# Filesystems

> How data is organized and persisted on storage

## The filesystem stack

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
     Page cache           ← in-memory cache of disk blocks
          │
          ▼
   Block layer (bio)      ← submits I/O to disk
          │
          ▼
    Block device          ← NVMe, SATA, virtio-blk
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [ext4](ext4.md) | On-disk layout, extents, journaling with jbd2 |
| [tmpfs and ramfs](tmpfs.md) | Memory-backed filesystems, size limits |
| [btrfs](btrfs.md) | Copy-on-Write B-tree, subvolumes, snapshots |

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
