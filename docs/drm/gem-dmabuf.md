# GEM Buffer Objects and dma-buf: Allocating and Sharing GPU Memory

> One base object every driver's buffer type embeds for refcounted GPU memory, and one framework — dma-buf — for handing that memory to a completely different device without copying it

## The problem: GPU memory needs a lifecycle, and it needs to leave the GPU

A frame a GPU renders doesn't stay on the GPU. It gets scanned out by a display controller that might be a second, entirely separate driver on a hybrid-graphics laptop. A frame a camera captures doesn't stay in the camera driver either — a compositor wants to hand it straight to the GPU for scaling and color conversion, with no CPU copy in between. Both cases need the same two things: a kernel-tracked, refcounted object to represent a chunk of GPU-visible memory, and a way to pass a *reference* to that memory across a driver boundary the exporting driver knows nothing about, safely and without copying.

**GEM (Graphics Execution Manager)** is the first piece: the base buffer-object type every DRM driver's memory allocator builds on, and the per-process/per-device handle system userspace uses to refer to it. **dma-buf** is the second: a cross-subsystem framework, not DRM-specific, for exporting any kernel buffer as a file descriptor another driver can attach to, map for its own DMA, and synchronize against — whether that other driver is a second GPU, a display controller, or a V4L2 video capture device. DRM's own binding to it is called **PRIME**.

## GEM: the base buffer object

`struct drm_gem_object` (`include/drm/drm_gem.h`) is the generic part every driver-specific buffer type embeds as its first member. It doesn't know anything about pixel formats or hardware placement — that's left to the driver or to helper layers built on top — it just handles refcounting, mmap bookkeeping, and the plumbing that makes a GEM object exportable:

```c
// include/drm/drm_gem.h
struct drm_gem_object {
	struct kref refcount;              // reference count; drm_gem_object_get()/_put()
	unsigned handle_count;              // number of open per-process handles

	struct drm_device *dev;             // owning DRM device

	struct file *filp;                  // shmem backing file, or NULL for driver-private storage

	struct drm_vma_offset_node vma_node; // mmap offset bookkeeping

	size_t size;                        // immutable over the object's lifetime

	int name;                           // GEM_FLINK/GEM_OPEN global name; 0 = unnamed

	struct dma_buf *dma_buf;            // dma-buf this object is exported/imported through
	struct dma_buf_attachment *import_attach; // set only for objects imported from elsewhere

	struct dma_resv *resv;              // reservation object: normally == &_resv
	struct dma_resv _resv;              // the reservation object itself, for non-imported objects

	const struct drm_gem_object_funcs *funcs; // free/open/close/export/pin/vmap/mmap/evict/...
	...
};
```

A few things worth noting directly from that layout:

- **Refcounting is a plain `struct kref`.** `drm_gem_object_get()` calls `kref_get()`; `drm_gem_object_put()` calls `kref_put()` against `drm_gem_object_free()`, which dispatches to the driver's `funcs->free`.
- **`resv` and `_resv` are separate fields on purpose.** For a normal, locally allocated object `resv` just points back at its own embedded `_resv`. For an object imported from another device's dma-buf, `resv` instead points at the *exporter's* reservation object — so fence tracking follows the underlying buffer, not whichever driver most recently imported it, which is exactly what lets two different GPU drivers agree on who's still using a shared buffer (see [Fences and `dma_resv`](#fences-and-dma_resv), below).
- **`dma_buf` and `import_attach` are the two dma-buf linkage points.** `dma_buf` is set for a GEM object either way — exported or imported (`drm_gem.h` documents it as associated with the object "either through importing or exporting"). `import_attach` is what's specific to the import direction (pointing at this device's attachment to someone else's dma-buf), which is exactly why `drm_gem_is_imported()` tests `!!obj->import_attach` rather than checking `dma_buf`, which wouldn't distinguish the two cases.
- **`name` is the deprecated global name** — more on why below.

### Three ways to reference a GEM object, and why two of them are obsolete

A GEM object needs some integer userspace can pass through an ioctl — you can't hand a raw kernel pointer across the syscall boundary. DRM has had three answers to "which integer," introduced in roughly this order, each fixing a limitation or security problem in the last:

**1. The handle** — a `u32` returned by whatever ioctl created or imported the object (a driver's dumb-buffer or GEM-create ioctl, or `DRM_IOCTL_PRIME_FD_TO_HANDLE`), scoped to a single `struct drm_file` — i.e., to one open file description on `/dev/dri/card0` or `/dev/dri/renderD128`. It lives in that file's `object_idr` (`include/drm/drm_file.h`: "Mapping of mm object handles to object pointers. Used by the GEM subsystem."). A handle from one process's fd means nothing to another process; there's no cross-process sharing story here at all. It's released with `DRM_IOCTL_GEM_CLOSE`.

**2. The global name (`GEM_FLINK`/`GEM_OPEN`) — deprecated.** `DRM_IOCTL_GEM_FLINK` turns a handle into a small global integer (`struct drm_gem_object.name`) visible to *any* process that can open the DRM node; `DRM_IOCTL_GEM_OPEN` turns that integer back into a handle in the caller's own namespace. The problem is exactly what it sounds like: a flink name is a small, sequentially-ish allocated integer with **no access control** — nothing stops a second, unrelated process on the same system from calling `GEM_OPEN` with a guessed or brute-forced name and getting a handle to a buffer it was never given. `docs.kernel.org`'s DRM uAPI documentation is blunt about the consequence: render nodes, introduced to let unprivileged clients submit rendering work, are explicitly designed to avoid "the buffer-leaks, which occur if clients guess the flink names," and state outright that **"New clients must not use the insecure FLINK interface."**

**3. The dma-buf file descriptor (via DRM PRIME) — the modern mechanism.** `DRM_IOCTL_PRIME_HANDLE_TO_FD` exports a handle as an fd backed by a `struct dma_buf`. An fd carries ordinary Unix file-descriptor security semantics: it isn't guessable, and the only ways to get one are being handed it explicitly — passed over a `SCM_RIGHTS` control message on a Unix domain socket, or inherited across `fork()` — both of which require the sender to have chosen to share it. DRM's own kerneldoc in `drivers/gpu/drm/drm_prime.c` states the comparison directly: PRIME fds "offer additional security: as file descriptors must be explicitly sent over UNIX domain sockets to be shared between applications, they can't be guessed like the globally unique GEM names." This is also the *only* one of the three that works across devices — a name or a handle only ever means something to one specific DRM driver's own object namespace; a dma-buf fd can be handed to a totally different driver (see [DRM PRIME](#drm-prime-drms-dma-buf-binding), below).

### Backing memory: shmem helpers vs. TTM

`drm_gem_object` itself says nothing about *where* the bytes live — that's the job of a backing-memory helper layered on top, and which one a driver uses tracks directly to whether its GPU has its own dedicated video memory.

**`struct drm_gem_shmem_object`** (`include/drm/drm_gem_shmem_helper.h`) is the simple, common case: `struct drm_gem_shmem_object { struct drm_gem_object base; struct page **pages; ... struct sg_table *sgt; void *vaddr; ... }`. Backing storage is an ordinary shmem file (`drm_gem_object.filp`) — swappable system RAM, the same pool any other process memory comes from. This is what integrated GPUs and simpler SoC display/render drivers use, because there's no second memory pool to manage: system RAM is the only memory the GPU can address.

Discrete GPUs don't have that luxury — they have their own on-board VRAM, which is faster than going over PCIe to system memory but far more limited in size, so the kernel has to decide what lives where and migrate buffers between the two as pressure demands. That's **TTM (Translation Table Manager)**, DRM's original, older memory manager, predating GEM. There's no separate `drm_gem_ttm_object` type — instead `struct ttm_buffer_object` (`include/drm/ttm/ttm_bo.h`) embeds a `struct drm_gem_object base` directly, the same pattern the shmem helper uses:

```c
// include/drm/ttm/ttm_bo.h
struct ttm_buffer_object {
	struct drm_gem_object base;
	struct ttm_device *bdev;
	enum ttm_bo_type type;
	...
	struct ttm_resource *resource;   // current placement: VRAM range, or system memory
	struct ttm_tt *ttm;              // page array for the "TT" (system-memory) case
	...
};
```

`drm_gem_ttm_helper.h` supplies the glue (`drm_gem_ttm_vmap()`, `drm_gem_ttm_mmap()`, a `drm_gem_ttm_of_gem()` `container_of` macro) that lets a TTM-backed object still present a normal `drm_gem_object_funcs` vtable to the rest of DRM. The kernel's own memory-management documentation frames the split this way: TTM "tri[es] to be a one-size-fits-them all solution" for VRAM-plus-system-memory placement and eviction, while GEM "identified common code between drivers and created a support library to share it" for the simpler UMA case — which is why amdgpu and nouveau sit on TTM and most integrated/SoC drivers sit on the shmem helper. TTM's internal eviction and placement machinery is its own large subsystem and out of scope here; what matters for this page is just that both backing types are `drm_gem_object` underneath, so everything above — handles, names, dma-buf export, `resv` — works identically regardless of which one a driver picked.

## dma-buf: sharing a buffer across driver boundaries

### Why it exists

Before dma-buf, if a V4L2 capture driver had a frame and a separate DRM driver's GPU needed to touch it — scale it, color-convert it, composite it — the only options were a real memory copy, or a one-off hack coupling those two specific drivers together. Neither scales: a copy costs bandwidth and latency on every frame, and driver-pair-specific glue means every new combination of producer and consumer needs its own code.

dma-buf was proposed at the 2011 Linaro/kernel mini-summits and landed as a generic, subsystem-agnostic framework rather than a GPU-specific one. The foundational commit, [`d15bd7ee445d`](https://github.com/torvalds/linux/commit/d15bd7ee445d0702ad801fdaece348fdb79e6581) ("dma-buf: Introduce dma buffer sharing mechanism," Sumit Semwal, authored 26 December 2011, committed by Dave Airlie 6 January 2012 for the Linux 3.3 merge window), is explicit that it's building on earlier work — "based on design suggestions from many people at the mini-summits... most notably from Arnd Bergmann, Rob Clark and Daniel Vetter" — and that the whole mechanism was demonstrated first between two V4L2 devices by Tomasz Stanislawski. That design took three public RFC rounds to settle: the [second of them](https://lore.kernel.org/dri-devel/1322816252-19955-1-git-send-email-sumit.semwal@ti.com/), posted 2 December 2011, is where most of the subsystem-agnostic shape got argued over, with Arnd Bergmann, Daniel Vetter, Rob Clark, Dave Airlie, Alan Cox, and driver maintainers from NVIDIA, Samsung, and the V4L2 side all weighing in on the same thread. LWN's coverage at the time, [**"DMA buffer sharing in 3.3"**](https://lwn.net/Articles/474819/) (Jonathan Corbet, January 11, 2012), states the intended use case in almost exactly the terms this page opened with: *"The initial target use is sharing buffers between producers and consumers of video streams; a camera device, for example, could acquire a stream of frames into a series of buffers that are shared with the graphics adapter, enabling the capture and display of the data with no copying in the kernel."*

DRM's own binding on top, **PRIME**, followed not long after: [`3248877ea179`](https://github.com/torvalds/linux/commit/3248877ea1796915419fba7c89315fdbf00cb56a) ("drm: base prime/dma-buf support (v5)," Dave Airlie, authored 25 November 2011, committed 30 March 2012 for the Linux 3.4 merge window) added the GEM-handle-to-dma-buf-fd translation layer, explicitly as "a starting point" for driver support that followed in nouveau, i915, and others. Reviewing the merged version, Daniel Vetter gave a `Reviewed-by`, and [Ben Widawsky's `Acked-by`](https://lore.kernel.org/dri-devel/20120327183151.0523bf8d@bwidawsk.net/) came with a telling aside: "I swear there was some other reason for the global hash... if only I could remember it."

### `struct dma_buf`

`include/linux/dma-buf.h` defines the exported object itself:

```c
// include/linux/dma-buf.h
struct dma_buf {
	size_t size;                       // invariant over the buffer's lifetime
	struct file *file;                 // the fd userspace holds; also used for refcounting
	struct list_head attachments;      // one entry per attached device, guarded by resv
	const struct dma_buf_ops *ops;     // exporter's vtable
	...
	const char *exp_name;              // exporting driver's name, for debugging
	struct dma_resv *resv;             // reservation object: fences for this buffer
	wait_queue_head_t poll;            // userspace poll() support
	...
};
```

`ops` is a `struct dma_buf_ops` the exporting driver fills in — `attach`/`detach`, `map_dma_buf`/`unmap_dma_buf`, `pin`/`unpin`, `mmap`, `vmap`/`vunmap`, and `release` — the vtable every dma-buf importer interacts with indirectly through the generic `dma_buf_*()` API rather than ever calling an exporter's callback directly.

### The attach/map dance

Getting from "I have an fd" to "I can DMA into this buffer" is deliberately two steps, not one:

1. **`dma_buf_attach(struct dma_buf *dmabuf, struct device *dev)`** — the importer declares *intent* to use the buffer from a specific device, and creates a `struct dma_buf_attachment`. This calls the exporter's optional `dma_buf_ops.attach` callback, which is the exporter's chance to say no: kerneldoc for that callback spells out exactly why — "exporters which support buffer objects in special locations like VRAM or device-specific carveout areas should check whether the buffer could be move [sic] to system memory (or directly accessed by the provided device), and otherwise need to fail the attach operation." A buffer sitting in one GPU's VRAM might be physically unreachable by a second GPU or by an unrelated capture device without first being migrated or bounced through system memory — `attach()` is where that gets negotiated, before anyone commits to a mapping.
2. **`dma_buf_map_attachment(struct dma_buf_attachment *attach, enum dma_data_direction dir)`** — now actually get a `struct sg_table`, DMA-mapped for *this* attachment's device specifically. The kerneldoc for `map_dma_buf` notes this "may sleep, e.g. when the backing storage first needs to be allocated, or moved to a location suitable for all currently attached devices" — and that on the first call for a buffer, the exporter is free to look across *all* current attachments and choose backing storage that satisfies every one of them at once.

The two-step split exists because a GPU and, say, a camera capture engine can have genuinely different DMA addressing constraints — different IOMMU domains, different reachable physical ranges, different alignment needs — and the exporter needs the chance to migrate or pin the buffer into a location that works for the new device *before* that device is allowed to touch it, rather than finding out mid-access that the placement was wrong.

### DRM PRIME: DRM's dma-buf binding

PRIME is how a GEM handle in one driver's namespace becomes a GEM handle in a completely different driver's namespace, by round-tripping through a dma-buf fd. The two ioctls, and what actually happens underneath them (`drivers/gpu/drm/drm_prime.c`):

- **`DRM_IOCTL_PRIME_HANDLE_TO_FD`** — export. Handler `drm_prime_handle_to_fd_ioctl()` calls `drm_gem_prime_handle_to_fd()`, which calls `drm_gem_prime_handle_to_dmabuf()`: that looks up the GEM object for the handle and calls either the driver's own `drm_gem_object_funcs.export`, or the generic default, **`drm_gem_prime_export()`**. Either way the result is a `struct dma_buf`; `dma_buf_fd()`-equivalent plumbing (`fd_install()` on an already-reserved fd) hands userspace back an fd in `drm_prime_handle.fd`.
- **`DRM_IOCTL_PRIME_FD_TO_HANDLE`** — import. Handler `drm_prime_fd_to_handle_ioctl()` calls `drm_gem_prime_fd_to_handle()`: it takes a reference on the dma-buf (`dma_buf_get()`), checks whether *this* driver has already imported this exact dma-buf before (a per-`drm_file` lookup cache, so re-importing the same buffer twice returns the same handle rather than creating a duplicate object), and otherwise calls the driver's `gem_prime_import` callback or the generic **`drm_gem_prime_import()`**, which creates a new GEM object with `import_attach` set and `resv` pointed at the exporter's reservation object. A fresh handle for that object is then created in the *importing* driver's own `object_idr` — same handle mechanism as any locally-allocated object, just wrapping memory this driver didn't allocate.

This is the literal mechanism behind both scenarios this page opened with: a compositor exporting a rendered frame's GEM handle as a fd and handing that fd (over a Unix socket, e.g. the Wayland protocol) to a separate display-controller driver's `PRIME_FD_TO_HANDLE`; or a V4L2 driver exporting a captured frame the same way for a GPU driver to import and treat as an ordinary, zero-copy-populated GEM object.

## Fences and `dma_resv`

Two drivers sharing a buffer both need an answer to "is anyone still using this," without either one understanding anything about how the other's hardware works or what its command queues look like. dma-buf answers that with two cooperating pieces.

### `struct dma_fence`: a one-shot completion signal

`struct dma_fence` (`include/linux/dma-fence.h`) is the primitive:

```c
// include/linux/dma-fence.h
struct dma_fence {
	...
	const struct dma_fence_ops __rcu *ops;
	struct list_head cb_list;   // callbacks to run on signal (replaced by @timestamp once signaled)
	u64 context;                // which timeline/engine this fence belongs to
	u64 seqno;                  // ordering within that context
	unsigned long flags;
	struct kref refcount;
	int error;                  // set if the fence completed with an error, not just success
};
```

A fence represents one specific piece of GPU work finishing — a command-buffer submission, a page-table update, a copy — and nothing more. It doesn't know or care what engine produced it. Other code can `dma_fence_wait()` on it (block until it signals) or `dma_fence_add_callback()` (get notified asynchronously, e.g. to unblock a later scheduled GPU job without the CPU ever having to block), and the `dma_fence_ops.enable_signaling` callback is where an implementation hooks up whatever interrupt or polling mechanism actually detects hardware completion. Every wait-for-completion in the GPU stack — a driver waiting to reuse a buffer, a display controller waiting before scanning one out, one GPU job waiting on a dependency from another — reduces to waiting on one or more `dma_fence` objects, regardless of which driver or which piece of silicon produced them.

### `struct dma_resv`: which fences belong to a buffer, and why

`struct dma_resv` (`include/linux/dma-resv.h`) is the container attached to a buffer — `dma_buf.resv`, and by extension `drm_gem_object.resv` — that tracks which fences apply to it:

```c
// include/linux/dma-resv.h
struct dma_resv {
	struct ww_mutex lock;             // update-side lock; see dma_resv_lock()/_unlock()
	struct dma_resv_list __rcu *fences; // the fences currently attached
};
```

The current kernel doesn't split "the one writer fence" from "the shared reader fences" into two separate fields the way older documentation describes — that model has evolved. Instead every fence added via `dma_resv_add_fence()` carries an `enum dma_resv_usage` tag, in strict ascending order of "how much can safely run concurrently with it":

```c
// include/linux/dma-resv.h
enum dma_resv_usage {
	DMA_RESV_USAGE_KERNEL,    // in-kernel memory management (moves, clears) — always wait for these
	DMA_RESV_USAGE_WRITE,     // implicit write access — a new write must wait for prior reads+writes
	DMA_RESV_USAGE_READ,      // implicit read access — a new read only waits for prior writes
	DMA_RESV_USAGE_BOOKKEEP,  // no implicit sync at all (e.g. explicitly-synced submissions)
};
```

Asking for fences at a given usage level (`dma_resv_get_fences()`, `dma_resv_wait_timeout()`, ...) also returns every fence at a *lower* usage level in that list — asking for `WRITE` fences implicitly includes `KERNEL` fences, asking for `READ` includes both `WRITE` and `KERNEL`. That's what encodes the familiar reader/writer rule (many concurrent readers are fine; a writer must wait for everyone) without needing two separate storage slots: a new read only has to wait for existing *write* fences, but a new write has to wait for both existing reads and existing writes, which is precisely what `dma_resv_usage_rw()`'s inverted-looking mapping (`write ? DMA_RESV_USAGE_READ : DMA_RESV_USAGE_WRITE`) implements — asking "what must a new write wait for" returns the read-and-below set.

### Why this matters concretely

Every place two pieces of hardware might touch the same buffer without one waiting for the other to physically finish is a use-after-scanout or a torn-frame bug waiting to happen, and none of these devices can inspect each other's command queues to know when that is. So instead they all agree to go through `dma_resv`: a GPU driver about to evict or reuse a buffer's memory checks (or waits on) the fences in its `dma_resv` rather than assuming the job that last wrote it is done; a display driver about to scan a buffer out for the first time after a render does the same before it programs the CRTC; a dynamic dma-buf importer (one that participates in migration, per the `dma_buf_attach_ops.invalidate_mappings` callback) is required by the documented rules in `dma-buf.h` to "obey the write fences and wait for them to signal before allowing access to the buffer's underlying storage through the device." None of this requires the display driver to understand GPU command-buffer semantics, or the GPU driver to understand display-controller timing — both just wait on fences.

## Worked example: a camera frame becomes a GPU texture, zero-copy

A V4L2 capture driver has just filled a buffer with a captured frame and a compositor wants to use it as a GPU texture for scaling/color-conversion, without a CPU copy in either direction.

**1. Capture side exports.** The V4L2 driver, acting as a dma-buf exporter for its capture buffers (the same role any `dma_buf_ops`-implementing driver plays — V4L2's own buffer-sharing API is a thin wrapper over exactly this mechanism, and was in fact dma-buf's original demonstrated use case), hands userspace a dma-buf fd for the just-captured frame.

**2. The compositor imports it into the GPU driver.** It passes that fd to `DRM_IOCTL_PRIME_FD_TO_HANDLE` on the GPU's DRM fd. Kernel-side: `drm_gem_prime_fd_to_handle()` takes a reference on the dma-buf, doesn't find it in this file's import cache (first time seeing this buffer), and calls the GPU driver's `gem_prime_import` — which bottoms out in `drm_gem_prime_import()` / `drm_gem_prime_import_dev()`. That creates a new `drm_gem_object` in the GPU driver with `import_attach` set (from an internal `dma_buf_attach()` against the GPU's device) and `resv` pointed at the *V4L2 driver's* reservation object, not a fresh one — this GEM object and the original V4L2 buffer now share fence tracking. A handle for it lands in `object_idr` for the compositor's DRM file descriptor.

**3. Mapping for actual GPU access.** `drm_gem_prime_import_dev()` already did the attach/map work on the compositor's behalf during step 2 — calling `dma_buf_attach()` and then `dma_buf_map_attachment_unlocked()` (the variant for callers not already holding the `dma_resv` lock) for the GPU's attachment, getting back an `sg_table` DMA-mapped for the GPU's own address space/IOMMU domain. A V4L2 capture engine and a GPU render engine can easily have different reachable physical ranges, which is exactly the case the attach/map split exists for.

**4. Fencing keeps it safe — except V4L2 is a documented exception.** Because the imported GEM object's `resv` points at the *exporter's* `dma_resv`, any fence the exporting driver attaches is automatically visible to the GPU driver, and gets folded into the GPU job's dependencies under implicit sync (or waited on explicitly). But `dma-buf.h`'s implicit-synchronization rules call out V4L2 by name as a driver that doesn't participate: "Some drivers only expose a synchronous userspace API with no pipelining across drivers. These do not set any fences for their access. An example here is v4l." V4L2 gets its ordering from `VIDIOC_DQBUF` instead — a captured buffer isn't handed back to userspace (and so isn't passed on as a dma-buf fd) until the capture DMA has already completed, so by the time the compositor imports it there's nothing left in flight to fence. The shared-`resv` fencing path is what carries dependencies in the GPU-to-GPU case, where both sides pipeline asynchronously — see below.

**5. Teardown.** The compositor eventually calls `DRM_IOCTL_GEM_CLOSE` on its GPU-side handle. Handle release, not the dma-buf fd itself, is what drops the GPU driver's GEM object reference; the underlying dma-buf stays alive as long as anyone still holds a reference to it — the compositor's own dma-buf fd, or any other importer's `get_dma_buf()` reference. The V4L2 side is the reverse of what you might expect: exporting the buffer took a reference *on the underlying vb2 buffer*, so that capture buffer's memory cannot be freed until the dma-buf itself is finally released, not the other way around.

The same export/import shape — `PRIME_HANDLE_TO_FD` on one driver's GEM handle, `PRIME_FD_TO_HANDLE` on another driver's DRM fd — is how a render GPU hands a composited frame to a physically separate display-output GPU on a hybrid-graphics laptop, except there the fencing is live: the render GPU attaches a `DMA_RESV_USAGE_WRITE` fence for its submission via `dma_resv_add_fence()`, and the display driver, seeing the same `dma_resv` through the imported object's `resv`, picks that fence up before the flip. `drm_gem_plane_helper_prepare_fb()` — the default `prepare_fb` hook for GEM-backed drivers — calls `dma_resv_get_singleton(obj->resv, DMA_RESV_USAGE_WRITE, ...)` and stashes the result in the plane state, which `drm_atomic_helper_wait_for_fences()` then waits on before the commit actually programs the hardware. Only which side is "exporter" and which is "importer" changes.

## Further reading

- [Kernel docs: DRM Memory Management (GEM, TTM)](https://docs.kernel.org/gpu/drm-mm.html) — the authoritative GEM/TTM design and API reference
- [Kernel docs: Buffer Sharing and Synchronization (dma-buf)](https://docs.kernel.org/driver-api/dma-buf.html) — dma-buf, dma-buf attachments, and implicit vs. explicit fencing
- [Kernel docs: DRM uAPI](https://docs.kernel.org/gpu/drm-uapi.html) — includes the explicit "New clients must not use the insecure FLINK interface" guidance
- [`d15bd7ee445d`](https://github.com/torvalds/linux/commit/d15bd7ee445d0702ad801fdaece348fdb79e6581) — "dma-buf: Introduce dma buffer sharing mechanism," Sumit Semwal, merged for Linux 3.3 (early 2012)
- [lore.kernel.org: [RFC v2] Introduce DMA buffer sharing mechanism](https://lore.kernel.org/dri-devel/1322816252-19955-1-git-send-email-sumit.semwal@ti.com/) — the second (December 2011) RFC round, where the subsystem-agnostic design was argued over
- [`3248877ea179`](https://github.com/torvalds/linux/commit/3248877ea1796915419fba7c89315fdbf00cb56a) — "drm: base prime/dma-buf support (v5)," Dave Airlie, merged for Linux 3.4 (spring 2012): DRM's GEM-handle-to-dma-buf-fd binding
- [LWN: "DMA buffer sharing in 3.3"](https://lwn.net/Articles/474819/) — Jonathan Corbet, January 11, 2012, on the merged framework and its camera-to-GPU motivating use case
- `include/drm/drm_gem.h`, `include/drm/drm_gem_shmem_helper.h`, `include/drm/drm_gem_ttm_helper.h` — GEM object and backing-memory helper definitions
- `include/linux/dma-buf.h`, `include/linux/dma-resv.h`, `include/linux/dma-fence.h` — the dma-buf, reservation, and fence structures
- `drivers/gpu/drm/drm_prime.c` — the DRM PRIME implementation of export/import
- [DRM: the Direct Rendering Manager](README.md) · [Kernel Mode Setting (KMS)](kms.md) — where GEM buffers end up once they're on screen
