# Memory Virtualization

> EPT, shadow paging, balloon driver, and huge pages for KVM guests

## Two layers of address translation

A guest OS thinks it controls physical memory. It doesn't — it controls *guest physical addresses* (GPA), which KVM translates to *host physical addresses* (HPA) using a second page table layer.

```
Guest virtual → Guest physical → Host physical
      (guest CR3)       (EPT / shadow PT)

Without hardware:  two separate walks, merged by software (shadow paging)
With EPT/NPT:      hardware does a 2D walk automatically
```

## Extended Page Tables (EPT / NPT)

Intel EPT (Extended Page Tables) and AMD NPT (Nested Page Tables) are the hardware mechanisms for GPA→HPA translation. They eliminate the need for shadow page tables on modern hardware.

### EPT page walk

The CPU walks both GCR3 (guest CR3) and the EPT pointer (EPTP) simultaneously:

```
Guest CR3 → PML4 → PDPT → PD → PT → GPA
                                        │
                           EPTP → EPT PML4 → EPT PDPT → EPT PD → EPT PT → HPA
```

For a 4-level guest walking a 4-level EPT, the hardware may touch up to 24 page table entries in the worst case (4 guest + 4×4 EPT walks).

### struct kvm_mmu

```c
/* Simplified — arch/x86/include/asm/kvm_host.h; several callback and
 * shadow-root fields (get_guest_pgd, get_pdptr, inject_page_fault,
 * gva_to_gpa, sync_spte, mirror_root_hpa, cpu_role, pkru_mask,
 * permissions[], pml4_root, pml5_root, shadow/guest reserved-bits
 * validators) omitted */
struct kvm_mmu {
    /* Page fault handler: invoked on GPA fault */
    int (*page_fault)(struct kvm_vcpu *vcpu,
                      struct kvm_page_fault *fault);

    /* Root (top-level EPT/shadow PT physical address) */
    struct kvm_mmu_root_info root;   /* root.hpa, root.pgd */
    union kvm_mmu_page_role root_role;

    struct kvm_mmu_root_info prev_roots[KVM_MMU_NUM_PREV_ROOTS];

    /* PAE root page table(s) — needed when shadowing a 32-bit/PAE guest
     * paging mode (e.g. under NPT) with a 64-bit host MMU */
    u64                  *pae_root;
};
```

### EPT violation handling

When a guest accesses memory with no EPT entry, the CPU triggers an EPT violation VM exit:

```c
/* arch/x86/kvm/vmx/vmx.c — handle_ept_violation(), simplified */
static int handle_ept_violation(struct kvm_vcpu *vcpu)
{
    gpa_t gpa    = vmcs_read64(GUEST_PHYSICAL_ADDRESS);
    u64   exit_qual = vmcs_readl(EXIT_QUALIFICATION);
    u64   error_code = 0;

    /*
     * exit_qual bits:
     *   bit 0: read fault
     *   bit 1: write fault
     *   bit 2: fetch fault
     *   bit 7: GPA in addr translation of GVA (not a direct access)
     */
    if (exit_qual & EPT_VIOLATION_ACC_WRITE)
        error_code |= PFERR_WRITE_MASK;
    if (exit_qual & EPT_VIOLATION_ACC_INSTR)
        error_code |= PFERR_FETCH_MASK;
    /* (present/MBEC/GVA-translation/TDX-private bits omitted here) */

    /* Look up or create the HPA mapping */
    return kvm_mmu_page_fault(vcpu, gpa, error_code, NULL, 0);
}

/* arch/x86/kvm/mmu/mmu.c — kvm_mmu_page_fault(), simplified (real signature
 * takes 5 concrete params, not variadic; not static; also handles
 * software-protected-VM attributes and write-protect faults, omitted here) */
int noinline kvm_mmu_page_fault(struct kvm_vcpu *vcpu, gpa_t cr2_or_gpa,
                                 u64 error_code, void *insn, int insn_len)
{
    bool direct = vcpu->arch.mmu->root_role.direct;
    int r, emulation_type = EMULTYPE_PF;

    /* A reserved bit set in error_code is KVM's own MMIO hint */
    if (error_code & PFERR_RSVD_MASK) {
        r = handle_mmio_page_fault(vcpu, cr2_or_gpa, direct);
        if (r == RET_PF_EMULATE)
            goto emulate;
    } else {
        /* Try to resolve the fault by building EPT entries */
        r = kvm_mmu_do_page_fault(vcpu, cr2_or_gpa, error_code, false,
                                  &emulation_type, NULL);
    }

    if (r != RET_PF_EMULATE)
        return r;

emulate:
    /* Emulate the access (e.g., MMIO to a device region) */
    return x86_emulate_instruction(vcpu, cr2_or_gpa, emulation_type,
                                   insn, insn_len);
}
```

### struct kvm_mmu_page (shadow pages)

KVM tracks EPT/shadow pages via `struct kvm_mmu_page`. One struct per page table page:

```c
struct kvm_mmu_page {
    struct list_head    link;          /* in kvm->arch.active_mmu_pages */
    struct hlist_node   hash_link;     /* hash table by gfn */

    bool                unsync;        /* sptes may be out of date */
    u8                  mmu_valid_gen; /* generation counter */
    bool                nx_huge_page_disallowed; /* can't use a huge page here
                                                     due to the NX huge page
                                                     mitigation */

    gfn_t               gfn;          /* guest frame number this page maps */
    union kvm_mmu_page_role role;      /* level, cr4_pae, access bits, ... */

    u64                *spt;          /* the actual page table page (4096 bytes) */
    u64                *shadowed_translation; /* per-spte: shadowed GPA (upper
                                                  bits) + access perms (lower) */
    struct kvm_rmap_head parent_ptes;  /* reverse map: who points here */

    atomic_t            write_flooding_count;

    /* Separate list (kvm->arch.possible_nx_huge_pages), independent of
     * active_mmu_pages above: pages KVM split to 4K solely to mitigate the
     * iTLB multihit erratum (an executable huge PTE would otherwise be
     * split by hardware in a way that can hang certain CPUs). Periodically
     * re-zapped by a recovery thread (kvm_recover_nx_huge_pages()) so KVM
     * can retry the huge mapping and recoup the mitigation's TLB cost. */
    struct list_head    possible_nx_huge_page_link;
};
```

## Shadow paging (without EPT)

On older hardware without EPT, KVM maintains **shadow page tables** that directly map GVA→HPA. The guest's CR3 points to the shadow page table, not its own.

```
Guest CR3 ──────────► Shadow PT (GVA → HPA, maintained by KVM)
                              ▲
Guest's own PT ──────────────┘
(GVA → GPA, never loaded)
```

### The write-protection trap

Shadow paging requires KVM to intercept every guest write to a page table:

1. KVM write-protects all guest page table pages in the shadow PT (clear write permission)
2. When guest tries to modify its own page table → write fault → VM exit
3. KVM emulates the write, updates both guest PT and shadow PT
4. Resume guest

This is costly for page-table-heavy workloads. EPT avoids this entirely.

## Memory slots

KVM maps guest physical memory in *slots* — contiguous GPA ranges backed by host userspace memory:

```c
/* include/linux/kvm_host.h */
struct kvm_memory_slot {
    struct hlist_node   id_node[2];
    struct interval_tree_node hva_node[2];
    struct rb_node      gfn_node[2];

    gfn_t               base_gfn;   /* start GFN */
    unsigned long       npages;     /* number of guest pages */
    unsigned long      *dirty_bitmap;
    struct kvm_arch_memory_slot arch;

    unsigned long       userspace_addr; /* HVA of backing memory */
    u32                 flags;          /* KVM_MEM_LOG_DIRTY_PAGES, etc. */
    short               id;
    u16                 as_id;
};
```

A slot can be:

- **Normal RAM**: backed by `mmap(MAP_ANONYMOUS)` memory in the VMM (e.g. QEMU)
- **ROM**: read-only (bios, option ROM)
- **MMIO**: no backing — triggers `KVM_EXIT_MMIO` on access

## Dirty page tracking

KVM can track which guest pages have been modified (used by live migration):

```c
/* Enable dirty tracking on a slot */
struct kvm_userspace_memory_region region = {
    .slot  = 0,
    .flags = KVM_MEM_LOG_DIRTY_PAGES,  /* enables dirty bitmap */
    /* ... */
};
ioctl(vm_fd, KVM_SET_USER_MEMORY_REGION, &region);

/* Fetch and clear dirty bitmap (pauses guest writes during collection) */
struct kvm_dirty_log log = {
    .slot       = 0,
    .dirty_bitmap = bitmap,
};
ioctl(vm_fd, KVM_GET_DIRTY_LOG, &log);
```

### Dirty ring (5.11+)

The dirty ring is a faster alternative that avoids the bitmap scan:

```c
/* Kernel exports dirty GFNs to a per-vCPU ring */
struct kvm_dirty_ring {
    u32    dirty_index;   /* written by kernel */
    u32    reset_index;   /* read/reset by VMM */
    u32    size;
    u32    soft_limit;
    struct kvm_dirty_gfn *dirty_gfns; /* mmap'd ring */
};

struct kvm_dirty_gfn {
    __u32 flags;
    __u32 slot;
    __u64 offset;  /* page offset within slot */
};
```

The VMM polls the ring, processes dirty GFNs, and resets them. No bitmap scan needed — much faster for high-write-rate guests.

## Balloon driver

The balloon driver is a paravirtual mechanism for the host to reclaim memory from a guest without the guest noticing page table manipulations.

```
Host (KVM)              Guest (virtio-balloon driver)
    │                           │
    │  inflate request ─────────►
    │  (need N pages back)      │
    │                           │ allocate N pages from guest allocator
    │                           │ add their GFNs to balloon page list
    │                           │
    │  guest tells host GPAs ◄──┘
    │
    │  host removes EPT entries for those GPAs
    │  host can now use the physical memory for other guests
    │
    │  deflate request ──────────►
    │  (guest can have pages back) │
    │                              │ release pages back to guest allocator
```

### Balloon stats

The guest can also report memory statistics to the host:

```c
/* drivers/virtio/virtio_balloon.c, simplified.
 * update_stat() takes a running index, not just a tag — real callers do
 * update_stat(vb, idx++, TAG, val). Real code splits this in two:
 * update_balloon_vm_stats() first fills in vm-event-derived stats (swap
 * in/out, major/minor faults, OOM kills, reclaim/scan counts, hugetlb
 * stats — omitted here), returning the count; update_balloon_stats()
 * below picks up from there and appends the sysinfo-derived stats. Both
 * return the total entries filled, not void. */
static unsigned int update_balloon_stats(struct virtio_balloon *vb)
{
    struct sysinfo i;
    unsigned int idx;
    unsigned long caches;

    idx = update_balloon_vm_stats(vb);  /* SWAP_IN/OUT, MAJFLT, MINFLT, ... */

    si_meminfo(&i);
    caches = global_node_page_state(NR_FILE_PAGES);

    update_stat(vb, idx++, VIRTIO_BALLOON_S_MEMFREE,
               pages_to_bytes(i.freeram));
    update_stat(vb, idx++, VIRTIO_BALLOON_S_MEMTOT,
               pages_to_bytes(i.totalram));
    update_stat(vb, idx++, VIRTIO_BALLOON_S_AVAIL,
               pages_to_bytes(si_mem_available()));
    update_stat(vb, idx++, VIRTIO_BALLOON_S_CACHES,
               pages_to_bytes(caches));

    return idx;
}
```

The host uses these stats to make inflation/deflation decisions intelligently (e.g., don't inflate if guest has no free memory).

## Huge pages for guests

Using huge pages in the EPT improves TLB efficiency. KVM can map a 2MB or 1GB GPA range with a single EPT entry.

### Transparent huge pages (THP) for guest memory

QEMU typically allocates guest RAM with `mmap(MAP_ANONYMOUS)`. With THP enabled, the host kernel may promote guest pages to huge pages automatically, and KVM will use 2MB EPT entries:

```bash
# On host: allow THP for anonymous memory
echo always > /sys/kernel/mm/transparent_hugepage/enabled

# Check if guest pages are backed by hugepages
grep -i huge /proc/$(pgrep qemu)/smaps | head
# AnonHugePages: 1234567 kB
```

### hugetlbfs-backed guest memory

For guaranteed huge pages with no THP pressure, QEMU can use hugetlbfs:

```bash
# Allocate 512 x 2MB hugepages (1GB total) on host
echo 512 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages

# Start QEMU with hugetlbfs memory
qemu-system-x86_64 \
    -m 1G \
    -mem-path /dev/hugepages \
    -mem-prealloc \
    ...
```

When EPT maps these, every 2MB of guest physical memory uses one EPT leaf entry instead of 512. Fewer TLB misses → better guest performance for memory-intensive workloads.

### KVM large page handling

```c
/* arch/x86/kvm/mmu/mmu.c — kvm_mmu_hugepage_adjust(), simplified.
 * Not static, and returns void, not int. The actual alignment / host-page-size
 * check is a separate helper, kvm_mmu_max_mapping_level() (walks each memslot's
 * per-gfn lpage_info plus the real host page size) — not reproduced here. */
void kvm_mmu_hugepage_adjust(struct kvm_vcpu *vcpu, struct kvm_page_fault *fault)
{
    struct kvm_memory_slot *slot = fault->slot;
    kvm_pfn_t mask;

    fault->huge_page_disallowed = fault->exec &&
                                  fault->nx_huge_page_workaround_enabled;

    if (fault->max_level == PG_LEVEL_4K)
        return;
    if (is_error_noslot_pfn(fault->pfn))
        return;
    if (kvm_slot_dirty_track_enabled(slot))
        return;   /* KVM dirty-logs at 4KiB granularity, so huge pages
                     get split to 4K on first write when a slot is dirty-tracked */

    /* Largest level both the GPA alignment and the host page support: */
    fault->req_level = kvm_mmu_max_mapping_level(vcpu->kvm, fault,
                                                 fault->slot, fault->gfn);
    if (fault->req_level == PG_LEVEL_4K || fault->huge_page_disallowed)
        return;

    fault->goal_level = fault->req_level;
    mask = KVM_PAGES_PER_HPAGE(fault->goal_level) - 1;
    fault->pfn &= ~mask;
}
```

## Observing guest memory

```bash
# There's no dedicated "ept_violations" file (see kvm_vcpu_stats_desc[] in
# x86.c for the full real list). pf_taken is the nearest available proxy —
# it counts every fault handled by kvm_mmu_page_fault(), which includes
# EPT violations but isn't scoped to them exclusively:
cat /sys/kernel/debug/kvm/*/vcpu0/pf_taken

# Guest TLB flush requests (also per-vCPU, same directory level)
cat /sys/kernel/debug/kvm/*/vcpu0/tlb_flush

# Shadow pages KVM couldn't make huge, due to the NX-huge-page mitigation
# (this one's a per-VM stat, directly under the VM directory)
cat /sys/kernel/debug/kvm/*/nx_lpage_splits

# Host sees guest RSS as the QEMU process
cat /proc/$(pgrep qemu)/status | grep VmRSS

# Check EPT is active
cat /sys/module/kvm_intel/parameters/ept
# Y   (or N if disabled)

# Force EPT off for testing (requires shadow paging fallback)
modprobe kvm_intel ept=0
```

## KVM dirty logging for live migration

Live migration must transfer guest memory to the destination. KVM's dirty logging tracks which pages were written since the last iteration:

```c
/* Enable dirty logging on a memory slot: */
struct kvm_dirty_log {
    __u32 slot;
    __u32 padding1;
    union {
        void __user *dirty_bitmap; /* userspace buffer for dirty bits */
        __u64 padding2;
    };
};

/* Phase 1: enable dirty logging */
struct kvm_userspace_memory_region region = {
    .slot  = 0,
    .flags = KVM_MEM_LOG_DIRTY_PAGES,  /* enable dirty tracking */
    .guest_phys_addr = 0,
    .memory_size = 4ULL << 30,         /* 4GB */
    .userspace_addr = (uint64_t)vm_mem,
};
ioctl(vm_fd, KVM_SET_USER_MEMORY_REGION, &region);

/* Phase 2: iterative copy — transfer dirty pages, clear bitmap, repeat */
void *dirty_bitmap = calloc(1, bitmap_size);
struct kvm_dirty_log dirty = {
    .slot = 0,
    .dirty_bitmap = dirty_bitmap,
};
ioctl(vm_fd, KVM_GET_DIRTY_LOG, &dirty);
/* Now dirty_bitmap has a bit set for each 4K page written since last call */
/* Transfer those pages to destination, then repeat */
```

The EPT hardware's dirty bit (EPT PTE bit 9) is cleared when KVM resets the bitmap. Next write access causes an EPT violation → KVM marks page dirty and re-enables the dirty bit.

### KVM_CAP_MANUAL_DIRTY_LOG_PROTECT2

A two-phase protocol for very large VMs that avoids races:

```bash
# Phase 1: get dirty pages (kernel also write-protects them to capture new dirtying)
ioctl(vm_fd, KVM_GET_DIRTY_LOG, &dirty);
# Transfer those dirty pages to destination...
# Phase 2: clear dirty bits for the pages just transferred
ioctl(vm_fd, KVM_CLEAR_DIRTY_LOG, &clear);
```

## Memory overcommit and KSM

```bash
# KSM (Kernel Samepage Merging): merge identical pages across VMs
echo 1 > /sys/kernel/mm/ksm/run         # enable
echo 200 > /sys/kernel/mm/ksm/pages_to_scan  # pages/interval
echo 100 > /sys/kernel/mm/ksm/sleep_millisecs

# Stats:
cat /sys/kernel/mm/ksm/pages_shared     # merged pages
cat /sys/kernel/mm/ksm/pages_sharing    # using those shared pages
cat /sys/kernel/mm/ksm/pages_unshared   # not mergeable
# savings = pages_sharing * 4KB

# QEMU: enable KSM for guest memory
# (automatic: QEMU calls madvise(MADV_MERGEABLE) on guest RAM)

# Memory balloon: reclaim memory from idle guests
# virtio-balloon driver in guest tells host to reclaim pages
# Used by libvirt/QEMU to over-provision RAM across VMs
```

## Further reading

### Kernel source

- [arch/x86/include/asm/kvm_host.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/kvm_host.h) — `struct kvm_mmu`: the per-vCPU MMU context (`root` — a `struct kvm_mmu_root_info` holding the root HPA — `page_fault` handler, `root_role`)
- [arch/x86/kvm/mmu/mmu_internal.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/mmu/mmu_internal.h) — `struct kvm_mmu_page`: one struct per shadow/EPT page-table page, including the reverse-map `parent_ptes`
- [arch/x86/kvm/mmu/mmu.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/mmu/mmu.c) — `kvm_mmu_page_fault()` and `kvm_mmu_hugepage_adjust()`: GPA fault resolution and huge-page level selection
- [arch/x86/kvm/vmx/vmx.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/vmx/vmx.c) — `handle_ept_violation()`: the VMX EPT-violation VM-exit handler
- [include/linux/kvm_host.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/kvm_host.h) — `struct kvm_memory_slot`: guest physical memory slot layout
- [include/uapi/linux/kvm.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/kvm.h) — `struct kvm_userspace_memory_region`, `struct kvm_dirty_gfn`, and the `KVM_SET_USER_MEMORY_REGION` / `KVM_MEM_LOG_DIRTY_PAGES` ioctl ABI
- [include/linux/kvm_dirty_ring.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/kvm_dirty_ring.h) — `struct kvm_dirty_ring`: the per-vCPU dirty-GFN ring buffer (5.11+)
- [drivers/virtio/virtio_balloon.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/virtio/virtio_balloon.c) — `update_balloon_stats()`: guest memory statistics reported to the host

### Related pages

- [KVM Architecture](kvm-arch.md) — /dev/kvm API, vCPU run loop
- [virtio](virtio.md) — paravirtual I/O: virtqueues, virtio-net, virtio-blk
- [VFIO](vfio.md) — direct device passthrough to VMs
- [KVM Live Migration](live-migration.md) — how dirty-bitmap and dirty-ring tracking drive the pre-copy migration loop
- [Memory Management: page tables](../mm/page-tables.md) — host-side page tables
- [Memory Management: THP](../mm/thp.md) — huge page promotion KVM uses

### LWN articles

- [KVM: Dirty ring interface](https://lwn.net/Articles/833784/) — Peter Xu's patch posting introducing the per-vCPU dirty-ring alternative to the dirty bitmap

### External

- [The Definitive KVM API Documentation](https://docs.kernel.org/virt/kvm/api.html) — memory slot ioctls (`KVM_SET_USER_MEMORY_REGION`), dirty logging (`KVM_GET_DIRTY_LOG`, `KVM_CLEAR_DIRTY_LOG`), and the dirty-ring capability
- [Kernel Samepage Merging](https://docs.kernel.org/admin-guide/mm/ksm.html) — the `/sys/kernel/mm/ksm/` sysfs knobs and how KSM deduplicates identical guest pages
- [Transparent Hugepage Support](https://docs.kernel.org/admin-guide/mm/transhuge.html) — THP configuration referenced in the guest huge-pages section above
