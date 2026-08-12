# The 32-Bit Unsigned Bounds Propagation Bug

> CVE-2021-31440 — a fix landed four and a half months earlier had corrected the signed half of a two-line pattern and left the unsigned half standing

**Disclosed:** May 3, 2021 ([ZDI-21-503](https://www.zerodayinitiative.com/advisories/ZDI-21-503/), ZDI-CAN-13661; NVD record published May 21, 2021) &nbsp;·&nbsp; **Reported by:** Manfred Paul (per the fix commit's `Reported-by:` tag), via Trend Micro's Zero Day Initiative &nbsp;·&nbsp; **CVSS:** 7.0 HIGH (`CVSS:3.1/AV:L/AC:H/PR:L/UI:N/S:U/C:H/I:H/A:H`, NVD primary); 8.8 HIGH (`CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H`) from ZDI as secondary scorer &nbsp;·&nbsp; **Fixed in:** [`10bf4e83167c`](https://github.com/torvalds/linux/commit/10bf4e83167cc68595b85fd73bb91e8f2c086e36), mainline v5.13-rc1 &nbsp;·&nbsp; **Exploit tool:** none catalogued on Exploit-DB; NVD lists no reference tagged `Exploit` &nbsp;·&nbsp; **Actively exploited:** no confirmed cases (not on CISA KEV)

*Part of [War Stories: BPF Verifier Bugs and CVEs](../war-stories.md).*

## Before state

Since [`3f50f132d840`](https://github.com/torvalds/linux/commit/3f50f132d8400e129fc9eb68b5020167ef80a244) ("bpf: Verifier, do explicit ALU32 bounds tracking", v5.7-rc1), every scalar register in the verifier carries *two* sets of numeric bounds: the 64-bit `{s,u}{min,max}_value` and a separate 32-bit `{s,u}32_{min,max}_value` describing the low half.

Two sets of bounds means they have to be kept consistent. `__reg_combine_64_into_32()` is the direction that derives 32-bit bounds from 64-bit ones, and it did so one endpoint at a time:

```c
/* kernel/bpf/verifier.c, before the fix */
if (__reg64_bound_u32(reg->umin_value))
	reg->u32_min_value = (u32)reg->umin_value;
if (__reg64_bound_u32(reg->umax_value))
	reg->u32_max_value = (u32)reg->umax_value;
```

`__reg64_bound_u32(a)` is just `a > U32_MIN && a < U32_MAX` — "this value sits strictly inside the 32-bit range" (the strict comparisons exclude 0 and `U32_MAX` themselves).

## The trigger

Testing each endpoint independently is the bug. The fix commit states the rule that was violated:

> That is, really only set the `u32_{min,max}_value` when /both/ `{umin,umax}_value` safely fit in 32 bit space. For example, the register with a `umin_value == 1` does /not/ imply that `u32_min_value` is also equal to 1, since `umax_value` could be much larger than 32 bit subregister can hold, and thus `u32_min_value` is in the interval `[0,1]` instead.

A register whose 64-bit range is `[1, 0xffffffff00000001]` can hold `0x100000000` — whose low 32 bits are zero. So `u32_min_value = 1` is a false statement about the register, derived from a true one.

The commit shows the resulting verifier trace. After `if r2 >= 0x1` and `if w2 <= 0x1` on the goto paths, and then a `w2 = w2` (a 32-bit move that discards the high half):

```
10: R0=inv1337 R1=ctx(id=0,off=0,imm=0) R2_w=inv1 R10=fp0
```

`R2_w=inv1` means the verifier is now certain the register is exactly the constant 1. It is not. The bad `u32_min_value = 1` got promoted into a bad known-constant.

## Observed behavior

From that point the verifier is reasoning about a register whose real run-time value it no longer knows. NVD's description of the CVE puts the impact plainly:

> The specific flaw exists within the handling of eBPF programs. The issue results from the lack of proper validation of user-supplied eBPF programs prior to executing them. An attacker can leverage this vulnerability to escalate privileges and execute arbitrary code in the context of the kernel.

The two scorers disagree meaningfully on how hard that is. NVD's primary score puts it at 7.0 with `AC:H` and unchanged scope; ZDI scored it 8.8 with `AC:L` and `S:C`. The disagreement is about attack complexity and blast radius, not about what the bug does.

Unlike its sibling [CVE-2021-3490](alu32-bitwise-bounds.md), whose public exploit is catalogued on Packet Storm, no packaged public exploit for this one exists: NVD's reference list carries no `Exploit`-tagged entry, and there is no Exploit-DB entry.

## Why it happened

This is not the first time this exact code shape was fixed.

On December 8, 2020 — four and a half months before this fix — Alexei Starovoitov committed [`b02709587ea3`](https://github.com/torvalds/linux/commit/b02709587ea3d699a608568ee8157d8db4fd8cae) ("bpf: Fix propagation of 32-bit signed bounds from 64-bit bounds."), reported by Jean-Philippe Brucker. Its reasoning is word-for-word the same argument, one signedness over:

> The 64-bit signed bounds should not affect 32-bit signed bounds unless the verifier knows that upper 32-bits are either all 1s or all 0s. For example the register with `smin_value==1` doesn't mean that `s32_min_value` is also equal to 1, since `smax_value` could be larger than 32-bit subregister can hold.

And its diff fixes exactly one of the two adjacent blocks:

```diff
-	if (__reg64_bound_s32(reg->smin_value))
+	if (__reg64_bound_s32(reg->smin_value) && __reg64_bound_s32(reg->smax_value)) {
 		reg->s32_min_value = (s32)reg->smin_value;
-	if (__reg64_bound_s32(reg->smax_value))
 		reg->s32_max_value = (s32)reg->smax_value;
+	}
 	if (__reg64_bound_u32(reg->umin_value))
 		reg->u32_min_value = (u32)reg->umin_value;
 	if (__reg64_bound_u32(reg->umax_value))
 		reg->u32_max_value = (u32)reg->umax_value;
```

The unsigned block is right there in the diff context, immediately below the change, with identical structure — and it was left alone. The signed variant was the one that had been reported, so the signed variant was the one that got fixed.

Both blocks trace back to the same parent commit, `3f50f132d840`, which introduced explicit ALU32 tracking in v5.7-rc1. That commit is also the `Fixes:` target of [CVE-2021-3490](alu32-bitwise-bounds.md), disclosed eighteen days after this one's fix landed. Adding a second, parallel representation of a register's value created a whole family of "keep the two in sync" obligations, and the bugs came in one at a time.

## Resolution

[`10bf4e83167c`](https://github.com/torvalds/linux/commit/10bf4e83167cc68595b85fd73bb91e8f2c086e36) ("bpf: Fix propagation of 32 bit unsigned bounds from 64 bit bounds", Daniel Borkmann) applies the same shape of fix to the unsigned block:

```diff
-	if (__reg64_bound_u32(reg->umin_value))
+	if (__reg64_bound_u32(reg->umin_value) && __reg64_bound_u32(reg->umax_value)) {
 		reg->u32_min_value = (u32)reg->umin_value;
-	if (__reg64_bound_u32(reg->umax_value))
 		reg->u32_max_value = (u32)reg->umax_value;
+	}
```

It also does one more thing worth noting: it rewrites `__reg64_bound_u32()` from an `if/return true/return false` into a plain `return a > U32_MIN && a < U32_MAX;`, matching how `b02709587ea3` had already restyled `__reg64_bound_s32()`. The commit's own words: "Also, align `__reg64_bound_u32()` similarly to `__reg64_bound_s32()` as done in `b02709587ea3` to make them uniform again." That is the fix explicitly finishing the job of the earlier one, cosmetics included.

The patch carries `Reviewed-by: John Fastabend` and `Acked-by: Alexei Starovoitov`, but no `Link:` trailer to a public posting — consistent with a report handled privately before disclosure. Neither the commit nor NVD's reference list points to a mailing-list posting, so the public record is the CVE and the fix itself.

One line of the diff records the behavioral change better than any of the prose. A BPF selftest that had been asserting the verifier rejected a program with a specific message was updated:

```diff
-	.errstr = "invalid access to map value, value_size=48 off=44 size=8",
+	.errstr = "R0 unbounded memory access",
```

Before the fix the verifier believed it knew the offset precisely enough to complain about that specific offset. After it, the verifier correctly admits it does not know the value at all.

## What it taught us

**When a bug report names one variant, the fix's scope is every sibling in the same block.** The signed and unsigned propagation paths were adjacent, identically structured, and derived from the same commit. Fixing one and shipping is a defensible response to a bug report and an indefensible response to a bug *class*. Four and a half months and one CVE separated the two halves.

**Redundant representations of the same fact create synchronization obligations that no compiler checks.** `3f50f132d840` gave every register a second set of bounds for good reasons — real BPF programs written in C do 32-bit arithmetic, and forcing everything into 64-bit bounds made the verifier reject correct programs. The cost was a set of invariants ("the 32-bit bounds must be implied by the 64-bit bounds and vice versa") that live only in reviewers' heads.

**A one-sided range test is not a range test.** `if (endpoint_fits) narrow(endpoint)` is wrong whenever narrowing one endpoint asserts something about the interval as a whole. The correct predicate is about the interval, not the endpoint — which is exactly what the fix's `&&` encodes.

!!! warning "Pattern to watch for"
    Grep for paired `if (cond_a) x = ...;` / `if (cond_b) y = ...;` blocks that jointly define a range, an extent, or a start/end pair. If narrowing one end without the other can produce a range that excludes real values, the two tests belong in one condition. And when reviewing any `Fixes:`-tagged patch, read the surrounding hunk context for a structurally identical block the patch did not touch — in this case the vulnerable code was visible, unchanged, in the trailing context immediately below the fix, in the fix's own diff.

## See also

- [BPF Verifier](../bpf-verifier.md) — register bounds tracking and how the verifier reasons about scalar values
- [ALU32 Bitwise Bounds Tracking](alu32-bitwise-bounds.md) — the other 2021 CVE against the same introducing commit, reported by the same researcher
- [The jmp32 Bounds Regression](jmp32-bounds.md) — the 2020 CVE whose fallout produced `3f50f132d840` in the first place
- [Unprivileged BPF Off by Default](unprivileged-bpf-off.md) — the hardening response to this run of verifier CVEs

## External references

- [NVD: CVE-2021-31440](https://nvd.nist.gov/vuln/detail/CVE-2021-31440) — CVSS 7.0 HIGH (NVD) / 8.8 HIGH (ZDI), published May 21, 2021
- [GitHub mirror: 10bf4e83167c](https://github.com/torvalds/linux/commit/10bf4e83167cc68595b85fd73bb91e8f2c086e36) — "bpf: Fix propagation of 32 bit unsigned bounds from 64 bit bounds", the fix
- [GitHub mirror: b02709587ea3](https://github.com/torvalds/linux/commit/b02709587ea3d699a608568ee8157d8db4fd8cae) — "bpf: Fix propagation of 32-bit signed bounds from 64-bit bounds." (December 2020), the signed half of the same bug, fixed first
- [GitHub mirror: 3f50f132d840](https://github.com/torvalds/linux/commit/3f50f132d8400e129fc9eb68b5020167ef80a244) — "bpf: Verifier, do explicit ALU32 bounds tracking" (v5.7-rc1), the introducing commit named by both 2021 CVEs
- [CISA: Known Exploited Vulnerabilities Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) — does not list CVE-2021-31440
