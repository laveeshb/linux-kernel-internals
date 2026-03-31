# nftables vs iptables

> The two Linux packet filtering frontends: differences, migration, and coexistence

## The relationship to Netfilter

Both `iptables` and `nftables` are **userspace tools** that install rules into the kernel's Netfilter framework. The difference is in which kernel module processes those rules:

- **iptables** → `ip_tables` kernel module (legacy, per-table modules)
- **nftables** → `nf_tables` kernel module (unified, modern)

The underlying hook mechanism is the same. What changes is how rules are represented, matched, and applied.

## Why nftables was created

iptables accumulated significant technical debt:

1. **Separate tools for each family**: `iptables` (IPv4), `ip6tables` (IPv6), `arptables`, `ebtables` — each with its own codebase
2. **Linear rule scanning**: Every packet scans every rule in a chain
3. **No atomic updates**: Adding a rule requires re-applying the entire ruleset via `iptables-restore`
4. **Poor set support**: Matching against large IP lists requires thousands of rules or `ipset` extension

nftables (merged in Linux 3.13) solves all of these with a single unified framework.

## Side-by-side comparison

### Basic syntax

```bash
# iptables: block SSH from a specific IP
iptables -A INPUT -s 10.0.0.5 -p tcp --dport 22 -j DROP

# nftables equivalent
nft add rule inet filter input ip saddr 10.0.0.5 tcp dport 22 drop
```

### Tables and chains

```bash
# iptables: implicit tables (filter, nat, mangle, raw, security)
# You can't create new tables

# nftables: explicit table and chain creation
nft add table inet myfilter
nft add chain inet myfilter input { type filter hook input priority 0\; policy accept\; }

# iptables tables correspond to nftables types:
# filter table  → type filter
# nat table     → type nat
# mangle table  → type filter (type route is only for re-routing at OUTPUT hook)
```

### Rule listing

```bash
# iptables
iptables -L -n -v --line-numbers
iptables -t nat -L -n -v

# nftables
nft list ruleset            # everything
nft list table inet filter  # specific table
nft list chain inet filter input  # specific chain
```

### Counters

```bash
# iptables: counters per rule (packets, bytes)
iptables -L -n -v
# → Chain INPUT: 12345 packets, 1234567 bytes

# nftables: optional counters per rule
nft add rule inet filter input ip protocol tcp counter
nft list ruleset  # shows counter values inline
```

## Set-based matching

This is where nftables shines — efficient matching against large sets:

```bash
# iptables: 10,000 IPs requires 10,000 rules (linear scan)
# (or ipset extension)

# nftables: hash set, O(1) lookup
nft add set inet filter blocked_ips {
    type ipv4_addr\;
    flags dynamic, timeout\;
    timeout 1h\;   # entries expire after 1 hour
}

nft add rule inet filter input ip saddr @blocked_ips drop

# Add IPs to the set
nft add element inet filter blocked_ips { 10.0.0.1, 10.0.0.2, 192.168.1.0/24 }

# Named maps: match IP → action
nft add map inet filter client_policy {
    type ipv4_addr : verdict\;
}
nft add element inet filter client_policy { 10.0.0.1 : accept, 10.0.0.2 : drop }
nft add rule inet filter input ip saddr vmap @client_policy
```

## Atomic rule updates

```bash
# iptables: non-atomic — race window between flush and reload
iptables -F INPUT
iptables-restore < /etc/iptables/rules.v4

# nftables: atomic transactions
nft -f /etc/nftables.conf  # applied atomically, or fails entirely

# nftables.conf example:
table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;
        ct state established,related accept
        iif lo accept
        tcp dport { 22, 80, 443 } accept
    }
}
```

## NAT with nftables

```bash
# DNAT: redirect port 80 to internal server
nft add table ip nat
nft add chain ip nat prerouting { type nat hook prerouting priority -100\; }
nft add chain ip nat postrouting { type nat hook postrouting priority 100\; }

nft add rule ip nat prerouting tcp dport 80 dnat to 192.168.1.10:8080
nft add rule ip nat postrouting oifname "eth0" masquerade
```

## Conntrack integration

```bash
# iptables: -m conntrack (or -m state)
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# nftables: ct state expression
nft add rule inet filter input ct state established,related accept
nft add rule inet filter input ct state invalid drop

# Match by connection mark
nft add rule inet filter input ct mark 0x1 accept
```

## Priority values

```bash
# Hook priorities determine order when multiple rules/tables are at same hook
# Lower number = earlier execution

# Standard priorities:
#  -400: NF_IP_PRI_CONNTRACK_DEFRAG (IP defragmentation)
#  -300: NF_IP_PRI_RAW              (raw table)
#  -200: NF_IP_PRI_CONNTRACK        (conntrack)
#   -50: NF_IP_PRI_SELINUX_FIRST    (SELinux)
#     0: NF_IP_PRI_FILTER           (filter table)
#    50: NF_IP_PRI_SELINUX_LAST
#   100: NF_IP_PRI_NAT_SRC          (SNAT in POSTROUTING)
#   300: NF_IP_PRI_CONNTRACK_HELPER

nft add chain inet myapp input { type filter hook input priority -50\; }
# This chain runs before standard filter rules
```

## Coexistence and migration

iptables and nftables can coexist on a system, but `iptables-nft` (available in modern distros) wraps iptables syntax while using the `nf_tables` backend:

```bash
# Check which backend iptables uses
iptables --version
# iptables v1.8.7 (nf_tables)  ← using nf_tables backend
# iptables v1.8.7 (legacy)     ← using ip_tables backend

# Translate iptables rules to nftables
iptables-translate -A INPUT -p tcp --dport 22 -j ACCEPT
# → nft add rule ip filter INPUT tcp dport 22 counter accept

# Translate entire ruleset
iptables-restore-translate -f /etc/iptables/rules.v4 > /etc/nftables.conf
```

## Debugging and logging

```bash
# nftables: log matching packets
nft add rule inet filter input tcp dport 22 log prefix "SSH: " level info

# Count packets matched by a rule (counter keyword)
nft add rule inet filter input tcp dport 80 counter accept

# Trace packet through rules (nftables 0.9.1+)
nft add table inet trace_debug
nft add chain inet trace_debug input { type filter hook input priority -200\; }
nft add rule inet trace_debug input ip saddr 10.0.0.1 meta nftrace set 1
nft monitor trace

# iptables: LOG target
iptables -A INPUT -p tcp --dport 22 -j LOG --log-prefix "SSH: " --log-level 4
```

## Performance comparison

For simple cases (small rulesets), performance is similar. For large rulesets:

- **iptables**: O(n) per packet where n = number of rules
- **nftables with sets**: O(1) for set membership, O(log n) for interval sets

```bash
# ipset (iptables extension) vs nftables native sets
# ipset can match 100k IPs in ~same time as 1 rule
# nftables sets are integrated, no separate tool needed

# For high-performance firewalling, also consider:
# - XDP for early drop before kernel networking stack
# - eBPF socket filters
```

## Further reading

- [Netfilter Architecture](netfilter.md) — The hook framework underlying both tools
- [Connection Tracking](conntrack.md) — The conntrack module both tools use
- [XDP](xdp.md) — Pre-stack packet filtering for maximum performance
