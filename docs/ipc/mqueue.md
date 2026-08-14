# POSIX Message Queues

> Priority-ordered, kernel-managed message passing between processes

## Overview

POSIX message queues (`mq_open`, `mq_send`, `mq_receive`) provide a message-passing IPC mechanism with:
- **Priority ordering**: messages are dequeued highest-priority first
- **Blocking and non-blocking**: readers block until a message arrives
- **Async notification**: `mq_notify` delivers a signal or starts a thread when a message arrives
- **Kernel persistence**: queues survive until explicitly deleted or system reboot
- **VFS integration**: queues appear as files under `/dev/mqueue`

```bash
# Mount the mqueue filesystem (usually automatic on modern systems)
mount -t mqueue none /dev/mqueue
ls /dev/mqueue/   # lists all open queues
```

## Basic usage

```c
#include <mqueue.h>
/* Link with -lrt */

/* Create or open a queue */
struct mq_attr attr = {
    .mq_maxmsg  = 10,     /* maximum messages in queue */
    .mq_msgsize = 256,    /* maximum message size (bytes) */
};

/* Producer: open for writing */
mqd_t mq = mq_open("/myqueue", O_WRONLY | O_CREAT, 0644, &attr);

/* Consumer: open for reading */
mqd_t mq = mq_open("/myqueue", O_RDONLY);

/* Send a message (priority 5) */
const char *msg = "hello";
mq_send(mq, msg, strlen(msg), 5);  /* prio=5 (higher = dequeued first) */

/* Receive the highest-priority message */
char buf[256];
unsigned int prio;
ssize_t n = mq_receive(mq, buf, sizeof(buf), &prio);
printf("received %zd bytes, priority=%u: %.*s\n", n, prio, (int)n, buf);

/* Delete the queue */
mq_close(mq);
mq_unlink("/myqueue");
```

### Queue attributes

```c
/* Query queue attributes */
struct mq_attr attr;
mq_getattr(mq, &attr);
printf("maxmsg=%ld msgsize=%ld curmsgs=%ld\n",
       attr.mq_maxmsg, attr.mq_msgsize, attr.mq_curmsgs);

/* Set non-blocking mode */
attr.mq_flags = O_NONBLOCK;
mq_setattr(mq, &attr, NULL);

/* Non-blocking receive: returns EAGAIN if empty */
ssize_t n = mq_receive(mq, buf, sizeof(buf), &prio);
if (n == -1 && errno == EAGAIN)
    printf("queue empty\n");
```

## Priority queue behavior

Messages are ordered by priority (highest first). Same priority messages are FIFO:

```c
mq_send(mq, "low",    3, 1);  /* priority 1 */
mq_send(mq, "high",   4, 9);  /* priority 9 */
mq_send(mq, "medium", 6, 5);  /* priority 5 */
mq_send(mq, "high2",  5, 9);  /* priority 9 */

/* Dequeue order: high (p9), high2 (p9), medium (p5), low (p1) */
```

Priority range: 0 to `sysconf(_SC_MQ_PRIO_MAX) - 1` (at least 32, typically 32768).

## Timed operations

```c
#include <time.h>

/* Send with timeout (absolute time) */
struct timespec deadline;
clock_gettime(CLOCK_REALTIME, &deadline);
deadline.tv_sec += 5;  /* 5 seconds from now */

int ret = mq_timedsend(mq, msg, len, prio, &deadline);
if (ret == -1 && errno == ETIMEDOUT)
    printf("queue full, timed out\n");

/* Receive with timeout */
ssize_t n = mq_timedreceive(mq, buf, size, &prio, &deadline);
if (n == -1 && errno == ETIMEDOUT)
    printf("queue empty, timed out\n");
```

## Async notification: mq_notify

`mq_notify` delivers a notification when a message arrives in an empty queue:

```c
/* Signal notification */
struct sigevent sev = {
    .sigev_notify = SIGEV_SIGNAL,
    .sigev_signo  = SIGUSR1,
};
mq_notify(mq, &sev);

/* Only one process can be registered for notifications at a time */
/* Registration is one-shot: must re-register after each notification */

/* Thread notification: starts a thread on message arrival */
struct sigevent sev = {
    .sigev_notify            = SIGEV_THREAD,
    .sigev_notify_function   = my_handler,
    .sigev_notify_attributes = NULL,  /* default thread attrs */
};
mq_notify(mq, &sev);

void my_handler(union sigval sv) {
    /* Called in a new thread when message arrives */
    mqd_t mq = sv.sival_int;  /* pass mq via sigval if needed */
    /* Read messages, then re-register: */
    mq_notify(mq, &sev);
}
```

### epoll with mq_notify + eventfd

For integration with an event loop:

```c
int efd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);

/* Notify via eventfd write */
struct sigevent sev = {
    .sigev_notify            = SIGEV_THREAD,
    .sigev_notify_function   = notify_handler,
    .sigev_value.sival_int   = efd,
};
mq_notify(mq, &sev);

void notify_handler(union sigval sv) {
    int efd = sv.sival_int;
    write(efd, &(uint64_t){1}, 8);
    mq_notify(mq, &sev);  /* re-register */
}

/* epoll_wait on efd triggers when message arrives */
```

## System limits

```bash
# Maximum number of message queues per user
cat /proc/sys/fs/mqueue/queues_max    # default: 256

# Default maximum messages per queue
cat /proc/sys/fs/mqueue/msg_max       # default: 10

# Default maximum message size
cat /proc/sys/fs/mqueue/msgsize_max   # default: 8192

# Default mq_maxmsg applied to queues created without explicit attributes
# (not priority-related; msgsize_default is the sibling for message size)
cat /proc/sys/fs/mqueue/msg_default

# View all open queues with their attributes:
ls -la /dev/mqueue/
cat /dev/mqueue/myqueue  # shows: QSIZE:0 NOTIFY:0 SIGNO:0 NOTIFY_PID:0
```

## Kernel implementation

### struct mqueue_inode_info

```c
/* ipc/mqueue.c */
struct mqueue_inode_info {
    spinlock_t         lock;
    struct inode       vfs_inode;
    wait_queue_head_t  wait_q;

    /* One rb-tree, keyed by priority -- not an array of per-priority
     * lists. Same-priority messages are FIFO via a per-node msg_list. */
    struct rb_root     msg_tree;
    struct rb_node    *msg_tree_rightmost;
    struct posix_msg_tree_node *node_cache;  /* spare node, avoids GFP_ATOMIC alloc */
    struct mq_attr     attr;

    /* Notification */
    struct sigevent    notify;
    struct pid        *notify_owner;
    u32                notify_self_exec_id;
    struct user_namespace *notify_user_ns;
    struct ucounts    *ucounts;       /* user who created, for accounting */
    struct sock       *notify_sock;
    struct sk_buff    *notify_cookie;

    /* Waiters for free space and for messages, respectively */
    struct ext_wait_queue e_wait_q[2];

    unsigned long      qsize;         /* total size of queue in memory */
};

/* Each rb-tree node covers one distinct priority; messages of that
 * priority hang off msg_list in FIFO order */
struct posix_msg_tree_node {
    struct rb_node    rb_node;
    struct list_head  msg_list;
    int               priority;
};
```

### Message structure

```c
/* include/linux/msg.h */
struct msg_msg {
    struct list_head  m_list;   /* on priority list */
    long              m_type;   /* priority (stored as type) */
    size_t            m_ts;     /* message text size */
    struct msg_msgseg *next;    /* for messages > PAGE_SIZE */
    void             *security; /* LSM security label */
    /* Message data follows immediately in memory */
};
```

### mq_send kernel path

```c
/* ipc/mqueue.c -- simplified from the real do_mq_timedsend(); the real
 * function also handles a speculative node_cache allocation and a
 * pipelined direct handoff to an already-waiting receiver, skipping the
 * tree entirely when one exists */
static int do_mq_timedsend(mqd_t mqdes, const char __user *u_msg_ptr,
                           size_t msg_len, unsigned int msg_prio,
                           struct timespec64 *ts)
{
    struct mqueue_inode_info *info;
    struct msg_msg *msg_ptr;

    /* Allocate and copy message data from userspace */
    msg_ptr = load_msg(u_msg_ptr, msg_len);
    msg_ptr->m_ts = msg_len;
    msg_ptr->m_type = msg_prio;

    spin_lock(&info->lock);

    if (info->attr.mq_curmsgs == info->attr.mq_maxmsg) {
        /* Queue full: block (via wq_sleep(), on the SEND wait list) or EAGAIN */
        if (filp->f_flags & O_NONBLOCK) {
            spin_unlock(&info->lock);
            return -EAGAIN;
        }
        return wq_sleep(info, SEND, timeout, &wait);  /* releases the lock itself */
    }

    /* No receiver waiting: insert into the priority tree and notify */
    msg_insert(msg_ptr, info);
    __do_notify(info);

    spin_unlock(&info->lock);
    return 0;
}
```

### Priority tree insertion

```c
/* ipc/mqueue.c */
static int msg_insert(struct msg_msg *msg, struct mqueue_inode_info *info)
{
    struct rb_node **p, *parent = NULL;
    struct posix_msg_tree_node *leaf;
    bool rightmost = true;

    /* Find (or create) the rb-tree node for this priority */
    p = &info->msg_tree.rb_node;
    while (*p) {
        parent = *p;
        leaf = rb_entry(parent, struct posix_msg_tree_node, rb_node);

        if (likely(leaf->priority == msg->m_type))
            goto insert_msg;
        else if (msg->m_type < leaf->priority) {
            p = &(*p)->rb_left;
            rightmost = false;
        } else
            p = &(*p)->rb_right;
    }
    /* No existing node for this priority: use the spare node_cache if
     * available, otherwise allocate one (GFP_ATOMIC, under the lock) */
    if (info->node_cache) {
        leaf = info->node_cache;
        info->node_cache = NULL;
    } else {
        leaf = kmalloc_obj(*leaf, GFP_ATOMIC);
        if (!leaf)
            return -ENOMEM;
        INIT_LIST_HEAD(&leaf->msg_list);
    }
    leaf->priority = msg->m_type;
    if (rightmost)
        info->msg_tree_rightmost = &leaf->rb_node;
    rb_link_node(&leaf->rb_node, parent, p);
    rb_insert_color(&leaf->rb_node, &info->msg_tree);

insert_msg:
    /* Same-priority messages are FIFO within this node's msg_list */
    info->attr.mq_curmsgs++;
    info->qsize += msg->m_ts;
    list_add_tail(&msg->m_list, &leaf->msg_list);
    return 0;
}
```

## POSIX mqueue vs SysV message queues

| Feature | POSIX mqueue | SysV msgsnd/msgrcv |
|---------|-------------|-------------------|
| API | `mq_open`/`mq_send` | `msgget`/`msgsnd` |
| Name | `/name` in mqueue FS | Integer key (IPC_PRIVATE) |
| Priority | Yes (per-message priority) | Type-based filtering |
| Notification | `mq_notify` (signal/thread) | None (polling only) |
| epoll | Yes (real fd on Linux) | No |
| VFS | `/dev/mqueue/` | `/proc/sysvipc/msg` |
| Persistence | Until `mq_unlink` | Until explicit removal |
| Portability | POSIX standard | Historical (XSI) |

Note: On Linux, POSIX mqueue file descriptors are real fds and work with `select()`, `poll()`, and `epoll()` directly (since 2.6.19).

## SysV message queues (brief)

```c
#include <sys/msg.h>

/* Create/get a SysV message queue */
int msqid = msgget(IPC_PRIVATE, IPC_CREAT | 0666);
/* or by key: key_t key = ftok("/some/file", 'A'); */

/* Send */
struct msgbuf {
    long mtype;   /* must be > 0; used for filtering */
    char mtext[256];
} msg = { .mtype = 1, .mtext = "hello" };
msgsnd(msqid, &msg, strlen(msg.mtext), 0);

/* Receive: mtype=0 → first message; mtype>0 → first msg of that type */
struct msgbuf recv;
msgrcv(msqid, &recv, sizeof(recv.mtext), 0, 0);

/* Remove */
msgctl(msqid, IPC_RMID, NULL);
```

```bash
# List SysV queues
ipcs -q

# Show queue details
ipcs -q -i <msqid>

# Remove all SysV queues
ipcrm --all=msg
```

## Further reading

### Kernel source

- [ipc/mqueue.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/ipc/mqueue.c) — POSIX mqueue filesystem, syscalls (`do_mq_timedsend()`, `do_mq_timedreceive()`), and `struct mqueue_inode_info`
- [ipc/msg.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/ipc/msg.c) — SysV message queue implementation (`msgget`/`msgsnd`/`msgrcv`)
- [include/uapi/linux/mqueue.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/mqueue.h) — `struct mq_attr` and `MQ_PRIO_MAX` (32768)
- [include/linux/msg.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/msg.h) — `struct msg_msg`, the message representation shared by POSIX and SysV queues

### Man pages

- [`mq_overview(7)`](https://man7.org/linux/man-pages/man7/mq_overview.7.html) — overview of the POSIX message queue API, `/dev/mqueue`, and the `/proc/sys/fs/mqueue` limits
- [`mq_open(3)`](https://man7.org/linux/man-pages/man3/mq_open.3.html) — create/open a queue, `O_CREAT`/`O_EXCL` semantics, `struct mq_attr`
- [`mq_send(3)`](https://man7.org/linux/man-pages/man3/mq_send.3.html) — `mq_send()`/`mq_timedsend()`
- [`mq_receive(3)`](https://man7.org/linux/man-pages/man3/mq_receive.3.html) — `mq_receive()`/`mq_timedreceive()`
- [`mq_notify(3)`](https://man7.org/linux/man-pages/man3/mq_notify.3.html) — `SIGEV_SIGNAL`/`SIGEV_THREAD`/`SIGEV_NONE` notification modes
- [`mq_getattr(3)`](https://man7.org/linux/man-pages/man3/mq_getattr.3.html) — `mq_getattr()`/`mq_setattr()`

### Related pages

- [SysV IPC: Semaphores and Message Queues](sysv-semaphores.md) — full treatment of `msgget`/`msgsnd`/`msgrcv` and kernel internals, referenced briefly above
- [eventfd and signalfd](eventfd-signalfd.md) — the `epoll` integration pattern used in the mq_notify example above
- [Signals](signals.md) — real-time signal delivery, used by `mq_notify`'s `SIGEV_SIGNAL` mode
- [Pipes and FIFOs](pipes.md) — byte-stream IPC, contrasted with mqueue's message-oriented model
- [Shared Memory, Semaphores, and eventfd](shared-memory.md) — zero-copy bulk IPC vs. mqueue's small bounded messages
- [POSIX Timers and timerfd](../time/posix-timers.md) — same `sigevent`-based notification model as `mq_notify`

### LWN articles

- [IPC medley: message-queue peeking, io_uring, and bus1](https://lwn.net/Articles/1065490/) — Jonathan Corbet, April 2026; covers a proposed (not yet merged as of this page's kernel pin) `mq_timedreceive2()`/`MQ_PEEK` extension for non-destructive, index-addressed message reads
