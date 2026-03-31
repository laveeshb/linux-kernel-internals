# rwlock and rwsem

> Reader-writer locking — concurrent reads, exclusive writes

## The reader-writer pattern

Many kernel data structures are read far more often than they are written. A plain spinlock or mutex serializes all access, even concurrent reads that don't conflict. Reader-writer locks allow multiple simultaneous readers while ensuring writers have exclusive access:

```
Multiple readers: OK
Reader + writer:  BLOCKED (writer waits)
Two writers:      BLOCKED (second waits)
```

The kernel provides two reader-writer primitives:

| Primitive | Sleeps? | IRQ-safe? | Use when |
|-----------|---------|-----------|----------|
| `rwlock_t` | No (spinlock) | Yes | Interrupt context, short critical sections |
| `rw_semaphore` | Yes (sleeping) | No | Process context, longer critical sections |

## rwlock_t: the spinning variant

`rwlock_t` is a reader-writer spinlock. Readers and writers both spin rather than sleep.

```c
#include <linux/rwlock.h>

/* Initialization */
DEFINE_RWLOCK(my_rwlock);  /* static */
rwlock_t my_rwlock;
rwlock_init(&my_rwlock);   /* dynamic */

/* Read side */
read_lock(&my_rwlock);
/* read critical section — concurrent with other readers */
read_unlock(&my_rwlock);

/* Write side */
write_lock(&my_rwlock);
/* write critical section — exclusive */
write_unlock(&my_rwlock);

/* IRQ-safe variants (if lock is also taken in IRQ handler) */
unsigned long flags;
read_lock_irqsave(&my_rwlock, flags);
read_unlock_irqrestore(&my_rwlock, flags);

write_lock_irqsave(&my_rwlock, flags);
write_unlock_irqrestore(&my_rwlock, flags);

/* BH variants */
read_lock_bh(&my_rwlock);
read_unlock_bh(&my_rwlock);
```

On PREEMPT_RT kernels, `rwlock_t` is implemented with `rwbase_rt` (sleeping), just like `spinlock_t` maps to `rt_mutex`.

## rw_semaphore: the sleeping variant

`rw_semaphore` is the sleeping counterpart to `rwlock_t`. Contended waiters go to sleep rather than spinning (after a brief optimistic spin phase, like mutex).

```c
/* include/linux/rwsem.h */
struct rw_semaphore {
    atomic_long_t count;   /* reader count + RWSEM_WRITER_LOCKED bit */
    atomic_long_t owner;   /* writer task_struct* */
    struct osq_lock osq;   /* optimistic spinners */
    raw_spinlock_t wait_lock;
    struct list_head wait_list;
};
```

The `count` field encodes both the lock state and the reader count. The lower bits are flags; the reader count is stored in the upper bits, shifted by `RWSEM_READER_SHIFT` (8):

```
count = 0                       → unlocked
count & RWSEM_WRITER_LOCKED     → held by writer (bit 0)
count >> RWSEM_READER_SHIFT     → number of active readers
```

### API

```c
#include <linux/rwsem.h>

/* Initialization */
DECLARE_RWSEM(my_rwsem);       /* static */
struct rw_semaphore my_rwsem;
init_rwsem(&my_rwsem);         /* dynamic */

/* Read side */
down_read(&my_rwsem);          /* may sleep */
/* read critical section */
up_read(&my_rwsem);

/* Interruptible read lock */
if (down_read_interruptible(&my_rwsem))
    return -ERESTARTSYS;
up_read(&my_rwsem);

/* Trylock (non-blocking) */
if (down_read_trylock(&my_rwsem)) {
    /* got it */
    up_read(&my_rwsem);
}

/* Write side */
down_write(&my_rwsem);         /* may sleep, exclusive */
/* write critical section */
up_write(&my_rwsem);

/* Downgrade from write to read (without releasing) */
downgrade_write(&my_rwsem);    /* demote exclusive → shared */
/* now in read-side critical section */
up_read(&my_rwsem);
```

### downgrade_write

`downgrade_write()` atomically converts a write lock to a read lock. It's used when a writer has finished the write phase and wants to continue reading, while allowing other readers in:

```c
down_write(&mm->mmap_lock);
/* modify vma list */
downgrade_write(&mm->mmap_lock);
/* now read-only, other readers can join */
up_read(&mm->mmap_lock);
```

## Writer starvation

A critical problem with naïve reader-writer locks: if readers arrive continuously, a writer may never get the lock. Linux's rwsem prevents this by queuing writers — once a writer is waiting, new readers are also queued (they don't jump ahead of the waiting writer).

```
Timeline:
  R1 holds read lock
  W1 requests write lock → queues
  R2 requests read lock → also queues (behind W1)
  R1 releases → W1 gets lock
  W1 releases → R2 gets lock
```

## When to use rwlock vs rwsem vs plain mutex/spinlock

```
rwlock_t:
  ✓ IRQ context readers or writers
  ✓ Very short read/write critical sections
  ✗ Don't use if write side is rare — consider just spinlock

rw_semaphore:
  ✓ Process context, long critical sections
  ✓ Read-heavy workloads (many concurrent readers give real benefit)
  ✗ Not worth it for very short critical sections (mutex overhead similar)

Rule of thumb: if your reads are > 5x more frequent than writes,
and reads are long enough to matter, rwsem is a win.
The mm subsystem uses it heavily (mm->mmap_lock).
```

## Real-world usage: mmap_lock

The VMA list in each process is protected by `mm->mmap_lock` (an `rw_semaphore`):

```c
/* Reading VMAs (e.g., during page fault) */
mmap_read_lock(mm);      /* = down_read(&mm->mmap_lock) */
vma = find_vma(mm, addr);
/* use vma */
mmap_read_unlock(mm);    /* = up_read(&mm->mmap_lock) */

/* Modifying VMAs (e.g., mmap/munmap syscall) */
mmap_write_lock(mm);     /* = down_write(&mm->mmap_lock) */
/* add/remove/modify VMAs */
mmap_write_unlock(mm);   /* = up_write(&mm->mmap_lock) */
```

This allows multiple threads in the same process to take page faults concurrently, while mmap/munmap operations are serialized.

## Further reading

- [Spinlock and raw_spinlock](spinlock.md) — The plain spinlock
- [RCU](rcu.md) — Even more concurrent reads (no reader-side locking at all)
- [Per-VMA Locks](../mm/per-vma-locks.md) — Fine-grained alternative to mmap_lock
- `Documentation/locking/` in the kernel tree
