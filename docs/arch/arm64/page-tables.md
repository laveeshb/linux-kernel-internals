# ARM64 Page Tables

> TTBR0/TTBR1, translation granules, PTE format, and ASID

ARM64's MMU uses a two-register design to handle user and kernel address spaces independently. This page covers the hardware page table walk, how Linux structures its page table types, the PTE bit layout, ASID-based TLB management, and Stage 2 translation for KVM.

---

## Two TTBRs: user and kernel address spaces

ARM64 splits the virtual address space at the midpoint using the **top bit of the virtual address**. Two translation base registers tell the MMU where to start the walk:

| Register | Address range | Used for |
|---|---|---|
| `TTBR0_EL1` | `[0, 2^VA_BITS)` — low addresses | User space (per-process) |
| `TTBR1_EL1` | `[2^64 - 2^VA_BITS, 2^64)` — high addresses | Kernel (global) |

With the default `VA_BITS=48`, user space occupies `[0, 0x0000_FFFF_FFFF_FFFF]` and the kernel occupies `[0xFFFF_0000_0000_0000, 0xFFFF_FFFF_FFFF_FFFF]`. The top bit (bit 63) of a virtual address selects the register: bit 63 = 0 uses TTBR0, bit 63 = 1 uses TTBR1. Any address with bits between VA_BITS-1 and 63 not all matching (i.e., not properly sign-extended) causes a Translation Fault.

**52-bit VA (optional):** ARMv8.7+ supports 52-bit virtual addresses (`VA_BITS=52`) with `CONFIG_ARM64_VA_BITS_52`. This still uses 4 translation levels (not 5); the extra bits come from widening the Level 0 index field. This extends the user and kernel ranges to 4PB each. Most production configs still use 48-bit.

On context switch, the kernel writes the new process's PGD physical address into `TTBR0_EL1`. The ASID (see below) is packed into bits `[63:48]` of `TTBR0_EL1` at the same time. `TTBR1_EL1` is set once at boot and never changes.

```c
/* arch/arm64/include/asm/mmu_context.h */
static inline void cpu_switch_mm(pgd_t *pgd, struct mm_struct *mm)
{
    BUG_ON(pgd == swapper_pg_dir);
    cpu_set_reserved_ttbr0();
    /* ASID packed in mm->context.id; cpu_do_switch_mm writes TTBR0_EL1
     * with the new PGD PA and ASID together — no TLB flush needed when
     * switching to a different ASID (that is the whole point of ASIDs). */
    cpu_do_switch_mm(virt_to_phys(pgd), mm);
}
```

---

## Translation granules

The **translation granule** is the base page size. ARM64 supports three granule sizes, each changing the number of levels needed and the size of each level's table:

| Granule | Page size | Levels (48-bit VA) | Notes |
|---|---|---|---|
| 4KB | 4KB | 4 (L0→L1→L2→L3) | Most common; default in Linux |
| 16KB | 16KB | 4 (L0→L1→L2→L3) | Apple Silicon uses this |
| 64KB | 64KB | 3 (L1→L2→L3) | Fewer levels; large contiguous TLB entries |

The granule is selected by `TCR_EL1.TG0` (for TTBR0) and `TCR_EL1.TG1` (for TTBR1).

### 4KB granule: level coverage (48-bit VA)

With a 4KB granule each page table is exactly one 4KB page containing 512 8-byte entries (9 index bits per level):

```
Level   Index bits   Entries   Coverage per entry
─────   ──────────   ───────   ──────────────────
L0      [47:39]        512      512 GB
L1      [38:30]        512        1 GB
L2      [29:21]        512        2 MB  (block descriptor = huge page)
L3      [20:12]        512        4 KB  (page descriptor = normal page)
                                ────
Page offset [11:0]     —        4 KB
```

---

## The 4-level page table walk (48-bit VA, 4KB granule)

For a 48-bit virtual address with a 4KB granule, the hardware performs a 4-level walk:

```
48-bit Virtual Address:
 47      39 38      30 29      21 20      12 11       0
 ┌─────────┬──────────┬──────────┬──────────┬──────────┐
 │ L0 index│ L1 index │ L2 index │ L3 index │  offset  │
 │ (9 bits)│ (9 bits) │ (9 bits) │ (9 bits) │ (12 bits)│
 └─────────┴──────────┴──────────┴──────────┴──────────┘

Walk (TTBR0 for user, TTBR1 for kernel):

TTBR0_EL1 or TTBR1_EL1 → physical address of L0 table
  L0_table[VA[47:39]]   → physical address of L1 table
    L1_table[VA[38:30]] → physical address of L2 table  (or 1GB block)
      L2_table[VA[29:21]] → physical address of L3 table (or 2MB block)
        L3_table[VA[20:12]] → physical address of 4KB page frame
          + VA[11:0]         = final physical address
```

The MMU caches translations in the TLB, keyed on VA + ASID. On a TLB miss, the hardware page table walker performs the walk automatically (hardware-managed TLB on ARM64 — no software TLB fill required in the common case).

---

## PTE format

ARM64 descriptors are 64-bit values. The meaning of bits depends on the level and whether the entry is a **table**, **block**, or **page** descriptor.

```
ARM64 Page/Block Descriptor (64-bit):

 63   59 58   55 54 53 52 51      12 11 10  9  8  7  6  5  4  2  1  0
 ┌──────┬───────┬──┬──┬──┬──────────┬──┬──┬──┬──┬──┬──┬─────┬──┬──┐
 │ PBHA │ SW   │UXN│PXN│Cont│  OA   │nG│AF│SH│AP│NS│  │AtIdx│type│V│
 └──────┴───────┴──┴──┴──┴──────────┴──┴──┴──┴──┴──┴──┴─────┴──┴──┘

 bit 0:     Valid (V)        — 1 = entry is valid
 bit 1:     Type             — at L0-L2: 1 = table descriptor, 0 = block descriptor
                               at L3: 1 = page descriptor (must be 1 for valid pages)
 bits [4:2]: AttrIndx[2:0]  — index into MAIR_EL1 (memory type selection)
 bit 5:     NS               — Non-Secure (applies in Secure state)
 bits [7:6]: AP[2:1]         — Access Permissions (see table below)
 bits [9:8]: SH[1:0]         — Shareability: 00=non-shareable, 10=outer, 11=inner
 bit 10:    AF               — Access Flag: fault on first access if 0 (SW manages)
 bit 11:    nG               — not-Global: 1 = ASID-tagged (user), 0 = global (kernel)
 bits [47:12]: Output Address (OA) — physical page frame number (bits [47:12] of PA)
 bit 52:    Contiguous hint  — TLB can merge contiguous entries
 bit 53:    PXN              — Privileged Execute Never (EL1 cannot execute)
 bit 54:    UXN              — Unprivileged Execute Never (EL0 cannot execute)
 bits [58:55]: SW            — Software-defined (kernel uses for _PAGE_* flags)
 bits [63:59]: PBHA          — Page-Based Hardware Attributes (ARMv8.2+)
```

### Access Permission (AP[2:1]) encoding

| AP[2:1] | EL1 (kernel) | EL0 (user) |
|---|---|---|
| `00` | Read/Write | No access |
| `01` | Read/Write | Read/Write |
| `10` | Read-Only | No access |
| `11` | Read-Only | Read-Only |

Linux sets `UXN` on all kernel mappings and `PXN` on all user mappings (preventing user code from being executed at EL1 and vice versa). The `AF` (Access Flag) bit: on pre-ARMv8.1 hardware it is managed by software — a PTE with AF=0 generates an Access Flag Fault on first access, which the kernel handles by setting AF=1. On ARMv8.1+ hardware with `FEAT_HAFDBS`, Linux enables hardware-managed AF (`TCR_EL1.HA=1`), so the CPU sets AF automatically without faulting. The Access Flag is used by the page reclaim path to distinguish recently-accessed pages.

### ARM64 vs x86-64 PTE comparison

| Concept | ARM64 | x86-64 |
|---|---|---|
| Valid bit | bit 0 (`V`) | bit 0 (`P` — Present) |
| Read/Write | `AP[2:1]` field | bit 1 (`R/W`) |
| User access | `AP[2:1]` field | bit 2 (`U/S`) |
| Execute disable | `UXN` (bit 54), `PXN` (bit 53) | bit 63 (`NX`) |
| Cache type | `AttrIndx` → `MAIR_EL1` | `PCD`/`PWT`/`PAT` bits |
| Huge page marker | bit 1 = 0 at L1/L2 (block) | `PS` bit at PMD/PUD |
| Global (no ASID flush) | `nG` = 0 | bit 8 (`G`) |
| Dirty / Accessed | Software-managed via AF fault | Hardware-set bits 5 (`A`) and 6 (`D`) |

---

## Huge pages: block descriptors

ARM64 uses **block descriptors** to map large contiguous physical regions without traversing all four levels. A block descriptor at L1 or L2 has bit 1 (`type`) = 0:

| Level | Block size | Linux term |
|---|---|---|
| L1 | 1 GB | `pud_huge()` — 1GB huge page |
| L2 | 2 MB | `pmd_huge()` — 2MB huge page (THP, hugetlbfs) |

Linux detects block descriptors with `pmd_huge()` defined in `arch/arm64/include/asm/pgtable.h`:

```c
/* arch/arm64/include/asm/pgtable.h */
static inline int pmd_huge(pmd_t pmd)
{
    return pmd_val(pmd) && !(pmd_val(pmd) & PMD_TABLE_BIT);
}
```

`PMD_TABLE_BIT` is bit 1. A valid PMD entry with bit 1 clear is a 2MB block descriptor.

Transparent Huge Pages (THP) and `hugetlbfs` both use 2MB block descriptors. The kernel also maps its own text and data sections with 2MB blocks when alignment allows (visible in `arch/arm64/mm/mmu.c` via `create_mapping_noalloc()`).

---

## Linux kernel page table types

Linux uses a generic five-level abstraction over the hardware levels. On ARM64 with 48-bit VA and 4KB granule, `p4d_t` is **folded** (a no-op alias for `pgd_t`):

| Linux type | Hardware level | Source |
|---|---|---|
| `pgd_t` | L0 (pointed to by TTBR0/TTBR1) | `arch/arm64/include/asm/pgtable-types.h` |
| `p4d_t` | Folded into PGD (48-bit VA) | `include/asm-generic/pgtable-nop4d.h` |
| `pud_t` | L1 | `arch/arm64/include/asm/pgtable-types.h` |
| `pmd_t` | L2 | `arch/arm64/include/asm/pgtable-types.h` |
| `pte_t` | L3 | `arch/arm64/include/asm/pgtable-types.h` |

All types are wrappers around `u64`. The underlying hardware descriptor value is accessed with `pgd_val()`, `pud_val()`, `pmd_val()`, `pte_val()`.

Standard page table navigation macros:

```c
/* Given a mm_struct and virtual address, walk down to the PTE: */
pgd_t *pgd = pgd_offset(mm, addr);       /* index into mm->pgd */
p4d_t *p4d = p4d_offset(pgd, addr);      /* folded on 48-bit ARM64 */
pud_t *pud = pud_offset(p4d, addr);
pmd_t *pmd = pmd_offset(pud, addr);
pte_t *pte = pte_offset_map(pmd, addr);  /* maps the PTE page, returns kernel VA */
```

`pte_offset_map()` is defined in `arch/arm64/include/asm/pgtable.h` and handles the physical-to-virtual translation for the PTE page pointer.

---

## ASID: Address Space Identifiers

Every user-space mapping in a PTE has `nG` (not-Global) = 1. This means the TLB tags the entry with the current **ASID** (Address Space Identifier). Different processes with different ASIDs can coexist in the TLB without interference, avoiding a full TLB flush on every context switch.

### ASID storage

The ASID is stored in `TTBR0_EL1[63:48]` (16-bit ASID field, when `TCR_EL1.AS=1`). Each time a process is scheduled, the kernel writes both the ASID and the PGD address into `TTBR0_EL1` atomically. Kernel mappings use `nG=0` (global), so they are not tagged with an ASID and are never evicted by ASID-based TLB operations.

The per-process ASID is stored in `mm->context.id` and managed by `check_and_switch_context()` in `arch/arm64/mm/context.c`:

```c
/* arch/arm64/mm/context.c */
void check_and_switch_context(struct mm_struct *mm)
{
    unsigned long flags;
    unsigned int cpu;
    u64 asid, old_active_asid;

    asid = atomic64_read(&mm->context.id);

    /*
     * If the current ASID is still valid for this CPU, use it without
     * taking the lock.  Otherwise fall through to the slow path.
     */
    old_active_asid = atomic64_read(this_cpu_ptr(&active_asids));
    if (asid_gen_match(asid) &&
        atomic64_cmpxchg_relaxed(this_cpu_ptr(&active_asids),
                                 old_active_asid, asid))
        goto switch_mm_fastpath;

    raw_spin_lock_irqsave(&cpu_asid_lock, flags);
    /* ... slow path: allocate new ASID or flush on generation wrap ... */
    raw_spin_unlock_irqrestore(&cpu_asid_lock, flags);

switch_mm_fastpath:
    cpu_switch_mm(mm->pgd, mm);
}
```

### ASID generation wrap

ARM64 supports 8-bit or 16-bit ASIDs (`TCR_EL1.AS`). Linux detects ASID width at runtime from `ID_AA64MMFR0_EL1.ASIDBits` and uses 16-bit ASIDs where available. With 16-bit ASIDs there are 65536 possible values. When they are exhausted, the kernel bumps an internal **generation counter** and flushes the entire TLB (`TLBI VMALLE1IS`), then reallocates ASIDs from scratch.

---

## MAIR_EL1: Memory Attribute Indirection Register

The `AttrIndx[2:0]` field in every PTE is an index into `MAIR_EL1`, which maps 8 attribute slots to actual memory types. This indirection allows PTE format to stay compact while supporting many memory types.

Linux sets up `MAIR_EL1` once at boot in `arch/arm64/mm/proc.S`:

```asm
/* arch/arm64/mm/proc.S — MAIR_EL1 setup during __cpu_setup */
/*
 * MAIR_EL1 attribute encoding (one byte per slot, 8 slots = 64 bits):
 *
 * Slot  AttrIndx  Attr byte  Memory type
 * ────  ────────  ─────────  ───────────────────────────────────────
 *   0     0b000   0x00       Device-nGnRnE  (strongly ordered device)
 *   1     0b001   0x04       Device-nGnRE   (device, gathering+reordering ok)
 *   2     0b010   0x0C       Device-GRE     (device, gathering+reordering+early-write ok)
 *   3     0b011   0x44       Normal Non-Cacheable (NC)
 *   4     0b100   0xFF       Normal Write-Back, Read-Allocate, Write-Allocate (WB)
 *   5     0b101   0xBB       Normal Write-Through, Read-Allocate (WT)
 *   6     0b110   0x40       Normal Non-Cacheable Outer, NC Inner
 *   7     0b111   0xFF       Normal WB (duplicate; used by Tagged Normal memory)
 *
 * Linux primary slots:
 *   MT_DEVICE_nGnRnE  = 0  (ioremap strongly ordered)
 *   MT_DEVICE_nGnRE   = 1  (ioremap device)
 *   MT_DEVICE_GRE     = 2  (ioremap write-combining)
 *   MT_NORMAL_NC      = 3  (DMA non-cacheable)
 *   MT_NORMAL         = 4  (normal RAM — all kernel/user memory)
 *   MT_NORMAL_WT      = 5  (write-through)
 */
ldr x5, =MAIR_EL1_SET
msr mair_el1, x5
isb
```

The constant `MAIR_EL1_SET` is built from individual `MAIR_ATTRIDX()` macros in `arch/arm64/include/asm/pgtable-hwdef.h`. User-space and kernel text/data use slot 4 (`MT_NORMAL`, `AttrIndx=0b100`). Device memory mapped via `ioremap()` uses slot 0 (`MT_DEVICE_nGnRnE`).

---

## TLB operations

ARM64 uses **broadcast TLB invalidation instructions** (`TLBI`) rather than IPIs. These instructions propagate across CPUs within a shareability domain automatically when the `IS` (Inner Shareable) suffix is used.

### Key TLBI instructions

| Instruction | Invalidates | When to use |
|---|---|---|
| `TLBI VAE1IS, Xt` | Entry by VA + current ASID, inner shareable | Single page unmap (user) |
| `TLBI VALE1IS, Xt` | Entry by VA + ASID, last-level only | More common for leaf pages |
| `TLBI ASIDE1IS, Xt` | All entries matching ASID, inner shareable | Process exit (mm teardown) |
| `TLBI VMALLE1IS` | All EL1 entries (all ASIDs), inner shareable | ASID generation wrap |
| `TLBI VAAE1IS, Xt` | Entry by VA, all ASIDs | Kernel mapping change |

The operand `Xt` encodes the VA shifted right by 12 (page-aligned) ORed with the ASID in bits `[63:48]`.

### Required TLB invalidation sequence

Writing a new PTE and then invalidating the TLB must follow a strict ordering to prevent the MMU from caching a stale translation:

```
1. Write new PTE to memory
2. DSB ISHST       — ensure the PTE store is visible to all CPUs before TLBI
3. TLBI VAE1IS     — broadcast TLB invalidation
4. DSB ISH         — wait for TLB invalidation to complete on all CPUs
5. ISB             — flush instruction pipeline (see new mappings for instruction fetch)
```

In Linux C code, `flush_tlb_page()` in `arch/arm64/include/asm/tlbflush.h` implements this:

```c
/* arch/arm64/include/asm/tlbflush.h */
static inline void flush_tlb_page(struct vm_area_struct *vma,
                                   unsigned long uaddr)
{
    unsigned long addr = __TLBI_VADDR(uaddr, ASID(vma->vm_mm));

    dsb(ishst);              /* DSB ISH ST: wait for PTE stores to complete */
    __tlbi(vale1is, addr);   /* TLBI VALE1IS: invalidate last-level TLB entry */
    dsb(ish);                /* DSB ISH: wait for TLB invalidation to propagate */
}
```

Note there is no `ISB` in `flush_tlb_page()` itself because it is only used for data mappings; the ISB is required only when instruction mappings change (e.g., `flush_icache_range()`).

`__TLBI_VADDR()` is a macro that encodes the page-aligned address and ASID into the format expected by the `TLBI` operand. `__tlbi()` expands to an inline assembly `TLBI` instruction via the `SYS` instruction encoding.

---

## Stage 2 translation (KVM)

When KVM is active, the CPU runs at EL2 and guests run at EL1/EL0. Guest virtual addresses are translated first by the **Stage 1** page tables (guest OS's own `TTBR0_EL1`/`TTBR1_EL1`) to **Intermediate Physical Addresses (IPA)**, then by **Stage 2** page tables to real **Physical Addresses (PA)**.

Stage 2 is controlled by `VTTBR_EL2`, which holds the physical address of the Stage 2 PGD (the **IPA→PA** translation table). The Stage 2 tables use a similar descriptor format to Stage 1 but with different attribute fields (`S2AP`, `S2SH`, `MemAttr`).

```
Guest VA ──[Stage 1: TTBR0/TTBR1]──► IPA ──[Stage 2: VTTBR_EL2]──► PA
                 (Guest OS controls)              (KVM controls)
```

TLB invalidation for guests requires `TLBI` instructions with the `VMID` suffix (e.g., `TLBI IPAS2E1IS`) to invalidate only entries for the current VM's VMID. The VMID is stored in `VTTBR_EL2[55:48]`.

Stage 2 management in Linux lives in `arch/arm64/kvm/mmu.c`. See the [KVM Architecture](../../virtualization/kvm-arch.md) and [Memory Virtualization](../../virtualization/kvm-memory.md) docs for details.

---

## Observing ARM64 page tables

```bash
# Virtual address layout on ARM64
dmesg | grep -E "Virtual kernel memory layout" -A 20

# Per-process page table memory
cat /proc/$$/status | grep VmPTE

# Memory mapping of current process
cat /proc/$$/maps
cat /proc/$$/smaps   # includes page-level breakdown

# Check VA_BITS (kernel config)
zcat /proc/config.gz | grep ARM64_VA_BITS

# Check translation granule
zcat /proc/config.gz | grep ARM64_4K_PAGES

# TLB miss rate (requires PMU access)
perf stat -e dTLB-load-misses,iTLB-load-misses <command>

# ASID allocation (DEBUG_VM builds expose asid info via dmesg)
dmesg | grep -i asid

# Page table dump (requires CONFIG_PTDUMP_DEBUGFS)
ls /sys/kernel/debug/page_tables/
cat /sys/kernel/debug/page_tables/kernel
```

---

## Key kernel functions and files

| Symbol | File | Purpose |
|---|---|---|
| `pgd_t`, `pud_t`, `pmd_t`, `pte_t` | `arch/arm64/include/asm/pgtable-types.h` | Page table entry types |
| `pgd_offset()`, `pud_offset()`, `pmd_offset()` | `arch/arm64/include/asm/pgtable.h` | VA → page table level pointer |
| `pte_offset_map()` | `arch/arm64/include/asm/pgtable.h` | Map PTE page, return pointer |
| `pmd_huge()` | `arch/arm64/include/asm/pgtable.h` | Detect 2MB block descriptor |
| `pud_huge()` | `arch/arm64/include/asm/pgtable.h` | Detect 1GB block descriptor |
| `set_pte_at()` | `arch/arm64/mm/pgtable.c` | Write PTE (with barrier) |
| `flush_tlb_page()` | `arch/arm64/include/asm/tlbflush.h` | Single-page TLB invalidation |
| `flush_tlb_mm()` | `arch/arm64/include/asm/tlbflush.h` | Full mm TLB flush (ASIDE1IS) |
| `check_and_switch_context()` | `arch/arm64/mm/context.c` | ASID allocation and mm switch |
| `cpu_do_switch_mm()` | `arch/arm64/mm/proc.S` | Write TTBR0_EL1 with new ASID+PGD |
| `__cpu_setup()` | `arch/arm64/mm/proc.S` | Configure TCR_EL1, MAIR_EL1, SCTLR_EL1 |
| `create_mapping_noalloc()` | `arch/arm64/mm/mmu.c` | Build kernel page table entries |
| `MAIR_EL1_SET` | `arch/arm64/include/asm/pgtable-hwdef.h` | MAIR value built from slot macros |

---

## Further reading

- [Memory Model](memory-model.md) — ARM64 weak memory ordering, DSB/ISB, page table barriers
- [Exception Model](exception-model.md) — EL0–EL3, how EL2 relates to Stage 2 translation
- [Page Tables (generic)](../../mm/page-tables.md) — Linux pgd/pud/pmd/pte abstraction layer
- [Page Fault Handler](../../mm/page-fault.md) — how the kernel handles Translation Faults and Access Flag Faults
- [Transparent Huge Pages](../../mm/thp.md) — how Linux promotes 4KB pages to 2MB block descriptors
- [KVM Memory Virtualization](../../virtualization/kvm-memory.md) — Stage 2 page tables, EPT/NPT analog on ARM64
- [TLB Optimization](../../mm/tlb-optimization.md) — batched TLB invalidation and mmu_gather
- ARM Architecture Reference Manual (DDI 0487) — D5: AArch64 Virtual Memory System Architecture
- [Documentation/arch/arm64/memory.rst](https://docs.kernel.org/arch/arm64/memory.html) — ARM64 virtual address layout
