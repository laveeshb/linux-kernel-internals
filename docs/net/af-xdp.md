# AF_XDP Sockets

> Sending and receiving packets directly to/from userspace with zero copies

## What AF_XDP is

AF_XDP is a socket address family that allows a userspace application to receive packets directly from an XDP program — bypassing the kernel network stack entirely for those packets. A BPF program running in XDP redirects matched packets to an AF_XDP socket, and the application reads them from a shared-memory ring buffer.

This achieves near-DPDK performance while staying within the kernel security model (no kernel bypass, kernel still owns the hardware).

## The architecture

```
NIC hardware → DMA → ring buffer
    ↓ (NAPI poll)
XDP program runs:
    if packet matches: bpf_redirect_map(&xsk_map, queue_id, 0) → XDP_REDIRECT
    else: XDP_PASS → normal kernel stack
    ↓
Shared UMEM (User Memory)
    ↓
AF_XDP socket (xsk) → userspace application reads/writes directly
```

No `sk_buff` is allocated. The packet DMA buffer is the same memory that userspace reads.

## UMEM: the shared memory region

AF_XDP is built around **UMEM** — a userspace-allocated memory region divided into fixed-size frames that both the kernel and userspace share:

```
UMEM:
┌──────┬──────┬──────┬──────┬──────┬──────┐
│frame0│frame1│frame2│frame3│frame4│frame5│ ...
└──────┴──────┴──────┴──────┴──────┴──────┘
Each frame: configurable size (default 4096 bytes)
```

Four ring buffers mediate ownership of frames between kernel and userspace:

| Ring | Direction | Who produces | Who consumes |
|------|-----------|--------------|--------------|
| FILL | RX: give frames to kernel | Userspace | Kernel (DMA target) |
| RX | RX: kernel delivers packets | Kernel | Userspace |
| TX | TX: userspace sends packets | Userspace | Kernel |
| COMPLETION | TX: kernel signals sent | Kernel | Userspace |

## Setting up an AF_XDP socket

```c
// 1. Create UMEM (shared memory)
int umem_size = 4096 * NUM_FRAMES;  // NUM_FRAMES of 4096 bytes each
void *umem_area = mmap(NULL, umem_size, PROT_READ|PROT_WRITE,
                       MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB, -1, 0);

struct xdp_umem_reg mr = {
    .addr = (uint64_t)umem_area,
    .len  = umem_size,
    .chunk_size = 4096,
    .headroom   = 0,
};

// 2. Create AF_XDP socket
int xsk_fd = socket(AF_XDP, SOCK_RAW, 0);

// 3. Register UMEM with socket
setsockopt(xsk_fd, SOL_XDP, XDP_UMEM_REG, &mr, sizeof(mr));

// 4. Set up ring sizes
int ring_size = 2048;
setsockopt(xsk_fd, SOL_XDP, XDP_RX_RING,   &ring_size, sizeof(ring_size));
setsockopt(xsk_fd, SOL_XDP, XDP_TX_RING,   &ring_size, sizeof(ring_size));
setsockopt(xsk_fd, SOL_XDP, XDP_UMEM_FILL_RING,      &ring_size, sizeof(ring_size));
setsockopt(xsk_fd, SOL_XDP, XDP_UMEM_COMPLETION_RING,&ring_size, sizeof(ring_size));

// 5. Map rings into userspace
struct xdp_mmap_offsets off;
getsockopt(xsk_fd, SOL_XDP, XDP_MMAP_OFFSETS, &off, &optlen);

void *fill_ring = mmap(NULL, off.fr.desc + ring_size * sizeof(__u64),
                       PROT_READ|PROT_WRITE, MAP_SHARED|MAP_POPULATE,
                       xsk_fd, XDP_UMEM_PGOFF_FILL_RING);
// Similar for rx_ring, tx_ring, completion_ring

// 6. Bind to interface and queue
struct sockaddr_xdp sxdp = {
    .sxdp_family    = AF_XDP,
    .sxdp_ifindex   = ifindex,
    .sxdp_queue_id  = queue_id,
    .sxdp_flags     = XDP_COPY,  // or XDP_ZEROCOPY for optimal performance
};
bind(xsk_fd, (struct sockaddr *)&sxdp, sizeof(sxdp));
```

## Zero-copy mode

In **zero-copy** mode (`XDP_ZEROCOPY`), the NIC DMA-writes packets directly into the UMEM frames. No data copying occurs between NIC, kernel, and userspace. Requires:
- Driver support (i40e, mlx5, ixgbe, etc.)
- UMEM frames pinned in memory

In **copy mode** (`XDP_COPY`), the kernel copies packet data from its internal buffers to UMEM. Works on any NIC but adds a copy.

## Receiving packets (RX loop)

```c
// Fill ring with addresses of free frames (give to kernel for DMA)
for (int i = 0; i < NUM_FRAMES; i++) {
    fill_ring->addrs[fill_prod_idx % ring_size] = i * FRAME_SIZE;
    fill_prod_idx++;
}
// Update fill ring producer index
__atomic_store_n(fill_ring->producer, fill_prod_idx, __ATOMIC_RELEASE);

// Poll for received packets
struct pollfd pfd = { .fd = xsk_fd, .events = POLLIN };
poll(&pfd, 1, -1);

// Read from RX ring
uint32_t rx_idx = *rx_ring->consumer;
uint32_t avail  = *rx_ring->producer - rx_idx;

for (uint32_t i = 0; i < avail; i++) {
    struct xdp_desc *desc = &rx_ring->descs[(rx_idx + i) % ring_size];
    void *pkt = umem_area + desc->addr;
    uint32_t len = desc->len;
    // Process packet at pkt[0..len-1]
    // Then return the frame to fill ring
}
*rx_ring->consumer = rx_idx + avail;
```

## The XDP program (kernel side)

```c
struct {
    __uint(type, BPF_MAP_TYPE_XSKMAP);
    __uint(max_entries, 64);
    __type(key, __u32);    // queue index
    __type(value, __u32);  // xsk socket fd
} xsk_map SEC(".maps");

SEC("xdp")
int xdp_redirect_to_xsk(struct xdp_md *ctx)
{
    // Redirect all packets on this queue to the AF_XDP socket
    return bpf_redirect_map(&xsk_map, ctx->rx_queue_index, XDP_PASS);
    // XDP_PASS as fallback: if no xsk registered for this queue, pass to stack
}
```

```bash
# Register xsk socket in the XSKMAP
bpftool map update id <xskmap_id> key 0 value <xsk_fd>
```

## libxdp / libbpf helper library

For production use, `libxdp` (part of xdp-tools) and `libbpf` provide abstractions that handle the ring management, UMEM setup, and XDP program loading:

```c
// With libxdp
#include <xdp/xsk.h>

struct xsk_socket_config cfg = {
    .rx_size     = 2048,
    .tx_size     = 2048,
    .libxdp_flags = XSK_LIBXDP_FLAGS__INHIBIT_PROG_LOAD,
    .xdp_flags   = XDP_FLAGS_UPDATE_IF_NOEXIST,
    .bind_flags  = XDP_ZEROCOPY,
};

struct xsk_umem *umem;
struct xsk_socket *xsk;

xsk_umem__create(&umem, umem_area, umem_size, fill_ring, comp_ring, NULL);
xsk_socket__create(&xsk, ifname, queue_id, umem, rx_ring, tx_ring, &cfg);
```

## Use cases

- **Kernel bypass for application protocols**: Handle DNS/HTTP packet parsing in userspace at line rate
- **Packet capture**: Zero-copy alternative to libpcap for high-rate captures
- **Custom load balancers**: User-space decision logic with kernel-speed I/O
- **Network function virtualization**: Virtual switches, firewalls without full DPDK

## Further reading

- [XDP](xdp.md) — The XDP framework that feeds AF_XDP sockets
- [Network Device and NAPI](napi.md) — Where XDP programs hook into the driver
- [TC and qdisc](tc-qdisc.md) — Alternative for post-stack packet steering
