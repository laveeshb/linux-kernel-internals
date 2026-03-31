# Priority Inversion and PI Mutexes

> The classic real-time locking problem and Linux's solution

## The priority inversion problem

Priority inversion occurs when a high-priority task is blocked waiting for a resource held by a low-priority task, and a medium-priority task prevents the low-priority task from running. Result: the high-priority task waits behind the medium-priority task indefinitely — priority is effectively inverted.

```
Priority:  HIGH        MEDIUM      LOW
           ┌───┐       ┌───┐       ┌───┐
           │ H │       │ M │       │ L │
           └───┘       └───┘       └───┘

Timeline:
  t=0:  L starts, acquires mutex
  t=1:  H wakes, tries to acquire mutex → BLOCKED on L
  t=2:  M wakes (higher priority than L) → PREEMPTS L
  t=3:  M runs freely (doesn't need mutex)
        L can't run (preempted by M)
        H is stuck waiting for L to release mutex
        H < M effectively, even though H > M nominally!
```

This is not theoretical. The Mars Pathfinder mission (1997) experienced priority inversion that caused periodic system resets until engineers uploaded a fix to enable priority inheritance on the affected mutex.

## Priority inheritance: the solution

When task H blocks on a mutex held by L, the kernel temporarily boosts L's priority to H's level. This ensures L can preempt M and release the mutex quickly.

```
After PI boost:
  t=0:  L starts, acquires mutex
  t=1:  H blocks on mutex → L's priority BOOSTED to H's level
  t=2:  M wakes → cannot preempt L (L now has H's priority!)
  t=3:  L runs, finishes critical section, releases mutex
  t=4:  L's priority RESTORED to original
        H unblocks, runs (has highest priority)
        M runs after H
```

## rt_mutex: the PI-aware lock

Linux provides `rt_mutex` in `kernel/locking/rtmutex.c` for PI-capable locking:

```c
// include/linux/rtmutex.h
struct rt_mutex_base {
    raw_spinlock_t          wait_lock;  // protects waiters tree and owner
    struct rb_root_cached   waiters;    // priority-ordered tree of blocked tasks
    struct task_struct      *owner;     // current lock owner (LSB = has waiters)
};
```

Waiters are stored in a **priority-ordered RB-tree**, not a FIFO queue. The highest-priority waiter is at the root and determines the owner's boosted priority.

## Priority tracking in task_struct

```c
// include/linux/sched.h (CONFIG_RT_MUTEXES)
struct task_struct {
    // ...
    raw_spinlock_t          pi_lock;        // protects PI state changes
    struct rb_root_cached   pi_waiters;     // tasks boosting this task's priority
    struct task_struct      *pi_top_task;   // cached: highest-priority booster
    struct rt_mutex_waiter  *pi_blocked_on; // lock this task is blocked on
};
```

`pi_waiters` is an RB-tree of tasks waiting on locks held by this task. `pi_top_task` caches the highest-priority waiter for quick access.

## The boost mechanism

When task H tries to acquire a mutex held by L:

```c
// kernel/locking/rtmutex.c (simplified)
int rt_mutex_lock(struct rt_mutex *lock)
{
    // Try to acquire: CAS on lock->owner
    if (try_acquire(lock))
        return 0;

    // Lock contended: add H to lock->waiters
    // Boost L's priority to H's
    rt_mutex_adjust_prio_chain(H, lock, ...)
}
```

`rt_mutex_adjust_prio_chain()` walks the lock dependency chain:

```c
// kernel/locking/rtmutex.c
static int rt_mutex_adjust_prio_chain(struct task_struct *task,
                                       enum rtmutex_chainwalk chwalk,
                                       struct rt_mutex_base *orig_lock,
                                       struct rt_mutex_base *next_lock,
                                       struct rt_mutex_waiter *orig_waiter,
                                       struct task_struct *top_task)
{
    // Walk the lock chain: if L is also blocked on another lock,
    // propagate the boost transitively
    while (task) {
        // Boost task's priority
        rt_mutex_adjust_prio(task);

        // If task is blocked on another lock, continue up the chain
        if (task->pi_blocked_on)
            task = task->pi_blocked_on->lock->owner;
        else
            break;
    }
}
```

### Chained priority inheritance

PI must handle chains:

```
H waits on lock_1 held by M2
M2 waits on lock_2 held by L
→ L must be boosted to H's priority
→ M2 must also be boosted to H's priority (to run and release lock_2 first)
```

The chain walk handles this transitively. The kernel limits chain depth to prevent O(n) worst-case paths from DoS-ing the system.

## The boost application: rt_mutex_setprio()

```c
// kernel/sched/core.c
void rt_mutex_setprio(struct task_struct *p, struct task_struct *pi_task)
{
    // pi_task is the highest-priority waiter (or NULL to deboost)
    int prio = pi_task ? pi_task->prio : p->normal_prio;

    // Update p's priority
    p->pi_top_task = pi_task;
    __setscheduler_prio(p, prio);

    // If p is currently running, may need to reschedule
    if (p->on_rq)
        resched_curr(rq);
}
```

The boosted task runs with the PI task's priority — it gets scheduled exactly as if it were that high-priority task, until it releases the lock.

## Unboost on lock release

When L releases the mutex:

1. L is removed from H's `pi_waiters` (or H's priority is removed from L's boost)
2. `rt_mutex_setprio(L, new_pi_top)` is called — where `new_pi_top` is the next-highest waiter (or NULL if none)
3. L's priority reverts to `normal_prio`
4. H is woken and acquires the lock

```c
// kernel/locking/rtmutex.c
static void mark_wakeup_next_waiter(struct rt_wake_q_head *wqh,
                                     struct rt_mutex_base *lock)
{
    // Dequeue top waiter from owner's pi_waiters
    rt_mutex_dequeue_pi(current, waiter);

    // Deboost: restore owner's priority to next-highest waiter (or normal_prio)
    rt_mutex_adjust_prio(current);

    // Wake the top waiter (H)
    rt_wake_q_add(wqh, waiter->task);
}
```

## Userspace rt_mutex: PTHREAD_PRIO_INHERIT

The POSIX pthread mutex protocol `PTHREAD_PRIO_INHERIT` uses the kernel's `rt_mutex` infrastructure:

```c
pthread_mutexattr_t attr;
pthread_mutexattr_init(&attr);
pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT);
pthread_mutex_init(&my_mutex, &attr);
```

On Linux, `PTHREAD_PRIO_INHERIT` mutexes are backed by a futex with the `FUTEX_LOCK_PI` operation, which in turn uses `rt_mutex` internally.

```bash
# View futex PI operations
strace -e futex ./my_rt_app 2>&1 | grep FUTEX_LOCK_PI
```

## PI mutex vs regular mutex

| Property | pthread_mutex (default) | pthread_mutex (PRIO_INHERIT) |
|----------|------------------------|------------------------------|
| Lock owner boost | No | Yes |
| Overhead | Low | Slightly higher |
| Required for RT | No | Yes, if shared with non-RT tasks |
| Kernel backing | futex (FUTEX_LOCK) | futex (FUTEX_LOCK_PI / rt_mutex) |

For pure RT applications where all threads are the same priority, regular mutexes are fine. PI mutexes are needed when RT tasks share resources with non-RT tasks.

## SCHED_DEADLINE and PI

`SCHED_DEADLINE` tasks can also experience priority inversion. When a DL task blocks on an rt_mutex held by a normal or RT task, the owner is boosted to run with a virtual DL entity borrowed from the DL task:

```c
// kernel/sched/deadline.c
static inline bool is_dl_boosted(struct sched_dl_entity *dl_se)
{
    return pi_of(dl_se) != dl_se;  // pi_se points to donor if boosted
}
```

The boosted task temporarily runs under SCHED_DEADLINE semantics, ensuring it can preempt any RT task and release the lock before the DL task's deadline.

## The PREEMPT_RT extension

The full `PREEMPT_RT` patchset converts most kernel spinlocks to rt_mutexes, extending PI to nearly all kernel locking. This allows full preemption of kernel code and eliminates most sources of unbounded latency — at the cost of more complex locking and slightly higher overhead.

As of kernel 6.x, large parts of PREEMPT_RT are upstream. `CONFIG_PREEMPT_RT` can be selected on supported architectures.

## Observing PI

```bash
# See tasks blocked on rt_mutex (shown in wchan)
cat /proc/$PID/wchan   # shows "rt_mutex_wait" if blocked on PI mutex

# Trace PI boost events
trace-cmd record -e rtmutex:rtmutex_acquire \
                 -e rtmutex:rtmutex_release \
                 ./workload

# perf: count PI lock acquisitions
perf stat -e rtmutex:rtmutex_acquire -a sleep 10
```

## Further reading

- [RT Scheduler](rt-scheduler.md) — SCHED_FIFO/RR and why PI matters for RT tasks
- [SCHED_DEADLINE](deadline.md) — How DL interacts with PI locking
- [kernel/locking/rtmutex.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/locking/rtmutex.c) — Full PI implementation
- [LWN: Priority inheritance in the kernel](https://lwn.net/Articles/178253/) (2006) — Thomas Gleixner and Ingo Molnar's original submission
