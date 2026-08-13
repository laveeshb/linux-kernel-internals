# The Scheduler Fairness Evolution

> Round-robin starved entities with long job queues; the FIFO policy that replaced it starved low-priority entities under load; the fair policy that replaced FIFO borrowed its answer from CFS

Landed
:   FIFO: Linux 6.2 (2022) · Fair: Linux 7.2 (2026)

Scheduler
:   `drm_sched`, shared across every driver using the common DRM scheduler

Authors
:   Andrey Grodzovsky, Luben Tuikov (FIFO) · Tvrtko Ursulin (Fair)

Not a CVE

*Part of [War Stories: GPU/DRM Bugs and Regressions](../war-stories.md).*

## Before state

[Command Submission, `dma_fence`, and the GPU Scheduler](../command-submission.md) describes `drm_sched`'s run queue as a set of *entities* — one per userspace submission context — each holding its own queue of jobs, taking turns emitting work onto the hardware ring. For most of the scheduler's life, "taking turns" meant round robin: walk the entities in order, pop one job from whichever entity's turn it is, move to the next entity.

## The trigger

Andrey Grodzovsky's [`08fb97de03aa`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=08fb97de03aa2205c6791301bd83a095abc1949c) ("drm/sched: Add FIFO sched policy to run queue", September 2022) opens with the observed symptom: "When many entities are competing for the same run queue on the same scheduler, we observe an unusually long wait times and some jobs get starved. This has been observed on GPUVis" — AMD's own GPU-workload visualization tool. The mechanism was structural, not a bug in the traditional sense: round robin pops one job per entity per pass, *regardless of how long that entity's queue is or how old its oldest job is*. An entity with a long, old backlog and an entity with a short, fresh one got equal turns. Under enough concurrent entities, a job could sit behind an arbitrary number of other entities' turns no matter how long it had already been waiting — starvation that scaled with entity count, not with actual unfairness of demand.

## Observed behavior

The fix was FIFO ordering: instead of taking turns by entity, `drm_sched_rq_select_entity_fifo()` keeps entities in a red-black tree keyed on the timestamp of each entity's oldest waiting job, and always picks whichever entity's head job arrived first — O(1) to select, O(log N) to update. Luben Tuikov's [`977d97f18b5b`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=977d97f18b5b8efb7a94da84724113f15ae6cc2d) made it the scheduler's default in the same release, measuring "about 1% faster performance over the Round Robin algorithm" and explaining the intent with a worked example: given jobs A through J arriving in that chronological order across several entities, FIFO executes them in arrival order — A, B, C, D... — deviating only when an older job genuinely isn't ready yet, in which case a younger ready job runs, and the older one then jumps the queue the instant it becomes ready.

FIFO fixed the round-robin starvation case. It introduced a different one: strict chronological ordering means an entity that keeps submitting jobs can keep its jobs ahead of a lower-priority entity's older jobs indefinitely, so long as it keeps the queue non-empty. Tvrtko Ursulin's [`2fa4d8e2c109`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=2fa4d8e2c1091189064c5b93222a23ded2d881ba) ("drm/sched: Add fair scheduling policy", April 2026) names the failure mode FIFO couldn't avoid: "total priority starvation."

## Why it happened

Both policies optimized for a property that turned out not to be the only one that mattered. Round robin optimized for per-entity turn-taking and was blind to job age. FIFO optimized for job age and was blind to priority and to the asymmetry between a bursty low-priority client and a GPU-heavy high-priority one submitting continuously. Neither problem was a coding mistake; each policy was a genuine improvement on its predecessor's specific failure mode, and each new failure mode only became visible once the old one was fixed and workloads exercised the new gap.

## Resolution

`2fa4d8e2c109` replaces both with a CFS-style virtual-runtime scheme, in the commit's own words: "entity run queue is sorted by the virtual GPU time consumed by entities in a way that the entity with least vruntime runs first." Low-priority entities' real GPU time is scaled up by an exponential factor before being counted as vruntime, so they accumulate virtual runtime faster than normal-priority entities for the same real time spent — pushing them down the run-queue order proportionally, rather than either starving them (round robin, under enough competing entities) or letting priority be steamrolled entirely (FIFO, under sustained high-priority load). The commit specifically calls out oversubscription workloads — short, bursty clients running alongside a client submitting deep job queues — as the case fair scheduling handles better than either predecessor.

[`45c211ddf92a`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=45c211ddf92a1f9b4214ffadaf70d9037f53aaf6) made fair scheduling the new default, and [`77a6809f1dc3`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=77a6809f1dc39376116f8d769a0d2630dc95ad79) then deleted both round robin and FIFO outright — Ursulin's rationale being that fair scheduling was "in general better than FIFO and almost as good as round-robin in interactive use cases," and round robin hadn't been the default in years anyway, so keeping three policies alive cost more in scheduler complexity than any of the discarded ones was still buying. That also collapsed the scheduler's per-priority array of run queues into a single embedded run queue, since fair scheduling encodes priority through vruntime scaling rather than through separate queues.

## What it taught us

**A scheduling policy is a bet on which fairness property matters most, and every bet has a blind spot.** Round robin bet on entity turn-taking and lost to queue-length skew. FIFO bet on arrival order and lost to priority. Fair scheduling bets on a continuously-scaled virtual-time metric — the same bet CFS already made for CPU scheduling — precisely because it doesn't require choosing one dimension (age, priority, entity count) to protect at the expense of the others.

**"This fixes the starvation we're seeing" and "this eliminates starvation" are different claims, and the gap between them is exactly where the next policy comes from.** Both prior transitions were driven by a real, specific, observed symptom — GPUVis-visible entity starvation, then priority starvation under oversubscription — not by theoretical concern. Neither symptom was visible until the previous fix was already in wide use.

!!! warning "Pattern to watch for"
    A scheduling policy fix motivated by one observed starvation pattern is not evidence that starvation is solved in general — it's evidence that *this* pattern is solved. Watch for the next axis (priority, burstiness, entity count, queue depth) the new policy doesn't explicitly account for.

## See also

- [Command Submission, `dma_fence`, and the GPU Scheduler](../command-submission.md) — the run queue, entity, and scheduling-policy mechanics this page assumes; see "Scheduling policy, three eras" for the architectural summary
- [Scheduler Evolution](../../sched/scheduler-evolution.md) — CFS and vruntime-based fairness on the CPU-scheduling side, the model `drm_sched`'s fair policy borrows from

## External references

- [git.kernel.org: 08fb97de03aa](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=08fb97de03aa2205c6791301bd83a095abc1949c) — "drm/sched: Add FIFO sched policy to run queue," the GPUVis-observed starvation report
- [git.kernel.org: 977d97f18b5b](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=977d97f18b5b8efb7a94da84724113f15ae6cc2d) — "drm/scheduler: Set the FIFO scheduling policy as the default," with the worked chronological-order example
- [git.kernel.org: 2fa4d8e2c109](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=2fa4d8e2c1091189064c5b93222a23ded2d881ba) — "drm/sched: Add fair scheduling policy"
- [git.kernel.org: 45c211ddf92a](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=45c211ddf92a1f9b4214ffadaf70d9037f53aaf6) — "drm/sched: Switch default policy to fair"
- [git.kernel.org: 77a6809f1dc3](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=77a6809f1dc39376116f8d769a0d2630dc95ad79) — "drm/sched: Remove FIFO and RR and simplify to a single run queue"
