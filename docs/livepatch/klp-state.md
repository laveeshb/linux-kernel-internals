# KLP State: Custom Consistency Checks

> The klp_state API for patches that need more than stack scanning

## The problem with stack scanning alone

The standard KLP consistency model — scanning every task's stack and waiting
until no task is executing the old function — is sufficient for most patches.
A patch that simply fixes a logic error inside a single function can rely
entirely on the stack-based transition: once no task is mid-execution in the
old function body, it is safe to switch everyone to the new one.

But some patches change things that stack scanning cannot detect:

- A patch that changes the layout of a lock embedded in a shared data
  structure: old code holds a `spinlock_t` at offset 0; new code expects a
  `mutex` there. Even after all stacks are clear, concurrent code may still
  be reading or writing the old layout.
- A patch that adds a new field to a structure accessed by both old and new
  code. Until all callers are using the new code path, some callers will read
  the new field while others still ignore it.
- A patch that changes the semantics of a reference-counted object: the old
  code increments one counter; the new code increments a different one. The
  two cannot safely coexist.

In all of these cases, the patch author needs a way to run custom logic at
the moment of transition — logic that the kernel cannot infer automatically.
The `klp_state` API, added in Linux 5.8, provides exactly that.

## struct klp_state

```c
/* include/linux/livepatch.h */
struct klp_state {
    unsigned long  id;        /* non-zero, unique identifier for this state */
    unsigned int   version;   /* for cumulative patch compatibility */
    void          *data;      /* patch-private pointer, owned by the patch */
    void         (*cleanup)(struct klp_state *state);
                              /* called when the state is freed (patch removed) */
};
```

A patch declares an array of `klp_state` entries, terminated by a zero `id`:

```c
static struct klp_state my_states[] = {
    {
        .id      = 1,        /* arbitrary non-zero id, stable across versions */
        .version = 1,        /* incremented when the state format changes */
    },
    { }                      /* terminator */
};
```

The `data` pointer is available for the patch author to store any per-state
information needed during the transition. The `cleanup` callback is invoked by
`klp_free_patch_start()` when the patch is removed, giving the author a chance
to free resources allocated during the transition.

## Attaching states to a patch

The `states` array is a field of `struct klp_patch`:

```c
/* include/linux/livepatch.h */
struct klp_patch {
    struct module     *mod;
    struct klp_object *objs;
    struct klp_state  *states;   /* optional; NULL if not used */
    bool               replace;  /* true for cumulative patches */
    /* ... internal fields ... */
};
```

A patch that uses `klp_state` sets both fields:

```c
static struct klp_patch my_patch = {
    .mod     = THIS_MODULE,
    .objs    = my_objs,
    .states  = my_states,
    .replace = false,
};
```

## Transition callbacks in struct klp_object

The hooks where custom consistency logic runs are declared per-object in
`struct klp_object`:

```c
/* include/linux/livepatch.h */
struct klp_object {
    const char      *name;         /* NULL for vmlinux */
    struct klp_func *funcs;
    struct klp_state *states;      /* object-level states (rarely used) */

    int  (*pre_patch)(struct klp_object *obj);
    void (*post_patch)(struct klp_object *obj);
    void (*pre_unpatch)(struct klp_object *obj);
    void (*post_unpatch)(struct klp_object *obj);

    /* ... internal fields ... */
};
```

The call order during a forward transition (applying a patch):

1. `pre_patch(obj)` — called before the ftrace hooks are installed. If this
   returns a non-zero error code, `klp_enable_patch()` aborts and returns
   that error. No hooks are installed.
2. ftrace hooks are installed; tasks begin seeing the new function.
3. The consistency transition runs (stack scanning, per-task state updates).
4. `post_patch(obj)` — called after the transition completes and the patch is
   fully active. Errors here are logged but do not reverse the patch.

The call order during a reverse transition (disabling a patch):

1. `pre_unpatch(obj)` — called before the reverse transition begins.
2. The reverse transition runs.
3. ftrace hooks are removed.
4. `post_unpatch(obj)` — called after the patch is fully removed.

## klp_get_state() and klp_get_prev_state()

Two helpers provide access to state data from within the callbacks:

```c
/* kernel/livepatch/core.c */
struct klp_state *klp_get_state(struct klp_patch *patch, unsigned long id);
struct klp_state *klp_get_prev_state(unsigned long id);
```

`klp_get_state(patch, id)` returns the `klp_state` with the given `id` from
`patch->states`. It returns `NULL` if no state with that id exists.

`klp_get_prev_state(id)` searches for a `klp_state` with the given `id` in the
*previously active* patch — the patch that the current patch is replacing. This
is intended for cumulative patches that need to inherit state (counters, flags,
allocated data) from the patch they supersede.

Both functions must be called with `klp_mutex` held, which is guaranteed inside
all four transition callbacks.

## Example: patching a spinlock to a mutex

Consider a subsystem that currently uses a `spinlock_t` to protect a shared
table. A patch needs to change that to a `mutex` to allow sleeping inside the
critical section. The old and new code cannot coexist: if old code holds the
spinlock while new code tries to lock the mutex (at the same address), the
result is undefined behavior.

The patch must quiesce all old-code users before the new code becomes active:

```c
#include <linux/livepatch.h>
#include <linux/mutex.h>

/* id=1 identifies the subsystem lock state */
#define SUBSYS_LOCK_STATE_ID  1UL

static int pre_patch_subsys(struct klp_object *obj)
{
    struct klp_state *state;

    state = klp_get_state(obj->patch_for_state, SUBSYS_LOCK_STATE_ID);
    if (!state)
        return -EINVAL;

    /*
     * Acquire the subsystem's existing spinlock so no old-code caller
     * is inside the critical section when the hooks go live.
     * Store a flag so post_patch knows we succeeded.
     */
    spin_lock(&subsys_spinlock);
    state->data = (void *)1UL;   /* mark: lock held */

    /*
     * Drain any async work that uses the old lock path.
     * Return 0 to allow the transition to proceed.
     */
    return 0;
}

static void post_patch_subsys(struct klp_object *obj)
{
    /*
     * At this point all tasks are running the new code path,
     * which uses subsys_mutex.  Release the spinlock; from here
     * on, only mutex_lock/mutex_unlock will be used.
     */
    spin_unlock(&subsys_spinlock);
}

static void pre_unpatch_subsys(struct klp_object *obj)
{
    /*
     * Reverse: acquire the mutex to drain new-code callers before
     * the hooks are removed and old code (spinlock) resumes.
     */
    mutex_lock(&subsys_mutex);
}

static void post_unpatch_subsys(struct klp_object *obj)
{
    mutex_unlock(&subsys_mutex);
}

static struct klp_state subsys_states[] = {
    { .id = SUBSYS_LOCK_STATE_ID, .version = 1 },
    { }
};

static struct klp_func subsys_funcs[] = {
    {
        .old_name = "subsys_do_work",
        .new_func = patched_subsys_do_work,
    },
    { }
};

static struct klp_object subsys_objs[] = {
    {
        .name         = NULL,   /* vmlinux */
        .funcs        = subsys_funcs,
        .pre_patch    = pre_patch_subsys,
        .post_patch   = post_patch_subsys,
        .pre_unpatch  = pre_unpatch_subsys,
        .post_unpatch = post_unpatch_subsys,
    },
    { }
};

static struct klp_patch subsys_patch = {
    .mod    = THIS_MODULE,
    .objs   = subsys_objs,
    .states = subsys_states,
};
```

If `pre_patch_subsys` returns a non-zero value — for example, because
`subsys_spinlock` is held by a `TASK_UNINTERRUPTIBLE` caller that cannot be
drained — `klp_enable_patch()` propagates that error to `insmod` and no hooks
are installed. The system stays on the old code path with no partial state.

## klp_state and cumulative patches

When a cumulative patch replaces an earlier patch that also used `klp_state`,
the new patch can inherit the previous patch's state data via
`klp_get_prev_state()`. This allows multi-version migrations where each
successive patch builds on the state established by its predecessor:

```c
static int pre_patch_v2(struct klp_object *obj)
{
    struct klp_state *prev, *cur;

    prev = klp_get_prev_state(SUBSYS_LOCK_STATE_ID);
    cur  = klp_get_state(obj->patch_for_state, SUBSYS_LOCK_STATE_ID);

    if (prev && prev->data) {
        /*
         * The previous patch left a counter or flag in prev->data.
         * Inherit it so the new patch can continue from the same point.
         */
        cur->data = prev->data;
    }

    return 0;
}
```

The `version` field assists compatibility checks: if `prev->version` is higher
than the version the new patch understands, the new patch can reject the
transition early in `pre_patch` rather than misinterpreting inherited data.

## Observing state

There is no sysfs file that exposes `klp_state` data. The state is internal to
the patch module. To observe transition progress use the standard sysfs files:

```bash
# Is the patch still transitioning?
cat /sys/kernel/livepatch/<patch>/transition
# 1 = in progress, 0 = complete

# Was the transition forced (skipped consistency check)?
cat /sys/kernel/livepatch/<patch>/forced
# 0 = normal, 1 = forced
```

If a `pre_patch` callback returns an error, `insmod` exits with a non-zero
status and `dmesg` will contain a line like:

```
livepatch: 'my_patch': pre_patch callback failed for object 'vmlinux': -EBUSY
```

## Further reading

- [KLP Consistency Model](klp-consistency.md) — stack scanning, per-task state, forced transitions
- [Cumulative Patches and Atomic Replace](klp-cumulative.md) — `.replace=true`, `klp_get_prev_state()` in context
- [Kernel Live Patching](klp.md) — `struct klp_func`, `struct klp_patch`, ftrace redirection
- `include/linux/livepatch.h` — `struct klp_state`, `struct klp_object` callback declarations
- `kernel/livepatch/core.c` — `klp_get_state()`, `klp_get_prev_state()`, `klp_free_patch_start()`
- `Documentation/livepatch/callbacks.rst` — upstream documentation for transition callbacks
- `Documentation/livepatch/system-state.rst` — upstream documentation for the klp_state API
