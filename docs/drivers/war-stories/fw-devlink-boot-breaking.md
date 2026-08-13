# fw_devlink=on: The Default That Broke Boot Twice Before It Stuck

> Not a CVE — enabling automatic probe-order enforcement from firmware-described device graphs by default broke boot on multiple platforms twice in three months, forcing a full revert-and-retry cycle, and the revert commit's own "for 5.12" framing turned out to be moot: Linux 5.12 shipped with the old default the entire time, and the new one first reached users only in 5.13

First attempt
:   commit `e590474768f1`, December 18, 2020 — `fw_devlink=on` set as the default

First revert
:   commit `3e4c982f1ce7`, February 18, 2021 — reverted "for 5.12" after platform boot regressions

Re-enabled ("Take II")
:   commit `ea718c699055`, authored March 2, 2021, committed to the driver-core tree March 23, 2021

Actually shipped to users
:   Linux 5.13, released June 27, 2021 — not Linux 5.12 (April 25, 2021), which shipped with the old default despite the revert's "for 5.12" wording

Not a CVE
:   a boot-reliability regression affecting specific platforms under specific firmware configurations, not a security vulnerability

*Part of [War Stories: Device Drivers](../war-stories.md).*

## Before state

`fw_devlink` turns dependency information already present in firmware descriptions — Device Tree properties like `clocks`, `interrupts`, `dmas`, `power-domains`, or ACPI's `_DEP` — into real kernel `device_link`s that gate probing, not just informational metadata. `fw_devlink_parse_fwtree()` walks the firmware node tree and calls each fwnode's `add_links` operation to discover these relationships; once both ends of a discovered dependency have a `struct device`, `fw_devlink_create_devlink()` turns it into an actual link. Two flag sets control what a link means once created:

```c
#define FW_DEVLINK_FLAGS_PERMISSIVE (DL_FLAG_INFERRED | DL_FLAG_SYNC_STATE_ONLY)
#define FW_DEVLINK_FLAGS_ON         (DL_FLAG_INFERRED | DL_FLAG_AUTOPROBE_CONSUMER)
```

Under `permissive`, an inferred link only gates the supplier's `sync_state()` callback — it doesn't block a consumer from probing before its supplier has. Under `on`, the link carries `DL_FLAG_AUTOPROBE_CONSUMER`: a consumer whose supplier hasn't probed yet gets deferred automatically via the driver core's existing `-EPROBE_DEFER` retry mechanism, with no driver code needed to request it. This wasn't fw_devlink's first attempt at a default flip, either — a full year earlier, `fw_devlink=permissive` itself had briefly been made the default (`c442a0d18744`, March 21, 2020), silently froze boot on Raspberry Pi 3B and 4 hardware, and was reverted six days later (`18555cb6db23`) before being re-enabled about a month after that (`c78c31b374a6`, April 28, 2020), once the underlying handling bug that commit's own message points to was fixed (`00b247557858`, "driver core: Fix handling of fw_devlink=permissive"). The `on` saga is the same pattern one level up, with a different mechanism (probe blocking rather than sync-state ordering) and a much longer resolution arc.

`fw_devlink_relax_cycle()` handles graphs where the inferred dependencies form a cycle: it walks the would-be consumer's own consumer chain, and if the would-be supplier is found to already depend transitively on the would-be consumer, every fw_devlink-inferred link in that cycle is downgraded to sync-state-only rather than left to deadlock probing indefinitely. The enabling commit's own message is explicit that this capability — merged just before the default flip — was the last blocker: "Cyclic dependencies in some firmware was one of the last remaining reasons fw_devlink=on couldn't be set by default. Now that cyclic dependencies don't block probing, set fw_devlink=on by default."

## The trigger

`e590474768f1` ("driver core: Set fw_devlink=on by default", Saravana Kannan, December 18, 2020) flips the one-line default and lists the expected benefits in its own commit message: "Significantly cuts down deferred probes. Device probe is effectively attempted in graph order. Makes it much easier to load drivers as modules without having to worry about functional dependencies between modules." It also anticipates the failure mode that in fact followed: "If this patch prevents some devices from probing, it's very likely due to the system having one or more device drivers that 'probe'/set up a device (DT node with compatible property) without creating a struct device for it."

## Observed behavior

That anticipated failure mode is exactly what surfaced, repeatedly, across unrelated platforms over the following two months. Renesas R-Car Gen3 boards stopped booting entirely — Geert Uytterhoeven, bisecting a report from Shimoda-san: "next-20210111 and later fail to boot on Renesas R-Car Gen3 platforms. No output is seen, unless earlycon is enabled. I have bisected this to commit e590474768f1cc04." The root cause: R-Car's System Controller registers power domains from an `early_initcall()` without ever creating a `struct device` for itself, so fw_devlink saw its consumers' declared dependency on it as permanently unsatisfiable. A first fix (`2dfc564bda4a`, "soc: renesas: rcar-sysc: Mark device node OF_POPULATED after init") wasn't sufficient on its own — Geert reported R-Car Gen2/Gen3 still hanging afterward on specific configurations (`CONFIG_RCAR_DMAC=n hangs: supplier e7310000.dma-controller not ready`), requiring further follow-up.

Separately, Guenter Roeck — a longtime kernel boot-CI maintainer — reported nios2 hanging under QEMU, with a bisect log pointing at the same commit, and added a detail that captures the scale of the problem better than any single-platform report could: "It may also break a variety of other boot tests, but with 115 of 430 boot tests failing in -next it is difficult to identify all culprits." Other fixes followed for other platforms in the same window: `e2c1b0ff38c9` converted i.MX's AVIC interrupt controller to `IRQCHIP_DECLARE` so fw_devlink would stop waiting for it to become a `struct device` at all ("boot issues on imx25 with fw_devlink=on that were reported by Martin"); `f265f06af194` fixed fw_devlink's handling of Device Tree's `interrupt-map` property, tested by Marek Szyprowski against Samsung Exynos hardware. Szyprowski appears as a tester across essentially the entire February 2021 hardening batch — a second major regression-reporting platform alongside R-Car and nios2.

## Why it happened

Every one of these regressions shared the same shape: fw_devlink's cycle-breaking logic was ready, but the more basic assumption underneath the whole mechanism — that a device referenced in a firmware description will, eventually, register a matching `struct device` — doesn't hold universally. Platform-specific controllers that configure themselves via early boot-time initcalls without ever going through the driver core's normal device-registration path are invisible to that assumption in a way no amount of cycle-detection logic addresses; fw_devlink simply waits forever for a `struct device` that is never coming. This is exactly the failure mode the enabling commit's own message predicted in the abstract — the problem was that the actual hardware matrix exercising it wasn't fully surfaced until the default had already flipped and a much wider range of real boot configurations started exercising the new code path.

## Resolution

Greg Kroah-Hartman reverted the default on February 18, 2021 (`3e4c982f1ce7`), with a message that reads as a plan rather than a retreat: "While things are _almost_ there and working for almost all systems, there are still reported regressions happening, so let's revert this default for 5.12. We can bring it back in linux-next after 5.12-rc1 is out to get more testing..." Saravana Kannan's "Take II" series followed on schedule — cover letter posted March 2, 2021: "This series fixes the last few remaining issues reported when fw_devlink=on by default... As far as I know, there shouldn't have any more issues you reported that are still left unfixed after this series." [sic] `ea718c699055` re-flipped the default the same day, committed into Greg's driver-core tree on March 23, 2021.

Here is the detail the "for 5.12" framing didn't anticipate: Take II never made it into Linus's mainline tree in time for Linux 5.12 at all. Comparing the actual v5.12 source directly against v5.13 confirms it: `drivers/base/core.c` in the final v5.12 tag still reads `fw_devlink_flags = FW_DEVLINK_FLAGS_PERMISSIVE`; `ea718c699055` is not an ancestor of v5.12 (`git compare` reports the two as diverged), but it *is* an ancestor of v5.13-rc1. Linux 5.12 released April 25, 2021 with the *old* default the entire time — the exact default the February revert had already put back — and `fw_devlink=on` first reached users only with v5.13-rc1, tagged May 9, 2021, and the full v5.13 release on June 27, 2021.

That gap between "Take II" being written and actually shipping mattered in practice. On April 26–28, 2021 — the day after v5.12 shipped — Florian Fainelli reported a new regression on Broadcom's ARCH_BRCMSTB platform, testing an internal 5.12-based build that already carried the not-yet-mainlined Take II patches: "This change breaks booting on SCMI-based platforms such as ARCH_BRCMSTB... the SCMI clock provider was never probed which means that our UART driver never got a chance to get its clock and we have no console." Diagnosis by Cristian Marussi and Jim Quinlan found the board's Device Tree declared its SCMI node with both a working SMC transport *and* a legacy `mboxes` phandle to a permanently `status = "disabled"` mailbox node, kept only for backward compatibility. fw_devlink faithfully turned that stale reference into a hard probe dependency, and since nothing ever binds a driver to a disabled mailbox device, the SCMI provider — and everything downstream of it, including the UART's clock — deferred forever.

This time, the resolution was explicitly not a kernel-core change. Saravana Kannan ranked the available workarounds in the thread: "1. Fix the DT sent to the kernel. 2. If deferred_probe_timeout=1 doesn't break anything else, use that... 3. Geert's early boot quirk suggestion. 4. fw_devlink=permissive (least preferred)... Changing the SCMI driver itself won't help fw_devlink." Fainelli confirmed removing the stale `mboxes` phandle from the board's DT fixed it — fw_devlink was, in this case, correctly enforcing a dependency the firmware description itself asserted; the bug was in the DT, and the old permissive default had simply never been strict enough to expose it. The same underlying SMC-versus-mailbox ambiguity on Broadcom STB SCMI nodes resurfaced years later under a different trigger — an unrelated 2024 SCMI transport refactor — and was finally addressed in the driver itself by `db8f0b808886` ("firmware: arm_scmi: Give SMC transport precedence over mailbox," October 2024). That commit's own `Fixes:` tag points at the 2024 refactor, not at the 2021 fw_devlink saga, so it's best read as the same class of firmware-description ambiguity resurfacing on new terms rather than a delayed fix for this specific 2021 episode.

## What it taught us

**Flipping a default that changes probe-order semantics platform-wide exposes a long tail of individual corners a review pass can't catch in advance — one hardware platform, one bus type, one legacy compatibility string at a time.** R-Car's early-initcall power controller, i.MX's AVIC, and Broadcom's stale mailbox phandle are three unrelated instances of the same specific gap: a device the graph says should exist, but that never actually registers a `struct device`. Samsung Exynos's `interrupt-map` fix was a different kind of gap in the same rollout — a parsing bug in how fw_devlink itself resolved an interrupt supplier through DT indirection, not a missing-device case at all. Different mechanisms, same lesson: a systemwide default change surfaces whatever the review process didn't happen to exercise, and it surfaces it one platform at a time.

**A revert commit's stated target release is a plan, not a fact about what will ship — verify against the tag the change actually lands in, not the date someone wrote it.** "Revert this default for 5.12" read, to anyone tracking the fix by that commit message alone, as a guarantee that 5.12 would carry the new default. Merge-window timing meant otherwise: the retry commit existed in a subsystem maintainer's tree for weeks before it was pulled into mainline, and the release it actually first shipped in was determined by that pull timing, not by the revert's own wording.

!!! warning "Pattern to watch for"
    When a kernel change flips a systemwide default that alters ordering or dependency enforcement, expect the real test matrix to be "every platform currently being actively tested," discovered incrementally after the flip — not the platforms exercised during review. And when tracking whether a specific fix or default change has "shipped," confirm against the actual tagged release it's an ancestor of, not the date on the commit that made the change — a fix authored and even committed to a maintainer's tree well before a release can still miss that release's merge window entirely.

## See also

- [Linux Device Model](../device-model.md) — `struct device`, buses, and the probe/link machinery fw_devlink builds on
- [Device Tree](../device-tree.md) — the firmware description format fw_devlink parses to discover dependencies
- [The Origin of Deferred Probing](deferred-probe-origin.md) — the `-EPROBE_DEFER` retry mechanism fw_devlink's `on` mode drives automatically
- [The uevent_show() Fix That Deadlocked Driver Detach](uevent-show-deadlock.md) — a different driver-core regression from the same subsystem, on a much shorter timescale

## External references

- [git.kernel.org: c78c31b374a6](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=c78c31b374a68be79cb4a03ef5b6c187f034e903) — "Revert 'Revert...'," the 2020 re-enable of the earlier `fw_devlink=permissive` default
- [git.kernel.org: e590474768f1](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=e590474768f1cc04852190b61dec692411b22e2a) — "driver core: Set fw_devlink=on by default," the first enable
- [git.kernel.org: 3e4c982f1ce7](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=3e4c982f1ce75faf5314477b8da296d2d00919df) — "Revert 'driver core: Set fw_devlink=on by default'"
- [git.kernel.org: ea718c699055](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=ea718c699055c8566eb64432388a04974c43b2ea) — "Revert 'Revert...'," Take II
- [git.kernel.org: 2dfc564bda4a](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=2dfc564bda4a31bc4439315448bd4da5182cb397) — the R-Car SYSC OF_POPULATED fix
- [git.kernel.org: e2c1b0ff38c9](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=e2c1b0ff38c961d49ce34efda48fa45eb1cb5f19) — the i.MX AVIC IRQCHIP_DECLARE fix
- [git.kernel.org: f265f06af194](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=f265f06af1948c90007c78fe9f2fa93d6cea8800) — the fw_devlink `interrupt-map` fix, Exynos-tested
- [git.kernel.org: db8f0b808886](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=db8f0b8088865150e4c9a8b8ffc9abdfd58bc4f7) — the 2024 Broadcom SCMI SMC-precedence fix, the same DT ambiguity resurfacing years later
- [lore.kernel.org: the original enable-patch thread](https://lore.kernel.org/r/20201218031703.3053753-6-saravanak@google.com/) — R-Car and nios2 regression reports
- [lore.kernel.org: the Take II thread](https://lore.kernel.org/r/20210302211133.2244281-4-saravanak@google.com/) — the ARCH_BRCMSTB/SCMI regression and its resolution as a DT bug
