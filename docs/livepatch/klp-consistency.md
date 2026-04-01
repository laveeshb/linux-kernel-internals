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
of three values, defined in `kernel/livepatch/transition.c`:

```c
/* kernel/livepatch/transition.c */
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
    /*
     * This is called from the scheduler (finish_task_switch) and from
     * klp_try_complete_transition().  The task must not be running on
     * another CPU.
     */
    WARN_ON_ONCE(task == current && preemptible());

    /*
     * If the task is already in the target state, nothing to do.
     */
    if (task->patch_state == klp_target_state)
        return;

    task->patch_state = klp_target_state;
}
```

The global `klp_target_state` is set by the transition machinery to
`KLP_PATCHED` when enabling or `KLP_UNPATCHED` when disabling. Each time a
task is scheduled out (`finish_task_switch`) the scheduler calls
`klp_update_patch_state()` for that task — but only after the stack check
passes.

## Stack checking: klp_check_stack()

Before a task can be transitioned, the kernel must verify that the old
(unpatched) function is not on that task's call stack. If it is, the task is
mid-execution inside the old function and cannot be safely transitioned yet.

```c
/* kernel/livepatch/transition.c */
static int klp_check_stack_func(struct klp_func *func, unsigned long address)
{
    unsigned long func_addr, func_size;

    func_addr = (unsigned long)func->old_func;
    func_size = func->old_size;   /* set during symbol resolution */

    /*
     * Is 'address' (a frame's return address) inside the old function?
     */
    if (address >= func_addr && address < func_addr + func_size)
        return 1;   /* old function is on the stack — cannot transition */

    return 0;
}

static int klp_check_stack(struct task_struct *task, const char **oldname)
{
    struct klp_patch *patch;
    struct klp_object *obj;
    struct klp_func *func;
    struct stack_info info;
    unsigned long *frame;

    /*
     * Walk every frame of this task's kernel stack.
     */
    for_each_frame(task, frame, &info) {
        /* For each frame address, check every func being patched */
        klp_for_each_patch(patch) {
            klp_for_each_object(patch, obj) {
                klp_for_each_func(obj, func) {
                    if (klp_check_stack_func(func, *frame)) {
                        if (oldname)
                            *oldname = func->old_name;
                        return -EAGAIN;
                    }
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

`klp_try_complete_transition()` iterates all tasks and attempts to call
`klp_update_patch_state()` for those that have not yet transitioned, after
first running `klp_check_stack()`. Tasks that fail the stack check are
skipped and the work item re-queues itself:

```c
/* kernel/livepatch/transition.c */
void klp_try_complete_transition(void)
{
    struct task_struct *g, *task;
    bool complete = true;

    /* Check init and all threads */
    for_each_process_thread(g, task) {
        if (task->patch_state == klp_target_state)
            continue;

        if (klp_check_stack(task, NULL)) {
            /* Task is in old function — can't transition yet */
            complete = false;
            continue;
        }

        klp_update_patch_state(task);
    }

    /* Also check idle tasks (one per CPU) */
    for_each_possible_cpu(cpu) {
        task = idle_task(cpu);
        if (task->patch_state != klp_target_state) {
            klp_update_patch_state(task);
        }
    }

    if (complete) {
        klp_complete_transition();
        return;
    }

    /* Some tasks not yet transitioned — try again later */
    schedule_delayed_work(&klp_transition_work,
                          round_jiffies_relative(HZ));
}
```

The periodic re-check runs approximately every second (one HZ).

## klp_send_signals(): waking blocked tasks

A task in uninterruptible sleep (`D` state) will never voluntarily schedule
out. If such a task is blocked inside the old function, the transition stalls.
`klp_send_signals()` forcibly wakes these tasks so they can reach a schedule
point:

```c
/* kernel/livepatch/transition.c */
static void klp_send_signals(void)
{
    struct task_struct *g, *task;

    /*
     * Send a fake signal to tasks stuck in D state that are blocking
     * the transition.  The signal wakes them so they can reschedule.
     * SIGURG is used because it is ignored by default — most tasks
     * won't notice it.
     */
    for_each_process_thread(g, task) {
        if (task->patch_state == klp_target_state)
            continue;
        if (task->state & TASK_UNINTERRUPTIBLE)
            send_sig(SIGURG, task, 0);
    }
}
```

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

This arrangement, called *patch stacking* or *KLPR_STACKING*, means patches
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
`true`, and the kernel taints itself with `TAINT_LIVEPATCH`. The
`/sys/kernel/livepatch/<patch>/forced` sysfs file reflects this.

```c
/* kernel/livepatch/core.c */
if (patch->forced)
    add_taint(TAINT_LIVEPATCH, LOCKDEP_STILL_OK);
```

Only use forced transitions as a last resort after confirming — by reading
`/proc/<pid>/stack` — that the affected task is not in a call path the new
function relies upon.

## klp_complete_transition(): finalizing the patch

Once every task has been transitioned, `klp_complete_transition()` is called:

```c
/* kernel/livepatch/transition.c */
static void klp_complete_transition(void)
{
    struct klp_patch *patch = klp_transition_patch;
    struct klp_object *obj;
    struct klp_func *func;
    struct task_struct *g, *task;

    /* Clear per-task patch_state back to KLP_UNDEFINED */
    for_each_process_thread(g, task)
        task->patch_state = KLP_UNDEFINED;

    /* Mark all functions as fully patched (or unpatched, for disable) */
    klp_for_each_object(patch, obj) {
        klp_for_each_func(obj, func) {
            func->transition = false;
        }
    }

    /* Update patch enabled/disabled state */
    if (klp_target_state == KLP_PATCHED)
        patch->enabled = true;
    else
        patch->enabled = false;

    klp_transition_patch = NULL;

    /* Cancel the periodic work item */
    cancel_delayed_work(&klp_transition_work);
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
       │         cancel work item
```

## Further reading

- [Kernel Live Patching](klp.md) — struct klp_func/klp_patch, ftrace redirection, shadow variables
- [Cumulative Patches and Atomic Replace](klp-cumulative.md) — patch stacking and .replace=true
- [ftrace](../tracing/ftrace.md) — the ftrace hook that KLP uses
- `kernel/livepatch/transition.c` — full transition implementation
- `Documentation/livepatch/livepatch.rst` — upstream documentation
