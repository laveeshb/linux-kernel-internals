# io_uring

> True async I/O for everything

## What io_uring is

io_uring (introduced in Linux 5.1) is a high-performance async I/O interface that:

- **Eliminates syscall overhead**: submit and reap operations via shared memory rings, not per-operation syscalls
- **Works for all I/O**: files, sockets, pipes, splice, cancel, timeout — not just O_DIRECT block I/O like the older aio
- **Zero-copy**: fixed buffers eliminate per-I/O allocation and copying
- **Kernel-side polling**: SQPOLL thread eliminates `io_uring_enter()` syscalls entirely

```
Userspace                    Kernel
─────────────────────────────────────────────────────────────
                        ┌──────────────────────┐
  SQ ring (mmap'd)  ──► │  io_uring instance   │
  CQ ring (mmap'd)  ◄── │  (per-fd state)      │
                        └──────────────────────┘
                                  │
                        io_uring_enter() → process SQEs
                                  │
                            async I/O workers / direct dispatch
                                  │
                          complete → post CQE
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Architecture and Rings](io-uring-arch.md) | Setup, SQ/CQ ring layout, SQE/CQE structures |
| [Operations and Advanced Features](io-uring-ops.md) | Supported ops, fixed files/buffers, SQPOLL, linked requests |

## Quick reference

```c
/* Typical io_uring workflow with liburing */
#include <liburing.h>

struct io_uring ring;
io_uring_queue_init(32, &ring, 0);     /* 32 SQE slots */

/* Submit a read */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(sqe, fd, buf, len, offset);
sqe->user_data = 1;   /* tag for matching completions */
io_uring_submit(&ring);

/* Wait for completion */
struct io_uring_cqe *cqe;
io_uring_wait_cqe(&ring, &cqe);
int result = cqe->res;   /* bytes read, or -errno */
io_uring_cqe_seen(&ring, cqe);  /* advance CQ tail */

io_uring_queue_exit(&ring);
```
