# cpufreq: CPU Frequency Scaling

> P-states, governors, and hardware-coordinated frequency management

## Why CPU frequency scaling?

Modern CPUs can run at different voltage-frequency operating points called **P-states** (performance states). Lower frequency = lower voltage = less power. The kernel's cpufreq subsystem selects the operating point based on current load.

```
P0 (max turbo): 4.5 GHz, 1.4V  — high throughput, high power
P1 (base):      3.5 GHz, 1.2V  — sustained all-core
P2:             2.5 GHz, 1.0V
...
Pn (minimum):   0.8 GHz, 0.7V  — idle, minimal power
```

## Architecture

```
cpufreq core (drivers/cpufreq/cpufreq.c)
    │
    ├── Governor (policy): schedutil / ondemand / performance / powersave
    │       decides target frequency based on utilization
    │
    └── Driver (hardware): intel_pstate / acpi-cpufreq / cppc_cpufreq
            programs the actual hardware MSRs / ACPI commands
```

## struct cpufreq_policy

```c
/* include/linux/cpufreq.h */
struct cpufreq_policy {
    /* CPUs sharing this policy (e.g., SMT siblings or all cores on a die) */
    cpumask_var_t   cpus;
    cpumask_var_t   related_cpus;

    unsigned int    shared_type;   /* CPUFREQ_SHARED_TYPE_ALL/ANY/HW */

    unsigned int    cpu;           /* managing CPU */
    struct clk     *clk;

    struct cpufreq_cpuinfo cpuinfo; /* min/max freq, transition latency */

    unsigned int    min;     /* current policy min (kHz) */
    unsigned int    max;     /* current policy max (kHz) */
    unsigned int    cur;     /* current frequency */
    unsigned int    suspend_freq;

    unsigned int    policy;  /* CPUFREQ_POLICY_PERFORMANCE or _POWERSAVE */
    unsigned int    last_policy;

    struct cpufreq_governor *governor;
    void            *governor_data;

    /* embedded, not pointers -- QoS constraints tracked in-line */
    struct freq_qos_request min_freq_req;
    struct freq_qos_request max_freq_req;
    /* ... additional fields (stats, kobject, locking) omitted ... */
};
```

## Governors

A governor observes CPU utilization and selects a target frequency.

### schedutil (recommended, 4.7+)

schedutil integrates with the scheduler's per-CPU utilization tracking. It's called directly from the scheduler path when utilization changes — no polling needed.

```c
/* kernel/sched/cpufreq_schedutil.c */
static void sugov_update_single_freq(struct update_util_data *hook, u64 time,
                                     unsigned int flags)
{
    struct sugov_cpu *sg_cpu = container_of(hook, struct sugov_cpu, update_util);
    struct sugov_policy *sg_policy = sg_cpu->sg_policy;
    unsigned int cached_freq = sg_policy->cached_raw_freq;
    unsigned long max_cap;
    unsigned int next_f;

    max_cap = arch_scale_cpu_capacity(sg_cpu->cpu);

    /* Refresh utilization, apply iowait boost, honor the rate limit */
    if (!sugov_update_single_common(sg_cpu, time, max_cap, flags))
        return;

    /* Map utilization → target frequency */
    next_f = get_next_freq(sg_policy, sg_cpu->util, max_cap);

    if (sugov_hold_freq(sg_cpu) && next_f < sg_policy->next_freq &&
        !sg_policy->need_freq_update) {
        next_f = sg_policy->next_freq;
        sg_policy->cached_raw_freq = cached_freq;
    }

    if (!sugov_update_next_freq(sg_policy, time, next_f))
        return;

    if (sg_policy->policy->fast_switch_enabled)
        cpufreq_driver_fast_switch(sg_policy->policy, next_f);
    else
        sugov_deferred_update(sg_policy);  /* wakes the sugov kthread */
}

/*
 * get_next_freq() - target frequency proportional to utilization:
 *   next_freq = C * ref_freq * util / max   (C = 1.25 margin)
 */
static unsigned int get_next_freq(struct sugov_policy *sg_policy,
                                  unsigned long util, unsigned long max)
{
    struct cpufreq_policy *policy = sg_policy->policy;
    unsigned int freq = get_capacity_ref_freq(policy);

    freq = map_util_freq(util, freq, max);

    if (freq == sg_policy->cached_raw_freq && !sg_policy->need_freq_update)
        return sg_policy->next_freq;

    sg_policy->cached_raw_freq = freq;
    return cpufreq_driver_resolve_freq(policy, freq);
}
```

### ondemand

Polls CPU idle time periodically, scales frequency proportionally to non-idle fraction. The sampling interval is not a fixed 10ms: it defaults to `max(2 * tick_period, 1.5 * transition_latency)` (falling back to 1ms if the driver reports no transition latency) — see `cpufreq_policy_transition_delay_us()` in `drivers/cpufreq/cpufreq.c` and the default computed in `drivers/cpufreq/cpufreq_governor.c`. It's tunable at runtime via the governor's `sampling_rate` sysfs file:

```
target_freq = max_freq * (non_idle_time / sample_time)
```

Slower to react than schedutil (polling vs event-driven), but simpler and still widely used.

### performance / powersave

Static governors: always select the maximum (performance) or minimum (powersave) frequency in the policy range. No utilization sampling at all.

```bash
# Use performance governor for latency-critical workloads
echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# Use powersave for battery/thermal savings
echo powersave | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
```

## cpufreq drivers

### acpi-cpufreq

Uses ACPI _PCT (Performance Control) and _PSS (Performance Supported States) objects to enumerate and switch P-states. The OS writes to MSR_IA32_PERF_CTL:

```c
/* drivers/cpufreq/acpi-cpufreq.c */
static void drv_write(struct acpi_cpufreq_data *data,
                      const struct cpumask *mask, u32 val)
{
    struct acpi_processor_performance *perf = to_perf_data(data);
    struct drv_cmd cmd = {
        .reg = &perf->control_register,
        .val = val,
        .func.write = data->cpu_freq_write,  /* usually writes MSR_IA32_PERF_CTL */
    };

    /* Runs do_drv_write() -> cmd.func.write() on every CPU in @mask */
    on_each_cpu_mask(mask, do_drv_write, &cmd, true);
}
```

### intel_pstate

Intel's native driver for Sandy Bridge and later. It bypasses the traditional governor hierarchy for CPUs with HWP (Hardware P-state control, Broadwell+):

```
Without HWP: intel_pstate governor → write PERF_CTL MSR every ~10ms
With HWP:    intel_pstate sets HWP_{MIN,MAX,EPP} once
             hardware manages frequency autonomously between min/max
```

```c
/* drivers/cpufreq/intel_pstate.c */
static void intel_pstate_hwp_set(unsigned int cpu)
{
    struct cpudata *cpu_data = all_cpu_data[cpu];
    int max, min;
    u64 value;
    s16 epp;

    max = cpu_data->max_perf_ratio;
    min = cpu_data->min_perf_ratio;
    if (cpu_data->policy == CPUFREQ_POLICY_PERFORMANCE)
        min = max;  /* pin to max in the "performance" policy */

    rdmsrq_on_cpu(cpu, MSR_HWP_REQUEST, &value);
    value &= ~HWP_MIN_PERF(~0L);
    value |= HWP_MIN_PERF(min);
    value &= ~HWP_MAX_PERF(~0L);
    value |= HWP_MAX_PERF(max);

    /* EPP itself comes from intel_pstate_get_epp() / epp_powersave,
     * not from the min/max perf ratios computed above */
    epp = intel_pstate_get_epp(cpu_data, value);
    /* ... encode epp into bits [31:24] of value, then: */
    wrmsrq_on_cpu(cpu, MSR_HWP_REQUEST, value);
}
```

There's no `HWP_DESIRED_PERF` field set here: leaving the MSR's desired-performance bits at 0 tells the hardware to autonomously pick between `HWP_MIN_PERF` and `HWP_MAX_PERF`.

#### Energy Performance Preference (EPP)

EPP is a hint to the hardware about the performance/power tradeoff:

| EPP value | Hint | Typical use |
|-----------|------|-------------|
| 0 | performance | latency-critical |
| 128 | balance_performance | default |
| 192 | balance_power | |
| 255 | power | battery saving |

```bash
# Read/write EPP for CPU 0
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference
# balance_performance

echo performance | sudo tee /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference
```

### ARM / cppc_cpufreq

ARM servers use ACPI CPPC (Collaborative Processor Performance Control) for firmware-assisted frequency scaling. Similar to HWP: the OS writes desired performance, firmware adjusts clocks.

## Frequency QoS (Quality of Service)

Devices and drivers can impose constraints on CPU frequency via the frequency QoS API:

```c
#include <linux/pm_qos.h>

/* Request minimum frequency of 1 GHz for a latency-sensitive device */
struct freq_qos_request req;
freq_qos_add_request(&policy->constraints, &req,
                     FREQ_QOS_MIN, 1000000 /* kHz */);

/* Later: remove constraint */
freq_qos_remove_request(&req);
```

Constraints from multiple requestors are combined (highest min / lowest max wins).

## C-states: idle power

Separate from P-states, C-states are CPU idle states (when there's no work):

| C-state | Name | Wake latency | Power saved |
|---------|------|-------------|-------------|
| C0 | Active | 0 | none |
| C1 | Halt | ~2µs | low |
| C1E | Enhanced halt | ~10µs | moderate |
| C3 | Sleep | ~70µs | high |
| C6 | Deep power down | ~85µs | highest |
| C10 | Deepest core idle | ~0.9ms | maximum |

(Figures are representative `intel_idle` values for a Skylake-class core, from `skl_cstates[]` in `drivers/idle/intel_idle.c`; exact numbers vary by CPU generation.)

Note that C10 here is a per-core ACPI C-state, distinct from **Modern Standby** (also called S0ix / Low Power Idle), which is a *platform-wide* low-power mode entered instead of S3 suspend when every core, and the chipset, agree conditions are met. Modern Standby is not part of the per-core C-state ladder and has its own, much coarser-grained latency budget — don't conflate the two.

The cpuidle subsystem selects C-states. The governor (`menu` or `teo`) predicts next wakeup time and picks the deepest C-state with acceptable latency.

```bash
# C-state statistics per CPU
grep . /sys/devices/system/cpu/cpu0/cpuidle/state*/name
grep . /sys/devices/system/cpu/cpu0/cpuidle/state*/usage
grep . /sys/devices/system/cpu/cpu0/cpuidle/state*/time  # microseconds

# Prevent deep C-states (latency-sensitive workloads)
# Set latency QoS: max allowed exit latency in µs
#
# /dev/cpu_dma_latency requires a *binary* 4-byte s32, not a decimal string:
# cpu_latency_qos_write() (kernel/power/qos.c) only string-parses a write
# when its length is NOT exactly sizeof(s32) == 4 bytes. "100\n" from
# `echo 100` is exactly 4 bytes, so it's reinterpreted as a raw binary value
# instead of the string "100" -- producing a garbage latency, not 100us.
# `sudo tee` also closes the fd right after writing, which drops the
# constraint immediately (it only lasts as long as the fd stays open).
sudo python3 -c "
import os, struct, time
fd = os.open('/dev/cpu_dma_latency', os.O_WRONLY)
os.write(fd, struct.pack('i', 100))  # binary s32: max 100us wakeup latency
time.sleep(3600)                     # keep the fd open -- closing it reverts the constraint
os.close(fd)
"
```

## Observing cpufreq

```bash
# Current frequencies (all CPUs)
grep MHz /proc/cpuinfo

# Frequency transition statistics
cat /sys/devices/system/cpu/cpu0/cpufreq/stats/time_in_state
# 800000   12345678   (freq_kHz  time_in_10ms_units)
# 1000000  8765432
# 2400000  1234567

cat /sys/devices/system/cpu/cpu0/cpufreq/stats/total_trans

# turbostat: per-CPU P-state and C-state distribution
sudo turbostat --interval 5

# perf: CPU frequency events
perf stat -e power/energy-pkg/,power/energy-cores/ sleep 10

# trace frequency transitions
echo 1 > /sys/kernel/tracing/events/power/cpu_frequency/enable
cat /sys/kernel/tracing/trace_pipe
# kworker/0:1-42 [000] cpu_frequency: state=2400000 cpu_id=0
```

## Further reading

### Kernel source

- [include/linux/cpufreq.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/cpufreq.h) — `struct cpufreq_policy`, `struct cpufreq_driver`, and the governor registration API
- [drivers/cpufreq/cpufreq.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/cpufreq/cpufreq.c) — the cpufreq core: policy lifecycle, sysfs, driver/governor registration
- [kernel/sched/cpufreq_schedutil.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/cpufreq_schedutil.c) — schedutil governor: `sugov_update_single_freq()`, `get_next_freq()`
- [drivers/cpufreq/intel_pstate.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/cpufreq/intel_pstate.c) — Intel's native driver, including `intel_pstate_hwp_set()` and EPP handling
- [drivers/cpufreq/acpi-cpufreq.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/cpufreq/acpi-cpufreq.c) — ACPI `_PSS`/`_PCT`-driven P-state switching via `drv_write()`
- [drivers/cpufreq/cppc_cpufreq.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/cpufreq/cppc_cpufreq.c) — ACPI CPPC driver used on ARM servers
- [include/linux/pm_qos.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pm_qos.h) — `freq_qos_add_request()` / `freq_qos_remove_request()` and `struct freq_qos_request`

### Related pages

- [cpuidle: CPU C-states](cpuidle.md) — the idle-time counterpart to cpufreq's active-time scaling
- [Runtime PM](runtime-pm.md) — device-level power management
- [System Suspend](suspend.md) — system-wide power states
- [Scheduler: EEVDF](../sched/eevdf.md) — schedutil reads utilization straight from the scheduler's per-CPU tracking

### LWN articles

- [LWN: Improvements in CPU frequency management](https://lwn.net/Articles/682391/) — covers the 4.7-cycle work that introduced the schedutil governor and its scheduler integration

### External

- [Documentation/admin-guide/pm/cpufreq.rst](https://docs.kernel.org/admin-guide/pm/cpufreq.html) — upstream CPUFreq subsystem admin guide: governors, drivers, sysfs interface
- [Documentation/admin-guide/pm/intel_pstate.rst](https://docs.kernel.org/admin-guide/pm/intel_pstate.html) — `intel_pstate` driver details: active/passive mode, HWP, EPP
