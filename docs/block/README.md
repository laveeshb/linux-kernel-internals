# Block Layer

> How the kernel handles storage I/O from filesystem to hardware

## The block layer's role

The block layer sits between filesystems (and direct I/O users) and block device drivers. It provides:

- A uniform interface (`struct bio`) for submitting I/O to any block device
- I/O scheduling: reorders requests for efficiency (merging, elevator algorithms)
- Request queuing: batches and plugs I/O for throughput
- Multi-queue support (blk-mq): maps to modern NVMe and SAS hardware with multiple queues

```
Filesystem (ext4, btrfs...)
    ↓ submit_bio()
Block layer core
    ↓ (optional) I/O scheduler (BFQ, mq-deadline, kyber)
    ↓ blk-mq: software queue → hardware queue
Device driver (NVMe, SCSI, virtio-blk...)
    ↓ DMA
Storage hardware
```

## Contents

- [Block Layer Overview](block-overview.md) — Key structures and submission path
- [bio and request structures](bio-request.md) — The I/O descriptor objects
- [blk-mq: Multi-Queue Block Layer](blk-mq.md) — Modern driver interface
- [I/O Schedulers](io-schedulers.md) — BFQ, mq-deadline, kyber
