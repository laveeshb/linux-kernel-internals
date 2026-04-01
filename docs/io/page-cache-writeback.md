# Page Cache Writeback

> How the kernel flushes dirty pages to storage, and what controls the timing

## What writeback is

When a process calls `write()`, the kernel copies data into **page cache** pages and marks them **dirty** — modified in memory but not yet on disk. At some later point the kernel must flush these dirty pages to storage. That process is called **writeback**.

```
write() path:
  process → copy_from_user() → page cache (dirty) → return to caller
                                       ↓
                              [later, asynchronously]
                                       ↓
                             writeback → block layer → disk
```

Writeback sits at the intersection of two competing pressures:

- **Write performance**: buffering writes in DRAM and flushing them in large batches is much faster than writing every `write()` call synchronously to disk.
- **Memory pressure**: dirty pages cannot be reclaimed until they are written back. Too many dirty pages means less free memory for new allocations.

The kernel balances these by limiting how much of RAM can be dirty at any time, and by proactively flushing dirty pages in the background.

## Writeback threads: `bdi_writeback`

Each block device has an associated **backing device info** (`struct bdi_writeback`) that owns the writeback state for all filesystems on that device. A per-BDI kernel worker thread (`wb_workfn`) runs the actual flush work.

```c
/* include/linux/backing-dev-defs.h */
struct bdi_writeback {
    struct backing_dev_info *bdi;   /* parent BDI */
    unsigned long state;            /* WB_writeback_running, etc. */
    unsigned long last_old_flush;   /* last time we held off flushing */

    struct list_head b_dirty;       /* dirty inodes */
    struct list_head b_io;          /* inodes ready for writeback */
    struct list_head b_more_io;     /* inodes waiting for more writeback */
    struct list_head b_dirty_time;  /* time-expired dirty inodes */

    spinlock_t list_lock;           /* protects the inode lists */

    struct percpu_counter stat[NR_WB_STAT_ITEMS]; /* bytes written, etc. */

    struct delayed_work dwork;      /* work item for wb_workfn */
    struct delayed_work bw_dwork;   /* bandwidth estimation work */
};
```

The work function `wb_workfn()` (in `fs/fs-writeback.c`) is scheduled via the `dwork` delayed work item. It calls `writeback_inodes_wb()` to walk the dirty inode lists and push pages to storage:

```c
/* fs/fs-writeback.c (simplified) */
void wb_workfn(struct work_struct *work)
{
    struct bdi_writeback *wb =
        container_of(to_delayed_work(work), struct bdi_writeback, dwork);
    struct wb_writeback_work *work_item;

    /* Process any explicit work items (sync, fsync) first */
    while ((work_item = get_next_work_item(wb)) != NULL) {
        wb_do_writeback(wb);
        finish_writeback_work(wb, work_item);
    }

    /* Then do periodic/background writeback */
    wb_do_writeback(wb);

    /* Reschedule if there is still dirty data */
    if (wb_has_dirty_io(wb))
        wb_wakeup_delayed(wb);
}

static long writeback_inodes_wb(struct bdi_writeback *wb,
                                 struct wb_writeback_work *work)
{
    /* Move inodes from b_dirty → b_io */
    queue_io(wb, work, dirtied_before);

    /* Iterate b_io list and write each inode's dirty pages */
    while (!list_empty(&wb->b_io)) {
        struct inode *inode = wb_inode(wb->b_io.prev);
        writeback_sb_inodes(inode->i_sb, wb, work);
    }
}
```

To see which BDIs exist on a running system:

```bash
ls /sys/class/bdi/
# e.g.: 8:0  259:0  0:12  ...

# Writeback stats per BDI:
cat /sys/class/bdi/8:0/stats
```

## Dirty throttling

The kernel imposes two thresholds — expressed as a percentage of available memory — to control how much dirty data can accumulate.

### `dirty_background_ratio` (default: 10%)

The **soft limit**. When dirty pages exceed this fraction of memory, the background flusher (`wb_workfn`) is woken up to start writing. Processes writing new data are not stalled — writeback runs concurrently.

### `dirty_ratio` (default: 20%)

The **hard limit**. When dirty pages hit this fraction of memory, the kernel throttles the writing process directly: `balance_dirty_pages()` stalls the process (via `usleep_range()`) until enough dirty pages have been flushed. This is sometimes called **direct reclaim throttling** or **dirty throttling**.

```
          0%        10%         20%
          |---------|-----------|
          clean   background   direct
                   flusher     reclaim
                   wakes up    (process stalls)
```

### `/proc/sys/vm/` parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `dirty_ratio` | 20 | Hard limit: % of memory that can be dirty before a writing process is throttled |
| `dirty_background_ratio` | 10 | Soft limit: % of memory that triggers background writeback |
| `dirty_bytes` | 0 | Hard limit in bytes (overrides `dirty_ratio` when non-zero) |
| `dirty_background_bytes` | 0 | Soft limit in bytes (overrides `dirty_background_ratio` when non-zero) |
| `dirty_writeback_centisecs` | 500 | How often the flusher wakes up, in centiseconds (500 = 5 s) |
| `dirty_expire_centisecs` | 3000 | How old a dirty page must be before it is eligible for writeback (3000 = 30 s) |

```bash
# Read current values:
sysctl vm.dirty_ratio vm.dirty_background_ratio \
       vm.dirty_writeback_centisecs vm.dirty_expire_centisecs

# Tune for a write-heavy workload (more buffering):
sysctl -w vm.dirty_ratio=40
sysctl -w vm.dirty_background_ratio=20

# Tune for durability (flush more aggressively):
sysctl -w vm.dirty_writeback_centisecs=100   # wake up every 1 s
sysctl -w vm.dirty_expire_centisecs=500      # flush pages older than 5 s
```

The logic that enforces the hard limit lives in `mm/page-writeback.c`:

```c
/* mm/page-writeback.c (simplified) */
static void balance_dirty_pages(struct bdi_writeback *wb,
                                 unsigned long pages_dirtied)
{
    for (;;) {
        unsigned long nr_dirty = global_node_page_state(NR_FILE_DIRTY);
        unsigned long dirty_thresh = wb_calc_thresh(wb, ...);

        if (nr_dirty <= dirty_thresh)
            break;

        /* Kick background writeback */
        wb_start_background_writeback(wb);

        /* Throttle the writing process */
        nr_reclaimable = nr_dirty - dirty_thresh;
        pause = msecs_to_jiffies(
            balance_dirty_pages_ratelimited_interval(wb, nr_reclaimable));
        usleep_range(pause, pause + pause / 8);
    }
}
```

## When writeback triggers

Writeback fires from four distinct sources:

### 1. Periodic (timer-based)

Every `dirty_writeback_centisecs` centiseconds, the per-BDI delayed work item fires `wb_workfn`. It flushes pages older than `dirty_expire_centisecs`. This is the normal steady-state path for most workloads.

### 2. Soft limit crossed

When dirty pages exceed `dirty_background_ratio`, `wb_start_background_writeback()` is called from `balance_dirty_pages()`, waking the flusher immediately without stalling the writer.

### 3. Memory pressure (kswapd)

When `kswapd` tries to reclaim pages, it cannot reclaim dirty pages without writing them first. It calls `wakeup_flusher_threads()` to ask writeback to flush dirty pages so they become reclaimable. If background writeback is too slow, `kswapd` itself may write pages directly.

### 4. Explicit sync calls

`sync()`, `fsync()`, and `fdatasync()` inject a `wb_writeback_work` item directly into the BDI's work queue, bypassing the periodic timer entirely.

```
                ┌─────────────────────────────────────────┐
                │            writeback triggers            │
                ├───────────┬───────────┬──────────────────┤
                │ periodic  │ mem       │ explicit         │
                │ (5s timer)│ pressure  │ sync/fsync       │
                └─────┬─────┴─────┬─────┴────┬─────────────┘
                      └───────────┴──────────┘
                                  │
                           wb_workfn()
                                  │
                    writeback_inodes_wb()
```

## The writeback path

Once `wb_workfn` is running, the call chain proceeds down through the VFS and into the filesystem:

```
wb_workfn()
  └── wb_do_writeback()
        └── writeback_inodes_wb()          fs/fs-writeback.c
              └── writeback_sb_inodes()    per-superblock loop
                    └── writeback_single_inode()
                          └── do_writepages()     mm/page-writeback.c
                                └── a_ops->writepages()   filesystem op
                                      └── (e.g.) ext4_writepages()
                                            └── mpage_writepages() / iomap_writepages()
                                                  └── submit_bio()
                                                        └── block layer → driver → disk
```

The key boundary is `a_ops->writepages` — the `address_space_operations` vector. Each filesystem implements its own, but they all eventually call down to `submit_bio()`.

```c
/* mm/page-writeback.c */
int do_writepages(struct address_space *mapping, struct writeback_control *wbc)
{
    int ret;

    if (mapping->a_ops->writepages)
        ret = mapping->a_ops->writepages(mapping, wbc);
    else
        ret = generic_writepages(mapping, wbc);

    return ret;
}
```

The `writeback_control` struct carries the parameters for the writeback pass: how many pages to write, whether to wait for I/O completion, and which range of the file to flush.

```c
/* include/linux/writeback.h */
struct writeback_control {
    long nr_to_write;           /* number of pages to write (decremented) */
    long pages_skipped;         /* pages that were skipped */
    loff_t range_start;         /* start of file range to write */
    loff_t range_end;           /* end of file range */
    enum writeback_sync_modes sync_mode; /* WB_SYNC_NONE or WB_SYNC_ALL */
    unsigned for_kupdate:1;     /* periodic flusher writeback */
    unsigned for_background:1;  /* background (soft limit) writeback */
    unsigned tagged_writepages:1; /* tag-based writeback */
};
```

## `fsync()` vs `fdatasync()` vs `sync()`

These three calls are often confused. They differ in scope and in what metadata they guarantee:

| Call | Scope | Data | File metadata (size, mtime) | Other metadata (dir entry) |
|------|-------|------|-----------------------------|---------------------------|
| `fdatasync(fd)` | single file | yes | only if needed for data integrity | no |
| `fsync(fd)` | single file | yes | yes | no |
| `sync()` | all filesystems | yes | yes | yes (deferred, not guaranteed immediate) |

```c
/* Ensure a newly written file is durable and findable after crash */

int fd = open("data.bin", O_WRONLY | O_CREAT, 0644);
write(fd, buf, len);

/* Step 1: flush file data and metadata to disk */
fsync(fd);

/* Step 2: flush the directory entry (so the filename survives a crash) */
int dir_fd = open(dirname(path), O_RDONLY);
fsync(dir_fd);    /* flushes the directory's data, making the entry durable */
close(dir_fd);

close(fd);
```

`fdatasync()` skips the inode's metadata (mtime, atime) when they are not required for a correct read of the data — saving one journal commit on filesystems like ext4. It still flushes the file size if the write extended the file.

The kernel path for `fsync()`:

```c
/* fs/sync.c */
SYSCALL_DEFINE1(fsync, unsigned int, fd)
{
    return do_fsync(fd, 0);  /* 0 = sync data + metadata */
}

SYSCALL_DEFINE1(fdatasync, unsigned int, fd)
{
    return do_fsync(fd, 1);  /* 1 = datasync (metadata only if needed) */
}

static int do_fsync(unsigned int fd, int datasync)
{
    struct fd f = fdget(fd);
    ret = vfs_fsync(f.file, datasync);
    /* vfs_fsync → file->f_op->fsync → filesystem fsync implementation */
}
```

## Write barriers and persistence

Even after `fsync()` returns, durability depends on the storage device honouring write ordering. The kernel uses **write barriers** to communicate ordering requirements to the block layer.

### `O_SYNC` and `O_DSYNC`

Opening a file with `O_SYNC` makes every `write()` behave like `write()` + `fsync()` — the call does not return until data and metadata have been flushed to durable storage.

`O_DSYNC` is the per-write equivalent of `fdatasync()`: each `write()` flushes data (and size metadata if the file was extended), but not timestamps.

```c
/* O_SYNC: every write is immediately durable */
int fd = open("journal.log", O_WRONLY | O_CREAT | O_SYNC, 0644);
write(fd, record, len);  /* does not return until on disk */

/* O_DSYNC: data durable, mtime may lag */
int fd = open("data.bin", O_WRONLY | O_CREAT | O_DSYNC, 0644);
write(fd, buf, len);  /* data durable; inode mtime may not be */
```

These flags set `IOCB_SYNC` / `IOCB_DSYNC` on the in-kernel `kiocb`, which the filesystem checks after completing the write to decide whether to call `vfs_fsync_range()` inline.

### Flush cache commands

The block layer translates write barrier requirements into storage commands:

| Requirement | SATA/SCSI command | NVMe command |
|-------------|-------------------|--------------|
| Flush write cache | `FLUSH CACHE` | `Flush` |
| Force unit access (per-write) | `FUA` bit on write | `FUA` bit on write |

FUA (Force Unit Access) tells the drive to bypass its write cache for a specific write, avoiding the round-trip cost of a separate flush command. The block layer uses FUA for `O_DSYNC` writes on drives that support it:

```bash
# Check if a drive supports FUA:
cat /sys/block/sda/queue/fua       # 1 = supported
cat /sys/block/nvme0n1/queue/fua   # 1 = supported

# Check write cache status:
hdparm -W /dev/sda                 # 0 = disabled, 1 = enabled
```

### Ordering guarantees summary

```
O_SYNC write:
  write() → page cache → writeback → FLUSH CACHE → return
                                          (or FUA on supported drives)

fsync():
  write() → page cache → return
  ...
  fsync() → writeback of all dirty pages → FLUSH CACHE → return

fdatasync():
  same as fsync() but skips inode timestamp update to journal
```

If a drive has a volatile write cache and write cache is enabled, data written without `O_SYNC`/`fsync()` can be lost on power failure even after `write()` returns — it may still be sitting in the drive's DRAM.

## Observing writeback

```bash
# Real-time dirty page stats:
watch -n1 'grep -E "Dirty|Writeback" /proc/meminfo'

# Per-BDI writeback statistics:
cat /sys/class/bdi/*/stats

# Trace writeback events with ftrace:
echo 1 > /sys/kernel/debug/tracing/events/writeback/enable
cat /sys/kernel/debug/tracing/trace_pipe

# vmstat: see writeback columns (bo = blocks out per second):
vmstat 1

# iostat: see write throughput per device:
iostat -x 1
```

## Further reading

- [Buffered I/O](buffered-io.md) — how the page cache works and how dirty pages are created
- [Direct I/O](direct-io.md) — bypassing the page cache and writeback entirely
- [Async I/O](async-io.md) — io_uring and Linux AIO for non-blocking I/O submission
- `mm/page-writeback.c` — dirty throttling, `balance_dirty_pages()`, `do_writepages()`
- `fs/fs-writeback.c` — `wb_workfn()`, `writeback_inodes_wb()`, `writeback_sb_inodes()`
- `include/linux/backing-dev-defs.h` — `struct bdi_writeback` definition
- `include/linux/writeback.h` — `struct writeback_control`
