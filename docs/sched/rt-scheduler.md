# RT Scheduler: SCHED_FIFO and SCHED_RR

> Hard real-time scheduling with priority-based preemption

## What the RT scheduler provides

The RT scheduler (`rt_sched_class`) gives tasks strict priority guarantees: an RT task at priority N will always preempt any fair-class task and any RT task at priority < N. There is no fairness, no vruntime, no time-sharing between tasks of different priorities — the highest-priority runnable task runs, period.

Two policies share the RT class:

| Policy | Timeslice | Preemption |
|--------|-----------|------------|
| `SCHED_FIFO` | None — runs until it blocks or yields | By higher-priority task only |
| `SCHED_RR` | 100ms (default) | By higher-priority task, or same-priority task when slice expires |

RT priorities range from 1 (lowest) to 99 (highest). This is the reverse of nice values: higher number = higher priority.

## The RT runqueue

```c
// kernel/sched/sched.h
struct rt_prio_array {
    DECLARE_BITMAP(bitmap, MAX_RT_PRIO + 1); // 101-bit bitmap (+1 for delimiter)
    struct list_head queue[MAX_RT_PRIO];     // 100 per-priority FIFO queues
};

struct rt_rq {
    struct rt_prio_array active;    // ready-to-run tasks by priority
    unsigned int         rt_nr_running;  // total runnable RT tasks
    int                  rt_queued;      // is this rq on the overload list?
    // (throttling fields when CONFIG_RT_GROUP_SCHED)
};
```

`MAX_RT_PRIO = 100` (defined in `include/linux/sched/prio.h`). The bitmap has one bit per priority level — when a task at priority P becomes runnable, bit P is set. Task selection is:

```c
int idx = sched_find_first_bit(rt_rq->active.bitmap);
// idx is the highest-priority non-empty queue
next = list_first_entry(&rt_rq->active.queue[idx], ...);
```

This is O(1) regardless of how many RT tasks exist — the bitmap scan is a single hardware instruction (`bsf`/`bsr` on x86).

## struct sched_rt_entity

Every RT task has a `sched_rt_entity` embedded in its `task_struct`:

```c
// include/linux/sched.h
struct sched_rt_entity {
    struct list_head    run_list;       // node in priority queue
    unsigned long       timeout;        // RLIMIT_RTTIME watchdog
    unsigned long       watchdog_stamp; // jiffies at last check
    unsigned int        time_slice;     // remaining RR timeslice
    unsigned short      on_rq;          // currently queued?
    unsigned short      on_list;        // on active priority list?
    // (group scheduling fields when CONFIG_RT_GROUP_SCHED)
};
```

## Task selection: pick_next_task_rt()

```c
// kernel/sched/rt.c
static struct task_struct *pick_task_rt(struct rq *rq, struct rq_flags *rf)
{
    struct sched_rt_entity *rt_se = pick_next_rt_entity(rq->rt.active);
    if (!rt_se)
        return NULL;
    return rt_task_of(rt_se);
}
```

`pick_next_rt_entity()` finds the first-set bit in the priority bitmap, then returns the head of that queue. For SCHED_RR tasks at equal priority, the queue is FIFO — the task at the front ran most recently and goes to the back after its slice.

## SCHED_RR timeslice rotation

On each timer tick, `task_tick_rt()` runs:

```c
// kernel/sched/rt.c
static void task_tick_rt(struct rq *rq, struct task_struct *p, int queued)
{
    struct sched_rt_entity *rt_se = &p->rt;

    // Watchdog: kill task if it exceeds RLIMIT_RTTIME
    watchdog(rq, p);

    // Only SCHED_RR uses timeslices
    if (p->policy != SCHED_RR)
        return;

    if (--rt_se->time_slice)
        return;   // still has time left

    // Timeslice expired: reset and requeue at back
    rt_se->time_slice = sched_rr_timeslice;

    if (rt_se->run_list.prev != rt_se->run_list.next) {
        // Other tasks at same priority: move to back of queue
        requeue_task_rt(rq, p, 0);
        resched_curr(rq);
    }
}
```

The default SCHED_RR timeslice is 100ms:
```c
// include/linux/sched/rt.h
#define RR_TIMESLICE    (100 * HZ / 1000)

// Configurable via sysctl:
// /proc/sys/kernel/sched_rr_timeslice_ms (default: 100)
int sched_rr_timeslice = RR_TIMESLICE;
```

## RT throttling

An RT task that never sleeps will starve all normal tasks. The kernel protects against this with **RT throttling**:

```c
// kernel/sched/rt.c
int sysctl_sched_rt_period  = 1000000;  // 1 second (µs)
int sysctl_sched_rt_runtime =  950000;  // 950ms (µs)
```

RT tasks collectively can use at most `rt_runtime / rt_period` = 95% of CPU time. The remaining 5% is reserved for SCHED_NORMAL tasks (including the shell, so you can `kill -9` a runaway RT task).

```bash
# View/change RT throttle settings
cat /proc/sys/kernel/sched_rt_period_us    # default: 1000000 (1s)
cat /proc/sys/kernel/sched_rt_runtime_us   # default: 950000 (950ms)

# Disable throttling (dangerous — can freeze the system)
echo -1 > /proc/sys/kernel/sched_rt_runtime_us
```

Setting `sched_rt_runtime_us` to -1 disables throttling entirely. Only do this if you fully trust your RT tasks.

## Setting RT policy

```c
// Set SCHED_FIFO at priority 50
struct sched_param param = { .sched_priority = 50 };
sched_setscheduler(pid, SCHED_FIFO, &param);

// Or via sched_setattr (more flexible)
struct sched_attr attr = {
    .sched_policy   = SCHED_FIFO,
    .sched_priority = 50,
};
sched_setattr(0, &attr, 0);
```

Requires `CAP_SYS_NICE` (or running as root). Unprivileged users cannot set RT policies.

```bash
# Set process to SCHED_FIFO priority 80
chrt -f 80 ./my_realtime_app

# Set existing process
chrt -f -p 80 $PID

# Check scheduling policy
chrt -p $PID
```

## SMP considerations: pushable tasks

On multi-CPU systems, the RT scheduler maintains a **pushable tasks** list — RT tasks that could be migrated to another CPU if their current CPU is occupied by a higher-priority RT task.

When a higher-priority RT task arrives on a CPU that's already running an RT task, the lower-priority task is "pushed" to another CPU:

```
Before:                          After:
CPU 0: RT-90 (running)          CPU 0: RT-90 (running)
CPU 1: RT-70 (running)          CPU 1: RT-80 (running, migrated here)
                                CPU 1: RT-70 → pushed to CPU 2
CPU 2: normal task              CPU 2: RT-70 (migrated)
```

The `push_rt_task()` and `pull_rt_task()` functions handle this migration.

## Practical patterns

### Audio/video processing

```c
// Realtime audio thread: SCHED_FIFO, priority ~70
// High enough to preempt all normal tasks,
// low enough for SCHED_DEADLINE tasks to preempt if needed
struct sched_param param = { .sched_priority = 70 };
sched_setscheduler(0, SCHED_FIFO, &param);

// Process audio in tight loop, sleep on condition variable
while (running) {
    pthread_mutex_lock(&buf_lock);
    while (buf_empty)
        pthread_cond_wait(&buf_cond, &buf_lock);
    process_audio();
    pthread_mutex_unlock(&buf_lock);
}
```

### Avoiding PI issues

When using mutexes in RT tasks, use `pthread_mutexattr_setprotocol(PTHREAD_PRIO_INHERIT)` to enable priority inheritance:

```c
pthread_mutexattr_t attr;
pthread_mutexattr_init(&attr);
pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT);
pthread_mutex_init(&mutex, &attr);
```

Without PI, a low-priority task holding a mutex can block a high-priority RT task indefinitely — the classic priority inversion problem. See [Priority Inversion and PI Mutexes](pi-mutexes.md).

## Further reading

- [SCHED_DEADLINE](deadline.md) — Even stricter guarantees with bandwidth enforcement
- [Priority Inversion and PI Mutexes](pi-mutexes.md) — The RT locking problem and solution
- [Scheduler Classes](scheduler-classes.md) — RT class in the class hierarchy
