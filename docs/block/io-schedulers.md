# I/O Schedulers

> How the block layer reorders requests for efficiency

## What I/O schedulers do

An I/O scheduler (also called an elevator) sits between the block layer submission path and the hardware dispatch. It can:

1. **Merge** adjacent requests into one (fewer I/O operations)
2. **Reorder** requests to reduce HDD seek distance or improve fairness
3. **Prioritize** certain types of requests (metadata, interactive I/O)
4. **Throttle** requests from processes that are using too much I/O

On modern blk-mq hardware (NVMe, virtio-blk), schedulers are optional — for NVMe with many queues, "none" (no scheduler) is often optimal.

## Available schedulers

```bash
# Check available schedulers for a device
cat /sys/block/sda/queue/scheduler
# [mq-deadline] none bfq kyber
# Current scheduler in brackets

# Change scheduler
echo mq-deadline > /sys/block/sda/queue/scheduler
echo none > /sys/block/nvme0n1/queue/scheduler  # for NVMe
```

### none

No scheduling. Requests are dispatched in submission order. Optimal for:
- NVMe SSDs with hardware queues (no seek latency, no benefit from reordering)
- Very low-latency workloads where scheduler overhead matters

```bash
echo none > /sys/block/nvme0n1/queue/scheduler
```

### mq-deadline

**Default for most block devices.** Prevents request starvation by giving each request a deadline. Uses two separate queues: read and write.

Algorithm:
1. Requests are sorted in an elevator (rb-tree sorted by sector)
2. Each request also gets a **deadline**: reads default 500ms, writes 5000ms
3. Scheduler normally dispatches in sector order (fewer seeks)
4. If any request reaches its deadline, it's dispatched immediately

```c
/* block/mq-deadline.c */
struct deadline_data {
    struct rb_root sort_list[DD_DIR_COUNT];  /* sorted by sector */
    struct list_head fifo_list[DD_DIR_COUNT]; /* sorted by deadline */
    sector_t last_sector[DD_DIR_COUNT];
    unsigned int batching;    /* current batch count */
    unsigned int starved;     /* write starvation count */
};
```

Tuning:
```bash
# Deadline for reads (ms, default 500)
cat /sys/block/sda/queue/iosched/read_expire
echo 100 > /sys/block/sda/queue/iosched/read_expire

# Deadline for writes (ms, default 5000)
cat /sys/block/sda/queue/iosched/write_expire

# How many read requests to dispatch before switching to writes
cat /sys/block/sda/queue/iosched/writes_starved  # default 2

# Number of requests to batch before switching direction
cat /sys/block/sda/queue/iosched/fifo_batch  # default 16
```

### BFQ (Budget Fair Queueing)

**Best for desktop/interactive workloads.** Provides proportional-share I/O scheduling with a focus on low latency for interactive applications (browser, desktop UI) even under heavy background I/O.

BFQ assigns each process or group a **budget** of sectors to serve. When the budget is exhausted, the scheduler moves to the next process. Budget is dynamically sized based on workload characteristics.

Key properties:
- Interactive processes get boosted priority (short bursts are rewarded)
- cgroups integration: `/sys/block/sda/queue/iosched/` exposes per-group weights
- `CONFIG_BFQ_GROUP_IOSCHED` enables cgroup-based I/O isolation

```bash
echo bfq > /sys/block/sda/queue/scheduler

# BFQ tunables
cat /sys/block/sda/queue/iosched/slice_idle    # idle time between requests (µs)
cat /sys/block/sda/queue/iosched/back_seek_max  # max backward seek allowed

# Per-process I/O priority (ionice)
ionice -c 2 -n 4 rsync source/ dest/   # best-effort, priority 4
ionice -c 3 rsync source/ dest/         # idle class
```

### kyber

**For multi-queue, low-latency devices (NVMe, SSDs).** Uses per-operation-type queues (read, write, discard) with token-based latency targeting.

Rather than reordering, kyber:
- Limits in-flight requests per category to hit target latencies
- Doesn't do merging (relies on hardware)
- Very low overhead

```bash
echo kyber > /sys/block/nvme0n1/queue/scheduler

# Latency targets (ns)
cat /sys/block/nvme0n1/queue/iosched/read_lat_nsec    # default 2000000 (2ms)
cat /sys/block/nvme0n1/queue/iosched/write_lat_nsec   # default 10000000 (10ms)
```

## Choosing a scheduler

| Workload | Recommended scheduler |
|----------|----------------------|
| NVMe SSD | `none` or `kyber` |
| SATA SSD | `mq-deadline` or `none` |
| HDD (spinning) | `mq-deadline` or `bfq` |
| Desktop/interactive | `bfq` |
| Database server | `mq-deadline` or `none` |
| Container I/O isolation | `bfq` (with cgroups) |

```bash
# Check if rotational (0=SSD, 1=HDD)
cat /sys/block/sda/queue/rotational

# Automatic scheduler selection at boot (udev rules)
# /usr/lib/udev/rules.d/60-io-scheduler.rules
ACTION=="add|change", KERNEL=="sd[a-z]*", ATTR{queue/rotational}=="0",
  ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="nvme[0-9]*",
  ATTR{queue/scheduler}="none"
```

## Monitoring I/O performance

```bash
# iostat: throughput, IOPS, latency
iostat -x 1 /dev/sda
# Device    r/s   w/s  rkB/s  wkB/s  await  svctm  %util
# sda       0.5  50.2   8.0  801.0    4.5    1.2   6.1

# await: average total latency (queue wait + service time)
# svctm: average service time at device
# %util: device utilization

# blktrace: detailed per-request tracing
blktrace -d /dev/sda -o trace
blkparse -i trace.blktrace.0 | head -50

# biolatency (BCC): histogram of I/O latencies
biolatency -d sda 10 1
```

## Further reading

- [blk-mq](blk-mq.md) — The dispatch layer below the scheduler
- [bio and request structures](bio-request.md) — What the scheduler reorders
- `Documentation/block/` in the kernel tree
