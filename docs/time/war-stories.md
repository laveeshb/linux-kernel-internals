# Time Subsystem War Stories

> TSC instability, clocksource watchdog, leap seconds, and timer bugs

## TSC drift on multi-socket systems

Early x86 NUMA systems (pre-Nehalem era) had a fundamental problem: each socket contained its own oscillator, and the TSCs (Time Stamp Counters) across sockets were not synchronized to a common reference. The TSC on socket 0 might increment slightly faster than the TSC on socket 1. The difference was small — typically tens of microseconds per second — but it accumulated.

The consequence: a task scheduled on socket 0 could read `CLOCK_MONOTONIC` via the vDSO (which reads the TSC), be migrated by the scheduler to socket 1, and then read a *smaller* TSC value. `clock_gettime(CLOCK_MONOTONIC)` would appear to go backwards. Applications that assumed monotonic time was actually monotonic — a reasonable assumption given the name — would misbehave.

The kernel's fix is the **clocksource watchdog** (`kernel/time/clocksource.c`, `clocksource_watchdog()`). A periodic timer compares TSC readings against a reference clocksource (HPET or ACPI PM timer). If the TSC and the reference diverge by more than a threshold, the TSC is marked `CLOCK_SOURCE_UNSTABLE` and the kernel downgrades to the next-best clocksource (typically HPET, with a rating of 250 vs TSC's 300–400).

Modern Intel and AMD CPUs expose the **Invariant TSC** feature: `CPUID` leaf `0x80000007`, EDX bit 8 (`TSC_INVARIANT`). An invariant TSC:
- Runs at a constant rate regardless of CPU frequency scaling (P-states) and power states (C-states up to C1).
- Is synchronized across all cores in the package.
- Is synchronized across all sockets on Intel platforms using RESET synchronization.

The kernel checks for this flag during boot (`tsc_init()`) and sets `X86_FEATURE_TSC_RELIABLE` when present, allowing the TSC to be used safely as the primary clocksource even on multi-socket systems.

```bash
# Check for invariant TSC
grep ' constant_tsc' /proc/cpuinfo
grep ' nonstop_tsc' /proc/cpuinfo

# See what clocksource is active
cat /sys/devices/system/clocksource/clocksource0/current_clocksource

# Watchdog marks TSC unstable — look for this in dmesg
dmesg | grep -i 'clocksource.*unstable\|tsc.*watchdog'
```

## The leap second thundering herd (2012)

On June 30, 2012, at 23:59:59 UTC, a leap second was inserted. Linux servers worldwide experienced CPU saturation simultaneously — not from load, but from a kernel bug.

When `STA_INS` is set in the timex status, the kernel schedules the leap second insertion at the UTC midnight boundary. The implementation at the time had a flaw in how it handled `hrtimer_interrupt()` for tasks sleeping with `TIMER_ABSTIME` on `CLOCK_REALTIME`.

Here is what happened:

1. Applications (JVM, MySQL, Java-based services) had threads sleeping until an absolute `CLOCK_REALTIME` time — say, "wake me at 00:00:00.000".
2. The leap second was inserted: the kernel held the clock at 23:59:59 for an extra second, then jumped to 00:00:00.
3. The threads' wakeup times were now "in the past" from the kernel's perspective.
4. The kernel woke them immediately.
5. The threads called `clock_nanosleep()` again with a new absolute time.
6. That new time was also "in the past" (the NTP-adjusted clock was in a confused state).
7. The threads were woken again immediately, re-slept, woken again — spinning in a tight loop consuming 100% CPU.

The result: Reddit, Mozilla, LinkedIn, Qantas, and hundreds of other Linux-based services reported CPU spikes to 100% at exactly the same moment, worldwide.

Root cause: the leap second handling hrtimers were never notified of the clock step via `clock_was_set()`, so `CLOCK_REALTIME`/`TIMER_ABSTIME` timers fired immediately in a continuous loop. The kernel was subsequently patched with backports that corrected `hrtimer` behavior during leap second insertion.

**Workarounds used at the time:**
- Set the system clock slightly ahead before midnight so the leap second was absorbed as a normal tick, avoiding the confused state entirely.
- Use `ntpd`'s `leapsmear` option (chrony, NTPD 4.2.6+) to spread the one-second adjustment over a longer window (12–24 hours) so no single second has a discontinuity — preventing the sharp discontinuity that triggered the spin. Many NTP server operators and cloud providers now smear by default. The kernel does not implement smearing natively; it is done by the time daemon.
- Apply the kernel fix: backported patches that corrected `hrtimer` behavior during leap second insertion were available for affected kernel versions.

This incident led to widespread adoption of `CLOCK_TAI` for applications that need a monotonically increasing real-time clock — TAI has no leap seconds and never jumps.

## The clocksource watchdog false positive

A production Kubernetes cluster on KVM hypervisors started showing erratic `clock_gettime()` behavior. Processes observed `CLOCK_MONOTONIC` advancing far too slowly — with a resolution of 1 millisecond instead of the expected 1 nanosecond. `dmesg` on affected guest VMs showed:

```
clocksource: timekeeping watchdog on CPU 0: Marking clocksource hpet unstable due to frequency skew
clocksource: Switched to clocksource jiffies
```

The root cause was a chain of fallbacks:

1. The KVM guests had HPET disabled in the hypervisor (`no_hpet` on the host kernel command line) for performance — HPET registers are slow to access.
2. Without HPET, the watchdog fell back to the **ACPI PM timer** as the reference clocksource.
3. The host was overloaded. Reading the PM timer register from a KVM guest required a VMEXIT. Under load, the hypervisor would not schedule the VMEXIT completion for hundreds of microseconds — much longer than the expected PM timer read latency.
4. The watchdog compared the TSC delta against the delayed PM timer delta and concluded the TSC had drifted by hundreds of microseconds — even though the TSC was accurate.
5. The kernel marked the TSC `CLOCK_SOURCE_UNSTABLE`, fell back to HPET (unavailable), then fell back to `jiffies` — giving 1 ms resolution.

All `clock_gettime()` calls in the affected guests became coarse-grained. Any application relying on high-resolution timing (profiling, network pacing, HTTP/2 deadlines) was degraded.

**Fixes and mitigations:**

```bash
# Immediate mitigation on affected guests:
echo tsc > /sys/devices/system/clocksource/clocksource0/current_clocksource

# Permanent: disable the watchdog if TSC is known reliable
# Add to kernel command line:
tsc=reliable

# Better: configure KVM guests to use kvm-clock
# kvm-clock is paravirtualized and accounts for steal time correctly
grep kvm-clock /sys/devices/system/clocksource/clocksource0/available_clocksource
echo kvm-clock > /sys/devices/system/clocksource/clocksource0/current_clocksource
```

`kvm-clock` is the correct clocksource for KVM guests. It uses a shared memory page (the `pvclock` page) written by the hypervisor, and accounts for steal time — time during which the guest vCPU was not scheduled. The kernel uses it by default when running under KVM if the hypervisor exposes it.

## timer_delete vs timer_delete_sync race

A network driver registered a timer to retransmit a packet if an acknowledgment did not arrive within a timeout. The timer callback read fields from the driver's `struct device_state`. During driver teardown, the cleanup function called `timer_delete()` and then `kfree(state)`:

```c
/* BUGGY teardown */
static void driver_remove(struct platform_device *pdev)
{
    struct device_state *state = platform_get_drvdata(pdev);
    timer_delete(&state->retransmit_timer);  /* BUG: does not wait */
    kfree(state);                          /* freed while callback may run */
}
```

The race:

1. CPU 0: `timer_delete()` is called. The timer is pending in the wheel. `timer_delete()` removes it and returns 1 (was pending).
2. CPU 1: The timer had already been dequeued by `__run_timers()` before CPU 0's `timer_delete()` ran — the callback is now executing.
3. CPU 0: `timer_delete()` returns. `kfree(state)` is called. `state` is freed.
4. CPU 1: The timer callback continues executing and reads fields from the now-freed `state` — use-after-free.

`timer_delete()` removes the timer from the wheel but provides no guarantee that a currently-executing callback has finished. `timer_delete_sync()` spins until the callback is not running on any CPU before returning.

**Fix:**

```c
/* Correct teardown */
static void driver_remove(struct platform_device *pdev)
{
    struct device_state *state = platform_get_drvdata(pdev);
    timer_delete_sync(&state->retransmit_timer);  /* waits for callback */
    kfree(state);                               /* safe */
}
```

Since Linux 6.2, `timer_shutdown_sync()` is the preferred function when a timer must never fire again after teardown:

```c
timer_shutdown_sync(&state->retransmit_timer);
/* Any subsequent add_timer() / mod_timer() calls are silently ignored */
kfree(state);
```

This prevents a re-arm race where the callback arms the timer again before `timer_delete_sync()` returns — `timer_shutdown_sync()` marks the timer permanently inactive.

LOCKDEP will warn about `timer_delete_sync()` called from softirq context (it cannot sleep to wait). In that case, use `timer_delete()` and defer the `kfree()` to a work queue, or use RCU to protect the data structure.

## The 32-bit jiffies wraparound

A storage driver implemented a command timeout:

```c
struct command {
    unsigned long submit_jiffies;
    /* ... */
};

/* On submit: */
cmd->submit_jiffies = jiffies;

/* In the completion path: */
unsigned long elapsed = jiffies - cmd->submit_jiffies;
if (elapsed > msecs_to_jiffies(TIMEOUT_MS)) {
    report_timeout(cmd);
}
```

This code appeared correct and passed testing. On production systems with HZ=1000, it worked reliably for 49 days — then commands started being incorrectly reported as timed out.

At HZ=1000, `jiffies` wraps from `ULONG_MAX` (0xFFFFFFFF on a 32-bit kernel, or the lower 32 bits of `jiffies` on a 64-bit kernel if the driver cast to `u32`) back to zero after approximately 49.7 days.

After wraparound: `cmd->submit_jiffies` is a large number (e.g., 0xFFFF0000). Current `jiffies` is a small number (e.g., 0x00001000). The subtraction `jiffies - cmd->submit_jiffies` produces a huge positive number due to unsigned wraparound — incorrectly appearing as a very long elapsed time.

A second variant of the bug uses raw comparison:

```c
/* Also wrong: */
if (jiffies > cmd->submit_jiffies + msecs_to_jiffies(TIMEOUT_MS)) {
```

After wraparound, `cmd->submit_jiffies + timeout` wraps to a small number, and `jiffies > small_number` is immediately true.

**The fix: always use the wraparound-safe macros.**

```c
/* Correct elapsed time check */
if (time_after(jiffies, cmd->submit_jiffies + msecs_to_jiffies(TIMEOUT_MS))) {
    report_timeout(cmd);
}

/* time_after(a, b) performs the subtraction at unsigned long width,
 * then casts the result to long: (long)((b) - (a)) < 0
 * By interpreting the unsigned result as signed long, wraparound
 * differences up to LONG_MAX are handled correctly. The macro assumes
 * the interval is < LONG_MAX/HZ seconds (about 24 days on a 32-bit
 * HZ=1000 system). */
```

The full family of macros in `include/linux/jiffies.h`:

| Macro | Meaning |
|-------|---------|
| `time_after(a, b)` | `a` is after `b` (a > b, wraparound-safe) |
| `time_before(a, b)` | `a` is before `b` |
| `time_after_eq(a, b)` | `a` is after or equal to `b` |
| `time_before_eq(a, b)` | `a` is before or equal to `b` |
| `time_in_range(a, b, c)` | `a` is within `[b, c]` |

On 64-bit kernels, `jiffies` is a 64-bit value and `jiffies_64` provides the full 64-bit counter directly. Overflow takes hundreds of millions of years, making it a non-issue — but the wraparound-safe macros remain correct and should be used regardless for clarity and portability.

## Further reading

### Kernel source

- [kernel/time/clocksource.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/clocksource.c) — `clocksource_watchdog()` stability verification, `CLOCK_SOURCE_UNSTABLE` marking, and retry threshold logic
- [kernel/time/timekeeping.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/timekeeping.c) — `second_overflow()` and leap-second state transitions, preventing timer rearm loops
- [kernel/time/timer.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/timer.c) — `timer_delete_sync()` and `timer_shutdown_sync()` implementation preventing concurrent execution and re-arming races
- [include/linux/jiffies.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/jiffies.h) — `time_after()`, `time_before()`, and wraparound-safe arithmetic
- [arch/x86/kernel/tsc.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/tsc.c) — `tsc_init()`, invariant TSC CPUID validation, and `mark_tsc_unstable()`
- [arch/x86/kernel/kvmclock.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/kvmclock.c) — paravirtualized `kvm-clock` clocksource integration for guest timekeeping

### Man pages

- [`clock_gettime(2)`](https://man7.org/linux/man-pages/man2/clock_gettime.2.html) — monotonic and realtime clock querying semantics
- [`adjtimex(2)`](https://man7.org/linux/man-pages/man2/adjtimex.2.html) — leap second insertion flags (`STA_INS`, `STA_DEL`) and status reporting

### Related pages

- [Clocksource and Clockevent Drivers](clocksource.md) — hardware clocksources, watchdog verification, and rating hierarchy
- [Timekeeping and Clocksources](timekeeping.md) — timekeeping architecture, leap seconds, and vDSO fast paths
- [The Timer Wheel](timer-wheel.md) — timer lifecycle, `timer_delete_sync()`, and jiffies arithmetic
- [NTP and Clock Discipline](ntp.md) — PLL synchronization, leap seconds, and chrony/ntpd smearing

### LWN articles

- [The leap second bug](https://lwn.net/Articles/504658/) — Jonathan Corbet, July 2012: in-depth postmortem of the 2012 leap second hrtimer livelock
- [The trouble with the TSC](https://lwn.net/Articles/388188/) — Jonathan Corbet, May 2010: invariant TSC guarantees, frequency scaling drift, and watchdog verification
- [Reinventing the timer wheel](https://lwn.net/Articles/646950/) — Jonathan Corbet, June 2015: redesigning the timer wheel and improving timer cancellation guarantees

### External

- [Timekeeping and Timers in Linux](https://docs.kernel.org/core-api/timekeeping.html) — core kernel documentation for timekeeping and timer subsystems
- [The kernel's command-line parameters](https://docs.kernel.org/admin-guide/kernel-parameters.html) — `tsc=reliable`, `clocksource=`, and `no_hpet` parameter reference
