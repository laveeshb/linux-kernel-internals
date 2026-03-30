# Memory Subsystem Tracepoints

> Runtime tracing of kernel memory events with perf, ftrace, and BPF

The kernel's memory management subsystem exposes dozens of tracepoints that let you observe page allocation, reclaim, OOM decisions, page faults, compaction, huge pages, and slab activity at runtime — without recompilation and with very low overhead when disabled.

This reference covers the tracepoints grouped by category, their available fields, and practical diagnostic examples using ftrace, `perf`, and BPF (via `bpftrace`).

## Prerequisites and General Usage

### Finding Available Tracepoints

```bash
# List all mm-related tracepoints
ls /sys/kernel/debug/tracing/events/kmem/
ls /sys/kernel/debug/tracing/events/vmscan/
ls /sys/kernel/debug/tracing/events/compaction/
ls /sys/kernel/debug/tracing/events/huge_memory/

# Or via perf
perf list 'mm:*' 'kmem:*' 'vmscan:*' 'compaction:*' 2>/dev/null
```

### Enabling with ftrace

```bash
# Enable a single tracepoint
echo 1 > /sys/kernel/debug/tracing/events/kmem/mm_page_alloc/enable

# Enable an entire subsystem
echo 1 > /sys/kernel/debug/tracing/events/vmscan/enable

# Read the trace buffer
cat /sys/kernel/debug/tracing/trace

# Stream events live
cat /sys/kernel/debug/tracing/trace_pipe

# Clean up
echo 0 > /sys/kernel/debug/tracing/events/kmem/mm_page_alloc/enable
echo > /sys/kernel/debug/tracing/trace   # clear the buffer
```

### Enabling with perf

```bash
# Record mm tracepoints for 10 seconds
perf record -e 'kmem:mm_page_alloc,kmem:mm_page_free' -a -- sleep 10
perf script

# Count events per second
perf stat -e 'kmem:mm_page_alloc,kmem:mm_page_free' -a -- sleep 5
```

### Enabling with bpftrace

```bash
# bpftrace uses the same tracepoint names
bpftrace -e 'tracepoint:kmem:mm_page_alloc { @[comm] = count(); }'
```

---

## Page Allocation Tracepoints

**Source**: [`include/trace/events/kmem.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/kmem.h)

### mm_page_alloc

Fires whenever the page allocator (`__alloc_pages()` in [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c)) successfully returns a page or compound page.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `page` | `struct page *` | Pointer to the first page |
| `order` | `unsigned int` | Allocation order (0 = single page, 1 = 2 pages, ...) |
| `gfp_flags` | `gfp_t` | GFP flags used for the allocation |
| `migratetype` | `int` | Migrate type of the allocation (UNMOVABLE, MOVABLE, RECLAIMABLE) |

**Format string** (from `/sys/kernel/debug/tracing/events/kmem/mm_page_alloc/format`):

```
page=%p pfn=%lu order=%d migratetype=%d gfp_flags=%s
```

**Enabling**:

```bash
echo 1 > /sys/kernel/debug/tracing/events/kmem/mm_page_alloc/enable
```

**Diagnostic use**: Measure page allocation rate and distribution by order. A high rate of order > 0 allocations that fail (falling back to `mm_page_alloc_extfrag`) signals fragmentation pressure.

```bash
# bpftrace: histogram of allocation orders
bpftrace -e '
tracepoint:kmem:mm_page_alloc {
    @order_hist = hist(args->order);
}
interval:s:5 {
    print(@order_hist);
    clear(@order_hist);
}'
```

### mm_page_free

Fires when a page (or compound page) is returned to the page allocator via `free_pages()` / `__free_pages()`.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `page` | `struct page *` | The page being freed |
| `order` | `unsigned int` | Order of the compound page being freed |

**Diagnostic use**: Paired with `mm_page_alloc`, you can track the net allocation rate (allocs minus frees). A diverging count indicates a memory leak or accumulation.

```bash
# perf: count alloc vs free over 30 seconds
perf stat -e kmem:mm_page_alloc,kmem:mm_page_free -a -- sleep 30
```

### mm_page_alloc_zone_locked

Fires when the page allocator falls back to the zone lock path — typically when the per-CPU page set (PCP) is empty and must be refilled from the zone's free lists.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `page` | `struct page *` | The allocated page |
| `order` | `unsigned int` | Allocation order |
| `migratetype` | `int` | Migration type |

**Diagnostic use**: Frequent `mm_page_alloc_zone_locked` events relative to `mm_page_alloc` mean the PCP lists are frequently being exhausted. This can happen under allocation bursts or if `vm.percpu_pagelist_high_fraction` is set too conservatively.

### mm_page_alloc_extfrag

Fires when the allocator satisfies a request by **stealing** pages from a different migratetype freelist. This is the main indicator of fragmentation.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `page` | `struct page *` | The stolen page |
| `alloc_order` | `int` | The order originally requested |
| `fallback_order` | `int` | The order that was actually used from the fallback list |
| `alloc_migratetype` | `int` | The requested migration type |
| `fallback_migratetype` | `int` | The migration type stolen from |
| `change_ownership` | `int` | Whether the pageblock's migratetype was changed |

**Diagnostic use**: Sustained `mm_page_alloc_extfrag` events with `change_ownership=1` mean unmovable allocations are permanently colonizing movable pageblocks. This leads to compaction failures. See [Compaction](compaction.md).

---

## Page Reclaim Tracepoints

**Source**: [`include/trace/events/vmscan.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/vmscan.h)

These tracepoints cover both background reclaim (kswapd) and synchronous direct reclaim, which blocks the allocating process.

### mm_vmscan_kswapd_wake

Fires when `kswapd` is woken up to begin background page reclaim.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `nid` | `int` | NUMA node ID |
| `zid` | `int` | Zone index |
| `order` | `int` | Allocation order that triggered the wakeup |

**Diagnostic use**: Count how often kswapd wakes per second. A high wake rate means the system is under memory pressure but still in the background reclaim phase (before direct reclaim kicks in). If this is frequent, check `vm.min_free_kbytes` — raising it gives kswapd more headroom.

```bash
# Rate of kswapd wakeups by NUMA node
bpftrace -e '
tracepoint:vmscan:mm_vmscan_kswapd_wake {
    @[args->nid] = count();
}
interval:s:1 { print(@); clear(@); }'
```

### mm_vmscan_kswapd_sleep

Fires when kswapd goes back to sleep after reclaiming enough memory.

**Fields**: `nid` (NUMA node ID)

**Diagnostic use**: Time between `mm_vmscan_kswapd_wake` and `mm_vmscan_kswapd_sleep` gives the duration of each reclaim cycle.

### mm_vmscan_direct_reclaim_begin / mm_vmscan_direct_reclaim_end

Fires when an allocation triggers **direct reclaim** — the allocating task itself must reclaim pages before it can proceed. Direct reclaim causes allocation latency visible to applications.

**Fields** (begin):

| Field | Type | Description |
|-------|------|-------------|
| `order` | `int` | Order being allocated |
| `gfp_flags` | `gfp_t` | GFP flags of the allocation |

**Fields** (end):

| Field | Type | Description |
|-------|------|-------------|
| `nr_reclaimed` | `unsigned long` | Number of pages reclaimed |

**Diagnostic use**: Measure direct reclaim frequency and duration. Frequent direct reclaim is a strong signal of memory pressure — it directly adds latency to kernel and application code paths. Correlate with `allocstall_normal` in `/proc/vmstat` (described in [proc vmstat](understanding-proc-vmstat.md)).

```bash
# Measure direct reclaim latency (nanoseconds) per task
bpftrace -e '
tracepoint:vmscan:mm_vmscan_direct_reclaim_begin {
    @start[tid] = nsecs;
}
tracepoint:vmscan:mm_vmscan_direct_reclaim_end /@start[tid]/ {
    @latency_ns = hist(nsecs - @start[tid]);
    delete(@start[tid]);
}
interval:s:10 { print(@latency_ns); }'
```

### mm_vmscan_lru_isolate

Fires when pages are isolated from the LRU list for reclaim consideration.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `highest_zoneidx` | `int` | The highest zone being reclaimed |
| `order` | `int` | Requested allocation order |
| `nr_requested` | `unsigned long` | Pages requested for isolation |
| `nr_scanned` | `unsigned long` | Pages scanned |
| `nr_skipped` | `unsigned long` | Pages skipped (e.g., busy pages) |
| `nr_taken` | `unsigned long` | Pages actually isolated |
| `lru` | `unsigned int` | Which LRU list (active/inactive anon/file) |

**Diagnostic use**: A high `nr_skipped` / `nr_taken` ratio means many pages are temporarily busy (under writeback, locked, etc.) and cannot be reclaimed. This can cause reclaim to stall.

### mm_vmscan_lru_shrink_inactive

Fires when the inactive LRU list is shrunk (pages are being reclaimed or moved to the active list after reference check).

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `nid` | `int` | NUMA node |
| `nr_scanned` | `unsigned long` | Pages scanned on inactive list |
| `nr_reclaimed` | `unsigned long` | Pages actually freed |
| `nr_dirty` | `unsigned long` | Dirty pages encountered |
| `nr_writeback` | `unsigned long` | Pages currently under writeback |
| `nr_congested` | `unsigned long` | Pages waiting on congested backing device |
| `nr_immediate` | `unsigned long` | Pages eligible for immediate reclaim |
| `nr_activate` | `unsigned long` | Pages promoted back to active list |
| `nr_ref_keep` | `unsigned long` | Pages kept due to reference |
| `nr_unmap_fail` | `unsigned long` | Pages that failed unmapping |
| `priority` | `int` | Reclaim urgency (lower = more urgent) |

**Diagnostic use**: A large `nr_dirty` combined with low `nr_reclaimed` means reclaim is hitting dirty pages and having to wait for writeback. This is a common source of reclaim latency. The `priority` field (from 12 at start down to 0 at desperation) shows how aggressively the kernel is trying.

### mm_vmscan_writepage

Fires when the reclaim path decides to write a dirty page to swap or backing storage.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `page` | `struct page *` | The page being written |
| `reclaim_flags` | `int` | Flags describing the writeback context |

**Diagnostic use**: High rates of `mm_vmscan_writepage` mean the system is swap-writing or syncing dirty file pages due to memory pressure — I/O-driven reclaim that significantly impacts application latency.

---

## OOM Tracepoints

**Source**: [`include/trace/events/oom.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/oom.h)

### oom_score_adj_update

Fires when a process's `oom_score_adj` value is changed (via `/proc/PID/oom_score_adj`).

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `pid` | `int` | Process ID being adjusted |
| `comm` | `char[]` | Process name |
| `oom_score_adj` | `short` | New oom_score_adj value |

**Diagnostic use**: Audit which processes are adjusting their OOM scores, and when. A process repeatedly setting itself to -1000 (fully protected) as it starts can leave the system without viable OOM victims.

### mark_victim

Fires when the OOM killer selects a process to kill.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `pid` | `int` | PID of the victim process |
| `uid` | `uid_t` | UID of the victim |
| `oom_score_adj` | `short` | The victim's oom_score_adj |
| `total_vm` | `unsigned long` | Victim's total virtual memory (pages) |
| `rss` | `unsigned long` | Resident set size (pages) |
| `pgtables_bytes` | `unsigned long` | Page table memory |
| `oom_score` | `int` | The score that selected this process |

**Diagnostic use**: This is the single most useful OOM tracepoint for production monitoring. Subscribe to `mark_victim` to get a structured event every time the OOM killer fires, including which process was selected and why.

```bash
# Alert on OOM kills with process details
bpftrace -e '
tracepoint:oom:mark_victim {
    printf("OOM kill: pid=%d comm=%s rss_pages=%lu score=%d\n",
           args->pid, args->comm, args->rss, args->oom_score);
}'
```

For the full OOM debugging workflow, see [OOM Debugging](oom-debugging.md).

---

## Page Fault Tracepoints

**Source**: [`include/trace/events/kmem.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/kmem.h) and architecture-specific files

### mm_anon_fault (mm_anon_pgin, historically)

!!! note "Naming varies by kernel version"
    Page fault tracepoints have been reorganized across kernel versions. The tracepoint names shown here reflect the tracepoints available via `perf list` and ftrace's events directory. Always check `/sys/kernel/debug/tracing/events/` on your running kernel for the exact names present.

**Conceptual fields** (check your kernel's format file):

| Field | Description |
|-------|-------------|
| `address` | Faulting virtual address |
| `flags` | Fault flags (write fault, instruction fetch, etc.) |
| `mm` | The `mm_struct` of the faulting task |

**Diagnostic use**: Measure anonymous page fault rate — useful for understanding how much new heap/stack memory a workload is instantiating. A process that page-faults continuously is touching new memory pages, which drives physical memory growth.

### mm_filemap_fault

Fires on a file-backed page fault (demand paging from a file, including executable text pages).

**Diagnostic use**: High rates indicate the page cache is cold — the working set of the application does not fit in available RAM. Correlate with `pgmajfault` in `/proc/vmstat`.

```bash
# Compare minor vs major faults to measure I/O-bound paging
perf stat -e kmem:mm_page_alloc \
          -e exceptions:page_fault_user \
          -a -- sleep 10
```

---

## Compaction Tracepoints

**Source**: [`include/trace/events/compaction.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/compaction.h)

### mm_compaction_begin / mm_compaction_end

Fires when a compaction pass starts and ends.

**Fields** (begin):

| Field | Type | Description |
|-------|------|-------------|
| `zone_start` | `unsigned long` | Start PFN of the zone being compacted |
| `migrate_pfn` | `unsigned long` | Current migration scanner position |
| `free_pfn` | `unsigned long` | Current free-page scanner position |
| `zone_end` | `unsigned long` | End PFN |
| `sync` | `bool` | Whether this is synchronous (blocking) compaction |

**Fields** (end):

| Field | Type | Description |
|-------|------|-------------|
| `zone_start` | `unsigned long` | Zone start PFN |
| `migrate_pfn` | `unsigned long` | Final migration scanner position |
| `free_pfn` | `unsigned long` | Final free-page scanner position |
| `zone_end` | `unsigned long` | Zone end PFN |
| `sync` | `bool` | Synchronous compaction |
| `status` | `int` | Result: `COMPACT_SUCCESS`, `COMPACT_PARTIAL`, `COMPACT_CONTINUE`, `COMPACT_SKIPPED`, `COMPACT_DEFERRED`, `COMPACT_NOT_SUITABLE_ZONE` |

**Diagnostic use**: Track compaction duration and success rate. Frequent `COMPACT_DEFERRED` statuses mean the kernel has given up trying to compact a zone (too many failed attempts). `COMPACT_SUCCESS` followed by a successful high-order allocation confirms fragmentation was the root cause.

```bash
# How often does compaction succeed vs fail?
bpftrace -e '
tracepoint:compaction:mm_compaction_end {
    @status[args->status] = count();
}
interval:s:10 { print(@status); }'
```

### mm_compaction_isolate_migratepages / mm_compaction_isolate_freepages

Fires when pages are isolated for migration or as free targets during compaction.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `start_pfn` | `unsigned long` | Start of the scanned range |
| `end_pfn` | `unsigned long` | End of the scanned range |
| `nr_scanned` | `unsigned long` | Pages scanned |
| `nr_taken` | `unsigned long` | Pages isolated |

**Diagnostic use**: A low `nr_taken / nr_scanned` ratio means most pages in the zone are pinned (unmovable) and cannot be compacted. This indicates fundamental fragmentation that compaction cannot resolve — consider [CMA](cma.md) or huge page reservation changes.

### mm_compaction_migratepages

Fires when isolated pages are actually migrated to new locations.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `nr_migrated` | `unsigned long` | Pages successfully moved |
| `nr_failed` | `unsigned long` | Pages that failed migration |

---

## Huge Page Tracepoints

**Source**: [`include/trace/events/huge_memory.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/huge_memory.h)

### hugepage_set_pmd / hugepage_set_pud

Fires when a transparent huge page (THP) is mapped into a page table at the PMD or PUD level.

### mm_collapse_huge_page

Fires when the khugepaged daemon collapses a set of base pages into a single transparent huge page.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `mm` | `struct mm_struct *` | The process address space |
| `addr` | `unsigned long` | Virtual address of the collapsed region |
| `isolated` | `int` | Number of pages isolated for collapse |
| `status` | `int` | Result of the collapse attempt |
| `sync` | `bool` | Whether the collapse was synchronous |

**Diagnostic use**: Track THP collapse activity. Frequent collapse failures (`status != 0`) may indicate the process's memory is too fragmented for khugepaged to make progress. Collapsed THPs appear as `AnonHugePages` in `/proc/meminfo`.

```bash
# Count THP collapses per minute
bpftrace -e '
tracepoint:huge_memory:mm_collapse_huge_page {
    @[args->status == 0 ? "success" : "fail"] = count();
}
interval:s:60 { print(@); clear(@); }'
```

### mm_collapse_huge_page_begin / mm_collapse_huge_page_end

Bracket a collapse attempt with timing information, useful for measuring how long khugepaged spends collapsing.

### thp_fault_alloc / thp_fault_fallback

**`thp_fault_alloc`**: Fires when a THP is successfully allocated at fault time (the fault path succeeded in allocating a 2MB page directly rather than falling back to base pages).

**`thp_fault_fallback`**: Fires when THP allocation at fault time **fails** and the kernel falls back to a regular 4KB page.

**Diagnostic use**: A high ratio of `thp_fault_fallback` to `thp_fault_alloc` means THP is configured to try but the system cannot satisfy 2MB contiguous allocations — fragmentation is preventing it. This is actionable: either reduce THP size pressure with `huge_pages` reservation, or accept the fallback rate as normal for your workload.

```bash
# THP allocation success rate
perf stat -e huge_memory:thp_fault_alloc,huge_memory:thp_fault_fallback -a -- sleep 30
```

---

## Slab Tracepoints

**Source**: [`include/trace/events/kmem.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/kmem.h)

### kmem_cache_alloc

Fires on every allocation from a named slab cache (`kmem_cache_alloc()`, `kmem_cache_alloc_node()`).

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `call_site` | `unsigned long` | Return address of the caller (instruction pointer) |
| `ptr` | `const void *` | Pointer to the allocated object |
| `bytes_req` | `size_t` | Bytes requested |
| `bytes_alloc` | `size_t` | Bytes actually allocated (may be larger due to alignment) |
| `gfp_flags` | `gfp_t` | Allocation flags |
| `node` | `int` | NUMA node allocated from (-1 = any) |

**Diagnostic use**: Identify which allocation sites are most active and which slab caches are growing fastest. The `call_site` field gives a raw instruction pointer — symbolize it with `addr2line` or `perf script` to get a function name.

```bash
# Top 10 slab allocation call sites
bpftrace -e '
tracepoint:kmem:kmem_cache_alloc {
    @[ksym(args->call_site)] = count();
}
interval:s:10 {
    print(@, 10);
    clear(@);
}'
```

### kmem_cache_free

Fires on every slab object free (`kmem_cache_free()`).

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `call_site` | `unsigned long` | Caller instruction pointer |
| `ptr` | `const void *` | Pointer being freed |

**Diagnostic use**: Pair with `kmem_cache_alloc` to find allocation sites that allocate but never free — a slab-level leak.

```bash
# Net slab balance: allocations minus frees per call site
bpftrace -e '
tracepoint:kmem:kmem_cache_alloc { @net[ksym(args->call_site)]++; }
tracepoint:kmem:kmem_cache_free  { @net[ksym(args->call_site)]--; }
interval:s:30 {
    print(@net);  # positive = more allocs than frees
    clear(@net);
}'
```

### kmalloc / kfree

**`kmalloc`** fires on `kmalloc()` / `kzalloc()` allocations (general-purpose slab).

**`kfree`** fires on `kfree()`.

**Fields** (kmalloc):

| Field | Type | Description |
|-------|------|-------------|
| `call_site` | `unsigned long` | Caller IP |
| `ptr` | `const void *` | Allocated pointer |
| `bytes_req` | `size_t` | Bytes requested |
| `bytes_alloc` | `size_t` | Bytes allocated (next power of two) |
| `gfp_flags` | `gfp_t` | GFP flags |
| `node` | `int` | NUMA node |

**Diagnostic use**: The difference between `bytes_req` and `bytes_alloc` reveals internal fragmentation. A call site that always requests 33 bytes gets 64 bytes — nearly 2x waste. This is a signal to adjust the allocation size or use a dedicated `kmem_cache`.

```bash
# Show average waste ratio by call site
bpftrace -e '
tracepoint:kmem:kmalloc {
    @req[ksym(args->call_site)]  = sum(args->bytes_req);
    @alloc[ksym(args->call_site)] = sum(args->bytes_alloc);
}
interval:s:15 {
    print(@req);
    print(@alloc);
}'
```

---

## Practical Diagnostic Recipes

### Recipe 1: Is Memory Pressure Causing Application Latency?

Determine whether direct reclaim is adding latency to your process:

```bash
# Step 1: Check if direct reclaim is happening at all
grep allocstall /proc/vmstat

# Step 2: If yes, measure how long it lasts using tracepoints
bpftrace -e '
tracepoint:vmscan:mm_vmscan_direct_reclaim_begin {
    @start[tid] = nsecs;
    @task = comm;
}
tracepoint:vmscan:mm_vmscan_direct_reclaim_end /@start[tid]/ {
    $lat = nsecs - @start[tid];
    printf("direct_reclaim: comm=%s latency=%.3fms reclaimed=%lu pages\n",
           @task, $lat / 1e6, args->nr_reclaimed);
    delete(@start[tid]);
}'
```

If you see your application's task name in the output with high latency values, memory pressure is directly adding latency to your workload.

### Recipe 2: Finding the Source of Memory Growth

Identify which code path is allocating the most memory:

```bash
# Top kmalloc call sites by total bytes allocated over 60 seconds
bpftrace -e '
tracepoint:kmem:kmalloc {
    @bytes[ksym(args->call_site)] = sum(args->bytes_alloc);
}
interval:s:60 {
    print(@bytes, 20);  # top 20
    exit();
}'
```

Cross-reference with [KASAN](kasan.md) if the growth is unexpected — it may be a legitimate feature allocating memory, or it may be a leak.

### Recipe 3: Diagnosing THP Collapse Failures

If you expect THP to be helping but are not seeing `AnonHugePages` grow in `/proc/meminfo`:

```bash
# Monitor collapse success/failure and latency
bpftrace -e '
tracepoint:huge_memory:mm_collapse_huge_page_begin {
    @start[tid] = nsecs;
}
tracepoint:huge_memory:mm_collapse_huge_page_end /@start[tid]/ {
    $lat = nsecs - @start[tid];
    @collapse_latency = hist($lat);
    delete(@start[tid]);
}
tracepoint:huge_memory:mm_collapse_huge_page {
    @result[args->status] = count();
}
interval:s:30 { print(@result); print(@collapse_latency); }'
```

### Recipe 4: Watching the OOM Killer

Set up a persistent monitor that logs every OOM kill with process details:

```bash
bpftrace -e '
tracepoint:oom:mark_victim {
    time("%H:%M:%S ");
    printf("OOM KILL pid=%d comm=%s rss=%lu pages (%lu MB) score=%d adj=%d\n",
           args->pid,
           args->comm,
           args->rss,
           args->rss * 4 / 1024,
           args->oom_score,
           args->oom_score_adj);
}'
```

See [OOM Debugging](oom-debugging.md) for the full investigation workflow after an OOM event.

### Recipe 5: Compaction Health Check

Determine whether compaction is keeping up with high-order allocation demand:

```bash
# Run for 60 seconds, then report
bpftrace -e '
tracepoint:compaction:mm_compaction_end {
    @[args->status] = count();
}
tracepoint:kmem:mm_page_alloc_extfrag {
    @extfrag_total = count();
    if (args->change_ownership) {
        @ownership_stolen = count();
    }
}
interval:s:60 {
    printf("\nCompaction outcomes:\n");
    print(@);
    printf("\nFragmentation events: %d total, %d ownership changes\n",
           @extfrag_total, @ownership_stolen);
    exit();
}'
```

High `@ownership_stolen` combined with frequent `COMPACT_DEFERRED` results is a strong signal to consider `vm.min_free_kbytes` tuning or workload changes that reduce unmovable allocations.

---

## Tracepoint Quick Reference

| Category | Tracepoint | Key Use |
|----------|-----------|---------|
| Allocation | `kmem:mm_page_alloc` | Page allocation rate and order distribution |
| Allocation | `kmem:mm_page_free` | Page free rate (pair with alloc for net growth) |
| Allocation | `kmem:mm_page_alloc_extfrag` | Fragmentation: migratetype stealing |
| Allocation | `kmem:mm_page_alloc_zone_locked` | PCP list exhaustion |
| Reclaim | `vmscan:mm_vmscan_kswapd_wake` | Background reclaim pressure |
| Reclaim | `vmscan:mm_vmscan_direct_reclaim_begin/end` | Allocation latency from reclaim |
| Reclaim | `vmscan:mm_vmscan_lru_shrink_inactive` | Reclaim efficiency (dirty page bottlenecks) |
| Reclaim | `vmscan:mm_vmscan_writepage` | Swap/writeback rate from reclaim |
| OOM | `oom:mark_victim` | OOM kills: victim selection |
| OOM | `oom:oom_score_adj_update` | OOM score manipulation audit |
| Compaction | `compaction:mm_compaction_begin/end` | Compaction duration and success |
| Compaction | `compaction:mm_compaction_migratepages` | Pages moved per compaction pass |
| Huge pages | `huge_memory:thp_fault_alloc` | THP allocation successes at fault time |
| Huge pages | `huge_memory:thp_fault_fallback` | THP fallback to base pages |
| Huge pages | `huge_memory:mm_collapse_huge_page` | khugepaged collapse activity |
| Slab | `kmem:kmem_cache_alloc` | Named-cache allocation by call site |
| Slab | `kmem:kmem_cache_free` | Named-cache frees |
| Slab | `kmem:kmalloc` | General kmalloc by call site and size |
| Slab | `kmem:kfree` | kfree call sites |

---

## Key Source Files

| File | Description |
|------|-------------|
| [`include/trace/events/kmem.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/kmem.h) | Page allocator and slab tracepoint definitions |
| [`include/trace/events/vmscan.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/vmscan.h) | Reclaim tracepoint definitions |
| [`include/trace/events/compaction.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/compaction.h) | Compaction tracepoint definitions |
| [`include/trace/events/huge_memory.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/huge_memory.h) | THP/huge page tracepoint definitions |
| [`include/trace/events/oom.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/oom.h) | OOM tracepoint definitions |
| [`include/trace/events/mmflags.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/mmflags.h) | GFP flag name strings used in tracepoint output |
| [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) | Page allocator — calls `trace_mm_page_alloc()` etc. |
| [`mm/vmscan.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmscan.c) | Reclaim engine — calls vmscan trace events |
| [`mm/compaction.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/compaction.c) | Compaction — calls compaction trace events |
| [`mm/khugepaged.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/khugepaged.c) | khugepaged daemon — calls huge_memory trace events |

## Further Reading

### Kernel Documentation

- [ftrace documentation](https://docs.kernel.org/trace/ftrace.html) — full reference for the tracing infrastructure
- [BPF and tracing](https://docs.kernel.org/bpf/index.html) — BPF programs for tracepoints

### Related Pages

- [Understanding /proc/vmstat](understanding-proc-vmstat.md) — counters that aggregate what tracepoints observe individually
- [OOM Debugging](oom-debugging.md) — using `mark_victim` and PSI together for OOM investigation
- [KASAN](kasan.md) — for memory bugs found alongside allocation tracing
- [Why Is My Process Slow](why-is-my-process-slow.md) — using direct reclaim tracepoints to diagnose application latency from memory pressure
