# The `hid_validate_values()` Type Confusion That a 2014 Bug Fix Introduced

> A 2014 fix for a broken report-ID-0 lookup replaced a safe hash-table read with an unchecked list walk — introducing, as a side effect, a type confusion that sat unexploited for almost nine years purely by luck of memory layout.

Landed
:   Linux, January 2023 (CVE-2023-1073)

Driver
:   HID core (`drivers/hid/hid-core.c`)

Reporter
:   Pietro Borrello

Introducing commit
:   `1b15d2e5b807` (Kees Cook, 2014) — "HID: core: fix validation of report id 0"

Mechanism
:   Type confusion via unchecked `list_entry()` on an empty list

CVE-2023-1073

*Part of [War Stories: Input/HID Bugs and Regressions](../war-stories.md).*

## Before state

Every HID device's parsed report descriptor is organized by report type (input/output/feature) into a `report_enum` structure per type, each holding both a `report_id_hash[256]` array (direct lookup by report ID) and a `report_list` — a linked list of the same `struct hid_report` entries. Before 2014, `hid_validate_values()` looked up a report purely through the hash array: `report = hid->report_enum[type].report_id_hash[id];` — safe on any input, since an unpopulated slot is just a `NULL` array read.

## The trigger

Kees Cook's 2014 fix (`1b15d2e5b807`) addressed a real functional bug: some devices — the Logitech `lgff` gamepad family among them — numbered their single report starting at ID 1, not 0, so a driver calling `hid_validate_values()` with ID 0 to mean "give me the first report" got a `NULL` back from the hash lookup and the device stopped working. The fix special-cased ID 0: instead of the hash lookup, it walks `report_list` and takes the first entry.

To get that first entry, the new code called `list_entry()` directly on `hid->report_enum[type].report_list.next` — the standard Linux list convention where `list_entry()` uses `container_of()` to compute a pointer to the containing struct from a pointer to its embedded `list_head` field, with no runtime check that the list actually has any entries. On an **empty** list, `.next` doesn't point at a real `hid_report`; by definition of a circular empty list, it points back at the list head itself — which lives inside `report_enum`, not inside any `hid_report`. `container_of()` doesn't know that. It subtracts the `list_head` field's offset within `struct hid_report` from whatever pointer it's given, and hands back the result as if it *were* a `hid_report *` — landing at the `report_list` field itself, with the struct's later fields (as read/written by downstream code) falling inside the adjacent `report_id_hash[256]` array. A malicious HID device supplying a descriptor with zero reports of a given type triggers exactly this path.

## Observed behavior

Code downstream of the type-confused pointer then reads and writes fields of what it believes is a `struct hid_report` — but is actually reading and writing bytes that belong to `report_id_hash` and whatever memory sits around it in the real `report_enum` struct. This is type confusion, not a simple out-of-bounds access: the pointer is "valid" in the sense that it points at real, allocated memory, just memory of a completely different type and layout than the code operating on it assumes. NVD rates it CVSS 3.1 6.6. Borrello's own disclosure concluded that, in the specific instances found, the bug was **not actually exploitable** — the fields the type-confused pointer ends up reading/writing happen to land on parts of `report_id_hash` that are zero-initialized and stay that way, so the corruption has no observable effect under the layout current kernels happen to produce. The disclosure still recommended fixing it defensively, since that safety margin depends on struct layout details (padding, field ordering) that aren't guaranteed to hold — a future rearrangement, or structure-layout randomization, could turn today's inert type confusion into a real primitive.

## Why it happened

The bug's history is the sharpest part of this incident, and it runs the opposite direction from what a first read of the code might suggest. The 2014 commit didn't leave a pre-existing gap unaddressed — it *introduced* the vulnerable code path. Before 2014, `hid_validate_values()` never called `list_entry()` at all; every lookup went through the hash array, which is safe by construction (an unpopulated slot is just `NULL`). Fixing the report-id-0 problem required a different lookup strategy for that one case, and the strategy chosen — walk the list, take the first entry — introduced a list-walking primitive with no precedent elsewhere in the function to establish the "always check emptiness first" habit. The `Fixes: 1b15d2e5b807` tag on Borrello's 2023 patch makes the causal chain explicit: this is a fix *for* the 2014 commit, not an extension of it to a case it missed.

Pietro Borrello's disclosure also flagged a second instance of the same root pattern in `hid-bigbenff.c`'s probe function, confirming this wasn't a one-off logic slip specific to `hid_validate_values()`'s call site, but a pattern that had been copied or independently reproduced elsewhere in the HID tree.

## Resolution

The fix replaces the bare `list_entry()` call with `list_first_entry_or_null()`, a standard kernel helper that performs the same `container_of()` computation but first checks whether the list is empty and returns `NULL` if so — pushing the emptiness check into the primitive itself rather than relying on every call site to remember to check before calling `list_entry()`.

## What it taught us

**A bug fix that trades a safe access pattern for an unsafe one, in service of fixing an unrelated functional problem, can introduce a new vulnerability class as a side effect — and that side effect can go unnoticed for the better part of a decade if it happens to land somewhere memory layout keeps it inert.** The 2014 commit's authors were solving a real, narrow problem (report-id-0 lookups for a specific device family) and had no reason to think about list emptiness, because the code path they were replacing had never needed to. The empty-list case wasn't a known gap someone chose not to close; it was a new failure mode nobody was looking for, created by the fix itself.

**`list_entry()`/`container_of()` will silently produce a pointer to the wrong type of object when called on an empty list, because the macro has no way to know the list is empty — it just does pointer arithmetic.** `list_first_entry_or_null()` exists specifically so callers don't have to remember to check emptiness themselves; a bare `list_entry()` call on a list whose emptiness isn't already guaranteed by some invariant elsewhere is worth treating as suspect on sight.

!!! warning "Pattern to watch for"
    `list_entry()` (or a hand-rolled `container_of()` on a list's `.next` pointer) called without a preceding `list_empty()` check or an established invariant guaranteeing non-emptiness — especially when the list's population is driven by attacker-controlled input, like a device's own descriptor, that can legitimately produce zero entries.

## See also

- [The HID Subsystem](../hid.md) — report descriptors, `struct hid_report`, and where `hid_validate_values()` sits in the report-handling path
- [The Uninitialized HID Report Buffer Kernel Memory Leak](uninitialized-report-buffer-leak.md) — a different HID core bug, from a non-zeroing allocator rather than a list-emptiness gap
- [14 Force-Feedback Drivers, Missing List-Emptiness Check](../war-stories.md#case-3-14-force-feedback-drivers-missing-a-list-emptiness-check-cve-2019-19532) — the same list-emptiness-unchecked pattern, about 3.3 years *earlier*, at the per-driver probe layer instead of HID core

## External references

- [NVD: CVE-2023-1073](https://nvd.nist.gov/vuln/detail/CVE-2023-1073) — CVSS 3.1 6.6
- [oss-security: disclosure thread](https://www.openwall.com/lists/oss-security/2023/01/17/3) — Pietro Borrello's original report, January 17, 2023
- [git.kernel.org: b12fece4c648](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b12fece4c64857e5fab4290bf01b2e0317a88456) — the fix: `list_entry()` → `list_first_entry_or_null()`
- [git.kernel.org: 1b15d2e5b807](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=1b15d2e5b8077670b1e6a33250a0d9577efff4a5) — the 2014 commit that fixed a report-id-0 lookup bug and, as a side effect, introduced the unchecked `list_entry()` call this incident is about
