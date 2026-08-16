# HID: One Driver for Every Keyboard, Mouse, and Gamepad

> The device carries its own datasheet: a report descriptor the kernel parses at connect time, so one generic driver handles almost anything with buttons on it

## The problem: a keyboard is not a network card

A network card driver has to know its chip: which registers hold the DMA ring, how to read the link-partner's autonegotiation state, what the interrupt-cause bitmap means. That knowledge is specific to one chip family and has to be hand-written once per family. If input devices worked the same way, Linux would need a bespoke driver for every mouse, keyboard, gamepad, graphics tablet, and volume-control knob ever built — thousands of small, mostly-identical drivers differing only in which byte in a report means "left button."

USB's Human Interface Device class, ratified in 1996, was designed specifically to avoid that. Rather than the host having to already know a device's data format, the *device* carries a compact, byte-coded description of its own report layout — the **report descriptor** — and hands it to the host during enumeration. A HID host stack reads that descriptor once, learns the exact bit layout of every report the device will ever send or accept, and from then on can decode traffic from a device the driver author never saw, built by a vendor the driver author has never heard of. The class was later carried over largely unchanged onto Bluetooth (the HID Profile, or HIDP) and onto I2C (for the embedded touchpads and touchscreens common on laptops and tablets), because the same self-describing-report idea is just as useful over those links as it is over USB.

Linux's HID subsystem, rooted at `drivers/hid/`, is built around that same idea: one transport-agnostic core (`drivers/hid/hid-core.c`) that knows how to parse a report descriptor and turn raw report bytes into typed field values, one generic input-mapping layer (`drivers/hid/hid-input.c`) that turns those typed values into evdev events, and a thin per-transport shim — USB-HID, BT-HIDP, I2C-HID — that only has to know how to move bytes back and forth. A plain mouse or keyboard needs no vendor-specific driver at all: `hid-generic` matches any device the core can parse and lets the generic tables do all the work. Only devices with a broken or unusual report descriptor, or ones that want to expose something the generic mapping tables don't already know about, need one of the just over 150 small quirk drivers under `drivers/hid/`.

## Report descriptors: the device's own datasheet

A report descriptor is a short program in a stack-based, TLV-like byte code: each **item** is one to five bytes — a one-byte prefix encoding an item *type* and *tag*, followed by zero, one, two, or four bytes of value. Items come in three types, and the parser (below) dispatches on that type:

- **Main items** — `Input`, `Output`, `Feature`, `Collection`, `End Collection` — the ones that actually emit a field or open/close a grouping.
- **Global items** — `Usage Page`, `Logical Minimum`/`Maximum`, `Report Size`, `Report Count`, `Report ID`, `Push`/`Pop` — state that persists across items until changed, forming the context the next `Input`/`Output`/`Feature` item is interpreted in.
- **Local items** — `Usage`, `Usage Minimum`/`Maximum`, `Designator Index`, `String Index` — state that applies only to the *next* main item and is cleared afterward.

`include/linux/hid.h` spells out the exact tag values the parser dispatches on:

```c
// include/linux/hid.h
#define HID_MAIN_ITEM_TAG_INPUT			8
#define HID_MAIN_ITEM_TAG_OUTPUT		9
#define HID_MAIN_ITEM_TAG_FEATURE		11
#define HID_MAIN_ITEM_TAG_BEGIN_COLLECTION	10
#define HID_MAIN_ITEM_TAG_END_COLLECTION	12

#define HID_GLOBAL_ITEM_TAG_USAGE_PAGE		0
#define HID_GLOBAL_ITEM_TAG_LOGICAL_MINIMUM	1
#define HID_GLOBAL_ITEM_TAG_LOGICAL_MAXIMUM	2
#define HID_GLOBAL_ITEM_TAG_REPORT_SIZE		7
#define HID_GLOBAL_ITEM_TAG_REPORT_ID		8
#define HID_GLOBAL_ITEM_TAG_REPORT_COUNT	9
#define HID_GLOBAL_ITEM_TAG_PUSH		10
#define HID_GLOBAL_ITEM_TAG_POP			11

#define HID_LOCAL_ITEM_TAG_USAGE		0
#define HID_LOCAL_ITEM_TAG_USAGE_MINIMUM	1
#define HID_LOCAL_ITEM_TAG_USAGE_MAXIMUM	2
```

**Usage Pages** and **Usages** are what give a field semantic meaning instead of just a bit position. A Usage Page is a namespace — `Generic Desktop` (mice, keyboards, joysticks as physical device classes, plus axis usages like X/Y/Wheel), `Keyboard/Keypad`, `Button`, `Consumer` (media keys), `LED`, and dozens more, all enumerated by the USB-IF's published *HID Usage Tables*. A Usage is a specific meaning within that page — Usage Page `Keyboard/Keypad` (0x07), Usage `0x04` is literally "Keyboard a and A." Combined, a 32-bit usage value (page in the high 16 bits, usage in the low 16, per `include/linux/hid.h`'s `HID_USAGE_PAGE`/`HID_USAGE` masks) is a globally unambiguous name for "this field means this."

A **Collection** groups related items — `Application` (the top-level "this whole thing is a mouse" grouping), `Physical`, `Logical`, `Report`, and a few others — and can nest, so a gamepad's descriptor might have one top-level Application collection containing a Physical collection for the analog sticks and a separate one for the D-pad.

Conceptually — not hand-decoded raw bytes, but the structural shape — a minimal three-button mouse descriptor reads like this:

```
Usage Page (Generic Desktop)
Usage (Mouse)
Collection (Application)
    Usage (Pointer)
    Collection (Physical)
        Usage Page (Button)
        Usage Minimum (1)
        Usage Maximum (3)
        Logical Minimum (0)
        Logical Maximum (1)
        Report Count (3)          # 3 one-bit button fields
        Report Size (1)
        Input (Data, Variable, Absolute)   # the 3 button bits

        Report Count (1)          # 5 padding bits to fill the byte
        Report Size (5)
        Input (Constant)                    # padding, ignored

        Usage Page (Generic Desktop)
        Usage (X)
        Usage (Y)
        Logical Minimum (-127)
        Logical Maximum (127)
        Report Size (8)
        Report Count (2)          # 2 one-byte fields: X, Y
        Input (Data, Variable, Relative)   # the X/Y movement bytes
    End Collection
End Collection
```

Every `Input`/`Output`/`Feature` item closes out one **field**: whatever `Usage`(s), `Logical Minimum`/`Maximum`, `Report Size`, and `Report Count` are currently in effect at that point become that field's shape, and the item's own flags (`Data`/`Constant`, `Variable`/`Array`, `Absolute`/`Relative`) say how to interpret the bits. This mouse example produces a 3-byte input report: byte 0's low 3 bits are the button states (5 bits of padding above them), bytes 1 and 2 are signed relative X and Y deltas. Nothing in that shape is hardcoded into any kernel driver — it's exactly what parsing the descriptor below reconstructs.

## Parsing: `hid_open_report()` and `struct hid_parser`

Every HID driver's `probe()` calls `hid_parse()` (a thin wrapper around `hid_open_report()`) before doing anything else:

```c
// include/linux/hid.h
/**
 * hid_parse - parse HW reports
 *
 * @hdev: hid device
 *
 * Call this from probe after you set up the device (if needed). Your
 * report_fixup will be called (if non-NULL) after reading raw report from
 * device before passing it to hid layer for real parsing.
 */
static inline int __must_check hid_parse(struct hid_device *hdev)
{
	return hid_open_report(hdev);
}
```

`hid_open_report()` (`drivers/hid/hid-core.c`) takes the raw descriptor bytes the transport driver read off the device, runs the driver's `.report_fixup` callback over a copy if one is registered (so a quirk driver can patch a broken descriptor before the real parser ever sees it — see the worked example below), and then hands the (possibly patched) bytes to `hid_parse_collections()`:

```c
// drivers/hid/hid-core.c
int hid_open_report(struct hid_device *device)
{
	unsigned int size;
	const u8 *start;
	int error;

	if (WARN_ON(device->status & HID_STAT_PARSED))
		return -EBUSY;

	start = device->bpf_rdesc;
	if (WARN_ON(!start))
		return -ENODEV;
	size = device->bpf_rsize;

	if (device->driver->report_fixup) {
		/*
		 * device->driver->report_fixup() needs to work
		 * on a copy of our report descriptor so it can
		 * change it.
		 */
		u8 *buf __free(kfree) = kmemdup(start, size, GFP_KERNEL);

		if (!buf)
			return -ENOMEM;

		start = device->driver->report_fixup(device, buf, &size);

		/*
		 * The second kmemdup is required in case report_fixup() returns
		 * a static read-only memory, but we have no idea if that memory
		 * needs to be cleaned up or not at the end.
		 */
		start = kmemdup(start, size, GFP_KERNEL);
		if (!start)
			return -ENOMEM;
	}

	device->rdesc = start;
	device->rsize = size;

	error = hid_parse_collections(device);
	...
	return 0;
}
```

`hid_parse_collections()` walks the byte stream item by item, dispatching each one through a small lookup table keyed by item type:

```c
// drivers/hid/hid-core.c
static typeof(hid_parser_main) (* const dispatch_type[]) = {
	hid_parser_main,
	hid_parser_global,
	hid_parser_local,
	hid_parser_reserved
};
...
while ((next = fetch_item(start, end, &item)) != NULL) {
	start = next;
	...
	if (dispatch_type[item.type](parser, &item)) {
		hid_err(device, "item %u %u %u %u parsing failed\n", ...);
		goto out;
	}
}
```

`hid_parser_global()` updates the persistent state (current Usage Page, Report Size, Report Count, ...) in `struct hid_parser`'s `global` field (and its `global_stack`, for `Push`/`Pop`); `hid_parser_local()` accumulates the Usage(s) that apply to the *next* main item; `hid_parser_main()` is where an `Input`/`Output`/`Feature`/`Collection` item actually consumes that accumulated state and allocates a `struct hid_field` (or opens/closes a `struct hid_collection`) inside the device's `struct hid_report`. By the time `hid_open_report()` returns, the entire descriptor has been turned into the object graph the rest of the subsystem operates on — no further byte-level parsing happens on the hot path of reading actual reports.

## `struct hid_device` and the parsed object graph

`struct hid_device` (`include/linux/hid.h`) is the parsed device: descriptor bytes, the report tables the parser built, transport plumbing, and the attached driver, all in one object:

```c
// include/linux/hid.h
struct hid_device {
	const __u8 *dev_rdesc;						/* device report descriptor */
	const __u8 *bpf_rdesc;						/* bpf modified report descriptor, if any */
	const __u8 *rdesc;						/* currently used report descriptor */
	unsigned int dev_rsize;
	unsigned int bpf_rsize;
	unsigned int rsize;
	unsigned int collection_size;					/* Number of allocated hid_collections */
	struct hid_collection *collection;				/* List of HID collections */
	unsigned int maxcollection;						/* Number of parsed collections */
	unsigned int maxapplication;					/* Number of applications */
	__u16 bus;							/* BUS ID */
	__u16 group;							/* Report group */
	__u32 vendor;							/* Vendor ID */
	__u32 product;							/* Product ID */
	__u32 version;							/* HID version */
	enum hid_type type;						/* device type (mouse, kbd, ...) */
	unsigned country;						/* HID country */
	struct hid_report_enum report_enum[HID_REPORT_TYPES];
	struct work_struct led_work;					/* delayed LED worker */

	struct semaphore driver_input_lock;				/* protects the current driver */
	struct device dev;						/* device */
	struct hid_driver *driver;
	void *devres_group_id;						/* ID of probe devres group	*/

	const struct hid_ll_driver *ll_driver;
	struct mutex ll_open_lock;
	unsigned int ll_open_count;
	...
	unsigned long status;						/* see STAT flags above */
	unsigned claimed;						/* Claimed by hidinput, hiddev? */
	unsigned quirks;						/* Various quirks the device can pull on us */
	...
	struct list_head inputs;					/* The list of inputs */
	void *hiddev;							/* The hiddev structure */
	void *hidraw;

	char name[128];							/* Device name */
	char phys[64];							/* Device physical location */
	char uniq[64];							/* Device unique identifier (serial #) */
	u64 firmware_version;						/* Firmware version */

	void *driver_data;
	...
};
```

`report_enum[HID_REPORT_TYPES]` is the parser's real output: one `struct hid_report_enum` per report type — `HID_INPUT_REPORT`, `HID_OUTPUT_REPORT`, `HID_FEATURE_REPORT` (`include/uapi/linux/hid.h`) — each holding a `report_id_hash[]` so a numbered report (a device with a Report ID byte prefixing each packet, for devices that multiplex several report shapes over one endpoint) can be looked up in O(1) when a raw packet comes in.

A `struct hid_report` is one parsed report — the unit `hid_open_report()` builds out of one span of `Input`/`Output`/`Feature` items sharing a Report ID:

```c
// include/linux/hid.h
struct hid_report {
	struct list_head list;
	struct list_head hidinput_list;
	struct list_head field_entry_list;		/* ordered list of input fields */
	unsigned int id;				/* id of this report */
	enum hid_report_type type;			/* report type */
	unsigned int application;			/* application usage for this report */
	struct hid_field *field[HID_MAX_FIELDS];	/* fields of the report */
	struct hid_field_entry *field_entries;		/* allocated memory of input field_entry */
	unsigned maxfield;				/* maximum valid field index */
	unsigned size;					/* size of the report (bits) */
	struct hid_device *device;			/* associated device */
	...
};
```

and a `struct hid_field` is exactly one `Input`/`Output`/`Feature` item's worth of shape — where it lives in the report, how big it is, what it means:

```c
// include/linux/hid.h
struct hid_field {
	unsigned  physical;		/* physical usage for this field */
	unsigned  logical;		/* logical usage for this field */
	unsigned  application;		/* application usage for this field */
	struct hid_usage *usage;	/* usage table for this function */
	unsigned  maxusage;		/* maximum usage index */
	unsigned  flags;		/* main-item flags (i.e. volatile,array,constant) */
	unsigned  report_offset;	/* bit offset in the report */
	unsigned  report_size;		/* size of this field in the report */
	unsigned  report_count;		/* number of this field in the report */
	unsigned  report_type;		/* (input,output,feature) */
	__s32    *value;		/* last known value(s) */
	__s32    *new_value;		/* newly read value(s) */
	...
	__s32     logical_minimum;
	__s32     logical_maximum;
	__s32     physical_minimum;
	__s32     physical_maximum;
	...
	struct hid_report *report;	/* associated report */
	unsigned index;			/* index into report->field[] */
	/* hidinput data */
	struct hid_input *hidinput;	/* associated input structure */
	...
};
```

and `struct hid_usage` is one Usage attached to a field (a field can have several — an array field, or a field built from a Usage Minimum/Maximum range, covers more than one usage):

```c
// include/linux/hid.h
struct hid_usage {
	unsigned  hid;			/* hid usage code */
	unsigned  collection_index;	/* index into collection array */
	unsigned  usage_index;		/* index into usage array */
	__s8	  resolution_multiplier;/* Effective Resolution Multiplier
					   (HUT v1.12, 4.3.1), default: 1 */
	/* hidinput data */
	__s8	  wheel_factor;		/* 120/resolution_multiplier */
	__u16     code;			/* input driver code */
	__u8      type;			/* input driver type */
	__s16	  hat_min;		/* hat switch fun */
	__s16	  hat_max;		/* ditto */
	__s16	  hat_dir;		/* ditto */
	__s16	  wheel_accumulated;	/* hi-res wheel */
};
```

`usage->hid` is the raw HID usage code straight from the descriptor (page + usage, as described above); `usage->type`/`usage->code` are filled in *later*, during evdev mapping — they start life meaningless and get set to an `EV_*` type and a `KEY_*`/`ABS_*`/... code once `hid-input.c` decides what this usage means to userspace (next section). `struct hid_collection` is the simplest of the four — just enough to reconstruct the nesting:

```c
// include/linux/hid.h
struct hid_collection {
	int parent_idx; /* device->collection */
	unsigned type;
	unsigned usage;
	unsigned level;
};
```

## The driver model: `struct hid_driver`

A HID driver — whether the catch-all `hid-generic` or a vendor-specific quirk driver — registers a `struct hid_driver`, matched against connecting devices by `.id_table` (a `struct hid_device_id` array, matched on bus/vendor/product, built with helper macros like `HID_USB_DEVICE()`, `HID_BLUETOOTH_DEVICE()`, `HID_I2C_DEVICE()` — the same struct works across transports, since matching happens above the transport layer):

```c
// include/linux/hid.h
struct hid_driver {
	const char *name;
	const struct hid_device_id *id_table;

	struct list_head dyn_list;
	spinlock_t dyn_lock;

	bool (*match)(struct hid_device *dev, bool ignore_special_driver);
	int (*probe)(struct hid_device *dev, const struct hid_device_id *id);
	void (*remove)(struct hid_device *dev);

	const struct hid_report_id *report_table;
	int (*raw_event)(struct hid_device *hdev, struct hid_report *report,
			u8 *data, int size);
	const struct hid_usage_id *usage_table;
	int (*event)(struct hid_device *hdev, struct hid_field *field,
			struct hid_usage *usage, __s32 value);
	void (*report)(struct hid_device *hdev, struct hid_report *report);

	const __u8 *(*report_fixup)(struct hid_device *hdev, __u8 *buf,
			unsigned int *size);

	int (*input_mapping)(struct hid_device *hdev,
			struct hid_input *hidinput, struct hid_field *field,
			struct hid_usage *usage, unsigned long **bit, int *max);
	int (*input_mapped)(struct hid_device *hdev,
			struct hid_input *hidinput, struct hid_field *field,
			struct hid_usage *usage, unsigned long **bit, int *max);
	int (*input_configured)(struct hid_device *hdev,
				struct hid_input *hidinput);
	void (*feature_mapping)(struct hid_device *hdev,
			struct hid_field *field,
			struct hid_usage *usage);

	int (*suspend)(struct hid_device *hdev, pm_message_t message);
	int (*resume)(struct hid_device *hdev);
	int (*reset_resume)(struct hid_device *hdev);
	void (*on_hid_hw_open)(struct hid_device *hdev);
	void (*on_hid_hw_close)(struct hid_device *hdev);

/* private: */
	struct device_driver driver;
};
```

The callbacks that matter for overriding generic report handling, in the order they're consulted:

- **`.report_fixup`** — called once, from `hid_open_report()` before the descriptor is even parsed (shown above). Patches raw descriptor bytes — the tool of choice when a device ships a descriptor that's outright wrong (a maximum value set too low, a Usage Page byte that doesn't match what the rest of the descriptor implies).
- **`.probe`** — a driver's own probe, called after the transport's core probe has attached `hid_device`; almost always calls `hid_parse()` then `hid_hw_start()`.
- **`.input_mapping`** — called once per usage, while `hid-input.c` is deciding how to map that usage to an evdev event (below). Returning `1` claims the mapping (the driver already called `hid_map_usage()` itself); `0` defers to the generic tables; a negative value says "map nothing, ignore this usage entirely."
- **`.input_mapped`** — called once per usage *after* a mapping (generic or driver-supplied) has been decided, just before it's committed to the `input_dev`'s capability bitmaps. Lets a driver adjust or veto a mapping it didn't originate — a negative return here also suppresses the usage.
- **`.raw_event`** — called for every incoming report, before any field extraction happens, with the raw report bytes. The escape hatch for a driver that needs to intercept a report before generic processing, or that wants to synthesize input events from bytes the generic field-extraction logic wouldn't know how to interpret at all.
- **`.event`** — called once per extracted field *value*, after generic field extraction but before (or instead of) the generic `hidinput_hid_event()` translation to `input_event()`.

## Transport layering: `struct hid_ll_driver`

Nothing described so far — descriptor parsing, `struct hid_device`, `hid-input.c`'s mapping — knows or cares how report bytes actually reached the kernel. That's deliberately factored out into `struct hid_ll_driver` ("low-level driver"), the interface a transport implements once and the core calls through for every device on that transport:

```c
// include/linux/hid.h
struct hid_ll_driver {
	int (*start)(struct hid_device *hdev);
	void (*stop)(struct hid_device *hdev);

	int (*open)(struct hid_device *hdev);
	void (*close)(struct hid_device *hdev);

	int (*power)(struct hid_device *hdev, int level);

	int (*parse)(struct hid_device *hdev);

	void (*request)(struct hid_device *hdev,
			struct hid_report *report, int reqtype);

	int (*wait)(struct hid_device *hdev);

	int (*raw_request) (struct hid_device *hdev, unsigned char reportnum,
			    __u8 *buf, size_t len, unsigned char rtype,
			    int reqtype);

	int (*output_report) (struct hid_device *hdev, __u8 *buf, size_t len);

	int (*idle)(struct hid_device *hdev, int report, int idle, int reqtype);
	bool (*may_wakeup)(struct hid_device *hdev);

	unsigned int max_buffer_size;
};
```

`.parse` is the transport reading the raw descriptor bytes off the device (USB: a `GET_DESCRIPTOR` control request; Bluetooth: bytes handed over at connection setup by userspace's SDP/HID-profile negotiation) and stashing them where `hid_open_report()` will find them — everything *after* that point (fixup, item parsing, field extraction) is identical regardless of transport. `.raw_request`/`.output_report` are how a driver or the input-event path sends a Feature or Output report back to the device (LED state, force-feedback, a vendor configuration blob) — again, one call shape, transport-specific bytes underneath.

Two real, in-tree transports implement it. USB-HID (`drivers/hid/usbhid/hid-core.c`) is the original and most common:

```c
// drivers/hid/usbhid/hid-core.c
static const struct hid_ll_driver usb_hid_driver = {
	.parse = usbhid_parse,
	.start = usbhid_start,
	.stop = usbhid_stop,
	.open = usbhid_open,
	.close = usbhid_close,
	.power = usbhid_power,
	.request = usbhid_request,
	.wait = usbhid_wait_io,
	.raw_request = usbhid_raw_request,
	.output_report = usbhid_output_report,
	.idle = usbhid_idle,
	.may_wakeup = usbhid_may_wakeup,
};
```

`.open`/`.close` there wire up the USB interrupt-IN endpoint (the pipe that carries unsolicited Input reports) and, when present, the interrupt-OUT endpoint; `.raw_request` goes over the USB control pipe as a class-specific `SET_REPORT`/`GET_REPORT` request.

Bluetooth-HID is the HID Profile (HIDP) implementation, `net/bluetooth/hidp/core.c` — it registers its own `hid_ll_driver` and drives it over two L2CAP channels (a control channel and an interrupt channel, mirroring the "ctrl"/"intr" split USB-HID gets for free from its control and interrupt endpoints):

```c
// net/bluetooth/hidp/core.c
static const struct hid_ll_driver hidp_hid_driver = {
	.parse = hidp_parse,
	.start = hidp_start,
	.stop = hidp_stop,
	.open  = hidp_open,
	.close = hidp_close,
	.raw_request = hidp_raw_request,
	.output_report = hidp_output_report,
};
```

The kernel's own transport documentation names all three real-world transports the abstraction was built for: "USB, I2C, Bluetooth-l2cap" at the wire level, surfaced through "USB-HID, I2C-HID, BT-HIDP" drivers (`Documentation/hid/hid-transport.rst`). I2C-HID (`drivers/hid/i2c-hid/`) is the third — common on laptop touchpads and touchscreens — using a single I2C bus transaction protocol instead of BT-HIDP's two separate L2CAP channels or USB-HID's separate control/interrupt endpoints (I2C-HID is a Microsoft-authored addition to the class, not part of the original USB HID spec). A driver author never has to care which of these actually moved a given report's bytes; `struct hid_device->ll_driver` just points at whichever one attached this device.

## Mapping to evdev: `hid_map_usage()` and `hid-input.c`

Parsing produces `struct hid_field`s full of `struct hid_usage`s with a raw `usage->hid` code and nothing else — `usage->type`/`usage->code` are unset. Turning that into something `evdev` understands (an `EV_KEY`/`KEY_A` pair, an `EV_ABS`/`ABS_X` pair) is `hid-input.c`'s job, done once per usage at connect time in `hidinput_configure_usage()`. The mapping itself is a small, generic inline helper:

```c
// include/linux/hid.h
static inline void hid_map_usage(struct hid_input *hidinput,
		struct hid_usage *usage, unsigned long **bit, int *max,
		__u8 type, unsigned int c)
{
	struct input_dev *input = hidinput->input;
	unsigned long *bmap = NULL;
	unsigned int limit = 0;

	switch (type) {
	case EV_ABS:
		bmap = input->absbit;
		limit = ABS_MAX;
		break;
	case EV_REL:
		bmap = input->relbit;
		limit = REL_MAX;
		break;
	case EV_KEY:
		bmap = input->keybit;
		limit = KEY_MAX;
		break;
	...
	}

	if (unlikely(c > limit || !bmap)) {
		pr_warn_ratelimited("%s: Invalid code %d type %d\n",
				    input->name, c, type);
		*bit = NULL;
		return;
	}

	usage->type = type;
	usage->code = c;
	*max = limit;
	*bit = bmap;
}
```

`hidinput_configure_usage()` calls it — but only after giving the driver first refusal:

```c
// drivers/hid/hid-input.c (hidinput_configure_usage(), abridged)
if (device->driver->input_mapping) {
	int ret = device->driver->input_mapping(device, hidinput, field,
			usage, &bit, &max);
	if (ret > 0)
		goto mapped;
	if (ret < 0)
		goto ignore;
}

switch (usage->hid & HID_USAGE_PAGE) {
case HID_UP_UNDEFINED:
	goto ignore;

case HID_UP_KEYBOARD:
	set_bit(EV_REP, input->evbit);

	if ((usage->hid & HID_USAGE) < 256) {
		if (!hid_keyboard[usage->hid & HID_USAGE]) goto ignore;
		map_key_clear(hid_keyboard[usage->hid & HID_USAGE]);
	} else
		map_key(KEY_UNKNOWN);

	break;
...
```

That `hid_keyboard[]` table is the generic Keyboard-page mapping — a flat 256-entry array of Linux key codes indexed by the low byte of the usage. Index 4 (usage `0x00070004`, Usage Page `Keyboard/Keypad`, Usage `0x04`, per the HID Usage Tables "Keyboard a and A") holds `30`, which is `KEY_A` — the array is literally `hid_keyboard[]` from `drivers/hid/hid-input.c`, and `hid_keyboard[4] == 30` is exactly this mapping, with no driver code involved for an ordinary keyboard.

Once a mapping is chosen — generic, or a driver's own `hid_map_usage()` call from `.input_mapping` — control passes through one more driver hook before it's committed:

```c
// drivers/hid/hid-input.c (hidinput_configure_usage(), abridged)
mapped:
	if (!bit)
		return;

	if (device->driver->input_mapped &&
	    device->driver->input_mapped(device, hidinput, field, usage,
					 &bit, &max) < 0) {
		return;
	}

	set_bit(usage->type, input->evbit);
	...
```

At runtime, once a device is open, every incoming report reaches `__hid_input_report()` (`drivers/hid/hid-core.c`), which — after finding the matching `struct hid_report` by ID — gives the driver's `.raw_event` the report bytes before any HID-core field extraction, then always runs the generic path:

```c
// drivers/hid/hid-core.c (__hid_input_report(), abridged)
if (hdrv && hdrv->raw_event && hid_match_report(hid, report)) {
	ret = hdrv->raw_event(hid, report, data, size);
	if (ret < 0)
		goto unlock;
}

ret = hid_report_raw_event(hid, type, data, bufsize, size, interrupt);
```

`hid_report_raw_event()` hands the whole report to `hid_process_report()`, which extracts each field's bit-packed value and, for every usage in the report, calls `hid_process_event()` — that's the function that actually calls `hidinput_hid_event()`, the `input_event(input, usage->type, usage->code, value)` call, using the `type`/`code` pair `hid_map_usage()` set at connect time, now finally used. Only after `hid_process_report()` has dispatched every field does `hid_report_raw_event()` call `hidinput_report_event()` — and that function does nothing more than walk `hid->inputs` and call `input_sync()` on each attached `input_dev`, the `EV_SYN`/`SYN_REPORT` fan-out that closes out the batch of events `hid_process_event()` just generated.

## Worked example: `hid-petalynx.c`

`drivers/hid/hid-petalynx.c` is a small, real, in-tree quirk driver for the Petalynx Maxter remote control, and it happens to demonstrate both `.report_fixup` and `.input_mapping` in under 100 lines. First, the descriptor bug it works around — the device's Consumer-page maximum usage value is set too low, which would make the parser reject or truncate perfectly valid usages further down the descriptor:

```c
// drivers/hid/hid-petalynx.c
/* Petalynx Maxter Remote has maximum for consumer page set too low */
static const __u8 *pl_report_fixup(struct hid_device *hdev, __u8 *rdesc,
		unsigned int *rsize)
{
	if (*rsize >= 62 && rdesc[39] == 0x2a && rdesc[40] == 0xf5 &&
			rdesc[41] == 0x00 && rdesc[59] == 0x26 &&
			rdesc[60] == 0xf9 && rdesc[61] == 0x00) {
		hid_info(hdev, "fixing up Petalynx Maxter Remote report descriptor\n");
		rdesc[60] = 0xfa;
		rdesc[40] = 0xfa;
	}
	return rdesc;
}
```

Note the defensive byte-pattern check before patching — `report_fixup` runs on every device this driver's `id_table` matches, so it verifies the exact bytes it expects are actually there (a different firmware revision of the "same" device could have a different, already-correct descriptor) before overwriting two bytes in the maximum-usage-value item.

Second, the driver remaps two vendor/logitech-adjacent usage pages onto standard Linux key codes the generic tables have no idea about — a "LogiVendor" page for the remote's colored buttons, and two Consumer-page usages for next/back that this device apparently doesn't use per the HID Usage Tables' own suggested mapping:

```c
// drivers/hid/hid-petalynx.c
#define pl_map_key_clear(c)	hid_map_usage_clear(hi, usage, bit, max, \
					EV_KEY, (c))
static int pl_input_mapping(struct hid_device *hdev, struct hid_input *hi,
		struct hid_field *field, struct hid_usage *usage,
		unsigned long **bit, int *max)
{
	if ((usage->hid & HID_USAGE_PAGE) == HID_UP_LOGIVENDOR) {
		switch (usage->hid & HID_USAGE) {
		case 0x05a: pl_map_key_clear(KEY_TEXT);		break;
		case 0x05b: pl_map_key_clear(KEY_RED);		break;
		case 0x05c: pl_map_key_clear(KEY_GREEN);	break;
		case 0x05d: pl_map_key_clear(KEY_YELLOW);	break;
		case 0x05e: pl_map_key_clear(KEY_BLUE);		break;
		default:
			return 0;
		}
		return 1;
	}

	if ((usage->hid & HID_USAGE_PAGE) == HID_UP_CONSUMER) {
		switch (usage->hid & HID_USAGE) {
		case 0x0f6: pl_map_key_clear(KEY_NEXT);		break;
		case 0x0fa: pl_map_key_clear(KEY_BACK);		break;
		default:
			return 0;
		}
		return 1;
	}

	return 0;
}
```

Returning `1` after a successful `pl_map_key_clear()` call tells `hidinput_configure_usage()` the mapping is already done — skip the generic switch entirely for this usage. Falling through to `return 0` for anything on those two pages that isn't one of the five/two usages listed lets the generic tables have a try instead of silently dropping the usage.

And the plumbing that ties both into the driver:

```c
// drivers/hid/hid-petalynx.c
static int pl_probe(struct hid_device *hdev, const struct hid_device_id *id)
{
	int ret;

	hdev->quirks |= HID_QUIRK_NOGET;

	ret = hid_parse(hdev);
	if (ret) {
		hid_err(hdev, "parse failed\n");
		goto err_free;
	}

	ret = hid_hw_start(hdev, HID_CONNECT_DEFAULT);
	if (ret) {
		hid_err(hdev, "hw start failed\n");
		goto err_free;
	}

	return 0;
err_free:
	return ret;
}

static const struct hid_device_id pl_devices[] = {
	{ HID_USB_DEVICE(USB_VENDOR_ID_PETALYNX, USB_DEVICE_ID_PETALYNX_MAXTER_REMOTE) },
	{ }
};
MODULE_DEVICE_TABLE(hid, pl_devices);

static struct hid_driver pl_driver = {
	.name = "petalynx",
	.id_table = pl_devices,
	.report_fixup = pl_report_fixup,
	.input_mapping = pl_input_mapping,
	.probe = pl_probe,
};
module_hid_driver(pl_driver);
```

`.probe` here is close to the minimum any HID driver needs: `hid_parse()` (which is where `.report_fixup` actually gets invoked, inside `hid_open_report()`), then `hid_hw_start(hdev, HID_CONNECT_DEFAULT)` — the flag combination (`HID_CONNECT_HIDINPUT|HID_CONNECT_HIDRAW|HID_CONNECT_HIDDEV|HID_CONNECT_FF`) that wires the device up to evdev, `/dev/hidraw*`, the legacy hiddev interface, and force-feedback, all at once. Everything else — the report-ID lookup table, the `struct hid_field`s, the evdev device this driver never explicitly creates — is built by the generic core using the fixed-up descriptor and the driver's two callbacks.

## HID-BPF: fixups without a new driver

`.report_fixup` and `.input_mapping` both require writing, building, and upstreaming a kernel module — a slow path for a one-device bug fix. HID-BPF (`Documentation/hid/hid-bpf.rst`, `CONFIG_HID_BPF`) is a newer, complementary mechanism: an eBPF program, loaded from userspace at runtime, can be attached to fix up a report descriptor or intercept report events for a specific device, without a new driver ever landing in-tree. `struct hid_device`'s `bpf_rdesc`/`bpf_rsize` fields (used by `hid_open_report()`, shown above, as the actual starting point for parsing) exist precisely so a BPF descriptor fixup runs *before* any `.report_fixup` in the normal driver-matching path even gets a chance. The kernel's own HID-BPF documentation frames the motivation directly: for the common case of a driver that exists only to fix "one key or one byte" in a report descriptor, the traditional route "require[s] a kernel patch and the subsequent shepherding into a release, a long and painful process for users," where an eBPF program can instead be verified by the user and loaded directly, without waiting on a kernel release (`Documentation/hid/hid-bpf.rst`). Benjamin Tissoires proposed the mechanism upstream in 2022; the v2 cover letter of that patch series is archived on LWN ([Introduce eBPF support for HID devices](https://lwn.net/Articles/886860/)). It doesn't replace `.input_mapping`/`.raw_event` for anything stateful or complex — those still need a real driver — but for the narrow, extremely common case of "this one descriptor has a wrong byte," it's now the lower-friction option upstream generally prefers over a brand-new quirk module.

## The full path, device to userspace

```
 Physical device
 (keyboard, mouse, gamepad, touchpad...)
        │  descriptor bytes + report bytes, over one of:
        ▼
 ┌───────────────┬───────────────┬───────────────┐
 │   USB          │  Bluetooth     │  I2C           │
 │ (interrupt IN/  │  (HIDP, two    │  (I2C-HID       │
 │  OUT endpoints) │  L2CAP chans)  │  protocol)      │
 └───────┬───────┴───────┬───────┴───────┬───────┘
         ▼                ▼                ▼
   usb_hid_driver    hidp_hid_driver   i2c_hid_ll_driver
         │  each is a struct hid_ll_driver: .parse/.start/.open/
         │  .raw_request/.output_report/...
         └────────────────┬────────────────┘
                           ▼
              HID core (drivers/hid/hid-core.c)
              ┌─────────────────────────────────┐
              │ hid_open_report()                │
              │   .report_fixup (if any)          │  ← quirk driver, or HID-BPF
              │   hid_parse_collections()          │     rdesc fixup program
              │     → struct hid_report/hid_field/ │
              │       hid_usage/hid_collection      │
              │                                     │
              │ __hid_input_report() (per packet)  │
              │   .raw_event (if any)               │  ← quirk driver, raw bytes
              │   hid_report_raw_event()            │
              │     → field value extraction        │
              └─────────────────┬───────────────────┘
                                 ▼
              hid-input.c: hidinput_configure_usage()
              ┌─────────────────────────────────┐
              │ .input_mapping (if any)  ──1──►  claims mapping
              │       │0                          │
              │       ▼                           │
              │ generic switch(usage->hid          │
              │   & HID_USAGE_PAGE) tables         │
              │       │                            │
              │       ▼                            │
              │ hid_map_usage(): sets               │
              │   usage->type / usage->code          │
              │       │                              │
              │       ▼                              │
              │ .input_mapped (if any) ──◄───────────┘
              │   may veto/adjust
              └─────────────────┬───────────────────┘
                                 ▼
              hidinput_hid_event() → input_event(dev,
                usage->type, usage->code, value)
                                 ▼
                        evdev (/dev/input/eventN)
                                 ▼
                    userspace (libinput, Xorg, Wayland
                    compositor, a game reading /dev/input
                    directly...)
```

## Further reading

### Kernel source

- [`include/linux/hid.h`](https://raw.githubusercontent.com/torvalds/linux/master/include/linux/hid.h) — `struct hid_device`, `struct hid_driver`, `struct hid_ll_driver`, `struct hid_report`/`hid_field`/`hid_usage`/`hid_collection`, `hid_map_usage()`
- [`include/uapi/linux/hid.h`](https://raw.githubusercontent.com/torvalds/linux/master/include/uapi/linux/hid.h) — `enum hid_report_type` (`HID_INPUT_REPORT`/`HID_OUTPUT_REPORT`/`HID_FEATURE_REPORT`)
- [`drivers/hid/hid-core.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/hid/hid-core.c) — `hid_open_report()`, `hid_parse_collections()`, `__hid_input_report()`, `hid_report_raw_event()`
- [`drivers/hid/hid-input.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/hid/hid-input.c) — `hidinput_configure_usage()`, `hid_keyboard[]`, `hidinput_hid_event()`
- [`drivers/hid/usbhid/hid-core.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/hid/usbhid/hid-core.c) — `usb_hid_driver`, the USB-HID `hid_ll_driver`
- [`net/bluetooth/hidp/core.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/net/bluetooth/hidp/core.c) — `hidp_hid_driver`, the BT-HIDP `hid_ll_driver`
- [`drivers/hid/hid-petalynx.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/hid/hid-petalynx.c) — the worked-example quirk driver above
- [`drivers/hid/hid-generic.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/hid/hid-generic.c) — the catch-all driver ordinary mice/keyboards use, with no quirk callbacks at all

### Related pages

- [Input Subsystem: evdev and the Input Core](README.md) — the `input_dev`/`evdev` layer HID's `hid_map_usage()` and `input_event()` calls feed into
- [Input Subsystem War Stories](war-stories.md) — incidents from the input/HID stack this page's parsing and mapping machinery sits under

### External

- [Introduction to HID report descriptors](https://docs.kernel.org/hid/hidintro.html) — the kernel's own tour of usage pages, usages, reports, and collections, with a worked mouse descriptor
- [HID I/O Transport Drivers](https://docs.kernel.org/hid/hid-transport.html) — the `hid_ll_driver` contract and the USB-HID/BT-HIDP/I2C-HID transports
- [HID-BPF](https://docs.kernel.org/hid/hid-bpf.html) — the eBPF-based alternative to a full quirk driver for descriptor fixups and event filtering
- [Introduce eBPF support for HID devices](https://lwn.net/Articles/886860/) — Benjamin Tissoires's v2 cover letter proposing HID-BPF upstream, archived on LWN (a mailing-list post, not LWN editorial coverage)
