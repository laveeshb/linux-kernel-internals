# The Input Subsystem: One Model for Every Keyboard, Mouse, and Touchscreen

> How Linux turns a PS/2 keyboard, a USB mouse, and an I2C touchscreen into the same `struct input_event` stream — one kernel-level object model shared by every HID-class device, with `/dev/input/eventN` as the uniform handoff point to userspace

## Getting Started

Every input device is, at bottom, a stream of discrete state changes: a key went down, a wheel turned two clicks, a finger touched down at (412, 900). But the hardware producing those changes is wildly heterogeneous — PS/2 controllers, USB HID devices, I2C/SPI touch controllers, Bluetooth peripherals, GPIO-wired buttons — and if every driver invented its own ioctl set and its own device-node convention, every window system and every application would need a driver-specific backend for each one. The **input subsystem**, living under `drivers/input/`, exists to prevent that: it gives every driver one shared object (`struct input_dev`), one event structure (`struct input_event`), and one small vocabulary of event types, so that from userspace's point of view a keyboard, a mouse, a joystick, and a touchscreen all look like the same kind of thing — a character device that emits a stream of typed, coded, timestamped events.

### The problem the input subsystem solves

Before this model existed, individual driver subsystems (the console keyboard driver, the PS/2 mouse driver, joystick drivers) each exposed their own bespoke interface, and every application that wanted keyboard or pointer input had to know which one it was talking to. The input subsystem, whose core lives in `drivers/input/input.c` and whose data structures are declared in [`include/linux/input.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/input.h) and [`include/uapi/linux/input.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/input.h), splits the problem into three layers:

- **Device drivers** (`drivers/input/keyboard/`, `drivers/input/mouse/`, `drivers/input/touchscreen/`, `drivers/hid/`, and many more) know how to talk to specific hardware and turn raw interrupts/reports into typed events. This is the layer a device-specific driver author writes.
- **The input core** owns `struct input_dev` and `struct input_handler`, and is the switchboard between them: every event a driver reports gets dispatched to every handler currently attached to that device.
- **Input handlers** consume the event stream. The one nearly everything cares about is **evdev**, which exposes the raw event stream to userspace as a character device. Two older, narrower handlers — **mousedev** (`/dev/input/mice`, a synthesized PS/2-mouse-protocol stream) and **joydev** (`/dev/input/jsN`, the legacy joystick API) — still exist for compatibility, but evdev is the general-purpose interface everything modern is built on.

The result is that a driver author only has to learn one API to make a new device usable by every input-aware program on the system, and a userspace program only has to learn one event format to read from any input device, regardless of the bus or protocol underneath.

### The core object model: `struct input_dev`

A driver's job is to build one `struct input_dev`, describe what kinds of events it can produce, and register it. Three calls carry almost the whole life cycle:

1. **`input_allocate_device()`** (or the devres-managed **`devm_input_allocate_device(dev)`**, which ties the input device's lifetime to the owning `struct device` and needs no explicit unregister) allocates and zeroes a `struct input_dev`, initializes its mutex and `event_lock` spinlock, and calls `dev_set_name(&dev->dev, "input%lu", ...)` once to give it its permanent sysfs identity — this `inputN` number is never changed by `input_register_device()` and stays fixed for the device's whole life. A driver's human-readable label lives in a separate field, `dev->name` (the `N: Name=` line in `/proc/bus/input/devices`); registration does not use it to rename anything. Where that `inputN` entry shows up in sysfs also depends on whether the device has a parent: `devm_input_allocate_device(dev)` sets `input->dev.parent = dev`, so a hardware-backed device registered this way appears under its physical parent's sysfs path (with a symlink from `/sys/class/input/`); only parentless devices land directly under `/sys/devices/virtual/input/`.
2. The driver declares **capabilities** — which event types and which codes within each type the device can produce — by setting bits in the device's capability bitmaps. This can be done directly:

   ```c
   __set_bit(EV_KEY, input_dev->evbit);
   __set_bit(KEY_A, input_dev->keybit);
   __set_bit(EV_REL, input_dev->evbit);
   __set_bit(REL_X, input_dev->relbit);
   ```

   or through the helper `input_set_capability(dev, type, code)`, which sets the per-type bit (`keybit`, `relbit`, `absbit`, `mscbit`, `swbit`, `ledbit`, `sndbit`, `ffbit`) *and* the corresponding bit in `dev->evbit` in one call. For absolute axes, `input_set_abs_params(dev, axis, min, max, fuzz, flat)` additionally allocates the axis's `struct input_absinfo` and fills in `minimum`, `maximum`, `fuzz`, and `flat` — `value` is left at zero (the driver reports it later via ordinary `input_report_abs()` calls) and `resolution` needs a separate `input_abs_set_res(dev, axis, res)` call if the device provides one. Every `EV_ABS` axis needs an `absinfo` entry, and `input_register_device()` refuses to register a device that declares `EV_ABS` capability without any `absinfo` array.
3. **`input_register_device()`** finalizes the device: it unconditionally sets the `EV_SYN` bit (every input device is required to emit synchronization events, whether or not the driver remembered to declare it), clamps out the reserved `KEY_RESERVED` keycode, calls `device_add()` to make the device visible in sysfs, and walks the list of registered input handlers, attaching any whose `match()`/`id_table` accepts this device — which is what causes an evdev node to appear.

`struct input_dev` itself (defined in `include/linux/input.h`) is built almost entirely out of capability bitmaps sized by the corresponding `*_CNT` constant from `input-event-codes.h` — `evbit[BITS_TO_LONGS(EV_CNT)]`, `keybit[BITS_TO_LONGS(KEY_CNT)]`, `relbit`, `absbit`, `mscbit`, `ledbit`, `sndbit`, `ffbit`, `swbit` — plus identity fields (`name`, `phys`, `uniq`, `id`), the live-state mirrors (`key`, `led`, `snd`, `sw` — bitmaps of current pressed/lit/active state), an `open()`/`close()` pair the core calls when the first/last handler opens or closes the device (so a driver can defer starting a polling thread or requesting an IRQ until something actually wants events), and the embedded `struct device dev` that makes it a first-class citizen of the driver model.

### The event model

Every event, in-kernel or over the wire to userspace, is one `struct input_event` (`include/uapi/linux/input.h`):

```c
struct input_event {
	struct timeval time;
	__u16 type;
	__u16 code;
	__s32 value;
};
```

The `time` field above is the userspace-facing shape, and it's what almost every userspace program actually sees: any 64-bit build gets it unconditionally, and so does an ordinary 32-bit build. Only in-kernel code, or a 32-bit userspace build that has specifically opted into the Y2038-safe 64-bit `time_t` ABI (`__USE_TIME_BITS64`, a macro libc defines on the application's behalf), instead sees two plain `__kernel_ulong_t` fields, `__sec` and `__usec` — accessed as `ev.input_event_sec`/`ev.input_event_usec` (object-like macros aliasing those fields, not function calls) rather than `time.tv_sec`/`time.tv_usec`. The field layout is picked by preprocessor conditionals in `include/uapi/linux/input.h` so the struct's on-the-wire size matches what the reading process expects.

`type` is one of a fixed, small-ish set of event classes (`include/uapi/linux/input-event-codes.h`):

| Type | Meaning | Example codes |
|---|---|---|
| `EV_SYN` | Synchronization marker — separates one packet of simultaneous changes from the next | `SYN_REPORT`, `SYN_MT_REPORT`, `SYN_DROPPED` |
| `EV_KEY` | Keys and buttons: value `0` = release, `1` = press, `2` = autorepeat. A driver reporting through `input_report_key()` can only ever send `0`/`1` — the `!!value` normalization in that wrapper makes `2` unreachable from driver code; autorepeat events are synthesized by the input core's own repeat timer instead | `KEY_A`, `BTN_LEFT`, `BTN_TOUCH` |
| `EV_REL` | Relative axis motion — a *delta*, like a mouse moving | `REL_X`, `REL_Y`, `REL_WHEEL` |
| `EV_ABS` | Absolute axis position — a new value within `[minimum, maximum]` | `ABS_X`, `ABS_Y`, the `ABS_MT_*` multitouch codes |
| `EV_MSC` | Miscellaneous events that don't fit elsewhere, e.g. raw scancodes | `MSC_SCAN` |
| `EV_SW` | Stateful binary switches (not momentary like keys) | `SW_LID`, `SW_TABLET_MODE` |
| `EV_LED` | Set/query LED state — flows *into* the device | `LED_NUML`, `LED_CAPSL` |
| `EV_SND` | Simple sound events — also flow into the device | `SND_CLICK`, `SND_BELL` |
| `EV_REP` | Autorepeat settings (delay/period) — flows *into* the device via `EVIOCSREP` | `REP_DELAY`, `REP_PERIOD` |
| `EV_FF` | Force-feedback effect control | upload/play/erase force-feedback effects |
| `EV_PWR` | Power-management events, used by a handful of drivers | driver-specific |
| `EV_FF_STATUS` | Force-feedback effect status reports, flowing *from* the device | effect playback state |

`code` picks a specific member of that type (which key, which axis), and `value` is the payload — its meaning depends on `type`, as the table above shows.

A driver reports events with a family of small inline wrappers around the core dispatcher `input_event()`, defined in `include/linux/input.h`:

```c
input_report_key(input_dev, BTN_LEFT, 1);   /* -> input_event(dev, EV_KEY, BTN_LEFT, !!1) */
input_report_rel(input_dev, REL_X, -3);     /* -> input_event(dev, EV_REL, REL_X, -3)   */
input_report_abs(input_dev, ABS_X, 512);    /* -> input_event(dev, EV_ABS, ABS_X, 512)  */
input_sync(input_dev);                      /* -> input_event(dev, EV_SYN, SYN_REPORT, 0) */
```

`input_event()` checks that the device actually declared the given type in `evbit` (an undeclared event is silently dropped — a driver that forgets to `set_bit` the capability will find its events go nowhere), then takes `dev->event_lock` and hands off to the internal dispatch path. For most types the dispatch path also deduplicates against the device's live-state bitmap: an `EV_KEY`, `EV_SW`, `EV_LED`, or `EV_SND` report whose value matches the state already recorded (`key`/`sw`/`led`/`snd`) is dropped rather than forwarded, so calling `input_report_key()` twice in a row with the same value only produces one event at the handler side (autorepeat, `value == 2`, is the deliberate exception — it always passes through). Events that do pass the check update the live-state bitmap (or the current `absinfo[axis].value` for `EV_ABS`) and are queued for every attached handler.

**`input_sync()`** matters more than it looks: individual `input_report_*()` calls describe *changes*, and several changes can belong to the same physical instant — moving a mouse diagonally is a `REL_X` and a `REL_Y` event that happened together. `EV_SYN`/`SYN_REPORT` is the marker that tells a reader "everything since the last `SYN_REPORT` happened as one atomic update"; a driver is expected to call `input_sync()` once after each batch of related reports, not after every single one.

### The evdev userspace interface

**evdev** (`drivers/input/evdev.c`) is the input handler that hands the raw event stream to userspace essentially unfiltered. Each input device that evdev attaches to gets a character device node, `/dev/input/eventN`, allocated from minor numbers starting at `EVDEV_MINOR_BASE` (64) — the docs.kernel.org input overview documents this as the 64–95 legacy evdev minor range, with additional dynamic minors available beyond it for systems with more than 32 input devices.

A userspace program opens the node and calls `read()`; each `read()` returns one or more whole `struct input_event` records (never a partial one — `evdev_read()` rejects a buffer smaller than one event's size with `-EINVAL`, except that a `count == 0` call is let through as a no-op probe rather than rejected) pulled from a per-open-file-descriptor ring buffer that the kernel fills as the underlying device generates events. The size checked against isn't a flat `sizeof(struct input_event)`: it's `input_event_size()`, which returns the size of the compat 32-bit-time `struct input_event_compat` instead when the caller is a compat-mode (e.g. 32-bit) process on a 64-bit kernel, so the bound matches whichever event layout that process actually reads. Reads block by default and return `-EAGAIN` under `O_NONBLOCK` if the buffer is empty. Beyond `read()`, evdev supports a family of `ioctl()`s — `EVIOCGBIT` to query a device's capability bitmaps, `EVIOCGABS`/`EVIOCSABS` to read or set an absolute axis's `input_absinfo`, `EVIOCGRAB` to take exclusive ownership of the device's event stream (what a compositor uses so its own keypresses don't leak to whatever else might be listening), and more, all declared in `include/uapi/linux/input.h`.

Almost nothing talks to `/dev/input/eventN` directly except two userspace layers built for exactly that purpose: **libevdev**, a thin C wrapper that handles the `ioctl()` boilerplate and keeps a local mirror of device state, and **libinput**, built on top of libevdev, which turns raw events into higher-level semantics — pointer acceleration, tap-to-click, gesture recognition, device-quirk workarounds — for consumption by a Wayland compositor or X server. This page stops at evdev: libevdev/libinput internals are userspace, not kernel, and out of scope here.

### Device enumeration

Three places let you inspect what input devices exist without reading any event data:

- **`/proc/bus/input/devices`** — a plain-text dump, one stanza per registered `struct input_dev`, generated by `input_devices_seq_show()` in `drivers/input/input.c`. Each stanza has fixed prefix letters: `I:` bus/vendor/product/version, `N:` the device's `name`, `P:` its `phys` path, `S:` its sysfs path, `U:` its `uniq` string, `H:` the list of handlers attached to it (e.g. `sysrq kbd event3`), then a series of `B:` bitmap lines, each a hex bitmap of the codes it names. `B: PROP=...` (input properties, e.g. `INPUT_PROP_POINTER`) and `B: EV=...` (the `evbit` mask itself) are always printed; a further `B: KEY=...`/`REL=...`/`ABS=...`/`MSC=...`/`LED=...`/`SND=...`/`FF=...`/`SW=...` line is printed only for each event type the device actually declared in `evbit`.
- **`/sys/class/input/`** — every registered input device and every handler-created node (`inputN`, `eventN`, `mouseN`, `jsN`) appears here as a symlink into the driver-model device tree, registered under the kernel's `input` device class (`const struct class input_class`, `.name = "input"`, in `drivers/input/input.c`). This is the same information `/proc/bus/input/devices` shows, but navigable as ordinary sysfs attribute files rather than a flat-text dump.
- **udev naming** — udev consumes the sysfs tree above and creates the stable, human-readable symlinks under `/dev/input/by-id/` and `/dev/input/by-path/` that userspace tools actually use, since a bare `/dev/input/eventN` number is not guaranteed to stay attached to the same physical device across reboots or hot-plug events.

### Absolute vs. relative devices, and multitouch

The `EV_REL`/`EV_ABS` split exists because "where is the pointer" genuinely means different things for different hardware. A mouse reports **relative** motion (`REL_X`, `REL_Y`): it has no idea where the cursor is on screen, only how far it moved since the last report, and the receiving side (input core, then a compositor) accumulates those deltas into a position. A touchscreen or graphics tablet reports **absolute** position (`ABS_X`, `ABS_Y`): the hardware knows exactly where the contact is within its own coordinate space, and every report is a new authoritative value, not a delta.

A single touch point fits neatly into `ABS_X`/`ABS_Y`, but a touchscreen or trackpad that can sense several simultaneous fingers cannot: one pair of absolute axes can't represent more than one position at a time. The kernel's **multitouch (MT) protocol** solves this with a set of `ABS_MT_*` codes (`ABS_MT_POSITION_X`, `ABS_MT_POSITION_Y`, `ABS_MT_TOUCH_MAJOR`, `ABS_MT_PRESSURE`, `ABS_MT_TRACKING_ID`, and others, starting at `ABS_MT_SLOT`) and a **slot** model: `ABS_MT_SLOT` selects which contact (slot) the following `ABS_MT_*` events describe, and `ABS_MT_TRACKING_ID` gives that contact a persistent ID for as long as it stays down — a non-negative value means an active contact, `-1` means the slot is now empty. A driver walks its slots, calls `input_mt_slot(dev, slot)` to select one and then reports that contact's `ABS_MT_*` axes, exactly the way it would report any other absolute axis. This slot-based scheme is officially called **type B**; an older **type A** scheme that sent anonymous per-contact data separated by `SYN_MT_REPORT` markers still exists in the protocol's history and is considered obsolete — the kernel's own documentation claims all in-tree drivers have been converted to type B, but that's not quite accurate: a handful of drivers, including `drivers/input/touchscreen/auo-pixcir-ts.c`, `drivers/input/touchscreen/usbtouchscreen.c`, and `drivers/hid/hid-ntrig.c`, still call `input_mt_sync()` and emit type-A reports. The large majority of drivers do use type B, and it's the scheme any new driver should target. See [Kernel docs: Multi-touch (MT) protocol](https://docs.kernel.org/input/multi-touch-protocol.html) for the full slot/tracking-ID mechanics; [HID: the Human Interface Device layer](hid.md) covers how a HID report descriptor is parsed and mapped onto `input_dev` capabilities in the first place, for devices — including multitouch touchscreens — that arrive over USB, Bluetooth, or I2C HID.

### Architecture: from hardware to userspace

```
  Hardware (PS/2 controller, USB HID device, I2C/SPI touch controller, ...)
          │
          ▼
  Device driver's probe()        e.g. atkbd, usbhid, a touchscreen driver
          │
          ▼
  input_allocate_device() / devm_input_allocate_device()
          │  allocates struct input_dev
          │
          ├── set_bit(EV_KEY, dev->evbit); set_bit(KEY_A, dev->keybit); ...
          │      or input_set_capability() / input_set_abs_params()
          │      declares the capability bitmaps (evbit/keybit/relbit/absbit/...)
          │
          ▼
  input_register_device()
          │  device_add(); EV_SYN forced on; attaches every matching
          │  registered input_handler to this device
          ▼
  Input core (drivers/input/input.c)
          │  driver calls input_report_key()/_rel()/_abs() + input_sync()
          │  → input_event() → dispatch under dev->event_lock
          │
          ├── evdev handler   → /dev/input/eventN   struct input_event stream
          ├── mousedev        → /dev/input/mice      (legacy PS/2-style protocol)
          └── joydev          → /dev/input/jsN        (legacy joystick API)
          ▼
  Userspace: libevdev / libinput
          │  read()s struct input_event records; libinput adds pointer
          │  acceleration, gesture recognition, device quirks, etc.
          ▼
  Wayland compositor / X server / plain read() by a console tool
```

### The rest of this section

- **[HID: the Human Interface Device layer](hid.md)** — how USB/Bluetooth/I2C HID report descriptors get parsed and mapped onto `input_dev` capabilities, the HID driver model, and transport layering.
- **[War Stories](war-stories.md)** — real incidents from the input/HID subsystems.

### Prerequisites and neighbors

Input drivers are ordinary [Linux device-model](../drivers/device-model.md) citizens — most are [USB devices](../usb/README.md) (via the HID layer), I2C/SPI [platform devices](../drivers/platform-driver.md), or, on older hardware, ISA/PS2 devices with no bus abstraction at all. The `/dev/input/*` nodes are plain [character devices](../drivers/chardev.md) registered through the same `cdev`/`file_operations` machinery as any other driver. Reading order: this page, then [HID](hid.md) if you're working with USB/Bluetooth input hardware.

## Further reading

### Kernel source

- [include/linux/input.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/input.h) — `struct input_dev`, `struct input_handler`, `struct input_handle`, and the driver-facing registration/reporting API
- [include/uapi/linux/input.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/input.h) — `struct input_event`, `struct input_absinfo`, the `EVIOC*` ioctls
- [include/uapi/linux/input-event-codes.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/input-event-codes.h) — every `EV_*`, `KEY_*`, `REL_*`, `ABS_*`, `SYN_*` constant
- [include/linux/input/mt.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/input/mt.h) — `struct input_mt`, `input_mt_slot()`, `input_mt_report_slot_state()`
- [drivers/input/input.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/input/input.c) — the input core: `input_register_device()`, `input_event()`/dispatch, `/proc/bus/input/devices`, the `input` device class
- [drivers/input/evdev.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/input/evdev.c) — the evdev handler: `/dev/input/eventN`, `evdev_read()`, the per-client event ring buffer
- [drivers/input/mousedev.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/input/mousedev.c) · [drivers/input/joydev.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/input/joydev.c) — the legacy `/dev/input/mice` and `/dev/input/jsN` handlers

### Related pages

- [HID: the Human Interface Device layer](hid.md) — report descriptors, parsing, the HID driver model, and USB/Bluetooth/I2C transport layering
- [War Stories](war-stories.md) — real incidents in the subsystems above
- [Linux Device Model](../drivers/device-model.md) · [Character and Misc Devices](../drivers/chardev.md) · [Platform Drivers](../drivers/platform-driver.md) — the driver-core layers the input subsystem sits on
- [USB](../usb/README.md) — the bus most HID input devices attach through

### LWN articles

- [An update on the input stack](https://lwn.net/Articles/801767/) — libinput's evolution, high-resolution scroll events, and the userspace layer built on top of evdev

### External

- [Kernel docs: Input subsystem introduction](https://docs.kernel.org/input/input.html) — the `input_event` structure, evdev, and the driver/core/handler architecture
- [Kernel docs: Event codes](https://docs.kernel.org/input/event-codes.html) — the full semantics of every `EV_*` type
- [Kernel docs: Multi-touch (MT) protocol](https://docs.kernel.org/input/multi-touch-protocol.html) — type A vs. type B, slots, and `ABS_MT_TRACKING_ID`
- [Kernel docs: Input subsystem driver API](https://docs.kernel.org/driver-api/input.html) — the full driver-facing function reference
