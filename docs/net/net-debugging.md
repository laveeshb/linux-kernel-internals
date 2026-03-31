# Network Debugging with ss and ip

> Essential tools for inspecting network state without looking at source code

## ss: socket statistics

`ss` (socket statistics) is the modern replacement for `netstat`. It reads directly from kernel data structures instead of parsing `/proc/net/tcp`, making it significantly faster.

### Basic usage

```bash
# All TCP sockets
ss -tn

# With process info
ss -tnp

# All socket types
ss -a

# Listening sockets only
ss -tnl

# UDP sockets
ss -un

# Unix domain sockets
ss -x
```

### Filter by state and address

```bash
# Specific state
ss -tn state established
ss -tn state time-wait
ss -tn state syn-sent

# Multiple states
ss -tn state established state close-wait

# Filter by port
ss -tn sport = :22         # source port 22
ss -tn dport = :80         # destination port 80
ss -tn '( dport = :443 or sport = :443 )'

# Filter by address
ss -tn dst 8.8.8.8
ss -tn src 10.0.0.0/8

# Count TIME_WAIT sockets (common performance issue)
ss -tn state time-wait | wc -l
```

### Detailed socket info

```bash
# Show internal TCP info (congestion state, cwnd, RTT, etc.)
ss -tni

# Example output for an ESTABLISHED connection:
# ESTAB 0 0 10.0.0.1:22 10.0.0.2:54321
#  cubic wscale:7,7 rto:208 rtt:4.2/0.5 ato:40 mss:1448 pmtu:1500
#  rcvmss:931 advmss:1448 cwnd:10 ssthresh:2147483647
#  bytes_sent:12345 bytes_acked:12345 bytes_received:67890
#  segs_out:456 segs_in:234
#  send 27.6Mbps pacing_rate 55.2Mbps delivery_rate 27.6Mbps
#  delivered:234 app_limited
#  reord_seen:0 lost:0 retrans:0/0 dsack_dups:0
#  rcv_rtt:4.2 rcv_space:14600 rcv_ssthresh:87380 minrtt:3.8

# Key fields:
#   rtt/rtt_var: smoothed RTT and variance
#   cwnd: congestion window (segments)
#   ssthresh: slow start threshold
#   retrans: cumulative/current retransmissions
#   delivery_rate: actual send rate
```

### Socket memory usage

```bash
# Show send/receive queue sizes and memory
ss -tm

# Output columns:
# Recv-Q: bytes received but not read by application
# Send-Q: bytes sent but not yet acknowledged

# Large Recv-Q: application not reading fast enough
# Large Send-Q: network is slow / receiver window is small
```

## ip: network configuration and state

### Interface information

```bash
# Show all interfaces with statistics
ip -s link show
# → shows rx/tx packets, bytes, errors, drops per interface

# Show a specific interface
ip link show eth0

# Show IP addresses
ip addr show
ip addr show dev eth0

# Monitor interface events (link up/down, address changes)
ip monitor link
ip monitor address
```

### Route inspection

```bash
# Show routing table
ip route show
ip route show table all  # all routing tables

# Routing lookup (simulate what the kernel would do)
ip route get 8.8.8.8
# → 8.8.8.8 via 192.168.1.1 dev eth0 src 192.168.1.100 uid 0

# Watch route changes
ip monitor route

# Show cached routes
ip route show cache
```

### ARP/neighbor table

```bash
# Show ARP table
ip neigh show
# → 192.168.1.1 dev eth0 lladdr 52:54:00:12:34:56 REACHABLE

# Filter by state
ip neigh show nud reachable  # only confirmed entries
ip neigh show nud stale      # entries that need reconfirmation

# Flush stale entries
ip neigh flush dev eth0

# Add static entry
ip neigh add 10.0.0.5 lladdr 52:54:00:11:22:33 dev eth0

# Watch ARP events
ip monitor neigh
```

## /proc/net: reading socket tables

```bash
# TCP socket table (hex addresses)
cat /proc/net/tcp
# local_address rem_address state tx_queue rx_queue uid inode
# 0101007F:0035 00000000:0000 0A ...  ← 127.0.0.1:53 listening
# 010011AC:01BB 02010A0A:E76C 01 ...  ← ESTABLISHED

# Convert hex address:port
python3 -c "import socket; print(socket.inet_ntoa(bytes.fromhex('010011AC')[::-1]))"
# → 172.17.0.1

# UDP sockets
cat /proc/net/udp

# Network interface stats
cat /proc/net/dev
# eth0: 12345678 23456 0 0 0 0 0 0  98765432 12345 0 0 0 0 0 0
#       ↑rx bytes ↑rx pkts ↑err     ↑tx bytes ↑tx pkts

# ARP table
cat /proc/net/arp
```

## Quick diagnostic patterns

```bash
# Count connections by state (overall health check)
ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn

# Top 10 remote IPs by connection count
ss -tn | awk '{print $5}' | grep -v Peer | sed 's/:[0-9]*$//' | sort | uniq -c | sort -rn | head

# Find what's listening (with process names)
ss -tnlp

# Check if port is in use
ss -tnlp | grep ':8080'

# Monitor socket queue buildup in real time
watch -n 1 'ss -tn | awk "NR==1 || \$2>0 || \$3>0"'

# Sockets with large send queues (possible network issue)
ss -tn | awk '$3 > 0'  # Send-Q > 0

# Sockets with large receive queues (slow application)
ss -tn | awk '$2 > 10000'  # Recv-Q > 10KB
```

## Further reading

- [Understanding /proc/net/snmp](proc-snmp.md) — Protocol counters in depth
- [Network Tracing](net-tracing.md) — ftrace and BPF for packet-level debugging
- [TCP Implementation](tcp.md) — What the ss -tni fields mean internally
- [Socket Layer Overview](socket-layer.md) — The socket structures ss reads
