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

### Fragmentation
When free memory exists but isn't usable because it's broken into small, non-contiguous pieces.

**External fragmentation**: Free pages scattered throughout memory.
**Internal fragmentation**: Allocated more than needed (asked for 5KB, got 8KB).

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
Pages larger than the default 4KB (typically 2MB or 1GB). Reduce TLB pressure for large allocations but increase internal fragmentation.

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
Power of 2 indicating allocation size. Order 0 = 1 page (4KB), Order 1 = 2 pages (8KB), Order 2 = 4 pages (16KB), etc.

---

## P

### Page
The basic unit of memory management. Typically 4KB on x86. The smallest unit the MMU can map.

### Page Table
Data structure mapping virtual addresses to physical addresses. Multi-level (PGD → PUD → PMD → PTE on x86-64) to save space.

### Physical Address
Actual location in RAM hardware. What the memory controller sees.

---

## R

### RBTree (Red-Black Tree)
Self-balancing binary search tree. Used in vmalloc for O(log n) address lookup. Better than linked lists for large datasets.

---

## S

### Slab Allocator
Carves pages into fixed-size object caches. Avoids internal fragmentation for small objects. SLUB is the current default implementation.

### SLUB
Current default slab allocator (since v2.6.22). Simpler than original SLAB, lower overhead, better NUMA support.

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
Division of physical memory by characteristics:
- **ZONE_DMA**: Memory accessible by old 16-bit DMA (first 16MB)
- **ZONE_NORMAL**: Regular memory
- **ZONE_HIGHMEM**: Memory above ~896MB on 32-bit (not directly mapped)

---

## See Also

- [overview](overview.md) - Start here for the big picture
- [vmalloc](vmalloc.md) - Virtual memory allocation
- [vrealloc](vrealloc.md) - Resizing allocations
