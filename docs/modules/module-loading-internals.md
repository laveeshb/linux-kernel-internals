# Module Loading Internals

> What load_module() does: ELF parsing, relocation, symbol resolution, and versioning

## The syscalls

Two syscalls can load a kernel module:

```c
/* Load from a buffer in userspace — the original interface */
long init_module(void __user *umod, unsigned long len, const char __user *uargs);

/* Load from a file descriptor — added in Linux 3.8 */
long finit_module(int fd, const char __user *uargs, int flags);
```

`finit_module()` was added for two reasons: it allows the kernel to verify a module's signature before the image is copied into kernel memory (the file descriptor can be authenticated), and it avoids a double-copy when loading from a file. Both syscalls eventually call `load_module()` in `kernel/module/main.c`.

`finit_module()` accepts flags such as `MODULE_INIT_IGNORE_MODVERSIONS` (bypass CRC checks) and `MODULE_INIT_IGNORE_VERMAGIC` (bypass version string check). Using these flags taints the kernel.

## load_module(): the ten steps

`load_module()` takes the raw ELF bytes and produces a running module. Here is the high-level sequence:

### 1. Copy the ELF image from userspace

```c
/* Allocates a kernel buffer and copies from userspace */
info.hdr = copy_module_from_user(umod, len, &info);
```

For `finit_module()`, the kernel reads the file via `kernel_read_file_from_fd()` instead. The resulting buffer is a complete ELF relocatable object (`.ko` file).

### 2. Sanity-check the ELF header

The kernel verifies:
- `e_ident` contains the ELF magic bytes (`\x7fELF`)
- `e_type == ET_REL` — modules are relocatable objects, not executables or shared libraries
- Section headers are present and within bounds
- The ELF class matches the running kernel (64-bit kernel rejects 32-bit ELF)

A "vermagic" string is embedded in `.modinfo` and checked against the running kernel's version, SMP configuration, and preemption model. Mismatch causes `ENOEXEC`.

### 3. Find key sections

The loader finds these sections by iterating the section header table:

| Section | Purpose |
|---------|---------|
| `.gnu.linkonce.this_module` | Contains the module's `struct module` |
| `.modinfo` | Null-separated `key=value` strings (license, author, description, vermagic) |
| `.init.text` | Init code — freed after `mod->init()` returns |
| `.exit.text` | Cleanup code — kept until unload |
| `__versions` | Array of `struct modversion_info` for CRC checking |
| `__ksymtab` / `__ksymtab_gpl` | Exported symbols this module provides |
| `__kcrctab` / `__kcrctab_gpl` | CRCs for this module's exported symbols |

### 4. Allocate module memory

Module code and data live in a dedicated allocator:

```c
/* Allocates memory in the module region — within 2 GB of the kernel image */
void *module_alloc(unsigned long size);
```

On x86-64, the module region sits near `0xffffffffa0000000`. The proximity is mandatory: the compiler generates 32-bit PC-relative relocations (`R_X86_64_PC32`, `R_X86_64_PLT32`) whose signed 32-bit offset can only reach ±2 GB from the instruction. If the module were placed further away, these relocations would overflow.

Two regions are allocated:

- **Init layout** (`mod->init_layout`): holds `.init.text`, `.init.data`, and related sections. Freed by `do_free_init()` after `mod->init()` returns.
- **Core layout** (`mod->core_layout`): holds `.text`, `.data`, `.rodata`, `__ksymtab`, and everything that persists while the module is loaded.

### 5. Copy sections to their final locations

Each section is copied or zeroed into the allocated regions. After this step, the module's code and data are at their final runtime addresses.

### 6. Apply relocations

The ELF `.rela.*` sections contain relocation entries. The kernel applies them with:

```c
/* Arch-independent dispatch */
int apply_relocations(struct module *mod, const struct load_info *info);

/* Arch-specific implementation (e.g., arch/x86/kernel/module.c) */
int apply_relocate_add(Elf64_Shdr *sechdrs, const char *strtab,
                       unsigned int symindex, unsigned int relsec,
                       struct module *mod);
```

On x86-64, the common relocation types are:

| Type | Meaning |
|------|---------|
| `R_X86_64_64` | 64-bit absolute address |
| `R_X86_64_PC32` | 32-bit PC-relative (used for `call`, `jmp` to nearby symbols) |
| `R_X86_64_PLT32` | 32-bit PC-relative via PLT — used for calls that may go through a thunk |
| `R_X86_64_32S` | 32-bit sign-extended absolute |

For each relocation entry, the kernel: looks up the target symbol's final address, computes the value (`S + A - P` for PC-relative), and writes it into the instruction at the relocation offset.

### 7. Resolve symbols

```c
/* Walks the module's symbol table and resolves undefined symbols */
static int simplify_symbols(struct module *mod, const struct load_info *info);
```

For each symbol with `STB_UNDEFINED` binding, `simplify_symbols()` calls `resolve_symbol()`, which searches:

1. The kernel's built-in symbol table (`kernel_symbol_hash`) — populated at compile time from `__ksymtab` entries of vmlinux and built-in modules.
2. The `__ksymtab` sections of all already-loaded modules, via `find_symbol()`.

If a symbol is found but is GPL-only and the module is not GPL-licensed, the load fails with `ENOEXEC`. If a symbol is not found at all, the load fails with `ENOENT` and prints `Unknown symbol <name>` to the kernel log.

### 8. Verify CRC checksums

With `CONFIG_MODVERSIONS=y`, every undefined symbol reference is paired with a CRC stored in the `__versions` section:

```c
struct modversion_info {
    unsigned long crc;
    char          name[MODULE_NAME_LEN];
};
```

`check_version()` compares the module's stored CRC for each imported symbol against the kernel's `__crc_<symbolname>` (a per-symbol absolute value generated at kernel build time by `genksyms`). A mismatch means the symbol's type signature differs between the kernel the module was built against and the running kernel — loading fails with `ENOEXEC` and the message:

```
mymodule: disagrees about version of symbol module_layout
```

### 9. Run module notifiers

Before calling the module's init function, the kernel notifies registered listeners:

```c
blocking_notifier_call_chain(&module_notify_list,
                             MODULE_STATE_COMING, mod);
```

Subsystems like ftrace, kprobes, and the live-patching infrastructure use these notifiers to patch the new module's code (e.g., installing ftrace trampolines).

### 10. Call mod->init()

The module's init function is called:

```c
ret = do_one_initcall(mod->init);
```

A return value of `0` means success — the module transitions to `MODULE_STATE_LIVE`. A negative errno means failure — the kernel calls `module_put()`, notifies `MODULE_STATE_GOING`, runs the exit function if one was registered, and frees both memory regions.

## struct module

`struct module` (defined in `include/linux/module.h`) is the kernel's runtime representation of a loaded module. Key fields:

```c
struct module {
    enum module_state    state;         /* current lifecycle state */
    struct list_head     list;          /* linked into global modules list */
    char                 name[MODULE_NAME_LEN];

    /* Memory regions */
    struct module_layout core_layout;   /* persistent text/data */
    struct module_layout init_layout;   /* freed after init */

    /* Exported symbols */
    const struct kernel_symbol *syms;
    const s32                  *crcs;
    unsigned int                num_syms;

    /* GPL-only exported symbols */
    const struct kernel_symbol *gpl_syms;
    const s32                  *gpl_crcs;
    unsigned int                num_gpl_syms;

    /* Entry points */
    int  (*init)(void);
    void (*exit)(void);

    /* Dependency tracking */
    struct list_head source_list;  /* modules that use symbols from us */
    struct list_head target_list;  /* modules whose symbols we use */

    /* Reference counting */
    struct module_ref __percpu *refptr;
};
```

`source_list` and `target_list` together form the dependency graph that `rmmod` walks to verify nothing depends on the module being removed.

## MODULE_STATE_* lifecycle

```
insmod/modprobe
      │
      ▼
 UNFORMED ── (allocation and ELF setup)
      │
      ▼
  COMING  ── (notifiers fire, ftrace patches applied)
      │
      ▼
   LIVE   ← module is active and usable
      │
   rmmod  (only if refcount == 0)
      │
      ▼
  GOING   ── (notifiers fire, users drained)
      │
      ▼
  (freed) ── module_memfree() releases core_layout
```

The `GOING` state is visible to other CPUs via the global modules list. Code that holds a reference to a symbol in the module must not be executing when the module reaches `GOING`.

## /proc/modules format

```bash
cat /proc/modules
# e1000e 262144 0 - Live 0xffffffffc0400000
# ^^^^^^ ^^^^^^ ^ ^ ^^^^ ^^^^^^^^^^^^^^^^^
# name   size   | |  |   load address
#              |  |  state (Live/Loading/Unloading)
#           deps  refcount
```

Fields:
- **size**: total size of the core layout in bytes
- **refcount**: current use count (`-1` means permanent/built-in style; `0` means removable)
- **deps**: comma-separated list of modules this module depends on (`-` if none)
- **state**: `Live`, `Loading`, or `Unloading`
- **load address**: base address of the core text region

## Symbol versioning detail

`genksyms` runs at kernel build time and computes a CRC over the full C type signature (recursively including struct/union layouts) of each exported symbol. The CRC is stored in `Module.symvers`:

```bash
# Format: CRC  symbol_name  vmlinux_or_module  namespace
cat Module.symvers | grep module_layout
# 0xdeadbeef   module_layout   vmlinux   (none)
```

When building an out-of-tree module, `make` reads `Module.symvers` from `$(KDIR)` to embed the correct CRCs in the module's `__versions` section. Building against the wrong `Module.symvers` is the most common cause of version mismatch errors.

## Further reading

- [Module Parameters, Symbols, and Kconfig](module-params.md) — EXPORT_SYMBOL, Module.symvers, KBUILD_EXTRA_SYMBOLS
- [Module Signing](module-signing.md) — how finit_module() enables signature verification
- [Kbuild Build System](kbuild.md) — out-of-tree builds and cross-compilation
- `kernel/module/main.c` — load_module() implementation
- `include/linux/module.h` — struct module definition
- `Documentation/kbuild/modules.rst` — out-of-tree module build guide
