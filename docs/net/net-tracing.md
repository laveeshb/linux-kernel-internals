# Tracing the Network Stack

> ftrace, perf, and BPF tools for packet-level network debugging

## Network trace events

The kernel emits tracepoints at key points in the network stack, accessible via ftrace and perf:

```bash
# List available network trace events
ls /sys/kernel/debug/tracing/events/net/
ls /sys/kernel/debug/tracing/events/tcp/
ls /sys/kernel/debug/tracing/events/skb/

# Key events:
# net:net_dev_xmit           - packet transmitted by device
# net:net_dev_queue          - packet queued for transmission
# net:netif_rx               - packet received (old NAPI path)
# net:netif_receive_skb      - packet processed by NAPI
# skb:consume_skb            - sk_buff freed (normal path)
# skb:kfree_skb              - sk_buff freed (drop path)
# tcp:tcp_send_reset         - RST sent
# tcp:tcp_rcv_space_adjust   - receive buffer resized
# tcp:tcp_destroy_sock       - socket destroyed
```

## Tracing packet drops with kfree_skb

`skb:kfree_skb` fires whenever an sk_buff is dropped. The `reason` field identifies why:

```bash
# Enable drop tracing
echo 1 > /sys/kernel/debug/tracing/events/skb/kfree_skb/enable
cat /sys/kernel/debug/tracing/trace_pipe

# Example output:
# <irq>-0 [000] ..... 123.456789: kfree_skb: skbaddr=0xffff... location=0xffffffff... protocol=2048 reason=NETFILTER_DROP

# Or with trace-cmd:
trace-cmd record -e skb:kfree_skb sleep 5
trace-cmd report | grep kfree_skb
```

### Drop reason codes (Linux 5.17+)

The `reason` field was added to identify exact drop location:

```bash
# See all drop reasons
grep -r "SKB_DROP_REASON" /usr/include/linux/ 2>/dev/null | head -20
# SKB_DROP_REASON_NOT_SPECIFIED
# SKB_DROP_REASON_NO_SOCKET
# SKB_DROP_REASON_PKT_TOO_SMALL
# SKB_DROP_REASON_TCP_CSUM
# SKB_DROP_REASON_TCP_FILTER
# SKB_DROP_REASON_UDP_CSUM
# etc.
```

### Using dropwatch (BCC)

```bash
# dropwatch: show packet drop locations and rates
# Requires BCC tools
dropwatch -l kas  # kernel address symbols

# Or with bpftrace:
bpftrace -e '
tracepoint:skb:kfree_skb {
    @drops[kstack] = count();
}
interval:s:5 {
    print(@drops);
    clear(@drops);
}'
```

## Tracing TCP events

```bash
# Trace TCP state changes and resets
trace-cmd record -e tcp:tcp_send_reset \
                 -e tcp:tcp_receive_reset \
                 sleep 10

# Watch for RST storms (connection resets)
bpftrace -e '
tracepoint:tcp:tcp_send_reset {
    @resets[args->saddr, args->daddr] = count();
}
interval:s:5 { print(@resets); clear(@resets); }'

# Trace retransmissions
bpftrace -e '
kprobe:tcp_retransmit_skb {
    @retrans[comm] = count();
}'
```

## perf for network events

```bash
# Count network events system-wide
perf stat -e \
    net:net_dev_xmit,\
    net:netif_receive_skb,\
    skb:kfree_skb \
    -a sleep 10

# Record and analyze packet flow
perf record -e net:netif_receive_skb -ag sleep 5
perf report

# Overhead of network processing (CPU cycles)
perf top -e net:net_dev_xmit
```

## bpftrace one-liners

```bash
# Show receive rate per device
bpftrace -e '
tracepoint:net:netif_receive_skb {
    @pkts[args->dev_name] = count();
    @bytes[args->dev_name] = sum(args->len);
}
interval:s:1 {
    print(@pkts); print(@bytes);
    clear(@pkts); clear(@bytes);
}'

# Trace packet latency from NIC receive to socket delivery
bpftrace -e '
tracepoint:net:netif_receive_skb { @ts[args->skbaddr] = nsecs; }
kprobe:tcp_rcv_established {
    $key = (uint64)arg1;
    if (@ts[$key]) {
        @lat = hist(nsecs - @ts[$key]);
        delete(@ts[$key]);
    }
}'

# Track which processes send UDP packets
bpftrace -e '
kprobe:udp_sendmsg {
    @[comm, pid] = count();
}'

# Show TCP connection setup time
bpftrace -e '
kprobe:tcp_connect { @start[tid] = nsecs; }
kretprobe:tcp_finish_connect {
    @connect_ms = hist((nsecs - @start[tid]) / 1000000);
    delete(@start[tid]);
}'
```

## Wireshark / tcpdump

For packet-level capture:

```bash
# Capture on interface
tcpdump -i eth0 -n

# Filter by host and port
tcpdump -i eth0 -n host 8.8.8.8 and port 53

# Save to file for Wireshark
tcpdump -i eth0 -w /tmp/capture.pcap

# Capture specific protocol
tcpdump -i eth0 -n 'tcp[tcpflags] & tcp-syn != 0'  # only SYN packets
tcpdump -i eth0 -n 'tcp[tcpflags] & tcp-rst != 0'  # only RST packets

# Read from file
tcpdump -r /tmp/capture.pcap -nn

# Capture on any interface (including loopback)
tcpdump -i any -n
```

### AF_PACKET sockets (what tcpdump uses)

tcpdump uses AF_PACKET sockets, which receive a copy of every packet at the `__netif_receive_skb` level — before the packet is processed by the network stack. This is why tcpdump sees packets even if they're subsequently dropped by iptables.

```bash
# tcpdump can miss packets under high load: check for drops
tcpdump -i eth0 -w /dev/null -v  # shows "X packets captured, Y dropped by kernel"

# Increase capture buffer to reduce drops
tcpdump -i eth0 -B 65536 -w /dev/null  # 65MB buffer
```

## Tracing with nftables/iptables

For packet-level debugging of firewall rules:

```bash
# nftables: trace packets matching a specific rule
nft add table inet debug
nft add chain inet debug input { type filter hook input priority -200\; }
nft add rule inet debug input ip saddr 10.0.0.1 meta nftrace set 1
nft monitor trace

# iptables: LOG target (goes to kernel log / syslog)
iptables -I INPUT 1 -p tcp --dport 80 -j LOG --log-prefix "HTTP: " --log-level 4
journalctl -k | grep "HTTP: "
```

## net_ratelimit and kernel log drops

The kernel rate-limits some network messages to prevent log flooding. If you see messages like `net_ratelimit: X callbacks suppressed`, the kernel is dropping log messages:

```bash
# Increase logging rate limit
echo 5000 > /proc/sys/net/core/message_burst  # burst
echo 10 > /proc/sys/net/core/message_cost     # tokens per interval
```

## Systematic approach to network debugging

1. **Check counters first**: `/proc/net/dev`, `ethtool -S eth0`, `/proc/net/snmp`
2. **Identify drop location**: `skb:kfree_skb` tracepoint or `dropwatch`
3. **Check socket queues**: `ss -tn | awk '$2>0 || $3>0'`
4. **Check conntrack**: `conntrack -S`, `cat /proc/sys/net/netfilter/nf_conntrack_count`
5. **Packet capture**: `tcpdump` for protocol-level analysis
6. **Firewall trace**: nftables `meta nftrace` or iptables LOG

## Further reading

- [Network Debugging with ss and ip](net-debugging.md) — Socket and route inspection
- [Understanding /proc/net/snmp](proc-snmp.md) — Protocol counters
- [Netfilter Architecture](netfilter.md) — Where firewall drops happen
- [Life of a Packet (receive)](life-of-packet-rx.md) — The full path where drops can occur
