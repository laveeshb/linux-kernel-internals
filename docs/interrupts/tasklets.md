# Tasklets

> Serialized, per-CPU deferred work built on softirqs

## What are tasklets?

Tasklets are a driver-accessible deferral mechanism built on top of softirqs (`TASKLET_SOFTIRQ` and `HI_SOFTIRQ`). They provide two properties that raw softirqs don't:

1. **Serialization**: a given tasklet runs on only one CPU at a time — even on SMP systems, the same tasklet function is never called concurrently
2. **Dynamic registration**: drivers can register their own tasklets without defining a new softirq type

Tasklets cannot sleep (they run in softirq context). For deferred work that needs to sleep, use [workqueues](workqueues.md).

## The tasklet_struct

```c
/* include/linux/interrupt.h */
struct tasklet_struct {
    struct tasklet_struct *next;  /* pending list link */
    unsigned long state;          /* TASKLET_STATE_SCHED, TASKLET_STATE_RUN */
    atomic_t count;               /* 0 = enabled, >0 = disabled */
    bool use_callback;            /* which union member is live */
    union {
        void (*func)(unsigned long data);         /* legacy API */
        void (*callback)(struct tasklet_struct *t); /* modern API */
    };
    unsigned long data;           /* legacy: passed to old-style func */
};
```

`use_callback` and the `func`/`callback` union are themselves part of the 5.9 security-motivated rework covered below — before that patch set, `.func` was the only signature and `.data` was the only way to pass it context.

## API

```c
#include <linux/interrupt.h>

/* Modern API: callback receives the tasklet pointer */
void my_tasklet_handler(struct tasklet_struct *t)
{
    struct my_device *dev = from_tasklet(dev, t, tasklet);
    /* process work */
}

/* Declare (static) */
DECLARE_TASKLET(my_tasklet, my_tasklet_handler);

/* Or initialize dynamically */
struct tasklet_struct my_tasklet;
tasklet_setup(&my_tasklet, my_tasklet_handler);

/* Schedule (can call from IRQ handler) */
tasklet_schedule(&my_tasklet);    /* normal priority (TASKLET_SOFTIRQ) */
tasklet_hi_schedule(&my_tasklet); /* high priority (HI_SOFTIRQ) */

/* Disable/enable */
tasklet_disable(&my_tasklet);   /* wait for running, then disable */
tasklet_disable_nosync(&my_tasklet);  /* disable without waiting */
tasklet_enable(&my_tasklet);    /* re-enable, schedule if was pending */

/* Wait for tasklet to finish and kill it */
tasklet_kill(&my_tasklet);
```

## from_tasklet: accessing device context

The modern callback receives a `struct tasklet_struct *`. Use `from_tasklet()` to get the containing device struct:

```c
struct my_device {
    struct tasklet_struct rx_tasklet;
    void *rx_buffer;
    int rx_len;
};

static void my_rx_tasklet(struct tasklet_struct *t)
{
    struct my_device *dev = from_tasklet(dev, t, rx_tasklet);
    /* process dev->rx_buffer[0..dev->rx_len-1] */
}

static irqreturn_t my_irq_handler(int irq, void *data)
{
    struct my_device *dev = data;

    /* Copy data from hardware to buffer */
    dev->rx_len = readl(dev->regs + RX_LEN);
    memcpy_fromio(dev->rx_buffer, dev->regs + RX_DATA, dev->rx_len);

    /* Defer processing to tasklet */
    tasklet_schedule(&dev->rx_tasklet);
    return IRQ_HANDLED;
}
```

## Serialization guarantee

If `tasklet_schedule()` is called while the tasklet is already running on another CPU, the tasklet will run again after it finishes. But it will never run concurrently:

```
CPU 0: tasklet running...
CPU 1: tasklet_schedule() → sets SCHED bit

After CPU 0 finishes: sees SCHED bit, runs tasklet again
→ tasklet function never runs simultaneously on two CPUs
```

This is the key advantage over raw softirqs, where the same handler can run on multiple CPUs simultaneously.

## The deprecation nobody planned to start, then couldn't finish

Tasklets have existed since the 2.3 development series, essentially unchanged in shape while every other deferred-work mechanism around them evolved. The deprecation comment now sitting in `include/linux/interrupt.h` — *"This API is deprecated. Please consider using threaded IRQs instead"* — first appeared for Linux 5.9 (2020), and it started as a side effect of a patch nobody expected to be controversial.

In 2019, Kees Cook (with Romain Perier) posted a security-motivated patch set on the kernel-hardening mailing list to modernize the tasklet callback signature: the legacy API passes an `unsigned long data` to the callback, which the callback then casts back to whatever type it actually needs — no `container_of()`, no type checking, and, since `.func` and `.data` sit next to each other in `tasklet_struct`, a buffer overflow that reaches one can often overwrite the other, hijacking both the function pointer and its argument in one write. The fix — `DECLARE_TASKLET()`/`tasklet_setup()` passing the `tasklet_struct *` itself, the `from_tasklet()` pattern shown above — merged cleanly.

The discussion it provoked did not stay narrow. Peter Zijlstra used the thread to push for removing tasklets outright: *"I would _MUCH_ rather see tasklets go the way of the dodo [...] Can't we stage an extinction event here instead?"* Thomas Gleixner "grudgingly" acked the API-modernization patches while agreeing with the sentiment: *"I'd rather see tasklets vanish from the planet completely, but that's going to be a daring feat."* ([LWN](https://lwn.net/Articles/830964/)) Sebastian Andrzej Siewior suggested threaded IRQs as the direct replacement — the tasklet body moves essentially unchanged into the threaded handler's `thread_fn`, which runs in process context and can therefore do anything a tasklet's softirq-context body couldn't — while Dmitry Torokhov suggested immediately-expiring timers for other cases.

It's been a "daring feat" indeed. The same discussion surfaced two examples of why: the AMD `ccp` crypto driver combines tasklets with DMA-engine completion callbacks in ways that don't map cleanly onto a single replacement, and the Intel `i915` GPU driver used tasklets to schedule GPU command submission on a fast path where thread-wakeup latency mattered. Removal proceeded driver by driver and subsystem by subsystem for years — Takashi Iwai reported the sound subsystem's conversion ready around the same time — with no purpose-built mechanical replacement for the fast-path case Siewior's and Torokhov's suggestions didn't cover.

That gap is what `WQ_BH` closes. In February 2024, Linus Torvalds suggested a workqueue mode that runs a work item in atomic (softirq-like) context on the same CPU, without threading it — no scheduling latency, but still the modern workqueue API. Workqueue maintainer Tejun Heo built it as `WQ_BH`, merged for Linux 6.9 ([LWN](https://lwn.net/Articles/960041/)): a work item submitted to a `WQ_BH` workqueue runs quickly, in atomic context, on the same CPU it was queued from — as close to a drop-in tasklet replacement as the workqueue API has ever offered. Notably, `WQ_BH` work items are *themselves* run out of a tasklet internally, at least for now — Heo chose that specifically to avoid priority-inversion between `WQ_BH` items and the tasklets not yet converted, meaning the API can be deprecated in code while its own replacement still depends on it underneath. Siewior objected on the same RT grounds as before, preferring threaded IRQs or plain workqueues over anything backed by softirqs at all — the tension the 2019 thread surfaced hadn't gone away, it just moved to a new patch set. A bulk-conversion effort followed within weeks ([LWN](https://lwn.net/Articles/966894/), Allen Pais's `[PATCH 0/9] Convert Tasklets to BH Workqueues`), but with well over 500 tasklet users in the kernel at the time, the conversion is still ongoing rather than finished — as of current mainline, the tasklet API still exists and still has real users.

This isn't even the argument's first outing. [LWN covered](https://lwn.net/Articles/240054/) essentially the same removal proposal in 2007, when the case for it was interrupt latency (tasklets run in softirq context and can starve even the highest-priority task) and the case against it was performance for drivers needing a fast reaction — the same tension visible above, before threaded IRQs existed as an answer to it. What's different this time is that the alternative mechanisms (workqueues, threaded IRQs) now actually exist and are mature, which is why the 2019–2020 round produced an accepted deprecation notice where the 2007 round produced nothing.

**Practical reasons the deprecation stuck even without a removal date:**

- Softirq context means no sleeping, limited functionality
- Serialization is too coarse for modern hardware
- Workqueues and threaded IRQs provide the same properties with fewer sharp edges

New drivers should use `workqueue` (or `threaded IRQ`) instead of tasklets.

```c
/* Instead of tasklet, use work_struct */
struct my_device {
    struct work_struct rx_work;  /* instead of tasklet */
};

static void my_rx_work(struct work_struct *work)
{
    struct my_device *dev = container_of(work, struct my_device, rx_work);
    /* can sleep, take mutexes, etc. */
}

/* Schedule from IRQ handler */
schedule_work(&dev->rx_work);
```

## Observing tasklet activity

```bash
# Tasklet softirq counts
cat /proc/softirqs | grep -E "TASKLET|HI"
#     HI:        4        2        1        3
# TASKLET:    12345    12234    12123    12234

# High TASKLET counts indicate heavy tasklet usage
# Consider migrating to workqueues if causing scheduling issues
```

## Further reading

- [Softirqs](softirq.md) — What tasklets are built on
- [Workqueues](workqueues.md) — The recommended modern alternative
- [Threaded IRQs](threaded-irq.md) — Another modern alternative for driver IRQ handling
