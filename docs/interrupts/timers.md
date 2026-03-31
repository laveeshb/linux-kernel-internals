# Timers and hrtimers

> Scheduling kernel work at a specific time

## Two timer subsystems

The kernel has two independent timer mechanisms:

| | timer_list | hrtimer |
|---|-----------|---------|
| Resolution | jiffies (1ms–10ms) | nanoseconds |
| Data structure | hash table (timer wheel) | red-black tree |
| Callback context | softirq (TIMER_SOFTIRQ) | softirq or hardirq |
| Use for | Coarse timeouts, watchdogs | High-precision, audio/video, userspace sleep |

## timer_list: jiffies-based timers

`timer_list` is the traditional timer API. Timers expire on a jiffies boundary (typically 1ms–10ms depending on `HZ`).

```c
/* include/linux/timer.h */
struct timer_list {
    struct hlist_node entry;     /* timer wheel position */
    unsigned long expires;       /* expiry time in jiffies */
    void (*function)(struct timer_list *);
    u32 flags;
};
```

### API

```c
#include <linux/timer.h>

struct my_device {
    struct timer_list watchdog;
};

static void my_watchdog_handler(struct timer_list *t)
{
    struct my_device *dev = from_timer(dev, t, watchdog);
    /* runs in TIMER_SOFTIRQ context: no sleeping */
    if (device_stuck(dev))
        recover_device(dev);
    /* Restart timer */
    mod_timer(&dev->watchdog, jiffies + HZ * 5);  /* 5 seconds */
}

/* Initialize */
timer_setup(&dev->watchdog, my_watchdog_handler, 0);

/* Start timer: expire in 5 seconds */
mod_timer(&dev->watchdog, jiffies + HZ * 5);

/* Check if pending */
if (timer_pending(&dev->watchdog)) { ... }

/* Cancel (non-synchronous: may still fire) */
del_timer(&dev->watchdog);

/* Cancel and wait for in-flight handler to complete */
del_timer_sync(&dev->watchdog);

/* Restart timer to new expiry (or arm if not pending) */
mod_timer(&dev->watchdog, jiffies + HZ);
```

### Time conversion helpers

```c
jiffies + HZ           /* 1 second */
jiffies + HZ / 2       /* 500ms */
jiffies + msecs_to_jiffies(250)  /* 250ms */
jiffies + usecs_to_jiffies(500)  /* 500µs */

/* Remaining time */
long remaining = timer->expires - jiffies;
```

### The timer wheel

Timers are stored in a hierarchical hash table called the **timer wheel**. The wheel has multiple levels of 64 slots each, covering different time ranges:

```
Level 0: 64 slots × 1 jiffie   = 64 jiffies (~64ms at HZ=1000)
Level 1: 64 slots × 64 jiffies = ~4 seconds
Level 2: 64 slots × 4096 jiffies = ~4.5 minutes
Level 3: 64 slots × 262144 jiffies = ~4.8 hours
```

On each timer tick, the wheel advances. Timers in the current slot are fired. Timers at higher levels are "cascaded" down as needed.

## hrtimer: high-resolution timers

hrtimers use `ktime_t` (nanosecond resolution) and a red-black tree ordered by expiry time. The closest expiry sets the hardware timer interrupt.

```c
/* include/linux/hrtimer.h */
struct hrtimer {
    struct timerqueue_node node;   /* rb-tree node, stores expiry */
    ktime_t _softexpires;          /* earliest possible expiry */
    enum hrtimer_restart (*function)(struct hrtimer *);
    struct hrtimer_clock_base *base;
    u8 state;
    u8 is_rel;    /* relative time? */
    u8 is_soft;   /* softirq delivery? */
    u8 is_hard;   /* hardirq delivery? */
};
```

### API

```c
#include <linux/hrtimer.h>

struct my_device {
    struct hrtimer timer;
};

static enum hrtimer_restart my_hrtimer_handler(struct hrtimer *timer)
{
    struct my_device *dev = container_of(timer, struct my_device, timer);

    /* Process work */
    do_periodic_work(dev);

    /* Restart: advance by 10ms */
    hrtimer_forward_now(timer, ms_to_ktime(10));
    return HRTIMER_RESTART;

    /* Or: don't restart */
    /* return HRTIMER_NORESTART; */
}

/* Initialize */
hrtimer_setup(&dev->timer, my_hrtimer_handler,
              CLOCK_MONOTONIC, HRTIMER_MODE_REL);

/* Start: fire in 10ms */
hrtimer_start(&dev->timer, ms_to_ktime(10), HRTIMER_MODE_REL);

/* Start with absolute time */
hrtimer_start(&dev->timer, ktime_get() + ms_to_ktime(100),
              HRTIMER_MODE_ABS);

/* Cancel */
hrtimer_cancel(&dev->timer);         /* cancel, wait if firing */
hrtimer_try_to_cancel(&dev->timer);  /* cancel only if not firing */

/* Check if active */
if (hrtimer_active(&dev->timer)) { ... }
```

### Clock sources

```c
CLOCK_MONOTONIC     /* always-increasing, not affected by settimeofday */
CLOCK_REALTIME      /* wall-clock time, can jump */
CLOCK_BOOTTIME      /* like MONOTONIC but includes suspend time */
CLOCK_TAI           /* international atomic time */
```

Use `CLOCK_MONOTONIC` for most kernel timers. Use `CLOCK_REALTIME` only when the timer must track wall-clock time.

### Delivery modes

```c
/* Soft mode: callback in HRTIMER_SOFTIRQ (default on non-RT) */
HRTIMER_MODE_REL_SOFT

/* Hard mode: callback in hardirq context (lower latency, more restrictions) */
HRTIMER_MODE_REL_HARD

/* Pinned: timer stays on current CPU */
HRTIMER_MODE_REL_PINNED
```

## Userspace sleep: hrtimer under the hood

The kernel's `nanosleep()` syscall and `usleep()` in glibc are implemented via hrtimers. When a process calls `nanosleep(10ms)`:

1. `hrtimer_start()` arms a timer 10ms in the future
2. Process goes to `TASK_INTERRUPTIBLE` sleep
3. Timer fires → callback wakes the process
4. Process returns from `nanosleep()`

The precision of `usleep(1)` (1µs sleep) depends on whether `CONFIG_HIGH_RES_TIMERS` is set and whether the hardware supports high-resolution timer mode.

```bash
# Check if high-resolution timers are active
cat /sys/devices/system/clocksource/clocksource0/available_clocksource
# tsc hpet acpi_pm

# Current clocksource
cat /sys/devices/system/clocksource/clocksource0/current_clocksource
# tsc
```

## Further reading

- [Softirqs](softirq.md) — Where TIMER_SOFTIRQ and HRTIMER_SOFTIRQ run
- [Workqueues](workqueues.md) — For work deferred by a timer that needs to sleep
- `Documentation/timers/timers-howto.rst` — Which timer to use when
