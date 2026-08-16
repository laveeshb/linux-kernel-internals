# The Uninitialized HID Report Buffer Kernel Memory Leak

> A one-word fix — `kmalloc` should have been `kzalloc` — closed a heap-memory leak that a forensic device maker had already turned into part of a working phone-unlock chain.

Landed
:   Linux, October 2024 (fix commit authored 2024-10-29; CVE-2024-50302 published by NVD November 2024)

Driver
:   HID core (`drivers/hid/hid-core.c`)

Reporter
:   Benoît Sevens (Google)

Mechanism
:   Uninitialized memory read, `hid_alloc_report_buf()`

CVE-2024-50302 — CISA Known Exploited Vulnerabilities catalog (added March 4, 2025)

*Part of [War Stories: Input/HID Bugs and Regressions](../war-stories.md).*

## Before state

A HID device — keyboard, gamepad, touchscreen, anything speaking the HID protocol — describes its own data format via a report descriptor, and the kernel allocates a buffer sized to hold one instance of that report before reading or writing it. `hid_alloc_report_buf()` in `drivers/hid/hid-core.c` is the function that allocates that buffer; it's used both for outbound reports (userspace or a driver setting an LED, a force-feedback effect) and inbound ones parsed off the wire.

## The trigger

`hid_alloc_report_buf()` allocated its buffer with plain `kmalloc()`. `kmalloc()` returns memory exactly as it was left by whatever previously used that page — it does not zero it. If a report field the buffer was sized to hold never actually got written — because the device sent a truncated or crafted report, or because a code path read a report back before every field in it had been populated — the read returned whatever kernel heap contents happened to occupy that memory, not zeros and not an error.

## Observed behavior

Reading an uninitialized report handed back stale kernel heap data to whatever consumed it — userspace via a HID raw-report interface, or a driver that then further processed the leaked bytes. NVD rates this CVSS 3.1 5.5 (CWE-908, use of uninitialized resource) — a straightforward information-disclosure primitive on its own. What makes this incident notable isn't the bug's mechanism, which is simple, but its use: CISA added CVE-2024-50302 to its Known Exploited Vulnerabilities catalog on March 4, 2025, and Amnesty International's Security Lab published a forensic report in February 2025 documenting Google Threat Analysis Group's identification of at least three zero-day vulnerabilities — including CVE-2024-50302 — likely exploited as part of a Cellebrite exploit chain used to unlock a Samsung Galaxy A32 belonging to a detained student activist in Belgrade in December 2024. Amnesty's report itself hedges both the chain and the hardware attribution: it states plainly that "it is unclear if each device listed... was part of the successful exploitation chain," and describes Cellebrite's Turbo Link adapter only as hardware that "may be used to facilitate such hardware-based attacks," not a confirmed match. A kernel information leak that reads as low-severity in isolation was, on Google's assessment, likely one link in a real device-unlock chain used against a specific person — even if the full chain and exact hardware aren't independently confirmed.

## Why it happened

`kmalloc()` is the default allocator reflex — it's faster than `kzalloc()` because it skips zeroing, and for a buffer the code is about to fully overwrite before ever reading it back, that's the correct choice. The bug is that not every path through HID report handling guarantees full-write-before-read: a device is free to send a report shorter than its own descriptor claims, or a code path can read a field the device never populated in this particular report, and the buffer's contents at that point are whatever `kmalloc()` handed back — attacker-influenced only in the sense that the attacker (the device) controls which bytes get requested from a partially-stale allocation, not in any more direct way. The fix accepts the small, constant cost of zeroing every report buffer up front rather than trying to audit and guarantee full-initialization on every one of HID core's many report-handling paths.

## Resolution

Commit `177f25d1292c` changes the single allocation call in `hid_alloc_report_buf()` from `kmalloc(len, flags)` to `kzalloc(len, flags)`. That's the entire fix — no other logic changes.

## What it taught us

**An uninitialized-memory bug doesn't need a clever trigger to be dangerous — it needs a real-world actor willing to use it as one piece of a larger chain.** Nothing about this bug's mechanism is exotic; it's the same "we assumed full-write-before-read and that assumption doesn't always hold" pattern that shows up across the kernel. What made it worth a forensic report wasn't novelty, it was that Google assessed a commercial device-unlocking product had likely found and weaponized it before the fix shipped.

**A one-line, low-risk fix (`kmalloc` → `kzalloc`) can close a bug most audits would rate as minor, right up until someone shows you the exploit chain it was part of.** The severity of an isolated primitive and the severity of what it enables once combined with other bugs are different questions, and a defender auditing HID core in isolation wouldn't necessarily see the second one from the first.

!!! warning "Pattern to watch for"
    A buffer allocated with a non-zeroing allocator, read back on any code path that doesn't first prove every byte was written since allocation — especially when what fills the buffer is attacker-influenced (a device's own report length, in this case) and can legitimately be shorter than the buffer's full size.

## See also

- [The HID Subsystem](../hid.md) — report descriptors, parsing, and where `hid_alloc_report_buf()` sits in the report-handling path
- [The `hid_validate_values()` Type Confusion](hid-validate-values-type-confusion.md) — a different HID core bug, from a missing list-emptiness check rather than uninitialized memory

## External references

- [NVD: CVE-2024-50302](https://nvd.nist.gov/vuln/detail/CVE-2024-50302) — CVSS 3.1 5.5, CWE-908 (Use of Uninitialized Resource); CISA Known Exploited Vulnerabilities catalog, added 2025-03-04
- [git.kernel.org: 177f25d1292c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=177f25d1292c7e16e1199b39c85480f7f8815552) — the fix: `kmalloc()` → `kzalloc()` in `hid_alloc_report_buf()`
- [Amnesty International Security Lab: "Cellebrite zero-day exploit used to target phone of Serbian student activist"](https://securitylab.amnesty.org/latest/2025/02/cellebrite-zero-day-exploit-used-to-target-phone-of-serbian-student-activist/) (February 2025) — the forensic report documenting real-world use of this CVE as part of a phone-unlock exploit chain
