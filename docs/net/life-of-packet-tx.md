# Life of a Packet (Transmit Path)

> From application write() to NIC DMA, step by step

## Overview

When an application writes data to a TCP socket, the kernel turns that data into one or more IP packets and transmits them. The path from `write()` to wire:

```
Application: write() / send()
    ↓
tcp_sendmsg()         copy data into sk_buff chain
    ↓
tcp_write_xmit()      TCP segmentation, window check
    ↓
tcp_transmit_skb()    build TCP header
    ↓
ip_queue_xmit()       build IP header, routing lookup
    ↓ Netfilter: OUTPUT
    ↓ Netfilter: POSTROUTING
neigh_output()        ARP resolution → Ethernet header
    ↓
dev_queue_xmit()      qdisc (traffic control)
    ↓
driver ndo_start_xmit() DMA to NIC
    ↓
NIC transmits packet
```

## Phase 1: tcp_sendmsg() — data from userspace

```c
// net/ipv4/tcp.c:1460
int tcp_sendmsg(struct sock *sk, struct msghdr *msg, size_t size)
{
    lock_sock(sk);
    err = tcp_sendmsg_locked(sk, msg, size);
    release_sock(sk);
    return err;
}

int tcp_sendmsg_locked(struct sock *sk, struct msghdr *msg, size_t size)
{
    while (msg_data_left(msg)) {
        // Get or allocate a send sk_buff
        skb = tcp_write_queue_tail(sk);
        if (!skb || skb_tailroom(skb) == 0) {
            skb = sk_stream_alloc_skb(sk, 0, sk->sk_allocation, ...);
            tcp_add_write_queue_tail(sk, skb);
        }

        // Copy data from userspace into skb
        // Uses copy_from_iter() — zero-copy for MSG_ZEROCOPY if configured
        copy = skb_copy_to_page_nocache(sk, &msg->msg_iter, skb, ...);
        copied += copy;
    }

    // Try to send immediately
    tcp_push(sk, flags, mss_now, ...);
}
```

Data is held in `sk->sk_write_queue` until TCP decides to send it.

## Phase 2: TCP write: tcp_write_xmit()

TCP decides *when* to send based on:
- Congestion window (`tp->snd_cwnd`)
- Receive window advertised by peer (`tp->snd_wnd`)
- Nagle algorithm (delay small packets)
- Send buffer availability

```c
// net/ipv4/tcp_output.c
static bool tcp_write_xmit(struct sock *sk, unsigned int mss_now, ...)
{
    while ((skb = tcp_send_head(sk))) {
        // Check congestion window
        cwnd_quota = tcp_cwnd_test(tp, skb);
        if (!cwnd_quota)
            break;

        // Check receive window
        if (!tcp_snd_wnd_test(tp, skb, mss_now))
            break;

        // Segment if skb is larger than MSS
        if (skb->len > mss_now)
            tcp_mtu_probe(sk) || tcp_fragment(sk, skb, mss_now, ...);

        tcp_transmit_skb(sk, skb, 1, GFP_ATOMIC);
    }
}
```

## Phase 3: Build TCP header — tcp_transmit_skb()

```c
// net/ipv4/tcp_output.c
static int tcp_transmit_skb(struct sock *sk, struct sk_buff *skb, int clone_it, ...)
{
    // Clone the skb (original stays in write queue for retransmit)
    if (clone_it)
        skb = skb_clone(skb, gfp_mask);

    // Make room for TCP header
    skb_push(skb, tcp_header_size);
    skb_reset_transport_header(skb);

    // Fill TCP header
    th = tcp_hdr(skb);
    th->source = inet->inet_sport;
    th->dest   = inet->inet_dport;
    th->seq    = htonl(tcb->seq);
    th->ack_seq = htonl(tp->rcv_nxt);
    th->doff   = tcp_header_size >> 2;
    th->window = htons(tcp_select_window(sk));
    // ... options (SACK, timestamp, etc.)

    // Compute checksum (or leave for hardware offload)
    tcp_set_skb_tso_segs(skb, mss_now);

    // Hand to IP layer
    icsk->icsk_af_ops->queue_xmit(sk, skb, &inet->cork.fl);
    // → ip_queue_xmit()
}
```

## Phase 4: IP layer — ip_queue_xmit()

```c
// net/ipv4/ip_output.c:546
int ip_queue_xmit(struct sock *sk, struct sk_buff *skb, struct flowi *fl)
{
    // Route lookup (cached in sk->sk_dst_cache)
    rt = (struct rtable *)__sk_dst_check(sk, 0);
    if (!rt) {
        rt = ip_route_output_ports(net, fl4, sk, ...);
        sk_setup_caps(sk, &rt->dst);
    }
    skb_dst_set_noref(skb, &rt->dst);

    // Build IP header
    skb_push(skb, sizeof(struct iphdr));
    skb_reset_network_header(skb);
    iph = ip_hdr(skb);
    iph->version  = 4;
    iph->ihl      = 5;
    iph->tos      = inet->tos;
    iph->tot_len  = htons(skb->len);
    iph->id       = htons(inet->inet_id++);
    iph->ttl      = ip_select_ttl(inet, &rt->dst);
    iph->protocol = sk->sk_protocol;
    iph->saddr    = fl4->saddr;
    iph->daddr    = fl4->daddr;
    ip_send_check(iph);  // compute checksum

    // Netfilter: NF_INET_LOCAL_OUT hook (OUTPUT chain)
    return NF_HOOK(NFPROTO_IPV4, NF_INET_LOCAL_OUT, sk, skb, NULL,
                   rt->dst.dev, dst_output);
}
```

## Phase 5: Netfilter OUTPUT and routing

`dst_output()` calls `ip_output()`:

```c
// net/ipv4/ip_output.c:428
int ip_output(struct net *net, struct sock *sk, struct sk_buff *skb)
{
    struct net_device *dev = skb_dst(skb)->dev;
    skb->dev = dev;
    skb->protocol = htons(ETH_P_IP);

    // Netfilter: NF_INET_POST_ROUTING hook (POSTROUTING chain)
    // (SNAT happens here)
    return NF_HOOK_COND(NFPROTO_IPV4, NF_INET_POST_ROUTING, sk, skb,
                        NULL, dev, ip_finish_output, ...);
}

static int ip_finish_output(struct net *net, struct sock *sk, struct sk_buff *skb)
{
    // Fragmentation if needed (skb->len > dev->mtu)
    if (skb->len > ip_skb_dst_mtu(sk, skb))
        return ip_fragment(net, sk, skb, mtu, ip_finish_output2);

    return ip_finish_output2(net, sk, skb);
}
```

## Phase 6: ARP and Ethernet — neigh_output()

`ip_finish_output2()` resolves the next-hop MAC address:

```c
// net/ipv4/ip_output.c
static int ip_finish_output2(struct net *net, struct sock *sk, struct sk_buff *skb)
{
    struct neighbour *neigh;

    // Neighbour lookup (ARP table)
    neigh = ip_neigh_for_gw(rt, skb, &is_v6gw);

    // neigh->output = neigh_hh_output() if MAC known (fast path)
    // → adds Ethernet header and calls dev_queue_xmit()
    // If neighbour not resolved, triggers ARP and queues packet
    return neigh_output(neigh, skb, is_v6gw);
}
```

If the ARP entry doesn't exist, an ARP request is sent and the packet is queued until the reply arrives.

## Phase 7: Traffic control — dev_queue_xmit()

```c
// net/core/dev.c
int dev_queue_xmit(struct sk_buff *skb)
{
    struct net_device *dev = skb->dev;
    struct netdev_queue *txq;

    // Select transmit queue (XPS: Transmit Packet Steering)
    txq = netdev_core_pick_tx(dev, skb, ...);

    // Pass through qdisc (traffic control, rate limiting)
    // Default: pfifo_fast (priority FIFO)
    // Custom: tbf, htb, fq_codel, etc.
    rc = __dev_xmit_skb(skb, q, dev, txq);
    // q->enqueue() → q->dequeue() → dev_hard_start_xmit()
}
```

The qdisc can:
- Drop packets (rate limiting via TBF, policing)
- Reorder packets (FQ scheduling)
- Delay packets (netem for testing)
- Shape traffic (HTB, TBF)

## Phase 8: Driver DMA — ndo_start_xmit()

```c
// Driver implementation
static netdev_tx_t my_nic_xmit(struct sk_buff *skb, struct net_device *dev)
{
    // Map skb data for DMA
    dma_addr = dma_map_single(dev, skb->data, skb->len, DMA_TO_DEVICE);

    // Write descriptor to TX ring
    ring->desc[tail].dma_addr = dma_addr;
    ring->desc[tail].len = skb->len;
    ring->desc[tail].cmd = CMD_EOP | CMD_IFCS;  // end of packet, insert FCS

    // Advance ring tail
    ring->tail = (tail + 1) % ring->size;

    // Ring doorbell: notify NIC of new descriptor
    writel(ring->tail, ring->tail_reg);

    return NETDEV_TX_OK;
}
```

After the NIC transmits the packet, it generates a TX completion interrupt. The driver then calls `dev_consume_skb_any(skb)` to free the `sk_buff`.

## TX completion and write space wakeup

```c
// TX completion interrupt handler
static void my_nic_tx_clean(struct my_nic_ring *ring)
{
    while (ring->next_to_clean != ring->next_to_use) {
        skb = ring->tx_buf[ring->next_to_clean].skb;
        dma_unmap_single(...);
        dev_consume_skb_any(skb);  // free sk_buff
        ring->next_to_clean++;
    }
    // If socket send buffer freed up, wake the writer
    netif_wake_queue(ring->dev);
}
```

`netif_wake_queue()` eventually calls `sk->sk_write_space(sk)`, waking any task blocked in `sendmsg()` waiting for send buffer space.

## Send buffer and backpressure

The kernel won't copy more data than the send buffer allows:

```bash
# Default TCP send buffer sizes [min, default, max]
cat /proc/sys/net/ipv4/tcp_wmem
# → 4096 16384 4194304

# Per-socket override
setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &size, sizeof(size));

# Check current usage (Send-Q column)
ss -tn  # non-zero Send-Q = data in send buffer, waiting to be transmitted
```

If `sk->sk_wmem_alloc >= sk->sk_sndbuf`, `tcp_sendmsg()` blocks until TX completions free up space.

## Further reading

- [sk_buff](sk-buff.md) — The packet structure built in tcp_sendmsg
- [Life of a Packet (receive)](life-of-packet-rx.md) — The inbound path
- [TCP Implementation](tcp.md) — Congestion control and window management
- [Socket Layer Overview](socket-layer.md) — The sendmsg dispatch chain
- [TC and qdisc](tc-qdisc.md) — Traffic control in Phase 7
