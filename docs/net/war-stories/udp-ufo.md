# UDP Fragmentation-Offload Path-Switch Corruption

> CVE-2017-1000112 — a per-call heuristic that should have been a per-datagram invariant let two `send()` calls disagree about how a UDP datagram was being built, syzkaller-found and embargo-disclosed in one week

**Disclosed:** August 10, 2017 &nbsp;·&nbsp; **Reported by:** Andrey Konovalov (via syzkaller) &nbsp;·&nbsp; **CVSS:** 7.0 HIGH &nbsp;·&nbsp; **Bug present since:** October 2005

*Part of [War Stories: Network Stack Bugs and CVEs](../war-stories.md).*

## Before state

UDP datagrams larger than the path MTU can be built up incrementally with `MSG_MORE`, appending data across multiple `send()` calls before the kernel actually transmits. Depending on whether the underlying NIC advertises UFO (`NETIF_F_UFO`, a scatter-gather segmentation offload for UDP), `__ip_append_data()` in `net/ipv4/ip_output.c` (and its IPv6 counterpart `__ip6_append_data()` in `net/ipv6/ip6_output.c`) chooses one of two paths for building the outgoing SKB(s): the UFO path via `ip_ufo_append_data()`, which builds a single GSO SKB with the fragmentation deferred to the NIC/software GSO, or the plain fragmentation path, which splits the data into MTU-sized SKBs itself, computing a `copy` length for each fragment as it goes.

## The trigger

The decision of which path to use was re-evaluated on **every** `send()` call in a `MSG_MORE` sequence, based on current conditions, rather than being fixed for the lifetime of the datagram being built. Andrey Konovalov, using syzkaller, found that between two `send()` calls on the same socket building the same oversized datagram, the append path could **switch from UFO to non-UFO** mid-datagram.

When the non-UFO path then continued appending onto an SKB that had already grown past the MTU under the UFO path's rules, its `copy = maxfraglen - skb->len` computation could go negative, triggering the fragmentation branch, which computed `fraggap = skb_prev->len - maxfraglen` — itself capable of exceeding the MTU — and from there `copy = datalen - transhdrlen - fraggap` could also go negative.

## Observed behavior

A negative `copy` length fed directly into `skb_copy_and_csum_bits()`, which performs an **out-of-bounds write** using that length as a copy size. The NVD entry describes the same defect present in the IPv6 code path. The bug was traced back to the original UFO scatter-gather implementation, commit `e89e9cf539a2` ("[IPv4/IPv6]: UFO Scatter-gather approach") from October 2005 — meaning it had existed for roughly twelve years before syzkaller found it.

## Why it happened

The bug is a **state-consistency bug across a multi-call API**: `sendmsg(MSG_MORE)` sequences are meant to build one logical datagram across several calls, but the UFO-vs-fragmentation decision was a per-call heuristic rather than a per-datagram invariant. Once the first `send()` call had committed an SKB to the "GSO, defer to UFO" shape, a later `send()` call in the same sequence was still free to decide independently that non-UFO fragmentation applied — even though the SKB it was appending to was already built under different assumptions.

## Resolution

[`85f1bd9a7b5a`](https://github.com/torvalds/linux/commit/85f1bd9a7b5a79d5baa8bf44af19658f7bf77bfa) ("udp: consistently apply ufo or fragmentation"), authored by Willem de Bruijn and reported by Andrey Konovalov, enforces the invariant explicitly in both `__ip_append_data()` and `__ip6_append_data()`: **once an SKB is GSO (`skb_is_gso(skb)`), always continue appending via the UFO path** for the rest of that datagram, regardless of what the size/MTU heuristic would otherwise choose:

```c
if ((skb && skb_is_gso(skb)) ||
    (((length + (skb ? skb->len : fragheaderlen)) > mtu) &&
    (skb_queue_len(queue) <= 1) &&
    (sk->sk_protocol == IPPROTO_UDP) &&
    (rt->dst.dev->features & NETIF_F_UFO) && !dst_xfrm(&rt->dst) &&
    (sk->sk_type == SOCK_DGRAM) && !sk->sk_no_check_tx)) {
        err = ip_ufo_append_data(...);
```

The `skb_queue_len(queue) <= 1` condition handles the reverse direction: once a datagram has already been split across more than one SKB by the fragmentation path, UFO is no longer considered, so the path cannot switch *into* UFO partway through either. A related change in `udp_send_skb()` also stops honoring `sk->sk_no_check_tx` (checksum-disable) once a packet is already GSO, since a GSO SKB must carry a partial checksum. The fix landed in mainline in August 2017 and was backported to stable kernels; Debian shipped it as DSA-3981.

David Miller applied the patch the same day it was posted to netdev ("Applied and queued up for -stable"). A few days later Vasily Averin (Virtuozzo) asked on the list whether the new logic might now route non-UDP traffic through `ip_ufo_append_data()`. De Bruijn clarified that `__ip_append_data()`'s GSO branch is reachable only for UDP sockets — TCP and other segmentable protocols call `ip_queue_xmit()` instead and never enter this path — confirming the fix hadn't inadvertently widened what code the change could affect.

There's no earlier public back-and-forth over how to fix this because there wasn't a public phase before the fix: Konovalov's own [account of the disclosure](https://xairy.io/articles/cve-2017-1000112) shows the bug went straight to `security@kernel.org` on 3 August 2017 and to `linux-distros@` the next day, with the patch only reaching the public `netdev` list on 10 August, the same day it was merged and announced. That compressed, one-week, embargoed timeline is why the netdev thread reads as a finished patch rather than a debated one — the debate, if any, happened off-list.

What Konovalov's [disclosure email](https://seclists.org/oss-sec/2017/q3/277) does surface is a second, broader track running in parallel to the targeted fix: "David has also sent an RFC series to remove UFO completely, which should be merged in 4.14." That series — [`[PATCH v2 RFC 0/13] Remove UDP Fragmentation Offload support`](https://web.archive.org/web/20250414125717/https://www.spinics.net/lists/netdev/msg443815.html), posted by David Miller on 7 July 2017, a full month before this CVE was even reported — wasn't a response to the bug; Miller's stated rationale was that "very few devices support this operation, its usefulness is questionable at best, and it adds a non-trivial amount of complexity to our data paths."

But it meant the kernel had two fixes in flight at once for the same underlying feature: a minimal, stable-backportable patch that repaired the UFO/fragmentation invariant (what actually shipped for this CVE, since it could go to `-stable` immediately), and a slower-moving, `net-next`-only effort to remove software UFO offload altogether, which was too large and too likely to break existing users (UFO support was later partially restored for tuntap/`AF_PACKET` to preserve live-migration compatibility with older guests) to be a candidate for an urgent security fix. The invariant fix addressed the immediate bug without waiting on, or depending on, that larger cleanup.

## What it taught us

**Multi-call APIs need invariants that survive across calls, not just per-call correctness.** Each individual `send(MSG_MORE)` call's path-selection logic was locally reasonable; the bug only existed in the transition between two calls that each made a locally-correct but mutually inconsistent decision.

**A twelve-year-old code path is not a validated code path — it's an unfuzzed one.** UFO's scatter-gather logic from 2005 had simply never been exercised by the specific interleaving syzkaller found; age is not evidence of correctness for combinatorially rare input sequences.

**syzkaller-class fuzzing finds exactly this shape of bug.** State-machine inconsistencies triggered by an unusual sequence of syscalls (here, two `send()` calls with specific size/MTU relationships) are precisely what coverage-guided kernel fuzzing is good at surfacing, and are hard to find by code review alone.

!!! warning "Pattern to watch for"
    Any code path where a per-call heuristic decision (buffer strategy, offload path, algorithm choice) can vary across a sequence of calls building one logical object is a candidate for this bug class. If your workload uses `MSG_MORE` with UDP sockets near or above MTU size, make sure you're on a kernel that includes `85f1bd9a7b5a` (August 2017 or later stable).

## See also

- [UDP Socket Internals](../udp.md) — the send path and UFO/segmentation behavior behind this bug
- [AF_PACKET Privilege Escalation](af-packet.md) — another syzkaller-found bug in the same era

## External references

- [NVD: CVE-2017-1000112](https://nvd.nist.gov/vuln/detail/CVE-2017-1000112) — UDP UFO path-switch CVE record
- [GitHub mirror: 85f1bd9a7b5a](https://github.com/torvalds/linux/commit/85f1bd9a7b5a79d5baa8bf44af19658f7bf77bfa) — "udp: consistently apply ufo or fragmentation"
- [lore.kernel.org: udp: consistently apply ufo or fragmentation](https://lore.kernel.org/netdev/20170810162919.50577-1-willemdebruijn.kernel@gmail.com/) — the netdev thread, including David Miller's same-day merge and a follow-up correctness question from Vasily Averin
- [Andrey Konovalov: CVE-2017-1000112](https://xairy.io/articles/cve-2017-1000112) — the reporter's own writeup and disclosure timeline
- [oss-security: CVE-2017-1000112 disclosure](https://seclists.org/oss-sec/2017/q3/277) — Konovalov's public announcement, including the reference to David Miller's parallel UFO-removal RFC
- [Wayback Machine: [PATCH v2 RFC 0/13] Remove UDP Fragmentation Offload support](https://web.archive.org/web/20250414125717/https://www.spinics.net/lists/netdev/msg443815.html) — David Miller's RFC series to remove software UFO entirely, in flight a month before this CVE was reported (spinics.net's live site is currently unreachable)
