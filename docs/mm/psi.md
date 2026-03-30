# Pressure Stall Information (PSI)

> Quantifying resource pressure, not just utilization

## What Is PSI?

Traditional system metrics like CPU utilization, free memory, and I/O throughput tell you how busy resources are, but they don't tell you whether workloads are actually *suffering*. A system can show 90% CPU utilization and be perfectly healthy if all tasks are making progress. Conversely, a system at 30% CPU can be in trouble if tasks are stuck waiting for memory to be reclaimed.

PSI (Pressure Stall Information) measures the amount of time tasks spend *stalled* — waiting for resources instead of doing useful work. This is the difference between utilization (how much of a resource is in use) and pressure (how much work is delayed because of insufficient resources).

```
Traditional metrics:          PSI:
"CPU is 85% used"             "Tasks lost 12% of productive time
                               waiting for CPU"

"500MB free memory"           "Tasks were fully stalled on memory
                               for 3% of the last 10 seconds"

"Disk is 60% busy"           "No tasks were stalled on I/O"
```

## Three Resources Tracked

PSI tracks pressure across the three fundamental resources that tasks compete for:

| Resource | Pressure File | What Causes Stalls |
|----------|--------------|-------------------|
| CPU | `/proc/pressure/cpu` | Runnable tasks waiting for a CPU core |
| Memory | `/proc/pressure/memory` | Tasks waiting for page reclaim, swap I/O, refaults |
| I/O | `/proc/pressure/io` | Tasks waiting for block device I/O |

```bash
# View all pressure metrics
cat /proc/pressure/cpu
cat /proc/pressure/memory
cat /proc/pressure/io
```

## "some" vs "full" Pressure

Each pressure file reports two levels of stalling:

```
$ cat /proc/pressure/memory
some avg10=0.00 avg60=0.00 avg300=0.00 total=456789
full avg10=0.00 avg60=0.00 avg300=0.00 total=123456
```

**some**: At least one task is stalled on this resource. Other tasks may still be running productively. This indicates contention — the workload is partially degraded.

**full**: *All* non-idle tasks are stalled simultaneously. No productive work is happening. This is a much more severe condition — the system (or cgroup) is completely bogged down.

```
                Time ──────────────────────>

Task A:    [running][stalled ][running ][stalled ]
Task B:    [running][running ][stalled ][stalled ]
                         │                   │
                    "some" pressure     "full" pressure
                  (one task stalled)   (all tasks stalled)
```

!!! note
    `/proc/pressure/cpu` only reports `some`, not `full`. The reasoning: if all tasks are waiting for CPU, then no task is running, which means the CPU is idle — a contradictory state. CPU pressure means runnable tasks are competing for time, so at least one is always making progress.

## Reading the Pressure Files

Each line contains three moving averages and a cumulative total:

```
some avg10=4.67 avg60=2.13 avg300=0.85 total=2345678
```

| Field | Meaning |
|-------|---------|
| `avg10` | Percentage of time tasks were stalled over the last 10 seconds |
| `avg60` | Percentage of time stalled over the last 60 seconds |
| `avg300` | Percentage of time stalled over the last 5 minutes |
| `total` | Cumulative stall time in microseconds since boot |

The averages are exponentially weighted moving averages (similar to load average), expressed as percentages (0.00 to 100.00). The `total` counter is monotonically increasing and useful for computing exact stall rates over custom intervals.

```bash
# Compute exact stall rate over a 5-second window
T1=$(awk '/some/ {print $NF}' /proc/pressure/memory | cut -d= -f2)
sleep 5
T2=$(awk '/some/ {print $NF}' /proc/pressure/memory | cut -d= -f2)
STALL_US=$((T2 - T1))
echo "Memory stall: ${STALL_US}us over 5 seconds"
```

## PSI Triggers: Userspace Monitoring

Reading pressure files by polling is fine for dashboards, but for real-time resource management you need event-driven notification. PSI supports poll/epoll on pressure files, allowing userspace to set thresholds and be woken only when pressure exceeds them.

### Setting Up a Trigger

Write a trigger specification to a pressure file, then use `poll()` or `epoll()` to wait for events:

```c
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    int fd = open("/proc/pressure/memory", O_RDWR | O_NONBLOCK);

    /* Trigger when "some" stall time exceeds 100ms
       within any 1-second window (values in microseconds) */
    const char *trigger = "some 100000 1000000";
    write(fd, trigger, strlen(trigger) + 1);

    struct pollfd fds = { .fd = fd, .events = POLLPRI };

    for (;;) {
        int ret = poll(&fds, 1, -1);  /* Block until threshold hit */
        if (ret > 0) {
            printf("Memory pressure threshold exceeded!\n");
            /* Take action: drop caches, kill low-priority work, etc. */
        }
    }
}
```

The trigger format is:

```
<some|full> <stall_us> <window_us>
```

- `some 100000 1000000` means: trigger when at least 100ms of stall time (stall_us) occurs within any 1-second window (window_us).
- The window must be between 500ms and 10 seconds. Unprivileged users are additionally restricted to windows that are multiples of 2 seconds. See [`Documentation/accounting/psi.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/accounting/psi.rst) for the full specification.

PSI trigger support was added in v5.2 by Suren Baghdasaryan ([commit 0e94682b73bf](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=0e94682b73bf)).

## PSI in Practice

PSI is not just a monitoring curiosity — it is the foundation for modern out-of-memory management in production systems.

### systemd-oomd

[systemd-oomd](https://www.freedesktop.org/software/systemd/man/latest/systemd-oomd.html) uses PSI memory pressure to decide when to kill cgroups before the kernel OOM killer triggers. It monitors `memory.pressure` for each cgroup and kills the highest-memory consumer when pressure exceeds a threshold. This replaces the blunt global OOM killer with targeted, early intervention.

```ini
# /etc/systemd/oomd.conf
[OOM]
SwapUsedLimit=90%
DefaultMemoryPressureLimit=60%
DefaultMemoryPressureDurationUSec=30s
```

### Meta's oomd

Meta (Facebook) originally developed [oomd](https://github.com/facebookincubator/oomd), the PSI-based OOM daemon that inspired systemd-oomd. In Meta's fleet, PSI-based killing replaced the kernel OOM killer, providing faster response times and better decisions about what to kill. This was a primary motivation for PSI's development — Johannes Weiner built PSI to solve real fleet management problems at Meta.

For more context on the problem PSI was designed to solve, see the [LWN article on tracking pressure-stall information](https://lwn.net/Articles/759658/).

### Android LMKD

Android's Low Memory Killer Daemon (LMKD) uses PSI triggers to detect memory pressure and kill background apps before the system becomes unresponsive. Android moved from the in-kernel lowmemorykiller to a PSI-based userspace approach, giving better responsiveness on memory-constrained mobile devices.

### Resource Management at Scale

Beyond OOM handling, PSI enables:

- **Autoscaling**: Scale up containers or VMs when pressure indicates the workload is suffering, rather than reacting to raw utilization.
- **Workload placement**: Schedulers can prefer nodes with lower pressure rather than lower utilization.
- **SLA monitoring**: Define health in terms of "how much time are tasks losing" rather than arbitrary resource thresholds.

## Per-cgroup PSI

PSI is not limited to system-wide metrics. Each cgroup exposes its own pressure information via `memory.pressure`, `cpu.pressure`, and `io.pressure`:

```bash
# View memory pressure for a specific cgroup
cat /sys/fs/cgroup/myservice/memory.pressure

# View CPU pressure
cat /sys/fs/cgroup/myservice/cpu.pressure

# View I/O pressure
cat /sys/fs/cgroup/myservice/io.pressure
```

Per-cgroup PSI is what makes tools like systemd-oomd and oomd practical. System-wide pressure might be fine while a single container is thrashing. Per-cgroup pressure catches this.

PSI triggers also work on per-cgroup pressure files, so a daemon can register for threshold notifications on individual cgroups:

```c
int fd = open("/sys/fs/cgroup/myservice/memory.pressure",
              O_RDWR | O_NONBLOCK);
write(fd, "some 50000 1000000", 19);  /* 50ms stall per 1s window */
/* poll(fd) ... */
```

## How the Kernel Calculates PSI

### Task State Tracking

PSI works by tracking what every task is doing at any given moment. The scheduler already knows whether a task is running, sleeping, or waiting — PSI hooks into these state transitions to accumulate stall time.

Each task can be in one of several PSI-relevant states:

```
┌────────────────────────────────────────────────────────────┐
│  TSK_IOWAIT          - Waiting for I/O completion          │
│  TSK_MEMSTALL        - Waiting for memory (reclaim, swap)  │
│  TSK_RUNNING         - On a runqueue (may or may not       │
│                        have a CPU)                         │
│  TSK_MEMSTALL_RUNNING - Running but inside a memory stall  │
│                        (e.g. synchronous reclaim)          │
│  TSK_ONCPU           - Currently executing on a CPU        │
└────────────────────────────────────────────────────────────┘
```

These flags are defined in [`include/linux/psi_types.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/psi_types.h). `TSK_MEMSTALL_RUNNING` was added to correctly account for tasks that are executing on CPU while in a synchronous reclaim path — these contribute to `some` pressure but not `full` pressure, since the CPU is not idle.

When a task enters a stall state (e.g., it needs to reclaim memory or wait for swap I/O), the kernel calls `psi_task_change()` to record the transition. When it leaves the stall state, the transition is recorded again.

### Aggregation

PSI tracks time at the per-CPU level, then aggregates. For each CPU, it records how much time was spent with at least one task stalled (`some`) and with all tasks stalled (`full`). These per-CPU samples are aggregated into the exponentially weighted averages you see in the pressure files.

```
Per-CPU tracking:
  CPU 0: some=150us  full=30us   (in last period)
  CPU 1: some=80us   full=0us
  CPU 2: some=200us  full=100us
  CPU 3: some=0us    full=0us
         │
         v
  Aggregation → weighted averages → /proc/pressure/*
```

The aggregation happens in `psi_avgs_work()`, a deferred work function that runs periodically (every 2 seconds) to update the moving averages. When userspace has registered PSI triggers, a faster polling path runs at the trigger's window granularity.

### Growth-based Tracking

An important optimization ([commit df77430639c9](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=df77430639c9)): PSI uses per-CPU "growth" counters rather than locks. Each CPU independently tracks cumulative stall time. The aggregation step reads these counters and computes the deltas, avoiding contention on hot paths.

## History

### Introduction (v4.20, 2018)

**Commit**: [eb414681d5a0](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=eb414681d5a0) ("psi: pressure stall information for CPU, memory, and IO")

**Author**: Johannes Weiner (Facebook/Meta)

PSI was merged in Linux v4.20 (December 2018). The motivation, as described in the [commit message](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=eb414681d5a0) and [LWN coverage](https://lwn.net/Articles/759658/), was that existing metrics (load average, free memory, I/O utilization) were poor indicators of whether workloads were actually affected by resource shortages. Facebook needed a metric that quantified lost work, not just resource consumption, to drive fleet-wide resource management decisions.

### PSI Triggers (v5.2, 2019)

**Commit**: [0e94682b73bf](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=0e94682b73bf) ("psi: introduce psi monitor")

**Author**: Suren Baghdasaryan

Added poll/epoll support on PSI files, enabling event-driven userspace monitoring. This was essential for making PSI practical in daemons like oomd — polling files in a loop is expensive and introduces latency.

### Per-cgroup PSI (v4.20)

Per-cgroup PSI was part of the original PSI patchset, since cgroup-level pressure was a core use case from the start.

### Broader Adoption

- **Android**: Adopted PSI for LMKD in Android 10 (2019)
- **systemd**: systemd-oomd [introduced in systemd v247](https://lwn.net/Articles/837034/) (2020)
- **Meta**: Used PSI across their entire fleet for OOM prevention and workload scheduling

## Key Source Files

| File | Description |
|------|-------------|
| [`kernel/sched/psi.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/psi.c) | Core PSI implementation: state tracking, aggregation, triggers |
| [`include/linux/psi.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/psi.h) | PSI API and inline functions |
| [`include/linux/psi_types.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/psi_types.h) | PSI data structure definitions |
| [`kernel/cgroup/cgroup.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/cgroup/cgroup.c) | Per-cgroup PSI file exposure |
| [`Documentation/accounting/psi.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/accounting/psi.rst) | Kernel documentation for PSI |

## Try It Yourself

### View System Pressure

```bash
# Check if PSI is enabled (most modern kernels have it on by default)
cat /proc/pressure/cpu
cat /proc/pressure/memory
cat /proc/pressure/io
```

If the files don't exist, PSI may be disabled. It can be enabled with the `psi=1` kernel boot parameter. Some distributions disable it by default for performance reasons (the overhead is minimal but nonzero).

### Generate Memory Pressure and Observe

```bash
# Terminal 1: Watch memory pressure
watch -n 1 cat /proc/pressure/memory

# Terminal 2: Create memory pressure
# Allocate more memory than available (adjust size for your system)
stress --vm 4 --vm-bytes $(awk '/MemAvailable/ {print int($2*0.3)"k"}' \
    /proc/meminfo) --timeout 30
```

You should see `avg10` rise for both `some` and `full` lines while memory is under pressure.

### Per-cgroup Pressure Monitoring

```bash
# Create a memory-limited cgroup
sudo mkdir /sys/fs/cgroup/psi-test
echo "+memory" | sudo tee /sys/fs/cgroup/cgroup.subtree_control
echo 100M | sudo tee /sys/fs/cgroup/psi-test/memory.max

# Move a shell into the cgroup
echo $$ | sudo tee /sys/fs/cgroup/psi-test/cgroup.procs

# Watch cgroup-specific pressure
watch -n 1 cat /sys/fs/cgroup/psi-test/memory.pressure

# In the same shell, create pressure
python3 -c "x = bytearray(80 * 1024 * 1024)"  # 80MB in a 100MB cgroup
```

### Using the total Counter for Precise Measurements

```bash
# Measure exact stall time over a custom interval
read_total() {
    awk '/^some/ {for(i=1;i<=NF;i++) if($i~/^total=/) print substr($i,7)}' \
        /proc/pressure/memory
}

START=$(read_total)
# Run your workload here
sleep 10
END=$(read_total)

STALL_US=$((END - START))
STALL_PCT=$(echo "scale=2; $STALL_US / 10000000 * 100" | bc)
echo "Memory stall: ${STALL_US}us (${STALL_PCT}% of 10s)"
```

### Clean Up

```bash
# Remove test cgroup (move processes out first)
echo $$ | sudo tee /sys/fs/cgroup/cgroup.procs
sudo rmdir /sys/fs/cgroup/psi-test
```

## References

### Kernel Documentation

- [`Documentation/accounting/psi.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/accounting/psi.rst) — Authoritative PSI documentation

### LWN Articles

- [Tracking pressure-stall information](https://lwn.net/Articles/759658/) — Original coverage of the PSI patchset (2018)
- [Monitoring memory pressure with PSI](https://lwn.net/Articles/837034/) — systemd-oomd and PSI triggers

### Related

- [Memory Cgroups](memcg.md) — Per-cgroup memory limits and accounting
- [Page Reclaim](reclaim.md) — What causes memory stalls
- [Running out of memory](oom.md) — The OOM killer that PSI helps avoid
- [Glossary](glossary.md) — PSI, cgroup, OOM definitions
