# Btrfs: B-tree Filesystem

> Copy-on-write B-tree layout, snapshots, subvolumes, and RAID

## Why Btrfs?

Btrfs (B-tree filesystem) was designed to address limitations of ext4:

| Feature | ext4 | Btrfs |
|---------|------|-------|
| Max volume | 1 EiB | 16 EiB |
| Checksums | No | Yes (CRC32C/xxhash/SHA256) |
| Snapshots | No | Yes (instant, writable) |
| Subvolumes | No | Yes (independent namespaces) |
| RAID | mdraid only | Built-in RAID 0/1/5/6/10 |
| Compression | No | zlib/lzo/zstd inline |
| Deduplication | No | Offline (duperemove) |
| Send/receive | No | Yes (incremental backups) |
| Copy-on-write | No (uses journaling) | Data + metadata |

## B-tree structure

Everything in Btrfs is stored in B-trees. There is no separate inode table or block bitmap — all metadata lives in these trees:

```
Btrfs superblock
└── tree of tree roots
    ├── root tree     ← metadata about all other trees
    ├── extent tree   ← free space and block reference counts
    ├── chunk tree    ← logical → physical address mapping
    ├── device tree   ← physical devices
    ├── checksum tree ← data block checksums
    └── [subvolume trees]
        ├── subvol 256 (default root)  ← files and directories
        ├── subvol 257 (first snapshot)
        └── ...
```

### B-tree node format

```c
/* include/uapi/linux/btrfs_tree.h */

/* Every node starts with this header: */
struct btrfs_header {
    __u8    csum[BTRFS_CSUM_SIZE]; /* checksum of this block */
    __u8    fsid[BTRFS_FSID_SIZE]; /* filesystem UUID */
    __le64  bytenr;                /* this block's bytenr (logical addr) */
    __le64  flags;
    __u8    chunk_tree_uuid[BTRFS_UUID_SIZE];
    __le64  generation;            /* transaction ID when written */
    __le64  owner;                 /* tree ID this node belongs to */
    __le32  nritems;               /* number of items */
    __u8    level;                 /* 0 = leaf, >0 = internal node */
};

/* Internal node: array of (key, blockptr) pairs */
struct btrfs_key_ptr {
    struct btrfs_disk_key key;
    __le64 blockptr;           /* child node address */
    __le64 generation;
};

/* Leaf node: items + data packed from both ends */
struct btrfs_item {
    struct btrfs_disk_key key;  /* (objectid, type, offset) triple */
    __le32 offset;              /* data offset from end of leaf */
    __le32 size;                /* data size */
};
/* Item data sits at end of leaf, items array at start, they grow toward center */
```

### Keys

Every item in every Btrfs tree has a 3-part key:

```
(objectid, type, offset)
   ↑            ↑      ↑
 inode#    item type  varies

Examples:
(256, INODE_ITEM,    0)           → inode metadata
(256, INODE_REF,     parent_id)   → directory reference
(256, EXTENT_DATA,   file_offset) → file data mapping
(256, DIR_ITEM,      name_hash)   → directory entry
(256, XATTR_ITEM,    name_hash)   → extended attribute
```

## Copy-on-write semantics

Btrfs never overwrites data in place. Every write creates new blocks:

```
Write to file:
  1. Allocate new block(s) from extent tree
  2. Write new data to new block
  3. Update file's EXTENT_DATA item → new block address
  4. COW the leaf containing EXTENT_DATA
  5. COW all parent nodes up to root
  6. Update root pointer in superblock

Old blocks become unreferenced → freed in next transaction

Benefits:
  • Crash safety: superblock update is atomic, old tree still valid
  • Snapshots: share unchanged blocks between snapshots
  • No journal needed for metadata consistency
```

```
Before write:                After write:

Root ──→ [A]                 Root ──→ [A']  (new)
         │                            │
        [B]                          [B']  (new)
         │                            │
        [leaf: extent→blk1]          [leaf': extent→blk2]  (new)

blk1 still valid (could be shared by snapshot)
```

## Subvolumes and snapshots

A **subvolume** is an independently rootable B-tree (its own root inode):

```bash
# Create a subvolume:
btrfs subvolume create /data/myapp

# List subvolumes:
btrfs subvolume list /data
# ID 256 gen 100 top level 5 path myapp
# ID 257 gen 102 top level 5 path myapp-snap-2024

# Create a snapshot (instant, CoW):
btrfs subvolume snapshot /data/myapp /data/myapp-snap-2024
# Read-only snapshot:
btrfs subvolume snapshot -r /data/myapp /data/myapp-backup

# Delete snapshot:
btrfs subvolume delete /data/myapp-snap-2024

# Set default subvolume (what mounts to /):
btrfs subvolume set-default 256 /data
```

Snapshot creation is O(1) — it just copies the B-tree root pointer. Shared blocks are reference-counted in the extent tree.

## Extent tree: space accounting

```c
/* Each allocated extent has a back-reference: */
struct btrfs_extent_item {
    __le64  refs;          /* reference count */
    __le64  generation;
    __le64  flags;         /* BTRFS_EXTENT_FLAG_DATA or _TREE_BLOCK */
};

/* Inline back-reference (for single owner): */
struct btrfs_extent_inline_ref {
    __u8    type;           /* BTRFS_EXTENT_DATA_REF_KEY etc. */
    __le64  offset;         /* depends on type */
};
```

```bash
# Show extent usage:
btrfs filesystem df /data
# Data, single: total=2.00GiB, used=1.23GiB
# Metadata, DUP: total=256.00MiB, used=12.50MiB
# System, DUP: total=8.00MiB, used=16.00KiB

# Detailed space info:
btrfs filesystem usage /data

# Show shared extents between snapshots:
btrfs inspect-internal dump-tree -t extent /dev/sda1 | head -50
```

## Checksums

Btrfs checksums every data block and every metadata block:

```bash
# Default checksum: crc32c (fast, hardware-accelerated)
# Available: xxhash (faster), sha256, blake2b (collision-resistant)

# Set checksum at mkfs:
mkfs.btrfs --checksum xxhash /dev/sda1

# Check filesystem:
btrfs scrub start /data          # verify all checksums
btrfs scrub status /data         # check progress
# scrub device /dev/sda1 (id 1) done
# total bytes scrubbed: 100.23GiB with 0 errors

# Scrub finds silent bit-rot that ext4 would miss!
```

```c
/* Kernel verifies checksum on every read (fs/btrfs/disk-io.c):
 * btrfs_validate_extent_buffer() computes the checksum over the
 * extent buffer data and compares against the stored checksum in
 * the first bytes of the buffer header.
 * Uses fs_info->csum_type to dispatch to the correct hash (crc32c,
 * xxhash64, sha256, or blake2b). */
```

## Inline compression

```bash
# Mount with compression:
mount -o compress=zstd /dev/sda1 /data      # zstd (best ratio/speed balance)
mount -o compress=lzo /dev/sda1 /data       # lzo (fastest)
mount -o compress=zlib /dev/sda1 /data      # zlib (best ratio)
mount -o compress-force=zstd /dev/sda1 /data # force even for incompressible data

# Per-file compression:
btrfs property set /data/bigfile compression zstd

# Check compression ratio:
compsize /data/bigfile
# Type       Perc     Disk Usage   Uncompressed Referenced
# TOTAL       42%      420M         1.00G        1.00G
# zstd        42%      420M         1.00G        1.00G
```

## Send/receive (incremental backups)

```bash
# Full backup:
btrfs subvolume snapshot -r /data/myapp /data/myapp-snap-1
btrfs send /data/myapp-snap-1 | btrfs receive /backup/

# Incremental: only changed blocks since snap-1
btrfs subvolume snapshot -r /data/myapp /data/myapp-snap-2
btrfs send -p /data/myapp-snap-1 /data/myapp-snap-2 | btrfs receive /backup/
# Sends only the diff between snap-1 and snap-2

# Over SSH:
btrfs send /data/myapp-snap-2 | ssh backuphost "btrfs receive /backup/"
```

## RAID in Btrfs

```bash
# Create RAID 1 (mirrored metadata + data):
mkfs.btrfs -d raid1 -m raid1 /dev/sda /dev/sdb

# Add device to existing filesystem:
btrfs device add /dev/sdc /data
btrfs balance start -dconvert=raid1 -mconvert=raid1 /data

# Show RAID status:
btrfs filesystem show /data

# Replace a failed device:
btrfs replace start /dev/sdb /dev/sdd /data
btrfs replace status /data
```

## Transaction model

Btrfs uses a transaction-based model without a journal:

```c
/* fs/btrfs/transaction.c */
struct btrfs_trans_handle {
    u64             transid;         /* transaction ID */
    u64             bytes_reserved;  /* space reserved */
    struct btrfs_transaction *transaction;
};

/* Begin transaction (reserves space): */
trans = btrfs_start_transaction(root, 10); /* reserve 10 blocks worth */

/* Modify B-tree items (e.g., insert inode ref): */
btrfs_insert_inode_ref(trans, root, name, namelen, objectid, dir_objectid, index);

/* Commit (COW all dirty nodes, update superblock): */
btrfs_commit_transaction(trans);
```

The superblock is written last and contains the root of the tree-of-roots. Until the superblock update, the old tree is intact — crash at any point leaves the previous transaction's state valid.

## Defragmentation

CoW fragmentation builds up over time:

```bash
# Defragment a file (rewrites extents sequentially):
btrfs filesystem defragment /data/bigfile

# Defragment with compression:
btrfs filesystem defragment -czstd /data/bigfile

# Defragment entire subvolume (warning: breaks CoW sharing with snapshots!):
btrfs filesystem defragment -r /data/myapp

# Auto-defrag on mount:
mount -o autodefrag /dev/sda1 /data
```

## Observability

```bash
# Filesystem stats:
btrfs filesystem show
btrfs filesystem df /data
btrfs filesystem usage /data

# Tree inspection (low-level):
btrfs inspect-internal dump-tree /dev/sda1       # all trees
btrfs inspect-internal dump-tree -t fs /dev/sda1 # subvolume tree
btrfs inspect-internal dump-super /dev/sda1       # superblock

# Find which file owns a logical address:
btrfs inspect-internal logical-resolve 12345678 /data

# Check for errors (offline, non-destructive):
btrfs check --readonly /dev/sda1

# Stats: read/write errors per device
btrfs device stats /data

# Performance tracing:
bpftrace -e 'kprobe:btrfs_file_write_iter { @[comm] = count(); }'
```

## Further reading

- [ext4 Journaling (JBD2)](ext4-journal.md) — journal-based contrast
- [Page Cache](../mm/page-cache.md) — page cache that Btrfs CoW writes through
- [Copy-on-Write](../mm/cow.md) — process CoW vs filesystem CoW
- [xattr](../vfs/xattr.md) — Btrfs stores xattrs in the subvolume tree
- `fs/btrfs/` — Btrfs implementation
- `Documentation/filesystems/btrfs.rst`
