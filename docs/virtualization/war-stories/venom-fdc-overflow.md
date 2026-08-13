# VENOM: The Floppy Controller Nobody Turned Off

> CVE-2015-3456 — QEMU's floppy disk controller emulation is instantiated for every default x86 machine type whether or not a guest has a floppy drive configured, and its command FIFO had no bounds check at all — a guest that never touched a floppy could still overflow it straight into the host's heap

Disclosed
:   May 13, 2015 (coordinated disclosure, CrowdStrike)

CVSS
:   7.7 (CVSS v2, `AV:A/AC:L/Au:S/C:C/I:C/A:C` — no CVSS v3 score was ever assigned)

Bug present since
:   the FDC emulation file's own copyright headers date to 2003, over a decade before disclosure

Fixed in
:   commit `e907746266721`, QEMU (not the Linux kernel — this bug lives entirely in QEMU's device-emulation userspace code), May 12, 2015

Exploit tool
:   no public working exploit independently confirmed

Actively exploited
:   no confirmed cases (not on CISA KEV)

*Part of [War Stories: Virtualization (KVM) Bugs and Escapes](../war-stories.md).*

## Before state

QEMU's Floppy Disk Controller emulation (`hw/block/fdc.c`) models the Intel 82078 controller chip, command FIFO and all. Since floppy drives predate every modern x86 machine type by decades but the PC platform's device model still assumes one might exist, `pc_basic_device_init()` instantiates the FDC unconditionally for the default PIIX and ICH9 machine types — no check for whether the user configured `-drive if=floppy` or any floppy media at all. A guest with no floppy drive attached still has a live, guest-accessible FDC at the standard I/O ports, because both KVM's QEMU and Xen's HVM device model share this same code.

The FDC's command FIFO is a fixed 512-byte heap buffer (`fdctrl->fifo = qemu_memalign(512, FD_SECTOR_LEN)`, `FD_SECTOR_LEN` = 512), used for both command/parameter bytes and PIO sector-data staging. `fdctrl_write_data()`'s job is straightforward: index into that buffer with `fdctrl->data_pos`, write the guest-supplied byte, increment. Under ordinary operation, whatever command handler is running resets `data_pos` back to zero once it has consumed the parameters it needs — so the index index never has a chance to run away.

## The trigger

Two command handlers don't reset it. `FD_CMD_READ_ID` arms a one-shot 20-millisecond timer and returns immediately, without touching `data_pos`/`data_len` at all — the reset only happens later, when the timer fires. `FD_CMD_DRIVE_SPECIFICATION_COMMAND` only resets the FIFO if the final parameter byte has a specific bit set; if a guest sends that byte with the bit clear, the handler does nothing whatsoever — no reset, no state transition, no error.

Either way, the controller is left in "still expecting FIFO writes" state with `data_pos` untouched. `fdctrl_write_data()` had no bound of its own — it trusted the command handlers to keep `data_pos` in range by resetting it. A guest that issues one of these two commands and then just keeps writing to the FDC's data port (`0x3f5`) drives `data_pos` past 512 with nothing to stop it, one guest-controlled byte at a time, straight past the end of the heap-allocated FIFO buffer.

## Observed behavior

This is a classic heap buffer overflow with both the content and the length under full guest control — a guest process needs no special privilege beyond ordinary I/O-port access to trigger it, and no floppy drive needs to be configured for the FDC to be present and vulnerable. Red Hat's technical analysis of the flaw summarized the impact plainly: an attacker able to corrupt adjacent heap memory in the host QEMU process this way has a path to a full guest-to-host virtual machine escape — arbitrary code execution on the host, not merely a guest or QEMU-process crash. Because the same vulnerable FDC code is shared by KVM's QEMU and by Xen's HVM device model (both the historical `qemu-xen-traditional` and the upstream-QEMU-based device model, per Xen's own advisory XSA-133), the practical exposure spanned both major open-source hypervisor stacks — any x86 HVM guest without a stub-domain was affected, regardless of what device the guest administrator thought they'd configured.

## Why it happened

The FDC's command handlers were written under an implicit, undocumented contract: every command must either consume exactly its declared parameters and then reset the FIFO index, or the FIFO index simply won't advance further. `FD_CMD_READ_ID`'s deferred, timer-based reset and `FD_CMD_DRIVE_SPECIFICATION_COMMAND`'s conditional reset were each, on their own terms, reasonable implementations of a real hardware timing/protocol detail — real floppy controllers genuinely have asynchronous, multi-phase command sequences. Neither handler was written with an attacker in mind, and neither `fdctrl_write_data()` nor `fdctrl_read_data()` was written to defend itself against a command handler that (correctly, per spec) doesn't reset the index on every call. The bug is the gap between "the handlers usually reset the index" and "the buffer-access code assumes they always do."

## Resolution

`e907746266721` ("fdc: force the fifo access to be in bounds of the allocated buffer") stops trusting the command handlers and bounds the buffer access directly: every FIFO index — in `fdctrl_read_data()`, `fdctrl_write_data()`, and `fdctrl_handle_drive_specification_command()` — is now taken modulo `FD_SECTOR_LEN` immediately before use. `data_pos` itself can still grow without limit, but the actual array index it produces is always clamped back into the allocated 512 bytes. A follow-up commit, `6cc8a11c84ddc`, separately tightened the controller's MSR "Request for Master" (RQM) status bit to correctly reflect whether the controller is actually expecting FIFO input at any given phase — a spec-correctness fix that further narrows when the FIFO can be driven at all, on top of the memory-safety fix that closes the overflow outright.

## What it taught us

**A buffer-access function that trusts its callers to keep an index in range needs its own bound, not a hope that every caller remembers to reset the index correctly.** Two command handlers, each independently reasonable in isolation, both happened to leave that implicit contract unfulfilled — and the buffer code had no defense of its own when they did.

**Device emulation that's instantiated unconditionally is attack surface whether or not the corresponding hardware is "in use."** No floppy drive needed to be configured, mounted, or even present in the guest's boot order for this bug to be reachable — the FDC was live at the ports the moment the VM started, simply because the default machine type wires it up.

!!! warning "Pattern to watch for"
    A legacy or rarely-used device model, kept around for compatibility and instantiated by default regardless of whether any guest actually uses it, is exactly the kind of code that stops getting security scrutiny while remaining fully guest-reachable. If a device is unconditionally present in a default machine type, its buffer-handling code needs the same defensive bounds-checking as anything a guest can reach directly — "nobody uses floppy drives anymore" is not a mitigation.

## See also

- [KVM Architecture](../kvm-arch.md) — the /dev/kvm API and QEMU's role as the userspace half of the virtualization stack
- [KVM Exit Handling](../kvm-exits.md) — how guest I/O-port accesses like the FDC's data port reach QEMU's device-emulation code
- [The Deadlock Detector That Scheduled While Atomic](../../locking/war-stories/rtmutex-deadlock-detector-atomic-sleep.md) — a comparably narrow gap in trusted-caller assumptions, in an unrelated subsystem

## External references

- [GitHub mirror: e907746266721](https://github.com/qemu/qemu/commit/e907746266721f305d67bc0718795fedee2e824c) — "fdc: force the fifo access to be in bounds of the allocated buffer," the fix
- [GitHub mirror: 6cc8a11c84ddc](https://github.com/qemu/qemu/commit/6cc8a11c84ddc18c64fc88d54c8e9dca24ada489) — "fdc: Fix MSR.RQM flag," the follow-up spec-correctness hardening
- [Xen Security Advisory XSA-133](https://xenbits.xen.org/xsa/advisory-133.html) — confirms the shared QEMU device-model exposure across both Xen device models
- [Red Hat: VENOM, don't get bitten](https://access.redhat.com/blogs/product-security/posts/1976633) — technical analysis of the FIFO-index reset gap and the unconditional FDC instantiation
- [NVD: CVE-2015-3456](https://nvd.nist.gov/vuln/detail/CVE-2015-3456) — CVE record, CVSS v2 7.7, published May 13, 2015
