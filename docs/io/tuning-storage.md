# Tuning I/O Performance for Storage-Heavy Workloads

> Understanding what the kernel does with your I/O — and where the defaults get out of the way

## Why I/O Tuning Requires a Workload Model

A web server, an OLTP database, a time-series ingest pipeline, and a backup job all use the same block layer, but they need entirely different configurations. Before touching a single sysctl:

- A setting that cuts NVMe latency in half for random 4K reads may reduce throughput for sequential 1MB reads.
- Disabling readahead is essential for PostgreSQL index scans and actively harmful for log streaming.
- The "right" I/O scheduler depends on whether you have one NVMe with 64 hardware queues or a spinning disk with a 32-entry NCQ queue.

Tuning without a workload model is guessing. The sections below first explain how to characterize your workload, then give concrete knobs for each workload shape.

## Understanding Your Workload First

### The Four Axes

Every I/O workload lives somewhere in this four-dimensional space:

```
1. Access pattern     random        ←————————→   sequential
2. Direction          write-heavy   ←————————→   read-heavy
3. Optimization goal  latency       ←————————→   throughput
4. Queue depth        shallow (1)   ←————————→   deep (128+)
```

These are not independent. Sequential I/O benefits from deep queues and large readahead; random I/O at low queue depth needs low per-operation latency. Choosing tunables that optimize one axis can degrade another.

Common workload archetypes:

| Workload | Pattern | Goal | Typical Queue Depth |
|----------|---------|------|---------------------|
| OLTP database (pg, mysql) | Random 4–16K | Latency | 4–32 |
| Data warehouse / OLAP | Sequential scan, large blocks | Throughput | 32–256 |
| Time-series ingest | Sequential write, many small | Throughput + latency | 8–64 |
| Backup / restore | Sequential | Throughput | 32–128 |
| Object storage | Mixed random + sequential | Throughput | 32–256 |
| WAL / redo log | Sequential write | Latency (fsync) | 1–4 |

### Quick Profiling with iostat

`iostat` from the `sysstat` package is the first tool to reach for. It reads from `/proc/diskstats`, which the block layer updates on every I/O completion.

```bash
# 1-second intervals, extended statistics, human-readable
iostat -x -h 1

# Key columns:
#  r/s    w/s    — IOPS (completed reads/writes per second)
#  rkB/s  wkB/s  — Throughput in kB/s
#  r_await w_await — Average completion latency in ms
#  aqu-sz          — Average queue depth (inflight + waiting)
#  %util           — Fraction of time device had outstanding I/O
```

What to look for:

- `%util` near 100% and `aqu-sz` much greater than 1 on a spinning disk means the device is saturated.
- High `r_await` (>5ms for SSD, >20ms for HDD) with low `%util` often means the I/O scheduler is adding queuing overhead.
- High `aqu-sz` on NVMe with `%util` well below 100% is expected — NVMe devices have deep internal queues and parallelize freely.

### Profiling with fio

`fio` lets you issue controlled, reproducible workloads and measure the device's raw capability before applying any application load.

```bash
# Random 4K read, queue depth 32, 30 seconds — baseline for OLTP
fio --name=randread-baseline \
    --filename=/dev/nvme0n1 \
    --rw=randread \
    --bs=4k \
    --iodepth=32 \
    --numjobs=1 \
    --runtime=30 \
    --time_based \
    --direct=1 \
    --lat_percentiles=1 \
    --output-format=normal

# Sequential 1M read — baseline for streaming workloads
fio --name=seqread-baseline \
    --filename=/dev/nvme0n1 \
    --rw=read \
    --bs=1m \
    --iodepth=4 \
    --numjobs=4 \
    --runtime=30 \
    --time_based \
    --direct=1 \
    --output-format=normal
```

!!! warning "Run against a block device, not a file, for device characterization"
    Running `fio` against a file goes through the filesystem and page cache, which adds variability. For baseline device measurement, use the raw block device (`/dev/nvme0n1`). Only switch to files when characterizing filesystem overhead.

### Deep Tracing with blktrace

When `iostat` shows a problem but not its cause, `blktrace` records every event the block layer sees per request: queue insertion, merge, dispatch to driver, completion.

```bash
# Trace /dev/sda for 10 seconds
blktrace -d /dev/sda -o /tmp/sda-trace -- sleep 10

# Post-process into human-readable form
blkparse -i /tmp/sda-trace.blktrace.* -o /tmp/sda-trace.txt

# Generate aggregated statistics
btt -i /tmp/sda-trace.blktrace.*

# Key btt output sections:
#  D2C  — time from dispatch to driver until completion (device latency)
#  Q2C  — time from queue insertion to completion (total latency)
#  Q2D  — time waiting in software queues (Q2C - D2C)
```

If `Q2D` is large relative to `Q2C`, the software queues are adding latency and scheduler tuning will help. If `D2C` dominates, the device itself is the bottleneck.

### The Benchmark-Before-You-Tune Principle

Record baseline numbers before changing anything. After each change, re-run the same benchmark with the same parameters. A change that improves 99th-percentile latency while reducing throughput may or may not be an improvement depending on your workload — you need both numbers to decide.

```bash
# A minimal but reproducible baseline script
#!/bin/bash
DEVICE=${1:-/dev/nvme0n1}
echo "=== Baseline: $(date) === Device: $DEVICE ==="

# Random 4K, single queue
fio --name=rand4k-qd1 --filename=$DEVICE --rw=randread \
    --bs=4k --iodepth=1 --numjobs=1 --runtime=30 \
    --time_based --direct=1 --lat_percentiles=1 \
    --output-format=terse --terse-version=5 2>/dev/null \
    | awk -F';' '{printf "rand4k-qd1: IOPS=%s lat_p99=%sµs lat_p999=%sµs\n",$49,$83,$84}'

# Random 4K, deep queue
fio --name=rand4k-qd32 --filename=$DEVICE --rw=randread \
    --bs=4k --iodepth=32 --numjobs=4 --runtime=30 \
    --time_based --direct=1 --lat_percentiles=1 \
    --output-format=terse --terse-version=5 2>/dev/null \
    | awk -F';' '{printf "rand4k-qd32: IOPS=%s lat_p99=%sµs lat_p999=%sµs\n",$49,$83,$84}'
```

## I/O Scheduler Selection

The I/O scheduler sits between the block layer's request queue and the device driver. On modern kernels, all schedulers run under the multi-queue block layer (`blk-mq`), which maps software queues to hardware dispatch queues.

### Checking and Setting the Scheduler

```bash
# Show the active scheduler and available options for a device
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq

# The value in brackets is the active scheduler

# Set at runtime
echo mq-deadline > /sys/block/nvme0n1/queue/scheduler

# Make persistent via udev rule
cat > /etc/udev/rules.d/60-ioscheduler.rules << 'EOF'
# NVMe: no scheduler (passthrough)
ACTION=="add|change", KERNEL=="nvme[0-9]*", ATTR{queue/scheduler}="none"

# SATA SSD: mq-deadline for predictable latency
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"

# HDD: bfq for fairness
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="bfq"
EOF

udevadm control --reload-rules
udevadm trigger --type=devices --action=change
```

### none (Passthrough)

`none` disables reordering entirely. Requests are dispatched to the device in submission order. This is the right choice for NVMe because:

- NVMe devices have internal command queues (up to 64K entries per queue, up to 64K queues) and perform their own reordering in firmware.
- Software reordering adds latency without benefit — the drive is smarter than the scheduler about its own access patterns.
- NVMe latency is already in the single-digit microsecond range; adding scheduler overhead doubles it for no gain.

```bash
echo none > /sys/block/nvme0n1/queue/scheduler
```

### mq-deadline

`mq-deadline` assigns an expiry deadline to each request and guarantees it is dispatched before the deadline. It also batches reads separately from writes, preventing writes from starving reads.

This is the best general-purpose scheduler for latency-sensitive workloads on SATA SSDs:

```bash
echo mq-deadline > /sys/block/sda/queue/scheduler

# Tune the deadline and batch parameters
# Read deadline in ms (default 500ms — reduce for databases)
echo 100 > /sys/block/sda/queue/iosched/read_expire

# Write deadline in ms (default 5000ms)
echo 1000 > /sys/block/sda/queue/iosched/write_expire

# How many sequential requests to dispatch in one batch
echo 16 > /sys/block/sda/queue/iosched/fifo_batch

# Writes dispatched per reads (1 = one write batch per read batch)
echo 1 > /sys/block/sda/queue/iosched/writes_starved
```

For a database WAL disk (SATA SSD), lowering `read_expire` and `write_expire` reduces tail latency at the cost of some reordering efficiency.

### kyber

`kyber` is a latency-targeting scheduler designed for fast SSDs. It maintains separate queues for reads and synchronous writes, and adjusts dispatch rates dynamically to hit a configurable latency target.

```bash
echo kyber > /sys/block/sda/queue/scheduler

# Target latency in nanoseconds for reads (default 2ms)
echo 500000 > /sys/block/sda/queue/iosched/read_lat_nsec

# Target latency for sync writes (default 10ms)
echo 2000000 > /sys/block/sda/queue/iosched/write_lat_nsec
```

Kyber works well when your SSD has relatively consistent device latency. If the device itself has high latency variance (common with cheaper consumer SSDs under write pressure), kyber's feedback loop may oscillate. In that case, `mq-deadline` with explicit expiry times is more predictable.

### bfq (Budget Fair Queuing)

`bfq` is a proportional-share scheduler that tracks per-process I/O budgets. It is designed for desktop/interactive use where fairness between multiple processes matters more than raw throughput.

For a dedicated database server, `bfq` adds overhead with no benefit — there is only one workload to be fair to. Use it when:

- The system runs mixed workloads (databases + backups + analytics) and you need to protect interactive I/O from background jobs.
- The device is a spinning HDD where reordering decisions genuinely matter for throughput.

```bash
echo bfq > /sys/block/sda/queue/scheduler

# Use cgroups v2 io.weight to control per-cgroup I/O priority with bfq
echo "100" > /sys/fs/cgroup/databases/io.bfq.weight
echo "10"  > /sys/fs/cgroup/backups/io.bfq.weight
```

### Scheduler Effect on Latency Distribution

The scheduler choice primarily affects latency distribution (p99, p999), not median latency. A well-tuned `none` on NVMe may show:

```
Median (p50):  50µs
p99:           120µs
p999:          200µs
```

While `mq-deadline` on the same NVMe might show:

```
Median (p50):  55µs    (slightly worse — scheduling overhead)
p99:           85µs    (better — deadline enforcement prevents outliers)
p999:          110µs   (better — expiry prevents starvation)
```

This trade-off — slightly higher median for better tail latency — is usually correct for databases where p99 connects to user-visible latency.

## Queue Depth Tuning

Queue depth controls how many I/O requests can be in flight simultaneously. Too shallow and you underutilize the device; too deep and you increase per-request queuing latency.

### Software Queue Depth: nr_requests

`nr_requests` sets the maximum number of requests per software queue before back-pressure is applied to submitters.

```bash
# Check current value
cat /sys/block/nvme0n1/queue/nr_requests
# 64 (default for NVMe)

# Increase for high-throughput workloads
echo 256 > /sys/block/nvme0n1/queue/nr_requests

# Reduce for latency-sensitive workloads (forces back-pressure sooner)
echo 32 > /sys/block/nvme0n1/queue/nr_requests
```

For NVMe devices that can sustain hundreds of thousands of IOPS, increasing `nr_requests` allows the kernel to buffer more requests for the device's internal scheduler. For SATA SSDs with much lower IOPS ceilings, the default is usually sufficient.

### Hardware Queue Count: nr_hw_queues

NVMe devices expose multiple hardware submission queues. The kernel maps software queues to hardware queues, ideally one-to-one with CPU cores or NUMA nodes.

```bash
# Check hardware queue count
cat /sys/block/nvme0n1/queue/nr_hw_queues
# 16 (example: 16-queue NVMe)

# Check how blk-mq maps CPUs to queues
cat /sys/block/nvme0n1/mq/*/cpu_list
```

If `nr_hw_queues` is less than the number of CPU cores, multiple CPUs share a hardware queue and contend on its lock. This is visible as `nvme_irq` in `perf top` on systems with many cores and few NVMe queues.

```bash
# Verify IRQ distribution across CPUs (each NVMe queue has one IRQ)
grep nvme /proc/interrupts | head -20
```

### Finding the Saturation Point with fio

The optimal queue depth is where IOPS peak without significantly increasing per-request latency. Find it by sweeping `iodepth`:

```bash
#!/bin/bash
DEVICE=${1:-/dev/nvme0n1}
for QD in 1 2 4 8 16 32 64 128 256; do
    RESULT=$(fio --name=qd-sweep \
        --filename=$DEVICE \
        --rw=randread \
        --bs=4k \
        --iodepth=$QD \
        --numjobs=1 \
        --runtime=10 \
        --time_based \
        --direct=1 \
        --output-format=terse \
        --terse-version=5 2>/dev/null)
    IOPS=$(echo "$RESULT" | awk -F';' '{print $49}')
    LAT_P99=$(echo "$RESULT" | awk -F';' '{print $83}')
    printf "qd=%-4d  iops=%-8s  lat_p99=%s µs\n" $QD "$IOPS" "$LAT_P99"
done
```

A typical NVMe result looks like:

```
qd=1     iops=50000    lat_p99=35 µs
qd=4     iops=185000   lat_p99=38 µs
qd=16    iops=450000   lat_p99=52 µs
qd=32    iops=520000   lat_p99=89 µs     ← diminishing returns start
qd=64    iops=540000   lat_p99=155 µs
qd=128   iops=542000   lat_p99=290 µs    ← IOPS plateau, latency rising fast
```

For OLTP databases, choose the queue depth where IOPS are still growing but latency is still acceptable for your SLA (p99 < 1ms is a common target).

### io_uring with Deep Queues

`io_uring` is the modern async I/O interface that avoids the overhead of per-syscall context switches. It shines at high queue depths because multiple I/O requests can be submitted in a single `io_uring_enter()` call.

```bash
# Benchmark io_uring vs libaio at various queue depths
fio --name=io_uring_deep \
    --ioengine=io_uring \
    --filename=/dev/nvme0n1 \
    --rw=randread \
    --bs=4k \
    --iodepth=128 \
    --numjobs=4 \
    --runtime=30 \
    --time_based \
    --direct=1 \
    --lat_percentiles=1

# Compare with libaio
fio --name=libaio_deep \
    --ioengine=libaio \
    --filename=/dev/nvme0n1 \
    --rw=randread \
    --bs=4k \
    --iodepth=128 \
    --numjobs=4 \
    --runtime=30 \
    --time_based \
    --direct=1 \
    --lat_percentiles=1
```

At queue depths above 32, `io_uring` typically shows 10–20% higher IOPS than `libaio` due to reduced syscall overhead and better CPU cache behavior from batched completions.

## Readahead Tuning

The kernel's readahead mechanism (described in detail in [readahead](readahead.md)) prefetches pages into the page cache before they are explicitly requested. The default `read_ahead_kb` is set per device and represents the maximum bytes to prefetch in a single window.

### Checking and Setting read_ahead_kb

```bash
# Check current value
cat /sys/block/nvme0n1/queue/read_ahead_kb
# 128 (typical default)

# Check for a SATA HDD
cat /sys/block/sda/queue/read_ahead_kb
# 128

# Set per-device
echo 4096 > /sys/block/sda/queue/read_ahead_kb   # streaming workload on HDD
echo 16   > /sys/block/nvme0n1/queue/read_ahead_kb # database random I/O on NVMe
```

### When to Reduce Readahead

**Random I/O workloads** — Database index scans access random 8–16KB pages. Readahead prefetches adjacent pages that are never read, wasting page cache space and generating unnecessary I/O. For a PostgreSQL server, set:

```bash
# Minimal readahead: only prefetch what the kernel's sequential detector demands
echo 16 > /sys/block/nvme0n1/queue/read_ahead_kb
```

**Devices with their own cache** — NVMe drives with large DRAM caches already perform internal prefetching. The kernel's readahead on top of the drive's prefetch doubles the work.

### When to Increase Readahead

**Sequential streaming** — Log ingestion pipelines, video transcoding, and backup jobs read large files sequentially. Larger readahead windows reduce the frequency of actual I/O by filling the page cache further ahead:

```bash
# Aggressive readahead for sequential streaming on HDD
echo 8192 > /sys/block/sda/queue/read_ahead_kb   # 8MB window
```

**Network-attached storage** — On high-latency block devices (iSCSI, NBD), even a small sequential access pattern benefits from aggressive readahead because round-trip latency dominates.

### Per-File Readahead with fadvise

Applications can advise the kernel about their access pattern without changing system-wide settings. The kernel uses these hints to adjust the readahead window for the specific file description:

```c
#include <fcntl.h>

int fd = open("data.db", O_RDONLY);

// Tell the kernel: random access, disable readahead for this fd
posix_fadvise(fd, 0, 0, POSIX_FADV_RANDOM);

// Tell the kernel: sequential access, prefetch aggressively for this fd
posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL);

// Hint that this range will be accessed soon
posix_fadvise(fd, offset, length, POSIX_FADV_WILLNEED);

// Drop cached pages once done (avoid polluting cache for single-pass reads)
posix_fadvise(fd, offset, length, POSIX_FADV_DONTNEED);
```

PostgreSQL uses `POSIX_FADV_DONTNEED` after sequential scans to prevent the page cache from being flooded with scan data that will not be reused, protecting the buffer pool pages used by index lookups.

## Dirty Writeback Tuning

Dirty page writeback controls how quickly the kernel flushes modified page cache pages to disk. The same tunables were covered from the memory perspective in [tuning databases](../mm/tuning-databases.md); this section looks at the I/O implications.

### The Writeback Tunables

```bash
# Current values
sysctl vm.dirty_ratio vm.dirty_background_ratio \
       vm.dirty_expire_centisecs vm.dirty_writeback_centisecs

# Typical defaults:
# vm.dirty_ratio = 20
# vm.dirty_background_ratio = 10
# vm.dirty_expire_centisecs = 3000   (30 seconds)
# vm.dirty_writeback_centisecs = 500 (5 seconds)
```

- **`dirty_background_ratio`**: Background writeback kicks in when dirty pages exceed this fraction of available memory. Keep it low (3–5%) to spread writeback evenly.
- **`dirty_ratio`**: Writers are throttled when dirty pages hit this level. This is a hard stall — the writing process sleeps until writeback catches up.
- **`dirty_expire_centisecs`**: Pages older than this are eligible for writeback even if the ratio thresholds are not met. Useful for bursty write workloads that produce many dirty pages quickly.
- **`dirty_writeback_centisecs`**: How often the per-device writeback threads wake to check for pages to flush.

### Tuning for Latency-Sensitive Workloads

The write-stall problem: on a 256GB server with `dirty_ratio=20`, up to 51GB of dirty data can accumulate before writers stall. When a checkpoint or sync event triggers a large flush, the resulting I/O storm saturates the device and stalls WAL writes.

```bash
# Low dirty ratios for databases: flush early and often
cat >> /etc/sysctl.d/io-database.conf << 'EOF'
vm.dirty_background_ratio = 3
vm.dirty_ratio = 8
vm.dirty_expire_centisecs = 1000
vm.dirty_writeback_centisecs = 200
EOF
sysctl --system
```

Or use absolute byte limits, which are more predictable on large-memory servers:

```bash
cat >> /etc/sysctl.d/io-database.conf << 'EOF'
vm.dirty_background_bytes = 134217728    # 128MB: start background writeback
vm.dirty_bytes = 536870912               # 512MB: hard stall threshold
EOF
```

!!! tip "Byte limits override ratio limits"
    When both `dirty_background_bytes` and `dirty_background_ratio` are set, the byte limit takes effect and the ratio is ignored. Use byte limits on servers with more than 64GB RAM where percentage-based thresholds become too large to be meaningful.

### Tuning for Write-Heavy Throughput

For bulk-ingest pipelines where throughput matters more than latency:

```bash
cat >> /etc/sysctl.d/io-bulk.conf << 'EOF'
vm.dirty_background_ratio = 15
vm.dirty_ratio = 40
vm.dirty_expire_centisecs = 6000
vm.dirty_writeback_centisecs = 1000
EOF
```

Larger thresholds allow writes to coalesce in the page cache and get flushed in larger sequential batches, which is more efficient for HDDs and benefits from writeback merging even on SSDs.

### Per-Device Writeback Throttling with cgroup v2

For mixed-workload servers, `io.max` in cgroup v2 allows per-device I/O rate limits independent of the system-wide dirty ratios:

```bash
# Limit backup job to 100MB/s writes on /dev/sda (major:minor 8:0)
echo "8:0 wbps=104857600" > /sys/fs/cgroup/backups/io.max

# Limit backup job to 1000 IOPS
echo "8:0 wiops=1000" > /sys/fs/cgroup/backups/io.max

# Check current limits
cat /sys/fs/cgroup/backups/io.max
```

This prevents a backup job from saturating the device and affecting database write latency, without touching global dirty ratio settings.

## O_DIRECT vs Buffered I/O

The choice between `O_DIRECT` and buffered I/O is one of the most consequential decisions for database I/O performance.

### The Double-Buffering Problem

A database with a 32GB buffer pool and buffered I/O uses memory twice: the database buffers data in its own pool, and the OS page cache holds a second copy of the same pages. On a 128GB server, this can mean 64GB consumed by two copies of the same data.

```
Buffered I/O with database:
┌─────────────────────────────────────────┐
│ OS Page Cache (32GB of duplicated data) │
├─────────────────────────────────────────┤
│ Database Buffer Pool (32GB)             │
├─────────────────────────────────────────┤
│ OS + Applications (~10GB)               │
└─────────────────────────────────────────┘
Total: 74GB used, 54GB wasted on duplication

O_DIRECT with database:
┌─────────────────────────────────────────┐
│ Database Buffer Pool (32GB)             │
├─────────────────────────────────────────┤
│ OS + Applications (~10GB)               │
│ Page cache (WAL, temp files, etc.)      │
└─────────────────────────────────────────┘
Total: ~45GB used, 83GB available
```

### When Databases Should Use O_DIRECT

**PostgreSQL** uses buffered I/O by default for data files but recommends `O_DIRECT`-equivalent behavior. Setting `effective_io_concurrency` and using `pg_prewarm` with direct I/O is the standard approach. For WAL, PostgreSQL's `wal_sync_method = open_datasync` uses `O_DIRECT | O_SYNC`.

**MySQL InnoDB** uses `O_DIRECT` when `innodb_flush_method = O_DIRECT`:

```ini
# /etc/my.cnf.d/innodb.cnf
[mysqld]
innodb_flush_method = O_DIRECT        # O_DIRECT for data files
# innodb_flush_method = O_DIRECT_NO_FSYNC  # Skip fsync if using battery-backed cache
```

**Oracle** enables `O_DIRECT` by default for datafiles when the filesystem supports it.

### Alignment Requirements

`O_DIRECT` imposes alignment requirements on the buffer address, file offset, and transfer size. All three must be aligned to the logical block size of the device (typically 512 bytes for SATA, 4096 bytes for NVMe with 4Kn format). Violating alignment returns `EINVAL`.

```bash
# Check the device's logical block size
cat /sys/block/nvme0n1/queue/logical_block_size
# 512  (or 4096 for 4Kn devices)

# Check physical block size (optimal alignment)
cat /sys/block/nvme0n1/queue/physical_block_size
# 4096
```

For application code, always align O_DIRECT buffers to the physical block size, not just the logical block size, to avoid internal partial-block reads in the device firmware.

```c
// Allocate an aligned buffer for O_DIRECT
void *buf;
posix_memalign(&buf, 4096, IO_SIZE);   // 4096-byte aligned, IO_SIZE multiple of 4096
```

### Benchmarking O_DIRECT with fio

```bash
# Compare buffered vs O_DIRECT for random 4K reads
# Buffered (first run fills cache, second run reads from cache):
fio --name=buffered-randread \
    --filename=/var/lib/postgresql/data/base/16384/1259 \
    --rw=randread --bs=4k --iodepth=8 --numjobs=4 \
    --runtime=30 --time_based --direct=0 \
    --lat_percentiles=1

# O_DIRECT (always goes to device):
fio --name=odirect-randread \
    --filename=/var/lib/postgresql/data/base/16384/1259 \
    --rw=randread --bs=4k --iodepth=8 --numjobs=4 \
    --runtime=30 --time_based --direct=1 \
    --lat_percentiles=1
```

### Downsides of O_DIRECT

- **No readahead**: The kernel cannot prefetch adjacent pages because `O_DIRECT` bypasses the page cache entirely. Applications that mix sequential and random access in the same process may lose readahead benefits for the sequential portions.
- **No page cache sharing**: If the same file is read by multiple processes (e.g., multiple PostgreSQL backends reading the same heap page), buffered I/O lets them share the cached page. `O_DIRECT` forces each process to go to the device independently unless the database manages its own shared buffer.
- **Alignment complexity**: Application code must manage buffer alignment explicitly.

For files accessed by exactly one process with its own buffer management (a database's data files), the benefits outweigh the costs. For files shared across processes or accessed sequentially without a cache (log files, temp files), buffered I/O is usually better.

## NVMe-Specific Tuning

NVMe devices are qualitatively different from SATA in ways that affect how the kernel should interact with them.

### IRQ Affinity for NVMe Completion Queues

Each NVMe hardware queue has a dedicated MSI-X interrupt. When a request completes, the NVMe controller raises this interrupt and the kernel's IRQ handler processes the completion. If this IRQ handler runs on a different CPU than the one that submitted the request, the completion data (including the result buffer) must cross CPU caches.

```bash
# List NVMe IRQ assignments
grep nvme /proc/interrupts

# Pin each NVMe queue IRQ to a specific CPU
# IRQ 35 → CPU 0, IRQ 36 → CPU 1, etc.
echo 1 > /proc/irq/35/smp_affinity_list
echo 2 > /proc/irq/36/smp_affinity_list

# Or use irqbalance with a policy hint
# /etc/sysconfig/irqbalance:
# IRQBALANCE_ARGS="--policy=exact"
```

For large NVMe deployments, CPU pinning reduces cross-NUMA cache misses on completion and can measurably improve p99 latency.

### io_poll: Busy-Polling Without IRQs

For ultra-low latency applications, `io_uring` with `IORING_SETUP_IOPOLL` (io_poll mode) avoids the IRQ path entirely. Instead of waiting for the NVMe controller to raise an interrupt, the kernel busy-polls the NVMe completion queue register.

This trades CPU cycles for latency:

```bash
# Benchmark io_uring HIPRI (poll) vs default IRQ path
fio --name=uring-poll \
    --ioengine=io_uring \
    --hipri=1 \
    --filename=/dev/nvme0n1 \
    --rw=randread \
    --bs=4k \
    --iodepth=1 \
    --numjobs=1 \
    --runtime=30 \
    --time_based \
    --direct=1 \
    --lat_percentiles=1

# Compare without polling
fio --name=uring-irq \
    --ioengine=io_uring \
    --hipri=0 \
    --filename=/dev/nvme0n1 \
    --rw=randread \
    --bs=4k \
    --iodepth=1 \
    --numjobs=1 \
    --runtime=30 \
    --time_based \
    --direct=1 \
    --lat_percentiles=1
```

io_poll is only worthwhile when:

- You have dedicated CPU cores available (it pins a core at 100% while polling).
- Latency SLA is below 100µs.
- Queue depth is low (1–4); at high queue depths, the IRQ path amortizes overhead across more requests.

### nomerges for NVMe

The block layer's merge logic combines adjacent requests into a single larger I/O to reduce IOPS. This is valuable for slow HDDs but counterproductive for NVMe where the device can handle hundreds of thousands of individual IOPS natively:

```bash
# Check current merge behavior
cat /sys/block/nvme0n1/queue/nomerges
# 0 = merging enabled (default)
# 1 = only contiguous merges
# 2 = no merges at all

# Disable merges for NVMe OLTP workloads
echo 2 > /sys/block/nvme0n1/queue/nomerges
```

Disabling merges reduces latency by eliminating the time the block layer spends searching the merge tree. The effect is measurable at high IOPS (>100K IOPS), where merge-tree lookups can become a bottleneck.

### nvme-tcp Latency

For NVMe-oF (NVMe over Fabrics) using TCP transport, additional tuning is needed at the network layer:

```bash
# Disable Nagle's algorithm on the NVMe-TCP connection socket
# (done via nvme-cli, not directly)
nvme connect -t tcp -a 192.168.1.100 -s 4420 -n nqn.example:storage1 \
    --reconnect-delay=1 --ctrl-loss-tmo=600

# TCP optimizations for NVMe-TCP
sysctl -w net.ipv4.tcp_nodelay=1          # Disable Nagle (reduce latency)
sysctl -w net.core.rmem_max=134217728     # 128MB receive buffer
sysctl -w net.core.wmem_max=134217728     # 128MB send buffer
```

## Filesystem Choices for I/O

The filesystem layer sits above the block device and adds metadata operations, journaling, and extent management overhead to every I/O path.

### XFS

XFS is the best choice for storage-heavy workloads on large files:

- Extent-based allocation reduces fragmentation for large sequential files.
- Per-inode allocation groups allow parallel writes to different files without contention.
- Delayed allocation coalesces small writes into larger extent allocations.
- Scalable B-tree metadata structures maintain performance as the filesystem fills up.

```bash
# Format with optimal settings for databases (adjust agcount for your CPU count)
mkfs.xfs -f \
    -d agcount=16 \
    -l size=256m,lazy-count=1 \
    /dev/nvme0n1p1

# Mount with performance options
mount -o noatime,nodiratime,logbufs=8,logbsize=256k /dev/nvme0n1p1 /var/lib/postgresql
```

### ext4

ext4 is a solid general-purpose choice with wide tooling support:

```bash
# Format for database workloads (larger journal, no lazy inode initialization delay)
mkfs.ext4 -E lazy_itable_init=0,lazy_journal_init=0 \
           -J size=1024 \
           /dev/sda1

# Mount options for database workloads
mount -o noatime,nodiratime,data=ordered,barrier=1 /dev/sda1 /var/lib/mysql
```

### btrfs

btrfs is generally not recommended for random-write database workloads. Its copy-on-write (CoW) design means that overwriting a page always writes to a new location, generating significantly more I/O and fragmentation than in-place-write filesystems:

```
In-place write (ext4/XFS):    single 4KB write → one 4KB I/O
CoW write (btrfs):            one 4KB write → read old block, write new block,
                               update parent tree node, possibly cascade
```

btrfs does have legitimate uses: incremental snapshots for backup pipelines, RAID integration, and checksumming for integrity-critical workloads. But for raw I/O performance with random writes, use XFS or ext4.

### Mount Options That Matter

**`noatime` / `nodiratime`**: By default, the kernel updates the `atime` (access time) of every file and directory on every read. This turns every read into a potential write (to update the inode). `noatime` disables this entirely; `nodiratime` disables it only for directories.

```bash
# Add to /etc/fstab
/dev/nvme0n1p1 /var/lib/postgresql xfs noatime,nodiratime 0 2
```

**`barrier=0`**: Write barriers ensure journal commits are durable by forcing a cache flush to the device before marking a journal transaction complete. Disabling barriers (`barrier=0`) improves write throughput but risks filesystem corruption if the system loses power mid-write.

```
With barrier:     write data → flush → write journal commit → flush
Without barrier:  write data + journal commit (no ordering guarantee)
```

Only disable barriers when the storage has a battery-backed write cache (RAID controller with BBU, enterprise NVMe with power-loss protection) that guarantees ordering persistence. Never disable on consumer SSDs.

```bash
# Only with battery-backed write cache:
mount -o noatime,barrier=0 /dev/nvme0n1p1 /var/lib/postgresql
```

**`data=writeback` for WAL partitions**: For the PostgreSQL WAL or MySQL redo log partition, `data=writeback` (ext4) allows the journal to log metadata changes without enforcing that data blocks are written first. Since the database's own WAL provides ordering guarantees, this is safe and reduces fsync latency:

```bash
# WAL-only partition: disable data ordering (database WAL provides safety)
mount -o noatime,data=writeback /dev/nvme1n1p1 /var/lib/postgresql/pg_wal
```

## HDD-Specific Tuning

Spinning disks have fundamentally different performance characteristics that require different tuning strategies.

### Detecting Rotational Media

```bash
# 1 = rotational (HDD), 0 = non-rotational (SSD/NVMe)
cat /sys/block/sda/queue/rotational
# 1

# List all block devices with their rotational status
lsblk -d -o NAME,ROTA,SCHED,RA,NR_HW_QUEUES
```

### Scheduler Selection for HDDs

For HDDs, the scheduler's reordering decisions directly affect throughput because the drive must physically seek between tracks. Use `bfq` for mixed workloads or `mq-deadline` for latency-sensitive single-workload databases:

```bash
echo bfq > /sys/block/sda/queue/scheduler

# BFQ tuning: increase maximum budget for sequential workloads
echo 8192 > /sys/block/sda/queue/iosched/max_budget

# Raise the timeout before a non-sequential request gets priority
echo 100 > /sys/block/sda/queue/iosched/slice_idle_us
```

### NCQ (Native Command Queuing) Depth

Modern HDDs support NCQ, which allows the drive to reorder up to 32 commands internally for optimal seek scheduling. Ensure NCQ is enabled and set the queue depth to use it:

```bash
# Check NCQ depth support
cat /sys/block/sda/device/queue_depth
# 32

# Set queue depth (reduce to 1 to effectively disable NCQ for testing)
echo 32 > /sys/block/sda/device/queue_depth

# Confirm via dmesg
dmesg | grep -i "ncq\|queue depth"
```

### Large Readahead for HDDs

On HDDs, a sequential read that triggers a seek is expensive (~5ms). Large readahead amortizes the seek cost over many pages:

```bash
# 16MB readahead window for sequential workloads on HDD
echo 16384 > /sys/block/sda/queue/read_ahead_kb
```

### Avoiding Mixed Random I/O on HDDs

A single HDD handling both random OLTP reads and sequential backup writes will perform poorly at both — the seek head cannot simultaneously optimize for both patterns. Use separate physical devices or at minimum separate disk arms.

If you must mix workloads on one HDD, use cgroup v2 `io.weight` with `bfq` to prioritize the latency-sensitive workload:

```bash
# High priority for the database, low for backup
echo "8:0 100" > /sys/fs/cgroup/databases/io.bfq.weight
echo "8:0 10"  > /sys/fs/cgroup/backups/io.bfq.weight
```

### HDD Checklist

```bash
#!/bin/bash
# hdd-check.sh: Verify HDD is configured for best performance
DEVICE=${1:-sda}

echo "=== $DEVICE HDD Configuration ==="
echo "Scheduler:   $(cat /sys/block/$DEVICE/queue/scheduler)"
echo "Rotational:  $(cat /sys/block/$DEVICE/queue/rotational)"
echo "Queue depth: $(cat /sys/block/$DEVICE/device/queue_depth 2>/dev/null || echo 'N/A')"
echo "Read-ahead:  $(cat /sys/block/$DEVICE/queue/read_ahead_kb) KB"
echo "nr_requests: $(cat /sys/block/$DEVICE/queue/nr_requests)"

# Check for write caching
hdparm -W /dev/$DEVICE 2>/dev/null | grep "write-caching"
```

## Benchmarking Methodology

A benchmark that produces misleading results is worse than no benchmark — it leads to tuning changes that hurt performance in production.

### Common Mistakes

1. **Not running long enough** — Storage devices have write caches. A 5-second benchmark will run entirely in the drive's DRAM cache and show unrealistically high throughput. Run for at least 60 seconds for SSDs, 120 seconds for HDDs.

2. **Not warming up** — The first several seconds of a benchmark often show different behavior as the device fills its cache or the kernel builds up readahead state. Use `--ramp_time=10` in fio.

3. **Testing on tmpfs** — `tmpfs` is DRAM. Any benchmark on tmpfs measures memory bandwidth, not storage. Always use a real block device or filesystem backed by physical storage.

4. **Wrong block size** — Using 128K blocks to benchmark a database whose actual I/O is 8K produces useless results. Match the benchmark block size to your application's actual I/O size.

5. **Not isolating the device** — If the OS is installed on the same device you are benchmarking, background I/O from the OS will corrupt the results. Use a dedicated device.

6. **Not matching the access pattern** — Random read IOPS and sequential read throughput are different numbers. Benchmark the pattern that matches your workload.

### fio Job Files

Using fio job files instead of command-line flags ensures reproducibility and makes it easy to share benchmark configurations:

**OLTP random 4K (simulates database random page reads)**

```ini
# oltp-randread.fio
[global]
ioengine=libaio
direct=1
runtime=120
time_based=1
ramp_time=10
numjobs=4
group_reporting=1
lat_percentiles=1
clat_percentiles=1

[randread-4k]
name=oltp-randread-4k
filename=/dev/nvme0n1
rw=randread
bs=4k
iodepth=32
```

```bash
fio oltp-randread.fio
```

**Sequential streaming 1M (simulates backup, analytics scan, log ingest)**

```ini
# sequential-1m.fio
[global]
ioengine=libaio
direct=1
runtime=120
time_based=1
ramp_time=10
group_reporting=1

[seqread-1m]
name=sequential-read-1m
filename=/dev/nvme0n1
rw=read
bs=1m
iodepth=4
numjobs=4

[seqwrite-1m]
name=sequential-write-1m
filename=/dev/nvme0n1
rw=write
bs=1m
iodepth=4
numjobs=4
```

**Mixed read/write (simulates OLTP with ongoing writes)**

```ini
# mixed-rw.fio
[global]
ioengine=libaio
direct=1
runtime=120
time_based=1
ramp_time=10
group_reporting=1
lat_percentiles=1
clat_percentiles=1

[mixed-oltp]
name=mixed-oltp-70r-30w
filename=/dev/nvme0n1
rw=randrw
rwmixread=70
bs=4k
iodepth=16
numjobs=4
```

### Interpreting fio Output

```
Jobs: 4 (f=4): [r(4)][100.0%][r=1824MiB/s,w=0KiB/s][r=466k,w=0 IOPS][eta 00m:00s]
mixed-oltp-70r-30w: (groupid=0, jobs=4): err= 0: pid=12345: ...
  read: IOPS=326k, BW=1274MiB/s (1336MB/s)(149GiB/120001msec)
    clat (usec): min=48, max=12806, avg=94.51, stdev=71.23
     lat (usec): min=48, max=12807, avg=94.63, stdev=71.24
    clat percentiles (usec):
     |  1.00th=[   59],  5.00th=[   64], 10.00th=[   68], 20.00th=[   73],
     | 50.00th=[   81], 75.00th=[   94], 90.00th=[  112], 95.00th=[  135],
     | 99.00th=[  247], 99.50th=[  363], 99.90th=[  742], 99.95th=[ 1045],
     | 99.99th=[ 3195]
```

Key metrics to record:

- **IOPS**: Total throughput in operations per second.
- **BW**: Bandwidth in MB/s (relevant for sequential workloads).
- **clat p50**: Median completion latency — what most requests experience.
- **clat p99**: 99th percentile — the latency budget you need for interactive queries.
- **clat p999**: 99.9th percentile — the tail that causes connection timeouts.

`group_reporting=1` aggregates results across all jobs into a single summary, which makes it easier to compare runs. Without it, you get one block of output per job.

### Warming the Cache

For benchmarks that include a cache-warm phase (simulating a server that has been running for hours):

```bash
# Warm the page cache or device cache before measuring
fio --name=warm \
    --filename=/dev/nvme0n1 \
    --rw=read \
    --bs=1m \
    --iodepth=8 \
    --numjobs=4 \
    --size=100% \
    --direct=0 \
    --loops=1

# Then run the actual benchmark
fio actual-workload.fio
```

For `O_DIRECT` benchmarks, the page cache is bypassed, but the device's internal DRAM cache still needs warming. Use `--ramp_time=30` to let the device cache fill before measuring.

## Practical Configuration Examples

### Dedicated NVMe Database Server

A complete I/O configuration for a server running PostgreSQL on NVMe:

```bash
#!/bin/bash
# nvme-database-tune.sh

NVME_DEV=nvme0n1

# Scheduler: none (let NVMe handle its own queuing)
echo none > /sys/block/$NVME_DEV/queue/scheduler

# No merges (NVMe can handle fine-grained I/O natively)
echo 2 > /sys/block/$NVME_DEV/queue/nomerges

# Minimal readahead (database manages its own prefetch)
echo 16 > /sys/block/$NVME_DEV/queue/read_ahead_kb

# Conservative dirty ratios (avoid write stalls)
sysctl -w vm.dirty_background_bytes=134217728  # 128MB
sysctl -w vm.dirty_bytes=536870912             # 512MB
sysctl -w vm.dirty_expire_centisecs=1000
sysctl -w vm.dirty_writeback_centisecs=200

echo "NVMe database tuning applied to $NVME_DEV"
```

```bash
# Persist via udev + sysctl.d
cat > /etc/udev/rules.d/60-nvme-database.rules << 'EOF'
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", \
  ATTR{queue/scheduler}="none", \
  ATTR{queue/nomerges}="2", \
  ATTR{queue/read_ahead_kb}="16"
EOF

cat > /etc/sysctl.d/30-io-database.conf << 'EOF'
vm.dirty_background_bytes = 134217728
vm.dirty_bytes = 536870912
vm.dirty_expire_centisecs = 1000
vm.dirty_writeback_centisecs = 200
EOF
```

### HDD Data Warehouse Server

For sequential-heavy analytics on HDDs:

```bash
#!/bin/bash
# hdd-dw-tune.sh

HDD_DEV=sda

# BFQ scheduler for rotational media
echo bfq > /sys/block/$HDD_DEV/queue/scheduler

# Large readahead for sequential scans
echo 8192 > /sys/block/$HDD_DEV/queue/read_ahead_kb

# Full NCQ depth
echo 32 > /sys/block/$HDD_DEV/device/queue_depth

# Higher dirty thresholds: let writes coalesce before flushing
sysctl -w vm.dirty_background_ratio=15
sysctl -w vm.dirty_ratio=40

echo "HDD data warehouse tuning applied to $HDD_DEV"
```

## Monitoring I/O Health

```bash
#!/bin/bash
# io-health.sh: Quick I/O subsystem health check

echo "=== I/O Scheduler Configuration ==="
for dev in $(lsblk -d -n -o NAME); do
    sched=$(cat /sys/block/$dev/queue/scheduler 2>/dev/null | tr -d '[]' | awk '{print $1}')
    rota=$(cat /sys/block/$dev/queue/rotational 2>/dev/null)
    ra=$(cat /sys/block/$dev/queue/read_ahead_kb 2>/dev/null)
    printf "  %-12s  scheduler=%-12s  rotational=%s  read_ahead=%s KB\n" \
           "$dev" "$sched" "$rota" "$ra"
done

echo ""
echo "=== Dirty Page Status ==="
grep -E "^Dirty:|^Writeback:" /proc/meminfo

echo ""
echo "=== I/O Wait ==="
iostat -x 1 3 | awk '/^Device/{header=1} header && /[0-9]/{print $1, "await="$10, "util="$NF}'

echo ""
echo "=== Block Layer Errors ==="
dmesg --since "1 hour ago" 2>/dev/null | grep -iE "blk_|io error|medium error|ata.*error" | tail -10
```

## Further Reading

- [docs.kernel.org: block layer documentation](https://docs.kernel.org/block/index.html) — Kernel documentation for the block subsystem, schedulers, and blk-mq
- [docs.kernel.org: admin-guide sysctl vm](https://docs.kernel.org/admin-guide/sysctl/vm.html) — Full reference for `vm.*` tunables including dirty writeback
- [LWN: The multiqueue block layer](https://lwn.net/Articles/552904/) — Design of blk-mq, the basis for all modern I/O schedulers
- [LWN: io_uring](https://lwn.net/Articles/776703/) — io_uring design and comparison with libaio
- [LWN: BFQ, the budget fair queueing scheduler](https://lwn.net/Articles/601799/) — How BFQ works and when to use it
- [fio documentation](https://fio.readthedocs.io/) — Full fio reference including all engine options and output fields
- [block/blk-mq.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-mq.c) — Multi-queue block layer implementation
- [block/mq-deadline.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/mq-deadline.c) — mq-deadline scheduler source
- [block/kyber-iosched.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/kyber-iosched.c) — Kyber scheduler source
- [mm/readahead.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/readahead.c) — Readahead implementation
- [Readahead](readahead.md) — How the kernel's readahead window grows and shrinks
- [Direct I/O](direct-io.md) — O_DIRECT alignment rules and kernel path
- [Tuning Memory for Databases](../mm/tuning-databases.md) — Companion guide covering huge pages, swappiness, and NUMA for the same workloads
