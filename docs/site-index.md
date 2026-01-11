# Index

A complete listing of all documentation, organized by topic.

---

## General

| Page | Description |
|------|-------------|
| [Home](index.md) | Introduction and overview |
| [Linux Evolution](linux-evolution.md) | From hobby project to world infrastructure |

---

## Memory Management (mm/)

### Getting Started

| Page | Description |
|------|-------------|
| [Getting Started](mm/README.md) | Prerequisites, setup, and reading order |
| [Overview](mm/overview.md) | The 30-year story of Linux memory management |

### Fundamentals

| Page | Description |
|------|-------------|
| [Page Allocator](mm/page-allocator.md) | Buddy system - physical page management |
| [kmalloc (SLUB)](mm/slab.md) | kmalloc/kfree, size classes, kvmalloc |
| [vmalloc](mm/vmalloc.md) | Virtually contiguous allocation |
| [NUMA](mm/numa.md) | Multi-node memory management |

### Address Translation & Process Memory

| Page | Description |
|------|-------------|
| [Page Tables](mm/page-tables.md) | Virtual-to-physical address translation |
| [Process Address Space](mm/mmap.md) | VMAs, mmap, demand paging, COW |

### Caching & Reclaim

| Page | Description |
|------|-------------|
| [Page Cache](mm/page-cache.md) | File data caching and writeback |
| [Page Reclaim](mm/reclaim.md) | LRU, kswapd, MGLRU, OOM killer |
| [Swap](mm/swap.md) | Extending memory to disk (zswap, zram) |

### Advanced Topics

| Page | Description |
|------|-------------|
| [Memory Cgroups](mm/memcg.md) | Container memory limits (v1/v2) |
| [Transparent Huge Pages](mm/thp.md) | Automatic 2MB/1GB pages |
| [Compaction](mm/compaction.md) | Memory defragmentation |
| [KSM](mm/ksm.md) | Page deduplication for VMs |
| [vrealloc](mm/vrealloc.md) | Resizing vmalloc allocations |

### Lifecycle

| Page | Description |
|------|-------------|
| [Life of a malloc](mm/life-of-malloc.md) | Tracing malloc() from userspace to physical pages |
| [Life of a page](mm/life-of-page.md) | A physical page's journey through allocation, use, and reclaim |
| [What happens when you fork](mm/fork.md) | COW setup, page table copying, and COW fault handling |
| [Running out of memory](mm/oom.md) | Watermarks, kswapd, direct reclaim, and OOM killer |
| [Life of a file read](mm/life-of-read.md) | How read() flows through the page cache |
| [What happens during swapping](mm/swapping.md) | Swap-out and swap-in mechanics in detail |

### Explainers

| Page | Description |
|------|-------------|
| [Virtual vs Physical vs Resident](mm/virtual-physical-resident.md) | Understanding VSZ, RSS, PSS, and USS |
| [Memory Overcommit](mm/overcommit.md) | Why it's the only sane default |
| [brk vs mmap](mm/brk-vs-mmap.md) | Two ways to get memory from the kernel |
| [Contiguous Memory](mm/contiguous-memory.md) | Why large allocations fail despite free memory |
| [Copy-on-Write](mm/cow.md) | COW edge cases and when it breaks |

### Reference

| Page | Description |
|------|-------------|
| [Glossary](mm/glossary.md) | Terminology reference |

---

## Planned Subsystems

| Subsystem | Status |
|-----------|--------|
| scheduler/ | Planned |
| networking/ | Planned |
| bpf/ | Planned |
| drivers/ | Planned |

---

## External Resources

| Resource | Description |
|----------|-------------|
| [Official Kernel Docs](https://docs.kernel.org/) | Authoritative kernel documentation |
| [LKML Archive](https://lore.kernel.org/) | Linux kernel mailing list archive |
| [Kernel Source](https://git.kernel.org/) | Official git repositories |
