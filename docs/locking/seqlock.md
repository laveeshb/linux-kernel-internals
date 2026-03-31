# Seqlock

> Sequence counters for lockless reads of small, frequently-updated data

## The seqlock pattern

A seqlock (sequence lock) solves a specific problem: how do you let readers access small data (like a timestamp or a counter) without taking any lock, while still detecting if a concurrent write happened?

The writer increments a sequence counter before and after writing. A reader reads the counter before and after reading the data. If the counter changed (or is odd, meaning a write is in progress), the reader retries:

```
Writer:
  seq++      (now odd → write in progress)
  write data
  seq++      (now even → write complete)

Reader:
  s1 = seq
  if (s1 & 1) retry    ← write in progress
  read data
  s2 = seq
  if (s1 != s2) retry  ← write happened during read
  data is valid
```

This gives **zero-cost reads when there are no concurrent writes**, and cheap retries otherwise.

## Two types: seqcount_t and seqlock_t

```c
/* seqcount_t: raw counter, no writer serialization built in.
   You provide your own writer lock. */
typedef struct seqcount {
    unsigned sequence;
} seqcount_t;

/* seqlock_t: seqcount + embedded spinlock for writer serialization */
typedef struct {
    struct seqcount_spinlock seqcount;
    spinlock_t lock;
} seqlock_t;
```

`seqlock_t` is the complete package for most users. `seqcount_t` is used when the writer serialization is handled by some other mechanism (e.g., a mutex).

## API

### seqlock_t

```c
#include <linux/seqlock.h>

/* Initialization */
DEFINE_SEQLOCK(my_seqlock);    /* static */
seqlock_t my_seqlock;
seqlock_init(&my_seqlock);     /* dynamic */

/* Writer side */
write_seqlock(&my_seqlock);
/* modify data */
write_sequnlock(&my_seqlock);

/* Writer + IRQ disable */
write_seqlock_irqsave(&my_seqlock, flags);
write_sequnlock_irqrestore(&my_seqlock, flags);

/* Reader side: retry loop */
unsigned seq;
int value;
do {
    seq = read_seqbegin(&my_seqlock);
    value = protected_value;
} while (read_seqretry(&my_seqlock, seq));
/* value is now consistent */
```

### seqcount_t

```c
#include <linux/seqlock.h>

seqcount_t my_seqcount = SEQCNT_ZERO(my_seqcount);
/* or dynamically: seqcount_init(&my_seqcount); */

/* Writer: you serialize separately */
spin_lock(&my_lock);
write_seqcount_begin(&my_seqcount);
/* modify data */
write_seqcount_end(&my_seqcount);
spin_unlock(&my_lock);

/* Reader */
unsigned seq;
do {
    seq = read_seqcount_begin(&my_seqcount);
    /* read data */
} while (read_seqcount_retry(&my_seqcount, seq));
```

## Real-world example: jiffies and time

The kernel uses seqlocks extensively for time-related data that is updated on every timer tick but read from many places:

```c
/* kernel/time/timekeeping.c */
/* Reading the current time */
static inline u64 __ktime_get_fast_ns(void)
{
    struct tk_read_base *tkr;
    unsigned int seq;
    u64 now;

    do {
        seq = raw_read_seqcount_latch(&tk_core.seq);
        tkr = tk_core.tkr_mono + (seq & 0x01);
        now = tkr->base + clocksource_delta(tkr->clock, tkr->mask, tkr->mult, tkr->shift);
    } while (raw_read_seqcount_latch_retry(&tk_core.seq, seq));

    return now;
}
```

The `jiffies_64` counter is also protected by a seqlock on 32-bit systems (where a 64-bit read is non-atomic):

```c
/* include/linux/jiffies.h */
extern seqlock_t jiffies_lock;
extern u64 jiffies_64;

static inline u64 get_jiffies_64(void)
{
    unsigned long seq;
    u64 ret;
    do {
        seq = read_seqbegin(&jiffies_lock);
        ret = jiffies_64;
    } while (read_seqretry(&jiffies_lock, seq));
    return ret;
}
```

## Constraints

Seqlocks have important limitations:

1. **No pointers**: readers cannot follow pointers during the critical section. If the writer frees the old object between the reader's pointer dereference and its use, the reader has a dangling pointer. Use RCU instead for pointer-based data.

2. **Small, bounded data**: the retry loop must be cheap and terminating. Don't protect megabytes of data or data with variable-length reads.

3. **Writer progress**: writes complete quickly. If writes are frequent or long, readers will spin in the retry loop.

4. **No blocking in reader**: the reader critical section must not sleep (the data could change while asleep).

```
Use seqlock when:
  ✓ Data is small and fixed-size (integers, timestamps)
  ✓ Reads are much more frequent than writes
  ✓ Writers are quick and infrequent
  ✓ No pointers in the protected data

Use RCU when:
  ✓ Data is pointer-based
  ✓ Reads must see consistent snapshots of complex structures
```

## Seqlock vs rwlock

Both allow concurrent readers, but:

| | rwlock | seqlock |
|---|--------|---------|
| Reader overhead | atomic op (acquire) | non-atomic read + barrier |
| Writer blocks readers? | Yes | No (readers retry) |
| Reader starvation | No | Possible (busy writers force retries) |
| Pointer data | Yes | No |
| IRQ safe | Yes | Yes |

Seqlock wins on read-heavy, write-rare workloads with non-pointer data.

## Further reading

- [rwlock and rwsem](rwlock-rwsem.md) — For pointer-based data or complex structures
- [RCU](rcu.md) — Lock-free reads for pointer-based data
- `Documentation/locking/seqlock.rst` in the kernel tree
