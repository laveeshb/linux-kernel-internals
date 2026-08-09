# URBs and the Four Transfer Types

> The URB is the single unit of USB data movement — how it's built, submitted, and completed, and how its shape changes for each of the four transfer types

Every byte a USB driver moves rides in a **URB** (USB Request Block). It is the USB analogue of the block layer's [`bio`](../block/bio-request.md): a self-contained I/O request that a driver hands to the core, which schedules it on the bus and reports completion asynchronously through a callback. Understanding the URB lifecycle is most of understanding how to write a USB driver.

## Anatomy of a URB

```c
struct urb {
    struct usb_device *dev;          /* target device                    */
    unsigned int   pipe;             /* endpoint + direction + type       */
    void          *transfer_buffer;  /* DMA-able data buffer              */
    u32            transfer_buffer_length;
    u32            actual_length;     /* filled in on completion          */
    int            status;            /* 0 or negative errno on completion */
    usb_complete_t complete;          /* callback fired when done          */
    void          *context;           /* driver's cookie                   */
    int            interval;          /* polling period (periodic types)   */
    int            number_of_packets; /* isochronous only                  */
    struct usb_iso_packet_descriptor iso_frame_desc[0];
    /* ... */
};
```

The **pipe** encodes the whole target in one integer — device, endpoint number, direction, and transfer type — built with helpers like `usb_sndbulkpipe(dev, ep)` (host→device bulk) or `usb_rcvintpipe(dev, ep)` (device→host interrupt). "snd/rcv" are always from the *host's* point of view.

## The lifecycle

```c
urb = usb_alloc_urb(0, GFP_KERNEL);                 /* 1. allocate       */
usb_fill_bulk_urb(urb, dev, pipe, buf, len,         /* 2. fill           */
                  my_complete, ctx);
usb_submit_urb(urb, GFP_KERNEL);                    /* 3. submit (async) */
/* returns immediately; the transfer happens later on the bus            */

static void my_complete(struct urb *urb)            /* 4. completion     */
{
    if (urb->status == 0)
        /* urb->actual_length bytes transferred */ ;
    /* for a continuous stream, resubmit here with GFP_ATOMIC */
}
/* usb_free_urb(urb);  when finished (ref-counted)  */
```

Two things about step 4 matter. The completion callback runs in **atomic (interrupt) context** — it must not sleep, and any resubmission from inside it uses `GFP_ATOMIC`. And a submitted URB is **reference-counted and owned by the core** until its callback fires; to cancel one, a driver calls `usb_kill_urb()` (waits for completion) or `usb_unlink_urb()` (async), never just frees it.

For one-shot transfers where blocking is fine, usbcore provides synchronous wrappers that build, submit, and wait internally: **`usb_control_msg()`**, **`usb_bulk_msg()`**, **`usb_interrupt_msg()`**.

## The four transfer types

The endpoint's type (from its [descriptor](enumeration.md)) determines how the core schedules the URB and what guarantees it gets.

### Control — setup, configuration, small commands

Control transfers are the only *bidirectional* type and the only one guaranteed to exist (endpoint 0). Each has up to three stages: a **SETUP** packet (an 8-byte request), an optional **DATA** stage, and a **STATUS** handshake. All enumeration and most "send this device a command" operations are control transfers, usually issued via `usb_control_msg()`.

### Bulk — large, reliable, whenever-there's-room

Bulk transfers are error-checked and retried (reliable delivery) but get **no timing or bandwidth guarantee** — the host schedules them only in bandwidth left over after the periodic types. Ideal for "move a lot of data, correctly, eventually": mass storage, printers, bulk network adapters.

### Interrupt — small, bounded latency, host-polled

Despite the name, nothing interrupts the host. The device declares a desired polling interval (`bInterval`); the host **polls** the endpoint at least that often and the device answers "nothing new" or hands over a small payload. This bounds worst-case latency, which is what a keyboard or mouse needs. Drivers keep one interrupt URB perpetually in flight, resubmitting it from the completion callback.

### Isochronous — guaranteed bandwidth, no retransmission

Isochronous transfers reserve **guaranteed bandwidth** at configuration time and deliver on a fixed schedule, but are **never retried** — a corrupted or late packet is simply lost. That is the correct trade for streaming audio and video, where a stale frame is worthless and re-sending it would only break timing. An isochronous URB carries *many* packets at once (`number_of_packets`, each described by an `iso_frame_desc[]` entry with its own status and length), because scheduling one URB per frame would be far too much overhead.

| Type | Reliable? | Timing | Bandwidth | Typical use |
|---|---|---|---|---|
| Control | yes | none | best-effort | enumeration, commands |
| Bulk | yes | none | leftover | storage, printers |
| Interrupt | yes | bounded latency | reserved (small) | HID |
| Isochronous | **no** | fixed schedule | **reserved** | audio, video |

## Bandwidth, DMA, and errors

- **Bandwidth reservation.** The two periodic types (interrupt and isochronous) reserve bus bandwidth when an interface or alternate setting is selected. If the bus can't satisfy the request, `SET_INTERFACE`/`usb_submit_urb` **fails** rather than silently degrading — which is why a webcam may refuse a high-resolution alt-setting on a crowded bus.
- **DMA.** `transfer_buffer` must be DMA-addressable; the HCD maps it for the [DMA engine](../mm/dma.md). For hot paths, `usb_alloc_coherent()` hands back a buffer that's already mapped.
- **Errors** arrive as a negative `urb->status`: `-EPIPE` (endpoint **stalled/halted** — cleared with `usb_clear_halt()`), `-EOVERFLOW` (**babble**: device sent more than the endpoint's max packet), `-ENOENT`/`-ECONNRESET` (URB was killed/unlinked), `-ESHUTDOWN` (the device was disconnected).

## Further reading

- [Kernel docs: USB Request Block (URB)](https://docs.kernel.org/driver-api/usb/URB.html) — the authoritative URB lifecycle reference
- [Kernel docs: the USB core API](https://docs.kernel.org/driver-api/usb/usb.html) — the submit/complete interface
- [USB overview](README.md) · [Enumeration and Descriptors](enumeration.md) — where endpoints and their types come from
