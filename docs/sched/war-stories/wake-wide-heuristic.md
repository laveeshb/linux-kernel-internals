# wake_wide(): A Heuristic That Helps One Workload by Hurting Another

> Facebook's producer-consumer workload needed the scheduler to pack woken tasks tightly onto nearby CPUs for cache locality — but the same packing heuristic made hackbench-style all-to-all workloads ping-pong between CPU caches and perform worse

Reported by
:   Josef Bacik (Facebook), in an LKML thread also involving Joel Fernandes and Mike Galbraith

Heuristic introduced by
:   Mike Galbraith, as `wake_wide()`, feeding into `select_task_rq_fair()`

Article
:   [LWN 728942](https://lwn.net/Articles/728942/), "Reconsidering the scheduler's wake_wide() heuristic," by Matt Fleming (July 28, 2017)

Outcome
:   unresolved as of the cited discussion — "no proposal was the clear winner"

*Part of [War Stories: Scheduler Bugs](../war-stories.md).*

## Before state

`wake_wide()` exists to answer a narrow but important question when the scheduler wakes a sleeping task: should it look for an idle CPU sharing a last-level cache (LLC) with the waker, or is it worth paying the cost of a system-wide search? Galbraith wrote it for a specific, real Facebook workload: a latency-sensitive, heavily multithreaded application following a producer-consumer pattern, with one master task per NUMA node. That application's performance dropped dramatically whenever the scheduler placed a woken task onto a busy neighboring CPU instead of finding a genuinely idle one — for this workload, cache locality mattered far less than avoiding contention.

The heuristic tracks how often a task and its wakee flip roles (`p->wakee_flips`) to infer a master/slave relationship, then decides whether to constrain the search to the local LLC domain:

```c
static int wake_wide(struct task_struct *p)
{
    unsigned int master = current->wakee_flips;
    unsigned int slave  = p->wakee_flips;
    int factor = this_cpu_read(sd_llc_size);

    if (master < slave)
        swap(master, slave);
    if (slave < factor || master < slave * factor)
        return 0;
    return 1;
}
```

If the "slave" side's flip count is below the LLC's CPU count (or the ratio between them is small), `wake_wide()` returns 0 and `select_task_rq_fair()` packs the pair's tasks into a single LLC domain rather than searching the whole system.

## The trigger

Joel Fernandes questioned the `slave * factor` multiplication in an LKML discussion, and Bacik used the opening to raise a problem he was seeing directly: the packing behavior that helped Facebook's specific master/slave workload actively hurt a different, equally common pattern — many tasks all communicating with each other rather than in strict pairs. `hackbench` is exactly that shape: it forks more tasks than fit in one LLC domain, they start out spread across multiple domains, and `wake_wide()`'s packing logic then repeatedly ping-pongs them back into a single domain and out again as the tool's own load pattern shifts — producing extremely poor cache usage and worse measured performance than leaving the tasks spread out in the first place.

## Observed behavior

Bacik measured that dropping the `slave < factor` test entirely improved `hackbench`'s worst-case run duration, by reducing how aggressively the scheduler tried to pack a workload that gets no benefit from a shared LLC in the first place. But that same change — packing less aggressively by default — has the opposite effect on the workload `wake_wide()` was written for: Facebook's producer-consumer application specifically needs the aggressive-packing behavior to avoid its own latency regression.

## Why it happened

`wake_wide()` was tuned against one real, specific, latency-sensitive production workload. It worked well for that workload precisely because it made a strong assumption — that a small number of "slave" flips relative to LLC size indicates a tight producer-consumer pair that benefits from packing. `hackbench`'s all-to-all communication pattern violates that assumption's premise entirely: there is no master/slave pair to detect, just many tasks that happen to trigger the same flip-counting logic. A heuristic tuned to correctly infer one relationship shape has no principled way to also correctly infer the *absence* of that shape for a fundamentally different communication pattern — from the flip counts alone, the two cases can look identical.

There was also a dimension entirely absent from the performance-tuning discussion, which the article notes explicitly: packing tasks onto fewer CPUs is also a power-management strategy, since it lets more CPUs stay in a low-power idle state instead of being woken to run a spread-out workload. Any fix aimed purely at `hackbench`'s cache behavior risked trading away that power benefit for workloads that never asked for one.

## Resolution

None reached, as of the cited discussion. Bacik's own conclusion: "messing with `wake_wide()` itself is too big of a hammer, we probably need a middle ground." Galbraith, the heuristic's original author, pushed back against changing it casually at all: "If you have ideas to improve or replace that heuristic, by all means go for it, just make damn sure it's dirt cheap. Heuristics all suck one way or another, problem is that nasty old 'perfect is the enemy of good' adage."

## What it taught us

**A scheduler heuristic tuned against one real workload can be actively wrong for another real workload, using the exact same signal.** `wake_wide()`'s flip-count logic can't distinguish "a tight producer-consumer pair" from "one of many tasks in an all-to-all mesh" — both produce similar-looking flip patterns, but the correct scheduling decision is opposite in each case.

**Scheduler tuning discussions routinely have to weigh dimensions the benchmark in front of you doesn't measure.** `hackbench` run time says nothing about power consumption, and a fix that only looks like a clear win on one axis can be a regression on another that nobody was watching.

!!! note "Not every war story ends with a fix"
    This one is included specifically because it didn't resolve cleanly. The debate captures something true about scheduler heuristics generally: the same mechanism that measurably helps one production workload can measurably hurt another, and there's no way to know which without someone hitting the regression in production and someone else being willing to defend the original design against a well-intentioned "simplification."

## See also

- [Scheduler Overview](../README.md) — the fair scheduling class and task placement
- [EEVDF](../eevdf.md) — the scheduling algorithm `select_task_rq_fair()`'s placement decisions feed into

## External references

- [LWN: Reconsidering the scheduler's wake_wide() heuristic](https://lwn.net/Articles/728942/) — Matt Fleming's coverage of the LKML discussion, including the `wake_wide()` source and the Bacik/Fernandes/Galbraith exchange quoted above
