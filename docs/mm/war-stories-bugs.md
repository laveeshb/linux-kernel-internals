# War Stories: mm Bug Incident Narratives

> Three production bugs that revealed deep design problems in the Linux memory manager — told from the moment operators noticed something was wrong through the investigation, fix, and design lessons that followed

These are not hypothetical examples or theoretical risks. Each story is grounded in public LKML discussions, kernel commit messages, and documented production reports. Specific commit hashes are provided for details that can be verified in the kernel git history. Where details are approximated or inferred from public sources rather than directly verifiable from commits, that is noted.

The three bugs were chosen to cover different parts of the subsystem and different classes of failure:

| Bug | Area | Failure class | Era |
|-----|------|---------------|-----|
| zone_reclaim_mode | NUMA reclaim policy | Silent perf destruction | 2006–2014 |
| THP compound page locking | Page allocator / AIO path | Collateral overhead | 2011–2013 |
| RSS percpu_counter inaccuracy | Memory accounting / OOM | Wrong victim selection | 2022–2026 |

---

## Bug 1: zone_reclaim_mode — The NUMA Reclaim Policy That Destroyed Performance by Default

*Introduced approximately v2.6.16 (2006). Disabled by default in v3.16 (2014). Commit: [4f9b16a64753](https://git.kernel.org/linus/4f9b16a64753).*

### The symptom

Operators running databases, web servers, and in-memory caches on NUMA hardware — typically two- or four-socket x86 servers — noticed that their applications ran significantly slower than expected. The symptoms were inconsistent: some servers were fine, others on identical hardware were not. Performance could drop by 50% or more on the affected machines without any obvious cause.

The slowdown did not correlate with CPU saturation, network latency, or disk I/O. Memory appeared to have plenty of free space. The kernel was not swapping. Yet the application was clearly spending time waiting.

A careful operator inspecting `/proc/vmstat` would find elevated counts for `zone_reclaim_failed` — a counter that incremented every time the kernel tried to reclaim memory from the local NUMA node and failed. The reclaim was failing because there was nothing to reclaim locally: the workload's active pages were spread across both NUMA nodes, but `zone_reclaim_mode` was forcing the allocator to repeatedly try (and fail) to satisfy allocations from a single node before spilling to the other.

### Investigation

The investigation path was difficult because the slowdown was not obviously memory-related from the application side. A process accessing remote NUMA memory experiences higher latency on every memory access, which manifests as reduced throughput across the board — slower queries, higher latency, less IPC — with no single bottleneck visible in top-level tools.

The first clue for many operators was the `numastat` tool, which revealed that a large fraction of memory accesses were going to a non-local NUMA node:

```bash
numastat -p <pid>
# Per-NUMA-node allocation statistics for a process
# A large gap between local and remote allocations suggests
# zone_reclaim_mode is interfering with cross-node allocation

cat /proc/vmstat | grep zone_reclaim
# zone_reclaim_failed: <large number>
# Each increment means the kernel tried to reclaim locally but couldn't
```

For those who knew to look, the setting was visible:

```bash
cat /proc/sys/vm/zone_reclaim_mode
# 1   ← enabled; this is the culprit
```

Setting it to zero immediately recovered performance, which confirmed the diagnosis. The fix was one sysctl away, but only for those who knew it existed.

### Root cause

`zone_reclaim_mode` was introduced when NUMA systems were predominantly found in HPC clusters. The workloads on those machines were carefully partitioned: each NUMA node ran a distinct slice of a distributed computation, and cross-node memory access was genuinely expensive and to be avoided. When memory on a node became tight, the correct behavior was to reclaim local pages rather than spill to a remote node — the remote-access penalty was worse than the reclaim cost.

When enabled (`zone_reclaim_mode=1`), the kernel's page allocator would, before falling through to a remote NUMA node, attempt to reclaim pages from the local node's LRU lists. This reclaim ran inline during the allocation path: the allocating process was stalled while the kernel scanned and evicted pages from the local node.

The problem was that this assumption — cross-node access is always worse than local reclaim — stopped being true as NUMA hardware became commonplace outside HPC. On a modern two-socket database server:

1. The workload's hot pages were spread across both nodes naturally.
2. The application's working set did not fit in one node.
3. `zone_reclaim_mode` forced the allocator to reclaim active working-set pages from the local node before allocating from the remote node.
4. Those evicted pages were promptly faulted back in, creating a reclaim-fault-evict loop.
5. Remote-node allocations eventually happened anyway — after the reclaim attempt — so the reclaim was wasted work that also damaged the working set.

The Mel Gorman commit message that finally disabled the default put it plainly ([4f9b16a64753](https://git.kernel.org/linus/4f9b16a64753)):

> *"zone_reclaim_mode causes processes to prefer reclaiming memory from local node instead of spilling over to other nodes. This made sense initially when NUMA machines were almost exclusively HPC and the workload was partitioned into nodes. The NUMA penalties were sufficiently high to justify reclaiming the memory. On current machines and workloads it is often the case that zone_reclaim_mode destroys performance but not all users know how to detect this."*

### The fix

The immediate fix was runtime: setting `vm.zone_reclaim_mode=0` disabled the local-first reclaim policy and allowed the allocator to spill to remote nodes freely. Performance recovered immediately on affected systems.

```bash
# Disable zone_reclaim_mode (makes cross-node allocation free to proceed)
sysctl vm.zone_reclaim_mode=0
echo 0 > /proc/sys/vm/zone_reclaim_mode
```

The structural fix was commit [4f9b16a64753](https://git.kernel.org/linus/4f9b16a64753) (v3.16, June 2014), authored by Mel Gorman, which changed the kernel default from `1` to `0`. The commit was acked by Johannes Weiner, Michal Hocko, and Christoph Lameter — the core mm team — indicating broad consensus that the old default was wrong for the majority of systems.

A companion commit, [6b187d0260b6](https://git.kernel.org/linus/6b187d0260b6), refined the heuristic for when zone_reclaim should even be considered: it is now only auto-enabled if the NUMA node distance exceeds a threshold (`RECLAIM_DISTANCE`, typically 30), meaning nodes that are truly remote (not just on different sockets but with reasonable interconnect) still benefit from the policy.

### Design lesson

**Default behavior must match the majority workload, not the historical workload.** Zone_reclaim_mode made sense when it was introduced because the machines it ran on were nearly all HPC clusters with partitioned workloads. By the time NUMA servers were everywhere, the default was wrong for most users — but it remained on for years because those who needed to disable it had to know about an obscure sysctl.

**Silent performance destruction is worse than an error.** Zone_reclaim_mode did not produce errors, warnings, or unusual metrics that an operator unfamiliar with the option would recognize as its signature. The failure mode was a percentage-point throughput reduction with no obvious cause. A performance bug that produces only "things are slower" without a clear signal pointing to the root cause can persist for years in production.

!!! note "Design change that followed"
    After this experience, there was renewed attention to NUMA policy defaults and documentation. The kernel documentation for `zone_reclaim_mode` was expanded to note that it is typically harmful unless the node NUMA distance is large enough that cross-node access is genuinely expensive. The `numastat` and `numactl` tooling improved, and distributions began including NUMA tuning guidance in their documentation for database workloads.

    If you run NUMA hardware and are experiencing unexplained performance degradation, verify this setting before investigating anything else:
    ```bash
    cat /proc/sys/vm/zone_reclaim_mode
    # Should be 0 on most workloads; if it's nonzero, try setting it to 0
    ```

---

## Bug 2: THP's Compound Page Locking Overhead Broke Hugetlbfs AIO

*Introduced with THP in v2.6.38 (2011). Fixed in v3.12 (2013). Commit: [7cb2ef56e6a8](https://git.kernel.org/linus/7cb2ef56e6a8).*

### The symptom

Oracle database administrators benchmarking I/O performance on Linux noticed a sharp regression after upgrading kernels. Using Oracle's `orion` I/O benchmark tool — a standard tool for characterizing storage performance under database I/O patterns — they measured read throughput from flash storage into hugetlbfs-backed buffers. The numbers from the commit message are precise:

| I/O block size | Pre-THP | After THP (v2.6.39) | After THP (v3.11-rc5) |
|----------------|---------|---------------------|----------------------|
| 1MB reads | 8,384 MB/s | 5,629 MB/s | 6,501 MB/s |
| 64KB reads | 7,867 MB/s | 4,576 MB/s | 4,251 MB/s |

The 1MB workload lost 33% throughput. The 64KB workload lost 41%. Neither was recovering in subsequent releases — the v3.11-rc5 numbers show the problem persisting two years after THP was introduced.

This was not a THP workload. The benchmark was using `shmget()` with `SHM_HUGETLB` to allocate traditional hugetlbfs pages — a mechanism that predates THP by many years. The application had not changed. The storage had not changed. Only the kernel had changed.

### Investigation

The investigation was done by Khalid Aziz at Oracle. The key tool was `perf top`, which revealed the root cause immediately:

```
# perf top output on the regressed kernel, during AIO benchmark
  40.3%  [kernel]  __get_page_tail
  18.7%  [kernel]  put_compound_page
   8.4%  [kernel]  aio_complete
   ...
```

More than 40% of CPU cycles were being consumed in two page reference counting functions: `__get_page_tail()` and `put_compound_page()`. These functions are called on every `get_page()` and `put_page()` for compound pages. Every time the AIO layer submitted I/O to a hugetlbfs page, it called `get_page()` to grab a reference; every time I/O completed, it called `put_page()` to release it. On a 64KB-block I/O benchmark doing hundreds of thousands of operations per second, these calls were on the critical path.

The question was: why were these functions expensive? They hadn't been before THP.

The answer was in what THP added to the compound page handling path. When THP was introduced, it created a new risk: a transparent huge page could be split while another thread was in the middle of `get_page()` or `put_page()`. To handle this safely, the kernel added locking to the compound page reference counting path — specifically, it acquired the compound page's lock on every `get_page_tail()` call to prevent concurrent splits from racing with reference counting.

This locking was necessary for transparent huge pages, which can be split under concurrent access. But it was applied to **all** compound pages — including traditional hugetlbfs pages, which cannot be split. Hugetlbfs pages are allocated from a preallocated pool and have a fixed size for their entire lifetime. There is no split operation. The lock was pure overhead.

### Root cause

The code path before THP: `get_page()` on a compound page tail incremented the head page's reference count atomically. Fast, no locking.

The code path after THP: `__get_page_tail()` checked `PageTail()`, then acquired the compound page lock, re-checked that the page was still a tail (in case a split happened between the check and the lock), then incremented the reference count, then released the lock. Correct for THP. Completely unnecessary for hugetlbfs.

The same pattern applied to `put_compound_page()`: releasing a reference to a compound page tail now went through a locking path that was designed to handle the case where a split might be in progress.

On a benchmark doing I/O at hundreds of thousands of requests per second, with each I/O acquiring and releasing a page reference, this overhead compounded. The compound page lock became a hot spot. `perf top` showed it clearly; the diagnosis from there was straightforward.

### The fix

Commit [7cb2ef56e6a8](https://git.kernel.org/linus/7cb2ef56e6a8) by Khalid Aziz, merged in v3.12 (November 2013), added a fast path that bypasses the split-protection locking for hugetlbfs pages. Hugetlbfs pages are identified by `PageHuge()`, which is set at allocation time and never cleared. If a compound page has `PageHuge()` set, it cannot be a transparent huge page, and therefore cannot be split. The lock is not needed.

```c
/* Simplified version of the fix logic */
static void __get_page_tail(struct page *page)
{
    if (likely(!PageTail(page)))
        return;

    /* Hugetlbfs pages cannot be split — skip the THP lock */
    if (PageHuge(compound_head(page))) {
        atomic_inc(&compound_head(page)->_count);
        return;
    }

    /* THP pages need the lock to guard against concurrent splits */
    /* ... THP-specific locking path ... */
}
```

The result was immediate: 1MB read throughput recovered to 8,371 MB/s (versus the pre-THP baseline of 8,384 MB/s — effectively full recovery). 64KB throughput improved from 4,251 MB/s to 6,510 MB/s, a 53% improvement, though still below the pre-THP baseline — indicating additional overhead remained elsewhere in the 64KB path.

### Design lesson

**Optimizations for a new feature must not add overhead to unrelated code paths.** THP's compound page split protection was necessary and correct for transparent huge pages. Applying it to all compound pages was a natural but incorrect generalization. The assumption was that the locking path was "fast enough" — but at hundreds of thousands of operations per second, even a small per-operation overhead accumulates into a major throughput regression.

**`perf top` is the right first tool for unexplained CPU-bound regressions.** The regression showed up as increased CPU consumption (lower throughput at the same CPU utilization), not as increased latency or error rates. The instant `perf top` showed `__get_page_tail` at 40% of cycles, the investigation was effectively over.

**HPC and database AIO patterns stress reference counting.** Unlike workloads that allocate pages once and hold them, direct I/O patterns constantly acquire and release page references — one per I/O operation. Code on this path must be optimized at the instruction level, not just algorithmically. A single extra lock acquire per operation can be catastrophic.

!!! note "Design change that followed"
    This bug led to more careful review of what compound page handling code applies to. The distinction between `PageHuge()` (cannot be split, no THP locking needed) and THP pages (can be split, locking needed) became an explicit consideration in the compound page code. Subsequent work on the folio abstraction further formalized the type distinctions that allow fast paths to be taken safely.

    To detect this class of regression, watch `perf top` for unexpectedly high time in reference-counting functions (`get_page`, `put_page`, `__get_page_tail`, `put_compound_page`, and their folio equivalents in newer kernels) during I/O-intensive workloads on hugetlbfs or large-page-backed memory.

---

## Bug 3: RSS Percpu Counter Inaccuracy and Wrong OOM Victims

*RSS conversion introduced in v6.2 (February 2023), commit [f1a7941243c1](https://git.kernel.org/linus/f1a7941243c1). Inaccuracy fixed in 2026, commit [5898aa8f9a0b](https://git.kernel.org/linus/5898aa8f9a0b).*

### The symptom

After upgrading to a Linux v6.2 or later kernel, engineering teams running production services on large-core-count machines began seeing two categories of anomalous behavior.

The first: monitoring systems that watched RSS to detect memory overuse started firing spuriously. A service expected to use approximately 100MB of memory — monitored by a watchdog process reading `/proc/<pid>/status` — was reporting RSS tens of megabytes higher than expected. On a machine with 250 CPU cores, a five-thread service could appear to use 100MB more memory than it actually did. For services close to their monitored limit, this caused unnecessary alerts and restarts.

The second, more serious: when the system did reach an OOM condition, the kernel killed the wrong process. A low-memory service that happened to have a large apparent RSS (due to the accounting inaccuracy) would be selected as the OOM victim even when higher-memory services were the real cause of pressure. The service with the highest real memory usage survived; a lighter service was killed in its place. This made OOM situations harder to recover from and harder to diagnose.

Both symptoms appeared after the v6.2 kernel upgrade and disappeared when reverting to v5.x. The upgrade was the only change.

### Investigation

The investigation began with the monitoring anomaly. The watchdog was reading `/proc/<pid>/status`:

```bash
cat /proc/<pid>/status | grep VmRSS
# VmRSS:    156432 kB   ← reported
# Expected: ~102400 kB (100MB)
# Discrepancy: ~54MB
```

The discrepancy varied between reads and was larger on machines with more CPUs. This suggested a statistical rather than deterministic accounting error. The natural hypothesis: something changed in how RSS is counted.

Examining the v6.2 kernel changelog pointed directly to commit [f1a7941243c1](https://git.kernel.org/linus/f1a7941243c1) ("mm: convert mm's rss stats into percpu_counter"). This commit changed the per-thread RSS batching model.

**Before v6.2**: Each thread maintained a private RSS counter with a flush threshold of `TASK_RSS_EVENTS_THRESH` (64 pages = 256KB). When a thread's counter exceeded the threshold, it was flushed to the per-`mm_struct` atomic counter. The maximum error at any moment was `nr_threads × 64 pages`. For a five-thread process: 5 × 64 × 4KB = 1.25MB. Small and bounded.

**After v6.2**: The commit converted RSS to use `percpu_counter`, the kernel's standard per-CPU approximate counter infrastructure. `percpu_counter` maintains a per-CPU batch and flushes to a global sum when the batch overflows. The batch size for `percpu_counter` scales with the number of CPUs: on a 250-CPU machine, the maximum error is approximately `nr_cpus × batch_size × nr_counters`. The commit message acknowledges this scaling:

> *"convert the error margin from (nr_threads * 64) to approximately (nr_cpus ^ 2)"*

The intent was to reduce lock contention on the per-`mm_struct` counter in highly multithreaded workloads, which was a real problem. But the tradeoff — error scaling approximately as CPU count squared — was not adequately considered in the contexts where RSS accuracy matters most: OOM victim selection and memory monitoring.

On a 250-CPU machine, the error margin grew from bounded kilobytes to potentially gigabytes. A single process could appear to have RSS several hundred megabytes different from its actual resident set size. The commit noted that readers like OOM killer and memory reclaim "are not performance critical and should be ok with slow read" — but it did not implement a precise read path, leaving them using the fast (inaccurate) counter.

### Root cause

The `percpu_counter` infrastructure is designed for statistics where approximate values are sufficient: page counts, network packet counters, event rates. The `percpu_counter_read()` function returns the approximate value immediately. `percpu_counter_sum()` returns the precise value but is slow because it must sum across all per-CPU slots.

After v6.2, `get_mm_counter()` — used throughout the OOM killer and in `/proc` RSS reporting — called `percpu_counter_read()`. This was accurate enough for short reports on small machines but degraded on large machines because threads migrated between CPUs during their lifetime, leaving stale values in per-CPU slots that were not yet flushed.

The OOM killer path in `oom_badness()` used `get_mm_counter()` to read RSS for each process when selecting a victim. On a 250-CPU server:

- Process A (the real memory hog): actual RSS 2GB, reported as 1.7GB
- Process B (a small service): actual RSS 100MB, reported as 650MB

The OOM killer kills Process B. Process A continues running and immediately triggers another OOM. The system enters an OOM loop killing innocent services.

The bug report from Sweet Tea Dorminy, as quoted in the fix commit, described exactly this scenario occurring in production.

### The fix

Commit [5898aa8f9a0b](https://git.kernel.org/linus/5898aa8f9a0b) (January 2026) introduced `get_mm_counter_sum()`, which calls `percpu_counter_sum()` instead of `percpu_counter_read()` for contexts where accuracy matters. The OOM killer's victim selection, its console dump output, and the OOM reaper's progress reporting were all converted to use the precise version.

The tradeoff is explicit: `percpu_counter_sum()` must read all per-CPU slots, taking time proportional to the number of CPUs. For the OOM killer this is acceptable — OOM events are infrequent, and waiting a few extra microseconds for accurate RSS values is far preferable to killing the wrong process.

```c
/* Before fix — fast but potentially gigabytes off on large machines */
points += get_mm_counter(p->mm, MM_ANONPAGES) +
          get_mm_counter(p->mm, MM_FILEPAGES) +
          get_mm_counter(p->mm, MM_SHMEMPAGES);

/* After fix — slower but accurate when it counts */
points += get_mm_counter_sum(p->mm, MM_ANONPAGES) +
          get_mm_counter_sum(p->mm, MM_FILEPAGES) +
          get_mm_counter_sum(p->mm, MM_SHMEMPAGES);
```

The fix also addressed the same inaccuracy in the RSS values printed to the kernel log when an OOM kill occurs — previously, the logged RSS could be wildly wrong on large machines, making post-mortem analysis misleading.

### Design lesson

**Approximate counters are not interchangeable with exact counters in decision-making paths.** The `percpu_counter` infrastructure is deliberately approximate — that is its purpose. Converting an RSS counter to use it is an appropriate optimization for hot paths where exact values are not needed. The mistake was not providing a precise read path and ensuring that all callers requiring accuracy used it. The comment in the original commit ("OOM killer and memory reclaim are not performance critical and should be ok with slow read") identified the right concern but was not translated into code.

**The error bound of a counter must be understood relative to the values being measured.** A 1MB error margin in a 1GB RSS measurement is 0.1% — negligible. The same error formula on a 250-CPU machine produces errors in the hundreds of megabytes. When the error exceeds the difference in RSS between processes, the ranking used by the OOM killer is meaningless. Error analysis must be done in the context of real-world machine sizes, not development workstations.

**Wrong OOM kills cause cascading failures.** If the OOM killer kills the wrong process, memory is not freed from the real cause of pressure. Another OOM condition triggers quickly. The new victim is again selected inaccurately. Systems can enter OOM loops that kill many correct processes before the real culprit is finally selected — or never select it at all.

!!! note "Design change that followed"
    This bug reinforced a design rule: callers of RSS counters must explicitly choose between the approximate and precise read. The `get_mm_counter()` / `get_mm_counter_sum()` split makes this explicit. Any new caller of `get_mm_counter()` must consciously accept that it may be off by large amounts on many-core systems.

    If you operate large servers (100+ CPU cores) and are running kernels v6.2 through approximately v6.24, verify whether your OOM kill logs show accurate RSS values by comparing the logged `anon-rss` against `/proc/<pid>/smaps_rollup` for the killed process at OOM time. If the logged values differ substantially from expected, this bug may be affecting your OOM victim selection.

    ```bash
    # Check kernel version for the fix
    uname -r
    # Fix is in commits merged after January 2026

    # At OOM time, the kernel logs:
    # "Killed process <pid> (<name>) total-vm:X anon-rss:Y file-rss:Z"
    # On a v6.2-v6.24 kernel with 100+ CPUs, Y and Z may be significantly wrong
    ```

---

## Summary: What These Bugs Have in Common

All three bugs share a structural pattern that appears repeatedly in mm development:

| Pattern | zone_reclaim_mode | THP compound locking | RSS percpu inaccuracy |
|---------|-------------------|----------------------|----------------------|
| **Assumption that failed** | NUMA workloads are partitioned | All compound pages can be split | Approximate counts are good enough everywhere |
| **Who was affected** | Multi-socket NUMA servers | Hugetlbfs + AIO (databases) | Many-core servers (100+ CPUs) |
| **Detection tool** | numastat, vmstat | perf top | /proc/status, OOM logs |
| **Time to default fix** | ~8 years | ~2 years | ~3 years |
| **Fix type** | Changed default | Added fast path | Added precise read path |

The recurring theme: **an optimization correct in one context becomes harmful in a different context**, and the harm is difficult to see without knowing what to look for. All three bugs survived in production for years because their signatures were "unexplained performance degradation" or "occasional wrong behavior" rather than crashes or data loss.

!!! note "Investigation toolkit for mm bugs"
    These three bugs can be investigated with standard Linux tools:

    ```bash
    # zone_reclaim_mode: check NUMA reclaim activity
    cat /proc/sys/vm/zone_reclaim_mode
    cat /proc/vmstat | grep zone_reclaim

    # Compound page locking: profile reference counting overhead
    perf top -e cycles:k
    # Look for get_page, put_page, __folio_put variants at high percentages

    # RSS accuracy: compare approximate vs. precise RSS
    cat /proc/<pid>/status | grep VmRSS       # uses approximate counter
    cat /proc/<pid>/smaps_rollup | grep Rss   # forces precise accounting
    # Large discrepancy on many-core systems indicates the percpu inaccuracy
    ```

## See also

- [thp.md](thp.md) — THP configuration, defrag modes, and khugepaged tuning
- [oom.md](oom.md) — OOM killer mechanics, deadlocks, and the OOM reaper
- [war-stories-regressions.md](war-stories-regressions.md) — Performance regressions from mm changes (THP defrag stalls, NUMA balancing overhead, khugepaged CPU storms)
- [war-stories-cves.md](war-stories-cves.md) — Security vulnerability narratives (Dirty COW, StackRot, THP COW race)
- [numa.md](numa.md) — NUMA memory policy and the zone_reclaim design
- [reclaim.md](reclaim.md) — How kswapd and direct reclaim work
