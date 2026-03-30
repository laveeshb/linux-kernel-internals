# Multi-size THP (mTHP)

> Sub-PMD transparent huge pages for workloads where 2MB is too much

## The problem with classic 2MB THP

Traditional THP allocates PMD-sized huge pages — 2MB on x86-64 with 4KB base pages (PMD_ORDER = 9, so 2^9 = 512 pages × 4KB). For large server workloads, this is ideal: fewer TLB entries, faster page fault servicing at scale. For everything else, 2MB is often the wrong granularity.

**Internal fragmentation.** Allocating a 2MB huge page for a 64KB working set wastes 1984KB. In memory-constrained environments — embedded systems, Android, mobile — this adds up fast.

**Compaction pressure.** The buddy allocator must find 512 physically contiguous free pages to back each THP. On fragmented systems this triggers compaction, which is expensive. Compaction scans and migrates pages to create contiguous free regions; on a loaded system this causes latency spikes.

**Fault latency.** When the fault handler allocates a huge page it must zero-clear the entire 2MB region before returning to userspace. That is 512× more work than a 4KB fault. For latency-sensitive applications this can be measurable.

The kernel documentation for THP describes the tradeoff explicitly:

> "Page faults are significantly reduced (by a factor of e.g. 4, 8, 16, etc), but latency spikes are much less prominent because the size of each page isn't as huge as the PMD-sized variant and there is less memory to clear in each page fault."

## What mTHP is

Multi-size THP (mTHP), introduced in Linux 6.10, allows the kernel to back anonymous memory with huge pages at orders between 2 and PMD_ORDER−1 (inclusive). On x86-64 with 4KB base pages that is orders 2–8, corresponding to 16KB through 512KB.

!!! note "Order 1 is excluded"
    Order-1 (8KB) is excluded from `THP_ORDERS_ALL_ANON` by an explicit mask in the source. The THP implementation has a structural limitation at order-1 that prevents its use.

The macro encoding this is in `include/linux/huge_mm.h`:

```c
/* Orders 2..PMD_ORDER, order-0 and order-1 excluded */
#define THP_ORDERS_ALL_ANON  ((BIT(PMD_ORDER + 1) - 1) & ~(BIT(0) | BIT(1)))
```

Unlike classic PMD-sized THP (which uses a dedicated PMD-level page table entry), mTHP pages remain **PTE-mapped**. Each of the 2^order 4KB PTEs in the range still exists in the page table — the folio is just physically contiguous underneath them. This is why they are sometimes called "PTE-mapped huge pages."

!!! note "mTHP is also available for shmem/tmpfs"
    File-backed mTHP support was added for tmpfs and shmem. The order range for file-backed pages is governed by `THP_ORDERS_ALL_FILE_DEFAULT`, which covers up to `MAX_PAGECACHE_ORDER`. Per-size controls are surfaced in sysfs under the same `hugepages-NkB/` directories.

## ARM64 contiguous PTE hardware

On ARM64, PTE-mapped huge pages become genuinely efficient because the architecture supports a **contiguous PTE** hardware feature. When a naturally-aligned run of PTEs point to physically contiguous pages, the hardware can collapse those entries into a single TLB entry (or a small number of entries), reducing TLB pressure even without a PMD-level mapping.

The number of contiguous PTEs is architecture-configured. With 4KB pages the default `CONFIG_ARM64_CONT_PTE_SHIFT` is 4, meaning 2^4 = 16 contiguous PTEs cover 64KB. When an mTHP allocation fills exactly this window, the hardware can fold the whole 64KB into one TLB entry — the same outcome as a PMD-mapped huge page but at a smaller granularity.

The kernel uses `contpte_try_fold()` and `contpte_try_unfold()` (in `arch/arm64/include/asm/pgtable.h`) to transparently manage the contiguous bit as PTEs are set and cleared.

!!! tip "This is why mTHP is particularly valuable on ARM64"
    The 64KB contpte size aligns with the order-4 mTHP size. Mobile and embedded ARM64 workloads with moderate working sets can get near-PMD TLB efficiency without the fragmentation and fault-latency cost of 2MB pages.

## The sysfs interface

mTHP is controlled entirely at runtime through sysfs. No kernel rebuild is needed beyond having `CONFIG_TRANSPARENT_HUGEPAGE` enabled.

Per-size controls live under:

```
/sys/kernel/mm/transparent_hugepage/hugepages-<size>kB/
```

The kernel creates one directory for each supported order. For example, on a 4KB-page system with PMD_ORDER=9 you will see directories for `hugepages-16kB`, `hugepages-32kB`, `hugepages-64kB`, `hugepages-128kB`, `hugepages-256kB`, `hugepages-512kB`, `hugepages-1024kB`, and `hugepages-2048kB`.

The directory name is computed at boot from `(PAGE_SIZE << order) / 1024` as a kB value.

### The `enabled` attribute (anonymous)

```
/sys/kernel/mm/transparent_hugepage/hugepages-<size>kB/enabled
```

Accepts four values:

| Value | Meaning |
|-------|---------|
| `always` | Allocate this size on every anonymous fault, unconditionally |
| `inherit` | Follow the top-level `/sys/kernel/mm/transparent_hugepage/enabled` setting |
| `madvise` | Only allocate for regions marked with `madvise(MADV_HUGEPAGE)` |
| `never` | Disable this size entirely |

The active value is shown in brackets:

```
$ cat /sys/kernel/mm/transparent_hugepage/hugepages-64kB/enabled
always inherit [madvise] never
```

The three global bitmasks that back these per-size flags are `huge_anon_orders_always`, `huge_anon_orders_inherit`, and `huge_anon_orders_madvise` in `mm/huge_memory.c`.

**Default at boot:** PMD-sized THP defaults to `inherit`. All other sizes default to `never`. The first time you want mTHP to be active you must explicitly write `always` or `madvise` to the smaller-size `enabled` files.

### The `enabled` attribute (shmem/file-backed)

For file-backed orders, the attribute is named `enabled` inside the same per-size directory but routed through the shmem subsystem (`thpsize_shmem_enabled_attr`). shmem supports additional values (`within_size`, `advise`) beyond what anonymous THP uses.

### Boot-time configuration

You can configure mTHP sizes from the kernel command line using the `thp_anon=` parameter:

```
thp_anon=16K-64K:always;128K,512K:inherit;256K:madvise;1M-2M:never
```

If `thp_anon=` is specified at least once, any size not mentioned defaults to `never`.

### Per-size statistics

Each per-size directory also contains a `stats/` subdirectory:

```
/sys/kernel/mm/transparent_hugepage/hugepages-<size>kB/stats/
    anon_fault_alloc          # successful allocations on page fault
    anon_fault_fallback       # fell back to a smaller order
    anon_fault_fallback_charge  # fallback due to charge failure
    split                     # folios of this size that were split
    split_failed              # split attempts that failed
    split_deferred            # splits deferred to shrinker
    nr_anon                   # current count of live anon folios at this order
    nr_anon_partially_mapped  # partially mapped (e.g. after COW split)
    swpout / swpout_fallback
    swpin / swpin_fallback
    zswpout
```

These counters are tracked per-CPU in `struct mthp_stat` (declared in `include/linux/huge_mm.h`) and summed on read.

!!! note "Counters only track orders 2..PMD_ORDER"
    The `mod_mthp_stat()` helper silently drops events for `order <= 0` or `order > PMD_ORDER`. You will not see per-size stats for PMD-order pages in the mTHP `stats/` directory — PMD-order is tracked separately by the classic THP counters in `/proc/vmstat`.

## Allocation paths that support mTHP

**Anonymous memory (faults):** The primary supported path from 6.10 onward. When a process faults on an anonymous page, `__handle_mm_fault()` calls into the THP code, which uses `thp_vma_allowable_orders()` to determine which orders are eligible for the VMA at the faulting address. The fault handler then attempts to allocate the largest eligible order that succeeds.

**Anonymous memory (khugepaged):** khugepaged currently only searches for PMD-sized collapse opportunities. Sub-PMD sizes are not collapsed by khugepaged.

**Swap:** mTHP-aware swap paths handle swapping out and back in of large folios; the `swpout`, `swpin`, and related counters in the stats directory reflect this activity.

**shmem/tmpfs:** File-backed mTHP is supported for the internal shmem mount (used by `memfd_create`, shared memory) and for tmpfs mounts. Ordinary tmpfs uses all available sizes without fine-grained control; the internal shmem mount has per-size controls.

## Impact on fragmentation

Classic 2MB THP either succeeds in finding 512 contiguous pages or falls back to 4KB pages entirely. There is no middle ground. This creates a cliff: a lightly-fragmented system gets good huge-page coverage; a moderately fragmented system gets none.

mTHP fills the middle ground. Order-4 (64KB) requires only 16 contiguous pages. This is far easier for the buddy allocator to satisfy without triggering compaction. A system where a 2MB allocation would fail may still readily serve 16 or 32 64KB allocations.

The fallback logic is explicit: if the preferred order cannot be satisfied, `anon_fault_fallback` is incremented and the allocator tries the next smaller enabled order, eventually falling back to order-0 (a single 4KB page) if necessary.

## Performance: when mTHP helps

**Medium-sized allocations** that do not fill a full PMD are the primary beneficiary. A 128KB buffer allocated as a 2MB THP wastes 1.875MB. As mTHP at 128KB it has zero waste.

**ARM64 workloads**, especially mobile (Android) and embedded. The contiguous PTE hardware means order-4 (64KB) mTHP delivers real TLB compression without requiring any PMD alignment.

**Low-latency applications** that cannot tolerate the occasional 2MB zero-clear on fault. mTHP reduces both the average and the worst-case fault latency.

**Fragmented systems** where 2MB THP would have a high `thp_fault_fallback` rate. Smaller orders have better allocation success rates.

## Kernel configuration

`CONFIG_TRANSPARENT_HUGEPAGE` is the only compile-time gate. mTHP does not have its own `Kconfig` symbol — it is part of the base THP implementation and controlled entirely through the per-size sysfs interface at runtime.

Sub-PMD THP behavior at sysfs is only available when both `CONFIG_TRANSPARENT_HUGEPAGE` and `CONFIG_SYSFS` are enabled (the sysfs attribute definitions are wrapped in `#if defined(CONFIG_TRANSPARENT_HUGEPAGE) && defined(CONFIG_SYSFS)`).

!!! warning "Disabling all sizes does not disable MADV_COLLAPSE"
    Writing `never` to every per-size `enabled` file does not prevent `madvise(MADV_COLLAPSE)` from working. `MADV_COLLAPSE` ignores these settings and forces PMD-sized collapse unconditionally. See the kernel documentation note:
    > "Setting 'never' in all sysfs THP controls does **not** disable Transparent Huge Pages globally."
