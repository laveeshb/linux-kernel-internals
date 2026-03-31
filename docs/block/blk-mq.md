# blk-mq: Multi-Queue Block Layer

> The modern block layer interface for high-performance storage

## Why blk-mq?

Traditional block layer had a single request queue per device, protected by a global lock. This was fine for HDDs (which are sequential anyway) but became a bottleneck for NVMe SSDs that can handle millions of IOPS across multiple hardware queues.

blk-mq (introduced in Linux 3.13) uses:
- **Multiple software queues** (one per CPU or CPU group) to eliminate lock contention
- **Multiple hardware queues** (mapped to NVMe queues, SCSI host adapters, etc.)
- **Per-CPU tag allocation** for request objects

## The evolution: from single queue to blk-mq

### The original block layer (Linux 2.4–2.6)

The original block layer had one `request_queue` per device, protected by a single spinlock (`q->queue_lock`). An elevator scheduler (CFQ, deadline, anticipatory) sat inside that queue, merging and reordering requests to minimize HDD seek time.

This made sense for HDDs: a spinning disk has seek latency (3–10ms), so batching and reordering requests by cylinder address (the "elevator" metaphor) could double throughput. CFQ (Completely Fair Queuing) was the default — it gave each process a fair share of disk bandwidth by interleaving per-process queues.

```
Per-device request_queue
  │
  ├── q->queue_lock (single spinlock — ALL CPUs contend here)
  ├── elevator (CFQ/deadline/anticipatory)
  └── hw_queue → one hardware submission path
```

### SSDs exposed the flaw

When SSDs arrived (~2007–2010), the entire model broke down:

1. **No seek cost** — reordering requests by address was irrelevant. The elevator added CPU overhead and latency without any benefit.
2. **High parallelism** — an SSD could serve thousands of I/Os simultaneously from multiple internal flash dies, but the kernel serialized them all through one queue.
3. **Interrupt bottleneck** — completion interrupts landed on one CPU, which then had to wake up requestors on other CPUs.

NVMe (2011+) made this crisis acute. An NVMe controller has up to 65,535 hardware queues, each with 65,535 slots. The kernel could only use one of them because `request_queue` was a single object with a single lock.

Benchmarks on early NVMe drives showed the kernel saturating the `queue_lock` spinlock at around 700K IOPS — far below the hardware's ~1M+ IOPS capability.

### blk-mq (Linux 3.13, 2014)

Jens Axboe redesigned the block layer around two key ideas — [`320ae51feed5`](https://git.kernel.org/linus/320ae51feed5c2f13664aa05a76bec198967e04d) ("blk-mq: new multi-queue block IO queueing mechanism"), [LWN](https://lwn.net/Articles/552683/):

1. **Per-CPU software queues** — each CPU has its own `blk_mq_ctx` with its own lock. CPUs never contend with each other during I/O submission. Requests are batched on the per-CPU queue, then dispatched to a hardware queue.

2. **Multiple hardware queues** — `blk_mq_hw_ctx` maps to actual hardware submission queues. For NVMe, each hardware queue maps to an NVMe SQ/CQ pair. For SCSI adapters with one queue, blk-mq presents one hardware queue.

The elevator schedulers were redesigned as optional plugins that fit *between* the per-CPU queues and the hardware queues. NVMe uses `none` (no scheduler) by default — requests go straight through. HDDs still benefit from `mq-deadline` or `bfq`.

```
Before blk-mq:    1 CPU → q->queue_lock → 1 hw queue
After blk-mq:     N CPUs → N per-CPU queues → M hw queues (N ≫ M possible)
```

The result: modern NVMe drives saturate at 3–7M IOPS on Linux, limited by PCIe bandwidth rather than kernel lock contention.

## Two-level queue architecture

```
CPUs
 CPU 0    CPU 1    CPU 2    CPU 3
   │        │        │        │
   ▼        ▼        ▼        ▼
Software Queue (blk_mq_ctx)  ← per-CPU, no contention between CPUs
   │        │        │        │
   └────────┴────────┘        │
           │                  │
    ┌──────▼──────┐   ┌───────▼──────┐
    │  Hardware   │   │  Hardware    │
    │  Queue 0    │   │  Queue 1     │  ← maps to NVMe submission queues
    └─────────────┘   └──────────────┘
```

### Software queues (blk_mq_ctx)

One per CPU. Requests are initially queued here without any locking (each CPU has its own queue):

```c
/* Per-CPU software queue context */
struct blk_mq_ctx {
    struct {
        spinlock_t      lock;
        struct list_head rq_lists[HCTX_MAX_TYPES]; /* pending requests */
    } ____cacheline_aligned_in_smp;

    unsigned int        cpu;        /* CPU this belongs to */
    unsigned short      index_hw[HCTX_MAX_TYPES]; /* hw queue index */
    struct blk_mq_hw_ctx *hctxs[HCTX_MAX_TYPES];
    struct request_queue *queue;
};
```

### Hardware queues (blk_mq_hw_ctx)

One per hardware queue (NVMe namespace, virtio queue, etc.):

```c
/* Hardware queue context */
struct blk_mq_hw_ctx {
    spinlock_t          lock;         /* protects dispatch list */
    struct list_head    dispatch;     /* requests ready to dispatch */
    unsigned long       state;        /* BLK_MQ_S_* */
    struct blk_mq_tags *tags;         /* tag allocation for this hw queue */
    cpumask_var_t       cpumask;      /* CPUs mapped to this hw queue */
    unsigned long       flags;        /* BLK_MQ_F_* */
};
```

## Implementing a blk-mq driver

### 1. Define the operations

```c
static const struct blk_mq_ops my_mq_ops = {
    .queue_rq     = my_queue_rq,     /* submit a request to hardware */
    .complete     = my_complete_rq,  /* called on completion from interrupt */
    .timeout      = my_timeout,      /* called when a request times out */
    .poll         = my_poll,         /* for polled I/O (no interrupt) */
};
```

### 2. Set up tag_set

```c
struct blk_mq_tag_set tag_set;

memset(&tag_set, 0, sizeof(tag_set));
tag_set.ops        = &my_mq_ops;
tag_set.nr_hw_queues = num_online_cpus();  /* or: number of NVMe queues */
tag_set.queue_depth  = 128;               /* max in-flight requests */
tag_set.numa_node    = NUMA_NO_NODE;
tag_set.cmd_size     = sizeof(struct my_request);  /* driver-private per-request data */
tag_set.flags        = BLK_MQ_F_SHOULD_MERGE;

ret = blk_mq_alloc_tag_set(&tag_set);
```

### 3. Allocate disk

```c
struct gendisk *disk = blk_mq_alloc_disk(&tag_set, NULL, my_dev);
disk->major       = 0;  /* let kernel assign */
disk->first_minor = 0;
disk->minors      = 1;
disk->fops        = &my_block_ops;
snprintf(disk->disk_name, DISK_NAME_LEN, "myblk%d", index);

/* Set capacity (in 512-byte sectors) */
set_capacity(disk, total_bytes >> 9);

/* Register */
add_disk(disk);
```

### 4. queue_rq: submitting to hardware

```c
static blk_status_t my_queue_rq(struct blk_mq_hw_ctx *hctx,
                                  const struct blk_mq_queue_data *bd)
{
    struct request *rq = bd->rq;
    struct my_request *my_req = blk_mq_rq_to_pdu(rq);

    /* Mark request as started */
    blk_mq_start_request(rq);

    /* Build hardware command */
    my_req->sector = blk_rq_pos(rq);     /* starting sector */
    my_req->count  = blk_rq_sectors(rq); /* sector count */
    my_req->dir    = rq_data_dir(rq);    /* READ or WRITE */

    /* Map scatter-gather list for DMA */
    my_req->nsegs = blk_rq_map_sg(hctx->queue, rq, my_req->sglist);

    /* Submit to hardware */
    if (my_hw_submit(hctx->driver_data, my_req) != 0) {
        blk_mq_requeue_request(rq, true);
        return BLK_STS_RESOURCE;
    }

    return BLK_STS_OK;
}
```

### 5. Completion from interrupt

```c
/* Called from IRQ handler when hardware signals completion */
static void my_irq_handler(void *data)
{
    struct my_request *my_req = data;
    struct request *rq = blk_mq_rq_from_pdu(my_req);

    /* Pass status directly — struct request has no 'result' field */
    blk_mq_end_request(rq, BLK_STS_OK);  /* or BLK_STS_IOERR on error */
}

/* Alternatively, split completion into two steps: */
static void my_complete_rq(struct request *rq)
{
    blk_mq_end_request(rq, BLK_STS_OK);
    /* This notifies the bio and its filesystem/application */
}
```

## Tag allocation

Each in-flight request gets a **tag** — a small integer that uniquely identifies it while it's outstanding. The driver uses the tag to correlate completion events with requests.

```c
/* Tag range: 0 to queue_depth-1 */
int tag = rq->tag;    /* set by blk-mq before calling queue_rq */

/* Retrieve request from tag in completion */
struct request *rq = blk_mq_tag_to_rq(hctx->tags, tag);
```

## Polled I/O

For ultra-low latency NVMe, spinning for completion is faster than waiting for an interrupt:

```c
/* Submit with polling flag */
bio->bi_opf |= REQ_POLLED;
submit_bio(bio);

/* Poll for completion */
blk_poll(q, cookie, true);
```

This avoids interrupt overhead (~1-2µs) at the cost of burning a CPU. Useful when latency target is under 10µs.

## Observing blk-mq

```bash
# Queue depth and inflight
cat /sys/block/nvme0n1/queue/nr_requests      # max queue depth
cat /sys/block/nvme0n1/inflight               # current in-flight requests

# Per-hardware queue stats (if driver exposes)
ls /sys/block/nvme0n1/mq/
cat /sys/block/nvme0n1/mq/0/nr_tags

# blktrace: trace individual I/O events
blktrace -d /dev/nvme0n1 -o - | blkparse -i -
# C = completion, D = driver, I = insert, Q = queued

# iostat: throughput and latency
iostat -x 1 /dev/nvme0n1
```

## Further reading

- [bio and request structures](bio-request.md) — What blk-mq dispatches
- [I/O Schedulers](io-schedulers.md) — What runs before blk-mq dispatch
- [Block Layer Overview](block-overview.md) — The full picture
