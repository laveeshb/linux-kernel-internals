# SCHED_DEADLINE

> Bandwidth-based real-time scheduling with admission control

## What SCHED_DEADLINE provides

`SCHED_DEADLINE` is the highest-priority regular scheduling policy in Linux (above SCHED_FIFO/RR). Instead of a fixed priority, each task describes its computational requirements:

- **Runtime** (`sched_runtime`): How much CPU time it needs per period
- **Deadline** (`sched_deadline`): By when it must finish
- **Period** (`sched_period`): How often it repeats (defaults to deadline if unset)

The kernel enforces these bounds using **Constant Bandwidth Server (CBS)**: each task gets exactly its declared bandwidth and no more. When a task exhausts its runtime budget, it is throttled until the next period.

```
Task declares: 5ms runtime, 10ms deadline, 10ms period
= 50% CPU utilization

Timeline:
|----5ms---|---throttled---|----5ms---|---throttled---|
0         5              10         15              20ms
          ↑ budget exhausted          ↑ replenished
          deadline must be met ←------↑
```

## Why SCHED_DEADLINE over SCHED_FIFO?

| Property | SCHED_FIFO | SCHED_DEADLINE |
|----------|------------|----------------|
| Guarantee type | Priority (relative) | Bandwidth (absolute) |
| Admission control | None | Yes — kernel rejects infeasible tasks |
| Worst-case latency | Unbounded for same-priority tasks | Bounded by deadline |
| Overrun behavior | Starvation | Throttled, replenished at next period |
| Use case | Simple RT tasks | Periodic tasks with timing requirements |

SCHED_DEADLINE is suitable for tasks with provable timing requirements: video encoding frames, network packet processing at a rate guarantee, industrial control loops.

## Data structures

### struct sched_dl_entity

Embedded in `task_struct`, tracks per-task deadline state:

```c
// include/linux/sched.h
struct sched_dl_entity {
    struct rb_node  rb_node;        // position in dl_rq RB-tree
    struct hrtimer  dl_timer;       // CBS replenishment timer

    u64 dl_runtime;     // declared runtime (r_i)
    u64 dl_deadline;    // declared relative deadline (d_i)
    u64 dl_period;      // declared period (p_i); 0 means = dl_deadline
    u64 dl_bw;          // bandwidth = dl_runtime / dl_period
    u64 dl_density;     // density = dl_runtime / dl_deadline

    s64 runtime;        // remaining runtime for current instance
    u64 deadline;       // absolute deadline for current instance

    unsigned int dl_throttled : 1;  // budget exhausted this period
    // ...
    struct hrtimer  inactive_timer; // GRUB inactive time tracking
};
```

### struct dl_rq

Per-CPU deadline runqueue:

```c
// kernel/sched/sched.h
struct dl_rq {
    struct rb_root_cached root;              // RB-tree ordered by absolute deadline
    unsigned int          dl_nr_running;     // runnable DL task count
    struct {
        u64 curr, next;
    } earliest_dl;                           // cached earliest deadlines

    u64 running_bw;   // bandwidth of currently running tasks
    u64 this_bw;      // total assigned bandwidth (running + blocked)
    u64 extra_bw;     // reclaimed idle bandwidth (GRUB)
    u64 max_bw;       // maximum reclaimable bandwidth
    u64 bw_ratio;     // 1/Umax for GRUB calculations
};
```

## Admission control

Before a task can become `SCHED_DEADLINE`, the kernel checks whether the system can accommodate it:

```c
// kernel/sched/deadline.c
static int sched_dl_overflow(struct task_struct *p, int policy,
                              const struct sched_attr *attr)
{
    // Check: sum of all DL bandwidths + new task <= 1.0 (per CPU)
    // If over capacity: return -EBUSY
}
```

The check is global across all CPUs in the scheduling domain. If accepting the new task would make the total utilization exceed 100%, `sched_setattr()` returns `-EBUSY`:

```c
struct sched_attr attr = {
    .size           = sizeof(attr),
    .sched_policy   = SCHED_DEADLINE,
    .sched_runtime  = 5000000,   // 5ms
    .sched_deadline = 10000000,  // 10ms
    .sched_period   = 10000000,  // 10ms
};
if (sched_setattr(0, &attr, 0) < 0) {
    if (errno == EBUSY)
        // System cannot admit this task — too much DL bandwidth in use
}
```

This is unlike SCHED_FIFO/RR where any number of tasks can be created regardless of system capacity.

## CBS: budget enforcement and replenishment

### Budget exhaustion

Each time the task runs, its remaining `runtime` decreases. When it hits zero:

1. Task is marked `dl_throttled = 1`
2. Task is dequeued from the dl_rq
3. An hrtimer (`dl_timer`) is armed for the next replenishment time
4. The task can no longer run until replenished

### Replenishment via dl_task_timer()

```c
// kernel/sched/deadline.c
static enum hrtimer_restart dl_task_timer(struct hrtimer *timer)
{
    struct sched_dl_entity *dl_se = container_of(timer, ...);
    struct task_struct *p = dl_task_of(dl_se);

    // Replenish budget for next period
    replenish_dl_entity(dl_se);

    // Re-enqueue the task
    enqueue_task(rq, p, ENQUEUE_REPLENISH);

    // Check preemption
    wakeup_preempt(rq, p, 0);
}
```

`replenish_dl_entity()` sets:
- `dl_se->runtime = dl_se->dl_runtime` (full budget restored)
- `dl_se->deadline += dl_se->dl_period` (absolute deadline advanced)

### EDF selection

Among multiple runnable DL tasks, the scheduler always picks the one with the **earliest absolute deadline** (EDF — Earliest Deadline First):

```c
// kernel/sched/deadline.c
static struct sched_dl_entity *pick_next_dl_entity(struct dl_rq *dl_rq)
{
    struct rb_node *left = rb_first_cached(&dl_rq->root);
    return rb_entry(left, struct sched_dl_entity, rb_node);
}
```

The RB-tree is ordered by `deadline`, so the leftmost node always has the earliest deadline.

## GRUB: reclaiming unused bandwidth

A DL task that doesn't use its full budget would waste CPU time — other tasks couldn't use the reserved bandwidth. **GRUB (Greedy Reclamation of Unused Bandwidth)** solves this:

When a DL task is inactive (sleeping), its unused bandwidth is tracked and made available to other tasks via `extra_bw`. This allows the system to run more work than the strict bandwidth reservation would suggest, while still meeting all deadlines when tasks are active.

```bash
# Check total DL bandwidth per CPU
cat /proc/sched_debug | grep -A 5 "dl_rq"
```

## Using SCHED_DEADLINE

### Setting the policy

```c
#include <linux/sched/types.h>

struct sched_attr attr = {
    .size           = sizeof(struct sched_attr),
    .sched_policy   = SCHED_DEADLINE,
    .sched_flags    = 0,
    .sched_runtime  =  5000000,  // 5ms in nanoseconds
    .sched_deadline = 10000000,  // 10ms
    .sched_period   = 10000000,  // 10ms (= 50% utilization)
};

if (sched_setattr(0, &attr, 0) < 0)
    perror("sched_setattr");
```

Requires `CAP_SYS_NICE`.

### sched_yield() for SCHED_DEADLINE

A DL task should call `sched_yield()` when it finishes its work early. This tells the CBS that the task is done for this period and the remaining budget can be reclaimed:

```c
while (1) {
    do_periodic_work();  // finishes before dl_runtime
    sched_yield();       // release remaining budget, sleep until next period
}
```

Without `sched_yield()`, the task runs until its budget is exhausted, wasting CPU cycles.

### Constraints

- Cannot `fork()` with `SCHED_DEADLINE` — returns `-EAGAIN`
- Cannot use `pthread_create()` in a DL task (same reason)
- DL tasks cannot be part of a cgroup with CPU limits

```bash
# Check current DL tasks
chrt -p $PID  # shows SCHED_DEADLINE and parameters

# View system DL bandwidth usage
cat /proc/sched_debug | grep running_bw
```

## Interaction with RT tasks

`dl_sched_class` sits above `rt_sched_class` in the class hierarchy. A SCHED_DEADLINE task always preempts SCHED_FIFO/RR tasks, regardless of RT priority.

If an RT task holds a mutex that a DL task needs, priority inheritance boosts the RT task's priority. SCHED_DEADLINE also has boosting support via `is_dl_boosted()` — when a DL task is boosted, its effective deadline is derived from the donor task.

## Further reading

- [RT Scheduler](rt-scheduler.md) — SCHED_FIFO/RR, the class below DL
- [Priority Inversion and PI Mutexes](pi-mutexes.md) — How DL interacts with locking
- [Scheduler Classes](scheduler-classes.md) — Where DL fits in the hierarchy
- [kernel/sched/deadline.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/deadline.c) — Full CBS implementation
