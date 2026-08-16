# The `hid_validate_values()` Type Confusion, Nine Years in the Making

> A 2014 fix for one report-lookup edge case left a second one standing: an empty report list, iterated as if it couldn't be, produced a fake report pointer that overlapped the very structure it came from.

Landed
:   Linux, January 2023 (CVE-2023-1073)

Driver
:   HID core (`drivers/hid/hid-core.c`)

Reporter
:   Pietro Borrello

Prior commit
:   `1b15d2e5b807` (Kees Cook, 2014) — "HID: core: fix validation of report id 0"

Mechanism
:   Type confusion via unchecked `list_entry()` on an empty list

CVE-2023-1073

*Part of [War Stories: Input/HID Bugs and Regressions](../war-stories.md).*

## Before state

Every HID device's parsed report descriptor is organized by report type (input/output/feature) into a `report_enum` structure per type, each holding a `report_list` — a linked list of `struct hid_report` entries, one per distinct report ID the device declared for that type. `hid_validate_values()` looks up a specific report by walking that list, and needs a starting point to hand to the list-walking macros.

## The trigger

To get that starting point, `hid_validate_values()` called `list_entry()` directly on `hid->report_enum[type].report_list.next` — the standard Linux list convention where `list_entry()` uses `container_of()` to compute a pointer to the containing struct from a pointer to its embedded `list_head` field, with no runtime check that the list actually has any entries. On an **empty** list, `.next` doesn't point at a real `hid_report`; by definition of a circular empty list, it points back at the list head itself — which lives inside `report_enum`, not inside any `hid_report`. `container_of()` doesn't know that. It subtracts the `list_head` field's offset within `struct hid_report` from whatever pointer it's given, and hands back the result as if it *were* a `hid_report *` — landing somewhere inside the `report_enum` structure that contains the list head, specifically overlapping its `report_id_hash[256]` array. A malicious HID device supplying a descriptor with zero reports of a given type triggers exactly this path.

## Observed behavior

Code downstream of the type-confused pointer then reads and writes fields of what it believes is a `struct hid_report` — but is actually reading and writing bytes that belong to `report_id_hash` and whatever memory sits around it in the real `report_enum` struct. This is type confusion, not a simple out-of-bounds access: the pointer is "valid" in the sense that it points at real, allocated memory, just memory of a completely different type and layout than the code operating on it assumes. NVD rates it CVSS 3.1 6.6.

## Why it happened

The bug's history is the sharpest part of this incident. In 2014, Kees Cook's commit `1b15d2e5b807` fixed a *related* but narrower problem: report ID 0 needing special-case handling in report lookups. That fix addressed the report-id-0 case specifically — it did not add a general "is this list actually empty" guard to `hid_validate_values()`'s list-walking logic. The empty-list case sat unaddressed for nine more years, not because anyone had ruled it out, but because the 2014 fix's scope never covered it in the first place. A malicious device supplying zero reports of a given type is a straightforward, only-slightly-unusual descriptor shape — not an edge case requiring careful crafting to reach, just one that a full-coverage fix for a narrower symptom didn't happen to close.

Pietro Borrello's disclosure also flagged a second instance of the same root pattern in `hid-bigbenff.c`'s probe function, confirming this wasn't a one-off logic slip specific to `hid_validate_values()`'s call site, but a pattern that had been copied or independently reproduced elsewhere in the HID tree.

## Resolution

The fix replaces the bare `list_entry()` call with `list_first_entry_or_null()`, a standard kernel helper that performs the same `container_of()` computation but first checks whether the list is empty and returns `NULL` if so — pushing the emptiness check into the primitive itself rather than relying on every call site to remember to check before calling `list_entry()`.

## What it taught us

**A fix scoped to the specific symptom reported doesn't necessarily close the general class of bug the symptom came from — and nine years is a realistic gap between the two, not a hypothetical one.** The 2014 fix solved the report-id-0 problem it was written for. It didn't ask "what happens if this list is empty in any other case," and the answer to that broader question sat unexamined until a fresh disclosure nine years later.

**`list_entry()`/`container_of()` will silently produce a pointer to the wrong type of object when called on an empty list, because the macro has no way to know the list is empty — it just does pointer arithmetic.** `list_first_entry_or_null()` exists specifically so callers don't have to remember to check emptiness themselves; a bare `list_entry()` call on a list whose emptiness isn't already guaranteed by some invariant elsewhere is worth treating as suspect on sight.

!!! warning "Pattern to watch for"
    `list_entry()` (or a hand-rolled `container_of()` on a list's `.next` pointer) called without a preceding `list_empty()` check or an established invariant guaranteeing non-emptiness — especially when the list's population is driven by attacker-controlled input, like a device's own descriptor, that can legitimately produce zero entries.

## See also

- [The HID Subsystem](../hid.md) — report descriptors, `struct hid_report`, and where `hid_validate_values()` sits in the report-handling path
- [The Uninitialized HID Report Buffer Kernel Memory Leak](uninitialized-report-buffer-leak.md) — a different HID core bug, from a non-zeroing allocator rather than a list-emptiness gap
- [14 Force-Feedback Drivers, Missing List-Emptiness Check](../war-stories.md#case-3-14-force-feedback-drivers-missing-a-list-emptiness-check-cve-2019-19532) — the same `list_entry()`-on-a-HID-supplied-list pattern, four years later, at the per-driver probe layer instead of HID core

## External references

- [NVD: CVE-2023-1073](https://nvd.nist.gov/vuln/detail/CVE-2023-1073) — CVSS 3.1 6.6
- [oss-security: disclosure thread](https://www.openwall.com/lists/oss-security/2023/01/17/3) — Pietro Borrello's original report, January 17, 2023
- [git.kernel.org: b12fece4c648](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b12fece4c64857e5fab4290bf01b2e0317a88456) — the fix: `list_entry()` → `list_first_entry_or_null()`
- [git.kernel.org: 1b15d2e5b807](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=1b15d2e5b8077670b1e6a33250a0d9577efff4a5) — the 2014 commit that fixed the narrower report-id-0 case without closing the general empty-list gap
