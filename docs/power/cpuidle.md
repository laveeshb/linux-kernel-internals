# cpuidle: CPU C-states and Idle Power Management

> Hardware sleep states, latency/power tradeoffs, and the cpuidle governor framework

## CPU C-states

When a CPU has no work to do, it enters a **C-state** (idle state). Each state trades deeper power savings for higher wake-up latency:

```
C-state hierarchy (x86):
  C0 - Active (running instructions)
  C1 - HALT (stops pipeline, keeps power on)       ~1µs wake, ~15W saved
  C1E - C1 + Enhanced (lower voltage)              ~5µs wake, ~20W saved
  C2 - STOP-GRANT (cache coherent)                 ~10µs wake
  C3 - SLEEP (LLC may flush, snoop disabled)       ~50µs wake, large savings
  C6 - DEEP POWER DOWN (core voltage off)          ~100µs wake, max savings
  C7 - ENHANCED C6 (LLC flushed)                   ~150µs wake
  C8, C9, C10 - Platform C-states (package + RAM)  ~300µs+ wake

Package C-states (PC-states): the entire socket enters when all cores idle:
  PC2: ~5µs, PC3: ~50µs, PC6: ~100µs (DRAM power down), PC8: ~300µs
```

```bash
# Check available C-states:
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/name
# POLL
# C1
# C1E
# C3
# C6
# C7s
# C8
# C9
# C10

# Check C-state latency and power:
for state in /sys/devices/system/cpu/cpu0/cpuidle/state*; do
    echo -n "$(cat $state/name): "
    echo -n "latency=$(cat $state/latency)µs "
    echo "power=$(cat $state/power)mW"
done
# C1: latency=1µs power=0mW
# C3: latency=59µs power=0mW
# C6: latency=124µs power=0mW
```

## cpuidle framework

The Linux cpuidle framework selects which C-state to enter when the CPU is idle:

```c
/* include/linux/cpuidle.h */

/* Describes one C-state: */
struct cpuidle_state {
    char        name[CPUIDLE_NAME_LEN];
    char        desc[CPUIDLE_DESC_LEN];
    s64         exit_latency_ns;  /* worst-case wake-up latency */
    s64         target_residency_ns; /* min time to justify entering */
    unsigned int flags;           /* CPUIDLE_FLAG_TIMER_STOP etc. */
    int (*enter)(struct cpuidle_device *dev,
                 struct cpuidle_driver *drv, int index);
};

/* Per-CPU idle device: */
struct cpuidle_device {
    unsigned int    registered:1;
    unsigned int    enabled:1;
    unsigned int    poll_time_limit:1;
    unsigned int    cpu;
    ktime_t         next_hrtimer;          /* next timer expiry */
    struct cpuidle_state_usage states_usage[CPUIDLE_STATE_MAX];
    /* states_usage[i].time_ns: total ns spent in state i */
    /* states_usage[i].usage:   number of times state i entered */
};

/* Driver: describes all C-states for a platform: */
struct cpuidle_driver {
    const char          *name;
    struct module       *owner;
    struct cpuidle_state states[CPUIDLE_STATE_MAX];
    int                  state_count;
    int                  safe_state_index; /* fallback if deadline missed */
};
```

### intel_idle driver

The `intel_idle` driver provides Intel-specific C-states with known latencies:

```c
/* drivers/idle/intel_idle.c */
static struct cpuidle_state skl_cstates[] = {
    {
        .name = "C1",
        .desc = "MWAIT 0x00",
        .flags = MWAIT2flg(0x00),
        .exit_latency = 2,
        .target_residency = 2,
        .enter = intel_idle,
    },
    {
        .name = "C1E",
        .desc = "MWAIT 0x01",
        .exit_latency = 10,
        .target_residency = 20,
        .enter = intel_idle,
    },
    {
        .name = "C3",
        .desc = "MWAIT 0x10",
        .exit_latency = 70,
        .target_residency = 100,
        .enter = intel_idle,
    },
    {
        .name = "C6",
        .desc = "MWAIT 0x20",
        .exit_latency = 85,
        .target_residency = 200,
        .enter = intel_idle,
        .flags = CPUIDLE_FLAG_TLB_FLUSHED,
    },
    /* ... more states ... */
};

/* Entering a C-state via MWAIT instruction: */
#define flg2MWAIT(flags) (((flags) >> 24) & 0xFF)  /* hint packed in top byte of .flags */

static __always_inline int __intel_idle(struct cpuidle_device *dev,
                                        struct cpuidle_driver *drv,
                                        int index, bool irqoff)
{
    struct cpuidle_state *state = &drv->states[index];
    unsigned int eax = flg2MWAIT(state->flags);
    unsigned int ecx = 1 * irqoff; /* break on interrupt */

    mwait_idle_with_hints(eax, ecx);  /* issues MONITOR/MWAIT */
    return index;
}

static __cpuidle int intel_idle(struct cpuidle_device *dev,
                                struct cpuidle_driver *drv, int index)
{
    return __intel_idle(dev, drv, index, true);
}
```

## cpuidle governors

The governor decides which C-state to enter based on expected idle duration:

### ladder governor

Simple: tries to stay at or near the current state; moves up/down based on actual vs predicted duration:

```
idle duration < target_residency[current-1] → demote to lower state
idle duration > target_residency[current]   → promote to deeper state
```

### menu governor (default for tickless systems)

Predicts idle duration using the next timer event and historical data:

```c
/* kernel/sched/idle.c + drivers/cpuidle/governors/menu.c */

/* Inputs to prediction: */
/* 1. Time to next timer (hrtimer, jiffies timer) */
/* 2. Historical data: exponentially weighted moving average */
/* 3. iowait correction: lower C-state if I/O is pending */

/* Output: selected C-state index */

/* Correction factors: */
/* - If many short idles: don't go deep (I/O about to arrive) */
/* - If long idles predicted: go deep */
```

### TEO governor (Timer Events Oriented, Linux 5.1+)

More accurate for modern tickless systems:

```bash
# Check/set current governor:
cat /sys/devices/system/cpu/cpuidle/current_governor
# menu

echo teo > /sys/devices/system/cpu/cpuidle/current_governor
```

## Disabling C-states

For latency-sensitive workloads, disable deep C-states:

```bash
# Disable C6 and deeper (state 3+):
for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state3/; do
    echo 1 > $cpu/disable 2>/dev/null
done

# Permanent: add "processor.max_cstate=1" to kernel boot params
# or: "intel_idle.max_cstate=1"

# For RT systems: disable all C-states except C0/POLL:
for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state[1-9]*/; do
    echo 1 > $cpu/disable 2>/dev/null
done

# Check pm_qos latency constraint (set by applications/drivers):
cat /sys/devices/system/cpu/cpu0/power/pm_qos_resume_latency_us
# 0 = no constraint, other value = max acceptable wakeup latency

# Application: prevent deep C-states (e.g., audio daemon):
echo 100 > /dev/cpu_dma_latency  # max 100µs wakeup latency
# (keep fd open; closing reverts the constraint)
```

## Statistics and observability

```bash
# Per-CPU per-state time and usage:
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/usage
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/time   # µs
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/name

# cpupower tool:
cpupower idle-info
# CPUs which run at the same hardware frequency:  0-7
# CPUs which need to have their frequency coordinated: 0-7
# maximum transition latency: 0.00 ms
# Available idle states:
# POLL  C1  C1E  C3  C6  C7s  C8  C9  C10

cpupower monitor -i 5  # 5-second sample
# Mperf | C0   Cx   Freq | POLL C1   C1E  C3   C6   C7s  C8   C9   C10
#      0| 25%  75% 3.2G  |   0%   0%   0%   0%   0%  10%  20%  45%   0%

# Turbostat: per-CPU C-state residency:
turbostat --interval 1 --show CPU,Busy%,Bzy_MHz,PkgWatt,C1%,C6%,C8%
# CPU   Busy%  Bzy_MHz  PkgWatt  C1%    C6%    C8%
#   0    5.2   3400.0   18.4    2.3    3.1   89.4
#   1    2.1   3400.0            1.2    1.8   94.9

# BPF trace cpuidle events:
bpftrace -e '
tracepoint:power:cpu_idle
{ @[args->state, cpu] = count(); }'
# [state, cpu] → entry count

# CPU wake-up latency histogram (time between idle entry and next event):
bpftrace -e '
tracepoint:power:cpu_idle /args->state != 4294967295/
{ @start[cpu] = nsecs; }
tracepoint:power:cpu_idle /args->state == 4294967295 && @start[cpu]/
{
    @lat_us[cpu] = hist((nsecs - @start[cpu]) / 1000);
    delete(@start[cpu]);
}'
```

## Power consumption impact

```bash
# Measure power with powertop:
powertop --auto-tune   # apply recommended power settings
powertop --csv=power.csv --time=60  # 60-second measurement

# RAPL (Running Average Power Limit) energy counters:
cat /sys/class/powercap/intel-rapl:0/energy_uj       # package energy
cat /sys/class/powercap/intel-rapl:0:0/energy_uj     # core energy
cat /sys/class/powercap/intel-rapl:0:1/energy_uj     # uncore energy

# turbostat shows instantaneous watts per package
turbostat --show PkgWatt,PkgTmp --interval 1
```

## Further reading

### Kernel source

- [include/linux/cpuidle.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/cpuidle.h) — `struct cpuidle_state`, `struct cpuidle_device`, `struct cpuidle_driver`
- [drivers/idle/intel_idle.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/idle/intel_idle.c) — Intel C-state driver: `skl_cstates[]` table and the `intel_idle()`/MWAIT entry path
- [drivers/cpuidle/governors/menu.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/cpuidle/governors/menu.c) — the `menu` governor's idle-duration prediction
- [drivers/cpuidle/governors/teo.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/cpuidle/governors/teo.c) — the Timer Events Oriented governor
- [kernel/sched/idle.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/idle.c) — `cpuidle_idle_call()`, the idle loop that invokes the governor and driver

### Related pages

- [cpufreq and P-states](cpufreq.md) — frequency scaling (orthogonal to C-states)
- [Real-Time Tuning](../sched/rt-tuning.md) — CPU isolation and frequency-scaling tuning for RT tasks
- [The Scheduling Tick](../sched/sched-tick.md) — NOHZ interaction with cpuidle
- [hrtimers](../time/hrtimers.md) — timers that interrupt idle

### LWN articles

- [LWN: cpuidle: New timer events oriented governor for tickless systems](https://lwn.net/Articles/769571/) — Rafael Wysocki's original patch and rationale for the TEO governor, merged in Linux 5.1

### External

- [Documentation/admin-guide/pm/cpuidle.rst](https://docs.kernel.org/admin-guide/pm/cpuidle.html) — upstream CPUIdle subsystem admin guide: governors, drivers, the `disable` and `pm_qos_resume_latency_us` sysfs knobs
