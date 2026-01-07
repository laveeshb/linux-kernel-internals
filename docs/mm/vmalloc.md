# vmalloc

> Allocate virtually contiguous memory from scattered physical pages

## What is vmalloc?

`vmalloc()` allocates memory that is contiguous in *virtual* address space but may be backed by non-contiguous physical pages. This makes it suitable for large allocations where physical contiguity isn't required.

```c
void *vmalloc(unsigned long size);
void vfree(const void *addr);
```

## When to Use vmalloc

**Use vmalloc when:**
- Allocation is large (multiple pages)
- Physical contiguity not required
- Memory won't be used for DMA

**Don't use vmalloc when:**
- Small allocations (use kmalloc)
- Need physical contiguity (use kmalloc or alloc_pages)
- DMA operations (need physical addresses)
- Performance critical hot paths (TLB overhead)

## How It Works

1. **Find virtual address range** - Reserve space in the vmalloc address range
2. **Allocate physical pages** - Get individual pages from page allocator
3. **Build page tables** - Map virtual addresses to physical pages
4. **Return pointer** - Caller sees contiguous virtual memory

```
Virtual Address Space          Physical Memory
┌──────────────┐               ┌──────────────┐
│   vmalloc    │──────────────→│   Page A     │
│   buffer     │               ├──────────────┤
│   (contiguous│──────────────→│   Page B     │ (scattered)
│    virtual)  │               ├──────────────┤
│              │──────────────→│   Page C     │
└──────────────┘               └──────────────┘
```

## Key Data Structures

### vm_struct

Describes a vmalloc region:

```c
struct vm_struct {
    void *addr;           /* Virtual address */
    unsigned long size;   /* Size including guard page */
    struct page **pages;  /* Array of backing pages */
    unsigned int nr_pages;/* Number of pages */
    unsigned long flags;  /* VM_ALLOC, VM_MAP, etc. */
    /* ... */
};
```

### vmap_area

Tracks vmalloc address space usage (red-black tree for fast lookup).

## Variants

| Function | Description |
|----------|-------------|
| `vmalloc()` | Standard allocation |
| `vzalloc()` | Zero-initialized |
| `vmalloc_node()` | NUMA-aware allocation |
| `vrealloc()` | Resize existing allocation |
| `vfree()` | Free allocation |

## Design Decisions

### Why a guard page?

Each vmalloc region has a guard page (unmapped) at the end. Buffer overflows hit the guard and trigger a fault immediately rather than silently corrupting adjacent allocations.

### Why lazy TLB flushing?

TLB flushes are expensive (IPI to all CPUs). vmalloc batches unmappings and flushes lazily when possible to amortize the cost.

## References

- `mm/vmalloc.c` - Implementation
- `include/linux/vmalloc.h` - API
- [vrealloc](vrealloc.md) - Resizing allocations
