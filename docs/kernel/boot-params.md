# Kernel Boot Parameters

> Command-line parsing, `__setup` macros, and `early_param`

## How the kernel receives its command line

The kernel's command line originates with the bootloader. GRUB, for example, places the command string in the boot protocol's `boot_params.hdr.cmd_line_ptr` field (a physical address). The arch setup code (`setup_arch()`) copies this into the kernel's address space early in boot.

By the time `start_kernel()` begins, the command line has been copied into two static arrays:

```c
/* init/main.c */
char __initdata boot_command_line[COMMAND_LINE_SIZE];
char *saved_command_line __ro_after_init;
```

`boot_command_line` holds the raw string from the bootloader, preserved verbatim. `saved_command_line` may include additions from `setup_arch()` (e.g., parameters appended by the UEFI stub). A working mutable copy is parsed and consumed by the various parsing stages.

```bash
# See the command line from userspace:
cat /proc/cmdline
# BOOT_IMAGE=/vmlinuz-6.8.0 root=/dev/sda1 ro quiet splash
```

---

## Parsing stages

The kernel parses the command line in three distinct phases. The phase determines which parameters are visible and when.

### Phase 1: `parse_early_param()` — very early

Called from `start_kernel()` before memory allocators are initialized. This phase handles parameters that must be known before the rest of boot can proceed — for example, the amount of usable RAM or which console to use.

Parameters registered with `early_param()` are processed here.

### Phase 2: `parse_args()` — main kernel init

Called from `start_kernel()` after `setup_arch()` and the per-CPU areas are set up. This phase handles the bulk of kernel parameters registered with `__setup()`.

Anything not matched by `__setup()` or `early_param()` is treated as either:
- A module parameter for a built-in module (`module.param=value` form)
- An environment variable to pass to the init process
- An unknown parameter (logged as a warning)

### Phase 3: module parameters — at module load time

For loadable modules, parameters passed on the `insmod`/`modprobe` command line are parsed when the module is loaded, via `kernel/params.c`. For built-in modules, these appear as `module.param=value` on the kernel command line and are handled during Phase 2.

---

## `early_param()` macro

```c
/* include/linux/init.h */
#define early_param(str, fn) \
    __setup_param(str, fn, fn, 1)
```

The `1` marks this as an early parameter. `parse_early_param()` calls `parse_args()` with a filter that only processes entries flagged as early.

### Example: `mem=` handler

```c
/* arch/x86/kernel/setup.c */
static int __init parse_mem(char *arg)
{
    if (!arg)
        return -EINVAL;
    mem_size = memparse(arg, &arg);
    return 0;
}
early_param("mem", parse_mem);
```

Common parameters handled by `early_param()`:

| Parameter | Handler location | Purpose |
|-----------|-----------------|---------|
| `mem=N` | `arch/x86/kernel/setup.c` | Limit usable RAM |
| `memmap=N@S` | `arch/x86/kernel/setup.c` | Mark memory region |
| `console=` | `kernel/printk/printk.c` | Early console configuration |
| `earlyprintk=` | `arch/x86/kernel/early_printk.c` | Very early console (before `console_init()`) |
| `loglevel=N` | `init/main.c` | Set initial log level |
| `ignore_loglevel` | `kernel/printk/printk.c` | Print all log levels to console |

---

## `__setup()` macro

```c
/* include/linux/init.h */
#define __setup(str, fn) \
    __setup_param(str, fn, fn, 0)

#define __setup_param(str, unique_id, fn, early)        \
    static const char __setup_str_##unique_id[] __initconst \
        __aligned(1) = str;                              \
    static struct obs_kernel_param __setup_##unique_id  \
        __used __section(".init.setup")                  \
        __attribute__((aligned((sizeof(long)))))         \
    = { __setup_str_##unique_id, fn, early }
```

Each `__setup()` call places a `struct obs_kernel_param` entry into the `.init.setup` section:

```c
struct obs_kernel_param {
    const char *str;
    int (*setup_func)(char *);
    int early;
};
```

The linker collects all `.init.setup` entries into a contiguous array between `__setup_start` and `__setup_end`. `parse_args()` iterates this array and calls the matching `setup_func` when it finds a parameter whose name matches `str`.

### Writing a `__setup()` handler

```c
static int __init myopt_setup(char *str)
{
    if (!str)
        return 0;

    if (*str == '=')
        str++;

    if (kstrtoint(str, 0, &myopt_value))
        return 0;

    return 1;  /* 1 = successfully parsed, 0 = not handled */
}
__setup("myopt=", myopt_setup);
```

The handler receives a pointer to the value portion of the parameter (everything after `myopt=`). Return `1` if the parameter was recognized and handled, `0` if not (which allows other handlers to try it). The setup string can include the `=` to require a value, or omit it for a bare flag.

### Boolean flag example

```c
static bool myfeature_enabled __initdata = false;

static int __init myfeature_setup(char *str)
{
    myfeature_enabled = true;
    return 1;
}
__setup("myfeature", myfeature_setup);
```

---

## `parse_args()` internals

`parse_args()` is defined in `kernel/params.c`. It:

1. Walks the command line, splitting on whitespace (respecting quotes)
2. For each token, splits on the first `=`
3. Tries to match the name against `__setup` entries (via the linker-section array)
4. If no match and the name contains `.`, tries to match against module parameters (built-in modules)
5. If still no match, calls the `unknown` callback — typically either passed to init as an environment variable or logged as unknown

```bash
# Kernel log for an unrecognized parameter:
# Unknown kernel command line parameters "mxcpus=4", will be passed to userspace
```

---

## Module parameters for built-in modules

A module built into the kernel (via `y` in Kconfig rather than `m`) still exposes parameters, but they are parsed from the kernel command line instead of the `insmod` command line:

```c
/* Example: net/core/dev.c */
static int netdev_budget = 300;
module_param(netdev_budget, int, 0644);
MODULE_PARM_DESC(netdev_budget, "Maximum number of packets taken from all "
                 "interfaces in one polling cycle; following NAPI completion "
                 "callback.");
```

To set this from the kernel command line:

```
net_core.netdev_budget=600
```

The module name prefix (`net_core`) is derived from the module name. `parse_args()` matches the prefix to a registered module and dispatches the parameter.

### Accessing from sysfs

Module parameters for loaded modules (or built-ins with `0644` permissions) are exposed under `/sys/module/`:

```bash
cat /sys/module/net_core/parameters/netdev_budget
300

echo 600 > /sys/module/net_core/parameters/netdev_budget
```

Parameters marked `0444` are read-only after boot. Parameters marked `0000` do not appear in sysfs at all.

---

## Important kernel parameters

These are parameters whose handlers are worth understanding at a source level:

| Parameter | Handler | Source file |
|-----------|---------|------------|
| `root=/dev/sda1` | `root_dev_setup()` | `init/do_mounts.c` |
| `init=/bin/sh` | `init_setup()` | `init/main.c` |
| `ro` / `rw` | `readonly_setup()` | `init/do_mounts.c` |
| `quiet` | `quiet_kernel()` | `init/main.c` |
| `debug` | `debug_kernel()` | `init/main.c` |
| `panic=N` | `panic_timeout` (early_param) | `kernel/panic.c` |
| `maxcpus=N` | `maxcpus()` | `kernel/smp.c` |
| `nosmp` | `nosmp()` | `kernel/smp.c` |
| `nokaslr` | `parse_nokaslr()` | `arch/x86/mm/kaslr.c` |
| `nopti` | `pti_cmdline_cfg()` | `arch/x86/mm/pti.c` |
| `crashkernel=N` | `parse_crashkernel()` | `kernel/crash_core.c` |
| `initcall_debug` | `initcall_debug_enable()` | `init/main.c` |
| `printk.devkmsg=on/off/ratelimit` | — | `kernel/printk/printk.c` |

### Selecting an init binary

```
init=/bin/sh          # drop to a root shell (recovery)
init=/sbin/init       # explicit sysvinit
init=/lib/systemd/systemd  # explicit systemd (usually the default)
rdinit=/bin/sh        # shell in initramfs (before pivot_root)
```

### Limiting CPUs

```
maxcpus=1    # boot as if uniprocessor (secondary CPUs parked)
nosmp        # equivalent; disables SMP entirely
```

### KASLR control

```
nokaslr      # disable kernel address space layout randomization
             # useful for debugging: makes addresses reproducible across boots
```

---

## Inspecting parameters from kernel code

```c
#include <linux/init.h>

/* Access the preserved command line */
extern char *saved_command_line;

/* Check if a parameter appears anywhere in the command line */
static bool __init has_param(const char *name)
{
    return strstr(saved_command_line, name) != NULL;
}

/* Parse a numeric value from the command line */
static unsigned long __init get_param_ulong(const char *name,
                                             unsigned long defval)
{
    char *p = strstr(saved_command_line, name);
    if (!p)
        return defval;
    p += strlen(name);
    if (*p != '=')
        return defval;
    return simple_strtoul(p + 1, NULL, 0);
}
```

For production code, prefer `early_param()` or `__setup()` over manual string searching — they provide correct lifetime handling, proper error reporting, and the `.init.setup` section cleanup at boot completion.

---

## Further reading

- [Early Boot and start_kernel()](early-boot.md) — when each parsing phase runs
- [Module Init and Initcalls](initcalls-modules.md) — `module_param()` in loadable modules
- `kernel/params.c` — `parse_args()`, `parse_one()`, module parameter core
- `include/linux/moduleparam.h` — `module_param()` macro family
- `Documentation/admin-guide/kernel-parameters.txt` — canonical list of all kernel parameters
- `Documentation/core-api/kernel-api.rst` — `__setup` and `early_param` documentation
