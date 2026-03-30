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
/* drivers/iommu/dma-iommu.c */
static dma_addr_t iommu_dma_map_page(struct device *dev, struct page *page,
                                      unsigned long offset, size_t size,
                                      enum dma_data_direction dir,
                                      unsigned long attrs)
{
    struct iommu_domain *domain = iommu_get_dma_domain(dev);
    struct iommu_dma_cookie *cookie = domain->iova_cookie;
    struct iova_domain *iovad = &cookie->iovad;

    /* Allocate an IOVA (I/O virtual address range) */
    dma_addr_t iova = iommu_dma_alloc_iova(domain, size, dma_get_mask(dev), dev);
    if (!iova)
        return DMA_MAPPING_ERROR;

    /* Create IOMMU page table entry: IOVA → physical page */
    phys_addr_t phys = page_to_phys(page) + offset;
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
/* kernel/dma/swiotlb.c */
phys_addr_t swiotlb_tbl_map_single(struct device *dev,
                                     phys_addr_t orig_addr,
                                     size_t mapping_size,
                                     size_t alloc_size,
                                     unsigned int alloc_align_mask,
                                     enum dma_data_direction dir,
                                     unsigned long attrs)
{
    struct io_tlb_mem *mem = dev->dma_io_tlb_mem;
    /* Find a free slot in the swiotlb pool */
    index = find_slots(dev, mem, orig_addr, alloc_size, alloc_align_mask);
    tlb_addr = slot_addr(mem->start, index);

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
echo 1 > /sys/kernel/debug/dma-api/disabled  # re-enable
cat /sys/kernel/debug/dma-api/error_count
cat /sys/kernel/debug/dma-api/dump

# Tracepoints: DMA map/unmap
echo 1 > /sys/kernel/tracing/events/dma_fence/enable
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

- [IOMMU Architecture](iommu-arch.md) — IOMMU hardware and domains
- [Memory Management: DMA zones](../mm/dma.md) — DMA zone in the buddy allocator
- [Memory Management: Device Coherency](../mm/device-coherency.md) — cache coherency
- [Device Drivers: platform driver](../drivers/platform-driver.md) — devm_request_mem_region
- `include/linux/dma-mapping.h` — DMA API declarations
- `Documentation/core-api/dma-api.rst` — full DMA API reference
