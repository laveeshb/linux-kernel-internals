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
insmod/modprobe                                  rmmod
    │                                              │
    ▼                                              ▼
load_module()                                free_module()
    │                                              │
    ├── verify_elf()          module refcount = 0 ─┤
    ├── layout_sections()          (checked first)  │
    ├── relocate symbols            module_exit() ──┘
    │     ├── parse .modinfo                        │
    │     ├── check MODULE_LICENSE                  ▼
    │     └── call module_init()             module_memfree()
    │              │                           vfree(module ELF)
    │              │
    │              └── return 0: success
    │              └── return -errno: unload immediately
    │
    └── add to modules list (/proc/modules)
        export symbols to other modules
```

## Module sections

A module `.ko` file is an ELF with special sections:

```bash
objdump -h hello.ko | grep -E "(\.init|\.exit|\.text|\.data|__param|__mod)"
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
# e1000e 262144 0 - Live 0xffffffffc0400000 (OE)
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
    const char       *srcversion;  /* source hash for module signing */

    struct module_kobject mkobj;   /* /sys/module/name/ */
    struct module_attribute *modinfo_attrs;

    const char       *version;
    const char       *srcversion;
    struct kobject   *holders_dir; /* /sys/module/name/holders/ */

    /* Exported symbols: */
    const struct kernel_symbol *syms;
    const s32                  *crcs;
    unsigned int                num_syms;

    /* GPL-only exported symbols: */
    const struct kernel_symbol *gpl_syms;
    const s32                  *gpl_crcs;
    unsigned int                num_gpl_syms;

    /* Module memory layout (6.4+: struct module_memory mem[]) */
    struct module_layout core_layout;  /* .text, .data, .rodata */
    struct module_layout init_layout;  /* .init.text (freed after init) */

    /* Reference counting (per-CPU for performance): */
    struct module_ref __percpu *refptr;

    /* init/exit: */
    int (*init)(void);
    void (*exit)(void);

    /* Parameters: */
    struct kernel_param *kp;
    unsigned int num_kp;

    /* Tracepoints: */
    struct tracepoint * const *tracepoints_ptrs;
    unsigned int num_tracepoints;
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
pr_debug("...");   /* KERN_DEBUG — only printed if CONFIG_DYNAMIC_DEBUG */

/* Device-specific logging (prefixes with device name): */
dev_err(&pdev->dev, "failed to allocate: %d\n", ret);
dev_info(&pdev->dev, "initialized at %p\n", base);

/* Rate-limited logging: */
pr_info_ratelimited("too many events\n");

/* Dynamic debug: selectively enable at runtime */
/* echo "module hello +p" > /sys/kernel/debug/dynamic_debug/control */
pr_debug("This only shows when enabled dynamically\n");
```

## Module signing

Modern kernels can enforce that modules are signed by a trusted key:

```bash
# Check if kernel requires signed modules
cat /proc/sys/kernel/modules_disabled  # 0=allow, 1=completely disable module loading (irreversible)

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
echo "module hello +p" > /sys/kernel/debug/dynamic_debug/control
echo "file hello.c +p" > /sys/kernel/debug/dynamic_debug/control
echo "func hello_init +p" > /sys/kernel/debug/dynamic_debug/control

# Show all dynamic debug settings
cat /sys/kernel/debug/dynamic_debug/control

# KASAN for memory errors (CONFIG_KASAN=y)
# Load module and trigger bug → KASAN reports use-after-free, etc.

# Check module's kallsyms
grep hello /proc/kallsyms
# ffffffffc0401000 t hello_init [hello]
# ffffffffc0401020 t hello_exit [hello]

# Crash debugging with gdb
gdb vmlinux
(gdb) add-symbol-file /path/to/hello.ko 0xffffffffc0401000
(gdb) list hello_init
```

## Further reading

- [Parameters, Symbols, and Kconfig](module-params.md) — module_param, EXPORT_SYMBOL
- [Platform Drivers](../drivers/platform-driver.md) — Most drivers are modules
- [BPF Verifier](../bpf/bpf-verifier.md) — Alternative to modules for safe kernel extension
- `Documentation/kbuild/modules.rst` — kernel build system for modules
