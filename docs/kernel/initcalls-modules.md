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

For a **built-in module** (`y` in Kconfig), `module_init()` doesn't expand directly to `device_initcall()` —
there's an indirection layer in between:

```c
#define module_init(x)     __initcall(x);
#define __initcall(fn)      device_initcall(fn)
#define device_initcall(fn) __define_initcall(fn, 6)
```

`__initcall(fn)` is itself just an alias for `device_initcall(fn)` (no behavioral difference — both land in
initcall level 6), but it's the macro `module_init()` actually invokes. `__define_initcall(fn, 6)` is what
places the function pointer in the `.initcall6.init` ELF section, called by `do_initcalls()` during boot. See
[Early Boot and start_kernel()](early-boot.md) for the full initcall level table.

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

    /* Exported symbols (GPL and non-GPL share one unified table;
     * each entry's license is carried in flagstab, not a separate array) */
    const struct kernel_symbol *syms;
    const u32 *crcs;
    const u8 *flagstab;
    unsigned int num_syms;

    /* Init and exit functions */
    int (*init)(void);
    void (*exit)(void);

    /* Reference counting */
    atomic_t refcnt;

    /* Module dependencies */
    struct list_head source_list;   /* modules that use this one (dependents) */
    struct list_head target_list;   /* modules this one depends on */

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
- `finit_module(fd, params, flags)` — loads a module from an already-open file descriptor rather than a userspace buffer (preferred since 3.8, especially by container runtimes and systemd); both syscalls funnel into the same `load_module()`, so `module_sig_check()` runs identically either way — `finit_module` doesn't change signature handling, it changes how the module image gets to the kernel

`insmod` uses `init_module`; `modprobe` uses `finit_module`.

### `load_module()`: step by step

`load_module()` in `kernel/module/main.c` does the heavy lifting:

```
load_module()
    1. module_sig_check()       [if CONFIG_MODULE_SIG]
       - Runs FIRST, before the ELF is even parsed
       - Verify the module's signature against the kernel's built-in
         public key (not PKCS#7 — see "Module signing" below for the
         real, non-standard signature format)
       - Fail if CONFIG_MODULE_SIG_FORCE and signature invalid

    2. elf_validity_cache_copy()
       - Verify ELF magic, architecture, section headers

    3. layout_and_allocate()
       - Compute section sizes
       - module_alloc(): allocate memory in module space
         (vmalloc region, or close to kernel text for 32-bit)

    4. add_unformed_module()
       - Adds the module to the global modules list, state =
         MODULE_STATE_UNFORMED, so a concurrent finit_module() of the
         same module is detected and rejected early
       - Runs right after allocation — well before init() is ever
         called, not after it

    5. Apply ELF relocations
       - apply_relocations(): resolve symbol references
       - Symbols resolved against:
         a. __ksymtab (unified table; each entry carries its own
            GPL/non-GPL license string, not a separate table)
         b. Other loaded modules' exported symbols

    6. post_relocation() -> module_finalize()
       - Set up alternatives (CPU feature patching)
       - Set up jump labels
       - Set up ORC unwind info

    7. complete_formation()
       - verify_exported_symbols(): reject a module that redefines an
         existing exported symbol name
       - Enable RO/NX/ROX memory protections on the module's sections
       - Set state = MODULE_STATE_COMING (do_init_module(), next, does
         NOT set this — it's already set by the time init() runs)

    8. mod_sysfs_setup()
       - Module directory created in /sys/module/

    9. do_init_module()
       - call module->init()   <-- driver's __init function runs
       - If init() returns 0: state = MODULE_STATE_LIVE
       - If init() returns non-zero: module loading fails,
         module freed, error returned to userspace
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

    4. free_module(): mod_sysfs_teardown() first
       - Remove from /sys/module/ (before the list unlink below,
         so nothing can look the module up mid-teardown)

    5. Remove from modules list and /proc/modules
       - list_del_rcu(&mod->list): a concurrent kallsyms walk of the
         list may still be in progress

    6. Synchronize with RCU (synchronize_rcu(), not rcu_barrier())
       - Waits out that grace period before the module's memory
         (which the list node lives inside) can be freed

    7. free_mod_mem(): return memory to vmalloc allocator
```

Modules cannot be unloaded while any code is executing in them (tracked by `refcnt`) or while any other module depends on them (tracked by the `source_list`).

---

## Symbol export

Only explicitly exported symbols are accessible to loadable modules. Both macros funnel into the same underlying `__EXPORT_SYMBOL()`, differing only in the license string each entry carries:

```c
/* include/linux/export.h */
#define _EXPORT_SYMBOL(sym, license)  __EXPORT_SYMBOL(sym, license, DEFAULT_SYMBOL_NAMESPACE)
#define EXPORT_SYMBOL(sym)            _EXPORT_SYMBOL(sym, "")
#define EXPORT_SYMBOL_GPL(sym)        _EXPORT_SYMBOL(sym, "GPL")
```

Each export creates a `struct kernel_symbol` in a single unified `__ksymtab` section (`kernel/module/internal.h`):

```c
struct kernel_symbol {
    int value_offset;    /* offset from this struct to the symbol */
    int name_offset;     /* offset from this struct to the name string */
    int namespace_offset;
};
```

The license string itself lives in the module's `flagstab` array (see `struct module` above), not a separate symbol table — there is no `__ksymtab_gpl`. During module loading, the relocation step resolves undefined symbols by searching `__ksymtab` (and the `__ksymtab` of already-loaded modules). If a resolved symbol's license is GPL-only and the loading module's `MODULE_LICENSE` is not GPL-compatible, the load fails:

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

# Confirm a signature is present (does not validate it):
modinfo mydriver.ko | grep sig
tail -c 28 mydriver.ko   # should read "~Module signature appended~"
```

With `CONFIG_MODULE_SIG_FORCE`, any unsigned or incorrectly signed module is rejected. With `CONFIG_MODULE_SIG` but not `_FORCE`, unsigned modules are accepted with a taint flag:

```
mydriver: module verification failed: signature and/or required key missing
Tainted: G           E
```

The signature is a small, kernel-specific `struct module_signature` trailer appended after the ELF data —
not a PKCS#7 (or any other industrial-standard) container. Per the kernel's own documentation: "the
signatures are not themselves encoded in any industrial standard type." That trailer's `id_type` field does
name a payload format for the signature bytes it wraps — currently only `PKCS7` is defined — but there's no
general-purpose `openssl`-style command that verifies it offline; validation only happens inside the kernel,
against its built-in public key, at load time.

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

### Kernel source

- [include/linux/module.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/module.h) — `module_init()` / `module_exit()` macros and the `struct module` definition
- [include/linux/init.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/init.h) — the initcall level macros (`early_initcall()` through `late_initcall()`) and `__define_initcall()`
- [kernel/module/main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/main.c) — `load_module()` and the steps it calls in order: `module_sig_check()`, `elf_validity_cache_copy()`, `layout_and_allocate()`, `add_unformed_module()`, `apply_relocations()`, `post_relocation()`, `complete_formation()`, `do_init_module()`; unloading via `SYSCALL_DEFINE2(delete_module, ...)` → `try_stop_module()` → `free_module()` (`mod_sysfs_teardown()`, `synchronize_rcu()`, `free_mod_mem()`)
- [include/uapi/linux/module_signature.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/module_signature.h) — `struct module_signature`, the custom trailer appended to a signed `.ko`
- [include/linux/export.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/export.h) — `EXPORT_SYMBOL()` and `EXPORT_SYMBOL_GPL()`
- [kernel/module/internal.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/internal.h) — the current `struct kernel_symbol` definition and the `__ksymtab` boundary symbols

### Man pages

- [`init_module(2)`](https://man7.org/linux/man-pages/man2/init_module.2.html) — loads a module from a userspace buffer
- [`finit_module(2)`](https://man7.org/linux/man-pages/man2/finit_module.2.html) — loads a module from a file descriptor; added in Linux 3.8
- [`delete_module(2)`](https://man7.org/linux/man-pages/man2/delete_module.2.html) — the syscall behind `rmmod`
- [`modprobe(8)`](https://man7.org/linux/man-pages/man8/modprobe.8.html) — dependency-aware module loading/removal
- [`depmod(8)`](https://man7.org/linux/man-pages/man8/depmod.8.html) — builds `modules.dep` from each module's undefined symbols

### Related pages

- [Early Boot and start_kernel()](early-boot.md) — the initcall levels and `do_initcalls()`
- [Kernel Modules](../modules/README.md) — writing and building out-of-tree modules
- [Module Signing](../modules/module-signing.md) — key generation and signing workflow
- [Parameters, Symbols, and Kconfig](../modules/module-params.md) — `module_param()` in depth

### LWN articles

- [LWN: Enforcement (or not) for module-specific exported symbols](https://lwn.net/Articles/1029492/) — the debate over restricting exports to a named set of in-tree modules; the macro discussed was proposed as `EXPORT_SYMBOL_GPL_FOR_MODULES()` and merged as `EXPORT_SYMBOL_FOR_MODULES()`, dropping the `GPL_` (see the Kernel source entry above)
- [LWN: The proper use of EXPORT_SYMBOL_GPL()](https://lwn.net/Articles/769471/) — how maintainers decide when an exported symbol should be GPL-only

### External

- [Kernel module signing facility](https://docs.kernel.org/admin-guide/module-signing.html) — `CONFIG_MODULE_SIG`, key generation, and `scripts/sign-file`
- [Building External Modules](https://docs.kernel.org/kbuild/modules.html) — kbuild mechanics for out-of-tree modules
- [Symbol Namespaces](https://docs.kernel.org/core-api/symbol-namespaces.html) — `EXPORT_SYMBOL_NS()` for namespaced exports
