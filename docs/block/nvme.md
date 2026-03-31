# NVMe Driver

> PCIe SSD architecture, submission/completion queues, and blk-mq integration

## NVMe overview

NVMe (Non-Volatile Memory Express) is the protocol for PCIe-attached SSDs. It's designed for low latency and high parallelism:

```
CPU → PCIe bus → NVMe controller → NAND flash

Key differences from SATA/SAS:
  SATA: 1 command queue, 32 depth
  NVMe: up to 65535 I/O queues, 65535 depth each
  NVMe latency: ~100µs (vs ~100ms HDD, ~1ms SATA SSD)
```

## NVMe queue architecture

### Admin queue and I/O queues

```
NVMe controller
├── Admin queue (Q0): management commands (identify, firmware, etc.)
└── I/O queues (Q1-QN): data read/write commands
    ├── Q1: CPU 0  (submission queue + completion queue)
    ├── Q2: CPU 1
    ├── Q3: CPU 2
    └── ...  (one queue per CPU, up to controller's maximum)
```

Each queue is a **shared memory ring** between the CPU and the NVMe controller:

```
Submission Queue (SQ):
  CPU writes commands here, advances SQ tail doorbell
  Controller reads commands, advances SQ head

Completion Queue (CQ):
  Controller writes completions here, advances CQ tail
  CPU reads completions, advances CQ head doorbell
```

### NVMe submission queue entry (SQE)

```c
/* include/linux/nvme.h */
struct nvme_command {
    __u8    opcode;           /* NVM_OP_READ, NVM_OP_WRITE, etc. */
    __u8    flags;
    __u16   command_id;       /* matches CQE command_id for completion */
    __le32  nsid;             /* namespace ID (1-based) */
    __u64   rsvd2;
    __le64  metadata;         /* metadata pointer */
    union nvme_data_ptr dptr; /* data pointer: PRP list or SGL */
    union {
        struct nvme_rw_command rw; /* for read/write */
        struct nvme_identify   identify;
        /* ... other command types ... */
    };
};

/* Read/write command fields: */
struct nvme_rw_command {
    __le16  flags;
    __le16  control;    /* FUA, PRINFO, etc. */
    __le32  dsmgmt;
    __le32  reftag;
    __le16  apptag;
    __le16  appmask;
    __le64  slba;       /* starting logical block address */
    __le16  length;     /* 0-based number of logical blocks - 1 */
};
```

### NVMe completion queue entry (CQE)

```c
struct nvme_completion {
    __le32  result;         /* command-specific result */
    __u32   rsvd;
    __le16  sq_head;        /* SQ head pointer (updated by controller) */
    __le16  sq_id;          /* submission queue ID */
    __u16   command_id;     /* matches SQE command_id */
    __le16  status;         /* success or error code */
    /* Bit 0: phase tag (alternates 0/1 per wrap of CQ) */
};
```

The **phase tag** allows polling for completions without a separate "entries used" counter: the CPU flips the expected phase bit on each CQ wrap.

## Linux NVMe driver: struct nvme_dev

```c
/* drivers/nvme/host/pci.c */
struct nvme_dev {
    struct nvme_queue   *queues;     /* array of I/O queues */
    u32                 q_depth;     /* queue depth */
    u32                 db_stride;   /* doorbell register stride */
    void __iomem       *bar;         /* BAR0 MMIO base */
    unsigned long       bar_mapped_size;

    /* Admin queue */
    struct nvme_queue   adminq;

    /* Interrupt */
    struct msix_entry  *entry;       /* MSI-X entries */
    int                 num_vecs;    /* number of MSI-X vectors */

    struct nvme_ctrl    ctrl;        /* generic NVMe controller */
    /* ... */
};

struct nvme_queue {
    struct nvme_dev    *dev;
    struct nvme_command *sq_cmds;   /* submission queue (DMA) */
    volatile struct nvme_completion *cqes; /* completion queue (DMA) */
    dma_addr_t          sq_dma_addr;
    dma_addr_t          cq_dma_addr;
    u32 __iomem        *q_db;       /* doorbell register */
    u16                 q_depth;
    u16                 cq_head;
    u16                 cq_phase;   /* phase bit */
    u16                 sq_tail;
    u16                 last_sq_tail;
    int                 cq_vec;     /* MSI-X vector */
    struct blk_mq_tags *tags;
};
```

## blk-mq integration

The NVMe driver hooks into the block layer's `blk-mq` (multi-queue) framework:

```c
/* drivers/nvme/host/pci.c */
static const struct blk_mq_ops nvme_mq_admin_ops = {
    .queue_rq = nvme_queue_rq,
    .complete = nvme_pci_complete_rq,
    .init_hctx = nvme_admin_init_hctx,
    .exit_hctx = nvme_admin_exit_hctx,
    .init_request = nvme_init_request,
    .timeout = nvme_timeout,
};

static const struct blk_mq_ops nvme_mq_ops = {
    .queue_rq     = nvme_queue_rq,     /* submit a request to the NVMe SQ */
    .complete     = nvme_pci_complete_rq, /* called on completion */
    .init_hctx    = nvme_init_hctx,    /* per hardware queue initialization */
    .init_request = nvme_init_request,
    .map_queues   = nvme_pci_map_queues, /* CPU → queue mapping */
    .poll         = nvme_poll,          /* polled completion (IOPOLL) */
    .timeout      = nvme_timeout,
};
```

### nvme_queue_rq: submitting a request

```c
static blk_status_t nvme_queue_rq(struct blk_mq_hw_ctx *hctx,
                                    const struct blk_mq_queue_data *bd)
{
    struct nvme_ns *ns = hctx->queue->queuedata;
    struct nvme_queue *nvmeq = hctx->driver_data;
    struct request *req = bd->rq;
    struct nvme_iod *iod = blk_mq_rq_to_pdu(req);
    struct nvme_command cmnd;
    blk_status_t ret;

    /* Map request buffers to DMA */
    ret = nvme_setup_cmd(ns, req, &cmnd);
    if (ret)
        return ret;

    ret = nvme_map_data(dev, req, &cmnd);
    if (ret)
        goto out_free_cmd;

    /* Write command into the SQ ring */
    nvme_submit_cmd(nvmeq, &cmnd, bd->last);
    return BLK_STS_OK;
}

static void nvme_submit_cmd(struct nvme_queue *nvmeq,
                              struct nvme_command *cmd, bool write_sq)
{
    u16 tail = nvmeq->sq_tail;

    /* Copy command to SQ slot */
    memcpy(nvmeq->sq_cmds + tail, cmd, sizeof(*cmd));

    /* Advance tail */
    if (++tail == nvmeq->q_depth)
        tail = 0;
    nvmeq->sq_tail = tail;

    if (write_sq) {
        /* Ring doorbell: tell controller new SQ entries available */
        writel(tail, nvmeq->q_db);
    }
}
```

### nvme_irq: processing completions

```c
static irqreturn_t nvme_irq(int irq, void *data)
{
    struct nvme_queue *nvmeq = data;
    return nvme_process_cq(nvmeq);
}

static blk_status_t nvme_process_cq(struct nvme_queue *nvmeq)
{
    u16 head = nvmeq->cq_head;
    u8  phase = nvmeq->cq_phase;

    /* Poll CQ entries with matching phase bit */
    while ((nvmeq->cqes[head].status & 1) == phase) {
        struct nvme_completion *cqe = &nvmeq->cqes[head];
        u16 status = le16_to_cpu(cqe->status) >> 1;

        /* Complete the request */
        struct request *req = nvme_find_rq(nvmeq, cqe->command_id);
        nvme_complete_rq(req, status);

        /* Advance head */
        if (++head == nvmeq->q_depth) {
            head = 0;
            phase ^= 1;   /* phase bit flips on wrap */
        }
    }

    nvmeq->cq_head  = head;
    nvmeq->cq_phase = phase;

    /* Ring CQ head doorbell */
    writel(head, nvmeq->q_db + nvmeq->dev->db_stride);
    return IRQ_HANDLED;
}
```

## NVMe namespaces

NVMe uses "namespaces" to divide the SSD into logical units (like LUNs in SCSI):

```bash
# List NVMe namespaces
nvme list-ns /dev/nvme0

# Each namespace appears as a block device:
ls /dev/nvme0n1    # nvme0 = controller 0, n1 = namespace 1
ls /dev/nvme0n2    # namespace 2

# Identify the controller:
nvme id-ctrl /dev/nvme0 | head -20
# mn: Samsung SSD 990 PRO 2TB
# sn: S1234567890
# fr: 4B2QFXO7
# tnvmcap: 2000398934016   # 2TB

# Identify namespace 1:
nvme id-ns /dev/nvme0n1
# nsze: 3907029168  # total sectors
# ncap: 3907029168  # formatted capacity
# lbads: 9           # logical block size = 2^9 = 512B (or 12 = 4096B)
```

## NVMe polling (no-IRQ path)

For ultra-low latency, NVMe can use **polling** instead of interrupts:

```bash
# Enable io polling for NVMe
echo 1 > /sys/block/nvme0n1/queue/io_poll
echo 0 > /sys/block/nvme0n1/queue/io_poll_delay  # -1 = spin, 0 = hybrid

# io_uring with IORING_SETUP_IOPOLL:
struct io_uring_params params = {
    .flags = IORING_SETUP_IOPOLL,
};
io_uring_queue_init_params(128, &ring, &params);
```

With polling, the completion interrupt is disabled; the kernel busy-polls the CQ after submission. Latency can drop from ~100µs to ~15-20µs for NVMe SSDs.

## Observing NVMe

```bash
# NVMe statistics
nvme smart-log /dev/nvme0
# Critical Warning: 0x00
# Temperature: 35 C
# Available Spare: 100%
# Data Units Read: 12,345,678
# Data Units Written: 9,876,543
# Host Read Commands: 234,567,890
# Host Write Commands: 123,456,789

# I/O queue stats
cat /sys/block/nvme0n1/queue/iostats

# Queue depth and dispatch stats (blk-mq)
cat /sys/block/nvme0n1/mq/0/nr_tags

# Latency histogram
bpftrace -e '
tracepoint:block:block_rq_issue
/strncmp(args->devname, "nvme", 4) == 0/
{
    @start[args->sector] = nsecs;
}
tracepoint:block:block_rq_complete
/@start[args->sector]/
{
    @lat_us = hist((nsecs - @start[args->sector]) / 1000);
    delete(@start[args->sector]);
}'
```

## Further reading

- [blk-mq (Multi-Queue)](blk-mq.md) — the block multiqueue framework NVMe uses
- [bio and request structures](bio-request.md) — struct request NVMe processes
- [I/O Schedulers](io-schedulers.md) — NVMe bypasses scheduler (none scheduler)
- [PCI Drivers](../drivers/pci-driver.md) — NVMe is a PCI driver
- [Direct I/O](../io/direct-io.md) — O_DIRECT + NVMe for databases
- `drivers/nvme/host/pci.c` — NVMe PCI driver
- `drivers/nvme/host/core.c` — NVMe core (namespaces, admin commands)
