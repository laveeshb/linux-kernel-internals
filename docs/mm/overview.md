# Memory Management: The Story

## The Problem (1991)

When Linus Torvalds started Linux, he faced a fundamental question: **how do you let multiple programs share limited RAM?**

Every program thinks it has the entire computer's memory to itself. But there's only so much physical RAM. The memory management (mm) subsystem solves this with two key tricks:

1. **Virtual memory**: Each program gets its own "fake" address space
2. **Paging**: Only keep in RAM what's actually being used

This document tells the story of how Linux's memory allocators evolved over 30+ years.

---

## The Big Picture

How Linux memory allocators relate to each other:

```
                           +---------------------------------------------+
                           |              User Space                     |
                           |  malloc() / mmap() / brk()                  |
                           +-----------------------+---------------------+
                                                   |  system calls
                           +-----------------------v---------------------+
                           |              Kernel                         |
                           |                                             |
  +------------------------+---------------------------------------------+
  |                        |                                             |
  |   +--------------------v--------------------+                        |
  |   |             kmalloc / kfree             | <--- Small objects     |
  |   |         (physically contiguous)         |      (<page size)      |
  |   +--------------------+--------------------+                        |
  |                        |                                             |
  |   +--------------------v--------------------+                        |
  |   |           SLUB Allocator                | <--- Object caches     |
  |   |    (carves pages into fixed objects)    |      (inodes, tasks)   |
  |   +--------------------+--------------------+                        |
  |                        |                                             |
  |   +--------------------v--------------------+   +-----------------+  |
  |   |          Buddy Allocator                |<--|    vmalloc      |  |
  |   |   (manages physical page frames)        |   |  (virtual only) |  |
  |   |        mm/page_alloc.c                  |   |  mm/vmalloc.c   |  |
  |   +--------------------+--------------------+   +--------+--------+  |
  |                        |                                 |           |
  +------------------------+---------------------------------+-----------+
                           |                                 |
                           v                                 v
              +------------------------------------------------------------+
              |                  Physical RAM                              |
              |   [page][page][page][page][page][page][page][page]         |
              |     ^     ^     ^                 ^           ^            |
              |     |     |     |                 |           |            |
              |     +-----+-----+                 +-----------+            |
              |      contiguous                    scattered               |
              |      (kmalloc)                     (vmalloc)               |
              +------------------------------------------------------------+
```

**Key insight**: All allocators ultimately get pages from the buddy allocator. The difference is how they present memory to callers:
- **kmalloc/SLUB**: Physically contiguous, fast, small allocations
- **vmalloc**: Virtually contiguous, can satisfy large requests from fragmented memory

---

## Chapter 1: The Page Allocator (The Foundation)

### The Original Problem

Physical memory is finite. You need a way to hand out chunks of it and get them back.

*Note: The buddy allocator dates to Linux 0.01 (1991). This predates LKML - early Linux development happened on comp.os.minix and early mailing lists without good archives. Detailed mm discussions from this era are largely lost to history.*

> **Historical Context: How Linux Started**
>
> On August 25, 1991, Linus Torvalds [posted to comp.os.minix](https://www.cs.cmu.edu/~awb/linux.history.html): *"I'm doing a (free) operating system (just a hobby, won't be big and professional like gnu) for 386(486) AT clones."* He was a 21-year-old student in Helsinki, frustrated that MINIX (a teaching OS) couldn't be freely modified. Linux 0.01 had basic memory management - a simple buddy allocator for physical pages. Within months, others were contributing.
>
> **The Monolithic vs Microkernel Debate (1992)**
>
> In January 1992, Andrew Tanenbaum (MINIX creator, OS professor) [declared "Linux is obsolete"](https://www.oreilly.com/openbook/opensources/book/appa.html) on comp.os.minix. His argument: Linux's monolithic kernel (where mm/, filesystems, drivers all run in kernel space) was a "giant step back into the 1970s." Microkernels (like MINIX) were the future - minimal kernel, everything else in userspace.
>
> Torvalds responded the next day: monolithic was a pragmatic choice. Microkernels had theoretical elegance but real-world performance overhead from context switches and message passing. He prioritized getting things working on real hardware (the 386) over architectural purity. History proved him right - Linux runs everywhere from phones to supercomputers, while pure microkernels remain niche.
>
> **Why this matters for mm/**: Linux's monolithic design means memory management runs in kernel space with direct hardware access. No message-passing overhead. `kmalloc()` is a function call, not an IPC. This shaped every allocator discussed below - they optimize for this tight integration.

### The Solution: Buddy System

Linux uses a "buddy allocator" (borrowed from older systems). Here's the clever idea:

```
Imagine you have 16 pages of RAM:

[________________]  <- 16 pages (order 4)

Someone asks for 2 pages. You split:

[________][______]  <- two 8-page blocks
[____][__][______]  <- split again: 4, 4, 8
[__][_][_][______]  <- split again: 2, 2, 4, 8
    ^^
    Given to requester

When they free those 2 pages, you merge them back with their "buddy":
[__][_][_] -> [____][_] -> [________] -> etc.
```

**Why it works**: Fast allocation (`O(log n)`), automatic merging reduces fragmentation.

**What it can't do**: Give you, say, 3 pages. You'll get 4 (next power of 2).

---

## Chapter 2: The Slab Allocator (v2.0, ~1996)

### The Problem

The page allocator works in page-sized chunks (`4KB`). But kernel objects are often tiny:
- An inode? ~600 bytes
- A `task_struct`? ~`8KB`
- A socket buffer? ~200 bytes

Giving someone a whole `4KB` page for a 200-byte object wastes memory.

### The Solution: Slab

The "slab allocator" (borrowed from SunOS) carves pages into fixed-size object caches:

```
Page for 200-byte objects:
[obj][obj][obj][obj][obj][obj]...[obj]  <- ~20 objects fit

Page for 600-byte objects:
[object][object][object][object]...     <- ~6 objects fit
```

Each object type gets its own cache. Allocating is fast (grab from cache), freeing is fast (return to cache).

### The Evolution

**SLAB (Original, ~1996)**: Ported from SunOS, based on [Bonwick's 1994 USENIX paper](https://www.usenix.org/legacy/publications/library/proceedings/bos94/bonwick.html). Complex. Multiple levels of caches. Good debugging. But hard to maintain.

*Note: SLAB predates good LKML archives. The Bonwick paper is the canonical design reference.*

**SLUB (v2.6.22, 2007)**: Simpler redesign by Christoph Lameter.
- **Commit**: [81819f0fc828](https://git.kernel.org/linus/81819f0fc828)
- Removed complex queuing
- Lower memory overhead
- Better NUMA support
- Same API, simpler internals

*Note: The original "SLUB: The unqueued Slab allocator" LKML thread (Feb 2007) predates reliable archives. The commit message and code comments document the design rationale.*

**Why SLUB won**: Kernel developers learned that simpler code is easier to maintain and debug. SLAB's complexity wasn't worth the marginal performance gains.

**SLOB (embedded, removed v6.2)**: Minimal allocator for tiny systems. Removed because SLUB became efficient enough for embedded too.

**The API** (`kmalloc`/`kfree`):
```c
ptr = kmalloc(size, GFP_KERNEL);  // Get memory
kfree(ptr);                        // Give it back
```

---

## Chapter 3: vmalloc (1993 → Present)

### The Problem

`kmalloc` gives you *physically contiguous* memory. As the system runs, physical memory becomes fragmented. Eventually, you can't find a contiguous `1MB` chunk even if total free memory is `100MB`.

### The Solution: Virtual Contiguity

What if the memory only needs to *look* contiguous to the user?

```
Virtual addresses:     Physical pages:
0xFFFF0000 ──────────→ Page at 0x1234000
0xFFFF1000 ──────────→ Page at 0x8765000  (scattered!)
0xFFFF2000 ──────────→ Page at 0x2222000
```

The program sees contiguous 0xFFFF0000-0xFFFF3000, but the physical pages are scattered. This is `vmalloc()`.

### The Cost

Page tables must be set up. TLB (translation cache) entries are consumed. It's slower than kmalloc. But it can satisfy large allocations when kmalloc can't.

### Major Evolution

**v2.6.28 (2008): The Scalability Crisis**

**The problem**: vunmap needed to flush TLB entries. On multi-core systems, this meant an IPI (interrupt) to *every* CPU. Under a global lock. As core counts grew from 4 to 64+, this became quadratic slowdown.

**The fix**: Nick Piggin rewrote vmalloc from scratch:
- **Commit**: [db64fe02258f](https://git.kernel.org/linus/db64fe02258f)
- Lazy TLB flushing: Don't flush immediately, batch multiple unmaps
- RBTree for address lookup: `O(log n)` instead of `O(n)` list scan
- Per-CPU frontend: Reduce lock contention

*Note: The original LKML discussion (Oct 2008) predates reliable archives.*

**v5.13 (2021): Huge Pages**

**The problem**: With huge vmalloc buffers (BPF programs, modules), each `4KB` page needed a TLB entry. TLB is limited. Lots of TLB misses.

**The fix**: Use huge pages (`2MB`) when possible:
- **Commit**: [121e6f3258fe](https://git.kernel.org/linus/121e6f3258fe)
- Fewer TLB entries needed
- Trade-off: More internal fragmentation

**v6.12 (2024): vrealloc**

**The problem**: You have a vmalloc buffer and want to resize it. Previously, you'd have to allocate new, copy, free old.

**The fix**: `vrealloc()` - resize in place when possible:
- **Commit**: [3ddc2fefe6f3](https://git.kernel.org/linus/3ddc2fefe6f3)
- Motivated by Rust's allocator needs (`Vec` resizing)
- See [vrealloc](vrealloc.md) for the full story and bugs found

---

## Chapter 4: When Things Broke

Real bugs teach more than perfect code. Here are instructive failures:

### KASAN vs vrealloc (v6.12)

**What broke**: vrealloc reused existing memory but didn't update KASAN (memory sanitizer) annotations. Result: false-positive "use-after-free" reports.

**The lesson**: When you have memory safety tooling, you must keep it in sync with actual memory state. Annotations are code, not comments.

**Fix**: [d699440f58ce](https://git.kernel.org/linus/d699440f58ce)

### The Return Value Bug (v6.13)

**What broke**: vrealloc was refactored to support in-place growing. The code did all the work correctly... then returned the wrong variable. Growing allocations silently fell back to the slow path.

**The lesson**: After complex refactoring, double-check your return statements. The happy path isn't always the executed path.

**Impact**: BPF verifier performance regression - it uses vrealloc heavily.

**Fix**: [f7a35a3c36d1](https://git.kernel.org/linus/f7a35a3c36d1) - one line change.

### Redundant Zeroing (v6.13)

**What broke**: With `init_on_alloc` enabled, vrealloc was zeroing memory on both grow and shrink. But on grow, the new memory was already zeroed by the allocator.

**The lesson**: Understand what upstream code already did. Don't assume you need to do everything yourself.

**Fix**: [70d1eb031a68](https://git.kernel.org/linus/70d1eb031a68)

---

## Chapter 5: Choosing the Right Allocator

After all this history, here's the practical guidance:

| Situation | Use | Why |
|-----------|-----|-----|
| Small object (<page) | `kmalloc()` | Fast, low overhead |
| Large buffer (pages+) | `vmalloc()` | Doesn't need physical contiguity |
| Don't know size ahead | `kvmalloc()` | Tries kmalloc, falls back to vmalloc |
| DMA buffer | `dma_alloc_coherent()` | Need physical address for hardware |
| Resizable buffer | `krealloc()`/`vrealloc()` | Efficient resize |

---

## Try It Yourself

### Explore the Buddy Allocator

```bash
# View buddy allocator state per zone
cat /proc/buddyinfo

# Example output:
# Node 0, zone   Normal  1024  512  256  128   64   32   16    8    4    2    1
#                        ^     ^    ^    ^     ^    ^    ^     ^    ^    ^    ^
#                        |     |    |    |     |    |    |     |    |    |    order 10 (4MB blocks)
#                        order 0 (4KB pages)

# Each number = count of free blocks at that order
# Order 0 = 4KB, Order 1 = 8KB, ... Order 10 = 4MB
```

### Explore the Slab Allocator

```bash
# View all slab caches
cat /proc/slabinfo

# Better: use slabtop for live monitoring
slabtop

# Key columns:
# OBJS     - Total objects (active + inactive)
# ACTIVE   - Objects currently in use
# USE      - Percentage utilization
# OBJ SIZE - Size of each object
# SLABS    - Number of slabs

# Find biggest memory consumers
slabtop -s c  # Sort by cache size
```

### Check Overall Memory

```bash
# High-level memory overview
cat /proc/meminfo

# Key fields for mm/:
# MemTotal      - Total usable RAM
# MemFree       - Completely unused pages
# Buffers       - Block device cache
# Cached        - Page cache (file data)
# Slab          - Kernel slab allocator total
# SReclaimable  - Slab memory that can be reclaimed
# VmallocUsed   - vmalloc usage
```

### Run Kernel Memory Tests

```bash
# Build test modules (in kernel tree with CONFIG_TEST_* enabled)
make M=lib/ lib/test_vmalloc.ko
make M=mm/ mm/test_hmm.ko

# Run vmalloc tests
modprobe test_vmalloc run_test_mask=0xFFFF
dmesg | grep test_vmalloc

# Run via virtme-ng (recommended for testing)
virtme-ng --kdir . --append 'test_vmalloc.run_test_mask=0xFFFF'
```

### Key Code Locations

| Subsystem | File | What to Look For |
|-----------|------|------------------|
| Buddy allocator | [`mm/page_alloc.c`](https://elixir.bootlin.com/linux/latest/source/mm/page_alloc.c) | `__alloc_pages()`, `free_pages()` |
| SLUB allocator | [`mm/slub.c`](https://elixir.bootlin.com/linux/latest/source/mm/slub.c) | `kmem_cache_alloc()`, `kmalloc()` |
| vmalloc | [`mm/vmalloc.c`](https://elixir.bootlin.com/linux/latest/source/mm/vmalloc.c) | `vmalloc()`, `vfree()` |
| Memory reclaim | [`mm/vmscan.c`](https://elixir.bootlin.com/linux/latest/source/mm/vmscan.c) | `shrink_node()`, `kswapd()` |
| OOM killer | [`mm/oom_kill.c`](https://elixir.bootlin.com/linux/latest/source/mm/oom_kill.c) | `out_of_memory()`, `oom_badness()` |

*Use [Bootlin Elixir](https://elixir.bootlin.com/linux/latest/source/mm/) for navigating kernel source with cross-references.*

---

## Timeline Summary

| Year | Kernel | What Happened |
|------|--------|---------------|
| 1991 | 0.01 | Buddy allocator for pages |
| ~1996 | 2.0 | SLAB allocator for small objects |
| 1993-2002 | 2.x | vmalloc evolution (Linus, then Christoph Hellwig) |
| 2007 | [v2.6.22](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v2.6.22) | SLUB replaces SLAB as default |
| 2008 | [v2.6.28](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v2.6.28) | vmalloc rewrite (RBTree, lazy TLB) |
| 2021 | [v5.13](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v5.13) | vmalloc huge page support |
| 2023 | [v6.2](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v6.2) | SLOB removed |
| 2024 | [v6.12](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v6.12) | vrealloc introduced |
| 2025 | [v6.13](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v6.13)+ | vrealloc bugs fixed, shrink optimization |

---

## Further Reading

- [vmalloc](vmalloc.md) - Deep dive into virtual memory allocation
- [vrealloc](vrealloc.md) - The full story of vmalloc resizing
- [page-allocator](page-allocator.md) - Buddy system details (planned)
- [slab](slab.md) - SLUB internals (planned)
