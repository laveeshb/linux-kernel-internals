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
/* fs/pipe.c */
struct pipe_inode_info {
    struct mutex        mutex;          /* protects the pipe */
    wait_queue_head_t   rd_wait;        /* readers waiting for data */
    wait_queue_head_t   wr_wait;        /* writers waiting for space */

    unsigned int        head;           /* producer head index */
    unsigned int        tail;           /* consumer tail index */
    unsigned int        max_usage;      /* buffer slots (default 16 = 64KB) */
    unsigned int        ring_size;      /* power-of-2 buffer size */
    unsigned int        nr_accounted;   /* for accounting */
    unsigned int        readers;        /* count of read end openers */
    unsigned int        writers;        /* count of write end openers */
    unsigned int        files;          /* sum of readers + writers */
    unsigned int        r_counter;      /* read counter for POLLHUP check */
    unsigned int        w_counter;
    unsigned int        poll_usage;
    bool                poll_usage_aware;
    struct page        *tmp_page;       /* reusable page */
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
/* Simplified pipe write path */
static ssize_t pipe_write(struct kiocb *iocb, struct iov_iter *from)
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
/* Returns -1 with ENXIO if no writers have opened yet */

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

# Pipe buffer size
cat /proc/$(pgrep myproc)/fdinfo/4
# flags:   0100001
# mnt_id:  12
# pos:     0
# pipe-size: 65536  ← current pipe size

# Check splice/vmsplice usage
perf trace -e splice,vmsplice -- myprocess
```

## Further reading

- [Shared Memory and Semaphores](shared-memory.md) — Alternatives without byte ordering
- [VFS: File Operations](../vfs/file-ops.md) — How pipes fit in the VFS
- `fs/pipe.c` — complete pipe implementation
- `man 7 pipe` — pipe semantics and limits
