# bio and request structures

> The objects that describe I/O operations in the block layer

## struct bio: the submission unit

A `bio` (Block I/O) is the fundamental I/O descriptor. It describes a scatter-gather I/O operation: one or more physical memory segments mapped to contiguous sectors on a block device.

```c
/* include/linux/blk_types.h */
struct bio {
    struct bio          *bi_next;     /* for chaining bios in a request */
    struct block_device *bi_bdev;     /* target block device */
    blk_opf_t            bi_opf;      /* operation + flags (REQ_OP_READ/WRITE, etc.) */
    blk_status_t         bi_status;   /* completion status */

    /* The scatter-gather list */
    struct bio_vec      *bi_io_vec;   /* array of (page, offset, len) */
    struct bvec_iter     bi_iter;     /* current position in bi_io_vec */

    bio_end_io_t        *bi_end_io;   /* completion callback */
    void                *bi_private;  /* caller's private data */
    atomic_t             __bi_remaining; /* for splitting: how many sub-bios remain */
};
```

### struct bio_vec: one scatter-gather segment

```c
/* include/linux/bvec.h */
struct bio_vec {
    struct page  *bv_page;    /* the page containing the data */
    unsigned int  bv_len;     /* number of bytes */
    unsigned int  bv_offset;  /* byte offset within the page */
};
```

Each `bio_vec` describes a contiguous chunk of memory (one page or less). A bio with multiple `bio_vec`s is a scatter-gather operation:

```
bio->bi_io_vec:
  [0]: page A, offset 0, len 4096    → sectors 1024..1031
  [1]: page B, offset 2048, len 2048  → sectors 1032..1035
  [2]: page C, offset 0, len 4096    → sectors 1036..1043

All map to contiguous sectors on disk.
```

### bio_vec iteration

```c
/* Iterate over all segments in a bio */
struct bvec_iter iter;
struct bio_vec bvec;

bio_for_each_segment(bvec, bio, iter) {
    /* bvec.bv_page, bvec.bv_offset, bvec.bv_len */
    void *addr = page_address(bvec.bv_page) + bvec.bv_offset;
    /* process bvec.bv_len bytes at addr */
}
```

## bio operations (bi_opf)

```c
/* Operation types */
REQ_OP_READ        /* read data from device */
REQ_OP_WRITE       /* write data to device */
REQ_OP_FLUSH       /* flush device write cache */
REQ_OP_DISCARD     /* discard sectors (TRIM for SSDs) */
REQ_OP_ZONE_RESET  /* reset a zoned device zone */
REQ_OP_WRITE_ZEROES /* zero out sectors */

/* Flags that modify the operation */
REQ_SYNC      /* caller is waiting for completion */
REQ_META      /* metadata I/O (higher priority) */
REQ_PRIO      /* priority I/O */
REQ_NOMERGE   /* don't merge with adjacent requests */
REQ_IDLE      /* hint: submit when queue is idle */
REQ_FUA       /* force unit access (bypass write cache) */
REQ_PREFLUSH  /* issue flush before this write */
REQ_RAHEAD    /* read-ahead, can be dropped under pressure */
```

## Allocating and submitting a bio

```c
#include <linux/bio.h>

/* Allocate a bio with nr_vecs bio_vec slots */
struct bio *bio = bio_alloc(GFP_KERNEL, nr_vecs);

bio->bi_bdev = bdev;
bio_set_op_attrs(bio, REQ_OP_WRITE, 0);
bio->bi_iter.bi_sector = sector;   /* starting sector (512-byte units) */
bio->bi_end_io = my_bio_complete;  /* completion callback */
bio->bi_private = my_data;

/* Add pages to the bio */
bio_add_page(bio, page, len, offset);

/* Submit */
submit_bio(bio);

/* Completion callback */
static void my_bio_complete(struct bio *bio)
{
    if (bio->bi_status != BLK_STS_OK)
        handle_error(bio->bi_status);
    /* free resources */
    bio_put(bio);
}
```

## struct request: the scheduled unit

While `bio` is the submission unit from the filesystem, `struct request` is what the I/O scheduler works with. Multiple bios can be **merged** into a single request if they are adjacent on disk:

```c
/* include/linux/blkdev.h */
struct request {
    struct request_queue *q;        /* the queue */
    struct blk_mq_ctx    *mq_ctx;   /* software queue context */
    struct blk_mq_hw_ctx *mq_hctx; /* hardware queue context */
    blk_opf_t             cmd_flags; /* REQ_OP_* + flags */
    struct bio            *bio;      /* first bio in the chain */
    struct bio            *biotail;  /* last bio in the chain */
    unsigned int          __data_len; /* total bytes */
    sector_t              __sector;  /* starting sector */
    unsigned int          nr_phys_segments; /* scatter-gather segment count */
    /* ... tag, timeout, stats ... */
};
```

### Bio merging

The I/O scheduler tries to merge adjacent bios into one request before dispatch:

```
Before merging:
  Request A: sectors 1000-1007 (write)
  Bio:        sectors 1008-1015 (write to same device)

After merging:
  Request A: sectors 1000-1015 (merged write)
  → fewer interrupts, larger DMA transfers, better throughput
```

Merging is constrained by hardware limits:
- `queue->limits.max_sectors` — maximum request size
- `queue->limits.max_segments` — maximum scatter-gather segments
- `queue->limits.max_segment_size` — maximum bytes per segment

## bio splitting

When a bio exceeds hardware limits, the block layer splits it:

```c
/* bio_split: split bio at 'sectors' sectors from start */
struct bio *split = bio_split(bio, sectors, GFP_NOIO, &q->bio_split);
bio_chain(split, bio);   /* link them: split completes before bio */
submit_bio(split);
submit_bio(bio);
```

Splitting is transparent to the filesystem — the completion callback fires only when all sub-bios complete.

## Further reading

- [Block Layer Overview](block-overview.md) — Where bios fit in the stack
- [blk-mq](blk-mq.md) — How requests are dispatched to hardware
- [DMA](../mm/dma.md) — How bio pages are DMA-mapped for the controller
