# What's New

Big changes to the site — new sections, major expansions, and notable corrections — newest first. This is a *curated* list of the significant milestones, not a full commit log; the complete history lives in [the repository](https://github.com/laveeshb/linux-kernel-internals/commits/main).

## August 2026

- **New section: [USB](usb/README.md).** A full walkthrough of the USB subsystem — the host-scheduled bus model, [enumeration and descriptors](usb/enumeration.md), [URBs and the four transfer types](usb/urbs.md), [host controllers (xHCI) and gadget mode](usb/xhci-gadget.md), and [war stories](usb/war-stories.md) (BadUSB, a MIDI double-free, fuzzing the host stack).
- **Devices & Drivers, filled out.** The category launched with GPU/DRM, sound, input/HID, and TTY/serial queued up — all four landed this month: [GPU/DRM](drm/README.md) ([KMS and atomic modesetting](drm/kms.md), [GEM buffer objects and dma-buf](drm/gem-dmabuf.md), [command submission and the scheduler](drm/command-submission.md)), [sound/ALSA](alsa/README.md), [input/HID](input/README.md), and [TTY/serial](tty/README.md).
- **War stories, nearly everywhere.** Dedicated war-stories pages landed across most of the site this month — [net](net/war-stories.md), [security](security/war-stories.md), [locking](locking/war-stories.md), [VFS](vfs/war-stories.md), [BPF](bpf/war-stories.md), [drivers](drivers/war-stories.md), [virtualization](virtualization/war-stories.md), [DRM](drm/war-stories.md) (two rounds), plus first-class war-stories for the new USB/ALSA/input/TTY sections. Each incident is independently verified against a primary source — a real commit, CVE, or LWN article — rather than summarized from memory.
- **Citation integrity, twice over.** A site-wide sweep fixed broken and wrong LWN/docs.kernel.org links (including converting kernel commit citations from GitHub to git.kernel.org) and closed out the last 11 subsystems that had zero source citations at all. That work then surfaced a deeper problem: pre-existing illustrative code samples with fabricated struct fields, function signatures, and version claims. A page-by-page technical-accuracy audit of [virtualization/](virtualization/README.md) is underway to catch these — four pages fixed so far ([kvm-arch.md](virtualization/kvm-arch.md), [kvm-exits.md](virtualization/kvm-exits.md), [kvm-memory.md](virtualization/kvm-memory.md), [live-migration.md](virtualization/live-migration.md)), three more in progress.
- **New: [Hardware Evolution](hardware-evolution.md).** A companion to the [Linux Evolution](linux-evolution.md) timeline, tracing six moments where a hardware-landscape shift forced a new kernel abstraction — PCI's hotplug gap and the devfs-to-udev handoff, NAPI's multi-queue split, VT-x/SVM making KVM possible, WiFi's mac80211, the 2011 ARM Device-Tree crisis, and NVMe forcing the blk-mq rewrite — each backed by a primary source.
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
