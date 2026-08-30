# When the Hardware Changed, So Did the Kernel

> New bus technologies, CPUs that gained virtualization instructions, ubiquitous Ethernet and WiFi, and storage that got radically faster each broke an existing kernel assumption — and each time, the fix was a new abstraction layer, not more code per device

## The pattern

Linux didn't just get faster over three decades — the hardware underneath it kept changing *shape*, and each shape-change broke something the kernel had taken for granted. A bus that couldn't be probed. An interrupt model that assumed one packet per IRQ. A "network card" that turned out to need a full protocol stack behind it. A CPU that suddenly had a hardware-assisted way to run another OS inside it. A board full of GPIO pins that no longer fit in a `board-*.c` file. A storage device fast enough that a single lock around a single queue became the entire system's bottleneck.

The recurring fix wasn't "write more drivers." It was building a data model — sysfs, Device Tree, a regulatory database, a per-CPU queue — that let one generic driver serve a whole class of hardware, and pushing the per-device specifics out of code and into data. This page traces six times that happened, each with the person who said so and the primary source to prove it.

## Timeline at a glance

| Year | Hardware change | Kernel response |
|------|------------------|------------------|
| 1992 | PCI specified with no hotplug provisions | Static bus enumeration at boot |
| 2001–2006 | Ethernet outpaces per-packet interrupt handling; multi-queue NICs arrive | NAPI (2.4), then split from `net_device` for MSI-X (RFC Dec 2006) |
| 2002–2007 | Cheap "Soft MAC" WiFi chipsets replace firmware-complete cards | `mac80211`/`cfg80211` merged in 2.6.22 |
| 2003–2006 | No distro shipped devfs; dynamic device nodes needed a real owner | devfs deprecated, udev takes over |
| 2005–2007 | Intel VT-x and AMD SVM add hardware virtualization instructions | KVM merged in 2.6.20 |
| 2011 | ARM SoC board files hit ~145 near-duplicate GPIO drivers | Torvalds pushes Device Tree over board files |
| 2011–2014 | NVMe SSDs expose thousands of parallel hardware queues | blk-mq replaces the single-queue block layer |

## 1992–2004: from "wire it up and hope" to a bus that can be probed

The original PCI specification had a structural gap that seems strange in hindsight: it had no way to add or remove a card while the system was running. As an LWN retrospective on PCIe hotplug puts it, ["the initial PCI specification from 1992 had no provisions for the addition or removal of cards at runtime"](https://lwn.net/Articles/767885/). A PCI system's device topology was something you discovered once, at boot, and never again — fine for a desktop tower you power off to open, useless for a server rack or anything that needed to survive a failed card.

PCI Express fixed this at the specification level: it "supported hotplug from the get-go" when it arrived in 2002, and Linux's own `pciehp` driver followed two years later, written by Dely Sy in 2004 ([LWN](https://lwn.net/Articles/767885/)).

Hotplug capability at the bus level only matters if the kernel can represent devices that come and go, though — and that's a userspace problem as much as a kernel one. Linux's answer here took two tracks that converged around the same time:

- **Inside the kernel**, the driver model was unified — every device, bus, and driver got a common `struct device`/`struct bus_type`/`struct device_driver` representation exposed through `sysfs`, replacing what had been ad hoc per-subsystem bookkeeping. That's covered in depth in [the device model page](drivers/device-model.md) — it's the reason a hotplugged device can be *represented* generically at all, regardless of what kind of device it is.
- **In userspace**, the mechanism for turning that representation into `/dev` nodes went through a real changeover. `devfs`, an earlier in-kernel attempt at dynamic device nodes, was marked obsolete in September 2003: ["no one has stepped up to maintain it, and with udev we have a proper replacement now"](https://lwn.net/Articles/50731/), as the deprecation announcement put it — devfs had gone unmaintained for about a year and no major distribution had ever enabled it by default. It was formally removed in kernel 2.6.18 (2006), per [the kernel's own removed-ABI record](https://www.kernel.org/doc/Documentation/ABI/removed/devfs).

The shift from devfs to udev is really the same story as PCI to PCIe: a static, boot-time picture of "what hardware exists" stopped being good enough once hardware could legitimately change underneath a running system.

## 2001–2006: Ethernet gets fast enough to overwhelm the CPU

An interrupt per packet is a fine model until the packet rate gets high enough that the interrupts themselves become the bottleneck — a failure mode network engineers call *interrupt livelock*, where a CPU spends all its time acknowledging IRQs and none of it actually processing packets. Linux's answer, **NAPI** (New API), let a driver switch from interrupt-per-packet to interrupt-then-poll under load: take one interrupt, disable it, then pull packets in a batch until the queue drains, only re-arming the interrupt once there's nothing left to poll. The kernel's own networking documentation dates the mechanism simply: ["NAPI was originally referred to as New API in 2.4 Linux"](https://docs.kernel.org/networking/napi.html) — placing its origin in the 2.4 series, 2001–2003, without a more precise citation. (See [Network Device and NAPI](net/napi.md) for the mechanism itself — the struct, the poll loop, GRO, threaded NAPI, and the rest.)

NAPI itself needed a second revision once the hardware kept moving. Its first form assumed one poll context per network device — reasonable when one device meant one interrupt line, but multi-queue NICs using MSI-X broke that assumption by design: they deliberately spread receive processing across several interrupts (and ideally several CPUs) per device. An RFC posted to the kernel mailing list in December 2006 spelled out the mismatch directly: ["some hardware has N devices for one IRQ, others like MSI-X want multiple receives for one device"](https://lwn.net/Articles/214186/). The fix decoupled `napi_struct` from `net_device` entirely, so a single device could register several independent NAPI contexts — one per hardware queue.

## 2005–2007: the CPU learns to host another kernel, and KVM becomes possible

Running one OS inside another had always been possible on x86, but never cheaply: without hardware support, a hypervisor had to either rewrite the guest's privileged instructions ahead of time (paravirtualization, Xen's original approach) or intercept and rewrite them on the fly (binary translation, VMware's approach) — both real engineering, and both work a general-purpose CPU wasn't designed to make easy. Intel's VT-x and AMD's SVM instruction sets changed the premise: they added a new, more-privileged CPU mode specifically for a hypervisor to run in, so an unmodified guest OS could execute its privileged instructions directly and trap to the host only when it actually needed to.

Avi Kivity, working at the Israeli startup Qumranet, had been fighting limitations in Qumranet's Xen-based product when he started what became KVM. Posted to the kernel mailing list on 19 October 2006, KVM's first patch set targeted Intel's new VMX instructions, with AMD's SVM support following soon after ([LWN, "Ten years of KVM"](https://lwn.net/Articles/705160/)). It was merged upstream that December and shipped in kernel **2.6.20**, released 4 February 2007 — less than four months after the first post.

The speed of that merge is itself the point: KVM could be small and simple *because* the hardware had just started doing the hard part. As the same LWN retrospective puts it, the goal was "as much reuse of existing functionality as possible: using Linux to do most of the work, with KVM just being a driver that handled the new virtualization instructions exposed by hardware." Xen, designed before VT-x/SVM existed, had no such option — it "had to use a different design," modifying the guest kernel and taking over the host kernel's role itself. KVM didn't out-engineer Xen; it arrived after the hardware made a fundamentally simpler design possible, and it never needed the older approach at all. (See [KVM Architecture](virtualization/kvm-arch.md) and the rest of the [virtualization section](virtualization/README.md) for the mechanism this hardware support actually enabled — VMCS, EPT, and the vCPU run loop.)

## 2002–2007: WiFi goes mainstream, and the Ethernet model breaks

Early wireless cards mostly got away with looking like slow Ethernet to the kernel, because the card's firmware handled the 802.11 protocol itself — scanning, association, encryption, retransmission — and only handed the kernel finished frames. LWN's coverage of a 2008 Linux wireless status talk calls this **"Full MAC"** hardware. But a cheaper class of card shipped the radio and left the protocol logic to be implemented in software — **"Soft MAC"** hardware, which wireless maintainer John Linville compared directly to *"winmodems"*, the infamous software modems that pushed telephony signal processing onto the host CPU. The tradeoff was explicit: Soft MAC "is a cheaper solution for vendors, but it requires an 802.11 stack for the kernel" ([LWN](https://lwn.net/Articles/291896/)).

That requirement — a real 802.11 stack, not a thin device driver — is why WiFi couldn't just extend the Ethernet driver model the way, say, a new NIC chipset could. A `net_device` driver assumes the hardware (or its firmware) already speaks a known link-layer protocol; Soft MAC hardware needed the kernel itself to speak 802.11 — scanning for networks, negotiating authentication, tracking association state, handling power-save timing, picking a data rate, and reacting to per-country radio regulations, none of which has an Ethernet equivalent.

The resulting stack, **mac80211**, traces its lineage through the copyright headers still in the kernel source today: originated at Devicescape Software (2002–2005), carried forward by Jiri Benc (2006–2007), then Johannes Berg (2007–2010) — visible directly in [`include/net/mac80211.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/net/mac80211.h). After the initial code needed locking and SMP fixes, it was merged into kernel **2.6.22**, released July 2007 ([LWN](https://lwn.net/Articles/291896/)). A companion layer, **cfg80211**, took over device *configuration* — replacing the older Wireless Extensions ioctl interface, which had its own hardware-diversity scar: its fixed-size, NULL-terminated SSID buffer couldn't correctly round-trip a legitimate 32-byte SSID, a bug [Johannes Berg was still fixing in 2009](https://lkml.iu.edu/hypermail/linux/kernel/0912.2/00078.html), years after mac80211 itself had shipped.

There isn't yet a dedicated deep-dive on `mac80211`/`cfg80211` internals on this site — it's a natural next addition given the depth of material here, and is tracked as follow-up work rather than covered on this page.

## 2011: when SoC diversity broke the board-file model

ARM's rise as a kernel-supported architecture created a different kind of pressure: not one class of device changing, but *hundreds* of System-on-Chip variants, each with its own board file hand-coding which peripherals existed and how they were wired — including, often, its own copy-pasted GPIO driver. By March 2011 this had become unsustainable, and Linus Torvalds said so directly on the kernel mailing list, replying to a pull request of OMAP board changes:

> *"What I'm saying is that we should not be adding ANY MINDLESS BOARD DRIVERS for ARM. Because they don't work. Most of them are totally unmaintainable CRAP in the long run. [...] That's 145 files in the arm directory that are some kind of crazy gpio support. [...] ARM is at the point where it's just crazy."*
>
> — [Linus Torvalds, "Re: [GIT PULL] omap changes for v2.6.39 merge window," March 30, 2011](https://lkml.iu.edu/hypermail/linux/kernel/1103.3/03692.html)

Torvalds didn't just diagnose the problem — the same message proposed the fix that ARM support standardized on: describe each board's hardware as *data*, not code. "Instead of writing yet another mindless board driver for the gpio's on it, just add the entries to the device tree. NOT A SINGLE LINE OF CODE," he wrote, pointing to PowerPC's existing Device Tree usage as the model to copy. That shift — from board files compiled into the kernel to Device Tree blobs describing hardware topology at boot — is the subject of [the Device Tree page](drivers/device-tree.md).

## 2011–2014: SSDs get fast enough that the queue lock is the bottleneck

The pre-2013 block layer had one `request_queue` per device, guarded by a single spinlock — a fine design for spinning disks, where seek latency dominated and an elevator scheduler reordering requests by cylinder address was the actual performance win. That design assumed contention on the queue lock was rare, because no single disk could issue enough I/O per second to make lock contention the bottleneck.

NVMe broke that assumption at the specification level: an NVMe controller can expose up to 65,535 hardware queues, each deep enough to hold 65,535 commands, specifically so software never has to serialize access to them. Matthew Wilcox (Intel) posted the first Linux NVMe driver to the kernel mailing list on 3 March 2011 ([LWN](https://lwn.net/Articles/431103/)) — but a driver alone couldn't fix a block layer built around exactly one queue. Jens Axboe's multiqueue rewrite (`blk-mq`), merged into kernel 3.13 in early 2014, replaced it with per-CPU software queues feeding multiple hardware queues; the commit message is direct about why the old design didn't age well: it "runs into scaling issues even on smaller machines when you have IOPS in the hundreds of thousands per device" ([commit `320ae51feed5`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=320ae51feed5c2f13664aa05a76bec198967e04d)).

The full mechanism — per-CPU `blk_mq_ctx`, hardware `blk_mq_hw_ctx`, tag allocation, and the real IOPS numbers behind the rewrite — is already covered in depth on [the blk-mq page](block/blk-mq.md); this is the same pattern as NAPI and mac80211 above, just in storage instead of networking: hardware parallelism arrived faster than the kernel's queueing model could absorb it, one lock at a time.

## The throughline

Six different hardware shifts, two repeated responses. Most of the time, the fix was moving per-device differences out of code and into data something generic could describe: PCI's static topology gave way to `sysfs`/`udev`'s dynamic device model; hundreds of near-identical ARM board files gave way to Device Tree's declarative hardware description. The other times, the fix was multiplying a single serialized resource into many parallel ones: NAPI's single poll context became a per-queue model as NICs went multi-queue; the block layer's single request queue and lock became per-CPU software queues feeding many hardware queues once NVMe made one queue the bottleneck. WiFi is the outlier, and the more interesting case for it: Soft-MAC hardware couldn't be served by *either* fix, because the missing piece wasn't a data model or a parallelism limit — it was an entire protocol the kernel had never needed to speak before, so `mac80211` had to become a real 802.11 stack, not a smarter driver. And KVM inverts the whole pattern: for once, new hardware didn't force the kernel to build something more elaborate — VT-x and SVM let it build something *simpler* than the software-only hypervisors that came before.

The common thread underneath all six: none of them were solved by writing more code per device. They were solved by recognizing that the *shape* of the hardware had changed — from static to dynamic, from serial to parallel, from dumb to protocol-aware — and rebuilding the kernel's abstraction to match that shape, once, generically.

## Further reading

### LWN articles

- [The modernization of PCIe hotplug in Linux](https://lwn.net/Articles/767885/) — the 1992 PCI spec's lack of hotplug, PCIe's 2002 hotplug support, and Linux's 2004 `pciehp` driver
- [The beginning of the end for devfs](https://lwn.net/Articles/50731/) — devfs's September 2003 deprecation in favor of udev
- [Network devices, NAPI, and multiqueue](https://lwn.net/Articles/214186/) — the December 2006 RFC splitting `napi_struct` from `net_device` for MSI-X hardware
- [OLS: The state of Linux wireless networking](https://lwn.net/Articles/291896/) — Full MAC vs. Soft MAC hardware, and mac80211's 2.6.22 merge
- [Ten years of KVM](https://lwn.net/Articles/705160/) — Avi Kivity, Qumranet, the October 2006 announcement, the 2.6.20 merge, and why hardware virtualization let KVM's design stay simple
- [NVM Express driver review](https://lwn.net/Articles/431103/) — Matthew Wilcox's original Linux NVMe driver, posted March 2011

### Kernel source and documentation

- [include/net/mac80211.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/net/mac80211.h) — the copyright history tracing mac80211's authorship from Devicescape through Jiri Benc to Johannes Berg
- [Removed devfs ABI documentation](https://www.kernel.org/doc/Documentation/ABI/removed/devfs) — devfs's final removal in kernel 2.6.18
- [NAPI documentation](https://docs.kernel.org/networking/napi.html) — dates NAPI's origin to the 2.4 kernel series
- [commit `320ae51feed5`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=320ae51feed5c2f13664aa05a76bec198967e04d) — Jens Axboe's blk-mq introduction, merged in kernel 3.13

### Primary sources

- [Linus Torvalds, "Re: [GIT PULL] omap changes for v2.6.39 merge window," March 30, 2011](https://lkml.iu.edu/hypermail/linux/kernel/1103.3/03692.html) — the ARM board-file rant that argued for Device Tree adoption
- [Johannes Berg, "Re: [PATCH] wireless: wext: allocate space for NULL-termination for 32byte SSIDs," December 16, 2009](https://lkml.iu.edu/hypermail/linux/kernel/0912.2/00078.html) — the Wireless Extensions SSID-truncation bug cfg80211 was built to avoid

### Related pages

- [Linux Evolution](linux-evolution.md) — the broader release-history and governance timeline this page complements
- [The Linux Device Model](drivers/device-model.md) — the kobject/sysfs/bus_type unification that made hotplug representable
- [Network Device and NAPI](net/napi.md) — the interrupt-mitigation mechanism itself
- [KVM Architecture](virtualization/kvm-arch.md) — the VMCS/EPT/vCPU-run-loop mechanism VT-x and SVM made possible
- [Device Tree](drivers/device-tree.md) — the declarative hardware description Torvalds' 2011 message argued for
- [blk-mq: Multi-Queue Block Layer](block/blk-mq.md) — the per-CPU/per-hardware-queue mechanism in full depth
