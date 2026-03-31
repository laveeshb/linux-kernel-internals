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
| `pfn` | `unsigned long` | PFN of the first page (use `pfn_to_page()` to get the `struct page *`) |
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
| `pfn` | `unsigned long` | PFN of the page being freed |
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
| `pfn` | `unsigned long` | PFN of the allocated page |
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
| `nr_activate0` | `unsigned long` | Anonymous pages promoted back to active list |
| `nr_activate1` | `unsigned long` | File-backed pages promoted back to active list |
| `nr_ref_keep` | `unsigned long` | Pages kept due to reference |
| `nr_unmap_fail` | `unsigned long` | Pages that failed unmapping |
| `priority` | `int` | Reclaim urgency (lower = more urgent) |

**Diagnostic use**: A large `nr_dirty` combined with low `nr_reclaimed` means reclaim is hitting dirty pages and having to wait for writeback. This is a common source of reclaim latency. The `priority` field (from 12 at start down to 0 at desperation) shows how aggressively the kernel is trying.

### mm_vmscan_write_folio

!!! note "Renamed in recent kernels"
    This tracepoint was originally called `mm_vmscan_writepage` and was renamed to `mm_vmscan_write_folio` during the folio conversion. Check `/sys/kernel/debug/tracing/events/vmscan/` on your running kernel for the exact name.

Fires when the reclaim path decides to write a dirty page/folio to swap or backing storage.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `pfn` | `unsigned long` | PFN of the folio being written |
| `reclaim_flags` | `int` | Flags describing the writeback context |

**Diagnostic use**: High rates mean the system is swap-writing or syncing dirty file pages due to memory pressure — I/O-driven reclaim that significantly impacts application latency.

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

**Diagnostic use**: This is the single most useful OOM tracepoint for production monitoring. Subscribe to `mark_victim` to get a structured event every time the OOM killer fires, including which process was selected and why.

```bash
# Alert on OOM kills with process details (RSS values are in kB)
bpftrace -e '
tracepoint:oom:mark_victim {
    $rss_kb = args->anon_rss + args->file_rss + args->shmem_rss;
    printf("OOM kill: pid=%d comm=%s rss=%lu kB adj=%d\n",
           args->pid, args->comm, $rss_kb, args->oom_score_adj);
}'
```

For the full OOM debugging workflow, see [OOM Debugging](oom-debugging.md).

---

## Page Fault Tracepoints

The kernel does not expose generic mm-level page fault tracepoints. Page fault observation is architecture-specific:

- **x86/x86_64**: `exceptions:page_fault_user` and `exceptions:page_fault_kernel`
- **ARM64**: `exceptions:page_fault_user` and `exceptions:page_fault_kernel`

```bash
# Count user-space page faults (all architectures that support it)
perf stat -e exceptions:page_fault_user -a -- sleep 10

# Or use /proc/vmstat counters (architecture-independent)
grep pgfault /proc/vmstat     # minor faults
grep pgmajfault /proc/vmstat  # major faults (required I/O)
```

For page fault analysis, `/proc/vmstat` counters (`pgfault`, `pgmajfault`) and per-process `/proc/<pid>/stat` fields (minflt, majflt) are generally more portable than tracepoints.

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
| `status` | `int` | Result: `COMPACT_SUCCESS`, `COMPACT_PARTIAL_SKIPPED`, `COMPACT_CONTINUE`, `COMPACT_SKIPPED`, `COMPACT_DEFERRED`, `COMPACT_NOT_SUITABLE_ZONE`, `COMPACT_CONTENDED` |

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

The available tracepoints cover khugepaged's collapse activity. Check `/sys/kernel/debug/tracing/events/huge_memory/` on your running kernel for the full list, as names evolve with folio and file-THP work.

### mm_collapse_huge_page

Fires when the khugepaged daemon finishes a collapse attempt (success or failure).

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `mm` | `struct mm_struct *` | The process address space |
| `isolated` | `int` | Number of pages isolated for collapse |
| `status` | `int` | Result: 0 = success, non-zero = failure |

**Diagnostic use**: Track THP collapse activity. Frequent failures (`status != 0`) may indicate the process's memory is too fragmented for khugepaged to make progress. Collapsed THPs appear as `AnonHugePages` in `/proc/meminfo`.

```bash
# Count THP collapses per minute, split by outcome
bpftrace -e '
tracepoint:huge_memory:mm_collapse_huge_page {
    @[args->status == 0 ? "success" : "fail"] = count();
}
interval:s:60 { print(@); clear(@); }'
```

### mm_collapse_huge_page_isolate

Fires when pages are isolated from the LRU as part of a collapse attempt.

**Fields**: `pfn`, `none_or_zero`, `referenced`, `status`

**Diagnostic use**: A non-zero `status` here means the isolation step itself failed — the pages were busy (under I/O, locked, etc.) and could not be moved.

### mm_khugepaged_scan_pmd

Fires when khugepaged scans a PMD entry looking for collapse opportunities.

**Fields**: `mm`, `pfn`, `referenced`, `none_or_zero`, `status`, `unmapped`

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
# Monitor collapse outcomes
bpftrace -e '
tracepoint:huge_memory:mm_collapse_huge_page {
    @result[args->status] = count();
}
interval:s:30 {
    printf("\nTHP collapse outcomes (status 0 = success):\n");
    print(@result);
    clear(@result);
}'
```

A `status` of 0 is success. Non-zero values map to `SCAN_*` enum values in `mm/khugepaged.c` — check the source for the current mapping (e.g., `SCAN_ALLOC_HUGE_PAGE_FAIL`, `SCAN_CGROUP_CHARGE_FAIL`). If collapses are consistently failing, also check `/sys/kernel/mm/transparent_hugepage/khugepaged/pages_collapsed` and `full_scans` for a longer-term view.

### Recipe 4: Watching the OOM Killer

Set up a persistent monitor that logs every OOM kill with process details:

```bash
bpftrace -e '
tracepoint:oom:mark_victim {
    $rss_kb = args->anon_rss + args->file_rss + args->shmem_rss;
    time("%H:%M:%S ");
    printf("OOM KILL pid=%d comm=%s rss=%lu kB (%lu MB) adj=%d\n",
           args->pid,
           args->comm,
           $rss_kb,
           $rss_kb / 1024,
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
| Reclaim | `vmscan:mm_vmscan_write_folio` | Swap/writeback rate from reclaim (was `mm_vmscan_writepage` pre-folio) |
| OOM | `oom:mark_victim` | OOM kills: victim selection |
| OOM | `oom:oom_score_adj_update` | OOM score manipulation audit |
| Compaction | `compaction:mm_compaction_begin/end` | Compaction duration and success |
| Compaction | `compaction:mm_compaction_migratepages` | Pages moved per compaction pass |
| Huge pages | `huge_memory:mm_collapse_huge_page` | khugepaged collapse outcomes |
| Huge pages | `huge_memory:mm_collapse_huge_page_isolate` | Page isolation step of collapse |
| Huge pages | `huge_memory:mm_khugepaged_scan_pmd` | khugepaged PMD scan activity |
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

## Further reading

### Kernel source

- [include/trace/events/mmflags.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/mmflags.h) — GFP flag name strings (`gfp_flag_names[]`) used to decode `gfp_flags` fields in tracepoint output
- [include/trace/events/kmem.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/kmem.h) — page allocator and slab tracepoint definitions
- [include/trace/events/vmscan.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/vmscan.h) — reclaim tracepoint definitions
- [include/trace/events/compaction.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/compaction.h) — compaction tracepoint definitions
- [include/trace/events/huge_memory.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/huge_memory.h) — THP and khugepaged tracepoint definitions

### Kernel documentation

- [`Documentation/trace/ftrace.rst`](https://docs.kernel.org/trace/ftrace.html) — full reference for the ftrace infrastructure: ring buffer, filter syntax, and function tracing
- [`Documentation/trace/tracepoints.rst`](https://docs.kernel.org/trace/tracepoints.html) — how tracepoints are defined with `TRACE_EVENT()` and how to add new ones
- [`Documentation/trace/events.rst`](https://docs.kernel.org/trace/events.html) — enabling and filtering events via `/sys/kernel/debug/tracing/events/`
- [`Documentation/bpf/index.rst`](https://docs.kernel.org/bpf/index.html) — BPF subsystem documentation including `tracepoint` program type

### Related pages

- [understanding-proc-vmstat.md](understanding-proc-vmstat.md) — aggregate counters that summarize what individual tracepoints observe
- [oom-debugging.md](oom-debugging.md) — using `oom:mark_victim` and PSI together for post-OOM investigation
- [why-is-my-process-slow.md](why-is-my-process-slow.md) — using `mm_vmscan_direct_reclaim_begin/end` to attribute latency to memory pressure
- [kasan.md](kasan.md) — memory bug detection to pair with allocation tracing when hunting use-after-free

### LWN articles

- [LWN: Tracepoints in the Linux kernel](https://lwn.net/Articles/379903/) — original introduction to the `TRACE_EVENT()` macro and the design philosophy behind static tracepoints
- [LWN: Dynamic tracing with BPF](https://lwn.net/Articles/740157/) — using `bpftrace` and BCC to attach to kernel tracepoints with low overhead
