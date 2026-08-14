# Signals

> Asynchronous notifications delivered to processes

## Signal basics

A signal is an integer (1–64 on x86-64) sent to a process or thread. The kernel delivers it by interrupting the target process at the next opportunity (syscall return, interrupt return).

```
Sender                Kernel                Receiver
──────                ──────                ────────
kill(pid, SIGTERM) →  pending bit set   →   process checks TIF_SIGPENDING
                      on return to user     arch_do_signal_or_restart()
                      mode:                 → runs signal handler
                                           → or default action (terminate)
```

Standard signals (1–31) are not queued — multiple sends before delivery collapse to one. Real-time signals (32–64, `SIGRTMIN`..`SIGRTMAX`) are queued.

## Signal numbers and default actions

```
SIGHUP  (1)  — hangup (terminal closed) → terminate
SIGINT  (2)  — interrupt (Ctrl+C) → terminate
SIGQUIT (3)  — quit (Ctrl+\) → core dump
SIGILL  (4)  — illegal instruction → core dump
SIGTRAP (5)  — debug trap → core dump
SIGABRT (6)  — abort() → core dump
SIGFPE  (8)  — arithmetic exception → core dump
SIGKILL (9)  — kill (cannot be caught/ignored) → terminate
SIGSEGV (11) — invalid memory access → core dump
SIGPIPE (13) — write to closed pipe → terminate
SIGALRM (14) — timer (alarm()) → terminate
SIGTERM (15) — termination request → terminate
SIGCHLD (17) — child status change → ignore
SIGCONT (18) — continue if stopped → continue
SIGSTOP (19) — stop (cannot be caught/ignored) → stop
SIGTSTP (20) — terminal stop (Ctrl+Z) → stop
SIGUSR1 (10) — user defined → terminate
SIGUSR2 (12) — user defined → terminate
SIGRTMIN..SIGRTMAX (32..64) — real-time → terminate
```

## Sending signals

```c
/* kill: send to process or process group */
kill(pid, SIGTERM);   /* pid>0: specific process */
kill(-pgrp, SIGTERM); /* pid<0: process group */
kill(0, SIGTERM);     /* current process group */
kill(-1, SIGTERM);    /* all processes (except init) — requires privilege */

/* tkill: send to specific thread (deprecated, use tgkill) */
tkill(tid, SIGTERM);

/* tgkill: send to specific thread in specific process (Linux-specific) */
tgkill(tgid, tid, SIGTERM);

/* sigqueue: send with data (for real-time signals) */
union sigval value;
value.sival_int = 42;
sigqueue(pid, SIGRTMIN, value);
/* Receiver gets si_value.sival_int == 42 in siginfo_t */

/* raise: send to current thread */
raise(SIGINT);

/* From kernel: */
send_sig(SIGTERM, task, 0);         /* send to process */
send_sig_info(SIGTERM, &info, task); /* with siginfo_t */
kill_pgrp(pgrp, SIGTERM, 0);
```

## Kernel signal delivery path

```c
/* Spans three files: do_send_sig_info()/signal_wake_up()/get_signal() are
 * in kernel/signal.c; exit_to_user_mode_loop() is in kernel/entry/common.c;
 * arch_do_signal_or_restart()/handle_signal()/setup_rt_frame() are x86-64-
 * specific, in arch/x86/kernel/signal.c */

/* 1. do_send_sig_info(): queues signal to target task */
do_send_sig_info(sig, info, task, type)
  /* Process-directed (kill): goes to task->signal->shared_pending */
  /* Thread-directed (tgkill): goes to task->pending */
  → sigaddset(&task->signal->shared_pending.signal, sig)  /* process-directed */
  → signal_wake_up(task, sig == SIGKILL)    /* wake if sleeping, set TIF_SIGPENDING */

/* 2. On return to userspace (syscall return, interrupt return): */
exit_to_user_mode_loop()
  → if TIF_SIGPENDING: arch_do_signal_or_restart(regs)
      → get_signal(&ksig)               /* dequeue next signal (also handles
                                          * the ignored/default-action cases
                                          * internally -- only "handled"
                                          * returns to the caller below) */
      → if handled: handle_signal(&ksig) /* set up userspace stack frame */

/* 3. handle_signal: set up signal frame on userspace stack */
handle_signal(ksig, regs)
  → setup_rt_frame(ksig, regs)
      /* pushes: siginfo_t, ucontext_t, trampoline code onto user stack */
      /* sets rip = signal handler, rsp = new user stack */
      /* sets up SIGRETURN trampoline (calls rt_sigreturn syscall) */
```

After the signal handler returns, the trampoline calls `rt_sigreturn` which restores the saved `ucontext_t` (CPU registers before signal delivery) and resumes normal execution.

## struct sigaction: installing handlers

```c
#include <signal.h>

/* sa_handler or sa_sigaction (not both) */
struct sigaction {
    union {
        void (*sa_handler)(int signum);
        void (*sa_sigaction)(int signum, siginfo_t *info, void *ucontext);
    };
    sigset_t sa_mask;     /* signals to block during handler */
    int      sa_flags;    /* SA_SIGINFO, SA_RESTART, SA_NODEFER, ... */
    void    (*sa_restorer)(void);  /* internal use */
};
```

```c
/* Install a signal handler */
struct sigaction sa = {
    .sa_sigaction = my_handler,
    .sa_flags = SA_SIGINFO | SA_RESTART,
};
sigemptyset(&sa.sa_mask);
sigaddset(&sa.sa_mask, SIGTERM);  /* block SIGTERM during handler */
sigaction(SIGUSR1, &sa, NULL);

/* Handler: */
static void my_handler(int sig, siginfo_t *info, void *ctx)
{
    /* info->si_pid: sender's PID */
    /* info->si_code: SI_USER, SI_QUEUE, SI_TIMER, ... */
    /* info->si_value: data from sigqueue() */
    printf("signal %d from pid %d\n", sig, info->si_pid);
}
```

Important flags:
- `SA_SIGINFO` — use `sa_sigaction` (3-arg handler) instead of `sa_handler`
- `SA_RESTART` — auto-restart interrupted syscalls (`EINTR` hidden from app)
- `SA_NODEFER` — don't block the signal during its own handler (reentrant)
- `SA_RESETHAND` — reset to default after one delivery

## Signal masks

Each thread has a signal mask — blocked signals are not delivered until unblocked:

```c
/* Block SIGINT and SIGTERM temporarily */
sigset_t block_set, old_set;
sigemptyset(&block_set);
sigaddset(&block_set, SIGINT);
sigaddset(&block_set, SIGTERM);
sigprocmask(SIG_BLOCK, &block_set, &old_set);

/* ... critical section ... */

/* Restore original mask */
sigprocmask(SIG_SETMASK, &old_set, NULL);

/* Atomically: wait for specific signal while unblocking */
sigsuspend(&old_set);  /* replaces mask, sleeps until any signal */
```

### Kernel data structures

```c
/* Per-process signal state */
struct signal_struct {
    /* pending signals shared by all threads: */
    struct sigpending   shared_pending;
    /* ... */
};

/* Per-thread signal state */
struct task_struct {
    /* thread-private pending signals: */
    struct sigpending   pending;
    sigset_t            blocked;        /* current signal mask */
    sigset_t            real_blocked;   /* saved mask (for sigwaitinfo) */
    sigset_t            saved_sigmask;  /* restored on sigreturn */
    /* ... */
};

struct sigpending {
    struct list_head    list;           /* queued siginfo_t for RT signals */
    sigset_t            signal;         /* bitmask of pending standard signals */
};
```

## Real-time signals

Real-time signals (SIGRTMIN..SIGRTMAX) differ from standard signals:
- **Queued**: multiple sends before delivery are all delivered (FIFO order)
- **Value**: can carry an integer or pointer (via sigqueue + `si_value`)
- **Priority**: lower signal number = higher priority within real-time range

```c
/* Send with data */
union sigval val = { .sival_int = 100 };
sigqueue(pid, SIGRTMIN+1, val);

/* Receive multiple */
struct sigaction sa = {
    .sa_sigaction = rt_handler,
    .sa_flags = SA_SIGINFO,
};
sigaction(SIGRTMIN+1, &sa, NULL);

/* Synchronously wait for signal */
sigset_t wait_set;
sigemptyset(&wait_set);
sigaddset(&wait_set, SIGRTMIN+1);
sigprocmask(SIG_BLOCK, &wait_set, NULL);  /* must block before sigwaitinfo */

siginfo_t info;
sigwaitinfo(&wait_set, &info);
/* info.si_value.sival_int == 100 */
```

## signalfd: signals as file descriptors

`signalfd` converts signal delivery into `read()` calls, enabling use with `epoll`:

```c
#include <sys/signalfd.h>
#include <sys/epoll.h>

/* Block signals we want to receive via signalfd */
sigset_t mask;
sigemptyset(&mask);
sigaddset(&mask, SIGINT);
sigaddset(&mask, SIGTERM);
sigprocmask(SIG_BLOCK, &mask, NULL);

/* Create signalfd */
int sfd = signalfd(-1, &mask, SFD_NONBLOCK | SFD_CLOEXEC);

/* Add to epoll */
struct epoll_event ev = { .events = EPOLLIN, .data.fd = sfd };
epoll_ctl(epfd, EPOLL_CTL_ADD, sfd, &ev);

/* Read signal info */
struct signalfd_siginfo si;
read(sfd, &si, sizeof(si));
if (si.ssi_signo == SIGTERM) {
    /* clean shutdown */
}
```

## SIGCHLD and waitpid

`SIGCHLD` is sent to a parent when a child changes state (exits, stops, continues). The parent must call `waitpid` to reap the zombie:

```c
static void sigchld_handler(int sig, siginfo_t *info, void *ctx)
{
    int status;
    pid_t pid;

    /* Reap all exited children (loop for multiple children) */
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        if (WIFEXITED(status))
            printf("child %d exited with %d\n", pid, WEXITSTATUS(status));
        else if (WIFSIGNALED(status))
            printf("child %d killed by signal %d\n", pid, WTERMSIG(status));
    }
}
```

## Further reading

### Kernel source

- [kernel/signal.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/signal.c) — `do_send_sig_info()`, `signal_wake_up()`, and `get_signal()`: the core signal-queuing and dequeuing implementation
- [kernel/entry/common.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/entry/common.c) — `exit_to_user_mode_loop()`: where `TIF_SIGPENDING` is checked on the way back to userspace
- [arch/x86/kernel/signal.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/signal.c) — `arch_do_signal_or_restart()`, `handle_signal()`, `setup_rt_frame()`: x86-64 signal-frame setup and the `rt_sigreturn` trampoline
- [include/linux/sched.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/sched.h) — `task_struct`: per-thread `pending`, `blocked`, `real_blocked`, `saved_sigmask`
- [include/linux/sched/signal.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/sched/signal.h) — `signal_struct`: per-process `shared_pending`
- [include/linux/signal_types.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/signal_types.h) — `struct sigpending` definition

### Man pages

- [signal(7)](https://man7.org/linux/man-pages/man7/signal.7.html) — signal list, default dispositions, and the standard-vs-real-time queuing distinction
- [sigaction(2)](https://man7.org/linux/man-pages/man2/sigaction.2.html) — `struct sigaction` and the `SA_*` flags
- [kill(2)](https://man7.org/linux/man-pages/man2/kill.2.html) — `pid` targeting rules (process, process group, broadcast)
- [rt_sigqueueinfo(2)](https://man7.org/linux/man-pages/man2/rt_sigqueueinfo.2.html) — the syscall underlying `sigqueue(3)`, used to queue a real-time signal with data
- [signalfd(2)](https://man7.org/linux/man-pages/man2/signalfd.2.html) — signals delivered as `read()`-able file descriptor events
- [signal-safety(7)](https://man7.org/linux/man-pages/man7/signal-safety.7.html) — which functions may safely be called from a signal handler

### Related pages

- [eventfd and signalfd](eventfd-signalfd.md) — a fuller treatment of `signalfd`, including `struct signalfd_siginfo` and the `epoll` integration pattern
- [Pipes and FIFOs](pipes.md) — `SIGPIPE` when writing to a broken pipe

### LWN articles

- [Ghosts of Unix past, part 3: Unfixable designs](https://lwn.net/Articles/414618/) — Neil Brown on why the original signal design became unfixably complicated, and how `signalfd()` sidesteps it by making delivery synchronous
