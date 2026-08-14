# Kernel Panic and Oops

> Oops handling, `panic()`, call stack decoding, and kdump

## What triggers an oops?

An "oops" is the kernel's report of a fault it cannot safely recover from in the current context. Common triggers on x86-64:

- **NULL pointer dereference** — accessing address `0x0` through `0xfff` (the first page, 4 KB, is unmapped)
- **Use-after-free** — accessing memory that has been returned to the allocator and possibly reallocated
- **Stack corruption** — stack smash overwrites the return address; detected by the stack canary or ORC unwinder
- **Invalid opcode (#UD)** — executing `ud2` (used by `BUG()`) or a truly invalid instruction
- **General protection fault (#GP)** — misaligned access to a privileged resource, segment limit violation
- **Double fault (#DF)** — fault while handling a fault, often a stack overflow

The CPU raises an exception, the IDT handler runs, and control reaches `do_page_fault()`, `do_general_protection()`, or similar. If the fault occurred in kernel code (not a user program), the handler calls `die()`.

---

## `die()` and the oops path

```c
/* arch/x86/kernel/dumpstack.c */

void die(const char *str, struct pt_regs *regs, long err)
{
    unsigned long flags = oops_begin();
    int sig = SIGSEGV;

    if (__die(str, regs, err))   /* formats and prints the oops message */
        sig = 0;

    oops_end(flags, regs, sig);  /* decides: kill task or panic */
}
```

### `oops_begin()` / `oops_end()`

`oops_begin()` takes a raw spinlock (`die_lock`) to serialize concurrent oopses across CPUs — nested oopses on the *same* CPU (tracked via `die_owner`/`die_nest_count`) are allowed through rather than deadlocking — then calls `console_verbose()` and `bust_spinlocks(1)` to flush any spinning console writers. It returns the saved interrupt flags so `oops_end()` can restore them. Neither function touches any watchdog, and there is no `oops_count` sysctl.

`oops_end()` is where `kexec_should_crash()`/`crash_kexec()` are actually invoked (not inside `die()` itself), followed by releasing `die_lock`, tainting the kernel (`TAINT_DIE`), and — if `signr` is nonzero — deciding whether to `panic()` (always in interrupt context, or if `panic_on_oops` is set) or otherwise kill the offending task.

`oops_end()` re-enables the watchdog, calls `bust_spinlocks(0)`, and then either:
- Delivers `SIGSEGV` to the current task (if the task can be killed)
- Calls `panic()` if `panic_on_oops` sysctl is set or if the task cannot be killed (e.g., kernel thread)

---

## Anatomy of an oops message

```
BUG: unable to handle kernel NULL pointer dereference at 0000000000000008
PGD 0 P4D 0
Oops: 0002 [#1] SMP NOPTI
CPU: 3 PID: 1234 Comm: mydriver Tainted: G           O      5.15.0 #1
Hardware name: QEMU Standard PC (i440FX + PIIX, 1996)
RIP: 0010:my_driver_read+0x2c/0x80 [mydriver]
Code: 48 89 e5 41 54 53 48 89 fb 48 8b 47 08 48 85 c0 74 19 ...
RSP: 0018:ffffb3c4c0a1bdc8 EFLAGS: 00010246
RAX: 0000000000000000 RBX: ffff9d4b81234500 RCX: 0000000000000000
RDX: 0000000000000000 RSI: 0000000000000001 RDI: ffff9d4b81234500
RBP: ffffb3c4c0a1bdd0 R08: 0000000000000000 R09: 0000000000000000
R10: 0000000000000000 R11: 0000000000000000 R12: ffff9d4b81234500
R13: 0000000000000000 R14: 0000000000000000 R15: 0000000000000000
FS:  00007f8a3c4a4740(0000) GS:ffff9d4ba7c00000(0000) knlGS:0000000000000000
CS:  0010 DS: 0000 ES: 0000 CR0: 0000000080050033
CR2: 0000000000000008 CR3: 000000004a210001 CR4: 00000000003706e0
Call Trace:
 <TASK>
 vfs_read+0xb3/0x190
 ksys_read+0x5a/0xd0
 __x64_sys_read+0x1a/0x20
 do_syscall_64+0x5b/0xc0
 entry_SYSCALL_64_after_hwframe+0x61/0xcb
 </TASK>
```

Key fields:

| Field | Meaning |
|-------|---------|
| `BUG: unable to handle kernel NULL pointer dereference at 0000000000000008` | Fault type and faulting address |
| `Oops: 0002 [#1]` | Error code (0002 = write fault); `[#1]` = first oops in this boot |
| `Tainted: G ... O` | Taint flags (see below) |
| `RIP: 0010:my_driver_read+0x2c/0x80` | Instruction pointer: function + offset / function size |
| `CR2` | The address that caused the page fault (faulting virtual address) |
| `Call Trace` | Stack unwinding from current frame to syscall entry |

---

## Taint flags

The `Tainted:` line summarizes kernel integrity state. A "tainted" kernel has been modified in ways that may make bug reports less reliable.

| Flag | Meaning |
|------|---------|
| `G` | All loaded modules are GPL-licensed (no taint from this) |
| `P` | A proprietary (non-GPL) module has been loaded |
| `O` | An out-of-tree (not mainline) module has been loaded |
| `W` | A WARN() was triggered |
| `D` | `die()` has been called at least once |
| `E` | An unsigned module was loaded |
| `C` | A staging driver is loaded |
| `X` | Auxiliary taint (architecture-specific) |

```bash
# Check taint state from userspace:
cat /proc/sys/kernel/tainted
# 0 = untainted
# Each bit corresponds to a flag; see Documentation/admin-guide/tainted-kernels.rst
```

---

## Stack unwinding: ORC

Since Linux 4.14, x86-64 uses the **ORC (Oops Rewind Capability) unwinder** instead of frame pointer-based unwinding. ORC is more reliable because it works even when the compiler omits frame pointers (which is common with optimization).

At build time, `objtool` analyzes each function and generates an ORC entry describing the stack layout at every instruction:

```c
/* arch/x86/include/asm/orc_types.h */
struct orc_entry {
    s16     sp_offset;   /* stack pointer offset from the CFA */
    s16     bp_offset;   /* base pointer offset */
    unsigned int sp_reg:4;   /* register containing the CFA */
    unsigned int bp_reg:4;
    unsigned int type:3;
    unsigned int signal:1;
};
```

These entries are stored in `.orc_unwind` and `.orc_unwind_ip` ELF sections. The unwinder (`arch/x86/kernel/unwind_orc.c`) looks up the ORC entry for the current RIP and uses it to unwind one frame at a time, producing the `Call Trace` in the oops message.

On arm64, the kernel uses a frame-pointer-based unwinder. arm64 requires `CONFIG_FRAME_POINTER`, ensuring the frame pointer chain is always intact, so the unwinder can walk frames without architecture-specific unwind tables.

---

## `WARN()`, `BUG()`, and their variants

```c
/* include/linux/bug.h, include/asm-generic/bug.h */

/* Print stack trace and continue. Does NOT kill the task. */
WARN(condition, fmt, ...)
WARN_ON(condition)          /* no format string */
WARN_ONCE(condition, fmt, ...)  /* fires at most once */
WARN_ON_ONCE(condition)

/* Trigger an oops (invalid opcode on x86; kills task or panics). */
BUG()
BUG_ON(condition)
```

`BUG()` on x86 expands to the `ud2` instruction (undefined instruction opcode `0x0f 0x0b`). This raises a `#UD` exception, which reaches the kernel's `invalid_op` handler, which calls `die()`.

`WARN()` calls `warn_slowpath_fmt()` → `__warn()`, which calls `dump_stack()` and `print_oops_end_marker()` but does not trigger `die()`. Execution continues after `WARN()`.

---

## `panic()`: the point of no return

```c
/* kernel/panic.c */
void panic(const char *fmt, ...)
{
    /* 1. Disable preemption and local IRQs */
    preempt_disable();

    /* 2. Format and print the panic message */
    pr_emerg("Kernel panic - not syncing: %s\n", buf);

    /* 3. Trigger any registered panic notifiers */
    atomic_notifier_call_chain(&panic_notifier_list, 0, buf);

    /* 4. Attempt to kexec into the crash kernel */
    crash_kexec(NULL);

    /* 5. If kdump didn't take over, try to reboot */
    if (panic_timeout > 0) {
        pr_emerg("Rebooting in %d seconds..\n", panic_timeout);
        ssleep(panic_timeout);
        emergency_restart();
    }

    /* 6. Halt */
    for (;;)
        halt();
}
```

The `panic_notifier_list` allows subsystems to register callbacks that run before the system halts. netconsole, pstore, and kdump all hook into this chain.

### `panic_on_oops` sysctl

```bash
# Read current value:
cat /proc/sys/kernel/panic_on_oops
# 0 = try to recover (kill task)
# 1 = panic on oops

# Set for production (many sites do this):
echo 1 > /proc/sys/kernel/panic_on_oops
```

When `panic_on_oops = 1`, `oops_end()` calls `panic()` instead of attempting to continue. This is appropriate in production environments where a partially-corrupted kernel state is worse than a clean reboot.

### `panic=N` boot parameter

```
panic=30    # reboot 30 seconds after panic
panic=-1    # reboot immediately
panic=0     # do not reboot (halt forever, default)
```

---

## kdump: capturing crash memory

kdump allows the kernel to save a complete memory dump when it panics. The mechanism uses `kexec(2)` to boot a pre-loaded "crash kernel" from a reserved memory region, bypassing normal boot.

### Setup

```bash
# Reserve memory for the crash kernel at boot time:
# (add to GRUB_CMDLINE_LINUX in /etc/default/grub)
crashkernel=256M

# Load the crash kernel (run at boot via initscript or systemd unit):
kexec -p /boot/vmlinuz-$(uname -r) \
    --initrd=/boot/initrd.img-$(uname -r) \
    --append="root=/dev/sda1 irqpoll maxcpus=1 reset_devices"
```

### What happens on panic

1. `crash_kexec()` is called from `panic()` or `die()`
2. kexec switches to the crash kernel's page tables and jumps to its entry point
3. The crash kernel boots as a fresh kernel (using only the reserved memory region)
4. The crash kernel exposes the original kernel's memory as `/proc/vmcore` (an ELF core dump)
5. A userspace tool (typically `makedumpfile`) copies `/proc/vmcore` to disk

### Analyzing the dump

```bash
# On the crashed system (or a system with the same kernel):
crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux vmcore

# Inside crash:
crash> bt         # backtrace of the crashed task
crash> log        # kernel log ring buffer
crash> ps         # all processes at time of crash
crash> vm         # virtual memory state
```

The `crash` utility (from `crash-utility` package) is the standard tool for post-mortem analysis of Linux kernel vmcores.

---

## Decoding oops output

### `faddr2line`

```bash
# Decode a function+offset from the oops:
scripts/faddr2line vmlinux my_driver_read+0x2c

# Output:
# my_driver_read (drivers/mydriver/mydriver.c:142)
```

### `addr2line`

```bash
# Decode a raw address (requires debug symbols):
addr2line -e vmlinux -a ffffffff81234567

# Or with the offset from the oops RIP:
addr2line -e vmlinux -i -f ffffffff81234567
```

### `decode_stacktrace.sh`

```bash
# Pipe dmesg through the kernel's decode script:
dmesg | ./scripts/decode_stacktrace.sh vmlinux . /path/to/modules

# Before:
# my_driver_read+0x2c/0x80 [mydriver]
# After:
# my_driver_read (drivers/mydriver/mydriver.c:142)
```

### `objdump` for instruction-level analysis

```bash
# Disassemble around the faulting instruction:
objdump -d --start-address=0xffffffff81234540 \
           --stop-address=0xffffffff812345a0 vmlinux
```

---

## KASAN: Kernel Address SANitizer

KASAN (`CONFIG_KASAN`) is a compile-time instrumentation tool that detects use-after-free and out-of-bounds accesses. It maintains a "shadow memory" region where each byte tracks the validity of 8 bytes of real memory.

When an access is made, the compiler-inserted instrumentation checks the shadow byte. An invalid access produces an oops-style report:

```
BUG: KASAN: use-after-free in my_driver_read+0x2c/0x80
Read of size 8 at addr ffff888012345600 by task mydriver/1234

CPU: 3 PID: 1234 Comm: mydriver Tainted: G    B
Call Trace:
 kasan_report+0xe1/0x180
 my_driver_read+0x2c/0x80

Allocated by task 1234:
 kmalloc+0x...
 my_driver_alloc+0x...

Freed by task 5678:
 kfree+0x...
 my_driver_free+0x...

The buggy address belongs to the object at ffff888012345600
 which belongs to the cache kmalloc-256 of size 256
```

Generic KASAN uses one shadow byte per 8 bytes of real memory, adding approximately 12.5% memory overhead (for the shadow region), plus 2–3x CPU/execution overhead from the compiler-inserted instrumentation. It is used in development and CI, not production. Two variants exist:

- **Generic KASAN** (`CONFIG_KASAN_GENERIC`): full shadow memory, highest overhead
- **SW tag KASAN** (`CONFIG_KASAN_SW_TAGS`): uses ARM64 top-byte ignore for lower overhead
- **HW tag KASAN** (`CONFIG_KASAN_HW_TAGS`): uses ARM64 MTE hardware, very low overhead

---

## KFENCE: Kernel Electric-Fence

KFENCE (`CONFIG_KFENCE`, Linux 5.12+) is a sampling-based memory safety detector designed for production use. Instead of instrumenting every allocation, it periodically intercepts a small percentage of `kmalloc` and `kmem_cache_alloc` calls and places the returned object on a special "guarded" page flanked by guard pages.

Any access to the guard pages triggers a page fault, caught by KFENCE's fault handler, which reports the violation:

```
BUG: KFENCE: use-after-free in my_driver_read+0x2c/0x80

Use-after-free read at 0x... (in kfence-#42):
 my_driver_read+0x2c/0x80

kfence-#42 [0x...-0x...], size=256, cache=kmalloc-256
 allocated by task 1234:
  my_driver_alloc+0x... at ...

 freed by task 5678:
  my_driver_free+0x... at ...
```

The sampling rate is controlled by `CONFIG_KFENCE_SAMPLE_INTERVAL` (default 100ms) and can be tuned at runtime via `/sys/module/kfence/parameters/sample_interval`. The overhead is low enough for production systems: typically less than 1% CPU impact.

KFENCE does not catch every bug (only sampled allocations are guarded), but it provides continuous coverage over time in production, often catching bugs that KASAN would miss due to its development-only deployment.

---

## Further reading

### Kernel source

- [kernel/panic.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/panic.c) — `panic()`/`vpanic()`: message formatting, the panic notifier chain, and the reboot/halt sequence
- [kernel/crash_core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/crash_core.c) — `kexec_should_crash()` and `crash_kexec()`: the kdump entry point invoked from both `oops_end()` and `vpanic()`
- [arch/x86/kernel/dumpstack.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/dumpstack.c) — `die()`, `oops_begin()`, `oops_end()`: the actual x86 oops path
- [arch/x86/kernel/traps.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/traps.c) — exception entry points (`exc_general_protection()`, `exc_invalid_op()`, `exc_double_fault()`, etc.) that call `die()`
- [arch/x86/kernel/unwind_orc.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/unwind_orc.c) — `orc_find()`: ORC entry lookup used to produce `Call Trace`
- [arch/x86/include/asm/orc_types.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/orc_types.h) — `struct orc_entry` layout
- [include/asm-generic/bug.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/asm-generic/bug.h) — `WARN()`/`BUG()` family, and the `warn_slowpath_fmt()`/`__warn()` declarations
- [lib/bust_spinlocks.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/bust_spinlocks.c) — `bust_spinlocks()`: the `oops_in_progress` counter used to keep console output readable during an oops

### Man pages

- [`kexec_load(2)`](https://man7.org/linux/man-pages/man2/kexec_load.2.html) — the underlying syscall behind `kexec -p`; documents `KEXEC_ON_CRASH`, the flag that registers a crash kernel

### Related pages

- [Oops Analysis](../debugging/oops-analysis.md) — step-by-step guide to reading an oops
- [kdump and crash](../debugging/kdump.md) — setting up and using kdump in depth
- [KASAN](../mm/kasan.md) — KASAN configuration and use
- [KFENCE](../mm/kfence.md) — KFENCE in production

### LWN articles

- [ORC unwinder](https://lwn.net/Articles/728721/) — Josh Poimboeuf's patch series and design writeup introducing the ORC unwinder and objtool-generated unwind tables (2017)
- [Crash dumps with kexec](https://lwn.net/Articles/108595/) — Jonathan Corbet on the original kexec-based crash dump design (2004)
- [The kernel address sanitizer](https://lwn.net/Articles/612153/) — Jake Edge's introduction to KASAN (2014)
- [KFENCE: A low-overhead sampling-based memory safety error detector](https://lwn.net/Articles/830877/) — Marco Elver's design writeup for KFENCE (2020)

### External

- [Tainted kernels](https://docs.kernel.org/admin-guide/tainted-kernels.html) — full taint flag reference
- [Kdump](https://docs.kernel.org/admin-guide/kdump/kdump.html) — kdump setup guide
