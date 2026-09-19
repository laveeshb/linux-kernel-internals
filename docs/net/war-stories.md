# War Stories: Network Stack Bugs and CVEs

> Real vulnerabilities and production incidents from Linux networking history — what broke, why, and what the kernel learned

The network stack sits at a trust boundary that most of the kernel doesn't have to deal with: its input arrives from the wire, often from a remote, unauthenticated peer, and gets parsed and acted on before any application-layer authentication happens. A bug in TCP's SACK processing, in a netfilter compat shim, or in a socket-ring-buffer size calculation is reachable by anyone who can send packets to the box — no local shell required. That's why network-stack incidents skew toward remote denial-of-service and remote-triggered memory corruption, rather than the local data-loss and performance-regression stories that dominate filesystem and I/O history.

Each incident below has its own page: root-cause analysis grounded in the actual patches, plus the real mailing-list discussion behind each fix — alternatives considered, trade-offs debated, and in a few cases genuinely notable process failures. Three are remote (reachable over the network with no local access); the other four are local — three of them reachable through capabilities (`CAP_NET_ADMIN`, `CAP_NET_RAW`) that are routinely granted to unprivileged processes inside user namespaces, and one through nothing more than an ordinary `sendmsg()` sequence. That capability angle is itself a recurring theme in how "local" bugs in this subsystem became "container escape" bugs.

## Incidents

Ordered reverse chronologically by disclosure date — newest first.

### [The net/sched act_api Filter-Delete Race](war-stories/act-api-uaf.md)
**Fixed June 2026, public exploit write-up July 2026 · CVE-2026-53264 · CVSS 7.8 (NVD) / 7.0 (Red Hat)**
A 2017 comment correctly reasoned that one reader path was RCU-safe and never checked whether a second one was — nine years later, a researcher's AI-assisted write-up turned the resulting use-after-free into a root exploit in about 5 seconds per attempt.

### [Netfilter x_tables Heap Overflow](war-stories/netfilter-xtables.md)
**Fixed April 2021, disclosed July 2021 · CVE-2021-22555 · CVSS 8.3 (Google) / 7.8 (NVD)**
A 15-year-old bounds-check gap, sitting unanswered in a syzbot report for 8 months, became "Turning \x00\x00 into 10000$" and a real Kubernetes pod escape once someone built an exploit chain for it. Still being actively exploited as of late 2025, per CISA's KEV catalog.

### [The TCP SACK Panic](war-stories/sack-panic.md)
**June 2019 · CVE-2019-11477/78/79 · CVSS 7.5 (all three)**
A remote peer could crash any Linux TCP endpoint by overflowing a 16-bit segment counter with a crafted sequence of SACK blocks. The fix itself then collided with legitimate high-throughput and small-buffer workloads twice more before it stopped causing production stalls.

### [SegmentSmack](war-stories/segmentsmack.md)
**August 2018 · CVE-2018-5390 · CVSS 7.5**
Tiny, deliberately-scattered out-of-order TCP segments could pin a CPU core at 100% with roughly 2 kilopackets/second of traffic. The public disclosure process became its own controversy, chronicled in detail on LWN.

### [UDP Fragmentation-Offload Path-Switch Corruption](war-stories/udp-ufo.md)
**August 2017 · CVE-2017-1000112 · CVSS 7.0**
Two `send()` calls building the same datagram could disagree about which code path was building it, twelve years after the bug was introduced. Embargo-disclosed and fixed in one week.

### [AF_PACKET TPACKET_V3 Privilege Escalation](war-stories/af-packet.md)
**March 2017 · CVE-2017-7308 · CVSS 7.8**
A single `(int)` cast around an unsigned subtraction defeated a ring-buffer bounds check — found by syzkaller, turned into local root by Project Zero.

### [The TCP Challenge-ACK Side Channel](war-stories/challenge-ack.md)
**August 2016 · CVE-2016-5696 · CVSS 4.8**
A global rate-limit counter, meant purely as an internal implementation detail, let an off-path attacker infer TCP sequence numbers by watching how much of the shared quota a victim connection consumed.

## Common threads

| Pattern | act_api race | Netfilter x_tables | SACK panic | SegmentSmack | UFO path-switch | AF_PACKET | Challenge-ACK |
|---------|:------------:|:-------------------:|:----------:|:-------------:|:-----------------:|:----------:|:--------------:|
| Remotely triggerable, no local access needed | No | No | Yes | Yes | No | No | Yes |
| Root cause is an integer/width assumption | No | No | Yes | No | Yes | Yes | No |
| Found via fuzzing (syzkaller) or automated tooling | Partial | Partial | No | No | Yes | Yes | No |
| Capability check defeated by user namespaces | Yes | Yes | No | No | No | Yes | No |
| Published exploit tool exists (PoC or Metasploit module) | Yes | Yes | No | No | Yes | Yes | Yes |
| Confirmed active exploitation (CISA KEV) | No | Yes | No | No | No | No | No |
| Fix added an explicit cap/invariant, not just a patch to one call site | Yes | Yes | Yes | Yes | Yes | Yes | Yes |

Three of these seven are reachable by an attacker who has never authenticated to anything — they only need to be able to route packets to the target, which is the defining characteristic of network-stack bugs as a category. The other four (act_api, Netfilter x_tables, AF_PACKET, and the UDP UFO bug) require local execution; three of those four are gated only by capabilities (`CAP_NET_ADMIN` for act_api and Netfilter x_tables, `CAP_NET_RAW` for AF_PACKET) that are either trivially available or handed out routinely by unprivileged user namespaces, and the fourth (UDP UFO) needs nothing more than an ordinary `sendmsg()` sequence — which is why several of these ended up cited as container-escape primitives rather than filed away as low-severity local bugs.

The other recurring shape is **an assumption that held for years until an adversary specifically targeted it**: a 16-bit segment counter, a per-second reset boundary, a per-entry padding write, a signed cast, a per-call path decision, a 2017 comment about which reader paths an RCU grace period actually covered — each was locally reasonable and had shipped for anywhere from under two years (SegmentSmack) to fifteen years (Netfilter x_tables) before someone deliberately constructed the input (or, for act_api, the exact interleaving) that broke the assumption. Fuzzing (syzkaller, in the act_api, AF_PACKET, and UFO cases) and dedicated security research (OpenAI, STAR Labs, Netflix, Project Zero, academic researchers) each found different corners of this space; neither alone would have caught all of these.

A working exploit and confirmed real-world exploitation are not the same thing, and the two don't correlate the way severity scores suggest. Five of these seven had a fully working, published exploit — a Kubernetes pod escape (Netfilter x_tables), Metasploit modules for both AF_PACKET and UDP UFO, a standalone proof-of-concept (`mountain_goat`) for the Challenge-ACK side channel, and an AI-assisted root exploit chain (STAR Labs) for the act_api race — but as of this writing, only Netfilter x_tables (added to CISA's KEV catalog in October 2025, per [NVD](https://nvd.nist.gov/vuln/detail/CVE-2021-22555)) has ever been confirmed under active exploitation against real targets, years after its patch shipped. The other published exploits remain, as far as public records show, research and disclosure artifacts rather than bugs known to have been weaponized in the field.

The two DoS bugs (SACK panic, SegmentSmack) never got a dedicated exploit tool at all — a crafted packet sequence *is* the entire attack, nothing to weaponize — but they show a different kind of impact evidence: each triggered a wide wave of downstream vendor advisories (Cisco, Oracle, F5, VMware, Siemens, and roughly two dozen others for SACK panic alone), including dedicated industrial-control-system advisories from Siemens and CISA/ICS-CERT. "No exploit tool" and "no real consequence" are not the same claim either — the scale of who had to patch is its own evidence of reach, even without a confirmed in-the-wild attack.

## See also

- [TCP Implementation](tcp.md) — SACK, the retransmit queue, and the receive path involved in the SACK panic, SegmentSmack, and Challenge-ACK cases
- [TCP Congestion Control](tcp-congestion.md) — how MSS and segment sizing interact with the send path
- [Netfilter Architecture](netfilter.md) — x_tables, hooks, and the compat translation layer
- [AF_PACKET Raw Sockets](packet-socket.md) — the ring-buffer mechanics behind the AF_PACKET case
- [UDP Socket Internals](udp.md) — the send path and UFO/segmentation behavior
- [Network Namespaces](net-namespaces.md) — how unprivileged user+network namespaces expose `CAP_NET_ADMIN`/`CAP_NET_RAW` gated code paths
- [Why Is the Network Stack So Complex?](network-stack-overview.md) — the broader architectural context these bugs sit within
