# Netfilter x_tables Heap Overflow

> CVE-2021-22555 — a 15-year-old bounds-check gap in the iptables compat layer, sitting unactioned in syzbot's inbox for 8 months, became "Turning \x00\x00 into 10000$" and a Kubernetes pod escape

**Disclosed:** July 2021 (fixed April 2021) &nbsp;·&nbsp; **Reported by:** syzbot (August 2020, unanswered) and Andy Nguyen, Google (April 2021) &nbsp;·&nbsp; **CVSS:** 8.3 HIGH (Google's CNA score) / 7.8 HIGH (NVD primary) &nbsp;·&nbsp; **Bug present since:** 2.6.19-rc1 (2006)

*Part of [War Stories: Network Stack Bugs and CVEs](../war-stories.md).*

## Before state

`iptables`/`ip6tables`/`arptables` rulesets are built by userspace and passed into the kernel via `setsockopt()`. On 64-bit kernels, 32-bit userspace tools (compat mode) submit rules in a **compat** layout that the kernel must translate into native 64-bit structures before use. This translation happens in `translate_compat_table()` (in each of `net/ipv4/netfilter/ip_tables.c`, `net/ipv6/netfilter/ip6_tables.c`, and `net/ipv4/netfilter/arp_tables.c`), which allocates a new buffer sized for the native layout and then calls `xt_compat_match_from_user()` / `xt_compat_target_from_user()` in `net/netfilter/x_tables.c` to copy and expand each match/target entry into it.

Native `xt_entry_match`/`xt_entry_target` structures are padded to an aligned size (`XT_ALIGN()`), but the compat versions the kernel receives from 32-bit userspace are not necessarily aligned the same way. The pre-fix code in `xt_compat_match_from_user()`/`xt_compat_target_from_user()` tried to zero just the padding gap for each individual entry:

```c
pad = XT_ALIGN(match->matchsize) - match->matchsize;
if (pad > 0)
    memset(m->data + match->matchsize, 0, pad);
```

## The trigger

This per-entry padding zero used an offset (`m->data + match->matchsize`) computed independently for each match/target, without re-checking it against the actual size of the destination buffer allocated for the *whole* translated ruleset. By choosing targets whose `matchsize`/`targetsize` isn't 8-byte aligned (Andy Nguyen's exploit writeup cites `NFLOG` as one such target, achievable via a controllable out-of-bounds offset reaching up to `0x4C` bytes past the buffer), a local process able to load such a compat ruleset could cause the `memset()` to write a small number of zero bytes **past the end of the allocated ruleset blob** — a heap out-of-bounds write.

Reaching this code path requires only being able to call `setsockopt(IPT_SO_SET_REPLACE)` (or the IPv6/ARP equivalents) from a 32-bit compat context, which requires `CAP_NET_ADMIN` — a capability routinely available to an unprivileged user inside a user *and* network namespace.

## Observed behavior

The bug had existed since **2.6.19-rc1** (2006) — roughly fifteen years — reachable via `net/netfilter/x_tables.c`. It was reported to the kernel by syzbot and independently by Andy Nguyen (Google).

Its severity came less from the bug itself (a write of a handful of zero bytes) than from what that primitive enabled. Andy Nguyen's public writeup, [`CVE-2021-22555: Turning \x00\x00 into 10000$`](https://google.github.io/security-research/pocs/linux/cve-2021-22555/writeup.html), demonstrates using the four-zero-byte out-of-bounds write to corrupt an in-flight `msg_msg` object via heap spraying, build a use-after-free, leak kernel heap and code addresses, hijack a `pipe_buffer`'s function-pointer table, and ultimately execute a ROP chain that calls `commit_creds()` and switches namespaces — turning a tiny OOB write into full kernel code execution. Nguyen used the exploit to escape a Kubernetes pod's isolation in Google's kCTF cluster, as covered by LWN (["CVE-2021-22555: Turning \x00\x00 into 10000$", July 2021](https://lwn.net/Articles/862955/)).

syzbot's report actually predates Nguyen's by nearly eight months. On 17 August 2020 syzbot [emailed a KASAN slab-out-of-bounds report](https://lore.kernel.org/all/00000000000022934305ad166be3@google.com/) titled "KASAN: slab-out-of-bounds Write in xt_compat_target_from_user" directly to `netdev@`, `netfilter-devel@`, the netfilter core team address, David Miller, and Florian Westphal, with a full crash trace pinpointing `net/netfilter/x_tables.c:1129` and a ready-to-run C reproducer. Nobody replied.

The [syzbot dashboard](https://syzkaller.appspot.com/bug?extid=cfc0247ac173f597aaaa) for that report shows zero human follow-up on the thread, and its own cause and fix bisections both failed — it sat as an open, unactioned bug until Westphal's April 2021 fix, prompted by Nguyen's independent, exploit-driven report through `security@kernel.org`, was manually linked to it: the shipped commit carries both `Reported-by: syzbot+cfc0247ac173f597aaaa@syzkaller.appspotmail.com` and `Reported-by: Andy Nguyen <theflow@google.com>`. The automated report had everything a maintainer would need to reproduce and fix the bug eight months earlier; what was missing wasn't detection but triage.

## Why it happened

The root cause is a **local, per-entry bounds check standing in for a missing global bounds check**: each match/target's padding write was "correct" in isolation (it wrote exactly `pad` bytes past that entry's data), but nothing validated that the cumulative effect of translating every entry in the ruleset stayed within the single buffer allocated up front. A fifteen-year-old assumption — that compat-mode entry sizes would always sum to no more than the native allocation — turned out to be false for certain target types.

## Resolution

[`b29c457a6511`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b29c457a6511435960115c0f548c4360d5f4801d) ("netfilter: x_tables: fix compat match/target pad out-of-bound write") removes the per-entry padding `memset()` entirely and instead **zeroes the whole destination buffer up front**, before any entries are translated into it:

```c
newinfo = xt_alloc_table_info(size);
memset(newinfo->entries, 0, size);   /* added to translate_compat_table() in ip_tables.c, ip6_tables.c, arp_tables.c */
```

This sidesteps the bounds-tracking problem completely — there's no longer a separate, per-entry write that can land outside the buffer, because every byte of the buffer is already zero before any entry-specific data is copied in. The fix was merged upstream in April 2021 and backported across stable kernels.

The [patch drew no pushback on netfilter-devel](https://lore.kernel.org/netfilter-devel/20210407193857.21120-1-fw@strlen.de/) — Pablo Neira Ayuso applied Westphal's post within a week, replying simply "Applied."

The fix itself wasn't the end of the discussion, though. Two weeks later Westphal [posted a follow-up](https://lore.kernel.org/netfilter-devel/20210426101440.25335-1-fw@strlen.de/), "netfilter: allow to turn off xtables compat layer," adding a `CONFIG_NETFILTER_XTABLES_COMPAT` Kconfig knob (default `y`, for compatibility) so the 32-bit compat translation code could be compiled out entirely. His stated reasoning was blunt: "The compat layer needs to parse untrusted input (the ruleset) to translate it to a 64bit compatible format. We had a number of bugs in this department in the past, so allow users to turn this feature off."

Jan Engelhardt pushed the idea further, asking whether the compat layer could be removed altogether rather than just made optional, since only one match (`xt_limit`'s `struct xt_rateinfo`) still needed a compat-specific struct layout: "Perhaps the remaining one... could be respecified as a v1, with the plan to ditch the v0. Then the entire xtables_compat code could go as well." Pablo Neira Ayuso agreed in principle — "If the remaining matches and targets that rely on this get a new revision to fix their structure layout issues, then this entire layer could be peeled off" — but Westphal explained why full removal wasn't that simple even then: the compat and native rule blobs have inherently different alignment rules (the `ip(6)t_entry`/match/target structures don't line up 1:1 across 32- and 64-bit layouts), `ipt_get_entries` carries mid-structure padding on x86_64 that i686 doesn't have, and the `compat_to_user` callback is needed by the standard target itself, not just by per-match structs like `xt_rateinfo`.

He offered a narrower version of the idea instead — dropping just the per-match `xt_match` compat callback, since `xt_limit` and `ebt_mark` were its only remaining users — while leaving the core translation layer in place. The Kconfig toggle, as originally posted, was what shipped; Pablo applied it the same day: "Applied, thanks."

```bash
# Compat netfilter is only reachable via 32-bit setsockopt() paths;
# CONFIG_NETFILTER_XTABLES and user namespace availability are the relevant knobs
sysctl kernel.unprivileged_userns_clone   # if present (some distros), 0 blocks the CAP_NET_ADMIN-via-userns path
```

## What it taught us

**A per-item bounds check is not a buffer bounds check.** Each `memset()` call was individually correct relative to the entry it was processing; the bug was in the aggregate, which no single call site could see.

**"Zero everything up front" beats "zero exactly what's needed, exactly where it's needed."** The fix traded a precise, per-entry computation for a coarser but provably-safe whole-buffer zero — a good general instinct when the precise version requires reasoning about interactions between many call sites.

**A tiny primitive plus a determined exploit writer equals full compromise.** Four zero bytes, written out of bounds, were enough to build a complete kernel-code-execution chain — severity assessments based on "how many bytes" rather than "what can be reached from here" undersell bugs like this one.

**An unanswered automated report is not a dismissed one — it's an untriaged one.** syzbot handed maintainers a full crash trace and working reproducer eight months before the bug was independently rediscovered and weaponized; what was missing wasn't detection but triage. A fuzzer finding a bug and a human acting on it are two different events, and the gap between them is exactly where a low-severity-looking crash can sit until someone builds an exploit chain for it.

!!! warning "Pattern to watch for"
    User-namespace-reachable `CAP_NET_ADMIN`/`CAP_NET_RAW` code paths deserve extra scrutiny — capabilities that once implied "trusted root-equivalent caller" now routinely apply to unprivileged users inside containers. If `kernel.unprivileged_userns_clone` (or your distro's equivalent knob) is enabled, any bug in a `CAP_NET_ADMIN`-gated path is a potential container-escape primitive, not just a local bug.

## See also

- [Netfilter Architecture](../netfilter.md) — x_tables, hooks, and the compat translation layer behind this bug
- [Network Namespaces](../net-namespaces.md) — how unprivileged user+network namespaces expose `CAP_NET_ADMIN`-gated code paths
- [AF_PACKET Privilege Escalation](af-packet.md) — another capability-gated local bug turned container-escape primitive

## External references

- [NVD: CVE-2021-22555](https://nvd.nist.gov/vuln/detail/CVE-2021-22555) — Netfilter x_tables heap overflow CVE record
- [git.kernel.org: b29c457a6511](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b29c457a6511435960115c0f548c4360d5f4801d) — "netfilter: x_tables: fix compat match/target pad out-of-bound write"
- [lore.kernel.org: netfilter: x_tables: fix compat match/target pad out-of-bound write](https://lore.kernel.org/netfilter-devel/20210407193857.21120-1-fw@strlen.de/) — Florian Westphal's patch as posted to netfilter-devel
- [syzbot: KASAN: slab-out-of-bounds Write in xt_compat_target_from_user](https://syzkaller.appspot.com/bug?extid=cfc0247ac173f597aaaa) — the syzbot dashboard for the original August 2020 report, showing no reply on the report thread until the fix landed eight months later
- [lore.kernel.org: syzbot's original report](https://lore.kernel.org/all/00000000000022934305ad166be3@google.com/) — the unanswered 17 August 2020 KASAN report emailed to netdev, netfilter-devel, and the netfilter maintainers
- [lore.kernel.org: netfilter: allow to turn off xtables compat layer](https://lore.kernel.org/netfilter-devel/20210426101440.25335-1-fw@strlen.de/) — the follow-up thread debating a `CONFIG_NETFILTER_XTABLES_COMPAT` opt-out versus removing the compat layer entirely
- [Andy Nguyen: CVE-2021-22555: Turning \x00\x00 into 10000$](https://google.github.io/security-research/pocs/linux/cve-2021-22555/writeup.html) — the primary-source exploit writeup, including the kCTF container-escape use
- [LWN: CVE-2021-22555: Turning \x00\x00 into 10000$](https://lwn.net/Articles/862955/) — LWN's brief on Nguyen's writeup
