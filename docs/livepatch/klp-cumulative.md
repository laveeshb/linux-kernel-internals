# Cumulative Patches and Atomic Replace

> Stacking live patches and replacing them atomically

## The accumulation problem

In a long-running production environment, a kernel may accumulate several live
patches over time. Patch P1 fixes a bug in `tcp_sendmsg`. Two weeks later,
patch P2 fixes a different function, `ip_output`. A month after that, patch P3
fixes `vfs_write`.

Each patch is independent, but they must all stay loaded simultaneously — the
system now carries three patch modules, three transition histories, and the
cognitive overhead of tracking which functions are patched by which module.
When a fourth security patch arrives that updates `tcp_sendmsg` again, things
get complicated: P4 must be written knowing P1 is also active.

*Cumulative patches* solve this. A cumulative patch replaces all previous
patches in a single atomic operation rather than layering on top of them.

## struct klp_patch: the .replace flag

The `.replace` field, added to `struct klp_patch` in Linux 5.1, marks a
patch as cumulative:

```c
/* include/linux/livepatch.h */
struct klp_patch {
    /* external (set by patch module author): */
    struct module       *mod;       /* the live patch module */
    struct klp_object   *objs;      /* array of patched objects */
    struct klp_state    *states;    /* optional consistency states (5.8+) */
    bool                 replace;   /* true = cumulative replace (5.1+) */

    /* internal (managed by the livepatch core): */
    struct list_head     list;
    struct kobject       kobj;
    struct list_head     obj_list;
    bool                 enabled;
    bool                 forced;
    struct work_struct   free_work;
    struct completion    finish;
};
```

A cumulative patch declares every function that should be patched after it is
applied — including functions that earlier patches touched. When
`.replace = true`, the KLP core replaces the entire set of active patches, not
just adds one more.

## Writing a cumulative patch

```c
/* Cumulative patch: replaces P1 (tcp_sendmsg) and P2 (ip_output) */

static int patched_tcp_sendmsg(struct sock *sk, struct msghdr *msg,
                                size_t size)
{
    /* Latest fix: combines fix from P1 and any new changes */
    ...
}

static int patched_ip_output(struct net *net, struct sock *sk,
                              struct sk_buff *skb)
{
    /* Re-implements fix from P2 */
    ...
}

static struct klp_func net_funcs[] = {
    {
        .old_name = "tcp_sendmsg",
        .new_func = patched_tcp_sendmsg,
    },
    {
        .old_name = "ip_output",
        .new_func = patched_ip_output,
    },
    {}
};

static struct klp_object objs[] = {
    { .name = NULL, .funcs = net_funcs },
    {}
};

static struct klp_patch cumulative_patch = {
    .mod     = THIS_MODULE,
    .objs    = objs,
    .replace = true,    /* <-- this is a cumulative patch */
};

static int __init cumulative_patch_init(void)
{
    return klp_enable_patch(&cumulative_patch);
}
```

There is no `klp_atomic_replace()` function. The mechanism for cumulative replace is:

When `patch->replace == true`, `klp_init_patch()` calls `klp_add_nops(patch)` to dynamically allocate `klp_func` "nop" entries for every function that currently-active patches cover but the new cumulative patch does not explicitly patch. These nop entries, when active, call through to the original function. This ensures that when the transition completes and old patches are removed from the func_stack, all previously-patched functions are still covered (by a nop).

The "atomic" part is that the entire switch — enabling the new patch and removing old patches — happens atomically from userspace's perspective: old patches are removed inside `klp_complete_transition()` after the transition finishes.

```c
/* The cumulative replace flow (simplified): */

/* 1. Patch author sets .replace = true in klp_patch */
/* 2. klp_enable_patch() → klp_init_patch() → klp_add_nops()
 *    allocates nop funcs for any functions in active patches
 *    not covered by the new patch */
/* 3. Normal transition begins (same as any patch) */
/* 4. klp_complete_transition() → klp_unpatch_objects() removes
 *    all replaced patches from the func_stack */
```

## struct klp_ops: the per-function hook

There is exactly one `struct klp_ops` for each (object, function-name) pair,
no matter how many patches target that function:

```c
/* kernel/livepatch/patch.c */
struct klp_ops {
    struct list_head  node;        /* global klp_ops list */
    struct list_head  func_stack;  /* klp_func entries — newest at head */
    struct ftrace_ops fops;        /* single ftrace registration */
};
```

All patches that touch the same function share one `klp_ops` and therefore one
ftrace hook. The `func_stack` is the arbiter: the head entry is the active
replacement. A newer patch's `klp_func` is always pushed to the head when it
is enabled:

```c
/* kernel/livepatch/patch.c — klp_patch_func() */
list_add_rcu(&func->stack_node, &ops->func_stack);
```

And removed from the head (or wherever it sits) when disabled:

```c
/* kernel/livepatch/patch.c — klp_unpatch_func() */
list_del_rcu(&func->stack_node);
```

If the stack becomes empty, the ftrace hook is unregistered and the original
function resumes executing without any trampoline overhead.

## Disabling a patch

Disabling a patch starts a *reverse transition*: tasks are moved from
`KLP_PATCHED` back to `KLP_UNPATCHED`. The `enabled` sysfs file triggers this:

```bash
echo 0 > /sys/kernel/livepatch/<patch>/enabled
```

The kernel sets `klp_target_state = KLP_UNPATCHED` and queues
`klp_transition_work`. The stack check still applies — tasks that are executing
inside the *new* (patched) function cannot be reversed until they return.

Observing a disable transition:

```bash
cat /sys/kernel/livepatch/mypatch/transition
# 1 = reverse transition in progress

# Wait for it to complete
while [ "$(cat /sys/kernel/livepatch/mypatch/transition)" = "1" ]; do
    sleep 1
done

cat /sys/kernel/livepatch/mypatch/enabled
# 0 = fully disabled
```

## Removing a patch

Once a patch is disabled, its module can be unloaded. The only public livepatch API exported via `EXPORT_SYMBOL_GPL` is `klp_enable_patch()`. A livepatch module's `module_exit` should be empty or omitted entirely — the livepatch core handles cleanup via the module notifier `klp_module_going()`:

```c
/* Livepatch module exit: no explicit unregister needed.
 * The livepatch core registers a module notifier (klp_module_going)
 * that handles cleanup when the module is unloaded.
 * Before unloading, disable the patch via sysfs:
 *   echo 0 > /sys/kernel/livepatch/<patch>/enabled
 * Then: rmmod <patch_module>
 */
static void __exit livepatch_exit(void) { }
module_exit(livepatch_exit);
```

A live patch module cannot be unloaded while enabled — the module loader
checks this:

```bash
# This will fail if the patch is still enabled:
rmmod mypatch
# ERROR: Module mypatch is in use

# Correct sequence:
echo 0 > /sys/kernel/livepatch/mypatch/enabled
# wait for transition=0
rmmod mypatch
```

## klp_patch lifecycle

`struct klp_patch` has no state enum. State is tracked via boolean fields: `patch->enabled` (bool) and `patch->forced` (bool). The lifecycle in terms of sysfs-observable state is: unloaded → `enabled=0` (loaded, not yet active) → `enabled=1, transition=1` (transitioning) → `enabled=1, transition=0` (fully active) → `enabled=0` (disabled, can unload).

```
insmod mypatch.ko
  │
  ▼
klp_enable_patch()
  │  (registration, symbol resolution, ftrace hook install)
  ▼
enabled=0, transition=1 (transition in progress)
  │
  ▼
enabled=1, transition=0 (fully active)
  │
  │  echo 0 > enabled
  ▼
enabled=0, transition=1 (reverse transition in progress)
  │
  ▼
enabled=0, transition=0 (disabled, can unload)
  │
  │  rmmod mypatch.ko
  ▼
(patch removed, ftrace hooks cleaned up via klp_module_going)
```

## Observing the func_stack

The sysfs hierarchy exposes the state of each patched function, including
its position in the func_stack relative to other patches:

```bash
# Check if a specific function is patched
cat /sys/kernel/livepatch/mypatch/objs/vmlinux/funcs/tcp_sendmsg/patched
# 1 = hook is active for this function

# old_addr is NOT exposed via sysfs
# To find the original function address, use /proc/kallsyms:
grep " tcp_sendmsg$" /proc/kallsyms

# If two patches cover the same function:
cat /sys/kernel/livepatch/p1/objs/vmlinux/funcs/tcp_sendmsg/patched  # 0 (shadowed by p2)
cat /sys/kernel/livepatch/p2/objs/vmlinux/funcs/tcp_sendmsg/patched  # 1 (active)
```

## Practical workflow with kpatch

`kpatch` is the most widely used toolchain for building and distributing
cumulative live patches. The standard workflow for a security patch release:

```bash
# 1. Build a cumulative patch from a source diff
#    kpatch-build creates a .ko that patches all functions touched by the diff
kpatch-build -t vmlinux security-fix.patch

# 2. The resulting module embeds all functions from the diff
#    If this is a third patch after p1 and p2, set .replace=true in the module

# 3. Load the cumulative patch
insmod kpatch-security-fix.ko

# 4. Verify it replaced previous patches
cat /sys/kernel/livepatch/kpatch-security-fix/transition
# wait for 0

cat /sys/kernel/livepatch/kpatch-security-fix/enabled
# 1

# Previous patches are now disabled and their modules can be unloaded:
echo 0 > /sys/kernel/livepatch/kpatch-prev-patch/enabled
# wait, then rmmod

# 5. Persist across reboots (using kpatch service)
kpatch install kpatch-security-fix.ko
systemctl enable kpatch
```

## Cumulative patch ordering rules

Loading a cumulative patch while another patch is still transitioning is
unsafe. The `func_stack` can end up in an indeterminate state. Always verify
all active patches are stable before loading a cumulative replacement:

```bash
# Check all patches are fully transitioned before loading a cumulative patch
for p in /sys/kernel/livepatch/*/; do
    t=$(cat "$p/transition")
    if [ "$t" = "1" ]; then
        echo "WARNING: $(basename $p) is still transitioning — wait before loading cumulative patch"
    fi
done
```

See [war stories](war-stories.md) for a real incident where this rule was
violated.

## Further reading

- [KLP Consistency Model](klp-consistency.md) — per-task states, stack checking, forced transitions
- [Kernel Live Patching](klp.md) — struct klp_func/klp_patch, ftrace redirection, shadow variables
- [Kernel Modules](../modules/module-basics.md) — KLP modules use the standard module infrastructure
- `kernel/livepatch/core.c` — klp_enable_patch(), klp_add_nops(), klp_module_going()
- `kernel/livepatch/patch.c` — struct klp_ops, func_stack management
- `Documentation/livepatch/cumulative-patches.rst` — upstream cumulative patch guide
