# The DEADLINE Lock Holder That Forgot to Inherit on the Way Down

> CVE-2026-23371 — a SCHED_DEADLINE task holding a priority-inheritance mutex, demoted to a lower scheduling class mid-hold, could skip inheriting the waiting donor's deadline parameters entirely, corrupting the kernel's own bandwidth accounting

Reported by
:   surfaced via `stress-ng --schedpolicy 0` on a PREEMPT_RT kernel on a large multi-CPU machine

Fixed in
:   commit introducing `__setscheduler_dl_pi()`, backported to 6.18.34 and 6.19.7, mainline in Linux 7.0

Bug present since
:   Linux 5.10, via commit `2279f540ea7d`

*Part of [War Stories: Scheduler Bugs](../war-stories.md).*

## Before state

SCHED_DEADLINE's priority-inheritance protocol lets a task that's blocked on a mutex temporarily donate its own deadline parameters to whichever task currently holds that mutex, so the holder runs with at least as tight a deadline as the task waiting on it — preventing an ordinary priority inversion from also becoming a deadline miss. A DEADLINE task doesn't always need to inherit a waiter's parameters, though: if the holder's *own* deadline is already shorter than the waiting donor's, there's nothing to inherit, and the kernel correctly leaves it alone.

## The trigger

The gap shows up when a lock holder that never needed to inherit gets changed to a *different*, lower-priority scheduling class via `sched_setscheduler()` while it's still holding the mutex:

1. A DEADLINE task ("donor") blocks on a PI mutex held by a second DEADLINE task ("holder").
2. Because the holder's own deadline was already tighter than the donor's, the holder never inherited the donor's parameters — correctly, per the rule above.
3. `sched_setscheduler()` then changes the holder from `SCHED_DEADLINE` to a lower-priority class while it's still holding the mutex.

At this point the holder should be recognized as boosted — it needs to inherit the donor's DEADLINE parameters *now*, precisely because it's about to stop being a DEADLINE task on its own merits — and be re-enqueued with the `ENQUEUE_REPLENISH` flag so bandwidth accounting treats it correctly. Because the holder's inheritance state was never established in step 2, nothing in `sched_setscheduler()`'s existing logic triggered that inheritance at the point of the class change.

## Observed behavior

Running `stress-ng --schedpolicy 0` on a PREEMPT_RT kernel on a large machine (the report cites CPU 93 in its trace) produced kernel warnings:

```
sched: DL de-boosted task PID 22725: REPLENISH flag missing
WARNING: CPU: 93 PID: 0 at kernel/sched/deadline.c:239 dequeue_task_dl+0x15c/0x1f8
```

followed by a `running_bw` underflow, reached via `dequeue_task_dl → dequeue_task → deactivate_task → push_dl_task → dl_task_timer → __hrtimer_run_queues → hrtimer_interrupt`. Without the missing `ENQUEUE_REPLENISH` flag, `enqueue_task_dl()` never recognized the demoted holder as a boosted task in the first place — leaving the kernel's own DEADLINE bandwidth bookkeeping for that CPU corrupted.

## Why it happened

`sched_setscheduler()`'s existing logic for handling a class change on a DEADLINE task only knew how to handle a task that was *already* tracked as boosted — one that had inherited parameters from some donor in the past. A holder that legitimately never needed to inherit anything (because its own deadline was already tight enough) fell outside that logic entirely, even though the *reason* it never inherited stopped being relevant the instant it was demoted away from `SCHED_DEADLINE` altogether. The condition for "does this task need to inherit right now" silently changed at the moment of the class switch, and nothing re-evaluated it.

## Resolution

The fix introduces `__setscheduler_dl_pi()`, called specifically when `sched_setscheduler()` detects a DEADLINE task (boosted or not) being moved to a lower-priority class. The new function makes the task inherit DEADLINE parameters from its PI donor at that exact moment and sets `ENQUEUE_REPLENISH` on the subsequent enqueue, so bandwidth accounting is redone correctly for a task that's only now becoming boosted, rather than assuming inheritance state established earlier is still the right answer.

## What it taught us

**A precondition that's correct at one point in a task's life can become wrong the instant something else about that task changes — even if nothing directly touches the state the precondition depends on.** The holder's decision not to inherit was correct when it was made; it stopped being correct the moment `sched_setscheduler()` pulled the task out of `SCHED_DEADLINE`, and nothing re-ran the inheritance check at that transition.

**Scheduling-class transitions are a natural place for boosted/inheritance state to fall out of sync, because the code paths that manage inheritance and the code paths that manage class changes are usually written, and reasoned about, separately.** The fix is scoped exactly to that intersection — a DEADLINE-specific hook inside the generic `sched_setscheduler()` path — rather than a change to the inheritance logic itself, which was correct on its own terms throughout.

!!! warning "Pattern to watch for"
    When a piece of state ("has this task inherited donor parameters") is established under one set of conditions and consumed under a different one, check every code path that can change the *conditions* — not just the ones that directly touch the state — for whether it needs to re-derive that state rather than leave it as a stale snapshot from before the conditions changed.

## See also

- [Scheduler Overview](../README.md) — SCHED_DEADLINE and CBS bandwidth accounting
- [Priority Inversion & PI Mutexes](../pi-mutexes.md) — the priority-inheritance protocol this bug's donor/holder relationship depends on

## External references

- [git.kernel.org: security/vulns — CVE-2026-23371](https://git.kernel.org/pub/scm/linux/security/vulns.git/plain/cve/published/2026/CVE-2026-23371.mbox) — the kernel CVE team's official announcement, including the full trace, root-cause writeup, and fixed commits across stable branches
