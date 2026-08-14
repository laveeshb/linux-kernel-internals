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
#define KLP_TRANSITION_IDLE       -1   /* task hasn't been evaluated yet */
#define KLP_TRANSITION_UNPATCHED   0   /* task should call the original function */
#define KLP_TRANSITION_PATCHED     1   /* task should call the patched function */
```

`KLP_TRANSITION_IDLE` is the resting value when no transition is in progress.
`klp_init_transition()` assigns every task's real starting state —
`KLP_TRANSITION_UNPATCHED` or `KLP_TRANSITION_PATCHED`, whichever isn't the
target — before a transition becomes visible, so no live task is ever actually
observed at `KLP_TRANSITION_IDLE` mid-transition; the ftrace handler in
`kernel/livepatch/patch.c` even asserts this with `WARN_ON_ONCE(patch_state ==
KLP_TRANSITION_IDLE)`.

The transition direction can be either forward (enabling a patch:
`KLP_TRANSITION_UNPATCHED` → `KLP_TRANSITION_PATCHED`) or backward (disabling
a patch: `KLP_TRANSITION_PATCHED` → `KLP_TRANSITION_UNPATCHED`).

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
`KLP_TRANSITION_PATCHED` when enabling or `KLP_TRANSITION_UNPATCHED` when
disabling. `klp_update_patch_state()` is called for `current` from the
kernel-exit-to-userspace path (`__exit_to_user_mode_loop()` in
`kernel/entry/common.c`) whenever `TIF_PATCH_PENDING` is set, and directly on
every task by `klp_force_transition()` for a forced transition.

## Stack checking: klp_check_stack()

`klp_update_patch_state()` does **not** run a stack check — it's an
unconditional flag-check-and-clear. That's safe on the kernel-exit-to-userspace
path because a task that's about to return to userspace cannot be mid-execution
inside a patched kernel function's body.

Two other paths *do* run a stack check, both funneling through
`klp_check_stack()`:

- **The workqueue path** (`klp_try_complete_transition()`, described below):
  runs roughly once a second and walks every task in the system, including
  ones that are sleeping or blocked.
- **The scheduler path**: while a transition is in progress, `__schedule()`
  calls `klp_sched_try_switch(prev)` (`kernel/sched/core.c`), which — gated by
  a static key that `klp_resched_enable()`/`klp_resched_disable()` toggle for
  the duration of the transition — calls `klp_try_switch_task(current)` on
  context switches where the outgoing task is entering a freezable sleep
  state (`TASK_FREEZABLE`), not on every context switch. This exists specifically to help CPU-bound kthreads
  get patched: such a task may rarely (or never) go through the
  kernel-exit-to-userspace path, so relying on that path alone could stall
  the transition indefinitely.

Either way, before a task can be switched via a stack-checking path, the
kernel must verify that the old (unpatched) function — or, if a patch is
already stacked on top of another, the previously patched function — is not
on that task's call stack. If it is, the task is mid-execution inside that
function and cannot be safely transitioned yet.

```c
/* kernel/livepatch/transition.c */
static int klp_check_stack_func(struct klp_func *func, unsigned long *entries,
                                unsigned int nr_entries)
{
    unsigned long func_addr, func_size, address;
    struct klp_ops *ops;
    int i;

    if (klp_target_state == KLP_TRANSITION_UNPATCHED) {
        /*
         * Check for the to-be-unpatched function
         * (the func itself).
         */
        func_addr = (unsigned long)func->new_func;
        func_size = func->new_size;
    } else {
        /*
         * Check for the to-be-patched function
         * (the previous func).
         */
        ops = klp_find_ops(func->old_func);

        if (list_is_singular(&ops->func_stack)) {
            /* original function */
            func_addr = (unsigned long)func->old_func;
            func_size = func->old_size;
        } else {
            /* previously patched function */
            struct klp_func *prev;

            prev = list_next_entry(func, stack_node);
            func_addr = (unsigned long)prev->new_func;
            func_size = prev->new_size;
        }
    }

    for (i = 0; i < nr_entries; i++) {
        address = entries[i];

        if (address >= func_addr && address < func_addr + func_size)
            return -EAGAIN;
    }
    return 0;
}
```

Note the patch-stacking-aware branch: when checking whether it's safe to
*patch* (not unpatch), the function doesn't just look for `func->old_func` —
if another patch already replaced this function (`func_stack` has more than
one entry), it looks for the *previously patched* function
(`list_next_entry(func, stack_node)`'s `new_func`), since that's what's
actually running on the stack right now. See "Patch stacking", below.

The function receives the full stack frame array captured by
`stack_trace_save_tsk_reliable()`, not a single address.

```c
/* kernel/livepatch/transition.c */
#define MAX_STACK_ENTRIES  100
static DEFINE_PER_CPU(unsigned long[MAX_STACK_ENTRIES], klp_stack_entries);

static int klp_check_stack(struct task_struct *task, const char **oldname)
{
    unsigned long *entries = this_cpu_ptr(klp_stack_entries);
    struct klp_object *obj;
    struct klp_func *func;
    int ret, nr_entries;

    ret = stack_trace_save_tsk_reliable(task, entries, MAX_STACK_ENTRIES);
    if (ret < 0)
        return -EINVAL;
    nr_entries = ret;

    klp_for_each_object(klp_transition_patch, obj) {
        if (!obj->patched)
            continue;
        klp_for_each_func(obj, func) {
            ret = klp_check_stack_func(func, entries, nr_entries);
            if (ret) {
                *oldname = func->old_name;
                return -EADDRINUSE;
            }
        }
    }

    return 0;
}
```

`klp_check_stack()` only walks the single patch currently transitioning
(`klp_transition_patch`, via `klp_for_each_object()`) — not every enabled
patch — since only one patch can be mid-transition at a time. The stack
buffer itself is a per-CPU array (`klp_stack_entries`, sized by the private
`MAX_STACK_ENTRIES` `#define`, not a `KLP_MAX_STACK_ENTRIES` constant),
protected by having preemption disabled.

`klp_check_stack()` returns `-EINVAL` if the stack trace itself is
unreliable (`stack_trace_save_tsk_reliable()` failed) and `-EADDRINUSE` if
the stack unwound cleanly but a to-be-patched or to-be-unpatched function was
found on it. Either way the task is skipped for this transition round; the
transition machinery will retry on the next workqueue invocation.

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

The actual call chain in `klp_try_complete_transition()` is: `klp_try_complete_transition()` → `klp_try_switch_task(task)` → `klp_check_and_switch_task()`. The `klp_check_and_switch_task()` function (used via `task_call_func()` for non-current tasks) runs `klp_check_stack()` and, if it returns 0, clears `TIF_PATCH_PENDING` and sets `task->patch_state = klp_target_state` directly. `klp_update_patch_state()` — the flag-check-and-clear function from the previous section — is never called from the main loop of `klp_try_complete_transition()`; that function is reserved for the kernel-exit-to-userspace path and `klp_force_transition()`.

```c
/* kernel/livepatch/transition.c — simplified structure */
void klp_try_complete_transition(void)
{
    unsigned int cpu;
    struct task_struct *g, *task;
    bool complete = true;

    /*
     * klp_try_switch_task uses task_call_func to safely run
     * klp_check_and_switch_task on the target task. It returns
     * true on success (task is now at klp_target_state).
     */
    for_each_process_thread(g, task)
        if (!klp_try_switch_task(task))
            complete = false;

    /* idle ("swapper") tasks are checked the same way */
    for_each_possible_cpu(cpu) {
        task = idle_task(cpu);
        if (!klp_try_switch_task(task))
            complete = false;
    }

    if (!complete) {
        /* some tasks weren't switched yet — try again later */
        schedule_delayed_work(&klp_transition_work, round_jiffies_relative(HZ));
        return;
    }

    /* all tasks transitioned */
    klp_complete_transition();
}
```

The periodic re-check runs approximately every second (one HZ).

## klp_send_signals(): nudging blocked tasks

`klp_send_signals()` does **not** send any POSIX signal. The actual mechanism:

- For **kthreads** (`task->flags & PF_KTHREAD`): calls `wake_up_state(task, TASK_INTERRUPTIBLE)` — a direct scheduler wakeup for sleeping kthreads
- For **user tasks**: calls `set_notify_signal(task)` — sets `TIF_NOTIFY_SIGNAL`, causing the task to return to userspace at its next signal-check point

Neither path can wake a task in `TASK_UNINTERRUPTIBLE` (D state). D-state tasks must leave that state naturally before the transition can include them. This is why livepatch transitions can stall for an extended period — the `force` mechanism exists precisely for situations where a D-state task cannot be transitioned.

`klp_send_signals()` is called from `klp_try_complete_transition()` roughly
every 15 seconds (every `SIGNALS_TIMEOUT`th incomplete retry round, at the
~1-second-per-round cadence described below) once the transition has stalled.

## Patch stacking: func_stack and struct klp_ops

When multiple live patches are active at the same time, each patching the same
function, the kernel must know which replacement is currently active. This is
managed through `struct klp_ops` and its `func_stack`:

```c
/* kernel/livepatch/patch.h */
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
code, but the patch state is set to `KLP_TRANSITION_PATCHED`. If the new
function changes data layouts or assumptions, those tasks can access
inconsistent state.

After a forced transition the `forced` field of `struct klp_patch` is set to
`true`. This is internal-only — there is no sysfs file to read it back; the
only externally visible trace is that `rmmod` on the patch module is
permanently disabled from that point on.

`TAINT_LIVEPATCH` is applied at **module load time** for every livepatch module — not conditionally on forced transitions. Every live patch application taints the kernel with `TAINT_LIVEPATCH` (bit 15). `klp_force_transition()` itself does not add any additional taint — `TAINT_FORCED_MODULE` is unrelated; it's set when a module is force-loaded with `insmod -f`, not when a livepatch transition is forced.

Only use forced transitions as a last resort after confirming — by reading
`/proc/<pid>/stack` — that the affected task is not in a call path the new
function relies upon.

## klp_complete_transition(): finalizing the patch

Once every task has been transitioned, `klp_complete_transition()` is called:

```c
/* kernel/livepatch/transition.c */
static void klp_complete_transition(void)
{
    struct klp_object *obj;
    struct klp_func *func;
    struct task_struct *g, *task;
    unsigned int cpu;

    /* For cumulative (replace) patches: unpatch all replaced patches.
     * This removes their funcs from the func_stack. */
    if (klp_transition_patch->replace && klp_target_state == KLP_TRANSITION_PATCHED) {
        klp_unpatch_replaced_patches(klp_transition_patch);
        klp_discard_nops(klp_transition_patch);
    }

    if (klp_target_state == KLP_TRANSITION_UNPATCHED) {
        /*
         * All tasks have transitioned to KLP_TRANSITION_UNPATCHED so we
         * can now remove the new functions from the func_stack.
         */
        klp_unpatch_objects(klp_transition_patch);
        klp_synchronize_transition();
    }

    /* Clear per-func transition flag */
    klp_for_each_object(klp_transition_patch, obj)
        klp_for_each_func(obj, func)
            func->transition = false;

    /* Prevent klp_ftrace_handler() from seeing KLP_TRANSITION_IDLE state */
    if (klp_target_state == KLP_TRANSITION_PATCHED)
        klp_synchronize_transition();

    /* Clear per-task transition state, including idle tasks */
    read_lock(&tasklist_lock);
    for_each_process_thread(g, task)
        task->patch_state = KLP_TRANSITION_IDLE;
    read_unlock(&tasklist_lock);

    for_each_possible_cpu(cpu)
        idle_task(cpu)->patch_state = KLP_TRANSITION_IDLE;

    /* Run any post-(un)patch callbacks now that the transition is done */
    klp_for_each_object(klp_transition_patch, obj) {
        if (!klp_is_object_loaded(obj))
            continue;
        if (klp_target_state == KLP_TRANSITION_PATCHED)
            klp_post_patch_callback(obj);
        else if (klp_target_state == KLP_TRANSITION_UNPATCHED)
            klp_post_unpatch_callback(obj);
    }

    klp_target_state = KLP_TRANSITION_IDLE;
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

# Whether a transition was ever forced is internal-only (struct klp_patch.forced)
# and not exposed via sysfs — the only observable side effect is that `rmmod`
# on the patch module will be permanently refused from that point on.

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
  Set klp_target_state = KLP_TRANSITION_PATCHED
  Set func->transition = true
  Queue klp_transition_work
       │
       ▼ (periodic, every ~1s)
  klp_try_complete_transition()
       │
       ├── for each task (and each idle task):
       │     klp_try_switch_task() → klp_check_and_switch_task()
       │       task unsafe to switch (-EBUSY: running; -EINVAL / -EADDRINUSE from klp_check_stack())?
       │         yes: skip (try again next round)
       │         no:  task->patch_state = KLP_TRANSITION_PATCHED
       │
       ├── all tasks KLP_TRANSITION_PATCHED?
       │     no:  klp_send_signals(), reschedule work
       │     yes: klp_complete_transition()
       │             │
       │             ▼
       │         func->transition = false
       │         klp_target_state = KLP_TRANSITION_IDLE
       │         patch->enabled = true
       │         transition sysfs = 0
```

## Further reading

### Kernel source

- [kernel/livepatch/transition.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/transition.c) — `klp_check_stack()`, `klp_try_complete_transition()`, `klp_update_patch_state()`, `klp_force_transition()`, and the rest of the transition state machine
- [kernel/livepatch/patch.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/patch.c) — `klp_ftrace_handler()`, which walks `func_stack` to pick the active replacement, plus `klp_patch_func()`/`klp_unpatch_func()`
- [kernel/livepatch/core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/core.c) — the `/sys/kernel/livepatch/<patch>/{transition,force}` sysfs attributes
- [include/linux/livepatch.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/livepatch.h) — `struct klp_func`, `struct klp_object`, `struct klp_patch`, and the transition-state constants

### Related pages

- [Kernel Live Patching](klp.md) — struct klp_func/klp_patch, ftrace redirection, shadow variables
- [Cumulative Patches and Atomic Replace](klp-cumulative.md) — patch stacking and .replace=true
- [KLP State: Custom Consistency Checks](klp-state.md) — the `klp_state` API for changes stack scanning alone can't validate
- [ftrace](../tracing/ftrace.md) — the ftrace hook that KLP uses

### LWN articles

- [LWN: livepatch: consistency model](https://lwn.net/Articles/632582/) — the original 2015 design writeup for the per-task, stack-checking transition model implemented in `kernel/livepatch/transition.c`
- [LWN: An update on live kernel patching](https://lwn.net/Articles/734765/) — 2017 status report covering the hybrid lazy-migration/stack-checking model and why the ORC unwinder was needed for reliable stack checks

### External

- [Kernel docs: Livepatch](https://docs.kernel.org/livepatch/livepatch.html) — upstream description of the consistency model, the `force` and `transition` sysfs files, and patch stacking via `func_stack`
- [Kernel docs: Reliable Stacktrace](https://docs.kernel.org/livepatch/reliable-stacktrace.html) — why livepatch requires a reliable (not best-effort) stack unwinder for the stack-checking path
