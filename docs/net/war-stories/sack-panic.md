# The TCP SACK Panic

> CVE-2019-11477 / CVE-2019-11478 / CVE-2019-11479 — a remote peer could crash any Linux TCP endpoint with a carefully crafted sequence of SACK blocks

Disclosed
:   June 17, 2019

Reported by
:   Jonathan Looney (Netflix)

CVSS
:   7.5 HIGH (all three)

Fixed in
:   4.4.182, 4.9.182, 4.14.127, 4.19.52, 5.1.11

Exploit tool
:   none published — the crafted-packet sequence is the whole attack

Actively exploited
:   no confirmed cases (not on CISA KEV)

*Part of [War Stories: Network Stack Bugs and CVEs](../war-stories.md).*

## Before state

TCP's selective acknowledgment (SACK) option, defined in RFC 2018, lets a receiver tell the sender exactly which byte ranges it has received out of order, instead of forcing the sender to retransmit everything after the first gap. To implement this efficiently, Linux's retransmit queue and out-of-order queue hold data in `struct sk_buff` (SKB) chains, and the kernel aggressively **coalesces** adjacent SKBs together as SACK information arrives, to avoid keeping thousands of tiny buffer fragments around.

Each SKB carries a `struct tcp_skb_cb` control block (`include/net/tcp.h`) that tracks, among other things, `tcp_gso_segs` — the number of MSS-sized segments the SKB represents for generic segmentation offload (GSO) accounting. This field is a **16-bit unsigned integer**, which is fine as long as a single SKB never represents more than 65,535 segments. An SKB can hold up to 17 fragments (`MAX_SKB_FRAGS`), each up to 32 KB on x86 (64 KB on some PowerPC configurations with 64 KB pages) — so a maximally-packed SKB can hold over 500 KB of payload. If the MSS is tiny, that translates into an enormous segment count.

## The trigger

Linux enforces a minimum MSS floor, but as of the vulnerable code that floor was hardcoded to 48 bytes in `__tcp_mtu_to_mss()` in `net/ipv4/tcp_output.c` — and TCP options can consume up to 40 of those bytes, leaving as little as **8 bytes of real payload per segment**. Jonathan Looney at Netflix found that a remote peer could advertise this minimal MSS and then send a carefully crafted sequence of SACK blocks — published as [Netflix's own advisory](https://github.com/Netflix/security-bulletins/blob/master/advisories/third-party/2019-001.md) (NFLX-2019-001), the primary source for all three CVEs. Because SACK processing causes `tcp_shift_skb_data()` in `net/ipv4/tcp_input.c` to coalesce retransmit-queue SKBs via `skb_shift()`, an attacker could drive one SKB's accumulated segment count past 65,535 — silently overflowing the 16-bit `tcp_gso_segs` field.

## Observed behavior

The overflow caused `tcp_shifted_skb()` to hit:

```c
BUG_ON(tcp_skb_pcount(skb) < pcount);
```

`BUG_ON()` triggers a kernel panic. A remote, unauthenticated peer could crash any Linux TCP endpoint that had SACK enabled (the default) — this is CVE-2019-11477, the most severe of the three. Two related bugs were reported alongside it:

- **CVE-2019-11478**: even without hitting the panic, an attacker could use crafted SACK sequences to force `tcp_fragment()` (`net/ipv4/tcp_output.c`) to fragment the retransmit queue into a very large number of tiny SKBs, inflating memory usage per connection.
- **CVE-2019-11479**: because the minimum MSS was hardcoded to 48 bytes, an attacker didn't even need SACK tricks — simply advertising a tiny MSS forced the kernel to do far more per-byte work (more headers, more SKBs, more CPU) than a sane minimum would allow.

LWN's coverage (["The TCP SACK panic", June 2019](https://lwn.net/Articles/791409/)) noted this was "the most serious of four SACK-related bugs found by Jonathan Looney at Netflix" (a fourth, related bug affected FreeBSD's RACK stack, not Linux).

## Why it happened

Three independent weaknesses combined:

1. `tcp_gso_segs` is a `u16` — a hard ceiling of 65,535 that nothing enforced before coalescing.
2. `tcp_shift_skb_data()` called `skb_shift()` directly with no check on the resulting segment count, so coalescing could silently overflow the field.
3. The MSS floor (48 bytes) was low enough that reaching a 65,535-segment SKB was achievable with realistic amounts of retransmit-queue data, and `tcp_fragment()` had no cap on how many times a queue could be split relative to socket buffer size.

The `BUG_ON()` in `tcp_shifted_skb()` was a defensive assertion written on the assumption that the segment count could never be inconsistent — a remote peer proved that assumption wrong.

The bug's reach also grew in a way nobody was tracking as a security property. In the comments beneath LWN's coverage, kernel developer Richard Weinberger observed that on older kernels the `BUG_ON()` was reachable only when GSO/GRO offload was actually negotiated for a flow. That, in his reading, changed with [`0a6b2a1dc2a2`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=0a6b2a1dc2a2105f178255fe495eb914b09cb37a) ("tcp: switch to GSO being always on", February 2018), also authored by Eric Dumazet, merged for an unrelated reason: fixing a BBR-pacing performance problem reported by Oleksandr Natalenko by making GSO mandatory for every TCP socket instead of an opportunistic offload. That change had nothing to do with security, but on Weinberger's account it widened the SACK panic's blast radius from "flows using GSO/GRO" to "every Linux TCP endpoint."

Also in that comment thread, XFS maintainer Dave Chinner ("dgc") recognized the bug's shape from a much older incident: "I remember back in late 2002 when a bug report for an Irix NFS server performance issue was nailed down to a serious SACK problem due to really small MSS windows being sent from a buggy NFS client implementation. The phrase 'SACK panic' triggered my memory immediately…" Chinner's broader point was about institutional memory, not blame: "the OS networking community knew about these problems 15 years ago but that knowledge seems to have been lost and so we have repeated past mistakes. Which raises some interesting questions: where did that institutional knowledge go?"

## Resolution

Three separate commits addressed the three CVEs:

- **CVE-2019-11477** — [`3b4929f65b0d`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=3b4929f65b0d8249f19a50245cd88ed1a2f78cff) ("tcp: limit payload size of sacked skbs") introduces `tcp_skb_shift()`, a wrapper around `skb_shift()` that refuses to shift if the result would push `to->len` past `65535 * TCP_MIN_GSO_SIZE` bytes or `tcp_skb_pcount()` past 65,535 segments, and downgrades the `BUG_ON()` to `WARN_ON_ONCE()` so an inconsistency no longer panics the box.
- **CVE-2019-11478** — [`f070ef2ac667`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=f070ef2ac66716357066b683fb0baf55f8191a2e) ("tcp: tcp_fragment() should apply sane memory limits") makes `tcp_fragment()` refuse to split a packet once `sk_wmem_queued` exceeds twice `sk_sndbuf` (`(sk->sk_wmem_queued >> 1) > sk->sk_sndbuf`), returning `-ENOMEM` and incrementing a new `TCPWqueueTooBig` SNMP counter instead.
- **CVE-2019-11479** — [`967c05aee439`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=967c05aee439e6e5d7d805e195b3a20ef5c433d6) enforces a new `net.ipv4.tcp_min_snd_mss` sysctl in `tcp_mtu_probing()`, and a companion commit, [`5f3e2bf008c2`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=5f3e2bf008c2221478101ee72f5cb4654b9fc363) ("tcp: add tcp_min_snd_mss sysctl"), adds the sysctl itself. The default stays at 48 for compatibility, but administrators can now raise it.

These patches were [posted to netdev](https://lore.kernel.org/netdev/20190617170354.37770-1-edumazet@google.com/) on June 17, 2019 as part of the public disclosure, and the CVE-2019-11478 fix immediately surfaced a real regression: Christoph Paasch reported a packetdrill test that used to pass but now stalled indefinitely, because a connection with `SO_SNDBUF` forced artificially low could no longer fragment its retransmit queue at all once `sk_wmem_queued` exceeded the new limit.

Eric Dumazet's initial response — "I guess it is WAI :)" — offered a quick guard anyway, skipping the new check when the retransmit queue was empty (`!tcp_rtx_queue_empty(sk)`), which Paasch confirmed fixed his test. But he also flagged an open question: could a connection get permanently stuck if `sk_wmem_queued` grew large enough that even a legitimate retransmit couldn't fragment? Dumazet's answer at the time was blunt: "Really TCP can not work well with tiny sndbuf limits. There is really no point trying to be nice."

The emailed patch was only a stopgap. What actually shipped four days later as [`b6653b3629e5`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b6653b3629e5b88202be3c9abc44713973f5c4b4) ("tcp: refine memory limit test in tcp_fragment()") used a more precise condition — exempting fragmentation of skbs already in the write queue (`tcp_queue != TCP_FRAG_IN_WRITE_QUEUE`) rather than checking whether the retransmit queue was empty — on the reasoning that `tcp_sendmsg()` only enforces `SO_SNDBUF` at 64&nbsp;KB skb boundaries, so the first skb built by an application could legitimately need one more split.

That still wasn't the end of it. Three weeks later, Andrew Prout at the MIT Lincoln Laboratory Supercomputing Center hit what Paasch had predicted: TCP connections over a non-blocking 10&nbsp;Gbit fabric — VPN users pulling large files over Samba, and MPI jobs over TCP/IP — stalling permanently and never recovering, bisected to the CVE-2019-11478 fix and confirmed by a rising `TCPWqueueTooBig` counter.

On netdev, Christoph Paasch proposed always permitting the allocation when `tcp_fragment()` was called from the retransmit timer specifically, reasoning that the original attack relied on forged SACK blocks, not legitimate retransmits. Dumazet rejected always-allow as reopening the same hole at scale ("Anything we add in TCP stack to overcome the SO_SNDBUF by twice the limit _will_ be exploited at scale") and instead floated raising `tcp_retrans_collapse` from 1 to 3 to shrink the queue through better collapsing.

What actually shipped, [`b617158dc096`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b617158dc096709d8600c53b6052144d12b89fab) ("tcp: be more careful in tcp_fragment()", July 2019), split the difference: it lets the first and last skb in the retransmit queue split even when the memory limit is hit — enough to unstick a stalled connection without lifting the cap generally — and adds explicit headroom for the up-to-64&nbsp;KB overshoot `tcp_sendmsg()`/`tcp_sendpage()` can legitimately produce. That closed the MIT Lincoln Lab report.

Two months after that, [Databricks published an account](https://www.databricks.com/blog/2019/09/16/adventures-in-the-tcp-stack-performance-regressions-vulnerability-fixes.html) of hitting the same fix from the other side: a Spark job writing to S3 on AWS ran 6x slower. They traced it to a connection where `sk_sndbuf` was 46,080 bytes but `sk_wmem_queued` had legitimately grown to 103,971 — a 56&nbsp;KB gap, because `tcp_sendmsg()`/`tcp_sendpage()` only enforce `SO_SNDBUF` at 64&nbsp;KB skb boundaries, exactly the overshoot `b617158dc096` had already been written to tolerate. Their write-up is a confirmation of the already-shipped fix's rationale, not an independent report that drove new kernel work.

All three original fixes shipped in the 4.4.182, 4.9.182, 4.14.127, 4.19.52, and 5.1.11 stable releases on June 17, 2019, with the two follow-up `tcp_fragment()` refinements landing over the following month. Operators unable to upgrade immediately had interim mitigations: disable MTU probing (`net.ipv4.tcp_mtu_probing=0`) and disable SACK (`net.ipv4.tcp_sack=0`) to blunt CVE-2019-11477/78, or filter out unreasonably small advertised MSS values at the firewall for CVE-2019-11479.

No published exploit tool or Metasploit module exists for this one — a remote kernel panic doesn't need one; the crafted-SACK sequence Netflix documented in its own advisory is the entire "exploit." The real measure of its reach is the vendor response: NVD lists over 25 distinct downstream advisories, spanning Cisco, Oracle, VMware, F5, Huawei, Aruba, Pulse Secure, McAfee, SonicWall, NetApp, Synology — and a [Siemens ProductCERT advisory](https://cert-portal.siemens.com/productcert/pdf/ssa-462066.pdf) plus a dedicated [CISA ICS advisory](https://www.cisa.gov/news-events/ics-advisories/icsa-19-253-03), meaning this reached into industrial control systems, not just cloud and enterprise gear.

```bash
# Check whether the fixed sysctl is present and what it's set to
sysctl net.ipv4.tcp_min_snd_mss
```

## What it taught us

**A fixed-width counter is a hard ceiling, not a soft guideline.** `tcp_gso_segs` being a `u16` was a reasonable choice under the assumption that no single SKB could realistically represent more than 65,535 segments — an assumption that held until an attacker controlled the MSS.

**`BUG_ON()` on attacker-influenced state is a self-inflicted denial-of-service.** The assertion was meant to catch programmer error, not adversarial input; turning an invariant violation triggered by a remote peer into a kernel panic converts a bug into a crash-on-demand primitive.

**A "reasonable minimum" needs its own floor.** The 48-byte MSS minimum was implicitly relied upon by other size calculations; nothing in the codebase treated it as a security-relevant parameter until it was exploited as one.

**A resource cap shipped under embargo will collide with legitimate workloads it wasn't tested against.** The CVE-2019-11478 fix was correct in isolation but had never been validated against unusual-but-real configurations — an artificially small `SO_SNDBUF`, a non-blocking 10&nbsp;Gbit fabric, a zero-copy `sendfile()` path — because coordinated disclosure limits how widely a fix can be tested before it ships. Both follow-up incidents were legitimate traffic tripping a new limit, not new attacks; the cap needed two more rounds of refinement (`b6653b3629e5`, `b617158dc096`) before it stopped colliding with real usage.

!!! warning "Pattern to watch for"
    Any per-connection or per-buffer counter derived from attacker-controllable values (segment counts, buffer sizes, queue lengths) needs an explicit cap that's enforced *before* the value is used, not just an assertion that fires after it's already wrong. If you're running a pre-5.1.11/4.19.52/4.14.127/4.9.182/4.4.182 kernel, check `sysctl net.ipv4.tcp_min_snd_mss` — its absence means you're still exposed.

## See also

- [TCP Implementation](../tcp.md) — SACK, the retransmit queue, and the receive path involved in this bug
- [TCP Congestion Control](../tcp-congestion.md) — how MSS and segment sizing interact with the send path
- [SegmentSmack](segmentsmack.md) and [The Challenge-ACK Side Channel](challenge-ack.md) — two other TCP-layer war stories from the same era

## External references

- [Netflix: NFLX-2019-001](https://github.com/Netflix/security-bulletins/blob/master/advisories/third-party/2019-001.md) — Jonathan Looney's original advisory, including patches and workarounds for all three CVEs
- [NVD: CVE-2019-11477](https://nvd.nist.gov/vuln/detail/CVE-2019-11477), [CVE-2019-11478](https://nvd.nist.gov/vuln/detail/CVE-2019-11478), [CVE-2019-11479](https://nvd.nist.gov/vuln/detail/CVE-2019-11479) — the TCP SACK panic CVE records
- [git.kernel.org: 3b4929f65b0d](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=3b4929f65b0d8249f19a50245cd88ed1a2f78cff) — "tcp: limit payload size of sacked skbs"
- [git.kernel.org: f070ef2ac667](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=f070ef2ac66716357066b683fb0baf55f8191a2e) — "tcp: tcp_fragment() should apply sane memory limits"
- [git.kernel.org: 967c05aee439](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=967c05aee439e6e5d7d805e195b3a20ef5c433d6) and [5f3e2bf008c2](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=5f3e2bf008c2221478101ee72f5cb4654b9fc363) — "tcp: enforce tcp_min_snd_mss in tcp_mtu_probing()" and the sysctl that backs it
- [LWN: The TCP SACK panic](https://lwn.net/Articles/791409/) — Jake Edge's coverage of CVE-2019-11477/78/79, including comments on the 2018 GSO-always-on change and the 2002 Irix SACK-panic precedent
- [lore.kernel.org: tcp: make sack processing more robust](https://lore.kernel.org/netdev/20190617170354.37770-1-edumazet@google.com/) — the netdev disclosure thread, including Christoph Paasch's regression report against the CVE-2019-11478 fix and Eric Dumazet's follow-up guard
- [git.kernel.org: 0a6b2a1dc2a2](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=0a6b2a1dc2a2105f178255fe495eb914b09cb37a) — "tcp: switch to GSO being always on" (February 2018), the unrelated performance fix that widened the SACK panic's later reach
- [git.kernel.org: b6653b3629e5](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b6653b3629e5b88202be3c9abc44713973f5c4b4) and [b617158dc096](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b617158dc096709d8600c53b6052144d12b89fab) — the two follow-up refinements to the CVE-2019-11478 `tcp_fragment()` fix, prompted by real-world regression reports
- [Databricks: Adventures in the TCP stack](https://www.databricks.com/blog/2019/09/16/adventures-in-the-tcp-stack-performance-regressions-vulnerability-fixes.html) — an account of hitting the CVE-2019-11478 fix's 64&nbsp;KB `SO_SNDBUF` overshoot allowance, causing a 6x S3-write slowdown, traced to `tcp_fragment()`'s memory-limit check
- [Siemens ProductCERT: SSA-462066](https://cert-portal.siemens.com/productcert/pdf/ssa-462066.pdf) and [CISA ICS Advisory ICSA-19-253-03](https://www.cisa.gov/news-events/ics-advisories/icsa-19-253-03) — evidence of reach into industrial control system products
