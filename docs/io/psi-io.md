# PSI: Pressure Stall Information for I/O

> How the kernel measures I/O pressure, what the numbers mean, and how to act on them

## What PSI measures

PSI (Pressure Stall Information), introduced in v4.20 ([commit 0e94682b73bf](https://git.kernel.org/linus/0e94682b73bf)), directly measures whether tasks are blocked waiting for I/O — not device utilization, but actual task impact.

Traditional I/O metrics (`%util` from `iostat`, `nr_io_pending`) describe the device. PSI describes the workload: what fraction of time did tasks spend waiting for I/O instead of making progress?

```bash
cat /proc/pressure/io
# some avg10=3.24 avg60=1.89 avg300=0.94 total=123456789
# full avg10=0.08 avg60=0.04 avg300=0.01 total=4567890
```

---

## The two PSI lines: `some` and `full`

**`some`**: the fraction of time during which at least one task was stalled waiting for I/O. Some tasks could still run (on other CPUs); the system was not completely I/O blocked.

**`full`**: the fraction of time during which *all* non-idle tasks were stalled waiting for I/O — no useful work was being done anywhere. The system was completely I/O blocked.

```
Time →

4 tasks, one blocked on I/O:
Task A: running  running  running  running  running
Task B: running  [IO wait] [IO wait] running  running
Task C: running  running  running  running  running
Task D: running  running  running  running  running
         ↑ "some" counts here: task B blocked, others running

All tasks blocked on I/O:
Task A: [IO wait] [IO wait] [IO wait] [IO wait]
Task B: [IO wait] [IO wait] [IO wait] [IO wait]
Task C: [IO wait] [IO wait] [IO wait] [IO wait]
Task D: [IO wait] [IO wait] [IO wait] [IO wait]
         ↑ "full" counts here: zero productive work happening
```

---

## The three time windows

Each metric is reported as three exponentially weighted moving averages:

| Window | Key | What it tells you |
|--------|-----|-------------------|
| `avg10` | Last 10 seconds | Current pressure; useful for alerting on spikes |
| `avg60` | Last 60 seconds | Short-term trend; smooths out brief spikes |
| `avg300` | Last 5 minutes | Sustained pressure; useful for capacity planning |

The `total` field is the raw cumulative microseconds of stall time since boot — useful for computing precise rates in monitoring pipelines.

---

## Interpreting the values

### `some avg10`: the most useful metric for alerting

```
some avg10 = 0       No I/O pressure. Tasks are not waiting for I/O.
some avg10 = 1–5     Light pressure. Acceptable for most workloads.
some avg10 = 5–20    Moderate pressure. Investigate if latency SLOs are at risk.
some avg10 > 20      Significant pressure. I/O is impacting application throughput.
some avg10 = 100     Every second of every second, at least one task is blocked on I/O.
                     The device is saturated.
```

### `full avg10`: the severity indicator

```
full avg10 = 0       Even when tasks stall, others can run. Impact is partial.
full avg10 = 1–5     Occasionally the entire system is stalled on I/O.
full avg10 > 5       Frequent full stalls. I/O is a system-wide bottleneck.
full avg10 = 100     The system is completely I/O bound. Nothing is making progress.
```

### Distinguishing I/O pressure from other pressure

```bash
# Check all three PSI dimensions simultaneously
echo "=== CPU ===" && cat /proc/pressure/cpu
echo "=== Memory ===" && cat /proc/pressure/memory
echo "=== I/O ===" && cat /proc/pressure/io

# If I/O pressure is high but CPU and memory are low:
#   → Storage device bottleneck, or writeback overload
# If memory pressure is high and I/O pressure follows:
#   → Page cache thrashing: reclaim evicting pages that are immediately refaulted
# If all three are high:
#   → System is severely resource-constrained
```

---

## PSI vs `iostat %util`

`iostat %util` and `some` measure different things:

| Metric | What it measures | Who it describes |
|--------|-----------------|-----------------|
| `iostat %util` | Fraction of time device had any I/O in flight | The **device** |
| `PSI some` | Fraction of time any task was blocked on I/O | The **workload** |

A device at 60% `%util` with `some avg10 = 0.5` is fine: tasks occasionally wait briefly, but the device has headroom. A device at 60% `%util` with `some avg10 = 15` is a problem: tasks are spending significant time blocked even though the device isn't saturated. This points to scheduler latency, filesystem overhead, or writeback stalls rather than device saturation.

```bash
# Run both simultaneously to understand the relationship
iostat -xz 1 /dev/nvme0n1 &
watch -n 1 'cat /proc/pressure/io'
```

---

## PSI in cgroups: per-container I/O pressure

With cgroup v2, PSI metrics are available per-cgroup. Each cgroup has its own `/sys/fs/cgroup/<group>/io.pressure`:

```bash
# Check I/O pressure for a specific container
cat /sys/fs/cgroup/system.slice/docker-<id>.scope/io.pressure
# some avg10=12.4 avg60=8.1 avg300=3.2 total=456789012
# full avg10=2.1 avg60=1.3 avg300=0.6 total=98765432

# List all containers sorted by I/O pressure (most stressed first)
for cg in /sys/fs/cgroup/system.slice/docker-*.scope; do
    name=$(basename $cg | cut -c8-19)
    some=$(awk '/^some/{print $2}' $cg/io.pressure 2>/dev/null | cut -d= -f2)
    echo "$some $name"
done | sort -rn | head -10
```

Per-cgroup PSI is the correct way to find the noisy neighbor: which container is generating I/O pressure that affects others.

---

## Using PSI for alerting

PSI is designed for alerting. The kernel supports **PSI notifications** (since v5.2) that trigger when pressure exceeds a threshold:

```c
/* PSI notification via poll/epoll (no busy-waiting) */
int fd = open("/proc/pressure/io", O_RDWR | O_NONBLOCK);

/* Alert when full pressure exceeds 5% over 500ms window */
const char *trigger = "full 5000000 500000";  /* 5% over 500ms */
write(fd, trigger, strlen(trigger));

/* Now poll for the notification */
struct pollfd pfd = { .fd = fd, .events = POLLPRI };
while (1) {
    poll(&pfd, 1, -1);
    if (pfd.revents & POLLPRI) {
        char buf[128];
        pread(fd, buf, sizeof(buf), 0);
        /* Parse and log the pressure event */
        fprintf(stderr, "I/O pressure alert: %s\n", buf);
    }
}
```

**Systemd integration**: `systemd` uses PSI notifications to throttle or restart services that are causing I/O pressure on shared infrastructure.

```bash
# Check if systemd is monitoring PSI
systemctl show | grep -i psi
```

**Prometheus/monitoring integration:**

```bash
# Export PSI metrics for Prometheus
# Node exporter supports PSI natively (--collector.pressure flag)
# Or parse manually:
awk '/^some/{gsub(/[a-z0-9_]+=/, ""); print}' /proc/pressure/io
# Output: 3.24 1.89 0.94 123456789
# Map to: some_avg10, some_avg60, some_avg300, some_total
```

---

## Diagnosing elevated PSI

When `some avg10` rises above your alerting threshold:

```bash
# Step 1: Which device is responsible?
iostat -xz 1 5  # find the device with high %util or await

# Step 2: Which process is causing the I/O?
iotop -ao       # accumulated I/O by process
# Or:
bpftrace -e 'tracepoint:block:block_rq_issue {
    @[comm, pid] = sum(args->nr_sector * 512);
}
interval:s:5 { print(@); clear(@); }'

# Step 3: What kind of I/O? (writeback? reads? fsyncs?)
grep -E '(nr_dirty|nr_writeback)' /proc/vmstat  # is writeback behind?
bpftrace -e 'tracepoint:syscalls:sys_enter_fsync { @fsyncs[comm] = count(); }
interval:s:5 { print(@fsyncs); clear(@fsyncs); }'

# Step 4: Is it the scheduler holding I/Os back?
/usr/share/bcc/tools/biolatency -d nvme0n1 10
# High latency at the block layer (not the device) → scheduler issue
```

---

## PSI thresholds by workload type

| Workload | `some avg10` concern | `full avg10` concern |
|---------|---------------------|---------------------|
| Interactive / latency-sensitive | > 2 | > 0.5 |
| Database (OLTP) | > 5 | > 1 |
| Batch / analytics | > 30 | > 10 |
| Backup / archival | Not a concern | > 50 |

These are starting points; calibrate based on your application's sensitivity to I/O latency.

---

## PSI implementation

PSI tracks stall states in `kernel/sched/psi.c`. Each task has a `psi_flags` field indicating whether it is currently blocked on memory, I/O, or CPU. The kernel updates these flags at state transitions (scheduling, blocking, unblocking) and accumulates them into per-cgroup and system-wide counters.

The implementation uses a lockless approach for the common case (reading and writing flags from the scheduling fast path) and periodic aggregate computation (every 2 seconds) for the moving averages.

The source reference: [`kernel/sched/psi.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/psi.c).

Facebook developed PSI to replace load average and `MemAvailable` as the primary signal for resource pressure in their infrastructure. The design rationale is explained in the original LWN article: [Tracking pressure-stall information](https://lwn.net/Articles/759658/).

---

## Related pages

- [Debugging Slow I/O](debugging-slow-io.md) — using PSI in the diagnosis workflow
- [Tuning I/O for Containers](tuning-containers.md) — per-cgroup PSI for noisy neighbor detection
- [I/O Bandwidth](io-bandwidth.md) — when PSI is high but device utilization is low
- [Writeback Internals](writeback-internals.md) — dirty throttling as a source of I/O PSI
- [Understanding /proc/diskstats](understanding-proc-diskstats.md) — complementary device metrics
