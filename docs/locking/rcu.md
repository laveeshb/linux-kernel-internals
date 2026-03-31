# RCU (Read-Copy-Update)

> Lock-free reads through grace periods — the highest-performance synchronization in the kernel

## The core idea

RCU was added to Linux in kernel 2.5.43 (October 2002) by Dipankar Sarma (IBM) and Paul E. McKenney — confirmed in ["What is RCU, Fundamentally?"](https://lwn.net/Articles/262464/) (McKenney & Walpole, LWN 2007): *"RCU added to the Linux kernel in October 2002."*

RCU solves a specific problem: how do you allow many readers to access a data structure with zero synchronization overhead, while still allowing writers to modify it safely?

The insight: **readers never modify the data**, so they can run truly concurrently as long as the writer doesn't free the old data until all readers that could see it have finished.

```
Writer algorithm:
  1. Make a copy of the data
  2. Modify the copy
  3. Atomically publish the new version (pointer swap)
  4. Wait for a "grace period" — until all readers that could
     have seen the old version have finished
  5. Free the old version

Reader algorithm:
  1. Enter RCU read-side critical section (very cheap)
  2. Dereference the published pointer
  3. Use the data
  4. Exit RCU read-side critical section
```

The critical property: **readers pay almost nothing**. On non-preemptible kernels, `rcu_read_lock()` is literally a compiler barrier with preemption disabled — no atomic operations, no cache line bouncing.

## The grace period

A **grace period** is the time the writer waits after publishing the new pointer before freeing the old one. A grace period ends when every CPU has passed through a **quiescent state** — a point where no RCU read-side critical section can be in progress.

Quiescent states include:
- Context switch (the CPU was preempted)
- Idle (the CPU has no work)
- User mode execution

```
CPU 0: [reader using old data]──────────────────[end read]
CPU 1:                         [context switch]
CPU 2:                                    [context switch]
                         ↑                           ↑
                   grace period starts          grace period ends
                                                (old data safe to free)
```

On a non-preemptible kernel, a grace period completes when every CPU has scheduled at least once. This is why context switches are RCU quiescent states.

## API

```c
#include <linux/rcupdate.h>

/* Read side: enter/exit critical section */
rcu_read_lock();
/* Access RCU-protected data. May NOT sleep (on !PREEMPT_RCU). */
rcu_read_unlock();

/* Read a pointer protected by RCU */
struct my_data *p = rcu_dereference(rcu_ptr);
/* rcu_dereference adds a data-dependency barrier — required! */

/* Publish a new pointer (issues memory barrier before assignment) */
rcu_assign_pointer(rcu_ptr, new_data);

/* Wait for grace period to complete (blocking) */
synchronize_rcu();

/* Schedule callback for after grace period (non-blocking) */
call_rcu(&old_data->rcu_head, my_free_callback);

/* In the callback: */
static void my_free_callback(struct rcu_head *head)
{
    struct my_data *data = container_of(head, struct my_data, rcu_head);
    kfree(data);
}
```

### Embedding rcu_head

Any object freed via RCU must embed `struct rcu_head`:

```c
struct my_data {
    int value;
    char name[32];
    struct rcu_head rcu;  /* for call_rcu / kfree_rcu */
};

/* Allocate and publish */
struct my_data *new_data = kmalloc(sizeof(*new_data), GFP_KERNEL);
new_data->value = 42;
rcu_assign_pointer(global_ptr, new_data);

/* Remove and free (writer side) */
struct my_data *old = rcu_dereference_protected(global_ptr,
                                                 lockdep_is_held(&my_lock));
rcu_assign_pointer(global_ptr, NULL);
synchronize_rcu();
kfree(old);

/* Or with call_rcu (async) */
call_rcu(&old->rcu, my_free_callback);
```

### kfree_rcu shorthand

For objects that just need `kfree()` after a grace period, `kfree_rcu()` is a shorthand that avoids writing a callback:

```c
/* Instead of call_rcu + callback that calls kfree: */
kfree_rcu(old_data, rcu);  /* 'rcu' is the rcu_head field name */

/* Zero-argument form (Linux 5.9+): no rcu_head needed */
kfree_rcu(old_data);
```

## A complete example: RCU-protected lookup table

```c
/* Global pointer, updated rarely */
static struct config __rcu *global_config;
static DEFINE_SPINLOCK(config_lock);  /* protects writers */

/* Reader: called frequently, must be fast */
int get_timeout(void)
{
    int timeout;
    rcu_read_lock();
    timeout = rcu_dereference(global_config)->timeout;
    rcu_read_unlock();
    return timeout;
}

/* Writer: called rarely */
int update_config(int new_timeout)
{
    struct config *new_cfg, *old_cfg;

    new_cfg = kmalloc(sizeof(*new_cfg), GFP_KERNEL);
    if (!new_cfg)
        return -ENOMEM;

    spin_lock(&config_lock);
    old_cfg = rcu_dereference_protected(global_config,
                                         lockdep_is_held(&config_lock));
    new_cfg->timeout = new_timeout;
    rcu_assign_pointer(global_config, new_cfg);
    spin_unlock(&config_lock);

    /* Wait until no reader can see old_cfg, then free it */
    synchronize_rcu();
    kfree(old_cfg);
    return 0;
}
```

## RCU-protected lists

The kernel provides `rculist.h` for linked lists:

```c
#include <linux/rculist.h>

/* Writer: add to list (must hold list lock) */
spin_lock(&list_lock);
list_add_rcu(&new->list, &my_list);
spin_unlock(&list_lock);

/* Writer: remove from list */
spin_lock(&list_lock);
list_del_rcu(&entry->list);
spin_unlock(&list_lock);
synchronize_rcu();  /* wait before freeing */
kfree(entry);

/* Reader: traverse list */
rcu_read_lock();
list_for_each_entry_rcu(entry, &my_list, list) {
    /* use entry */
}
rcu_read_unlock();
```

## RCU flavors

There are three main RCU flavors for different contexts:

| Flavor | Read-side lock | Quiescent state | Use when |
|--------|---------------|-----------------|----------|
| `rcu` | `rcu_read_lock()` | context switch, idle, user mode | Most kernel code |
| `rcu_bh` | `rcu_read_lock_bh()` | any BH-disabled region | Legacy, BH context |
| `rcu_sched` | `rcu_read_lock_sched()` | preemption-disabled region | Scheduler internals |

Since Linux 5.0, all three are unified — `synchronize_rcu()` waits for all three simultaneously.

## SRCU: sleepable RCU

Standard RCU read-side critical sections cannot sleep. SRCU (Sleepable RCU) lifts this restriction at the cost of higher read-side overhead:

```c
#include <linux/srcu.h>

DEFINE_SRCU(my_srcu);  /* or DEFINE_STATIC_SRCU */

/* Reader (may sleep) */
int idx = srcu_read_lock(&my_srcu);
/* ... may call schedule() here ... */
srcu_read_unlock(&my_srcu, idx);

/* Writer */
synchronize_srcu(&my_srcu);
```

SRCU is used where readers need to sleep, such as notifier chains, filesystem operations, and BPF program invocation.

## When to use RCU

```
RCU is ideal when:
  ✓ Reads are much more frequent than writes
  ✓ Read-side performance is critical (no atomic ops in read path)
  ✓ The data is accessed via pointers
  ✓ Writers can tolerate the cost of synchronize_rcu() or call_rcu()

RCU is not suited for:
  ✗ Write-heavy workloads (synchronize_rcu is expensive)
  ✗ Data updated in-place (not pointer-based)
  ✗ Small per-CPU data (use per-CPU variables instead)
```

## Tree RCU: grace period detection mechanism

`synchronize_rcu()` on a real system can't simply "wait for every CPU to context switch" — it would block the caller indefinitely on a loaded system. Tree RCU solves this with an efficient hierarchical algorithm:

```
Tree RCU node hierarchy (for 16 CPUs, FANOUT=8):
          [root rcu_node]
         /               \
   [node 0-7]         [node 8-15]
   /  |  |  \  \       ...
 CPU0 CPU1 ... CPU7

Each node tracks:
  qsmask:   bitmask of children that haven't reported QS yet
  qsmaskinit: initial value at grace period start
```

### Grace period phases

```c
/* kernel/rcu/tree.c */

/* Phase 1: RCU GP kthread starts a new grace period */
static void rcu_gp_init(void)
{
    /* Set qsmaskinit for all nodes based on online CPUs */
    /* Bump GP sequence number, wake CPUs to report quiescent state */
}

/* Phase 2: Each CPU reports its quiescent state */
/* On context switch: */
void rcu_note_context_switch(bool preempt)
{
    /* Report quiescent state to parent node */
    rcu_qs();
}

/* Phase 3: When all bits in root qsmask are clear, GP ends */
static void rcu_gp_cleanup(void)
{
    /* Invoke all callbacks registered via call_rcu() */
    /* Advance the grace period sequence counter */
    rcu_advance_cbs(rdp);
}
```

### Expedited grace periods

`synchronize_rcu_expedited()` forces a fast grace period by sending IPIs to all CPUs to make them immediately report a quiescent state:

```c
/* Completes in ~100µs vs ~10ms for normal GP */
synchronize_rcu_expedited();
/* Use sparingly: IPI storm overhead, hurts real-time latency */

/* The kernel automatically switches between:
   - Normal GP: low overhead, used when no one is waiting urgently
   - Expedited GP: after a threshold of synchronize_rcu() callers queue up */
```

### TASKS RCU

For "tasks" (non-atomic, can-sleep contexts), Tasks RCU tracks quiescent states differently:

```c
/* Tasks RCU: used for BPF program updates, trampoline code patching */
synchronize_rcu_tasks();   /* wait until no task is in old trampolines */
call_rcu_tasks(&rcu_head, callback);

/* Quiescent state for tasks RCU: voluntary scheduling (cond_resched) */
/* Used by: BPF, ftrace, live patching */
```

## RCU torture testing

The kernel includes an extensive RCU stress test:

```bash
# Load rcutorture module to stress-test RCU:
modprobe rcutorture

# Watch results:
dmesg | grep -E "rcu_torture|Readers Stall"
# rcu_torture: Readers stall PASSED: n=0
# rcu_torture: 0 expedited-grace-period failures

# rcuscale: performance measurement (renamed from rcuperf in Linux 5.10 — 4e88ec4a9eb1)
modprobe rcuscale perf_type="rcu"
dmesg | grep "rcuscale"
```

## RCU in the kernel: key usage sites

```c
/* Routing table lookup (hot path): */
rcu_read_lock();
rt = rcu_dereference(dev->ip_ptr->rt_cache);  /* no lock needed */
/* ... use rt ... */
rcu_read_unlock();

/* Network interface list: */
rcu_read_lock();
list_for_each_entry_rcu(dev, &net->dev_base_head, dev_list) {
    if (dev->flags & IFF_UP)
        do_something(dev);
}
rcu_read_unlock();

/* Process credentials (very hot path): */
rcu_read_lock();
uid = rcu_dereference(current->cred)->uid;
rcu_read_unlock();
/* Or the optimized helper: */
uid = current_uid();  /* uses rcu_read_lock internally */
```

## Debugging RCU

```bash
# Check for RCU stalls (CPUs stuck in read-side critical section):
# Kernel detects and prints: "INFO: rcu_sched detected stalls on CPUs/tasks"
dmesg | grep "rcu.*stall"

# Lockdep checks for misuse:
# rcu_read_lock() annotates the task; lockdep warns if you sleep

# CONFIG_PROVE_RCU=y: enables lockdep-style RCU correctness checking
# Warns about: rcu_dereference() outside rcu_read_lock, sleeping in read-side

# rcustat BPF tool:
bpftrace -e '
kprobe:synchronize_rcu { @[kstack] = count(); }' &
# Shows who is calling synchronize_rcu (the expensive operation)
```

## Further reading

- [RCU in Memory Management](../mm/rcu-mm.md) — How RCU is used in the mm subsystem
- [Spinlock](spinlock.md) — For write-heavy short critical sections
- [rwsem](rwlock-rwsem.md) — For sleeping reader-writer locking
- [SRCU](srcu.md) — Sleepable RCU for contexts that need to sleep
- `Documentation/RCU/` in the kernel tree — Paul McKenney's extensive RCU docs
- `kernel/rcu/tree.c` — Tree RCU implementation
- `kernel/rcu/tasks.h` — Tasks RCU
