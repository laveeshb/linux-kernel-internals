# Tuning Memory for Databases

> Why databases fight the kernel's defaults, and how to fix it

## Why Databases Need Special Memory Tuning

A general-purpose Linux kernel is tuned for a mix of workloads: compiling code, serving web pages, running containers. Databases break nearly every assumption those defaults are built on.

Three properties make databases different:

1. **Large shared buffers** - A production PostgreSQL instance might allocate 25% of RAM (32GB+) as a single shared memory region. MySQL's InnoDB buffer pool can be even larger. These are long-lived, heavily accessed allocations that the kernel must not fragment or swap out.

2. **Random I/O patterns** - The kernel's readahead and page cache heuristics assume sequential access. Databases perform random lookups by primary key, index scans that jump across pages, and hash joins. The page cache wastes memory prefetching data that is never read.

3. **Latency sensitivity** - A web server can absorb a 50ms stall without anyone noticing. A database holding row locks during a 50ms compaction stall causes cascading lock waits, connection pile-ups, and visible application latency. Predictability matters more than throughput.

```
General-purpose workload:              Database workload:
┌─────────────────────────┐            ┌─────────────────────────┐
│ Many small allocations  │            │ Few huge allocations    │
│ Sequential file access  │            │ Random page access      │
│ Throughput-oriented     │            │ Latency-sensitive       │
│ Short-lived processes   │            │ Long-lived daemon       │
│ Tolerates swap          │            │ Cannot tolerate swap    │
└─────────────────────────┘            └─────────────────────────┘
```

The rest of this page walks through the kernel tunables that address each of these problems, with practical examples for PostgreSQL, MySQL/MariaDB, and Redis.

## Huge Pages for Shared Buffers

### The Problem

A 32GB shared buffer pool backed by 4KB pages means 8,388,608 page table entries. Every TLB miss during a buffer pool lookup triggers a multi-level page table walk. On a busy OLTP system, TLB misses on the shared buffer become a measurable overhead.

Huge pages (2MB) reduce the page table entry count by 512x. For a 32GB buffer pool, that is 16,384 entries instead of 8 million.

### hugetlbfs: Static Huge Pages

Unlike [THP](thp.md), hugetlbfs pages are pre-allocated at boot and never fragmented or reclaimed. This is exactly what databases want: guaranteed, stable huge page backing for their shared buffers.

#### Reserve Huge Pages

```bash
# Reserve 16384 huge pages (32GB with 2MB pages)
echo 16384 > /proc/sys/vm/nr_hugepages

# Or at boot via kernel command line (more reliable for large reservations):
# hugepages=16384

# Verify allocation:
cat /proc/meminfo | grep -i huge
# HugePages_Total:   16384
# HugePages_Free:    16384
# HugePages_Rsvd:        0
# Hugepagesize:       2048 kB
```

!!! warning "Reserve early"
    Huge page reservation can fail after the system has been running because physical memory becomes fragmented. For production databases, reserve at boot via the kernel command line or via a systemd unit that runs before the database starts.

The kernel's hugetlb subsystem is implemented in [mm/hugetlb.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/hugetlb.c). The `set_max_huge_pages()` function handles the reservation logic and will attempt compaction if contiguous memory is not immediately available.

#### PostgreSQL with hugetlbfs

PostgreSQL uses System V shared memory or `mmap` for its shared buffers. Since version 11, it supports huge pages natively.

```bash
# 1. Reserve huge pages (shared_buffers / hugepage size + some overhead)
#    For shared_buffers = 32GB: 32768MB / 2MB = 16384 pages
#    Add ~5% overhead for internal structures
echo 17000 > /proc/sys/vm/nr_hugepages

# 2. Allow the postgres user to use huge pages
#    Option A: sysctl (preferred)
echo "vm.hugetlb_shm_group = $(id -g postgres)" > /etc/sysctl.d/hugepages.conf
sysctl --system

#    Option B: Set memlock limit in /etc/security/limits.conf
#    postgres  soft  memlock  unlimited
#    postgres  hard  memlock  unlimited

# 3. Configure PostgreSQL
# In postgresql.conf:
#   shared_buffers = '32GB'
#   huge_pages = on        # 'on' = require, 'try' = best-effort, 'off' = disable
```

When `huge_pages = on`, PostgreSQL calls `shmget()` with `SHM_HUGETLB` (or uses `mmap` with `MAP_HUGETLB` in newer versions). If the kernel cannot satisfy the request from the hugetlb pool, PostgreSQL refuses to start, which is the correct behavior: you want to know at startup, not discover degraded performance later.

#### Oracle with hugetlbfs

Oracle's SGA (System Global Area) benefits enormously from huge pages. Oracle calls this "HugePages" in its documentation and it has been a best practice since Oracle 11g.

```bash
# 1. Calculate pages needed: SGA target / hugepage size
#    For sga_target = 64GB: 65536MB / 2MB = 32768
echo 33000 > /proc/sys/vm/nr_hugepages

# 2. Set memlock for the oracle user
#    /etc/security/limits.conf:
#    oracle  soft  memlock  unlimited
#    oracle  hard  memlock  unlimited

# 3. Oracle automatically uses huge pages for the SGA if:
#    - USE_LARGE_PAGES = ONLY (init.ora, recommended)
#    - Sufficient huge pages are available
#    - memlock limits are set
```

#### MySQL/InnoDB with hugetlbfs

```bash
# 1. Reserve huge pages for the InnoDB buffer pool
#    For innodb_buffer_pool_size = 48GB: 49152MB / 2MB = 24576
echo 25000 > /proc/sys/vm/nr_hugepages

# 2. Set memlock for the mysql user
#    /etc/security/limits.conf:
#    mysql  soft  memlock  unlimited
#    mysql  hard  memlock  unlimited

# 3. Enable in my.cnf:
#    [mysqld]
#    large-pages

# 4. MySQL must also have CAP_IPC_LOCK capability, or run with sufficient
#    memlock limits. Check:
cat /proc/$(pidof mysqld)/status | grep HugetlbPages
```

## THP: Why Databases Often Disable It

[Transparent Huge Pages](thp.md) sound like they solve the same problem as hugetlbfs, but the "transparent" part is where the trouble starts.

### The Compaction Problem

When THP is enabled, the kernel runs `khugepaged` to collapse 4KB pages into 2MB huge pages. To do this, it must find or create 2MB-aligned contiguous free regions. This triggers [compaction](compaction.md) -- moving pages around in physical memory to defragment it.

Compaction holds zone locks and can stall allocations. For a database handling thousands of queries per second, a compaction stall during a page fault means:

```
Query arrives
    │
    ▼
Buffer pool miss, need new page
    │
    ▼
Page fault → kernel tries 2MB allocation
    │
    ▼
No contiguous 2MB region → trigger compaction
    │
    ▼
Compaction holds zone lock (10-100ms+)
    │
    ▼
Query blocked, holds row locks
    │
    ▼
Other queries waiting on those locks pile up
    │
    ▼
Latency spike visible to application
```

This is documented in many database vendor guides. MongoDB, Redis, and Oracle all recommend disabling THP. PostgreSQL recommends hugetlbfs instead of THP.

The compaction code lives in [mm/compaction.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/compaction.c). The `compact_zone()` function is where stalls occur -- it migrates pages while holding the zone lock, and cannot be interrupted mid-migration.

### Disabling THP

```bash
# Disable immediately (runtime)
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Verify
cat /sys/kernel/mm/transparent_hugepage/enabled
# always madvise [never]

# Make persistent via kernel command line:
# transparent_hugepage=never
```

!!! note "THP madvise mode"
    Setting THP to `madvise` instead of `never` allows applications to opt-in to THP via `madvise(MADV_HUGEPAGE)` while keeping the default behavior as 4KB pages. This can be a reasonable middle ground on systems running mixed workloads, but most database-dedicated servers use `never` for simplicity.

### When THP Might Be Acceptable

THP is not universally bad. Analytical/OLAP databases that perform large sequential scans over column stores may benefit from THP because their access patterns align with huge page boundaries. The issue is specifically with random-access OLTP workloads where compaction latency is unpredictable.

## vm.swappiness

### Why Databases Set This Low

`vm.swappiness` controls how aggressively the kernel reclaims anonymous pages (process memory) versus file-backed pages (page cache). The value ranges from 0 to 200, with the default at 60.

For databases, the shared buffer pool is anonymous memory. The kernel has no way to know that those anonymous pages contain hot B-tree index nodes that are accessed thousands of times per second. With the default swappiness, the kernel may decide to swap out buffer pool pages to make room for page cache entries from sequential file reads.

The swappiness value feeds into the reclaim scanner's cost calculation in [mm/vmscan.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmscan.c). Higher values make the scanner more willing to scan and reclaim anonymous pages; lower values bias toward reclaiming file pages.

```bash
# Set swappiness to 1 (strongly prefer reclaiming file pages)
sysctl -w vm.swappiness=1

# Make persistent
echo "vm.swappiness = 1" >> /etc/sysctl.d/database.conf
```

**Why 1 and not 0?**

Setting `vm.swappiness = 0` tells the kernel to avoid swapping anonymous pages unless the system is under severe memory pressure (free + file pages below the high watermark of a zone). This sounds ideal, but in practice it means the kernel goes directly from "no swap" to "OOM pressure" with no graceful middle ground. A value of 1 provides a minimal but non-zero willingness to swap, giving the kernel a pressure release valve before reaching OOM conditions.

!!! info "Databases that manage their own cache"
    PostgreSQL, MySQL, and Oracle all have their own buffer management with LRU eviction, write-behind, and prefetching. They are better at managing their hot set than the kernel's generic LRU. Keeping `vm.swappiness` low lets the database's own cache management do its job without the kernel second-guessing it.

## vm.dirty_ratio and vm.dirty_background_ratio

### The Write-Ahead Log Pattern

Databases use write-ahead logging (WAL): every data modification is first written sequentially to a log file, then `fsync()`'d. The actual data files are written asynchronously later (checkpointing). This creates two distinct I/O patterns:

```
WAL writes:                         Data file writes:
┌──────────────────┐                ┌──────────────────┐
│ Sequential       │                │ Random           │
│ Small (8KB-64KB) │                │ Large (pages)    │
│ Frequent fsync() │                │ Periodic bursts  │
│ Latency-critical │                │ Throughput-ok     │
└──────────────────┘                └──────────────────┘
```

The kernel's dirty page writeback is controlled by two ratios:

- **`vm.dirty_background_ratio`** (default: 10%) - When dirty pages exceed this percentage of available memory, the kernel starts background writeback via `bdflush`/`pdflush`/`writeback` threads.
- **`vm.dirty_ratio`** (default: 20%) - When dirty pages exceed this, processes performing writes are **blocked** until writeback catches up. This is a synchronous stall.

The writeback logic is in [mm/page-writeback.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page-writeback.c). The `balance_dirty_pages()` function is where processes get throttled when dirty pages exceed the threshold.

### Why the Defaults Hurt Databases

On a 128GB server, 20% means 25GB of dirty pages can accumulate before processes stall. When a checkpoint flushes 25GB of dirty data at once, it creates a thundering herd of I/O that saturates the disk and stalls WAL writes.

```bash
# Lower the ratios for database workloads
sysctl -w vm.dirty_background_ratio=3
sysctl -w vm.dirty_ratio=10

# Or use absolute byte values for more predictable behavior:
sysctl -w vm.dirty_background_bytes=268435456   # 256MB
sysctl -w vm.dirty_bytes=1073741824              # 1GB

# Make persistent
cat >> /etc/sysctl.d/database.conf << 'EOF'
vm.dirty_background_ratio = 3
vm.dirty_ratio = 10
EOF
```

Lowering these values causes the kernel to write back dirty pages more frequently in smaller batches, which:

- Reduces checkpoint I/O spikes
- Keeps WAL write latency more predictable
- Avoids the cliff where processes hit `dirty_ratio` and stall

!!! tip "Byte values vs ratios"
    On large-memory servers (256GB+), even 3% is ~8GB of dirty data. Using `vm.dirty_background_bytes` and `vm.dirty_bytes` gives you absolute control regardless of total RAM. The byte values override the ratio values when both are set.

## NUMA Pinning

### The Problem with Database Shared Buffers on NUMA

On a [NUMA](numa.md) system, the default memory allocation policy is "local allocation" -- memory is allocated on the node where the requesting CPU runs. For a database shared buffer pool, this means:

```
Node 0 (CPUs 0-15)           Node 1 (CPUs 16-31)
┌──────────────────┐          ┌──────────────────┐
│ Local memory     │          │ Local memory     │
│ 80% buffer pool  │          │ 20% buffer pool  │
│ (allocated by    │          │ (allocated by    │
│  startup thread) │          │  some queries)   │
└──────────────────┘          └──────────────────┘
```

If PostgreSQL's postmaster starts on Node 0 and allocates shared buffers there, every backend running on Node 1 pays the cross-node latency penalty for every buffer pool access. Since the buffer pool is the most frequently accessed data structure in a database, this is devastating for throughput.

### numactl --interleave

The fix is to interleave the shared buffer allocation across all NUMA nodes so that, on average, each CPU has equal local/remote access:

```bash
# Start PostgreSQL with interleaved memory allocation
numactl --interleave=all pg_ctl start -D /var/lib/postgresql/data

# For MySQL
numactl --interleave=all mysqld_safe &

# For systemd services, add to the unit file:
# [Service]
# ExecStart=/usr/bin/numactl --interleave=all /usr/bin/postgres -D /var/lib/postgresql/data
```

Interleaving distributes pages round-robin across nodes. No single CPU gets optimal locality, but no CPU gets worst-case remote access for the majority of the buffer pool either. This is the right trade-off for shared data structures accessed by all CPUs.

Linux 6.3 introduced NUMA memory balancing improvements (see [LWN: NUMA balancing gets some tweaks](https://lwn.net/Articles/920920/)) that can automatically migrate pages toward their accessing CPUs. However, for large shared buffers accessed by many CPUs, interleaving remains the recommended approach because automatic balancing cannot satisfy all accessors simultaneously.

### Verifying NUMA Distribution

```bash
# Check per-node memory usage for a process
numastat $(pidof postgres) 2>/dev/null || numastat -p $(pidof postgres)

# Look for roughly equal distribution across nodes:
#                  Node 0      Node 1
# Heap             15360       15680    <-- interleaved: good
# Stack               4           0
# Total            16200       16100

# If you see heavy skew (90%+ on one node), interleaving is not working
```

## vm.overcommit_memory

### Why Strict Overcommit for Databases

As described in [Memory Overcommit](overcommit.md), Linux defaults to heuristic overcommit (mode 0). This is fine for general workloads, but databases have a specific problem: they allocate large shared buffers at startup and expect that memory to be available for the lifetime of the process.

With heuristic overcommit, the kernel may allow more total allocations than physical memory can support. If this happens, the [OOM killer](oom.md) wakes up and picks a victim -- and a database with a 64GB shared buffer pool is an attractive target due to its high RSS.

```bash
# Mode 2: strict accounting
sysctl -w vm.overcommit_memory=2

# Set the ratio to allow enough for the database + OS
# On a 128GB server with 32GB swap:
# CommitLimit = (128GB * overcommit_ratio/100) + 32GB
sysctl -w vm.overcommit_ratio=80
# CommitLimit = (128 * 0.80) + 32 = 134.4GB

# Make persistent
cat >> /etc/sysctl.d/database.conf << 'EOF'
vm.overcommit_memory = 2
vm.overcommit_ratio = 80
EOF
```

The accounting logic is in [mm/util.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/util.c) (`__vm_enough_memory()`). In mode 2, every `mmap()` and `brk()` call checks the commit charge against the commit limit. If the new allocation would exceed the limit, the syscall fails with `ENOMEM`.

**The trade-off:** Mode 2 means `fork()` from a large process can fail because the child's address space counts against the commit limit, even with copy-on-write. PostgreSQL forks a backend for each connection, so `overcommit_ratio` must be high enough to account for the apparent (not actual) memory cost of all those forked backends. Monitor `Committed_AS` in `/proc/meminfo` to verify headroom.

!!! warning "Commit accounting and fork()"
    A PostgreSQL server with 32GB `shared_buffers` and 200 connections may show a `Committed_AS` much larger than actual RAM usage because each forked backend inherits the parent's address space in the commit accounting. Set `overcommit_ratio` conservatively and monitor `Committed_AS` vs `CommitLimit`.

## vm.zone_reclaim_mode

### Why Databases Should Disable Zone Reclaim

On NUMA systems, `vm.zone_reclaim_mode` controls whether the kernel tries to reclaim memory from the local node before falling back to remote nodes. When enabled, the kernel may evict page cache or even swap out pages from the local zone rather than allocate from a remote node.

This is exactly wrong for databases. Database buffer pools are not page cache -- they are anonymous memory that is expensive to reconstruct. Even for page cache, evicting a hot cached WAL segment to satisfy a local allocation is worse than paying the cross-node latency.

```bash
# Disable zone reclaim (default on most modern distros, but verify)
sysctl -w vm.zone_reclaim_mode=0

# Make persistent
echo "vm.zone_reclaim_mode = 0" >> /etc/sysctl.d/database.conf
```

The zone reclaim logic lives in [mm/vmscan.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmscan.c) (`node_reclaim()`). When mode is 0, the allocator skips local reclaim and falls back to remote nodes immediately. When mode is non-zero, it attempts local reclaim first, which can cause latency spikes on NUMA database workloads.

The kernel changed the default from 1 to 0 in commit [4f9b16a6 ("mm: disable zone_reclaim_mode by default")](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=4f9b16a64753d0bb607454347036dc997fd03b82), recognizing that the old behavior caused more harm than good for most workloads. Verify your system has the sane default:

```bash
cat /proc/sys/vm/zone_reclaim_mode
# Should be: 0
```

## Monitoring

### Key /proc/meminfo Fields

```bash
# Essential fields for database workloads
cat /proc/meminfo | grep -E \
  'MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|Dirty|Writeback|AnonPages|Mapped|Shmem|HugePages|Committed_AS|CommitLimit'
```

| Field | What It Tells You | Warning Sign |
|-------|-------------------|--------------|
| `MemAvailable` | How much memory can be allocated without swapping | Dropping below database buffer pool size |
| `SwapFree` | Remaining swap space | Any swap usage on a tuned database server is a red flag |
| `Dirty` | Pages modified but not yet written to disk | Sustained high values mean writeback cannot keep up |
| `Writeback` | Pages currently being written to disk | Sustained non-zero means I/O bottleneck |
| `AnonPages` | Non-file-backed pages (includes buffer pools) | Should be stable once database is warmed up |
| `Shmem` | Shared memory (PostgreSQL shared buffers use this) | Should match your shared_buffers roughly |
| `HugePages_Free` | Unused huge pages | Should drop after database starts, stay stable |
| `Committed_AS` | Total committed address space | Approaching `CommitLimit` means new allocations will fail (mode 2) |

### Key /proc/vmstat Fields

```bash
# Real-time monitoring of reclaim and compaction
watch -n 1 'cat /proc/vmstat | grep -E \
  "pgscan_direct|pgsteal_direct|pgscan_kswapd|pgsteal_kswapd|pswpin|pswpout|compact_stall|compact_fail|thp_fault_alloc|thp_fault_fallback|numa_hit|numa_miss|numa_foreign"'
```

| Counter | What It Tells You | Warning Sign |
|---------|-------------------|--------------|
| `pgscan_direct` | Direct reclaim scanning (process stalled) | Any increase under normal load |
| `pgsteal_direct` | Pages reclaimed by direct reclaim | Process had to wait for memory |
| `pswpin` / `pswpout` | Pages swapped in/out | Any activity on a tuned server |
| `compact_stall` | Processes stalled waiting for compaction | Increasing = THP or hugepage allocation issues |
| `compact_fail` | Failed compaction attempts | High ratio to compact_stall = fragmentation |
| `thp_fault_fallback` | THP allocations that fell back to 4KB | Indicates fragmentation if THP is enabled |
| `numa_hit` / `numa_miss` | Local vs remote NUMA allocations | High `numa_miss` = memory policy misconfiguration |

### A Practical Monitoring Script

```bash
#!/bin/bash
# db-memcheck.sh: Quick health check for database memory configuration

echo "=== Huge Pages ==="
grep -i huge /proc/meminfo

echo ""
echo "=== Swap Activity ==="
grep -E "SwapTotal|SwapFree" /proc/meminfo
echo "Swap I/O: $(grep -E 'pswpin|pswpout' /proc/vmstat)"

echo ""
echo "=== Dirty Pages ==="
grep -E "^Dirty|^Writeback" /proc/meminfo

echo ""
echo "=== Reclaim Pressure ==="
echo "Direct reclaim scans: $(awk '/pgscan_direct/ {sum+=$2} END {print sum}' /proc/vmstat)"
echo "Compaction stalls:    $(grep compact_stall /proc/vmstat | awk '{print $2}')"

echo ""
echo "=== NUMA Balance ==="
grep -E "numa_hit|numa_miss" /proc/vmstat

echo ""
echo "=== Commit Status ==="
grep -E "Committed_AS|CommitLimit" /proc/meminfo

echo ""
echo "=== THP Status ==="
echo "Enabled: $(cat /sys/kernel/mm/transparent_hugepage/enabled)"
echo "Defrag:  $(cat /sys/kernel/mm/transparent_hugepage/defrag)"
```

## Practical Examples

### PostgreSQL

A complete sysctl and configuration for a 128GB server dedicated to PostgreSQL:

```bash
# /etc/sysctl.d/postgresql.conf

# Huge pages: reserve for 32GB shared_buffers + overhead
vm.nr_hugepages = 17000

# Swap: strongly prefer keeping anonymous pages in RAM
vm.swappiness = 1

# Dirty pages: frequent small flushes instead of large bursts
vm.dirty_background_ratio = 3
vm.dirty_ratio = 10

# NUMA: disable zone reclaim
vm.zone_reclaim_mode = 0

# Overcommit: strict accounting
vm.overcommit_memory = 2
vm.overcommit_ratio = 80
```

```ini
# postgresql.conf
shared_buffers = '32GB'
huge_pages = on
effective_cache_size = '80GB'    # Tells planner about OS cache, not an allocation
wal_buffers = '64MB'
```

```bash
# systemd override: /etc/systemd/system/postgresql.service.d/numa.conf
[Service]
ExecStart=
ExecStart=/usr/bin/numactl --interleave=all /usr/bin/postgres -D /var/lib/postgresql/data
LimitMEMLOCK=infinity
```

```bash
# Disable THP
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Or via kernel command line (persistent):
# transparent_hugepage=never
```

### MySQL / MariaDB

A complete configuration for a 64GB server dedicated to MySQL:

```bash
# /etc/sysctl.d/mysql.conf

# Huge pages for 40GB InnoDB buffer pool
vm.nr_hugepages = 21000

vm.swappiness = 1
vm.dirty_background_ratio = 3
vm.dirty_ratio = 10
vm.zone_reclaim_mode = 0
vm.overcommit_memory = 2
vm.overcommit_ratio = 85
```

```ini
# /etc/my.cnf.d/server.cnf
[mysqld]
innodb_buffer_pool_size = 40G
innodb_buffer_pool_instances = 8    # Reduce mutex contention
large-pages                         # Enable huge pages

# InnoDB manages its own flushing; these complement the sysctl settings:
innodb_flush_method = O_DIRECT      # Bypass page cache for data files
innodb_io_capacity = 2000           # Match your storage IOPS
innodb_io_capacity_max = 4000
```

Using `O_DIRECT` for InnoDB is important: it tells the kernel to bypass the page cache for data file I/O, since InnoDB maintains its own buffer pool. This avoids double-caching and reduces memory pressure. The interaction between `O_DIRECT` and the page cache is implemented in [mm/filemap.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/filemap.c).

```bash
# Start with NUMA interleaving
numactl --interleave=all mysqld_safe &

# Disable THP
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
```

### Redis

Redis is single-threaded (per shard) and keeps its entire dataset in anonymous memory. Its tuning needs are different from disk-based databases but the memory management concerns overlap.

```bash
# /etc/sysctl.d/redis.conf

# Redis does not use huge pages for its main data structures
# (it uses jemalloc with small allocations), but if you use
# large Redis instances, huge pages can still help.
# vm.nr_hugepages = ...  # Usually not needed for Redis

# Critical: Redis forks for BGSAVE/BGREWRITEAOF
# Overcommit must allow fork() to succeed
vm.overcommit_memory = 1    # Redis recommends mode 1, not mode 2!

vm.swappiness = 1
vm.zone_reclaim_mode = 0

# Lower dirty ratios help BGSAVE complete faster
vm.dirty_background_ratio = 3
vm.dirty_ratio = 10
```

!!! warning "Redis and overcommit mode 2"
    Unlike PostgreSQL and MySQL, Redis recommends `vm.overcommit_memory = 1` (always overcommit). This is because Redis uses `fork()` for background persistence (BGSAVE, BGREWRITEAOF). A Redis instance using 50GB of RAM needs to fork, creating a child with a 50GB address space. With mode 2, this fork will fail unless `CommitLimit` has 50GB of headroom, which defeats the purpose of strict accounting. Mode 1 allows the fork to succeed, relying on copy-on-write to avoid actually needing 100GB.

```bash
# Disable THP: Redis strongly recommends this
# Redis will log a warning at startup if THP is enabled
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
```

## Try It Yourself

### Check Your Current Settings

```bash
# Display all relevant sysctl values at once
echo "=== Current Database Memory Tunables ==="
sysctl vm.swappiness vm.dirty_ratio vm.dirty_background_ratio \
       vm.overcommit_memory vm.overcommit_ratio vm.zone_reclaim_mode \
       vm.nr_hugepages
echo ""
echo "THP enabled: $(cat /sys/kernel/mm/transparent_hugepage/enabled)"
```

### Observe Swap Behavior Under Memory Pressure

```bash
# Terminal 1: Monitor swap activity
watch -n 1 'grep -E "SwapTotal|SwapFree|SwapCached" /proc/meminfo; echo "---"; grep -E "pswpin|pswpout" /proc/vmstat'

# Terminal 2: Create memory pressure (adjust size for your system)
stress-ng --vm 2 --vm-bytes 80% --timeout 30s

# Compare behavior with vm.swappiness=60 vs vm.swappiness=1
```

### Measure NUMA Effects

```bash
# Allocate memory on a specific node vs interleaved
# and measure access latency with numactl:
numactl --membind=0 -- stress-ng --vm 1 --vm-bytes 1G --timeout 10s --metrics
numactl --interleave=all -- stress-ng --vm 1 --vm-bytes 1G --timeout 10s --metrics

# Check where a running process has its memory:
numastat -p $(pidof postgres)
```

### Watch Dirty Page Writeback

```bash
# Terminal 1: Watch dirty page count
watch -n 0.5 'grep -E "^Dirty|^Writeback" /proc/meminfo'

# Terminal 2: Generate writes
dd if=/dev/zero of=/tmp/testfile bs=1M count=2048 conv=fdatasync

# Observe how dirty pages accumulate up to dirty_background_ratio
# then writeback kicks in, and how they are capped at dirty_ratio
```

## Further Reading

- [docs.kernel.org: vm.overcommit_memory](https://docs.kernel.org/admin-guide/sysctl/vm.html#overcommit-memory) - Kernel documentation for all vm sysctl tunables
- [docs.kernel.org: hugetlbpage](https://docs.kernel.org/admin-guide/mm/hugetlbpage.html) - Kernel documentation for huge page configuration
- [LWN: NUMA in a hurry](https://lwn.net/Articles/473440/) - Overview of NUMA memory management in Linux
- [LWN: Transparent huge pages](https://lwn.net/Articles/423584/) - Original THP design and trade-offs
- [LWN: Better active/inactive list balancing](https://lwn.net/Articles/495543/) - How the kernel decides what to reclaim
- [mm/vmscan.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmscan.c) - Reclaim, swappiness, and zone reclaim logic
- [mm/page-writeback.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page-writeback.c) - Dirty page writeback and throttling
- [mm/hugetlb.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/hugetlb.c) - Huge page reservation and allocation
