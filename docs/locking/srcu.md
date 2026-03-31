# SRCU: Sleepable RCU

> RCU for read-side critical sections that may block or sleep

## The problem with classic RCU

Classic RCU (`rcu_read_lock`) has one key constraint: **no sleeping**. The reader must stay in its critical section without blocking:

```c
rcu_read_lock();
p = rcu_dereference(global_ptr);
/* Must not sleep here! No mutex, no blocking I/O */
do_something(p);
rcu_read_unlock();
```

This rules out many use cases: VFS operations (may take a lock), I/O, memory allocation with GFP_KERNEL, or any operation that might schedule.

**SRCU** (Sleepable RCU) allows sleeping inside the read-side critical section. The trade-off: SRCU is more expensive than classic RCU (per-CPU counters instead of quiescent state detection).

## SRCU usage

```c
#include <linux/srcu.h>

/* Declare a per-module SRCU domain */
DEFINE_SRCU(my_srcu);
/* Or: */
struct srcu_struct my_srcu;
init_srcu_struct(&my_srcu);  /* dynamic initialization */

/* ---- Read side ---- */
int idx = srcu_read_lock(&my_srcu);
/* CAN sleep here (mutex, wait_event, etc.) */
p = srcu_dereference(global_ptr, &my_srcu);
mutex_lock(&p->lock);     /* ← this is fine in SRCU */
do_work(p);
mutex_unlock(&p->lock);
srcu_read_unlock(&my_srcu, idx);

/* ---- Update side ---- */
old = rcu_replace_pointer(global_ptr, new_ptr, 1);

/* Wait for all current readers to complete */
synchronize_srcu(&my_srcu);  /* may sleep (blocks) */
/* Safe to free old */
kfree(old);

/* Asynchronous: */
call_srcu(&my_srcu, &old->rcu, my_free_callback);
```

## struct srcu_struct

```c
/* include/linux/srcu.h */
struct srcu_struct {
    struct srcu_node    node[NUM_RCU_NODES];  /* expedited nodes */
    struct srcu_node   *level[RCU_NUM_LVLS + 1]; /* node levels */
    int                 srcu_size_state;       /* size of below */
    struct mutex        srcu_cb_mutex;         /* callback serialization */
    spinlock_t          lock;
    struct mutex        srcu_gp_mutex;
    unsigned int        srcu_idx;             /* current grace period idx */
    bool                srcu_gp_running;
    bool                srcu_gp_waiting;
    struct srcu_data __percpu *sda;           /* per-CPU counters */
    struct list_head    srcu_work_list;
    struct delayed_work work;                 /* periodic grace period check */
    struct lockdep_map  dep_map;
    unsigned long       srcu_gp_seq;          /* grace period sequence */
    unsigned long       srcu_gp_seq_needed;
    unsigned long       srcu_gp_seq_needed_exp;
};
```

### Per-CPU counters: the key difference

Classic RCU tracks quiescent states globally. SRCU uses per-CPU counters that readers increment/decrement:

```c
/* srcu_read_lock: */
int idx = srcu_read_lock(sp)
    → this_cpu_inc(sp->sda->srcu_lock_count[idx & 1])
    → return idx

/* srcu_read_unlock: */
srcu_read_unlock(sp, idx)
    → this_cpu_inc(sp->sda->srcu_unlock_count[idx & 1])
```

A grace period completes when `srcu_lock_count[old_idx] == srcu_unlock_count[old_idx]` across all CPUs — meaning all readers that started before the grace period have finished.

## Expedited SRCU

`synchronize_srcu_expedited()` shortens the grace period by actively polling CPUs:

```c
/* Faster than synchronize_srcu but more CPU intensive */
synchronize_srcu_expedited(&my_srcu);
```

Use for infrequent, latency-critical updates where waiting is unacceptable.

## SRCU vs classic RCU

| Feature | RCU | SRCU |
|---------|-----|------|
| Read-side overhead | barrier (near zero) | per-CPU counter increment |
| Sleep in read-side | No | Yes |
| Grace period | Async, natural quiescent states | Active polling of per-CPU counters |
| Multiple domains | One global | One per-domain (struct srcu_struct) |
| Typical use | Lock-free data structures | VFS, notifiers, module unload |
| `call_rcu` equivalent | Yes | `call_srcu` |

## Real-world uses of SRCU

**VFS path lookup**: The kernel uses SRCU for namespaces where locks might be needed during the read-side:

```c
/* fs/namespace.c */
/* SRCU for mount namespace protection */
DEFINE_STATIC_SRCU(mount_lock);

int path_mount(const char *dev_name, struct path *path, ...)
{
    int mnt_flags = 0;
    int retval;

    /* ... */
    retval = do_mount(dev_name, path->dentry, type_page, flags, data_page);
    /* ... */
}
```

**Notifier chains**: Many kernel notifier chains use SRCU to allow sleeping callbacks.

**Module unload**: SRCU allows holding a reference to a module while sleeping, preventing the module from being unloaded mid-operation.

## Observing SRCU

```bash
# SRCU grace period statistics
cat /sys/kernel/debug/rcu/rcudata

# Lockdep: SRCU annotations appear in lockdep output
# If a read-side critical section is too long:
dmesg | grep "SRCU stall"
# rcu: INFO: SRCU stall warning (5999ms)

# Force an SRCU stall (for testing, requires CONFIG_RCU_STALL_COMMON)
# echo 1 > /sys/kernel/debug/rcu/rcu_urgent_qs
```

## Further reading

- [RCU](rcu.md) — classic RCU for non-sleeping read-side
- [Mutex](mutex.md) — blocking mutual exclusion
- [Completions and Wait Queues](completions.md) — blocking synchronization primitives
- `kernel/rcu/srcutree.c` — SRCU implementation
- `Documentation/RCU/Design/` in the kernel tree
