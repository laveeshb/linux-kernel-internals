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
The `klp_state` API, added in Linux 5.5, provides exactly that.

## struct klp_state

```c
/* include/linux/livepatch.h */
struct klp_state {
    unsigned long  id;        /* non-zero, unique identifier for this state */
    unsigned int   version;   /* for cumulative patch compatibility */
    void          *data;      /* patch-private pointer, owned by the patch */
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
information needed during the transition.

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
    const char           *name;      /* NULL for vmlinux */
    struct klp_func      *funcs;
    struct klp_callbacks  callbacks; /* contains pre/post patch/unpatch hooks */
    /* ... internal fields ... */
};

/* include/linux/livepatch_external.h */
struct klp_callbacks {
    int  (*pre_patch)(struct klp_object *obj);
    void (*post_patch)(struct klp_object *obj);
    void (*pre_unpatch)(struct klp_object *obj);
    void (*post_unpatch)(struct klp_object *obj);
    bool post_unpatch_enabled;
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
/* include/linux/livepatch.h (declared here; implemented in kernel/livepatch/state.c) */
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

/*
 * Forward-declared: pre_patch_subsys() below needs to look up its own
 * patch's state via klp_get_state(&subsys_patch, ...), but the full
 * struct klp_patch definition (which needs the callbacks and objects
 * defined first) only comes together at the end of the file -- the
 * same order real livepatch modules use, e.g.
 * samples/livepatch/livepatch-callbacks-demo.c.
 */
static struct klp_patch subsys_patch;

static int pre_patch_subsys(struct klp_object *obj)
{
    struct klp_state *state;

    state = klp_get_state(&subsys_patch, SUBSYS_LOCK_STATE_ID);
    if (!state)
        return -EINVAL;

    /*
     * Briefly take the subsystem's existing spinlock just long enough
     * to confirm no old-code caller is mid-critical-section, then
     * release it immediately. The lock must NOT be held across the
     * rest of the transition (steps 2-3 below): the consistency
     * model's stack scan can take an unbounded amount of time while
     * it waits for every task in the system, and holding a spinlock
     * for that long is itself a correctness bug, not a safe pattern.
     */
    spin_lock(&subsys_spinlock);
    state->data = (void *)1UL;   /* mark: transition to mutex started */
    spin_unlock(&subsys_spinlock);

    return 0;
}

static void post_patch_subsys(struct klp_object *obj)
{
    /*
     * By the time post_patch runs, the consistency model has already
     * confirmed that no task is still executing inside the old
     * subsys_do_work() -- so nothing can still be holding
     * subsys_spinlock across a call into it. Every caller from here
     * on uses the new, mutex-based code path; there is no lock left
     * to release here.
     */
}

static void pre_unpatch_subsys(struct klp_object *obj)
{
    /*
     * Reverse transition: briefly take the mutex to confirm no
     * new-code caller is mid-critical-section, then release it right
     * away. As with pre_patch_subsys() above, the lock must not be
     * held across the reverse transition itself.
     */
    mutex_lock(&subsys_mutex);
    mutex_unlock(&subsys_mutex);
}

static void post_unpatch_subsys(struct klp_object *obj)
{
    /*
     * The reverse transition has completed and the ftrace hooks are
     * gone, so the original spinlock-based code is running again for
     * every caller. There is nothing left to release here.
     */
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
        .name  = NULL,   /* vmlinux */
        .funcs = subsys_funcs,
        .callbacks = {
            .pre_patch    = pre_patch_subsys,
            .post_patch   = post_patch_subsys,
            .pre_unpatch  = pre_unpatch_subsys,
            .post_unpatch = post_unpatch_subsys,
        },
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
`klp_get_state()` can't find the state entry it expects —
`klp_enable_patch()` propagates that error to `insmod` and no hooks are
installed. The system stays on the old code path with no partial state.

## klp_state and cumulative patches

When a cumulative patch replaces an earlier patch that also used `klp_state`,
the new patch can inherit the previous patch's state data via
`klp_get_prev_state()`. This allows multi-version migrations where each
successive patch builds on the state established by its predecessor:

```c
/* subsys_patch_v2: the new, replacing patch's own struct klp_patch,
 * declared the same way subsys_patch was above -- omitted here for
 * brevity. */
static int pre_patch_v2(struct klp_object *obj)
{
    struct klp_state *prev, *cur;

    prev = klp_get_prev_state(SUBSYS_LOCK_STATE_ID);
    cur  = klp_get_state(&subsys_patch_v2, SUBSYS_LOCK_STATE_ID);

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

The `version` field is what the kernel uses to decide compatibility —
automatically, and before any of the patch's own code runs. When a patch is
loaded, `klp_enable_patch()` calls `klp_is_patch_compatible()`
(`kernel/livepatch/state.c`), which walks every state already modified by
every currently-installed patch. For each such state, if the new patch also
declares that state id, its `version` must be `>=` the already-installed
version; if the new patch doesn't declare that state id at all, it's only
compatible when the new patch is non-cumulative (a cumulative, `.replace =
true` patch must account for every state a patch it replaces has already
touched). If the check fails, `klp_enable_patch()` returns `-EINVAL`
immediately — `pre_patch_v2()` above is never called, and `insmod` fails
outright. The patch's own callbacks have no say in the decision; they only
run once the kernel has already confirmed compatibility.

## Observing state

There is no sysfs file that exposes `klp_state` data. The state is internal to
the patch module. To observe transition progress use the standard sysfs files:

```bash
# Is the patch still transitioning?
cat /sys/kernel/livepatch/<patch>/transition
# 1 = in progress, 0 = complete

# Force a stuck transition to finish immediately, skipping the rest of
# the consistency check. This attribute is write-only -- there is no
# way to read it back to find out whether a past transition was
# forced; that's tracked only internally (struct klp_patch.forced).
echo 1 > /sys/kernel/livepatch/<patch>/force
```

Forcing a transition is a last resort: it clears every task's pending-patch
flag outright, and once used, the patch module can never be removed
(`rmmod`) again for the lifetime of the running kernel.

If a `pre_patch` callback returns an error, `insmod` exits with a non-zero
status and `dmesg` will contain a line like:

```
livepatch: pre-patch callback failed for object 'vmlinux'
```

## Further reading

### Kernel source

- [include/linux/livepatch.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/livepatch.h) — `struct klp_state`, `struct klp_object`, `struct klp_patch`, and the `klp_get_state()`/`klp_get_prev_state()` declarations
- [include/linux/livepatch_external.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/livepatch_external.h) — `struct klp_callbacks`: the `pre_patch`/`post_patch`/`pre_unpatch`/`post_unpatch` hook table
- [kernel/livepatch/state.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/state.c) — `klp_get_state()` and `klp_get_prev_state()` implementations, plus the automatic version-compatibility check (`klp_is_patch_compatible()`) run when a patch is loaded
- [kernel/livepatch/core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/core.c) — `klp_enable_patch()`: where `pre_patch` is invoked before the ftrace hooks are installed, and how a non-zero return aborts the transition

### Related pages

- [KLP Consistency Model](klp-consistency.md) — stack scanning, per-task state, forced transitions
- [Cumulative Patches and Atomic Replace](klp-cumulative.md) — `.replace=true`, `klp_get_prev_state()` in context
- [Kernel Live Patching](klp.md) — `struct klp_func`, `struct klp_patch`, ftrace redirection

### LWN articles

- [LWN: Live patching for CPU vulnerabilities](https://lwn.net/Articles/775264/) — Nicolai Stange's account of the L1TF/KPTI live patches, which had to flip global page-table semantics mid-transition using exactly the pre/post-patch callback pattern this page describes

### External

- [System State Changes — The Linux Kernel documentation](https://docs.kernel.org/livepatch/system-state.html) — upstream documentation for the `klp_state` API and its version-compatibility rules
- [(Un)patching Callbacks — The Linux Kernel documentation](https://docs.kernel.org/livepatch/callbacks.html) — upstream documentation for `pre_patch`/`post_patch`/`pre_unpatch`/`post_unpatch` semantics and use cases
