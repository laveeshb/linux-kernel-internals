# Memory Management (mm/)

> How Linux manages the most fundamental resource: memory

## For Students

This documentation is designed to help you understand how a real operating system manages memory - not just the theory from textbooks, but the actual implementation decisions, trade-offs, and lessons learned over 30+ years of development.

### Prerequisites

Before diving in, you should understand:
- **C programming** - Kernel is written in C
- **Pointers and memory addresses** - Virtual vs physical addressing
- **Basic OS concepts** - Processes, kernel vs userspace

If your textbook covers virtual memory and paging (Silberschatz Ch. 9-10, Tanenbaum Ch. 3), you have enough background.

### Start Here

1. **[Glossary](glossary.md)** - Learn the terminology first
2. **[Overview: The Story](overview.md)** - The narrative of how mm/ evolved
3. **[vmalloc](vmalloc.md)** - Deep dive into one allocator
4. **[vrealloc](vrealloc.md)** - A recent feature with instructive bugs

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
| [glossary](glossary.md) | Every term defined for newcomers |
| [vmalloc](vmalloc.md) | How virtually contiguous allocation works |
| [vrealloc](vrealloc.md) | Resizing allocations - a case study in kernel development |

### Planned

| Document | Status |
|----------|--------|
| [page-allocator](page-allocator.md) | Planned - Buddy system deep dive |
| [slab](slab.md) | Planned - SLUB internals |
| [page-tables](page-tables.md) | Planned - Virtual memory mapping |
| [reclaim](reclaim.md) | Planned - What happens under memory pressure |
| [memcg](memcg.md) | Planned - Container memory limits |

---

## Timeline

A quick reference of major events in Linux mm/ history:

| Year | Version | Event |
|------|---------|-------|
| 1991 | 0.01 | Linux born with basic memory management |
| ~1996 | 2.0 | SLAB allocator introduced |
| 2002 | 2.5 | vmalloc rewritten by Christoph Hellwig |
| 2007 | [v2.6.22](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v2.6.22) | SLUB replaces SLAB as default |
| 2008 | [v2.6.28](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v2.6.28) | vmalloc rewritten again (RBTree, lazy TLB) |
| 2021 | [v5.13](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v5.13) | vmalloc huge page support |
| 2023 | [v6.2](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v6.2) | SLOB removed |
| 2024 | [v6.12](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v6.12) | vrealloc introduced |
| 2025 | [v6.13](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v6.13)+ | vrealloc bugs fixed, optimized |

---

## Key Source Files

If you want to read the actual code:

| File | What It Does |
|------|--------------|
| `mm/page_alloc.c` | Buddy allocator - physical page management |
| `mm/slub.c` | SLUB allocator - small object caches |
| `mm/vmalloc.c` | vmalloc - virtually contiguous allocation |
| `mm/vmscan.c` | Memory reclaim under pressure |
| `mm/memcontrol.c` | Memory cgroups |
| `include/linux/gfp.h` | GFP flags definitions |

---

## Further Reading

### Free Resources
- [Bonwick, "The Slab Allocator" (1994)](https://www.usenix.org/legacy/publications/library/proceedings/bos94/bonwick.html) - Original slab paper from USENIX
- [Gorman, "Understanding the Linux Virtual Memory Manager"](https://www.kernel.org/doc/gorman/) - Free online book

### Kernel Documentation
- [Documentation/mm/](https://docs.kernel.org/mm/) in the kernel tree
- [Documentation/admin-guide/mm/](https://docs.kernel.org/admin-guide/mm/) for sysadmin perspective

### Textbooks
- Silberschatz, "Operating System Concepts" - Ch. 9-10 (Memory)
- Tanenbaum, "Modern Operating Systems" - Ch. 3 (Memory Management)
- Love, "Linux Kernel Development" - Ch. 12 (Memory Management)
