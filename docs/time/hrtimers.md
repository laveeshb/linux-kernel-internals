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
/* include/linux/hrtimer.h */
struct hrtimer {
    struct timerqueue_node  node;     /* rb_node + expiry time */
    ktime_t                 _softexpires; /* earliest expiry */
    enum hrtimer_restart  (*function)(struct hrtimer *); /* callback */
    struct hrtimer_clock_base *base;  /* clock base this timer belongs to */
    u8                      state;    /* HRTIMER_STATE_INACTIVE/ENQUEUED */
    u8                      is_rel;   /* relative timer? */
    u8                      is_soft;  /* softirq delivery? */
    u8                      is_hard;  /* hardirq delivery? */
};

struct hrtimer_cpu_base {
    raw_spinlock_t           lock;
    unsigned int             cpu;
    unsigned int             active_bases;  /* bitmask of active clock bases */
    unsigned int             clock_was_set_seq;
    unsigned int             hres_active:1; /* high-res mode enabled */
    ktime_t                  expires_next;  /* next clockevent expiry */
    struct hrtimer          *running;       /* currently executing timer */
    struct hrtimer_clock_base clock_base[HRTIMER_MAX_CLOCK_BASES];
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

    /* Initialize timer (does not start it) */
    hrtimer_init(&dev->poll_timer, CLOCK_MONOTONIC, HRTIMER_MODE_REL);
    dev->poll_timer.function = mydev_timer_cb;

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
    if (tick_init_highres()) {
        pr_warn("Could not switch to high resolution mode on CPU %d\n",
                smp_processor_id());
        return;
    }
    /* Reprogram clockevent to fire at exact timer expiry */
    __hrtimer_run_queues(base, now, flags, HRTIMER_ACTIVE_HARD);
    tick_setup_sched_timer();
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

The default slack is `CONFIG_HZ`-dependent (typically ~50µs). Setting slack=0 disables coalescing — useful for real-time tasks that need precise wakeup.

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

- [Timekeeping](timekeeping.md) — clocksources, NTP, vDSO
- [POSIX timers](posix-timers.md) — user-facing timer APIs
- [Interrupts: Timers](../interrupts/timers.md) — timer_list wheel and workqueue timers
- [Scheduler: EEVDF](../sched/eevdf.md) — scheduler tick via hrtimer
- `kernel/time/hrtimer.c` — hrtimer implementation
