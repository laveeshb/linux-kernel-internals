# DMA API

> Programming devices for memory access: coherent and streaming DMA

## Why a DMA API?

DMA programming is architecture-dependent:
- x86 with IOMMU: allocate IOVA, program device with IOVA
- x86 without IOMMU: device uses physical addresses directly
- ARM with non-coherent cache: must flush/invalidate cache around DMA
- 32-bit DMA-capable device on 64-bit system: addresses must be < 4GB

The DMA API abstracts all of this. Device drivers use one API regardless of architecture, IOMMU presence, or device addressing limitations.

## Setting up a device for DMA

Before using DMA, a driver declares the device's addressing capability:

```c
/* Set the DMA mask: device can address 64-bit addresses */
if (dma_set_mask_and_coherent(dev, DMA_BIT_MASK(64))) {
    /* Fall back to 32-bit if 64-bit not supported */
    if (dma_set_mask_and_coherent(dev, DMA_BIT_MASK(32))) {
        dev_err(dev, "No suitable DMA mask\n");
        return -ENODEV;
    }
}
```

`DMA_BIT_MASK(n)` creates a mask of `n` bits. Setting a 32-bit mask means the device cannot DMA above 4GB — the kernel must ensure DMA buffers are allocated below 4GB.

## Coherent DMA

Coherent (or "consistent") DMA allocates memory that is both CPU-accessible and device-accessible without explicit cache management. The CPU and device always see the same data.

```c
/* Allocate coherent DMA buffer */
dma_addr_t dma_handle;
void *cpu_addr = dma_alloc_coherent(dev,
                                     size,         /* bytes */
                                     &dma_handle,  /* device-visible address */
                                     GFP_KERNEL);
if (!cpu_addr)
    return -ENOMEM;

/* cpu_addr: CPU-side virtual address */
/* dma_handle: address to program into device registers */
device_set_dma_addr(dev, dma_handle);

/* Use the buffer (no cache management needed) */
memset(cpu_addr, 0, size);
/* Device can read this immediately */

/* Free when done */
dma_free_coherent(dev, size, cpu_addr, dma_handle);
```

**How it works under the hood:**
- x86 with cache-coherent bus: `dma_alloc_coherent` → `alloc_pages` + IOMMU mapping
- ARM non-coherent: `dma_alloc_coherent` → `alloc_pages` + mark as uncached (`pgprot_noncached`)
- No IOMMU: `dma_alloc_coherent` → `alloc_pages` restricted to DMA zone (< 4GB if 32-bit mask)

## Streaming DMA (map/unmap)

Streaming DMA is for existing buffers that are transferred once. The CPU writes data, hands it to the device, then takes it back.

### Single buffer

```c
/* DMA direction: */
/* DMA_TO_DEVICE:     CPU → device (write DMA) */
/* DMA_FROM_DEVICE:   device → CPU (read DMA)  */
/* DMA_BIDIRECTIONAL: both */

/* Map before transfer */
dma_addr_t dma_handle = dma_map_single(dev,
                                        cpu_addr,      /* kernel virtual address */
                                        size,
                                        DMA_TO_DEVICE);
if (dma_mapping_error(dev, dma_handle)) {
    dev_err(dev, "DMA mapping failed\n");
    return -ENOMEM;
}

/* Program the device with dma_handle */
device_write(dev, dma_handle, size);

/* Wait for DMA to complete (device signals via interrupt) */
wait_for_completion(&transfer_done);

/* Unmap after transfer */
dma_unmap_single(dev, dma_handle, size, DMA_TO_DEVICE);

/* Now CPU can read/modify the buffer again */
```

**What happens at map/unmap:**
- With IOMMU: allocate IOVA, create IOMMU mapping
- Without IOMMU, coherent cache: mapping is a no-op (physical == device address)
- Without IOMMU, non-coherent cache: `map` flushes CPU cache; `unmap` invalidates CPU cache

### Scatter-gather

Real I/O often involves discontiguous memory (e.g., page-aligned skb fragments, bio pages):

```c
#include <linux/dma-mapping.h>
#include <linux/scatterlist.h>

struct scatterlist sg[4];
sg_init_table(sg, 4);
sg_set_page(&sg[0], page0, PAGE_SIZE, 0);
sg_set_page(&sg[1], page1, PAGE_SIZE, 0);
sg_set_page(&sg[2], page2, 512,       0);

/* Map all entries at once */
int nents = dma_map_sg(dev, sg, 3, DMA_TO_DEVICE);
if (!nents) {
    /* mapping failed */
    return -ENOMEM;
}

/* Program device: iterate mapped entries */
for_each_sg(sg, s, nents, i) {
    dma_addr_t addr = sg_dma_address(s);
    unsigned int len = sg_dma_len(s);
    device_add_descriptor(dev, addr, len);
}

/* Wait for completion, then unmap */
dma_unmap_sg(dev, sg, 3, DMA_TO_DEVICE);
```

With an IOMMU, `dma_map_sg` can coalesce adjacent pages into a single IOVA range — the device sees one contiguous buffer even though physical memory is fragmented.

## IOVA allocation

With an IOMMU, each streaming DMA map requires an IOVA allocation:

```c
/* drivers/iommu/dma-iommu.c — current signature takes a phys_addr_t directly,
 * not a struct page + offset pair (older kernels used the page+offset form) */
dma_addr_t iommu_dma_map_phys(struct device *dev, phys_addr_t phys, size_t size,
                               enum dma_data_direction dir, unsigned long attrs)
{
    bool coherent = dev_is_dma_coherent(dev);
    int prot = dma_info_to_prot(dir, coherent, attrs);
    struct iommu_domain *domain = iommu_get_dma_domain(dev);
    struct iommu_dma_cookie *cookie = domain->iova_cookie;
    struct iova_domain *iovad = &cookie->iovad;
    dma_addr_t iova, dma_mask = dma_get_mask(dev);

    /* If the buffer needs bouncing (unaligned for the device), swiotlb
     * handles that here before IOVA allocation */
    if (dev_use_swiotlb(dev, size, dir) && iova_unaligned(iovad, phys, size)) {
        phys = iommu_dma_map_swiotlb(dev, phys, size, dir, attrs);
        if (phys == (phys_addr_t)DMA_MAPPING_ERROR)
            return DMA_MAPPING_ERROR;
    }

    /* Allocate an IOVA (I/O virtual address range) and map it to phys */
    iova = iommu_dma_alloc_iova(domain, size, dma_mask, dev);
    if (!iova)
        return DMA_MAPPING_ERROR;
    if (iommu_map(domain, iova, phys, size, prot, GFP_ATOMIC)) {
        iommu_dma_free_iova(cookie, iova, size, NULL);
        return DMA_MAPPING_ERROR;
    }

    return iova;
}
```

The IOVA allocator uses a red-black tree of free ranges and a cached allocator for same-size allocations.

## swiotlb: bounce buffers

When a device cannot address certain memory (e.g., 32-bit device, memory > 4GB), the kernel must **bounce** DMA through a buffer in addressable memory:

```
Bounce buffer mechanism:
  1. Device needs to DMA to high memory (> 4GB, but device is 32-bit)
  2. swiotlb allocates a buffer in low memory (< 4GB)
  3. For writes (DMA_TO_DEVICE):  CPU copies data to bounce buffer first
  4. Device DMAs from bounce buffer
  5. For reads (DMA_FROM_DEVICE): Device DMAs to bounce buffer, then CPU copies out

  High memory buffer ──[CPU copy]──► bounce buffer ──[DMA]──► device
```

```c
/* kernel/dma/swiotlb.c — simplified; real function has no separate
 * alloc_size parameter (it's derived from mapping_size + alignment
 * padding) and slots are tracked per struct io_tlb_pool, since a
 * system can have more than one swiotlb pool (CONFIG_SWIOTLB_DYNAMIC) */
phys_addr_t swiotlb_tbl_map_single(struct device *dev,
                                     phys_addr_t orig_addr,
                                     size_t mapping_size,
                                     unsigned int alloc_align_mask,
                                     enum dma_data_direction dir,
                                     unsigned long attrs)
{
    unsigned int offset = swiotlb_align_offset(dev, alloc_align_mask, orig_addr);
    size_t size = ALIGN(mapping_size + offset, alloc_align_mask + 1);
    struct io_tlb_pool *pool;
    int index;
    phys_addr_t tlb_addr;

    /* Find a free slot, in whichever pool has room */
    index = swiotlb_find_slots(dev, orig_addr, size, alloc_align_mask, &pool);
    tlb_addr = slot_addr(pool->start, index);

    /* Copy data to bounce buffer for DMA_TO_DEVICE */
    if (!(attrs & DMA_ATTR_SKIP_CPU_SYNC) &&
        (dir == DMA_TO_DEVICE || dir == DMA_BIDIRECTIONAL))
        swiotlb_bounce(dev, tlb_addr, mapping_size, DMA_TO_DEVICE);

    return tlb_addr;
}
```

```bash
# swiotlb pool size (set at boot with swiotlb= parameter)
dmesg | grep "software IO TLB"
# software IO TLB: mapped [mem 0x...] (64MB)

# swiotlb usage
cat /sys/kernel/debug/swiotlb/io_tlb_nslabs    # total slots
cat /sys/kernel/debug/swiotlb/io_tlb_used      # currently used
```

## DMA pools

For small, frequently allocated DMA buffers (e.g., descriptor rings), use a DMA pool to avoid fragmentation:

```c
#include <linux/dmapool.h>

/* Create a pool of 64-byte DMA-coherent buffers, 64-byte aligned */
struct dma_pool *pool = dma_pool_create("my_descriptors", dev,
                                         64,   /* size */
                                         64,   /* alignment */
                                         0);   /* boundary (0 = no boundary) */

/* Allocate from pool */
dma_addr_t dma_handle;
void *vaddr = dma_pool_alloc(pool, GFP_KERNEL, &dma_handle);

/* Use the descriptor */
setup_descriptor(vaddr, dma_handle);

/* Return to pool */
dma_pool_free(pool, vaddr, dma_handle);

/* Destroy pool (frees all underlying coherent memory) */
dma_pool_destroy(pool);
```

## Observing DMA

```bash
# DMA memory zones (for no-IOMMU systems)
cat /proc/zoneinfo | grep -A5 "Node 0, zone  DMA"

# IOVA allocator statistics
cat /sys/kernel/debug/iommu/iova

# Check if swiotlb is in use (active remapping)
cat /sys/kernel/debug/swiotlb/io_tlb_used

# DMA API debugging (catch unmapped accesses, misuse)
# Requires CONFIG_DMA_API_DEBUG=y in kernel config
echo 0 > /sys/kernel/debug/dma-api/disabled  # re-enable (1=disable, 0=enable)
cat /sys/kernel/debug/dma-api/error_count
cat /sys/kernel/debug/dma-api/dump

# Tracepoints: DMA map/unmap
echo 1 > /sys/kernel/tracing/events/dma/enable
```

## Device tree DMA binding (ARM/embedded)

On ARM SoCs, device tree specifies DMA capabilities:

```dts
/* Device tree source */
dma-controller@40400000 {
    compatible = "arm,pl330";
    reg = <0x40400000 0x1000>;
    #dma-cells = <1>;
};

ethernet@e0100000 {
    compatible = "cdns,macb";
    reg = <0xe0100000 0x1000>;
    dmas = <&dma_controller 0>,   /* TX DMA channel */
           <&dma_controller 1>;   /* RX DMA channel */
    dma-names = "tx", "rx";
};
```

```c
/* Driver: request DMA channels from device tree */
priv->dma_tx = dma_request_chan(dev, "tx");
priv->dma_rx = dma_request_chan(dev, "rx");
```

## Further reading

### Kernel source

- [include/linux/dma-mapping.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/dma-mapping.h) — `dma_map_single()`, `dma_alloc_coherent()`, `dma_mapping_error()`, `dma_set_mask_and_coherent()`: the API declarations used throughout this page
- [kernel/dma/mapping.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/dma/mapping.c) — `dma_map_sg_attrs()`, `dma_alloc_attrs()`: the core implementation that dispatches to the platform's `dma_map_ops`
- [kernel/dma/swiotlb.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/dma/swiotlb.c) — `swiotlb_tbl_map_single()`, `swiotlb_find_slots()`: the real bounce-buffer implementation
- [drivers/iommu/dma-iommu.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/iommu/dma-iommu.c) — `iommu_dma_map_phys()`: the current IOMMU-backed streaming-DMA mapping function
- [mm/dmapool.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/dmapool.c) — `dma_pool_create_node()`, `dma_pool_alloc()`, `dma_pool_free()`: the DMA pool allocator behind `dma_pool_create()`
- [Documentation/core-api/dma-api-howto.rst](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/core-api/dma-api-howto.rst) — the kernel's own practical guide to when to use coherent vs. streaming mappings

### Related pages

- [IOMMU Architecture](iommu-arch.md) — `iommu_domain`, IOTLB, and the hardware DMA remapping this API relies on when an IOMMU is present
- [IOVA Allocator](iova-allocator.md) — the rbtree/rcache allocator behind every IOMMU-backed `dma_map_single()`/`dma_map_sg()` call
- [IOMMU War Stories](war-stories.md) — a real incident where per-packet `dma_map_single()` calls became a CPU bottleneck, fixed by batching with `dma_map_sg()`
- [Memory Management: DMA](../mm/dma.md) — a companion deep-dive on the same API, covering `dma_sync_*`, DMA zones, and swiotlb internals in more depth
- [Memory Management: Device Coherency](../mm/device-coherency.md) — the cache-coherency rules that govern when `dma_map_single()`/`dma_sync_*` actually need to do anything
- [Device Drivers: PCI driver](../drivers/pci-driver.md) — `dma_alloc_coherent()`/`dma_map_single()` used in a real PCI network driver

### LWN articles

- [The trouble with 64-bit DMA](https://lwn.net/Articles/904210/) — Jonathan Corbet, August 11, 2022: why the IOMMU layer conservatively picks IOVAs below 4GB even for 64-bit-capable devices, and what went wrong when Robin Murphy tried to relax it — background for the `DMA_BIT_MASK()`/`dma_set_mask_and_coherent()` masks used in this page's setup section
- [Noncoherent DMA mappings](https://lwn.net/Articles/855328/) — Jonathan Corbet, May 7, 2021: the `dma_alloc_noncontiguous()` API and manual cache synchronization (`dma_sync_sgtable_for_device()`/`_for_cpu()`) for non-cache-coherent architectures — background for this page's coherent-vs-streaming distinction
- [Restricted DMA](https://lwn.net/Articles/841916/) — Jonathan Corbet, January 7, 2021: Claire Chang's per-device restricted SWIOTLB pools, used to isolate untrusted devices without a full IOMMU — background for the swiotlb bounce-buffer mechanism described on this page
