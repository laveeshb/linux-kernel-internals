# Block Layer

> How the kernel moves storage I/O from the filesystem down to the device — and merges, reorders, and schedules it along the way

## Getting Started

The block layer sits between the parts of the kernel that *produce* storage I/O — filesystems, the page cache's writeback path, swap, and direct-I/O submitters — and the drivers that talk to actual devices (NVMe, SCSI, virtio-blk, ...). Its job is to turn a stream of `bio` submissions into an efficient sequence of device requests: merging adjacent I/O, batching submissions, applying an I/O scheduler, and mapping work onto a device's hardware queues.

This documentation explains not just the API but the design — why the block layer exists as a distinct layer, why it was rewritten around multiple queues (`blk-mq`) for modern SSDs, and what the resulting structures (`bio`, `request`, `request_queue`, software and hardware queues) actually do.

```
Filesystem / writeback / swap / O_DIRECT
    ↓ submit_bio()
Block layer core   ──►  (optional) I/O scheduler: BFQ · mq-deadline · Kyber · none
    ↓ blk-mq: software queue (per-CPU) → hardware queue (per device queue)
Device driver: NVMe · SCSI · virtio-blk · ...
    ↓ DMA
Storage hardware
```

### A brief history: why blk-mq

The original block layer used a single request queue per device, protected by a single lock — fine for a rotational disk doing a few hundred IOPS, but a scaling wall for SSDs doing millions. The multi-queue block layer (`blk-mq`) was introduced in Linux 3.13 to fix this ([`320ae51feed5`](https://git.kernel.org/linus/320ae51feed5), "blk-mq: new multi-queue block IO queueing mechanism"): each CPU gets its own software queue that maps onto the device's hardware queues, removing the shared lock. Drivers migrated over the following years, until blk-mq became the *only* path: the legacy single-queue I/O schedulers (CFQ, deadline) were removed in Linux 5.0 ([`f382fb0bcef4`](https://git.kernel.org/linus/f382fb0bcef4), "block: remove legacy IO schedulers"), and the old request path went with them. Every block driver today is blk-mq.

### Prerequisites

- **C and basic OS concepts** — the kernel is in C; be comfortable with the ideas of drivers, DMA, and the kernel/userspace boundary.
- **The page cache and writeback** help, since most block I/O originates there — see [page cache](../mm/page-cache.md) and [page cache and writeback](../io/page-cache-writeback.md).

### Getting the source

```bash
git clone https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git
cd linux
```

The relevant directories are `block/` (core, blk-mq, schedulers), `drivers/nvme/`, `drivers/scsi/`, and `drivers/block/` (virtio-blk, loop, `null_blk`).

### Experimenting

`null_blk` is the easiest way to exercise the block layer without hardware — it presents a configurable in-memory block device. `blktests` is the block-layer test suite, and `fio` is the standard tool for generating and measuring I/O patterns.

### Suggested reading order

1. **[Block Layer Overview](block-overview.md)** — the key structures and the submission path end to end
2. **[Life of a Block I/O](life-of-block-io.md)** — one I/O traced from `submit_bio()` down to the device and back
3. **[bio and request structures](bio-request.md)** — the I/O descriptor objects, and how a `bio` becomes a `request`
4. **[blk-mq: Multi-Queue Block Layer](blk-mq.md)** — software/hardware queues, tag allocation, and the driver interface
5. **[I/O Schedulers](io-schedulers.md)** — BFQ, mq-deadline, and Kyber: what each optimizes for
6. **[Block Cgroup (I/O Control)](blk-cgroup.md)** — dividing a device's bandwidth between cgroups
7. **[NVMe Driver](nvme.md)** — how a real modern driver plugs into blk-mq via submission/completion queues
8. **[Device Mapper: dm-verity](dm-verity.md)** — stacking a virtual block device for integrity verification
9. **[Observability](block-observability.md)** — seeing what the block layer is doing, from counters to blktrace
10. **[War Stories](war-stories.md)** — real block-layer bugs and what they taught

### What you'll learn

| Textbook idea | Linux reality |
|---|---|
| "The OS sends reads and writes to the disk" | I/O is described by a [`bio`](bio-request.md), merged and queued as a `request`, reordered by an [I/O scheduler](io-schedulers.md), and dispatched to a hardware queue |
| "One request queue per disk" | [blk-mq](blk-mq.md) gives each CPU a software queue mapped onto the device's hardware queues — no shared lock |
| "The I/O scheduler makes things faster" | On fast SSDs the best scheduler is often *none*; scheduling mainly bounds latency and enforces fairness ([schedulers](io-schedulers.md)) |
| "`write()` goes to disk" | It usually goes to the [page cache](../io/page-cache-writeback.md); the block layer only sees it later, during writeback |

## Documentation

| Document | What you'll learn |
|---|---|
| [Block Layer Overview](block-overview.md) | Key structures (`bio`, `request`, `request_queue`) and the submission path |
| [Life of a Block I/O](life-of-block-io.md) | One I/O traced end to end, submission through completion |
| [bio and request structures](bio-request.md) | The I/O descriptor objects and their lifecycle |
| [blk-mq: Multi-Queue Block Layer](blk-mq.md) | Software/hardware queues, tags, and the modern driver interface |
| [I/O Schedulers](io-schedulers.md) | BFQ, mq-deadline, and Kyber |
| [Block Cgroup (I/O Control)](blk-cgroup.md) | Dividing device bandwidth per cgroup (`io.max` / `io.weight` / `io.latency`) |
| [NVMe Driver](nvme.md) | PCIe SSD architecture, submission/completion queues, blk-mq integration |
| [Device Mapper: dm-verity](dm-verity.md) | Merkle-tree block integrity verification (Android, ChromeOS) |
| [Observability](block-observability.md) | `/proc/diskstats`, `blktrace`, and BPF for block I/O |
| [War Stories](war-stories.md) | Real block-layer incidents and their lessons |

## Further reading

- [Kernel docs: block layer](https://docs.kernel.org/block/index.html) — the authoritative reference for the block subsystem
- [`320ae51feed5`](https://git.kernel.org/linus/320ae51feed5) — the introduction of blk-mq (Linux 3.13)
- [`f382fb0bcef4`](https://git.kernel.org/linus/f382fb0bcef4) — removal of the legacy single-queue schedulers (Linux 5.0)
