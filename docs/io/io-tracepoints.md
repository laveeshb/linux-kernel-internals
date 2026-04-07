# I/O Subsystem Tracepoints

> Runtime tracing of kernel I/O events with ftrace, perf, and BPF

The Linux kernel's I/O stack exposes dozens of tracepoints that let you observe block requests, writeback, page cache activity, and extent mapping — without recompilation and with negligible overhead when disabled.

This reference covers the tracepoints grouped by subsystem, their available fields, and practical diagnostic examples using ftrace, `perf`, and BPF (via `bpftrace`).

---

## Overview

Linux tracepoints are static probe points compiled directly into the kernel using the `TRACE_EVENT()` macro. When disabled, a tracepoint is a single compare-and-branch that costs nothing measurable. When enabled, the kernel fills in a fixed-format record and writes it to the ring buffer.

For I/O, tracepoints span four subsystems:

| Subsystem | Tracepoint prefix | What it covers |
|-----------|------------------|----------------|
| **block/** | `block:` | Request lifecycle: submission, dispatch, completion, merges |
| **writeback/** | `writeback:` | Dirty pages, flusher threads (wb), throttling |
| **filemap/** | `filemap:` | Page cache: insertions, deletions, faults |
| **iomap/** | `iomap:` | Extent mapping, direct I/O via the iomap layer |

---

## Prerequisites and General Usage

### Finding Available Tracepoints

```bash
# List all I/O-related tracepoints via the tracefs directory
ls /sys/kernel/debug/tracing/events/block/
ls /sys/kernel/debug/tracing/events/writeback/
ls /sys/kernel/debug/tracing/events/filemap/
ls /sys/kernel/debug/tracing/events/iomap/

# Or via perf
perf list 'block:*' 'writeback:*' 'filemap:*' 'iomap:*' 2>/dev/null
```

### Enabling with ftrace

```bash
# Enable a single tracepoint
echo 1 > /sys/kernel/debug/tracing/events/block/block_rq_issue/enable

# Enable an entire subsystem
echo 1 > /sys/kernel/debug/tracing/events/writeback/enable

# Read the trace buffer (snapshot)
cat /sys/kernel/debug/tracing/trace

# Stream events live
cat /sys/kernel/debug/tracing/trace_pipe

# Disable and clear the buffer
echo 0 > /sys/kernel/debug/tracing/events/block/block_rq_issue/enable
echo > /sys/kernel/debug/tracing/trace
```

The `format` file in each tracepoint directory shows the exact fields and their types:

```bash
cat /sys/kernel/debug/tracing/events/block/block_rq_issue/format
```

### Enabling with perf

```bash
# Record block tracepoints for a specific command
perf record -e 'block:block_rq_issue,block:block_rq_complete' -- fio workload.fio
perf script

# Count events system-wide over 10 seconds
perf stat -e 'block:block_rq_issue,block:block_rq_complete' -a -- sleep 10

# Trace a running process by PID
perf trace -e 'block:*' -p $(pgrep fio)
```

### Enabling with bpftrace

```bash
# bpftrace uses the tracepoint:subsystem:name syntax
bpftrace -e 'tracepoint:block:block_rq_complete { @[comm] = count(); }'

# List all iomap tracepoints
bpftrace -l 'tracepoint:iomap:*'
```

---

## Block Layer Tracepoints

**Source**: [`include/trace/events/block.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/block.h)

### Request Lifecycle: block_rq_submit / block_rq_insert / block_rq_issue / block_rq_complete

These four tracepoints cover the full lifecycle of a block I/O request from the moment it is created to the moment the device signals completion.

```
block_rq_submit   — request allocated and submitted to the block layer
block_rq_insert   — request inserted into the I/O scheduler queue
block_rq_issue    — request dispatched from the scheduler to the device driver
block_rq_complete — request completed by the device (interrupt or poll)
```

The time from `block_rq_issue` to `block_rq_complete` is the device-level latency visible to the kernel — the number most comparable to what NVMe firmware reports. The time from `block_rq_submit` to `block_rq_complete` includes scheduler queue time.

**Fields** for `block_rq_issue` (representative; all four share the same layout):

```c
/* include/trace/events/block.h */
TP_STRUCT__entry(
    __field(dev_t,        dev)
    __field(sector_t,     sector)
    __field(unsigned int, nr_sector)
    __field(unsigned int, bytes)
    __array(char,         rwbs, RWBS_LEN)   /* "R", "W", "D", "F", "RA", "WS", etc. */
    __array(char,         comm, TASK_COMM_LEN)
    __dynamic_array(char, cmd, 1)
)
```

The `dev` field encodes major:minor — use `MAJOR(dev)` / `MINOR(dev)` in BPF. The `sector` and `nr_sector` fields give the LBA range in 512-byte units regardless of the physical sector size.

#### The rwbs field

`rwbs` is a short ASCII string encoding the operation type and flags. It is decoded from the `bio` operation flags in `blk_fill_rwbs()`:

| Code | Meaning |
|------|---------|
| `R`  | Read |
| `W`  | Write |
| `D`  | Discard (TRIM/UNMAP) |
| `N`  | No-op (used by some passthrough paths) |
| `F`  | Flush / FUA (Force Unit Access — write with forced cache flush) |
| `S`  | Sync (O_SYNC or fsync-driven write) |
| `M`  | Metadata (filesystem journal or superblock I/O) |
| `A`  | Read-ahead (`REQ_RAHEAD`) |

These can combine: `"WSM"` means a synchronous metadata write; `"RA"` means a read-ahead read.

**Diagnostic use**:

```bash
# Measure block I/O latency per device
bpftrace -e '
tracepoint:block:block_rq_issue {
    @start[args->dev, args->sector] = nsecs;
}
tracepoint:block:block_rq_complete {
    $key = (args->dev, args->sector);
    if (@start[$key]) {
        @latency_us = hist((nsecs - @start[$key]) / 1000);
        delete(@start[$key]);
    }
}'
```

```bash
# Count I/O by operation type
bpftrace -e '
tracepoint:block:block_rq_issue {
    @[str(args->rwbs)] = count();
}
interval:s:5 { print(@); clear(@); }'
```

### block_bio_queue / block_bio_complete / block_bio_bounce

```
block_bio_queue    — bio submitted to the request queue (before merging or request allocation)
block_bio_complete — bio completed (may be earlier than request completion for merged bios)
block_bio_bounce   — DMA bounce buffer was allocated for this bio
```

`block_bio_bounce` firing means a bio's pages could not be DMA-mapped directly — the kernel had to copy the data through a bounce buffer in a zone accessible to the device. This is typically caused by a DMA zone mismatch (device cannot address high memory). Check the device's `dma_mask` and `coherent_dma_mask`. On modern x86-64 hardware with 64-bit-capable devices, this should never fire.

**Fields** for `block_bio_queue`:

| Field | Type | Description |
|-------|------|-------------|
| `dev` | `dev_t` | Block device (major:minor) |
| `sector` | `sector_t` | Starting LBA |
| `nr_sector` | `unsigned int` | Length in 512-byte sectors |
| `rwbs` | `char[]` | Operation type string (see rwbs table above) |
| `comm` | `char[]` | Submitting task name |

### block_rq_merge / block_bio_frontmerge / block_bio_backmerge

```
block_rq_merge        — two full requests were merged into one
block_bio_frontmerge  — bio merged at the front of an existing request (bio LBA precedes request)
block_bio_backmerge   — bio merged at the back of an existing request (most common; sequential I/O)
```

A high backmerge rate is a sign of sequential workloads — the I/O scheduler is successfully coalescing adjacent writes or reads. Zero merges on NVMe is expected and normal: NVMe uses multi-queue (`blk-mq`) with per-CPU hardware queues and typically the `none` or `mq-deadline` scheduler, which does little or no merging.

**Diagnostic use**: If you see no merges on a rotational device under a workload you expect to be sequential, check which I/O scheduler is active:

```bash
cat /sys/block/sda/queue/scheduler
```

### block_plug / block_unplug

```
block_plug   — a task began plugging its I/O (batching requests before submission)
block_unplug — a task flushed its plug queue (submitted the batched requests)
```

Plugging is a per-task optimization where the kernel holds back I/O submissions briefly so that adjacent requests can be merged or reordered before hitting the scheduler. `block_plug` fires when a task starts building a batch; `block_unplug` fires when the batch is flushed, either explicitly (via `blk_finish_plug()`) or when the task blocks.

**Fields** for `block_unplug`:

| Field | Type | Description |
|-------|------|-------------|
| `nr_rqs` | `int` | Number of requests flushed from the plug |
| `sync` | `bool` | Whether the unplug was synchronous |

A `nr_rqs` value of 1 means plugging provided no benefit — the task submitted one request at a time. Higher values indicate effective batching.

### block_split

```
block_split — a bio was split into two because it exceeded device or queue limits
```

A bio is split when it exceeds `max_sectors`, `max_segments`, or `max_segment_size` from the request queue's limits (`struct queue_limits`). Frequent splits mean the caller is building bios that are too large for the device.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `dev` | `dev_t` | Block device |
| `sector` | `sector_t` | LBA where the split occurred |
| `new_sector` | `sector_t` | Start of the second (split-off) bio |
| `rwbs` | `char[]` | Operation type |
| `comm` | `char[]` | Submitting task |

**Diagnostic use**: Frequent `block_split` events on NVMe with large-block workloads (e.g., databases using 1 MiB I/O) may indicate the `max_sectors_kb` queue setting is too low:

```bash
cat /sys/block/nvme0n1/queue/max_sectors_kb
```

### block_getrq / block_sleeprq

```
block_getrq   — a request slot was allocated immediately from the free list
block_sleeprq — had to sleep waiting for a request slot (queue depth exhausted)
```

`block_sleeprq` fires when all `nr_requests` slots in the request queue are in-flight and the submitter must wait. This means your configured queue depth is too small for the offered load.

```bash
# Current queue depth setting
cat /sys/block/sda/queue/nr_requests

# Watch for queue starvation events
bpftrace -e '
tracepoint:block:block_sleeprq {
    @[comm] = count();
}
interval:s:5 { print(@); clear(@); }'
```

### block_dirty_buffer / block_touch_buffer

```
block_dirty_buffer — a buffer_head was marked dirty (metadata write path, buffer_head users only)
block_touch_buffer — a buffer_head was accessed
```

These apply only to filesystems using `struct buffer_head` (ext2, ext4 without iomap, fat). Filesystems that have adopted iomap (XFS, ext4 with `CONFIG_FS_IOMAP`, btrfs via its own path) do not use these.

---

## Writeback Tracepoints

**Source**: [`include/trace/events/writeback.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/writeback.h)

The writeback subsystem manages the flushing of dirty pages from the page cache to storage. It is organized around per-device `bdi_writeback` structures (wb), each running a `writeback_workqueue` flush thread. Tracepoints here cover three concerns: which inodes are getting dirty, what the flush threads are doing, and whether dirty throttling is slowing down writers.

### writeback_dirty_inode / writeback_dirty_page

```c
writeback_dirty_inode  /* an inode was marked dirty: I_DIRTY_PAGES, I_DIRTY_SYNC, or I_DIRTY_DATASYNC */
writeback_dirty_page   /* a specific page within an inode was marked dirty */
```

Use these to identify which files are generating the most dirty data.

**Fields** for `writeback_dirty_inode`:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `char[]` | Backing device name (e.g., `"nvme0n1"`) |
| `ino` | `unsigned long` | Inode number |
| `state` | `unsigned long` | New inode dirty state flags (`I_DIRTY_*`) |

```bash
# Top inodes generating dirty pages (by inode number and device)
bpftrace -e '
tracepoint:writeback:writeback_dirty_inode {
    @[args->name, args->ino] = count();
}
interval:s:10 { print(@, 10); clear(@); }'
```

To map an inode number back to a filename:

```bash
find /mount/point -inum <ino>
```

### writeback_write_inode / writeback_single_inode

```
writeback_write_inode   — writeback started on a specific inode
writeback_single_inode  — writeback of one inode finished
```

The `writeback_single_inode` tracepoint fires after all pages for an inode have been written in a single wb pass.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `char[]` | Device name |
| `ino` | `unsigned long` | Inode number |
| `state` | `unsigned long` | Inode state at the time of writeback |
| `dirtied_when` | `unsigned long` | Jiffies when the inode was first dirtied |
| `writeback_index` | `unsigned long` | Page index to start writeback from |
| `nr_to_write` | `long` | Number of pages requested to write |
| `wrote` | `unsigned long` | Number of pages actually written |

A `wrote` value much smaller than `nr_to_write` for a given inode indicates contention — pages were under I/O or locked. Check `nr_writeback` in `/proc/meminfo`.

### writeback_start / writeback_written / writeback_wait

These cover the three phases of a `wb_writeback_work` operation — one unit of work assigned to a writeback thread:

```
writeback_start   — wb_writeback() started processing a work item
writeback_written — pages have been written in this pass (intermediate update)
writeback_wait    — WB_SYNC_ALL mode: waiting for all submitted I/Os to complete
```

`writeback_wait` fires only for `WB_SYNC_ALL` writeback, which is triggered by `fsync()`, `sync()`, or the periodic writeback with `dirty_expire_centisecs` expiry. Background writeback (`WB_SYNC_NONE`) never reaches `writeback_wait`.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `char[]` | Device name |
| `nr_pages` | `long` | Pages to be written in this work item |
| `sb_dev` | `dev_t` | Superblock device |
| `sync_mode` | `int` | `WB_SYNC_NONE` (0) or `WB_SYNC_ALL` (1) |
| `for_kupdate` | `int` | This is a kupdate (periodic age-based flush) |
| `range_cyclic` | `int` | Range-cyclic mode (wraps around file) |
| `for_background` | `int` | Background writeback triggered by dirty threshold |

### writeback_balance_dirty_start / writeback_balance_dirty_pages

```
writeback_balance_dirty_start  — a writer entered balance_dirty_pages() (about to be throttled)
writeback_balance_dirty_pages  — each individual sleep event inside dirty throttling
```

These are the most important writeback tracepoints for diagnosing write throughput problems. When a process has dirtied pages faster than writeback can flush them, `balance_dirty_pages()` introduces artificial delays to slow the writer. Every call to `usleep_range()` inside `balance_dirty_pages()` fires `writeback_balance_dirty_pages`.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `bdi` | `char[]` | Backing device identifier |
| `limit` | `unsigned long` | Current dirty limit (pages) |
| `setpoint` | `unsigned long` | Desired dirty setpoint (pages) |
| `dirty` | `unsigned long` | Current global dirty page count |
| `bdi_dirty` | `unsigned long` | Dirty pages on this specific bdi |
| `dirty_ratelimit` | `unsigned long` | Current dirty rate limit (pages/second) |
| `task_ratelimit` | `unsigned long` | Rate limit applied to this task |
| `dirtied` | `unsigned int` | Pages dirtied by this task in this interval |
| `period` | `unsigned long` | Control period (jiffies) |
| `pause` | `long` | Sleep duration (nanoseconds) |
| `cgroup_ino` | `unsigned long` | cgroup inode (for per-cgroup writeback) |

```bash
# Detect dirty throttling and show which tasks are being slowed
bpftrace -e '
tracepoint:writeback:balance_dirty_pages {
    printf("throttled: pid=%d comm=%s bdi=%s sleep=%ldms dirty=%lu limit=%lu\n",
           pid, comm,
           str(args->bdi),
           args->pause / 1000000,
           args->dirty,
           args->limit);
}'
```

Frequent `balance_dirty_pages` events with long `pause` values indicate that writers are outrunning the storage subsystem. Tuning options: increase `vm.dirty_bytes` / `vm.dirty_ratio` (raises the throttle threshold), reduce `vm.dirty_background_bytes` (starts writeback earlier), or investigate storage throughput with the block tracepoints above.

### writeback_global_dirty_state

```
writeback_global_dirty_state — snapshot of global dirty accounting at each balance point
```

This fires at the same points as `balance_dirty_pages` but records the global counters rather than per-task data.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `nr_dirty` | `unsigned long` | Global dirty pages |
| `nr_writeback` | `unsigned long` | Pages currently under writeback |
| `background_thresh` | `unsigned long` | Background writeback threshold (pages) |
| `dirty_thresh` | `unsigned long` | Hard dirty limit (pages) |
| `dirty_limit` | `unsigned long` | Adjusted dirty limit after accounting |
| `nr_dirtied` | `unsigned long` | Total pages dirtied since boot |
| `nr_written` | `unsigned long` | Total pages written since boot |

When `nr_dirty` approaches `dirty_thresh`, the kernel starts hard throttling. When `nr_dirty` exceeds `background_thresh`, background flusher threads wake up. This tracepoint lets you watch these thresholds in real time.

### writeback_sb_inodes_requeue

```
writeback_sb_inodes_requeue — an inode was requeued for another writeback pass
```

Fires when an inode is put back on the writeback list because it was not fully written in one pass (e.g., the budget of `nr_to_write` was exhausted). High requeue rates for the same inode suggest a very large or continuously re-dirtied file.

### writeback_congestion_wait / writeback_wait_iff_congested

```
writeback_congestion_wait      — writeback thread sleeping because the device queue is full
writeback_wait_iff_congested   — writeback thread conditionally waiting on device congestion
```

!!! note "Congestion removal"
    As of Linux 5.18, the block layer congestion mechanism (`set_bdi_congested` / `clear_bdi_congested`) was largely removed. On kernels 5.18+, `writeback_congestion_wait` events are rare or absent. The tracepoints still exist for compatibility.

---

## Filemap Tracepoints

**Source**: [`include/trace/events/filemap.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/filemap.h)

The filemap tracepoints cover the page cache layer — what goes in, what comes out, and what triggers I/O to fill it.

### mm_filemap_add_to_page_cache / mm_filemap_delete_from_page_cache

```
mm_filemap_add_to_page_cache    — a page (folio) was inserted into the page cache
mm_filemap_delete_from_page_cache — a page (folio) was removed from the page cache
```

`add` fires for both read-path cache fills and write-path dirty insertions. `delete` fires on reclaim (page freed to the buddy allocator) and on truncation.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `pfn` | `unsigned long` | Page frame number of the inserted/deleted page |
| `i_ino` | `unsigned long` | Inode number |
| `index` | `unsigned long` | Page index within the file (page_offset / PAGE_SIZE) |
| `s_dev` | `dev_t` | Superblock device |
| `shadow` | `bool` | (delete only) Page was replaced by a shadow entry (for workingset detection) |

```bash
# Track cache population and eviction for a specific device
bpftrace -e '
tracepoint:filemap:mm_filemap_add_to_page_cache    { @adds[args->s_dev]++; }
tracepoint:filemap:mm_filemap_delete_from_page_cache { @dels[args->s_dev]++; }
interval:s:5 {
    printf("adds=%d evictions=%d\n", @adds, @dels);
    clear(@adds); clear(@dels);
}'
```

To track a specific file, filter on `i_ino`:

```bash
# Get the inode number first
stat /path/to/file

# Then filter tracepoints to that inode
bpftrace -e '
tracepoint:filemap:mm_filemap_add_to_page_cache /args->i_ino == 123456/ {
    @pages_loaded++;
}'
```

### mm_filemap_fault / mm_filemap_map_pages

```
mm_filemap_fault     — a page fault into a memory-mapped file (mmap) required reading from disk
mm_filemap_map_pages — map_pages() was called to fault in a batch of pages speculatively
```

`mm_filemap_fault` is the single-page fault path. It fires when a process accesses an mmap region and the backing page is not in the page cache — a major fault. `mm_filemap_map_pages` fires when the kernel proactively faults in adjacent pages to reduce future fault overhead.

**Fields** for `mm_filemap_fault`:

| Field | Type | Description |
|-------|------|-------------|
| `i_ino` | `unsigned long` | Inode number |
| `s_dev` | `dev_t` | Device |
| `index` | `unsigned long` | Faulted page index |

```bash
# Count major mmap faults by inode
bpftrace -e '
tracepoint:filemap:mm_filemap_fault {
    @[args->s_dev, args->i_ino] = count();
}
interval:s:10 { print(@, 10); clear(@); }'
```

### Measuring Cache Miss Rate

```bash
# Track miss rate (new pages entering cache) vs read-ahead
bpftrace -e '
tracepoint:filemap:mm_filemap_add_to_page_cache { @misses++; }
tracepoint:block:block_rq_issue / str(args->rwbs) == "RA" / { @readahead++; }
interval:s:1 {
    printf("misses/s=%d readahead_ios/s=%d\n", @misses, @readahead);
    clear(@misses); clear(@readahead);
}'
```

The `misses` counter here is a superset — it includes both demand reads and write-path page insertions. To isolate read misses, also filter on the absence of concurrent dirty state, or cross-reference with `block_rq_issue` read events.

---

## iomap Tracepoints

**Source**: [`include/trace/events/iomap.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/iomap.h)

iomap is the modern extent-mapping layer used by XFS, ext4, btrfs (partially), and others. It replaced per-filesystem implementations of `write_begin`/`write_end`/`direct_IO`. See [iomap-internals.md](iomap-internals.md) for the full architecture.

iomap tracepoints sit between the VFS and the block layer — they show extent-resolution activity before block I/O is submitted.

### iomap_readpage / iomap_readahead

```
iomap_readpage   — iomap is reading a single page (demand read)
iomap_readahead  — iomap is submitting a readahead batch
```

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `dev` | `dev_t` | Block device |
| `ino` | `unsigned long` | Inode number |
| `size` | `loff_t` | File size at the time of the read |
| `offset` | `loff_t` | File offset being read |
| `length` | `loff_t` | Length of the range being read |
| `nr_pages` | `int` | (readahead only) Number of pages in the batch |

### iomap_writepage / iomap_writepages

```
iomap_writepage  — iomap is writing a single dirty page to disk
iomap_writepages — iomap is processing a batch of dirty pages for writeback
```

**Fields** for `iomap_writepage`:

| Field | Type | Description |
|-------|------|-------------|
| `dev` | `dev_t` | Block device |
| `ino` | `unsigned long` | Inode number |
| `size` | `loff_t` | File size |
| `offset` | `loff_t` | Page offset |

### iomap_dio_rw_begin / iomap_dio_rw_end

These cover the direct I/O path through iomap — used by O_DIRECT reads and writes on XFS, ext4, and other iomap-based filesystems.

```
iomap_dio_rw_begin — a direct I/O operation started (after extent mapping)
iomap_dio_rw_end   — a direct I/O operation completed (all bios done)
```

**Fields** for `iomap_dio_rw_begin`:

| Field | Type | Description |
|-------|------|-------------|
| `dev` | `dev_t` | Block device |
| `ino` | `unsigned long` | Inode number |
| `isize` | `loff_t` | Inode size |
| `pos` | `loff_t` | File position for this I/O |
| `count` | `unsigned long` | Bytes requested |
| `flags` | `unsigned int` | iomap DIO flags (`IOMAP_DIO_*`) |

**Fields** for `iomap_dio_rw_end`:

| Field | Type | Description |
|-------|------|-------------|
| `dev` | `dev_t` | Block device |
| `ino` | `unsigned long` | Inode number |
| `isize` | `loff_t` | Inode size |
| `pos` | `loff_t` | File position |
| `count` | `unsigned long` | Bytes requested |
| `ret` | `ssize_t` | Return value (bytes transferred, or negative errno) |

```bash
# Measure O_DIRECT I/O latency via iomap
bpftrace -e '
tracepoint:iomap:iomap_dio_rw_begin {
    @start[args->ino, args->pos] = nsecs;
}
tracepoint:iomap:iomap_dio_rw_end {
    $key = (args->ino, args->pos);
    if (@start[$key]) {
        @dio_latency_us = hist((nsecs - @start[$key]) / 1000);
        delete(@start[$key]);
    }
}'
```

### Correlating iomap and Block Tracepoints

iomap tracepoints operate at the file level (inode + file offset), while block tracepoints operate at the device level (dev + LBA sector). To correlate them:

1. Record both `iomap:iomap_dio_rw_begin` (file offset) and `block:block_rq_issue` (sector) with timestamps.
2. Match by timestamp window and device — the block I/Os issued within a few microseconds after `iomap_dio_rw_begin` on the same device belong to that request.
3. For filesystem-level to sector-level mapping, use `filefrag -v` or `FIEMAP ioctl` offline to build a file-offset-to-LBA map.

```bash
# Observe both layers for a specific inode
INODE=$(stat -c %i /path/to/file)

bpftrace -e '
tracepoint:iomap:iomap_dio_rw_begin /args->ino == '"$INODE"'/ {
    printf("DIO begin: pos=%lld count=%lu t=%llu\n",
           args->pos, args->count, nsecs);
}
tracepoint:block:block_rq_issue {
    printf("  rq_issue: dev=%d:%d sector=%llu rwbs=%s t=%llu\n",
           args->dev >> 20, args->dev & ((1<<20)-1),
           args->sector, str(args->rwbs), nsecs);
}'
```

---

## Practical Diagnostic Recipes

### Recipe 1: Block I/O Latency Histogram per Device

```bash
bpftrace -e '
tracepoint:block:block_rq_issue {
    @start[args->dev, args->sector] = nsecs;
}
tracepoint:block:block_rq_complete {
    $key = (args->dev, args->sector);
    if (@start[$key]) {
        @latency_us[args->dev] = hist((nsecs - @start[$key]) / 1000);
        delete(@start[$key]);
    }
}
interval:s:10 {
    print(@latency_us);
    clear(@latency_us);
    clear(@start);
}'
```

### Recipe 2: Find Top Dirty Files

Identify which inodes are dirtying the most pages:

```bash
bpftrace -e '
tracepoint:writeback:writeback_dirty_inode {
    @[str(args->name), args->ino] = count();
}
interval:s:30 {
    print(@, 10);
    clear(@);
}'
```

Then resolve inode numbers to paths on the relevant filesystem:

```bash
find /mount -inum <ino> 2>/dev/null
```

### Recipe 3: Detect and Quantify Dirty Throttling

```bash
bpftrace -e '
tracepoint:writeback:balance_dirty_pages {
    @sleep_ms[comm] = sum(args->pause / 1000000);
    @throttle_count[comm]++;
}
interval:s:10 {
    printf("\nDirty throttle sleep time (ms) by task:\n");
    print(@sleep_ms, 10);
    printf("\nDirty throttle event count by task:\n");
    print(@throttle_count, 10);
    clear(@sleep_ms); clear(@throttle_count);
}'
```

A task accumulating tens or hundreds of milliseconds of throttle sleep per interval is severely write-throttled. Options: tune `vm.dirty_ratio` / `vm.dirty_bytes`, increase storage throughput, or restructure the workload to write smaller batches.

### Recipe 4: Page Cache Miss Rate per File

```bash
bpftrace -e '
tracepoint:filemap:mm_filemap_add_to_page_cache {
    @cache_misses[args->s_dev, args->i_ino]++;
}
tracepoint:filemap:mm_filemap_delete_from_page_cache {
    @evictions[args->s_dev, args->i_ino]++;
}
interval:s:15 {
    printf("Cache misses (new pages loaded):\n");
    print(@cache_misses, 10);
    printf("Cache evictions:\n");
    print(@evictions, 10);
    clear(@cache_misses); clear(@evictions);
}'
```

A file with a high miss rate that is also seeing frequent evictions is caught in a reclaim loop — it is read frequently but always evicted before the next access. This is a workload that would benefit from larger available memory or `mlock()`.

### Recipe 5: Queue Depth Saturation Check

Monitor whether the block queue depth is a bottleneck:

```bash
bpftrace -e '
tracepoint:block:block_sleeprq {
    @queue_waits[comm]++;
}
tracepoint:block:block_getrq {
    @queue_hits[comm]++;
}
interval:s:10 {
    printf("Queue slot waits (block_sleeprq):\n");
    print(@queue_waits, 10);
    printf("Queue slot hits (block_getrq):\n");
    print(@queue_hits, 10);
    clear(@queue_waits); clear(@queue_hits);
}'
```

If `queue_waits` is non-zero, increase `nr_requests`:

```bash
echo 256 > /sys/block/sda/queue/nr_requests
```

### Recipe 6: O_DIRECT vs Buffered I/O Breakdown

```bash
bpftrace -e '
tracepoint:iomap:iomap_dio_rw_begin {
    @dio_bytes = sum(args->count);
    @dio_ops++;
}
tracepoint:filemap:mm_filemap_add_to_page_cache {
    @buffered_pages++;
}
interval:s:5 {
    printf("Direct I/O: %d ops, %llu bytes\n", @dio_ops, @dio_bytes);
    printf("Buffered:   %d pages loaded (%llu KB)\n",
           @buffered_pages, @buffered_pages * 4);
    clear(@dio_bytes); clear(@dio_ops); clear(@buffered_pages);
}'
```

### Recipe 7: End-to-End Write Path Tracing

Trace a single write from page dirtying through writeback to block completion:

```bash
bpftrace -e '
tracepoint:writeback:writeback_dirty_page  { @dirty++; }
tracepoint:writeback:writeback_write_inode { @wb_start++; }
tracepoint:block:block_rq_issue /str(args->rwbs) == "W" ||
                                  str(args->rwbs) == "WS"/ { @issued++; }
tracepoint:block:block_rq_complete /str(args->rwbs) == "W" ||
                                     str(args->rwbs) == "WS"/ { @completed++; }
interval:s:5 {
    printf("dirty_page: %d  wb_write_inode: %d  rq_issue: %d  rq_complete: %d\n",
           @dirty, @wb_start, @issued, @completed);
    clear(@dirty); clear(@wb_start); clear(@issued); clear(@completed);
}'
```

---

## Tracepoint Quick Reference

| Subsystem | Tracepoint | Primary Use |
|-----------|-----------|-------------|
| block | `block:block_rq_issue` | Dispatch latency start |
| block | `block:block_rq_complete` | Dispatch latency end; I/O completion rate |
| block | `block:block_rq_insert` | Scheduler queue depth |
| block | `block:block_bio_queue` | Bio submission rate |
| block | `block:block_bio_bounce` | DMA misconfiguration |
| block | `block:block_bio_backmerge` | Sequential I/O quality |
| block | `block:block_rq_merge` | Request consolidation |
| block | `block:block_plug` / `block_unplug` | Plugging batch size |
| block | `block:block_split` | Oversized bios / queue limit |
| block | `block:block_sleeprq` | Queue depth saturation |
| writeback | `writeback:writeback_dirty_inode` | Which files are dirtying |
| writeback | `writeback:writeback_dirty_page` | Per-page dirty rate |
| writeback | `writeback:writeback_single_inode` | Per-inode writeback completion |
| writeback | `writeback:balance_dirty_pages` | Write throttling events |
| writeback | `writeback:writeback_global_dirty_state` | Global dirty accounting |
| writeback | `writeback:writeback_start` | Flush thread activity |
| writeback | `writeback:writeback_wait` | Sync writeback stalls |
| filemap | `filemap:mm_filemap_add_to_page_cache` | Cache miss / page load rate |
| filemap | `filemap:mm_filemap_delete_from_page_cache` | Cache eviction rate |
| filemap | `filemap:mm_filemap_fault` | mmap major fault rate |
| filemap | `filemap:mm_filemap_map_pages` | Speculative fault batches |
| iomap | `iomap:iomap_readpage` | Buffered read (iomap path) |
| iomap | `iomap:iomap_writepage` | Writeback (iomap path) |
| iomap | `iomap:iomap_dio_rw_begin` | Direct I/O start |
| iomap | `iomap:iomap_dio_rw_end` | Direct I/O completion and result |

---

## Key Source Files

| File | Description |
|------|-------------|
| [`include/trace/events/block.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/block.h) | Block layer tracepoint definitions |
| [`include/trace/events/writeback.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/writeback.h) | Writeback tracepoint definitions |
| [`include/trace/events/filemap.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/filemap.h) | Page cache (filemap) tracepoint definitions |
| [`include/trace/events/iomap.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/iomap.h) | iomap layer tracepoint definitions |
| [`block/blk-core.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-core.c) | Block core — calls `trace_block_rq_insert()`, `trace_block_rq_issue()`, etc. |
| [`block/blk-merge.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-merge.c) | Merge logic — calls `trace_block_bio_backmerge()` etc. |
| [`mm/page-writeback.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page-writeback.c) | Dirty throttling and writeback — calls `trace_writeback_*` |
| [`mm/filemap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/filemap.c) | Page cache operations — calls `trace_mm_filemap_*` |
| [`fs/iomap/buffered-io.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/iomap/buffered-io.c) | iomap buffered I/O — calls `trace_iomap_readpage()` etc. |
| [`fs/iomap/direct-io.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/iomap/direct-io.c) | iomap direct I/O — calls `trace_iomap_dio_rw_begin()` etc. |

---

## Further Reading

### Kernel Source

- [`include/trace/events/block.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/block.h) — full `TRACE_EVENT()` definitions for all block tracepoints
- [`include/trace/events/writeback.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/writeback.h) — writeback tracepoint definitions, including the `bdi_writeback` field layouts
- [`include/trace/events/filemap.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/filemap.h) — filemap tracepoint definitions
- [`Documentation/trace/events.rst`](https://docs.kernel.org/trace/events.html) — enabling tracepoints via tracefs, filter syntax, and trigger actions
- [`Documentation/trace/tracepoints.rst`](https://docs.kernel.org/trace/tracepoints.html) — how `TRACE_EVENT()` macros work and how to define new tracepoints

### Kernel Documentation

- [`Documentation/block/blk-mq.rst`](https://docs.kernel.org/block/blk-mq.html) — multi-queue block layer architecture; explains why NVMe tracepoints look different from HDD
- [`Documentation/filesystems/vfs.rst`](https://docs.kernel.org/filesystems/vfs.html) — VFS layer context for filemap and iomap tracepoints

### Related Pages

- [observability.md](observability.md) — `/proc/diskstats`, `iostat`, and `blktrace` — the aggregate-counter layer that complements tracepoints
- [writeback-internals.md](writeback-internals.md) — detailed walkthrough of the writeback state machine that these tracepoints instrument
- [page-cache-internals.md](page-cache-internals.md) — page cache data structures underlying the filemap tracepoints
- [iomap-internals.md](iomap-internals.md) — iomap architecture: `struct iomap`, `iomap_begin()`, and the buffered/direct split
- [tuning-storage.md](tuning-storage.md) — sysctl and queue parameters to adjust based on tracepoint findings

### LWN Articles

- [LWN: The block I/O tracing facility](https://lwn.net/Articles/332108/) — introduction to `blktrace` and the block tracepoint infrastructure it is built on
- [LWN: Controlling writeback from within](https://lwn.net/Articles/456904/) — the design of `balance_dirty_pages()` and the throttling mechanism observable via `balance_dirty_pages` tracepoints
- [LWN: Dynamic tracing with BPF](https://lwn.net/Articles/740157/) — using `bpftrace` to attach to kernel tracepoints
