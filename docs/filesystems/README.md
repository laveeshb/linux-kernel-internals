# Filesystems

> How the kernel turns a flat array of disk blocks into named files with metadata — and keeps them consistent across a crash

## Getting Started

A block device is a linear array of fixed-size sectors; a *filesystem* is the code that imposes structure on it — a hierarchy of named files, their contents, and the metadata (sizes, timestamps, permissions, block maps) that ties them together. The structure is the easy part. The hard part is keeping it *consistent* when power fails mid-write — and almost every design decision a Linux filesystem makes is, at bottom, an answer to "how do we not corrupt everything on a crash?"

This section explains the *why* behind the major Linux filesystems — the trade-offs behind journaling versus copy-on-write, extents versus block maps, in-place updates versus never overwriting — not just their on-disk formats.

```
Application: open("/data/file", O_RDONLY)
          │
          ▼
     VFS layer            ← generic operations (see vfs/)
          │
          ▼
  Filesystem driver       ← ext4, btrfs, xfs, tmpfs, ...
          │
          ▼
     Page cache           ← in-memory cache of file data
          │
          ▼
   Block layer (bio)      ← submits I/O to disk
          │
          ▼
    Block device          ← NVMe, SATA, virtio-blk
```

### The one question every filesystem answers

Writing a file touches several places on disk — the data blocks, the block map, the inode, the free-space bitmap. A crash *between* those writes leaves the filesystem inconsistent: an inode pointing at blocks the allocator still thinks are free, or data in blocks the inode doesn't yet reference. There are two dominant strategies:

- **Journaling** (ext4, XFS) — write the intended changes to a **log** first and commit them atomically, then apply them in place. After a crash, replay the log. Updates still happen *in place*, but the journal makes them recoverable.
- **Copy-on-write** (btrfs) — never overwrite live data. Write new versions into free space, then atomically flip a single pointer to the new tree root. A crash simply leaves the old, consistent tree intact.

Nearly everything else — extents, delayed allocation, snapshots, checksums — follows from committing to one of these.

### Prerequisites

Familiarity with the [VFS](../vfs/README.md) (the layer above, which dispatches operations to these filesystems), the [page cache](../mm/page-cache.md) (where file data lives in memory), and the [block layer](../block/README.md) (below, which carries the I/O to the device).

### Suggested reading order

1. **[ext4](ext4.md)** — the default: extents, and journaling with jbd2
2. **[ext4 Journaling Deep Dive](ext4-journal.md)** — jbd2 internals; ordered vs. journaled data modes
3. **[XFS](xfs.md)** — allocation groups, delayed allocation, and a log built for scale
4. **[btrfs](btrfs.md)** — the copy-on-write B-tree, subvolumes, and snapshots
5. **[tmpfs and ramfs](tmpfs.md)** — a filesystem with no disk at all
6. **[overlayfs](overlayfs.md)** — union mounts and copy-up, the basis of container images

### What you'll learn

| Textbook idea | Linux reality |
|---|---|
| "The filesystem writes files to disk" | It writes to the [page cache](../mm/page-cache.md); the real disk write is deferred to writeback, which is why [`fsync()`](../io/page-cache-writeback.md) exists |
| "A journal logs everything" | ext4 defaults to journaling *metadata* only (`data=ordered`); full data journaling exists but roughly halves write throughput |
| "Copy-on-write means snapshots" | CoW is a *crash-consistency* strategy first; snapshots fall out of it for free, because old tree roots are never overwritten |
| "Deleting a file frees its space" | Only the metadata immediately; actual reclamation on SSDs involves discard/TRIM, and on CoW filesystems, reference counting |

## Documentation

| Page | What it covers |
|------|----------------|
| [ext4](ext4.md) | On-disk layout, extents, journaling with jbd2 |
| [ext4 Journaling Deep Dive](ext4-journal.md) | jbd2 internals, ordered vs journaled data |
| [XFS](xfs.md) | Allocation groups, delayed allocation, log design |
| [btrfs](btrfs.md) | Copy-on-Write B-tree, subvolumes, snapshots |
| [tmpfs and ramfs](tmpfs.md) | Memory-backed filesystems, size limits |
| [overlayfs](overlayfs.md) | Union mounts, copy-up, container layers |

## Choosing a filesystem

| Filesystem | Use case | Key feature |
|-----------|---------|-------------|
| ext4 | General purpose, servers | Stable, journaled |
| btrfs | Desktop, NAS | CoW, snapshots, RAID |
| xfs | High-performance servers | High scalability |
| tmpfs | /tmp, /run, shared memory | RAM-backed, fast |
| overlayfs | Container images | Union of layers |
| squashfs | Read-only (LiveCD, containers) | Compressed, read-only |
| erofs | Android, embedded | Compressed, fast read |

## Further reading

- [Kernel docs: filesystems](https://docs.kernel.org/filesystems/index.html) — per-filesystem and VFS reference
- [VFS](../vfs/README.md) · [page cache](../mm/page-cache.md) · [block layer](../block/README.md) — the layers above and below
