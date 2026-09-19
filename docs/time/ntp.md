# NTP and Clock Discipline

> How the kernel adjusts the clock: adjtimex, PLL/FLL, and TAI offset

## The problem

A hardware oscillator drifts. Without correction, the system clock deviates from UTC by seconds per day. The goal of clock discipline is to steer the clock toward an external reference (GPS, NTP server, PPS signal) continuously and smoothly, without stepping the clock backwards or creating discontinuities that confuse applications.

The Linux kernel implements this through a control loop in `kernel/time/ntp.c`, driven by `adjtimex()` calls from userspace daemons (`ntpd`, `chrony`).

## PLL and FLL modes

The kernel supports two adjustment strategies:

**Phase-locked loop (PLL)** — The daemon measures the offset between local time and the reference, then asks the kernel to make small, continuous frequency adjustments to steer the clock toward zero offset. The correction is proportional to the measured offset, clamped to `±MAXPHASE` (500 ms) before it's applied (`ntp_update_offset()`, `kernel/time/ntp.c`) regardless of which mode is active — that clamp isn't what selects PLL over FLL. This is the steady-state mode for a well-synchronized clock, used whenever updates arrive frequently enough (within `MAXSEC` of each other) and `STA_FLL` isn't set.

**Frequency-locked loop (FLL)** — Used when the offset is large or when the clock has not been synchronized for a long time. The kernel adjusts frequency more aggressively based on the rate at which the offset is changing rather than the offset itself. The kernel switches into FLL correction (`ntp_update_offset_fll()`) either because the daemon explicitly sets the `STA_FLL` status flag, or because too much time (`MAXSEC`) has passed since the last update for pure PLL correction to make sense.

The daemon selects the mode by setting `STA_PLL` or `STA_FLL` (or both) in `timex.status` when calling `adjtimex()`.

## adjtimex()

`adjtimex()` is the kernel's time discipline interface. The syscall entry point (`SYSCALL_DEFINE1(adjtimex, ...)`) and its underlying `do_adjtimex()` live in `kernel/time/time.c` and `kernel/time/timekeeping.c` respectively; `kernel/time/ntp.c` holds the PLL/FLL math itself (`ntp_adjtimex()`, `ntp_update_frequency()`) that `do_adjtimex()` calls into:

```c
int adjtimex(struct timex *txc);
```

That's the glibc-facing prototype; the actual syscall (`SYSCALL_DEFINE1(adjtimex, struct __kernel_timex __user *, txc_p)`) takes `struct __kernel_timex`, a separate, architecture-independent layout `include/uapi/linux/timex.h` defines outside the `#ifndef __KERNEL__` block that hides `struct timex` from the kernel. It's not just a renamed copy: every field is a fixed `long long` (rather than the architecture-dependent `__kernel_long_t` glibc's `struct timex` uses) with explicit padding to keep them aligned the same way on 32- and 64-bit builds, and its embedded `struct __kernel_timex_timeval` uses a 64-bit, Y2038-safe `tv_sec`. glibc's wrapper translates its own `struct timex` into this shape before making the syscall.

The `struct timex` (defined in `include/uapi/linux/timex.h`):

```c
struct timex {
    unsigned int modes;          /* ADJ_OFFSET, ADJ_FREQUENCY, ADJ_MAXERROR,
                                    ADJ_ESTERROR, ADJ_STATUS, ADJ_TIMECONST,
                                    ADJ_TAI, ADJ_SETOFFSET, ADJ_NANO, ... */
    __kernel_long_t offset;      /* time offset (ns if STA_NANO set, else us) */
    __kernel_long_t freq;        /* frequency offset (scaled ppm: ppm * 2^16) */
    __kernel_long_t maxerror;    /* maximum error estimate (us) */
    __kernel_long_t esterror;    /* estimated error (us) */
    int  status;                 /* STA_PLL, STA_FLL, STA_NANO, STA_UNSYNC,
                                    STA_INS, STA_DEL, STA_PPSFREQ, STA_PPSTIME,
                                    STA_PPSJITTER, STA_PPSWANDER, STA_PPSERROR,
                                    STA_CLOCKERR, ... */
    __kernel_long_t constant;    /* PLL time constant (log2 of poll interval) */
    __kernel_long_t precision;   /* clock precision (us, read-only) */
    __kernel_long_t tolerance;   /* clock frequency tolerance (read-only) */
    struct timeval time;         /* current time (read-only) */
    __kernel_long_t tick;        /* us between clock ticks */
    __kernel_long_t ppsfreq;     /* PPS frequency (read-only, scaled ppm) */
    __kernel_long_t jitter;      /* PPS jitter (read-only, ns or us) */
    int  shift;                  /* PPS interval duration (seconds, read-only) */
    __kernel_long_t stabil;      /* PPS stability (read-only, scaled ppm) */
    __kernel_long_t jitcnt;      /* PPS jitter exceeded limit count (read-only) */
    __kernel_long_t calcnt;      /* PPS calibration intervals (read-only) */
    __kernel_long_t errcnt;      /* PPS calibration errors (read-only) */
    __kernel_long_t stbcnt;      /* PPS stability exceeded limit count (read-only) */
    int  tai;                    /* TAI - UTC offset in seconds (read-only unless
                                    ADJ_TAI is set in modes) */

    int :32; int :32; int :32; int :32;  /* reserved padding, for future use */
    int :32; int :32; int :32; int :32;
    int :32; int :32; int :32;
};
```

Important `modes` flags:

| Flag | Effect |
|------|--------|
| `ADJ_OFFSET` | Apply `offset` as a phase correction |
| `ADJ_FREQUENCY` | Set `freq` (frequency offset in ppm × 2^16) |
| `ADJ_STATUS` | Update `status` flags (STA_PLL, STA_FLL, etc.) |
| `ADJ_TIMECONST` | Set `constant` (PLL bandwidth, affects convergence speed) |
| `ADJ_TAI` | Set the TAI − UTC offset |
| `ADJ_SETOFFSET` | Step the clock by `offset` (used by chrony for large corrections) |
| `ADJ_NANO` | Interpret `offset` in nanoseconds (otherwise microseconds) |

### clock_adjtime()

`clock_adjtime()` is the modern, POSIX-compatible variant that takes a `clockid_t`:

```c
int clock_adjtime(clockid_t clk_id, struct timex *txc);
```

`chrony` prefers `clock_adjtime(CLOCK_REALTIME, ...)` over the older `adjtimex()`; the two are equivalent for `CLOCK_REALTIME` (`do_clock_adjtime()` in `kernel/time/posix-timers.c` just dispatches to the same `.clock_adj` handler `adjtimex()` reaches). `clock_adjtime()` doesn't extend this to `CLOCK_TAI`, though — `clock_tai`'s `k_clock` struct has no `.clock_adj` handler at all, so calling it with `CLOCK_TAI` returns `-EOPNOTSUPP`. The TAI offset is set through `CLOCK_REALTIME` with `ADJ_TAI`, as shown below.

## The NTP state machine

The `status` field in `struct timex` drives a state machine:

```
STA_UNSYNC
  │
  │  daemon calls adjtimex() with STA_PLL set and a valid offset
  ▼
STA_PLL          ← steady state: continuous frequency steering
  │
  │  PPS signal available and stable
  ▼
STA_PPSFREQ | STA_PPSTIME   ← PPS-disciplined (highest accuracy)
```

`STA_UNSYNC` is set by the kernel when it has not received a valid time update recently. A userspace daemon clears `STA_UNSYNC` when it starts locking to a reference. The return value of `adjtimex()` reports the current sync state as `TIME_OK`, `TIME_INS`, `TIME_DEL`, `TIME_OOP`, `TIME_WAIT`, or `TIME_ERROR`.

## ntp_tick_length()

On every tick, `timekeeping_adjust()` and `__timekeeping_advance()` (both in `kernel/time/timekeeping.c`) call into the NTP code to retrieve the correction to apply:

```c
u64 ntp_tick_length(unsigned int tkid);
```

This function takes a timekeeper ID (`tkid`) and returns the tick length to add, incorporating the current PLL/FLL frequency correction — but not in plain nanoseconds: the value is scaled left by `NTP_SCALE_SHIFT` (32 bits), i.e. `ns << 32`, the same fixed-point representation `struct timekeeper`'s own internal accumulators use. The base value before scaling is `NSEC_PER_SEC / HZ`; the PLL/FLL correction (`ntp_update_frequency()`, `kernel/time/ntp.c`) shifts it slightly up or down each time the sysadmin or synchronization daemon adjusts frequency.

## Leap seconds

A leap second is a one-second adjustment inserted (or deleted) at the end of a UTC day to keep UTC aligned with UT1 (Earth rotation). The kernel handles leap seconds through `adjtimex()` status flags:

| Flag | Meaning |
|------|---------|
| `STA_INS` | Insert a leap second at the next UTC midnight rollover |
| `STA_DEL` | Delete a leap second at the next UTC midnight rollover |

When `STA_INS` is set, at the UTC midnight boundary the kernel (`second_overflow()` in `kernel/time/ntp.c`):

1. Holds `xtime.tv_sec` at the value of 23:59:59 for two seconds (the "23:59:60" leap second) and increments `tai_offset` by 1 — TAI is always ahead of UTC by this offset (currently 37 seconds as of 2024).
2. Moves its internal `time_state` through `TIME_INS` → `TIME_OOP` → `TIME_WAIT`, which is reflected in `adjtimex()`'s return value so a synchronization daemon can observe the leap second happening.
3. Does *not* clear `STA_INS` itself — that bit stays set until the daemon that requested the leap second explicitly clears it via another `adjtimex()` call. The kernel only returns to `TIME_OK` once `STA_INS`/`STA_DEL` are already clear.

`CLOCK_TAI` reads the TAI clock, which never has leap seconds and counts seconds monotonically. Applications that need a monotonically increasing real-time clock (e.g., financial systems) should use `CLOCK_TAI` rather than `CLOCK_REALTIME`.

!!! warning "Leap second bugs"
    See the [War Stories](war-stories.md#the-leap-second-thundering-herd-2012) page for the 2012 leap second incident in which a kernel bug caused CPU saturation across Linux servers worldwide when the leap second was inserted.

## TAI offset

TAI (International Atomic Time) is ahead of UTC by an integer number of seconds equal to the cumulative count of inserted leap seconds. As of 2024, TAI − UTC = 37 seconds.

Reading TAI:

```c
struct timespec64 ts;
clock_gettime(CLOCK_TAI, &ts);
/* ts.tv_sec = CLOCK_REALTIME + tai_offset */
```

Setting the TAI offset (done by the time daemon, not applications):

```c
struct timex txc = {
    .modes = ADJ_TAI,
    .tai   = 37,
};
adjtimex(&txc);
```

## The 11-minute mode (RTC sync)

When the clock is synchronized (`STA_UNSYNC` is clear), the kernel periodically writes the current time to the hardware RTC every 11 minutes. This is implemented in `sync_hw_clock()` (called from a work queue) and ensures that the RTC — which has no NTP correction — stays close to UTC across reboots. The function was renamed from `sync_cmos_clock()` to `sync_hw_clock()` to reflect that it supports modern RTC class devices as well as legacy CMOS/RTC hardware.

The 11-minute interval is hardcoded (`SYNC_PERIOD_NS`, `kernel/time/ntp.c`) and not configurable. `sync_hw_clock()` has no VM-specific check — it simply tries `update_persistent_clock64()` (the legacy CMOS path) and then `update_rtc()` (the modern RTC-class path) in turn, and gives up permanently only once both return `-ENODEV`. In practice that's most often true on a VM with no RTC device exposed to the guest, but the logic itself is just "no RTC of either kind was found," not a virtualization check.

## ntpd / chrony workflow

A time synchronization daemon:

1. Opens a connection to one or more NTP servers (UDP port 123).
2. Measures the round-trip time and computes the clock offset using the NTP on-wire protocol.
3. Calls `adjtimex()` (or `clock_adjtime()`) repeatedly to drive the kernel PLL toward zero offset.
4. Adjusts `constant` (the PLL time constant) based on the poll interval — longer poll intervals use a larger time constant for stability.

`chrony` differs from `ntpd` in several ways:

- Uses `ADJ_SETOFFSET` to make fast step corrections when the offset is large (e.g., on first start), rather than slewing slowly.
- Supports hardware timestamping via `SO_TIMESTAMPING` for sub-microsecond accuracy with a PPS or PTP source.
- Tracks multiple reference sources and weights them by jitter and distance.

## Checking synchronization status

```bash
# Show current timex state (from util-linux)
adjtimex

# systemd's view
timedatectl show
timedatectl status
# Look for: NTP synchronized: yes

# chrony detailed tracking
chronyc tracking
# Reference ID, stratum, system time offset, frequency error

# ntpd peer status
ntpq -p
# '*' prefix = selected peer

# Kernel timex status directly via C
struct timex tx = {};
int state = adjtimex(&tx);
/* state: TIME_OK=0, TIME_INS=1, TIME_DEL=2, TIME_OOP=3,
          TIME_WAIT=4, TIME_ERROR=5 */
/* tx.status & STA_UNSYNC: nonzero = not synchronized */
```

The `STA_UNSYNC` bit being clear (zero) indicates the kernel considers the clock synchronized. `timedatectl` displays this as "NTP synchronized: yes".

## Further reading

### Kernel source

- [kernel/time/ntp.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/ntp.c) — the PLL/FLL time discipline control loop, leap-second state machine, `ntp_tick_length()`, and `sync_hw_clock()`
- [kernel/time/time.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/time.c) — the `adjtimex()`/`adjtimex_time32()` syscall entry points
- [kernel/time/timekeeping.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/timekeeping.c) — `do_adjtimex()`, and `timekeeping_advance()`/`timekeeping_adjust()` applying NTP tick corrections to `struct timekeeper`
- [include/uapi/linux/timex.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/timex.h) — user-space definitions for `struct timex`, `ADJ_*` modes, `STA_*` status flags, and `TIME_*` return codes
- [include/linux/timex.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/timex.h) — internal kernel timex operations, scaled ppm conversions, and PPS interface hooks

### Man pages

- [`adjtimex(2)`](https://man7.org/linux/man-pages/man2/adjtimex.2.html) — system call interface for reading and tuning kernel timekeeping parameters
- [`clock_adjtime(2)`](https://man7.org/linux/man-pages/man2/clock_adjtime.2.html) — POSIX clock-specific adjustment syscall supporting `CLOCK_REALTIME` and `CLOCK_TAI`
- [`adjtime(3)`](https://man7.org/linux/man-pages/man3/adjtime.3.html) — legacy C library interface for gradual clock slewing
- [`timedatectl(1)`](https://man7.org/linux/man-pages/man1/timedatectl.1.html) — systemd utility for querying NTP synchronization status and system clock settings

### Related pages

- [Timekeeping and Clocksources](timekeeping.md) — timekeeper architecture, `struct timekeeper`, and hardware counter integration
- [Clocksource and Clockevent Drivers](clocksource.md) — hardware counter calibration and frequency multiplier math
- [Time Subsystem War Stories](war-stories.md) — real-world leap second bugs and clocksource watchdog false positives

### LWN articles

- [ptp: IEEE 1588 hardware clock support](https://lwn.net/Articles/421436/) — Richard Cochran's patch series, December 2010, covered in LWN's kernel patches digest: introduces the `clock_adjtime()` syscall and the `ADJ_SETOFFSET` mode bit alongside PTP hardware clock support
- [The leap second bug](https://lwn.net/Articles/504657/) — Jonathan Corbet, July 2012: analysis of the 2012 kernel leap-second livelock and resolution

### External

- [Timekeeping and Timers in Linux](https://docs.kernel.org/core-api/timekeeping.html) — kernel documentation on timekeeping, NTP discipline, and hardware clock synchronization
- [RFC 5905: Network Time Protocol Protocol and Algorithm Specification](https://datatracker.ietf.org/doc/html/rfc5905) — authoritative specification of the NTPv4 on-wire protocol and clock discipline algorithm
