# TC (Traffic Control) and qdisc

> How the kernel shapes, schedules, and polices outbound traffic

## What TC does

Traffic Control (TC) is the kernel's framework for controlling packet transmission. It sits between `dev_queue_xmit()` and the NIC driver, and handles:

- **Shaping**: Rate-limit outbound traffic (TBF, HTB)
- **Scheduling**: Control which packets go next (PRIO, FQ)
- **Policing**: Drop packets exceeding a rate (policer)
- **Classification**: Map packets to treatment classes

TC only controls **egress** (outbound) by default. Ingress shaping requires redirect tricks (IFB device).

## The qdisc hierarchy

Every network device has a root **qdisc** (queuing discipline). When a packet is transmitted, it goes through the qdisc before reaching the driver:

```
dev_queue_xmit(skb)
    → q->enqueue(skb, q)   // qdisc enqueue
    → q->dequeue(q)         // qdisc selects next packet
    → dev_hard_start_xmit() // driver DMA
```

Qdiscs can be hierarchical:

```
root qdisc (HTB)
├── class 1:10 (rate 100Mbit)
│   └── leaf qdisc (fq_codel)
├── class 1:20 (rate 50Mbit)
│   └── leaf qdisc (pfifo)
└── class 1:30 (rate 10Mbit)  ← default
    └── leaf qdisc (sfq)
```

## Viewing current qdisc

```bash
# Show qdisc on an interface
tc qdisc show dev eth0

# Default (most interfaces): pfifo_fast
# → 3-band FIFO based on TOS bits
# Handle "0:" is the root

# Show full hierarchy
tc qdisc show dev eth0
tc class show dev eth0
tc filter show dev eth0
```

## Common qdiscs

### pfifo_fast (default)

Three priority bands (0=high, 1=med, 2=low) based on the packet's DSCP/TOS field. Simple FIFO within each band. No rate limiting.

```bash
# Default on most interfaces
tc qdisc show dev eth0
# qdisc pfifo_fast 0: root refcnt 2 bands 3 priomap 1 2 2 2 1 2 0 0 1 1 1 1 1 1 1 1
```

### fq_codel (modern default on Linux desktops)

**Fair Queueing + Controlled Delay (CoDel)**. Combines fair per-flow scheduling with active queue management (AQM) to reduce bufferbloat:

```bash
tc qdisc add dev eth0 root fq_codel
tc qdisc show dev eth0
# qdisc fq_codel 8001: root refcnt 2 limit 10240p flows 1024
#   quantum 1514 target 5ms interval 100ms memory_limit 32Mb ecn
```

Parameters:
- `target`: acceptable minimum standing queue delay (default 5ms)
- `interval`: control loop interval for CoDel (default 100ms)
- `flows`: number of hash buckets for fair queueing (default 1024)
- `ecn`: mark packets instead of dropping when possible

### fq (Fair Queue — default for BBR)

Per-flow fair queuing with pacing. Allows each flow to specify its desired send rate. Required for TCP BBR congestion control's accurate pacing:

```bash
tc qdisc replace dev eth0 root fq

# After enabling BBR:
echo bbr > /proc/sys/net/ipv4/tcp_congestion_control
tc qdisc replace dev eth0 root fq  # fq enables accurate rate pacing
```

### TBF (Token Bucket Filter)

Rate-limits traffic to a specific bandwidth with burst allowance:

```bash
# Limit to 1Mbit/s with 10KB burst
tc qdisc add dev eth0 root tbf rate 1mbit burst 10k latency 50ms

# Parameters:
#   rate:    sustained rate
#   burst:   maximum burst (traffic above rate drains tokens accumulated here)
#   latency: maximum queuing latency (used to calculate queue size)
```

### HTB (Hierarchical Token Bucket)

The standard choice for multi-class rate limiting. Supports a hierarchy of classes with guaranteed and ceiling rates:

```bash
# Root HTB qdisc
tc qdisc add dev eth0 root handle 1: htb default 30

# Classes: guaranteed rate + ceiling
tc class add dev eth0 parent 1:  classid 1:1 htb rate 100mbit
tc class add dev eth0 parent 1:1 classid 1:10 htb rate 80mbit ceil 100mbit
tc class add dev eth0 parent 1:1 classid 1:20 htb rate 15mbit ceil 100mbit
tc class add dev eth0 parent 1:1 classid 1:30 htb rate  5mbit ceil 100mbit

# Leaf qdiscs for each class
tc qdisc add dev eth0 parent 1:10 handle 10: fq_codel
tc qdisc add dev eth0 parent 1:20 handle 20: fq_codel
tc qdisc add dev eth0 parent 1:30 handle 30: fq_codel
```

When class 1:10 uses less than 80Mbit, its unused bandwidth can be borrowed by 1:20 and 1:30, up to their ceiling (100Mbit).

## TC filters: classifying packets

Filters determine which class a packet goes to:

```bash
# Match by destination port → class 1:10
tc filter add dev eth0 parent 1: protocol ip prio 1 \
    u32 match ip dport 80 0xffff flowid 1:10

# Match by source IP
tc filter add dev eth0 parent 1: protocol ip prio 2 \
    u32 match ip src 10.0.0.0/8 flowid 1:20

# Match by fwmark (from iptables MARK)
tc filter add dev eth0 parent 1: protocol ip prio 3 \
    handle 0x1 fw flowid 1:10

# eBPF classifier (modern approach)
tc filter add dev eth0 parent 1: bpf obj tc_prog.o sec tc flowid 1:10
```

## TC eBPF (TC-BPF)

eBPF programs can be attached to TC as classifiers or actions. Unlike XDP, TC-BPF runs **after `sk_buff` allocation**, enabling full packet modification:

```c
// TC egress program: add VLAN tag
SEC("tc")
int tc_add_vlan(struct __sk_buff *skb)
{
    bpf_skb_vlan_push(skb, htons(ETH_P_8021Q), 100);  // VLAN 100
    return TC_ACT_OK;
}
```

```bash
# Attach TC-BPF program to egress
tc qdisc add dev eth0 clsact
tc filter add dev eth0 egress bpf obj tc_prog.o sec tc direct-action

# Can also attach to ingress (for shaping incoming traffic)
tc filter add dev eth0 ingress bpf obj tc_ingress.o sec tc direct-action
```

TC-BPF verdicts:
- `TC_ACT_OK` (= 0): pass to next stage
- `TC_ACT_SHOT` (= 2): drop
- `TC_ACT_REDIRECT` (= 7): redirect to another interface

## Ingress shaping with IFB

TC only shapes egress natively. For ingress shaping:

```bash
# Create IFB (Intermediate Functional Block) device
modprobe ifb
ip link set dev ifb0 up

# Redirect all ingress traffic to IFB
tc qdisc add dev eth0 ingress handle ffff:
tc filter add dev eth0 parent ffff: protocol all u32 \
    match u32 0 0 action mirred egress redirect dev ifb0

# Now shape ifb0's egress (= eth0's ingress)
tc qdisc add dev ifb0 root tbf rate 10mbit burst 20k latency 100ms
```

## netem: network emulation

`netem` adds artificial delay, jitter, packet loss, and corruption — useful for testing:

```bash
# Add 100ms delay with 10ms jitter
tc qdisc add dev eth0 root netem delay 100ms 10ms

# Add 5% packet loss
tc qdisc add dev eth0 root netem loss 5%

# Combine: 50ms delay + 1% loss + 0.1% corruption
tc qdisc add dev eth0 root netem delay 50ms loss 1% corrupt 0.1%

# Remove
tc qdisc del dev eth0 root
```

## Statistics

```bash
# Show qdisc statistics
tc -s qdisc show dev eth0
# qdisc fq_codel 8001: root ...
#  Sent 12345 bytes 100 pkt (dropped 0, overlimits 0 requeues 0)
#  backlog 0b 0p requeues 0
#  maxpacket 1514 drop_overlimit 0 new_flow_count 50

# Show class statistics (HTB)
tc -s class show dev eth0

# Watch in real time
watch -n 1 'tc -s qdisc show dev eth0'
```

## Further reading

- [XDP](xdp.md) — Pre-stack packet processing (higher performance than TC for drops)
- [AF_XDP Sockets](af-xdp.md) — Userspace packet I/O without full kernel bypass
- [Life of a Packet (transmit)](life-of-packet-tx.md) — Where TC fits in the transmit path
- [CPU Bandwidth Control](../sched/cpu-bandwidth.md) — Analogous control for CPU time
