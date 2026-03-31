# Workqueue Internals

> cmwq architecture, worker pools, work item lifecycle, and NUMA affinity

## Why workqueues exist

Interrupt handlers (hardirq and softirq) run atomically — they cannot sleep or block. Work that needs to sleep, acquire mutexes, or do I/O must be deferred. Workqueues provide a kernel thread pool that can run this deferred work in process context.

```
Interrupt fires:
  hardirq handler → schedule_work(&my_work)   ← non-sleeping, fast
                         │
                         ▼
                    [kworker thread]            ← sleeps OK
                    my_work_func()
                    → can mutex_lock(), kmalloc(GFP_KERNEL), etc.
```

## Concurrency-Managed Workqueues (cmwq)

Since Linux 2.6.36, workqueues use **cmwq** — a unified worker pool that automatically manages concurrency:

```
Before cmwq (per-CPU dedicated threads):
  cpu0: kblockd/0, kworker/0:0, kworker/0:1, ...
  cpu1: kblockd/1, kworker/1:0, kworker/1:1, ...
  Problem: each workqueue had its own per-CPU thread → thread explosion

After cmwq (shared worker pool):
  cpu0: [shared pool] kworker/0:0, kworker/0:1, kworker/0:2H (high-prio)
  cpu1: [shared pool] kworker/1:0, kworker/1:1, kworker/1:2H
  All workqueues share the pool → far fewer threads
```

### Worker pool types

```c
/* kernel/workqueue.c */

/* Per-CPU worker pools (2 per CPU: normal and highpri): */
static DEFINE_PER_CPU_SHARED_ALIGNED(struct worker_pool [NR_STD_WORKER_POOLS],
                                     cpu_worker_pools);
/*
 * cpu_worker_pools[0]: normal priority (SCHED_NORMAL, nice=0)
 * cpu_worker_pools[1]: high priority  (SCHED_NORMAL, nice=-20)
 */

/* Unbound worker pools: not tied to any CPU, for WQ_UNBOUND workqueues */
static DEFINE_HASHTABLE(unbound_pool_hash, UNBOUND_POOL_HASH_ORDER);
```

## Creating workqueues

```c
#include <linux/workqueue.h>

/* System workqueues (prefer these): */
system_wq             /* general-purpose, can sleep */
system_highpri_wq     /* high-priority, time-critical work */
system_long_wq        /* for work that may run for a long time */
system_unbound_wq     /* not bound to a specific CPU */
system_freezable_wq   /* suspended during system freeze */
system_power_efficient_wq  /* prefers low-power CPUs */

/* Use system_wq for most cases: */
schedule_work(&my_work);  /* submits to system_wq */

/* Custom workqueue: */
struct workqueue_struct *wq;

/* Bound to a CPU (work runs on the CPU it was submitted from): */
wq = alloc_workqueue("my-wq", WQ_MEM_RECLAIM, 1);

/* Unbound (can run on any CPU, better for NUMA): */
wq = alloc_workqueue("my-unbound-wq", WQ_UNBOUND, 0);

/* High priority + unbound: */
wq = alloc_workqueue("my-hipri-wq", WQ_UNBOUND | WQ_HIGHPRI, 0);

/* Flags: */
WQ_UNBOUND          /* not bound to a specific CPU */
WQ_FREEZABLE        /* freeze during system suspend */
WQ_MEM_RECLAIM      /* may be needed during memory reclaim (reserves a rescue thread) */
WQ_HIGHPRI          /* high-priority worker pool */
WQ_CPU_INTENSIVE    /* CPU-intensive work: excluded from pool concurrency count,
                       allowing other pending work to start alongside it */
WQ_SYSFS            /* expose workqueue attributes in /sys/bus/workqueue */

/* Last arg: max_active = max concurrent work items per CPU (0 = default=256) */
```

## Work items

```c
/* Declare and initialize work: */
DECLARE_WORK(my_work, my_work_func);
/* or: */
struct work_struct my_work;
INIT_WORK(&my_work, my_work_func);

/* Work function: */
static void my_work_func(struct work_struct *work)
{
    struct my_device *dev = container_of(work, struct my_device, work);
    /* Process dev->data — can sleep here */
    mutex_lock(&dev->lock);
    process_data(dev);
    mutex_unlock(&dev->lock);
}

/* Submit work: */
schedule_work(&my_work);          /* to system_wq, current CPU */
queue_work(wq, &my_work);         /* to custom wq */
queue_work_on(cpu, wq, &my_work); /* to specific CPU's pool */

/* Wait for work to complete: */
flush_work(&my_work);             /* blocks until this work item finishes */
flush_workqueue(wq);              /* blocks until all items in wq finish */
```

## Delayed work

```c
struct delayed_work my_dwork;
INIT_DELAYED_WORK(&my_dwork, my_dwork_func);

/* Schedule to run after 100ms: */
schedule_delayed_work(&my_dwork, msecs_to_jiffies(100));
queue_delayed_work(wq, &my_dwork, msecs_to_jiffies(100));

/* Cancel (may or may not cancel if already running): */
cancel_delayed_work(&my_dwork);

/* Cancel and wait for completion: */
cancel_delayed_work_sync(&my_dwork);
```

## struct work_struct internals

```c
struct work_struct {
    atomic_long_t   data;       /* encodes: pool pointer + flags */
    struct list_head entry;     /* in pool->worklist */
    work_func_t     func;
#ifdef CONFIG_LOCKDEP
    struct lockdep_map lockdep_map;
#endif
};

/* data field encodes: */
/* bits [0]: WORK_STRUCT_PENDING — work is queued */
/* bits [1]: WORK_STRUCT_INACTIVE — work is in an inactive list */
/* bits [2]: WORK_STRUCT_PWQ — lower bits point to pool_workqueue */
/* bits [WORK_STRUCT_FLAG_BITS..]: pointer to pool_workqueue or last pool */
```

## Worker pool and concurrency management

```c
struct worker_pool {
    spinlock_t          lock;
    int                 cpu;        /* CPU or -1 for unbound */
    int                 node;       /* NUMA node */
    int                 id;
    unsigned int        flags;

    unsigned long       watchdog_ts;
    bool                cpu_stall;

    struct list_head    worklist;   /* pending work items */
    int                 nr_workers;
    int                 nr_idle;

    struct list_head    idle_list;  /* idle workers */
    struct timer_list   idle_timer;
    struct work_struct  idle_cull_work;

    struct timer_list   mayday_timer; /* safety valve */
    DECLARE_HASHTABLE(busy_hash, BUSY_WORKER_HASH_ORDER);

    struct worker       *manager;   /* thread managing the pool */
    struct list_head    workers;    /* all workers in pool */
    struct completion   *detach_completion;

    struct ida          worker_ida;
    struct workqueue_attrs *attrs;
    struct hlist_node   hash_node;
    int                 refcnt;
    struct rcu_head     rcu;
};
```

### Concurrency management algorithm

cmwq maintains exactly enough workers to keep the CPU busy:

```
Rule: pool tries to keep at least one runnable worker
  (one that is executing work AND not sleeping)

When a worker goes to sleep (blocks on mutex, I/O, etc.):
  → pool checks: is there another runnable worker?
  → if not: wake an idle worker (or create a new one)
  → prevents CPU stall while work is blocked

When a worker wakes up:
  → pool checks: too many runnable workers?
  → if yes: go back to sleep (idle)

Result: CPU always busy, minimal thread creation
```

```c
/* kernel/workqueue.c */
static void worker_enter_idle(struct worker *worker)
{
    struct worker_pool *pool = worker->pool;

    /* ... */
    pool->nr_idle++;
    worker->last_active = jiffies;
    worker->flags |= WORKER_IDLE;
    list_add(&worker->entry, &pool->idle_list);

    /* Destroy idle workers after 5 minutes of idleness */
    if (too_many_workers(pool))
        mod_timer(&pool->idle_timer, jiffies + IDLE_WORKER_TIMEOUT);
}

static bool keep_working(struct worker_pool *pool)
{
    return !list_empty(&pool->worklist) &&
           atomic_read(&pool->nr_running) <= 1;
}
```

## Workqueue attributes and NUMA affinity

```c
/* Get/set workqueue attributes (WQ_UNBOUND only): */
struct workqueue_attrs *attrs = alloc_workqueue_attrs();
attrs->nice = -5;           /* worker thread niceness */
attrs->cpumask = cpu_mask;  /* which CPUs workers can run on */
attrs->no_numa = false;     /* respect NUMA locality */

apply_workqueue_attrs(wq, attrs);
free_workqueue_attrs(attrs);

/* NUMA-aware unbound pools:
   By default, unbound workqueues have per-NUMA-node pools.
   Work submitted from node 0 runs on node 0 workers.
   This ensures cache-hot data stays on the same node. */
```

## Workqueue debugging

```bash
# Show all workqueues and their stats:
cat /sys/kernel/debug/workqueue/stats

# Show worker threads:
ps aux | grep kworker
# kworker/0:1   — bound to CPU 0, pool 1 (normal)
# kworker/0:1H  — bound to CPU 0, pool H (high priority)
# kworker/u8:2  — unbound pool, pool ID=8, worker ID=2

# Show per-workqueue stats (if WQ_SYSFS):
ls /sys/bus/workqueue/devices/
cat /sys/bus/workqueue/devices/system_wq/per_cpu

# Dump all task stacks (including kworker threads) via SysRq:
echo t > /proc/sysrq-trigger
# Shows all threads in dmesg; use /sys/kernel/debug/workqueue for
# workqueue-specific state (pending counts, queue depths)

# Trace work submission and execution:
bpftrace -e '
kprobe:queue_work_on {
    /* queue_work_on(int cpu, struct workqueue_struct *wq, struct work_struct *work) */
    printf("queue_work: cpu=%d func=%s\n", (int)arg0,
           ksym(((struct work_struct *)arg2)->func));
}
kprobe:process_one_work {
    printf("exec_work: cpu=%d pid=%d func=%s\n",
           cpu, pid, ksym(((struct work_struct *)arg1)->func));
}'

# Watchdog: detect hung workers (CONFIG_WQ_WATCHDOG=y)
# Kernel will warn if a worker pool stalls for > 30 seconds:
# "BUG: workqueue lockup"
# Tune:
echo 60 > /sys/module/workqueue/parameters/watchdog_thresh
```

## WQ_MEM_RECLAIM and rescue workers

```c
/*
 * Work used during memory reclaim (e.g., writeback) MUST use WQ_MEM_RECLAIM.
 * This ensures a dedicated rescue worker exists that won't be blocked
 * waiting for memory (avoiding deadlock):
 *
 * Memory reclaim path:
 *   1. kswapd needs to write dirty pages → queues work
 *   2. Normal workers might be sleeping waiting for memory
 *   3. Rescue worker picks up the work — always has one thread reserved
 */
wq = alloc_workqueue("writeback", WQ_MEM_RECLAIM | WQ_UNBOUND, 1);
```

## Further reading

- [Workqueues](workqueues.md) — API reference and basic usage
- [Softirq and Tasklets](softirq.md) — lighter-weight deferral (no sleep)
- [Threaded IRQs](threaded-irq.md) — IRQ handlers in thread context
- [RCU](../locking/rcu.md) — lock-free deferred work
- `kernel/workqueue.c` — complete implementation (~6000 lines)
- `Documentation/core-api/workqueue.rst` — kernel documentation
