# Devices & Drivers

How the kernel discovers hardware, binds drivers to it, and exposes the big device classes — buses, peripherals, and the frameworks that make them look uniform to user space.

- [Drivers (drivers/)](../drivers/README.md) — the device model and how drivers bind to hardware (buses, PCI, device tree, platform, I2C/SPI)
- [USB (usb/)](../usb/README.md) — the host-scheduled, hot-pluggable peripheral bus: descriptors, endpoints, and URBs
- [GPU / DRM (drm/)](../drm/README.md) — the graphics and display stack: KMS modesetting, GEM buffers, and command submission
- [Audio / ALSA (alsa/)](../alsa/README.md) — the sound subsystem: the card/PCM/control object model, the ring-buffer data path, and ASoC for embedded audio
- [Input / HID (input/)](../input/README.md) — the input core, evdev, and the self-describing HID report-descriptor protocol
- [TTY / Serial (tty/)](../tty/README.md) — the teletypewriter-derived terminal model: line disciplines, serial core/UART drivers, and pseudo-terminals
