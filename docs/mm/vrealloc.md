# vrealloc

> Resize vmalloc allocations

## What is vrealloc?

`vrealloc()` resizes an existing vmalloc allocation, similar to userspace `realloc()`.

```c
void *vrealloc(const void *p, size_t size, gfp_t flags);
```

## History & Evolution

### v6.12: Initial Implementation

**Commit**: [3ddc2fefe6f3](https://git.kernel.org/linus/3ddc2fefe6f3) ("mm: vmalloc: implement vrealloc()")
**Kernel**: v6.12
**Author**: Danilo Krummrich

**Why it was needed**:

The existing `kvrealloc()` had inconsistent behavior compared to `krealloc()`:

| Behavior | krealloc() | kvrealloc() (old) |
|----------|------------|-------------------|
| size = 0 | Frees memory | Returns existing pointer |
| NULL pointer | Acts like kmalloc | Faults |
| Track old size | Self-contained | Caller must track |

**LKML Discussion**: [Align kvrealloc() with krealloc()](https://lore.kernel.org/lkml/20240704170738.3621-1-dakr@redhat.com/)

**Rust motivation**: The patch mentions Rust's allocator abstractions. `Vec` and `KVec` need efficient realloc for growing/shrinking - a common pattern that was inefficient without proper vrealloc.

### Bug: KASAN Poisoning (v6.12)

**Commit**: [d699440f58ce](https://git.kernel.org/linus/d699440f58ce) ("mm: fix vrealloc()'s KASAN poisoning logic")
**Reporter**: Andrii Nakryiko (via BPF testing)
**Bug Report**: [lore.kernel.org](https://lore.kernel.org/bpf/67450f9b.050a0220.21d33d.0004.GAE@google.com/)

**What happened**: When vrealloc() reused existing vmap_area, KASAN annotations weren't updated correctly for the new size, causing false-positive KASAN splats.

**Learning**: Memory sanitizers (KASAN) add complexity to allocation code paths. When reusing memory regions, all annotations must be updated to match new valid/invalid byte ranges.

### v6.13: requested_size Tracking

**Commit**: [a0309faf1cb0](https://git.kernel.org/linus/a0309faf1cb0) ("mm: vmalloc: support more granular vrealloc() sizing")
**Author**: Kees Cook

Introduced `vm_struct::requested_size` to track actual requested size separately from allocated area. This enabled:
- Correct KASAN poisoning boundaries
- Growing within existing allocation
- Foundation for shrink optimization

**Bug Report that triggered this**: [lore.kernel.org](https://lore.kernel.org/all/20250408192503.6149a816@outsider.home/)

### Bug: In-place Region Not Returned (v6.13)

**Commit**: [f7a35a3c36d1](https://git.kernel.org/linus/f7a35a3c36d1) ("mm: vmalloc: actually use the in-place vrealloc region")
**Reporter**: Shung-Hsi Yu (SUSE)
**Bug Report**: [lore.kernel.org](https://lore.kernel.org/all/20250515-bpf-verifier-slowdown-vwo2meju4cgp2su5ckj@6gi6ssxbnfqg)

**What happened**: The refactoring to support in-place growing only worked for shrinking. Growing allocations would do the work but then allocate a completely new region anyway.

**Impact**: Performance regression in BPF verifier (heavy vrealloc user).

**Learning**: Off-by-one-style bugs in control flow. The function did all the right work, but the return statement used the wrong variable. One-line fix, big impact.

### Bug: Unnecessary Zero-init on Grow (v6.13)

**Commit**: [70d1eb031a68](https://git.kernel.org/linus/70d1eb031a68) ("mm: vmalloc: only zero-init on vrealloc shrink")

**What happened**: With `init_on_alloc`, the code was zeroing memory on both grow and shrink. But on grow, the new memory was already zeroed by the allocator.

**Learning**: Understand when initialization has already happened upstream. Redundant zeroing is expensive at scale.

### v6.14+: Shrink Optimization

**Commit**: [e64f42036ef4](https://git.kernel.org/linus/e64f42036ef4) ("mm/vmalloc: free pages when vrealloc() shrinks allocation")

**Problem identified**: `vrealloc()` shrinking only updated metadata but kept all pages mapped. Shrinking `256KB` to `16KB` still consumed `256KB` of physical memory.

**The fix**:
- Unmap pages beyond new size via `vunmap_range()`
- Free pages via `__free_page()`
- Update memcg accounting
- Update `nr_vmalloc_pages` counter

**Result**: 93% memory reduction when shrinking `256KB` -> `16KB`.

## Behavior

### Shrinking

When shrinking (size < current):
- Preserves data up to new size
- Frees unused pages (since e64f42036ef4)
- Returns same pointer (no copy)

### Growing

When growing (size > current):
- May reuse existing allocation if space allows (since a0309faf1cb0)
- Otherwise: allocate new, copy, free old
- Returns potentially new pointer

## Design Decisions

### Why huge pages are skipped for shrink

Huge pages (order > 0) use single TLB entries covering multiple pages. Partial unmapping would require splitting the huge page, which is complex and defeats the purpose. Shrinking huge page allocations only updates metadata.

### Why at least one page must remain

The first page is used for memcg accounting via `mod_memcg_page_state()`. The memcg charge is associated with the first page. Freeing all pages would lose this accounting reference.

### Why no minimum threshold for shrink

Early iterations considered requiring >= 4 pages to free before actually freeing. This was removed:
- Callers should control behavior, not arbitrary kernel policy
- Any freed memory has value
- Magic thresholds are hard to justify in review

## Common Pitfalls

Based on bugs found in vrealloc development:

1. **KASAN annotations**: When reusing memory, update sanitizer state
2. **Return value bugs**: After complex operations, ensure you return the right thing
3. **Redundant initialization**: Know what upstream code already initialized
4. **Partial operations on huge pages**: Usually not possible without splitting

## Testing

The `test_vmalloc` module includes `vrealloc_shrink_test` (id: 4096):

```bash
# Run in QEMU with virtme-ng
virtme-ng --append 'test_vmalloc.run_test_mask=4096'
```

## References

### Commits (chronological)
| Commit | Kernel | Description |
|--------|--------|-------------|
| [3ddc2fefe6f3](https://git.kernel.org/linus/3ddc2fefe6f3) | [v6.12](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v6.12) | Initial implementation |
| [d699440f58ce](https://git.kernel.org/linus/d699440f58ce) | [v6.12](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v6.12) | Fix KASAN poisoning |
| [a0309faf1cb0](https://git.kernel.org/linus/a0309faf1cb0) | [v6.13](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v6.13) | requested_size tracking |
| [f7a35a3c36d1](https://git.kernel.org/linus/f7a35a3c36d1) | [v6.13](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v6.13) | Fix in-place region return |
| [70d1eb031a68](https://git.kernel.org/linus/70d1eb031a68) | [v6.13](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v6.13) | Fix redundant zero-init |
| [e64f42036ef4](https://git.kernel.org/linus/e64f42036ef4) | v6.14+ | Shrink optimization |

### LKML Discussions
- [Original vrealloc proposal](https://lore.kernel.org/lkml/20240704170738.3621-1-dakr@redhat.com/)
- [KASAN bug report](https://lore.kernel.org/bpf/67450f9b.050a0220.21d33d.0004.GAE@google.com/)
- [BPF verifier slowdown](https://lore.kernel.org/all/20250515-bpf-verifier-slowdown-vwo2meju4cgp2su5ckj@6gi6ssxbnfqg)

### Code
- [`mm/vmalloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmalloc.c) - Implementation
- [`lib/test_vmalloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/test_vmalloc.c) - Test module

### Related
- [vmalloc](vmalloc.md) - Parent allocator
