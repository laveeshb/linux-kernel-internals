# Life of a Block I/O

> Tracing a read or write from `submit_bio()` down through the block layer to the device — and back up on completion

Every block I/O has two halves: a **submission path** that carries a request *down* toward the hardware, and a **completion path** that carries the result *back up* to whoever asked. Between them, the block layer does the work that justifies its existence — merging, batching, scheduling, and mapping onto hardware queues. This page follows one I/O through both halves.

Function names below refer to [`block/blk-mq.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-mq.c) and [`block/blk-core.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-core.c) unless noted.

## The starting point: a bio

A [`bio`](bio-request.md) describes one I/O: a target device, a starting sector, a direction, and a list of memory segments to read into or write from. Whoever wants I/O — a filesystem, the [page-cache writeback](../io/page-cache-writeback.md) path, swap, or an `O_DIRECT` submitter — fills in a `bio` and calls `submit_bio()`.

## 1. Submission: `submit_bio()` → `blk_mq_submit_bio()`

`submit_bio()` funnels into `submit_bio_noacct()`, which does validation and I/O accounting, then hands the `bio` to `blk_mq_submit_bio()` — the entry into the multi-queue machinery. From here the block layer's first instinct is *not* to build a new request, but to avoid one.

## 2. Can we avoid a new request? Merging

Before allocating anything, the block layer tries to fold the `bio` into an existing, not-yet-dispatched request:

- **`blk_attempt_plug_merge()`** — the current task holds a short *plug* list of pending requests (see step 4). A `bio` that is contiguous with one of them is merged right there, without taking a queue lock.
- **`blk_mq_sched_bio_merge()`** — if an I/O scheduler is attached, it gets a chance to merge the `bio` into a request already sitting in its queues.

A **back-merge** (the `bio`'s start sector equals a request's end) or **front-merge** simply extends the existing request to cover the new segments. Merging is why a stream of sequential 4 KB writes becomes a handful of large requests instead of thousands of tiny ones — the single biggest efficiency win the block layer provides.

## 3. Allocation: a bio becomes a request

If nothing could be merged, `blk_mq_get_new_requests()` allocates a `request` by claiming a free **tag** from the hardware queue's tag set. That tag is the request's identity for the rest of its life — it travels down to the device and comes back on completion to identify which I/O finished.

Tags are finite (the queue depth). If none is free, the submitter **blocks** until one is returned. This is the block layer's natural backpressure: a device that can't keep up throttles its submitters automatically, without any explicit rate limiting.

## 4. Plugging: batching for throughput

Rather than dispatch immediately, the fresh request is usually added to the task's **plug**. Code that is about to submit a burst of I/O brackets it with `blk_start_plug()` / `blk_finish_plug()` — the writeback path does this around a flushing run, for example. While the plug is held, requests accumulate, which gives merging (step 2) more to work with and amortizes the cost of poking the hardware. When the plug is flushed, its requests move toward dispatch.

## 5. Scheduling: order and fairness

If an [I/O scheduler](io-schedulers.md) is attached — BFQ, mq-deadline, or Kyber — requests wait in its queues and it decides the **dispatch order**: bounding tail latency, dividing bandwidth fairly between cgroups, or reducing seeks on rotational media. On a fast SSD the scheduler is frequently set to **`none`**, and requests flow straight to the hardware queue, because reordering buys little when the device has no seek penalty and millions of IOPS to spare.

## 6. Dispatch: into the hardware queue

`blk_mq_run_hw_queue()` → `blk_mq_dispatch_rq_list()` walks the ready requests and hands each to the driver's `->queue_rq()` callback — `nvme_queue_rq()` for NVMe ([`drivers/nvme/host/pci.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/nvme/host/pci.c)), and equivalents for SCSI or virtio-blk. The driver translates the generic request into a device-specific command, places it on a **hardware submission queue** (identified by the request's tag), and rings the device's doorbell. Control returns to the submitter; the I/O is now in flight.

## 7. Completion: back up the stack

Eventually the device finishes and signals it — usually an **interrupt**, or a **[poll](../io/io-polling.md)** for latency-critical I/O. The driver reads the completion, looks up the request by its tag, and calls `blk_mq_complete_request()`. To keep data cache-warm, completion is often steered back to the CPU that submitted the I/O (via an IPI), where it runs `blk_mq_end_request()` → `bio_endio()`.

`bio_endio()` invokes the `bio`'s `->bi_end_io` callback — the hook the *original* submitter installed. That is where the story ends for each caller: a synchronous reader is woken, a page is marked up-to-date and unlocked, or a writeback completion records that the data is now durable. The tag is freed, which may release a submitter that was blocked back in step 3.

## The round trip

```
 submit_bio()                                     bi_end_io() callback
     │  submit_bio_noacct()                              ▲  (wake / mark up-to-date)
     ▼                                                   │
 blk_mq_submit_bio()                              bio_endio()
     │  try merge (plug / scheduler)                     ▲
     ▼  else allocate request (claim a tag)      blk_mq_end_request()
 plug → (I/O scheduler) → hardware queue                 ▲
     │  blk_mq_dispatch_rq_list()               blk_mq_complete_request()
     ▼  ->queue_rq()                                     ▲  (IRQ or poll)
 device  ───────────────  in flight  ──────────────────  device
```

## Try it yourself

`blktrace` records every stage of this path — `Q` (queued), `M` (merged), `G` (get request), `I` (inserted), `D` (dispatched), `C` (completed) — for a live device:

```bash
blktrace -d /dev/nvme0n1 -o - | blkparse -i -
```

`bpftrace` can watch the same transitions by attaching to the block tracepoints (`block:block_bio_queue`, `block:block_rq_issue`, `block:block_rq_complete`).

## Further reading

- [Kernel docs: block layer](https://docs.kernel.org/block/index.html)
- [`block/blk-mq.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-mq.c) — the submission and completion machinery
- [`320ae51feed5`](https://git.kernel.org/linus/320ae51feed5) — the introduction of blk-mq, which established this multi-queue path (Linux 3.13)
