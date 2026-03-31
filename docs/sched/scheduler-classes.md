# Scheduler Classes

> How Linux layers five scheduling policies into a single framework

## The layered model

Linux doesn't have one scheduler — it has five, each handling a different class of tasks. They're stacked by priority: when the kernel picks the next task to run, it asks each class in turn, from highest to lowest, until one has a task ready.

```
┌─────────────────────────────────────────┐
│  stop     (migration, hotplug)          │  ← highest priority
├─────────────────────────────────────────┤
│  deadline (SCHED_DEADLINE)              │
├─────────────────────────────────────────┤
│  rt       (SCHED_FIFO, SCHED_RR)        │
├─────────────────────────────────────────┤
│  fair     (SCHED_NORMAL, SCHED_BATCH,   │
│            SCHED_IDLE)                  │
├─────────────────────────────────────────┤
│  idle     (swapper/idle thread)         │  ← lowest priority
└─────────────────────────────────────────┘
```

A CPU running a deadline task will never run a fair task until the deadline task blocks or its budget is exhausted. This gives real-time and deadline tasks strict priority without any special casing in the core scheduler.

## struct sched_class

Each scheduler class implements a common interface defined in `kernel/sched/sched.h`:

```c
// kernel/sched/sched.h
struct sched_class {
    void (*enqueue_task)(struct rq *rq, struct task_struct *p, int flags);
    bool (*dequeue_task)(struct rq *rq, struct task_struct *p, int flags);

    struct task_struct *(*pick_task)(struct rq *rq, struct rq_flags *rf);
    struct task_struct *(*pick_next_task)(struct rq *rq,
                                          struct task_struct *prev,
                                          struct rq_flags *rf);
    void (*put_prev_task)(struct rq *rq, struct task_struct *p,
                          struct task_struct *next);
    void (*set_next_task)(struct rq *rq, struct task_struct *p, bool first);

    void (*task_tick)(struct rq *rq, struct task_struct *p, int queued);
    void (*prio_changed)(struct rq *this_rq, struct task_struct *task,
                         int oldprio);
    void (*update_curr)(struct rq *rq);
    // ... (more hooks)
};
```

Key callbacks:

| Callback | When it's called |
|----------|-----------------|
| `enqueue_task` | Task becomes runnable (wakeup, new task) |
| `dequeue_task` | Task blocks or exits |
| `pick_next_task` | Scheduler needs the next task to run |
| `put_prev_task` | Currently running task is being preempted |
| `task_tick` | Timer interrupt — check if task should be preempted |
| `prio_changed` | Task's priority changed (e.g., `nice()`) |
| `update_curr` | Update the current task's accounting |

## Class registration

Each class is registered using the `DEFINE_SCHED_CLASS` macro, which places the struct in a special linker section with a defined ordering:

```c
// kernel/sched/sched.h
#define DEFINE_SCHED_CLASS(name) \
const struct sched_class name##_sched_class \
    __aligned(__alignof__(struct sched_class)) \
    __section("__sched_classes")
```

Classes are ordered in the section from highest to lowest priority. The `for_each_class()` macro walks them:

```c
// kernel/sched/sched.h
#define for_each_class(class) \
    for (class = __sched_class_highest; \
         class <= __sched_class_lowest; \
         class++)
```

## The five classes

### 1. stop (`stop_sched_class`)

**File**: `kernel/sched/stop_task.c`

The stop class has the highest priority of all. It's used for per-CPU "stopper" threads that implement CPU migration and hotplug operations.

A stopper thread can preempt anything — even a SCHED_FIFO task at priority 99. You never interact with this class directly; it's entirely internal to the kernel.

```c
// kernel/sched/stop_task.c
DEFINE_SCHED_CLASS(stop) = {
    .enqueue_task   = enqueue_task_stop,
    .dequeue_task   = dequeue_task_stop,
    .pick_next_task = pick_next_task_stop,
    // ...
};
```

### 2. deadline (`dl_sched_class`)

**File**: `kernel/sched/deadline.c`

`SCHED_DEADLINE` implements Constant Bandwidth Server (CBS) scheduling. Each task declares its worst-case execution time (`runtime`) and period. The kernel runs it within that budget and uses an EDF (Earliest Deadline First) red-black tree to select which deadline task runs next.

```c
// Set a task to SCHED_DEADLINE
struct sched_attr attr = {
    .sched_policy   = SCHED_DEADLINE,
    .sched_runtime  = 5000000,   // 5ms execution per period
    .sched_deadline = 10000000,  // must finish within 10ms
    .sched_period   = 10000000,  // period is 10ms
};
sched_setattr(0, &attr, 0);
```

The kernel enforces admission control: it rejects `SCHED_DEADLINE` tasks if accepting them would make the system infeasible (total utilization would exceed 1.0 per CPU).

### 3. rt (`rt_sched_class`)

**File**: `kernel/sched/rt.c`

Two policies share the RT class:

- **`SCHED_FIFO`**: Run until it blocks or a higher-priority task wakes up. No timeslice.
- **`SCHED_RR`**: Same as FIFO, but tasks at the same priority get a fixed timeslice (default 100ms), after which they go to the back of their priority queue.

RT tasks have priorities 1–99. The RT runqueue uses a bitmap of 100 priority levels — the same O(1) bitmap idea from the old scheduler, which is still appropriate here because RT workloads are typically small and bounded.

```c
// Set a task to SCHED_FIFO at priority 50
struct sched_param param = { .sched_priority = 50 };
sched_setscheduler(pid, SCHED_FIFO, &param);
```

**Danger**: An RT task that never sleeps will starve all normal tasks. The kernel protects against this with `rt_throttle`: by default, RT tasks can use at most 95% of CPU time per 1-second window (`/proc/sys/kernel/sched_rt_runtime_us` and `sched_rt_period_us`).

### 4. fair (`fair_sched_class`)

**File**: `kernel/sched/fair.c`

The fair class handles three policies:

| Policy | Use case |
|--------|----------|
| `SCHED_NORMAL` | Default for all user processes |
| `SCHED_BATCH` | CPU-bound batch jobs — fewer preemptions, no interactivity boost |
| `SCHED_IDLE` | Background tasks, lower priority than any `SCHED_NORMAL` task |

This is where CFS and EEVDF live. See [CFS](cfs.md) and [EEVDF](eevdf.md) for details.

### 5. idle (`idle_sched_class`)

**File**: `kernel/sched/idle.c`

The idle class runs the per-CPU idle thread (`swapper/N`). It's selected only when no other class has a runnable task.

The idle thread calls `cpu_idle_loop()`, which invokes the CPU's idle instruction (`hlt` on x86, `wfi` on ARM). It also handles:
- CPU frequency scaling callbacks
- RCU quiescent state reporting
- Polling for new work before sleeping

```c
// kernel/sched/idle.c
DEFINE_SCHED_CLASS(idle) = {
    .enqueue_task   = enqueue_task_idle,
    .dequeue_task   = dequeue_task_idle,
    .pick_next_task = pick_next_task_idle,
    // ...
};
```

## Task policy and class mapping

A task's scheduling policy is stored in `task_struct->policy`. The class pointer is cached in `task_struct->sched_class`:

```c
// include/uapi/linux/sched.h — policy values
#define SCHED_NORMAL    0
#define SCHED_FIFO      1
#define SCHED_RR        2
#define SCHED_BATCH     3
#define SCHED_IDLE      5
#define SCHED_DEADLINE  6
```

Setting a task's policy via `sched_setscheduler()` or `sched_setattr()` also updates `task_struct->sched_class` to point to the corresponding class struct.

## How pick_next_task works

The core scheduling function walks the class hierarchy:

```c
// kernel/sched/core.c (simplified)
static struct task_struct *
pick_next_task(struct rq *rq, struct task_struct *prev, struct rq_flags *rf)
{
    const struct sched_class *class;

    // Optimized fast path: if all tasks are fair class, skip the loop
    if (likely(!sched_class_above(prev->sched_class, &fair_sched_class) &&
               rq->nr_running == rq->cfs.h_nr_running))
        return pick_next_task_fair(rq, prev, rf);

    // General path: walk from highest to lowest priority class
    for_each_class(class) {
        p = class->pick_next_task(rq, prev, rf);
        if (p)
            return p;
    }
    BUG(); // idle class always returns something
}
```

The fast path is significant: on systems running only normal tasks (the common case), the kernel skips straight to `fair_sched_class` without checking stop, deadline, and rt first.

## Priority ranges

```
Policy          Priority range   Nice range   Who can set
──────────────────────────────────────────────────────────
SCHED_DEADLINE  n/a              n/a          CAP_SYS_NICE
SCHED_FIFO      1–99             n/a          CAP_SYS_NICE
SCHED_RR        1–99             n/a          CAP_SYS_NICE
SCHED_NORMAL    0                -20 to +19   any user (raise only)
SCHED_BATCH     0                -20 to +19   any user
SCHED_IDLE      0                n/a          CAP_SYS_NICE
```

## Further reading

- [Scheduler Evolution](scheduler-evolution.md) — Why we have this design
- [CFS](cfs.md) — The fair class in depth
- [RT Scheduler](rt-scheduler.md) — RT class details
- [SCHED_DEADLINE](deadline.md) — CBS and admission control
