# Time Subsystem

> Timekeeping, clocksources, and timers in the Linux kernel

## The time stack

```
User space
  clock_gettime(CLOCK_MONOTONIC)     timer_create()     timerfd_create()
        │                                  │                   │
        ▼                                  ▼                   ▼
  vDSO (userspace page, no syscall)   POSIX timers        timerfd
        │                                  │                   │
        └──────────────┬───────────────────┘                   │
                       ▼                                       │
             Timekeeping core                                   │
             (kernel/time/timekeeping.c)                        │
             struct timekeeper                                  │
                       │                                        │
             ┌─────────┴──────────┐                            │
             ▼                    ▼                             │
       Clocksource           Clockevent                        │
       (read counter)        (program interrupt)               │
       TSC / HPET            HPET / LAPIC / ARM              hrtimer
                                    │                           │
                              tick_device                  hrtimer_cpu_base
                              tick_sched                        │
                                    │                           │
                             Scheduler tick              High-res callback
                             NOHZ idle                   (on clockevent IRQ)
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Timekeeping](timekeeping.md) | clocksources, TSC, NTP, struct timekeeper, vDSO |
| [hrtimers](hrtimers.md) | High-resolution timers, CLOCK_MONOTONIC/REALTIME, timer slack |
| [POSIX timers](posix-timers.md) | timer_create, clock_nanosleep, timerfd, epoll integration |
| [The Timer Wheel](timer-wheel.md) | jiffies, struct timer_list, hierarchical wheel, deferrable timers |
| [NTP and Clock Discipline](ntp.md) | adjtimex, PLL/FLL, leap seconds, TAI offset, chrony/ntpd |
| [Time Namespaces](time-namespaces.md) | CLONE_NEWTIME, CLOCK_MONOTONIC isolation, CRIU use case |
| [War Stories](war-stories.md) | TSC drift, leap second thundering herd, del_timer_sync race, jiffies wraparound |

## Quick reference

```bash
# Available clocksources (current in brackets)
cat /sys/devices/system/clocksource/clocksource0/available_clocksource
# tsc-early tsc hpet acpi_pm

cat /sys/devices/system/clocksource/clocksource0/current_clocksource
# tsc

# TSC frequency
dmesg | grep "TSC.*MHz"
# tsc: Detected 3600.000 MHz processor

# Timer resolution
clock_getres(CLOCK_MONOTONIC) → 1 ns on most x86 systems

# hrtimer mode
dmesg | grep "hrtimer"
# Switched to high resolution mode on CPU 0

# System time offset (NTP)
timedatectl
# NTP synchronized: yes
```
