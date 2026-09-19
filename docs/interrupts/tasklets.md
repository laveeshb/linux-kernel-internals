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

In 2019, Romain Perier — with Kees Cook involved from early on — posted a security-motivated patch set on the kernel-hardening mailing list to modernize the tasklet callback signature: the legacy API passes an `unsigned long data` to the callback, which the callback then casts back to whatever type it actually needs, with no `container_of()` and no type checking. The fix — `DECLARE_TASKLET()`/`tasklet_setup()` passing the `tasklet_struct *` itself, the `from_tasklet()` pattern shown above — eventually merged for 5.9, with Perier and Cook each landing commits in the final series ([LWN](https://lwn.net/Articles/830964/)).

The discussion it provoked did not stay narrow. Peter Zijlstra used the thread to push for removing tasklets outright: *"I would _MUCH_ rather see tasklets go the way of the dodo [...] Can't we stage an extinction event here instead?"* Thomas Gleixner "grudgingly" acked the API-modernization patches while agreeing with the sentiment: *"I'd rather see tasklets vanish from the planet completely, but that's going to be a daring feat."* ([LWN](https://lwn.net/Articles/830964/)) Sebastian Andrzej Siewior suggested threaded IRQs as one replacement — the tasklet body moves essentially unchanged into the threaded handler's `thread_fn`, which runs in process context and can therefore do anything a tasklet's softirq-context body couldn't — while Dmitry Torokhov suggested immediately-expiring timers for other cases.

It's been a "daring feat" indeed. The same discussion surfaced two examples of why: the AMD `ccp` crypto driver combines tasklets with DMA engines in ways that don't map cleanly onto a single replacement, and the Intel `i915` GPU driver schedules GPU tasks with tasklets on a path nobody wanted to touch without careful performance testing first. Removal proceeded driver by driver and subsystem by subsystem for years — Takashi Iwai reported the sound subsystem's conversion ready a few weeks later — with no purpose-built mechanical replacement for the fast-path case Siewior's and Torokhov's suggestions didn't cover.

That gap is what `WQ_BH` closes. In January 2024, replying to a proposed tasklet variant he disliked, Linus Torvalds suggested something more radical: *"look at introducing a 'low-latency atomic workqueue' that looks exactly like a regular workqueue, but has the rule that it's per-cpu and functions on it cannot sleep... I think if we introduced a workqueue that worked more like a tasklet — in that it's run in softirq context — but doesn't have the interface mistakes of tasklets, a number of existing workqueue users might decide that that is exactly what they want."* Workqueue maintainer Tejun Heo built it as `WQ_BH`, merged for Linux 6.9: a work item submitted to a `WQ_BH` workqueue runs quickly, in atomic (softirq) context, on the same CPU it was queued from — as close to a drop-in tasklet replacement as the workqueue API has offered. The version LWN covered at the time still ran `WQ_BH` work items out of a tasklet internally, specifically to avoid priority inversion against tasklets not yet converted ([LWN](https://lwn.net/Articles/960041/)) — a design Siewior objected to, preferring tasklet users move to threaded IRQs or regular workqueues instead, since neither depends on software interrupts staying around at all. Heo's answer was that neither of those helps the cases needing the shortest possible latency. By the version that actually merged, the implementation had changed to hook directly into the tasklet softirq's own action function rather than through a tasklet at all — cheaper, and closer to the eventual code structure once tasklets are gone entirely. A bulk-conversion effort followed within weeks ([LWN](https://lwn.net/Articles/966894/), Allen Pais's `[PATCH 0/9] Convert Tasklets to BH Workqueues`), but with well over 500 tasklet users in the kernel at the time, the conversion is still ongoing rather than finished — as of current mainline, the tasklet API still exists and still has real users.

This isn't even the argument's first outing. [LWN covered](https://lwn.net/Articles/239633/) essentially the same removal proposal in 2007: Steven Rostedt's patch tore out the tasklet implementation and replaced it with a compatibility wrapper backed by a workqueue underneath, so existing tasklet-using code wouldn't need to change. There was little opposition to eliminating tasklets themselves — the interrupt-latency argument above was already well understood — but "almost nobody" liked the wrapper itself, since compatibility shims that hide one mechanism behind another are exactly what the kernel's "no stable internal API" norm tries to avoid. That left converting every tasklet user directly to workqueues as the real alternative, a much bigger job nobody took on at the time, which is likely why that round produced nothing. What's different in the 2019–2020 and 2024 rounds is that direct, mechanical alternatives — first threaded IRQs and workqueues, then `WQ_BH` specifically — actually exist and are mature, rather than a wrapper standing in for conversion work nobody had done yet.

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
