# War Stories: TTY/Serial Bugs and Regressions

> Six incidents from the TTY layer, N_TTY, and the pty subsystem — five CVEs and one well-documented non-CVE lifetime bug, almost all of them locking races in code whose bookkeeping has to stay consistent across a writer path and an independently-triggered reader/echo path

[The TTY Layer](README.md), [Serial Core and UART Drivers](serial.md), and [Line Disciplines, termios, and Pseudo-Terminals](line-disciplines.md) document this subsystem as it works today. This page is the incident record behind that architecture — and it's a subsystem with an unusually deep bench of hard, multi-year locking bugs, some of which took more than one attempt to actually resolve.

## Deep dives

### [The n_tty Echo Race: Nine Years From Fix to CISA's Exploited-in-the-Wild List](war-stories/n-tty-echo-race.md)
**May 2014 · CVE-2014-0196 · CISA Known Exploited Vulnerabilities catalog (added 2023)**
Writing to a pty while the line discipline echoed input back out let two writers corrupt the same tty buffer with no lock between them. Fixed in 2014 — and still showing up as a live Android root exploit technique nine years later.

### [The pty_write() Lock That Was Fixed, Un-Fixed, and Fixed Again](war-stories/pty-write-lock-saga.md)
**2018 → 2020 → July 2022 · CVE-2022-1462**
A 2018 data-race fix added a lock. A 2020 deadlock fix removed part of it, silently reintroducing the race in a new shape. A 2022 CVE report finally caught it, and the real fix needed both properties at once.

## Quick cases

### Case 1: The n_hdlc double-free — CVE-2017-2636

A 2009 commit added `n_hdlc.tbuf`, a single unsynchronized pointer tracking "the buffer currently being retransmitted after a tx error," to the HDLC line discipline (`drivers/tty/n_hdlc.c`, loadable via `N_HDLC`). Concurrent `flush_tx_queue()` (triggered by a `TCFLSH` ioctl or ldisc close) and `n_hdlc_send_frames()` (transmit completion) could both see the same buffer through `tbuf` and both queue it onto the free-buffer list — a double-free, reachable by a local unprivileged user, that researcher Alexander Popov turned into a working root exploit bypassing SMEP.

The fix ([`82f2341c94d2`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=82f2341c94d270421f383641b7cd670e474db56b), Alexander Popov, February 2017) removes the ad hoc pointer-tracking design entirely, converting the buffer bookkeeping to the kernel's standard `list_head` and simply requeuing a tx-error buffer at the head of the buffer list instead of tracking it through a second, unsynchronized reference. [NVD: CVE-2017-2636](https://nvd.nist.gov/vuln/detail/CVE-2017-2636), CVSS 3.1 7.0 HIGH.

### Case 2: The wrong tty_struct locked in a pty pair — CVE-2020-29660 and CVE-2020-29661

Two related bugs Jann Horn reported the same day, both in `drivers/tty/tty_jobctrl.c`. `tiocspgrp()` takes two `tty_struct` pointers — `tty` (what userspace's `ioctl()` fd refers to) and `real_tty` (the actual tty being modified, which differs when the ioctl runs on a pty *master* fd) — but the code updating `real_tty->pgrp` was taking `tty->ctrl_lock`, the *wrong side's* lock. Concurrent `TIOCSPGRP` calls on both ends of the same pty pair could race and corrupt the refcount of the underlying `struct pid`, a use-after-free (CVE-2020-29661). Separately, locking of `tty->session` was inconsistent across the codebase — most call sites protected it, but `disassociate_ctty()`, `__do_SAK()`, and `tiocgsid()` didn't, making a `TIOCGSID` read racy against a concurrent session teardown (CVE-2020-29660).

Both fixed by Jann Horn on the same day: [`54ffccbf053b`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=54ffccbf053b5b6ca4f6e45094b942fab92a25fc) locks `real_tty->ctrl_lock` instead of `tty->ctrl_lock` in `tiocspgrp()`; [`c8bcd9c5be24`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=c8bcd9c5be24fb9e6132e97da5a35e55a83e36b9) makes every writer of `->session` take a consistent lock and adds the missing locking to `tiocgsid()`/`__do_SAK()`. [NVD: CVE-2020-29661](https://nvd.nist.gov/vuln/detail/CVE-2020-29661) (CVSS 3.1 7.8 HIGH), [NVD: CVE-2020-29660](https://nvd.nist.gov/vuln/detail/CVE-2020-29660).

### Case 3: The ldisc semaphore hangup deadlock — CVE-2015-4170

During a 2013 rework replacing the line discipline's ad hoc mutex-plus-status-bits locking with a dedicated reader/writer semaphore (`ld_semaphore`, `drivers/tty/tty_ldsem.c`), the internal `ldsem_cmpxchg()` helper checked the *old* lock-count value after a compare-exchange instead of the *new* one. When a signalled reader/writer released its ldisc reference at the same moment a hangup was waiting and a new reader/writer was also trying to acquire, the wakeup for the waiting hangup could be missed — hanging the hangup indefinitely.

The fix ([`cf872776fc84`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=cf872776fc84128bb779ce2b83a37c884c3203ae), Peter Hurley, December 2013) reworks `ldsem_cmpxchg()` to correctly report success/failure and update the caller's count with the current value on failure, restoring the missed wakeup path. [NVD: CVE-2015-4170](https://nvd.nist.gov/vuln/detail/CVE-2015-4170), CVSS 3.0 4.7 MEDIUM.

### Case 4: The pty driver_data use-after-free on an unusual close order — not a CVE

A corner case in `drivers/tty/pty.c`: the *last* reference to a pty master/slave pair could be released via a previously-opened `/dev/tty` file descriptor rather than directly through the `/dev/ptmx`/`/dev/pts/N` file that owned the underlying devpts inode. If every `ptmx`/`pts/N` handle had already closed — and the devpts inode they held had already been released — before that final `/dev/tty` close ran, `tty->driver_data` (which pointed at that inode) was stale, and `pty_unix98_shutdown()` used it after it had already been freed.

The fix ([`2831c89f42dc`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=2831c89f42dcde440cfdccb9fee9f42d54bbc1ef), Herton R. Krzesinski, January 2016) takes an extra reference on the ptmx inode via `ihold()` at open time, and has `pty_unix98_shutdown()` determine the correct inode from either side of the pair and release that held reference explicitly, rather than trusting a `driver_data` pointer whose validity depended on close ordering.

## Common threads

| Pattern | n_tty echo race | pty_write saga | n_hdlc double-free | Wrong tty locked | ldsem hangup | pty driver_data UAF |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Writer path races an independently-triggered reader/echo path | Yes | Yes | — | — | — | — |
| A prior fix for one problem reintroduced a different one | — | Yes | — | — | — | — |
| Lock taken on the wrong side of a paired structure | — | — | — | Yes | — | — |
| Reachable by any local unprivileged user, no special config | Yes | Yes | Yes | Yes | — | — |
| Took years from introduction to fix | Yes (fix→exploit gap) | Yes (2018→2022) | Yes (2009→2017) | — | — | — |

**Two of six incidents are exactly the same shape: a writer path and a separately-triggered reader or echo path both mutate the same tty buffer, and only one of the two paths is covered by the lock that's supposed to protect it.** The n_tty echo race and the pty_write saga's Act 1 are both this pattern, in two different parts of the tty stack (N_TTY's write path vs. the pty layer's write path) — the shared root cause across the whole subsystem seems to be that "the write path" and "everything that can mutate the buffer" are not the same set of call sites, and a lock scoped to the former misses the latter.

**The pty_write saga is the sharpest illustration on this page of a fix trading one correctness property for another without anyone checking whether that trade was safe.** The 2020 fix correctly resolved a lockdep-detected deadlock — a real, verified problem — by moving a buffer-commit step outside a lock. What it didn't do was re-verify that the commit step still needed to stay atomic with the insert step for an unrelated reason (data-race safety) that the 2018 fix had established as an implicit invariant. Compare this to the [ALSA epic's mixer teardown UAF](../alsa/war-stories/mixer-teardown-use-after-free.md) or [Input/HID's type confusion bug](../input/war-stories/hid-validate-values-type-confusion.md): those are cases where a fix for one problem *introduced* a different one as a side effect. The pty_write saga is a variant — a fix *removed* a mitigation for a problem the *original* fix had solved, because the deadlock-focused fix wasn't checking for that property at all.

**Case 2's "wrong side of a paired structure" bug is a distinct root cause worth naming on its own.** A pty always has two `tty_struct`s — master and slave — and code that's handed one needs to know which operations apply to *that* struct and which need to go through its pair (`real_tty`). Locking the wrong one isn't a missing-lock bug; a lock was taken, just on the wrong object, which can be harder to catch in review than an outright missing lock.

## See also

- [The TTY Layer](README.md) — `tty_struct`, `tty_driver`, and the three-layer stack these incidents live inside
- [Serial Core and UART Drivers](serial.md) / [Line Disciplines, termios, and Pseudo-Terminals](line-disciplines.md) — the buffer and pty mechanics Cases 1-4 and both deep dives touch
- [ALSA War Stories](../alsa/war-stories.md) and [Input/HID War Stories](../input/war-stories.md) — sibling device-subsystem incident pages, for comparison on how often "a fix for one bug introduces a different one" recurs across this site's device-driver coverage
- [Locking](../locking/README.md) — general background on lock-scope, lock-ordering, and critical-section bugs, the pattern behind most of this page
