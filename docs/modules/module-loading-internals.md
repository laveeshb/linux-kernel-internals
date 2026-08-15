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

`finit_module()` was added so the kernel can reason about where a module *came from*, not just what bytes it contains. A file descriptor names a file on a filesystem, so the kernel and any LSM can consider the file's provenance — a signature held in an extended attribute, a dm-verity-protected root filesystem — rather than judging an anonymous userspace buffer. Both syscalls eventually call `load_module()` in `kernel/module/main.c`.

`finit_module()` accepts exactly three flags; anything else in `flags` is rejected with `EINVAL`:

- `MODULE_INIT_IGNORE_MODVERSIONS` — zero out the version-section indices so the CRC comparison is skipped
- `MODULE_INIT_IGNORE_VERMAGIC` — treat the module as having no vermagic string, skipping the version-string comparison
- `MODULE_INIT_COMPRESSED_FILE` — the file is a compressed `.ko` in whichever single format the kernel was built with (`CONFIG_MODULE_COMPRESS_GZIP`, `_XZ`, or `_ZSTD` — `kernel/module/decompress.c` selects exactly one with an `#if`/`#elif` chain); the kernel decompresses it itself via `module_decompress()`

The first two flags route through `try_to_force_load()`, which taints the kernel with `TAINT_FORCED_MODULE` (`F`) when `CONFIG_MODULE_FORCE_LOAD=y` and fails the load with `ENOEXEC` when it is not.

## load_module(): step by step

`load_module()` takes the raw ELF bytes and produces a running module. Step 1 happens in the syscall wrappers, just before `load_module()` is entered; steps 2 through 11 are the body of `load_module()` itself, in the order its work happens (step 8's version check runs inside step 7's symbol resolution, not as a separate pass).

### 1. Get the ELF image into the kernel

Neither syscall hands `load_module()` a userspace pointer. Each one first materialises the whole `.ko` in kernel memory and fills in a `struct load_info`, which carries `info->hdr` (the image) and `info->len` (its length) through every later stage.

`init_module()` uses `copy_module_from_user()`:

```c
/* kernel/module/main.c — abridged */
info->hdr = __vmalloc(info->len, GFP_KERNEL | __GFP_NOWARN);
if (!info->hdr)
        return -ENOMEM;

if (copy_chunked_from_user(info->hdr, umod, info->len) != 0) {
        err = -EFAULT;
        goto out;
}
```

`copy_chunked_from_user()` is a loop around `copy_from_user()` that moves at most `16 * PAGE_SIZE` per iteration and calls `cond_resched()` between chunks, so copying a large module does not hold the CPU for an unbounded time.

`finit_module()` takes a different route: `idempotent_init_module()` → `init_module_from_file()`, which reads the file with

```c
len = kernel_read_file(f, 0, &buf, INT_MAX, NULL,
                       compressed ? READING_MODULE_COMPRESSED :
                                    READING_MODULE);
```

If `MODULE_INIT_COMPRESSED_FILE` was passed, `module_decompress()` expands `buf` into `info->hdr`; otherwise `buf` *is* `info->hdr`. The `idempotent_*` wrapper deduplicates concurrent loads: it hashes the file's inode into a small hash table, and if another task is already loading that same inode, the second caller simply waits on a completion and returns the first caller's result instead of doing the work twice.

Either way, the resulting buffer is a complete ELF relocatable object.

### 2. Check the module signature

`module_sig_check()` runs first, before any section is examined, so a corrupt image cannot steer the loader before its authenticity is established. It also trims the appended signature off the end of the image by adjusting `info->len`, which makes every subsequent bounds check operate on the real ELF length. See [Kernel Module Signing](module-signing.md) for the details.

### 3. Validate the ELF headers and cache the section table

`elf_validity_cache_copy()` performs the structural checks and records the indices of the sections the loader will need later. It verifies, among other things:

- `e_ident` starts with the ELF magic bytes (`\x7fELF`)
- `e_type == ET_REL` — modules are relocatable objects, not executables or shared libraries
- `elf_check_arch()` accepts `e_machine` (on x86-64, `EM_X86_64`)
- `e_shentsize` equals the running kernel's `sizeof(Elf_Shdr)`, and the section header array lies inside `info->len`
- Section 0 is a proper `SHT_NULL` entry with zero size and address
- Every section's contents are in bounds

Failures here return `ENOEXEC`. On success `info->mod` points at the module's on-disk `struct module` inside the temporary image, and `info->index.*` holds the cached section indices (`.modinfo`, symbol table, string table, `__versions`, and the extended-modversions pair).

### 4. Early checks: blacklist, module_layout CRC, vermagic

`early_mod_check()` runs the checks that can be made before anything is allocated:

- `blacklisted()` compares the module name against the comma-separated `module_blacklist=` boot parameter, returning `EPERM` if it is listed
- `rewrite_section_headers()` points every `sh_addr` at the temporary image and clears `SHF_ALLOC` on `.modinfo` and the version sections, so they are usable during the load but never copied into the module's runtime memory
- `check_modstruct_version()` runs the modversions check against the pseudo-symbol `module_layout`, catching a module built against an incompatible `struct module`
- `check_modinfo()` compares the module's `vermagic` string from `.modinfo` against the running kernel's, returning `ENOEXEC` on mismatch
- `module_patient_check_exists()` rejects a duplicate name — waiting first if an existing module of that name is still `COMING` or `UNFORMED`, then returning `EEXIST` if it went `LIVE` and `EBUSY` otherwise

The vermagic comparison is where the classic "version magic" error originates:

```c
} else if (!same_magic(modmagic, vermagic, info->index.vers)) {
        pr_err("%s: version magic '%s' should be '%s'\n",
               info->name, modmagic, vermagic);
        return -ENOEXEC;
}
```

`same_magic()` skips the leading kernel-release word of the string when the module carries CRCs, so a modversions-enabled module is judged on the remaining configuration fields (SMP, preemption model, module unload support, and so on) rather than on an exact release match.

### 5. Lay out and allocate module memory

`layout_and_allocate()` assigns every `SHF_ALLOC` section an offset within one of seven memory classes, then `move_module()` allocates each class and copies the sections in.

The old two-region model — `mod->core_layout` and `mod->init_layout`, both `struct module_layout` — is gone. Since commit `ac3b43283923` (v6.4) a module owns an array of independently allocated regions:

```c
/* include/linux/module.h */
enum mod_mem_type {
        MOD_TEXT = 0,
        MOD_DATA,
        MOD_RODATA,
        MOD_RO_AFTER_INIT,
        MOD_INIT_TEXT,
        MOD_INIT_DATA,
        MOD_INIT_RODATA,

        MOD_MEM_NUM_TYPES,
        MOD_INVALID = -1,
};

struct module {
        ...
        struct module_memory mem[MOD_MEM_NUM_TYPES] __module_memory_align;
};
```

| Class | Holds | Lifetime |
|-------|-------|----------|
| `MOD_TEXT` | executable sections (`SHF_EXECINSTR \| SHF_ALLOC`) | until unload |
| `MOD_DATA` | writable data, plus arch small-data sections | until unload |
| `MOD_RODATA` | allocated, non-writable data | until unload |
| `MOD_RO_AFTER_INIT` | `SHF_RO_AFTER_INIT` sections — writable during init, sealed afterwards | until unload |
| `MOD_INIT_TEXT` | `.init.text` | freed after init |
| `MOD_INIT_DATA` | `.init.data` | freed after init |
| `MOD_INIT_RODATA` | `.init.rodata` | freed after init |

Splitting text from data this way is what lets `complete_formation()` apply different page permissions to each class rather than to one undifferentiated blob.

Each class is allocated by `module_memory_alloc()`, which no longer has an allocator of its own — `module_alloc()` was replaced by the generic executable-memory allocator:

```c
/* kernel/module/main.c — abridged */
static int module_memory_alloc(struct module *mod, enum mod_mem_type type)
{
        unsigned int size = PAGE_ALIGN(mod->mem[type].size);
        enum execmem_type execmem_type;
        void *ptr;

        if (mod_mem_type_is_data(type))
                execmem_type = EXECMEM_MODULE_DATA;
        else
                execmem_type = EXECMEM_MODULE_TEXT;

        ptr = execmem_alloc_rw(execmem_type, size);
        ...
}
```

`EXECMEM_MODULE_TEXT` maps to the architecture's module region. On x86-64 that region starts at

```c
/* arch/x86/include/asm/pgtable_64_types.h */
#define MODULES_VADDR   (__START_KERNEL_map + KERNEL_IMAGE_SIZE)

#ifndef CONFIG_DEBUG_KMAP_LOCAL_FORCE_MAP
# define MODULES_END    _AC(0xffffffffff000000, UL)
#else
# define MODULES_END    _AC(0xfffffffffe000000, UL)
#endif
```

With `__START_KERNEL_map` at `0xffffffff80000000` and `KERNEL_IMAGE_SIZE` at 1 GiB — the value used when `CONFIG_RANDOMIZE_BASE` (KASLR) is enabled, as it is in essentially every distribution kernel — modules start at `0xffffffffc0000000`, which is why loaded modules show addresses like `0xffffffffc0400000` in `/proc/modules`. Without KASLR the image limit shrinks to 512 MiB and the module region starts at `0xffffffffa0000000` instead, growing to 1.5 GiB.

The proximity to the kernel image is mandatory, not incidental: the compiler generates 32-bit PC-relative relocations (`R_X86_64_PC32`, `R_X86_64_PLT32`) whose signed 32-bit offset can only reach ±2 GB from the instruction. Placing modules further away would overflow them.

### 6. Find the optional sections

With the module at its final address, `find_module_sections()` records pointers into the sections the kernel will consult at runtime. Together with the indices cached back in step 3, these are the sections that matter to a load:

| Section | Purpose |
|---------|---------|
| `.gnu.linkonce.this_module` | the module's `struct module` |
| `.modinfo` | null-separated `key=value` strings (license, author, description, vermagic) |
| `.init.text` | init code — freed after `mod->init()` returns |
| `.exit.text` | cleanup code — kept until unload with `CONFIG_MODULE_UNLOAD=y`; laid out as init memory and freed otherwise |
| `__versions` | array of `struct modversion_info` for CRC checking |
| `__version_ext_crcs` / `__version_ext_names` | the extended-modversions form of the same data, for long symbol names |
| `__ksymtab` | exported symbols this module provides |
| `__kcrctab` | CRCs for this module's exported symbols |
| `__kflagstab` | one flag byte per `__ksymtab` entry — `KSYM_FLAG_GPL_ONLY` marks a GPL-only export |
| `__param` | the module's `module_param()` entries |

There is no longer a separate `__ksymtab_gpl`. Since commit `55fcb926b6d8` (v7.1) GPL-only status is a bit in the parallel `__kflagstab` byte array, and the loader warns if it finds the old sections:

```c
/* — abridged, omitting the earlier mod->kp = section_objs(info, "__param", ...) — */
mod->syms = section_objs(info, "__ksymtab", sizeof(*mod->syms), &mod->num_syms);
mod->crcs = section_addr(info, "__kcrctab");
mod->flagstab = section_addr(info, "__kflagstab");

if (section_addr(info, "__ksymtab_gpl"))
        pr_warn("%s: ignoring obsolete section __ksymtab_gpl\n", mod->name);
if (section_addr(info, "__kcrctab_gpl"))
        pr_warn("%s: ignoring obsolete section __kcrctab_gpl\n", mod->name);
```

`check_export_symbol_sections()` then rejects with `ENOEXEC` any module that exports symbols but ships no `__kflagstab`.

### 7. Resolve symbols

Symbol resolution comes **before** relocation, and necessarily so: a relocation against an undefined symbol needs that symbol's address, which resolution is what supplies. `load_module()` calls them in exactly that order:

```c
/* Fix up syms, so that st_value is a pointer to location. */
err = simplify_symbols(mod, info);
if (err < 0)
        goto free_modinfo;

err = apply_relocations(mod, info);
if (err < 0)
        goto free_modinfo;
```

`simplify_symbols()` walks the module's symbol table and switches on each entry's `st_shndx`. Defined symbols get their section's base address added to `st_value`; `SHN_ABS` symbols are left alone; percpu symbols are diverted to the module's percpu allocation. Undefined symbols go to the lookup path:

```c
case SHN_UNDEF:
        ksym = resolve_symbol_wait(mod, info, name);
        /* Ok if resolved.  */
        if (ksym && !IS_ERR(ksym)) {
                sym[i].st_value = kernel_symbol_value(ksym);
                break;
        }
        ...
        ret = PTR_ERR(ksym) ?: -ENOENT;
        pr_warn("%s: Unknown symbol %s (err %d)\n", mod->name, name, ret);
```

`resolve_symbol_wait()` wraps `resolve_symbol()` in a `wait_event_interruptible_timeout()` with a 30-second budget. The wait exists for dependency ordering: if the module that exports the symbol is itself mid-load and still in `MODULE_STATE_COMING`, `strong_try_module_get()` returns `-EBUSY`, and rather than failing the load the kernel sleeps until the provider goes `LIVE` or the timeout expires (`gave up waiting for init of module %s`).

`resolve_symbol()` calls `find_symbol()`, which searches, in order:

1. vmlinux's own exports, between the `__start___ksymtab` and `__stop___ksymtab` linker symbols
2. the `__ksymtab` of every loaded module not in `MODULE_STATE_UNFORMED`

Both are sorted arrays of `struct kernel_symbol`, and `find_exported_symbol_in_section()` locates a name with `bsearch()` rather than a hash lookup. There is one table per provider, not two — GPL-only status is read out of the matching `__kflagstab` byte after the search hits:

```c
sym = bsearch(fsa->name, syms->start, syms->stop - syms->start,
              sizeof(struct kernel_symbol), cmp_name);
if (!sym)
        return false;

sym_flags = *(syms->flagstab + (sym - syms->start));
if (!fsa->gplok && (sym_flags & KSYM_FLAG_GPL_ONLY))
        return false;
```

That `return false` is why a proprietary module reaching for a GPL-only export does not get a distinct "license" error: the entry is skipped as though it were not there, `find_symbol()` reports failure, and `simplify_symbols()` ends up at its `-ENOENT` path, printing `Unknown symbol <name>` like any genuinely missing symbol. The same lookup also sets `mod->using_gplonly_symbols` when a GPL-only export *is* successfully consumed, which later prevents such a module from also importing from a proprietary one.

### 8. Verify CRC checksums

Version checking is not a separate pass — `resolve_symbol()` calls `check_version()` on each symbol it finds, during step 7. With `CONFIG_MODVERSIONS=y`, every imported symbol carries a CRC in the module's `__versions` section:

```c
struct modversion_info {
    unsigned long crc;
    char          name[MODULE_NAME_LEN];
};
```

`MODULE_NAME_LEN` is `64 - sizeof(unsigned long)`, so 56 bytes on 64-bit — which is not enough for every exported symbol name. The newer *extended modversions* format splits the record in two, a `__version_ext_crcs` array of `u32` and a `__version_ext_names` blob of null-terminated strings of unbounded length. `check_version()` prefers it when present:

```c
/* If we have extended version info, rely on it */
if (info->index.vers_ext_crc) {
        for_each_modversion_info_ext(version_ext, info) {
                ...
        }
}
```

and falls back to the fixed-size `struct modversion_info` array otherwise.

Either way, the module's recorded CRC is compared against the CRC the *providing* side supplied (`fsa.crc`, read from the provider's `__kcrctab`). A mismatch means the symbol's type signature differs between the kernel the module was built against and the running kernel. `check_version()` logs

```
mymodule: disagrees about version of symbol tcp_sendmsg
```

and returns 0, whereupon `resolve_symbol()` fails that symbol with `EINVAL`:

```c
if (!check_version(info, name, mod, fsa.crc)) {
        fsa.sym = ERR_PTR(-EINVAL);
        goto getname;
}
```

That `EINVAL` path is reached only by *ordinary* imported symbols. The `module_layout` pseudo-symbol never travels it: `modpost` synthesises it with `sym_add_unresolved("module_layout", mod, false)` purely so it gets a row in the module's CRC table, and the module contains no undefined ELF reference to it — so `simplify_symbols()` and `resolve_symbol()` never see it. Its CRC is compared once, much earlier, by `check_modstruct_version()` in step 4, and `early_mod_check()` turns the failure into `ENOEXEC` (`Invalid module format`).

It is worth keeping the failure codes apart, because they are easy to confuse from userspace:

| Condition | errno | Raised by |
|-----------|-------|-----------|
| Vermagic string mismatch | `ENOEXEC` | `check_modinfo()`, step 4 |
| `module_layout` CRC mismatch | `ENOEXEC` | `check_modstruct_version()` via `early_mod_check()`, step 4 |
| Imported symbol CRC mismatch | `EINVAL` | `resolve_symbol()`, via `check_version()` |
| Symbol missing, or GPL-only and unreachable | `ENOENT` | `simplify_symbols()` |

### 9. Apply relocations

The ELF `.rela.*` sections contain relocation entries, now resolvable because step 7 filled in every `st_value`. The kernel applies them with:

```c
/* Arch-independent dispatch */
static int apply_relocations(struct module *mod, const struct load_info *info);

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

For each entry the kernel computes `val = sym->st_value + r_addend`, subtracts the relocation's own address for the PC-relative types, and writes the result at the relocation offset. The PC-relative types (`R_X86_64_PC32`/`PLT32`) are not range-checked at all — if a target exceeds the ±2 GB reach discussed in step 5, the truncation is silent. `R_X86_64_32S` and `R_X86_64_32` are absolute-address types instead: they fail the load with `ENOEXEC` ("overflow") if `val` doesn't survive the narrowing, which is the `-mcmodel=kernel` constraint (a module's absolute symbol references must fit the top 2 GB of the address space), not the same ±2 GB PC-relative window.

### 10. Complete formation and fire the COMING notifiers

`complete_formation()` does the work that makes the module safe for other CPUs to observe. Under `module_mutex` it checks for duplicate exports with `verify_exported_symbols()`, finalises the BUG and CFI tables, applies page permissions to the memory classes allocated in step 5 (`module_enable_rodata_ro()`, `module_enable_data_nx()`, `module_enable_text_rox()`), and only then publishes the state change:

```c
/*
 * Mark state as coming so strong_try_module_get() ignores us,
 * but kallsyms etc. can see us.
 */
mod->state = MODULE_STATE_COMING;
```

The notifiers fire afterwards, from `prepare_coming_module()`:

```c
err = blocking_notifier_call_chain_robust(&module_notify_list,
                MODULE_STATE_COMING, MODULE_STATE_GOING, mod);
err = notifier_to_errno(err);
```

The `_robust` variant is the important detail: if any callback in the chain fails, it automatically replays the chain with `MODULE_STATE_GOING` for the callbacks that already succeeded, so a subsystem that patched the module can undo its work. Subsystems such as kprobes register on this chain (`kprobe_register_module_notifier()`) to instrument the new module's code; ftrace and live-patching are wired in directly instead — `ftrace_module_enable()` and `klp_module_coming()` run just before the chain, for the same reason.

### 11. Call mod->init()

`load_module()` ends with `return do_init_module(mod);`, and `do_init_module()` invokes the module's init function through `do_one_initcall()` — the very same helper used for built-in initcalls. That is why the `initcall_blacklist=` boot parameter works on module init functions too: `initcall_blacklisted()` resolves the function pointer with `sprint_symbol_no_offset()` and strips the `[module_name]` suffix before comparing. Going through `do_one_initcall()` also gets a module's init the initcall tracepoints and the `WARN` for leaving preemption or interrupt state imbalanced.

```c
do_mod_ctors(mod);
/* Start the module */
if (mod->init != NULL)
        ret = do_one_initcall(mod->init);
```

**On success** (`ret == 0`) the module becomes `MODULE_STATE_LIVE`, the `MODULE_STATE_LIVE` notifier fires, a `KOBJ_ADD` uevent is emitted, the initial reference is dropped with `module_put()`, and the three init memory classes are detached from `mod->mem[]`. A positive return is accepted but warned about (`init suspiciously returned %d`).

The init memory is *not* freed inline. The bases are pushed onto a lockless list and a workqueue item is scheduled:

```c
if (llist_add(&freeinit->node, &init_free_list))
        schedule_work(&init_free_wq);
```

`do_free_init()` then runs from that workqueue, waits out an RCU grace period (kallsyms may be walking the init symbols inside an RCU read-side section), and only then calls `execmem_free()` on each region. `module_memfree()` is gone along with `module_alloc()`.

```c
static void do_free_init(struct work_struct *w)
{
        ...
        synchronize_rcu();

        llist_for_each_safe(pos, n, list) {
                initfree = container_of(pos, struct mod_initfree, node);
                execmem_free(initfree->init_text);
                execmem_free(initfree->init_data);
                execmem_free(initfree->init_rodata);
                kfree(initfree);
        }
}
```

**On failure** (a negative return) the module is torn down without ever running its exit function — `mod->exit()` is only for `rmmod`, and a module whose init failed is assumed not to have finished setting anything up:

```c
fail:
        /* Try to protect us from buggy refcounters. */
        mod->state = MODULE_STATE_GOING;
        synchronize_rcu();
        module_put(mod);
        blocking_notifier_call_chain(&module_notify_list,
                                     MODULE_STATE_GOING, mod);
        klp_module_going(mod);
        ftrace_release_mod(mod);
        free_module(mod);
```

One errno is rewritten on the way out. `EEXIST` is reserved by `init_module()`/`finit_module()` to tell userspace that a module of this name is already loaded, so a module whose own init returns `-EEXIST` has it remapped:

```c
if (ret == -EEXIST)
        ret = -EBUSY;
```

## struct module

`struct module` (defined in `include/linux/module.h`) is the kernel's runtime representation of a loaded module. Key fields:

```c
struct module {
    enum module_state    state;         /* current lifecycle state */
    struct list_head     list;          /* linked into global modules list */
    char                 name[MODULE_NAME_LEN];

    /* Exported symbols — one table, plus a parallel flag byte per entry */
    const struct kernel_symbol *syms;
    const u32                  *crcs;
    const u8                   *flagstab;
    unsigned int                num_syms;

    /* Set when this module successfully imported a GPL-only export */
    bool using_gplonly_symbols;

    /* Startup function */
    int (*init)(void);

    /* Memory regions — one per class, allocated independently */
    struct module_memory mem[MOD_MEM_NUM_TYPES] __module_memory_align;

#ifdef CONFIG_MODULE_UNLOAD
    /* What modules depend on me? */
    struct list_head source_list;
    /* What modules do I depend on? */
    struct list_head target_list;

    /* Destruction function. */
    void (*exit)(void);

    atomic_t refcnt;
#endif
};
```

The two dependency lists are named from the perspective of a `struct module_use` edge, which records a `source` (the importing module) and a `target` (the exporting module). `add_module_usage(a, b)` — where `a` imports from `b` — links the edge onto `b->source_list` and onto `a->target_list`. So:

- **`source_list`** holds the edges whose `target` is this module: **what depends on me**. This is the list `lsmod` renders in its "Used by" column.
- **`target_list`** holds the edges whose `source` is this module: **what I depend on**.

Together they form the dependency graph that `rmmod` walks: a module can only be removed when its `source_list` is empty and its `refcnt` has drained.

Note that the unload machinery — both lists, `exit`, and the reference count — only exists under `CONFIG_MODULE_UNLOAD`. Build without it and modules are load-only, which is why `print_unload_info()` has a stub that prints two literal dashes instead of a refcount and a dependency list.

The reference count itself is a plain `atomic_t refcnt`. The per-CPU `struct module_ref __percpu *refptr` it replaced has been gone since v3.19.

## MODULE_STATE_* lifecycle

```
insmod / modprobe
      │
      ▼
 UNFORMED    add_unformed_module(): the name is reserved in the modules
      │      list, but find_symbol() and /proc/modules both skip it
      ▼
  COMING     complete_formation() seals page permissions and sets the
      │      state; prepare_coming_module() then runs ftrace/klp setup
      │      and the COMING notifier chain
      ▼
 do_init_module() → do_one_initcall(mod->init)
      │
      ├── returns 0 ──────────────► LIVE
      │                              │   init memory goes to a workqueue;
      │                              │   do_free_init() waits an RCU grace
      │                              │   period, then execmem_free()s it
      │                              │
      │                            rmmod   (needs an empty source_list and
      │                              │       a drained refcnt; runs mod->exit())
      │                              ▼
      └── returns < 0 ────────────► GOING
                                     │   GOING notifier fires. mod->exit() is
                                     │   NOT called on this path — a failed
                                     │   init never gets its exit function
                                     ▼
                                  free_module() → execmem_free() per mem[] class
```

The `UNFORMED` and `COMING` states are both visible to other CPUs through the global modules list, and both are special-cased there: `find_symbol()` skips `UNFORMED` modules outright, `m_show()` omits them from `/proc/modules`, and `strong_try_module_get()` refuses a `COMING` module with `-EBUSY` so a dependent load waits rather than binding to a half-built provider. (`GOING` gets no such special-casing in `find_symbol()` — a module can still export symbols while unloading — but `m_show()` does print it, as `Unloading`.) What guarantees no thread is still executing *inside* a module by the time it reaches `GOING` is the reference count, not RCU: `try_module_get()`/`module_put()` (and `strong_try_module_get()` behind `__symbol_get()`) hold the count up, and `delete_module()` will not set `GOING` with a live count remaining unless the caller forces it (`try_stop_module()` sets `GOING` regardless of count when `try_force_unload()` succeeds, gated on `CONFIG_MODULE_FORCE_UNLOAD` and the `O_TRUNC` flag to `delete_module(2)`) — otherwise `try_release_module_ref()` puts the base reference back and `try_stop_module()` returns `-EWOULDBLOCK`, failing `rmmod` immediately. (The kernel has not blocked and waited for a refcount to drain since v3.13, commit `3f2b9c9cdf38` "module: remove rmmod --wait option.") The `synchronize_rcu()` calls on the teardown paths do a different job: `free_module()` unlinks the module from the modules list, the mod tree and the bug list with the `_rcu` variants — "Unlink carefully: kallsyms could be walking list" — and then waits a grace period so those RCU readers cannot touch the memory as it is freed.

## /proc/modules format

```bash
cat /proc/modules
# e1000e 262144 0 - Live 0xffffffffc0400000
# ^^^^^^ ^^^^^^ ^ ^ ^^^^ ^^^^^^^^^^^^^^^^^^
# name   size   | | |    load address
#               | | state (Live/Loading/Unloading)
#               | dependents ("Used by" in lsmod)
#               refcount
```

`m_show()` in `kernel/module/procfs.c` is the authority on the format. Fields:

- **size**: `module_total_size(mod)`, which sums `mod->mem[type].size` over **all seven** memory classes — not just the core ones. Reading `/proc/modules` before a module's init memory has been freed therefore reports a slightly larger number than reading it afterwards.
- **refcount**: `module_refcount(mod)` — the number of held references, or `-1` once `try_stop_module()` has dropped `MODULE_REF_BASE`, i.e. for a module shown as `Unloading`. (`module_refcount()`'s own kernel-doc says it will "return the refcount or -1 if unloading"; the window is real because `delete_module()` runs `mod->exit()` after setting `GOING` but while the module is still on the modules list, and `m_show()` only skips `UNFORMED`.) With `CONFIG_MODULE_UNLOAD=n` there is no refcount and no dependency tracking at all, and `print_unload_info()`'s stub prints two literal dashes (`- -`) in place of this field *and* the next one.
- **dependents**: the modules that depend on *this* one, not the ones it depends on. `print_unload_info()` walks `mod->source_list` and prints `use->source->name` with a trailing comma for each — the same set `lsmod` shows under "Used by". A module with an init function but no exit function additionally gets `[permanent],` appended, matching the `if (mod->init && !mod->exit)` test in `delete_module()` that refuses to unload it short of a forced removal. If nothing at all was printed, a single `-` is emitted.
- **state**: `Live`, `Loading` (`MODULE_STATE_COMING`), or `Unloading` (`MODULE_STATE_GOING`). `MODULE_STATE_UNFORMED` modules are skipped entirely.
- **load address**: `mod->mem[MOD_TEXT].base` — the base of the module's text region, not of some combined "core layout". Readers that fail `kallsyms_show_value()` see `0x0000000000000000` instead.

When `mod->taints` is non-zero a parenthesised flag suffix follows, e.g. `(OE)` for an out-of-tree unsigned module, with `+` appended while the module is loading and `-` while it is unloading.

## Symbol versioning detail

There are two CRC generators. `scripts/genksyms/` is the original: it runs at kernel build time, parses the preprocessed C, and computes a CRC over the full type signature (recursively expanding struct and union layouts) of each exported symbol. Its C parser cannot see Rust, and cannot version a symbol whose type is only fully described in debug info, so `scripts/gendwarfksyms/` was added alongside it under `CONFIG_GENDWARFKSYMS`; it derives the same kind of CRC from DWARF rather than from source.

Either way the result lands in `Module.symvers`, which `modpost` writes from `write_dump()`:

```c
buf_printf(&buf, "0x%08x\t%s\t%s\tEXPORT_SYMBOL%s\t%s\n",
           sym->crc, sym->name, mod->name,
           sym->is_gpl_only ? "_GPL" : "",
           sym->namespace);
```

Five tab-separated fields: CRC, symbol name, the providing module (`vmlinux` for built-ins), the export flavour, and the namespace. The namespace field is the empty string for symbols exported without one, so an unnamespaced line simply ends in a tab:

```bash
grep -w module_layout Module.symvers | cat -A
# 0x1a2b3c4d^Imodule_layout^Ivmlinux^IEXPORT_SYMBOL^I$
```

(`cat -A` renders tabs as `^I` and end-of-line as `$`; the CRC itself is specific to the build.)

When building an out-of-tree module, `make` reads `Module.symvers` from `$(KDIR)` to embed the correct CRCs in the module's `__versions` (or `__version_ext_crcs`/`__version_ext_names`) section. Building against the wrong `Module.symvers` is the most common cause of version mismatch errors.

## Further reading

### Kernel source

- [kernel/module/main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/main.c) — the loader core: `load_module()`, `simplify_symbols()`, `apply_relocations()`, `do_init_module()`, and the `init_module`/`finit_module` `SYSCALL_DEFINE`s
- [kernel/module/internal.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/internal.h) — `struct load_info`, the ELF-section cache threaded through every stage of a load
- [kernel/module/version.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/version.c) — `check_version()` and `same_magic()`: the `__versions` CRC comparison and the vermagic check, plus the newer extended-modversions path for long symbol names
- [kernel/module/kallsyms.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/kallsyms.c) — `layout_symtab()` and `add_kallsyms()`: how a module's own symbol table is carried into its allocated memory and exposed through `/proc/kallsyms`
- [kernel/module/procfs.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/procfs.c) — `m_show()`: the authoritative source for the `/proc/modules` field order, the `Live`/`Loading`/`Unloading` strings, and the `[permanent]` marker
- [include/linux/module.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/module.h) — `struct module`, `enum module_state`, `struct modversion_info`, and the `struct module_memory mem[]` array that holds each allocated section class
- [include/linux/export.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/export.h) — `EXPORT_SYMBOL()`/`EXPORT_SYMBOL_GPL()`: the `.export_symbol` entries that modpost turns into `__ksymtab`
- [include/uapi/linux/module.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/module.h) — the complete `finit_module()` flag set: `MODULE_INIT_IGNORE_MODVERSIONS`, `MODULE_INIT_IGNORE_VERMAGIC`, `MODULE_INIT_COMPRESSED_FILE`
- [arch/x86/kernel/module.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/module.c) — `apply_relocate_add()`: the x86-64 `R_X86_64_*` switch that computes and writes each relocation
- [scripts/genksyms/](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/genksyms) — the `CONFIG_MODVERSIONS` CRC generator that produces the values recorded in `Module.symvers`
- [`ac3b43283923`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=ac3b43283923440900b4f36ca5f9f0b1ca43b70e) — "module: replace module_layout with module_memory" (Song Liu, 2023): the commit that split the old two-region core/init layout into the per-class `mod->mem[]` array
- [`12af2b83d0b1`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=12af2b83d0b17ec8b379b721dd4a8fbcd5d791f3) — "mm: introduce execmem_alloc() and execmem_free()" (Mike Rapoport, 2024): the allocator that module text and data are carved out of today
- [`55fcb926b6d8`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=55fcb926b6d8b5cfb40873e4840a69961db1bb69) — "module: use kflagstab instead of *_gpl sections" (Siddharth Nayyar, 2026): GPL-only became a bit in a parallel `__kflagstab` section, so the loader no longer searches a separate `__ksymtab_gpl`

### Man pages

- [`init_module(2)`](https://man7.org/linux/man-pages/man2/init_module.2.html) — documents both syscalls in one page: the prototypes, the three `finit_module()` flags, and that `finit_module()` appeared in Linux 3.8
- [`delete_module(2)`](https://man7.org/linux/man-pages/man2/delete_module.2.html) — the unload side; states that the call fails with `EWOULDBLOCK` when other loaded modules refer to symbols defined in this one, and what `O_NONBLOCK`/`O_TRUNC` change
- [`lsmod(8)`](https://man7.org/linux/man-pages/man8/lsmod.8.html) — "a trivial program which nicely formats the contents of the `/proc/modules`"; the userspace view of the file dissected above
- [`depmod(8)`](https://man7.org/linux/man-pages/man8/depmod.8.html) — determines "what symbols each module exports and needs" and writes the resulting graph to `modules.dep`, the input to dependency-ordered loading
- [`modprobe(8)`](https://man7.org/linux/man-pages/man8/modprobe.8.html) — the tool that consults `modules.dep`, which "lists what other modules each module needs (if any), and modprobe uses this to add or remove these dependencies automatically"; the man page does not name the syscall it ultimately issues, but kmod's implementation loads each `.ko` with `finit_module()`

### Related pages

- [Module Parameters, Symbols, and Kconfig](module-params.md) — `EXPORT_SYMBOL`/`EXPORT_SYMBOL_GPL`, the `has no CRC!` and `disagrees about version` symptoms, and `/proc/kallsyms`, from the module author's side
- [Kernel Module Signing](module-signing.md) — `module_sig_check()`, which `load_module()` runs before it looks at a single ELF section
- [Kbuild: The Kernel Build System](kbuild.md) — out-of-tree builds and cross-compilation, the build side that produces the `.ko` this walkthrough loads
- [Writing and Loading Kernel Modules](module-basics.md) — the source-level view: `module_init`/`module_exit`, `__init` sections, and the `.ko` this page takes apart
- [Module War Stories](war-stories.md) — CRC mismatches, taint cascades, and versioning surprises seen in production

### LWN articles

- [Loading modules from file descriptors](https://lwn.net/Articles/519010/) — Michael Kerrisk, October 2012, on the proposal that became `finit_module()`; the driving motivation was letting the kernel reason about a module's *filesystem origin* (dm-verity-backed roots, LSMs reading signatures from extended attributes), not just its bytes
- [The return of modversions](https://lwn.net/Articles/21393/) — January 2003; describes the mechanism step 8 above implements: one structure per imported symbol holding "the symbol name and its checksum", linked into a special section and discarded once the load succeeds
- [A new version of modversions](https://lwn.net/Articles/986892/) — August 2024; why `genksyms`' C parser cannot version Rust code, and the `gendwarfksyms` replacement that derives CRCs from DWARF instead of source
- [Yet another memory allocator for executable code](https://lwn.net/Articles/933867/) — June 2023; Mike Rapoport's case for taking executable-memory allocation away from the module loader, and the direct-map fragmentation that motivated it
- [Two approaches to tightening restrictions on loadable modules](https://lwn.net/Articles/998221/) — November 2024; how the loader's GPL-only enforcement worked as of the article's two-table `__ksymtab`/`__ksymtab_gpl` model (replaced by the single-table `__kflagstab` scheme described above in v7.1) and the proposal to restrict an export to a named set of modules

### External

- [Building External Modules](https://docs.kernel.org/kbuild/modules.html) — the upstream guide to out-of-tree builds, including "Symbols From the Kernel (vmlinux + modules)" and the `KBUILD_EXTRA_SYMBOLS` escape hatch for cross-module `Module.symvers`
- [Tainted kernels](https://docs.kernel.org/admin-guide/tainted-kernels.html) — the authoritative taint-flag table, including `F` ("module was force loaded"), `O` (out-of-tree module), and `E` (unsigned module)
