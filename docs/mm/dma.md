# DMA Memory Allocation

> How the kernel allocates and manages memory for devices that access RAM directly

## What is DMA?

Direct Memory Access (DMA) lets hardware devices read and write system memory without involving the CPU for every byte transferred. A network card receiving packets, a disk controller fetching blocks, or a GPU reading textures -- all bypass the CPU and talk to RAM directly.

This is essential for performance. Without DMA, the CPU would spend its time copying bytes between device registers and memory instead of doing useful work. But DMA introduces a fundamental problem: **devices operate on physical addresses, not virtual ones**, and they may not be able to reach all of physical memory.

## Why DMA Needs Special Memory

Three constraints make DMA memory allocation different from normal `kmalloc()`:

1. **Physical address limitations**: Many devices can only address a subset of physical memory. An old ISA sound card can only reach the first 16MB. A 32-bit PCI card can only reach the first 4GB. If the kernel hands a device a buffer at physical address 8GB, the device simply cannot access it.

2. **Cache coherency**: The CPU uses caches (L1, L2, L3) between itself and RAM. When a device writes to RAM via DMA, the CPU cache may still hold stale data for that address. Conversely, if the CPU writes to cache but the data has not reached RAM yet, the device reads stale memory. The kernel must manage this explicitly.

3. **Contiguity requirements**: Devices see physical memory, not virtual. A buffer that looks contiguous in the kernel's virtual address space may be scattered across physical pages. Without hardware support (IOMMU), the device needs physically contiguous memory.

## DMA Zones

The kernel partitions physical memory into zones to handle device addressing limitations. From [`include/linux/mmzone.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mmzone.h):

```c
enum zone_type {
    ZONE_DMA,       /* First 16MB - ISA devices */
    ZONE_DMA32,     /* First 4GB - 32-bit PCI devices */
    ZONE_NORMAL,    /* All addressable memory */
    /* ... */
};
```

### ZONE_DMA (first 16MB)

A legacy zone for ISA bus devices. The ISA bus uses 24-bit addresses, limiting DMA to the first 2^24 = 16MB of RAM. Modern systems rarely need this, but the zone persists because some architectures still define it.

Allocated with `GFP_DMA`.

### ZONE_DMA32 (first 4GB)

For 32-bit PCI devices that use 32-bit DMA addresses. On a system with 64GB of RAM, these devices can only access the bottom 4GB. This is still relevant -- many embedded devices and older PCIe cards have 32-bit DMA masks.

Allocated with `GFP_DMA32`.

### ZONE_NORMAL

Memory accessible by the kernel and by devices with full addressing capability (64-bit DMA). No special constraints.

```
Physical Memory Layout (64-bit system with 64GB RAM):

0                16MB              4GB                              64GB
|--- ZONE_DMA ---|--- ZONE_DMA32 ---|------------ ZONE_NORMAL -----------|
     ISA only        32-bit PCI              Full addressing
    (GFP_DMA)       (GFP_DMA32)             (GFP_KERNEL)
```

The zone boundaries are architecture-specific. ARM64 initially had no `ZONE_DMA` at all, but commit [1a8e1cef7603](https://git.kernel.org/linus/1a8e1cef7603) ("arm64: use both ZONE_DMA and ZONE_DMA32") added it to handle devices that can only address the lowest 1GB of physical memory — a constraint that exists on some ARM SoCs and PCIe devices regardless of what the architecture spec allows.

## The DMA API

The kernel provides a unified DMA API that abstracts away the differences between architectures and IOMMUs. The API lives in [`include/linux/dma-mapping.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/dma-mapping.h) with the core implementation in [`kernel/dma/`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/dma).

### dma_alloc_coherent()

Allocates a buffer that is simultaneously accessible by the CPU and the device, with hardware-enforced coherency (no manual cache management needed).

```c
void *dma_alloc_coherent(struct device *dev, size_t size,
                         dma_addr_t *dma_handle, gfp_t gfp);
void dma_free_coherent(struct device *dev, size_t size,
                       void *cpu_addr, dma_addr_t dma_handle);
```

Returns two things: a CPU virtual address (the return value) and a device-visible DMA address (via `dma_handle`). The driver uses the CPU address; it programs the device with the DMA address.

**When to use**: Long-lived buffers shared between CPU and device -- descriptor rings, command queues, firmware communication areas. The coherency guarantee means neither side needs to flush or invalidate caches.

**Trade-off**: Coherent memory is often uncacheable on architectures without hardware cache coherency (e.g., some ARM SoCs). This makes CPU access slower. Do not use for large data buffers that the CPU will read/write intensively.

### dma_map_single()

Maps an existing kernel buffer for DMA access by a device. This is a "streaming" mapping -- it has a direction and a lifecycle.

```c
dma_addr_t dma_map_single(struct device *dev, void *cpu_addr,
                          size_t size, enum dma_data_direction dir);
void dma_unmap_single(struct device *dev, dma_addr_t dma_addr,
                      size_t size, enum dma_data_direction dir);
```

The direction tells the kernel which cache operations are needed:

| Direction | Meaning | Cache Operation |
|-----------|---------|-----------------|
| `DMA_TO_DEVICE` | CPU writes, device reads | Flush CPU caches before DMA |
| `DMA_FROM_DEVICE` | Device writes, CPU reads | Invalidate CPU caches after DMA |
| `DMA_BIDIRECTIONAL` | Both directions | Flush before, invalidate after |

**When to use**: Temporary transfers -- sending a network packet, submitting a disk I/O request. Map before the transfer, unmap when it completes.

### dma_map_sg()

Maps a scatter-gather list -- multiple non-contiguous memory regions -- for a single DMA operation. This is how the kernel handles I/O that spans multiple pages.

```c
int dma_map_sg(struct device *dev, struct scatterlist *sg,
               int nents, enum dma_data_direction dir);
void dma_unmap_sg(struct device *dev, struct scatterlist *sg,
                  int nents, enum dma_data_direction dir);
```

`dma_map_sg()` returns the number of DMA-mapped entries, which may be *fewer* than the input entries. With an IOMMU, the kernel can merge physically discontiguous pages into a single contiguous DMA region as seen by the device.

**When to use**: Block I/O, large network transfers, any case where data spans multiple pages. Most real device drivers use scatter-gather extensively.

## Coherent vs Streaming DMA Mappings

This is the central design decision in the DMA API:

| Property | Coherent | Streaming |
|----------|----------|-----------|
| **API** | `dma_alloc_coherent()` | `dma_map_single()`, `dma_map_sg()` |
| **Lifetime** | Long-lived (driver load to unload) | Per-transfer (map, DMA, unmap) |
| **Cache handling** | Automatic (hardware or uncached) | Manual (flush/invalidate at map/unmap) |
| **CPU access speed** | Potentially slow (uncached on some archs) | Normal (cached) |
| **Use case** | Descriptor rings, command queues | Data buffers, packets, disk blocks |

The key insight: **coherent mappings trade CPU performance for convenience, while streaming mappings trade convenience for CPU performance.** Most drivers use coherent mappings for small control structures and streaming mappings for data.

### Sync Operations

Between map and unmap, if the CPU needs to touch a streaming buffer, it must use sync operations:

```c
/* CPU wants to read a buffer the device has written */
dma_sync_single_for_cpu(dev, dma_handle, size, DMA_FROM_DEVICE);
/* ... CPU reads data ... */

/* Hand buffer back to device */
dma_sync_single_for_device(dev, dma_handle, size, DMA_FROM_DEVICE);
```

These ensure cache coherency at the point of the sync call. Without them, the CPU may read stale cached data.

## IOMMU

An Input/Output Memory Management Unit (IOMMU) sits between devices and physical memory, translating device-visible "I/O virtual addresses" (IOVAs) to physical addresses. It is essentially a page table for devices.

```
Without IOMMU:
  Device --[physical addr]--> RAM
  (device must use real physical addresses)

With IOMMU:
  Device --[IOVA]--> IOMMU --[physical addr]--> RAM
  (device uses virtual addresses, translated by hardware)
```

### What IOMMU enables

1. **Scatter-gather coalescing**: Map physically scattered pages as contiguous to the device. A 64KB buffer spanning 16 scattered pages appears as one contiguous 64KB region to the device.

2. **Device isolation**: A buggy or malicious device can only access memory regions explicitly mapped in its IOMMU page table. This is essential for secure device passthrough to virtual machines (VFIO).

3. **Addressing limitations solved**: A 32-bit device can access memory above 4GB because the IOMMU maps high physical pages into the device's 32-bit address window.

4. **DMA remapping**: Intel calls it VT-d, AMD calls it AMD-Vi. Both provide hardware IOMMU for PCIe devices.

The IOMMU driver in Linux lives under [`drivers/iommu/`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/iommu). The DMA API automatically uses the IOMMU when one is present -- drivers do not need to know or care.

### LWN coverage

LWN's coverage of DMA addressing, cache coherency, and device isolation:

- [The trouble with 64-bit DMA](https://lwn.net/Articles/904210/) (2022) -- DMA addressing masks, IOVAs, and how the IOMMU maps device addresses
- [Noncoherent DMA mappings](https://lwn.net/Articles/855328/) (2021) -- coherent vs. streaming mappings and cache-coherency management
- [Restricted DMA](https://lwn.net/Articles/841916/) (2021) -- using SWIOTLB bounce buffering to isolate untrusted devices on systems without an IOMMU

## SWIOTLB Bounce Buffers

When there is no IOMMU and a device cannot address all of physical memory, the kernel falls back to SWIOTLB (Software I/O Translation Lookaside Buffer) -- a bounce buffer mechanism.

### How it works

1. Kernel allocates a pool of low-memory bounce buffers at boot (typically 64MB from memory below 4GB)
2. When `dma_map_single()` is called for a buffer the device cannot reach, the kernel:
   - Allocates a bounce buffer from the SWIOTLB pool
   - For `DMA_TO_DEVICE`: copies data from the original buffer to the bounce buffer
   - Gives the device the bounce buffer's physical address
3. When `dma_unmap_single()` is called:
   - For `DMA_FROM_DEVICE`: copies data from bounce buffer back to the original buffer
   - Frees the bounce buffer

```
High Memory (>4GB):
+------------------+
| Original Buffer  |  <-- CPU uses this
+------------------+
        |  copy
        v
Low Memory (<4GB):
+------------------+
| Bounce Buffer    |  <-- Device DMAs here
| (SWIOTLB pool)  |
+------------------+
```

### The cost

Bounce buffering means **double the memory copies** -- a significant performance penalty. This is why IOMMUs are strongly preferred on modern systems.

The SWIOTLB pool size can be configured at boot with `swiotlb=N` (number of 2KB slots). The implementation lives in [`kernel/dma/swiotlb.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/dma/swiotlb.c).

### Confidential computing and SWIOTLB

SWIOTLB gained renewed importance with confidential computing (AMD SEV, Intel TDX). In these environments, device DMA cannot access encrypted guest memory directly. The guest must use decrypted bounce buffers for all DMA operations. Commit [0b84e4f8b793](https://git.kernel.org/linus/0b84e4f8b793) ("swiotlb: Add restricted DMA pool initialization") added support for restricted DMA pools to handle these scenarios.

## DMA Memory Pools

For drivers that frequently allocate and free small, fixed-size DMA-coherent buffers (like USB transfer descriptors or hardware command entries), the overhead of calling `dma_alloc_coherent()` each time is excessive. The DMA pool API solves this.

From [`include/linux/dmapool.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/dmapool.h):

```c
struct dma_pool *dma_pool_create(const char *name, struct device *dev,
                                  size_t size, size_t align, size_t boundary);
void dma_pool_destroy(struct dma_pool *pool);

void *dma_pool_alloc(struct dma_pool *pool, gfp_t gfp,
                     dma_addr_t *dma_handle);
void dma_pool_free(struct dma_pool *pool, void *vaddr,
                   dma_addr_t dma_handle);
```

The pool pre-allocates large coherent regions and carves them into fixed-size chunks -- the same idea as the slab allocator, but for DMA-coherent memory. The `boundary` parameter prevents allocations from crossing a specified power-of-two boundary, which some hardware requires.

The implementation lives in [`mm/dmapool.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/dmapool.c).

## Common Mistakes

### Forgetting to unmap

Every `dma_map_single()` must have a matching `dma_unmap_single()`. Every `dma_map_sg()` must have a matching `dma_unmap_sg()`. Leaked mappings exhaust IOMMU address space or SWIOTLB pool, eventually causing allocation failures.

Enable `CONFIG_DMA_API_DEBUG` to catch this. It tracks all mappings and warns on driver unload if any remain:

```bash
# Boot with DMA API debugging
echo 1 > /sys/kernel/debug/dma-api/enable
```

### Using wrong GFP flags

Do not use `GFP_DMA` unless you actually need memory in ZONE_DMA (first 16MB). Most modern devices with 32-bit DMA limitations need `GFP_DMA32` instead. But ideally, use the DMA API and let it handle zone selection:

```c
/* Wrong: manually allocating from DMA zone */
buf = kmalloc(4096, GFP_KERNEL | GFP_DMA);
dma_handle = virt_to_phys(buf); /* BROKEN: skips IOMMU! */

/* Right: let the DMA API handle it */
buf = dma_alloc_coherent(dev, 4096, &dma_handle, GFP_KERNEL);
```

The DMA API consults the device's DMA mask to determine the correct zone automatically.

### Cache coherency bugs

On architectures without hardware-managed coherency, accessing a streaming DMA buffer without proper sync operations causes data corruption. This often manifests as intermittent failures that are extremely difficult to reproduce:

```c
/* BUG: reading device data without sync */
dma_handle = dma_map_single(dev, buf, len, DMA_FROM_DEVICE);
start_device_dma(dev, dma_handle, len);
wait_for_dma_complete(dev);
memcpy(dest, buf, len);  /* May read stale cached data! */
dma_unmap_single(dev, dma_handle, len, DMA_FROM_DEVICE);

/* CORRECT: unmap (which syncs) before reading */
dma_handle = dma_map_single(dev, buf, len, DMA_FROM_DEVICE);
start_device_dma(dev, dma_handle, len);
wait_for_dma_complete(dev);
dma_unmap_single(dev, dma_handle, len, DMA_FROM_DEVICE);
memcpy(dest, buf, len);  /* Safe: unmap invalidated cache */
```

### Using virt_to_phys() for DMA

Never convert a virtual address to physical and hand it to a device. This bypasses the IOMMU, skips bounce buffering, and ignores the device's DMA mask. Always use the DMA API.

### DMA to stack or module memory

Stack memory and module text may reside in vmalloc space, which is not guaranteed to be physically contiguous or DMA-addressable. Always use `kmalloc()` or `dma_alloc_coherent()` for DMA buffers.

## Try It Yourself

### Check DMA zone sizes

```bash
# View zone information
cat /proc/zoneinfo | grep -E "^Node|pages free|managed|zone"

# Compact view of zones
cat /proc/buddyinfo
# Example output:
# Node 0, zone      DMA      1    1    0    0    2    1    1    0    1    1    3
# Node 0, zone    DMA32   2907 2312  975  574  256   94   40   16    6    5  252
# Node 0, zone   Normal  19374 7834 5327 2581  784  168   30    5    0    0    0
```

### Inspect IOMMU state

```bash
# Check if IOMMU is active
dmesg | grep -i iommu

# View IOMMU groups (each group shares address space isolation)
ls /sys/kernel/iommu_groups/
# Each group directory contains a devices/ subdirectory listing PCI devices

# Check a specific device's DMA mask
# (from within a kernel module or via debugfs)
cat /sys/bus/pci/devices/0000:03:00.0/dma_mask_bits
```

### Monitor SWIOTLB usage

```bash
# Check SWIOTLB pool size and usage
cat /sys/kernel/debug/swiotlb/io_tlb_nslabs  2>/dev/null
cat /sys/kernel/debug/swiotlb/io_tlb_used    2>/dev/null

# Or from dmesg at boot
dmesg | grep -i swiotlb
# Example: "software IO TLB: mapped [mem 0x00000000b3c00000-0x00000000b7c00000] (64MB)"
```

### Enable DMA API debug checking

```bash
# Build kernel with CONFIG_DMA_API_DEBUG=y
# Then at boot or runtime:
echo 1 > /sys/kernel/debug/dma-api/enable

# View DMA API debug statistics
cat /sys/kernel/debug/dma-api/num_errors
cat /sys/kernel/debug/dma-api/num_free_entries
cat /sys/kernel/debug/dma-api/min_free_entries
```

### View DMA pool statistics

```bash
# DMA pool info per device
cat /sys/kernel/debug/dma_pools 2>/dev/null

# Or from sysfs (depends on kernel config)
find /sys/kernel/debug/ -name "*dma*" 2>/dev/null
```

## Key Source Files

| File | Description |
|------|-------------|
| [`kernel/dma/mapping.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/dma/mapping.c) | Core DMA mapping implementation |
| [`kernel/dma/direct.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/dma/direct.c) | Direct DMA (no IOMMU) implementation |
| [`kernel/dma/swiotlb.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/dma/swiotlb.c) | SWIOTLB bounce buffer implementation |
| [`include/linux/dma-mapping.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/dma-mapping.h) | DMA API header |
| [`include/linux/dmapool.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/dmapool.h) | DMA pool API header |
| [`mm/dmapool.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/dmapool.c) | DMA pool implementation |
| [`drivers/iommu/`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/iommu) | IOMMU driver implementations |
| [`include/linux/mmzone.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mmzone.h) | Zone type definitions |

---

## References

### Further Reading

- [DMA API Guide](https://docs.kernel.org/core-api/dma-api.html) -- the authoritative kernel documentation on the DMA API
- [DMA API HOWTO](https://docs.kernel.org/core-api/dma-api-howto.html) -- practical guide for driver developers
- [Dynamic DMA mapping Guide](https://docs.kernel.org/core-api/dma-api-howto.html) -- when and how to use each mapping type
- [LWN: The trouble with 64-bit DMA](https://lwn.net/Articles/904210/) (2022) -- DMA addressing masks, IOVAs, and the IOMMU
- [LWN: Noncoherent DMA mappings](https://lwn.net/Articles/855328/) (2021) -- coherent vs. streaming mappings and cache coherency
- [LWN: Restricted DMA](https://lwn.net/Articles/841916/) (2021) -- SWIOTLB bounce buffering to isolate untrusted devices

### Related

- [Page Allocator](page-allocator.md) -- where DMA memory ultimately comes from
- [vmalloc](vmalloc.md) -- virtual memory allocation (not suitable for DMA)
- [NUMA](numa.md) -- NUMA-aware allocation and its interaction with DMA zones
- [Overview](overview.md) -- how DMA allocation fits in the memory management hierarchy

## Further reading

- [Kernel docs: DMA API](https://docs.kernel.org/core-api/dma-api.html) — the authoritative reference for every function in the DMA API
- [Kernel docs: DMA API HOWTO](https://docs.kernel.org/core-api/dma-api-howto.html) — practical guide covering when and how to use each mapping type
- [`Documentation/core-api/dma-api.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/core-api/dma-api.rst) — kernel source for the DMA API documentation
- [`kernel/dma/`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/dma) — the full DMA subsystem source directory: mapping, direct, swiotlb, pool
- [LWN: The trouble with 64-bit DMA](https://lwn.net/Articles/904210/) — DMA addressing masks, IOVAs, and how the IOMMU maps device addresses (2022)
- [LWN: Noncoherent DMA mappings](https://lwn.net/Articles/855328/) — coherent vs. streaming DMA mappings and cache-coherency management (2021)
- [LWN: Restricted DMA](https://lwn.net/Articles/841916/) — SWIOTLB bounce buffering to isolate untrusted devices without an IOMMU (2021)
- [Device Memory Coherency](device-coherency.md) — cache maintenance rules that govern every DMA mapping
- [CMA](cma.md) — how `dma_alloc_coherent()` sources physically contiguous memory via the Contiguous Memory Allocator
