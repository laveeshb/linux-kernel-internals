# Tuning I/O for Streaming and High-Throughput Workloads

> Maximizing sequential read and write throughput for video, backup, ETL, and data pipeline workloads

## What streaming I/O looks like

Streaming workloads read or write data sequentially at high rates: video encoding/decoding, backup agents, log aggregation, ETL pipelines, Kafka brokers, and Hadoop/Spark. Their I/O pattern is:

```
Streaming write pattern:
Offset: 0     4MB    8MB    12MB   16MB   ...
        ████  ████  ████  ████  ████  →  sequential, large, aligned

Streaming read pattern:
Offset: 0     4MB    8MB    12MB   16MB   ...
        ████→ ████→ ████→ ████→ ████→    sequential scan, one pass

Contrast with random I/O:
Offset: 12MB  1MB   7MB   3MB   15MB   ...
        ████  ████  ████  ████  ████       random jumps, small sizes
```

The kernel's default configuration already favors sequential I/O through readahead and writeback coalescing — but defaults leave significant throughput on the table for workloads that are *exclusively* sequential.

---

## Readahead: the primary lever for streaming reads

The kernel's readahead mechanism pre-fetches data from disk ahead of the current read position. For streaming reads, aggressive readahead directly translates to throughput: the device stays busy reading while the application processes previously fetched data.

```bash
# Current readahead size
cat /sys/block/sda/queue/read_ahead_kb    # default: 128KB

# For streaming reads, increase substantially
echo 4096 > /sys/block/sda/queue/read_ahead_kb   # 4MB readahead
echo 8192 > /sys/block/nvme0n1/queue/read_ahead_kb  # 8MB for NVMe

# The optimal value depends on:
# - Storage latency (higher latency → larger readahead to keep device busy)
# - Memory available for caching
# - How much data is read sequentially before seeking
```

**Calculating the optimal readahead window:**

The readahead window should keep the device busy during application processing time. For a device delivering 2GB/s with 0.1ms latency per request at 128KB:

```
Without readahead (synchronous reads):
  App requests 128KB → device serves in 64µs → app processes → repeat
  Throughput: 128KB / 64µs ≈ 2GB/s (device-limited, but only if app is fast enough)

With 4MB readahead:
  Device is 4MB ahead of the app at all times
  App can process for up to 4MB / 2GB/s = 2ms before needing more data
  This allows substantial CPU processing between reads without stalling
```

**Per-file readahead with `posix_fadvise`:**

```c
/* Tell the kernel this file will be read sequentially — triggers large readahead */
posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL);

/* For files you won't need in the page cache after reading (streaming/single-pass) */
posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);

/* Combination for streaming single-pass reads: aggressive readahead, no cache pollution */
posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL);
/* ... read chunk ... */
posix_fadvise(fd, processed_offset, chunk_size, POSIX_FADV_DONTNEED);
```

`POSIX_FADV_DONTNEED` on already-processed data prevents the page cache from filling with single-pass data and evicting working-set pages for other processes. This is critical on a server running both streaming workloads and other services.

---

## Write buffering: letting the page cache absorb bursts

For streaming writes, the page cache acts as a write buffer. Writes go to the page cache immediately and are flushed to storage asynchronously by writeback threads. The application can write faster than the device can absorb, up to the dirty limit.

```bash
# Tune for streaming write workloads

# Allow more dirty data in memory before throttling
# Default: 20% of RAM. For dedicated streaming servers: 40-60%
echo 40 > /proc/sys/vm/dirty_ratio

# Background writeback starts at this threshold
# Default: 10%. For streaming: 20-30%
echo 20 > /proc/sys/vm/dirty_background_ratio

# Let dirty data sit longer before flushing (reduces write amplification
# from small batches). Default: 3000 (30s). For streaming: 6000 (60s)
echo 6000 > /proc/sys/vm/dirty_expire_centisecs

# Run writeback less frequently (larger batches per flush)
# Default: 500 (5s). For streaming: 1000 (10s)
echo 1000 > /proc/sys/vm/dirty_writeback_centisecs
```

!!! warning "Dirty ratio and crash risk"
    A high `dirty_ratio` means more data is in memory but not yet on disk. A system crash or power failure when 40% of RAM is dirty can lose gigabytes of data. Only use high dirty ratios for workloads where data loss is acceptable (ephemeral data, easily regenerated data) or where the storage has a battery-backed write cache.

---

## Large I/O size alignment

Streaming workloads should write in large, aligned chunks. The kernel can submit large sequential I/Os as a single BIO (block I/O request), maximizing device efficiency.

```bash
# Check maximum request size the device handles efficiently
cat /sys/block/nvme0n1/queue/max_sectors_kb   # e.g.: 512
cat /sys/block/sda/queue/max_hw_sectors_kb    # hardware maximum

# For streaming writes, match the I/O size to the device's preferred chunk:
# NVMe: 256KB-1MB chunks
# SATA SSD: 128KB-256KB chunks
# HDD: 1MB-8MB chunks (rotational latency amortization)
```

**In application code:**

```c
/* Streaming write: use large aligned buffers */
#define STREAM_BUF_SIZE (1 * 1024 * 1024)  /* 1MB */

void *buf;
posix_memalign(&buf, 4096, STREAM_BUF_SIZE);

while (has_data()) {
    size_t n = fill_buffer(buf, STREAM_BUF_SIZE);
    write(fd, buf, n);  /* kernel coalesces into large BIO */
}
```

For io_uring, use vectored writes with `IORING_OP_WRITEV` to submit multiple 256KB buffers at once, reducing syscall overhead.

---

## Bypass the page cache for single-pass streaming

When data will be read or written only once (backup dumps, log rotation, video encoding input), the page cache wastes RAM and evicts useful data without benefit.

**For single-pass reads:**

```c
/* O_DIRECT: bypass page cache, read directly into userspace buffer */
int fd = open(path, O_RDONLY | O_DIRECT);

/* Or: use buffered I/O but advise no caching */
int fd = open(path, O_RDONLY);
posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL | POSIX_FADV_NOREUSE);
/* After reading each block: */
posix_fadvise(fd, offset, block_size, POSIX_FADV_DONTNEED);
```

**For single-pass writes (backup, dump):**

```c
/* Write through to device without page cache buffering */
int fd = open(path, O_WRONLY | O_DIRECT);
/* Requires 512-byte or 4096-byte aligned buffers */
```

**Why this matters for a shared server:**

A 100GB backup running with buffered I/O will fill the page cache with 100GB of data that will never be read again, evicting the working sets of databases, web servers, and other running processes. On a 64GB server, a full-cache backup can cause a 40-60% performance hit to other services for 10-20 minutes afterward as their working sets are re-faulted from disk.

---

## Parallel I/O streams

Modern NVMe devices have multiple hardware queues and are designed for parallel I/O. A single sequential stream may not saturate the device:

```bash
# NVMe: number of hardware queues
cat /sys/block/nvme0n1/mq/     # one directory per queue

# Test: single stream vs multiple streams
# Single stream:
fio --name=single --rw=read --bs=1M --direct=1 \
    --numjobs=1 --iodepth=4 --filename=/dev/nvme0n1 \
    --size=10G --time_based --runtime=30

# Multiple parallel streams (often 2-4× faster on NVMe):
fio --name=parallel --rw=read --bs=1M --direct=1 \
    --numjobs=4 --iodepth=4 --filename=/dev/nvme0n1 \
    --size=10G --time_based --runtime=30 --group_reporting
```

For high-speed NVMe (7GB/s rated), a single stream may only achieve 4-5GB/s due to CPU/PCIe bottlenecks. Parallel streams distribute across multiple CPU cores and PCIe lanes.

---

## Kafka broker I/O tuning

Kafka is a canonical streaming workload: producers write to partition logs sequentially, consumers read from different offsets on the same logs simultaneously.

```bash
# Kafka I/O pattern:
# - Producers: sequential append to partition files
# - Consumers: sequential reads from various offsets (readahead essential)
# - Replication: sequential reads of recent data → shares readahead benefit

# Kernel settings for Kafka brokers:

# Large dirty buffer (Kafka writes are bursty and sequential)
echo 40 > /proc/sys/vm/dirty_ratio
echo 15 > /proc/sys/vm/dirty_background_ratio

# Longer dirty expiry (Kafka segments are long-lived, frequent fsync via flush config)
echo 3000 > /proc/sys/vm/dirty_expire_centisecs

# Aggressive readahead for consumer reads
echo 4096 > /sys/block/nvme0n1/queue/read_ahead_kb

# Kafka application settings to match:
# log.flush.interval.messages=Long.MAX_VALUE  # let OS handle flushing
# log.flush.interval.ms=Long.MAX_VALUE        # rely on replication for durability
# log.retention.bytes=107374182400            # 100GB per partition
```

**Why Kafka relies on the page cache:**

Kafka intentionally does not maintain its own buffer pool. Consumer reads that are close behind producers (the common case: the same recently written data) are served directly from the page cache without a disk read. The kernel's readahead brings subsequent segments into cache proactively. This zero-copy path from producer to consumer is Kafka's performance secret — see Kafka's performance documentation and the [splice/sendfile internals](splice-sendfile.md).

---

## HDFS DataNode I/O tuning

Hadoop DataNodes receive large blocks (128MB-256MB) from clients and write them to local storage. The pattern is sequential write followed by sequential reads from multiple clients.

```bash
# DataNode storage: large sequential I/Os, multiple concurrent streams
# Typically 4-12 drives per node (JBOD, not RAID)

# Per-disk readahead: set high for replication reads
for disk in /sys/block/sd*; do
    echo 8192 > $disk/queue/read_ahead_kb
done

# Allow large dirty buffers (DataNodes have significant RAM)
echo 40 > /proc/sys/vm/dirty_ratio
echo 20 > /proc/sys/vm/dirty_background_ratio

# HDFS application settings:
# dfs.datanode.data.dir — one directory per disk (parallel streams)
# dfs.datanode.handler.count — match to number of disks × 2
# dfs.client.read.shortcircuit — enable for local client reads (zero-copy)
```

---

## Video streaming server I/O tuning

A video streaming server reads large files sequentially and sends them to clients. The working set is large (active video catalog) and access is somewhat random by file but sequential within each file.

```bash
# Moderate readahead: good for per-file sequential access
# But not too large — too many concurrent files would consume RAM
echo 2048 > /sys/block/nvme0n1/queue/read_ahead_kb  # 2MB per file

# Use posix_fadvise in the application for each video file:
# SEQUENTIAL: enables larger per-file readahead
# DONTNEED after send: frees cache after streaming (if files are large and single-pass)

# sendfile() for zero-copy delivery to network sockets
# The kernel reads from file → NIC DMA directly, bypassing userspace copy
ssize_t sent = sendfile(client_sockfd, file_fd, &offset, chunk_size);

# For HTTP range requests (seeking within video):
posix_fadvise(fd, range_start, range_end - range_start, POSIX_FADV_WILLNEED);
```

---

## Throughput measurement and validation

```bash
# fio: streaming benchmark
fio --name=stream_read \
    --rw=read \
    --bs=1M \
    --direct=1 \
    --numjobs=1 \
    --iodepth=32 \
    --filename=/dev/nvme0n1 \
    --size=20G \
    --time_based \
    --runtime=60 \
    --output-format=normal \
    --group_reporting

# Target metrics:
# NVMe Gen4 sequential: 5-7 GB/s read, 4-6 GB/s write
# SATA SSD sequential: 400-550 MB/s read, 350-500 MB/s write
# HDD sequential: 100-200 MB/s read, 80-150 MB/s write

# Compare with and without readahead:
echo 0 > /sys/block/nvme0n1/queue/read_ahead_kb
fio --name=no_ra --rw=read --bs=4k --direct=0 ...   # buffered without readahead

echo 4096 > /sys/block/nvme0n1/queue/read_ahead_kb
fio --name=ra --rw=read --bs=4k --direct=0 ...      # buffered with readahead
```

---

## Quick reference: streaming tuning by storage type

| Setting | HDD | SATA SSD | NVMe |
|---------|-----|----------|------|
| `read_ahead_kb` | 8192 | 4096 | 2048-4096 |
| `dirty_ratio` | 40% | 30% | 20-30% |
| `dirty_background_ratio` | 20% | 15% | 10-15% |
| `scheduler` | `mq-deadline` | `mq-deadline` | `none` |
| `nr_requests` | 256 | 256 | 1024 |
| I/O size | 1-8MB | 256KB-1MB | 256KB-1MB |
| Parallel streams | 1-2 | 2-4 | 4-8 |

---

## Related pages

- [Readahead](readahead.md) — how the kernel readahead algorithm works
- [splice, sendfile, and Zero-Copy](splice-sendfile.md) — zero-copy for network streaming
- [Writeback Internals](writeback-internals.md) — dirty page lifecycle
- [Tuning Storage I/O](tuning-storage.md) — complete sysctl reference
- [Tuning I/O for Databases](tuning-databases.md) — when you need latency, not throughput
- [Buffered I/O and the Page Cache](buffered-io.md) — how buffered writes work
