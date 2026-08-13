# War Stories: Virtualization (KVM) Bugs and Escapes

> Five incidents spanning the whole KVM/QEMU stack — a guest-to-host escape through a device nobody configured, two speculative-execution mitigations whose exact timing turned out to matter as much as their existence, a use-after-free born from a refactor that quietly dropped an implicit invariant, and a heap overflow born from the same kind of gap in an edge case nobody had reasoned about

Virtualization's trust boundary is the sharpest one this site covers: a guest is, by design, an untrusted tenant that the host must contain completely, across both the device-emulation layer (QEMU, in userspace) and the hypervisor kernel module (KVM) that gives it hardware-accelerated CPU access. The five incidents below span that entire boundary — one lives entirely in QEMU's userspace device model, two are host-kernel memory-corruption bugs (a use-after-free born from a refactor, and a heap overflow born from an edge case) that each dropped an implicit invariant, and two are CPU speculative-execution mitigations where getting the *mechanism* right wasn't enough — the exact placement and timing of the fix mattered just as much.

## Incidents

Ordered reverse chronologically by when the fix landed — newest first.

### [MDS: The Mitigation That Flushed the Buffers Too Early](war-stories/mds-verw-timing-gap.md)
**Original mitigation 2019, real fix Linux 6.8 (February 2024) · CVE-2018-12130**
KVM's original defense against Microarchitectural Data Sampling flushed CPU buffers several instructions before actually entering the guest — and every register spill and stack push in between could refill those buffers with fresh host data. The gap sat unexamined for five years until a routine hardening pass closed it as a side effect.

### [vhost: The Dirty-Log Counter That Forgot Zero-Length Descriptors](war-stories/vhost-migration-log-overflow.md)
**Linux 5.3 (September 2019) · CVE-2019-14835**
Live-migration dirty-page logging assumed one log entry per descriptor could never outrun the descriptor count itself — an invariant a single guest-supplied zero-length descriptor could break, turning a routine migration into a guest-controlled kernel heap overflow.

### [The Nested-VMX Refactor That Forgot One Field on the Error Path](war-stories/nested-vmx-posted-interrupt-uaf.md)
**Linux 4.20 (December 2018) · CVE-2018-16882**
Removing a trivial wrapper function restructured a posted-interrupt setup path around an early return on failure — and that early return skipped resetting a pointer that used to be reset unconditionally on every call, dangling straight into a later use-after-free.

### [L1TF: When a Not-Present Page Table Entry Wasn't Not-Present Enough](war-stories/l1tf-foreshadow-vmm.md)
**Linux 4.19 (August 2018) · CVE-2018-3646**
A terminal page fault on a not-present EPT entry still let the CPU speculatively forward stale L1 data-cache contents — and in a virtualized guest, that cache is shared across every sibling hyperthread on the core, host and guests alike.

### [VENOM: The Floppy Controller Nobody Turned Off](war-stories/venom-fdc-overflow.md)
**QEMU, May 2015 · CVE-2015-3456**
QEMU's floppy disk controller emulation is instantiated for every default x86 machine type whether or not a guest has a floppy drive configured, and its command FIFO had no bounds check at all — a guest that never touched a floppy could still overflow it straight into the host's heap.

## Common threads

| Pattern | MDS timing gap | vhost log overflow | Nested-VMX UAF | L1TF | VENOM |
|---------|:---:|:---:|:---:|:---:|:---:|
| Lives in QEMU userspace, not the Linux kernel | No | No | No | No | Yes |
| Root cause: an implicit invariant a refactor or edge case quietly broke | No | Yes | Yes | — | Yes |
| Root cause: a correct mechanism placed at the wrong point in the execution path | Yes | No | No | Partial (SMT sharing, not placement) | No |
| Guest-to-host memory corruption (not just information disclosure) | No | Yes | Yes (UAF) | No (side channel only) | Yes |
| Fix required understanding hardware microarchitecture, not just software logic | Yes | No | No | Yes | No |
| CISA KEV-listed | No | No | No | No | No |
| Years between introduction and (eventual, full) fix | 5 (2019→2024) | 9 (2010→2019) | 1.3 (2017→2018) | N/A (hardware behavior) | 12+ (code dated 2003 at latest→2015) |

**Three of the five are the same shape of mistake: an invariant that held by construction, until a refactor or an edge case broke the thing nobody was checking directly.** The nested-VMX UAF lost an implicit reset-on-failure behavior when a wrapper-removal refactor changed unconditional assignment into an early return. The vhost overflow lost the "log_num tracks in_num" invariant to a completely ordinary, spec-legal zero-length descriptor nobody had reasoned about. VENOM is the same pattern one layer down, at the device-emulation level: buffer-access code trusted command handlers to reset an index that two of them, each independently reasonable on its own terms, didn't.

**MDS and L1TF are both speculative-execution mitigations where getting the concept right wasn't the hard part — getting the exact mechanics right was.** L1TF's flush-on-VM-entry doesn't help against a sibling hyperthread sharing the same physical core; the kernel had to add SMT-disable as a separate, costlier lever for the cases that actually need it. MDS's VERW-based flush was conceptually correct from day one in 2019, but its literal position in the compiled code left a window where ordinary memory writes could undo the flush before the guest ever ran — a bug in *placement*, not in the mitigation's logic, that took five years to actually close, and nearly two years longer before anyone recognized what the closing commit had actually fixed.

**VENOM is the only incident here that isn't a Linux kernel bug at all.** It's included because the guest-facing trust boundary this site documents doesn't stop at KVM's kernel module — QEMU is the other half of the stack every KVM guest actually runs against, and a guest-to-host escape through QEMU's device emulation is exactly as real a break of the virtualization boundary as a bug in KVM itself.

## See also

- [KVM Architecture](kvm-arch.md) — the `/dev/kvm` API and QEMU's role as the userspace half of the stack
- [Nested Virtualization](nested-virt.md) — L0/L1/L2, vmcs12/vmcs02, the model behind the posted-interrupt UAF
- [KVM Live Migration](live-migration.md) — dirty-page logging, the feature whose logging path the vhost bug lives in
- [Locking War Stories](../locking/war-stories.md) and [VFS War Stories](../vfs/war-stories.md) — comparable local-CVE collections from other subsystems, for contrasting root-cause shapes
- [GPU/DRM War Stories](../drm/war-stories.md) — reliability-only incidents (no CVEs) from a different kind of shared kernel-internal resource contention
