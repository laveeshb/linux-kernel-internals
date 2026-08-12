# Spectre in the BPF Verifier

> CVE-2021-33624 — the verifier only walks paths that can actually execute, so it never saw the path the branch predictor would take

**Disclosed:** June 2021 (NVD record published June 23, 2021) &nbsp;·&nbsp; **Reported by:** Adam Morrison and Ofek Kirzner, and independently Benedict Schlueter and Piotr Krysiuk (per the fix commit's `Reported-by:` tags) &nbsp;·&nbsp; **CVSS:** 4.7 MEDIUM (`CVSS:3.1/AV:L/AC:H/PR:L/UI:N/S:U/C:H/I:N/A:N`, NVD primary) &nbsp;·&nbsp; **Fixed in:** [`9183671af6db`](https://github.com/torvalds/linux/commit/9183671af6dbf60a1219371d4ed73e23f43b49db), mainline v5.13-rc7; stable 5.12.13 and 5.10.46 &nbsp;·&nbsp; **Exploit tool:** multiple proofs-of-concept were sent privately to `security@kernel.org`; NVD's reference list tags a public oss-security post as `Exploit` and links a public PoC repository. No Exploit-DB entry &nbsp;·&nbsp; **Actively exploited:** no confirmed cases (not on CISA KEV)

*Part of [War Stories: BPF Verifier Bugs and CVEs](../war-stories.md).*

## Before state

The BPF verifier's job is to prove, before a program is allowed to run, that it cannot touch memory it shouldn't. It does that by [abstract interpretation](../bpf-verifier.md): walking every control-flow path the program could take and tracking, per register, what the value could be on that path.

Spectre broke the premise underneath that. In January 2018, Alexei Starovoitov's [`b2157399cc98`](https://github.com/torvalds/linux/commit/b2157399cc9898260d6031c5bfe45fe137c1fbe7) ("bpf: prevent out-of-bounds speculation", v4.15-rc8) opened with the problem in two sentences:

> Under speculation, CPUs may mis-predict branches in bounds checks. Thus, memory accesses under a bounds check may be speculated even if the bounds check fails, providing a primitive for building a side channel.

That patch's answer was masking. For array maps created by an unprivileged process, the allocation is rounded up to a power of two and an `index_mask` is stored alongside it; every index used to compute an element address is ANDed with that mask, in `array_map_lookup_elem()`, in the instruction sequence emitted by `array_map_gen_lookup()`, and in the update paths:

```c
/* kernel/bpf/arraymap.c, after b2157399cc98 */
return array->value + array->elem_size * (index & array->index_mask);
```

`bpf_tail_call()` got the same treatment, patched by the verifier into an explicit `if (index >= max_entries) goto out; index &= array->index_mask;` sequence so that every JIT inherited the mask without each one having to be touched. The commit states plainly what it does and does not cover: *"That fixes bpf side of 'Variant 1: bounds check bypass (CVE-2017-5753)' on all architectures with and without JIT."*

That is: it fixes the *array index* shape of Spectre v1. It says nothing about the verifier's own model of which code is reachable.

## The trigger

Three and a half years later, that gap was the bug.

The verifier enumerates only paths that are reachable in the architectural machine. If it can prove a branch is always taken, it follows the taken side and discards the other. Under speculation, the CPU may execute the discarded side anyway.

Daniel Borkmann's fix commit opens with a six-instruction program that makes this concrete:

```
// r0 = pointer to a map array entry
// r6 = pointer to readable stack slot
// r9 = scalar controlled by attacker
1: r0 = *(u64 *)(r0) // cache miss
2: if r0 != 0x0 goto line 4
3: r6 = r9
4: if r0 != 0x1 goto line 6
5: r9 = *(u8 *)(r6)
6: // leak r9
```

Line 3 runs only if `r0 == 0`. Line 5 runs only if `r0 == 1`. The two are mutually exclusive, so no real execution can assign the attacker-controlled scalar into `r6` *and then* dereference it. The verifier walks both paths, finds no path containing both, and accepts the program.

The catch is line 1: a load engineered to miss cache. Rather than stall, the CPU predicts both branches and runs ahead — and if it predicts fall-through for both, it speculatively executes exactly the pair of instructions the verifier proved could never co-occur.

## Observed behavior

Mistraining two mutually exclusive branches sounds impossible, and the commit message addresses that head-on. Branch prediction is not value-based; it is history-based, keyed by a hash of the branch address into the CPU's pattern history table (PHT). So the attacker trains *different, non-exclusive* branches in user space, placed at addresses that collide with the BPF program's branches in the PHT:

> A non-privileged attacker could simply brute force such collisions in the PHT until observing the attack succeeding.

The commit then documents a second, more reliable construction that avoids brute-forcing PHT collisions entirely: a ~190-instruction program with a "training/attack phase" selector loaded from a control map, a long chain of dummy conditional jumps to separate the interesting branch from the current execution flow, and a slow (cache-missing) load that is masked down to a known zero for the verifier (`r3 &= 1; r3 &= 2;`) while still carrying the real load's latency dependency at run time.

The impact is disclosure, not corruption. As LWN's [Spectre revisits BPF](https://lwn.net/Articles/860597/) (Jonathan Corbet, June 24, 2021) put it, summarizing the advisory:

> These attacks can read out any memory in the kernel's address space; given that all of physical memory is contained therein, there are no real limits to what can be exfiltrated.

Corbet also noted the thing that makes BPF a uniquely attractive Spectre target: most speculative-execution attacks require finding a suitable gadget already present in the kernel binary, but "BPF exists to enable the loading of code from user space that runs within the kernel context; that allows attackers to craft their own code fragments and avoid the tedious task of combing through the kernel code."

Per LWN, multiple proofs-of-concept were sent to `security@kernel.org` when the problem was reported, and some of them did not require the branch-predictor training step at all.

## Why it happened

The verifier's soundness argument has always been about the architectural machine: *for every execution the ISA permits, the program is safe*. Speculation adds executions the ISA does not permit.

`b2157399cc98` had already conceded that point — but only for one shape of it. Masking an array index defends against a bounds check that the CPU speculates past. It does nothing about a *path* the CPU speculates into, because the verifier had already discarded that path as unreachable before any masking logic could apply.

Put differently: the 2018 fix hardened the values the verifier tracked. The 2021 bug was in which paths the verifier tracked at all.

There is a second, quieter contributing factor visible in the same era's patches. Speculation defenses in BPF are bolted on as a series of specific countermeasures — index masking ([`b2157399cc98`](https://github.com/torvalds/linux/commit/b2157399cc9898260d6031c5bfe45fe137c1fbe7)), pointer-arithmetic sanitation, and, a month before this fix, [`801c6058d14a`](https://github.com/torvalds/linux/commit/801c6058d14a82179a7ee17a4b532cac6fad067f) ("bpf: Fix leakage of uninitialized bpf stack under speculation", also reported by Piotr Krysiuk), which closed a window where speculative pointer arithmetic could walk intermediate offsets and read the 512-byte BPF stack before the program had written it. Each is correct; none of them is a general argument, so each new shape of the attack needs a new countermeasure.

## Resolution

The fix inverts the verifier's handling of provably-untaken branches. Instead of discarding them, it pushes them onto the verification stack, explicitly marked as speculative:

```c
/* kernel/bpf/verifier.c, added by 9183671af6db */
static struct bpf_verifier_state *
sanitize_speculative_path(struct bpf_verifier_env *env,
			  const struct bpf_insn *insn,
			  u32 next_idx, u32 curr_idx)
{
	struct bpf_verifier_state *branch;
	struct bpf_reg_state *regs;

	branch = push_stack(env, next_idx, curr_idx, true);
	if (branch && insn) {
		regs = branch->frame[branch->curframe]->regs;
		if (BPF_SRC(insn->code) == BPF_K) {
			mark_reg_unknown(env, regs, insn->dst_reg);
		} else if (BPF_SRC(insn->code) == BPF_X) {
			mark_reg_unknown(env, regs, insn->dst_reg);
			mark_reg_unknown(env, regs, insn->src_reg);
		}
	}
	return branch;
}
```

In `check_cond_jmp_op()`, both the `pred == 1` and `pred == 0` cases now call it — gated on `!env->bypass_spec_v1`, so privileged loaders that already opt out of speculative analysis pay nothing. The registers involved in the condition are marked unknown on the speculative branch, because no assumption about their contents survives a mispredict.

The commit explains why the branch is pushed rather than merely rejected outright: so that dead-code elimination can still sanitize those instructions with `jmp-1`s afterwards, and so that paths walked in the non-speculative domain are not pruned by earlier walks of the speculative domain.

**The commit also documents the alternative that was considered and rejected**, which is unusually candid for a security fix. The other option was to record a `BPF_JMP_TAKEN` state plus a direction encoding (always-goto, always-fall-through, unknown) in `aux->alu_state`, and reject programs that mix directions — which would have rejected ordinary constructs like `if (...) { x = 0; } else { x = 1; }` followed by `if (x == 1)`. Borkmann lists two downsides: valid programs doing no pointer arithmetic would be broken, and path pruning would have to be disabled for unprivileged programs. Pushing the speculative branch avoids both.

Corbet's assessment of the changelog, in the LWN writeup: *"the changelog for this patch is an outstanding example of how to document a vulnerability and its fix; it's worth reading in full."*

The cost is accepted openly. LWN:

> This change has the potential to block the loading of correct programs that could be run before, though it is hard to imagine real-world, non-malicious code that would include this kind of pattern. It will, of course, slow the verification process to force it to examine paths that cannot occur in normal program execution, but that's the speculative world we live in.

The fix reached mainline in v5.13-rc7 and, per LWN, the 5.12.13 and 5.10.46 stable updates — but not, at the time of writing of that article, any earlier stable series.

## What it taught us

**A soundness proof is only sound in the machine model it assumes.** The verifier proves properties about a machine that executes instructions in program order according to the ISA. Real CPUs are not that machine, and every place the verifier says "this cannot happen" is a place where the difference between the two machines becomes an attack surface. Path reachability turned out to be one; it is unlikely to be the last.

**Point mitigations do not compose into a guarantee.** Index masking, pointer-arithmetic sanitation, and uninitialized-stack sanitation are each correct fixes for a specific speculative shape. None of them implies the next one. The BPF subsystem accumulated three separate Spectre countermeasures between 2018 and 2021 and still needed a fourth.

**Being able to load attacker-authored code into the kernel changes the economics of speculative attacks.** Ordinary Spectre gadget-hunting is a search problem. With unprivileged BPF, the attacker writes the gadget. That asymmetry is the reason the [unprivileged-BPF-off-by-default](unprivileged-bpf-off.md) knob landed the same month, and the reason CVSS's 4.7 MEDIUM — capped by `AC:H` and `C:H/I:N/A:N` — understates what this bug is worth to someone who already has local code execution.

!!! warning "Pattern to watch for"
    Any static analysis that *prunes* branches it can prove unreachable is making a claim about the architectural machine, not the speculative one. When you find such a pruning step in security-relevant code — a verifier, a JIT, a sandbox policy compiler — ask what happens if that branch executes anyway. Also audit for the inverse of the 2018 fix: countermeasures that harden *values* (masking, clamping, saturation) do nothing about a *path* the analyzer never explored, and vice versa.

## See also

- [BPF Verifier](../bpf-verifier.md) — path exploration, register state tracking, and dead-code elimination, all of which this bug lives inside
- [Unprivileged BPF Off by Default](unprivileged-bpf-off.md) — the hardening response that landed in the same release cycle
- [ALU32 Bitwise Bounds Tracking](alu32-bitwise-bounds.md) — a non-speculative verifier bug disclosed six weeks earlier
- [Kernel Hardening](../../security/kernel-hardening.md) — the broader mitigation landscape this sits in
- [BPF Maps](../bpf-maps.md) — array maps, whose index handling the 2018 masking fix rewrote

## External references

- [NVD: CVE-2021-33624](https://nvd.nist.gov/vuln/detail/CVE-2021-33624) — CVSS 4.7 MEDIUM (`CVSS:3.1/AV:L/AC:H/PR:L/UI:N/S:U/C:H/I:N/A:N`), published June 23, 2021
- [GitHub mirror: 9183671af6db](https://github.com/torvalds/linux/commit/9183671af6dbf60a1219371d4ed73e23f43b49db) — "bpf: Fix leakage under speculation on mispredicted branches", the fix, including both crafted programs and the rejected alternative design
- [GitHub mirror: b2157399cc98](https://github.com/torvalds/linux/commit/b2157399cc9898260d6031c5bfe45fe137c1fbe7) — "bpf: prevent out-of-bounds speculation" (v4.15-rc8), the 2018 index-masking fix for the BPF side of Spectre v1
- [GitHub mirror: 801c6058d14a](https://github.com/torvalds/linux/commit/801c6058d14a82179a7ee17a4b532cac6fad067f) — "bpf: Fix leakage of uninitialized bpf stack under speculation" (April 2021), the adjacent speculative-leak fix
- [LWN: Spectre revisits BPF](https://lwn.net/Articles/860597/) — Jonathan Corbet, June 24, 2021; the walkthrough of the vulnerability, the fix, and its cost
- [NVD: CVE-2017-5753](https://nvd.nist.gov/vuln/detail/CVE-2017-5753) — Spectre Variant 1, the hardware vulnerability the 2018 BPF masking patch addressed
- [CISA: Known Exploited Vulnerabilities Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) — does not list CVE-2021-33624
