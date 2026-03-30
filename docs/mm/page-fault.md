# Page Fault Handler

> From hardware exception to page mapped: the complete fault path

## Hardware page fault

When the CPU encounters a virtual address that isn't mapped in the page tables, it raises a **page fault exception** (#PF on x86):

```
CPU accesses virtual address 0x7fff1234
  → page table walk: PTE not present
  → hardware raises exception #14 (Page Fault)
  → saves RIP, RFLAGS, error code on stack
  → jumps to IDT entry 14 → kernel's fault handler
```

## x86 page fault error codes

The error code pushed by the CPU describes the fault:

```
Bit 0 (P):   0 = not present (PTE absent)
             1 = protection violation (present but wrong permissions)
Bit 1 (W):   0 = read access
             1 = write access
Bit 2 (U):   0 = kernel mode access
             1 = user mode access
Bit 3 (R):   0 = non-reserved bit fault
             1 = reserved bit set in PTE
Bit 4 (I):   0 = data access
             1 = instruction fetch (NX violation)
Bit 5 (PK):  1 = protection key violation
Bit 15 (SS): 1 = shadow stack access
```

```c
/* arch/x86/mm/fault.c */
#define X86_PF_PROT   (1 << 0)   /* PTE present: protection violation */
#define X86_PF_WRITE  (1 << 1)   /* write access */
#define X86_PF_USER   (1 << 2)   /* from userspace */
#define X86_PF_RSVD   (1 << 3)   /* reserved bit in PTE */
#define X86_PF_INSTR  (1 << 4)   /* instruction fetch */
#define X86_PF_PK     (1 << 5)   /* protection key */
```

`CR2` register holds the **faulting virtual address** at the time of the fault.

## Kernel entry point

```c
/* arch/x86/mm/fault.c */
DEFINE_IDTENTRY_RAW_ERRORCODE(exc_page_fault)
{
    unsigned long address = read_cr2();  /* faulting virtual address */

    irqentry_state_t state = irqentry_enter(regs);
    handle_page_fault(regs, error_code, address);
    irqentry_exit(regs, state);
}

static __always_inline void
handle_page_fault(struct pt_regs *regs, unsigned long error_code,
                   unsigned long address)
{
    if (unlikely(kmmio_fault(regs, address)))
        return;  /* MMIO trace: handled */

    /* Was fault in kernel space? */
    if (unlikely(fault_in_kernel_space(address)))
        do_kern_addr_fault(regs, error_code, address);
    else
        do_user_addr_fault(regs, error_code, address);
}
```

## User-space fault path

```c
/* arch/x86/mm/fault.c */
static void
do_user_addr_fault(struct pt_regs *regs, unsigned long error_code,
                    unsigned long address)
{
    struct vm_area_struct *vma;
    struct task_struct *tsk = current;
    struct mm_struct *mm = tsk->mm;
    vm_fault_t fault;

    /* 1. Check for obvious non-canonical addresses */
    if (unlikely(error_code & X86_PF_RSVD))
        goto bad_area;

    /* 2. Don't handle faults while holding mmap_lock for write */
    if (unlikely(faulthandler_disabled() || !mm))
        goto bad_area_nosemaphore;

    /* 3. Find the VMA that should contain 'address' */
    vma = lock_vma_under_rcu(mm, address);
    if (!vma) {
        /* No VMA: try mmap_lock path */
        mmap_read_lock(mm);
        vma = find_vma(mm, address);
    }

    /* 4. Check the VMA covers the faulting address */
    if (unlikely(!vma || address < vma->vm_start))
        goto bad_area;

    /* 5. Check access permissions against VMA flags */
    if (unlikely(access_error(error_code, vma)))
        goto bad_area;

    /* 6. Handle the fault */
    fault = handle_mm_fault(vma, address, flags, regs);

    /* 7. Check for fault completion */
    if (fault_signal_pending(fault, regs))
        return;  /* signal arrived during fault */

    if (unlikely(fault & VM_FAULT_ERROR)) {
        if (fault & VM_FAULT_OOM)
            goto out_of_memory;
        if (fault & VM_FAULT_SIGBUS)
            goto do_sigbus;
        if (fault & VM_FAULT_SIGSEGV)
            goto bad_area;
    }
    return;

bad_area:
    /* VMA not found or permission denied */
    force_sig_fault(SIGSEGV, SEGV_MAPERR, (void __user *)address);
    return;

do_sigbus:
    /* Hardware error or VM_FAULT_HWPOISON */
    force_sig_fault(SIGBUS, BUS_ADRERR, (void __user *)address);
}
```

## Fault types and their handling

```c
/* mm/memory.c */
vm_fault_t handle_mm_fault(struct vm_area_struct *vma,
                             unsigned long address,
                             unsigned int flags,
                             struct pt_regs *regs)
{
    /* Handle huge page faults first */
    if (unlikely(is_vm_hugetlb_page(vma)))
        return hugetlb_fault(vma->vm_mm, vma, address, flags);

    /* THP: transparent huge page fault */
    if (pmd_none(*vmf.pmd) && hugepage_vma_check(vma, vm_flags))
        return create_huge_pmd(vmf);

    return handle_pte_fault(vmf);
}

static vm_fault_t handle_pte_fault(struct vm_fault *vmf)
{
    pte_t entry;

    if (unlikely(pmd_none(*vmf->pmd))) {
        vmf->pte = NULL;
        vmf->flags |= FAULT_FLAG_ORIG_PTE_VALID;
    } else {
        vmf->pte = pte_offset_map_lock(vmf->vma->vm_mm, vmf->pmd,
                                         vmf->address, &vmf->ptl);
        entry = *vmf->pte;
    }

    if (!vmf->pte || pte_none(entry)) {
        /* No PTE: anonymous or file-backed fault */
        if (vma_is_anonymous(vmf->vma))
            return do_anonymous_page(vmf);  /* demand-zero page */
        else
            return do_fault(vmf);           /* file-backed: filemap_fault */
    }

    if (!pte_present(entry)) {
        /* PTE exists but page not present: swapped out */
        if (pte_swp_soft_dirty(entry))
            return do_swap_page(vmf);       /* swap in the page */
    }

    /* Present PTE: must be a write fault on read-only PTE */
    if (vmf->flags & FAULT_FLAG_WRITE) {
        if (!pte_write(entry))
            return do_wp_page(vmf);         /* copy-on-write */
    }

    /* Spurious fault or soft dirty tracking */
    return 0;
}
```

## Fault types summary

| PTE state | Access type | Handler | Description |
|-----------|------------|---------|-------------|
| No PTE, anonymous VMA | Read/Write | `do_anonymous_page` | Demand-zero page |
| No PTE, file VMA | Read | `do_read_fault` → `filemap_fault` | Demand page from file |
| No PTE, file VMA | Write | `do_cow_fault` | Copy-on-write from file |
| Swap PTE | Any | `do_swap_page` | Swap in from disk |
| Present, read-only | Write | `do_wp_page` | COW or shared dirty |
| No VMA | Any | SIGSEGV | Segmentation fault |
| VMA: no write perm | Write | SIGSEGV | Permission denied |
| VMA: no exec perm | Fetch | SIGSEGV | NX violation |

## do_anonymous_page: demand-zero page

```c
/* mm/memory.c */
static vm_fault_t do_anonymous_page(struct vm_fault *vmf)
{
    struct vm_area_struct *vma = vmf->vma;
    struct page *page;
    pte_t entry;

    if (read_fault) {
        /* Read of unwritten anonymous page: map the zero page */
        /* (shared physical zero page — copy-on-write if written later) */
        entry = pte_mkspecial(pfn_pte(my_zero_pfn(vmf->address),
                                       vmf->vma->vm_page_prot));
        set_pte_at(vmf->vma->vm_mm, vmf->address, vmf->pte, entry);
        return 0;
    }

    /* Write: allocate a real zeroed page */
    page = alloc_zeroed_user_highpage_movable(vma, vmf->address);
    if (!page)
        return VM_FAULT_OOM;

    /* Install the PTE */
    entry = mk_pte(page, vma->vm_page_prot);
    entry = pte_sw_mkyoung(entry);
    if (vma->vm_flags & VM_WRITE)
        entry = pte_mkwrite(pte_mkdirty(entry));

    set_pte_at(vmf->vma->vm_mm, vmf->address, vmf->pte, entry);
    return 0;
}
```

## do_wp_page: copy-on-write

```c
/* mm/memory.c */
static vm_fault_t do_wp_page(struct vm_fault *vmf)
{
    struct vm_area_struct *vma = vmf->vma;
    struct page *old_page = vm_normal_page(vma, vmf->address, vmf->orig_pte);

    if (PageAnon(old_page)) {
        /* Anonymous page: can we reuse it? */
        if (page_count(old_page) == 1) {
            /* We're the only owner: make it writable in-place */
            wp_page_reuse(vmf);
            return VM_FAULT_WRITE;
        }
        /* Shared: allocate a new copy */
        return wp_page_copy(vmf);
    }

    if (vma->vm_flags & VM_SHARED) {
        /* Shared mapping: dirty the page in-place */
        return wp_page_shared(vmf);
    }

    /* Private file mapping: COW */
    return wp_page_copy(vmf);
}

static vm_fault_t wp_page_copy(struct vm_fault *vmf)
{
    /* Allocate new page */
    new_page = alloc_page_vma(GFP_HIGHUSER_MOVABLE, vmf->vma, vmf->address);

    /* Copy old page content */
    cow_user_page(new_page, old_page, vmf);

    /* Install new writable PTE */
    new_entry = mk_pte(new_page, vma->vm_page_prot);
    new_entry = pte_mkwrite(pte_mkdirty(new_entry));
    set_pte_at_notify(vmf->vma->vm_mm, vmf->address, vmf->pte, new_entry);

    /* Decrement reference to old page */
    put_page(old_page);
    return VM_FAULT_WRITE;
}
```

## Kernel page faults

```c
/* Kernel-space fault: usually a bug */
static noinline void
do_kern_addr_fault(struct pt_regs *regs, unsigned long error_code,
                    unsigned long address)
{
    /* vmalloc fault: mapping not synced from init_mm */
    if (!(error_code & X86_PF_USER) &&
        !(error_code & X86_PF_PROT) &&
        vmalloc_fault(address) >= 0)
        return;

    /* fixup_exception: expected fault from copy_to_user etc. */
    if (!user_mode(regs) && fixup_exception(regs, X86_TRAP_PF,
                                              error_code, address))
        return;

    /* Unrecoverable: kernel bug */
    oops_begin();
    show_fault_oops(regs, error_code, address);
    oops_end(flags, regs, SIGKILL);
}
```

Common kernel fault: `copy_to_user` / `copy_from_user` with an invalid user pointer. The `fixup_exception` mechanism uses a table of `{fault_address → recovery_address}` pairs — if the fault address is in the table, execution jumps to the recovery code (returns `-EFAULT`).

## Observing page faults

```bash
# Per-process fault statistics
cat /proc/<pid>/stat | awk '{print "minor:", $10, "major:", $12}'
# minor: 12345  (page was in cache; just needed mapping)
# major: 42     (page was not in memory; required I/O)

# System-wide fault rates (perf)
perf stat -e page-faults,major-faults -- my_program

# Trace specific faults with ftrace
echo 1 > /sys/kernel/debug/tracing/events/exceptions/page_fault_user/enable
cat /sys/kernel/debug/tracing/trace

# perf-record to find where faults happen
perf record -e page-faults -- my_program
perf report

# USDT/bpftrace:
bpftrace -e 'tracepoint:exceptions:page_fault_user {
    @addrs[uaddr] = count();
}'
```

## Further reading

- [File-backed mmap and page faults](file-mmap.md) — do_fault/filemap_fault path
- [Copy-on-Write](cow.md) — do_wp_page mechanics
- [Process Address Space](mmap.md) — VMA structure
- [Swap](swap.md) — do_swap_page path
- [KASAN](kasan.md) — detecting invalid kernel memory accesses
- `arch/x86/mm/fault.c` — x86 page fault entry
- `mm/memory.c` — handle_mm_fault, do_anonymous_page, do_wp_page
