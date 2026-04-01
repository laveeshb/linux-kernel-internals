# io_uring

> True async I/O for everything — files, sockets, pipes, and more, without a syscall per operation

## Getting Started

This documentation explains how io_uring works — not just the API, but the design decisions behind the ring layout, the trade-offs that shaped it, and the real-world patterns used in databases, storage engines, and network servers.

<div class="github-only" markdown>
> **Browsing on GitHub?** See the [full site index](../site-index.md) for a complete listing of all documentation.
</div>

### Prerequisites

This documentation assumes familiarity with:
- **C programming** — io_uring's API and the kernel implementation are both in C
- **File descriptors and syscalls** — how `read()`, `write()`, `accept()` work at the OS level
- **Basic async concepts** — event loops, non-blocking I/O, callbacks

If you've used `epoll` or `libaio`, you have a good foundation. If not, understanding blocking vs. non-blocking I/O is enough to start.

### Getting the Kernel Source

```bash
git clone https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git
cd linux
```

The io_uring implementation lives in `io_uring/` (~25,000 lines). The public ABI is in `include/uapi/linux/io_uring.h`.

### Suggested Reading Order

**Start here:**

1. **[Architecture and Rings](io-uring-arch.md)** — ring layout, SQE/CQE structures, submission and completion flow
2. **[Life of a Request](life-of-request.md)** — end-to-end trace: from userspace SQE to kernel completion to CQE

**Operations:**

3. **[Operations Reference](io-uring-ops.md)** — the full opcode table, flags, and per-operation semantics

**Advanced topics:**

4. **[Fixed Buffers and Files](fixed-buffers.md)** — pre-registered buffers and file descriptors, zero-copy I/O
5. **[Multishot Operations](multishot-ops.md)** — one SQE, many CQEs: multishot accept, recv, and poll
6. **[Networking](networking.md)** — accept loops, zero-copy send, TCP zero-copy receive

**Comparison and security:**

7. **[io_uring vs epoll](io-uring-vs-epoll.md)** — when to use each, what epoll can't do, migration patterns
8. **[Security](security.md)** — privilege requirements, attack surface, seccomp filtering
9. **[War Stories](war-stories.md)** — real bugs, CVEs, and lessons from production

### What You'll Learn

| Textbook Concept | Linux Reality |
|------------------|---------------|
| "async I/O requires threads" | io_uring's [SQPOLL](io-uring-arch.md) mode can drive I/O with zero application threads — a kernel thread polls the SQ ring |
| "one syscall per I/O" | io_uring batches submissions; with SQPOLL, you can eliminate `io_uring_enter()` entirely |
| "epoll handles all I/O" | [epoll cannot do file I/O](io-uring-vs-epoll.md) — regular files are always ready; io_uring handles files, sockets, pipes uniformly |
| "io_uring is just for servers" | Databases (RocksDB, ScyllaDB), storage engines, and game engines all use io_uring for file I/O |
| "zero-copy means no CPU" | [Fixed buffers](fixed-buffers.md) eliminate data copies between userspace and kernel, but DMA setup and completion interrupts still consume CPU |

### What Makes This Different

- **Real commits**: Every claim links to actual kernel commits
- **Real bugs**: Learn from what broke and why
- **Real discussions**: Links to LKML where design decisions were debated
- **Real trade-offs**: Not just "what" but "why this and not that"
- **Hands-on**: "Try It Yourself" sections with commands to run and code to read

---

## What io_uring Is

io_uring was introduced in Linux 5.1 (May 2019) by Jens Axboe. It is a kernel interface for asynchronous I/O built around two lock-free rings in shared memory:

- The **Submission Queue (SQ)** — userspace writes SQEs describing I/O operations
- The **Completion Queue (CQ)** — the kernel posts CQEs with results

Because both rings are mapped into userspace memory, submitting and harvesting I/O requires no syscall in the common case — especially with SQPOLL enabled.

```
Userspace                          Kernel
────────────────────────────────────────────────────────────────
                              ┌──────────────────────┐
  SQ ring (mmap'd)  ────────► │  io_uring instance   │
  SQE array (mmap'd) ────────►│  (struct io_ring_ctx) │
                              └──────────────────────┘
  CQ ring (mmap'd)  ◄────────         │
                              io_uring_enter() or SQPOLL
                                       │
                               direct dispatch / io-wq
                                       │
                               complete → post CQE
```

### How io_uring Differs from epoll and POSIX AIO

**epoll** is a readiness notification mechanism — it tells you when a file descriptor *can* be read without blocking. You still need a second syscall to actually transfer data. It cannot be used for regular file I/O because files are always "ready".

**POSIX AIO** (`aio_read`, `aio_write`) is implemented in glibc as a thread pool, not a true kernel interface. It has poor performance, a complex signal-based notification model, and limited operation coverage.

**Linux libaio** (`io_submit`, `io_getevents`) is a real kernel interface but is restricted to O_DIRECT block I/O, lacks socket support, and requires per-operation syscalls.

**io_uring** addresses all of these:

| Feature | epoll | libaio | io_uring |
|---------|-------|--------|----------|
| Regular file I/O | No | O_DIRECT only | Yes |
| Socket I/O | Yes | No | Yes |
| Zero syscall path | No | No | Yes (SQPOLL) |
| Batched submission | No | Limited | Yes |
| Linked operations | No | No | Yes |
| Fixed buffers | No | No | Yes |
| Multishot ops | No | No | Yes |

---

## Documentation

### Core Reading

| Document | What You'll Learn |
|----------|-------------------|
| [io-uring-arch](io-uring-arch.md) | Ring layout, SQE/CQE structures, `io_uring_setup`, submission and completion flow |
| [life-of-request](life-of-request.md) | End-to-end trace of a single read: SQE submission, kernel dispatch, CQE posting |
| [io-uring-ops](io-uring-ops.md) | Opcode table, per-operation flags and semantics, cancellation |

### Advanced Topics

| Document | What You'll Learn |
|----------|-------------------|
| [fixed-buffers](fixed-buffers.md) | Pre-registered buffers and file descriptors — eliminating per-I/O setup cost |
| [multishot-ops](multishot-ops.md) | One SQE generating many CQEs: multishot accept, recv, and poll |
| [networking](networking.md) | High-throughput accept loops, zero-copy TCP send, recv with buffer selection |

### Comparison and Security

| Document | What You'll Learn |
|----------|-------------------|
| [io-uring-vs-epoll](io-uring-vs-epoll.md) | When each model fits, what epoll can't do, migration patterns |
| [security](security.md) | Attack surface, privilege requirements, seccomp and io_uring, CVE history |
| [war-stories](war-stories.md) | Real bugs, production failures, and what they teach about the implementation |

---

## Key Source Files

If you want to read the actual kernel code:

| File | What It Does |
|------|--------------|
| [`io_uring/io_uring.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/io_uring/io_uring.c) | Core ring management, `io_uring_setup`, `io_uring_enter`, context lifecycle |
| [`io_uring/rw.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/io_uring/rw.c) | Read and write operations — `IORING_OP_READ`, `IORING_OP_WRITE`, vectored variants |
| [`io_uring/net.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/io_uring/net.c) | Network operations — `IORING_OP_ACCEPT`, `IORING_OP_SEND`, `IORING_OP_RECV` |
| [`io_uring/sqpoll.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/io_uring/sqpoll.c) | SQPOLL kernel thread — polling the SQ ring without userspace syscalls |
| [`io_uring/io-wq.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/io_uring/io-wq.c) | Async worker thread pool for operations that cannot be dispatched inline |
| [`io_uring/rsrc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/io_uring/rsrc.c) | Fixed buffer and fixed file registration, resource table management |
| [`include/uapi/linux/io_uring.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/io_uring.h) | Userspace ABI — `io_uring_sqe`, `io_uring_cqe`, opcodes, flags, feature bits |

---

## Quick Reference

A minimal io_uring read loop using liburing:

```c
#include <liburing.h>
#include <fcntl.h>
#include <stdio.h>

int main(void) {
    struct io_uring ring;
    struct io_uring_sqe *sqe;
    struct io_uring_cqe *cqe;
    char buf[4096];
    int fd, ret;

    /* Initialize ring with 32 SQE slots */
    io_uring_queue_init(32, &ring, 0);

    fd = open("/etc/hostname", O_RDONLY);

    /* Get a free SQE slot and describe a read */
    sqe = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe, fd, buf, sizeof(buf), 0);
    sqe->user_data = 42;   /* tag copied verbatim to CQE */

    /* Submit: tells the kernel there are pending SQEs */
    io_uring_submit(&ring);

    /* Wait for one completion */
    ret = io_uring_wait_cqe(&ring, &cqe);
    if (ret == 0) {
        printf("read %d bytes (tag=%llu)\n", cqe->res, cqe->user_data);
        io_uring_cqe_seen(&ring, cqe);   /* advance CQ head */
    }

    io_uring_queue_exit(&ring);
    return 0;
}
```

Compile with:

```bash
gcc -o example example.c -luring
```

### Key Patterns

**SQPOLL (zero-syscall I/O):**

```c
struct io_uring_params params = {
    .flags = IORING_SETUP_SQPOLL,
    .sq_thread_idle = 2000,  /* ms before thread sleeps */
};
int ring_fd = io_uring_setup(128, &params);
/* After this, io_uring_submit() does NOT need io_uring_enter() */
```

**Linked requests (ordered chain):**

```c
/* Write then fsync, guaranteed order */
sqe = io_uring_get_sqe(&ring);
io_uring_prep_write(sqe, fd, buf, len, 0);
sqe->flags |= IOSQE_IO_LINK;   /* link to next SQE */

sqe = io_uring_get_sqe(&ring);
io_uring_prep_fsync(sqe, fd, 0);
/* No IOSQE_IO_LINK here — ends the chain */

io_uring_submit(&ring);
```

---

## Further Reading

### Papers and Posts by Jens Axboe

- Axboe, [*Efficient IO with io_uring*](https://kernel.dk/io_uring.pdf) (2019) — the original design paper; explains the ring layout, SQPOLL, and fixed buffers
- Axboe, [*Lord of the io_uring*](https://unixism.net/loti/) — a practical guide with worked examples (hosted by Shuveb Hussain)

### LWN Articles

- [*The rapid growth of io_uring*](https://lwn.net/Articles/810414/) (2019) — early overview of capabilities and design rationale
- [*An introduction to the io_uring asynchronous I/O framework*](https://lwn.net/Articles/776703/) (2019) — how it compares to existing async interfaces
- [*io_uring and seccomp*](https://lwn.net/Articles/877165/) (2021) — security model and seccomp interaction

### Userspace Library

- [liburing on GitHub](https://github.com/axboe/liburing) — the standard userspace library; includes examples and wrappers for every opcode

### Kernel Documentation

- [`Documentation/filesystems/io_uring.rst`](https://docs.kernel.org/filesystems/io_uring.html) — in-tree documentation
- [`include/uapi/linux/io_uring.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/io_uring.h) — the definitive ABI reference

### Textbooks and Background

- Love, [*Linux Kernel Development*](https://www.oreilly.com/library/view/linux-kernel-development/9780768696974/) — Ch. 13 (Block I/O), background on the I/O stack io_uring builds on
- Stevens & Rago, [*Advanced Programming in the UNIX Environment*](https://www.oreilly.com/library/view/advanced-programming-in/9780321638014/) — Ch. 14 (Advanced I/O), for understanding the pre-io_uring landscape

---

## Appendix

- **[Glossary](../glossary.md)** — Terminology reference (SQE, CQE, SQPOLL, io-wq, fixed buffer, multishot)
