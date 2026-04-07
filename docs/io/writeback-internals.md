# Writeback Internals

> A deep dive into how dirty pages get flushed to disk — the per-BDI flusher threads, cgroup-aware writeback, bandwidth estimation, and dirty throttling

See [Page Cache Writeback](page-cache-writeback.md) for a gentler introduction to what writeback is and how to tune its basic knobs. This document covers the **implementation** of the writeback subsystem itself.

## Writeback subsystem overview

The writeback subsystem is responsible for four things:

1. **Tracking dirty inodes** — every inode with dirty pages lives on one of the per-BDI inode lists
2. **Periodically flushing dirty pages** — a per-device kernel worker thread wakes up every few seconds and writes old dirty data to storage
3. **Throttling fast writers** — when a process dirtys pages faster than the device can absorb them, `balance_dirty_pages()` makes it sleep
4. **Fair writeback under cgroups** — in cgroup v2, each memcg/blkcg pair gets its own writeback worker so that one cgroup cannot starve another

The high-level data flow:

```
                     ┌───────────────────────────────────────────────┐
                     │                  write() path                  │
                     │  copy_from_user → page cache → mark folio dirty│
                     └──────────────────────┬────────────────────────┘
                                            │
                             __mark_inode_dirty()
                                            │
                                            ▼
                     ┌──────────────────────────────────────┐
                     │          struct bdi_writeback (wb)    │
                     │  b_dirty list   b_io list   b_more_io │
                     │  write_bandwidth  dirty_ratelimit      │
                     └───────────────┬──────────────────────┘
                                     │
                              wb_workfn() fires
                                     │
                    ┌────────────────▼───────────────────┐
                    │      wb_do_writeback()              │
                    │   writeback_sb_inodes()             │
                    │   __writeback_single_inode()        │
                    │   do_writepages() → a_ops->writepages│
                    └────────────────┬───────────────────┘
                                     │
                              submit_bio()
                                     │
                     ┌───────────────▼──────────────────┐
                     │           block layer             │
                     │  blk-mq → driver → NVMe/SATA/HDD │
                     └──────────────────────────────────┘
```

## struct bdi_writeback: the per-BDI flush worker

Every block device has a `struct backing_dev_info` (BDI). Each BDI owns one or more `struct bdi_writeback` instances — one for the root cgroup, and one per live memcg/blkcg pair when cgroup v2 writeback is in use.

```c
/* include/linux/backing-dev-defs.h */
struct bdi_writeback {
    struct backing_dev_info *bdi;       /* owning BDI */
    unsigned long           state;      /* WB_* state flags */
    unsigned long           last_old_flush; /* timestamp: last kupdate pass */

    /* Inode lists — see "Inode list management" below */
    struct list_head        b_dirty;       /* recently dirtied inodes */
    struct list_head        b_io;          /* inodes being written now */
    struct list_head        b_more_io;     /* inodes needing another pass */
    struct list_head        b_dirty_time;  /* I_DIRTY_TIME-only inodes */
    spinlock_t              list_lock;     /* protects all four lists */

    atomic_t                writeback_inodes; /* inodes under active writeback */

    /* Per-BDI statistics counters (NR_WB_STAT_ITEMS items) */
    struct percpu_counter   stat[NR_WB_STAT_ITEMS];
    /*
     * stat[] indices:
     *   WB_RECLAIMABLE      — dirty pages eligible for reclaim
     *   WB_WRITEBACK        — pages currently under writeback
     *   WB_DIRTIED          — pages dirtied since last reset
     *   WB_WRITTEN          — pages written since last reset
     */

    /* Bandwidth estimation */
    unsigned long           bw_time_stamp;      /* when estimates were last updated */
    unsigned long           dirtied_stamp;       /* pages dirtied at bw_time_stamp */
    unsigned long           written_stamp;       /* pages written at bw_time_stamp */
    unsigned long           write_bandwidth;     /* current instantaneous estimate */
    unsigned long           avg_write_bandwidth; /* exponential moving average */

    /* Dirty rate limiting */
    unsigned long           dirty_ratelimit;          /* target dirty rate for this wb */
    unsigned long           balanced_dirty_ratelimit; /* global-adjusted target */

    struct fprop_local_percpu completions; /* completion events for fprop */
    int                     dirty_exceeded; /* non-zero when above dirty_thresh */
    enum wb_reason          start_all_reason; /* reason for last start_all */

    /* Work queue */
    spinlock_t              work_lock;
    struct list_head        work_list;     /* pending struct wb_writeback_work items */
    struct delayed_work     dwork;         /* wb_workfn — periodic flush worker */
    struct delayed_work     bw_dwork;      /* wb_update_bandwidth_workfn */

    wait_queue_head_t       wait;          /* used by wb_wait_for_completion */

    /* cgroup association (CONFIG_CGROUP_WRITEBACK) */
    struct cgroup_subsys_state *memcg_css; /* memory cgroup */
    struct cgroup_subsys_state *blkcg_css; /* block cgroup */
};
```

Key fields to understand:

- **`state`** carries `WB_*` flags such as `WB_writeback_running` (a flush pass is active) and `WB_has_dirty_io` (there are dirty inodes on the lists).
- **`write_bandwidth` / `avg_write_bandwidth`** are the estimates the throttle algorithm uses. `write_bandwidth` is updated every few seconds; `avg_write_bandwidth` is a longer-horizon smoothed value.
- **`dirty_ratelimit`** is the key output of the bandwidth estimator — it expresses how fast this wb believes the device can absorb writes, and drives the per-process pause duration in `balance_dirty_pages()`.
- **`dwork`** is the `delayed_work` that fires `wb_workfn`. Rescheduling it is how the background flush period (`dirty_writeback_interval`) is implemented.

## Inode dirty tracking

When a page in a file is modified, the kernel calls `__mark_inode_dirty()` to record the fact:

```c
/* fs/fs-writeback.c */
void __mark_inode_dirty(struct inode *inode, int flags)
```

The `flags` argument is a bitmask of:

| Flag | Meaning |
|------|---------|
| `I_DIRTY_SYNC` | Inode metadata needs flushing (`fsync` will wait for this) |
| `I_DIRTY_DATASYNC` | Inode metadata is needed for data integrity (`fdatasync` waits) |
| `I_DIRTY_PAGES` | The inode's page cache has dirty pages |
| `I_DIRTY_TIME` | Only timestamps (atime/mtime/ctime) are dirty — deferred writeback |

The function does the following:

1. **Sets bits in `inode->i_state`** — the dirty flags live here throughout the inode's life.
2. **Selects the correct wb** — for cgroup v2, the inode is charged to the wb that owns the memcg that first dirtied it.
3. **Moves the inode to `wb->b_dirty`** — if it is not already on a wb list.
4. **Calls `wb_wakeup(wb)`** if the global dirty byte count just crossed `dirty_background_thresh` — this wakes the flusher without waiting for the periodic timer.

```c
/* Simplified flow inside __mark_inode_dirty() */

spin_lock(&inode->i_lock);
inode->i_state |= flags;           /* set I_DIRTY_* bits */

if (inode->i_state & I_DIRTY_ALL) {
    struct bdi_writeback *wb = inode_to_wb(inode);  /* cgroup-aware lookup */

    spin_lock(&wb->list_lock);
    if (list_empty(&inode->i_io_list))
        inode->dirtied_when = jiffies;
    list_move(&inode->i_io_list, &wb->b_dirty);     /* onto b_dirty */
    spin_unlock(&wb->list_lock);

    /* Wake flusher if soft threshold crossed */
    if (wb_stat(wb, WB_RECLAIMABLE) > wb->bdi->bg_thresh)
        wb_wakeup(wb);
}
spin_unlock(&inode->i_lock);
```

### I_DIRTY_TIME deferral

Timestamp updates (reads update atime, writes update mtime/ctime) are extremely frequent and cause journal commits on filesystems like ext4. To avoid this overhead, Linux 3.18 ([commit 0ae45f63d4ef](https://git.kernel.org/linus/0ae45f63d4ef)) introduced `I_DIRTY_TIME`: when `relatime` or `lazytime` mount options are active, only the in-memory inode timestamps are updated and the inode is placed on `b_dirty_time` rather than `b_dirty`. The timestamps are flushed when:

- The inode is about to be evicted from memory
- Data writeback happens for the same inode
- More than `dirty_expire_centisecs` have elapsed since the timestamps were last written

## wb_workfn: the periodic flush worker

`wb->dwork` is a `delayed_work` item pointing at `wb_workfn`. It fires every `dirty_writeback_interval` centiseconds (default 500 cs = 5 s). The function is the entry point for all background writeback:

```c
/* fs/fs-writeback.c */
void wb_workfn(struct work_struct *work)
{
    struct bdi_writeback *wb =
        container_of(to_delayed_work(work), struct bdi_writeback, dwork);
    long pages_written;

    set_worker_desc("flush-%s", bdi_dev_name(wb->bdi));
    current->flags |= PF_SWAPWRITE;

    if (likely(!current_is_workqueue_rescuer() ||
               !test_bit(WB_registered, &wb->state))) {
        /*
         * The normal path: drain the work_list first (explicit
         * fsync/sync requests), then do background writeback.
         */
        do {
            pages_written = wb_do_writeback(wb);
        } while (!list_empty(&wb->work_list));
    }

    /*
     * If there is still dirty I/O, reschedule. Otherwise mark
     * ourselves idle — the next dirty inode will wake us.
     */
    if (wb_has_dirty_io(wb) && dirty_writeback_interval)
        wb_wakeup_delayed(wb);
    else
        wb_clear_pending(wb);

    current->flags &= ~PF_SWAPWRITE;
}
```

`wb_workfn` runs in a kernel worker thread from the `writeback` workqueue (`system_freezable_wq` prior to 5.16, dedicated `writeback` wq after). You can see it in `ps` or `top` as `[kworker/u...:flush-8:0]` or similar.

### wb_do_writeback

`wb_do_writeback` drains the explicit `work_list` first (items injected by `fsync()`, `sync()`, memory pressure), then performs periodic and kupdate writeback:

```c
/* fs/fs-writeback.c (simplified) */
static long wb_do_writeback(struct bdi_writeback *wb)
{
    struct wb_writeback_work *work;
    long wrote = 0;

    /* Drain explicitly queued work items */
    while ((work = get_next_work_item(wb)) != NULL) {
        wrote += wb_writeback(wb, work);
        finish_writeback_work(wb, work);
    }

    /* Periodic writeback: flush old (time-expired) dirty pages */
    wrote += wb_check_old_data_flush(wb);

    /* Background writeback: flush if above background threshold */
    wrote += wb_check_background_flush(wb);

    return wrote;
}
```

### wb_writeback: the main flush loop

`wb_writeback` is the core function. It moves inodes from `b_dirty` to `b_io` and then calls `writeback_sb_inodes` for each superblock with dirty inodes:

```c
/* fs/fs-writeback.c (simplified) */
static long wb_writeback(struct bdi_writeback *wb,
                          struct wb_writeback_work *work)
{
    long wrote = 0;
    unsigned long oldest_jif;
    struct inode *inode;

    oldest_jif = jiffies -
        msecs_to_jiffies(dirty_expire_centisecs * 10);

    /* Move inodes from b_dirty → b_io */
    spin_lock(&wb->list_lock);
    queue_io(wb, work, oldest_jif);
    spin_unlock(&wb->list_lock);

    /* Walk the b_io list, writing one superblock at a time */
    while (!list_empty(&wb->b_io)) {
        struct super_block *sb =
            wb_inode(wb->b_io.prev)->i_sb;

        wrote += writeback_sb_inodes(sb, wb, work);

        if (wrote >= work->nr_pages || work_done(work))
            break;
    }

    return wrote;
}
```

`queue_io` moves inodes from `b_dirty` to `b_io` in age order — oldest-dirtied first. Inodes on `b_more_io` (partially written) are prepended so they finish before new work starts.

## writeback_sb_inodes: writing dirty inodes

Once `b_io` is populated, `writeback_sb_inodes` iterates it and calls `__writeback_single_inode` for each inode belonging to the given superblock:

```c
/* fs/fs-writeback.c (simplified) */
static long writeback_sb_inodes(struct super_block *sb,
                                 struct bdi_writeback *wb,
                                 struct wb_writeback_work *work)
{
    long wrote = 0;

    while (!list_empty(&wb->b_io)) {
        struct inode *inode = wb_inode(wb->b_io.prev);

        if (inode->i_sb != sb) {
            /* This superblock is done; let the caller find the next one */
            redirty_tail_locked(inode, wb);
            break;
        }

        spin_lock(&inode->i_lock);

        /* Skip inodes locked by another writeback pass */
        if (inode->i_state & I_SYNC) {
            spin_unlock(&inode->i_lock);
            requeue_io(inode, wb);
            continue;
        }

        __inode_wait_for_writeback(inode); /* WB_SYNC_ALL only */

        /* Set I_SYNC to lock this inode against concurrent writeback */
        inode->i_state |= I_SYNC;
        spin_unlock(&inode->i_lock);

        wrote += __writeback_single_inode(inode, &wbc);

        /*
         * Did we write everything, or is there more to do?
         * If wbc.nr_to_write > 0 after the call, the inode is
         * fully written and moves off the list.
         * If nr_to_write <= 0, we hit the page budget and the
         * inode goes to b_more_io for the next pass.
         */
        requeue_inode(inode, wb, &wbc);
    }

    return wrote;
}
```

### __writeback_single_inode

This function writes both the inode's dirty pages and the inode metadata:

```c
/* fs/fs-writeback.c (simplified) */
static int __writeback_single_inode(struct inode *inode,
                                     struct writeback_control *wbc)
{
    struct address_space *mapping = inode->i_mapping;
    long nr_to_write = wbc->nr_to_write;
    int ret;

    /* 1. Write dirty pages via the address_space ops */
    ret = do_writepages(mapping, wbc);

    /*
     * 2. If WB_SYNC_ALL: wait for all submitted pages to complete.
     *    This is what makes fsync() wait for I/O.
     */
    if (wbc->sync_mode == WB_SYNC_ALL) {
        int err = filemap_fdatawait_range(mapping, 0, LLONG_MAX);
        if (!ret)
            ret = err;
    }

    /* 3. Write the inode itself (metadata) */
    if (inode->i_state & I_DIRTY_ALL) {
        ret = write_inode(inode, wbc);
        /* → sb->s_op->write_inode() → filesystem implementation */
    }

    /* 4. Clear dirty flags that have been flushed */
    spin_lock(&inode->i_lock);
    inode->i_state &= ~I_SYNC;
    inode_sync_complete(inode);
    spin_unlock(&inode->i_lock);

    return ret;
}
```

The complete call chain from `wb_workfn` down to the block layer:

```
wb_workfn()
  └── wb_do_writeback()
        ├── wb_check_old_data_flush()   (kupdate path)
        └── wb_writeback()
              └── writeback_sb_inodes()          fs/fs-writeback.c
                    └── __writeback_single_inode()
                          └── do_writepages()    mm/page-writeback.c
                                └── a_ops->writepages()
                                      ├── ext4_writepages()     (jbd2 journal commit)
                                      ├── xfs_vm_writepages()   (iomap-based)
                                      └── btrfs_writepages()    (extent-based)
                                            └── iomap_writepages() / mpage_writepages()
                                                  └── submit_bio()
                                                        └── blk-mq → driver → storage
```

## struct wb_writeback_work: work items

All writeback requests are expressed as `struct wb_writeback_work` items placed on `wb->work_list`. The key fields:

```c
/* fs/fs-writeback.c */
struct wb_writeback_work {
    long                   nr_pages;    /* page budget for this work item */
    struct super_block    *sb;          /* NULL = all superblocks */
    enum writeback_sync_modes sync_mode;
    unsigned int           tagged_writepages:1;
    unsigned int           for_kupdate:1;    /* time-expired writeback */
    unsigned int           range_cyclic:1;   /* cycle through file offsets */
    unsigned int           for_background:1; /* background soft-limit writeback */
    unsigned int           for_sync:1;       /* sync() / fsync() triggered */
    unsigned int           auto_free:1;      /* free work item when done */
    enum wb_reason         reason;           /* WB_REASON_* for tracing */
    struct list_head       list;
    struct wb_completion  *done;             /* completion to signal when finished */
};
```

Different triggers create work items with different parameters:

| Trigger | `sync_mode` | `nr_pages` | `for_*` flag |
|---------|------------|-----------|-------------|
| Periodic background (`dirty_writeback_interval`) | `WB_SYNC_NONE` | `LONG_MAX` | `for_background` |
| kupdate (pages older than `dirty_expire_centisecs`) | `WB_SYNC_NONE` | pages in age window | `for_kupdate` |
| Memory pressure (`wakeup_flusher_threads`) | `WB_SYNC_NONE` | requested pages | — |
| `fsync()` | `WB_SYNC_ALL` | all file pages | `for_sync` |
| `sync()` | `WB_SYNC_ALL` | `LONG_MAX` | `for_sync` |

`WB_SYNC_ALL` means `__writeback_single_inode` will call `filemap_fdatawait_range` to wait for each page's writeback bio to complete before returning. `WB_SYNC_NONE` submits bios but does not wait — the caller gets an async fire-and-forget flush.

### struct writeback_control

`writeback_control` is the per-call context passed from `wb_writeback` down through `writeback_sb_inodes` and into the filesystem's `writepages` handler:

```c
/* include/linux/writeback.h */
struct writeback_control {
    long                    nr_to_write;     /* pages budget; decremented as pages are written */
    long                    pages_skipped;   /* pages that were skipped (locked, etc.) */
    loff_t                  range_start;     /* byte offset range to flush */
    loff_t                  range_end;
    enum writeback_sync_modes sync_mode;     /* WB_SYNC_NONE or WB_SYNC_ALL */
    unsigned                for_kupdate:1;
    unsigned                for_background:1;
    unsigned                for_reclaim:1;   /* called from page reclaim path */
    unsigned                range_cyclic:1;  /* cycle through the file using writeback_index */
    unsigned                for_sync:1;
    unsigned                unpinned_fscache_wb:1;
    unsigned                no_cgroup_owner:1;
    struct folio_batch      fbatch;          /* folios to submit together */
    pgoff_t                 writeback_index; /* where to resume in range_cyclic mode */
    int                     saved_err;
};
```

`nr_to_write` is decremented by one for each page submitted. When it reaches zero, `writepages` returns and the inode is requeued on `b_more_io`. This is how the kernel bounds the amount of work done per `wb_workfn` invocation.

## Dirty throttling: balance_dirty_pages()

The throttling path is invoked from the write fast path after every `write_end`. Rather than calling `balance_dirty_pages()` on every write, the kernel uses a per-task rate limiter:

```c
/* mm/page-writeback.c */
void balance_dirty_pages_ratelimited(struct address_space *mapping)
{
    struct inode *inode = mapping->host;
    struct bdi_writeback *wb = inode_to_wb(inode);
    int ratelimit;

    ratelimit = current->nr_dirtied_pause;
    if (atomic_long_read(&wb->bdi->tot_write_bandwidth))
        /* Scale sampling interval by write speed */
        ratelimit = min(ratelimit, 32);

    if (--current->nr_dirtied_pause <= 0) {
        balance_dirty_pages(mapping, wb, current->nr_dirtied);
        current->nr_dirtied = 0;
    }
}
```

The `nr_dirtied_pause` value is recomputed by `balance_dirty_pages` at the end of each throttle event. It is derived from `dirty_ratelimit` so that faster storage gives larger batches between checks.

### The throttle algorithm in balance_dirty_pages

```c
/* mm/page-writeback.c (conceptual) */
static void balance_dirty_pages(struct address_space *mapping,
                                  struct bdi_writeback *wb,
                                  unsigned long pages_dirtied)
{
    unsigned long nr_dirty, nr_writeback;
    unsigned long dirty_thresh, background_thresh;
    long pause;

    for (;;) {
        /* 1. Compute current dirty counts */
        nr_dirty    = global_node_page_state(NR_FILE_DIRTY);
        nr_writeback = global_node_page_state(NR_WRITEBACK);

        /* 2. Compute thresholds from sysctl + available memory */
        global_dirty_limits(&background_thresh, &dirty_thresh);

        /* 3. Wake background flusher if above soft limit */
        if (nr_dirty > background_thresh)
            wb_start_background_writeback(wb);

        /* 4. If below hard limit, no need to throttle */
        if (nr_dirty + nr_writeback <= dirty_thresh)
            break;

        /* 5. Compute how long to sleep */
        pause = dirty_poll_interval(nr_dirty, dirty_thresh);

        /* 6. Sleep in D state (TASK_UNINTERRUPTIBLE) */
        __set_current_state(TASK_UNINTERRUPTIBLE);
        io_schedule_timeout(pause);

        /* 7. Loop — re-evaluate after waking */
    }

    /*
     * Update nr_dirtied_pause for next call.
     * Faster storage → higher ratelimit → fewer balance checks per MB written.
     */
    current->nr_dirtied_pause =
        dirty_ratelimit_pages(wb, dirty_thresh, background_thresh);
}
```

The pause duration is not fixed. It scales proportionally with how far the dirty count exceeds `dirty_thresh` — a small overage causes a short sleep, a large overage causes a long sleep. This provides a smooth proportional-control response rather than a hard on/off gate.

### Threshold computation

The global thresholds (`dirty_thresh` and `background_thresh`) are computed in `global_dirty_limits()`:

```c
void global_dirty_limits(unsigned long *pbackground, unsigned long *pdirty)
{
    unsigned long available_memory = global_dirtyable_memory();

    /* vm.dirty_background_ratio / vm.dirty_background_bytes */
    *pbackground = vm_dirty_background_bytes
        ? DIV_ROUND_UP(vm_dirty_background_bytes, PAGE_SIZE)
        : (dirty_background_ratio * available_memory) / 100;

    /* vm.dirty_ratio / vm.dirty_bytes */
    *pdirty = vm_dirty_bytes
        ? DIV_ROUND_UP(vm_dirty_bytes, PAGE_SIZE)
        : (vm_dirty_ratio * available_memory) / 100;
}
```

`global_dirtyable_memory()` is not just total RAM — it excludes pages reserved for the kernel, huge page pools, and other non-reclaimable memory. This means the effective dirty limit is often lower than `dirty_ratio * total_RAM`.

## Bandwidth estimation and dirty_ratelimit

The writeback subsystem continuously estimates how fast each wb can absorb writes. This estimate drives `dirty_ratelimit` — the per-wb target write rate — which in turn determines how long `balance_dirty_pages` makes processes sleep.

### write_bandwidth: instantaneous estimate

`write_bandwidth` is updated by `wb_update_write_bandwidth()`, called from the `bw_dwork` delayed work item every `BANDWIDTH_INTERVAL` jiffies (roughly every 200 ms):

```c
/* mm/page-writeback.c (simplified) */
static void wb_update_write_bandwidth(struct bdi_writeback *wb,
                                       unsigned long elapsed,
                                       unsigned long written)
{
    /*
     * Exponential moving average with weight 1/8:
     *   new_bw = old_bw * 7/8 + current_bw * 1/8
     *
     * This gives ~1.5 second time constant, tracking recent throughput
     * while damping short-term spikes.
     */
    unsigned long bw = written * HZ / elapsed;   /* pages/second */

    wb->write_bandwidth = bw;
    wb->avg_write_bandwidth =
        (wb->avg_write_bandwidth * 7 + bw) / 8;

    wb->written_stamp = wb->bdi->tot_write_bandwidth;
    wb->bw_time_stamp = jiffies;
}
```

### dirty_ratelimit: target dirty rate

`dirty_ratelimit` is the rate at which this wb would like processes to dirty pages. It is updated in `wb_update_dirty_ratelimit()`:

```
                 write_bandwidth
dirty_ratelimit = ────────────────────────── × setpoint_frac
                  global_pages / bdi_pages

where setpoint_frac = (dirty_thresh - background_thresh) / dirty_thresh
```

The intuition: if the device can write 100 MB/s and the wb owns half the dirty pages, its target rate is 50 MB/s. If the dirty level is halfway between `background_thresh` and `dirty_thresh`, the target rate is scaled down to reduce the chance of hitting the hard limit.

`balanced_dirty_ratelimit` is a further-smoothed version of `dirty_ratelimit` that reduces oscillation:

```c
wb->balanced_dirty_ratelimit =
    (wb->balanced_dirty_ratelimit * 7 +
     wb->dirty_ratelimit) / 8;
```

### Per-task pause computation

From `balanced_dirty_ratelimit`, the per-task pause between dirty checks is:

```
task_ratelimit = balanced_dirty_ratelimit * task_bw / wb_bw
pause_jiffies  = nr_dirtied_pause * HZ / task_ratelimit
```

A task that dirtied pages at a rate equal to `task_ratelimit` will pause for exactly `HZ / task_ratelimit` jiffies per page — on average keeping the dirty rate at the target. A task writing slower gets a proportionally shorter pause (or no pause at all).

## Cgroup-aware writeback (cgroup v2)

Since Linux 4.0, the writeback subsystem is fully cgroup-aware when using cgroup v2 with both `memory` and `io` controllers enabled.

### Architecture

Without cgroup writeback, all inodes for a given BDI share a single `bdi_writeback`. With cgroup writeback:

```
backing_dev_info
  ├── wb (root cgroup)          memcg=root, blkcg=root
  ├── wb_memcg1_blkcg1         memcg=cg1,  blkcg=blkcg1
  ├── wb_memcg2_blkcg1         memcg=cg2,  blkcg=blkcg1
  └── wb_memcg2_blkcg2         memcg=cg2,  blkcg=blkcg2
```

Each wb is a separate kernel worker with its own bandwidth estimate, dirty ratelimit, and inode lists.

### inode-to-wb assignment

When a page is first dirtied, `inode_to_wb_and_lock_list()` determines the correct wb:

1. Check `inode->i_wb` — if already assigned and the memcg still matches, use it.
2. Call `wb_get_create()` to find or create the wb for the current task's memcg/blkcg pair.
3. Store the result in `inode->i_wb` for future dirtying of the same inode.

An inode's wb can change when the last dirty page is written back and the inode is re-dirtied by a different memcg. This is the **inode writeback ownership transfer** mechanism (`inode_switch_wbs()`).

### cgroup writeback lifecycle

```c
/* Called when a new memcg or blkcg cgroup is created */
void wb_memcg_online(struct mem_cgroup *memcg);
void wb_blkcg_online(struct blkcg *blkcg);

/* Called when a cgroup is destroyed */
void wb_memcg_offline(struct mem_cgroup *memcg);
void wb_blkcg_offline(struct blkcg *blkcg);
```

`wb_memcg_online` iterates all BDIs and pre-creates a wb for the new memcg paired with each BDI's blkcg. `wb_memcg_offline` switches inodes belonging to the dying memcg's wb back to the root wb.

### Fairness with io.weight

Because each cgroup's dirty pages are tracked in its own wb, the block layer's `io.weight` knob applies naturally: when multiple wbs issue bios to the same device, blk-mq applies proportional weights at the scheduling level. A cgroup with `io.weight=100` receives twice the writeback bandwidth of one with `io.weight=50`.

Without cgroup writeback, a single greedy writer in one cgroup could consume the entire write_bandwidth budget and starve others — even though `io.weight` would apply to its bios at submission time, the dirty throttling feedback loop would be global and insensitive to the per-cgroup allocation.

## Inode list management

Each `bdi_writeback` maintains four lists. Understanding how inodes move between them is essential for reading writeback traces and diagnosing performance issues:

```
                      __mark_inode_dirty()
                              │
                              ▼
                  ┌──────── b_dirty ────────┐
                  │  recently dirtied inodes │
                  │  (ordered by dirtied_when│
                  │   oldest at list tail)   │
                  └───────────┬─────────────┘
                              │
                     queue_io() in wb_writeback()
                     (moves inodes older than
                      dirty_expire_centisecs)
                              │
                              ▼
                  ┌──────── b_io ───────────┐
                  │  inodes being written    │
                  │  now; b_more_io inodes   │
                  │  prepended at the front  │
                  └─────┬───────────┬────────┘
                        │           │
               fully written    nr_to_write
               (I_SYNC cleared)  budget exhausted
                        │           │
                        ▼           ▼
                  inode removed  ┌────────────────┐
                  from list      │  b_more_io     │
                                 │  partially     │
                                 │  written inodes│
                                 └────────────────┘

                  ┌─────────────────────────────┐
                  │  b_dirty_time               │
                  │  I_DIRTY_TIME-only inodes   │
                  │  (lazytime / relatime)       │
                  └─────────────────────────────┘
```

**b_dirty**: The primary queue. All newly dirtied inodes land here via `__mark_inode_dirty`. Ordered by `dirtied_when` timestamp with the oldest at the tail.

**b_io**: The active write queue. `queue_io()` bulk-moves inodes from `b_dirty` to `b_io` when their dirty age exceeds `dirty_expire_centisecs`, or unconditionally for background writeback. Inodes from `b_more_io` are moved to the front of `b_io` so partial writes are finished before new ones begin.

**b_more_io**: Inodes that were partially written (their `nr_to_write` budget ran out before all dirty pages were submitted). They wait here until `queue_io` is called again.

**b_dirty_time**: Inodes with only `I_DIRTY_TIME` set. These are not written by normal writeback passes; `wb_writeback` skips them unless `for_sync` is set or the inode is being evicted.

## writeback tracing

The kernel exports a rich set of tracepoints in the `writeback:` subsystem. Enable them via ftrace or perf:

```bash
# Enable all writeback tracepoints via ftrace
echo 1 > /sys/kernel/debug/tracing/events/writeback/enable
cat /sys/kernel/debug/tracing/trace_pipe

# Or selectively:
echo 1 > /sys/kernel/debug/tracing/events/writeback/writeback_written/enable
echo 1 > /sys/kernel/debug/tracing/events/writeback/global_dirty_state/enable
echo 1 > /sys/kernel/debug/tracing/events/writeback/balance_dirty_pages/enable
```

Key tracepoints:

| Tracepoint | Fires when | Useful fields |
|------------|-----------|---------------|
| `writeback_start` | `wb_writeback()` begins a pass | `bdi`, `nr_pages`, `reason` |
| `writeback_written` | `wb_writeback()` completes a pass | `bdi`, `nr_pages`, `pages_written` |
| `writeback_wait` | `WB_SYNC_ALL` pass waits for I/O | `bdi`, `nr_pages` |
| `writeback_pages_written` | after each inode's pages are written | `bdi`, `written` |
| `global_dirty_state` | inside `balance_dirty_pages` each loop | `nr_dirty`, `nr_writeback`, `background_thresh`, `dirty_thresh`, `dirty_limit` |
| `balance_dirty_pages` | each throttle event | `bdi`, `limit`, `setpoint`, `dirty`, `bdi_dirty`, `write_bw`, `avg_write_bw`, `dirty_ratelimit`, `task_ratelimit`, `dirtied`, `period`, `think`, `pause` |
| `writeback_sb_inodes_requeue` | inode moved to b_more_io | `bdi`, `ino`, `state`, `dirtied_when` |
| `writeback_queue` | work item enqueued on wb | `bdi`, `reason` |

### bpftrace recipes

```bash
# Show per-device writeback throughput every second
bpftrace -e '
tracepoint:writeback:writeback_written {
    @written[args->name] = sum(args->pages_written);
}
interval:s:1 {
    print(@written);
    clear(@written);
}'

# Show processes being throttled and their pause duration (ms)
bpftrace -e '
tracepoint:writeback:balance_dirty_pages {
    printf("%-20s pid=%-6d pause=%-5d dirty=%-8d thresh=%-8d rate=%-8d\n",
        comm, pid,
        args->pause,
        args->dirty,
        args->limit,
        args->task_ratelimit);
}'

# Histogram of throttle pause durations
bpftrace -e '
tracepoint:writeback:balance_dirty_pages {
    @pause_ms = hist(args->pause);
}
END { print(@pause_ms); }'

# Track inode writeback latency
bpftrace -e '
tracepoint:writeback:writeback_start  { @start[args->name] = nsecs; }
tracepoint:writeback:writeback_written {
    if (@start[args->name]) {
        @lat_us[args->name] = hist((nsecs - @start[args->name]) / 1000);
        delete(@start[args->name]);
    }
}'
```

### /proc/vmstat writeback counters

```bash
# One-shot writeback stats from /proc/vmstat
grep -E 'dirty|writeback|written' /proc/vmstat

# Key fields:
#   nr_dirty             — pages currently dirty
#   nr_writeback         — pages currently under writeback I/O
#   nr_writeback_temp    — dirty pages claimed by NFS unstable writes
#   nr_written           — total pages written since boot
#   nr_dirty_threshold   — current dirty_thresh in pages
#   nr_dirty_background_threshold  — current background_thresh in pages
```

## /sys/class/bdi knobs

Each BDI exposes tuning knobs under `/sys/class/bdi/<major:minor>/`:

```bash
ls /sys/class/bdi/8:0/
# max_ratio  min_ratio  min_bytes  max_bytes  stable_pages_required  read_ahead_kb  ...
```

| Knob | Default | Description |
|------|---------|-------------|
| `max_ratio` | 100 | Cap this BDI's writeback bandwidth as a percentage of the global dirty limit. Useful for slow network filesystems that should not consume the entire dirty budget. |
| `min_ratio` | 0 | Guarantee this BDI at least this percentage of the global dirty budget. Useful for latency-sensitive devices that need guaranteed write throughput. |
| `max_bytes` | 0 | Like `max_ratio` but expressed as an absolute byte count. Overrides `max_ratio` when non-zero. |
| `min_bytes` | 0 | Like `min_ratio` in bytes. |
| `stable_pages_required` | 0 | If 1, page data must not change during writeback (required by some network filesystems that compute checksums during writeback). When set, the kernel copies page data before writing rather than writing directly from the live page. |
| `read_ahead_kb` | device-dependent | Readahead window; not writeback-specific but lives here for convenience. |

Example: limit a slow USB drive to 5% of the global dirty budget so it does not starve faster devices:

```bash
echo 5 > /sys/class/bdi/$(lsblk -no MAJ:MIN /dev/sdb | head -1)/max_ratio
```

## Key source files

| File | Contents |
|------|----------|
| `fs/fs-writeback.c` | `wb_workfn`, `wb_writeback`, `writeback_sb_inodes`, `__writeback_single_inode`, `__mark_inode_dirty`, cgroup wb management |
| `mm/page-writeback.c` | `balance_dirty_pages`, `balance_dirty_pages_ratelimited`, `wb_update_write_bandwidth`, `wb_update_dirty_ratelimit`, `do_writepages`, `global_dirty_limits` |
| `mm/backing-dev.c` | BDI registration/unregistration, `wb_init`, `wb_shutdown`, sysfs knobs |
| `include/linux/backing-dev-defs.h` | `struct bdi_writeback`, `struct backing_dev_info` |
| `include/linux/writeback.h` | `struct writeback_control`, `enum writeback_sync_modes`, `WB_REASON_*` |
| `include/linux/fs.h` | `I_DIRTY_*` flags in `inode->i_state`, `struct address_space` |
| `block/blk-cgroup.c` | blkcg integration; `io.weight` and related cgroup knobs |

## Further reading

- [Page Cache Writeback](page-cache-writeback.md) — introduction to dirty pages, thresholds, and `fsync` vs `fdatasync`
- [Buffered I/O](buffered-io.md) — how `write()` populates the page cache and triggers `__mark_inode_dirty`
- [Address Space Operations](address-space-ops.md) — the `writepages` and `dirty_folio` callbacks that connect writeback to the filesystem
- [Life of a write](life-of-a-write.md) — end-to-end trace of a `write()` syscall including the throttle path
- [Observability](observability.md) — broader guide to I/O observability tools including ftrace and bpftrace
- Jens Axboe, "Optimizing Linux writeback", LWN.net (2007)
- Jan Kara, "Writeback and memory management", Kernel Summit (2010)
- Wu Fengguang, "BDI writeback", Linux kernel documentation `Documentation/admin-guide/mm/concepts.rst`
