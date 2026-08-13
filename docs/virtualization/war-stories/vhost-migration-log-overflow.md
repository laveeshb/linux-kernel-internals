# vhost: The Dirty-Log Counter That Forgot Zero-Length Descriptors

> CVE-2019-14835 — vhost's live-migration dirty-page logging assumed one log entry per descriptor could never outrun the descriptor count itself, an invariant a single guest-supplied zero-length descriptor could break, turning a routine migration into a guest-controlled kernel heap overflow

Disclosed
:   September 17, 2019 (Tencent Blade Team, coordinated disclosure via oss-security)

Reported by
:   Peter Pi, Tencent Blade Team

CVSS
:   7.8 HIGH, NVD (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`); 7.2 HIGH, Red Hat's own scoring (`CVSS:3.0/AV:L/AC:H/PR:H/UI:R/S:C/C:H/I:H/A:H`) — the two CNAs disagree on attack complexity and privileges required

Bug present since
:   commit `3a4d5c94e959`, vhost_net's original introduction, January 2010

Fixed in
:   commit `060423bfdee3f`, mainline Linux 5.3 (September 15, 2019)

Exploit tool
:   no independently-confirmed public PoC

Actively exploited
:   no confirmed cases (not on CISA KEV)

*Part of [War Stories: Virtualization (KVM) Bugs and Escapes](../war-stories.md).*

## Before state

vhost moves virtio device emulation into the host kernel — instead of every virtqueue notification trapping out to QEMU in userspace, `vhost_net.ko` processes the ring directly, cutting a costly userspace round-trip out of the hot path. During live migration, QEMU needs to know which guest-physical pages a virtqueue operation touched, so it can re-transmit exactly the pages that changed since the last pass. vhost supports this by logging descriptor addresses into a fixed-size kernel array (`vq->log`, sized to `dev->iov_limit` entries — 1088 for vhost-net) whenever migration dirty-tracking (`VHOST_F_LOG_ALL`) is negotiated.

The logging code, in `get_indirect()` and `vhost_get_vq_desc()`, relied on one unstated invariant: `log_num` (the count of entries written into the fixed-size log array) could never exceed `in_num` (the count of iovec segments produced for guest-writable descriptors) — because both counters were supposed to move in lockstep, one descriptor at a time. `in_num` was already bounds-checked against the caller's iovec array size. `log_num` itself never was, because it was never supposed to need one.

## The trigger

`translate_desc()` returns `ret = 0` for a zero-length descriptor — its core copy loop, `while ((u64)len > s)`, never executes when `len` is zero. The pre-fix logging code took that return value at face value: `*in_num += ret;` (adds zero, so `in_num` doesn't advance) followed unconditionally by `if (unlikely(log)) { log[*log_num].addr = ...; log[*log_num].len = ...; ++*log_num; }` — the log entry gets written and `log_num` advances regardless of whether `ret` was zero. A single guest-supplied, write-flagged, zero-length descriptor breaks the "log_num tracks in_num" invariant the array-size protection depended on: `log_num` can now advance past `in_num`, with nothing else in the code bounding it directly.

## Observed behavior

The amplification comes from indirect descriptor tables: a guest can supply an indirect table with up to 65,536 entries (bounded only by `count > USHRT_MAX + 1`), each one a write-flagged, zero-length descriptor. Every iteration through the loop writes an attacker-controlled 8-byte guest-physical address into `log[log_num]` and advances `log_num` with no bound at all — so after roughly the first 1,088 entries, the writes run straight off the end of the `kmalloc_array`-allocated log buffer and keep going, potentially for tens of thousands of 16-byte entries, each one attacker-controlled content landing sequentially past the buffer in kernel heap memory. Tencent Blade Team's own disclosure traced the identical call path independently: `handle_rx() → get_rx_bufs() → vhost_get_vq_desc() → get_indirect()`, and their annotated source excerpt flags the same line: "log buffer overflow, because log_num can be USHRT_MAX, but log buffer size is far below than USHRT_MAX." Because the vulnerable path only runs when `VHOST_F_LOG_ALL` is negotiated, this is specifically a migration-time bug — Red Hat's own guidance for administrators who can't immediately patch was to disable guest live migration, or blacklist the `vhost_net` module entirely, as interim mitigations.

## Why it happened

The invariant "one log entry per descriptor, so log_num can never outrun in_num" was true by construction for every ordinary descriptor — a nonzero-length descriptor always produces at least one iovec segment, incrementing both counters together. A zero-length descriptor is a legitimate, spec-permitted value that simply never occurred to the logging code as a case worth separate handling, because from the descriptor-translation logic's point of view it's a complete no-op: no data to copy, nothing to log. The bug is that "nothing to log" and "log nothing" were two different decisions, and only one of them was actually implemented — the code decided there was nothing worth *copying*, but still unconditionally recorded a log entry anyway.

## Resolution

`060423bfdee3f` ("vhost: make sure log_num < in_num") closes the gap with a two-word change in both `get_indirect()` and `vhost_get_vq_desc()`: the logging condition becomes `if (unlikely(log && ret))` instead of `if (unlikely(log))` — a log entry is now only written when the descriptor actually produced a nonzero-length iovec segment (`ret != 0`), restoring the "log_num tracks in_num" invariant the rest of the code already assumed. As the commit message puts it: "There's no need to log when desc.len = 0, so just don't increment log_num in this case."

## What it taught us

**An invariant that holds "by construction" for the common case still needs to be checked explicitly wherever the code that depends on it can't independently verify it.** Every code path that trusted `log_num <= in_num` had every reason to believe it — right up until a legitimate, unremarkable input value (a zero-length descriptor) turned out to be a case the invariant's original reasoning never actually covered.

**A counter that's "supposed to move in lockstep" with a bounds-checked counter is not itself bounds-checked, even when it looks like it should be.** `in_num` was protected because it was directly checked against the destination iovec array's size. `log_num` inherited that protection only in the sense that developers assumed the two counters couldn't diverge — an assumption that was true for nine years, until a single edge-case input showed it wasn't actually enforced anywhere.

!!! warning "Pattern to watch for"
    When two counters are meant to track each other one-for-one, and only one of them has an explicit bounds check, ask what input could advance the unchecked one without advancing the checked one. A zero-length buffer, an empty string, a no-op iteration — the "nothing happened" case is exactly where implicit lockstep invariants are most likely to have never actually been enforced.

## See also

- [virtio](../virtio.md) — the paravirtualized I/O model, virtqueue descriptors, and vhost's role accelerating it
- [KVM Live Migration](../live-migration.md) — dirty-page logging and pre-copy migration, the feature whose logging path this bug lives in
- [VENOM: The Floppy Controller Nobody Turned Off](venom-fdc-overflow.md) — another guest-to-host escape rooted in an implicit contract between two pieces of code that stopped holding

## External references

- [git.kernel.org: 060423bfdee3f](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=060423bfdee3f8bc6e2c1bac97de24d5415e2bc4) — "vhost: make sure log_num < in_num," the fix
- [git.kernel.org: 3a4d5c94e959](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=3a4d5c94e959359ece6d6b55045c3f046677f55c) — "vhost_net: a kernel-level virtio server," vhost_net's original 2010 introduction
- [oss-security: CVE-2019-14835 disclosure](https://www.openwall.com/lists/oss-security/2019/09/17/1) — Tencent Blade Team's technical writeup, with an independently-annotated trace of the same overflow
- [NVD: CVE-2019-14835](https://nvd.nist.gov/vuln/detail/CVE-2019-14835) — CVE record, CVSS 3.1 7.8 HIGH, published September 17, 2019
