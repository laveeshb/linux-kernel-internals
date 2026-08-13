# War Stories: Device Drivers

> Two CVEs, one multi-year default-rollout saga, and the origin story behind it all — every page here lives in the driver core itself (`drivers/base/`), the code that decides when a device is ready to be probed and how its identity is exposed to userspace, rather than in any individual hardware driver

The driver core sits underneath every bus-specific and hardware-specific driver in the kernel, and these four incidents show two different ways it can go wrong. Two pages — the uevent deadlock and the kobject path race — are about the same narrow problem: safely reading and rendering a device's identity (`dev->driver`, a kobject's name) while that identity can change out from under the reader. The other two are about a completely different axis: *when* a device is allowed to probe at all, relative to whatever it depends on. The deferred-probe origin story explains why that axis exists in the first place; the fw_devlink saga is what happened when the kernel tried to make dependency-aware probing the default behavior for everyone, automatically, without every driver having to ask for it.

## Incidents

Ordered reverse chronologically by when the fix (or, for the origin story, the original merge) landed in mainline — newest first.

### [The uevent_show() Fix That Deadlocked Driver Detach](war-stories/uevent-show-deadlock.md)
**Linux 6.11 (September 2024) · CVE-2024-44952 (rejected)**
A 2024 fix for a real `dev->driver` NULL-pointer race added `device_lock()` to a sysfs read path, recreating a deadlock against driver detach that lockdep couldn't see — `device_lock()` is deliberately exempted from lockdep's cycle detector, and only CXL's own local lockdep key ever caught it.

### [The kobject Path Race That Needed a Retry, Not a Lock](war-stories/kobject-path-race.md)
**Linux 6.3 (April 2023) · CVE-2023-45863**
`kobject_get_path()` measured a sysfs path's length in one unsynchronized pass and filled the buffer in a second — a concurrent network-interface rename between the two passes could grow a name enough to overflow the undersized buffer, a bug that sat in the kernel's git history since its very first tag in 2005.

### [fw_devlink=on: The Default That Broke Boot Twice Before It Stuck](war-stories/fw-devlink-boot-breaking.md)
**Linux 5.13 (June 2021) · not a CVE**
Enabling automatic probe-order enforcement from firmware-described device graphs by default broke boot on multiple platforms twice in three months — and the revert commit's own "for 5.12" framing turned out to be moot, since Linux 5.12 shipped with the old default the entire time.

### [The Deferred-Probe Origin Story](war-stories/deferred-probe-origin.md)
**Linux 3.4 (May 2012) · not a CVE**
An OLPC laptop's camera driver — really three separate devices — failed to initialize built-in but worked fine as a module, because the kernel's static built-in link order had no way to express that one device depended on another being ready first.

## Common threads

| Pattern | uevent deadlock | kobject path race | fw_devlink saga | deferred-probe origin |
|---------|:---:|:---:|:---:|:---:|
| Lives in the driver core itself (`drivers/base/`) | Yes | Yes | Yes | Yes |
| About safely exposing a device/driver's identity (sysfs, uevent) | Yes | Yes | No | No |
| About probe-order / dependency timing | No | No | Yes | Yes (defines it) |
| Introduced by a fix for a different, real bug | Yes | No | No | — |
| CVE assigned | Yes (rejected) | Yes | No | No |
| Root cause ultimately outside kernel code (firmware/DT description) | No | No | Yes, in one episode | No |
| Time from introduction to fix | ~2 months (2024) | ~18 years (2005→2023) | ~6 months of instability (2020→2021) | — |

**The two identity-exposure bugs are mirror images of each other in how they got fixed.** The uevent deadlock was fixed by *removing* a lock and replacing it with RCU; the kobject path race was fixed by *adding* a bounds check and a retry, deliberately without introducing any new lock at all. Both landed on the same conclusion from opposite starting points: a lock taken casually to fix one problem in this exact code area is more likely to create a new one than a synchronization-free, self-checking design.

**The probe-order pages are separated by almost a decade, and the second is the first one's mechanism turned into a systemwide default.** `-EPROBE_DEFER` started in 2012 as something an individual driver had to explicitly request. fw_devlink's `on` mode, landing for real in 2021, is the driver core issuing that same request automatically, on a driver's behalf, from a firmware-described dependency graph — and the boot regressions it caused were, in every verified case, exactly the class of gap the original 2012 mechanism was built to paper over: a device that the graph says should exist as a probe target, but that never actually registers a `struct device` the way the graph assumed.

**Only one of these four is a rejected CVE, and it's rejected for administrative reasons, not because the underlying deadlock wasn't real.** The lockdep splat behind CVE-2024-44952 is a genuine, reproducible AB-BA deadlock on real CXL hardware; the CVE record itself gives no bug-specific rationale for withdrawal, consistent with the kernel CVE team's general practice of assigning CVE numbers to nearly any bugfix and occasionally un-assigning them administratively afterward.

## See also

- [Linux Device Model](README.md) — `struct device`, buses, drivers, and classes, the framework every page here operates inside
- [Device Tree](device-tree.md) — the firmware description format two of these incidents (fw_devlink, deferred-probe) are built around
- [Locking War Stories](../locking/war-stories.md) — a comparable set of incidents where a lock's own discipline, rather than a device's identity, is the thing that goes wrong
