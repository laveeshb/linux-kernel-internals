# CPU Affinity

> Per-task CPU pinning: sched_setaffinity() and how it interacts with cpusets

## What CPU affinity controls

CPU affinity lets a task (or an admin) restrict which CPUs a specific task may run on. Unlike cpuset — which applies to an entire cgroup — affinity is **per-task**.

Common uses:
- **Cache locality**: Pin a task to CPUs sharing an L3 cache
- **Interrupt binding**: Keep a task on the same CPU as the NIC interrupt it processes
- **Benchmarking**: Eliminate CPU-to-CPU variation by pinning to one core
- **Real-time**: Reserve cores for latency-sensitive tasks

## The syscall

```c
// Restrict a task to specific CPUs
int sched_setaffinity(pid_t pid, size_t cpusetsize, const cpu_set_t *mask);

// Read a task's current affinity mask
int sched_getaffinity(pid_t pid, size_t cpusetsize, cpu_set_t *mask);
```

From the command line:

```bash
# Run a command pinned to CPUs 0 and 1
taskset -c 0,1 my_program

# Pin an existing process
taskset -cp 0,1 $PID

# Show current affinity
taskset -p $PID
# → pid 1234's current affinity mask: f  (CPUs 0-3 on a 4-core system)
```

## Kernel implementation

### The syscall path

```c
// kernel/sched/syscalls.c:1256
SYSCALL_DEFINE3(sched_setaffinity, pid_t, pid, unsigned int, len,
                unsigned long __user *, user_mask_ptr)
{
    cpumask_var_t new_mask;
    get_user_cpu_mask(user_mask_ptr, len, new_mask);  // copy from userspace
    return sched_setaffinity(pid, new_mask);
}
```

`sched_setaffinity()` validates the mask, checks permissions, and calls `__sched_setaffinity()` which calls `set_cpus_allowed_ptr()`.

### Affinity fields in task_struct

```c
// include/linux/sched.h
struct task_struct {
    // ...
    int            nr_cpus_allowed;  // popcount of cpus_ptr
    const cpumask_t *cpus_ptr;       // effective affinity (points to cpus_mask
                                     // or a temporary mask during migration)
    cpumask_t      *user_cpus_ptr;   // user-set affinity (NULL if not set)
    cpumask_t       cpus_mask;       // storage for cpus_ptr (usually)
    // ...
};
```

- `cpus_ptr` is what the scheduler reads. It normally points to `cpus_mask`.
- During temporary CPU restriction (e.g., migration helpers), `cpus_ptr` may point elsewhere.
- `user_cpus_ptr` tracks the user's requested mask, separate from any cpuset-imposed restrictions.

### Reading back affinity

```c
// kernel/sched/syscalls.c:1275
long sched_getaffinity(pid_t pid, struct cpumask *mask)
{
    // ...
    cpumask_and(mask, &p->cpus_mask, cpu_active_mask);
    // Note: intersects with active CPUs, excluding offline/hotplugged-out CPUs
}
```

The returned mask is always intersected with `cpu_active_mask` — offline CPUs are excluded even if they're in `cpus_mask`.

## Affinity and cpuset intersection

When a task is in a cpuset, the effective affinity is:

```
effective = user_affinity ∩ cpuset.effective_cpus
```

If you call `sched_setaffinity()` with a mask that includes CPUs outside the cpuset, those CPUs are silently excluded. The task cannot escape its cpuset through affinity.

```bash
# Example: task in a cpuset restricted to CPUs 4-7
taskset -cp 0-7 $PID      # try to use all CPUs
taskset -p $PID            # effective: only 4-7 (cpuset intersection)
```

The kernel stores both masks separately:
- `user_cpus_ptr`: what the user asked for
- `cpus_mask`: the intersection with cpuset (what's actually enforced)

This separation lets the kernel recompute the effective mask if the cpuset changes, without losing the user's original intent.

## Migration: what happens when affinity changes

When `set_cpus_allowed_ptr()` is called:

1. If the task's current CPU is still in the new mask → nothing changes immediately
2. If the current CPU is excluded → the task is migrated to an allowed CPU
3. Migration goes through `migration_cpu_stop()` — a stop-machine mechanism that runs on the target CPU to safely move the task

```bash
# Observe affinity-triggered migrations
perf stat -e migrations ./my_program
```

## Kernel threads and affinity

Kernel threads start with affinity set to all online CPUs (`cpu_all_mask`). You can restrict them:

```bash
# Pin kernel worker thread (e.g., kworker)
taskset -cp 0 $(pgrep "kworker/0:1")
```

Some kernel threads explicitly set their own affinity (e.g., interrupt threads, per-CPU kthreads) and resist external changes. Check `/proc/PID/status` for `Cpus_allowed`.

## NUMA-aware affinity

On NUMA systems, pinning to specific CPUs also affects memory allocation:

```bash
# Pin to NUMA node 1's CPUs (assuming CPUs 4-7 are on node 1)
taskset -c 4-7 ./my_program

# Better: use numactl to set both CPU and memory affinity
numactl --cpunodebind=1 --membind=1 ./my_program
```

`numactl` combines CPU affinity (`sched_setaffinity`) with NUMA memory policy (`set_mempolicy`). For NUMA-sensitive workloads, setting both is essential — pinning CPUs without pinning memory can still result in remote memory accesses.

## Checking affinity in /proc

```bash
# CPU affinity as a hex bitmask
cat /proc/$PID/status | grep Cpus_allowed
# → Cpus_allowed: 000f  (CPUs 0-3)
# → Cpus_allowed_list: 0-3  (human-readable)

# For threads in a process
for tid in /proc/$PID/task/*/; do
    echo -n "TID $(basename $tid): "
    cat ${tid}/status | grep Cpus_allowed_list
done
```

## Affinity vs cpuset vs scheduling domains

| Mechanism | Granularity | Scope | Hard limit? |
|-----------|-------------|-------|-------------|
| `sched_setaffinity` | Per-task | Selected CPUs | Yes — task never runs elsewhere |
| cpuset | Per-cgroup | Group of CPUs | Yes — intersected with all tasks |
| Sched domains | Global | Topology levels | No — affects load balancing preferences |
| `nice`/priority | Per-task | CPU time share | No — just affects scheduling preference |

## Further reading

- [cpuset](cpuset.md) — Group-level CPU restriction; intersects with per-task affinity
- [Scheduling Domains](sched-domains.md) — How load balancing respects topology
- [CPU Bandwidth Control](cpu-bandwidth.md) — Hard CPU time limits via cgroup quota
- [NUMA](../mm/numa.md) — Why NUMA node affinity matters alongside CPU affinity
