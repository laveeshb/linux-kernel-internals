# Futex Internals

> How userspace mutex and condition variable implementations work in the kernel

## Why futexes exist

Before futexes, every POSIX mutex operation went through the kernel. `pthread_mutex_lock()` called `sem_wait()` or a similar syscall; `pthread_mutex_unlock()` called `sem_post()`. A syscall costs ~100–300 ns on modern hardware. A program that holds fine-grained mutexes for short durations (a hash table lock held for a few cache accesses, for example) could spend more time in the kernel than doing actual work.

Hubertus Franke (IBM), Rusty Russell, and Matthew Kirkwood designed futexes in 2002 to eliminate this overhead — presented at the Ottawa Linux Symposium 2002 in ["Fuss, Futexes and Furwocks: Fast Userlevel Locking in Linux"](https://www.kernel.org/doc/ols/2002/ols2002-pages-479-495.pdf). (Ulrich Drepper later designed glibc's `pthread_mutex_t` *on top of* futexes; Ingo Molnár contributed early race-condition fixes.) The key observation: **locking is only expensive when there's contention**. When no other thread is waiting, the entire lock/unlock operation can be two atomic instructions in userspace. The kernel only needs to be called to park and unpark threads.

futex(2) entered Linux 2.6.0 (December 2003) — see [`man 2 futex`](https://www.man7.org/linux/man-pages/man2/futex.2.html). Today, glibc's `pthread_mutex_t`, `pthread_cond_t`, `pthread_rwlock_t`, `sem_t`, and C++ `std::mutex` are all implemented on top of futexes.

## What is a futex?

A **futex** (fast userspace mutex) is the kernel mechanism that allows userspace locking primitives (pthreads mutex, condition variables, semaphores) to be efficient. The key insight: in the common uncontended case, locking and unlocking should happen entirely in userspace with no kernel involvement. The kernel is only called when there's actual contention.

The futex syscall (`futex(2)`) provides two core operations:
- `FUTEX_WAIT`: sleep if the futex word has a given value
- `FUTEX_WAKE`: wake one or more waiters

## The uncontended fast path

A pthread mutex, for example, is implemented over a 32-bit integer in userspace memory:

```c
/* Simplified pthread mutex */
int mutex_word = 0;  /* 0 = unlocked, 1 = locked, 2 = locked with waiters */

void pthread_mutex_lock(int *mutex_word)
{
    /* Fast path: try to take the lock with an atomic CAS */
    if (atomic_cmpxchg(mutex_word, 0, 1) == 0)
        return;  /* got it, no kernel call */

    /* Slow path: there's contention, call into the kernel */
    do {
        /* Mark that there are waiters */
        atomic_set(mutex_word, 2);
        /* Sleep until value != 2 */
        futex(mutex_word, FUTEX_WAIT, 2, NULL, NULL, 0);
    } while (atomic_cmpxchg(mutex_word, 0, 2) != 0);
}

void pthread_mutex_unlock(int *mutex_word)
{
    /* Fast path: no waiters */
    if (atomic_xchg(mutex_word, 0) == 1)
        return;  /* just clear, no kernel call */

    /* Slow path: there are waiters, wake one */
    futex(mutex_word, FUTEX_WAKE, 1, NULL, NULL, 0);
}
```

The kernel is called only when:
1. Locking: the lock is already held (someone needs to sleep)
2. Unlocking: there are waiters that need to be woken

For a lightly-contended mutex, most lock/unlock operations complete entirely in userspace with two atomic instructions.

## Kernel-side data structures

```c
/* kernel/futex/futex.h */

/* Identifies a specific futex (where in memory it is) */
union futex_key {
    struct {
        u64 ptr;          /* for private futexes: mm pointer */
        unsigned long word;  /* page offset + word offset */
    } private;
    struct {
        u64 ptr;          /* for shared futexes: mapping pointer */
        unsigned long pgoff; /* page offset in file */
        unsigned int offset;
    } shared;
    struct {
        u64 ptr;
        unsigned long word;
    } both;
};

/* One entry per sleeping waiter */
struct futex_q {
    struct plist_node list;       /* sorted by priority in hash bucket */
    struct task_struct *task;     /* the sleeping task */
    spinlock_t *lock_ptr;         /* hash bucket lock */
    union futex_key key;          /* what futex we're waiting on */
    struct futex_pi_state *pi_state; /* priority inheritance state */
    u32 bitset;                   /* for FUTEX_WAIT_BITSET */
};

/* Hash table bucket: all futexes with the same hash share a bucket */
struct futex_hash_bucket {
    atomic_t waiters;
    spinlock_t lock;
    struct plist_head chain;      /* list of futex_q entries */
} ____cacheline_aligned_in_smp;
```

The hash table has `1 << CONFIG_FUTEX_HASHBITS` buckets (default 256 on most configs). Multiple futexes may share a bucket — the key is used to identify the specific futex when waking.

## Private vs shared futexes

```c
/* Private futex (process-private, default in glibc) */
futex(&word, FUTEX_WAIT | FUTEX_PRIVATE_FLAG, expected, timeout, NULL, 0);

/* Shared futex (can be in shared memory, accessible cross-process) */
futex(&word, FUTEX_WAIT, expected, timeout, NULL, 0);
```

Private futexes are slightly faster because the key is just the virtual address — no page table walk needed. Shared futexes use the underlying page's physical address (via `page->mapping` + offset) so multiple processes mapping the same page see the same futex.

## FUTEX_WAIT: going to sleep

```c
/* Simplified kernel FUTEX_WAIT implementation */
int futex_wait(u32 __user *uaddr, u32 val, ...)
{
    struct futex_q q;
    struct futex_hash_bucket *hb;

    /* 1. Compute the key */
    ret = get_futex_key(uaddr, &q.key);

    /* 2. Lock the hash bucket */
    hb = hash_futex(&q.key);
    spin_lock(&hb->lock);

    /* 3. Check the value under the bucket lock */
    ret = get_user(uval, uaddr);
    if (uval != val) {
        /* Value changed before we got here: return without sleeping */
        spin_unlock(&hb->lock);
        return -EAGAIN;
    }

    /* 4. Queue ourselves */
    plist_add(&q.list, &hb->chain);
    spin_unlock(&hb->lock);

    /* 5. Sleep */
    set_current_state(TASK_INTERRUPTIBLE);
    schedule();

    /* 6. Woke up: remove from queue */
    return 0;
}
```

The crucial step is checking the value **under the hash bucket lock** (step 3). This prevents a race where:
- Userspace sees the lock is contended and calls FUTEX_WAIT
- The lock holder unlocks and calls FUTEX_WAKE before we've queued
- We'd sleep forever without the lock check

## FUTEX_WAKE: waking sleepers

```c
int futex_wake(u32 __user *uaddr, int nr_wake)
{
    struct futex_hash_bucket *hb;
    struct futex_key key;
    struct futex_q *q;

    get_futex_key(uaddr, &key);
    hb = hash_futex(&key);

    spin_lock(&hb->lock);
    /* Find waiters with matching key and wake them */
    plist_for_each_entry_safe(q, ..., &hb->chain, list) {
        if (futex_match(&q->key, &key)) {
            wake_up_process(q->task);
            if (--nr_wake == 0)
                break;
        }
    }
    spin_unlock(&hb->lock);
}
```

## PI futexes

Priority-inheritance futexes (`FUTEX_LOCK_PI`, `FUTEX_UNLOCK_PI`) implement the priority inheritance protocol for userspace mutexes. When a high-priority task blocks on a PI futex held by a low-priority task, the low-priority task's effective priority is boosted.

The kernel maintains a `futex_pi_state` struct that connects the `futex_q` to an `rt_mutex` — the same priority-inheritance machinery used by `rt_mutex_t` in the kernel.

```c
/* Userspace PI mutex (simplified) */
void pi_mutex_lock(int *uaddr)
{
    /* Try to take: set word to our TID */
    int zero = 0;
    if (cmpxchg(uaddr, 0, gettid()) == 0)
        return;  /* got it */
    /* Block: kernel will boost owner's priority */
    futex(uaddr, FUTEX_LOCK_PI, 0, timeout, NULL, 0);
}
```

## Condition variables (FUTEX_WAIT + FUTEX_WAKE)

`pthread_cond_wait` is implemented as:
1. Release the associated mutex (userspace atomic)
2. `FUTEX_WAIT` on the condition variable word
3. On wake: re-acquire the mutex

`pthread_cond_signal` / `pthread_cond_broadcast` use `FUTEX_WAKE` (signal) or `FUTEX_REQUEUE` (broadcast, to efficiently move waiters to the mutex's queue without waking them all).

### Why FUTEX_REQUEUE exists

The naive implementation of `pthread_cond_broadcast` is `FUTEX_WAKE` with a large count — wake all waiters. The problem: all N waiters wake up simultaneously, all try to re-acquire the associated mutex, and N-1 of them immediately go back to sleep. This is a **thundering herd**.

`FUTEX_CMP_REQUEUE` (added in Linux 2.6.7, 2004 — [`man 2 futex`](https://www.man7.org/linux/man-pages/man2/futex.2.html)) moves sleeping threads from the condvar queue to the mutex queue *without waking them*. One waiter is woken (to acquire the mutex), and the rest are requeued. When the first waiter releases the mutex, the next requeued waiter wakes up, and so on. N waiters are processed sequentially rather than all competing at once.

## Further reading

- [Mutex and rt_mutex](mutex.md) — Kernel-side sleeping locks
- [Priority Inversion & PI Mutexes](../sched/pi-mutexes.md) — The rt_mutex PI mechanism
- `man 2 futex` — Syscall interface
- `Documentation/locking/` in the kernel tree
