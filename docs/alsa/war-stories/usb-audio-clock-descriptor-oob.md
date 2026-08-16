# The USB Audio Clock Descriptor Out-of-Bounds Reads

> Three functions walked a USB audio device's clock-topology descriptors without checking any of them were actually long enough to hold the fields being read — and the CVE covering all three sat in CISA's Known Exploited Vulnerabilities catalog with a federal patch deadline.

Landed
:   Linux, November 2024 (CVE-2024-53150)

Driver
:   `snd-usb-audio` (`sound/usb/clock.c`)

Reporter
:   Benoît Sevens (Google)

Fix author
:   Takashi Iwai

Mechanism
:   Missing descriptor length validation, out-of-bounds read

CVE-2024-53150 — CISA Known Exploited Vulnerabilities catalog, BOD 22-01 deadline April 30, 2025

*Part of [War Stories: ALSA Bugs and Regressions](../war-stories.md).*

## Before state

A USB audio device describes its internal clock topology — where its sample clock comes from, whether it can select between multiple clock sources, whether it multiplies a source clock up — through a set of USB Audio Class (UAC) descriptors: clock source, clock selector, and clock multiplier units. `sound/usb/clock.c` walks these descriptors to answer questions like "what's this device's current sample rate reference," following unit-ID references the same way the mixer code (see [the mixer teardown use-after-free](mixer-teardown-use-after-free.md)) follows unit IDs through the device's audio-function topology.

## The trigger

Each descriptor type carries a `bLength` field stating how many bytes it actually occupies. `validate_clock_source()`, `validate_clock_selector()`, and `validate_clock_multiplier()` read fixed-offset fields out of these descriptors — and, for the selector, a variable-length `bNrInPins`-sized array of input-pin unit IDs plus UAC2/UAC3-specific trailing fields — without first confirming `bLength` was large enough to contain what they were about to read. A USB audio device (physical, hostile, or emulated purely in firmware/software presented to the host) can advertise a descriptor with a `bLength` far shorter than a well-formed one, and the driver reads past the end of the buffer that descriptor was copied into.

## Observed behavior

An out-of-bounds read of kernel heap memory, triggered purely by what a USB device announces during enumeration — no user interaction beyond plugging in (or having the kernel probe) the device required. NVD rates this CVSS 3.1 7.1 (HIGH). The clock-topology parse runs early, during device probe, so the bug is reachable the moment a malicious USB audio device is presented to a host — but that ease of triggering isn't what put it on CISA's Known Exploited Vulnerabilities catalog. KEV listing requires confirmed evidence of *active* exploitation, not just theoretical reachability; this CVE's presence there means CISA had specific evidence it was actually being exploited, which is also what came with a federal patch deadline (BOD 22-01) of April 30, 2025.

## Why it happened

The selector descriptor is the sharpest illustration of why this class of bug is easy to introduce and easy to miss: it isn't a fixed-size struct. `bNrInPins` is itself a field inside the descriptor, and the array of input-pin IDs it counts comes right after it, followed by more fields whose presence depends on which UAC revision — UAC2 or UAC3; clock source/selector/multiplier topology is a UAC2/UAC3-only concept, UAC1 devices don't carry these descriptors at all — the device claims. Validating "is this descriptor long enough" for a variable-length, revision-dependent structure means computing the expected length from fields you've already read out of the descriptor — you can't check the length before reading `bNrInPins`, only after, and only if you remember to gate everything that follows on that check. Three separate functions, three separate descriptor shapes, and the length check was missing from all three.

## Resolution

The fix (`a3dd4d63eeb4`) adds a `DESC_LENGTH_CHECK` macro and applies it — with the correct expected-length formula for each descriptor's shape — inside `validate_clock_source()`, `validate_clock_selector()`, and `validate_clock_multiplier()`. The selector's check accounts for its `bNrInPins`-sized trailing array plus the UAC2/UAC3-only fields, rather than treating it as fixed-size. The fix was backported to the stable trees (`096bb5b43edf7`).

## What it taught us

**A bug class doesn't stay confined to one function once the same descriptor-walking pattern gets copy-adapted to a sibling descriptor type.** All three clock-descriptor parsers needed the same fix because all three had the same shape: read fields at fixed offsets (or offsets computed from an earlier field) without confirming the buffer is that long. This is the same underlying mistake as [the 2019 mixer-unit descriptor OOB](../war-stories.md#case-3-the-mixer-unit-descriptor-oob-five-years-before-the-clock-descriptors-cve-2019-15117) five years earlier, in a different `sound/usb/` parser entirely — length-prefixed, variable-shape USB descriptors are a recurring source of this exact bug across the driver, not a one-off.

**"Do I have enough bytes for this fixed part" and "do I have enough bytes for the variable part whose size I just read" are two different checks, and a descriptor parser needs both, in that order.** Checking only the fixed header length and then trusting a count field you read from inside that header to index further into the buffer is the mistake that recurs across all three functions here.

!!! warning "Pattern to watch for"
    A parser for a length-prefixed, externally-supplied structure that reads a count/size field from *inside* the structure and then uses it to index further into the same buffer, without re-validating the buffer is long enough to cover what that count field just promised.

## See also

- [The 21-Year-Latent USB Mixer Teardown Use-After-Free](mixer-teardown-use-after-free.md) — a different `sound/usb/` lifetime bug, in the mixer rather than the clock-topology parser
- [ALSA Overview](../README.md) — where USB audio's device model fits into ALSA's card/component structure

## External references

- [NVD: CVE-2024-53150](https://nvd.nist.gov/vuln/detail/CVE-2024-53150) — CVSS 3.1 7.1 HIGH; CISA Known Exploited Vulnerabilities catalog, BOD 22-01 deadline 2025-04-30
- [git.kernel.org: a3dd4d63eeb4](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=a3dd4d63eeb452cfb064a13862fb376ab108f6a6) — the fix: `DESC_LENGTH_CHECK` applied to all three clock-descriptor validators
- [git.kernel.org: 096bb5b43edf](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=096bb5b43edf755bc4477e64004fa3a20539ec2f) — the stable-tree backport
