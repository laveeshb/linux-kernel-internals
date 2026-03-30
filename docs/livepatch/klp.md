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

The original function's first bytes are never modified. The ftrace hook at function entry branches to the replacement.

## Architecture

```c
/* include/linux/livepatch.h */

/* Describes one patched function */
struct klp_func {
    const char      *old_name;      /* name of function to patch */
    void            *new_func;      /* replacement function */
    unsigned long    old_sympos;    /* which occurrence (for duplicates) */
    unsigned long    old_addr;      /* resolved at patch time */
    struct kobject   kobj;
    struct list_head node;
    struct ftrace_ops fops;          /* ftrace hook for this function */
    bool             nops;          /* no-op patch (for rollback testing) */
    bool             patched;       /* currently active */
    bool             transition;    /* in consistency transition */
};

/* A set of functions that form one complete patch */
struct klp_patch {
    struct module   *mod;           /* the live patch module */
    struct klp_object *objs;        /* array of objects (modules/vmlinux) */
    bool             enabled;
    bool             forced;        /* forced (skipped consistency check) */
    struct work_struct free_work;
    struct completion finish;
    struct kobject   kobj;
    struct list_head list;
};

/* Functions grouped by the kernel module (or vmlinux) they patch */
struct klp_object {
    const char      *name;          /* NULL for vmlinux */
    struct klp_func *funcs;         /* array of functions to patch */
    struct module   *mod;           /* resolved target module */
    struct kobject   kobj;
    struct list_head node;
    bool             dynamic;       /* for dynamically added funcs */
};
```

## Writing a live patch module

```c
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/livepatch.h>

/* The replacement function */
static int patched_vfs_read(struct file *file, char __user *buf,
                             size_t count, loff_t *pos)
{
    /* New implementation with the bug fixed */
    if (!file || !file->f_op)
        return -EBADF;   /* was: NULL deref here */

    /* Call the original after our check */
    return klp_call_orig(file, buf, count, pos);
    /* Or: re-implement entirely */
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

```c
/* klp_call_orig() works only when called from a live-patched function */
/* It calls the unpatched version of the function */
static int my_patched_func(...)
{
    /* Do pre-processing */
    preprocess(args);

    /* Call original */
    int ret = klp_call_orig(args);

    /* Do post-processing */
    postprocess(ret);
    return ret;
}
```

## ftrace-based redirection

KLP uses ftrace's `FTRACE_OPS_FL_SAVE_REGS` to redirect function calls:

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

    ops = container_of(fops, struct klp_ops, fops);

    /* Find the active patch for this function */
    func = list_first_or_null_rcu(&ops->func_stack, struct klp_func, stack_node);
    if (!func)
        return;

    /* Check consistency: is this task in a safe state? */
    patch_state = current->patch_state;
    if (patch_state == KLP_UNDEFINED)
        patch_state = current->patch_state = KLP_UNPATCHED;

    if (func->transition) {
        if (patch_state == KLP_UNPATCHED)
            return;  /* task not yet transitioned */
    }

    /* Redirect: change IP to point to patched function */
    klp_arch_set_pc(fregs, (unsigned long)func->new_func);
}
```

## The consistency model

KLP can't simply redirect calls immediately — a task might be in the middle of executing the old function. The **consistency model** ensures all tasks have transitioned before the patch is considered active:

```
State: KLP_UNPATCHED → (patch applied) → KLP_PATCHED

For each task:
  1. When task returns to userspace (schedule point), mark as KLP_PATCHED
  2. Tasks already in kernel get KLP_PATCHED at their next schedule
  3. Until all tasks are KLP_PATCHED, the patch is in "transition" state

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

A task blocked in `D` state (uninterruptible sleep) inside the old function will delay the transition. The kernel waits (with periodic wakeup attempts via `kick_all_cpus_sync()`):

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

# Which functions are patched
cat /sys/kernel/livepatch/*/objs/*/funcs/*/patched
cat /sys/kernel/livepatch/*/objs/*/funcs/*/old_addr

# Kernel taint from live patch
cat /proc/sys/kernel/tainted
# bit 11 set (KLP patch applied)

# Verify with dmesg
dmesg | grep livepatch
# livepatch: enabling patch 'mypatch'
# livepatch: 'mypatch': starting patching transition
# livepatch: 'mypatch': patching complete
```

## Further reading

- [kexec](kexec.md) — loading and booting a new kernel
- [Kernel Modules](../modules/module-basics.md) — KLP uses the module system
- [Tracing: ftrace](../tracing/ftrace.md) — ftrace function hooks used by KLP
- `kernel/livepatch/` in the kernel tree — KLP implementation
- `Documentation/livepatch/` in the kernel tree
