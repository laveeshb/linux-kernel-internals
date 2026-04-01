# io_uring Multishot, Linked Requests, and Probing

> One SQE, many CQEs — persistent operations, chained I/O, and capability detection

## What multishot means

A normal io_uring submission follows a one-to-one model: one SQE produces exactly one CQE. The SQE is consumed, the operation runs once, the result appears in the CQ.

**Multishot** breaks that contract. One SQE stays armed in the kernel and continues producing CQEs — one per event — until it is explicitly cancelled or encounters a fatal error. The `IORING_CQE_F_MORE` flag in `cqe->flags` is the signal that more completions are still coming from the same SQE:

```c
/* cqe->flags interpretation */
if (cqe->flags & IORING_CQE_F_MORE) {
    /* SQE is still armed — do NOT resubmit */
} else {
    /* SQE is done — resubmit if you want to continue */
}
```

When `IORING_CQE_F_MORE` is absent, the multishot SQE has been disarmed. This happens on cancellation, on certain errors, or when the underlying resource goes away. The application must resubmit if it wants to resume.

The multishot model eliminates the round-trip of resubmitting a new SQE after every accepted connection or every received message — critical for high-connection-rate servers.

## Multishot accept (`IORING_OP_ACCEPT`)

**Added:** Linux 5.19 — `io_uring/net.c`

With `IORING_ACCEPT_MULTISHOT`, a single `IORING_OP_ACCEPT` SQE accepts connections indefinitely. Each incoming connection produces a CQE whose `res` field holds the new client file descriptor, exactly as a successful blocking `accept()` would return.

```c
#include <liburing.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>

#define QUEUE_DEPTH 64
#define TAG_ACCEPT  1ULL

int run_accept_loop(int listen_fd)
{
    struct io_uring ring;
    struct io_uring_sqe *sqe;
    struct io_uring_cqe *cqe;
    int ret;

    io_uring_queue_init(QUEUE_DEPTH, &ring, 0);

    /* Submit one multishot accept — it stays armed until we cancel it */
    sqe = io_uring_get_sqe(&ring);
    io_uring_prep_multishot_accept(sqe, listen_fd,
                                   NULL,   /* addr: filled per-CQE if non-NULL */
                                   NULL,   /* addrlen */
                                   0);     /* flags passed to accept4() */
    io_uring_sqe_set_data64(sqe, TAG_ACCEPT);
    io_uring_submit(&ring);

    for (;;) {
        ret = io_uring_wait_cqe(&ring, &cqe);
        if (ret < 0) {
            perror("io_uring_wait_cqe");
            break;
        }

        if (io_uring_cqe_get_data64(cqe) == TAG_ACCEPT) {
            bool more = cqe->flags & IORING_CQE_F_MORE;

            if (cqe->res >= 0) {
                int client_fd = cqe->res;
                handle_client(client_fd);   /* your per-connection handler */
            } else if (cqe->res != -ECANCELED) {
                fprintf(stderr, "accept error: %s\n", strerror(-cqe->res));
            }

            io_uring_cqe_seen(&ring, cqe);

            if (!more) {
                /* SQE was disarmed — resubmit to keep accepting */
                sqe = io_uring_get_sqe(&ring);
                io_uring_prep_multishot_accept(sqe, listen_fd, NULL, NULL, 0);
                io_uring_sqe_set_data64(sqe, TAG_ACCEPT);
                io_uring_submit(&ring);
            }
        } else {
            /* handle other completions */
            io_uring_cqe_seen(&ring, cqe);
        }
    }

    io_uring_queue_exit(&ring);
    return 0;
}
```

To cancel the multishot accept, submit an `IORING_OP_ASYNC_CANCEL` targeting the same `user_data`:

```c
sqe = io_uring_get_sqe(&ring);
io_uring_prep_cancel64(sqe, TAG_ACCEPT, 0);
io_uring_submit(&ring);
/* The multishot accept will post a final CQE with res == -ECANCELED
   and IORING_CQE_F_MORE will be absent */
```

The kernel implementation lives in `io_uring/net.c` (`io_accept_multishot()`). On each `inet_csk_accept()` return, the kernel posts a CQE and immediately re-arms the wait — no round-trip to userspace required between connections.

## Multishot recv (`IORING_OP_RECV`)

**Added:** Linux 5.20 / 6.0 — `io_uring/net.c`

`IORING_RECV_MULTISHOT` on `IORING_OP_RECV` keeps reading from a socket and posting a CQE on each arrival. Because the kernel doesn't know how large each message will be in advance, multishot recv **requires** provided buffers (`IOSQE_BUFFER_SELECT`): the kernel picks a buffer from a pre-registered pool for each receive, and the CQE's `flags` field carries the buffer ID via `IORING_CQE_BUFFER_SHIFT`.

```c
#define NUM_BUFS   64
#define BUF_SIZE   4096
#define BUF_GID    0

/* Step 1: allocate and register a buffer ring */
struct io_uring_buf_ring *buf_ring;
void *bufs[NUM_BUFS];
unsigned ring_mask = io_uring_buf_ring_mask(NUM_BUFS);

buf_ring = io_uring_setup_buf_ring(&ring, NUM_BUFS, BUF_GID, 0, &ret);

for (int i = 0; i < NUM_BUFS; i++) {
    bufs[i] = malloc(BUF_SIZE);
    io_uring_buf_ring_add(buf_ring, bufs[i], BUF_SIZE,
                          i, ring_mask, i);
}
io_uring_buf_ring_advance(buf_ring, NUM_BUFS);

/* Step 2: submit one multishot recv — stays armed across all incoming data */
sqe = io_uring_get_sqe(&ring);
io_uring_prep_recv_multishot(sqe, client_fd, NULL, 0, 0);
sqe->buf_group = BUF_GID;
io_uring_sqe_set_flags(sqe, IOSQE_BUFFER_SELECT);
io_uring_sqe_set_data64(sqe, TAG_RECV);
io_uring_submit(&ring);

/* Step 3: harvest CQEs */
io_uring_wait_cqe(&ring, &cqe);
if (cqe->res > 0) {
    int buf_id = cqe->flags >> IORING_CQE_BUFFER_SHIFT;
    int bytes  = cqe->res;
    process_data(bufs[buf_id], bytes);

    /* Return the buffer to the pool */
    io_uring_buf_ring_add(buf_ring, bufs[buf_id], BUF_SIZE,
                          buf_id, ring_mask, 0);
    io_uring_buf_ring_advance(buf_ring, 1);
} else if (cqe->res == 0) {
    /* EOF: peer closed connection */
} else {
    fprintf(stderr, "recv error: %s\n", strerror(-cqe->res));
}
bool more = cqe->flags & IORING_CQE_F_MORE;
io_uring_cqe_seen(&ring, cqe);
/* if !more: resubmit */
```

If the buffer pool runs dry, the multishot recv is automatically disarmed and posts a CQE with `res == -ENOBUFS` and `IORING_CQE_F_MORE` absent. Refill the buffer ring and resubmit.

## Linked requests (`IOSQE_IO_LINK` / `IOSQE_IO_HARDLINK`)

Linked requests let you express **ordering dependencies** between SQEs without any application involvement between steps. The kernel executes the chain sequentially: SQE B does not start until SQE A completes.

Set `IOSQE_IO_LINK` on each SQE that should be followed by the next. The final SQE in the chain carries no link flag.

### `IOSQE_IO_LINK` — soft link

If the linked SQE fails (non-zero `res`), all subsequent SQEs in the chain receive a CQE with `res == -ECANCELED`. The chain is broken.

### `IOSQE_IO_HARDLINK` — hard link

The chain continues regardless of whether the linked SQE succeeds or fails. Each SQE runs in sequence unconditionally. Useful when you need cleanup steps that must run even after an error.

### Example: write then fsync

A common pattern for durable writes: persist data, then flush. A link guarantees `fsync` only runs after the write completes, and both are submitted in a single `io_uring_submit` call:

```c
#include <liburing.h>

int durable_write(struct io_uring *ring, int fd,
                  const void *buf, size_t len, off_t offset)
{
    struct io_uring_sqe *sqe;
    struct io_uring_cqe *cqe;
    int ret;

    /* SQE 1: write — linked to SQE 2 */
    sqe = io_uring_get_sqe(ring);
    io_uring_prep_write(sqe, fd, buf, len, offset);
    io_uring_sqe_set_flags(sqe, IOSQE_IO_LINK);
    io_uring_sqe_set_data64(sqe, 1);   /* tag: write */

    /* SQE 2: fsync — runs only if write succeeded */
    sqe = io_uring_get_sqe(ring);
    io_uring_prep_fsync(sqe, fd, 0);   /* 0 = fsync (not fdatasync) */
    /* no IOSQE_IO_LINK: end of chain */
    io_uring_sqe_set_data64(sqe, 2);   /* tag: fsync */

    /* Submit both in one syscall */
    io_uring_submit(ring);

    /* Collect both completions */
    for (int i = 0; i < 2; i++) {
        ret = io_uring_wait_cqe(ring, &cqe);
        uint64_t tag = io_uring_cqe_get_data64(cqe);
        if (cqe->res < 0) {
            fprintf(stderr, "%s failed: %s\n",
                    tag == 1 ? "write" : "fsync",
                    strerror(-cqe->res));
        }
        io_uring_cqe_seen(ring, cqe);
    }
    return 0;
}
```

If the write fails, the fsync CQE arrives with `res == -ECANCELED` — no need to check the fsync result independently. To force the fsync regardless, replace `IOSQE_IO_LINK` with `IOSQE_IO_HARDLINK`.

### Link timeouts

A `IORING_OP_LINK_TIMEOUT` SQE can be appended to a chain to bound its total duration. If the linked operation doesn't complete within the timeout, it is cancelled:

```c
/* connect with a 5-second timeout */
sqe = io_uring_get_sqe(ring);
io_uring_prep_connect(sqe, fd, addr, addrlen);
io_uring_sqe_set_flags(sqe, IOSQE_IO_LINK);

sqe = io_uring_get_sqe(ring);
io_uring_prep_link_timeout(sqe, &(struct __kernel_timespec){
    .tv_sec = 5, .tv_nsec = 0
}, 0);
```

## `IORING_OP_POLL_ADD` multishot

**Added:** Linux 5.13 — `io_uring/poll.c`

Normal `IORING_OP_POLL_ADD` fires once and is consumed. Adding `IORING_POLL_ADD_MULTI` makes it persistent: the SQE stays registered and a CQE is posted every time the polled events occur on the fd.

```c
sqe = io_uring_get_sqe(&ring);
io_uring_prep_poll_add(sqe, fd, POLLIN);
sqe->len |= IORING_POLL_ADD_MULTI;   /* multishot poll */
io_uring_sqe_set_data64(sqe, TAG_POLL);
io_uring_submit(&ring);

/* Each time fd becomes readable, a CQE arrives:
 *   cqe->res  = triggered poll events (POLLIN, POLLHUP, ...)
 *   cqe->flags & IORING_CQE_F_MORE: still armed
 */
```

This provides an alternative to `epoll` for persistent fd readiness notification inside an io_uring event loop — all events go through the same CQ, avoiding the context switch to `epoll_wait`.

To cancel:

```c
sqe = io_uring_get_sqe(&ring);
io_uring_prep_poll_remove(sqe, TAG_POLL);
io_uring_submit(&ring);
```

## Probing capabilities (`io_uring_probe`)

io_uring adds new opcodes and features frequently — and not all kernels support all operations. Calling an unsupported opcode produces `EINVAL` or `EOPNOTSUPP`, which is difficult to distinguish from a usage error. The probe API lets you query the kernel's capabilities before committing to a code path.

### Raw probe via `io_uring_register`

```c
#include <linux/io_uring.h>
#include <stdlib.h>

struct io_uring_probe *probe_kernel(int ring_fd)
{
    /* Allocate space for the probe struct + opcode entries */
    int nr_ops = IORING_OP_LAST;
    struct io_uring_probe *probe = calloc(1,
        sizeof(*probe) + nr_ops * sizeof(struct io_uring_probe_op));

    int ret = io_uring_register(ring_fd,
                                IORING_REGISTER_PROBE,
                                probe,
                                nr_ops);
    if (ret < 0) {
        free(probe);
        return NULL;
    }
    return probe;
}

/* Check one opcode */
bool op_supported(const struct io_uring_probe *probe, unsigned op)
{
    if (op > probe->last_op)
        return false;
    return probe->ops[op].flags & IO_URING_OP_SUPPORTED;
}
```

### liburing helper

```c
#include <liburing.h>

struct io_uring ring;
io_uring_queue_init(8, &ring, 0);

struct io_uring_probe *probe = io_uring_get_probe_ring(&ring);

if (io_uring_opcode_supported(probe, IORING_OP_ACCEPT)) {
    /* multishot accept available? check kernel version or probe flags */
}
if (io_uring_opcode_supported(probe, IORING_OP_SEND_ZC)) {
    printf("zero-copy send supported\n");
}

io_uring_free_probe(probe);
io_uring_queue_exit(&ring);
```

`io_uring_get_probe_ring()` calls `io_uring_register(IORING_REGISTER_PROBE)` internally and returns a heap-allocated `io_uring_probe`. Free it with `io_uring_free_probe()`.

### Why probing matters

| Approach | Consequence of missing op |
|----------|--------------------------|
| Unconditional use | `EINVAL` / `EOPNOTSUPP` at runtime, hard to diagnose |
| Version check (`uname`) | Fragile: backports, distribution kernels |
| Feature flag check (`params.features`) | Only covers ring-level features, not per-opcode |
| `io_uring_register(IORING_REGISTER_PROBE)` | Definitive per-opcode answer from the running kernel |

Probe once at startup, store the results, and branch on them. The probe syscall is cheap — one `io_uring_register` call.

## Putting it together: multishot accept with linked reads

A sketch of a server that combines multishot accept, per-connection multishot recv, and linked write+fsync for log durability:

```
listen_fd
    │
    └─▶ multishot ACCEPT (one SQE, never resubmitted unless disarmed)
              │
              ▼  CQE: cqe->res = client_fd
         per-connection:
              │
              └─▶ multishot RECV + IOSQE_BUFFER_SELECT
                        │
                        ▼  CQE: buf_id = cqe->flags >> IORING_CQE_BUFFER_SHIFT
                   process data
                        │
                        └─▶ linked WRITE → FSYNC (one io_uring_submit)
```

All three operation types drain into the same CQ. A single event loop harvests them by checking `user_data` tags to dispatch each CQE to the right handler. No epoll, no thread-per-connection, no per-event syscall.

## Further reading

- [Architecture and Rings](io-uring-arch.md) — SQE/CQE structures, ring layout, `io_uring_enter`
- [Operations and Advanced Features](io-uring-ops.md) — SQPOLL, fixed files, provided buffers
- `io_uring/net.c` in the kernel tree — `io_accept_multishot()`, `io_recv_multishot()`
- `io_uring/poll.c` in the kernel tree — `io_poll_multishot()`
- `include/uapi/linux/io_uring.h` — `IORING_ACCEPT_MULTISHOT`, `IORING_RECV_MULTISHOT`, `IORING_POLL_ADD_MULTI`, `IORING_CQE_F_MORE`
- `liburing` GitHub repository — `io_uring_prep_multishot_accept()`, `io_uring_get_probe_ring()`
