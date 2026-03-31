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

/* SYSCALL_METADATA() creates tracepoint data and audit hooks */
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
    struct fd f = fdget_pos(fd);  /* get file from fd table */
    ssize_t ret = -EBADF;

    if (f.file) {
        loff_t pos, *ppos = file_ppos(f.file);
        if (ppos) {
            pos = *ppos;
            ppos = &pos;
        }
        ret = vfs_write(f.file, buf, count, ppos);
        if (ret >= 0 && ppos)
            f.file->f_pos = pos;
        fdput_pos(f);
    }

    return ret;
}
```

Note the `ksys_write()` wrapper: it allows calling the syscall logic from within the kernel (e.g., in `init` code) without going through the syscall entry path. This pattern is used for syscalls that the kernel itself needs to call internally.

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
asmlinkage const sys_call_ptr_t sys_call_table[] = {
#include <asm/syscalls_64.h>
};
const int sys_call_table_size = sizeof(sys_call_table);
```

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
/* struct-based syscall: clone3 */
SYSCALL_DEFINE2(clone3, struct clone_args __user *, uargs, size_t, size)
{
    struct clone_args kargs;
    pid_t set_tid[MAX_PID_NS_LEVEL];

    if (size < CLONE_ARGS_SIZE_VER0)
        return -EINVAL;
    if (size > PAGE_SIZE)
        return -E2BIG;

    /* Copy only what caller provided; zero-initialize the rest */
    if (copy_struct_from_user(&kargs, sizeof(kargs), uargs, size))
        return -EFAULT;

    /* ... validate and use kargs ... */
}
```

`copy_struct_from_user` handles the versioning:
- If `size < sizeof(kargs)`: copies what's there, zeros the rest (old userspace)
- If `size > sizeof(kargs)`: checks that extension bytes are zero (new userspace, old kernel)

## 32-bit compat syscalls

64-bit kernels support 32-bit userspace binaries. Compat syscalls handle argument size differences:

```c
/* For types that differ between 32/64-bit: */
#ifdef CONFIG_COMPAT
COMPAT_SYSCALL_DEFINE6(mmap2, ...)
{
    /* 32-bit mmap uses 4KB page units for offset, not bytes */
    /* 32-bit uses u32 fd, offset; 64-bit uses long */
}
#endif
```

32-bit processes use `ia32_sys_call_table` (separate from `sys_call_table`).

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
/* syscall_exit_to_user_mode_work: checks on return to userspace */
static void exit_to_user_mode_loop(struct pt_regs *regs,
                                    u32 cached_flags)
{
    while (true) {
        local_irq_enable();

        if (cached_flags & _TIF_NEED_RESCHED)
            schedule();                  /* preemption point */

        if (cached_flags & _TIF_SIGPENDING)
            arch_do_signal_or_restart(regs);  /* deliver signal */

        if (cached_flags & _TIF_NOTIFY_RESUME)
            resume_user_mode_work(regs); /* seccomp, ptrace notify */

        /* Check again for new work */
        cached_flags = read_thread_flags();
        if (!(cached_flags & EXIT_TO_USER_MODE_WORK))
            break;
    }
}
```

This is why syscalls are preemption and signal delivery points — the kernel checks `TIF_*` flags on every syscall return.

## Further reading

- [Syscall Entry Path](syscall-entry.md) — Hardware mechanism and entry assembly
- [Adding a new syscall](adding-syscall.md) — Step-by-step guide
- `include/linux/syscalls.h` — SYSCALL_DEFINE macros
- `Documentation/process/adding-syscalls.rst` — Official guide for new syscalls
