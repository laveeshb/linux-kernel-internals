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

/* TX path: enqueue packet */
static int xmit_skb(struct send_queue *sq, struct sk_buff *skb)
{
    struct virtio_net_hdr_mrg_rxbuf *hdr;
    const unsigned char *dest = ((struct ethhdr *)skb->data)->h_dest;
    struct virtnet_info *vi = sq->vq->vdev->priv;
    int num_sg;

    /* Prepend virtio_net header */
    hdr = skb_push(skb, vi->hdr_len);
    memset(hdr, 0, vi->hdr_len);

    /* If TSO/checksum offload: set flags in hdr */
    if (skb->ip_summed == CHECKSUM_PARTIAL) {
        hdr->hdr.flags   = VIRTIO_NET_HDR_F_NEEDS_CSUM;
        hdr->hdr.csum_offset = skb->csum_offset;
        hdr->hdr.csum_start  = skb_checksum_start_offset(skb);
    }

    /* Build scatter-gather list from skb frags */
    num_sg = skb_to_sgvec(skb, sq->sg, 0, skb->len);

    return virtqueue_add_outbuf(sq->vq, sq->sg, num_sg, skb, GFP_ATOMIC);
}
```

### virtio-net header

```c
/* include/uapi/linux/virtio_net.h */
struct virtio_net_hdr {
    __u8  flags;       /* VIRTIO_NET_HDR_F_NEEDS_CSUM, etc. */
    __u8  gso_type;    /* VIRTIO_NET_HDR_GSO_TCPV4/6, etc. */
    __le16 hdr_len;    /* ethernet+IP+TCP header length */
    __le16 gso_size;   /* max segment size for GSO */
    __le16 csum_start; /* offset to start of checksum */
    __le16 csum_offset;/* offset within csum_start to place checksum */
};
```

This header lets the host/guest negotiate hardware offloads: checksum, segmentation (TSO), receive-side coalescing (LRO).

## virtio-blk

```c
/* include/uapi/linux/virtio_blk.h */
struct virtio_blk_req {
    __virtio32 type;    /* VIRTIO_BLK_T_IN / T_OUT / T_FLUSH / T_DISCARD */
    __virtio32 ioprio;
    __virtio64 sector;  /* 512-byte sector number */
};

/* A complete I/O request descriptor chain:
   [0] virtio_blk_req header  (device-readable)
   [1] data buffer            (device-writable for read, device-readable for write)
   [2] status byte            (device-writable: 0=success, 1=error, 2=unsupported) */
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
    struct vhost_dev dev;           /* owns vhost worker thread */
    struct vhost_net_virtqueue vqs[VHOST_NET_VQ_MAX];
    /* ... */
};

struct vhost_dev {
    struct mm_struct *mm;           /* guest mm for GPA→HVA translation */
    struct mutex mutex;
    struct vhost_virtqueue **vqs;
    int nvqs;
    struct task_struct *worker;     /* kernel thread doing I/O */
    /* ... */
};

/* vhost worker: polls virtqueue, processes TX/RX */
static void handle_tx(struct vhost_net *net)
{
    struct vhost_net_virtqueue *nvq = &net->vqs[VHOST_NET_VQ_TX];
    struct vhost_virtqueue *vq = &nvq->vq;

    /* Read from guest avail ring */
    while ((head = vhost_get_vq_desc(vq, ...)) != vq->num) {
        /* GPA → HVA translation using guest mm */
        /* write to socket / TAP fd */
        vhost_add_used(vq, head, 0);
    }
    vhost_signal(&net->dev, vq);  /* interrupt guest */
}
```

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

# Kick/interrupt frequency (low = batching, high = latency-sensitive)
cat /sys/kernel/debug/virtio*/virtqueue*/avail_idx
cat /sys/kernel/debug/virtio*/virtqueue*/used_idx

# perf: vhost worker CPU usage
perf top -p $(pgrep vhost)

# Interrupt coalescing: check if interrupts are suppressed
# (VRING_AVAIL_F_NO_INTERRUPT tells host not to interrupt guest)
```

## Further reading

- [KVM Architecture](kvm-arch.md) — VM exits, hypercalls
- [Memory Virtualization](kvm-memory.md) — EPT, balloon driver
- `drivers/virtio/` in the kernel tree — virtio core bus
- `drivers/net/virtio_net.c` — virtio-net driver
- `drivers/block/virtio_blk.c` — virtio-blk driver
- `drivers/vhost/` — vhost-net kernel backend
- virtio specification: https://docs.oasis-open.org/virtio/virtio/v1.2/
