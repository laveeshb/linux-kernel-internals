# The msm GPU Recovery/Shrinker Deadlock

> A hung-GPU recovery worker allocated memory while holding the very lock the job-running thread needed, and that allocation triggered a shrinker that waited on the fences the stuck job would have signaled

Landed
:   April 2026 (Linux 7.1)

Driver
:   msm (Qualcomm Adreno)

Author
:   Sergey Senozhatsky (Google/ChromeOS)

Fixed in
:   [`4625fe5bbdac`](https://github.com/torvalds/linux/commit/4625fe5bbdaccd45be274c30ff0a42e30d4e38cf)

Not a CVE

*Part of [War Stories: GPU/DRM Bugs and Regressions](../war-stories.md).*

## Before state

[Command Submission, `dma_fence`, and the GPU Scheduler](../command-submission.md) documents the cross-driver `dma_fence` signaling contract: because `dma_fence` waits are load-bearing all the way down into memory reclaim — the page allocator itself can end up waiting on a GPU fence to make forward progress — code that could block a fence signal "must not take a `dma_resv` lock, must not allocate with `GFP_KERNEL`, and must not allocate with `GFP_NOFS`/`GFP_NOIO` either," in that page's words. This incident is a variant of the same hazard one level removed: not an allocation directly on the signaling path, but an allocation made while holding a lock the signaling thread itself needed.

msm's GPU hangcheck mechanism detects a stuck ring by comparing the fence the GPU last completed against the fence it was last asked to submit. When hangcheck fires, a recovery worker takes `gpu->lock`, captures a crash-state dump for debugging, and attempts to reset and restart the ring.

## The trigger

Capturing that crash-state dump calls `kvmalloc_node()` to allocate the dump buffer — a plain kernel allocation, made while still holding `gpu->lock`. Under enough memory pressure, that allocation entered direct reclaim, which invoked msm's own GEM shrinker (`msm_gem_shrinker_scan()`), which in turn called `drm_gem_lru_scan()` → `active_purge()`, which waits on `dma_resv_wait_timeout()` for outstanding fences to signal before it can reclaim their pages.

## Observed behavior

Sergey Senozhatsky's fix commit quotes the actual symptom directly from a device stuck in this state — repeated hangcheck firings that never resolved:

```
[..]
msm_dpu ae01000.display-controller: [drm:hangcheck_handler] *ERROR* (IPv4: 1): hangcheck detected gpu lockup rb 0!
msm_dpu ae01000.display-controller: [drm:hangcheck_handler] *ERROR* (IPv4: 1): completed fence: 7840161
msm_dpu ae01000.display-controller: [drm:hangcheck_handler] *ERROR* (IPv4: 1): submitted fence: 7840162
msm_dpu ae01000.display-controller: [drm:hangcheck_handler] *ERROR* (IPv4: 1): hangcheck detected gpu lockup rb 0!
msm_dpu ae01000.display-controller: [drm:hangcheck_handler] *ERROR* (IPv4: 1): completed fence: 7840162
msm_dpu ae01000.display-controller: [drm:hangcheck_handler] *ERROR* (IPv4: 1): submitted fence: 7840163
[..]
```

The commit message also includes the hung-task dump for both blocked threads. The job-running kernel thread, blocked over two minutes on the mutex the recovery worker held:

```
INFO: task ring0:155 blocked for more than 122 seconds.
...
task:ring0 state:D stack:0 pid:155 ppid:2 flags:0x00000008
Call trace:
...
__mutex_lock_slowpath+0x28/0x40
mutex_lock+0x5c/0x90
msm_job_run+0x9c/0x140
drm_sched_main+0x514/0x938
...
```

And the recovery worker, itself blocked waiting on a fence inside memory reclaim, while still holding that same mutex:

```
...
task:gpu-worker state:D stack:0 pid:154 ppid:2 flags:0x00000008
Call trace:
...
dma_fence_default_wait+0x108/0x218
dma_fence_wait_timeout+0x6c/0x1c0
dma_resv_wait_timeout+0xe4/0x118
active_purge+0x34/0x98
drm_gem_lru_scan+0x1d0/0x388
msm_gem_shrinker_scan+0x1cc/0x2e8
shrink_slab+0x228/0x478
...
__vmalloc_node_range+0x1c0/0x420
kvmalloc_node+0xe8/0x108
msm_gpu_crashstate_capture+0x1e4/0x280
recover_worker+0x1c0/0x638
...
```

The cycle closes exactly the way the `dma_fence` contract warns against: the job thread needed `gpu->lock` to make progress and signal its fence; the recovery worker held `gpu->lock` and needed that same fence (via the shrinker's reclaim wait) to finish its allocation and release the lock. Neither side could proceed. "So no one can make any further progress," in the commit's own words.

## Why it happened

The crash-dump allocation was ordinary code, written without any thought to `dma_fence` or reclaim, because on its face `msm_gpu_crashstate_capture()` has nothing to do with fences — it's diagnostic tooling, not the fast path. The danger was entirely in what that allocation could transitively trigger under memory pressure: reclaim, into the GPU's own shrinker, into a fence wait — while the allocating thread's own held lock was exactly what the thread that would signal that fence needed to proceed. Nothing about the allocation call site looks unsafe in isolation; the hazard is only visible in the reachable call graph under load, which is why the cross-driver `dma_fence` contract calls out reclaim-adjacent allocation explicitly rather than leaving it to be rediscovered per driver.

## Resolution

`4625fe5bbdac` ("drm: gpu: msm: forbid mem reclaim from reset") forbids the recover/fault worker from entering memory reclaim while holding `gpu->lock`, breaking the cycle at the allocation rather than at the locking or the shrinker. Reviewed by Rob Clark, msm's maintainer.

## What it taught us

**A lock held across an allocation can create a `dma_fence` deadlock even when the allocating code never touches a fence directly.** `msm_gpu_crashstate_capture()` doesn't call any `dma_fence` API. The deadlock came from what its allocation could trigger — reclaim, into the driver's own shrinker — while the lock it ran under blocked the one thread that could have unblocked that reclaim by signaling its fence.

**Diagnostic/error-handling code paths are exactly where this rule gets missed**, because they're written to run *after* something has already gone wrong, under the assumption that correctness matters more than performance there — which is true, but doesn't exempt them from the locking and allocation constraints of the code they're recovering.

!!! warning "Pattern to watch for"
    Any allocation made while holding a lock that a job-completion or fence-signaling path also needs is a potential reclaim-triggered deadlock, even if the allocating code has no direct connection to fences. Trace what the allocation can transitively trigger (shrinkers, reclaim, other drivers' GEM/TTM shrinkers) under memory pressure, not just what it does in the common case.

## See also

- [Command Submission, `dma_fence`, and the GPU Scheduler](../command-submission.md) — the `dma_fence` cross-driver signaling contract this bug violated
- [GEM Buffer Objects and dma-buf Sharing](../gem-dmabuf.md) — GEM shrinkers and the `dma_resv` fence lists they interact with
- [The Xe TDR Recovery Regression Chain](xe-tdr-recovery-regression.md) — a different driver's recovery-path bug, in the same TDR/hangcheck family

## External references

- [GitHub mirror: 4625fe5bbdac](https://github.com/torvalds/linux/commit/4625fe5bbdaccd45be274c30ff0a42e30d4e38cf) — "drm: gpu: msm: forbid mem reclaim from reset," including both hung-task traces
