# Scheduler Statistics

> /proc/schedstat, /proc/PID/schedstat, and the sched_statistics structure

## What schedstat tracks

The kernel accumulates per-task and per-CPU scheduling statistics under `CONFIG_SCHEDSTATS`. These tell you how long tasks wait, how long they sleep, how often they migrate, and what's happening in the load balancer.

Schedstat is the first place to look when diagnosing scheduling anomalies: excessive wait times, unexpected migrations, or load imbalance.

## Enabling schedstat

```bash
# Check if enabled (runtime toggle since 4.6)
cat /proc/sys/kernel/sched_schedstats
# 0 = disabled (default — saves ~5% on scheduler overhead)
# 1 = enabled

# Enable at runtime
echo 1 > /proc/sys/kernel/sched_schedstats

# Or boot with schedstats=enable
```

Without `CONFIG_SCHEDSTATS`, the fields exist but are always zero. Most production kernels have `CONFIG_SCHEDSTATS` compiled in but disabled by default via the sysctl.

## Per-task statistics: /proc/PID/schedstat

```bash
cat /proc/$PID/schedstat
# Three space-separated fields:
# 1. CPU time (ns): total time running on CPU
# 2. Wait time (ns): total time runnable but waiting for CPU
# 3. Timeslices: number of times the task was scheduled
```

Example:

```bash
cat /proc/$$/schedstat
# 1234567890 98765432 1042
# → ran 1.23s, waited 98.7ms, scheduled 1042 times
```

### The sched_statistics struct

These statistics are stored in `struct sched_entity` (embedded in `task_struct`):

```c
// include/linux/sched.h (CONFIG_SCHEDSTATS)
struct sched_statistics {
    // Runqueue wait time
    u64  wait_start;      // timestamp when task last entered runqueue
    u64  wait_max;        // maximum wait time observed
    u64  wait_count;      // number of times task waited on runqueue
    u64  wait_sum;        // total wait time (ns)
    u64  iowait_count;    // number of I/O waits
    u64  iowait_sum;      // total I/O wait time (ns)

    // Sleep time (voluntary block)
    u64  sleep_start;
    u64  sleep_max;
    s64  sum_sleep_runtime;

    // Block time (involuntary, e.g., page fault)
    u64  block_start;
    u64  block_max;
    s64  sum_block_runtime;

    // Scheduling slice stats
    s64  exec_max;        // longest single execution burst (ns)
    u64  slice_max;       // longest scheduler slice used

    // Migration stats
    u64  nr_migrations_cold;            // migrated but cache was cold
    u64  nr_failed_migrations_affine;   // couldn't migrate due to affinity
    u64  nr_failed_migrations_running;  // target was running
    u64  nr_failed_migrations_hot;      // task was cache-hot, left alone
    u64  nr_forced_migrations;          // affinity was overridden

    // Wakeup stats
    u64  nr_wakeups;
    u64  nr_wakeups_sync;     // wakeup from WF_SYNC (producer-consumer)
    u64  nr_wakeups_migrate;  // wakeup caused a migration
    u64  nr_wakeups_local;    // woke up on local CPU
    u64  nr_wakeups_remote;   // woke up on remote CPU
    u64  nr_wakeups_affine;   // woke up on CPU due to affinity hint
};
```

## Per-CPU statistics: /proc/schedstat

```bash
cat /proc/schedstat
# version 15
# timestamp 12345678901234
# cpu0 0 0 0 0 0 0 123456789 987654321 42
# cpu1 0 0 0 0 0 0 ...
# domain0 00000003 0 0 0 0 0 0 ...
```

### CPU line fields (v15 format)

```
cpu<N> yld_count sched_count sched_goidle ttwu_count ttwu_local \
       rq_cpu_time run_delay pcount
```

| Field | Description |
|-------|-------------|
| `yld_count` | Times sched_yield() was called |
| `sched_count` | Times __schedule() was called |
| `sched_goidle` | Times __schedule() went to idle |
| `ttwu_count` | try_to_wake_up() calls |
| `ttwu_local` | Wakeups on local CPU |
| `rq_cpu_time` | Total time on runqueue (ns) |
| `run_delay` | Total wait time before running (ns) |
| `pcount` | Tasks scheduled |

### Domain line fields

Each `domain<N>` line shows load balancer statistics for that scheduling domain on that CPU:

```
domain<N> cpumask lb_count[idle] lb_count[busy] lb_count[newly_idle] \
          lb_failed[...] lb_balanced[...] lb_imbalance[...] \
          lb_gained[...] lb_hot_gained[...] lb_nobusyg[...] lb_nobusyq[...]
          alb_count alb_failed alb_pushed
          sbe_count sbe_balanced sbe_pushed
          sbf_count sbf_balanced sbf_pushed
          ttwu_wake_remote ttwu_move_affine ttwu_move_balance
```

These are the raw counters behind load balancing decisions — useful for diagnosing whether the load balancer is working.

## /proc/PID/sched

More detailed per-task stats (always available, not gated by schedstats):

```bash
cat /proc/$PID/sched
# Task: myprocess (pid: 1234)
# ...
# se.exec_start                    :  1234567890.123456
# se.vruntime                      :         456789.012
# se.sum_exec_runtime              :       12345.678901
# nr_switches                      :               1042
# nr_voluntary_switches            :                998
# nr_involuntary_switches          :                 44
# se.load.weight                   :               1024
# se.runnable_weight               :               1024
# policy                           :                  0
# prio                             :                120
# clock-delta                      :                 42
# mm->numa_scan_seq                :                  0
```

Key fields:

| Field | Meaning |
|-------|---------|
| `se.vruntime` | Current virtual runtime (ns) |
| `se.sum_exec_runtime` | Total CPU time consumed (ns) |
| `nr_voluntary_switches` | Context switches initiated by the task (I/O, sleep) |
| `nr_involuntary_switches` | Preemptions — scheduler forced the task off CPU |
| `prio` | Effective priority (100=RT max, 120=nice 0, 139=nice 19) |

A high `nr_involuntary_switches` relative to `nr_voluntary_switches` suggests the task is being preempted frequently — it may be using more CPU than its allocation allows, or competing with higher-priority tasks.

## Interpreting wait time

```bash
# Script to show top tasks by scheduler wait time
for pid in /proc/[0-9]*/schedstat; do
    task=$(dirname $pid | xargs -I{} cat {}/comm 2>/dev/null)
    read cpu_time wait_time slices < $pid
    echo "$wait_time $task $pid"
done | sort -rn | head -20
```

High `wait_time` relative to `cpu_time` means a task is often runnable but waiting for a CPU. Possible causes:
- System is overloaded (more runnable tasks than CPUs)
- Task has low priority (nice value or cgroup weight)
- CPU affinity is too restrictive

## perf and schedstat together

```bash
# Measure scheduler overhead for a workload
perf stat -e context-switches,cpu-migrations,sched:sched_switch ./workload

# Count involuntary context switches (preemptions)
perf stat -e sched:sched_switch -a sleep 5 2>&1 | grep sched_switch
```

## Further reading

- [Scheduler Tracing](sched-tracing.md) — ftrace events for real-time scheduling observation
- [Scheduler Tuning](sched-tuning.md) — sysctl knobs to adjust scheduler behavior
- [CFS](cfs.md) — How vruntime and virtual deadlines relate to scheduling decisions
- [Runqueues & Task Selection](runqueues.md) — Where these statistics are updated
