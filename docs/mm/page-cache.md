# Page Cache

> Caching file data in memory

## What Is the Page Cache?

The page cache keeps recently accessed file data in RAM. When you read a file, the data stays in memory - subsequent reads come from RAM instead of disk.

```
First read:
Application ──► Kernel ──► Storage (slow: ~10ms HDD, ~100μs NVMe)
                  │
                  ▼
             Page Cache (stores copy)

Second read:
Application ──► Kernel ──► Page Cache (fast, ~100ns)
                           (storage not touched)
```

## Why Page Cache?

### The Speed Gap

| Storage | Latency | Bandwidth |
|---------|---------|-----------|
| RAM | ~100ns | ~100 GB/s |
| NVMe SSD | ~100µs | ~7 GB/s |
| SATA SSD | ~100µs | ~600 MB/s |
| HDD | ~10ms | ~200 MB/s |

RAM is 1000-100,000x faster than storage. Caching exploits temporal locality - recently accessed data is likely to be accessed again.

### Benefits

- **Read performance**: Hot data served from RAM
- **Write buffering**: Writes batched, not synchronous
- **Shared data**: Multiple processes share cached pages
- **Memory efficiency**: Unused RAM becomes cache

## How It Works

### Reading Files

```
read(fd, buf, 4096)
        │
        v
Find page in cache? ─── Yes ──► Copy to user buffer
        │
        No
        │
        v
Allocate page
        │
        v
Read from disk into page
        │
        v
Add to page cache
        │
        v
Copy to user buffer
```

### Writing Files

```
write(fd, buf, 4096)
        │
        v
Find/allocate page in cache
        │
        v
Copy from user buffer to page
        │
        v
Mark page dirty
        │
        v
Return to application (write "complete")
        │
        ▼ (later, asynchronously)
Writeback thread flushes to disk
```

Writes return immediately - data is in cache, marked dirty. Background writeback handles actual disk I/O.

### The address_space Structure

Each file (inode) has an `address_space` managing its cached pages:

```c
struct address_space {
    struct inode *host;           /* Owning inode */
    struct xarray i_pages;        /* Cached pages */
    unsigned long nrpages;        /* Number of cached pages */
    const struct address_space_operations *a_ops;  /* Operations */
    /* ... */
};
```

Pages are indexed by file offset in the XArray, enabling fast lookup.

## Dirty Pages and Writeback

### Dirty Page Lifecycle

```
Clean page ──► write() ──► Dirty page ──► writeback ──► Clean page
                               │
                               ▼
                     Tracked in dirty lists
```

### Writeback Triggers

| Trigger | When |
|---------|------|
| Periodic | Every `dirty_writeback_centisecs` (default: 5s) |
| Memory pressure | Reclaim needs to free pages |
| sync/fsync | Explicit flush request |
| Dirty threshold | Too many dirty pages system-wide |
| Dirty age | Page dirty longer than `dirty_expire_centisecs` |

### Dirty Page Limits

```bash
# Percentage of memory that can be dirty
cat /proc/sys/vm/dirty_ratio
# 20 (default) - start blocking writers at 20%

# Background writeback threshold
cat /proc/sys/vm/dirty_background_ratio
# 10 (default) - start background writeback at 10%

# Time-based settings (centiseconds)
cat /proc/sys/vm/dirty_expire_centisecs
# 3000 (30s) - pages older than this get written

cat /proc/sys/vm/dirty_writeback_centisecs
# 500 (5s) - writeback thread wakes this often
```

### Writeback Threads

```bash
# Per-device writeback threads
ps aux | grep writeback
# kworker/u8:0+flush-8:0   (for device 8:0)
```

## Reading Strategies

### Readahead

The kernel predicts sequential access and reads ahead:

```
Application reads page 0
        │
        v
Kernel detects sequential pattern
        │
        v
Prefetch pages 1, 2, 3, 4... into cache
        │
        v
When application reads page 1, it's already cached
```

```bash
# Default readahead (KB)
cat /sys/block/sda/queue/read_ahead_kb
# 128 (default)

# Adjust for workload
echo 256 > /sys/block/sda/queue/read_ahead_kb
```

### mmap vs read()

| Method | Mechanism | Best For |
|--------|-----------|----------|
| `read()` | Copy from cache to user buffer | Sequential, simple |
| `mmap()` | Map cache pages into process address space | Random access, large files |

With `mmap()`, page cache pages can be directly mapped into the process address space:

```c
void *ptr = mmap(NULL, size, PROT_READ, MAP_SHARED, fd, 0);
/* ptr directly references page cache pages - true zero-copy */

/* With MAP_PRIVATE, writes trigger COW (copy-on-write) */
void *ptr = mmap(NULL, size, PROT_READ|PROT_WRITE, MAP_PRIVATE, fd, 0);
/* Reads are zero-copy, but writes get a private copy */
```

## Memory Pressure

### Page Cache as "Free" Memory

Linux uses "free" RAM for page cache. When applications need memory:

1. Clean cache pages are dropped immediately
2. Dirty cache pages are written out, then dropped
3. Application gets the memory

```bash
# View memory breakdown
cat /proc/meminfo | grep -E "MemFree|Cached|Buffers|Available"
# MemFree:     1234567 kB   (truly free)
# Cached:      8765432 kB   (page cache)
# MemAvailable: 9876543 kB  (free + reclaimable cache)
```

### Drop Caches (Testing Only)

```bash
# Drop clean caches (for benchmarking)
sync  # Write dirty pages first
echo 3 > /proc/sys/vm/drop_caches
# 1 = page cache
# 2 = dentries/inodes
# 3 = both
```

## Monitoring

### System-Wide Cache Statistics

```bash
# Disk I/O counters (not direct cache hit/miss - includes readahead, direct I/O)
cat /proc/vmstat | grep -E "pgpgin|pgpgout"
# pgpgin   - Pages read from disk (KB)
# pgpgout  - Pages written to disk (KB)

# Page cache size and state
cat /proc/meminfo | grep -E "Cached|Buffers|Dirty|Writeback"
# Cached:      Page cache size (file-backed pages in memory)
# Buffers:     Block device metadata cache
# Dirty:       Pages modified, waiting to be written
# Writeback:   Pages currently being written to disk
```

Note: Linux doesn't expose a direct "cache hit ratio" counter. High pgpgin with low Cached growth suggests cache pressure.

### Per-File Cache Status

```bash
# Check if file is cached (using vmtouch or fincore)
vmtouch -v /path/to/file
# Files: 1
# Pages: 1000 (cached: 800)

# Or with fincore (coreutils)
fincore /path/to/file
```

### Tracing

```bash
# Trace page cache events
echo 1 > /sys/kernel/debug/tracing/events/filemap/mm_filemap_add_to_page_cache/enable
echo 1 > /sys/kernel/debug/tracing/events/writeback/writeback_dirty_page/enable
cat /sys/kernel/debug/tracing/trace_pipe
```

## Evolution

### Origins (1990s)

Page cache has existed since early Linux. Originally separate from the "buffer cache" (for block devices).

### Unified Page Cache (v2.4, 2001)

Buffer cache merged into page cache. All file I/O goes through one cache.

### Radix Tree (v2.6)

Pages indexed in radix tree for fast lookup by file offset.

### XArray (v4.20, 2018)

**Commit**: [a28334862993](https://git.kernel.org/linus/a28334862993) ("page cache: Finish XArray conversion")

Radix tree replaced with XArray - cleaner API, same performance.

### Folios (v5.16, 2022)

**Commit**: [7b230db3b8d3](https://git.kernel.org/linus/7b230db3b8d3) ("mm: Introduce struct folio")

**Author**: Matthew Wilcox

Folios represent one or more contiguous pages as a single unit. This abstraction reduces overhead for huge pages in the page cache and eliminates confusion about whether a function operates on a head page or any page.

## Direct I/O (Bypassing Cache)

Some applications bypass page cache entirely:

```c
int fd = open("file", O_RDWR | O_DIRECT);
/* Reads/writes bypass page cache */
/* Requires aligned buffers and sizes */
```

**Use cases**:
- Databases with their own caching
- Avoiding double-caching
- Predictable latency

**Trade-offs**:
- No readahead benefits
- No write buffering
- Application must handle caching

## Common Issues

### Cache Thrashing

Working set larger than available RAM.

**Symptoms**: High `pgpgin`/`pgpgout`, slow I/O

**Solutions**:
- Add RAM
- Reduce working set
- Use O_DIRECT for some workloads

### Dirty Page Buildup

Too many dirty pages causing write stalls.

**Symptoms**: Processes blocked in `balance_dirty_pages`

**Solutions**:
- Lower `dirty_ratio`
- Faster storage
- Reduce write rate

### Readahead Mismatch

Sequential readahead hurts random workloads.

**Solutions**:
- Use `posix_fadvise(POSIX_FADV_RANDOM)`
- Reduce `read_ahead_kb`
- Use `madvise(MADV_RANDOM)` for mmap

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/filemap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/filemap.c) | Page cache core |
| [`mm/readahead.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/readahead.c) | Readahead logic |
| [`mm/page-writeback.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page-writeback.c) | Dirty page handling |

### Related

- [reclaim](reclaim.md) - How cache pages are reclaimed
- [mmap](mmap.md) - Memory-mapped file I/O
- [swap](swap.md) - When anonymous pages go to disk
