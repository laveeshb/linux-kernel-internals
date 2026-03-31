# Kbuild: The Kernel Build System

> Makefiles, Kconfig, out-of-tree modules, and cross-compilation

## Overview

The kernel build system (Kbuild) is built on top of GNU Make. It uses a hierarchy of `Makefile` fragments across the source tree and a powerful configuration language (Kconfig):

```
make menuconfig    → generates .config (symbol definitions)
make               → compiles kernel using .config
make modules_install → installs modules to /lib/modules/$(uname -r)/
```

## .config: kernel configuration

```bash
# Start fresh from a default config:
make defconfig          # minimal config for current arch
make allmodconfig       # enable everything as modules
make allyesconfig       # enable everything built-in
make localmodconfig     # minimal config matching currently loaded modules

# Interactive config tools:
make menuconfig         # text-based menu (requires ncurses-dev)
make xconfig            # Qt GUI
make gconfig            # GTK GUI
make nconfig            # newer ncurses UI

# Use existing config as base:
cp /boot/config-$(uname -r) .config
make olddefconfig        # accept defaults for new symbols

# Minimal config for compiling a specific driver:
make randconfig         # random config (for testing)
```

### Config file format

```bash
# .config format: each CONFIG_SYMBOL has one of:
CONFIG_SMP=y          # built-in (y = yes)
CONFIG_MODULES=y      # required for loadable modules
CONFIG_EXT4_FS=m      # built as module
# CONFIG_NFS_FS is not set   # disabled

# Query a symbol:
./scripts/config --state CONFIG_SMP
# y

# Set a symbol:
./scripts/config --enable CONFIG_DEBUG_INFO
./scripts/config --disable CONFIG_SWAP
./scripts/config --module CONFIG_EXT4_FS
./scripts/config --set-val CONFIG_LOG_BUF_SHIFT 18
```

## Kconfig language

```kconfig
# drivers/net/ethernet/intel/Kconfig

config E1000
    tristate "Intel(R) PRO/1000 Gigabit Ethernet support"
    depends on PCI
    help
      This driver supports Intel(R) PRO/1000 gigabit ethernet family of
      adapters.  For more information on how to identify your adapter, go
      to the Adapter & Driver ID Guide at:
      <http://support.intel.com/support/go/network/adapter/home.htm>

config E1000E
    tristate "Intel(R) PRO/1000 PCI-Express Gigabit Ethernet support"
    depends on PCI && (!SPARC32)
    select PTP_1588_CLOCK
    default y if X86
    help
      ...

# Types:
# bool:     y or n
# tristate: y, m (module), or n
# string:   CONFIG_DEFAULT_HOSTNAME="(none)"
# int:      CONFIG_LOG_BUF_SHIFT=18
# hex:      CONFIG_PAGE_OFFSET=0xC0000000

# Dependencies:
# depends on A && B    → both A and B must be y/m
# depends on A || B    → at least one
# depends on !A        → A must not be set
# select A             → force-enable A (ignores depends)
# imply A              → suggest enabling A (can be overridden)
```

## Kbuild Makefiles

Each directory has a `Makefile` that tells Kbuild what to compile:

```makefile
# drivers/net/ethernet/intel/e1000/Makefile

# obj-$(CONFIG_E1000): 'y' → built-in, 'm' → module, unset → skip
obj-$(CONFIG_E1000) += e1000.o

# e1000.o is built from multiple source files:
e1000-objs := e1000_main.o e1000_hw.o e1000_ethtool.o e1000_param.o

# Subdirectories:
obj-y += subdirname/
# → recurse into subdirname/Makefile
```

### Top-level build flow

```
make
├── scripts/Makefile.build: recurse into each subdirectory
├── Each Makefile: contributes obj-y, obj-m to the build
├── vmlinux: link all obj-y into the kernel binary
└── modules: compile all obj-m into .ko files
```

## Building an out-of-tree module

```makefile
# Makefile for external module (hello_module.c):
obj-m := hello_module.o

KDIR ?= /lib/modules/$(shell uname -r)/build
PWD  := $(shell pwd)

all:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean

install:
	$(MAKE) -C $(KDIR) M=$(PWD) modules_install
```

```bash
# Build the module:
make

# Install (copies to /lib/modules/$(uname -r)/extra/):
sudo make install
sudo depmod -a       # update module dependency database

# Load:
modprobe hello_module
```

### Multiple source files

```makefile
obj-m := mydriver.o
mydriver-objs := main.o helper.o init.o
# Builds main.o, helper.o, init.o and links into mydriver.ko
```

## Cross-compilation

```bash
# Cross-compile for ARM64 on x86-64 host:
export ARCH=arm64
export CROSS_COMPILE=aarch64-linux-gnu-

make defconfig      # uses arch/arm64/configs/defconfig
make -j$(nproc)

# The CROSS_COMPILE prefix is prepended to:
# ${CROSS_COMPILE}gcc, ${CROSS_COMPILE}ld, etc.

# For Raspberry Pi (armv7):
export ARCH=arm
export CROSS_COMPILE=arm-linux-gnueabihf-
make bcm2711_defconfig
make -j$(nproc)

# Out-of-tree module cross-compilation:
make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- \
     KDIR=/path/to/arm64-kernel-build M=$(PWD) modules
```

## Compiler options and build flags

```makefile
# Add compilation flags:
ccflags-y += -DDEBUG_MODE
ccflags-y += -I$(src)/include   # $(src) = directory of this Makefile

# Per-file flags:
CFLAGS_hello_module.o += -DTEST_BUILD

# Disable warnings:
CFLAGS_my_file.o += -w
```

```bash
# Build with debugging info (for KGDB, crash analysis):
make CONFIG_DEBUG_INFO=y

# Build with address sanitizer:
make CONFIG_KASAN=y

# Enable compile-time warnings:
make W=1        # extra warnings
make W=2        # more extra warnings
make W=3        # all warnings
make C=1        # sparse static analysis
make C=2        # sparse for all files

# Check build dependencies:
make htmldocs   # build kernel documentation
```

## depmod and module dependencies

```bash
# modules.dep: dependency database for modprobe:
depmod -a     # generate for current kernel
depmod -a 5.15.0  # for specific kernel version

# View module dependencies:
modinfo -F depends virtio_net
# virtio,net_failover

# modprobe automatically loads dependencies:
modprobe virtio_net
# Loads: virtio, net_failover, then virtio_net

# Manual depmod output:
cat /lib/modules/$(uname -r)/modules.dep | grep virtio_net
# kernel/drivers/net/virtio_net.ko: kernel/drivers/virtio/virtio.ko ...
```

## Build artifacts

```bash
# After make:
# Top-level build directory:
# vmlinux       ← uncompressed ELF kernel (for debugging)
# System.map    ← symbol table (addresses)
ls arch/x86/boot/
# bzImage       ← bootable compressed kernel

# Module signature (if CONFIG_MODULE_SIG_ALL=y):
modinfo drivers/net/ethernet/intel/e1000/e1000.ko | grep sig
# sig_id: PKCS#7
# sig_hashalgo: sha256

# Symbols a module exports:
nm --defined-only drivers/net/ethernet/intel/e1000/e1000.ko | grep " T "
# Only text (function) symbols defined in the module

# Check what a module provides and needs:
modinfo drivers/net/ethernet/intel/e1000/e1000.ko
# filename: ...
# license: GPL v2
# description: Intel(R) PRO/1000 Network Driver
# author: ...
# depends: ptp
# vermagic: 6.1.0-17-amd64 SMP preempt mod_unload modversions

# vermagic: must match running kernel exactly
```

## Useful build targets

```bash
make -j$(nproc)             # parallel build
make bzImage                # kernel image only
make modules                # modules only
make modules_install         # install modules to /lib/modules/
make install                 # install kernel image + System.map

# Single file:
make drivers/net/ethernet/intel/e1000/e1000.o

# Single module:
make drivers/net/ethernet/intel/e1000/e1000.ko

# Header dependency check:
make headers_check

# Clean:
make clean     # remove build artifacts (keep .config)
make mrproper  # remove everything including .config
make distclean # mrproper + patches
```

## Further reading

- [Writing and Loading Modules](module-basics.md) — module init/exit
- [Module Signing](module-signing.md) — signing out-of-tree modules
- [KGDB](../debugging/kgdb.md) — debugging requires debug symbols
- `Documentation/kbuild/` — Kbuild documentation
- `scripts/kconfig/` — Kconfig implementation
