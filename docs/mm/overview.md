# Memory Management Overview

## The Big Picture

Linux manages two types of memory:

1. **Physical memory** - Actual RAM, divided into pages (usually 4KB)
2. **Virtual memory** - Address space seen by processes and kernel

The mm/ subsystem bridges these, providing:
- Allocation APIs for different use cases
- Page tables to translate virtual → physical
- Reclaim mechanisms when memory is tight

## Allocation Layers

```
┌─────────────────────────────────────────────┐
│           Kernel/Driver Code                │
├─────────────────────────────────────────────┤
│  kmalloc()     vmalloc()     alloc_pages()  │  ← APIs
├─────────────────────────────────────────────┤
│  SLUB/SLAB       vmalloc                    │  ← Allocators
├─────────────────────────────────────────────┤
│              Page Allocator                 │  ← Buddy system
├─────────────────────────────────────────────┤
│              Physical Memory                │
└─────────────────────────────────────────────┘
```

## When to Use What

| API | Use Case | Memory Type |
|-----|----------|-------------|
| `kmalloc()` | Small allocations (<page), needs physical contiguity | Physically contiguous |
| `vmalloc()` | Large allocations, physical contiguity not needed | Virtually contiguous |
| `alloc_pages()` | Direct page allocation, DMA buffers | Physical pages |
| `kvmalloc()` | Try kmalloc first, fall back to vmalloc | Either |

## Design Decisions

### Why separate allocators?

Physical contiguity is expensive. As the system runs, physical memory becomes fragmented. kmalloc requires physically contiguous pages, which gets harder to satisfy for large allocations.

vmalloc solves this by only requiring *virtual* contiguity - it can stitch together scattered physical pages into a contiguous virtual address range using page tables.

**Trade-off**: vmalloc has overhead (page table manipulation, TLB pressure) but can satisfy large allocations that kmalloc cannot.

### Why SLUB over SLAB?

SLUB (default since ~2008) simplified the slab allocator:
- Removed per-CPU queues complexity
- Better NUMA awareness
- Lower memory overhead
- Simpler debugging

SLAB still exists for compatibility but SLUB is the default.

## Related

- [page-allocator](page-allocator.md) - Foundation of all allocations
- [slab](slab.md) - kmalloc internals
- [vmalloc](vmalloc.md) - Large allocations
