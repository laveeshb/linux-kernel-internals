# SYSCALL_DEFINE and Dispatch

> How syscalls are defined in C and wired into the dispatch table

## SYSCALL_DEFINE macro

Every syscall in the kernel is defined using a macro that:
1. Creates a function with the right signature (`asmlinkage`)
2. Handles argument extraction from `struct pt_regs`
3. Provides instrumentation hooks (tracepoints, audit)

```c
/* include/linux/syscalls.h */

/* SYSCALL_DEFINE<N> where N is the number of arguments */
SYSCALL_DEFINE0(getpid)
SYSCALL_DEFINE1(close, unsigned int, fd)
SYSCALL_DEFINE3(write, unsigned int, fd,
                const char __user *, buf,
                size_t, count)
SYSCALL_DEFINE6(mmap, unsigned long, addr,
                unsigned long, len,
                unsigned long, prot,
                unsigned long, flags,
                unsigned long, fd,
                unsigned long, off)
```

The `__user` annotation marks pointers that point into userspace (not kernel memory). The sparse tool uses this to catch missing `copy_from_user` calls.

### What SYSCALL_DEFINE expands to

```c
/* SYSCALL_DEFINE3(write, unsigned int, fd, const char __user *, buf, size_t, count)
   expands to approximately: */

static long __do_sys_write(unsigned int fd, const char __user *buf, size_t count);

/* Outer wrapper: extracts args from pt_regs */
__visible long __x64_sys_write(const struct pt_regs *regs)
{
    return __do_sys_write(
        (unsigned int)regs->di,    /* rdi = first arg */
        (const char __user *)regs->si,  /* rsi */
        (size_t)regs->dx           /* rdx */
    );
}

/* Also creates __ia32_sys_write for 32-bit compat */

/* And the actual implementation: */
static long __do_sys_write(unsigned int fd, const char __user *buf, size_t count)
{
    /* implementation here */
}

/* SYSCALL_METADATA() emits the struct syscall_metadata + trace events
 * ftrace's syscall tracepoints use — it's tracing-only, not audit; the
 * audit hooks are wired in separately (see Syscall Auditing) */
```

### Full example: sys_write

```c
/* fs/read_write.c */
SYSCALL_DEFINE3(write, unsigned int, fd, const char __user *, buf,
                size_t, count)
{
    return ksys_write(fd, buf, count);
}

ssize_t ksys_write(unsigned int fd, const char __user *buf, size_t count)
{
    CLASS(fd_pos, f)(fd);  /* cleanup-guard: auto fdput_pos() on return */
    ssize_t ret = -EBADF;

    if (!fd_empty(f)) {
        loff_t pos, *ppos = file_ppos(fd_file(f));
        if (ppos) {
            pos = *ppos;
            ppos = &pos;
        }
        ret = vfs_write(fd_file(f), buf, count, ppos);
        if (ret >= 0 && ppos)
            fd_file(f)->f_pos = pos;
    }

    return ret;
}
```

Note the `ksys_write()` wrapper: it allows calling the syscall logic from within the kernel (e.g., in `init` code) without going through the syscall entry path. This pattern is used for syscalls that the kernel itself needs to call internally.

`CLASS(fd_pos, f)(fd)` replaced the older `struct fd f = fdget_pos(fd); ... fdput_pos(f);` pattern: it's a scope-based cleanup guard (`DEFINE_CLASS`-generated) that calls `fdput_pos()` automatically when `f` goes out of scope, so every return path releases the reference without an explicit call. `fd_empty(f)`/`fd_file(f)` are the accessors for the guarded fd, replacing direct `f.file` access.

## The syscall table

### 64-bit: arch/x86/entry/syscalls/syscall_64.tbl

```
# <number>  <abi>   <name>         <entry point>
0           common  read           sys_read
1           common  write          sys_write
2           common  open           sys_open
3           common  close          sys_close
...
```

ABI can be `64` (only for 64-bit), `x32` (x32 ABI), or `common` (both). The build system generates `arch/x86/include/generated/asm/syscalls_64.h`:

```c
/* Auto-generated */
__SYSCALL(0,  sys_read)
__SYSCALL(1,  sys_write)
__SYSCALL(2,  sys_open)
...
```

Which is included in the syscall table array:

```c
/* arch/x86/entry/syscall_64.c */
const sys_call_ptr_t sys_call_table[] = {
#include <asm/syscalls_64.h>
};
```

`sys_call_table[]` is no longer how dispatch actually happens — real dispatch (`do_syscall_64()` in the same file) goes through `x64_sys_call()`, a `switch` statement built from the same `<asm/syscalls_64.h>` include (`case nr: return __x64_##sym(regs);`). This replaced an indexed call through the function-pointer array specifically to avoid an *indirect* call: as [the commit that made the change](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=1e3ad78334a69b36e107232e337f9d693dcc9df2) explains, a `switch` lets the compiler emit conditional branches instead, and a misprediction there only speculatively runs the *wrong syscall* — a bounded, harmless outcome — rather than an indirect call mispredicting to attacker-influenced code. The array itself is kept only because `kernel/trace/trace_syscalls.c` still wants each syscall's address.

### Architecture-independent: include/uapi/asm-generic/unistd.h

For architectures without their own syscall tables:

```c
/* include/uapi/asm-generic/unistd.h */
#define __NR_io_setup 0
__SC_COMP(__NR_io_setup, sys_io_setup, compat_sys_io_setup)
#define __NR_io_destroy 1
__SYSCALL(__NR_io_destroy, sys_io_destroy)
...
```

## Syscall ABI stability

Once a syscall is merged, its number and argument semantics are **never changed**. This is a hard kernel rule: user-space must not break.

Specific guarantees:

- Syscall numbers don't change
- Existing arguments are never reinterpreted
- Structs passed by pointer only grow (new fields at the end, with zero meaning "not set")

For new features, the kernel adds new syscalls rather than extend old ones in incompatible ways:

- `clone()` → `clone3()` (struct-based, extensible)
- `open()` → `openat()` → `openat2()` (added `how` struct)
- `read()` → `pread64()`, `readv()`, `preadv()`, `preadv2()`

## struct-based syscalls (modern pattern)

The modern approach passes arguments in a struct, allowing future extension without new syscalls:

```c
/* struct-based syscall: clone3 (kernel/fork.c) */
SYSCALL_DEFINE2(clone3, struct clone_args __user *, uargs, size_t, size)
{
    int err;
    struct kernel_clone_args kargs;   /* NOT struct clone_args — see below */
    pid_t set_tid[MAX_PID_NS_LEVEL];

    kargs.set_tid = set_tid;

    err = copy_clone_args_from_user(&kargs, uargs, size);
    if (err)
        return err;

    if (!clone3_args_valid(&kargs))
        return -EINVAL;

    return kernel_clone(&kargs);
}
```

Two distinct structs are involved, easy to conflate because both are visible here:

- `struct clone_args` (`include/uapi/linux/sched.h`) is the fixed, versioned, userspace-shaped layout `uargs` points to — the ABI contract, all `__aligned_u64` fields.
- `struct kernel_clone_args` (`include/linux/sched/task.h`) is the kernel's internal representation `kargs` — a superset used everywhere clone happens (`fork()`, `vfork()`, kernel threads, `io_uring` workers, not just `clone3()`), with kernel-only fields like `fn`/`fn_arg` that have no userspace equivalent.

`copy_clone_args_from_user()` (also in `kernel/fork.c`) is what bridges them: it calls `copy_struct_from_user(&args, sizeof(args), uargs, usize)` into a local `struct clone_args`, handling the versioning —

- If `usize < sizeof(args)`: copies what's there, zeros the rest (old userspace, new kernel)
- If `usize > sizeof(args)`: checks that the extension bytes are zero (new userspace, old kernel)

— then copies the validated fields across into the `struct kernel_clone_args` the rest of the clone path uses.

## 32-bit compat syscalls

64-bit kernels support 32-bit userspace binaries. Where argument layout or size actually differs between ABIs, `COMPAT_SYSCALL_DEFINEx()` defines a separate compat entry point. But that's only needed when it's needed — `mmap2` is a useful counter-example: it doesn't need a compat variant at all, because its arguments are already the same width and meaning on every ABI:

```c
/* mm/mmap.c — this is a NATIVE syscall, not COMPAT_SYSCALL_DEFINE: */
SYSCALL_DEFINE6(mmap_pgoff, unsigned long, addr, unsigned long, len,
                unsigned long, prot, unsigned long, flags,
                unsigned long, fd, unsigned long, pgoff)
{
    return ksys_mmap_pgoff(addr, len, prot, flags, fd, pgoff);
}
```

`mmap2` (i386 syscall 192) is wired directly to `sys_mmap_pgoff` in `arch/x86/entry/syscalls/syscall_32.tbl`, with no separate compat entry point at all — unlike legacy `mmap` (i386 syscall 90), which does have one (`compat_sys_ia32_mmap`). `mmap2` takes the offset in page units already (`pgoff`, not bytes), so it needs no ABI-specific translation of its own. The 64-bit `mmap` syscall (a *different* entry point, `SYSCALL_DEFINE6(mmap, ...)` in `arch/x86/kernel/sys_x86_64.c`) does the byte-to-page-unit conversion its own ABI requires — right-shifting the byte offset by `PAGE_SHIFT` — before calling into the same shared internal helper, `ksys_mmap_pgoff()`, that `sys_mmap_pgoff` also calls.

There's no separate `ia32_sys_call_table` symbol — `arch/x86/entry/syscall_32.c` mirrors `syscall_64.c`'s pattern exactly: a vestigial `sys_call_table[]` array (only built for pure 32-bit kernels, kept for tracing) alongside the real dispatcher, `ia32_sys_call()`, another `switch` statement built from `<asm/syscalls_32.h>`.

## Syscall tracing and audit

The SYSCALL_DEFINE macro automatically generates tracepoints:

```bash
# Available syscall tracepoints
ls /sys/kernel/tracing/events/syscalls/
# sys_enter_read  sys_exit_read  sys_enter_write  sys_exit_write ...

# Trace all write() calls
echo 1 > /sys/kernel/tracing/events/syscalls/sys_enter_write/enable
cat /sys/kernel/tracing/trace_pipe
# bash-1234 [000] sys_enter_write: fd=1, buf=0x7fff..., count=6

# strace uses ptrace, which intercepts at a different level
strace -e write ls
```

The `audit` subsystem also hooks into syscall entry/exit for security logging:

```bash
# Audit all opens by uid 1000
auditctl -a always,exit -F arch=b64 -S open,openat -F uid=1000
ausearch -k access
```

## Slow path vs fast path

Some syscalls go through a "slow path" that handles signals, scheduling, restart:

```c
/* kernel/entry/common.c (simplified — the real loop is split into an
 * outer exit_to_user_mode_loop() and this inline helper, and covers
 * more work items than shown: uprobes, livepatch, arch-specific work) */
static unsigned long __exit_to_user_mode_loop(struct pt_regs *regs,
                                               unsigned long ti_work)
{
    while (ti_work & EXIT_TO_USER_MODE_WORK_LOOP) {
        local_irq_enable();

        if (ti_work & (_TIF_NEED_RESCHED | _TIF_NEED_RESCHED_LAZY))
            schedule();                        /* preemption point */

        if (ti_work & (_TIF_SIGPENDING | _TIF_NOTIFY_SIGNAL))
            arch_do_signal_or_restart(regs);    /* deliver signal */

        if (ti_work & _TIF_NOTIFY_RESUME)
            resume_user_mode_work(regs);        /* seccomp, ptrace notify */

        local_irq_disable();
        ti_work = read_thread_flags();          /* re-check for new work */
    }

    return ti_work;
}
```

This is why syscalls are preemption and signal delivery points — the kernel checks thread-info work flags on every syscall return. The real flag set also includes `_TIF_UPROBE` (pending uprobe callback) and `_TIF_PATCH_PENDING` (livepatch transition), each with their own handler in the loop.

## Further reading

### Kernel source

- [include/linux/syscalls.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/syscalls.h) — `SYSCALL_DEFINEx()`/`__SYSCALL_DEFINEx()` macro definitions and the `__MAP()` argument-marshaling machinery
- [arch/x86/include/asm/syscall_wrapper.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/syscall_wrapper.h) — x86's override of `__SYSCALL_DEFINEx()`: decodes `pt_regs` into the `__x64_sys_*()`/`__ia32_sys_*()` stubs
- [fs/read_write.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/read_write.c) — `SYSCALL_DEFINE3(write, ...)` and `ksys_write()`, the worked example on this page
- [kernel/fork.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/fork.c) — `SYSCALL_DEFINE2(clone3, ...)` and `copy_clone_args_from_user()`: the struct-based, extensible syscall pattern
- [include/uapi/linux/sched.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/sched.h) — `struct clone_args`, the versioned userspace ABI struct `clone3()` copies from
- [include/linux/sched/task.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/sched/task.h) — `struct kernel_clone_args`, the internal struct shared by every clone path (`fork()`, `vfork()`, kernel threads), not just `clone3()`
- [mm/mmap.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mmap.c) — `SYSCALL_DEFINE6(mmap_pgoff, ...)`, the native (non-compat) syscall `mmap2` is wired to directly
- [arch/x86/entry/syscalls/syscall_32.tbl](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/entry/syscalls/syscall_32.tbl) — the i386 syscall table showing `mmap2` → `sys_mmap_pgoff` with no compat entry point, versus legacy `mmap` → `sys_old_mmap`/`compat_sys_ia32_mmap`
- [arch/x86/entry/syscalls/syscall_64.tbl](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/entry/syscalls/syscall_64.tbl) — the syscall number → entry point table that `sys_call_table` is generated from
- [arch/x86/entry/syscall_64.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/entry/syscall_64.c) — `do_syscall_64()` and `x64_sys_call()`: the real `switch`-based dispatch that replaced indexing `sys_call_table[]` directly
- [arch/x86/entry/syscall_32.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/entry/syscall_32.c) — the 32-bit/IA32-compat mirror of `syscall_64.c`: `ia32_sys_call()`, the same `switch`-based dispatch pattern
- [commit 1e3ad78334a6](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=1e3ad78334a69b36e107232e337f9d693dcc9df2) — "x86/syscall: Don't force use of indirect calls for system calls", the change and its stated Spectre-mitigation rationale
- [kernel/entry/common.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/entry/common.c) — `exit_to_user_mode_loop()`/`__exit_to_user_mode_loop()`: the slow-path signal/reschedule/uprobe/livepatch checks on syscall return

### Man pages

- [`syscalls(2)`](https://man7.org/linux/man-pages/man2/syscalls.2.html) — overview of Linux system calls and the wrapper-function naming convention
- [`strace(1)`](https://man7.org/linux/man-pages/man1/strace.1.html) — user-space syscall tracing via `ptrace`, as used in this page's tracing example

### Related pages

- [Syscall Entry Path](syscall-entry.md) — Hardware mechanism and entry assembly
- [Adding a new syscall](adding-syscall.md) — Step-by-step guide
- [32-bit Compat Syscalls](compat.md) — how `COMPAT_SYSCALL_DEFINEx()` and the compat table actually work
- [ptrace and Syscall Interception](ptrace-interception.md) — how strace, debuggers, and seccomp-notify intercept syscalls
- [Syscall Auditing](audit.md) — the Linux Audit subsystem referenced in the tracing/audit section
- [Syscall Restart Mechanisms](restart-block.md) — how the slow path's signal handling leads to `ERESTARTSYS`/`restart_syscall()`

### LWN articles

- [Anatomy of a system call, part 1](https://lwn.net/Articles/604287/) — David Drysdale, LWN.net (2014); walks through `SYSCALL_DEFINEn()`, using `read()`'s `fs/read_write.c` definition as the example

### External

- [Adding a New System Call](https://docs.kernel.org/process/adding-syscalls.html) — the kernel's official process guide (`Documentation/process/adding-syscalls.rst`)
