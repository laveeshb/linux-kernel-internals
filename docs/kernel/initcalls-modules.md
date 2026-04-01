# Module Init and Initcalls

> How kernel modules and built-in subsystems initialize

## `module_init()` and `module_exit()`

Every kernel module or built-in subsystem declares its initialization and cleanup functions using two macros:

```c
#include <linux/module.h>
#include <linux/init.h>

static int __init mydriver_init(void)
{
    pr_info("mydriver: initializing\n");
    /* ... register device, allocate resources ... */
    return 0;  /* 0 = success; negative errno = failure */
}

static void __exit mydriver_exit(void)
{
    pr_info("mydriver: exiting\n");
    /* ... release resources ... */
}

module_init(mydriver_init);
module_exit(mydriver_exit);
```

### What these macros expand to

For a **loadable module** (`.ko` file), `module_init()` creates an alias:

```c
/* include/linux/module.h (loadable module case) */
#define module_init(initfn)                         \
    static inline initcall_t __maybe_unused         \
    __inittest(void) { return initfn; }             \
    int init_module(void) __copy(initfn)            \
        __attribute__((alias(#initfn)));
```

The resulting `init_module` symbol is what the kernel's module loader calls after loading the `.ko`.

For a **built-in module** (`y` in Kconfig), `module_init()` becomes:

```c
#define module_init(initfn)     device_initcall(initfn)
```

which places the function pointer in the `.initcall8.init` ELF section, called by `do_initcalls()` during boot. See [Early Boot and start_kernel()](early-boot.md) for the full initcall level table.

`module_exit()` for built-in code expands to nothing — built-in code can never be unloaded, so the exit function is not needed (and is discarded by the linker from `.exit.text`).

---

## `struct module`

Every loaded module is represented by a `struct module` allocated in module memory:

```c
/* include/linux/module.h (simplified) */
struct module {
    enum module_state state;        /* COMING, LIVE, GOING, UNFORMED */

    struct list_head list;          /* linked into modules list */

    char name[MODULE_NAME_LEN];     /* module name (e.g., "e1000e") */

    /* Exported symbols */
    const struct kernel_symbol *syms;
    unsigned int num_syms;
    const s32 *crcs;

    /* GPL-exported symbols */
    const struct kernel_symbol *gpl_syms;
    unsigned int num_gpl_syms;
    const s32 *gpl_crcs;

    /* Init and exit functions */
    int (*init)(void);
    void (*exit)(void);

    /* Reference counting */
    atomic_t refcnt;

    /* Module dependencies */
    struct list_head requires;      /* modules this module depends on */
    struct list_head users;         /* modules that depend on this one */

    /* Source section information (for /sys/module/<name>/sections/) */
    struct module_sect_attrs *sect_attrs;

    /* Parameters (for /sys/module/<name>/parameters/) */
    struct kernel_param *kp;
    unsigned int num_kp;

    /* Build ID */
    unsigned char build_id[BUILD_ID_SIZE_MAX];
};
```

Module states (`enum module_state`):

| State | Meaning |
|-------|---------|
| `MODULE_STATE_LIVE` | Fully loaded and operational |
| `MODULE_STATE_COMING` | Being loaded, `init()` not yet called |
| `MODULE_STATE_GOING` | Being unloaded, `exit()` not yet called |
| `MODULE_STATE_UNFORMED` | Partially constructed (early allocations done) |

---

## Module loading flow

The kernel exposes two syscalls for loading modules:

- `init_module(buf, len, params)` — loads a module image from a buffer in userspace memory
- `finit_module(fd, params, flags)` — loads a module from a file descriptor (preferred since 3.8; enables module signing verification on the file)

`insmod` uses `init_module`; `modprobe` uses `finit_module`.

### `load_module()`: step by step

`load_module()` in `kernel/module/main.c` does the heavy lifting:

```
load_module()
    1. copy_module_from_user() / copy_module_from_fd()
       - Read the ELF image from userspace

    2. elf_validity_check()
       - Verify ELF magic, architecture, section headers

    3. module_sig_check()       [if CONFIG_MODULE_SIG]
       - Verify PKCS#7 signature against built-in public key
       - Fail if CONFIG_MODULE_SIG_FORCE and signature invalid

    4. Allocate struct module
       - layout_and_allocate(): compute section sizes
       - module_alloc(): allocate memory in module space
         (vmalloc region, or close to kernel text for 32-bit)

    5. Apply ELF relocations
       - apply_relocations(): resolve symbol references
       - Symbols resolved against:
         a. __ksymtab (EXPORT_SYMBOL)
         b. __ksymtab_gpl (EXPORT_SYMBOL_GPL)
         c. Other loaded modules' exported symbols

    6. module_finalize()
       - Set up alternatives (CPU feature patching)
       - Set up jump labels
       - Set up ORC unwind info

    7. do_init_module()
       - Set state = MODULE_STATE_COMING
       - call module->init()   <-- driver's __init function runs
       - If init() returns 0: state = MODULE_STATE_LIVE
       - If init() returns non-zero: module loading fails,
         module freed, error returned to userspace

    8. add_unformed_module() / add_module_to_list()
       - Module appears in /proc/modules
       - Module directory created in /sys/module/
```

### Module memory layout

Module code is loaded into a special virtual address range distinct from the main kernel text. On x86-64 this is in the range `0xffffffffc0000000` and above (the module space). The separation ensures that a module cannot be confused with core kernel code in stack traces and makes it easier to deallocate module memory on unload.

---

## Module unloading

```
rmmod mydriver
    → delete_module("mydriver", flags) syscall
    → kernel/module/main.c: free_module()

    1. Check refcnt: module_refcount() must be 0
       - If non-zero: EWOULDBLOCK
       - --force flag bypasses this (dangerous)

    2. set state = MODULE_STATE_GOING

    3. Call module->exit() if it exists

    4. Remove from modules list and /proc/modules

    5. Remove from /sys/module/

    6. Synchronize with RCU (rcu_barrier())
       - Ensures all in-flight RCU callbacks that reference
         the module's code have completed

    7. module_free(): return memory to vmalloc allocator
```

Modules cannot be unloaded while any code is executing in them (tracked by `refcnt`) or while any other module depends on them (tracked by the `users` list).

---

## Symbol export

Only explicitly exported symbols are accessible to loadable modules. The mechanism uses two ELF sections:

```c
/* include/linux/export.h */
#define EXPORT_SYMBOL(sym)      __EXPORT_SYMBOL(sym, "")
#define EXPORT_SYMBOL_GPL(sym)  __EXPORT_SYMBOL(sym, "_gpl")
```

Each `EXPORT_SYMBOL()` creates a `struct kernel_symbol` in `__ksymtab`:

```c
struct kernel_symbol {
    int value_offset;    /* offset from this struct to the symbol */
    int name_offset;     /* offset from this struct to the name string */
    int namespace_offset;
};
```

During module loading, the relocation step resolves undefined symbols by searching `__ksymtab` (and the `__ksymtab` of already-loaded modules). If a symbol is in `__ksymtab_gpl` and the loading module's `MODULE_LICENSE` is not GPL-compatible, the load fails:

```
ERROR: "some_gpl_function" [drivers/mydriver/mydriver.ko] undefined!
```

From userspace:
```bash
# List all exported kernel symbols:
cat /proc/kallsyms | grep ' T '    # T = global text symbol

# List symbols exported by a specific module:
cat /proc/kallsyms | grep '\[mydriver\]'

# List what symbols a .ko exports:
nm mydriver.ko | grep '__ksymtab'

# List what symbols a .ko imports (needs from other modules):
modinfo mydriver.ko
# or
nm mydriver.ko | grep ' U '  # U = undefined (imported)
```

---

## Module parameters during load

```c
/* In the module source: */
static int timeout_ms = 100;
module_param(timeout_ms, int, 0644);
MODULE_PARM_DESC(timeout_ms, "Timeout in milliseconds (default 100)");

static char *device_name = "default";
module_param(device_name, charp, 0444);
MODULE_PARM_DESC(device_name, "Target device name");
```

```bash
# Pass parameters at load time:
modprobe mydriver timeout_ms=500 device_name=eth0
insmod mydriver.ko timeout_ms=500

# Read/write parameters at runtime (if permissions allow):
cat /sys/module/mydriver/parameters/timeout_ms
echo 200 > /sys/module/mydriver/parameters/timeout_ms
```

The `module_param()` macro registers a `struct kernel_param` in the `.data..param` section. `load_module()` calls `parse_args()` on the parameter string passed to `finit_module()` before calling `init()`, so parameters are set before the driver initializes.

---

## Module dependencies

`modprobe` (from the `kmod` package) handles dependency resolution. The dependency database is built by `depmod`:

```bash
# Rebuild module dependency database after installing new modules:
depmod -a

# The result:
cat /lib/modules/$(uname -r)/modules.dep
# drivers/net/ethernet/intel/e1000e/e1000e.ko.xz: \
#     kernel/drivers/pci/pci.ko.xz
```

`depmod` reads each `.ko` file's undefined symbols and cross-references them against the exported symbols of other modules, producing a directed dependency graph. `modprobe` traverses this graph to ensure prerequisites are loaded first.

```bash
# Show dependencies of a module:
modinfo e1000e | grep depends

# Load a module and all its dependencies:
modprobe e1000e

# Remove a module and modules that depend on it (if not in use):
modprobe -r e1000e
```

---

## /sys/module/ and /proc/modules

```bash
# List all loaded modules with size and reference count:
cat /proc/modules
# e1000e 290816 0 - Live 0xffffffffc0234000
# Format: name size refcount dependencies state memaddr

# Or with lsmod (prettier):
lsmod

# Detailed module information:
ls /sys/module/e1000e/
# coresize  initsize  initstate  notes  parameters  refcnt  sections  srcversion  taint

cat /sys/module/e1000e/initstate
# live

# Module parameters:
ls /sys/module/e1000e/parameters/
cat /sys/module/e1000e/parameters/debug

# Section addresses (useful for debugging):
cat /sys/module/e1000e/sections/.text
```

---

## Module signing

`CONFIG_MODULE_SIG` enables cryptographic signature verification on module load. The kernel embeds a public key; modules are signed with the corresponding private key during the build.

```bash
# Sign a module manually (key must match kernel's built-in public key):
scripts/sign-file sha256 signing_key.pem signing_key.x509 mydriver.ko

# Check if a module is signed:
modinfo mydriver.ko | grep sig

# Verify signature:
openssl cms -verify -inform DER -in mydriver.ko ...
```

With `CONFIG_MODULE_SIG_FORCE`, any unsigned or incorrectly signed module is rejected. With `CONFIG_MODULE_SIG` but not `_FORCE`, unsigned modules are accepted with a taint flag:

```
mydriver: module verification failed: signature and/or required key missing
Tainted: G           E
```

The module signing infrastructure uses PKCS#7 signatures appended to the `.ko` file (after the ELF data).

---

## Initcall debugging

```bash
# Boot with initcall_debug to see every initcall and its duration:
# Add to kernel command line:
initcall_debug

# In dmesg:
# calling  e1000e_init_module+0x0/0x3c [e1000e] @ 3
# initcall e1000e_init_module+0x0/0x3c [e1000e] returned 0 after 1243 usecs

# The "@ N" is the CPU number; this helps identify parallelism issues.

# Find which initcall level a function is at:
grep '__initcall_' /proc/kallsyms | grep 'mydriver'

# Trace the module load path:
bpftrace -e '
kprobe:do_init_module {
    printf("loading module: %s\n",
           str(((struct module *)arg0)->name));
}'
```

---

## Further reading

- [Early Boot and start_kernel()](early-boot.md) — the initcall levels and `do_initcalls()`
- [Kernel Modules](../modules/README.md) — writing and building out-of-tree modules
- [Module Signing](../modules/module-signing.md) — key generation and signing workflow
- [Parameters, Symbols, and Kconfig](../modules/module-params.md) — `module_param()` in depth
- `kernel/module/main.c` — `load_module()`, `free_module()`, `do_init_module()`
- `include/linux/module.h` — `struct module`, `module_init()`, `EXPORT_SYMBOL()`
- `Documentation/kbuild/modules.rst` — building out-of-tree modules
- `Documentation/core-api/symbol-namespaces.rst` — EXPORT_SYMBOL_NS() for namespaced exports
