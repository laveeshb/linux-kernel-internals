# The ALSA PCM Data Path: Ring Buffer, Periods, hw_params, and mmap

> One ring buffer shared between a driver's DMA engine and userspace, two pointers that track how full it is, and one interrupt that keeps both sides honest

## The problem: getting audio samples across a driver boundary, continuously

A sound card doesn't ask for data once — it wants a steady stream of samples arriving (or leaving) at exactly its sample rate, forever, for as long as playback or capture runs. Userspace doesn't work that way: it wakes up, does other things, and comes back later to top up a buffer. Something has to reconcile a hardware DMA engine that consumes or produces samples in fixed lockstep with a scheduler-driven process that fills or drains a buffer in bursts, without either side ever finding the buffer empty (an underrun, an audible glitch) or unread (an overrun, dropped samples).

ALSA's answer is `snd_pcm` — the PCM ("Pulse-Code Modulation") layer that every sound driver, from a USB headset to an HDMI codec to a hardware DSP, implements against. It is one ring buffer per stream direction, a fixed division of that buffer into **periods** that set the interrupt granularity, and two positions — `hw_ptr` and `appl_ptr` — that respectively track how far the hardware has gotten and how far the application has gotten. This page covers the mechanics: the structures a driver and userspace actually touch (`struct snd_pcm_substream`, `struct snd_pcm_runtime`), how a period size and buffer size get negotiated, how userspace gets a zero-copy `mmap()`'d view of the buffer, and how a driver's interrupt handler drives the whole thing forward.

## `struct snd_pcm_substream` and `struct snd_pcm_runtime`

A `struct snd_pcm` is a sound card's PCM device — "device 0," say, a card's default audio device — and it can expose a playback direction, a capture direction, or both, each as a `struct snd_pcm_str`. Opening a device's playback or capture direction gets a process a `struct snd_pcm_substream` (`include/sound/pcm.h`), one per concurrently-open stream:

```c
// include/sound/pcm.h
struct snd_pcm_substream {
	struct snd_pcm *pcm;
	struct snd_pcm_str *pstr;
	void *private_data;		/* copied from pcm->private_data */
	int number;
	char name[32];			/* substream name */
	int stream;			/* stream (direction) */
	struct pm_qos_request latency_pm_qos_req; /* pm_qos request */
	size_t buffer_bytes_max;	/* limit ring buffer size */
	struct snd_dma_buffer dma_buffer;
	size_t dma_max;
	/* -- hardware operations -- */
	const struct snd_pcm_ops *ops;
	/* -- runtime information -- */
	struct snd_pcm_runtime *runtime;
	/* -- timer section -- */
	struct snd_timer *timer;		/* timer */
	unsigned timer_running: 1;	/* time is running */
	long wait_time;	/* time in ms for R/W to wait for avail */
	/* -- next substream -- */
	struct snd_pcm_substream *next;
	/* -- linked substreams -- */
	struct list_head link_list;
	struct snd_pcm_group self_group;
	struct snd_pcm_group *group;
	/* -- assigned files -- */
	int ref_count;
	atomic_t mmap_count;
	unsigned int f_flags;
	void (*pcm_release)(struct snd_pcm_substream *);
	struct pid *pid;
	...
};
```

`substream->ops` is the driver's vtable (`struct snd_pcm_ops`, covered below) — the only place driver code plugs into this machinery. `substream->runtime` is where nearly everything else lives: `struct snd_pcm_runtime` is, in the kernel doc's own framing in `Documentation/sound/kernel-api/writing-an-alsa-driver.rst`, "the chest of PCM information" — allocated fresh in `snd_pcm_attach_substream()` (`sound/core/pcm.c`, called from `snd_pcm_open()`'s open path) and freed on close, so it exists only while the stream is open. Its fields split cleanly into the categories the rest of this page walks through:

```c
// include/sound/pcm.h
struct snd_pcm_runtime {
	/* -- Status -- */
	snd_pcm_state_t state;		/* stream state */
	snd_pcm_state_t suspended_state; /* suspended stream state */
	struct snd_pcm_substream *trigger_master;
	struct timespec64 trigger_tstamp;	/* trigger timestamp */
	bool trigger_tstamp_latched;
	int overrange;
	snd_pcm_uframes_t avail_max;
	snd_pcm_uframes_t hw_ptr_base;	/* Position at buffer restart */
	snd_pcm_uframes_t hw_ptr_interrupt; /* Position at interrupt time */
	unsigned long hw_ptr_jiffies;	/* Time when hw_ptr is updated */
	unsigned long hw_ptr_buffer_jiffies; /* buffer time in jiffies */
	snd_pcm_sframes_t delay;	/* extra delay; typically FIFO size */
	u64 hw_ptr_wrap;                /* offset for hw_ptr due to boundary wrap-around */

	/* -- HW params -- */
	snd_pcm_access_t access;	/* access mode */
	snd_pcm_format_t format;	/* SNDRV_PCM_FORMAT_* */
	snd_pcm_subformat_t subformat;	/* subformat */
	unsigned int rate;		/* rate in Hz */
	unsigned int channels;		/* channels */
	snd_pcm_uframes_t period_size;	/* period size */
	unsigned int periods;		/* periods */
	snd_pcm_uframes_t buffer_size;	/* buffer size */
	snd_pcm_uframes_t min_align;	/* Min alignment for the format */
	...
	unsigned int frame_bits;
	unsigned int sample_bits;
	unsigned int info;
	...

	/* -- SW params; see struct snd_pcm_sw_params for comments -- */
	int tstamp_mode;
	unsigned int period_step;
	snd_pcm_uframes_t start_threshold;
	snd_pcm_uframes_t stop_threshold;
	snd_pcm_uframes_t silence_threshold;
	snd_pcm_uframes_t silence_size;
	snd_pcm_uframes_t boundary;
	...

	/* -- mmap -- */
	struct snd_pcm_mmap_status *status;
	struct snd_pcm_mmap_control *control;

	/* -- locking / scheduling -- */
	snd_pcm_uframes_t twake;
	wait_queue_head_t sleep;	/* poll sleep */
	wait_queue_head_t tsleep;	/* transfer sleep */
	struct snd_fasync *fasync;
	bool stop_operating;
	struct mutex buffer_mutex;
	atomic_t buffer_accessing;

	/* -- private section -- */
	void *private_data;
	void (*private_free)(struct snd_pcm_runtime *runtime);

	/* -- hardware description -- */
	struct snd_pcm_hardware hw;
	struct snd_pcm_hw_constraints hw_constraints;

	/* -- timer -- */
	unsigned int timer_resolution;	/* timer resolution */
	int tstamp_type;		/* timestamp type */

	/* -- DMA -- */
	unsigned char *dma_area;	/* DMA area */
	dma_addr_t dma_addr;		/* physical bus address (not accessible from main CPU) */
	size_t dma_bytes;		/* size of DMA area */

	struct snd_dma_buffer *dma_buffer_p;	/* allocated buffer */
	...
};
```

`runtime->private_data` is a driver-owned pointer — most drivers stash a small per-stream struct there (timer state, DMA channel handle, whatever the hardware backend needs) via `.open`, and free it via `.close`. `runtime->hw` (a `struct snd_pcm_hardware`) is the capability description a driver hands back at open time; `runtime->status`/`runtime->control` are the two mmap'd structs that carry `hw_ptr` and `appl_ptr` to userspace, covered in the mmap section below.

## The ring buffer model: periods and frames

The DMA buffer (`runtime->dma_area`, sized `runtime->dma_bytes`) is a single, contiguous ring. Data is measured in **frames** — one sample per channel, so a frame for 16-bit stereo is 4 bytes; for 24-bit 6-channel it depends on which 24-bit *format* is in use — 18 bytes for the tightly-packed `S24_3LE` (3 bytes/sample), but 24 bytes for the far more common `S24_LE` (which stores the 24-bit value in the low three bytes of a 4-byte container). (`S24_LE`/`S24_3LE` are distinct entries in `SNDRV_PCM_FORMAT_*`, not variants of a single format's `subformat` field — `subformat` is a separate, mostly-unused hw_params dimension of its own, see `SNDRV_PCM_SUBFORMAT_*`.) Frame count itself is independent of format and channel count, which is what lets the rest of the PCM core reason about buffer position without caring what's actually in the bytes.

The buffer is carved into `runtime->periods` equal-sized chunks of `runtime->period_size` frames each, so `buffer_size == period_size * periods`. A period is the **interrupt granularity**: the driver's hardware is expected to raise one interrupt every time it finishes consuming (playback) or producing (capture) one period's worth of frames, and that interrupt is what tells the PCM core "a period elapsed" — see [`snd_pcm_period_elapsed()`](#the-interrupt-driven-update-snd_pcm_period_elapsed) below. This is the same design OSS called a "fragment."

The size of a period is a direct latency/overhead tradeoff, and it's the central tuning knob of the whole data path:

- **Smaller periods** mean more frequent interrupts, so the kernel notices "you can write more now" (or "more is ready to read") sooner after the hardware consumes data — lower latency, because userspace doesn't have to keep as much data pre-buffered to survive the gap between wakeups. The cost is more interrupts per second: more CPU time in the IRQ handler, more scheduler wakeups, worse power behavior on anything that wants to stay idle.
- **Larger periods** mean fewer, cheaper interrupts and more slack for a userspace process that gets scheduled late — good for power and for anything sharing the CPU with bursty, less time-critical work — at the cost of needing more data buffered ahead of time to avoid an underrun, which is exactly what higher latency means in practice.

`buffer_size` itself, independent of how it's divided into periods, sets the outer bound: for playback it's how much audio can be queued before `write()` blocks or an `mmap()`'d ring fills up; for capture it's how long the hardware can keep producing data before an unread buffer overflows. A driver constrains both dimensions via `struct snd_pcm_hardware`, and userspace negotiates a specific point inside those constraints during `hw_params` — the next section.

## hw_params negotiation

### The driver's declared capability: `struct snd_pcm_hardware`

At `.open` time, a driver fills in `runtime->hw` with what its hardware can actually do:

```c
// include/sound/pcm.h
struct snd_pcm_hardware {
	unsigned int info;		/* SNDRV_PCM_INFO_* */
	u64 formats;			/* SNDRV_PCM_FMTBIT_* */
	u32 subformats;			/* for S32_LE, SNDRV_PCM_SUBFMTBIT_* */
	unsigned int rates;		/* SNDRV_PCM_RATE_* */
	unsigned int rate_min;		/* min rate */
	unsigned int rate_max;		/* max rate */
	unsigned int channels_min;	/* min channels */
	unsigned int channels_max;	/* max channels */
	size_t buffer_bytes_max;	/* max buffer size */
	size_t period_bytes_min;	/* min period size */
	size_t period_bytes_max;	/* max period size */
	unsigned int periods_min;	/* min # of periods */
	unsigned int periods_max;	/* max # of periods */
	size_t fifo_size;		/* fifo size in bytes */
};
```

`info` carries capability flags like `SNDRV_PCM_INFO_MMAP` (can this stream be `mmap()`'d at all — see below) and `SNDRV_PCM_INFO_INTERLEAVED`/`NONINTERLEAVED` (channel layout in the buffer). `rates`/`formats` are bitmasks (`SNDRV_PCM_RATE_44100`, `SNDRV_PCM_FMTBIT_S16_LE`, and so on); `rate_min`/`rate_max`/`channels_min`/`channels_max` bound the continuous ranges. Drivers can additionally register `hw_constraints` rules (`snd_pcm_hw_constraint_*()`) for relationships the flat `snd_pcm_hardware` struct can't express — e.g., "this channel count is only valid at these specific rates."

### The negotiation itself: refine, then commit

Userspace's ALSA-lib layer (`snd_pcm_hw_params()` in libasound, not to be confused with the kernel-side function of the same name) works by iteratively narrowing a `struct snd_pcm_hw_params` — a fixed-size array of masks (for enum-like parameters: access mode, format, subformat) and intervals (for ranged parameters: rate, channels, period size, periods, buffer size), indexed by parameter IDs like `SNDRV_PCM_HW_PARAM_ACCESS`, `SNDRV_PCM_HW_PARAM_FORMAT`, `SNDRV_PCM_HW_PARAM_RATE`, `SNDRV_PCM_HW_PARAM_PERIOD_SIZE`, `SNDRV_PCM_HW_PARAM_PERIODS`, `SNDRV_PCM_HW_PARAM_BUFFER_SIZE`, and so on. Each round trip is `SNDRV_PCM_IOCTL_HW_REFINE`, which lands on `snd_pcm_hw_refine()` (`sound/core/pcm_native.c`):

```c
// sound/core/pcm_native.c
int snd_pcm_hw_refine(struct snd_pcm_substream *substream,
		      struct snd_pcm_hw_params *params)
{
	int err;

	params->info = 0;
	params->fifo_size = 0;
	...
	err = constrain_mask_params(substream, params);
	if (err < 0)
		return err;

	err = constrain_interval_params(substream, params);
	if (err < 0)
		return err;

	err = constrain_params_by_rules(substream, params);
	if (err < 0)
		return err;

	params->rmask = 0;
	return 0;
}
```

`constrain_mask_params()` and `constrain_interval_params()` intersect each requested mask/interval against `runtime->hw` and the registered `hw_constraints` rules, shrinking the ranges in place; `constrain_params_by_rules()` applies the cross-parameter rules (e.g., format constraining sample bits constraining frame bits). Userspace calls this repeatedly, narrowing one parameter at a time, until every mask is a single value and every interval is a single point — a fully-specified configuration.

The actual commit is `SNDRV_PCM_IOCTL_HW_PARAMS`, `snd_pcm_hw_params()` in `pcm_native.c`. It re-runs `snd_pcm_hw_refine()` on the final params, picks concrete values via `snd_pcm_hw_params_choose()`, allocates the DMA buffer if the driver uses managed allocation, and — only once everything else has succeeded — calls the driver's own `.hw_params` callback so it can program format/rate/channel registers. On success it copies the negotiated values into the runtime fields covered above (`runtime->access`, `format`, `channels`, `rate`, `period_size`, `periods`, `buffer_size`, ...) and also seeds default software parameters:

```c
// sound/core/pcm_native.c — snd_pcm_hw_params(), abridged
runtime->access = params_access(params);
runtime->format = params_format(params);
runtime->subformat = params_subformat(params);
runtime->channels = params_channels(params);
runtime->rate = params_rate(params);
runtime->period_size = params_period_size(params);
runtime->periods = params_periods(params);
runtime->buffer_size = params_buffer_size(params);
...
/* Default sw params */
runtime->tstamp_mode = SNDRV_PCM_TSTAMP_NONE;
runtime->period_step = 1;
runtime->control->avail_min = runtime->period_size;
runtime->start_threshold = 1;
runtime->stop_threshold = runtime->buffer_size;
runtime->silence_threshold = 0;
runtime->silence_size = 0;
runtime->boundary = runtime->buffer_size;
while (runtime->boundary * 2 <= LONG_MAX - runtime->buffer_size)
	runtime->boundary *= 2;
```

The stream moves from `SNDRV_PCM_STATE_OPEN` to `SNDRV_PCM_STATE_SETUP`. `boundary` deserves a note: it's not the buffer size — it's the largest power-of-two multiple of `buffer_size` that still fits comfortably below `LONG_MAX` (the doubling loop above), and it's the modulus `hw_ptr` and `appl_ptr` wrap around at (not `buffer_size` itself), which is what lets the core distinguish "the buffer has wrapped N times" from "the pointers are equal" while still doing simple arithmetic on them.

### sw_params: policy, not capability

Where `hw_params` describes what the hardware supports, `SNDRV_PCM_IOCTL_SW_PARAMS` (`struct snd_pcm_sw_params`, handled by `snd_pcm_sw_params()`) tunes how the *core* behaves around that hardware — when to auto-start the stream (`start_threshold`, minimum `hw_avail` frames queued before playback starts automatically), when to auto-stop on underrun (`stop_threshold`), and `avail_min`, the minimum available-frame count that triggers a `poll()`/`select()` wakeup — the knob that determines how eagerly a period-driven interrupt actually wakes a blocked userspace process versus letting more accumulate first. `silence_threshold`/`silence_size` are a related but distinct pair: they don't wait for an underrun to fire — `snd_pcm_playback_silence()` (`sound/core/pcm_lib.c`) runs on every hw_ptr update and proactively writes silence into the buffer *ahead* of `hw_ptr`, up to `silence_size` frames, whenever the gap between `hw_ptr` and `appl_ptr` (the "noise distance," i.e. how much real, not-yet-overwritten data is still queued) drops below `silence_threshold`. That keeps the hardware from ever reading stale/garbage samples if userspace falls behind, independent of whether an actual xrun has happened yet.

## The mmap path: a zero-copy view of the ring buffer

For drivers advertising `SNDRV_PCM_INFO_MMAP`, userspace can skip `read()`/`write()` entirely and `mmap()` the ring buffer directly, writing (or reading) sample frames in place. The kernel side is `snd_pcm_mmap_data()` (`sound/core/pcm_native.c`), reached through the PCM device's `mmap` file operation once it's determined the requested offset isn't the status/control page (see below):

```c
// sound/core/pcm_native.c
int snd_pcm_mmap_data(struct snd_pcm_substream *substream, struct file *file,
		      struct vm_area_struct *area)
{
	struct snd_pcm_runtime *runtime;
	long size;
	unsigned long offset;
	size_t dma_bytes;
	int err;

	if (substream->stream == SNDRV_PCM_STREAM_PLAYBACK) {
		if (!(area->vm_flags & (VM_WRITE|VM_READ)))
			return -EINVAL;
	} else {
		if (!(area->vm_flags & VM_READ))
			return -EINVAL;
	}
	runtime = substream->runtime;
	if (runtime->state == SNDRV_PCM_STATE_OPEN)
		return -EBADFD;
	if (!(runtime->info & SNDRV_PCM_INFO_MMAP))
		return -ENXIO;
	if (runtime->access == SNDRV_PCM_ACCESS_RW_INTERLEAVED ||
	    runtime->access == SNDRV_PCM_ACCESS_RW_NONINTERLEAVED)
		return -EINVAL;
	size = area->vm_end - area->vm_start;
	offset = area->vm_pgoff << PAGE_SHIFT;
	dma_bytes = PAGE_ALIGN(runtime->dma_bytes);
	if ((size_t)size > dma_bytes)
		return -EINVAL;
	if (offset > dma_bytes - size)
		return -EINVAL;

	area->vm_ops = &snd_pcm_vm_ops_data;
	area->vm_private_data = substream;
	if (substream->ops->mmap)
		err = substream->ops->mmap(substream, area);
	else
		err = snd_pcm_lib_default_mmap(substream, area);
	if (!err)
		atomic_inc(&substream->mmap_count);
	return err;
}
```

It rejects mixing `mmap()` with the interleaved/noninterleaved `read`/`write` access modes (a stream picks one access model at `hw_params` time and sticks to it), bounds-checks the requested VMA against the actual DMA buffer size, and then either calls the driver's own `.mmap` op or falls back to `snd_pcm_lib_default_mmap()`, which either maps the buffer's pages directly (for a `dma_alloc_coherent()`-backed buffer this is often a straight `remap_pfn_range()`-style mapping via `snd_dma_buffer_mmap()`) or installs a page-fault handler (`snd_pcm_mmap_data_fault()`) that resolves individual pages on demand — the path a driver without a linear kernel-virtual DMA mapping takes, calling `substream->ops->page()` per fault.

### The other two mmap regions: status and control

The ring buffer itself is one of three things a PCM file descriptor can be `mmap()`'d for. The other two are fixed-offset, fixed-size structures — `SNDRV_PCM_MMAP_OFFSET_STATUS`/`_CONTROL` — that carry the position pointers, so userspace never needs an ioctl round trip just to check "how much room is left." The uapi header's "base" struct tags are actually `struct __snd_pcm_mmap_status`/`__snd_pcm_mmap_control`, a simplified 32-bit-timestamp layout with 6 and 2 fields respectively. But `include/uapi/sound/asound.h` defines `__SND_STRUCT_TIME64` whenever `__KERNEL__` is set, and under that macro it renames the larger `*64` variants — `struct __snd_pcm_mmap_status64`/`__snd_pcm_mmap_control64` — to the plain names `snd_pcm_mmap_status`/`snd_pcm_mmap_control` via `#define`. So in-kernel (and for y2038-safe 64-bit userspace), those plain names actually resolve to the bigger, padded structs, and `runtime->status`/`runtime->control` point at these, not the smaller ones:

```c
// include/uapi/sound/asound.h — the struct kernel builds actually get for
// "snd_pcm_mmap_status" / "snd_pcm_mmap_control", via the __SND_STRUCT_TIME64
// macro-rename of __snd_pcm_mmap_status64 / __snd_pcm_mmap_control64
struct snd_pcm_mmap_status {
	snd_pcm_state_t state;		/* RO: state - SNDRV_PCM_STATE_XXXX */
	__u32 pad1;			/* Needed for 64 bit alignment */
	__pad_before_uframe __pad1;
	snd_pcm_uframes_t hw_ptr;	/* RO: hw ptr (0...boundary-1) */
	__pad_after_uframe __pad2;
	struct __snd_timespec64 tstamp;	/* Timestamp; __kernel_timespec under __KERNEL__ */
	snd_pcm_state_t suspended_state; /* RO: suspended stream state */
	__u32 pad3;			/* Needed for 64 bit alignment */
	struct __snd_timespec64 audio_tstamp; /* from sample counter or wall clock */
};

struct snd_pcm_mmap_control {
	__pad_before_uframe __pad1;
	snd_pcm_uframes_t appl_ptr;	/* RW: appl ptr (0...boundary-1) */
	__pad_before_uframe __pad2;
	__pad_before_uframe __pad3;
	snd_pcm_uframes_t avail_min;	/* RW: min available frames for wakeup */
	__pad_after_uframe __pad4;
};
```

`runtime->status` and `runtime->control` in `struct snd_pcm_runtime` point at these same structures — the kernel and userspace's mmap'd view are the same memory. `hw_ptr` is written only by the kernel (updated from the driver's `.pointer` callback, see the next section); `appl_ptr` is written by userspace (or, for non-mmap `read()`/`write()` streams, by the kernel on the application's behalf) to say how far it has consumed or produced.

### `appl_ptr` and `hw_ptr`: producer and consumer position

Both are frame offsets that increase monotonically and wrap at `runtime->boundary`, not at `buffer_size` — the actual position within the ring is `pointer % buffer_size`, but keeping the counters unwrapped past the buffer size is what lets the core tell "the hardware is 1.5 buffers ahead of where it started" from "the hardware is exactly one buffer position ahead," which distinguishes a healthy running stream from one that silently wrapped an extra time. For playback: `hw_ptr` is how far the hardware has *consumed* (played) into the buffer; `appl_ptr` is how far userspace has *written*. The gap between them is exactly the queued-but-not-yet-played data, computed in `snd_pcm_playback_avail()` (`include/sound/pcm.h`) as the inverse — free space still available to write:

```c
// include/sound/pcm.h
static inline snd_pcm_uframes_t snd_pcm_playback_avail(struct snd_pcm_runtime *runtime)
{
	snd_pcm_sframes_t avail = runtime->status->hw_ptr + runtime->buffer_size - runtime->control->appl_ptr;
	if (avail < 0)
		avail += runtime->boundary;
	else if ((snd_pcm_uframes_t) avail >= runtime->boundary)
		avail -= runtime->boundary;
	return avail;
}
```

For capture the relationship inverts: `hw_ptr` is how far the hardware has *produced* (captured), `appl_ptr` is how far userspace has *read*, and `snd_pcm_capture_avail()` is simply `hw_ptr - appl_ptr` (mod boundary) — the amount of freshly captured, not-yet-read data. In both directions, the two pointers are only ever allowed to differ by at most `buffer_size` frames; hitting that limit without the consumer catching up is exactly an xrun (an underrun for playback, an overrun for capture).

## Ring buffer diagram

```
                     buffer_size = period_size * periods  (here: 4 periods)

        0        period_size   2*period_size  3*period_size   buffer_size
        |--------------|--------------|--------------|--------------|
        | period 0     | period 1     | period 2     | period 3     |
        |--------------|--------------|--------------|--------------|
                              ^ hw_ptr                      ^ appl_ptr
                              (mod buffer_size)              (mod buffer_size)
                              |<------ queued, not yet -------->|
                                    played (playback)/
                                    read (capture)

  hw_ptr, appl_ptr: monotonically increasing counters, wrap at `boundary`
  (a large multiple of buffer_size), not at buffer_size itself.

  playback: hw_ptr advances as hardware consumes each period and fires
            an interrupt; appl_ptr advances as userspace writes/mmap-fills
            more frames. hw_ptr chases appl_ptr; if it catches up = underrun.

  capture:  hw_ptr advances as hardware fills each period and fires an
            interrupt; appl_ptr advances as userspace reads/mmap-drains
            frames. appl_ptr chases hw_ptr; if hw_ptr laps it = overrun.

  One IRQ per period boundary crossed -> snd_pcm_period_elapsed()
```

## The interrupt-driven update: `snd_pcm_period_elapsed()`

The driver side of the loop is: an IRQ fires when the DMA engine finishes a period, and the driver's handler calls `snd_pcm_period_elapsed()` (`sound/core/pcm_lib.c`):

```c
// sound/core/pcm_lib.c
void snd_pcm_period_elapsed(struct snd_pcm_substream *substream)
{
	if (snd_BUG_ON(!substream))
		return;

	guard(pcm_stream_lock_irqsave)(substream);
	snd_pcm_period_elapsed_under_stream_lock(substream);
}
EXPORT_SYMBOL(snd_pcm_period_elapsed);
```

which, under the substream lock, calls `snd_pcm_update_hw_ptr0()`. That function is where the driver's `.pointer` callback actually gets invoked:

```c
// sound/core/pcm_lib.c — snd_pcm_update_hw_ptr0(), abridged
old_hw_ptr = runtime->status->hw_ptr;
pos = substream->ops->pointer(substream);
...
if (pos == SNDRV_PCM_POS_XRUN) {
	__snd_pcm_xrun(substream);
	return -EPIPE;
}
if (pos >= runtime->buffer_size) {
	/* ... treated as a driver bug, position reset to 0 with a rate-limited log ... */
}
pos -= pos % runtime->min_align;
hw_base = runtime->hw_ptr_base;
new_hw_ptr = hw_base + pos;
...
/* new_hw_ptr might be lower than old_hw_ptr in case when */
/* pointer crosses the end of the ring buffer */
if (new_hw_ptr < old_hw_ptr) {
	hw_base += runtime->buffer_size;
	if (hw_base >= runtime->boundary) {
		hw_base = 0;
		crossed_boundary++;
	}
	new_hw_ptr = hw_base + pos;
}
```

Note the contract this puts on a driver's `.pointer` callback: it returns a raw position *within the buffer* — `0 .. buffer_size - 1` (or `SNDRV_PCM_POS_XRUN` if the hardware has already xrun) — and the core is entirely responsible for turning that wrapped, hardware-relative position into the monotonically increasing, boundary-wrapped `hw_ptr` that `snd_pcm_playback_avail()`/`snd_pcm_capture_avail()` consume, by tracking `hw_ptr_base` and detecting the wraparound itself. A driver normally never writes `runtime->status->hw_ptr` directly — the exceptions are a few drivers with an explicit hardware-position-reset ioctl, like the RME9652 family (`sound/pci/rme9652/{hdsp,rme9652,hdspm}.c`), which assign `runtime->status->hw_ptr` straight from their own position readback inside that reset handler rather than going through `snd_pcm_update_hw_ptr0()`.

Once the position is updated, `snd_pcm_update_hw_ptr0()` itself hands off to `snd_pcm_update_state()`, which is what actually wakes anything sleeping on `runtime->sleep`/`runtime->tsleep` (a blocked `read()`/`write()`, or a `poll()` past `avail_min`) once enough frames are available; back up in `snd_pcm_period_elapsed_under_stream_lock()`, and if `CONFIG_SND_PCM_TIMER` is enabled, it also ticks the PCM's associated ALSA timer for anything subscribed to period-elapsed events that way. This is also the exact point where XRUN and DRAIN handling live: if `.pointer` reports `SNDRV_PCM_POS_XRUN`, `__snd_pcm_xrun()` transitions the stream to `SNDRV_PCM_STATE_XRUN` right here, in interrupt context, and userspace finds out the next time it touches the stream.

## Driver-side callback ops: `struct snd_pcm_ops`

Everything a driver plugs into the PCM core funnels through one vtable, `substream->ops`:

```c
// include/sound/pcm.h
struct snd_pcm_ops {
	int (*open)(struct snd_pcm_substream *substream);
	int (*close)(struct snd_pcm_substream *substream);
	int (*ioctl)(struct snd_pcm_substream * substream,
		     unsigned int cmd, void *arg);
	int (*hw_params)(struct snd_pcm_substream *substream,
			 struct snd_pcm_hw_params *params);
	int (*hw_free)(struct snd_pcm_substream *substream);
	int (*prepare)(struct snd_pcm_substream *substream);
	int (*trigger)(struct snd_pcm_substream *substream, int cmd);
	int (*sync_stop)(struct snd_pcm_substream *substream);
	snd_pcm_uframes_t (*pointer)(struct snd_pcm_substream *substream);
	int (*get_time_info)(struct snd_pcm_substream *substream,
			     struct timespec64 *system_ts, struct timespec64 *audio_ts,
			     struct snd_pcm_audio_tstamp_config *audio_tstamp_config,
			     struct snd_pcm_audio_tstamp_report *audio_tstamp_report);
	int (*fill_silence)(struct snd_pcm_substream *substream, int channel,
			    unsigned long pos, unsigned long bytes);
	int (*copy)(struct snd_pcm_substream *substream, int channel,
		    unsigned long pos, struct iov_iter *iter, unsigned long bytes);
	struct page *(*page)(struct snd_pcm_substream *substream,
			     unsigned long offset);
	int (*mmap)(struct snd_pcm_substream *substream, struct vm_area_struct *vma);
	int (*ack)(struct snd_pcm_substream *substream);
};
```

The core ones for the data path itself:

- **`.open`/`.close`** — allocate/free any per-stream driver state (commonly stashed in `runtime->private_data`), and set `runtime->hw` to describe what this specific device instance supports.
- **`.hw_params`/`.hw_free`** — program hardware format/rate/channel registers for the negotiated configuration; tear that back down. Called from `snd_pcm_hw_params()`/`do_hw_free()` after the core has already validated and recorded the parameters.
- **`.prepare`** — reset the driver's internal position/state to the start of the buffer, ready for the next `.trigger(START)`. Called after `hw_params`, and again after every `SNDRV_PCM_STATE_XRUN` recovery.
- **`.trigger`** — the real-time-sensitive one: start, stop, pause, resume, or begin draining, selected by `cmd` (`SNDRV_PCM_TRIGGER_START`, `_STOP`, `_PAUSE_PUSH`, `_PAUSE_RELEASE`, `_SUSPEND`, `_RESUME`, `_DRAIN`). Called with the stream lock held and interrupts disabled on at least some call paths, so it needs to be fast — this is where DMA actually gets kicked off or halted.
- **`.pointer`** — report current hardware position, in frames, within the buffer; this is what `snd_pcm_update_hw_ptr0()` calls, as shown above.
- **`.copy`/`.fill_silence`/`.page`** — only needed when a driver can't expose a plain linear kernel-mapped DMA buffer (scattered pages, hardware-specific transfer requirements); most drivers leave these unset and let the core's default linear-buffer path (`memcpy`-based `read`/`write`, direct mmap) handle it.
- **`.mmap`** — override the default buffer mmap logic (`snd_pcm_lib_default_mmap()`) entirely; most drivers with ordinary DMA-coherent memory leave this NULL.

## Worked example: `sound/drivers/dummy.c`'s systimer backend

`sound/drivers/dummy.c` implements a PCM device with no real hardware at all — it exists to test and demonstrate the ALSA PCM core in isolation, which makes it a clean, real, in-tree example of a minimal `.pointer`/`.trigger` implementation rather than a real DMA-driven one. It has two selectable backends for "hardware progress" — a `jiffies`-driven system timer and (if `CONFIG_HIGH_RES_TIMERS` is enabled) an `hrtimer`; the systimer one is simpler to read as a first example.

Per-substream state:

```c
// sound/drivers/dummy.c
struct dummy_systimer_pcm {
	/* ops must be the first item */
	const struct dummy_timer_ops *timer_ops;
	spinlock_t lock;
	struct timer_list timer;
	unsigned long base_time;
	unsigned int frac_pos;	/* fractional sample position (based HZ) */
	unsigned int frac_period_rest;
	unsigned int frac_buffer_size;	/* buffer_size * HZ */
	unsigned int frac_period_size;	/* period_size * HZ */
	unsigned int rate;
	int elapsed;
	struct snd_pcm_substream *substream;
};
```

`dummy_systimer_update()` advances the fractional position by however many jiffies have elapsed since the last update, converts that into frames via the stream's `rate`, and counts how many period boundaries were crossed:

```c
// sound/drivers/dummy.c
static void dummy_systimer_update(struct dummy_systimer_pcm *dpcm)
{
	unsigned long delta;

	delta = jiffies - dpcm->base_time;
	if (!delta)
		return;
	dpcm->base_time += delta;
	delta *= dpcm->rate;
	dpcm->frac_pos += delta;
	while (dpcm->frac_pos >= dpcm->frac_buffer_size)
		dpcm->frac_pos -= dpcm->frac_buffer_size;
	while (dpcm->frac_period_rest <= delta) {
		dpcm->elapsed++;
		dpcm->frac_period_rest += dpcm->frac_period_size;
	}
	dpcm->frac_period_rest -= delta;
}
```

The `struct timer_list` callback runs that update, rearms the timer for the next expected period boundary, and — only if at least one period actually elapsed — calls `snd_pcm_period_elapsed()`, exactly the mechanism described above, standing in for what a real driver's DMA-complete IRQ handler would do:

```c
// sound/drivers/dummy.c
static void dummy_systimer_callback(struct timer_list *t)
{
	struct dummy_systimer_pcm *dpcm = timer_container_of(dpcm, t, timer);
	int elapsed = 0;

	scoped_guard(spinlock_irqsave, &dpcm->lock) {
		dummy_systimer_update(dpcm);
		dummy_systimer_rearm(dpcm);
		elapsed = dpcm->elapsed;
		dpcm->elapsed = 0;
	}
	if (elapsed)
		snd_pcm_period_elapsed(dpcm->substream);
}
```

`.pointer` just reports the current fractional position converted back to frames:

```c
// sound/drivers/dummy.c
static snd_pcm_uframes_t
dummy_systimer_pointer(struct snd_pcm_substream *substream)
{
	struct dummy_systimer_pcm *dpcm = substream->runtime->private_data;

	guard(spinlock)(&dpcm->lock);
	dummy_systimer_update(dpcm);
	return dpcm->frac_pos / HZ;
}
```

And `.trigger`/`.prepare` are thin dispatches to this backend's `start`/`stop`/`prepare` — `dummy_pcm_trigger()` maps `SNDRV_PCM_TRIGGER_START`/`_RESUME` to `start()` (which stamps `base_time` and arms the timer) and `_STOP`/`_SUSPEND` to `stop()` (which disarms it):

```c
// sound/drivers/dummy.c
static int dummy_pcm_trigger(struct snd_pcm_substream *substream, int cmd)
{
	switch (cmd) {
	case SNDRV_PCM_TRIGGER_START:
	case SNDRV_PCM_TRIGGER_RESUME:
		return get_dummy_ops(substream)->start(substream);
	case SNDRV_PCM_TRIGGER_STOP:
	case SNDRV_PCM_TRIGGER_SUSPEND:
		return get_dummy_ops(substream)->stop(substream);
	}
	return -EINVAL;
}

static const struct snd_pcm_ops dummy_pcm_ops = {
	.open =		dummy_pcm_open,
	.close =	dummy_pcm_close,
	.hw_params =	dummy_pcm_hw_params,
	.prepare =	dummy_pcm_prepare,
	.trigger =	dummy_pcm_trigger,
	.pointer =	dummy_pcm_pointer,
};

static const struct snd_pcm_ops dummy_pcm_ops_no_buf = {
	.open =		dummy_pcm_open,
	.close =	dummy_pcm_close,
	.hw_params =	dummy_pcm_hw_params,
	.prepare =	dummy_pcm_prepare,
	.trigger =	dummy_pcm_trigger,
	.pointer =	dummy_pcm_pointer,
	.copy =		dummy_pcm_copy,
	.fill_silence =	dummy_pcm_silence,
	.page =		dummy_pcm_page,
};
```

That six-entry `snd_pcm_ops` — `open`/`close`/`hw_params`/`prepare`/`trigger`/`pointer` — is close to the practical minimum for a working PCM device: everything else (`.copy`, `.fill_silence`, `.page`, `.mmap`) is left unset and handled by the core's default linear-DMA-buffer path, which is exactly the "most drivers leave these unset" case described above. But `dummy.c` picks between the two structs above at card-creation time based on its `fake_buffer` module parameter (`static bool fake_buffer = 1;`, i.e. *on* by default):

```c
// sound/drivers/dummy.c
if (fake_buffer)
	ops = &dummy_pcm_ops_no_buf;
else
	ops = &dummy_pcm_ops;
```

So out of the box, with `fake_buffer` at its default of 1, `dummy.c` actually loads the *nine*-entry `dummy_pcm_ops_no_buf` — because with no real DMA-backed buffer to hand out, it has to implement `.copy`/`.fill_silence`/`.page` itself to shuttle sample data. The plain six-entry `dummy_pcm_ops` above is the minimal-vtable illustration and is what a driver with a real linear DMA buffer would use, but it's only what `dummy.c` itself falls back to when loaded with `fake_buffer=0`. A real hardware driver's `.pointer` reads a DMA position register instead of a jiffies-derived fraction, and its `.trigger` toggles an actual DMA-start bit instead of arming a software timer, but the shape — advance a position, notice period boundaries, call `snd_pcm_period_elapsed()` from whatever interrupt source stands in for "hardware made progress" — is identical.

## Further reading

### Kernel source

- [`include/sound/pcm.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/sound/pcm.h) — `struct snd_pcm_substream`, `struct snd_pcm_runtime`, `struct snd_pcm_hardware`, `struct snd_pcm_ops`
- [`include/uapi/sound/asound.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/sound/asound.h) — the uAPI structs: `snd_pcm_hw_params`, `snd_pcm_sw_params`, `snd_pcm_mmap_status`, `snd_pcm_mmap_control`, ioctl numbers
- [`sound/core/pcm_native.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/sound/core/pcm_native.c) — `snd_pcm_hw_refine()`, `snd_pcm_hw_params()`, `snd_pcm_sw_params()`, `snd_pcm_mmap_data()`
- [`sound/core/pcm_lib.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/sound/core/pcm_lib.c) — `snd_pcm_period_elapsed()`, `snd_pcm_update_hw_ptr0()`, hw_params constraint machinery
- [`sound/drivers/dummy.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/sound/drivers/dummy.c) — the worked-example driver above: a complete, minimal `snd_pcm_ops` implementation

### Related pages

- [ALSA: the Sound Subsystem](README.md) — where the PCM layer sits in the card/device model
- [ALSA War Stories](war-stories.md) — Case 1: the `hw_params`/`hw_free` race (CVE-2022-1048) that this page's negotiation and locking machinery shipped without a critical section wide enough to cover

### External

- [Writing an ALSA Driver: PCM Interface](https://docs.kernel.org/sound/kernel-api/writing-an-alsa-driver.html#pcm-interface) — the canonical driver-author's guide to `snd_pcm_runtime`, periods, and every `snd_pcm_ops` callback
- [ALSA PCM Timestamping](https://docs.kernel.org/sound/designs/timestamping.html) — how `hw_ptr` updates relate to the timestamps reported alongside `SNDRV_PCM_IOCTL_STATUS`/`SYNC_PTR`
