# Lockdep: Lock Dependency Validator

> The kernel's runtime lock correctness checker

## What lockdep does

Lockdep is a kernel subsystem (enabled by `CONFIG_PROVE_LOCKING`) that tracks lock acquisition order at runtime and detects potential deadlocks before they actually happen. It catches:

- **Circular lock dependencies**: A → B → A (classic deadlock)
- **Lock inversion**: taking A then B in some code paths, B then A in others
- **Bad IRQ context**: sleeping lock taken in interrupt context
- **Recursive locking**: taking the same lock twice without releasing
- **Missing annotations**: lock ordering that depends on subclasses

Lockdep reports a "possible deadlock" the first time it sees a new lock ordering that could lead to deadlock — even if no actual deadlock has occurred yet. This is much better than waiting for a real deadlock to happen in production.

## Lock classes

Lockdep tracks **lock classes**, not individual lock instances. A class represents "all locks initialized with this key". For example, all `mutex` instances of type `struct inode->i_mutex` belong to the same class, even though there are millions of inodes.

```c
/* Each statically initialized lock gets its own class automatically */
DEFINE_MUTEX(my_mutex);  /* class key = address of my_mutex */

/* Dynamic locks: a static key must be provided */
struct my_struct {
    struct mutex lock;
};

void init_my_struct(struct my_struct *s)
{
    /* All my_struct::lock instances share one class key */
    static struct lock_class_key my_lock_key;
    mutex_init(&s->lock);
    /* Or with explicit class annotation: */
    lockdep_set_class(&s->lock, &my_lock_key);
}
```

## Dependency graph

Every time a lock is acquired while another lock is already held, lockdep adds an edge A → B to its directed graph. A circular dependency (A → B → A) means a potential deadlock.

```
Scenario:
  Thread 1: lock(A), lock(B)    → adds edge A→B
  Thread 2: lock(B), lock(A)    → adds edge B→A
                                 → CIRCULAR! lockdep reports a warning
```

The warning appears the moment Thread 2's pattern is first observed, even if Threads 1 and 2 never actually run concurrently.

## Reading a lockdep warning

```
======================================================
WARNING: possible circular locking dependency detected
6.5.0 #1 Not tainted
------------------------------------------------------
thread/1234 is trying to acquire lock:
ffffffff82345678 (&a_lock){+.+.}-{3:3}, at: func_a+0x12/0x34

but task is already holding:
ffffffff82345690 (&b_lock){+.+.}-{3:3}, at: func_b+0x56/0x78

which lock already depends on the new lock.

the existing dependency chain (in reverse order) is:
-> #1 (&b_lock){+.+.}-{3:3}:
       lock_acquire at kernel/locking/lockdep.c:5543
       _raw_spin_lock at kernel/locking/spinlock.c:151
       func_b+0x56/0x78
-> #0 (&a_lock){+.+.}-{3:3}:
       lock_acquire at kernel/locking/lockdep.c:5543
       _raw_spin_lock at kernel/locking/spinlock.c:151
       func_a+0x12/0x34
```

Key fields:
- The lock type annotation `{+.+.}` shows where it's used: `+` = used with IRQs enabled, `-` = used with IRQs disabled, `.` = not used in that context
- The dependency chain shows the exact call path that created the dependency

## Lock annotations

Lockdep provides annotations to use in your code:

```c
/* Assert that a lock is held (WARN if not) */
lockdep_assert_held(&my_mutex);

/* Assert held for read */
lockdep_assert_held_read(&my_rwsem);

/* Assert held for write */
lockdep_assert_held_write(&my_rwsem);

/* Assert that NO lock is held (for sleeping functions) */
might_sleep();    /* warns if in atomic context */

/* Mark code that must not sleep */
cant_sleep();

/* Mark that we're in RCU read-side critical section */
lockdep_assert_in_rcu_read_lock();
```

These are no-ops when lockdep is disabled (`CONFIG_PROVE_LOCKING=n`), so they're safe to leave in production code.

## Subclasses for nested locks

When you legitimately take two locks of the same class in order (e.g., locking a parent then a child in a tree traversal), lockdep needs a subclass annotation to understand this is intentional and not a deadlock:

```c
/* A tree where each node has its own lock of the same class */
struct tree_node {
    struct mutex lock;
    struct tree_node *child;
};

void lock_parent_then_child(struct tree_node *parent,
                             struct tree_node *child)
{
    /* Without subclass: lockdep would flag this as circular */
    mutex_lock(&parent->lock);
    mutex_lock_nested(&child->lock, 1);  /* subclass=1 = child level */
    /* ... */
    mutex_unlock(&child->lock);
    mutex_unlock(&parent->lock);
}
```

The `_nested` variants (`mutex_lock_nested`, `spin_lock_nested`, `down_read_nested`, etc.) take a subclass argument that lockdep uses to distinguish lock orderings at different tree depths.

## /proc/lockdep

When lockdep is active, it exposes its data:

```bash
# All known lock classes
cat /proc/lockdep

# Dependency graph
cat /proc/lockdep_chains

# Statistics (lock classes used, dependency chains, etc.)
cat /proc/lockdep_stats
# lock-classes: 2341
# direct dependencies: 8234
# indirect dependencies: 12456
# all direct dependencies: 23456
```

## Lock stats (/proc/lock_stat)

With `CONFIG_LOCK_STAT`, the kernel tracks contention per lock class:

```bash
cat /proc/lock_stat
# class name    con-bounces   contentions   waittime-min   waittime-max   waittime-total  acq-bounces   acquisitions  holdtime-min   holdtime-max   holdtime-total
# &mm->mmap_lock:
#                      5623        5623              0.26        1234.56       123456.78      234567         2345678          0.12         456.78       23456789.12
```

Columns:
- `contentions`: times the lock was already held when taken
- `waittime-*`: how long callers waited (microseconds)
- `acquisitions`: total lock acquisitions
- `holdtime-*`: how long the lock was held

High `contentions` and `waittime-max` indicate a lock hotspot.

## Performance impact

Lockdep is expensive — it keeps a complete dependency graph in memory and validates every lock acquisition. It's intended for development/testing kernels, not production:

- Memory: ~60MB for the lock class data structures
- CPU: each lock acquire/release goes through lockdep validation

For production, compile with `CONFIG_PROVE_LOCKING=n`. The `lockdep_assert_held()` annotations remain as no-ops.

## Further reading

- [Lock contention debugging](lock-debugging.md) — Using lock_stat and perf to find hotspots
- [Spinlock](spinlock.md) — What lockdep validates
- `Documentation/locking/lockdep-design.rst` — Lockdep internals
