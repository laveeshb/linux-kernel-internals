# When the Hardware Changed, So Did the Kernel

> New bus technologies, ubiquitous Ethernet, and cheap WiFi chipsets each broke an existing kernel assumption — and each time, the fix was a new abstraction layer, not more code per device

## The pattern

Linux didn't just get faster over three decades — the hardware underneath it kept changing *shape*, and each shape-change broke something the kernel had taken for granted. A bus that couldn't be probed. An interrupt model that assumed one packet per IRQ. A "network card" that turned out to need a full protocol stack behind it. A board full of GPIO pins that no longer fit in a `board-*.c` file.

The recurring fix wasn't "write more drivers." It was building a data model — sysfs, Device Tree, a regulatory database — that let one generic driver serve a whole class of hardware, and pushing the per-device specifics out of code and into data. This page traces four times that happened, each with the person who said so and the primary source to prove it.

## Timeline at a glance

| Year | Hardware change | Kernel response |
|------|------------------|------------------|
| 1992 | PCI specified with no hotplug provisions | Static bus enumeration at boot |
| 2001–2006 | Ethernet outpaces per-packet interrupt handling; multi-queue NICs arrive | NAPI (2.4), then split from `net_device` for MSI-X (RFC Dec 2006) |
| 2002–2007 | Cheap "Soft MAC" WiFi chipsets replace firmware-complete cards | `mac80211`/`cfg80211` merged in 2.6.22 |
| 2003–2006 | No distro shipped devfs; dynamic device nodes needed a real owner | devfs deprecated, udev takes over |
| 2011 | ARM SoC board files hit ~145 near-duplicate GPIO drivers | Torvalds pushes Device Tree over board files |

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

## The throughline

Four different hardware shifts, one repeated response: PCI's static topology gave way to `sysfs`/`udev`'s dynamic device model; NAPI's single poll context gave way to a per-queue model as NICs went multi-queue; Ethernet's assume-a-known-protocol driver model gave way to `mac80211`'s full software stack once WiFi hardware stopped doing that protocol work itself; and hundreds of near-identical ARM board files gave way to Device Tree's declarative hardware description. In each case, the volume or diversity of hardware outgrew what one-driver-per-device could sanely support, and the kernel's answer was to move the differences out of code and into a structure something else — sysfs, a regulatory database, a `.dts` file — could describe instead.

## Further reading

### LWN articles

- [The modernization of PCIe hotplug in Linux](https://lwn.net/Articles/767885/) — the 1992 PCI spec's lack of hotplug, PCIe's 2002 hotplug support, and Linux's 2004 `pciehp` driver
- [The beginning of the end for devfs](https://lwn.net/Articles/50731/) — devfs's September 2003 deprecation in favor of udev
- [Network devices, NAPI, and multiqueue](https://lwn.net/Articles/214186/) — the December 2006 RFC splitting `napi_struct` from `net_device` for MSI-X hardware
- [OLS: The state of Linux wireless networking](https://lwn.net/Articles/291896/) — Full MAC vs. Soft MAC hardware, and mac80211's 2.6.22 merge

### Kernel source and documentation

- [include/net/mac80211.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/net/mac80211.h) — the copyright history tracing mac80211's authorship from Devicescape through Jiri Benc to Johannes Berg
- [Removed devfs ABI documentation](https://www.kernel.org/doc/Documentation/ABI/removed/devfs) — devfs's final removal in kernel 2.6.18
- [NAPI documentation](https://docs.kernel.org/networking/napi.html) — dates NAPI's origin to the 2.4 kernel series

### Primary sources

- [Linus Torvalds, "Re: [GIT PULL] omap changes for v2.6.39 merge window," March 30, 2011](https://lkml.iu.edu/hypermail/linux/kernel/1103.3/03692.html) — the ARM board-file rant that argued for Device Tree adoption
- [Johannes Berg, "Re: [PATCH] wireless: wext: allocate space for NULL-termination for 32byte SSIDs," December 16, 2009](https://lkml.iu.edu/hypermail/linux/kernel/0912.2/00078.html) — the Wireless Extensions SSID-truncation bug cfg80211 was built to avoid

### Related pages

- [Linux Evolution](linux-evolution.md) — the broader release-history and governance timeline this page complements
- [The Linux Device Model](drivers/device-model.md) — the kobject/sysfs/bus_type unification that made hotplug representable
- [Network Device and NAPI](net/napi.md) — the interrupt-mitigation mechanism itself
- [Device Tree](drivers/device-tree.md) — the declarative hardware description Torvalds' 2011 message argued for
