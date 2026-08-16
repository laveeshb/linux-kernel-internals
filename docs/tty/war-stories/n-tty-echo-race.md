# The n_tty Echo Race: Nine Years From Fix to CISA's Exploited-in-the-Wild List

> Writing to a pty while the line discipline echoed input back out let two writers corrupt the same tty buffer with no lock between them — fixed in 2014, and still showing up as a live Android root exploit technique nine years later.

Landed
:   Linux 3.15, May 2014 (CVE-2014-0196)

Driver
:   N_TTY line discipline (`drivers/tty/n_tty.c`)

Fix author
:   Peter Hurley

Mechanism
:   Missing lock between concurrent writer and echo paths into the tty flip buffer

CVE-2014-0196 — CISA Known Exploited Vulnerabilities catalog (added 2023-05-12, nine years after the fix)

*Part of [War Stories: TTY/Serial Bugs and Regressions](../war-stories.md).*

## Before state

When a pty is in raw (non-canonical) mode with echo enabled and output post-processing disabled (`LECHO` set, `OPOST` clear — a mode real terminal programs put ptys into), every character a process writes to the pty gets echoed straight back through the line discipline to whatever's reading the other end. That echo path and an ordinary `write()` to the same pty both ultimately call into the same tty-buffer insertion machinery (`tty_insert_flip_string()` and friends) to append bytes to the tty's flip buffer.

## The trigger

`n_tty_write()` (`drivers/tty/n_tty.c`) serialized *writers* against each other using the tty's `atomic_write_lock`. That lock does nothing to serialize a writer against the echo path — the echo path reaches the same buffer-insertion code through a completely different call chain, triggered by input arriving rather than by a `write()` call, and holds no lock in common with `atomic_write_lock`. A process that writes a long string to a pty while another process (or the kernel itself, echoing input from the other side) triggers echo output at the same time can have both paths racing on the same tty buffer's tail pointer and backing memory.

## Observed behavior

Two concurrent, unsynchronized appends to the same flip buffer corrupt the buffer's internal bookkeeping — advancing the same tail position twice, writing past where the other writer expected free space to be. Depending on timing and buffer state, this ranges from a kernel crash (denial of service) to a memory-corruption primitive that security researchers turned into a working local privilege-escalation exploit, since a pty is reachable by any unprivileged local user or process. That reachability — no special hardware, no unusual configuration, just a pty in a common echo mode — is why this bug proved so durable: it kept getting rediscovered as a rooting technique for Android devices running kernels that predated the fix, years after upstream had already resolved it. CISA added it to the Known Exploited Vulnerabilities catalog in May 2023, nine years after the patch landed, because it was still being actively exploited in the wild on unpatched/outdated kernels.

## Why it happened

The bug is a classic instance of a lock that covers *one* known caller of a shared resource but not *all* callers. `atomic_write_lock` was designed to keep concurrent `write()` calls from interleaving with each other — a reasonable, narrower goal than "protect the tty buffer from every possible writer." The echo path wasn't a `write()` call at all; it was triggered from the input side, reusing the same underlying buffer-insertion primitives without going through the write serialization that was supposed to guard them. The bug is invisible from reading `n_tty_write()` in isolation — the function's own locking looks complete for what it directly does. It only becomes visible once you trace every other call site that reaches the same buffer-insertion functions and ask whether they share a lock with this one.

## Resolution

Commit `4291086b1f081b869c6d79e5b7441633dc3ace00` takes the N_TTY line discipline's own `output_lock` mutex around the `tty->ops->write()` call inside `n_tty_write()`, serializing the writer path against the echo path's use of the same lock — closing the gap `atomic_write_lock` never covered.

## What it taught us

**A lock's name and its actual coverage can drift apart.** `atomic_write_lock` sounds like it should mean "no concurrent access to the write path," but its real scope was narrower — concurrent `write()` calls only — and a second, structurally different path into the same shared state (the echo path) existed outside that name's implied guarantee.

**Fixing a bug doesn't retire it from an attacker's toolkit if the fix only ships to actively-updated kernels.** The 2014 fix was correct and complete for the code it touched. The bug's second life as a 2020s Android exploitation technique is a story about patch propagation and device lifecycle, not about the fix being wrong — a reminder that "fixed upstream" and "no longer exploitable in the field" are different claims with a potentially decade-long gap between them.

!!! warning "Pattern to watch for"
    A lock named after one specific caller or call path (`atomic_write_lock` implying "the write path") guarding a resource that a *second*, differently-triggered code path (here, echo — triggered by input, not by a write syscall) also mutates without acquiring the same lock. Audit every caller of the shared buffer/state, not just the one the lock's name suggests.

## See also

- [Line Disciplines, termios, and Pseudo-Terminals](../line-disciplines.md) — N_TTY, canonical mode, and echo as covered today
- [The pty_write() Lock That Was Fixed, Un-Fixed, and Fixed Again](pty-write-lock-saga.md) — a different tty-buffer locking bug, in the pty layer rather than N_TTY, that took three commits across four years to fully resolve

## External references

- [NVD: CVE-2014-0196](https://nvd.nist.gov/vuln/detail/CVE-2014-0196) — CISA Known Exploited Vulnerabilities catalog, added 2023-05-12
- [git.kernel.org: 4291086b1f08](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=4291086b1f081b869c6d79e5b7441633dc3ace00) — the fix: take `output_lock` around the writer path's buffer insertion
