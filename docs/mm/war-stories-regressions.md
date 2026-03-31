# War Stories: Performance Regressions from mm Changes

> Real regressions from Linux memory management changes — what broke, why, and what the kernel learned

Memory management is one of the most performance-sensitive parts of the kernel. Changes that look correct on paper — and that pass all existing tests — can cause severe regressions in production workloads that the test suite never exercised. This page documents four well-known regressions drawn from public LWN articles, kernel commit logs, and LKML discussions.

These are not hypothetical risks. Each caused real outages or performance degradations that drove kernel developers to add new tunables, redesign subsystems, or rethink default behavior.

---

## Case 1: THP defrag=always and synchronous compaction stalls (v2.6.38–v4.x)

### Before state

Before Transparent Huge Pages (v2.6.38, 2011), applications ran entirely on 4KB pages. Latency-sensitive workloads like Redis or database buffer pools were predictable: a page fault was a page fault, taking roughly the same time every time.

### The change

THP shipped in v2.6.38 with `defrag=always` as the default mode for the `defrag` knob. This meant that every time the kernel tried to allocate a 2MB huge page and physical memory was fragmented, it would invoke synchronous memory compaction inline — in the page fault handler, while the faulting process was blocked waiting for the fault to complete.

The intent was sound: compact memory eagerly so that huge pages are always available. The problem was that compaction is expensive. It scans large ranges of physical memory, identifies movable pages, and migrates them to create a 2MB contiguous region. On a loaded system, this work could take many milliseconds.

### Observed regression

Latency-sensitive applications — Redis instances, PostgreSQL, MySQL, and Java workloads with large heap sizes — began reporting random latency spikes. A request that normally completed in under a millisecond would occasionally take tens of milliseconds or more. The spikes were irregular and hard to reproduce in testing because they depended on the fragmentation state of physical memory, which varied with system uptime and allocation patterns.

The pattern was first widely noticed and documented in LWN coverage of THP behavior (see [LWN: Transparent huge pages in 2.6.38](https://lwn.net/Articles/423584/) and subsequent follow-up articles). Database operators discovered that enabling THP — often enabled by default in distributions — was causing the problem.

### Why it happened

The compaction path (`try_to_compact_pages` → `compact_zone`) walks physical memory looking for movable pages and free pages to create a contiguous 2MB region. This work scales with the number of pages scanned, not the size of the allocation. On a fragmented 64GB system, satisfying a single 2MB THP allocation could require scanning and migrating hundreds of megabytes of physical memory.

This happened synchronously in the fault path. The faulting process was blocked the entire time. From the application's perspective, a normal anonymous page fault took an unpredictable, arbitrarily long time.

Worse, the trigger was non-deterministic: compaction was only needed when memory was fragmented. A freshly booted system rarely triggered it. A system that had been running for hours, with many allocations and frees creating "Swiss cheese" fragmentation, triggered it constantly.

### Resolution

The kernel added new `defrag` modes to give operators and applications more control:

```bash
# View current defrag mode
cat /sys/kernel/mm/transparent_hugepage/defrag
# [always] defer defer+madvise madvise never

# Avoid synchronous compaction on fault
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# Or opt out of defrag entirely
echo madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

The `defer` mode (added in v4.6, commit [444eb2a449ef](https://git.kernel.org/linus/444eb2a449ef)) hands defragmentation off to khugepaged to do asynchronously in the background, rather than stalling the faulting process. The `defer+madvise` mode combines this: asynchronous for all memory, but synchronous only for regions that the application has explicitly tagged with `MADV_HUGEPAGE`.

Applications that genuinely need huge pages and can tolerate occasional stalls (such as KVM guests doing large sequential allocations) can opt in to synchronous defrag per-region using `madvise`:

```c
/* Only compact synchronously for this specific region */
madvise(ptr, size, MADV_HUGEPAGE);
```

Meanwhile, latency-sensitive workloads that never needed THP got guidance to disable it entirely:

```bash
echo never > /sys/kernel/mm/transparent_hugepage/enabled
```

Many Linux distributions changed their defaults away from `defrag=always` as a result of this class of regression. See [compaction.md](compaction.md) for how compaction works and [thp.md](thp.md) for THP configuration details.

### What it taught us

**Synchronous work in the fault path has unbounded latency.** Any operation that can scale with system state (fragmentation, memory size) and runs inline during a page fault will produce latency spikes proportional to that state. The lesson generalized beyond THP: the kernel should never do expensive, open-ended work in a path that a latency-sensitive process is blocked on.

**Opt-in semantics for expensive optimizations matter.** THP delivered real throughput wins for workloads with large, contiguous working sets — but the default behavior of `defrag=always` imposed those costs on all workloads, including ones that never benefited. The fix was not to remove the optimization but to make its most expensive part opt-in.

!!! warning "Pattern to watch for"
    If your application shows irregular latency spikes that appear only after the system has been running for hours (not at startup), and the spikes are not correlated with I/O or CPU saturation, check whether THP defrag is triggering synchronous compaction. Look for time spent in `try_to_compact_pages` via `perf top` or trace the `mm_compaction_begin` tracepoint.

    ```bash
    # Check for compaction events
    cat /proc/vmstat | grep compact
    # compact_stall: number of times a process stalled for compaction
    # compact_fail:  compaction ran but did not produce a huge page
    ```

---

## Case 2: Automatic NUMA balancing overhead (v3.13)

### Before state

Before v3.13, NUMA-aware placement was entirely the application's responsibility. Operators used `numactl --membind` or `numactl --interleave` to control where memory was allocated, and workloads that cared about locality had to be tuned manually. Most workloads ran without any NUMA policy and got whatever the default allocator gave them (typically local-node allocation via the `MPOL_DEFAULT` policy).

This was imperfect — processes could migrate between CPUs and end up with remote memory — but it was **predictable**. The kernel did not move pages after they were allocated.

### The change

Automatic NUMA balancing (`CONFIG_NUMA_BALANCING`) was introduced in v3.13 by Mel Gorman. The design addressed a real problem: processes that migrated between NUMA nodes ended up accessing remote memory, paying a latency penalty on every access. The kernel had no mechanism to detect this and correct it.

The mechanism worked by periodically unmapping pages (marking PTEs as inaccessible) to catch access faults. When a process faulted on a page it had previously accessed, the kernel recorded which CPU caused the fault, measured the locality, and could decide to migrate the page closer to that CPU. The scanning was rate-limited by `numa_balancing_scan_period_min_ms` and `numa_balancing_scan_size_mb`.

### Observed regression

Several classes of workload regressed:

**HPC and batch workloads** that had carefully placed their memory with `numactl` or `mbind` found that the kernel was now unmapping and re-migrating pages that were already in the right place. The extra faults and TLB shootdowns added overhead with no benefit.

**Workloads with shared memory** — multiple processes accessing the same pages — saw contention. When two processes on different NUMA nodes both access a shared page, NUMA balancing cannot satisfy both; it may migrate the page back and forth, causing what is known as NUMA page thrashing.

**Latency-sensitive workloads** noticed that the periodic unmapping caused bursts of minor faults that temporarily increased access latency. Even if the page was not migrated, the TLB miss caused by the intentional unmap added latency to subsequent accesses until the TLB was re-populated.

The regressions were documented in LKML discussions shortly after v3.13 shipped (see the `linux-numa` and `linux-mm` archives from early 2014) and in LWN's coverage of NUMA balancing.

### Why it happened

The core mechanism — intentionally unmapping pages to catch faults — has inherent cost regardless of whether migration occurs:

1. **TLB shootdowns**: Unmapping a page that is mapped in multiple processes requires sending inter-processor interrupts to all CPUs that have a TLB entry for that page. On large NUMA systems with many CPUs, this is expensive.

2. **Page table lock contention**: Scanning and modifying PTEs requires holding page table locks, which contend with the application's own page fault handling.

3. **Migration overhead when pages are already local**: If a workload was already correctly placed (e.g., via `numactl`), NUMA balancing would still scan, unmap, and fault — incurring overhead without delivering benefit.

4. **Shared pages amplify contention**: Two threads on different nodes racing to pull a shared page local will each trigger migration, resulting in the page bouncing between nodes.

The problem was that NUMA balancing applied to all processes by default, including those that had already been carefully tuned or that had workloads unsuitable for automatic migration.

### Resolution

The kernel added sysctls to control NUMA balancing behavior:

```bash
# Disable automatic NUMA balancing system-wide
echo 0 > /proc/sys/kernel/numa_balancing

# Check current state
cat /proc/sys/kernel/numa_balancing
```

Per-process control is available via the `prctl` interface:

```c
/* Disable NUMA balancing for this process */
prctl(PR_SET_THP_DISABLE, 0, 0, 0, 0);  /* not NUMA-specific */

/* Use NUMA policy instead */
/* mbind(addr, len, MPOL_BIND, nodemask, maxnode, flags) */
```

Scan rate tunables were also refined over subsequent releases:

```bash
# How long to wait before re-scanning a region (milliseconds)
cat /proc/sys/kernel/numa_balancing_scan_period_min_ms  # default: 1000
cat /proc/sys/kernel/numa_balancing_scan_period_max_ms  # default: 60000

# How much memory to scan per period (MB)
cat /proc/sys/kernel/numa_balancing_scan_size_mb        # default: 256

# How long to delay migration after detecting a fault (ms)
cat /proc/sys/kernel/numa_balancing_scan_delay_ms       # default: 1000
```

The general guidance that emerged: workloads with well-understood NUMA topology should use explicit `numactl`/`mbind` placement and disable automatic balancing. Automatic balancing is most useful for workloads whose NUMA access patterns are dynamic or unknown.

### What it taught us

**Proactive optimization that interferes with deliberate placement is net negative.** The kernel did not know that an operator had already pinned a workload to specific NUMA nodes. From its perspective, a process accessing remote memory looked like a candidate for migration. The solution required adding control surfaces so that operators (and applications) could opt out.

**Fault-based sampling has side effects.** Using intentional faults to gather access statistics works, but every fault has cost: TLB invalidation, page table lock acquisition, and potential migration. The measurement instrument changed the system it was measuring. NUMA balancing's scan rate controls exist to limit this overhead.

**TLB shootdowns are expensive at scale.** On a 4-socket server with 256 hardware threads, unmapping a shared page requires broadcasting IPI to all CPUs that have a TLB entry — potentially all 256. This overhead does not appear on 2-socket test machines used during development but becomes significant in production.

!!! warning "Pattern to watch for"
    If a workload that was tuned with `numactl` or `taskset` regresses after upgrading to v3.13 or later, check whether automatic NUMA balancing is active. High `numa_pages_migrated` in `/proc/vmstat` combined with no improvement in NUMA locality (measured via `perf stat -e node-loads,node-load-misses`) suggests the balancer is working against a workload that was already correctly placed.

    ```bash
    # Check NUMA balancing activity
    grep -E 'numa_|pgmigrate' /proc/vmstat

    # Key counters:
    # numa_page_migrated   - pages moved by NUMA balancing
    # numa_pages_migrated  - (older kernels, same meaning)
    # pgmigrate_success    - successful migrations
    # pgmigrate_fail       - failed migrations (contention)

    # Check per-node memory access balance
    numastat -n
    ```

---

## Case 3: khugepaged CPU storms on multi-process systems

### Before state

Before THP (v2.6.38), the kernel had no background thread scanning process address spaces looking for memory to reorganize. Background memory activity was limited to kswapd (reclaim) and pdflush/writeback threads. These were well-understood and their CPU usage was proportional to memory pressure.

### The change

THP introduced khugepaged, a kernel thread whose job is to find 512 contiguous 4KB pages in a process's address space and collapse them into a single 2MB huge page. This runs asynchronously, decoupled from the fault path. The intent was to allow THP to improve over time: even if a 2MB page couldn't be allocated at fault time (because memory was fragmented), khugepaged could later consolidate the 4KB pages into a huge page once there was an opportunity.

The initial implementation was tuned for systems with relatively few long-lived processes.

### Observed regression

On systems running many processes — container hosts, build farms, CI systems, servers running hundreds of worker processes — khugepaged caused periodic CPU spikes. The spikes were visible in `top` and `perf top` as `khugepaged` consuming 1-5% of a CPU core periodically.

The pattern: khugepaged woke up on its scan interval, worked through a list of registered processes (all processes with THP regions), scanned each one looking for collapsible regions, and then slept again. On a system with hundreds of processes each with multi-gigabyte address spaces, this scan took significant CPU time even when there was nothing useful to collapse.

In some cases, the scanning itself was harmful: khugepaged needed to acquire `mmap_lock` (formerly `mmap_sem`) in read mode to walk process page tables. On processes with heavily-used address spaces, this created contention with the application's own page fault handling.

### Why it happened

The scan cost had two components:

1. **Iterating processes**: khugepaged maintained a list of all anonymous VMAs with THP enabled. Even VMAs with no collapsible pages needed to be visited to discover they were not collapsible.

2. **The "almost collapsible" problem**: When a 2MB region had 511 of 512 pages present (one page missing), khugepaged found it promising but could not collapse it. With the default `max_ptes_none=511`, it would attempt collapse, allocate a 2MB page, fail because not all pages were present, and retry on the next scan cycle. Each retry consumed CPU and caused TLB activity.

The CPU budget for khugepaged was not well-bounded relative to the number of processes or the size of their address spaces.

### Resolution

The main levers for controlling khugepaged CPU usage are its scan interval and the number of pages it scans per wakeup:

```bash
# Increase sleep between scans (default: 10000ms)
echo 60000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs

# Reduce pages examined per scan period (default: 4096)
echo 1024 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan

# Restrict collapse to regions where all pages are present
# (reduces wasted work on "almost collapsible" regions)
echo 0 > /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none
```

The `max_ptes_none` tunable is particularly effective at reducing wasted work: setting it to 0 means khugepaged will only collapse a region when all 512 pages are present, avoiding repeated failed collapse attempts.

For systems where THP latency benefits are not needed (latency-sensitive apps, containers with small heaps), disabling THP entirely eliminates khugepaged's work:

```bash
echo never > /sys/kernel/mm/transparent_hugepage/enabled
```

Over several kernel releases, khugepaged's scheduling was improved to better track which VMAs had changed since the last scan, avoiding rescanning unchanged regions. The per-process scan list management also improved.

### What it taught us

**Background optimization threads need CPU budgeting proportional to actual work available, not system size.** A system with 500 processes needs khugepaged to efficiently skip processes that have nothing to collapse, rather than visiting them all every scan cycle.

**"Almost collapsible" is worse than "not collapsible."** A region that is clearly not a candidate for THP is skipped cheaply. A region that looks like it might be a candidate but cannot yet be collapsed causes repeated wasted work. Setting conservative thresholds (like `max_ptes_none=0`) trades some missed optimization opportunities for predictable CPU overhead.

**Per-workload THP configuration matters.** Container environments running mixed workloads benefit from per-container THP control. Modern kernels support this via the cgroup THP interface, allowing some containers to use THP while others opt out.

!!! warning "Pattern to watch for"
    Periodic CPU spikes appearing in `top` or `perf top` attributed to `khugepaged` on systems with many processes are a sign of khugepaged over-scanning. Check the scan interval and pages_to_scan settings, and review whether the workloads on the system actually benefit from THP. Also watch for high values of `thp_collapse_alloc_failed` in `/proc/vmstat`, which indicates khugepaged is doing work but failing to collapse.

    ```bash
    # Check khugepaged activity
    cat /proc/vmstat | grep thp
    # thp_collapse_alloc        - successful collapses
    # thp_collapse_alloc_failed - attempted but failed

    # High failure rate = wasted CPU
    # Consider reducing pages_to_scan or raising max_ptes_none threshold
    ```

---

## Case 4: Swap readahead window mismatch

### Before state

The Linux swap readahead mechanism prefetches swap pages sequentially when a page fault causes a swap-in. The assumption: if you're faulting in swap page N, you'll probably need swap page N+1, N+2, etc. soon. This is the same principle as page cache readahead for files. Reading ahead reduces latency for sequential swap access by hiding disk seek latency.

The original readahead window was small and conservative.

### The change

The swap readahead logic has been revised multiple times across kernel versions. In some versions, the readahead window size was increased to improve throughput for swap-heavy workloads. The changes affected how many additional pages the kernel would prefetch beyond the page that actually faulted.

### Observed regression

Two opposite failure modes have been observed at different times, both documented in LKML and LWN discussions of swap readahead behavior:

**Window too large (over-prefetching)**: When the readahead window was large, the kernel issued I/O for many swap pages beyond what was needed. For workloads with random swap access patterns — common when many unrelated processes are swapping independently — the prefetched pages were never accessed. This wasted I/O bandwidth and polluted the swap cache with pages that would need to be evicted before pages that were actually needed could be brought in. Effective swap throughput decreased.

**Window too small (under-prefetching)**: When the window was reduced to address over-prefetching, workloads with genuinely sequential swap access patterns — such as a single large process that had been partially swapped out and was now being restored — suffered. Each page fault caused only a small readahead, resulting in many sequential I/O operations where one larger I/O would have been more efficient.

The regression pattern was documented in discussions around the swap readahead code in `mm/swap_state.c` and `mm/swap_slots.c`. The problem is described in the context of the "swap readahead trap" covered in [swapping.md](swapping.md#case-5-the-swap-readahead-trap).

### Why it happened

Swap readahead inherits the same fundamental tension as page cache readahead: the kernel must predict whether future access will be sequential or random, using only past access patterns as a hint. For swap, this prediction is harder than for files because:

1. **Swap pages from different processes are interleaved**: Unlike a file whose blocks are laid out with some locality, swap slots for process A and process B may alternate. A large readahead window for process A's fault may pull in process B's pages that process B will not need until much later.

2. **Swap is accessed under memory pressure**: Swap-ins happen when memory is already tight. Reading ahead aggressively competes for the same scarce I/O bandwidth as the swap-outs that are also happening.

3. **Access patterns are not stationary**: A process being restored from swap accesses pages in roughly the order it accesses memory on startup, which may not match the order they were swapped out. Sequential on-disk layout does not imply sequential access order.

The readahead window is a single global parameter that cannot capture this workload diversity.

### Resolution

The kernel's swap readahead path in `mm/swap_state.c` has been revised over multiple releases to use adaptive window sizing and better sequential detection. The `page_cluster` sysctl controls the readahead window:

```bash
# View current swap readahead cluster size (power of 2 pages)
cat /proc/sys/vm/page_cluster
# Default: 3 (= 2^3 = 8 pages prefetched)

# Reduce for random-access swap workloads
sysctl vm.page_cluster=0  # disable readahead (1 page at a time)

# Increase for sequential swap workloads on fast storage
sysctl vm.page_cluster=5  # prefetch 32 pages
```

Setting `vm.page_cluster=0` disables swap readahead entirely, reading exactly the page that faulted. This is appropriate for:
- Systems with NVMe swap where random I/O latency is low
- Workloads with random swap access patterns (many small independent processes)

Higher values (3-5) are appropriate for:
- Rotational disk swap where sequential I/O is much faster than random I/O
- Single large processes being restored from swap

Modern kernels also introduced swap slot clustering (`SWAP_CLUSTER_MAX`) to improve the locality of swap allocations, making readahead more effective when it is used.

### What it taught us

**A single global parameter cannot describe diverse workloads.** Page cluster was a reasonable default for the original Linux target workload (workstations with a single large process under memory pressure). Servers running hundreds of small processes with interleaved swap access patterns need different tuning.

**Readahead has negative value when the access pattern is not sequential.** The principle of readahead is that I/O bandwidth is cheap and latency is expensive, so fetching extra data is worthwhile. When I/O bandwidth is scarce (because you are under memory pressure) and access is random (because many processes are swapping simultaneously), readahead makes things worse, not better.

**Swap performance depends heavily on storage characteristics.** The optimal readahead size for a 7200 RPM hard disk, an SSD, and an NVMe device are all different. Default values calibrated for one era of hardware can become wrong as storage technology changes.

!!! warning "Pattern to watch for"
    If swap performance is worse than expected for the storage device's rated throughput, check whether `vm.page_cluster` is appropriate for the workload's access pattern. High `pswpin` (swap-ins) combined with low actual storage read throughput suggests that either many small I/Os are being issued (cluster too low) or that I/O is being wasted on pages that are never accessed (cluster too high, random pattern).

    ```bash
    # Measure swap I/O patterns
    vmstat 1 | awk '{print $7, $8}'  # si (swap-in), so (swap-out)

    # Check if swap reads are sequential via iostat
    iostat -x 1  # %util and await on the swap device

    # If %util is high but throughput is low = too many small I/Os
    # If throughput is low but %util is low = I/O is being wasted
    ```

---

## Common threads

These four regressions share a set of structural patterns worth recognizing:

| Pattern | THP defrag stalls | NUMA balancing overhead | khugepaged CPU storms | Swap readahead mismatch |
|---------|-------------------|------------------------|----------------------|------------------------|
| Optimization correct in theory | Yes | Yes | Yes | Yes |
| Default harmed a class of workloads | Yes | Yes | Yes | Depends on version |
| Fixed by adding opt-out / tuning knobs | Yes | Yes | Yes | Yes |
| Root cause: workload diversity | Yes | Yes | Yes | Yes |
| Latency vs throughput tradeoff | Yes | Partially | Partially | Yes |

The broader lesson: mm optimizations often make an implicit assumption about workload behavior (sequential access, single large process, benefit from page colocation). When that assumption is violated — which happens across a diverse fleet of servers — the optimization becomes a regression.

Recognizing the pattern is the first step to diagnosing it.

---

## See also

- [Transparent Huge Pages](thp.md) — THP configuration and khugepaged tuning
- [Memory Compaction](compaction.md) — How compaction works and its cost model
- [Page Reclaim](reclaim.md) — kswapd, direct reclaim, and swappiness
- [NUMA](numa.md) — NUMA topology, balancing, and placement policies
- [What happens during swapping](swapping.md) — Swap-in/swap-out lifecycle and the readahead trap
- [Swap Thrashing](swap-thrashing.md) — Detecting and preventing swap thrashing
- [Bug Index](bugs/README.md) — Security bugs and data corruption in the mm subsystem

---

## External references

- [LWN: Transparent huge pages in 2.6.38](https://lwn.net/Articles/423584/) — Original THP coverage including defrag behavior
- [LWN: NUMA in a hurry](https://lwn.net/Articles/486858/) — Background on NUMA balancing design
- [LWN: Automatic NUMA balancing](https://lwn.net/Articles/548098/) — v3.13 NUMA balancing introduction
- [LWN: Transparent huge pages and the NUMA problem](https://lwn.net/Articles/591790/) — THP and NUMA interaction
- [Kernel docs: THP](https://docs.kernel.org/admin-guide/mm/transhuge.html) — Official THP documentation with defrag modes
- [Kernel docs: NUMA balancing](https://docs.kernel.org/admin-guide/mm/numa_memory_policy.html) — NUMA policy reference
- [mm/khugepaged.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/khugepaged.c) — khugepaged implementation
- [mm/swap_state.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/swap_state.c) — Swap readahead implementation

## Further reading

- [war-stories-bugs.md](war-stories-bugs.md) — Production bug narratives: `zone_reclaim_mode` NUMA thrashing, THP compound page locking overhead, and RSS percpu counter inaccuracy causing wrong OOM victims
- [Tuning Memory for Databases](tuning-databases.md) — practical guidance for avoiding the THP compaction stalls (Case 1) and NUMA placement problems (Case 2) covered here
- [Tuning Memory for Containers](tuning-containers.md) — per-cgroup THP control and memory limits that help isolate the khugepaged CPU storms from Case 3
- [/proc/vmstat reference](proc-vmstat.md) — `compact_stall`, `thp_collapse_alloc_failed`, `numa_pages_migrated`, and `pswpin` counters for detecting all four regression patterns
- [LWN: THP defrag modes](https://lwn.net/Articles/629613/) — `defer` and `defer+madvise` defrag modes that fixed the Case 1 synchronous compaction stalls
- [LWN: Better active/inactive list balancing](https://lwn.net/Articles/495543/) — how the reclaim scanner interacts with NUMA balancing (Case 2)
- [`Documentation/admin-guide/mm/transhuge.rst`](https://docs.kernel.org/admin-guide/mm/transhuge.html) — authoritative THP documentation covering `defrag` modes, khugepaged tunables, and per-cgroup control
- [Commit 444eb2a449ef](https://git.kernel.org/linus/444eb2a449ef) — `defer` defrag mode addition that decoupled THP compaction from the fault path
