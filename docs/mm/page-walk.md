# Walking Page Tables Programmatically

> pagewalk API, apply_to_page_range, and ptdump — reading page tables from kernel code

## Why walk page tables?

The kernel needs to inspect or modify page table entries programmatically in many contexts:
- **KVM**: scan guest memory to find dirty pages
- **Migration**: find all PTEs mapping a page before moving it
- **Debugging**: `ptdump` dumps page tables to `/sys/kernel/debug/kernel_page_tables`
- **mprotect**: change protection bits on a VA range
- **userfaultfd**: set up write-protection on a range
- **NUMA balancing**: scan PTEs to detect hot/cold pages across NUMA nodes

## The pagewalk API

```c
#include <linux/pagewalk.h>

/* Callbacks invoked as the walker traverses the page table hierarchy */
struct mm_walk_ops {
    /* Called for each PGD entry (top level) */
    int (*pgd_entry)(pgd_t *pgd, unsigned long addr, unsigned long next,
                     struct mm_walk *walk);

    /* Called for each P4D (5-level paging), or not at all if 4-level */
    int (*p4d_entry)(p4d_t *p4d, unsigned long addr, unsigned long next,
                     struct mm_walk *walk);

    /* Called for each PUD entry */
    int (*pud_entry)(pud_t *pud, unsigned long addr, unsigned long next,
                     struct mm_walk *walk);

    /* Called for each PMD entry */
    int (*pmd_entry)(pmd_t *pmd, unsigned long addr, unsigned long next,
                     struct mm_walk *walk);

    /* Called for each PTE (leaf, most common) */
    int (*pte_entry)(pte_t *pte, unsigned long addr, unsigned long next,
                     struct mm_walk *walk);

    /* Called for holes (no VMA found): */
    int (*pte_hole)(unsigned long addr, unsigned long next,
                    int depth, struct mm_walk *walk);

    /* Called before and after entering a huge page PMD/PUD */
    int (*hugetlb_entry)(pte_t *pte, unsigned long hmask,
                         unsigned long addr, unsigned long next,
                         struct mm_walk *walk);

    /* Called for each VMA before walking its range */
    int (*pre_vma)(unsigned long start, unsigned long end,
                   struct mm_walk *walk);

    /* Called for each VMA after walking its range */
    void (*post_vma)(struct mm_walk *walk);

    /* Test whether to walk this VMA (return 0=skip, 1=walk) */
    int (*test_walk)(unsigned long start, unsigned long end,
                     struct mm_walk *walk);
};

/* mm_walk carries context through the callbacks */
struct mm_walk {
    const struct mm_walk_ops *ops;
    struct mm_struct         *mm;
    pgd_t                    *pgd;   /* current PGD being walked */
    struct vm_area_struct    *vma;   /* current VMA */
    void                     *private; /* caller private data */
    bool                      no_vma;  /* walk without VMA lookup */
};
```

## Walk a user address range

```c
static int count_present_pte(pte_t *pte, unsigned long addr,
                               unsigned long next, struct mm_walk *walk)
{
    long *count = walk->private;
    if (pte_present(*pte))
        (*count)++;
    return 0;
}

static const struct mm_walk_ops count_ops = {
    .pte_entry = count_present_pte,
};

long count_resident_pages(struct mm_struct *mm, unsigned long start,
                           unsigned long end)
{
    long count = 0;
    mmap_read_lock(mm);
    walk_page_range(mm, start, end, &count_ops, &count);
    mmap_read_unlock(mm);
    return count;
}
```

## Walk the kernel address space

```c
/* Walk kernel page tables (no mm, no VMA): */
static int dump_pte_entry(pte_t *pte, unsigned long addr,
                           unsigned long next, struct mm_walk *walk)
{
    if (pte_present(*pte)) {
        pr_info("  %016lx: PTE=%016llx pfn=%lx %s%s%s\n",
                addr, (u64)pte_val(*pte),
                pte_pfn(*pte),
                pte_write(*pte) ? "W" : "r",
                pte_exec(*pte) ? "X" : "-",
                pte_dirty(*pte) ? "D" : "-");
    }
    return 0;
}

static const struct mm_walk_ops kernel_walk_ops = {
    .pte_entry = dump_pte_entry,
};

/* Walk kernel vmalloc range: */
walk_page_range_novma(&init_mm, VMALLOC_START, VMALLOC_END,
                       &kernel_walk_ops, NULL, NULL);
```

## Modifying PTEs during the walk

```c
/* Write-protect a range (used by userfaultfd, KVM dirty tracking): */
static int wp_pte(pte_t *pte, unsigned long addr,
                  unsigned long next, struct mm_walk *walk)
{
    struct vm_area_struct *vma = walk->vma;
    spinlock_t *ptl = pte_lockptr(walk->mm, pte);

    spin_lock(ptl);

    if (pte_present(*pte) && pte_write(*pte)) {
        pte_t old_pte = *pte;
        pte_t new_pte = pte_wrprotect(old_pte);

        /* Atomically update the PTE */
        set_pte_at(walk->mm, addr, pte, new_pte);

        /* Flush TLB for this address */
        flush_tlb_page(vma, addr);
    }

    spin_unlock(ptl);
    return 0;
}
```

## apply_to_page_range: set up mappings

`apply_to_page_range` allocates page table pages as needed and calls a function on each PTE:

```c
/* Signature: */
int apply_to_page_range(struct mm_struct *mm, unsigned long addr,
                         unsigned long size, pte_fn_t fn, void *data);

/* Example: map a range of physical pages into kernel vmalloc space */
static int set_pte_fn(pte_t *pte, unsigned long addr,
                       unsigned long next, void *data)
{
    phys_addr_t phys = *(phys_addr_t *)data + (addr - start_addr);
    pte_t new_pte = pfn_pte(phys >> PAGE_SHIFT,
                             PAGE_KERNEL);  /* RW, NX */
    set_pte_at(&init_mm, addr, pte, new_pte);
    return 0;
}

apply_to_page_range(&init_mm, vaddr, size, set_pte_fn, &phys_base);
```

## ptdump: debugging page tables

```bash
# Kernel page table dump (requires CONFIG_PTDUMP_DEBUGFS=y):
cat /sys/kernel/debug/kernel_page_tables | head -50
# 0xffff888000000000-0xffffc87fffffffff   131072G PGD  RW NX  SZ=1G
# 0xffffc90000000000-0xffffe8ffffffffff     32768G PGD  RW NX  SZ=2M
# 0xffffea0000000000-0xffffeb7fffffffff      3072G PGD  RW NX  SZ=2M  dirty
# 0xffffffff80000000-0xffffffff9fffffff       512M PGD  ro  X  SZ=2M  (kernel text)
# 0xffffffff9fffffff-0xffffffffa0000000         0 PGD (hole)
# 0xffffffffa0000000-0xffffffffb0000fffff      ~1G PGD  RW NX  (modules)

# User process page table:
cat /sys/kernel/debug/page_tables/pid_<PID>

# Decode a page table entry manually:
python3 -c "
pte = 0x8000000004021025  # from ptdump
pfn = (pte >> 12) & 0xFFFFFFFFF
present = pte & 1
rw = (pte >> 1) & 1
user = (pte >> 2) & 1
nx = pte >> 63
print(f'PFN: {pfn:#x}  present={present} rw={rw} user={user} NX={nx}')
"
```

## PTE bit manipulation functions

```c
/* Read PTE properties: */
pte_present(pte)      /* page is in RAM (P bit set) */
pte_write(pte)        /* writable */
pte_exec(pte)         /* executable (NX bit clear on x86) */
pte_dirty(pte)        /* page was written (hardware sets this) */
pte_young(pte)        /* page was accessed (hardware sets this) */
pte_soft_dirty(pte)   /* software dirty tracking bit */
pte_special(pte)      /* special mapping (no struct page) */
pte_devmap(pte)       /* device memory (ZONE_DEVICE) */
pte_pfn(pte)          /* physical frame number */

/* Modify PTE properties: */
pte_mkwrite(pte)          /* set writable */
pte_wrprotect(pte)        /* clear writable */
pte_mkdirty(pte)          /* set dirty */
pte_mkclean(pte)          /* clear dirty */
pte_mkyoung(pte)          /* set accessed */
pte_mkold(pte)            /* clear accessed */
pte_mkspecial(pte)        /* set special */

/* Create a PTE from a PFN and protection flags: */
pte_t pte = pfn_pte(pfn, PAGE_KERNEL);      /* kernel RW NX */
pte_t pte = pfn_pte(pfn, PAGE_KERNEL_EXEC); /* kernel RX */
pte_t pte = pfn_pte(pfn, PAGE_SHARED);      /* user RW */

/* Get the struct page from a PTE: */
struct page *page = pte_page(pte);           /* via pfn_to_page() */
```

## Huge page PTEs

```c
/* PMD-level huge page (2MB): */
pmd_t *pmd = pmd_offset(pud, addr);
if (pmd_large(*pmd)) {
    /* This is a 2MB leaf PTE, not a pointer to PT */
    phys_addr_t phys = (phys_addr_t)pmd_pfn(*pmd) << PAGE_SHIFT;
    phys += addr & ~PMD_MASK;  /* offset within 2MB page */
}

/* PUD-level huge page (1GB): */
pud_t *pud = pud_offset(p4d, addr);
if (pud_large(*pud)) {
    /* 1GB leaf */
    phys_addr_t phys = (phys_addr_t)pud_pfn(*pud) << PAGE_SHIFT;
    phys += addr & ~PUD_MASK;
}
```

## NUMA balancing page table scan

The NUMA balancer uses page table walking to find pages that should be migrated:

```c
/* kernel/sched/fair.c (simplified) */
static void task_numa_work(struct callback_head *work)
{
    struct task_struct *p = current;
    struct mm_struct *mm = p->mm;
    unsigned long start = p->mm->numa_scan_offset;

    /* Walk a chunk of the process address space: */
    walk_page_range(mm, start, start + NUMA_SCAN_SIZE,
                    &numa_walk_ops, p);

    /* numa_walk_ops.pte_entry does:
     *   - pte_mkold() to clear the Accessed bit
     *   - On next access, CPU sets Accessed bit → NUMA fault
     *   - task_numa_fault() records the NUMA node of the access
     *   - Scheduler uses this to prefer running the task
     *     near its hot pages
     */
}
```

## Further reading

- [Page Tables](page-tables.md) — page table structure and format
- [Page Fault Handler](page-fault.md) — how faults are resolved
- [NUMA](numa.md) — NUMA balancing using page walk
- [KVM Memory](../virtualization/kvm-memory.md) — dirty page tracking
- [userfaultfd](userfaultfd.md) — write-protect via page walk
- `mm/pagewalk.c` — pagewalk implementation
- `arch/x86/mm/dump_pagetables.c` — ptdump debugfs
