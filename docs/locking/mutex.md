# Mutex and rt_mutex

> Sleeping locks for process context — the right tool when your critical section can block

## What is a mutex?

A mutex (mutual exclusion lock) is a sleeping lock. When a thread can't acquire a mutex, it goes to sleep and is woken up when the lock becomes available. This is unlike a spinlock, which busy-waits.

Because acquiring a mutex may sleep, mutexes can only be used in **process context** — never in interrupt handlers, softirqs, or tasklets.

## The mutex structure

```c
/* include/linux/mutex_types.h */
struct mutex {
    atomic_long_t   owner;      /* task_struct* of owner + flags in low bits */
    raw_spinlock_t  wait_lock;  /* protects wait_list */
    struct osq_lock osq;        /* optimistic spinning queue (MCS) */
    struct list_head wait_list; /* list of waiting tasks */
};
```

The `owner` field packs the owner pointer and status flags into a single atomic:

```c
/* kernel/locking/mutex.h */
#define MUTEX_FLAG_WAITERS  0x01  /* there are waiters on wait_list */
#define MUTEX_FLAG_HANDOFF  0x02  /* lock being handed off to first waiter */
#define MUTEX_FLAG_PICKUP   0x04  /* lock being picked up by first waiter */
#define MUTEX_FLAGS         0x07
```

The task pointer is stored in `owner & ~MUTEX_FLAGS` (safe because `task_struct` is aligned to at least 8 bytes, so the low 3 bits are always zero).

## Basic API

```c
#include <linux/mutex.h>

/* Static initialization */
DEFINE_MUTEX(my_mutex);

/* Dynamic initialization */
struct mutex my_mutex;
mutex_init(&my_mutex);

/* Lock (may sleep) */
mutex_lock(&my_mutex);
/* critical section */
mutex_unlock(&my_mutex);

/* Interruptible lock (returns -EINTR if signal arrives) */
if (mutex_lock_interruptible(&my_mutex))
    return -ERESTARTSYS;
/* critical section */
mutex_unlock(&my_mutex);

/* Killable lock (only interrupted by fatal signals) */
if (mutex_lock_killable(&my_mutex))
    return -EINTR;

/* Non-blocking trylock (returns 1 on success, 0 if locked) */
if (mutex_trylock(&my_mutex)) {
    /* got it */
    mutex_unlock(&my_mutex);
}

/* Check if locked (advisory, not synchronization) */
mutex_is_locked(&my_mutex);
```

## Three acquisition strategies

When `mutex_lock()` is called and the lock is held, the kernel tries three strategies in order:

```
1. Fastpath (no contention)
   ─────────────────────────
   atomic_long_try_cmpxchg(owner, 0, current)
   → succeeds immediately, no waiting

2. Midpath (owner is running on another CPU)
   ──────────────────────────────────────────
   Optimistic spinning via OSQ (MCS queue)
   → spins briefly, hoping owner finishes quickly
   → avoids the overhead of sleep/wake
   → bails out if owner is preempted

3. Slowpath (must sleep)
   ──────────────────────
   Add self to wait_list, set TASK_UNINTERRUPTIBLE, schedule()
   → woken by mutex_unlock() when lock is released
```

This three-phase approach avoids sleeping when the lock will be released quickly (the common case on loaded multiprocessor systems).

## Strict semantics

Mutexes enforce strict ownership rules that spinlocks do not:

- **Only the owner can unlock**: calling `mutex_unlock()` from a different task is a bug
- **No recursive locking**: a task that holds a mutex must not call `mutex_lock()` again on the same mutex — it will deadlock
- **No exit with lock held**: if a task exits while holding a mutex, the system detects this (with `CONFIG_DEBUG_MUTEXES`)
- **No use in interrupt context**: the kernel will warn if you try

```c
/* DON'T: unlock from a different task */
void thread_a(void) { mutex_lock(&m); /* hands off to thread_b */ }
void thread_b(void) { mutex_unlock(&m); /* BUG: not the owner */ }

/* DON'T: recursive locking */
mutex_lock(&m);
mutex_lock(&m);  /* DEADLOCK */
```

## rt_mutex: priority-inheritance mutex

On PREEMPT_RT kernels, `spinlock_t` is implemented via `struct rt_mutex` so that high-priority RT tasks can preempt the lock holder. `struct rt_mutex` is also available directly for cases where priority inheritance is explicitly needed.

```c
/* include/linux/rtmutex.h */
struct rt_mutex_base {
    raw_spinlock_t  wait_lock;
    struct rb_root_cached waiters;  /* waiters sorted by priority */
    struct task_struct *owner;
};
```

The key difference: with an rt_mutex, if a high-priority task is waiting on the lock, the lock holder **inherits** that high priority until it releases the lock. This prevents **priority inversion** (a low-priority task blocking a high-priority one indefinitely).

```
Without PI:
  RT task (prio=90)    waits on lock held by...
  Normal task (prio=20)   ... but gets preempted by...
  Medium task (prio=50)   ... which runs for a long time → RT task starves

With rt_mutex:
  RT task (prio=90)    waits on lock held by...
  Normal task (prio=20)   ... is boosted to prio=90, runs immediately
  → RT task gets the lock quickly
```

See [Priority Inversion & PI Mutexes](../sched/pi-mutexes.md) for the full story.

## Choosing between mutex and spinlock

```
Use mutex when:
  ✓ Critical section may block (e.g., kmalloc(GFP_KERNEL), copy_from_user)
  ✓ Critical section is long (milliseconds)
  ✓ You're in process context

Use spinlock when:
  ✓ Critical section never blocks
  ✓ Critical section is very short (microseconds)
  ✓ You're in interrupt context
  ✓ You need IRQ protection (spin_lock_irqsave)
```

## Design history

### Semaphores (pre-2.6.16)

Before `struct mutex` existed, the standard sleeping lock in the kernel was `struct semaphore`. A semaphore has a count — `down()` decrements it and sleeps if the count reaches zero; `up()` increments it and wakes a waiter.

The problem with using a counting semaphore as a mutex: because `up()` can be called by *any* task (not just the one that called `down()`), the kernel couldn't enforce ownership. This ruled out:
- Detecting recursive locking (which could deadlock)
- Priority inheritance (who holds the lock? unknown)
- Debugging tools that check "is the lock held when the task exits?"
- Static analysis of lock ordering

Ingo Molnár introduced `struct mutex` in Linux 2.6.16 (2006) with explicit single-owner semantics — [`6053ee3b32e3`](https://git.kernel.org/linus/6053ee3b32e3437e8c1e72687850f436e779bd49), announced at [LWN](https://lwn.net/Articles/164802/). Mutexes are semantically stricter than semaphores, which enables all the above. Kernel code was gradually migrated from `struct semaphore` to `struct mutex` over the following years. New code should always use `struct mutex` unless a counting semaphore is genuinely needed.

### The Big Kernel Lock (BKL)

The BKL (`lock_kernel()` / `unlock_kernel()`) was a single global recursive spinlock introduced in Linux 2.0 to make the kernel SMP-safe quickly. The approach: wrap large subsystems in one coarse lock rather than converting every data structure to fine-grained locking.

The BKL had unusual properties: it was released automatically on `schedule()` (so the holder could sleep without deadlocking other holders) and it was recursive. These properties made it easy to adopt but hard to remove, because removing it required proving that the protected code was safe without it.

Subsystem by subsystem, developers replaced BKL sections with proper per-subsystem mutexes and spinlocks. The process took over a decade:
- VFS: converted ~2004–2007 (big_kernel_lock → i_mutex, etc.)
- TTY layer: converted ~2009
- Remaining network drivers, sound: converted ~2011–2013
- BKL removed entirely in Linux 2.6.39 (May 2011) — [`4ba8216cd905`](https://git.kernel.org/linus/4ba8216cd90560bc402f52076f64d8546e8aefcb) by Arnd Bergmann ("BKL: That's all, folks") — [LWN background](https://lwn.net/Articles/384855/)

### PREEMPT_RT and rt_mutex

On `CONFIG_PREEMPT_RT` kernels (used in real-time Linux deployments), `spinlock_t` itself is implemented on top of `rt_mutex`. Spinlocks become sleeping locks that can be preempted by higher-priority RT tasks, with full priority inheritance. The priority ceiling is correct even in nested lock scenarios through PI chain walking.

This means: on a PREEMPT_RT system, nearly all kernel locking uses the same priority-inheritance machinery, making priority inversion virtually impossible — at the cost of some throughput compared to the bare-spinlock model.

## Further reading

- [Spinlock and raw_spinlock](spinlock.md) — The busy-wait alternative
- [Lockdep](lockdep.md) — Detecting deadlocks and lock ordering violations
- [Priority Inversion & PI Mutexes](../sched/pi-mutexes.md) — When rt_mutex matters
- `Documentation/locking/mutex-design.rst` in the kernel tree
