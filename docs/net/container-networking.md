# Container Networking

> How Docker, Kubernetes, and container runtimes implement network isolation

## The building blocks

Container networking is built from three Linux primitives:

1. **Network namespaces** — isolated network stacks (interfaces, routes, iptables)
2. **veth pairs** — virtual Ethernet cable connecting two namespaces
3. **Linux bridge** — software switch connecting veth pairs

```
Host network namespace                 Container namespace
┌─────────────────────────┐            ┌──────────────────────┐
│  eth0 (physical)         │            │  eth0 (veth1's peer) │
│  docker0 (bridge)        │            │  10.0.0.2/24         │
│  ├── veth0 (10.0.0.1)   │════════════│  (sees only this)    │
│  └── veth2              │════════════│                      │
│  iptables MASQUERADE     │            └──────────────────────┘
└─────────────────────────┘
```

## veth pairs

A veth pair is two virtual interfaces connected back-to-back. Packets sent to one end emerge from the other:

```bash
# Create a veth pair
ip link add veth0 type veth peer name veth1

# veth0 stays in host namespace
# veth1 is moved to container's network namespace
ip link set veth1 netns <container_pid>

# Configure both ends
ip addr add 10.0.0.1/24 dev veth0
ip link set veth0 up

# Inside container:
nsenter -t <container_pid> -n ip addr add 10.0.0.2/24 dev veth1
nsenter -t <container_pid> -n ip link set veth1 up
nsenter -t <container_pid> -n ip route add default via 10.0.0.1
```

### veth in the kernel

```c
/* drivers/net/veth.c */
struct veth_priv {
    struct net_device __rcu *peer;      /* the other end */
    atomic64_t               dropped;
    struct veth_rq          *rq;        /* RX queues */
    unsigned int             requested_headroom;
    bool                     rx_notify_masked;
    struct ptr_ring         *xdp_ring;  /* XDP ring buffer */
};

/* TX: just deliver to the peer's RX */
static netdev_tx_t veth_xmit(struct sk_buff *skb, struct net_device *dev)
{
    struct veth_priv *rcv_priv, *priv = netdev_priv(dev);
    struct net_device *rcv;

    rcv = rcu_dereference(priv->peer);
    if (!rcv)
        goto drop;

    /* Deliver directly to peer's softirq RX path */
    if (veth_forward_skb(rcv, skb, rq, use_napi) == NET_RX_DROP) {
        /* ... */
    }
    return NETDEV_TX_OK;
}
```

No actual hardware involved — packets cross from one namespace to another via `netif_rx()`.

## Linux bridge

The bridge acts as a software L2 switch. veth host-side interfaces are attached as bridge ports:

```bash
# Create a bridge (docker0 equivalent)
ip link add docker0 type bridge
ip addr add 172.17.0.1/16 dev docker0
ip link set docker0 up

# Attach veth host-sides to the bridge
ip link set veth0 master docker0
ip link set veth2 master docker0

# Now: containers connected to docker0 can communicate with each other
# and through the host's routing table
```

### Bridge forwarding

```c
/* net/bridge/br_forward.c */
/* When a frame arrives on a bridge port: */
void br_forward(const struct net_bridge_port *to, struct sk_buff *skb,
                bool local_rcv, bool local_orig)
{
    /* Look up destination MAC in FDB (forwarding database) */
    struct net_bridge_fdb_entry *dst = br_fdb_find_rcu(to->br, dest, vid);
    if (dst) {
        /* Unicast: forward to specific port */
        __br_forward(dst->dst, skb, local_orig);
    } else {
        /* Unknown unicast: flood to all ports */
        br_flood(to->br, skb, BR_PKT_UNICAST, local_rcv, local_orig);
    }
}
```

The bridge maintains a MAC→port forwarding database (FDB), learning from incoming packets. `bridge fdb show` displays it.

## NAT / masquerade

Containers need to reach the internet. The host NATs outgoing traffic:

```bash
# iptables NAT masquerade (what Docker adds)
iptables -t nat -A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE

# nftables equivalent
nft add rule ip nat POSTROUTING ip saddr 172.17.0.0/16 oif != "docker0" masquerade
```

When container `172.17.0.2` sends to `8.8.8.8`:
1. Packet leaves container via `eth0` → veth → bridge → host routing
2. Host sees source `172.17.0.2` → matches MASQUERADE rule
3. Connection tracking records the mapping: `172.17.0.2:54321 → host_ip:RANDOM`
4. Source IP rewritten to host IP
5. Reply comes back to host IP → conntrack → translated back → forwarded to container

## Port publishing

```bash
# Docker: map host port 8080 → container port 80
docker run -p 8080:80 nginx

# Translates to iptables rules:
iptables -t nat -A PREROUTING -p tcp --dport 8080 -j DNAT --to-destination 172.17.0.2:80
iptables -t filter -A DOCKER -d 172.17.0.2 -p tcp --dport 80 -j ACCEPT
```

## Overlay networks (VXLAN)

For multi-host container networking (Kubernetes, Docker Swarm), overlay networks encapsulate container traffic in UDP/VXLAN:

```
Node 1 (10.0.0.1)                    Node 2 (10.0.0.2)
Container A (192.168.0.1)            Container B (192.168.0.2)
   │                                        │
   veth                                     veth
   │                                        │
   VTEP (VXLAN Tunnel Endpoint)             VTEP
   │  encapsulate in UDP/VXLAN              │  decapsulate
   │  outer: 10.0.0.1→10.0.0.2             │
   └────────── physical network ────────────┘
```

```bash
# Create a VXLAN overlay (Flannel/Calico/Cilium do this automatically)
ip link add vxlan0 type vxlan id 100 \
    local 10.0.0.1 \
    remote 10.0.0.2 \
    dstport 4789

ip link set vxlan0 up
ip addr add 192.168.0.1/24 dev vxlan0

# Add a route for container B
ip route add 192.168.0.2/32 via 10.0.0.2 dev vxlan0
```

### VXLAN in the kernel

```c
/* drivers/net/vxlan/vxlan_core.c */
static netdev_tx_t vxlan_xmit(struct sk_buff *skb, struct net_device *dev)
{
    struct vxlan_dev *vxlan = netdev_priv(dev);

    /* Look up VTEP for destination */
    struct vxlan_fdb *f = vxlan_find_mac(vxlan, eth_hdr(skb)->h_dest, vni);

    /* Encapsulate: inner Ethernet frame → VXLAN header → UDP → outer IP */
    vxlan_encap_bypass(skb, vxlan, dst, vni, ...);
    udp_tunnel_xmit_skb(vxlan->vn4_sock, rt, skb,
                         src, remote_ip, ...);
    return NETDEV_TX_OK;
}
```

## Network policies (iptables vs eBPF)

Traditional container firewalling uses iptables rules inserted by the runtime. For thousands of pods, this becomes a bottleneck (O(n) rule traversal):

```bash
# kube-proxy (traditional): thousands of iptables rules
iptables -L -n | wc -l
# 5000+  ← one rule per service endpoint

# Cilium (eBPF-based): O(1) BPF map lookup
# No iptables at all — policy enforced via XDP/TC BPF hooks
bpf_redirect_map(&cilium_lb4_backends, backend_id, 0)
```

Cilium and other eBPF-based CNI plugins (Calico with eBPF, Flannel with VXLAN-on-eBPF) replace iptables with BPF maps — constant-time lookups regardless of rule count.

## Observing container networking

```bash
# List all network namespaces
lsns -t net

# Enter a container's network namespace
ip netns exec <ns_name> ip addr show
# or
nsenter -t <container_pid> -n ip addr show

# Show veth peer relationship
ip link show | grep -A1 "veth"
# Or:
for dev in /sys/class/net/veth*; do
    peer_idx=$(cat "$dev/ifindex")  # wrong — it's actually iflink
    echo "$(basename $dev) → peer ifindex $(cat $dev/iflink)"
done

# Bridge FDB (MAC learning table)
bridge fdb show dev docker0

# Watch packet flow through the bridge
tcpdump -i docker0 -n

# NAT connection tracking
conntrack -L -p tcp | head -20

# Per-veth stats
ip -s link show veth0

# VXLAN tunnel stats
ip -s link show vxlan0
```

## Further reading

- [Netfilter Architecture](netfilter.md) — iptables/nftables hooks
- [Connection Tracking](conntrack.md) — NAT state tracking
- [XDP](xdp.md) — eBPF networking acceleration
- [AF_XDP](af-xdp.md) — zero-copy userspace packet processing
- [Cgroups: Namespaces](../cgroups/namespaces.md) — network namespace internals
- [Cgroups: Container Isolation](../cgroups/container-isolation.md) — full container setup
