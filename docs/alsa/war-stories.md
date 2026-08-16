# War Stories: ALSA Bugs and Regressions

> Six incidents from the ALSA sound subsystem — five of them CVEs, spanning USB audio descriptor parsing, PCM buffer locking, rawmidi resize races, and a use-after-free that sat unexercised for nearly 21 years

[ALSA Overview](README.md), [The PCM Data Path](pcm.md), and [ASoC](asoc.md) document the subsystem as it works today. This page is the incident record behind parts of that architecture: the lifetime and locking bugs that real drivers shipped, and how they were found and fixed.

Unlike [DRM's war stories](../drm/war-stories.md), which are almost entirely reliability bugs (a hung GPU, not a security boundary), every incident here but one is a CVE. That's a structural difference in what the two subsystems expose: `sound/usb/` parses data supplied by whatever USB device is plugged in, and PCM/rawmidi expose ioctls directly to any process that can open `/dev/snd/*` — both are attacker-influenced-input surfaces in a way a GPU scheduler's internal job queue mostly isn't.

## Deep dives

### [The 21-Year-Latent USB Mixer Teardown Use-After-Free](war-stories/mixer-teardown-use-after-free.md)
**January 2026 · CVE-2026-23089**
A 2005 commit gave every registered ALSA control a raw pointer into a USB mixer's notification-routing array. A failed probe could free that array while controls created earlier in the same probe still pointed into it — a bug the code path made possible for almost 21 years before a fix landed.

### [The USB Audio Clock Descriptor Out-of-Bounds Reads](war-stories/usb-audio-clock-descriptor-oob.md)
**November 2024 · CVE-2024-53150 · CISA Known Exploited Vulnerabilities catalog**
Three functions walked a USB audio device's clock-topology descriptors without validating any of them were long enough to hold the fields being read. One of the three variants was exploited in the wild.

## Quick cases

### Case 1: The PCM `hw_params`/`hw_free` race — CVE-2022-1048

ALSA PCM had no critical section covering a full `hw_params`/`hw_free` ioctl call — the existing `snd_pcm_stream_lock` couldn't span the whole call because both ioctls need to sleep (memory allocation, in particular). Two threads issuing `hw_params` and `hw_free` concurrently on the same substream — or the same ioctl racing itself from two threads — could have one thread's `hw_free` release the buffer's backing memory while another thread's `hw_params` was still using it: a use-after-free through a missing lock, not a missing bounds check.

Takashi Iwai's fix ([`92ee3c60ec9f`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=92ee3c60ec9fe64404dc035e7c41277d74aa26cb)) adds a new `runtime->buffer_mutex` in `include/sound/pcm.h`, initialized/destroyed alongside the runtime in `sound/core/pcm.c`, and wraps both `snd_pcm_hw_params()` and `snd_pcm_hw_free()` in it in `sound/core/pcm_native.c` — a mutex specifically because the critical section needs to sleep, where the existing stream lock (a spinlock) couldn't. [NVD: CVE-2022-1048](https://nvd.nist.gov/vuln/detail/CVE-2022-1048), CVSS 3.1 7.0 HIGH.

### Case 2: The rawmidi buffer resize race — CVE-2020-27786

Rawmidi's read/write paths in `sound/core/rawmidi.c` have to unlock the runtime spinlock while copying to/from userspace — you can't hold a spinlock across a user-space copy, since the copy can fault and sleep. That unlock window is exactly when a concurrent `SNDRV_RAWMIDI_IOCTL_PARAMS` call could resize (free and reallocate) the runtime buffer a read or write was still using.

Takashi Iwai's fix ([`c1f6e3c818dd`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=c1f6e3c818dd734c30f6a7eeebf232ba2cf3181d)) adds a plain, spinlock-protected reference counter (`buffer_ref`) — not `refcount_t`, since every access is already serialized by the lock the counter lives under — and makes a resize return `-EBUSY` while a read or write holds a reference. The receive/transmit interrupt callbacks don't need the same check; they're already fully covered by the lock. [NVD: CVE-2020-27786](https://nvd.nist.gov/vuln/detail/CVE-2020-27786), CVSS 3.1 7.8 HIGH.

### Case 3: The mixer-unit descriptor OOB, five years before the clock descriptors — CVE-2019-15117

`parse_audio_mixer_unit()` in `sound/usb/mixer.c` reads a `uac_mixer_unit_descriptor` and walks its `baSourceID[]` array using the device-supplied `bNrInPins` count — without checking the descriptor was actually long enough to contain that many entries. Reported by USB-fuzzing researchers Hui Peng and Mathias Payer.

The fix adds one bounds check: `if (desc->bLength < sizeof(*desc) + desc->bNrInPins) return -EINVAL;` before the array walk ([`daac07156b33`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=daac07156b330b18eb5071aec4b3ddca1c377f2c)). It's the same missing-length-validation pattern the [clock descriptor deep-dive](war-stories/usb-audio-clock-descriptor-oob.md) hit again, in a different `sound/usb/` parser, five years later. [NVD: CVE-2019-15117](https://nvd.nist.gov/vuln/detail/CVE-2019-15117), CVSS 7.8 HIGH.

### Case 4: The caiaq probe error-handling use-after-free — CVE-2026-46004

The Native Instruments caiaq USB audio driver's `setup_card()` probe routine called `snd_card_free()` to tear down the card when `snd_card_register()` failed — and then kept executing, calling further init functions (audio, MIDI, input, control setup) against structures that had just been freed. `setup_card()` was `void`; there was no way for it to stop early on error, only to keep going.

Takashi Iwai's fix ([`28abd224db4a`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=28abd224db4a49560b452115bca3672a20e45b2f)) changes `setup_card()` to return `int`, adds an early `return` on every error path, drops the now-redundant `snd_card_free()` call (the caller handles cleanup once the error propagates), and makes `init_card()` check and propagate that return value. [NVD: CVE-2026-46004](https://nvd.nist.gov/vuln/detail/CVE-2026-46004), CVSS 3.1 7.8 HIGH.

## Common threads

| Pattern | Mixer UAF | Clock OOB | hw_params race | Rawmidi race | Mixer-unit OOB | caiaq UAF |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| USB descriptor parsing (attacker controls the input) | — | Yes | — | — | Yes | — |
| Missing length/bounds validation | — | Yes | — | — | Yes | — |
| Lock doesn't cover the full critical section | — | — | Yes | Yes | — | — |
| Probe/init error path leaves a stale reference | Yes | — | — | — | — | Yes |
| Fix required for years/decades before landing | Yes (~21y) | — | — | — | — | — |

**Three of six are USB-descriptor parsing bugs, and two of those three are the same missing check, five years apart, in two different parsers.** The mixer-unit OOB (2019) and the clock-descriptor OOB (2024) both come from reading a device-supplied count field and indexing further into a buffer without re-validating the buffer is actually that long — `sound/usb/` has more than one descriptor walker built on that same unchecked pattern, and fixing one instance evidently didn't prompt an audit of the others at the time.

**Two of six are the same underlying shape: a lock that can't span the full operation because part of the operation has to sleep.** PCM's `hw_params`/`hw_free` and rawmidi's read/write-vs-resize race both needed a mutex or reference count layered *around* a spinlock-protected fast path specifically because a user-space copy or an allocation can't happen while holding a spinlock — the fix in both cases is "add a second, sleep-safe layer of protection," not "make the existing lock work harder."

**The mixer teardown UAF is the one open-ended lifetime bug on this page, and it's also the only one that took decades to surface.** The USB-descriptor and locking bugs above are all reachable on essentially every affected kernel, the moment the right device or the right race window shows up — which is why they were found relatively quickly by fuzzing or CVE-hunting. The mixer teardown bug required a specific, non-trivial sequencing (some controls already registered, then a *later* unit's parsing to fail) that well-formed devices essentially never produce — the same property that let it hide for 21 years is why it needed a targeted audit, not routine fuzzing, to surface at all.

## See also

- [ALSA Overview](README.md) — `struct snd_card`, control registration, and the USB audio device model these incidents live inside
- [The PCM Data Path](pcm.md) — the `hw_params`/`hw_free` machinery Case 1's race lives in
- [DRM War Stories](../drm/war-stories.md) — a subsystem where reliability bugs (hangs, deadlocks) dominate instead of CVEs, for contrast in what "war story" means when the bug class is exploitable rather than reliability-only
- [Locking](../locking/README.md) — general background on lock-scope and critical-section bugs, the pattern behind Cases 1 and 2
