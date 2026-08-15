# Clocksource and Clockevent Drivers

> Hardware timers in the kernel: TSC, HPET, clockevents, and tick_device

## Two clock abstractions

The kernel separates time into two concepts:

```
clocksource:   reads current time (monotonic counter)
               "What time is it right now?"
               Example: TSC counter, HPET counter

clockevent:    programs a future interrupt (one-shot or periodic)
               "Wake me up in N nanoseconds"
               Example: Local APIC timer, HPET, ARM generic timer
```

Together they implement the kernel's timekeeping:

```
clocksource  →  timekeeping (clock_gettime, ktime_get)
clockevent   →  tick device  →  scheduler tick, hrtimers, timers
```

## struct clocksource

```c
/* include/linux/clocksource.h */
struct clocksource {
    u64             (*read)(struct clocksource *cs);
    u64             mask;          /* bitmask to handle counter wrap */
    u32             mult;          /* cycles to ns: ns = cycles * mult >> shift */
    u32             shift;
    u64             max_idle_ns;   /* max time between reads before losing accuracy */
    u32             maxadj;
    u64             max_cycles;    /* max cycles before ns calculation overflows */
    u64             max_raw_delta;
    const char      *name;
    struct list_head list;
    u32             freq_khz;
    int             rating;        /* quality: 500=perfect, 300=good, 100=basic */
    enum clocksource_ids id;
    enum vdso_clock_mode vdso_clock_mode;
    unsigned long   flags;
    struct clocksource_base *base;

    u64             (*read_snapshot)(struct clocksource *cs, struct clocksource_hw_snapshot *chs);
    int             (*enable)(struct clocksource *cs);
    void            (*disable)(struct clocksource *cs);
    void            (*suspend)(struct clocksource *cs);
    void            (*resume)(struct clocksource *cs);
    void            (*mark_unstable)(struct clocksource *cs);
    void            (*tick_stable)(struct clocksource *cs);
};
```

## TSC (Time Stamp Counter)

The TSC is the primary clocksource on modern x86:

```c
/* arch/x86/kernel/tsc.c */
static struct clocksource clocksource_tsc = {
    .name                   = "tsc",
    .rating                 = 300,
    .read                   = read_tsc,
    .mask                   = CLOCKSOURCE_MASK(64),
    .flags                  = CLOCK_SOURCE_IS_CONTINUOUS |
                              CLOCK_SOURCE_CAN_INLINE_READ |
                              CLOCK_SOURCE_MUST_VERIFY |
                              CLOCK_SOURCE_HAS_COUPLED_CLOCK_EVENT,
    .id                     = CSID_X86_TSC,
    .vdso_clock_mode        = VDSO_CLOCKMODE_TSC,
    .enable                 = tsc_cs_enable,
    .resume                 = tsc_resume,
    .mark_unstable          = tsc_cs_mark_unstable,
    .tick_stable            = tsc_cs_tick_stable,
};

static u64 read_tsc(struct clocksource *cs)
{
    return (u64)rdtsc_ordered();  /* RDTSC instruction */
}

/* Convert TSC cycles to nanoseconds: */
/* ns = (cycles * mult) >> shift */
/* mult and shift are calibrated at boot against HPET or PIT */
```

```bash
# Check the current clocksource:
cat /sys/devices/system/clocksource/clocksource0/current_clocksource
# tsc

# Available clocksources (sorted by preference):
cat /sys/devices/system/clocksource/clocksource0/available_clocksource
# tsc hpet acpi_pm

# TSC frequency:
dmesg | grep "tsc: Detected"
# tsc: Detected 3600.000 MHz processor

# TSC stability:
dmesg | grep tsc | grep -i "unstable\|skew\|reliable"
```

### TSC reliability issues

```bash
# TSC may be unreliable:
# 1. Old multi-socket systems: TSCs not synchronized between sockets
# 2. CPU frequency scaling: TSC rate changes with frequency (older CPUs)
# 3. Virtualization: hypervisor may not provide stable TSC

# Modern CPUs have invariant TSC (constant rate regardless of P-state):
grep "constant_tsc\|nonstop_tsc" /proc/cpuinfo | head -2
# flags: ... constant_tsc nonstop_tsc ...

# Force a different clocksource:
echo hpet > /sys/devices/system/clocksource/clocksource0/current_clocksource
```

## Registering a clocksource

```c
/* For a custom hardware counter (e.g., in a SoC driver): */
#include <linux/clocksource.h>

static u64 my_timer_read(struct clocksource *cs)
{
    return readl(my_timer_base + TIMER_COUNT_REG);
}

static struct clocksource my_clocksource = {
    .name    = "my-hw-timer",
    .rating  = 200,
    .read    = my_timer_read,
    .mask    = CLOCKSOURCE_MASK(32),
    .flags   = CLOCK_SOURCE_IS_CONTINUOUS,
};

/* In probe(): */
clocksource_register_hz(&my_clocksource, 24000000); /* 24 MHz */
/* Computes mult/shift from frequency */
```

## struct clock_event_device

```c
/* include/linux/clockchips.h */
struct clock_event_device {
    void (*event_handler)(struct clock_event_device *);
    /* Called on each timer interrupt (set by tick layer) */

    int  (*set_next_event)(unsigned long evt,
                           struct clock_event_device *);
    /* Program the hardware to fire in `evt` cycles */

    int  (*set_next_ktime)(ktime_t expires,
                           struct clock_event_device *);

    ktime_t             next_event;
    u64                 max_delta_ns;
    u64                 min_delta_ns;
    u32                 mult;
    u32                 shift;

    enum clock_event_state  state_use_accessors;
    unsigned int        features;
    /* CLOCK_EVT_FEAT_PERIODIC: supports periodic mode */
    /* CLOCK_EVT_FEAT_ONESHOT:  supports one-shot mode */
    /* CLOCK_EVT_FEAT_C3STOP:   stops in deep idle */

    const char          *name;
    int                 rating;
    int                 irq;
    int                 bound_on;
    const struct cpumask *cpumask;
    struct list_head    list;
};
```

## Local APIC timer (per-CPU clockevent)

```c
/* arch/x86/kernel/apic/apic.c */
static struct clock_event_device lapic_clockevent = {
    .name                   = "lapic",
    .features               = CLOCK_EVT_FEAT_PERIODIC |
                              CLOCK_EVT_FEAT_ONESHOT  |
                              CLOCK_EVT_FEAT_C3STOP   |
                              CLOCK_EVT_FEAT_DUMMY,
    .shift                  = 32,
    .set_state_shutdown     = lapic_timer_shutdown,
    .set_state_periodic     = lapic_timer_set_periodic,
    .set_state_oneshot      = lapic_timer_set_oneshot,
    .set_next_event         = lapic_next_event,
    .broadcast              = lapic_timer_broadcast,
    .rating                 = 100,
    .irq                    = -1,
};

static int lapic_next_event(unsigned long delta,
                             struct clock_event_device *evt)
{
    /* Program the APIC timer to fire in `delta` cycles */
    apic_write(APIC_TMICT, delta);
    return 0;
}
```

## tick device and NOHZ

Each CPU has a **tick device** — the clockevent used for the scheduling tick:

```c
/* kernel/time/tick-common.c */
struct tick_device {
    struct clock_event_device *evtdev;
    enum tick_device_mode      mode;  /* TICKDEV_MODE_PERIODIC or ONESHOT */
};

DEFINE_PER_CPU(struct tick_device, tick_cpu_device);
```

```bash
# In periodic mode: tick fires every 1/HZ seconds (HZ=250 → 4ms)
grep "^CONFIG_HZ=" /boot/config-$(uname -r)
# CONFIG_HZ=250

# In NOHZ (tickless) mode: tick is suppressed when CPU is idle
# Reduces power consumption and improves real-time latency

# Check NOHZ mode:
cat /sys/kernel/debug/sched/domains/cpu0/domain0/stats
# or:
cat /proc/timer_list | grep "Tick Device" | head -5

# NOHZ_FULL (adaptive tick): suppress tick even when running
# Requires: isolcpus + nohz_full= boot params (for RT/HPC)
```

## Timekeeping: clocksource → wall clock

```c
/* include/linux/timekeeper_internal.h */
struct timekeeper {
    struct tk_read_base     tkr_mono;   /* monotonic clock */
    struct tk_read_base     tkr_raw;    /* raw hardware clock */

    u64                     xtime_sec;  /* real wall-clock seconds */
    unsigned long           ktime_sec;  /* monotonic seconds */
    struct timespec64       wall_to_monotonic; /* offset */
    ktime_t                 offs_real;  /* monotonic → realtime offset */
    ktime_t                 offs_boot;  /* boot time offset */
    ktime_t                 offs_tai;   /* TAI offset */

    s32                     tai_offset; /* TAI - UTC in seconds */
    unsigned int            clock_was_set_seq;
    u8                      cs_was_changed_seq;
    ktime_t                 next_leap_ktime;
};

/* Reading current time (seqcount protects against concurrent updates): */
/* kernel/time/timekeeping.c */
ktime_t ktime_get(void)
{
    struct timekeeper *tk = &tk_core.timekeeper;
    unsigned int seq;
    ktime_t base;
    u64 nsecs;

    do {
        seq = read_seqcount_begin(&tk_core.seq);
        base  = tk->tkr_mono.base;
        nsecs = timekeeping_get_ns(&tk->tkr_mono);
    } while (read_seqcount_retry(&tk_core.seq, seq));

    return ktime_add_ns(base, nsecs);
}
```

## Observing timekeeping

```bash
# Current time sources and offsets:
cat /proc/timer_list

# NTP synchronization:
timedatectl status
# System clock synchronized: yes
# NTP service: active
# RTC in local TZ: no

# Clock error estimation (NTP):
adjtimex -p | grep -E "offset|freq|error"

# High-resolution timer benchmark:
cyclictest -n -m -p99 -i200 -l1000000
# Tests: time from sleep request to actual wakeup (uses hrtimer)

# TSC vs HPET accuracy comparison:
bpftrace -e '
BEGIN { @start = nsecs; }
interval:s:1 {
    printf("elapsed: %lld ns\n", nsecs - @start);
    @start = nsecs;
}'
```

## Further reading

### Kernel source

- [include/linux/clocksource.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/clocksource.h) — definition of `struct clocksource`, the `CLOCK_SOURCE_*` flags, and frequency-to-mult/shift conversion helpers
- [include/linux/clockchips.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/clockchips.h) — `struct clock_event_device`, `CLOCK_EVT_FEAT_*` feature flags, and clockevent state accessors
- [kernel/time/clocksource.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/clocksource.c) — clocksource registration, rating-based selection, and the `clocksource_watchdog()` stability verification framework
- [kernel/time/clockevents.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/clockevents.c) — clockevent programming, event handler dispatch, and clockevent device registration
- [kernel/time/tick-common.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/tick-common.c) — per-CPU `struct tick_device`, periodic tick setup, and the interface between clockevents and scheduler ticks
- [arch/x86/kernel/tsc.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/tsc.c) — `clocksource_tsc`, early boot calibration against PIT/HPET, and runtime instability detection
- [arch/x86/kernel/apic/apic.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/apic/apic.c) — `lapic_clockevent`, local APIC timer programming via `APIC_TMICT`, and broadcast handling

### Man pages

- [`clock_gettime(2)`](https://man7.org/linux/man-pages/man2/clock_gettime.2.html) — POSIX system call and vDSO fast-path for reading hardware clocksources
- [`adjtimex(2)`](https://man7.org/linux/man-pages/man2/adjtimex.2.html) — kernel clock discipline interface for tuning frequency and phase offsets

### Related pages

- [High-Resolution Timers (hrtimers)](hrtimers.md) — high-resolution timers and scheduler tick emulation built on clockevents
- [Timekeeping and Clocksources](timekeeping.md) — timekeeper architecture, `ktime_get()`, and wall-clock offsets
- [POSIX Timers and timerfd](posix-timers.md) — user-facing timer interfaces backed by clockevents and hrtimers
- [CPU Idle and C-States](../power/cpuidle.md) — dynamic tick suppression and `CLOCK_EVT_FEAT_C3STOP` broadcast timer management
- [Real-Time Tuning](../sched/rt-tuning.md) — isolated CPUs and full tickless (`nohz_full`) operation for low-latency workloads

### LWN articles

- [High-resolution timers and dynamic ticks](https://lwn.net/Articles/209101/) — Jonathan Corbet, November 2006: the architectural introduction of the clocksource and clockevent abstractions
- [Preventing clocksource watchdog false positives](https://lwn.net/Articles/858829/) — Jonathan Corbet, June 2021: improving clocksource watchdog reliability under high virtualization and bus load

### External

- [Timekeeping and Timers in Linux](https://docs.kernel.org/core-api/timekeeping.html) — upstream kernel documentation covering the clocksource, clockevent, and timekeeper subsystems
- [The kernel's command-line parameters](https://docs.kernel.org/admin-guide/kernel-parameters.html) — boot-time clock options: `clocksource=`, `tsc=reliable`, `nohz=`, and `nohz_full=`
