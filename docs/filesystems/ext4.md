# ext4

> The default Linux filesystem: journaled, extent-based, battle-tested. Developed by Theodore Ts'o, Andreas Dilger, Alex Tomas, and others; merged as stable in Linux 2.6.28.

## On-disk layout

An ext4 filesystem is divided into **block groups**. Each block group contains:

```
Block Group 0:
┌─────────────────────────────────────────────────────────────────┐
│ Super-   │ Group     │ Block    │ Inode    │ Inode │ Data       │
│ block    │ Descriptor│ Bitmap   │ Bitmap   │ Table │ Blocks     │
│ (1 block)│ Table     │ (1 block)│ (1 block)│       │            │
└─────────────────────────────────────────────────────────────────┘

Superblock: copies in groups 0, 1, 3^n, 5^n, 7^n (backup)
```

```bash
# Inspect filesystem layout
dumpe2fs /dev/sda1 | head -80
# Inode count:              2621440
# Block count:              10485760
# Block size:               4096
# Blocks per group:         32768
# Inodes per group:         8192
# Inode size:               256
# Journal inode:            8
```

## The ext4 superblock

```c
/* fs/ext4/ext4.h */
struct ext4_super_block {
    __le32  s_inodes_count;         /* total inodes */
    __le32  s_blocks_count_lo;      /* total blocks (low 32 bits) */
    __le32  s_r_blocks_count_lo;    /* reserved blocks */
    __le32  s_free_blocks_count_lo;
    __le32  s_free_inodes_count;
    __le32  s_first_data_block;     /* first data block (0 for 4K blocks) */
    __le32  s_log_block_size;       /* block size = 1024 << s_log_block_size */
    __le32  s_blocks_per_group;
    __le32  s_inodes_per_group;
    __le32  s_mtime;                /* last mount time */
    __le32  s_wtime;                /* last write time */
    __le16  s_magic;                /* 0xEF53 */
    __le16  s_state;                /* filesystem state: clean/errors */
    __le16  s_errors;               /* error behavior: continue/remount-ro/panic */
    /* ... */
    __le32  s_feature_compat;       /* compatible feature flags */
    __le32  s_feature_incompat;     /* incompatible feature flags */
    __le32  s_feature_ro_compat;    /* read-only compatible features */
    __u8    s_uuid[16];             /* filesystem UUID */
    char    s_volume_name[16];
    /* ... journal info, encryption, etc. */
};
```

## The ext4 inode

```c
struct ext4_inode {
    __le16  i_mode;             /* file mode (S_IFREG, S_IFDIR, etc.) */
    __le16  i_uid;              /* lower 16 bits of UID */
    __le32  i_size_lo;          /* file size (lower 32 bits) */
    __le32  i_atime;            /* access time */
    __le32  i_ctime;            /* inode change time */
    __le32  i_mtime;            /* modification time */
    __le32  i_dtime;            /* deletion time */
    __le16  i_gid;
    __le16  i_links_count;      /* hard link count */
    __le32  i_blocks_lo;        /* 512-byte blocks used */
    __le32  i_flags;            /* EXT4_EXTENTS_FL, EXT4_INLINE_DATA_FL, ... */
    __le32  i_block[EXT4_N_BLOCKS]; /* 15 words: extent tree root OR block map */
    __le32  i_generation;
    __le32  i_file_acl_lo;      /* extended attribute block */
    __le32  i_size_high;        /* upper 32 bits of file size */
    /* ... extra fields at offset 128 for inodes > 128 bytes ... */
    __le16  i_extra_isize;      /* extra inode size (allows new fields) */
    /* nanosecond timestamps: */
    __le32  i_ctime_extra;
    __le32  i_mtime_extra;
    __le32  i_atime_extra;
    __le32  i_crtime;           /* creation time */
    __le32  i_crtime_extra;
    /* ... version, checksum ... */
};
```

## Extent tree: efficient large file representation

ext4 uses extents (contiguous block runs) instead of the old indirect block maps. Extents were introduced by Alex Tomas [(commit)](https://git.kernel.org/linus/a86c61812637c7dd0c57e29880cffd477b62f2e7):

```
i_block[0..3] holds the extent tree root:
┌──────────────────────────────────────────────────────┐
│ ext4_extent_header                                    │
│   eh_magic=0xF30A, eh_entries=N, eh_depth=0 (leaf)   │
├──────────────────────────────────────────────────────┤
│ ext4_extent[0]: ee_block=0,  ee_len=128, ee_start=1024│
│ ext4_extent[1]: ee_block=128,ee_len=64,  ee_start=2048│
└──────────────────────────────────────────────────────┘

For deep files, eh_depth>0: i_block contains internal nodes
with ext4_extent_idx entries pointing to child blocks
```

```c
struct ext4_extent {
    __le32  ee_block;       /* first logical block covered */
    __le16  ee_len;         /* number of blocks (or 0x8000 | len for unwritten) */
    __le16  ee_start_hi;    /* physical block (high 16 bits) */
    __le32  ee_start_lo;    /* physical block (low 32 bits) */
};

struct ext4_extent_header {
    __le16  eh_magic;       /* 0xF30A */
    __le16  eh_entries;     /* number of entries */
    __le16  eh_max;         /* capacity of this node */
    __le16  eh_depth;       /* depth (0=leaf, >0=internal) */
    __le32  eh_generation;
};
```

Benefits over old indirect maps:
- A single extent covers contiguous blocks (e.g., 128MB in one entry)
- Sequential reads are contiguous on disk → fast
- Reduces inode tree depth for large files

## Journaling with jbd2

ext4 uses the Journal Block Device (jbd2) for crash consistency:

### Write modes

| Mode | journaled | Data safety | Performance |
|------|-----------|-------------|-------------|
| `data=writeback` | metadata only | Data may be pre-allocated garbage after crash | Fastest |
| `data=ordered` (default) | metadata only, but data written before metadata | Data is committed when metadata is | Good balance |
| `data=journal` | both metadata and data | Strongest | Slowest |

```bash
# Check current mode
tune2fs -l /dev/sda1 | grep "Default mount options"
# Default mount options: user_xattr acl

# Mount with specific journal mode
mount -o data=journal /dev/sda1 /mnt
```

### Journal structure (jbd2)

```c
/* fs/jbd2/journal.c */
struct journal_s {              /* journal_t */
    unsigned long   j_flags;   /* JBD2_UNMOUNT, JBD2_ABORT, ... */
    int             j_errno;

    struct buffer_head *j_sb_buffer; /* journal superblock */
    journal_superblock_t *j_superblock;

    tid_t           j_head;     /* latest transaction sequence number */
    tid_t           j_tail;     /* oldest committed transaction still on disk */
    unsigned long   j_free;     /* free space remaining */

    struct transaction_s *j_running_transaction;  /* current transaction */
    struct transaction_s *j_committing_transaction;
    struct list_head j_checkpoint_transactions;

    wait_queue_head_t j_wait_transaction_locked;
    wait_queue_head_t j_wait_done_commit;
    wait_queue_head_t j_wait_commit;
    wait_queue_head_t j_wait_updates;

    struct task_struct *j_task;  /* kjournald thread */
    int j_max_transaction_buffers;
    unsigned long j_commit_interval;  /* default 5 seconds */
};
```

### Transaction flow

```
1. jbd2_journal_start(): begin transaction
      → get handle_t for this transaction
      → reserve journal space (journal credits)

2. jbd2_journal_get_write_access(bh): mark buffer as modified
      → copy original buffer to journal (for undo)

3. Modify the buffer (update data)

4. jbd2_journal_dirty_metadata(bh): mark buffer dirty in journal

5. jbd2_journal_stop(): end transaction
      → if journal full or commit_interval elapsed:
          kjournald2 commits:
            → write descriptor + data blocks to journal
            → write commit record to journal (seals the transaction)
            → checkpoint: write data blocks to final location, mark journal free

6. On crash: journal replay restores consistency
```

## Delayed allocation (delalloc)

ext4 delays block allocation until actual writeback:

```c
/* When a page is written: */
/* 1. Mark page dirty, NO block allocated yet */
/* 2. On writeback (dirty expire or sync): */
ext4_writepages()
  → ext4_da_convert_inline_data()
  → mpage_map_and_submit_extent()
      → ext4_map_blocks(CREATE)  ← allocate blocks NOW
          → ext4_ext_map_blocks() → find/create extent
          → jbd2_journal_get_write_access()
```

Benefits:
- Small writes that are quickly deleted never need block allocation
- Large sequential writes get contiguous blocks (better for extent efficiency)
- Reduces journal pressure (allocations batched)

## Online features

```bash
# Online resize (grow filesystem)
resize2fs /dev/sda1  # grow to fill partition

# Online defrag (for fragmented files)
e4defrag /data/myfile
e4defrag /data/  # defrag directory

# Check filesystem health
e2fsck -n /dev/sda1   # dry run, don't fix

# Tune journaling commit interval (default 5s)
tune2fs -o journal_data_ordered /dev/sda1
mount -o commit=60 /dev/sda1 /mnt  # commit every 60s (less safe, faster)

# Enable inline data (small files stored in inode directly)
tune2fs -O inline_data /dev/sda1
```

## Key ext4 statistics

```bash
# ext4 stats via debugfs
debugfs /dev/sda1
> stats
> icheck <block_number>  # find inode owning block
> ncheck <inode_number>  # find name of inode
> blocks <inode_number>  # show blocks used by inode

# ext4 tracepoints
ls /sys/kernel/tracing/events/ext4/
echo 1 > /sys/kernel/tracing/events/ext4/ext4_da_write_begin/enable
cat /sys/kernel/tracing/trace_pipe

# Block allocation stats
cat /proc/fs/ext4/sda1/mb_groups  # buddy allocator per-group state
```

## Further reading

- [tmpfs and ramfs](tmpfs.md) — Memory-backed alternative
- [btrfs](btrfs.md) — Copy-on-Write alternative
- [VFS: Life of a write()](../vfs/life-of-write.md) — How writes reach ext4
- `Documentation/filesystems/ext4/` — detailed on-disk format
