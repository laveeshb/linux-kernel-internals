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
static int irq_count = 0;

module_param_array(irq_nums, int, &irq_count, 0444);
MODULE_PARM_DESC(irq_nums, "IRQ numbers (comma-separated)");
```

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
module_param_cb(debug, &debug_ops, &my_debug, 0644);
```

## EXPORT_SYMBOL: sharing symbols between modules

```c
/* In module A (or core kernel): */
int shared_function(int arg)
{
    return arg * 2;
}
EXPORT_SYMBOL(shared_function);             /* available to any module */
EXPORT_SYMBOL_GPL(shared_function_gpl);     /* GPL modules only */
EXPORT_SYMBOL_NS(shared_function, MYNS);    /* namespaced export (5.4+) */
```

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

# If you use a GPL-only symbol with non-GPL license, load fails:
# ERROR: "shared_function_gpl" [mymodule.ko] undefined!
```

### Symbol versioning (CRC)

Each exported symbol has a CRC of its type signature. If the symbol's definition changes, the CRC changes, and modules compiled against the old interface refuse to load:

```bash
# Check symbol CRCs
modpost output:
# WARNING: modpost: "tcp_sendmsg" [...] has no CRC!
# (happens if kernel isn't built with CONFIG_MODVERSIONS=y)
```

## /proc/kallsyms: all kernel symbols

```bash
# Find where a function lives
grep "tcp_sendmsg" /proc/kallsyms
# ffffffff81a12345 T tcp_sendmsg          ← T=text (exported)
# ffffffffc0401000 t hello_init [hello]   ← t=text (local), [module]

# Address → function name
awk '/ffffffff81a12345/{print $3}' /proc/kallsyms

# All module symbols
grep "\[mymodule\]" /proc/kallsyms
```

Symbol types:
- `T`/`t` — code (.text) — uppercase=global, lowercase=local
- `D`/`d` — data (.data)
- `R`/`r` — read-only data (.rodata)
- `B`/`b` — BSS (zero-initialized)
- `U` — undefined (imported)

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
mydriver-objs := mydriver_main.o mydriver_pci.o

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

# Build only this module
make M=drivers/mydriver
```

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

# Blacklist a module
echo "blacklist nouveau" >> /etc/modprobe.d/blacklist.conf
modprobe -r nouveau
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

# generates entry in modules.alias:
# alias pci:v00008086d00001234* e1000e

# When kernel discovers this device, it calls:
# modprobe pci:v00008086d00001234...
# which matches e1000e via modules.alias
```

## Symbol namespaces (5.4+)

For large subsystems, symbol namespaces prevent accidental use of internal symbols:

```c
/* Export with a namespace */
EXPORT_SYMBOL_NS(my_internal_func, MY_SUBSYSTEM);

/* Module that uses it must import the namespace */
MODULE_IMPORT_NS(MY_SUBSYSTEM);

extern int my_internal_func(void);
```

Without `MODULE_IMPORT_NS`, loading fails:
```
ERROR: module uses symbol from namespace MY_SUBSYSTEM but does not import it.
```

## Further reading

- [Module Basics](module-basics.md) — module_init/exit, lifecycle
- [Platform Drivers](../drivers/platform-driver.md) — Modules as drivers
- [Linux Device Model](../drivers/device-model.md) — How modules integrate with sysfs
- `Documentation/kbuild/kconfig-language.rst` — Kconfig syntax reference
