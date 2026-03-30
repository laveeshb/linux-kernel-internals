# TCP Implementation

> How the kernel implements reliable, ordered, byte-stream delivery

## TCP's guarantees

TCP provides:
1. **Reliability**: Lost packets are retransmitted
2. **Ordering**: Out-of-order segments are reordered before delivery
3. **Flow control**: The sender doesn't overwhelm the receiver
4. **Congestion control**: The sender doesn't overwhelm the network

The kernel implements all four simultaneously, which is why TCP is complex.

## struct tcp_sock

TCP state per connection is in `struct tcp_sock` (extends `struct sock`):

```c
// include/linux/tcp.h
struct tcp_sock {
    // Sequence numbers
    u32  rcv_nxt;      // next sequence we expect to receive
    u32  snd_nxt;      // next sequence we'll send
    u32  snd_una;      // oldest unacknowledged byte (send window start)

    // Congestion control
    u32  snd_cwnd;     // congestion window (in MSS units)
    u32  snd_ssthresh; // slow start threshold
    u32  snd_cwnd_cnt; // linear increase counter

    // RTT measurement
    u32  srtt_us;      // smoothed RTT (SRTT) × 8, in microseconds
    u32  mdev_us;      // mean deviation of RTT (for RTO)
    u32  rttvar_us;    // RTT variance

    // Receive window
    u32  rcv_wnd;      // current receive window size
    u32  rcv_ssthresh; // receive window size threshold (small socket buffer)
    u32  window_clamp; // maximum window size

    // SACK state
    struct tcp_sack_block selective_acks[4];  // SACK blocks to advertise
    struct tcp_sack_block recv_sack_cache[4]; // cached SACK received

    // Retransmission
    u32  high_seq;     // snd_nxt at onset of congestion
    u32  undo_marker;  // snd_una upon a new recovery episode

    // Congestion control private data
    // Accessed via tcp_sk(sk)->inet_conn.icsk_ca_priv
    // (64 bytes for algorithm-specific state, e.g., BBR bandwidth samples)
    // ...
};
```

## Sequence numbers and windows

```
Send side:
  snd_una ─── snd_nxt
     │            │
     └── unacked ─┘  (in-flight, waiting for ACK)
         ↑
  snd_una + snd_cwnd = send window limit

Receive side:
  rcv_nxt = next expected byte
  rcv_nxt + rcv_wnd = advertised window limit (flow control)
```

## Retransmission: RTO and timer

The **Retransmission Timeout (RTO)** is calculated from RTT measurements:

```
SRTT = α × SRTT + (1 - α) × RTT_sample   (α = 7/8)
RTTVAR = β × RTTVAR + (1 - β) × |SRTT - RTT|   (β = 3/4)
RTO = SRTT + 4 × RTTVAR   (minimum: 200ms)
```

When a segment is transmitted, a retransmit timer is armed for RTO. If no ACK arrives within RTO:
1. The segment is retransmitted
2. RTO doubles (exponential backoff)
3. `snd_cwnd` is reduced (congestion signal)

```bash
# View TCP retransmit counters
netstat -s | grep retransmit
cat /proc/net/snmp | grep ^Tcp
# TcpRetransSegs: total retransmitted segments
```

## Fast retransmit and SACK

When out-of-order segments arrive, the receiver sends **duplicate ACKs** (same `ack_seq` as before, with a SACK block noting what was received).

Three duplicate ACKs → fast retransmit (before RTO expires):

```c
// net/ipv4/tcp_input.c
static void tcp_fastretrans_alert(struct sock *sk, u32 prior_snd_una, ...)
{
    // 3 duplicate ACKs → enter LOSS recovery
    if (tp->sacked_out >= tp->reordering) {
        tcp_enter_recovery(sk, ...);
        // Retransmit the lost segment immediately
        tcp_retransmit_skb(sk, tcp_rtx_queue_head(sk), 1);
    }
}
```

With **SACK (Selective ACK)**, the receiver tells the sender exactly which segments were received out of order. The sender can retransmit only the gaps:

```bash
# SACK is enabled by default
cat /proc/sys/net/ipv4/tcp_sack  # → 1
```

## Congestion control framework

The kernel has a pluggable congestion control framework:

```c
// include/net/tcp.h
struct tcp_congestion_ops {
    // Classic response: update cwnd on ACK
    void (*cong_avoid)(struct sock *sk, u32 ack, u32 acked);

    // Custom control: full control over cwnd and pacing
    void (*cong_control)(struct sock *sk, u32 ack, int flag,
                         const struct rate_sample *rs);

    // Called when loss is detected: return new ssthresh
    u32  (*ssthresh)(struct sock *sk);

    // Called after loss recovery: restore cwnd
    u32  (*undo_cwnd)(struct sock *sk);

    char name[TCP_CA_NAME_MAX];  // "cubic", "bbr", "reno", etc.
};
```

### Available algorithms

```bash
# List available congestion control algorithms
cat /proc/sys/net/ipv4/tcp_available_congestion_control
# cubic reno bbr2 bbr

# Current default
cat /proc/sys/net/ipv4/tcp_congestion_control
# cubic

# Change globally
echo bbr > /proc/sys/net/ipv4/tcp_congestion_control

# Per-socket (requires CAP_NET_ADMIN for some algorithms)
setsockopt(fd, IPPROTO_TCP, TCP_CONGESTION, "bbr", 4);
```

### CUBIC (default)

CUBIC uses the cubic function of time since last congestion event to grow the congestion window:

```
W(t) = C × (t - K)³ + W_max

Where:
  W_max = cwnd at last congestion event
  K = time for cwnd to return to W_max
  C = scaling constant (0.4)
```

- **Slow start**: cwnd grows exponentially until ssthresh
- **Congestion avoidance**: cwnd grows per the cubic function
- **Loss detected**: ssthresh = 0.7 × cwnd; cwnd = ssthresh

### BBR (Bottleneck Bandwidth and RTT)

BBR (Bottleneck Bandwidth and RTT) models the network path — bandwidth and propagation delay — rather than reacting to loss:

```
delivery_rate = bytes_delivered / elapsed_time
BtlBw = max delivery_rate over recent window
RTprop = min RTT over recent window

pacing_rate = 2.77 × BtlBw  (probe phase)
              BtlBw          (drain/PROBE_BW phase)
cwnd = BtlBw × RTprop × 2   (BDP × 2)
```

BBR sends at a **paced rate** matching the bottleneck bandwidth, avoiding buffer bloat that loss-based algorithms create:

```bash
# BBR requires fq qdisc for accurate pacing
echo fq > /sys/class/net/eth0/queues/tx-0/tx_queue_len  # not quite right
tc qdisc replace dev eth0 root fq
echo bbr > /proc/sys/net/ipv4/tcp_congestion_control
```

## Flow control: receive window

The receiver's `rcv_wnd` tells the sender how much space remains in the receive buffer. If `rcv_wnd = 0`, the sender stops (zero window probe situation):

```c
// net/ipv4/tcp_output.c
static u16 tcp_select_window(struct sock *sk)
{
    u32 cur_win = tcp_receive_window(tp);
    u32 new_win = __tcp_select_window(sk);

    // Don't shrink the window (can confuse senders)
    if (new_win < cur_win)
        new_win = cur_win;

    return new_win;
}
```

**TCP window scaling** (RFC 1323) allows windows > 65535 bytes by using a shift factor negotiated in SYN/SYN-ACK:

```bash
cat /proc/sys/net/ipv4/tcp_window_scaling  # → 1 (enabled)
```

## Nagle algorithm and TCP_NODELAY

By default, TCP delays small packets hoping to coalesce them (Nagle's algorithm). For latency-sensitive applications:

```c
// Disable Nagle: send immediately even if segment is small
int flag = 1;
setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));
```

```bash
# Check if TCP_NODELAY is set
ss -tni | grep nodelay
```

## Key TCP sysctls

```bash
# Initial congestion window (in MSS units, default 10 per RFC 6928)
cat /proc/sys/net/ipv4/tcp_init_cwnd  # Linux uses 10 by default

# Maximum retransmits before giving up
cat /proc/sys/net/ipv4/tcp_retries2  # default: 15 (≈924s timeout)

# TIME_WAIT sockets: allow fast reuse
echo 1 > /proc/sys/net/ipv4/tcp_tw_reuse  # reuse for new outgoing connections

# Keep-alive probes
cat /proc/sys/net/ipv4/tcp_keepalive_time     # 7200s (2h)
cat /proc/sys/net/ipv4/tcp_keepalive_probes   # 9 probes
cat /proc/sys/net/ipv4/tcp_keepalive_intvl    # 75s between probes

# Buffer auto-tuning [min, default, max]
cat /proc/sys/net/ipv4/tcp_rmem
cat /proc/sys/net/ipv4/tcp_wmem
```

## Inspecting TCP connections

```bash
# Detailed TCP socket info (shows congestion state, cwnd, etc.)
ss -tni

# Example output:
# State Recv-Q Send-Q  Local Address:Port  Peer Address:Port
# ESTAB 0      0       10.0.0.1:22         10.0.0.2:54321
#  cubic wscale:7,7 rto:208 rtt:4.5/0.75 ato:40 mss:1448 pmtu:1500
#  rcvmss:931 advmss:1448 cwnd:10 ssthresh:2147483647 bytes_sent:12345
#  segs_out:456 segs_in:234 data_segs_out:123 send 25.7Mbps
#  lastrcv:100ms lastack:50ms pacing_rate 51.4Mbps delivery_rate 25.7Mbps

# Per-connection retransmit info
ss -tin | grep retrans

# TCP statistics
netstat -s | grep -E "connection|segment|retransmit"
```

## Further reading

- [TCP Congestion Control Algorithms](tcp-congestion.md) — CUBIC and BBR in depth (see below)
- [Life of a Packet (transmit)](life-of-packet-tx.md) — How tcp_write_xmit uses cwnd
- [What Happens When You connect()](connect.md) — Handshake and initial window setup
- [Socket Layer Overview](socket-layer.md) — The socket buffer that feeds tcp_sendmsg
