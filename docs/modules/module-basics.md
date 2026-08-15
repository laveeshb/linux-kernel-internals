# Writing and Loading Kernel Modules

> The lifecycle of a kernel module from source to running code

## A minimal kernel module

```c
/* hello.c */
#include <linux/module.h>
#include <linux/init.h>
#include <linux/kernel.h>

static int __init hello_init(void)
{
    pr_info("Hello, kernel!\n");  /* prints to kernel log */
    return 0;                      /* non-zero = load failed */
}

static void __exit hello_exit(void)
{
    pr_info("Goodbye, kernel!\n");
}

module_init(hello_init);
module_exit(hello_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Example Author");
MODULE_DESCRIPTION("A minimal hello world module");
MODULE_VERSION("1.0");
```

```makefile
# Makefile
obj-m := hello.o

# If source is out-of-tree:
KDIR ?= /lib/modules/$(shell uname -r)/build

all:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean
```

```bash
# Build
make

# Load
sudo insmod hello.ko

# Check output
dmesg | tail -3
# [12345.678] Hello, kernel!

# Unload
sudo rmmod hello

dmesg | tail -3
# [12346.789] Goodbye, kernel!
```

## Module lifecycle

```
insmod/modprobe                                rmmod
    │                                              │
    ▼                                              ▼
load_module()                                  delete_module()
    │                                              │
    ├── module_sig_check()                         ├── refcount must be 0
    ├── elf_validity_cache_copy()                  │   (try_stop_module)
    ├── early_mod_check()                          ├── mod->exit()
    │     └── parse .modinfo, check vermagic       │
    ├── layout_and_allocate()                      └── free_module()
    │     └── layout_sections()                        └── free_mod_mem()
    ├── add_unformed_module()                              └── module_memory_free()
    ├── module_augment_kernel_taints()                         └── execmem_free(mem->base)
    │     └── MODULE_LICENSE check (kernel taint set here)
    ├── find_module_sections()   /* mod->syms, crcs, flagstab */
    ├── simplify_symbols() / apply_relocations()
    ├── complete_formation()
    │     └── MODULE_STATE_COMING: module now visible in
    │         /proc/modules; symbols exported to other modules
    │
    └── return do_init_module(mod);   /* final statement of load_module() */
        │  (runs mod->init)
        ├── return 0: MODULE_STATE_LIVE
        └── return -errno: module unloaded immediately
```

## Module sections

A module `.ko` file is an ELF with special sections:

```bash
objdump -h hello.ko | grep -E "(\.init|\.exit|\.text|\.data|\.rodata|__param|\.modinfo)"
# .init.text   contains hello_init() (freed after module loads)
# .exit.text   contains hello_exit() (kept until module unloads)
# .text        normal code
# .data        read-write data
# .rodata      read-only data
# __param      module_param definitions
# .modinfo     MODULE_LICENSE, MODULE_AUTHOR, etc.
```

The `__init` attribute marks functions that should be freed after the module init runs (saving memory). Similarly `__exit` code can be discarded on permanent modules.

## /proc/modules

```bash
lsmod
# Module                  Size  Used by
# e1000e               262144  0
# ptp                   28672  1 e1000e

cat /proc/modules
# e1000e 262144 0 - Live 0xffffffffc0400000 (illustrative only -- a
#   stock distro-signed e1000e has no taint flags; (OE) would mean an
#   out-of-tree, unsigned build)
# Field: name size refcount deps state address (flags)
# Flags: O=out-of-tree, E=unsigned, F=forced

# See module dependencies
cat /lib/modules/$(uname -r)/modules.dep | grep e1000e
```

## The module struct in the kernel

```c
/* include/linux/module.h */
struct module {
    enum module_state state;       /* MODULE_STATE_LIVE/COMING/GOING/UNFORMED */
    struct list_head  list;        /* linked into modules list */
    char              name[MODULE_NAME_LEN];

    struct module_kobject mkobj;   /* /sys/module/name/ */
    struct module_attribute *modinfo_attrs;

    const char       *version;
    const char       *srcversion;  /* source hash */
    const char       *imported_namespaces;  /* MODULE_IMPORT_NS() list */
    struct kobject   *holders_dir; /* /sys/module/name/holders/ */

    /* Exported symbols — one table covers both plain and GPL-only
     * exports; flagstab[i] holds the flag byte (KSYM_FLAG_GPL_ONLY)
     * for syms[i]. There is no separate gpl_syms/gpl_crcs table. */
    const struct kernel_symbol *syms;
    const u32                  *crcs;
    const u8                   *flagstab;
    unsigned int                num_syms;

    /* Parameters: */
    struct kernel_param *kp;
    unsigned int num_kp;

    /* Set once this module resolves any GPL-only symbol: */
    bool using_gplonly_symbols;

    /* Startup function (not under CONFIG_MODULE_UNLOAD): */
    int (*init)(void);

    /* Module memory: one entry per region — MOD_TEXT, MOD_DATA,
     * MOD_RODATA, MOD_RO_AFTER_INIT, MOD_INIT_TEXT, MOD_INIT_DATA,
     * MOD_INIT_RODATA. This replaced the older core_layout/init_layout
     * pair of struct module_layout in 6.4; struct module_layout is gone. */
    struct module_memory mem[MOD_MEM_NUM_TYPES] __module_memory_align;

    /* Tracepoints: */
#ifdef CONFIG_TRACEPOINTS
    unsigned int      num_tracepoints;
    tracepoint_ptr_t *tracepoints_ptrs;
#endif

#ifdef CONFIG_MODULE_UNLOAD
    struct list_head source_list;  /* modules that depend on me */
    struct list_head target_list;  /* modules I depend on */
    void (*exit)(void);            /* destruction function */
    atomic_t refcnt;               /* module reference count */
#endif
    /* ... */
};
```

## pr_* logging

```c
/* Logging macros (prefer these over printk directly): */
pr_emerg("...");   /* KERN_EMERG — system is unusable */
pr_alert("...");   /* KERN_ALERT — action must be taken immediately */
pr_crit("...");    /* KERN_CRIT */
pr_err("...");     /* KERN_ERR — error conditions */
pr_warn("...");    /* KERN_WARNING */
pr_notice("...");  /* KERN_NOTICE */
pr_info("...");    /* KERN_INFO */
pr_debug("...");   /* KERN_DEBUG — compiled out unless CONFIG_DYNAMIC_DEBUG (runtime-switchable) or DEBUG is defined */

/* Device-specific logging (prefixes with device name): */
dev_err(&pdev->dev, "failed to allocate: %d\n", ret);
dev_info(&pdev->dev, "initialized at %px\n", base);  /* %p alone prints a
                                                        hashed, useless
                                                        value since 4.15 */

/* Rate-limited logging: */
pr_info_ratelimited("too many events\n");

/* Dynamic debug: selectively enable at runtime */
/* echo "module hello +p" > /proc/dynamic_debug/control */
pr_debug("This only shows when enabled dynamically\n");
```

## Module signing

Modern kernels can enforce that modules are signed by a trusted key:

```bash
# Check if kernel requires signed modules
cat /sys/module/module/parameters/sig_enforce  # Y = unsigned modules rejected

# Unrelated kill switch: blocks ALL module loading *and* unloading once set
cat /proc/sys/kernel/modules_disabled  # 0=allow, 1=no init_module/finit_module/delete_module (irreversible)

# Sign a module
/usr/src/linux-headers-$(uname -r)/scripts/sign-file \
    sha256 signing_key.pem signing_key.x509 hello.ko

# Check module signature
modinfo hello.ko | grep sig

# Kernel boot params:
# module.sig_enforce=1   — require signature (any unsigned module is rejected)
```

## Module debugging

```bash
# Dynamic debug: enable pr_debug() for a module
# Control file: /proc/dynamic_debug/control, or the equivalent
# /sys/kernel/debug/dynamic_debug/control when debugfs is enabled
echo "module hello +p" > /proc/dynamic_debug/control
echo "file hello.c +p" > /proc/dynamic_debug/control
echo "func hello_init +p" > /proc/dynamic_debug/control

# Show all dynamic debug settings
cat /proc/dynamic_debug/control

# KASAN for memory errors (CONFIG_KASAN=y)
# Load module and trigger bug → KASAN reports use-after-free, etc.

# Check module's kallsyms
grep hello /proc/kallsyms
# ffffffffc0401000 t hello_exit [hello]
# Note: hello_init does NOT show up here. do_init_module() switches
# mod->kallsyms over to core_kallsyms once init has run, and that table
# excludes every symbol living in an init-type section — so __init
# symbols vanish as soon as the module finishes loading.

# Crash debugging with gdb: the section base comes from sysfs, not from a
# symbol address (this module's only two functions are __init/__exit, so
# .text itself is empty and has no sysfs entry -- read .exit.text instead,
# since hello_exit is what's still resident and is what we're debugging)
cat /sys/module/hello/sections/.exit.text
# 0xffffffffc0401000
gdb vmlinux
(gdb) add-symbol-file /path/to/hello.ko 0xffffffffc0401000
(gdb) list hello_exit
```

## Further reading

### Kernel source

- [kernel/module/main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/main.c) — the loader core: `load_module()`, `layout_sections()`, `do_init_module()` (which calls the module's `init` function), and `free_module()` on the unload path
- [include/linux/module.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/module.h) — `struct module` itself, plus the `module_init()`/`module_exit()` and `MODULE_LICENSE()`/`MODULE_AUTHOR()`/`MODULE_DESCRIPTION()`/`MODULE_VERSION()` macros used by the hello-world example
- [include/linux/init.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/init.h) — where `__init` and `__exit` are defined as `__section(".init.text")` and `__section(".exit.text")`, the attributes behind the discardable-section behaviour described above
- [include/linux/moduleparam.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/moduleparam.h) — `MODULE_INFO()` emitting into the `.modinfo` section, and `module_param()` emitting into `__param`; the two sections `objdump` shows above
- [kernel/module/procfs.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/procfs.c) — generates the `/proc/modules` line format: name, size, refcount, dependency list, `Live`/`Loading`/`Unloading` state, base address, and taint flags
- [include/linux/printk.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/printk.h) — the `pr_emerg()` … `pr_debug()` family and `pr_info_ratelimited()`

### Man pages

- [`insmod(8)`](https://man7.org/linux/man-pages/man8/insmod.8.html) — the "trivial program to insert a module"; points readers at `modprobe(8)`, which is what handles module dependencies
- [`rmmod(8)`](https://man7.org/linux/man-pages/man8/rmmod.8.html) — unloading, and why `-f`/`--force` needs `CONFIG_MODULE_FORCE_UNLOAD`
- [`modprobe(8)`](https://man7.org/linux/man-pages/man8/modprobe.8.html) — dependency-aware loading via `modules.dep.bin`, and `-r` to remove a module plus its now-unused dependencies
- [`modinfo(8)`](https://man7.org/linux/man-pages/man8/modinfo.8.html) — dumps the `.modinfo` fields (`license`, `author`, `description`, `parm`, `depends`, `alias`, `filename`); note that kmod also prints the `sig*` signature fields, which this man page does not document
- [`lsmod(8)`](https://man7.org/linux/man-pages/man8/lsmod.8.html) — the formatted view of `/proc/modules` shown above
- [`depmod(8)`](https://man7.org/linux/man-pages/man8/depmod.8.html) — builds the `modules.dep` file that `modprobe` reads

### Related pages

- [Module Loading Internals](module-loading-internals.md) — what `load_module()` actually does between the ELF arriving and `init` being called
- [Parameters, Symbols, and Kconfig](module-params.md) — `module_param()` and `EXPORT_SYMBOL`/`EXPORT_SYMBOL_GPL`
- [Module Signing](module-signing.md) — the signature-enforcement machinery sketched in the signing section above
- [Kbuild](kbuild.md) — how `obj-m` and the out-of-tree `M=$PWD` build actually work
- [Dynamic Debug](dynamic-debug.md) — the full query syntax behind `echo "module hello +p"`
- [Platform Drivers](../drivers/platform-driver.md) — most drivers are modules
- [BPF Verifier](../bpf/bpf-verifier.md) — how the kernel admits untrusted extension code without the `.ko` load path: static verification instead of signature and symbol checks

### LWN articles

- [Two approaches to tightening restrictions on loadable modules](https://lwn.net/Articles/998221/) — Jonathan Corbet, November 2024: why `MODULE_LICENSE("GPL")` is a load-bearing declaration rather than a formality, covering the GPLv3-declared-as-GPL dispute and per-module symbol export namespaces
- [Yet another memory allocator for executable code](https://lwn.net/Articles/933867/) — Jonathan Corbet, June 2023: how memory for module text is allocated, and the work replacing `module_alloc()` with a shared executable-memory allocator

### External

- [Building External Modules — The Linux Kernel documentation](https://docs.kernel.org/kbuild/modules.html) — the upstream reference for the `obj-m` and `make -C $KDIR M=$PWD modules` pattern used in the Makefile above
- [Kernel module signing facility — The Linux Kernel documentation](https://docs.kernel.org/admin-guide/module-signing.html) — `scripts/sign-file`, `module.sig_enforce=1`, and `CONFIG_MODULE_SIG_FORCE`
- [Dynamic debug — The Linux Kernel documentation](https://docs.kernel.org/admin-guide/dynamic-debug-howto.html) — the `module`/`file`/`func` query language and `+p` flag for enabling `pr_debug()` at runtime
- [Message logging with printk — The Linux Kernel documentation](https://docs.kernel.org/core-api/printk-basics.html) — the `KERN_*` log levels behind each `pr_*()` macro, and `pr_fmt()` for prefixing a module's messages
