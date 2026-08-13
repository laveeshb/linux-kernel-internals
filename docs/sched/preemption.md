# Linux Preemption Model

> When can the kernel be preempted? Voluntary, full, and PREEMPT_RT

## What is preemption?

**Preemption** means stopping the currently running task to run a higher-priority task. Linux has several preemption models, selected at build time via Kconfig:

```
CONFIG_PREEMPT_NONE        — Server: only voluntary preemption
CONFIG_PREEMPT_VOLUNTARY   — Desktop: voluntary + explicit preemption points
CONFIG_PREEMPT             — Full: preempt anywhere except spinlocks
CONFIG_PREEMPT_RT          — Real-time: preempt almost everywhere
```

The model affects **latency** (how quickly high-priority tasks run) vs **throughput** (overall system efficiency).

## preempt_count: the preemption gate

Every task has a `preempt_count` field in its thread_info. Preemption is disabled when this is nonzero:

```c
/* include/linux/preempt.h */
/* preempt_count layout (per CPU): */
/*
 *         PREEMPT_MASK  (bits 0-7):   preemption nesting depth
 *         SOFTIRQ_MASK  (bits 8-15):  softirq nesting depth
 *         HARDIRQ_MASK  (bits 16-19): hardirq (interrupt) nesting depth
 *         NMI_MASK      (bit 20):     NMI context
 */

/* Check if preemptible */
#define preemptible()   (preempt_count() == 0 && !irqs_disabled())

/* Disable/enable preemption */
preempt_disable();   /* preempt_count++ */
preempt_enable();    /* preempt_count--; if 0, check for pending reschedule */

/* Low-overhead version (no reschedule check on enable): */
preempt_disable_notrace();
preempt_enable_notrace();
```

### preempt_count contexts

```c
/* Am I in interrupt context? */
in_interrupt()    /* HARDIRQ_MASK | SOFTIRQ_MASK | NMI_MASK */
in_irq()          /* HARDIRQ_MASK only */
in_softirq()      /* SOFTIRQ_MASK only */
in_nmi()          /* NMI_MASK only */

/* Am I in atomic context (cannot sleep)? */
in_atomic()       /* preempt_count != 0 */
/* Note: this includes hardirq, softirq, spinlock, and preempt_disable */
```

## CONFIG_PREEMPT_NONE: server model

No preemption except at explicit `schedule()` calls. A kernel code path runs until it voluntarily yields:

```
High-priority task wakes → must wait for current kernel path to finish
  ↓
Current task calls schedule() or returns to userspace
  ↓
High-priority task runs
```

**Latency**: milliseconds to seconds (if kernel path is long)
**Throughput**: highest (no unnecessary context switches)
**Use case**: servers, batch workloads (HPC, databases)

## CONFIG_PREEMPT_VOLUNTARY: desktop model

Adds explicit preemption points (`might_sleep()`, `cond_resched()`) at strategic locations in long kernel loops:

```c
/* mm/filemap.c — long loop with preemption point */
ssize_t filemap_read(struct kiocb *iocb, struct iov_iter *iter, ...)
{
    do {
        /* ... read pages ... */
        cond_resched();  /* yield if higher-priority task is waiting */
    } while (iov_iter_count(iter));
}

/* kernel/sched/fair.c */
static void __sched_yield(void)
{
    cond_resched();
}
```

`cond_resched()` checks `TIF_NEED_RESCHED` and calls `schedule()` if set — but only if preemption is not disabled (`preempt_count == 0`).

**Latency**: tens of milliseconds
**Use case**: desktop systems

## CONFIG_PREEMPT: full preemption

The kernel can be preempted at any point where `preempt_count == 0`, not just at explicit yield points. When `TIF_NEED_RESCHED` is set, the task is preempted at the next preemption window:

```c
/* arch/x86/kernel/entry_64.S */
/*
 * Interrupt return path:
 * If returning to kernel mode, check if preemption is needed
 */
.Lreturn_from_interrupt:
    testb $3, CS-ORIG_RAX(%rsp)  /* returning to userspace? */
    jnz .Lreturn_to_userspace

    /* Returning to kernel: check preempt_count and TIF_NEED_RESCHED */
    call preempt_schedule_irq    /* preempt if needed */
```

```c
/* kernel/sched/core.c */
asmlinkage __visible void __sched preempt_schedule_irq(void)
{
    /* Called from interrupt return when TIF_NEED_RESCHED is set */
    /* and preempt_count == 0 */
    do {
        preempt_disable();       /* prevent recursive preemption */
        local_irq_enable();
        __schedule(SM_PREEMPT);  /* context switch */
        local_irq_disable();
        sched_preempt_enable_no_resched();
    } while (need_resched());
}
```

**Latency**: hundreds of microseconds
**Use case**: desktop, embedded, audio systems

## CONFIG_PREEMPT_RT: real-time

PREEMPT_RT (fully merged in 6.12 for all architectures — [merge commit `baeb9a7d8b60`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=baeb9a7d8b60b021d907127509c44507539c15e5), [LWN](https://lwn.net/Articles/989212/)) converts almost all spinlocks to sleeping mutexes, allowing preemption even while holding a "spinlock":

```
Non-RT:                          RT:
  spin_lock → disable preempt     spin_lock → sleeping mutex
  [not preemptible]               [can be preempted]
  spin_unlock                     spin_unlock

  Result: RT task must wait       Result: RT task preempts
  for lock holder to finish       lock holder immediately
```

### What changes in PREEMPT_RT

```c
/* Most spinlocks become rt_mutex under PREEMPT_RT: */
spinlock_t lock;
spin_lock(&lock);   /* PREEMPT_RT: sleeping mutex_lock(&rt_mutex) */
spin_unlock(&lock); /* PREEMPT_RT: mutex_unlock */

/* Exceptions (still raw spinlocks in RT): */
raw_spinlock_t raw_lock;
raw_spin_lock(&raw_lock);   /* never sleeps, even in RT */
/* Used for: scheduler internals, IRQ subsystem, brief critical sections */

/* Softirqs run in dedicated per-CPU threads (RT): */
/* ksoftirqd/0 is a regular kthread, preemptible */

/* In-kernel timers fire from hrtimer softirq thread (preemptible) */
```

### Priority inversion prevention

PREEMPT_RT enables the **priority inheritance** mechanism for RT mutexes:

```c
/* Without priority inheritance: */
Low-prio task holds lock → High-prio RT task waits → Medium-prio task runs
  → RT task is effectively blocked by medium-prio task (priority inversion!)

/* With RT mutex priority inheritance: */
Low-prio task holds lock → High-prio RT task waits
  → Low-prio task temporarily runs at HIGH priority
  → Medium-prio task does NOT run
  → Low-prio finishes, releases lock
  → High-prio RT task runs immediately
```

See [Priority Inversion and PI Mutexes](pi-mutexes.md) for details.

### PREEMPT_RT latency

```
CONFIG_PREEMPT_NONE:       ~1-100ms worst-case
CONFIG_PREEMPT_VOLUNTARY:  ~1-10ms
CONFIG_PREEMPT:            ~100-1000µs
CONFIG_PREEMPT_RT:         ~10-100µs (with proper tuning)
```

## preempt_disable in practice

### Spinlocks implicitly disable preemption

```c
spinlock_t lock;

spin_lock(&lock);
/* preempt_count++ (in non-RT) */
/* Now: cannot sleep, cannot be preempted */

/* ... critical section ... */

spin_unlock(&lock);
/* preempt_count-- */
/* If TIF_NEED_RESCHED: schedule() called here */
```

### Per-CPU operations require preemption disabled

```c
/* Per-CPU variables are only safe when preemption is disabled */
/* (otherwise you could migrate to another CPU mid-operation) */

preempt_disable();
this_cpu_inc(my_per_cpu_counter);
preempt_enable();

/* Or use the helper (implicitly disables preemption): */
this_cpu_inc(my_per_cpu_counter);  /* always safe: implicitly disables preempt */
```

### Checking context in a driver

```c
void my_function(void) {
    if (in_interrupt()) {
        /* Called from IRQ: cannot sleep, cannot take sleeping locks */
        /* Use atomic allocation: GFP_ATOMIC */
        ptr = kmalloc(size, GFP_ATOMIC);
    } else if (in_atomic()) {
        /* Called while preemption disabled (spinlock, etc.) */
        /* Also cannot sleep */
    } else {
        /* Normal process context: can sleep */
        ptr = kmalloc(size, GFP_KERNEL);
        mutex_lock(&my_mutex);
    }
}
```

## might_sleep: debugging sleeping in atomic context

```c
/* include/linux/kernel.h */
#define might_sleep() \
    do { __might_sleep(__FILE__, __LINE__); } while (0)

void __might_sleep(const char *file, int line)
{
    if (in_atomic() || irqs_disabled()) {
        /* Print a WARN with stack trace */
        pr_warn("BUG: sleeping function called from invalid context at %s:%d\n",
                 file, line);
        dump_stack();
    }
}

/* Called automatically by: */
/* mutex_lock, down(), copy_to_user, kmalloc(GFP_KERNEL), ... */
```

This is why you get "BUG: sleeping function called from invalid context" when you accidentally call `mutex_lock()` from an interrupt handler.

## Checking the preemption model

```bash
# See which preemption model is active
zcat /proc/config.gz | grep PREEMPT
# CONFIG_PREEMPT_NONE=y      (or VOLUNTARY, PREEMPT, PREEMPT_RT)

# Check at runtime
uname -v | grep PREEMPT
# #1 SMP PREEMPT_RT ...

# Preemption statistics
cat /proc/sched_debug | grep -A5 "preempt"

# Latency tracing (ftrace)
echo preemptirqsoff > /sys/kernel/debug/tracing/current_tracer
# Traces longest preemption-disabled period
cat /sys/kernel/debug/tracing/trace | head -50
```

## Further reading

- [Context Switch](context-switch.md) — what schedule() does
- [What Happens When a Process Wakes Up](wakeup.md) — TIF_NEED_RESCHED setting
- [Priority Inversion and PI Mutexes](pi-mutexes.md) — RT priority inheritance
- [Spinlock and raw_spinlock](../locking/spinlock.md) — preemption disabling in spinlocks
- [Softirqs](../interrupts/softirq.md) — softirq threading in PREEMPT_RT
- `kernel/sched/core.c` — preempt_schedule_irq, __schedule
- `include/linux/preempt.h` — preempt_count macros
