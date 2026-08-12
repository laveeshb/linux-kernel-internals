# The `NO_HANG` False Positive

> For years, `drm_sched`'s timeout handler had exactly one answer to "did the GPU hang": reset it. Three drivers needed to say "actually, it didn't," and the scheduler had no way for them to say so without leaking memory

Landed
:   Linux 6.17 (July 2025)

Drivers affected
:   v3d, Etnaviv, Xe

Author
:   Maíra Canal (Igalia)

Mechanism
:   `DRM_GPU_SCHED_STAT_NO_HANG`

Not a CVE

*Part of [War Stories: GPU/DRM Bugs and Regressions](../war-stories.md).*

## Before state

[Command Submission, `dma_fence`, and the GPU Scheduler](../command-submission.md) covers `drm_sched`'s timeout path: when a job's timeout elapses, `drm_sched_job_timedout()` calls the driver's `timedout_job()` callback, and — before this change — the scheduler always removed the job from `sched->pending_list` on the assumption that the driver's callback would either recover the hardware or the job was genuinely dead either way. `sched->ops->free_job()` only ever ran for jobs still on that list.

## The trigger

Maíra Canal's commit message for [`0b1217bfdfdd`](https://github.com/torvalds/linux/commit/0b1217bfdfddf664c15954d1d51ee18ed88a2ccf) ("drm/sched: Allow drivers to skip the reset and keep on running", July 2025) names two concrete scenarios where the scheduler's timeout firing didn't mean the GPU was actually hung:

1. **The job is still making progress, just slower than the timeout allows.** Some drivers — v3d, Etnaviv, and Xe are named explicitly — have a GPU-specific way to check whether hardware is still advancing even after the software timeout elapsed, and would rather tell the scheduler to keep treating the job as pending than force a reset on hardware that's working correctly.
2. **The timeout and the free-job worker raced.** If the scheduler's timeout fires right as a separate worker is already freeing a job that just finished, `sched->ops->timedout_job()` gets called for a job that was never actually timed out at all — it just lost a race with its own completion.

## Observed behavior

Both scenarios hit the same structural problem: the job had already been removed from `sched->pending_list` before the driver's `timedout_job()` callback even ran. When the driver correctly determined the job wasn't actually hung and the job later genuinely finished, there was no way for the scheduler to know to free it — `free_job()` only fires for jobs still tracked on the pending list. The job's memory leaked, silently, every time a driver hit either of these legitimate not-actually-hung cases.

## Why it happened

The scheduler's timeout handling had one bit of information to work with — the timeout elapsed — and one action available in response — treat the job as no longer scheduler-tracked. That was sufficient as long as "timeout elapsed" reliably meant "job is hung," which held for drivers with no way to independently verify hardware progress. It stopped holding once multiple drivers had GPU-specific liveness signals more reliable than the software timeout, and once the free-job race made even non-hung jobs able to trigger the same code path through pure timing rather than an actual hang.

## Resolution

`0b1217bfdfdd` adds a new `drm_gpu_sched_stat` value, `DRM_GPU_SCHED_STAT_NO_HANG`, that a driver's `timedout_job()` callback can return to tell the scheduler: reinsert this job into `sched->pending_list` and let it keep running to completion normally, rather than treating it as reset-and-gone. Two follow-up commits wired specific drivers to use it: [`6b37fbacd087`](https://github.com/torvalds/linux/commit/6b37fbacd087fbd517b6b276ca8bebd1dc052fb7) for v3d and [`8902c2b17a6e`](https://github.com/torvalds/linux/commit/8902c2b17a6ec723ab7924bc4113bef47603c0dc) for Etnaviv, each converting their driver-specific "is this job actually still progressing" check into a `NO_HANG` return instead of forcing a reset. The series was reviewed by Philipp Stanner and posted as `20250714-sched-skip-reset-v6-...@igalia.com`.

The Xe driver's own `NO_HANG` usage shows up later, inside the resolution of [The Xe TDR Recovery Regression Chain](xe-tdr-recovery-regression.md) — the same status value this series introduced is exactly what Xe's handler returns after the fix to that separate regression.

## What it taught us

**A scheduler API built around one binary signal ("hung or not") eventually meets drivers with better information than that signal alone provides.** v3d, Etnaviv, and Xe each had a real, driver-specific way to distinguish "timed out because it's hung" from "timed out because it's just slow, and I can prove it's still moving" — the scheduler had no vocabulary for the second case until this change gave it one.

**A race between two independent triggers for the same code path (a real timeout and a completion race) can be just as real a bug as either trigger alone**, and fixing only the "driver knows better" case without also covering the "timeout raced completion" case would have left a resource leak that wasn't even about driver knowledge — just timing.

!!! warning "Pattern to watch for"
    Any timeout-detection path that unconditionally treats "timeout fired" as "resource should be torn down/reset" is worth checking for a race between the timeout and the resource's own normal completion path — and for whether the thing being timed has a way to prove it's still making progress that the timeout mechanism doesn't know how to ask for.

## See also

- [Command Submission, `dma_fence`, and the GPU Scheduler](../command-submission.md) — the TDR/timeout mechanics and `drm_gpu_sched_stat` return values this page's fix extends
- [The Xe TDR Recovery Regression Chain](xe-tdr-recovery-regression.md) — a separate Xe-specific TDR regression that also returns `DRM_GPU_SCHED_STAT_NO_HANG`, on a different bug entirely

## External references

- [GitHub mirror: 0b1217bfdfdd](https://github.com/torvalds/linux/commit/0b1217bfdfddf664c15954d1d51ee18ed88a2ccf) — "drm/sched: Allow drivers to skip the reset and keep on running," the core `DRM_GPU_SCHED_STAT_NO_HANG` addition
- [GitHub mirror: 6b37fbacd087](https://github.com/torvalds/linux/commit/6b37fbacd087fbd517b6b276ca8bebd1dc052fb7) — "drm/v3d: Use DRM_GPU_SCHED_STAT_NO_HANG to skip the reset"
- [GitHub mirror: 8902c2b17a6e](https://github.com/torvalds/linux/commit/8902c2b17a6ec723ab7924bc4113bef47603c0dc) — "drm/etnaviv: Use DRM_GPU_SCHED_STAT_NO_HANG to skip the reset"
