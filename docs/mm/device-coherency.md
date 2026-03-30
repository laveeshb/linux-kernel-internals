# Device Memory Coherency and Cache Management

> CPUs cache aggressively; DMA devices do not. Bridging that gap correctly is the difference between a working driver and one that corrupts data silently.

## The Cache Coherency Problem

Modern CPUs do not access RAM on every load and store. Instead, they fill cache lines from RAM and operate on those cached copies. Writes may sit in L1 or L2 cache for microseconds before being flushed to RAM. This is invisible to software running purely on the CPU — two cores share the same physical memory and their caches snoop each other.

DMA-capable devices break this assumption. A device performing DMA reads and writes RAM directly, bypassing the CPU caches entirely. Two failure modes result:

**CPU writes, device reads stale data (DMA transmit bug)**

```
1. CPU writes packet data to buffer[0..N]      → data in CPU cache, NOT yet in RAM
2. Driver programs NIC: "send buffer at phys X"
3. NIC reads physical address X from RAM        → reads STALE data (pre-write content)
4. Packet sent with wrong content
```

**Device writes, CPU reads stale data (DMA receive bug)**

```
1. Driver programs NIC: "DMA receive to buffer at phys X"
2. NIC writes received packet to RAM at phys X
3. CPU reads buffer[0..N]                       → reads STALE cache line (old content)
4. Driver processes garbage data
```

These bugs are intermittent, load-dependent, and architecture-specific. On x86 they are invisible. On non-coherent ARM they cause real corruption.

## Coherent vs Non-Coherent Systems

Whether hardware enforces coherency between CPU caches and DMA devices depends on the platform's memory interconnect.

### x86: Hardware-Enforced Coherency

On x86, PCIe DMA transactions snoop the CPU caches. When a device reads from a physical address, the CPU cache controller intercepts the transaction and supplies the most recent data — even if it has not yet been written back to RAM. When a device writes, the corresponding CPU cache lines are invalidated automatically.

The result: on x86, software never needs to flush or invalidate CPU caches for DMA correctness. `dma_map_single()` and `dma_sync_*` functions are no-ops at the cache level on x86.

### ARM64: Optional Coherency

ARM64 coherency depends on the System-on-Chip design:

- **Coherent interconnect (CCI, CMN)**: devices attached via a coherent interconnect participate in cache snooping. Most server-class ARM64 platforms (Ampere, Neoverse, ThunderX) and recent mobile SoCs fall here. DMA operations are coherent.
- **Non-coherent devices**: devices attached to a non-coherent interconnect or behind a simple bus bridge. The software must explicitly clean and invalidate CPU caches to match device ownership.

Whether a device is coherent is recorded in the device tree or ACPI tables and surfaced through `dev->dma_coherent`. The kernel checks this flag — set by `arch_setup_dma_ops()` in [`arch/arm64/mm/dma-mapping.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm64/mm/dma-mapping.c) — to decide whether to perform cache maintenance.

```
Coherent platform (x86, coherent ARM64):
  CPU cache ←→ Memory controller ←→ RAM
                      ↑ snoop
                   PCIe device

Non-coherent platform (some ARM64 SoCs):
  CPU cache           RAM
       ↑               ↑
       |       (separate paths, no snooping)
  CPU core         DMA device
```

### Key Source Files

| File | Purpose |
|------|---------|
| [`include/linux/dma-mapping.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/dma-mapping.h) | Public DMA API: `dma_alloc_coherent()`, `dma_map_single()`, `dma_sync_*()` |
| [`include/linux/dma-direction.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/dma-direction.h) | `enum dma_data_direction` values |
| [`kernel/dma/direct.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/dma/direct.h) | Non-IOMMU DMA path: calls `arch_sync_dma_for_device()` / `arch_sync_dma_for_cpu()` |
| [`arch/arm64/mm/dma-mapping.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm64/mm/dma-mapping.c) | ARM64 `arch_sync_dma_for_device()` → `dcache_clean_poc()` |
| [`arch/arm64/include/asm/cacheflush.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm64/include/asm/cacheflush.h) | ARM64 cache ops: `dcache_clean_poc()`, `dcache_inval_poc()`, `dcache_clean_inval_poc()` |
| [`arch/x86/mm/ioremap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/ioremap.c) | `ioremap()`, `ioremap_wc()`, `ioremap_uc()` implementations |
| [`arch/x86/mm/pat/memtype.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/pat/memtype.c) | PAT memory type management: WB, WC, UC-, WT |

## DMA Coherent Allocation

`dma_alloc_coherent()` allocates a buffer that is guaranteed coherent between the CPU and the device for its entire lifetime. No cache flushes are ever needed when accessing it.

```c
void *dma_alloc_coherent(struct device *dev, size_t size,
                         dma_addr_t *dma_handle, gfp_t gfp);

void dma_free_coherent(struct device *dev, size_t size,
                       void *cpu_addr, dma_addr_t dma_handle);
```

`dma_alloc_coherent()` returns two values: a CPU virtual address (the return value) and a device DMA address written into `*dma_handle`. The CPU address is used for normal memory accesses; the DMA address is programmed into the device's descriptor ring or DMA register.

From [`include/linux/dma-mapping.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/dma-mapping.h):

```c
static inline void *dma_alloc_coherent(struct device *dev, size_t size,
        dma_addr_t *dma_handle, gfp_t gfp)
{
    return dma_alloc_attrs(dev, size, dma_handle, gfp,
            (gfp & __GFP_NOWARN) ? DMA_ATTR_NO_WARN : 0);
}
```

**How coherency is achieved per architecture:**

- **x86**: allocates normal cacheable memory. Hardware coherency makes CPU cache flushes unnecessary.
- **Non-coherent ARM64**: allocates uncached memory (mapped with `pgprot_dmacoherent`). CPU accesses bypass the cache entirely, so there is never stale data — at the cost of slower CPU reads and writes.

**When to use coherent allocation:**

- Descriptor rings (NVMe submission/completion queues, network TX/RX rings)
- Command and status regions shared with firmware
- Small, long-lived control structures accessed frequently by both CPU and device

**When not to use it:**

Avoid `dma_alloc_coherent()` for large data buffers (packet payloads, disk read buffers) that the CPU will access heavily. On non-coherent systems, uncached memory access for large transfers is significantly slower than cached memory with explicit sync operations.

## DMA Streaming Mappings

Streaming mappings are used for buffers allocated by normal kernel means (`kmalloc`, `__get_free_pages`, `vmalloc` is **not** supported) that need to be temporarily handed to a device. Unlike coherent allocations, these buffers are normally cacheable; the DMA API performs cache maintenance only when needed.

### Ownership Model

Streaming mappings enforce a strict ownership model: **a buffer belongs either to the CPU or to the device — never both at the same time.**

```
CPU owns buffer → dma_map_single() → Device owns buffer
                                           ↓
                                    (device performs DMA)
                                           ↓
Device owns buffer → dma_unmap_single() → CPU owns buffer
```

While the device owns the buffer (between map and unmap), the CPU must not read or write it. Violating this rule causes corruption on non-coherent platforms.

### dma_map_single() / dma_unmap_single()

```c
/* Map a virtually contiguous buffer */
dma_addr_t dma_map_single(struct device *dev, void *ptr,
                          size_t size, enum dma_data_direction dir);

void dma_unmap_single(struct device *dev, dma_addr_t addr,
                      size_t size, enum dma_data_direction dir);
```

These are macros expanding to `dma_map_single_attrs()` / `dma_unmap_single_attrs()` with zero attributes. The `dir` argument controls which direction cache maintenance is applied:

- `DMA_TO_DEVICE` — CPU writes data, device reads it (transmit). On map: flush CPU cache to RAM so device sees the data. On unmap: no-op (device only read).
- `DMA_FROM_DEVICE` — device writes data, CPU reads it (receive). On map: invalidate CPU cache so the CPU cannot read stale data. On unmap: invalidate CPU cache again to expose what the device wrote.
- `DMA_BIDIRECTIONAL` — both directions; conservative. Performs both clean and invalidate.

```c
/* TX path: CPU filled the buffer, hand it to the device */
dma_addr_t dma_addr = dma_map_single(dev, skb->data, skb->len,
                                     DMA_TO_DEVICE);
if (dma_mapping_error(dev, dma_addr))
    goto drop;
/* Program device descriptor with dma_addr */
desc->addr = dma_addr;
desc->len  = skb->len;
kick_tx_queue(dev);

/* After device completes (TX completion interrupt): */
dma_unmap_single(dev, dma_addr, skb->len, DMA_TO_DEVICE);
dev_kfree_skb(skb);
```

!!! warning "Always check `dma_mapping_error()`"
    `dma_map_single()` can fail (IOMMU exhaustion, device address range overflow). Always check the return value with `dma_mapping_error(dev, addr)`. Using `DMA_MAPPING_ERROR` as a device address causes a hardware fault or silent corruption.

### dma_map_page()

```c
dma_addr_t dma_map_page(struct device *dev, struct page *page,
                        size_t offset, size_t size,
                        enum dma_data_direction dir);

void dma_unmap_page(struct device *dev, dma_addr_t addr,
                    size_t size, enum dma_data_direction dir);
```

Used when the buffer is described by a `struct page` rather than a virtual address. Common in network drivers receiving into page-based skb fragments.

### dma_map_sg() / dma_unmap_sg()

```c
unsigned int dma_map_sg(struct device *dev, struct scatterlist *sg,
                        int nents, enum dma_data_direction dir);

void dma_unmap_sg(struct device *dev, struct scatterlist *sg,
                  int nents, enum dma_data_direction dir);
```

Maps a scatter-gather list of physically discontiguous pages as a single DMA operation. The IOMMU maps them into a contiguous range of I/O virtual addresses. Without an IOMMU, the device must support scatter-gather natively.

`dma_map_sg()` returns the number of DMA segments — which may be fewer than `nents` if the IOMMU merged adjacent entries.

## dma_sync_*: Partial Ownership Transfers

Full unmap and remap on every access is expensive. `dma_sync_*` functions allow the CPU to temporarily reclaim ownership of a mapped buffer without unmapping it. This is the right pattern for high-performance descriptor rings.

```c
/* Defined in include/linux/dma-mapping.h */
void dma_sync_single_for_cpu(struct device *dev, dma_addr_t addr,
                             size_t size, enum dma_data_direction dir);

void dma_sync_single_for_device(struct device *dev, dma_addr_t addr,
                                size_t size, enum dma_data_direction dir);

void dma_sync_sg_for_cpu(struct device *dev, struct scatterlist *sg,
                         int nelems, enum dma_data_direction dir);

void dma_sync_sg_for_device(struct device *dev, struct scatterlist *sg,
                             int nelems, enum dma_data_direction dir);
```

### Ownership Protocol with sync

```
Initial state: CPU owns buffer

dma_map_single(DMA_FROM_DEVICE)   → Device owns buffer
   [device writes to buffer]
dma_sync_single_for_cpu(...)      → CPU temporarily owns buffer
   [CPU reads completed data]
dma_sync_single_for_device(...)   → Device owns buffer again
   [device writes next chunk]
...
dma_unmap_single(...)             → CPU owns buffer, mapping torn down
```

### RX Ring Pattern

A receive ring holds N pre-mapped buffers. The device writes into the current head; the driver reads completed entries from the tail.

```c
/* Setup: pre-map all RX buffers */
for (int i = 0; i < RING_SIZE; i++) {
    rx_ring[i].buf = kmalloc(BUF_SIZE, GFP_KERNEL);
    rx_ring[i].dma = dma_map_single(dev, rx_ring[i].buf,
                                    BUF_SIZE, DMA_FROM_DEVICE);
    /* Program buffer address into hardware descriptor */
    hw_ring[i].addr = rx_ring[i].dma;
}

/* Interrupt handler: device has written received data */
void rx_interrupt(struct device *dev)
{
    int idx = rx_tail;

    /* Transfer ownership back to CPU */
    dma_sync_single_for_cpu(dev, rx_ring[idx].dma,
                            BUF_SIZE, DMA_FROM_DEVICE);

    /* Safe to read the received data now */
    process_packet(rx_ring[idx].buf, hw_ring[idx].len);

    /* Replenish: give the buffer back to the device */
    dma_sync_single_for_device(dev, rx_ring[idx].dma,
                               BUF_SIZE, DMA_FROM_DEVICE);
    hw_ring[idx].addr = rx_ring[idx].dma;  /* re-arm descriptor */

    rx_tail = (rx_tail + 1) % RING_SIZE;
}
```

### Direction Values

From [`include/linux/dma-direction.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/dma-direction.h):

```c
enum dma_data_direction {
    DMA_BIDIRECTIONAL = 0,
    DMA_TO_DEVICE     = 1,  /* CPU → device: flush cache before DMA */
    DMA_FROM_DEVICE   = 2,  /* device → CPU: invalidate cache after DMA */
    DMA_NONE          = 3,  /* error sentinel, not a real direction */
};
```

## Cache Attributes and ioremap for MMIO

Device registers (MMIO) must never be accessed through a cached mapping. A CPU that caches a write to a control register may delay it indefinitely; a cached read may return a stale value rather than querying the device.

The `ioremap` family maps physical MMIO regions into the kernel's virtual address space with appropriate cache attributes. On x86, these mappings use the **PAT (Page Attribute Table)** to encode the memory type directly in the page table entry.

### ioremap Variants (x86)

From [`arch/x86/mm/ioremap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/ioremap.c):

```c
/* Standard uncached mapping (UC-minus: honors existing MTRRs) */
void __iomem *ioremap(resource_size_t phys_addr, unsigned long size);

/* Strongly uncached (UC: ignores MTRRs, truly uncached) */
void __iomem *ioremap_uc(resource_size_t phys_addr, unsigned long size);

/* Write-combining (WC: writes coalesced in write buffer before flush) */
void __iomem *ioremap_wc(resource_size_t phys_addr, unsigned long size);

/* Write-through (WT: writes go to both cache and memory) */
void __iomem *ioremap_wt(resource_size_t phys_addr, unsigned long size);

void iounmap(volatile void __iomem *addr);
```

**Which variant to use:**

| Variant | PAT Mode | Use Case |
|---------|----------|----------|
| `ioremap()` | UC-minus | Default for device registers; honors MTRR ranges |
| `ioremap_uc()` | UC | When you need strictly uncached access regardless of MTRR |
| `ioremap_wc()` | WC | Framebuffers, PCIe BAR for bulk data (GPU VRAM, NVMe doorbells) |
| `ioremap_wt()` | WT | Rare; use when reads must be cached but writes must be visible immediately |

Write-combining (`ioremap_wc`) is particularly important for framebuffers and other bulk write destinations. The CPU batches writes into a write-combining buffer and flushes them as a burst, dramatically reducing PCIe transactions compared to individual uncached writes.

### ioremap_np: Non-Posted Writes

```c
/* Non-posted writes: CPU waits for write completion acknowledgment */
void __iomem *ioremap_np(phys_addr_t offset, size_t size);
```

From [`include/asm-generic/io.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/asm-generic/io.h): `ioremap_np()` requests stricter non-posted write semantics — the CPU stalls until the device acknowledges the write. This guarantees ordering between a register write and subsequent reads. Not all architectures implement it; portable drivers should fall back to `ioremap()` if `ioremap_np()` returns `NULL`.

### PAT Memory Types on x86

x86 PAT supports four memory types relevant to MMIO (from [`arch/x86/mm/pat/memtype.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/pat/memtype.c)):

```
_PAGE_CACHE_MODE_WB       Write-back (normal RAM, cached)
_PAGE_CACHE_MODE_WC       Write-combining (framebuffers, PCIe bulk)
_PAGE_CACHE_MODE_UC_MINUS UC-minus (device registers, honors MTRRs)
_PAGE_CACHE_MODE_WT       Write-through
```

PAT encodes the memory type in bits of the page table entry (PWT, PCD, PAT bit). The kernel manages this through `ioremap_change_attr()`, which calls `_set_memory_uc()`, `_set_memory_wc()`, etc., to update the PTE and flush the TLB.

## ARM64 Cache Operations for DMA

On non-coherent ARM64 platforms, the DMA mapping layer performs explicit cache maintenance. The call chain for `dma_map_single()` on a non-coherent device, from [`kernel/dma/direct.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/dma/direct.h) and [`arch/arm64/mm/dma-mapping.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm64/mm/dma-mapping.c):

```
dma_map_single()
  └─ dma_map_single_attrs()
       └─ dma_map_page_attrs()
            └─ dma_direct_map_phys()       [kernel/dma/direct.h]
                 └─ if (!dev_is_dma_coherent(dev)):
                      arch_sync_dma_for_device(paddr, size, dir)
                        └─ dcache_clean_poc(start, start + size)
```

For the CPU-side sync on receive:

```
dma_sync_single_for_cpu()
  └─ __dma_sync_single_for_cpu()
       └─ dma_direct_sync_single_for_cpu()
            └─ if (!dev_is_dma_coherent(dev)):
                 arch_sync_dma_for_cpu(paddr, size, dir)
                   └─ if dir != DMA_TO_DEVICE:
                        dcache_inval_poc(start, start + size)
```

The ARM64 cache functions operate on ranges `[start, end)` to the **Point of Coherency (PoC)** — the level of the cache hierarchy shared by all observers, including DMA-capable devices:

From [`arch/arm64/include/asm/cacheflush.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm64/include/asm/cacheflush.h):

```c
/* Clean (write back dirty lines, keep valid) */
extern void dcache_clean_poc(unsigned long start, unsigned long end);

/* Invalidate (discard cache lines, force re-fetch from RAM) */
extern void dcache_inval_poc(unsigned long start, unsigned long end);

/* Clean + Invalidate (write back then discard) */
extern void dcache_clean_inval_poc(unsigned long start, unsigned long end);
```

**What each operation does in the DMA context:**

- `dcache_clean_poc`: used on `DMA_TO_DEVICE` — flushes CPU cache to RAM so the device reads the latest data.
- `dcache_inval_poc`: used on `DMA_FROM_DEVICE` — discards CPU cache lines so the CPU will re-fetch from RAM after the device has written.
- `dcache_clean_inval_poc`: used on `DMA_BIDIRECTIONAL` — combines both, used when the direction of data flow is unknown.

On coherent ARM64 platforms (where `dev->dma_coherent` is true), `arch_sync_dma_for_device()` and `arch_sync_dma_for_cpu()` are not called — the hardware handles it transparently, matching x86 behavior.

## The IOMMU and Coherency

The IOMMU translates device DMA addresses (I/O virtual addresses) into physical addresses. It enables address space isolation — a device can only access memory the kernel has explicitly mapped into its I/O page tables.

The IOMMU does **not** solve CPU cache coherency. It operates on the memory bus between the device and RAM, not between the CPU and RAM. On a non-coherent system, even with an IOMMU, the software must still perform cache maintenance through `dma_sync_*` or `dma_map_*` / `dma_unmap_*`.

The one exception: some IOMMUs on ARM SoCs are placed on the coherent interconnect side and can participate in snooping. In those cases, the device's coherency is determined by where in the interconnect hierarchy the device is placed, which is reflected in `dev->dma_coherent`.

For IOMMU address translation and memory protection, see [DMA Memory Allocation](dma.md).

## Common Bugs

!!! warning "Accessing a mapped buffer from the CPU"
    Calling `dma_map_single()` transfers ownership to the device. Any CPU read or write to that buffer before `dma_unmap_single()` (or `dma_sync_single_for_cpu()`) is undefined behavior. On coherent x86 the bug is invisible; on non-coherent ARM64 the CPU reads stale cache or the device reads stale RAM.

    ```c
    /* WRONG: CPU accesses buffer after mapping */
    dma_addr_t dma = dma_map_single(dev, buf, len, DMA_FROM_DEVICE);
    buf[0] = 0;                    /* undefined: device owns buf */
    submit_to_device(dev, dma);

    /* CORRECT: map after CPU is done writing */
    buf[0] = 0;
    dma_addr_t dma = dma_map_single(dev, buf, len, DMA_TO_DEVICE);
    submit_to_device(dev, dma);
    ```

!!! warning "Forgetting DMA_FROM_DEVICE sync before reading RX buffer"
    After a device fills an RX buffer, calling `dma_sync_single_for_cpu()` with `DMA_FROM_DEVICE` is required before reading it. Without this, on a non-coherent platform the CPU reads its own stale cache rather than what the device wrote.

    ```c
    /* WRONG on non-coherent ARM64: */
    /* Device has written packet data to rx_buf */
    process_packet(rx_buf, len);   /* reads stale cache */

    /* CORRECT: */
    dma_sync_single_for_cpu(dev, rx_dma, len, DMA_FROM_DEVICE);
    process_packet(rx_buf, len);   /* reads fresh data from RAM */
    ```

!!! warning "Using dma_alloc_coherent() for large streaming buffers"
    Coherent allocations on non-coherent ARM64 are backed by uncached memory. Reading or writing large amounts of data through an uncached mapping is slow — the CPU cannot use its write buffer or load multiple cache lines at once. For bulk data (packet payloads, DMA scatter lists), use `dma_map_single()` / `dma_map_sg()` with explicit sync instead.

!!! warning "Accessing MMIO through a cached mapping"
    Mapping device registers with `ioremap_cache()` (write-back) instead of `ioremap()` causes reads to return cached values and may delay writes indefinitely. Always use `ioremap()` or `ioremap_wc()` for MMIO regions. Never access a device register through a pointer obtained from `phys_to_virt()` — that mapping is write-back cached.

!!! warning "Ignoring dma_mapping_error()"
    `dma_map_single()` and `dma_map_sg()` can fail. The failure return is `DMA_MAPPING_ERROR` (~0ULL on 64-bit). Programming this value into a device DMA register will cause a device fault or access physical memory at the wrong address.

    ```c
    dma_addr_t addr = dma_map_single(dev, buf, len, DMA_TO_DEVICE);
    if (dma_mapping_error(dev, addr)) {
        /* handle error: drop packet, return error, etc. */
        return -ENOMEM;
    }
    ```
