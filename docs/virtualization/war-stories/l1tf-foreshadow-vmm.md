# L1TF: When a Not-Present Page Table Entry Wasn't Not-Present Enough

> CVE-2018-3646 — a terminal page fault on a not-present EPT entry still let the CPU speculatively forward whatever stale data happened to be sitting in the L1 data cache, and in a virtualized guest that cache is shared across every sibling hyperthread on the core, host and guests alike

Disclosed
:   August 14, 2018 (coordinated multi-vendor disclosure)

CVSS
:   5.6 (CVSS 3.1, `AV:L/AC:H/PR:L/UI:N/S:C/C:H/I:N/A:N`)

Bug present since
:   a hardware speculative-execution behavior, not introduced by any kernel change

Fixed in
:   the "l1tf-final" series, merged commit `958f338e96f87`, mainline Linux 4.19 (August 14, 2018)

Exploit tool
:   proof-of-concept demonstrated by the disclosing research teams; no public weaponized tool

Actively exploited
:   no confirmed cases (not on CISA KEV)

*Part of [War Stories: Virtualization (KVM) Bugs and Escapes](../war-stories.md).*

## Before state

L1TF is one of three related CVEs disclosed together under the umbrella "Foreshadow-NG" — CVE-2018-3615 for SGX enclaves, CVE-2018-3620 for the OS/SMM case, and CVE-2018-3646 for virtualization, all stemming from the same underlying CPU behavior. The kernel's own documentation states the mechanism precisely: "If an instruction accesses a virtual address for which the relevant page table entry (PTE) has the Present bit cleared or other reserved bits set, then speculative execution ignores the invalid PTE and loads the referenced data if it is present in the Level 1 Data Cache, as if the page referenced by the address bits in the PTE was still present and accessible." The instruction eventually raises a page fault when it retires — but by then, the speculatively-loaded data has already been made observable to other speculative instructions, opening a side-channel window.

## The trigger

For ordinary host-side attacks, this is a variant of the Meltdown family. For virtualization specifically, it's a different, worse problem: "the speculation bypasses the extended page table (EPT) protection mechanism" entirely. A guest can construct a not-present EPT entry whose stale physical-address bits point anywhere in host physical memory, and the CPU's speculative L1D lookup doesn't check whether that address belongs to the guest at all — it just serves whatever happens to be resident in L1D at that address. There is no permission check to bypass, because the hardware never gets far enough to consult one.

## Observed behavior

The multi-tenant angle is what makes this specifically dangerous for cloud hosting: sibling hyperthreads on the same physical core share the L1 data cache. The kernel documentation is explicit about the reach: "a malicious guest running on one Hyperthread can attack the data which is brought into the L1D by the context which runs on the sibling Hyperthread of the same physical core. This context can be host OS, host user space or a different guest." A malicious VM doesn't need a bug in the hypervisor to read another tenant's data — it needs only to share a physical core with that tenant at the right moment, something a cloud scheduler's ordinary vCPU placement can produce without any misconfiguration at all.

## Why it happened

This isn't a software defect in the traditional sense — the vulnerable behavior lives in the CPU's speculative-execution logic, present in the hardware regardless of what the kernel or hypervisor does. The kernel's mitigation options are all about closing the specific windows software controls: what's resident in L1D at the moment a guest can race a terminal fault against it, and whether a guest can ever share a core with a different security context while that window is open.

## Resolution

KVM's primary defense is an L1D cache flush at VM entry — wiping the cache clean of anything the *host* put there before the guest gets to run its next batch of speculative terminal-fault probes. The kernel ships two modes: `always` flushes on every VM entry for maximum protection at real cost (kernel documentation cites "performance degradation in the range of 1% to 50%" depending on VM-exit frequency and guest workload); the default, `cond`, skips the flush after VM exits whose intervening host code path has been audited not to expose secrets — though the documentation is careful to note that audited path "can [still] leak information about the address space layout of the hypervisor," a narrower but real residual leak. On top of the flush, `pte_inversion` unconditionally protects swapped-out host pages by inverting the physical address bits stored in a not-present PTE, so a terminal-fault probe against swap-related PTEs can't be steered at a chosen physical address — at the cost of capping usable swap to roughly 16TB.

Flushing alone does not solve the sibling-hyperthread case: "L1D flush does not prevent the SMT problem because the sibling thread will also bring back its data into the L1D which makes it attackable again," per the kernel documentation. The complete mitigation for multi-tenant hosts is disabling SMT (hyperthreading) outright, or scheduling so that sibling hyperthreads never run different security domains concurrently — a real capacity cost the kernel deliberately does not impose by default, leaving the tradeoff to the administrator via `l1tf=` and `kvm-intel.vmentry_l1d_flush=` command-line and module options. Nested virtualization gets its own careful handling too: when KVM is the bare-metal (L0) hypervisor running a nested hypervisor (L1) that in turn runs its own guest (L2), L0 flushes L1D on every switch between the nested hypervisor and the nested VM in both directions, while explicitly instructing the nested hypervisor not to *also* flush — avoiding redundant double-flushing on every nested transition.

## What it taught us

**A protection mechanism (EPT) can be completely bypassed by a CPU behavior that never consults it in the first place.** EPT's guarantee — a guest can only address memory the hypervisor mapped for it — assumes the CPU actually walks the EPT to enforce that boundary. Terminal-fault speculation short-circuits the walk entirely, so the protection's own correctness was never actually exercised on this path.

**Shared microarchitectural state (here, L1D between sibling hyperthreads) is a security boundary the software stack didn't design for, and closing it costs real capacity.** The kernel's own choice not to disable SMT by default is a deliberate acknowledgment that the fully-safe configuration and the fully-performant configuration are different configurations, and the tradeoff has to be made explicitly by whoever owns the isolation requirement.

!!! warning "Pattern to watch for"
    Whenever a hardware or software mechanism enforces isolation by consulting a permission structure (a page table, an EPT, a capability check), ask what happens on every path that *doesn't* reach that consultation — an error path, a speculative path, a fast path that assumes the check already happened elsewhere. A permission structure that's correct on every path that reaches it is not the same as a permission structure that's actually reached on every path that needs it.

## See also

- [Memory Virtualization](../kvm-memory.md) — EPT/NPT and the second-level address translation this bug bypasses
- [Nested Virtualization](../nested-virt.md) — the L0/L1/L2 model referenced in the nested-guest mitigation above
- [The MDS/KVM VERW Timing Gap](mds-verw-timing-gap.md) — a second speculative-execution hardware mitigation in KVM, whose own timing turned out to matter just as much as L1TF's flush-vs-not-flush choice

## External references

- [GitHub mirror: 958f338e96f87](https://github.com/torvalds/linux/commit/958f338e96f874a0d29442396d6adf9c1e17aa2d) — the merged "l1tf-final" series that landed the KVM mitigations in mainline
- [Kernel documentation: L1TF - L1 Terminal Fault](https://docs.kernel.org/admin-guide/hw-vuln/l1tf.html) — the kernel's own technical description and mitigation reference, source for every direct quote above
- [CERT/CC VU#982149](https://www.kb.cert.org/vuls/id/982149) — coordinated disclosure summary covering the full three-CVE Foreshadow-NG family
- [Foreshadow attack research](https://foreshadowattack.eu/) — two independent research teams that concurrently discovered and reported the flaw: KU Leuven (imec-DistriNet), and separately Technion, University of Michigan, and University of Adelaide/CSIRO's Data61
- [NVD: CVE-2018-3646](https://nvd.nist.gov/vuln/detail/CVE-2018-3646) — CVE record, CVSS 3.1 5.6, published August 14, 2018
