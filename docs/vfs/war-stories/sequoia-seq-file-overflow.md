# Sequoia: The seq_file Size-Truncation Overflow

> CVE-2021-33909 — a `size_t` buffer size, silently narrowed to a 32-bit `int` since the day `dentry_path()` was written, stayed unreachable until a 2014 fix for an unrelated allocation-failure bug made it possible to grow a buffer large enough to trigger it — and then sat unreachable-in-practice for seven more years until someone went looking, turning "make a very long directory path" into an exact, attacker-chosen out-of-bounds write

Disclosed
:   July 20, 2021 (coordinated with Red Hat, kernel security list, and linux-distros)

Reported by
:   Qualys Research Team

CVSS
:   7.8 HIGH (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`)

Bug present since
:   3.16 (July 2014, when the vmalloc fallback landed; the 3.16 release itself followed in August); exploitable through 5.13.3

Fixed in
:   commit `8cae8cd89f05`, fast-tracked to the 5.13.4 stable point release; reached Linus's mainline tree as part of the Linux 5.14 development cycle

Exploit tool
:   yes — Qualys built and privately demonstrated a working local-root exploit; a crasher PoC was published with the advisory

Actively exploited
:   no confirmed cases (not on CISA KEV)

*Part of [War Stories: VFS Bugs and Regressions](../war-stories.md).*

## Before state

`single_open()` and friends give a `seq_file` exactly one shot at producing its entire output in one buffer — no incremental chunking. When that output doesn't fit, `fs/seq_file.c` doubles the buffer and tries again. Originally that meant `kmalloc()`, which simply failed outright for large, hard-to-satisfy allocations under memory fragmentation — a real problem: [`058504edd026`](https://github.com/torvalds/linux/commit/058504edd02667eef8fac9be27ab3ea74332e9b4) ("fs/seq_file: fallback to vmalloc allocation", Heiko Carstens, July 2014) fixed genuine `/proc/stat` read failures on fragmented systems by adding a fallback: if `kmalloc()` fails and the request is bigger than a page, fall back to `vmalloc()`, which can satisfy far larger requests by stitching together non-contiguous pages.

```c
static void *seq_buf_alloc(unsigned long size)
{
	void *buf;

	buf = kmalloc(size, GFP_KERNEL | __GFP_NOWARN);
	if (!buf && size > PAGE_SIZE)
		buf = vmalloc(size);
	return buf;
}
```

That one change is what made a multi-gigabyte `seq_file` buffer *possible* to allocate at all. Nothing else in the doubling logic changed to account for it.

## The trigger

`m->size`, the buffer size that doubles on each retry, is a `size_t` — 64-bit on any modern kernel. Reading `/proc/self/mountinfo` (`show_mountinfo()` → `seq_dentry()`) passes that size straight into `dentry_path()`:

```c
char *dentry_path(struct dentry *dentry, char *buf, int buflen)
```

`buflen` is a plain 32-bit signed `int`. Once `m->size` reaches exactly 2 GiB, the implicit narrowing conversion at the call site produces `INT_MIN` — `-2147483648` — not an error, not a clamp, just a silently reinterpreted negative number.

Qualys's advisory traces the rest precisely: `dentry_path()`, on an unlinked dentry, computes `p = buf + buflen` — with `buflen` now `INT_MIN`, `p` points roughly 2 GiB *before* the start of the vmalloc'd buffer — and calls `prepend(&p, &buflen, "//deleted", 10)` to write that literal suffix. `prepend()` decrements the (still-negative, now-interpreted-as-huge-positive-after-arithmetic) `buflen` and the pointer, and writes.

## Observed behavior

The write is small — 10 bytes, the literal string `"//deleted"` — but it lands at an attacker-chosen offset with no bounds check at all: "exactly -2GB-10B below the beginning of a vmalloc()ated kernel buffer," in Qualys's own words. Reaching the 2 GiB threshold takes a real but achievable setup: create a deeply nested directory tree whose total path length exceeds 1 GiB, bind-mount it inside an unprivileged user namespace, then `rmdir()` it so the dentries become unlinked (triggering the `"//deleted"` suffix path) while something is still reading `mountinfo` for that mount. Because `seq_file`'s own path-component escaping turns each `\` into a 4-byte `\134` sequence, an attacker who pads directory names with backslashes gets a 4x length amplification — Qualys found the practical directory count came to roughly 1 million nested directories rather than the naive 4 million a flat 256-byte-`NAME_MAX` calculation would suggest — reachable with about 5 GB of memory and 1 million inodes.

From that single controlled 10-byte write, Qualys built a full local-root exploit: pin a thread mid-BPF-verification using `userfaultfd()` or FUSE to stall it after the verifier has approved a small eBPF program but before JIT compilation, use the OOB write's timing to corrupt kernel state, and swap in different bytecode than what was verified — arbitrary kernel read/write, then overwriting `modprobe_path[]` for root-equivalent code execution. They confirmed the full chain worked, unmodified, on default installs of Ubuntu 20.04, 20.10, and 21.04, Debian 11, and Fedora 34 Workstation, and assessed other distributions as "certainly vulnerable, and probably exploitable."

## Why it happened

The vulnerable narrowing conversion — a 64-bit size flowing into a 32-bit signed parameter — was there from the moment `dentry_path()`'s signature was written; it simply couldn't be triggered, because nothing could grow `m->size` past a few kilobytes before `vmalloc()` support existed. Adding the vmalloc fallback in 2014 was a correct, narrowly-scoped fix for a real allocation-failure bug — its author had no reason to audit every downstream consumer of `seq_file` buffer sizes for `int`-width assumptions, and the truncation sat unreachable-in-practice for seven years until someone specifically went looking for exactly this class of bug across the tree.

## Resolution

Eric Sandeen's fix, suggested by Al Viro after Qualys's report, is three lines:

```c
static void *seq_buf_alloc(unsigned long size)
{
	if (unlikely(size > MAX_RW_COUNT))
		return NULL;

	return kvmalloc(size, GFP_KERNEL_ACCOUNT);
}
```

`MAX_RW_COUNT` is `INT_MAX` rounded down to a page boundary — just under 2 GiB — an existing kernel-wide constant already used to cap ordinary read/write sizes for exactly this class of int-overflow hazard. The fix doesn't touch `dentry_path()`'s signature or fix the narrowing conversion itself; it simply refuses to let a `seq_file` buffer grow large enough to trigger it. LWN's coverage called it "something of a band-aid to simply reject seq_buf allocations that get 'too large,'" and asked "how many other size_t-to-int problems of that sort still linger in the kernel."

## What it taught us

**A correct, well-scoped fix can quietly reopen a dormant bug class years later**, if the fix removes a limit (here, the hard failure of `kmalloc()` on huge requests) that had been incidentally shielding an unrelated latent bug (the `int` truncation in `dentry_path()`). The 2014 patch was never wrong about what it set out to do.

**`size_t`-to-`int` narrowing is a recurring, name-brand bug class precisely because it's silent** — no compiler warning by default, no crash at the conversion site, just a value that becomes meaningfully wrong only once a caller manages to push it past 2^31. Any code path where an attacker can influence a size that eventually crosses a 32-bit signed boundary is worth this exact scrutiny.

!!! warning "Pattern to watch for"
    Grep for size/length parameters declared `int` (not `size_t`, `ssize_t`, or `unsigned long`) anywhere they're fed from a caller-influenced, unboundedly-growing value — buffer doubling logic, cumulative counters, anything that "just keeps growing" is exactly the shape that turns a silent narrowing conversion into an exact, attacker-controlled out-of-bounds offset once it crosses `INT_MAX`.

## See also

- [VFS Overview](../README.md) — the generic `seq_file` interface this bug lives in
- [Understanding /proc](../../mm/understanding-proc-meminfo.md) — the `/proc` infrastructure `seq_file` backs
- [Dirty Pipe](../../security/war-stories/dirty-pipe.md) — another local-root bug from a small, silent omission with a multi-year dormancy window

## External references

- [GitHub mirror: 8cae8cd89f05](https://github.com/torvalds/linux/commit/8cae8cd89f05f6de223d63e6d15e31c8ba9cf53b) — "seq_file: disallow extremely large seq buffer allocations," the fix
- [GitHub mirror: 058504edd026](https://github.com/torvalds/linux/commit/058504edd02667eef8fac9be27ab3ea74332e9b4) — "fs/seq_file: fallback to vmalloc allocation," the commit that made the bug reachable
- [oss-security: CVE-2021-33909](https://www.openwall.com/lists/oss-security/2021/07/20/1) — Qualys's original advisory, with the full exploitation mechanics
- [LWN: The Sequoia seq_file vulnerability](https://lwn.net/Articles/863729/) — Jake Edge, July 21, 2021
- [NVD: CVE-2021-33909](https://nvd.nist.gov/vuln/detail/CVE-2021-33909) — CVE record, CVSS 7.8 HIGH, published July 20, 2021
