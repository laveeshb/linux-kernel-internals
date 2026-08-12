# Sign Extension in `check_alu_op()`

> CVE-2017-16995 — the verifier sign-extended a 32-bit immediate that the machine zero-extends, so its model of the register and the register itself disagreed from the very first instruction

**Disclosed:** December 21, 2017 (oss-security) &nbsp;·&nbsp; **Reported by:** Jann Horn, Google Project Zero &nbsp;·&nbsp; **CVSS:** 7.8 HIGH (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`, NVD primary) &nbsp;·&nbsp; **Introduced in:** [`484611357c19`](https://github.com/torvalds/linux/commit/484611357c19f9e19ef742ebef4505a07d243cc9) ("bpf: allow access into map value arrays", v4.9) &nbsp;·&nbsp; **Fixed in:** [`95a762e2c8c9`](https://github.com/torvalds/linux/commit/95a762e2c8c942780948091f8f2a4f32fce1ac6f), mainline v4.15-rc5 &nbsp;·&nbsp; **Exploit tool:** yes — three Exploit-DB entries, including a [Metasploit module](https://www.exploit-db.com/exploits/45058) &nbsp;·&nbsp; **Actively exploited:** no confirmed cases (not on CISA KEV)

*Part of [War Stories: BPF Verifier Bugs and CVEs](../war-stories.md).*

## Before state

The BPF instruction set has two classes of ALU operation: `BPF_ALU64`, which works on the full 64-bit register, and `BPF_ALU`, which works on the low 32 bits and zero-fills the top. Both classes have a `MOV` with a 32-bit immediate operand, and the two behave differently at run time:

- `BPF_ALU64 | BPF_MOV | BPF_K` — load the 32-bit immediate, **sign-extended** to 64 bits.
- `BPF_ALU | BPF_MOV | BPF_K` — load the 32-bit immediate, **zero-padded** to 64 bits.

`insn->imm` is a signed 32-bit field. In `check_alu_op()`, the verifier recorded the resulting register value with a single line that did not distinguish the two cases:

```c
/* kernel/bpf/verifier.c, before the fix */
regs[insn->dst_reg].type = SCALAR_VALUE;
__mark_reg_known(regs + insn->dst_reg, insn->imm);
```

`__mark_reg_known()` takes a `u64`. Passing a negative `s32` to it promotes with sign extension. So for *both* instruction classes, the verifier recorded the sign-extended value.

## The trigger

For `BPF_ALU64` that is correct. For `BPF_ALU` it is not.

Write a 32-bit `MOV` with a negative immediate and the verifier records a register whose value it believes to be a large 64-bit quantity with the top 32 bits set. At run time, the interpreter and every JIT zero-pad instead, so the register actually holds a small positive number below 2³².

Jann Horn's fix states the distinction and nothing more, because nothing more is needed:

> Distinguish between `BPF_ALU64|BPF_MOV|BPF_K` (load 32-bit immediate, sign-extended to 64-bit) and `BPF_ALU|BPF_MOV|BPF_K` (load 32-bit immediate, zero-padded to 64-bit); only perform sign extension in the first case.

The verifier's entire safety argument rests on its per-register value model matching the machine. Here the two diverge at the point where a constant is loaded — the simplest instruction in the language, and the one every subsequent bounds inference is built on top of.

## Observed behavior

NVD's description is the conventional summary — "allows local users to cause a denial of service (memory corruption) or possibly have unspecified other impact by leveraging incorrect sign extension." Horn's own [oss-security posting](https://www.openwall.com/lists/oss-security/2017/12/21/2) on December 21, 2017 is blunter about the class: "A few BPF verifier bugs in the Linux kernel, most of which can be used for controlled memory corruption, have been fixed over the last days."

The proof-of-concept Horn published alongside the report is described in that post as a crasher that attempts to write to a noncanonical address, and is explicitly noted as being written only for 4.14 — a demonstration that the verifier's model is wrong, not a weaponized exploit.

Weaponization came from elsewhere, and it came fast:

- **[Exploit-DB 44298](https://www.exploit-db.com/exploits/44298)** — "Linux Kernel < 4.4.0-116 (Ubuntu 16.04.4) — Local Privilege Escalation", Bruce Leidl, March 16, 2018.
- **[Exploit-DB 45010](https://www.exploit-db.com/exploits/45010)** — "Linux Kernel < 4.13.9 (Ubuntu 16.04 / Fedora 27) — Local Privilege Escalation", rlarabee, July 10, 2018.
- **[Exploit-DB 45058](https://www.exploit-db.com/exploits/45058)** — "Linux — BPF Sign Extension Local Privilege Escalation", July 19, 2018: a Metasploit module (`exploit/linux/local/bpf_sign_extension_priv_esc`), which turns the bug into a one-command local root for anyone running the framework.

Three months from disclosure to a public working exploit, seven to a Metasploit module. As with the other incidents on this page, CISA's KEV catalog records no confirmed exploitation in the wild.

The reachability caveat is in the fix commit itself:

> Starting with v4.14, this is exploitable by unprivileged users as long as the `unprivileged_bpf_disabled` sysctl isn't set.

The bug was introduced in v4.9 by [`484611357c19`](https://github.com/torvalds/linux/commit/484611357c19f9e19ef742ebef4505a07d243cc9) ("bpf: allow access into map value arrays", Josef Bacik, September 2016) — but only became reachable from an unprivileged process in 4.14, which is what turned a verifier defect into a privilege escalation.

## Why it happened

**A signed field and an unsigned parameter, with an implicit promotion in between.** `insn->imm` is signed; `__mark_reg_known()` takes `u64`. The conversion is legal C, silent, and correct for exactly one of the two callers. No warning fires, because nothing is wrong at the language level — the code says precisely what it means, and what it means is right half the time.

**Two instruction classes sharing one code path with different semantics.** `check_alu_op()` handles `BPF_ALU` and `BPF_ALU64` together and branches on `BPF_CLASS(insn->code)` where behavior differs. This was one of the places where behavior differed and the branch was missing.

**It was one of eight.** Horn's December 2017 oss-security post is a single message enumerating eight distinct verifier bugs found in one pass, each with its own fix commit: incorrect signed bounds for `BPF_RSH`; incorrect tracking of register size truncation (CVE-2017-16996); 32-bit ALU op verification operating on 64-bit numbers while the interpreter and JIT do 32-bit arithmetic; a missing error return in `check_stack_boundary()`; missing strict alignment checks for stack pointers; branch pruning when a scalar is replaced with a pointer; and a set of integer overflows in offset arithmetic. The sign-extension bug is not an isolated slip. It is one sample from a subsystem whose arithmetic model had not yet been audited by anyone with an adversarial mindset — and Project Zero was the first to do so systematically.

## Resolution

The fix is an if/else:

```diff
 			regs[insn->dst_reg].type = SCALAR_VALUE;
-			__mark_reg_known(regs + insn->dst_reg, insn->imm);
+			if (BPF_CLASS(insn->code) == BPF_ALU64) {
+				__mark_reg_known(regs + insn->dst_reg,
+						 insn->imm);
+			} else {
+				__mark_reg_known(regs + insn->dst_reg,
+						 (u32)insn->imm);
+			}
```

The `(u32)` cast forces the zero-padding path for `BPF_ALU`, making the verifier's model match what the interpreter and JIT will actually do.

`95a762e2c8c9` carries `Acked-by: Edward Cree` and sign-offs from Alexei Starovoitov and Daniel Borkmann. Horn's oss-security post notes that at the time of the announcement the fixes were "in the net tree of the Linux kernel [...] but not in Linus' tree yet." The patch reached mainline in v4.15-rc5.

There is no design debate to quote here, and the reason is visible in the commit's own revision note:

```
v3:
 - add CVE number (Ben Hutchings)
```

The patch reached at least a third revision, and the only revision change the commit message preserves is adding the CVE identifier Debian had assigned. Nobody argued about the fix, because there is nothing to argue about: the instruction set defines two behaviors and the code implemented one.

What did change, structurally, is that this batch marks the point where the verifier's arithmetic became a security-reviewed surface rather than a correctness-reviewed one. The three-year run of bounds-tracking CVEs documented elsewhere on this page — [2020](jmp32-bounds.md), [2021](alu32-bitwise-bounds.md), [2021 again](alu32-unsigned-bounds.md) — all sit downstream of that shift.

## What it taught us

**Where a specification defines two behaviors, the implementation needs two branches — and the type system will not remind you.** The BPF instruction set is explicit that `BPF_ALU` zero-pads and `BPF_ALU64` sign-extends. The verifier had one code path. The bug is not subtle once stated; it is invisible in review because the offending line reads exactly like correct code.

**Signed-to-unsigned promotion at a function boundary deserves an explicit cast even when the default is right.** `__mark_reg_known(reg, insn->imm)` relies on the reader knowing that `imm` is `s32`, that the parameter is `u64`, and that sign extension is intended. Writing the intended conversion out — as the fix does with `(u32)` on one side — makes the two cases distinguishable at the call site instead of at the language-standard level.

**A verifier bug's severity is set by who can reach the verifier.** This defect shipped in v4.9 and was a privilege escalation from v4.14, because that is when the relevant path became reachable without privileges. The code did not change; the exposure did. That relationship is exactly what the [unprivileged-BPF-off-by-default](unprivileged-bpf-off.md) change would eventually act on, four years later.

**Systematic adversarial review finds bug *classes*, not bugs.** Eight verifier bugs in one announcement, from one researcher, in one pass. The individual fixes are each a few lines. The finding that mattered was that the verifier's integer arithmetic had never been examined by someone actively trying to break it.

!!! warning "Pattern to watch for"
    Audit every place a decoder, interpreter, or verifier handles a family of opcodes through shared code. For each field the opcode family varies over — operand width, signedness, addressing mode, endianness — confirm there is either a branch or a proof that the behavior is genuinely identical. The dangerous shape is a single statement that is correct for the majority case and silently wrong for a minority one, since it will read as correct in every review. Separately, treat `s32`-into-`u64` argument passing as a review flag in any code whose job is to model run-time values.

## See also

- [BPF Verifier](../bpf-verifier.md) — how the verifier models register values and why a wrong constant poisons everything downstream
- [Architecture & Program Types](../bpf-overview.md) — the BPF instruction set, including the `BPF_ALU` / `BPF_ALU64` split at the heart of this bug
- [The jmp32 Bounds Regression](jmp32-bounds.md) — the same failure mode (verifier model diverging from run-time value) three years later
- [Unprivileged BPF Off by Default](unprivileged-bpf-off.md) — the sysctl this bug's exploitability depended on
- [Kernel Hardening](../../security/kernel-hardening.md) — the mitigation layer that local privilege escalations like this one have to get through

## External references

- [NVD: CVE-2017-16995](https://nvd.nist.gov/vuln/detail/CVE-2017-16995) — CVSS 7.8 HIGH, published December 27, 2017
- [GitHub mirror: 95a762e2c8c9](https://github.com/torvalds/linux/commit/95a762e2c8c942780948091f8f2a4f32fce1ac6f) — "bpf: fix incorrect sign extension in check_alu_op()", the four-line fix
- [GitHub mirror: 484611357c19](https://github.com/torvalds/linux/commit/484611357c19f9e19ef742ebef4505a07d243cc9) — "bpf: allow access into map value arrays" (v4.9), the commit named by the fix's `Fixes:` tag
- [oss-security: Linux >=4.9: eBPF memory corruption bugs](https://www.openwall.com/lists/oss-security/2017/12/21/2) — Jann Horn's December 21, 2017 announcement of all eight verifier bugs, with per-bug technical descriptions
- [Exploit-DB 44298](https://www.exploit-db.com/exploits/44298), [45010](https://www.exploit-db.com/exploits/45010), and [45058](https://www.exploit-db.com/exploits/45058) — three catalogued local-root exploits; 45058 is the Metasploit module `exploit/linux/local/bpf_sign_extension_priv_esc`
- [CISA: Known Exploited Vulnerabilities Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) — does not list CVE-2017-16995
