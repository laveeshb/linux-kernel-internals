# War Stories: Network Stack Bugs and CVEs

> Real vulnerabilities and production incidents from Linux networking history — what broke, why, and what the kernel learned

The network stack sits at a trust boundary that most of the kernel doesn't have to deal with: its input arrives from the wire, often from a remote, unauthenticated peer, and gets parsed and acted on before any application-layer authentication happens. A bug in TCP's SACK processing, in a netfilter compat shim, or in a socket-ring-buffer size calculation is reachable by anyone who can send packets to the box — no local shell required. That's why network-stack incidents skew toward remote denial-of-service and remote-triggered memory corruption, rather than the local data-loss and performance-regression stories that dominate filesystem and I/O history.

This page documents six well-documented incidents drawn from CVE records and kernel commit history, with root-cause analysis grounded in the actual patches — not hypothetical scenarios. Four are remote (reachable over the network with no local access); two are local privilege-escalation primitives reachable through capabilities (`CAP_NET_RAW`, `CAP_NET_ADMIN`) that are routinely granted to unprivileged processes inside user namespaces, which is itself a recurring theme in how "local" bugs in this subsystem became "container escape" bugs.

---

## Case 1: The TCP SACK panic — CVE-2019-11477 / CVE-2019-11478 / CVE-2019-11479

### Before state

TCP's selective acknowledgment (SACK) option, defined in RFC 2018, lets a receiver tell the sender exactly which byte ranges it has received out of order, instead of forcing the sender to retransmit everything after the first gap. To implement this efficiently, Linux's retransmit queue and out-of-order queue hold data in `struct sk_buff` (SKB) chains, and the kernel aggressively **coalesces** adjacent SKBs together as SACK information arrives, to avoid keeping thousands of tiny buffer fragments around.

Each SKB carries a `struct tcp_skb_cb` control block (`include/net/tcp.h`) that tracks, among other things, `tcp_gso_segs` — the number of MSS-sized segments the SKB represents for generic segmentation offload (GSO) accounting. This field is a **16-bit unsigned integer**, which is fine as long as a single SKB never represents more than 65,535 segments. An SKB can hold up to 17 fragments (`MAX_SKB_FRAGS`), each up to 32 KB on x86 (64 KB on some PowerPC configurations with 64 KB pages) — so a maximally-packed SKB can hold over 500 KB of payload. If the MSS is tiny, that translates into an enormous segment count.

### The trigger

Linux enforces a minimum MSS floor, but as of the vulnerable code that floor was hardcoded to 48 bytes in `__tcp_mtu_to_mss()` in `net/ipv4/tcp_output.c` — and TCP options can consume up to 40 of those bytes, leaving as little as **8 bytes of real payload per segment**. Jonathan Looney at Netflix found that a remote peer could advertise this minimal MSS and then send a carefully crafted sequence of SACK blocks. Because SACK processing causes `tcp_shift_skb_data()` in `net/ipv4/tcp_input.c` to coalesce retransmit-queue SKBs via `skb_shift()`, an attacker could drive one SKB's accumulated segment count past 65,535 — silently overflowing the 16-bit `tcp_gso_segs` field.

### Observed behavior

The overflow caused `tcp_shifted_skb()` to hit:

```c
BUG_ON(tcp_skb_pcount(skb) < pcount);
```

`BUG_ON()` triggers a kernel panic. A remote, unauthenticated peer could crash any Linux TCP endpoint that had SACK enabled (the default) — this is CVE-2019-11477, the most severe of the three. Two related bugs were reported alongside it:

- **CVE-2019-11478**: even without hitting the panic, an attacker could use crafted SACK sequences to force `tcp_fragment()` (`net/ipv4/tcp_output.c`) to fragment the retransmit queue into a very large number of tiny SKBs, inflating memory usage per connection.
- **CVE-2019-11479**: because the minimum MSS was hardcoded to 48 bytes, an attacker didn't even need SACK tricks — simply advertising a tiny MSS forced the kernel to do far more per-byte work (more headers, more SKBs, more CPU) than a sane minimum would allow.

LWN's coverage (["The TCP SACK panic", June 2019](https://lwn.net/Articles/791409/)) noted this was "the most serious of four SACK-related bugs found by Jonathan Looney at Netflix" (a fourth, related bug affected FreeBSD's RACK stack, not Linux).

### Why it happened

Three independent weaknesses combined:

1. `tcp_gso_segs` is a `u16` — a hard ceiling of 65,535 that nothing enforced before coalescing.
2. `tcp_shift_skb_data()` called `skb_shift()` directly with no check on the resulting segment count, so coalescing could silently overflow the field.
3. The MSS floor (48 bytes) was low enough that reaching a 65,535-segment SKB was achievable with realistic amounts of retransmit-queue data, and `tcp_fragment()` had no cap on how many times a queue could be split relative to socket buffer size.

The `BUG_ON()` in `tcp_shifted_skb()` was a defensive assertion written on the assumption that the segment count could never be inconsistent — a remote peer proved that assumption wrong.

### Resolution

Three separate commits addressed the three CVEs:

- **CVE-2019-11477** — [`3b4929f65b0d`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=3b4929f65b0d8249f19a50245cd88ed1a2f78cff) ("tcp: limit payload size of sacked skbs") introduces `tcp_skb_shift()`, a wrapper around `skb_shift()` that refuses to shift if the result would push `to->len` past `65535 * TCP_MIN_GSO_SIZE` bytes or `tcp_skb_pcount()` past 65,535 segments, and downgrades the `BUG_ON()` to `WARN_ON_ONCE()` so an inconsistency no longer panics the box.
- **CVE-2019-11478** — [`f070ef2ac667`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=f070ef2ac66716357066b683fb0baf55f8191a2e) ("tcp: tcp_fragment() should apply sane memory limits") makes `tcp_fragment()` refuse to split a packet once `sk_wmem_queued` exceeds twice `sk_sndbuf` (`(sk->sk_wmem_queued >> 1) > sk->sk_sndbuf`), returning `-ENOMEM` and incrementing a new `TCPWqueueTooBig` SNMP counter instead.
- **CVE-2019-11479** — [`967c05aee439`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=967c05aee439e6e5d7d805e195b3a20ef5c433d6) enforces a new `net.ipv4.tcp_min_snd_mss` sysctl in `tcp_mtu_probing()`, and a companion commit, [`5f3e2bf008c2`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=5f3e2bf008c2221478101ee72f5cb4654b9fc363) ("tcp: add tcp_min_snd_mss sysctl"), adds the sysctl itself. The default stays at 48 for compatibility, but administrators can now raise it.

These patches were posted to netdev on June 17, 2019 as part of the public disclosure, and the CVE-2019-11478 fix immediately surfaced a real regression: Christoph Paasch reported a packetdrill test that used to pass but now stalled indefinitely, because a connection with `SO_SNDBUF` forced artificially low could no longer fragment its retransmit queue at all once `sk_wmem_queued` exceeded the new limit. Eric Dumazet's response — "I guess it is WAI :)" — offered a follow-up guard anyway, skipping the new check when the retransmit queue is empty (`!tcp_rtx_queue_empty(sk)`), which Paasch confirmed fixed his test; he also flagged an open question about whether a connection could get permanently stuck if `sk_wmem_queued` grew large enough that even a legitimate retransmit couldn't fragment.

All three shipped in the 4.4.182, 4.9.182, 4.14.127, 4.19.52, and 5.1.11 stable releases on June 17, 2019. Operators unable to upgrade immediately had interim mitigations: disable MTU probing (`net.ipv4.tcp_mtu_probing=0`) and disable SACK (`net.ipv4.tcp_sack=0`) to blunt CVE-2019-11477/78, or filter out unreasonably small advertised MSS values at the firewall for CVE-2019-11479.

```bash
# Check whether the fixed sysctl is present and what it's set to
sysctl net.ipv4.tcp_min_snd_mss
```

### What it taught us

**A fixed-width counter is a hard ceiling, not a soft guideline.** `tcp_gso_segs` being a `u16` was a reasonable choice under the assumption that no single SKB could realistically represent more than 65,535 segments — an assumption that held until an attacker controlled the MSS.

**`BUG_ON()` on attacker-influenced state is a self-inflicted denial-of-service.** The assertion was meant to catch programmer error, not adversarial input; turning an invariant violation triggered by a remote peer into a kernel panic converts a bug into a crash-on-demand primitive.

**A "reasonable minimum" needs its own floor.** The 48-byte MSS minimum was implicitly relied upon by other size calculations; nothing in the codebase treated it as a security-relevant parameter until it was exploited as one.

!!! warning "Pattern to watch for"
    Any per-connection or per-buffer counter derived from attacker-controllable values (segment counts, buffer sizes, queue lengths) needs an explicit cap that's enforced *before* the value is used, not just an assertion that fires after it's already wrong. If you're running a pre-5.1.11/4.19.52/4.14.127/4.9.182/4.4.182 kernel, check `sysctl net.ipv4.tcp_min_snd_mss` — its absence means you're still exposed.

---

## Case 2: SegmentSmack — CVE-2018-5390

### Before state

When TCP segments arrive out of order, the kernel holds them in a per-socket out-of-order (OFO) queue — an rbtree (`tp->out_of_order_queue`, introduced by commit `9f5afeae5152` "tcp: use an RB tree for ooo receive queue") keyed by sequence number, so later segments can be inserted and merged with existing ranges in roughly O(log n) time. Two related routines manage this queue under memory pressure:

- `tcp_collapse_ofo_queue()` (`net/ipv4/tcp_input.c`) walks the rbtree looking for adjacent ranges it can merge into fewer, larger SKBs, to reduce per-SKB overhead.
- `tcp_prune_ofo_queue()` drops SKBs from the OFO queue outright when the socket's receive buffer is under memory pressure.

Both were designed around the assumption that "adjacent ranges" would typically be a manageable number of reasonably sized segments.

### The trigger

Juha-Matti Tilli (Aalto University / Nokia Bell Labs) found that a remote attacker could send a stream of **tiny, out-of-order TCP segments with deliberately randomized sequence offsets** on an established connection. Because each segment lands in a different, non-adjacent spot in the rbtree, `tcp_collapse_ofo_queue()` had to walk and examine essentially every node on every incoming packet — without ever finding enough adjacency to actually shrink the queue. Red Hat's advisory noted that as little as ~2 kbps of crafted traffic was enough to trigger the pathological behavior, and the attack could not be done with spoofed source addresses, so it required (and consumed) a real, if cheap, TCP connection.

### Observed behavior

Sustained, attacker-controlled **CPU pinning**: a single low-bandwidth connection could keep a CPU core at 100% utilization by forcing repeated O(n) or worse scans of the out-of-order queue, with the queue holding on the order of thousands of nodes under default `tcp_rmem[2]` settings (~7,000 nodes at the 6 MB default). Red Hat and the wider community named this **SegmentSmack**. LWN's follow-up (["CVE-2018-5390 and 'embargoes'", August 2018](https://lwn.net/Articles/762512/)) covered the bug's disclosure timeline rather than its internals, but confirmed the practical impact and the "SegmentSmack" naming.

### Why it happened

The merge fix for CVE-2018-5390 landed as a five-commit series merged via [`1a4f14bab186`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=1a4f14bab1868b443f0dd3c55b689a478f82e72e) ("Merge branch 'tcp-robust-ooo'"), all authored by Eric Dumazet and reported by Tilli. The underlying issues:

- `tcp_prune_ofo_queue()` freed one SKB at a time, calling `sk_mem_reclaim()` and re-checking memory pressure after *every single node* — expensive when thousands of nodes needed to go.
- `tcp_collapse_ofo_queue()` had no early-exit: it would keep scanning and attempting collapses across the whole rbtree even when the "ranges" being merged were single tiny packets that could never coalesce into anything useful.
- Nothing tracked how much *work* (versus how much *memory*) had been spent on a given collapse/prune pass, so an attacker who couldn't grow the queue's memory footprint could still make the kernel spend unbounded CPU walking it.

### Resolution

The `tcp-robust-ooo` series made the OFO queue economics attacker-resistant rather than just memory-bounded:

- `tcp: free batches of packets in tcp_prune_ofo_queue()` changed pruning to purge roughly **12.5% of `sk_rcvbuf` capacity per pass** (`goal = sk->sk_rcvbuf >> 3`) instead of reclaiming and rechecking after every node.
- `tcp: avoid collapses in tcp_prune_queue() if possible` skips calling `tcp_collapse_ofo_queue()` entirely if `sk_rmem_alloc` is already within `sk_rcvbuf`, removing an O(N²) attack surface for freshly-opened connections.
- `tcp: detect malicious patterns in tcp_collapse_ofo_queue()` refuses to attempt collapsing when the accumulated range is still made of tiny (sub-`SK_MEM_QUANTUM`-sized) SKBs, and bails out of the whole collapse pass once the sum of skipped tiny ranges exceeds `sk_rcvbuf >> 3` — capping the CPU spent on a queue that will never usefully collapse.
- `tcp: call tcp_drop() from tcp_data_queue_ofo()` and `tcp: add tcp_ooo_try_coalesce() helper` improve drop accounting (`sk->sk_drops`) so operators can actually observe an attack in progress.

David Miller's reply when applying the series on netdev captured how non-obvious the fix was even to a maintainer familiar with the code: "Sucky... It took me a while to understand the sums_tiny logic, every time I read that function I forget that we reset all of the state and restart the loop after a coalesce inside the loop." He queued the full series for -stable the same day. The fifth patch (the `tcp_ooo_try_coalesce()` helper) initially missed the 4.9-stable backport anyway — David Woodhouse noticed it was absent from 4.9.116 two weeks later, Greg Kroah-Hartman confirmed it simply hadn't applied cleanly ("Odds are it did not apply and so I didn't backport it"), and Woodhouse sent a working backport.

```bash
# Watch for OFO-queue pruning/drop activity indicative of this pattern
nstat -az | grep -i 'TcpExtOfoPruned\|TcpExtTCPOFOMerge'
```

### What it taught us

**Memory-bounded is not CPU-bounded.** A queue that respects `sk_rcvbuf` can still let an attacker burn unbounded CPU per byte received, if the algorithm walking that queue has no independent bound on its own work.

**Adjacency-seeking algorithms need a "give up" condition.** Collapsing/merging logic that assumes typical input will merge cleanly needs an explicit early exit for input that's adversarially structured to never merge.

**Cheap traffic, expensive processing, is the classic algorithmic-complexity attack shape.** ~2 kbps of crafted segments pinning a CPU core is a textbook complexity attack — the fix wasn't "block the traffic," it was bounding the kernel's own work per unit of attacker-controlled input.

!!! warning "Pattern to watch for"
    Watch `TcpExtOfoPruned` and `TcpExtTCPOFOMerge` in `nstat`/`/proc/net/netstat` for unusual spikes correlated with a specific peer — that's the observable signature of an out-of-order queue under this kind of pressure. Kernels before 4.9.116/4.14.59/4.17.11 (4.18 in mainline) are exposed if `tcp-robust-ooo` hasn't been backported.

---

## Case 3: The TCP challenge-ACK side channel — CVE-2016-5696

### Before state

RFC 5961 hardens TCP against blind in-window packet injection: instead of silently accepting or resetting a connection when a spoofed SYN or RST with an in-window (but not exactly-right) sequence number arrives, the receiver sends a **challenge ACK** — carrying the *exact* next-expected sequence number — and waits for the real peer to either confirm or ignore it. This forces an off-path attacker (one who can't see the traffic) to guess the exact sequence number, not just land within the receive window, which is a much harder problem.

Because challenge ACKs consume resources and RFC 5961 expected them to be rare, Linux rate-limited them with a single **global counter**, `challenge_count`, reset once per second and capped by `sysctl_tcp_challenge_ack_limit` (default 100/second), in `tcp_send_challenge_ack()` in `net/ipv4/tcp_input.c`.

### The trigger

Yue Cao and colleagues at UC Riverside (with Lisa Marvel from the US Army Research Laboratory) found that the shared, global nature of that counter turned it into a **side channel**. An off-path attacker can:

1. Send a burst of spoofed RST/SYN packets designed to provoke the maximum number of challenge ACKs against a victim connection they're trying to identify or hijack.
2. Simultaneously send probe traffic on their own, legitimate connection to the same server.
3. Count how many challenge ACKs *their own* connection received back. If the count is short of the expected maximum, some of the global quota was consumed by challenge ACKs sent to the victim — meaning the attacker's spoofed guess landed in-window (or matched a live connection at all).

By repeating this with different guesses, the attacker narrows in on whether a given four-tuple represents a live connection, and eventually on the in-window sequence number — all **without ever seeing a single packet of the real conversation**.

### Observed behavior

LWN's coverage (["The TCP 'challenge ACK' side channel", August 2016](https://lwn.net/Articles/696868/)) summarized the paper's results: "it takes only 10 seconds to successfully infer whether they are communicating. If there is a connection, subsequently, it takes also only tens of seconds to infer the TCP sequence numbers." The researchers demonstrated both blind connection reset (against SSH and Tor connections) and, more seriously, blind data injection into long-lived connections such as video streams — including injecting attacker-controlled JavaScript into an unencrypted web session. The paper was presented at USENIX Security 2016. Because Linux was, at the time, the only major OS to faithfully implement RFC 5961's challenge-ACK behavior, it was also the only one vulnerable to this specific side channel.

### Why it happened

The root cause is a classic shared-resource side channel: a single global counter meant to be an internal implementation detail (a rate limit) became an externally observable signal once an attacker could both *consume* the shared quota and *measure* its depletion from a different vantage point. RFC 5961 itself recommended the rate limit but didn't anticipate that the limit's exact, predictable, low value (100/second) combined with a hard reset boundary (once per second) would make the counter cheap to exhaust and easy to observe.

### Resolution

[`75ff39ccc1bd`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=75ff39ccc1bd5d3c455b6822ab09e533c551f758) ("tcp: make challenge acks less predictable"), based on analysis from Linus Torvalds, made two changes: it raised the default limit from 100 to 1000 challenge ACKs/second (`sysctl_tcp_challenge_ack_limit`), and it **randomized** how the per-second quota is consumed — rather than counting up from zero and comparing to a fixed limit, it initializes `challenge_count` each second to a random value between half and one-and-a-half times the limit, and counts *down*, so an attacker can no longer cheaply determine how much quota remains:

```c
u32 half = (sysctl_tcp_challenge_ack_limit + 1) >> 1;
challenge_timestamp = now;
WRITE_ONCE(challenge_count, half + prandom_u32_max(sysctl_tcp_challenge_ack_limit));
```

The fix landed in mainline for 4.7. Existing per-socket rate limiting (`tcp_oow_rate_limited()`) was left in place and noted as a candidate for eventually removing the global limit altogether. Operators on kernels without the fix had a documented interim mitigation: raise `net.ipv4.tcp_challenge_ack_limit` to a very large value (e.g. `999999999`) to make the counter effectively unlimited and therefore uninformative to an attacker.

The fix went through a real back-and-forth with Yue Cao on netdev before landing. Dumazet's first posting only randomized the per-second *reset boundary* (a window between 0.5s and 1.5s); Cao replied that his attack could adapt by sending a short burst reliably contained within one window and repeating the guess to resolve edge cases, which is what prompted the "v2" patch that randomizes the *count* instead — the version that shipped. Cao then described a further refinement of his attack against v2 (sending well over 1,000 probes and using the number of returned challenge ACKs to infer a correct guess) and asked whether the global limit should simply be removed, noting that neither FreeBSD nor Windows enforced one. Dumazet's reply explained why the kernel kept it anyway: the limit exists to blunt the "ACK storms" caused by "buggy firewalls and appliances" that plagued servers before rate limiting was added in 3.6, he judged the residual side channel a "small nuisance" by comparison, and he pointed out that establishing the roughly 500 connections the refined attack needs is itself hard to do quietly against a real server — with session-hijacking risk better addressed by TLS than by closing every last bit of the timing channel.

### What it taught us

**A rate limiter is also a covert channel.** Any shared counter that an attacker can both perturb and observe — even indirectly, even without reading any protected data — can leak information about state the attacker shouldn't be able to infer.

**Predictable resets amplify side channels.** A fixed per-second reset boundary meant the attacker could synchronize probes to the counter's lifecycle, turning a noisy signal into a reliable one.

**Being the only compliant implementation can mean being the only exposed one.** Linux's correctness in implementing RFC 5961 faithfully is what created the side channel — other stacks that hadn't implemented the RFC's rate limiting simply didn't have this particular counter to attack.

!!! warning "Pattern to watch for"
    Any globally-shared, attacker-perturbable counter gating a security-relevant response (challenge ACKs, error responses, retry limits) is a potential side channel if its state can be inferred by a party who didn't directly cause the perturbation. Check `sysctl net.ipv4.tcp_challenge_ack_limit` — it should be at least the post-fix default of 1000, and kernels older than 4.7 should be treated as exposed.

---

## Case 4: Netfilter x_tables heap overflow — CVE-2021-22555

### Before state

`iptables`/`ip6tables`/`arptables` rulesets are built by userspace and passed into the kernel via `setsockopt()`. On 64-bit kernels, 32-bit userspace tools (compat mode) submit rules in a **compat** layout that the kernel must translate into native 64-bit structures before use. This translation happens in `translate_compat_table()` (in each of `net/ipv4/netfilter/ip_tables.c`, `net/ipv6/netfilter/ip6_tables.c`, and `net/ipv4/netfilter/arp_tables.c`), which allocates a new buffer sized for the native layout and then calls `xt_compat_match_from_user()` / `xt_compat_target_from_user()` in `net/netfilter/x_tables.c` to copy and expand each match/target entry into it.

Native `xt_entry_match`/`xt_entry_target` structures are padded to an aligned size (`XT_ALIGN()`), but the compat versions the kernel receives from 32-bit userspace are not necessarily aligned the same way. The pre-fix code in `xt_compat_match_from_user()`/`xt_compat_target_from_user()` tried to zero just the padding gap for each individual entry:

```c
pad = XT_ALIGN(match->matchsize) - match->matchsize;
if (pad > 0)
    memset(m->data + match->matchsize, 0, pad);
```

### The trigger

This per-entry padding zero used an offset (`m->data + match->matchsize`) computed independently for each match/target, without re-checking it against the actual size of the destination buffer allocated for the *whole* translated ruleset. By choosing targets whose `matchsize`/`targetsize` isn't 8-byte aligned (Andy Nguyen's exploit writeup cites `NFLOG` as one such target, with padding reaching up to `0x4C` bytes), a local process able to load such a compat ruleset could cause the `memset()` to write a small number of zero bytes **past the end of the allocated ruleset blob** — a heap out-of-bounds write. Reaching this code path requires only being able to call `setsockopt(IPT_SO_SET_REPLACE)` (or the IPv6/ARP equivalents) from a 32-bit compat context, which requires `CAP_NET_ADMIN` — a capability routinely available to an unprivileged user inside a user *and* network namespace.

### Observed behavior

The bug had existed since **2.6.19-rc1** (2006) — roughly fifteen years — reachable via `net/netfilter/x_tables.c`. It was reported to the kernel by syzbot and independently by Andy Nguyen (Google). Its severity came less from the bug itself (a write of a handful of zero bytes) than from what that primitive enabled: Andy Nguyen's public writeup, [`CVE-2021-22555: Turning \x00\x00 into 10000$`](https://google.github.io/security-research/pocs/linux/cve-2021-22555/writeup.html), demonstrates using the four-zero-byte out-of-bounds write to corrupt an in-flight `msg_msg` object via heap spraying, build a use-after-free, leak kernel heap and code addresses, hijack a `pipe_buffer`'s function-pointer table, and ultimately execute a ROP chain that calls `commit_creds()` and switches namespaces — turning a tiny OOB write into full kernel code execution. Nguyen used the exploit to escape a Kubernetes pod's isolation in Google's kCTF cluster, as covered by LWN (["CVE-2021-22555: Turning \x00\x00 into 10000$", July 2021](https://lwn.net/Articles/862955/)).

### Why it happened

The root cause is a **local, per-entry bounds check standing in for a missing global bounds check**: each match/target's padding write was "correct" in isolation (it wrote exactly `pad` bytes past that entry's data), but nothing validated that the cumulative effect of translating every entry in the ruleset stayed within the single buffer allocated up front. A fifteen-year-old assumption — that compat-mode entry sizes would always sum to no more than the native allocation — turned out to be false for certain target types.

### Resolution

[`b29c457a6511`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b29c457a6511435960115c0f548c4360d5f4801d) ("netfilter: x_tables: fix compat match/target pad out-of-bound write") removes the per-entry padding `memset()` entirely and instead **zeroes the whole destination buffer up front**, before any entries are translated into it:

```c
newinfo = xt_alloc_table_info(size);
memset(newinfo->entries, 0, size);   /* added to translate_compat_table() in ip_tables.c, ip6_tables.c, arp_tables.c */
```

This sidesteps the bounds-tracking problem completely — there's no longer a separate, per-entry write that can land outside the buffer, because every byte of the buffer is already zero before any entry-specific data is copied in. The fix was merged upstream in April 2021 and backported across stable kernels.

The patch drew no pushback on netfilter-devel — Pablo Neira Ayuso applied Westphal's post within a week, replying simply "Applied."

```bash
# Compat netfilter is only reachable via 32-bit setsockopt() paths;
# CONFIG_NETFILTER_XTABLES and user namespace availability are the relevant knobs
sysctl kernel.unprivileged_userns_clone   # if present (some distros), 0 blocks the CAP_NET_ADMIN-via-userns path
```

### What it taught us

**A per-item bounds check is not a buffer bounds check.** Each `memset()` call was individually correct relative to the entry it was processing; the bug was in the aggregate, which no single call site could see.

**"Zero everything up front" beats "zero exactly what's needed, exactly where it's needed."** The fix traded a precise, per-entry computation for a coarser but provably-safe whole-buffer zero — a good general instinct when the precise version requires reasoning about interactions between many call sites.

**A tiny primitive plus a determined exploit writer equals full compromise.** Four zero bytes, written out of bounds, were enough to build a complete kernel-code-execution chain — severity assessments based on "how many bytes" rather than "what can be reached from here" undersell bugs like this one.

!!! warning "Pattern to watch for"
    User-namespace-reachable `CAP_NET_ADMIN`/`CAP_NET_RAW` code paths deserve extra scrutiny — capabilities that once implied "trusted root-equivalent caller" now routinely apply to unprivileged users inside containers. If `kernel.unprivileged_userns_clone` (or your distro's equivalent knob) is enabled, any bug in a `CAP_NET_ADMIN`-gated path is a potential container-escape primitive, not just a local bug.

---

## Case 5: AF_PACKET TPACKET_V3 privilege escalation — CVE-2017-7308

### Before state

`AF_PACKET` sockets (used by `tcpdump`, Wireshark, and any raw-capture tool) can be configured with a memory-mapped ring buffer via `PACKET_RX_RING`/`PACKET_TX_RING`, avoiding a copy per captured packet. `packet_set_ring()` in `net/packet/af_packet.c` validates the requested ring geometry — block size, number of blocks, frame size — before allocating and mapping the ring. For the `TPACKET_V3` ring format, each block reserves space for a small private header (`tp_sizeof_priv`) in addition to packet frames, computed via the `BLK_PLUS_PRIV()` macro.

The sanity check guarding this computation looked like:

```c
if (po->tp_version >= TPACKET_V3 &&
    (int)(req->tp_block_size - BLK_PLUS_PRIV(req_u->req3.tp_sizeof_priv)) <= 0)
        goto out;
```

### The trigger

Both `tp_block_size` and the result of `BLK_PLUS_PRIV()` are unsigned. Casting their subtraction to `(int)` before comparing to zero is unsafe: Project Zero's Andrey Konovalov found that by supplying a `tp_sizeof_priv` value with its high bit set, the unsigned subtraction wraps to a large value that, when reinterpreted as a signed `int`, appears positive — silently passing a check that was supposed to reject an oversized private-header request. This let `blk_sizeof_priv` end up set to an attacker-chosen value, corrupting the block layout computed in `init_prb_bdqc()` and `prb_open_block()` and, downstream of that, the `max_frame_len` calculation used in `__packet_lookup_frame_in_block()` — leaving the kernel's view of the ring's frame layout disagreeing with the actual size of the mapped blocks.

### Observed behavior

The mismatch between the computed frame layout and the real block boundaries let a caller drive a **heap out-of-bounds write** when the kernel populated ring-buffer frames — a local integer-signedness bug (CVSS 7.8, "HIGH") that Project Zero's [writeup](https://projectzero.google/2017/05/exploiting-linux-kernel-via-packet.html), "Exploiting the Linux kernel via packet sockets," turned into a working local root exploit. Creating an `AF_PACKET` socket at all requires `CAP_NET_RAW` — ordinarily a meaningful barrier, but, as the writeup notes, one "which can be acquired by an unprivileged user inside a user namespaces" on any system where `CONFIG_USER_NS=y` and unprivileged user namespace creation is allowed, a common default on Ubuntu at the time (the writeup explicitly notes Android disallows untrusted code from creating `AF_PACKET` sockets at all).

### Why it happened

A single unsigned-to-signed cast, applied to a subtraction of two attacker-influenced unsigned values, was enough to defeat a bounds check. The check's author reasoned about the comparison as if it were happening in a signed domain where "negative or zero" cleanly meant "too small," without accounting for how a large unsigned wraparound would be reinterpreted once cast to `int`.

### Resolution

[`2b6867c2ce76`](https://github.com/torvalds/linux/commit/2b6867c2ce76c596676bec7d2d525af525fdc6e2) ("net/packet: fix overflow in check for priv area size"), authored by Andrey Konovalov, drops the signed cast and instead casts `tp_sizeof_priv` to `u64` before the comparison — comparing both sides in a wide-enough, correctly-signed domain that wraparound can no longer occur:

```c
if (po->tp_version >= TPACKET_V3 &&
    req->tp_block_size <=
          BLK_PLUS_PRIV((u64)req_u->req3.tp_sizeof_priv))
        goto out;
```

The fix landed in mainline in March 2017 and was backported to stable kernels; distributions shipped it in their 4.10.x and earlier stable branches shortly after.

Konovalov originally posted this fix as part of a five-patch series addressing multiple overflow and signedness issues across the AF_PACKET ring-buffer code. Willem de Bruijn, reviewing on netdev, pushed back on the scope: "These are a lot of changes to backport to stable kernels. Can we separate the minimal patch set needed to address known overflow to send to net... and follow up with the larger cleanup to net-next." Konovalov agreed and split two of the five patches — the `tp_frame_size` checks and a reordering cleanup — out into a separate net-next series, leaving this fix and two related overflow fixes as the minimal `net` submission that actually needed to reach stable.

### What it taught us

**Signed/unsigned casts around a subtraction are a recurring bug class.** "Cast the difference of two unsigned values to `int` and check the sign" is a pattern that looks correct and reads naturally, but only actually works if the difference can never wrap — a property that has to be proven, not assumed, whenever either operand is attacker-influenced.

**A capability check is only as strong as its reachability.** `CAP_NET_RAW` was a real, meaningful gate in a world without unprivileged user namespaces; once unprivileged namespace creation became common, the same capability check stopped meaning "trusted caller."

**Ring-buffer geometry bugs are size-mismatch bugs by nature.** Any code that separately validates a size and later relies on that size to compute offsets is vulnerable to exactly this class of bug if the validation and the later use don't agree bit-for-bit on the arithmetic domain (signed vs. unsigned, width).

!!! warning "Pattern to watch for"
    Grep for `(int)` casts wrapping subtraction of two `unsigned`/`size_t`/`u32`/`u64` values anywhere a bounds check follows — this exact shape (`(int)(a - b) <= 0`) is what caused CVE-2017-7308 and recurs across the kernel. Also worth checking: `sysctl kernel.unprivileged_userns_clone` (or your distro's equivalent) — if unprivileged namespace creation is enabled, treat every `CAP_NET_RAW`/`CAP_NET_ADMIN`-gated local bug as remotely reachable from container workloads.

---

## Case 6: UDP fragmentation-offload path-switch corruption — CVE-2017-1000112

### Before state

UDP datagrams larger than the path MTU can be built up incrementally with `MSG_MORE`, appending data across multiple `send()` calls before the kernel actually transmits. Depending on whether the underlying NIC advertises UFO (`NETIF_F_UFO`, a scatter-gather segmentation offload for UDP), `__ip_append_data()` in `net/ipv4/ip_output.c` (and its IPv6 counterpart `__ip6_append_data()` in `net/ipv6/ip6_output.c`) chooses one of two paths for building the outgoing SKB(s): the UFO path via `ip_ufo_append_data()`, which builds a single GSO SKB with the fragmentation deferred to the NIC/software GSO, or the plain fragmentation path, which splits the data into MTU-sized SKBs itself, computing a `copy` length for each fragment as it goes.

### The trigger

The decision of which path to use was re-evaluated on **every** `send()` call in a `MSG_MORE` sequence, based on current conditions, rather than being fixed for the lifetime of the datagram being built. Andrey Konovalov, using syzkaller, found that between two `send()` calls on the same socket building the same oversized datagram, the append path could **switch from UFO to non-UFO** mid-datagram. When the non-UFO path then continued appending onto an SKB that had already grown past the MTU under the UFO path's rules, its `copy = maxfraglen - skb->len` computation could go negative, triggering the fragmentation branch, which computed `fraggap = skb_prev->len - maxfraglen` — itself capable of exceeding the MTU — and from there `copy = datalen - transhdrlen - fraggap` could also go negative.

### Observed behavior

A negative `copy` length fed directly into `skb_copy_and_csum_bits()`, which performs an **out-of-bounds write** using that length as a copy size. The NVD entry (CVE-2017-1000112, CVSS 7.0 "HIGH") describes the same defect present in the IPv6 code path. The bug was traced back to the original UFO scatter-gather implementation, commit `e89e9cf539a2` ("[IPv4/IPv6]: UFO Scatter-gather approach") from October 2005 — meaning it had existed for roughly twelve years before syzkaller found it.

### Why it happened

The bug is a **state-consistency bug across a multi-call API**: `sendmsg(MSG_MORE)` sequences are meant to build one logical datagram across several calls, but the UFO-vs-fragmentation decision was a per-call heuristic rather than a per-datagram invariant. Once the first `send()` call had committed an SKB to the "GSO, defer to UFO" shape, a later `send()` call in the same sequence was still free to decide independently that non-UFO fragmentation applied — even though the SKB it was appending to was already built under different assumptions.

### Resolution

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

### What it taught us

**Multi-call APIs need invariants that survive across calls, not just per-call correctness.** Each individual `send(MSG_MORE)` call's path-selection logic was locally reasonable; the bug only existed in the transition between two calls that each made a locally-correct but mutually inconsistent decision.

**A twelve-year-old code path is not a validated code path — it's an unfuzzed one.** UFO's scatter-gather logic from 2005 had simply never been exercised by the specific interleaving syzkaller found; age is not evidence of correctness for combinatorially rare input sequences.

**syzkaller-class fuzzing finds exactly this shape of bug.** State-machine inconsistencies triggered by an unusual sequence of syscalls (here, two `send()` calls with specific size/MTU relationships) are precisely what coverage-guided kernel fuzzing is good at surfacing, and are hard to find by code review alone.

!!! warning "Pattern to watch for"
    Any code path where a per-call heuristic decision (buffer strategy, offload path, algorithm choice) can vary across a sequence of calls building one logical object is a candidate for this bug class. If your workload uses `MSG_MORE` with UDP sockets near or above MTU size, make sure you're on a kernel that includes `85f1bd9a7b5a` (August 2017 or later stable).

---

## Common threads

| Pattern | SACK panic | SegmentSmack | Challenge-ACK | Netfilter x_tables | AF_PACKET | UFO path-switch |
|---------|:----------:|:-------------:|:--------------:|:-------------------:|:----------:|:-----------------:|
| Remotely triggerable, no local access needed | Yes | Yes | Yes | No | No | No |
| Root cause is an integer/width assumption | Yes | No | No | No | Yes | Yes |
| Found via fuzzing (syzkaller) or automated tooling | No | No | No | Partial | No | Yes |
| Capability check defeated by user namespaces | No | No | No | Yes | Yes | No |
| Fix added an explicit cap/invariant, not just a patch to one call site | Yes | Yes | Yes | Yes | Yes | Yes |

Half of these cases are reachable by an attacker who has never authenticated to anything — they only need to be able to route packets to the target, which is the defining characteristic of network-stack bugs as a category. The other half (Netfilter x_tables, AF_PACKET, and the UDP UFO bug) require local execution, but all three are gated only by capabilities (`CAP_NET_ADMIN`, `CAP_NET_RAW`, or an ordinary `sendmsg()` sequence) that are either trivially available or handed out routinely by unprivileged user namespaces — which is why the first two ended up cited as container-escape primitives rather than filed away as low-severity local bugs.

The other recurring shape is **an assumption that held for years until an adversary specifically targeted it**: a 16-bit segment counter, a per-second reset boundary, a per-entry padding write, a signed cast, a per-call path decision — each was locally reasonable and had shipped for anywhere from months (SegmentSmack) to fifteen years (Netfilter x_tables) before someone deliberately constructed the input that broke the assumption. Fuzzing (syzkaller, in the UFO case) and dedicated security research (Netflix, Project Zero, academic researchers) each found different corners of this space; neither alone would have caught all six.

---

## See also

- [TCP Implementation](tcp.md) — SACK, the retransmit queue, and the receive path involved in Cases 1–3
- [TCP Congestion Control](tcp-congestion.md) — how MSS and segment sizing interact with the send path
- [Netfilter Architecture](netfilter.md) — x_tables, hooks, and the compat translation layer behind Case 4
- [AF_PACKET Raw Sockets](packet-socket.md) — the ring-buffer mechanics behind Case 5
- [UDP Socket Internals](udp.md) — the send path and UFO/segmentation behavior behind Case 6
- [Network Namespaces](net-namespaces.md) — how unprivileged user+network namespaces expose `CAP_NET_ADMIN`/`CAP_NET_RAW` gated code paths
- [Why Is the Network Stack So Complex?](network-stack-overview.md) — the broader architectural context these bugs sit within

## External references

- [NVD: CVE-2019-11477](https://nvd.nist.gov/vuln/detail/CVE-2019-11477), [CVE-2019-11478](https://nvd.nist.gov/vuln/detail/CVE-2019-11478), [CVE-2019-11479](https://nvd.nist.gov/vuln/detail/CVE-2019-11479) — the TCP SACK panic CVE records
- [git.kernel.org: 3b4929f65b0d](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=3b4929f65b0d8249f19a50245cd88ed1a2f78cff) — "tcp: limit payload size of sacked skbs"
- [git.kernel.org: f070ef2ac667](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=f070ef2ac66716357066b683fb0baf55f8191a2e) — "tcp: tcp_fragment() should apply sane memory limits"
- [git.kernel.org: 967c05aee439](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=967c05aee439e6e5d7d805e195b3a20ef5c433d6) and [5f3e2bf008c2](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=5f3e2bf008c2221478101ee72f5cb4654b9fc363) — "tcp: enforce tcp_min_snd_mss in tcp_mtu_probing()" and the sysctl that backs it
- [LWN: The TCP SACK panic](https://lwn.net/Articles/791409/) — Jake Edge's coverage of CVE-2019-11477/78/79
- [lore.kernel.org: tcp: make sack processing more robust](https://lore.kernel.org/netdev/20190617170354.37770-1-edumazet@google.com/) — the netdev disclosure thread, including Christoph Paasch's regression report against the CVE-2019-11478 fix and Eric Dumazet's follow-up guard
- [NVD: CVE-2018-5390](https://nvd.nist.gov/vuln/detail/CVE-2018-5390) — SegmentSmack CVE record
- [git.kernel.org: 1a4f14bab186](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=1a4f14bab1868b443f0dd3c55b689a478f82e72e) — "Merge branch 'tcp-robust-ooo'", the SegmentSmack fix series
- [lore.kernel.org: tcp: more robust ooo handling](https://lore.kernel.org/netdev/20180723162821.11556-1-edumazet@google.com/) — the netdev submission thread, including David Miller's merge reply and the follow-up about the missing 4.9-stable backport
- [LWN: CVE-2018-5390 and "embargoes"](https://lwn.net/Articles/762512/) — Jake Edge's coverage of the SegmentSmack disclosure
- [NVD: CVE-2016-5696](https://nvd.nist.gov/vuln/detail/CVE-2016-5696) — TCP challenge-ACK side channel CVE record
- [git.kernel.org: 75ff39ccc1bd](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=75ff39ccc1bd5d3c455b6822ab09e533c551f758) — "tcp: make challenge acks less predictable"
- [lore.kernel.org: tcp: make challenge acks less predictable (v2)](https://lore.kernel.org/netdev/1468137842.30694.58.camel@edumazet-glaptop3.roam.corp.google.com/) — the netdev thread with reporter Yue Cao, showing the v1-to-v2 iteration and Dumazet's rationale for accepting a residual side channel
- [LWN: The TCP "challenge ACK" side channel](https://lwn.net/Articles/696868/) — Jake Edge's coverage, including the USENIX Security 2016 paper details
- [NVD: CVE-2021-22555](https://nvd.nist.gov/vuln/detail/CVE-2021-22555) — Netfilter x_tables heap overflow CVE record
- [git.kernel.org: b29c457a6511](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b29c457a6511435960115c0f548c4360d5f4801d) — "netfilter: x_tables: fix compat match/target pad out-of-bound write"
- [lore.kernel.org: netfilter: x_tables: fix compat match/target pad out-of-bound write](https://lore.kernel.org/netfilter-devel/20210407193857.21120-1-fw@strlen.de/) — Florian Westphal's patch as posted to netfilter-devel
- [Andy Nguyen: CVE-2021-22555: Turning \x00\x00 into 10000$](https://google.github.io/security-research/pocs/linux/cve-2021-22555/writeup.html) — the primary-source exploit writeup, including the kCTF container-escape use
- [LWN: CVE-2021-22555: Turning \x00\x00 into 10000$](https://lwn.net/Articles/862955/) — LWN's brief on Nguyen's writeup
- [NVD: CVE-2017-7308](https://nvd.nist.gov/vuln/detail/CVE-2017-7308) — AF_PACKET TPACKET_V3 CVE record
- [GitHub mirror: 2b6867c2ce76](https://github.com/torvalds/linux/commit/2b6867c2ce76c596676bec7d2d525af525fdc6e2) — "net/packet: fix overflow in check for priv area size"
- [lore.kernel.org: net/packet: fix multiple overflow issues in ring buffers](https://lore.kernel.org/netdev/cover.1490709552.git.andreyknvl@google.com/) — the cover-letter thread showing Willem de Bruijn's request to split the minimal overflow fix from the broader ring-buffer cleanup
- [Project Zero: Exploiting the Linux kernel via packet sockets](https://projectzero.google/2017/05/exploiting-linux-kernel-via-packet.html) — Andrey Konovalov's writeup of CVE-2017-7308
- [NVD: CVE-2017-1000112](https://nvd.nist.gov/vuln/detail/CVE-2017-1000112) — UDP UFO path-switch CVE record
- [GitHub mirror: 85f1bd9a7b5a](https://github.com/torvalds/linux/commit/85f1bd9a7b5a79d5baa8bf44af19658f7bf77bfa) — "udp: consistently apply ufo or fragmentation"
- [lore.kernel.org: udp: consistently apply ufo or fragmentation](https://lore.kernel.org/netdev/20170810162919.50577-1-willemdebruijn.kernel@gmail.com/) — the netdev thread, including David Miller's same-day merge and a follow-up correctness question from Vasily Averin
