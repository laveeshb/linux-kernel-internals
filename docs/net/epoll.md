# epoll Internals

> How epoll monitors thousands of file descriptors efficiently

## The problem with poll/select

`select()` and `poll()` require passing the entire set of monitored file descriptors on every call. For N fds:
- Userspace → kernel copy: O(N)
- Kernel scans all fds for readiness: O(N)
- Kernel → userspace copy of ready fds: O(N)
- Total per-call: O(N), even if only 1 fd is ready

With 10,000 connections this is unacceptable.

## epoll: O(1) per event

epoll uses a **kernel-resident interest list** — registered once, no re-copying:

```
epoll workflow:

  epoll_create()  →  create struct eventpoll (rb-tree + ready list)
  epoll_ctl(ADD)  →  insert fd into rb-tree, add wait queue callback
  epoll_wait()    →  sleep; wake when ready list is non-empty
  [fd becomes ready] → ep_poll_callback adds to ready list, wakes waiter
  epoll_wait returns → copy only ready events (O(ready), not O(N))
```

## Creating an epoll instance

```c
#include <sys/epoll.h>

/* Create epoll instance */
int epfd = epoll_create1(EPOLL_CLOEXEC);

/* Add a file descriptor */
struct epoll_event ev = {
    .events  = EPOLLIN | EPOLLERR | EPOLLHUP,
    .data.fd = sock_fd,   /* or .data.ptr = &mydata */
};
epoll_ctl(epfd, EPOLL_CTL_ADD, sock_fd, &ev);

/* Modify */
ev.events = EPOLLIN | EPOLLOUT;
epoll_ctl(epfd, EPOLL_CTL_MOD, sock_fd, &ev);

/* Remove */
epoll_ctl(epfd, EPOLL_CTL_DEL, sock_fd, NULL);

/* Wait: returns up to maxevents ready fds */
struct epoll_event events[64];
int n = epoll_wait(epfd, events, 64, -1);   /* -1 = no timeout */
for (int i = 0; i < n; i++) {
    int fd = events[i].data.fd;
    if (events[i].events & EPOLLIN)
        handle_read(fd);
    if (events[i].events & EPOLLOUT)
        handle_write(fd);
}
```

## Level-triggered vs edge-triggered

### Level-triggered (LT) — default

`epoll_wait` returns as long as the fd is ready:

```c
/* LT: no flag needed, it's the default */
ev.events = EPOLLIN;

/* Behavior: */
/* recv buffer has 100 bytes */
/* epoll_wait returns fd=5 (EPOLLIN) */
/* read only 50 bytes */
/* epoll_wait returns fd=5 (EPOLLIN) again */
/* read remaining 50 bytes */
/* epoll_wait blocks (buffer empty) */
```

Safe: even if you don't drain the buffer in one call, you'll get notified again.

### Edge-triggered (ET)

`epoll_wait` returns only when the fd **transitions** from not-ready to ready:

```c
ev.events = EPOLLIN | EPOLLET;

/* Behavior: */
/* recv buffer has 100 bytes */
/* epoll_wait returns fd=5 (EPOLLIN) — transition: empty → data */
/* read only 50 bytes */
/* epoll_wait does NOT return fd=5 again (still ready, no transition) */
/* More data arrives: new transition → epoll_wait returns */
```

With EPOLLET you **must** read until `EAGAIN` in a non-blocking loop:

```c
void handle_read_et(int fd) {
    char buf[4096];
    while (1) {
        ssize_t n = recv(fd, buf, sizeof(buf), 0);
        if (n > 0) {
            process(buf, n);
        } else if (n == 0) {
            close_connection(fd);
            break;
        } else {
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                break;  /* all data read */
            if (errno == EINTR)
                continue;
            handle_error(fd);
            break;
        }
    }
}
```

### EPOLLONESHOT: single notification

Receive one notification, then the fd is automatically disabled:

```c
ev.events = EPOLLIN | EPOLLONESHOT;
epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &ev);

/* After one event, must re-arm to get more: */
epoll_ctl(epfd, EPOLL_CTL_MOD, fd, &ev);  /* re-enable */
```

Useful for multi-threaded epoll where only one thread should handle each event.

## Kernel data structures

### struct eventpoll

```c
/* fs/eventpoll.c */
struct eventpoll {
    /* Protects the access to this structure */
    spinlock_t        lock;
    struct mutex      mtx;

    /* Wait queue used by sys_epoll_wait() */
    wait_queue_head_t   wq;

    /* Wait queue used by file->poll() */
    wait_queue_head_t   poll_wait;

    /* List of ready file descriptors */
    struct list_head    rdllist;

    /* RB tree root used to store monitored fds */
    struct rb_root_cached rbr;

    /* This is a single linked list that chains all the "struct epitem"
       that happened while transferring ready events to userspace */
    struct epitem      *ovflist;

    /* wakeup_source used when ep_scan_ready_list is running */
    struct wakeup_source *ws;

    /* The user that created the eventpoll descriptor */
    struct user_struct *user;

    /* The epoll file itself */
    struct file        *file;

    /* Used to optimize the readiness check */
    int                napi_id;
    u64                gen;
    struct hlist_head  refs;
};
```

### struct epitem

One `epitem` per monitored fd:

```c
struct epitem {
    /* RB tree node used to link this structure to the eventpoll rb-tree */
    union {
        struct rb_node  rbn;
        struct rcu_head rcu;
    };

    /* List header used to link this item to the eventpoll ready list */
    struct list_head    rdllink;

    /* Works as temporary storage for the pointer when the
       ovflist is used */
    struct epitem      *next;

    /* The file descriptor information this item refers to */
    struct epoll_filefd  ffd;   /* {file*, fd} pair */

    /* Number of active wait queue attached to poll operations */
    int                 nwait;

    /* List containing poll wait queues */
    struct list_head    pwqlist;

    /* The "container" of this item */
    struct eventpoll   *ep;

    /* List header used to link this item to the ep->items list */
    struct list_head    fllink;

    /* epoll_event structure from epoll_ctl(EPOLL_CTL_ADD/MOD) */
    __poll_t            revents;
    struct epoll_event  event;
};
```

### ep_poll_callback: the critical wakeup path

When a monitored fd becomes ready, this callback runs from the fd's wait queue:

```c
/* fs/eventpoll.c */
static int ep_poll_callback(wait_queue_entry_t *wait, unsigned mode,
                              int sync, void *key)
{
    struct epitem *epi = ep_item_from_wait(wait);
    struct eventpoll *ep = epi->ep;
    __poll_t pollflags = key_to_poll(key);
    unsigned long flags;
    int ewake = 0;

    spin_lock_irqsave(&ep->wq.lock, flags);

    /* If the event we wait for is not here, try next one in the chain */
    if (pollflags && !(pollflags & epi->event.events))
        goto out_unlock;

    /* If this file is already in the ready list, we exit soon */
    if (!ep_is_linked(epi)) {
        list_add_tail(&epi->rdllink, &ep->rdllist);
        ep_pm_stay_awake_rcu(epi);
    }

    /* Wake up (if active) both the eventpoll wait list and the ->poll()
       wait list. */
    if (waitqueue_active(&ep->wq)) {
        if ((epi->event.events & EPOLLEXCLUSIVE) &&
            !(pollflags & POLLFREE)) {
            switch (pollflags & EPOLLINOUT_BITS) {
            case EPOLLIN:
                if (epi->event.events & EPOLLIN)
                    ewake = 1;
                break;
            /* ... */
            }
        } else
            ewake = 1;
        wake_up_locked(&ep->wq);
    }

out_unlock:
    spin_unlock_irqrestore(&ep->wq.lock, flags);
    return ewake;
}
```

### epoll_ctl(ADD) kernel path

```c
/* fs/eventpoll.c */
static int ep_insert(struct eventpoll *ep, const struct epoll_event *event,
                      struct file *tfile, int fd, int full_check)
{
    struct epitem *epi;

    /* Allocate the epitem structure */
    epi = kmem_cache_zalloc(epi_cache, GFP_KERNEL);

    /* Initialize the poll table using the queue callback */
    epq.epi = epi;
    init_poll_funcptr(&epq.pt, ep_ptable_queue_proc);

    /* Attach to the file's wait queue via ->poll() */
    revents = ep_item_poll(epi, &epq.pt, 1);
    /* This calls file->f_op->poll(file, &epq.pt) */
    /* poll_wait() inside the driver's poll adds ep_ptable_queue_proc
       as a wait queue callback */

    /* Insert into eventpoll's rb-tree */
    ep_rbtree_insert(ep, epi);

    /* If already ready, add to ready list immediately */
    if (revents & event->events) {
        list_add_tail(&epi->rdllink, &ep->rdllist);
        /* Wake any epoll_wait that's sleeping */
        wake_up(&ep->wq);
    }
}
```

## Thundering herd and EPOLLEXCLUSIVE

When many threads all `epoll_wait` on the same epfd and one event arrives, all threads wake up but only one handles it — **thundering herd**.

`EPOLLEXCLUSIVE` (4.5+) prevents this: only one waiter is woken per event:

```c
/* Server: one epfd per accept socket, multiple worker threads */
ev.events = EPOLLIN | EPOLLEXCLUSIVE;
epoll_ctl(shared_epfd, EPOLL_CTL_ADD, listen_fd, &ev);

/* Only one of the N epoll_wait threads wakes per connection */
```

Alternative: use separate epfds per thread, each with its own `accept()` thread on a `SO_REUSEPORT` socket:

```c
/* Per-thread accept: each thread has its own listening socket */
setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &(int){1}, sizeof(int));
/* Kernel load-balances new connections across all SO_REUSEPORT sockets */
```

## epoll with eventfd, signalfd, timerfd

epoll works with any fd that implements `->poll`:

```c
/* Unified event loop: I/O + signals + timers + events */
epoll_ctl(epfd, EPOLL_CTL_ADD, sock_fd,   &ev_socket);
epoll_ctl(epfd, EPOLL_CTL_ADD, signalfd,  &ev_signal);
epoll_ctl(epfd, EPOLL_CTL_ADD, timerfd,   &ev_timer);
epoll_ctl(epfd, EPOLL_CTL_ADD, eventfd,   &ev_event);
epoll_ctl(epfd, EPOLL_CTL_ADD, pipe_rfd,  &ev_pipe);
```

All block on a single `epoll_wait`. No polling loop, no busy-waiting.

## epoll limitations

- **Regular files**: always "ready" — cannot use epoll for disk file I/O (use io_uring)
- **Directories**: not pollable
- **No timeout per fd**: epoll_wait has one timeout for all
- **Notification only**: epoll tells you a fd is ready but doesn't do the I/O (unlike io_uring)

## Observing epoll

```bash
# Count epoll instances per process
ls -l /proc/<pid>/fd | grep eventpoll

# See epoll fds in /proc
cat /proc/<pid>/fdinfo/<epfd>
# pos: 0
# flags: 02
# mnt_id: 9
# tfd:   3 events: 19 data: 3000000003  pos:0 ino:7 stype:0x8001

# Trace epoll_wait calls
strace -e epoll_wait,epoll_ctl nginx &

# Perf: time spent in epoll_wait
perf stat -e syscalls:sys_enter_epoll_wait nginx
```

## Further reading

- [Socket Layer Overview](socket-layer.md) — socket poll() implementation
- [eventfd and signalfd](../ipc/eventfd-signalfd.md) — epoll-compatible event fds
- [POSIX Timers and timerfd](../time/posix-timers.md) — timerfd with epoll
- [io_uring Architecture](../io-uring/io-uring-arch.md) — io_uring solves epoll's file I/O limitation
- [Completions and Wait Queues](../locking/completions.md) — the wait_queue mechanism epoll uses
- `fs/eventpoll.c` — complete epoll implementation
