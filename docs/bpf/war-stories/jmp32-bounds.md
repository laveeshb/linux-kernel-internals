# The jmp32 Bounds Regression

> CVE-2020-8835 — a precision patch was auto-selected into a stable kernel by a machine-learning classifier that mistook it for a bug fix, and it turned out to be a privilege escalation

**Disclosed:** March 30, 2020 (oss-security) &nbsp;·&nbsp; **Demonstrated by:** Manfred Paul, as part of ZDI's Pwn2Own 2020 competition (ZDI-CAN-10780); the hang that led to the fix was reported by Anatoly Trosinenko, fuzzing with the kBdysch harness &nbsp;·&nbsp; **CVSS:** 7.8 HIGH (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`, NVD primary); Ubuntu's secondary score is also 7.8, with a different vector (`AC:H`, `S:C`) &nbsp;·&nbsp; **Introduced in:** [`581738a681b6`](https://github.com/torvalds/linux/commit/581738a681b6faae5725c2555439189ca81c0f1f) (v5.5), backported into 5.4-stable &nbsp;·&nbsp; **Fixed in:** [`f2d67fec0b43`](https://github.com/torvalds/linux/commit/f2d67fec0b43edce8c416101cdc52e71145b5fef), mainline v5.7-rc1; stable 5.6.1, 5.5.14, 5.4.29 &nbsp;·&nbsp; **Exploit tool:** no Exploit-DB entry; NVD tags a later oss-security post as `Exploit` &nbsp;·&nbsp; **Actively exploited:** no confirmed cases ([not on CISA KEV](https://nvd.nist.gov/vuln/detail/CVE-2020-8835))

*Part of [War Stories: BPF Verifier Bugs and CVEs](../war-stories.md).*

## Before state

BPF has 32-bit conditional jumps (`jmp32`, generated when LLVM is asked for `-mcpu=v3`), and in November 2019 Yonghong Song's [`581738a681b6`](https://github.com/torvalds/linux/commit/581738a681b6faae5725c2555439189ca81c0f1f) ("bpf: Provide better register bounds after jmp32 instructions") taught the verifier to learn something from them. The patch [went through review](https://lore.kernel.org/all/20191121045924.v77wb5zzfliln7ql@ast-mbp.dhcp.thefacebook.com/) on the bpf list — but Alexei Starovoitov's only comment was about the *style* of `__reg_bound_offset32()` ("may be make sense to do it as a helper?"), and his direct question to a second reviewer — "Ed, how would you simplify `__reg_bound_offset32` logic?" — went unanswered. The masking premise itself was never challenged.

The verifier tracks each scalar register two ways: as a numeric interval (`umin_value` … `umax_value`) and as a **tnum** — a `(value, mask)` pair recording which individual bits are known and which are not. `581738a681b6` added a helper to refine the tnum after a 32-bit comparison:

```c
static void __reg_bound_offset32(struct bpf_reg_state *reg)
{
	u64 mask = 0xffffFFFF;
	struct tnum range = tnum_range(reg->umin_value & mask,
				       reg->umax_value & mask);
	struct tnum lo32 = tnum_cast(reg->var_off, 4);
	struct tnum hi32 = tnum_lshift(tnum_rshift(reg->var_off, 32), 32);

	reg->var_off = tnum_or(hi32, tnum_intersect(lo32, range));
}
```

Read the first two statements. It takes the register's 64-bit bounds, masks both endpoints down to their low 32 bits, and treats the result as the register's 32-bit range.

At the time, this was a precision improvement, not a fix — it made the verifier accept correct programs it had been rejecting. That distinction matters for what happened next.

## The trigger

Masking both endpoints is only valid when the two endpoints agree on their high 32 bits.

Take a register bounded by `umin = 0x2000000000` and `umax = 0x4000000000`. Masking gives `0x0` and `0x0`, so `tnum_range()` produces the range `[0, 0]` — the verifier concludes the low half is *definitely zero*. The truth is that a value anywhere in `[0x2000000000, 0x4000000000]` can have any low 32 bits at all: the correct answer is `[0x0, 0xffffffff]`, i.e. no information.

The fix commit walks through it register-state by register-state. After bounding r1 with two 64-bit jumps and then two 32-bit jumps:

```
Thus, after knowing r1 <= 0x4000000000 and r1 >= 0x2000000000 and
                    w1 <= 0x400        and w1 >= 0x200:

  max: 0b100000000000000000000000000000000000000 / 0x4000000000
  var: 0b111111100000000000000000000000000000000 / 0x7f00000000
  min: 0b010000000000000000000000000000000000000 / 0x2000000000
```

Borkmann's verdict on that `var` line:

> A outcome of `0x7f00000000` is not correct since it would contradict the earlier probed bounds where we know that the result should have been in `[0x200,0x400]` in u32 space. Therefore, tests with such info will lead to wrong verifier assumptions later on like falsely predicting conditional jumps to be always taken, etc.

The verifier now holds two statements about the same register that cannot both be true. Everything downstream inherits the contradiction.

## Observed behavior

The way this surfaced is one of the more striking things in the record: **the kernel produced a program that hung**.

Anatoly Trosinenko, fuzzing with the kBdysch harness, reported a hang. Borkmann's investigation found the verifier had convinced itself that certain conditional jumps were always taken, marked the alternative branches dead, and rewrote those instructions as `goto pc-1` — an unconditional jump to itself. Then reality diverged from the simulation:

> The verifier rewrote original instructions it recognized as dead code with 'goto pc-1', but reality differs from verifier simulation in that we're actually able to trigger a hang due to hitting the 'goto pc-1' instructions.

That is the mildest possible manifestation of the bug. The verifier's dead-code elimination is only as sound as its jump prediction, and a bad jump prediction turns live code into an infinite loop.

The severe manifestation is what Manfred Paul demonstrated. The oss-security announcement by Steve Beattie, published the same day as the fix:

> Manfred Paul, as part of the ZDI pwn2own competition, demonstrated that a flaw existed in the bpf verifier for 32bit operations. [...] The result is that register bounds were improperly calculated, allowing out-of-bounds reads and writes to occur.

And the reachability, from the same announcement: "This bpf functionality is available to unprivileged users unless the `kernel.unprivileged_bpf_disabled` sysctl is set to 1." At the time, the default was 0.

## Why it happened

There are two distinct failures here, and only one of them is in the verifier.

**The arithmetic failure** is a masking operation applied to an interval rather than to a value. `umin & 0xffffffff` and `umax & 0xffffffff` are each well-defined; the interval between them is not the interval of possible low halves unless the interval doesn't cross a 2³² boundary. This is the same shape as a signed/unsigned truncation bug — a narrowing conversion applied to endpoints and assumed to commute with the range they define. It does not.

**The process failure** is more interesting, and Borkmann names it in the commit message:

> apparently `581738a681b6` got auto-selected by Sasha's ML system and misclassified as a fix, so it got sucked into v5.4 where it should never have landed.

`581738a681b6` was a precision improvement for BPF programs compiled with `-mcpu=v3`. It was never intended for a stable kernel. The kernel's automated stable-backport classifier — a machine-learning model that scans mainline commits looking for fixes their authors forgot to tag — decided it looked like a fix, and it was backported into the 5.4 long-term series, which is where a large fraction of the affected deployments came from. Per the oss-security announcement, the backport landed in 5.4-stable as commit `b4de258dede5`.

So the vulnerable window was substantially wider than the feature's actual audience: a feature nobody had asked for on 5.4 shipped on 5.4 anyway.

## Resolution

The chosen fix was **revert, not repair** — and the reasoning is spelled out for a stable-tree audience.

Borkmann first tried to repair it. He documents the attempt in the commit message: move the register into a temporary, run `coerce_reg_to_size(&tmp, 4)` on the temp to get a correctly-derived 32-bit range, and build the tnum range from that. Then he explains why he abandoned it:

> However, above new `__reg_bound_offset32()` has no effect on refining the knowledge of the register contents. Meaning, if the bounds in hi32 range mismatch we'll get the identity function [...] Likewise, if the bounds in hi32 range match, then we mask both bounds with `0xffffffff` [...] However, _prior_ called `__reg_bound_offset()` did already such intersection on the full reg and we therefore would only repeat the same operation on the lo32 part twice.

The corrected version does nothing the verifier wasn't already doing. So [`f2d67fec0b43`](https://github.com/torvalds/linux/commit/f2d67fec0b43edce8c416101cdc52e71145b5fef) ("bpf: Undo incorrect `__reg_bound_offset32` handling") deletes the helper and both pairs of call sites — a 19-line pure deletion — with an explicit stable-tree justification:

> Given this has no effect and the original commit had false assumptions, this patch reverts the code entirely which is also more straight forward for stable trees [...] A proper bounds refinement would need a significantly more complex approach which is currently being worked, but no stable material. Hence revert is best option for stable.

The commit message even shows the reverted verifier correctly rejecting Trosinenko's reproducer.

**A replacement implementation arrived in the same series.** [The three-patch posting](https://lore.kernel.org/all/20200330160324.15259-1-daniel@iogearbox.net/) to `bpf@vger.kernel.org` on March 30, 2020 was Borkmann's revert plus two patches by **Jann Horn**. Horn's [`604dca5e3af1`](https://github.com/torvalds/linux/commit/604dca5e3af1db98bd123b7bfc02b017af99e3a0) ("bpf: Fix tnum constraints for 32-bit comparisons") diagnoses the original defect in one sentence:

> However, the implementation from `581738a681b6` didn't compute the tnum constraint based on the fixed operand, but instead derives it from the arithmetic-range-based tracking.

and replaces it with `set_upper_bound()` / `set_lower_bound()` helpers that build the tnum range from the comparison's actual constant operand rather than from the register's existing numeric bounds. His second patch — 3/3 in the series — collapsed `reg_set_min_max_inv()` into `reg_set_min_max()` with the opcode flipped, on the grounds that the asymmetry made sense for classic BPF and not for eBPF.

Alexei Starovoitov's entire public reply to the series:

> Applied. Thanks

**And then the fix was itself replaced, within the same merge window — by the work Borkmann's revert had already footnoted as "currently being worked."** John Fastabend's [`3f50f132d840`](https://github.com/torvalds/linux/commit/3f50f132d8400e129fc9eb68b5020167ef80a244) ("bpf: Verifier, do explicit ALU32 bounds tracking") was authored the same day and landed in the same release, v5.7-rc1. It deletes Horn's `set_upper_bound()`/`set_lower_bound()` and abandons the tnum-abuse approach entirely, giving every register a genuine second set of 32-bit bounds (`s32_min_value`, `s32_max_value`, `u32_min_value`, `u32_max_value`) instead of encoding 32-bit knowledge into the tnum. This design got a real review: on [v1](https://lore.kernel.org/all/158507130343.15666.8018068546764556975.stgit@john-Precision-5820-Tower/), Starovoitov caught a genuine correctness bug in the sign-extension logic for negative 32-bit bounds — "looks like above will not be correct for negative `s32_min`/`max`" — which Fastabend fixed before [v2](https://lore.kernel.org/all/158560409224.10843.3588655801186916301.stgit@john-Precision-5820-Tower/) merged.

That is the right design, and it is also the commit named in the `Fixes:` tags of [CVE-2021-3490](alu32-bitwise-bounds.md) and [CVE-2021-31440](alu32-unsigned-bounds.md) a year later. The direct lineage runs: a precision improvement → a CVE → a revert plus a proper implementation → a better proper implementation → two more CVEs.

## What it taught us

**Automated stable-backport selection changes who is exposed to a feature's bugs.** `581738a681b6` was a correct-enough optimization for a narrow audience: people compiling BPF with `-mcpu=v3` on a recent kernel. Classifying it as a fix put it in front of everyone running 5.4. The classifier's error was not in judging the patch's quality; it was in judging its *category*, and category is what determines the blast radius.

**"It only makes the verifier smarter" is a security claim.** Precision improvements in a verifier are not neutral. Every additional inference the verifier draws is an additional opportunity to draw a wrong one, and a wrong inference in a safety checker is a bypass. Reviewing precision patches with the rigor reserved for security patches is the lesson; it took a Pwn2Own demo to make it stick.

**Reverting is a legitimate fix, and sometimes the only stable-appropriate one.** Borkmann had a working repair in hand and rejected it, on the grounds that it added complexity for zero information gain and that the real solution was too invasive for stable. That is a maintainer explicitly separating "what should the code be" from "what should ship to users on 5.4 today" — and the commit message is unusually good about showing its work on both.

**Masking is not a range operation.** `[a & M, b & M]` is the range of low bits only when `a` and `b` share high bits. Anywhere a narrowing conversion is applied to the endpoints of an interval, that precondition needs to be checked explicitly.

!!! warning "Pattern to watch for"
    Two things to grep for. First, `min & MASK` / `max & MASK` pairs (or `(u32)`, `(s32)`, `(u16)` casts of range endpoints) where the result is used as a range — valid only when the discarded high bits are provably equal on both endpoints. Second, in your own subsystem's stable branches, look for backported commits whose upstream subject line reads like a feature or an optimization rather than a fix; automated selection is not infallible, and a feature on a long-term branch has an audience it was never reviewed against.

## See also

- [BPF Verifier](../bpf-verifier.md) — tnums, register bounds, and the dead-code elimination pass that turned this bug into a hang
- [ALU32 Bitwise Bounds Tracking](alu32-bitwise-bounds.md) — a CVE in `3f50f132d840`, the design that replaced this one's fix
- [The 32-Bit Unsigned Bounds Propagation Bug](alu32-unsigned-bounds.md) — the other CVE in that replacement
- [Unprivileged BPF Off by Default](unprivileged-bpf-off.md) — the default this bug depended on, and how it changed a year later
- [Sign Extension in `check_alu_op()`](sign-extension.md) — the same class of bug (verifier's model diverging from run-time value) a little over two years earlier

## External references

- [NVD: CVE-2020-8835](https://nvd.nist.gov/vuln/detail/CVE-2020-8835) — CVSS 7.8 HIGH, published April 2, 2020; names the affected versions and the ZDI case number
- [GitHub mirror: f2d67fec0b43](https://github.com/torvalds/linux/commit/f2d67fec0b43edce8c416101cdc52e71145b5fef) — "bpf: Undo incorrect `__reg_bound_offset32` handling", the revert, with the full reproducer walkthrough and the rejected repair
- [GitHub mirror: 581738a681b6](https://github.com/torvalds/linux/commit/581738a681b6faae5725c2555439189ca81c0f1f) — "bpf: Provide better register bounds after jmp32 instructions" (v5.5), the introducing commit
- [lore.kernel.org: bpf: provide better register bounds after jmp32 instructions](https://lore.kernel.org/all/20191121045924.v77wb5zzfliln7ql@ast-mbp.dhcp.thefacebook.com/) — the November 2019 review thread; the masking premise itself was never challenged
- [GitHub mirror: 604dca5e3af1](https://github.com/torvalds/linux/commit/604dca5e3af1db98bd123b7bfc02b017af99e3a0) — "bpf: Fix tnum constraints for 32-bit comparisons", Jann Horn's replacement implementation from the same series
- [GitHub mirror: 3f50f132d840](https://github.com/torvalds/linux/commit/3f50f132d8400e129fc9eb68b5020167ef80a244) — "bpf: Verifier, do explicit ALU32 bounds tracking", the design that superseded both, in the same release
- [lore.kernel.org: ALU32 bounds tracking support (v1)](https://lore.kernel.org/all/158507130343.15666.8018068546764556975.stgit@john-Precision-5820-Tower/) — where Starovoitov caught a real sign-extension bug before the design merged
- [lore.kernel.org: `[PATCH bpf-next 0/3] Fix __reg_bound_offset32 handling`](https://lore.kernel.org/all/20200330160324.15259-1-daniel@iogearbox.net/) — the three-patch thread and Starovoitov's two-word reply
- [oss-security: CVE-2020-8835](https://www.openwall.com/lists/oss-security/2020/03/30/3) — Steve Beattie's announcement, March 30, 2020; the Pwn2Own attribution, the 5.4-stable backport hash, and the sysctl reachability note
