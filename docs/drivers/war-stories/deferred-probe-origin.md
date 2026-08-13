# The Deferred-Probe Origin Story

> Not a CVE — an OLPC laptop's camera driver failed to initialize when compiled directly into the kernel but worked fine as a module, because the "camera" was really three separate devices whose probe order the kernel's static, built-in link order couldn't guarantee — the fix started in 2011 as a driver returning `-EAGAIN` and settled, through several revisions, into the dedicated `-EPROBE_DEFER` mechanism the kernel still uses today

Landed
:   Linux 3.4, released May 20, 2012

Author
:   Grant Likely (patch author); Greg Kroah-Hartman (committer, driver core maintainer)

Originated in
:   a real boot failure on OLPC XO laptop hardware, first described publicly by Jonathan Corbet on LWN in July 2011

Not a CVE

*Part of [War Stories: Device Drivers](../war-stories.md).*

## Before state

A driver compiled directly into the kernel (rather than loaded later as a module) gets initialized during boot, in an order the kernel's build determines statically: initcall level (`arch_initcall`, `subsys_initcall`, `device_initcall`, and so on) first, then link order within that level. Nothing about that ordering knows or cares whether one built-in driver's device actually depends on another built-in driver's device being ready first — it's purely a function of where each `initcall` macro sits in the kernel image, decided at build time, long before any of the actual hardware is probed at boot. A driver loaded later as a kernel module has no such constraint: by the time an administrator or udev loads it, whatever else it depends on has typically already finished initializing.

## The trigger

LWN's Jonathan Corbet described the concrete failure this exposed, in a July 7, 2011 article on the resulting patch proposal: "The developers working on the initial OLPC laptop ran into an interesting problem: the camera driver would fail to initialize if it was built into the kernel, but it worked just fine if built as a module." The reason traced to what "the camera" actually was in hardware terms: "The problem with the camera driver is a result of the fact that the 'camera' is, in reality, three devices working in concert: a DMA bridge, a sensor, and an I2C bus connecting the two." Built directly into the kernel, there was no guarantee the three drivers' `probe()` functions would run in an order that respected this dependency: "If all of the drivers are built into the kernel, the bridge driver's probe() function may be called first; there will be no sensor, so everything fails." As a module, the same three drivers happened to load in an order where the dependency was already satisfied by the time each one's `probe()` ran — not because anything enforced that order, but because loading them later, by hand or via modprobe's own dependency resolution, sidestepped the built-in link-order problem entirely.

## Observed behavior

The mechanism Corbet described in 2011, credited to a patch from Grant Likely, was a general-purpose retry facility: "drivers which are unable to initialize their devices as the result of missing resources can request that the operation be retried at some point in the future. That request is a simple matter of returning **-EAGAIN** from the probe() function." The driver core would track drivers that asked for this: "The driver core maintains a simple linked list of drivers that have requested this sort of deferral." This early version used the kernel's ordinary `-EAGAIN` errno — the same value used throughout the kernel and POSIX for "try this operation again later" in dozens of unrelated contexts, from non-blocking I/O to resource contention. That choice didn't survive to the version that eventually merged.

## Why it happened

The underlying problem generalizes well beyond OLPC's specific camera hardware: the kernel's build-time initcall ordering has no representation of *functional* dependencies between devices — it only encodes the order the build system happened to link objects in. A later in-tree comment describing the finished mechanism states the general case plainly, using an unrelated example: "Sometimes driver probe order matters, but the kernel doesn't always have dependency information which means some drivers will get probed before a resource it depends on is available. For example, an SDHCI driver may first need a GPIO line from an i2c GPIO controller before it can be initialized. If a required resource is not available yet, a driver can request probing to be deferred by returning -EPROBE_DEFER from its probe hook." OLPC's three-device camera was simply the concrete case that surfaced the gap publicly and produced a patch; the SDHCI/GPIO example the merged code documents itself with shows the same shape of problem recurring on entirely different hardware.

## Resolution

The mechanism went through several revisions between Corbet's July 2011 coverage and merge. Its own v4 changelog, embedded in the final commit message, records a deliberate late-stage change: "Change -EAGAIN to -EPROBE_DEFER for drivers to trigger deferral" — presumably to give deferral requests a dedicated, unambiguous signal, distinct from the many other kernel subsystems that already used `-EAGAIN` for unrelated meanings. `d1c3414c2a9d` ("drivercore: Add driver probe deferral mechanism," Grant Likely, authored March 5, 2012, committed by Greg Kroah-Hartman March 8, 2012) landed this as the mechanism still in use: `include/linux/errno.h` gains `#define EPROBE_DEFER 517 /* Driver requests probe retry */`; `drivers/base/dd.c` gains `driver_deferred_probe_add()`, `driver_deferred_probe_del()`, `driver_deferred_probe_trigger()`, and `deferred_probe_work_func()`, backed by two lists — `deferred_probe_pending_list` and `deferred_probe_active_list` — protected by `deferred_probe_mutex` and drained by a dedicated workqueue rather than retried inline. The commit first shipped in Linux 3.4, released May 20, 2012.

This mechanism is also the retry primitive that automatic firmware-derived probe ordering later builds directly on top of: fw_devlink's `DL_FLAG_AUTOPROBE_CONSUMER` mode, [added nearly a decade later](fw-devlink-boot-breaking.md), works by having the driver core issue the equivalent of an `-EPROBE_DEFER` automatically whenever a consumer's declared supplier hasn't probed yet — turning a mechanism drivers originally had to invoke themselves, one `-EAGAIN`/`-EPROBE_DEFER` return at a time, into something the driver core can trigger on a driver's behalf from dependency data it already has.

## What it taught us

**A driver behaving differently as built-in versus as a module, with no other variable changed, is a strong signal that something about probe *order* — not the driver's own logic — is load-bearing.** The camera driver code itself wasn't wrong on either build; the built-in link order simply didn't happen to satisfy an ordering constraint that module-loading incidentally did.

**A retry request deserves its own dedicated signal, not an overloaded existing one.** The mechanism's own revision history shows it starting with `-EAGAIN` — the obvious, already-available "try again" errno — and moving to a purpose-built `-EPROBE_DEFER` before merge, once it became a general driver-core facility rather than one platform's workaround.

!!! warning "Pattern to watch for"
    If a driver initializes correctly as a module but fails when compiled directly into the kernel (or vice versa), suspect an implicit ordering dependency that the working configuration happens to satisfy by accident rather than by design — not a logic bug in the driver itself. `-EPROBE_DEFER` exists specifically so a driver can say "not yet" instead of failing outright when this happens.

## See also

- [Linux Device Model](../device-model.md) — `struct device`, `probe()`, and where deferred probing fits in driver registration
- [fw_devlink=on: The Default That Broke Boot Twice Before It Stuck](fw-devlink-boot-breaking.md) — the mechanism this page describes, made automatic and turned on by default nearly a decade later, with its own multi-year stabilization story
- [Device Tree](../device-tree.md) — the firmware description format that, decades later, lets the kernel derive dependency graphs instead of relying solely on drivers requesting their own deferral

## External references

- [LWN: Deferred driver probing](https://lwn.net/Articles/450460/) — Jonathan Corbet, July 7, 2011, the original OLPC camera account and the `-EAGAIN`-based proposal
- [LWN: Grant Likely's patch submission, "drivercore: Add driver probe deferral mechanism"](https://lwn.net/Articles/485194/) — lkml patch mail archived by LWN, March 5, 2012, textually the same content that merged as `d1c3414c2a9d`
- [git.kernel.org: d1c3414c2a9d](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d1c3414c2a9d10ef7f0f7665f5d2947cd088c093) — "drivercore: Add driver probe deferral mechanism," the merged commit, first shipped in Linux 3.4
