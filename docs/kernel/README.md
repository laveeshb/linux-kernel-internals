# Kernel Core Internals

> The glue that holds every subsystem together: boot, logging, parameters, panics, and module init

## What is "kernel core"?

The kernel core is the collection of infrastructure that does not belong to any single subsystem but that every subsystem depends on. It lives primarily in `init/`, `kernel/`, and `arch/x86/kernel/` (and the equivalent arch directories), and it answers the question: *how does a compressed binary become a running operating system that can schedule tasks, respond to interrupts, and load drivers?*

Topics covered here include:

- The C entry point (`start_kernel()`) and the ordered sequence of subsystem initialization calls it drives
- How the kernel receives and parses boot parameters from the bootloader
- How modules and built-in subsystems register their initialization functions through the initcall mechanism
- What happens when something goes catastrophically wrong — oops, panic, and crash dump collection
- The `printk` logging infrastructure that underpins every diagnostic message in the kernel

This is not memory management, not the scheduler, not networking — it is the machinery that sets up all of those before handing control off to them.

---

## Pages in this section

| Page | What it covers |
|------|---------------|
| [printk and Kernel Logging](printk.md) | Log levels, ring buffer, rate limiting, dynamic debug, dmesg |
| [Early Boot and start_kernel()](early-boot.md) | C entry point, subsystem init order, initcalls, `__init` sections |
| [Kernel Boot Parameters](boot-params.md) | Command-line parsing, `__setup`, `early_param`, module params |
| [Kernel Panic and Oops](panic-oops.md) | Oops handling, `panic()`, stack unwinding, kdump, KASAN/KFENCE |
| [Module Init and Initcalls](initcalls-modules.md) | `module_init`/`module_exit`, struct module, loading flow, signing |
| [Kernel Core War Stories](war-stories.md) | Real incidents: init ordering bugs, `__init` misuse, panic loops |

---

## Suggested reading order

If you are new to kernel internals, read these in order:

1. **[Early Boot and start_kernel()](early-boot.md)** — understand the init sequence before anything else
2. **[Kernel Boot Parameters](boot-params.md)** — how the kernel is configured before any code runs
3. **[Module Init and Initcalls](initcalls-modules.md)** — how subsystems and drivers hook into the boot sequence
4. **[printk and Kernel Logging](printk.md)** — observability infrastructure used by everything else
5. **[Kernel Panic and Oops](panic-oops.md)** — what happens when something goes wrong
6. **[Kernel Core War Stories](war-stories.md)** — real-world examples that tie the concepts together

---

## Kernel boot flow

```
Power on / bootloader (GRUB/EFI)
        |
        | loads compressed kernel image (bzImage / Image)
        v
arch entry point (arch/x86/kernel/head_64.S)
        |
        | sets up early page tables, GDT, stack
        v
startup_64 / __startup_64
        |
        | decompresses kernel, relocates if KASLR
        v
x86_64_start_kernel()   (arch/x86/kernel/head64.c)
        |
        | early CR0/CR4/EFER setup, early IDT
        v
start_kernel()          (init/main.c)          <--- C entry point
        |
        |-- set_task_stack_end_magic(&init_task)
        |-- smp_setup_processor_id()
        |-- boot_cpu_init()
        |-- setup_arch()         (memory map, page tables, ACPI)
        |-- setup_per_cpu_areas()
        |-- sched_init()
        |-- rcu_init()
        |-- init_IRQ()
        |-- timekeeping_init()
        |-- kmem_cache_init()
        |-- console_init()       (printk now goes to screen)
        |
        v
rest_init()
        |
        |-- kernel_thread(kernel_init, ...)  --> PID 1
        |-- kernel_thread(kthreadd, ...)     --> PID 2
        |
        v
cpu_startup_entry(CPUHP_ONLINE)   <-- CPU 0 becomes idle thread
        |
        v (PID 1 runs)
kernel_init()
        |
        |-- do_initcalls()        (runs all initcall levels)
        |-- prepare_namespace()   (mount root filesystem)
        |
        v
exec /sbin/init  (or init= boot parameter)
        |
        v
userspace init system (systemd / sysvinit)
```

---

## Quick reference: key kernel globals

| Symbol | Header | Description |
|--------|--------|-------------|
| `init_task` | `<linux/init_task.h>` | The static task_struct for PID 0 (idle thread); the root of all process lineage |
| `jiffies` | `<linux/jiffies.h>` | Monotonically increasing tick counter; wraps after ~497 days on 32-bit |
| `HZ` | `<asm/param.h>` | Timer interrupt frequency in ticks per second; typically 100, 250, or 1000 |
| `nr_cpu_ids` | `<linux/threads.h>` | Number of possible CPUs (set by `setup_nr_cpu_ids()` during early boot) |
| `NUMA_NO_NODE` | `<linux/numa.h>` | Sentinel value (-1) meaning "no specific NUMA node"; used in allocator APIs |
| `boot_command_line[]` | `<linux/init.h>` | Copy of the command line received from the bootloader |
| `system_state` | `<linux/kernel.h>` | Current boot phase: `SYSTEM_BOOTING`, `SYSTEM_RUNNING`, `SYSTEM_HALT`, etc. |

---

## Further reading

- [Kernel Modules](../modules/README.md) — writing and loading out-of-tree modules
- [printk](printk.md) — logging in depth
- [Kernel Debugging](../debugging/README.md) — KGDB, kdump, oops analysis
- `init/main.c` — the canonical source for `start_kernel()` and `rest_init()`
- `Documentation/admin-guide/kernel-parameters.txt` — exhaustive list of boot parameters
