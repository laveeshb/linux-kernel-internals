# Process Address Space

> How Linux manages virtual memory for processes

## What Is the Process Address Space?

Each process has its own virtual address space - a private view of memory that the kernel maps to physical memory. This isolation means processes can't access each other's memory (without explicit sharing).

```
Process A's View              Process B's View
┌─────────────────┐          ┌─────────────────┐
│ Stack      ↓    │          │ Stack      ↓    │
├─────────────────┤          ├─────────────────┤
│                 │          │                 │
│   (unmapped)    │          │   (unmapped)    │
│                 │          │                 │
├─────────────────┤          ├─────────────────┤
│ Heap       ↑    │          │ Heap       ↑    │
├─────────────────┤          ├─────────────────┤
│ BSS (zero)      │          │ BSS (zero)      │
├─────────────────┤          ├─────────────────┤
│ Data            │          │ Data            │
├─────────────────┤          ├─────────────────┤
│ Text (code)     │          │ Text (code)     │
└─────────────────┘          └─────────────────┘
   0x0                          0x0

Same virtual addresses, different physical memory
```

## Virtual Memory Areas (VMAs)

The address space is divided into regions called VMAs. Each VMA describes a contiguous range with consistent properties.

### VMA Structure

```c
struct vm_area_struct {
    unsigned long vm_start;      /* Start address */
    unsigned long vm_end;        /* End address (exclusive) */
    pgprot_t vm_page_prot;       /* Access permissions */
    unsigned long vm_flags;      /* Flags (VM_READ, VM_WRITE, etc.) */
    struct file *vm_file;        /* Backing file (or NULL) */
    unsigned long vm_pgoff;      /* Offset in file */
    struct mm_struct *vm_mm;     /* Owning mm_struct */
    /* ... */
};
```

### VMA Types

| Type | vm_file | Description |
|------|---------|-------------|
| Anonymous | NULL | Heap, stack, mmap(MAP_ANONYMOUS) |
| File-backed | Set | mmap'd files, executables, libraries |
| Shared | Set + VM_SHARED | Shared memory regions |

### Viewing VMAs

```bash
# View process memory map
cat /proc/<pid>/maps

# Example output:
# address          perms offset   dev   inode   pathname
# 00400000-00452000 r-xp 00000000 08:01 1234    /bin/bash
# 00651000-00652000 r--p 00051000 08:01 1234    /bin/bash
# 00652000-0065b000 rw-p 00052000 08:01 1234    /bin/bash
# 0065b000-00660000 rw-p 00000000 00:00 0       [heap]
# 7f8a0000-7f8a2000 rw-p 00000000 00:00 0
# 7ffff000-80000000 rw-p 00000000 00:00 0       [stack]

# Detailed view with sizes
cat /proc/<pid>/smaps
```

## The mmap() System Call

`mmap()` creates new VMAs - it's how processes request virtual memory.

### Basic Usage

```c
#include <sys/mman.h>

/* Anonymous mapping (like malloc for large allocations) */
void *ptr = mmap(NULL, size, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

/* File mapping */
int fd = open("file.dat", O_RDONLY);
void *ptr = mmap(NULL, size, PROT_READ,
                 MAP_PRIVATE, fd, 0);

/* Unmap when done */
munmap(ptr, size);
```

### mmap Flags

| Flag | Description |
|------|-------------|
| `MAP_PRIVATE` | Copy-on-write, changes not written to file |
| `MAP_SHARED` | Changes visible to other processes and written to file |
| `MAP_ANONYMOUS` | Not backed by file, zero-initialized |
| `MAP_FIXED` | Use exact address (dangerous) |
| `MAP_POPULATE` | Pre-fault pages (avoid later faults) |
| `MAP_HUGETLB` | Use huge pages |
| `MAP_LOCKED` | Lock in RAM (like mlock) |

### Protection Flags

| Flag | Description |
|------|-------------|
| `PROT_READ` | Pages can be read |
| `PROT_WRITE` | Pages can be written |
| `PROT_EXEC` | Pages can be executed |
| `PROT_NONE` | Pages cannot be accessed |

## Address Space Layout

### Traditional Layout (32-bit)

```
┌──────────────────┐ 0xFFFFFFFF (4GB)
│  Kernel Space    │
├──────────────────┤ 0xC0000000 (3GB) - TASK_SIZE
│  Stack     ↓     │
├──────────────────┤
│  mmap region ↓   │
├──────────────────┤
│                  │
├──────────────────┤
│  Heap       ↑    │ brk
├──────────────────┤
│  BSS             │
├──────────────────┤
│  Data            │
├──────────────────┤
│  Text            │
└──────────────────┘ 0x08048000
```

### Modern Layout (64-bit with ASLR)

```
┌──────────────────┐ 0xFFFFFFFFFFFFFFFF
│  Kernel Space    │
├──────────────────┤ 0x7FFFFFFFFFFF (128TB user limit)
│  Stack     ↓     │ (randomized)
├──────────────────┤
│                  │
├──────────────────┤
│  mmap region     │ (randomized)
│  (libs, anon)    │
├──────────────────┤
│                  │
├──────────────────┤
│  Heap       ↑    │ (randomized)
├──────────────────┤
│  BSS/Data/Text   │ (randomized)
└──────────────────┘ 0x0
```

### ASLR (Address Space Layout Randomization)

ASLR randomizes memory layout to make exploits harder:

```bash
# Check ASLR setting
cat /proc/sys/kernel/randomize_va_space
# 0 = disabled
# 1 = stack/mmap randomized
# 2 = + heap randomized (full ASLR)
```

## Memory Management Structures

### mm_struct

Each address space is described by one `mm_struct` (threads within a process share the same mm_struct via `CLONE_VM`):

```c
struct mm_struct {
    struct maple_tree mm_mt;     /* VMA tree (replaced rb_root in v6.1) */
    unsigned long task_size;     /* Size of user address space */
    pgd_t *pgd;                  /* Page Global Directory */
    atomic_t mm_users;           /* Processes sharing this mm */
    atomic_t mm_count;           /* References to struct */
    unsigned long start_code, end_code;   /* Text segment */
    unsigned long start_data, end_data;   /* Data segment */
    unsigned long start_brk, brk;         /* Heap */
    unsigned long start_stack;            /* Stack start */
    unsigned long mmap_base;              /* mmap region base */
    /* ... */
};
```

### VMA Organization

VMAs were stored in a red-black tree until v6.1, then switched to a maple tree for better performance:

```
Pre-v6.1: Red-Black Tree     v6.1+: Maple Tree
       [VMA]                    [Maple Node]
      /     \                   /    |    \
   [VMA]   [VMA]             [VMA] [VMA] [VMA]
   /   \                      ...
[VMA] [VMA]
```

**Commit**: [d4af56c5c7c6](https://git.kernel.org/linus/d4af56c5c7c6) ("mm: start tracking VMAs with maple tree") | [LKML](https://lore.kernel.org/linux-mm/20220822150128.1562046-1-Liam.Howlett@oracle.com/)

## Demand Paging

Pages aren't allocated until accessed. This is called demand paging or lazy allocation.

```
mmap() called:
┌───────────────────────┐
│ VMA created           │
│ No physical pages yet │
└───────────────────────┘

First access:
┌───────────────────────┐
│ Page fault            │
│     ↓                 │
│ Allocate page         │
│     ↓                 │
│ Update page table     │
│     ↓                 │
│ Resume execution      │
└───────────────────────┘
```

### Fault Types

| Fault | Cause | Resolution |
|-------|-------|------------|
| Minor | Page in memory but PTE needs update | Update PTE (includes COW breaks, access/dirty bit updates) |
| Major | Page not in memory | Read from file/swap |
| Invalid | Bad access (SIGSEGV) | Kill process |

## Copy-on-Write (COW)

When `fork()` creates a child, pages are shared until written:

```
After fork():
Parent          Child
  │               │
  └───────┬───────┘
          │
          ▼
    [Shared Page]  (read-only)

After child writes:
Parent          Child
  │               │
  ▼               ▼
[Original]    [Copy]
```

This makes `fork()` fast - page tables are duplicated (pointing to the same physical pages, now marked read-only), but the actual data pages are not copied. Only when either process writes does a copy occur.

## Common Operations

### brk/sbrk (Heap)

```c
/* Expand heap */
void *old_brk = sbrk(0);
brk(old_brk + 4096);  /* Add 4KB to heap */

/* malloc typically uses mmap for large allocations */
```

### mprotect (Change Permissions)

```c
/* Make region read-only */
mprotect(ptr, size, PROT_READ);

/* Make region executable (JIT) */
mprotect(ptr, size, PROT_READ | PROT_EXEC);
```

### mlock (Pin in RAM)

```c
/* Prevent page from being swapped */
mlock(ptr, size);

/* Unlock */
munlock(ptr, size);

/* Lock all current and future pages */
mlockall(MCL_CURRENT | MCL_FUTURE);
```

### mremap (Resize Mapping)

```c
/* Grow or shrink a mapping */
void *new_ptr = mremap(ptr, old_size, new_size, MREMAP_MAYMOVE);
```

## Evolution

### Original Design (1991)

Simple linear list of VMAs. Worked for small address spaces.

### Red-Black Tree (v2.4.10, 2001)

VMA lookup changed from O(n) to O(log n) using rb-tree.

### Maple Tree (v6.1, 2022)

**Commit**: [d4af56c5c7c6](https://git.kernel.org/linus/d4af56c5c7c6)

Replaced rb-tree with maple tree for better cache behavior and RCU-safe lookups.

### Per-VMA Locks (v6.4, 2023)

**Commit**: [5e31275cc997](https://git.kernel.org/linus/5e31275cc997) ("mm: add per-VMA lock and helper functions to control it")

Fine-grained locking per VMA instead of mmap_lock for entire mm, improving scalability for page fault handling.

## Debugging

### /proc Interface

```bash
# Memory map
cat /proc/<pid>/maps

# Detailed with RSS, PSS, etc.
cat /proc/<pid>/smaps

# Summary
cat /proc/<pid>/smaps_rollup

# Memory stats
cat /proc/<pid>/status | grep -i vm
# VmPeak: Peak virtual memory
# VmSize: Current virtual memory
# VmRSS:  Resident set size
# VmData: Data segment
# VmStk:  Stack
```

### Tracing

```bash
# Trace mmap calls
strace -e mmap,munmap,mprotect ./program

# Trace page faults
echo 1 > /sys/kernel/debug/tracing/events/exceptions/page_fault_user/enable
```

## Common Issues

### Virtual Memory Exhaustion

Process hits `TASK_SIZE` limit or `vm.max_map_count`.

```bash
# View/set max VMAs per process
cat /proc/sys/vm/max_map_count
echo 65530 > /proc/sys/vm/max_map_count
```

### Memory Fragmentation

Many small mappings prevent large allocations.

**Solution**: Use larger mappings, reduce mmap/munmap churn.

### mmap_lock Contention

Multiple threads fighting for mm->mmap_lock.

**Solution**: Upgrade to v6.4+ for per-VMA locks, or reduce mmap operations.

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/mmap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mmap.c) | mmap implementation |
| [`mm/memory.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memory.c) | Page fault handling |
| [`include/linux/mm_types.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mm_types.h) | mm_struct, vm_area_struct |

### Kernel Documentation

- [`Documentation/mm/process_addrs.rst`](https://docs.kernel.org/mm/process_addrs.html)

### Related

- [page-tables](page-tables.md) - How VMAs are backed by page tables
- [reclaim](reclaim.md) - Anonymous vs file-backed page handling
- [thp](thp.md) - Huge pages in VMAs
