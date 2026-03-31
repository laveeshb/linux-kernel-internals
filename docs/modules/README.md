# Kernel Modules

> Dynamically loadable code that extends the kernel

## What kernel modules are

A kernel module is an ELF shared object loaded into the kernel at runtime. Modules:
- Share the kernel's address space and run at ring 0 (full privilege)
- Can export and use symbols from other modules or the core kernel
- Are loaded by `insmod`/`modprobe` and removed by `rmmod`
- Have an init function called on load and an exit function called on unload

Most device drivers, filesystems, and network protocols ship as modules.

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Writing and Loading Modules](module-basics.md) | module_init/exit, lifecycle, /proc/modules, debugging |
| [Parameters, Symbols, and Kconfig](module-params.md) | module_param, EXPORT_SYMBOL, Kconfig integration |

## Quick reference

```bash
# Load a module
insmod ./mymodule.ko
modprobe e1000e      # load with dependencies

# Unload
rmmod mymodule
modprobe -r e1000e   # remove with unused dependencies

# List loaded modules
lsmod

# Module info
modinfo e1000e

# Check kernel log for module messages
dmesg | tail -20
```
