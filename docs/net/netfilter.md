# Netfilter Architecture

> The kernel's packet filtering and NAT framework: hooks, tables, and connection tracking

## What Netfilter is

Netfilter is a framework of hooks embedded at fixed points in the IP stack. Every packet traversing the network passes through these hooks, where registered callbacks (from iptables, nftables, conntrack, etc.) can inspect and modify it.

Netfilter itself is just the framework. The policy (firewall rules, NAT, etc.) is implemented by modules that register at these hooks.

## The five hook points

```
                          Routing Decision
                                │
NIC → PREROUTING ──────────────→ FORWARD → POSTROUTING → NIC
                   ↓                                 ↑
                LOCAL IN                         LOCAL OUT
                   ↓                                 ↑
               Local Socket ────────────────────────┘
```

```c
// include/uapi/linux/netfilter.h
enum nf_inet_hooks {
    NF_INET_PRE_ROUTING,   // After L2, before routing decision
    NF_INET_LOCAL_IN,      // After routing, for locally destined packets
    NF_INET_FORWARD,       // For forwarded packets (not for us)
    NF_INET_LOCAL_OUT,     // Locally generated packets, after routing lookup
    NF_INET_POST_ROUTING,  // After routing, just before transmission
};
```

| Hook | When | Common uses |
|------|------|-------------|
| PREROUTING | After NIC, before routing | DNAT (port forwarding), conntrack |
| LOCAL_IN | Before socket delivery | INPUT chain (firewall) |
| FORWARD | Between receive and transmit | FORWARD chain (router firewall) |
| LOCAL_OUT | After socket, before routing | OUTPUT chain |
| POSTROUTING | Before NIC transmit | SNAT (masquerade) |

## struct nf_hook_ops: registering a hook

Any module can register callbacks at these hooks:

```c
// include/linux/netfilter.h
struct nf_hook_ops {
    nf_hookfn    *hook;       // callback: (priv, skb, state) → verdict
    struct net_device *dev;   // NULL = all devices, or specific device
    void         *priv;       // private data passed to hook
    u8           pf;          // protocol family: NFPROTO_IPV4, NFPROTO_IPV6
    unsigned int hooknum;     // which hook: NF_INET_PRE_ROUTING, etc.
    int          priority;    // order among multiple hooks at same point
                              // NF_IP_PRI_CONNTRACK = -200
                              // NF_IP_PRI_FILTER = 0
                              // NF_IP_PRI_NAT_SRC = +100
};
```

Hook verdicts:
- `NF_ACCEPT` — continue processing
- `NF_DROP` — drop the packet
- `NF_STOLEN` — hook took ownership (no further processing)
- `NF_QUEUE` — send to userspace (for NFQUEUE)
- `NF_REPEAT` — call this hook again

```c
// Example: simple hook that logs all TCP SYN packets
static unsigned int syn_log_hook(void *priv, struct sk_buff *skb,
                                  const struct nf_hook_state *state)
{
    struct iphdr *iph = ip_hdr(skb);
    if (iph->protocol == IPPROTO_TCP) {
        struct tcphdr *th = tcp_hdr(skb);
        if (th->syn && !th->ack)
            pr_info("SYN from %pI4 to %pI4\n", &iph->saddr, &iph->daddr);
    }
    return NF_ACCEPT;
}
```

## iptables vs nftables

Both are userspace tools that install rules into Netfilter. They differ in the underlying kernel representation:

| Aspect | iptables | nftables |
|--------|----------|----------|
| Kernel module | ip_tables | nf_tables |
| Rule storage | Table/chain/rule lists | Sets and maps with bytecode |
| Performance | Linear scan | Set lookups (hash/rbtree) |
| IPv4/IPv6 | Separate (iptables/ip6tables) | Unified (nft) |
| ARP | Separate (arptables) | Unified |
| Atomic rule update | No (per-rule add) | Yes (transactions) |

Both install their rules as Netfilter hook callbacks under the hood.

### iptables chains and tables

```bash
# iptables organizes rules into tables and chains
iptables -L -n -v              # List rules in filter table
iptables -t nat -L -n -v      # NAT table
iptables -t mangle -L -n -v   # mangle table (QoS marks)
iptables -t raw -L -n -v      # raw table (conntrack bypass)

# Tables and which hooks they operate at:
# filter: INPUT, FORWARD, OUTPUT
# nat:    PREROUTING (DNAT), INPUT (local DNAT), OUTPUT (local DNAT), POSTROUTING (SNAT)
# mangle: all five hooks
# raw:    PREROUTING, OUTPUT (runs BEFORE conntrack)
```

### nftables equivalent

```bash
# nftables uses a unified command
nft list ruleset

# Create a table and chain
nft add table inet myfilter
nft add chain inet myfilter input { type filter hook input priority 0\; policy drop\; }
nft add rule inet myfilter input tcp dport 22 accept

# Efficient set-based matching (no linear scan)
nft add set inet myfilter allowed_ips { type ipv4_addr\; }
nft add element inet myfilter allowed_ips { 10.0.0.1, 10.0.0.2 }
nft add rule inet myfilter input ip saddr @allowed_ips accept
```

## Connection tracking (conntrack)

**Conntrack** is the stateful packet inspection layer. It tracks every connection through the kernel, enabling:
- Stateful firewall rules (`-m state --state ESTABLISHED,RELATED`)
- NAT (both DNAT and SNAT need to rewrite both directions)
- Connection-aware applications (via NFQUEUE or nf_conntrack events)

### struct nf_conn

```c
// include/net/netfilter/nf_conntrack.h
struct nf_conn {
    struct nf_conntrack ct_general;   // reference count

    u32 timeout;                      // expiry (jiffies)

    // Two tuples: original direction and reply direction
    // For TCP 10.0.0.1:54321 → 8.8.8.8:80:
    //   tuplehash[ORIGINAL]: src=10.0.0.1:54321 dst=8.8.8.8:80
    //   tuplehash[REPLY]:    src=8.8.8.8:80 dst=10.0.0.1:54321
    struct nf_conntrack_tuple_hash tuplehash[IP_CT_DIR_MAX];

    unsigned long status;   // IPS_CONFIRMED, IPS_SEEN_REPLY, IPS_ASSURED, ...

    u_int32_t mark;         // connmark (for firewall rules / routing)
    u_int32_t secmark;      // SELinux security mark

    union nf_conntrack_proto proto;  // TCP state, UDP timeout, etc.
};
```

### Conntrack lifecycle

```
Packet arrives → PREROUTING → conntrack lookup
    New packet: create nf_conn entry (state: NEW)
    Known packet: update state (ESTABLISHED/RELATED)
    ↓
Filter hook: rule can match by state
    -m conntrack --ctstate NEW,ESTABLISHED
    ↓
POSTROUTING → NAT rewrites src/dst if needed
    → nf_conn stores the rewrite for the reply direction
```

### Viewing conntrack state

```bash
# List all tracked connections
conntrack -L
# tcp      6 431999 ESTABLISHED src=10.0.0.1 dst=8.8.8.8 sport=54321 dport=80
#                               src=8.8.8.8 dst=10.0.0.1 sport=80 dport=54321

# Count connections by state
conntrack -L | awk '{print $4}' | sort | uniq -c | sort -rn

# Watch conntrack events
conntrack -E

# Conntrack table statistics
cat /proc/net/stat/nf_conntrack
```

### Conntrack tuning

```bash
# Maximum number of tracked connections
cat /proc/sys/net/netfilter/nf_conntrack_max
echo 524288 > /proc/sys/net/netfilter/nf_conntrack_max

# Current usage
cat /proc/sys/net/netfilter/nf_conntrack_count

# TCP established timeout (default: 5 days!)
cat /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established
echo 7200 > /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established

# For high-connection-rate servers: tune TIME_WAIT timeout
cat /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_time_wait  # default: 120s
```

A full conntrack table causes new connections to be dropped. This is a common issue on busy NAT gateways or connection-heavy servers.

## NAT: DNAT and SNAT

NAT is implemented as Netfilter hooks that modify packets and store the rewrite in the conntrack entry:

```bash
# DNAT: redirect port 80 to internal server (PREROUTING)
iptables -t nat -A PREROUTING -p tcp --dport 80 -j DNAT --to-destination 192.168.1.10:8080

# SNAT: masquerade outbound traffic (POSTROUTING)
iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE

# With nftables:
nft add rule inet nat prerouting tcp dport 80 dnat to 192.168.1.10:8080
nft add rule inet nat postrouting oifname "eth0" masquerade
```

The conntrack entry stores both directions, so reply packets are automatically rewritten in the opposite direction (DNAT reply becomes SNAT, etc.) without needing explicit reverse rules.

## NF_HOOK macro: how hooks are called

At each hook point in the IP stack:

```c
// Example from ip_rcv() (net/ipv4/ip_input.c)
return NF_HOOK(NFPROTO_IPV4, NF_INET_PRE_ROUTING,
               net, NULL, skb, dev, NULL,
               ip_rcv_finish);
```

`NF_HOOK` calls each registered hook in priority order. If all return `NF_ACCEPT`, `ip_rcv_finish` is called. Any `NF_DROP` stops processing immediately.

## Further reading

- [nftables vs iptables](nftables-iptables.md) — Rule syntax and migration
- [Connection Tracking](conntrack.md) — conntrack internals in depth
- [Life of a Packet (receive)](life-of-packet-rx.md) — Where Netfilter hooks appear in the receive path
- [IP Routing](ip-routing.md) — How routing and Netfilter interact
