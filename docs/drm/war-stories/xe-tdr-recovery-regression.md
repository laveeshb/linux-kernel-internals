# The Xe TDR Recovery Regression Chain

> A fix for one TDR bug on Intel Lunar Lake regressed a second time, and the fix for *that* regression crashed the kernel — three commits, twenty months, one driver

Landed
:   October 2024 – June 2026 (three-commit chain)

Driver
:   Intel Xe (Lunar Lake and later)

Authors
:   Matthew Brost, Rodrigo Vivi (Intel)

Actively causing hangs
:   yes, on affected hardware, until the final fix — not a CVE

*Part of [War Stories: GPU/DRM Bugs and Regressions](../war-stories.md).*

## Before state

[Command Submission, `dma_fence`, and the GPU Scheduler](../command-submission.md) covers TDR (timeout detection and recovery) mechanically: `drm_sched_job_timedout()` fires when a job's timeout elapses, and the driver's `timedout_job()` callback decides what happens next — reset the hardware, or tell the scheduler `DRM_GPU_SCHED_STAT_NO_HANG` and let the job keep running. Xe's `guc_exec_queue_timedout_job()` is that callback for jobs submitted through Intel's GuC firmware scheduler.

An earlier version of that callback treated a job that had never actually started running as a cheap case to skip: if the GuC hadn't even begun executing it, there was nothing to reset, so the handler could just let the timeout pass without further action.

## The trigger

On Lunar Lake, GuC could miss a GGTT (Global Graphics Translation Table) page update and simply never schedule a job at all. Because the callback specifically skipped jobs that hadn't started, this failure mode produced no recovery action whatsoever — the job sat forever, and nothing in the driver ever noticed.

Matthew Brost's fix, [`fe05cee4d953`](https://github.com/torvalds/linux/commit/fe05cee4d9533892210e1ee90147175d87e7c053) ("drm/xe: Don't short circuit TDR on jobs not started", October 2024), removed the short-circuit: on an unstarted job, the TDR now toggles scheduling to try to get the job unstuck, warns, and times the job out for real if a second TDR firing still finds it unstarted. That closed the original hang — and created the next one.

## Observed behavior

The revised handler now silently errored out an unstarted job instead of ever triggering a GT reset to actually recover the hardware. Rodrigo Vivi's fix nearly twenty months later, [`770031ec2312`](https://github.com/torvalds/linux/commit/770031ec2312bfab307d05db5469f24fd297e758) ("drm/xe: fix job timeout recovery for unstarted jobs and kernel queues", June 10, 2026), states the problem plainly: "A job that GuC never scheduled (never started) indicates a GuC scheduling failure; previously such jobs were silently errored out instead of triggering a GT reset to recover." For kernel queues — internal driver work, not user submissions — the fix goes further: they are "always recovered this way and wedge the device once recovery attempts are exhausted, since kernel work must not silently fail," in the commit's own words, unconditionally in a way a banned user queue's recovery isn't.

That fix itself had a sharp edge, caught in review: an unstarted job on a queue that was *already* banned had to be left alone. Clearing the ban or forcing a GT reset on an intentionally-banned queue would resurrect userspace work the kernel had deliberately killed, and could turn a single bad queue into a GT-reset storm. The v3 revision added that carve-out explicitly.

Two days after `770031ec2312` landed, it produced a crash of its own. [`d42df9dce7b3`](https://github.com/torvalds/linux/commit/d42df9dce7b374079c5c41691bd62d8765768a80) ("drm/xe: wedge from the timeout handler only after releasing the queue", June 12, 2026) quotes the fault directly:

```
Oops: general protection fault ... 0x6b6b6b6b6b6b6c3b
RIP: guc_exec_queue_timedout_job+...
```

`0x6b6b6b6b6b6b6c3b` is SLUB's poison pattern for freed memory — the handler was dereferencing a job that no longer existed.

## Why it happened

A kernel job that exhausted its recovery attempts called `xe_device_declare_wedged()` directly from inside `guc_exec_queue_timedout_job()`, while that same handler still held and was actively using the timed-out job and its scheduler. In Xe's default wedged mode, declaring the device wedged takes a destructive path that stops every queue's scheduler — including the one the TDR handler was still operating on — tearing down submission and signaling in-flight fences.

Control then returned to the handler, which kept using the now-stale job and scheduler: it called `drm_sched_for_each_pending_job()` on a scheduler that was no longer stopped (triggering a `WARN_ON`), and that iteration dereferenced a job the teardown had already freed. The wedge call was correct in isolation — it's the *right* thing to do when a kernel job can't be recovered — but calling it from inside a handler that still owned the very state it was about to tear down was not.

## Resolution

`d42df9dce7b3` moved the wedge call to fire only after the handler is done operating on the queue, immediately before returning `DRM_GPU_SCHED_STAT_NO_HANG`, so the teardown can no longer race the handler's own use of the job and scheduler. All three commits touch the same function, `guc_exec_queue_timedout_job()` in `drivers/gpu/drm/xe/xe_guc_submit.c`; the last two each carry a `Fixes:` tag pointing at the commit immediately before them in this chain (the first commit's own `Fixes:` tag points further back, to the original job-timeout-sampling commit this whole chain works around).

## What it taught us

**"Don't reset what isn't broken" and "always reset what's actually broken" are both correct, and the line between them is exactly where this regressed twice.** The original short-circuit skipped recovery for a case (unstarted jobs) that turned out to sometimes genuinely need it. The fix for that then recovered *every* unstarted job unconditionally, including ones that were unstarted because the kernel had deliberately banned them — recovering those was itself a bug.

**A handler that tears down state should not still be using that state afterward.** The final crash wasn't a logic error in *when* to wedge the device — it was a lifetime error in *where*, relative to code still holding references into what wedging would free.

!!! warning "Pattern to watch for"
    Any timeout/recovery callback that can itself trigger a broader teardown (device wedge, GT reset, scheduler stop) needs to either finish using its own local state *before* triggering that teardown, or defer the teardown until after it returns. Grep for `_declare_wedged()`, `_reset()`, or similar destructive calls made from inside a `timedout_job()`-style callback while local job/queue/scheduler pointers are still in scope below that call.

## See also

- [Command Submission, `dma_fence`, and the GPU Scheduler](../command-submission.md) — the TDR mechanism this regression lives inside, and the `DRM_GPU_SCHED_STAT_NO_HANG` status this driver ultimately returns
- [The `NO_HANG` False Positive](no-hang-false-positive.md) — a separate story about the same status value, on different drivers
- [KMS Object Model and Atomic Modesetting](../kms.md) — the display side of the same subsystem

## External references

- [GitHub mirror: fe05cee4d953](https://github.com/torvalds/linux/commit/fe05cee4d9533892210e1ee90147175d87e7c053) — "drm/xe: Don't short circuit TDR on jobs not started"
- [GitHub mirror: 770031ec2312](https://github.com/torvalds/linux/commit/770031ec2312bfab307d05db5469f24fd297e758) — "drm/xe: fix job timeout recovery for unstarted jobs and kernel queues"
- [GitHub mirror: d42df9dce7b3](https://github.com/torvalds/linux/commit/d42df9dce7b374079c5c41691bd62d8765768a80) — "drm/xe: wedge from the timeout handler only after releasing the queue," including the full GPF trace
