# x86_64 Boot Page Table Setup

> How the Linux kernel builds its own address space from scratch on x86_64 — from the first assembly instructions through the direct physical map, KASLR, and 5-level paging

!!! note "Architecture scope"
    This page covers x86_64 exclusively. ARM64, RISC-V, and other architectures have different boot paging sequences. For the generic page table abstraction that Linux uses across architectures, see [Page Tables](page-tables.md).

## Key Source Files

| File | Role |
|------|------|
| `arch/x86/kernel/head_64.S` | Entry point, early page table data (`early_top_pgt`, `init_top_pgt`, `level3_kernel_pgt`) |
| `arch/x86/boot/startup/map_kernel.c` | `__startup_64()` — first C code that fixes up page table physical addresses |
| `arch/x86/mm/init.c` | `init_mem_mapping()`, `memory_map_top_down()`, `memory_map_bottom_up()` |
| `arch/x86/mm/init_64.c` | `paging_init()`, `mem_init()` |
| `arch/x86/mm/kaslr.c` | `kernel_randomize_memory()` — virtual layout randomization |
| `arch/x86/lib/kaslr.c` | `kaslr_get_random_long()` — hardware entropy (RDRAND, TSC, i8254) |
| `arch/x86/boot/compressed/kaslr.c` | Physical KASLR during decompression |
| `arch/x86/include/asm/page_64_types.h` | `__PAGE_OFFSET_BASE_L4`, `__START_KERNEL_map`, `KERNEL_IMAGE_SIZE` |
| `arch/x86/include/asm/pgtable_64_types.h` | `__VMALLOC_BASE_L4`, `VMALLOC_SIZE_TB_L4`, page table level constants |
| `arch/x86/include/asm/pgtable_64.h` | `init_top_pgt[]` declaration, `swapper_pg_dir` alias |
| `Documentation/arch/x86/x86_64/mm.rst` | Authoritative virtual memory map for 4-level and 5-level paging |

---

## The Boot Paging Problem

When the kernel first receives control at `startup_64` in `arch/x86/kernel/head_64.S`, the CPU is already in 64-bit long mode — but the page tables are not the kernel's own. The bootloader or UEFI firmware created a temporary identity mapping (virtual address == physical address) that covers enough memory to load and decompress the kernel image, but no more.

Before the kernel can run normally it must:

1. Fix up the early page tables it compiled in, adjusting for the physical load address
2. Build an identity mapping covering its own code so the switch from physical to virtual addresses does not crash the CPU mid-instruction
3. Map the kernel text and data at their high virtual addresses (`0xffffffff80000000` and above)
4. Build the direct physical memory map — a complete mapping of all RAM into kernel virtual space
5. Set up vmalloc space, vmemmap, and fixmap regions
6. Optionally randomize all of these regions with KASLR

The challenge is that much of this must happen before the allocator exists, before `printk` works, and before exception handlers are fully in place — using only statically allocated page table arrays declared in assembly.

---

## Early Boot Page Tables in head_64.S

### The Static Arrays

`arch/x86/kernel/head_64.S` declares several page table arrays in the `.data` and `__INITDATA` sections. These are the only page tables available from the very first instruction:

```asm
/* arch/x86/kernel/head_64.S */

SYM_DATA_START_PTI_ALIGNED(early_top_pgt)
    .fill   511,8,0
    .quad   level3_kernel_pgt - __START_KERNEL_map + _PAGE_TABLE_NOENC
    /* [+ PTI_USER_PGD_FILL padding if CONFIG_MITIGATION_PAGE_TABLE_ISOLATION] */
SYM_DATA_END(early_top_pgt)

SYM_DATA_START_PTI_ALIGNED(init_top_pgt)
    .fill   512,8,0
    /* [+ PTI_USER_PGD_FILL padding if CONFIG_MITIGATION_PAGE_TABLE_ISOLATION] */
SYM_DATA_END(init_top_pgt)

SYM_DATA_START_PAGE_ALIGNED(level4_kernel_pgt)  /* used only in 5-level mode */
    .fill   511,8,0
    .quad   level3_kernel_pgt - __START_KERNEL_map + _PAGE_TABLE_NOENC
SYM_DATA_END(level4_kernel_pgt)

SYM_DATA_START_PAGE_ALIGNED(level3_kernel_pgt)
    .fill   L3_START_KERNEL,8,0   /* empty entries up to the kernel's PUD slot */
    .quad   level2_kernel_pgt - __START_KERNEL_map + _KERNPG_TABLE_NOENC
    .quad   level2_fixmap_pgt - __START_KERNEL_map + _PAGE_TABLE_NOENC
SYM_DATA_END(level3_kernel_pgt)

SYM_DATA_START_PAGE_ALIGNED(level2_kernel_pgt)
    /* 2MB huge-page PMD entries for the kernel image region */
    PMDS(0, __PAGE_KERNEL_LARGE_EXEC, KERNEL_IMAGE_SIZE/PMD_SIZE)
SYM_DATA_END(level2_kernel_pgt)
```

`L3_START_KERNEL` is `pud_index(__START_KERNEL_map)`, placing the kernel in slot 510 of `level3_kernel_pgt`. Slot 511 maps the fixmap region.

`init_top_pgt` starts out completely empty. It becomes the permanent kernel PGD after `__startup_64` runs. On x86_64, `swapper_pg_dir` is simply an alias for `init_top_pgt` (defined in `arch/x86/include/asm/pgtable_64.h`):

```c
extern pgd_t init_top_pgt[];
#define swapper_pg_dir init_top_pgt
```

A pool of 64 scratch PMD tables (`early_dynamic_pgts[EARLY_DYNAMIC_PAGE_TABLES]`) is declared alongside these. `__startup_64()` carves from this pool to build the temporary identity mapping.

### What `__startup_64()` Does

The first C function to run is `__startup_64()` in `arch/x86/boot/startup/map_kernel.c`. It is called from `startup_64` before `CR3` is loaded with the kernel's own tables.

```c
/* arch/x86/boot/startup/map_kernel.c */
unsigned long __init __startup_64(unsigned long p2v_offset,
                                  struct boot_params *bp)
```

Because the kernel may be loaded at a different physical address than it was compiled for (due to KASLR or bootloader placement), all addresses in the pre-built page table arrays are wrong. `__startup_64()` corrects them:

1. **Compute `load_delta`** — the difference between the compiled-in virtual address `__START_KERNEL_map` and the actual physical address, expressed as an addend.

2. **Fix `early_top_pgt`** — add `load_delta` to the PGD entry pointing at `level3_kernel_pgt` (slot 511, the `__START_KERNEL_map` region).

3. **Fix `level3_kernel_pgt`** — add `load_delta` to its two populated PUD entries (kernel image and fixmap).

4. **Fix `level2_fixmap_pgt`** — relocate the fixmap PMD entries.

5. **Build the identity map in `early_dynamic_pgts`** — allocate PUD and PMD tables from the pool and wire them into `early_top_pgt`. The identity mapping covers the physical pages that contain the kernel image itself so the CPU can keep fetching instructions while `CR3` is being reloaded. These entries deliberately do **not** have the global (`_PAGE_GLOBAL`) bit set so they are flushed when the kernel later switches to `init_top_pgt`.

6. **Validate `level2_kernel_pgt`** — pages before the kernel text and after `_end` have `_PAGE_PRESENT` cleared so speculative accesses cannot reach reserved memory.

### The Two-Stage CR3 Switch

```
startup_64 entry
    │
    ├─ call __startup_64()           ← fix physical addresses, build identity map
    │
    ├─ mov early_top_pgt → CR3       ← activate kernel's tables (identity map live)
    │
    └─ jmp common_startup_64         ← jump to virtual address (identity map used here)
           │
           ├─ secondary_startup_64:
           │    mov init_top_pgt → CR3   ← switch to permanent PGD
           │    (identity map gone)
           │
           └─ start_kernel()
```

`early_top_pgt` is only used for this brief window. Once `secondary_startup_64` loads `init_top_pgt` into `CR3`, the identity mapping disappears. From this point all code runs at its compiled-in kernel virtual addresses.

---

## The x86_64 Virtual Memory Layout

x86_64 splits the 64-bit address space at the canonical boundary. The 4-level (48-bit) layout is the baseline; 5-level (57-bit) is described in the next section.

### 4-Level Paging (48-bit virtual addresses)

The constants below are from `arch/x86/include/asm/page_64_types.h` and `arch/x86/include/asm/pgtable_64_types.h`. KASLR can shift `page_offset_base`, `vmalloc_base`, and `vmemmap_base` within their ranges (see [KASLR](#kaslr-kernel-address-space-layout-randomization) below).

```
Virtual address range                    Size   Region
─────────────────────────────────────────────────────────────────────────
0x0000000000000000 – 0x00007ffffffff000  ~128TB  User space
                   [ non-canonical hole ]
0xffff800000000000 – 0xffff87ffffffffff    8TB  Guard hole (hypervisor)
0xffff880000000000 – 0xffff887fffffffff  0.5TB  LDT remap (PTI)
0xffff888000000000 – 0xffffc87fffffffff   64TB  Direct physical map
                                                (page_offset_base,
                                                 __PAGE_OFFSET_BASE_L4 =
                                                 0xffff888000000000)
0xffffc88000000000 – 0xffffc8ffffffffff  0.5TB  Unused hole
0xffffc90000000000 – 0xffffe8ffffffffff   32TB  vmalloc / ioremap
                                                (vmalloc_base,
                                                 __VMALLOC_BASE_L4 =
                                                 0xffffc90000000000)
0xffffe90000000000 – 0xffffe9ffffffffff    1TB  Unused hole
0xffffea0000000000 – 0xffffeaffffffffff    1TB  vmemmap (struct page array)
0xffffec0000000000 – 0xfffffbffffffffff   16TB  KASAN shadow
0xfffffe0000000000 – 0xfffffe7fffffffff  0.5TB  cpu_entry_area
0xffffff0000000000 – 0xffffff7fffffffff  0.5TB  %esp fixup stacks
0xffffffef00000000 – 0xfffffffeffffffff   64GB  EFI runtime services
0xffffffff00000000 – 0xffffffff7fffffff    2GB  Unused hole
0xffffffff80000000 – 0xffffffff9fffffff  512MB  Kernel text+data
                                                (__START_KERNEL_map =
                                                 0xffffffff80000000)
0xffffffffa0000000 – 0xfffffffffeffffff 1520MB  Module mapping space
   FIXADDR_START   – 0xffffffffff5fffff ~0.5MB  Fixmap
0xffffffffff600000 – 0xffffffffff600fff    4KB  vsyscall ABI
─────────────────────────────────────────────────────────────────────────
```

Key constants from source:

| Symbol | Value | File |
|--------|-------|------|
| `__PAGE_OFFSET_BASE_L4` | `0xffff888000000000` | `page_64_types.h` |
| `__PAGE_OFFSET_BASE_L5` | `0xff11000000000000` | `page_64_types.h` |
| `__START_KERNEL_map` | `0xffffffff80000000` | `page_64_types.h` |
| `__VMALLOC_BASE_L4` | `0xffffc90000000000` | `pgtable_64_types.h` |
| `VMALLOC_SIZE_TB_L4` | `32` | `pgtable_64_types.h` |
| `__VMEMMAP_BASE_L4` | `0xffffea0000000000` | `pgtable_64_types.h` |
| `KERNEL_IMAGE_SIZE` | 1 GB (KASLR) / 512 MB (no KASLR) | `page_64_types.h` |

!!! note "KASLR shifts base addresses"
    `__PAGE_OFFSET` is the runtime variable `page_offset_base`, not `__PAGE_OFFSET_BASE_L4`. Similarly `VMALLOC_START` is `vmalloc_base` and `VMEMMAP_START` is `vmemmap_base`. The `_BASE_` constants are the no-KASLR defaults. When `CONFIG_RANDOMIZE_MEMORY=y`, the actual runtime addresses differ.

---

## `init_mem_mapping()` — Building the Direct Physical Map

The direct physical map is what lets the kernel address any byte of RAM with a simple pointer arithmetic offset from `page_offset_base`. Without it, the kernel could only access the memory covered by the static `level2_kernel_pgt` PMDs — roughly 1 GB around the kernel image.

`init_mem_mapping()` in `arch/x86/mm/init.c` is called from `setup_arch()` at line 1126 in `arch/x86/kernel/setup.c`, after `kernel_randomize_memory()` has already fixed the base addresses of the various regions.

```c
/* arch/x86/mm/init.c */
void __init init_mem_mapping(void)
{
    unsigned long end = max_pfn << PAGE_SHIFT;   /* highest physical address */

    pti_check_boottime_disable();
    probe_page_size_mask();   /* decide 4KB / 2MB / 1GB page sizes to use */
    setup_pcid();

    /* The ISA range [0, 1MB) is always mapped regardless of memory holes */
    init_memory_mapping(0, ISA_END_ADDRESS, PAGE_KERNEL);

    init_trampoline();        /* SMP AP trampoline needs its own mapping */

    if (memblock_bottom_up()) {
        /* Bottom-up: map above kernel first so page tables land above kernel */
        memory_map_bottom_up(kernel_end, end);
        memory_map_bottom_up(ISA_END_ADDRESS, kernel_end);
    } else {
        /* Top-down: map from the top of RAM downward */
        memory_map_top_down(ISA_END_ADDRESS, end);
    }

    load_cr3(swapper_pg_dir);
    __flush_tlb_all();
}
```

The choice between top-down and bottom-up depends on `memblock_bottom_up()`, which reflects how memblock is configured to allocate page table memory itself. KASLR forces bottom-up mode so page table allocations come from low physical addresses, avoiding collisions with the randomly-placed kernel image.

The inner workhorse is `init_range_memory_mapping()`, which calls `init_memory_mapping()` in chunks. `init_memory_mapping()` walks down the page table hierarchy — allocating PUD, PMD, and PTE tables as needed from memblock — and uses large pages (2 MB PMD entries or 1 GB PUD entries) wherever the physical range and alignment permit.

After `init_mem_mapping()` returns, `swapper_pg_dir` (which is `init_top_pgt`) has entries covering all physical RAM translated through `page_offset_base`. The kernel can now read and write any physical memory by computing `phys_addr + page_offset_base`.

---

## KASLR: Kernel Address Space Layout Randomization

KASLR on x86_64 has two independent components:

### 1. Physical KASLR — image placement

This happens during decompression, long before the main kernel runs. `arch/x86/boot/compressed/kaslr.c` scans the firmware memory map (e820 or EFI memmap), collects candidate 2 MB-aligned slots where the kernel image fits, and picks one using `kaslr_get_random_long("Physical")`. The chosen offset is stored in `boot_params` and consumed by `__startup_64()` as the `p2v_offset` argument.

Physical KASLR is controlled by `CONFIG_RANDOMIZE_BASE` and disabled at runtime by passing `nokaslr` on the kernel command line.

### 2. Memory layout KASLR — virtual region randomization

After the kernel image is running, `kernel_randomize_memory()` in `arch/x86/mm/kaslr.c` randomizes the virtual base addresses of the three major kernel memory regions:

```c
/* arch/x86/mm/kaslr.c */
static __initdata struct kaslr_memory_region {
    unsigned long *base;   /* pointer to the runtime base variable */
    unsigned long *end;    /* optional end pointer */
    unsigned long size_tb; /* region size in TB */
} kaslr_regions[] = {
    { .base = &page_offset_base, .end = &direct_map_physmem_end },  /* direct map */
    { .base = &vmalloc_base,     },                                  /* vmalloc */
    { .base = &vmemmap_base,     },                                  /* vmemmap */
};
```

The available entropy is the slack between these regions and their neighbors (up to `CPU_ENTRY_AREA_BASE`). Randomization is done at PGD/P4D/PUD granularity — each region's base is rounded to a PUD boundary — giving around 30,000 possible positions per region in a typical configuration.

`kernel_randomize_memory()` seeds a PRNG with `kaslr_get_random_long("Memory")`. The entropy function itself, in `arch/x86/lib/kaslr.c`, mixes hardware sources:

```c
/* arch/x86/lib/kaslr.c */
unsigned long kaslr_get_random_long(const char *purpose)
{
    unsigned long random = get_boot_seed();   /* kaslr_offset() of image */

    if (has_cpuflag(X86_FEATURE_RDRAND)) {
        rdrand_long(&raw);
        random ^= raw;           /* RDRAND if available */
    }

    if (has_cpuflag(X86_FEATURE_TSC)) {
        raw = rdtsc();
        random ^= raw;           /* TSC for timing jitter */
    } else {
        random ^= i8254();       /* legacy i8254 timer as fallback */
    }

    /* Circular multiply for bit diffusion */
    asm(_ASM_MUL "%3" ...);
    return random;
}
```

Memory layout KASLR is controlled by `CONFIG_RANDOMIZE_MEMORY` and is disabled when `CONFIG_KASAN` is enabled (checked in `kaslr_memory_enabled()`).

`kernel_randomize_memory()` is called from `setup_arch()` at line 1047, **before** `init_mem_mapping()` at line 1126. By the time page tables are being built, the final base addresses are already fixed.

!!! warning "KASAN disables memory KASLR"
    `kaslr_memory_enabled()` returns `false` when `CONFIG_KASAN=y` because KASAN requires a fixed shadow memory layout. Physical KASLR (`CONFIG_RANDOMIZE_BASE`) is independent and remains active with KASAN.

---

## 5-Level Paging (LA57)

x86_64 CPUs that support the LA57 feature bit expose 57-bit virtual addresses using a fifth level of page tables. The kernel option is `CONFIG_X86_5LEVEL`.

### Detection and Activation

5-level paging is detected and activated during decompression. The decompressor sets `CR4.LA57` if the CPU supports it and the kernel is built with `CONFIG_X86_5LEVEL`. By the time `startup_64` runs, either LA57 is already in effect or it is not.

`__startup_64()` checks at runtime:

```c
/* arch/x86/boot/startup/map_kernel.c */
static inline bool check_la57_support(void)
{
    if (!(native_read_cr4() & X86_CR4_LA57))
        return false;

    __pgtable_l5_enabled = 1;
    pgdir_shift           = 48;   /* was 39 in 4-level mode */
    ptrs_per_p4d          = 512;  /* P4D level is no longer folded */

    return true;
}
```

The global variable `__pgtable_l5_enabled` (declared in `arch/x86/include/asm/pgtable_64_types.h`) is then used by the `pgtable_l5_enabled()` inline throughout the rest of boot. After early boot, the normal kernel uses `cpu_feature_enabled(X86_FEATURE_LA57)` instead.

### Structural Difference

In 4-level mode the P4D level is **folded** — the PGD entry points directly to a PUD. In 5-level mode P4D is real:

```
4-level:  CR3 → PGD[9] → PUD[9] → PMD[9] → PTE[9] → page offset[12]  = 48 bits
5-level:  CR3 → PGD[9] → P4D[9] → PUD[9] → PMD[9] → PTE[9] → offset[12] = 57 bits
```

When 5-level mode is active, `__startup_64()` inserts `level4_kernel_pgt` (a real P4D page) between `early_top_pgt` (PGD) and `level3_kernel_pgt` (PUD):

```c
if (la57) {
    p4d = (p4dval_t *)rip_rel_ptr(level4_kernel_pgt);
    p4d[MAX_PTRS_PER_P4D - 1] += load_delta;   /* fix the P4D entry */

    pgd[pgd_index(__START_KERNEL_map)] = (pgdval_t)p4d | _PAGE_TABLE;
}
```

### Virtual Layout Changes

With 57-bit addresses, the layout shifts dramatically. From `Documentation/arch/x86/x86_64/mm.rst`:

| Region | 4-level base | 5-level base | Size change |
|--------|-------------|-------------|-------------|
| Direct physical map | `0xffff888000000000` (-119.5 TB) | `0xff11000000000000` (-59.75 PB) | 64 TB → 32 PB |
| vmalloc/ioremap | `0xffffc90000000000` (-55 TB) | `0xffa0000000000000` (-24 PB) | 32 TB → 12.5 PB |
| vmemmap | `0xffffea0000000000` (-22 TB) | `0xffd4000000000000` (-11 PB) | 1 TB → 0.5 PB |
| User space | ~128 TB | ~64 PB | 512x larger |

The `VMALLOC_SIZE_TB_L5` constant is 12,800 (TB), compared to `VMALLOC_SIZE_TB_L4` at 32 (TB).

---

## Finalizing Page Tables: `paging_init()` and Beyond

### Call Sequence in `setup_arch()`

The page table lifecycle in `setup_arch()` (`arch/x86/kernel/setup.c`) proceeds as:

```
setup_arch()
  │
  ├─ kernel_randomize_memory()     # fix virtual region base addresses
  │
  ├─ init_mem_mapping()            # build direct physical map in init_top_pgt
  │    ├─ memory_map_top_down()    # or
  │    └─ memory_map_bottom_up()
  │    └─ load_cr3(swapper_pg_dir) # reload CR3 with completed mapping
  │
  └─ x86_init.paging.pagetable_init()
       └─ native_pagetable_init()
            └─ paging_init()       # arch/x86/mm/init_64.c
```

`paging_init()` on x86_64 (`arch/x86/mm/init_64.c:834`) is deliberately minimal — it clears NUMA node state so zone initialization can set it correctly — because the heavy lifting was already done by `init_mem_mapping()`.

After `x86_init.paging.pagetable_init()` returns, `setup_arch()` continues with KASAN initialization (`kasan_init()`), after which the permanent page tables are in place.

### `mem_init()` — Handing Off to the Buddy Allocator

`mem_init()` (`arch/x86/mm/init_64.c:1368`) is called from `mm_core_init()` in `init/main.c`. At this point `memblock_free_all()` has already transferred all unreserved memory to the buddy allocator. `mem_init()` itself:

- Sets `after_bootmem = 1`, marking the point of no return for early-boot allocations
- Calls `register_page_bootmem_info()` to register memmap pages for memory hotplug tracking
- Marks `after_bootmem` to end early-boot allocations

### Permanent vs. Early Tables

| Table | Lifetime | Purpose |
|-------|----------|---------|
| `early_top_pgt` | Only until `secondary_startup_64` loads `init_top_pgt` | Has identity map + kernel |
| `early_dynamic_pgts` | Same — scratch space for `__startup_64` | Identity map PUD/PMD tables |
| `init_top_pgt` (`swapper_pg_dir`) | Permanent — `init_mm.pgd` | Full kernel PGD after `init_mem_mapping` |
| `level3_kernel_pgt` / `level2_kernel_pgt` | Permanent | Kernel text/data PUD and PMD tables |

---

## Debugging Boot Page Tables

### `CONFIG_PTDUMP_DEBUGFS`

When `CONFIG_PTDUMP_DEBUGFS=y`, the kernel registers debugfs files under `/sys/kernel/debug/page_tables/` (implemented in `arch/x86/mm/debug_pagetables.c`):

```
/sys/kernel/debug/page_tables/kernel         # init_mm page tables
/sys/kernel/debug/page_tables/current_kernel # current process kernel mapping
/sys/kernel/debug/page_tables/current_user   # current process user mapping (PTI)
/sys/kernel/debug/page_tables/efi            # EFI runtime page tables
```

Reading `kernel` calls `ptdump_walk_pgd_level_debugfs()` and walks `init_top_pgt`, printing every mapped range with the permission bits (RW, NX, Global, etc.) and the page size (4K, 2M, 1G) used.

### W+X Check

After `mark_rodata_ro()` finalizes the permission bits, the kernel checks that no page is simultaneously writable and executable. The result is logged to dmesg:

```
x86/mm: Checked W+X mappings: passed, no W+X pages found.
```

or on failure:

```
x86/mm: Found insecure W+X mapping at address <symbol>
x86/mm: Checked W+X mappings: FAILED, N W+X pages found.
```

This is implemented in `arch/x86/mm/dump_pagetables.c`.

### Other Useful Interfaces

```bash
# Physical memory regions from firmware (e820 map)
cat /proc/iomem

# Show page fault statistics
cat /proc/vmstat | grep pgfault

# Dump kernel log for early mapping messages
dmesg | grep -E "x86/mm|PAGE|mapping"

# Check if 5-level paging is active
grep . /sys/devices/system/cpu/cpu0/cpufreq/../topology/physical_package_id
# or inspect /proc/cpuinfo for 'la57' in flags
grep la57 /proc/cpuinfo
```

### Boot Parameters

| Parameter | Effect |
|-----------|--------|
| `nokaslr` | Disables both physical and memory KASLR |
| `no5lvl` | Disables 5-level paging even if CPU and kernel support it |
| `memmap=exactmap` | Override e820 memory map (useful for testing) |

---

## Summary

The x86_64 boot paging sequence moves through distinct phases, each unlocking more of the system:

```
Bootloader / UEFI
  └─ Identity-mapped page tables loaded, CPU in 64-bit long mode
        │
        ▼
startup_64  (arch/x86/kernel/head_64.S)
  └─ __startup_64() fixes early_top_pgt physical addresses,
     builds identity map in early_dynamic_pgts
        │
        ▼
CR3 = early_top_pgt
  └─ Identity map + high kernel map both active
        │
        ▼
secondary_startup_64 → CR3 = init_top_pgt
  └─ Identity map gone; kernel runs at virtual addresses only
        │
        ▼
setup_arch()
  ├─ kernel_randomize_memory()   ← KASLR: randomize region bases
  └─ init_mem_mapping()          ← direct physical map built
        │
        ▼
x86_init.paging.pagetable_init() → paging_init()
  └─ NUMA zone state cleared; buddy allocator ready to take over
        │
        ▼
mem_init() → memblock_free_all()
  └─ All free memory handed to the buddy allocator
     Boot page table setup complete
```

## Further reading

### Kernel source

- [arch/x86/kernel/head_64.S](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/head_64.S) — `startup_64` entry point; static `early_top_pgt`, `init_top_pgt`, and `level3_kernel_pgt` declarations
- [arch/x86/boot/startup/map_kernel.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/boot/startup/map_kernel.c) — `__startup_64()`: first C code; fixes physical addresses and builds identity map
- [arch/x86/mm/init.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/init.c) — `init_mem_mapping()`, `memory_map_top_down()`, `memory_map_bottom_up()`
- [arch/x86/mm/kaslr.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/kaslr.c) — `kernel_randomize_memory()`: randomizes direct map, vmalloc, and vmemmap base addresses

### Kernel documentation

- [`Documentation/arch/x86/boot.rst`](https://docs.kernel.org/arch/x86/boot.html) — x86 boot protocol: what state the bootloader must establish before jumping to the kernel
- [`Documentation/arch/x86/x86_64/mm.rst`](https://docs.kernel.org/arch/x86/x86_64/mm.html) — authoritative virtual memory map for 4-level and 5-level paging with exact address ranges

### Related pages

- [page-tables.md](page-tables.md) — the generic Linux page-table abstraction (PGD/P4D/PUD/PMD/PTE) that the boot tables slot into
- [memblock.md](memblock.md) — the early allocator that provides memory for page table pages before the buddy allocator is ready

### LWN articles

- [LWN: Five-level page tables](https://lwn.net/Articles/717293/) — introduction to LA57 and the 57-bit address space extension
- [LWN: KASLR for the kernel's virtual address space](https://lwn.net/Articles/569635/) — memory-layout KASLR: motivation, entropy sources, and trade-offs
