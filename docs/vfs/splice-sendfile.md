# splice, sendfile, and copy_file_range

> Zero-copy data transfer between file descriptors

## The problem: data movement overhead

Normal `read()` + `write()` copies data through userspace:

```
Disk → kernel page cache → [copy] → userspace buffer → [copy] → kernel socket buffer → NIC
                                         ↑
                               Two copies through CPU
```

For large data transfers (serving files over HTTP, piping data between processes), these copies are wasteful. Linux provides several zero-copy alternatives.

## sendfile: file-to-socket zero-copy

`sendfile()` was introduced in Linux 2.2 [(man page)](https://www.man7.org/linux/man-pages/man2/sendfile.2.html) and sends a file directly to a socket without copying through userspace:

```c
#include <sys/sendfile.h>

ssize_t sendfile(int out_fd, int in_fd, off_t *offset, size_t count);

/* Example: serve a file over HTTP */
int file_fd = open("file.dat", O_RDONLY);
int sock_fd = accept(listen_fd, NULL, NULL);

off_t offset = 0;
ssize_t sent = sendfile(sock_fd, file_fd, &offset, file_size);
```

Data path with sendfile:
```
Disk → page cache → [DMA] → NIC (with scatter-gather DMA)
              ↑
    No copy through userspace
    No copy through socket buffer (with NIC scatter-gather)
```

### sendfile limitations

- `out_fd` must be a socket (or pipe on some kernels)
- `in_fd` must support `mmap`-like operations (regular files, not sockets)
- Does not work for file-to-file copies
- Requires NIC scatter-gather for true zero-copy; otherwise one kernel→kernel copy

## splice: pipe-based zero-copy

`splice()` was introduced in Linux 2.6.17 by Jens Axboe [(commit)](https://git.kernel.org/linus/5274f052e7b3dbd81935772eb551dfd0325dfa9d) [(LWN)](https://lwn.net/Articles/178199/), based on an earlier concept by Larry McVoy. It moves data between a pipe and a file descriptor using page references — no data copying:

```c
#define _GNU_SOURCE
#include <fcntl.h>

ssize_t splice(int fd_in, loff_t *off_in,
               int fd_out, loff_t *off_out,
               size_t len, unsigned int flags);
/* flags: SPLICE_F_MOVE, SPLICE_F_NONBLOCK, SPLICE_F_MORE */
```

At least one of `fd_in` or `fd_out` must be a pipe. The pipe acts as a staging buffer:

```c
/* File to socket via pipe (zero-copy) */
int pipefd[2];
pipe(pipefd);

/* Stage 1: file → pipe (moves page references, no copy) */
splice(file_fd, &file_offset, pipefd[1], NULL, len, SPLICE_F_MOVE);

/* Stage 2: pipe → socket (zero-copy with scatter-gather NIC) */
splice(pipefd[0], NULL, sock_fd, NULL, len, SPLICE_F_MOVE | SPLICE_F_MORE);
```

### tee: duplicate pipe data

`tee()` duplicates data between two pipes without consuming from the source:

```c
ssize_t tee(int fd_in, int fd_out, size_t len, unsigned int flags);

/* Duplicate a stream: log and forward simultaneously */
int log_pipe[2], fwd_pipe[2];
pipe(log_pipe); pipe(fwd_pipe);

/* Source → log_pipe */
splice(source_fd, NULL, log_pipe[1], NULL, len, 0);

/* Duplicate log_pipe → fwd_pipe (no copy, pages shared) */
tee(log_pipe[0], fwd_pipe[1], len, 0);

/* Consume from both independently */
splice(log_pipe[0], NULL, logfile_fd, NULL, len, 0);
splice(fwd_pipe[0], NULL, socket_fd, NULL, len, 0);
```

## copy_file_range: kernel-side file copy

`copy_file_range()` copies between two files without touching userspace. On modern filesystems it can use **server-side copy** (e.g., NFS, SMB, Btrfs reflinking):

```c
#define _GNU_SOURCE
#include <unistd.h>

ssize_t copy_file_range(int fd_in, loff_t *off_in,
                         int fd_out, loff_t *off_out,
                         size_t len, unsigned int flags);

/* Fast file copy (may be instantaneous with reflink) */
int src = open("src.dat", O_RDONLY);
int dst = open("dst.dat", O_WRONLY | O_CREAT, 0644);

off_t off_in = 0, off_out = 0;
copy_file_range(src, &off_in, dst, &off_out, file_size, 0);
```

### Btrfs reflink

On Btrfs (and XFS with reflink), `copy_file_range` does a **reflink** — the destination shares the same extents as the source with copy-on-write semantics:

```
Before copy_file_range:
  src inode → [extent A] [extent B] [extent C]

After copy_file_range (reflink):
  src inode → [extent A] [extent B] [extent C]
  dst inode →     ↑           ↑          ↑
              (shared, COW on write)

No data copied — instantaneous regardless of file size!
```

```bash
# Check if filesystem supports reflink
cp --reflink=always src.dat dst.dat   # fails if not supported
cp --reflink=auto   src.dat dst.dat   # falls back to copy if needed
```

## Kernel implementation

### sendfile kernel path

```c
/* fs/read_write.c */
SYSCALL_DEFINE4(sendfile64, int, out_fd, int, in_fd,
                loff_t __user *, offset, size_t, count)
{
    struct fd in = fdget(in_fd);
    struct fd out = fdget(out_fd);

    /* Delegate to do_sendfile */
    return do_sendfile(out.file, in.file, ppos, count, 0);
}

/* fs/read_write.c */
static ssize_t do_sendfile(struct file *out_file, struct file *in_file, loff_t *ppos, size_t count, loff_t max)
{
    /* Uses file->f_op->splice_read to get pages from in_file */
    /* Uses sock_sendpage (or generic_file_splice_write) for out_file */

    /* For sockets: calls tcp_sendpage → skb_fill_page_desc */
    /* Page reference is added to skb — no copy if NIC has scatter-gather */
}
```

### splice kernel path

```c
/* fs/splice.c */
SYSCALL_DEFINE6(splice, int, fd_in, loff_t __user *, off_in,
                int, fd_out, loff_t __user *, off_out,
                size_t, len, unsigned int, flags)
{
    if (ipipe && opipe) {
        /* pipe-to-pipe: just move the pipe_buffer references */
        return splice_pipe_to_pipe(ipipe, opipe, len, flags);
    }
    if (ipipe) {
        /* pipe-to-file: write pipe buffers to file */
        return do_splice_from(ipipe, out, &offset, len, flags);
    }
    if (opipe) {
        /* file-to-pipe: add page references to pipe */
        return do_splice_to(in, &offset, opipe, len, flags);
    }
}

/* pipe_buffer: a reference to a page, no data copy */
struct pipe_buffer {
    struct page      *page;
    unsigned int     offset, len;
    const struct pipe_buf_operations *ops;
    unsigned int     flags;
};
```

### copy_file_range kernel path

```c
/* fs/read_write.c */
SYSCALL_DEFINE6(copy_file_range, ...)
{
    /* Try filesystem-specific implementation first */
    if (out_file->f_op->copy_file_range) {
        ret = out_file->f_op->copy_file_range(file_in, pos_in,
                                               file_out, pos_out,
                                               len, flags);
        if (ret != -EOPNOTSUPP && ret != -EXDEV)
            return ret;
    }

    /* Fallback: generic_copy_file_range (splice-based) */
    return generic_copy_file_range(file_in, pos_in,
                                    file_out, pos_out, len, flags);
}

/* Btrfs implementation: */
static ssize_t btrfs_copy_file_range(...)
{
    /* btrfs_clone_file_range → create shared extents */
    ret = btrfs_clone(src, dst, off, len, len, destoff, 0);
}
```

## Comparison

| API | Zero-copy? | Use case | Kernel → userspace copy |
|-----|-----------|----------|------------------------|
| `read()` + `write()` | No | Universal | 2 copies |
| `sendfile()` | Yes (with NIC SG) | File → socket | 0 copies |
| `splice()` | Yes | Any fd ↔ pipe | 0 copies |
| `tee()` | Yes | Pipe duplication | 0 copies |
| `copy_file_range()` | Yes (reflink) | File → file | 0 copies (reflink) |
| `mmap()` + `write()` | Partial | File → socket | 1 copy (page → SKB) |

## Performance tips

```bash
# Verify sendfile is used (strace a file server):
strace -e sendfile64,splice nginx -g 'daemon off;' 2>&1 | head -20

# Check NIC scatter-gather support (required for true zero-copy):
ethtool -k eth0 | grep scatter-gather
# scatter-gather: on

# For large files: sendfile outperforms read+write significantly
# Typical: 2-4x throughput improvement for 100MB+ files
```

```c
/* io_uring splice: zero-copy without blocking */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_splice(sqe,
    file_fd, file_offset,
    pipe_fd[1], -1,
    len, SPLICE_F_MOVE);
io_uring_sqe_set_flags(sqe, IOSQE_IO_LINK);

/* Chain: pipe → socket */
sqe = io_uring_get_sqe(&ring);
io_uring_prep_splice(sqe,
    pipe_fd[0], -1,
    sock_fd, -1,
    len, SPLICE_F_MOVE);

io_uring_submit(&ring);
```

## Further reading

- [File Operations](file-ops.md) — read/write VFS path
- [Page Cache](../mm/page-cache.md) — page references in splice
- [Direct I/O](../io/direct-io.md) — bypassing page cache entirely
- [io_uring Operations](../io-uring/io-uring-ops.md) — `IORING_OP_SPLICE`
- `fs/splice.c` — splice/sendfile/tee implementation
- `include/linux/splice.h`
