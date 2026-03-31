# IP Routing

> How the kernel decides where packets go: routing tables, lookups, and the FIB

## What routing does

For every packet — inbound or outbound — the kernel asks: "where should this go?" The routing subsystem answers:

- **Local delivery**: This packet is for us, send it up to a socket
- **Forward**: This packet is for someone else, find the next hop and transmit
- **Unreachable**: No route to destination, send ICMP unreachable

The answer comes from the **FIB (Forwarding Information Base)** — the kernel's routing table.

## The routing tables

Linux supports multiple routing tables (for policy routing):

```bash
# Main table (table 254) — standard routes
ip route show

# All tables
ip route show table all

# Lookup a specific destination
ip route get 8.8.8.8
# → 8.8.8.8 via 192.168.1.1 dev eth0 src 192.168.1.100

# Add a route
ip route add 10.0.0.0/8 via 192.168.1.254 dev eth0

# Policy rules: route by source IP, mark, or interface
ip rule show
```

## FIB internals: LC-trie

The kernel implements the FIB as an **LC-trie** (Level Compressed trie, a.k.a. Patricia trie) for efficient longest-prefix matching:

```c
// include/net/ip_fib.h
struct fib_table {
    struct hlist_node   tb_hlist;
    u32                 tb_id;      // table ID (254 = main, 255 = local)
    int                 tb_num_default;
    struct rcu_head     rcu;
    unsigned long       *tb_data;   // the trie
};

struct fib_result {
    __be32          prefix;
    unsigned char   prefixlen;
    struct fib_info *fi;    // next-hop info: gateway, device, metrics
    struct fib_nh_common *nhc; // selected next hop (for ECMP)
    // ...
};
```

Lookup is `fib_table_lookup()`:

```c
// net/ipv4/fib_trie.c:1420
int fib_table_lookup(struct fib_table *tb, const struct flowi4 *flp,
                     struct fib_result *res, int fib_flags)
{
    // Walk the LC-trie from root
    // At each node, extract bits from the destination address
    // Follow the matching child
    // At a leaf: longest-prefix match found
    // Fill res with the fib_info (gateway, interface, etc.)
}
```

## Route lookup: ip_route_input_noref()

On receive, routing is called from `ip_rcv_finish()`:

```c
// net/ipv4/route.c
int ip_route_input_noref(struct sk_buff *skb, __be32 daddr, __be32 saddr,
                          dscp_t dscp, struct net_device *dev)
{
    // 1. FIB lookup (no route cache since Linux 3.6)
    err = fib_lookup(net, &fl4, &res, 0);

    // 2. Determine input action
    if (res.type == RTN_LOCAL) {
        // Packet is for us — create rtable with input = ip_local_deliver
        // skb->_skb_refdst set to &rt->dst
    } else if (res.type == RTN_UNICAST) {
        // Packet should be forwarded
        ip_route_input_slow(skb, daddr, saddr, ...);
    } else {
        // RTN_UNREACHABLE, RTN_BLACKHOLE, RTN_PROHIBIT
        goto martian_destination;
    }
}
```

## Route cache: dst_entry

Routing decisions are cached in `struct dst_entry`:

```c
// include/net/dst.h
struct dst_entry {
    struct net_device *dev;         // output device
    struct  dst_ops   *ops;         // ip_dst_ops, etc.
    void (*output)(struct net *, struct sock *, struct sk_buff *);
    // → ip_output() for local, ip_forward() for forwarded

    unsigned long     _metrics;     // MTU, RTT, etc.
    unsigned long     expires;      // cache expiry
};
```

On the transmit path, the route is cached in `sk->sk_dst_cache`:

```c
// ip_queue_xmit() checks this first:
rt = (struct rtable *)__sk_dst_check(sk, 0);
if (!rt) {
    rt = ip_route_output_ports(net, fl4, sk, daddr, saddr, ...);
    sk_setup_caps(sk, &rt->dst);  // cache it
}
```

## Policy routing

Linux supports multiple routing tables and **rules** that select which table to use:

```bash
# Add a rule: packets from 10.0.0.0/24 use table 100
ip rule add from 10.0.0.0/24 table 100
ip route add default via 192.168.2.1 table 100

# Rules are evaluated in priority order
ip rule show
# 0:      from all lookup local   (local table: localhost, broadcast)
# 32766:  from all lookup main    (main table: normal routes)
# 32767:  from all lookup default (default table: usually empty)
```

Rules can match on:
- Source address (`from`)
- Destination address (`to`)
- Incoming interface (`iif`)
- Firewall mark (`fwmark`)
- TOS/DSCP field

## ECMP: Equal Cost Multipath

Multiple routes to the same destination with equal metric = ECMP:

```bash
# Add two equal-cost routes (traffic split across eth0 and eth1)
ip route add 10.0.0.0/8 nexthop via 192.168.1.1 dev eth0 weight 1 \
                         nexthop via 192.168.2.1 dev eth1 weight 1

# Default hash: 5-tuple (src/dst IP, src/dst port, protocol)
# L4 hash ensures same flow always takes the same path
```

```bash
# Check ECMP hashing algorithm
cat /proc/sys/net/ipv4/fib_multipath_hash_policy
# 0 = L3 (src+dst IP)
# 1 = L4 (5-tuple)
# 2 = L3+L4
```

## Neighbor subsystem: ARP

IP routing resolves to a next-hop IP, but transmission requires a MAC address. The **neighbor subsystem** maps IP → MAC via ARP:

```c
// net/core/neighbour.c
struct neighbour {
    struct neighbour __rcu *next;
    struct neigh_table  *tbl;       // arp_tbl for IPv4
    struct neigh_parms  *parms;
    unsigned long       confirmed;  // last time we confirmed reachability
    u8                  flags;
    u8                  nud_state;  // NUD_REACHABLE, NUD_STALE, NUD_PROBE, ...
    u8                  ha[ALIGN(MAX_ADDR_LEN, sizeof(unsigned long))]; // MAC addr
    struct hh_cache     hh;         // cached L2 header for fast path
    int (*output)(struct neighbour *, struct sk_buff *);
};
```

NUD (Neighbor Unreachability Detection) states:

```
INCOMPLETE → REACHABLE (ARP reply received)
REACHABLE → STALE (no recent confirmation)
STALE → PROBE (send unicast ARP probe)
PROBE → REACHABLE (got reply) or FAILED (no reply)
```

```bash
# View ARP table
ip neigh show

# Add static ARP entry
ip neigh add 10.0.0.5 lladdr 52:54:00:12:34:56 dev eth0

# Flush stale entries
ip neigh flush dev eth0

# Tune ARP cache lifetime
cat /proc/sys/net/ipv4/neigh/default/gc_stale_time  # default: 60s
```

## Diagnosing routing issues

```bash
# Simulate routing decision
ip route get 8.8.8.8

# Watch routing table changes
ip monitor route

# Count route cache misses (if applicable)
cat /proc/net/rt_cache_stat  # (removed in newer kernels)

# FIB table statistics
cat /proc/net/fib_triestat
# Aver depth: how deep the trie is
# Max depth: worst case lookup depth

# ICMP unreachable messages (routing failures)
netstat -s | grep "destination unreachable"
```

## Further reading

- [Life of a Packet (receive)](life-of-packet-rx.md) — Where routing fits in ip_rcv_finish
- [Life of a Packet (transmit)](life-of-packet-tx.md) — Where ip_queue_xmit uses routing
- [Netfilter Architecture](netfilter.md) — Hooks run alongside routing decisions
- [TCP Implementation](tcp.md) — How TCP uses routing for source IP selection
