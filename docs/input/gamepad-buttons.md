# Gamepad Buttons: Position, Not Label

> Why the kernel names a gamepad's face buttons by where they sit, why some older drivers don't, and why nobody has fixed them

## The question people ask

Plug in an Xbox controller over USB and press **Y**, the button at the top of the diamond. The kernel reports it as `BTN_WEST`. Press **X**, the button on the left, and it comes out as `BTN_NORTH`. Both look backwards. The kernel's own [gamepad specification](https://docs.kernel.org/input/gamepad.html) says buttons are reported by physical position, and the Xbox driver doesn't do that.

Both statements are true, and the reason is a decision made in 2013 that applied only to drivers written after it.

## The problem in 2013

Before 2013, gamepad drivers each reported their buttons in their own way. In April 2013 Todd Showalter ran `evtest` on an Xbox pad, an Xbox 360 pad and a PS3 pad and [posted the results to wayland-devel](https://lists.freedesktop.org/archives/wayland-devel/2013-April/008790.html). The two Xbox pads reported `A B X Y`. The PS3 pad shared "not a single button in common" with them, "despite the PS3 controller having buttons physically labelled 'start' and 'select'". A game that wanted a jump button and a shoot button had to know which pad was plugged in.

## The decision

In June, David Herrmann sent the fix. The commit message opens:

> Until today all gamepad input drivers report their data differently. It is nearly impossible to write applications for more than one device in a generic way. Therefore, this patch introduces a uniform gamepad API which will be used for all new drivers.
>
> Instead of mapping buttons by their labels, we now map them by position. [...]

The labels differ between vendors (Xbox has A/B/X/Y, PlayStation has Cross/Circle/Square/Triangle, Nintendo has its own A/B/X/Y), but on most pads the four buttons sit in a diamond. So the spec names them by compass point:

```
                 ┌──────────────┐
                 │  BTN_NORTH   │
                 └──────────────┘
 ┌──────────────┐                ┌──────────────┐
 │  BTN_WEST    │                │  BTN_EAST    │
 └──────────────┘                └──────────────┘
                 ┌──────────────┐
                 │  BTN_SOUTH   │
                 └──────────────┘
```

The patch ([`d09bbfd2a840`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d09bbfd2a8408a995419dff0d2ba906013cf4cc9)) added these four names as aliases with the same numeric values as the existing `BTN_A`, `BTN_B`, `BTN_X` and `BTN_Y`, so existing programs kept working:

| Position | Code | Old name |
|----------|------|----------|
| South | `BTN_SOUTH` (0x130) | `BTN_A` |
| East | `BTN_EAST` (0x131) | `BTN_B` |
| North | `BTN_NORTH` (0x133) | `BTN_X` |
| West | `BTN_WEST` (0x134) | `BTN_Y` |

Dmitry Torokhov acked the patch but [asked for the definitions to be flipped](https://lkml.iu.edu/hypermail/linux/kernel/1306.3/03524.html) "so that it is clear that BTN_A, BTN_B, etc are legacy definitions and not an accidental typos that need their own key codes". Jiri Kosina made the change the next day in [`701ba533f658`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=701ba533f6587aaf402a9bb732548503263d2b23). The header today defines `BTN_SOUTH` as the number and `BTN_A` as `BTN_SOUTH`.

## What the spec does not do

The spec does not rewrite existing drivers. [`gamepad.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/input/gamepad.rst) says so:

> Legacy drivers often don't comply to these rules. As we cannot change them for backwards-compatibility reasons, you need to provide fixup mappings in user-space yourself.

So what a pad reports depends on which driver handles it:

| Driver | Reports | Result |
|--------|---------|--------|
| `hid-playstation`, `hid-sony` | Cross `BTN_SOUTH`, Circle `BTN_EAST`, Square `BTN_WEST`, Triangle `BTN_NORTH` | By position |
| `hid-nintendo` (Pro Controller, Joy-Con, SNES) | A `BTN_EAST`, B `BTN_SOUTH`, X `BTN_NORTH`, Y `BTN_WEST` | By position |
| `xpad` | A `BTN_A`, B `BTN_B`, X `BTN_X`, Y `BTN_Y` | By label |
| `hid-steam` | `BTN_A`, `BTN_B`, `BTN_X`, `BTN_Y` | By label |

The same `hid-nintendo` driver has other tables that don't follow the rule: its NES table puts A on `BTN_SOUTH`, and its N64 table uses `BTN_A` and `BTN_B`.

`xpad` is where the opening question comes from. It dates from 2002, eleven years before the spec, and reports each Xbox button under the letter printed on it. A and B land on the right positions, since `BTN_A` is south and `BTN_B` is east. X and Y don't: the Xbox X is on the left but `BTN_X` is `BTN_NORTH`, and the Xbox Y is on top but `BTN_Y` is `BTN_WEST`.

The same two codes line up with a Nintendo layout instead. On a Switch controller, X is on top and Y is on the left, and `hid-nintendo` reports them as `BTN_NORTH` and `BTN_WEST`. So the legacy letter codes behave like Xbox for A/B and like Nintendo for X/Y. The sources don't say why the pre-2013 codes were laid out this way. What the 2013 patch did was put `BTN_NORTH` on the value of `BTN_X` and `BTN_WEST` on the value of `BTN_Y`, and that aliasing is what puts `xpad`'s X and Y at the wrong compass points.

## Why nobody fixes it

The reason is the one the spec gives: changing a mapping breaks userspace. It came up in 2022, when a patch tried to move `hid-nintendo` to the Xbox layout. Roderick Colenbrander, who maintains the PlayStation HID driver, [replied](https://lkml.iu.edu/hypermail/linux/kernel/2205.1/08436.html):

> The standard which this driver (as well as others such as hid-sony/hid-playstation) follow is the Linux gamepad standard (see Documentation/input/gamepad.rst). It stays away of the debate what is A/B/X/Y.

and on merging a different mapping:

> a changed mapping breaks user spaces and in general can't do this unless there is a really good reason. It just would break existing applications and libraries (often e.g. SDL)

He also noted, in parentheses, that one could argue the Xbox controller "should be flipped as it was the SNES controller back in the days which introduced X/Y". The patch author then asked for an opt-in module parameter instead. Colenbrander [declined that too](https://lkml.iu.edu/hypermail/linux/kernel/2205.1/09033.html), since it "essentially adds new kernel APIs, which have to be maintained unless truly needed", and pointed to the HID-BPF work then in progress as a way to do such fixups.

## What this means in practice

- A `BTN_*` face-button code means the same physical position only on drivers written to the spec. A program that wants "the Xbox Y button" can't assume that from the code alone.
- The spec is explicit that the codes are not labels: "Regardless of the labels on the buttons, the codes are sent according to the physical position of the buttons."
- Where a driver doesn't follow the spec, the fix-up lives in userspace, as `gamepad.rst` says. The spec says legacy mappings can't change, so `xpad` still reports by label.

## Further reading

### Kernel source

- [`include/uapi/linux/input-event-codes.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/input-event-codes.h) — the `BTN_SOUTH` / `BTN_A` definitions
- [`Documentation/input/gamepad.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/input/gamepad.rst) — the spec, including the legacy-driver paragraph
- [`drivers/input/joystick/xpad.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/input/joystick/xpad.c) — Xbox pads, reporting by label; first added in July 2002 ([history.git log](https://git.kernel.org/pub/scm/linux/kernel/git/tglx/history.git/log/drivers/usb/input/xpad.c))
- [`drivers/hid/hid-playstation.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/hid/hid-playstation.c) · [`drivers/hid/hid-nintendo.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/hid/hid-nintendo.c) — drivers that report by position

### Commits and threads

- [`d09bbfd2a840`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d09bbfd2a8408a995419dff0d2ba906013cf4cc9) — input: document gamepad API and add extra keycodes (2013)
- [`701ba533f658`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=701ba533f6587aaf402a9bb732548503263d2b23) — Input: make gamepad API keycodes more clear (2013)
- [Input and games (wayland-devel, April 2013)](https://lists.freedesktop.org/archives/wayland-devel/2013-April/008790.html) — the cross-device inconsistency report
- [Review of the 2013 patch](https://lkml.iu.edu/hypermail/linux/kernel/1306.3/03524.html) — Herrmann's reply quoting Torokhov's ack and Kosina's agreement
- [HID: nintendo: fix face button mappings (May 2022)](https://lkml.iu.edu/hypermail/linux/kernel/2205.1/08436.html) — the reply explaining why mappings stay

### Related pages

- [Input Subsystem: evdev and the Input Core](README.md) — event types and codes
- [HID: the Human Interface Device layer](hid.md) — the layer `hid-playstation`, `hid-nintendo` and `hid-steam` sit on

### External

- [Kernel docs: Linux Gamepad Specification](https://docs.kernel.org/input/gamepad.html)
