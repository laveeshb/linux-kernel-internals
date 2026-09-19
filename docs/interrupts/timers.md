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

### The timer wheel, and why it was rebuilt in 2016

Timers are stored in a hierarchical array structure called the **timer wheel** — but the wheel in current kernels is not the one that shipped for most of Linux's history, and the difference is itself a "why" story worth knowing.

The original wheel indexed timers by the low 8 bits of `jiffies` (256 slots) at the finest level, with coarser levels above it. Every 256 jiffies, the kernel had to "cascade" a whole batch of timers down from the level above into individual finer-grained slots — an operation whose cost was, in Jonathan Corbet's words, "to a first approximation, unpredictable," it wasn't cache-friendly, and the design gave no cheap way to answer "when's the next thing that has to fire" without walking multiple levels ([LWN: Reinventing the timer wheel](https://lwn.net/Articles/646950/), June 2015). None of this mattered much when timers mostly just fired on schedule. It mattered a great deal once `NO_HZ` (tickless idle) made "how long can this CPU safely sleep" a question the scheduler needed answered cheaply and often.

Thomas Gleixner's rewrite, merged for **Linux 4.8** (2016) — confirmed absent in `kernel/time/timer.c` at v4.7, present at v4.8 — didn't just resize the levels, it removed cascading outright. The code's own comment is blunt about it: *"We don't have cascading anymore. timers with a expiry time above the capacity of the last wheel level are force expired at the maximum timeout value of the last wheel level."* A timer requesting more than the wheel's ~12-day maximum range no longer waits for cascading to eventually place it correctly — it's just clamped to fire at that maximum, on the (measured) assumption that nothing legitimate needs more precision than that at multi-day timescales. The level *sizing* changed too: the classic wheel's first level alone had 256 slots (`TVR_SIZE`, one jiffy each) with every level above it at 64 (`TVN_SIZE`); the rewrite made every level uniform at 64 slots (`LVL_SIZE`). At `HZ=1000`, the real current layout (`kernel/time/timer.c`) is:

```
Level 0:  64 slots × 1 ms granularity   → covers    0 ms –     63 ms
Level 1:  64 slots × 8 ms granularity   → covers   64 ms –    511 ms
Level 2:  64 slots × 64 ms granularity  → covers  512 ms –   4095 ms  (~4s)
Level 3:  64 slots × 512 ms granularity → covers 4096 ms –  32767 ms (~32s)
...continuing through Level 8 (HZ > 100 builds add a 9th level),
each level 8× coarser than the one below, up to roughly 12 days.
```

On each tick, the wheel simply advances and fires whatever's due in the current finest-grained slot — there's no cascade step left to run at all, which is the actual point of the rewrite, not a side effect of resizing the levels. `timer_list` remains the mechanism for **timeouts**: things the kernel expects to cancel before they fire (a missing I/O completion, a missing network ACK), where being a few milliseconds late doesn't matter and where cheap insertion/removal matters more than precision. That's a different job from hrtimer's, below — hrtimer is for things that are expected to actually run, on time.

## hrtimer: high-resolution timers

hrtimers were introduced in Linux 2.6.16 by Thomas Gleixner [(LWN)](https://lwn.net/Articles/167897/). They use `ktime_t` (nanosecond resolution) and a red-black tree ordered by expiry time. The closest expiry sets the hardware timer interrupt.

Before hrtimer existed as a unified subsystem, high-precision timing on Linux was a patchwork. Gleixner and Ingo Molnar's original design announcement — posted to LKML in September 2005 under the name "ktimers," before the "hrtimer" rename — opens by cataloguing what had accumulated instead of a single answer: UTIME (microsecond timers dating back to Linux 2.0, maintained separately by a Kansas University realtime research project, restricted to a handful of architectures), plus HRT, VST, DTCK, and NEWTOD — each solving one narrow piece (nanosleep here, POSIX interval timers there) for one or two architectures, none of them general. The announcement's own framing: *"All of those patches have one thing in common. They are restricted to a few architectures and address only single problems of timers and timekeeping."* ([lore.kernel.org, mirrored on LWN](https://lwn.net/Articles/152363/))

The proposal also names where the pressure to unify actually came from: *"The efforts to integrate the High Resolution Timer patches into the -rt tree gave a deep insight into the big picture and initiated the ktimers implementation."* Precise timing is a harder requirement for [PREEMPT_RT](../locking/preempt-rt.md) than for a general-purpose kernel — a realtime system that can only promise "sometime in the next 10ms" isn't realtime — so, as with threaded IRQs, the RT tree's needs forced the underlying question ("how does Linux represent a point in time precisely, uniformly, across architectures?") to actually get answered, rather than patched around one more time. `ktime_t` and the API shown below are that answer, merged into mainline as hrtimer for 2.6.16 after roughly six months of the design being reworked in public.

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
