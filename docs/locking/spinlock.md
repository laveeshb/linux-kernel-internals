# Spinlock and raw_spinlock

> Busy-wait locks that don't sleep — the foundation of kernel synchronization

## What is a spinlock?

A spinlock is a lock that a thread holds by spinning in a tight loop until the lock becomes available. Unlike a mutex, it never puts the thread to sleep. This makes spinlocks usable in contexts where sleeping is forbidden — interrupt handlers, NMI handlers, and anywhere `in_interrupt()` is true.

The cost: spinning wastes CPU cycles. Spinlocks should only protect very short critical sections (typically microseconds, not milliseconds).

## Two spinlock types

The kernel has two types that look similar but behave differently on PREEMPT_RT kernels:

```c
/* include/linux/spinlock_types.h */

/* Non-RT kernels: spinlock_t wraps raw_spinlock_t */
typedef struct spinlock {
    union {
        struct raw_spinlock rlock;
    };
} spinlock_t;

/* raw_spinlock_t: always a real spinlock, never converted */
typedef struct raw_spinlock {
    arch_spinlock_t raw_lock;   /* arch-specific, e.g. queued spinlock */
#ifdef CONFIG_DEBUG_LOCK_ALLOC
    struct lockdep_map dep_map;
#endif
} raw_spinlock_t;
```

On a standard kernel (non-RT), `spinlock_t` and `raw_spinlock_t` behave identically.

On a PREEMPT_RT kernel, `spinlock_t` becomes a sleeping lock (backed by `rt_mutex`) so that RT tasks can preempt the lock holder. `raw_spinlock_t` remains a true spinlock even on RT.

**Rule**: use `spinlock_t` for most code. Use `raw_spinlock_t` only when you need a true spinlock even on RT kernels (e.g., the scheduler's runqueue lock, which cannot sleep because the scheduler itself is how sleeping works).

## Basic API

```c
#include <linux/spinlock.h>

/* Static initialization */
DEFINE_SPINLOCK(my_lock);

/* Dynamic initialization */
spinlock_t my_lock;
spin_lock_init(&my_lock);

/* Lock / unlock (process context, preemption disabled) */
spin_lock(&my_lock);
/* critical section */
spin_unlock(&my_lock);

/* Lock/unlock + disable local interrupts */
unsigned long flags;
spin_lock_irqsave(&my_lock, flags);
/* critical section — safe even if called from process context
   where IRQ handler might also take this lock */
spin_unlock_irqrestore(&my_lock, flags);

/* Lock/unlock + disable only softirqs (bottom halves) */
spin_lock_bh(&my_lock);
spin_unlock_bh(&my_lock);

/* Non-blocking trylock (returns 1 on success, 0 on failure) */
if (spin_trylock(&my_lock)) {
    /* got the lock */
    spin_unlock(&my_lock);
}
```

## When to use irqsave vs plain spin_lock

The rule: you need `spin_lock_irqsave()` if the same lock is acquired from both process context and an interrupt handler.

```c
/* WRONG: process context takes lock, then IRQ fires and also
   tries to take the same lock → deadlock */
static spinlock_t counter_lock;
static int counter;

void update_counter(void)       /* process context */
{
    spin_lock(&counter_lock);   /* takes lock */
    counter++;
    spin_unlock(&counter_lock); /* releases lock */
}

irqreturn_t my_irq_handler(int irq, void *data)
{
    spin_lock(&counter_lock);   /* DEADLOCK: IRQ fires while process holds lock */
    counter++;
    spin_unlock(&counter_lock);
    return IRQ_HANDLED;
}

/* CORRECT: disable IRQs while holding the lock */
void update_counter(void)
{
    unsigned long flags;
    spin_lock_irqsave(&counter_lock, flags);
    counter++;
    spin_unlock_irqrestore(&counter_lock, flags);
}
```

If the lock is only used within a single IRQ handler (or only in process context where IRQs are already off), plain `spin_lock()` is sufficient.

## How it works: queued spinlocks

Modern x86 uses **queued spinlocks** (MCS-based, introduced in Linux 4.2). Instead of all waiters spinning on the same variable (causing cache line bouncing), each CPU spins on its own per-CPU node:

```
Lock structure:
┌──────────────────────────────┐
│ locked byte | pending | tail (cpu+ctx) │  ← 32-bit word
└────────────────────────────────────────┘
  bits 0-7: locked byte (0=free, 1=locked)
  bit 8:    pending (a waiter is about to acquire)
  bits 16-31: tail (encodes CPU number + nesting context)

MCS queue node (per-CPU):
┌────────────────────────────┐
│ locked | next_cpu_ptr      │
└────────────────────────────┘
         ↑
         Each waiter spins on its own node's 'locked' field.
         No cache line bouncing.
```

When a CPU acquires the lock it clears `locked` in the next CPU's node, causing only that waiter to stop spinning. This scales to hundreds of CPUs.

## raw_spinlock API

`raw_spinlock_t` uses the same naming convention but with `raw_` prefix:

```c
raw_spinlock_t raw_lock = __RAW_SPIN_LOCK_UNLOCKED(raw_lock);

raw_spin_lock(&raw_lock);
raw_spin_unlock(&raw_lock);

raw_spin_lock_irqsave(&raw_lock, flags);
raw_spin_unlock_irqrestore(&raw_lock, flags);

raw_spin_trylock(&raw_lock);       /* returns 1 on success */
```

## Debugging: lockdep catches misuse

With `CONFIG_DEBUG_SPINLOCK` and `CONFIG_LOCKDEP`, the kernel detects:
- Double-locking (taking a lock you already hold)
- Lock ordering violations (potential deadlocks between lock classes)
- Sleeping while holding a spinlock
- Taking a lock in hardirq context that is also taken in process context without irq-disable

```
BUG: spinlock already locked on CPU#1
spin_lock() at include/linux/spinlock.h:186
...
```

See [Lockdep](lockdep.md) for full details.

## Common mistakes

```c
/* DON'T: hold a spinlock across sleeping calls */
spin_lock(&lock);
kmalloc(size, GFP_KERNEL);  /* may sleep — BUG */
spin_unlock(&lock);

/* DO: use GFP_ATOMIC when holding a spinlock */
spin_lock(&lock);
kmalloc(size, GFP_ATOMIC);  /* never sleeps */
spin_unlock(&lock);

/* DON'T: call spin_lock twice on the same lock (no recursion) */
spin_lock(&lock);
spin_lock(&lock);  /* DEADLOCK */

/* DON'T: exit function without unlocking */
spin_lock(&lock);
if (error)
    return -EINVAL;  /* leaked lock! */
spin_unlock(&lock);
```

## Further reading

- [Mutex and rt_mutex](mutex.md) — When you can afford to sleep
- [Lockdep](lockdep.md) — How the kernel validates lock usage
- [Atomic operations and memory barriers](atomics.md) — What spinlocks are built on
- `Documentation/locking/spinlocks.rst` in the kernel tree
