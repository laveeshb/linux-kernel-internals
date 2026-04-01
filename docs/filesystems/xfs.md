# XFS: High-Performance Journaling Filesystem

> Allocation groups, B-tree index structures, delayed allocation, and online repair

## Why XFS?

XFS was originally developed at SGI for IRIX in 1993, then ported to Linux by Steve Lord and the SGI team; it was merged into the mainline kernel in Linux 2.5.36 (2002). It excels at:
- **Large files and filesystems**: up to 8 EiB volumes, 8 EiB files
- **High concurrency**: per-allocation-group locking, minimal global contention
- **Metadata performance**: B-tree indexes for extents, inodes, and free space
- **Online operations**: defrag, grow, and repair while mounted

| Feature | ext4 | XFS | Btrfs |
|---------|------|-----|-------|
| Max filesystem | 1 EiB | 8 EiB | 16 EiB |
| Max file size | 16 TiB | 8 EiB | 16 EiB |
| Delayed alloc | Yes | Yes | Yes |
| Journal | JBD2 | Internal (xlog) | None (CoW) |
| Checksums | Metadata only | Metadata + dir | All blocks |
| Online repair | No | Yes (5.19+) | Yes (btrfs scrub) |
| Reflinks | No | Yes | Yes |
| Quotas | Yes | Yes | Yes |
| Realtime section | No | Yes | No |

## Allocation Groups

XFS divides the filesystem into **Allocation Groups (AGs)**. Each AG manages its own inodes, free space, and B-trees independently:

```
XFS filesystem:
┌──────────────────────────────────────────────────────────┐
│ Superblock │ AG 0 │ AG 1 │ AG 2 │ AG 3 │ ... │ AG N-1  │
└──────────────────────────────────────────────────────────┘
              Each AG:
              ┌────────────────────────────────────────┐
              │ AG superblock (agf + agi + agfl)       │
              │ Free space B-tree 1 (by block number)  │
              │ Free space B-tree 2 (by block count)   │
              │ Inode B-tree                           │
              │ Free inode B-tree                      │
              │ Reverse mapping B-tree (rmapbt)        │
              │ Reference count B-tree (refcntbt)      │
              │ [Data blocks and inodes]               │
              └────────────────────────────────────────┘
```

AG size defaults to roughly 1 GiB (power of 2 ≤ filesystem size / 4). The number of AGs determines the parallelism:

```bash
# Check AG count and size:
xfs_info /dev/sda1
# meta-data=/dev/sda1    isize=512  agcount=16, agsize=6553600 blks
#          =             sectsz=512   attr=2, projid32bit=1
#          =             crc=1        finobt=1, sparse=1, rmapbt=1
# data     =             bsize=4096   blocks=104857600, imaxpct=25
# naming   =version 2    bsize=4096   ascii-ci=0, ftype=1
# log      =internal     bsize=4096   blocks=51200, version=2
#          =             sectsz=512   sunit=0 blks, lazy-count=1
# realtime =none         extsz=4096   blocks=0, rtextents=0
```

## B-tree structures

### Free space B-trees (bnobt and cntbt)

Two B-trees track free space, allowing O(log n) allocation:

```c
/* Free extent record: */
struct xfs_alloc_rec {
    __be32  ar_startblock;  /* starting block number */
    __be32  ar_blockcount;  /* number of free blocks */
};
/* bnobt: keyed by startblock (for contiguous allocation near a hint) */
/* cntbt: keyed by blockcount (for best-fit allocation by size) */
```

```bash
# Dump free space B-tree:
xfs_db -c 'ag 0' -c 'agf' -c 'print' /dev/sda1
# magicnum = 0x58414746   (XAGF)
# versionnum = 1
# seqno = 0
# length = 6553600
# bnoroot = 2
# cntroot = 3
# bnolevel = 2
# cntlevel = 2
# freeblks = 5234567
```

### Inode B-tree (inobt) and free inode B-tree (finobt)

```c
/* Inode chunk record: 64 inodes per chunk */
struct xfs_inobt_rec {
    __be32  ir_startino;   /* first inode number in chunk */
    __be16  ir_holemask;   /* holes in the inode chunk (sparse inodes) */
    __u8    ir_count;      /* # of inodes in this record */
    __u8    ir_freecount;  /* # of free inodes */
    __be64  ir_free;       /* bitmask of free inodes */
};
/* finobt: same format, but only records with ir_freecount > 0 */
/* finobt allows O(log n) free inode lookup instead of scanning inobt */
```

### Reverse mapping B-tree (rmapbt)

Introduced in Linux 4.8. Every allocated block is back-referenced to its owner:

```c
struct xfs_rmap_rec {
    __be32  rm_startblock; /* start block of extent */
    __be32  rm_blockcount; /* length of extent */
    __be64  rm_owner;      /* owner (inode#, or XFS_RMAP_OWN_* for metadata) */
    __be64  rm_offset;     /* file offset (for data extents) */
    /* flags: unwritten, attr fork, bmbt block */
};
```

rmapbt enables: online repair (find which inode owns a corrupt block), online scrub, and reflink COW tracking.

## Inode format

XFS inodes are 512 bytes (configurable to 256 or 2048):

```c
struct xfs_dinode {
    __be16  di_magic;      /* 0x494e "IN" */
    __be16  di_mode;       /* file type + permissions */
    __u8    di_version;    /* inode version 1/2/3 */
    __u8    di_format;     /* XFS_DINODE_FMT_* */
    __be64  di_size;
    __be64  di_nblocks;    /* # of data + attr blocks */
    __be32  di_extsize;    /* extent size hint */
    __be32  di_nextents;   /* # of data extents */
    __be16  di_anextents;  /* # of attr extents */
    __be64  di_atime;
    __be64  di_mtime;
    __be64  di_ctime;
    __be64  di_crtime;     /* v3: creation time */
    __be64  di_ino;        /* v3: inode number (self-identification) */
    uuid_t  di_uuid;       /* v3: filesystem UUID */
    /* ... checksum, flags ... */
    /* Followed by: data fork (extents or B-tree root or inline data) */
};

/* di_format values: */
/* XFS_DINODE_FMT_DEV:    special file, device number inline */
/* XFS_DINODE_FMT_LOCAL:  data inline (small files/dirs) */
/* XFS_DINODE_FMT_EXTENTS: extent list fits in inode */
/* XFS_DINODE_FMT_BTREE:  B-tree rooted in inode (many extents) */
```

### Extent format

XFS stores extents in a compact 128-bit format:

```c
/* xfs_bmbt_rec: 128-bit packed extent record */
/* Bits:
   [127]      unwritten flag
   [126:73]   file offset in blocks (54 bits)
   [72:21]    start block (52 bits)
   [20:0]     block count (21 bits, max 2M blocks per extent)
*/
```

Up to ~20 extents fit inline in the inode. Beyond that, a B-tree (bmbt) is rooted in the inode.

## Delayed allocation

XFS uses **delayed allocation** to improve write performance. Instead of allocating disk blocks immediately on write, XFS reserves space in memory and delays the actual allocation until writeback:

```
write() → page cache → dirty pages
                           ↓ (delayed: no block allocation yet)
                    speculative reservation (in-memory)
                           ↓ (at writeback time)
                    actual allocation from cntbt
                    extent map updated
                    blocks written to disk
```

Benefits:
- Consecutive writes can be merged into large extents
- Allocation happens when more context is available (full file size known)
- Fewer, larger extents → less fragmentation

```bash
# Monitor allocation statistics:
xfs_io -c 'statfs' /data
# geometry.rtextsize = 0
# geometry.rtblocks = 0

# Check fragmentation:
xfs_db -c 'freesp -s' /dev/sda1
# from      to extents  blocks    pct
#    1       1  123456  123456   5.40
#    2       3   23456   46912   2.06
# ...

# Defragment:
xfs_fsr /dev/sda1       # filesystem reorganizer
```

## XFS journal (xlog)

XFS uses its own journaling (xlog), separate from JBD2:

```
Journal write sequence:
  1. Begin transaction (xfs_trans_alloc)
  2. Lock and log modified buffers (xfs_buf_item_log)
  3. Commit transaction → write log records to circular journal
  4. Async: CIL (Committed Item List) batches commits
  5. Checkpoint: write all modified metadata to its real location
  6. Log tail advances: journal space is freed

On crash recovery:
  xlog_recover() replays committed transactions since last checkpoint
```

### Committed Item List (CIL)

The CIL is XFS's equivalent of JBD2's running transaction, but with delayed flushing. Delayed logging (log intent items) was designed and implemented by Dave Chinner:

```c
/* Multiple transactions are batched into one CIL push: */
/* - xfs_log_commit_cil() adds items to in-memory CIL */
/* - When CIL exceeds threshold (1/4 log), push to disk */
/* - One xlog_write() for many transactions → fewer I/Os */
```

```bash
# Journal stats:
xfs_logprint -t /dev/sda1 | head -30

# Check journal size:
xfs_info /dev/sda1 | grep log
# log  =internal   bsize=4096  blocks=51200, version=2
# Journal: 51200 * 4096 = 200MB internal log
```

## Online repair (XFS 5.19+)

A unique XFS feature: repair the filesystem while it is mounted:

```bash
# Online scrub: check for inconsistencies (read-only, safe):
xfs_scrub /data
# Phase 1: Check internal metadata.
# Phase 2: Scan directory tree.
# Phase 3: Check directory connectivity.
# Phase 4: Verify inode disk data.
# Phase 5: Check summary counters.

# Aggressive: also repair found issues:
xfs_scrub -n /data   # dry run: just report
xfs_scrub /data      # repair in-place

# Traditional offline repair (unmounted):
xfs_repair /dev/sda1
```

Scrub works by cross-referencing B-trees: the rmapbt knows every allocated block, so the scrubber can verify that every block referenced by the extent B-tree is also in the rmapbt.

## Quotas

```bash
# Enable quota at mount:
mount -o uquota /dev/sda1 /data     # user quota
mount -o gquota /dev/sda1 /data     # group quota
mount -o pquota /dev/sda1 /data     # project quota (for directories)

# Set limits:
xfs_quota -x -c 'limit bsoft=1g bhard=2g user1' /data
xfs_quota -x -c 'limit -p bsoft=10g bhard=20g 100' /data  # project 100

# Report:
xfs_quota -c 'quota -h user1' /data
xfs_quota -c 'df -h' /data

# Project quota: track a directory tree
echo "100:/data/project1" >> /etc/projects
echo "100:Project One" >> /etc/projid
xfs_quota -x -c 'project -s 100' /data  # assign directory to project
```

## Performance tuning

```bash
# Optimal mkfs for a specific workload:
mkfs.xfs \
    -b size=4096 \          # block size (4K default)
    -l size=256m \          # journal size (larger = better burst)
    -d agcount=32 \         # 32 AGs = 32-way parallelism
    -i size=512 \           # inode size (512B, or 256B for small files)
    /dev/sda1

# Mount options:
mount -o noatime,largeio,inode64 /dev/sda1 /data
# noatime:  skip atime updates (reduces writes)
# largeio:  512KB I/O for striped storage
# inode64:  allocate inodes throughout filesystem (not just first 1TB)

# Allocator hints: tell XFS about RAID geometry
mkfs.xfs -d su=64k,sw=4 /dev/md0
# su=stripe unit (64K), sw=stripe width (4 disks)
```

## Observability

```bash
# XFS statistics:
cat /proc/fs/xfs/stat
# extent_alloc 12345 678 90123 456
# abt 0 0 0 0       ← alloc B-tree operations
# blk_map ...
# bmbt ...          ← extent B-tree operations
# dir ...           ← directory operations
# trans ...         ← transaction statistics

# IO stats:
xfs_io -c 'fiemap' /data/bigfile  # show extent map for a file

# Trace XFS B-tree operations:
bpftrace -e 'kprobe:xfs_alloc_ag_vextent { @[probe] = count(); }'

# Check inode count:
df -i /data

# Detailed space usage:
xfs_db -c 'freesp -d' /dev/sda1
```

## Further reading

- [ext4 Journaling (JBD2)](ext4-journal.md) — alternative journaling approach
- [Btrfs](btrfs.md) — CoW filesystem comparison
- [blk-mq](../block/blk-mq.md) — block layer XFS submits I/O through
- [Page Cache](../mm/page-cache.md) — XFS uses page cache for buffered I/O
- `fs/xfs/` — XFS implementation
- `Documentation/filesystems/xfs/` — XFS developer documentation
- `xfsprogs` — mkfs.xfs, xfs_info, xfs_repair, xfs_scrub, xfs_io
