# io_uring Architecture and Rings

> Shared memory rings, SQEs, and CQEs

## The problem io_uring solves

Traditional I/O interfaces:
- `read()`/`write()`: one syscall per operation, blocking
- `aio_read()` (POSIX AIO): thread-pool based, complex API, poor performance
- `epoll` + non-blocking: two syscalls per operation (one to check, one to act), no batching
- Linux `libaio`: low-level, incomplete operation coverage

io_uring's solution: **two lock-free rings in shared memory**. Userspace writes to the Submission Queue; the kernel posts results to the Completion Queue. No per-operation syscall needed (especially with SQPOLL).

## io_uring_setup

```c
#include <linux/io_uring.h>

struct io_uring_params params = {
    .flags = IORING_SETUP_SQPOLL,  /* optional: kernel polling thread */
    /* .sq_thread_cpu, .sq_thread_idle, etc. */
};

int ring_fd = io_uring_setup(32,  /* sq_entries: power of 2 */
                              &params);

/* params is filled in by the kernel: */
/* params.sq_off: offsets within sq ring mmap */
/* params.cq_off: offsets within cq ring mmap */
/* params.features: IORING_FEAT_SINGLE_MMAP, IORING_FEAT_NODROP, etc. */
```

After `io_uring_setup`, userspace maps two (or one, if `IORING_FEAT_SINGLE_MMAP`) memory regions:

```c
/* Map the SQ and CQ rings */
void *sq_ring = mmap(NULL, params.sq_off.array + params.sq_entries * sizeof(u32),
                     PROT_READ|PROT_WRITE, MAP_SHARED|MAP_POPULATE,
                     ring_fd, IORING_OFF_SQ_RING);

void *cq_ring = mmap(NULL, params.cq_off.cqes +
                           params.cq_entries * sizeof(struct io_uring_cqe),
                     PROT_READ|PROT_WRITE, MAP_SHARED|MAP_POPULATE,
                     ring_fd, IORING_OFF_CQ_RING);

/* Map the SQE array separately */
struct io_uring_sqe *sqes = mmap(NULL,
    params.sq_entries * sizeof(struct io_uring_sqe),
    PROT_READ|PROT_WRITE, MAP_SHARED|MAP_POPULATE,
    ring_fd, IORING_OFF_SQES);
```

## Ring layout

```
SQ ring (at IORING_OFF_SQ_RING):
  ┌─────────────────────────────────────────┐
  │ head     (u32) ← kernel reads from here │
  │ tail     (u32) ← userspace writes here  │
  │ mask     (u32) = sq_entries - 1         │
  │ entries  (u32) = sq_entries             │
  │ flags    (u32) = IORING_SQ_NEED_WAKEUP  │
  │ dropped  (u32) = dropped SQEs           │
  │ array[]  (u32) = indices into SQE array │
  └─────────────────────────────────────────┘

SQE array (at IORING_OFF_SQES):
  ┌──────────────────────────────────────────┐
  │ sqe[0] │ sqe[1] │ ... │ sqe[sq_entries-1] │
  └──────────────────────────────────────────┘

CQ ring (at IORING_OFF_CQ_RING):
  ┌─────────────────────────────────────────┐
  │ head     (u32) ← userspace reads here   │
  │ tail     (u32) ← kernel writes here     │
  │ mask     (u32) = cq_entries - 1         │
  │ entries  (u32) = cq_entries             │
  │ overflow (u32) = CQEs dropped (if full) │
  │ cqes[]   = CQE ring array               │
  └─────────────────────────────────────────┘
```

## struct io_uring_sqe

The Submission Queue Entry describes one I/O operation:

```c
/* include/uapi/linux/io_uring.h */
struct io_uring_sqe {
    __u8    opcode;         /* IORING_OP_READ, IORING_OP_WRITE, ... */
    __u8    flags;          /* IOSQE_FIXED_FILE, IOSQE_IO_LINK, ... */
    __u16   ioprio;         /* I/O priority (ionice class/level) */
    __s32   fd;             /* file descriptor (or fixed file index) */
    union {
        __u64   off;        /* offset for read/write */
        __u64   addr2;      /* used by some ops */
        struct {
            __u32 cmd_op;
            __u32 __pad1;
        };
    };
    union {
        __u64   addr;       /* pointer to buffer (or fixed buffer index) */
        __u64   splice_off_in;
    };
    __u32   len;            /* buffer length, or sqe count for LINK */
    union {
        __kernel_rwf_t  rw_flags;   /* read/write flags */
        __u32           fsync_flags;
        __u16           poll_events;
        __u32           poll32_events;
        __u32           sync_range_flags;
        __u32           msg_flags;
        __u32           timeout_flags;
        __u32           accept_flags;
        __u32           cancel_flags;
        __u32           open_flags;
        __u32           statx_flags;
        __u32           fadvise_advice;
        __u32           splice_flags;
        __u32           rename_flags;
        __u32           unlink_flags;
        __u32           hardlink_flags;
        __u32           xattr_flags;
        __u32           msg_ring_flags;
        __u32           uring_cmd_flags;
    };
    __u64   user_data;      /* tag copied to CQE — for matching completions */
    union {
        __u16   buf_index;  /* fixed buffer index (for IORING_OP_*) */
        __u16   buf_group;  /* buffer group for buffer selection */
    };
    __u16   personality;    /* credential to use for this op */
    union {
        __s32   splice_fd_in;
        __u32   file_index;   /* for fixed files */
        __u32   optlen;
        struct {
            __u16 addr_len;
            __u16 __pad3[1];
        };
    };
    union {
        struct {
            __u64 addr3;
            __u64 __pad2[1];
        };
        __u8 cmd[0];  /* IORING_OP_URING_CMD payload */
    };
};
```

## struct io_uring_cqe

The Completion Queue Entry carries the result:

```c
struct io_uring_cqe {
    __u64   user_data;  /* copied from SQE (for matching) */
    __s32   res;        /* result code: bytes transferred, or -errno */
    __u32   flags;      /* IORING_CQE_F_MORE, IORING_CQE_F_SOCK_NONEMPTY */
    __u64   big_cqe[];  /* if IORING_SETUP_CQE32: extra 16 bytes */
};
```

`res` semantics mirror the corresponding blocking syscall:
- `IORING_OP_READ`: bytes read, or -errno
- `IORING_OP_WRITE`: bytes written, or -errno
- `IORING_OP_ACCEPT`: new fd, or -errno
- `IORING_OP_CONNECT`: 0 on success, or -errno

## Submission flow

```
1. Get an SQE slot:
   tail = sq_ring->tail & sq_ring->mask
   sqe = &sqes[tail]

2. Fill the SQE:
   sqe->opcode = IORING_OP_READ
   sqe->fd = fd
   sqe->addr = (uintptr_t)buf
   sqe->len = len
   sqe->off = offset
   sqe->user_data = my_tag

3. Advance tail (publish to kernel):
   sq_ring->array[tail] = tail  /* indirect index */
   smp_store_release(&sq_ring->tail, tail + 1)

4. Optionally: io_uring_enter(ring_fd, to_submit, min_complete, flags)
   /* with SQPOLL: skip this — kernel polls automatically */
```

## Completion harvesting

```
1. Check if new CQEs available:
   if (cq_ring->head == READ_ONCE(cq_ring->tail)) { /* no completions */ }

2. Process CQE:
   head = cq_ring->head & cq_ring->mask
   cqe = &cq_ring->cqes[head]
   result = cqe->res
   tag = cqe->user_data

3. Advance head (consume):
   smp_store_release(&cq_ring->head, cq_ring->head + 1)
```

## io_uring_enter: the syscall

```c
int io_uring_enter(unsigned int fd,    /* ring fd */
                   unsigned int to_submit,  /* SQEs to submit */
                   unsigned int min_complete, /* wait for N CQEs */
                   unsigned int flags,   /* IORING_ENTER_GETEVENTS, ... */
                   sigset_t *sig,        /* optional signal mask during wait */
                   size_t sigsz);
```

With batching, a single `io_uring_enter` can submit many operations and wait for many completions. This amortizes the syscall overhead across all concurrent I/O.

## Kernel side: struct io_ring_ctx

```c
/* io_uring/io_uring.h */
struct io_ring_ctx {
    struct {
        unsigned        flags;
        unsigned        compat;
        unsigned        drain_next;
        unsigned        eventfd_async;
        /* ... */
    } ____cacheline_aligned_in_smp;

    struct io_rings     *rings;          /* the shared SQ/CQ rings */
    struct io_uring_sqe *sq_sqes;        /* SQE array */

    /* completion state */
    spinlock_t          completion_lock;
    struct list_head    locked_free_list;
    unsigned int        locked_free_nr;

    /* submission state */
    struct io_sq_data   *sq_data;        /* SQPOLL thread */

    /* workers for blocking ops */
    struct io_wq        *io_wq;

    /* ... many more fields ... */
};
```

## Further reading

- [Operations and Advanced Features](io-uring-ops.md) — Supported ops, SQPOLL, fixed buffers
- [BPF](../bpf/README.md) — io_uring + BPF programs
- `io_uring/` in the kernel tree — full implementation (~25,000 lines)
- `liburing` — userspace library with convenience API
