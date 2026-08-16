# ASoC: Audio for Embedded Systems

> Why a phone's audio path is three drivers wired together instead of one, and how DAPM keeps most of it powered off

## The problem: the "sound card" is actually three chips on a board

ALSA's original driver model assumes a sound card is one device. A PCI or USB sound card has a single `snd_pcm` driver that owns the DMA engine, the codec registers, and the mixer controls — because physically it's one chip (or one small board) behind one bus address. `snd_pcm_ops` for `hw_params`/`trigger`/`pointer` and a handful of `snd_kcontrol`s for volume are enough, because there's nothing else to describe: the codec is soldered to the same silicon as the DMA engine and never appears on any other card.

Embedded and mobile audio doesn't look like that. A typical phone or single-board computer has:

- an **I2S/TDM controller** that's part of the SoC itself, sharing silicon with the CPU, GPU, and everything else on the die;
- a **codec** — a separate DAC/ADC chip (Wolfson, Cirrus, Maxim, Realtek, TI...) sitting on the board's I2C or SPI bus, wired to the SoC's I2S pins for audio and to a completely different bus for control;
- sometimes a **separate amplifier** driving the speaker, also a distinct chip with its own enable GPIO and gain registers.

None of these three are the same piece of silicon, and — critically — the *same* codec chip and the *same* SoC I2S block both turn up on dozens of unrelated boards in different combinations. A driver that hard-wired "this I2S controller talks to this codec" the way a PCI sound card driver hard-wires "this DMA engine talks to this codec" would have to be rewritten for every board. `Documentation/sound/soc/overview.rst` names this as the concrete problem ASoC was written to fix, using exactly this codec-reuse example:

> *"Codec drivers were often tightly coupled to the underlying SoC CPU. This is not ideal and leads to code duplication - for example, Linux had different wm8731 drivers for 4 different SoC platforms."*

The same document lists two more limitations of pre-ASoC embedded audio: no standard way to signal user-initiated events like a headphone jack insertion, and codec drivers that powered up the *entire* chip for any playback or capture — fine for a PC plugged into the wall, wasteful for a battery.

ASoC's answer is to stop treating "the sound card" as one driver and split it into three reusable pieces along exactly the seams the hardware already has:

> *"Codec class drivers: The codec class driver is platform independent... Platform class drivers: The platform class driver includes the audio DMA engine driver, digital audio interface (DAI) drivers... Machine class driver: The machine driver class acts as the glue that describes and binds the other component drivers together to form an ALSA 'sound card device'."*
> — [`Documentation/sound/soc/overview.rst`](https://docs.kernel.org/sound/soc/overview.html)

That's the shape of the rest of this page: what each of those three driver types actually registers with the core, how the machine driver wires two of them together into a working `dai_link`, and why the resulting audio path needs its own fine-grained power model (DAPM) that a PC sound card never had to bother with.

## Three driver components

### CPU DAI driver: the SoC side of the wire

The CPU DAI driver owns the SoC's digital audio interface hardware — the I2S/TDM/PCM controller that shifts bits onto a bus at a bit clock and frame-sync rate, and the DMA plumbing that feeds it from a ring buffer. It has no idea what's on the other end of the wire; it just needs to be configured with a format and a rate and told to start.

The interface it exposes to the ASoC core is `struct snd_soc_dai_driver`, defined in [`include/sound/soc-dai.h`](https://raw.githubusercontent.com/torvalds/linux/master/include/sound/soc-dai.h):

```c
// include/sound/soc-dai.h
struct snd_soc_dai_driver {
	/* DAI description */
	const char *name;
	unsigned int id;
	unsigned int base;
	struct snd_soc_dobj dobj;
	const struct of_phandle_args *dai_args;

	/* ops */
	const struct snd_soc_dai_ops *ops;
	const struct snd_soc_cdai_ops *cops;

	/* DAI capabilities */
	struct snd_soc_pcm_stream capture;
	struct snd_soc_pcm_stream playback;
	unsigned int symmetric_rate:1;
	unsigned int symmetric_channels:1;
	unsigned int symmetric_sample_bits:1;
};
```

`capture` and `playback` are each a `struct snd_soc_pcm_stream` — supported rates, formats, and channel counts as bitmasks (`SNDRV_PCM_RATE_*`, `SNDRV_PCM_FMTBIT_*`), the same vocabulary a plain ALSA PCM driver uses. The actual operations live in `struct snd_soc_dai_ops`, and the ones a CPU DAI driver cares about are the clocking/format setters plus the standard PCM trigger sequence:

```c
// include/sound/soc-dai.h (selected fields)
struct snd_soc_dai_ops {
	int (*probe)(struct snd_soc_dai *dai);
	int (*remove)(struct snd_soc_dai *dai);

	/* clocking configuration */
	int (*set_sysclk)(struct snd_soc_dai *dai, int clk_id, unsigned int freq, int dir);
	int (*set_pll)(struct snd_soc_dai *dai, int pll_id, int source,
		unsigned int freq_in, unsigned int freq_out);
	int (*set_clkdiv)(struct snd_soc_dai *dai, int div_id, int div);
	int (*set_bclk_ratio)(struct snd_soc_dai *dai, unsigned int ratio);

	/* format configuration */
	int (*set_fmt)(struct snd_soc_dai *dai, unsigned int fmt);
	int (*set_tdm_slot)(struct snd_soc_dai *dai,
		unsigned int tx_mask, unsigned int rx_mask, int slots, int slot_width);

	/* digital mute */
	int (*mute_stream)(struct snd_soc_dai *dai, int mute, int stream);

	/* PCM operations, called by soc-core during audio PCM operations */
	int (*startup)(struct snd_pcm_substream *, struct snd_soc_dai *);
	void (*shutdown)(struct snd_pcm_substream *, struct snd_soc_dai *);
	int (*hw_params)(struct snd_pcm_substream *, struct snd_pcm_hw_params *, struct snd_soc_dai *);
	int (*hw_free)(struct snd_pcm_substream *, struct snd_soc_dai *);
	int (*trigger)(struct snd_pcm_substream *, int, struct snd_soc_dai *);
};
```

`set_fmt` is the one that carries the I2S protocol details — justification (I2S/left-justified/right-justified/DSP), clock polarity, and, as of the format-bit rework, which side drives the bit clock and frame sync. That last part used to be spelled `_MASTER`/`_SLAVE`; current headers spell it in terms of provider/consumer instead, and the bit patterns are explicit about which signal each side of the link owns:

```c
// include/sound/soc-dai.h
#define SND_SOC_DAIFMT_CBP_CFP		(1 << 12) /* codec clk provider & frame provider */
#define SND_SOC_DAIFMT_CBC_CFP		(2 << 12) /* codec clk consumer & frame provider */
#define SND_SOC_DAIFMT_CBP_CFC		(3 << 12) /* codec clk provider & frame consumer */
#define SND_SOC_DAIFMT_CBC_CFC		(4 << 12) /* codec clk consumer & frame consumer */
```

Rockchip's I2S driver is a compact real example of a CPU DAI driver — no codec-specific code anywhere in it, just the I2S controller:

```c
// sound/soc/rockchip/rockchip_i2s.c
static const struct snd_soc_dai_ops rockchip_i2s_dai_ops = {
	.probe = rockchip_i2s_dai_probe,
	.hw_params = rockchip_i2s_hw_params,
	.set_bclk_ratio	= rockchip_i2s_set_bclk_ratio,
	.set_sysclk = rockchip_i2s_set_sysclk,
	.set_fmt = rockchip_i2s_set_fmt,
	.trigger = rockchip_i2s_trigger,
};

static struct snd_soc_dai_driver rockchip_i2s_dai = {
	.ops = &rockchip_i2s_dai_ops,
	.symmetric_rate = 1,
};
```

(The `playback`/`capture` `snd_soc_pcm_stream`s aren't in the static initializer — `rockchip_i2s_init_dai()` fills them in from devicetree at probe time, since the same silicon block is wired for playback-only, capture-only, or both depending on the board.)

There's a structural detail worth flagging here, because ASoC's own documentation still describes the older three-way split: a "platform class driver" for the DMA engine, separate from the codec class driver. That struct doesn't exist anymore — `grep -rn "struct snd_soc_platform" include/sound/` against current mainline returns nothing. The DMA/platform role was folded into the same component model the codec side uses (below); a CPU DAI driver registers its `snd_soc_dai_driver` and, for the DMA side, typically just calls a helper like `devm_snd_dmaengine_pcm_register()` rather than implementing PCM callbacks itself:

```c
// sound/soc/rockchip/rockchip_i2s.c
ret = devm_snd_soc_register_component(&pdev->dev,
				      &rockchip_i2s_component,
				      dai, 1);
...
ret = devm_snd_dmaengine_pcm_register(&pdev->dev, NULL, 0);
```

### Codec driver: the DAC/ADC chip itself

The codec driver is the platform-independent half: it knows how to talk to a specific DAC/ADC chip over I2C or SPI, what its mixer topology looks like, and how to sequence its internal power domains — but nothing about which SoC or which board it's wired to. That's what makes the wm8731-times-four problem `overview.rst` complains about solvable: write the codec driver once, reuse it on every board that happens to use that chip.

Structurally, a codec driver looks almost identical to a CPU DAI driver — it registers a `snd_soc_dai_driver` too, since the codec side of the I2S link is also a DAI. What differs is the *component* it registers alongside it. Older ASoC code had a distinct `struct snd_soc_codec` for this; current mainline doesn't — the same `grep` for `struct snd_soc_codec` against `include/sound/` turns up nothing but `snd_soc_codec_conf` (a machine-driver-side per-codec configuration knob, not the driver-facing struct). Codec drivers, CPU DAI/platform drivers, and even DSP/compressed-audio drivers all register through the same [`struct snd_soc_component_driver`](https://raw.githubusercontent.com/torvalds/linux/master/include/sound/soc-component.h):

```c
// include/sound/soc-component.h (selected fields)
struct snd_soc_component_driver {
	const char *name;

	const struct snd_kcontrol_new *controls;
	unsigned int num_controls;
	const struct snd_soc_dapm_widget *dapm_widgets;
	unsigned int num_dapm_widgets;
	const struct snd_soc_dapm_route *dapm_routes;
	unsigned int num_dapm_routes;

	int (*probe)(struct snd_soc_component *component);
	void (*remove)(struct snd_soc_component *component);

	unsigned int (*read)(struct snd_soc_component *component, unsigned int reg);
	int (*write)(struct snd_soc_component *component, unsigned int reg, unsigned int val);

	int (*set_sysclk)(struct snd_soc_component *component,
			  int clk_id, int source, unsigned int freq, int dir);
	int (*set_jack)(struct snd_soc_component *component,
			struct snd_soc_jack *jack, void *data);
	int (*set_bias_level)(struct snd_soc_component *component,
			      enum snd_soc_bias_level level);

	/* PCM operations — used by DMA/platform-style components */
	int (*hw_params)(struct snd_soc_component *component,
			 struct snd_pcm_substream *substream, struct snd_pcm_hw_params *params);
	int (*trigger)(struct snd_soc_component *component,
		       struct snd_pcm_substream *substream, int cmd);
	snd_pcm_uframes_t (*pointer)(struct snd_soc_component *component,
				     struct snd_pcm_substream *substream);

	unsigned int idle_bias_on:1;
	unsigned int endianness:1;
};
```

and its runtime counterpart:

```c
// include/sound/soc-component.h (selected fields)
struct snd_soc_component {
	const char *name;
	const char *name_prefix;
	struct device *dev;
	struct snd_soc_card *card;

	unsigned int active;
	struct list_head dai_list;
	int num_dai;

	struct regmap *regmap;

	/*
	 * DO NOT use any of the fields below in drivers, they are
	 * temporary and are going to be removed again soon. If you
	 * use them in driver code the driver will be marked as
	 * BROKEN when these fields are removed.
	 */
	struct snd_soc_dapm_context *dapm;
	int (*init)(struct snd_soc_component *component);
};
```

`controls`, `dapm_widgets`, and `dapm_routes` on the *driver* struct are exactly what makes a codec driver self-describing: the driver ships its own DAPM graph (below), and the machine driver only has to describe the parts that are board-specific (an external speaker, a mic jack) rather than re-declaring the codec's internal mixer topology every time.

Maxim's max98090 codec driver shows the pattern end to end — its own `snd_soc_dai_driver` for the I2S side, and a `snd_soc_component_driver` for everything else:

```c
// sound/soc/codecs/max98090.c
static struct snd_soc_dai_driver max98090_dai = {
	.name = "HiFi",
	.playback = {
		.stream_name = "HiFi Playback",
		.channels_min = 2,
		.channels_max = 2,
		.rates = MAX98090_RATES,
		.formats = MAX98090_FORMATS,
	},
	.capture = {
		.stream_name = "HiFi Capture",
		.channels_min = 1,
		.channels_max = 4,
		.rates = MAX98090_RATES,
		.formats = MAX98090_FORMATS,
	},
	.ops = &max98090_dai_ops,
};

static const struct snd_soc_component_driver soc_component_dev_max98090 = {
	.probe			= max98090_probe,
	.remove			= max98090_remove,
	.seq_notifier		= max98090_seq_notifier,
	.set_bias_level		= max98090_set_bias_level,
	.set_jack		= max98090_set_jack,
	.idle_bias_on		= 1,
	.use_pmdown_time	= 1,
	.endianness		= 1,
};
```

registered from the I2C probe function with the same `devm_snd_soc_register_component()` the CPU DAI side used:

```c
// sound/soc/codecs/max98090.c
ret = devm_snd_soc_register_component(&i2c->dev,
				      &soc_component_dev_max98090,
				      &max98090_dai, 1);
```

Nothing in either struct mentions Rockchip, and nothing in the Rockchip I2S driver mentions Maxim — which is exactly the reuse `overview.rst` was written to enable. The board that puts these two together is the machine driver's job.

### Machine driver: DAI links and board glue

The machine driver is the only one of the three that's genuinely board-specific, and its central job is small: declare which CPU DAI connects to which codec DAI, over what bus format, and hand the pair to the core as a `struct snd_soc_dai_link`. `Documentation/sound/soc/machine.rst` puts the scope plainly:

> *"The ASoC machine (or board) driver is the code that glues together all the component drivers (e.g. codecs, platforms and DAIs). It also describes the relationships between each component which include audio paths, GPIOs, interrupts, clocking, jacks and voltage regulators."*

A `dai_link` doesn't reference a CPU DAI and a codec DAI by embedding them directly — each side is an array of `struct snd_soc_dai_link_component`, because a link can legitimately have more than one DAI per side (multi-codec boards, TDM-split CPUs feeding several codec channels):

```c
// include/sound/soc.h
struct snd_soc_dai_link_component {
	const char *name;
	struct device_node *of_node;
	const char *dai_name;
	const struct of_phandle_args *dai_args;
	unsigned int ext_fmt;
};

// struct snd_soc_dai_link (selected fields)
struct snd_soc_dai_link {
	const char *name;			/* Codec name */
	const char *stream_name;		/* Stream name */

	struct snd_soc_dai_link_component *cpus;
	unsigned int num_cpus;

	struct snd_soc_dai_link_component *codecs;
	unsigned int num_codecs;

	struct snd_soc_dai_link_component *platforms;
	unsigned int num_platforms;

	unsigned int dai_fmt;			/* format to set on init */

	/* codec/machine specific init - e.g. add machine controls */
	int (*init)(struct snd_soc_pcm_runtime *rtd);

	const struct snd_soc_ops *ops;

	unsigned int playback_only:1;
	unsigned int capture_only:1;
	unsigned int no_pcm:1;			/* backend link, no userspace PCM */
	unsigned int dynamic:1;		/* frontend, routes to a BE at runtime */
};
```

There are no `.cpu_dai_name`/`.codec_name`/`.platform_name` string fields on this struct — that flatter, DPCM-era shape is gone from current mainline (a stale example still circulating in `machine.rst` still shows it; don't copy it). Populating the three component arrays by hand for every link is tedious enough that `soc.h` provides a macro pair to build them at compile time:

```c
// include/sound/soc.h
#define COMP_CPU(_dai)			{ .dai_name = _dai, }
#define COMP_CODEC(_name, _dai)		{ .name = _name, .dai_name = _dai, }
#define COMP_PLATFORM(_name)		{ .name = _name }

SND_SOC_DAILINK_DEFS(test,
	DAILINK_COMP_ARRAY(COMP_CPU("cpu_dai")),
	DAILINK_COMP_ARRAY(COMP_CODEC("codec", "codec_dai")),
	DAILINK_COMP_ARRAY(COMP_PLATFORM("platform")));

struct snd_soc_dai_link link = {
	...
	SND_SOC_DAILINK_REG(test),
};
```

Rockchip's machine driver for boards with a max98090 codec is a real, current instance of exactly this pattern — note that both `cpus` and `platforms` use `COMP_EMPTY()`, because on this SoC the I2S controller and the DMA engine are matched to the runtime by devicetree phandle rather than by name:

```c
// sound/soc/rockchip/rockchip_max98090.c
SND_SOC_DAILINK_DEFS(analog,
		     DAILINK_COMP_ARRAY(COMP_EMPTY()),
		     DAILINK_COMP_ARRAY(COMP_CODEC(NULL, "HiFi")),
		     DAILINK_COMP_ARRAY(COMP_EMPTY()));

static struct snd_soc_dai_link rk_max98090_dailinks[] = {
	{
		.name = "max98090",
		.stream_name = "Analog",
		.init = rk_init,
		.ops = &rk_aif1_ops,
		/* set max98090 as slave */
		.dai_fmt = SND_SOC_DAIFMT_I2S | SND_SOC_DAIFMT_NB_NF |
			SND_SOC_DAIFMT_CBC_CFC,
		SND_SOC_DAILINK_REG(analog),
	},
};

static struct snd_soc_card rockchip_max98090_card = {
	.name = "ROCKCHIP-I2S",
	.owner = THIS_MODULE,
	.dai_link = rk_max98090_dailinks,
	.num_links = ARRAY_SIZE(rk_max98090_dailinks),
	.aux_dev = &rk_98090_headset_dev,
	.num_aux_devs = 1,
	.dapm_widgets = rk_max98090_dapm_widgets,
	.num_dapm_widgets = ARRAY_SIZE(rk_max98090_dapm_widgets),
	.dapm_routes = rk_max98090_audio_map,
	.num_dapm_routes = ARRAY_SIZE(rk_max98090_audio_map),
	.controls = rk_max98090_controls,
	.num_controls = ARRAY_SIZE(rk_max98090_controls),
};
```

`struct snd_soc_card` is the top-level object the machine driver registers with `devm_snd_soc_register_card()`: an array of `dai_link`s plus the board-level DAPM widgets/routes/controls that the codec driver doesn't already know about (the external speaker, the mic jack — see below). `dai_fmt` here spells out the I2S wire format directly on the link: standard I2S justification, normal (non-inverted) bit clock and frame, and the codec as the clock *consumer* on both bit clock and frame sync — meaning the Rockchip I2S controller is the one driving BCLK/LRCK on this board. `aux_dev`/`num_aux_devs` is a separate, smaller mechanism for a component that isn't part of any `dai_link` at all — on this board it points at `rk_98090_headset_dev`, which just calls `ts3a227e_enable_jack_detect()` to wire up a headset-jack-detection IC's interrupt, not an audio data path.

## DAPM: power-managing what a PC sound card doesn't have

A PC sound card codec is behind a fixed AC'97 or HD-Audio link, plugged into wall power, and typically has one dominant power state: on, because the machine itself is either awake or suspended. An embedded codec is different in two ways that matter for power: it runs on a battery, and it usually contains several genuinely independent analog blocks — a headphone amp, a speaker amp, a mic bias supply, an ADC, a DAC — any subset of which might be needed at a given moment depending on what's actually connected and what's actually playing. Powering the whole chip for a phone call that only needs the mic-bias-to-ADC path is wasted current draw a laptop sound card never had to think about.

Dynamic Audio Power Management (DAPM) is ASoC's answer, and unlike everything else on this page it's *not* something the machine driver has to actively manage — `Documentation/sound/soc/dapm.rst` is explicit that the machine driver just describes the graph and the core does the rest:

> *"DAPM is also completely transparent to all user space applications as all power switching is done within the ASoC core. No code changes or recompiling are required for user space applications. DAPM makes power switching decisions based upon any audio stream (capture/playback) activity and audio mixer settings within the device."*

The model is a directed graph of two kinds of object:

> *"a **widget** is every part of the audio hardware that can be enabled by software when in use and disabled to save power when not in use... a **route** is an interconnection between widgets that exists when sound can flow from one widget to the other."*

A widget is `struct snd_soc_dapm_widget` — a typed node (mixer, mux, PGA, ADC, DAC, mic, speaker, supply, ...) with a register/bit/mask that toggles its power, plus the standard bookkeeping for walking the graph:

```c
// include/sound/soc-dapm.h (selected fields)
struct snd_soc_dapm_widget {
	enum snd_soc_dapm_type id;
	const char *name;
	const char *sname;			/* stream name, for AIF/DAC/ADC widgets */

	int reg;				/* negative reg = no direct dapm */
	unsigned char shift;
	unsigned int mask;
	unsigned int on_val;
	unsigned int off_val;
	unsigned char power:1;			/* block power status */
	unsigned char connected:1;		/* connected codec pin */

	int (*event)(struct snd_soc_dapm_widget*, struct snd_kcontrol *, int);
	unsigned short event_flags;

	int num_kcontrols;
	const struct snd_kcontrol_new *kcontrol_news;

	struct list_head edges[2];		/* widget input and output edges */
};
```

and a route is the much simpler `struct snd_soc_dapm_route` — just `sink`, `source`, and an optional `control` name when the connection is gated by a mux or switch:

```c
// include/sound/soc-dapm.h
struct snd_soc_dapm_route {
	const char *sink;
	const char *control;
	const char *source;
	int (*connected)(struct snd_soc_dapm_widget *source,
			 struct snd_soc_dapm_widget *sink);
};
```

Widgets are declared with per-type convenience macros — `SND_SOC_DAPM_SPK`, `SND_SOC_DAPM_MIC`, `SND_SOC_DAPM_ADC`, `SND_SOC_DAPM_MIXER`, and so on — most of them expanding to a `struct snd_soc_dapm_widget` literal with the right `id` and register bits filled in. The Rockchip board again gives a real, minimal example of the board-level half of the graph — the external jacks the codec driver doesn't know about, wired to pins the codec driver *does* export:

```c
// sound/soc/rockchip/rockchip_max98090.c
#define RK_MAX98090_WIDGETS \
	SND_SOC_DAPM_HP("Headphone", NULL), \
	SND_SOC_DAPM_MIC("Headset Mic", NULL), \
	SND_SOC_DAPM_MIC("Int Mic", NULL), \
	SND_SOC_DAPM_SPK("Speaker", NULL)

#define RK_MAX98090_AUDIO_MAP \
	{"IN34", NULL, "Headset Mic"}, \
	{"Headset Mic", NULL, "MICBIAS"}, \
	{"DMICL", NULL, "Int Mic"}, \
	{"Headphone", NULL, "HPL"}, \
	{"Headphone", NULL, "HPR"}, \
	{"Speaker", NULL, "SPKL"}, \
	{"Speaker", NULL, "SPKR"}
```

`IN34`, `HPL`/`HPR`, `SPKL`/`SPKR`, and `MICBIAS` are internal pins the max98090 codec driver already registered — but not through the `snd_soc_component_driver` static initializer shown above. `soc_component_dev_max98090` sets no `.dapm_widgets`/`.dapm_routes` at all; the driver instead registers its widgets imperatively from its `probe()` callback, via a helper that calls `snd_soc_dapm_new_controls()`/`snd_soc_dapm_add_routes()`:

```c
// sound/soc/codecs/max98090.c
static int max98090_add_widgets(struct snd_soc_component *component)
{
	struct max98090_priv *max98090 = snd_soc_component_get_drvdata(component);
	struct snd_soc_dapm_context *dapm = snd_soc_component_to_dapm(component);

	snd_soc_add_component_controls(component, max98090_snd_controls,
		ARRAY_SIZE(max98090_snd_controls));

	if (max98090->devtype == MAX98091) {
		snd_soc_add_component_controls(component, max98091_snd_controls,
			ARRAY_SIZE(max98091_snd_controls));
	}

	snd_soc_dapm_new_controls(dapm, max98090_dapm_widgets,
		ARRAY_SIZE(max98090_dapm_widgets));

	snd_soc_dapm_add_routes(dapm, max98090_dapm_routes,
		ARRAY_SIZE(max98090_dapm_routes));
	...
}
```

Doing it this way rather than through the static `.dapm_widgets` field is what lets the driver pick a different widget set at runtime — the `if (max98090->devtype == MAX98091)` branch above adds a second array of controls for the max98091 variant, something a fixed compile-time array on the driver struct can't express. Either way, the machine driver never needs to know how the codec powers its own headphone amp internally; it only has to say "the board's headphone jack is wired to the codec's HPL/HPR pins," and DAPM's graph walk takes care of the rest: opening a playback stream marks the DAC endpoint active, the core walks backward through the route graph powering every widget on the path to a connected, active endpoint, and idle branches (the mic path, if nothing's recording) stay off.

`dapm.rst` groups the power decisions into four domains, each triggered by a different kind of event — stream start/stop, a mixer switch, a jack insertion, or codec suspend/resume:

| Domain | What it covers | Triggered by |
|---|---|---|
| Codec bias | VREF/VMID — core codec/audio power | probe, suspend/resume |
| Platform/machine | physically connected inputs/outputs | machine driver, async events (jack insert) |
| Path | mixer/mux signal paths | user changing a control (alsamixer) |
| Stream | DACs and ADCs | stream start/stop (aplay/arecord) |

The codec bias domain is itself a small state machine, `enum snd_soc_bias_level`, and its four states are the ones a codec's `set_bias_level` callback is expected to sequence through cleanly to avoid the pops and clicks a fast, uncontrolled power transition causes. The enum body itself is bare; the explanation of each value lives in the kernel-doc block immediately above it:

```c
// include/sound/soc-dapm.h
/*
 * Bias levels
 *
 * @ON:      Bias is fully on for audio playback and capture operations.
 * @PREPARE: Prepare for audio operations. Called before DAPM switching for
 *           stream start and stop operations.
 * @STANDBY: Low power standby state when no playback/capture operations are
 *           in progress. NOTE: The transition time between STANDBY and ON
 *           should be as fast as possible and no longer than 10ms.
 * @OFF:     Power Off. No restrictions on transition times.
 */
enum snd_soc_bias_level {
	SND_SOC_BIAS_OFF = 0,
	SND_SOC_BIAS_STANDBY = 1,
	SND_SOC_BIAS_PREPARE = 2,
	SND_SOC_BIAS_ON = 3,
};
```

## Devicetree: describing the board topology without writing a driver

Most embedded boards don't need a bespoke C machine driver at all. If the topology is just "one CPU DAI, one codec DAI, a fixed I2S format, and a short list of board widgets/routes" — which covers a large fraction of real hardware — the generic **simple-audio-card** driver (`sound/soc/generic/simple-card.c`) can build the entire `snd_soc_card` from devicetree properties, with no board-specific driver code at all. The DT node names the CPU and codec DAIs by phandle and spells out the same widget/route information a bespoke machine driver would hardcode in C:

```dts
sound {
    compatible = "simple-audio-card";
    simple-audio-card,name = "VF610-Tower-Sound-Card";
    simple-audio-card,format = "left_j";
    simple-audio-card,bitclock-master = <&dailink0_master>;
    simple-audio-card,frame-master = <&dailink0_master>;
    simple-audio-card,widgets =
            "Microphone", "Microphone Jack",
            "Headphone", "Headphone Jack",
            "Speaker", "External Speaker";
    simple-audio-card,routing =
            "MIC_IN", "Microphone Jack",
            "Headphone Jack", "HP_OUT",
            "External Speaker", "LINE_OUT";

    simple-audio-card,cpu {
        sound-dai = <&sh_fsi2 0>;
    };

    dailink0_master: simple-audio-card,codec {
        sound-dai = <&ak4648>;
        clocks = <&osc>;
    };
};
```
— [`Documentation/devicetree/bindings/sound/simple-card.yaml`](https://www.kernel.org/doc/Documentation/devicetree/bindings/sound/simple-card.yaml)

For topologies simple-card's flat `cpu`/`codec` node pair can't express cleanly — several DAIs feeding a shared codec through TDM splits, or boards with more than two components chained together — there's **audio-graph-card** (`sound/soc/generic/audio-graph-card.c`), which reuses the generic devicetree [OF graph](https://www.kernel.org/doc/Documentation/devicetree/bindings/graph.txt) `port`/`endpoint`/`remote-endpoint` bindings instead of simple-card's flat property list:

```dts
sound {
    compatible = "audio-graph-card";
    dais = <&cpu_port_a>;
};

cpu {
    port {
        cpu_endpoint: endpoint {
            remote-endpoint = <&codec_endpoint>;
            dai-format = "left_j";
        };
    };
};

codec {
    port {
        codec_endpoint: endpoint {
            remote-endpoint = <&cpu_endpoint>;
        };
    };
};
```
— [`Documentation/devicetree/bindings/sound/audio-graph-card.yaml`](https://raw.githubusercontent.com/torvalds/linux/master/Documentation/devicetree/bindings/sound/audio-graph-card.yaml)

Both drivers are, structurally, just machine drivers themselves: they parse devicetree properties and populate the exact same `snd_soc_dai_link`/`snd_soc_card` structures a hand-written board driver like `rockchip_max98090.c` would build in C, then call the same `devm_snd_soc_register_card()`. The choice between writing a real machine driver, using simple-card, or using audio-graph-card is purely about how much board-specific logic (jack detection callbacks, GPIO-controlled amps, non-trivial `.init()` hooks) the board actually needs — anything simple-card and audio-graph-card can't express in properties still falls back to a C machine driver.

## How it fits together

```
                          snd_soc_card                         machine driver
                    (e.g. "ROCKCHIP-I2S", or built
                     from DT by simple-card/
                     audio-graph-card)
                ┌───────────────────────────────┐
                │ dai_link[] ─┬─ .cpus[]         │
                │             ├─ .codecs[]       │
                │             ├─ .platforms[]    │
                │             └─ .dai_fmt        │
                │ board dapm_widgets/routes      │  ("Headphone" → codec's HPL/HPR)
                │ board controls                 │
                └───────────────┬─────────────────┘
                                 │ binds cpus[i] <-> codecs[i]
              ┌──────────────────┴──────────────────┐
              ▼                                      ▼
  ┌─────────────────────────┐            ┌─────────────────────────┐
  │   CPU DAI driver          │  I2S/TDM   │   Codec driver           │
  │   (e.g. rockchip_i2s.c)   │◄──────────►│   (e.g. max98090.c)      │
  │                           │ BCLK/LRCK  │                          │
  │ snd_soc_component_driver  │  /DATA     │ snd_soc_component_driver │
  │ snd_soc_dai_driver         │            │ snd_soc_dai_driver       │
  │  .ops: set_fmt, hw_params, │            │  .ops: set_fmt, set_sysclk│
  │        trigger             │            │  .dapm_widgets: ADC/DAC, │
  │ + DMA engine (component)   │            │    mixers, HP/SPK amps   │
  │                           │            │  I2C/SPI regmap I/O      │
  └─────────────┬─────────────┘            └─────────────┬─────────────┘
                │                                          │
        part of the SoC die                    separate chip on the board,
                                                reused across many boards
```

The CPU DAI and codec boxes never reference each other by name in source; the machine driver — or the devicetree it was generated from — is the only thing that knows they're wired together on *this particular* board.

## Further reading

### Kernel source

- [`include/sound/soc.h`](https://raw.githubusercontent.com/torvalds/linux/master/include/sound/soc.h) — `snd_soc_dai_link`, `snd_soc_dai_link_component`, `snd_soc_card`, `SND_SOC_DAILINK_DEFS`/`SND_SOC_DAILINK_REG` macros
- [`include/sound/soc-dai.h`](https://raw.githubusercontent.com/torvalds/linux/master/include/sound/soc-dai.h) — `snd_soc_dai`, `snd_soc_dai_driver`, `snd_soc_dai_ops`, DAI format bit definitions
- [`include/sound/soc-component.h`](https://raw.githubusercontent.com/torvalds/linux/master/include/sound/soc-component.h) — `snd_soc_component`, `snd_soc_component_driver` (the unified codec/platform registration point)
- [`include/sound/soc-dapm.h`](https://raw.githubusercontent.com/torvalds/linux/master/include/sound/soc-dapm.h) — `snd_soc_dapm_widget`, `snd_soc_dapm_route`, `snd_soc_bias_level`, widget macros
- [`sound/soc/rockchip/rockchip_i2s.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/sound/soc/rockchip/rockchip_i2s.c) — a real CPU DAI driver
- [`sound/soc/codecs/max98090.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/sound/soc/codecs/max98090.c) — a real codec driver
- [`sound/soc/rockchip/rockchip_max98090.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/sound/soc/rockchip/rockchip_max98090.c) — a real machine driver, DAI links, board DAPM graph
- [`sound/soc/generic/simple-card.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/sound/soc/generic/simple-card.c), [`sound/soc/generic/audio-graph-card.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/sound/soc/generic/audio-graph-card.c) — the generic devicetree-driven machine drivers

### Related pages

- [Device Tree: ARM Hardware Description](../drivers/device-tree.md) — the `of_node`/phandle mechanism `snd_soc_dai_link_component` and simple-card/audio-graph-card build on
- [I2C and SPI Bus Drivers](../drivers/i2c-spi.md) — the control bus most codec drivers register on
- [Platform Drivers](../drivers/platform-driver.md) — the `platform_device`/`platform_driver` pattern CPU DAI and machine drivers both use
- [ALSA War Stories](war-stories.md) — incident record for the PCM/rawmidi/USB-audio layers ASoC's `dai_link`s ultimately sit on top of

### External

- [ALSA SoC Layer Overview](https://docs.kernel.org/sound/soc/overview.html) — the problem statement and the codec/platform/machine split
- [ASoC Machine Driver](https://docs.kernel.org/sound/soc/machine.html) — the machine driver's role (note: its inline code sample predates the current `cpus[]`/`codecs[]`/`platforms[]` array shape — the `SND_SOC_DAILINK_DEFS` form on this page reflects current mainline)
- [ASoC Codec Class Driver](https://docs.kernel.org/sound/soc/codec.html) — codec driver responsibilities
- [ASoC Digital Audio Interface (DAI)](https://docs.kernel.org/sound/soc/dai.html) — AC97/I2S/PCM wire protocols
- [Dynamic Audio Power Management for Portable Devices](https://docs.kernel.org/sound/soc/dapm.html) — the widget/route model and power domains
- [Simple Audio Card devicetree binding](https://www.kernel.org/doc/Documentation/devicetree/bindings/sound/simple-card.yaml)
- [Audio Graph Card devicetree binding](https://www.kernel.org/doc/Documentation/devicetree/bindings/sound/audio-graph-card.yaml)
