# Virtual Filesystem (VFS)

> The kernel's filesystem abstraction layer

## What is VFS?

The Virtual Filesystem Switch (VFS) is an abstraction layer that allows the kernel to support many different filesystems (ext4, btrfs, tmpfs, procfs, NFS...) through a common interface. When your program calls `read()`, it goes through VFS, which dispatches to the appropriate filesystem implementation.

VFS makes the following possible:
- A single `open()`, `read()`, `write()` API works for ext4, NFS, /proc, /sys, pipes, and sockets
- Files can be accessed across mounted filesystems transparently
- Filesystems can be developed as kernel modules

## The four VFS objects

VFS defines four core objects:

| Object | Represents | Kernel struct |
|--------|-----------|---------------|
| Superblock | A mounted filesystem instance | `struct super_block` |
| Inode | A file or directory | `struct inode` |
| Dentry | A path component (name → inode mapping) | `struct dentry` |
| File | An open file (open() creates one) | `struct file` |

Each has an associated operations table (vtable) that the filesystem must implement:

| Object | Operations struct |
|--------|------------------|
| Superblock | `struct super_operations` |
| Inode | `struct inode_operations` |
| Dentry | `struct dentry_operations` |
| File | `struct file_operations` |

## Contents

### Fundamentals
- [VFS Objects: superblock, inode, dentry, file](vfs-objects.md) — The four core objects in detail
- [Path Resolution](namei.md) — How `/usr/bin/bash` becomes an inode
- [File Operations](file-ops.md) — The file_operations vtable and open/read/write
- [Filesystem Registration and Mounting](mounting.md) — How filesystems plug into VFS

### Lifecycle
- [Life of a write() syscall](life-of-write.md) — From write() to disk
- [Dentry and Inode Caches](dcache-icache.md) — Caching for performance
