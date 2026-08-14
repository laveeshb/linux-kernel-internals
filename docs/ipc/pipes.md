# Pipes and FIFOs

> Unidirectional byte stream IPC

## What pipes are

A pipe is a kernel-managed circular buffer connecting a write end to a read end. Data written by one process is read by another — no filesystem involved.

```
Process A               Kernel              Process B
─────────              ────────             ─────────
write(pipefd[1], data)  →  pipe buffer  →  read(pipefd[0], buf)
                             (64KB)
```

Properties:
- **Unidirectional**: data flows write→read only
- **Byte stream**: no message boundaries
- **Blocking**: write blocks if full, read blocks if empty
- **Atomic writes**: writes ≤ PIPE_BUF (4096) bytes are atomic (won't interleave)
- **SIGPIPE**: write to a pipe with no readers → `SIGPIPE` + `EPIPE`

## Creating pipes

```c
/* Anonymous pipe: returned as two fds */
int pipefd[2];
pipe2(pipefd, O_CLOEXEC | O_NONBLOCK);
/* pipefd[0] = read end, pipefd[1] = write end */

/* Classic pipe */
pipe(pipefd);

/* Typical fork + pipe pattern */
if (fork() == 0) {
    /* child: read from pipe */
    close(pipefd[1]);              /* close write end */
    read(pipefd[0], buf, sizeof(buf));
    exit(0);
} else {
    /* parent: write to pipe */
    close(pipefd[0]);              /* close read end */
    write(pipefd[1], "hello", 5);
    close(pipefd[1]);              /* EOF to child */
    wait(NULL);
}
```

## Kernel pipe data structures

```c
/* include/linux/pipe_fs_i.h -- not fs/pipe.c */
struct pipe_inode_info {
    struct mutex        mutex;          /* protects the pipe */
    wait_queue_head_t   rd_wait;        /* readers waiting for data */
    wait_queue_head_t   wr_wait;        /* writers waiting for space */

    /* head/tail are packed into a union (as one unsigned long,
     * head_tail, on 64-bit) rather than two standalone fields */
    union pipe_index {
        unsigned long head_tail;
        struct {
            pipe_index_t head;         /* producer index */
            pipe_index_t tail;         /* consumer index */
        };
    };

    unsigned int        max_usage;      /* buffer slots (default 16 = 64KB) */
    unsigned int        ring_size;      /* power-of-2 buffer size */
    unsigned int        nr_accounted;   /* for accounting */
    unsigned int        readers;        /* count of read end openers */
    unsigned int        writers;        /* count of write end openers */
    unsigned int        files;          /* sum of readers + writers */
    unsigned int        r_counter;      /* read counter for POLLHUP check */
    unsigned int        w_counter;
    bool                poll_usage;
    struct page        *tmp_page[2];    /* reusable pages -- an array, not one pointer */
    struct fasync_struct *fasync_readers;
    struct fasync_struct *fasync_writers;
    struct pipe_buffer  *bufs;          /* ring of pipe_buffer[ring_size] */
    struct user_struct  *user;
};

struct pipe_buffer {
    struct page *page;          /* the page holding this chunk of data */
    unsigned int offset;        /* byte offset within page */
    unsigned int len;           /* number of bytes */
    const struct pipe_buf_operations *ops;
    unsigned int flags;         /* PIPE_BUF_FLAG_* */
    unsigned long private;
};
```

The pipe buffer is a ring of `pipe_buffer` slots, each pointing to a page. The default capacity is 16 pages × 4096 = 65,536 bytes.

## Pipe read and write paths

```c
/* Simplified pipe write path -- real function is anon_pipe_write() (fs/pipe.c) */
static ssize_t anon_pipe_write(struct kiocb *iocb, struct iov_iter *from)
{
    struct pipe_inode_info *pipe = /* ... */;
    size_t total_len = iov_iter_count(from);

    mutex_lock(&pipe->mutex);

    while (total_len > 0) {
        unsigned int head = pipe->head;

        /* Wait if pipe is full */
        if (pipe_full(head, pipe->tail, pipe->max_usage)) {
            mutex_unlock(&pipe->mutex);
            wait_event_interruptible(pipe->wr_wait,
                !pipe_full(pipe->head, pipe->tail, pipe->max_usage));
            mutex_lock(&pipe->mutex);
            continue;
        }

        /* Copy data into head buffer */
        struct pipe_buffer *buf = &pipe->bufs[head & (pipe->ring_size-1)];
        /* ... copy from user into buf->page ... */

        pipe->head = head + 1;
        wake_up_interruptible(&pipe->rd_wait);
    }

    mutex_unlock(&pipe->mutex);
    return written;
}
```

## Changing pipe capacity

```c
/* Increase pipe buffer (useful for high-throughput logging) */
int new_size = 1 << 20;  /* 1MB */
fcntl(pipefd[1], F_SETPIPE_SZ, new_size);

/* Query current size */
int size = fcntl(pipefd[1], F_GETPIPE_SZ);
```

```bash
# System-wide maximum pipe size
cat /proc/sys/fs/pipe-max-size  # default 1MB
echo 4194304 > /proc/sys/fs/pipe-max-size  # increase to 4MB
```

## splice: zero-copy pipe I/O

`splice` moves data between a file descriptor and a pipe without copying to userspace:

```c
/* Copy file → pipe (zero-copy read) */
ssize_t n = splice(file_fd, &offset,
                   pipe_fd,  NULL,
                   count, SPLICE_F_MOVE | SPLICE_F_MORE);

/* Copy pipe → socket (zero-copy send) */
n = splice(pipe_fd, NULL,
           socket_fd, NULL,
           count, SPLICE_F_MOVE);

/* Typical pattern: splice file to network socket without copy */
splice(file_fd, NULL, pipe_fd, NULL, file_size, SPLICE_F_MORE);
splice(pipe_fd, NULL, socket_fd, NULL, file_size, 0);
```

`splice` works by moving `pipe_buffer` page references — no data is copied. This is how `sendfile` is implemented internally.

## vmsplice: mapping userspace memory into a pipe

```c
/* Map userspace buffer into the pipe (gift: pipe takes ownership) */
struct iovec iov = { .iov_base = buf, .iov_len = len };
vmsplice(pipefd[1], &iov, 1, SPLICE_F_GIFT);

/* Without SPLICE_F_GIFT: pipe gets a reference, buf must not change */
vmsplice(pipefd[1], &iov, 1, 0);
```

## tee: duplicating pipe data

```c
/* Copy data from pipe1 to pipe2 without consuming from pipe1 */
tee(pipe1_read_fd, pipe2_write_fd, count, SPLICE_F_NONBLOCK);
/* Data is now readable from both pipe1 and pipe2 */
```

Useful for implementing `tee(1)` (stdout → file + stdout) efficiently.

## FIFOs (named pipes)

A FIFO is a pipe accessible via the filesystem. Any process knowing the path can open it:

```bash
# Create FIFO
mkfifo /tmp/myfifo

# Process A: write
echo "hello" > /tmp/myfifo  # blocks until a reader opens it

# Process B: read
cat /tmp/myfifo  # blocks until a writer opens it
```

```c
/* Create FIFO programmatically */
mkfifo("/tmp/myfifo", 0666);

/* Open without blocking (O_NONBLOCK) */
int fd = open("/tmp/myfifo", O_RDONLY | O_NONBLOCK);
/* Returns immediately; succeeds even if no writers have opened yet */

/* Standard blocking open */
int fd = open("/tmp/myfifo", O_RDONLY);
/* Blocks until a writer opens the write end */
```

Opening rules:
- Read-only open blocks until a writer opens (unless `O_NONBLOCK`)
- Write-only open blocks until a reader opens (unless `O_NONBLOCK`, returns `ENXIO`)
- Read-write open never blocks

## Pipe vs socket

| | Pipe/FIFO | Unix socket (SOCK_STREAM) |
|---|-----------|--------------------------|
| Direction | Unidirectional | Bidirectional |
| Address | Anonymous or path | Path or autobind |
| Scatter/gather | No (writev works) | Yes (sendmsg) |
| Out-of-band data | No | Yes (MSG_OOB) |
| Credentials | No | Yes (SCM_CREDENTIALS) |
| FD passing | No | Yes (SCM_RIGHTS) |
| Overhead | Lower | Slightly higher |

## Observing pipes

```bash
# Check pipe buffer usage
ls -la /proc/self/fd/
# lrwx 0 -> pipe:[12345678]

# See all pipes open in the system
lsof | grep "^.\{8\}pipe"

# fdinfo has no pipe-specific "pipe-size" field -- only the generic
# pos/flags/mnt_id/ino lines. Use F_GETPIPE_SZ to read current capacity.
cat /proc/$(pgrep myproc)/fdinfo/4
# pos:     0
# flags:   0100001
# mnt_id:  12
# ino:     54321

# Check splice/vmsplice usage
perf trace -e splice,vmsplice -- myprocess
```

## Further reading

### Kernel source

- [fs/pipe.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/pipe.c) — pipe/FIFO read and write paths (`anon_pipe_read()`, `anon_pipe_write()`, `fifo_open()`), and `F_SETPIPE_SZ`/`F_GETPIPE_SZ` handling
- [include/linux/pipe_fs_i.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pipe_fs_i.h) — `struct pipe_inode_info` and `struct pipe_buffer` definitions, `PIPE_DEF_BUFFERS`
- [fs/splice.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/splice.c) — `splice()`, `vmsplice()`, and `tee()` syscall implementations
- [Splice — The Linux Kernel documentation](https://docs.kernel.org/filesystems/splice.html) — kernel-internal splice/pipe API reference (`pipe_buffer` helpers, `splice_to_pipe()`, and friends)

### Man pages

- [`pipe(2)`](https://man7.org/linux/man-pages/man2/pipe.2.html) — `pipe()`/`pipe2()` creation, `O_DIRECT` packet mode
- [`pipe(7)`](https://man7.org/linux/man-pages/man7/pipe.7.html) — pipe/FIFO overview, capacity, `PIPE_BUF` atomicity
- [`fifo(7)`](https://man7.org/linux/man-pages/man7/fifo.7.html) — FIFO `open()` blocking semantics for `O_RDONLY`/`O_WRONLY`/`O_RDWR`
- [`splice(2)`](https://man7.org/linux/man-pages/man2/splice.2.html) — `splice()` flags and the "at least one fd must be a pipe" requirement
- [`vmsplice(2)`](https://man7.org/linux/man-pages/man2/vmsplice.2.html) — `SPLICE_F_GIFT` semantics
- [`tee(2)`](https://man7.org/linux/man-pages/man2/tee.2.html) — duplicating pipe data without consuming it
- [`F_SETPIPE_SZ(2const)`](https://man7.org/linux/man-pages/man2/F_SETPIPE_SZ.2const.html) — changing/querying pipe capacity, rounding rules, since Linux 2.6.35

### Related pages

- [splice-sendfile.md](../vfs/splice-sendfile.md) — deeper dive into the splice/tee/sendfile kernel paths and how `sendfile()` is built on the same machinery
- [shared-memory.md](shared-memory.md) — alternatives without byte-stream ordering
- [unix-sockets.md](unix-sockets.md) — the bidirectional, credential-passing counterpart compared above
- [war-stories.md](war-stories.md) — "The pipe capacity surprise": a producer blocking on a full pipe during a consumer stall
- [file-ops.md](../vfs/file-ops.md) — the `file_operations` vtable that pipe/FIFO `read_iter`/`write_iter` hook into

### LWN articles

- [Two new system calls: splice() and sync_file_range()](https://lwn.net/Articles/178199/) — Jonathan Corbet, April 3, 2006; introduces `splice()` (Jens Axboe's 2.6.17 implementation, based on an earlier proposal by Larry McVoy) and the `SPLICE_F_MOVE` flag
