# io_uring vs epoll

> When to replace your event loop, when to keep it, and how to migrate

## The problem both solve

Modern servers need to wait on many file descriptors at once without spinning
or blocking. The naive approach — one thread per connection — collapses under
load because of context-switch overhead and memory (each thread needs a stack).

The Unix answer has evolved through three generations:

| Interface | Introduced | Mechanism | Scalability limit |
|-----------|-----------|-----------|-------------------|
| `select(2)` | BSD 4.2 | bitmap scan | O(maxfd); 1024 fd cap |
| `poll(2)` | SVR3 | linear scan of `pollfd[]` | O(N) per call |
| `epoll(7)` | Linux 2.5.44 | red-black tree + ready list | O(1) per event |
| `io_uring` | Linux 5.1 | shared-memory rings | O(0) syscalls (SQPOLL) |

`epoll` solved the scalability problem for **network sockets**: the kernel
tracks interest in a red-black tree and pushes ready fds into a linked list
that `epoll_wait` drains. Only *active* fds cost anything at wait time.

The gaps that remained:

- Regular files are *always* ready in epoll — `EPOLLIN` fires immediately,
  actual data is fetched synchronously in a follow-up `read()`.
- Every operation still needs at least one syscall: `epoll_ctl` to register,
  `epoll_wait` to block, then `read`/`write`/`accept` to do the I/O.
- No way to batch submissions or results across heterogeneous operation types.
- No kernel-side polling, no zero-copy, no integrated timers.

`io_uring` adds a single unified submission/completion interface that covers
network I/O, file I/O, timers, and cancellation. Under SQPOLL, userspace
submits work by writing to shared memory — zero syscalls.

---

## epoll internals

### Setup

```c
/* Create an epoll instance. size arg is ignored since 2.6.8 but must be > 0 */
int epfd = epoll_create1(EPOLL_CLOEXEC);

struct epoll_event ev = {
    .events  = EPOLLIN | EPOLLET,  /* edge-triggered read interest */
    .data.fd = client_fd,
};
epoll_ctl(epfd, EPOLL_CTL_ADD, client_fd, &ev);
```

```c
/* Block until events arrive (or timeout_ms elapses) */
struct epoll_event events[MAX_EVENTS];
int n = epoll_wait(epfd, events, MAX_EVENTS, timeout_ms);
for (int i = 0; i < n; i++) {
    handle_fd(events[i].data.fd, events[i].events);
}
```

### Kernel data structures

```
epoll instance (struct eventpoll)
  ├─ rbr: red-black tree
  │    Each node is a struct epitem (one per registered fd)
  │    epoll_ctl ADD/MOD/DEL = O(log N) tree operation
  │
  └─ rdllist: doubly-linked ready list
       When a socket becomes readable, the VFS wq callback fires,
       puts the epitem on rdllist.
       epoll_wait drains rdllist into the userspace events[] array.
```

`epoll_wait` cost is O(1) in the number of *active* fds, regardless of how
many fds are registered. That is the key insight epoll contributed.

### Edge-triggered vs level-triggered

- **Level-triggered (default):** `epoll_wait` returns an fd as long as data is
  available. Safe with standard blocking reads.
- **Edge-triggered (`EPOLLET`):** fires only on *state change* (new data
  arrival). Userspace must drain the fd completely with non-blocking reads.
  Used to reduce spurious wakeups at the cost of more careful buffering.

### EPOLLONESHOT

`EPOLLONESHOT` disables the fd after one event. Userspace must re-arm with
`EPOLL_CTL_MOD` after processing. Common pattern in multi-threaded servers to
avoid two threads waking on the same fd.

```c
ev.events = EPOLLIN | EPOLLONESHOT;
epoll_ctl(epfd, EPOLL_CTL_MOD, fd, &ev);  /* re-arm after handling */
```

---

## Where epoll falls short

### Regular files

```c
/* This always returns immediately — regular files are always "ready" */
ev.events = EPOLLIN;
epoll_ctl(epfd, EPOLL_CTL_ADD, open("big_file", O_RDONLY), &ev);
/* epoll_wait fires, but read() may still block in page-fault path */
```

The kernel's poll implementation for regular files unconditionally returns
`POLLIN | POLLOUT`. epoll cannot express "wake me when this disk read is
done." The actual I/O happens synchronously in the `read()` call after the
epoll event.

### Syscall cost per batch

Every I/O round-trip involves at minimum:

```
epoll_wait()          — syscall 1: block/wait
read() / recv()       — syscall 2: get data
write() / send()      — syscall 3: send response
epoll_ctl(MOD/ADD)    — syscall 4: re-arm if EPOLLONESHOT
```

At 100 K RPS, that is 400 K+ syscalls/second. Each syscall crosses the
user/kernel boundary, flushes the TLB partial state, and on systems with
mitigations (KPTI, Retpoline) costs 100–300 ns.

### No submission batching

`epoll_ctl` takes one fd at a time. Registering 1000 fds on startup means
1000 individual syscalls.

### No integrated timers

Timeouts require a separate `timerfd_create` + `EPOLL_CTL_ADD` or careful
use of the `epoll_wait` timeout argument — neither integrates cleanly into
an operation-level deadline model.

### No cancellation

There is no way to cancel a pending `epoll_wait` other than closing the fd or
sending a signal.

---

## io_uring's unified model

io_uring presents one ring for *all* asynchronous operations. The same
submission path handles:

```
Network:  IORING_OP_ACCEPT, IORING_OP_RECV, IORING_OP_SEND
Files:    IORING_OP_READ, IORING_OP_WRITE, IORING_OP_FSYNC
Poll:     IORING_OP_POLL_ADD, IORING_OP_POLL_REMOVE
Timers:   IORING_OP_TIMEOUT, IORING_OP_TIMEOUT_REMOVE
Other:    IORING_OP_CONNECT, IORING_OP_OPENAT, IORING_OP_CLOSE,
          IORING_OP_STATX, IORING_OP_SPLICE, IORING_OP_SEND_ZC
```

### IORING_OP_POLL_ADD — replacing epoll_wait

```c
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_poll_add(sqe, fd, POLLIN);
sqe->user_data = (uintptr_t)conn;  /* context pointer */
io_uring_submit(&ring);

/* Later, harvest completions */
struct io_uring_cqe *cqe;
io_uring_wait_cqe(&ring, &cqe);
if (cqe->res & POLLIN) {
    handle_readable((struct conn *)cqe->user_data);
}
io_uring_cqe_seen(&ring, cqe);
```

One-shot by default. Re-submit the SQE to re-arm, just like `EPOLLONESHOT`.

### IORING_POLL_ADD_MULTI — persistent fd monitoring

```c
sqe->len = IORING_POLL_ADD_MULTI;  /* multishot: don't auto-cancel */
```

With `IORING_POLL_ADD_MULTI`, a single submission keeps generating CQEs every
time the fd becomes ready — equivalent to level-triggered epoll without
re-arming. Cancel with `IORING_OP_POLL_REMOVE`.

```c
/* Cancel a multishot poll */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_poll_remove(sqe, user_data_tag);
io_uring_submit(&ring);
```

### Pipelining: ACCEPT + RECV in one ring

With linked SQEs (`IOSQE_IO_LINK`), a chain of operations completes in order
without returning to userspace between steps:

```c
/* SQE 0: accept */
sqe = io_uring_get_sqe(&ring);
io_uring_prep_multishot_accept(sqe, listen_fd, NULL, NULL, 0);
sqe->user_data = TAG_ACCEPT;

/* SQE 1: recv (linked to accept via IOSQE_IO_LINK on SQE 0) */
sqe = io_uring_get_sqe(&ring);
io_uring_prep_recv(sqe, IORING_FILE_INDEX_ALLOC, buf, sizeof(buf), 0);
sqe->flags |= IOSQE_FIXED_FILE;
sqe->user_data = TAG_RECV;

io_uring_submit(&ring);
```

### File I/O without threads

```c
/* Regular file read — actually async, not O_NONBLOCK faking */
sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(sqe, file_fd, buf, 4096, offset);
sqe->user_data = TAG_FILE_READ;
io_uring_submit(&ring);
/* epoll_wait on this fd would have returned "ready" immediately
   and then blocked in read(). io_uring does the actual I/O async. */
```

---

## Feature comparison

| Feature | epoll | io_uring |
|---------|-------|---------|
| Network socket readiness | Yes | Yes (`IORING_OP_POLL_ADD`) |
| Network socket I/O | Via `recv`/`send` after event | `IORING_OP_RECV` / `IORING_OP_SEND` |
| Regular file I/O | No (always ready) | Yes (`IORING_OP_READ` / `IORING_OP_WRITE`) |
| Pipes and FIFOs | Yes | Yes |
| `eventfd` / `timerfd` | Yes | Yes (`IORING_OP_POLL_ADD`) |
| Zero-copy send | No | Yes (`IORING_OP_SEND_ZC`, kernel ≥ 6.0) |
| Kernel-side polling | No | Yes (`IORING_SETUP_SQPOLL`) |
| Batched submission | No (one fd per `epoll_ctl`) | Yes (fill ring, one submit) |
| Batched completion harvest | Yes (`epoll_wait` returns N) | Yes (drain CQ ring) |
| Linked/chained operations | No | Yes (`IOSQE_IO_LINK`, `IOSQE_IO_HARDLINK`) |
| Multishot (persistent) | Yes (level-triggered default) | Yes (`IORING_POLL_ADD_MULTI`, multishot accept/recv) |
| Integrated timeouts | Partial (`timerfd` workaround) | Yes (`IORING_OP_TIMEOUT`, timeout-linked ops) |
| Cancellation | No | Yes (`IORING_OP_CANCEL`) |
| Fixed buffers / registered fds | No | Yes (`IORING_REGISTER_BUFFERS` / `IORING_REGISTER_FILES`) |
| POSIX portability | Linux only | Linux only (5.1+) |
| BSD / macOS equivalent | `kqueue` | No equivalent |
| Minimum kernel version | 2.5.44 | 5.1 (usable: 5.10+) |
| Userspace library | None needed | `liburing` (highly recommended) |

---

## Syscall overhead

### epoll path (per request, echo server example)

```
Client sends data:
  1. epoll_wait()             ← wake on EPOLLIN
  2. recv(fd, buf, len, 0)    ← read data
  3. send(fd, buf, len, 0)    ← write response
  [4. epoll_ctl(MOD, ...)     ← re-arm if EPOLLONESHOT]

= 3–4 syscalls per request
```

### io_uring path (without SQPOLL)

```
Client sends data:
  1. io_uring_enter()         ← submit RECV + SEND SQEs, wait for CQEs
                                 (or io_uring_submit + io_uring_wait_cqe)

= 1 syscall per batch of N requests
```

### io_uring path (with SQPOLL)

```
Client sends data:
  (no syscall — kernel SQPOLL thread sees new SQEs in shared memory)
  Completions appear in CQ ring
  Userspace reads CQ ring directly

= 0 syscalls per request (while ring is active)
```

### Numbers from the wild

Benchmarks on high-connection workloads (sources: io_uring author talks,
Cloudflare blog, Nginx io_uring experiments):

- At 100 K connections, epoll servers typically spend 15–25% of CPU time in
  syscall overhead alone.
- io_uring with SQPOLL reduces syscall count by ~80% in echo-server
  micro-benchmarks.
- `io_uring_enter` with batching (submit 32 SQEs, wait for 32 CQEs) brings
  per-operation syscall cost below 10 ns on modern CPUs.
- Zero-copy send (`IORING_OP_SEND_ZC`) removes the user→kernel buffer copy
  on large payloads, yielding another 10–15% throughput gain for >4 KB messages.

---

## Side-by-side: echo server

### epoll version

```c
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>

#define MAX_EVENTS 64
#define BUF_SIZE   4096

static void set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

int main(void) {
    int listen_fd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    int opt = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port   = htons(8080),
        .sin_addr   = { .s_addr = INADDR_ANY },
    };
    bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr));
    listen(listen_fd, 128);

    int epfd = epoll_create1(EPOLL_CLOEXEC);

    /* Register listen socket */
    struct epoll_event ev = { .events = EPOLLIN, .data.fd = listen_fd };
    epoll_ctl(epfd, EPOLL_CTL_ADD, listen_fd, &ev);

    struct epoll_event events[MAX_EVENTS];
    char buf[BUF_SIZE];

    for (;;) {
        int n = epoll_wait(epfd, events, MAX_EVENTS, -1); /* syscall 1 */
        for (int i = 0; i < n; i++) {
            int fd = events[i].data.fd;

            if (fd == listen_fd) {
                /* Accept new connection */
                int conn = accept4(listen_fd, NULL, NULL,
                                   SOCK_NONBLOCK | SOCK_CLOEXEC); /* syscall 2 */
                ev.events  = EPOLLIN | EPOLLET;
                ev.data.fd = conn;
                epoll_ctl(epfd, EPOLL_CTL_ADD, conn, &ev); /* syscall 3 */
            } else {
                /* Read and echo */
                ssize_t r;
                while ((r = recv(fd, buf, sizeof(buf), 0)) > 0) { /* syscall 4 */
                    send(fd, buf, r, 0);                           /* syscall 5 */
                }
                if (r == 0 || (r < 0 && errno != EAGAIN)) {
                    epoll_ctl(epfd, EPOLL_CTL_DEL, fd, NULL);      /* syscall 6 */
                    close(fd);                                      /* syscall 7 */
                }
            }
        }
    }
}
```

### io_uring version

```c
#include <liburing.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <string.h>

#define QUEUE_DEPTH  256
#define BUF_SIZE     4096

/* Tags encoded in user_data to identify CQE type */
#define TAG_ACCEPT  0x0100000000000000ULL
#define TAG_RECV    0x0200000000000000ULL
#define TAG_SEND    0x0300000000000000ULL

struct conn {
    int  fd;
    char buf[BUF_SIZE];
};

static void submit_accept(struct io_uring *ring, int listen_fd) {
    struct io_uring_sqe *sqe = io_uring_get_sqe(ring);
    /* multishot: keeps generating CQEs for every new connection */
    io_uring_prep_multishot_accept(sqe, listen_fd, NULL, NULL, 0);
    sqe->user_data = TAG_ACCEPT;
}

static void submit_recv(struct io_uring *ring, struct conn *c) {
    struct io_uring_sqe *sqe = io_uring_get_sqe(ring);
    io_uring_prep_recv(sqe, c->fd, c->buf, BUF_SIZE, 0);
    sqe->user_data = TAG_RECV | (uintptr_t)c;
}

static void submit_send(struct io_uring *ring, struct conn *c, int len) {
    struct io_uring_sqe *sqe = io_uring_get_sqe(ring);
    io_uring_prep_send(sqe, c->fd, c->buf, len, 0);
    sqe->user_data = TAG_SEND | (uintptr_t)c;
}

int main(void) {
    int listen_fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    int opt = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port   = htons(8080),
        .sin_addr   = { .s_addr = INADDR_ANY },
    };
    bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr));
    listen(listen_fd, 128);

    struct io_uring ring;
    io_uring_queue_init(QUEUE_DEPTH, &ring, 0);

    /* Submit multishot accept once — no re-arm needed */
    submit_accept(&ring, listen_fd);
    io_uring_submit(&ring); /* one-time setup syscall */

    for (;;) {
        struct io_uring_cqe *cqe;
        io_uring_wait_cqe(&ring, &cqe); /* single syscall for all events */

        uint64_t tag  = cqe->user_data & 0xff00000000000000ULL;
        void    *ptr  = (void *)(uintptr_t)(cqe->user_data & ~0xff00000000000000ULL);

        if (tag == TAG_ACCEPT) {
            if (cqe->res >= 0) {
                /* New connection fd in cqe->res */
                struct conn *c = calloc(1, sizeof(*c));
                c->fd = cqe->res;
                submit_recv(&ring, c); /* post RECV immediately */
                io_uring_submit(&ring);
            }
            /* multishot: accept SQE remains active, no re-arm */

        } else if (tag == TAG_RECV) {
            struct conn *c = ptr;
            if (cqe->res > 0) {
                submit_send(&ring, c, cqe->res); /* echo back */
                io_uring_submit(&ring);
            } else {
                close(c->fd);
                free(c);
            }

        } else if (tag == TAG_SEND) {
            struct conn *c = ptr;
            if (cqe->res > 0) {
                submit_recv(&ring, c); /* wait for next message */
                io_uring_submit(&ring);
            } else {
                close(c->fd);
                free(c);
            }
        }

        io_uring_cqe_seen(&ring, cqe);
    }
}
```

Key differences between the two versions:

- The io_uring version never calls `epoll_ctl`, `recv`, or `send` directly —
  those are expressed as SQEs.
- `multishot_accept` fires a CQE for every new connection without re-arming;
  the equivalent epoll code must call `accept4` in a loop plus `epoll_ctl ADD`
  per client.
- At high throughput, multiple CQEs can be drained in one `io_uring_wait_cqe`
  loop before the next submit, amortising the submit syscall across many
  completions.

---

## Migration patterns

### Step 1: replace `epoll_wait` with CQE drain

```c
/* Before */
int n = epoll_wait(epfd, events, MAX, -1);
for (int i = 0; i < n; i++) { handle(events[i]); }

/* After */
struct io_uring_cqe *cqe;
unsigned head;
io_uring_for_each_cqe(&ring, head, cqe) {
    handle_cqe(cqe);
}
io_uring_cq_advance(&ring, count);  /* bulk-advance head */
```

### Step 2: replace `epoll_ctl ADD` with `IORING_OP_POLL_ADD`

```c
/* Before */
struct epoll_event ev = { .events = EPOLLIN, .data.fd = fd };
epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &ev);

/* After */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_poll_add(sqe, fd, POLLIN);
sqe->user_data = (uintptr_t)conn;
/* batch with other SQEs; call io_uring_submit once */
```

### Step 3: replace post-event `recv` with `IORING_OP_RECV`

```c
/* Before (two-step: epoll says ready, then recv) */
/* epoll_wait fires */
ssize_t r = recv(fd, buf, len, 0);

/* After (one-step: submit RECV, get result in CQE) */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_recv(sqe, fd, buf, len, 0);
sqe->user_data = TAG_RECV | ctx;
/* result arrives as cqe->res, no separate recv() call */
```

### Step 4: optionally enable SQPOLL

```c
struct io_uring_params params = {
    .flags          = IORING_SETUP_SQPOLL,
    .sq_thread_idle = 10000, /* ms before SQPOLL thread sleeps */
};
io_uring_queue_init_params(QUEUE_DEPTH, &ring, &params);
/* After this, io_uring_submit() is optional — check sq_ring->flags
   for IORING_SQ_NEED_WAKEUP before calling it */
```

Requires `CAP_SYS_NICE` on kernels < 5.11, or `IORING_SETUP_SQPOLL` + a
privileged process. On 5.11+, unprivileged SQPOLL is allowed.

### Incremental migration strategy

```
Phase 1: introduce ring alongside epoll
  ├─ create io_uring ring at startup
  ├─ route new file I/O through io_uring (replace pread/pwrite threads)
  └─ keep existing epoll loop for socket events

Phase 2: migrate socket events
  ├─ replace EPOLL_CTL_ADD with IORING_OP_POLL_ADD for new connections
  ├─ replace recv/send after epoll event with IORING_OP_RECV / IORING_OP_SEND
  └─ drain epoll instances as fd count drops to zero

Phase 3: remove epoll entirely
  ├─ replace remaining epoll_ctl calls
  └─ optionally enable SQPOLL once correctness is confirmed
```

---

## When to keep epoll

**Portability is required.** epoll is Linux-only, but it has been around since
2.5.44. If the codebase must also compile on FreeBSD, macOS, or OpenBSD —
where `kqueue` is the equivalent — an abstraction layer (libevent, libuv,
uv__io_t) that speaks epoll on Linux and kqueue elsewhere is a better fit than
io_uring.

**Kernel version constraints.** io_uring stabilised across kernel versions:

```
5.1   — initial release (incomplete, many bugs)
5.6   — IORING_OP_SPLICE, fixed buffers stable
5.10  — IOSQE_BUFFER_SELECT, good stability baseline
5.11  — unprivileged SQPOLL
5.19  — multishot recv, send_zc prototype
6.0   — IORING_OP_SEND_ZC stable
6.1   — multishot recv stable
```

If the deployment target is RHEL 8 (kernel 4.18) or any kernel older than
5.10, io_uring either is unavailable or lacks important features.

**Small, simple event loops.** A single-threaded daemon watching 10 sockets
with a few thousand requests per second gets nothing from io_uring's batching
machinery. The added complexity is not worth it.

**`eventfd` / `signalfd` / `timerfd` heavy usage.** These are all valid epoll
targets. While io_uring can `POLL_ADD` on them, the existing epoll integration
is mature and well-understood. Migration offers minimal gain if the workload is
already dominated by these special fds.

**Audit and debugging tools.** Tools like strace, perf, and BPF-based
observability hooks have decades of epoll tracing support. io_uring syscall
patterns are different enough to break naive `epoll_wait`-based profiling.
`io_uring_register(IORING_REGISTER_ENABLE_RINGS)` and BPF tracing of
`io_uring_enter` work, but require updated tooling.

**Existing large codebase with mature epoll logic.** If the event loop is
deeply embedded in a production system (Nginx, HAProxy, Redis), the cost of
migration and re-testing outweighs the gains unless a specific bottleneck has
been measured.

---

## When io_uring wins

**New high-performance network servers.** If starting from scratch and
targeting Linux 5.10+, io_uring is the right default. The syscall savings
are real and compound at scale.

**\>50 K concurrent connections.** At this scale, the per-event syscall cost
of epoll becomes measurable. io_uring's batched submit/complete loop amortises
that cost across hundreds of events per syscall.

**Mixed file + network I/O.** Databases, object stores, and proxies that
read files and serve network clients in the same loop benefit most. With epoll,
file I/O requires a thread pool (because files are always "ready") or Linux AIO
(`libaio`), both of which have worse integration. io_uring handles both with
identical SQE/CQE semantics.

**Replacing Linux AIO for databases.** `libaio` only handles `O_DIRECT` reads
and writes, has a fixed 64 KB buffer alignment requirement, and uses
`io_submit`/`io_getevents` with suboptimal batching. io_uring supersedes it:
PostgreSQL, RocksDB, and ScyllaDB have all moved or are moving io_uring paths.

**Latency-critical paths.** With SQPOLL and registered fds/buffers, the data
path can be entirely in shared memory — no syscall crossing on the hot path.
Measured p99 latency improvements of 20–40% are reported for in-kernel SQPOLL
workloads vs. equivalent epoll servers.

**Zero-copy send for large payloads.** `IORING_OP_SEND_ZC` avoids the
userspace→kernel buffer copy on `send`. For payloads ≥ 4 KB (typical HTTP
response bodies, streaming media), this removes a significant memcpy on every
outbound write.

**Wanting to simplify the I/O threading model.** epoll-based servers often
have a dedicated thread pool for blocking file I/O alongside the event loop
threads. io_uring unifies both into a single ring, eliminating the synchronisation
overhead between the thread pool and the event loop.

---

## `io_uring_prep_poll_add` and `IORING_POLL_ADD_MULTI` in depth

For teams that want a minimal migration — "use io_uring as a better epoll" —
`IORING_OP_POLL_ADD` is the entry point.

### One-shot poll (epoll EPOLLONESHOT equivalent)

```c
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_poll_add(sqe, fd, POLLIN | POLLRDHUP);
io_uring_sqe_set_data(sqe, conn);

io_uring_submit(&ring);

/* CQE arrives when fd is readable */
struct io_uring_cqe *cqe;
io_uring_wait_cqe(&ring, &cqe);
struct conn *c = io_uring_cqe_get_data(cqe);
/* cqe->res contains the poll mask that fired */
io_uring_cqe_seen(&ring, cqe);

/* Must re-submit to watch fd again (like EPOLLONESHOT + EPOLL_CTL_MOD) */
```

### Multishot poll (epoll level-triggered equivalent)

```c
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_poll_multishot(sqe, fd, POLLIN);
io_uring_sqe_set_data(sqe, conn);
io_uring_submit(&ring);

/* CQEs keep arriving as long as fd remains ready.
   Check IORING_CQE_F_MORE in cqe->flags: */
struct io_uring_cqe *cqe;
io_uring_wait_cqe(&ring, &cqe);
if (!(cqe->flags & IORING_CQE_F_MORE)) {
    /* poll was cancelled or error — re-submit if needed */
}
io_uring_cqe_seen(&ring, cqe);
```

`IORING_CQE_F_MORE` being set means the multishot poll is still armed in the
kernel. When it is absent (cancelled, error, or `IORING_OP_POLL_REMOVE`), the
fd is no longer watched.

### Cancelling a multishot poll

```c
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_poll_remove(sqe, conn);  /* matches user_data */
io_uring_submit(&ring);
/* A CQE with res == 0 confirms cancellation */
```

### poll mask reference

```c
POLLIN      — data available to read          (EPOLLIN equivalent)
POLLOUT     — space available to write        (EPOLLOUT equivalent)
POLLRDHUP   — peer closed write end           (EPOLLRDHUP equivalent)
POLLHUP     — hang-up (connection closed)     (EPOLLHUP equivalent)
POLLERR     — error condition                 (EPOLLERR equivalent)
POLLPRI     — urgent / out-of-band data       (EPOLLPRI equivalent)
```

---

## Further reading

- [io_uring Architecture and Rings](io-uring-arch.md) — SQ/CQ ring layout,
  SQE/CQE structs, submission and completion flows
- [io_uring Operations and Advanced Features](io-uring-ops.md) — Full op list,
  SQPOLL, fixed buffers, registered files
- `liburing` source — `src/` contains `io_uring_prep_*` helpers that map
  directly to the SQE fields described above
- `io_uring/poll.c` in the kernel tree — implementation of `IORING_OP_POLL_ADD`
  and multishot logic
- Jens Axboe's io_uring notes — `kernel.dk/io_uring.pdf` (original design doc)
- `man 7 epoll`, `man 2 epoll_ctl`, `man 2 epoll_wait` — epoll reference
