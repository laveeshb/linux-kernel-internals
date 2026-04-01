# Syscall Restart Mechanisms

> How interrupted syscalls restart transparently — ERESTARTSYS, ERESTART_RESTARTBLOCK, and restart_syscall()

## The problem

A process calls `read()` on a slow device. The kernel blocks the task,
waiting for data. While it is blocked, a signal arrives: a `SIGCHLD` from a
child process, or a `SIGALRM` from a timer. The kernel wakes the task to
deliver the signal. But what should happen to the `read()`?

Three outcomes are possible:

1. Return `-EINTR` to userspace. The caller must retry manually if it wants to.
2. Restart the `read()` transparently, as if the signal had not interrupted it.
3. Restart the `read()` but with adjusted arguments — for example, a
   `nanosleep()` that should sleep for the *remaining* time rather than the
   original duration.

Which outcome occurs depends on which restart code the syscall returns, and on
whether the signal handler was installed with `SA_RESTART`.

## The four restart codes

These are special negative error values, all below `-MAX_ERRNO` (defined as
4096). Because they are outside the normal error range, they never reach
userspace — the signal delivery path intercepts them before `sysretq`.

```c
/* include/linux/errno.h */
#define ERESTARTSYS          512
#define ERESTARTNOINTR       513
#define ERESTARTNOHAND       514
#define ERESTART_RESTARTBLOCK 516
```

As negative values in `regs->ax` after a syscall returns:

| Code | Value | Meaning |
|------|-------|---------|
| `ERESTARTSYS` | -512 | Restart if `SA_RESTART` is set on the signal handler; return `-EINTR` otherwise |
| `ERESTARTNOINTR` | -513 | Always restart, regardless of `SA_RESTART`; transparent to userspace |
| `ERESTARTNOHAND` | -514 | Return `-EINTR` if a handler ran; restart only if no handler is installed |
| `ERESTART_RESTARTBLOCK` | -516 | Restart via `restart_syscall()` — for syscalls that must adjust arguments |

`EINTR` (-4) is not a restart code. It is the ordinary error returned to
userspace when the kernel has decided the syscall should not restart.

## How the signal path uses restart codes

After a signal handler returns, the architecture signal code calls
`arch_do_signal_or_restart()` (x86: `arch/x86/kernel/signal.c`). It inspects
`regs->ax` to determine what to do:

```c
/* arch/x86/kernel/signal.c — simplified */
static void handle_signal(struct ksignal *ksig, struct pt_regs *regs)
{
    /* ... set up signal frame on userstack ... */

    /*
     * If the syscall was interrupted, decide whether to restart:
     * regs->orig_ax holds the syscall number; regs->ax holds the
     * interrupted syscall's return value (one of the ERESTART* codes).
     */
    if (regs->orig_ax != -1) {
        switch ((int)regs->ax) {
        case -ERESTART_RESTARTBLOCK:
        case -ERESTARTNOHAND:
            regs->ax = -EINTR;
            break;
        case -ERESTARTSYS:
            if (!(ksig->ka.sa.sa_flags & SA_RESTART)) {
                regs->ax = -EINTR;
                break;
            }
            fallthrough;
        case -ERESTARTNOINTR:
            /* Restart: rewind rip to re-execute the syscall instruction */
            regs->ax  = regs->orig_ax;
            regs->ip -= 2;   /* back up over the two-byte syscall instruction */
            break;
        }
    }
}
```

For `ERESTART_RESTARTBLOCK`, the signal path does something different: instead
of rewinding `rip` to re-execute the original syscall, it rewrites `regs->ax`
to `__NR_restart_syscall` and rewinds `rip`. This causes the CPU to execute
`restart_syscall()` when it returns to userspace, not the original syscall.

```c
/* arch/x86/kernel/signal.c */
case -ERESTART_RESTARTBLOCK:
    regs->ax  = __NR_restart_syscall;
    regs->ip -= 2;
    break;
```

## struct restart_block

`struct restart_block` is embedded directly in `struct task_struct`
(`include/linux/sched.h`). It stores the restart function and all arguments
needed to resume the syscall:

```c
/* include/linux/sched.h */
struct restart_block {
    u32  arch_data;   /* arch-specific flags, e.g., x86 TS_COMPAT */
    long (*fn)(struct restart_block *);

    union {
        /* select/pselect */
        struct {
            __kernel_fd_set __user *inp, *outp, *exp;
            struct __kernel_timespec __user *tvp;
            u32 tv_sec32, tv_nsec32;
            unsigned long fd_array[2];
        } select;

        /* futex_wait / futex_wait_bitset */
        struct {
            u32 __user *uaddr;
            u32 val, flags;
            u32 bitset;
            u64 time;
            u32 __user *uaddr2;
        } futex;

        /* nanosleep / clock_nanosleep */
        struct {
            clockid_t clockid;
            struct __kernel_timespec __user *rmtp;
            u64 expires;
        } nanosleep;

        /* poll / ppoll */
        struct {
            struct pollfd __user *ufds;
            int nfds;
            int has_timeout;
            unsigned long tv_sec, tv_nsec;
        } poll;
    };
};
```

There is one `restart_block` per task, reused across interrupted syscalls.
Before returning `ERESTART_RESTARTBLOCK`, the syscall fills in `fn` and the
appropriate union member with the adjusted arguments.

## restart_syscall(): the re-entry point

`restart_syscall()` is a real syscall — syscall number `__NR_restart_syscall`
(219 on x86-64). It has no arguments; it reads everything it needs from
`current->restart_block`:

```c
/* kernel/signal.c */
SYSCALL_DEFINE0(restart_syscall)
{
    struct restart_block *restart = &current->restart_block;
    return restart->fn(restart);
}
```

The `fn` pointer is set by the interrupted syscall before it returns
`ERESTART_RESTARTBLOCK`. When `restart_syscall()` fires, it calls that function
with the pre-filled `restart_block`, which contains already-adjusted arguments
(such as the remaining sleep time).

Userspace never sees `__NR_restart_syscall` in normal operation. It appears in
`strace` output as `restart_syscall()` when a `nanosleep`, `poll`, `select`, or
`futex_wait` is restarted after signal delivery.

## nanosleep() restart: a complete walkthrough

```
1.  Userspace calls nanosleep({.tv_sec=5, .tv_nsec=0}, &rem)
    → kernel: sys_nanosleep()
    → hrtimer started, task sleeps

2.  3 seconds later: signal arrives, task woken up

3.  sys_nanosleep() calculates remaining time: 2 seconds

4.  Fills in restart_block:
        current->restart_block.fn              = nanosleep_restart;
        current->restart_block.nanosleep.clockid = CLOCK_REALTIME;
        current->restart_block.nanosleep.rmtp    = &rem (userspace pointer);
        current->restart_block.nanosleep.expires = now + 2_seconds_in_ns;

5.  Returns -ERESTART_RESTARTBLOCK

6.  Signal path:
        - Delivers the signal to the handler
        - Sees -ERESTART_RESTARTBLOCK in regs->ax
        - Rewrites regs->ax = __NR_restart_syscall (219)
        - Rewinds rip by 2 bytes

7.  Handler returns; CPU re-executes syscall instruction with rax=219

8.  Kernel dispatches restart_syscall()
    → current->restart_block.fn(&current->restart_block)
    → nanosleep_restart()
    → starts a new hrtimer for the remaining 2 seconds
    → task sleeps again

9.  If no further signals: nanosleep_restart() returns 0 to userspace.
    If another signal arrives: the whole cycle repeats with the new
    remaining time.
```

The userspace process sees the original `nanosleep()` call eventually return
0 — it is unaware of the restart. The `rem` pointer is updated with the time
remaining at each interruption, in case the program inspects it.

## Which syscalls use which mechanism

| Restart code | Examples | Behavior when `SA_RESTART` is set |
|---|---|---|
| `ERESTARTSYS` | `read`, `write`, `accept`, `connect`, `waitpid`, `select` (short wait) | Restarts transparently |
| `ERESTARTNOINTR` | Wait states entered during page faults, some internal waits | Always restarts; `SA_RESTART` irrelevant |
| `ERESTARTNOHAND` | `pause`, `sigsuspend`, `epoll_wait` (with signal mask change) | Never restarts when a handler ran |
| `ERESTART_RESTARTBLOCK` | `nanosleep`, `clock_nanosleep`, `poll`, `ppoll`, `select` (with timeout), `futex` (FUTEX_WAIT) | Always restarts via `restart_syscall()`; `SA_RESTART` irrelevant |

`SA_RESTART` only controls the behavior of `ERESTARTSYS`. It has no effect on
`ERESTART_RESTARTBLOCK` (those always restart) or `ERESTARTNOHAND` (those never
restart when a handler ran). A common mistake is installing a signal handler
with `SA_RESTART` and expecting that `nanosleep()` will restart with the
original full duration — it will restart, but via `restart_syscall()` with the
remaining time, not the original duration.

## Debugging restarts

### strace

`strace` shows `restart_syscall()` explicitly whenever a restarted syscall
is invoked:

```
nanosleep({tv_sec=5, tv_nsec=0}, 0x7ffd...)  = ? ERESTART_RESTARTBLOCK (Interrupted by signal)
--- SIGALRM {si_signo=SIGALRM, si_code=SI_KERNEL} ---
rt_sigreturn()                               = 0
restart_syscall(<... resuming interrupted nanosleep ...>) = 0
```

### perf trace

`perf trace` records syscall entry and exit events including restarts:

```bash
# Trace all syscalls of a process, showing restart_syscall entries
perf trace -p <pid> 2>&1 | grep -E 'restart|nanosleep|poll'
```

### /proc/pid/syscall

`/proc/<pid>/syscall` shows the syscall a task is currently blocked in. If it
reads `219` (on x86-64), the task is inside `restart_syscall()`:

```bash
cat /proc/$(pgrep myapp)/syscall
# 219 0x0 0x0 0x0 0x0 0x0 0x0 0x7ffd12345678 0xffffffffffffffff
# ^219 = __NR_restart_syscall
```

## Further reading

- [Syscall Entry Path](syscall-entry.md) — `syscall_exit_to_user_mode()`, signal path, `pt_regs`
- [Signals](../ipc/signals.md) — signal delivery, `sigaction`, `SA_RESTART`
- `kernel/signal.c` — `restart_syscall()`, `set_restart_fn()`
- `arch/x86/kernel/signal.c` — `handle_signal()`, restart-code handling
- `include/linux/sched.h` — `struct restart_block` definition
- `kernel/time/hrtimer.c` — `nanosleep_restart()`, hrtimer-based sleep restart
