# The Deadlock Detector That Scheduled While Atomic

> CVE-2024-46829 — when rt_mutex's own cycle detector confirmed a genuine deadlock, its response was to warn and then loop forever calling `schedule()` — while still holding the raw spinlock that every other waiter on the same lock needed to make progress

Disclosed
:   September 27, 2024 (NVD, auto-generated from the Linux kernel's own CVE tooling)

Reported by
:   Roland Xu, via LKML patch submission

CVSS
:   5.5 MEDIUM (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H`)

Bug present since
:   3.16 (2014), when `rt_mutex_handle_deadlock()` was introduced

Fixed in
:   commit `d33d26036a02`, mainline Linux 6.11 (September 15, 2024)

Exploit tool
:   no — a code-review-style fix, not a fuzzer or crash report

Actively exploited
:   no confirmed cases (not on CISA KEV)

*Part of [War Stories: Locking and Synchronization Bugs](../war-stories.md).*

## Before state

rt_mutex's slow-path lock acquisition holds `rt_mutex::wait_lock` — a raw spinlock, non-preemptible and non-sleeping even under `PREEMPT_RT` — across the chain-walk that checks whether taking this lock would create a cycle in the priority-inheritance dependency graph. `3d5c9340d194` ("rtmutex: Handle deadlock detection smarter", 2014) made that chain-walk report every genuine deadlock it finds, not just the ones a caller explicitly asked to detect, and introduced `rt_mutex_handle_deadlock()` to react to a confirmed cycle: print a warning, and park the offending task in `TASK_INTERRUPTIBLE` inside an infinite `while (1) { schedule(); }` loop, since there is no sane way to unwind a task that has just been proven to be part of a genuine circular wait.

## The trigger

`rt_mutex_handle_deadlock()` was called from inside the slow-path lock function, which still held `wait_lock` at that point in its control flow. Nothing in the 2014 commit dropped it before entering the parking loop — the function simply issued its `WARN(1, "rtmutex deadlock detected\n")` and called `schedule()` with a raw spinlock still held. Deadlock detection isn't exercised on every lock acquisition: on a non-debug kernel it's gated behind an explicit `RT_MUTEX_FULL_CHAINWALK` flag, which the PI-futex proxy-lock path (`__rt_mutex_start_proxy_lock()`, backing glibc's `PTHREAD_PRIO_INHERIT` mutexes) always passes — "We enforce deadlock detection for futexes," as a comment in that same 2014 commit puts it. Kernels built with `CONFIG_DEBUG_RT_MUTEXES=y` exercise it on every rt_mutex acquisition, PI-futex or not.

## Observed behavior

Calling `schedule()` while holding a raw spinlock is a documented invariant violation, and the scheduler itself checks for it on every call, in production kernels, not just debug builds: `__schedule()`'s `schedule_debug()` tests `in_atomic_preempt_off()` and, if true, prints `"BUG: scheduling while atomic: %s/%d/0x%08x\n"`, dumps held locks, and — if the system has `panic_on_warn` set — panics outright. Beyond the diagnostic splat, the practical failure compounds: the task that hit the confirmed deadlock is now parked, off-CPU, in an interruptible sleep, while `wait_lock` remains held. Any other CPU that needs that same `wait_lock` — another waiter on the same rt_mutex, or the lock's own owner doing PI bookkeeping — spins indefinitely in the raw spinlock's busy-wait, since nothing guarantees the sleeping holder is ever rescheduled to release it. A confirmed, correctly-detected deadlock in one task turns into an actual system-wide lockup, via the very code path whose job was to report the deadlock safely.

## Why it happened

The 2014 commit's own description frames its goal precisely: stop silently returning `0` on a detected cycle and instead throw a warning and park the task. A comment left in that commit's diff, above the new parking loop, put it more bluntly (typo included): "Yell lowdly and stop the task right here." That's a reasonable response to "there's no way to make progress" — but "stop the task right here" was implemented as an infinite scheduling loop, and nobody at the time traced what "right here" meant in terms of which locks were still held across that loop. The bug isn't in the decision to park the task; it's that the parking code was written inside a critical section without re-examining what state the function still held when it got there.

## Resolution

`d33d26036a02` ("rtmutex: Drop rt_mutex::wait_lock before scheduling") adds a `raw_spin_unlock_irq(&lock->wait_lock)` immediately before the `WARN()` and the parking loop — releasing the lock before doing anything that could sleep, rather than after. Thomas Gleixner's own summary of the fix, in his pull request to Linus, states the bug plainly: "The deadlock detection code drops into an infinite scheduling loop while still holding rt_mutex::wait_lock, which rightfully triggers a 'scheduling in atomic' warning. Unlock it before that." The submitted patch had originally placed the unlock *after* the `WARN()`; Gleixner moved it earlier when merging, so the warning itself no longer fires from atomic context either.

## What it taught us

**"Stop the task safely" and "stop the task without checking what's still locked" are different fixes, and it's easy to ship the second while believing you wrote the first.** The 2014 commit's intent — make a detected deadlock loud and inert rather than silently returning success — was correct. The bug was entirely in the mechanics of *how* the task was made inert, not in the decision to make it so.

**A code path that only exists to report a fatal condition still has to honor the same locking discipline as every other path.** It's tempting to treat an already-broken-beyond-recovery branch as exempt from ordinary care, since "the task is stuck anyway" — but a lock held into that branch doesn't stop mattering to every other task still waiting on it.

!!! warning "Pattern to watch for"
    Any "we've detected a fatal condition, park this task" code path deserves the exact same lock-audit as ordinary control flow — arguably more, since it's usually reached rarely enough that ordinary testing won't exercise it. Before adding a call that can block or sleep (`schedule()`, `msleep()`, any allocation that can wait) inside an error-handling or panic-adjacent branch, check what the immediately enclosing scope is still holding, the same way you would for the success path.

## See also

- [Locking Overview](../README.md) — spinlocks, rt_mutex, and the deadlock-detection machinery this bug lives in
- [The PI-Mutex Origin Story](pi-mutex-origin.md) — rt_mutex's priority-inheritance chain-walk, the mechanism whose cycle detection this bug's parking loop responds to
- [The PI-Futex Fixup That Had No Answer for a Permanent Fault](pi-futex-fixup-owner-uaf.md) — a third rt_mutex/PI-futex correctness bug, on the fault-handling side

## External references

- [GitHub mirror: d33d26036a02](https://github.com/torvalds/linux/commit/d33d26036a0274b472299d7dcdaa5fb34329f91b) — "rtmutex: Drop rt_mutex::wait_lock before scheduling," the fix
- [GitHub mirror: 3d5c9340d194](https://github.com/torvalds/linux/commit/3d5c9340d1949733eb37616abd15db36aef9a57c) — "rtmutex: Handle deadlock detection smarter," the 2014 commit that introduced the unconditional parking loop
- [lore.kernel.org: the original patch submission](https://lore.kernel.org/all/ME0P300MB063599BEF0743B8FA339C2CECC802@ME0P300MB0635.AUSP300.PROD.OUTLOOK.COM/) — Roland Xu's "Avoid schedule while atomic if meeting the early deadlock"
- [NVD: CVE-2024-46829](https://nvd.nist.gov/vuln/detail/CVE-2024-46829) — CVE record, CVSS 5.5 MEDIUM, published September 27, 2024
