# The CFS Bandwidth Slice That Expired Before It Was Spent

> A multi-threaded, non-CPU-bound application under `cpu.cfs_quota_us` could get throttled while never actually using its full quota — because each CPU's local slice of that quota expired at the end of every period whether or not it had been spent

Reported by
:   Kubernetes users (tracked publicly as [kubernetes/kubernetes#67577](https://github.com/kubernetes/kubernetes/issues/67577)); root-caused and fixed by Dave Chiluk (Indeed)

Bug present since
:   Linux 3.16 (2014), via commit `51f2176d74ac` ("sched/fair: Fix unlocked reads of some cfs_b->quota/period")

Fixed in
:   commit `de53fd7aedb1` ("sched/fair: Fix low cpu usage with high throttling by removing expiration of cpu-local slices"), mainline Linux 5.4 (August 2019)

Measured impact of the fix
:   almost 30x throughput improvement on an artificial 80-CPU benchmark (10ms/100ms quota)

*Part of [War Stories: Scheduler Bugs](../war-stories.md).*

## Before state

CFS bandwidth control (`cpu.cfs_quota_us`/`cpu.cfs_period_us`) doesn't hand a cgroup's entire quota to whichever CPU asks first. To avoid a global lock on every scheduling decision, the quota is doled out in small slices to each CPU's local run queue (`cfs_rq`) as it's needed, tracked via `cfs_rq->runtime_remaining`. Each slice carried an expiration timestamp, `cfs_rq->runtime_expires`, tied to the bandwidth period it was drawn from — the idea being that an unused slice shouldn't be allowed to accumulate indefinitely across periods.

## The trigger

Commit `51f2176d74ac`, merged for Linux 3.16 in 2014, added a check around this expiration logic to fix an unrelated unlocked-read race:

```c
if (cfs_rq->runtime_expires != cfs_b->runtime_expires) {
    /* extend local deadline, drift is bounded above by 2 ticks */
    cfs_rq->runtime_expires += TICK_NSEC;
```

This conditional had the side effect of making slices effectively never expire in practice — for nearly five years, until commit `512ac999d275` ("sched/fair: Fix bandwidth timer clock drift condition") fixed *that* bug and restored real per-period expiration. Restoring correct expiration is what exposed the underlying design problem: a highly-threaded application whose individual threads each do a little work, then sleep, spreads its quota consumption thinly across many CPUs. Each CPU draws a small slice, uses part of it, and then hits the period boundary with time left on that slice — which now genuinely expired and was discarded, rather than being available to any thread that needed it moments later.

## Observed behavior

Once slices actually expired again, Kubernetes and Mesos users running multi-threaded, non-CPU-bound workloads under a CPU quota began seeing a high percentage of periods throttled — despite `cpuacct` accounting showing the container never came close to consuming its allotted quota. The workload was interactive, not CPU-bound: exactly the pattern most likely to leave unused runtime stranded on many different CPUs' local slices at once.

## Why it happened

The 2014 fix and the 2019 fix that re-enabled real expiration were both individually correct responses to real bugs in front of their authors — an unlocked-read race, then a clock-drift condition. Neither patch was evaluating the underlying design decision that per-CPU slices should expire at all; each was narrowly scoped to the specific bug it addressed. The design flaw — that quota fragmented across many CPUs' local slices is quota that can silently evaporate at a period boundary even though the cgroup as a whole never came close to its limit — had been latent and effectively masked by the first bug for five years, and only became visible in production once the second bug fix removed the accidental workaround.

## Resolution

Dave Chiluk's fix, commit `de53fd7aedb1`, doesn't patch the expiration logic further — it removes cpu-local slice expiration entirely. Unused quota on a CPU's local `cfs_rq` can now persist past a period boundary rather than being discarded, bounded above by `min_cfs_rq_runtime` (1ms) per CPU, so the worst-case overrun of the group's total quota in any one period is small and self-limiting. Chiluk's own reproduction — a synthetic 80-CPU test case with a 10ms/100ms quota, published as [fibtest](https://github.com/indeedeng/fibtest) — measured almost 30x higher throughput after the change, while quota restrictions remained correct over longer timeframes.

## What it taught us

**A performance bug fix can silently remove a design flaw's own accidental mitigation.** The 2014 unlocked-read fix wasn't wrong, but its side effect of disabling real slice expiration had been quietly absorbing the cost of a bandwidth-fragmentation problem for five years. Fixing the clock-drift bug correctly is what made the older design flaw visible again.

**"Never consumed the quota, still got throttled" is a sign the accounting granularity is wrong, not that the limit is wrong.** The fix here wasn't to raise anyone's quota — it was to stop discarding fragments of quota that had simply landed on the wrong CPU's ledger at the wrong moment.

!!! warning "Pattern to watch for"
    When a resource is subdivided across many independent trackers (here: one CPU's local runtime slice per cgroup, per period) for locking-scalability reasons, any expiration or reset policy applied per-subdivision needs to be evaluated against workloads that spread their usage thin across all the subdivisions at once — not just against the CPU-bound, single-hot-CPU case that's easiest to reason about and benchmark.

## See also

- [Scheduler Overview](../README.md) — CFS and bandwidth control
- [cgroup v2 CPU controller](../../cgroups/cgroup-v2.md) — how `cpu.max`/`cpu.cfs_quota_us` map onto this mechanism

## External references

- [git.kernel.org: de53fd7aedb1](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=de53fd7aedb100f03e5d2231cfce0e4993282425) — "sched/fair: Fix low cpu usage with high throttling by removing expiration of cpu-local slices," the fix, with Dave Chiluk's full root-cause writeup
- [git.kernel.org: 512ac999d275](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=512ac999d275) — "sched/fair: Fix bandwidth timer clock drift condition," the fix that re-enabled real expiration and exposed the design flaw
- [LWN: sched/fair: Fix low cpu usage with high throttling...](https://lwn.net/Articles/792268/) — LWN's coverage of the fix
- [kubernetes/kubernetes#67577](https://github.com/kubernetes/kubernetes/issues/67577) — the public user reports that drove the root-cause investigation
