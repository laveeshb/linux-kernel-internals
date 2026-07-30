# Networking

> From socket() to the wire: how packets traverse the Linux network stack

## The stack at a glance

```
Application: send(fd, buf, len)
        │
        ▼
   Socket layer          ← struct socket, protocol-agnostic API
        │
        ▼
   TCP / UDP             ← congestion control, retransmission, ports
        │
        ▼
   IP / routing          ← FIB lookup, netfilter hooks, fragmentation
        │
        ▼
   Traffic control       ← qdiscs, shaping, prioritization
        │
        ▼
   Device driver         ← NAPI, ring buffers, offloads
        │
        ▼
      NIC                ← DMA, interrupts / polling
```

Every packet is carried by an [sk_buff](sk-buff.md) — start there if you read only one page.

## Pages in this section

### Fundamentals

| Page | What it covers |
|------|----------------|
| [Network Stack Overview](network-stack-overview.md) | The layers and how they connect |
| [Socket Layer](socket-layer.md) | struct socket, file descriptors, protocol families |
| [sk_buff](sk-buff.md) | The packet data structure everything else shares |
| [NAPI](napi.md) | Interrupt mitigation: from IRQ storm to polling |

### Packet lifecycle

| Page | What it covers |
|------|----------------|
| [Life of a Packet: RX](life-of-packet-rx.md) | NIC to application, step by step |
| [Life of a Packet: TX](life-of-packet-tx.md) | Application to NIC, step by step |
| [What Happens in connect()](connect.md) | Three-way handshake from the kernel's side |

### TCP/IP

| Page | What it covers |
|------|----------------|
| [TCP Internals](tcp.md) | State machine, buffers, timers |
| [TCP Congestion Control](tcp-congestion.md) | CUBIC, BBR, pluggable algorithms |
| [UDP](udp.md) | The thin path, and where it still surprises |
| [IP Routing](ip-routing.md) | FIB, rules, multipath |
| [epoll](epoll.md) | Readiness notification at scale |

### Filtering & traffic control

| Page | What it covers |
|------|----------------|
| [Netfilter](netfilter.md) | Hooks, tables, chains |
| [nftables vs iptables](nftables-iptables.md) | Why the replacement happened |
| [Connection Tracking](conntrack.md) | conntrack entries, NAT, helpers |
| [Traffic Control (tc/qdisc)](tc-qdisc.md) | Queuing disciplines, shaping, fq_codel |

### High performance & offload

| Page | What it covers |
|------|----------------|
| [XDP](xdp.md) | Processing packets before the stack |
| [AF_XDP](af-xdp.md) | Zero-copy userspace packet I/O |
| [kTLS](ktls.md) | TLS record processing in the kernel |
| [Packet Sockets](packet-socket.md) | AF_PACKET, tcpdump's view of the world |

### Namespaces & virtualization

| Page | What it covers |
|------|----------------|
| [Network Namespaces](net-namespaces.md) | Per-namespace stacks, veth pairs |
| [Container Networking](container-networking.md) | Bridges, NAT, overlay basics |
| [TUN/TAP](tun-tap.md) | Userspace network devices, VPNs |

### Interfaces & observability

| Page | What it covers |
|------|----------------|
| [Netlink](netlink.md) | The kernel's network configuration API |
| [Network Debugging](net-debugging.md) | ss, ethtool, drop diagnostics |
| [Network Tracing](net-tracing.md) | Tracepoints and BPF on the data path |
| [Buffer Tuning](net-buffer-tuning.md) | Socket buffers, rmem/wmem, autotuning |
| [/proc/net/snmp Reference](proc-snmp.md) | Reading the protocol counters |
