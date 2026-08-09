# USB Enumeration and Descriptors

> How a device that just appeared on the wire tells the host what it is — the descriptor hierarchy, the standard control requests that read it, and the reset-address-configure dance that ends with a driver bound

When a USB device is plugged in, the host knows nothing about it — not its speed, not its identity, not what it can do. **Enumeration** is the conversation over the mandatory control endpoint (endpoint 0) that turns an anonymous newly-attached device into an addressed, configured device with drivers bound to its interfaces. Everything the host learns comes from the device's **descriptors**.

## The descriptor hierarchy

A device describes itself as a tree of fixed-format structures (defined in the kernel in `include/uapi/linux/usb/ch9.h`, mirroring "Chapter 9" of the USB specification):

```
Device descriptor              idVendor, idProduct, bDeviceClass,
  │                            bMaxPacketSize0, bNumConfigurations
  └── Configuration descriptor  bNumInterfaces, bmAttributes (self/bus powered),
        │                       bMaxPower
        ├── Interface descriptor   bInterfaceClass/SubClass/Protocol,
        │     │                    bNumEndpoints, bAlternateSetting
        │     ├── Endpoint descriptor  bEndpointAddress (number + IN/OUT),
        │     │                        bmAttributes (transfer type),
        │     │                        wMaxPacketSize, bInterval
        │     └── Endpoint descriptor ...
        └── Interface descriptor ...
```

- **Device descriptor** — one per device. Carries `idVendor`/`idProduct` (the identity drivers match on), the device class, and `bMaxPacketSize0` (how big endpoint 0's packets are — needed before anything else can be read reliably).
- **Configuration descriptor** — a complete power/feature profile. Most devices have exactly one; only one is ever *active*. Reading it returns the interface and endpoint descriptors packed after it in one contiguous blob.
- **Interface descriptor** — one *function*. Its `bInterfaceClass` (mass storage, HID, CDC, audio…) is what usbcore matches drivers against. Interfaces can have **alternate settings** — different endpoint arrangements selected at runtime (isochronous devices use this to switch bandwidth, e.g. a webcam picking a resolution).
- **Endpoint descriptor** — one data pipe: its address and direction, its [transfer type](README.md), its max packet size, and `bInterval` (the polling period for interrupt/isochronous endpoints).
- **String descriptors** — optional human-readable UTF-16 strings (manufacturer, product, serial) referenced by index.

Class drivers layer their own **class-specific descriptors** into this tree — the HID report descriptor, the CDC union descriptor — which the class driver, not usbcore, interprets.

## The standard control requests

Enumeration is driven entirely by **standard device requests** on endpoint 0 — an 8-byte SETUP packet the host sends, defined once for every USB device:

| Request | What it does |
|---|---|
| `GET_DESCRIPTOR` | Read a descriptor (device, configuration+children, string) |
| `SET_ADDRESS` | Assign the device its unique bus address |
| `SET_CONFIGURATION` | Activate a configuration (this is what "turns the device on") |
| `SET_INTERFACE` / `GET_INTERFACE` | Select or query an interface's alternate setting |
| `GET_STATUS`, `CLEAR_FEATURE`, `SET_FEATURE` | Halt/unhalt endpoints, remote-wakeup, etc. |

These are the same requests `usb_control_msg()` issues, and they work *before* any driver exists — endpoint 0 is the one pipe guaranteed to be present the instant a device attaches.

## The sequence

The hub driver, not the target device, orchestrates this:

1. **Attach + debounce.** A downstream hub port signals a status change; the hub driver debounces it (a device isn't "there" until the line is stable).
2. **Speed detection.** Before any packet, speed is read from the electrical signaling — pull-up resistors on D+ (full-speed) or D− (low-speed), a chirp handshake for high-speed, and separate SuperSpeed lanes for USB 3. The host now knows how fast to talk.
3. **Reset.** The host resets the port. The device wakes at the **default address 0**.
4. **First read.** The host does `GET_DESCRIPTOR(device)` to learn `bMaxPacketSize0` — it must know endpoint 0's packet size before it can reliably read anything longer.
5. **Address.** `SET_ADDRESS` moves the device off address 0 to a unique address (1–127). Because *only one device can sit at address 0 at a time*, hubs enumerate their ports **one at a time** — this serialization is why plugging in a big hub full of devices takes a visible moment.
6. **Full read.** With a private address, the host reads the full device descriptor, then each configuration descriptor (and its packed interface/endpoint descriptors), then strings.
7. **Configure.** `SET_CONFIGURATION` activates the chosen configuration. The device's endpoints (beyond 0) now exist and are usable.
8. **Bind.** usbcore matches each interface against registered drivers and calls the winner's `->probe()`.

## How drivers match

A USB driver advertises what it handles with a `usb_device_id` table, matched during step 8:

```c
static const struct usb_device_id my_ids[] = {
    { USB_DEVICE(0x046d, 0xc52b) },              /* exact vendor+product   */
    { USB_INTERFACE_INFO(USB_CLASS_HID, 0, 0) }, /* any device of a class  */
    { }                                          /* terminator             */
};
MODULE_DEVICE_TABLE(usb, my_ids);
```

Matching on `USB_DEVICE` binds one specific product; matching on `USB_INTERFACE_INFO` (class/subclass/protocol) is how generic class drivers like `usb-storage` and `usbhid` claim *any* device that speaks their class. `MODULE_DEVICE_TABLE` exports this table so a plugged-in device's IDs can auto-load the right module via the `modalias` mechanism.

The whole enumerated tree is then visible from user space under `/sys/bus/usb/devices/` and via `lsusb -v`.

## Further reading

- [USB overview](README.md) — the stack, the device model, and the transfer types these endpoints use
- [Kernel docs: the USB core API](https://docs.kernel.org/driver-api/usb/usb.html) — descriptors, interfaces, and driver binding
- [Kernel docs: writing USB device drivers](https://docs.kernel.org/driver-api/usb/writing_usb_driver.html) — the probe/`usb_device_id` path in practice
