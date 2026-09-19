# The net/sched act_api Filter-Delete Race

> CVE-2026-53264 — a 2017 comment's reasoning about RCU safety covered one path readers could reach an action object through, but not the other one; nine years later, an AI-accelerated exploit write-up turned the gap into root

Disclosed
:   Fix merged June 2026; public exploit write-up July 27, 2026 (STAR Labs)

Reported by
:   Kyle Zeng (OpenAI security research) and syzbot — original kernel bug report; Lee Jia Jie (STAR Labs, Singapore) — independent, post-fix exploit write-up

CVSS
:   7.8 HIGH (NVD) / 7.0 (Red Hat, vector `CVSS:3.1/AV:L/AC:H/PR:L/UI:N/S:U/C:H/I:H/A:H`)

Fixed in
:   mainline 7.1-rc7 (commit `5057e1aca011`); backported to stable 5.10.259, 5.15.210, 6.1.176, 6.6.143, 6.12.94, 6.18.36, 7.0.13

Exploit tool
:   yes — Lee Jia Jie's proof-of-concept, described and partly reproduced in a public STAR Labs write-up

Actively exploited
:   no confirmed cases (local-only; requires an existing unprivileged shell; not on CISA KEV as of this writing)

*Part of [War Stories: Network Stack Bugs and CVEs](../war-stories.md).*

## Before state

Linux [traffic control](../tc-qdisc.md) (`tc`) actions — the `gact`, `mirred`, and similar objects a filter runs when it matches a packet — are reference-counted `struct tc_action` objects, indexed per action-type in an IDR (`idr_find(idr, index)`) so that [netlink](../netlink.md) requests can look one up by its numeric index and either attach it to a new filter or delete it. Because the IDR is walked by lookups that only take `rcu_read_lock()`, not the mutex that protects *removing* entries from it, an action's memory has to stay valid for at least one RCU grace period after it's unlinked — otherwise a concurrent reader that found the pointer just before removal can dereference (or refcount) it just after the memory is freed.

That's exactly how it originally worked: `free_tcf()` deferred the actual `kfree()` with `call_rcu(&p->tcfa_rcu, free_tcf)`. In September 2017, Cong Wang's commit [`d7fb60b9cafb`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d7fb60b9cafb982cb2e46a267646a8dfd4f2e5da) ("net_sched: get rid of tcfa_rcu") removed that deferral in favor of an immediate `kfree(p)`, with a comment explaining why it should be safe: gen_estimator's rewrite meant that particular caller no longer needed to wait for a grace period, and — the load-bearing claim — *"for standalone actions, we don't need a RCU grace period either, because actions are always connected to filters and filters are already destroyed in RCU callbacks, so after a RCU grace period actions are already disconnected from filters. Readers later can not find us."* That argument is about one specific reader path: someone reaching an action *through a filter*. It says nothing about a reader reaching the same action *directly through the IDR* — which is exactly what a concurrent `NEWTFILTER` lookup does.

## The trigger

The fix commit's own description lays out the race with CPU0 running `RTM_NEWTFILTER` and CPU1 running `RTM_DELTFILTER` concurrently against the same action index:

```
0: mutex_lock()                              <-- holds the idr lock
0: rcu_read_lock()
0: p = idr_find(idr, index)                  <-- action p is valid (RCU protects IDR)
0: mutex_unlock()                            <-- releases the idr lock
1: refcount_dec_and_mutex_lock()             <-- refcnt 1->0, mutex held
1: idr_remove(idr, index)                    <-- action removed from IDR
1: mutex_unlock()                            <-- mutex released
1: tcf_action_cleanup(p); kfree(p)           <-- kfree's p immediately, no deferral
0: refcount_inc_not_zero(&p->tcfa_refcnt)    <-- UAF: p points to freed memory
```

CPU0 finds `p` under RCU protection and releases the IDR mutex before it gets around to bumping the refcount — a perfectly ordinary sequence, since nothing says the refcount increment has to happen while still holding that mutex. If CPU1's delete path runs in the gap and frees `p` immediately (as the 2017 change made it do), CPU0's subsequent `refcount_inc_not_zero()` touches memory that's already back in the slab allocator's hands.

## Observed behavior

Two distinct threads of research surfaced this bug, months apart.

**The original report.** Kyle Zeng, a security researcher at OpenAI, and syzbot's fuzzing both hit the race and are credited in the fix commit's `Reported-by`/`Tested-by` tags. Jakub Kicinski, who maintains this area, suggested the fix approach; Jamal Hadi Salim implemented it — explicitly, in his own commit message, as a revert of the 2017 change plus a modernization to `kfree_rcu()`.

**The exploit write-up.** On July 27, 2026 — roughly two months after the fix landed — Singapore-based offensive-security firm STAR Labs published a technical write-up by researcher Lee Jia Jie, framed explicitly as a study of whether AI tooling changes how fast a *disclosed, already-patched* bug ("when AI makes 0-days feel like n-days," in the post's own title) can be turned into a working exploit. Lee's own description of the vulnerability, independent confirmation of the same root cause: *"The vulnerability is a lock-mismatch: `tcf_idr_check_alloc()` accesses the action idr with only `rcu_read_lock()`, while actions are freed with `idrinfo->lock` and `rtnl_lock()` held, but without waiting for the RCU grace period."*

Lee described using AI for three specific tasks — bug discovery (working backward from the patch diff), producing a KASAN proof-of-concept, and refining the race-window-widening technique — with a concrete before/after: naive attempts to hit the race took over 15 minutes; after AI-assisted refinement using `timerfd`/`epoll` to widen the window, it dropped to roughly 5 seconds on average across 10 runs on a CentOS Stream 9 desktop (an Intel i5 laptop CPU), with per-run times of 10, 10, 9, 11, 11, 111, 64, 69, 47, and 10 seconds. The full chain went well past triggering the UAF: reclaiming the freed `tc_action` memory with an attacker-controlled `user_key_payload` object to hijack a function pointer, a stack pivot from a controlled heap buffer, and a kernel-version-specific ROP chain that overwrites `core_pattern` to gain root execution through the core-dump handler — a working local-root exploit, not just a crash. It requires unprivileged user namespaces (enabled by default on most distributions), the `CONFIG_NET_ACT_GACT` and `CONFIG_NET_CLS_FLOWER` kernel options, and hardcoded per-kernel-version offsets in the ROP chain, so it's a local privilege-escalation primitive, not something portable or remotely triggerable as published. Lee was explicit about the limits of AI's contribution, quoted across multiple outlets covering the write-up: *"AI still has many blind spots and lapses in reasoning ability,"* and *"human judgement remained necessary throughout the work."*

## Why it happened

The root cause is a locking/RCU mismatch that was the *product* of a reasoning gap, not sloppiness: the 2017 comment's claim — that a grace period elsewhere already guarantees readers can't find a freed action — was true for the one reader path it was written about (reaching an action by walking a filter's attached actions) and simply didn't consider the other path that reaches the same object: a direct `idr_find()` on the action index itself, independent of any filter. An RCU-safety argument scoped to "the readers I have in mind" doesn't automatically cover every reader that exists; it held, unnoticed, for nine years until a fuzzer and a security researcher specifically drove `NEWTFILTER` and `DELFILTER` against each other.

## Resolution

Commit [`5057e1aca011`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=5057e1aca011e51ef51498c940ef96f3d3e8a305) (Jamal Hadi Salim, May 31 2026) restores `struct rcu_head tcfa_rcu` to `struct tc_action` and changes `free_tcf()`'s `kfree(p)` back to a deferred `kfree_rcu(p, tcfa_rcu)` — explicitly framed in the commit message as a revert of 2017's `d7fb60b9cafb` combined with a modernization (the original used an explicit `call_rcu()` callback; the fix uses `kfree_rcu()` directly). With the free deferred, CPU0's `idr_find()` either finds a still-live object (and `refcount_inc_not_zero()` succeeds normally) or the object is already unlinked from the IDR and `idr_find()` correctly returns `NULL` — but the memory itself, even if a stale pointer to it exists somewhere, isn't actually released until the RCU grace period elapses, so there's no window left in which a refcount operation can touch freed memory. Suggested-by Jakub Kicinski; reviewed by Pedro Tammela, Eric Dumazet, and Victor Nogueira; tested by Kyle Zeng, syzbot, and Victor Nogueira.

This project independently confirmed the fix's placement in mainline: `net/sched/act_api.c` at the `v7.0` tag still has the unconditional `kfree(p)`, while current mainline has the restored `kfree_rcu(p, tcfa_rcu)` — consistent with public reporting that pins the mainline landing to `7.1-rc7`. The fix was also backported as a stable-tree patch (commit `98b2e40879ab`, carrying `[ Upstream commit 5057e1aca011... ]` and Sasha Levin's stable-tree sign-off) to LTS branches 5.10.259, 5.15.210, 6.1.176, 6.6.143, 6.12.94, 6.18.36, and 7.0.13.

## What it taught us

**An RCU-safety argument has to cover every reader path, not just the one under discussion.** The 2017 reasoning wasn't wrong about filter-chain traversal; it just never checked whether direct IDR lookup needed the same guarantee, and nobody revisited that question for nine years.

**A correctness comment is a claim that ages, silently, along with the code around it.** Nothing about the 2017 change looked unsafe in isolation — the bug is only visible if you already know to ask "what *other* ways can a reader reach this object" before removing a deferral that protects against exactly that.

**The same disclosed patch was two different stories months apart.** To almost everyone, this was a routine, one-paragraph stable-kernel security fix. To a researcher treating it as a case study, it became a demonstration that AI tooling can compress a race-condition exploit's development time dramatically — 15-plus minutes of blind racing down to about 5 seconds — on a bug whose root cause was already public. That's a fact about how fast a disclosed race condition can now be turned into a reliable local-root chain, not a claim that this particular bug was unusually AI-discoverable; Lee's own account describes AI accelerating specific mechanical steps under his direction, not independently finding or exploiting the flaw.

!!! warning "Pattern to watch for"
    Any refcounted object reachable through both an RCU-read-locked lookup (an IDR, a hash table, an RCU-protected list) and a mutex-protected removal path needs the *free itself* deferred with `call_rcu()`/`kfree_rcu()` — a lock around removal doesn't help a lookup that only ever took the RCU read lock. If a comment justifies skipping deferred freeing by saying "readers can only reach this through path X, and X is already safe," audit every other path that can reach the same object before trusting it — not just the one the comment's author had in mind.

## See also

- [Traffic Control and Queueing Disciplines](../tc-qdisc.md) — the `tc` filter/action architecture this bug lives in
- [Netlink Sockets](../netlink.md) — how `NEWTFILTER`/`DELFILTER` requests reach the kernel
- [Network Namespaces](../net-namespaces.md) — how unprivileged user+network namespaces expose the capabilities this exploit needs
- [AF_PACKET TPACKET_V3 Privilege Escalation](af-packet.md) — another local UAF-to-root chain on this page, for comparison

## External references

- [git.kernel.org: 5057e1aca011](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=5057e1aca011e51ef51498c940ef96f3d3e8a305) — "net/sched: act_api: use RCU with deferred freeing for action lifecycle"
- [git.kernel.org: d7fb60b9cafb](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d7fb60b9cafb982cb2e46a267646a8dfd4f2e5da) — "net_sched: get rid of tcfa_rcu", the 2017 change this fix reverts
- [STAR Labs: When AI Makes 0-Days Feel Like N-Days](https://starlabs.sg/blog/2026/07-when-ai-makes-0-days-feel-like-n-days/) — Lee Jia Jie's exploit write-up, including the AI-assisted race-window timing data
- [The Hacker News: Researcher Says AI Helped Develop Linux Traffic-Control Race Into Root Exploit](https://thehackernews.com/2026/07/researcher-says-ai-helped-develop-linux.html) — coverage confirming the fixed-version list and researcher quotes
- [Red Hat: CVE-2026-53264](https://access.redhat.com/security/cve/cve-2026-53264) — CVE description and Red Hat's own CVSS scoring
