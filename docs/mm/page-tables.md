# Page Tables

> Mapping virtual addresses to physical memory

## What Are Page Tables?

Page tables are hierarchical data structures that map virtual addresses (what programs see) to physical addresses (actual RAM locations). The MMU (Memory Management Unit) hardware uses them to translate every memory access.

```
Virtual Address                Physical Address
0x7fff12340000   ──────────>   0x1a2b3c000
       │                              │
       │    Page Table Walk           │
       └──────────────────────────────┘
```

## The Five-Level Hierarchy

Linux uses a five-level page table hierarchy (since v4.14 for x86-64):

```
+-----+
| PGD |  Page Global Directory
+-----+
   │
   v
+-----+
| P4D |  Page Level 4 Directory (5-level paging only)
+-----+
   │
   v
+-----+
| PUD |  Page Upper Directory
+-----+
   │
   v
+-----+
| PMD |  Page Middle Directory
+-----+
   │
   v
+-----+
| PTE |  Page Table Entry
+-----+
   │
   v
 PAGE    Physical memory page
```

### Level Details

| Level | Type | Bits (x86-64) | Entries | Maps |
|-------|------|---------------|---------|------|
| PGD | `pgd_t` | 47-39 (4-level) or 56-48 (5-level) | 512 | 512GB or 128PB |
| P4D | `p4d_t` | 47-39 | 512 | 512GB (folded if 4-level) |
| PUD | `pud_t` | 38-30 | 512 | 1GB |
| PMD | `pmd_t` | 29-21 | 512 | 2MB |
| PTE | `pte_t` | 20-12 | 512 | 4KB |

### Address Translation (x86-64, 4-level)

A 48-bit virtual address breaks down as:

```
 47      39 38      30 29      21 20      12 11       0
+----------+----------+----------+----------+----------+
| PGD idx  | PUD idx  | PMD idx  | PTE idx  |  Offset  |
+----------+----------+----------+----------+----------+
   9 bits     9 bits     9 bits     9 bits    12 bits
```

## Page Table Folding

Not all architectures need all five levels. Linux handles this through **folding** - unused levels are compile-time optimized away.

| Architecture | Levels | Notes |
|--------------|--------|-------|
| x86-64 (LA57) | 5 | 57-bit virtual addresses |
| x86-64 (standard) | 4 | 48-bit virtual addresses |
| x86-32 (PAE) | 3 | 36-bit physical addresses |
| x86-32 | 2 | Original 32-bit |
| ARM64 | 3-4 | Configurable |

When a level is folded, functions like `p4d_offset()` become no-ops that return the input unchanged.

## Key Data Structures

### Per-Process Page Tables

Each process has its own page tables via `mm_struct`:

```c
struct mm_struct {
    pgd_t *pgd;              /* Top-level page table */
    atomic_t mm_users;       /* Users of this mm */
    atomic_t mm_count;       /* References to struct */
    /* ... */
};
```

The kernel has a single `swapper_pg_dir` for kernel mappings, shared across all processes.

### Page Table Entry Format (x86-64 specific)

```
 63    62    52 51                           12 11  9 8 7 6 5 4 3 2 1 0
+----+--------+-------------------------------+-----+-+-+-+-+-+-+-+-+-+
| XD | (avail)|        Physical Address       |avail|G|S|D|A|C|W|U|W|P|
+----+--------+-------------------------------+-----+-+-+-+-+-+-+-+-+-+
  │                        │                          │ │ │ │ │ │ │ │ │
  │                        │                          │ │ │ │ │ │ │ │ └─ Present
  │                        │                          │ │ │ │ │ │ │ └─── Writable
  │                        │                          │ │ │ │ │ │ └───── User accessible
  │                        │                          │ │ │ │ │ └─────── Write-through
  │                        │                          │ │ │ │ └───────── Cache disable
  │                        │                          │ │ │ └─────────── Accessed
  │                        │                          │ │ └───────────── Dirty
  │                        │                          │ └─────────────── Page size (huge)
  │                        │                          └───────────────── Global
  │                        └──────────────────────────────────────────── PFN
  └───────────────────────────────────────────────────────────────────── Execute disable
```

## Page Faults

When the MMU can't translate an address, it triggers a **page fault**. The kernel handles this in `handle_mm_fault()`:

```
Page Fault
    │
    v
handle_mm_fault()
    │
    v
__handle_mm_fault()
    │
    ├── pgd_offset() ─> p4d_alloc()
    ├── p4d_offset() ─> pud_alloc()
    ├── pud_offset() ─> pmd_alloc()
    ├── pmd_offset() ─> pte_alloc()
    │
    v
handle_pte_fault()
    │
    ├── do_read_fault()    (file read)
    ├── do_cow_fault()     (copy-on-write)
    └── do_shared_fault()  (shared mapping)
```

### Fault Types

| Type | Cause | Resolution |
|------|-------|------------|
| Minor | Page in memory, PTE not set | Update PTE |
| Major | Page not in memory | Read from disk/swap |
| Invalid | Bad address or permissions | SIGSEGV |

## TLB (Translation Lookaside Buffer)

The TLB caches recent translations. Without it, every memory access would require multiple page table lookups.

### TLB Flush Operations

```c
/* Flush single page */
flush_tlb_page(vma, addr);

/* Flush range */
flush_tlb_range(vma, start, end);

/* Flush entire mm */
flush_tlb_mm(mm);
```

TLB flushes are expensive on SMP - they require IPIs (Inter-Processor Interrupts) to all CPUs running the affected process.

## Huge Pages

Higher-level entries can map large pages directly, skipping lower levels:

| Level | Page Size | Use Case |
|-------|-----------|----------|
| PUD | 1GB | Large databases, VMs |
| PMD | 2MB | General large allocations |
| PTE | 4KB | Default |

```c
/* Check if PMD maps a huge page */
if (pmd_large(*pmd)) {
    /* 2MB page, no PTE walk needed */
}
```

Benefits:
- Fewer TLB entries needed
- Reduced page table memory
- Fewer page faults

Trade-offs:
- Internal fragmentation
- Allocation challenges

## History

### Origins (1991-1994)

Early Linux on i386 used two-level page tables (PGD + PTE). The `swapper_pg_dir` was the top-level Page Global Directory, not a single flat table. The i386 hardware dictated this structure.

### Three-Level (v2.3.23, 1999)

Added PMD for PAE (Physical Address Extension) on x86, enabling >4GB physical memory on 32-bit.

### Four-Level (v2.6.11, 2005)

Added PUD for x86-64's 48-bit virtual address space. This predates git history (kernel moved to git at v2.6.12).

### Five-Level (v4.14, 2017)

**Commit**: [77ef56e4f0fb](https://git.kernel.org/linus/77ef56e4f0fb) ("x86: Enable 5-level paging support via CONFIG_X86_5LEVEL=y")

Added P4D for 57-bit virtual addresses (128PB), needed for machines with >64TB physical memory.

## Try It Yourself

### View Process Page Tables

```bash
# Page table stats for a process
cat /proc/<pid>/smaps | grep -E "Size|Rss|Pss"

# Detailed page mapping
cat /proc/<pid>/pagemap  # Binary format

# Parse with tools
pagemap <pid> <address>
```

### Check TLB Flushes

```bash
# TLB flush statistics
cat /proc/vmstat | grep tlb

# Trace TLB flushes
echo 1 > /sys/kernel/debug/tracing/events/tlb/tlb_flush/enable
cat /sys/kernel/debug/tracing/trace_pipe
```

### Check Huge Page Usage

```bash
# System huge page stats
cat /proc/meminfo | grep -i huge

# Per-process huge pages
cat /proc/<pid>/smaps | grep -i huge
```

## Common Issues

### TLB Shootdown Storms

Heavy `mprotect()` or `munmap()` causes excessive IPIs.

**Debug**: Check `/proc/interrupts` for TLB IPI counts.

### Page Table Memory Overhead

Sparse address spaces waste page table memory.

**Debug**: Check `PageTables` in `/proc/meminfo`.

### Huge Page Allocation Failures

Can't allocate huge pages due to fragmentation.

**Solutions**:
- Reserve at boot: `hugepages=N`
- Enable THP: `/sys/kernel/mm/transparent_hugepage/enabled`
- Compact memory: `echo 1 > /proc/sys/vm/compact_memory`

## References

### Key Code

| File | Description |
|------|-------------|
| [`include/linux/pgtable.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pgtable.h) | Generic page table API |
| [`arch/x86/include/asm/pgtable.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/pgtable.h) | x86 page table definitions |
| [`mm/memory.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memory.c) | Page fault handling |

### Kernel Documentation

- [`Documentation/mm/page_tables.rst`](https://docs.kernel.org/mm/page_tables.html)

### Related

- [overview](overview.md) - Memory management overview
- [glossary](glossary.md) - PFN, TLB, MMU definitions
