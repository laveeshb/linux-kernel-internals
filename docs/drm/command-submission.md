# Command Submission, Fences, and the GPU Scheduler

> How a batch of GPU work gets from an ioctl to hardware execution — and what happens when it never comes back

## The problem: the kernel can't read the command stream, but it still has to schedule it

The [DRM overview](README.md) makes the split clear: userspace (Mesa) builds the hardware's native command buffers, and the kernel doesn't inspect them. But "doesn't inspect" is not the same as "doesn't manage." Between the ioctl and the hardware there is a long list of things only the kernel can do — decide which of several competing clients gets the ring next, make sure a submission doesn't start before the buffers it reads have finished being written by somebody else's submission, keep the buffers it touches resident until it's done, and notice when a submission has been sitting on the hardware for seconds and is never going to finish.

That machinery divides into three pieces, and this page follows them in order:

- **Command submission** — a driver-specific ioctl that turns a userspace-built command buffer into a kernel-tracked **job**.
- **`struct dma_fence`** — the one-shot completion primitive every wait in the GPU stack reduces to. [GEM and dma-buf](gem-dmabuf.md) introduced it as the thing stored in a buffer's `dma_resv`; here we go into how a fence actually gets signaled.
- **`drm_sched`** — the shared GPU scheduler in `drivers/gpu/drm/scheduler/`, which owns the queue between "userspace submitted a job" and "the driver pushed it at hardware," including the timeout that fires when hardware stops answering.

Code and struct layouts on this page are from **Linux 7.1** unless noted; the scheduler is under active redesign and the last section flags what has already changed in mainline since.

## Command submission: driver-specific by design

There is no generic "submit rendering" ioctl. Each driver defines its own, because the shape of a submission is a property of the hardware: how many independent engines it has, whether it takes a GPU virtual address or a buffer handle, whether it needs an explicit residency list. LWN's ["The Linux graphics stack in a nutshell, part 1"](https://lwn.net/Articles/955376/) (Thomas Zimmermann, December 19, 2023) puts it plainly for the render path: *"It's again all specific to the hardware and provided as `ioctl()` operations by each DRM driver individually. As with buffer allocation, the hardware driver within Mesa invokes the DRM driver's `ioctl()` operations."*

amdgpu's is `DRM_IOCTL_AMDGPU_CS` ("command submission"), and it's a good representative because it's the driver the scheduler was originally written for. The uAPI (`include/uapi/drm/amdgpu_drm.h`) is deliberately open-ended — a small fixed header plus an array of variable-length, tagged **chunks**:

```c
// include/uapi/drm/amdgpu_drm.h
struct drm_amdgpu_cs_in {
	__u32		ctx_id;           /* rendering context id */
	__u32		bo_list_handle;   /* resource list associated with this CS */
	__u32		num_chunks;
	__u32		flags;
	__u64		chunks;           /* points to __u64 * which point to cs chunks */
};

struct drm_amdgpu_cs_chunk {
	__u32		chunk_id;         /* AMDGPU_CHUNK_ID_* */
	__u32		length_dw;
	__u64		chunk_data;
};

struct drm_amdgpu_cs_out {
	__u64 handle;                     /* sequence number to wait on later */
};
```

The chunk IDs are what carry the actual meaning:

```c
#define AMDGPU_CHUNK_ID_IB			0x01
#define AMDGPU_CHUNK_ID_FENCE			0x02
#define AMDGPU_CHUNK_ID_DEPENDENCIES		0x03
#define AMDGPU_CHUNK_ID_SYNCOBJ_IN		0x04
#define AMDGPU_CHUNK_ID_SYNCOBJ_OUT		0x05
#define AMDGPU_CHUNK_ID_BO_HANDLES		0x06
#define AMDGPU_CHUNK_ID_SCHEDULED_DEPENDENCIES	0x07
#define AMDGPU_CHUNK_ID_SYNCOBJ_TIMELINE_WAIT	0x08
#define AMDGPU_CHUNK_ID_SYNCOBJ_TIMELINE_SIGNAL	0x09
#define AMDGPU_CHUNK_ID_CP_GFX_SHADOW		0x0a
```

An **IB chunk** (`struct drm_amdgpu_cs_chunk_ib`) is the command buffer itself — but note what it actually contains: `va_start` (a GPU *virtual* address to begin executing at), `ib_bytes`, and `ip_type`/`ip_instance`/`ring` naming which hardware engine to run on. On the graphics and compute rings the kernel never reads the packets at that address; it just needs the buffers to be resident and the page tables to be right, which is exactly the isolation model the [overview](README.md) describes. (UVD/VCE video rings are the exception: `amdgpu_cs_patch_jobs()` — next in the call sequence below — actually parses or in-place patches those command streams, since that hardware needs it.) **`BO_HANDLES`** is the residency list. **`DEPENDENCIES`** names fences to wait for by `(ctx_id, ip_type, ip_instance, ring, handle)` — amdgpu's own per-context sequence numbers, the same values earlier submissions got back in `cs_out.handle`. The **`SYNCOBJ_*`** chunks are the driver-independent equivalent: `SYNCOBJ_IN` for fences to wait on, `SYNCOBJ_OUT` for fences to signal, with the `TIMELINE_` variants adding a `point` for timeline `drm_syncobj`s.

`amdgpu_cs_ioctl()` (`drivers/gpu/drm/amd/amdgpu/amdgpu_cs.c`) runs the whole thing as a fixed pipeline, and the function names read like a table of contents:

```c
	r = amdgpu_cs_parser_init(&parser, adev, filp, data);   /* look up ctx, reject a guilty one */
	r = amdgpu_cs_pass1(&parser, data);                     /* copy chunks in, allocate jobs */
	r = amdgpu_cs_pass2(&parser);                           /* interpret each chunk */
	r = amdgpu_cs_parser_bos(&parser, data);                /* lock + validate the BO list */
	r = amdgpu_cs_patch_jobs(&parser);                      /* parse/patch IBs -- UVD/VCE only */
	r = amdgpu_cs_vm_handling(&parser);                     /* page-table updates */
	r = amdgpu_cs_sync_rings(&parser);                      /* collect dependencies */
	r = amdgpu_cs_submit(&parser, data);                    /* arm + push to the scheduler */
```

The two-pass split exists because pass 1 has to know how many distinct engines the submission targets before it can allocate anything: `amdgpu_cs_job_idx()` maps each IB chunk's `ip_type`/`ip_instance`/`ring` to a scheduler entity, deduplicates against entities already seen, and grows a "gang" — up to `AMDGPU_CS_GANG_SIZE` jobs from one ioctl, one per engine, with one of them designated the **gang leader**. Only after that loop does pass 1 call `amdgpu_job_alloc()` for each.

### What a "job" is

`amdgpu_job_alloc()` bottoms out in `drm_sched_job_init()`, which is where a driver-private submission becomes a scheduler-visible object. That is the definition of a job worth holding on to: **a job is one unit of work that the scheduler hands to the driver's `run_job()` callback, that carries its own list of dependency fences, and whose completion is represented by a fence other code can wait on.** (The deprecated `drm_sched_resubmit_jobs()` can call `run_job()` a second time for the same job — the `run_job()` kerneldoc warns that doing so "violates dma_fence rules"; see [timeout detection and recovery](#timeout-detection-and-recovery) below.) Everything hardware-specific stays in the driver's containing struct (amdgpu's `struct amdgpu_job` embeds `struct drm_sched_job base` as its first member, the same embedding pattern GEM uses for buffer objects).

## `struct dma_fence`, in detail

[GEM and dma-buf](gem-dmabuf.md) introduced `dma_fence` as the thing that lives in a buffer's `dma_resv` and lets two drivers agree on who is still using memory. Command submission needs the next layer down: how a fence is ordered, how it gets signaled, and what the kernel guarantees about it.

### Contexts and sequence numbers

```c
// include/linux/dma-fence.h
struct dma_fence {
	union {
		spinlock_t *extern_lock;
		spinlock_t inline_lock;
	};
	const struct dma_fence_ops __rcu *ops;
	union {
		struct list_head cb_list;   /* replaced by @timestamp on dma_fence_signal() */
		ktime_t timestamp;
		struct rcu_head rcu;
	};
	u64 context;
	u64 seqno;
	unsigned long flags;
	struct kref refcount;
	int error;
};
```

`context` and `seqno` together are the ordering model, and `dma-fence.c`'s own overview states the rule: fences are *"associated with a context, allocated through `dma_fence_context_alloc()`, and all fences on the same context are fully ordered."* Within a context, a later `seqno` means "later" — though the comparison itself is the driver's choice: `__dma_fence_is_later()` does a wrapping 32-bit compare by default, or compares the full 64 bits if the fence sets `DMA_FENCE_FLAG_SEQNO64_BIT`. Across contexts there is no ordering at all, which is why comparing sequence numbers between two different engines is meaningless. `dma_fence_is_later()` is only valid for two fences sharing a context.

That property is what makes fence *deduplication* cheap. `drm_sched_job_add_dependency()` walks the job's existing dependency array and, if it finds one from the same `context`, keeps only the later of the two — the code comment spells out the payoff: *"This lets the size of the array of deps scale with the number of engines involved, rather than the number of BOs."* A submission touching 500 buffers that were all last written by the same engine ends up with one dependency, not 500.

### Signaling

`struct dma_fence_ops` is small, and only two callbacks are mandatory (`get_driver_name` and `get_timeline_name`, both informational — surfaced through `SYNC_IOC_FILE_INFO` as well as debug output). The interesting one is optional:

```c
// include/linux/dma-fence.h
struct dma_fence_ops {
	const char * (*get_driver_name)(struct dma_fence *fence);
	const char * (*get_timeline_name)(struct dma_fence *fence);
	bool (*enable_signaling)(struct dma_fence *fence);
	bool (*signaled)(struct dma_fence *fence);
	signed long (*wait)(struct dma_fence *fence, bool intr, signed long timeout);
	void (*release)(struct dma_fence *fence);
	void (*set_deadline)(struct dma_fence *fence, ktime_t deadline);
};
```

`enable_signaling` exists because interrupts cost something. Its kerneldoc explains the intent: implementations that can do hardware-to-hardware signaling can *"implement this op to enable the necessary interrupts, or insert commands into cmdstream, etc, to avoid these costly operations for the common case where only hw->hw synchronization is required."* Nothing calls it directly; it is invoked lazily by `__dma_fence_enable_signaling()` the first time somebody actually needs a software notification — which happens from `dma_fence_add_callback()`, or via `dma_fence_enable_sw_signaling()` — which `dma_fence_wait_timeout()` calls unconditionally before it starts waiting. If the callback returns `false` — meaning the fence already passed, or signaling could not be enabled at all — `__dma_fence_enable_signaling()` signals it immediately, with whatever `fence->error` the driver set.

amdgpu's hardware fence shows the pattern in miniature. `amdgpu_fence_ops` implements `enable_signaling` as nothing more than arming a fallback timer:

```c
// drivers/gpu/drm/amd/amdgpu/amdgpu_fence.c
static bool amdgpu_fence_enable_signaling(struct dma_fence *f)
{
	if (!timer_pending(&to_amdgpu_fence(f)->ring->fence_drv.fallback_timer))
		amdgpu_fence_schedule_fallback(to_amdgpu_fence(f)->ring);

	return true;
}
```

The real signaling comes from `amdgpu_fence_process()`, called from the ring's interrupt handler: it reads the last-completed sequence number the GPU wrote to memory (`amdgpu_fence_read()`), and signals every fence from the previously known `last_seq` up to it. The fallback timer is insurance against a missed interrupt.

On the waiting side, `dma_fence_add_callback()` is the non-blocking primitive the scheduler leans on, and it has one sharp edge worth internalizing: **if the fence is already signaled it returns `-ENOENT` and does not call the callback.** Every caller has to treat `-ENOENT` as "already done, act now," which is exactly what `drm_sched_run_job_work()` does after `run_job()` returns a hardware fence. Its kerneldoc also warns that *"the callback can be called from an atomic context or irq context"* — a callback may not sleep.

### The cross-driver contract

Because a fence created by one driver can be waited on by a completely different one, `dma-fence.c` documents a set of rules under **"fence cross-driver contract"** that constrain every implementation. The first is the one this page cares about most:

> *Fences must complete in a reasonable time. Fences which represent kernels and shaders submitted by userspace, which could run forever, must be backed up by timeout and gpu hang recovery code. Minimally that code must prevent further command submission and force complete all in-flight fences... Ideally the driver supports gpu recovery which only affects the offending userspace context, and no other userspace submissions.*

The remaining rules are mostly locking constraints that follow from it: drivers may call `dma_fence_wait()` while holding a `dma_resv` lock, from a shrinker callback, and from an MMU notifier — so any code on the path to `dma_fence_signal()` must not take a `dma_resv` lock, must not allocate with `GFP_KERNEL`, and must not allocate with `GFP_NOFS`/`GFP_NOIO` either. `dma_fence_begin_signalling()`/`dma_fence_end_signalling()` exist to let lockdep police exactly this.

The mirror image of the rule is [**"Indefinite DMA Fences"**](https://docs.kernel.org/driver-api/dma-buf.html) in the dma-buf documentation, which enumerates proposals that would have allowed a fence whose completion is under userspace's control (future fences, proxy fences, userspace fences, long-running compute batches) and explains why they are rejected: *"Mixing indefinite fences with normal in-kernel DMA fences does not work, even when a fallback timeout is included to protect against malicious userspace."* The reason a GPU hang must be *recovered from* rather than merely waited out is this contract — memory reclaim is allowed to block on a fence.

### Deadline hints

One late addition worth knowing about, because it shows up in the scheduler's fence ops. `dma_fence_set_deadline()` lets a waiter tell the signaler *when* it would like the fence done, as an absolute `ktime`. The `deadline hints` documentation gives the motivating case: a double-buffered renderer that misses a vblank ends up *more* idle (it waits a whole extra vblank period), so a utilization-based devfreq governor sees idle time and lowers the GPU clock — precisely backwards. It is explicitly advisory: *"The deadline hint is just that, a hint. The driver that created the fence may react by increasing frequency, making different scheduling choices, etc. Or doing nothing at all."*

## `drm_sched`: the shared GPU scheduler

### Why it's shared

The scheduler was not designed as common infrastructure. It arrived as AMD-only code in [`a72ce6f84109`](https://github.com/torvalds/linux/commit/a72ce6f84109c1dec1ab236d65979d3250668af3) ("drm/amd: add basic scheduling framework," authored by Jammy Zhou in May 2015 with sign-offs from Shaoyun Liu and Chunming Zhou, merged for Linux 4.3), living under `drivers/gpu/drm/amd/scheduler/`. Its commit message already describes the object model that survives today essentially unchanged — a *run queue* ("a set of entities scheduling commands for the same ring... implements the scheduling policy that selects the next entity to emit commands from...") and an *entity* ("a wrapper around a job queue... Entities take turns emitting jobs from their job queue to the corresponding hardware ring").

Two and a half years later, Lucas Stach moved it wholesale in [`1b1f42d8fde4`](https://github.com/torvalds/linux/commit/1b1f42d8fde4fef1ed7873bf5aa91755f8c3de35) ("drm: move amd_gpu_scheduler into common location," authored December 2017, merged for Linux 4.16): *"This moves and renames the AMDGPU scheduler to a common location in DRM in order to facilitate re-use by other drivers. This is mostly a straight forward rename with no code changes."* The first non-AMD user followed one cycle later — [`e93b6deeb45a`](https://github.com/torvalds/linux/commit/e93b6deeb45a781489f4ceaa97f9545a3cbebb81) ("drm/etnaviv: hook up DRM GPU scheduler," Lucas Stach, merged for 4.17), whose commit message notes the immediate win of not having to keep etnaviv's own retire worker: *"Allows to get rid of the retire worker, as this is now driven by the scheduler."* Etnaviv's own hangcheck code went away two days later in [`6d7a20c07760`](https://github.com/torvalds/linux/commit/6d7a20c0776036115c6e22bc673d645d524c4b8a) ("drm/etnaviv: replace hangcheck with scheduler timeout").

That is the reason a shared scheduler exists at all: every driver with a ring buffer had independently written the same three things — an ordered software queue in front of the hardware queue, dependency tracking so a job doesn't start before its inputs are ready, and a hangcheck timer. In Linux 7.1 thirteen drivers select `DRM_SCHED`: amdgpu, etnaviv, imagination, lima, msm, nouveau, panfrost, panthor, v3d and xe under `drivers/gpu/drm/`, plus amdxdna, ethosu and rocket under `drivers/accel/`.

### The four objects

```
  drm_sched_entity           drm_sched_rq              drm_gpu_scheduler        hardware
  (one per client            (one per priority,        (one per hw ring)          ring
   context+engine)            per scheduler)
  ┌──────────────┐           ┌─────────────┐          ┌──────────────────┐
  │ job_queue    │──push──►  │  entities   │──select► │ work_run_job     │──run_job()──►
  │ (spsc queue) │           │  (rr / fifo)│          │ pending_list     │
  │ dependency   │           └─────────────┘          │ work_tdr         │
  └──────────────┘                                    └──────────────────┘
```

**`struct drm_gpu_scheduler`** is one per hardware ring (`sched_main.c`'s overview: *"Each hw run queue has one scheduler"*). It owns the run-queue array, the workqueues, the list of jobs currently on hardware, and the timeout:

```c
// include/drm/gpu_scheduler.h
struct drm_gpu_scheduler {
	const struct drm_sched_backend_ops	*ops;
	u32				credit_limit;
	atomic_t			credit_count;
	long				timeout;
	const char			*name;
	u32				num_rqs;
	struct drm_sched_rq		**sched_rq;
	...
	struct workqueue_struct		*submit_wq;
	struct workqueue_struct		*timeout_wq;
	struct work_struct		work_run_job;
	struct work_struct		work_free_job;
	struct delayed_work		work_tdr;
	struct list_head		pending_list;   /* jobs handed to hardware */
	spinlock_t			job_list_lock;
	int				hang_limit;
	atomic_t			*score;
	...
};
```

**`struct drm_sched_rq`** is one run-queue per priority level (`DRM_SCHED_PRIORITY_KERNEL`, `HIGH`, `NORMAL`, `LOW`), holding the set of entities with work pending. **`struct drm_sched_entity`** is the per-client queue — its own kerneldoc calls it *"A wrapper around a job queue (typically attached to the DRM file_priv)"*. In amdgpu, `amdgpu_ctx_init_entity()` creates one entity per `(hardware IP type, ring)` pair per context — they live in `ctx->entities[hw_ip][ring]` — so a process holding two GPU contexts and using both graphics and compute ends up with at least four independent entities. The entity holds a single-producer/single-consumer queue of jobs (`struct spsc_queue job_queue`) plus the fence identity that ties the whole thing together:

```c
// include/drm/gpu_scheduler.h — struct drm_sched_entity, selected fields
	struct spsc_queue		job_queue;
	atomic_t			fence_seq;
	uint64_t			fence_context;
	struct dma_fence		*dependency;   /* what the head job is blocked on */
	struct dma_fence_cb		cb;
	atomic_t			*guilty;
	struct dma_fence __rcu		*last_scheduled;
```

`drm_sched_entity_init()` calls `dma_fence_context_alloc(2)` — **two** contexts per entity, not one, because every job produces two fences and they must be independently orderable.

**`struct drm_sched_job`** is the unit the driver embeds:

```c
struct drm_sched_job {
	ktime_t				submit_ts;
	struct drm_gpu_scheduler	*sched;    /* set by drm_sched_job_arm() */
	struct drm_sched_fence		*s_fence;
	struct drm_sched_entity		*entity;
	enum drm_sched_priority		s_priority;
	u32				credits;
	unsigned int			last_dependency;
	atomic_t			karma;     /* hangs blamed on this job */
	struct spsc_node		queue_node;
	struct list_head		list;      /* on the scheduler's pending_list */
	union {
		struct dma_fence_cb	finish_cb;
		struct work_struct	work;
	};
	struct dma_fence_cb		cb;
	struct xarray			dependencies;
};
```

### Two fences per job, and why

`struct drm_sched_fence` is the piece that makes the whole pipeline work, and it contains *two* `dma_fence`s plus a pointer to a third:

```c
// include/drm/gpu_scheduler.h
struct drm_sched_fence {
	struct dma_fence		scheduled;  /* job has been pushed to hardware */
	struct dma_fence		finished;   /* job is complete */
	ktime_t				deadline;
	struct dma_fence		*parent;    /* the hardware fence from run_job() */
	struct drm_gpu_scheduler	*sched;
	spinlock_t			lock;
	void				*owner;
	uint64_t			drm_client_id;
};
```

`drm_sched_fence_init()` gives them adjacent contexts — `scheduled` gets `entity->fence_context`, `finished` gets `entity->fence_context + 1`, both with the same `seqno`.

The reason there are two is a chicken-and-egg problem the `finished` fence's kerneldoc states directly: *"When setting up an out fence for the job, you should use this, since it's available immediately upon `drm_sched_job_init()`, and the fence returned by the driver from `run_job()` won't be created until the dependencies have resolved."* A submission needs a fence to hand back to userspace and to stick in every touched buffer's `dma_resv` *at ioctl time* — but the hardware fence doesn't exist until the job actually reaches hardware, possibly seconds later. So `finished` is a stand-in: the scheduler signals it when `parent` (the real hardware fence) signals, forwarding the error code along the way.

The `scheduled` fence buys something different: pipelining. When one job depends on another job *on the same scheduler*, `drm_sched_entity_add_dependency_cb()` quietly substitutes the dependency's `scheduled` fence for its `finished` fence:

```c
	s_fence = to_drm_sched_fence(fence);
	if (!fence->error && s_fence && s_fence->sched == sched &&
	    !test_bit(DRM_SCHED_FENCE_DONT_PIPELINE, &fence->flags)) {
		/*
		 * Fence is from the same scheduler, only need to wait for
		 * it to be scheduled
		 */
		fence = dma_fence_get(&s_fence->scheduled);
		dma_fence_put(entity->dependency);
		entity->dependency = fence;
	}
```

Since both jobs go to the same ring and the ring executes in order, the dependent job can be pushed to hardware as soon as its predecessor has been pushed — no CPU round trip waiting for completion. `DRM_SCHED_FENCE_DONT_PIPELINE` (a `dma_fence` user flag) is the opt-out for cases where that isn't safe. The same function also short-circuits dependencies on the entity's *own* fences entirely — an entity's jobs are already ordered by its SPSC queue.

### The pipeline

**Submit side**, in a required order:

1. **`drm_sched_job_init(job, entity, credits, owner, drm_client_id)`** — allocates the `drm_sched_fence` and initializes the dependency xarray. It does *not* yet pick a scheduler.
2. Dependencies get attached: `drm_sched_job_add_dependency()` for a raw fence, `drm_sched_job_add_syncobj_dependency()` for a `drm_syncobj` handle plus timeline point, `drm_sched_job_add_resv_dependencies()` to sweep a `dma_resv` at a given `dma_resv_usage`, or `drm_sched_job_add_implicit_dependencies(job, obj, write)` — which is just the `dma_resv` variant with `dma_resv_usage_rw(write)`, i.e. exactly the implicit-sync rule from [GEM/dma-buf](gem-dmabuf.md#fences-and-dma_resv) expressed as a job dependency.
3. **`drm_sched_job_arm(job)`** — picks the scheduler (`drm_sched_entity_select_rq()`), stamps `job->sched` and `job->s_priority`, and initializes the two fences with real sequence numbers. `drm_sched_job_cleanup()`'s kerneldoc calls this *"a point of no return since it initializes the fences and their sequence number"*: once armed, the job **must** be pushed, because other code may now be holding its `finished` fence.
4. **`drm_sched_entity_push_job(job)`** — timestamps the job, pushes it onto the entity's SPSC queue, and if it's the first job, adds the entity to its run-queue and calls `drm_sched_wakeup()`.

amdgpu's `amdgpu_cs_submit()` shows all of this with the gang wrinkle: it arms every job in the gang, makes the gang leader depend on every other member's **`scheduled`** fence, publishes the leader's `finished` fence into every locked buffer's `dma_resv` (`DMA_RESV_USAGE_WRITE` for the leader, `DMA_RESV_USAGE_READ` for the rest), and only then pushes them all.

**Execution side** — `drm_sched_run_job_work()`, a work item on `submit_wq`:

1. **`drm_sched_select_entity()`** walks run-queues from `DRM_SCHED_PRIORITY_KERNEL` downward and returns the first ready entity. Crucially, if a run-queue has a ready entity but the scheduler is out of credits, the per-run-queue selector helper returns `ERR_PTR(-ENOSPC)` rather than `NULL`, the priority loop stops, and `drm_sched_select_entity()` hands back `NULL` — so a busy ring does not let low-priority work jump ahead of blocked high-priority work.
2. **`drm_sched_entity_pop_job()`** resolves dependencies. It loops `drm_sched_job_dependency()`, which returns the next fence from the job's xarray (already-signaled ones fall straight through the loop below) — or, once the xarray is exhausted, calls the driver's optional `prepare_job()` callback, which can return yet another fence — amdgpu uses it to grab a VMID. For each, `drm_sched_entity_add_dependency_cb()` registers `drm_sched_entity_wakeup` and the worker returns; the entity is re-examined when that fence signals.
3. The job is added to `sched->pending_list` and the timeout is (re)armed by `drm_sched_job_begin()`.
4. **`sched->ops->run_job(job)`** — the driver actually writes the ring. It returns the **hardware fence**, and the scheduler *inherits* the caller's reference: *"the scheduler expects to 'inherit' its own reference to this fence from the callback. It does not invoke an extra `dma_fence_get()` on it."*
5. `drm_sched_fence_scheduled()` stores the hardware fence as `s_fence->parent` and signals `scheduled`. A `dma_fence_add_callback()` on the hardware fence arms `drm_sched_job_done_cb()`; the `-ENOENT` case (already signaled) is handled by calling `drm_sched_job_done()` directly.
6. When the hardware fence signals, `drm_sched_job_done()` returns the job's credits, signals `finished` with the hardware fence's error code, and queues `work_free_job`, which eventually calls `sched->ops->free_job()`.

### Flow control: credits

`drm_sched` doesn't count jobs, it counts **credits** — a driver-defined quantity per job against a per-scheduler `credit_limit`. `sched_main.c` documents why this is a limit and not a queue: *"If by executing one more job the scheduler's credit count would exceed the scheduler's credit limit, the job won't be executed."* The point is ring-buffer capacity. Matthew Brost's workqueue-conversion commit describes the trick Xe relies on: *"in Xe submissions are done via programming a ring buffer (circular buffer), a drm_gpu_scheduler provides a limit on number of jobs, if the limit of number jobs is set to RING_SIZE / MAX_SIZE_PER_JOB we get flow control on the ring for free."* amdgpu keeps it simple — `credit_limit = ring->num_hw_submission` and every job costs 1 credit. `drm_sched_can_queue()` clamps any job whose credits exceed the whole limit down to the limit (with a `dev_WARN`) specifically to guarantee forward progress rather than deadlocking on an impossible job.

### Scheduling policy, three eras

The policy that picks between entities on a run-queue has been rewritten twice, and each rewrite was driven by a measured starvation problem.

- **Round-robin** (2015–2022) — `drm_sched_rq_select_entity_rr()` walks the entity list from wherever it stopped last time. Luben Tuikov's commit message for the switch away from it shows the failure with a diagram: with entities holding wildly different queue depths, strict round-robin drains one job per entity per pass, so a deep queue's oldest job can sit behind many newer jobs from shallow queues.
- **FIFO** (Linux 6.2 onwards) — [`08fb97de03aa`](https://github.com/torvalds/linux/commit/08fb97de03aa2205c6791301bd83a095abc1949c) (Andrey Grodzovsky, "drm/sched: Add FIFO sched policy to run queue") added `drm_sched_rq_select_entity_fifo()`, which keeps entities in an `rb_root_cached` keyed on `oldest_job_waiting` and always picks the entity whose head job arrived first — O(1) selection, O(log N) update. [`977d97f18b5b`](https://github.com/torvalds/linux/commit/977d97f18b5b8efb7a94da84724113f15ae6cc2d) (Luben Tuikov) made it the default in the same release. Both policies remain selectable in 7.1 via the scheduler's `sched_policy` module parameter.
- **Fair** (merged for Linux 7.2, still unreleased as of this writing) — Tvrtko Ursulin's [`2fa4d8e2c109`](https://github.com/torvalds/linux/commit/2fa4d8e2c1091189064c5b93222a23ded2d881ba) ("drm/sched: Add fair scheduling policy") replaces both with a CFS-style virtual-runtime ordering: *"entity run queue is sorted by the virtual GPU time consumed by entities in a way that the entity with least vruntime runs first... It is able to avoid total priority starvation, which is one of the problems with FIFO, and it also does not need for per priority run queues."* [`45c211ddf92a`](https://github.com/torvalds/linux/commit/45c211ddf92a1f9b4214ffadaf70d9037f53aaf6) made it the default and [`77a6809f1dc3`](https://github.com/torvalds/linux/commit/77a6809f1dc39376116f8d769a0d2630dc95ad79) then deleted FIFO, round-robin, and the whole per-priority run-queue array, collapsing `drm_gpu_scheduler.sched_rq[]` into a single embedded `struct drm_sched_rq rq`. If you are reading mainline rather than 7.1, that is the largest structural difference from what's shown above.

One more structural change worth knowing when reading older code: until Linux 6.8 each scheduler ran a dedicated **kthread**. [`a6149f039369`](https://github.com/torvalds/linux/commit/a6149f0393699308fb00149be913044977bceb56) (Matthew Brost, "drm/sched: Convert drm scheduler to use a work queue rather than kthread") replaced it with the `work_run_job`/`work_free_job` work items shown above. The motivation came from Xe, which maps one scheduler to one entity — needed because its firmware scheduler (GuC) may reorder and preempt submissions, so *"if a using shared drm_gpu_scheduler across multiple drm_sched_entity, the TDR falls apart as the TDR expects submission order == completion order"* — and one kthread per entity does not scale.

## Timeout detection and recovery

### The timer

`sched->work_tdr` is a `delayed_work` running `drm_sched_job_timedout()`, armed by `drm_sched_start_timeout()` whenever `pending_list` is non-empty and `sched->timeout != MAX_SCHEDULE_TIMEOUT`. It is re-armed on each job completion, so the timeout is per-job-at-the-head, not per-submission-batch. Two functions short-circuit it: `drm_sched_fault()` fires it immediately when a driver's interrupt handler detects a hardware fault, and `drm_sched_tdr_queue_imm()` sets `sched->timeout = 0` and re-arms.

The handler itself is short:

```c
// drivers/gpu/drm/scheduler/sched_main.c
static void drm_sched_job_timedout(struct work_struct *work)
{
	...
	spin_lock(&sched->job_list_lock);
	job = list_first_entry_or_null(&sched->pending_list,
				       struct drm_sched_job, list);

	if (job) {
		/*
		 * Remove the bad job so it cannot be freed by a concurrent
		 * &struct drm_sched_backend_ops.free_job. It will be
		 * reinserted after the scheduler's work items have been
		 * cancelled, at which point it's safe.
		 */
		list_del_init(&job->list);
		spin_unlock(&sched->job_list_lock);

		status = job->sched->ops->timedout_job(job);
		...
		if (status == DRM_GPU_SCHED_STAT_NO_HANG)
			drm_sched_job_reinsert_on_false_timeout(sched, job);
	} else {
		spin_unlock(&sched->job_list_lock);
	}

	if (status != DRM_GPU_SCHED_STAT_ENODEV)
		drm_sched_start_timeout_unlocked(sched);
}
```

Note what it does *not* do: there is no generic reset. The core's entire contribution is "the head of `pending_list` has been there too long — here it is, you deal with it." Recovery is `timedout_job()`, a driver callback returning a status:

```c
enum drm_gpu_sched_stat {
	DRM_GPU_SCHED_STAT_NONE,     /* reserved, do not use */
	DRM_GPU_SCHED_STAT_RESET,    /* the GPU hung and was successfully reset */
	DRM_GPU_SCHED_STAT_ENODEV,   /* device is gone */
	DRM_GPU_SCHED_STAT_NO_HANG,  /* GPU did not hang and is still running */
};
```

`DRM_GPU_SCHED_STAT_NO_HANG` is the newest of these, added by Maíra Canal in [`0b1217bfdfdd`](https://github.com/torvalds/linux/commit/0b1217bfdfddf664c15954d1d51ee18ed88a2ccf) ("drm/sched: Allow drivers to skip the reset and keep on running," Linux 6.17) to fix a real leak. Because the handler removes the job from `pending_list` *before* calling `timedout_job()`, a driver that decided "actually the GPU is fine, this job is just slow" had no way to put it back — so when the job did finish, `free_job()` was never called for it. The commit names both cases it covers: a driver observing GPU forward progress through a hardware-specific mechanism (*"This happens in v3d, Etnaviv, and Xe"*), and the plain race where *"Timeout has fired before the free-job worker."*

### Resetting without killing everyone

The `timedout_job` kerneldoc in `gpu_scheduler.h` spells out the recommended sequence, and the interesting part is how much of it exists to *avoid* collateral damage. For a hardware scheduler where one `drm_gpu_scheduler` serves many entities on one ring, tearing down the scheduler is not acceptable, because *"this would effectively also affect innocent userspace processes which did not submit faulty jobs."* The prescribed order is: `drm_sched_stop()` every affected scheduler → kill the entity the faulty job came from → issue the driver-specific ring reset → re-submit the survivors → `drm_sched_start()`.

`drm_sched_stop(sched, bad)` does the delicate bookkeeping. It pauses the work items, then walks `pending_list` *backwards* and for each job either removes the hardware-fence callback (the job hasn't completed; drop `s_fence->parent` and refund its credits, so it can be re-submitted) or, if the callback was already running, waits out the `finished` fence and frees the job. The guilty job is deliberately kept alive — `sched->free_guilty` is set as a hint so the timeout handler frees it afterwards. `drm_sched_start(sched, errno)` then re-attaches callbacks to the survivors and force-completes anything whose parent fence is gone with `errno ?: -ECANCELED` — which is how errors reach userspace rather than a wait hanging forever.

Blame is tracked with **karma**. `drm_sched_increase_karma(bad)` increments the job's `karma` and sets the owning entity's `guilty` flag, and `drm_sched_entity_pop_job()` then poisons every subsequent job from that entity by setting `-ECANCELED` on its `finished` fence. The core still calls `run_job()` on it; it's the driver that checks — amdgpu's `amdgpu_job_run()` logs "Skip scheduling IBs in ring(%s)" and returns no hardware fence when `finished->error < 0`. Kernel jobs are exempt by design — the comment notes that a GPU hang can corrupt kernel VM-update jobs too, *"but keep in mind that kernel jobs always considered good."* (The related `hang_limit`/`drm_sched_invalidate_job()` threshold mechanism is now marked DEPRECATED in `drm_sched_init_args`, which tells drivers to set it to 0.)

`drm_sched_resubmit_jobs()` carries an unusually blunt deprecation notice, and it is a good summary of what the community learned here:

> *Re-submitting jobs was a concept AMD came up as cheap way to implement recovery after a job timeout. This turned out to be not working very well. First of all there are many problem with the dma_fence implementation and requirements. Either the implementation is risking deadlocks with core memory management or violating documented implementation details of the dma_fence object.*

Re-initializing a `dma_fence` that other drivers may already hold references to breaks the one-shot contract; and allocating memory during reset can deadlock against reclaim waiting on the very fence you're trying to signal. The suggested replacement is for drivers to iterate `drm_sched_for_each_pending_job()` after stopping the scheduler and do their own recovery.

### What amdgpu actually does

`amdgpu_job_timedout()` is a good illustration of "escalate as little as possible." In order:

1. If the device is unplugged (`drm_dev_enter()` fails), return `DRM_GPU_SCHED_STAT_ENODEV` immediately.
2. Take a devcoredump (`amdgpu_job_core_dump()`) right away, to capture state before recovery perturbs it.
3. Try **soft recovery** — `amdgpu_ring_soft_recovery()` marks the timed-out fence `-ENODATA` and then spins on the per-ASIC `ring->funcs->soft_recovery(ring, vmid)` callback for up to 10 ms, hoping the fence signals. Nothing is reset. On success: log `"ring %s timeout, but soft recovered"` and stop.
4. Try a **per-queue ring reset** — `drm_sched_wqueue_stop()`, `amdgpu_ring_reset()`, `drm_sched_wqueue_start()`, and on success emit `drm_dev_wedged_event(..., DRM_WEDGE_RECOVERY_NONE, info)` so userspace can collect the coredump.
5. Otherwise `dma_fence_set_error(&s_job->s_fence->finished, -ETIME)` and fall through to `amdgpu_device_gpu_recover()`, a full device reset.

Every path except the unplugged-device one falls through to a single `return DRM_GPU_SCHED_STAT_NO_HANG` at the end of the function, annotated `/* This is needed to add the job back to the pending list */` — amdgpu leans on the `NO_HANG` reinsertion path unconditionally so the core puts the job back and `free_job()` still runs for it, rather than distinguishing "recovered" from "was never hung."

Default timeouts are set per engine type in `amdgpu_device_init_schedulers()` from `adev->gfx_timeout` / `compute_timeout` / `sdma_timeout` / `video_timeout`; `amdgpu_device_get_job_timeout_settings()` initializes all four to 2 seconds, overridable with the `amdgpu.lockup_timeout=` parameter (a negative value disables the timeout and taints the kernel with `TAINT_SOFTLOCKUP`). Notably, amdgpu passes `adev->reset_domain->wq` as `timeout_wq` — the `timedout_job` kerneldoc explicitly recommends an ordered workqueue for GPUs that have distinct hardware queues but must reset globally, so that timeout handlers on different schedulers run one at a time.

### Telling userspace

Recovery is only half the job; a client whose context was killed has to find out. [Kernel docs: DRM uAPI](https://docs.kernel.org/gpu/drm-uapi.html) devotes a "Device reset" section to this, and its framing is that error propagation *"goes in the opposite direction of the usual flow of commands"* — hence the vendor-independent mechanism being `dma_fence_set_error()` on fences before signaling them, with the scheduler forwarding errors *"from the hardware fence to the scheduler fence to bubble up errors to the higher levels of the stack and eventually userspace."* Drivers are told to track resets per context (`drm_sched_entity_error()` is the provided helper) and to **reject new submissions from affected contexts** — which is exactly what `amdgpu_cs_parser_init()` does when it returns `-ECANCELED` for a context whose `guilty` flag is set. Userspace then surfaces it as `GL_ARB_robustness` reset status or Vulkan's `VK_ERROR_DEVICE_LOST`. The same document is candid that this only works if the application opted into robustness at all, and that *"there is no strong community consensus on what the userspace driver should do"* otherwise.

## Worked example: one `AMDGPU_CS` call, end to end

A Vulkan application submits a render pass that samples a texture another queue just wrote, and presents the result.

**1. Userspace builds the request.** Mesa's radv writes the command packets into a GPU-visible buffer it already owns, then fills a `union drm_amdgpu_cs` with `ctx_id`, a `bo_list_handle` naming every buffer the submission touches, and chunks: one `AMDGPU_CHUNK_ID_IB` (the `va_start` of those packets, `ip_type = AMDGPU_HW_IP_GFX`), one `AMDGPU_CHUNK_ID_SYNCOBJ_IN` naming the syncobj the other queue will signal, and one `AMDGPU_CHUNK_ID_SYNCOBJ_OUT` for the fence the compositor will wait on.

**2. Pass 1 allocates the job.** `amdgpu_cs_pass1()` copies the chunk array in, and for the IB chunk calls `amdgpu_cs_job_idx()` → `amdgpu_ctx_get_entity()`, resolving `(GFX, instance 0, ring 0)` to a `drm_sched_entity` created earlier by `amdgpu_ctx_init_entity()`. One engine, so `gang_size == 1`. `amdgpu_job_alloc()` → `drm_sched_job_init()` creates the `drm_sched_fence` — at this instant the `finished` fence exists and is unsignaled, with no idea which hardware ring will eventually run it.

**3. Pass 2 turns chunks into dependencies.** The `SYNCOBJ_IN` chunk goes through `amdgpu_syncobj_lookup_and_add()`, which resolves the handle to a `dma_fence` and adds it to the submission's sync set. `amdgpu_cs_parser_bos()` locks every buffer in the BO list with `drm_exec` (a `ww_acquire_ctx` wrapper, so lock-ordering conflicts back off and retry) and validates their placement. `amdgpu_cs_sync_rings()` then does the *implicit* half: it walks every locked object's `dma_resv` with `amdgpu_sync_resv()` and pushes the result into each job via `amdgpu_sync_push_to_job()`, which bottoms out in `drm_sched_job_add_dependency()`. Explicit and implicit dependencies end up in the same xarray.

**4. Arm and push.** `amdgpu_cs_submit()` calls `drm_sched_job_arm()` — *now* `drm_sched_entity_select_rq()` picks a scheduler (`drm_sched_pick_best()` chooses the least-loaded ring by `score` if the entity was given several), and the two fences get real sequence numbers. The `finished` fence is added to every locked buffer's `dma_resv` with `DMA_RESV_USAGE_WRITE`, which is what makes the *next* submission's implicit-sync sweep — or the display driver's `prepare_fb`, per [GEM/dma-buf](gem-dmabuf.md#worked-example-a-camera-frame-becomes-a-gpu-texture-zero-copy) — automatically wait for this render. `amdgpu_ctx_add_fence()` records it under a sequence number returned in `cs->out.handle`. Then `drm_sched_entity_push_job()`, and the ioctl returns. Nothing has touched the ring yet.

**5. The scheduler runs it.** `drm_sched_run_job_work()` picks the entity, and `drm_sched_entity_pop_job()` finds the texture-write dependency unsignaled — so it registers a callback and returns without running anything. When the other queue's job completes and signals, `drm_sched_entity_wakeup()` re-queues the work item. This time dependencies are exhausted, so `prepare_job()` (amdgpu: `amdgpu_vmid_grab()`) may return one more fence for a VMID; once that clears, the job lands on `pending_list`, the 2-second GFX timeout is armed, and `amdgpu_job_run()` writes the ring. It returns an `amdgpu_fence`; the scheduler stores it as `s_fence->parent`, signals `scheduled`, and hangs `drm_sched_job_done_cb()` off it.

**6a. Normal completion.** The GPU writes the sequence number to memory and raises its ring interrupt; `amdgpu_fence_process()` signals every fence up to that seqno. `drm_sched_job_done()` refunds the credits, signals `finished` (error code forwarded from the hardware fence), and queues `work_free_job`. The `SYNCOBJ_OUT` fence — which is the `finished` fence — signals, the compositor's wait completes, and the frame goes up for a [KMS](kms.md) atomic commit.

**6b. The shader loops forever instead.** No interrupt arrives. Two seconds later `drm_sched_job_timedout()` pops the job off `pending_list` and calls `amdgpu_job_timedout()`. A coredump is taken; soft recovery is tried for 10 ms; if the fence still hasn't signaled, a per-queue ring reset is attempted; if that fails too, `-ETIME` is set on `finished` and the whole device is reset. On that full-reset path, `drm_sched_increase_karma()` marks the entity guilty, so every job still queued behind this one is completed with `-ECANCELED` rather than run. The application's next `AMDGPU_CS` is rejected with `-ECANCELED` at `amdgpu_cs_parser_init()`, radv turns that into `VK_ERROR_DEVICE_LOST`, and — critically for the rest of the system — the compositor's wait on that syncobj completes with an error rather than hanging forever, because the cross-driver fence contract does not permit anything else.

## Further reading

- [Kernel docs: DRM Memory Management](https://docs.kernel.org/gpu/drm-mm.html) — includes the "GPU Scheduler" chapter (overview, flow control, and the generated `drm_sched` API reference) and "DRM Sync Objects"
- [Kernel docs: Buffer Sharing and Synchronization (dma-buf)](https://docs.kernel.org/driver-api/dma-buf.html) — the DMA fence overview, cross-driver contract, signalling annotations, deadline hints, and the "Indefinite DMA Fences" rationale
- [Kernel docs: DRM uAPI](https://docs.kernel.org/gpu/drm-uapi.html) — the "Device reset", "Robustness" and "Device Wedging" sections on propagating a hang to userspace
- [`a72ce6f84109`](https://github.com/torvalds/linux/commit/a72ce6f84109c1dec1ab236d65979d3250668af3) — "drm/amd: add basic scheduling framework," Linux 4.3 (2015): the original AMD-only scheduler
- [`1b1f42d8fde4`](https://github.com/torvalds/linux/commit/1b1f42d8fde4fef1ed7873bf5aa91755f8c3de35) — "drm: move amd_gpu_scheduler into common location," Lucas Stach, Linux 4.16 (2018)
- [`e93b6deeb45a`](https://github.com/torvalds/linux/commit/e93b6deeb45a781489f4ceaa97f9545a3cbebb81) — "drm/etnaviv: hook up DRM GPU scheduler," Linux 4.17: the first non-AMD user
- [`08fb97de03aa`](https://github.com/torvalds/linux/commit/08fb97de03aa2205c6791301bd83a095abc1949c) · [`977d97f18b5b`](https://github.com/torvalds/linux/commit/977d97f18b5b8efb7a94da84724113f15ae6cc2d) — FIFO scheduling policy added and made the default, Linux 6.2
- [`a6149f039369`](https://github.com/torvalds/linux/commit/a6149f0393699308fb00149be913044977bceb56) — "drm/sched: Convert drm scheduler to use a work queue rather than kthread," Matthew Brost, Linux 6.8
- [`0b1217bfdfdd`](https://github.com/torvalds/linux/commit/0b1217bfdfddf664c15954d1d51ee18ed88a2ccf) — "drm/sched: Allow drivers to skip the reset and keep on running," Maíra Canal, Linux 6.17: `DRM_GPU_SCHED_STAT_NO_HANG`
- [`2fa4d8e2c109`](https://github.com/torvalds/linux/commit/2fa4d8e2c1091189064c5b93222a23ded2d881ba) · [`77a6809f1dc3`](https://github.com/torvalds/linux/commit/77a6809f1dc39376116f8d769a0d2630dc95ad79) — "Add fair scheduling policy" and "Remove FIFO and RR and simplify to a single run queue," Tvrtko Ursulin, Linux 7.2
- [LWN: "The Linux graphics stack in a nutshell, part 1"](https://lwn.net/Articles/955376/) — Thomas Zimmermann, December 19, 2023, on where Mesa ends and driver-specific ioctls begin
- `include/drm/gpu_scheduler.h`, `drivers/gpu/drm/scheduler/{sched_main.c,sched_entity.c,sched_fence.c}` — the scheduler itself
- `include/linux/dma-fence.h`, `drivers/dma-buf/dma-fence.c` — the fence primitive and its documented contract
- `include/uapi/drm/amdgpu_drm.h`, `drivers/gpu/drm/amd/amdgpu/{amdgpu_cs.c,amdgpu_job.c,amdgpu_fence.c}` — a complete real submission path
- [DRM: the Direct Rendering Manager](README.md) · [GEM Buffer Objects and dma-buf](gem-dmabuf.md) · [Kernel Mode Setting (KMS)](kms.md) — the buffers jobs operate on, and where their output ends up
- [Workqueues](../interrupts/workqueues.md) — the deferred-work mechanism `submit_wq`, `timeout_wq` and `work_tdr` are built on
