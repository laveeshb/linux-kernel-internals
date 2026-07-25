# CMA (Contiguous Memory Allocator)

> Reserved regions that serve double duty: normal pages by day, DMA buffers on demand

## What Is CMA?

CMA reserves regions of physical memory at boot that can be reclaimed for large contiguous allocations when devices need them. The key insight is that these reserved pages are not wasted -- they serve normal movable allocations (page cache, anonymous memory) until a device driver requests a contiguous buffer, at which point the pages are migrated out and the region is handed to the driver.

```
CMA region (idle):
┌────────────────────────────────────────────────────────────────┐
│  Page   Page   Page   Page   Page   Page   Page   Page        │
│  cache  anon   cache  anon   cache  anon   cache  cache       │
│  (movable allocations using the CMA region normally)           │
└────────────────────────────────────────────────────────────────┘

DMA allocation request arrives:
┌────────────────────────────────────────────────────────────────┐
│  Migrate all movable pages out...                              │
│  ← pages moved to other free memory                           │
└────────────────────────────────────────────────────────────────┘

CMA region (allocated to device):
┌────────────────────────────────────────────────────────────────┐
│              Contiguous DMA buffer for device                  │
└────────────────────────────────────────────────────────────────┘
```

## Why CMA Exists

### The Problem

DMA devices often need physically contiguous memory. Unlike CPUs, many devices cannot use page tables to remap scattered physical pages into a contiguous address range. A camera capturing a frame, a display controller scanning out a framebuffer, or a network card sending a jumbo packet may all need a single contiguous physical buffer.

On a freshly booted system, large contiguous allocations succeed easily. But after days of uptime, physical memory becomes fragmented -- free pages are scattered between persistent allocations. Even with gigabytes free, allocating a contiguous 8MB buffer can fail.

### Previous Solutions and Their Downsides

Before CMA, the options were poor:

| Approach | Downside |
|----------|----------|
| Boot-time reservation (`memblock_reserve`) | Memory is exclusively locked away, wasted when devices are idle |
| High-order `alloc_pages` at runtime | Fails under fragmentation |
| Compaction before allocation | Slow, unreliable for very large buffers |
| IOMMU remapping | Not all platforms have an IOMMU; adds complexity and latency |

The boot-time reservation approach was especially wasteful on embedded devices (phones, set-top boxes) where RAM is scarce. A device might reserve 64MB for a camera that is used for a few minutes a day, leaving that memory unavailable for the rest of the system.

### CMA's Insight

CMA eliminates the tradeoff between reliability and waste. It reserves regions at boot (guaranteeing contiguous space is available) but allows movable allocations to use that space in the meantime. When a device needs the memory, CMA migrates the movable pages out and hands over the contiguous region.

This dual-use design was particularly important for ARM-based mobile devices at Samsung, where limited RAM and many DMA-dependent peripherals (camera, display, codec) created constant tension between device driver needs and application memory.

## How CMA Works

### The Dual-Use Design

CMA regions live within `ZONE_NORMAL` (or `ZONE_DMA`/`ZONE_DMA32` depending on architecture). The buddy allocator treats CMA pages as a special migrate type: `MIGRATE_CMA`.

```
Zone layout with CMA:
┌──────────────────────────────────────────────────────────────────────┐
│                           ZONE_NORMAL                                │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  ┌──────────┐    │
│  │ MOVABLE  │  │UNMOVABLE │  │   MIGRATE_CMA    │  │RECLAIMABLE│   │
│  │          │  │          │  │  (CMA region)    │  │          │    │
│  └──────────┘  └──────────┘  └──────────────────┘  └──────────┘    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

The rules for `MIGRATE_CMA` pages:

1. **Movable allocations can use CMA pages freely.** The page allocator falls back to CMA pageblocks when serving `MIGRATE_MOVABLE` requests.
2. **Unmovable and reclaimable allocations cannot use CMA pages.** This is critical -- if an unmovable kernel allocation landed in a CMA region, the region could never be fully reclaimed.
3. **When a driver calls `cma_alloc()`, all movable pages in the requested range are migrated out.** The kernel uses the same page migration machinery as compaction.

### Allocation Path

When a driver needs contiguous memory (typically through `dma_alloc_coherent()`):

```
Driver calls dma_alloc_coherent(dev, size, ...)
        │
        ▼
DMA subsystem selects CMA region for this device
        │
        ▼
cma_alloc(cma, count, align, no_warn)
        │
        ▼
Find a suitable range of pages within the CMA region
        │
        ▼
alloc_contig_range(start, end, MIGRATE_CMA, ...)
        │
        ├─── Isolate the range (prevent new allocations)
        │
        ├─── Migrate all movable pages out of the range
        │         Uses the same migration code as compaction
        │
        ├─── Drain per-cpu page lists
        │
        └─── Return contiguous pages to the caller
```

If migration fails (e.g., a page is pinned for I/O), `cma_alloc()` retries with a different range within the CMA region. It scans through the region in bitmap-tracked chunks until it finds a range that can be fully cleared, or gives up.

### The CMA Bitmap

Each CMA region tracks allocation state with a bitmap. Each bit represents a block of pages (the granularity is set by `CONFIG_CMA_ALIGNMENT`, defaulting to order-8 or 1MB with 4KB pages):

```c
struct cma {
    unsigned long   base_pfn;       /* Start of CMA region */
    unsigned long   count;          /* Total pages in region */
    unsigned long   *bitmap;        /* Allocation bitmap */
    unsigned int    order_per_bit;  /* Pages per bit (power of 2) */
    spinlock_t      lock;
    ...
};
```

The bitmap tracks which chunks are currently allocated to devices. Pages not marked as allocated in the bitmap are available for movable use by the rest of the system.

### Interaction with the Page Allocator

CMA integrates with the buddy allocator through the `MIGRATE_CMA` migrate type, introduced alongside CMA. Key interactions:

- **Fallback behavior**: When the buddy allocator cannot satisfy a `MIGRATE_MOVABLE` request from the movable free list, it falls back to `MIGRATE_CMA` pages. This is how CMA regions get populated with movable pages during normal operation.
- **Steal prevention**: The allocator never steals CMA pageblocks for `MIGRATE_UNMOVABLE` or `MIGRATE_RECLAIMABLE` requests. This guarantee is enforced in `__rmqueue_fallback()` in `mm/page_alloc.c`.
- **Compaction awareness**: When compaction runs, it understands CMA regions and respects their migrate type. CMA pages can be targets for the compaction migration scanner (pages can be moved *into* CMA regions), but CMA pages won't be changed to unmovable types.

## Configuration

### Kernel Command Line

The simplest way to set up CMA:

```bash
# Reserve 256MB for the default global CMA area
cma=256M

# With placement hint (base address)
cma=256M@0x40000000
```

The `cma=` parameter sets the size of the default CMA area, which is used by any device that does not have a dedicated CMA region.

### Device Tree (ARM/embedded)

Embedded platforms typically define CMA regions in the device tree:

```dts
reserved-memory {
    #address-cells = <2>;
    #size-cells = <2>;
    ranges;

    /* Default CMA region */
    linux,cma {
        compatible = "shared-dma-pool";
        reusable;
        size = <0 0x10000000>;  /* 256MB */
        linux,cma-default;
    };

    /* Dedicated region for a specific device */
    camera_mem: camera-buffer {
        compatible = "shared-dma-pool";
        reusable;
        reg = <0 0x78000000 0 0x8000000>;  /* 128MB at specific address */
    };
};

camera@0 {
    memory-region = <&camera_mem>;
};
```

The `reusable` property is what makes it CMA rather than a static reservation. Without `reusable`, the region would be exclusively reserved and not available for movable allocations.

### Kernel Config Options

```
CONFIG_CMA=y                    # Enable CMA support
CONFIG_CMA_DEBUG=y              # Extra debug checks (development only)
CONFIG_CMA_DEBUGFS=y            # Expose per-region stats in debugfs
CONFIG_CMA_SIZE_MBYTES=16       # Default CMA size in MB
CONFIG_CMA_SIZE_PERCENTAGE=0    # Default CMA size as percentage of RAM
CONFIG_CMA_ALIGNMENT=8          # Minimum alignment (order), default 8 = 256 pages = 1MB
CONFIG_DMA_CMA=y                # Use CMA as the DMA contiguous allocator backend
```

`CONFIG_CMA_SIZE_MBYTES` sets the default size when no `cma=` boot parameter is given. `CONFIG_CMA_SIZE_PERCENTAGE` provides an alternative way to scale CMA with RAM size. The larger of the two values wins.

## Using CMA from Drivers

### The DMA API (Recommended)

Most drivers should use the DMA API, which handles CMA allocation transparently:

```c
#include <linux/dma-mapping.h>

/* Allocate contiguous DMA buffer -- uses CMA if CONFIG_DMA_CMA=y */
void *vaddr = dma_alloc_coherent(dev, size, &dma_handle, GFP_KERNEL);

/* Free when done */
dma_free_coherent(dev, size, vaddr, dma_handle);
```

The DMA subsystem calls into CMA via `dma_alloc_from_contiguous()`, which maps to `cma_alloc()` internally. The device's CMA region is selected based on its `memory-region` device tree property, or the default global CMA area.

### Direct CMA API (Rare)

For subsystems that need direct control:

```c
#include <linux/cma.h>

/* Allocate count pages aligned to 1 << align from a specific CMA area */
struct page *page = cma_alloc(cma, count, align, no_warn);

/* Release back to CMA */
cma_release(cma, page, count);
```

After `cma_release()`, the pages return to the buddy allocator as `MIGRATE_CMA` pages and can once again serve movable allocations.

## Monitoring

### /proc/meminfo

```bash
$ grep Cma /proc/meminfo
CmaTotal:        262144 kB    # Total CMA reservation
CmaFree:         245760 kB    # CMA pages not allocated to devices
```

`CmaFree` shows how much of the CMA region is not currently held by device drivers. These pages are likely in use by movable allocations (page cache, anonymous memory) but can be reclaimed when a device needs them.

Note that `CmaTotal` and `CmaFree` are included in `MemTotal` and `MemFree` respectively -- CMA memory is not "missing" from the system's perspective.

### debugfs (CONFIG_CMA_DEBUGFS)

```bash
$ ls /sys/kernel/debug/cma/
cma-reserved/

$ ls /sys/kernel/debug/cma/cma-reserved/
alloc  base_pfn  bitmap  count  free  maxchunk  order_per_bit  used

$ cat /sys/kernel/debug/cma/cma-reserved/base_pfn
262144
$ cat /sys/kernel/debug/cma/cma-reserved/count
65536        # Total pages in region
$ cat /sys/kernel/debug/cma/cma-reserved/used
0            # Pages currently allocated to devices
$ cat /sys/kernel/debug/cma/cma-reserved/maxchunk
65536        # Largest contiguous free chunk (in pages)
```

The `alloc` file is writable -- you can trigger a test allocation to verify CMA is working:

```bash
# Test-allocate 1024 pages (4MB) from the CMA region
echo 1024 > /sys/kernel/debug/cma/cma-reserved/alloc
```

### vmstat Counters

```bash
$ grep cma /proc/vmstat
cma_alloc_success 42
cma_alloc_fail 0
```

These counters (added in v5.19) track CMA allocation outcomes across all CMA regions.

## Try It Yourself

```bash
# Check if CMA is enabled and how much is reserved
grep Cma /proc/meminfo

# View CMA kernel boot parameter
cat /proc/cmdline | tr ' ' '\n' | grep cma

# If debugfs is available, inspect CMA regions
ls /sys/kernel/debug/cma/ 2>/dev/null

# Watch CMA allocation stats (kernel 5.19+)
grep cma /proc/vmstat

# Check buddyinfo to see free page counts per order
# Low counts at high orders suggest fragmentation that CMA helps avoid
cat /proc/buddyinfo

# On an embedded device, view device tree CMA configuration
# (requires dtc; /proc/device-tree may also be available)
ls /proc/device-tree/reserved-memory/ 2>/dev/null
```

## History

### Development at Samsung

CMA was developed by Marek Szyprowski at Samsung Electronics. The motivation came from ARM mobile platforms (like Samsung's Exynos SoCs) where multiple peripherals -- cameras, display controllers, multimedia codecs, and GPU -- all needed large contiguous buffers but the system had limited RAM to spare for static reservations.

The feature went through extensive review over multiple revisions of the patch series before being merged.

### Merged in v3.5 (2012)

**Commit**: [c64be2bb1c6e](https://git.kernel.org/linus/c64be2bb1c6e) ("drivers: add Contiguous Memory Allocator")

**Author**: Marek Szyprowski

The initial merge included the core CMA allocator and its integration with the DMA subsystem.

**LWN coverage**: [A deep dive into CMA](https://lwn.net/Articles/486301/) -- discusses the design rationale and review process.

### MIGRATE_CMA Type (v3.5, 2012)

**Commit**: [47118af076f6](https://git.kernel.org/linus/47118af076f6) ("mm: mmzone: MIGRATE_CMA migration type added")

**Author**: Marek Szyprowski

Added the `MIGRATE_CMA` migrate type to the buddy allocator, enabling the dual-use design where CMA pages serve movable allocations while preventing unmovable ones from landing in CMA regions.

### Per-device CMA Areas (v3.17, 2014)

**Commit**: [c1f733aaf1e1](https://git.kernel.org/linus/c1f733aaf1e1) ("drivers: of: add initialization code for dma-reserved-memory")

The device tree `memory-region` property support, allowing individual devices to have their own dedicated CMA regions rather than sharing the global one.

### CMA debugfs (v4.1, 2015)

**Commit**: [28b24c1fc8c4](https://git.kernel.org/linus/28b24c1fc8c4) ("mm: cma: debugfs interface")

**Author**: Sasha Levin

The debugfs interface for monitoring CMA was added, giving operators visibility into CMA region usage.

## Key Source Files

| File | Description |
|------|-------------|
| [`mm/cma.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/cma.c) | Core CMA allocator: `cma_alloc()`, `cma_release()`, bitmap management |
| [`mm/cma.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/cma.h) | Internal CMA header (the `struct cma` definition) |
| [`include/linux/cma.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/cma.h) | Public CMA API for drivers |
| [`mm/cma_debug.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/cma_debug.c) | debugfs interface for CMA regions |
| [`kernel/dma/contiguous.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/dma/contiguous.c) | DMA subsystem integration: `dma_alloc_from_contiguous()` |
| [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) | Buddy allocator with `MIGRATE_CMA` fallback logic |
| [`mm/page_isolation.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_isolation.c) | Page range isolation used during `cma_alloc()` |

## Common Issues

### CMA Allocation Failures

**Symptoms**: `cma_alloc_fail` count increasing, driver probe failures, DMA allocation errors in dmesg.

**Common causes**:

- **Pinned pages in the CMA region**: Pages undergoing I/O or held by `get_user_pages()` cannot be migrated. This is the most common cause of CMA allocation failures. See [Getting User Pages (GUP)](gup.md#foll_longterm-the-pin-that-fights-the-whole-memory-manager) for why long-term pins and CMA movability are fundamentally at odds.
- **CMA region too small**: The region must accommodate the largest single contiguous allocation plus any concurrent allocations from other devices.
- **Fragmentation within CMA**: If device allocations of varying sizes come and go, the CMA bitmap itself can become fragmented (external fragmentation within the CMA region).

**Diagnosis**:

```bash
# Check for CMA failures
grep cma /proc/vmstat
dmesg | grep -i cma

# Check available CMA space
grep Cma /proc/meminfo

# debugfs for detailed region state
cat /sys/kernel/debug/cma/*/used
cat /sys/kernel/debug/cma/*/maxchunk
```

### CMA Memory Not Appearing

If `CmaTotal` is 0 in `/proc/meminfo`:

- Verify `CONFIG_CMA=y` and `CONFIG_DMA_CMA=y` in the kernel config
- Check that the `cma=` boot parameter is present, or that `CONFIG_CMA_SIZE_MBYTES` is nonzero
- On device tree platforms, verify the reserved-memory node has `compatible = "shared-dma-pool"` and the `reusable` property

## References

- [LWN: A deep dive into CMA](https://lwn.net/Articles/486301/) - Design discussion from the merge window
- [LWN: CMA and compaction](https://lwn.net/Articles/684611/) - Interaction between CMA and compaction
- [LWN: Contiguous memory allocation for drivers](https://lwn.net/Articles/396657/) - Early CMA proposal
- [Kernel docs: DMA API](https://docs.kernel.org/core-api/dma-api.html) - How drivers should allocate DMA memory
- [contiguous-memory](contiguous-memory.md) - The fragmentation problem CMA solves
- [compaction](compaction.md) - The page migration machinery CMA relies on
- [page-allocator](page-allocator.md) - Buddy allocator and migrate types

## Further reading

- [LWN: A deep dive into CMA](https://lwn.net/Articles/486301/) — design rationale and the long review process before CMA merged in v3.5 (2012)
- [LWN: Contiguous memory allocation for drivers](https://lwn.net/Articles/396657/) — the early CMA proposal that motivated the final design (2010)
- [LWN: CMA and compaction](https://lwn.net/Articles/684611/) — interaction between CMA migration and memory compaction (2016)
- [`Documentation/admin-guide/mm/dma-api-howto.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/admin-guide/mm/dma-api-howto.rst) — kernel documentation covering how drivers should allocate DMA memory including CMA-backed paths
- [`mm/cma.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/cma.c) — core CMA allocator: bitmap management, `cma_alloc()`, and `cma_release()`
- [`kernel/dma/contiguous.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/dma/contiguous.c) — the bridge between `dma_alloc_coherent()` and `cma_alloc()`
- [DMA Memory Allocation](dma.md) — the DMA API that drivers use to reach CMA transparently
- [contiguous-memory](contiguous-memory.md) — the fragmentation problem that CMA was designed to solve
- [memory-reservation](memory-reservation.md) — how CMA regions are carved out of physical memory at boot via memblock
