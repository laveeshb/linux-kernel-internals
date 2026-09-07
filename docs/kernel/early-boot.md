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
    setup_arch(&command_line)              [6]
    mm_core_init_early()
    jump_label_init()
    static_call_init()
    early_security_init()                  [7]
    setup_boot_config()
    setup_command_line(command_line)       [8]
    setup_nr_cpu_ids()                     [9]
    setup_per_cpu_areas()                  [10]
    smp_prepare_boot_cpu()                 [11]
    parse_early_param()                    <- early_param() handlers run here
    ...
    trap_init()                            [12]
    mm_core_init()                         [13]
    poking_init()                          [14]
    ftrace_init()                          [15]
    early_trace_init()                     [16]
    sched_init()                           [17]
    radix_tree_init()                      [18]
    workqueue_init_early()                 [19]
    rcu_init()                             [20]
    init_IRQ()                             [21]
    tick_init()                            [22]
    timekeeping_init()                     [23]
    time_init()                            [24]
    kmem_cache_init_late()                 [25]
    ...
    console_init()                         [26]
    ...
    rest_init()                            [27]
```

`setup_arch()` genuinely runs before `early_security_init()` — swapped from an earlier version of this page. Between them, `start_kernel()` also calls `mm_core_init_early()` (an early memory-init split described under step [13] below), `jump_label_init()`, and `static_call_init()`; `setup_boot_config()` runs between `early_security_init()` and `setup_command_line()`. None of these get their own step number, same as the other unnumbered calls above.

`build_all_zonelists(NULL)` and (the renamed) `page_alloc_init_cpuhp()` are no longer called directly from `start_kernel()` at all — both moved inside `mm_core_init()` (step [13]), alongside `kmem_cache_init()`.

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

**[6] `setup_arch(&command_line)`** (`arch/x86/kernel/setup.c` or `arch/arm64/kernel/setup.c`)

The largest and most architecture-specific call in `start_kernel()`. On x86-64 this includes:

- Parsing the e820 memory map from the bootloader
- Setting up the initial kernel page tables
- Initializing memblock (the boot-time memory allocator)
- Parsing ACPI tables (MADT, SRAT, SLIT) for CPU and NUMA topology
- Setting up the initial command line pointer
- Configuring the kernel's virtual address layout

After `setup_arch()` returns, the kernel knows how much physical memory it has and where it is.

**[7] `early_security_init()`** (`security/lsm_init.c`)

Runs after `setup_arch()`, not before it. Walks the LSMs flagged "early" (`lsm_early_for_each_raw()`) and initializes each one via `lsm_init_single()` — this is what lets integrity-measurement and similar early-hooking LSMs register before most of the kernel is up. `security_init()`, which initializes the rest of the (non-early) LSMs, runs much later, well after `console_init()`.

**[8] `setup_command_line(command_line)`**

Copies the command line into two static buffers: `boot_command_line[]` (for reference, never modified) and `saved_command_line[]` (also preserved). The working copy in `command_line` may be modified by subsequent parsers.

**[9] `setup_nr_cpu_ids()`**

Computes `nr_cpu_ids` from the CPU possible bitmask. This tells the rest of the kernel the maximum CPU index it will ever see, allowing per-CPU arrays to be sized correctly.

**[10] `setup_per_cpu_areas()`**

Allocates memory for per-CPU data. The linker places per-CPU variables in a `.data..percpu` section; at runtime, `setup_per_cpu_areas()` creates one copy of this section per possible CPU, separated by enough padding to prevent false sharing. After this call, `this_cpu_*()` macros work correctly.

**[11] `smp_prepare_boot_cpu()`**

Performs any SMP-specific initialization needed on the boot CPU before secondary CPUs start. On x86 this sets up the boot CPU's GS segment for per-CPU access.

**[12] `trap_init()`** (`arch/x86/kernel/traps.c`)

On x86, sets up the Interrupt Descriptor Table (IDT) with handlers for all CPU exceptions: divide error (#DE), page fault (#PF), general protection fault (#GP), double fault (#DF), etc. After this call, the CPU can handle exceptions properly. Before this, any fault is fatal.

**[13] `mm_core_init()`** (`mm/mm_init.c`)

Initializes the core memory management infrastructure: `mem_init()` (converts memblock to the buddy allocator), `kmem_cache_init()` (bootstraps the slab allocator), page table caches, and more. It's also where `build_all_zonelists(NULL)` (`mm/page_alloc.c` — constructs the NUMA zone fallback lists, in NUMA-distance order from `mm/numa.c`) and `page_alloc_init_cpuhp()` (registers the CPU hotplug callback that sets up each secondary CPU's per-CPU page frames/pcplists — renamed from the older `page_alloc_init()`) are called; neither is a standalone `start_kernel()` step any more. After `mm_core_init()`, the general-purpose page allocator (`alloc_pages()`) and `kmalloc()` are both operational. Note: `kmem_cache_init_late()` (step [25] below) is a separate, later, plain direct call from `start_kernel()` — not called from within `mm_core_init()`, and not registered via any `core_initcall()`/initcall-level mechanism.

**[14] `poking_init()`**

Initializes the text-poking infrastructure used by kprobes, ftrace, and live patching to safely modify kernel text at runtime. On x86 this sets up a temporary mapping mechanism to write to read-only kernel pages.

**[15] `ftrace_init()`**

Prepares the function tracer's internal data structures (the `ftrace_ops` list, the mcount call sites recorded in `__mcount_loc`). The tracer is not yet active but the infrastructure is ready.

**[16] `early_trace_init()`**

Initializes the tracing ring buffer and trace clock before most subsystems are up, so that trace events from early boot can be captured.

**[17] `sched_init()`** (`kernel/sched/core.c`)

Initializes the scheduler: allocates per-CPU runqueues (`struct rq`), sets up the CFS, RT, and deadline scheduling classes, and makes `init_task` runnable. After `sched_init()`, context switching is possible.

**[18] `radix_tree_init()`**

Initializes the kmem_cache for radix tree nodes. The radix tree (now maple tree for VMAs, but radix tree still used elsewhere) is used by the page cache, the inode cache, and many other subsystems.

**[19] `workqueue_init_early()`** (`kernel/workqueue.c`)

Creates the early workqueue infrastructure. Full workqueue initialization (`workqueue_init()`) happens later via a core_initcall; this early call sets up the data structures so that `schedule_work()` can be queued even before worker threads exist.

**[20] `rcu_init()`** (`kernel/rcu/tree.c`)

Initializes RCU (Read-Copy-Update). Sets up the RCU tree (rcu_node hierarchy), per-CPU state, and the rcu_tasks mechanism. After this, `rcu_read_lock()` / `rcu_read_unlock()` and `call_rcu()` are safe to use.

**[21] `init_IRQ()`** (`arch/x86/kernel/irqinit.c`)

Initializes the interrupt controller. On x86 this sets up the legacy 8259 PIC (or APIC if present), allocates IRQ descriptors, and prepares the interrupt handling framework. After this, `request_irq()` is possible.

**[22] `tick_init()`** (`kernel/time/tick-common.c`)

Initializes the tick framework (NO_HZ, HRTICK, broadcast clock event). Must precede timekeeping.

**[23] `timekeeping_init()`** (`kernel/time/timekeeping.c`)

Reads the hardware clock source and initializes `timekeeper`. After this, `ktime_get()` and `ktime_get_real_ts64()` work. This is the kernel's internal clock, not the wall clock.

**[24] `time_init()`** (`arch/x86/kernel/time.c`)

Architecture-specific time initialization. On x86 this calibrates the TSC against the PIT or HPET and sets up the clock event device for the timer interrupt.

**[25] `kmem_cache_init_late()`** (`mm/slub.c` — SLAB has been removed; SLUB is the only allocator remaining)

Not the slab bootstrap — that's `kmem_cache_init()`, already done inside `mm_core_init()` (step [13]), and `kmalloc()` has worked since then. `kmem_cache_init_late()` runs much later, right before `console_init()`: it allocates the `slub_flushwq` workqueue SLUB uses to flush per-CPU partial-slab caches, and (when `CONFIG_SLAB_FREELIST_RANDOM` is enabled) seeds the per-boot freelist-randomization state via `prandom_init_once()`.

**[26] `console_init()`** (`kernel/printk/printk.c`)

Initializes the console subsystem and calls registered console drivers. After this call, `printk` output goes to the serial console or VGA — this is when the boot messages that were buffered in the log ring actually appear on screen.

**[27] `rest_init()`** (`init/main.c`)

The last call in `start_kernel()`. Creates kernel threads and enters the idle loop (see below).

---

## rest_init(): spawning PID 1 and PID 2

```c
/* init/main.c */
static noinline void __ref __noreturn rest_init(void)
{
    struct kernel_clone_args init_args = {
        .flags      = (CLONE_VM | CLONE_UNTRACED),
        .fn         = kernel_init,
        .fn_arg     = NULL,
    };
    struct task_struct *tsk;
    int pid;

    rcu_scheduler_starting();
    /*
     * We need to spawn init first so that it obtains pid 1, however
     * the init task will end up wanting to create kthreads, which, if
     * we schedule it before we create kthreadd, will OOPS.
     */
    pid = kernel_clone(&init_args);
    /*
     * Pin init on the boot CPU. Task migration is not properly working
     * until sched_init_smp() has been run. It will set the allowed
     * CPUs for init to the non isolated CPUs.
     */
    rcu_read_lock();
    tsk = find_task_by_pid_ns(pid, &init_pid_ns);
    tsk->flags |= PF_NO_SETAFFINITY;
    set_cpus_allowed_ptr(tsk, cpumask_of(smp_processor_id()));
    rcu_read_unlock();

    numa_default_policy();
    pid = kernel_thread(kthreadd, NULL, NULL, CLONE_FS | CLONE_FILES);
    rcu_read_lock();
    kthreadd_task = find_task_by_pid_ns(pid, &init_pid_ns);
    rcu_read_unlock();

    /*
     * Enable might_sleep() and smp_processor_id() checks.
     * They cannot be enabled earlier because with CONFIG_PREEMPTION=y
     * kernel_thread() would trigger might_sleep() splats. With
     * CONFIG_PREEMPT_VOLUNTARY=y the init task might have scheduled
     * already, but it's stuck on the kthreadd_done completion.
     */
    system_state = SYSTEM_SCHEDULING;

    complete(&kthreadd_done);

    /*
     * The boot idle thread must execute schedule()
     * at least once to get things moving:
     */
    schedule_preempt_disabled();
    /* Call into cpu_idle with preempt disabled */
    cpu_startup_entry(CPUHP_ONLINE);
}
```

- **PID 1 (`kernel_init`)**: spawned via `kernel_clone()` with a `struct kernel_clone_args` requesting `CLONE_VM | CLONE_UNTRACED` (not the generic `kernel_thread()` — PID 1 needs a real userspace return path; an older version of this code called a dedicated `user_mode_thread()` helper for the same purpose, but `rest_init()` builds the `kernel_clone_args` directly now). Runs `do_initcalls()` to execute all registered initcalls, then mounts the root filesystem and execs `/sbin/init` (or whatever `init=` specifies on the command line).
- **PID 2 (`kthreadd`)**: the kernel thread daemon, spawned via `kernel_thread()`. All subsequent kernel threads are created by `kthreadd` in response to `kernel_thread()` calls.
- **CPU 0 idle**: after `rest_init()` finishes, CPU 0 enters `cpu_startup_entry()` and becomes the idle thread, running `do_idle()` in a loop. `rest_init()` itself never returns to `start_kernel()`.

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

Each macro (e.g. `core_initcall(fn)`) expands through a chain: `__define_initcall(fn, id)` → `___define_initcall(fn, id, .initcall##id)` → `__unique_initcall(fn, id, __sec, __iid)` → `____define_initcall(...)`, the layer that actually emits the section entry:

```c
/* include/linux/init.h */
#ifdef CONFIG_HAVE_ARCH_PREL32_RELOCATIONS
#define ____define_initcall(fn, __stub, __name, __sec)		\
	__define_initcall_stub(__stub, fn)			\
	asm(".section	\"" __sec "\", \"a\"		\n"	\
	    __stringify(__name) ":			\n"	\
	    ".long	" __stringify(__stub) " - .	\n"	\
	    ".previous					\n");	\
	static_assert(__same_type(initcall_t, &fn));
#else
#define ____define_initcall(fn, __unused, __name, __sec)	\
	static initcall_t __name __used 			\
		__attribute__((__section__(__sec))) = fn;
#endif

#define __unique_initcall(fn, id, __sec, __iid)			\
	____define_initcall(fn,					\
		__initcall_stub(fn, __iid, id),			\
		__initcall_name(initcall, __iid, id),		\
		__initcall_section(__sec, __iid))

#define ___define_initcall(fn, id, __sec)			\
	__unique_initcall(fn, id, __sec, __initcall_id(fn))

#define __define_initcall(fn, id) ___define_initcall(fn, id, .initcall##id)
```

Most 64-bit architectures (including x86-64 and arm64) build with `CONFIG_HAVE_ARCH_PREL32_RELOCATIONS=y` today. On that path, each initcall entry isn't a plain function pointer — `__define_initcall_stub()` emits a small wrapper function (`__stub`) that just calls `fn()`, and the `asm()` block stores a **PC-relative 32-bit offset** to that stub, resolved back to a real address only when read (`initcall_from_entry()`, used below). This trades a small amount of decode overhead for a smaller `initcall*.init` section, since a 4-byte relative offset is half the size of a full pointer on 64-bit. Without `CONFIG_HAVE_ARCH_PREL32_RELOCATIONS`, `____define_initcall()` falls back to the plain static function-pointer array this section used to show exclusively.

The linker script (`arch/x86/kernel/vmlinux.lds.S`, via `include/asm-generic/vmlinux.lds.h`) collects all `.initcall*.init` sections in level order. `do_initcalls()` iterates this array and calls each function pointer:

```c
/* init/main.c */
static void __init do_initcall_level(int level, char *command_line)
{
    initcall_entry_t *fn;

    parse_args(initcall_level_names[level],
               command_line, __start___param,
               __stop___param - __start___param,
               level, level,
               NULL, ignore_unknown_bootoption);

    do_trace_initcall_level(initcall_level_names[level]);
    for (fn = initcall_levels[level]; fn < initcall_levels[level+1]; fn++)
        do_one_initcall(initcall_from_entry(fn));
}

static void __init do_initcalls(void)
{
    int level;
    size_t len = saved_command_line_len + 1;
    char *command_line;

    command_line = kzalloc(len, GFP_KERNEL);
    if (!command_line)
        panic("%s: Failed to allocate %zu bytes\n", __func__, len);

    for (level = 0; level < ARRAY_SIZE(initcall_levels) - 1; level++) {
        /* Parser modifies command_line, restore it each time */
        strcpy(command_line, saved_command_line);
        do_initcall_level(level, command_line);
    }

    kfree(command_line);
}
```

Two things worth noting beyond the obvious level-by-level dispatch: `do_initcall_level()` re-runs `parse_args()` against each level's own module-parameter slice (so `module.param=value`-style boot arguments are matched against the right level, not just once globally at `parse_early_param()` time), and `do_initcalls()` re-copies `saved_command_line` into its scratch buffer before every level because `parse_args()` mutates the string it's given as it walks it — without the restore, only the first level would see the full, unmodified command line.

The initcall return value matters: a non-zero return causes a `pr_warn` message but does not stop the boot process (unless `initcall_debug` is set to a stricter mode). An initcall that returns an error is simply logged and skipped.

---

## `__init` and `__exit` sections

### `__init`

Functions annotated with `__init` are placed in the `.init.text` ELF section. After `do_initcalls()` completes and the init process starts, the kernel frees the entire `.init.text` and `.init.data` sections:

```c
/* init/main.c */
static int __ref kernel_init(void *unused)
{
    ...
    free_initmem();
    ...
}
```

`kernel_init()` is annotated `__ref`, not `__init` — it can't be `__init` itself, because it's the function that calls `free_initmem()` to free the `.init.text`/`.init.data` sections. A function placed in `.init.text` that's still running when that section gets freed would be calling for its own page to be reclaimed out from under it. `__ref` tells modpost "yes, this function references `__init` code/data on purpose, don't warn about it."

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

### Kernel source

- [init/main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/init/main.c) — `start_kernel()`, `rest_init()`, `kernel_init()`, and `do_initcalls()`
- [include/linux/init.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/init.h) — the `__init`/`__exit` section macros and the `early_initcall()` … `late_initcall()` level macros
- [arch/x86/kernel/head_64.S](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/head_64.S) — `startup_64`, the x86-64 assembly entry point that runs before `start_kernel()`
- [arch/arm64/kernel/head.S](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm64/kernel/head.S) — `primary_entry`, the arm64 equivalent
- [arch/x86/kernel/setup.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/setup.c) — `setup_arch()` on x86-64: e820 parsing, memblock and page table setup, ACPI table parsing
- [kernel/cpu.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/cpu.c) — `boot_cpu_init()`
- [mm/mm_init.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mm_init.c) — `mm_core_init()`
- [mm/page_alloc.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) — `build_all_zonelists()`
- [mm/slub.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slub.c) — `kmem_cache_init()`, the SLUB bootstrap, and `kmem_cache_init_late()`, the later `slub_flushwq`/freelist-randomization setup
- [security/lsm_init.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/security/lsm_init.c) — `early_security_init()`: initializes the LSMs flagged "early"
- [kernel/sched/core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/core.c) — `sched_init()`
- [kernel/rcu/tree.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/rcu/tree.c) — `rcu_init()`
- [kernel/workqueue.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/workqueue.c) — `workqueue_init_early()`
- [kernel/printk/printk.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/printk/printk.c) — `console_init()`
- [include/asm-generic/vmlinux.lds.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/asm-generic/vmlinux.lds.h) — `INIT_CALLS`/`INIT_CALLS_LEVEL`, the linker macros that lay out `.initcall*.init` sections in level order

### Related pages

- [Kernel Boot Parameters](boot-params.md) — how `early_param` and `__setup` are parsed
- [Module Init and Initcalls](initcalls-modules.md) — the module side of `module_init()`
- [printk and Kernel Logging](printk.md) — why printk works after `console_init()` but not before
- [memblock: The Boot-Time Memory Allocator](../mm/memblock.md) — the allocator `setup_arch()` initializes, used before the buddy allocator exists
- [SLUB Allocator Internals](../mm/slab-internals.md) — `struct kmem_cache`, freelist mechanics, and per-CPU caches: the runtime machinery `kmem_cache_init()` bootstraps
- [Runqueues and Task Selection](../sched/runqueues.md) — the per-CPU `struct rq` that `sched_init()` allocates
- [RCU (Read-Copy-Update)](../locking/rcu.md) — what becomes safe to use after `rcu_init()`

### External

- [The Linux/x86 Boot Protocol](https://docs.kernel.org/arch/x86/boot.html) — the boot loader/kernel handoff that precedes `startup_64`
- [Kernel Parameters: `initcall_debug`](https://docs.kernel.org/admin-guide/kernel-parameters.html) — official description of the boot parameter covered in "Observing boot order"
