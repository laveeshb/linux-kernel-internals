# Device Drivers

> How hardware becomes accessible to userspace

## Overview

Device drivers bridge hardware and the rest of the kernel. The Linux driver model organizes this with:

- **Devices** (`struct device`) — represent hardware or logical devices
- **Buses** (`struct bus_type`) — communication channel (PCI, USB, I2C, platform)
- **Drivers** (`struct device_driver`) — code that handles a specific device
- **Classes** (`struct class`) — groups of devices with similar behavior (e.g., "input", "net")

```
sysfs (/sys/bus/pci/devices/0000:00:1f.2)
         │
         ▼
struct device ←────── struct pci_dev (bus-specific extension)
         │
    bus_type.match()
         │
         ▼
struct device_driver ←── struct pci_driver (driver-specific extension)
         │
    driver.probe()
         │
         ▼
    Hardware
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Linux Device Model](device-model.md) | struct device, bus, driver, kobject, sysfs |
| [Platform Drivers](platform-driver.md) | Platform bus, probe/remove, devm_, device tree |
| [Character and Misc Devices](chardev.md) | cdev, file_operations, ioctl, mmap from driver side |
| [PCI Drivers](pci-driver.md) | Enumeration, config space, BARs, MSI setup |
| [I2C and SPI](i2c-spi.md) | Slow-bus drivers, regmap, device addressing |
| [Device Tree](device-tree.md) | Hardware description for non-discoverable buses |

## Quick reference

```bash
# List all devices and their drivers
ls /sys/bus/pci/devices/
ls /sys/bus/platform/devices/

# See driver for a device
cat /sys/bus/pci/devices/0000:00:1f.2/driver/module/name

# Load a kernel module
modprobe e1000e
lsmod | grep e1000

# Bind/unbind a driver manually
echo "0000:00:1f.2" > /sys/bus/pci/drivers/ahci/unbind
echo "0000:00:1f.2" > /sys/bus/pci/drivers/ahci/bind

# Character device major/minor
ls -la /dev/null /dev/random
# crw-rw-rw- 1 root root 1, 3 ... /dev/null  ← major=1, minor=3
```
