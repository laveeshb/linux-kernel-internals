# Dirty Pipe

> CVE-2022-0847 — one missing `buf->flags = 0;` let any user who could *read* a file overwrite it in the page cache, including immutable files, read-only btrfs snapshots, and read-only mounts

**Disclosed:** March 7, 2022 (fix merged February 21, 2022) &nbsp;·&nbsp; **Reported by:** Max Kellermann, CM4all GmbH / IONOS SE &nbsp;·&nbsp; **CVSS:** 7.8 HIGH (`AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H` — NVD primary and Red Hat's CNA score agree) &nbsp;·&nbsp; **Bug present since:** 4.9 (2016); **exploitable since:** 5.8 (2020) &nbsp;·&nbsp; **Fixed in:** 5.16.11, 5.15.25, 5.10.102 (all released February 23, 2022) &nbsp;·&nbsp; **Exploit tool:** yes — the reporter published a working PoC in the disclosure itself &nbsp;·&nbsp; **Actively exploited:** yes — [added to CISA's KEV catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) April 25, 2022

*Part of [War Stories: Linux Security Bugs and CVEs](../war-stories.md).*

## Before state

A Linux pipe is a ring of `struct pipe_buffer` entries, each pointing at a page. See [Pipes and FIFOs](../../ipc/pipes.md) for the ring mechanics and [splice, sendfile, and Zero-Copy](../../io/splice-sendfile.md) for how `splice()` moves pages into that ring without copying.

The relevant optimization is **merging**. If the last write to a pipe didn't fill its page, the next `write()` can append into the same page rather than allocating a new one. That is safe for *anonymous* pipe buffers, whose pages the pipe owns outright. It is emphatically not safe for buffers created by `splice()` from a file, because those point directly into the **page cache** — the page belongs to the file, not to the pipe, and appending to it would be writing to the file.

So the kernel has always had a "can this buffer be merged into?" check. What changed over the years is *where that check reads its answer from*:

- **2.6.17 (2006)** — [`5274f052e7b3`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=5274f052e7b3dbd81935772eb551dfd0325dfa9d) introduced `splice()` along with `page_cache_pipe_buf_ops`, the first `struct pipe_buf_operations` with `can_merge = 0`. The answer lived in the **ops vector**.
- **5.1 (2019)** — [`01e7187b4119`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=01e7187b41191376cee8bea8de9f907b001e87b4) ("pipe: stop using ->can_merge", Jann Horn, at Al Viro's suggestion) dropped the flag and replaced it with a pointer comparison, since only one ops vector had ever set it. This traces back to a real bug Horn found and [reported in October 2018](https://lore.kernel.org/linux-fsdevel/CAG48ez1wN=oC_uWkHHhboDvfVt8p9O98ZMFZyh=AK6D=eHU7MA@mail.gmail.com/): `tee()`'ing from a pipe with a partial-page buffer could let two independent pipes end up sharing — and corrupting — the same page. His [first fix attempt](https://lore.kernel.org/linux-fsdevel/20181015150420.2096-1-jannh@google.com/) went through a round of review from Eric Biggers before a [revised v2](https://lore.kernel.org/linux-fsdevel/20190123141918.238286-2-jannh@google.com/) landed three months later. The answer still came from the **ops pointer**:

    ```c
    static bool pipe_buf_can_merge(struct pipe_buffer *buf)
    {
        return buf->ops == &anon_pipe_buf_ops;
    }
    ```

- **5.8 (2020)** — [`f6dd975583bd`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=f6dd975583bd8ce088400648fd9819e4691c8958) ("pipe: merge anon_pipe_buf*_ops", Christoph Hellwig) noticed that `anon_pipe_buf_ops`, `anon_pipe_buf_nomerge_ops`, and `packet_pipe_buf_ops` had byte-identical function tables and existed only to encode behavior. It deleted two of the three and moved the answer into a **per-buffer flag**:

    ```c
    #define PIPE_BUF_FLAG_CAN_MERGE	0x10	/* can merge buffers */
    ```

    ```c
    /* fs/pipe.c, pipe_write() after f6dd975583bd */
    if ((buf->flags & PIPE_BUF_FLAG_CAN_MERGE) &&
        offset + chars <= PAGE_SIZE) {
    ```

Hellwig's commit message called out that inverting the sense of the old `nomerge` special case "actually allows for much nicer code," and it did — the diff removes 48 lines and adds 11. It also had no per-patch public review at all: it reached mainline as one of seven patches in [Al Viro's "assorted splice cleanups" pull request](https://lore.kernel.org/lkml/20200603192615.GY23230@ZenIV.linux.org.uk/), whose only reply is an automated merge-tracker acknowledgment.

Meanwhile, in an entirely different file, [`241699cd72a8`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=241699cd72a8489c9446ae3910ddd243e9b9061b) ("new iov_iter flavour: pipe-backed", Al Viro, 4.9, 2016) had added two functions in `lib/iov_iter.c` that allocate a fresh `pipe_buffer` from the ring and populate it by hand:

```c
/* copy_page_to_iter_pipe(), lib/iov_iter.c, pre-fix */
buf->ops = &page_cache_pipe_buf_ops;
get_page(page);
buf->page = page;
buf->offset = offset;
```

`ops`, `page`, `offset`, `len` — all set. `flags` — never touched, so it retained whatever the *previous* occupant of that ring slot had left behind.

This patch was reviewed publicly, and reviewed carefully. On the [second posting](https://lore.kernel.org/linux-fsdevel/20160924040117.GP2356@ZenIV.linux.org.uk/) to linux-fsdevel, Miklos Szeredi — who would rediscover this same bug class under five months later, see below — wrote: "This is the hardest part of the whole set. I've been trying to understand it, but the modular arithmetic makes it really tricky to read... Specific comments inline," then quoted four excerpts and commented inline, mostly on unrelated points — missing `EFAULT` handling and unexpected zero returns in `copy_page_to_iter_pipe()` and `push_pipe()`, a dead store in `pipe_advance()`, and the page accounting in `iov_iter_npages()`. The two excerpts taken from the vulnerable functions both stop immediately before the field-by-field assignment block, so that block, and the `flags` line missing from it, never appeared anywhere in the thread's quoted code at all.

From 2016 to 2020 this was a latent, inert bug. Every flag that existed at the time (`PIPE_BUF_FLAG_LRU`, `_ATOMIC`, `_GIFT`, `_PACKET`) was, in Kellermann's words, "rather boring," and the merge decision was being read out of `ops`, which *was* initialized. The uninitialized field simply didn't matter yet.

## The trigger

`f6dd975583bd` made it matter, by moving the merge decision onto the one field these two functions forgot to write. A stale `PIPE_BUF_FLAG_CAN_MERGE` bit inherited from a recycled ring slot now told `pipe_write()` that a page-cache page was safe to append to.

Kellermann's proof-of-concept, published in full in [the disclosure writeup](https://dirtypipe.cm4all.com/), is five steps and needs no capabilities at all:

1. Create a pipe.
2. Fill it completely with arbitrary data — every `pipe_buffer` in the ring now has `PIPE_BUF_FLAG_CAN_MERGE` set, because that is what the normal anonymous write path does.
3. Drain the pipe. The buffers are released, but the ring slots keep their `flags` values.
4. `splice()` a single byte from the target file — opened `O_RDONLY` — into the pipe, positioned just before the offset you want to overwrite. `copy_page_to_iter_pipe()` fills in a page-cache reference and leaves the stale merge bit standing.
5. `write()` your data to the pipe. It merges into the page-cache page instead of allocating a new buffer.

The exploit's own comment on the `open()` call — `O_RDONLY, // yes, read-only! :-)` — is the whole vulnerability in one line. There are only three real constraints, all documented in the PoC: the offset can't sit on a page boundary (one byte before it must be spliced in), the write can't cross a page boundary (the remainder would land in a new anonymous buffer), and the file can't be extended (the pipe never tells the page cache the file grew).

As Kellermann put it: it "not only works without write permissions, it also works with immutable files, on read-only btrfs snapshots and on read-only mounts (including CD-ROM mounts). That is because the page cache is always writable (by the kernel), and writing to a pipe never checks any permissions."

## Observed behavior

For nearly a year, nobody knew this was a security bug. It presented as flaky data corruption.

CM4all's hosting platform compresses daily web access logs with zlib and serves a month's worth as one concatenated `.gz` — or, for Windows users, wrapped in a ZIP container — using `splice()` to push file data straight into the HTTP connection. Starting April 2021, customers occasionally reported that downloaded logs failed CRC validation. The first ticket was closed by hand-patching the CRC.

The corruption had a signature. Every affected file ended with the same eight wrong bytes:

```
000005f0  81 d6 94 39 8a 05 b0 ed  e9 c0 fd 07 00 00 ff ff
00000600  03 00 50 4b 01 02 1e 03  14 00
```

`50 4b` is `PK`. `01 02` is a ZIP central directory file header. The bytes overwriting the log files were the ZIP header that the *web service* wrote to its pipe after splicing all the daily files — a process running as a different user, with no write permission on those files, which never opened them for writing at all.

A full-disk scan turned up 37 corrupt files over three months, clustered hard on the last day of each month — because the download loop sends days in order, so the last day's file is always the one immediately followed by the `PK` header. Only the server actually serving HTTP downloads was affected; its standby, running the identical log-splitting job, had zero corruptions.

Kellermann's minimal reproducer is two small programs: one that loops `write(1, "AAAAA", 5)` into a file, and one that loops `splice()` from that file into a pipe followed by `write(1, "BBBBB", 5)`. "BBBBB" started appearing inside the file. A bisect across the 185,011 commits between v4.19 and v5.10 took 17 steps and landed on `f6dd975583bd`.

His initial read was that this required a concurrent privileged writer and won a race. Once he understood the actual mechanism, the hole widened enormously: no writer, no race, arbitrary data at almost arbitrary offsets in any file the attacker can read. `/etc/passwd`, a setuid binary, `authorized_keys` — anything.

One property makes it especially nasty operationally: overwriting a page-cache page this way never marks the page dirty, so writeback never runs. The change is live for every process that reads the file, and it evaporates on reboot or reclaim without ever touching the disk. Kellermann's understated note — "This allows interesting attacks without leaving a trace on hard disk" — describes an incident that leaves no forensic artifact in the filesystem.

Exploitation in the wild followed quickly and is well documented:

- **CISA** [added CVE-2022-0847 to the Known Exploited Vulnerabilities catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) on **April 25, 2022**, seven weeks after disclosure, with a federal remediation deadline of May 16, 2022.
- **Google's [Android Security Bulletin for May 2022](https://source.android.com/docs/security/bulletin/2022-05-01)** lists CVE-2022-0847 (component: `pipes`, EoP, High, bug A-220741611) and flags it under "There are indications that the following may be under limited, targeted exploitation." Kellermann had reproduced the bug on a Google Pixel 6 the day after reporting it.
- **Exploit-DB** carries entry [50808](https://www.exploit-db.com/exploits/50808), "Linux Kernel 5.8 < 5.16.11 — Local Privilege Escalation (DirtyPipe)," published March 8, 2022 — the day after public disclosure. NVD's reference list additionally tags three Packet Storm entries as `Exploit`, one of them a SUID-binary hijack variant and the other two generic local-privilege-escalation writeups of the same bug.

The rough analogy is CVE-2016-5195, Dirty COW, which Kellermann invokes in the name — but he is explicit that this one "is easier to exploit," and it is: Dirty COW needed a race window, this needs four syscalls in a fixed order.

## Why it happened

The proximate cause is two missing initializers. The interesting cause is *why nobody noticed them for six years*.

**The safety check moved from a field that was always initialized to one that wasn't.** Every version of the merge check was correct at the time it was written. `copy_page_to_iter_pipe()` and `push_pipe()` had always set `buf->ops` correctly, so for as long as the answer was derived from `ops`, they were fine — accidentally. `f6dd975583bd` was a clean, well-reasoned dead-code cleanup that read the merge decision out of `flags` instead. It could not have known that two functions in `lib/iov_iter.c` — a different file, a different subsystem, added by a different author four years earlier — happened to populate `pipe_buffer` by hand and skipped that one member. Kellermann is unambiguous in the PoC's own comments: "The commit did not introduce the bug, it was there before, it just provided an easy way to exploit it."

**The polarity flipped from fail-closed to fail-open.** Under the old scheme, an unset/garbage `flags` value was harmless because merging required an affirmative `ops == &anon_pipe_buf_ops` match. Under the new scheme, merging is granted by a bit being *set*, so garbage that happens to contain `0x10` grants permission. A struct field whose zero value means "deny" tolerates sloppy initialization; one whose set value means "allow" does not. Nothing about the refactor made this distinction visible at the call sites that mattered.

**Hand-populating a struct field-by-field has no compiler backstop.** Both vulnerable functions assign members individually rather than using a designated initializer or memset, so an omitted member produces no warning — it silently inherits whatever the recycled ring slot held. `struct pipe_buffer` sits in a long-lived ring that is deliberately reused, which turns "uninitialized" into "attacker-influenced" rather than "random."

**This exact bug class had already been found and fixed once, in a sibling caller, five years earlier — twice, in one day.** In February 2017, Miklos Szeredi committed [`84588a93d097`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=84588a93d097bace24b9233930f82511d4f34210), titled — word for word — "fuse: fix uninitialized flags in pipe_buffer." Its one-line diff adds `bufs[page_nr].flags = 0;` right after a `bufs[page_nr].ops = ...` assignment in `fuse_dev_splice_read()`, and its `Fixes:` tag points at [`d82718e348fe`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d82718e348fee15dbce8f578ff2588982b7cc7ca) ("fuse_dev_splice_read(): switch to add_to_pipe()"), part of the same 4.9-era pipe-backed-iov_iter conversion that introduced the `lib/iov_iter.c` instances. The fuse fix never got a standalone posting of its own — it reached Linus inside a [pull request](https://lore.kernel.org/linux-fsdevel/20170216164335.GB30656@veci.piliscsaba.szeredi.hu/) Szeredi sent that same day. Five minutes later, [Szeredi posted a second fix](https://lore.kernel.org/linux-fsdevel/20170216164902.GC30656@veci.piliscsaba.szeredi.hu/): the identical one-line fix for `splice_to_pipe()`, whose commit message notes the uninitialized flags "appears to have been there from the introduction of the splice syscall" — i.e. since 2006. Two callers of the same pattern got audited and patched on the same day; the two in `lib/iov_iter.c`, written by the same 2016 conversion, did not. At the time it made no difference. Three years later it made all the difference.

## Resolution

The fix, [`9d2231c5d74e`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=9d2231c5d74e13b2a0546fee6737ee4446017903) ("lib/iov_iter: initialize \"flags\" in new pipe_buffer", Max Kellermann), is two lines:

```diff
@@ -414,6 +414,7 @@ static size_t copy_page_to_iter_pipe(struct page *page, size_t offset, size_t by
 	buf->ops = &page_cache_pipe_buf_ops;
+	buf->flags = 0;
 	get_page(page);
@@ -577,6 +578,7 @@ static size_t push_pipe(struct iov_iter *i, size_t size,
 		buf->ops = &default_pipe_buf_ops;
+		buf->flags = 0;
 		buf->page = page;
```

The commit carries `Fixes: 241699cd72a8 ("new iov_iter flavour: pipe-backed")` and `Cc: stable@vger.kernel.org`, correctly attributing the omission to the 2016 commit rather than to the 5.8 refactor that weaponized it.

**On the public mailing list, there was no debate — deliberately.** The [LKML thread](https://lore.kernel.org/lkml/20220221100313.1504449-1-max.kellermann@ionos.com/) is exactly two messages long. Kellermann posted the patch on February 21, 2022 with a body that says only "The functions `copy_page_to_iter_pipe()` and `push_pipe()` can both allocate a new `pipe_buffer`, but the 'flags' member initializer is missing." Five hours later, Al Viro replied in full:

> Applied, will push to Linus...

That brevity is the story rather than an absence of one. Per Kellermann's timeline, the bug report, exploit, and patch went to the closed `security@kernel.org` list on February 20; the LKML posting the next day was made **"(without vulnerability details) as suggested by Linus Torvalds, Willy Tarreau and Al Viro"** — a patch that reads as a trivial missing-initializer cleanup, merged on its own merits, with the exploitability discussion kept off the public archive until fixes had shipped. Anyone searching lore for a design argument about this CVE will not find one, and that is the intended outcome of the [kernel's security-bug process](https://docs.kernel.org/process/security-bugs.html), not a gap in the record.

The rest of the timeline, from Kellermann's disclosure:

| Date | Event |
| --- | --- |
| 2021-04-29 | First support ticket about corrupt log files |
| 2022-02-19 | Corruption identified as a kernel bug, and as exploitable |
| 2022-02-20 | Report, exploit, and patch sent to `security@kernel.org` |
| 2022-02-21 | Reproduced on a Google Pixel 6; reported to the Android Security Team |
| 2022-02-21 | Patch posted to LKML without vulnerability details; Al Viro applies it |
| 2022-02-23 | Stable releases [5.16.11](https://lore.kernel.org/stable/1645618039140207@kroah.com/), [5.15.25](https://lore.kernel.org/stable/164561803311588@kroah.com/), and 5.10.102 ship the fix |
| 2022-02-24 | Google merges the fix into the Android common kernel |
| 2022-02-28 | `linux-distros` notified |
| 2022-03-07 | Public disclosure |

Three days from private report to shipped stable kernels; fifteen days to public disclosure. Because the fix is a two-line initializer with no behavioral risk, there were no follow-up regressions to walk back — a rare case where the corrective patch needed no corrections.

There is no meaningful runtime mitigation. `splice()` and `pipe()` are unprivileged core syscalls used by ordinary software, and the bug needs neither capabilities nor namespaces; blocking the syscalls via [seccomp BPF](../seccomp.md) protects only sandboxed processes that opt in. Patching was the only real answer, which is exactly why CISA attached a three-week federal deadline to it.

```bash
# Vulnerable range is 5.8 through 5.16.10 / 5.15.24 / 5.10.101.
# Distro kernels backport, so the upstream version alone is not conclusive —
# check the vendor's changelog for the CVE ID.
uname -r
```

## What it taught us

**Refactoring where a decision reads its answer from silently re-scopes which initializers are load-bearing.** `f6dd975583bd` was a good cleanup: it deleted two identical ops vectors and made the code shorter and clearer. Its only defect was invisible from its own diff — that moving the merge decision from `ops` to `flags` promoted a long-dormant missing initializer in another subsystem into a privilege escalation. When a check changes which struct member it consults, every site that constructs that struct by hand becomes newly relevant, including the ones the refactor never touched.

**A flag whose set bit grants permission is far less forgiving than one whose set bit denies it.** For fourteen years the merge decision was fail-closed: you needed a positive match to append. `PIPE_BUF_FLAG_CAN_MERGE` inverted that, and inverted sense turns "we forgot to zero this" from a cosmetic defect into an authorization bypass. Capability bits in reused, kernel-owned structures should be spelled as denials, or the structure should be zeroed on allocation so the safe state is the default.

**"Harmless today" is a claim about the current codebase, not about the code.** The missing initializer was genuinely inconsequential from 2016 to 2020, and treating it that way was reasonable at the time. But latent bugs don't decay — their severity is set by code written years later by people who never saw them. The 2017 fuse fix shows the class was known and patched in one caller while its siblings, added by the same conversion, went unaudited. When you fix an uninitialized-field bug, the fix is auditing every construction site of that struct, not the one that reported the crash.

**A CVSS base score is a description of the attack vector, not of the blast radius.** 7.8 HIGH is correct — `AV:L` and `PR:L` cap it there, because you need a local unprivileged account. But within that constraint the bug is essentially unbounded: no capabilities, no namespaces, no race, no timing, a fully public four-syscall exploit, and it defeats read-only mounts, immutable files, and read-only snapshots. CISA listed it as actively exploited and Google flagged targeted exploitation on Android within weeks. If you triage by score alone, this ranks the same as a great many local bugs that are nothing like it.

!!! warning "Pattern to watch for"
    Audit any code that builds a kernel struct by assigning members one at a time out of a long-lived, recycled pool — pipe buffer rings, skb control blocks, request structures, per-CPU caches. An omitted member there does not read as zero; it reads as whatever the previous user left, and if an attacker controlled the previous user, the "uninitialized" value is attacker-chosen. Prefer designated initializers (`*buf = (struct pipe_buffer){ ... };`) or an explicit memset over field-by-field assignment, and treat every `Fixes:`-tagged uninitialized-field patch as a prompt to grep for the same pattern in sibling call sites rather than as a closed ticket.

## See also

- [Linux Capabilities](../capabilities.md) — the privilege model this bug bypassed entirely; unlike most local escalations, Dirty Pipe required no capability at all, only read access
- [Kernel Hardening](../kernel-hardening.md) — why exploit mitigations (KASLR, stack protectors) offer nothing against a bug that needs no memory corruption
- [seccomp BPF](../seccomp.md) — the only practical containment for `splice()`-based attacks, and only for processes that opt in
- [Linux Security Module (LSM) Framework](../lsm.md) — why access-control hooks raised no objection: every syscall in the exploit (`open()` read-only, `splice()`, `write()` to a pipe) is individually legitimate
- [Pipes and FIFOs](../../ipc/pipes.md) — the `pipe_buffer` ring and the merge optimization at the center of this bug
- [splice, sendfile, and Zero-Copy](../../io/splice-sendfile.md) — how `splice()` puts page-cache references into a pipe
- [Page Cache](../../mm/page-cache.md) — why an overwritten page that is never marked dirty leaves no on-disk trace

## External references

- [The Dirty Pipe Vulnerability](https://dirtypipe.cm4all.com/) — Max Kellermann's disclosure writeup: the primary source for the mechanism, the year-long corruption investigation, the proof-of-concept exploit, and the timeline
- [NVD: CVE-2022-0847](https://nvd.nist.gov/vuln/detail/CVE-2022-0847) — CVE record, CVSS 7.8 HIGH (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`), published March 10, 2022
- [git.kernel.org: 9d2231c5d74e](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=9d2231c5d74e13b2a0546fee6737ee4446017903) — "lib/iov_iter: initialize \"flags\" in new pipe_buffer", the two-line fix
- [lore.kernel.org: the LKML patch thread](https://lore.kernel.org/lkml/20220221100313.1504449-1-max.kellermann@ionos.com/) — the entire public discussion: Kellermann's patch and Al Viro's "Applied, will push to Linus..."
- [git.kernel.org: 241699cd72a8](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=241699cd72a8489c9446ae3910ddd243e9b9061b) — "new iov_iter flavour: pipe-backed" (4.9, 2016), the commit the fix's `Fixes:` tag names as the origin
- [lore.kernel.org: new iov_iter flavour: pipe-backed](https://lore.kernel.org/linux-fsdevel/20160924040117.GP2356@ZenIV.linux.org.uk/) — the 2016 review thread, including Miklos Szeredi's inline review of the two functions that turned out to be missing the initializer
- [git.kernel.org: f6dd975583bd](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=f6dd975583bd8ce088400648fd9819e4691c8958) — "pipe: merge anon_pipe_buf*_ops" (5.8, 2020), which moved the merge check onto `flags` and made the dormant bug exploitable
- [lore.kernel.org: Al Viro's "assorted splice cleanups" pull request](https://lore.kernel.org/lkml/20200603192615.GY23230@ZenIV.linux.org.uk/) — `f6dd975583bd`'s only public appearance; no per-patch review preceded it
- [git.kernel.org: 01e7187b4119](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=01e7187b41191376cee8bea8de9f907b001e87b4) — "pipe: stop using ->can_merge" (5.1, 2019), the intermediate refactor that replaced the ops flag with a pointer comparison
- [lore.kernel.org: sys_tee() bug report](https://lore.kernel.org/linux-fsdevel/CAG48ez1wN=oC_uWkHHhboDvfVt8p9O98ZMFZyh=AK6D=eHU7MA@mail.gmail.com/) and [the v2 fix](https://lore.kernel.org/linux-fsdevel/20190123141918.238286-2-jannh@google.com/) — Jann Horn's original bug report and the patch it produced
- [git.kernel.org: 84588a93d097](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=84588a93d097bace24b9233930f82511d4f34210) — "fuse: fix uninitialized flags in pipe_buffer" (2017), the same bug class found and fixed in a sibling caller five years earlier
- [lore.kernel.org: vfs: fix uninitialized flags in splice_to_pipe()](https://lore.kernel.org/linux-fsdevel/20170216164902.GC30656@veci.piliscsaba.szeredi.hu/) — the second, near-identical fix Szeredi posted five minutes after the pull request carrying the fuse one
- [CISA: Known Exploited Vulnerabilities Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) — lists CVE-2022-0847 as actively exploited, added April 25, 2022, remediation due May 16, 2022
- [Android Security Bulletin, May 2022](https://source.android.com/docs/security/bulletin/2022-05-01) — lists CVE-2022-0847 (`pipes`, EoP, High) and notes indications of "limited, targeted exploitation"
- [Exploit-DB 50808](https://www.exploit-db.com/exploits/50808) — "Linux Kernel 5.8 < 5.16.11 — Local Privilege Escalation (DirtyPipe)", published March 8, 2022
- [lore.kernel.org: Linux 5.16.11](https://lore.kernel.org/stable/1645618039140207@kroah.com/) and [Linux 5.15.25](https://lore.kernel.org/stable/164561803311588@kroah.com/) — Greg Kroah-Hartman's stable release announcements carrying the fix, February 23, 2022
- [Red Hat Bugzilla 2060795](https://bugzilla.redhat.com/show_bug.cgi?id=2060795) — the CNA's tracking bug and impact analysis
- [kernel.org: Security bugs](https://docs.kernel.org/process/security-bugs.html) — the `security@kernel.org` process that kept the exploitability discussion off the public list until fixes shipped
