# Direct I/O

> O_DIRECT: bypassing the page cache for predictable I/O latency

## What O_DIRECT does

By default, `read()` and `write()` go through the **page cache** — the kernel reads disk data into DRAM pages and serves reads from there. Writes go to dirty pages, which are flushed asynchronously.

O_DIRECT bypasses the page cache:

```
Buffered I/O:
  write() → page cache (dirty page) → [async] → disk
  read()  ← page cache ← [lazy] ← disk

O_DIRECT:
  write() → disk (synchronous, no page cache)
  read()  ← disk (synchronous, no page cache)
```

## Why use O_DIRECT?

**Databases (PostgreSQL, MySQL InnoDB, Oracle)**: Databases implement their own buffer pool. Routing I/O through both the database buffer and the OS page cache wastes DRAM. O_DIRECT gives the database full control:

```
Without O_DIRECT:
  DB buffer (8GB) + OS page cache (partial duplication) = wasted RAM

With O_DIRECT:
  DB buffer (8GB) = all RAM goes to the database
```

**Predictable latency**: Page cache writeback can cause surprising latency spikes when dirty pages are flushed. O_DIRECT writes complete when the data reaches the drive.

**NUMA-aware memory**: O_DIRECT allows passing NUMA-local buffers to the kernel, avoiding cache effects across NUMA nodes.

## Alignment requirements

O_DIRECT has strict alignment requirements. Violating them returns `EINVAL`:

```c
#define SECTOR_SIZE 512    /* minimum for most drives */
#define BLOCK_SIZE  4096   /* filesystem block size */

/* All three must be aligned to logical block size (usually 512B or 4096B): */
/* 1. File offset */
/* 2. Buffer address */
/* 3. Transfer length */

/* Correct: 4096-byte aligned everything */
void *buf;
posix_memalign(&buf, 4096, 4096);   /* 4096-byte aligned buffer */

int fd = open("file", O_RDWR | O_DIRECT);
pread(fd, buf, 4096, 0);    /* offset=0, len=4096 → OK */
pread(fd, buf, 4096, 512);  /* offset=512, len=4096 → EINVAL on many FS */
pread(fd, buf, 512, 0);     /* len=512 → may work (if blksize=512) */
```

### Checking the required alignment

```c
#include <sys/ioctl.h>
#include <linux/fs.h>

int blksz;
ioctl(fd, BLKSSZGET, &blksz);   /* logical block size */
/* or */
struct stat st;
fstat(fd, &st);
/* st.st_blksize = preferred I/O block size */

/* For block devices: */
ioctl(fd, BLKPBSZGET, &blksz);  /* physical block size (may be 4096) */
```

## O_DIRECT in the kernel

```c
/* fs/read_write.c */
static ssize_t do_loop_readv_writev(struct file *filp, struct iov_iter *iter,
                                     loff_t *ppos, int type, rwf_t flags)
{
    /* O_DIRECT path for block-aligned I/O */
    if (filp->f_flags & O_DIRECT) {
        return filp->f_op->read_iter(kiocb, iter);
        /* → generic_file_direct_write → filemap_write_and_wait_range +
             filp->f_mapping->a_ops->direct_IO */
    }
    /* ... buffered path ... */
}

/* Per-filesystem direct_IO implementation: */
/* ext4_direct_IO → iomap_dio_rw → bio submission */
static ssize_t ext4_direct_IO(struct kiocb *iocb, struct iov_iter *iter)
{
    struct inode *inode = iocb->ki_filp->f_mapping->host;
    size_t count = iov_iter_count(iter);

    /* Must flush dirty pages in range (coherency: page cache may have newer data) */
    ret = filemap_write_and_wait_range(inode->i_mapping, offset,
                                        offset + count - 1);
    if (ret)
        return ret;

    /* Submit DIO: goes directly to the block layer */
    return iomap_dio_rw(iocb, iter, &ext4_iomap_ops,
                         &ext4_dio_write_ops, 0, 0, 0);
}
```

## iomap DIO: modern direct I/O path

Since 4.10, most filesystems use the `iomap` layer for direct I/O:

```c
/* fs/iomap/direct-io.c */
ssize_t iomap_dio_rw(struct kiocb *iocb, struct iov_iter *iter,
                      const struct iomap_ops *ops,
                      const struct iomap_dio_ops *dops,
                      unsigned int dio_flags,
                      void *private, size_t done_before)
{
    struct iomap_dio *dio;

    /* Map file blocks to physical addresses */
    while (iov_iter_count(iter)) {
        ret = iomap_apply(inode, pos, count, flags, ops, dio,
                           iomap_dio_iter);
    }

    /* Wait for all bios to complete (sync DIO) */
    if (!is_sync_kiocb(iocb))
        return -EIOCBQUEUED;  /* async: caller will wait */

    wait_for_completion_io(&dio->done);
    return dio->size;
}
```

## O_DIRECT vs mmap

| Aspect | O_DIRECT | mmap |
|--------|----------|------|
| Page cache | Bypassed | Used |
| Zero-copy | With DMA (buffer directly addressed) | Copy from page cache |
| Random access | `pread(fd, buf, len, offset)` | `memcpy(buf, mmap_ptr + offset, len)` |
| CPU cost | Syscall per I/O | After fault: load instructions |
| Alignment | Strict sector alignment | None (page granularity) |
| Scatter-gather | `preadv(fd, iov, n, offset)` | Natural (pointer arithmetic) |
| Typical use | Databases | Search engines, key-value stores |

## O_DSYNC and O_SYNC: write durability

```c
/* O_SYNC: fsync() after every write (metadata + data durable) */
int fd = open("file", O_WRONLY | O_SYNC);

/* O_DSYNC: only data durable (no metadata sync for performance) */
int fd = open("file", O_WRONLY | O_DSYNC);

/* fsync() manually: flush buffered writes to disk */
write(fd, data, len);
fsync(fd);  /* or fdatasync(fd) for data only */
```

## O_DIRECT performance tips

```c
/* Use io_uring with IORING_OP_READ_FIXED for best O_DIRECT performance */
/* Register buffers once: */
struct iovec iov[1] = {{ .iov_base = buf, .iov_len = BUF_SIZE }};
io_uring_register_buffers(ring, iov, 1);

/* Submit with registered buffer (no per-op mapping) */
struct io_uring_sqe *sqe = io_uring_get_sqe(ring);
io_uring_prep_read_fixed(sqe, fd, buf, BUF_SIZE, offset, 0);
io_uring_submit(ring);
```

## Further reading

- [Async I/O evolution](async-io.md) — AIO, io_uring for O_DIRECT
- [io_uring: Operations](../io-uring/io-uring-ops.md) — IORING_OP_READ_FIXED
- [Block Layer: bio and request](../block/bio-request.md) — bio submission from DIO
- [Memory Management: page cache](../mm/page-cache.md) — what O_DIRECT bypasses
- `fs/iomap/direct-io.c` — modern DIO implementation
- `Documentation/filesystems/dax.txt` — DAX for PMEM
