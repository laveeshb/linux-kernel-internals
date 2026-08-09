# Block Layer War Stories

> Real bugs where the block layer met the messy reality of hardware, concurrency, and stacked devices — and what each one taught

The block layer's job looks simple: carry bytes between memory and a device. In practice it sits between untrusted device firmware below and a tower of stacked virtual devices above, all while I/O flows concurrently and the configuration can change underneath it. Each of these stories is a place where one of those realities bit hard.

## 1. The SSD that lied about TRIM

**Symptom.** Filesystems on certain SSDs developed silent data corruption once `discard` (TRIM) was enabled — files reading back as zeros or garbage, with no I/O errors reported.

**Root cause.** For performance, the kernel had begun issuing **queued** DSM TRIM commands (NCQ TRIM) — letting a TRIM ride alongside normal reads and writes instead of draining the queue first. Some drives' firmware mishandled this: a queued TRIM could return incorrect data or affect the wrong logical blocks. The hardware advertised support for queued TRIM; it just didn't work.

**Fix.** The kernel maintains a per-device quirk list. Affected models were flagged to force **unqueued** TRIM, starting with [`6fc4d97a4987`](https://git.kernel.org/linus/6fc4d97a4987) ("libata: Blacklist queued TRIM on Samsung SSD 850 Pro") and growing into a broader `ATA_HORKAGE_NO_NCQ_TRIM` blacklist.

**Lesson.** "The device reports that it supports X" is a claim, not a guarantee. A storage stack that trusts firmware blindly will corrupt data; a per-device quirk/blacklist is an unglamorous but essential defense, and it never really shrinks.

## 2. The page that changed mid-flight

**Symptom.** Sporadic, maddeningly unreproducible integrity errors on setups using **iSCSI data digests**, **DIF/DIX** protection information, or software RAID — a checksum computed over data that was correct in memory would fail to match downstream.

**Root cause.** During writeback, the CPU can modify a page *while the device is still reading it out via DMA*. If a lower layer computes a checksum over the page and the contents change between checksum and transmission, the check fails — or worse, wrong data is written with a valid-looking checksum. The remedy is **stable pages**: layers that need the page to hold still advertise `BDI_CAP_STABLE_WRITES`, and the writeback path then waits for in-flight writeback before letting the page be dirtied again.

The bug was in propagation. Device-mapper did not carry `BDI_CAP_STABLE_WRITES` up from an underlying device that required it, so a `dm` device stacked on top wouldn't wait — producing the sporadic checksum errors ([`eb40c0acdc34`](https://git.kernel.org/linus/eb40c0acdc34), "dm table: propagate BDI_CAP_STABLE_WRITES to fix sporadic checksum errors"). The iSCSI side had the mirror problem: it only set the flag when a data digest was actually enabled ([`89d0c804392b`](https://git.kernel.org/linus/89d0c804392b)).

**Lesson.** In a stacked block device, a correctness requirement is only as strong as its *weakest* layer. A capability that one layer silently drops on the way up breaks the entire stack — and the resulting bugs are rare and non-deterministic, the hardest kind to chase.

## 3. Swapping the engine while the car is moving

**Symptom.** Crashes and use-after-free reports when changing a device's I/O scheduler at runtime (`echo bfq > /sys/block/sdX/queue/scheduler`) under load.

**Root cause.** Switching the elevator tears down the old scheduler's per-queue state and builds the new one — all while I/O may still be referencing the old state. Releasing the queue's sysfs lock partway through the switch opened a window for a concurrent path to touch freed scheduler data.

**Fix.** Hold the queue's sysfs lock across the *entire* switch, closing the window ([`b89f625e28d4`](https://git.kernel.org/linus/b89f625e28d4), "block: don't release queue's sysfs lock during switching elevator").

**Lesson.** Runtime-reconfigurable subsystems — swap the scheduler, resize the queue, all while live I/O flows — are a rich seam of lifetime bugs. The fix is almost always the same shape: make the transition atomic with respect to everything that can observe it.

## The recurring themes

Across these very different failures, the same three pressures show up:

- **Don't trust the hardware.** Firmware lies; the block layer needs quirk lists and defensive checks (story 1).
- **Requirements must propagate.** Stacked devices only work if every layer honors the constraints of the layers below (story 2).
- **Reconfiguration races the datapath.** Anything you can change at runtime can be changed *during* an I/O (story 3).

## Further reading

- [Kernel docs: block layer](https://docs.kernel.org/block/index.html)
- [`6fc4d97a4987`](https://git.kernel.org/linus/6fc4d97a4987) — the first queued-TRIM blacklist entry
- [`eb40c0acdc34`](https://git.kernel.org/linus/eb40c0acdc34) — stable-writes propagation through device-mapper
- [`b89f625e28d4`](https://git.kernel.org/linus/b89f625e28d4) — the elevator-switch locking fix
