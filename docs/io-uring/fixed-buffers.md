# Fixed Buffers and Fixed Files

> Amortizing page pinning and fd lookup across I/O operations

## The per-operation tax

Every `read()` or `write()` — and every plain `IORING_OP_READ` — pays two costs that are easy to overlook:

**Page pinning.** Before DMA can start, the kernel must ensure the target pages stay resident in physical memory for the duration of the transfer. This means calling `get_user_pages()` to walk the page tables, increment the page's reference count, and pin each page against reclaim. When the I/O completes, the pages must be unpinned (`unpin_user_pages()`). On a NVMe device capable of 1M IOPS, with a 4 KB buffer spanning a single page, that is 1M pin/unpin cycles per second — each one a TLB-unfriendly page-table walk.

**File descriptor lookup.** The kernel resolves an integer `fd` to a `struct file *` on every operation via `fdget()`, which takes a reference on the file and must drop it when done. At high IOPS the lock contention on the file descriptor table is measurable.

Fixed buffers and fixed files solve these problems by paying the cost once, at registration time, and amortizing it across every subsequent I/O.

## Fixed buffers (`IORING_REGISTER_BUFFERS`)

### Registration

```c
#include <sys/uio.h>
#include <liburing.h>

#define NR_BUFS  8
#define BUF_SIZE (64 * 1024)  /* 64 KB per buffer */

static char bufs[NR_BUFS][BUF_SIZE];

struct iovec iovecs[NR_BUFS];
for (int i = 0; i < NR_BUFS; i++) {
    iovecs[i].iov_base = bufs[i];
    iovecs[i].iov_len  = BUF_SIZE;
}

/* Register all buffers in one call */
int ret = io_uring_register_buffers(&ring, iovecs, NR_BUFS);
if (ret < 0) {
    perror("io_uring_register_buffers");
    return ret;
}
```

Under the hood, `io_uring_register_buffers` issues:

```c
io_uring_register(ring_fd, IORING_REGISTER_BUFFERS, iovecs, nr_iovecs);
```

The kernel handler (`io_sqe_buffers_register` in `io_uring/rsrc.c`) iterates every `iovec`, calls `get_user_pages_fast()` to pin all pages, and stores the resulting `struct page **` arrays inside an `io_mapped_ubuf` structure:

```c
/* io_uring/rsrc.c (simplified) */
struct io_mapped_ubuf {
    u64         ubuf;         /* start of userspace virtual address */
    u64         ubuf_end;     /* end (exclusive) */
    unsigned    nr_bvecs;     /* number of struct bio_vec entries */
    struct bio_vec bvec[];    /* one per page, for direct DMA use */
};
```

These `io_mapped_ubuf` pointers are gathered into an `io_rsrc_data` table and stored on `io_ring_ctx`:

```c
/* io_uring/io_uring.h */
struct io_ring_ctx {
    /* ... */
    struct io_rsrc_data     *buf_data;   /* registered buffers table */
    struct io_rsrc_data     *file_data;  /* registered files table */
    /* ... */
};
```

The pages remain pinned — and the `bio_vec` table stays valid — until the buffers are unregistered. No page-table walk happens on the I/O submission path.

### Using fixed buffers in SQEs

Use `IORING_OP_READ_FIXED` / `IORING_OP_WRITE_FIXED` and set `buf_index` in the SQE to the index of the registered buffer:

```c
/* SQE fields involved */
struct io_uring_sqe {
    __u8   opcode;     /* IORING_OP_READ_FIXED or IORING_OP_WRITE_FIXED */
    __u64  addr;       /* pointer into the registered buffer */
    __u32  len;        /* bytes to transfer */
    __u64  off;        /* file offset */
    __u16  buf_index;  /* index into the registered buffer table */
    /* ... */
};
```

With liburing:

```c
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);

/* Read into registered buffer 2, starting at byte 0 of that buffer */
io_uring_prep_read_fixed(sqe, fd, bufs[2], BUF_SIZE, /*offset=*/0, /*buf_index=*/2);
io_uring_sqe_set_data64(sqe, 2);  /* tag = buffer index, for matching CQEs */

io_uring_submit(&ring);
```

`addr` must fall within the range `[iovecs[buf_index].iov_base, iov_base + iov_len)`. The kernel validates this at submission time and returns `-EFAULT` if the range is out of bounds.

### Unregistering

```c
io_uring_unregister_buffers(&ring);
/* equivalent to:
   io_uring_register(ring_fd, IORING_UNREGISTER_BUFFERS, NULL, 0); */
```

All pinned pages are released. Any in-flight operations that reference the buffers must complete before unregistration succeeds.

## Fixed files (`IORING_REGISTER_FILES`)

### Registration

```c
int fds[MAX_CLIENTS];
/* fill fds[0..n-1] with open file descriptors; use -1 for empty slots */
fds[0] = open("data.bin", O_RDONLY | O_DIRECT);
fds[1] = accept(listen_fd, NULL, NULL);
/* remaining slots pre-populated as -1 */
for (int i = 2; i < MAX_CLIENTS; i++) fds[i] = -1;

int ret = io_uring_register_files(&ring, fds, MAX_CLIENTS);
if (ret < 0) {
    perror("io_uring_register_files");
    return ret;
}
```

The raw syscall is:

```c
io_uring_register(ring_fd, IORING_REGISTER_FILES, fds, nr_fds);
```

The kernel resolves each fd to its `struct file *`, calls `fget()` once to take a counted reference, and stores the pointer in the `io_rsrc_data` files table on `io_ring_ctx`. Subsequent operations use the stored pointer directly — `fdget()` is not called on the submission path.

### Using fixed files in SQEs

Set `IOSQE_FIXED_FILE` in `sqe->flags` and use the registered array index as `sqe->fd`:

```c
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);

/* Read from fixed file at index 0; use registered buffer at index 0 */
io_uring_prep_read_fixed(sqe, /*fd=*/0, bufs[0], BUF_SIZE, 0, /*buf_index=*/0);
io_uring_sqe_set_flags(sqe, IOSQE_FIXED_FILE);
io_uring_sqe_set_data64(sqe, 0);

io_uring_submit(&ring);
```

Fixed files and fixed buffers are independent features and can be combined freely in the same SQE.

### Updating slots without full re-registration

When a client disconnects and a new one connects, update the relevant slot atomically — without unregistering the entire table:

```c
int new_fd = accept(listen_fd, NULL, NULL);
unsigned slot = find_free_slot();

/* Replace slot `slot` with new_fd */
int ret = io_uring_register_files_update(&ring, slot, &new_fd, 1);
if (ret < 0)
    perror("io_uring_register_files_update");
```

This maps to `IORING_REGISTER_FILES_UPDATE` and allows per-slot updates at runtime. Setting a slot to `-1` releases the reference for that slot.

### Unregistering

```c
io_uring_unregister_files(&ring);
```

## Performance numbers

The performance benefit from fixed resources compounds at higher IOPS:

| Workload | Plain ops | Fixed buffers | Fixed files | Both |
|----------|-----------|---------------|-------------|------|
| 4 KB sequential read, NVMe | baseline | +8–12% throughput | +3–5% throughput | +12–18% throughput |
| 4 KB random read, NVMe, 32 depth | baseline | −20–30 µs CPU/op | −5–10 µs CPU/op | −30–40 µs CPU/op |
| High-concurrency socket recv | baseline | negligible | +5–10% | +8–15% |

Three distinct effects drive the numbers:

1. **Eliminated TLB pressure.** Page-table walks during `get_user_pages()` dirty TLB entries and evict cache lines used by the application. Pinning once removes this interference for the duration of the ring's lifetime.

2. **Reduced kernel CPU time.** Profiling with `perf` on a busy io_uring workload shows `get_user_pages_fast` and `unpin_user_pages` appearing prominently in kernel CPU profiles. With fixed buffers, these symbols disappear from the profile entirely.

3. **Fewer atomic operations.** `fdget()` increments the file's reference count with an atomic `atomic_long_inc`. At 1M IOPS with 100 concurrent connections, the contention on file reference counts is visible in CPU cycle counts. Fixed files replace per-op atomics with a single `fget` at registration time.

The gains are most visible with small I/O operations on fast NVMe or in-memory filesystems (tmpfs, ramfs), where the kernel overhead is large relative to the actual I/O time. On rotating disk, I/O latency dominates and the savings are proportionally smaller.

## Buffer rings (Linux 5.19+)

Fixed buffers work well when the application assigns each I/O to a specific buffer. For socket `recv` or similar operations where the incoming data size is not known in advance, the application cannot safely assign a buffer at SQE submission time — the buffer might not be large enough, or hundreds of inflight receives might exhaust the buffer pool.

**Provided buffer rings** (`IORING_REGISTER_PBUF_RING`, added in Linux 5.19) solve this by letting the kernel select a buffer from a pool at the moment data arrives:

### Setting up a buffer ring

```c
#include <liburing.h>

#define NUM_BUFS  64
#define BUF_SIZE  4096

/* Allocate the shared buffer ring and the backing buffers */
struct io_uring_buf_ring *buf_ring;
unsigned ring_mask = io_uring_buf_ring_mask(NUM_BUFS);

/* io_uring_setup_buf_ring allocates buf_ring via mmap and registers it */
int bgid = 0;  /* buffer group ID */
buf_ring = io_uring_setup_buf_ring(&ring, NUM_BUFS, bgid, 0, &ret);
if (!buf_ring) {
    fprintf(stderr, "io_uring_setup_buf_ring: %s\n", strerror(-ret));
    return ret;
}

/* Backing storage for the buffers themselves */
char *bufs = malloc((size_t)NUM_BUFS * BUF_SIZE);

/* Add all buffers to the ring */
for (int i = 0; i < NUM_BUFS; i++) {
    io_uring_buf_ring_add(buf_ring,
                          bufs + (size_t)i * BUF_SIZE, /* buf pointer */
                          BUF_SIZE,                     /* length */
                          i,                            /* buffer ID (bid) */
                          ring_mask,
                          i);                           /* offset in ring */
}
io_uring_buf_ring_advance(buf_ring, NUM_BUFS);
```

The `io_uring_buf_ring` is a single-producer (userspace) / single-consumer (kernel) ring. Userspace adds buffers via `io_uring_buf_ring_add` and commits them with `io_uring_buf_ring_advance`. The kernel picks from the tail.

### Submitting a recv with buffer selection

```c
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);

/* NULL buffer, zero length: kernel will choose */
io_uring_prep_recv(sqe, client_fd, NULL, 0, 0);
sqe->buf_group = bgid;  /* which buffer group to draw from */
io_uring_sqe_set_flags(sqe, IOSQE_BUFFER_SELECT);
io_uring_sqe_set_data64(sqe, (uint64_t)client_fd);

io_uring_submit(&ring);
```

### Consuming completions and recycling buffers

```c
struct io_uring_cqe *cqe;
io_uring_wait_cqe(&ring, &cqe);

if (cqe->res < 0) {
    fprintf(stderr, "recv error: %s\n", strerror(-cqe->res));
} else {
    /* Which buffer did the kernel pick? */
    int bid   = cqe->flags >> IORING_CQE_BUFFER_SHIFT;
    int bytes = cqe->res;
    char *data = bufs + (size_t)bid * BUF_SIZE;

    process_data(data, bytes);

    /* Return the buffer to the ring for reuse */
    io_uring_buf_ring_add(buf_ring, data, BUF_SIZE, bid, ring_mask, 0);
    io_uring_buf_ring_advance(buf_ring, 1);
}
io_uring_cqe_seen(&ring, cqe);
```

`IORING_CQE_F_BUFFER` is set in `cqe->flags` whenever a buffer was selected; if it is not set (e.g., on error), `bid` is meaningless and the buffer was not consumed.

The underlying registration syscall is:

```c
struct io_uring_buf_reg reg = {
    .ring_addr    = (uint64_t)buf_ring,
    .ring_entries = NUM_BUFS,           /* must be power of two */
    .bgid         = bgid,
};
io_uring_register(ring_fd, IORING_REGISTER_PBUF_RING, &reg, 1);
```

To unregister:

```c
io_uring_free_buf_ring(&ring, buf_ring, NUM_BUFS, bgid);
/* equivalent to IORING_UNREGISTER_PBUF_RING */
```

## Complete C example

The following example registers both buffers and a file, issues a `IORING_OP_READ_FIXED`, and cleans up:

```c
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <liburing.h>

#define BUF_SIZE  (64 * 1024)   /* 64 KB */
#define NR_BUFS   4
#define QUEUE_DEPTH 8

int main(int argc, char *argv[])
{
    if (argc < 2) {
        fprintf(stderr, "usage: %s <file>\n", argv[0]);
        return 1;
    }

    /* --- Open the file --- */
    int fd = open(argv[1], O_RDONLY | O_DIRECT);
    if (fd < 0) {
        perror("open");
        return 1;
    }

    /* --- Initialize the ring --- */
    struct io_uring ring;
    int ret = io_uring_queue_init(QUEUE_DEPTH, &ring, 0);
    if (ret < 0) {
        fprintf(stderr, "io_uring_queue_init: %s\n", strerror(-ret));
        return 1;
    }

    /* --- Register buffers (aligned for O_DIRECT) --- */
    static char raw[NR_BUFS][BUF_SIZE] __attribute__((aligned(4096)));
    struct iovec iovecs[NR_BUFS];
    for (int i = 0; i < NR_BUFS; i++) {
        iovecs[i].iov_base = raw[i];
        iovecs[i].iov_len  = BUF_SIZE;
    }
    ret = io_uring_register_buffers(&ring, iovecs, NR_BUFS);
    if (ret < 0) {
        fprintf(stderr, "io_uring_register_buffers: %s\n", strerror(-ret));
        return 1;
    }

    /* --- Register the file --- */
    ret = io_uring_register_files(&ring, &fd, 1);
    if (ret < 0) {
        fprintf(stderr, "io_uring_register_files: %s\n", strerror(-ret));
        return 1;
    }
    /* fd is now accessible as fixed file index 0; the integer fd is no
       longer needed for I/O (but still needed for close()). */

    /* --- Submit a fixed read --- */
    struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
    if (!sqe) {
        fprintf(stderr, "ring full\n");
        return 1;
    }

    /*
     * io_uring_prep_read_fixed(sqe, fd_or_index, buf, nbytes, offset, buf_index)
     *   - fd_or_index: 0 = fixed file index 0
     *   - buf:         pointer into registered buffer 0
     *   - buf_index:   0 = registered buffer 0
     */
    io_uring_prep_read_fixed(sqe,
                             /*fd*/        0,
                             /*buf*/       raw[0],
                             /*nbytes*/    BUF_SIZE,
                             /*offset*/    0,
                             /*buf_index*/ 0);
    io_uring_sqe_set_flags(sqe, IOSQE_FIXED_FILE);
    io_uring_sqe_set_data64(sqe, 42);   /* arbitrary user tag */

    ret = io_uring_submit(&ring);
    if (ret < 0) {
        fprintf(stderr, "io_uring_submit: %s\n", strerror(-ret));
        return 1;
    }

    /* --- Wait for completion --- */
    struct io_uring_cqe *cqe;
    ret = io_uring_wait_cqe(&ring, &cqe);
    if (ret < 0) {
        fprintf(stderr, "io_uring_wait_cqe: %s\n", strerror(-ret));
        return 1;
    }

    if (cqe->res < 0) {
        fprintf(stderr, "read error: %s\n", strerror(-cqe->res));
    } else {
        printf("read %d bytes (tag=%" PRIu64 ")\n",
               cqe->res, io_uring_cqe_get_data64(cqe));
        /* raw[0][0..cqe->res-1] contains the data */
    }
    io_uring_cqe_seen(&ring, cqe);

    /* --- Cleanup --- */
    io_uring_unregister_buffers(&ring);
    io_uring_unregister_files(&ring);
    io_uring_queue_exit(&ring);
    close(fd);
    return 0;
}
```

Compile with:

```bash
gcc -O2 -o fixed_read fixed_read.c -luring
```

Key points in the example:

- `IOSQE_FIXED_FILE` must be set whenever `sqe->fd` is a registered file index, not a real file descriptor.
- `buf_index` in `io_uring_prep_read_fixed` must match the index in the `iovecs[]` array passed to `io_uring_register_buffers`.
- `addr` (the `buf` argument) must lie within the registered region for `buf_index`. Passing `raw[0]` with `buf_index=0` satisfies this because `iovecs[0].iov_base == raw[0]`.
- Unregistration order does not matter, but both should happen before `io_uring_queue_exit`.

## Further reading

- [Architecture and Rings](io-uring-arch.md) — Ring layout, SQE/CQE structures, mmap setup
- [Operations and Advanced Features](io-uring-ops.md) — Supported opcodes, SQPOLL, linked requests
- `io_uring/rsrc.c` in the kernel tree — `io_sqe_buffers_register`, `io_sqe_files_register`, `io_mapped_ubuf`
- `io_uring/rsrc.h` — `io_rsrc_data`, `io_rsrc_node` structures
- `liburing/src/register.c` — userspace wrappers for all `io_uring_register` operations
- `liburing/test/fixed-buffers.c` — liburing test suite examples for fixed buffer edge cases
