# Buffered I/O vs Direct I/O

> When does bypassing the page cache help, and when does it hurt?

## The choice

Every read and write on Linux takes one of two paths to storage:

**Buffered I/O** (the default): data passes through the page cache. Reads check the cache first; writes go to the cache and are flushed to disk asynchronously by writeback threads.

**Direct I/O** (`O_DIRECT`): data bypasses the page cache entirely. Reads come from storage directly into userspace buffers; writes go from userspace buffers directly to storage.

```
Buffered I/O path:
application → write() → page cache → [background] → storage
application → read() → page cache → (cache miss) → storage → page cache → application

Direct I/O path:
application → write() → DMA → storage
application → read() → DMA → storage → application buffer
```

The choice between them is one of the most impactful I/O decisions in systems programming. The wrong choice for a workload can waste RAM, add overhead, or cause correctness problems.

---

## What the page cache does

The page cache is an in-kernel cache of recently accessed file data. It serves four purposes:

1. **Read caching**: a file read that hits the cache avoids a storage access entirely (microseconds vs milliseconds).
2. **Write buffering**: writes return immediately to the application; storage writeback happens asynchronously.
3. **Read-ahead**: the kernel speculatively prefetches pages ahead of the current read position for sequential access patterns.
4. **Sharing**: multiple processes reading the same file share the same cached pages (no duplicate copies per process).

```
Page cache as a shared read cache:

Process A        Process B        Process C
read("foo.dat")  read("foo.dat")  read("foo.dat")
     |                |                |
     └────────────────┴────────────────┘
                      |
              [single copy in page cache]
                      |
                  storage
```

These four properties make the page cache valuable for many workloads — and irrelevant or harmful for others.

---

## When buffered I/O wins

### Repeated reads of the same data

The page cache amortizes the cost of storage access across many reads. If a file is read by multiple processes, or the same file region is read repeatedly, the cache delivers the data without touching storage.

```
Cache hit: application → page cache → return in ~1µs
Cache miss: application → page cache → storage → page cache → return in ~100µs
                                                                (NVMe) or ~10ms (SSD)

10× repeated reads: cache saves 9 storage accesses
100× repeated reads: cache saves 99 storage accesses
```

### Write bursts that exceed device throughput

Buffered writes return immediately to the application. The page cache absorbs a write burst even if the storage device cannot keep up with the burst rate. The writeback subsystem smooths the burst into sustained writes at the device's capacity.

```
Application write rate: 2 GB/s (in-memory speed)
Device write rate: 500 MB/s

Buffered I/O: application writes at 2GB/s to page cache → writeback at 500MB/s
Direct I/O: application blocks until device absorbs each write at 500MB/s
```

For workloads that produce data in bursts (log writers, event streams, checkpoints), buffered writes reduce write() latency and improve application throughput.

### Sequential reads with readahead

The kernel's readahead algorithm detects sequential access patterns and prefetches ahead of the current position. For a process reading a large file sequentially, readahead keeps the device busy and data ready before it is requested, hiding storage latency.

```bash
# Check readahead effectiveness
grep -E '(pgpgin|pgpgout)' /proc/vmstat  # page-in rate
cat /sys/block/sda/queue/read_ahead_kb   # current readahead window
```

Buffered sequential reads can achieve device-saturating throughput without the application explicitly managing parallelism, because readahead handles it.

### Small files, many files

Opening and reading many small files is more efficient with buffered I/O. Small files may fit entirely in the page cache after the first access. Subsequent accesses (e.g., re-reading a config file on every request) are served from memory.

With O_DIRECT, every read goes to storage regardless of cache state.

---

## When direct I/O wins

### Application has its own cache

Databases (PostgreSQL shared buffers, MySQL InnoDB buffer pool, Oracle SGA) maintain their own application-level caches that are smarter than the page cache for their access patterns. They know which pages are hot, manage eviction explicitly, and can pre-warm caches on startup.

For these applications, the page cache is a second copy of the same data:

```
Without O_DIRECT (wasteful):
┌─────────────┐    ┌─────────────┐    ┌──────────┐
│  App cache  │ ←→ │ Page cache  │ ←→ │ Storage  │
│  (64 GB)    │    │  (64 GB)    │    │          │
└─────────────┘    └─────────────┘    └──────────┘
  Two copies of the same 64GB of database pages

With O_DIRECT:
┌─────────────┐                       ┌──────────┐
│  App cache  │ ←────────────────────→│ Storage  │
│  (64 GB)    │                        │          │
└─────────────┘                        └──────────┘
  One copy; the other 64GB of RAM is available for other uses
```

O_DIRECT allows the application to manage caching with full knowledge of access patterns, without wasting RAM on a kernel cache for the same data.

### Streaming single-pass reads

A backup process, video transcoder, or ETL pipeline that reads data once and never revisits it gets no benefit from caching — but it does cause harm by evicting other processes' working sets from the page cache.

```bash
# Without O_DIRECT: 100GB backup fills page cache, evicts working sets
# Page cache before backup: [database pages] [web server pages] [config files]
# Page cache during backup: [backup data] [backup data] [backup data]
# Page cache after backup:  [backup data] [backup data] [backup data]  ← everything else evicted!

# With O_DIRECT: backup reads go directly to disk, page cache unchanged
# Page cache after backup: [database pages] [web server pages] [config files]  ← preserved
```

`POSIX_FADV_DONTNEED` provides a middle ground: use buffered I/O (and get readahead benefits), but advise the kernel to drop the pages after they have been processed.

### Predictable write latency requirements

Buffered writes return immediately but the actual storage write happens at an unknown time in the future. If an application needs to know when data is on storage (for crash safety or durability guarantees), it must call `fsync()` — which blocks until all dirty pages are flushed.

O_DIRECT with `O_SYNC` (or with an explicit `fdatasync()` after each write) provides synchronous writes: the write() call doesn't return until the data is on storage. This gives deterministic write latency.

```c
/* Synchronous write with known durability guarantee */
int fd = open(path, O_WRONLY | O_DIRECT | O_SYNC);
ssize_t n = write(fd, buf, len);
/* At this point, data is durably on storage */

/* Buffered write with unknown durability */
int fd = open(path, O_WRONLY);
write(fd, buf, len);
/* Data is in page cache. May be on storage in 0ms to 30s, depending on writeback. */
fdatasync(fd);  /* Now it's on storage. But this was a second call. */
```

---

## Constraints of direct I/O

O_DIRECT has requirements that buffered I/O does not:

**Alignment**: buffer address, file offset, and transfer length must all be aligned to the device's logical block size (typically 512 or 4096 bytes).

```c
/* O_DIRECT alignment requirement */
void *buf;
posix_memalign(&buf, 4096, IO_SIZE);  /* 4096-byte aligned buffer */

/* File offset must also be aligned */
lseek(fd, 4096 * page_number, SEEK_SET);  /* aligned offset */

/* Transfer size must be aligned */
read(fd, buf, 4096 * n_pages);  /* aligned size */
```

If any of these requirements is violated, `read()` or `write()` returns `EINVAL`.

**No readahead**: O_DIRECT reads are synchronous and do not trigger readahead. Each read fetches exactly the requested bytes from storage.

**No write buffering**: O_DIRECT writes are synchronous by default. Write throughput is limited by device throughput, not by RAM.

**Mixed-mode coherency**: mixing O_DIRECT and buffered I/O on the same file can produce stale reads. See [War Stories: Data Loss](war-stories-data-loss.md#incident-2).

---

## Quantitative comparison

| Scenario | Buffered I/O | Direct I/O |
|---|---|---|
| Cold read of 1MB file | ~100µs (NVMe) | ~100µs (NVMe) |
| Warm read of 1MB file (cached) | ~20µs | ~100µs (always goes to device) |
| Sequential 10GB read | Device-speed after warm-up | Device-speed (no readahead benefit) |
| Write 1MB, return latency | ~1µs (write to cache) | ~100µs (wait for device) |
| Write 1MB, durability latency | ~100µs (after fsync) | ~100µs (synchronous) |
| 64GB database, 64GB RAM | Cache doubles memory usage | Full 64GB usable for DB buffer |
| Single-pass backup of 100GB | Pollutes 100GB of page cache | No cache effect |

---

## Decision guide

```
Does the application manage its own cache? (database, key-value store)
    YES → O_DIRECT
    NO  → continue

Is the data accessed more than once?
    NO  → O_DIRECT or POSIX_FADV_DONTNEED
    YES → Buffered (cache amortizes storage cost)

Is the access pattern sequential?
    YES → Buffered (readahead helps significantly)
    NO  → Both are similar; O_DIRECT avoids cache pollution

Is write latency predictable important?
    YES → O_DIRECT | O_SYNC, or O_DIRECT + explicit fdatasync
    NO  → Buffered (lower write latency for the application)

Is there a risk of mixing O_DIRECT and buffered I/O on the same file?
    YES → Commit to one mode; do not mix
```

---

## Using `posix_fadvise` as a middle ground

For workloads that benefit from some page cache features (readahead) but not others (long-term caching), `posix_fadvise` allows fine-grained control without `O_DIRECT` alignment requirements:

```c
/* Sequential scan: enable aggressive readahead */
posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL);

/* Random access: disable readahead for this file */
posix_fadvise(fd, 0, 0, POSIX_FADV_RANDOM);

/* Pre-fault pages into cache before they're needed */
posix_fadvise(fd, offset, length, POSIX_FADV_WILLNEED);

/* Release cache after use (streaming single-pass) */
posix_fadvise(fd, processed_offset, processed_length, POSIX_FADV_DONTNEED);
```

`POSIX_FADV_DONTNEED` is particularly useful for streaming workloads: use buffered I/O to get readahead, but release pages after they have been processed to prevent cache pollution.

---

## Related pages

- [Buffered I/O and the Page Cache](buffered-io.md) — page cache internals
- [Direct I/O](direct-io.md) — O_DIRECT kernel path
- [Readahead](readahead.md) — readahead algorithm
- [Tuning I/O for Databases](tuning-databases.md) — when to use O_DIRECT in practice
- [Tuning I/O for Streaming Workloads](tuning-streaming.md) — single-pass read strategies
- [War Stories: Data Loss](war-stories-data-loss.md) — O_DIRECT + buffered I/O coherency issue
