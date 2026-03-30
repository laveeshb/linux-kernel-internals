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

    struct cpufreq_driver *driver;

    struct freq_qos_request *min_freq_req;
    struct freq_qos_request *max_freq_req;
};
```

## Governors

A governor observes CPU utilization and selects a target frequency.

### schedutil (recommended, 4.7+)

schedutil integrates with the scheduler's per-CPU utilization tracking. It's called directly from the scheduler path when utilization changes — no polling needed.

```c
/* drivers/cpufreq/schedutil.c */
static void sugov_update_single_freq(struct update_util_data *hook, u64 time,
                                      unsigned int flags)
{
    struct sugov_cpu *sg_cpu = container_of(hook, struct sugov_cpu, update_util);
    struct sugov_policy *sg_policy = sg_cpu->sg_policy;
    unsigned int cached_freq = sg_policy->cached_raw_freq;
    unsigned int next_f;

    /* Get utilization signal from scheduler */
    sugov_get_util(sg_cpu);
    sugov_iowait_apply(sg_cpu, time);

    /* Map utilization → target frequency */
    next_f = get_next_freq(sg_policy, sg_cpu->util, sg_cpu->max);

    /* Apply rate limiting (don't change too often) */
    if (!sugov_update_next_freq(sg_policy, time, next_f))
        return;

    sugov_fast_switch(sg_policy, time, next_f);
}

static unsigned int get_next_freq(struct sugov_policy *sg_policy,
                                   unsigned long util, unsigned long max)
{
    struct cpufreq_policy *policy = sg_policy->policy;
    unsigned int freq = arch_scale_freq_invariant() ?
                        policy->cpuinfo.max_freq : policy->cur;

    /*
     * Scale: freq = max_freq * (util / max)
     * With 25% margin for responsiveness: util * 1.25
     */
    util = map_util_perf(util);
    freq = map_util_freq(util, freq, max);

    if (freq == sg_policy->cached_raw_freq && !sg_policy->need_freq_update)
        return sg_policy->next_freq;

    sg_policy->cached_raw_freq = freq;
    return cpufreq_driver_resolve_freq(policy, freq);
}
```

### ondemand

Polls CPU idle time periodically (default 10ms), scales frequency proportionally to non-idle fraction:

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

Uses ACPI _PCT (performance control) and _PSS (P-state supported) objects to enumerate and switch P-states. The OS writes to MSR_IA32_PERF_CTL:

```c
/* drivers/cpufreq/acpi-cpufreq.c */
static void drv_write(struct acpi_cpufreq_data *data,
                       const struct cpumask *mask, u32 val)
{
    /* Write target P-state to performance control MSR */
    wrmsr_on_cpus(mask, MSR_IA32_PERF_CTL, val);
}
```

### intel_pstate

Intel's native driver for Sandy Bridge and later. It bypasses the traditional governor hierarchy for CPUs with HWP (Hardware P-state control, Broadwell+):

```
Without HWP: intel_pstate governor → write PERF_CTL MSR every ~10ms
With HWP:    intel_pstate sets HWP_{MIN,MAX,DESIRED,EPP} once
             hardware manages frequency autonomously
```

```c
/* drivers/cpufreq/intel_pstate.c */
static void intel_pstate_hwp_set(unsigned int cpu)
{
    struct cpudata *cpu_data = all_cpu_data[cpu];
    int max, min, desired, epp;

    max     = cpu_data->max_perf_ratio;
    min     = cpu_data->min_perf_ratio;
    desired = 0;  /* let hardware decide between min and max */
    epp     = cpu_data->epp_policy; /* Energy Performance Preference */

    /* Pack into HWP_REQUEST MSR */
    wrmsrl_on_cpu(cpu, MSR_HWP_REQUEST,
        HWP_MIN_PERF(min) | HWP_MAX_PERF(max) |
        HWP_DESIRED_PERF(desired) | HWP_ENERGY_PERF_PREFERENCE(epp));
}
```

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
| C1 | Halt | ~1µs | low |
| C1E | Enhanced halt | ~1µs | moderate |
| C3 | Sleep | ~100µs | high |
| C6 | Deep power down | ~200µs | highest |
| C10 | Modern standby | ~10ms | maximum |

The cpuidle subsystem selects C-states. The governor (`menu` or `teo`) predicts next wakeup time and picks the deepest C-state with acceptable latency.

```bash
# C-state statistics per CPU
grep . /sys/devices/system/cpu/cpu0/cpuidle/state*/name
grep . /sys/devices/system/cpu/cpu0/cpuidle/state*/usage
grep . /sys/devices/system/cpu/cpu0/cpuidle/state*/time  # microseconds

# Prevent deep C-states (latency-sensitive workloads)
# Set latency QoS: max allowed exit latency in µs
echo 100 | sudo tee /dev/cpu_dma_latency  # hold fd open
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

- [Runtime PM](runtime-pm.md) — device-level power management
- [System Suspend](suspend.md) — system-wide power states
- [Scheduler: EEVDF](../sched/eevdf.md) — schedutil integrates with scheduler utilization
- `drivers/cpufreq/` in the kernel tree — governor and driver implementations
- `Documentation/admin-guide/pm/cpufreq.rst` in the kernel tree
