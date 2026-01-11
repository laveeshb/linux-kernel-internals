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

**End-to-End Walkthroughs:**

After the fundamentals, these trace operations through the entire stack:

15. **[Life of a malloc](life-of-malloc.md)** - From userspace to physical page
16. **[Life of a page](life-of-page.md)** - Allocation through reclaim
17. **[What happens when you fork](fork.md)** - COW mechanics
18. **[Running out of memory](oom.md)** - The path to OOM kill
19. **[Life of a file read](life-of-read.md)** - Page cache in action
20. **[What happens during swapping](swapping.md)** - Swap-out and swap-in

### What You'll Learn

| Textbook Concept | Linux Reality |
|------------------|---------------|
| "malloc allocates memory" | [No - it reserves address space](life-of-malloc.md). Physical pages come later via demand paging |
| "fork copies process memory" | [Copy-on-write](fork.md) means pages are shared until written |
| "Page tables map virtual to physical" | Multi-level page tables, TLB flushing costs, [lazy creation](life-of-malloc.md) |
| "Memory allocator" | Multiple allocators for different use cases (slab, vmalloc, buddy) |
| "Fragmentation" | Why physically contiguous memory is hard, vmalloc as a solution |
| "Memory is finite" | [Watermarks, kswapd, direct reclaim, OOM killer](oom.md) - a progression, not a cliff |
| "Reading files hits disk" | [Page cache](life-of-read.md) means most reads are from memory |
| "Swap is slow" | [Swap mechanics](swapping.md) - understand when and why it hurts |

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

### Lifecycle

Narrative walkthroughs following memory operations end-to-end:

| Document | What You'll Learn |
|----------|-------------------|
| [life-of-malloc](life-of-malloc.md) | Tracing malloc() from userspace to physical pages |
| [life-of-page](life-of-page.md) | A physical page's journey through allocation, use, and reclaim |
| [fork](fork.md) | COW setup, page table copying, and COW fault handling |
| [oom](oom.md) | Watermarks, kswapd, direct reclaim, and OOM killer |
| [life-of-read](life-of-read.md) | How read() flows through the page cache |
| [swapping](swapping.md) | Swap-out and swap-in mechanics in detail |

### Explainers

Conceptual guides for common memory management questions:

| Document | What You'll Learn |
|----------|-------------------|
| [virtual-physical-resident](virtual-physical-resident.md) | VSZ vs RSS vs PSS vs USS - why memory numbers don't add up |
| [overcommit](overcommit.md) | Why overcommit is the only sane default |
| [brk-vs-mmap](brk-vs-mmap.md) | Two ways to get memory from the kernel |
| [contiguous-memory](contiguous-memory.md) | Why large allocations fail despite free memory |
| [cow](cow.md) | Copy-on-write edge cases and when it breaks |

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
| [`mm/oom_kill.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/oom_kill.c) | OOM killer, victim selection |
| [`kernel/fork.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/fork.c) | Process creation, dup_mm() |
| [`include/linux/gfp.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/gfp.h) | GFP flags definitions |

---

## Further Reading

### Free Resources
- Bonwick, [*The Slab Allocator*](https://people.eecs.berkeley.edu/~kubitron/courses/cs194-24-S14/hand-outs/bonwick_slab.pdf) (1994) - Original slab paper from USENIX
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
