# What's New

Big changes to the site — new sections, major expansions, and notable corrections. This is a curated list of the significant additions, not a full commit log (that lives in [the repository](https://github.com/laveeshb/linux-kernel-internals/commits/main)).

## August 2026

- **New section: [USB](usb/README.md).** A full walkthrough of the USB subsystem — the host-scheduled bus model, [enumeration and descriptors](usb/enumeration.md), [URBs and the four transfer types](usb/urbs.md), [host controllers (xHCI) and gadget mode](usb/xhci-gadget.md), and [war stories](usb/war-stories.md) (BadUSB, a MIDI double-free, fuzzing the host stack).
- **New top-level category: [Devices & Drivers](usb/README.md).** The device-driver material now has its own home, starting a push to cover the device/media subsystems that were missing. GPU/DRM, sound (ALSA), input/HID, and the TTY/serial layer are queued next.
- **Filesystems, deepened.** The [filesystems](filesystems/README.md) section gained [crash consistency and recovery](filesystems/crash-consistency.md), [iomap](filesystems/iomap.md), [FUSE](filesystems/fuse.md), and [war stories](filesystems/war-stories.md), plus a rewritten overview and primary-source citations across the existing pages.
- **Block layer & tracing, expanded.** The [block layer](block/README.md) added a life-of-a-block-I/O walkthrough, cgroup I/O control, observability, and war stories; [tracing](tracing/README.md) added the ring buffer, trace events, BPF-for-tracing, and war stories.
- **Citation accuracy.** An ongoing audit is removing unverifiable citations and grounding claims in primary sources (kernel commits, official documentation, LWN).
- **Navigation & readability overhaul.** The 30+ subsystems are now grouped into themed category tabs with landing pages, a navigable sidebar, and larger, more readable text.

---

*Following along?* Watch or star the [GitHub repository](https://github.com/laveeshb/linux-kernel-internals) for updates.
