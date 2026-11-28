# Gamepad Buttons: Position, Not Label

> Why the kernel names a gamepad's face buttons by where they sit, and why some drivers still report them by label

## The question people ask

Plug in an Xbox controller over USB (the `xpad` driver) and press **Y**, the button at the top of the diamond. The kernel reports code 0x134, which the header names `BTN_WEST`. Press **X**, the button on the left, and it comes out as 0x133, `BTN_NORTH`. Both look backwards. The kernel's own [gamepad specification](https://docs.kernel.org/input/gamepad.html) says buttons are reported by physical position, and the Xbox driver doesn't do that.

The spec and the driver disagree because of a 2013 decision that was meant for new drivers and was not forced on existing ones.

## The problem in 2013

In April 2013 Todd Showalter ran `evtest` on an Xbox pad, an Xbox 360 pad and a PS3 pad and [posted the results to wayland-devel](https://lists.freedesktop.org/archives/wayland-devel/2013-April/008790.html). The two Xbox pads reported `A B X Y`. The PS3 pad shared "not a single button in common" with them, "despite the PS3 controller having buttons physically labelled 'start' and 'select'". A game that wanted a jump button and a shoot button had to know which pad was plugged in.

## The decision

In June, David Herrmann posted the patch that was merged. The commits credit Showalter with `Reported-by`. The message opens:

> Until today all gamepad input drivers report their data differently. It is nearly impossible to write applications for more than one device in a generic way. Therefore, this patch introduces a uniform gamepad API which will be used for all new drivers.
>
> Instead of mapping buttons by their labels, we now map them by position. [...]

The labels differ between vendors (Xbox has A/B/X/Y, PlayStation has Cross/Circle/Square/Triangle, Nintendo has its own A/B/X/Y), but the spec's model gamepad has four buttons in a diamond. So the spec names them by compass point. The Switch row is the original Switch, and SDL's [gamepad header](https://github.com/libsdl-org/SDL/blob/release-3.2.0/include/SDL3/SDL_gamepad.h) documents the same positions for all three families:

```
                 ┌───────────────┐
                 │   BTN_NORTH   │
                 │     Xbox Y    │
                 │  PS Triangle  │
                 │    Switch X   │
                 └───────────────┘
┌───────────────┐                 ┌───────────────┐
│    BTN_WEST   │                 │    BTN_EAST   │
│     Xbox X    │                 │     Xbox B    │
│   PS Square   │                 │   PS Circle   │
│    Switch Y   │                 │    Switch A   │
└───────────────┘                 └───────────────┘
                 ┌───────────────┐
                 │   BTN_SOUTH   │
                 │     Xbox A    │
                 │    PS Cross   │
                 │    Switch B   │
                 └───────────────┘
```

The patch was applied as two commits with the same subject: [`d09bbfd2a840`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d09bbfd2a8408a995419dff0d2ba906013cf4cc9) for the header and [`6e0fe2e5723c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=6e0fe2e5723cec36eb24959dd99a16e445816a6a) for the spec text. The header change added these four names as aliases with the same numeric values as the existing `BTN_A`, `BTN_B`, `BTN_X` and `BTN_Y`, so existing programs kept working:

| Position | Code | Old name |
|----------|------|----------|
| South | `BTN_SOUTH` (0x130) | `BTN_A` |
| East | `BTN_EAST` (0x131) | `BTN_B` |
| North | `BTN_NORTH` (0x133) | `BTN_X` |
| West | `BTN_WEST` (0x134) | `BTN_Y` |

Dmitry Torokhov acked the patch but [asked for the definitions to be flipped](https://lkml.iu.edu/hypermail/linux/kernel/1306.3/02232.html) "so that it is clear that BTN_A, BTN_B, etc are legacy definitions and not an accidental typos that need their own key codes". Jiri Kosina made the change the next day in [`701ba533f658`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=701ba533f6587aaf402a9bb732548503263d2b23). The header today defines `BTN_SOUTH` as the number and `BTN_A` as `BTN_SOUTH`.

## What the spec does not do

The spec does not rewrite existing drivers. [`gamepad.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/input/gamepad.rst) says so:

> Legacy drivers often don't comply to these rules. As we cannot change them for backwards-compatibility reasons, you need to provide fixup mappings in user-space yourself. Some of them might also provide module-options that change the mappings so you can advise users to set these.

So what a pad reports depends on which driver handles it:

| Driver | Reports | Result |
|--------|---------|--------|
| `hid-playstation`, `hid-sony` | Cross `BTN_SOUTH`, Circle `BTN_EAST`, Square `BTN_WEST`, Triangle `BTN_NORTH` | By position |
| `hid-nintendo` (Switch 1 Pro Controller and Joy-Con, SNES) | A `BTN_EAST`, B `BTN_SOUTH`, X `BTN_NORTH`, Y `BTN_WEST` | By position |
| `xpad` | A `BTN_A`, B `BTN_B`, X `BTN_X`, Y `BTN_Y` | By label |
| `hid-steam` (added 2018) | `BTN_A`, `BTN_B`, `BTN_X`, `BTN_Y` | By label |

Other tables in the same driver differ. The NES table puts A on `BTN_SOUTH` and B on `BTN_EAST`, and the N64 table uses `BTN_A` and `BTN_B`, the same codes. The Switch 2 tables, added in 2026, also put A on `BTN_SOUTH` and B on `BTN_EAST`, where the Switch 1 tables above have A on `BTN_EAST` and B on `BTN_SOUTH`. X stays on `BTN_NORTH` and Y on `BTN_WEST`.

`gamepad.rst` says all new gamepads are "supposed to" comply with the mapping and asks for bug reports when they don't.

`xpad` is where the opening question comes from. It dates from 2002, eleven years before the spec, and reports each Xbox button under the letter printed on it. A and B land on the right positions, since `BTN_A` is south and `BTN_B` is east. X and Y don't: the Xbox X is on the left but `BTN_X` is `BTN_NORTH`, and the Xbox Y is on top but `BTN_Y` is `BTN_WEST`.

The same two codes line up with a Nintendo layout instead. On a Switch controller, X is on top and Y is on the left, and `hid-nintendo` reports them as `BTN_NORTH` and `BTN_WEST`. The 2013 aliases paired `BTN_X` with north and `BTN_Y` with west, and that pairing is what puts `xpad`'s X and Y at compass points that don't match the Xbox layout.

## Why mappings rarely change

The reason is the one the spec gives: changing a mapping breaks userspace. Mappings have been changed before. In 2016 and 2017 Roderick Colenbrander moved the DualShock 4 and DualShock 3 in `hid-sony` to the spec ([`9131f8cc2b4e`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=9131f8cc2b4eaf7c08d402243429e0bfba9aa0d6), [`e19a267b9987`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=e19a267b9987135c00155a51e683e434b9abb56b)). For the DS4, SDL2's controller database is keyed on vendor, device and version, so the commit says "In order to not break SDL2 we discussed adjusting the version number, so it can have both mappings".

In 2022 a patch tried to swap X and Y on `hid-nintendo` so they "match the Xbox layout". Colenbrander, who made the `hid-sony` change above, [replied](https://lkml.iu.edu/hypermail/linux/kernel/2205.1/08436.html) with two objections. The first:

> The standard which this driver (as well as others such as hid-sony/hid-playstation) follow is the Linux gamepad standard (see Documentation/input/gamepad.rst). It stays away of the debate what is A/B/X/Y.

and the second:

> a changed mapping breaks user spaces and in general can't do this unless there is a really good reason. It just would break existing applications and libraries (often e.g. SDL)

He added that one could argue the Xbox controller "should be flipped as it was the SNES controller back in the days which introduced X/Y". The series' second patch added a module parameter to swap the buttons, and the author asked whether that opt-in part could still be merged. Colenbrander [argued against that too](https://lkml.iu.edu/hypermail/linux/kernel/2205.1/09033.html): it "essentially adds new kernel APIs, which have to be maintained unless truly needed". He suggested that the HID-BPF work then in progress could "probably" allow a similar fixup without changing the kernel module.

## What this means in practice

- A `BTN_*` face-button code means the same physical position only on drivers written to the spec. A program that wants the top button can't get it from the code alone.
- Where a driver reports by label, the fix-up lives in userspace, as `gamepad.rst` says. `xpad` still reports by label.

## Further reading

### Kernel source

- [`include/uapi/linux/input-event-codes.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/input-event-codes.h) — the `BTN_SOUTH` / `BTN_A` definitions
- [`Documentation/input/gamepad.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/input/gamepad.rst) — the spec, including the legacy-driver paragraph
- [`drivers/input/joystick/xpad.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/input/joystick/xpad.c) — Xbox pads, reporting by label; first added in 2002 ([history.git log](https://git.kernel.org/pub/scm/linux/kernel/git/tglx/history.git/log/drivers/usb/input/xpad.c))
- [`drivers/hid/hid-playstation.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/hid/hid-playstation.c) · [`drivers/hid/hid-nintendo.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/hid/hid-nintendo.c) — `hid-playstation` reports by position; `hid-nintendo` does for the Switch 1 pads

### Commits and threads

- [`d09bbfd2a840`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d09bbfd2a8408a995419dff0d2ba906013cf4cc9) · [`6e0fe2e5723c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=6e0fe2e5723cec36eb24959dd99a16e445816a6a) — input: document gamepad API and add extra keycodes (2013): the header and the spec text
- [`701ba533f658`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=701ba533f6587aaf402a9bb732548503263d2b23) — Input: make gamepad API keycodes more clear (2013)
- [Input and games (wayland-devel, April 2013)](https://lists.freedesktop.org/archives/wayland-devel/2013-April/008790.html) — the cross-device inconsistency report
- [Torokhov's review of the 2013 patch](https://lkml.iu.edu/hypermail/linux/kernel/1306.3/02232.html) — the ack and the alias-order request; [Herrmann's reply](https://lkml.iu.edu/hypermail/linux/kernel/1306.3/03524.html) quotes it with Kosina's agreement
- [`9131f8cc2b4e`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=9131f8cc2b4eaf7c08d402243429e0bfba9aa0d6) · [`e19a267b9987`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=e19a267b9987135c00155a51e683e434b9abb56b) — hid-sony moves the DS4 and DS3 to the spec (2016, 2017)
- [HID: nintendo: fix face button mappings (May 2022)](https://lkml.iu.edu/hypermail/linux/kernel/2205.1/08436.html) — the reply explaining why mappings stay

### Related pages

- [Input Subsystem: evdev and the Input Core](README.md) — event types and codes
- [HID: the Human Interface Device layer](hid.md) — the layer `hid-playstation`, `hid-nintendo` and `hid-steam` sit on

### External

- [Kernel docs: Linux Gamepad Specification](https://docs.kernel.org/input/gamepad.html)
- [SDL3 `SDL_gamepad.h`](https://github.com/libsdl-org/SDL/blob/release-3.2.0/include/SDL3/SDL_gamepad.h) — documents the south/east/west/north face-button positions for Xbox, Switch and PlayStation pads
