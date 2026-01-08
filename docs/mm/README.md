# Memory Management (mm/)

> How Linux manages the most fundamental resource: memory

## Getting Started

This documentation explains how Linux manages memory - not just the theory, but the actual implementation decisions, trade-offs, and lessons learned over 30+ years of development.

### Prerequisites

This documentation assumes familiarity with:
- **C programming** - The kernel is written in C
- **Pointers and memory addresses** - Virtual vs physical addressing
- **Basic OS concepts** - Processes, kernel vs userspace

If you've covered virtual memory and paging, that's a good foundation. See [Further Reading](#further-reading) for recommended textbooks.

### Getting the Kernel Source

```bash
git clone https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git
cd linux
```

For building and configuration, see [Documentation/admin-guide/README.rst](https://docs.kernel.org/admin-guide/README.html).

### Running Tests

The fastest way to test kernel changes without rebooting your machine:

```bash
# Install virtme-ng (runs kernel in QEMU with your filesystem)
pip install virtme-ng

# Build and boot with a test module
virtme-ng --kdir . --append 'test_vmalloc.run_test_mask=0xFFFF'

# Check results
# (dmesg output appears in the virtual console)
```

For comprehensive testing documentation, see [Documentation/dev-tools/testing-overview.rst](https://docs.kernel.org/dev-tools/testing-overview.html).

### Suggested Reading Order

**Fundamentals:**

1. **[Overview](overview.md)** - The narrative of how mm/ evolved
2. **[Page Allocator](page-allocator.md)** - Buddy system fundamentals
3. **[Slab](slab.md)** - SLUB allocator for small objects
4. **[vmalloc](vmalloc.md)** - Virtual memory allocation

**Address Translation & Process Memory:**

5. **[Page Tables](page-tables.md)** - Virtual address translation
6. **[Process Address Space](mmap.md)** - VMAs, mmap, demand paging

**Memory Pressure & Reclaim:**

7. **[Page Reclaim](reclaim.md)** - LRU, kswapd, MGLRU
8. **[Swap](swap.md)** - Extending memory to disk
9. **[Page Cache](page-cache.md)** - File data caching

**Advanced Topics:**

10. **[Memory Cgroups](memcg.md)** - Container memory limits
11. **[NUMA](numa.md)** - Multi-node memory management
12. **[Transparent Huge Pages](thp.md)** - Automatic huge pages
13. **[Compaction](compaction.md)** - Memory defragmentation
14. **[KSM](ksm.md)** - Page deduplication for VMs

### What You'll Learn

| Textbook Concept | Linux Reality |
|------------------|---------------|
| "Page tables map virtual to physical" | Multi-level page tables, TLB flushing costs, lazy unmapping |
| "Memory allocator" | Multiple allocators for different use cases (slab, vmalloc, buddy) |
| "Fragmentation" | Why physically contiguous memory is hard, vmalloc as a solution |
| "Memory is finite" | OOM killer, memory cgroups, reclaim |

### What Makes This Different

- **Real commits**: Every claim links to actual kernel commits
- **Real bugs**: Learn from what broke and why
- **Real discussions**: Links to LKML where decisions were debated
- **Real trade-offs**: Not just "what" but "why this and not that"
- **Hands-on**: "Try It Yourself" sections with commands to run and code to read

---

## Documentation

### Core Reading

| Document | What You'll Learn |
|----------|-------------------|
| [overview](overview.md) | The 30-year story of Linux memory management |
| [page-allocator](page-allocator.md) | Buddy system - physical page management |
| [slab](slab.md) | SLUB - small object allocation |
| [vmalloc](vmalloc.md) | Virtually contiguous allocation |
| [vrealloc](vrealloc.md) | Resizing allocations |
| [page-tables](page-tables.md) | Virtual address translation |
| [reclaim](reclaim.md) | What happens under memory pressure |
| [memcg](memcg.md) | Container memory limits |
| [thp](thp.md) | Transparent Huge Pages - automatic 2MB pages |
| [numa](numa.md) | NUMA memory policies and balancing |
| [compaction](compaction.md) | Memory defragmentation for large allocations |
| [ksm](ksm.md) | Kernel Same-page Merging - memory deduplication |
| [mmap](mmap.md) | Process address space and VMAs |
| [page-cache](page-cache.md) | File data caching in memory |
| [swap](swap.md) | Extending memory to disk |

---

## Key Source Files

If you want to read the actual code:

| File | What It Does |
|------|--------------|
| [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) | Buddy allocator - physical page management |
| [`mm/slub.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slub.c) | SLUB allocator - small object caches |
| [`mm/vmalloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmalloc.c) | vmalloc - virtually contiguous allocation |
| [`mm/vmscan.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmscan.c) | Memory reclaim under pressure |
| [`mm/memcontrol.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c) | Memory cgroups |
| [`mm/huge_memory.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/huge_memory.c) | Transparent Huge Pages |
| [`mm/mempolicy.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mempolicy.c) | NUMA memory policies |
| [`mm/compaction.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/compaction.c) | Memory compaction |
| [`mm/ksm.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/ksm.c) | Kernel Same-page Merging |
| [`mm/mmap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mmap.c) | Process address space, VMAs |
| [`mm/filemap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/filemap.c) | Page cache |
| [`mm/swapfile.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/swapfile.c) | Swap area management |
| [`include/linux/gfp.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/gfp.h) | GFP flags definitions |

---

## Further Reading

### Free Resources
- Bonwick, [*The Slab Allocator*](https://www.usenix.org/legacy/publications/library/proceedings/bos94/bonwick.html) (1994) - Original slab paper from USENIX
- Gorman, [*Understanding the Linux Virtual Memory Manager*](https://www.kernel.org/doc/gorman/) - Free online book

### Kernel Documentation
- [Documentation/mm/](https://docs.kernel.org/mm/) in the kernel tree
- [Documentation/admin-guide/mm/](https://docs.kernel.org/admin-guide/mm/) for sysadmin perspective

### Textbooks
- Silberschatz et al., [*Operating System Concepts*](https://www.os-book.com/) - Ch. 9-10 (Memory)
- Tanenbaum & Bos, [*Modern Operating Systems*](https://www.pearson.com/en-us/subject-catalog/p/modern-operating-systems/P200000003295) - Ch. 3 (Memory Management)
- Love, [*Linux Kernel Development*](https://www.oreilly.com/library/view/linux-kernel-development/9780768696974/) - Ch. 12 (Memory Management)

---

## Appendix

- **[Glossary](glossary.md)** - Terminology reference
