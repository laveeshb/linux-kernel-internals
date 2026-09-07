# virtio

> Paravirtualized I/O for KVM guests

## Why paravirtualization?

Emulating real hardware (e.g., Intel e1000 NIC, IDE disk) inside QEMU works but is slow: every device register access by the guest causes a VM exit, QEMU decodes the access, updates emulated state, and returns. This happens thousands of times per packet.

virtio replaces emulated hardware registers with a shared-memory protocol. The guest knows it's in a VM and cooperates — far fewer VM exits, much higher throughput.

```
Emulated hardware path:
  Guest write → VM exit → QEMU decode → emulate register → VM resume
  (per I/O register access)

virtio path:
  Guest fills ring buffer → notify host (one VM exit per batch)
  Host processes batch → notifies guest
```

## virtio architecture

```
Guest kernel                          Host (QEMU / vhost)
┌────────────────────────────┐        ┌────────────────────────────┐
│  virtio-net / virtio-blk   │        │  virtio-net backend        │
│  device driver             │        │  (QEMU or vhost-net)       │
│           │                │        │           ▲                │
│    virtqueue (vring)        │        │    virtqueue (vring)        │
│    ┌──────────────────┐    │        │    ┌──────────────────┐    │
│    │ desc  table      │◄───┼────────┼───►│ desc  table      │    │
│    │ avail ring       │    │        │    │ avail ring       │    │
│    │ used  ring       │    │        │    │ used  ring       │    │
│    └──────────────────┘    │        │    └──────────────────┘    │
│           │                │        │                            │
│    kick (PCI notify)  ─────┼────────┼──► process descriptors    │
│    ◄─── interrupt ─────────┼────────┼─── add to used ring       │
└────────────────────────────┘        └────────────────────────────┘
```

## The virtqueue / vring

A virtqueue is a split ring buffer with three regions in shared memory:

```c
/* include/uapi/linux/virtio_ring.h */

/* One descriptor: points to a buffer segment */
struct vring_desc {
    __virtio64 addr;   /* physical address (GPA) of buffer */
    __virtio32 len;    /* buffer length */
    __virtio16 flags;  /* VRING_DESC_F_NEXT | VRING_DESC_F_WRITE | VRING_DESC_F_INDIRECT */
    __virtio16 next;   /* index of next descriptor (if NEXT flag set) */
};

/* Available ring: driver (guest) adds here, device (host) reads */
struct vring_avail {
    __virtio16 flags;  /* VRING_AVAIL_F_NO_INTERRUPT: suppress interrupts */
    __virtio16 idx;    /* where driver will put next entry */
    __virtio16 ring[]; /* descriptor chain head indices */
};

/* Used ring: device (host) adds here, driver (guest) reads */
struct vring_used_elem {
    __virtio32 id;     /* index of used descriptor chain */
    __virtio32 len;    /* bytes written (for reads; 0 for writes) */
};

struct vring_used {
    __virtio16 flags;  /* VRING_USED_F_NO_NOTIFY: suppress kicks */
    __virtio16 idx;    /* where device will put next entry */
    struct vring_used_elem ring[];
};
```

This is the **split ring** layout — three separate regions (descriptor table, avail ring, used ring), the classic/default virtqueue format. Negotiating `VIRTIO_F_RING_PACKED` (see feature bits below) switches to the **packed ring** layout instead: a single combined ring of `struct vring_packed_desc` entries that fold descriptor, availability, and completion state into one cache-line-friendly structure, avoiding the split layout's three-region indirection.

### virtqueue lifecycle

```
Guest (driver side):                   Host (device side):

1. Allocate descriptors:
   desc[0].addr = buf_gpa
   desc[0].len  = 1500
   desc[0].flags = VRING_DESC_F_WRITE

2. Post to available ring:
   avail.ring[avail.idx] = 0 (desc #0)
   wmb()
   avail.idx++

3. Kick the host:
   iowrite16(queue_idx, notify_addr)
   → VM exit (PCI MMIO write)

                                       4. Host sees avail.idx changed
                                          Read desc[0] → DMA into buf

                                       5. Host posts to used ring:
                                          used.ring[used.idx] = {0, 1500}
                                          used.idx++
                                          send interrupt to guest

6. Guest interrupt handler:
   while (last_used != used.idx) {
       process used.ring[last_used]
       last_used++
   }
```

### Descriptor chaining

Large buffers (e.g., a 64KB network packet with header + payload) can be represented as a chain:

```
desc[0]: header   → flags = NEXT, next = 1
desc[1]: payload  → flags = WRITE, next = 0  (end of chain)
```

The host reads desc[0], follows `next` to desc[1], processes both as one logical buffer.

## virtio-net

```c
/* drivers/net/virtio_net.c */
struct virtnet_info {
    struct virtio_device    *vdev;
    struct virtqueue        *cvq;           /* control virtqueue */
    struct net_device       *dev;
    struct send_queue       *sq;            /* one per TX queue */
    struct receive_queue    *rq;            /* one per RX queue */
    unsigned int            max_queue_pairs;

    /* Offload features negotiated with host */
    bool                    mergeable_rx_bufs;
    bool                    has_rss;
};

/* TX path: enqueue packet (conceptual sketch — the real xmit_skb() in
 * drivers/net/virtio_net.c has grown to handle a whole family of header
 * variants, tunneling, and a header-push optimization; see below) */
static int xmit_skb(struct send_queue *sq, struct sk_buff *skb)
{
    struct virtio_net_hdr *hdr;
    struct virtnet_info *vi = sq->vq->vdev->priv;
    int num_sg;

    /* Prepend virtio_net header */
    hdr = skb_push(skb, vi->hdr_len);
    memset(hdr, 0, vi->hdr_len);

    /* Fill in checksum/GSO offload fields from the skb's own state */
    virtio_net_hdr_from_skb(skb, hdr, virtio_is_little_endian(vi->vdev), false, 0);

    /* Build scatter-gather list from skb frags */
    num_sg = skb_to_sgvec(skb, sq->sg, 0, skb->len);

    return virtqueue_add_outbuf(sq->vq, sq->sg, num_sg, skb, GFP_ATOMIC);
}
```

The real `xmit_skb()` (which now also takes an `orphan` flag) doesn't hand-roll the checksum/GSO logic shown above inline — that's factored into the `virtio_net_hdr_from_skb()` helper (`include/linux/virtio_net.h`), which is what actually sets `VIRTIO_NET_HDR_F_NEEDS_CSUM`/`csum_start`/`csum_offset` when `skb->ip_summed == CHECKSUM_PARTIAL`, and fills in GSO fields when the skb is a GSO packet. The real function also picks from several header variants depending on negotiated features — plain `struct virtio_net_hdr`, the mergeable-rx-buffers variant below, or (for the newer hash/tunnel offloads) `struct virtio_net_hdr_v1_hash_tunnel` — and enqueues through a `virtnet_add_outbuf()` wrapper rather than calling `virtqueue_add_outbuf()` directly. The sketch above keeps the core idea — prepend a header, let the skb's own checksum/GSO state drive it, hand the buffer to the ring — without the header-variant dispatch and TX batching logic.

### virtio-net header

```c
/* include/uapi/linux/virtio_net.h */
struct virtio_net_hdr {
    __u8       flags;       /* VIRTIO_NET_HDR_F_NEEDS_CSUM, etc. */
    __u8       gso_type;    /* VIRTIO_NET_HDR_GSO_TCPV4/6, etc. */
    __virtio16 hdr_len;     /* ethernet+IP+TCP header length */
    __virtio16 gso_size;    /* max segment size for GSO */
    __virtio16 csum_start;  /* offset to start of checksum */
    __virtio16 csum_offset; /* offset within csum_start to place checksum */
};

/* Negotiating VIRTIO_NET_F_MRG_RXBUF (below) adds one field on top —
 * still the live, current wire format for receive-side buffer merging: */
struct virtio_net_hdr_mrg_rxbuf {
    struct virtio_net_hdr hdr;
    __virtio16 num_buffers; /* number of merged RX buffers this packet spans */
};
```

These 16-bit fields are `__virtio16`, not a fixed-endian type — virtio's wire byte order depends on which VIRTIO_F_VERSION_1 mode was negotiated (modern devices are always little-endian; legacy ones use the guest's native order), so the header itself can't commit to `__le16` at the type level. This header lets the host/guest negotiate hardware offloads: checksum, segmentation (TSO), receive-side coalescing (LRO).

## virtio-blk

```c
/* include/uapi/linux/virtio_blk.h */
struct virtio_blk_outhdr {
    __virtio32 type;    /* VIRTIO_BLK_T_IN / T_OUT / T_FLUSH / T_DISCARD */
    __virtio32 ioprio;
    __virtio64 sector;  /* 512-byte sector number */
};

/* A complete I/O request descriptor chain:
   [0] virtio_blk_outhdr header (device-readable)
   [1] data buffer              (device-writable for read, device-readable for write)
   [2] status byte              (device-writable: VIRTIO_BLK_S_OK=0, S_IOERR=1, S_UNSUPP=2) */
```

### Why virtio-blk is fast

- One virtqueue per vCPU (multi-queue support)
- Guest batches multiple requests before kicking
- Host processes full batch, posts all completions
- With `VIRTIO_BLK_F_FLUSH`: explicit flush ordering

## Feature negotiation

virtio devices negotiate features before use:

```c
/* Guest reads host-supported features */
u64 host_features = vdev->config->get_features(vdev);

/* Guest decides what it wants */
u64 guest_features = 0;
if (host_features & (1ULL << VIRTIO_NET_F_CSUM))
    guest_features |= (1ULL << VIRTIO_NET_F_CSUM);   /* checksum offload */
if (host_features & (1ULL << VIRTIO_NET_F_MRG_RXBUF))
    guest_features |= (1ULL << VIRTIO_NET_F_MRG_RXBUF); /* mergeable RX */
if (host_features & (1ULL << VIRTIO_F_RING_PACKED))
    guest_features |= (1ULL << VIRTIO_F_RING_PACKED); /* packed ring layout */

/* Write accepted features back */
vdev->config->finalize_features(vdev);
```

Key feature bits:
```c
VIRTIO_F_VERSION_1         /* modern virtio (mandatory for new devices) */
VIRTIO_F_RING_PACKED       /* packed ring layout (avoids avail/used split) */
VIRTIO_F_IN_ORDER          /* host completes requests in order */
VIRTIO_NET_F_CSUM          /* checksum offload */
VIRTIO_NET_F_HOST_TSO4     /* TCP segmentation offload (IPv4) */
VIRTIO_NET_F_MRG_RXBUF     /* mergeable receive buffers */
VIRTIO_NET_F_RSS           /* receive-side scaling (multi-queue) */
VIRTIO_BLK_F_SEG_MAX       /* max segments per request */
VIRTIO_BLK_F_SIZE_MAX      /* max segment size */
VIRTIO_BLK_F_DISCARD       /* TRIM/discard support */
VIRTIO_BLK_F_WRITE_ZEROES  /* write-zeroes command */
```

## vhost-net: kernel-space acceleration

vhost-net moves the virtio-net backend from QEMU userspace into the kernel, eliminating the QEMU → host kernel round trip for each packet.

```
Without vhost-net:
  Guest → VM exit → KVM → wake QEMU → QEMU reads vring →
  QEMU writes to TAP fd → kernel TAP → network

With vhost-net:
  Guest → VM exit → KVM → vhost worker (kernel thread) →
  reads vring → writes to TAP directly (no QEMU in data path)
```

### vhost kernel internals

```c
/* drivers/vhost/net.c */
struct vhost_net {
    struct vhost_dev dev;           /* the generic vhost core (worker, iotlb, ...) */
    struct vhost_net_virtqueue vqs[VHOST_NET_VQ_MAX];
    /* ... */
};

struct vhost_dev {
    struct mm_struct *mm;           /* guest mm for GPA→HVA translation */
    struct mutex mutex;
    struct vhost_virtqueue **vqs;
    int nvqs;
    struct xarray worker_xa;        /* registry of this device's worker(s) */
    bool use_worker;
    /* ... */
};

/* Illustrative only — not a real function. The general vhost worker
 * pattern: read descriptors off the guest's avail ring, do the I/O,
 * post completions to the used ring, signal the guest. In
 * drivers/vhost/net.c this is spread across handle_tx() (a thin
 * dispatcher), get_tx_bufs(), and handle_tx_copy()/handle_tx_zerocopy(),
 * which add TX batching, XDP, and busy-polling this sketch leaves out: */
static void vhost_worker_tx_sketch(struct vhost_net *net, struct vhost_virtqueue *vq)
{
    unsigned int head;

    while ((head = vhost_get_vq_desc(vq, ...)) != vq->num) {
        /* GPA → HVA translation using guest mm */
        /* write to socket / TAP fd */
        vhost_add_used(vq, head, 0);
    }
    vhost_signal(&net->dev, vq);  /* interrupt guest */
}
```

`struct vhost_dev` used to own a single `struct task_struct *worker` directly; it's since been refactored so a device can register multiple workers (`worker_xa`, keyed for cases like per-vq worker assignment), created via `vhost_task_create()` rather than a raw kthread — the worker's `comm` is still `vhost-<owner-pid>`, so `pgrep vhost` (further down) still finds it.

### vhost-user: userspace vhost

vhost-user moves the backend to a separate userspace process (e.g., DPDK, OVS) using a Unix socket for control and shared memory for the rings:

```
Guest (KVM) ──► vring (shared memory) ◄── vhost-user process (DPDK/OVS)
                 ▲
          eventfd for kick/interrupt
```

Used by Open vSwitch + DPDK for line-rate switching without kernel involvement.

## virtio-mmio vs PCI transport

virtio devices are exposed over two transports:

| Transport | Usage | Discovery |
|-----------|-------|-----------|
| PCI | x86 VMs, standard | PCI config space scan |
| MMIO | ARM/embedded VMs, containers | Device tree / ACPI |

```bash
# In a Linux guest: see virtio devices
lspci | grep -i virtio
# 00:01.0 Ethernet controller: Red Hat, Inc. Virtio network device
# 00:02.0 SCSI storage controller: Red Hat, Inc. Virtio block device

# Or via virtio-mmio:
cat /proc/device-tree/virtio_mmio@*/compatible
# virtio,mmio
```

## Observing virtio performance

```bash
# In guest: virtio-net stats
ethtool -S eth0 | grep -E "queue|vq"

# virtio-blk device statistics
cat /sys/block/vda/stat

# vhost-net stats (on host)
cat /proc/net/dev   # TAP interface throughput

# Kick/interrupt frequency (low = batching, high = latency-sensitive):
# virtio/vring expose no debugfs or tracepoint interface for this, so
# count calls to the real kick/interrupt entry points directly instead:
perf probe -a virtqueue_notify
perf probe -a vring_interrupt
perf stat -e probe:virtqueue_notify,probe:vring_interrupt -a sleep 5

# perf: vhost worker CPU usage
perf top -p $(pgrep vhost)

# Interrupt coalescing: check if interrupts are suppressed
# (VRING_AVAIL_F_NO_INTERRUPT tells host not to interrupt guest)
```

## Further reading

### Kernel source

- [drivers/virtio/](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/virtio) — the virtio core bus: device registration and feature negotiation (`virtio_add_status()`)
- [drivers/virtio/virtio_ring.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/virtio/virtio_ring.c) — `virtqueue_add_outbuf()` and `virtqueue_kick()`: the split- and packed-ring implementation behind the vring diagrams above
- [include/uapi/linux/virtio_ring.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/virtio_ring.h) — `struct vring_desc`, `vring_avail`, `vring_used`: the on-the-wire descriptor/available/used ring layout
- [drivers/net/virtio_net.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/net/virtio_net.c) — the virtio-net driver: `struct virtnet_info`, `xmit_skb()`
- [include/linux/virtio_net.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/virtio_net.h) — `virtio_net_hdr_from_skb()`: fills the checksum/GSO offload fields `xmit_skb()` writes into the header
- [include/uapi/linux/virtio_net.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/virtio_net.h) — `struct virtio_net_hdr`, `struct virtio_net_hdr_mrg_rxbuf`, and the `VIRTIO_NET_F_*` feature bits
- [drivers/block/virtio_blk.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/block/virtio_blk.c) — the virtio-blk driver
- [include/uapi/linux/virtio_blk.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/virtio_blk.h) — `struct virtio_blk_outhdr` and the `VIRTIO_BLK_F_*` feature bits (`DISCARD`, `WRITE_ZEROES`, `FLUSH`)
- [drivers/vhost/net.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/vhost/net.c) — the vhost-net kernel backend: `struct vhost_net`, `handle_tx()` dispatching to `handle_tx_copy()`/`handle_tx_zerocopy()`
- [drivers/vhost/vhost.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/vhost/vhost.h) — `struct vhost_dev`: the generic vhost core shared by vhost-net, vhost-scsi, and vhost-vsock

### Related pages

- [KVM Architecture](kvm-arch.md) — VM exits, hypercalls
- [Memory Virtualization](kvm-memory.md) — EPT, balloon driver

### LWN articles

- [An API for virtual I/O: virtio](https://lwn.net/Articles/239238/) — LWN's 2007 coverage of Rusty Russell's introduction of virtio: the `add_buf()`/`sync()`/`get_buf()` operations vector that became the virtqueue, and worked examples from the block and network drivers
- [Standardizing virtio](https://lwn.net/Articles/580186/) — Jonathan Corbet, 2014: why virtio moved to OASIS standardization and what changed in the 1.0 specification (mandatory version feature bit, fixed little-endian byte order, flexible virtqueue memory layout)

### External

- [Virtual I/O Device (VIRTIO) Version 1.2](https://docs.oasis-open.org/virtio/virtio/v1.2/virtio-v1.2.html) — the OASIS committee specification: split and packed virtqueue formats, device types (net, block, and others), and the PCI/MMIO/CCW transports
- [Virtio on Linux](https://docs.kernel.org/driver-api/virtio/virtio.html) — kernel documentation for the virtio subsystem: the core bus, virtqueues, and transport drivers
- [Writing Virtio Drivers](https://docs.kernel.org/driver-api/virtio/writing_virtio_drivers.html) — kernel documentation covering `virtqueue_add_outbuf()`, `virtqueue_add_inbuf()`, `virtqueue_kick()`, and the driver probe/remove lifecycle
