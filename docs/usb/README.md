# USB: the Universal Serial Bus Subsystem

> How Linux drives USB — a host-scheduled, hot-pluggable bus where the host initiates *every* transfer, devices describe themselves through descriptors, and drivers bind to interfaces rather than whole devices

## Getting Started

USB is the bus almost every peripheral speaks: keyboards, mice, storage, webcams, network dongles, printers, phones. From the kernel's side it has three defining properties that shape the whole subsystem:

- **Host-scheduled.** There is one master — the host controller. *Every* transfer on the wire is initiated by the host; a device never speaks unprompted. Even an "interrupt" endpoint (a mouse reporting movement) is really the host *polling* the device on a fixed interval. This is the opposite of an interrupt-driven bus like PCI.
- **Hot-pluggable and self-describing.** A device can appear or vanish at any moment, and when it appears it tells the host exactly what it is through a tree of **descriptors** — no static configuration, no device tree entry.
- **Tiered-star topology.** Devices hang off hubs, hubs off other hubs, all rooted at the host controller's *root hub*. Up to 127 addresses per bus.

## The three layers of the stack

```
  Class / interface drivers   ← usb-storage, usbhid, cdc-acm, uvcvideo, ...
        │   bind to an interface, submit URBs
        ▼
  usbcore  (drivers/usb/core/) ← the hub driver, device model, enumeration,
        │                         URB machinery — the bus midlayer
        ▼
  Host Controller Driver (HCD) ← xHCI (USB3), EHCI (USB2), OHCI/UHCI (USB1)
        │   schedules transactions on the physical bus
        ▼
  Host controller hardware  (usually a PCIe function) → the wire → devices
```

- **The host controller + its driver (HCD)** own the wire. The dominant one today is **xHCI** (eXtensible Host Controller Interface), which handles USB 1 through USB 3+ in one controller; **EHCI/OHCI/UHCI** are the older USB 2/1 controllers. The controller itself is almost always a [PCI device](../drivers/pci-driver.md).
- **usbcore** is the midlayer every device and driver goes through. It contains the **hub driver** (which detects attach/detach and drives enumeration), the USB **device model** layered on the [driver core](../drivers/device-model.md), and the **URB** engine (below). It presents a clean, controller-independent view of devices to drivers.
- **Class/interface drivers** are what you think of as "the USB driver" for a device — `usb-storage` for flash drives, `usbhid` for keyboards, `cdc-acm` for serial adapters. Crucially, they bind to an **interface**, not the whole device.

## The device model: device → configuration → interface → endpoint

A USB device isn't a single addressable thing; it's a small tree that the device describes through descriptors:

```
Device  (idVendor, idProduct — identifies the product)
└── Configuration  (a power/feature profile; usually just one, and one is active)
    ├── Interface 0  (one *function* — e.g. the video half of a webcam)
    │   ├── Endpoint 1 IN   (isochronous — video frames)
    │   └── Endpoint 0 (shared control endpoint)
    └── Interface 1  (another function — e.g. the audio half)
        └── Endpoint 2 IN   (isochronous — audio)
```

The key consequence: **a driver binds to an interface, not a device.** A USB headset that is simultaneously an audio device and a HID volume control is driven by *two* different drivers bound to *two* interfaces of the *same* physical device. This is why `struct usb_driver`'s `->probe()` receives a `usb_interface`, and why matching is usually done on interface class as well as vendor/product IDs.

## Endpoints and the four transfer types

An **endpoint** is a one-directional data source or sink on the device (IN = toward host, OUT = from host). Each endpoint has exactly one of four transfer types, chosen for the data's needs:

| Type | Guarantees | Used by |
|---|---|---|
| **Control** | Reliable, bidirectional; endpoint 0 exists on every device | Enumeration, configuration, small commands |
| **Bulk** | Reliable (retried), no timing guarantee; uses spare bandwidth | Mass storage, printers, bulk network |
| **Interrupt** | Bounded latency via host polling at a set interval; small payloads | Keyboards, mice, HID |
| **Isochronous** | Guaranteed bandwidth and timing, **no retransmission** | Audio, video (a late frame is useless, so it's dropped, not resent) |

Endpoint 0 is special: it is the **control endpoint** every device must have, and it is how the host talks to a device *before* any driver is bound — during enumeration.

## The URB: the unit of USB I/O

All actual data movement is expressed as a **URB** (USB Request Block) — the USB analogue of the block layer's [`bio`](../block/bio-request.md). A driver fills a URB with the target endpoint, a data buffer, and a completion callback, then submits it asynchronously:

```c
usb_fill_bulk_urb(urb, dev, pipe, buffer, len, my_complete, ctx);
usb_submit_urb(urb, GFP_KERNEL);   /* returns immediately */
/* ... later, from the HCD's completion path: */
static void my_complete(struct urb *urb) { /* urb->status, urb->actual_length */ }
```

The URB is queued to the HCD, scheduled on the wire when the bus can carry it, and its callback runs on completion (or error, or unlink). For simple one-shot transfers, usbcore provides synchronous wrappers — `usb_control_msg()`, `usb_bulk_msg()` — that build a URB, submit it, and wait.

## How a device comes to life (enumeration, in brief)

When a device is plugged in, the hub driver sees the port change, the host **resets** the port, assigns the device an **address**, and reads its descriptors over endpoint 0. It selects a configuration, and usbcore then **matches** each interface against registered drivers (by vendor/product ID or by USB class) and calls the winner's `->probe()`. The full descriptor exchange is covered in the enumeration page.

## Linux as a USB *device*: gadget mode

Everything above is the **host** side. Linux can also *be* a USB peripheral — a phone presenting itself as storage, an embedded board exposing a serial console or Ethernet over USB. That is the **gadget** side: a USB Device Controller (UDC) driver plus a gadget function, usually composed through configfs. It's a separate stack, covered with the host-controller page.

## Further reading

- [Kernel docs: USB driver API](https://docs.kernel.org/driver-api/usb/index.html) — the authoritative reference for usbcore and HCDs
- [Kernel docs: the USB core API](https://docs.kernel.org/driver-api/usb/usb.html) — device model, interfaces, and the driver interface
- [Kernel docs: USB Request Block (URB)](https://docs.kernel.org/driver-api/usb/URB.html) — the URB lifecycle in detail
- [Linux Device Model](../drivers/device-model.md) — the driver core USB builds on · [PCI Drivers](../drivers/pci-driver.md) — how host controllers attach
