# War Stories: Input/HID Bugs and Regressions

> Six incidents from the input core and HID subsystem — all six are CVEs, and two of the four quick cases below are themselves pairs: the same missing check, or the same bug shape, recurring years apart in a different part of the tree

[The Input Subsystem](README.md) and [The HID Subsystem](hid.md) document input core, evdev, and HID report parsing as they work today. This page is the incident record behind that architecture — mostly parser bugs (a device-supplied report descriptor, or an empty device-supplied list, read without validating it first) and timer-teardown races (a periodic timer not stopped synchronously before the memory it touches is freed).

## Deep dives

### [The Uninitialized HID Report Buffer Kernel Memory Leak](war-stories/uninitialized-report-buffer-leak.md)
**October 2024 (CVE published November 2024) · CVE-2024-50302 · CISA Known Exploited Vulnerabilities catalog**
A one-word fix — `kmalloc` should have been `kzalloc` — closed a heap leak that Google assessed was likely one of several zero-days a forensic device maker's hardware used in a phone-unlock chain, documented by Amnesty International's Security Lab.

### [The `hid_validate_values()` Type Confusion That a 2014 Bug Fix Introduced](war-stories/hid-validate-values-type-confusion.md)
**January 2023 (CVE published March 2023) · CVE-2023-1073**
A 2014 fix for a broken report-ID-0 lookup replaced a safe hash-table read with an unchecked list walk — introducing, as a side effect, a type confusion that sat unexploited for almost nine years purely by luck of memory layout.

## Quick cases

### Case 1: The Bluetooth HIDP idle-timer race — CVE-2023-54120

`net/bluetooth/hidp/core.c`'s session teardown stopped the connection's idle-timeout timer with `del_timer()` — asynchronous; it removes the timer from the pending-timer list but doesn't wait for a callback already running on another CPU to finish. The window: `hidp_del_timer()` runs while `hidp_idle_timeout()` is already executing elsewhere; teardown proceeds straight to `hidp_session_put()`, freeing the session; the still-running timer callback then touches freed memory. NVD's kernel.org-sourced score rates it CVSS 3.1 8.8 (HIGH).

The fix ([`c95930abd687`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=c95930abd687fcd1aa040dc4fe90dff947916460), Min Li, March 2023) is a one-line change: `del_timer(&session->timer)` → `del_timer_sync(&session->timer)`, which blocks until any in-flight callback has actually finished before returning. [NVD: CVE-2023-54120](https://nvd.nist.gov/vuln/detail/CVE-2023-54120).

### Case 2: The force-feedback timer use-after-free — CVE-2019-19524

`drivers/input/ff-memless.c`'s device-teardown path stopped all *playing* force-feedback effects — via `input_device_flush()` calling into `input_ff_flush()`, upstream of `ml_ff_destroy()` — but `ml_ff_destroy()` itself never stopped the underlying periodic `ml->timer`, which could still be pending or running when it freed the driver's private data a few lines later. A malicious or malfunctioning USB force-feedback device could trigger the teardown path while the timer was live.

The fix ([`fa3a5a1880c9`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=fa3a5a1880c91bb92594ad42dfe9eedad7996b86), Oliver Neukum, November 2019) adds `del_timer_sync(&ml->timer)` to `ml_ff_destroy()` before the `kfree()`, with a comment noting explicitly that flushing effects elsewhere doesn't stop the timer — the same class of gap as Case 1, in a different subsystem. [NVD: CVE-2019-19524](https://nvd.nist.gov/vuln/detail/CVE-2019-19524).

### Case 3: 14 force-feedback drivers, missing a list-emptiness check — CVE-2019-19532

A batch bug found by syzbot: 14 separate HID force-feedback quirk drivers (`hid-axff.c`, `hid-dr.c`, `hid-emsff.c`, `hid-gaff.c`, `hid-holtekff.c`, `hid-lg2ff.c`, `hid-lg3ff.c`, `hid-lg4ff.c`, `hid-lgff.c`, `hid-logitech-hidpp.c`, `hid-microsoft.c`, `hid-sony.c`, `hid-tmff.c`, `hid-zpff.c`) each called `list_first_entry()` or the equivalent `list_entry(hid->inputs.next, ...)` at probe time without first checking `&hid->inputs` was non-empty — three drivers used the former, the other eleven the latter. A malicious device presenting no input reports at all produces the same kind of bogus, type-confused pointer as [the `hid_validate_values()` bug](war-stories/hid-validate-values-type-confusion.md) — the same `list_entry`-family-on-a-possibly-empty-list mistake, at the per-driver probe layer instead of HID core, about three years earlier.

The fix ([`d9d4b1e46d95`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d9d4b1e46d9543a82c23f6df03f4ad697dab361b), Alan Stern, October 2019) adds an explicit `if (list_empty(&hid->inputs)) { hid_err(...); return -ENODEV; }` guard to all 14 drivers before the `list_first_entry()` call. [NVD: CVE-2019-19532](https://nvd.nist.gov/vuln/detail/CVE-2019-19532).

### Case 4: The GTCO tablet driver, the same function, two bugs under two years apart — CVE-2017-16643 and CVE-2019-13631

`parse_hid_report_descriptor()` in the GTCO digitizer/tablet driver (`drivers/input/tablet/gtco.c`) walks a device-supplied HID report descriptor byte by byte, and had two separate, unrelated-in-mechanism bugs in the same function:

- **2017**: the loop checked that at least one byte remained before each iteration, but each HID descriptor item can consume 1, 2, or 4 bytes depending on its prefix byte — so a one-byte-remaining check didn't guarantee a multi-byte read was safe, producing an out-of-bounds read past the descriptor buffer. Fixed by [`a50829479f58`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=a50829479f58416a013a4ccca791336af3c584c7) (Dmitry Torokhov, October 2017), adding a single `if (i + size > length)` check, hoisted above the switch statement, that covers all three read widths (1, 2, and 4 bytes) at once. [NVD: CVE-2017-16643](https://nvd.nist.gov/vuln/detail/CVE-2017-16643).
- **2019**: a completely different bug in the same function — a debug-message indentation counter tracking HID Collection/End Collection nesting depth had no bound, so a descriptor with deeply nested or unbalanced collections could write past the end of a fixed 10-byte indent-string array. Found via code review after a prior syzkaller report against the same driver. Fixed by [`2a017fd82c54`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=2a017fd82c5402b3c8df5e3d6e5165d9e6147dc1) (Grant Hernandez, July 2019), which adds two different checks: a `MAX_COLLECTION_LEVELS` upper-bound check before incrementing the indent counter (rejecting collections nested too deep), and a separate zero-floor check (`indent == 0`) before decrementing it (rejecting an unbalanced End-Collection that would underflow the counter). [NVD: CVE-2019-13631](https://nvd.nist.gov/vuln/detail/CVE-2019-13631).

## Common threads

| Pattern | Report buffer leak | `hid_validate` confusion | BT HIDP timer | ff-memless timer | 14-driver list check | GTCO (both) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Report-descriptor parsing (attacker controls the input) | — | Yes | — | — | Yes | Yes |
| `list_entry()`/`container_of()` on a possibly-empty list | — | Yes | — | — | Yes | — |
| Timer stopped asynchronously (or not at all) before teardown | — | — | Yes | Yes | — | — |
| Same bug shape recurs elsewhere, years apart | — | Yes (→ Case 3) | Yes (↔ Case 2) | Yes (↔ Case 1) | Yes (← type confusion) | Yes (within itself) |
| Real-world exploitation documented | Yes | — | — | — | — | — |

**Two of six are the same "list walked as if it can't be empty" mistake, about three years apart, at two different layers.** [`hid_validate_values()`'s type confusion](war-stories/hid-validate-values-type-confusion.md) (2023) is HID core calling `list_entry()` on a report list without checking it's non-empty; Case 3's 14 force-feedback drivers (2019) do the identical thing to `hid->inputs` at probe time, about three years *earlier*. Different call sites, same underlying gap in the same subsystem's use of the kernel's list primitives — closing the 2019 instances evidently didn't prompt an audit that would have caught the 2023 one in HID core itself.

**Two of six are a timer stopped the wrong way on teardown, in two unrelated subsystems — the same bug shape recurring, not just a shared category.** The BT HIDP session teardown (Case 1) and `ff-memless`'s device teardown (Case 2) both called an asynchronous or missing timer-stop before freeing the memory the timer's callback would touch — `del_timer()` instead of `del_timer_sync()`, or no stop call at all. Both fixes are one line: swap in the synchronous variant, or add the missing call.

**The GTCO driver is the one incident that's internally a pair, not a pairing with another case.** Two structurally unrelated bugs — a missing multi-byte-read bound check, and an unbounded indentation counter — both lived in the same function, surfaced under two years apart. Fixing the first didn't prompt a close-enough read of the rest of the function to catch the second.

**Only the report-buffer leak has documented real-world exploitation, and that's not because it's the most severe bug on this page in isolation** — CVE-2023-54120 (CVSS 8.8) and CVE-2023-1073 (type confusion) are both plausibly more dangerous as standalone primitives. What made the leak notable is that Google's Threat Analysis Group assessed it as likely one of at least three zero-days used by a commercial forensic-device maker's hardware in a working phone-unlock exploit before the fix shipped — documented by Amnesty International's Security Lab, whose report itself notes it's unclear which specific devices were part of the successful chain — a reminder that "most severe in isolation" and "most likely to actually get used" are different rankings.

## See also

- [The Input Subsystem](README.md) — `struct input_dev`, the event model, and evdev
- [The HID Subsystem](hid.md) — report descriptors, parsing, and the driver model every incident above lives inside
- [ALSA War Stories](../alsa/war-stories.md) — a sibling device-subsystem incident page with a similar shape: mostly CVEs, mostly descriptor-parsing and teardown-locking bugs
- [Timers and Timer Wheels](../interrupts/timers.md) — `del_timer()` vs `del_timer_sync()` and the async-vs-synchronous teardown distinction behind Cases 1 and 2
- [Locking](../locking/README.md) — general background on lock-scope and critical-section bugs
