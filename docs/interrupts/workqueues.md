# Workqueues

> Process-context deferred work — the right choice for most drivers

## What are workqueues?

Workqueues are the most flexible deferred work mechanism in the kernel. Unlike softirqs and tasklets, workqueue handlers run in **process context** — they can sleep, take mutexes, do memory allocation with `GFP_KERNEL`, and perform any operation that's valid in a kernel thread.

The kernel automatically manages a pool of worker threads. Each work item is queued and run when a worker becomes available.

## Work items and initialization

```c
#include <linux/workqueue.h>

/* Define a work item and its handler */
struct my_device {
    struct work_struct  work;      /* one-shot work */
    struct delayed_work dwork;     /* delayed work */
};

/* Work handler: runs in process context */
static void my_work_handler(struct work_struct *work)
{
    struct my_device *dev = container_of(work, struct my_device, work);
    /* Can sleep, take mutexes, allocate memory with GFP_KERNEL */
    mutex_lock(&dev->lock);
    process_data(dev);
    mutex_unlock(&dev->lock);
}

static void my_delayed_work_handler(struct work_struct *work)
{
    struct delayed_work *dwork = to_delayed_work(work);
    struct my_device *dev = container_of(dwork, struct my_device, dwork);
    /* ... */
}

/* Initialize */
INIT_WORK(&dev->work, my_work_handler);
INIT_DELAYED_WORK(&dev->dwork, my_delayed_work_handler);
```

## Scheduling work

```c
/* Queue on the system workqueue (runs as soon as worker is free) */
schedule_work(&dev->work);

/* Queue with a delay */
schedule_delayed_work(&dev->dwork, msecs_to_jiffies(100));  /* 100ms delay */

/* Cancel a pending delayed work */
cancel_delayed_work_sync(&dev->dwork);  /* wait for running handler */
cancel_delayed_work(&dev->dwork);       /* don't wait */

/* Cancel a non-delayed work */
cancel_work_sync(&dev->work);
```

`schedule_work()` is idempotent: if the work is already pending, calling it again does nothing. The work will run exactly once.

## System workqueues

The kernel provides several pre-built workqueues for different priorities and behaviors:

```c
/* include/linux/workqueue.h */
extern struct workqueue_struct *system_wq;           /* general purpose */
extern struct workqueue_struct *system_highpri_wq;   /* high priority */
extern struct workqueue_struct *system_long_wq;      /* for long-running work */
extern struct workqueue_struct *system_unbound_wq;   /* not CPU-bound */
extern struct workqueue_struct *system_freezable_wq; /* freezable for suspend */
extern struct workqueue_struct *system_power_efficient_wq; /* optimized for power */

/* Queue on a specific workqueue */
queue_work(system_highpri_wq, &dev->work);
queue_delayed_work(system_wq, &dev->dwork, delay);
```

For most drivers, `system_wq` (accessed via `schedule_work()`) is the right choice.

## Creating a private workqueue

For work that needs specific concurrency control or isolation from system work:

```c
/* alloc_workqueue(name, flags, max_active) */

/* Bound: one worker per CPU, max 1 concurrent item */
wq = alloc_workqueue("my-driver", WQ_MEM_RECLAIM, 1);

/* Unbound: not tied to specific CPUs, good for CPU-intensive work */
wq = alloc_workqueue("my-driver-unbound", WQ_UNBOUND, 0);

/* High priority, unbound */
wq = alloc_workqueue("my-driver-hp", WQ_UNBOUND | WQ_HIGHPRI, 0);

/* Queue on private workqueue */
queue_work(wq, &dev->work);

/* Flush: wait for all pending work to complete */
flush_workqueue(wq);
drain_workqueue(wq);

/* Destroy */
destroy_workqueue(wq);
```

## WQ flags

| Flag | Meaning |
|------|---------|
| `WQ_UNBOUND` | Workers not bound to specific CPUs — work runs anywhere |
| `WQ_MEM_RECLAIM` | Reserves a rescue worker for memory pressure situations |
| `WQ_HIGHPRI` | Workers run at elevated priority |
| `WQ_FREEZABLE` | Work freezes during system suspend |
| `WQ_SYSFS` | Expose workqueue in `/sys/bus/workqueue/devices/` |

## Concurrency-managed workqueues (cmwq)

Since Linux 2.6.36, the kernel uses **concurrency-managed workqueues** (cmwq), introduced by Tejun Heo [(LWN)](https://lwn.net/Articles/394084/). Instead of one thread per CPU, the kernel maintains a pool of workers and dynamically creates/destroys threads based on demand.

The key property: **the kernel tries to keep exactly one runnable worker per CPU**. If a worker sleeps (waiting on I/O or a mutex), the kernel may create another worker to keep the CPU busy.

```
Worker pool state:
  Worker A: running (doing work)
  Worker B: sleeping on mutex
                ↓
  Kernel creates Worker C to handle next queued work
  (because Worker B is blocked, Worker A is the only runner)

When Worker B wakes:
  Now two runnable workers → Worker B becomes idle
```

This avoids both CPU underutilization (when workers sleep) and thread explosion (cmwq reuses workers intelligently).

## flush_work vs cancel_work

```c
/* Wait for a specific work item to finish */
flush_work(&dev->work);          /* blocks until handler completes */
flush_delayed_work(&dev->dwork); /* cancels delay if pending, then waits */

/* Cancel and wait */
cancel_work_sync(&dev->work);         /* cancel + wait for running handler */
cancel_delayed_work_sync(&dev->dwork); /* cancel delayed + wait */
```

Always use `cancel_*_sync()` in driver teardown to prevent use-after-free:

```c
static void my_driver_remove(struct platform_device *pdev)
{
    struct my_device *dev = platform_get_drvdata(pdev);

    /* IMPORTANT: cancel before freeing dev */
    cancel_work_sync(&dev->work);
    cancel_delayed_work_sync(&dev->dwork);

    kfree(dev);
}
```

## Observing workqueue activity

```bash
# List workqueues and worker thread counts
cat /sys/bus/workqueue/devices/*/name 2>/dev/null

# Worker threads
ps aux | grep kworker
# root  1234  0.0 [kworker/0:1-events]    ← CPU 0, events wq
# root  1235  0.0 [kworker/1:2-mm_percpu_wq]
# root  1236  0.0 [kworker/u8:0-writeback] ← unbound

# Work queue stats (with CONFIG_WQ_WATCHDOG)
cat /proc/sys/kernel/watchdog_thresh
```

## Further reading

- [Softirqs](softirq.md) — Lower-level, non-sleeping deferred work
- [Tasklets](tasklets.md) — Simpler but deprecated, non-sleeping
- [Threaded IRQs](threaded-irq.md) — Process-context IRQ handlers
- `Documentation/core-api/workqueue.rst` — Complete workqueue documentation
