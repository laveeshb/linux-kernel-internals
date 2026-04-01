# x86-64 Page Tables

> 4-level and 5-level paging, CR3, PCID, and KPTI

Virtual memory on x86-64 uses a multi-level radix tree of page tables to translate virtual addresses to physical addresses. Understanding this translation is fundamental to understanding memory allocation, protection, isolation, and the Meltdown mitigations.

---

## 4-level paging: the standard case

On x86-64, the default is **4-level paging** using 48-bit virtual addresses. Each virtual address is decoded as five fields:

```
48-bit virtual address (canonical form):
 63        48 47    39 38    30 29    21 20    12 11      0
 ┌───────────┬────────┬────────┬────────┬────────┬────────┐
 │ sign ext  │  PGD   │  PUD   │  PMD   │  PTE   │ offset │
 │  (16 bit) │ (9 bit)│ (9 bit)│ (9 bit)│ (9 bit)│(12 bit)│
 └───────────┴────────┴────────┴────────┴────────┴────────┘
               L4 idx   L3 idx   L2 idx   L1 idx   byte off

Terminology used in the kernel source:
  PGD = Page Global Directory  (level 4, pointed to by CR3)
  PUD = Page Upper Directory   (level 3)
  PMD = Page Middle Directory  (level 2)
  PTE = Page Table Entry       (level 1, maps a 4KB page)
```

Each level is an array of 512 entries (2^9), each entry 8 bytes wide — exactly one 4KB page per level.

The hardware walks these four levels to translate a virtual address:

```
CR3 (physical addr of PGD)
  → PGD[VA[47:39]]  (physical addr of PUD page)
    → PUD[VA[38:30]] (physical addr of PMD page)
      → PMD[VA[29:21]] (physical addr of PTE page)
        → PTE[VA[20:12]] (physical addr of 4KB page frame)
          + VA[11:0]    (byte offset within the page)
          = Physical Address
```

The MMU caches recent translations in the **TLB** (Translation Lookaside Buffer) to avoid walking the page table on every memory access.

---

## Page table entry (PTE) bit layout

Each 8-byte entry in the page table uses a defined set of bits:

```
PTE (64-bit) format — applies to all levels (PGD, PUD, PMD, PTE):

 63  52 51      12 11 10  9  8  7  6  5  4  3  2  1  0
 ┌─────┬──────────┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐
 │ NX  │  PFN     │  │G │PS│D │A │PCD│PWT│U/S│R/W│ P │
 └─────┴──────────┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┘

 bit 0:  P   — Present: 1 = entry is valid; 0 = page not present (triggers #PF)
 bit 1:  R/W — Read/Write: 0 = read-only; 1 = writable
 bit 2:  U/S — User/Supervisor: 0 = kernel only; 1 = user accessible
 bit 3:  PWT — Page Write-Through (cache behavior)
 bit 4:  PCD — Page Cache Disable
 bit 5:  A   — Accessed: set by hardware on any access; used by LRU reclaim
 bit 6:  D   — Dirty: set by hardware on write; indicates page was modified
 bit 7:  PS  — Page Size: at PMD level → 2MB huge page; at PUD level → 1GB huge page
               At PTE level this bit is PAT (Page Attribute Table index bit 2)
 bit 8:  G   — Global: TLB entry not flushed on CR3 reload; used for kernel mappings
 bits 9-11:   Software-defined (kernel uses for various flags)
 bits 12-51:  PFN (Page Frame Number) — physical address >> 12
 bits 52-62:  Reserved (must be zero)
 bit 63:  NX  — No-Execute: 1 = code cannot be fetched from this page
                Requires EFER.NXE = 1 (set by kernel during boot)
```

### Kernel-side PTE manipulation

The kernel provides a set of functions to read and modify PTEs safely:

```c
/* arch/x86/include/asm/pgtable.h */

/* Check flags */
static inline int pte_present(pte_t pte)  { return pte_flags(pte) & _PAGE_PRESENT; }
static inline int pte_write(pte_t pte)    { return pte_flags(pte) & _PAGE_RW; }
static inline int pte_dirty(pte_t pte)    { return pte_flags(pte) & _PAGE_DIRTY; }
static inline int pte_young(pte_t pte)    { return pte_flags(pte) & _PAGE_ACCESSED; }
static inline int pte_exec(pte_t pte)     { return !(pte_flags(pte) & _PAGE_NX); }

/* Modify flags */
static inline pte_t pte_mkwrite(pte_t pte, struct vm_area_struct *vma)
{
    return pte_set_flags(pte, _PAGE_RW);
}
static inline pte_t pte_mkdirty(pte_t pte)  { return pte_set_flags(pte, _PAGE_DIRTY); }
static inline pte_t pte_mkyoung(pte_t pte)  { return pte_set_flags(pte, _PAGE_ACCESSED); }
static inline pte_t pte_wrprotect(pte_t pte) { return pte_clear_flags(pte, _PAGE_RW); }

/* Address translation helpers */
#define __pa(x)  ((unsigned long)(x) - PAGE_OFFSET)  /* virtual → physical */
#define __va(x)  ((void *)((unsigned long)(x) + PAGE_OFFSET))  /* physical → virtual */
```

`set_pte_at(mm, addr, ptep, pte)` writes a PTE atomically, handling TLB flushes as needed.

---

## 5-level paging (LA57)

5-level paging adds a fifth level called **P4D** (Page 4 Directory) above the PGD, extending the virtual address space from 48 bits to **57 bits**:

```
57-bit virtual address (5-level paging):
 63        57 56    48 47    39 38    30 29    21 20    12 11      0
 ┌───────────┬────────┬────────┬────────┬────────┬────────┬────────┐
 │ sign ext  │  P4D   │  PGD   │  PUD   │  PMD   │  PTE   │ offset │
 │  (7 bit)  │ (9 bit)│ (9 bit)│ (9 bit)│ (9 bit)│ (9 bit)│(12 bit)│
 └───────────┴────────┴────────┴────────┴────────┴────────┴────────┘
```

This provides 128 PB of virtual address space per process (versus 128 TB with 4-level paging).

5-level paging is enabled by setting `CR4.LA57 = 1` during kernel boot. The kernel detects support via CPUID leaf 7, subleaf 0, ECX bit 16. Linux support was introduced in **Linux 4.14**.

```bash
# Check if 5-level paging is in use
grep -i la57 /proc/cpuinfo     # CPU supports it
dmesg | grep -i "5-level\|la57"  # kernel enabled it
```

In kernel source, `CONFIG_X86_5LEVEL=y` enables compile-time support. At runtime, the kernel detects whether the CPU and BIOS support it and enables it during `startup_64` before the final page tables are set up.

---

## CR3: the page table register

`CR3` is the register that tells the MMU where the current process's top-level page table lives:

```
CR3 register (64-bit):
 63      12 11      0
 ┌─────────┬─────────┐
 │  PGD PA │  PCID   │
 │ (52 bit)│ (12 bit)│
 └─────────┴─────────┘

 bits 12-63: Physical address of the PGD (page-aligned, so bits 11:0 are zero)
 bits 11:0:  PCID (Process-Context Identifier) — see below
 bit 63:     (when writing CR3) if set AND PCID is in use, skip TLB flush
```

Loading CR3 with a new value switches the current page table. Every process context switch calls `switch_mm_irqs_off()` which writes the new process's PGD physical address into CR3.

```c
/* arch/x86/mm/tlb.c */
void switch_mm_irqs_off(struct mm_struct *prev, struct mm_struct *next,
                         struct task_struct *tsk)
{
    /* ... select correct CR3 value (accounting for KPTI, PCID) ... */
    load_new_mm_cr3(next_pgd, new_asid, new_lam, true);
}
```

---

## Huge pages: 2MB and 1GB

The `PS` bit in a non-leaf page table entry causes the hardware to treat that entry as a leaf — directly mapping a large page instead of pointing to the next table level:

| PS bit location | Page size | Alignment required |
|----------------|-----------|-------------------|
| PMD (level 2) | 2MB | 2MB aligned |
| PUD (level 3) | 1GB | 1GB aligned |

For a 2MB PMD entry, bits 20:0 of the virtual address are used as the offset within the 2MB page (no PTE level walk). The PMD entry's PFN field points directly to a 2MB-aligned physical frame.

Huge pages reduce TLB pressure: a single TLB entry covers 2MB instead of 4KB, so fewer entries are needed for the same working set.

The kernel uses 2MB huge pages for the **direct mapping** of all physical memory (the physmap, aliased by `__va()`/`__pa()`). User-visible huge pages are managed via `hugetlbfs` or Transparent Huge Pages (THP).

---

## PCID: Process-Context Identifiers

Without PCID, every CR3 load (context switch) must flush the entire TLB — because the new process's virtual-to-physical mappings would otherwise collide with the old process's cached translations.

**PCID** (Process-Context Identifier) is a 12-bit tag stored in bits 11:0 of CR3. The TLB stores the PCID alongside each cached translation. When switching to a new process, if its PCID differs from the current one, the CPU uses the new process's cached translations (tagged with its PCID) without flushing out the old entries.

```
TLB entry with PCID:
  [ PCID (12 bits) | Virtual Page Number (52 bits) ] → Physical Frame Number
```

PCID is enabled by setting `CR4.PCIDE = 1`. The kernel uses PCID to avoid full TLB flushes on context switch:

- Each `mm_struct` is assigned an ASID (address space ID) from the `pcid_asid_map[]` array
- On context switch, if the process has a valid PCID assigned and its translations are cached, CR3 is loaded with `bit 63 = 1` (no-flush) to preserve the TLB entries

```c
/* arch/x86/mm/tlb.c */
/*
 * Given an ASID, pick a PCID. The kernel uses a per-CPU
 * array to track which PCIDs are currently in use.
 */
static u16 user_pcid(u16 asid)
{
    u16 ret = asid;
    /* Kernel PCID is asid + TLB_NR_DYN_ASIDS */
    return ret;
}
```

PCID requires the `INVPCID` instruction to invalidate individual PCID-tagged TLB entries. Some early Haswell CPUs support PCID but not INVPCID — the kernel detects this and falls back.

---

## KPTI: Kernel Page Table Isolation

**KPTI** (Kernel Page Table Isolation) was introduced in **Linux 4.15** (January 2018) to mitigate **Meltdown** (CVE-2017-5754).

### The problem KPTI solves

Before KPTI, the kernel's page tables were always mapped — including when running user code. This meant a user process's page table always included kernel virtual addresses (marked non-accessible via U/S=0). Meltdown exploited speculative execution to read kernel memory through these mappings before the CPU's permission check raised a #GP.

### The two-PGD solution

KPTI maintains **two page tables per process**:

```
User PGD (loaded when running in userspace):
  - All user VMA mappings
  - Minimal kernel mappings: only what is needed to enter the kernel
    • The syscall/interrupt entry trampoline page (entry_SYSCALL_64)
    • The CPU's own per-CPU data needed for the initial stack switch
  - No kernel code, no kernel data, no physmap

Kernel PGD (loaded when running in the kernel):
  - All user VMA mappings
  - Full kernel mappings: all kernel code, data, physmap, modules, vmalloc
```

The two PGDs are allocated together as a pair. In `pgd_alloc()`, the kernel allocates two adjacent PGD pages and links them:

```c
/* arch/x86/mm/pgtable.c */
pgd_t *pgd_alloc(struct mm_struct *mm)
{
    pgd_t *pgd;
    /* Allocate two pages: one for user PGD, one for kernel PGD */
    pgd = _pgd_alloc();
    /* ... */
    pgd_prepopulate_pmd(mm, pgd, pmds);
    /* The "kernel" PGD is at pgd + PTRS_PER_PGD (one page later) */
    return pgd;
}
```

### CR3 switches on every kernel entry/exit

On every syscall, interrupt, or exception:

```
User → Kernel:
  1. CPU delivers exception/syscall
  2. Entry trampoline (mapped in user PGD) executes swapgs
  3. Load kernel CR3 (switch to full kernel page table)
  4. Switch to kernel stack
  5. Continue in kernel

Kernel → User:
  1. Restore user registers
  2. Load user CR3 (switch to user-only page table)
  3. swapgs
  4. SYSRET or IRET
```

The entry trampoline is in `arch/x86/entry/entry_64.S`. The `PAGE_TABLE_ISOLATION` config option controls KPTI.

### KPTI + PCID: reducing the overhead

The naive KPTI implementation would flush the entire TLB on every user↔kernel transition (two CR3 loads per syscall). With PCID, the kernel assigns separate PCIDs for the user PGD and kernel PGD of each process:

```
Process A, user PGD:   PCID = asid (e.g., 5)
Process A, kernel PGD: PCID = asid + 512 (e.g., 517)
```

With PCID, switching between the user and kernel PGDs preserves TLB entries for both. The CR3 is still reloaded, but with `bit 63 = 1` (no flush). This reduces the KPTI overhead from ~30% to roughly 5% on syscall-heavy workloads.

```bash
# Check if KPTI is active
cat /sys/devices/system/cpu/vulnerabilities/meltdown
# "Mitigation: PTI" = KPTI is on
# "Not affected"   = CPU is not vulnerable (or has hardware fix)

# See the PTI CR3 switch cost in perf
perf stat -e tlb:tlb_flush ls
```

---

## Kernel virtual address layout

The 64-bit kernel virtual address space is divided into regions (values are for a typical 4-level paging, non-5-level system with `CONFIG_X86_64`):

```
Virtual address layout (x86-64, 4-level paging, kernel 6.x):

ffff888000000000 - ffffc87fffffffff  Direct mapping of all physical memory (physmap)
                                     Accessed via __va() / __pa()
ffffc90000000000 - ffffe8ffffffffff  vmalloc / ioremap area
ffffe90000000000 - ffffe9ffffffffff  Hole
ffffea0000000000 - ffffeaffffffffff  Virtual memory map (struct page array)
ffffec0000000000 - fffffbffffffffff  KASAN shadow memory (if CONFIG_KASAN)
fffffe0000000000 - fffffe7fffffffff  cpu_entry_area (per-CPU entry trampoline, fixmap)
fffffe8000000000 - fffffeffffffffff  LDT remap area
ffffff0000000000 - ffffff7fffffffff  %esp fixup stacks
ffffffef00000000 - fffffffeffffffff  EFI runtime services mapping
ffffffff80000000 - ffffffff9fffffff  Kernel text (.text, .rodata)
ffffffffa0000000 - fffffffffeffffff  Modules
ffffffffff000000 - ffffffffffffffff  Fixmap
```

The physmap (direct mapping) allows the kernel to access any physical page via a simple arithmetic offset: `phys_addr + PAGE_OFFSET = virt_addr`. `PAGE_OFFSET` is `0xffff888000000000` on a standard x86-64 kernel.

---

## Observing page tables

```bash
# Process virtual memory map
cat /proc/$$/maps
cat /proc/$$/smaps       # includes RSS, anonymous/file-backed breakdown

# Page table usage statistics
cat /proc/$$/status | grep VmPTE   # page table memory used

# Kernel virtual address layout
dmesg | grep -E "Virtual kernel memory layout" -A 20

# Page table debugging (requires CONFIG_X86_PTDUMP or CONFIG_PTDUMP_DEBUGFS)
ls /sys/kernel/debug/page_tables/
cat /sys/kernel/debug/page_tables/kernel

# PCID / ASID usage — no direct interface, but visible in perf
perf stat -e dTLB-load-misses,iTLB-load-misses <command>

# With crash(8) on a vmcore, translate a virtual address
# crash> vtop <address>
# crash> ptov <physical_address>

# Check if huge pages are in use for kernel text
dmesg | grep -i "huge\|2M\|PMD"
```

---

## Key kernel functions

| Function | File | Purpose |
|----------|------|---------|
| `pgd_alloc()` | `arch/x86/mm/pgtable.c` | Allocate PGD (and shadow PGD for KPTI) |
| `pgd_free()` | `arch/x86/mm/pgtable.c` | Free PGD pair |
| `__pa()` / `__va()` | `arch/x86/include/asm/page.h` | Physical↔virtual address conversion |
| `pte_mkwrite()` | `arch/x86/include/asm/pgtable.h` | Set R/W bit in PTE |
| `set_pte_at()` | `arch/x86/mm/pgtable.c` | Atomically write a PTE |
| `flush_tlb_mm()` | `arch/x86/mm/tlb.c` | TLB flush for an entire mm |
| `flush_tlb_page()` | `arch/x86/mm/tlb.c` | TLB flush for a single page |
| `switch_mm_irqs_off()` | `arch/x86/mm/tlb.c` | Context switch — load new CR3 |
| `load_new_mm_cr3()` | `arch/x86/mm/tlb.c` | Write CR3, handling PCID and KPTI |

---

## Version notes

| Feature | Linux version | Notes |
|---------|--------------|-------|
| 4-level paging | Always | Default on x86-64 |
| NX bit (EFER.NXE) | 2.6.8 | No-execute support |
| PCID support | 3.2 | CR4.PCIDE, avoids full TLB flush |
| 5-level paging (LA57) | 4.14 | `CONFIG_X86_5LEVEL`, CR4.LA57 |
| KPTI (Meltdown fix) | 4.15 | Two PGDs, CR3 switch on entry/exit |
| KPTI + PCID optimization | 4.15 | Dual-ASID scheme, `bit 63` no-flush |
