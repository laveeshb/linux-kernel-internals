# Writes Are Not Atomic

> What "atomicity" means for file writes in Linux, and why it is weaker than most programmers assume

## The assumption that breaks things

Many programs assume that a `write()` call either writes all the data or nothing. This is not what POSIX guarantees, and it is not what Linux delivers.

```c
/* This looks safe. It is not. */
write(fd, large_buffer, 1024 * 1024);
/* Could write 0, 512, 65536, or 1048576 bytes. All are valid. */
```

The confusion causes real bugs: partially written records in log files, split writes causing corrupt state in message queues, incomplete updates that leave application state inconsistent.

---

## What POSIX actually guarantees

POSIX guarantees atomicity of `write()` only in limited cases:

1. **Writes ≤ `PIPE_BUF` to a pipe or FIFO**: writes of `PIPE_BUF` bytes or fewer (at least 512 bytes, typically 4096 bytes on Linux) to a pipe are guaranteed to be atomic — they either complete fully or not at all, with no interleaving from other writers.

2. **`O_APPEND` writes**: writes with `O_APPEND` guarantee that the seek-to-end and write happen atomically — two processes writing with `O_APPEND` will not overwrite each other (their data may be interleaved, but each write's bytes are contiguous in the file).

For regular files without `O_APPEND`, POSIX says `write()` may write fewer bytes than requested (a "short write"), and the application must handle this.

---

## When short writes happen to regular files

On Linux, `write()` to a regular file rarely returns a short count under normal conditions — but it can and does in specific scenarios:

**Signal delivery**: if a signal is delivered while a write is in progress and the signal handler runs, the write may return early with `EINTR`, or — if `SA_RESTART` is set — restart from where it left off. On network filesystems, writes can be interrupted.

**Disk full**: if the filesystem runs out of space mid-write, `write()` returns the number of bytes written before the failure, followed by `ENOSPC` on the next call.

**Filesystem limits**: if the write would exceed the file size limit (`RLIMIT_FSIZE` or filesystem quotas), the write is truncated to the limit.

**Network filesystem timeouts**: NFS and CIFS writes that are interrupted by server timeouts can return short counts.

**Direct I/O (`O_DIRECT`) misalignment**: if an O_DIRECT write partially falls outside a valid aligned range, the valid portion may be written and the rest rejected.

The correct way to handle any write:

```c
ssize_t write_all(int fd, const void *buf, size_t len) {
    const char *p = buf;
    size_t remaining = len;
    while (remaining > 0) {
        ssize_t n = write(fd, p, remaining);
        if (n < 0) {
            if (errno == EINTR) continue;   /* restart on signal */
            return -1;                       /* real error */
        }
        if (n == 0) {
            errno = EIO;
            return -1;  /* device stopped accepting writes */
        }
        p += n;
        remaining -= n;
    }
    return len;
}
```

---

## Concurrent writes: visibility and ordering

Even when individual `write()` calls complete fully, concurrent writes from multiple processes or threads are not atomic with respect to each other.

### Regular files: no isolation

Two processes writing to overlapping regions of a regular file with `write()` can produce interleaved results. POSIX does not guarantee any isolation:

```
Process A: write(fd, "AAAA", 4) at offset 0
Process B: write(fd, "BBBB", 4) at offset 0

Possible outcome 1: "AAAA"  (A completed first, B overwrote with BBBB, then... wait no)
Possible outcome 2: "BBBB"  (B completed, then A)
Possible outcome 3: "AABB"  (A wrote first 2 bytes, B wrote last 2 bytes)
Possible outcome 4: "BBAA"  (B wrote first 2 bytes, A wrote last 2 bytes)
```

On Linux, writes to a regular file are protected by the inode's `i_lock` (or `i_rwsem` in newer kernels) at the VFS layer, which provides serialization within a single `write()` call. But two separate `write()` calls are not serialized with each other — only with the inode lock acquisition order.

### The page size boundary problem

Page cache writes go through `generic_perform_write()`, which processes a write in chunks aligned to page boundaries. A write that spans a page boundary is processed as two separate page operations:

```
write(fd, buf, 8192) spanning a page boundary (pages at 0 and 4096):

Step 1: acquire page 0, write [0, 4096)
Step 2: release page 0
Step 3: acquire page 1, write [4096, 8192)
Step 4: release page 1
```

Between steps 2 and 3, another process can write to page 0 — or a reader can see page 0 updated but page 1 not yet. For readers, a large buffered write is not atomic even from a single writer.

---

## O_APPEND: one form of atomicity that works

`O_APPEND` provides a useful atomicity guarantee: the seek-to-end and the write happen atomically at the kernel level. Two processes writing with `O_APPEND` will not overwrite each other:

```c
int fd = open("log.txt", O_WRONLY | O_APPEND);
write(fd, line, line_len);
/* The line is appended atomically — no other writer can interleave here */
```

The `PIPE_BUF` limit does not apply to `O_APPEND` on regular files — `PIPE_BUF` is a pipe-specific guarantee. For regular files, the seek-to-end and write are always atomic in the sense that no other writer can insert data between them. However, writes large enough to span multiple page boundaries are split into per-page operations by `generic_perform_write()` (see [Kernel-level write splitting](#kernel-level-write-splitting) below), and two concurrent large `O_APPEND` writes may therefore interleave at page granularity. For reliable non-interleaved records, keep each `O_APPEND` write smaller than a page (4096 bytes on x86).

For log files, `O_APPEND` with short writes (< 4096 bytes per line) is a reliable multi-process logging pattern:

```c
/* Safe for multiple writers: each log line appears complete, never interleaved */
char line[256];
int n = snprintf(line, sizeof(line), "[pid %d] event: %s\n", getpid(), event);
write(log_fd, line, n);  /* n < 4096, O_APPEND: atomic */
```

---

## Pipes: the PIPE_BUF guarantee

Writes to pipes ≤ `PIPE_BUF` bytes are atomic: either the entire write goes through without interleaving, or the write blocks until the pipe has enough space.

```bash
$ getconf PIPE_BUF /
4096
```

```c
/* Safe: multiple writers, messages ≤ 4096 bytes, no interleaving */
#define MSG_SIZE 256
write(pipe_fd, msg, MSG_SIZE);  /* atomic: readers see complete messages */

/* Unsafe: messages > PIPE_BUF may be split */
write(pipe_fd, large_msg, 8192);  /* not atomic: another writer may interleave */
```

This is why many IPC patterns use fixed-size or bounded messages: they can fit within `PIPE_BUF` and be guaranteed to be read atomically.

---

## `pwrite` and concurrent writes

`pwrite(fd, buf, len, offset)` writes to a specific offset without seeking. Unlike `write()` + `lseek()`, the offset is specified atomically. But `pwrite()` does not provide isolation between concurrent writers to the same offset:

```c
/* Process A and B both call pwrite to offset 0 simultaneously */
pwrite(fd_a, "AAAA", 4, 0);
pwrite(fd_b, "BBBB", 4, 0);

/* The result can be "AAAA", "BBBB", or a mix */
/* pwrite only guarantees the offset is used atomically (no race with seek),
   not that the write is isolated from concurrent writers */
```

`pwrite()` is useful when multiple threads share a file descriptor and need to write to non-overlapping regions without serializing all writes through a mutex. Each thread writes to its own region with `pwrite()`, and the underlying inode locking prevents corruption within each write — but the application must ensure the regions don't overlap.

---

## Atomic file updates: the write-rename pattern

The standard technique for atomically replacing a file's contents is:

```c
/* Step 1: write new content to a temporary file */
int tmp_fd = open("file.tmp", O_WRONLY | O_CREAT | O_TRUNC, 0644);
write_all(tmp_fd, new_content, new_content_len);
fsync(tmp_fd);     /* ensure content is on storage */
close(tmp_fd);

/* Step 2: atomically replace the original */
rename("file.tmp", "file");

/* Step 3: ensure the directory entry is durable */
int dir_fd = open(".", O_RDONLY);
fsync(dir_fd);     /* don't forget this! */
close(dir_fd);
```

This pattern is atomic in the sense that readers always see either the old complete file or the new complete file — never a partial file. The `rename()` syscall is atomic at the VFS level for local filesystems. (See [War Stories: Data Loss](war-stories-data-loss.md) for what happens if the `fsync(dir_fd)` is omitted.)

---

## Kernel-level write splitting

At the kernel level, `write()` to a regular file goes through `vfs_write()` → `generic_perform_write()` (for buffered I/O). `generic_perform_write` processes the write in page-sized chunks:

```c
/* Simplified from fs/generic_file.c */
ssize_t generic_perform_write(struct kiocb *iocb, struct iov_iter *i)
{
    while (iov_iter_count(i)) {
        unsigned long offset = iocb->ki_pos & (PAGE_SIZE - 1);
        size_t bytes = min(PAGE_SIZE - offset, iov_iter_count(i));

        /* Acquire the page, copy up to one page of data */
        status = a_ops->write_begin(file, mapping, pos, bytes, &page, &fsdata);
        copied = copy_page_from_iter_atomic(page, offset, bytes, i);
        status = a_ops->write_end(file, mapping, pos, bytes, copied, page, fsdata);

        iocb->ki_pos += copied;
        written += copied;
        /* ... loop continues for next page ... */
    }
    return written;
}
```

This loop processes one page per iteration. A write spanning many pages is many separate page operations. A concurrent reader can observe intermediate states.

For `O_DIRECT`, the write goes through `iomap_dio_rw()` or `__blockdev_direct_IO()`, which submits DMA directly. The DMA transfer is not atomic across multiple sectors — but for block-aligned writes within a single sector (512 or 4096 bytes), the storage device guarantees atomicity at the hardware level.

---

## What applications can rely on

| Operation | Atomicity guarantee |
|-----------|---------------------|
| `write()` ≤ `PIPE_BUF` to a pipe | Fully atomic (no interleaving from other writers) |
| `write()` with `O_APPEND` | Seek+write atomic (no position race); data may interleave at page boundaries if write > 4096 bytes |
| `write()` to a regular file | No interleaving guarantee for concurrent writers |
| `pwrite()` | Offset used atomically; no isolation from concurrent writes |
| `rename()` | Atomic at VFS level (reader sees old or new, never partial) |
| `O_DIRECT` write (single sector) | Hardware-atomic at device level |
| `write()` > `PIPE_BUF` | May be split; concurrent writers may interleave |

---

## Related pages

- [I/O Consistency and Ordering](io-consistency.md) — memory barriers and ordering guarantees
- [fsync, fdatasync, and O_SYNC](fsync-fdatasync.md) — durability semantics
- [Life of a write()](life-of-a-write.md) — the full kernel path of a write
- [War Stories: Data Loss](war-stories-data-loss.md) — real bugs from write atomicity assumptions
- [pread, pwrite, preadv2, pwritev2](pread-pwrite.md) — positional I/O interfaces
