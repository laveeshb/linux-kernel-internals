# War Stories: Linux Security Bugs and CVEs

> Real vulnerabilities from the LSM/capabilities/namespaces/ptrace territory — what broke, why, and what the kernel learned

The bugs on this page live in a different part of the trust model than most of the kernel's other war stories. A networking bug is usually reachable by an unauthenticated remote peer; a filesystem bug is usually reachable by anyone who can mount a crafted image. The bugs here are reachable by an ordinary local user account — no exploit chain needed to get a shell first — and every one of them ends the same way: a process that should have stayed unprivileged ends up with root, or with read/write access to data it should never have been able to touch.

What makes this territory distinctive is *how* that happens. Only one of these four is a classic memory-safety failure found by KASAN on a fuzzed input. Three are quieter than that: a struct field that keeps a stale value from a previous owner, a derived copy taken a few lines before the source it was copied from changed, a credential pointer captured from the wrong process entirely — and still trusted after that process's privileges changed. The fourth is a one-line arithmetic mistake, but even that one only matters because Linux's unprivileged user-namespace model hands an ordinary desktop user a namespace-scoped `CAP_SYS_ADMIN` that the vulnerable code was never audited against. Capabilities, credentials, and namespaces are exactly the primitives this page's bugs corrupt — which is also exactly what makes them dangerous: a bug in `net/` usually crashes something, a bug here usually hands over root.

There's a second recurring pattern worth calling out before the incidents themselves: unlike several of the openly-debated fixes on the [network stack's war-stories page](../net/war-stories.md), every fix below was reviewed privately under embargo before it ever reached a public list — via `security@kernel.org` for Dirty Pipe and the nested-namespace bug, through a distributor-coordinated channel for the fs_context overflow, and through a private channel that left no public review record for the ptrace bug, which Linus applied directly. Where a real LKML or lore.kernel.org discussion thread exists for a fix, each page below cites and quotes it; where none does — which is the norm here, not the exception — the page says so explicitly rather than inventing a debate that never happened.

Each incident below has its own page: root-cause analysis grounded in the actual patches, real primary sourcing (NVD, CISA's KEV catalog, Exploit-DB, and whatever mailing-list record actually exists), and a no-blame retrospective on the design decisions that made the bug possible.

## Incidents

Ordered reverse chronologically by disclosure date — newest first.

### [Dirty Pipe](war-stories/dirty-pipe.md)
**March 2022 · CVE-2022-0847 · CVSS 7.8**
A single missing `buf->flags = 0;`, dormant for six years across two unrelated refactors, let any user who could merely *read* a file overwrite it in the page cache instead — immutable files, read-only btrfs snapshots, and read-only mounts included, with no capability required at all. Actively exploited per CISA's KEV catalog within seven weeks of disclosure.

### [The fs_context Legacy Parameter Overflow](war-stories/fscontext-overflow.md)
**January 2022 · CVE-2022-0185 · CVSS 8.4**
A bounds check written as a subtraction instead of a sum underflowed in unsigned arithmetic, and `unshare -Urm` was all it took to reach it from an unprivileged account. One team weaponized it into a Kubernetes pod escape within days for a $31,337 bounty; a second, independent exploit targeting a different distribution followed a week later.

### [Stale ptracer Credentials](war-stories/stale-ptracer-creds.md)
**July 2019 · CVE-2019-13272 · CVSS 7.8**
`PTRACE_TRACEME` recorded the *parent's* credentials as the tracer's rather than the requesting child's, so an unprivileged process could make its own privileged parent its ptracer, wait for that parent to drop privilege and exec something attacker-reachable, and keep the ptrace relationship's original, still-privileged authority. Weaponized against polkit's `pkexec` on twenty-odd tested distributions within a week.

### [Nested User Namespace UID/GID Mapping](war-stories/nested-userns-uid-mapping.md)
**November 2018 · CVE-2018-18955 · CVSS 7.0**
A performance optimization kept two sorted copies of a namespace's ID mapping table but only translated one of them, an inconsistency invisible except two levels deep with more than five mapped ID ranges — reachable with nothing more than the setuid `newuidmap` helper from the `uidmap` package. An unprivileged process inside a nested namespace could read `/etc/shadow` on the host.

## Common threads

| Pattern | Dirty Pipe | fs_context overflow | Stale ptracer creds | Nested userns mapping |
|---------|:----------:|:--------------------:|:--------------------:|:-----------------------:|
| Reachable with zero capabilities or namespace tricks | Yes | No | Partial | Partial |
| Exploitability hinges on unprivileged user namespaces being enabled | No | Yes | No | Yes |
| Root cause is unsigned-integer arithmetic (over/underflow) | No | Yes | No | No |
| Root cause is a stale value carried forward from before a state change | Yes | No | Yes | Yes |
| An automated fuzzer (syzbot) found it first, independently, and went unanswered | No | Yes | No | No |
| Published exploit tool exists (PoC or Metasploit module) | Yes | Yes | Yes | Yes |
| Confirmed active exploitation (CISA KEV) | Yes | Yes | Yes | No |
| Fix reviewed privately under embargo, no substantive public LKML debate | Yes | Yes | Yes | Yes |

"Partial" on the first row means no *capability* is checked, but the bug still needs a specific structural precondition to be present — a privileged parent process for the ptrace bug, a namespace nested at least two levels deep with more than five mapped ID ranges for the UID-mapping bug. Dirty Pipe is the outlier that needed none of that: ordinary read access to a target file, on a kernel built any time between 2020 and February 2022, was the entire precondition.

The stale-value pattern is the strongest thread running through three of the four. A `pipe_buffer` slot keeping a previous occupant's flag, a `kmemdup()`'d array that stopped tracking its source, a credential pointer captured from the wrong process at the right moment but the wrong context — none of these are the buffer overruns or use-after-frees that dominate memory-safety CVEs elsewhere on this site. They're state that was correct when it was written and became wrong later, silently, because nothing re-validated it against what had changed around it. That's a harder bug class to catch with a sanitizer, and it shows: none of these three were found by fuzzing.

The fs_context bug is the exception on almost every row, and it's exactly the row it's an exception on that makes it the most severe of the four by CVSS: a classic unsigned-underflow bounds check, exactly the kind of thing KASAN and syzkaller are built to catch — and syzbot did catch it, independently, six days before the CTF team that got credit for the public disclosure, sitting unanswered on an Android-tree bug tracker the same way the netfilter x_tables report sat unanswered for eight months on the [networking side of this site](../net/war-stories/netfilter-xtables.md). Detection was never the bottleneck for any of these four bugs; triage was — and for the three private, embargoed disclosures here, the record shows the kernel's security process worked as designed, even where it left little for a mailing-list archaeologist to find later.

Three of the four have been confirmed under real-world active exploitation by CISA's KEV catalog — a strikingly high fraction, compared to the one out of six on the networking page. Local privilege-escalation primitives are directly useful to an attacker who already has a foothold, in a way a remote crash usually isn't; that's a plausible reason KEV inclusion runs higher here even though every bug on this page requires local access first.

## See also

- [LSM Framework](lsm.md) — the hook layer that sits alongside these bugs rather than in front of them: `security_ptrace_traceme()` is an LSM hook, but the decisions these bugs got wrong live in the DAC/credential/capability layers beneath it
- [Linux Capabilities](capabilities.md) — the privilege-splitting model that `CAP_SYS_ADMIN`-in-a-namespace and privilege-dropping-then-exec both depend on being sound
- [Credentials and User Namespaces](credentials.md) — `struct cred`, its lifecycle, and the RCU/reference-counting discipline two of these bugs violated
- [User Namespaces and uid Mapping](user-namespaces.md) — the unprivileged-namespace mechanism that turns "requires CAP_SYS_ADMIN" into "requires nothing" for two of these four bugs
- [seccomp BPF](seccomp.md) — syscall filtering as a containment layer for processes that opt in, relevant to Dirty Pipe's near-total lack of alternative mitigations
- [Kernel Hardening](kernel-hardening.md) — KASLR, hardened usercopy, and why none of them stopped the fs_context or ptracer-creds exploit chains
