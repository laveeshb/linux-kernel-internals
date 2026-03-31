# io_uring Operations and Advanced Features

> From basic read/write to SQPOLL and linked requests

## Supported operations

io_uring supports a wide range of operations, all async:

### File and socket I/O

```c
/* Read/write (like pread64/pwrite64) */
IORING_OP_READ        /* read from fd at offset */
IORING_OP_WRITE       /* write to fd at offset */
IORING_OP_READV       /* scatter read (struct iovec) */
IORING_OP_WRITEV      /* gather write */
IORING_OP_READ_FIXED  /* read into pre-registered buffer */
IORING_OP_WRITE_FIXED /* write from pre-registered buffer */

/* Socket operations */
IORING_OP_ACCEPT      /* accept connection */
IORING_OP_CONNECT     /* connect to address */
IORING_OP_SEND        /* send on socket */
IORING_OP_RECV        /* receive from socket */
IORING_OP_SENDMSG     /* sendmsg (scatter/gather, ancillary data) */
IORING_OP_RECVMSG     /* recvmsg */
IORING_OP_SEND_ZC     /* zero-copy send (kernel 6.0+) */
IORING_OP_SENDMSG_ZC

/* File operations */
IORING_OP_OPENAT      /* open file */
IORING_OP_OPENAT2     /* openat2 with how struct */
IORING_OP_CLOSE       /* close fd */
IORING_OP_STATX       /* statx */
IORING_OP_FADVISE     /* posix_fadvise */
IORING_OP_FALLOCATE   /* fallocate */
IORING_OP_FSYNC       /* fsync/fdatasync */
IORING_OP_SYNC_FILE_RANGE

/* Directory operations */
IORING_OP_RENAMEAT    /* rename */
IORING_OP_UNLINKAT    /* unlink/rmdir */
IORING_OP_MKDIRAT     /* mkdir */
IORING_OP_LINKAT      /* link */
IORING_OP_SYMLINKAT   /* symlink */

/* Splice */
IORING_OP_SPLICE      /* splice between fds */
IORING_OP_TEE         /* tee */

/* Timing */
IORING_OP_TIMEOUT     /* wait for a duration, then post CQE */
IORING_OP_TIMEOUT_REMOVE  /* cancel a timeout */
IORING_OP_LINK_TIMEOUT    /* timeout linked to another SQE */

/* Polling */
IORING_OP_POLL_ADD    /* add fd to poll */
IORING_OP_POLL_REMOVE /* remove poll */

/* Miscellaneous */
IORING_OP_CANCEL      /* cancel pending operation */
IORING_OP_ASYNC_CANCEL
IORING_OP_MSG_RING    /* send CQE to another ring */
IORING_OP_URING_CMD   /* driver-specific commands */
IORING_OP_WAITID      /* async waitid() */
IORING_OP_SOCKET      /* create a socket */
IORING_OP_EPOLL_CTL   /* async epoll_ctl */
IORING_OP_PROVIDE_BUFFERS /* register buffer pool */
IORING_OP_REMOVE_BUFFERS
```

## liburing: the convenience wrapper

Most applications use `liburing` instead of raw syscalls:

```c
#include <liburing.h>

/* Initialize a ring with 256 entries */
struct io_uring ring;
io_uring_queue_init(256, &ring, 0);

/* Or with flags */
io_uring_queue_init_params(256, &ring, &(struct io_uring_params){
    .flags = IORING_SETUP_SQPOLL | IORING_SETUP_SQ_AFF,
    .sq_thread_cpu = 2,
    .sq_thread_idle = 2000,  /* idle 2s before sleeping */
});
```

### Batch example: submit multiple reads

```c
struct io_uring_sqe *sqe;
struct io_uring_cqe *cqe;

/* Submit 8 reads at once */
for (int i = 0; i < 8; i++) {
    sqe = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe, fds[i], bufs[i], BUF_SIZE, 0);
    io_uring_sqe_set_data64(sqe, (uint64_t)i);  /* tag */
}

/* One syscall to submit all 8 */
io_uring_submit(&ring);

/* Collect completions */
for (int i = 0; i < 8; i++) {
    io_uring_wait_cqe(&ring, &cqe);
    int idx = (int)io_uring_cqe_get_data64(cqe);
    if (cqe->res < 0)
        fprintf(stderr, "read[%d] error: %s\n", idx, strerror(-cqe->res));
    io_uring_cqe_seen(&ring, cqe);
}
```

## SQPOLL: eliminating syscalls entirely

With `IORING_SETUP_SQPOLL`, a dedicated kernel thread polls the SQ ring continuously. Userspace never needs to call `io_uring_enter` — it just writes SQEs and they're picked up automatically:

```c
io_uring_queue_init_params(256, &ring, &(struct io_uring_params){
    .flags = IORING_SETUP_SQPOLL,
    .sq_thread_idle = 2000,  /* kernel thread sleeps after 2s of idle */
});

/* Submit without syscall: */
sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(sqe, fd, buf, len, 0);
io_uring_sqe_set_flags(sqe, 0);

/* Just update the SQ tail — no io_uring_enter() needed */
io_uring_submit(&ring);  /* liburing: detects SQPOLL, writes directly */

/* Check if kernel thread needs wakeup */
if (io_sq_ring_needs_enter(ring_ptr))
    io_uring_enter(ring_fd, 0, 0, IORING_ENTER_SQ_WAKEUP, NULL, 0);
```

The kernel SQPOLL thread is pinned to a CPU (`sq_thread_cpu`) and runs at normal scheduling priority (`SCHED_NORMAL`). For ultra-low latency I/O, it avoids the ~1µs overhead of a syscall.

```bash
# See the SQPOLL thread
ps aux | grep io_uring-sq
# root 1234  99.9  0.0  0  0 [io_uring-sq]
```

## Fixed files (registered file descriptors)

Registering file descriptors eliminates per-operation fd lookups:

```c
/* Register up to 4096 fds with the ring */
int fds[4096] = { fd0, fd1, fd2, -1, -1, ... };
io_uring_register_files(&ring, fds, 4096);

/* Use fixed file index instead of fd */
sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(sqe, 0, buf, len, 0);  /* 0 = fixed file index 0 */
io_uring_sqe_set_flags(sqe, IOSQE_FIXED_FILE);

/* Update a slot without re-registering all */
io_uring_register_files_update(&ring, slot_index, &new_fd, 1);

/* Unregister */
io_uring_unregister_files(&ring);
```

Fixed files avoid taking a reference to the `struct file` on every operation — significant for high-IOPS workloads.

## Fixed buffers (registered buffers)

Pre-registered buffers avoid per-I/O pinning of pages:

```c
/* Register 8 buffers */
struct iovec iovecs[8];
for (int i = 0; i < 8; i++) {
    iovecs[i].iov_base = bufs[i];
    iovecs[i].iov_len  = BUF_SIZE;
}
io_uring_register_buffers(&ring, iovecs, 8);

/* Use IORING_OP_READ_FIXED with buffer index */
sqe = io_uring_get_sqe(&ring);
io_uring_prep_read_fixed(sqe, fd, bufs[0], BUF_SIZE, offset, 0);
/*                                                              ^ buf_index */

io_uring_unregister_buffers(&ring);
```

Fixed buffers are pinned in memory once at registration. Per-I/O page pinning/unpinning (which requires page table walks) is eliminated.

## Linked requests

Chain SQEs so that the next one only starts when the previous completes successfully:

```c
/* Sequence: connect → send → recv */
sqe = io_uring_get_sqe(&ring);
io_uring_prep_connect(sqe, fd, addr, addrlen);
io_uring_sqe_set_flags(sqe, IOSQE_IO_LINK);  /* link to next */

sqe = io_uring_get_sqe(&ring);
io_uring_prep_send(sqe, fd, request, req_len, 0);
io_uring_sqe_set_flags(sqe, IOSQE_IO_LINK);  /* link to next */

sqe = io_uring_get_sqe(&ring);
io_uring_prep_recv(sqe, fd, response, resp_len, 0);
/* no IOSQE_IO_LINK: end of chain */

io_uring_submit(&ring);
/* If connect fails → send/recv get CQE with -ECANCELED */
```

For hard chains that ignore errors, use `IOSQE_IO_HARDLINK` instead.

## Buffer selection: provided buffers

Instead of pre-assigning buffers to SQEs, let the kernel pick from a pool (useful when you don't know how many bytes will arrive):

```c
/* Register a buffer group */
struct io_uring_buf_reg reg = {
    .ring_addr    = (uint64_t)buf_ring,  /* shared ring of buffers */
    .ring_entries = NUM_BUFS,
    .bgid         = 0,                   /* buffer group ID */
};
io_uring_register_buf_ring(&ring, &reg, 0);

/* Add buffers to the group */
for (int i = 0; i < NUM_BUFS; i++) {
    io_uring_buf_ring_add(buf_ring, bufs[i], BUF_SIZE, i, ring_mask, i);
}
io_uring_buf_ring_advance(buf_ring, NUM_BUFS);

/* Use buffer selection on recv */
sqe = io_uring_get_sqe(&ring);
io_uring_prep_recv(sqe, fd, NULL, 0, 0);  /* NULL = kernel picks buffer */
sqe->buf_group = 0;
io_uring_sqe_set_flags(sqe, IOSQE_BUFFER_SELECT);

/* CQE tells you which buffer was used */
io_uring_wait_cqe(&ring, &cqe);
int buf_id = cqe->flags >> IORING_CQE_BUFFER_SHIFT;
int bytes = cqe->res;
void *data = bufs[buf_id];
/* process data[0..bytes-1] */
/* Return buffer to pool: */
io_uring_buf_ring_add(buf_ring, bufs[buf_id], BUF_SIZE, buf_id, ring_mask, 0);
io_uring_buf_ring_advance(buf_ring, 1);
```

## Multishot operations

Some operations can post multiple CQEs from a single SQE:

```c
/* Multishot accept: use IORING_OP_ACCEPT with IORING_ACCEPT_MULTISHOT flag */
sqe = io_uring_get_sqe(&ring);
io_uring_prep_multishot_accept(sqe, listen_fd, NULL, NULL, 0);
/* liburing sets IORING_ACCEPT_MULTISHOT flag on IORING_OP_ACCEPT */

/* Each new connection posts a CQE with the new fd in cqe->res */
/* IORING_CQE_F_MORE set while multishot is still active */
while (1) {
    io_uring_wait_cqe(&ring, &cqe);
    if (cqe->res >= 0) {
        int client_fd = cqe->res;
        handle_client(client_fd);
    }
    bool more = cqe->flags & IORING_CQE_F_MORE;
    io_uring_cqe_seen(&ring, cqe);
    if (!more) break;  /* multishot ended (e.g., listen_fd closed) */
}

/* Also available (flags on their base opcodes, not separate opcodes): */
/* IORING_OP_RECV + IORING_RECV_MULTISHOT flag — recv on socket continuously */
/* IORING_OP_POLL_ADD + IORING_POLL_ADD_MULTI flag — poll fd repeatedly */
```

## io_uring and BPF

BPF programs can be attached to io_uring operations:

```c
/* BPF program type: BPF_PROG_TYPE_SYSCALL can intercept io_uring_enter */
/* More commonly: io_uring + BPF via socket_filter for network paths */

/* io_uring credentials: run this SQE with a different uid/caps */
sqe->personality = io_uring_register_personality(&ring);
/* The SQE executes with the registered identity */
```

## Observing io_uring

```bash
# List io_uring instances
ls /proc/*/fdinfo/ | xargs grep -l "sq entries" 2>/dev/null

# io_uring stats for a process
cat /proc/<pid>/fdinfo/<ring_fd>
# pos:     0
# flags:   0100002
# sq entries:     256
# cq entries:     512
# sq head:         42
# sq tail:         43
# sq mask:        255
# sq array off:    128
# cq head:         40
# cq tail:         42
# ...

# System-wide io_uring stats
cat /proc/sys/fs/io_uring_groups
cat /sys/kernel/debug/io_uring_stats 2>/dev/null

# Trace io_uring events
trace-cmd record -e io_uring:* sleep 1
trace-cmd report

# BPF tracing
bpftrace -e 'tracepoint:io_uring:io_uring_submit_sqe { printf("%s\n", comm); }'
```

## Performance comparison

| Interface | Setup | Per-op syscall | Max IOPS (NVMe) |
|-----------|-------|----------------|-----------------|
| `read()`/`write()` | None | Yes (1 per op) | ~300K |
| `libaio` + O_DIRECT | AIO context | `io_submit` (batched) | ~700K |
| io_uring (no SQPOLL) | Ring init | `io_uring_enter` (batched) | ~1.5M |
| io_uring + SQPOLL | Ring + thread | None | ~2M+ |

## Further reading

- [Architecture and Rings](io-uring-arch.md) — Ring layout and SQE/CQE structures
- [BPF/eBPF](../bpf/README.md) — io_uring + BPF integration
- [Block Layer: blk-mq](../block/blk-mq.md) — Where io_uring ops eventually land
- `io_uring/` directory in the kernel tree
- `liburing` GitHub repository — high-level C API
