# vrealloc

> Resize vmalloc allocations

## What is vrealloc?

`vrealloc()` resizes an existing vmalloc allocation, similar to userspace `realloc()`. Added in kernel 6.x (commit 3ddc2fefe6f3).

```c
void *vrealloc(const void *p, size_t size, gfp_t flags);
```

## Behavior

### Shrinking

When shrinking an allocation:
- Preserves data up to the new size
- Frees pages that are no longer needed
- Updates page tables to unmap freed pages
- Returns the same pointer (no copy needed)

### Growing

When growing an allocation:
- Allocates new, larger buffer
- Copies existing data
- Frees old allocation
- Returns new pointer

**Note**: Growing cannot extend in-place because the virtual address space after the allocation may be in use.

## Design Decisions

### Why shrink frees pages

Originally, `vrealloc()` shrinking only updated metadata (`requested_size`) but kept all pages mapped. This wasted memory when allocations were significantly downsized.

**Example**: Shrinking 256KB to 16KB kept 256KB of physical pages allocated.

The fix (2025) actually unmaps and frees unused pages:
- Updates memcg accounting
- Unmaps pages from virtual address space
- Returns pages to the page allocator

**Result**: 93% memory reduction when shrinking 256KB → 16KB.

### Why huge pages are skipped

Huge pages (order > 0) cannot be partially unmapped. If an allocation uses huge pages, shrinking only updates metadata without freeing memory.

### Why at least one page must remain

The first page holds memcg (memory cgroup) accounting state. Freeing all pages would break accounting, so at least one page always remains.

## Internals

When shrinking:

```c
if (page_order == 0 && new_nr_pages > 0 && pages_to_free > 0) {
    /* Update accounting */
    mod_memcg_page_state(vm->pages[0], MEMCG_VMALLOC, -pages_to_free);
    atomic_long_sub(pages_to_free, &nr_vmalloc_pages);

    /* Unmap pages */
    vunmap_range(unmap_start, old_end);

    /* Free pages */
    for (i = new_nr_pages; i < old_nr_pages; i++) {
        __free_page(vm->pages[i]);
        vm->pages[i] = NULL;
    }

    vm->nr_pages = new_nr_pages;
}
```

## Testing

The `test_vmalloc` module includes `vrealloc_shrink_test` (id: 4096):

```bash
# Run in QEMU with virtme-ng
virtme-ng --append 'test_vmalloc.run_test_mask=4096'
```

Test allocates 50 × 256KB buffers, shrinks to 16KB each, verifies data preservation and ~93% memory reduction.

## References

- `mm/vmalloc.c` - Implementation
- Commit 3ddc2fefe6f3 - Original vrealloc implementation
- [vmalloc](vmalloc.md) - Parent allocator
