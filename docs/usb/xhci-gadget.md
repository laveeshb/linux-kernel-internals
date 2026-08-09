# Host Controllers (xHCI) and Gadget Mode

> The bottom of the host stack — how xHCI actually schedules transfers on the wire — and the mirror image: how Linux becomes a USB *device* through the gadget framework

The [overview](README.md) treated the host controller as a black box that "owns the wire." This page opens it: what the **host controller driver (HCD)** does, how the modern **xHCI** controller is structured, and then the opposite direction entirely — **gadget mode**, where Linux *is* the peripheral.

## The host controller driver

Every host-side USB stack bottoms out in an HCD. usbcore talks to it through a uniform `struct usb_hcd` interface — enqueue this URB, cancel that one, what's the root-hub status — so the rest of the kernel never sees controller-specific details. The families, newest first:

- **xHCI** (eXtensible Host Controller Interface) — the modern controller; one xHCI handles USB 1, 2, and 3+ speeds. This is what essentially all current hardware uses.
- **EHCI** (USB 2 high-speed), **OHCI/UHCI** (USB 1) — legacy. EHCI historically needed *companion* OHCI/UHCI controllers to handle the low/full-speed devices it couldn't.

A host controller is almost always a [PCIe function](../drivers/pci-driver.md) (or an SoC platform device), so the HCD is also a PCI/platform driver that probes the controller and maps its registers.

## Inside xHCI: rings, TRBs, and contexts

xHCI's key design move was to **push transfer scheduling into the controller**. Where EHCI exposed frame-list schedules the *driver* had to weave, xHCI is organized around shared-memory **rings** — the same producer/consumer pattern as [NVMe](../block/nvme.md) submission/completion queues:

- **Transfer Request Blocks (TRBs)** are the ring entries — each describes one chunk of a transfer (data, setup stage, link to the next ring segment).
- **Transfer rings** — one per active endpoint. The driver appends TRBs; the controller consumes them.
- **Command ring** — the driver issues controller commands (enable a device slot, configure an endpoint, set address).
- **Event ring** — the controller posts completions and port events here; the driver consumes them, typically off an **MSI-X** interrupt.
- **Doorbell registers** — how the driver tells the controller "I added work to this ring," avoiding a poll.
- **Device Context Base Address Array (DCBAA)** — an array of *pointers* to per-device **device context** structures; each device context holds that device's *slot* context plus its *endpoint* contexts, which carry each endpoint's state (type, max packet, ring dequeue pointer). The controller owns and updates the contexts.

The result: enqueuing a URB becomes "append TRBs to the endpoint's transfer ring and ring the doorbell," and completions arrive as events — a lockless, memory-resident hand-off rather than register poking per packet. The driver lives in `drivers/usb/host/xhci*`.

## Gadget mode: Linux as a USB device

Everything above is the **host**. But a phone presenting itself as a flash drive, a dev board exposing a serial console over USB, a `g_ether` network link — those are Linux acting as a **peripheral**. The device side is a separate stack with three parts:

```
  Gadget function(s)      ← mass storage, serial (ACM), ethernet (ECM/RNDIS),
        │                   HID, or a userspace function via FunctionFS
  Composite framework     ← assembles functions into configurations,
        │                   builds the descriptors the host will enumerate
  UDC driver              ← drives the USB Device Controller silicon
        │                   (the device-side analogue of the HCD)
  UDC hardware  → the wire → some host enumerates *us*
```

- A **UDC (USB Device Controller) driver** is the device-side counterpart of the HCD: it drives the peripheral controller and presents endpoints to the gadget layer.
- The **composite framework** lets a device be built from reusable **function** drivers, assembling their interface/endpoint descriptors into the configuration a host will read during enumeration — the same descriptors from the [enumeration](enumeration.md) page, now *served* rather than read.
- Functions can be bound at runtime through **configfs** under `/sys/kernel/config/usb_gadget/`: create a gadget, set its vendor/product IDs, instantiate functions (`mass_storage.0`, `acm.0`, `ecm.0`), link them into a configuration, and bind to a UDC to go live. **FunctionFS** goes further, letting a *userspace* program implement a function's endpoints (this is how Android's adb works).

## Dual-role and OTG

A USB-C port is often **dual-role** (DRD): it can act as host or device depending on what's plugged in, negotiated over the connector. The kernel's role-switching moves the port between its xHCI (host) and UDC (gadget) drivers as the role changes — the same physical port, two entirely different stacks behind it.

## Further reading

- [Kernel docs: USB gadget API](https://docs.kernel.org/driver-api/usb/gadget.html) — the composite/function framework
- [Kernel docs: gadget configfs](https://docs.kernel.org/usb/gadget_configfs.html) — composing a gadget at runtime
- [Kernel docs: FunctionFS](https://docs.kernel.org/usb/functionfs.html) — implementing a gadget function from userspace
- [USB overview](README.md) — the host stack this sits beneath · [PCI Drivers](../drivers/pci-driver.md) — how host controllers attach
