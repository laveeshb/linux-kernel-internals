# Page Allocator (Buddy System)

> The foundation of Linux memory management - allocating physical page frames

## What is the Page Allocator?

The page allocator manages physical memory at the page granularity (typically `4KB`). It's the lowest-level allocator in the kernel - every other allocator (SLUB, vmalloc) ultimately gets pages from here.

```c
struct page *alloc_pages(gfp_t gfp, unsigned int order);
void free_pages(unsigned long addr, unsigned int order);
```

## The Buddy System

Linux uses a **buddy allocator**, an algorithm dating back to 1965 (Knowlton). The key insight: manage memory in power-of-2 sized blocks, and when you free memory, merge it with its "buddy" if also free.

### How It Works

```
Memory divided into blocks of order 0, 1, 2, ... 10
Order 0 = 1 page (4KB)
Order 1 = 2 pages (8KB)
Order 2 = 4 pages (16KB)
...
Order 10 = 1024 pages (4MB) - max order (MAX_ORDER=11, so 0-10 valid)

Free lists per order:
+-------------------------------------------+
| Order 0: [4KB] [4KB] [4KB] ...            |
| Order 1: [8KB] [8KB] ...                  |
| Order 2: [16KB] ...                       |
| ...                                       |
| Order 10: [4MB] ...                       |
+-------------------------------------------+
```

### Allocation Example

Request for 3 pages (needs order 2 = 4 pages):

```
1. Check order 2 free list
   - If available: remove block, return it
   - If empty: go to step 2

2. Check order 3 free list (8 pages)
   - Split: one 4-page block to satisfy request
   - Other 4-page block goes to order 2 free list

3. Continue splitting from higher orders if needed
```

### Free Example (Buddy Merging)

Freeing a 4-page block at address 0x4000 (order-2 blocks must be 4-page aligned):

```
1. Find buddy address: 0x4000 XOR (4 * PAGE_SIZE) = 0x0000

2. Is buddy free and same order?
   - Yes: merge into 8-page block, try to merge again
   - No: add to order 2 free list

Merging continues up to MAX_ORDER or until buddy isn't free
```

### Why Buddies?

The buddy's address can be computed with a single XOR operation - no searching required. Two adjacent blocks of the same size are buddies only if they came from splitting the same larger block.

## Memory Zones

Physical memory is divided into zones based on hardware constraints:

| Zone | Purpose | Typical Range (x86-64) |
|------|---------|------------------------|
| `ZONE_DMA` | Legacy 16-bit DMA devices | 0 - 16MB |
| `ZONE_DMA32` | 32-bit DMA devices | 16MB - 4GB |
| `ZONE_NORMAL` | Regular kernel allocations | Above 4GB |
| `ZONE_MOVABLE` | Migratable pages (memory hotplug, isolation) | Configurable |

Each zone has its own set of buddy free lists.

## GFP Flags

GFP (Get Free Pages) flags control allocation behavior:

```c
/* Common combinations */
GFP_KERNEL    /* Normal allocation, can sleep, can reclaim */
GFP_ATOMIC    /* Cannot sleep (interrupt context) */
GFP_USER      /* User-space allocation */
GFP_DMA       /* Must be in ZONE_DMA */
GFP_DMA32     /* Must be in ZONE_DMA32 */

/* Modifiers */
__GFP_ZERO    /* Zero the memory */
__GFP_NOWARN  /* Suppress allocation failure warnings */
__GFP_RETRY_MAYFAIL  /* Try hard but may fail */
__GFP_NOFAIL  /* Never fail - use sparingly, can deadlock */
```

See [`include/linux/gfp.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/gfp.h) for the full list.

## History & Evolution

### Origins (1991)

The buddy allocator has been in Linux since the beginning. The basic algorithm is from:

> Knowlton, K. C. "A Fast Storage Allocator" Communications of the ACM, 1965

*Note: Pre-LKML era. Early implementation details are in the git history starting from v2.6.12.*

### Per-CPU Page Lists (v2.5/2.6)

**Problem**: The zone lock became a bottleneck on SMP systems - every allocation/free needed it.

**Solution**: Per-CPU page lists (`per_cpu_pages`) cache single pages, reducing lock contention.

*Note: Developed incrementally during 2.5 cycle. Predates searchable git history (v2.6.12+).*

```
CPU 0: [page] [page] [page] ...  (hot cache)
CPU 1: [page] [page] ...
...
        |
        v
   Zone free lists (locked)
```

### NUMA Awareness (v2.6)

**Problem**: On NUMA systems, accessing remote memory is slower than local memory.

**Solution**: Per-node zones. Allocations prefer local node memory.

```c
/* Allocate from specific node */
alloc_pages_node(node_id, gfp, order);
```

*Note: NUMA support evolved over many releases. See `mm/mempolicy.c` for allocation policies.*

### Compaction (v2.6.35, 2010)

**Commit**: [748446bb6b5a](https://git.kernel.org/linus/748446bb6b5a) ("mm: compaction: memory compaction core") | [LKML](https://lore.kernel.org/lkml/1269347146-7461-1-git-send-email-mel@csn.ul.ie/)

**Author**: Mel Gorman

**Problem**: External fragmentation - free pages scattered, can't satisfy high-order allocations.

**Solution**: Memory compaction - move pages to create contiguous free blocks.

### CMA (Contiguous Memory Allocator, v3.5, 2012)

**Commit**: [c64be2bb1c6e](https://git.kernel.org/linus/c64be2bb1c6e) ("drivers: add Contiguous Memory Allocator")

**Author**: Marek Szyprowski (Samsung)

*Note: Pre-2013 LKML archives on lore.kernel.org are sparse. See [LWN article](https://lwn.net/Articles/486301/) for design discussion.*

**Problem**: Devices need large contiguous buffers but memory fragments over time.

**Solution**: Reserve regions that can be used by movable pages normally, but reclaimed for contiguous allocation when needed.

## Try It Yourself

### View Buddy Allocator State

```bash
# Free blocks per order, per zone
cat /proc/buddyinfo

# Example output:
# Node 0, zone   Normal  1024  512  256  128   64   32   16    8    4    2    1
#                        ^order 0              ^order 5                    ^order 10

# Each number = count of free blocks at that order
```

### View Zone Information

```bash
# Detailed zone stats
cat /proc/zoneinfo

# Key fields:
# - min/low/high: watermarks for reclaim
# - free: current free pages
# - managed: pages managed by this zone
```

### Memory Pressure Test

```bash
# Watch buddy state while allocating memory
watch -n 1 cat /proc/buddyinfo

# In another terminal, consume memory
stress --vm 1 --vm-bytes 1G
```

### Trace Allocations

```bash
# Enable page allocation tracing (requires debugfs)
echo 1 > /sys/kernel/debug/tracing/events/kmem/mm_page_alloc/enable
cat /sys/kernel/debug/tracing/trace_pipe

# Output shows: page address, order, gfp flags, migratetype
```

## Key Data Structures

### struct zone

```c
struct zone {
    unsigned long watermark[NR_WMARK];     /* min/low/high thresholds */
    unsigned long nr_reserved_highatomic;
    struct per_cpu_pages __percpu *per_cpu_pageset;
    struct free_area free_area[NR_PAGE_ORDERS];  /* buddy free lists */
    unsigned long zone_start_pfn;
    unsigned long managed_pages;
    unsigned long spanned_pages;
    unsigned long present_pages;
    const char *name;
    /* ... */
};
```

*Note: `NR_PAGE_ORDERS` replaced `MAX_ORDER` in recent kernels. When reading older code, `MAX_ORDER` is the same concept.*

### Watermarks

Each zone has watermarks that control reclaim behavior:

| Watermark | When Reached |
|-----------|--------------|
| `high` | Zone is healthy, no action needed |
| `low` | Wake `kswapd` to reclaim pages in background |
| `min` | Direct reclaim - allocating process must help free pages |
| `promo` | For tiered memory (CXL/NUMA), controls page promotion |

Watermarks are derived from `vm.min_free_kbytes`:

```bash
# View watermarks
cat /proc/zoneinfo | grep -E "pages free|min|low|high"

# Adjust minimum free memory (affects all watermarks)
sysctl vm.min_free_kbytes=65536
```

**Zone fallback**: When a zone is exhausted, allocations fall back to other zones in order: NORMAL → DMA32 → DMA (preferring higher zones first).

### struct free_area

```c
struct free_area {
    struct list_head free_list[MIGRATE_TYPES];  /* per-migratetype lists */
    unsigned long nr_free;
};
```

### Migrate Types

Pages are grouped by mobility to reduce fragmentation:

| Type | Description |
|------|-------------|
| `MIGRATE_UNMOVABLE` | Kernel allocations that can't move |
| `MIGRATE_MOVABLE` | User pages, can be migrated/compacted |
| `MIGRATE_RECLAIMABLE` | Caches that can be freed under pressure |
| `MIGRATE_HIGHATOMIC` | Reserved for high-priority atomic allocations |
| `MIGRATE_CMA` | Contiguous Memory Allocator regions |
| `MIGRATE_ISOLATE` | Pages being isolated for migration/offlining |

```bash
# View migrate type distribution
cat /proc/pagetypeinfo
```

## Common Issues

### High-Order Allocation Failures

Large contiguous allocations (order > 3) can fail due to fragmentation even with free memory.

**Solutions**:
- Use `__GFP_RETRY_MAYFAIL` to try harder
- Use vmalloc instead (virtual contiguity)
- Enable compaction (`/proc/sys/vm/compact_memory`)

### Zone Imbalance

Memory pressure in one zone while others have free memory.

**Check**: `cat /proc/zoneinfo | grep -E "zone|free|min"`

### OOM Despite Free Pages

Free pages exist but in wrong zone or wrong migratetype.

**Debug**: Check `/proc/buddyinfo` and `/proc/pagetypeinfo`

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) | Core allocator |
| [`include/linux/gfp.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/gfp.h) | GFP flags |
| [`include/linux/mmzone.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mmzone.h) | Zone structures |

### Key Commits

| Commit | Kernel | Description |
|--------|--------|-------------|
| [748446bb6b5a](https://git.kernel.org/linus/748446bb6b5a) | v2.6.35 | Memory compaction |
| [c64be2bb1c6e](https://git.kernel.org/linus/c64be2bb1c6e) | v3.5 | CMA introduction |

### Related

- [overview](overview.md) - How page allocator fits with other allocators
- [slab](slab.md) - SLUB uses pages from buddy allocator
- [vmalloc](vmalloc.md) - Gets individual pages from buddy
