# Transparent Huge Pages (THP)

> Automatic huge page allocation without application changes

## What Is THP?

Transparent Huge Pages automatically promotes regular 4KB pages to 2MB huge pages when possible. Unlike hugetlbfs, THP requires no application modifications - the kernel handles everything transparently.

```
Without THP:                    With THP:
┌─────┬─────┬─────┬─────┐      ┌─────────────────────┐
│ 4KB │ 4KB │ 4KB │ ... │      │       2MB           │
│     │     │     │     │      │    (512 x 4KB)      │
└─────┴─────┴─────┴─────┘      └─────────────────────┘
   512 TLB entries needed         1 TLB entry needed
```

## Why THP?

### The TLB Problem

The TLB (Translation Lookaside Buffer) caches page table entries. It's small (typically 64-1536 entries) but critical for performance. With 4KB pages:

| Workload Size | Pages Needed | TLB Pressure |
|---------------|--------------|--------------|
| 1MB | 256 | Low |
| 1GB | 262,144 | High |
| 100GB | 26,214,400 | Severe |

Large workloads constantly evict TLB entries, causing expensive page table walks.

### Huge Pages as Solution

2MB pages reduce TLB pressure by 512x:

| Page Size | Pages for 1GB | TLB Entries |
|-----------|---------------|-------------|
| 4KB | 262,144 | 262,144 |
| 2MB | 512 | 512 |
| 1GB | 1 | 1 |

## How THP Works

### Two Allocation Paths

**1. Fault-based (synchronous)**

When a process faults on memory, the kernel tries to allocate a huge page:

```
Page fault
    │
    v
Can we allocate 2MB?
    │
    ├── Yes: Map huge page
    │
    └── No: Fall back to 4KB pages
```

**2. khugepaged (asynchronous)**

A kernel thread scans for regions that can be collapsed into huge pages:

```
khugepaged thread
    │
    v
Scan process VMAs
    │
    v
Find 512 contiguous 4KB pages?
    │
    ├── Yes: Collapse into 2MB huge page
    │
    └── No: Skip, try again later
```

## Configuration

### Global Settings

```bash
# View current mode
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# Options:
# always  - THP for all anonymous memory
# madvise - THP only for MADV_HUGEPAGE regions
# never   - THP disabled
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
```

### Defrag Settings

```bash
# When to defragment memory for huge pages
cat /sys/kernel/mm/transparent_hugepage/defrag
# [always] defer defer+madvise madvise never

# always        - Sync defrag on fault (can stall)
# defer         - Async defrag via khugepaged
# defer+madvise - Defer for most, sync for MADV_HUGEPAGE
# madvise       - Only defrag for MADV_HUGEPAGE
# never         - Never defrag for THP
```

### Per-Process Control

```c
#include <sys/mman.h>

void *ptr = mmap(NULL, size, PROT_READ|PROT_WRITE,
                 MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);

/* Enable THP for this region */
madvise(ptr, size, MADV_HUGEPAGE);

/* Disable THP for this region */
madvise(ptr, size, MADV_NOHUGEPAGE);
```

### khugepaged Tuning

```bash
# Scan interval (milliseconds)
cat /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
# 10000 (default)

# Pages to scan per interval
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
# 4096 (default)

# Max unmapped PTEs allowed when collapsing
cat /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none
# 511 (default - collapse even if 511 of 512 PTEs are none/zero)
```

## THP and Specific Workloads

### Databases

Databases often benefit from THP but can suffer from:
- Latency spikes during compaction
- Memory bloat (2MB granularity)

Many databases recommend `madvise` mode with explicit huge page requests.

### Virtual Machines (KVM)

THP was originally designed for KVM:

From commit [71e3aac0724f](https://git.kernel.org/linus/71e3aac0724f):
> "Lately I've been working to make KVM use hugepages transparently without the usual restrictions of hugetlbfs."

VMs benefit significantly from reduced TLB pressure on nested page tables.

### Redis/Memcached

In-memory stores can see latency spikes from THP defragmentation. Many recommend:
```bash
echo never > /sys/kernel/mm/transparent_hugepage/enabled
```

Or use `madvise` mode with application-level control.

## THP vs hugetlbfs

| Feature | THP | hugetlbfs |
|---------|-----|-----------|
| Application changes | None (or MADV_HUGEPAGE for hints) | Required |
| Page sizes | 2MB (PMD), 16KB-1MB with mTHP (v6.10+) | 2MB, 1GB |
| Swappable | Yes (since v4.13) | No |
| Reservation | On-demand | Pre-allocated |
| Fragmentation risk | Higher | Lower |
| Overcommit | Yes | No |

## Monitoring

### System-Wide Statistics

```bash
# THP statistics
cat /proc/meminfo | grep -i huge
# AnonHugePages:    2097152 kB  <- THP usage
# HugePages_Total:       0     <- hugetlbfs
# HugePages_Free:        0

# Detailed THP stats
cat /proc/vmstat | grep thp
# thp_fault_alloc        - Huge pages allocated on fault
# thp_fault_fallback     - Fell back to 4KB
# thp_collapse_alloc     - khugepaged collapses
# thp_split_page         - Huge pages split back to 4KB
```

### Per-Process

```bash
# Huge page usage for a process
cat /proc/<pid>/smaps | grep -i huge
# AnonHugePages:     2048 kB

# Or summarized
cat /proc/<pid>/smaps_rollup | grep AnonHugePages
```

### Tracing

```bash
# Trace THP events
echo 1 > /sys/kernel/debug/tracing/events/huge_memory/mm_khugepaged_scan_pmd/enable
echo 1 > /sys/kernel/debug/tracing/events/huge_memory/mm_collapse_huge_page/enable
cat /sys/kernel/debug/tracing/trace_pipe
```

## History

### THP Introduction (v2.6.38, 2011)

**Commit**: [71e3aac0724f](https://git.kernel.org/linus/71e3aac0724f) ("thp: transparent hugepage core")

**Author**: Andrea Arcangeli (Red Hat)

*Note: Pre-2012 LKML archives on lore.kernel.org are sparse. The commit message documents the design rationale.*

Initial THP implementation for anonymous memory.

### THP Swap Support (v4.13, 2017)

**Commit**: [38d8b4e6bdc8](https://git.kernel.org/linus/38d8b4e6bdc8) ("mm, THP, swap: delay splitting THP during swap out") | [LKML](https://lore.kernel.org/lkml/20170724051840.2309-1-ying.huang@intel.com/)

**Author**: Huang Ying

THP pages can now be swapped as a unit without splitting first, improving swap performance.

### Multi-Size THP (v6.10, 2024)

**Commit**: [19eaf44954df](https://git.kernel.org/linus/19eaf44954df) ("mm: thp: support allocation of anonymous multi-size THP") | [LKML](https://lore.kernel.org/linux-mm/20231204102027.57185-1-ryan.roberts@arm.com/)

**Author**: Ryan Roberts

Enables THP at sizes between 4KB and 2MB (e.g., 16KB, 64KB), providing more flexibility for workloads where 2MB is too large.

## Common Issues

### Latency Spikes

THP defragmentation can cause allocation stalls.

**Symptoms**: Random latency spikes in latency-sensitive applications

**Solutions**:
- Use `defrag=defer` or `defrag=madvise`
- Set `enabled=madvise` and control per-region
- Disable THP for latency-critical apps

### Memory Bloat

Small allocations rounded up to 2MB.

**Symptoms**: Higher than expected memory usage

**Debug**: Compare `AnonHugePages` vs `Anonymous` in `/proc/meminfo`

**Solutions**:
- Use `madvise` mode
- Tune application allocation patterns

### khugepaged CPU Usage

khugepaged consuming too much CPU.

**Debug**: `top` or `perf top`

**Solutions**:
- Increase `scan_sleep_millisecs`
- Reduce `pages_to_scan`

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/huge_memory.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/huge_memory.c) | THP core implementation |
| [`mm/khugepaged.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/khugepaged.c) | Collapse daemon |

### Kernel Documentation

- [`Documentation/admin-guide/mm/transhuge.rst`](https://docs.kernel.org/admin-guide/mm/transhuge.html)

### Mailing List Discussions

- [THP defrag behavior](https://lore.kernel.org/patchwork/patch/745411/) - Discussion on MADV_HUGEPAGE stalling semantics and Mel Gorman's intent for "defer" mode
- [Node-local hugepage allocations](https://lore.kernel.org/lkml/20181206045917.GG23332@shao2-debian/) - 2018 discussion on THP gfp handling and remote allocations

### Related

- [page-tables](page-tables.md) - PMD-level huge page mapping
- [compaction](compaction.md) - Memory defragmentation for THP
- [reclaim](reclaim.md) - THP and memory pressure
