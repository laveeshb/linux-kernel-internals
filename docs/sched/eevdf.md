# EEVDF Scheduler

> Earliest Eligible Virtual Deadline First: adding latency guarantees to fairness

## The problem with CFS

CFS selects the task with the smallest `vruntime`. This is fair but not deadline-aware.

Consider a task that just woke from I/O. Its vruntime may be behind the pack, so it runs quickly — but CFS has no concept of *urgency*. A task processing a network packet that needs a 1ms response has the same scheduling priority as a batch task that just happened to sleep briefly.

EEVDF fixes this by replacing CFS's "minimum vruntime" selection with **"earliest deadline among eligible tasks"**.

## Background

EEVDF is based on the 1995 technical report ["Earliest Eligible Virtual Deadline First: A Flexible and Accurate Mechanism for Proportional Share Resource Allocation"](https://citeseerx.ist.psu.edu/document?repid=rep1&type=pdf&doi=805acf7726282721504c8f00575d91ebfd750564) by Ion Stoica and Hussein Abdel-Wahab (William & Mary).

It was implemented for Linux by Peter Zijlstra (Intel) and merged in kernel 6.6 (October 2023). **Patch series**: [lore.kernel.org, May 2023](https://lore.kernel.org/lkml/20230531115839.089944915@infradead.org/)

**Commits**:
- [`147f3efaa241`](https://git.kernel.org/linus/147f3efaa24182a21706bca15eab2f3f4630b5fe) — `sched/fair: Implement an EEVDF-like scheduling algorithm`
- [`5e963f2bd465`](https://git.kernel.org/linus/5e963f2bd4654a202a8a05aa3a86cb0300b10e6c) — `sched/fair: Commit to EEVDF` (makes EEVDF unconditional in `pick_next_entity`)

## Two concepts: eligibility and virtual deadline

### Eligibility

A task is **eligible** if it hasn't consumed more than its fair share of CPU up to the current virtual time. Informally: a task that has been running too much is ineligible and shouldn't preempt others.

```c
// kernel/sched/fair.c
static bool vruntime_eligible(struct cfs_rq *cfs_rq, u64 vruntime)
{
    struct sched_entity *curr = cfs_rq->curr;
    s64 avg = cfs_rq->avg_vruntime;
    long load = cfs_rq->avg_load;

    if (curr && curr->on_rq)
        avg += entity_key(cfs_rq, curr) * curr->load.weight;

    return vruntime * load < avg;
}
```

A task is eligible if its `vruntime` is at or behind the weighted average vruntime of the runqueue.

### Virtual deadline

Each task has a `deadline` — the virtual time by which it should have run. When a task is placed on the runqueue, its deadline is set as:

```c
// kernel/sched/fair.c
se->deadline = se->vruntime + calc_delta_fair(se->slice, se);
```

This means: "I want to run for `slice` worth of virtual time starting from my current vruntime." The deadline is the end of that window.

A task with a short `slice` gets an early deadline and runs sooner. A task with a long `slice` gets a later deadline and may wait.

## The new fields in sched_entity

EEVDF added several fields to `struct sched_entity` (in `include/linux/sched.h`):

```c
struct sched_entity {
    // ... existing CFS fields ...
    u64 vruntime;       // virtual runtime (still central)
    u64 deadline;       // virtual deadline for this request
    u64 slice;          // requested time slice
    u64 vlag;           // virtual lag: how far behind/ahead of ideal
    // ...
};
```

### vlag

`vlag` tracks the task's lag relative to the ideal fair-share schedule. Positive lag means the task is behind its ideal share (hasn't gotten enough CPU); negative lag means it's ahead.

When a task wakes up, `vlag` is used to place its `vruntime` appropriately — preventing sleeping tasks from either starving (getting nothing) or bursting (monopolizing CPU after a long sleep).

## Selection: __pick_eevdf()

The core selection function:

```c
// kernel/sched/fair.c
static struct sched_entity *
__pick_eevdf(struct cfs_rq *cfs_rq)
{
    struct rb_node *node = cfs_rq->tasks_timeline.rb_root.rb_node;
    struct sched_entity *se, *curr, *best = NULL;

    while (node) {
        se = __node_2_se(node);

        // Is this task eligible?
        if (entity_eligible(cfs_rq, se)) {
            // Is this the earliest deadline among eligible tasks?
            if (!best || deadline_gt(best->deadline, se->deadline))
                best = se;
        }

        // Prune the search using subtree min_deadline
        // (not all subtrees need to be searched)
        if (node->rb_left &&
            __node_2_se(node->rb_left)->min_deadline <= se->deadline)
            node = node->rb_left;
        else
            node = node->rb_right;
    }

    return best;
}

static struct sched_entity *pick_eevdf(struct cfs_rq *cfs_rq)
{
    return __pick_eevdf(cfs_rq);
}
```

The algorithm walks the RB-tree, finds all eligible tasks, and returns the one with the earliest (smallest) deadline. Non-eligible tasks are skipped. The tree traversal is pruned using cached `min_deadline` subtree values for efficiency.

## How EEVDF improves latency

### Scenario: batch + interactive task

With CFS (simplified):
```
Time:    0   1   2   3   4   5   6   7   8ms
Batch:   ████████░░░░░░░░████████
Network: ░░░░░░░░████████
                ↑ woke here, had to wait for batch's vruntime to be overtaken
```

With EEVDF:
```
Time:    0   1   2   3   4   5   6   7   8ms
Batch:   ████████░░░░░░░░░░░░░░░░
Network: ░░░░░░░░████░░░░░░░░░░░░
                ↑ eligible + earliest deadline → runs immediately
```

The network task has an early deadline (small requested slice) and is eligible (just woke). EEVDF schedules it immediately without waiting for vruntime to drift.

## Time slice and sched_base_slice_ns

When EEVDF was merged in 6.6, the old `sched_latency_ns` / `sched_min_granularity_ns` tunables were deprecated in favor of `sched_base_slice_ns` ([`e4ec3318a17f`](https://git.kernel.org/linus/e4ec3318a17f5dcf11bc23b2d2c1da4c1c5bb507), Peter Zijlstra); the sysctls still exist but `sched_base_slice_ns` is now the primary knob. The base time slice is now controlled by a single knob:

```bash
# Base time slice (default: 3ms = 3000000ns)
cat /proc/sys/kernel/sched_base_slice_ns
```

Each task's `slice` is set to `sched_base_slice_ns` scaled by the task's weight relative to the average. Tasks with larger requested slices get later deadlines; tasks with smaller slices get earlier deadlines and lower latency.

Applications can request a specific latency hint via `sched_setattr()` with `SCHED_FLAG_UTIL_CLAMP_MIN`/`SCHED_FLAG_UTIL_CLAMP_MAX` for frequency scaling, but direct slice control from userspace is not yet exposed.

## Comparing CFS and EEVDF selection

| Aspect | CFS | EEVDF |
|--------|-----|-------|
| Selection criterion | `min(vruntime)` — leftmost RB-tree node | `min(deadline)` among eligible tasks |
| Eligibility check | None | `vruntime ≤ avg_vruntime` |
| Latency for waking tasks | Depends on vruntime gap | Immediate if eligible + early deadline |
| Starvation prevention | Via vruntime convergence | Via eligibility + deadline together |
| Worst-case selection | O(1) (leftmost node) | O(log n) (tree walk, pruned) |
| Time slice | Implicit, from latency target | Explicit (`se->slice`) |

## What didn't change

EEVDF replaced the *selection* inside `fair_sched_class` — the vruntime machinery, weight calculations, group scheduling, load balancing, and enqueue/dequeue paths are largely unchanged. The `sched_prio_to_weight` table, `calc_delta_fair()`, `update_curr()`, and cgroup integration all remain from CFS.

This means EEVDF is an evolution of CFS, not a replacement. The name "CFS" is increasingly a misnomer for what's actually EEVDF — but the `fair_sched_class` still carries the name.

## Checking EEVDF behavior

```bash
# Per-task sched info (includes vruntime, deadline, slice)
cat /proc/$PID/sched

# Scheduler wakeup and switch latencies
perf sched record -a sleep 10
perf sched latency --sort=max

# Watch scheduling decisions in real time
trace-cmd record -e sched:sched_switch -e sched:sched_wakeup ./workload
trace-cmd report
```

## Further reading

- [CFS](cfs.md) — The vruntime foundation that EEVDF builds on
- [Runqueues](runqueues.md) — The per-CPU context EEVDF runs within
- [LWN: An EEVDF CPU scheduler for Linux](https://lwn.net/Articles/925371/) — Peter Zijlstra's explanation
- [kernel/sched/fair.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/fair.c) — `__pick_eevdf()` at line 1010
