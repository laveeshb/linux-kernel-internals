# Glossary

Terms you'll encounter in Linux memory management, explained for newcomers.

---

## A

### Address Space
The range of memory addresses a process can use. In virtual memory systems, each process has its own address space that maps to physical memory via page tables.

### Allocation
Requesting memory from the system. The kernel provides various allocators (kmalloc, vmalloc) for different use cases.

---

## B

### Buddy Allocator
The Linux page allocator. Groups physical pages into "buddies" of power-of-2 sizes. When you free pages, they merge with their buddy if also free.

**Example**: Two adjacent 4-page blocks can merge into one 8-page block.

---

## C

### Cache (CPU)
Fast memory between CPU and RAM. Holds recently accessed data. L1 is fastest/smallest, L3 is slowest/largest.

### Cache (Slab)
A pool of pre-allocated objects of the same type. Faster than allocating fresh memory each time.

### Contiguous
Adjacent in address space. "Physically contiguous" means adjacent in actual RAM. "Virtually contiguous" means adjacent in virtual addresses (but possibly scattered in physical RAM).

---

## D

### DMA (Direct Memory Access)
Hardware accessing memory directly without CPU involvement. DMA buffers need physical addresses, not virtual ones.

---

## F

### Folio
A modern abstraction (v5.16+) representing one or more contiguous pages. Replaces the ambiguous use of `struct page` for compound pages. A folio is always the head of a compound page or a single page.

```c
struct folio *folio = page_folio(page);
```

**Why it exists**: `struct page` was overloaded - it could be a single page, a tail page of a compound page, or a head page. Folios make the API clearer and enable future optimizations.

### Fragmentation
When free memory exists but isn't usable because it's broken into small, non-contiguous pieces.

**External fragmentation**: Free pages scattered throughout memory.
**Internal fragmentation**: Allocated more than needed (asked for `5KB`, got `8KB`).

---

## G

### GFP Flags (Get Free Pages)
Flags passed to allocation functions specifying behavior:
- `GFP_KERNEL`: Normal allocation, can sleep
- `GFP_ATOMIC`: Can't sleep (used in interrupts)
- `__GFP_ZERO`: Zero the memory before returning

---

## H

### Huge Pages
Pages larger than the default `4KB` (typically `2MB` or `1GB`). Reduce TLB pressure for large allocations but increase internal fragmentation.

---

## I

### IPI (Inter-Processor Interrupt)
Signal sent from one CPU to another. Used for TLB flushes - when one CPU changes page tables, others must be told to invalidate their TLB entries.

**Why it matters**: IPIs are expensive. Batching operations to reduce IPIs is a common optimization.

---

## K

### kmalloc
Kernel's general-purpose memory allocator. Returns physically contiguous memory. Fast for small allocations.

```c
void *ptr = kmalloc(size, GFP_KERNEL);
kfree(ptr);
```

### kvmalloc
Tries kmalloc first; if that fails (fragmentation), falls back to vmalloc. Best of both worlds.

---

## L

### Lazy (Deferred) Operations
Postponing work until necessary. Example: Lazy TLB flushing delays flush until addresses are reused, batching multiple operations.

---

## M

### memblock
Early boot memory allocator. Before the buddy allocator is initialized, the kernel uses memblock to track and allocate memory. It's simple (just tracks reserved and free regions) but sufficient for boot.

```bash
# View memblock regions (if debugfs enabled)
cat /sys/kernel/debug/memblock/memory
```

### memcg (Memory Cgroup)
Memory control group. Allows limiting and tracking memory usage per container or group of processes. Foundation of container memory limits.

### MMU (Memory Management Unit)
Hardware that translates virtual addresses to physical addresses using page tables. Every memory access goes through the MMU.

---

## N

### NUMA (Non-Uniform Memory Access)
Architecture where memory access time depends on which CPU is accessing which memory bank. Each CPU has "local" memory (fast) and "remote" memory (slower).

**Why it matters**: Allocators try to give you memory from your local node.

---

## O

### OOM (Out of Memory)
When the system runs out of memory. The OOM killer selects a process to terminate and free memory.

### Order (Page Order)
Power of 2 indicating allocation size. Order 0 = 1 page (`4KB`), Order 1 = 2 pages (`8KB`), Order 2 = 4 pages (`16KB`), etc.

---

## P

### Page
The basic unit of memory management. Typically `4KB` on x86. The smallest unit the MMU can map.

### Page Table
Data structure mapping virtual addresses to physical addresses. Multi-level (`PGD` -> `PUD` -> `PMD` -> `PTE` on x86-64) to save space.

### PFN (Page Frame Number)
Index of a physical page frame. If a page is at physical address `0x1234000` and page size is `4KB`, PFN = `0x1234000 / 4096 = 0x1234`.

```c
/* Convert between PFN and physical address */
pfn = phys_addr >> PAGE_SHIFT;
phys_addr = pfn << PAGE_SHIFT;

/* Convert between PFN and struct page */
struct page *page = pfn_to_page(pfn);
pfn = page_to_pfn(page);
```

### Physical Address
Actual location in RAM hardware. What the memory controller sees.

---

## R

### RBTree (Red-Black Tree)
Self-balancing binary search tree. Used in vmalloc for `O(log n)` address lookup. Better than linked lists for large datasets.

---

## S

### Slab Allocator
Carves pages into fixed-size object caches. Avoids internal fragmentation for small objects. SLUB is the current default implementation.

### SLUB
Current default slab allocator (since v2.6.22). Simpler than original SLAB, lower overhead, better NUMA support.

### struct page
The kernel's descriptor for a physical page frame. One `struct page` exists for every physical page in the system (stored in the `mem_map` array or vmemmap).

```c
struct page {
    unsigned long flags;        /* Page status flags (PG_locked, PG_dirty, etc.) */
    atomic_t _refcount;         /* Reference count */
    atomic_t _mapcount;         /* Number of page table mappings */
    struct address_space *mapping;  /* Owner (file, swap, anon) */
    pgoff_t index;              /* Offset within mapping */
    struct list_head lru;       /* LRU list for reclaim */
    /* ... many more fields via unions */
};
```

**Note**: Modern code should prefer `struct folio` for multi-page operations.

---

## T

### TLB (Translation Lookaside Buffer)
Cache for page table entries. Without TLB, every memory access would need multiple page table lookups. TLB makes virtual memory practical.

**TLB Miss**: Address not in TLB, must walk page tables. Expensive.
**TLB Flush**: Invalidate TLB entries. Required when page tables change.

---

## V

### Virtual Address
Address a process uses. Translated to physical address by MMU + page tables. Each process can have same virtual address mapping to different physical memory.

### vmalloc
Allocates virtually contiguous memory from potentially scattered physical pages. Slower than kmalloc but can satisfy large allocations.

```c
void *ptr = vmalloc(size);
vfree(ptr);
```

### vmap_area
Data structure tracking vmalloc address space. Stored in RBTree for fast lookup.

### vm_struct
Describes a vmalloc region: address, size, backing pages, flags.

### vrealloc
Resize a vmalloc allocation. Can shrink in-place (freeing pages) or grow (may need new allocation).

---

## Z

### Zone
Division of physical memory by hardware constraints. Zones vary by architecture:

**x86-64:**
- **`ZONE_DMA`**: First 16MB (legacy 16-bit DMA)
- **`ZONE_DMA32`**: 16MB - 4GB (32-bit DMA devices)
- **`ZONE_NORMAL`**: Above 4GB (regular allocations)

**32-bit x86:**
- **`ZONE_DMA`**: First 16MB
- **`ZONE_NORMAL`**: 16MB - ~896MB (directly mapped)
- **`ZONE_HIGHMEM`**: Above ~896MB (not directly mapped, requires kmap)

---

## See Also

- [overview](overview.md) - Start here for the big picture
- [vmalloc](vmalloc.md) - Virtual memory allocation
- [vrealloc](vrealloc.md) - Resizing allocations
