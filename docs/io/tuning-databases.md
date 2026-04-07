# Tuning I/O for Databases

> How database workloads break the kernel's I/O defaults, and how to fix it

## Why databases need special I/O tuning

A general-purpose Linux kernel is tuned for a mix of workloads. Databases break nearly every assumption those defaults make about I/O behavior.

```
General-purpose workload:              Database workload:
┌─────────────────────────┐            ┌─────────────────────────┐
│ Sequential file reads   │            │ Random page reads       │
│ Readahead is helpful    │            │ Readahead wastes I/O    │
│ Page cache is good      │            │ Buffer pool > page cache│
│ Write ordering flexible │            │ fsync on every commit   │
│ I/O can be deferred     │            │ Latency < throughput    │
└─────────────────────────┘            └─────────────────────────┘
```

Four properties define database I/O:

1. **Random access patterns.** Index lookups, row fetches, and hash joins access pages at arbitrary offsets. Readahead prefetches adjacent pages that are never read, wasting bandwidth and evicting useful pages.

2. **Application-managed caching.** PostgreSQL has its shared buffer pool, MySQL has the InnoDB buffer pool. These are explicitly managed caches that know what's hot. The kernel page cache is a second, redundant cache for the same data — it consumes RAM without benefit when using `O_DIRECT`.

3. **Durability requirements.** Every committed transaction must be on durable storage. This requires `fsync()` on the WAL, which must complete before returning to the client. Write latency is bounded by fsync latency, which is bounded by storage device characteristics.

4. **Write amplification from journaling.** A database already does its own journaling (WAL). A filesystem that also journals its metadata writes every transaction twice: once in the WAL, once in the filesystem journal. ext4 in `data=ordered` mode causes an additional ordering flush that databases don't need.

---

## Direct I/O: bypassing the page cache

The single highest-impact optimization for databases is `O_DIRECT` — bypassing the page cache entirely for data files.

```c
/* PostgreSQL uses O_DIRECT for data files when configured */
int fd = open("base/16384/1259", O_RDWR | O_DIRECT | O_NOATIME);
```

Without `O_DIRECT`, every read and write goes through the page cache. For a database with a 32GB buffer pool on a 64GB machine, the kernel is caching the same data in two places: the database's buffer pool and the kernel page cache. The page cache copy wastes 32GB of RAM and adds a copy on every read.

**PostgreSQL `direct_io` mode** (added in PostgreSQL 16):

```ini
# postgresql.conf
io_method = io_uring   # or: worker (uses O_DIRECT with thread pool)
```

For PostgreSQL < 16, `O_DIRECT` requires the `pg_directio` patch or using a filesystem mounted with `directio` (Solaris) or configuring via `storage_parameters`.

**MySQL/InnoDB:**

```ini
# my.cnf
innodb_flush_method = O_DIRECT        # data files: O_DIRECT
# innodb_flush_method = O_DIRECT_NO_FSYNC  # data files: O_DIRECT, no extra fsync on flush
```

`O_DIRECT_NO_FSYNC` is safe if the storage controller has a battery-backed cache (BBWC), because the controller guarantees ordering and durability on power loss.

**Checking if direct I/O is active:**

```bash
# Check open flags for database data files
# O_DIRECT = 0x4000 (16384 decimal, 040000 octal)
grep flags /proc/$(pgrep -f postgres)/fdinfo/* 2>/dev/null | awk -F: '{printf "%s: 0x%x\n", $1, strtonum($2)}'

# Or use lsof and look for the access mode
lsof -p $(pgrep -f mysqld) | grep '.ibd'
```

---

## Writeback tuning for WAL-heavy workloads

Databases write to WAL continuously. Without tuning, dirty page accumulation can trigger write stalls:

```bash
# Check current dirty state
grep -E '(nr_dirty|nr_writeback|dirty_thresh)' /proc/vmstat

# Default thresholds (often too aggressive for databases):
cat /proc/sys/vm/dirty_ratio            # default: 20% — too high
cat /proc/sys/vm/dirty_background_ratio # default: 10% — too high
```

**Recommended for database servers:**

```bash
# Use absolute byte values instead of ratios (more predictable)
# On a server with 64GB RAM, set background writeback to start at 512MB dirty data
echo $((512 * 1024 * 1024)) > /proc/sys/vm/dirty_background_bytes

# Start throttling writers at 1GB dirty — prevents large burst latency spikes
echo $((1 * 1024 * 1024 * 1024)) > /proc/sys/vm/dirty_bytes

# Run writeback more frequently (every 500ms instead of 500cs = 5s default)
echo 50 > /proc/sys/vm/dirty_writeback_centisecs

# Flush dirty pages sooner (after 1s instead of 30s default)
echo 100 > /proc/sys/vm/dirty_expire_centisecs
```

The logic: databases call `fsync()` explicitly on WAL. They don't need the kernel to hold dirty pages in the page cache for seconds. Flushing sooner and more often keeps `nr_dirty` low, which prevents `balance_dirty_pages()` stalls from interrupting write operations.

---

## Scheduler selection for database I/O

The I/O scheduler sits between the block layer and the device driver. It merges and reorders requests. The wrong scheduler adds latency.

```bash
# Check available schedulers
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq

# For NVMe SSDs: use 'none' (the device has its own internal queue)
echo none > /sys/block/nvme0n1/queue/scheduler

# For SATA SSDs: mq-deadline or none
echo mq-deadline > /sys/block/sda/queue/scheduler

# For spinning disks (rare for databases): mq-deadline
echo mq-deadline > /sys/block/sda/queue/scheduler
```

**Why `none` for NVMe:**

NVMe devices have multiple hardware queues (often 32-256), each capable of handling thousands of I/Os in parallel. The kernel I/O scheduler was designed for single-queue spinning disks where reordering matters. NVMe has no seek penalty; reordering provides no benefit and adds latency overhead.

```bash
# Verify NVMe queue depth
cat /sys/block/nvme0n1/queue/nr_requests   # kernel-side queue depth
nvme id-ctrl /dev/nvme0 | grep qsize       # device-reported queue size
```

---

## Queue depth tuning

```bash
# Increase queue depth for high-IOPS workloads
cat /sys/block/nvme0n1/queue/nr_requests  # default: 1023 for NVMe
echo 2048 > /sys/block/nvme0n1/queue/nr_requests

# Check current in-flight I/O count
cat /sys/block/nvme0n1/inflight
# reads: 4   writes: 12
```

For databases doing many concurrent writes (OLTP with many connections), a higher queue depth allows more I/Os to be in flight simultaneously. The optimal value is workload-dependent: start at 2× the device's internal queue size and reduce if latency increases.

---

## Filesystem selection and configuration

### ext4 for database data directories

```bash
# Mount options for database data directories
# journal_async_commit: allow journal commits to overlap
# noatime: don't update access time on read (saves I/O)
# data=ordered: default — safe, no extra overhead for databases using O_DIRECT
mount -o noatime,journal_async_commit,data=ordered /dev/sda1 /var/lib/postgresql

# For WAL directories specifically, data=writeback is safe if the database
# does its own fsync (PostgreSQL does; MySQL InnoDB does)
mount -o noatime,data=writeback /dev/sdb1 /var/lib/postgresql/pg_wal
```

!!! warning "data=writeback and crash safety"
    `data=writeback` is only safe for database WAL directories if the database application calls `fsync()` before considering a transaction committed. See [War Stories: Data Loss](war-stories-data-loss.md) for what happens when this assumption is violated.

### XFS for large database files

XFS handles large files and high-concurrency writes better than ext4 for some database workloads:

```bash
# XFS mount options for databases
mount -o noatime,logbsize=256k /dev/sda1 /var/lib/mysql

# Increase log buffer size (reduces log I/O frequency)
# Default logbsize is 32KB; 256KB reduces log I/Os by 8×
# Maximum is 256KB for most configurations

# For very write-heavy workloads, an external log device improves
# checkpoint latency:
mkfs.xfs -l logdev=/dev/sdb /dev/sda
mount -o logdev=/dev/sdb /dev/sda /var/lib/mysql
```

---

## PostgreSQL-specific I/O tuning

```ini
# postgresql.conf — I/O related parameters

# Buffer pool: set to 25-30% of RAM
shared_buffers = 16GB

# Hint to the OS about total memory available for caching
effective_cache_size = 48GB  # RAM - shared_buffers - OS overhead

# WAL settings
wal_buffers = 64MB           # WAL write buffer (default: 1/32 of shared_buffers)
wal_compression = lz4        # Compress WAL records (reduces fsync load)
wal_level = replica          # Minimum for WAL archiving/replication

# Checkpoint tuning: spread checkpoint I/O over time
checkpoint_completion_target = 0.9   # Write 90% of dirty pages before deadline
checkpoint_timeout = 15min           # Target: checkpoint every 15 minutes
max_wal_size = 4GB                   # Trigger checkpoint after this much WAL

# I/O concurrency for parallel scans
effective_io_concurrency = 200       # NVMe: 200+; SATA SSD: 10-50; HDD: 2
maintenance_io_concurrency = 100     # For VACUUM, index builds

# Disable readahead hint for random workloads
random_page_cost = 1.1               # NVMe: 1.1 (close to seq cost); HDD: 4.0
seq_page_cost = 1.0
```

**PostgreSQL checkpoint I/O visualization:**

```
Without tuning (checkpoint_completion_target=0.5):
Time: |---work---|---work---|---CHECKPOINT BURST---|---work---|
I/O:  |  normal  |  normal  |  ████████████████  |  normal  |
                              ^ latency spike here

With tuning (checkpoint_completion_target=0.9):
Time: |---work---|---work---|---work---|---work---|---checkpoint---|
I/O:  |  normal  | ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ | finish |
                    ^ gradual write spread over entire interval
```

---

## MySQL/InnoDB-specific I/O tuning

```ini
# my.cnf — InnoDB I/O parameters

# Buffer pool
innodb_buffer_pool_size = 48G        # 60-80% of RAM for dedicated MySQL servers
innodb_buffer_pool_instances = 8     # Parallel instances reduce contention

# I/O threads
innodb_read_io_threads = 8           # Parallel read threads
innodb_write_io_threads = 8          # Parallel write threads

# Flush method
innodb_flush_method = O_DIRECT       # Bypass page cache for data files
innodb_flush_log_at_trx_commit = 1   # fsync log after every commit (ACID)
# innodb_flush_log_at_trx_commit = 2 # Write to OS buffer, flush every second
#                                     (risky: up to 1 second of data loss on crash)

# I/O capacity — tell InnoDB how many IOPS the storage can handle
innodb_io_capacity = 2000            # SATA SSD: 2000; NVMe: 10000+
innodb_io_capacity_max = 4000        # Maximum burst IOPS for urgent flushing

# Log file tuning
innodb_log_file_size = 2G            # Larger = fewer checkpoints = better write throughput
innodb_log_buffer_size = 256M        # Buffer uncommitted transaction data

# Doublewrite buffer (crash protection)
innodb_doublewrite = 1               # Required for data safety on partial page writes
# Can disable if using ZFS or if storage guarantees atomic 16KB writes
```

---

## Redis I/O tuning

Redis is an in-memory store, but its persistence options (RDB snapshots and AOF) interact significantly with the kernel I/O stack.

```ini
# redis.conf — persistence I/O parameters

# AOF (Append-Only File) sync policy
appendfsync everysec    # fsync every second — good balance (default)
# appendfsync always    # fsync every write — safest, slowest
# appendfsync no        # let OS decide — fastest, most data loss risk on crash

# Rewrite settings
no-appendfsync-on-rewrite yes   # Don't fsync during AOF rewrite
# This is safe because the rewrite creates a new file atomically,
# and the old AOF is still being synced by the background thread.

auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb

# RDB: avoid fork() + write stalls interfering with serving
rdbcompression yes
rdbchecksum yes
stop-writes-on-bgsave-error yes
```

**Handling Redis fork() COW I/O pressure:**

Redis RDB snapshots and AOF rewrites use `fork()`. The child process writes the snapshot while the parent serves requests. Copy-on-write means that every page the parent modifies during the fork must be duplicated. On a large Redis instance with a write-heavy workload, this can cause significant I/O (and memory) pressure.

```bash
# Monitor COW pressure during a BGSAVE
redis-cli info persistence | grep rdb_changes_since_last_save

# Watch for elevated dirty pages during fork
watch -n 1 'grep nr_dirty /proc/vmstat'

# THP can dramatically increase COW cost (one 2MB write = 2MB copy vs 4KB)
# Disable THP for Redis servers:
echo never > /sys/kernel/mm/transparent_hugepage/enabled
```

---

## Storage device selection guide

| Storage type | Read IOPS | Write IOPS | fsync latency | Recommendation |
|---|---|---|---|---|
| SATA SSD | 80K | 50K | 1-3ms | Small databases, secondary storage |
| NVMe Gen3 | 500K | 300K | 0.1-0.5ms | Production OLTP |
| NVMe Gen4/5 | 1M+ | 700K+ | 0.05-0.2ms | Latency-critical, high-concurrency |
| Optane/PMEM | 2M+ | 2M+ | 10-20µs | Extreme latency requirements |
| Spinning disk | 150 | 100 | 5-10ms | Archive, bulk storage only |

**fsync latency matters more than throughput for databases.** A database doing 1000 TPS with `fsync` on every commit is I/O bound by `1000 × fsync_latency`. At 1ms fsync latency (NVMe Gen3), that's 1s of pure I/O overhead per second — the theoretical maximum is ~1000 TPS. At 5ms (SATA SSD), maximum TPS from fsync alone is 200.

```bash
# Measure fsync latency on your storage
# Use fio's sync test
fio --name=fsync_test --rw=write --bs=4k --direct=1 \
    --numjobs=1 --iodepth=1 --fsync=1 \
    --filename=/var/lib/postgresql/fsync_test \
    --size=1G --time_based --runtime=30 \
    --output-format=normal

# Look for: clat percentiles — this is your fsync latency distribution
```

---

## Related pages

- [Tuning Storage I/O](tuning-storage.md) — general-purpose I/O sysctl reference
- [Tuning I/O for Containers](tuning-containers.md) — cgroup I/O isolation for databases in containers
- [Direct I/O](direct-io.md) — how O_DIRECT works in the kernel
- [Writeback Internals](writeback-internals.md) — dirty throttling algorithm
- [War Stories: Data Loss](war-stories-data-loss.md) — what breaks when durability is misconfigured
- [fsync, fdatasync, and O_SYNC](fsync-fdatasync.md) — durability semantics
