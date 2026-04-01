# Early Boot and start_kernel()

> Subsystem initialization order, initcalls, and `__init` sections

## Overview

After the bootloader decompresses the kernel and the architecture-specific assembly entry point (`startup_64` on x86-64, `primary_entry` on arm64) sets up the bare minimum — early page tables, a valid stack, and a GDT — control passes to `start_kernel()` in `init/main.c`. This is the C entry point, and every subsystem in the kernel traces its initialization back to a call made directly or indirectly from this function.

`start_kernel()` is a long, ordered sequence of function calls. The ordering is deliberate: some subsystems require that others are already operational before they can initialize. Memory allocation must come before anything that allocates memory. Interrupts must be disabled until the interrupt controller is configured. The console must be set up before diagnostic messages are useful.

---

## start_kernel(): the initialization sequence

The following is the initialization order as it appears in `init/main.c` (Linux 6.x). Not every call is listed — only the ones that matter for understanding the system.

```
start_kernel()
    set_task_stack_end_magic(&init_task)    [1]
    smp_setup_processor_id()               [2]
    debug_objects_early_init()
    init_vmlinux_build_id()
    cgroup_init_early()
    local_irq_disable()                    <- interrupts off
    boot_cpu_init()                        [3]
    page_address_init()                    [4]
    pr_notice(linux_banner)                [5]
    early_security_init()                  [6]
    setup_arch(&command_line)              [7]
    setup_command_line(command_line)       [8]
    setup_nr_cpu_ids()                     [9]
    setup_per_cpu_areas()                  [10]
    smp_prepare_boot_cpu()                 [11]
    build_all_zonelists(NULL)              [12]
    page_alloc_init()                      [13]
    parse_early_param()                    <- early_param() handlers run here
    ...
    trap_init()                            [14]
    mm_core_init()                         [15]
    poking_init()                          [16]
    ftrace_init()                          [17]
    early_trace_init()                     [18]
    sched_init()                           [19]
    radix_tree_init()                      [20]
    workqueue_init_early()                 [21]
    rcu_init()                             [22]
    init_IRQ()                             [23]
    tick_init()                            [24]
    timekeeping_init()                     [25]
    time_init()                            [26]
    kmem_cache_init()                      [27]
    ...
    console_init()                         [28]
    ...
    rest_init()                            [29]
```

### Key steps explained

**[1] `set_task_stack_end_magic(&init_task)`**

Places a canary value (`STACK_END_MAGIC = 0x57AC6E9F`) at the bottom of `init_task`'s kernel stack. If the stack overflows and overwrites this value, the kernel can detect it and panic rather than silently corrupting memory. `init_task` is a statically allocated `struct task_struct` — it is the idle thread (PID 0) and the ancestor of all processes.

**[2] `smp_setup_processor_id()`**

Records the boot CPU's hardware ID. On x86 this reads the APIC ID; on arm64 it reads MPIDR. This must happen before any code that uses `smp_processor_id()`.

**[3] `boot_cpu_init()`** (`kernel/cpu.c`)

Marks the boot CPU as present, possible, active, and online in the CPU bitmasks (`cpu_present_mask`, `cpu_possible_mask`, etc.). Secondary CPUs are brought online later during SMP bringup; the boot CPU must be registered first.

**[4] `page_address_init()`**

Initializes the page address hash table used to convert `struct page *` to virtual addresses for highmem pages. On 64-bit kernels with direct mapping this is mostly a no-op, but it must be called before any page address lookups.

**[5] `pr_notice(linux_banner)`**

The first human-readable log line: `Linux version 6.x.y (compiler) #N SMP ...`. This is the version string seen at the top of `dmesg`. At this point `printk` writes to an in-memory buffer; nothing appears on a console yet.

**[6] `early_security_init()`**

Initializes LSM (Linux Security Module) infrastructure that must be present before `setup_arch()`. Specifically, this allows LSMs that hook into architecture setup (e.g., integrity measurement) to register their early hooks. Introduced to support IMA/EVM initialization ordering.

**[7] `setup_arch(&command_line)`** (`arch/x86/kernel/setup.c` or `arch/arm64/kernel/setup.c`)

The largest and most architecture-specific call in `start_kernel()`. On x86-64 this includes:

- Parsing the e820 memory map from the bootloader
- Setting up the initial kernel page tables
- Initializing memblock (the boot-time memory allocator)
- Parsing ACPI tables (MADT, SRAT, SLIT) for CPU and NUMA topology
- Setting up the initial command line pointer
- Configuring the kernel's virtual address layout

After `setup_arch()` returns, the kernel knows how much physical memory it has and where it is.

**[8] `setup_command_line(command_line)`**

Copies the command line into two static buffers: `boot_command_line[]` (for reference, never modified) and `saved_command_line[]` (also preserved). The working copy in `command_line` may be modified by subsequent parsers.

**[9] `setup_nr_cpu_ids()`**

Computes `nr_cpu_ids` from the CPU possible bitmask. This tells the rest of the kernel the maximum CPU index it will ever see, allowing per-CPU arrays to be sized correctly.

**[10] `setup_per_cpu_areas()`**

Allocates memory for per-CPU data. The linker places per-CPU variables in a `.data..percpu` section; at runtime, `setup_per_cpu_areas()` creates one copy of this section per possible CPU, separated by enough padding to prevent false sharing. After this call, `this_cpu_*()` macros work correctly.

**[11] `smp_prepare_boot_cpu()`**

Performs any SMP-specific initialization needed on the boot CPU before secondary CPUs start. On x86 this sets up the boot CPU's GS segment for per-CPU access.

**[12] `build_all_zonelists(NULL)`** (`mm/page_alloc.c`)

Constructs the NUMA zone fallback lists. Each node gets an ordered list of zones to try when its own zones are exhausted. The order is determined by NUMA distance (from `mm/numa.c`). This must happen before any NUMA-aware allocation.

**[13] `page_alloc_init()`**

Registers a CPU hotplug callback so the page allocator's per-CPU page frames (pcplists) are set up correctly when secondary CPUs come online.

**[14] `trap_init()`** (`arch/x86/kernel/traps.c`)

On x86, sets up the Interrupt Descriptor Table (IDT) with handlers for all CPU exceptions: divide error (#DE), page fault (#PF), general protection fault (#GP), double fault (#DF), etc. After this call, the CPU can handle exceptions properly. Before this, any fault is fatal.

**[15] `mm_core_init()`** (`mm/mm_init.c`)

Initializes the core memory management infrastructure: `mem_init()` (converts memblock to the buddy allocator), `kmem_cache_init()` (bootstraps the slab allocator), page table caches, and more. After this, the general-purpose page allocator (`alloc_pages()`) is operational. Note: `kmem_cache_init_late()` is invoked later as a separate `core_initcall`, not from within `mm_core_init()`.

**[16] `poking_init()`**

Initializes the text-poking infrastructure used by kprobes, ftrace, and live patching to safely modify kernel text at runtime. On x86 this sets up a temporary mapping mechanism to write to read-only kernel pages.

**[17] `ftrace_init()`**

Prepares the function tracer's internal data structures (the `ftrace_ops` list, the mcount call sites recorded in `__mcount_loc`). The tracer is not yet active but the infrastructure is ready.

**[18] `early_trace_init()`**

Initializes the tracing ring buffer and trace clock before most subsystems are up, so that trace events from early boot can be captured.

**[19] `sched_init()`** (`kernel/sched/core.c`)

Initializes the scheduler: allocates per-CPU runqueues (`struct rq`), sets up the CFS, RT, and deadline scheduling classes, and makes `init_task` runnable. After `sched_init()`, context switching is possible.

**[20] `radix_tree_init()`**

Initializes the kmem_cache for radix tree nodes. The radix tree (now maple tree for VMAs, but radix tree still used elsewhere) is used by the page cache, the inode cache, and many other subsystems.

**[21] `workqueue_init_early()`** (`kernel/workqueue.c`)

Creates the early workqueue infrastructure. Full workqueue initialization (`workqueue_init()`) happens later via a core_initcall; this early call sets up the data structures so that `schedule_work()` can be queued even before worker threads exist.

**[22] `rcu_init()`** (`kernel/rcu/tree.c`)

Initializes RCU (Read-Copy-Update). Sets up the RCU tree (rcu_node hierarchy), per-CPU state, and the rcu_tasks mechanism. After this, `rcu_read_lock()` / `rcu_read_unlock()` and `call_rcu()` are safe to use.

**[23] `init_IRQ()`** (`arch/x86/kernel/irqinit.c`)

Initializes the interrupt controller. On x86 this sets up the legacy 8259 PIC (or APIC if present), allocates IRQ descriptors, and prepares the interrupt handling framework. After this, `request_irq()` is possible.

**[24] `tick_init()`** (`kernel/time/tick-common.c`)

Initializes the tick framework (NO_HZ, HRTICK, broadcast clock event). Must precede timekeeping.

**[25] `timekeeping_init()`** (`kernel/time/timekeeping.c`)

Reads the hardware clock source and initializes `timekeeper`. After this, `ktime_get()` and `ktime_get_real_ts64()` work. This is the kernel's internal clock, not the wall clock.

**[26] `time_init()`** (`arch/x86/kernel/time.c`)

Architecture-specific time initialization. On x86 this calibrates the TSC against the PIT or HPET and sets up the clock event device for the timer interrupt.

**[27] `kmem_cache_init()`** (`mm/slab.c` or `mm/slub.c`)

Bootstraps the slab allocator. This is a multi-stage process because the slab allocator needs to allocate memory for its own metadata, but it needs the slab allocator to do so. The bootstrap uses static arrays then migrates. After this call, `kmalloc()` works.

**[28] `console_init()`** (`kernel/printk/printk.c`)

Initializes the console subsystem and calls registered console drivers. After this call, `printk` output goes to the serial console or VGA — this is when the boot messages that were buffered in the log ring actually appear on screen.

**[29] `rest_init()`** (`init/main.c`)

The last call in `start_kernel()`. Creates kernel threads and enters the idle loop (see below).

---

## rest_init(): spawning PID 1 and PID 2

```c
/* init/main.c */
static noinline void __ref rest_init(void)
{
    struct task_struct *tsk;
    int pid;

    rcu_scheduler_starting();

    /*
     * We need to spawn init first so that it obtains pid 1,
     * and kthreadd second so that it obtains pid 2. We require
     * pid 1 to be running before kthreadd starts.
     */
    pid = kernel_thread(kernel_init, NULL, "init", CLONE_FS);

    rcu_read_lock();
    tsk = find_task_by_pid_ns(pid, &init_pid_ns);
    tsk->flags |= PF_NO_SETAFFINITY;
    set_cpus_allowed_ptr(tsk, cpumask_of(smp_processor_id()));
    rcu_read_unlock();

    numa_default_policy();
    pid = kernel_thread(kthreadd, NULL, "kthreadd", CLONE_FS | CLONE_FILES);
    rcu_read_lock();
    kthreadd_task = find_task_by_pid_ns(pid, &init_pid_ns);
    rcu_read_unlock();

    system_state = SYSTEM_SCHEDULING;

    complete(&kthreadd_done);

    /*
     * The boot CPU is now the idle thread. It will never return.
     */
    cpu_startup_entry(CPUHP_ONLINE);
}
```

- **PID 1 (`kernel_init`)**: runs `do_initcalls()` to execute all registered initcalls, then mounts the root filesystem and execs `/sbin/init` (or whatever `init=` specifies on the command line).
- **PID 2 (`kthreadd`)**: the kernel thread daemon. All subsequent kernel threads are created by `kthreadd` in response to `kernel_thread()` calls.
- **CPU 0 idle**: after `rest_init()` returns, CPU 0 enters `cpu_startup_entry()` and becomes the idle thread, running `do_idle()` in a loop. It never returns to `start_kernel()`.

---

## Initcall levels

Built-in kernel subsystems register initialization functions using initcall macros. These functions are called by `do_initcalls()` in `kernel_init()`, after `start_kernel()` has completed. The levels define ordering:

| Macro | Level | Typical use |
|-------|-------|-------------|
| `early_initcall(fn)` | early | Very early, before pure |
| `pure_initcall(fn)` | 0 | Pure infrastructure, no hardware |
| `core_initcall(fn)` | 1 | Core kernel infrastructure (workqueues, etc.) |
| `core_initcall_sync(fn)` | 1s | Synchronization point after core |
| `postcore_initcall(fn)` | 2 | After core subsystems |
| `arch_initcall(fn)` | 3 | Architecture-specific init |
| `subsys_initcall(fn)` | 4 | Subsystem init (PCI, USB core, networking) |
| `subsys_initcall_sync(fn)` | 4s | |
| `fs_initcall(fn)` | 5 | Filesystem registration |
| `rootfs_initcall(fn)` | rootfs | Root filesystem (initramfs population) |
| `device_initcall(fn)` | 6 | Most drivers; `module_init()` is an alias |
| `device_initcall_sync(fn)` | 6s | |
| `late_initcall(fn)` | 7 | After all devices initialized |

### How it works

Each macro expands to `__define_initcall(fn, level)`:

```c
/* include/linux/init.h */
#define __define_initcall(fn, id) \
    static initcall_t __initcall_##fn##id \
    __used __attribute__((__section__(".initcall" #id ".init"))) = fn

#define core_initcall(fn)       __define_initcall(fn, 1)
#define device_initcall(fn)     __define_initcall(fn, 6)
#define module_init(fn)         device_initcall(fn)
```

The linker script (`arch/x86/kernel/vmlinux.lds.S`, via `include/asm-generic/vmlinux.lds.h`) collects all `.initcall*.init` sections in level order. `do_initcalls()` iterates this array and calls each function pointer:

```c
/* init/main.c */
static void __init do_initcall_level(int level, char *command_line)
{
    initcall_entry_t *fn;

    for (fn = initcall_levels[level]; fn < initcall_levels[level + 1]; fn++)
        do_one_initcall(initcall_from_entry(fn));
}

static void __init do_initcalls(void)
{
    int level;
    size_t len = strlen(saved_command_line) + 1;
    char *command_line = kzalloc(len, GFP_KERNEL);

    for (level = 0; level < ARRAY_SIZE(initcall_levels) - 1; level++)
        do_initcall_level(level, command_line);

    kfree(command_line);
}
```

The initcall return value matters: a non-zero return causes a `pr_warn` message but does not stop the boot process (unless `initcall_debug` is set to a stricter mode). An initcall that returns an error is simply logged and skipped.

---

## `__init` and `__exit` sections

### `__init`

Functions annotated with `__init` are placed in the `.init.text` ELF section. After `do_initcalls()` completes and the init process starts, the kernel frees the entire `.init.text` and `.init.data` sections:

```c
/* init/main.c */
static int __init kernel_init(void *unused)
{
    ...
    free_initmem();
    ...
}
```

`free_initmem()` calls `free_reserved_area()` to return these pages to the buddy allocator. This is why the boot log contains a message like:

```
Freeing unused kernel image (initmem) memory: 2548K
```

The practical consequence: **never call an `__init` function after boot**. The page containing it has been freed and may be reused. A stored function pointer to an `__init` function is a time bomb.

```c
/* WRONG: storing a pointer to __init function */
static int (*saved_fn)(void);

static int __init my_init(void)
{
    saved_fn = some_init_helper;  /* some_init_helper is __init */
    return 0;
}

/* Calling saved_fn after boot → use-after-free, oops */
```

### `__exit`

Functions annotated with `__exit` are placed in `.exit.text`. For built-in code (not a loadable module), the `.exit.text` section is discarded at link time — the linker does not include it in the final image because built-in code can never be unloaded. For loadable modules, `.exit.text` is kept and called when the module is removed.

### Data sections

| Annotation | Section | Freed after boot? |
|-----------|---------|------------------|
| `__init` | `.init.text` | Yes |
| `__initdata` | `.init.data` | Yes |
| `__initconst` | `.init.rodata` | Yes |
| `__exit` | `.exit.text` | Discarded (built-in) / kept (module) |
| `__exitdata` | `.exit.data` | Same |

### Size savings

The `__init` mechanism recovers a meaningful amount of memory. On a typical x86-64 kernel the init sections total 1–3 MB. On memory-constrained embedded systems this matters significantly.

---

## Observing boot order

### dmesg with timestamps

```bash
dmesg -T          # human-readable timestamps
dmesg --color     # colored output by level
dmesg | head -50  # first 50 lines (arch init, version, memory map)
```

### initcall_debug boot parameter

Add `initcall_debug` to the kernel command line (in GRUB: `linux ... initcall_debug`). The kernel will print every initcall with its execution time:

```
calling  e1000e_init_module+0x0/0x3c [e1000e] @ 2
initcall e1000e_init_module+0x0/0x3c [e1000e] returned 0 after 1243 usecs
calling  ahci_init+0x0/0x28 @ 2
initcall ahci_init+0x0/0x28 returned 0 after 87 usecs
```

The number after `@` is the CPU on which the initcall ran.

### /proc/kallsyms

```bash
# See registered initcall symbols in section order:
grep '__initcall_' /proc/kallsyms | head -20
```

These symbols correspond to the function pointer entries placed in `.initcall*.init` sections.

### Tracing with ftrace

```bash
# Trace all calls made during boot (requires early ftrace setup)
echo function > /sys/kernel/debug/tracing/current_tracer
echo 1 > /sys/kernel/debug/tracing/tracing_on
cat /sys/kernel/debug/tracing/trace | grep 'do_one_initcall'
```

---

## Further reading

- [Kernel Boot Parameters](boot-params.md) — how `early_param` and `__setup` are parsed
- [Module Init and Initcalls](initcalls-modules.md) — the module side of `module_init()`
- [printk and Kernel Logging](printk.md) — why printk works after `console_init()` but not before
- `init/main.c` — `start_kernel()`, `rest_init()`, `do_initcalls()`
- `include/linux/init.h` — `__init`, `__exit`, initcall macros
- `Documentation/core-api/kernel-api.rst` — kernel API reference
