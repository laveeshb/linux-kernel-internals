# War Stories: Network Stack Bugs and CVEs

> Real vulnerabilities and production incidents from Linux networking history — what broke, why, and what the kernel learned

The network stack sits at a trust boundary that most of the kernel doesn't have to deal with: its input arrives from the wire, often from a remote, unauthenticated peer, and gets parsed and acted on before any application-layer authentication happens. A bug in TCP's SACK processing, in a netfilter compat shim, or in a socket-ring-buffer size calculation is reachable by anyone who can send packets to the box — no local shell required. That's why network-stack incidents skew toward remote denial-of-service and remote-triggered memory corruption, rather than the local data-loss and performance-regression stories that dominate filesystem and I/O history.

The incidents below, each with its own page: root-cause analysis grounded in the actual patches, plus the real mailing-list discussion behind each fix — alternatives considered, trade-offs debated, and in a few cases genuinely notable process failures. Three are remote (reachable over the network with no local access); the other three are local — two of them reachable through capabilities (`CAP_NET_ADMIN`, `CAP_NET_RAW`) that are routinely granted to unprivileged processes inside user namespaces, and one through nothing more than an ordinary `sendmsg()` sequence. That capability angle is itself a recurring theme in how "local" bugs in this subsystem became "container escape" bugs.

## Incidents

Ordered chronologically by disclosure date.

### [The TCP Challenge-ACK Side Channel](war-stories/challenge-ack.md)
**August 2016 · CVE-2016-5696 · CVSS 4.8**
A global rate-limit counter, meant purely as an internal implementation detail, let an off-path attacker infer TCP sequence numbers by watching how much of the shared quota a victim connection consumed.

### [AF_PACKET TPACKET_V3 Privilege Escalation](war-stories/af-packet.md)
**March 2017 · CVE-2017-7308 · CVSS 7.8**
A single `(int)` cast around an unsigned subtraction defeated a ring-buffer bounds check — found by syzkaller, turned into local root by Project Zero.

### [UDP Fragmentation-Offload Path-Switch Corruption](war-stories/udp-ufo.md)
**August 2017 · CVE-2017-1000112 · CVSS 7.0**
Two `send()` calls building the same datagram could disagree about which code path was building it, twelve years after the bug was introduced. Embargo-disclosed and fixed in one week.

### [SegmentSmack](war-stories/segmentsmack.md)
**August 2018 · CVE-2018-5390 · CVSS 7.5**
Tiny, deliberately-scattered out-of-order TCP segments could pin a CPU core at 100% with roughly 2 kilopackets/second of traffic. The public disclosure process became its own controversy, chronicled in detail on LWN.

### [The TCP SACK Panic](war-stories/sack-panic.md)
**June 2019 · CVE-2019-11477/78/79 · CVSS 7.5 (all three)**
A remote peer could crash any Linux TCP endpoint by overflowing a 16-bit segment counter with a crafted sequence of SACK blocks. The fix itself then collided with legitimate high-throughput and small-buffer workloads twice more before it stopped causing production stalls.

### [Netfilter x_tables Heap Overflow](war-stories/netfilter-xtables.md)
**Fixed April 2021, disclosed July 2021 · CVE-2021-22555 · CVSS 8.3 (Google) / 7.8 (NVD)**
A 15-year-old bounds-check gap, sitting unanswered in a syzbot report for 8 months, became "Turning \x00\x00 into 10000$" and a real Kubernetes pod escape once someone built an exploit chain for it.

## Common threads

| Pattern | Challenge-ACK | AF_PACKET | UFO path-switch | SegmentSmack | SACK panic | Netfilter x_tables |
|---------|:--------------:|:----------:|:-----------------:|:-------------:|:----------:|:-------------------:|
| Remotely triggerable, no local access needed | Yes | No | No | Yes | Yes | No |
| Root cause is an integer/width assumption | No | Yes | Yes | No | Yes | No |
| Found via fuzzing (syzkaller) or automated tooling | No | Yes | Yes | No | No | Partial |
| Capability check defeated by user namespaces | No | Yes | No | No | No | Yes |
| Fix added an explicit cap/invariant, not just a patch to one call site | Yes | Yes | Yes | Yes | Yes | Yes |

Half of these cases are reachable by an attacker who has never authenticated to anything — they only need to be able to route packets to the target, which is the defining characteristic of network-stack bugs as a category. The other half (Netfilter x_tables, AF_PACKET, and the UDP UFO bug) require local execution, but all three are gated only by capabilities (`CAP_NET_ADMIN`, `CAP_NET_RAW`, or an ordinary `sendmsg()` sequence) that are either trivially available or handed out routinely by unprivileged user namespaces — which is why the first two ended up cited as container-escape primitives rather than filed away as low-severity local bugs.

The other recurring shape is **an assumption that held for years until an adversary specifically targeted it**: a 16-bit segment counter, a per-second reset boundary, a per-entry padding write, a signed cast, a per-call path decision — each was locally reasonable and had shipped for anywhere from under two years (SegmentSmack) to fifteen years (Netfilter x_tables) before someone deliberately constructed the input that broke the assumption. Fuzzing (syzkaller, in the AF_PACKET and UFO cases) and dedicated security research (Netflix, Project Zero, academic researchers) each found different corners of this space; neither alone would have caught all of these.

## See also

- [TCP Implementation](tcp.md) — SACK, the retransmit queue, and the receive path involved in the Challenge-ACK, SegmentSmack, and SACK panic cases
- [TCP Congestion Control](tcp-congestion.md) — how MSS and segment sizing interact with the send path
- [Netfilter Architecture](netfilter.md) — x_tables, hooks, and the compat translation layer
- [AF_PACKET Raw Sockets](packet-socket.md) — the ring-buffer mechanics behind the AF_PACKET case
- [UDP Socket Internals](udp.md) — the send path and UFO/segmentation behavior
- [Network Namespaces](net-namespaces.md) — how unprivileged user+network namespaces expose `CAP_NET_ADMIN`/`CAP_NET_RAW` gated code paths
- [Why Is the Network Stack So Complex?](network-stack-overview.md) — the broader architectural context these bugs sit within
