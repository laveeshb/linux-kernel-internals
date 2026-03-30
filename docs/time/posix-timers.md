# POSIX Timers and timerfd

> User-facing timer APIs: timer_create, clock_nanosleep, and timerfd

## POSIX timer APIs

POSIX defines a portable timer interface built on arbitrary clock IDs:

```c
#include <signal.h>
#include <time.h>

/* Create a timer */
timer_t timerid;
struct sigevent sev = {
    .sigev_notify = SIGEV_SIGNAL,   /* notify via signal */
    .sigev_signo  = SIGRTMIN,       /* which signal */
};
timer_create(CLOCK_MONOTONIC, &sev, &timerid);

/* Arm it: first expiry at 100ms, then repeat every 50ms */
struct itimerspec its = {
    .it_value    = { .tv_sec = 0, .tv_nsec = 100000000 }, /* 100ms */
    .it_interval = { .tv_sec = 0, .tv_nsec =  50000000 }, /* 50ms repeat */
};
timer_settime(timerid, 0 /* relative */, &its, NULL);

/* Query current state */
struct itimerspec cur;
timer_gettime(timerid, &cur);

/* Delete */
timer_delete(timerid);
```

### Notification modes

```c
/* sigev_notify options: */

/* Deliver signal (default) */
sev.sigev_notify = SIGEV_SIGNAL;
sev.sigev_signo  = SIGRTMIN + 1;

/* Create a new thread for each expiry */
sev.sigev_notify            = SIGEV_THREAD;
sev.sigev_notify_function   = my_callback;
sev.sigev_notify_attributes = NULL;

/* Send signal to specific thread */
sev.sigev_notify            = SIGEV_THREAD_ID;
sev.sigev_signo             = SIGRTMIN;
sev._sigev_un._tid          = gettid();  /* specific thread */

/* No notification (query manually with timer_gettime) */
sev.sigev_notify = SIGEV_NONE;
```

## clock_nanosleep

`clock_nanosleep` suspends the calling thread until an absolute or relative time:

```c
struct timespec req, rem;

/* Relative sleep: 10ms */
req.tv_sec  = 0;
req.tv_nsec = 10000000;
clock_nanosleep(CLOCK_MONOTONIC, 0, &req, &rem);

/* Absolute sleep: wake at a specific monotonic time */
struct timespec now, abs;
clock_gettime(CLOCK_MONOTONIC, &now);
abs.tv_sec  = now.tv_sec;
abs.tv_nsec = now.tv_nsec + 5000000;  /* 5ms from now */
if (abs.tv_nsec >= 1000000000L) {
    abs.tv_sec++;
    abs.tv_nsec -= 1000000000L;
}
/* TIMER_ABSTIME: don't wake early due to signal if abs time hasn't passed */
clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &abs, NULL);
```

The absolute form is important for precise periodic loops — avoids drift from relative sleep accumulation.

### Precise periodic loop

```c
/* Common pattern: audio/video callback at fixed period */
static void run_periodic(long period_ns)
{
    struct timespec next;
    clock_gettime(CLOCK_MONOTONIC, &next);

    while (running) {
        /* Do work */
        do_work();

        /* Advance to next period (absolute time, no drift) */
        next.tv_nsec += period_ns;
        if (next.tv_nsec >= 1000000000L) {
            next.tv_sec++;
            next.tv_nsec -= 1000000000L;
        }
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL);
    }
}
```

## timerfd

`timerfd_create` returns a file descriptor that becomes readable when the timer expires. This enables integrating timers with `epoll` and `select` — no signals needed.

```c
#include <sys/timerfd.h>
#include <sys/epoll.h>

/* Create a timerfd */
int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);

/* Arm: fire every 100ms */
struct itimerspec its = {
    .it_value    = { .tv_nsec = 100000000 },
    .it_interval = { .tv_nsec = 100000000 },
};
timerfd_settime(tfd, 0, &its, NULL);

/* Integrate with epoll */
int epfd = epoll_create1(EPOLL_CLOEXEC);
struct epoll_event ev = { .events = EPOLLIN, .data.fd = tfd };
epoll_ctl(epfd, EPOLL_CTL_ADD, tfd, &ev);

/* Event loop */
while (1) {
    struct epoll_event events[8];
    int n = epoll_wait(epfd, events, 8, -1);

    for (int i = 0; i < n; i++) {
        if (events[i].data.fd == tfd) {
            uint64_t expirations;
            read(tfd, &expirations, sizeof(expirations));
            /* expirations = number of times timer fired since last read
               (can be > 1 if we're behind) */
            handle_timer(expirations);
        }
    }
}
```

### timerfd_settime flags

```c
/* Absolute time */
timerfd_settime(tfd, TFD_TIMER_ABSTIME, &its, NULL);

/* Cancel on clock changes (CLOCK_REALTIME) */
timerfd_settime(tfd, TFD_TIMER_CANCEL_ON_SET, &its, NULL);
/* Returns ECANCELED on read after clock was set */
```

## Kernel implementation

### POSIX timers in the kernel

```c
/* kernel/time/posix-timers.c */
struct k_itimer {
    struct list_head    list;       /* per-process list */
    struct hlist_node   t_hash;     /* hash table node */
    spinlock_t          it_lock;

    const struct k_clock *kclock;   /* clock operations */
    clockid_t            it_clock;
    timer_t              it_id;

    int                  it_overrun;     /* missed expirations */
    int                  it_overrun_last;

    int                  it_requeue_pending;
    int                  it_sigev_notify;
    ktime_t              it_interval;   /* reload interval */
    struct signal_struct *it_signal;
    union {
        struct pid         *it_pid;
        struct task_struct *it_process;
    };
    struct sigqueue      *sigq;         /* pre-allocated signal */

    union {
        struct {
            struct hrtimer  timer;   /* hrtimer backing this POSIX timer */
        } real;
        struct cpu_timer_list   cpu;  /* CPU time timers */
    } it;
};
```

Each `timer_create()` allocates a `k_itimer` backed by an `hrtimer`. When the hrtimer fires, it queues the signal.

### timerfd in the kernel

```c
/* fs/timerfd.c */
struct timerfd_ctx {
    union {
        struct hrtimer      tmr;   /* backing hrtimer */
        struct alarm        alarm; /* for CLOCK_REALTIME_ALARM */
    } t;
    ktime_t             tintv;     /* interval */
    ktime_t             moffs;     /* MONOTONIC offset at creation */
    wait_queue_head_t   wqh;       /* epoll/select wait queue */
    u64                 ticks;     /* expired count */
    int                 clockid;
    short               expired;   /* pending reads */
    short               settime_flags;
    struct rcu_head     rcu;
    struct list_head    clist;
    spinlock_t          cancel_lock;
    bool                might_cancel;
};

/* hrtimer callback: wake epoll waiters */
static enum hrtimer_restart timerfd_tmrproc(struct hrtimer *htmr)
{
    struct timerfd_ctx *ctx = container_of(htmr, struct timerfd_ctx, t.tmr);

    spin_lock(&ctx->wqh.lock);
    ctx->ticks++;
    wake_up_locked_poll(&ctx->wqh, EPOLLIN);
    spin_unlock(&ctx->wqh.lock);

    return ctx->tintv ? HRTIMER_RESTART : HRTIMER_NORESTART;
}
```

## Overruns

When a periodic timer fires faster than you consume it, expirations accumulate:

```c
/* timer_create: check overruns */
struct itimerspec its;
timer_gettime(timerid, &its);
int overruns = timer_getoverrun(timerid);
/* overruns > 0: missed this many expirations */

/* timerfd: read returns accumulated count */
uint64_t count;
ssize_t sz = read(tfd, &count, sizeof(count));
if (count > 1)
    fprintf(stderr, "Behind by %llu expirations\n", count - 1);
```

Overruns happen when:
- Handler takes longer than the period
- System is loaded; scheduling latency > period
- Thread was blocked (sleeping, waiting for I/O)

## Choosing the right API

| Scenario | Use |
|----------|-----|
| Simple sleep | `clock_nanosleep` |
| Periodic work, signal-based | `timer_create(SIGEV_SIGNAL)` |
| Event loop (epoll/select) | `timerfd_create` |
| Real-time periodic thread | `clock_nanosleep(TIMER_ABSTIME)` |
| Timeout on I/O | `timerfd` + `epoll` |
| Kernel driver timer | `hrtimer` |

## Observing POSIX timers

```bash
# Active timers for a process
cat /proc/<pid>/timers
# ID: 0
# signal: 34 /...
# notify: signal/pid.12345
# ClockID: 1 (CLOCK_MONOTONIC)

# timerfd shows up as an anonymous inode in lsof
lsof -p <pid> | grep timerfd

# perf: timer system calls
perf trace -e timer_create,clock_nanosleep -p <pid>

# Tracepoints: POSIX timer events
echo 1 > /sys/kernel/tracing/events/timer/hrtimer_start/enable
echo 1 > /sys/kernel/tracing/events/syscalls/sys_enter_timer_settime/enable
```

## Further reading

- [hrtimers](hrtimers.md) — kernel timer implementation backing POSIX timers
- [Timekeeping](timekeeping.md) — clock IDs and their semantics
- [IPC: Signals](../ipc/signals.md) — signal delivery for `SIGEV_SIGNAL` timers
- [io_uring: Operations](../io-uring/io-uring-ops.md) — `IORING_OP_TIMEOUT` for ring-based timers
- `man 2 timerfd_create`, `man 2 clock_nanosleep`, `man 7 time`
