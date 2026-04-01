# ptrace and Syscall Interception

> How strace, debuggers, and seccomp-notify intercept syscalls

## ptrace overview

`ptrace(2)` is the kernel mechanism that powers debuggers (`gdb`), tracers (`strace`), and system call
supervisors. It lets one process (the tracer) inspect and modify the register state and memory of another
(the tracee), and pause the tracee at specific events.

Two ways to attach:

```c
/* Tracee opts in — used by a process that forks a child to debug */
ptrace(PTRACE_TRACEME, 0, NULL, NULL);

/* Tracer attaches to an existing process (sends SIGSTOP) */
ptrace(PTRACE_ATTACH, target_pid, NULL, NULL);
/* Modern equivalent (doesn't require SIGSTOP to stabilize) */
ptrace(PTRACE_SEIZE, target_pid, NULL, 0);
```

After attachment, the tracee enters a **ptrace-stop** when it hits a watched event (syscall, signal, exec,
fork, clone). In ptrace-stop, the tracee is paused and the tracer can call `waitpid()` to collect the stop
reason, then inspect or modify state before resuming.

## PTRACE_SYSCALL: how strace works

```c
/* Resume the tracee, but stop again at the next syscall entry or exit */
ptrace(PTRACE_SYSCALL, pid, NULL, NULL);
```

This causes the kernel to stop the tracee **twice per syscall**: once on entry (before the syscall executes)
and once on exit (after the kernel sets the return value). `strace` uses this to log every syscall:

```
waitpid(pid, &status)     /* wait for entry-stop */
ptrace(PTRACE_GETREGS, pid, NULL, &regs)
/* regs.orig_rax = syscall number, regs.rdi/rsi/rdx = args */
ptrace(PTRACE_SYSCALL, pid, NULL, NULL)  /* resume to exit-stop */

waitpid(pid, &status)     /* wait for exit-stop */
ptrace(PTRACE_GETREGS, pid, NULL, &regs)
/* regs.rax = return value */
ptrace(PTRACE_SYSCALL, pid, NULL, NULL)  /* resume to next entry-stop */
```

Because `strace` calls `waitpid()` twice per syscall, tracing doubles the number of context switches and is
costly. A traced process can be 100x slower on syscall-heavy workloads.

## Syscall-stops: entry and exit

The kernel notifies ptrace of syscall boundaries via two functions in `kernel/ptrace.c`:

- `ptrace_report_syscall_entry()` — called from `syscall_enter_from_user_mode_work()` before the syscall handler runs
- `ptrace_report_syscall_exit()` — called from `syscall_exit_to_user_mode_work()` after the return value is set

Both functions call `ptrace_notify()`, which sets the tracee's stop code to `(SIGTRAP | 0x80)` (the high bit
distinguishes a syscall-stop from a plain signal-stop) and sends `SIGCHLD` to the tracer.

## Reading and modifying syscall args

At entry-stop, the syscall arguments are in `pt_regs`:

```c
struct user_regs_struct regs;
ptrace(PTRACE_GETREGS, pid, NULL, &regs);

/* Syscall number */
long syscall_nr = regs.orig_rax;

/* Arguments (x86-64 calling convention for syscalls) */
unsigned long arg1 = regs.rdi;
unsigned long arg2 = regs.rsi;
unsigned long arg3 = regs.rdx;
unsigned long arg4 = regs.r10;
unsigned long arg5 = regs.r8;
unsigned long arg6 = regs.r9;
```

To change the syscall number (e.g., to replace `unlink` with a no-op):

```c
regs.orig_rax = __NR_getpid;   /* substitute a harmless syscall */
ptrace(PTRACE_SETREGS, pid, NULL, &regs);
```

To cancel the syscall entirely, set `orig_rax` to `-1`. The kernel's `do_syscall_x64()` will call
`__x64_sys_ni_syscall()` which returns `-ENOSYS`.

## TIF_SYSCALL_TRACE

The flag that triggers ptrace syscall-stops is `TIF_SYSCALL_TRACE` in the task's `thread_info.flags`. It is
set by `ptrace_attach()` and cleared when the tracer detaches. The kernel checks this flag in
`syscall_enter_from_user_mode()` and `syscall_exit_to_user_mode()`:

```c
/* kernel/entry/common.c */
static long syscall_trace_enter(struct pt_regs *regs, long syscall,
                                 unsigned long work)
{
    if (work & SYSCALL_WORK_SYSCALL_TRACE)
        ptrace_report_syscall_entry(regs);
    /* ... seccomp check, audit ... */
    return syscall;
}
```

The same work-flags mechanism also carries `SYSCALL_WORK_SECCOMP` (for seccomp filtering) and
`SYSCALL_WORK_SYSCALL_AUDIT` (for the audit subsystem), so all three can coexist.

## PTRACE_GET_SYSCALL_INFO (Linux 5.3)

Before Linux 5.3, tracers had to call `PTRACE_GETREGS` and infer the stop type from the waitpid status.
Linux 5.3 added `PTRACE_GET_SYSCALL_INFO` (commit `201766a20e30`), which returns a structured description:

```c
/* include/uapi/linux/ptrace.h */
struct ptrace_syscall_info {
    __u8    op;          /* PTRACE_SYSCALL_INFO_ENTRY/EXIT/SECCOMP/NONE */
    __u8    pad[3];
    __u32   arch;        /* AUDIT_ARCH_X86_64 etc. */
    __u64   instruction_pointer;
    __u64   stack_pointer;
    union {
        struct {
            __u64   nr;           /* syscall number */
            __u64   args[6];      /* arguments */
        } entry;
        struct {
            __s64   rval;         /* return value */
            __u8    is_error;
        } exit;
        struct {
            __u64   nr;
            __u64   args[6];
            __u32   ret_data;     /* seccomp filter return data */
        } seccomp;
    };
};

/* Usage */
struct ptrace_syscall_info info;
ptrace(PTRACE_GET_SYSCALL_INFO, pid, sizeof(info), &info);
if (info.op == PTRACE_SYSCALL_INFO_ENTRY) {
    printf("syscall %llu, arg0=%llu\n", info.entry.nr, info.entry.args[0]);
}
```

This is the interface used by modern `strace` (4.26+) instead of `PTRACE_GETREGS`.

## ptrace events: PTRACE_O_TRACEFORK and friends

The tracer can request events beyond syscall-stops by setting ptrace options:

```c
ptrace(PTRACE_SETOPTIONS, pid, 0,
       PTRACE_O_TRACEFORK   |  /* stop on fork() */
       PTRACE_O_TRACEVFORK  |  /* stop on vfork() */
       PTRACE_O_TRACECLONE  |  /* stop on clone() */
       PTRACE_O_TRACEEXEC   |  /* stop after execve() */
       PTRACE_O_TRACEEXIT   |  /* stop before process exit */
       PTRACE_O_TRACESECCOMP); /* stop on SECCOMP_RET_TRACE */
```

When one of these events fires, `waitpid()` returns a status where
`(status >> 8) == (SIGTRAP | (PTRACE_EVENT_xxx << 8))`. For example, a fork event returns
`PTRACE_EVENT_FORK`. The tracer can then call `ptrace(PTRACE_GETEVENTMSG, pid, NULL, &msg)` to retrieve
the new child's PID.

## seccomp-notify: a modern alternative to ptrace

`SECCOMP_RET_USER_NOTIF` (added in Linux 5.0, `include/uapi/linux/seccomp.h`) lets a privileged supervisor
intercept syscalls without the overhead of ptrace. Instead of stopping the tracee and waking the tracer, the
kernel sends a notification to a file descriptor, and the tracee sleeps until the supervisor replies.

### Installing the filter

```c
/* In the process to be supervised (or before exec) */
int notif_fd = seccomp(SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER,
                       &prog);
/* notif_fd is a new file descriptor — pass it to the supervisor via SCM_RIGHTS */
```

The BPF program returns `SECCOMP_RET_USER_NOTIF` for syscalls to intercept and `SECCOMP_RET_ALLOW` for
everything else.

### Receiving and responding to notifications

```c
/* include/uapi/linux/seccomp.h */
struct seccomp_notif {
    __u64   id;         /* unique notification ID */
    __u32   pid;        /* PID of the triggering task */
    __u32   flags;
    struct seccomp_data data;  /* syscall number + args + arch */
};

struct seccomp_notif_resp {
    __u64   id;         /* must match the request */
    __s64   val;        /* return value to inject */
    __s32   error;      /* errno to inject (0 = use val) */
    __u32   flags;      /* SECCOMP_USER_NOTIF_FLAG_CONTINUE */
};

/* Supervisor loop */
struct seccomp_notif req;
struct seccomp_notif_resp resp = {};

ioctl(notif_fd, SECCOMP_IOCTL_NOTIF_RECV, &req);   /* blocks */
/* Inspect req.data.nr (syscall nr) and req.data.args[] */

resp.id    = req.id;
resp.error = 0;
resp.val   = 42;   /* inject return value */
ioctl(notif_fd, SECCOMP_IOCTL_NOTIF_SEND, &resp);
```

The suspended task in the supervised process wakes up and sees `42` as the syscall return value. This
avoids the two context switches per syscall that ptrace requires.

Container managers such as `bubblewrap` and `systemd`'s `RootDirectory=` sandboxing use seccomp-notify to
implement syscall emulation (e.g., faking `mount()` for unprivileged containers).

### SECCOMP_USER_NOTIF_FLAG_CONTINUE

If the supervisor sets `SECCOMP_USER_NOTIF_FLAG_CONTINUE` in `resp.flags`, the kernel executes the syscall
normally instead of injecting a return value. This is used when the supervisor just wants to log the call
without blocking it.

## perf syscall tracing

```bash
# Raw syscall tracepoints (all syscalls, entry only)
perf record -e raw_syscalls:sys_enter -- my_program

# Fine-grained: only openat() entry
perf record -e syscalls:sys_enter_openat -- my_program

# Count syscalls during an ls
perf stat -e 'syscalls:sys_enter_*' -- ls 2>&1 | head -20
```

`raw_syscalls:sys_enter` fires on every syscall and provides the number and first argument. The
`syscalls:sys_enter_<name>` tracepoints fire only for the named syscall and decode all arguments
symbolically. Both are standard ftrace tracepoints, defined by the `SYSCALL_METADATA` macro that
`SYSCALL_DEFINE` emits.

## eBPF tracepoints for syscalls

BPF programs can attach to syscall tracepoints using libbpf:

```c
/* BPF program — attach to openat() entry */
SEC("tracepoint/syscalls/sys_enter_openat")
int trace_openat_entry(struct trace_event_raw_sys_enter *ctx)
{
    /* ctx->args[0] = dirfd, ctx->args[1] = filename ptr,
       ctx->args[2] = flags, ctx->args[3] = mode */
    char fname[256];
    bpf_probe_read_user_str(fname, sizeof(fname), (void *)ctx->args[1]);
    bpf_printk("openat: %s\n", fname);
    return 0;
}
```

The struct `trace_event_raw_sys_enter` is generated by BTF from the tracepoint format file at
`/sys/kernel/tracing/events/syscalls/sys_enter_openat/format`. The `args[]` array contains the raw
register values in argument order.

For syscall exit:

```c
SEC("tracepoint/syscalls/sys_exit_openat")
int trace_openat_exit(struct trace_event_raw_sys_exit *ctx)
{
    long ret = ctx->ret;   /* return value (negative = -errno) */
    if (ret < 0)
        bpf_printk("openat failed: %ld\n", ret);
    return 0;
}
```

## ftrace: tracing syscall handler functions

```bash
# Trace the sys_openat function via function tracer
echo sys_openat > /sys/kernel/tracing/set_ftrace_filter
echo function > /sys/kernel/tracing/current_tracer
echo 1 > /sys/kernel/tracing/tracing_on
cat /sys/kernel/tracing/trace_pipe
```

Note that the function tracer traces `__x64_sys_openat` (the pt_regs wrapper), not `do_sys_openat2()` (the
actual implementation). To trace the implementation, add it explicitly:

```bash
echo '__x64_sys_openat do_sys_openat2' > /sys/kernel/tracing/set_ftrace_filter
```

For syscall function graphs (showing the entire call tree under a syscall):

```bash
echo function_graph > /sys/kernel/tracing/current_tracer
echo __x64_sys_openat > /sys/kernel/tracing/set_graph_function
```

## Further reading

- [Syscall Entry Path](syscall-entry.md) — TIF_SYSCALL_TRACE and the entry fast/slow path
- [SYSCALL_DEFINE and Dispatch](syscall-define.md) — Tracepoints generated by SYSCALL_METADATA
- `kernel/ptrace.c` — ptrace_report_syscall_entry/exit
- `kernel/seccomp.c` — SECCOMP_RET_USER_NOTIF implementation
- `include/uapi/linux/ptrace.h` — ptrace_syscall_info struct
- `include/uapi/linux/seccomp.h` — seccomp_notif / seccomp_notif_resp
