# NTP and Clock Discipline

> How the kernel adjusts the clock: adjtimex, PLL/FLL, and TAI offset

## The problem

A hardware oscillator drifts. Without correction, the system clock deviates from UTC by seconds per day. The goal of clock discipline is to steer the clock toward an external reference (GPS, NTP server, PPS signal) continuously and smoothly, without stepping the clock backwards or creating discontinuities that confuse applications.

The Linux kernel implements this through a control loop in `kernel/time/ntp.c`, driven by `adjtimex()` calls from userspace daemons (`ntpd`, `chrony`).

## PLL and FLL modes

The kernel supports two adjustment strategies:

**Phase-locked loop (PLL)** — The daemon measures the offset between local time and the reference, then asks the kernel to make small, continuous frequency adjustments to steer the clock toward zero offset. The correction is proportional to the measured offset. PLL is used when the offset is small (typically less than 128 ms). This is the steady-state mode for a well-synchronized clock.

**Frequency-locked loop (FLL)** — Used when the offset is large or when the clock has not been synchronized for a long time. The kernel adjusts frequency more aggressively based on the rate at which the offset is changing rather than the offset itself. FLL mode is signaled by the `STA_FLL` status flag.

The daemon selects the mode by setting `STA_PLL` or `STA_FLL` (or both) in `timex.status` when calling `adjtimex()`.

## adjtimex()

`adjtimex()` is the kernel's time discipline interface, defined in `kernel/time/ntp.c`:

```c
int adjtimex(struct timex *txc);
```

The `struct timex` (defined in `include/uapi/linux/timex.h`):

```c
struct timex {
    unsigned int modes;     /* ADJ_OFFSET, ADJ_FREQUENCY, ADJ_MAXERROR,
                               ADJ_ESTERROR, ADJ_STATUS, ADJ_TIMECONST,
                               ADJ_TAI, ADJ_SETOFFSET, ADJ_NANO, ... */
    long offset;            /* time offset (ns if STA_NANO set, else us) */
    long freq;              /* frequency offset (scaled ppm: ppm * 2^16) */
    long maxerror;          /* maximum error estimate (us) */
    long esterror;          /* estimated error (us) */
    int  status;            /* STA_PLL, STA_FLL, STA_NANO, STA_UNSYNC,
                               STA_INS, STA_DEL, STA_PPSFREQ, STA_PPSTIME,
                               STA_PPSJITTER, STA_PPSWANDER, STA_PPSERROR,
                               STA_CLOCKERR, ... */
    long constant;          /* PLL time constant (log2 of poll interval) */
    long precision;         /* clock precision (us, read-only) */
    long tolerance;         /* clock frequency tolerance (read-only) */
    struct timeval time;    /* current time (read-only) */
    long tick;              /* us between clock ticks */
    long ppsfreq;           /* PPS frequency (read-only, scaled ppm) */
    long jitter;            /* PPS jitter (read-only, ns or us) */
    int  shift;             /* PPS interval duration (seconds, read-only) */
    long stabil;            /* PPS stability (read-only, scaled ppm) */
    long jitcnt;            /* PPS jitter exceeded limit count (read-only) */
    long calcnt;            /* PPS calibration intervals (read-only) */
    long errcnt;            /* PPS calibration errors (read-only) */
    long stbcnt;            /* PPS stability exceeded limit count (read-only) */
    int  tai;               /* TAI - UTC offset in seconds (read-only unless
                               ADJ_TAI is set in modes) */
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

`chrony` prefers `clock_adjtime(CLOCK_REALTIME, ...)` over the older `adjtimex()`. The two calls are equivalent for `CLOCK_REALTIME`; `clock_adjtime()` additionally supports adjusting `CLOCK_TAI` (for the TAI offset).

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

On every tick, `timekeeping_update()` calls into the NTP code to retrieve the correction to apply:

```c
u64 ntp_tick_length(unsigned int tkid);
```

This function takes a timekeeper ID (`tkid`) and returns the number of nanoseconds to add for this tick, incorporating the current PLL/FLL frequency correction. The base value is `NSEC_PER_SEC / HZ`; the PLL correction shifts it slightly up or down. `timekeeping_adjust()` applies the accumulated correction when updating `struct timekeeper`.

## Leap seconds

A leap second is a one-second adjustment inserted (or deleted) at the end of a UTC day to keep UTC aligned with UT1 (Earth rotation). The kernel handles leap seconds through `adjtimex()` status flags:

| Flag | Meaning |
|------|---------|
| `STA_INS` | Insert a leap second at the next UTC midnight rollover |
| `STA_DEL` | Delete a leap second at the next UTC midnight rollover |

When `STA_INS` is set, at the UTC midnight boundary the kernel:

1. Holds `xtime.tv_sec` at the value of 23:59:59 for two seconds (the "23:59:60" leap second).
2. Increments `tai_offset` by 1 — TAI is always ahead of UTC by this offset (currently 37 seconds as of 2024).
3. Clears `STA_INS`.

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

When the clock is synchronized (`STA_UNSYNC` is clear and `STA_PLL` is set), the kernel periodically writes the current time to the hardware RTC every 11 minutes. This is implemented in `sync_hw_clock()` (called from a work queue) and ensures that the RTC — which has no NTP correction — stays close to UTC across reboots. The function was renamed from `sync_cmos_clock()` to `sync_hw_clock()` to reflect that it supports modern RTC class devices as well as legacy CMOS/RTC hardware.

The 11-minute interval is hardcoded and not configurable. The write is skipped if the system is a virtual machine without a real CMOS clock.

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
