# What Happens When You connect()

> The TCP three-way handshake from a kernel perspective

## Overview

When a client calls `connect()`, the kernel initiates a TCP three-way handshake. The call may block until the connection is established (or timeout/error). The full sequence:

```
Client                                    Server
  │                                          │
connect() →                                  │ (listening on accept())
  tcp_v4_connect()                           │
  → route lookup                             │
  → ephemeral port selection                 │
  → TCP state: SYN_SENT                      │
  → send SYN packet                          │
  │────────────── SYN ─────────────────────→ │
  │                                     tcp_v4_rcv()
  │                                     tcp_rcv_state_process()
  │                                     TCP state: SYN_RECEIVED
  │                                     send SYN-ACK
  │ ←──────────── SYN-ACK ─────────────── │
tcp_v4_rcv()                                 │
tcp_rcv_synsent_state_process()              │
→ TCP state: ESTABLISHED                     │
→ wake up connect()                          │
→ send ACK                                   │
  │────────────── ACK ─────────────────────→ │
  │                                     TCP state: ESTABLISHED
  │                                     sk queued on listen backlog
  │                                     accept() returns new socket
```

## Phase 1: connect() syscall → tcp_v4_connect()

```c
// Userspace
int fd = socket(AF_INET, SOCK_STREAM, 0);
connect(fd, (struct sockaddr *)&addr, sizeof(addr));
```

The syscall path:

```
connect()
  → inet_stream_connect()       [af_inet.c]
    → __inet_stream_connect()
      → sk->sk_prot->connect()  = tcp_v4_connect()
```

## Phase 2: tcp_v4_connect()

```c
// net/ipv4/tcp_ipv4.c:222
int tcp_v4_connect(struct sock *sk, struct sockaddr *uaddr, int addr_len)
{
    struct sockaddr_in *usin = (struct sockaddr_in *)uaddr;

    // 1. Route lookup: find how to reach the destination
    rt = ip_route_connect(fl4, daddr, inet->inet_saddr, ...);

    // 2. Source IP selection (if not bound)
    // fl4->saddr is filled in by the routing subsystem

    // 3. Ephemeral port selection (if not bound)
    err = inet_hash_connect(&tcp_death_row, sk);
    // Picks a source port from ip_local_port_range, checks for conflicts

    // 4. Transition to SYN_SENT state
    tcp_set_state(sk, TCP_SYN_SENT);

    // 5. Start the connect timer (retransmission)
    inet->inet_id = get_random_u16();

    // 6. Send SYN
    err = tcp_connect(sk);
}
```

## Phase 3: tcp_connect() — sending the SYN

```c
// net/ipv4/tcp_output.c:4296
int tcp_connect(struct sock *sk)
{
    struct tcp_sock *tp = tcp_sk(sk);

    // Initialize sequence number (random for security)
    tp->write_seq = secure_tcp_seq(inet->inet_saddr, inet->inet_daddr,
                                   inet->inet_sport, inet->inet_dport);

    // Allocate SYN sk_buff
    buff = sk_stream_alloc_skb(sk, 0, sk->sk_allocation, true);

    // Set up SYN packet
    tcp_init_nondata_skb(buff, tp->write_seq++, TCPHDR_SYN);

    // TCP Fast Open: attach data to SYN if requested
    if (tp->fastopen_req)
        err = tcp_send_syn_data(sk, buff);
    else
        tcp_transmit_skb(sk, buff, 1, sk->sk_allocation);

    // Start retransmit timer
    inet_csk_reset_xmit_timer(sk, ICSK_TIME_RETRANS, inet_csk(sk)->icsk_rto, ...);

    return 0;
}
```

SYN options set in the SYN packet:
- **MSS** (Maximum Segment Size): tells the server the max segment we'll accept
- **WSCALE**: window scaling factor for large windows
- **SACK_PERM**: we support Selective ACK
- **Timestamp**: for RTT measurement and PAWS (Protection Against Wrapped Sequences)

## Phase 4: Server processes SYN → tcp_rcv_state_process()

On the server side:

```c
// net/ipv4/tcp_input.c
int tcp_rcv_state_process(struct sock *sk, struct sk_buff *skb)
{
    // Server in LISTEN state receives SYN:
    case TCP_LISTEN:
        if (th->syn) {
            // Create a request socket (lightweight, not a full sock yet)
            req = inet_reqsk_alloc(rsk_ops, sk, !want_cookie);

            // Record client's ISN, MSS, options
            tcp_parse_options(net, skb, &opt_rx, ...);

            // Start SYN timeout timer (handles half-open connections)
            inet_csk_reqsk_queue_hash_add(sk, req, TCP_TIMEOUT_INIT);

            // Send SYN-ACK
            af_ops->send_synack(sk, dst, &fl, req, ...);
            // → tcp_send_synack() → tcp_transmit_skb()
        }
}
```

The server creates a **request socket** (`struct request_sock`) — a lightweight half-open connection entry. The full `struct sock` is only allocated when the third ACK arrives.

## Phase 5: Client processes SYN-ACK → ESTABLISHED

```c
// net/ipv4/tcp_input.c
static int tcp_rcv_synsent_state_process(struct sock *sk, struct sk_buff *skb, ...)
{
    // Client in SYN_SENT receives SYN-ACK:
    if (th->ack) {
        // Validate ACK number: must ACK our SYN
        if (TCP_SKB_CB(skb)->ack_seq != tp->snd_nxt)
            goto reset_and_undo;

        // Accept server's ISN
        tp->rcv_nxt = TCP_SKB_CB(skb)->seq + 1;

        // Record server's MSS, window scale, SACK support
        tcp_process_options(...);

        // Transition to ESTABLISHED
        tcp_set_state(sk, TCP_ESTABLISHED);

        // Initialize congestion control
        tcp_init_congestion_control(sk);

        // Send ACK (completes the 3-way handshake)
        tcp_send_ack(sk);

        // Wake up connect() — it can return now
        sk->sk_state_change(sk);
        // → wake_up_interruptible(sk->sk_wq)
    }
}
```

`connect()` unblocks and returns 0.

## Phase 6: Server processes ACK → accept() returns

```c
// Server receives the final ACK:
// tcp_rcv_state_process() → TCP_SYN_RECV case
//   → inet_csk(sk)->icsk_af_ops->syn_recv_sock()
//       → tcp_v4_syn_recv_sock()
//           → allocate full struct sock for the new connection
//           → move from request_sock queue to accept queue
//   → sk_acceptq_added()  (increments accept queue length)

// accept() on the server:
accept(listenfd, &addr, &addrlen)
  → inet_accept()
    → sk->sk_prot->accept()  = inet_csk_accept()
      → wait for connection in accept queue
      → dequeue and return new sock
```

## SYN backlog and accept queue

The server maintains two queues:

```
SYN queue (incomplete connections):
  SYN received → request_sock added
  SYN-ACK sent
  ACK received → moved to accept queue

Accept queue (complete connections):
  accept() dequeues from here
```

Controlled by:

```bash
# Maximum accept queue depth (SOMAXCONN)
cat /proc/sys/net/core/somaxconn  # default: 4096

# TCP SYN backlog
cat /proc/sys/net/ipv4/tcp_max_syn_backlog  # default: 512

# listen() second argument sets per-socket accept queue limit
listen(fd, backlog);  # capped at somaxconn
```

A full accept queue → new ACKs are dropped → client retries (appears as connection slowness, not error). A full SYN queue → SYN cookies or SYN drop.

## SYN cookies

Under SYN flood attack, the SYN queue fills. SYN cookies encode connection state in the ISN, avoiding SYN queue entries:

```bash
# Enable SYN cookies (auto-activates under SYN flood)
cat /proc/sys/net/ipv4/tcp_syncookies  # 1 = enabled (default)
```

With SYN cookies, the server doesn't create a request_sock on SYN receipt. Instead, it encodes the connection parameters in the SYN-ACK's sequence number. When the ACK arrives with the valid cookie, the connection is established without ever having been in the SYN queue.

## Ephemeral port selection

```bash
# Range for ephemeral (outbound) ports
cat /proc/sys/net/ipv4/ip_local_port_range
# → 32768 60999  (default)

# Count ports in use
ss -tn | wc -l

# If running out of ports: expand range or use SO_REUSEPORT
echo "1024 65535" > /proc/sys/net/ipv4/ip_local_port_range
```

## Observing the connection

```bash
# See connections in all TCP states
ss -tn state syn-sent
ss -tn state syn-recv  # on server: half-open connections

# Count connections by state
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn

# Trace the handshake
trace-cmd record -e tcp:tcp_rcv_state_process \
                 -e tcp:tcp_send_syn \
                 -e tcp:tcp_send_synack \
                 sleep 5
```

## Further reading

- [Life of a Packet (transmit)](life-of-packet-tx.md) — How the SYN packet is transmitted
- [Life of a Packet (receive)](life-of-packet-rx.md) — How the SYN-ACK is received
- [TCP Implementation](tcp.md) — Congestion control, flow control, retransmission
- [Socket Layer Overview](socket-layer.md) — Socket state machine
