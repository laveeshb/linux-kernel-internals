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
    void (*callback)(struct tasklet_struct *t);  /* modern API */
    unsigned long data;           /* legacy: passed to old-style func */
};
```

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

## Tasklets are deprecated for new code

Since Linux 5.14 (2021), tasklets are explicitly deprecated for new code [(LWN)](https://lwn.net/Articles/830964/). The reasons:
- Softirq context means no sleeping, limited functionality
- Serialization is too coarse for modern hardware
- Workqueues provide similar functionality with more flexibility

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
