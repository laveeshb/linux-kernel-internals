# The 21-Year-Latent USB Mixer Teardown Use-After-Free

> A 2005 commit gave every registered ALSA control a back-pointer to its USB mixer object. Nobody stopped that mixer object from being freed out from under a live control for nearly 21 years — until a failed probe did exactly that.

Landed
:   Linux, January 2026 (CVE-2026-23089)

Driver
:   `snd-usb-audio` (`sound/usb/mixer.c`)

Fix author
:   Berk Cem Goksel

Origin commit
:   `6639b6c2367f` (Clemens Ladisch, April 2005)

Mechanism
:   Use-after-free, `struct usb_mixer_interface`

CVE-2026-23089

*Part of [War Stories: ALSA Bugs and Regressions](../war-stories.md).*

## Before state

USB audio devices can report status changes — a jack plugged in, a volume knob turned on the hardware itself — over a dedicated USB status interrupt endpoint rather than requiring the driver to poll. `6639b6c2367f` ("[ALSA] usb-audio - add mixer control notifications"), authored by Clemens Ladisch and committed in April 2005, added the plumbing for this: when a status interrupt arrives, the driver needs to figure out which ALSA control(s) that notification applies to and fire the right callback.

That lookup is backed by `mixer->id_elems`, an array on `struct usb_mixer_interface` indexed by the USB descriptor's unit ID, with each populated slot pointing at a `struct usb_mixer_elem_list` node. Every ALSA control created while parsing the device's mixer descriptors gets its own such node — allocated separately from the `id_elems` array itself — and that node carries a `head.mixer` back-pointer to the `struct usb_mixer_interface` object that owns it. The notification-interrupt handler walks `id_elems` to find the right node; the node's own callbacks (mixer value reads among them) go the other direction, through `head.mixer`, whenever they need to reach the mixer object's own state.

## The trigger

`snd_usb_create_mixer()` builds up a device's full mixer — parsing every unit descriptor, creating an ALSA control for each — before calling `snd_card_register()` to make the card live. If mixer creation fails partway through (a malformed or partially-enumerated descriptor set, a USB-level failure mid-parse — the class of condition a hostile or malfunctioning USB device can trigger directly), the error path calls `snd_usb_mixer_free()` to unwind. That function frees `mixer->id_elems`, and then — at the very end — `kfree(mixer)`: the entire `struct usb_mixer_interface` object.

The problem: `snd_card_register()` can run — and the OSS-compatibility mixer emulation layer can walk the card's already-registered controls — even when the USB-side mixer setup failed. Controls that had already been registered on the sound card before the failure are separate allocations (`usb_mixer_elem_info`/`usb_mixer_elem_list` nodes) that survive `snd_usb_mixer_free()` untouched — but each one's `head.mixer` field is now a dangling pointer to the `usb_mixer_interface` that function just freed.

## Observed behavior

Any subsequent read through one of those surviving controls that dereferences `head.mixer` — the crash trace in the fix's commit message runs through `get_ctl_value()` reading `cval->head.mixer->protocol`, reached from the OSS mixer-emulation compatibility layer during `snd_card_register()` — touches freed heap memory. On a system where that memory had been reallocated for something else in the interim, this is a classic use-after-free: attacker-influenced data read as if it were mixer object state, or a crash if the freed page had been unmapped. NVD rates it CVSS 3.1 7.8 (HIGH), consistent with local privilege escalation via memory corruption rather than a remote vector — the trigger condition needs a malicious or malfunctioning USB device attached to the machine, not network input.

## Why it happened

The teardown path treated the mixer object as if it and the ALSA controls it had registered shared the same lifetime — free the mixer, and there'd be nothing left that could read it. That was true for controls that were never registered because mixer creation failed before reaching them. It was false for controls registered earlier in the same `snd_usb_create_mixer()` call, before the failure — those had already been handed to ALSA's core, which doesn't know or care that the USB-side mixer object that created them just tore itself down. The mixer's own lifetime and its readers' lifetime (registered ALSA controls, reachable independently through the card once registration succeeds) diverged, and the cleanup path only accounted for the mixer's own side of that divergence.

The bug sat unexercised for close to 21 years because it requires the specific combination of (a) at least one control successfully registered, then (b) mixer creation failing on a *later* unit, a sequencing a well-formed, fully-enumerable USB audio device essentially never produces on its own.

## Resolution

The fix (`930e69757b74`) changes `snd_usb_mixer_free()`'s teardown order: before freeing `id_elems` itself, it walks the array and calls `snd_ctl_remove()` on every populated entry's control, un-registering each one from the card first. Because `snd_ctl_remove()` deallocates the `usb_mixer_elem_list` node it's called on as a side effect, the walk saves each entry's `next_id_elem` pointer before making the call — using a value after the function that just freed it would just move the same bug one line down. Only once every control has been fully unregistered does the array itself get freed.

## What it taught us

**A cleanup function's job is to make every remaining reference into the thing it's freeing unreachable first, not just to free the thing.** The mixer object had exactly one owner (the USB probe path) but was reachable from many readers (every control that had been registered against it, via each one's `head.mixer` back-pointer) through a path — ALSA's own control-lookup machinery, reachable independently through the card — the mixer's teardown code didn't traverse.

**Partial-failure teardown paths are exactly where "the object shouldn't have any live readers by now" assumptions break**, because partial failure is definitionally the state where some initialization completed and some didn't — readers created by the completed part don't know the rest failed.

!!! warning "Pattern to watch for"
    A teardown/error path that frees a data structure without first checking whether anything created *before* the failure point still holds a reference into it — especially when that something (here, an ALSA control) is independently reachable through a different subsystem's own lookup path, not just through the object being freed.

## See also

- [ALSA Overview](../README.md) — `struct snd_card`, control registration, and where USB audio's mixer fits into the card lifecycle
- [The USB Audio Clock Descriptor Out-of-Bounds Reads](usb-audio-clock-descriptor-oob.md) — a different `sound/usb/` bug class: missing descriptor-length validation rather than a lifetime mismatch

## External references

- [NVD: CVE-2026-23089](https://nvd.nist.gov/vuln/detail/CVE-2026-23089) — CVSS 3.1 7.8 HIGH, CWE-416 (Use After Free)
- [git.kernel.org: 930e69757b74](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=930e69757b74c3ae083b0c3c7419bfe7f0edc7b2) — the fix: unregister every control before freeing the mixer object
- [git.kernel.org: 6639b6c2367f](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=6639b6c2367f884ca172b78d69f7da17bfab2e5e) — the April 2005 origin commit that introduced the notification-routing array
