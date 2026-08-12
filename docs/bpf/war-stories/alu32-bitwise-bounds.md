# ALU32 Bitwise Bounds Tracking

> CVE-2021-3490 — a comment that checked a 32-bit condition and relied on a 64-bit guarantee

**Disclosed:** May 11, 2021 (oss-security) &nbsp;·&nbsp; **Reported by:** Manfred Paul (@_manfp) of the RedRocket CTF team, working with Trend Micro's Zero Day Initiative (ZDI-CAN-13590), and Thadeu Lima de Souza Cascardo of Canonical — both carried as `Reported-by:` on the fix &nbsp;·&nbsp; **CVSS:** 7.8 HIGH (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`, NVD primary); Ubuntu's secondary score is also 7.8, with a different vector (`AC:H`, `S:C`) &nbsp;·&nbsp; **Fixed in:** [`049c4e13714e`](https://github.com/torvalds/linux/commit/049c4e13714ecbca567b4d5f6d563f05d431c80e), mainline v5.13-rc4; stable 5.12.4, 5.11.21, 5.10.37 &nbsp;·&nbsp; **Exploit tool:** yes — NVD tags a public Packet Storm entry, "Linux eBPF ALU32 32-bit Invalid Bounds Tracking Local Privilege Escalation", as `Exploit`. No Exploit-DB entry &nbsp;·&nbsp; **Actively exploited:** no confirmed cases ([not on CISA KEV](https://nvd.nist.gov/vuln/detail/CVE-2021-3490))

*Part of [War Stories: BPF Verifier Bugs and CVEs](../war-stories.md).*

## Before state

After [`3f50f132d840`](https://github.com/torvalds/linux/commit/3f50f132d8400e129fc9eb68b5020167ef80a244) ("bpf: Verifier, do explicit ALU32 bounds tracking", v5.7-rc1), the verifier simulates the arithmetic and bitwise ALU operations twice: once over the 64-bit bounds, once over the separate 32-bit `{s,u}32_{min,max}_value` bounds. For the bitwise ops that means two parallel families of functions — `scalar_min_max_and()` / `scalar_min_max_or()` / `scalar_min_max_xor()`, and their `scalar32_` counterparts.

The 32-bit versions each opened with a shortcut. From `scalar32_min_max_and()`:

```c
	/* Assuming scalar64_min_max_and will be called so its safe
	 * to skip updating register for known 32-bit case.
	 */
	if (src_known && dst_known)
		return;
```

The reasoning: if both the source and destination subregisters are known constants, the operation's result is a known constant, and the 64-bit function that runs immediately afterwards will set the register to that constant — so the 32-bit function need not do anything.

A near-identical comment and the same early return appear in `scalar32_min_max_or()`. The `xor` variant is younger: [`2921c90d4718`](https://github.com/torvalds/linux/commit/2921c90d471889242c24cff529043afb378937fa) ("bpf: Fix a verifier failure with xor", v5.10-rc1) added `scalar32_min_max_xor()` months later, and it opens by copying the `or` variant's comment, adjusted only for the function name.

That commit's own review is where the CVE's exact precondition got examined and declared safe. Alexei Starovoitov [asked directly](https://lore.kernel.org/all/20200826015836.2rlfvhoznylkabp6@ast-mbp.dhcp.thefacebook.com/), quoting the same `if (src_known && dst_known) return;` line this page is about: "why? I've looked at `_and()` and `_or()` variants that do the same and couldn't quite remember why it's ok to do so." Song's [reply](https://lore.kernel.org/all/f2056e3c-e300-6fa0-8b8e-fa19ed5580bd@fb.com/) was candid, and unsure: "Yes, I copied what `_and()` and `_or()` did. What I thought is if both known, 64bit `scalar_min_max_xor()` handled this and did not go through the approximation below... John, could you confirm?" John Fastabend then [walked through the exact register state](https://lore.kernel.org/all/5f46dcd8c0156_50e8208f4@john-XPS-13-9370.notmuch/) this CVE would later exploit — a constant subregister inside a non-constant 64-bit register — and concluded it was fine, because the generic post-pass "will use the `var_off`, previously updated. The 32-bit bounds are then updated using this `var_off` so they are correct even if less precise than we might expect." He was describing `__update_reg32_bounds()`, the same tighten-only function this page's "The trigger" section explains — and he was wrong. That function can only tighten: it pulled the maximum down to the correct value and left the stale minimum standing, which is precisely the `u32_min_value=1, u32_max_value=0` state CVE-2021-3490 exploited. He did write the promised test — [`99d4def4d085`](https://github.com/torvalds/linux/commit/99d4def4d08507474b250dad6345d14715a4726b) ("bpf: Add AND verifier test case where 32bit and 64bit bounds differ") landed a month later with a "check known subreg with unknown reg" case in `verifier/and.c`. It asserted that the program loaded and returned 0, not that the resulting bounds were self-consistent, so it exercised the vulnerable path for seven months without detecting it.

## The trigger

The shortcut's premise does not survive contact with the function it defers to.

`src_known` and `dst_known` are computed with `tnum_subreg_is_const()` — they are statements about the **low 32 bits**. But `scalar_min_max_and()` only assigns a known constant when the **full 64-bit** source and destination are known. There is a gap between the two conditions, and any register that sits in it gets its 32-bit bounds left stale. The generic post-pass at the end of `adjust_scalar_min_max_vals()` (`__update_reg32_bounds()`) then reconciles them against `var_off` — but it can only tighten, never widen, so it pulls the maxima down to the correct value and leaves the stale minima behind.

The fix commit's example:

> consider a register R2 which has a tnum of `0xffffffff00000000`, meaning, lower 32 bits are known constant and in this case of value `0x00000001`. R2 is then and'ed with a register R3 which is a 64 bit known constant, here, `0x100000002`.

R2's low half is known (1). R3 is fully known. So `src_known && dst_known` holds and `scalar32_min_max_and()` returns immediately — but R2's high half is unknown, so `scalar_min_max_and()` declines to mark the register constant, and nothing updates the 32-bit bounds.

The verifier trace in the commit shows the wreckage:

```
9: (5f) r2 &= r3
10: R2_w=inv(id=0,...,var_off=(0x0; 0x100000000),
             s32_min_value=1,s32_max_value=0,
             u32_min_value=1,u32_max_value=0)
```

`u32_min_value=1` with `u32_max_value=0`. The correct answer is 0 for all four, since `0x1 & 0x2 == 0` in 32-bit space.

## Observed behavior

A register whose minimum exceeds its maximum describes an empty set — a state no real value can be in, which means every subsequent inference the verifier draws from it is unconstrained by reality.

The oss-security announcement by Cascardo, published May 11, 2021, states the consequence:

> Manfred Paul (@_manfp) of the RedRocket CTF team (@redrocket_ctf) working with Trend Micro's Zero Day Initiative discovered that this vulnerability could be turned into out-of-bounds reads and writes in the kernel.

NVD's description agrees and goes one step further: "which could be turned into out of bounds reads and writes in the Linux kernel and therefore, arbitrary code execution."

A working local-privilege-escalation exploit is public: NVD's reference list carries a Packet Storm entry titled "Linux eBPF ALU32 32-bit Invalid Bounds Tracking Local Privilege Escalation," tagged `Exploit`. As of CISA's KEV catalog there is no confirmed in-the-wild exploitation — the same gap between "weaponized" and "used" that runs through most of the [network stack's war stories](../../net/war-stories.md).

Cascardo's announcement includes one detail that materially limited blast radius: "There has been no backport to any upstream LTS kernel." That is about backports: 5.10 is itself a long-term series and carried the bug natively (hence the 5.10.37 fix above), but the `and`/`or` variants were introduced in 5.7-rc1 and the `xor` variant in 5.10-rc1, so the older 4.19 and 5.4 long-term series never received these commits at all.

## Why it happened

**A comment asserting an invariant is not an invariant.** "Assuming `scalar64_min_max_and` will be called so its safe to skip updating register for known 32-bit case" is a claim about a *different function's* behavior, written in this function, checked by nobody. It was very nearly true — for fully-known registers, which is the common case — and the case where it was false is a register that is constant in one half and unknown in the other, which is exactly the state a hostile program can construct on purpose.

**Two parallel implementations drift, and the drift is invisible per-file.** The fix commit names this directly: "Given `scalar32_min_max_*()` is intended to be designed as closely as possible to `scalar_min_max_*()`". The 32-bit family was written to mirror the 64-bit family; the mirroring was the design goal and also the failure mode, because "as closely as possible" is not "identically," and the difference lands in the precondition each one uses.

**Copying a comment copies its assumptions.** The `xor` variant did not exist when the bug was introduced. `2921c90d4718` was itself a bug fix — for a verifier failure that broke a BPF selftest under LLVM 11 and 12 — and in adding the missing 32-bit `xor` path it duplicated the delegation shortcut from its `and`/`or` neighbors, along with the flawed reasoning. That is why the fix carries **two** `Fixes:` tags:

```
Fixes: 3f50f132d840 ("bpf: Verifier, do explicit ALU32 bounds tracking")
Fixes: 2921c90d4718 ("bpf: Fix a verifier failure with xor")
```

Five months separate them, and the second one is a fix that propagated the first one's bug into a new call site.

## Resolution

[`049c4e13714e`](https://github.com/torvalds/linux/commit/049c4e13714ecbca567b4d5f6d563f05d431c80e) ("bpf: Fix alu32 const subreg bound tracking on bitwise operations", Daniel Borkmann) deletes the assumption instead of trying to make it true. The same change is applied to all three functions:

```diff
-	/* Assuming scalar64_min_max_and will be called so its safe
-	 * to skip updating register for known 32-bit case.
-	 */
-	if (src_known && dst_known)
+	if (src_known && dst_known) {
+		__mark_reg32_known(dst_reg, var32_off.value);
 		return;
+	}
```

Rather than defer to the 64-bit path, the 32-bit path now sets the 32-bit bounds itself. It can, because the answer is already sitting in a local: `var32_off` is `tnum_subreg(dst_reg->var_off)`, and as the commit notes, "This is possible given `var32_off` already holds the final value as `dst_reg->var_off` is updated before calling `scalar32_min_max_*()`." The correct value was available the whole time; the code just wasn't using it.

The patch carries `Reviewed-by: John Fastabend` and `Acked-by: Alexei Starovoitov`. This specific patch has no `Link:` trailer to a public posting — consistent with a report handled through a private channel and announced on oss-security once fixes shipped, the same pattern seen across the [security subsystem's war stories](../../security/war-stories.md). But the design question the fix answers *was* argued publicly, nine months earlier, in the `xor` commit's own review thread described above — the record just isn't attached to this commit.

The fix reached mainline in v5.13-rc4 and the 5.12.4, 5.11.21, and 5.10.37 stable releases.

## What it taught us

**Precondition mismatches between a caller and its delegate are a silent bug class.** This function checked a 32-bit condition and relied on a function that acts on a 64-bit condition. Neither is wrong in isolation. The bug lives entirely in the space between them, which no single-function review would surface — and which no test would catch either, unless someone thought to construct a register that is constant in one half and unknown in the other.

**"The other path handles it" needs to be checked, not assumed, every time the other path changes.** The comment was plausible enough to survive review in three separate functions, including a brand-new one added by a different author five months later.

**An impossible register state is a detectable invariant.** `u32_min_value > u32_max_value` cannot describe any real value. That inconsistency was visible in the verifier's own debug output the moment someone looked — and it is the kind of thing a cheap assertion over register state, run at every step of simulation, would have caught immediately regardless of which function introduced it.

!!! warning "Pattern to watch for"
    When you find two parallel implementations of the same logic over different widths, signedness, or representations — a 32-bit and a 64-bit path, a fast path and a slow path, a cached and an uncached variant — read the *early returns* first, not the bodies. Early returns are where one implementation delegates to the other, and delegation is where preconditions silently differ. Then check whether any downstream state can end up self-contradictory (`min > max`, `end < start`, `count > capacity`) and, if so, assert it rather than relying on all producers being correct.

## See also

- [BPF Verifier](../bpf-verifier.md) — register bounds tracking, tnums, and how ALU operations are simulated
- [The 32-Bit Unsigned Bounds Propagation Bug](alu32-unsigned-bounds.md) — the other 2021 CVE against the same introducing commit, reported by the same researcher and fixed two and a half weeks earlier
- [The jmp32 Bounds Regression](jmp32-bounds.md) — the 2020 CVE whose resolution produced `3f50f132d840`
- [Unprivileged BPF Off by Default](unprivileged-bpf-off.md) — posted the same day this CVE was announced
- [Security War Stories](../../security/war-stories.md) — where the same embargo-then-announce disclosure pattern shows up repeatedly

## External references

- [NVD: CVE-2021-3490](https://nvd.nist.gov/vuln/detail/CVE-2021-3490) — CVSS 7.8 HIGH, published June 4, 2021; the description names both introducing commits and all three stable releases
- [GitHub mirror: 049c4e13714e](https://github.com/torvalds/linux/commit/049c4e13714ecbca567b4d5f6d563f05d431c80e) — "bpf: Fix alu32 const subreg bound tracking on bitwise operations", the fix, with before/after verifier traces
- [GitHub mirror: 3f50f132d840](https://github.com/torvalds/linux/commit/3f50f132d8400e129fc9eb68b5020167ef80a244) — "bpf: Verifier, do explicit ALU32 bounds tracking" (v5.7-rc1), the first `Fixes:` target
- [GitHub mirror: 2921c90d4718](https://github.com/torvalds/linux/commit/2921c90d471889242c24cff529043afb378937fa) — "bpf: Fix a verifier failure with xor" (v5.10-rc1), the second `Fixes:` target, which copied the flawed shortcut into a new function
- [lore.kernel.org: bpf: fix a verifier failure with xor](https://lore.kernel.org/all/20200825064608.2017937-1-yhs@fb.com/) — the August 2020 review thread where the exact precondition CVE-2021-3490 exploits was examined and declared safe, nine months before the CVE
- [oss-security: CVE-2021-3490](https://www.openwall.com/lists/oss-security/2021/05/11/11) — Thadeu Lima de Souza Cascardo's announcement, May 11, 2021, crediting Manfred Paul and noting the introducing commits never reached the older LTS series
