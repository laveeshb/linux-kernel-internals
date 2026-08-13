# Syscall War Stories

> Real bugs, ABI breaks, and lessons from the syscall interface

These incidents are drawn from real Linux kernel development history. Each one illustrates a constraint or
hazard that is not obvious until you hit it in production.

## The time_t overflow (Y2038)

### Background

The original `stat()` syscall (and `time()`, `select()`, `utime()`, and many others) stored timestamps as
`time_t`, which on 32-bit architectures is a signed 32-bit integer. A 32-bit `time_t` overflows on
**January 19, 2038 at 03:14:07 UTC**. At that moment, the value wraps to a large negative number,
representing a time in 1901.

### What the kernel did

Adding `stat64()` and `lstat64()` helped 32-bit architectures get 64-bit file sizes, but the time fields
in `struct stat64` on 32-bit Linux still used 32-bit `time_t`. The real fix required new syscalls with
genuinely 64-bit timestamps throughout.

Linux 4.11 (2017) added `statx()` (`fs/stat.c`, commit [`a528d35e8bfc`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=a528d35e8bfcc521d7cb70aaf03e1bd296c8493f)), which uses `__kernel_timespec`
with a 64-bit `tv_sec`:

```c
/* include/uapi/linux/stat.h */
struct statx_timestamp {
    __s64   tv_sec;    /* always 64-bit */
    __u32   tv_nsec;
    __s32   __reserved;
};

struct statx {
    /* ... */
    struct statx_timestamp  stx_atime;
    struct statx_timestamp  stx_btime;
    struct statx_timestamp  stx_ctime;
    struct statx_timestamp  stx_mtime;
    /* ... */
};
```

But `statx()` alone was not enough. Any 32-bit architecture (ARM, MIPS, x86 with `CONFIG_IA32_EMULATION`)
that called `clock_gettime()`, `select()`, `ppoll()`, `nanosleep()`, or `pselect6()` still passed 32-bit
`struct timespec` fields, which overflow in 2038.

Linux 5.1 added a family of `_time64` variants for 32-bit architectures:
`clock_gettime64`, `clock_settime64`, `clock_adjtime64`, `clock_getres_time64`, `pselect6_time64`,
`ppoll_time64`, `io_pgetevents_time64`, `utimensat_time64`, and several more — over 20 new syscalls just
to fix the time type.

### The lesson

ABI decisions made in the 1970s (when `time_t` was sized for the hardware of the day) propagated for
50 years. The fix required a coordinated effort across glibc, musl, the kernel, and every toolchain
targeting 32-bit Linux. The syscall ABI is effectively permanent — there is no mechanism to change a
struct field's width once it is in a shipped kernel. New syscalls are the only recourse.

If you define a new syscall today with a 32-bit timestamp or a 32-bit offset, you are writing the next
Y2038.

---

## The futex ABI hash collision

### Background

`futex()` was added in Linux 2.5.7 as a fast user-space mutex. The kernel uses the futex's address as a
hash key to find waiters: `futex_wait(addr, val)` adds the current task to a wait queue keyed on `addr`.
`futex_wake(addr, n)` finds waiters on `addr` and wakes them.

### The bug

The early implementation keyed on the **virtual** address. Two processes that shared a memory-mapped region
(via `mmap(MAP_SHARED)` or a shared anonymous mapping) could both call `futex_wait()` on what was the same
physical memory location, but with different virtual addresses. The hash lookup used the virtual address, so
the waiter and the waker were in different wait queues — the wake had no effect, and the waiter slept
forever.

### The fix

The fix was to key futexes on the **physical address** of the page, combined with the page offset. The
kernel now computes a `struct futex_key`:

```c
/* kernel/futex/core.c */
union futex_key {
    struct {
        u64     i_seq;      /* inode sequence number (for file-backed) */
        unsigned long pgoff;
        unsigned int  bitset;
    } shared;
    struct {
        union {
            struct mm_struct *mm;
            u64 __tmp;
        };
        unsigned long address;
        unsigned int  bitset;
    } private;
    struct {
        u64     ptr;        /* physical address bits */
        unsigned long word;
        unsigned int  bitset;
    } both;
};
```

For shared mappings, `get_futex_key()` calls `get_user_pages()` to pin the page, then uses the page's
physical address (via `page_to_pfn()`) as the hash key. Private mappings (anonymous, `MAP_PRIVATE`) still
use the virtual address plus the `mm_struct` pointer, which uniquely identifies the mapping within a
process.

### The lesson

The syscall ABI looked correct: `futex(addr, FUTEX_WAIT, val, timeout)` is a reasonable interface. The
bug was in the implementation's semantics — the kernel's notion of "same futex" did not match the user's
notion of "same location in shared memory." Fixing it without changing the syscall number was possible
because the fix was purely internal. But had the wrong behavior been in the specification rather than the
implementation, a new syscall would have been required.

Shared-memory IPC semantics — especially anything involving equality of addresses or object identity
across process boundaries — must be defined in terms of physical or file identity, not virtual addresses.

---

## The clone vs fork CLONE_FILES fd sharing

### Background

`clone(CLONE_FILES)` creates a new task that shares the parent's file descriptor table. Both tasks see the
same `struct files_struct`, so an `open()` in one is immediately visible as an `fd` in the other. This is
how `pthread_create()` works: threads share file descriptors.

### The hazard

A program created a thread via `clone(CLONE_FILES | CLONE_VM | CLONE_THREAD | SIGCHLD)` and used the
following pattern:

```c
/* Thread: opens a file and returns the fd to the parent via a pipe */
int fd = open("/some/file", O_RDONLY);
write(notify_pipe[1], &fd, sizeof(fd));

/* Parent: reads the fd and closes it when done */
int fd;
read(notify_pipe[0], &fd, sizeof(fd));
/* ... use fd ... */
close(fd);
```

This worked reliably. Then `O_CLOEXEC` became widespread. The thread started opening files with
`O_CLOEXEC` for safety. The problem: `O_CLOEXEC` is set per-file-description (in `struct file`), not
per-descriptor. When the parent process called `execve()` — for a completely different reason, in a
different thread — the kernel closed all `O_CLOEXEC` file descriptors in the shared table. The fd the
parent was about to use was silently closed.

A further subtle issue: `dup2(oldfd, newfd)` across threads sharing `CLONE_FILES` is not atomic. The
kernel must hold `files->file_lock` during the operation, but if another thread calls `close(newfd)` between
the validity check and the installation, the behavior is undefined. The `POSIX_SPAWN_FILE_ACTIONS_ADDDUP2`
interface was specifically designed to avoid this by serializing at a higher level.

### The lesson

`CLONE_FILES` threads must treat all fd operations as shared-memory operations: any close, dup, or
`execve` in any thread immediately affects all threads. Using `O_CLOEXEC` on fds you intend to share
across a `CLONE_FILES` boundary with a subsequent `execve` is a logic error. The correct pattern is to
not share the fd table (`CLONE_FILES` without `CLONE_THREAD`) when fd lifecycle is managed across threads.

---

## The EINTR surprise

### Background

`poll()`, `select()`, `read()`, and most blocking syscalls return `-1` with `errno == EINTR` when
interrupted by a signal. This is documented, well-known, and still causes production bugs regularly.

### The incident

A long-running daemon used `poll()` with a multi-minute timeout to wait for network events. It installed
a `SIGTERM` handler to initiate graceful shutdown:

```c
void sigterm_handler(int sig)
{
    shutdown_requested = 1;
}

int main(void)
{
    struct sigaction sa = { .sa_handler = sigterm_handler };
    sigaction(SIGTERM, &sa, NULL);

    while (!shutdown_requested) {
        int ret = poll(fds, nfds, TIMEOUT_MS);
        if (ret < 0) {
            perror("poll");  /* logs "Interrupted system call" and exits */
            exit(1);
        }
        /* handle events */
    }
}
```

When `SIGTERM` arrived during `poll()`, the handler ran, set `shutdown_requested = 1`, and returned.
`poll()` then returned `-1` with `errno == EINTR`. The daemon treated any negative return from `poll()` as
fatal and called `exit(1)` — bypassing the graceful shutdown it had carefully implemented.

### The fix and the subtlety

The obvious fix is to check for `EINTR` and retry:

```c
do {
    ret = poll(fds, nfds, TIMEOUT_MS);
} while (ret < 0 && errno == EINTR && !shutdown_requested);
```

The less obvious fix is `SA_RESTART`:

```c
struct sigaction sa = {
    .sa_handler = sigterm_handler,
    .sa_flags   = SA_RESTART,
};
```

With `SA_RESTART`, the kernel automatically restarts certain slow syscalls after the signal handler
returns, without returning `EINTR`. The interaction with `poll()` is subtler than it appears:

Since Linux 2.6.24, `poll()` returns `ERESTART_RESTARTBLOCK` when interrupted by a signal (not
`ERESTARTSYS`). The `ERESTART_RESTARTBLOCK` mechanism causes the kernel to restart the syscall via
`restart_syscall()`, adjusting the timeout to reflect elapsed time. This is transparent to userspace —
`poll()` does not return `EINTR` to the process; it restarts automatically. `SA_RESTART` does not control
this path (it only controls `ERESTARTSYS`), but the net effect is the same: `poll()` is restarted.

The syscalls that genuinely always return `EINTR` are those that use `ERESTARTNOHAND` (like `epoll_wait()`)
— these return `EINTR` when any signal handler runs, even with `SA_RESTART`. In the incident above, the
EINTR issue would arise from `epoll_wait()` or a pre-2.6.24 kernel's `poll()`, not modern `poll()`.

Syscalls that **are** restarted by `SA_RESTART`: `read()`, `write()`, `wait()`, `ioctl()` (device),
`flock()`.

Syscalls that use `ERESTART_RESTARTBLOCK` (restart via `restart_syscall()`, not controlled by
`SA_RESTART`): `poll()`, `select()`, `nanosleep()`.

Syscalls that are **not** restarted even with `SA_RESTART`: `epoll_wait()` and others using
`ERESTARTNOHAND`, which always return `EINTR` when any signal handler runs.

The correct production pattern for daemons: use `signalfd()` or `pselect()`/`ppoll()` with a signal mask.
`ppoll()` and `pselect6()` atomically install a signal mask and then wait, closing the race window between
unblocking the signal and entering the wait.

---

## The syscall number collision on a new architecture

### Background

RISC-V was officially merged into the Linux kernel in version 4.15 (2018). It uses the generic syscall
table from `include/uapi/asm-generic/unistd.h` rather than a hand-maintained architecture-specific table.
Syscall numbers are assigned sequentially as new syscalls are merged upstream.

### The incident

A semiconductor vendor shipped a downstream kernel for a RISC-V SoC that needed a custom interface to
control proprietary hardware accelerator firmware. Rather than use an `ioctl()` or `netlink` interface,
an engineer added a new out-of-tree syscall in the downstream tree:

```c
/* vendor/downstream kernel: kernel/vendor_accel.c */
/* Added at number 451 — the next available number at the time of the fork */
SYSCALL_DEFINE3(vendor_accel_submit, ...)
```

Downstream userspace tools and the accelerator SDK hard-coded `#define __NR_vendor_accel_submit 451` and
were shipped in firmware images to end customers.

Linux 5.16 (released upstream in January 2022) added `futex_waitv()` at syscall number 449, and subsequent
releases assigned 450 and 451 to `set_mempolicy_home_node` (5.17) and `cachestat` (6.5) respectively.
Customers who attempted to run the vendor's userspace tools on an upstream or distribution kernel got
incorrect behavior: calling syscall 451 invoked a completely different kernel function.

Because the vendor's downstream branched before `futex_waitv` was merged, their numbering was offset from
upstream. The collision was not detectable until customers started mixing vendor-provided userspace with
upstream kernels.

### The lesson

Out-of-tree syscall numbers in production are a time bomb. The kernel's syscall number space is a global
namespace managed by the upstream `MAINTAINERS` process. Assigning a number in a downstream tree with the
intent to merge later creates a collision risk that grows with every kernel release cycle.

The correct path for vendor-specific interfaces:
1. Use `ioctl()` on a character device — ioctl command numbers are per-device and don't collide globally.
2. Use `netlink` (for networking and system configuration) or `sysfs` (for device attributes).
3. If a genuine new syscall is needed, submit it upstream and wait for an assigned number before shipping
   userspace that hard-codes the number.

The `seccomp-notify` mechanism (see [ptrace and Syscall Interception](ptrace-interception.md)) is also an
option for implementing custom syscall-like interfaces in a privileged supervisor without any kernel
modification.

---

## Further reading

- [SYSCALL_DEFINE and Dispatch](syscall-define.md) — ABI stability guarantees and struct-based syscalls
- [32-bit Compat Syscalls](compat.md) — How Y2038 affected the compat syscall tables
- [Syscall Restart Mechanisms](restart-block.md) — ERESTARTSYS, ERESTART_RESTARTBLOCK, and restart_syscall() in full, the mechanism behind the EINTR story above
- [Signals](../ipc/signals.md) — signal delivery, `sigaction`, and `SA_RESTART` semantics behind the EINTR story above
- [Futex Internals](../locking/futex.md) — how futex_wait()/futex_wake() and futex key hashing work today
- [ptrace and Syscall Interception](ptrace-interception.md) — seccomp-notify as an alternative to custom syscalls
- [Adding a New Syscall](adding-syscall.md) — The right way to add a syscall and avoid the pitfalls above
- `kernel/futex/core.c` — futex_key and physical address hashing

## External references

- [git.kernel.org: a528d35e8bfc](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=a528d35e8bfcc521d7cb70aaf03e1bd296c8493f) — "statx: Add a system call to make enhanced file info available," David Howells, merged for Linux 4.11 (fs/stat.c)
- [git.kernel.org: 3075d9da0b4c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=3075d9da0b4ccc88959db30de80ebd11d2dde175) — "Use ERESTART_RESTARTBLOCK if poll() is interrupted by a signal," the fs/select.c change (merged for Linux 2.6.24) behind the EINTR story's central claim about `poll()`
- [Kernel documentation: ktime accessors](https://docs.kernel.org/core-api/timekeeping.html) — "Deprecated time interfaces" section: "all interfaces returning a 'struct timeval' or 'struct timespec' have been replaced because the tv_sec member overflows in year 2038 on 32-bit architectures"
- [Kernel documentation: Adding a New System Call](https://docs.kernel.org/process/adding-syscalls.html) — upstream guidance on syscall numbering ("these numbers are liable to be changed if there are conflicts in the relevant merge window") and on preferring ioctl/sysfs/other interfaces over new syscalls
