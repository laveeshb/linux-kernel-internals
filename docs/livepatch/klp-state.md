# KLP State: Custom Consistency Checks

> The klp_state API for patches that need more than stack scanning

## The problem with stack scanning alone

The standard KLP consistency model — scanning every task's stack and waiting
until no task is executing the old function — is sufficient for most patches.
A patch that simply fixes a logic error inside a single function can rely
entirely on the stack-based transition: once no task is mid-execution in the
old function body, it is safe to switch everyone to the new one.

But some patches change things that stack scanning cannot detect:

- A patch that changes which lock protects a shared structure: old code takes
  a `spinlock_t`, new code wants to hold a `mutex` so the critical section can
  sleep. The consistency model deliberately runs old and new code side by side
  until the last task has switched, and during that window neither lock
  excludes the other.
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
   fully active. Note the signature above: it returns `void`. By this point
   the patch is applied and there is no mechanism to back out, so a
   `post_patch` callback has no way to report failure and must be written so
   that it cannot fail.

The call order during a reverse transition (disabling a patch):

1. `pre_unpatch(obj)` — called from `__klp_disable_patch()`
   (`kernel/livepatch/core.c`) *before* `klp_start_transition()`, so it runs
   while every task is still executing patched code.
2. The reverse transition runs.
3. ftrace hooks are removed — `klp_complete_transition()` calls
   `klp_unpatch_objects()` (`kernel/livepatch/transition.c`).
4. `post_unpatch(obj)` — called at the end of `klp_complete_transition()`,
   after step 3, so the patched code is already unreachable by the time it
   runs. It only fires if this object's `pre_patch` callback previously
   succeeded: `klp_pre_patch_callback()` records that in the
   `post_unpatch_enabled` flag (`kernel/livepatch/core.h`).

## klp_get_state() and klp_get_prev_state()

Two helpers provide access to state data from within the callbacks:

```c
/* include/linux/livepatch.h (declared here; implemented in kernel/livepatch/state.c) */
struct klp_state *klp_get_state(struct klp_patch *patch, unsigned long id);
struct klp_state *klp_get_prev_state(unsigned long id);
```

`klp_get_state(patch, id)` returns the `klp_state` with the given `id` from
`patch->states`. It returns `NULL` if no state with that id exists.

`klp_get_prev_state(id)` searches the *already installed* patches for a
`klp_state` with the given `id`. It walks the global patch list in order,
stops when it reaches the patch that is currently transitioning
(`klp_transition_patch`), and returns the **last** match found along the way —
not simply "the previous patch". More than one older patch can declare the
same id; the kernel-doc in `kernel/livepatch/state.c` notes that "the same
system state can be modified by more non-cumulative livepatches" and that "it
is expected that the latest livepatch has the most up-to-date information".
This is what a cumulative patch uses to inherit state (counters, flags,
allocated data) from the patches it supersedes.

Neither function takes or asserts `klp_mutex`; their real preconditions
differ. `klp_get_state()` is a plain walk of `patch->states`, and its
kernel-doc says it "can be called either from pre/post (un)patch callbacks or
from the kernel code added by the livepatch". `klp_get_prev_state()` is
stricter: it reads the global `klp_transition_patch` and opens with
`WARN_ON_ONCE(!klp_transition_patch)`, returning `NULL` if it is unset. It may
therefore only be called while a transition is actually in progress — in
practice, from inside the callbacks, and not from patched code at runtime.

## Example: switching a subsystem from a spinlock to a mutex

Consider a subsystem whose shared table is protected by `subsys_spinlock`. A
patch wants a `mutex` instead, so the critical section can sleep. The two lock
disciplines cannot simply be swapped over: for as long as the transition is
running, some tasks are on old code and some are on new code, so an old-code
caller holding `subsys_spinlock` and a new-code caller holding `subsys_mutex`
would each believe it owns the table.

No callback can make that window disappear — the mixed window is the
consistency model working as designed. What the callbacks *can* do is make the
new code cope with the window and then retire it. That is the pattern
`Documentation/livepatch/system-state.rst` §4 prescribes, and the one Nicolai
Stange's L1TF/KPTI live patches used:

1. Patch every accessor so it can handle **both** the old and the new
   semantics, selected at runtime by a flag. While the flag is clear, the new
   accessor keeps obeying the old locking rules.
2. Let the transition finish. Only then, from `post_patch()`, set the flag.
   Because the consistency model guarantees no task is on old code by that
   point, an old-code caller can never observe the new semantics.
3. On the way out, clear the flag from `pre_unpatch()` — which runs *before*
   the reverse transition starts, while every task is still on new code — so
   no task can be back on old code while the new semantics are still live.

The flag itself must be read and written under a lock that actually excludes
the callers it arbitrates. Here that lock is `subsys_mutex`, which the patched
accessor holds across both the flag read and the table access in *either*
mode, so a flip can never land in the middle of a critical section.

This also assumes every caller of `subsys_do_work()` is allowed to sleep —
which it must be, or wanting a mutex there would make no sense in the first
place.

```c
#include <linux/livepatch.h>
#include <linux/mutex.h>
#include <linux/spinlock.h>

/* id=1 identifies "the subsystem table's lock discipline" */
#define SUBSYS_LOCK_STATE_ID  1UL

/*
 * Forward-declared: the callbacks below look up their own patch's state
 * via klp_get_state(&subsys_patch, ...), but the full struct klp_patch
 * definition (which needs the callbacks and objects defined first) only
 * comes together at the end of the file -- the same end-of-file
 * struct-definition order real livepatch modules use (most samples, e.g.
 * samples/livepatch/livepatch-callbacks-demo.c, don't need a forward
 * declaration since their callbacks don't reference their own patch
 * struct by address, but a klp_state user that calls
 * klp_get_state(&this_patch, ...) does).
 */
static struct klp_patch subsys_patch;

/*
 * Pre-existing vmlinux symbols the patch module reaches through KLP
 * relocations -- their definitions are omitted here for brevity, the same
 * way subsys_patch_v2 is omitted later on this page.
 */
extern spinlock_t subsys_spinlock;
extern void subsys_update_table(void);       /* the existing, atomic update */
extern void subsys_update_table_slow(void);  /* may sleep; the point of the patch */

/* Everything below is new and lives in the patch module. */
static DEFINE_MUTEX(subsys_mutex);

/*
 * false = mixed mode. Unpatched code may still be running and still guards
 *         the table with subsys_spinlock alone, so the patched accessor
 *         must take it too, and must not sleep.
 * true  = the forward transition is complete and only patched code is live,
 *         so subsys_mutex alone suffices and the critical section may sleep.
 *
 * Read and written ONLY under subsys_mutex. See the note after this listing.
 */
static bool subsys_use_mutex;

/* Replacement for subsys_do_work(): implements both semantics. */
static void patched_subsys_do_work(void)
{
    mutex_lock(&subsys_mutex);

    if (!subsys_use_mutex) {
        /* Mixed mode: interlock with the still-live original code. */
        spin_lock(&subsys_spinlock);
        subsys_update_table();
        spin_unlock(&subsys_spinlock);
    } else {
        /* Only patched callers remain; the mutex alone is enough. */
        subsys_update_table_slow();
    }

    mutex_unlock(&subsys_mutex);
}

static int pre_patch_subsys(struct klp_object *obj)
{
    struct klp_state *state;

    state = klp_get_state(&subsys_patch, SUBSYS_LOCK_STATE_ID);
    if (!state)
        return -EINVAL;

    /*
     * pre_patch() prepares; it must not change the semantics yet, because
     * the original code is still live and cannot cope with mutex-only
     * locking. Record only that the hand-off has not happened.
     */
    state->data = (void *)0UL;

    return 0;
}

/*
 * post_patch() and pre_unpatch() can dereference the lookup without a NULL
 * check: neither runs for an object whose pre_patch() returned an error
 * (kernel/livepatch/core.c and core.h), and pre_patch_subsys() already
 * refused the patch if the state was missing.
 */
static void post_patch_subsys(struct klp_object *obj)
{
    struct klp_state *state = klp_get_state(&subsys_patch,
                                            SUBSYS_LOCK_STATE_ID);

    /*
     * The transition is complete: no task is executing the original
     * subsys_do_work() any more, so nothing can still be guarding the
     * table with subsys_spinlock alone. Taking subsys_mutex waits out any
     * patched caller already inside its critical section, so the flip
     * cannot land between a caller's flag read and its table access --
     * both happen inside one mutex hold.
     *
     * post_patch() runs in process context, from klp_complete_transition()
     * on either the enabling task or the transition workqueue, so sleeping
     * on the mutex here is allowed.
     */
    mutex_lock(&subsys_mutex);
    subsys_use_mutex = true;
    state->data = (void *)1UL;   /* hand-off done */
    mutex_unlock(&subsys_mutex);
}

static void pre_unpatch_subsys(struct klp_object *obj)
{
    struct klp_state *state = klp_get_state(&subsys_patch,
                                            SUBSYS_LOCK_STATE_ID);

    /*
     * Symmetric to post_patch_subsys(), and it has to run *here*:
     * __klp_disable_patch() calls pre_unpatch before klp_start_transition(),
     * while every task is still on patched code. Clearing the flag now means
     * that by the time any task is back on the original spinlock-only code,
     * every remaining patched caller is taking subsys_spinlock again too.
     */
    mutex_lock(&subsys_mutex);
    subsys_use_mutex = false;
    state->data = (void *)0UL;
    mutex_unlock(&subsys_mutex);
}

/*
 * There is deliberately no post_unpatch callback. klp_complete_transition()
 * calls klp_unpatch_objects() -- tearing down the ftrace redirection -- before
 * it invokes the post_unpatch callbacks, so by then nothing can be executing
 * patched_subsys_do_work() and a flag write there would be dead code. The
 * revert already happened in pre_unpatch_subsys(), which is exactly the
 * symmetry Documentation/livepatch/system-state.rst describes: pre_unpatch()
 * mirrors post_patch(), and post_unpatch() "might mean doing nothing".
 */

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
            .pre_patch   = pre_patch_subsys,
            .post_patch  = post_patch_subsys,
            .pre_unpatch = pre_unpatch_subsys,
            /* .post_unpatch deliberately unset -- see above */
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

The whole protocol rests on one rule: `subsys_use_mutex` is read and written
only under `subsys_mutex`, and the accessor holds that mutex across both the
read and the table access. Publishing the flip under some other lock — or
reading the flag outside the mutex — reopens exactly the race it exists to
close: a caller could read `false`, be preempted before reaching
`spin_lock()`, and resume after the flip, while a second caller that read
`true` is already inside the mutex-only critical section. Both would then be
touching the table at once. Because the flip has to acquire the same mutex the
accessor holds for its whole critical section, that interleaving is
unreachable.

The design also survives a reversed transition, which the callbacks get for
free. If the forward transition is reversed before it completes (`echo 0 >
.../enabled` while `transition` still reads 1), `post_patch` never ran, so the
flag was never set and there is nothing to undo. If a *disable* is reversed
back to patching, `pre_unpatch` has already cleared the flag and
`klp_complete_transition()` runs `post_patch` again on the way back in, which
re-establishes it — under the mutex, after the consistency model has again
confirmed no task is on old code.

If `pre_patch_subsys` returns a non-zero value — for example, because
`klp_get_state()` can't find the state entry it expects —
`klp_enable_patch()` propagates that error to `insmod` and no hooks are
installed. The system stays on the old code path with no partial state.

## klp_state and cumulative patches

When a cumulative patch replaces an earlier patch that also used `klp_state`,
the new patch can inherit the previous patch's state data via
`klp_get_prev_state()`. This allows multi-version migrations where each
successive patch builds on the state established by its predecessor:

The inheritance itself belongs in `post_patch()`, not `pre_patch()`.
`system-state.rst` §4 lists "Copy *state->data* from the previous livepatch
when they are compatible" under `post_patch()`, for the same reason the main
example flips its flag there: until the transition completes, the older
patch's code is still live and still owns the state it is describing.
`pre_patch()` is where allocation goes, because it is the only callback that
can still refuse the load.

```c
/* subsys_patch_v2: the new, replacing patch's own struct klp_patch,
 * declared the same way subsys_patch was above -- omitted here for
 * brevity. */
static int pre_patch_v2(struct klp_object *obj)
{
    struct klp_state *cur;

    cur = klp_get_state(&subsys_patch_v2, SUBSYS_LOCK_STATE_ID);
    if (!cur)
        return -EINVAL;

    /*
     * Allocate anything the new state format needs here -- this is the
     * only callback that can still fail the load. Do NOT take over the
     * previous patch's state yet: its code is still running.
     */
    return 0;
}

static void post_patch_v2(struct klp_object *obj)
{
    struct klp_state *prev, *cur;

    cur  = klp_get_state(&subsys_patch_v2, SUBSYS_LOCK_STATE_ID);
    prev = klp_get_prev_state(SUBSYS_LOCK_STATE_ID);

    /*
     * klp_get_prev_state() still works here: klp_complete_transition()
     * clears klp_transition_patch only *after* running the post_patch
     * callbacks, and the replaced patches are not freed until it returns.
     */
    if (prev)
        cur->data = prev->data;
}
```

Copying `prev->data` verbatim is only safe when it carries a *value*, as the
encoded flag in the earlier example does. If the older patch stored a pointer,
ownership has to be settled explicitly. Once the atomic replace completes the
older patch is disabled and its module can be unloaded: a `state->data` that
points into that module's own storage becomes a dangling pointer, and memory
it had allocated becomes a leak that only the new patch is still in a position
to release. That is what `system-state.rst`'s remaining `post_patch()` bullet
— "Free *state->data* from replaces livepatches when they are not longer
needed" — is asking for. The robust form is to allocate in `pre_patch_v2()`
(where failure can still abort the load), copy the *contents* in
`post_patch_v2()`, and free the older patch's allocation there.

Unlike the main example, this one does need a `post_unpatch_v2()`: if
`pre_patch_v2()` allocates and the enable is later reversed before
`post_patch_v2()` runs, that allocation has no other release point.
`system-state.rst` notes `post_unpatch()` "typically does symmetric
operations to `pre_patch()`" for exactly this reason — free here whatever
`pre_patch_v2()` allocated, mirroring `pre_patch_subsys()`'s "clean up its own
mess" obligation on error.

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
flag outright, and it permanently pins whichever patch modules it marks.
Which patch gets marked depends on what was being forced —
`klp_force_transition()` (`kernel/livepatch/transition.c`) sets
`forced = true` on:

- the patch being disabled, when a *disable* (unpatch) transition is forced;
- every **other** installed patch — the ones being replaced — when the enable
  of a cumulative (`.replace = true`) patch is forced, but not on the new
  patch itself;
- nothing at all, when the enable of a non-cumulative patch is forced.

`klp_free_patch_finish()` (`kernel/livepatch/core.c`) then skips the
`module_put()` for any patch with `forced` set, so that module's reference
count never falls back to zero and `rmmod` on it fails for the lifetime of the
running kernel.

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
