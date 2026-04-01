# BPF Networking Programs

> TC, cgroup, and socket BPF programs for network control

## BPF program types for networking

| Program type | Attach point | Can modify packet | Can drop | Use case |
|-------------|-------------|-----------------|---------|---------|
| `XDP` | NIC driver | Yes | Yes | DDoS mitigation, load balancing |
| `SCHED_CLS` (tc) | Traffic control qdisc | Yes | Yes | L3/L4 policies, encapsulation |
| `SCHED_ACT` (tc action) | TC action | Yes | Yes | Direct action mode |
| `CGROUP_SKB` | cgroup ingress/egress | Limited | Yes | Container network policy |
| `CGROUP_SOCK` | socket creation | No | Yes | Socket-level control |
| `SK_SKB` | sockmap | Yes | Yes | Socket redirection |
| `SK_MSG` | sockmap (sendmsg) | Yes | Yes | Message-level redirection |
| `SOCKET_FILTER` | Raw socket | Read-only | Yes | Packet capture (tcpdump) |

## TC BPF: traffic control programs

TC BPF programs attach to the `clsact` qdisc (classless act), which can run BPF at ingress and egress hooks before and after the network stack.

```bash
# Attach a BPF program at TC ingress
ip link add dev eth0 clsact
tc filter add dev eth0 ingress bpf da obj my_prog.o sec tc_ingress
# "da" = direct action mode (BPF returns TC_ACT_* verdict directly)

# Attach at egress
tc filter add dev eth0 egress bpf da obj my_prog.o sec tc_egress

# List attached programs
tc filter show dev eth0 ingress
tc filter show dev eth0 egress
```

### TC BPF program structure

```c
#include <vmlinux.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>
#include <linux/pkt_cls.h>  /* TC_ACT_* */

/* Verdict codes */
/* TC_ACT_OK      (0): pass packet */
/* TC_ACT_SHOT    (2): drop packet */
/* TC_ACT_REDIRECT(7): redirect to another interface */
/* TC_ACT_UNSPEC (-1): defer to next filter */

SEC("tc")
int tc_ingress(struct __sk_buff *skb)
{
    void *data     = (void *)(long)skb->data;
    void *data_end = (void *)(long)skb->data_end;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return TC_ACT_OK;

    /* Only handle IPv4 */
    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return TC_ACT_OK;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return TC_ACT_OK;

    /* Drop traffic from a specific source IP */
    if (ip->saddr == bpf_htonl(0xC0A80101))  /* 192.168.1.1 */
        return TC_ACT_SHOT;

    return TC_ACT_OK;
}
```

### Packet modification with TC BPF

TC BPF programs can modify packets using helpers:

```c
SEC("tc")
int tc_nat(struct __sk_buff *skb)
{
    void *data     = (void *)(long)skb->data;
    void *data_end = (void *)(long)skb->data_end;

    struct iphdr *ip = data + sizeof(struct ethhdr);
    if ((void *)(ip + 1) > data_end)
        return TC_ACT_OK;

    /* Rewrite destination IP (DNAT) */
    __be32 new_daddr = bpf_htonl(0x0A000001);  /* 10.0.0.1 */
    if (ip->daddr != bpf_htonl(0x0A000002))
        return TC_ACT_OK;

    /* Update IP header, fix checksum */
    bpf_l3_csum_replace(skb, ETH_HLEN + offsetof(struct iphdr, check),
                          ip->daddr, new_daddr, sizeof(new_daddr));
    bpf_skb_store_bytes(skb, ETH_HLEN + offsetof(struct iphdr, daddr),
                         &new_daddr, sizeof(new_daddr), 0);

    return TC_ACT_OK;
}
```

### TC redirect to another interface

```c
struct {
    __uint(type, BPF_MAP_TYPE_DEVMAP);
    __uint(max_entries, 128);
    __uint(key_size, sizeof(u32));
    __uint(value_size, sizeof(u32));
} tx_port SEC(".maps");

SEC("tc")
int tc_redirect(struct __sk_buff *skb)
{
    /* Redirect packet to interface index 5 */
    return bpf_redirect(5, 0);  /* ifindex, flags */
}
```

## Cgroup BPF: per-container network policy

Cgroup BPF programs attach to a cgroup and affect all sockets/packets within that cgroup hierarchy. Used by container runtimes (Kubernetes, containerd) for network policy.

### BPF_CGROUP_INET_INGRESS/EGRESS: packet filtering

```c
SEC("cgroup_skb/ingress")
int cgroup_ingress(struct __sk_buff *skb)
{
    /* Called for every packet received by any socket in this cgroup */
    /* Return 1: pass, 0: drop */

    /* Block inbound traffic to port 8080 */
    if (skb->protocol == bpf_htons(ETH_P_IP)) {
        struct iphdr *ip = (void *)(long)skb->data + ETH_HLEN;
        if ((void *)(ip + 1) > (void *)(long)skb->data_end)
            return 1;

        if (ip->protocol == IPPROTO_TCP) {
            struct tcphdr *tcp = (void *)(ip + 1);
            if ((void *)(tcp + 1) > (void *)(long)skb->data_end)
                return 1;
            if (tcp->dest == bpf_htons(8080))
                return 0;  /* drop */
        }
    }
    return 1;  /* pass */
}
```

```bash
# Attach to a cgroup
bpftool prog load cgroup_filter.o /sys/fs/bpf/cgroup_filter

bpftool cgroup attach /sys/fs/cgroup/system.slice/mycontainer.scope \
    ingress pinned /sys/fs/bpf/cgroup_filter

# List attached programs
bpftool cgroup tree /sys/fs/cgroup/system.slice/
```

### BPF_CGROUP_SOCK_OPS: TCP socket option control

```c
SEC("sockops")
int bpf_sockops(struct bpf_sock_ops *skops)
{
    /* Called on TCP state transitions and option negotiations */

    switch (skops->op) {
    case BPF_SOCK_OPS_TCP_CONNECT_CB:
        /* Set TCP_NODELAY for all connections in this cgroup */
        bpf_sock_ops_cb_flags_set(skops, BPF_SOCK_OPS_STATE_CB_FLAG);
        break;

    case BPF_SOCK_OPS_ACTIVE_ESTABLISHED_CB:
        /* Set socket buffer sizes */
        bpf_setsockopt(skops, SOL_SOCKET, SO_SNDBUF, &(int){512*1024}, 4);
        /* Increase initial congestion window */
        bpf_setsockopt(skops, IPPROTO_TCP, TCP_CONGESTION, "bbr", 4);
        break;
    }
    return 1;
}
```

```bash
bpftool cgroup attach /sys/fs/cgroup/myapp sock_ops pinned /sys/fs/bpf/sockops
```

## Sockmap: socket redirection

Sockmap enables redirecting data between sockets at kernel speed, without going through userspace:

```
Normal:                         Sockmap redirect:
  Client → kernel → recv() →   Client → kernel (BPF) → Backend
  userspace → send() → kernel  (no userspace copy)
  → Backend
```

### sk_skb: redirect incoming data

```c
struct {
    __uint(type, BPF_MAP_TYPE_SOCKMAP);
    __uint(max_entries, 65536);
    __uint(key_size, sizeof(u32));
    __uint(value_size, sizeof(u32));
} sock_map SEC(".maps");

/* Stream parser: decide how to split stream into messages */
SEC("sk_skb/stream_parser")
int bpf_parser(struct __sk_buff *skb)
{
    /* Return length of next message */
    return skb->len;  /* one message per skb */
}

/* Stream verdict: decide what to do with each message */
SEC("sk_skb/stream_verdict")
int bpf_verdict(struct __sk_buff *skb)
{
    /* Look up destination socket by key */
    u32 key = 0;
    return bpf_sk_redirect_map(skb, &sock_map, key, 0);
    /* Data is delivered to the target socket without userspace copy */
}
```

```bash
# Attach parser and verdict programs
bpftool prog load sk_skb.o /sys/fs/bpf/sk_skb

bpftool map update id <sockmap_id> key 0 value <target_socket_fd>
```

### sk_msg: intercept sendmsg

```c
struct {
    __uint(type, BPF_MAP_TYPE_SOCKHASH);
    __uint(max_entries, 65536);
    __uint(key_size, sizeof(struct sock_key));
    __uint(value_size, sizeof(u32));
} sock_ops_map SEC(".maps");

SEC("sk_msg")
int bpf_redir_proxy(struct sk_msg_md *msg)
{
    struct sock_key key = {};
    /* Build reverse key: redirect to peer */
    key.sip4 = msg->remote_ip4;
    key.dip4 = msg->local_ip4;
    key.sport = msg->remote_port;
    key.dport = (bpf_htonl(msg->local_port) >> 16);

    /* Redirect msg directly to peer socket */
    return bpf_msg_redirect_hash(msg, &sock_ops_map, &key, BPF_F_INGRESS);
}
```

Cilium uses `sk_msg` + `sk_skb` to implement transparent service mesh data plane without a sidecar proxy in the hot path.

## libbpf: attaching network programs

```c
/* TC attach via libbpf */
struct bpf_tc_hook hook = {
    .sz      = sizeof(hook),
    .ifindex = if_nametoindex("eth0"),
    .attach_point = BPF_TC_INGRESS,
};
bpf_tc_hook_create(&hook);

struct bpf_tc_opts opts = {
    .sz   = sizeof(opts),
    .prog_fd = bpf_program__fd(skel->progs.tc_ingress),
};
bpf_tc_attach(&hook, &opts);

/* Detach */
bpf_tc_detach(&hook, &opts);
bpf_tc_hook_destroy(&hook);
```

```c
/* Cgroup attach via libbpf */
int cgroup_fd = open("/sys/fs/cgroup/myapp", O_RDONLY);
bpf_prog_attach(bpf_program__fd(skel->progs.cgroup_ingress),
                cgroup_fd,
                BPF_CGROUP_INET_INGRESS,
                BPF_F_ALLOW_MULTI);  /* chain with existing programs */
```

## Observing network BPF programs

```bash
# List all BPF programs
bpftool prog list

# Show a specific program
bpftool prog show id 42 --pretty

# Dump bytecode / JIT-compiled instructions
bpftool prog dump xlated id 42
bpftool prog dump jited id 42

# Show TC BPF filters on an interface
tc filter show dev eth0 ingress

# Show cgroup BPF programs
bpftool cgroup tree

# Statistics
bpftool prog show id 42 | grep run_cnt
```

## Further reading

- [XDP (eXpress Data Path)](../net/xdp.md) — BPF at driver level, introduced in Linux 4.8 [(LWN)](https://lwn.net/Articles/682538/)
- [AF_XDP Sockets](../net/af-xdp.md) — zero-copy packet processing
- [TC and qdisc](../net/tc-qdisc.md) — TC architecture
- [BPF Architecture](bpf-overview.md) — program type overview
- [BPF Verifier](bpf-verifier.md) — safety constraints on packet access
- [libbpf and Skeletons](libbpf.md) — TC/cgroup attach with libbpf
- `net/core/filter.c` — sk_filter, socket filter implementation
- `net/sched/cls_bpf.c` — TC BPF classifier
