# Life of a Packet (Receive Path)

> From NIC DMA to application read(), step by step

## Overview

A TCP packet arriving at a server traverses roughly 8 distinct phases before the application receives the data. Each phase is handled by a different kernel subsystem, and the same `sk_buff` passes through all of them without data copying.

```
NIC hardware
    ↓ DMA
Ring buffer
    ↓ interrupt / NAPI poll
sk_buff allocation
    ↓
Ethernet demux (__netif_receive_skb)
    ↓
IP input (ip_rcv)
    ↓ Netfilter: PREROUTING
    ↓ routing decision
    ↓ Netfilter: INPUT
TCP input (tcp_v4_rcv)
    ↓ socket lookup
    ↓ TCP state machine
Socket receive queue
    ↓ data_ready wakeup
Application: read() / recv()
```

## Phase 1: NIC DMA and interrupt

The NIC places received packets into a pre-allocated **ring buffer** via DMA. Each ring entry (descriptor) points to a kernel buffer:

```c
// Driver pre-allocates buffers (RX ring setup)
for each ring slot:
    buf = page_pool_alloc_pages(pool, GFP_ATOMIC);
    ring->desc[i].dma_addr = dma_map_page(dev, buf, ...);
```

When a packet arrives:
1. NIC writes packet data to the DMA buffer
2. NIC sets the "done" bit on the ring descriptor
3. NIC raises a hardware interrupt

## Phase 2: NAPI polling

The hard IRQ handler disables further NIC interrupts and schedules NAPI:

```c
// Driver interrupt handler
static irqreturn_t my_nic_irq(int irq, void *data)
{
    napi_schedule(&nic->napi);   // schedule softirq poll
    my_nic_mask_irq(nic);        // disable NIC interrupt
    return IRQ_HANDLED;
}
```

The `NET_RX_SOFTIRQ` softirq fires (on the same CPU) and calls `net_rx_action()`:

```c
// net/core/dev.c
static __latent_entropy void net_rx_action(void)
{
    // For each scheduled napi on this CPU:
    while (!list_empty(&sd->poll_list)) {
        napi->poll(napi, budget);  // driver's poll function
    }
}
```

The driver's poll function builds `sk_buff`s from ring buffer entries:

```c
static int my_nic_poll(struct napi_struct *napi, int budget)
{
    while (pkts < budget && ring has packets) {
        skb = napi_build_skb(rx_buf, headroom);
        skb->protocol = eth_type_trans(skb, dev); // set Ethernet type
        napi_gro_receive(napi, skb);              // pass to GRO → stack
    }
    if (pkts < budget)
        napi_complete_done(napi, pkts);  // re-enable interrupt
    return pkts;
}
```

## Phase 3: Ethernet demux — __netif_receive_skb()

`napi_gro_receive()` either merges the packet with an existing GRO flow or delivers it to `__netif_receive_skb()`:

```c
// net/core/dev.c
static int __netif_receive_skb_core(struct sk_buff *skb, ...)
{
    // 1. Deliver to packet sockets (tcpdump, AF_PACKET)
    list_for_each_entry_rcu(ptype, &ptype_all, list)
        ptype->func(skb, ...);

    // 2. XDP (if attached to this device) — early drop/redirect
    // [handled before this point in NAPI]

    // 3. Protocol demux based on skb->protocol
    // Looks up ptype_base[ntohs(skb->protocol) & PTYPE_HASH_MASK]
    // For IP: ip_rcv()
    // For ARP: arp_rcv()
    // etc.
    deliver_ptype_list_skb(skb, &pt_prev, orig_dev, skb->protocol, ...);
}
```

## Phase 4: IP input — ip_rcv()

```c
// net/ipv4/ip_input.c:564
int ip_rcv(struct sk_buff *skb, struct net_device *dev, ...)
{
    // Validate IP header: checksum, version, min length
    iph = ip_hdr(skb);
    if (ip_fast_csum((u8 *)iph, iph->ihl))
        goto drop;  // bad checksum

    // Netfilter: NF_INET_PRE_ROUTING hook (IP header still in place)
    // (conntrack, DNAT happens here)
    return NF_HOOK(NFPROTO_IPV4, NF_INET_PRE_ROUTING, ..., ip_rcv_finish);
}

static int ip_rcv_finish(struct sk_buff *skb)
{
    // Route: is this for us or should we forward?
    ip_route_input_noref(skb, iph->daddr, iph->saddr, iph->tos, dev);

    // dst decides: local delivery or forward
    return dst_input(skb);
    // → ip_local_deliver() for local packets
    // → ip_forward() for forwarded packets
}
```

## Phase 5: Netfilter INPUT hook and local delivery

```c
// net/ipv4/ip_input.c
int ip_local_deliver(struct sk_buff *skb)
{
    // Netfilter: NF_INET_LOCAL_IN hook
    // (iptables INPUT rules, firewall, etc.)
    return NF_HOOK(NFPROTO_IPV4, NF_INET_LOCAL_IN, ..., ip_local_deliver_finish);
}

static int ip_local_deliver_finish(struct sk_buff *skb)
{
    // Transport protocol demux
    // iph->protocol = IPPROTO_TCP (6), IPPROTO_UDP (17), etc.
    ipprot = rcu_dereference(inet_protos[iph->protocol]);
    ipprot->handler(skb);
    // → tcp_v4_rcv() for TCP
    // → udp_rcv() for UDP
}
```

## Phase 6: TCP receive — tcp_v4_rcv()

```c
// net/ipv4/tcp_ipv4.c:2147
int tcp_v4_rcv(struct sk_buff *skb)
{
    // 1. Validate TCP header
    th = tcp_hdr(skb);
    if (skb->len < th->doff * 4)
        goto drop;

    // 2. Socket lookup: find the sock matching (src IP, src port, dst IP, dst port)
    sk = __inet_lookup_skb(&tcp_hashinfo, skb, th->source, th->dest, ...);
    if (!sk)
        goto no_tcp_socket;  // send RST

    // 3. If socket lock is held, queue to backlog
    if (!sock_owned_by_user(sk)) {
        tcp_v4_do_rcv(sk, skb);
    } else {
        sk_add_backlog(sk, skb, ...);
    }
}

static int tcp_v4_do_rcv(struct sock *sk, struct sk_buff *skb)
{
    // TCP state machine: handles SYN, ACK, data, FIN, RST
    // For ESTABLISHED state:
    tcp_rcv_established(sk, skb);
}
```

## Phase 7: TCP state machine and socket queue

For an ESTABLISHED connection receiving data:

```c
// net/ipv4/tcp_input.c (simplified)
static void tcp_rcv_established(struct sock *sk, struct sk_buff *skb)
{
    // Fast path: expected sequence number, no options
    // Slow path: reordering, SACKs, urgent data, options

    // 1. Sequence number validation
    // 2. Data delivery to receive queue
    eaten = tcp_queue_rcv(sk, skb, &fragstolen);

    // 3. Send ACK (may be delayed)
    tcp_event_data_recv(sk, skb);

    // 4. Wake up reader
    sk->sk_data_ready(sk);  // = sock_def_readable()
}

static int tcp_queue_rcv(struct sock *sk, struct sk_buff *skb, bool *fragstolen)
{
    // Add to sk->sk_receive_queue
    __skb_queue_tail(&sk->sk_receive_queue, skb);
    sk_mem_charge(sk, skb->truesize);  // charge against sk_rcvbuf
}
```

## Phase 8: Application read()

The application calls `read()` or `recv()`. If `sk_receive_queue` is empty, it blocks (TASK_INTERRUPTIBLE). When `sk_data_ready()` fires, the task wakes:

```c
// net/ipv4/tcp.c
int tcp_recvmsg(struct sock *sk, struct msghdr *msg, size_t len, int flags, int *addr_len)
{
    // Lock the socket
    lock_sock(sk);

    while (len > 0) {
        // Dequeue from sk_receive_queue
        skb = skb_peek(&sk->sk_receive_queue);
        if (!skb) {
            // Nothing: wait
            sk_wait_data(sk, &timeo, last);
            continue;
        }

        // Copy data to userspace (msg->msg_iter)
        copied = skb_copy_datagram_msg(skb, offset, msg, chunk);
        // Advance offset, release consumed skbs
    }

    // Process backlog accumulated while we held the lock
    release_sock(sk);
}
```

`release_sock()` processes the backlog: packets that arrived while the socket was locked are now handled by `tcp_v4_do_rcv()`.

## Key counters to watch

```bash
# Drop counters at each stage
ethtool -S eth0 | grep -i drop   # NIC ring drops
cat /proc/net/softnet_stat        # softirq backlog drops (column 2)
ss -s                             # socket buffer drops
cat /proc/net/snmp | grep -E "Tcp|Ip"  # IP/TCP protocol counters

# Specific TCP counters
netstat -s | grep -E "segments|retransmit|error"

# Socket receive queue depth (RX-Q column)
ss -tn  # non-zero RX-Q means unread data in socket buffer
```

## Further reading

- [sk_buff](sk-buff.md) — The packet structure used throughout this path
- [Network Device and NAPI](napi.md) — Phases 1-2 in depth
- [Socket Layer Overview](socket-layer.md) — struct sock and the receive queue
- [Life of a Packet (transmit)](life-of-packet-tx.md) — The outbound path
- [TCP Implementation](tcp.md) — TCP state machine and congestion control
