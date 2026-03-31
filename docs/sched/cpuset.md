# cpuset: CPU and Memory Pinning

> How cgroups restrict which CPUs and NUMA nodes tasks can use

## What cpuset controls

`cpuset` is a cgroup subsystem that restricts which CPUs and NUMA memory nodes a group of tasks can use. It operates independently from CPU bandwidth and weight:

- **Bandwidth** (cpu.max): How much CPU time a group gets
- **Weight** (cpu.weight/shares): How CPU time is divided between groups
- **cpuset**: Which CPUs are even eligible — tasks never run on excluded CPUs

This matters for:
- **NUMA locality**: Pin tasks to CPUs close to their memory
- **Core isolation**: Reserve specific cores for latency-sensitive workloads
- **Hardware partitioning**: Assign CPUs to dedicated containers

## Interface

```bash
# v2 (unified hierarchy)
ls /sys/fs/cgroup/mygroup/
# cpuset.cpus              - requested CPU list
# cpuset.mems              - requested NUMA node list
# cpuset.cpus.effective    - actual CPUs after intersection with parent
# cpuset.mems.effective    - actual NUMA nodes after intersection with parent
# cpuset.cpus.exclusive    - CPUs exclusively reserved for this cgroup
# cpuset.cpus.partition    - partition root control (member/root/isolated)

# Pin a cgroup to CPUs 0-3 and NUMA node 0
echo "0-3" > /sys/fs/cgroup/mygroup/cpuset.cpus
echo "0"   > /sys/fs/cgroup/mygroup/cpuset.mems

# v1 (separate mount)
echo "0-3" > /sys/fs/cgroup/cpuset/mygroup/cpus
echo "0"   > /sys/fs/cgroup/cpuset/mygroup/mems
```

## struct cpuset

Each cgroup maps to a `cpuset` in `kernel/cgroup/cpuset-internal.h`:

```c
// kernel/cgroup/cpuset-internal.h
struct cpuset {
    struct cgroup_subsys_state css;  // embedded cgroup state

    unsigned long flags;             // CS_CPU_EXCLUSIVE, CS_MEM_EXCLUSIVE, etc.

    // User-configured masks (written via control files)
    cpumask_var_t cpus_allowed;
    nodemask_t    mems_allowed;

    // Effective masks (actual limits applied to tasks)
    // effective = configured & parent's effective
    cpumask_var_t effective_cpus;
    nodemask_t    effective_mems;

    // Exclusive CPUs (v2 partition support)
    cpumask_var_t effective_xcpus;  // effective exclusive CPUs granted
    cpumask_var_t exclusive_cpus;   // user-requested exclusive CPUs

    int partition_root_state;       // PRS_MEMBER/ROOT/ISOLATED or negative = invalid
    int nr_deadline_tasks;          // SCHED_DEADLINE tasks in this cpuset

    // ...
};
```

### Flags

```c
typedef enum {
    CS_CPU_EXCLUSIVE,      // No sibling cgroup can overlap these CPUs
    CS_MEM_EXCLUSIVE,      // No sibling cgroup can overlap these NUMA nodes
    CS_MEM_HARDWALL,       // User allocations cannot use other nodes (even as fallback)
    CS_MEMORY_MIGRATE,     // Migrate pages when mems_allowed changes
    CS_SCHED_LOAD_BALANCE, // Enable load balancing across cpuset CPUs
    CS_SPREAD_PAGE,        // Spread page cache across all allowed nodes
    CS_SPREAD_SLAB,        // Spread slab cache across all allowed nodes
} cpuset_flagbits_t;
```

## Effective masks: intersection with parent

The key cpuset invariant: a child's **effective_cpus** can only be a subset of its parent's **effective_cpus**. If you write a CPU list that includes CPUs not in the parent's effective set, those CPUs are silently excluded.

```
root cpuset: effective_cpus = {0,1,2,3,4,5,6,7}
    └── mygroup: cpus_allowed = {4,5,6,7,8,9}
                 effective_cpus = {4,5,6,7}  ← intersection with parent
```

```c
// kernel/cgroup/cpuset.c (simplified)
static void cpuset_cpus_allowed(struct task_struct *p, struct cpumask *pmask)
{
    struct cpuset *cs = task_cs(p);
    // Walk up the hierarchy until we find a non-empty intersection
    while (!cpumask_intersects(cs->effective_cpus, pmask))
        cs = parent_cs(cs);
    cpumask_and(pmask, pmask, cs->effective_cpus);
}
```

## How tasks are constrained

When a task is added to a cgroup (`cgroup.procs`), or when the cpuset's effective_cpus changes, the kernel updates the task's affinity:

1. `cpuset_change_task_nodemask()` — updates NUMA node policy
2. `set_cpus_allowed_ptr()` — restricts the task to `effective_cpus`
3. If the task is currently running on an excluded CPU, it gets migrated

Tasks in a cpuset can still set their own affinity (via `sched_setaffinity()`), but the result is always **intersected** with the cpuset's effective_cpus. You can't escape the cpuset through affinity.

## Partition roots (v2)

v2 cpusets support **partition roots** — a mechanism to carve CPUs out of the parent's scheduling domain entirely:

```bash
# Create a partition: take CPUs 4-7 exclusively
echo "4-7" > /sys/fs/cgroup/mygroup/cpuset.cpus
echo "root" > /sys/fs/cgroup/mygroup/cpuset.cpus.partition
# CPUs 4-7 are now removed from the parent's scheduling domain
# and form an isolated domain for mygroup

# Isolated partition: no load balancing within the partition either
echo "isolated" > /sys/fs/cgroup/mygroup/cpuset.cpus.partition
```

Partition states:
- `member` (default): Normal cpuset, shares parent's scheduling domain
- `root`: Carves out CPUs into a dedicated scheduling domain
- `isolated`: Like root, but also disables load balancing within the partition

## cpuset and scheduler domains

When a partition root is created or CPUs are assigned exclusively, the kernel **rebuilds the scheduling domains**:

```c
// kernel/cgroup/cpuset.c
// After effective_cpus changes:
rebuild_sched_domains();  // or rebuild_sched_domains_locked()
```

This is expensive — each rebuild tears down and reconstructs per-CPU scheduler domain hierarchies. Avoid frequent cpuset CPU changes in production.

## NUMA: mems_allowed

`effective_mems` controls which NUMA nodes memory allocations can use:

```bash
# Restrict to node 0 only
echo "0" > /sys/fs/cgroup/mygroup/cpuset.mems

# Allow nodes 0 and 1
echo "0-1" > /sys/fs/cgroup/mygroup/cpuset.mems
```

With `CS_MEM_HARDWALL` set, tasks cannot fall back to other nodes even if their allowed nodes are full. Without it, the kernel may allocate from other nodes under memory pressure.

With `CS_MEMORY_MIGRATE` set, existing pages are migrated to the new node set when `mems_allowed` changes.

## Diagnosing cpuset constraints

```bash
# See a task's cpuset
cat /proc/$PID/cpuset
# → /mygroup/container1

# Effective CPUs for a cgroup
cat /sys/fs/cgroup/mygroup/cpuset.cpus.effective

# Check if a task's affinity is being constrained by cpuset
taskset -p $PID  # shows the intersection of user affinity and cpuset

# Monitor cpuset events (cpu hotplug, partition changes)
cat /sys/kernel/debug/tracing/events/cpuset/
```

```bash
# Common mistake: writing CPUs not in parent's effective set
echo "0-7" > /sys/fs/cgroup/nested/cpuset.cpus
cat /sys/fs/cgroup/nested/cpuset.cpus.effective
# → 0-3   (silently clamped to parent's range)
```

## cpuset vs sched_setaffinity

| Mechanism | Who controls | Scope | Inheritable |
|-----------|-------------|-------|-------------|
| cpuset | cgroup admin | All tasks in cgroup | Yes — children inherit |
| sched_setaffinity | Process (CAP_SYS_NICE for others) | One task | No |

The effective affinity is always `user_affinity ∩ cpuset.effective_cpus`. If either restricts a CPU, the task cannot run there.

## Further reading

- [CPU cgroup: v1 vs v2](cpu-cgroup.md) — CPU bandwidth and weight controls
- [Scheduling Domains](sched-domains.md) — How cpuset partition roots affect load balancing
- [CPU Affinity](cpu-affinity.md) — Per-task CPU restrictions via sched_setaffinity
- [NUMA](../mm/numa.md) — Why NUMA node pinning matters for performance
