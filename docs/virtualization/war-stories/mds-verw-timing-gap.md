# MDS: The Mitigation That Flushed the Buffers Too Early

> CVE-2018-12130 — KVM's original defense against Microarchitectural Data Sampling flushed CPU buffers with VERW several instructions before actually entering the guest, and every register spill and stack push in between was itself a memory access that could refill those buffers with fresh host data — a gap that sat unexamined for five years until a routine hardening pass closed it as a side effect

Disclosed
:   May 14, 2019 (coordinated multi-vendor disclosure, alongside three related CVEs)

CVSS
:   5.9 (CVSS 3.1, `AV:L/AC:H/PR:N/UI:N/S:C/C:H/I:N/A:N`)

Bug present since
:   commit `650b68a0622f9`, the original KVM MDS mitigation, March 2019

Fixed in
:   commit `43fb862de8f62`, mainline Linux 6.8 (February 2024) — five years after the original mitigation, and only explicitly identified as a fix for this specific gap in a follow-up commit in late 2025

Exploit tool
:   no public exploit tool; the gap was closed before any confirmed exploitation

Actively exploited
:   no confirmed cases (not on CISA KEV)

*Part of [War Stories: Virtualization (KVM) Bugs and Escapes](../war-stories.md).*

## Before state

MDS — Microarchitectural Data Sampling — covers a family of related CPU flaws (MSBDS/CVE-2018-12126, MFBDS/CVE-2018-12130, MLPDS/CVE-2018-12127, MDSUM/CVE-2019-11091) in which, per the kernel's own documentation, "processors write data into temporary microarchitectural structures (buffers)" during ordinary store, load, and L1-refill operations, and that data can be speculatively sampled by other code before it's overwritten. The `VERW` instruction, repurposed for this mitigation, clears those buffers as a side effect. The kernel's fix was to execute `VERW` at the two boundaries where trust changes: on return to userspace, and — the case that matters here — immediately before a VM entry, so a guest can't sample whatever host data was left in the buffers by the host code that ran just before it.

## The trigger

`650b68a0622f9` ("x86/kvm/vmx: Add MDS protection when L1D Flush is not active", March 2019) added the guest-entry VERW call as an ordinary C function invocation, `mds_clear_cpu_buffers()`, inside `__vmx_vcpu_run()` — several lines *before* the large inline `asm()` block that does the actual register save/restore and VMLAUNCH/VMRESUME. Between that call and the actual VM-entry instruction sat an unknown quantity of compiler-generated code: stack frame setup for the asm block's operands, register spills, and the asm block's own "store host registers" prologue — which, quite literally, pushes registers onto the stack. Every one of those is a memory write. And per the kernel's own description of the vulnerability class, a memory write is exactly the kind of operation that populates the microarchitectural fill buffers MDS targets.

## Observed behavior

The practical consequence: VERW cleans the buffers, and then several ordinary memory operations — a pushed `%rbp`, a spilled register, a return address — refill them with fresh host data, all before the CPU actually hands control to the guest. A guest exploiting MFBDS after that point would be sampling *newly*-buffered host data, not the pre-flush contents VERW was supposed to have cleared. Five years later, `43fb862de8f62` ("KVM/VMX: Move VERW closer to VMentry for MDS mitigation", February 2024) described the risk in exactly these terms: "After VERW, any memory access like register push onto stack may put host data in MDS affected CPU buffers. A guest can then use MDS to sample host data. Although likelihood of secrets surviving in registers at current VERW callsite is less, but it can't be ruled out." The fix moved the buffer-clear into the hand-written assembly stub itself, as a `CLEAR_CPU_BUFFERS` macro inserted right after the guest's RAX is loaded and immediately before the branch to VMLAUNCH or VMRESUME — with no further C-level calls, spills, or memory writes physically possible in between.

An even later commit, `e6ff1d61de51e` (November 2025, Sean Christopherson), reworking a related MMIO-specific mitigation, states the history plainly and puts a name on what had actually happened: "the flaw goes back to the introduction of the MDS mitigation. The MDS mitigation was inadvertently fixed by commit 43fb862de8f6 ... but previous kernels that flush CPU buffers in vmx_vcpu_enter_exit() are affected (though it's unlikely the flaw is meaningfully exploitable even older kernels)." The word "inadvertently" is doing real work there — the 2024 commit's authors were hardening the callsite against a *theoretical* concern they could articulate but hadn't traced back to the original 2019 design, and it took a third developer, over a year later, working on an adjacent piece of the same code, to recognize that the 2024 change had already closed a genuine, if likely low-severity, gap in the original fix.

## Why it happened

The original 2019 mitigation was written under real time pressure — MDS was one of four CVEs disclosed together, across a 23-commit series covering documentation, sysfs reporting, command-line controls, and mitigations for both userspace and KVM simultaneously. Placing the VERW call as an ordinary C function invocation was the natural, mechanically simplest way to add the mitigation to existing C code; nobody involved in that specific patch appears to have reasoned explicitly about exactly how many bytes of compiler-generated code separated that call from the real VM-entry instruction, or audited what those bytes actually did. The gap wasn't a rejected tradeoff — it was a question nobody in the room had asked yet, closed only when later work on a related mitigation (the 2024 MMIO Stale Data hardening) happened to move the same code for an unrelated, more conservative reason.

## Resolution

`43fb862de8f62` deletes the C-level `mds_clear_cpu_buffers()` call from `vmx_vcpu_enter_exit()` in `vmx.c` entirely, and inserts a `CLEAR_CPU_BUFFERS` macro — a raw, alternative-patched `VERW` — directly into the `__vmx_vcpu_run` assembly routine in `vmenter.S`, positioned as the last instruction before the branch that executes VMLAUNCH or VMRESUME. By that point every guest register is already loaded into its GPR, and nothing further touches memory before the CPU commits to entering the guest — closing the window entirely rather than merely narrowing it. `e6ff1d61de51e`, in late 2025, went further still: it moved the related MMIO Stale Data buffer-clear into the same assembly location via a shared `ALTERNATIVES_2` block, both consolidating the mitigations' code paths and, per its own commit message, fixing "a mostly-benign flaw where KVM wouldn't do any clearing/flushing" under one specific combination of mitigation settings — a second, smaller gap in the same neighborhood, found while cleaning up the first.

## What it taught us

**A security mitigation added under deadline pressure, correct in its stated goal, can still leave an unexamined gap in exactly how it's wired into the surrounding code.** The 2019 fix did add VERW at guest entry, as intended — it just didn't verify that nothing could touch memory between the flush and the entry it was protecting.

**A fix can close a real vulnerability nobody has named yet.** The 2024 commit's authors were hardening against a theoretical concern in their own reasoning, not consciously patching a five-year-old CVE — it took a third party, working on adjacent code over a year later, to recognize and document what had actually been fixed.

!!! warning "Pattern to watch for"
    When a security-critical instruction (a cache flush, a buffer clear, a permission check) needs to be "the last thing that happens" before a trust boundary is crossed, verify that placement at the assembly level, not just the C level — a compiler is free to insert spills, stack adjustments, and other memory traffic between a C statement and the machine instruction that logically follows it, and any of that traffic can undo the guarantee the security instruction was supposed to provide.

## See also

- [L1TF: When a Not-Present Page Table Entry Wasn't Not-Present Enough](l1tf-foreshadow-vmm.md) — a sibling speculative-execution mitigation in the same KVM VM-entry path, with its own SMT-sharing caveat
- [KVM Architecture](../kvm-arch.md) — VM entry/exit and the `vmlaunch`/`vmresume` boundary this mitigation protects
- [The rt_mutex Deadlock Detector's Atomic-Sleep Bug](../../locking/war-stories/rtmutex-deadlock-detector-atomic-sleep.md) — a comparable case of code placement, not logic, being the actual defect

## External references

- [GitHub mirror: 650b68a0622f9](https://github.com/torvalds/linux/commit/650b68a0622f933444a6d66936abb3103029413b) — "x86/kvm/vmx: Add MDS protection when L1D Flush is not active," the original 2019 mitigation
- [GitHub mirror: 43fb862de8f62](https://github.com/torvalds/linux/commit/43fb862de8f628c5db5e96831c915b9aebf62d33) — "KVM/VMX: Move VERW closer to VMentry for MDS mitigation," the 2024 fix
- [GitHub mirror: e6ff1d61de51e](https://github.com/torvalds/linux/commit/e6ff1d61de51ec5fe94c5fb79544a93f494104eb) — the 2025 commit that names the original flaw explicitly and closes a related gap
- [Kernel documentation: MDS - Microarchitectural Data Sampling](https://docs.kernel.org/admin-guide/hw-vuln/mds.html) — the kernel's own technical description of the MDS CVE family and the VERW-based mitigation
- [NVD: CVE-2018-12130](https://nvd.nist.gov/vuln/detail/CVE-2018-12130) — CVE record, CVSS 3.1 5.9, published May 30, 2019
