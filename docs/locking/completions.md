# Completions and Wait Queues

> Blocking synchronization: sleeping until an event occurs

## struct completion

`completion` is a simple one-shot synchronization primitive: one thread waits, another signals when done. It's simpler and safer than using `wait_queue_head_t` directly for this common pattern.

```c
#include <linux/completion.h>

/* Declare and initialize */
DECLARE_COMPLETION(my_completion);
/* Or dynamically: */
struct completion c;
init_completion(&c);

/* Waiter thread: block until signaled */
wait_for_completion(&c);
/* Execution continues here after signal */

/* Signaler thread: wake up the waiter */
complete(&c);
/* After complete(), one waiter is woken */
```

### Completion variants

```c
/* Timed wait: return 0 on timeout, 1 on completion */
unsigned long remaining = wait_for_completion_timeout(&c, jiffies + HZ);
if (!remaining)
    pr_err("Timed out waiting!\n");

/* Interruptible wait: return -ERESTARTSYS if signal arrives */
int ret = wait_for_completion_interruptible(&c);
if (ret)
    return ret;  /* interrupted */

/* Interruptible with timeout */
long ret = wait_for_completion_interruptible_timeout(&c, timeout);
/* ret > 0: completed */
/* ret == 0: timed out */
/* ret < 0: interrupted */

/* Wake all waiters (not just one) */
complete_all(&c);

/* Reinitialize after all waiters have woken */
reinit_completion(&c);

/* Check without blocking */
if (completion_done(&c)) {
    /* already signaled */
}
```

### Completion with try_wait

```c
/* Non-blocking check: acquire if already signaled */
if (try_wait_for_completion(&c)) {
    /* Was already complete — no blocking */
} else {
    /* Not yet complete — would have blocked */
}
```

## struct wait_queue_head_t

`wait_queue_head_t` is the lower-level primitive that `completion` builds on. It supports:
- Multiple waiters on the same event
- Custom wake conditions
- Exclusive vs non-exclusive wakeup
- `poll()/select()/epoll` integration

```c
#include <linux/wait.h>

/* Declare */
DECLARE_WAIT_QUEUE_HEAD(my_wq);
/* Or: */
wait_queue_head_t wq;
init_waitqueue_head(&wq);
```

## wait_event: the standard pattern

`wait_event` combines the wait with a condition check:

```c
/* Waiter: sleep until condition is true */
wait_event(wq, condition);
/* condition is re-evaluated after every wakeup */

/* Interruptible version */
int ret = wait_event_interruptible(wq, condition);
if (ret)
    return ret;  /* -ERESTARTSYS: signal received */

/* With timeout */
long ret = wait_event_timeout(wq, condition, timeout_jiffies);
/* ret > 0: condition met */
/* ret == 0: timed out */

/* With interruptible + timeout */
long ret = wait_event_interruptible_timeout(wq, condition, timeout);
```

**The wake_up / wait_event contract**:

```c
/* Signaler: modify the condition variable, then wake */
WRITE_ONCE(data_ready, true);
wake_up(&wq);          /* wake one non-exclusive waiter */
wake_up_all(&wq);      /* wake all waiters */
wake_up_interruptible(&wq);  /* wake only interruptible waiters */
```

`wait_event` uses a loop:
```c
/* wait_event expansion (simplified): */
for (;;) {
    prepare_to_wait(&wq, &__wait, TASK_UNINTERRUPTIBLE);
    if (condition)
        break;
    schedule();   /* sleep */
}
finish_wait(&wq, &__wait);
```

This correctly handles races: if the condition becomes true between the check and `schedule()`, the wake_up will have set the task state back to TASK_RUNNING.

## Custom wait: prepare_to_wait / finish_wait

For more complex patterns:

```c
DEFINE_WAIT(wait);

prepare_to_wait(&wq, &wait, TASK_INTERRUPTIBLE);
while (!condition) {
    if (signal_pending(current)) {
        /* Signal received */
        break;
    }
    /* Drop any locks here before sleeping */
    spin_unlock_irq(&lock);
    schedule();
    spin_lock_irq(&lock);
    /* Recheck condition here */
}
finish_wait(&wq, &wait);
```

## Exclusive waiters

Exclusive waiters are woken one at a time (thundering herd prevention):

```c
/* Add as exclusive waiter (only woken by wake_up, not wake_up_all) */
prepare_to_wait_exclusive(&wq, &wait, TASK_INTERRUPTIBLE);

/* wake_up: wakes exactly one exclusive waiter + all non-exclusive */
wake_up(&wq);
```

Used for accept() on TCP listen sockets: only one of many waiting accept() calls needs to be woken when a connection arrives.

## poll/select/epoll integration

Drivers implement `poll` (or `->poll` in file_operations) using wait queues:

```c
/* In file_operations.poll or .f_poll: */
static __poll_t mydev_poll(struct file *file, poll_table *wait)
{
    struct mydev *dev = file->private_data;
    __poll_t mask = 0;

    /* Register this file's wait queue with the poll table */
    poll_wait(file, &dev->read_wq, wait);
    poll_wait(file, &dev->write_wq, wait);

    /* Check current state */
    if (!kfifo_is_empty(&dev->recv_fifo))
        mask |= EPOLLIN | EPOLLRDNORM;   /* data available to read */
    if (!kfifo_is_full(&dev->send_fifo))
        mask |= EPOLLOUT | EPOLLWRNORM;  /* space available to write */

    return mask;
}

/* When data arrives: wake the wait queue */
void mydev_data_arrived(struct mydev *dev)
{
    kfifo_put(&dev->recv_fifo, data);
    wake_up_interruptible(&dev->read_wq);
}
```

`poll_wait` adds the wait queue to the poll table so that epoll monitors it. When `wake_up` fires, epoll wakes the calling process.

## wait_queue_entry: custom callbacks

Advanced use: add a custom function to call on wakeup:

```c
/* Custom wait entry with callback */
static int my_wakeup_func(struct wait_queue_entry *curr,
                           unsigned mode, int wake_flags, void *key)
{
    struct mydata *data = container_of(curr, struct mydata, wait_entry);

    /* Called in the waker's context (IRQ or process) */
    /* Return 0 to continue waking other waiters, 1 to stop */

    /* Schedule a task for later processing */
    schedule_work(&data->work);
    return 1;  /* don't wake the task directly */
}

struct wait_queue_entry wqe = {
    .private = &mydata,
    .func    = my_wakeup_func,
    .flags   = 0,  /* or WQ_FLAG_EXCLUSIVE for exclusive */
};

add_wait_queue(&wq, &wqe);
/* ... */
remove_wait_queue(&wq, &wqe);
```

## Common patterns

### Producer/consumer with wait queue

```c
struct ring_buffer {
    u8               data[1024];
    unsigned int     head, tail;
    wait_queue_head_t not_empty;   /* consumers wait here */
    wait_queue_head_t not_full;    /* producers wait here */
    spinlock_t        lock;
};

/* Consumer */
int rb_read(struct ring_buffer *rb, u8 *buf, size_t len)
{
    int ret;

    spin_lock(&rb->lock);
    ret = wait_event_interruptible_lock_irq(rb->not_empty,
                                             !rb_is_empty(rb),
                                             rb->lock);
    if (ret) {
        spin_unlock(&rb->lock);
        return ret;  /* interrupted */
    }

    memcpy(buf, &rb->data[rb->tail], len);
    rb->tail = (rb->tail + len) % sizeof(rb->data);
    spin_unlock(&rb->lock);

    wake_up(&rb->not_full);
    return len;
}

/* Producer */
int rb_write(struct ring_buffer *rb, const u8 *buf, size_t len)
{
    spin_lock(&rb->lock);
    wait_event_interruptible_lock_irq(rb->not_full, !rb_is_full(rb), rb->lock);
    memcpy(&rb->data[rb->head], buf, len);
    rb->head = (rb->head + len) % sizeof(rb->data);
    spin_unlock(&rb->lock);

    wake_up(&rb->not_empty);
    return len;
}
```

## Further reading

- [SRCU](srcu.md) — sleepable RCU with read-side blocking
- [Mutex](mutex.md) — sleeping mutual exclusion
- [IPC: Signals](../ipc/signals.md) — signal delivery to waiting tasks
- [io_uring](../io-uring/io-uring-arch.md) — io_uring avoids wait queues entirely
- `include/linux/wait.h` — full wait queue API
