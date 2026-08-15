# cpuidle: CPU C-states and Idle Power Management

> Hardware sleep states, latency/power tradeoffs, and the cpuidle governor framework

## CPU C-states

When a CPU has no work to do, it enters a **C-state** (idle state). Each state trades deeper power savings for higher wake-up latency:

```
C-state hierarchy (x86, representative intel_idle/skl_cstates[] values --
exact numbers vary by CPU generation, see drivers/idle/intel_idle.c):
  C0  - Active (running instructions)
  C1  - HALT (stops pipeline, keeps power on)      ~2µs wake
  C1E - C1 + Enhanced (lower voltage)               ~10µs wake
  C3  - SLEEP (LLC may flush, snoop disabled)       ~70µs wake, large savings
  C6  - DEEP POWER DOWN (core voltage off)          ~85µs wake, max savings
  C7s - ENHANCED C6 (LLC flushed)                   ~124µs wake
  C8  - Platform C-state (package + RAM)            ~200µs wake
  C9  - Platform C-state                            ~480µs wake
  C10 - Deepest per-core idle state                 ~890µs (~0.9ms) wake

C10 here is still a per-core ACPI C-state -- not to be confused with
"Modern Standby" (S0ix), a separate platform-wide low-power mode entered
instead of S3 suspend, with its own coarser latency budget.
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
# C1: latency=2µs power=0mW
# C3: latency=70µs power=0mW
# C6: latency=85µs power=0mW
```

## cpuidle framework

The Linux cpuidle framework selects which C-state to enter when the CPU is idle:

```c
/* include/linux/cpuidle.h */

/* Describes one C-state: */
struct cpuidle_state {
    char        name[CPUIDLE_NAME_LEN];
    char        desc[CPUIDLE_DESC_LEN];

    s64         exit_latency_ns;      /* worst-case wake-up latency */
    s64         target_residency_ns;  /* min time to justify entering */
    unsigned int flags;               /* CPUIDLE_FLAG_TIMER_STOP etc. */

    /* legacy µs-granularity fields -- most drivers (e.g. intel_idle) still
     * populate these; the core derives the _ns fields above from them */
    unsigned int exit_latency;        /* in US */
    int          power_usage;         /* in mW */
    unsigned int target_residency;    /* in US */

    int (*enter)(struct cpuidle_device *dev,
                 struct cpuidle_driver *drv, int index);
    /* ... enter_dead(), enter_s2idle() also omitted here ... */
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
    int                  safe_state_index; /* shallow state used while a CPU
                                             * waits for coupled CPUs during
                                             * synchronized (COUPLED) idle
                                             * entry, see drivers/cpuidle/coupled.c */
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
        .flags = MWAIT2flg(0x01) | CPUIDLE_FLAG_ALWAYS_ENABLE,
        .exit_latency = 10,
        .target_residency = 20,
        .enter = intel_idle,
    },
    {
        .name = "C3",
        .desc = "MWAIT 0x10",
        .flags = MWAIT2flg(0x10) | CPUIDLE_FLAG_TLB_FLUSHED,
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
        .flags = MWAIT2flg(0x20) | CPUIDLE_FLAG_TLB_FLUSHED,
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

Simple: tries to stay at or near the current state; moves up/down by comparing the *actual* residency in the last state entered against the neighboring states' exit latencies (`drivers/cpuidle/governors/ladder.c`):

```
last_residency = actual_time_in_last_state - exit_latency[last_state]

# promote (go deeper), after PROMOTION_COUNT consecutive qualifying idles:
if last_residency > exit_latency[last_state + 1]:
    → promote to last_state + 1

# demote (go shallower):
if exit_latency[last_state] > latency_req:
    → demote immediately to the deepest state still within latency_req
elif last_residency < exit_latency[last_state]:
    → demote to last_state - 1  (DEMOTION_COUNT == 1, so this is immediate)
```

### menu governor (default for tickless systems)

Predicts idle duration using the next timer event and historical data. As of current mainline, `menu_select()` no longer has an iowait-based correction input (an older iowaiters-aware `which_bucket()` variant was removed) -- the prediction is now purely timer- and history-driven:

```c
/* drivers/cpuidle/governors/menu.c */

/* Inputs to prediction: */
/* 1. Time to next timer event (tick_nohz_get_sleep_length()) */
/* 2. Per-magnitude correction factor: an EWMA, bucketed by which_bucket()
 *    on the predicted duration alone (6 buckets, by order of magnitude) --
 *    corrects for wakeups (e.g. interrupts) that beat the next timer */
/* 3. Repeatable-interval detector: get_typical_interval() looks at the
 *    last 8 idle intervals; if their stddev is low, their average is used
 *    as the prediction instead of the next-timer estimate */
/* 4. pm_qos latency constraint (cpuidle_governor_latency_req()): caps how
 *    deep a state may be selected regardless of the duration prediction */

/* Output: selected C-state index */
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
# Disable C6 and deeper. With the state ordering used above
# (state0=POLL, state1=C1, state2=C1E, state3=C3, state4=C6, ...),
# C6 is state4:
for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state[4-9]*/; do
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

# Application: prevent deep C-states (e.g., audio daemon).
#
# /dev/cpu_dma_latency requires a *binary* 4-byte s32, not a decimal string:
# cpu_latency_qos_write() (kernel/power/qos.c) only string-parses a write
# when its length is NOT exactly sizeof(s32) == 4 bytes. "100\n" from
# `echo 100` is exactly 4 bytes, so it's reinterpreted as a raw binary value
# instead of the string "100" -- producing a garbage latency, not 100us.
# A shell redirect (or `tee`) also closes the fd right after writing, which
# drops the constraint immediately -- it only lasts as long as the fd stays
# open, so a real daemon holds it open for its own lifetime:
python3 -c "
import os, struct, time
fd = os.open('/dev/cpu_dma_latency', os.O_WRONLY)
os.write(fd, struct.pack('i', 100))  # binary s32: max 100us wakeup latency
time.sleep(3600)                     # keep the fd open -- closing it reverts the constraint
os.close(fd)
"
```

## Statistics and observability

```bash
# Per-CPU per-state time and usage:
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/usage
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/time   # µs
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/name

# cpupower tool:
cpupower idle-info
# CPUidle driver: intel_idle
# CPUidle governor: menu
#
# analyzing CPU 0:
#
# Number of idle states: 9
# Available idle states: POLL C1 C1E C3 C6 C7s C8 C9 C10
# C1:
# Flags/Description: MWAIT 0x00
# Latency: 2
# Residency: 2
# Usage: 8214532
# Duration: 431029841203
# C6:
# Flags/Description: MWAIT 0x20
# Latency: 85
# Residency: 200
# Usage: 5127004
# Duration: 981234501122

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
