# ALSA: the Advanced Linux Sound Architecture

> How Linux turns a sound chip into `/dev/snd/pcmC0D0p` — one kernel-level object model shared by every sound card, with playback, mixing, and MIDI as separate, independently-numbered device files

## Getting Started

Audio hardware looks simple from the outside — a DAC, a few mixer knobs, maybe a MIDI port — but a general-purpose OS has to support hundreds of unrelated chips (PCI, USB, and the dozens of I2S/SoC codecs found on embedded boards) behind one predictable userspace interface, while also letting more than one logical stream exist per device: playback and capture are different data paths, and a card's mixer state has to stay visible and controllable independently of whether anything is currently playing. **ALSA (Advanced Linux Sound Architecture)**, living under `sound/`, is the kernel subsystem that does this. It defines one shared object model — the *card* — and hangs everything else (PCM streams, mixer controls, MIDI ports, timers) off it as component devices with their own device-node numbering.

### The problem ALSA solves

Linux's original sound subsystem was **OSS (Open Sound System)**, built directly on the early SoundBlaster driver. OSS's API required every audio service — sample-rate and format conversion, routing, mixing multiple streams down to one device — to be implemented *inside* the kernel driver itself, because the interface gave userspace only a single, fixed-format stream per device node. By 1998 that had become a real limitation as sound hardware and use cases diversified, and growing dissatisfaction with OSS's design led Jaroslav Kysela and others to begin work on a redesigned kernel API that became ALSA — one that kept the kernel side to hardware control, buffer management, and mixer state, and pushed format conversion and mixing policy into a userspace/library layer instead. By the end of 2001, ALSA was adopted as Linux's official audio system ([LWN: "LPC: The past, present, and future of Linux audio," Jake Edge, 2009](https://lwn.net/Articles/355542/)); it was merged into the mainline kernel during the 2.5 development series in early 2002 (2.5.4–2.5.5), and became the *default* sound system, replacing OSS, in Linux 2.6 (released December 2003). The older OSS API was retained afterward only as an optional emulation layer (`snd-pcm-oss`, `snd-mixer-oss`, `snd-seq-oss`) for legacy binaries.

The result is a kernel API that stays deliberately narrow: negotiate hardware parameters, move audio buffers, expose mixer controls, and route MIDI bytes. Sample-rate conversion, stream mixing, and network transparency are userspace's job — first ALSA's own `libasound` plugin chain, and on most modern desktops, an audio server (PulseAudio or PipeWire) layered on top of it.

### The core object model: cards and devices

Every ALSA driver's job boils down to building one `struct snd_card` and attaching component objects to it. `struct snd_card` (defined in [`include/sound/core.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/sound/core.h)) is, in the kernel documentation's own words, "the headquarters of the soundcard" — it owns the card's identity strings (`id`, `driver`, `shortname`, `longname`), a `struct list_head devices` of every component attached to it, the mixer/control state (`controls`, `controls_rwsem`, `last_numid`), the card's `/proc/asound/cardN` tree (`proc_root`), and the `card_dev` embedded `struct device` used for sysfs and driver-core registration.

A driver's `probe()` follows a fixed sequence:

1. **`snd_card_new()`** (or the devres-managed `snd_devm_card_new()`) allocates the `snd_card` and claims a card index — either the one requested via the module's `index` parameter, or the first free slot below `SNDRV_CARDS` (8 by default, or `CONFIG_SND_MAX_CARDS` with dynamic minors enabled).
2. The driver creates its **component objects** — a PCM (`snd_pcm_new()`), a rawmidi port (`snd_rawmidi_new()`), a timer (`snd_timer_new()`) — as needed. Each of these attaches itself to the card as a `struct snd_device` via `snd_device_new()`, tagged with an `enum snd_device_type` (`SNDRV_DEV_PCM`, `SNDRV_DEV_RAWMIDI`, `SNDRV_DEV_TIMER`, ...) and a `struct snd_device_ops` of `dev_free`/`dev_register`/`dev_disconnect` callbacks. A freshly created device starts in the `SNDRV_DEV_BUILD` state — allocated, but not yet reachable from userspace. Mixer controls work differently: there is exactly one `SNDRV_DEV_CONTROL` `snd_device` per card, created automatically by `snd_ctl_create()` inside `snd_card_new()` — drivers get it for free. Individual `struct snd_kcontrol`s (built with `snd_ctl_new1()`) don't get a `snd_device` of their own; `snd_ctl_add()` (`sound/core/control.c`) simply links each one onto the card's `controls` list, where the single control device serves all of them through one ioctl surface.
3. **`snd_card_register()`** flips the switch: it calls `device_add()` on the card's own `card_dev` and then `snd_device_register_all()`, which walks `card->devices` and invokes each component's `dev_register` callback, moving it from `SNDRV_DEV_BUILD` to `SNDRV_DEV_REGISTERED`. Only after this call are the card's device nodes actually openable — "before `snd_card_register()` is called, the components are safely inaccessible from external side," per the kernel's own driver-writing guide ([docs.kernel.org: Writing an ALSA Driver](https://docs.kernel.org/sound/kernel-api/writing-an-alsa-driver.html)).

Teardown is the mirror image: `snd_card_free()` (or, for devres-managed cards, an automatic `devm` action added at registration time) disconnects and frees every attached `snd_device` before freeing the card itself, so a single call unwinds the whole component tree regardless of how many PCMs, controls, or MIDI ports the driver created.

```
  Hardware (PCI, USB, or an ASoC I2S/SoC codec)
          │
          ▼
  Low-level driver's probe()      e.g. snd_hda_intel, snd_usb_audio,
          │                          or an ASoC machine driver
          ▼
  snd_card_new() / snd_devm_card_new()
          │  allocates struct snd_card, claims a card index (card->number)
          │  snd_ctl_create() → the one SNDRV_DEV_CONTROL snd_device for this card
          │
          ├── snd_pcm_new()      → SNDRV_DEV_PCM      (playback/capture streams)
          ├── snd_rawmidi_new()  → SNDRV_DEV_RAWMIDI   (MIDI byte stream)
          └── snd_timer_new()    → SNDRV_DEV_TIMER     (sample-accurate scheduling)
          │      each wraps itself in a struct snd_device, state = SNDRV_DEV_BUILD
          │      (linked onto card->devices)
          │
          snd_ctl_new1() + snd_ctl_add()  → struct snd_kcontrol linked onto card->controls
          │      (no snd_device of its own; served by the one SNDRV_DEV_CONTROL device above)
          ▼
  snd_card_register()
          │  device_add(&card->card_dev)
          │  snd_device_register_all(card)  → each snd_device: BUILD → REGISTERED
          ▼
  Device nodes go live under /dev/snd/*  and  /proc/asound/cardN/*
```

### The four subsystems ALSA exposes

Every ALSA card is built from up to four kinds of component, each with its own kernel data structures, minor-number range, and device-node naming scheme:

- **PCM (Pulse-Code Modulation)** — playback and capture streams. A `struct snd_pcm` (`sound/core/pcm.c`, `include/sound/pcm.h`) holds up to two `struct snd_pcm_str` — one per direction (`SNDRV_PCM_STREAM_PLAYBACK` / `_CAPTURE`) — each of which owns a list of `struct snd_pcm_substream` for multi-substream hardware. This is where the hardware-parameter negotiation (`hw_params`), ring-buffer layout, and interrupt-driven position updates live. A dedicated deep-dive lives at [PCM: playback and capture](pcm.md).
- **Control** — the mixer. A `struct snd_kcontrol` (`include/sound/control.h`) is a generic name/index/get/put/info tuple — volume sliders, capture-source switches, S/PDIF status bits, and non-audio settings (like a card's internal routing) are all just kcontrols with different `info`/`get`/`put` callbacks. There is exactly one control device per card (`controlC*`), created automatically alongside the card itself, and every mixer application (`amixer`, `alsamixer`, and the PulseAudio/PipeWire mixer backends) talks to it through the same ioctl surface.
- **MIDI** — split into two layers. **Rawmidi** (`struct snd_rawmidi`, `include/sound/rawmidi.h`) is the low-level byte-stream interface a hardware MIDI port or USB MIDI adapter exposes directly. On top of that, the **ALSA sequencer** (`include/sound/seq_kernel.h`, `sound/core/seq/`) is a kernel-space MIDI event router with its own client/port/queue model, letting synthesizers, hardware ports, and userspace sequencer applications (a DAW, `aconnect`) patch MIDI event streams together without every pair of endpoints needing a direct connection.
- **Timer** — `struct snd_timer` (`include/sound/timer.h`) is ALSA's sample-accurate scheduling primitive, used internally to drive PCM period-elapsed notifications and sequencer event timing, and also exposed to userspace (`/dev/snd/timer`) for applications that need hardware-synchronized wakeups.

Most consumer audio hardware only ever populates PCM and Control; MIDI and Timer devices appear on cards that actually have MIDI ports or timer-capable hardware. For SoC/embedded audio, the four subsystems above are still what gets exposed to userspace, but the driver side is usually written against **ASoC (ALSA System on Chip)**, a layer that splits a driver into a reusable *codec* driver, a *platform*/DMA driver, and a small *machine* driver that wires the two together for a specific board — covered in [ASoC](asoc.md).

### Userspace-facing device nodes

Every registered component shows up as a character device under `/dev/snd/`, all sharing major number 116 (`CONFIG_SND_MAJOR`) with the card and device-within-card encoded in the minor number (`SNDRV_MINOR_CARD()`/`SNDRV_MINOR_DEVICE()` in [`include/sound/minors.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/sound/minors.h)). That fixed `card << 5 | device` minor layout is the default; with `CONFIG_SND_DYNAMIC_MINORS` enabled, minors are instead handed out on demand from a flat range and no longer decompose this way. The naming, set with `dev_set_name()` in each subsystem's registration path, follows a fixed pattern:

| Node | Meaning | Set in |
|---|---|---|
| `controlC0` | mixer/control device for card 0 | `sound/core/control.c` |
| `pcmC0D0p` | card 0, PCM device 0, **p**layback | `sound/core/pcm.c` |
| `pcmC0D0c` | card 0, PCM device 0, **c**apture | `sound/core/pcm.c` |
| `midiC0D0` | card 0, rawmidi device 0 | `sound/core/rawmidi.c` |
| `seq` | the sequencer, one node shared by all cards | `sound/core/seq/` |
| `timer` | the timer device, likewise shared | `sound/core/timer.c` |

A card with two independent audio paths (say, analog output and HDMI output) shows up as `pcmC0D0p` and `pcmC0D1p` — different PCM *devices* on the same *card*, not different cards.

Almost nothing talks to these nodes directly except `libasound` (the ALSA userspace library) and audio servers. On most modern distributions, applications go through **PipeWire** (or, on older/simpler setups, **PulseAudio**), which owns the device exclusively and gives applications a mixed, format-converted, network-transparent stream instead. PipeWire's own ALSA compatibility is a plugin that intercepts `libasound` calls for the (shrinking) set of applications that still open ALSA devices directly, and it also implements a PulseAudio-compatible socket and a JACK-compatible client library for those ecosystems — the kernel ALSA nodes remain the actual bottom layer underneath all of them ([LWN: "PipeWire: The Linux audio/video bus," Ahmed S. Darwish, 2021](https://lwn.net/Articles/847412/)). This page stops at that boundary: PulseAudio/PipeWire internals are userspace, not kernel, and out of scope here.

### Card and device numbering, and `/proc/asound`

Card indices are assigned at `snd_card_new()` time (`snd_card_init()` in `sound/core/init.c`): a driver can request a specific `index` module parameter; if unset, the kernel first checks the global `slots=` module parameter for a slot reserved by that driver's module name (`module_slot_match()`), and only then falls back to the first free slot, up to `SNDRV_CARDS` cards. That index (`card->number`) is what appears in every device name — `card0`, `controlC0`, `pcmC0D0p` — and it is *not* guaranteed to match probe order across reboots unless something (a module `options` line pinning `index=`, the `slots=` array, or udev/systemd persistent-naming rules) fixes it in place.

`/proc/asound/` mirrors the live card/device state for inspection without needing any special tooling:

- **`/proc/asound/cards`** lists every registered card, one line (plus a driver/long-name continuation line) per card, in the format `snd_card_info_read()` in `sound/core/init.c` writes: `" N [id             ]: driver - shortname"` followed by the `longname` on the next line.
- **`/proc/asound/cardN/`** holds that card's own tree — `id`, `pcm0p/`, `pcm0c/`, etc. — with hardware parameters, buffer state, and driver-specific debug info exposed as plain-text files, which is often the fastest way to check what a driver's `hw_params` or `codec` state actually is without instrumenting the driver.

### The rest of this section

The pages that follow go deeper on each piece summarized above:

- **[PCM: playback and capture](pcm.md)** — hardware-parameter negotiation, the ring buffer, interrupt-driven period updates, and how a userspace `write()`/`mmap()` call turns into DMA.
- **[ASoC](asoc.md)** — the codec/platform/machine driver split used by essentially all embedded and SoC audio, and how DAPM manages power domains inside the audio path.

### Prerequisites and neighbors

ALSA drivers are ordinary [Linux device-model](../drivers/device-model.md) citizens — most desktop/server sound cards are [PCI devices](../drivers/pci-driver.md) or USB audio-class devices, while embedded audio is almost always a [platform device](../drivers/platform-driver.md) tree assembled by ASoC. The `/dev/snd/*` nodes themselves are plain [character devices](../drivers/chardev.md) registered through the same `cdev`/`file_operations` machinery as any other driver. Reading order: this page, then [PCM](pcm.md) for the data path, then [ASoC](asoc.md) if you're working on embedded/SoC audio.

## Further reading

### Kernel source

- [include/sound/core.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/sound/core.h) — `struct snd_card`, `struct snd_device`, and the card/device registration API
- [sound/core/init.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/sound/core/init.c) — `snd_card_new()`, `snd_card_register()`, card-index assignment, `/proc/asound/cards`
- [sound/core/device.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/sound/core/device.c) — `snd_device_new()`/`snd_device_register_all()` and the `SNDRV_DEV_BUILD` → `SNDRV_DEV_REGISTERED` state machine
- [include/sound/pcm.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/sound/pcm.h) · [sound/core/pcm.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/sound/core/pcm.c) — `struct snd_pcm`, substreams, and `pcmC%iD%i%c` device naming
- [include/sound/control.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/sound/control.h) · [sound/core/control.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/sound/core/control.c) — `struct snd_kcontrol` and the mixer control device
- [include/sound/rawmidi.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/sound/rawmidi.h) — `struct snd_rawmidi`
- [include/sound/timer.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/sound/timer.h) — `struct snd_timer`
- [include/sound/minors.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/sound/minors.h) — minor-number layout for `/dev/snd/*`

### Related pages

- [PCM: playback and capture](pcm.md) — the data path in depth
- [ASoC](asoc.md) — codec/platform/machine drivers for embedded audio
- [Linux Device Model](../drivers/device-model.md) · [PCI Drivers](../drivers/pci-driver.md) · [Platform Drivers](../drivers/platform-driver.md) · [Character Devices](../drivers/chardev.md) — the driver-core layers ALSA sits on

### LWN articles

- [LPC: The past, present, and future of Linux audio](https://lwn.net/Articles/355542/) — how and why ALSA replaced OSS as Linux's default sound system
- [PipeWire: The Linux audio/video bus](https://lwn.net/Articles/847412/) — where PipeWire sits relative to ALSA, PulseAudio, and JACK

### External

- [Kernel docs: Writing an ALSA Driver](https://docs.kernel.org/sound/kernel-api/writing-an-alsa-driver.html) — the canonical driver-author's guide to the card/device model
- [Kernel docs: ALSA configuration guide](https://docs.kernel.org/sound/alsa-configuration.html) — module parameters, device-file mapping, and the `/proc/asound` layout
- [Kernel docs: OSS emulation](https://docs.kernel.org/sound/designs/oss-emulation.html) — how the legacy OSS API is emulated on top of ALSA today
- [Kernel docs: Sound subsystem documentation index](https://docs.kernel.org/sound/index.html) — top-level index, including the ALSA SoC and HD-Audio sections
