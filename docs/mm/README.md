# Memory Management (mm/)

The memory management subsystem is the foundation of the Linux kernel. It handles physical and virtual memory allocation, page tables, memory reclaim, and more.

## Topics

| Document | Description | Status |
|----------|-------------|--------|
| [overview](overview.md) | How mm/ fits together | Draft |
| [page-allocator](page-allocator.md) | Buddy system, physical pages | Planned |
| [slab](slab.md) | Slab/SLUB allocator, kmalloc | Planned |
| [vmalloc](vmalloc.md) | Virtually contiguous allocation | Planned |
| [vrealloc](vrealloc.md) | Resizing vmalloc allocations | Planned |
| [page-tables](page-tables.md) | Virtual to physical mapping | Planned |
| [reclaim](reclaim.md) | Memory pressure, vmscan | Planned |
| [memcg](memcg.md) | Memory cgroups, accounting | Planned |

## Reading Order

For understanding mm/ bottom-up:

1. **page-allocator** - Start here. Everything else builds on this.
2. **slab** - How small allocations work (kmalloc)
3. **vmalloc** - Virtual contiguous memory
4. **page-tables** - How virtual addresses map to physical
5. **reclaim** - What happens under memory pressure
6. **memcg** - Container memory isolation

## Key Source Files

- `mm/page_alloc.c` - Buddy allocator
- `mm/slub.c` - SLUB allocator (default)
- `mm/vmalloc.c` - vmalloc implementation
- `mm/vmscan.c` - Memory reclaim
- `mm/memcontrol.c` - Memory cgroups
