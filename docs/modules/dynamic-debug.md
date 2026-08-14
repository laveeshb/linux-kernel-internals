# Dynamic Debug

> pr_debug and dev_dbg: enabling kernel debug messages at runtime without recompilation

## The problem with pr_debug

`pr_debug()` is controlled in two ways:

- With `CONFIG_DYNAMIC_DEBUG=y`: each `pr_debug()` becomes a dynamically-controllable site (NOP by default, enabled at runtime).
- Without `CONFIG_DYNAMIC_DEBUG`: `pr_debug()` expands to `printk(KERN_DEBUG ...)` if the `DEBUG` C preprocessor macro is defined for that compilation unit (via `CFLAGS_file.o += -DDEBUG` in the Makefile), or to `no_printk()` (a compile-time no-op) if `DEBUG` is not defined.

Without `CONFIG_DYNAMIC_DEBUG`, this is an all-or-nothing compile-time switch that floods the log with messages from every subsystem simultaneously.

`CONFIG_DYNAMIC_DEBUG` replaces this with a per-call-site on/off switch controlled at runtime through debugfs. The cost when disabled is a single NOP instruction. There is no need to recompile or reboot to enable debug messages for a specific driver or function.

Two Kconfig symbols are involved. `CONFIG_DYNAMIC_DEBUG=y` turns the feature on kernel-wide: it selects `CONFIG_DYNAMIC_DEBUG_CORE` *and* catalogs every `pr_debug()`/`dev_dbg()` call site in the build (which costs roughly 2% of kernel text). `CONFIG_DYNAMIC_DEBUG_CORE=y` on its own builds only the machinery — the control file and the query engine — and catalogs nothing. Individual modules then opt in by adding `ccflags-y += -DDYNAMIC_DEBUG_MODULE` to their Makefile; the macros in `include/linux/dynamic_debug.h` are gated on `CONFIG_DYNAMIC_DEBUG || (CONFIG_DYNAMIC_DEBUG_CORE && DYNAMIC_DEBUG_MODULE)`. This split exists for size-sensitive builds, such as embedded systems, that want dynamic debug for a handful of drivers but cannot afford the full catalog.

## How it works

For every `pr_debug()` and `dev_dbg()` call site in the kernel, the compiler emits:

1. A `static struct _ddebug` descriptor in the `__dyndbg` section of the object file, containing metadata about that call site.
2. A NOP instruction at the call site in `.text`, via the jump label (static key) infrastructure.

Dynamic debug uses the jump label (static key) infrastructure (`CONFIG_JUMP_LABEL`). Each `pr_debug()` call site has a static key embedded in its `_ddebug` descriptor — the `key` union shown below. When disabled, the site is a NOP (via a `jump_label` that doesn't branch). When enabled, `static_branch_enable()` / `jump_label_update()` patches the NOP to a short jump. The patching is done by the jump label subsystem — dynamic debug itself just calls `static_branch_enable()` or `static_branch_disable()` on `dp->key.dd_key_true`. When disabled, the call site is a NOP with zero runtime overhead.

The two union members are the reason a `key` is a union at all, and the control path and the call site read it differently. `ddebug_change()` always flips `dd_key_true`. The call site, by contrast, expands `DYNAMIC_DEBUG_BRANCH()`, which picks its member from whether the translation unit was compiled with `DEBUG` defined: without it — the normal case — the branch is `static_branch_unlikely(&descriptor.key.dd_key_false)`, initialized off, so the compiler lays the debug call out on the unlikely path; with `-DDEBUG` it becomes `static_branch_likely(&descriptor.key.dd_key_true)`, initialized on, so the site starts out printing and the fast path is the one that logs. Both members alias the same underlying key, so the control file toggles either build identically.

## struct _ddebug

Defined in `include/linux/dynamic_debug.h`:

```c
struct _ddebug {
    const char *modname;    /* module name */
    const char *function;   /* enclosing function name */
    const char *filename;   /* source file path */
    const char *format;     /* the format string literal */
    unsigned int lineno:18; /* source line number */
    unsigned int class_id:6;
    unsigned int flags:8;   /* _DPRINTK_FLAGS_* bitmask */
#ifdef CONFIG_JUMP_LABEL
    union {
        struct static_key_true dd_key_true;
        struct static_key_false dd_key_false;
    } key;
#endif
} __attribute__((aligned(8)));
```

The `flags` field tracks which output decorations are enabled for this site (print, line, file, module, thread info, and so on).

Descriptors are not searched as one flat global array. Each loadable module carries its own `__dyndbg` section, and `lib/dynamic_debug.c` registers it as a `struct ddebug_table` on the global `ddebug_tables` linked list:

```c
/* lib/dynamic_debug.c */
struct ddebug_table {
    struct list_head link, maps;
    const char *mod_name;
    unsigned int num_ddebugs;
    struct _ddebug *ddebugs;
};

static DEFINE_MUTEX(ddebug_lock);
static LIST_HEAD(ddebug_tables);
```

Built-in code is the case where section and table stop being one-to-one. The vmlinux linker script gathers every built-in call site into a *single* bounded `__dyndbg` section, so there is one section for the whole image no matter how many built-in modules contributed to it. `dynamic_debug_init()` then walks that section from `__start___dyndbg` to `__stop___dyndbg` and carves it into many tables: because the descriptors arrive grouped by translation unit, it simply watches for `iter->modname` to change and calls `ddebug_add_module()` for each run of same-named entries. One section in, one `ddebug_table` per distinct `modname` out — matching the per-module tables that loadable modules register through the notifier.

So a control command is matched in two nested loops. `ddebug_change()` takes `ddebug_lock` and walks `ddebug_tables`. Per table it does two cheap rejections before looking at any call site: the table's `mod_name` is tested against the query's `module` spec — letting it skip an entire module's descriptors in one comparison — and, if the query carries a `class` spec, `ddebug_find_valid_class()` resolves that class *name* to a numeric `class_id` by searching the table's `maps` list of `ddebug_class_map`s, skipping the whole table if this module never declared that class. It then iterates the `dt->ddebugs[]` array, testing `class_id`, `filename`, `function`, `format`, and `lineno` per call site.

The class test comes first in that inner loop, and it is not optional: when the query has no `class` spec, `valid_class` defaults to `_DPRINTK_CLASS_DFLT`, and every site whose `class_id` differs is skipped. So an ordinary query never touches class'd call sites — including the `module mymodule +p` form below, which enables that module's unclassed sites only. Reaching a subsystem's classed sites (DRM's debug categories, say) always requires naming the class explicitly.

## The control interface

The control file is at `/sys/kernel/debug/dynamic_debug/control`. Writing a query string to it enables or disables matching call sites.

Since v5.7 the same control file is also exposed at `/proc/dynamic_debug/control`, so dynamic debug stays usable on systems that build without debugfs. The two are interchangeable; the examples below use the debugfs path, but upstream documentation now leads with the procfs one.

```bash
# Enable a module's unclassed pr_debug() calls
# (classed sites need an explicit "class" spec — see above)
echo "module mymodule +p" > /sys/kernel/debug/dynamic_debug/control

# Enable by source file (relative path from kernel root)
echo "file drivers/net/ethernet/intel/e1000/e1000_main.c +p" \
    > /sys/kernel/debug/dynamic_debug/control

# Enable a line range within a file
echo "file drivers/net/ethernet/intel/e1000/e1000_main.c line 100-200 +p" \
    > /sys/kernel/debug/dynamic_debug/control

# Enable by function name
echo "func tcp_recvmsg +p" > /sys/kernel/debug/dynamic_debug/control

# Enable with additional output decorations
# +p  print the message
# +f  prefix with the function name
# +s  prefix with the source file name
# +l  prefix with line number
# +m  prefix with module name
# +t  prefix with the thread ID (or <intr>)
echo "module mymodule +pmfl" > /sys/kernel/debug/dynamic_debug/control

# Disable all call sites in a module
echo "module mymodule -p" > /sys/kernel/debug/dynamic_debug/control

# Show current state — one line per registered call site
cat /sys/kernel/debug/dynamic_debug/control | grep mymodule

# Show only currently active (printing) sites
grep "=p" /sys/kernel/debug/dynamic_debug/control
```

### Query syntax

A control string has the form:

```
[match-spec ...] flags-spec
```

Where `match-spec` can be:

- `module <name>` — match by module name, as it appears in `lsmod` (no directory, no `.ko`, with `-` changed to `_`)
- `file <path>` — match by source file. The value is compared against the source-root-relative pathname *or* the basename, so both `file kernel/freezer.c` and `file svcsock.c` work. Two tail forms are also accepted: `file inode.c:start_*` parses the `:tail` as a `func` spec, and `file inode.c:1-100` parses it as a `line` range.
- `func <name>` — match by function name
- `line <N>` or `line <N>-<M>` — match by line number or range. Either end may be omitted: `line -1605` means line 1 through 1605, `line 1600-` means line 1600 to end of file. A range must contain no spaces — `1-30` is valid, `1 - 30` is not.
- `format <string>` — match if the format string contains this substring. A leading `^` anchors the match to the start of the format. Whitespace can be escaped as C octal (`format nfsd:\040SETATTR`) or the whole value quoted (`format "nfsd: SETATTR"`).
- `class <name>` — match only call sites belonging to a class the module has declared (via a `ddebug_class_map`). Classes let a subsystem group its call sites into named categories that can be toggled together — DRM's debug categories, matched with queries like `class DRM_UT_KMS`, are the main user. This is what the `class_id` bitfield in `struct _ddebug` above selects. An unknown class name is a silent non-match, and class names do *not* accept wildcards.

Multiple match specs are ANDed, and an absent keyword behaves like `*`. Because a query with no match spec at all is legal, the flags are parsed first — so a bad flag letter masks a bad keyword in the error message.

Wildcards are not universal. The `module`, `file`, and `func` specs are the ones that go through `match_wildcard()`, so they accept globs: `*` for zero or more characters, `?` for exactly one. `module drm*` matches both `drm` and `drm_kms_helper`; `file "drivers/usb/*"` matches everything under that directory (quote it to stop the shell expanding it first). The other three specs do not glob: `format` is always a literal substring search (optionally anchored with a leading `^`), so `*` and `?` in it are ordinary characters; `line` takes only numbers and ranges, and a wildcard there is rejected as a bad line number; `class` names are matched exactly.

A single `write()` may carry several queries, separated by `;` or newlines, applied left to right:

```bash
# Turn everything off, then enable just the run* functions in the main module
echo '-p; module main func run* +p' > /sys/kernel/debug/dynamic_debug/control

# Or one query per line, from a file
cat query-batch-file > /sys/kernel/debug/dynamic_debug/control
```

Within a multi-query string, a query beginning with `#` is treated as a comment and skipped.

The `flags-spec` is `+` (add), `-` (remove), or `=` (set exactly) followed by one or more flag letters.

### Output flag letters

| Flag | Meaning |
|------|---------|
| `p` | Enable printing (required to see output) |
| `t` | Prefix output with the thread ID, or `<intr>` in interrupt context |
| `m` | Prefix output with module name |
| `f` | Prefix output with the function name |
| `s` | Prefix output with the source file name |
| `l` | Prefix output with line number |
| `d` | Include a call trace |
| `_` | No flags (use `=_` to clear everything) |

The decorator flags (`t`, `m`, `f`, `s`, `l`, `d`) are added to the message
prefix in that fixed order, regardless of the order you type them in the query. `d` is not a prefix decorator at all — it appends a `dump_stack()` call after the message, handled separately from `__dynamic_emit_prefix()`.

## Boot-time enablement

Some debug messages are needed before debugfs is mounted. Two boot-time mechanisms exist:

```bash
# Kernel command line — applies to all call sites matching the query
dyndbg="module mymodule +p"

# Per-module parameter — applies only to that module at load time
# Passed via the kernel command line, an /etc/modprobe.d/*.conf
# "options" line, or directly as a modprobe argument
mymodule.dyndbg="+p"
```

The two forms are processed differently, and the difference matters:

- Bare `dyndbg="QUERY"` is processed **only once**, from an `early_initcall` that runs just after the built-in ddebug tables are registered. It therefore reaches any code that runs after that early initcall — ACPI setup, PCI enumeration, and other `subsys_initcall`-and-later work — but it is never revisited, so it cannot affect a module loaded later.
- `<module>.dyndbg="QUERY"` *is* reprocessed when the module loads. If the named module is built in, the boot-time pass applies it. If it is not built in, the boot-time pass sees it and does nothing, and the query is applied again — this time for real — at module load.

A boot-time query must not exceed 1023 characters, and a bootloader may impose a lower limit of its own. In the `<module>.dyndbg=` form the query must not include its own `module` match spec: the module name is taken from the parameter name and applied to each query in the string.

For persistence across reboots, an `/etc/modprobe.d/*.conf` file can carry the setting as a module option:

```
options mymodule dyndbg=+pt
```

When several sources set `dyndbg` for the same module, modprobe applies them in order — `/etc/modprobe.d/*.conf` first, then `<module>.dyndbg` from the boot command line, then arguments passed to `modprobe` itself — with the last one winning.

## Module integration

When a module is loaded, `find_module_sections()` in `kernel/module/main.c` locates the module's `__dyndbg` (and `__dyndbg_classes`) sections and records them in `mod->dyndbg_info`:

```c
/* kernel/module/main.c, find_module_sections() */
mod->dyndbg_info.descs = section_objs(info, "__dyndbg",
                                      sizeof(*mod->dyndbg_info.descs),
                                      &mod->dyndbg_info.num_descs);
```

Registration itself happens through the module notifier chain. `lib/dynamic_debug.c` registers `ddebug_module_nb`, whose callback calls `ddebug_add_module()` on `MODULE_STATE_COMING` and `ddebug_remove_module()` on `MODULE_STATE_GOING`:

```c
/* lib/dynamic_debug.c */
static int ddebug_module_notify(struct notifier_block *self, unsigned long val,
                                void *data)
{
    struct module *mod = data;

    switch (val) {
    case MODULE_STATE_COMING:
        ret = ddebug_add_module(&mod->dyndbg_info, mod->name);
        ...
    case MODULE_STATE_GOING:
        ddebug_remove_module(mod->name);
        ...
    }
}
```

The notifier block uses `.priority = 0` deliberately, so that jump labels — registered on the same chain — are initialized before dynamic debug runs. Earlier kernels used explicit `dynamic_debug_setup()` / `dynamic_debug_remove()` calls wired into the module loader; those were replaced by this notifier in v6.4.

If a `dyndbg` module parameter was passed at load time (e.g., `insmod mymodule.ko dyndbg=+p`), it is not a real module parameter — the module loader's `unknown_module_param_cb()` recognizes it specially and hands it to `ddebug_dyndbg_module_param_cb()`. This happens after the descriptors are registered and before `mod->init()` runs, so debug messages from the init function itself can be captured.

## pr_debug vs dev_dbg

Both use the dynamic debug infrastructure and are controlled through the same interface.

```c
/* Generic — not tied to a device */
pr_debug("packet count: %d\n", count);

/* Device-aware — prepends the device name to the output */
dev_dbg(&pdev->dev, "DMA transfer complete, status=%#x\n", status);
```

`dev_dbg()` is preferred in driver code because the device name in the output immediately identifies which hardware instance produced the message. Both are no-ops (NOPs) when disabled.

## print_hex_dump_debug

For bulk data, `print_hex_dump_debug()` dumps a buffer in hex + ASCII format and is also controlled by dynamic debug:

```c
print_hex_dump_debug("rx buf: ", DUMP_PREFIX_OFFSET, 16, 1,
                     buf, len, true);
```

This produces output like:
```
rx buf: 00000000: 45 00 00 3c 1c 46 40 00 40 06 ac 10 7f 00 00 01  E..<.F@.@.......
```

Hex-dump call sites are a partial exception to the flag rules above: for `print_hex_dump_debug()` and `print_hex_dump_bytes()`, only `p` and `d` have any effect. The prefix decorators (`t`, `m`, `f`, `s`, `l`) are accepted by the parser but inert for these sites, because the output is produced by `print_hex_dump()` rather than by `__dynamic_emit_prefix()`, the function that builds the decorated prefix for `__dynamic_pr_debug()`. `d` still fires, though: `dump_stack()` is invoked by the `__dynamic_func_call*` wrapper macro in `include/linux/dynamic_debug.h`, which guards every dynamic debug site — hex dumps included — not by the prefix path.

Matching them with `format` works, but on the `prefix_str` argument rather than a real format string: the descriptor records `prefix_str` if it is a constant string, and the literal `hexdump` if it is built at runtime. So the call above is selected by `format "rx buf: "`.

## Combining with ftrace for lightweight tracing

Enable thread info (`+t`) in dynamic debug output and compare timestamps against ftrace's function graph tracer to correlate debug messages with kernel function calls — without writing a custom tracepoint:

```bash
# Enable dynamic debug with thread info
echo "module mymodule +pt" > /sys/kernel/debug/dynamic_debug/control

# Enable ftrace function graph for the same module.
# set_ftrace_filter matches function names, not modules, so restrict
# by module with the "mod:" filter command: <function>:mod:<module>
echo '*:mod:mymodule' > /sys/kernel/debug/tracing/set_ftrace_filter
echo function_graph > /sys/kernel/debug/tracing/current_tracer
cat /sys/kernel/debug/tracing/trace_pipe &

# Run your workload — pr_debug output and ftrace appear on the same timeline
```

A bare `echo mymodule > set_ftrace_filter` does *not* do this — it is read as a function-name glob. Since no function is likely to be named after the module, nothing matches, and `ftrace_process_regex()` turns a zero-match write into `-EINVAL`, so the shell reports `write error: Invalid argument` rather than silently ignoring it. (If some unrelated function does happen to share the name, the write succeeds and traces that function instead.) The `mod:` filter command takes a function glob before the module name, so `'*:mod:mymodule'` means "every function in `mymodule`", while `'e1000_tx*:mod:e1000'` narrows to a subset. Append with `>>` to add another module's functions, and prefix an entry with `!` to remove it.

## Implementation: jump label patching

When a `_ddebug` entry's `p` flag is set, the kernel:

1. Updates the `flags` field in the `_ddebug` structure.
2. Calls `static_branch_enable()` on the static key embedded in the `_ddebug` descriptor's `key` field (`dp->key.dd_key_true`).
3. The jump label subsystem (`jump_label_update()`) patches the NOP at the call site to a short branch, directing execution to `__dynamic_pr_debug()` (or `__dynamic_dev_dbg()`).

The call site address and all metadata are stored directly in the `_ddebug` descriptor at compile time — no runtime ELF debug info lookup occurs. When disabled, `static_branch_disable()` causes `jump_label_update()` to patch the branch back to a NOP. Because the patch is applied by the jump label subsystem, it is safe with respect to concurrent execution on other CPUs.

## Checking what is enabled

```bash
# All registered call sites — shows =p for enabled, =_ for disabled
cat /sys/kernel/debug/dynamic_debug/control
# The file's own header line gives the format:
# filename:lineno [module]function flags format
#
# example (two of the ~109 netdev_dbg() sites the e1000 module registers,
# one enabled; most of the rest come from the e_dbg() wrapper in e1000.h):
# drivers/net/ethernet/intel/e1000/e1000_main.c:3573 [e1000]e1000_change_mtu =p "changing MTU from %d to %d\n"
# drivers/net/ethernet/intel/e1000/e1000_main.c:4429 [e1000]e1000_clean_rx_irq =_ "Receive packet consumed multiple buffers\n"

# Count enabled sites
grep -c "=p" /sys/kernel/debug/dynamic_debug/control

# Disable everything
echo "module mymodule -p" > /sys/kernel/debug/dynamic_debug/control
```

The line numbers above are from v7.2-rc7 and drift with every kernel release; the file, module, and function columns are the stable parts. Note also that the first column is the source-root-relative path, which is exactly the form the `file` match spec accepts — so a line from this output can be turned into a query by pasting that first column, `:lineno` tail and all, after `file`:

```bash
echo "file drivers/net/ethernet/intel/e1000/e1000_main.c:3573 +p" \
    > /sys/kernel/debug/dynamic_debug/control
```

`ddebug_parse_query()` splits the `:3573` tail off and reparses it as a one-line range, so this selects exactly the site the output line came from. The second column, `[module]function`, is display formatting rather than query syntax — it has to be retyped as separate `module` and `func` specs to be used in a query.

## Further reading

### Kernel source

- [include/linux/dynamic_debug.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/dynamic_debug.h) — the `struct _ddebug` definition quoted above, the `_DPRINTK_FLAGS_*` bit definitions behind the flag letters, `DEFINE_DYNAMIC_DEBUG_METADATA()` / `DYNAMIC_DEBUG_BRANCH()` (the macros that emit the `__dyndbg` descriptor and the static branch), and `dynamic_hex_dump()`
- [lib/dynamic_debug.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/dynamic_debug.c) — the whole runtime: `ddebug_change()` walks the matching call sites and flips `dp->key.dd_key_true` with `static_branch_enable()`/`static_branch_disable()`; `__dynamic_pr_debug()` and `__dynamic_dev_dbg()` build the decorated prefix; `struct ddebug_table` is the per-module registration record; `dynamic_debug_init_control()` creates both the debugfs and procfs control files
- [include/linux/printk.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/printk.h) — the three-way `pr_debug()` expansion this page opens with (`dynamic_pr_debug()` under `CONFIG_DYNAMIC_DEBUG`, `printk(KERN_DEBUG …)` under `DEBUG`, `no_printk()` otherwise), plus the same pattern for `print_hex_dump_debug()` and `pr_debug_ratelimited()`
- [kernel/module/main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/main.c) — `find_module_sections()` captures `__dyndbg`/`__dyndbg_classes` into `mod->dyndbg_info`, and `unknown_module_param_cb()` routes a load-time `dyndbg=` argument to `ddebug_dyndbg_module_param_cb()`
- [include/asm-generic/vmlinux.lds.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/asm-generic/vmlinux.lds.h) — `BOUNDED_SECTION_BY(__dyndbg, ___dyndbg)`: how the vmlinux linker script gathers every built-in call site's descriptor into one bounded array
- [commit `7deabd674988`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=7deabd67498869640c937c9bd83472574b7dea0b) — "dyndbg: use the module notifier callbacks" (Jason Baron, March 2023, merged for v6.4): deleted the old `dynamic_debug_setup()`/`dynamic_debug_remove()` hooks from the module loader in favour of `ddebug_module_notify()`, and explains why the notifier priority must let jump labels initialize first
- [commit `239a5791ffd5`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=239a5791ffd5559f51815df442c4dbbe7fc21ade) — "dynamic_debug: allow to work if debugfs is disabled" (Greg Kroah-Hartman, February 2020, merged for v5.7): the commit that added `/proc/dynamic_debug/control`

### Man pages

- [`modprobe.d(5)`](https://man7.org/linux/man-pages/man5/modprobe.d.5.html) — the `options <modulename> <option>` directive used to make a per-module `dyndbg=` setting persistent across boots
- [`modprobe(8)`](https://man7.org/linux/man-pages/man8/modprobe.8.html) — how module parameters from the command line, aliases, and config files are combined before reaching `unknown_module_param_cb()`

### Related pages

- [Writing and Loading Kernel Modules](module-basics.md) — where `pr_debug()`/`dev_dbg()` fit in the module author's logging toolkit
- [Module Loading Internals](module-loading-internals.md) — `load_module()`, section parsing, and the `MODULE_STATE_COMING`/`MODULE_STATE_GOING` notifier chain that dynamic debug hooks
- [Module Parameters, Symbols, and Kconfig](module-params.md) — the `module_param()` machinery that a load-time `dyndbg=` argument deliberately sidesteps by never registering itself as a parameter at all
- [printk: Kernel Logging Internals](../kernel/printk.md) — the log buffer and loglevel filtering that debug output still has to get past once a call site is enabled
- [ftrace: Function Tracer](../tracing/ftrace.md) — the tracer paired with dynamic debug in the correlation recipe above

### LWN articles

- [The dynamic debugging interface](https://lwn.net/Articles/434833/) — Jonathan Corbet, March 22, 2011: LWN's introduction to the feature, covering `pr_debug()`/`dev_dbg()`, the debugfs control file, and the query language
- [dynamic debug](https://lwn.net/Articles/286191/) — Jason Baron's original June 2008 patch posting, with the problem statement (`dprintk`, `pr_debug`, `DEBUGP`, and a dozen incompatible ways to enable them) that motivated a single uniform interface
- [The perils of `pr_info()`](https://lwn.net/Articles/487437/) — Jonathan Corbet, March 21, 2012: why `pr_debug()` is preferable to a bare `printk(KERN_DEBUG …)`, since only the former is reachable from the dynamic debug control file
- [Jump label](https://lwn.net/Articles/412072/) — Jonathan Corbet, October 27, 2010: the NOP-patching mechanism that makes a disabled dynamic debug call site free
- [Jump label reworked](https://lwn.net/Articles/436041/) — Jonathan Corbet, March 30, 2011: the `static_branch()` API rework that eventually became the static-key interface `ddebug_change()` calls today

### External

- [Dynamic debug — The Linux Kernel documentation](https://docs.kernel.org/admin-guide/dynamic-debug-howto.html) — the authoritative reference for the control file: the full match-spec grammar (`func`, `file`, `module`, `format`, `class`, `line`), wildcard and line-range rules, the complete flag list and the fixed order decorators are printed in, and the `;`-separated multi-query form
- [The kernel's command-line parameters](https://docs.kernel.org/admin-guide/kernel-parameters.html) — the canonical `dyndbg[="val"]` and `<module>.dyndbg[="val"]` boot-parameter entries (the howto above adds the detail that a boot query must not exceed 1023 characters, and that a bare `dyndbg=` is only processed at boot while `<module>.dyndbg` is reprocessed when the module loads)
- [Static keys — The Linux Kernel documentation](https://docs.kernel.org/staging/static-keys.html) — `static_branch_enable()`/`static_branch_disable()` semantics, with disassembly showing the NOP that a disabled call site compiles down to
- [Message logging with printk](https://docs.kernel.org/core-api/printk-basics.html) — log levels and `console_loglevel`, which still filter enabled `pr_debug()` output on its way to the console
