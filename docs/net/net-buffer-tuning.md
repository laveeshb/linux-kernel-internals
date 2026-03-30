# Network Buffer Tuning

> Tuning socket buffers, ring buffers, and backpressure for high-throughput networking

## The buffer hierarchy

Network data flows through several buffering layers, each of which can be a bottleneck:

```
Application
    ↓ write()
Socket send buffer  (sk->sk_sndbuf)
    ↓ tcp_sendmsg
TCP write queue     (segments not yet sent or ACK'd)
    ↓ ip_queue_xmit
qdisc queue         (dev_queue_xmit)
    ↓ ndo_start_xmit
NIC TX ring buffer  (driver)
    ↓ DMA
Wire

Wire
    ↓ DMA
NIC RX ring buffer  (driver)
    ↓ NAPI
Softnet backlog     (sd->input_pkt_queue)
    ↓ __netif_receive_skb
Socket receive buffer (sk->sk_receive_queue)
    ↓ tcp_recvmsg
Application
```

## Socket buffer tuning

### TCP auto-tuning

By default, TCP auto-tunes socket buffers based on observed bandwidth-delay product:

```bash
# TCP buffer auto-tuning (recommended: leave on)
cat /proc/sys/net/ipv4/tcp_moderate_rcvbuf  # default: 1 (enabled)

# Auto-tuning range [min, default, max] in bytes
cat /proc/sys/net/ipv4/tcp_rmem  # → 4096 131072 6291456
cat /proc/sys/net/ipv4/tcp_wmem  # → 4096 16384 4194304

# For high-bandwidth, high-latency paths (e.g., 10Gbps, 50ms RTT)
# BDP = 10Gbps × 50ms = 62.5 MB → need buffers ≥ 64MB
echo "4096 87380 67108864" > /proc/sys/net/ipv4/tcp_rmem
echo "4096 65536 67108864" > /proc/sys/net/ipv4/tcp_wmem
```

### Manual buffer sizing

```bash
# Global maximum (setsockopt cannot exceed this)
cat /proc/sys/net/core/rmem_max  # default: 212992 (208KB)
cat /proc/sys/net/core/wmem_max

# Increase for large buffer sockets
echo 67108864 > /proc/sys/net/core/rmem_max  # 64MB
echo 67108864 > /proc/sys/net/core/wmem_max

# Per-socket (application can set up to rmem_max/2 due to kernel doubling)
setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &size, sizeof(size));
setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &size, sizeof(size));

# Check effective buffer size
getsockopt(fd, SOL_SOCKET, SO_RCVBUF, &actual, &len);
# actual = 2 × requested (kernel doubles for bookkeeping)
```

### UDP buffer sizing

UDP has no flow control — if the application reads slowly, packets are dropped:

```bash
# Increase UDP socket receive buffer for high-rate senders
cat /proc/sys/net/core/rmem_default  # default receive buffer for all sockets
echo 26214400 > /proc/sys/net/core/rmem_default  # 25MB

# Application: increase buffer before binding
int buf_size = 25 * 1024 * 1024;
setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &buf_size, sizeof(buf_size));
```

## NIC ring buffer tuning

The NIC maintains DMA ring buffers for TX and RX. If they fill up, packets are dropped before they reach the kernel:

```bash
# Show current ring buffer sizes
ethtool -g eth0
# Ring parameters for eth0:
# Pre-set maximums:
# RX: 4096  TX: 4096
# Current hardware settings:
# RX: 256   TX: 256  ← often too small for high traffic

# Increase ring buffers (critical for high-throughput workloads)
ethtool -G eth0 rx 4096 tx 4096

# Verify changes
ethtool -g eth0
```

Ring buffer drops are visible in:

```bash
ethtool -S eth0 | grep -i "drop\|miss\|discard"
# rx_missed_errors: number of packets NIC dropped because RX ring was full
```

## Softnet backlog

The kernel's per-CPU receive backlog (`sd->input_pkt_queue`) sits between NAPI and protocol processing. If it fills, packets are dropped:

```bash
# Backlog queue length (per CPU)
cat /proc/sys/net/core/netdev_max_backlog  # default: 1000

# Increase for high packet rates
echo 10000 > /proc/sys/net/core/netdev_max_backlog

# Check for drops (column 2 = dropped, column 3 = time_squeeze)
cat /proc/net/softnet_stat
# format: total dropped time_squeeze 0 0 0 0 0 0 cpu_collision received_rps flow_limit_count
```

### softnet_stat columns explained

```bash
# Show per-CPU softnet stats with labels
awk 'BEGIN{OFS="\t"; print "CPU","total","dropped","time_squeeze"}
     {print NR-1, strtonum("0x"$1), strtonum("0x"$2), strtonum("0x"$3)}
     ' /proc/net/softnet_stat | head -10
```

| Column | Meaning | Fix |
|--------|---------|-----|
| total | Total packets processed by softirq | Normal |
| dropped | Packets dropped (backlog full) | Increase `netdev_max_backlog` |
| time_squeeze | poll() ran out of budget | Increase `netdev_budget` |
| cpu_collision | Multiple CPUs contending for CPU queue | Enable RPS/RSS |

## TCP memory pressure

The kernel limits total memory used by TCP sockets:

```bash
# TCP memory limits [pages at which pressure starts, hard limit, max]
cat /proc/sys/net/ipv4/tcp_mem
# → 94011 125349 188022 (in pages of 4KB = ~368MB total max)

# Current usage
cat /proc/net/sockstat | grep TCP
# TCP: inuse 234 orphan 0 tw 12 alloc 248 mem 45

# If mem approaches tcp_mem[2]: "TCP: out of memory" in dmesg
# Fix: increase tcp_mem (or fix memory leaks/reduce connections)
echo "768432 1024576 1536864" > /proc/sys/net/ipv4/tcp_mem
```

## Diagnosing buffer issues

### RX bottleneck (application reads slowly)

```bash
# Large Recv-Q in ss means data is waiting for the application
ss -tn | awk '$2 > 10000 {print $2, $5}'

# Monitor socket memory usage
cat /proc/net/sockstat

# Check UDP drops
netstat -s | grep "receive buffer"
# "X packets pruned from receive queue because of socket buffer overrun"
```

### TX bottleneck (send buffer full)

```bash
# Large Send-Q means data is waiting to be sent (network slow or receiver window full)
ss -tn | awk '$3 > 0'

# Check if receiver window is limiting (zero window probes)
netstat -s | grep "zero window"
```

### NIC ring buffer drops

```bash
# Check for NIC-level drops
ethtool -S eth0 | grep -i drop
watch -n 5 'ethtool -S eth0 | grep -i "drop\|miss" | awk "$2>0"'
```

### qdisc drops (TX queue too small)

```bash
# Check qdisc drops
tc -s qdisc show dev eth0
# If "dropped" is non-zero, qdisc is dropping packets

# Increase qdisc queue length
ip link set dev eth0 txqueuelen 10000  # default 1000
```

## Complete performance checklist

For high-throughput servers (10G+):

```bash
# 1. NIC ring buffers
ethtool -G eth0 rx 4096 tx 4096

# 2. Socket buffers
echo 67108864 > /proc/sys/net/core/rmem_max
echo 67108864 > /proc/sys/net/core/wmem_max
echo "4096 87380 67108864" > /proc/sys/net/ipv4/tcp_rmem
echo "4096 65536 67108864" > /proc/sys/net/ipv4/tcp_wmem

# 3. Softnet backlog
echo 30000 > /proc/sys/net/core/netdev_max_backlog
echo 1000  > /proc/sys/net/core/netdev_budget
echo 8000  > /proc/sys/net/core/netdev_budget_usecs

# 4. Connection tracking (if using NAT)
echo 1048576 > /proc/sys/net/netfilter/nf_conntrack_max

# 5. TCP memory
echo "768432 1024576 1536864" > /proc/sys/net/ipv4/tcp_mem

# 6. Offloads (ensure enabled for high-throughput)
ethtool -k eth0 | grep -E "scatter-gather|tcp-segmentation|generic-segmentation|generic-receive"
# All should be "on" for throughput; disable for latency/debug
```

## Further reading

- [Understanding /proc/net/snmp](proc-snmp.md) — Counters that reflect these drops
- [Network Tracing](net-tracing.md) — How to diagnose drop location
- [Network Device and NAPI](napi.md) — NAPI budget and softnet tuning
- [TCP Implementation](tcp.md) — How TCP window and cwnd interact with buffers
