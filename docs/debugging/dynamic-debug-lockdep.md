# lockdep in Practice

> Lock dependency tracking: reading splats, annotating false positives, and hunting impossible deadlocks

## Why this page exists

`docs/locking/lockdep.md` covers lockdep fundamentals — what it is, how the dependency graph works, and lock classes. This page focuses on **practical debugging**: reading real splats, resolving false positives, writing correct annotations, and understanding lockdep's limits.

---

## Anatomy of a lockdep splat

When lockdep detects a potential deadlock, it prints a `WARNING: possible circular locking dependency detected` message. Here is a fully annotated example:

```
======================================================
WARNING: possible circular locking dependency detected
6.8.0-rc3 #1 Not tainted
------------------------------------------------------
kworker/u4:2/345 is trying to acquire lock:             ← (1) task + lock being acquired
ffff888100ab1230 (&sb->s_type->i_mutex_key#3){+.+.}-{3:3}, at: inode_lock+0x1d/0x30

but task is already holding:                            ← (2) lock(s) already held
ffff888100ab1278 (&ei->i_data_sem){++++}-{3:3}, at: ext4_write_begin+0x1f0/0x8c0

which lock already depends on the new lock.             ← (3) conflict detected

the existing dependency chain (in reverse order) is:   ← (4) the cycle
-> #1 (&ei->i_data_sem){++++}-{3:3}:
       lock_acquire+0xd8/0x390
       down_write+0x52/0x120
       ext4_write_begin+0x1f0/0x8c0
       generic_perform_write+0x10a/0x2a0

-> #0 (&sb->s_type->i_mutex_key#3){+.+.}-{3:3}:
       lock_acquire+0xd8/0x390
       down_write+0x52/0x120
       inode_lock+0x1d/0x30
       do_truncate+0x91/0x160

other info that might help us debug this:              ← (5) "who else holds what"
 Possible unsafe locking scenario:
   CPU0                        CPU1
   ----                        ----
   lock(&ei->i_data_sem);
                               lock(&sb->s_type->i_mutex_key#3);
                               lock(&ei->i_data_sem);
   lock(&sb->s_type->i_mutex_key#3);
   *** DEADLOCK ***
```

**The four parts:**

1. **Task + what it's trying to acquire** — the task name, PID, and the lock address + class name + annotation + the call site
2. **Lock(s) currently held** — the chain of locks this task already holds (could be multiple)
3. **Conflict statement** — lockdep says this new acquisition would create a cycle
4. **Dependency chain in reverse** — `#1` is the first lock in the cycle, `#0` is the one being acquired; together they show the circular path
5. **CPU0/CPU1 scenario** — lockdep spells out the exact interleaving that would deadlock

---

## Lock annotations in the splat

Each lock in the splat is annotated with `{+.+.}-{3:3}`:

```
{+.+.}  = usage in 4 contexts (hardirq-on, hardirq-off, softirq-on, softirq-off)
           + = used in this context
           . = not used in this context
           - = used with IRQs disabled in this context

-{3:3}  = lock depth class: 3 = mutex (not spinlock, not rwsem read-side)
           format is {hard-depth:soft-depth}
```

Common annotations:
- `{+.+.}` — mutex taken in process context with IRQs enabled
- `{-.-.}` — spinlock taken with IRQs disabled
- `{++++}` — rwsem taken in all four contexts (e.g., i_data_sem)

---

## Lock classes and `lock_class_key`

Lockdep tracks **classes**, not instances. Every lock instance of the same type shares a class and lockdep only tracks edges between classes.

```c
/* A static lock gets its class key from the lock's own address: */
static DEFINE_SPINLOCK(my_lock);
/* → class key = &my_lock, class name = "my_lock" */

/* A dynamically allocated lock: ALL instances share ONE class key */
struct my_obj {
    spinlock_t lock;
};

void init_my_obj(struct my_obj *obj)
{
    spin_lock_init(&obj->lock);
    /* All obj->lock instances share a single class, identified by
       the static __key embedded in spin_lock_init() via macro expansion */
}
```

The class key is a `struct lock_class_key` that lives in the kernel's `.data` section. It is generated automatically by `spin_lock_init()`, `mutex_init()`, etc., via the macro:

```c
/* include/linux/spinlock.h (simplified): */
#define spin_lock_init(lock)                        \
do {                                                \
    static struct lock_class_key __key;             \
    __spin_lock_init(lock, #lock, &__key);          \
} while (0)
```

That `static struct lock_class_key __key` is the class key — one per call-site in source code, not per instance.

---

## Splitting classes to resolve false positives

Sometimes lockdep reports a false positive because two instances of the same lock type have legitimately different valid orderings. The classic example is **nested directory locks** in a filesystem:

```
Thread 1: rename(parent_dir/a → parent_dir/b)
  → lock(parent_inode), then lock(child_inode_a), lock(child_inode_b)

Thread 2: rename(child_dir/x → parent_dir/y)
  → lock(child_inode_x), then lock(parent_inode)
```

Lockdep sees: `i_mutex` → `i_mutex` in one order and `i_mutex` → `i_mutex` in the reverse order — a false positive, because the "parent always before child" invariant is safe.

**Solution 1: `lockdep_set_subclass()`**

```c
/* Tell lockdep this lock instance is subclass N (0 = default): */
lockdep_set_subclass(&inode->i_rwsem, I_MUTEX_PARENT);   /* subclass 0 */
lockdep_set_subclass(&inode->i_rwsem, I_MUTEX_CHILD);    /* subclass 1 */

/* Lockdep now allows PARENT→CHILD but reports CHILD→PARENT */
/* Subclasses are defined in include/linux/fs.h: */
enum {
    I_MUTEX_NORMAL,
    I_MUTEX_PARENT,
    I_MUTEX_CHILD,
    I_MUTEX_XATTR,
    I_MUTEX_NONDIR2,
    /* ... */
};
```

**Solution 2: `lockdep_init_map()` with a separate key**

```c
static struct lock_class_key dir_lock_key;
static struct lock_class_key file_lock_key;

void init_inode(struct inode *inode, bool is_dir)
{
    struct lock_class_key *key = is_dir ? &dir_lock_key : &file_lock_key;
    lockdep_init_map(&inode->i_rwsem.dep_map, "i_rwsem", key, 0);
}
/* Now directories and files have separate lock classes */
```

`lockdep_set_subclass()` is preferred when there is a clear nesting level (parent/child). Separate keys are used when two groups of locks have completely independent ordering requirements.

---

## Runtime assertions

### `lockdep_assert_held()`

Assert that the current task holds a specific lock. Use this at the top of functions that require a lock to be held by the caller:

```c
/* fs/inode.c */
void inode_set_flags(struct inode *inode, unsigned int flags,
                     unsigned int mask)
{
    lockdep_assert_held(&inode->i_lock);   /* caller must hold i_lock */
    /* ... modify inode flags ... */
}
```

If the assertion fails (lock is not held), lockdep prints a `WARNING` and a stack trace. With `CONFIG_PROVE_LOCKING=n`, the macro compiles away.

### `lockdep_assert_not_held()`

Assert a lock is **not** held. Used for functions that cannot be called under a specific lock:

```c
/* Cannot be called while holding the mm semaphore — would deadlock
   because this function may try to acquire it internally: */
void some_mm_operation(struct mm_struct *mm)
{
    lockdep_assert_not_held(&mm->mmap_lock);
    /* ... */
}
```

### `lockdep_assert_held_write()` / `lockdep_assert_held_read()`

For rwsems, assert the specific lock mode:

```c
void vma_adjust(struct vm_area_struct *vma, ...)
{
    lockdep_assert_held_write(&vma->vm_mm->mmap_lock);
    /* write lock required */
}
```

---

## Implementing custom primitives with lockdep

If you write a custom locking primitive (e.g., a lock-free structure with manual memory ordering, or a per-object lock that wraps something else), you can make it visible to lockdep:

```c
struct my_lock {
    atomic_t state;
    struct lockdep_map dep_map;   /* embed lockdep metadata */
};

static struct lock_class_key my_lock_key;

void my_lock_init(struct my_lock *l, const char *name)
{
    atomic_set(&l->state, 0);
    lockdep_init_map(&l->dep_map, name, &my_lock_key, 0);
}

void my_lock_acquire(struct my_lock *l)
{
    /* Tell lockdep: exclusive acquire, not nested, return address */
    lock_acquire(&l->dep_map, 0, 0, 0, 1, NULL, _RET_IP_);

    /* ... actual acquire logic ... */
    while (atomic_cmpxchg(&l->state, 0, 1) != 0)
        cpu_relax();
}

void my_lock_release(struct my_lock *l)
{
    atomic_set(&l->state, 0);
    lock_release(&l->dep_map, _RET_IP_);
}
```

`lock_acquire()` and `lock_release()` are the lockdep hooks that `spin_lock()` etc. invoke internally (in `kernel/locking/lockdep.c`). Using them directly integrates your primitive into the dependency graph.

---

## Suppressing false positives (use sparingly)

### `lockdep_set_novalidate_class()`

Mark a lock class as exempt from validation. **Avoid unless absolutely necessary** — it hides real bugs along with false positives:

```c
lockdep_set_novalidate_class(&my_lock);
```

### `lockdep_off()` / `lockdep_on()`

Temporarily suspend lockdep for a code region that legitimately violates ordering (e.g., a self-test that deliberately creates a cycle):

```c
lockdep_off();
/* code that would trigger false lockdep warnings */
lockdep_on();
```

These are process-local (they adjust a per-task counter). Do not use them to paper over real locking bugs.

---

## Configuration

```bash
CONFIG_PROVE_LOCKING=y          # enables lockdep (required)
CONFIG_DEBUG_LOCK_ALLOC=y       # detect use of uninitialized locks
CONFIG_LOCKDEP=y                # pulled in by PROVE_LOCKING
CONFIG_DEBUG_LOCKDEP=y          # extra lockdep self-checks (very slow)
CONFIG_LOCK_STAT=y              # enables /proc/lock_stat
```

---

## Lockdep limits

Lockdep maintains a compile-time-bounded data structure. `MAX_LOCKDEP_KEYS` is a fixed cap; the others are Kconfig-tunable (`CONFIG_LOCKDEP_BITS`, `CONFIG_LOCKDEP_CHAINS_BITS`, `CONFIG_LOCKDEP_STACK_TRACE_BITS`), each defaulting to the value shown below (`MAX_STACK_TRACE_ENTRIES` defaults higher, to 2M, under `CONFIG_KASAN`):

```c
/* include/linux/lockdep_types.h, kernel/locking/lockdep_internals.h */
#define MAX_LOCKDEP_KEYS        8192   /* max lock classes (fixed) */
#define MAX_LOCKDEP_ENTRIES     (1UL << CONFIG_LOCKDEP_BITS)         /* default 32768 */
#define MAX_LOCKDEP_CHAINS      (1UL << CONFIG_LOCKDEP_CHAINS_BITS)  /* default 65536 */
#define MAX_STACK_TRACE_ENTRIES (1UL << CONFIG_LOCKDEP_STACK_TRACE_BITS)  /* default 524288 */
```

Once the tables are full, new lock classes are silently dropped — lockdep stops tracking them. Check usage at runtime:

```bash
cat /proc/lockdep_stats
```

```
lock-classes:                          3456 [max: 8192]
direct dependencies:                  12345 [max: 32768]
indirect dependencies:                56789
all direct dependencies:              23456
dependency chains:                     8901 [max: 65536]
stack-trace entries:                 234567 [max: 524288]
```

If `lock-classes` is near the maximum, consider booting with a config that has fewer drivers, or increase `MAX_LOCKDEP_KEYS` in the source.

---

## Lock contention statistics

`CONFIG_LOCK_STAT=y` enables per-lock contention counters. Enable at runtime:

```bash
echo 1 > /proc/sys/kernel/lock_stat
```

Read statistics:

```bash
cat /proc/lock_stat
```

```
lock_stat version 0.4
---------------------------------------------------------------
                              class name    con-bounces    contentions   waittime-min   waittime-max waittime-total   acq-bounces   acquisitions   holdtime-min   holdtime-max holdtime-total
---------------------------------------------------------------
                        &sb->s_type->i_mutex_key#3:            0             23           0.27          143.50        1423.10           5432        1234567          0.10           5.30        8901.20
```

Key columns:
- **con-bounces** — lock was contended and the CPU changed hands between acquire and release
- **contentions** — total number of times a task had to wait for this lock
- **waittime-min/max/total** — time spent waiting (microseconds)
- **acq-bounces** — lock acquired but holder migrated to another CPU before releasing
- **acquisitions** — total successful acquires

Reset statistics:

```bash
echo 0 > /proc/lock_stat
```

High `contentions` on a specific lock class points to a bottleneck. High `waittime-max` indicates rare but very long stalls (often from priority inversion or a long critical section).

---

## Workflow: debugging a lockdep splat

```bash
# 1. Capture the full splat (it can be long):
dmesg | grep -A 80 "possible circular locking"

# 2. Identify the two lock classes in the cycle:
#    Look for "-> #1" and "-> #0" in the chain

# 3. Find where each lock is acquired:
#    Each chain entry has a call stack — use addr2line:
./scripts/faddr2line vmlinux ext4_write_begin+0x1f0/0x8c0

# 4. Draw the dependency graph on paper:
#    Class A → Class B (acquired in this order somewhere)
#    Class B → Class A (acquired in this order somewhere else)
#    Find the inversion point

# 5. Fix options:
#    a. Reorder acquisitions to be consistent everywhere
#    b. Drop one lock before acquiring the other (if safe)
#    c. Use trylock + retry loop to avoid blocking
#    d. Split the class with lockdep_set_subclass() (if false positive)
#    e. Use lockdep_assert_held() to enforce correct call ordering

# 6. Verify: rebuild and boot; the splat should not reappear
#    (lockdep prints each unique cycle at most once per boot)
```

---

## Further reading

### Kernel source

- [kernel/locking/lockdep.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/locking/lockdep.c) — the validator implementation; `lock_acquire()` and `lock_release()` are the hooks that `spin_lock()`/`mutex_lock()` and friends call internally
- [kernel/locking/lockdep_internals.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/locking/lockdep_internals.h) — `MAX_LOCKDEP_ENTRIES`, `MAX_LOCKDEP_CHAINS`, `MAX_STACK_TRACE_ENTRIES`; on current kernels these are derived from the `CONFIG_LOCKDEP_BITS`/`CONFIG_LOCKDEP_CHAINS_BITS`/`CONFIG_LOCKDEP_STACK_TRACE_BITS` Kconfig options rather than fixed at compile time
- [include/linux/lockdep_types.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/lockdep_types.h) — `MAX_LOCKDEP_KEYS_BITS`/`MAX_LOCKDEP_KEYS`, the fixed cap on lock classes
- [kernel/locking/lockdep_proc.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/locking/lockdep_proc.c) — `/proc/lockdep_stats` and `/proc/lock_stat` output formatting (`lock-classes`, `con-bounces`, `contentions`, `waittime-min`, etc.)
- [include/linux/fs.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/fs.h) — the `I_MUTEX_NORMAL`/`I_MUTEX_PARENT`/`I_MUTEX_CHILD`/`I_MUTEX_XATTR`/`I_MUTEX_NONDIR2` subclass enum used with `lockdep_set_subclass()`
- [include/linux/spinlock.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/spinlock.h) — `spin_lock_init()`, which allocates the per-call-site `lock_class_key`
- [scripts/faddr2line](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/faddr2line) — resolves `func+0x123/0x456`-style offsets from a splat back to source lines
- [Documentation/locking/lockdep-design.rst](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/locking/lockdep-design.rst) — lockdep's own design document
- [Documentation/locking/lockstat.rst](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/locking/lockstat.rst) — `/proc/lock_stat` design document

### Related pages

- [Lockdep fundamentals](../locking/lockdep.md) — dependency graph, lock classes, basic splat reading
- [Lock Contention Debugging](../locking/lock-debugging.md) — `/proc/lock_stat`, perf lock
- [KASAN and KFENCE](kasan-kfence.md) — complementary memory error detectors
- [KCSAN](kcsan.md) — data race detection

### LWN articles

- [Enhancing lockdep with crossrelease](https://lwn.net/Articles/709849/) — Byungchul Park lays out lockdep's dependency-graph fundamentals (lock classes, cycle detection) before proposing the crossrelease extension (December 2016)
- [The dependency tracker for complex deadlock detection](https://lwn.net/Articles/1036222/) — Jonathan Corbet on DEPT, a proposed lockdep alternative; explains what lockdep does and does not catch (September 2025)

### External

- [docs.kernel.org: Runtime locking correctness validator](https://docs.kernel.org/locking/lockdep-design.html) — rendered version of lockdep-design.rst
- [docs.kernel.org: Lock Statistics](https://docs.kernel.org/locking/lockstat.html) — rendered version of lockstat.rst
