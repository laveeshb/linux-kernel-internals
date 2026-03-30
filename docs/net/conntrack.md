# Connection Tracking (conntrack)

> How the kernel tracks the state of network connections for stateful firewalling and NAT

## What conntrack does

Connection tracking maintains a table of all active network flows. For every packet, the kernel looks up its flow in this table to determine its state (new, established, related, invalid). This enables:

- **Stateful firewalling**: Accept replies to outbound connections without explicit rules
- **NAT**: Track both directions of a rewritten connection
- **Helper modules**: Track related connections (FTP data channel, SIP RTP, etc.)

Conntrack is implemented in `net/netfilter/nf_conntrack_core.c` and hooks at PREROUTING and OUTPUT (before routing and before NAT).

## struct nf_conn

Each tracked connection is a `struct nf_conn`:

```c
// include/net/netfilter/nf_conntrack.h
struct nf_conn {
    struct nf_conntrack ct_general;  // reference count

    u32 timeout;  // expiry time (jiffies32)

    // Two tuples: how we see it in each direction
    // For TCP connection: client 10.0.0.1:54321 → server 8.8.8.8:80
    //   tuplehash[ORIGINAL]: src=10.0.0.1:54321 dst=8.8.8.8:80  proto=TCP
    //   tuplehash[REPLY]:    src=8.8.8.8:80 dst=10.0.0.1:54321  proto=TCP
    struct nf_conntrack_tuple_hash tuplehash[IP_CT_DIR_MAX];

    unsigned long status;  // IPS_* bitmask

    u_int32_t mark;    // connmark (can be set by iptables CONNMARK target)
    u_int32_t secmark; // SELinux security mark

    union nf_conntrack_proto proto;  // per-protocol state (TCP: state machine)
};
```

### Connection status bits (IPS_*)

```c
IPS_EXPECTED      // was expected by a helper (e.g., FTP data)
IPS_SEEN_REPLY    // seen traffic in both directions
IPS_ASSURED       // will survive GC under memory pressure (long-lived)
IPS_CONFIRMED     // inserted into hash table (survived packet processing)
IPS_SRC_NAT       // source address was NATted
IPS_DST_NAT       // destination address was NATted
IPS_DYING         // being removed
IPS_FIXED_TIMEOUT // timeout was explicitly set
```

### TCP-specific state

```c
// TCP state tracked per connection
union nf_conntrack_proto {
    struct nf_ct_tcp {
        enum tcp_conntrack state;  // TCP_CONNTRACK_SYN_SENT, ESTABLISHED, etc.
        enum tcp_conntrack last_dir;
        u_int32_t seen[2];         // window info for both directions
    } tcp;
    // UDP, ICMP, SCTP state...
};
```

## Conntrack tuple

A **tuple** uniquely identifies a packet in one direction:

```c
struct nf_conntrack_tuple {
    struct nf_conntrack_man {
        union nf_inet_addr u3;    // src IP (IPv4 or IPv6)
        union nf_conntrack_man_proto {
            __be16 port;  // TCP/UDP source port
            // ICMP id, etc.
        } u;
    } src;

    struct {
        union nf_inet_addr u3;    // dst IP
        union {
            __be16 port;           // TCP/UDP destination port
        } u;
        u_int8_t protonum;         // IPPROTO_TCP, IPPROTO_UDP, ...
        u_int8_t dir;              // ORIGINAL or REPLY
    } dst;
};
```

Two tuples are stored per `nf_conn`: the original direction and the reply direction (which is the original reversed). This is how NAT works — NAT modifies one or both tuples, and conntrack uses the reply tuple to match return traffic.

## Conntrack lifecycle

### 1. First packet (NEW)

```
Packet arrives → PREROUTING hook → nf_conntrack_in()
    → Lookup hash table by packet's tuple
    → Not found: create new nf_conn (state = UNCONFIRMED)
    → Hash table insertion deferred (to avoid early allocation)
    → Attach nf_conn to skb->_nfct
```

### 2. Confirmed (after LOCAL_OUT or FORWARD)

```
nf_conntrack_confirm()
    → Hash the tuple
    → Insert both tuplehash entries into conntrack hash table
    → Status: IPS_CONFIRMED
```

### 3. Subsequent packets (ESTABLISHED)

```
Packet arrives → lookup by tuple → nf_conn found
    → Update state, refresh timeout
    → Set IPS_SEEN_REPLY when reply direction seen
    → Set IPS_ASSURED when connection is long-lived
```

### 4. Timeout and cleanup

Connections time out if no packets are seen. Timeouts vary by protocol and state:

```bash
# TCP timeouts
cat /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established  # 432000s (5 days)
cat /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_syn_sent      # 120s
cat /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_time_wait     # 120s
cat /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_close          # 10s

# UDP timeout (no state, just expiry)
cat /proc/sys/net/netfilter/nf_conntrack_udp_timeout                # 30s
cat /proc/sys/net/netfilter/nf_conntrack_udp_timeout_stream         # 180s

# ICMP
cat /proc/sys/net/netfilter/nf_conntrack_icmp_timeout               # 30s
```

## Conntrack states for firewall rules

States visible to iptables/nftables:

| State | Meaning |
|-------|---------|
| `NEW` | First packet of a new connection (SYN for TCP) |
| `ESTABLISHED` | Reply seen; connection is going both ways |
| `RELATED` | New connection related to an existing one (FTP data, ICMP error) |
| `INVALID` | Doesn't match any connection; could be malformed |
| `UNTRACKED` | Explicitly bypassed via `NOTRACK`/`raw` table |

```bash
# iptables: accept established/related, drop invalid
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -m conntrack --ctstate INVALID -j DROP

# nftables
nft add rule inet filter input ct state established,related accept
nft add rule inet filter input ct state invalid drop
```

## Conntrack helpers: tracking related connections

Some protocols open secondary connections (FTP data channel, SIP RTP media). **Conntrack helpers** parse protocol messages to `EXPECT` these secondary connections:

```bash
# Load FTP helper
modprobe nf_conntrack_ftp
# Now FTP data connections are automatically RELATED and accepted
```

The helper creates an **expectation** — a placeholder that matches the expected secondary connection:

```c
// When FTP server sends "PORT x,x,x,x,a,b":
// Helper creates expectation: src=server dst=client dport=(a*256+b)
// When data connection arrives → matches expectation → state=RELATED
```

```bash
# View current expectations
cat /proc/net/nf_conntrack | grep RELATED
conntrack -L expect
```

## Conntrack marks (connmark)

Marks allow correlating firewall rules with routing or QoS:

```bash
# Mark all HTTP connections
iptables -t mangle -A POSTROUTING -p tcp --dport 80 \
    -j CONNMARK --set-mark 0x1

# Restore mark from conntrack to packet mark (on subsequent packets)
iptables -t mangle -A PREROUTING -j CONNMARK --restore-mark

# Use mark in routing (policy routing table 100)
ip rule add fwmark 0x1 table 100
```

## Monitoring and debugging

```bash
# List all connections
conntrack -L
conntrack -L --proto tcp --state ESTABLISHED

# Count connections by state
conntrack -L 2>/dev/null | awk '{print $4}' | sort | uniq -c

# Watch events in real time
conntrack -E

# Statistics per CPU (count lookups, inserts, found, etc.)
conntrack -S
# or
cat /proc/net/stat/nf_conntrack

# Dump conntrack table size
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Manual delete
conntrack -D -p tcp --src 10.0.0.1 --sport 54321

# Flush entire table (WARNING: drops all active connections' state)
conntrack -F
```

## Tuning for high-connection-rate environments

```bash
# Increase table size (at the cost of memory)
echo 1048576 > /proc/sys/net/netfilter/nf_conntrack_max
# Memory per entry: ~300 bytes → 1M entries ≈ 300MB

# Hash table size (set at module load time)
# nf_conntrack hashsize = nf_conntrack_max / 8 (typical)
modprobe nf_conntrack hashsize=131072

# Reduce TIME_WAIT entries (major consumer on busy servers)
echo 60 > /proc/sys/net/netfilter/nf_conntrack_tcp_timeout_time_wait

# For SYN floods: don't track half-open connections (raw table)
iptables -t raw -A PREROUTING -p tcp --syn -j NOTRACK
iptables -A INPUT -p tcp --syn -m conntrack --ctstate UNTRACKED -j ACCEPT
```

## Further reading

- [Netfilter Architecture](netfilter.md) — The hook framework conntrack lives within
- [nftables vs iptables](nftables-iptables.md) — How to write conntrack rules
- [Life of a Packet (receive)](life-of-packet-rx.md) — Where conntrack runs in the receive path
- [Network Debugging with ss and ip](net-debugging.md) — Tools for inspecting connections
