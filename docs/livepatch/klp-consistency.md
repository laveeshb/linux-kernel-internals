# KLP Consistency Model

> How the kernel ensures all tasks are in a safe state before activating a patch

## The problem

Applying a live patch is not instantaneous. At the moment the patch is loaded,
some tasks may be executing inside the old function — mid-stack, with local
variables referencing data structures that the new function may handle
differently. Blindly redirecting calls at that instant would leave those tasks
in an inconsistent state.

The KLP consistency model solves this by tracking every task in the system and
only considering the patch fully active once every task has reached a safe
point: returned from the old function, passed through a schedule point, or
entered from userspace.

## Per-task patch state

Each task carries a `patch_state` field in `struct task_struct`
(`include/linux/sched.h`). During a live patch transition the field holds one
of three values, defined in `include/linux/livepatch.h`:

```c
/* include/linux/livepatch.h */
#define KLP_UNDEFINED  -1   /* task hasn't been evaluated yet */
#define KLP_UNPATCHED   0   /* task should call the original function */
#define KLP_PATCHED     1   /* task should call the patched function */
```

At the start of a patching transition every task is `KLP_UNDEFINED`. The
ftrace handler in `kernel/livepatch/patch.c` treats `KLP_UNDEFINED` the same
as `KLP_UNPATCHED` — the task gets the old behavior until explicitly
transitioned.

The transition direction can be either forward (enabling a patch:
`KLP_UNPATCHED` → `KLP_PATCHED`) or backward (disabling a patch:
`KLP_PATCHED` → `KLP_UNPATCHED`).

### How klp_update_patch_state() works

`klp_update_patch_state()` is the function that moves a single task from one
state to the next:

```c
/* kernel/livepatch/transition.c */
void klp_update_patch_state(struct task_struct *task)
{
    preempt_disable_notrace();

    /*
     * Clear TIF_PATCH_PENDING and update patch_state only if
     * the flag was set. This is the mechanism: not a state
     * comparison but a pending-flag check-and-clear.
     */
    if (test_and_clear_tsk_thread_flag(task, TIF_PATCH_PENDING))
        task->patch_state = READ_ONCE(klp_target_state);

    preempt_enable_notrace();
}
```

The global `klp_target_state` is set by the transition machinery to
`KLP_PATCHED` when enabling or `KLP_UNPATCHED` when disabling. Each time a
task is scheduled out (`finish_task_switch`) the scheduler calls
`klp_update_patch_state()` for that task.

## Stack checking: klp_check_stack()

The scheduler path (`finish_task_switch` → `klp_update_patch_state`) does **not** run a stack check. It fires whenever `TIF_PATCH_PENDING` is set, unconditionally. The scheduler path is always safe because a task being scheduled out cannot currently be executing the old function's body.

The stack check (`klp_check_stack()`) only runs in the workqueue path (`klp_try_complete_transition()`), not in the scheduler fast path. Before a task can be transitioned via the workqueue path, the kernel must verify that the old (unpatched) function is not on that task's call stack. If it is, the task is mid-execution inside the old function and cannot be safely transitioned yet.

```c
/* kernel/livepatch/transition.c */
static int klp_check_stack_func(struct klp_func *func,
                                unsigned long *entries,
                                unsigned int nr_entries)
{
    unsigned long func_addr, func_size;
    const char *func_name;
    struct klp_ops *ops;
    int i;

    for (i = 0; i < nr_entries; i++) {
        if (klp_target_state == KLP_UNPATCHED) {
            /*
             * Check for the new (patched) function on the stack:
             * if found, can't unpatch yet.
             */
            func_addr = (unsigned long)func->new_func;
            func_size = func->new_size;
        } else {
            /*
             * Check for the old (original) function on the stack:
             * if found, can't patch yet.
             */
            ops = klp_find_ops(func->old_func);
            func_addr = func->old_addr;
            func_size = func->old_size;
        }
        if (entries[i] >= func_addr &&
            entries[i] < func_addr + func_size)
            return -EAGAIN;
    }
    return 0;
}
```

The function receives the full stack frame array captured by `stack_trace_save_tsk()`, not a single address.

```c
/* kernel/livepatch/transition.c */
static int klp_check_stack(struct task_struct *task,
                            const char **oldname)
{
    unsigned long entries[KLP_MAX_STACK_ENTRIES];
    struct klp_patch *patch;
    struct klp_object *obj;
    struct klp_func *func;
    int nr_entries, ret;

    nr_entries = stack_trace_save_tsk(task, entries,
                                       ARRAY_SIZE(entries), 0);

    klp_for_each_patch(patch) {
        if (!patch->enabled)
            continue;
        klp_for_each_object(patch, obj) {
            if (!klp_is_object_loaded(obj))
                continue;
            klp_for_each_func(obj, func) {
                ret = klp_check_stack_func(func, entries, nr_entries);
                if (ret) {
                    *oldname = func->old_name;
                    return -EAGAIN;
                }
            }
        }
    }
    return 0;
}
```

If `klp_check_stack()` returns `-EAGAIN`, the task is skipped for this
transition round. The transition machinery will retry on the next workqueue
invocation.

## The transition workqueue

A single work item, `klp_transition_work`, drives the transition loop:

```c
/* kernel/livepatch/transition.c */
static void klp_transition_work_fn(struct work_struct *work)
{
    mutex_lock(&klp_mutex);

    if (klp_transition_patch)
        klp_try_complete_transition();

    mutex_unlock(&klp_mutex);
}

static DECLARE_DELAYED_WORK(klp_transition_work, klp_transition_work_fn);
```

The actual call chain in `klp_try_complete_transition()` is: `klp_try_complete_transition()` → `klp_try_switch_task(task)` → `klp_check_and_switch_task()`. The `klp_check_and_switch_task()` function (used via `task_call_func()` for non-current tasks) runs `klp_check_stack()` and, if it returns 0, calls `klp_update_patch_state()`. `klp_update_patch_state()` is never called directly from the main loop of `klp_try_complete_transition()`.

```c
/* kernel/livepatch/transition.c — simplified structure */
static void klp_try_complete_transition(void)
{
    /* ... */
    for_each_process_thread(g, task) {
        if (!klp_patch_pending(task))
            continue;
        /*
         * klp_try_switch_task uses task_call_func to safely
         * run klp_check_and_switch_task on the target task.
         */
        if (klp_try_switch_task(task)) {
            /* task still has old func on stack — not done yet */
            goto err;
        }
    }
    /* all tasks transitioned */
    klp_complete_transition();
    return;
err:
    schedule_delayed_work(&klp_transition_work, round_jiffies_relative(HZ));
}
```

The periodic re-check runs approximately every second (one HZ).

## klp_send_signals(): nudging blocked tasks

`klp_send_signals()` does **not** send any POSIX signal. The actual mechanism:

- For **kthreads** (`task->flags & PF_KTHREAD`): calls `wake_up_state(task, TASK_INTERRUPTIBLE)` — a direct scheduler wakeup for sleeping kthreads
- For **user tasks**: calls `set_notify_signal(task)` — sets `TIF_NOTIFY_SIGNAL`, causing the task to return to userspace at its next signal-check point

Neither path can wake a task in `TASK_UNINTERRUPTIBLE` (D state). D-state tasks must leave that state naturally before the transition can include them. This is why livepatch transitions can stall for an extended period — the `force` mechanism exists precisely for situations where a D-state task cannot be transitioned.

`klp_send_signals()` is called from `klp_try_complete_transition()` when the
transition has been in progress for more than a few seconds.

## Patch stacking: func_stack and struct klp_ops

When multiple live patches are active at the same time, each patching the same
function, the kernel must know which replacement is currently active. This is
managed through `struct klp_ops` and its `func_stack`:

```c
/* kernel/livepatch/patch.c */
struct klp_ops {
    struct list_head  node;        /* entry in klp_ops list */
    struct list_head  func_stack;  /* stack of klp_func — newest at head */
    struct ftrace_ops fops;        /* ftrace hook for this function */
};
```

There is exactly one `klp_ops` per (object, function-name) pair, shared across
all patches. When a second patch targets the same function, its `klp_func` is
pushed onto the head of `func_stack`. The ftrace handler always uses the head:

```c
/* kernel/livepatch/patch.c */
func = list_first_or_null_rcu(&ops->func_stack, struct klp_func, stack_node);
```

So the most recently enabled patch wins. Disabling a patch removes its
`klp_func` from the stack, restoring the previous patch (or the original
function if the stack is empty).

```
func_stack (head → tail):

  [P3: patched_tcp_sendmsg]  ← active (P3 enabled last)
  [P1: patched_tcp_sendmsg]  ← shadowed by P3
```

This arrangement, called *patch stacking*, means patches
do not need to be aware of each other — the stack handles ordering
automatically.

## Forced transitions

If a transition is stuck and cannot complete (for example, a kthread that
loops forever inside the old function), a forced transition can be triggered:

```bash
# Force transition — skips stack check for all tasks
echo 1 > /sys/kernel/livepatch/<patch>/force
```

Forcing a transition is **unsafe**: any task that was executing inside the old
function at the moment of the force will continue executing the old function's
code, but the patch state is set to `KLP_PATCHED`. If the new function changes
data layouts or assumptions, those tasks can access inconsistent state.

After a forced transition the `forced` field of `struct klp_patch` is set to
`true`. The `/sys/kernel/livepatch/<patch>/forced` sysfs file reflects this.

`TAINT_LIVEPATCH` is applied at **module load time** for every livepatch module — not conditionally on forced transitions. Every live patch application taints the kernel with `TAINT_LIVEPATCH` (bit 15). A separate taint (`TAINT_FORCED_MODULE`) may be added on forced transitions.

Only use forced transitions as a last resort after confirming — by reading
`/proc/<pid>/stack` — that the affected task is not in a call path the new
function relies upon.

## klp_complete_transition(): finalizing the patch

Once every task has been transitioned, `klp_complete_transition()` is called:

```c
/* kernel/livepatch/transition.c */
static void klp_complete_transition(void)
{
    struct klp_patch *patch;
    struct klp_object *obj;
    struct klp_func *func;
    struct task_struct *g, *task;

    /* Clear per-task transition state */
    for_each_process_thread(g, task)
        task->patch_state = KLP_UNDEFINED;

    /* Clear per-func transition flag */
    klp_for_each_object(klp_transition_patch, obj)
        klp_for_each_func(obj, func)
            func->transition = false;

    /* For cumulative (replace) patches: unpatch all replaced patches.
     * This removes their funcs from the func_stack. */
    if (klp_transition_patch->replace) {
        klp_for_each_patch(patch) {
            if (patch == klp_transition_patch)
                continue;
            if (patch->enabled)
                klp_unpatch_objects(patch);
        }
    }

    klp_transition_patch = NULL;
}
```

After `klp_complete_transition()` returns, the `transition` sysfs file reads
`0` and the patch is fully active.

## Observing the transition

```bash
# Is the patch still transitioning?
cat /sys/kernel/livepatch/<patch>/transition
# 1 = in progress, 0 = complete

# Was the transition forced?
cat /sys/kernel/livepatch/<patch>/forced
# 0 = normal, 1 = forced

# Which tasks are blocking the transition?
# (tasks that have the old function on their stack)
for pid in $(ls /proc/ | grep -E '^[0-9]+$'); do
    stack=$(cat /proc/$pid/stack 2>/dev/null)
    if echo "$stack" | grep -q "old_function_name"; then
        echo "PID $pid is blocking transition"
        cat /proc/$pid/stack
    fi
done

# Kernel log during transition
dmesg | grep livepatch
# livepatch: 'mypatch': starting patching transition
# livepatch: 'mypatch': patching complete
```

## Transition state machine

```
klp_enable_patch()
       │
       ▼
  Set klp_target_state = KLP_PATCHED
  Set func->transition = true
  Queue klp_transition_work
       │
       ▼ (periodic, every ~1s)
  klp_try_complete_transition()
       │
       ├── for each task:
       │     klp_check_stack() → EAGAIN?
       │       yes: skip (try again next round)
       │       no:  klp_update_patch_state() → KLP_PATCHED
       │
       ├── all tasks KLP_PATCHED?
       │     no:  klp_send_signals(), reschedule work
       │     yes: klp_complete_transition()
       │             │
       │             ▼
       │         func->transition = false
       │         patch->enabled = true
       │         transition sysfs = 0
```

## Further reading

- [Kernel Live Patching](klp.md) — struct klp_func/klp_patch, ftrace redirection, shadow variables
- [Cumulative Patches and Atomic Replace](klp-cumulative.md) — patch stacking and .replace=true
- [ftrace](../tracing/ftrace.md) — the ftrace hook that KLP uses
- `kernel/livepatch/transition.c` — full transition implementation
- `Documentation/livepatch/livepatch.rst` — upstream documentation
