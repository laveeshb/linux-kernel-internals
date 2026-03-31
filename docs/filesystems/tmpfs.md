# tmpfs and ramfs

> Memory-backed filesystems with no persistent storage

## What tmpfs is

tmpfs is a filesystem that lives entirely in RAM (and optionally swap). It's backed by the page cache — each file's data is anonymous memory, evictable to swap under memory pressure.

```bash
# Mount a tmpfs
mount -t tmpfs -o size=512m tmpfs /mnt/mytmpfs

# Common uses:
# /tmp — temporary files
# /run — runtime data (PID files, sockets)
# /dev/shm — POSIX shared memory (shm_open)
# container overlays — Docker container upper layers
# /var/cache — build caches
```

## tmpfs vs ramfs

| | tmpfs | ramfs |
|---|-------|-------|
| Size limit | Yes (configurable) | No (can OOM) |
| Swap | Yes (pages evicted to swap) | No (always in RAM) |
| VFS operations | Full (truncate, etc.) | Full |
| Persistence | No (lost on umount) | No (lost on umount) |
| shmem backed | Yes | No |
| Use case | /tmp, /run, shm | embedded with no swap |

## tmpfs implementation

tmpfs is built on top of `shmem` (shared memory) subsystem:

```c
/* mm/shmem.c */
static const struct file_system_type shmem_fs_type = {
    .name           = "tmpfs",
    .init_fs_context = shmem_init_fs_context,
    .kill_sb        = kill_litter_super,
    .fs_flags       = FS_USERNS_MOUNT,
};
```

### shmem inode

```c
struct shmem_inode_info {
    spinlock_t          lock;
    unsigned int        seals;          /* F_SEAL_* for memfd */
    unsigned long       flags;
    unsigned long       alloced;        /* pages allocated */
    unsigned long       swapped;        /* pages swapped out */
    pgoff_t             fallocend;      /* end of fallocate range */
    struct list_head    shrinklist;     /* list of inodes with swap */
    struct list_head    swaplist;       /* link to global swap list */
    struct shared_policy policy;        /* NUMA policy */
    struct simple_xattrs xattrs;
    atomic_long_t       i_direct_seals;
    struct inode        vfs_inode;      /* MUST be last */
};
```

### Page fault path for tmpfs

When a process reads from a tmpfs file and the page isn't in memory:

```c
/* mm/shmem.c: shmem_fault() → shmem_get_folio() */
shmem_get_folio(inode, index, ...)
  → filemap_get_folio()   /* check page cache */
  → if not found:
      shmem_alloc_and_add_folio()
          → alloc_folio(GFP_HIGHUSER)
          → /* if page was swapped: swap_read_folio() */
          → /* otherwise: zero the page */
          → add_to_page_cache()
```

For pages that were swapped out, `shmem_fault` reads them back from swap before returning. This is transparent to the application.

### Size limits

```bash
# Default: half of RAM
mount -t tmpfs tmpfs /tmp

# Explicit size
mount -t tmpfs -o size=1g tmpfs /tmp       # 1GB hard limit
mount -t tmpfs -o size=50% tmpfs /tmp      # 50% of RAM

# nr_inodes limit
mount -t tmpfs -o size=512m,nr_inodes=100k tmpfs /tmp

# Check current usage
df -h /tmp
cat /proc/mounts | grep tmpfs

# tmpfs stats
cat /proc/meminfo | grep -E "Shmem|Swap"
# Shmem:           524288 kB  ← total tmpfs usage
```

### NUMA policy

```bash
# Mount with preferred NUMA node
mount -t tmpfs -o mpol=prefer:0 tmpfs /tmp  # prefer node 0

# Interleave across nodes
mount -t tmpfs -o mpol=interleave tmpfs /tmp

# Bind to specific node
mount -t tmpfs -o mpol=bind:0-1 tmpfs /tmp
```

## devtmpfs: /dev filesystem

devtmpfs is a special tmpfs populated by the kernel with device nodes before udev runs:

```bash
mount | grep devtmpfs
# devtmpfs on /dev type devtmpfs (rw,nosuid,size=...)

# Kernel creates nodes as devices are discovered:
ls -la /dev/sda /dev/null /dev/tty
# brw-rw---- root disk  8, 0  /dev/sda   ← block device (major=8, minor=0)
# crw-rw-rw- root root  1, 3  /dev/null  ← char device
# crw-rw-rw- root tty   5, 0  /dev/tty
```

## tmpfs and Linux's /proc, /sys

Both `/proc` and `/sys` are special pseudo-filesystems built on the same infrastructure:

```c
/* proc_fs_type */
static struct file_system_type proc_fs_type = {
    .name           = "proc",
    .init_fs_context = proc_init_fs_context,
    .kill_sb        = proc_kill_sb,
    .fs_flags       = FS_USERNS_MOUNT,
};

/* sysfs built on kernfs */
static struct file_system_type sysfs_fs_type = {
    .name           = "sysfs",
    .init_fs_context = sysfs_init_fs_context,
    .kill_sb        = sysfs_kill_sb,
    .fs_flags       = FS_USERNS_MOUNT,
};
```

These filesystems don't use backing storage — reads synthesize data from kernel data structures; writes trigger kernel operations.

## Volatile mounts: tmpfs in container use

Containers use tmpfs for writable layers and ephemeral storage:

```bash
# Docker: mount tmpfs for /tmp in container
docker run --tmpfs /tmp:size=512m,mode=1777 ubuntu bash

# Kubernetes: emptyDir with medium: Memory
# Creates a tmpfs mount for the pod's ephemeral volume
```

## Further reading

- [ext4](ext4.md) — Persistent alternative
- [btrfs](btrfs.md) — CoW persistent alternative
- [Memory Management: mmap](../mm/mmap.md) — How tmpfs pages are faulted in
- [IPC: Shared Memory](../ipc/shared-memory.md) — POSIX shm backed by tmpfs
