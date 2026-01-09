# Why can't I allocate contiguous memory?

> The fragmentation problem that plagues every long-running system

## The question

You have 4GB of free memory. You need a 4MB contiguous buffer for DMA. The allocation fails. Why?

```c
// This might fail even with gigabytes free
struct page *pages = alloc_pages(GFP_KERNEL, 10);  // order 10 = 4MB (1024 pages)

// kmalloc for large sizes falls back to the page allocator internally,
// so it's subject to the same fragmentation limits
void *buf = kmalloc(4 * 1024 * 1024, GFP_KERNEL);
```

*Note: `MAX_PAGE_ORDER` is typically 10 (4MB with 4KB pages) on most configs. `kmalloc()` doesn't have a separate size cap - large requests become high-order page allocations internally (see `__kmalloc_large_noprof()` in mm/slub.c).*

The answer is **external fragmentation** - free memory exists, but not in contiguous chunks.

## Why contiguous memory matters

Most kernel allocations don't need physical contiguity. Virtual memory lets you map scattered physical pages into a contiguous virtual address range (that's what `vmalloc()` does).

But some things genuinely need physically contiguous memory:

| Use case | Why contiguous? |
|----------|-----------------|
| DMA buffers | Many devices can't handle scatter-gather lists |
| Huge pages | 2MB/1GB pages require aligned contiguous regions |
| Network buffers | Some devices/paths benefit from contiguity (though many use scatter-gather) |
| GPU memory | Graphics drivers often need large contiguous allocations |

## The fragmentation problem

The buddy allocator divides memory into power-of-2 blocks. After running for days or weeks, a system's memory looks like this:

```
Physical memory after extended use:

┌─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┐
│U│F│U│U│F│U│F│F│U│U│U│F│U│F│U│F│F│F│U│U│F│U│F│U│U│F│F│U│F│U│F│U│
└─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┘
 U = Used page, F = Free page

Free pages: 14 (56KB)
Largest contiguous block: 3 pages (12KB)
```

You have 56KB free but can't allocate a 16KB block. This is external fragmentation.

### How it happens

1. System boots with large contiguous free regions
2. Allocations of various sizes come and go
3. Some allocations persist (kernel structures, pinned pages)
4. Free memory becomes scattered around persistent allocations

The persistent allocations act like rocks in a stream - free memory flows around them but can't coalesce.

## Migrate types: the kernel's first defense

The kernel groups pages by **mobility** to reduce fragmentation:

```
MIGRATE_UNMOVABLE   - Kernel structures that can't move
MIGRATE_MOVABLE     - User pages that can be migrated
MIGRATE_RECLAIMABLE - Caches that can be freed
```

The buddy allocator maintains separate free lists per migrate type ([mm/page_alloc.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c)):

```
┌─────────────────────────────────────────────────────────────┐
│                     Physical memory                         │
├───────────────────┬────────────────────┬────────────────────┤
│    UNMOVABLE      │      MOVABLE       │    RECLAIMABLE     │
│  (kernel stuff)   │   (user pages)     │    (caches)        │
└───────────────────┴────────────────────┴────────────────────┘
```

This helps because:
- Movable pages can be migrated to create contiguous free space
- Reclaimable pages can be freed under pressure
- Unmovable pages are grouped together, limiting fragmentation spread

But it's not perfect. Under pressure, the allocator will "steal" pages from other migrate types, polluting movable regions with unmovable allocations.

## Memory compaction: defragmentation for Linux

When high-order allocations fail, the kernel can try **compaction** - moving pages to create contiguous free regions.

```
Before compaction:
┌───┬───┬───┬───┬───┬───┬───┬───┐
│ M │ F │ M │ F │ M │ F │ M │ F │  M = Movable, F = Free
└───┴───┴───┴───┴───┴───┴───┴───┘

After compaction:
┌───┬───┬───┬───┬───┬───┬───┬───┐
│ M │ M │ M │ M │ F │ F │ F │ F │  Contiguous free region!
└───┴───┴───┴───┴───┴───┴───┴───┘
```

Compaction was added by Mel Gorman in kernel 2.6.35 ([commit 748446bb6b5a](https://git.kernel.org/linus/748446bb6b5a) | [LKML](https://lore.kernel.org/lkml/1269347146-7461-1-git-send-email-mel@csn.ul.ie/), 2010). Before this, high-order allocation failures on long-running systems were common and the only solution was rebooting.

See [compaction](compaction.md) for details on the algorithm.

### Limitations of compaction

Compaction can only move **movable** pages. Unmovable pages (kernel allocations, pinned memory) are permanent obstacles:

```
┌───┬───┬───┬───┬───┬───┬───┬───┐
│ U │ M │ F │ U │ M │ F │ U │ F │  U = Unmovable (can't move!)
└───┴───┴───┴───┴───┴───┴───┴───┘
                │
                ▼ After compaction
┌───┬───┬───┬───┬───┬───┬───┬───┐
│ U │ M │ M │ U │ F │ F │ U │ F │  Still fragmented around U
└───┴───┴───┴───┴───┴───┴───┴───┘
```

## CMA: the solution for device drivers

The **Contiguous Memory Allocator** (CMA) solves the device driver problem by reserving regions that serve double duty:

1. Normally used for movable pages (page cache, user memory)
2. Reclaimed for contiguous allocation when devices need them

```
CMA region:
┌─────────────────────────────────────────────────────────────┐
│  Normal operation: filled with movable pages (page cache)   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ Device requests contiguous buffer
┌─────────────────────────────────────────────────────────────┐
│  Pages migrated out, region available for DMA buffer        │
└─────────────────────────────────────────────────────────────┘
```

CMA was developed by Marek Szyprowski at Samsung and merged in kernel 3.5 ([commit c64be2bb1c6e](https://git.kernel.org/linus/c64be2bb1c6e), 2012). See the [LWN article](https://lwn.net/Articles/486301/) for design discussion.

### Using CMA

From a driver:

```c
#include <linux/dma-mapping.h>

// Allocate from CMA (DMA API handles this automatically)
void *buf = dma_alloc_coherent(dev, size, &dma_handle, GFP_KERNEL);

// Or directly (rarely needed):
#include <linux/cma.h>
struct page *pages = cma_alloc(cma, count, align, false /* no_warn */);
```

CMA regions are configured at boot:

```bash
# Reserve 256MB for CMA
cma=256M

# Or in device tree (ARM):
reserved-memory {
    linux,cma {
        compatible = "shared-dma-pool";
        size = <0x10000000>;  /* 256MB */
        reusable;
    };
};
```

## Best practices for driver developers

### 1. Use the DMA API

Don't allocate contiguous memory directly. Use `dma_alloc_coherent()` or `dma_alloc_attrs()`:

```c
// Good: Let the DMA API handle it
void *buf = dma_alloc_coherent(dev, size, &dma_handle, GFP_KERNEL);

// Avoid: Direct contiguous allocation
void *buf = kmalloc(size, GFP_KERNEL);  // May fail with large sizes
```

The DMA API can use CMA, IOMMU remapping, or bounce buffers as appropriate.

### 2. Use scatter-gather when possible

Many modern devices support scatter-gather DMA:

```c
// Instead of one large contiguous buffer
struct scatterlist sg[MAX_SEGS];
sg_init_table(sg, nents);

// Map scattered pages
dma_map_sg(dev, sg, nents, direction);
```

This eliminates the contiguous memory requirement entirely.

### 3. Allocate early or use CMA

If you need large contiguous buffers:

- Reserve memory at boot (via `memblock` or CMA)
- Use CMA regions sized for your needs
- Allocate during driver probe, not on-demand

### 4. Handle allocation failures gracefully

High-order allocations can fail. Don't use `__GFP_NOFAIL` for large allocations:

```c
// Bad: Can hang the system
void *buf = kmalloc(large_size, GFP_KERNEL | __GFP_NOFAIL);

// Good: Handle failure
void *buf = kmalloc(large_size, GFP_KERNEL | __GFP_RETRY_MAYFAIL);
if (!buf)
    return -ENOMEM;
```

## Try it yourself

```bash
# View fragmentation per order
cat /proc/buddyinfo
# Example: Node 0, zone Normal  1024  512  256  128  64  32  16  8  4  2  1
#          (counts at each order 0-10)

# View fragmentation index (debugfs required, may not exist on all configs)
cat /sys/kernel/debug/extfrag/extfrag_index
# 0.0 = no fragmentation, 1.0 = severe fragmentation

# View CMA regions
cat /proc/meminfo | grep Cma
# CmaTotal:        262144 kB
# CmaFree:         131072 kB

# Trigger manual compaction
echo 1 > /proc/sys/vm/compact_memory

# Watch compaction statistics
watch -n 1 'grep -E "compact_" /proc/vmstat'
```

## Evolution

The kernel's approach to contiguous allocation has evolved significantly:

### ZONE_MOVABLE (v2.6.23, 2007)

**Commit**: [2a1e274acf0b](https://git.kernel.org/linus/2a1e274acf0b) ("Create the ZONE_MOVABLE zone")

**Author**: Mel Gorman

*Note: This commit predates modern LKML archiving on lore.kernel.org.*

The first major anti-fragmentation feature. Created a zone that only accepts movable allocations, guaranteeing that memory in this zone can always be migrated or reclaimed. Configured via `kernelcore=` or `movablecore=` boot parameters.

```bash
# Reserve 4GB for unmovable kernel allocations, rest is ZONE_MOVABLE
kernelcore=4G

# Or specify movable zone size directly
movablecore=8G
```

### Migrate types (v2.6.24, 2007)

**Commit**: [b2a0ac8875a0](https://git.kernel.org/linus/b2a0ac8875a0) ("Split the free lists for movable and unmovable allocations")

**Author**: Mel Gorman

*Note: This commit predates modern LKML archiving on lore.kernel.org.*

Split the buddy allocator free lists by page mobility. This was a less invasive alternative to ZONE_MOVABLE that works automatically without boot parameters. The two approaches complement each other.

### Memory compaction (v2.6.35, 2010)

**Commit**: [748446bb6b5a](https://git.kernel.org/linus/748446bb6b5a) ("mm: compaction: memory compaction core") | [LKML](https://lore.kernel.org/lkml/1269347146-7461-1-git-send-email-mel@csn.ul.ie/)

**Author**: Mel Gorman

Active defragmentation by migrating pages. Before this, the kernel could only *prevent* fragmentation (via migrate types), not *fix* it. Compaction made THP viable on long-running systems.

### CMA (v3.5, 2012)

**Commit**: [c64be2bb1c6e](https://git.kernel.org/linus/c64be2bb1c6e) ("drivers: add Contiguous Memory Allocator")

**Author**: Marek Szyprowski (Samsung)

*Note: The original patch series is not archived on lore.kernel.org; see [LWN coverage](https://lwn.net/Articles/486301/) for discussion.*

Solved the device driver problem by creating regions that serve double duty - used for movable pages normally, reclaimed for contiguous DMA buffers on demand. See [LWN article](https://lwn.net/Articles/486301/).

### Proactive compaction (v5.9, 2020)

**Commit**: [facdaa917c4d](https://git.kernel.org/linus/facdaa917c4d) ("mm: proactive compaction") | [LKML](https://lore.kernel.org/linux-mm/20200428221055.598-1-nigupta@nvidia.com/)

**Author**: Nitin Gupta (NVIDIA)

Background compaction based on fragmentation levels, reducing direct compaction stalls. Controlled via `vm.compaction_proactiveness`.

## Further reading

- [Memory compaction](compaction.md) - How compaction works
- [Page allocator](page-allocator.md) - Buddy system and migrate types
- [LWN: CMA](https://lwn.net/Articles/486301/) - CMA design and rationale
- [LWN: Memory compaction](https://lwn.net/Articles/368869/) - Original compaction proposal
- [LWN: In defense of fragmentation avoidance](https://lwn.net/Articles/226419/) - Mel Gorman's 2007 explanation of the approach
- [Kernel docs: DMA API](https://docs.kernel.org/core-api/dma-api.html) - Using the DMA API correctly
