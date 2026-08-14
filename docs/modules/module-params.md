# Module Parameters, Symbols, and Kconfig

> Configuring modules at load time and sharing symbols across the kernel

## module_param: runtime configuration

```c
/* Declare module parameters */
static int debug = 0;
static unsigned int timeout_ms = 100;
static char *device_name = "mydevice";
static bool enable_feature = false;

module_param(debug, int, 0644);
MODULE_PARM_DESC(debug, "Debug level (0=off, 1=basic, 2=verbose)");

module_param(timeout_ms, uint, 0644);
MODULE_PARM_DESC(timeout_ms, "Timeout in milliseconds (default: 100)");

module_param(device_name, charp, 0444);  /* read-only after load */
MODULE_PARM_DESC(device_name, "Device name string");

module_param(enable_feature, bool, 0644);
MODULE_PARM_DESC(enable_feature, "Enable experimental feature");
```

The third argument is the `sysfs` permission:
- `0644` — owner read-write, group/other read-only → visible and changeable
- `0444` — read-only for everyone
- `0` — not exposed in sysfs (load-time only)

```bash
# Set at load time
sudo modprobe mymodule debug=2 timeout_ms=500

# Or with insmod
sudo insmod mymodule.ko debug=2

# Read/write via sysfs (if permission allows)
cat /sys/module/mymodule/parameters/debug
echo 3 > /sys/module/mymodule/parameters/debug
```

### Arrays

```c
static int irq_nums[4];
static unsigned int irq_count;

module_param_array(irq_nums, int, &irq_count, 0444);
MODULE_PARM_DESC(irq_nums, "IRQ numbers (comma-separated)");
```

The count variable must be `unsigned int`, not `int`: `module_param_array()`
stores the pointer in `struct kparam_array`, whose `.num` field is declared
`unsigned int *`, so passing an `int *` is an incompatible-pointer-type error
the kernel build rejects. Pass `NULL` instead if you do not need the count.

```bash
sudo insmod mymodule.ko irq_nums=5,6,7  # irq_count set to 3 by kernel
```

### Callbacks on parameter change

```c
static int my_debug = 0;

static int debug_set(const char *val, const struct kernel_param *kp)
{
    int n;
    int ret = kstrtoint(val, 10, &n);
    if (ret)
        return ret;
    if (n < 0 || n > 3)
        return -EINVAL;
    my_debug = n;
    pr_info("debug level changed to %d\n", n);
    return 0;
}

static const struct kernel_param_ops debug_ops = {
    .set = debug_set,
    .get = param_get_int,
};
/* Note the distinct name: "debug" is already taken by the
 * module_param(debug, ...) above, and one module cannot
 * register two parameters under the same name.
 */
module_param_cb(debug_level, &debug_ops, &my_debug, 0644);
```

## EXPORT_SYMBOL: sharing symbols between modules

```c
/* In module A (or core kernel): */
int shared_function(int arg)
{
    return arg * 2;
}
EXPORT_SYMBOL(shared_function);             /* available to any module */

int shared_function_gpl(int arg)
{
    return arg * 3;
}
EXPORT_SYMBOL_GPL(shared_function_gpl);     /* GPL modules only */

int namespaced_function(int arg)
{
    return arg + 1;
}
/* Namespaced export (5.4+). The namespace is a string literal. */
EXPORT_SYMBOL_NS(namespaced_function, "MYNS");
```

Each symbol is exported exactly once — `EXPORT_SYMBOL`, `EXPORT_SYMBOL_GPL`,
and `EXPORT_SYMBOL_NS` are alternatives for the same symbol, not layers you
stack on top of one another.

```c
/* In module B: */
extern int shared_function(int arg);  /* or just include the header */

static int __init moduleB_init(void)
{
    int result = shared_function(21);  /* works: symbol is exported */
    pr_info("result = %d\n", result);
    return 0;
}
```

### EXPORT_SYMBOL vs EXPORT_SYMBOL_GPL

`EXPORT_SYMBOL_GPL` makes the symbol usable only by modules with `MODULE_LICENSE("GPL")` or compatible licenses. This enforces that proprietary modules can't use kernel-internal interfaces.

When a module imports a GPL-only symbol:
```bash
modinfo mymodule.ko | grep license
# license: GPL
```

If a module declares a GPL-incompatible license and still references a
GPL-only symbol, the violation is caught twice. First at **build** time, by
`modpost`:

```
ERROR: modpost: GPL-incompatible module mymodule.ko uses GPL-only symbol 'shared_function_gpl'
```

And again at **load** time, if such a module is loaded anyway (a prebuilt
`.ko`, say). The kernel does not have a dedicated "you are not GPL" error:
`find_exported_symbol_in_section()` simply skips GPL-only symbols when the
loading module's license is not GPL-compatible, so the symbol looks like it
does not exist at all:

```
$ sudo insmod mymodule.ko
insmod: ERROR: could not insert module mymodule.ko: Unknown symbol in module

$ dmesg | tail -1
mymodule: Unknown symbol shared_function_gpl (err -2)
```

### Symbol versioning (CRC)

When the kernel is built with `CONFIG_MODVERSIONS=y`, each exported symbol also
gets a CRC of its type signature. If the symbol's definition changes, the CRC
changes, and modules compiled against the old interface refuse to load:

```
# Load time, from check_version() in kernel/module/version.c:
mymodule: disagrees about version of symbol tcp_sendmsg
```

Build-time complaints come from `modpost`, which records a CRC for every
symbol the module references:

```
WARNING: modpost: "tcp_sendmsg" [drivers/net/mydriver.ko] has no CRC!
```

This warning fires *only* when `CONFIG_MODVERSIONS=y` — `add_versions()`
returns immediately when modversions is off — and means a referenced symbol
had no valid CRC to record, usually because the exporting side was built
without version information. With `CONFIG_MODVERSIONS=n` there are no CRCs and
therefore no CRC warnings or load-time version checks at all.

## /proc/kallsyms: all kernel symbols

```bash
# Find where a function lives (as root — see the note on addresses below)
sudo grep "tcp_sendmsg" /proc/kallsyms
# ffffffff81a12345 T tcp_sendmsg          ← T = global code, not "exported"
# ffffffffc0401000 t hello_init [hello]   ← t = module-local code, [module]

# Address → function name
sudo awk '/ffffffff81a12345/{print $3}' /proc/kallsyms

# All module symbols
sudo grep "\[mymodule\]" /proc/kallsyms
```

Addresses are hidden from unprivileged readers. `/proc/kallsyms` calls
`kallsyms_show_value()` on the credentials of whoever opened the file, and
`s_show()` prints a NULL address when it returns false. Without `CAP_SYSLOG`
(and depending on `kptr_restrict`), every line reads `0000000000000000` rather
than the real addresses shown above — hence the `sudo`.

Symbol types:
- `T`/`t` — code (.text) — uppercase=global, lowercase=local
- `D`/`d` — data (.data)
- `R`/`r` — read-only data (.rodata)
- `B`/`b` — BSS (zero-initialized)
- `W`/`w` — weak, and `V`/`v` — weak data object
- `A`/`a` — absolute, which for module symbols also covers per-CPU variables
- `G`/`g` and `S`/`s` — small data and small BSS, on architectures with a
  small-data section

The case convention differs slightly between the two halves of the file. For
vmlinux symbols the letter comes straight from the `nm` output baked in at
build time, where uppercase means global (external) linkage — `T` says nothing
about whether the symbol was passed to `EXPORT_SYMBOL`. For module symbols,
`s_show()` re-cases the letter itself: uppercase if the symbol is exported,
lowercase if not.

`nm`'s `U` (undefined) never appears in `/proc/kallsyms`. Undefined symbols are
filtered out when a module's symbol table is trimmed — `is_core_symbol()`
returns false for anything with `st_shndx == SHN_UNDEF` — so imported symbols
are simply absent from the listing rather than shown with a type of their own.

## Kconfig: compile-time configuration

```kconfig
# drivers/mydriver/Kconfig

config MY_DRIVER
    tristate "My example driver"
    depends on PCI
    select DMA_ENGINE
    help
      Enable support for the MyDriver hardware.

      If unsure, say N.
      To compile as a module, say M.

config MY_DRIVER_DEBUG
    bool "Enable MyDriver debug output"
    depends on MY_DRIVER
    default n
    help
      Enable verbose debug logging for MyDriver.
```

`tristate` means: `y` (built-in), `m` (module), or `n` (disabled).

```makefile
# drivers/mydriver/Makefile
obj-$(CONFIG_MY_DRIVER) += mydriver.o
mydriver-y := mydriver_main.o mydriver_pci.o

# Conditional compilation
obj-$(CONFIG_MY_DRIVER_DEBUG) += mydriver_debug.o
```

```c
/* In source: */
#ifdef CONFIG_MY_DRIVER_DEBUG
void debug_dump(void) { /* ... */ }
#else
static inline void debug_dump(void) {}
#endif
```

```bash
# Configure
make menuconfig
# Navigate to your driver section

# Check what's enabled
grep MY_DRIVER .config
# CONFIG_MY_DRIVER=m
# CONFIG_MY_DRIVER_DEBUG=n

# Build only this directory (in-tree single target)
make drivers/mydriver/

# Or one specific object / module
make drivers/mydriver/mydriver.ko
```

`M=` is *not* the in-tree equivalent: it names the directory of an **external**
module, as in `make -C $KDIR M=$PWD`. For code inside the kernel tree, use the
single-target forms above — a trailing `/` builds everything under that
directory.

## Module dependencies

`modprobe` reads dependency information to automatically load required modules:

```bash
# Regenerate dependency database (after installing new modules)
depmod -a

# Check what mymodule requires
modinfo mymodule.ko | grep depends
# depends: ptp,i2c-algo-bit

# See full dependency tree
modprobe --show-depends e1000e
# insmod /lib/modules/.../ptp.ko
# insmod /lib/modules/.../e1000e.ko

# Blacklist a module: stops *future* automatic loading by alias
# (it does not affect an explicit `modprobe nouveau`, and does not
#  unload anything that is already loaded)
echo "blacklist nouveau" >> /etc/modprobe.d/blacklist.conf

# Unloading is a separate, immediate action
modprobe -r nouveau

# Blacklisting only takes effect for boot-time autoloading once the
# initramfs has been regenerated (distro-specific), e.g.:
# sudo dracut -f      /  sudo update-initramfs -u
```

```bash
# /lib/modules/$(uname -r)/ directory
ls /lib/modules/$(uname -r)/
# build           kernel          modules.alias      modules.builtin
# modules.dep     modules.order   modules.softdep    modules.symbols

# modules.dep: generated by depmod
cat /lib/modules/$(uname -r)/modules.dep | grep e1000e
# kernel/drivers/net/ethernet/intel/e1000e/e1000e.ko: kernel/drivers/ptp/ptp.ko
```

## Module loading hooks

udev/systemd-udevd automatically loads modules based on device discovery:

```bash
# Add a MODULE_ALIAS to match hardware IDs
# In source:
MODULE_ALIAS("pci:v00008086d00001234*");  /* Intel device 0x1234 */

# depmod collects it into modules.alias:
# alias pci:v00008086d00001234* e1000e
```

The kernel does not invoke `modprobe` for discovered devices. When a device
appears, the kernel emits a uevent carrying a `MODALIAS=` variable built from
the device's IDs:

```bash
cat /sys/bus/pci/devices/0000:00:1f.6/modalias
# pci:v00008086d00001234sv...sd...bc02sc00i00
```

`systemd-udevd` receives that uevent and matches it against its rules. The
standard one lives in `80-drivers.rules`:

```
ENV{MODALIAS}=="?*", IMPORT{builtin}="kmod load $env{MODALIAS}"
```

udev's `kmod` builtin then resolves the alias through `modules.alias` — the
same libkmod lookup `modprobe` performs — and loads `e1000e`. It applies
`modprobe.d` blacklists along the way, which is why blacklisting a module
suppresses this autoload path while leaving an explicit `modprobe nouveau`
working.

## Symbol namespaces (5.4+)

For large subsystems, symbol namespaces prevent accidental use of internal symbols:

```c
/* Export with a namespace */
EXPORT_SYMBOL_NS(my_internal_func, "MY_SUBSYSTEM");

/* Module that uses it must import the namespace */
MODULE_IMPORT_NS("MY_SUBSYSTEM");

extern int my_internal_func(void);
```

The namespace argument is a **string literal**. It was originally a bare token
when the feature landed in 5.4, but commit `cdd30ebb1b9f` (v6.13) converted
the macros and every in-tree caller to quoted strings; the quoted form is the
only one that compiles on current kernels.

Without `MODULE_IMPORT_NS`, the build fails first, in `modpost`:

```
ERROR: modpost: module mymodule uses symbol my_internal_func from namespace MY_SUBSYSTEM, but does not import it.
```

and `verify_namespace_is_imported()` rejects the same module at load time:

```
mymodule: module uses symbol (my_internal_func) from namespace MY_SUBSYSTEM, but does not import it.
```

`CONFIG_MODULE_ALLOW_MISSING_NAMESPACE_IMPORTS` downgrades both to warnings —
it makes the kernel use `pr_warn()` instead of `pr_err()`, and passes `-N` to
`modpost`. `make nsdeps` will add the missing `MODULE_IMPORT_NS()` lines for
you.

## Further reading

### Kernel source

- [include/linux/moduleparam.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/moduleparam.h) — every macro used above. `module_param()` is a thin wrapper over `module_param_named()`, which expands to `param_check_<type>()` + `module_param_cb()` + `__MODULE_PARM_TYPE()`; `MODULE_PARM_DESC()` is just `MODULE_INFO(parm, ...)`. Also `struct kernel_param_ops` (`.flags`, `.set`, `.get`, `.free`), `struct kparam_array` (whose `.num` field is an `unsigned int *`), and `__module_param_call()`, which places each `struct kernel_param` into the `__param` section
- [kernel/params.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/params.c) — the per-type `kernel_param_ops` behind the `int`/`uint`/`charp`/`bool` type names — the numeric ones generated by the `STANDARD_PARAM_DEF()` macro, `param_ops_charp` and `param_ops_bool` written out by hand — plus `param_array_ops` (the code that parses `5,6,7` and writes the element count back through `nump`), and `add_sysfs_param()`/`module_param_sysfs_setup()`, which build `/sys/module/<name>/parameters/`. Note `add_sysfs_param()` skips parameters with `perm == 0` and only installs a `store` handler when `perm` has a write bit set
- [include/linux/sysfs.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/sysfs.h) — `VERIFY_OCTAL_PERMISSIONS()`, the compile-time check `__module_param_call()` applies to the permission argument: it rejects any world-writable mode and any mode where group or other is more permissive than owner, so `0666` will not build
- [include/linux/export.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/export.h) — `EXPORT_SYMBOL()`, `EXPORT_SYMBOL_GPL()`, `EXPORT_SYMBOL_NS()`/`EXPORT_SYMBOL_NS_GPL()`, `DEFAULT_SYMBOL_NAMESPACE`, and the newer `EXPORT_SYMBOL_FOR_MODULES()`. The license and namespace are emitted as strings into a `.export_symbol` section, which is why the namespace argument is a quoted string literal
- [kernel/module/main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/main.c) — `resolve_symbol()` and `find_exported_symbol_in_section()`, where a GPL-only symbol is simply made *invisible* to a module whose license is not GPL-compatible (the load then fails with `Unknown symbol`), plus `verify_namespace_is_imported()`, the source of the missing-`MODULE_IMPORT_NS` error
- [kernel/module/version.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/version.c) — `check_version()`: the load-time CRC comparison behind `CONFIG_MODVERSIONS`, and where the `disagrees about version of symbol` and `no symbol version for` messages come from
- [scripts/mod/modpost.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/mod/modpost.c) — the build-time half of the same checks: `add_versions()` emits the `has no CRC!` warning, and the GPL and namespace violations are reported as `GPL-incompatible module ... uses GPL-only symbol` and `module ... uses symbol ... from namespace ..., but does not import it`
- [kernel/module/kallsyms.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/kallsyms.c) — `elf_type()`, which assigns the one-letter symbol types (`t`/`d`/`r`/`b`, plus `w`/`v` for weak and `a` for absolute) shown in `/proc/kallsyms`, and `is_core_symbol()`, which decides which of a module's symbols are listed at all
- [kernel/kallsyms.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/kallsyms.c) — the `/proc/kallsyms` seq_file, and `kallsyms_show_value()`, which is why an unprivileged `cat` sees `0000000000000000` for every address

### Man pages

- [`modprobe(8)`](https://man7.org/linux/man-pages/man8/modprobe.8.html) — passing `param=value` after the module name, `-r` for removal, and `--show-depends`
- [`insmod(8)`](https://man7.org/linux/man-pages/man8/insmod.8.html) — the dependency-unaware loader used in the `insmod mymodule.ko debug=2` examples above
- [`modinfo(8)`](https://man7.org/linux/man-pages/man8/modinfo.8.html) — the `parm:` lines produced by `MODULE_PARM_DESC()`, plus the `depends`, `license`, and `alias` fields, and `-F` to extract one of them
- [`depmod(8)`](https://man7.org/linux/man-pages/man8/depmod.8.html) — builds `modules.dep`/`modules.dep.bin` and the map files including `modules.alias`
- [`modules.dep(5)`](https://man7.org/linux/man-pages/man5/modules.dep.5.html) — the exact format of the `modules.dep` lines shown above
- [`modprobe.d(5)`](https://man7.org/linux/man-pages/man5/modprobe.d.5.html) — the configuration files behind `blacklist`, plus the `options` directive for setting default module parameters persistently

### Related pages

- [Writing and Loading Kernel Modules](module-basics.md) — `module_init()`/`module_exit()`, `MODULE_LICENSE()`, and the module lifecycle these parameters attach to
- [Module Loading Internals](module-loading-internals.md) — where symbol resolution, relocation, and the modversions check happen inside `load_module()`
- [Kbuild Build System](kbuild.md) — the `obj-y`/`obj-m`/`<module>-y` mechanics and Kconfig front-ends behind the Makefile fragment above
- [Kernel Module Signing](module-signing.md) — the other load-time gate a `.ko` has to pass
- [Platform Drivers](../drivers/platform-driver.md) — modules as drivers, and how `MODULE_DEVICE_TABLE` feeds `modules.alias`
- [Linux Device Model](../drivers/device-model.md) — the kobject/sysfs machinery that `/sys/module/<name>/parameters/` is built on

### LWN articles

- [module_param() 1/3](https://lwn.net/Articles/16550/) — Rusty Russell, November 26, 2002: the patch posting that introduced `module_param()` to replace `MODULE_PARM`, including the original explanation of the permissions argument ("for exposing parameters in sysfs (if non-zero)")
- [Module parameters in sysfs](https://lwn.net/Articles/85443/) — Jonathan Corbet, May 18, 2004: the patch that created `/sys/module/<name>/parameters/`, establishing that a parameter appears only when its `perm` is non-zero and that `perm` becomes the file's mode. It also flags the caveat this page's callback section addresses: there is no built-in notification when a parameter is written
- [Kernel symbol namespacing](https://lwn.net/Articles/760045/) — Jonathan Corbet, July 18, 2018: the original proposal for `EXPORT_SYMBOL_NS()` and `MODULE_IMPORT_NS()`, and why 30,000 flat exported symbols were a problem worth solving
- [A new version of modversions](https://lwn.net/Articles/986892/) — Jonathan Corbet, August 26, 2024: the history of the symbol CRCs described above, from the original modversions in 1.1.85 (January 1995) through the `genksyms` C parser, and Sami Tolvanen's `gendwarfksyms` replacement — it reads the compiler's DWARF output instead of parsing C, because `genksyms` cannot handle Rust. The result is the `CONFIG_GENDWARFKSYMS` path referenced from `include/linux/export.h`

### External

- [The kernel's command-line parameters](https://docs.kernel.org/admin-guide/kernel-parameters.html) — the other way to set a parameter: `modulename.param=value` on the boot command line, which is the only way to set a parameter for code built in with `=y` (there is no `modprobe` invocation to attach it to), and the `echo -n value > /sys/module/${modulename}/parameters/${parm}` runtime form
- [Symbol Namespaces](https://docs.kernel.org/core-api/symbol-namespaces.html) — the current, authoritative syntax: `EXPORT_SYMBOL_NS(usb_stor_suspend, "USB_STORAGE")` and `MODULE_IMPORT_NS("USB_STORAGE")` with quoted namespace strings, `DEFAULT_SYMBOL_NAMESPACE`, and using `make nsdeps` to add missing imports automatically
- [Kconfig Language](https://docs.kernel.org/kbuild/kconfig-language.html) — the reference for `bool`/`tristate`, and the precise semantics of `depends on` versus `select` (a reverse dependency that ignores the selected symbol's own dependencies)
- [Linux Kernel Makefiles](https://docs.kernel.org/kbuild/makefiles.html) — `obj-$(CONFIG_FOO)` goal definitions and composite modules built from several objects
- [Building External Modules](https://docs.kernel.org/kbuild/modules.html) — what `M=` actually means, and the `make -C $KDIR M=$PWD modules` pattern for out-of-tree builds
