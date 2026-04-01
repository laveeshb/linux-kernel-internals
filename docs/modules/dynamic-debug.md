# Dynamic Debug

> pr_debug and dev_dbg: enabling kernel debug messages at runtime without recompilation

## The problem with pr_debug

`pr_debug()` is defined as a no-op when `CONFIG_DEBUG` is not set and as a printk call when it is. This is an all-or-nothing compile-time switch that floods the log with messages from every subsystem simultaneously.

`CONFIG_DYNAMIC_DEBUG` replaces this with a per-call-site on/off switch controlled at runtime through debugfs. The cost when disabled is a single NOP instruction. There is no need to recompile or reboot to enable debug messages for a specific driver or function.

## How it works

For every `pr_debug()` and `dev_dbg()` call site in the kernel, the compiler emits:

1. A `static struct _ddebug` descriptor in the `__dyndbg` section of the object file, containing metadata about that call site.
2. A NOP instruction at the call site in `.text`.

When a call site is enabled at runtime, the kernel patches the NOP to a `call` instruction using `text_poke()` — the same mechanism used by ftrace and the alternatives framework. When disabled, the call site reverts to a NOP with zero runtime overhead.

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
    unsigned int flags:8;   /* DYNAMIC_DEBUG_FLAGS_* bitmask */
} __attribute__((aligned(8)));
```

The `flags` field tracks which output decorations are enabled for this site (print, line, file, module, thread info, and so on). The kernel maintains an array of all `_ddebug` entries and searches it when processing control commands.

## The control interface

The control file is at `/sys/kernel/debug/dynamic_debug/control`. Writing a query string to it enables or disables matching call sites.

```bash
# Enable all pr_debug() calls in a module
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
# +f  prefix with filename
# +l  prefix with line number
# +m  prefix with module name
# +t  prefix with thread/task name and PID
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
- `module <name>` — match by module name
- `file <path>` — match by source file (substring or exact)
- `func <name>` — match by function name
- `line <N>` or `line <N>-<M>` — match by line number or range
- `format <string>` — match if the format string contains this substring

Multiple match specs are ANDed. The `flags-spec` is `+` or `-` followed by flag letters.

### Output flag letters

| Flag | Meaning |
|------|---------|
| `p` | Enable printing (required to see output) |
| `f` | Prefix output with source filename |
| `l` | Prefix output with line number |
| `m` | Prefix output with module name |
| `t` | Prefix output with task name and PID |

## Boot-time enablement

Some debug messages are needed before debugfs is mounted. Two boot-time mechanisms exist:

```bash
# Kernel command line — applies to all call sites matching the query
dyndbg="module mymodule +p"

# Per-module parameter — applies only to that module at load time
# Passed via the kernel command line or modprobe.conf
mymodule.dyndbg="+p"
```

The `dyndbg` kernel parameter is processed during early boot and again when modules are loaded.

## Module integration

When a module is loaded, `load_module()` registers its `__dyndbg` section entries with the dynamic debug core:

```c
/* Called from load_module() */
int dynamic_debug_setup(struct module *mod, struct _ddebug *debug, unsigned int num);
```

If a `dyndbg` module parameter was passed at load time (e.g., `insmod mymodule.ko dyndbg=+p`), the dynamic debug core applies it immediately after registration, before `mod->init()` runs. This means debug messages from the init function itself can be captured.

When a module is unloaded, its `_ddebug` entries are unregistered.

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
rx buf: 00000000: 45 00 00 3c 1c 46 40 00  40 06 ac 10 7f 00 00 01  E..<.F@.@.......
```

## Combining with ftrace for lightweight tracing

Enable thread info (`+t`) in dynamic debug output and compare timestamps against ftrace's function graph tracer to correlate debug messages with kernel function calls — without writing a custom tracepoint:

```bash
# Enable dynamic debug with thread info
echo "module mymodule +pt" > /sys/kernel/debug/dynamic_debug/control

# Enable ftrace function graph for the same module
echo mymodule > /sys/kernel/debug/tracing/set_ftrace_filter
echo function_graph > /sys/kernel/debug/tracing/current_tracer
cat /sys/kernel/debug/tracing/trace_pipe &

# Run your workload — pr_debug output and ftrace appear on the same timeline
```

## Implementation: text_poke patching

When a `_ddebug` entry's `p` flag is set, the kernel:

1. Looks up the call site's address from the ELF debug info embedded at build time.
2. Calls `text_poke_bp()` to safely patch the NOP with a `call` to `__dynamic_pr_debug()` (or `__dynamic_dev_dbg()`), handling concurrent execution on other CPUs via an INT3 breakpoint.
3. Updates the `flags` field in the `_ddebug` structure.

When disabled, the same mechanism patches the `call` back to a NOP. Because the patch is in the `.text` section, it is global and affects all CPUs immediately after the patching sequence completes.

## Checking what is enabled

```bash
# All registered call sites — shows =p for enabled, =_ for disabled
cat /sys/kernel/debug/dynamic_debug/control
# format:  file:line [module]function flags  "format-string"
# example:
# drivers/net/e1000/e1000_main.c:1502 [e1000]e1000_configure =p "configured\n"
# drivers/net/e1000/e1000_main.c:1510 [e1000]e1000_open =_  "irq %d\n"

# Count enabled sites
grep -c "=p" /sys/kernel/debug/dynamic_debug/control

# Disable everything
echo "module mymodule -p" > /sys/kernel/debug/dynamic_debug/control
```

## Further reading

- [Writing and Loading Modules](module-basics.md) — pr_* logging overview
- [Module Loading Internals](module-loading-internals.md) — how __dyndbg is registered at load time
- `Documentation/admin-guide/dynamic-debug-howto.rst` — kernel documentation for dynamic debug
- `include/linux/dynamic_debug.h` — struct _ddebug and macro definitions
