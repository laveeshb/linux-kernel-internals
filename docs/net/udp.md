# UDP Socket Internals

> struct udp_sock, sendmsg/recvmsg paths, UDP segmentation offload, and multicast

## UDP in the kernel

UDP is connectionless: there is no handshake, no retransmission, no flow control. The kernel's job is minimal — add a UDP header and hand the packet to IP.

```
Application:
    sendto(fd, buf, len, 0, &dest, sizeof(dest))
         │
    ┌────▼────────────────────────────────────────────────────┐
    │ sock_sendmsg → udp_sendmsg                              │
    │   1. Build sk_buff                                      │
    │   2. Set UDP header (src port, dst port, len, checksum) │
    │   3. ip_make_skb → route lookup                         │
    │   4. udp_send_skb → ip_send_skb                         │
    └─────────────────────────────────────────────────────────┘
         │
    IP layer → routing → Ethernet → wire
```

## struct udp_sock

```c
/* include/linux/udp.h */
struct udp_sock {
    /* inet_sock must be first: */
    struct inet_sock inet;   /* contains: struct sock sk as first member */

    int       pending;       /* Any pending frames? */
    unsigned int corkflag;   /* Cork by setting UDP_CORK socket option */
    __u8      encap_type;    /* Is this a UDP encap socket? */
    unsigned char no_check6_tx:1, no_check6_rx:1;
    unsigned char encap_enabled:1;
    unsigned char gro_enabled:1;
    unsigned char accept_udp_l4:1;
    unsigned char accept_udp_fraglist:1;

    __u16     len;           /* total length of pending frames */
    __u16     gso_size;      /* UDP GSO fragment size */

    /* Receive path: */
    int       (*encap_rcv)(struct sock *sk, struct sk_buff *skb);
    int       (*encap_err_rcv)(struct sock *sk, struct sk_buff *skb, int err,
                               __be16 port, u32 info, u8 *payload);
    void      (*encap_destroy)(struct sock *sk);
    struct sk_buff *(*gro_receive)(struct sock *sk, struct list_head *head,
                                   struct sk_buff *skb);
    int       (*gro_complete)(struct sock *sk, struct sk_buff *skb, int nhoff);
};
```

## UDP send path

### udp_sendmsg

```c
/* net/ipv4/udp.c */
int udp_sendmsg(struct sock *sk, struct msghdr *msg, size_t len)
{
    struct inet_sock *inet = inet_sk(sk);
    struct udp_sock  *up   = udp_sk(sk);
    struct flowi4     fl4;
    struct rtable    *rt = NULL;
    struct sk_buff   *skb;

    /* 1. Determine destination address and port */
    if (msg->msg_name) {
        struct sockaddr_in *usin = (struct sockaddr_in *)msg->msg_name;
        daddr = usin->sin_addr.s_addr;
        dport = usin->sin_port;
    } else {
        /* Connected socket: use cached dst */
        daddr = inet->inet_daddr;
        dport = inet->inet_dport;
    }

    /* 2. Route lookup */
    flowi4_init_output(&fl4, sk->sk_bound_dev_if, sk->sk_mark,
                       tos, RT_SCOPE_UNIVERSE, IPPROTO_UDP,
                       sk->sk_flags, daddr, saddr, dport, sport, ...);
    rt = ip_route_output_flow(net, &fl4, sk);

    /* 3. Build the sk_buff with UDP header + data */
    skb = ip_make_skb(sk, &fl4, getfrag, msg, ulen,
                      sizeof(struct udphdr), &ipc, &rt,
                      msg->msg_flags);

    /* 4. Add UDP header */
    struct udphdr *uh = udp_hdr(skb);
    uh->source = inet->inet_sport;
    uh->dest   = dport;
    uh->len    = htons(ulen);
    uh->check  = 0;  /* compute checksum below */

    /* 5. Compute checksum (or offload to hardware) */
    udp4_hwcsum(skb, fl4.saddr, fl4.daddr);

    /* 6. Hand to IP */
    return udp_send_skb(skb, &fl4, &cork.base);
}
```

### UDP corking (MSG_MORE)

```c
/* Corking: accumulate data before sending (like TCP_CORK) */
setsockopt(fd, IPPROTO_UDP, UDP_CORK, &one, sizeof(one));
/* or MSG_MORE flag on each sendmsg: */

/* Multiple small sendmsg calls → one UDP packet: */
sendmsg(fd, &msg1, MSG_MORE);  /* buffered */
sendmsg(fd, &msg2, MSG_MORE);  /* buffered */
sendmsg(fd, &msg3, 0);         /* flush: all three sent in one UDP packet */
```

## UDP receive path

### Incoming packet routing

```c
/* net/ipv4/udp.c */
int udp_rcv(struct sk_buff *skb)
{
    return __udp4_lib_rcv(skb, &udp_table, IPPROTO_UDP);
}

static int __udp4_lib_rcv(struct sk_buff *skb, struct udp_table *udptable,
                            int proto)
{
    struct udphdr *uh = udp_hdr(skb);
    __be32 saddr = ip_hdr(skb)->saddr;
    __be32 daddr = ip_hdr(skb)->daddr;
    __u16  ulen  = ntohs(uh->len);

    /* 1. Validate UDP header and checksum */
    if (udp4_csum_init(skb, uh, proto))
        goto csum_error;

    /* 2. Lookup socket by dst port/addr (hash table) */
    sk = __udp4_lib_lookup_skb(skb, uh->source, uh->dest, udptable);
    if (sk)
        return udp_unicast_rcv_skb(sk, skb, uh);

    /* 3. No socket found — send ICMP port unreachable */
    icmp_send(skb, ICMP_DEST_UNREACH, ICMP_PORT_UNREACH, 0);
    return 0;
}
```

### Delivering to socket receive queue

```c
static int udp_queue_rcv_one_skb(struct sock *sk, struct sk_buff *skb)
{
    struct udp_sock *up = udp_sk(sk);

    /* Run BPF socket filter if installed */
    if (sk_filter_trim_cap(sk, skb, sizeof(struct udphdr)))
        goto drop;

    /* Enqueue to sk->sk_receive_queue */
    if (likely(sk_receive_skb(sk, skb, 1) == NET_RX_SUCCESS))
        return 0;

    return -1;
}

/* recvmsg: userspace reads from the queue */
int udp_recvmsg(struct sock *sk, struct msghdr *msg, size_t len, ...)
{
    struct sk_buff *skb;

    /* Wait for and dequeue a packet */
    skb = __skb_recv_udp(sk, flags, &off, &err);
    if (!skb)
        return err;

    /* Copy to userspace */
    copied = skb->len - sizeof(struct udphdr) - off;
    err = skb_copy_datagram_msg(skb, sizeof(struct udphdr) + off, msg, copied);

    /* Return source address if requested (MSG_NAME) */
    if (msg->msg_name) {
        struct sockaddr_in *sin = (struct sockaddr_in *)msg->msg_name;
        sin->sin_addr.s_addr = ip_hdr(skb)->saddr;
        sin->sin_port        = udp_hdr(skb)->source;
    }

    return copied;
}
```

## UDP socket hash table

```c
/* Sockets are stored in a hash table keyed by local port: */
struct udp_table {
    struct udp_hslot    *hash;      /* hash by port */
    struct udp_hslot    *hash2;     /* hash by port+addr (4-tuple) */
    unsigned int         mask;
    unsigned int         log;
};

/* Lookup: */
/* 1. Hash by {dest_port} → candidates list */
/* 2. Check addr match for each candidate */
/* 3. If multiple match, prefer connected sockets (4-tuple match) */
```

## UDP GSO (Generic Segmentation Offload)

For high-throughput UDP (e.g., QUIC, game servers), UDP GSO allows sending multiple UDP payloads in one syscall:

```c
/* Send 10 x 1400-byte UDP datagrams in one syscall: */
char buf[10 * 1400];
fill_data(buf, sizeof(buf));

struct msghdr msg = {};
struct iovec iov = { .iov_base = buf, .iov_len = sizeof(buf) };
msg.msg_iov    = &iov;
msg.msg_iovlen = 1;

/* Destination: */
struct sockaddr_in dest = { .sin_family = AF_INET, .sin_port = htons(9000) };
inet_pton(AF_INET, "192.168.1.1", &dest.sin_addr);
msg.msg_name = &dest;
msg.msg_namelen = sizeof(dest);

/* GSO control message: segment size */
char cmsg_buf[CMSG_SPACE(sizeof(uint16_t))];
struct cmsghdr *cm = (struct cmsghdr *)cmsg_buf;
cm->cmsg_level = SOL_UDP;
cm->cmsg_type  = UDP_SEGMENT;
cm->cmsg_len   = CMSG_LEN(sizeof(uint16_t));
*(uint16_t *)CMSG_DATA(cm) = 1400;  /* segment size */

msg.msg_control    = cmsg_buf;
msg.msg_controllen = sizeof(cmsg_buf);

sendmsg(fd, &msg, 0);
/* Kernel sends 10 separate UDP packets, one syscall! */
```

### UDP GRO (Generic Receive Offload)

```c
/* Enable UDP GRO on receive: */
int one = 1;
setsockopt(fd, SOL_UDP, UDP_GRO, &one, sizeof(one));

/* Now recvmsg with MSG_TRUNC to get the full coalesced buffer */
/* Check cmsg for UDP_GRO segment size */
char cmsg_buf[256];
msg.msg_control    = cmsg_buf;
msg.msg_controllen = sizeof(cmsg_buf);

ssize_t n = recvmsg(fd, &msg, 0);
for (struct cmsghdr *cm = CMSG_FIRSTHDR(&msg); cm;
     cm = CMSG_NXTHDR(&msg, cm)) {
    if (cm->cmsg_level == SOL_UDP && cm->cmsg_type == UDP_GRO) {
        uint16_t seg_size = *(uint16_t *)CMSG_DATA(cm);
        /* n bytes received, each segment is seg_size bytes */
    }
}
```

## Multicast

```c
/* Join a multicast group: */
struct ip_mreq mreq = {
    .imr_multiaddr.s_addr = inet_addr("239.0.0.1"),
    .imr_interface.s_addr = INADDR_ANY,
};
setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, sizeof(mreq));

/* Bind to multicast port: */
struct sockaddr_in addr = {
    .sin_family = AF_INET,
    .sin_port   = htons(5000),
    .sin_addr.s_addr = inet_addr("239.0.0.1"),  /* or INADDR_ANY */
};
bind(fd, (struct sockaddr *)&addr, sizeof(addr));

/* Send to multicast group: */
struct sockaddr_in dest = {
    .sin_family = AF_INET,
    .sin_port   = htons(5000),
    .sin_addr.s_addr = inet_addr("239.0.0.1"),
};
sendto(fd, data, len, 0, (struct sockaddr *)&dest, sizeof(dest));
```

### Kernel multicast delivery

```c
/* net/ipv4/udp.c: deliver to multiple sockets in multicast group */
static int __udp4_lib_mcast_deliver(struct net *net, struct sk_buff *skb,
                                     struct udphdr *uh, ...)
{
    /* Find all sockets subscribed to this group/port */
    struct hlist_head *head = &udptable->hash[hash];
    struct sock *sk;

    sk_for_each_from(sk) {
        /* Check: port matches, multicast group joined, interface matches */
        if (!inet_mc_hash_match(sk, skb))
            continue;
        /* Clone skb for each receiving socket */
        struct sk_buff *skb2 = skb_clone(skb, GFP_ATOMIC);
        udp_queue_rcv_one_skb(sk, skb2);
    }
}
```

## UDP performance tuning

```bash
# Increase receive buffer (reduces drops under load):
sysctl -w net.core.rmem_max=26214400        # 25 MB max
sysctl -w net.core.rmem_default=26214400
sysctl -w net.ipv4.udp_mem="102400 873800 16777216"

# Increase send buffer:
sysctl -w net.core.wmem_max=26214400

# Check UDP drop stats:
cat /proc/net/snmp | grep Udp
# UdpInDatagrams, UdpNoPorts, UdpInErrors, UdpOutDatagrams
# UdpRcvbufErrors: dropped because socket receive buffer full

netstat -su | grep -i error
ss -upe  # show UDP socket stats including drops

# Per-socket stats:
ss -u -n -e | grep ":9000"

# Trace UDP drops:
bpftrace -e '
tracepoint:udp:udp_fail_queue_rcv_skb {
    @drops = count();
}'
```

## Further reading

- [TCP](tcp.md) — connection-oriented transport
- [Socket Layer](socket-layer.md) — socket() create, bind, sendmsg
- [sk_buff](sk-buff.md) — packet data structure
- [NAPI](napi.md) — receive scaling
- [XDP](xdp.md) — bypass kernel for extreme UDP throughput
- `net/ipv4/udp.c` — UDP implementation
