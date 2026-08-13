# The Nested-VMX Refactor That Forgot One Field on the Error Path

> CVE-2018-16882 — removing a trivial wrapper function restructured a posted-interrupt setup path around an early return on failure, and that early return skipped resetting a pointer that used to be reset unconditionally on every call, dangling straight into a later use-after-free

Disclosed
:   December 19, 2018 (CVE request posted to oss-security)

Reported by
:   Cfir Cohen, Google

CVSS
:   8.8 HIGH (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H`)

Bug present since
:   commit `5e2f30b756a37`, August 2017

Fixed in
:   commit `c2dd5146e9fe1`, mainline Linux 4.20 (December 23, 2018); backported to 4.14.91 and 4.19.13, both December 29, 2018

Exploit tool
:   working reproduction steps published in the fix's own commit message; no separate public exploit tool

Actively exploited
:   no confirmed cases (not on CISA KEV)

*Part of [War Stories: Virtualization (KVM) Bugs and Escapes](../war-stories.md).*

## Before state

In nested virtualization, L0 (the real hypervisor) runs L1 (a guest that is itself a hypervisor), which in turn runs L2 (L1's own guest). L1 never touches real VMX hardware — L0 intercepts L1's VMX instructions and shadows L1's intended VMCS state as `vmcs12`, then builds the actual hardware-loaded VMCS (`vmcs02`) by merging `vmcs12` with L0's own required controls. Posted interrupts are a hardware feature letting a physical CPU deliver an interrupt to a running vCPU without forcing a VM exit, via a small in-memory posted-interrupt descriptor. For a nested L2 guest, L0 has to track *L1's* posted-interrupt descriptor for L2 — a guest-physical address L1 specifies in `vmcs12->posted_intr_desc_addr` — which means translating that GPA to a real host page, pinning it, and `kmap()`-ing it to a kernel pointer L0 can dereference directly: `vmx->nested.pi_desc`.

`nested_get_vmcs12_pages()` does this translation on every nested VM-entry setup, and has to release the *previous* mapping first if one is cached from an earlier call.

## The trigger

`5e2f30b756a37` ("KVM: nVMX: get rid of nested_get_page()") removed a thin wrapper function and inlined its replacement — cosmetically a pure cleanup. But the removal restructured the posted-interrupt block's control flow along the way. Before the change, `vmx->nested.pi_desc_page` and `vmx->nested.pi_desc` were unconditionally reassigned on every call — a failed lookup produced `NULL` in both, since the assignment happened regardless of success. After the change, the code was rewritten around an early return on failure: `page = kvm_vcpu_gpa_to_page(...); if (is_error_page(page)) return;` — with the field assignments moved *after* that check. On failure, the function now returns without touching `pi_desc_page` or `pi_desc` at all, leaving whatever value was cached from a previous, successful call. The "shouldn't happen" cleanup block at the top of the function does reset `pi_desc_page` to `NULL` when releasing a stale page — but it never reset `pi_desc`, which still points into the page that was just `kunmap()`-ed and released.

## Observed behavior

The fix's own commit message documents the exact reproduction its author used: call `vmlaunch` with a valid posted-interrupt descriptor address but an invalid `MSR_EFER`, so `nested_get_vmcs12_pages()` caches the mapped `pi_desc_page`/`pi_desc` before the whole vmlaunch fails on the invalid EFER later in validation. Call `vmlaunch` again, this time with a valid EFER but a deliberately invalid `posted_intr_desc_addr` — this trips the "shouldn't happen" block, which unmaps and releases the previously-cached page and resets `pi_desc_page` to `NULL`, but the new address lookup then fails too, and the function returns early without ever touching `pi_desc`. At this point `vmx->nested.pi_desc` is a dangling pointer into freed memory, and the hardware VMCS field `POSTED_INTR_DESC_ADDR` in L0's own VMCS still points at the released physical page — but nothing has failed loudly, so `vmlaunch` proceeds. Issue an interprocessor interrupt from L2 guest code, and `vmx_complete_nested_posted_interrupt()` calls `pi_test_and_clear_on(vmx->nested.pi_desc)`, which directly dereferences the dangling pointer — a guest-triggerable use-after-free in the host kernel, reachable whenever nested virtualization and APIC virtualization are both enabled and the host CPU supports posted interrupts.

## Why it happened

The wrapper-removal commit's diff reads, line by line, like an unremarkable cleanup — a helper function inlined, explicit error checks added at each call site instead of relying on a `NULL` return. Nothing in the diff looks like a state-management change. But restructuring "always assign, sometimes to a null value" into "assign only on the success path, return early otherwise" quietly removed an implicit reset-on-failure behavior the surrounding code depended on — for one of the two fields the block was responsible for, not both. The refactor's author had every reason to believe this was mechanical; the bug is in what the old code's unconditional-assignment structure was silently guaranteeing that the new early-return structure no longer did.

## Resolution

`c2dd5146e9fe1` ("KVM: Fix UAF in nested posted interrupt processing") adds exactly the two lines the "shouldn't happen" block was missing: reset `vmx->nested.pi_desc` to `NULL` alongside `pi_desc_page`, and reset the live hardware VMCS field `POSTED_INTR_DESC_ADDR` to an invalid sentinel (`-1ull`) so neither the software pointer nor the hardware posted-interrupt mechanism can reference the released page. Both software and hardware state are now made consistent at the exact point the stale mapping is torn down, rather than leaving one of the two half-updated.

## What it taught us

**A refactor that changes control flow — early return vs. fall-through — can silently drop an implicit invariant even when every individual line change looks correct in isolation.** The old code's "always assign, even to null" pattern was doing double duty: producing a usable value on success, and resetting stale state on failure, as a side effect of the same unconditional assignment. The new code split that into "assign only on success" without anyone re-deriving that the reset-on-failure behavior needed to be preserved explicitly.

**When a cleanup block is responsible for releasing multiple related pieces of state, resetting only some of them is worse than resetting none — it looks correct.** The "shouldn't happen" block *did* reset `pi_desc_page`. That partial correctness is exactly what made this bug hide in a code review: a reviewer scanning for "did the release get undone" sees the page reference cleared and moves on, without noticing the pointer derived from that page wasn't cleared alongside it.

!!! warning "Pattern to watch for"
    When two or more fields are always supposed to be consistent with each other (here: a page reference and a pointer mapped from that page, plus a hardware register mirroring the same address), any code path that resets one on error needs to reset all of them — and a refactor that changes *when* a reset happens (unconditional assignment vs. early return) needs to be checked against every invariant the old control flow was implicitly maintaining, not just the one the refactor's author had in mind.

## See also

- [Nested Virtualization](../nested-virt.md) — the L0/L1/L2 model, vmcs12/vmcs02 merge, and posted-interrupt tracking for nested guests
- [KVM Exit Handling](../kvm-exits.md) — interrupt injection and the posted-interrupt delivery mechanism this bug corrupts
- [The PI-Futex Fixup That Had No Answer for a Permanent Fault](../../locking/war-stories/pi-futex-fixup-owner-uaf.md) — a closer structural parallel: an error path that left related state only partially reset, also leading to a use-after-free

## External references

- [git.kernel.org: c2dd5146e9fe1](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=c2dd5146e9fe1f22c77c1b011adf84eea0245806) — "KVM: Fix UAF in nested posted interrupt processing," the fix, with the full reproduction recipe in its commit message
- [git.kernel.org: 5e2f30b756a37](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=5e2f30b756a37bd80c5b0471d0e10d769ab2eb9a) — "KVM: nVMX: get rid of nested_get_page()," the refactor that introduced the gap
- [marc.info: the original patch submission](https://marc.info/?l=kvm&m=154514994222809&w=2) — Cfir Cohen's patch mail with the exact reproduction steps
- [LWN: Linux 4.19.13](https://lwn.net/Articles/775720/) and [Linux 4.14.91](https://lwn.net/Articles/775721/) — the stable releases (both December 29, 2018) that first shipped the backported fix
- [NVD: CVE-2018-16882](https://nvd.nist.gov/vuln/detail/CVE-2018-16882) — CVE record, CVSS 8.8 HIGH, published January 3, 2019
