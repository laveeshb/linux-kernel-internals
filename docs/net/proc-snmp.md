# Understanding /proc/net/snmp and netstat

> Protocol-level counters for diagnosing TCP, UDP, and IP issues

## /proc/net/snmp

`/proc/net/snmp` exposes MIB (Management Information Base) counters from the SNMP RFC. Each counter tells you about a specific protocol event at the IP, TCP, or UDP level.

```bash
cat /proc/net/snmp
# Ip: Forwarding DefaultTTL InReceives InHdrErrors ...
# Ip: 2 64 1234567 0 ...        ← values
# Icmp: InMsgs InErrors InCsumErrors ...
# Icmp: 123 0 0 ...
# Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens ...
# Tcp: 1 200 120000 -1 5678 ...
# Udp: InDatagrams NoPorts InErrors OutDatagrams ...
# Udp: 12345 0 0 23456 ...
```

## Key IP counters

```bash
# Extract IP stats
awk '/^Ip:/ && /[0-9]/' /proc/net/snmp | head -1

# Important fields:
# InReceives       - packets received by IP layer
# InHdrErrors      - IP header checksum errors
# InAddrErrors     - destination address invalid (no such IP on this host)
# ForwDatagrams    - packets forwarded (router only)
# InDiscards       - dropped despite valid header (buffer pressure)
# InDelivers       - packets delivered to transport layer
# OutRequests      - packets originated locally
# OutDiscards      - packets dropped due to send queue overflow
# OutNoRoutes      - packets dropped because no route to destination
# ReasmOKs         - fragments reassembled successfully
# ReasmFails       - fragment reassembly failures
# FragOKs          - fragmented outbound packets
# FragFails        - fragmentation failures (DF bit set but MTU exceeded)
```

```bash
# One-liner: show IP counters with labels
paste <(head -1 /proc/net/snmp | tr ' ' '\n') \
      <(sed -n '2p' /proc/net/snmp | tr ' ' '\n') | grep -v "^Ip"
```

## Key TCP counters

```bash
# Extract TCP stats with labels (using python for clarity)
python3 -c "
data = open('/proc/net/snmp').read()
lines = [l.split() for l in data.split('\n') if l.startswith('Tcp')]
for k, v in zip(lines[0][1:], lines[1][1:]):
    if int(v) > 0:
        print(f'{k}: {v}')
"
```

| Counter | What it means | Common cause |
|---------|---------------|--------------|
| `ActiveOpens` | TCP connections initiated (connect()) | Normal outbound |
| `PassiveOpens` | TCP connections accepted (accept()) | Normal inbound |
| `AttemptFails` | Connections that failed during setup | Refused connections, SYN timeouts |
| `EstabResets` | ESTABLISHED connections reset | Application crash, network issue |
| `CurrEstab` | Currently established connections | Current load |
| `InSegs` | Total segments received | Traffic volume |
| `OutSegs` | Total segments sent | Traffic volume |
| `RetransSegs` | Retransmitted segments | **Network quality issue** |
| `InErrs` | Segments received with errors (bad checksum) | Hardware/NIC issue |
| `OutRsts` | RST segments sent | Connection rejections |
| `InCsumErrors` | Checksum errors | NIC offload bug, hardware issue |

A rising `RetransSegs/OutSegs` ratio (>1-2%) indicates network packet loss:

```bash
# Calculate retransmit ratio
python3 -c "
import re
data = open('/proc/net/snmp').read()
tcp = dict(zip(re.findall(r'Tcp: (.*)', data)[0].split(),
               re.findall(r'Tcp: (.*)', data)[1].split()))
ratio = int(tcp['RetransSegs']) / max(int(tcp['OutSegs']), 1) * 100
print(f'Retransmit ratio: {ratio:.2f}%')
print(f'RetransSegs: {tcp[\"RetransSegs\"]}')
print(f'OutSegs: {tcp[\"OutSegs\"]}')
"
```

## Key UDP counters

| Counter | What it means |
|---------|---------------|
| `InDatagrams` | UDP datagrams received and delivered |
| `NoPorts` | Received UDP with no socket listening → ICMP port unreachable sent |
| `InErrors` | Buffer overflow, checksum errors |
| `OutDatagrams` | UDP datagrams sent |
| `RcvbufErrors` | Dropped because socket receive buffer was full |
| `SndbufErrors` | Dropped because socket send buffer was full |

High `NoPorts` means something is sending to UDP ports with no listener. High `RcvbufErrors` means applications aren't reading fast enough.

## /proc/net/netstat: extended TCP stats

More detailed TCP counters (not in SNMP MIB):

```bash
cat /proc/net/netstat
# TcpExt: SyncookiesSent SyncookiesRecv SyncookiesFailed EmbryonicRsts ...
```

Key `TcpExt` counters:

| Counter | What it means |
|---------|---------------|
| `SyncookiesSent` | SYN cookies sent (SYN queue was full) |
| `SyncookiesRecv` | Valid SYN cookie ACKs received |
| `SyncookiesFailed` | SYN cookies that were invalid (possible attack) |
| `EmbryonicRsts` | RSTs sent to SYN_RECV connections |
| `ListenDrops` | Connections dropped because accept queue was full |
| `ListenOverflows` | Accept queue overflow count |
| `TCPHPHits` | Header prediction hits (fast path for established conns) |
| `TCPPureAcks` | Pure ACKs received |
| `TCPHPAcks` | ACKs processed via header prediction fast path |
| `TCPRenoRecovery` | Reno-style loss recovery episodes |
| `TCPSackRecovery` | SACK loss recovery episodes |
| `TCPFastRetrans` | Fast retransmits triggered |
| `TCPTimeouts` | RTO timeouts (slow recovery) |
| `TCPLostRetransmit` | Retransmitted segments lost again |
| `TCPDSACKOldSent` | Duplicate SACKs for old data |
| `TCPAbortOnTimeout` | Connections aborted due to retry limit |
| `TCPAbortOnData` | Connections aborted because data arrived on closing connection |

```bash
# Watch for TCP issues in real time
watch -n 2 'awk "/^TcpExt:/ && NR==2 {
    split(\$0, a, \" \"); for(i=1;i<=NF;i++) print a[i]
}" /proc/net/netstat | paste - <(
awk "/^TcpExt:/ && NR==1 {
    split(\$0, a, \" \"); for(i=1;i<=NF;i++) print a[i]
}" /proc/net/netstat) | grep -v "^0"'
```

## netstat (the tool)

`netstat` reads from `/proc/net/` and presents counters in a readable format:

```bash
# Protocol statistics (from /proc/net/snmp and /proc/net/netstat)
netstat -s

# Filter to TCP stats
netstat -s | grep -i -E "retransmit|error|fail|drop|reset"

# Active connections
netstat -tn          # like ss -tn

# Listen sockets
netstat -tnl
```

`netstat` is deprecated in favor of `ss` for connection listing, but `netstat -s` remains useful for statistics.

## Diagnosing with counters: common issues

### Packet loss

```bash
# Rising RetransSegs indicates loss
watch -n 5 'cat /proc/net/snmp | grep ^Tcp | awk "NR==2 {print \"Retrans:\", \$13, \"OutSegs:\", \$12}"'

# Also check NIC drops
ethtool -S eth0 | grep -i drop
```

### Accept queue overflow

```bash
# ListenOverflows: connections dropped because backlog was full
netstat -s | grep "listen"
# If non-zero:
#   increase listen() backlog: listen(fd, 4096)
#   increase /proc/sys/net/core/somaxconn
```

### SYN flood detection

```bash
# SyncookiesSent > 0 means SYN queue was full
netstat -s | grep "syncookies"
# Or watch for large SYN-RECV count:
ss -tn state syn-recv | wc -l
```

### UDP buffer drops

```bash
# RcvbufErrors: application not reading fast enough
netstat -s | grep "receive buffer"
# Fix: increase socket buffer (SO_RCVBUF) or increase read frequency
```

## Further reading

- [Network Debugging with ss and ip](net-debugging.md) — Per-connection inspection
- [Network Tracing](net-tracing.md) — Event-based debugging
- [TCP Implementation](tcp.md) — What these counters measure internally
- [Network Buffer Tuning](net-buffer-tuning.md) — Fixing buffer overflow issues
