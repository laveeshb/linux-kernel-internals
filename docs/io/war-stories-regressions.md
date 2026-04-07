# War Stories: I/O Performance Regressions

> Kernel changes that degraded I/O performance — what regressed, why, and how the kernel recovered

These are real regressions documented in LKML discussions, LWN articles, and kernel commit histories. Each was caused by a well-intentioned change that produced unexpected interactions with real workloads.

---

## Regression 1: Dirty throttling rework — write latency spikes in v3.1

*Introduced: v3.1 (October 2011). Significantly improved in v3.2. Final stabilization: v3.10-v3.13.*

### Before state

The dirty page throttling mechanism in Linux before v3.1 was relatively simple: when the amount of dirty data exceeded a threshold, writing processes were put to sleep for a fixed interval. The threshold was checked in `balance_dirty_pages()`, called from `generic_perform_write()` after each chunk of a write.

The mechanism had problems — it was too coarse, could cause write bursts followed by stalls, and treated fast and slow storage identically. On a server with a fast NVMe device, the default thresholds caused unnecessary stalls; on a slow USB disk, the thresholds weren't tight enough.

### The change

In v3.1, Fengguang Wu introduced a completely reworked throttling algorithm. The new design:

- Tracked per-BDI (Backing Device Info) write bandwidth dynamically
- Computed how long a dirty page would take to be written back
- Scaled the sleep time proportionally to the degree of threshold exceedance
- Aimed to smooth writes so processes were slowed to match the device's capacity

This was a significant architectural improvement and was extensively covered in LWN: [Smarter write throttling](https://lwn.net/Articles/458093/).

### Observed regression

After v3.1 shipped, production workloads reported latency spikes in `write()` calls that previously completed in microseconds. Individual writes could stall for tens or hundreds of milliseconds. The pattern had two manifestations:

**Manifestation 1: Underestimated bandwidth causing over-throttling**

The bandwidth estimator used an exponentially weighted moving average of recent writeback throughput. On storage with variable throughput (network filesystems, spinning disks with seek costs, storage with write cliffs), the estimator could underestimate available bandwidth. When the estimator said "the device can write 10MB/s" but the device could actually sustain 100MB/s, writers were throttled far more aggressively than necessary.

**Manifestation 2: Thundering herd on threshold crossing**

When the dirty ratio crossed the background threshold, the kernel started background writeback. When it crossed the foreground threshold, it started throttling writers. On a system with many writing processes, all of them could cross the threshold simultaneously and all receive sleep intervals simultaneously. When the writeback completed and the threshold fell, all of them woke up and dirtied pages at full speed simultaneously — causing another threshold crossing immediately, then another sleep. The result was a saw-tooth pattern with write latency spikes at each cycle.

```
Dirty pages (MB):
                      ▲
dirty_ratio ─────────────────────────────────────────────────
              /\ /\ /\ /\ /\ /\ /\
             /  \/  \/  \/  \/  \/
dirty_bg ────────────────────────────────────────────────────
                                                          → Time

write() latency:
   low  low  low  low  SPIKE  low  low  SPIKE  ...
```

### Root cause

The per-BDI bandwidth estimator was initialized with a guess and took time to converge. During the convergence window, throttling was poorly calibrated. On workloads with many writing processes, the thundering herd on wakeup was not damped.

A particularly well-documented case was reported by database teams: PostgreSQL checkpoints, which write large amounts of dirty data over a short period, caused the dirty estimator to be "confused" about the current write rate. The estimator saw a burst of writes (checkpoint in progress), estimated very high bandwidth, and then when the checkpoint ended, estimated very low bandwidth for the next checkpoint — causing severe over-throttling.

Relevant commits in the stabilization work: [bb6142ca6cfe](https://git.kernel.org/linus/bb6142ca6cfe), [9d823e8f6b6f](https://git.kernel.org/linus/9d823e8f6b6f), [5a537485f0a9](https://git.kernel.org/linus/5a537485f0a9).

### Resolution

Over several kernel versions (v3.2 through v3.13), the dirty throttling algorithm was refined:

- **Dampened wakeups**: processes waking up from throttle sleeps no longer immediately write at full speed; they start with a rate-limited burst.
- **Better bandwidth estimation**: the estimator was made more conservative and better at handling variable-throughput devices.
- **Per-inode tracking**: the `struct bdi_writeback` structure was improved to track per-writeback-context information more accurately.
- **Cgroup writeback** (v4.2): introduced per-cgroup dirty throttling, which fixed the interference between unrelated workloads writing to the same device.

### What it taught us

**Proportional control requires good measurement.** The new throttling algorithm was better designed than its predecessor in theory, but real-world performance depended entirely on the accuracy of the bandwidth estimator. An underestimating estimator turned a smooth throttle into a binary sleep/run cycle — worse than the original blunt mechanism.

**Write workload patterns vary wildly.** The estimator was tuned for steady-state sequential writes. Checkpoint-style workloads (bursty, correlated with I/O patterns) could confuse the estimator and cause oscillations.

---

## Regression 2: CFQ scheduler retirement and BFQ introduction — latency regressions for mixed workloads

*CFQ deprecated: v5.0 (2019). Removed: v5.3. BFQ introduced as alternative: v4.12.*

### Before state

CFQ (Completely Fair Queuing) was the default I/O scheduler for Linux from v2.6.6 (2004) through v5.0 (2019). It provided per-process I/O queues, time-slice-based fairness, and special handling for synchronous operations. Many production workloads were tuned to CFQ's behavior.

CFQ's design was rooted in the single-queue block layer era. Each device had one hardware queue, and CFQ sat between the filesystem and that queue, reordering requests to minimize seek time and allocating time slices fairly.

### The change

The move to multi-queue block layer (`blk-mq`) in v3.16-v4.x fundamentally changed the block layer architecture. Multiple hardware queues could be serviced in parallel from multiple CPUs. CFQ's single-queue design was not compatible with `blk-mq` and could not be meaningfully ported.

The replacement options were:
- `mq-deadline`: simple deadline scheduler, multi-queue aware, low overhead
- `kyber`: designed for fast NVMe with multiple queues
- `bfq`: Budget Fair Queueing, a more sophisticated CFQ successor designed to provide CFQ-like fairness on multi-queue devices
- `none`: passthrough with no scheduling

### Observed regression

After CFQ was retired, users who moved to `bfq` (the closest CFQ replacement) reported latency regressions and throughput decreases in specific workloads:

**Regression 1: Mixed sequential/random workloads**

BFQ's budget-based scheduling gave each process a "budget" of sectors it could use before being preempted. A process doing sequential writes used its budget quickly (large sequential requests). A process doing random reads used its budget slowly (small random requests). Under mixed workloads, the budgeting could cause the sequential writer to monopolize the device while the random reader's small requests waited.

**Regression 2: Filesystems with internal journaling**

ext4 uses separate I/O for journal writes and data writes. BFQ tracked these as separate "processes" (jbd2 kthread vs the writing process). Under heavy write load, BFQ's fair scheduling caused journal writes and data writes to timeshare the device, reducing the throughput that a sequential write workload would have achieved with CFQ (which was aware of the special nature of journal I/O).

**Regression 3: Database WAL writes**

PostgreSQL's WAL writer process does synchronous sequential writes. BFQ's detection of this as "sequential I/O" gave it higher priority — but this conflicted with concurrent checkpoint I/O doing random writes to data files. The interaction produced latency spikes for WAL commits (critical for transaction throughput) when checkpoints were running.

### Root cause

BFQ is a sophisticated scheduler with a complex algorithm that tries to mimic CFQ while supporting multiple queues. Its complexity makes it sensitive to workload patterns that CFQ handled through simpler heuristics. BFQ's budget calculation, back-seeking detection, and I/O class handling all involved heuristics that could misfire on workloads different from what the algorithm expected.

Additionally, BFQ's overhead was higher than `none` or `mq-deadline` on high-IOPS NVMe devices. For a NVMe device capable of 500K IOPS, BFQ's per-request processing overhead became measurable.

### Resolution

The resolution was pragmatic rather than algorithmic:

- **NVMe: use `none`**. Modern NVMe devices have sufficient hardware queuing that kernel scheduling provides no benefit and only adds overhead. The kernel now defaults to `none` for NVMe.
- **SATA SSD: use `mq-deadline`**. Simple, low-overhead, prevents starvation.
- **HDDs: use `bfq` or `mq-deadline`**. HDDs benefit from reordering; BFQ's budget-based approach works better for HDDs where seek cost is real.

BFQ continued to receive fixes for specific workload regressions ([v5.10 fixups](https://lore.kernel.org/lkml/), [v6.x cgroup integration improvements](https://git.kernel.org/linus/)). As of Linux 6.x, BFQ is the recommended scheduler for HDDs and for multi-tenant environments needing I/O isolation.

### What it taught us

**Scheduler design is coupled to hardware characteristics.** CFQ worked well for single-queue spinning disks. Its design assumptions (single queue, significant seek cost, need for per-process fairness) did not map to multi-queue NVMe. New hardware required new schedulers, not ports of old ones.

**Fairness and throughput are in tension.** BFQ provides better fairness than `mq-deadline` or `none` — but on fast NVMe, "fairness" is not meaningful because the device is fast enough to serve all processes quickly without scheduling. Overhead from fair scheduling reduces the throughput that makes NVMe valuable.

---

## Regression 3: Writeback cgroup integration — I/O latency for cgrouped workloads in v4.2

*Introduced: v4.2 (August 2015). Stabilization patches through v4.5.*

### Before state

Before v4.2, dirty page writeback was entirely per-BDI (per-device), with no awareness of cgroups. A container doing heavy writes could dirty a large portion of the system's dirty threshold, causing writeback to run at high priority and potentially throttling processes in other containers.

The `memory` cgroup could track memory usage per container. But writeback — the asynchronous process of flushing dirty pages to disk — ran in global kworker threads that were not cgroup-aware. A container could trigger heavy writeback from a kworker thread that was accounted to the root cgroup, making I/O accounting and isolation incomplete.

### The change

Cgroup-aware writeback (v4.2) changed this: writeback kworkers became aware of which `memory` cgroup owned each dirty page. Writeback was now done in the context of the owning cgroup, allowing:

- Per-container `io.stat` accounting
- Per-container dirty throttling (with cgroup v2 `io` controller)
- Accurate attribution of writeback I/O to the container that generated the dirty pages

This was a significant architectural change. The `struct bdi_writeback` was extended to be per-cgroup, and the writeback work item scheduler was modified to maintain per-cgroup context.

### Observed regression

After v4.2, users running containerized workloads reported:

**Regression 1: Writeback stalls for containers with large dirty data**

Under cgroup-aware writeback, the dirty throttling threshold was applied per-cgroup. A container that filled its dirty quota was throttled — but the throttling now accounted for the cgroup's entire memory usage, not just the active dirty pages. Containers that had previously coasted within the global dirty threshold were now throttled more aggressively.

**Regression 2: Writeback kworker migration overhead**

The cgroup-aware kworker threads needed to migrate writeback work to the correct cgroup's worker pool. Under high write rates from many containers, this migration added scheduling overhead that showed up as increased `write()` tail latency.

**Regression 3: Interaction with memcg reclaim**

The `memory` cgroup's reclaim logic would attempt to free pages by triggering writeback. Cgroup-aware writeback meant this reclaim-triggered writeback ran in the context of the container being reclaimed — which could cause the container's writeback kworker to compete with its own application for I/O bandwidth.

### Root cause

The interaction between dirty throttling (which limited per-container write rates), memcg reclaim (which triggered writeback during memory pressure), and the cgroup-aware kworker scheduling was complex. Edge cases in the three-way interaction produced latency spikes that were not visible in synthetic benchmarks.

Stabilization patches: [commit 703c2708f (writeback: cgroup writeback: don't share bdi_writeback among multiple cgroups)](https://git.kernel.org/linus/703c2708f), [commit 9a7c032c9 (writeback: don't issue wb_writeback_work if the bdi is not registered)](https://git.kernel.org/linus/9a7c032c9).

### Resolution

The writeback cgroup integration stabilized over v4.2 through v4.5 as the three-way interaction was better understood and edge cases fixed. The feature itself was sound; the regressions were in the implementation rather than the design.

Modern kernels (v5.x+) have stable cgroup-aware writeback. The combination with cgroup v2's `io.max` and `io.weight` controls provides the per-container I/O isolation that the feature was designed to enable.

### What it taught us

**Cross-subsystem integration amplifies complexity.** Writeback, memory management, and cgroup scheduling are each complex. Their interaction is a product of their individual complexities. Features that integrate across subsystems need to be tested against workloads that exercise all three simultaneously.

**Synthetic benchmarks miss real-world regressions.** The writeback cgroup regressions were not visible in single-container or single-process benchmarks. They only appeared under realistic multi-container workloads with concurrent memory pressure.

---

## Regression 4: `O_DIRECT` + `io_uring` corking — throughput drop for mixed workloads in v5.8

*Reported: v5.8 (August 2020). Fixed in v5.10.*

### Before state

io_uring's `IORING_SETUP_IOPOLL` mode allows applications to poll for I/O completions rather than waiting for interrupts. This reduces latency for NVMe workloads where interrupt handling overhead is measurable.

### The change

In v5.8, the io_uring code was changed to batch (or "cork") multiple `O_DIRECT` write completions before waking up the polling thread. The intent was to reduce the frequency of wakeups and amortize the overhead of the poll loop across multiple completions.

### Observed regression

Mixed workloads that submitted a mix of small `O_DIRECT` reads (latency-sensitive) and large `O_DIRECT` writes (throughput-oriented) saw the read completions delayed by the corking logic. A large write completion batch could hold up read completions for 50-100µs beyond their natural completion time.

Applications using io_uring for low-latency reads reported p99 latency increases of 2-5× compared to pre-v5.8.

### Root cause

The corking logic did not distinguish between I/O classes (reads vs writes) or between latency-sensitive and throughput-oriented operations. All completions in the same ring were treated identically — if a write was being batched, a concurrent read completion waited for the batch to be released.

### Resolution

Fixed in v5.10 ([commit 90696f](https://git.kernel.org/linus/90696f)) by limiting corking to completions of the same I/O type and adding a maximum cork time of 1µs. Reads were no longer delayed by write batches.

### What it taught us

**Batching optimizations need per-class policies.** Batching is effective for throughput, but it adds latency — that latency must not affect classes of I/O that didn't request it. Any batching optimization that applies uniformly to all I/O in a ring will hurt mixed-class workloads.

---

## Related pages

- [War Stories: Data Loss](war-stories-data-loss.md) — when I/O bugs cause data corruption
- [War Stories: CVEs](war-stories-cves.md) — security vulnerabilities in the I/O stack
- [Writeback Internals](writeback-internals.md) — how the dirty throttling algorithm works
- [io_uring Architecture](../io-uring/io-uring-arch.md) — io_uring design
- [I/O Schedulers](../block/io-schedulers.md) — BFQ, Kyber, mq-deadline
