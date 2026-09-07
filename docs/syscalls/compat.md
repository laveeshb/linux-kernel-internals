# 32-bit Compat Syscalls

> Supporting 32-bit userspace on 64-bit kernels

## Why compat exists

A 64-bit kernel can run 32-bit ELF binaries directly (via `CONFIG_IA32_EMULATION` on x86-64). The problem is that
32-bit and 64-bit ABIs differ in ways that go beyond register width:

- **Pointer size**: 32-bit userspace uses 4-byte pointers; the kernel uses 8-byte pointers.
- **`time_t` and `off_t`**: 32-bit ABIs define these as `int` (32 bits); 64-bit ABIs use `long` (64 bits).
- **Struct layout**: structs containing `long`, `size_t`, or pointer members have different padding and sizes.
- **Argument passing**: 32-bit x86 uses the `int 0x80` path or `sysenter`; arguments are 32-bit registers.

If a 32-bit process calls `read()`, it passes a 32-bit pointer for `buf`. The kernel cannot treat that as a 64-bit
pointer directly — it must zero-extend the value and validate it within the 32-bit address space. For simple
syscalls like `read()`, the difference is minor. For syscalls that pass structs containing `time_t`, `off_t`, or
embedded pointers (like `sendmsg()`, `stat()`, `select()`), the kernel needs entirely separate handlers to
translate the 32-bit layout into the kernel's internal representation.

## The COMPAT_SYSCALL_DEFINE macro

Compat syscall handlers are defined with `COMPAT_SYSCALL_DEFINE`, which lives in `include/linux/compat.h`:

```c
/* include/linux/compat.h */
COMPAT_SYSCALL_DEFINE3(read, unsigned int, fd,
                       char __user *, buf,
                       compat_size_t, count)
```

`COMPAT_SYSCALL_DEFINE` generates a C function named `compat_sys_xxx` (e.g., `compat_sys_read`). On x86, the
architecture-specific `__IA32_COMPAT_SYS_STUBx` macros in `arch/x86/include/asm/syscall_wrapper.h` then
generate a separate `__ia32_compat_sys_xxx` entry-point stub that decodes 32-bit registers and calls
`compat_sys_xxx`. The macro itself produces `compat_sys_xxx`, not the ia32 stub. The macro also generates
the necessary tracepoint metadata so compat syscalls appear in `ftrace` and `perf` output the same way native
syscalls do.

For syscalls where the argument types are identical at all widths (e.g., `close(int fd)`) the `SYSCALL_DEFINE`
handler is reused directly; the compat table points to the same `__x64_sys_close`.

## The compat syscall tables

On x86-64, 32-bit processes are dispatched through a separate table:

```
# arch/x86/entry/syscalls/syscall_32.tbl (partial)
# <number>  <abi>  <name>   <entry point>         <compat entry point>
3           i386   read     sys_read               # reuses 64-bit handler
...
11          i386   execve   sys_execve             compat_sys_execve
...
102         i386   socketcall  sys_socketcall       compat_sys_socketcall
...
```

The build system generates `arch/x86/include/generated/asm/syscalls_32.h`, which is included in:

```c
/* arch/x86/entry/syscall_32.c */
#define __SYSCALL(nr, sym) case nr: return __ia32_##sym(regs);
static noinline long ia32_sys_call(const struct pt_regs *regs, unsigned int nr)
{
	switch (nr) {
	#include <asm/syscalls_32.h>
	default: return __ia32_sys_ni_syscall(regs);
	}
}
```

When a 32-bit process enters the kernel via `int 0x80` or `sysenter`, the entry code detects the 32-bit CS
segment and calls `ia32_sys_call()`, which switches on the syscall number to the matching `__ia32_*` stub —
the same switch-based dispatch pattern the native 64-bit path uses (`x64_sys_call()`; see
[Syscall Entry Path](syscall-entry.md)). A `sys_call_table[]` array is still built for `CONFIG_X86_32`, but
only because `kernel/trace/trace_syscalls.c` needs a syscall-number-to-address table for tracing — it is not
used for dispatch.

## Key compat types

```c
/* include/asm-generic/compat.h (pulled in by each arch's asm/compat.h) */
typedef u32                 compat_uptr_t;   /* 32-bit userspace pointer */
typedef u32                 compat_size_t;   /* 32-bit size_t */
typedef s32                 compat_ssize_t;
typedef s32                 compat_long_t;
typedef u32                 compat_ulong_t;
typedef s32                 compat_int_t;
typedef s64 __attribute__((aligned(4))) compat_s64;
typedef u64 __attribute__((aligned(4))) compat_u64;
```

```c
/* include/vdso/time32.h */
struct old_timespec32 {
    old_time32_t tv_sec;   /* s32 */
    s32          tv_nsec;
};
```

`old_timespec32` aligns at 4 bytes rather than 8, matching the layout a 32-bit compiler would produce.
This is the fundamental reason 32-bit `clock_gettime()` cannot share the 64-bit handler.

## compat_ptr() and ptr_to_compat()

`compat_ptr()` converts a `compat_uptr_t` (u32) into a kernel `void __user *` by zero-extending:

```c
/* include/linux/compat.h */
static inline void __user *compat_ptr(compat_uptr_t uptr)
{
    return (void __user *)(unsigned long)uptr;
}
```

This is safe because a 32-bit process cannot have a valid address above 4 GB; the zero-extension just produces
the correct 64-bit representation of the 32-bit address.

The reverse direction uses `ptr_to_compat()`:

```c
static inline compat_uptr_t ptr_to_compat(void __user *uptr)
{
    return (u32)(unsigned long)uptr;
}
```

## in_compat_syscall()

Code that needs to behave differently for 32-bit callers (e.g., to pick the right struct size) uses
`in_compat_syscall()`. On x86, it isn't a single check but a three-level chain down to a per-syscall status
bit — not a thread flag. Some other architectures (ARM64, MIPS) use `TIF_32BIT` instead. The generic
declaration is in `include/linux/compat.h`; x86 overrides it in `arch/x86/include/asm/compat.h`:

```c
/* include/linux/compat.h — generic fallback */
static inline bool in_compat_syscall(void)
{
    return is_compat_task();  /* arch-specific */
}

/* arch/x86/include/asm/compat.h — x86 override */
static inline bool in_32bit_syscall(void)
{
    return in_ia32_syscall() || in_x32_syscall();
}

static inline bool in_compat_syscall(void)
{
    return in_32bit_syscall();
}
```

`in_ia32_syscall()` is a macro, not a function — it's defined two levels down in
`arch/x86/include/asm/thread_info.h`:

```c
/* arch/x86/include/asm/thread_info.h */
#define in_ia32_syscall() (IS_ENABLED(CONFIG_IA32_EMULATION) && \
                           current_thread_info()->status & TS_COMPAT)
```

`TS_COMPAT` is set when a task is executing in 32-bit compatibility mode. It is checked at various points in
the VFS and networking stack so that a single in-kernel code path can serve both 32-bit and 64-bit callers
where only minor differences exist.

## Struct layout differences: compat_iovec and compat_stat

### compat_iovec

```c
/* include/linux/compat.h */
struct compat_iovec {
    compat_uptr_t   iov_base;   /* u32 — 32-bit pointer */
    compat_size_t   iov_len;    /* u32 */
};

/* vs native: */
struct iovec {
    void __user    *iov_base;   /* 8 bytes on x86-64 */
    __kernel_size_t iov_len;    /* 8 bytes on x86-64 */
};
```

An `iovec` array passed by a 32-bit process has 8 bytes per element; the 64-bit layout has 16 bytes per
element. `readv()` and `writev()` must detect the compat case and iterate using `compat_iovec`.

### compat_stat

```c
/* arch/x86/include/asm/compat.h */
struct compat_stat {
    u32             st_dev;
    compat_ino_t    st_ino;     /* u32 */
    compat_mode_t   st_mode;    /* u16 on x86; u32 in the generic definition */
    compat_nlink_t  st_nlink;   /* u16 on x86; u32 in the generic definition */
    __compat_uid_t  st_uid;     /* u16 on x86; u32 in the generic definition */
    __compat_gid_t  st_gid;     /* u16 on x86; u32 in the generic definition */
    u32             st_rdev;
    u32             st_size;    /* only 32 bits! */
    u32             st_blksize;
    u32             st_blocks;
    u32             st_atime;   /* 32-bit time_t */
    u32             st_atime_nsec;
    u32             st_mtime;
    u32             st_mtime_nsec;
    u32             st_ctime;
    u32             st_ctime_nsec;
    u32             __unused4;
    u32             __unused5;
};
```

The native `struct stat` on x86-64 uses 64-bit `off_t` for `st_size` and 64-bit `time_t`. The kernel fills
in both forms depending on which handler was called.

## When compat is NOT needed

Modern struct-based syscalls designed with portability in mind use explicit-width types (`__u64`, `__u32`,
`__s64`) rather than `long` or pointer types in their UAPI structs. Because the struct layout is identical
between 32-bit and 64-bit, no compat handler is needed:

```c
/* include/uapi/linux/openat2.h — used by openat2() */
struct open_how {
    __u64   flags;
    __u64   mode;
    __u64   resolve;
};
```

A 32-bit process that passes `struct open_how` has the same binary layout as a 64-bit process. The single
`sys_openat2` handler works for both. This is the recommended pattern for any new syscall.

## compat_ioctl: driver-level compat

`ioctl()` is special because ioctl commands encode struct sizes, and many commands pass structs with
architecture-dependent layouts. Drivers implement both:

```c
/* include/linux/fs.h — file_operations */
struct file_operations {
    /* ... */
    long (*unlocked_ioctl)(struct file *, unsigned int, unsigned long);
    long (*compat_ioctl)(struct file *, unsigned int, unsigned long);
    /* ... */
};
```

When a 32-bit process calls `ioctl()`, the compat ioctl syscall first tries `do_vfs_ioctl()` for commands the
VFS itself understands generically (independent of the driver). If that returns `-ENOIOCTLCMD` (not one of
those), it falls through to the driver's `compat_ioctl`, if set. There is no generic, automatic
translation-table fallback for arbitrary driver-specific commands — if `compat_ioctl` is NULL, a 32-bit
caller gets `-ENOTTY` for anything the driver hasn't explicitly handled. For commands whose only argument is
either absent or already compatible between widths (pointers, not raw `unsigned long` values embedding a
pointer), a driver can opt in to the generic `compat_ptr_ioctl()` helper (`fs/ioctl.c`) instead of writing
its own — it just zero-extends `arg` through `compat_ptr()` and calls `unlocked_ioctl`.

```c
/* Example: driver that handles compat explicitly */
static long my_compat_ioctl(struct file *file, unsigned int cmd,
                             unsigned long arg)
{
    switch (cmd) {
    case MY_IOCTL_GET_INFO32: {
        struct my_info32 __user *uinfo = compat_ptr(arg);
        struct my_info32 kinfo;
        /* fill kinfo from kernel state */
        if (copy_to_user(uinfo, &kinfo, sizeof(kinfo)))
            return -EFAULT;
        return 0;
    }
    default:
        return my_ioctl(file, cmd, arg);
    }
}
```

## Practical example: compat_sys_read vs sys_read

`read()` only passes a 32-bit pointer and a 32-bit count. On x86-64, the kernel handles this transparently:
`ia32_sys_call()`'s `read` case dispatches straight to the native `sys_read` handler, because `compat_ptr()` of the
32-bit buffer address produces the correct 64-bit user pointer, and `compat_size_t` (u32) fits in `size_t`.
No separate compat handler is needed.

## Practical example: compat_sys_sendmsg vs sys_sendmsg

`sendmsg()` passes `struct msghdr __user *`, which contains an embedded `struct iovec __user *` and a
`void __user *` for the control message. Because both are pointers, they differ in size between 32-bit and
64-bit:

```c
/* net/compat.c */
static inline long __compat_sys_sendmsg(int fd, struct compat_msghdr __user *msg,
                                        unsigned int flags)
{
    return __sys_sendmsg(fd, (struct user_msghdr __user *)msg,
                         flags | MSG_CMSG_COMPAT, false);
}

COMPAT_SYSCALL_DEFINE3(sendmsg, int, fd, struct compat_msghdr __user *, msg,
                       unsigned int, flags)
{
    return __compat_sys_sendmsg(fd, msg, flags);
}
```

The `MSG_CMSG_COMPAT` flag, not a separate boolean, is what marks this as a compat call — it's OR'd in here.
The final argument to `__sys_sendmsg()` is `forbid_cmsg_compat`: when `true`, it rejects a caller that has
`MSG_CMSG_COMPAT` set (used by the *native* `sys_sendmsg` path, to reject a native caller spoofing that
flag); the compat path legitimately sets the flag itself, so it passes `false`. Downstream,
`sendmsg_copy_msghdr()` (`net/socket.c`) is what actually branches on `MSG_CMSG_COMPAT`: on the compat path
it calls `get_compat_msghdr()`, which reads `struct compat_msghdr` (containing `compat_uptr_t` fields) and
reconstructs a native `struct msghdr` in kernel space before proceeding; on the native path it calls
`copy_msghdr_from_user()` instead.

## Detecting 32-bit processes

```bash
# The ELF class shows 32-bit
file /proc/$(pidof myapp)/exe
# ELF 32-bit LSB executable ...

# Or check the CS segment register in the task's pt_regs
# CS == __USER32_CS (0x23) for ia32; CS == __USER_CS (0x33) for x86-64
```

Inside the kernel, `task_pt_regs(task)->cs` is compared to `__USER32_CS` to determine the execution mode of
a traced task.

## The old compat_alloc_user_space() pattern — removed in Linux 5.15

Older compat handlers used a different strategy from the shared-helper pattern above: build a native-layout
struct in a scratch region carved out below the user's own stack pointer, then call the *native* syscall
handler as if userspace itself had passed that struct. `compat_alloc_user_space()` was the function that
carved out that scratch region — it aligned the result to 16 bytes, checked it stayed within the caller's
address range, and validated it with `access_ok()` before handing it back.

That function, and the pattern it enabled, is gone. Arnd Bergmann's series eliminating `set_fs()`-based
address-space overrides removed the last callers, and `compat_alloc_user_space()` itself in
[commit a7a08b275a8b](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=a7a08b275a8bbade798c4bdaad07ade68fe7003c)
("arch: remove compat_alloc_user_space") — first absent starting in **Linux 5.15** (October 2021).

The replacement isn't a new function; it's the shared-kernel-space-helper pattern this page already showed
for `sendmsg()`: a common `__sys_*()` function that takes already-copied-in kernel data and is called
directly from both the native and compat entry points, with any compat-specific translation (pointer width,
`MSG_CMSG_COMPAT`, etc.) done in kernel space along the way — never by faking a struct on the user's own
stack and re-entering as if userspace had built it. `compat_sys_socketcall()` (`net/compat.c`) — the very
function this section used to cite as a `compat_alloc_user_space()` user — is a good example of the
*before* and *after* in one place: it's still a genuinely separate compat handler (a 32-bit process packs
its socketcall argument array as `u32`s, not native `unsigned long`s, so it can't just reuse the native
parser), but it now `copy_from_user()`s that array into kernel space and dispatches straight to the same
internal helpers the native path uses (`__sys_bind()`, `__sys_connect()`, ...), translating pointer-sized
arguments with `compat_ptr()` along the way — no user-stack scratch space involved.

## Summary: when to write a compat handler

| Situation | Action |
|-----------|--------|
| Syscall args are `int`, `unsigned int`, fixed-size types | Share native handler |
| Args contain `long`, `size_t`, `off_t`, or pointers | Write `COMPAT_SYSCALL_DEFINE` handler |
| Struct passed by pointer uses explicit `__u64`/`__u32` | Share native handler (no compat needed) |
| Struct has embedded pointer or `time_t` | Write compat struct + compat handler |
| Driver `ioctl` with pointer args | Implement `compat_ioctl` in `file_operations` |

## Further reading

### Kernel source

- [include/linux/compat.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/compat.h) — `COMPAT_SYSCALL_DEFINEx()` macros, `compat_ptr()`/`ptr_to_compat()`, `struct compat_iovec`
- [include/asm-generic/compat.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/asm-generic/compat.h) — the base `compat_uptr_t`, `compat_size_t`, `compat_long_t`, `compat_s64`/`compat_u64` typedefs (pulled in by each arch's `asm/compat.h`)
- [arch/x86/include/asm/compat.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/compat.h) — `struct compat_stat` and the x86 override of `in_compat_syscall()`/`in_32bit_syscall()`
- [arch/x86/include/asm/thread_info.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/thread_info.h) — the `in_ia32_syscall()` macro and the `TS_COMPAT` flag it checks
- [include/vdso/time32.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/vdso/time32.h) — `struct old_timespec32`, the real 32-bit-layout timespec
- [arch/x86/include/asm/syscall_wrapper.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/syscall_wrapper.h) — `__IA32_COMPAT_SYS_STUBx()`: generates the `__ia32_compat_sys_xxx` entry stub
- [arch/x86/entry/syscalls/syscall_32.tbl](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/entry/syscalls/syscall_32.tbl) — the ia32 syscall table, including its compat-entry-point column
- [include/uapi/linux/openat2.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/openat2.h) — `struct open_how`: an explicit-width UAPI struct that needs no compat handler
- [net/compat.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/net/compat.c) — `compat_sys_sendmsg`/`compat_sys_recvmsg`, `compat_sys_socketcall()`, and `get_compat_msghdr()`
- [include/linux/fs.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/fs.h) — `struct file_operations`, including the `compat_ioctl` member
- [fs/ioctl.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/ioctl.c) — `compat_ptr_ioctl()` and the compat `ioctl()` syscall's dispatch logic
- [commit a7a08b275a8b](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=a7a08b275a8bbade798c4bdaad07ade68fe7003c) — "arch: remove compat_alloc_user_space", Arnd Bergmann, first in Linux 5.15

### Related pages

- [SYSCALL_DEFINE and Dispatch](syscall-define.md) — How native syscalls are defined and dispatched
- [Syscall Entry Path](syscall-entry.md) — `do_syscall_64()`'s dispatch and the `do_syscall_x32()` x32 path; ia32 compat dispatches through its own separate entry point (`ia32_sys_call()`) rather than through either of these
- [Adding a New Syscall](adding-syscall.md) — Includes the checklist for deciding whether a new syscall needs a compat handler

### LWN articles

- [LWN: System calls and 64-bit architectures](https://lwn.net/Articles/311630/) — Jake Edge, December 2008; the `preadv()`/`pwritev()` design debate that illustrates why some syscalls need a `compat_sys_*` handler and others don't

### External

- [Adding System Calls — The Linux Kernel documentation](https://docs.kernel.org/process/adding-syscalls.html) — Rendered version of `Documentation/process/adding-syscalls.rst`; see "Compatibility System Calls (Generic)" for when a compat handler is required
