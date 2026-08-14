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
make defconfig          # the arch's default config (arch/$SRCARCH/configs/)
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

# Randomized config, for build-testing wide swathes of the tree:
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

# Set a symbol (pick one that actually has a prompt — see the note under
# "Compiler options and build flags" about promptless symbols):
./scripts/config --enable CONFIG_DEBUG_KERNEL
./scripts/config --disable CONFIG_SWAP
./scripts/config --module CONFIG_EXT4_FS
./scripts/config --set-val CONFIG_LOG_BUF_SHIFT 18
```

## Kconfig language

```kconfig
# drivers/net/ethernet/intel/Kconfig

config E1000
    tristate "Intel(R) PRO/1000 Gigabit Ethernet support"
    depends on PCI && HAS_IOPORT
    help
      This driver supports Intel(R) PRO/1000 gigabit ethernet family of
      adapters.  For more information on how to identify your adapter, go
      to the Adapter & Driver ID Guide that can be located at:

      <http://support.intel.com>
      ...

config E1000E
    tristate "Intel(R) PRO/1000 PCI-Express Gigabit Ethernet support"
    depends on PCI && (!SPARC32 || BROKEN)
    depends on PTP_1588_CLOCK_OPTIONAL
    select CRC32
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
e1000-y := e1000_main.o e1000_hw.o e1000_ethtool.o e1000_param.o

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

# Install (copies to /lib/modules/$(uname -r)/updates/, the default
# INSTALL_MOD_DIR for external modules):
sudo make install
sudo depmod -a       # update module dependency database

# Load:
modprobe hello_module
```

### Multiple source files

```makefile
obj-m := mydriver.o
mydriver-y := main.o helper.o init.o
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

# For 32-bit ARM (e.g. Raspberry Pi 2/3, armv7):
export ARCH=arm
export CROSS_COMPILE=arm-linux-gnueabihf-
make multi_v7_defconfig   # arch/arm/configs/; includes CONFIG_ARCH_BCM2835
make -j$(nproc)

# Out-of-tree module cross-compilation (invoke kbuild directly: -C points at
# the prepared kernel build tree, M= at the module source directory):
make -C /path/to/arm64-kernel-build M=$PWD \
     ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- modules
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
# CONFIG_* symbols come from .config (via include/config/auto.conf), not
# from the make command line — setting them there is not how kbuild works.
# Edit .config, then re-resolve the new symbols:

# Build with debugging info (for KGDB, crash analysis). CONFIG_DEBUG_INFO
# itself has no prompt — it is selected by the "Debug information" choice,
# so enable a choice entry instead. That choice is itself
# `depends on DEBUG_KERNEL`, which has no default, so enable DEBUG_KERNEL
# first or olddefconfig will silently drop the DWARF selection too:
./scripts/config --enable CONFIG_DEBUG_KERNEL
./scripts/config --enable CONFIG_DEBUG_INFO_DWARF_TOOLCHAIN_DEFAULT
make olddefconfig && make -j$(nproc)

# Build with address sanitizer:
./scripts/config --enable CONFIG_KASAN
make olddefconfig && make -j$(nproc)

# Enable compile-time warnings. The levels are independent, not cumulative:
# each is gated by its own findstring test on KBUILD_EXTRA_WARN, so W=3
# enables only the level-3 warnings, not levels 1 and 2 as well.
make W=1        # relevant warnings that do not occur too often
make W=2        # warnings that occur quite often but may still be relevant
make W=3        # more obscure warnings, can most likely be ignored
make W=123      # combine all three (W=12, W=13, ... work the same way)
make C=1        # sparse static analysis
make C=2        # sparse for all files

# Documentation:
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
# Loads whichever of virtio_net's dependencies are themselves modules
# (here virtio, net_failover) before virtio_net. Which ones those are is
# config-dependent: CONFIG_VIRTIO_NET selects NET_FAILOVER, DIMLIB and
# PAGE_POOL and depends on VIRTIO. NET_FAILOVER and DIMLIB are tristate and
# so may be modules; PAGE_POOL is a plain bool and is always built in.

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

# Module signature. Signing is not part of the build: `make` leaves the .ko
# in the build tree unsigned. scripts/Makefile.modinst signs modules during
# `make modules_install` (when CONFIG_MODULE_SIG_ALL=y) or `make modules_sign`,
# so inspect the *installed* copy:
modinfo /lib/modules/$(uname -r)/kernel/drivers/net/ethernet/intel/e1000/e1000.ko | grep sig
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
# vermagic: 7.2.0-rc7 SMP preempt mod_unload modversions

# vermagic: must match the running kernel exactly — except that with
# CONFIG_MODVERSIONS the leading release string is skipped and only the
# trailing flags are compared (same_magic() in kernel/module/version.c)
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

# Export sanitised UAPI headers (the old `headers_check` target was
# removed in v5.17; CONFIG_UAPI_HEADER_TEST compile-tests them instead):
make headers_install

# Clean:
make clean     # remove build artifacts (keep .config)
make mrproper  # remove everything including .config
make distclean # mrproper + editor/tag leftovers: *.orig, *.rej, *~, *.bak,
               # #*#, *%, core, tags/TAGS, cscope*, GPATH/GRTAGS/GSYMS/GTAGS
```

## Further reading

### Kernel source

- [Makefile](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Makefile) — the top-level build driver: the `W=1`/`W=2`/`W=3` warning levels and `C=1`/`C=2` sparse checking, the `ARCH`/`CROSS_COMPILE` handling, and the `clean`/`mrproper`/`distclean` targets listed above
- [scripts/Makefile.build](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/Makefile.build) — the per-directory recursion engine that reads each `Makefile`'s `obj-y`/`obj-m` lists and descends into `obj-y += subdir/`
- [scripts/Makefile.lib](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/Makefile.lib) — expands composite objects (the `<module>-y` / `<module>-objs` suffix search) and assembles the per-file flags `ccflags-y`, `asflags-y`, and `CFLAGS_<file>.o`
- [scripts/Makefile.modinst](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/Makefile.modinst) — the `modules_install` rules; note `INSTALL_MOD_DIR ?= updates`, the default install subdirectory for external modules since [commit b74d7bb7ca24](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b74d7bb7ca2412ab37bab782591573b5f265872b) ("kbuild: Modify default INSTALL_MOD_DIR from extra to updates", v6.3)
- [scripts/kconfig/](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/kconfig) — the Kconfig implementation: `lexer.l` and `parser.y` parse the language shown above, `mconf.c`/`nconf.c`/`qconf.cc`/`gconf.c` are the programs behind `menuconfig`/`nconfig`/`xconfig`/`gconfig`, and `streamline_config.pl` implements `localmodconfig`
- [scripts/config](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/config) — the shell script implementing the `--state`/`--enable`/`--disable`/`--module`/`--set-val` `.config` edits used above

### Man pages

- [`modprobe(8)`](https://man7.org/linux/man-pages/man8/modprobe.8.html) — dependency-aware module loading, `-r`, and module parameters on the command line
- [`depmod(8)`](https://man7.org/linux/man-pages/man8/depmod.8.html) — generates `modules.dep` and the map files; `-a`, `-b basedir`, and the optional `version` argument
- [`modules.dep(5)`](https://man7.org/linux/man-pages/man5/modules.dep.5.html) — the format of `modules.dep`/`modules.dep.bin`, the dependency database `modprobe` consults
- [`modinfo(8)`](https://man7.org/linux/man-pages/man8/modinfo.8.html) — `-F field` extraction of `depends`, `vermagic`, `sig_id`, and the other `.modinfo` fields shown above

### Related pages

- [Writing and Loading Kernel Modules](module-basics.md) — module init/exit, the source-to-`.ko` lifecycle these Makefiles drive
- [Module Loading Internals](module-loading-internals.md) — what the kernel does with the `.ko` afterwards: ELF parsing, relocation, and the `vermagic`/modversions checks
- [Module Parameters, Symbols, and Kconfig](module-params.md) — `module_param()`, symbol export, and how Kconfig symbols reach module code
- [Kernel Module Signing](module-signing.md) — `CONFIG_MODULE_SIG_ALL` and signing out-of-tree modules
- [KGDB: Kernel GDB Debugger](../debugging/kgdb.md) — the consumer of the debug-info builds described above

### LWN articles

- [How many ways are there to configure the Linux kernel?](https://lwn.net/Articles/1034811/) — Daroc Alden, September 10, 2025: 32,468 Kconfig options on x86_64 in 6.16, and what `depends on`/`select` constraints do to the space of valid configurations
- [A kbuild and kconfig maintainer change](https://lwn.net/Articles/1032722/) — August 6, 2025: Masahiro Yamada steps down after eight years; kbuild moves to "odd fixes" under Nathan Chancellor and Nicolas Schier, and Kconfig is left unmaintained

### External

- [Kernel Build System](https://docs.kernel.org/kbuild/index.html) — index of the upstream `Documentation/kbuild/` set
- [Linux Kernel Makefiles](https://docs.kernel.org/kbuild/makefiles.html) — the authoritative reference for `obj-y`/`obj-m`, composite objects via `<module>-y`, `ccflags-y`/`subdir-ccflags-y`, and `$(src)`/`$(obj)`
- [Building External Modules](https://docs.kernel.org/kbuild/modules.html) — the `make -C $KDIR M=$PWD modules` pattern, `KBUILD_EXTRA_SYMBOLS`, and where `modules_install` puts external modules
- [Kconfig Language](https://docs.kernel.org/kbuild/kconfig-language.html) — `bool`/`tristate`/`string`/`int`/`hex` types and the exact semantics of `depends on`, `select`, and `imply`
- [Configuration targets and editors](https://docs.kernel.org/kbuild/kconfig.html) — the `menuconfig`/`nconfig`/`xconfig`/`gconfig` front-ends and the `KCONFIG_CONFIG`, `KCONFIG_ALLCONFIG`, and `KCONFIG_SEED` environment variables
- [Kbuild](https://docs.kernel.org/kbuild/kbuild.html) — build-time environment variables: `KBUILD_OUTPUT`/`O=`, `KBUILD_EXTRA_WARN`/`W=`, `CROSS_COMPILE`, `CF` for sparse, and `INSTALL_PATH`
