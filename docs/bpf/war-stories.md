# War Stories: BPF Verifier Bugs and CVEs

> Real vulnerabilities from the eBPF verifier — what broke, why, and what the kernel eventually concluded about the whole idea

Almost every other war story on this site is about code that was *supposed* to be safe and turned out not to be. The BPF verifier is different: it is a program whose entire job is to be a proof. Before the kernel will run a BPF program, the verifier walks every path the program could take, tracks what every register could hold, and refuses anything it cannot prove safe. When it works, an unprivileged user can load code into ring 0 and nothing bad happens.

That makes the bug class here unusually pure. There is no buffer to overflow and no lock to drop. Every incident below is the same failure in a different costume: **the verifier's model of what a register holds diverged from what the register will actually hold at run time.** One instruction where the model says "sign-extended" and the machine says "zero-padded." One masking operation that is valid for a value and invalid for a range. One early return that skips an update because a sibling function "will handle it." Each of those is a few lines, each of them passed review, and each of them hands an unprivileged process the ability to construct a pointer the verifier thinks is in bounds.

The other thing this page documents is a conclusion. After years of holding the line that the verifier could be a security boundary against a hostile program author, the BPF maintainers stopped believing it — publicly, on LWN, in 2019 — and the subsystem eventually shipped a knob to turn unprivileged BPF off by default. That is not a CVE, but it is the most consequential entry here, so it gets a page.

Each incident below has its own page: root-cause analysis grounded in the actual patches and the actual verifier traces the maintainers pasted into their commit messages, plus whatever public mailing-list record exists. For one of them — the 2020 jmp32 revert — that record is a full public thread with a replacement implementation from Jann Horn in the same series. For most of the rest, the fixes were handled privately and announced on oss-security once they shipped; CVE-2021-31440 has no oss-security announcement at all, only a ZDI advisory, and the unprivileged-BPF default change was an ordinary public patch posting. The pages say that rather than manufacturing a debate.

## Incidents

Ordered reverse chronologically by earliest public disclosure — oss-security post, ZDI advisory, or NVD publication, whichever came first — newest first.

### [Spectre in the BPF Verifier](war-stories/spectre-verifier.md)
**June 2021 · CVE-2021-33624 · CVSS 4.7**
The verifier only walks paths that can actually execute. A CPU that mispredicts two mutually exclusive branches will execute a path the verifier proved impossible, dereferencing an attacker-controlled pointer under speculation. The fix stopped pruning unreachable branches and started simulating them.

### [Unprivileged BPF Off by Default](war-stories/unprivileged-bpf-off.md)
**May 2021 · not a CVE**
Posted the same day CVE-2021-3490 was announced: a kconfig knob defaulting `kernel.unprivileged_bpf_disabled` to a new value 2 — off, but recoverable by an administrator. The end of a two-year argument about whether unprivileged BPF was ever achievable, which LWN had documented in 2019.

### [ALU32 Bitwise Bounds Tracking](war-stories/alu32-bitwise-bounds.md)
**May 2021 · CVE-2021-3490 · CVSS 7.8**
Three functions skipped updating a register's 32-bit bounds on the grounds that a 64-bit sibling would handle it. The sibling only handled it under a stricter precondition, leaving registers in a state where the minimum exceeded the maximum. A public local-root exploit followed.

### [The 32-Bit Unsigned Bounds Propagation Bug](war-stories/alu32-unsigned-bounds.md)
**May 2021 · CVE-2021-31440 · CVSS 7.0 (NVD) / 8.8 (ZDI)**
Four and a half months earlier, someone had fixed exactly this bug in the signed half of a two-block pattern. The unsigned half sat unchanged in the trailing context of the fix's own diff.

### [The jmp32 Bounds Regression](war-stories/jmp32-bounds.md)
**March 2020 · CVE-2020-8835 · CVSS 7.8**
A precision improvement, never intended for stable, was auto-selected into the 5.4 long-term series by a machine-learning classifier that mistook it for a fix. Manfred Paul turned it into a Pwn2Own entry. The fix was a pure 19-line deletion, chosen over a working repair.

### [Sign Extension in `check_alu_op()`](war-stories/sign-extension.md)
**December 2017 · CVE-2017-16995 · CVSS 7.8**
The verifier sign-extended a 32-bit immediate that the machine zero-pads, so its model of the register was wrong from the first instruction. One of eight verifier bugs Jann Horn reported in a single message — the pass that established the verifier's arithmetic as a security-reviewed surface. Three public exploits, including a Metasploit module.

## Common threads

| Pattern | Spectre | Unpriv off | ALU32 bitwise | 32-bit unsigned | jmp32 | Sign extension |
|---------|:-------:|:----------:|:-------------:|:----------------:|:-----:|:--------------:|
| Root cause is 32-bit vs. 64-bit value tracking | No | — | Yes | Yes | Yes | Yes |
| Reachable by an unprivileged local process on a default-configured kernel | Yes | — | Yes | Yes | Yes | Yes (from 4.14) |
| Descends from `3f50f132d840` (explicit ALU32 bounds tracking) | No | — | Yes | Yes | No | No |
| Surfaced first by fuzzing | No | — | No | No | Yes | No |
| Found through a paid vulnerability program (ZDI / Pwn2Own) | No | — | Yes | Yes | Yes | No |
| Packaged public exploit tool (Exploit-DB / Metasploit / Packet Storm) | No | — | Yes | No | No | Yes |
| Confirmed active exploitation (CISA KEV) | No | — | No | No | No | No |
| Fix deleted code rather than adding it | No | — | No | No | Yes | No |

The first row is the page's spine. Four of the five bugs are the same disagreement at different points in the pipeline: a 64-bit value, a 32-bit view of it, and a rule for keeping the two consistent that was correct for the case its author had in mind. BPF programs are written in C and compiled by LLVM, which emits 32-bit arithmetic constantly, so the verifier cannot simply refuse to reason about subregisters — the alternative to this machinery is rejecting correct programs.

**The lineage is the most instructive thing here, and it is fully traceable in the commits.** A precision patch ([`581738a681b6`](https://github.com/torvalds/linux/commit/581738a681b6faae5725c2555439189ca81c0f1f)) encoded 32-bit knowledge by abusing the tnum representation. That became [CVE-2020-8835](war-stories/jmp32-bounds.md). The response was a revert plus a correct reimplementation by Jann Horn — which was itself superseded, in the same release, by John Fastabend's [`3f50f132d840`](https://github.com/torvalds/linux/commit/3f50f132d8400e129fc9eb68b5020167ef80a244), giving registers a genuine second set of 32-bit bounds instead of overloading the tnum. That is the better design, and it is the `Fixes:` target of both [CVE-2021-3490](war-stories/alu32-bitwise-bounds.md) and [CVE-2021-31440](war-stories/alu32-unsigned-bounds.md). Every step of that chain was an improvement. Every step also created new invariants that nothing but review enforced, and review missed them.

**Detection here looks nothing like the [networking page](../net/war-stories.md).** There, syzkaller and KASAN found most of the bugs, because most of them corrupt memory in ways a sanitizer notices. A verifier bug corrupts nothing at verification time — it produces a *proof that is wrong*, and no sanitizer has an opinion about that. So the finders are different: Jann Horn's systematic 2017 audit, and then Manfred Paul, who is behind three of the five CVEs on this page, working through Pwn2Own and ZDI. Fuzzing appears exactly once, and even then obliquely: Anatoly Trosinenko's kBdysch harness reported CVE-2020-8835 as a *hang*, because the verifier's wrong proof caused it to rewrite live instructions as an infinite loop. The security impact was found separately, by someone looking for it.

**None of these has ever been confirmed exploited in the wild.** Not one appears in CISA's KEV catalog, despite two of them having public working exploits, both shipped as Metasploit modules — one since 2018. That is a lower rate than the [security subsystem's war stories](../security/war-stories.md), where three of four are KEV-listed — and the likely reason is the same reason this page ends the way it does. A local privilege escalation is only useful if the primitive is available on the target, and over this exact period the primitive was being fenced off: `CAP_BPF` in 2020, then a build-time off-by-default option in 2021. That is a plausible explanation rather than a demonstrated one — absence from KEV is absence of *confirmed* exploitation, not evidence that nobody tried.

**Which is the actual conclusion of this page.** The [unprivileged-BPF-off](war-stories/unprivileged-bpf-off.md) entry is not a CVE and not a mistake — it is the subsystem's own answer to everything above it. Alexei Starovoitov's position, quoted on LWN in 2019, is that the verifier hardening built to make unprivileged BPF safe is "a lot of complex kernel code without users." Andy Lutomirski's counter, that the use cases don't exist *because* the support doesn't, was never refuted; it was settled by shipping a default. Read the five bug pages first, then that one, and the argument reads very differently than it does in isolation.

## See also

- [BPF Verifier](bpf-verifier.md) — register state tracking, tnums, path exploration, and dead-code elimination: the machinery every bug on this page lives inside
- [Architecture & Program Types](bpf-overview.md) — the BPF instruction set, including the `BPF_ALU` / `BPF_ALU64` split behind the 2017 bug
- [BPF Maps](bpf-maps.md) — array maps, whose index handling the 2018 Spectre mitigation rewrote
- [Linux Capabilities](../security/capabilities.md) — `CAP_BPF` and the privilege split that gave administrators an option between "root" and "anyone"
- [Kernel Hardening](../security/kernel-hardening.md) — where default-off knobs and speculation mitigations sit in the wider picture
- [Security War Stories](../security/war-stories.md) — local privilege escalations in the capabilities/namespaces/credentials layer, with a very different KEV profile
- [Network War Stories](../net/war-stories.md) — the same site's networking incidents, where fuzzing rather than bounty programs did most of the finding
