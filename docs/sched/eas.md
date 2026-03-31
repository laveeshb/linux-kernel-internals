# Energy-Aware Scheduling (EAS)

> Minimizing energy consumption on heterogeneous CPU topologies

## Motivation

On ARM big.LITTLE and Intel hybrid (P+E core) CPUs, different cores have different performance *and* energy characteristics. EAS was originally merged in Linux 5.0 for ARM big.LITTLE by Quentin Perret (ARM) — [`732cd75b8c92`](https://git.kernel.org/linus/732cd75b8c920d3727e69957b14faa7c2d7c3b75) ([patch series](https://lore.kernel.org/lkml/20181203095628.11858-1-quentin.perret@arm.com/), [LWN](https://lwn.net/Articles/772475/)). Intel hybrid (P+E core) support was added in Linux 6.16 by Rafael J. Wysocki — [`7b010f9b9061`](https://git.kernel.org/linus/7b010f9b906107ae4e5ac626329ab818b3f0a6b6).

```
ARM big.LITTLE:
  "big" cores (A76):   high performance, high power
  "LITTLE" cores (A55): low performance, low power

Intel Alder Lake:
  P-cores (Golden Cove): high performance, high power
  E-cores (Gracemont):   lower performance, lower power
```

A compute-intensive task should run on a big/P-core. An idle background task should park on a LITTLE/E-core. EAS makes this decision based on an energy model of the hardware.

## Energy model

The energy model describes the power consumption of each CPU at different utilization levels:

```c
/* include/linux/energy_model.h */
struct em_perf_state {
    unsigned long frequency;  /* kHz */
    unsigned long power;      /* mW */
    unsigned long cost;       /* power * max_freq / frequency (normalized) */
    unsigned long flags;
};

struct em_perf_domain {
    struct em_perf_state   *table;      /* performance states (P-states) */
    int                     nr_perf_states;
    unsigned long           flags;
    struct cpumask          cpus;       /* CPUs in this domain */
};
```

The energy model is registered by cpufreq drivers or device tree:

```c
/* drivers/cpufreq/cpufreq-dt.c (or ARM firmware) */
em_dev_register_perf_domain(cpu_dev, nr_states, &em_cb, cpumask, milliwatts);

/* em_cb.active_power(dev, freq, power) — power at given frequency */
/* em_cb.get_cost(dev, freq, cost) — optional: pre-compute cost */
```

## CPU capacity

EAS models each CPU's maximum compute capacity (normalized to 1024):

```c
/* Maximum capacity: fastest CPU = 1024 */
/* Each CPU has capacity_orig based on its max frequency */

/* arch/arm64/kernel/topology.c */
static void update_cpu_capacity(unsigned int cpu)
{
    unsigned long capacity = SCHED_CAPACITY_SCALE;  /* 1024 */

    /* Scale by frequency ratio vs max CPU in system */
    capacity *= per_cpu(cpu_scale, cpu);
    capacity >>= SCHED_CAPACITY_SHIFT;

    topology_set_cpu_scale(cpu, capacity);
}
```

A LITTLE core running at 1.0 GHz vs a big core at 2.5 GHz might have capacity 400 vs 1024.

## find_energy_efficient_cpu

The core EAS function selects the CPU that minimizes total system energy:

```c
/* kernel/sched/fair.c */
static int find_energy_efficient_cpu(struct task_struct *p, int prev_cpu)
{
    struct cpumask *pd_cpus;
    struct em_perf_domain *pd;
    long prev_delta = LONG_MAX, best_delta = LONG_MAX;
    unsigned long p_util_cfs = task_util_est(p);
    int best_energy_cpu = prev_cpu;

    /* For each performance domain (group of CPUs sharing frequency): */
    for_each_perf_domain(pd) {
        pd_cpus = em_span_cpus(pd);

        if (!cpumask_intersects(sched_domain_span(sd), pd_cpus))
            continue;

        /* Find the most energy-efficient CPU in this domain */
        for_each_cpu_and(cpu, pd_cpus, sched_domain_span(sd)) {
            long energy_delta = compute_energy(pd, cpu, p, prev_cpu);

            /* Does placing p on cpu reduce total energy? */
            if (cpu == prev_cpu)
                prev_delta = energy_delta;
            else if (energy_delta < best_delta) {
                best_delta    = energy_delta;
                best_energy_cpu = cpu;
            }
        }
    }

    /* Only switch if energy saving exceeds migration cost threshold (~6%) */
    if ((prev_delta - best_delta) > (prev_delta >> 4))
        return best_energy_cpu;

    return prev_cpu;  /* stay on previous CPU */
}
```

## compute_energy

Energy estimation for placing a task on a specific CPU:

```c
/* kernel/sched/fair.c */
static long compute_energy(struct em_perf_domain *pd, int cpu,
                             struct task_struct *p, int prev_cpu)
{
    struct em_perf_state *ps;
    unsigned long util_sum = 0;

    /* Sum utilization of all tasks that will be on CPUs in this domain */
    for_each_cpu(cpu_iter, em_span_cpus(pd)) {
        unsigned long util = cpu_util_next(cpu_iter, p, cpu);
        util_sum += util;
    }

    /* Find the performance state (P-state) needed to sustain util_sum */
    ps = em_pd_get_efficient_state(pd, util_sum, ..., pd->nr_perf_states);

    /* Energy = power * time
       Normalized: cost = power * max_freq / freq
       energy ≈ cost * util_sum */
    return em_cpu_energy(pd, ps, util_sum, ...);
}
```

## Capacity-aware wakeup

Before EAS runs its full energy computation, a simpler capacity check prevents placing a task on a CPU that's already saturated:

```c
/* Only run EAS if system is not overutilized */
static bool sched_energy_enabled(void)
{
    static u64 last_check;
    u64 now;

    /* Check if any CPU is overutilized */
    if (READ_ONCE(overutilized))
        return false;

    return true;
}

/* Per-CPU: is this CPU's capacity sufficient? */
static inline bool cpu_overutilized(int cpu)
{
    return !fits_capacity(cpu_util(cpu), capacity_of(cpu));
}
```

When the system is overutilized (some CPU at 100%), EAS falls back to the regular load balancer — energy optimization doesn't help when you're already maxed out.

## Schedutil + EAS interaction

EAS determines *which* CPU; schedutil determines *which frequency*:

```
1. EAS: place task on CPU that minimizes total system energy
2. schedutil: set frequency of that CPU based on utilization
   (freq = max_freq * util / capacity)
3. cpufreq driver: select actual P-state or HWP hint
```

```bash
# EAS is only enabled if schedutil governor is active
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
# schedutil  ← EAS active
# ondemand   ← EAS disabled (falls back to load balancing)
```

## Observing EAS

```bash
# Check if EAS is active
dmesg | grep -i "energy"
# sched: EAS: Energy Model successfully initialized

# CPU capacities
cat /sys/devices/system/cpu/cpu*/cpu_capacity
# 512 512 512 512 1024 1024 1024 1024
# (LITTLE cores at 512, big cores at 1024)

# Energy model per-domain
cat /sys/devices/system/cpu/cpu0/cpufreq/stats/time_in_state

# Task placement: which core type is each task using?
ps aux --sort=-%cpu | head -10
# Then check CPU affinity:
taskset -cp <pid>

# perf: energy events
perf stat -e power/energy-pkg/,power/energy-cores/ sleep 10

# Trace EAS decisions
echo 1 > /sys/kernel/tracing/events/sched/sched_find_energy_efficient_cpu/enable
cat /sys/kernel/tracing/trace_pipe

# Force a task to LITTLE cores only (for testing)
taskset -cp 0-3 <pid>  # pin to CPUs 0-3 (LITTLE cores)
```

## big.LITTLE Linux support

```bash
# Check asymmetric CPU topology
cat /sys/devices/system/cpu/cpu*/topology/physical_package_id
cat /sys/devices/system/cpu/cpu*/cpu_capacity

# ARM's sysfs for cluster info
cat /sys/devices/system/cpu/cpufreq/policy*/cpuinfo_max_freq

# Current energy model
for cpu in /sys/devices/system/cpu/cpu*/; do
    echo -n "$cpu: capacity "
    cat "$cpu/cpu_capacity" 2>/dev/null || echo "N/A"
done
```

## Thermal pressure

When a CPU is thermally throttled, its capacity is temporarily reduced. EAS accounts for this:

```c
/* drivers/base/arch_topology.c */
void arch_update_thermal_pressure(const struct cpumask *cpus,
                                   unsigned long capped_frequency)
{
    unsigned long max_freq, thermal_pressure;

    max_freq = per_cpu(freq_factor, cpu) * arch_max_freq_scale;

    /* thermal_pressure = capacity loss due to throttling */
    thermal_pressure = max_freq - capped_frequency;
    thermal_pressure = div_u64(thermal_pressure << SCHED_CAPACITY_SHIFT,
                                max_freq);

    /* Reduce effective capacity */
    WRITE_ONCE(per_cpu(thermal_pressure, cpu), thermal_pressure);
}
```

```bash
# Current thermal pressure per CPU
cat /sys/devices/system/cpu/cpu*/thermal_throttle/throttle_count
```

## Further reading

- [Load Balancing](load-balancing.md) — cross-CPU task migration
- [cpufreq: P-states](../power/cpufreq.md) — frequency selection, schedutil
- [Scheduler: EEVDF](eevdf.md) — per-CPU scheduling policy
- [Scheduler Domains](sched-domains.md) — topology construction for EAS
- `kernel/sched/fair.c` — `find_energy_efficient_cpu`
- `Documentation/scheduler/sched-energy.rst` in the kernel tree
