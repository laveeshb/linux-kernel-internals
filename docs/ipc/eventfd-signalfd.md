# eventfd and signalfd

> Event notification and signal delivery through file descriptors

## eventfd: a counter you can poll

`eventfd` creates a file descriptor backed by a kernel counter. It's used for:
- Event notification between threads or processes
- Waking up `epoll`/`select`/`poll` from another context
- Counting occurrences (semaphore-like, but pollable)

```c
#include <sys/eventfd.h>

int efd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
/* initval=0: initial counter value */
/* EFD_SEMAPHORE: semaphore mode (see below) */
```

### Writing (signaling)

Writing an 8-byte `uint64_t` adds to the counter:

```c
uint64_t value = 1;
write(efd, &value, sizeof(value));  /* counter += 1 */

/* Multiple signals: */
value = 5;
write(efd, &value, sizeof(value));  /* counter += 5 */

/* Counter has a ceiling of UINT64_MAX - 1 */
/* write blocks (or returns EAGAIN with EFD_NONBLOCK) when at max, it does not saturate */
```

### Reading (consuming)

Reading an 8-byte `uint64_t` returns the current counter and resets it to 0:

```c
uint64_t count;
ssize_t n = read(efd, &count, sizeof(count));
/* n == 8, count == accumulated value, counter reset to 0 */

/* EFD_NONBLOCK: returns EAGAIN if counter == 0 */
```

### EFD_SEMAPHORE mode

With `EFD_SEMAPHORE`, each `read()` decrements by 1 and returns 1 (not the full count):

```c
int efd = eventfd(0, EFD_SEMAPHORE | EFD_NONBLOCK);

write(efd, &(uint64_t){3}, 8);  /* counter = 3 */

uint64_t val;
read(efd, &val, 8);  /* val=1, counter=2 */
read(efd, &val, 8);  /* val=1, counter=1 */
read(efd, &val, 8);  /* val=1, counter=0 */
read(efd, &val, 8);  /* EAGAIN: counter==0 */
```

### epoll integration

The key feature: `eventfd` integrates with `epoll` so you can wake a sleeping event loop:

```c
int epfd = epoll_create1(0);
int efd  = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);

struct epoll_event ev = { .events = EPOLLIN, .data.fd = efd };
epoll_ctl(epfd, EPOLL_CTL_ADD, efd, &ev);

/* In another thread or signal handler: */
write(efd, &(uint64_t){1}, 8);  /* wakes epoll_wait */

/* Main loop: */
struct epoll_event events[16];
int n = epoll_wait(epfd, events, 16, -1);
for (int i = 0; i < n; i++) {
    if (events[i].data.fd == efd) {
        uint64_t count;
        read(efd, &count, 8);   /* consume + reset */
        /* Handle the event */
    }
}
```

### Typical uses

**Thread pool wakeup**: Instead of a mutex+condvar, use eventfd with a work queue:

```c
struct thread_pool {
    int        wakeup_efd;  /* eventfd */
    /* ... work queue ... */
};

/* Enqueue work and wake a thread */
void enqueue(struct thread_pool *pool, struct work *w) {
    work_queue_push(pool, w);
    write(pool->wakeup_efd, &(uint64_t){1}, 8);
}

/* Worker thread */
void worker(struct thread_pool *pool) {
    while (1) {
        uint64_t count;
        read(pool->wakeup_efd, &count, 8);  /* blocks until work */
        /* process 'count' items */
    }
}
```

**io_uring completion notification**: io_uring can post to an eventfd when completions arrive:

```c
io_uring_register_eventfd(ring, efd);
/* Now epoll_wait on efd wakes when CQEs are available */
```

### Kernel implementation

```c
/* fs/eventfd.c */
struct eventfd_ctx {
    struct kref     kref;
    wait_queue_head_t wqh;
    __u64           count;
    unsigned int    flags;
    int             id;   /* for debugging */
};

static ssize_t eventfd_write(struct file *file, const char __user *buf,
                             size_t count, loff_t *ppos)
{
    struct eventfd_ctx *ctx = file->private_data;
    ssize_t res;
    __u64 ucnt;

    if (count != sizeof(ucnt))
        return -EINVAL;
    if (copy_from_user(&ucnt, buf, sizeof(ucnt)))
        return -EFAULT;
    /* Writing the exact max value is rejected outright, not saturated */
    if (ucnt == ULLONG_MAX)
        return -EINVAL;

    spin_lock_irq(&ctx->wqh.lock);
    res = -EAGAIN;
    if (ULLONG_MAX - ctx->count > ucnt)
        res = sizeof(ucnt);
    else if (!(file->f_flags & O_NONBLOCK)) {
        /* Block until there's room, rather than silently saturating */
        res = wait_event_interruptible_locked_irq(ctx->wqh,
                ULLONG_MAX - ctx->count > ucnt);
        if (!res)
            res = sizeof(ucnt);
    }
    if (likely(res > 0)) {
        ctx->count += ucnt;
        if (waitqueue_active(&ctx->wqh))
            wake_up_locked_poll(&ctx->wqh, EPOLLIN);
    }
    spin_unlock_irq(&ctx->wqh.lock);

    return res;
}

/* eventfd uses the iov_iter read interface (.read_iter), not the classic
 * .read(file, buf, count, ppos) signature */
static ssize_t eventfd_read(struct kiocb *iocb, struct iov_iter *to)
{
    struct file *file = iocb->ki_filp;
    struct eventfd_ctx *ctx = file->private_data;
    __u64 ucnt = 0;

    if (iov_iter_count(to) < sizeof(ucnt))
        return -EINVAL;

    spin_lock_irq(&ctx->wqh.lock);
    if (!ctx->count) {
        if ((file->f_flags & O_NONBLOCK) || (iocb->ki_flags & IOCB_NOWAIT)) {
            spin_unlock_irq(&ctx->wqh.lock);
            return -EAGAIN;
        }
        /* Sleep until count > 0 */
        if (wait_event_interruptible_locked_irq(ctx->wqh, ctx->count)) {
            spin_unlock_irq(&ctx->wqh.lock);
            return -ERESTARTSYS;
        }
    }

    if (ctx->flags & EFD_SEMAPHORE) {
        ucnt = 1;
        ctx->count--;
    } else {
        ucnt = ctx->count;
        ctx->count = 0;
    }
    /* Wake up blocked writers if count was at max */
    if (waitqueue_active(&ctx->wqh))
        wake_up_locked_poll(&ctx->wqh, EPOLLOUT);
    spin_unlock_irq(&ctx->wqh.lock);

    if (unlikely(copy_to_iter(&ucnt, sizeof(ucnt), to) != sizeof(ucnt)))
        return -EFAULT;
    return sizeof(ucnt);
}
```

## signalfd: receive signals via file descriptor

Normally, signals interrupt the current execution at unpredictable points. `signalfd` delivers signals as readable data on a file descriptor, making signal handling compatible with `epoll`-driven event loops.

```c
#include <sys/signalfd.h>
#include <signal.h>

/* Block signals from normal delivery first */
sigset_t mask;
sigemptyset(&mask);
sigaddset(&mask, SIGINT);
sigaddset(&mask, SIGTERM);
sigaddset(&mask, SIGUSR1);
sigprocmask(SIG_BLOCK, &mask, NULL);

/* Create signalfd for these signals */
int sfd = signalfd(-1, &mask, SFD_NONBLOCK | SFD_CLOEXEC);

/* Read signal info (blocks or EAGAIN with SFD_NONBLOCK) */
struct signalfd_siginfo ssi;
ssize_t n = read(sfd, &ssi, sizeof(ssi));
if (n == sizeof(ssi)) {
    printf("signal %u from pid %u\n", ssi.ssi_signo, ssi.ssi_pid);
    printf("uid=%u code=%d status=%d\n",
           ssi.ssi_uid, ssi.ssi_code, ssi.ssi_status);
}
```

### signalfd_siginfo fields

```c
struct signalfd_siginfo {
    uint32_t ssi_signo;    /* Signal number */
    int32_t  ssi_errno;    /* Error number (usually 0) */
    int32_t  ssi_code;     /* Signal code (SI_USER, SI_KERNEL, etc.) */
    uint32_t ssi_pid;      /* PID of sender */
    uint32_t ssi_uid;      /* UID of sender */
    int32_t  ssi_fd;       /* File descriptor (SIGIO) */
    uint32_t ssi_tid;      /* Timer ID (SIGALRM/SIGVTALRM) */
    uint32_t ssi_band;     /* Band event (SIGIO) */
    uint32_t ssi_overrun;  /* Timer overrun count */
    uint32_t ssi_trapno;   /* Trap number (hardware fault) */
    int32_t  ssi_status;   /* Exit status/signal (SIGCHLD) */
    int32_t  ssi_int;      /* Integer payload (sigqueue) */
    uint64_t ssi_ptr;      /* Pointer payload (sigqueue) */
    uint64_t ssi_utime;    /* User CPU time consumed (SIGCHLD) */
    uint64_t ssi_stime;    /* System CPU time consumed (SIGCHLD) */
    uint64_t ssi_addr;     /* Faulting address (SIGSEGV/SIGBUS) */
    /* ... padding ... */
};
```

### epoll with signalfd

The canonical pattern for a single-threaded server handling both I/O and signals:

```c
/* Block signals at thread/process level */
sigset_t mask;
sigemptyset(&mask);
sigaddset(&mask, SIGINT);
sigaddset(&mask, SIGTERM);
sigaddset(&mask, SIGCHLD);
pthread_sigmask(SIG_BLOCK, &mask, NULL);

int sfd = signalfd(-1, &mask, SFD_NONBLOCK | SFD_CLOEXEC);
int epfd = epoll_create1(EPOLL_CLOEXEC);

/* Add signalfd and other fds to epoll */
struct epoll_event ev = { .events = EPOLLIN, .data.fd = sfd };
epoll_ctl(epfd, EPOLL_CTL_ADD, sfd, &ev);

/* ... add socket fds, timer fds, etc. ... */

/* Single event loop for everything */
while (running) {
    struct epoll_event events[32];
    int n = epoll_wait(epfd, events, 32, -1);

    for (int i = 0; i < n; i++) {
        int fd = events[i].data.fd;

        if (fd == sfd) {
            struct signalfd_siginfo ssi;
            read(sfd, &ssi, sizeof(ssi));
            if (ssi.ssi_signo == SIGTERM || ssi.ssi_signo == SIGINT)
                running = 0;
            else if (ssi.ssi_signo == SIGCHLD)
                reap_children();
        } else {
            handle_io(fd);
        }
    }
}
```

### signalfd vs traditional signal handling

| Approach | Thread-safe | epoll-compatible | Signal info |
|----------|------------|-----------------|-------------|
| `signal()`/`sigaction()` | Careful with SA_RESTART | No | Limited |
| `sigwaitinfo()` | Yes (blocking) | No | Full siginfo |
| `signalfd` | Yes | **Yes** | Full siginfo_t |
| `self-pipe trick` | Yes | Yes | Signal number only |

The **self-pipe trick** (write a byte to a pipe in the signal handler, read from the other end in the event loop) was the traditional solution. `signalfd` replaces it cleanly.

### signalfd update

Pass an existing sfd to update its mask:

```c
/* Add SIGUSR2 to existing signalfd */
sigaddset(&mask, SIGUSR2);
signalfd(sfd, &mask, 0);  /* first arg is existing fd */
```

### Kernel implementation

```c
/* fs/signalfd.c — real function uses .read_iter, not the classic
 * .read(file, buf, count, ppos) signature, and delegates dequeuing to a
 * helper (signalfd_dequeue()) rather than calling dequeue_signal() inline */
static ssize_t signalfd_read_iter(struct kiocb *iocb, struct iov_iter *to)
{
    struct file *file = iocb->ki_filp;
    struct signalfd_ctx *ctx = file->private_data;
    size_t count = iov_iter_count(to);
    ssize_t ret, total = 0;
    kernel_siginfo_t info;
    bool nonblock;

    count /= sizeof(struct signalfd_siginfo);
    if (!count)
        return -EINVAL;

    nonblock = file->f_flags & O_NONBLOCK || iocb->ki_flags & IOCB_NOWAIT;
    do {
        /* Dequeue a pending signal matching our mask (blocks internally
         * unless nonblock), sleeping on current->sighand->signalfd_wqh */
        ret = signalfd_dequeue(ctx, &info, nonblock);
        if (unlikely(ret <= 0))
            break;
        /* Copy siginfo to userspace signalfd_siginfo format directly
         * into the iov_iter -- no intermediate siginfo_t buffer */
        ret = signalfd_copyinfo(to, &info);
        if (ret < 0)
            break;
        total += ret;
        nonblock = 1;   /* only the first iteration may block */
    } while (--count);

    return total ? total : ret;
}
```

`dequeue_signal()` itself takes exactly three arguments — `(sigset_t *mask, kernel_siginfo_t *info, enum pid_type *type)` — with no explicit `current` argument (it operates on the caller's own pending signals). There is no `copy_siginfo_to_user_sighand()` anywhere in the kernel; the real translation to the userspace `struct signalfd_siginfo` layout is done by `signalfd_copyinfo()`, which maps fields via a `siginfo_layout()` switch.

## timerfd: pollable timers

`timerfd` (covered in [POSIX Timers](../time/posix-timers.md)) follows the same pattern — a file descriptor that becomes readable when a timer fires. Combined with eventfd and signalfd, it enables a complete event loop without threads:

```c
/* All three work with epoll: */
epoll_ctl(epfd, EPOLL_CTL_ADD, timerfd, &ev_timer);
epoll_ctl(epfd, EPOLL_CTL_ADD, signalfd, &ev_signal);
epoll_ctl(epfd, EPOLL_CTL_ADD, eventfd,  &ev_event);
epoll_ctl(epfd, EPOLL_CTL_ADD, sock_fd,  &ev_socket);
/* One epoll_wait handles timers + signals + events + I/O */
```

## Further reading

### Kernel source

- [fs/eventfd.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/eventfd.c) — `do_eventfd()`, `eventfd_read()`/`eventfd_write()`, and the `eventfd_signal_mask()` in-kernel signaling entry point
- [fs/signalfd.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/signalfd.c) — `signalfd_read_iter()`, `signalfd_copyinfo()`, and `do_signalfd4()`
- [include/uapi/linux/eventfd.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/eventfd.h) — `EFD_SEMAPHORE`/`EFD_CLOEXEC`/`EFD_NONBLOCK` flag definitions
- [include/uapi/linux/signalfd.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/signalfd.h) — the `signalfd_siginfo` struct layout

### Man pages

- [`eventfd(2)`](https://man7.org/linux/man-pages/man2/eventfd.2.html) — counter semantics, `EFD_SEMAPHORE`, and the `ULLONG_MAX - 1` blocking/EAGAIN ceiling
- [`signalfd(2)`](https://man7.org/linux/man-pages/man2/signalfd.2.html) — `signalfd_siginfo` fields and the epoll+`fork()` caveat

### Related pages

- [Signals](signals.md) — the traditional signal delivery path `signalfd` replaces
- [epoll Internals](../net/epoll.md) — the event loop eventfd/signalfd are designed to integrate with
- [POSIX Timers and timerfd](../time/posix-timers.md) — the third pollable-fd primitive that rounds out an all-fd event loop
- [Completions and Wait Queues](../locking/completions.md) — the `wait_queue_head_t` primitive `eventfd_ctx` and signalfd's per-sighand queue build on
- [IPC War Stories](war-stories.md) — a real eventfd `EAGAIN`/backpressure incident, walked through against `eventfd_write()`
