# I/O Polling: HIPRI, IOPOLL, and NOWAIT

> Eliminating interrupt and thread-switch overhead for NVMe I/O — how IOCB_HIPRI, io_uring IOPOLL, and IOCB_NOWAIT work inside the kernel

---

## Why polling?

Traditional block I/O uses interrupts. When a write or read completes, the NVMe controller asserts an MSI-X interrupt. The CPU stops what it is doing, saves state, runs the interrupt handler, posts the completion, and returns. For a spinning disk with multi-millisecond latency, this overhead is negligible. For a modern NVMe SSD with sub-100µs latency, the interrupt path starts to matter.

Break down what happens on the interrupt path for a 50µs NVMe read:

```
Application thread submits I/O
  → syscall entry overhead                     ~200 ns
  → VFS, filesystem, block layer               ~1–2 µs
  → NVMe submission queue ring doorbell write  ~100 ns
  [NVMe controller processes request]          ~45–50 µs
  → MSI-X interrupt fires on some CPU
  → interrupt handler: nvme_irq()              ~1–2 µs
  → softirq: blk_done_softirq()               ~1–2 µs
  → bio end_io → kiocb completion             ~500 ns
  → wakeup sleeping thread                    ~2–5 µs
  → context switch back to application        ~2–5 µs
Total overhead (interrupt + wakeup path):     ~7–15 µs on top of device latency
```

On a device with 50µs latency, that overhead is 15–30% of total observed latency. For p99 tail latency the problem is worse: interrupt coalescing, CPU c-states, and scheduler jitter all inflate the wake-up path.

Polling eliminates the interrupt entirely:

```
Application thread submits I/O
  → syscall entry overhead                     ~200 ns
  → VFS, filesystem, block layer               ~1–2 µs
  → NVMe submission queue ring doorbell write  ~100 ns
  [NVMe controller processes request]          ~45–50 µs
  → kernel spins reading NVMe CQ              ~100–500 ns per check
  → CQ entry appears: completion inline        ~500 ns
Total overhead:                               ~2–4 µs on top of device latency
```

The tradeoff is CPU: the polling core cannot go idle while waiting. One core is 100% busy for the duration of every I/O. This is a reasonable trade for:

- **Latency-sensitive workloads**: database transaction commits, key-value stores, real-time analytics
- **High-IOPS workloads**: where the polling core is always finding completions immediately and is therefore doing useful work
- **Tail-latency SLOs**: eliminating the interrupt jitter that inflates p99 and p999

It is a poor trade for:

- **Low-IOPS workloads**: the core spins doing nothing most of the time
- **Shared systems**: the polling core is stolen from other tenants
- **Rotating media or slow SSDs**: latency is high enough that sleeping is always better

### Interrupt path vs polling path

```
Interrupt path:
┌─────────────┐    doorbell     ┌──────────┐    MSI-X      ┌──────────────┐
│  submitter  │ ─────────────▶ │   NVMe   │ ────────────▶ │  interrupt   │
│   (asleep)  │                │ controller│               │   handler    │
└─────────────┘                └──────────┘               └──────┬───────┘
       ▲                                                          │ wakeup
       └──────────────────────────────────────────────────────────┘
       (context switch back)

Polling path:
┌─────────────┐    doorbell     ┌──────────┐
│  submitter  │ ─────────────▶ │   NVMe   │
│  (spinning) │ ◀── CQ check ─ │ controller│
│             │ ◀── CQ check ─ │          │
│             │ ◀── CQ found ─ │          │  ← completion visible in CQ
└─────────────┘                └──────────┘
(no interrupt, no context switch)
```

---

## HIPRI: the kernel polling interface

The user-visible entry point for polling is the `RWF_HIPRI` flag on `preadv2()`/`pwritev2()`, or `IORING_SETUP_IOPOLL` on an io_uring ring. Both ultimately set `IOCB_HIPRI` in the kiocb's `ki_flags`.

### Userspace API

```c
/* preadv2/pwritev2 with RWF_HIPRI: per-call polling request */
#include <sys/uio.h>

struct iovec iov = { .iov_base = buf, .iov_len = 4096 };
/* RWF_HIPRI = 0x1: request high-priority polling for this call */
ssize_t n = preadv2(fd, &iov, 1, offset, RWF_HIPRI);

/* io_uring: ring-wide IOPOLL mode */
struct io_uring_params params = {};
params.flags |= IORING_SETUP_IOPOLL;
int ring_fd = io_uring_setup(128, &params);
```

Both require `O_DIRECT`. HIPRI on a buffered file is rejected: the block layer has no way to poll for a page cache fill.

### How RWF_HIPRI becomes IOCB_HIPRI

The `RWF_*` flags passed to `preadv2()` and `pwritev2()` are copied directly into `IOCB_*` flags. The values are deliberately equal:

```c
/* include/uapi/linux/fs.h */
#define RWF_HIPRI   ((__force __poll_t)0x00000001)
#define RWF_NOWAIT  ((__force __poll_t)0x00000008)

/* include/linux/fs.h */
#define IOCB_HIPRI  (__force int) RWF_HIPRI    /* = 0x1 */
#define IOCB_NOWAIT (__force int) RWF_NOWAIT   /* = 0x8 */
```

At VFS entry:

```c
/* fs/read_write.c */
static ssize_t do_iter_readv_writev(struct file *filp, struct iov_iter *iter,
                                     loff_t *ppos, int type, rwf_t flags)
{
    struct kiocb kiocb;
    init_sync_kiocb(&kiocb, filp);

    /* Copy RWF_* flags to IOCB_* — values are identical */
    ret = kiocb_set_rw_flags(&kiocb, flags);
    if (ret)
        return ret;
    /* kiocb.ki_flags now has IOCB_HIPRI set if RWF_HIPRI was passed */
    ...
}
```

### HIPRI flows through to the bio

Once `IOCB_HIPRI` is set on the kiocb, it propagates to the bio and then to the block-layer request:

```c
/* fs/iomap/direct-io.c — iomap DIO path */
static void iomap_dio_submit_bio(const struct iomap_iter *iter,
                                  struct iomap_dio *dio, struct bio *bio)
{
    /* Propagate HIPRI from the kiocb to the bio */
    if (dio->iocb->ki_flags & IOCB_HIPRI)
        bio->bi_opf |= REQ_HIPRI | REQ_NOWAIT;

    submit_bio(bio);
}
```

In the block layer, `REQ_HIPRI` requests are allocated from a reserved tag set:

```c
/* block/blk-mq.c */
struct request *blk_mq_alloc_request_hctx(struct request_queue *q,
                                            unsigned int opf,
                                            blk_mq_req_flags_t flags,
                                            unsigned int hctx_idx)
{
    /*
     * HIPRI requests go to a dedicated hardware queue that is not
     * used by the interrupt-driven completion path. This allows
     * polling that queue without racing with the interrupt handler.
     */
    if (op_is_hipri(opf))
        flags |= BLK_MQ_REQ_RESERVED;
    ...
}
```

The dedicated queue is important: if HIPRI and non-HIPRI requests shared a hardware queue, the poll function would find completions for non-HIPRI requests and either miss them or process them in the wrong context.

---

## The iopoll hook: filesystem-level polling

`file_operations` has an `iopoll` method that io_uring calls to check for completions without going to sleep:

```c
/* include/linux/fs.h */
struct file_operations {
    ...
    int (*iopoll)(struct kiocb *kiocb, struct io_comp_batch *iob,
                  unsigned int flags);
    ...
};
```

### iocb_bio_iopoll: the common implementation

Both ext4 and XFS delegate to the iomap layer, which stores the bio pointer in `kiocb->private` at submission time:

```c
/* fs/iomap/direct-io.c */
/* Called at submission: stash the bio so iopoll can find it */
iocb->private = bio;

/* fs/iomap/direct-io.c */
int iocb_bio_iopoll(struct kiocb *kiocb, struct io_comp_batch *iob,
                     unsigned int flags)
{
    struct bio *bio = READ_ONCE(kiocb->private);

    if (!bio)
        return 0;   /* already completed */

    return bio_poll(bio, iob, flags);
}
EXPORT_SYMBOL_GPL(iocb_bio_iopoll);
```

The bio_poll function walks down to the block layer:

```c
/* block/bio.c */
int bio_poll(struct bio *bio, struct io_comp_batch *iob, unsigned int flags)
{
    struct request_queue *q = bdev_get_queue(bio->bi_bdev);
    blk_qc_t cookie = READ_ONCE(bio->bi_cookie);

    if (cookie == BLK_QC_T_NONE ||
        !test_bit(QUEUE_FLAG_POLL, &q->queue_flags))
        return 0;

    if (current->plug)
        blk_flush_plug(current->plug, false);

    return q->mq_ops->poll(q->queue_hw_ctx[blk_qc_t_to_queue_num(cookie)], iob);
}
```

The `cookie` here is the hardware queue index encoded in the `blk_qc_t` that was returned from `submit_bio()`. It tells the poll function exactly which NVMe completion queue to check.

---

## NVMe polling: reading the completion queue directly

NVMe controllers use a pair of rings per queue: a submission queue (SQ) that the driver writes commands into, and a completion queue (CQ) that the controller writes completions into. The driver detects new CQ entries by checking the **phase bit** — a single bit that the controller toggles on each pass through the ring.

```c
/* drivers/nvme/host/pci.c */
static inline bool nvme_cqe_pending(struct nvme_queue *nvmeq)
{
    struct nvme_completion *hd = cq_head(nvmeq);
    return (le16_to_cpu(hd->status) & 1) == nvmeq->cq_phase;
}

static int nvme_poll(struct blk_mq_hw_ctx *hctx, struct io_comp_batch *iob)
{
    struct nvme_queue *nvmeq = hctx->driver_data;
    bool found = false;

    if (!nvme_cqe_pending(nvmeq))
        return 0;

    /*
     * Poll lock: multiple poll callers (e.g. multiple threads sharing
     * an io_uring ring) must serialize CQ processing to avoid double-
     * completing the same entry.
     */
    spin_lock(&nvmeq->cq_poll_lock);
    found = nvme_process_cq(nvmeq, iob);
    spin_unlock(&nvmeq->cq_poll_lock);

    return found;
}
```

`nvme_process_cq` walks pending CQ entries, calls `blk_mq_complete_request()` for each, and updates the head pointer. The phase bit check is a single memory read — no MMIO, no PCI transaction. This is why polling is so fast: detecting completion is a load from a DMA-mapped memory region that the controller writes to.

### Phase bit mechanics

```
CQ ring (4 entries):
                         ┌───────────┬───────────┬───────────┬───────────┐
  entries:               │  phase=1  │  phase=1  │  phase=0  │  phase=0  │
                         └───────────┴───────────┴───────────┴───────────┘
                                                 ▲
                                              cq_head (next to check)

  nvme_cqe_pending() checks: entry[cq_head].phase == nvmeq->cq_phase
  When controller posts completion: it writes status with toggled phase bit
  Driver detects it: phase bit at cq_head matches expected phase → new entry
```

On the interrupt path, the driver does the same `nvme_process_cq()` work — but triggered by the interrupt handler rather than the poll loop. The code path from `nvme_process_cq()` onward is shared.

---

## io_uring IOPOLL mode

io_uring's `IORING_SETUP_IOPOLL` is the highest-performance polling interface. It combines:

1. Asynchronous submission (no per-I/O syscall overhead)
2. Kernel-side completion polling (no interrupt, no wakeup)
3. Optional submission-side polling (`IORING_SETUP_SQPOLL`, described below)

### Setup

```c
#include <liburing.h>

struct io_uring ring;
struct io_uring_params params = {};

params.flags = IORING_SETUP_IOPOLL;
/* Optional: also poll the submission queue */
/* params.flags |= IORING_SETUP_SQPOLL; */

io_uring_queue_init_params(128, &ring, &params);

/* O_DIRECT is required for IOPOLL */
int fd = open("/dev/nvme0n1", O_RDWR | O_DIRECT);

/* Register fixed buffers (strongly recommended with IOPOLL) */
struct iovec iov[1] = {{ .iov_base = buf, .iov_len = BUF_SIZE }};
io_uring_register_buffers(&ring, iov, 1);
```

### Submission and completion

```c
/* Submit a read using a registered (fixed) buffer */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_read_fixed(sqe, fd, buf, BUF_SIZE, offset, 0 /* buf_index */);
io_uring_submit(&ring);

/* Wait for completion: kernel busy-waits in io_do_iopoll() */
struct io_uring_cqe *cqe;
io_uring_wait_cqe(&ring, &cqe);   /* calls io_uring_enter(IORING_ENTER_GETEVENTS) */
int result = cqe->res;
io_uring_cqe_seen(&ring, cqe);
```

### Inside io_do_iopoll()

When `io_uring_enter()` is called with `IORING_ENTER_GETEVENTS` on a IOPOLL ring, the kernel enters the poll loop:

```c
/* io_uring/io_uring.c */
static int io_do_iopoll(struct io_ring_ctx *ctx, bool force_nonspin)
{
    struct io_kiocb *req;
    struct io_comp_batch iob = {};
    int nr_events = 0;

    /*
     * Walk the list of in-flight IOPOLL requests.
     * Each request has a kiocb with an iopoll method on its file.
     */
    list_for_each_entry(req, &ctx->iopoll_list, inflight_entry) {
        const struct file_operations *fops = req->file->f_op;

        if (!fops->iopoll)
            break;  /* not a pollable file — should not be in this list */

        ret = fops->iopoll(&req->rw.kiocb, &iob, 0);
        if (unlikely(ret < 0))
            return ret;

        if (ret)
            nr_events++;
    }

    /*
     * Drain completed requests from iob: post CQEs, remove from
     * iopoll_list, release resources.
     */
    if (!wq_list_empty(&iob.req_list))
        io_iopoll_complete(ctx, &iob);

    return nr_events;
}
```

The loop iterates `ctx->iopoll_list`, calling each file's `iopoll` method, until all requested completions have arrived. The caller in `io_uring_enter()` repeats this until `min_complete` CQEs are available:

```c
/* io_uring/io_uring.c */
static int io_iopoll_check(struct io_ring_ctx *ctx, long min)
{
    int iters, ret = 0;

    do {
        ret = io_do_iopoll(ctx, !iters);
        if (ret < 0)
            break;
        if (!iters && !io_cqring_events(ctx))
            break;
    } while (io_cqring_events(ctx) < min);

    return ret;
}
```

### Request lifecycle in IOPOLL mode

```
io_uring_submit()
  → io_submit_sqes()
    → io_issue_sqe()        ← submit the I/O with IOCB_HIPRI set
      → vfs_iocb_iter_read() / vfs_iocb_iter_write()
        → file->f_op->read_iter / write_iter
          → iomap_dio_rw()  ← submits bio with REQ_HIPRI | REQ_NOWAIT
            → iocb->private = bio  ← stash bio for iopoll
      → req added to ctx->iopoll_list  ← tracked for polling

io_uring_enter(IORING_ENTER_GETEVENTS)
  → io_iopoll_check()
    → io_do_iopoll()
      → file->f_op->iopoll()  ← per-request: reads NVMe CQ
        → bio_poll()
          → nvme_poll()       ← reads phase bit, processes CQ entry
      → io_iopoll_complete()  ← post CQE, remove from iopoll_list
```

---

## SQPOLL: kernel-side submission polling

`IORING_SETUP_SQPOLL` is a companion feature to IOPOLL that eliminates the submission-side syscall. With SQPOLL, a dedicated kernel thread polls the SQ ring:

```c
/* SQPOLL + IOPOLL: zero syscalls per I/O */
params.flags = IORING_SETUP_IOPOLL | IORING_SETUP_SQPOLL;
params.sq_thread_idle = 2000;  /* ms before SQPOLL thread sleeps */
io_uring_queue_init_params(128, &ring, &params);
```

The SQPOLL thread (`io_sq_thread()`) runs as a real-time kernel thread bound to a CPU:

```c
/* io_uring/sqpoll.c */
static int io_sq_thread(void *data)
{
    struct io_sq_data *sqd = data;
    struct io_ring_ctx *ctx;

    while (!kthread_should_stop()) {
        bool cap_entries = !list_is_singular(&sqd->ctx_list);

        /*
         * Check all rings associated with this SQPOLL thread for
         * new SQEs. Submit any found.
         */
        list_for_each_entry(ctx, &sqd->ctx_list, sqd_list)
            io_submit_sqes(ctx, cap_entries ? 4 : UINT_MAX);

        if (list_empty(&sqd->ctx_list) ||
            (!io_sqring_entries(ctx) && time_after(jiffies, timeout))) {
            /* No work: sleep until userspace writes to the SQ ring */
            set_current_state(TASK_INTERRUPTIBLE);
            schedule_timeout(usecs_to_jiffies(sqd->sq_thread_idle * 1000));
        }
    }
    return 0;
}
```

With both SQPOLL and IOPOLL enabled, the userspace application:

1. Writes SQEs into the shared SQ ring (no syscall)
2. The SQPOLL kernel thread picks them up and submits them
3. Calls `io_uring_enter(IORING_ENTER_GETEVENTS)` to collect completions (one syscall for a batch of results)
4. Or reads CQEs directly from the CQ ring if `IORING_FEAT_NODROP` is set

### Requirements for SQPOLL + IOPOLL

| Requirement | Reason |
|-------------|--------|
| `O_DIRECT` | Buffered I/O has no poll hook |
| NVMe (or similar) device | Polling requires a `mq_ops->poll` implementation |
| Fixed buffers (`io_uring_register_buffers`) | Avoids per-I/O `get_user_pages` overhead |
| Fixed files (`io_uring_register_files`) | Avoids per-I/O `fdget` overhead |
| `CAP_SYS_NICE` or privileged process | SQPOLL thread needs elevated priority |

---

## IOCB_NOWAIT: fail fast instead of block

`IOCB_NOWAIT` is conceptually different from `IOCB_HIPRI`. Rather than polling for completion, NOWAIT says: "if this I/O would have to wait for any reason, return `-EAGAIN` immediately instead."

```c
/* RWF_NOWAIT: per-call non-blocking I/O */
ssize_t n = preadv2(fd, &iov, 1, offset, RWF_NOWAIT);
if (n == -EAGAIN) {
    /* I/O would block — fall back or queue for later */
}

/* io_uring sets IOCB_NOWAIT automatically on O_DIRECT files */
/* No special flag needed — it is the default io_uring behavior */
```

### What causes NOWAIT to return EAGAIN?

Any operation that would require the calling context to sleep triggers the NOWAIT fast-path:

```c
/* Inode lock contention */
if (iocb->ki_flags & IOCB_NOWAIT) {
    if (!inode_trylock_shared(inode))
        return -EAGAIN;   /* someone holds i_rwsem exclusively */
}

/* Page not in cache (buffered read) */
if (iocb->ki_flags & IOCB_NOWAIT) {
    folio = filemap_get_folio(mapping, index);
    if (!folio || !folio_test_uptodate(folio))
        return -EAGAIN;   /* would need disk I/O to fill page */
}

/* Folio lock contention (buffered write) */
if (iocb->ki_flags & IOCB_NOWAIT) {
    if (!folio_trylock(folio))
        return -EAGAIN;   /* writer holds the folio lock */
}

/* Block layer: request queue full */
if (iocb->ki_flags & IOCB_NOWAIT) {
    bio->bi_opf |= REQ_NOWAIT;
    /* blk-mq returns BLK_STS_AGAIN if no tags available */
}
```

### NOWAIT in io_uring's fast path

io_uring's performance depends heavily on NOWAIT. io_uring always tries the fast path first with `IOCB_NOWAIT` set:

```c
/* io_uring/rw.c */
static int io_read(struct io_kiocb *req, unsigned int issue_flags)
{
    struct kiocb *kiocb = &req->rw.kiocb;

    /* Always try NOWAIT first */
    kiocb->ki_flags |= IOCB_NOWAIT;

    ret = vfs_iocb_iter_read(req->file, kiocb, &iter);

    if (ret == -EAGAIN) {
        /*
         * Fast path failed. If the caller said it's OK to block
         * (i.e. we're not in a context that forbids sleeping),
         * fall back to the io-wq thread pool.
         */
        if (issue_flags & IO_URING_F_NONBLOCK)
            return -EAGAIN;

        /* Re-issue without NOWAIT: will sleep in io-wq thread */
        kiocb->ki_flags &= ~IOCB_NOWAIT;
        return io_read_prep_async(req);  /* queues to io-wq */
    }
    return ret;
}
```

The io-wq fallback is what gives io_uring the ability to handle any I/O, even when the fast path cannot complete it. But the important metric is the hit rate: for an O_DIRECT workload on an NVMe device where the queue is rarely full, nearly 100% of operations complete on the fast path — no thread pool, no context switch.

---

## NOWAIT support by filesystem and operation

Not all I/O types support NOWAIT equally. The support depends on what locks and resources the operation needs:

### O_DIRECT I/O

```
ext4 O_DIRECT read:     Full NOWAIT support
ext4 O_DIRECT write:    Full NOWAIT support (no journal lock needed)
XFS  O_DIRECT read:     Full NOWAIT support
XFS  O_DIRECT write:    Full NOWAIT support
btrfs O_DIRECT read:    Full NOWAIT support (since ~5.16)
btrfs O_DIRECT write:   Partial (CoW may require allocation)
```

For O_DIRECT, the main failure modes are:

- `i_rwsem` held exclusively (rare, only during truncate/fallocate)
- NVMe queue full (rare at normal utilization)
- Extent map not yet in memory (XFS: extent tree may need a read)

### Buffered I/O

```
Buffered read, page in cache and uptodate:    NOWAIT succeeds
Buffered read, page not in cache:             NOWAIT returns EAGAIN
Buffered read, folio lock contended:          NOWAIT returns EAGAIN
Buffered write, page in cache and writable:   NOWAIT may succeed
Buffered write, page allocation needed:       NOWAIT returns EAGAIN
Buffered write, journal pressure (ext4):      NOWAIT returns EAGAIN
```

Buffered NOWAIT reads are useful for workloads with a hot working set: if the page is in cache (common case), the read completes without any syscall overhead. On a cache miss, NOWAIT hands off to io-wq, which handles the disk read in the background.

### Operation support matrix

| Filesystem | O_DIRECT read | O_DIRECT write | Buffered read | Buffered write |
|------------|--------------|----------------|---------------|----------------|
| ext4       | Full         | Full           | Partial       | Partial        |
| XFS        | Full         | Full           | Partial       | Partial        |
| btrfs      | Full         | Partial        | Partial       | Limited        |
| tmpfs      | N/A          | N/A            | Full          | Full           |
| nfs        | Full         | Full           | Limited       | Limited        |
| block dev  | Full         | Full           | N/A           | N/A            |

"Partial" means: succeeds when resources are uncontested (which is the common case for well-tuned workloads), but falls back to io-wq on contention. "Limited" means: falls back frequently because the filesystem's write path has structural blocking points.

---

## HIPRI vs IOPOLL vs NOWAIT: comparison

These three flags are often mentioned together but solve different problems:

| Feature | HIPRI / IOPOLL | NOWAIT |
|---------|---------------|--------|
| What it does | Polls NVMe CQ instead of sleeping on IRQ | Returns EAGAIN instead of sleeping |
| Mechanism | Busy-wait loop in kernel | Trylock / non-blocking allocation |
| CPU cost | High — one core occupied while waiting | Low — just changes error handling |
| Latency benefit | Eliminates IRQ delivery + wakeup (~5–15µs) | Eliminates thread context switch (~2–5µs) |
| Works with | O_DIRECT only | Buffered I/O and O_DIRECT |
| Fallback behavior | None — caller gets result or waits | io_uring falls back to io-wq thread |
| Best for | Consistent low p99 on NVMe | High concurrency, mixed workloads |
| Requires dedicated hardware queue | Yes | No |
| Requires kernel IOPOLL support in driver | Yes (nvme, io_uring, virtio-blk) | No |
| Combined with io_uring | `IORING_SETUP_IOPOLL` | Default behavior, no flag needed |

### Choosing the right mode

```
High-performance NVMe, dedicated server, latency SLO:
  → IORING_SETUP_IOPOLL (+ SQPOLL for zero-syscall path)

High-concurrency application server, mixed I/O:
  → io_uring default (IOCB_NOWAIT + io-wq fallback)
  → No IOPOLL (too expensive to dedicate a core)

Database with large working set (mostly cached):
  → io_uring buffered NOWAIT: cache hits are free, misses fall back

Mixed read/write, NVMe, p99 matters:
  → IORING_SETUP_IOPOLL for O_DIRECT, NOWAIT for buffered
  → Separate rings: one IOPOLL ring for bulk I/O, one standard ring for metadata
```

---

## Measuring poll effectiveness

### Check that the NVMe driver supports polling

```bash
# Verify the block device has poll queues
cat /sys/block/nvme0n1/queue/io_poll
# 0 = disabled (default), 1 = enabled

# Enable polling for the device
echo 1 > /sys/block/nvme0n1/queue/io_poll

# Check number of hardware queues (one per CPU typically)
cat /sys/block/nvme0n1/mq/*/nr_tags | head
# Each queue's tag depth (e.g. 1024)

# Verify the device has multiple queues
ls /sys/block/nvme0n1/mq/
# 0  1  2  3  ...  (one directory per hw queue)
```

### fio benchmark: interrupt vs poll

```bash
# Baseline: O_DIRECT with interrupts (default)
fio --name=baseline \
    --filename=/dev/nvme0n1 \
    --ioengine=io_uring \
    --iodepth=1 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --runtime=30 \
    --output-format=json \
    --lat_percentiles=1

# Polling mode: IORING_SETUP_IOPOLL
fio --name=polled \
    --filename=/dev/nvme0n1 \
    --ioengine=io_uring \
    --iodepth=1 \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --hipri=1 \           # sets IORING_SETUP_IOPOLL
    --runtime=30 \
    --output-format=json \
    --lat_percentiles=1
# Compare p50, p99, p999 latency between the two runs
```

### bpftrace: count interrupt vs poll completions

```bash
# Count block completions by whether they came from interrupt or poll context
bpftrace -e '
tracepoint:block:block_rq_complete
{
    /* softirq context = interrupt-driven; task context = polling */
    @completions[curtask->comm, in_softirq()] = count();
}
interval:s:5 { print(@completions); clear(@completions); }'

# Trace NOWAIT fallbacks: how often io_uring falls back to io-wq
bpftrace -e '
kprobe:io_wq_enqueue
{
    @io_wq_fallbacks[comm] = count();
}
interval:s:5 { print(@io_wq_fallbacks); clear(@io_wq_fallbacks); }'
```

### perf: NVMe interrupt rate

```bash
# Count NVMe MSI-X interrupts while fio runs
# With polling enabled, this count should drop dramatically
perf stat -e 'irq_vectors:irq_handler_entry' \
    -p $(pgrep fio) \
    -- sleep 10

# Or count via /proc/interrupts
watch -n1 'grep nvme /proc/interrupts'
# With IOPOLL active: the NVMe interrupt counter should stop incrementing
```

### io_uring statistics

```bash
# io_uring exposes per-ring statistics via /proc
cat /proc/$(pgrep myapp)/fdinfo/$(ls -1 /proc/$(pgrep myapp)/fd | head -1)
# Look for: sq_entries, cq_entries, sq_head, sq_tail, cq_head, cq_tail

# Kernel tracepoints for io_uring internals (Linux 5.x+)
bpftrace -e '
tracepoint:io_uring:io_uring_poll_arm   { @poll_armed = count(); }
tracepoint:io_uring:io_uring_complete   { @completed  = count(); }
interval:s:1 { print(@poll_armed); print(@completed);
               clear(@poll_armed); clear(@completed); }'
```

### Verifying NOWAIT hit rate

```bash
# Instrument the NOWAIT fast path and io-wq fallback
bpftrace -e '
/* Fast path completion */
kretprobe:vfs_iocb_iter_read /retval > 0/ {
    @nowait_hits = count();
}
/* io-wq fallback (NOWAIT miss) */
kprobe:io_wq_enqueue {
    @io_wq_submissions = count();
}
interval:s:5 {
    printf("NOWAIT hits: %d, io-wq fallbacks: %d\n",
           @nowait_hits, @io_wq_submissions);
    clear(@nowait_hits); clear(@io_wq_submissions);
}'
# Target: >95% NOWAIT hits for O_DIRECT NVMe workloads
```

---

## Key source files

| File | Contents |
|------|----------|
| `include/linux/fs.h` | `IOCB_HIPRI`, `IOCB_NOWAIT`, `struct kiocb`, `file_operations.iopoll` |
| `include/uapi/linux/fs.h` | `RWF_HIPRI`, `RWF_NOWAIT` (userspace-visible flags) |
| `include/uapi/linux/io_uring.h` | `IORING_SETUP_IOPOLL`, `IORING_SETUP_SQPOLL` |
| `fs/read_write.c` | `kiocb_set_rw_flags()`, `do_iter_readv_writev()` |
| `fs/iomap/direct-io.c` | `iomap_dio_rw()`, `iocb_bio_iopoll()`, bio submission with `REQ_HIPRI` |
| `block/bio.c` | `bio_poll()` |
| `block/blk-mq.c` | HIPRI request allocation, poll queue management |
| `drivers/nvme/host/pci.c` | `nvme_poll()`, `nvme_cqe_pending()`, phase bit check |
| `io_uring/io_uring.c` | `io_do_iopoll()`, `io_iopoll_check()` |
| `io_uring/rw.c` | `io_read()`, `io_write()`, NOWAIT fast path and io-wq fallback |
| `io_uring/sqpoll.c` | `io_sq_thread()`, SQPOLL kernel thread |

---

## Further reading

- [struct kiocb](kiocb.md) — `ki_flags`, `IOCB_HIPRI`, `IOCB_NOWAIT`, the full flag table
- [Direct I/O](direct-io.md) — O_DIRECT requirement for HIPRI/IOPOLL
- [Async I/O Evolution](async-io.md) — io_uring architecture and SQE/CQE model
- [iomap internals](iomap-internals.md) — how `iomap_dio_rw()` handles the DIO path
- [Tuning storage](tuning-storage.md) — practical fio and io_uring performance tuning
- `Documentation/block/blk-mq.rst` — block multiqueue architecture
- `Documentation/admin-guide/iostats.rst` — interpreting `/proc/diskstats`
- NVMe specification §4.6 — Completion Queue entry format and phase bit semantics
