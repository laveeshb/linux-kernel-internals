# XDP (eXpress Data Path)

> High-performance packet processing before the kernel network stack

## What XDP is

XDP is a programmable, high-performance packet processing framework that runs eBPF programs **before the kernel allocates `sk_buff`**. It's attached to a network device and invoked by the NIC driver (or the kernel) for every incoming packet.

XDP eliminates the main overhead sources of traditional kernel packet processing:
- **No `sk_buff` allocation**: Operates directly on DMA-mapped packet memory
- **No per-packet memory allocation**: Uses pre-allocated per-CPU buffers
- **No lock contention**: Each CPU processes its own RX queue independently

This enables packet rates of tens of millions of packets per second on a single core.

## XDP actions (return codes)

An XDP program examines the packet and returns one of five actions:

```c
// include/uapi/linux/bpf.h
enum xdp_action {
    XDP_ABORTED = 0,  // BPF error: drop + trace event
    XDP_DROP,         // Drop the packet immediately
    XDP_PASS,         // Pass to normal kernel network stack
    XDP_TX,           // Transmit back out the same NIC (hairpin)
    XDP_REDIRECT,     // Redirect to another NIC, CPU, or AF_XDP socket
};
```

## struct xdp_md — the BPF program's context

XDP programs see the packet through `struct xdp_md`:

```c
// include/uapi/linux/bpf.h
struct xdp_md {
    __u32 data;           // pointer to packet start (cast to void*)
    __u32 data_end;       // pointer to packet end
    __u32 data_meta;      // pointer to metadata area (before data)
    __u32 ingress_ifindex; // receiving interface index
    __u32 rx_queue_index;  // RX queue number
    __u32 egress_ifindex;  // for XDP_REDIRECT: target interface
};
```

The underlying kernel structure is `struct xdp_buff`:

```c
// include/net/xdp.h
struct xdp_buff {
    void *data;           // packet start
    void *data_end;       // packet end
    void *data_meta;      // metadata area
    void *data_hard_start; // start of DMA buffer (headroom before data)
    struct xdp_rxq_info *rxq; // RX queue info (device, queue index)
    u32   frame_sz;       // total frame size
    u32   flags;
};
```

## A minimal XDP program

```c
// Drop all UDP traffic
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>

SEC("xdp")
int xdp_drop_udp(struct xdp_md *ctx)
{
    void *data = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    struct ethhdr *eth = data;
    if ((void*)(eth + 1) > data_end)
        return XDP_PASS;

    if (eth->h_proto != htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *iph = (void*)(eth + 1);
    if ((void*)(iph + 1) > data_end)
        return XDP_PASS;

    if (iph->protocol == IPPROTO_UDP)
        return XDP_DROP;

    return XDP_PASS;
}

char _license[] SEC("license") = "GPL";
```

## Attaching XDP programs

```bash
# Compile
clang -O2 -target bpf -c xdp_drop_udp.c -o xdp_drop_udp.o

# Attach to interface (native mode: highest performance)
ip link set dev eth0 xdp obj xdp_drop_udp.o sec xdp

# Check it's attached
ip link show eth0
# → link/ether ... xdp (id 42, flags <XDP_FLAGS_SKB_MODE>)

# Remove
ip link set dev eth0 xdp off

# With bpftool
bpftool net attach xdp id 42 dev eth0
bpftool net show dev eth0
```

## XDP operation modes

```bash
# Native/driver mode (fastest): program runs in NIC driver's NAPI poll
ip link set dev eth0 xdp obj prog.o

# Generic/SKB mode (any NIC, slower): runs after sk_buff allocation
ip link set dev eth0 xdpgeneric obj prog.o

# Hardware offload (smartNICs: Netronome, etc.): runs on NIC hardware
ip link set dev eth0 xdpoffload obj prog.o
```

| Mode | Performance | NIC requirement | When to use |
|------|-------------|-----------------|-------------|
| Native | Highest | Driver support | Production DDoS mitigation, load balancing |
| Generic | Moderate | Any NIC | Development, NICs without XDP support |
| HW Offload | Maximum | Smartcard NIC | Extreme performance (line-rate 100G) |

## XDP_REDIRECT: steering to other destinations

`XDP_REDIRECT` is the most powerful action, allowing redirection to:

```c
// Redirect to another NIC
bpf_redirect(ifindex, 0);

// Redirect to a CPU (via CPUMAP)
bpf_redirect_map(&cpu_map, target_cpu, 0);

// Redirect to AF_XDP socket (for userspace packet processing)
bpf_redirect_map(&xsk_map, queue_id, 0);
```

### BPF maps for redirection

```c
// DEVMAP: redirect to another NIC
struct {
    __uint(type, BPF_MAP_TYPE_DEVMAP);
    __uint(max_entries, 256);
    __type(key, __u32);    // ifindex
    __type(value, __u32);  // destination ifindex
} tx_port SEC(".maps");

// CPUMAP: send to a specific CPU's RX queue
struct {
    __uint(type, BPF_MAP_TYPE_CPUMAP);
    __uint(max_entries, 16);
    __type(key, __u32);     // CPU id
    __type(value, struct bpf_cpumap_val); // queue size + optional XDP prog
} cpu_map SEC(".maps");
```

## Common XDP use cases

### DDoS mitigation

```c
// Drop packets from known attack sources (BPF map lookup)
struct {
    __uint(type, BPF_MAP_TYPE_LPM_TRIE);
    __type(key, struct bpf_lpm_trie_key_u8);
    __type(value, __u64);  // drop counter
} blocklist SEC(".maps");

SEC("xdp")
int xdp_ddos_filter(struct xdp_md *ctx)
{
    struct iphdr *iph = parse_iphdr(ctx);
    if (!iph) return XDP_PASS;

    struct bpf_lpm_trie_key_u8 key = { .prefixlen = 32 };
    *((__u32 *)key.data) = iph->saddr;

    if (bpf_map_lookup_elem(&blocklist, &key))
        return XDP_DROP;

    return XDP_PASS;
}
```

### Load balancing

```c
// XDP load balancer: forward to backend servers via XDP_TX
// (used by Facebook's Katran, Cloudflare's layer4 load balancer)
```

### Packet sampling

```c
// Sample 1 in 1000 packets to userspace via perf ring buffer
if (bpf_get_prandom_u32() % 1000 == 0) {
    bpf_perf_event_output(ctx, &events, BPF_F_CURRENT_CPU,
                          data, data_end - data);
}
return XDP_PASS;
```

## Statistics and observability

```bash
# XDP program statistics
bpftool prog show
bpftool prog dump xlated id 42  # show XDP bytecode

# Count XDP drops (per-CPU)
bpftool map dump id <map_id>

# ethtool XDP stats
ethtool -S eth0 | grep xdp
# rx_xdp_drop: 12345
# rx_xdp_redirect: 0
# rx_xdp_pass: 67890

# Trace XDP events
perf record -e xdp:xdp_exception -ag sleep 10
trace-cmd record -e xdp:xdp_bulk_tx -e xdp:xdp_redirect_err
```

## Performance comparison

At 40 Gbps with small packets:

| Path | Mpps/core | Notes |
|------|-----------|-------|
| Kernel TCP stack | ~1-2 | Full stack processing |
| DPDK (userspace) | ~20-30 | Kernel bypass |
| XDP native | ~20-25 | In-kernel, no copy |
| XDP HW offload | ~80+ | NIC handles it |

## Further reading

- [AF_XDP Sockets](af-xdp.md) — Sending XDP-processed packets to userspace
- [Network Device and NAPI](napi.md) — Where XDP hooks into the driver
- [TC and qdisc](tc-qdisc.md) — Alternative packet steering (post-stack)
- [Netfilter Architecture](netfilter.md) — The older hook-based alternative
