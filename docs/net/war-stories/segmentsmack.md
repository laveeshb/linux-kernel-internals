# SegmentSmack

> CVE-2018-5390 — tiny, deliberately-scattered out-of-order TCP segments could pin a CPU core at 100% with roughly 2 kpps of traffic

**Disclosed:** August 6, 2018 &nbsp;·&nbsp; **Reported by:** Juha-Matti Tilli (Aalto University / Nokia Bell Labs) &nbsp;·&nbsp; **CVSS:** 7.5 HIGH &nbsp;·&nbsp; **Fixed in:** 4.9.116, 4.14.59, 4.17.11, mainline 4.18

*Part of [War Stories: Network Stack Bugs and CVEs](../war-stories.md).*

## Before state

When TCP segments arrive out of order, the kernel holds them in a per-socket out-of-order (OFO) queue — an rbtree (`tp->out_of_order_queue`, introduced by commit `9f5afeae5152` "tcp: use an RB tree for ooo receive queue") keyed by sequence number, so later segments can be inserted and merged with existing ranges in roughly O(log n) time. Two related routines manage this queue under memory pressure:

- `tcp_collapse_ofo_queue()` (`net/ipv4/tcp_input.c`) walks the rbtree looking for adjacent ranges it can merge into fewer, larger SKBs, to reduce per-SKB overhead.
- `tcp_prune_ofo_queue()` drops SKBs from the OFO queue outright when the socket's receive buffer is under memory pressure.

Both were designed around the assumption that "adjacent ranges" would typically be a manageable number of reasonably sized segments.

## The trigger

Juha-Matti Tilli (Aalto University / Nokia Bell Labs) found that a remote attacker could send a stream of **tiny, out-of-order TCP segments with deliberately randomized sequence offsets** on an established connection. Because each segment lands in a different, non-adjacent spot in the rbtree, `tcp_collapse_ofo_queue()` had to walk and examine essentially every node on every incoming packet — without ever finding enough adjacency to actually shrink the queue. Red Hat's advisory noted that as little as ~2 kpps (kilopackets/second) of crafted traffic was enough to trigger the pathological behavior, and the attack could not be done with spoofed source addresses, so it required (and consumed) a real, if cheap, TCP connection.

According to [Aalto University's account of the discovery](https://www.aalto.fi/en/news/juha-matti-tilli-could-not-sleep-instead-he-had-an-idea-that-took-him-to-the-vulnerabilities), Tilli found this bug as a side effect of unrelated work: his post-graduate research was on IP fragment reassembly, where he'd identified that Linux (like most open-source stacks) walked a plain linked list to reassemble fragments — an algorithmic-complexity weakness in its own right, later tracked separately as FragmentSmack (CVE-2018-5391). Testing a balanced-search-tree replacement for that linked list, he ran speed comparisons against Linux's stack and, in the process, "also noticed another vulnerability associated with the most common way to break information, TCP segmentation" — the out-of-order queue's collapse logic. He reported both findings directly to the Finnish Communications Regulatory Authority and to Linus Torvalds.

## Observed behavior

Sustained, attacker-controlled **CPU pinning**: a single low-bandwidth connection could keep a CPU core at 100% utilization by forcing repeated O(n) or worse scans of the out-of-order queue, with the queue holding on the order of thousands of nodes under default `tcp_rmem[2]` settings (~7,000 nodes at the 6 MB default). Red Hat and the wider community named this **SegmentSmack**. LWN's follow-up (["CVE-2018-5390 and 'embargoes'", August 2018](https://lwn.net/Articles/762512/)) covered the bug's disclosure timeline rather than its internals, but confirmed the practical impact and the "SegmentSmack" naming.

## Why it happened

The merge fix for CVE-2018-5390 landed as a five-commit series merged via [`1a4f14bab186`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=1a4f14bab1868b443f0dd3c55b689a478f82e72e) ("Merge branch 'tcp-robust-ooo'"), all authored by Eric Dumazet and reported by Tilli. The underlying issues:

- `tcp_prune_ofo_queue()` freed one SKB at a time, calling `sk_mem_reclaim()` and re-checking memory pressure after *every single node* — expensive when thousands of nodes needed to go.
- `tcp_collapse_ofo_queue()` had no early-exit: it would keep scanning and attempting collapses across the whole rbtree even when the "ranges" being merged were single tiny packets that could never coalesce into anything useful.
- Nothing tracked how much *work* (versus how much *memory*) had been spent on a given collapse/prune pass, so an attacker who couldn't grow the queue's memory footprint could still make the kernel spend unbounded CPU walking it.

## Resolution

The `tcp-robust-ooo` series made the OFO queue economics attacker-resistant rather than just memory-bounded:

- `tcp: free batches of packets in tcp_prune_ofo_queue()` changed pruning to purge roughly **12.5% of `sk_rcvbuf` capacity per pass** (`goal = sk->sk_rcvbuf >> 3`) instead of reclaiming and rechecking after every node.
- `tcp: avoid collapses in tcp_prune_queue() if possible` skips calling `tcp_collapse_ofo_queue()` entirely if `sk_rmem_alloc` is already within `sk_rcvbuf`, removing an O(N²) attack surface for freshly-opened connections.
- `tcp: detect malicious patterns in tcp_collapse_ofo_queue()` refuses to attempt collapsing when the accumulated range is still made of tiny (sub-`SK_MEM_QUANTUM`-sized) SKBs, and bails out of the whole collapse pass once the sum of skipped tiny ranges exceeds `sk_rcvbuf >> 3` — capping the CPU spent on a queue that will never usefully collapse.
- `tcp: call tcp_drop() from tcp_data_queue_ofo()` and `tcp: add tcp_ooo_try_coalesce() helper` improve drop accounting (`sk->sk_drops`) so operators can actually observe an attack in progress.

David Miller's [reply when applying the series on netdev](https://lore.kernel.org/netdev/20180723162821.11556-1-edumazet@google.com/) captured how non-obvious the fix was even to a maintainer familiar with the code: "Sucky... It took me a while to understand the sums_tiny logic, every time I read that function I forget that we reset all of the state and restart the loop after a coalesce inside the loop." He queued the full series for -stable the same day.

The fifth patch (the `tcp_ooo_try_coalesce()` helper) initially missed the 4.9-stable backport anyway. David Woodhouse noticed it was absent from 4.9.116 two weeks later, Greg Kroah-Hartman confirmed it simply hadn't applied cleanly ("Odds are it did not apply and so I didn't backport it"), and Woodhouse sent a working backport.

The public disclosure that followed the merge was messier than the fix itself, and became its own point of debate. The `1a4f14bab186` merge landed in Linus's tree on July 23, 2018, and CERT was coordinating a private notification to distributions around the same problem (and a related FreeBSD bug, CVE-2018-6922). But the merged commit was public from the moment it landed, and a grsecurity tweet linking to it the same day — followed by a second tweet on July 28 when the stable backports shipped — made the fix's existence and purpose widely visible well before the CVE was formally announced.

The public CERT note didn't appear until August 6. Matthew Garrett's mandatory report to the oss-security mailing list, required once a bug has been discussed on the closed linux-distros list, followed two days after that on August 8 — light enough on detail that a member of the list, Stiepan A. Kovac, publicly pressed for more information.

Alexander Peslyak ("Solar Designer"), who moderates the distros/linux-distros/oss-security lists, laid out the full timeline and didn't defend it: "Of course, I am unhappy about this semi-embargo, and even more unhappy about the semi-violation of linux-distros list policy on only having non-public issues in there. However, with CERT involved and with related issues affecting more than just Linux, there was little I could do, short of playing full BOFH and breaking the semi-embargo for everyone." He was equally unhappy about the gap between the CERT note and the mandatory oss-security post: "I've been pinging off-list to make this happen at all, and would have probably made the posting myself if it didn't happen for another day."

[LWN's coverage of the episode](https://lwn.net/Articles/762512/) drew the conclusion that once a fix is public and being pointed at by security researchers, further "embargo" delay mostly just leaves defenders in the dark while the code itself is already exploitable by anyone reading netdev — "the horse is loose, so the state of the barn door is immaterial."

```bash
# Watch for OFO-queue pruning/drop activity indicative of this pattern
nstat -az | grep -i 'TcpExtOfoPruned\|TcpExtTCPOFOMerge'
```

## What it taught us

**Memory-bounded is not CPU-bounded.** A queue that respects `sk_rcvbuf` can still let an attacker burn unbounded CPU per byte received, if the algorithm walking that queue has no independent bound on its own work.

**Adjacency-seeking algorithms need a "give up" condition.** Collapsing/merging logic that assumes typical input will merge cleanly needs an explicit early exit for input that's adversarially structured to never merge.

**Cheap traffic, expensive processing, is the classic algorithmic-complexity attack shape.** ~2 kpps of crafted segments pinning a CPU core is a textbook complexity attack — the fix wasn't "block the traffic," it was bounding the kernel's own work per unit of attacker-controlled input.

!!! warning "Pattern to watch for"
    Watch `TcpExtOfoPruned` and `TcpExtTCPOFOMerge` in `nstat`/`/proc/net/netstat` for unusual spikes correlated with a specific peer — that's the observable signature of an out-of-order queue under this kind of pressure. Kernels before 4.9.116/4.14.59/4.17.11 (4.18 in mainline) are exposed if `tcp-robust-ooo` hasn't been backported.

## See also

- [TCP Implementation](../tcp.md) — the out-of-order queue and receive path involved in this bug
- [The TCP SACK Panic](sack-panic.md) and [The Challenge-ACK Side Channel](challenge-ack.md) — two other TCP-layer war stories from the same era

## External references

- [NVD: CVE-2018-5390](https://nvd.nist.gov/vuln/detail/CVE-2018-5390) — SegmentSmack CVE record
- [git.kernel.org: 1a4f14bab186](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=1a4f14bab1868b443f0dd3c55b689a478f82e72e) — "Merge branch 'tcp-robust-ooo'", the SegmentSmack fix series
- [lore.kernel.org: tcp: more robust ooo handling](https://lore.kernel.org/netdev/20180723162821.11556-1-edumazet@google.com/) — the netdev submission thread, including David Miller's merge reply and the follow-up about the missing 4.9-stable backport
- [LWN: CVE-2018-5390 and "embargoes"](https://lwn.net/Articles/762512/) — Jake Edge's coverage of the SegmentSmack disclosure controversy, including Alexander Peslyak's full timeline
- [Red Hat: SegmentSmack and FragmentSmack](https://access.redhat.com/articles/3553061) — the ~2 kpps attack-traffic figure and impact summary for CVE-2018-5390
- [Aalto University: Juha-Matti Tilli could not sleep](https://www.aalto.fi/en/news/juha-matti-tilli-could-not-sleep-instead-he-had-an-idea-that-took-him-to-the-vulnerabilities) — the reporter's own account of how the bug was found, alongside the sibling FragmentSmack finding
