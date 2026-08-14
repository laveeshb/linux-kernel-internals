# Kernel Live Patching (KLP)

> Applying security fixes and bug fixes to a running kernel without rebooting

## What KLP does

KLP redirects calls from the original (buggy) function to a replacement (patched) function at runtime, using ftrace's function entry hook:

```
Before patch:           After patch:
  caller                  caller
    │                       │
    call orig_func          call orig_func
                              │ (function entry hook)
                              └─► NEW: jump to patched_func
                                        │
                                        └─► executes patch
```

The original function's body is never rewritten and no jump is inserted into it. KLP reuses the ftrace call site the compiler already emitted at function entry (via `-mfentry`, or `-fpatchable-function-entry` on arm64), and `klp_ftrace_handler()` redirects execution by changing the saved instruction pointer, not by patching code.

## Architecture

```c
/* include/linux/livepatch.h */

/* Describes one patched function */
struct klp_func {
    /* external */
    const char       *old_name;     /* name of function to patch */
    void             *new_func;     /* replacement function */
    unsigned long     old_sympos;   /* which occurrence (for duplicates) */

    /* internal */
    void             *old_func;     /* resolved via kallsyms at patch time */
    struct kobject    kobj;
    struct list_head  node;         /* list node for klp_object->func_list */
    struct list_head  stack_node;   /* position in klp_ops->func_stack */
    unsigned long     old_size, new_size;  /* sizes of old/new function */
    bool              nop;          /* temporary patch to use the original code
                                       again; dynamically allocated by atomic
                                       replace (klp-cumulative.md) */
    bool              patched;      /* currently active */
    bool              transition;   /* in consistency transition */
};

/* A set of functions that form one complete patch */
struct klp_patch {
    /* external */
    struct module     *mod;         /* the live patch module */
    struct klp_object *objs;        /* array of objects (modules/vmlinux) */
    struct klp_state  *states;      /* system states the patch may modify (klp-state.md) */
    bool               replace;     /* atomic-replace: supersede other patches (klp-cumulative.md) */

    /* internal */
    struct list_head    list;
    struct kobject       kobj;
    struct list_head    obj_list;
    bool                 enabled;
    bool                 forced;    /* was involved in a forced transition —
                                        module can never be unloaded */
    struct work_struct   free_work;
    struct completion    finish;
};

/* Functions grouped by the kernel module (or vmlinux) they patch */
struct klp_object {
    /* external */
    const char           *name;      /* NULL for vmlinux */
    struct klp_func       *funcs;    /* array of functions to patch */
    struct klp_callbacks  callbacks; /* pre/post-(un)patch hooks */

    /* internal */
    struct kobject       kobj;
    struct list_head     func_list;  /* dynamic list of func entries */
    struct list_head     node;
    struct module        *mod;       /* resolved target module */
    bool                  dynamic;   /* for dynamically added funcs */
    bool                  patched;
};
```

## Writing a live patch module

```c
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/livepatch.h>

/*
 * The replacement function. Its prototype must match the original exactly:
 * include/linux/fs.h declares
 *   ssize_t vfs_read(struct file *, char __user *, size_t, loff_t *);
 * Getting this wrong is silent — .new_func is a void *, so a mismatched
 * return type (int here) would compile without a warning and truncate
 * every result the patched function hands back to its callers.
 */
static ssize_t patched_vfs_read(struct file *file, char __user *buf,
                                size_t count, loff_t *pos)
{
    /* New implementation with the bug fixed */
    if (!file || !file->f_op)
        return -EBADF;   /* was: NULL deref here */

    /*
     * ... rest of vfs_read()'s body, copied verbatim from fs/read_write.c,
     * elided here. KLP has no klp_call_orig(): there is no supported way to
     * chain back into the original function, so the patch module carries the
     * whole body and applies the fix inside its own copy.
     */
}

/* Patch descriptor */
static struct klp_func funcs[] = {
    {
        .old_name = "vfs_read",
        .new_func = patched_vfs_read,
    },
    {}  /* sentinel */
};

static struct klp_object objs[] = {
    {
        .name  = NULL,  /* NULL = patch vmlinux */
        .funcs = funcs,
    },
    {}  /* sentinel */
};

static struct klp_patch patch = {
    .mod  = THIS_MODULE,
    .objs = objs,
};

static int __init livepatch_init(void)
{
    return klp_enable_patch(&patch);
}

static void __exit livepatch_exit(void)
{
    /* KLP modules are sticky by default — can only unload after disabling */
}

module_init(livepatch_init);
module_exit(livepatch_exit);
MODULE_INFO(livepatch, "Y");
MODULE_LICENSE("GPL");
```

### Calling the original function

The KLP API does not provide a `klp_call_orig()` helper. A live patch replacement
must either fully re-implement the function or use `klp_shadow_*` to carry extra
state. If you need access to the original logic, copy it into the patch module and
apply only the targeted fix.

## ftrace-based redirection

KLP registers an `ftrace_ops` per patched function with `FTRACE_OPS_FL_IPMODIFY`
(permission to change the instruction pointer) and `klp_ftrace_handler()` redirects
execution to whichever patch is on top of the target function's `func_stack`:

```c
/* kernel/livepatch/patch.c */
static void notrace klp_ftrace_handler(unsigned long ip,
                                        unsigned long parent_ip,
                                        struct ftrace_ops *fops,
                                        struct ftrace_regs *fregs)
{
    struct klp_ops *ops;
    struct klp_func *func;
    int patch_state;
    int bit;

    ops = container_of(fops, struct klp_ops, fops);

    /* Recursion guard. It also disables preemption, which is required by
       kernel/livepatch/transition.c's klp_synchronize_transition() — a
       schedule_on_each_cpu()-based stand-in for synchronize_rcu(), used
       because livepatch must also patch functions where RCU isn't watching
       (e.g. before user_exit()), so it can't rely on RCU itself */
    bit = ftrace_test_recursion_trylock(ip, parent_ip);
    if (WARN_ON_ONCE(bit < 0))
        return;

    /* Top of func_stack is the most recently applied patch for this function */
    func = list_first_or_null_rcu(&ops->func_stack, struct klp_func, stack_node);
    if (WARN_ON_ONCE(!func))
        goto unlock;

    if (unlikely(func->transition)) {
        patch_state = current->patch_state;
        WARN_ON_ONCE(patch_state == KLP_TRANSITION_IDLE);

        if (patch_state == KLP_TRANSITION_UNPATCHED) {
            /*
             * This task hasn't transitioned yet. Fall back to the
             * next-oldest patch still on the stack (if any); with no
             * older patch, fall through to the original function.
             */
            func = list_entry_rcu(func->stack_node.next,
                                   struct klp_func, stack_node);
            if (&func->stack_node == &ops->func_stack)
                goto unlock;
        }
    }

    /* NOPs restore the original code — leave the instruction pointer alone */
    if (func->nop)
        goto unlock;

    ftrace_regs_set_instruction_pointer(fregs, (unsigned long)func->new_func);

unlock:
    ftrace_test_recursion_unlock(bit);
}
```

Because `func_stack` is a stack, this is also how patch **stacking** works: if
patch B is applied on top of patch A and a task hasn't transitioned to B yet,
the handler walks past B to A's version of the function rather than the
original — so already-patched behavior from A is preserved during B's
transition.

## The consistency model

KLP can't simply redirect calls immediately — a task might be in the middle of executing the old function. The **consistency model** ensures all tasks have transitioned before the patch is considered active:

```
State: KLP_TRANSITION_UNPATCHED → (patch applied) → KLP_TRANSITION_PATCHED

For each task:
  1. On return to userspace, klp_update_patch_state() marks it KLP_TRANSITION_PATCHED
  2. Tasks that stay in the kernel are switched by the ~1s transition workqueue's
     stack check, or by klp_sched_try_switch() in __schedule() — which only fires
     when the outgoing task is entering a freezable (TASK_FREEZABLE) sleep, not at
     every schedule point
  3. Until all tasks are KLP_TRANSITION_PATCHED, the patch is in "transition" state

During transition:
  - New task entries: use new (patched) function
  - Tasks already running in old function: continue until they return
  - Patch isn't "complete" until all tasks are transitioned
```

```bash
# Check transition status
cat /sys/kernel/livepatch/mypatch/transition
# 1 = still transitioning (some tasks not yet patched)
# 0 = complete

# Force completion (skips consistency check — may be unsafe!)
echo 1 > /sys/kernel/livepatch/mypatch/force
```

### Sleepy tasks

A task blocked in `D` state (`TASK_UNINTERRUPTIBLE`) inside the old function will delay the transition, and the livepatch core cannot shorten that wait: `klp_send_signals()` reaches only tasks in interruptible sleep (`wake_up_state(task, TASK_INTERRUPTIBLE)` for kthreads, `set_notify_signal()` — itself only a `TASK_INTERRUPTIBLE` wakeup — for user tasks). A D-state task has to leave that state on its own; the periodic workqueue just re-checks until it does. See [KLP Consistency Model](klp-consistency.md):

```bash
# If transition is stuck: find who's blocking it
cat /sys/kernel/livepatch/mypatch/transition
# 1

# Find tasks in the old function's call stack
ps aux | grep ' D '  # uninterruptible sleep tasks
cat /proc/<pid>/stack  # check if in the old function
```

## Shadow variables

Shadow variables attach extra data to existing kernel objects without modifying their structure — useful when a patch needs to add state:

```c
/* Add a "magic" field to struct file without changing the struct */
#define KLP_SHADOW_MAGIC 0xdeadbeef

struct my_shadow_data {
    u32 magic;
    int new_state;
};

/* On first use: allocate and attach shadow data */
struct my_shadow_data *data;
data = klp_shadow_get_or_alloc(file,  /* attached to this object */
                                 KLP_SHADOW_MAGIC,
                                 sizeof(*data), GFP_KERNEL,
                                 shadow_init_fn, NULL);
data->new_state = 42;

/* On subsequent uses: retrieve */
data = klp_shadow_get(file, KLP_SHADOW_MAGIC);

/* On cleanup (e.g., file close): free */
klp_shadow_free(file, KLP_SHADOW_MAGIC, NULL);
```

Shadow data is stored in a global hash table keyed by (object pointer, ID).

## Building a live patch

```bash
# Kernel build tree required
make -C /lib/modules/$(uname -r)/build M=$(pwd) modules

# Or: use kpatch-build (automated live patch creation)
kpatch-build -t vmlinux fix.patch

# Install
insmod mypatch.ko
lsmod | grep livepatch

# Verify active
cat /sys/kernel/livepatch/mypatch/enabled
# 1
```

## Observing live patches

```bash
# All active patches
for p in /sys/kernel/livepatch/*/; do
    echo "Patch: $(basename $p)"
    echo "  enabled: $(cat $p/enabled)"
    echo "  transition: $(cat $p/transition)"
done

# Which objects (vmlinux or a module) are patched
cat /sys/kernel/livepatch/*/*/patched
# Note: the per-function directory (<object>/<function,sympos>/) exists but
# currently exposes no attributes of its own.

# Kernel taint from live patch
cat /proc/sys/kernel/tainted
# bit 15 set (TAINT_LIVEPATCH: KLP patch applied)

# Verify with dmesg
dmesg | grep livepatch
# livepatch: enabling patch 'mypatch'
# livepatch: 'mypatch': starting patching transition
# livepatch: 'mypatch': patching complete
```

## Further reading

### Kernel source

- [include/linux/livepatch.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/livepatch.h) — `struct klp_func`, `struct klp_object`, `struct klp_patch`, and the `klp_shadow_*()` prototypes
- [kernel/livepatch/patch.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/patch.c) — `klp_ftrace_handler()`, the ftrace ops registration (`FTRACE_OPS_FL_IPMODIFY`), and the func-stack redirection logic
- [kernel/livepatch/transition.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/transition.c) — the consistency-model state machine, `klp_try_complete_transition()`, and `klp_send_signals()`
- [kernel/livepatch/shadow.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/shadow.c) — the shadow-variable hash table and the `klp_shadow_alloc()`/`klp_shadow_get()`/`klp_shadow_free()` implementation
- [samples/livepatch/livepatch-sample.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/samples/livepatch/livepatch-sample.c) — the canonical minimal live patch module (patches `cmdline_proc_show`)
- [Documentation/ABI/testing/sysfs-kernel-livepatch](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/ABI/testing/sysfs-kernel-livepatch) — the authoritative `/sys/kernel/livepatch/` attribute list (`enabled`, `transition`, `force`, `replace`, `stack_order`, and per-object `patched`)

### Related pages

- [KLP Consistency Model](klp-consistency.md) — deep dive on per-task patch state, stack checking, and the transition workqueue
- [Cumulative Patches and Atomic Replace](klp-cumulative.md) — patch stacking, `.replace`, and `struct klp_ops`
- [KLP State: Custom Consistency Checks](klp-state.md) — the `klp_state` API for consistency checks beyond stack scanning
- [kexec](kexec.md) — loading and booting a new kernel, the alternative to live patching for changes KLP can't express
- [Kernel Modules](../modules/module-basics.md) — KLP patches are distributed and loaded as regular kernel modules
- [Tracing: ftrace](../tracing/ftrace.md) — the function-entry hook mechanism KLP builds on

### LWN articles

- [Kernel Live Patching](https://lwn.net/Articles/619390/) — Seth Jennings' original 2014 writeup of the ftrace-based core: the pre-merge `lp_patch`-based design (renamed `klp_` before merge) and the original sysfs interface
- [livepatch: hybrid consistency model](https://lwn.net/Articles/685464/) — Josh Poimboeuf's 2016 series introducing per-task transitions, stack-reliability checking, and `TIF_PATCH_PENDING`
- [livepatch: introduce shadow variable API](https://lwn.net/Articles/731585/) — Joe Lawrence's 2017 patch introducing `klp_shadow_alloc()`/`klp_shadow_get()`/`klp_shadow_free()`

### External

- [Livepatch — The Linux Kernel documentation](https://docs.kernel.org/livepatch/livepatch.html) — official documentation: motivation, the consistency model, module life-cycle, and known limitations
- [Shadow Variables — The Linux Kernel documentation](https://docs.kernel.org/livepatch/shadow-vars.html) — official shadow-variable API reference and usage notes
