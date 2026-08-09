# What's New

Big changes to the site — new sections, major expansions, and notable corrections — newest first. This is a *curated* list of the significant milestones, not a full commit log; the complete history lives in [the repository](https://github.com/laveeshb/linux-kernel-internals/commits/main).

## August 2026

- **New section: [USB](usb/README.md).** A full walkthrough of the USB subsystem — the host-scheduled bus model, [enumeration and descriptors](usb/enumeration.md), [URBs and the four transfer types](usb/urbs.md), [host controllers (xHCI) and gadget mode](usb/xhci-gadget.md), and [war stories](usb/war-stories.md) (BadUSB, a MIDI double-free, fuzzing the host stack).
- **New top-level category: Devices & Drivers.** The device-driver material now has its own home, starting a push to cover the device/media subsystems that were missing — GPU/DRM, sound (ALSA), input/HID, and the TTY/serial layer are queued next.
- **[Filesystems](filesystems/README.md), deepened.** Added [crash consistency and recovery](filesystems/crash-consistency.md), [iomap](filesystems/iomap.md), [FUSE](filesystems/fuse.md), and [war stories](filesystems/war-stories.md), plus a rewritten overview and primary-source citations across the existing pages.
- **[Block layer](block/README.md) & [tracing](tracing/README.md), expanded.** The block layer gained a life-of-a-block-I/O walkthrough, cgroup I/O control, observability, and war stories; tracing gained the ring buffer, trace events, BPF-for-tracing, and war stories.
- **Navigation & readability overhaul.** The 30+ subsystems are now grouped into themed category tabs with landing pages, a navigable sidebar, and larger, more readable text.

## July 2026

- **Build integrity enforced in CI.** Pull requests are now gated on strict builds with internal-link and anchor validation, so a broken cross-reference can no longer merge.
- **More memory-management depth.** Added the [physical memory model](mm/memory-model.md), the [kernel half of the address space](mm/kernel-address-space.md), and [GUP (Getting User Pages)](mm/gup.md).
- **Sourcing pass.** Sourced further-reading sections across the [architecture](arch/arm64/README.md) docs, and a refresh of the section landing pages.

## April 2026 — Depth pass

- **Stub sections grown to comprehensive coverage.** Deep-dive expansions landed across [arch/x86](arch/x86/README.md) and the [core kernel](kernel/README.md); [I/O and io_uring](io/README.md); [IOMMU](iommu/README.md) and [crypto](crypto/README.md); [livepatch](livepatch/README.md), [syscalls](syscalls/README.md), [modules](modules/README.md), and [time](time/README.md); [virtualization](virtualization/README.md), [debugging](debugging/README.md), [cgroups](cgroups/README.md), [IPC](ipc/README.md), and [power](power/README.md); and [arch/arm64](arch/arm64/README.md).

## March 2026 — From memory to the whole kernel

- **The site expanded from a memory-management reference into a whole-kernel one.** Two dozen new subsystem sections landed at once: the [scheduler](sched/README.md), [networking](net/README.md), [VFS](vfs/README.md) / [filesystems](filesystems/README.md) / [storage](block/README.md) / [IPC](ipc/README.md) / [syscalls](syscalls/README.md), [locking](locking/README.md) / [interrupts](interrupts/README.md) / [BPF](bpf/README.md) / [tracing](tracing/README.md), and [architecture](arch/arm64/README.md) / [security](security/README.md) / [drivers](drivers/README.md) / [virtualization](virtualization/README.md).
- **Memory management deepened.** NUMA-advanced topics, reclaim internals, modern mm (folio, maple tree, TLB, RCU), the first mm war stories, and boot/DMA coverage.
- **First site-wide citation audit.** Primary-source citations added across many subsystems, alongside an accuracy review spanning 85 documents.

## January 2026 — Launch

- **The site went live** as a deep [memory-management](mm/README.md) reference, paired with a history of [Linux's evolution](linux-evolution.md).
- Custom domain, automated deploys, and [contribution guidelines](contributing.md) established.

---

*Following along?* Watch or star the [GitHub repository](https://github.com/laveeshb/linux-kernel-internals) for updates.
