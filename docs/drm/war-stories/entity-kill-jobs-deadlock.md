# The `drm_sched_entity_kill_jobs_cb` Lockdep Deadlock

> A fence-signaling callback running in interrupt context tried to take a lock that ordinary process context also held without disabling interrupts — a classic interrupt-unsafe locking bug, caught by lockdep on a real user's machine

Landed
:   November 2025 (backported to stable 6.2+)

Scheduler
:   `drm_sched`, shared across every driver using the common DRM scheduler

Author
:   Pierre-Eric Pelloux-Prayer (AMD)

Reported by
:   Mikhail Gavrilov, via [Mesa issue #13908](https://gitlab.freedesktop.org/mesa/mesa/-/issues/13908)

Fixed in
:   [`487df8b69834`](https://github.com/torvalds/linux/commit/487df8b698345dd5a91346335f05170ed5f29d4e)

Not a CVE

*Part of [War Stories: GPU/DRM Bugs and Regressions](../war-stories.md).*

## Before state

When a `drm_sched` entity is torn down — a process exits, a context is destroyed — any jobs still queued on that entity need to be cleaned up. `drm_sched_entity_kill_jobs_cb()` handles that: it runs as a callback attached to a job's dependency fence, walks the entity's remaining `job->dependencies` (stored in an `xarray`), and re-arms the cleanup on the next dependency.

`job->dependencies` is protected by the xarray's own internal spinlock, `xa_lock`. Ordinary code that adds to it — `drm_sched_job_add_dependency()`, and `drm_sched_entity_kill_jobs_cb()` itself when it iterates — used the plain `xa_*` accessors, which take `xa_lock` without disabling interrupts.

## The trigger

`drm_sched_entity_kill_jobs_cb()` is registered as a `dma_fence` callback, which means it can run from `dma_fence_signal()` — in interrupt context. Mikhail Gavrilov filed a bug against Mesa after lockdep caught the resulting interrupt-unsafe locking pattern on real hardware, with the full scenario captured in the trace:

```
Possible interrupt unsafe locking scenario:

      CPU0                    CPU1
      ----                    ----
 lock(&xa->xa_lock#17);
                              local_irq_disable();
                              lock(&fence->lock);
                              lock(&xa->xa_lock#17);
 <Interrupt>
   lock(&fence->lock);

*** DEADLOCK ***
```

CPU0 is any ordinary process-context function touching `job->dependencies` through the non-IRQ-safe `xa_*` accessors. CPU1 is `drm_sched_entity_kill_jobs_cb()`, running as a fence callback in interrupt context, which needs the same `xa_lock` CPU0 already holds — and if the interrupt lands on CPU0 mid-hold, CPU1 spins forever waiting for a lock CPU0 can't release until the interrupt handler returns, which itself is waiting on CPU1.

## Observed behavior

Christian König identified a second, independent way the same function could deadlock, even if the interrupt-safety of the xarray locking were fixed on its own: `dma_fence_signal()` itself takes `fence.lock` before invoking callbacks, and `drm_sched_entity_kill_jobs_cb()`'s own iteration calls `dma_fence_add_callback()` on each dependency — which also takes *that* fence's `lock`. If the fence currently signaling and a fence being newly waited-on during cleanup happened to share the same underlying spinlock, the callback would deadlock against the very signal that invoked it:

```
dma_fence_signal() // locks f1.lock
-> drm_sched_entity_kill_jobs_cb()
-> foreach dependencies
   -> dma_fence_add_callback() // locks f2.lock
```

So there were two independent deadlock shapes rooted in the same design choice: doing xarray iteration and fence-callback registration directly inside a callback that's already running with a fence lock held, in interrupt context.

## Why it happened

Switching every `xa_*` call to its interrupt-safe `xa_*_irq` counterpart would have fixed the first deadlock alone, but not the second — the fence-lock nesting problem is structural to running that logic *at all* inside a signaling callback, no matter how carefully the xarray locking is made interrupt-safe. A partial fix (irq-safe xarray accessors only) would have looked complete under the lockdep trace that motivated it, while leaving the fence-lock nesting hazard Christian König spotted entirely unaddressed.

## Resolution

`487df8b69834` moves the dependency-iteration and re-arming logic out of the fence-signaling callback entirely, into a new `drm_sched_entity_kill_jobs_work()` run as ordinary work, not as a callback invoked directly from `dma_fence_signal()`. That sidesteps both deadlock shapes at once: work-queue context isn't interrupt context, so the xarray locking is no longer interrupt-unsafe, and it isn't running with any fence's `lock` already held, so the nested `dma_fence_add_callback()` calls can't collide with the fence that triggered the callback. The fix carries `Cc: stable@vger.kernel.org # v6.2+` and `Fixes: 2fdb8a8f07c2` ("drm/scheduler: rework entity flush, kill and fini"), the commit that had originally introduced this cleanup path.

## What it taught us

**A fix scoped to the bug lockdep actually reported can still leave a structurally identical bug standing.** The interrupt-unsafe xarray locking was the finding; the fence-lock nesting was a second, independent deadlock in the same function that required looking past the specific lockdep splat to the shape of the code around it.

**Code that runs as a `dma_fence` signaling callback inherits interrupt-context and lock-nesting constraints it may not obviously look like it needs**, especially when that code was originally written as ordinary cleanup logic and only later became reachable from a signaling path as the surrounding code evolved — `2fdb8a8f07c2`'s "rework" put this logic where it is; the deadlock wasn't there from day one.

!!! warning "Pattern to watch for"
    Any logic invoked as a `dma_fence` callback — directly registered via `dma_fence_add_callback()`, or reached through one — runs in whatever context the fence signals from, which can be interrupt context. Grep for locking calls (`xa_lock`, spinlocks, mutexes) inside fence-callback functions that don't use their `_irq`/`_irqsave` variants, and check whether the callback itself calls back into fence machinery that could nest against the signaling fence's own lock.

## See also

- [Command Submission, `dma_fence`, and the GPU Scheduler](../command-submission.md) — `dma_fence` signaling, callbacks, and the cross-driver contract this bug's fix now honors
- [The msm GPU Recovery/Shrinker Deadlock](msm-shrinker-deadlock.md) — a different `dma_fence`-adjacent deadlock, on the reclaim side rather than the interrupt-safety side
- [RCU (Read-Copy-Update)](../../locking/rcu.md) and [Atomic Operations and Memory Barriers](../../locking/atomics.md) — general background on interrupt-context locking hazards

## External references

- [GitHub mirror: 487df8b69834](https://github.com/torvalds/linux/commit/487df8b698345dd5a91346335f05170ed5f29d4e) — "drm/sched: Fix deadlock in drm_sched_entity_kill_jobs_cb," full lockdep trace and both deadlock scenarios
- [Mesa GitLab issue #13908](https://gitlab.freedesktop.org/mesa/mesa/-/issues/13908) — Mikhail Gavrilov's original report
