# The TCP Challenge-ACK Side Channel

> CVE-2016-5696 — a global rate-limit counter meant as an internal implementation detail became an off-path attacker's window into a victim's TCP connections

**Disclosed:** August 2016 &nbsp;·&nbsp; **Reported by:** Yue Cao, Zhiyun Qian, et al. (UC Riverside, with Lisa Marvel, US Army Research Laboratory) &nbsp;·&nbsp; **CVSS:** 4.8 MEDIUM &nbsp;·&nbsp; **Fixed in:** mainline 4.7 &nbsp;·&nbsp; **Exploit tool:** yes ([`mountain_goat`](https://github.com/Gnoxter/mountain_goat) PoC) &nbsp;·&nbsp; **Actively exploited:** no confirmed cases (not on CISA KEV)

*Part of [War Stories: Network Stack Bugs and CVEs](../war-stories.md).*

## Before state

RFC 5961 hardens TCP against blind in-window packet injection: instead of silently accepting or resetting a connection when a spoofed SYN or RST with an in-window (but not exactly-right) sequence number arrives, the receiver sends a **challenge ACK** — carrying the *exact* next-expected sequence number — and waits for the real peer to either confirm or ignore it. This forces an off-path attacker (one who can't see the traffic) to guess the exact sequence number, not just land within the receive window, which is a much harder problem.

Because challenge ACKs consume resources and RFC 5961 expected them to be rare, Linux rate-limited them with a single **global counter**, `challenge_count`, reset once per second and capped by `sysctl_tcp_challenge_ack_limit` (default 100/second), in `tcp_send_challenge_ack()` in `net/ipv4/tcp_input.c`.

## The trigger

Yue Cao and colleagues at UC Riverside (with Lisa Marvel from the US Army Research Laboratory) found that the shared, global nature of that counter turned it into a **side channel**. An off-path attacker can:

1. Send a burst of spoofed RST/SYN packets designed to provoke the maximum number of challenge ACKs against a victim connection they're trying to identify or hijack.
2. Simultaneously send probe traffic on their own, legitimate connection to the same server.
3. Count how many challenge ACKs *their own* connection received back. If the count is short of the expected maximum, some of the global quota was consumed by challenge ACKs sent to the victim — meaning the attacker's spoofed guess landed in-window (or matched a live connection at all).

By repeating this with different guesses, the attacker narrows in on whether a given four-tuple represents a live connection, and eventually on the in-window sequence number — all **without ever seeing a single packet of the real conversation**.

## Observed behavior

LWN's coverage (["The TCP 'challenge ACK' side channel", August 2016](https://lwn.net/Articles/696868/)) summarized the paper's results: "it takes only 10 seconds to successfully infer whether they are communicating. If there is a connection, subsequently, it takes also only tens of seconds to infer the TCP sequence numbers."

The researchers demonstrated both blind connection reset (against SSH and Tor connections) and, more seriously, blind data injection into long-lived connections such as video streams — including injecting attacker-controlled JavaScript into an unencrypted web session. The paper was presented at USENIX Security 2016.

The technique didn't stay confined to the paper: a standalone proof-of-concept tool, [`mountain_goat`](https://github.com/Gnoxter/mountain_goat), was published separately implementing the off-path inference attack. As with the other locally-weaponized bugs on this page, there's no public record of it being caught in active exploitation against real targets — no CISA KEV listing, no confirmed incident report — but the side channel was demonstrably practical to exploit, not just theoretically real.

Because Linux was, at the time, the only major OS to faithfully implement RFC 5961's challenge-ACK behavior, it was also the only one vulnerable to this specific side channel.

## Why it happened

The root cause is a classic shared-resource side channel: a single global counter meant to be an internal implementation detail (a rate limit) became an externally observable signal once an attacker could both *consume* the shared quota and *measure* its depletion from a different vantage point. RFC 5961 itself recommended the rate limit but didn't anticipate that the limit's exact, predictable, low value (100/second) combined with a hard reset boundary (once per second) would make the counter cheap to exhaust and easy to observe.

## Resolution

[`75ff39ccc1bd`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=75ff39ccc1bd5d3c455b6822ab09e533c551f758) ("tcp: make challenge acks less predictable"), based on analysis from Linus Torvalds, made two changes: it raised the default limit from 100 to 1000 challenge ACKs/second (`sysctl_tcp_challenge_ack_limit`), and it **randomized** how the per-second quota is consumed. Rather than counting up from zero and comparing to a fixed limit, it initializes `challenge_count` each second to a random value between half and one-and-a-half times the limit, and counts *down*, so an attacker can no longer cheaply determine how much quota remains:

```c
u32 half = (sysctl_tcp_challenge_ack_limit + 1) >> 1;
challenge_timestamp = now;
WRITE_ONCE(challenge_count, half + prandom_u32_max(sysctl_tcp_challenge_ack_limit));
```

The fix landed in mainline for 4.7. Existing per-socket rate limiting (`tcp_oow_rate_limited()`) was left in place; Jason Baron (Akamai) followed up two days later with [`083ae308280d`](https://github.com/torvalds/linux/commit/083ae308280d013363a2d33e4b0002a4edfef97) ("tcp: enable per-socket rate limiting of all 'challenge acks'"), explicitly [framed as a step toward eventually removing the global limit](https://lore.kernel.org/netdev/1468510720-322-1-git-send-email-jbaron@akamai.com/) altogether, "as Eric Dumazet has suggested." Operators on kernels without the fix had a documented interim mitigation: raise `net.ipv4.tcp_challenge_ack_limit` to a very large value (e.g. `999999999`) to make the counter effectively unlimited and therefore uninformative to an attacker.

The fix went through a real back-and-forth with Yue Cao on netdev before landing. Dumazet's [first posting](https://lore.kernel.org/netdev/1467995586.30694.34.camel@edumazet-glaptop3.roam.corp.google.com/) only randomized the per-second *reset boundary* (a window between 0.5s and 1.5s); Cao replied that his attack could adapt by sending a short burst reliably contained within one window and repeating the guess to resolve edge cases — which is what prompted the ["v2" patch](https://lore.kernel.org/netdev/1468137842.30694.58.camel@edumazet-glaptop3.roam.corp.google.com/) that randomizes the *count* instead, the version that shipped.

Cao then described a further refinement of his attack against v2 (sending well over 1,000 probes and using the number of returned challenge ACKs to infer a correct guess) and asked whether the global limit should simply be removed, noting that neither FreeBSD nor Windows enforced one. Dumazet's reply explained why the kernel kept it anyway: the limit exists to blunt the "ACK storms" caused by "buggy firewalls and appliances" that plagued servers before rate limiting was added in 3.6. He judged the residual side channel a "small nuisance" by comparison, and pointed out that establishing the roughly 500 connections the refined attack needs is itself hard to do quietly against a real server — with session-hijacking risk better addressed by TLS than by closing every last bit of the timing channel.

## What it taught us

**A rate limiter is also a covert channel.** Any shared counter that an attacker can both perturb and observe — even indirectly, even without reading any protected data — can leak information about state the attacker shouldn't be able to infer.

**Predictable resets amplify side channels.** A fixed per-second reset boundary meant the attacker could synchronize probes to the counter's lifecycle, turning a noisy signal into a reliable one.

**Being the only compliant implementation can mean being the only exposed one.** Linux's correctness in implementing RFC 5961 faithfully is what created the side channel — other stacks that hadn't implemented the RFC's rate limiting simply didn't have this particular counter to attack.

!!! warning "Pattern to watch for"
    Any globally-shared, attacker-perturbable counter gating a security-relevant response (challenge ACKs, error responses, retry limits) is a potential side channel if its state can be inferred by a party who didn't directly cause the perturbation. Check `sysctl net.ipv4.tcp_challenge_ack_limit` — it should be at least the post-fix default of 1000, and kernels older than 4.7 should be treated as exposed.

## See also

- [TCP Implementation](../tcp.md) — sequence number tracking and the challenge-ACK path
- [The TCP SACK Panic](sack-panic.md) and [SegmentSmack](segmentsmack.md) — two other TCP-layer war stories from the same era

## External references

- [NVD: CVE-2016-5696](https://nvd.nist.gov/vuln/detail/CVE-2016-5696) — TCP challenge-ACK side channel CVE record
- [git.kernel.org: 75ff39ccc1bd](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=75ff39ccc1bd5d3c455b6822ab09e533c551f758) — "tcp: make challenge acks less predictable"
- [lore.kernel.org: tcp: make challenge acks less predictable (v1)](https://lore.kernel.org/netdev/1467995586.30694.34.camel@edumazet-glaptop3.roam.corp.google.com/) and [(v2)](https://lore.kernel.org/netdev/1468137842.30694.58.camel@edumazet-glaptop3.roam.corp.google.com/) — the netdev thread with reporter Yue Cao, showing the v1-to-v2 iteration and Dumazet's rationale for accepting a residual side channel
- [lore.kernel.org: tcp: enable per-socket rate limiting of all "challenge acks"](https://lore.kernel.org/netdev/1468510720-322-1-git-send-email-jbaron@akamai.com/) — Jason Baron's explicit follow-up toward removing the global limit
- [LWN: The TCP "challenge ACK" side channel](https://lwn.net/Articles/696868/) — Jake Edge's coverage, including the USENIX Security 2016 paper details
- [Gnoxter/mountain_goat](https://github.com/Gnoxter/mountain_goat) — a published proof-of-concept exploit implementing the off-path inference attack
