# Block Layer Overview

> Key structures and the I/O submission path

## Key data structures

The block layer uses three key structures:

```
gendisk                    ← represents the whole disk (/dev/sda)
  │
  ├── block_device         ← represents a partition or whole disk (/dev/sda1)
  │
  └── request_queue        ← I/O queue + scheduler state
        │
        └── blk_mq_tag_set ← hardware queue mapping (blk-mq)
```

### struct gendisk

`gendisk` represents a physical disk or virtual block device:

```c
/* include/linux/blkdev.h */
struct gendisk {
    int                    major;         /* device major number */
    int                    first_minor;   /* first minor number */
    int                    minors;        /* number of minors (partitions) */
    char                   disk_name[DISK_NAME_LEN]; /* "sda", "nvme0n1" */
    struct xarray          part_tbl;      /* partition table */
    struct block_device   *part0;         /* whole-disk block_device */
    const struct block_device_operations *fops;  /* driver operations */
    struct request_queue  *queue;         /* I/O queue */
    void                  *private_data;  /* driver private data */
    int                   flags;          /* GENHD_FL_* */
};
```

### struct block_device

One `block_device` per partition (or whole disk). This is what filesystems use:

```c
struct block_device {
    sector_t           bd_start_sect;  /* start sector of partition */
    sector_t           bd_nr_sectors;  /* size in 512-byte sectors */
    struct gendisk    *bd_disk;        /* the physical disk */
    struct inode      *bd_inode;       /* inode in bdev filesystem */
    struct super_block *bd_super;      /* superblock if mounted */
    unsigned int       bd_openers;     /* open count */
    struct mutex       bd_mutex;       /* open/close mutex */
};
```

### struct request_queue

The `request_queue` is the central object for I/O management:

```c
struct request_queue {
    const struct blk_mq_ops  *mq_ops;   /* driver operations */
    struct blk_mq_tag_set    *tag_set;   /* hardware queue mapping */
    struct elevator_queue    *elevator;  /* I/O scheduler */
    struct queue_limits       limits;    /* sector size, max request size, etc. */
    unsigned long             queue_flags; /* QUEUE_FLAG_* */
    /* ... */
};
```

## The submit_bio() path

```c
/* Filesystem or direct I/O: */
submit_bio(bio)
    ↓
submit_bio_noacct(bio)
    ↓
blk_mq_submit_bio(bio)    ← blk-mq path (all modern drivers)
    │
    ├── Try to merge with existing request in plug list
    │
    ├── Allocate a request from tag set
    │
    ├── If I/O scheduler: elevator->type->ops.insert_requests()
    │     mq-deadline: add to deadline queue sorted by deadline
    │     BFQ: add to BFQ per-process queue
    │     none: add directly to hardware queue
    │
    └── blk_mq_run_hw_queue()
          → driver's .queue_rq() called
          → DMA mapping
          → hardware command submission
```

## /proc and /sys for block devices

```bash
# List block devices
lsblk
# NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINT
# sda      8:0    0  100G  0 disk
# ├─sda1   8:1    0   99G  0 part /
# └─sda2   8:2    0    1G  0 part [SWAP]
# nvme0n1 259:0   0  500G  0 disk
# └─nvme0n1p1 259:1 0 500G 0 part /data

# Block device stats
cat /proc/diskstats
# 8  0 sda 123456 7890 12345678 12345 234567 8901 23456789 23456 0 12345 23456
# Fields: major minor name reads_completed reads_merged sectors_read ms_reading
#         writes_completed writes_merged sectors_written ms_writing io_in_progress
#         ms_io ms_weighted_io

# Per-queue sysfs
ls /sys/block/sda/queue/
cat /sys/block/sda/queue/scheduler          # current scheduler
cat /sys/block/sda/queue/nr_requests        # queue depth
cat /sys/block/sda/queue/read_ahead_kb      # readahead size
cat /sys/block/sda/queue/rotational         # 1=HDD, 0=SSD/NVMe
cat /sys/block/sda/queue/logical_block_size # typically 512 or 4096
```

## I/O plug and unplug

For throughput, the block layer "plugs" the queue briefly to accumulate requests before submitting:

```c
/* Driver/filesystem code that issues many bios */
struct blk_plug plug;
blk_start_plug(&plug);

submit_bio(bio1);
submit_bio(bio2);
submit_bio(bio3);
/* Requests accumulate in plug->mq_list */

blk_finish_plug(&plug);
/* All requests dispatched at once → better merging, fewer interrupts */
```

This is analogous to TCP's Nagle algorithm: batching small operations into larger ones.

## Further reading

- [bio and request structures](bio-request.md) — The I/O descriptor objects
- [blk-mq](blk-mq.md) — The modern multi-queue dispatch mechanism
- [I/O Schedulers](io-schedulers.md) — How requests are reordered
