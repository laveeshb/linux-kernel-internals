# Timekeeping and Clocksources

> How the kernel tracks time: TSC, HPET, clocksources, and NTP

## Two abstractions: clocksource and clockevent

The kernel splits time hardware into two roles:

| Abstraction | Role | Examples |
|-------------|------|---------|
| **clocksource** | Free-running counter to *read* elapsed time | TSC, HPET, ACPI PM timer |
| **clockevent** | Programmable device to *generate* interrupts at a future time | LAPIC timer, HPET, ARM generic timer |

A clocksource is polled; a clockevent fires interrupts. Both are needed: the clocksource provides nanosecond-resolution reads; the clockevent drives the scheduler tick and hrtimers.

## struct clocksource

```c
/* include/linux/clocksource.h */
struct clocksource {
    u64             (*read)(struct clocksource *cs);  /* read hardware counter */
    u64             mask;          /* bitmask for counter width */
    u32             mult;          /* counter→nanoseconds multiplier */
    u32             shift;         /* fractional shift for mult */
    u64             max_idle_ns;   /* max time without a read (for wrap detection) */
    u32             maxadj;        /* max adjustment to mult */
    u64             max_cycles;    /* max counter delta before overflow */
    const char     *name;
    int             rating;        /* quality: 1=bad, 100=good, 400=ideal (TSC) */
    /* ... */
};

/* TSC clocksource (arch/x86/kernel/tsc.c) */
static struct clocksource clocksource_tsc = {
    .name           = "tsc",
    .rating         = 300,
    .read           = read_tsc,   /* rdtsc */
    .mask           = CLOCKSOURCE_MASK(64),
    .flags          = CLOCK_SOURCE_IS_CONTINUOUS | CLOCK_SOURCE_MUST_VERIFY,
    /* mult/shift calibrated at boot */
};
```

### Counter → nanoseconds conversion

The `mult` and `shift` fields avoid division in the hot path:

```c
/*
 * ns = (cycles * mult) >> shift
 *
 * mult is computed so that:
 *   (10^9 * 2^shift) / frequency = mult
 */
static inline u64 clocksource_cyc2ns(u64 cycles, u32 mult, u32 shift)
{
    return ((u64) cycles * mult) >> shift;
}
```

For a 3.6 GHz TSC: `mult ≈ 1175`, `shift = 22`. Each call to `clock_gettime` does one `rdtsc` + one multiply + one shift — no division, no lock.

## struct timekeeper

The timekeeper holds the current time state and is updated on every tick and NTP adjustment:

```c
/* kernel/time/timekeeping.c */
struct timekeeper {
    struct tk_read_base  tkr_mono;   /* CLOCK_MONOTONIC */
    struct tk_read_base  tkr_raw;    /* CLOCK_MONOTONIC_RAW (no NTP) */

    u64                  xtime_sec;    /* seconds component of wall time */
    unsigned long        ktime_sec;    /* CLOCK_MONOTONIC seconds */

    struct timespec64    wall_to_monotonic; /* offset between REALTIME and MONOTONIC */
    ktime_t              offs_real;    /* offset: monotonic → realtime */
    ktime_t              offs_boot;    /* offset: monotonic → boottime (adds suspend time) */
    ktime_t              offs_tai;     /* offset: monotonic → TAI */

    s32                  tai_offset;   /* TAI - UTC (leap seconds) */
    unsigned int         clock_was_set_seq; /* incremented on settimeofday */
};

struct tk_read_base {
    struct clocksource  *clock;
    u64                  mask;
    u64                  cycle_last;   /* last read counter value */
    u64                  mult;         /* adjusted mult (NTP modifies this) */
    u32                  shift;
    u64                  xtime_nsec;   /* accumulated nanoseconds (fractional) */
    ktime_t              base;         /* nanoseconds base */
    u64                  base_real;
};
```

### Clock IDs

| Clock ID | Description | Affected by |
|----------|-------------|------------|
| `CLOCK_REALTIME` | Wall clock (UTC) | settimeofday, NTP jumps |
| `CLOCK_MONOTONIC` | Monotonically increasing from boot | NTP rate adjustment only; never jumps |
| `CLOCK_MONOTONIC_RAW` | Like MONOTONIC but no NTP adjustment | Nothing — pure hardware |
| `CLOCK_BOOTTIME` | Like MONOTONIC but includes suspend time | Nothing |
| `CLOCK_TAI` | International Atomic Time (no leap seconds) | Leap second offset only |
| `CLOCK_PROCESS_CPUTIME_ID` | Process CPU time | |
| `CLOCK_THREAD_CPUTIME_ID` | Thread CPU time | |

```c
struct timespec64 ts;
clock_gettime(CLOCK_MONOTONIC, &ts);  /* nanosecond precision */
clock_gettime(CLOCK_REALTIME, &ts);   /* wall clock */
```

## TSC: Time Stamp Counter

The TSC is the primary clocksource on x86. It's a 64-bit counter incremented every CPU cycle.

### TSC calibration

At boot, the kernel calibrates the TSC frequency against a known-good reference (HPET, PIT, or ACPI PM timer):

```c
/* arch/x86/kernel/tsc.c */
static unsigned long pit_calibrate_tsc(u32 latch, unsigned long ms, int loopmin)
{
    u64 tsc, t1, t2, delta;
    unsigned long tscmin, tscmax;

    /* Program PIT channel 2 for a known interval */
    outb((inb(0x61) & ~0x02) | 0x01, 0x61);

    /* Measure TSC ticks in that interval */
    t1 = get_cycles();
    /* ... wait for PIT ... */
    t2 = get_cycles();

    delta = t2 - t1;
    /* delta / ms = TSC frequency in kHz */
    return delta / ms;
}
```

### TSC invariance

Modern CPUs have an **invariant TSC** (`CPUID[0x80000007] bit 8`) that runs at a fixed rate regardless of P-states or C-states. This makes TSC a reliable clocksource even on laptops with frequency scaling.

```bash
# Check invariant TSC support
grep "constant_tsc nonstop_tsc" /proc/cpuinfo
```

Without invariant TSC, TSC drifts when the CPU frequency changes — unreliable for timekeeping.

## NTP: adjusting the clock

NTP runs in userspace (ntpd/chronyd) but applies corrections to the kernel clock via `adjtimex(2)`:

```c
/* Userspace NTP daemon calls: */
struct timex tx = {
    .modes  = ADJ_FREQUENCY | ADJ_OFFSET,
    .freq   = ppm_scaled,   /* frequency error in scaled PPM */
    .offset = offset_ns,    /* time offset in nanoseconds */
};
adjtimex(&tx);
```

The kernel applies the frequency correction by adjusting the clocksource `mult` value:

```
new_mult = orig_mult + (freq_error * orig_mult) / NSEC_PER_SEC
```

This makes the counter-to-nanosecond conversion run slightly faster or slower without any visible jumps.

### NTP phase-locked loop (PLL)

```c
/* kernel/time/ntp.c */
static void ntp_update_frequency(void)
{
    u64 second_length = (u64)(tick_usec * NSEC_PER_USEC * USER_HZ)
                        << NTP_SCALE_SHIFT;

    second_length += time_freq;   /* accumulated frequency correction */

    /* Adjust clocksource mult to correct rate */
    tick_length_base = second_length;
}
```

## vDSO: time without a syscall

`clock_gettime(CLOCK_MONOTONIC)` is the most-called libc function. The kernel optimizes it via the **vDSO** (virtual dynamic shared object) — a read-only page mapped into every process that contains the timekeeping fast path.

```c
/* lib/vdso/gettimeofday.c — runs in userspace without syscall */
static __always_inline int
do_hres(const struct vdso_data *vd, clockid_t clk, struct __kernel_timespec *ts)
{
    const struct vdso_timestamp *vdso_ts = &vd->basetime[clk];
    u64 cycles, last, sec, ns;
    u32 seq;

    do {
        /* Seqlock: read until consistent (no concurrent writer) */
        seq = vdso_read_begin(vd);

        /* Read hardware counter (userspace RDTSC or CNTVCT_EL0 on ARM) */
        cycles = vdso_read_counter(vd);

        /* cycles_since_last * mult >> shift = nanoseconds delta */
        ns  = vdso_ts->nsec;
        last = vd->cycle_last;
        ns += clocksource_delta(cycles, last, vd->mask) * vd->mult >> vd->shift;
        sec = vdso_ts->sec;
    } while (vdso_read_retry(vd, seq));

    ts->tv_sec  = sec;
    ts->tv_nsec = ns;
    return 0;
}
```

The vDSO page is updated by the kernel on every tick. User reads are entirely in userspace — no ring transitions, no TLB misses to kernel pages.

## Observing timekeeping

```bash
# Current clocksource and available alternatives
cat /sys/devices/system/clocksource/clocksource0/current_clocksource
cat /sys/devices/system/clocksource/clocksource0/available_clocksource

# Force a different clocksource (for testing/debugging)
echo hpet | sudo tee /sys/devices/system/clocksource/clocksource0/current_clocksource

# TSC frequency and stability
dmesg | grep -E "TSC|tsc"
# tsc: Detected 3600.000 MHz processor
# tsc: Detected 3600.000 MHz TSC
# clocksource: tsc: mask: 0xffffffffffffffff max_cycles: 0x...

# NTP synchronization status
timedatectl show | grep NTP
chronyc tracking

# Time namespace (containers may have their own offset)
# /proc/<pid>/timens_offsets shows MONOTONIC/BOOTTIME offsets

# Kernel time debugging
cat /proc/timer_list | head -50
```

## Further reading

- [hrtimers](hrtimers.md) — high-resolution timer implementation
- [POSIX timers](posix-timers.md) — timer_create, timerfd
- [System Calls: entry path](../syscalls/syscall-entry.md) — vDSO seqlock implementation
- [Scheduler: CFS](../sched/cfs.md) — scheduler tick drives timekeeping
- `kernel/time/timekeeping.c` — timekeeper implementation
- `arch/x86/kernel/tsc.c` — TSC clocksource
