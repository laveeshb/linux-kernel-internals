# btrfs

> Copy-on-Write B-tree filesystem with snapshots, checksums, and RAID

## Core concepts

btrfs is built on a single fundamental mechanism: **Copy-on-Write (CoW) B-trees**. Instead of modifying data in-place, btrfs writes new versions and updates parent pointers atomically. This enables:

- **Snapshots**: zero-copy point-in-time copies (shared CoW pages)
- **Checksums**: every data and metadata block is checksummed
- **Self-healing**: with redundant data, corrupted blocks are repaired automatically
- **Online resize**: grow/shrink while mounted
- **Built-in RAID**: stripe, mirror, or RAID5/6 without MD/LVM

## The B-tree structure

All btrfs data is organized in a forest of CoW B-trees. Each tree has a root stored in the superblock or its parent tree:

```
Superblock
    │
    ├── Root Tree ─────────────────────────────────────┐
    │   (tree of trees — maps tree IDs to roots)       │
    │   ├── FS Tree root (subvol 5 = default)  ←───────┤
    │   ├── Snapshot Tree root (subvol 256)    ←───────┤
    │   └── ...                                        │
    │                                                  │
    ├── Chunk Tree ──────────────────────────────────── physical location mapping
    │   (maps logical addresses to physical extents)
    │
    └── Device Tree ─────────────────────────────────── device info
```

### B-tree nodes

```c
/* fs/btrfs/ctree.h */
struct btrfs_header {
    /* checksummed area starts here: */
    u8      csum[BTRFS_CSUM_SIZE];  /* checksum of node */
    u8      fsid[BTRFS_FSID_SIZE];  /* filesystem UUID */
    __le64  bytenr;                  /* logical address of this node */
    __le64  flags;
    u8      chunk_tree_uuid[BTRFS_UUID_SIZE];
    __le64  generation;              /* transaction ID that wrote this */
    __le64  owner;                   /* which tree owns this node */
    __le32  nritems;                 /* number of items */
    u8      level;                   /* 0 = leaf, >0 = internal */
};

/* Leaf node item (internal nodes use btrfs_key_ptr instead): */
struct btrfs_item {
    struct btrfs_disk_key key;
    __le32 offset;  /* offset within leaf data area */
    __le32 size;    /* size of item data */
};

/* Key: identifies all btrfs items */
struct btrfs_disk_key {
    __le64  objectid;   /* inode number, subvol ID, etc. */
    u8      type;       /* BTRFS_INODE_ITEM_KEY, BTRFS_EXTENT_DATA_KEY, ... */
    __le64  offset;     /* file offset, extent start, etc. */
};
```

## Copy-on-Write mechanics

When btrfs modifies a block:

```
1. Allocate a new block at a free location
2. Write new data to the new block
3. Update parent node: change pointer to new block
4. Parent node is also CoW'd (recursively up to the root)
5. Update superblock to point to new root
6. Old blocks are freed when no snapshot references them
```

This means:
- Old data remains valid until all snapshots drop their references
- No partial writes: either the new root is committed or the old is used
- Crash safety: the superblock update is atomic (single write)

## Subvolumes and snapshots

A **subvolume** is an independent filesystem tree (its own FS tree root). The default mount point is subvolume 5 (or the one set with `btrfs subvolume set-default`).

```bash
# Create a subvolume
btrfs subvolume create /data/mysubvol
# mounts as: /data/mysubvol/

# List subvolumes
btrfs subvolume list /data
# ID 256 gen 42 top level 5 path mysubvol

# Snapshot: instant copy-on-write copy
btrfs subvolume snapshot /data/mysubvol /data/snap-20240115
# Takes nanoseconds: just creates a new root pointing to same leaves

# Read-only snapshot (for backups)
btrfs subvolume snapshot -r /data/mysubvol /data/snap-readonly

# Delete a subvolume/snapshot
btrfs subvolume delete /data/snap-20240115
```

### Snapshot internals

A snapshot is just a new FS tree root that shares all B-tree nodes with its parent. Shared nodes have their reference counts incremented. When a shared node needs modification, it's CoW'd and the reference count decremented:

```
Before snapshot:         After snapshot:
FS Tree                  FS Tree    Snapshot
  Root                     Root       Root
  [gen=42]                [gen=42]   [gen=42]←─shared, refcount=2
     │                       │         │
   dir a                   dir a     dir a (same node, refcount=2)
```

When a file in the snapshot changes, only the modified path gets CoW'd; unchanged subtrees remain shared.

## Checksums

Every data and metadata block has a checksum stored in its B-tree parent:

```bash
# Default checksum: crc32c
btrfs inspect-internal dump-super /dev/sda | grep csum_type
# csum_type 0 (crc32c)

# SHA256 checksum (slower but cryptographic)
mkfs.btrfs --checksum sha256 /dev/sda

# BLAKE2b (fast and cryptographic)
mkfs.btrfs --checksum blake2 /dev/sda

# Verify checksums
btrfs scrub start /data    # check all data/metadata on device
btrfs scrub status /data   # check status
```

When a read encounters a checksum mismatch:
- Single device: returns EIO
- RAID1/RAID10: reads from redundant copy and repairs the bad block

## Built-in RAID

```bash
# Create with RAID1 metadata + RAID1 data (2 devices)
mkfs.btrfs -m raid1 -d raid1 /dev/sda /dev/sdb

# RAID5 (3+ devices, 1 parity)
mkfs.btrfs -m raid1 -d raid5 /dev/sda /dev/sdb /dev/sdc

# Check RAID status
btrfs filesystem df /data
# Data, RAID1: total=10.00GiB, used=8.50GiB
# Metadata, RAID1: total=1.00GiB, used=0.50GiB

# Balance: restripe data across devices
btrfs balance start -dconvert=raid1 /data
```

## Deduplication

btrfs supports extents sharing (CoW-based dedup):

```bash
# Online dedup with duperemove
duperemove -dr /data/

# Or FIDEDUPERANGE ioctl (kernel 4.5+): share identical extents
# btrfs-dedupe tool
```

Dedup works by finding files with identical content ranges and pointing their extent references to the same physical block (with refcounting).

## Transparent compression

```bash
# Mount with transparent compression
mount -o compress=zstd /dev/sda /data    # zstd (recommended)
mount -o compress=lzo /dev/sda /data     # lzo (faster)
mount -o compress=zlib /dev/sda /data    # zlib (best ratio)

# Set per-file compression attribute
btrfs property set /data/myfile compression zstd

# Check compression ratio
compsize /data/
# Uncompressed size:  100G
# Compressed size:    60G
# Compression ratio:  1.67
```

## Send/receive: efficient incremental backup

```bash
# Initial backup: send full snapshot
btrfs subvolume snapshot -r /data/subvol /data/snap-1
btrfs send /data/snap-1 | btrfs receive /backup/

# Incremental: only send the diff
btrfs subvolume snapshot -r /data/subvol /data/snap-2
btrfs send -p /data/snap-1 /data/snap-2 | btrfs receive /backup/
# Much smaller than a full send — only CoW'd blocks

# Send to remote
btrfs send /data/snap-2 | ssh backup-server btrfs receive /backup/
```

## Monitoring btrfs

```bash
# Filesystem stats
btrfs filesystem show /data
btrfs filesystem df /data

# Device stats (I/O errors, checksum errors)
btrfs device stats /data
# [/dev/sda].write_io_errs   0
# [/dev/sda].read_io_errs    0
# [/dev/sda].flush_io_errs   0
# [/dev/sda].corruption_errs 0
# [/dev/sda].generation_errs 0

# Extent and tree statistics
btrfs inspect-internal dump-tree /dev/sda   # dump all B-tree data
btrfs inspect-internal inode-resolve <ino> /data

# Balance status
btrfs balance status /data
```

## Further reading

- [ext4](ext4.md) — Traditional journaled alternative
- [tmpfs](tmpfs.md) — Memory-backed filesystem
- [VFS: Dentry and Inode Caches](../vfs/dcache-icache.md) — How btrfs integrates with VFS
- [Copy-on-Write](../mm/cow.md) — CoW mechanism from mm perspective
- `Documentation/filesystems/btrfs.rst`
