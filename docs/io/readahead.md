# Readahead

> Prefetching pages into the page cache before a process requests them

## What is readahead?

When a process reads a file sequentially, each `read()` that misses the page cache incurs a block I/O wait. Readahead eliminates this latency by predicting which pages will be needed soon and issuing I/O for them **before** the process requests them — ideally so the pages are already warm in the page cache by the time the process gets there.

The kernel implements readahead entirely inside the page cache layer (`mm/readahead.c`). It is transparent to applications: a sequential `read()` just happens to return faster because the data was already fetched.

Key properties:

- Only applies to **buffered I/O**. `O_DIRECT` bypasses the page cache and therefore bypasses readahead entirely.
- The kernel tracks a **readahead window** — a contiguous range of pages to prefetch — per open file description.
- The window grows on confirmed sequential access and shrinks (or is disabled) when random access is detected.

## `struct file_ra_state`

Every `struct file` carries a `file_ra_state` that records the readahead window for that open file description.

```c
/* include/linux/fs.h */
struct file_ra_state {
    pgoff_t start;          /* where the current window begins (page index) */
    unsigned int size;      /* number of pages in the current window */
    unsigned int async_size;/* pages left in window before async prefetch fires */
    unsigned int ra_pages;  /* max readahead in pages (0 = disabled) */
    unsigned int mmap_miss; /* cache miss stat for mmap accesses */
    loff_t prev_pos;        /* position of last read, for sequential detection */
};
```

| Field | Meaning |
|-------|---------|
| `start` | Page index of the first page in the current readahead window |
| `size` | Total pages in the current window (`start` .. `start + size - 1`) |
| `async_size` | When the process reaches `start + size - async_size`, an async prefetch is triggered for the *next* window |
| `ra_pages` | Upper bound on window size; `0` disables readahead |
| `mmap_miss` | Counts page-fault misses on mmap'd regions to detect sequential mmap access |
| `prev_pos` | Byte offset of the previous read, used to detect whether the current read is sequential |

`ra_pages` is initialised from the backing device's `queue/read_ahead_kb` setting (divided by page size). `POSIX_FADV_SEQUENTIAL` doubles it; `POSIX_FADV_RANDOM` sets it to zero.

## Synchronous readahead

Synchronous readahead happens **on the critical path** of `read()`. When the VFS services a `read()` call, it calls into the readahead machinery before (or while) reading the requested page. The result: I/O for pages beyond the requested one is submitted before the process blocks waiting for the requested page.

### Call path

```
read()
  → vfs_read()
    → generic_file_read_iter()
      → filemap_read()
        → page_cache_sync_ra()   ← first read or after a miss
          → ondemand_readahead()
            → do_page_cache_ra()
              → page_cache_ra_unbounded()
```

### `page_cache_ra_unbounded()`

`page_cache_ra_unbounded()` is the low-level workhorse. It:

1. Iterates over pages in the window `[ractl->_index, ractl->_index + nr_to_read)`.
2. For each page not already in cache, allocates a page and marks it `PG_locked`.
3. Submits a single merged `readahead` bio covering the range.
4. Marks exactly one page — the first page of the lookahead zone, at index `start + size - async_size` — with `PG_readahead`. This single page acts as the trigger: when `filemap_read` encounters it already uptodate, async readahead fires for the next window.

```c
/* mm/readahead.c */
void page_cache_ra_unbounded(struct readahead_control *ractl,
                             unsigned long nr_to_read,
                             unsigned long lookahead_size)
{
    struct address_space *mapping = ractl->mapping;
    unsigned long index = readahead_index(ractl);

    /*
     * Allocate pages, add to page cache, then submit I/O.
     * 'lookahead_size' pages at the end get PG_readahead set
     * so async readahead fires when the process reaches them.
     */
    for (i = 0; i < nr_to_read; i++) {
        struct folio *folio = xa_load(&mapping->i_pages, index + i);
        if (folio)
            continue;           /* already cached */
        folio = filemap_alloc_folio(gfp, 0);
        filemap_add_folio(mapping, folio, index + i, gfp);
        ractl->_nr_pages++;
    }
    read_pages(ractl);          /* submit bio(s) */
}
```

### `ondemand_readahead()`

`ondemand_readahead()` is a `static` internal function (not a public API) that sits above `do_page_cache_ra()` and decides **how many pages** to read. It implements the window-growth heuristic and sequential-detection logic described in the next section.

> **Note:** In Linux 6.6+, `ondemand_readahead()` was renamed to `page_cache_ra_order()` as part of the large-folio readahead refactor.

## Async readahead

Async readahead prefetches the **next** window in the background while the process is still consuming the current one, so there is no stall at the window boundary.

### The readahead marker page

When `page_cache_ra_unbounded()` submits a window, it sets the `PG_readahead` flag on exactly one page — the first page of the lookahead zone, at index `start + size - async_size`. When `filemap_read()` encounters this page already uptodate, it calls `page_cache_async_ra()` — which calls `ondemand_readahead()` again for the next window — without waiting for the current read to finish.

```
Window N already in cache (or being read):
┌────────────────────────────────────────────┐
│ page page page page page [RA] page page    │
└────────────────────────────────────────────┘
                               ↑
               process reaches here (first page of lookahead zone,
               index start+size-async_size) → triggers window N+1 fetch
               (async, does not block the read())
```

This means: by the time the process reads the last page of window N, window N+1 is already in flight (or done). With an appropriate `async_size`, the process never stalls.

```c
/* mm/readahead.c — called when PG_readahead page is hit */
void page_cache_async_ra(struct readahead_control *ractl,
                         struct folio *folio,
                         unsigned long req_count)
{
    /* Don't start async readahead if the folio is not yet uptodate
     * or if the readahead flag is no longer set. */
    if (!folio_test_readahead(folio))
        return;
    ondemand_readahead(ractl, folio, req_count);
}
```

## Adaptive readahead

The kernel does not use a fixed window size. `ondemand_readahead()` grows and shrinks `ra->size` based on observed access patterns.

### Sequential detection

A read is considered sequential if:

- The current read offset equals `ra->start + ra->size` (continues exactly where the last window ended), **or**
- `prev_pos` is within one page of the current offset (the process stepped forward by one read).

If neither condition holds, the access is treated as **random** and the window is reset to a small initial size (typically 2 pages) rather than zero — so the kernel probes whether sequential access might resume.

### Window growth

On each sequential confirmation, the window roughly doubles until it hits `ra->ra_pages`:

```c
/* Simplified from ondemand_readahead() in mm/readahead.c */
if (sequential) {
    ra->size = min(ra->size * 2, ra->ra_pages);
} else {
    /* Random-looking access: reset to initial probe size */
    ra->size  = get_init_ra_size(ra->ra_pages, ra->ra_pages);
    ra->start = offset;
}
ra->async_size = ra->size / 2;   /* fire async prefetch halfway through */
```

`async_size` is set to roughly half the window so the async prefetch fires early enough that I/O completes before the process reaches the end of the window.

### State machine summary

```
First read on file
  → small initial window (2–4 pages)
  → submit sync readahead

Each subsequent sequential read
  → window doubles (capped at ra_pages)
  → submit async readahead when marker page hit

Random read detected
  → window reset to initial size
  → no async prefetch until sequential pattern re-established

POSIX_FADV_RANDOM or ra_pages == 0
  → readahead fully disabled
```

## `posix_fadvise()` hints

`posix_fadvise()` lets an application tell the kernel about its intended access pattern, adjusting the readahead behaviour without changing the read API.

```c
#include <fcntl.h>

int posix_fadvise(int fd, off_t offset, off_t len, int advice);
```

| Advice | Effect on readahead |
|--------|---------------------|
| `POSIX_FADV_NORMAL` | Restore default `ra_pages` |
| `POSIX_FADV_SEQUENTIAL` | Double `ra_pages` relative to the BDI default — calling it twice does not quadruple |
| `POSIX_FADV_RANDOM` | Set `ra_pages = 0` — disable readahead entirely |
| `POSIX_FADV_WILLNEED` | Trigger immediate synchronous readahead for `[offset, offset+len)` |
| `POSIX_FADV_DONTNEED` | Drop pages in range from the page cache |
| `POSIX_FADV_NOREUSE` | Hint that pages will not be reused (advisory, limited kernel support) |

### `POSIX_FADV_SEQUENTIAL`

Doubles `ra->ra_pages` relative to the BDI default — calling it twice does not quadruple the window. Useful for applications that stream a file from start to finish and want larger prefetch windows to hide I/O latency.

### `POSIX_FADV_RANDOM`

Sets `ra->ra_pages = 0`. The kernel skips all readahead logic for this file descriptor. Every page fault or `read()` that misses the cache will fetch exactly the requested page(s) — no more. Appropriate for databases doing their own I/O scheduling or workloads with truly random access patterns where prefetched pages would be evicted before use.

### `POSIX_FADV_WILLNEED`

Schedules immediate readahead for the specified range regardless of the current access pattern. The call returns before the I/O completes (it is non-blocking). Useful for:

- Preloading a file before starting a sequential scan
- Warming the cache during an idle period before a latency-sensitive operation

### `POSIX_FADV_DONTNEED`

Drops clean pages in the range from the page cache. Useful for streaming applications that read a file once and want to avoid polluting the cache (similar to `O_DIRECT` but without the alignment restrictions).

### C example

```c
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(void)
{
    int fd = open("large_file.dat", O_RDONLY);
    if (fd < 0) { perror("open"); return 1; }

    off_t file_size = lseek(fd, 0, SEEK_END);

    /*
     * Tell the kernel we will read sequentially.
     * This doubles ra_pages, so the prefetch window grows faster.
     */
    posix_fadvise(fd, 0, file_size, POSIX_FADV_SEQUENTIAL);

    /*
     * Optionally: warm the first 64 MiB into cache now,
     * before the processing loop starts.
     */
    posix_fadvise(fd, 0, 64 * 1024 * 1024, POSIX_FADV_WILLNEED);

    char *buf = malloc(1024 * 1024);
    ssize_t n;
    lseek(fd, 0, SEEK_SET);
    while ((n = read(fd, buf, 1024 * 1024)) > 0) {
        /* process buf[0..n-1] */

        /*
         * Drop already-processed pages from cache to avoid
         * evicting more useful data.
         */
        off_t pos = lseek(fd, 0, SEEK_CUR);
        posix_fadvise(fd, pos - n, n, POSIX_FADV_DONTNEED);
    }

    free(buf);
    close(fd);
    return 0;
}
```

## `madvise()` equivalents for mmap

For memory-mapped files, `posix_fadvise()` does not apply. Use `madvise()` instead:

```c
#include <sys/mman.h>

void *addr = mmap(NULL, length, PROT_READ, MAP_SHARED, fd, 0);

/* Equivalent of POSIX_FADV_SEQUENTIAL: */
madvise(addr, length, MADV_SEQUENTIAL);

/* Equivalent of POSIX_FADV_RANDOM: */
madvise(addr, length, MADV_RANDOM);

/* Equivalent of POSIX_FADV_WILLNEED: */
madvise(addr, length, MADV_WILLNEED);

/* Drop pages (equivalent of POSIX_FADV_DONTNEED): */
madvise(addr, length, MADV_DONTNEED);
```

| `madvise` flag | Effect |
|---------------|--------|
| `MADV_SEQUENTIAL` | Doubles readahead, aggressively evicts pages behind the fault point |
| `MADV_RANDOM` | Disables readahead for this mapping (`ra_pages = 0` for faults in range) |
| `MADV_WILLNEED` | Triggers async readahead for the range — pages are faulted in before the process accesses them |
| `MADV_DONTNEED` | Drops pages from cache; next access will re-fault |

`MADV_SEQUENTIAL` also instructs the kernel's page-fault handler to drop pages **behind** the current fault point more aggressively, reducing memory pressure for streaming workloads.

## Practical tuning

### `/sys/block/<dev>/queue/read_ahead_kb`

The per-device readahead size sets the default `ra_pages` for all files on that device:

```bash
# Read the current setting (in kilobytes):
cat /sys/block/sda/queue/read_ahead_kb
# 128

# Increase for sequential workloads (e.g., large video files, backups):
echo 2048 > /sys/block/sda/queue/read_ahead_kb

# Reduce for random-access workloads (e.g., database data files):
echo 16 > /sys/block/sda/queue/read_ahead_kb
```

`POSIX_FADV_SEQUENTIAL` doubles this per-fd value; `POSIX_FADV_RANDOM` zeroes it. The sysfs knob is the global baseline.

### Effect on database workloads

Most databases (PostgreSQL, MySQL InnoDB, RocksDB) open data files with either `O_DIRECT` or explicit `POSIX_FADV_RANDOM`:

- **`O_DIRECT`** — bypasses page cache and readahead entirely; the database manages its own buffer pool.
- **`POSIX_FADV_RANDOM`** — keeps buffered I/O but disables the kernel's readahead; the database issues its own prefetch via `POSIX_FADV_WILLNEED` when it knows a sequential scan is coming.

For a database running **buffered I/O without fadvise hints**, a large `read_ahead_kb` wastes memory and I/O bandwidth because the kernel prefetches pages the database will not access in order. Reducing `read_ahead_kb` to 16–64 KB on database block devices is a common production tuning step.

Conversely, for **sequential workloads** — log shipping, backup streams, analytics full-table scans — a large readahead window (512 KB – 4 MB) keeps the I/O pipeline full and eliminates stalls.

### NVMe considerations

On NVMe, I/O latency is low enough (50–200 µs) that readahead is less critical for moderate sequential reads. However, because NVMe queues are deep (1024+ commands), submitting a large readahead window early still helps saturate bandwidth. The default `read_ahead_kb` for NVMe devices is typically 128 KB; tuning to 512 KB or higher can improve throughput for bulk sequential workloads.

## Further reading

- [Buffered I/O](buffered-io.md) — page cache, `filemap_read()`, writeback
- [Direct I/O](direct-io.md) — bypassing the page cache and readahead
- `mm/readahead.c` — `ondemand_readahead()`, `page_cache_ra_unbounded()`, `page_cache_async_ra()`
