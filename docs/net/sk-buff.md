# sk_buff: The Network Buffer

> The central data structure of the Linux network stack

## What sk_buff is

`struct sk_buff` (socket buffer) is how the kernel represents a network packet. Every packet — from the moment it arrives from hardware to the moment it's delivered to a socket — lives in an `sk_buff`.

The structure has two parts:
1. **Metadata header**: pointers, length fields, protocol info, timestamps
2. **Data buffer**: the actual packet bytes (pointed to, not embedded)

Understanding `sk_buff` is fundamental to understanding the entire network stack, since every layer operates on it.

## Memory layout

```
sk_buff metadata:
┌──────────────────────────────────────┐
│ next, prev  (list linkage)           │
│ sk          (owning socket)          │
│ dev         (network device)         │
│ len, data_len                        │
│ protocol, cloned, ...                │
│ head, data, tail, end (data ptrs)    │
│ cb[48]      (layer-private scratch)  │
│ ...                                  │
└──────────────────────────────────────┘

Packet data buffer (allocated separately):
 ┌─────────────┬───────────────────────────────────────┬────────┐
 │  headroom   │  packet data (data ... tail)           │  end   │
 └─────────────┴───────────────────────────────────────┴────────┘
 ↑ head        ↑ data                           ↑ tail           ↑ end

As headers are added (push down the stack):
  data moves left: skb_push()
As headers are consumed (pop up the stack):
  data moves right: skb_pull()
```

The `headroom` is reserved space before `data` — lower layers (ethernet, IP) push their headers into headroom as the packet goes down the stack. This avoids copying.

## struct sk_buff key fields

```c
// include/linux/skbuff.h
struct sk_buff {
    // List linkage (in queues, hash chains)
    struct sk_buff  *next;
    struct sk_buff  *prev;

    struct sock     *sk;        // owning socket (or NULL for forwarded packets)
    struct net_device *dev;     // network device this packet arrived on / will go out

    ktime_t         tstamp;     // packet timestamp

    // Per-layer scratch space: each layer stores its own data here.
    // Only valid while the packet is at that layer.
    char            cb[48] __aligned(8);

    unsigned int    len;        // total length (linear + paged data)
    unsigned int    data_len;   // paged data length (scatter-gather)
    __u16           mac_len;    // MAC header length
    __u16           hdr_len;    // cloned header length

    __u8            cloned:1;   // shares data with another skb
    __u8            head_frag:1; // head is a page fragment (not kmalloc)
    __u8            pp_recycle:1; // owned by page_pool

    // Protocol info
    __be16          protocol;   // Ethernet type (ETH_P_IP, ETH_P_IPV6, ...)
    __u16           transport_header;  // offset to L4 header
    __u16           network_header;    // offset to L3 header (IP)
    __u16           mac_header;        // offset to L2 header (Ethernet)

    // Data pointers
    sk_buff_data_t  tail;       // end of linear data
    sk_buff_data_t  end;        // end of buffer (hard limit)
    unsigned char   *head;      // start of buffer
    unsigned char   *data;      // start of valid data

    unsigned int    truesize;   // total memory charged to socket

    // Paged data (for large packets, scatter-gather)
    skb_frag_t      frags[MAX_SKB_FRAGS]; // page fragments
    // ...
};
```

## Data pointer manipulation

```c
// Push data onto the front (add a header going down the stack)
void *skb_push(struct sk_buff *skb, unsigned int len)
{
    skb->data -= len;
    skb->len += len;
    return skb->data;
}

// Pull data off the front (consume a header going up the stack)
void *skb_pull(struct sk_buff *skb, unsigned int len)
{
    skb->data += len;
    skb->len -= len;
    return skb->data;
}

// Add data at the end
void *skb_put(struct sk_buff *skb, unsigned int len)
{
    void *tmp = skb_tail_pointer(skb);
    skb->tail += len;
    skb->len += len;
    return tmp;
}
```

## Header access macros

```c
// Get pointer to L2/L3/L4 headers
static inline struct ethhdr *eth_hdr(const struct sk_buff *skb)
{
    return (struct ethhdr *)skb_mac_header(skb);
}

static inline struct iphdr *ip_hdr(const struct sk_buff *skb)
{
    return (struct iphdr *)skb_network_header(skb);
}

static inline struct tcphdr *tcp_hdr(const struct sk_buff *skb)
{
    return (struct tcphdr *)skb_transport_header(skb);
}

// Example: reading the destination IP from a received packet
struct iphdr *iph = ip_hdr(skb);
__be32 dst = iph->daddr;
```

## The cb[] scratch area

Each layer has 48 bytes of private storage in `cb[]`. This is a critical design — it avoids separate allocations for per-layer metadata:

```c
// TCP uses cb[] to store TCP-specific info
struct tcp_skb_cb {
    union {
        struct inet_skb_parm    h4;
        struct inet6_skb_parm   h6;
    } header;
    __u32   seq;            // Starting sequence number
    __u32   end_seq;        // SEQ + FIN + SYN + datalen
    __u8    tcp_flags;      // TCP header flags
    __u8    sacked;         // State of sack bits
    // ...
};
#define TCP_SKB_CB(__skb)    ((struct tcp_skb_cb *)&((__skb)->cb[0]))

// Usage:
TCP_SKB_CB(skb)->seq = tcp_seq;
```

## Cloning and sharing

`skb_clone()` creates a new `sk_buff` that shares the same data buffer. The `cloned` bit is set on both. Useful for sending the same packet to multiple consumers (e.g., packet sockets + forwarding):

```c
struct sk_buff *clone = skb_clone(skb, GFP_ATOMIC);
// clone->data and skb->data point to the same buffer
// modifying headers requires skb_copy_expand() first
```

`skb_copy()` creates a full independent copy.

## Fragmented packets (scatter-gather)

For large packets (e.g., TCP offload), data may span multiple pages:

```c
struct sk_buff {
    // Linear portion: head...tail
    // Paged portion:
    skb_frag_t frags[MAX_SKB_FRAGS];
    // data_len = total length of paged portions
    // len = linear + paged
};

// Total accessible data:
// skb->data ... skb->tail  (linear)
// + frags[0] ... frags[nr_frags-1]  (paged)
```

Functions like `skb_linearize()` collapse paged data into the linear portion when a driver doesn't support scatter-gather.

## Allocation and freeing

```c
// Allocate a new sk_buff with headroom for headers
struct sk_buff *alloc_skb(unsigned int size, gfp_t priority);

// Allocate from network allocator (uses page_pool for RX paths)
struct sk_buff *napi_alloc_skb(struct napi_struct *napi, unsigned int length);

// Free the sk_buff (decrements refcount, frees when zero)
void kfree_skb(struct sk_buff *skb);

// Free without error accounting (normal path)
void consume_skb(struct sk_buff *skb);
```

`truesize` is charged to the socket's receive buffer (`sk->sk_rmem_alloc`). If the socket buffer fills up, new packets are dropped.

## Further reading

- [Socket Layer Overview](socket-layer.md) — How sk_buff connects to sockets
- [Network Device and NAPI](napi.md) — How sk_buffs are allocated during receive
- [Life of a Packet (receive)](life-of-packet-rx.md) — Full receive path using sk_buff
- [Life of a Packet (transmit)](life-of-packet-tx.md) — Full transmit path
