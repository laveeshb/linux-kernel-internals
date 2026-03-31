# Scheduler Tuning

> sysctl knobs, SCHED_FEAT flags, and common tuning patterns

## Scheduler sysctls

All scheduler tuning knobs live under `/proc/sys/kernel/`:

```bash
ls /proc/sys/kernel/sched_*
```

### Core timing knobs

```bash
# Minimum scheduling granularity (ns)
# Tasks run for at least this long before being preempted
# Default: 750000 (750µs), scales with CPU count
cat /proc/sys/kernel/sched_min_granularity_ns

# Base scheduling slice (ns) — the target time per task per period
# EEVDF uses this as the default slice per task
# Default: 700000 (700µs)
cat /proc/sys/kernel/sched_base_slice_ns

# Wakeup preemption granularity (ns)
# A waking task must be this much more "urgent" to preempt the current task
# Default: 1000000 (1ms)
cat /proc/sys/kernel/sched_wakeup_granularity_ns
```

The relationship: `sched_latency_ns ≥ nr_runnable × sched_min_granularity_ns` ensures each runnable task gets at least one slice per latency period.

### Migration and balancing

```bash
# Task migration cost (ns)
# If a task ran on its current CPU within this window, it's "cache hot"
# and the load balancer avoids migrating it
# Default: 500000 (500µs)
cat /proc/sys/kernel/sched_migration_cost_ns

# Max tasks to migrate in one load balance call
# Default: 32
cat /proc/sys/kernel/sched_nr_migrate

# CFS bandwidth slice (µs)
# Amount of quota a CPU grabs from the global bandwidth pool at once
# Default: 5000 (5ms)
cat /proc/sys/kernel/sched_cfs_bandwidth_slice_us
```

### RT throttling

```bash
# RT task period (µs): how often RT tasks' quota is refreshed
# Default: 1000000 (1 second)
cat /proc/sys/kernel/sched_rt_period_us

# RT task runtime (µs): how much of the period RT tasks can consume
# Default: 950000 (950ms = 95% of period)
# -1 = unlimited (disables RT throttling — dangerous)
cat /proc/sys/kernel/sched_rt_runtime_us
```

### Schedstat

```bash
# Enable per-task scheduling statistics (slight overhead)
# Default: 0 (disabled)
echo 1 > /proc/sys/kernel/sched_schedstats
```

## SCHED_FEAT: compile-time feature toggles

`SCHED_FEAT` flags are booleans controlling specific scheduler behaviors. In a kernel with `CONFIG_SCHED_DEBUG`, they can be toggled at runtime:

```bash
# View all features and their current state
cat /sys/kernel/debug/sched/features
# PLACE_LAG PLACE_DEADLINE_INITIAL PLACE_REL_DEADLINE RUN_TO_PARITY
# PREEMPT_SHORT PICK_BUDDY CACHE_HOT_BUDDY DELAY_DEQUEUE DELAY_ZERO
# WAKEUP_PREEMPTION ...

# Toggle a feature
echo NO_WAKEUP_PREEMPTION > /sys/kernel/debug/sched/features  # disable
echo WAKEUP_PREEMPTION > /sys/kernel/debug/sched/features      # enable
```

Key features:

| Feature | Default | Effect |
|---------|---------|--------|
| `WAKEUP_PREEMPTION` | on | Waking task can preempt the current task if it has an earlier deadline |
| `PLACE_LAG` | on | Adjust woken task's vruntime based on its lag (how much CPU it's owed) |
| `PLACE_DEADLINE_INITIAL` | on | Give newly enqueued tasks an initial deadline advantage |
| `CACHE_HOT_BUDDY` | on | Don't preempt a cache-hot task just because it's been running |
| `NEXT_BUDDY` | off | After preemption, try to run the task that just woke up |
| `HRTICK` | off | Use hrtimers for precise preemption at timeslice expiry (more accurate, slightly higher overhead) |
| `TTWU_QUEUE` | arch | Queue cross-CPU wakeups (reduces IPI storms) |
| `RT_RUNTIME_SHARE` | on | Allow RT tasks to borrow runtime from sibling CPUs |

## Common tuning scenarios

### Latency-sensitive workloads (network, trading, audio)

```bash
# Reduce minimum granularity: tasks get smaller slices, lower max latency
echo 500000 > /proc/sys/kernel/sched_min_granularity_ns     # 500µs (default 750µs)
echo 700000 > /proc/sys/kernel/sched_base_slice_ns           # keep at default

# Reduce wakeup granularity: waking tasks preempt more aggressively
echo 500000 > /proc/sys/kernel/sched_wakeup_granularity_ns  # 500µs (default 1ms)

# Reduce migration cost: allow more migration (less cache-hot protection)
echo 250000 > /proc/sys/kernel/sched_migration_cost_ns      # 250µs (default 500µs)
```

### Throughput-oriented workloads (batch processing, HPC)

```bash
# Increase minimum granularity: tasks run longer before preemption
echo 4000000 > /proc/sys/kernel/sched_min_granularity_ns   # 4ms

# Increase migration cost: keep tasks cache-hot, fewer migrations
echo 5000000 > /proc/sys/kernel/sched_migration_cost_ns    # 5ms

# Allow more tasks to migrate per balance call
echo 64 > /proc/sys/kernel/sched_nr_migrate
```

### Real-time workloads (SCHED_FIFO/RR tasks)

```bash
# Ensure RT tasks get priority over CFS (default: 95%)
cat /proc/sys/kernel/sched_rt_runtime_us  # should be 950000

# For isolated RT cores (combined with cpuset isolation):
# Disable RT throttling on dedicated cores — RT tasks need guaranteed time
# WARNING: only safe if RT tasks are well-behaved and CPU is fully dedicated
echo -1 > /proc/sys/kernel/sched_rt_runtime_us  # disable throttling globally

# Better: use per-cgroup RT limit
echo 950000 > /sys/fs/cgroup/rt_group/cpu.rt_runtime_us   # runtime in µs
echo 1000000 > /sys/fs/cgroup/rt_group/cpu.rt_period_us   # period in µs
```

### Container/cgroup isolation

```bash
# Give a container 2 CPUs (200ms quota / 100ms period)
echo "200000 100000" > /sys/fs/cgroup/containers/myapp/cpu.max

# Reduce bandwidth slice for tighter throttle response (at cost of more lock contention)
echo 1000 > /proc/sys/kernel/sched_cfs_bandwidth_slice_us  # 1ms (default 5ms)
```

## CPU isolation for RT/low-latency

For truly latency-sensitive tasks, isolate CPUs from the kernel scheduler entirely:

```bash
# Boot parameter: remove CPUs 4-7 from general scheduling
# Add to /etc/default/grub: GRUB_CMDLINE_LINUX="isolcpus=4-7 nohz_full=4-7 rcu_nocbs=4-7"

# At runtime: pin tasks to isolated CPUs
taskset -c 4 ./latency_sensitive_app

# Check isolation status
cat /sys/devices/system/cpu/isolated  # → 4-7
cat /sys/devices/system/cpu/nohz_full # → 4-7
```

`isolcpus` removes CPUs from the load balancer. `nohz_full` disables the scheduler tick on those CPUs (tasks run without periodic interruption). `rcu_nocbs` offloads RCU callbacks to other CPUs.

## Diagnosing tuning effects

```bash
# Measure scheduling latency before and after
perf sched latency -- sleep 10

# Count preemptions (involuntary switches)
perf stat -e cs ./workload 2>&1 | grep "context-switches"

# Watch runqueue length (high = tasks waiting)
runqlen 10  # from BCC toolkit, sample every 10ms

# Check if tasks are being throttled (CFS bandwidth)
watch -n 1 'cat /sys/fs/cgroup/myapp/cpu.stat | grep throttled'
```

## Observability checklist

Before tuning, establish a baseline:

1. **Are tasks waiting long?** → `perf sched latency` or `runqlat`
2. **Excessive migrations?** → `perf stat -e cpu-migrations` or `schedstat`
3. **CFS bandwidth throttling?** → `cpu.stat nr_throttled/nr_periods`
4. **RT task monopolizing CPU?** → `htop` or `perf top` showing high RT%
5. **NUMA inefficiency?** → `numastat`, `perf stat -e cache-misses`

## Further reading

- [Scheduler Statistics](schedstat.md) — What to measure before tuning
- [Scheduler Tracing](sched-tracing.md) — Real-time observation tools
- [CPU Bandwidth Control](cpu-bandwidth.md) — CFS quota/throttle tuning
- [cpuset](cpuset.md) — CPU isolation for low-latency workloads
- [EEVDF](eevdf.md) — How the slice/deadline parameters affect task selection
