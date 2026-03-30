# Atomic Operations and Memory Barriers

> The primitives that all higher-level synchronization is built on

## What problem do atomics solve?

On modern CPUs, a simple `x++` compiles to three operations: load `x`, add 1, store `x`. If two CPUs run this simultaneously, both might load the same value and one increment is lost:

```
CPU 0:  load x (gets 5)                store x = 6
CPU 1:              load x (gets 5)              store x = 6
Result: x = 6 (should be 7)
```

Atomic operations are hardware instructions that perform a read-modify-write as a single indivisible unit. No other CPU can see an intermediate state.

## atomic_t and atomic64_t

```c
/* include/linux/atomic.h */
typedef struct { int counter; } atomic_t;
typedef struct { s64 counter; } atomic64_t;

/* Basic operations */
atomic_t a = ATOMIC_INIT(0);

atomic_read(&a);              /* read value */
atomic_set(&a, 5);            /* set value */

atomic_inc(&a);               /* a++ */
atomic_dec(&a);               /* a-- */
atomic_add(n, &a);            /* a += n */
atomic_sub(n, &a);            /* a -= n */

/* Return the new value */
int v = atomic_inc_return(&a);   /* ++a */
int v = atomic_dec_return(&a);   /* --a */
int v = atomic_add_return(n, &a);
int v = atomic_sub_return(n, &a);

/* Return the old value */
int old = atomic_fetch_add(n, &a);
int old = atomic_fetch_sub(n, &a);

/* Test and return */
bool zero = atomic_dec_and_test(&a);  /* returns true if result == 0 */
bool neg  = atomic_add_negative(n, &a); /* returns true if result < 0 */

/* Bitwise */
atomic_or(mask, &a);
atomic_and(mask, &a);
atomic_xor(mask, &a);
int old = atomic_fetch_or(mask, &a);
```

## Compare-and-swap (cmpxchg)

The most powerful atomic: atomically compare a value with expected, and swap if equal:

```c
/* Succeeds (returns old == expected) if *ptr == expected, sets *ptr = new */
old = atomic_cmpxchg(&a, expected, new);

/* Returns true if the swap happened */
bool success = atomic_try_cmpxchg(&a, &expected, new);
```

This is the building block for lock-free data structures. For example, a non-blocking push:

```c
struct node {
    struct node *next;
    int value;
};
static atomic_long_t head;  /* really: struct node __rcu *head */

void push(struct node *node)
{
    struct node *old_head;
    do {
        old_head = (struct node *)atomic_long_read(&head);
        node->next = old_head;
    } while (atomic_long_cmpxchg(&head,
                                  (long)old_head,
                                  (long)node) != (long)old_head);
}
```

## atomic_long_t

`atomic_long_t` is a pointer-sized atomic, useful for 64-bit values that need to fit in a pointer on all architectures:

```c
atomic_long_t v = ATOMIC_LONG_INIT(0);
atomic_long_read(&v);
atomic_long_set(&v, val);
atomic_long_add(n, &v);
atomic_long_cmpxchg(&v, old, new);
```

## READ_ONCE and WRITE_ONCE

Two CPUs accessing a variable simultaneously is undefined behavior in C. `READ_ONCE` and `WRITE_ONCE` prevent the compiler from:
- Tearing the access (splitting a word-sized read/write into multiple)
- Merging or reordering accesses
- Caching the value in a register across function calls

```c
/* Without READ_ONCE/WRITE_ONCE: compiler may cache, reorder, or tear */
while (flag) { ... }  /* compiler might load flag once and loop forever */

/* With READ_ONCE: fresh load every iteration */
while (READ_ONCE(flag)) { ... }

/* WRITE_ONCE: ensure the write is visible as a single operation */
WRITE_ONCE(flag, 0);
```

These are the minimum necessary for any shared variable access. They don't provide ordering guarantees between CPUs — that's what memory barriers are for.

## Memory barriers

Modern CPUs and compilers reorder memory accesses for performance. On a single CPU this is invisible, but between CPUs it can break synchronization.

There are three types of reordering to prevent:

```
Store-store: CPU may reorder two stores
Load-load:   CPU may reorder two loads
Store-load:  CPU may reorder a store followed by a load (most common)
```

### Barrier types

```c
/* Full barrier: no reordering across this point */
smp_mb();

/* Read barrier: no load reordering across this point */
smp_rmb();

/* Write barrier: no store reordering across this point */
smp_wmb();

/* Acquire: no loads/stores after this are moved before it */
smp_load_acquire(ptr);   /* load + acquire barrier */

/* Release: no loads/stores before this are moved after it */
smp_store_release(ptr, val);  /* release barrier + store */
```

### Acquire-Release pattern

The most common barrier pattern is acquire/release, used for passing data from producer to consumer:

```c
/* Producer */
data = compute_result();        /* (1) prepare data */
smp_store_release(&ready, 1);  /* (2) publish: data visible before ready=1 */

/* Consumer */
if (smp_load_acquire(&ready)) { /* (3) check: ready=1 before reading data */
    use(data);                   /* (4) data is guaranteed visible here */
}
```

The release barrier in (2) ensures (1) is ordered before (2). The acquire barrier in (3) ensures (3) is ordered before (4). Together they form a happens-before relationship.

### Atomic ordering variants

Atomic operations come in four ordering flavors:

```c
/* Relaxed: no ordering, just atomicity */
atomic_add_relaxed(1, &counter);

/* Acquire: loads after this see stores before the pairing release */
atomic_add_acquire(1, &counter);

/* Release: stores before this are visible before any pairing acquire */
atomic_add_release(1, &counter);

/* Full (default): both acquire and release semantics */
atomic_add(1, &counter);
```

Use relaxed for counters where you don't need ordering. Use acquire/release for producer-consumer synchronization. The defaults (`atomic_add`, etc.) are full barriers, which is safe but potentially slower than needed.

```c
/* Around non-atomic operations: ensure ordering with respect to atomics */
smp_mb__before_atomic();
/* non-atomic operations */
atomic_op();
/* non-atomic operations */
smp_mb__after_atomic();
```

## Common patterns

### Reference counting (atomic_t)

```c
/* Simpler than kref for simple cases */
static atomic_t refcount = ATOMIC_INIT(1);

void get(void) { atomic_inc(&refcount); }
void put(void) {
    if (atomic_dec_and_test(&refcount))
        free_object();
}
```

The kernel provides `kref` (kernel reference counting) that wraps atomic operations with cleaner semantics.

### Flags (atomic_t as bitfield)

```c
#define FLAG_BUSY    0
#define FLAG_READY   1

atomic_t flags = ATOMIC_INIT(0);

/* Set a flag */
atomic_or(BIT(FLAG_READY), &flags);

/* Test and clear atomically */
if (atomic_fetch_andnot(BIT(FLAG_BUSY), &flags) & BIT(FLAG_BUSY)) {
    /* was busy, now cleared */
}
```

For per-bit atomics, the kernel also provides `set_bit()`, `clear_bit()`, `test_and_set_bit()`, etc. on `unsigned long`.

## Further reading

- [Spinlock](spinlock.md) — Built on atomics and memory barriers
- [Per-CPU variables](percpu.md) — Avoiding atomics entirely for per-CPU data
- `Documentation/memory-barriers.txt` in the kernel tree — The definitive reference
- `Documentation/atomic_t.txt` — atomic_t semantics
