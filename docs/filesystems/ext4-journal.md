# ext4 Journaling and Crash Recovery

> JBD2 transaction lifecycle: how ext4 survives power failures

## Why journaling?

Without journaling, a power failure mid-write can leave the filesystem in an inconsistent state:

```
Without journal:
  1. Write inode (update file size)          ← power fail here
  2. Write data block
  3. Update block bitmap

After crash: file has new size but block bitmap says block is free.
fsck must scan the entire filesystem to find and fix inconsistencies.
On a 4TB filesystem: hours.
```

With journaling, changes are written to the **journal** (a circular log) first. After crash, the kernel replays the journal in seconds.

## ext4 journal modes

```bash
# Check/set journal mode at mount time:
mount -o data=ordered /dev/sda1 /mnt   # default
mount -o data=writeback /dev/sda1 /mnt  # highest performance
mount -o data=journal /dev/sda1 /mnt    # most durable
```

| Mode | What's journaled | Performance | Durability |
|------|-----------------|-------------|-----------|
| `writeback` | Metadata only; data can be written after metadata | Fastest | Data may be corrupted after crash |
| `ordered` | Metadata only; **data written before metadata** | Good | Data blocks committed before metadata |
| `journal` | Both metadata and data | Slowest | Strongest |

Default is `ordered`: metadata changes are atomic, data blocks are guaranteed to be written before the metadata that references them.

## JBD2: the journaling layer

ext4 uses JBD2 (Journaling Block Device 2) as its journaling layer. JBD2 is independent of ext4 — it could journal any block device.

### Journal layout on disk

```
Ext4 partition layout:
┌────────────────────────────────────────────────────┐
│ Superblock │ Block groups │ Journal (special inode) │
│            │ [ext4 data]  │ [JBD2 circular log]     │
└────────────────────────────────────────────────────┘

Journal structure (circular log):
┌──────────────────────────────────────────────────────────┐
│ Journal superblock │ T1: [commit block] │ T2: [commit] │..│
│ (seq, tail_sequence, s_start)                            │
└──────────────────────────────────────────────────────────┘

T1 (transaction 1):
  ┌─────────────────────────────────────────────────────┐
  │ descriptor block │ data/metadata blocks │ commit block│
  │ (lists what blocks follow) │ (original blocks) │ (seq #)│
  └─────────────────────────────────────────────────────┘
```

The journal superblock records `s_start` (tail) and `s_sequence` (current transaction). Recovery replays all transactions from `s_start` to the last valid commit block.

### struct journal_t

```c
/* include/linux/jbd2.h */
typedef struct journal_s {
    /* Journal superblock data */
    unsigned long   j_flags;        /* JBD2_UNMOUNT, JBD2_ABORT, ... */
    int             j_errno;
    struct buffer_head *j_sb_buffer; /* journal superblock buffer */

    /* Transaction state */
    transaction_t  *j_running_transaction;    /* current open transaction */
    transaction_t  *j_committing_transaction; /* being committed */
    transaction_t  *j_checkpoint_transactions; /* not yet freed */

    /* Journal block range */
    unsigned int    j_maxlen;       /* total journal blocks */
    unsigned int    j_tail;         /* oldest known transaction */
    unsigned int    j_free;         /* free journal blocks */
    unsigned int    j_first;        /* journal start block */
    unsigned int    j_last;         /* journal end block (exclusive) */
    unsigned int    j_head;         /* current write position */

    /* Sequence numbers */
    tid_t           j_tail_sequence;
    tid_t           j_transaction_sequence;
    tid_t           j_commit_sequence;
    tid_t           j_commit_request;

    /* Block device */
    struct block_device *j_dev;     /* journal device */
    struct block_device *j_fs_dev;  /* filesystem device */
    unsigned int        j_blocksize;

    /* kjournald kernel thread */
    struct task_struct *j_task;

    /* Commit timer and workqueue */
    struct timer_list   j_commit_timer;
} journal_t;
```

### struct transaction_t

```c
typedef struct transaction_s {
    journal_t      *t_journal;
    tid_t           t_tid;          /* transaction ID */
    enum {
        T_RUNNING,          /* accepting new handles */
        T_LOCKED,           /* waiting for handles to close */
        T_SWITCH,
        T_FLUSH,
        T_COMMIT,
        T_COMMIT_DFLUSH,
        T_COMMIT_JFLUSH,
        T_FINISHED,
    } t_state;

    struct list_head t_buffers;      /* buffers modified in this transaction */
    struct list_head t_forget;       /* buffers to unlink after commit */
    struct list_head t_checkpoint_list; /* buffers needing checkpoint */

    handle_t       *t_handle_count; /* number of open handles */
    unsigned int    t_outstanding_credits; /* remaining journal space */
} transaction_t;
```

## Transaction lifecycle

### Phase 1: begin

```c
/* Start a transaction */
handle_t *handle = jbd2_journal_start(journal, nblocks);
/* nblocks: worst-case blocks this handle will modify */
/* Returns a handle; increments t_handle_count */
```

### Phase 2: modify buffers

```c
/* Tell JBD2 we're about to modify a buffer (gets the journal credit): */
jbd2_journal_get_write_access(handle, bh);
/* Adds bh to the transaction's t_buffers list */
/* Copies the original block to the journal buffer */

/* Modify the buffer: */
ext4_set_bit(block, group->bg_block_bitmap->b_data);

/* Tell JBD2 the modification is complete: */
jbd2_journal_dirty_metadata(handle, bh);
/* Marks bh as dirty in the transaction */
```

### Phase 3: commit (kjournald)

```c
/* kjournald thread (fs/jbd2/journal.c) */
static int kjournald2(void *arg)
{
    journal_t *journal = arg;
    transaction_t *transaction;

    for (;;) {
        /* Wait for commit needed or timer */
        wait_event_interruptible_timeout(journal->j_wait_commit, ...);

        /* Commit the current transaction */
        jbd2_journal_commit_transaction(journal);
    }
}
```

Commit phases:
1. **Close**: stop accepting new handles for this transaction (T_LOCKED)
2. **Write descriptor**: write the descriptor block listing all modified buffers
3. **Write data**: write all modified metadata buffers to the journal
4. **Flush**: wait for all journal writes to complete
5. **Write commit block**: write the commit block with the transaction's sequence number
6. **Checkpoint**: once the commit block is on disk, the filesystem blocks can be written in place
7. **Free**: after checkpoint, free journal space

### Phase 4: checkpoint

After committing, the original filesystem blocks must be written out (checkpointed) before the journal space can be reused:

```c
/* The transaction's modified blocks are eventually written to
   their real filesystem locations (checkpointed) */
jbd2_log_do_checkpoint(journal);

/* After checkpoint: journal space is freed for the next transaction */
```

## Crash recovery

```bash
# View journal state
debugfs -R "show_super_stats" /dev/sda1 | grep -i journal
# Journal inode: 8
# Journal backup: inode blocks
# Journal features: journal_64bit, journal_fast_commit
# Journal size: 128m
# Journal length: 32768

# Replay journal manually (dry run):
e2fsck -n /dev/sda1 2>&1 | head -20
# Pass 1: Checking inodes, blocks, and sizes
# Pass 2: Checking directory structure
# ...
```

### Kernel journal recovery

```c
/* fs/jbd2/recovery.c */
int jbd2_journal_recover(journal_t *journal)
{
    struct recovery_info info = {};

    /* Scan the journal for all valid transactions */
    err = do_one_pass(journal, &info, PASS_SCAN);
    /* Finds all committed transactions: info.end_transaction */

    /* Replay valid transactions: write blocks to their real locations */
    err = do_one_pass(journal, &info, PASS_REVOKE);
    /* Applies revoke records (blocks that were freed and shouldn't be replayed) */

    err = do_one_pass(journal, &info, PASS_REPLAY);
    /* Replays remaining transactions to their real filesystem locations */

    jbd2_journal_clear_revoke(journal);
    err = sync_blockdev(journal->j_fs_dev);
    return err;
}
```

Recovery is **O(journal size)**, not O(filesystem size). Even a 2TB filesystem recovers in seconds because only the journal (default 128MB) is replayed.

## Fast commit (ext4 5.10+)

JBD2 full commits are expensive (hundreds of microseconds). **Fast commit** is an optimized path for common operations:

```c
/* fs/ext4/fast_commit.c */
/* Fast commit records only what changed (delta), not full blocks: */
/* - Inode changes (truncate, setattr)           */
/* - Directory entry changes (create, unlink)    */

/* Much smaller journal writes: ~1KB vs ~4KB per commit */
```

```bash
# Enable fast commit (default on new ext4 filesystems):
tune2fs -O fast_commit /dev/sda1
mke2fs -O fast_commit /dev/sda1

# Check:
tune2fs -l /dev/sda1 | grep "Filesystem features"
# Filesystem features: fast_commit ...
```

## ext4 journaling vs fsync

```c
/* Application: ensure data durability */
fd = open("file", O_WRONLY);
write(fd, data, len);
fsync(fd);     /* blocks until data AND metadata are on disk */
/* Without fsync: data may be in page cache or journal, not disk */

/* fdatasync: data only (no metadata unless file size changed) */
fdatasync(fd);

/* O_SYNC: fsync after every write */
fd = open("file", O_WRONLY | O_SYNC);
```

The journal only guarantees metadata consistency after crash. Data durability requires `fsync()` or `O_SYNC`.

## Monitoring journal performance

```bash
# Journal statistics
cat /proc/fs/ext4/<dev>/journal_info
# journal_sequence: 12345
# journal_buffers: 0
# journal_outstanding: 0

# Trace journal commits
bpftrace -e '
kprobe:jbd2_journal_commit_transaction {
    @commits = count();
    @time_ns = hist(nsecs);
}'

# iostat: journal writes appear as writes to the same device
iostat -x 1

# blktrace: see journal vs data writes
blktrace -d /dev/sda1 -o - | blkparse -i - | grep -v "Q  W" | head -50
```

## Further reading

- [ext4](ext4.md) — ext4 architecture and disk layout
- [Life of a write() Syscall](../vfs/life-of-write.md) — write path ending at JBD2
- [Page Cache](../mm/page-cache.md) — dirty pages that JBD2 journals
- [IOMMU DMA](../mm/dma.md) — journal I/O uses DMA
- `fs/jbd2/` — JBD2 implementation
- `fs/ext4/` — ext4 JBD2 integration
- `Documentation/filesystems/ext4/` — ext4 on-disk format
