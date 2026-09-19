# USB War Stories

> Six incidents that trace back to two facts: USB is a bus where an *untrusted physical device* hands the kernel complex data to parse, and USB's hot-plug model means every code path has to survive the device disappearing out from under it mid-operation

USB's conveniences — self-describing devices, hot-plug, drivers auto-loaded by the IDs a device claims — cut both ways. The first three stories below are that trust being abused: a device lying about what it is, or feeding a [descriptor](enumeration.md) parser input no real device would ever send. The last three are the other side of the same coin: hot-plug means a device (or, in gadget mode, a host) can disappear mid-operation, and every code path that reaches toward it has to survive that disappearance — no malicious input required, just bad timing.

## 1. BadUSB: the device that lies about what it is (2014)

USB identity is **self-asserted**. Nothing binds a device's physical form to the descriptors it presents; a flash drive says "I am mass storage" only because its firmware chooses to. BadUSB, demonstrated at Black Hat 2014, weaponized this: reflash a normal USB stick's controller so that, *in addition* to being storage, it enumerates a second interface claiming to be a **HID keyboard** — and then "types" commands into the machine the instant it's plugged in. Nothing was exploited in the kernel; the kernel did exactly what USB says to do. The vulnerability *was* the trust model.

There is no patch for "USB trusts devices," so the kernel's answer is **policy, not a fix**: every USB device has an `authorized` flag in sysfs, and `authorized_default` can be set so newly-attached devices are **deauthorized until a human approves them** — the kernel enumerates them but binds no drivers. Paired with userspace tools like USBGuard (allow-list by device identity), this lets a locked-down machine refuse the surprise keyboard. See the kernel's [USB authorization](https://docs.kernel.org/usb/authorization.html) documentation.

**Lesson:** when identity is self-asserted, *authentication* has to live above the bus. The kernel can't tell a real keyboard from a malicious one, so it exposes the controls for a policy layer to decide.

## 2. CVE-2016-2384: a MIDI descriptor that frees twice

A device doesn't have to inject keystrokes to be dangerous — it just has to describe itself *impossibly*. CVE-2016-2384 was a **double-free** in the USB-MIDI driver (`snd-usbmidi`). When a device presented a USB-MIDI interface descriptor that the driver's setup path rejected, an error path freed the `umidi` object — and then a second cleanup path freed it again. A crafted descriptor (deliverable by any physical device, including a BadUSB one) turned that into a classic double-free, corrupting the allocator and opening the door to code execution.

The fix ([`07d86ca93db7`](https://git.kernel.org/linus/07d86ca93db7) "ALSA: usb-audio: avoid freeing umidi object twice") simply removed the duplicate free. But the *class* of bug — an error path in a descriptor parser mishandling attacker-shaped input — is the point: the parser was written assuming descriptors come from cooperating hardware.

**Lesson:** a descriptor parser is an attack-surface parser. Every count, length, and endpoint number in a descriptor is attacker-controlled, and the error paths (rarely exercised by real devices) are where the bugs hide.

## 3. Fuzzing the host from the device side: raw-gadget and syzkaller

For most of USB's history the host stack was effectively unfuzzable — you needed real malicious hardware to test it. That changed when the kernel gained the ability to *emulate* a USB device in software: **`dummy_hcd`** presents a virtual host controller wired to a virtual device controller, and **raw-gadget** lets a userspace program drive that device side byte-by-byte, presenting *any* descriptors and responses it likes. Andrey Konovalov wired this into **syzkaller**, and the fuzzer — now able to plug a fully attacker-controlled "device" into the host stack — found **hundreds** of bugs across USB drivers: out-of-bounds reads on truncated descriptors, use-after-frees on disconnect races, missing length checks.

The result was a wave of systematic hardening across the USB core and drivers — representative commit [`2e1c42391ff2`](https://git.kernel.org/linus/2e1c42391ff2) "USB: core: harden cdc_parse_cdc_header" — adding the length and bounds checks that had been missing because, until you could fuzz it, nobody fed those parsers malformed input. See the [raw-gadget](https://docs.kernel.org/usb/raw-gadget.html) documentation.

**Lesson:** the reason the parsers were fragile is the reason they got fixed — for decades the only way to send the host a malformed descriptor was special hardware, so that path went untested. Making the *device* side programmable turned an un-reachable attack surface into a fuzzable one.

## 4. CVE-2024-36896: unplugging a hub while sysfs is asking it a question

USB hubs expose per-port controls through sysfs, including a `disable` attribute (`drivers/usb/core/port.c`) that lets userspace power down a single port. Reading or writing it means walking from the port device up to the hub that owns it: `hdev = to_usb_device(dev->parent->parent)`, then `hub = usb_hub_to_struct_hub(hdev)`.

`usb_hub_to_struct_hub()` can return `NULL` — it does, precisely when the hub is in the middle of being removed. Both `disable_show()` and `disable_store()` skipped checking for that and dereferenced `hub->intfdev` immediately, assuming a hub device found via a live port must still have a hub structure behind it. KASAN and syzkaller found the resulting access violation: unplug a hub (or its parent) at the moment a `disable` sysfs read or write is in flight, and the handler dereferences a NULL pointer. The bug had been there since Linux 6.0, when the `disable` attribute itself was added.

The fix ([`a4b46d450c49`](https://git.kernel.org/linus/a4b46d450c49) "USB: core: Fix access violation during port device removal", Alan Stern, merged for 6.9) adds the missing `if (!hub) return -ENODEV;` check to both handlers — and, while there, replaces the `hub->intfdev` dereference with `dev->parent`, which reaches the same interface device without needing `hub` to still exist at all.

**Lesson:** a sysfs handler that walks a device's parent hierarchy is racing hot-unplug by construction — nothing prevents the device at the other end of that walk from being torn down between the lookup and the dereference. Where possible, reach data through a pointer that's guaranteed to outlive the lookup (like `dev->parent` here) rather than one that depends on a second object still being alive.

## 5. CVE-2026-80824: usbfs frees the device, then reads through it anyway

`usbfs` lets userspace submit and reap USB requests (URBs) directly against `/dev/bus/usb/*` nodes, including `mmap()`-backed buffers for zero-copy transfers. When a program closes its usbfs file descriptor, `usbdev_release()` tears everything down: it calls `usb_put_dev(dev)` to drop its reference to the `struct usb_device`, then walks the list of completed async URBs and frees each one with `free_async()`.

That ordering is backwards for `mmap()`-backed URBs. `free_async()` calls `dec_usb_memory_use_count()` for any URB whose buffer came from the usbfs mmap region, and that function's first statement dereferences `ps->dev->bus` — reading back through the very `usb_device` `usbdev_release()` just released. If usbfs's reference happens to be the device's last one — which, per the fix commit, can be the case right after a disconnect — `usb_put_dev()` has already freed it, and the drain loop reads a freed structure's memory and follows it as a `struct usb_hcd *`.

This isn't a narrow race window — it reproduces on every attempt. A live `MAP_SHARED` mapping holds its own reference on the open file, so `usbdev_release()` can't even run until every mapping of the usbfs fd is gone; by the time it does run, the freeing branch of `dec_usb_memory_use_count()` is guaranteed to be taken. An unprivileged process with read/write access to a `/dev/bus/usb` node can trigger it deterministically: `mmap()` the fd, submit one URB with a buffer inside the mapping, wait for the device to be unplugged, then `munmap()` and `close()`.

The fix ([`0dd68b5d01d0`](https://git.kernel.org/linus/0dd68b5d01d0) "usb: usbfs: fix use-after-free of usb_device in usbdev_release()", Miguel Peñaranda, merged for 7.3) simply reorders the two steps: drain and free the completed URBs first, then call `usb_put_dev()`. Nothing in between the two original steps needed the reference already dropped.

**Lesson:** "drop the reference, then clean up what depended on it" is backwards whenever the cleanup path can read back through the object the reference was protecting. The bug had been present since the mmap-zerocopy feature was added in Linux 4.6 — a decade during which the ordering only mattered if a program disconnected mid-flight in exactly this way.

## 6. CVE-2025-68282: a teardown flag closes a race its first fix didn't

USB gadget devices (the kernel acting as a USB *device* rather than a host — see [gadget internals](xhci-gadget.md)) report state changes (`configured`, `suspended`, and so on) via a `sysfs_notify()` call, deferred to a workqueue (`gadget->work`) so it doesn't run in whatever atomic context triggered the state change. `usb_del_gadget()` tears the gadget down: at some point it calls `flush_work()` to wait for any pending `gadget->work` to finish, then frees the gadget's memory.

The first version of this code had a subtler race than "some unrelated concurrent event." `device_del()` itself can synchronously schedule a fresh `gadget->work`: the fix commit traces one real call chain, `device_del() → gadget_unbind_driver() → usb_gadget_disconnect_locked() → dwc3_gadget_pullup() → dwc3_gadget_soft_disconnect() → usb_gadget_set_state() → schedule_work()`. If `flush_work()` ran *before* `device_del()`, that work item — scheduled by teardown itself, not by anything external — was left pointing at memory about to be freed. [`399a45e5237c`](https://git.kernel.org/linus/399a45e5237c) ("usb: gadget: core: flush gadget workqueue after device removal") fixed exactly that: it moved `flush_work()` to *after* `device_del()`, so the work `device_del()` itself triggers gets drained too. KASAN found this narrowed the window without closing it: a genuinely separate, concurrent event could still schedule a new work item between the (moved) `flush_work()` call and the gadget's memory actually being freed, reproducing the identical use-after-free.

The real fix ([`baeb66fbd420`](https://git.kernel.org/linus/baeb66fbd420) "usb: gadget: udc: fix use-after-free in usb_gadget_state_work", Jimmy Hu (Google), merged for 6.18) adds what the first attempt lacked: a `teardown` flag and a `state_lock` spinlock on `usb_gadget`. `usb_del_gadget()` sets the flag under the lock *before* calling `flush_work()`, and `usb_gadget_set_state()` — the only place that schedules the work — checks the flag under the same lock before queueing anything. Ordering two operations relative to each other (move the flush later) closed one window; a flag checked under a lock that both sides share closes all of them, regardless of ordering.

**Lesson:** a use-after-free caused by "something got scheduled after we thought cleanup was done" usually needs a state check guarded by the same lock the scheduling side uses, not a reordering of when cleanup happens — reordering narrows a race, a shared guarded flag closes it. The underlying bug dated back to Linux 3.12, and even the first, incomplete fix attempt shipped over a decade after the bug was introduced.

## Further reading

- [USB overview](README.md) — the trust model and the descriptor tree these stories abuse
- [Kernel docs: USB authorization](https://docs.kernel.org/usb/authorization.html) — the `authorized`/`authorized_default` policy controls
- [Kernel docs: raw-gadget](https://docs.kernel.org/usb/raw-gadget.html) — the device-emulation interface that made the host stack fuzzable
