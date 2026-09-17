# wake_wide(): A Packing Shortcut Two Workloads Wanted Removed, and Nobody Could Prove Was Safe To Remove

> wake_wide() was rewritten in 2015 to make the scheduler search system-wide for an idle CPU, rather than pack, when it detects a genuine producer-consumer pair — but the same heuristic's fallback packing behavior for everything else also hurt hackbench-style all-to-all workloads, and a 2017 proposal to loosen that fallback stalled over an unquantified power-management cost, not a fight between the two workloads

Reported by
:   Josef Bacik (Facebook) — both the original workload behind the 2015 rewrite and the 2017 follow-up discussion, the latter also involving Joel Fernandes and Mike Galbraith

Heuristic introduced by
:   Michael Wang, as the original `wake_wide()`/`wakee_flips` tracking (`62470419e993`, 2013, mainline Linux 3.12); the version described below is Mike Galbraith's 2015 rewrite (`63b0e9edceec`, "sched/fair: Beef up wake_wide()"), feeding into `select_task_rq_fair()`

Article
:   [LWN 728942](https://lwn.net/Articles/728942/), "Reconsidering the scheduler's wake_wide() heuristic," by Matt Fleming (July 27, 2017)

Outcome
:   unresolved as of the cited discussion — "no proposal was the clear winner"

*Part of [War Stories: Scheduler Bugs](../war-stories.md).*

## Before state

`wake_wide()` exists to answer a narrow but important question when the scheduler wakes a sleeping task: should it look for an idle CPU sharing a last-level cache (LLC) with the waker, or is it worth paying the cost of a system-wide search? Galbraith rewrote it in 2015 for a specific, real Facebook workload that Bacik had reported: a latency-sensitive, heavily multithreaded application following a producer-consumer pattern, with one master task per NUMA node. That application's performance dropped dramatically whenever the scheduler placed a woken task onto a busy neighboring CPU instead of finding a genuinely idle one — for this workload, cache locality mattered far less than avoiding contention, so the fix was to make the scheduler search *wide*, system-wide, rather than pack, whenever it detected that master/slave shape.

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

If the "slave" side's flip count is below the LLC's CPU count (or the ratio between them is small), `wake_wide()` returns 0 and `select_task_rq_fair()` packs the pair's tasks into a single LLC domain rather than searching the whole system. Return 1 triggers the wide, system-wide search Facebook's workload needed.

## The trigger

Joel Fernandes questioned the `slave * factor` multiplication in an LKML discussion, and Bacik used the opening to raise a second, different problem: the `slave < factor` fallback — the condition that packs a wakee pair into one LLC domain when neither side shows a strong master/slave flip pattern — was also catching `hackbench`, which has no master/slave pair at all. `hackbench` forks more tasks than fit in one LLC domain in an all-to-all communication pattern; because none of those tasks individually accumulate the flip counts that would trigger a wide search, `wake_wide()`'s packing fallback repeatedly pulled them back into a single domain, and the tool's own shifting load pattern then pushed them back out again — producing extremely poor cache usage and worse measured performance than leaving the tasks spread out in the first place.

## Observed behavior

Bacik suggested simply dropping the `slave < factor` test, so the heuristic would default to a wide search more often. Fleming's own data, reported in the same article, showed that dropping the check entirely improved `hackbench`'s worst-case run duration. Nothing in that data showed a corresponding regression for Facebook's workload — the master/slave detection Facebook actually depends on lives in the `master < slave * factor` branch, which the proposal left untouched.

## Why it happened

The `slave < factor` fallback exists to avoid paying for a system-wide search when there's no detected reason to believe one is worth it — a cost-avoidance shortcut, not a mechanism Facebook's workload specifically relies on. `hackbench`'s all-to-all pattern falls into that fallback by coincidence: many tasks with individually modest flip counts look, to this one signal, like weak evidence against a wide search, even though the *real* reason a wide search would help here has nothing to do with a master/slave relationship existing or not. The heuristic conflates "no strong pairing detected" with "packing is fine," and those aren't the same claim.

That still didn't make loosening the fallback an easy call. The article notes a dimension entirely absent from the hackbench-focused data: packing tasks onto fewer CPUs is also a power-management strategy, letting more CPUs stay in a low-power idle state instead of being woken for a spread-out workload. Nobody in the thread had numbers for what a systematically wider default search would cost on that axis. On top of that, Galbraith — the rewrite's author — was wary of touching a heuristic this cheap and this widely exercised on the strength of one benchmark, regardless of whose data motivated it.

## Resolution

None reached, as of the cited discussion. Bacik's own conclusion: "messing with `wake_wide()` itself is too big of a hammer, we probably need a middle ground." Galbraith's response set the bar for any replacement: "If you have ideas to improve or replace that heuristic, by all means go for it, just make damn sure it's dirt cheap. Heuristics all suck one way or another, problem is that nasty old 'perfect is the enemy of good' adage."

## What it taught us

**A heuristic's cost-avoidance shortcut can hurt an unrelated workload it was never tuned against, without that fix costing the workload the heuristic *was* tuned for.** `hackbench` and Facebook's producer-consumer application didn't actually want opposite things here — the fallback that hurt `hackbench` wasn't load-bearing for Facebook's case at all. What stalled the fix was a cost nobody had measured on a third axis: power.

**Scheduler tuning discussions routinely have to weigh dimensions the benchmark in front of you doesn't measure.** `hackbench` run time says nothing about power consumption, and a fix that looks like a clear win against the workload that motivated it can still be shelved because of a plausible cost elsewhere that nobody could rule out.

!!! note "Not every war story ends with a fix"
    This one is included specifically because it didn't resolve cleanly. A change that helped the workload actually reported in the thread, with no data showing it hurt the workload the heuristic was originally written for, still didn't ship — because an unmeasured concern (power) and a general caution about touching cheap, widely-exercised heuristics were enough to stall it. Sometimes the honest end state of a scheduler debate is "we didn't find a reason this is unsafe, and that wasn't enough."

## See also

- [Scheduler Overview](../README.md) — the fair scheduling class and task placement
- [EEVDF](../eevdf.md) — the scheduling algorithm `select_task_rq_fair()`'s placement decisions feed into

## External references

- [LWN: Reconsidering the scheduler's wake_wide() heuristic](https://lwn.net/Articles/728942/) — Matt Fleming's coverage of the LKML discussion, including the `wake_wide()` source and the Bacik/Fernandes/Galbraith exchange quoted above
