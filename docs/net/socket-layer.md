# Socket Layer Overview

> How the kernel maps userspace socket calls to protocol implementations

## The socket abstraction

A socket is a bidirectional communication endpoint. From userspace, it's just a file descriptor. Internally, it's a stack of three structures:

```
userspace:   fd (int)
             ↓
kernel VFS:  struct file → f_op = socket_file_ops
             ↓
socket:      struct socket (VFS view: state, type, proto_ops)
             ↓
sock:        struct sock (protocol view: receive queues, buffers, state machine)
             ↓
protocol:    struct proto (TCP/UDP/RAW-specific operations)
```

## struct socket — the VFS-facing layer

```c
// include/linux/net.h
struct socket {
    socket_state        state;   // SS_FREE, SS_UNCONNECTED, SS_CONNECTING,
                                  // SS_CONNECTED, SS_DISCONNECTING
    short               type;    // SOCK_STREAM, SOCK_DGRAM, SOCK_RAW, ...
    unsigned long       flags;
    struct file         *file;   // associated file (for fd → socket lookup)
    struct sock         *sk;     // the protocol-level socket
    const struct proto_ops *ops; // VFS-to-protocol dispatch table
    struct socket_wq    wq;      // wait queue for poll/select
};
```

`proto_ops` is the dispatch table mapping socket syscalls to protocol code:

```c
// include/linux/net.h
struct proto_ops {
    int family;
    int (*bind)     (struct socket *, struct sockaddr *, int);
    int (*connect)  (struct socket *, struct sockaddr *, int, int);
    int (*accept)   (struct socket *, struct socket *, struct proto_accept_arg *);
    int (*listen)   (struct socket *, int);
    int (*sendmsg)  (struct socket *, struct msghdr *, size_t);
    int (*recvmsg)  (struct socket *, struct msghdr *, size_t, int);
    int (*setsockopt)(struct socket *, int, int, sockptr_t, unsigned int);
    int (*getsockopt)(struct socket *, int, int, char __user *, int __user *);
    int (*shutdown) (struct socket *, int);
    // ...
};
```

For TCP/IPv4, `proto_ops = inet_stream_ops`. For UDP, `proto_ops = inet_dgram_ops`. For AF_UNIX, `proto_ops = unix_stream_ops`.

## struct sock — the protocol-facing layer

```c
// include/net/sock.h
struct sock {
    struct sock_common __sk_common; // address/port/family/state
    // Common macros expose these fields:
    // sk_daddr, sk_rcv_saddr  (IPv4 addresses)
    // sk_dport, sk_num        (ports)
    // sk_state                (TCP_ESTABLISHED, TCP_CLOSE_WAIT, ...)
    // sk_prot                 (points to struct proto)

    // Receive path
    struct sk_buff_head sk_receive_queue; // received but not yet read
    struct {
        atomic_t rmem_alloc;
        struct sk_buff *head, *tail;
    } sk_backlog;               // packets arrived while lock was held

    // Memory limits
    int           sk_rcvbuf;    // receive buffer size limit
    int           sk_sndbuf;    // send buffer size limit
    atomic_t      sk_rmem_alloc; // currently allocated for receive
    atomic_t      sk_wmem_alloc; // currently allocated for send

    // Callbacks (set by protocol)
    void    (*sk_data_ready)(struct sock *sk);    // data arrived
    void    (*sk_write_space)(struct sock *sk);   // send buffer freed up
    void    (*sk_state_change)(struct sock *sk);  // TCP state changed
    void    (*sk_error_report)(struct sock *sk);  // error (ICMP, etc.)

    // Protocol-specific extension (TCP uses tcp_sock, etc.)
    // Accessed by container_of() from the protocol layer
};
```

## struct proto — the protocol implementation

Each protocol registers a `struct proto` that contains the actual work:

```c
// include/net/sock.h
struct proto {
    void  (*close)     (struct sock *, long timeout);
    int   (*connect)   (struct sock *, struct sockaddr *, int);
    int   (*disconnect)(struct sock *, int);
    struct sock *(*accept)(struct sock *, struct proto_accept_arg *);
    int   (*sendmsg)   (struct sock *, struct msghdr *, size_t);
    int   (*recvmsg)   (struct sock *, struct msghdr *, size_t, int, int *);
    int   (*backlog_rcv)(struct sock *, struct sk_buff *);  // process backlog
    int   (*hash)      (struct sock *);   // add to protocol hash table
    void  (*unhash)    (struct sock *);
    int   (*get_port)  (struct sock *, unsigned short);     // port binding
    char  name[32];   // "TCP", "UDP", "RAW"
    // ...
};
```

TCP: `struct proto tcp_prot` at `net/ipv4/tcp_ipv4.c`
UDP: `struct proto udp_prot` at `net/ipv4/udp.c`

## Creating a socket: socket(2)

```
socket(AF_INET, SOCK_STREAM, 0)
    → sys_socket()
        → sock_create()
            → __sock_create()
                → net_families[AF_INET]->create()  # = inet_create()
                    → allocate struct socket + struct sock (tcp_sock)
                    → set sock->sk_prot = &tcp_prot
                    → set sock->ops = &inet_stream_ops
                    → tcp_prot.init(sk)
        → sock_map_fd()  # install in fd table
```

## The two dispatch levels

The double-layer dispatch (proto_ops → proto) exists because:

- `proto_ops` handles the **VFS interface** (file descriptor semantics, socket states, address family dispatch)
- `proto` handles the **protocol implementation** (TCP state machine, UDP demux, etc.)

A single layer can't serve both: `sendmsg()` on a TCP socket needs different behavior from `sendmsg()` on a UDP socket, but both go through the same VFS file operations.

## Receive path: how data reaches the socket

```
NIC interrupt → NAPI poll → __netif_receive_skb()
    → IP input → TCP/UDP demux → socket lookup
        → sk->sk_receive_queue or sk->sk_backlog
            → sk->sk_data_ready(sk)   # wake up reader
                → sock_def_readable() → wake_up_interruptible(&sk->sk_wq)
                    → read()/recv() returns data
```

The `sk_backlog` handles the case where a packet arrives while the socket lock is held (e.g., during another syscall). Packets are held in the backlog and processed when the lock is released.

## Socket buffers and memory

```bash
# Default receive/send buffer sizes
cat /proc/sys/net/core/rmem_default  # bytes
cat /proc/sys/net/core/wmem_default

# Maximum (upper bound for setsockopt SO_RCVBUF/SO_SNDBUF)
cat /proc/sys/net/core/rmem_max
cat /proc/sys/net/core/wmem_max

# TCP-specific auto-tuning range [min, default, max]
cat /proc/sys/net/ipv4/tcp_rmem
cat /proc/sys/net/ipv4/tcp_wmem
```

`sk->sk_rmem_alloc` tracks memory currently held in `sk_receive_queue`. When it exceeds `sk_rcvbuf`, new packets are dropped (kernel silently drops them, returning 0 bytes to the application if it doesn't read fast enough).

## Socket state machine (TCP)

```
                   connect()
                      ↓
    CLOSE → SYN_SENT → ESTABLISHED → FIN_WAIT_1 → FIN_WAIT_2 → TIME_WAIT → CLOSE
                                  ↘ CLOSE_WAIT → LAST_ACK → CLOSE

                                  accept() returns when: LISTEN → ESTABLISHED
```

`sk->sk_state` (accessed via `sk->__sk_common.skc_state`) tracks this. The TCP protocol implementation transitions these states and calls `sk->sk_state_change()` to notify waiting pollers.

## Inspecting sockets

```bash
# List all TCP sockets
ss -tnap

# Show socket memory usage
ss -tm

# Show internal kernel state for a socket (Linux 5.1+)
ss --diag

# /proc/net/tcp shows socket table
cat /proc/net/tcp  # hex: local_addr:port remote_addr:port state tx_queue rx_queue uid

# Count sockets by state
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn
```

## Further reading

- [sk_buff](sk-buff.md) — The packet structure passed between layers
- [Network Device and NAPI](napi.md) — How packets arrive from hardware
- [Life of a Packet (receive)](life-of-packet-rx.md) — Full path from NIC to socket
- [TCP Implementation](tcp.md) — TCP state machine and congestion control
