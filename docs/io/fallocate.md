# fallocate and File Space Management

> Reserving disk blocks without writing data: avoiding ENOSPC, fragmentation, and sparse-file surprises

## The problem with `write()`-based preallocation

The traditional way to guarantee space for a file before filling it is to write zeros:

```c
/* old pattern: write zeros to preallocate 1 GiB */
char zeros[4096] = {0};
for (size_t i = 0; i < (1UL << 30) / sizeof(zeros); i++) {
    write(fd, zeros, sizeof(zeros));
}
```

This has three serious problems:

**It is slow.** Every `write()` dirtied pages must be flushed through the page cache and eventually written to disk. Writing 1 GiB of zeros takes real I/O time even though the data is meaningless.

**It does not prevent ENOSPC mid-write.** Space is only reserved one page at a time as writes arrive. A concurrent process filling the filesystem can trigger `ENOSPC` halfway through the loop, leaving a partially-written file and a caller that must now decide how to recover.

**It causes fragmentation.** The filesystem allocates blocks as writes come in, interleaving them with other concurrent allocations. A large sequential file can end up as hundreds of small extents scattered across the disk.

`fallocate(2)` solves all three: the kernel contacts the filesystem and reserves contiguous extents in a single operation, marking them allocated but not yet written. No I/O occurs. The file size reflects the reservation (or doesn't, depending on the mode). A later `write()` fills already-allocated blocks — it can no longer fail with `ENOSPC` for that range.

```
write()-based preallocation:
  write(zeros) → page cache → writeback → allocate block → ...  (N writes, N allocations)

fallocate(mode=0):
  fallocate() → filesystem allocates extents → done  (1 syscall, contiguous extent)
  write(data) → fills already-allocated blocks (no allocation at write time)
```

## `fallocate()` system call

```c
#include <fcntl.h>

int fallocate(int fd, int mode, off_t offset, off_t len);
```

- `fd` — open file descriptor (must be writable)
- `mode` — zero for the default allocation, or a bitmask of `FALLOC_FL_*` flags
- `offset` — byte offset at which the operation starts
- `len` — length in bytes of the region to operate on

Returns 0 on success, -1 on error. Errors include:

| Error | Meaning |
|-------|---------|
| `ENOSPC` | Not enough space to satisfy the request |
| `EOPNOTSUPP` | Filesystem or mode not supported |
| `EINVAL` | Bad offset/len, or incompatible flags |
| `EBADF` | `fd` not open for writing |
| `ESPIPE` | `fd` is a pipe or FIFO |

The flag constants live in `include/uapi/linux/falloc.h`; the VFS dispatch is in `fs/fallocate.c`.

## Modes overview

| Mode | Constant | Effect |
|------|----------|--------|
| Default | `0` | Allocate blocks; extend file size if needed; fill with zeros |
| Keep size | `FALLOC_FL_KEEP_SIZE` | Allocate blocks; **do not** extend file size |
| Punch hole | `FALLOC_FL_PUNCH_HOLE \| FALLOC_FL_KEEP_SIZE` | Deallocate blocks; reads return zeros |
| Collapse range | `FALLOC_FL_COLLAPSE_RANGE` | Remove bytes from the middle of a file |
| Zero range | `FALLOC_FL_ZERO_RANGE` | Zero a range without removing allocation |
| Insert range | `FALLOC_FL_INSERT_RANGE` | Insert empty space, shifting subsequent data |
| Unshare range | `FALLOC_FL_UNSHARE_RANGE` | Break copy-on-write sharing of reflinked extents |

`FALLOC_FL_PUNCH_HOLE` must always be combined with `FALLOC_FL_KEEP_SIZE`; the kernel rejects `FALLOC_FL_PUNCH_HOLE` alone with `EINVAL`.

## Default allocation (mode = 0)

```c
/* Preallocate a 512 MiB file */
int fd = open("data.bin", O_RDWR | O_CREAT, 0644);
if (fallocate(fd, 0, 0, 512UL << 20) == -1)
    perror("fallocate");
```

After this call:

- `stat(2).st_size` equals 512 MiB — the file size is extended.
- `stat(2).st_blocks` is proportional to 512 MiB — physical blocks are allocated.
- Reading unwritten regions returns zeros, but no I/O is required: the filesystem marks the extents as allocated-but-unwritten.
- Subsequent `write()` calls into the range never need to allocate new blocks and cannot fail with `ENOSPC` for that range.

### Effect on `st_size` vs `st_blocks`

```
Before fallocate:
  st_size   = 0
  st_blocks = 0

After fallocate(fd, 0, 0, 512MiB):
  st_size   = 536870912   (512 * 1024 * 1024)
  st_blocks = 1048576     (in 512-byte units: 512MiB / 512)

After fallocate(fd, FALLOC_FL_KEEP_SIZE, 0, 512MiB):
  st_size   = 0           (unchanged!)
  st_blocks = 1048576     (blocks still allocated)
```

### Sparse file detection: `du` vs `ls`

`ls -l` reports `st_size` (logical size). `du` reports `st_blocks` (physical allocation). A sparse file shows a large `ls -l` size but a small `du` result:

```bash
# Create a 1 GiB sparse file (ftruncate, no blocks)
truncate -s 1G sparse.bin
ls -lh sparse.bin          # 1.0G
du -sh sparse.bin          # 4.0K  (only the inode)

# Preallocate 1 GiB (fallocate, actual blocks)
fallocate -l 1G preallocated.bin
ls -lh preallocated.bin    # 1.0G
du -sh preallocated.bin    # 1.1G  (actual disk usage)
```

### Filesystem-specific behavior

**ext4**: Uses extent preallocation (`ext4_fallocate` in `fs/ext4/extents.c`). Creates unwritten extents — the extent tree marks the range as `EXT_UNWRITTEN`. Reads from unwritten extents return zeros without disk I/O. On the first write to a block, the extent is converted to written.

**XFS**: Calls `xfs_alloc_file_space`, which creates unwritten extents in the B-tree. XFS was the first Linux filesystem to implement `fallocate`-style preallocation via `XFS_IOC_ALLOCSP`.

**btrfs**: Supports `fallocate` but may produce more fragmentation over time due to copy-on-write semantics: overwriting preallocated blocks creates new extents rather than updating in place (unless `nodatacow` is set for the file).

**tmpfs**: Supports `fallocate` for in-memory files; blocks are DRAM pages. Hole punching is also supported.

## `FALLOC_FL_KEEP_SIZE`: preallocate without extending

This mode allocates physical blocks but leaves `st_size` unchanged. It is the canonical pattern for write-ahead log (WAL) preallocation:

```c
/*
 * PostgreSQL-style WAL segment preallocation.
 * The file appears empty (st_size=0) but blocks are already reserved.
 * When the WAL writer calls write(), it fills pre-allocated blocks.
 */
int preallocate_wal_segment(const char *path, size_t segment_size)
{
    int fd = open(path, O_RDWR | O_CREAT, 0600);
    if (fd < 0)
        return -1;

    /* Reserve blocks; file size stays 0 */
    if (fallocate(fd, FALLOC_FL_KEEP_SIZE, 0, segment_size) == -1) {
        /* Fall back to writing zeros if fallocate unsupported */
        if (errno == EOPNOTSUPP)
            return write_zeros(fd, segment_size);
        close(fd);
        return -1;
    }
    close(fd);
    return 0;
}
```

Why keep size at zero? The consuming process (the WAL applier) must not see the file as having data until the WAL writer says so. `st_size` is the authoritative "how much data is here" signal; `st_blocks` is a storage-layer detail.

## `FALLOC_FL_PUNCH_HOLE`: reclaiming space within a file

Hole punching deallocates blocks in the middle of a file without changing `st_size`. The punched region becomes a sparse hole: reads return zeros, but no disk blocks are consumed.

```c
#include <linux/falloc.h>

/*
 * Punch a hole from byte 'offset' for 'len' bytes.
 * FALLOC_FL_KEEP_SIZE is mandatory with FALLOC_FL_PUNCH_HOLE.
 */
int punch_hole(int fd, off_t offset, off_t len)
{
    return fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE,
                     offset, len);
}
```

### Use cases

**Log rotation**: Rather than unlinking and recreating a log file (which breaks open file descriptors held by other processes), punch the consumed region:

```c
/* Process has read bytes [0, consumed_offset). Reclaim the space. */
punch_hole(log_fd, 0, consumed_offset);
/* st_size unchanged; readers still see the file at its original size */
```

**Database free-list management**: Databases that manage their own free lists (like PostgreSQL's heap pages marked as dead) can punch holes over freed page ranges, returning blocks to the filesystem without truncating the file.

**Large media files**: Video editing tools can punch holes over deleted frame ranges, reclaiming space while keeping the file structure intact.

### Iterating holes with `SEEK_HOLE` / `SEEK_DATA`

After punching holes, use `lseek(2)` with `SEEK_HOLE` and `SEEK_DATA` to find the boundaries of data and sparse regions:

```c
#include <unistd.h>
#include <stdio.h>

/*
 * Print all data and hole extents in a file.
 * SEEK_DATA: seek to next data region at or after offset.
 * SEEK_HOLE: seek to next hole at or after offset.
 * A file always ends with a virtual hole at st_size.
 */
void print_extents(int fd, off_t file_size)
{
    off_t pos = 0;

    while (pos < file_size) {
        off_t data_start = lseek(fd, pos, SEEK_DATA);
        if (data_start == -1)
            break;  /* no more data: rest is a hole */

        off_t hole_start = lseek(fd, data_start, SEEK_HOLE);
        if (hole_start == -1)
            hole_start = file_size;  /* data extends to end */

        printf("  data: [%lld, %lld)  (%lld bytes)\n",
               (long long)data_start,
               (long long)hole_start,
               (long long)(hole_start - data_start));

        /* Find where the hole ends */
        off_t next_data = lseek(fd, hole_start, SEEK_DATA);
        if (next_data == -1)
            next_data = file_size;

        if (hole_start < next_data)
            printf("  hole: [%lld, %lld)  (%lld bytes)\n",
                   (long long)hole_start,
                   (long long)next_data,
                   (long long)(next_data - hole_start));

        pos = next_data;
    }
}
```

`SEEK_HOLE` and `SEEK_DATA` were standardized in POSIX 2013 and are supported on ext4, XFS, btrfs, and tmpfs. On filesystems that do not support them, `SEEK_HOLE` returns `st_size` (the whole file appears to be data).

## `FALLOC_FL_ZERO_RANGE`: zeroing without punching

`FALLOC_FL_ZERO_RANGE` zeros a region of a file efficiently. Unlike punch-hole, the blocks remain allocated. Unlike writing zeros through `write()`, the filesystem may implement this as metadata-only if the region aligns to block boundaries:

```c
/* Zero bytes [offset, offset+len) without deallocating blocks */
fallocate(fd, FALLOC_FL_ZERO_RANGE, offset, len);

/* Optionally avoid extending file size (mirror KEEP_SIZE behavior) */
fallocate(fd, FALLOC_FL_ZERO_RANGE | FALLOC_FL_KEEP_SIZE, offset, len);
```

On ext4 and XFS, aligned zero-range requests convert written extents to unwritten extents in the extent tree — the same representation as freshly preallocated blocks. No actual zero bytes are written to disk; the filesystem's read path synthesizes them. For unaligned edges, partial blocks are read, zeroed, and written back.

## `FALLOC_FL_COLLAPSE_RANGE`: removing a file section

`FALLOC_FL_COLLAPSE_RANGE` removes `len` bytes starting at `offset` from a file, shifting all subsequent data down. No hole is left: the file shrinks by `len` bytes. Both `offset` and `len` must be multiples of the filesystem block size.

```c
/* Remove 1 MiB starting at offset 4 MiB, shifting the rest down */
fallocate(fd, FALLOC_FL_COLLAPSE_RANGE, 4UL << 20, 1UL << 20);
```

This is useful for in-place log compaction: rather than copying the remaining data into a new file, collapse the consumed head. Supported on ext4 (since 3.15) and XFS (since 3.15). btrfs does not support it.

## `FALLOC_FL_INSERT_RANGE`: inserting space

The inverse of collapse: `FALLOC_FL_INSERT_RANGE` inserts `len` zero bytes at `offset`, shifting subsequent data up. The file grows by `len`. Both values must be block-size aligned.

```c
/* Insert 512 KiB at offset 2 MiB */
fallocate(fd, FALLOC_FL_INSERT_RANGE, 2UL << 20, 512UL << 10);
```

Supported on ext4 (since 4.1) and XFS (since 4.1). Rarely used in practice.

## `FALLOC_FL_UNSHARE_RANGE`: breaking reflink sharing

On copy-on-write filesystems that support reflinks (btrfs, XFS), `cp --reflink` creates a file that shares extent tree entries with the original. A write to either file triggers copy-on-write to a new extent.

`FALLOC_FL_UNSHARE_RANGE` forces the kernel to physically copy the shared data, breaking the sharing relationship:

```c
struct stat st;
fstat(fd, &st);

/* Force all shared extents to become private copies */
fallocate(fd, FALLOC_FL_UNSHARE_RANGE, 0, st.st_size);
```

This is useful before intensive random writes to a reflinked file: without unsharing, every write triggers a COW allocation and potentially scatters extents. After unsharing, writes are in-place and contiguous (assuming the file was not already fragmented).

!!! note "Filesystem implementation differences"
    XFS has a native, efficient kernel-level unshare implementation that operates on extent metadata directly. btrfs does not have a native kernel-level unshare operation for this flag and falls back to a read-rewrite path, which is less efficient and produces I/O proportional to file size.

See [Copy-on-write filesystems](#copy-on-write-filesystems-btrfs-and-xfs) below for the broader context.

## `posix_fallocate()`: the POSIX fallback

```c
#include <fcntl.h>

int posix_fallocate(int fd, off_t offset, off_t len);
```

`posix_fallocate()` is a libc function (not a direct syscall) that guarantees space reservation. If the kernel supports `fallocate(fd, 0, offset, len)`, glibc calls it directly. If not — on NFS, CIFS, or old kernels — glibc falls back to writing zeros:

```c
/* glibc sysdeps/unix/sysv/linux/posix_fallocate.c (simplified) */
int posix_fallocate(int fd, off_t offset, off_t len)
{
    int ret = fallocate(fd, 0, offset, len);
    if (ret == 0)
        return 0;
    if (errno != EOPNOTSUPP)
        return errno;

    /* Fallback: write zeros the slow way */
    return write_zeros_range(fd, offset, len);
}
```

The fallback is correct but slow and still subject to ENOSPC mid-write. Prefer calling `fallocate(2)` directly and handling `EOPNOTSUPP` yourself when you care about performance.

## `ftruncate()` vs `fallocate()`

`ftruncate(fd, new_size)` and `fallocate(fd, 0, 0, new_size)` both extend a file to `new_size`, but they do fundamentally different things:

| Aspect | `ftruncate(fd, size)` | `fallocate(fd, 0, 0, size)` |
|--------|----------------------|----------------------------|
| Blocks allocated | No (sparse) | Yes (real blocks) |
| `st_size` | Set to `size` | Set to `size` |
| `st_blocks` | Unchanged (nearly 0) | Proportional to `size` |
| Later write can ENOSPC | Yes | No (blocks already reserved) |
| Fragmentation risk | None at extend time | None (extent is contiguous) |
| Disk usage | Near zero | Full `size` |
| Speed | Instant (metadata only) | Proportional to `size` |

```c
/* ftruncate: creates a 1 GiB sparse file */
ftruncate(fd, 1UL << 30);
/* st_size=1GiB, st_blocks≈8 (just inode), disk usage: ~4KiB */

/* fallocate: creates a 1 GiB preallocated file */
fallocate(fd, 0, 0, 1UL << 30);
/* st_size=1GiB, st_blocks=2097152, disk usage: ~1GiB */
```

When shrinking, both `ftruncate(fd, smaller_size)` and `fallocate(fd, 0, 0, smaller_size)` truncate the file. Use `ftruncate` for truncation — `fallocate` is not documented for shrinking below the current size, and behavior is filesystem-dependent.

## Practical use cases with code

### 1. Download file reservation

Preallocate the full file size before a download begins to guarantee space and avoid fragmentation:

```c
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>

int create_download_file(const char *path, off_t expected_size)
{
    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
    if (fd < 0)
        return -1;

    if (fallocate(fd, 0, 0, expected_size) == -1) {
        if (errno == EOPNOTSUPP) {
            /*
             * Filesystem doesn't support fallocate.
             * Fall back to ftruncate: creates a sparse file.
             * ENOSPC is possible during the actual download.
             */
            if (ftruncate(fd, expected_size) == -1) {
                close(fd);
                return -1;
            }
        } else {
            /* ENOSPC or other real error */
            close(fd);
            return -1;
        }
    }

    return fd;  /* caller writes download data via pwrite() */
}
```

### 2. WAL/journal preallocation (PostgreSQL pattern)

```c
#include <fcntl.h>
#include <linux/falloc.h>

/*
 * Preallocate a WAL segment file.
 * Use KEEP_SIZE so the file appears empty to WAL readers.
 * The writer fills it via sequential write() calls.
 */
int preallocate_wal(const char *path, size_t wal_segment_size)
{
    int fd = open(path, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd < 0)
        return -1;

    int ret = fallocate(fd, FALLOC_FL_KEEP_SIZE, 0, wal_segment_size);
    if (ret == -1 && errno != EOPNOTSUPP) {
        close(fd);
        return -1;
    }

    close(fd);
    return 0;
}
```

### 3. Log file rotation with hole punching

```c
#include <fcntl.h>
#include <linux/falloc.h>
#include <sys/stat.h>

/*
 * After a consumer has processed log bytes [0, consumed_up_to),
 * punch the consumed region to return disk space.
 * The file descriptor stays open; active writers are unaffected.
 */
int reclaim_consumed_log(int fd, off_t consumed_up_to)
{
    struct stat st;
    if (fstat(fd, &st) == -1)
        return -1;

    /* Align to filesystem block size */
    long blksz = st.st_blksize;
    off_t aligned_end = (consumed_up_to / blksz) * blksz;

    if (aligned_end <= 0)
        return 0;   /* nothing to punch yet */

    return fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE,
                     0, aligned_end);
}
```

### 4. Sparse file creation and hole inspection

```c
#include <fcntl.h>
#include <linux/falloc.h>
#include <stdio.h>
#include <unistd.h>

int main(void)
{
    const char *path = "sparse_demo.bin";
    const off_t size = 10UL << 20;  /* 10 MiB file */

    /* Create a 10 MiB preallocated file */
    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
    fallocate(fd, 0, 0, size);

    /* Write data in two 1 MiB blocks */
    char buf[1 << 20];
    memset(buf, 'A', sizeof(buf));
    pwrite(fd, buf, sizeof(buf), 0);           /* bytes [0, 1MiB) */
    pwrite(fd, buf, sizeof(buf), 4 << 20);     /* bytes [4MiB, 5MiB) */

    /* Punch holes in the regions we don't need */
    fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE,
              1 << 20, 3 << 20);               /* punch [1MiB, 4MiB) */
    fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE,
              5 << 20, 5 << 20);               /* punch [5MiB, 10MiB) */

    /* Iterate extents using SEEK_DATA / SEEK_HOLE */
    printf("Extents in %s:\n", path);
    off_t pos = 0;
    while (pos < size) {
        off_t data = lseek(fd, pos, SEEK_DATA);
        if (data == -1) break;

        off_t hole = lseek(fd, data, SEEK_HOLE);
        if (hole == -1) hole = size;

        printf("  data [%lld, %lld)\n", (long long)data, (long long)hole);
        pos = lseek(fd, hole, SEEK_DATA);
        if (pos == -1) break;
    }

    close(fd);
    return 0;
}
/*
 * Output:
 *   data [0, 1048576)
 *   data [4194304, 5242880)
 */
```

## Filesystem support matrix

| Mode | ext4 | XFS | btrfs | tmpfs | NFS | CIFS |
|------|------|-----|-------|-------|-----|------|
| `mode=0` (allocate) | Yes | Yes | Yes | Yes | No* | No* |
| `FALLOC_FL_KEEP_SIZE` | Yes | Yes | Yes | Yes | No* | No* |
| `FALLOC_FL_PUNCH_HOLE` | Yes (3.0+) | Yes | Yes | Yes | Partial† | Partial |
| `FALLOC_FL_COLLAPSE_RANGE` | Yes (3.15+) | Yes (3.15+) | No | No | No | No |
| `FALLOC_FL_ZERO_RANGE` | Yes (3.15+) | Yes | Yes | No | No | No |
| `FALLOC_FL_INSERT_RANGE` | Yes (4.1+) | Yes (4.1+) | No | No | No | No |
| `FALLOC_FL_UNSHARE_RANGE` | No | Yes | Yes | No | No | No |

\* NFS (for modes other than `FALLOC_FL_PUNCH_HOLE`) and CIFS may support some modes depending on the server-side filesystem. `fallocate` over NFS typically returns `EOPNOTSUPP` from the client, causing `posix_fallocate` to fall back to writing zeros.

† NFSv4.2 clients support hole punching via the `DEALLOCATE` NFS operation when the server-side filesystem also supports it. NFSv3, NFSv4.0, and NFSv4.1 do not support `FALLOC_FL_PUNCH_HOLE` and return `EOPNOTSUPP`.

Always check for `EOPNOTSUPP` and have a fallback:

```c
ret = fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE,
                offset, len);
if (ret == -1 && errno == EOPNOTSUPP) {
    /* Filesystem doesn't support hole punching.
     * Options: write zeros (keeps space used), or ignore. */
}
```

## Copy-on-write filesystems: btrfs and XFS

### Reflinks and `cp --reflink`

btrfs and XFS support *reflinks*: a file copy that shares extent tree entries with the original. A `cp --reflink` is nearly instant and uses no additional disk space until one of the files is modified:

```bash
# Create a 1 GiB file, then reflink-copy it (instant, no extra space)
fallocate -l 1G original.bin
cp --reflink=always original.bin copy.bin
du -sh original.bin copy.bin   # both show ~1GiB but share the blocks
```

When a reflinked block is written, the filesystem performs copy-on-write: the writing process gets a new private extent, and the other file's extent remains unchanged.

### `copy_file_range` and kernel-side reflinks

`copy_file_range(2)` asks the kernel to copy a range between files. On reflink-capable filesystems, the kernel may satisfy this as a metadata-only clone operation rather than copying bytes:

```c
#include <sys/sendfile.h>
/* Actually: */
#include <unistd.h>

ssize_t copy_file_range(int fd_in, loff_t *off_in,
                         int fd_out, loff_t *off_out,
                         size_t len, unsigned int flags);
```

For block-aligned ranges on XFS or btrfs with matching block sizes, this becomes a reflink clone — O(extents), effectively constant for single-extent files, but scales with extent count for heavily fragmented files. For other cases it falls back to a read/write loop.

### Fragmentation over time with COW

COW filesystems accumulate fragmentation for frequently overwritten files. Each overwrite creates a new extent; the extent tree grows; sequential reads become random I/O. `FALLOC_FL_UNSHARE_RANGE` is one tool to combat this: it consolidates shared extents into a single contiguous private allocation.

For databases on btrfs, the standard recommendation is to disable data COW for database files:

```bash
# Disable COW on a directory (new files inherit the flag)
chattr +C /var/lib/postgresql/

# Or on an existing file (must be empty)
chattr +C database.db
```

With `+C` (nodatacow), `fallocate` and `write` behave more like they do on ext4: in-place updates without per-block copy-on-write.

### Detecting extent sharing

On XFS and btrfs, the `FIEMAP` ioctl with the `FIEMAP_EXTENT_SHARED` flag indicates shared extents:

```c
#include <linux/fiemap.h>
#include <linux/fs.h>
#include <sys/ioctl.h>

/* Check if any extents in the file are shared (reflinked) */
int has_shared_extents(int fd)
{
    struct {
        struct fiemap fm;
        struct fiemap_extent fe[64];
    } buf;

    memset(&buf, 0, sizeof(buf));
    buf.fm.fm_length = FIEMAP_MAX_OFFSET;
    buf.fm.fm_extent_count = 64;
    buf.fm.fm_flags = FIEMAP_FLAG_SYNC;

    if (ioctl(fd, FS_IOC_FIEMAP, &buf.fm) == -1)
        return -1;

    for (uint32_t i = 0; i < buf.fm.fm_mapped_extents; i++) {
        if (buf.fm.fm_extents[i].fe_flags & FIEMAP_EXTENT_SHARED)
            return 1;
    }
    return 0;
}
```

## Kernel internals

The VFS entry point for `fallocate` is `vfs_fallocate()` in `fs/fallocate.c`:

```c
/* fs/fallocate.c */
int vfs_fallocate(struct file *file, int mode, loff_t offset, loff_t len)
{
    struct inode *inode = file_inode(file);

    /* Basic sanity checks */
    if (offset < 0 || len <= 0)
        return -EINVAL;
    if (mode & ~(FALLOC_FL_KEEP_SIZE | FALLOC_FL_PUNCH_HOLE |
                 FALLOC_FL_COLLAPSE_RANGE | FALLOC_FL_ZERO_RANGE |
                 FALLOC_FL_INSERT_RANGE | FALLOC_FL_UNSHARE_RANGE))
        return -EOPNOTSUPP;

    /* Filesystem must implement fallocate */
    if (!file->f_op->fallocate)
        return -EOPNOTSUPP;

    /* Security and quota checks */
    ret = security_file_permission(file, MAY_WRITE);
    if (ret)
        return ret;

    return file->f_op->fallocate(file, mode, offset, len);
}
```

Each filesystem provides its own `fallocate` operation. For ext4:

```c
/* fs/ext4/extents.c (simplified) */
long ext4_fallocate(struct file *file, int mode, loff_t offset, loff_t len)
{
    struct inode *inode = file_inode(file);

    if (mode & FALLOC_FL_PUNCH_HOLE)
        return ext4_punch_hole(file, offset, len);
    if (mode & FALLOC_FL_COLLAPSE_RANGE)
        return ext4_collapse_range(inode, offset, len);
    if (mode & FALLOC_FL_ZERO_RANGE)
        return ext4_zero_range(file, offset, len, mode);
    if (mode & FALLOC_FL_INSERT_RANGE)
        return ext4_insert_range(inode, offset, len);

    /* Default: allocate unwritten extents */
    return ext4_alloc_file_blocks(file, lblk, max_blocks,
                                   new_size, flags);
}
```

The flags constant definitions are in `include/uapi/linux/falloc.h`:

```c
/* include/uapi/linux/falloc.h */
#define FALLOC_FL_KEEP_SIZE      0x01
#define FALLOC_FL_PUNCH_HOLE     0x02
#define FALLOC_FL_NO_HIDE_STALE  0x04  /* internal, not for userspace */
#define FALLOC_FL_COLLAPSE_RANGE 0x08
#define FALLOC_FL_ZERO_RANGE     0x10
#define FALLOC_FL_INSERT_RANGE   0x20
#define FALLOC_FL_UNSHARE_RANGE  0x40
```

## Further reading

- [Buffered I/O and the Page Cache](buffered-io.md) — page cache interaction with preallocated extents
- [Direct I/O](direct-io.md) — bypassing the page cache for O_DIRECT writes into preallocated ranges
- [Life of a Write](life-of-a-write.md) — how `write()` interacts with preallocated (unwritten) extents
- [VFS: File Operations](../vfs/file-ops.md) — `f_op->fallocate` dispatch
- [splice, sendfile, copy_file_range](../vfs/splice-sendfile.md) — kernel-side reflink copies
- [btrfs](../filesystems/btrfs.md) — COW semantics and extent sharing
- [XFS](../filesystems/xfs.md) — extent B-tree and preallocation history
- `fs/fallocate.c` — VFS `vfs_fallocate()` implementation
- `include/uapi/linux/falloc.h` — `FALLOC_FL_*` flag definitions
- `fs/ext4/extents.c` — `ext4_fallocate()` and unwritten extent handling
