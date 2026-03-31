# TCP Congestion Control

> How the kernel decides how fast to send: CUBIC, BBR, and the cc_ops interface

## What congestion control does

TCP congestion control governs the **congestion window (cwnd)** — the maximum number of unacknowledged bytes in flight:

```
Throughput ≈ min(rwnd, cwnd) / RTT

rwnd: receiver's advertised window (flow control)
cwnd: sender's estimate of network capacity (congestion control)
```

The congestion controller runs on the sender and responds to:
- **ACK received**: increase cwnd (network has capacity)
- **Loss detected**: decrease cwnd (congestion)
- **ECN (Explicit Congestion Notification)**: decrease cwnd before loss

## struct tcp_congestion_ops: the cc interface

All congestion control algorithms implement this interface:

```c
/* include/net/tcp.h */
struct tcp_congestion_ops {
    /* Required */
    u32  (*ssthresh)(struct sock *sk);      /* set ssthresh after loss */
    void (*cong_avoid)(struct sock *sk,
                        u32 ack, u32 acked); /* increase cwnd on ACK */

    /* Optional */
    void (*set_state)(struct sock *sk, u8 new_state);
    void (*cwnd_event)(struct sock *sk, enum tcp_ca_event ev);
    void (*in_ack_event)(struct sock *sk, u32 flags);
    u32  (*undo_cwnd)(struct sock *sk);
    void (*pkts_acked)(struct sock *sk,
                        const struct ack_sample *sample);
    u32  (*min_tso_segs)(struct sock *sk);
    void (*cong_control)(struct sock *sk, const struct rate_sample *rs);
    u32  (*get_info)(struct sock *sk, u32 ext,
                      int *attr, union tcp_cc_info *info);

    char         name[TCP_CA_NAME_MAX];
    struct module *owner;
    u32           key;
    u32           flags;
};
```

### Registering an algorithm

```c
/* net/ipv4/tcp_cubic.c */
static struct tcp_congestion_ops cubictcp __read_mostly = {
    .init        = bictcp_init,
    .ssthresh    = bictcp_recalc_ssthresh,
    .cong_avoid  = bictcp_cong_avoid,
    .set_state   = bictcp_state,
    .undo_cwnd   = tcp_reno_undo_cwnd,
    .cwnd_event  = bictcp_cwnd_event,
    .pkts_acked  = bictcp_acked,
    .owner       = THIS_MODULE,
    .name        = "cubic",
};

static int __init cubictcp_register(void)
{
    BUILD_BUG_ON(sizeof(struct bictcp) > ICSK_CA_PRIV_SIZE);
    return tcp_register_congestion_control(&cubictcp);
}
```

### Per-socket congestion control data

Each socket has `ICSK_CA_PRIV_SIZE` bytes (128 bytes = 16 × u64) for algorithm-specific state:

```c
struct tcp_sock *tp = tcp_sk(sk);
struct bictcp *ca = inet_csk_ca(sk);  /* points to icsk_ca_priv */
```

## TCP Reno: the baseline

Reno is the simplest correct algorithm, required by all TCP implementations:

```
Slow Start:
  cwnd starts at IW (≈10 segments)
  Each ACK: cwnd += 1 MSS  (exponential growth)
  Until cwnd >= ssthresh

Congestion Avoidance (AIMD):
  Each RTT: cwnd += 1 MSS  (linear growth, "AI" = Additive Increase)

Loss detected (triple duplicate ACKs):
  ssthresh = cwnd / 2
  cwnd = ssthresh  (fast recovery)
  ("MD" = Multiplicative Decrease)

Timeout (RTO):
  ssthresh = cwnd / 2
  cwnd = 1 MSS  (slow start restart)
```

```c
/* net/ipv4/tcp_cong.c - Reno implementation */
void tcp_reno_cong_avoid(struct sock *sk, u32 ack, u32 acked)
{
    struct tcp_sock *tp = tcp_sk(sk);

    if (!tcp_is_cwnd_limited(sk))
        return;

    if (tcp_in_slow_start(tp)) {
        /* Slow start: grow by acked segments */
        acked = tcp_slow_start(tp, acked);
        if (!acked)
            return;
    }
    /* Congestion avoidance: cwnd += 1 MSS per RTT */
    tcp_cong_avoid_ai(tp, tp->snd_cwnd, acked);
}
```

## CUBIC: the Linux default

CUBIC replaces the linear increase of Reno with a **cubic function** of time since the last congestion event. This allows much faster window growth at high bandwidth-delay products.

```
CUBIC window function:
  W(t) = C × (t - K)³ + Wmax

  t    = time since last congestion event
  K    = time to reach Wmax (origin point)
  Wmax = window at last congestion
  C    = scaling factor (typically 0.4)

    cwnd
      │        ╭─── new Wmax
  Wmax│───╮   ╭
      │    ╰─╯  concave/convex cubic curve
      │
      └────────────── time
           K
```

The cubic shape means CUBIC:
- Grows quickly far below Wmax (catching up after loss)
- Slows near Wmax (probing carefully)
- Overshoots if Wmax was limited by receiver

```c
/* net/ipv4/tcp_cubic.c */
struct bictcp {
    u32 cnt;           /* increase cwnd by 1 after ACKs */
    u32 last_max_cwnd; /* Wmax: last maximum snd_cwnd */
    u32 last_cwnd;
    u32 last_time;
    u32 bic_origin_point; /* origin point of bic function */
    u32 bic_K;            /* time to origin point */
    u32 delay_min;        /* min delay (msec << 3) */
    u32 epoch_start;      /* beginning of an epoch */
    u32 ack_cnt;          /* number of acks */
    u32 tcp_cwnd;         /* estimated tcp cwnd */
    u16 unused;
    u8  sample_cnt;       /* number of samples to decide curr_rtt */
    u8  found;            /* the exit point is found? */
    u32 round_start;      /* beginning of each round */
    u32 end_seq;          /* end_seq of the round */
    u32 last_ack;         /* last time when the ACK spacing is close */
    u32 curr_rtt;         /* the minimum rtt of current round */
};

static void bictcp_cong_avoid(struct sock *sk, u32 ack, u32 acked)
{
    struct tcp_sock *tp = tcp_sk(sk);
    struct bictcp *ca = inet_csk_ca(sk);

    if (!tcp_is_cwnd_limited(sk))
        return;

    if (tcp_in_slow_start(tp)) {
        if (hystart && after(ack, ca->end_seq))
            bictcp_hystart_reset(sk);  /* HyStart: slow start exit
                                          when delay increases */
        acked = tcp_slow_start(tp, acked);
        if (!acked)
            return;
    }
    bictcp_update(ca, tp->snd_cwnd, acked);
    tcp_cong_avoid_ai(tp, ca->cnt, acked);
}
```

### HyStart++: safe slow start exit

CUBIC uses HyStart to exit slow start before actual loss:
- **Delay increase**: exit when RTT increases by more than a threshold (ACK train delay)
- **ACK train end**: exit when ACK spacing shows the pipe is full

```bash
# Check/set HyStart
sysctl net.ipv4.tcp_cubic_hystart
```

## BBR: bandwidth-based congestion control

BBR (Bottleneck Bandwidth and Round-trip propagation time) takes a fundamentally different approach: instead of reacting to **loss**, it estimates **bandwidth** and **RTT** to set the sending rate directly.

```
BBR's model:
  BtlBw  = bottleneck bandwidth (bytes/sec)
  RTprop = round-trip propagation delay (min RTT)

  Optimal operating point:
    Inflight = BtlBw × RTprop
    Rate = BtlBw

BBR phases:
  STARTUP:       probe bandwidth (double rate each RTT, like slow start)
  DRAIN:         drain the queue STARTUP filled
  PROBE_BW:      cycle pacing_gain (1.25/0.75/1.0...) to probe bandwidth
  PROBE_RTT:     reduce cwnd to 4 MSS to measure min RTT (every 10s)
```

```c
/* net/ipv4/tcp_bbr.c */
struct bbr {
    u32  min_rtt_us;           /* min RTT in usec */
    u32  min_rtt_stamp;        /* timestamp of min_rtt_us */
    u32  probe_rtt_done_stamp; /* end time for BBR_PROBE_RTT mode */
    struct minmax bw;          /* max recent delivery rate */
    u32  rtt_cnt;              /* count of packet-timed rounds elapsed */
    u32  next_rtt_delivered;   /* scb->tx.delivered at end of round */
    u64  cycle_mstamp;         /* time of this cycle phase start */
    u32  mode:3,               /* current BBR mode */
         prev_ca_state:3,      /* CA state on previous ACK */
         packet_conservation:1,/* use packet conservation? */
         round_start:1,        /* start of packet-timed tx.delivered round? */
         idle_restart:1,       /* restarting after idle? */
         probe_rtt_round_done:1, /* a BBR_PROBE_RTT round at 4 pkts? */
         unused:13,
         lt_is_sampling:1,     /* taking long-term ("LT") samples now? */
         lt_rtt_cnt:7,         /* round trips in long-term interval */
         lt_use_bw:1;          /* use lt_bw as our bw estimate? */
    u32  lt_bw;                /* LT est delivery rate in pkts/uS << 24 */
    u32  lt_last_delivered;    /* LT intvl start: tp->delivered */
    u32  lt_last_stamp;        /* LT intvl start: tp->delivered_mstamp */
    u32  lt_last_lost;         /* LT intvl start: tp->lost */
    u32  pacing_gain:10,       /* current gain for sending rate */
         cwnd_gain:10,         /* current gain for cwnd */
         full_bw_reached:1,    /* hit BBR_FULL_BW_THRESH? */
         full_bw_cnt:2,        /* number of rounds with thresh */
         cycle_idx:3,          /* current index in pacing_gain cycle array */
         has_seen_rtt:1,       /* have we seen an RTT sample yet? */
         unused_b:5;
    u32  prior_cwnd;           /* prior cwnd upon entering loss recovery */
    u32  full_bw;              /* recent bw, to estimate if pipe is full */
};
```

### BBR pacing

BBR uses **pacing** (spreading packets evenly over time) rather than bursting:

```c
/* Set pacing rate: BtlBw × pacing_gain */
static void bbr_set_pacing_rate(struct sock *sk, u32 bw, int gain)
{
    struct tcp_sock *tp = tcp_sk(sk);
    struct bbr *bbr = inet_csk_ca(sk);
    u64 rate = bw;

    rate = bbr_rate_bytes_per_sec(sk, rate, gain);
    rate = min_t(u64, rate, sk->sk_max_pacing_rate);
    if (bbr->mode != BBR_STARTUP || rate > sk->sk_pacing_rate)
        WRITE_ONCE(sk->sk_pacing_rate, rate);
}
```

TCP pacing is implemented by the packet scheduler (FQ/fq_codel qdisc) or via hrtimers if no pacing qdisc is present.

```bash
# Enable FQ pacing for BBR (recommended):
tc qdisc add dev eth0 root fq
sysctl -w net.ipv4.tcp_congestion_control=bbr
```

## BBR vs CUBIC

| Aspect | CUBIC | BBR |
|--------|-------|-----|
| Reacts to | Loss | Bandwidth + RTT |
| Pacing | No (bursts) | Yes (BtlBw rate) |
| Queue filling | Fills bottleneck queue | Targets BtlBw×RTprop |
| Fairness | Fair to other CUBIC | Can be unfair to loss-based |
| Performance on loss | Good | Better on high loss |
| Latency | Higher (queue) | Lower (targets min RTT) |
| Kernel version | 2.6.19 default | 4.9 |

## Selecting and observing congestion control

```bash
# System default
sysctl net.ipv4.tcp_congestion_control

# Change system default
sysctl -w net.ipv4.tcp_congestion_control=bbr

# Per-socket (requires CAP_NET_ADMIN for non-standard algorithms):
setsockopt(fd, IPPROTO_TCP, TCP_CONGESTION, "bbr", 4);

# List available algorithms
sysctl net.ipv4.tcp_available_congestion_control
# or:
cat /proc/sys/net/ipv4/tcp_available_congestion_control

# Observe per-connection state (ss -i shows cwnd, rtt, etc.)
ss -tni
# Outputs:
#  cubic wscale:7,7 rto:204 rtt:0.748/0.374 ato:40
#  mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:10 ssthresh:7
#  bytes_sent:1234 bytes_acked:1234 segs_out:10 segs_in:10

# BBR-specific info
ss -tni | grep -A2 bbr
#  bbr wscale:7,7 rto:204 rtt:1.234/0.617
#  bw:1.23Gbps pacing_rate:1.50Gbps
```

## ECN: explicit congestion notification

ECN allows routers to signal congestion via IP header bits before dropping:

```
IP header: ECT(0), ECT(1) — ECN capable transport
TCP: CWR (congestion window reduced), ECE (ECN echo)

Flow:
  1. Sender marks packets as ECN-capable (ECT)
  2. Router sets CE (Congestion Experienced) when queue fills
  3. Receiver echoes CE back to sender via ECE flag
  4. Sender reduces cwnd (like a loss signal) and sets CWR
```

```bash
# Enable ECN
sysctl -w net.ipv4.tcp_ecn=1  # enable if both ends support it
# 0: disabled, 1: enable ECN (initiates in SYN), 2: accept ECN but don't initiate
```

## Further reading

- [TCP Implementation](tcp.md) — TCP socket state machine, fast retransmit
- [Network Buffer Tuning](net-buffer-tuning.md) — tuning cwnd initial values
- [TC and qdisc](tc-qdisc.md) — FQ qdisc for BBR pacing
- `net/ipv4/tcp_cubic.c` — CUBIC implementation
- `net/ipv4/tcp_bbr.c` — BBR implementation
- `net/ipv4/tcp_cong.c` — cc_ops registration and dispatch
