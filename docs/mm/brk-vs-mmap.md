# brk vs mmap: Two Ways to Get Memory

> The kernel provides two mechanisms; userspace allocators choose between them

## Kernel Mechanisms vs Userspace Policy

The kernel provides two system calls for obtaining memory:

1. **`brk()`** - Extend a single contiguous heap region
2. **`mmap()`** - Create arbitrary memory mappings anywhere

The kernel doesn't care which one you use. It just implements both and lets userspace decide. This document covers both the kernel mechanisms and how glibc uses them - clearly separated.

## The Two Approaches

### brk(): The Heap

`brk()` moves the "program break" - historically called the end of the "data segment," though on modern systems it's just another VMA that grows upward (see `do_brk_flags()` in [mm/vma.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vma.c)):

```
┌─────────────────┐ High addresses
│      Stack      │
│        ↓        │
│                 │
│                 │
│        ↑        │
│      Heap       │
├─────────────────┤ ← Program break (brk)
│   BSS (zeros)   │
│   Data (init)   │
│   Text (code)   │
└─────────────────┘ Low addresses
```

```c
// The brk syscall sets the program break
#include <unistd.h>
#include <sys/syscall.h>

unsigned long current_brk = syscall(SYS_brk, 0);  // Get current break
syscall(SYS_brk, current_brk + 4096);             // Extend by 4KB
// New memory is between old and new break

// Note: sbrk() is the libc wrapper; brk is the actual syscall
```

**Characteristics:**
- Single contiguous region
- Grows upward
- Cannot release memory in the middle
- Lower overhead than mmap (but still a syscall - involves VMA updates, security checks, rlimit checks)

### mmap(): Anonymous Mappings

`mmap()` creates a new region anywhere in the address space:

```
┌─────────────────┐
│      Stack      │
│                 │
│  ┌───────────┐  │
│  │  mmap #2  │  │  ← Independent regions
│  └───────────┘  │
│                 │
│  ┌───────────┐  │
│  │  mmap #1  │  │
│  └───────────┘  │
│                 │
│      Heap       │
├─────────────────┤
│   Text/Data     │
└─────────────────┘
```

```c
void *p = mmap(NULL, size,
               PROT_READ | PROT_WRITE,
               MAP_PRIVATE | MAP_ANONYMOUS,
               -1, 0);
```

See [`do_mmap()`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mmap.c) for the kernel implementation.

**Characteristics:**
- Arbitrary location in address space
- Each mapping independent
- Can release (`munmap`) individually
- More overhead per allocation

## Userspace Policy: How glibc Chooses

This is where userspace makes its own decisions - the kernel isn't involved.

glibc's malloc uses a **dynamic threshold** that adjusts based on allocation patterns:

```
Allocation size < threshold → brk (main arena heap)
Allocation size ≥ threshold → mmap
```

The threshold starts at 128KB and can grow up to 32MB (on 64-bit systems) as the allocator observes large allocations being freed. This dynamic behavior was added to reduce mmap/munmap syscall overhead for programs with consistent large allocation patterns.

**Note:** These thresholds are `glibc`-specific. Other C libraries (`musl`, `bionic`) use different strategies, and some distributions patch `glibc` defaults.

```c
// Simplified glibc logic
void *malloc(size_t size) {
    if (size < mmap_threshold) {
        return allocate_from_arena();  // Main arena uses brk
    } else {
        return mmap(...);              // Direct mmap
    }
}
```

Check or override the threshold:
```bash
# Default starts at 128KB (131072 bytes), grows dynamically
# Can disable dynamic behavior and set fixed threshold:
$ MALLOC_MMAP_THRESHOLD_=65536 ./myprogram

# Or in code:
mallopt(M_MMAP_THRESHOLD, 65536);
```

See [glibc malloc tunables](https://www.gnu.org/software/libc/manual/html_node/Memory-Allocation-Tunables.html) for details.

## Why the Threshold?

### Small allocations → brk (heap)

**Pros:**
- Lower syscall overhead (glibc extends heap in large chunks, serves many mallocs per brk call)
- Good locality (allocations are adjacent)
- Fast allocation from free lists

**Cons:**
- Memory fragmentation over time
- Harder to return memory to OS (requires free space at top of heap)

### Large allocations → mmap

**Pros:**
- Memory returned to OS immediately on free (`munmap()`)
- No heap fragmentation from large blocks
- Predictable cleanup

**Cons:**
- Per-allocation syscall overhead
- TLB pressure (each mapping needs entries)
- Potential address space fragmentation

## The Fragmentation Problem

Consider this scenario with brk-only allocation:

```
Initial heap:
[  A  ][  B  ][  C  ][  D  ]
        └─ free B ─┘

After free(B):
[  A  ][hole][  C  ][  D  ]
       └─ Can't return to OS!

Even if C and D are freed:
[  A  ][          free           ]
       └─ Still can't shrink brk past A
```

With mmap for large allocations:
```
Heap: [  A  ][ B ][ C ]   (small allocations)

mmap regions:
[ Large D ]   ← munmap() returns directly to OS
[ Large E ]   ← Independent of heap
```

## Real-World Example

```c
#include <stdlib.h>
#include <stdio.h>

int main() {
    // Small allocation - goes to heap (brk)
    void *small = malloc(1024);
    printf("Small (1KB): %p\n", small);

    // Large allocation - uses mmap
    void *large = malloc(256 * 1024);
    printf("Large (256KB): %p\n", large);

    // Notice the address difference
    // small: near heap (lower address)
    // large: mmap region (higher, separate)

    free(large);  // glibc calls munmap() → returns to OS
    free(small);  // Goes to malloc's free list (no syscall)

    return 0;
}
```

Trace the syscalls:
```bash
$ strace -e brk,mmap,munmap ./test
brk(NULL)                               = 0x55a8b8c49000
brk(0x55a8b8c6a000)                     = 0x55a8b8c6a000  # Heap setup
mmap(NULL, 266240, ..., MAP_ANONYMOUS)  = 0x7f8b12345000  # Large alloc
munmap(0x7f8b12345000, 266240)          = 0              # Large free
```

## When glibc Returns Memory

### Heap (brk) memory:

- Freed blocks go to malloc's free list for reuse
- `glibc` automatically trims the heap when free space at the top exceeds `M_TRIM_THRESHOLD` (default 128KB)
- `malloc_trim()` can force trimming, but only releases memory at the top of the heap
- Memory in the middle of the heap cannot be returned to the OS

### mmap memory:

- `munmap()` on free → immediate return to OS
- RSS decreases visibly
- Clean release regardless of allocation order

```c
// Force heap trimming (only affects top of heap)
#include <malloc.h>
malloc_trim(0);  // Returns free memory at heap top to OS

// Alternatively, use MADV_DONTNEED on specific ranges
madvise(addr, len, MADV_DONTNEED);  // Release pages, keep mapping
```

## Tuning the Threshold

```c
#include <malloc.h>

// Increase threshold: fewer mmaps, bigger heap
mallopt(M_MMAP_THRESHOLD, 512 * 1024);  // 512KB

// Decrease threshold: more mmaps, smaller heap
mallopt(M_MMAP_THRESHOLD, 64 * 1024);   // 64KB
```

Or via environment:
```bash
# All allocations ≥64KB use mmap
export MALLOC_MMAP_THRESHOLD_=65536
./myprogram
```

## Trade-offs Summary

| Factor | brk (heap) | mmap |
|--------|------------|------|
| Syscall overhead | Low | Per-allocation |
| Memory return to OS | Difficult | Immediate |
| Fragmentation | Can accumulate | Per-region only |
| Locality | Good | Scattered |
| TLB pressure | Low | Higher |
| Best for | Many small allocs | Large allocs |

## Historical Context

These two system calls come from different eras and were designed for different purposes.

### brk(): The Original (1979)

`brk()` appeared in **Version 7 AT&T Unix (1979)** - one of the earliest Unix system calls. In the 1970s, address spaces were tiny (often 64KB total). The "program break" literally divided the program's code from its data, and you grew the heap by moving this boundary upward.

For over a decade, `brk()` was the **only** way for applications to acquire heap memory. Every `malloc()` implementation used it.

The call is now considered a historical artifact:
- Marked **LEGACY** in Single UNIX Specification v2
- **Removed** from POSIX.1-2001
- Linux keeps it for compatibility, but modern allocators use it less

### mmap(): File Mapping First (1983-1988)

`mmap()` was designed for a completely different purpose: **memory-mapped files**.

Timeline:
- **1983 (4.2BSD)**: API designed and documented, but not implemented
- **~1988 (SunOS 4.0)**: First working implementation by Sun Microsystems
- **4.3BSD-Reno**: BSD implementation (based on Mach VM, after Sun refused to share their code)
- **4.4BSD**: Official BSD release with mmap

The original use case was mapping file contents directly into memory - read a file by accessing memory addresses instead of calling `read()`. This had nothing to do with heap allocation.

### MAP_ANONYMOUS: The Game Changer

The feature that made `mmap()` useful for heap allocation: **`MAP_ANONYMOUS`** (or `MAP_ANON`).

- Allows memory mappings **not backed by any file**
- Before this existed, the workaround was `mmap("/dev/zero", ...)`
- **`MAP_ANONYMOUS` with `MAP_PRIVATE`**: Available in early Linux (inherited from BSD)

#### The "Monstrosity" That Took Years

**`MAP_ANONYMOUS` with `MAP_SHARED`** has a contentious history:

**July 1996**: A.N. Kuznetsov [discovered](https://lkml.iu.edu/hypermail/linux/kernel/9607.3/0055.html) Linux 2.0 lacked this feature:
> *"Unpleasant discovery, 2.0 has no shared anonymous mmap ??? I do not believe to my eyes..."*

**Linus Torvalds [replied](https://lkml.iu.edu/hypermail/linux/kernel/9607.3/0107.html)** dismissively:
> *"a monstrosity (even the name is a oxymoron [sic]), and it's hard to implement to boot"*
> *"definitely 2.1, if even that"*

He recommended SysV shared memory instead and wanted to "avoid shared anonymous mmap altogether."

**2000-2001**: **Christoph Rohland** (SAP AG) finally implemented the solution in the 2.3/2.4 development cycle by creating the **`shmem`/`tmpfs`** filesystem. The clever trick: Linux creates an "artificial file-backing for anonymous pages using a RAM-based filesystem." Shared anonymous mappings aren't truly anonymous - they're backed by an invisible `tmpfs` file.

*Note: Linux 2.4 predates git (kernel switched to git in April 2005 with 2.6.12). No commit IDs exist for pre-git history.*

Once `MAP_ANONYMOUS` existed, allocators could use `mmap()` for large allocations with a key advantage: `munmap()` returns memory to the OS immediately, unlike `brk()` where you can only shrink the heap from the top.

### Why Both Survive

Today we have two mechanisms because they evolved for different purposes:

| Era | Mechanism | Purpose |
|-----|-----------|---------|
| 1979 | `brk()` | Grow a single heap (the only option) |
| 1983-88 | `mmap()` | Map files into memory |
| 1990s+ | `mmap()` + `MAP_ANONYMOUS` | Alternative to `brk()` for heap |

Modern allocators like `glibc`'s `malloc` use **both**: `brk()` for the main arena (small allocations benefit from locality), `mmap()` for large allocations (clean release back to OS). This isn't elegant design - it's historical accident turned pragmatic engineering.

## Try It Yourself

```bash
# Watch brk vs mmap in action
strace -e brk,mmap,munmap ./myprogram

# See heap size
cat /proc/<pid>/maps | grep heap

# See all anonymous mappings
cat /proc/<pid>/maps | grep anon

# Compare RSS before/after large allocation free
watch -n 0.5 "grep -E 'VmRSS|VmData' /proc/<pid>/status"
```

## Further Reading

- [glibc malloc internals](https://sourceware.org/glibc/wiki/MallocInternals) - How glibc manages memory
- [mallopt(3) man page](https://man7.org/linux/man-pages/man3/mallopt.3.html) - Tuning options
- [brk(2) man page](https://man7.org/linux/man-pages/man2/brk.2.html) - System call documentation
- [LWN: malloc() tutorial](https://lwn.net/Articles/250967/) - Historical context
