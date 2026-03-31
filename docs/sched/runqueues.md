# Runqueues and Task Selection

> Per-CPU runqueues, struct rq, and how the scheduler picks the next task

## The per-CPU design

Every CPU has its own runqueue. There is no global queue of runnable tasks — each CPU independently manages its own set and picks from it. This design scales: CPUs never contend on a shared lock just to pick the next task.

```
CPU 0             CPU 1             CPU 2             CPU 3
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ struct rq│     │ struct rq│     │ struct rq│     │ struct rq│
│  cfs_rq  │     │  cfs_rq  │     │  cfs_rq  │     │  cfs_rq  │
│  rt_rq   │     │  rt_rq   │     │  rt_rq   │     │  rt_rq   │
│  dl_rq   │     │  dl_rq   │     │  dl_rq   │     │  dl_rq   │
│  curr ───┼─>T1 │  curr ───┼─>T4 │  curr ───┼─>T7 │  curr ───┼─>T9
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

Load balancing periodically migrates tasks between CPUs to keep them busy, but that's separate from the per-CPU selection path.

## struct rq

`struct rq` is the central per-CPU scheduler state, defined in `kernel/sched/sched.h`:

```c
// kernel/sched/sched.h
struct rq {
    /* Runqueue lock */
    raw_spinlock_t      __lock;

    /* Number of runnable tasks (all classes) */
    unsigned int        nr_running;

    /* Currently running task */
    struct task_struct __rcu *curr;

    /* Idle thread for this CPU */
    struct task_struct  *idle;

    /* Stop task (migration/hotplug) */
    struct task_struct  *stop;

    /* Runqueue clock (ns) */
    u64                 clock;
    u64                 clock_task;

    /* Per-class sub-queues */
    struct cfs_rq       cfs;   // fair_sched_class
    struct rt_rq        rt;    // rt_sched_class
    struct dl_rq        dl;    // dl_sched_class

    /* CPU this runqueue belongs to */
    int                 cpu;

    /* Load tracking */
    struct sched_avg    avg_rt;
    struct sched_avg    avg_dl;

    /* ... (many more fields for load balancing, energy, stats) */
};
```

### Key fields

| Field | Type | Purpose |
|-------|------|---------|
| `__lock` | `raw_spinlock_t` | Protects runqueue modifications |
| `nr_running` | `unsigned int` | Total runnable tasks across all classes |
| `curr` | `struct task_struct *` | Currently executing task |
| `idle` | `struct task_struct *` | The idle thread (swapper/N) |
| `clock` | `u64` | Monotonic nanosecond clock for this CPU |
| `cfs` | `struct cfs_rq` | CFS/EEVDF runqueue (fair tasks) |
| `rt` | `struct rt_rq` | RT runqueue (FIFO/RR tasks) |
| `dl` | `struct dl_rq` | Deadline runqueue (SCHED_DEADLINE tasks) |

## Accessing runqueues

The runqueues are declared as a per-CPU variable:

```c
// kernel/sched/sched.h
DECLARE_PER_CPU_SHARED_ALIGNED(struct rq, runqueues);
```

Access macros:

```c
// kernel/sched/sched.h
#define cpu_rq(cpu)    (&per_cpu(runqueues, (cpu)))
#define this_rq()      this_cpu_ptr(&runqueues)
#define task_rq(p)     cpu_rq(task_cpu(p))
```

Most scheduler code uses `this_rq()` — the runqueue for the currently executing CPU. Accessing another CPU's runqueue requires holding that CPU's `rq->__lock`.

## The three sub-queues

### struct cfs_rq (fair tasks)

```c
// kernel/sched/sched.h
struct cfs_rq {
    struct rb_root_cached tasks_timeline; // RB-tree keyed by vruntime/deadline
    struct sched_entity  *curr;           // running entity
    struct sched_entity  *next;           // next candidate (wakeup hint)
    unsigned int          nr_queued;      // runnable task count
    s64                   avg_vruntime;   // weighted vruntime sum (eligibility)
    long                  avg_load;       // total load weight of queued tasks
    // ...
};
```

The `tasks_timeline` RB-tree holds all runnable fair tasks, ordered by `vruntime`. The `rb_root_cached` variant caches the leftmost node for O(1) access, though since EEVDF the leftmost node is no longer always selected — but the cache remains useful as a starting point for the tree walk.

### struct rt_rq (RT tasks)

```c
// kernel/sched/sched.h
struct rt_rq {
    struct rt_prio_array active;    // 100-level priority bitmap + queues
    unsigned int         rt_nr_running;
    int                  rt_queued; // is this rq on the overload list?
    // throttling fields...
};

struct rt_prio_array {
    DECLARE_BITMAP(bitmap, MAX_RT_PRIO + 1); // 101 bits
    struct list_head queue[MAX_RT_PRIO];     // per-priority FIFO queues
};
```

RT task selection is O(1): `sched_find_first_bit(bitmap)` finds the highest-priority non-empty queue, then takes the head of that queue.

### struct dl_rq (deadline tasks)

```c
// kernel/sched/sched.h
struct dl_rq {
    struct rb_root_cached root;      // RB-tree ordered by deadline
    unsigned int          dl_nr_running;
    // CBS bandwidth tracking fields...
};
```

Deadline task selection picks the task with the earliest `dl_deadline` from the RB-tree — similar to EEVDF but for absolute (not virtual) deadlines.

## The scheduling decision

The core of the scheduler lives in `__schedule()` in `kernel/sched/core.c`:

```c
// kernel/sched/core.c (simplified)
static void __sched notrace __schedule(int sched_mode)
{
    struct task_struct *prev, *next;
    struct rq *rq;

    rq = this_rq();
    prev = rq->curr;

    // Update runqueue clock
    update_rq_clock(rq);

    // If prev is going to sleep, dequeue it
    if (!(sched_mode & SM_MASK_PREEMPT) && prev->__state) {
        // task is blocking
        deactivate_task(rq, prev, DEQUEUE_SLEEP | DEQUEUE_NOCLOCK);
    }

    // Pick the next task (walks sched_class hierarchy)
    next = pick_next_task(rq, prev, &rf);

    // If same task, no switch needed
    if (likely(prev != next)) {
        rq->nr_switches++;
        rq->curr = next;
        context_switch(rq, prev, next, &rf);
    }
}
```

### pick_next_task()

Walks the scheduler class hierarchy until a class has a task:

```c
// kernel/sched/core.c (simplified)
static struct task_struct *
pick_next_task(struct rq *rq, struct task_struct *prev, struct rq_flags *rf)
{
    const struct sched_class *class;
    struct task_struct *p;

    // Fast path: all tasks are fair class
    if (likely(!sched_class_above(prev->sched_class, &fair_sched_class) &&
               rq->nr_running == rq->cfs.h_nr_running)) {
        p = pick_next_task_fair(rq, prev, rf);
        if (unlikely(p == RETRY_TASK))
            goto restart;
        return p;
    }

restart:
    // General path: stop → deadline → rt → fair → idle
    for_each_class(class) {
        p = class->pick_next_task(rq, prev, rf);
        if (p)
            return p;
    }
    BUG(); /* idle_sched_class always returns idle thread */
}
```

The fast path skips the class walk entirely when all tasks are SCHED_NORMAL (the common case on most systems). This saves checking three higher-priority classes that almost never have tasks.

## context_switch()

Once `next` is selected, `context_switch()` switches execution:

```c
// kernel/sched/core.c
static __always_inline struct rq *
context_switch(struct rq *rq, struct task_struct *prev,
               struct task_struct *next, struct rq_flags *rf)
{
    prepare_task_switch(rq, prev, next);

    // Switch memory mapping if different process
    if (!next->mm) {
        // kernel thread: borrow prev's page tables
        next->active_mm = prev->active_mm;
        enter_lazy_tlb(prev->active_mm, next);
    } else {
        // user process: switch page tables
        switch_mm_irqs_off(prev->active_mm, next->mm, next);
    }

    // Switch CPU registers and stack
    switch_to(prev, next, prev);
    barrier();

    return finish_task_switch(prev);
}
```

`switch_to()` is architecture-specific. On x86-64 it saves/restores registers and switches the stack pointer. After `switch_to()`, execution continues in `next`'s context — `prev` is whatever task ran before `next` last yielded.

## Runqueue clock

`rq->clock` is a nanosecond-precision monotonic clock per CPU, updated at each scheduling event:

```c
// Update the clock (called at the start of __schedule)
update_rq_clock(rq);

// Tasks use rq_clock_task() which excludes time stolen by guests (VMs)
u64 now = rq_clock_task(rq);
```

CFS uses `rq_clock_task()` (not wall time) for vruntime updates, which means time spent in a VM guest doesn't count toward the host task's CPU consumption.

## Observing runqueue state

```bash
# Tasks currently running or runnable per CPU
cat /proc/schedstat | head -20

# Number of runnable tasks per CPU right now
for cpu in /sys/devices/system/cpu/cpu*/; do
  echo -n "$(basename $cpu): "
  cat "$cpu/cpufreq/stats/time_in_state" 2>/dev/null | head -1
done

# Real-time runqueue visualization
watch -n 0.5 'cat /proc/$(pgrep stress | head -1)/sched 2>/dev/null'

# Per-CPU task counts from schedstat
awk '/^cpu[0-9]/ {print $1, "running:", $2, "switches:", $8}' /proc/schedstat
```

## Further reading

- [Scheduler Classes](scheduler-classes.md) — The five classes that populate these queues
- [CFS](cfs.md) — `struct cfs_rq` and the fair class in depth
- [EEVDF](eevdf.md) — How `pick_next_entity()` works inside the fair class
- [Life of a Context Switch](context-switch.md) — The full path through `__schedule()`
