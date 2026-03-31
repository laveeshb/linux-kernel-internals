# Scheduling Domains

> How the kernel organizes CPUs into a hierarchy for load balancing

## What scheduling domains are

The Linux scheduler doesn't just balance load between individual CPUs — it uses a hierarchical topology that reflects the hardware: SMT siblings, CPU cores, NUMA sockets. This hierarchy is called the **scheduling domain tree**.

Each level in the tree is a `sched_domain` spanning a set of CPUs. When load balancing runs, it works domain by domain, from narrowest (SMT) to widest (NUMA), respecting topology boundaries.

This matters because:
- Moving a task between SMT siblings is cheap (shared L1/L2 cache)
- Moving between NUMA sockets is expensive (remote memory access)
- The scheduler should balance aggressively at the cheap levels and conservatively at the expensive ones

## struct sched_domain

```c
// include/linux/sched/topology.h
struct sched_domain {
    struct sched_domain __rcu *parent;   // broader domain (e.g., NUMA above MC)
    struct sched_domain __rcu *child;    // narrower domain (e.g., SMT below MC)
    struct sched_group *groups;          // circular list of sched_groups in this domain

    unsigned long min_interval;          // minimum balance interval (ms)
    unsigned long max_interval;          // maximum balance interval (ms)
    unsigned int  imbalance_pct;         // tolerate up to X% imbalance before balancing
    unsigned int  cache_nice_tries;      // leave hot tasks alone for this many tries

    int flags;                           // SD_* flags controlling balance behavior
    int level;                           // 0=SMT, 1=MC, 2=PKG, 3=NUMA, ...

    unsigned long last_balance;          // last time balance ran (jiffies)
    unsigned int  balance_interval;      // current adaptive interval

    // per-CPU pointer (accessed via rcu)
    // ...
};
```

### SD_* flags

Flags control what load balancing is enabled at each domain level:

```c
// include/linux/sched/sd_flags.h
SD_LOAD_BALANCE     // Enable load balancing at this level
SD_BALANCE_NEWIDLE  // Balance when a CPU goes idle
SD_BALANCE_EXEC     // Balance when exec() is called (new task)
SD_BALANCE_FORK     // Balance when fork() creates a task
SD_WAKE_AFFINE      // Keep recently woken tasks on wake-up CPU
SD_ASYM_CPUCAPACITY // Domain spans CPUs of different capacity (big.LITTLE)
SD_SHARE_PKG_RESOURCES  // CPUs share last-level cache
SD_NUMA             // Domain crosses NUMA node boundary
SD_OVERLAP          // Domain can overlap with siblings (NUMA)
```

## The topology hierarchy

The default topology levels (from narrowest to broadest):

```
NUMA (node 0)  ←────────────────────────────┐
│                                           │
└── PKG (socket 0)       PKG (socket 1) ───┘
    │                    │
    └── MC (core 0-3)    └── MC (core 4-7)
        │
        └── SMT (core 0: cpu0, cpu1)
```

Per-CPU pointers give quick access to specific levels:

```c
// kernel/sched/topology.c
DEFINE_PER_CPU(struct sched_domain __rcu *, sd_llc);      // Last Level Cache domain
DEFINE_PER_CPU(struct sched_domain_shared __rcu *, sd_llc_shared);
DEFINE_PER_CPU(struct sched_domain __rcu *, sd_numa);     // NUMA domain
DEFINE_PER_CPU(struct sched_domain __rcu *, sd_asym_packing);
DEFINE_PER_CPU(struct sched_domain __rcu *, sd_asym_cpucapacity);
```

### struct sched_domain_topology_level

Architecture code defines topology by providing a list of levels:

```c
// kernel/sched/topology.c
static struct sched_domain_topology_level default_topology[] = {
#ifdef CONFIG_SCHED_SMT
    { cpu_smt_mask, cpu_smt_flags, SD_INIT_NAME(SMT) },   // Hyperthreading siblings
#endif
#ifdef CONFIG_SCHED_CLUSTER
    { cpu_clustergroup_mask, cpu_cluster_flags, SD_INIT_NAME(CLS) }, // CPU cluster
#endif
#ifdef CONFIG_SCHED_MC
    { cpu_coregroup_mask, cpu_core_flags, SD_INIT_NAME(MC) },  // Cores sharing L2/L3
#endif
    { cpu_cpu_mask, NULL, SD_INIT_NAME(PKG) },             // Physical socket/package
    { NULL, },
};
```

NUMA levels are added on top by `sched_init_numa()` based on ACPI SRAT data.

## Building domains: build_sched_domains()

When topology changes (boot, CPU hotplug, cpuset partition), the kernel rebuilds the domain tree:

```c
// kernel/sched/topology.c
static int build_sched_domains(const struct cpumask *cpu_map,
                                struct sched_domain_attr *attr)
{
    // For each CPU in cpu_map:
    //   for each topology level:
    //     sd_init() — allocate and initialize a sched_domain
    //     connect parent/child pointers
    //     assign to per-CPU sd pointer
    // Then:
    //   build_sched_groups() — connect CPUs into sched_groups per domain
    //   cpu_attach_domain() — install new domains (RCU-swap old ones)
}
```

This is called via `rebuild_sched_domains()`, which is triggered by:
- `sched_domain_sysctl` changes
- CPU hotplug events
- cpuset partition root changes

## Load balancing: sched_balance_rq()

Load balancing happens in `sched_balance_rq()` (previously `load_balance()`), called periodically by the scheduler tick and when a CPU goes idle:

```
Idle CPU → sched_balance_rq()
    Walk from narrowest domain to broadest:
    ├── SMT domain: too few tasks? steal from sibling HT
    ├── MC domain: unbalanced across cores? pull tasks
    ├── PKG domain: cross-socket imbalance? migrate tasks
    └── NUMA domain: large imbalance across nodes? migrate
```

Key principle: **start at the narrowest domain first**. If there's enough work within the MC domain, don't cross the PKG boundary. NUMA migrations are last resort.

### Idle load balancing

When a CPU runs out of work, it enters `newidle_balance()`:

```c
// kernel/sched/fair.c
static int newidle_balance(struct rq *this_rq, struct rq_flags *rf)
{
    // Walk domains from narrowest outward
    for_each_domain(this_cpu, sd) {
        if (!(sd->flags & SD_BALANCE_NEWIDLE))
            continue;

        pulled_tasks = sched_balance_rq(this_rq, rf, sd,
                                         CPU_NEWLY_IDLE, &continue_balancing);
        if (pulled_tasks)
            break;  // Found work at this level, stop
    }
}
```

### Periodic balancing

The scheduler tick triggers `sched_balance_softirq()` every `balance_interval` jiffies. The interval adapts: if recent balancing found no imbalance, `balance_interval` doubles (up to `max_interval`) to reduce overhead. When imbalance is found, it resets to `min_interval`.

## Viewing domain topology

```bash
# /proc/schedstat shows per-domain statistics (requires CONFIG_SCHEDSTATS)
cat /proc/schedstat

# sched_debug shows the full domain tree
cat /proc/sched_debug | grep -A 20 "domain"

# Per-CPU domain info
cat /sys/kernel/debug/sched/domains/cpu0/domain0/name   # "MC"
cat /sys/kernel/debug/sched/domains/cpu0/domain0/flags
cat /sys/kernel/debug/sched/domains/cpu0/domain1/name   # "PKG"
```

## Domain isolation with cpuset

cpuset partition roots **break** the scheduling domain tree. When you create a partition root with CPUs 4-7:

1. Those CPUs are removed from the parent's domain
2. `rebuild_sched_domains()` is called
3. A new isolated domain tree is built for CPUs 4-7
4. Load balancing no longer crosses the partition boundary

This is how container runtimes pin VMs or containers to exclusive CPU sets with no interference from the host scheduler.

## Asymmetric CPU capacity (big.LITTLE)

On ARM systems with heterogeneous CPUs (Cortex-A55 + Cortex-A78), the `SD_ASYM_CPUCAPACITY` flag marks domains spanning CPUs of different compute capacity. The scheduler tracks CPU capacity via `cpu_capacity` and uses Energy Aware Scheduling (EAS) to prefer placing tasks on appropriately-sized CPUs.

```bash
# View per-CPU capacity (normalized, 1024 = maximum)
cat /sys/devices/system/cpu/cpu*/cpu_capacity
```

## Further reading

- [cpuset](cpuset.md) — How cpuset partition roots interact with sched domains
- [CPU Affinity](cpu-affinity.md) — Per-task affinity and its relationship to domains
- [CFS](cfs.md) — The fair scheduler that load balancing serves
- [NUMA](../mm/numa.md) — Why cross-node migrations are expensive
