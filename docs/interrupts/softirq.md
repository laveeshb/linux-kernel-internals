# Softirqs

> The kernel's high-priority deferred work mechanism

## What are softirqs?

Softirqs (software interrupts) are the lowest-level deferred execution mechanism in the kernel. Unlike hardirq handlers that run with interrupts disabled, softirqs run with interrupts **enabled** — they're preemptible by hardirqs but not by other softirqs on the same CPU.

Softirqs are statically defined: there are exactly 10 softirq types, registered at boot. New types cannot be added dynamically. Drivers don't use softirqs directly — they use [tasklets](tasklets.md) or [workqueues](workqueues.md) instead.

## The 10 softirq types

```c
/* include/linux/interrupt.h */
enum {
    HI_SOFTIRQ      = 0,  /* high-priority tasklets */
    TIMER_SOFTIRQ   = 1,  /* timer wheel expiry */
    NET_TX_SOFTIRQ  = 2,  /* network transmit */
    NET_RX_SOFTIRQ  = 3,  /* network receive (NAPI) */
    BLOCK_SOFTIRQ   = 4,  /* block layer completions */
    IRQ_POLL_SOFTIRQ= 5,  /* IRQ poll (blk-mq) */
    TASKLET_SOFTIRQ = 6,  /* normal-priority tasklets */
    SCHED_SOFTIRQ   = 7,  /* scheduler (load balancing) */
    HRTIMER_SOFTIRQ = 8,  /* high-resolution timer */
    RCU_SOFTIRQ     = 9,  /* RCU callbacks */
    NR_SOFTIRQS
};
```

The number is the **priority** — lower number runs first. `HI_SOFTIRQ` (priority 0) for high-priority tasklets always preempts `TASKLET_SOFTIRQ` (priority 6) for normal tasklets.

## How softirqs are triggered

A softirq is raised by calling `raise_softirq()`, which sets a bit in the per-CPU `__softirq_pending` bitmask:

```c
/* Raise a softirq (can call from hardirq context) */
raise_softirq(NET_RX_SOFTIRQ);

/* Variant for use when IRQs are already disabled */
raise_softirq_irqoff(NET_TX_SOFTIRQ);
```

## When softirqs run

Softirqs are processed at three points:

1. **After a hardirq handler returns** (`irq_exit_rcu()`)
2. **In ksoftirqd threads** when softirqs are too frequent
3. **Explicitly** in `local_bh_enable()` when bottom halves are re-enabled

The `__do_softirq()` → `handle_softirqs()` loop:

```c
/* kernel/softirq.c (simplified) */
static void handle_softirqs(bool ksirqd)
{
    __u32 pending = local_softirq_pending();

    /* Enable IRQs (softirqs run with interrupts enabled) */
    local_irq_enable();

    /* Process each pending softirq in priority order */
    while ((softirq_bit = ffs(pending))) {
        h = &softirq_vec[softirq_bit - 1];
        h->action();    /* call the registered handler */
        pending >>= softirq_bit;
    }

    local_irq_disable();

    /* If more softirqs pending and time allows, restart */
    if (pending) {
        if (time_before(jiffies, end) && !need_resched() && --max_restart)
            goto restart;
        /* Otherwise, wake ksoftirqd */
        wakeup_softirqd();
    }
}
```

The loop limits to `MAX_SOFTIRQ_RESTART` (10) iterations before waking `ksoftirqd`, preventing softirqs from starving processes indefinitely.

## ksoftirqd

When softirqs are too frequent (high network load, many timers), the loop would run too long. Instead, the kernel wakes `ksoftirqd/N` — one per CPU — which is a kernel thread at `SCHED_NORMAL` priority that drains pending softirqs:

```bash
# ksoftirqd threads: one per CPU
ps aux | grep ksoftirqd
# root         9  0.0  0.0      0     0 ?   S    10:00   0:01 [ksoftirqd/0]
# root        18  0.0  0.0      0     0 ?   S    10:00   0:00 [ksoftirqd/1]
```

Since `ksoftirqd` is a normal process, it can be preempted by user tasks, preventing livelock. High CPU usage by `ksoftirqd` indicates the system is processing many interrupts.

## Checking softirq activity

```bash
# Per-CPU softirq counts
cat /proc/softirqs
#                     CPU0       CPU1       CPU2       CPU3
#           HI:          1          1          1          1
#        TIMER:    1234567    1234456    1234123    1234234
#       NET_TX:       1234       1567       1123       1345
#       NET_RX:    2345678    2345234    2345123    2345456
#        BLOCK:      23456      23234      23123      23345
#     IRQ_POLL:          0          0          0          0
#      TASKLET:       1234       1234       1234       1234
#        SCHED:    3456789    3456234    3456123    3456456
#      HRTIMER:      12345      12234      12123      12234
#          RCU:    4567890    4567234    4567123    4567456

# NET_RX high = heavy network receive
# TASKLET high = many driver tasklets
# RCU high = many RCU callbacks being processed
```

## Registering a softirq handler (kernel subsystems only)

```c
/* At boot time only (not from drivers) */
open_softirq(MY_SOFTIRQ_NR, my_softirq_action);

/* The handler signature */
static void my_softirq_action(void)
{
    /* Process work for this CPU */
    /* Runs with IRQs enabled, preemptible by hardirqs */
    /* Cannot sleep */
}
```

Drivers should use tasklets or workqueues instead — never add a new softirq type.

## local_bh_disable / local_bh_enable

Code that shares data with softirq handlers must disable softirqs on the local CPU while accessing the data:

```c
/* Disable softirqs (and tasklets) on this CPU */
local_bh_disable();
/* Access data shared with softirq handler */
local_bh_enable();  /* re-enables, runs pending softirqs */

/* spin_lock_bh: spinlock + local_bh_disable in one call */
spin_lock_bh(&my_lock);
/* safe to access data that softirq also touches */
spin_unlock_bh(&my_lock);
```

## Further reading

- [Tasklets](tasklets.md) — The driver-accessible wrapper around softirqs
- [Workqueues](workqueues.md) — When you need to sleep in deferred work
- [Network Device and NAPI](../net/napi.md) — NET_RX_SOFTIRQ in practice
