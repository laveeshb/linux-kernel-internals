# The PI-Mutex Origin Story

> A low-priority lock holder can be starved by a medium-priority task that has nothing to do with the lock at all, indefinitely — priority-inheritance mutexes exist because a plain mutex has no way to stop this, and it took a blunt public objection from Linus Torvalds before the kernel carried a mainline implementation anyway

Landed
:   Linux 2.6.18 (September 20, 2006)

Authors
:   Ingo Molnar, Thomas Gleixner (rt_mutex core and PI-futex integration); Steven Rostedt (design documentation)

Originated in
:   the out-of-tree `-rt` (PREEMPT_RT) patch series

Not a CVE

*Part of [War Stories: Locking and Synchronization Bugs](../war-stories.md).*

## Before state

A plain mutex enforces exclusion but has nothing to say about scheduling. The kernel's own design documentation for rt_mutex states the failure mode precisely: with three processes A (high priority), B (medium), and C (low), where A blocks on a lock C holds, "B executes, and since B is of a higher priority than C, it preempts C, but by doing so, it is in fact preempting A which is a higher priority process. ... B is a CPU hog and will never give C a chance to release the lock." This is *unbounded* priority inversion — A's wait time is bounded only by B's behavior, which has nothing to do with the lock A actually wants, rather than by the length of C's critical section. A scheduler that always runs the highest-priority runnable task, correctly and exactly as designed, produces this outcome — the bug isn't in the scheduler.

## The trigger

Priority-inheritance mutexes were not a novel idea in 2006 — the mechanism had existed in real-time systems literature and out-of-tree Linux `-rt` patches for years by the time Ingo Molnar and Thomas Gleixner proposed merging a mainline implementation. Linus Torvalds's opposition was blunt and public, in a December 16, 2005 LKML post: "Friends don't let friends use priority inheritance. Just don't do it. If you really need it, your system is broken anyway." Jonathan Corbet's LWN coverage in April 2006, describing the renewed merge push, noted it was "too late for 2.6.17, but, if no real opposition develops, the PI-futex code might just find its way into a subsequent kernel."

## Observed behavior

The mechanism that eventually merged solves the inversion by making C's *effective* priority track whoever is waiting on a lock C holds, for exactly as long as C holds it: when A blocks on C's lock, C inherits A's priority immediately, so B — genuinely lower priority than the boosted C — can no longer preempt it. The moment C releases the lock, the boost is removed and C returns to its own priority. The kernel's rt_mutex design documentation describes this as a *chain*, not just a single hop: if C is itself blocked on a lock D holds, D inherits transitively, and "if process G has the highest priority in the chain, then all the tasks up the chain... must have their priorities increased to that of G" — chains can merge (multiple waiters converging on the same lock) but never diverge, since a task can only block on one lock at a time. The same chain-walk function handles the reverse direction too: released, timed-out, or signaled waiters trigger the identical logic to deboost, not a separate special case.

## Why it happened

This isn't a story about a mistake — it's a story about a real, well-understood problem in real-time systems that had an equally well-understood *userspace real-time* answer, contested specifically on whether the *general-purpose kernel* should carry the mechanism at all. Torvalds's objection wasn't that priority inheritance doesn't work; it was a judgment that most systems reaching for it have a design problem PI merely papers over, and that building it into the kernel invites exactly that kind of paper-over. The feature merged anyway, scoped narrowly around a concrete userspace consumer: glibc's `pthread_mutex` priority-inheritance support, which needed a real kernel-level PI primitive rather than something built entirely out of userspace polling.

## Resolution

`23f78d4a03c5` ("[PATCH] pi-futex: rt mutex core", Ingo Molnar) introduced `kernel/rtmutex.c` on June 27, 2006, followed the same day by the futex-facing half, `c87e2837be82` ("[PATCH] pi-futex: futex_lock_pi/futex_unlock_pi support") — adding the `FUTEX_LOCK_PI`/`FUTEX_UNLOCK_PI` operations that give userspace's `pthread_mutex` a real kernel-backed priority-inheritance primitive, distinct from and complementary to the separately-merged "robust futex" (owner-death handling) work from earlier the same year. Both landed in the merge window that opened right after 2.6.17, shipping in **Linux 2.6.18**, released September 20, 2006 — about five months after LWN's coverage correctly guessed "a subsequent kernel."

The kernel's own `pi-futex.rst` documentation describes the resulting fast path plainly: "in the user-space fastpath a PI-enabled futex involves no kernel work (or any other PI complexity) at all" — ordinary atomic compare-and-swap, identical in cost to a non-PI futex when uncontended. Only the slow path (actual contention) touches the kernel's rt_mutex machinery at all.

## What it taught us

**A maintainer's blanket rejection of a mechanism and that mechanism eventually merging are not in tension — they're often the same design process working correctly.** What shipped in 2.6.18 is scoped tightly around one concrete consumer — glibc's PI-aware `pthread_mutex` support — rather than a general-purpose "fix your priority inversions" hammer, which is a large part of why the implementation stayed as narrow as it is.

**Solving unbounded priority inversion changes what "priority" means at exactly one boundary: the moment a higher-priority task starts waiting on you.** The rt_mutex design's chain-walk is careful to bound how much work that boost can cost (at most two locks held at once while walking a chain) — a scheduling-correctness fix that also had to come with its own resource-bound engineering, not just an algorithmic idea.

!!! warning "Pattern to watch for"
    Priority inversion doesn't require a bug anywhere — every individual component (scheduler, lock, the unrelated medium-priority task) can be behaving exactly as designed, and the system still starves a high-priority task indefinitely. If a real-time or latency-sensitive workload shares a lock with lower-priority code and any unrelated medium-priority work exists on the system, ask whether that lock needs priority inheritance — not whether anything nearby is "broken."

## See also

- [Locking Overview](../README.md) — mutexes, spinlocks, and where rt_mutex fits among them
- [The PI-Futex Fixup That Had No Answer for a Permanent Fault](pi-futex-fixup-owner-uaf.md) — a correctness bug in the machinery this page describes being built
- [Towelroot: The Missing Check on the Requeuer's Half of the Pair](towelroot-futex-requeue.md) — a second PI-futex correctness bug, in the requeue path

## External references

- [GitHub mirror: 23f78d4a03c5](https://github.com/torvalds/linux/commit/23f78d4a03c53cbd75d87a795378ea540aa08c86) — "[PATCH] pi-futex: rt mutex core," the commit that introduced `kernel/rtmutex.c`
- [GitHub mirror: c87e2837be82](https://github.com/torvalds/linux/commit/c87e2837be82df479a6bae9f155c43516d2feebc) — "[PATCH] pi-futex: futex_lock_pi/futex_unlock_pi support," the futex-facing integration
- [LWN: Priority inheritance in the kernel](https://lwn.net/Articles/178253/) — Jonathan Corbet, April 3, 2006
- [LWN: mirror of Linus Torvalds's December 2005 LKML post](https://lwn.net/Articles/178258/) — "Friends don't let friends use priority inheritance"
- [Kernel documentation: RT-mutex implementation design](https://docs.kernel.org/locking/rt-mutex-design.html) — Steven Rostedt's design document, the source for the priority-inversion and PI-chain explanations above
- [Kernel documentation: Lightweight PI-futexes](https://docs.kernel.org/locking/pi-futex.html) — the source for the fast-path quote above
