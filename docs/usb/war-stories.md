# USB War Stories

> Three incidents that all trace back to one fact: USB is a bus where an *untrusted physical device* hands the kernel complex data to parse — and for years the kernel believed it

USB's conveniences — self-describing devices, hot-plug, drivers auto-loaded by the IDs a device claims — are all forms of the kernel *trusting whatever plugs in*. Every story below is that trust being abused: a device lying about what it is, or feeding a [descriptor](enumeration.md) parser input no real device would ever send.

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

## Further reading

- [USB overview](README.md) — the trust model and the descriptor tree these stories abuse
- [Kernel docs: USB authorization](https://docs.kernel.org/usb/authorization.html) — the `authorized`/`authorized_default` policy controls
- [Kernel docs: raw-gadget](https://docs.kernel.org/usb/raw-gadget.html) — the device-emulation interface that made the host stack fuzzable
