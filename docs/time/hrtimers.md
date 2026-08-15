# hrtimers

> High-resolution timers: nanosecond-precision kernel timers

## The two timer systems

Linux has two timer implementations:

| System | Precision | Data structure | Typical use |
|--------|-----------|---------------|-------------|
| **timer_list** (classic) | ~1/HZ (1–10ms) | Per-CPU hashed wheels | Timeout detection, network retransmit |
| **hrtimer** | ~nanosecond | Per-CPU red-black tree | sleep(), audio, network pacing, real-time |

The classic wheel is O(1) but coarse. hrtimers use a sorted red-black tree; the soonest expiry is at the tree minimum and programs the hardware clockevent directly.

## struct hrtimer

```c
/* include/linux/hrtimer_types.h */
struct hrtimer {
    struct timerqueue_linked_node node;
    struct hrtimer_clock_base   *base;
    bool                        is_queued;
    bool                        is_rel;
    bool                        is_soft;
    bool                        is_hard;
    bool                        is_lazy;
    ktime_t                     _softexpires; /* earliest expiry */
    enum hrtimer_restart      (*__private function)(struct hrtimer *); /* callback */
};

```

## Clock bases

Each CPU has separate timer queues per clock ID:

```c
/* HRTIMER_BASE_* indices into hrtimer_cpu_base.clock_base[] */
HRTIMER_BASE_MONOTONIC        /* CLOCK_MONOTONIC */
HRTIMER_BASE_REALTIME         /* CLOCK_REALTIME */
HRTIMER_BASE_BOOTTIME         /* CLOCK_BOOTTIME (includes suspend) */
HRTIMER_BASE_TAI              /* CLOCK_TAI */
HRTIMER_BASE_MONOTONIC_SOFT   /* CLOCK_MONOTONIC, softirq delivery */
HRTIMER_BASE_REALTIME_SOFT    /* CLOCK_REALTIME, softirq delivery */
HRTIMER_BASE_BOOTTIME_SOFT    /* CLOCK_BOOTTIME, softirq delivery */
HRTIMER_BASE_TAI_SOFT         /* CLOCK_TAI, softirq delivery */
```

Hard delivery timers fire directly in the hardirq context of the clockevent interrupt (lowest latency); soft delivery timers fire in softirq context (slightly higher latency but avoids running at hard-IRQ level).

## Using hrtimers

### Kernel driver example

```c
#include <linux/hrtimer.h>
#include <linux/ktime.h>

struct mydev {
    struct hrtimer poll_timer;
    /* ... */
};

/* Callback: called when timer fires */
static enum hrtimer_restart mydev_timer_cb(struct hrtimer *timer)
{
    struct mydev *dev = container_of(timer, struct mydev, poll_timer);

    /* Do work */
    mydev_poll(dev);

    /* Rearm for 10ms from now */
    hrtimer_forward_now(timer, ms_to_ktime(10));
    return HRTIMER_RESTART;  /* reschedule */

    /* Or: return HRTIMER_NORESTART to stop */
}

static int mydev_probe(struct platform_device *pdev)
{
    struct mydev *dev = devm_kzalloc(&pdev->dev, sizeof(*dev), GFP_KERNEL);

    /* Initialize timer and set callback function */
    hrtimer_setup(&dev->poll_timer, mydev_timer_cb, CLOCK_MONOTONIC, HRTIMER_MODE_REL);

    /* Start: fire 10ms from now */
    hrtimer_start(&dev->poll_timer, ms_to_ktime(10), HRTIMER_MODE_REL);

    return 0;
}

static void mydev_remove(struct platform_device *pdev)
{
    struct mydev *dev = platform_get_drvdata(pdev);
    hrtimer_cancel(&dev->poll_timer);  /* cancel and wait for callback */
}
```

### Timer modes

```c
/* Absolute: fire at specific time */
hrtimer_start(&timer, ktime_set(1735689600, 0), HRTIMER_MODE_ABS);

/* Relative: fire N nanoseconds from now */
hrtimer_start(&timer, ns_to_ktime(5000000), HRTIMER_MODE_REL);

/* Pinned to current CPU (don't migrate on CPU hotplug) */
hrtimer_start(&timer, ns_to_ktime(5000000), HRTIMER_MODE_REL_PINNED);

/* Soft (softirq context): */
hrtimer_start(&timer, ns_to_ktime(5000000), HRTIMER_MODE_REL_SOFT);
```

## High-resolution mode

On boot, the kernel operates in **low-resolution mode** where timer interrupts fire at HZ rate (100–1000/s). When the first hrtimer device is detected, the system switches to **high-resolution mode**:

```c
/* kernel/time/hrtimer.c */
static void hrtimer_switch_to_hres(void)
{
    struct hrtimer_cpu_base *base = this_cpu_ptr(&hrtimer_bases);

    if (tick_init_highres()) {
        pr_warn("Could not switch to high resolution mode on CPU %u\n", base->cpu);
        return;
    }
    base->hres_active = true;
    hrtimer_resolution = HIGH_RES_NSEC;

    tick_setup_sched_timer(true);
    /* "Retrigger" the interrupt to get things going */
    retrigger_next_event(NULL);
    hrtimer_schedule_hres_work();
}
```

After switching:
- The scheduler tick is implemented via an hrtimer (no longer a fixed-rate interrupt)
- Timer resolution is limited only by hardware latency (~100ns typical)
- `NOHZ` (tickless idle) can skip ticks entirely when CPU is idle

```bash
dmesg | grep "high resolution"
# Switched to high resolution mode on CPU 0
```

## NOHZ: tickless operation

With `CONFIG_NO_HZ_IDLE` (default), when all runqueue tasks sleep and no hrtimers are pending soon, the tick stops entirely:

```
CPU goes idle:
  1. Calculate next hrtimer expiry
  2. Program clockevent for that time
  3. Enter C-state
  4. Wake on clockevent (or external IRQ)
  5. Process any expired hrtimers
  6. Resume scheduler
```

With `CONFIG_NO_HZ_FULL` (for real-time/HPC), ticks also stop for CPUs with only one running task — eliminating ~1000 interrupts/second of OS noise.

```bash
# Check NOHZ status
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/name
dmesg | grep nohz

# See idle time per CPU
cat /proc/stat | awk 'NR>1 && /cpu[0-9]/ {print $1, "idle:", $5}'
```

## Timer slack

`nanosleep` and similar calls can be coalesced with nearby wakeups to reduce power consumption. The kernel applies a **slack** — allowed slippage past the requested time:

```c
/* Userspace: set timer slack for current thread */
prctl(PR_SET_TIMERSLACK, 50000 /* ns */);

/* In kernel: clock_nanosleep honors slack */
hrtimer_sleeper_start_expires(&t, HRTIMER_MODE_ABS | HRTIMER_MODE_SOFT);
```

The default slack is a fixed constant (`.timer_slack_ns = 50000` in `init/init_task.c`), equating to 50µs. Setting slack=0 disables coalescing — useful for real-time tasks that need precise wakeup.

```bash
# View timer slack for a process
cat /proc/<pid>/timerslack_ns
```

## hrtimer vs timer_list

When to use each:

| Use case | Use |
|----------|-----|
| Timeouts (network, locks, wait_for_completion) | `timer_list` — cheaper, less precision needed |
| Periodic work with precise interval | `hrtimer` |
| `schedule_timeout` / `msleep` | `timer_list` — `msleep` calls `schedule_timeout` which uses the timer wheel |
| Real-time audio/video pacing | `hrtimer` with `HRTIMER_MODE_ABS` |
| Watchdog timers | `timer_list` |

## Observing hrtimers

```bash
# All active hrtimers in the system
cat /proc/timer_list

# hrtimer interrupt latency (how late timers fire)
# Use cyclictest for real-time latency measurement
cyclictest -p 99 -t 1 -m -n

# perf: timer events
perf stat -e hrtimer:hrtimer_start,hrtimer:hrtimer_expire_entry sleep 5

# Trace hrtimer activity
echo 1 > /sys/kernel/tracing/events/timer/hrtimer_start/enable
echo 1 > /sys/kernel/tracing/events/timer/hrtimer_expire_entry/enable
cat /sys/kernel/tracing/trace_pipe
# kworker/0:1 [000] hrtimer_start: hrtimer=0xffff... function=tick_sched_timer expires=...
```

## Further reading

### Kernel source

- [include/linux/hrtimer.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/hrtimer.h) — public hrtimer API: `hrtimer_setup()`, `hrtimer_start()`, `hrtimer_cancel()`, and `hrtimer_forward_now()`
- [include/linux/hrtimer_defs.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/hrtimer_defs.h) — definitions of `struct hrtimer`, `struct hrtimer_cpu_base`, and the `HRTIMER_MODE_*` flags
- [kernel/time/hrtimer.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/hrtimer.c) — high-resolution timer queue management, `hrtimer_switch_to_hres()`, and red-black tree expiry processing
- [kernel/time/tick-sched.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/tick-sched.c) — scheduler tick emulation via `sched_timer` hrtimer and NOHZ idle/full tick suppression
- [lib/timerqueue.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/timerqueue.c) — augmented red-black tree operations (`timerqueue_add()`, `timerqueue_del()`) keeping the earliest timer cached

### Man pages

- [`nanosleep(2)`](https://man7.org/linux/man-pages/man2/nanosleep.2.html) — high-resolution sleep syscall implemented on top of kernel hrtimers
- [`clock_nanosleep(2)`](https://man7.org/linux/man-pages/man2/clock_nanosleep.2.html) — clock-selectable sleep supporting `TIMER_ABSTIME` and timer slack coalescing
- [`prctl(2)`](https://man7.org/linux/man-pages/man2/prctl.2.html) — `PR_SET_TIMERSLACK` and `PR_GET_TIMERSLACK` for configuring per-thread timer coalescing slack

### Related pages

- [Timekeeping and Clocksources](timekeeping.md) — timekeeping architecture, clock IDs, and time offset conversions
- [POSIX Timers and timerfd](posix-timers.md) — user-space timer APIs (`timer_create()`, `timerfd`) backed by kernel hrtimers
- [The Timer Wheel](timer-wheel.md) — low-resolution `timer_list` wheel comparison and selection guide
- [EEVDF Scheduler](../sched/eevdf.md) — CPU scheduler tick driven by an hrtimer in high-resolution mode

### LWN articles

- [High-resolution timers](https://lwn.net/Articles/167897/) — Jonathan Corbet, January 2006: the design and integration of Thomas Gleixner's hrtimer subsystem
- [hrtimer: Provide softirq context hrtimers](https://lwn.net/Articles/732536/) — Anna-Maria Gleixner, Aug 31, 2017: splitting hardirq vs softirq timer expiry handling for low-latency RT safety

### External

- [Timekeeping and Timers in Linux](https://docs.kernel.org/core-api/timekeeping.html) — core API documentation for the kernel timekeeping and timer infrastructure
- [High-resolution timers subsystem](https://docs.kernel.org/timers/hrtimers.html) — design documentation and architecture of high-resolution timer queues
