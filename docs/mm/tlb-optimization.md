# TLB Optimization Techniques

> How the Linux kernel minimizes the cost of keeping Translation Lookaside Buffers coherent across CPUs

## Key Source Files

| File | Purpose |
|------|---------|
| `arch/x86/include/asm/tlbflush.h` | `flush_tlb_mm()`, `flush_tlb_range()`, `flush_tlb_page()`, `struct tlb_state`, `struct flush_tlb_info` |
| `arch/x86/mm/tlb.c` | TLB flush batching, lazy TLB mode, PCID/ASID management, `flush_tlb_mm_range()`, `enter_lazy_tlb()`, `switch_mm_irqs_off()` |
| `include/asm-generic/tlb.h` | `struct mmu_gather`, `tlb_gather_mmu()`, `tlb_finish_mmu()`, `tlb_flush_mmu()` |
| `mm/mmu_gather.c` | mmu_gather implementation: `tlb_gather_mmu()`, `tlb_gather_mmu_fullmm()`, `tlb_finish_mmu()`, `tlb_flush_mmu()` |

---

## Why the TLB Matters for Performance

The Translation Lookaside Buffer (TLB) is a small hardware cache that stores recent virtual-to-physical address translations. Without it, every memory access would require a full page-table walk — typically three to five additional memory reads depending on the paging depth.

### The Cost Difference

```
TLB hit:   ~1  cycle    (~0.3 ns)
TLB miss:  ~50 cycles   (~17 ns) + page table walk
Page walk: up to 4 serialized cache misses on a cold hierarchy
```

On modern x86, the L1 dTLB holds 64–96 entries for 4KB pages and 32 entries for 2MB pages. A second-level TLB (STLB) provides 1024–3072 additional entries. These numbers are dwarfed by realistic working sets.

| Working Set | 4KB Pages Needed | TLB Entries Required | Fits in TLB? |
|-------------|-----------------|---------------------|--------------|
| 4MB | 1,024 | 1,024 | No (4x STLB) |
| 1GB | 262,144 | 262,144 | No (256x STLB) |
| 100GB | 26,214,400 | 26,214,400 | No |

Processes with large virtual address spaces, many VMAs, or frequent `mmap()`/`munmap()` activity generate significant TLB pressure. Every stale entry that must be invalidated and every subsequent miss is paid in cycles — and on multi-CPU systems, in IPI latency.

---

## TLB Flush Basics

The kernel must flush TLB entries whenever the underlying mapping changes in a way that could allow a CPU to observe incorrect data:

- **Page unmapped**: a live translation must not be used after the physical page is freed.
- **Permission downgraded**: e.g., write-protecting a page; the old cached read-write entry must be evicted.
- **PTE changed**: any modification to a present PTE that narrows access rights or changes the physical address.

The rule is: *flush before freeing the page, never after*.

### The Three Core Flush Functions (x86)

These are defined in `arch/x86/include/asm/tlbflush.h`. On x86 they are all implemented as thin wrappers around the underlying `flush_tlb_mm_range()`:

```c
/* Flush the entire address space of mm on all CPUs */
#define flush_tlb_mm(mm) \
    flush_tlb_mm_range(mm, 0UL, TLB_FLUSH_ALL, 0UL, true)

/* Flush a range of pages in vma->vm_mm, respecting huge page stride */
#define flush_tlb_range(vma, start, end) \
    flush_tlb_mm_range((vma)->vm_mm, start, end, \
                       ((vma)->vm_flags & VM_HUGETLB) \
                           ? huge_page_shift(hstate_vma(vma)) \
                           : PAGE_SHIFT, true)

/* Flush a single page */
static inline void flush_tlb_page(struct vm_area_struct *vma,
                                   unsigned long a)
{
    flush_tlb_mm_range(vma->vm_mm, a, a + PAGE_SIZE, PAGE_SHIFT, false);
}
```

For kernel mappings, `flush_tlb_kernel_range(start, end)` sends a flush to every CPU — there is no per-process scoping for kernel space.

### IPIs to Remote CPUs

When a mapping changes, every CPU that might have a cached translation must be notified. The kernel uses inter-processor interrupts (IPIs) for this: `flush_tlb_multi()` sends a `flush_tlb_func()` handler to all CPUs in the target `mm_cpumask(mm)`. Each remote CPU then executes an `INVLPG` (single page) or CR3 reload (full flush) to evict the stale entries.

IPI delivery has non-trivial cost: on a loaded system, round-trip latency can be several microseconds. On NUMA systems with many sockets, this cost multiplies.

---

## mmu_gather — Batched TLB Flushing

Naively, unmapping N pages would require N separate TLB flushes. The kernel avoids this with `mmu_gather`, a per-operation accumulator that collects all address ranges to be flushed and delivers a single batched flush at the end.

### The struct

Defined in `include/asm-generic/tlb.h`:

```c
struct mmu_gather {
    struct mm_struct    *mm;

    unsigned long        start;   /* lowest address unmapped */
    unsigned long        end;     /* highest address unmapped */

    unsigned int         fullmm        : 1; /* tearing down entire mm? */
    unsigned int         need_flush_all: 1; /* arch needs full flush */
    unsigned int         freed_tables  : 1; /* freed page table pages */
    unsigned int         delayed_rmap  : 1; /* pending rmap removals */

    /* which page-table levels were cleared */
    unsigned int         cleared_ptes : 1;
    unsigned int         cleared_pmds : 1;
    unsigned int         cleared_puds : 1;
    unsigned int         cleared_p4ds : 1;

    /* VMA flags captured at tlb_start_vma() */
    unsigned int         vma_exec : 1;
    unsigned int         vma_huge : 1;
    unsigned int         vma_pfn  : 1;

    unsigned int         batch_count;

    struct mmu_gather_batch *active;  /* current page-free batch */
    struct mmu_gather_batch  local;   /* on-stack initial batch */
    struct page         *__pages[MMU_GATHER_BUNDLE]; /* small initial array */
};
```

### Lifecycle

The gather lifecycle is three steps, implemented in `mm/mmu_gather.c`:

```
tlb_gather_mmu(tlb, mm)          ← begin gathering; resets range and page list
    |
    | ... page-table walk, PTE clears, tlb_remove_page() calls ...
    | Each cleared PTE updates tlb->start / tlb->end via __tlb_adjust_range()
    |
tlb_finish_mmu(tlb)              ← issue TLB flush, free queued pages
```

`tlb_gather_mmu()` initialises the structure (range reset to `[TASK_SIZE, 0]`, page batch empty) and increments `mm->tlb_flush_pending` to signal that a nested TLB flush may be needed.

`tlb_finish_mmu()` calls `tlb_flush_mmu()`, which in turn:
1. Calls `tlb_flush_mmu_tlbonly()` — issues `flush_tlb_range()` or `flush_tlb_mm()` covering the full accumulated range.
2. Frees all batched pages (`tlb_batch_pages_flush()`).

Finally, `dec_tlb_flush_pending()` balances the counter.

For the full-mm case (`exec`, `exit`), `tlb_gather_mmu_fullmm()` sets `fullmm = 1`. This skips per-VMA range tracking — there is no point narrowing a flush that will cover the entire address space anyway. On architectures with ASIDs, `fullmm` also enables cycling to a new ASID rather than sending IPIs.

### Why Batching Matters

Consider `munmap()` of a 1GB anonymous mapping (262,144 pages). Without batching:

- 262,144 × `flush_tlb_page()` = 262,144 IPI round-trips on an SMP system.
- Each IPI costs ~1–5 µs; total: potentially over a second of IPI overhead.

With `mmu_gather`, the kernel walks all PTEs, accumulates the range `[start, start+1GB)`, then issues **one** `flush_tlb_range()` call. The single IPI flushes the entire range on each remote CPU at once.

!!!tip "Performance tip"
    If your workload performs many small `munmap()` calls in a tight loop, consider batching them into a single larger unmap or replacing them with `madvise(MADV_FREE)`, which defers the actual page release and avoids immediate TLB shootdowns.

---

## Lazy TLB Mode

When a CPU switches from a user-space process to a kernel thread (or another process whose mm differs), it does not immediately need to flush the TLB for the previous mm — there are no user mappings to protect from a kernel thread. Flushing early wastes CPU cycles.

The kernel exploits this with **lazy TLB mode**, tracked via the `is_lazy` flag in `struct tlb_state_shared` (per-CPU, `cpu_tlbstate_shared`):

```c
struct tlb_state_shared {
    bool is_lazy;
};
DECLARE_PER_CPU_SHARED_ALIGNED(struct tlb_state_shared, cpu_tlbstate_shared);
```

### Entering Lazy Mode

`enter_lazy_tlb()` is called by the scheduler when switching to a kernel thread. On x86:

```c
void enter_lazy_tlb(struct mm_struct *mm, struct task_struct *tsk)
{
    if (this_cpu_read(cpu_tlbstate.loaded_mm) == &init_mm)
        return;

    this_cpu_write(cpu_tlbstate_shared.is_lazy, true);
}
```

The CPU's bit in `mm_cpumask(mm)` **remains set** — the CPU is still in the cpumask so it will eventually receive flush IPIs — but the `is_lazy` flag tells the IPI sender it can skip sending unless page tables are being freed.

### Skipping IPIs to Lazy CPUs

In `native_flush_tlb_multi()` (`arch/x86/mm/tlb.c`), the IPI is sent only to CPUs that are actively running the mm:

```c
if (info->freed_tables || mm_in_asid_transition(info->mm))
    on_each_cpu_mask(cpumask, flush_tlb_func, (void *)info, true);
else
    on_each_cpu_cond_mask(should_flush_tlb, flush_tlb_func,
                          (void *)info, 1, cpumask);
```

`should_flush_tlb()` returns `false` for CPUs with `is_lazy == true` (unless page tables are being freed, in which case all CPUs must be flushed to prevent speculative walks of freed memory).

When the lazy CPU next runs user code, `switch_mm_irqs_off()` resets `is_lazy` to `false` and checks `tlb_gen` — if the generation counter has advanced while the CPU was lazy, a full flush is issued at that point.

!!!tip "What this means in practice"
    Idle CPUs and kernel threads on a large machine contribute zero IPI cost for typical page-table changes. The savings scale linearly with the number of CPUs that are in kernel threads or idle at the time of the flush.

---

## Huge Pages and TLB Coverage

A 2MB huge page is mapped by a single PMD-level TLB entry rather than 512 individual 4KB PTE entries. The TLB coverage per entry is 512× larger.

| Working Set | 4KB Page TLB Entries | 2MB Page TLB Entries | Reduction |
|-------------|---------------------|---------------------|-----------|
| 1GB | 262,144 | 512 | 512× |
| 4GB | 1,048,576 | 2,048 | 512× |

This is the primary performance benefit of Transparent Huge Pages (THP): reducing TLB pressure rather than reducing memory usage.

### How the Kernel Tracks Huge-Page Entries

`struct mmu_gather` tracks which page-table levels were cleared during an unmap operation:

```c
unsigned int  cleared_ptes : 1;  /* 4KB pages */
unsigned int  cleared_pmds : 1;  /* 2MB pages */
unsigned int  cleared_puds : 1;  /* 1GB pages */
unsigned int  cleared_p4ds : 1;
```

`tlb_get_unmap_shift()` uses these bits to return the smallest TLB entry size that was unmapped, so `tlb_flush()` can pass the correct `stride_shift` to `flush_tlb_range()`. For huge-page VMAs, `flush_tlb_range()` receives `PMD_SHIFT` (21) as the stride, telling the hardware to flush at 2MB granularity rather than 4KB.

The `vma_huge` bit in `struct mmu_gather` is set by `tlb_update_vma_flags()` when processing a `VM_HUGETLB` VMA, allowing the flush to pass the correct stride even when an intermediate `tlb_flush_mmu()` fires before `tlb_finish_mmu()`.

!!!tip "TLB-aware allocation"
    For workloads with multi-gigabyte working sets, enabling THP (`/sys/kernel/mm/transparent_hugepage/enabled = always`) or using `madvise(MADV_HUGEPAGE)` on hot regions dramatically reduces TLB miss rates. The reduction in TLB pressure typically outweighs any memory fragmentation cost for large, long-lived allocations.

---

## PCID — Process Context Identifiers

Without PCID, every context switch flushes the entire TLB (by reloading CR3 with the new page-table root). With PCID, the TLB is tagged: each entry carries the PCID of the process that created it, and the CPU can keep entries for multiple processes simultaneously. Context switches no longer require a flush — the incoming process simply starts using its own tagged entries.

### PCID in the Hardware

x86 supports up to 4096 PCIDs (12-bit field in CR3). To switch to a process *without* flushing its existing TLB entries, the kernel sets the `CR3_NOFLUSH` bit (bit 63) when writing CR3.

### Linux's ASID Model

Linux does not give each process a globally unique PCID. Instead it maintains a small per-CPU array of **dynamic ASIDs** (`TLB_NR_DYN_ASIDS = 6`), caching the last few processes that ran on each CPU:

```c
struct tlb_context {
    u64 ctx_id;   /* which mm owns this slot */
    u64 tlb_gen;  /* generation when last flushed */
};

struct tlb_state {
    struct mm_struct *loaded_mm;
    u16               loaded_mm_asid;
    u16               next_asid;
    bool              invalidate_other;  /* flush non-loaded ctxs next switch */
    unsigned short    user_pcid_flush_mask;
    struct tlb_context ctxs[TLB_NR_DYN_ASIDS];
    /* ... */
};
DECLARE_PER_CPU_ALIGNED(struct tlb_state, cpu_tlbstate);
```

`choose_new_asid()` scans `ctxs[]` looking for an existing slot whose `ctx_id` matches `next->context.ctx_id`. If found, it checks whether `tlb_gen` is current; if so, `need_flush = false` and the CR3 load uses `CR3_NOFLUSH`:

```c
static inline unsigned long build_cr3_noflush(pgd_t *pgd, u16 asid,
                                               unsigned long lam)
{
    VM_WARN_ON_ONCE(!boot_cpu_has(X86_FEATURE_PCID));
    return build_cr3(pgd, asid, lam) | CR3_NOFLUSH;
}
```

If the generation has advanced (a TLB flush happened while this CPU was running another process), `need_flush = true` and a full CR3 reload (without `CR3_NOFLUSH`) evicts stale entries for that ASID.

### KPTI and Doubled PCIDs

When Kernel Page Table Isolation (KPTI) is active, each mm needs two PCIDs: one for user-space page tables and one for kernel-space. This halves the available PCID space to 2048 effective ASIDs (`PTI_CONSUMED_PCID_BITS = 1`).

### Global ASIDs (INVLPGB)

On AMD processors supporting `INVLPGB` (broadcast TLB invalidation), the kernel can assign a **global ASID** to processes that are simultaneously active on four or more CPUs. A global ASID is identical on every CPU, enabling hardware-assisted remote TLB invalidation without IPIs:

```c
/* From arch/x86/mm/tlb.c */
static void consider_global_asid(struct mm_struct *mm)
{
    if (!cpu_feature_enabled(X86_FEATURE_INVLPGB))
        return;

    if (mm_active_cpus_exceeds(mm, 3))
        use_global_asid(mm);
}
```

`broadcast_tlb_flush()` then uses `invlpgb_flush_user_nr_nosync()` followed by `__tlbsync()` to flush the TLB across all CPUs in hardware, completely eliminating IPI overhead for heavily multi-threaded processes.

!!!tip "PCID benefit at a glance"
    On a workload with frequent context switches between the same small set of processes (e.g., a web server with a fixed worker pool), PCID avoids all TLB flushes on CPUs where the process's ASID slot is still valid and up to date. The savings are proportional to TLB warm-up time per context switch.

---

## TLB Shootdown Cost on NUMA Systems

On multi-socket NUMA machines, a TLB shootdown IPI must cross inter-socket interconnects to reach remote CPUs. These cross-socket IPIs are substantially more expensive than intra-socket ones.

### Cost Anatomy

A TLB shootdown for a single `munmap()` on a 64-CPU, 4-socket machine:

1. **IPI send**: broadcast to up to 63 CPUs, crossing NUMA interconnects.
2. **IPI receive overhead**: each CPU must enter the IPI handler, execute INVLPG or CR3 reload, and return.
3. **Synchronization**: the initiating CPU waits for all acknowledgements before returning from `flush_tlb_multi()`.

The `mmu_gather` batching directly amortises this cost: the number of IPIs is bounded by the number of distinct flush events, not the number of pages unmapped. Regardless of whether 1 or 1,000,000 pages are unmapped in a single `munmap()`, at most one flush IPI round-trip is needed.

### `tlb_single_page_flush_ceiling`

For small ranges, individual `INVLPG` instructions (one per page) are cheaper than a full flush. For larger ranges, a full flush wins. The kernel switches strategies at `tlb_single_page_flush_ceiling` pages (default: 33):

```c
/* arch/x86/mm/tlb.c */
unsigned long tlb_single_page_flush_ceiling __read_mostly = 33;
```

Inside `get_flush_tlb_info()`, if `(end - start) >> stride_shift > tlb_single_page_flush_ceiling`, the range is promoted to `TLB_FLUSH_ALL`.

This threshold is tunable via `/sys/kernel/debug/x86/tlb_single_page_flush_ceiling`.

!!!tip "Reducing shootdown cost"
    - **Avoid frequent small unmaps** in hot paths; coalesce `munmap()` calls over larger ranges.
    - **Use `madvise(MADV_FREE)`** instead of `munmap()` where possible: the kernel defers actual unmapping until memory pressure occurs, avoiding immediate TLB invalidation.
    - **Use `madvise(MADV_DONTNEED)`** to drop page contents without unmapping the VMA, which also defers TLB shootdown work.
    - On workloads with many threads, consider evaluating whether the kernel can use global ASIDs (AMD INVLPGB) to replace IPIs with hardware broadcast flushing.

---

## Kernel TLB Pressure: vmalloc and Global Entries

Kernel virtual memory allocated via `vmalloc()` uses the global page-table region. Kernel mappings are not tagged per-process — they appear in every address space via the shared kernel PGD entries. Flushing a kernel TLB entry requires invalidating it on **every CPU**, regardless of which process is running.

### `flush_tlb_kernel_range()`

```c
void flush_tlb_kernel_range(unsigned long start, unsigned long end)
```

This function sends a flush to every CPU on the system. On a 64-CPU machine, every `vfree()` that triggers a kernel TLB flush costs 63 IPIs. The `_PAGE_GLOBAL` flag on kernel PTEs means these entries are not evicted by normal user-space CR3 reloads, so there is no opportunity to avoid the IPIs.

On processors with `INVLPGB`, `flush_tlb_kernel_range()` uses `invlpgb_flush_addr_nosync()` + `__tlbsync()` instead of IPIs, eliminating the per-CPU interrupt overhead.

### Why vmalloc Is Expensive

```
vmalloc() call path:
  1. Allocate physical pages (GFP_KERNEL)
  2. Find a free range in the vmalloc virtual address space
  3. Map pages into kernel page tables
  4. flush_tlb_kernel_range() → IPI to ALL CPUs

vfree() call path:
  1. Unmap pages from kernel page tables
  2. flush_tlb_kernel_range() → IPI to ALL CPUs
  3. Free physical pages
```

The global flush on every `vmalloc()`/`vfree()` pair makes vmalloc unsuitable for high-frequency allocation in hot paths.

!!!tip "vmalloc guidelines"
    - **Avoid vmalloc in hot paths.** Use `kmalloc()` (slab) for objects under ~128KB; it operates within the direct-mapped region and requires no global TLB invalidation.
    - **For large kernel buffers that are allocated once and reused**, vmalloc is acceptable; the TLB cost is paid once at allocation and deallocation.
    - **`vmalloc_huge()`** uses 2MB huge pages for vmalloc mappings, which reduces the number of kernel TLB entries required and can improve performance for large, persistent vmalloc areas.

---

## Summary: TLB Optimization Strategies

| Technique | Mechanism | Kernel Implementation |
|-----------|-----------|----------------------|
| Flush batching | Accumulate ranges; one flush per unmap operation | `struct mmu_gather`, `tlb_gather_mmu()` / `tlb_finish_mmu()` |
| Lazy TLB mode | Skip IPIs to CPUs running kernel threads | `enter_lazy_tlb()`, `cpu_tlbstate_shared.is_lazy`, `should_flush_tlb()` |
| PCID / ASID caching | Survive context switches without flushing | `choose_new_asid()`, `build_cr3_noflush()`, `cpu_tlbstate.ctxs[]` |
| Huge pages | 512× TLB coverage per entry | `tlb_update_vma_flags()`, `vma_huge`, PMD-level flush stride |
| Global ASIDs (INVLPGB) | Hardware broadcast; no IPIs | `use_global_asid()`, `broadcast_tlb_flush()` |
| Range-vs-full heuristic | Switch to full flush beyond 33 pages | `tlb_single_page_flush_ceiling`, `get_flush_tlb_info()` |
| Avoid kernel vmalloc | No global TLB flush for slab allocs | Use `kmalloc()` instead of `vmalloc()` in hot paths |

## Further reading

### Kernel source

- [arch/x86/mm/tlb.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/tlb.c) — `flush_tlb_mm_range()`, `native_flush_tlb_multi()`, `enter_lazy_tlb()`, `switch_mm_irqs_off()`, PCID/ASID management
- [arch/x86/include/asm/tlbflush.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/tlbflush.h) — `flush_tlb_mm()`, `flush_tlb_range()`, `flush_tlb_page()`, `struct tlb_state`
- [include/asm-generic/tlb.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/asm-generic/tlb.h) — `struct mmu_gather`, `tlb_gather_mmu()`, `tlb_finish_mmu()`
- [mm/mmu_gather.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mmu_gather.c) — mmu_gather implementation: batching, range accumulation, and page freeing

### Kernel documentation

- [`Documentation/arch/x86/tlb.rst`](https://docs.kernel.org/arch/x86/tlb.html) — x86 TLB flushing design notes: why certain shootdown paths are taken

### Related pages

- [page-tables.md](page-tables.md) — the page table hierarchy that TLB entries cache
- [thp.md](thp.md) — how huge pages reduce TLB pressure by providing 512× larger entries
- [boot-page-tables.md](boot-page-tables.md) — PCID activation and the early CR3 setup that initializes ASID support

### LWN articles

- [LWN: Improving page-fault scalability](https://lwn.net/Articles/741937/) — covers PCID benefits and context-switch TLB cost reduction
- [LWN: Meltdown and Spectre, part 2](https://lwn.net/Articles/743287/) — KPTI's impact on TLB performance and the doubled-PCID workaround
- [LWN: INVLPGB and broadcast TLB flushing](https://lwn.net/Articles/951489/) — AMD INVLPGB support: eliminating cross-CPU IPIs for TLB invalidation
