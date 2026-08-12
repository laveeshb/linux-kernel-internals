# War Stories: Locking and Synchronization Bugs

> Three CVEs and one origin story, all from the same corner of the kernel — rt_mutex and PI-futexes, the priority-inheritance machinery that keeps a high-priority task from starving behind a low-priority lock holder, and the three separate ways getting that machinery's bookkeeping wrong has gone badly

All three CVEs here live in the same subsystem — priority-inheritance futexes and the rt_mutex they're built on. Two of the three are the mirror image of each other: rt_mutex has to keep several pieces of state (a userspace futex word, `pi_state`, the mutex's own owner field) consistent across code paths that don't all touch every piece at once, and one bug left that state inconsistent after an unhandled fault while the other missed a precondition check its sibling function already had. The third CVE is a different kind of mistake entirely — a lock-discipline violation, not a state-consistency one. The fourth page isn't a bug at all: it's why any of this machinery exists.

## Incidents

Ordered reverse chronologically by when the fix (or, for the origin story, the original merge) landed in mainline — newest first.

### [The Deadlock Detector That Scheduled While Atomic](war-stories/rtmutex-deadlock-detector-atomic-sleep.md)
**Linux 6.11 (September 2024) · CVE-2024-46829**
rt_mutex's own cycle detector confirmed a genuine deadlock and responded by warning and then looping forever calling `schedule()` — while still holding the raw spinlock every other waiter on the same lock needed to make progress.

### [The PI-Futex Fixup That Had No Answer for a Permanent Fault](war-stories/pi-futex-fixup-owner-uaf.md)
**Linux 5.11 (January 2021) · CVE-2021-3347**
When the kernel couldn't write a new owner's TID back into a PI futex word, it gave up without reconciling its own rt_mutex and pi_state — and a subsequent unlock on that mismatch corrupted a waiter structure still resident on another task's kernel stack.

### [Towelroot: The Missing Check on the Requeuer's Half of the Pair](war-stories/towelroot-futex-requeue.md)
**Linux 3.15 (June 2014) · CVE-2014-3153**
`futex_requeue()` never checked that a PI-requeue's source and destination were different futexes — the identical check on the sibling function, added two years earlier for an unrelated crash, hadn't been enough to catch it.

### [The PI-Mutex Origin Story](war-stories/pi-mutex-origin.md)
**Linux 2.6.18 (September 2006) · not a CVE**
A low-priority lock holder can be starved by a medium-priority task that has nothing to do with the lock at all — priority-inheritance mutexes exist because a plain mutex has no way to stop this, and it took Linus Torvalds most of a year to be convinced the kernel should carry the fix.

## Common threads

| Pattern | Deadlock detector | PI-futex fixup | Towelroot | PI-mutex origin |
|---------|:---:|:---:|:---:|:---:|
| Involves rt_mutex/PI-futex bookkeeping specifically | Yes | Yes | Yes | Yes (defines it) |
| Root cause: a lock held across a call that shouldn't happen while holding it | Yes | No | No | — |
| Root cause: state left inconsistent after an unhandled failure path | No | Yes | No | — |
| Root cause: a fix applied to one function, needed on its untouched sibling | No | No | Yes | — |
| Years between the bug's introduction and its fix | 10 (2014→2024) | 13 (2008→2021) | ~5 (2009→2014) | — |
| CISA KEV-listed | No | No | Yes (May 2022) | — |
| Public exploit tool published | No | No | Yes (Towelroot) | — |

**Two of the three CVEs are the same shape of mistake, from opposite directions.** The PI-futex fixup bug is a fault-handling path that left cross-referencing state inconsistent because the "permanent failure" branch was never written. Towelroot is a missing precondition check that *had* been written — just on the wrong half of a two-function pair. Both are failures to fully generalize a fix: the 2008 retry logic generalized "the fault will eventually resolve" without a fallback; the 2012 `trinity`-driven fix generalized "check `uaddr != uaddr2`" to exactly one function instead of the pair that shared the invariant.

**The deadlock-detector bug is the odd one out: a lock-discipline violation in error-handling code, not a state-consistency bug.** Unlike the other two, nothing about *what* the code was tracking was wrong — the mistake was scheduling with a spinlock held, in a branch whose entire job was to report that no further progress was possible. It's also the only one of the three not tied to PI-futexes at all: `CONFIG_DEBUG_RT_MUTEXES=y` kernels can hit it through any rt_mutex, not just the futex path.

**None of the three CVEs here have a public exploit tool except Towelroot — and Towelroot's is one of the most consequential local root exploits the kernel has ever shipped.** Read alongside [the origin story](war-stories/pi-mutex-origin.md), there's a certain irony: the mechanism Torvalds worried was "your system is broken anyway" territory became, about eight years later, the exact subsystem whose bookkeeping mistakes produced the highest-impact bug on this page.

## See also

- [Locking Overview](README.md) — spinlocks, mutexes, rt_mutex, and RCU
- [VFS War Stories](../vfs/war-stories.md) — a comparable set of local-privilege CVEs from a different subsystem, useful for contrasting root-cause shapes
- [GPU/DRM War Stories](../drm/war-stories.md) — reliability-only incidents (no CVEs) from a different kind of shared kernel-internal scheduling problem
