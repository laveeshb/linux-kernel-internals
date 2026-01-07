# vmalloc

> Allocate virtually contiguous memory from scattered physical pages

## What is vmalloc?

`vmalloc()` allocates memory that is contiguous in *virtual* address space but may be backed by non-contiguous physical pages. This makes it suitable for large allocations where physical contiguity isn't required.

```c
void *vmalloc(unsigned long size);
void vfree(const void *addr);
```

## History & Evolution

### Origins (1993)

vmalloc dates back to the original Linux kernel by Linus Torvalds.

From `mm/vmalloc.c`:
```
Copyright (C) 1993  Linus Torvalds
Support of BIGMEM added by Gerhard Wichert, Siemens AG, July 1999
SMP-safe vmalloc/vfree/ioremap, Tigran Aivazian, May 2000
Major rework to support vmap/vunmap, Christoph Hellwig, SGI, August 2002
```

### v2.6.28: Major Rewrite - RBTree & Lazy TLB

**Commit**: [db64fe02258f](https://git.kernel.org/linus/db64fe02258f) ("mm: rewrite vmap layer")
**Kernel**: v2.6.28
**Author**: Nick Piggin

**The problem**: vunmap required a global kernel TLB flush (broadcast IPI to all CPUs), all under a single global rwlock taken for write in fast paths. Quadratic scalability as CPU count increased.

**The solution**:
1. **Lazy TLB flushing**: Don't flush immediately on vunmap. Addresses won't be reused until reallocated, so batch multiple unmaps into single flush.
2. **RBTree for vmap_area**: Fast O(log n) lookups instead of linear list scan.
3. **Percpu frontend**: Fast, scalable allocation for small vmaps.

**Trade-off**: XEN and PAT need immediate TLB flush due to aliasing issues. They call `vm_unmap_aliases()` to force flush when needed.

**LKML Discussion**: [vmap rewrite](https://lkml.kernel.org/r/20081015031109.GA11393@wotan.suse.de)

### v5.13: Huge Page Support

**Commit**: [121e6f3258fe](https://git.kernel.org/linus/121e6f3258fe) ("mm/vmalloc: hugepage vmalloc mappings")
**Kernel**: v5.13
**Author**: Nicholas Piggin

**What changed**: vmalloc can now use PMD-sized huge pages for large allocations.

**How it works**:
- If allocation >= PMD size, try huge pages first
- Fall back to small pages if huge allocation fails
- `VM_NOHUGE` flag to force small pages (needed for module allocations with strict rwx)
- Boot option `nohugevmalloc` to disable globally

**Trade-off**: More internal fragmentation (allocating 2MB when you need 1.1MB), but fewer TLB entries needed.

### v6.12: vrealloc Introduction

**Commit**: [3ddc2fefe6f3](https://git.kernel.org/linus/3ddc2fefe6f3) ("mm: vmalloc: implement vrealloc()")
**Kernel**: v6.12

See [vrealloc](vrealloc.md) for detailed history.

## When to Use vmalloc

**Use vmalloc when:**
- Allocation is large (multiple pages)
- Physical contiguity not required
- Memory won't be used for DMA

**Don't use vmalloc when:**
- Small allocations (use kmalloc - less overhead)
- Need physical contiguity (use kmalloc or alloc_pages)
- DMA operations (need physical addresses)
- Performance critical hot paths (page table overhead, potential TLB misses)

## How It Works

### Allocation Flow

1. **Find virtual address range**: Search vmap_area rbtree for free space
2. **Allocate physical pages**: Get individual pages from buddy allocator
3. **Build page tables**: Map virtual addresses to physical pages
4. **Return pointer**: Caller sees contiguous virtual memory

```
Virtual Address Space          Physical Memory
+---------------+              +---------------+
|   vmalloc     |------------->|   Page A      |
|   buffer      |              +---------------+
|   (contiguous |              :               :
|    virtual)   |------------->|   Page B      | (scattered!)
|               |              +---------------+
|               |              :               :
|               |------------->|   Page C      |
+---------------+              +---------------+
```

### Free Flow (Lazy TLB)

1. **Mark area for freeing**: Add to lazy free list
2. **Don't flush TLB immediately**: Address won't be reused yet
3. **Batch flush**: When threshold reached or `vm_unmap_aliases()` called
4. **Return pages**: Free physical pages to buddy allocator

## Key Data Structures

How vmalloc tracks allocations:

```
  vmap_area RBTree                      vm_struct                Physical Pages
  (fast lookup)                      (allocation info)           (actual memory)

+------------------+              +-------------------+        +---------+
| vmap_area        |              | vm_struct         |        | struct  |
|------------------|              |-------------------|        | page    |
| va_start --------|--+           | addr = 0xFFFF0000 |        +---------+
| va_end           |  |           | size = 12288      |            ^
| rb_node ------+  |  |           | nr_pages = 3      |            |
| vm -----------)--|--+---------->| pages[] ----------|--+---------+
+------------------+  |           | flags = VM_ALLOC  |  |     +---------+
        |             |           +-------------------+  |     | struct  |
        v             |                                  +---->| page    |
   +----+----+        |                                  |     +---------+
   |         |        |                                  |         ^
   v         v        |                                  |         |
 [left]   [right]     |                                  |     +---------+
                      |                                  +---->| struct  |
                      v                                        | page    |
              Virtual Address                                  +---------+
              0xFFFF0000-0xFFFF3000
```

### vm_struct

Describes a vmalloc region:

```c
struct vm_struct {
    void *addr;              /* Virtual address */
    unsigned long size;      /* Size including guard page */
    struct page **pages;     /* Array of backing pages */
    unsigned int nr_pages;   /* Number of pages */
    phys_addr_t phys_addr;   /* Physical address (for ioremap) */
    unsigned long flags;     /* VM_ALLOC, VM_MAP, VM_IOREMAP, etc. */
    unsigned long requested_size; /* Actual requested size (v6.13+) */
};
```

### vmap_area

Tracks vmalloc address space usage:

```c
struct vmap_area {
    unsigned long va_start;  /* Start of virtual range */
    unsigned long va_end;    /* End of virtual range */
    struct rb_node rb_node;  /* RBTree node for fast lookup */
    struct list_head list;   /* Linked list */
    struct vm_struct *vm;    /* Associated vm_struct */
};
```

## Variants

| Function | Description | Since |
|----------|-------------|-------|
| `vmalloc()` | Standard allocation | Original |
| `vzalloc()` | Zero-initialized | v2.6.37 |
| `vmalloc_node()` | NUMA-aware | v2.6.16 |
| `vmalloc_huge()` | Prefer huge pages | v5.13 |
| `vmalloc_no_huge()` | Force small pages | v5.13 |
| `vrealloc()` | Resize allocation | v6.12 |
| `vfree()` | Free allocation | Original |

## Design Decisions

### Why guard pages?

Each vmalloc region has a guard page (unmapped) at the end. Buffer overflows hit the guard and trigger a page fault immediately, rather than silently corrupting adjacent allocations.

**Commit**: The `VM_NO_GUARD` flag exists for special cases that don't want guard pages, but [bd1a8fb2d43f](https://git.kernel.org/linus/bd1a8fb2d43f) ("mm/vmalloc: don't allow VM_NO_GUARD on vmap()") restricts its use.

### Why lazy TLB flushing?

TLB flushes are expensive:
- IPI (Inter-Processor Interrupt) to all CPUs
- Each CPU must flush its TLB
- All done under lock

Batching multiple vunmaps into a single flush amortizes this cost. The kernel tracks `vmap_lazy_nr` and flushes when it exceeds a threshold.

### Why RBTree for vmap_area?

Before v2.6.28, vmalloc used a simple linked list. As systems grew larger, linear O(n) searches became a bottleneck. RBTree provides O(log n) lookup, insertion, and deletion.

## Common Issues

### TLB Flush Storms

Under heavy vmalloc/vfree workload, lazy flushing can cause "flush storms" where many IPIs fire at once when threshold is reached.

### Address Space Exhaustion

vmalloc has limited address space (VMALLOC_START to VMALLOC_END). On 32-bit systems this was often only 128MB. Heavy users like BPF, modules, and drivers can exhaust it.

### NUMA Locality

vmalloc wasn't always NUMA-aware. Modern kernels try to allocate pages from the same node when possible via `vmalloc_node()`.

## Try It Yourself

### Inspect vmalloc Usage

View all vmalloc allocations on a running system:

```bash
# List all vmalloc regions with addresses, sizes, and callers
cat /proc/vmallocinfo

# Example output:
# 0xffffc90000000000-0xffffc90000201000 2101248 bpf_prog_alloc+0x5e/0x100 pages=512 vmalloc N0=512
# 0xffffc90000201000-0xffffc90000206000   20480 pcpu_alloc+0x3fa/0x7e0 pages=4 vmalloc N0=4
```

Key fields:
- **Address range**: Virtual address start-end
- **Size**: In bytes
- **Caller**: Function that allocated (useful for debugging leaks)
- **pages=N**: Number of physical pages backing this allocation
- **vmalloc**: Allocation type (vs ioremap, vmap)
- **N0=N**: NUMA node distribution

### Check vmalloc Statistics

```bash
# Total vmalloc pages in use
grep VmallocUsed /proc/meminfo

# vmalloc address space limits
grep Vmalloc /proc/meminfo
# VmallocTotal:   34359738367 kB  (address space size)
# VmallocUsed:           0 kB     (may show 0 on modern kernels)
# VmallocChunk:          0 kB     (largest contiguous free block)
```

### Run the Test Module

The kernel includes `test_vmalloc` for testing vmalloc functionality:

```bash
# Build the test module (in kernel tree)
make M=lib/ lib/test_vmalloc.ko

# Load with specific tests (in QEMU or on test machine)
# Test mask bits: see lib/test_vmalloc.c for all options
modprobe test_vmalloc run_test_mask=0xFFFF

# Or via virtme-ng for quick testing
virtme-ng --append 'test_vmalloc.run_test_mask=0xFFFF'

# Check results
dmesg | grep test_vmalloc
```

### Key Code Locations

| Function | File:Line | What It Does |
|----------|-----------|--------------|
| `vmalloc()` | [`mm/vmalloc.c:3510`](https://elixir.bootlin.com/linux/latest/source/mm/vmalloc.c#L3510) | Main entry point |
| `__vmalloc_node_range()` | [`mm/vmalloc.c:3380`](https://elixir.bootlin.com/linux/latest/source/mm/vmalloc.c#L3380) | Core allocation logic |
| `vfree()` | [`mm/vmalloc.c:2950`](https://elixir.bootlin.com/linux/latest/source/mm/vmalloc.c#L2950) | Free vmalloc memory |
| `find_vmap_area()` | [`mm/vmalloc.c:820`](https://elixir.bootlin.com/linux/latest/source/mm/vmalloc.c#L820) | RBTree lookup |
| `vrealloc()` | [`mm/vmalloc.c:3600`](https://elixir.bootlin.com/linux/latest/source/mm/vmalloc.c#L3600) | Resize allocation |

*Note: Line numbers are approximate and vary by kernel version. Use [Bootlin Elixir](https://elixir.bootlin.com/linux/latest/source/mm/vmalloc.c) for current code.*

### Write a Simple Test

```c
// In a kernel module or via BPF
#include <linux/vmalloc.h>

void test_vmalloc_basic(void)
{
    void *ptr;

    // Allocate 1MB virtually contiguous
    ptr = vmalloc(1024 * 1024);
    if (!ptr) {
        pr_err("vmalloc failed\n");
        return;
    }

    // Use it...
    memset(ptr, 0, 1024 * 1024);

    // Free it
    vfree(ptr);
}
```

---

## References

### Key Commits
| Commit | Kernel | Description |
|--------|--------|-------------|
| [1da177e4c3f4](https://git.kernel.org/linus/1da177e4c3f4) | [v2.6.12](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v2.6.12) | Initial git history |
| [db64fe02258f](https://git.kernel.org/linus/db64fe02258f) | [v2.6.28](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v2.6.28) | RBTree + lazy TLB rewrite |
| [121e6f3258fe](https://git.kernel.org/linus/121e6f3258fe) | [v5.13](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v5.13) | Huge page support |
| [3ddc2fefe6f3](https://git.kernel.org/linus/3ddc2fefe6f3) | [v6.12](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tag/?h=v6.12) | vrealloc introduction |

### Code
- `mm/vmalloc.c` - Implementation
- `include/linux/vmalloc.h` - API

### Related
- [vrealloc](vrealloc.md) - Resizing allocations
- [overview](overview.md) - Memory management overview
