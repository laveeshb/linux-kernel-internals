# memory.stat Field Reference

> A complete field-by-field breakdown of /sys/fs/cgroup/*/memory.stat (cgroup v2)

## What is memory.stat?

`/sys/fs/cgroup/<cgroup>/memory.stat` is the most detailed memory accounting file the kernel exposes for a cgroup. It is produced by `memcg_stat_show()` in [`mm/memcontrol.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c), which reads from the cgroup's per-cpu stat counters and formats them as name/value pairs.

```bash
cat /sys/fs/cgroup/mycontainer/memory.stat
```

All byte values are exact byte counts (not pages, not kilobytes). All event counters are monotonically increasing since the cgroup was created.

The authoritative source for field definitions is [`Documentation/admin-guide/cgroup-v2.rst`](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files).

---

## A Note on Hierarchical vs. Flat Accounting

Every field in `memory.stat` reports the **hierarchical total** — the sum of the cgroup itself plus all its descendant cgroups. There is no flat/local-only variant exposed through this file.

This means if you have:

```
/myapp (memory.stat: anon = 600 MiB)
├── /myapp/worker-1 (local anon = 400 MiB)
└── /myapp/worker-2 (local anon = 200 MiB)
```

Reading `/myapp/memory.stat` gives `anon 629145600` (the total). Each child's `memory.stat` reports only its own subtotal.

`memory.current` is similarly hierarchical. The per-cgroup local contribution to a field is not directly exposed, but you can calculate it as:

```
local = parent_stat_field - sum(child_stat_fields)
```

---

## Field Groups

### Anonymous Memory

Anonymous pages are not backed by a file. They back heap allocations, stack growth, and `mmap(MAP_ANONYMOUS)` regions.

---

#### `anon`

**What it counts**: Bytes of anonymous memory currently resident in RAM — heap, stack, anonymous `mmap()` regions, and `MAP_PRIVATE` copy-on-write pages that have been dirtied.

**Kernel counter**: `NR_ANON_MAPPED` in the cgroup's `vmstats`, updated in `__mod_memcg_lruvec_state()` whenever an anonymous page is mapped or unmapped. Defined in `include/linux/mmzone.h`.

**Hierarchical**: Yes — includes all descendant cgroups.

**Diagnostic use**: The primary indicator of application heap/stack size. If `anon` is growing unboundedly, suspect a memory leak. Compare to `anon_thp` to see what fraction is in huge pages.

```bash
# Heap and stack memory of all processes in the cgroup
grep '^anon ' /sys/fs/cgroup/mycontainer/memory.stat
```

---

#### `anon_thp`

**What it counts**: Bytes of anonymous memory backed by Transparent Huge Pages (THP). This is a subset of `anon`.

**Kernel counter**: `NR_ANON_THPS` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: Shows how much of the anonymous footprint is in 2 MiB huge pages. A high `anon_thp / anon` ratio means THP is working well for this cgroup (better TLB coverage). An unexpectedly low ratio may indicate fragmentation preventing THP allocation. See [Transparent Huge Pages](thp.md).

---

#### `shmem`

**What it counts**: Bytes of shared memory (`shmget`, `shm_open`, tmpfs) and `mmap(MAP_SHARED)` pages of anonymous files, currently resident in RAM. Also includes `/dev/shm` usage.

**Kernel counter**: `NR_SHMEM` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: High `shmem` with low `anon` often indicates inter-process communication via shared memory (e.g., PostgreSQL shared buffer pool, Redis AOF shared memory). Shared pages are charged to the cgroup that first faulted them in.

!!! note "shmem and charge attribution"
    When two cgroups both map the same shared memory region, only one cgroup is charged for the physical pages. The page is charged to whichever cgroup first caused the page fault. This can cause surprising accounting if shared memory is created in one container and mapped in another.

---

### File-Backed Memory (Page Cache)

File-backed pages are backed by files on disk. They can be reclaimed without writing to swap — either discarded (if clean) or flushed to disk (if dirty).

---

#### `file`

**What it counts**: Bytes of file-backed memory currently in the page cache and attributed to this cgroup — clean and dirty pages for regular files, `mmap(MAP_SHARED)` file mappings, and read-ahead pages.

**Kernel counter**: `NR_FILE_PAGES` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: The most reclaimable memory in the cgroup. If `file` is large and `anon` is small, the cgroup is doing heavy file I/O and caching results. This is normal and healthy — `file` pages will be evicted under pressure before anonymous pages are swapped. However, if `memory.high` throttling is happening and `file` is large, consider increasing `memory.high` to accommodate the cache.

```bash
# Is memory usage mostly cache or real working set?
awk '/^anon / {anon=$2} /^file / {file=$2} END {
    total = anon + file
    printf "anon: %.0f MiB (%.0f%%)\nfile: %.0f MiB (%.0f%%)\n",
           anon/1048576, anon*100/total, file/1048576, file*100/total
}' /sys/fs/cgroup/mycontainer/memory.stat
```

---

#### `file_mapped`

**What it counts**: Bytes of file-backed pages that are currently mapped into at least one process's virtual address space (i.e., they are in a VMA). This is a subset of `file`.

**Kernel counter**: `NR_FILE_MAPPED` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: The portion of file cache that is actively used via `mmap()`. Unmapped file cache can be reclaimed immediately with no cost to running processes. Mapped file cache requires unmapping first and may trigger major faults when accessed again. High `file_mapped / file` ratio means most of your file cache is memory-mapped rather than just read-ahead cache.

---

#### `file_dirty`

**What it counts**: Bytes of file-backed pages that have been modified but not yet written to disk.

**Kernel counter**: `NR_FILE_DIRTY` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: Dirty pages cannot be reclaimed without first writing to disk (writeback). Under memory pressure, the kernel wakes `flush` threads to write them out before reclaiming. High `file_dirty` under pressure leads to high I/O and slower reclaim. Compare with `pglazyfreed` events — if that counter is rising, pages are being reclaimed without writeback (valid only for clean pages).

---

#### `file_writeback`

**What it counts**: Bytes of file-backed pages currently being written back to disk by `flush` kernel threads.

**Kernel counter**: `NR_WRITEBACK` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: Nonzero `file_writeback` under memory pressure is normal and expected — the kernel is cleaning dirty pages so they can be reclaimed. A persistently high value means the storage I/O path is a bottleneck in reclaim. Cross-reference with I/O PSI (`$CGROUP/io.pressure`) to confirm.

---

#### `shmem_thp`

**What it counts**: Bytes of shared memory (`shmem` / tmpfs) backed by Transparent Huge Pages. Subset of `shmem`.

**Kernel counter**: `NR_SHMEM_THPS` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: Relevant for workloads that use large anonymous shared memory regions (databases, scientific computing). Shows whether THP is being used for shmem, which reduces TLB pressure.

---

#### `file_thp`

**What it counts**: Bytes of file-backed pages backed by Transparent Huge Pages (read-only file THP, introduced for non-anonymous mappings). Subset of `file`.

**Kernel counter**: `NR_FILE_THPS` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: Indicates that read-only file mappings (e.g., shared libraries, executables) are using huge pages. This reduces TLB pressure for text-heavy workloads.

---

### Kernel Memory

Kernel memory is allocated by kernel code on behalf of cgroup processes — slab objects, page tables, kernel stacks, socket buffers. In cgroup v2, kernel memory is charged to the cgroup by default ([background: new slab memory controller](https://lwn.net/Articles/798605/)).

---

#### `kernel`

**What it counts**: Total bytes of kernel memory attributed to this cgroup: the sum of `kernel_stack`, `pagetables`, `percpu`, `sec_pagetables`, and slab memory (`slab_reclaimable` + `slab_unreclaimable`). Note: socket buffers (`sock`) are tracked separately and are **not** included in this total.

**Hierarchical**: Yes.

**Diagnostic use**: Use `kernel` to understand the overhead of kernel data structures for processes in this cgroup. In containers running many short-lived processes, `kernel` can be significant. It counts against `memory.current`.

!!! note "Kernel memory counts against memory.current"
    In cgroup v2, `memory.current = anon + file + kernel + ...`. This is a frequent surprise: a container may hit its limit not because of application heap, but because of kernel slab growth (e.g., large dentry caches from filesystem traversal).

---

#### `kernel_stack`

**What it counts**: Bytes of kernel stacks for tasks in this cgroup. Each task has a kernel stack (typically 8 KiB on x86-64, or 16 KiB when `KASAN` is enabled).

**Kernel counter**: `NR_KERNEL_STACK_KB` (in KiB) in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: Proportional to the number of live threads in the cgroup. Spikes indicate a thread creation burst (fork bomb, connection storm). A container with 10,000 threads uses ~80 MiB of kernel stack memory.

---

#### `pagetables`

**What it counts**: Bytes of page table memory for processes in this cgroup. Page tables translate virtual addresses to physical addresses and are allocated by the kernel as a process's VMA expands.

**Kernel counter**: `NR_PAGETABLE` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: Large `pagetables` with many small anonymous mappings suggests a process with a highly fragmented virtual address space (many small `mmap()` calls without `munmap()`). With THP, page tables are smaller because one huge-page entry covers 2 MiB instead of 512 individual 4 KiB entries.

---

#### `sec_pagetables`

**What it counts**: Bytes of secondary page tables (e.g., shadow page tables for KVM guests, IOMMU page tables for device I/O virtualization) attributed to this cgroup.

**Kernel counter**: `NR_SECONDARY_PAGETABLE` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: Relevant primarily for cgroups running KVM virtual machines. Non-zero in containers using device passthrough with IOMMU.

---

#### `percpu`

**What it counts**: Bytes of per-cpu kernel memory allocated by kernel code running on behalf of processes in this cgroup.

**Hierarchical**: Yes.

**Diagnostic use**: Rarely significant in practice for most workloads. Appears mainly in accounting completeness.

---

#### `sock`

**What it counts**: Bytes of memory allocated for network socket buffers (send and receive buffers, sk_buff structures) for sockets owned by processes in this cgroup.

**Kernel counter**: `MEMCG_SOCK` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: High `sock` in a network-heavy container (proxy, load balancer, gRPC server) indicates buffer pressure. If socket buffers are growing unboundedly, a process may not be draining its receive buffers (slow consumer). Cross-reference with `memory.current` to understand what fraction is networking overhead.

---

#### `slab_reclaimable`

**What it counts**: Bytes of reclaimable kernel slab memory charged to this cgroup — primarily `dentry` (directory entry cache) and `inode_cache` objects that the kernel can free under memory pressure via `shrink_slab()`.

**Kernel counter**: `NR_SLAB_RECLAIMABLE_B` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: A container doing heavy filesystem traversal (e.g., `find`, recursive builds, log scanners) accumulates large `slab_reclaimable`. This is healthy — it will be freed under pressure. However, if `memory.high` is set tight, this reclaimable slab may cause throttling even though the memory can be freed at any time.

---

#### `slab_unreclaimable`

**What it counts**: Bytes of unreclaimable kernel slab memory charged to this cgroup — kernel objects that cannot be freed until the process explicitly releases them (e.g., `task_struct`, `mm_struct`, open file descriptors, network connections, `struct socket`).

**Kernel counter**: `NR_SLAB_UNRECLAIMABLE_B` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: Bounded growth is expected. Continuous growth suggests a kernel-level resource leak — a process opening file descriptors, network connections, or sockets without closing them. Unlike userspace leaks, `slab_unreclaimable` does not appear in process RSS, making it harder to diagnose with `top` or `ps`.

---

### Swap

Swap fields appear only when swap is available to the cgroup (`memory.swap.max` is not zero and the host has swap configured).

---

#### `swapcached`

**What it counts**: Bytes of anonymous memory that is simultaneously in swap and in RAM (i.e., it was swapped out, then faulted back in but not yet removed from the swap device). These pages are counted in both `anon` and `swapcached`.

**Kernel counter**: `NR_SWAPCACHE` in the cgroup's vmstats.

**Hierarchical**: Yes.

**Diagnostic use**: Non-zero `swapcached` means the cgroup is actively using swap — pages have been swapped out and at least some have been read back. This is a signal of memory pressure: the cgroup needed swap recently. A large `swapcached` that is not decreasing means pages are being faulted back in but the cgroup is still under pressure.

---

### Reclaim Events

These are monotonically increasing event counters. They do not measure current state — they record things that have happened since the cgroup was created.

---

#### `pgfault`

**What it counts**: Total number of minor page faults in this cgroup — faults that were satisfied without disk I/O (page was in RAM, just not mapped: e.g., copy-on-write, accessing a page that was in page cache).

**Kernel counter**: `MEMCG_PGFAULT`.

**Hierarchical**: Yes.

**Diagnostic use**: A baseline indicator of memory access patterns. Very high `pgfault` rates are normal for workloads that access many pages. Compare `pgfault` rates before and after a code change to detect regressions.

---

#### `pgmajfault`

**What it counts**: Total number of major page faults — faults that required disk I/O to satisfy (page was not in RAM and had to be read from disk or swap).

**Kernel counter**: `MEMCG_PGMAJFAULT`.

**Hierarchical**: Yes.

**Diagnostic use**: The most direct indicator of swap pressure or file I/O caused by working-set eviction. A container with a sustained high `pgmajfault` rate is thrashing — it keeps reading pages from disk that were previously evicted. Correlate with `memory.pressure` `full` values.

```bash
# Compute pgmajfault rate (sample twice, divide by interval)
S1=$(grep pgmajfault /sys/fs/cgroup/mycontainer/memory.stat | awk '{print $2}')
sleep 10
S2=$(grep pgmajfault /sys/fs/cgroup/mycontainer/memory.stat | awk '{print $2}')
echo "pgmajfault rate: $(( (S2 - S1) / 10 )) faults/sec"
```

---

#### `pgrefill`

**What it counts**: Number of pages scanned during LRU refill — pages moved from the active LRU list to the inactive list during reclaim. Each page moved counts as one event.

**Kernel counter**: `MEMCG_PGREFILL`.

**Hierarchical**: Yes.

**Diagnostic use**: Rising `pgrefill` indicates active reclaim pressure — the kernel is demoting pages from active to inactive LRU. Cross-reference with `pgscan` and `pgsteal` to understand the full reclaim pipeline.

---

#### `pgscan`

**What it counts**: Number of pages scanned by the page reclaim code while looking for pages to free — both from direct reclaim (triggered by process allocations) and from kswapd (background reclaim daemon).

**Kernel counter**: `MEMCG_PGSCAN`.

**Hierarchical**: Yes.

**Diagnostic use**: The "work done" metric for reclaim. A high `pgscan` rate means reclaim is running hard. Comparing `pgscan` to `pgsteal` gives the reclaim efficiency ratio.

---

#### `pgsteal`

**What it counts**: Number of pages actually reclaimed (freed or swapped out) by the page reclaim code. Always less than or equal to `pgscan` — some pages scanned cannot be reclaimed immediately (dirty, locked, referenced).

**Kernel counter**: `MEMCG_PGSTEAL`.

**Hierarchical**: Yes.

**Diagnostic use**: The actual yield of reclaim. A high `pgscan` with a low `pgsteal` means reclaim scanning many pages but freeing few — this is the thrashing signature. The ratio `pgsteal / pgscan` (as a heuristic) indicates reclaim efficiency; a ratio below ~50% under pressure suggests a working set larger than available memory.

---

#### `pgactivate`

**What it counts**: Number of pages promoted from the inactive LRU list to the active LRU list because they were accessed again before eviction.

**Kernel counter**: `MEMCG_PGACTIVATE`.

**Hierarchical**: Yes.

**Diagnostic use**: Shows that the working set is being preserved — pages accessed frequently are being protected. Very low `pgactivate` during heavy reclaim may indicate the working set has been fully evicted.

---

#### `pgdeactivate`

**What it counts**: Number of pages moved from the active LRU to the inactive LRU, making them eligible for reclaim. This is the opposite of `pgactivate`.

**Kernel counter**: `MEMCG_PGDEACTIVATE`.

**Hierarchical**: Yes.

**Diagnostic use**: Indicates memory pressure forcing the kernel to consider reclaiming previously active pages. A sustained high rate of `pgdeactivate` followed by `pgsteal` on the same pages means thrashing.

---

#### `pglazyfreed`

**What it counts**: Number of anonymous pages reclaimed via the "lazy free" path — pages freed without writeback because they were associated with a process that exited (the pages were in swap, the in-memory copy was discarded).

**Kernel counter**: `MEMCG_PGLAZYFREED`.

**Hierarchical**: Yes.

**Diagnostic use**: Counts "free lunches" in reclaim — pages that could be discarded without I/O. Rarely significant on its own, but useful to understand total reclaim breakdown.

---

#### `thp_fault_alloc`

**What it counts**: Number of Transparent Huge Page 2 MiB allocations that succeeded on page fault (i.e., a huge page was allocated for an anonymous mapping when the process touched a new region).

**Hierarchical**: Yes.

**Diagnostic use**: Indicates THP is actively being used. If this is zero in a workload that should benefit from THP, check `/sys/kernel/mm/transparent_hugepage/enabled` and fragmentation.

---

#### `thp_collapse_alloc`

**What it counts**: Number of times `khugepaged` successfully collapsed multiple 4 KiB pages into a single 2 MiB huge page for this cgroup.

**Hierarchical**: Yes.

**Diagnostic use**: Shows background THP optimization is working. Zero may indicate fragmentation preventing collapse or `khugepaged` being disabled.

---

### Memory Protection

These fields reflect the protection configuration and whether it is taking effect.

---

#### `workingset_refault_anon`

**What it counts**: Number of anonymous pages that were faulted back in after being evicted from RAM (refaulted). Incremented when a page that was previously swapped out is accessed again.

**Kernel counter**: `WORKINGSET_REFAULT_ANON`.

**Hierarchical**: Yes.

**Diagnostic use**: The definitive thrashing indicator for anonymous memory. If `workingset_refault_anon` is rising, anonymous pages are being evicted and then re-faulted — the working set does not fit in the available memory. Paired with high `pgmajfault`, this confirms you need more RAM or a larger swap.

---

#### `workingset_refault_file`

**What it counts**: Number of file-backed pages that were faulted back in after being evicted from the page cache.

**Kernel counter**: `WORKINGSET_REFAULT_FILE`.

**Hierarchical**: Yes.

**Diagnostic use**: Thrashing indicator for file-backed memory. High values mean your I/O working set (databases reading from disk, web servers reading static files) does not fit in the page cache. Increasing `memory.high` or the container's memory limit to give more room for file cache will reduce this.

---

#### `workingset_activate_anon`

**What it counts**: Number of anonymous refaulted pages that were immediately promoted to the active LRU after refault, because they were deemed part of the working set.

**Kernel counter**: `WORKINGSET_ACTIVATE_ANON`.

**Hierarchical**: Yes.

**Diagnostic use**: Shows the kernel's working set detection is operating on anonymous pages. A page that refaults quickly is likely in the hot working set; `workingset_activate_anon` counts those.

---

#### `workingset_activate_file`

**What it counts**: Number of file-backed refaulted pages promoted to the active LRU after refault.

**Kernel counter**: `WORKINGSET_ACTIVATE_FILE`.

**Hierarchical**: Yes.

**Diagnostic use**: Same as above for file-backed pages.

---

#### `workingset_restore_anon`

**What it counts**: Number of anonymous pages that were "restored" from eviction — they were promoted to the active list before the refault shadow expired (meaning they faulted back in quickly enough to be recognized as active).

**Kernel counter**: `WORKINGSET_RESTORE_ANON`.

**Hierarchical**: Yes.

---

#### `workingset_restore_file`

**What it counts**: Number of file-backed pages restored (promoted active before shadow expiry).

**Kernel counter**: `WORKINGSET_RESTORE_FILE`.

**Hierarchical**: Yes.

---

#### `workingset_nodereclaim`

**What it counts**: Number of times a node's reclaim was avoided because the workingset was recognized as active. This counter records when the refault distance detection machinery decided a page's shadow indicated it was in the active working set.

**Kernel counter**: `WORKINGSET_NODERECLAIM`.

**Hierarchical**: Yes.

**Diagnostic use**: Advanced diagnostic. Low values relative to `workingset_refault_*` suggests the working set detection is not helping much — the workload may be accessing pages in patterns the kernel's LRU approximation does not handle well (e.g., large sequential scans).

---

## Worked Example: Accounting Identity

`memory.current` should equal the sum of resident memory types. The exact relationship, as documented in [`Documentation/admin-guide/cgroup-v2.rst`](https://docs.kernel.org/admin-guide/cgroup-v2.html):

```
memory.current ≈ anon + file + kernel + swapcached + sock + (children's contributions)
```

In practice, due to per-cpu counter batching and timing, `memory.current` may differ slightly from the sum of `memory.stat` fields at any instant. This is expected — the kernel batches counter updates in `__mod_memcg_lruvec_state()` to avoid cache-line contention on hot paths.

### Example snapshot

```bash
$ cat /sys/fs/cgroup/myapp/memory.stat
anon 549453824          # ~524 MiB of heap/stack
file 157286400          # ~150 MiB of page cache
shmem 0
kernel_stack 2097152    # 2 MiB (256 threads × 8 KiB)
pagetables 4194304      # 4 MiB
slab_reclaimable 20971520   # ~20 MiB (dentry, inode caches)
slab_unreclaimable 8388608  # ~8 MiB (task structs, file structs)
sock 10485760           # ~10 MiB (socket buffers)
swapcached 0            # no swap activity
...
workingset_refault_anon 0
workingset_refault_file 123456

$ cat /sys/fs/cgroup/myapp/memory.current
753207296               # ~718 MiB
```

Accounting:

| Component | Bytes | MiB |
|-----------|-------|-----|
| `anon` | 549,453,824 | 524 |
| `file` | 157,286,400 | 150 |
| `kernel_stack` | 2,097,152 | 2 |
| `pagetables` | 4,194,304 | 4 |
| `slab_reclaimable` | 20,971,520 | 20 |
| `slab_unreclaimable` | 8,388,608 | 8 |
| `sock` | 10,485,760 | 10 |
| **Sum** | **752,877,568** | **718** |
| `memory.current` | 753,207,296 | ~718 |

The ~330 KiB gap is from `percpu` counters and batching delay — well within normal. `workingset_refault_file` at 123,456 events indicates this container has experienced file cache eviction and refaults, suggesting `memory.high` may be set too tight for its I/O working set.

### What memory.stat does not include

| Item | Why it is absent |
|------|-----------------|
| Pages in swap (not in RAM) | `memory.swap.current` tracks this separately |
| Hugetlb pages | Managed by the `hugetlb` controller, not `memory` |
| Memory-mapped device I/O | Not tracked by memcg (no page struct backing) |
| Kernel memory outside slab | e.g., vmalloc allocations — not fully tracked in all kernel versions |

---

## Quick Reference Table

| Field | Type | Reclaimable? | Kernel counter |
|-------|------|-------------|----------------|
| `anon` | Anonymous | Only via swap | `NR_ANON_MAPPED` |
| `anon_thp` | Anonymous THP | Only via swap | `NR_ANON_THPS` |
| `shmem` | Shared memory | Yes (to swap) | `NR_SHMEM` |
| `shmem_thp` | Shared memory THP | Yes (to swap) | `NR_SHMEM_THPS` |
| `file` | Page cache | Yes (clean: discard; dirty: writeback) | `NR_FILE_PAGES` |
| `file_mapped` | Mapped file pages | Yes (after unmap) | `NR_FILE_MAPPED` |
| `file_dirty` | Dirty page cache | After writeback | `NR_FILE_DIRTY` |
| `file_writeback` | Under writeback | After writeback completes | `NR_WRITEBACK` |
| `file_thp` | File THP | Yes | `NR_FILE_THPS` |
| `kernel` | Kernel overhead total | Partially | (derived sum) |
| `kernel_stack` | Thread kernel stacks | No (freed on exit) | `NR_KERNEL_STACK_KB` |
| `pagetables` | Page table pages | No (freed on exit) | `NR_PAGETABLE` |
| `sec_pagetables` | Secondary PT | No | `NR_SECONDARY_PAGETABLE` |
| `percpu` | Per-cpu allocations | No | (memcg-specific counter) |
| `sock` | Socket buffers | No (freed on close) | `MEMCG_SOCK` |
| `slab_reclaimable` | Reclaimable slab | Yes | `NR_SLAB_RECLAIMABLE_B` |
| `slab_unreclaimable` | Unreclaimable slab | No | `NR_SLAB_UNRECLAIMABLE_B` |
| `swapcached` | Swap cache | Yes (discard the swap copy) | `NR_SWAPCACHE` |
| `pgfault` | Event counter | — | `MEMCG_PGFAULT` |
| `pgmajfault` | Event counter | — | `MEMCG_PGMAJFAULT` |
| `pgrefill` | Event counter | — | `MEMCG_PGREFILL` |
| `pgscan` | Event counter | — | `MEMCG_PGSCAN` |
| `pgsteal` | Event counter | — | `MEMCG_PGSTEAL` |
| `pgactivate` | Event counter | — | `MEMCG_PGACTIVATE` |
| `pgdeactivate` | Event counter | — | `MEMCG_PGDEACTIVATE` |
| `pglazyfreed` | Event counter | — | `MEMCG_PGLAZYFREED` |
| `thp_fault_alloc` | Event counter | — | (memcg THP counter) |
| `thp_collapse_alloc` | Event counter | — | (memcg THP counter) |
| `workingset_refault_anon` | Event counter | — | `WORKINGSET_REFAULT_ANON` |
| `workingset_refault_file` | Event counter | — | `WORKINGSET_REFAULT_FILE` |
| `workingset_activate_anon` | Event counter | — | `WORKINGSET_ACTIVATE_ANON` |
| `workingset_activate_file` | Event counter | — | `WORKINGSET_ACTIVATE_FILE` |
| `workingset_restore_anon` | Event counter | — | `WORKINGSET_RESTORE_ANON` |
| `workingset_restore_file` | Event counter | — | `WORKINGSET_RESTORE_FILE` |
| `workingset_nodereclaim` | Event counter | — | `WORKINGSET_NODERECLAIM` |

---

## Diagnostic Recipes

### Is the container memory limit set too tight for its file cache?

```bash
STAT=/sys/fs/cgroup/mycontainer/memory.stat
HIGH=$(cat /sys/fs/cgroup/mycontainer/memory.high)
FILE=$(grep '^file ' $STAT | awk '{print $2}')
REFAULT=$(grep '^workingset_refault_file' $STAT | awk '{print $2}')

echo "File cache: $(( FILE / 1048576 )) MiB"
echo "File refaults (lifetime): $REFAULT"
echo "memory.high: $(( HIGH / 1048576 )) MiB"
# If REFAULT is high and FILE is near HIGH, raise memory.high to give cache more room
```

### Is slab growth hiding a kernel resource leak?

```bash
STAT=/sys/fs/cgroup/mycontainer/memory.stat
ANON=$(grep '^anon ' $STAT | awk '{print $2}')
FILE=$(grep '^file ' $STAT | awk '{print $2}')
SLAB_U=$(grep '^slab_unreclaimable' $STAT | awk '{print $2}')
CURRENT=$(cat /sys/fs/cgroup/mycontainer/memory.current)

echo "anon: $(( ANON / 1048576 )) MiB"
echo "file: $(( FILE / 1048576 )) MiB"
echo "slab_unreclaimable: $(( SLAB_U / 1048576 )) MiB"
echo "memory.current: $(( CURRENT / 1048576 )) MiB"
echo "unexplained: $(( (CURRENT - ANON - FILE - SLAB_U) / 1048576 )) MiB"
# Large unexplained gap or rising slab_unreclaimable = potential kernel leak
```

### Is the container actively thrashing?

```bash
STAT=/sys/fs/cgroup/mycontainer/memory.stat
SCAN=$(grep '^pgscan ' $STAT | awk '{print $2}')
STEAL=$(grep '^pgsteal ' $STAT | awk '{print $2}')
REFAULT_A=$(grep '^workingset_refault_anon' $STAT | awk '{print $2}')
REFAULT_F=$(grep '^workingset_refault_file' $STAT | awk '{print $2}')
MAJFAULT=$(grep '^pgmajfault' $STAT | awk '{print $2}')

echo "pgscan/pgsteal ratio (lifetime): $SCAN / $STEAL"
echo "workingset_refault_anon: $REFAULT_A"
echo "workingset_refault_file: $REFAULT_F"
echo "pgmajfault: $MAJFAULT"
# High refaults + high pgmajfault + pgscan >> pgsteal = thrashing
```

---

## Key Source Files

| File | Relevance |
|------|-----------|
| [`mm/memcontrol.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c) | `memcg_stat_show()` produces `memory.stat`; `__mod_memcg_lruvec_state()` updates counters |
| [`include/linux/memcontrol.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/memcontrol.h) | `mem_cgroup` struct; `MEMCG_*` stat enum; `mem_cgroup_stat_names[]` |
| [`include/linux/mm.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mm.h) | `NR_*` enum values for global and per-lruvec stats |
| [`mm/vmscan.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmscan.c) | Updates `pgscan`, `pgsteal`, `pgrefill`, `pgactivate`, `pgdeactivate` |
| [`mm/workingset.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/workingset.c) | Updates `workingset_refault_*`, `workingset_activate_*` |
| [`Documentation/admin-guide/cgroup-v2.rst`](https://docs.kernel.org/admin-guide/cgroup-v2.html) | Authoritative field descriptions |

---

## Further Reading

- [Memory Cgroups](memcg.md) — What is charged to a cgroup and how
- [Tuning Containers](tuning-containers.md) — Using memory.stat data to size memory.high and memory.max
- [/proc/meminfo](proc-meminfo.md) — The system-wide equivalent of memory.stat
- [Container Memory Limits](container-memory-limits.md) — What happens when memory.stat numbers approach the limit
