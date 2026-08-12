# Kernel Mode Setting (KMS): the Object Model and Atomic Modesetting

> Four objects that model a display pipeline, and one ioctl that changes all of them together or none of them at all

## The problem: describing a display pipeline in the kernel

Turning a framebuffer into photons on a screen is not one operation, it is a chain of them: pick a rectangle of pixel data, scale and position it, blend it with any other layers sharing the screen, convert the result into a signal a cable or panel understands, and drive that signal out a physical port at the right timing so the display doesn't just show garbage. [KMS (Kernel Mode Setting)](README.md) is DRM's model of that chain. It represents each stage as a kernel object — `drm_plane`, `drm_crtc`, `drm_encoder`, `drm_connector` — wires them into a pipeline per display, and gives userspace one ioctl, `DRM_IOCTL_MODE_ATOMIC`, to propose and validate a complete pipeline configuration before any of it touches hardware.

KMS itself dates to December 2008, when [`f453ba046074`](https://git.kernel.org/linus/f453ba0460742ad027ae0c4c7d61e62817b3e7ef) moved modesetting out of X and into the kernel (see the [DRM overview](README.md) for that history). What this page covers is what came after: the object model KMS introduced, and the atomic ioctl that — six years later — replaced KMS's original one-property-at-a-time interface.

## The four objects

### `drm_plane` — a hardware compositing layer

A plane is one layer of pixel data that display hardware can scan out and blend with other planes, all in a fixed-function compositor built into the display controller — no GPU 3D engine involved. `include/drm/drm_plane.h` defines three types:

```c
enum drm_plane_type {
	DRM_PLANE_TYPE_OVERLAY,  /* any non-primary, non-cursor plane ("sprites") */
	DRM_PLANE_TYPE_PRIMARY,  /* the plane most likely to light up the CRTC alone */
	DRM_PLANE_TYPE_CURSOR,   /* small plane sized for drm_mode_config.cursor_{width,height} */
};
```

`struct drm_plane` carries the hardware-independent state — `format_types` (the pixel formats it accepts), `possible_crtcs` (which CRTCs it can feed), and the currently-bound `fb`/`crtc`. The per-commit geometry lives in `struct drm_plane_state`:

```c
// include/drm/drm_plane.h
struct drm_plane_state {
	struct drm_plane   *plane;
	struct drm_crtc     *crtc;
	struct drm_framebuffer *fb;   // the buffer this plane is scanning out
	...
	int32_t  crtc_x,  crtc_y;     // position on the CRTC, integer pixels
	uint32_t crtc_w,  crtc_h;     // size on the CRTC, integer pixels
	uint32_t src_x,   src_y;      // position within the source fb, 16.16 fixed point
	uint32_t src_w,   src_h;      // size of the sampled region, 16.16 fixed point
	unsigned int rotation;
	unsigned int zpos;            // blend order relative to other planes
	struct drm_rect src, dst;     // derived integer rects
	bool visible;
	...
};
```

The distinction between `src_*` (fixed-point, in the framebuffer's own coordinate space — this is what lets a plane crop or scale) and `crtc_*` (integer, in the output's coordinate space — this is where the result lands) is what makes a plane a real compositing primitive rather than just a pointer to a buffer.

Multi-plane hardware matters because it's the difference between the display controller doing compositing for free and the GPU having to render one. A video player showing a 4K movie in a window doesn't need to touch the 3D engine at all: it decodes into a buffer, hands that buffer directly to an overlay plane sized and positioned over the window, and the display controller blends it with the desktop's primary plane in hardware, scan line by scan line, at zero GPU cost and with no extra memory copy. Lose the overlay plane — headless SoC displays, or a compositor unable to find one free — and that same video has to be composited into the desktop framebuffer by the GPU every frame instead.

### `drm_crtc` — the scanout engine

A CRTC (the name is a holdover from CRT "Cathode Ray Tube Controller" hardware) is the engine that actually walks a composited image out to an encoder in real time, line by line, timed against a `drm_display_mode`. `struct drm_crtc` holds two built-in plane pointers — every CRTC has at least a `primary` plane, and usually a `cursor` plane:

```c
// include/drm/drm_crtc.h
struct drm_crtc {
	...
	struct drm_plane *primary;
	struct drm_plane *cursor;
	...
	struct drm_display_mode mode;    // current, legacy-path timings
	struct drm_display_mode hwmode;  // what's actually programmed after adjustment
	...
	struct drm_crtc_state *state;    // current atomic state
};
```

The mode itself, `struct drm_display_mode` (`include/drm/drm_modes.h`), is the full CRT-derived timing description: pixel `clock` in kHz, and the horizontal/vertical `display`/`sync_start`/`sync_end`/`total` values that define active pixels, sync pulses, and blanking intervals. `struct drm_crtc_state` is where atomic commits actually record what changed:

```c
// include/drm/drm_crtc.h
struct drm_crtc_state {
	struct drm_crtc *crtc;
	bool enable;
	bool active;
	bool planes_changed     : 1;
	bool mode_changed       : 1;   // @mode or @enable changed — needs a real modeset
	bool active_changed     : 1;
	bool connectors_changed : 1;
	...
	u32 plane_mask, connector_mask, encoder_mask;
	struct drm_display_mode mode, adjusted_mode;
	...
};
```

`mode_changed`, together with `active_changed` and `connectors_changed`, is what `drm_atomic_crtc_needs_modeset()` combines and the atomic core checks against `DRM_MODE_ATOMIC_ALLOW_MODESET`, covered below.

### `drm_encoder` — signal conversion, increasingly a formality

`include/drm/drm_encoder.h` describes the encoder's job in one line: "CRTCs drive pixels to encoders, which convert them into signals appropriate for a given connector." `encoder_type` names the format it produces — `DRM_MODE_ENCODER_TMDS` for DVI/HDMI/eDP, `DRM_MODE_ENCODER_DAC` for VGA, `DRM_MODE_ENCODER_DSI`/`DPI` for panels, `DRM_MODE_ENCODER_VIRTUAL` for VM displays — and `possible_crtcs`/`possible_clones` are bitmasks fixed at registration time describing which CRTCs can drive this encoder and which sibling encoders it can clone alongside.

On real hardware from the era KMS was designed for, the encoder was a distinct block: a TMDS transmitter chip, a separate silicon block doing signal conversion downstream of the scanout engine. On modern SoCs and integrated GPUs that block is frequently either fused into the same hardware as the CRTC or reduced to fixed muxing, and the kernel's own header now says as much: `drm_encoder.crtc` is documented as "only really meaningful for non-atomic drivers. Atomic drivers should instead check `drm_connector_state.crtc`" — atomic drivers are steered toward asking the *connector* which CRTC drives it, treating the encoder as bookkeeping rather than a real object to reason about. Many simple modern drivers instantiate exactly one encoder per connector purely to satisfy the object model.

### `drm_connector` — the physical output, and hotplug

The connector is the one object tied to something you can point at on the back of the machine: an HDMI jack, a DisplayPort connector, an eDP panel's fixed internal link. It owns the connection's mutable state — is anything plugged in right now, and what modes does whatever is plugged in support:

```c
// include/drm/drm_connector.h
struct drm_connector {
	...
	int connector_type;                 // DRM_MODE_CONNECTOR_HDMIA, ...
	enum drm_connector_status status;
	struct list_head modes;             // drm_display_mode list, EDID-derived
	struct drm_display_info display_info;
	const struct drm_connector_funcs *funcs;
	const struct drm_connector_helper_funcs *helper_private;
	u32 possible_encoders;
	struct drm_encoder *encoder;
	...
	struct drm_connector_state *state;
};
```

Detection is a driver callback, not core logic — `struct drm_connector_funcs` and its atomic-aware counterpart in `include/drm/drm_modeset_helper_vtables.h`:

```c
// drm_connector_funcs
enum drm_connector_status (*detect)(struct drm_connector *connector, bool force);

// drm_connector_helper_funcs — the modeset-lock-aware version
int (*detect_ctx)(struct drm_connector *connector,
		   struct drm_modeset_acquire_ctx *ctx, bool force);
```

`force` tells the driver whether this is a cheap periodic poll (leave it false, skip expensive/destructive probing) or a user-initiated recheck where it's fine to do a real, possibly disruptive detection cycle. A hotplug event — a monitor plugged into HDMI, a DP dock connected — fires an interrupt the driver turns into a call to `drm_kms_helper_hotplug_event()`, which schedules connector re-probing; userspace (a compositor listening on the DRM fd, or via udev) picks up the resulting uevent and re-reads connector state through `DRM_IOCTL_MODE_GETCONNECTOR`.

Once something is detected, `helper_private->get_modes()` populates the connector's mode list, ordinarily by reading EDID over I2C/DDC or an AUX channel and parsing it into `drm_display_mode` entries via `drm_add_edid_modes()`/`drm_helper_probe_add_cmdline_mode()`-style helpers — this is where a 4K panel's native timing and a monitor's supported refresh rates actually come from.

### The pipeline, and where the framebuffer attaches

```
  drm_framebuffer                                                   physical
  (GEM buffer +          drm_plane(s)      drm_crtc      drm_encoder    display
   format/pitch)   ──►   (composite)  ──►  (scanout,  ──►  (signal  ──► drm_connector
                         primary/            timing)        convert)    (HDMI/eDP/…)
                         cursor/overlay
```

A `drm_framebuffer` is metadata over GEM buffer objects — pixel `format`, per-plane `pitches`/`offsets`, `width`/`height` — that doesn't itself belong to any particular plane; it's attached by assigning it to `drm_plane_state.fb` as part of a commit. One or more planes feed a CRTC, which reads them in composited form, applies its `drm_display_mode` timing, and drives the result to the encoder bound to it (directly, or via `drm_bridge` chain hops for things like SoC-internal MIPI-to-eDP converters); the encoder converts to the connector's signal format, and the connector is the wire out to the display. All four object types, plus the framebuffer, are modeset objects (`struct drm_mode_object`); planes, CRTCs, and connectors each carry their own property sets — which is exactly what made changing them one at a time so dangerous, covered next.

## Why the legacy API had to go

The original 2008 KMS interface was modeled closely on X's own XRandR-era model: a `DRM_IOCTL_MODE_SETCRTC` (`drm_mode_setcrtc()`) to bind a CRTC to a mode, connectors, and a framebuffer in one call, plus separate ioctls layered on afterward as needs grew — `DRM_IOCTL_MODE_SETPLANE` for plane updates, and once properties existed, `DRM_IOCTL_MODE_OBJ_SETPROPERTY` (`drm_mode_obj_set_property_ioctl()`) to change one property on one object per call. All of these ioctl entries are still present in `drivers/gpu/drm/drm_ioctl.c` today, kept for legacy userspace.

The failure mode was structural, not incidental. A compositor reacting to a hotplug — say, a laptop's external monitor appearing, forcing a mode change on the internal panel to keep both in sync — had to issue a sequence of separate ioctls: disable one CRTC, set a new mode on another, re-point planes, re-enable. Nothing prevented another process (or the same compositor, on the next vblank) from observing the display mid-sequence, and nothing let the kernel reject the *whole* sequence up front if step three turned out to be invalid on the real hardware — you found out by getting a mid-sequence error and a screen already left in a half-updated state. There was no way to ask "would this new configuration work at all" without actually applying pieces of it.

The fix was proposed and driven by two DRM developers over 2014: Rob Clark posted the locking and state-tracking infrastructure as a 17-patch series, ["prepare for atomic/nuclear modeset/pageflip"](https://lwn.net/Articles/600369/), to dri-devel in May 2014 — explicitly infrastructure-only, not yet the ioctl itself. Daniel Vetter then reworked and landed the core state-tracking object in [`cc4ceb484b37`](https://github.com/torvalds/linux/commit/cc4ceb484b37b9369e0d4e8682b7ae1849ae4579) ("drm: Global atomic state handling," July 2014), whose commit message describes it explicitly as a divergence from — and successor to — "Rob's patches." Vetter's [cover letter](https://lore.kernel.org/dri-devel/1406497308-30733-1-git-send-email-daniel.vetter@ffwll.ch/) for that series lays out why he diverged: synchronous, software-side state updates so "all the tricky locking dances can be abolished," and check-only operations that don't have to block on the previous update completing, since "compositors need to do [this] right after having completed the current frame." Rob Clark defended his own design in the same thread — his refcounted state was meant to let states chain so check-only paths needed no locks at all, and "in cases where drivers have to fwd one property to another object or other sort of side effect, I think my way was nicer, imho ;-)." Vetter's design is the one that shipped.

Rob Clark then landed the userspace-facing entry point itself in [`d34f20d6e2f2`](https://github.com/torvalds/linux/commit/d34f20d6e2f21bd3531b969dc40913181a8ae31a) ("drm: Atomic modeset ioctl," December 2014, reviewed by Daniel Vetter and Sean Paul), which added `DRM_IOCTL_MODE_ATOMIC` and gated it behind a `DRM_CLIENT_CAP_ATOMIC` capability flag so legacy userspace wouldn't stumble into it by accident. The [RFC two days before](https://lore.kernel.org/dri-devel/1418771141-16954-1-git-send-email-robdclark@gmail.com/) the merged version is where the uAPI itself got argued over: Michel Dänzer pushed for the ioctl to take an explicit *when*-parameter for the change to take effect, and — anticipating variable-refresh-rate displays — that it should be a timestamp rather than a frame counter. Pekka Paalanen, drawing on Wayland's own Presentation extension, pushed back on the complexity a queueing model like that opens up: how do you cancel a commit scheduled an hour out? The ioctl that shipped took neither — commits are either synchronous or nonblocking-and-immediate, with no scheduled-future-commit concept at all. The interface, and enough converted drivers to rely on it, shipped in Linux 4.2 in mid-2015 — LWN's two-part design writeup, [part 1](https://lwn.net/Articles/653071/) and [part 2](https://lwn.net/Articles/653466/) (Daniel Vetter, August 2015), frames the driving motivation as Wayland-era compositors needing "every frame is perfect" semantics and power-sensitive mobile/embedded hardware needing to batch state changes instead of touching registers one property at a time.

## How an atomic commit actually works

### The container: `drm_atomic_state` → `drm_atomic_commit`

The atomic core assembles a proposed configuration into one container object before touching anything. From 2014 through Linux 7.1 this struct was named `struct drm_atomic_state`, and that's the name you'll see in the LWN articles above and in most driver code still in wide deployment. In April 2026 it was renamed to `struct drm_atomic_commit` by [`5164f7e7ff8e`](https://github.com/torvalds/linux/commit/5164f7e7ff8ec7d41065d3862630c2ba09854328) ("drm: Rename struct drm_atomic_state to drm_atomic_commit," Maxime Ripard) — the commit message's rationale is that `drm_atomic_state` was easily confused with the *per-object* state structs (`drm_plane_state`, `drm_crtc_state`, etc.), when it's actually a commit-in-progress that references old and new per-object states, not "the state" of the device. This page uses the current name; mentally substitute `drm_atomic_state` if you're reading pre-2026 kernel source or documentation — it's the same object.

```c
// include/drm/drm_atomic.h (current master)
struct drm_atomic_commit {
	struct kref ref;
	struct drm_device *dev;

	bool allow_modeset       : 1;   // DRM_MODE_ATOMIC_ALLOW_MODESET was set
	bool legacy_cursor_update : 1;
	bool async_update        : 1;
	bool duplicated          : 1;
	bool checked             : 1;   // ->atomic_check has run

	struct __drm_planes_state     *planes;
	struct __drm_crtcs_state      *crtcs;
	int num_connector;
	struct __drm_connnectors_state *connectors;
	int num_private_objs;
	struct __drm_private_objs_state *private_objs;

	struct drm_modeset_acquire_ctx *acquire_ctx;
	struct drm_crtc_commit *fake_commit;
	struct work_struct commit_work;
	...
};
```

Each per-object array entry holds both the object's old state (what's currently live) and the proposed new state, obtained via `drm_atomic_get_crtc_state()` / `drm_atomic_get_plane_state()` / `drm_atomic_get_connector_state()` — calling one of these is what pulls an object into the commit and duplicates its current state for the driver to mutate.

### The check/commit split

Two entry points, cleanly separated:

- **`drm_atomic_check_only(struct drm_atomic_commit *state)`** (`drivers/gpu/drm/drm_atomic.c`) — validates the proposed state against `config->funcs->atomic_check`, and additionally rejects the commit with `-EINVAL` if any CRTC needs a full modeset (`drm_atomic_crtc_needs_modeset()`: `mode_changed`, `active_changed`, or `connectors_changed`) but `state->allow_modeset` is false. No hardware is touched. Drivers implementing `atomic_check` typically call the generic **`drm_atomic_helper_check(struct drm_device *dev, struct drm_atomic_commit *state)`** (`drivers/gpu/drm/drm_atomic_helper.c`) as their first step, which runs the shared plane/CRTC/connector cross-validation (does every enabled CRTC have a mode and at least one connector, do plane geometries fit, etc.) before any hardware-specific checks.
- **`drm_atomic_commit(struct drm_atomic_commit *state)`** / **`drm_atomic_nonblocking_commit(struct drm_atomic_commit *state)`** — both documented as internally calling check first ("checking will be internally enforced by always calling `->atomic_check` before `->atomic_commit`," per the original design commit), then applying the state to hardware. Either can return `-EDEADLK` if the ww-mutex locking (`state->acquire_ctx`, a `drm_modeset_acquire_ctx`) hit a backoff case; the caller is expected to drop locks and retry, which is exactly what the ioctl handler does in its `retry:` loop.

### uAPI flags

The ioctl struct and its flags, defined in `include/uapi/drm/drm_mode.h` since the original `d34f20d6e2f2` and unchanged since:

```c
#define DRM_MODE_ATOMIC_TEST_ONLY      0x0100
#define DRM_MODE_ATOMIC_NONBLOCK       0x0200
#define DRM_MODE_ATOMIC_ALLOW_MODESET  0x0400

struct drm_mode_atomic {
	__u32 flags;
	__u32 count_objs;
	__u64 objs_ptr;           // array of object IDs
	__u64 count_props_ptr;    // array of per-object property counts
	__u64 props_ptr;          // flat array of property IDs
	__u64 prop_values_ptr;    // flat array of property values
	__u64 reserved;
	__u64 user_data;          // echoed back in the completion event
};
```

- **`DRM_MODE_ATOMIC_TEST_ONLY`** — run `drm_atomic_check_only()` and return its result; never call commit. This is the "would this work" dry run the legacy API had no equivalent for — a compositor can probe an arbitrary combination of mode/plane/property changes and get a definitive yes/no with zero visible side effects.
- **`DRM_MODE_ATOMIC_ALLOW_MODESET`** — without it, any change that would require a real modeset (`drm_atomic_crtc_needs_modeset()`) is rejected. Compositors set this only for actual mode changes and leave it off for routine per-frame plane/property updates, so a buggy commit can't accidentally force a full, visible modeset.
- **`DRM_MODE_ATOMIC_NONBLOCK`** — routes to `drm_atomic_nonblocking_commit()` instead of `drm_atomic_commit()`; the ioctl returns once the commit is validated and queued, without waiting for the hardware to actually flip.
- **`DRM_MODE_PAGE_FLIP_EVENT`** (shared with the legacy page-flip ioctl) — request a completion event; mutually exclusive with `TEST_ONLY` (checked explicitly in `drm_mode_atomic_ioctl()`, since a dry run has nothing to signal completion of).

### Completion: vblank-synced events

When `DRM_MODE_PAGE_FLIP_EVENT` is set, the ioctl handler attaches a `struct drm_pending_vblank_event` to each affected CRTC's `crtc_state->event`. Once the driver's atomic commit worker has actually written the new state to hardware and the display has flipped at the next vblank, it calls **`drm_crtc_send_vblank_event(struct drm_crtc *crtc, struct drm_pending_vblank_event *e)`** (`drivers/gpu/drm/drm_vblank.c`), which stamps the event with the current vblank sequence number and timestamp and queues it for delivery; userspace reads it back off the DRM file descriptor as a `DRM_EVENT_FLIP_COMPLETE`. `struct drm_crtc_commit` (one per CRTC per in-flight commit, referenced from `drm_crtc_state.commit`) exposes this as three `completion` stages a driver or helper can wait on — `flip_done` (hardware has flipped, same moment the event fires), `hw_done` (all register writes for the commit are out, which for a CRTC being *disabled* can be later than `flip_done`), and `cleanup_done` (old buffers released) — which is what lets `DRM_MODE_ATOMIC_NONBLOCK` commits queue up behind each other correctly instead of racing.

## Worked example: hotplug, then an overlay video commit

**1. A display appears.** The driver's hotplug interrupt handler calls `drm_kms_helper_hotplug_event()`; the compositor gets a uevent, re-reads connectors via `DRM_IOCTL_MODE_GETCONNECTOR`, and sees a new connector with `status == connector_status_connected` and a freshly populated mode list. To light it up, it builds one `DRM_IOCTL_MODE_ATOMIC` request: object IDs for the connector, its CRTC, and the CRTC's primary plane; properties `CRTC_ID` on the connector, `MODE_ID` (a blob property referencing the chosen `drm_display_mode`) and `ACTIVE=1` on the CRTC, and `CRTC_ID`/`FB_ID`/`CRTC_X`/`CRTC_Y`/`CRTC_W`/`CRTC_H`/`SRC_*` on the primary plane. It sets `DRM_MODE_ATOMIC_ALLOW_MODESET` (this is a real mode change) and, for a first dry run, `DRM_MODE_ATOMIC_TEST_ONLY`.

Kernel-side, `drm_mode_atomic_ioctl()` (`drivers/gpu/drm/drm_atomic_uapi.c`) walks `objs_ptr`/`props_ptr`/`prop_values_ptr`, resolving each object with `drm_mode_object_find()` and routing each property through `drm_atomic_set_property()`, which pulls the relevant object into the commit (`drm_atomic_get_crtc_state()` etc.) and mutates its proposed `drm_crtc_state`/`drm_plane_state`/`drm_connector_state`. Because `TEST_ONLY` is set, it calls only `drm_atomic_check_only()` — which runs the driver's `atomic_check` (typically starting with `drm_atomic_helper_check()`), skips the modeset rejection (`drm_atomic_crtc_needs_modeset()` is true here, but `allow_modeset` was set), and returns 0 or an error without a single register write happening. The compositor repeats the same request without `TEST_ONLY` (optionally adding `DRM_MODE_PAGE_FLIP_EVENT`) to actually apply it; this time `drm_atomic_commit()` runs, hardware is reprogrammed, and — once the new mode is actually scanning out — `drm_crtc_send_vblank_event()` signals completion.

**2. A video app requests direct-scanout overlay.** A fullscreen video player wants its decoded frames to bypass GPU composition entirely. It finds a plane of type `DRM_PLANE_TYPE_OVERLAY` usable on the same CRTC as the desktop (enumerated via `DRM_IOCTL_MODE_GETPLANERESOURCES` / `GETPLANE`, filtering `possible_crtcs`), and issues an atomic commit touching only that plane: `CRTC_ID` binding it to the desktop's CRTC, `FB_ID` pointing at its latest decoded buffer, `CRTC_X`/`CRTC_Y`/`CRTC_W`/`CRTC_H` for where the video window sits, `SRC_X`/`SRC_Y`/`SRC_W`/`SRC_H` (16.16 fixed point) for the source crop, and `zpos` above the desktop's primary plane but below any cursor. No `ALLOW_MODESET` — nothing here should require a modeset, so the commit goes through without it; if a bug did make the CRTC need one, the kernel would reject the commit rather than flash the screen, which is exactly the safety property compositors want for a per-frame update. `DRM_MODE_ATOMIC_NONBLOCK | DRM_MODE_PAGE_FLIP_EVENT` lets the player queue the next frame's commit without blocking, throttled by waiting for the previous frame's flip-complete event before submitting the next — the same rhythm a page-flip loop always had, just now expressed as one atomic commit per frame instead of a plane-specific ioctl.

## Further reading

- [Kernel docs: kernel mode setting (KMS)](https://docs.kernel.org/gpu/drm-kms.html) — the authoritative object-model and atomic-design reference, kept in sync with `Documentation/gpu/drm-kms.rst`
- [`f453ba046074`](https://git.kernel.org/linus/f453ba0460742ad027ae0c4c7d61e62817b3e7ef) — "DRM: add mode setting support," the original December 2008 KMS merge
- [`cc4ceb484b37`](https://github.com/torvalds/linux/commit/cc4ceb484b37b9369e0d4e8682b7ae1849ae4579) — "drm: Global atomic state handling," Daniel Vetter, July 2014: the core atomic state object
- [lore.kernel.org: atomic, remixed](https://lore.kernel.org/dri-devel/1406497308-30733-1-git-send-email-daniel.vetter@ffwll.ch/) — the July 2014 design thread, including Rob Clark's defense of his own competing approach
- [`d34f20d6e2f2`](https://github.com/torvalds/linux/commit/d34f20d6e2f21bd3531b969dc40913181a8ae31a) — "drm: Atomic modeset ioctl," Rob Clark, December 2014: the `DRM_IOCTL_MODE_ATOMIC` entry point
- [lore.kernel.org: Atomic Properties (RFC: drm: Atomic modeset ioctl)](https://lore.kernel.org/dri-devel/1418771141-16954-1-git-send-email-robdclark@gmail.com/) — the uAPI debate, including the rejected timestamp-based scheduling proposal
- [`5164f7e7ff8e`](https://github.com/torvalds/linux/commit/5164f7e7ff8ec7d41065d3862630c2ba09854328) — "drm: Rename struct drm_atomic_state to drm_atomic_commit," Maxime Ripard, April 2026
- [LWN: "prepare for atomic/nuclear modeset/pageflip"](https://lwn.net/Articles/600369/) — Rob Clark's May 2014 infrastructure series that started the transition
- [LWN: Atomic mode setting design overview, part 1](https://lwn.net/Articles/653071/) — Daniel Vetter, August 2015, on the legacy interface's history and limits
- [LWN: Atomic mode setting design overview, part 2](https://lwn.net/Articles/653466/) — Daniel Vetter, August 2015, on the check/commit split and locking
- `drivers/gpu/drm/drm_atomic.c`, `drivers/gpu/drm/drm_atomic_uapi.c`, `drivers/gpu/drm/drm_atomic_helper.c` in the kernel tree — the current implementation
- [DRM: the Direct Rendering Manager](README.md) — the object model's place in the wider GPU stack
