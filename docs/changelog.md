# What's New

Big changes to the site — new sections, major expansions, and notable corrections — newest first. This is a *curated* list of the significant milestones, not a full commit log; the complete history lives in [the repository](https://github.com/laveeshb/linux-kernel-internals/commits/main).

## September 2026

- **Accuracy audit extended site-wide.** Dozens more pages — spanning syscalls, kernel internals, debugging, crypto, IOMMU, virtualization, and IPC — had fabricated or stale technical details corrected against current kernel source, continuing the pass that started in [virtualization/](virtualization/README.md) in August.
- **New pages: [PREEMPT_RT](locking/preempt-rt.md), [sched_ext](sched/sched-ext.md), and two BPF deep-dives** ([security model](bpf/bpf-security-model.md), [helpers/kfuncs/JIT](bpf/bpf-helpers-kfuncs-jit.md)).
- **War stories kept growing:** new pages for the scheduler, interrupts, and livepatch's kGraft-vs-kpatch history; five new real-incident CVE write-ups (three USB, one XFS, one net/sched — the last documenting an AI-assisted 0-day exploit); and an editorial pass clarifying which war-stories pages are illustrative versus real, individually-cited incidents.
- **[Interrupts](interrupts/README.md) given real design history** — the section's shallowest pages now explain *why* the kernel has five different deferred-work mechanisms and how each one came to exist, not just how they work.

## August 2026

- **New content across devices, drivers, and storage.** [USB](usb/README.md) landed as a full new section; the Devices & Drivers category filled out with [GPU/DRM](drm/README.md), [sound/ALSA](alsa/README.md), [input/HID](input/README.md), and [TTY/serial](tty/README.md); [filesystems](filesystems/README.md), the [block layer](block/README.md), and [tracing](tracing/README.md) all deepened; and a new [Hardware Evolution](hardware-evolution.md) timeline traces six moments a hardware shift forced a kernel-design change.
- **War stories expanded across most of the site**, each incident independently verified against a real commit, CVE, or LWN article rather than summarized from memory.
- **A citation-integrity sweep** fixed broken and wrong source links and closed out subsystems with no citations at all — which surfaced fabricated technical details in some older illustrative code samples, kicking off the ongoing accuracy audit.
- **Navigation overhaul.** Subsystems are now grouped into themed category tabs with landing pages and a more readable layout.

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
