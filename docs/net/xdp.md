# XDP: eXpress Data Path

> Kernel bypass at the driver level: BPF programs on the receive fast path

## What is XDP?

XDP (eXpress Data Path) runs a BPF program at the earliest possible point in the kernel network stack — inside the NIC driver, **before** skb allocation. This achieves near-DPDK speeds while staying in the kernel:

```
Packet arrival:

Without XDP:
  NIC → DMA → driver alloc skb → kernel stack → socket → userspace
  Latency: ~1-5µs, throughput: limited by skb overhead

With XDP:
  NIC → DMA → XDP BPF program → (pass/drop/tx/redirect)
  Latency: ~100-200ns, throughput: 10-50+ Mpps (million packets/sec)

DPDK (comparison):
  NIC → userspace poll → DPDK app
  Latency: ~50-100ns, throughput: 60+ Mpps
  But: requires dedicated CPUs, no kernel network stack
```

## XDP hook points

```c
/* Three attachment modes: */

/* 1. Native XDP (fastest): runs in driver's RX path */
/*    Supported by: mlx5, i40e, ixgbe, bpfilter, veth, etc. */
ip link set eth0 xdp obj xdp_prog.o sec xdp

/* 2. Generic XDP (skb-based): works on any driver, slower */
/*    Runs after skb allocation, in netif_receive_skb() */
ip link set eth0 xdpgeneric obj xdp_prog.o sec xdp

/* 3. HW offload: runs on the NIC itself (very few NICs) */
ip link set eth0 xdpoffload obj xdp_prog.o sec xdp
```

## XDP verdicts

```c
/* BPF program returns one of these: */

XDP_DROP      /* Drop the packet immediately (no skb alloc, no notification) */
XDP_PASS      /* Continue normal kernel processing (alloc skb, pass up stack) */
XDP_TX        /* Retransmit on the same interface (e.g., for reflection) */
XDP_REDIRECT  /* Forward to another interface, CPU, or AF_XDP socket */
XDP_ABORTED   /* Drop + trace point for debugging (treated like DROP) */
```

## XDP program structure

```c
/* xdp_prog.c */
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <linux/if_ether.h>
#include <linux/ip.h>

/* BPF map: track per-source-IP packet counts */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);    /* source IP */
    __type(value, __u64);  /* packet count */
    __uint(max_entries, 65536);
} ip_counter SEC(".maps");

/* Blocklist map */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);    /* blocked IP */
    __type(value, __u8);
    __uint(max_entries, 1024);
} blocklist SEC(".maps");

SEC("xdp")
int xdp_firewall(struct xdp_md *ctx)
{
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    /* Parse Ethernet header */
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_DROP;   /* truncated packet */

    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;   /* not IPv4, pass to stack */

    /* Parse IP header */
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_DROP;

    __u32 src_ip = ip->saddr;

    /* Check blocklist */
    if (bpf_map_lookup_elem(&blocklist, &src_ip))
        return XDP_DROP;   /* blocked: drop silently */

    /* Count packets per source IP */
    __u64 *count = bpf_map_lookup_elem(&ip_counter, &src_ip);
    if (count) {
        __sync_fetch_and_add(count, 1);
    } else {
        __u64 one = 1;
        bpf_map_update_elem(&ip_counter, &src_ip, &one, BPF_ANY);
    }

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

```bash
# Compile:
clang -O2 -target bpf -c xdp_prog.c -o xdp_prog.o

# Attach:
ip link set eth0 xdp obj xdp_prog.o sec xdp

# Check:
ip link show eth0
# 2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 xdp ...
#     xdp id 42    ← program loaded

# Detach:
ip link set eth0 xdp off
```

## Packet modification (NAT)

```c
SEC("xdp")
int xdp_dnat(struct xdp_md *ctx)
{
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;
    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    /* Rewrite destination IP (save old value first for checksum diff) */
    __u32 old_dst = ip->daddr;
    __u32 new_dst = bpf_htonl(0xc0a80101);  /* 192.168.1.1 */
    ip->daddr = new_dst;

    /* Recompute IP checksum inline (bpf_l3_csum_replace/bpf_l4_csum_replace
     * and bpf_csum_diff are TC-only helpers not available in XDP programs;
     * use incremental checksum update via RFC 1624): */
    __u32 csum_diff = (~old_dst & 0xffff) + (~old_dst >> 16) +
                      (new_dst & 0xffff) + (new_dst >> 16);
    __u16 csum = (~ntohs(ip->check) & 0xffff) + (csum_diff & 0xffff) +
                  (csum_diff >> 16);
    ip->check = htons(~(csum + (csum >> 16)));

    return XDP_PASS;  /* or XDP_TX to send back */
}
```

## XDP redirect

### Between interfaces

```c
/* Redirect packet to eth1: */
SEC("xdp")
int xdp_redirect_iface(struct xdp_md *ctx)
{
    int ifindex = 3;  /* eth1's ifindex */
    return bpf_redirect(ifindex, 0);
}
```

### DEVMAP: batch redirect

```c
/* High-performance redirect via devmap */
struct {
    __uint(type, BPF_MAP_TYPE_DEVMAP);
    __uint(key_size, sizeof(int));
    __uint(value_size, sizeof(int));
    __uint(max_entries, 256);
} tx_ports SEC(".maps");

SEC("xdp")
int xdp_devmap_redirect(struct xdp_md *ctx)
{
    int port = 0;  /* devmap key */
    return bpf_redirect_map(&tx_ports, port, XDP_DROP);
}
```

```bash
# Populate devmap (userspace):
int map_fd = bpf_obj_get("/sys/fs/bpf/tx_ports");
int ifindex = if_nametoindex("eth1");
bpf_map_update_elem(map_fd, &key, &ifindex, BPF_ANY);
```

### CPUMAP: steer to specific CPU

```c
/* Redirect to CPU for further processing (after XDP) */
struct {
    __uint(type, BPF_MAP_TYPE_CPUMAP);
    __uint(key_size, sizeof(__u32));
    __uint(value_size, sizeof(struct bpf_cpumap_val));
    __uint(max_entries, 12);
} cpumap SEC(".maps");

SEC("xdp")
int xdp_cpumap_redirect(struct xdp_md *ctx)
{
    /* RSS-based steering: hash to CPU */
    __u32 cpu = bpf_get_smp_processor_id() % 4;
    return bpf_redirect_map(&cpumap, cpu, 0);
}
```

## AF_XDP: zero-copy to userspace

AF_XDP (eXpress Data Path socket) moves packets directly to userspace memory without any kernel copying:

```
NIC DMA → UMEM (userspace memory) → XSK socket → userspace app
          ↑ zero copy! kernel never touches packet data
```

### Setup

```c
/* Userspace: create AF_XDP socket */
#include <linux/if_xdp.h>
#include <sys/socket.h>

/* 1. Allocate UMEM (packet buffer pool): */
void *umem_area = mmap(NULL, UMEM_SIZE, PROT_READ|PROT_WRITE,
                        MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB, -1, 0);

struct xdp_umem_reg umem_reg = {
    .addr = (uint64_t)umem_area,
    .len  = UMEM_SIZE,
    .chunk_size = FRAME_SIZE,    /* 4096 bytes per frame */
    .headroom   = 0,
};
setsockopt(xsk_fd, SOL_XDP, XDP_UMEM_REG, &umem_reg, sizeof(umem_reg));

/* 2. Create rings (FILL/COMPLETION/RX/TX): */
int ring_size = 2048;
setsockopt(xsk_fd, SOL_XDP, XDP_RX_RING, &ring_size, sizeof(ring_size));
setsockopt(xsk_fd, SOL_XDP, XDP_UMEM_FILL_RING, &ring_size, sizeof(ring_size));

/* 3. mmap the rings: */
struct xdp_mmap_offsets off;
getsockopt(xsk_fd, SOL_XDP, XDP_MMAP_OFFSETS, &off, &optlen);

void *fill_ring = mmap(NULL, off.fr.desc + ring_size * sizeof(uint64_t),
                        PROT_READ|PROT_WRITE, MAP_SHARED|MAP_POPULATE,
                        xsk_fd, XDP_UMEM_PGOFF_FILL_RING);

/* 4. Bind to interface queue: */
struct sockaddr_xdp sxdp = {
    .sxdp_family   = AF_XDP,
    .sxdp_ifindex  = if_nametoindex("eth0"),
    .sxdp_queue_id = 0,           /* NIC queue 0 */
    .sxdp_flags    = XDP_ZEROCOPY, /* requires native XDP driver support */
};
bind(xsk_fd, (struct sockaddr *)&sxdp, sizeof(sxdp));
```

### XDP program for AF_XDP redirect

```c
/* BPF map of AF_XDP sockets */
struct {
    __uint(type, BPF_MAP_TYPE_XSKMAP);
    __uint(key_size, sizeof(int));
    __uint(value_size, sizeof(int));
    __uint(max_entries, 64);
} xsks_map SEC(".maps");

SEC("xdp")
int xdp_sock_prog(struct xdp_md *ctx)
{
    int index = ctx->rx_queue_index;

    /* Redirect to AF_XDP socket on same queue */
    if (bpf_map_lookup_elem(&xsks_map, &index))
        return bpf_redirect_map(&xsks_map, index, 0);

    return XDP_PASS;
}
```

## XDP vs alternatives

| | XDP | DPDK | kernel TC | iptables |
|---|-----|------|-----------|----------|
| Throughput | 50+ Mpps | 60+ Mpps | 10+ Mpps | 1-5 Mpps |
| Latency | ~200ns | ~100ns | ~1µs | ~10µs |
| Kernel stack access | Yes (XDP_PASS) | No | Yes | Yes |
| CPU dedication | No | Yes | No | No |
| Programmability | BPF | C | BPF/C | limited |
| Use case | DDoS mitigation, LB, firewall | High-freq trading, NFV | QoS, TC filter | Generic firewall |

## Observability

```bash
# XDP program info:
bpftool net show dev eth0
# xdp:
#         id 42  name xdp_firewall  flags 0x0

# XDP stats (via driver):
ethtool -S eth0 | grep xdp
# rx_xdp_drop: 1234567
# rx_xdp_pass: 9876543
# rx_xdp_tx:          0
# rx_xdp_redirect:    0

# BPF map inspection:
bpftool map dump id 5   # dump blocklist map

# XDP program tracing:
bpftrace -e '
tracepoint:xdp:xdp_exception
{ printf("XDP exception: ifindex=%d, prog_id=%d, act=%d\n",
         args->ifindex, args->prog_id, args->act); }'

# Perf event for XDP drop:
perf record -e xdp:xdp_drop -ag -- sleep 10
perf script
```

## Further reading

- [BPF Networking](../bpf/bpf-networking.md) — TC BPF, sockmap
- [sk_buff: The Network Buffer](sk-buff.md) — XDP_PASS creates sk_buff
- [NVMe Driver](../block/nvme.md) — similar DMA/ring buffer pattern
- [IRQ Affinity](../interrupts/irq-affinity.md) — NIC queue/CPU affinity for XDP
- `net/core/filter.c` — BPF network filter infrastructure
- `drivers/net/ethernet/intel/i40e/i40e_xsk.c` — XDP in i40e driver
- `samples/bpf/xdpsock_user.c` — AF_XDP userspace example
- `tools/lib/bpf/xsk.c` — libbpf AF_XDP helper
