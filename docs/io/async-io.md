# Async I/O Evolution

> From POSIX AIO to Linux AIO to io_uring

## The problem with synchronous I/O

Synchronous `read()`/`write()` block the calling thread until data is transferred. For high-throughput servers this means either:
- Many threads (each blocking on I/O) — high memory cost, context switch overhead
- Non-blocking I/O with `epoll` — works for sockets, but **epoll does not work for regular files** (they are always "ready")

The goal of async I/O: submit I/O, do other work, collect results when ready.

## POSIX AIO (glibc userspace)

POSIX AIO (`aio_read`, `aio_write`) is the standard API — but the Linux glibc implementation fakes it with threads:

```c
#include <aio.h>

struct aiocb cb = {
    .aio_fildes = fd,
    .aio_buf    = buf,
    .aio_nbytes = 4096,
    .aio_offset = 0,
    /* Notify via signal: */
    .aio_sigevent = {
        .sigev_notify = SIGEV_SIGNAL,
        .sigev_signo  = SIGUSR1,
    },
};

/* Submit async read */
aio_read(&cb);

/* ... do other work ... */

/* Check completion */
int err = aio_error(&cb);
if (err == 0) {
    ssize_t n = aio_return(&cb);  /* bytes transferred */
}

/* Or: wait for all */
const struct aiocb *list[] = { &cb };
aio_suspend(list, 1, NULL);
```

**The problem**: glibc implements POSIX AIO using a thread pool. Each `aio_read()` submits work to a worker thread that calls `pread()` synchronously. This adds:
- Thread creation/teardown overhead
- Memory per thread (stack)
- Context switches to the worker thread and back
- No kernel bypass — still goes through the kernel per-thread

## Linux Kernel AIO

Linux added native async I/O in 2.6 (`io_submit`, `io_getevents`). Unlike POSIX AIO, this runs in the kernel — no threads.

```c
#include <linux/aio_abi.h>
#include <sys/syscall.h>

/* Setup: create an AIO context */
aio_context_t ctx = 0;
io_setup(128, &ctx);  /* max 128 in-flight ops */

/* Prepare an iocb */
struct iocb cb = {
    .aio_lio_opcode = IOCB_CMD_PREAD,
    .aio_fildes     = fd,
    .aio_buf        = (uint64_t)buf,
    .aio_nbytes     = 4096,
    .aio_offset     = 0,
};
struct iocb *cbs[] = { &cb };

/* Submit */
io_submit(ctx, 1, cbs);

/* Wait for completion */
struct io_event events[1];
struct timespec timeout = { .tv_sec = 1 };
int n = io_getevents(ctx, 1, 1, events, &timeout);
if (n == 1) {
    printf("result: %ld\n", events[0].res);
}

io_destroy(ctx);
```

### Linux AIO limitations

Linux AIO was designed specifically for `O_DIRECT` I/O. It has serious limitations:

| Limitation | Details |
|-----------|---------|
| **O_DIRECT only** | Buffered I/O submits synchronously even with `io_submit` |
| **No network sockets** | Only block/file I/O, not sockets or pipes |
| **io_submit can block** | On buffered files or full submission ring |
| **No fixed buffers** | Each op requires mapping/unmapping user buffers |
| **No chaining** | Can't express "read A, then write B" without round-tripping to userspace |
| **No fsync** | `IOCB_CMD_FSYNC` exists but rarely works async |

The result: Linux AIO only helps databases already using `O_DIRECT`. It does not solve the general async I/O problem.

### Kernel path for Linux AIO

```c
/* fs/aio.c */
long io_submit(aio_context_t ctx_id, long nr, struct iocb __user **iocbpp)
{
    struct kioctx *ctx = lookup_ioctx(ctx_id);

    for (i = 0; i < nr; i++) {
        struct iocb __user *user_iocb = iocbpp[i];
        ret = io_submit_one(ctx, user_iocb, &tmp, compat);
    }
}

static int io_submit_one(struct kioctx *ctx, struct iocb __user *user_iocb, ...)
{
    struct aio_kiocb *req = aio_get_req(ctx);

    switch (iocb.aio_lio_opcode) {
    case IOCB_CMD_PREAD:
        ret = aio_read(&req->rw, &iocb, false, compat);
        /* For O_DIRECT: submits bio and returns immediately */
        /* For buffered: may block right here in io_submit! */
        break;
    case IOCB_CMD_PWRITE:
        ret = aio_write(&req->rw, &iocb, false, compat);
        break;
    }
}
```

## io_uring: solving the problem properly

`io_uring` (merged in Linux 5.1, 2019) addresses all Linux AIO limitations. It uses two shared-memory ring buffers between kernel and userspace:

```
Userspace                    Kernel
   │                            │
   │  SQ ring (submissions)     │
   │  ┌─────────────────────┐   │
   │  │ SQE SQE SQE SQE ... │──▶│ io_uring_enter()
   │  └─────────────────────┘   │     ↓
   │                         submits I/O
   │  CQ ring (completions)      │
   │  ┌─────────────────────┐   │
   │  │ CQE CQE CQE CQE ... │◀──│ kernel writes completions
   │  └─────────────────────┘   │
```

No locking needed: SQ tail is written by userspace, SQ head by kernel; CQ tail by kernel, CQ head by userspace.

### Basic io_uring usage

```c
#include <liburing.h>

struct io_uring ring;
io_uring_queue_init(128, &ring, 0);

/* Submit a read */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(sqe, fd, buf, 4096, offset);
sqe->user_data = 42;  /* tag to identify completion */

io_uring_submit(&ring);

/* Wait for completion */
struct io_uring_cqe *cqe;
io_uring_wait_cqe(&ring, &cqe);
printf("read %d bytes (tag=%llu)\n", cqe->res, cqe->user_data);
io_uring_cqe_seen(&ring, cqe);

io_uring_queue_exit(&ring);
```

### io_uring vs Linux AIO

| Feature | Linux AIO | io_uring |
|---------|-----------|---------|
| Buffered I/O | Blocks in submit | Truly async |
| Network sockets | No | Yes (recv/send/accept/connect) |
| Fixed buffers | No | Yes (zero-copy after register) |
| Request chaining | No | Yes (IOSQE_IO_LINK) |
| Polled I/O (no IRQ) | No | Yes (IORING_SETUP_IOPOLL) |
| Kernel thread submit | No | Yes (IORING_SETUP_SQPOLL) |
| fsync | Partial | Yes |
| Splice/tee | No | Yes |
| openat/statx/unlinkat | No | Yes |
| Zero syscalls | No | Yes (with SQPOLL) |

### io_uring SQPOLL: zero-syscall I/O

With `IORING_SETUP_SQPOLL`, a kernel thread polls the SQ ring:

```c
struct io_uring_params params = {
    .flags = IORING_SETUP_SQPOLL,
    .sq_thread_idle = 2000,  /* ms before kernel thread sleeps */
};
io_uring_queue_init_params(128, &ring, &params);

/* Now io_uring_submit() is optional — kernel polls for new SQEs */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(sqe, fd, buf, 4096, 0);
io_uring_sqe_set_flags(sqe, IOSQE_FIXED_FILE);

/* No syscall needed if kernel thread is still polling: */
io_uring_submit(&ring);  /* may return without syscall */
```

Useful for NVMe with polled queues (`IORING_SETUP_IOPOLL` + `IORING_SETUP_SQPOLL`): latency of 50-100µs with zero syscalls.

### io_uring request chaining

```c
/* Chain: read file → write to socket, only if read succeeds */
struct io_uring_sqe *read_sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(read_sqe, file_fd, buf, 4096, 0);
io_uring_sqe_set_flags(read_sqe, IOSQE_IO_LINK);  /* link to next */

struct io_uring_sqe *send_sqe = io_uring_get_sqe(&ring);
io_uring_prep_send(send_sqe, sock_fd, buf, 4096, 0);
/* No IOSQE_IO_LINK: end of chain */

io_uring_submit(&ring);
/* Kernel executes read, then send (if read succeeded) */
```

### io_uring kernel internals

```c
/* io_uring/io_uring.c */
static int io_read(struct io_kiocb *req, unsigned int issue_flags)
{
    struct io_rw *rw = io_kiocb_to_cmd(req, struct io_rw);
    struct kiocb *kiocb = &rw->kiocb;

    /* Try inline (non-blocking first): */
    ret = io_iter_do_read(rw, &iter);

    if (ret == -EAGAIN) {
        /* Would block: punt to io-wq thread pool */
        if (issue_flags & IO_URING_F_NONBLOCK)
            return -EAGAIN;
        /* Or: submit to async worker */
        io_req_task_work_add(req);
    }
    /* Complete inline if data was in page cache */
    io_req_set_res(req, ret, 0);
    return IOU_OK;
}
```

io_uring first attempts the operation inline (non-blocking). If it would block, it falls back to a `io-wq` worker thread (similar to a kernel thread pool but cheaper than POSIX AIO's userspace threads).

## epoll limitations for file I/O

For completeness: `epoll` does not solve async file I/O:

```c
/* This does NOT work for regular files: */
int fd = open("file.dat", O_RDONLY | O_NONBLOCK);
int epfd = epoll_create1(0);

struct epoll_event ev = { .events = EPOLLIN, .data.fd = fd };
epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &ev);

/* epoll_wait will return immediately: files are always "ready" */
epoll_wait(epfd, events, 10, -1);
/* read() still blocks if data isn't in page cache */
```

Regular files always appear ready to epoll because the VFS has no mechanism to notify when a page cache miss resolves. Only sockets and pipes have genuine readiness semantics.

## Choosing the right async I/O

| Scenario | Recommendation |
|----------|---------------|
| O_DIRECT database I/O | io_uring (or Linux AIO for legacy) |
| Network + file I/O together | io_uring |
| High-throughput NVMe | io_uring + IOPOLL + SQPOLL |
| Portable POSIX code | POSIX AIO (accepts the thread overhead) |
| Socket-only server | epoll + non-blocking sockets |
| Buffered file I/O, simple | Sync read/write + thread pool |

## Further reading

- [Direct I/O](direct-io.md) — O_DIRECT, alignment requirements
- [io_uring: Architecture](../io-uring/io-uring-arch.md) — ring setup, SQE/CQE layout
- [io_uring: Operations](../io-uring/io-uring-ops.md) — full operation reference
- `io_uring/io_uring.c` — io_uring core
- `fs/aio.c` — Linux AIO implementation
- [io_uring.pdf](https://kernel.dk/io_uring.pdf) — Jens Axboe's design paper
