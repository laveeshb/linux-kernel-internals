# EEVDF Scheduler

> Earliest Eligible Virtual Deadline First: adding latency guarantees to fairness

## The problem with CFS

CFS selects the task with the smallest `vruntime`. This is fair but not deadline-aware.

Consider a task that just woke from I/O. Its vruntime may be behind the pack, so it runs quickly — but CFS has no concept of *urgency*. A task processing a network packet that needs a 1ms response has the same scheduling priority as a batch task that just happened to sleep briefly.

EEVDF fixes this by replacing CFS's "minimum vruntime" selection with **"earliest deadline among eligible tasks"**.

## Background

EEVDF is based on the 1995 paper ["Earliest Eligible Virtual Deadline First: A Flexible and Accurate Mechanism for Proportional Share Resource Allocation"](https://dl.acm.org/doi/10.1145/248052.248064) by Ion Stoica and Hussein Abdel-Wahab.

It was implemented for Linux by Peter Zijlstra (Intel) and merged in kernel 6.6 (October 2023).

**Commit**: [147f3efaa241](https://git.kernel.org/linus/147f3efaa241) ("sched/fair: Implement an EEVDF-like scheduling algorithm")

## Two concepts: eligibility and virtual deadline

### Eligibility

A task is **eligible** if it hasn't consumed more than its fair share of CPU up to the current virtual time. Informally: a task that has been running too much is ineligible and shouldn't preempt others.

```c
// kernel/sched/fair.c:797
static int vruntime_eligible(struct cfs_rq *cfs_rq, u64 vruntime)
{
    struct sched_entity *curr = cfs_rq->curr;
    s64 avg = cfs_rq->sum_w_vruntime;
    long load = cfs_rq->sum_weight;

    if (curr && curr->on_rq) {
        unsigned long weight = scale_load_down(curr->load.weight);
        avg += entity_key(cfs_rq, curr) * weight;
        load += weight;
    }

    return avg >= vruntime_op(vruntime, "-", cfs_rq->zero_vruntime) * load;
}
```

A task is eligible if the weighted sum of vruntimes (`sum_w_vruntime`) is at least as large as the task's adjusted vruntime scaled by the total weight — i.e., the task has not consumed more than its fair share.

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
    u64 vprot;          // protected deadline (minimum quantum guarantee)
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
__pick_eevdf(struct cfs_rq *cfs_rq, bool protect)
{
    struct rb_node *node = cfs_rq->tasks_timeline.rb_root.rb_node;
    struct sched_entity *se, *curr, *best = NULL;
    u64 avg_vruntime = avg_vruntime(cfs_rq);

    while (node) {
        se = __node_2_se(node);

        // Is this task eligible?
        if (entity_eligible(cfs_rq, se)) {
            // Is this the earliest deadline among eligible tasks?
            if (!best || deadline_gt(best->deadline, se->deadline))
                best = se;
        }

        // Prune the search using subtree min_vruntime
        // (not all subtrees need to be searched)
        if (node->rb_left &&
            __node_2_se(node->rb_left)->min_vruntime <= avg_vruntime)
            node = node->rb_left;
        else
            node = node->rb_right;
    }

    return best;
}

static struct sched_entity *pick_eevdf(struct cfs_rq *cfs_rq)
{
    return __pick_eevdf(cfs_rq, true);
}
```

The algorithm walks the RB-tree, finds all eligible tasks, and returns the one with the earliest (smallest) deadline. Non-eligible tasks are skipped. The tree traversal is pruned using cached `min_vruntime` subtree values for efficiency.

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

## Interaction with sched_latency_ns

The `slice` a task gets is derived from `sched_latency_ns` divided by the number of runnable tasks (with a minimum of `sched_min_granularity_ns`):

```bash
# Scheduling latency target (default: 6ms)
cat /proc/sys/kernel/sched_latency_ns

# Minimum per-task granularity (default: 750µs)
cat /proc/sys/kernel/sched_min_granularity_ns
```

With 4 runnable tasks and 6ms latency target: each task gets a 1.5ms slice. EEVDF's deadline for each task is 1.5ms of virtual time from its current vruntime.

Applications can request a specific latency hint via `sched_setattr()` with `SCHED_FLAG_UTIL_CLAMP` (though full custom slice control is still being developed).

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
