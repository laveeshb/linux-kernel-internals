# The net/sched act_api Filter-Delete Race

> CVE-2026-53264 — a 2017 comment's reasoning about RCU safety covered one path readers could reach an action object through, but not the other one; nine years later, a researcher rediscovered the same bug independently as a fresh 0-day, with AI accelerating the exploit build

Disclosed
:   2026-06-25 (Linux kernel CNA record); independent 0-day exploit write-up published July 27, 2026 (STAR Labs)

Reported by
:   Kyle Zeng (OpenAI security research) — original kernel bug report, credited in the fix commit's `Reported-by` tag (syzbot is credited separately, as `Tested-by`); Lee Jia Jie (STAR Labs, Singapore) — independently found and exploited the same bug as a 0-day roughly two days later, unaware it had already been reported upstream

CVSS
:   7.8 HIGH (Linux kernel CNA, vector `CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`; adopted by NVD) / 7.0 (Red Hat's own scoring, vector `CVSS:3.1/AV:L/AC:H/PR:L/UI:N/S:U/C:H/I:H/A:H`)

Fixed in
:   mainline 7.1-rc7 (commit `5057e1aca011`, merged May 31, 2026); backported separately to stable 5.10.259, 5.15.210, 6.1.176, 6.6.143, 6.12.94, 6.18.36, and 7.0.13

Exploit tool
:   yes — full source published: [star-sg/CVE: CVE-2026-53264](https://github.com/star-sg/CVE/tree/master/CVE-2026-53264), Lee Jia Jie's TyphoonPwn 2026 submission, with a demo video and a detailed STAR Labs write-up

Actively exploited
:   no confirmed cases (local-only; requires an existing unprivileged shell; not on CISA KEV as of this writing)

*Part of [War Stories: Network Stack Bugs and CVEs](../war-stories.md).*

## Before state

Linux [traffic control](../tc-qdisc.md) (`tc`) actions — the `gact`, `mirred`, and similar objects a filter runs when it matches a packet — are reference-counted `struct tc_action` objects, indexed per action-type in an IDR (`idr_find(idr, index)`) so that [netlink](../netlink.md) requests can look one up by its numeric index and either attach it to a new filter or delete it. Because the IDR is walked by lookups that only take `rcu_read_lock()`, not the mutex that protects *removing* entries from it, an action's memory has to stay valid for at least one RCU grace period after it's unlinked — otherwise a concurrent reader that found the pointer just before removal can dereference (or refcount) it just after the memory is freed.

That's exactly how it originally worked: before 2017, `free_tcf()` *was* the RCU callback itself — `static void free_tcf(struct rcu_head *head)`, recovering the action pointer via `container_of()` — and it was its two callers, `tcf_idr_remove()` and `tcf_idr_cleanup()`, that deferred the free with `call_rcu(&p->tcfa_rcu, free_tcf)` rather than invoking it directly. In September 2017, Cong Wang's commit [`d7fb60b9cafb`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d7fb60b9cafb982cb2e46a267646a8dfd4f2e5da) ("net_sched: get rid of tcfa_rcu") removed that deferral: `free_tcf()` was changed to take the `tc_action *` directly and run immediately, with both callers now just calling `free_tcf(p)`.

The commit message gives two reasons. The narrow one is specific to a single caller: gen_estimator's rewrite meant `tcf_idr_remove()` no longer needed to wait for a grace period on that account. The other is a real constraint on a follow-up patch the commit was clearing the way for — Wang writes that removing the deferral *"also completely closes a race condition between action free path and filter chain add/remove path for the following patch. Because otherwise the nested RCU callback can't be caught by `rcu_barrier()`"* — a `call_rcu()` nested inside another RCU callback can outlive the `rcu_barrier()` a caller uses to wait out all pending callbacks, which the follow-up work needed to not happen. Alongside both of those, the rewritten `free_tcf()` carries a comment justifying why dropping the deferral should be safe on its own terms — the load-bearing claim for *this* bug: *"for standalone actions, we don't need a RCU grace period either, because actions are always connected to filters and filters are already destroyed in RCU callbacks, so after a RCU grace period actions are already disconnected from filters. Readers later can not find us."* That argument is about one specific reader path: someone reaching an action *through a filter*. It says nothing about a reader reaching the same action *directly through the IDR* — which is exactly what a concurrent `NEWTFILTER` lookup does.

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

Two researchers found the same bug independently, days apart, for unrelated reasons — one doing routine kernel security triage, the other hunting 0-days with AI assistance for a competition.

**The original report.** Kyle Zeng, a security researcher at OpenAI, reported the race upstream; syzbot's fuzzing independently hit it too. Both are credited in the fix commit — Zeng in its `Reported-by` tag, syzbot in `Tested-by` (Zeng also re-tested the finished fix, appearing a second time as `Tested-by`). Jakub Kicinski, who maintains this area, suggested the fix approach; Jamal Hadi Salim implemented it — explicitly, in his own commit message, as a revert of the 2017 change plus a modernization to `kfree_rcu()`. The fix merged May 31, 2026; the CVE was published June 25, 2026.

**The independent 0-day.** Lee Jia Jie, a researcher at STAR Labs (Singapore), was hunting kernel bugs with AI assistance for **TyphoonPwn 2026**, a Linux local-privilege-escalation competition held May 27–28, 2026 — before Zeng's report was public. Lee found the same race in `net/sched` on his own and built it into a working local-root exploit. He learned his queue position (8th of 11 entrants) the morning of the competition; by early afternoon, three winners had already been declared in the Linux LPE category, and he never got to demo it. A few days later he learned why someone had beaten him to it: *"someone told me that KyleBot had already reported the bug 2 days before TyphoonPwn."* His write-up, published July 27, 2026 and titled ["When AI Makes 0-Days Feel Like N-Days"](https://starlabs.sg/blog/2026/07-when-ai-makes-0-days-feel-like-n-days/), independently confirms the same root cause: *"The vulnerability is a lock-mismatch: `tcf_idr_check_alloc()` accesses the action idr with only `rcu_read_lock()`, while actions are freed with `idrinfo->lock` and `rtnl_lock()` held, but without waiting for the RCU grace period."*

Lee describes using AI for three tasks — finding the bug itself, producing a KASAN proof-of-concept, and refining a race-window-widening technique — with a concrete before/after on the last one: naive attempts to win the CPU0/CPU1 race took over 15 minutes; after AI-assisted refinement using `timerfd`/`epoll` to widen the window, a single race attempt dropped to around 5 seconds. That's a different measurement from how reliably the *finished* exploit runs end-to-end: in a separate 10-run benchmark of the complete chain (CentOS Stream 9 desktop, an Intel i5-1235U laptop), all 10 runs succeeded, taking 10, 10, 9, 11, 11, 111, 64, 69, 47, and 10 seconds — full-chain runtime, not race-trigger latency; Lee attributes the slower outliers to CPU thermal throttling.

The full chain went well past triggering the UAF: reclaiming the freed `tc_action` memory with an attacker-controlled `user_key_payload` object to hijack a function pointer, a stack pivot from a controlled heap buffer, and a kernel-version-specific ROP chain that overwrites `core_pattern` to gain root execution through the core-dump handler — a working local-root exploit, not just a crash. It requires unprivileged user namespaces (enabled by default on most distributions), the `CONFIG_NET_ACT_GACT` and `CONFIG_NET_CLS_FLOWER` kernel options, and hardcoded per-kernel-version offsets in the ROP chain, so it's a local privilege-escalation primitive, not something portable or remotely triggerable as published. Lee's own summary of AI's contribution is more modest than "found and built it for me": *"It was certainly helpful for iterating quickly, but still lacking in reasoning ability and having clear blind spots. It was still crucial to exercise my own judgement especially when fine-tuning."* His stated takeaway from the exercise was narrower than "AI finds 0-days" — that AI tooling made *hunting an unknown bug* start to feel, procedurally, like the easier problem of analyzing an already-known one: *"this made it feel more like I was doing n-day analysis even on new bugs."*

## Why it happened

The root cause is a locking/RCU mismatch that was the *product* of a reasoning gap, not sloppiness: the 2017 comment's claim — that a grace period elsewhere already guarantees readers can't find a freed action — was true for the one reader path it was written about (reaching an action by walking a filter's attached actions) and simply didn't consider the other path that reaches the same object: a direct `idr_find()` on the action index itself, independent of any filter. An RCU-safety argument scoped to "the readers I have in mind" doesn't automatically cover every reader that exists; it held, unnoticed, for nine years until a fuzzer and a security researcher specifically drove `NEWTFILTER` and `DELFILTER` against each other.

## Resolution

Commit [`5057e1aca011`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=5057e1aca011e51ef51498c940ef96f3d3e8a305) (Jamal Hadi Salim, May 31 2026) restores `struct rcu_head tcfa_rcu` to `struct tc_action` and changes `free_tcf()`'s `kfree(p)` back to a deferred `kfree_rcu(p, tcfa_rcu)` — explicitly framed in the commit message as a revert of 2017's `d7fb60b9cafb` combined with a modernization (the original used an explicit `call_rcu()` callback; the fix uses `kfree_rcu()` directly). With the free deferred, CPU0's `idr_find()` either finds a still-live object (and `refcount_inc_not_zero()` succeeds normally) or the object is already unlinked from the IDR and `idr_find()` correctly returns `NULL` — but the memory itself, even if a stale pointer to it exists somewhere, isn't actually released until the RCU grace period elapses, so there's no window left in which a refcount operation can touch freed memory. Suggested-by Jakub Kicinski; reviewed by Pedro Tammela, Eric Dumazet, and Victor Nogueira; tested by Kyle Zeng, syzbot, and Victor Nogueira.

This project independently confirmed the fix's placement in mainline: `net/sched/act_api.c` at the `v7.0` tag still has the unconditional `kfree(p)`, while current mainline has the restored `kfree_rcu(p, tcfa_rcu)` — consistent with public reporting that pins the mainline landing to `7.1-rc7`. The fix was backported separately to each affected LTS branch as seven distinct commits — `98b2e40879ab`, `18af5d2ef0c4`, `1f1b98fea6b9`, `8b136f18ac4b`, `5dd51e09020c`, `b60e9391142e`, and `91d105d2cbe0`, covering 5.10.259, 5.15.210, 6.1.176, 6.6.143, 6.12.94, 6.18.36, and 7.0.13 — each one carrying its own `[ Upstream commit 5057e1aca011... ]` tag; the `98b2e40879ab` backport's sign-off chain was confirmed directly and ends with Sasha Levin's stable-tree sign-off, as is standard for these backports.

## What it taught us

**An RCU-safety argument has to cover every reader path, not just the one under discussion.** The 2017 reasoning wasn't wrong about filter-chain traversal; it just never checked whether direct IDR lookup needed the same guarantee, and nobody revisited that question for nine years.

**A correctness comment is a claim that ages, silently, along with the code around it.** Nothing about the 2017 change looked unsafe in isolation — the bug is only visible if you already know to ask "what *other* ways can a reader reach this object" before removing a deferral that protects against exactly that.

**Two independent discoveries landed within days of each other, for unrelated reasons.** One was routine security triage (Zeng, syzbot); the other was a researcher using AI to hunt for competition bugs, unaware the same bug had just been reported (Lee). That's a coincidence of timing, not evidence this particular bug was unusually easy to find — but it's a reminder that once fuzzing and AI-assisted hunting both make searching a subsystem cheap enough to run casually, a bug that sat unfixed for nine years can still get rediscovered by two unrelated efforts within 48 hours of each other.

**AI made 0-day hunting feel, procedurally, like n-day analysis — in the researcher's own words, not this page's spin.** Lee's account doesn't claim AI found or exploited the bug autonomously: he credits it for iterating quickly on discovery, a proof-of-concept, and one specific timing refinement, while repeatedly stressing that his own judgment was still necessary to fine-tune the result. The narrower, still-notable claim is his own: for a researcher who already knows the subsystem, AI tooling can shrink the gap between "hunting for an unknown bug" and "exploiting one that's already disclosed" — which is what his write-up's title is actually about, and it's a different claim from "AI raced to exploit an already-patched bug," which is not what happened here.

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
- [STAR Labs: When AI Makes 0-Days Feel Like N-Days](https://starlabs.sg/blog/2026/07-when-ai-makes-0-days-feel-like-n-days/) — Lee Jia Jie's own account of finding and exploiting this bug as a 0-day, including the AI-assisted race-window timing data
- [star-sg/CVE: CVE-2026-53264](https://github.com/star-sg/CVE/tree/master/CVE-2026-53264) — Lee Jia Jie's full published exploit source
- [The Hacker News: Researcher Says AI Helped Develop Linux Traffic-Control Race Into Root Exploit](https://thehackernews.com/2026/07/researcher-says-ai-helped-develop-linux.html) — secondary coverage of the write-up
- [Red Hat: CVE-2026-53264](https://access.redhat.com/security/cve/cve-2026-53264) — CVE description and Red Hat's own CVSS scoring
