# Kernel Memory Reservation Mechanisms

> Not all physical RAM is yours to use — the kernel, firmware, and hardware carve out regions long before user space ever runs

## Why reservations exist

Physical memory is not a flat, uniformly available resource. By the time the kernel reaches `start_kernel()`, several parties have already laid claim to portions of the physical address space:

- **Firmware tables** — the BIOS, ACPI tables (RSDT, XSDT, DSDT), and SMBIOS data reside in RAM and must not be overwritten
- **Kernel text and data** — `.text`, `.rodata`, `.data`, `.bss`, and related sections occupy fixed physical addresses set by the bootloader
- **EFI runtime services** — on UEFI systems, boot services memory and the EFI memory map itself need protection
- **EBDA and legacy BIOS region** — the Extended BIOS Data Area and the top of the first megabyte are historically corrupt-prone
- **Device memory and memory-mapped I/O** — firmware may describe ranges as `E820_TYPE_RESERVED` rather than RAM
- **crashkernel regions** — a dedicated region held in reserve for the kdump capture kernel
- **CMA pools** — contiguous memory for DMA that doubles as ordinary movable memory until needed
- **Hardware quirks** — some chipsets corrupt specific physical ranges (Sandy Bridge iGPU is a canonical x86 example)

The buddy allocator, which manages all general-purpose page allocation, can only hand out pages it knows are free. Anything outside that set must be reserved before `memblock_free_all()` hands memory over.

!!! note "Key Source Files"
    | File | Role |
    |---|---|
    | `mm/memblock.c` | Core memblock allocator and reservation engine |
    | `include/linux/memblock.h` | Public API, flag definitions, inline wrappers |
    | `arch/x86/kernel/setup.c` | `setup_arch()` — orchestrates all x86 boot reservations |
    | `arch/x86/kernel/ebda.c` | `reserve_bios_regions()` — EBDA and legacy BIOS area |
    | `arch/x86/realmode/init.c` | `reserve_real_mode()` — first 1 MB and trampoline |
    | `arch/x86/platform/efi/efi.c` | `efi_memblock_x86_reserve_range()` — EFI memory map |
    | `arch/x86/kernel/e820.c` | `e820__memblock_setup()` — translates e820 map to memblock |
    | `kernel/crash_reserve.c` | `reserve_crashkernel_generic()` — kdump region |
    | `mm/memory_hotplug.c` | `movable_node` parameter handling |

---

## memblock reservations

memblock is the kernel's boot-time memory manager. It maintains two flat arrays of `struct memblock_region`: one for all available physical memory (`memblock.memory`) and one for reserved regions (`memblock.reserved`). When `memblock_free_all()` is called late in `mm_init()`, only pages that appear in `memblock.memory` but *not* in `memblock.reserved` are released to the buddy allocator. Everything else stays off-limits.

### memblock_reserve()

The primary reservation function is a thin inline wrapper in `include/linux/memblock.h`:

```c
static __always_inline int memblock_reserve(phys_addr_t base, phys_addr_t size)
{
    return __memblock_reserve(base, size, NUMA_NO_NODE, 0);
}
```

`__memblock_reserve()` calls `memblock_add_range()` against `memblock.reserved`, merging overlapping and adjacent regions as it goes. The function is safe to call from the earliest stages of `setup_arch()`, before paging is fully initialized.

A variant, `memblock_reserve_kern()`, sets the additional `MEMBLOCK_RSRV_KERN` flag to indicate the region is consumed by the kernel itself (versus firmware, device memory, etc.):

```c
static __always_inline int memblock_reserve_kern(phys_addr_t base, phys_addr_t size)
{
    return __memblock_reserve(base, size, NUMA_NO_NODE, MEMBLOCK_RSRV_KERN);
}
```

All internal memblock allocations automatically set `MEMBLOCK_RSRV_KERN`.

### memblock_phys_alloc()

Before the buddy allocator is available, the kernel must allocate memory for its own data structures (page tables, `struct page` arrays, zone structures). `memblock_phys_alloc()` satisfies these requests and returns a physical address:

```c
static __always_inline phys_addr_t memblock_phys_alloc(phys_addr_t size,
                                                        phys_addr_t align)
{
    return memblock_phys_alloc_range(size, align, 0, MEMBLOCK_ALLOC_ACCESSIBLE);
}
```

The call both allocates and implicitly marks the region reserved via `__memblock_reserve()` with `MEMBLOCK_RSRV_KERN`. A mapped virtual-address variant, `memblock_alloc()`, is also widely used for kernel data structure initialization.

### memblock_mark_nomap()

A reserved region still gets struct pages allocated for it and is covered by the kernel direct map by default. `memblock_mark_nomap()` goes further by setting the `MEMBLOCK_NOMAP` flag, which prevents the region from being included in the kernel's direct physical mapping altogether:

```c
int __init_memblock memblock_mark_nomap(phys_addr_t base, phys_addr_t size)
{
    return memblock_setclr_flag(&memblock.memory, base, size, 1, MEMBLOCK_NOMAP);
}
```

Regions marked `MEMBLOCK_NOMAP` are still covered by the memory map (struct pages exist and are `PageReserved()`), but the kernel has no linear-map virtual address for them. This is used for device memory ranges or persistent memory that requires special mapping treatment. As the comment in `include/linux/memblock.h` states: *"don't add to kernel direct mapping and treat as reserved in the memory map."*

### memblock flags summary

| Flag | Meaning |
|---|---|
| `MEMBLOCK_NONE` | Plain reserved region |
| `MEMBLOCK_HOTPLUG` | Firmware-described hot(un)pluggable memory |
| `MEMBLOCK_MIRROR` | Mirrored (redundant) memory region |
| `MEMBLOCK_NOMAP` | Exclude from kernel direct map |
| `MEMBLOCK_DRIVER_MANAGED` | Always added via driver, not firmware RAM |
| `MEMBLOCK_RSRV_NOINIT` | Reserved; struct pages not fully initialized |
| `MEMBLOCK_RSRV_KERN` | Reserved for kernel use |

---

## What gets reserved at boot on x86

`setup_arch()` in `arch/x86/kernel/setup.c` orchestrates all physical memory reservations for x86. The sequence matters — later stages depend on earlier reservations already being in place.

### Phase 1: early_reserve_memory()

Called before `e820__memory_setup()` adds any RAM to `memblock.memory`, so nothing gets allocated on top of these regions:

```c
static void __init early_reserve_memory(void)
{
    /*
     * Reserve the memory occupied by the kernel between _text and
     * __end_of_kernel_reserve symbols.
     */
    memblock_reserve_kern(__pa_symbol(_text),
                  (unsigned long)__end_of_kernel_reserve - (unsigned long)_text);

    /* Reserve the first 64K; BIOSes are known to corrupt low memory */
    memblock_reserve(0, SZ_64K);

    early_reserve_initrd();

    memblock_x86_reserve_range_setup_data();

    reserve_bios_regions();
    trim_snb_memory();
}
```

**Kernel image:** The range from `_text` to `__end_of_kernel_reserve` (a linker-defined symbol in `arch/x86/kernel/vmlinux.lds.S`) covers `.text`, `.rodata`, `.data`, `.bss`, and related sections. Any sections placed *after* `__end_of_kernel_reserve` (such as `.brk`) must be reserved separately.

**Low memory:** The first 64 KB (raised to 1 MB later by `reserve_real_mode()`) is reserved because legacy BIOSes corrupt low RAM and the first page must be reserved to prevent L1TF side-channel leaks.

**initrd:** `early_reserve_initrd()` immediately calls `memblock_reserve_kern()` on the ramdisk image address from `boot_params`, ensuring memblock cannot allocate over it before full setup completes.

**BIOS/EBDA:** `reserve_bios_regions()` in `arch/x86/kernel/ebda.c` reads the EBDA pointer and reserves everything from the EBDA start through the top of the first megabyte:

```c
memblock_reserve(bios_start, 0x100000 - bios_start);
```

### Phase 2: e820 and EFI memory map processing

`e820__memory_setup()` reads the firmware's physical memory map (BIOS e820 or EFI memory map) and constructs the authoritative picture of what is RAM, what is reserved, and what is absent. Regions typed `E820_TYPE_RAM` are subsequently added to `memblock.memory` by `e820__memblock_setup()`.

On EFI systems, `efi_memblock_x86_reserve_range()` reserves the EFI memory map table itself:

```c
memblock_reserve(pmap, efi.memmap.nr_map * efi.memmap.desc_size);
```

### Phase 3: post-e820 reservations

After `e820__memblock_setup()`, the full memory topology is known and further reservations are made:

- **EFI boot services:** `efi_reserve_boot_services()` pins EFI boot service memory so runtime services remain accessible until `efi_free_boot_services()` is called after the boot CPU is up.
- **Real mode trampoline:** `x86_platform.realmode_reserve()` calls `reserve_real_mode()`, which allocates a sub-1 MB trampoline region (for AP startup) and then unconditionally reserves the entire first megabyte with `memblock_reserve(0, SZ_1M)`.
- **initrd (final):** `reserve_initrd()` later verifies the initrd mapping and frees the physical pages once they have been copied.
- **ACPI tables:** `acpi_boot_table_init()` ultimately calls `memblock_reserve()` on ACPI table ranges found in the firmware map.
- **CMA:** `dma_contiguous_reserve()` carves out the CMA region (see [CMA reservations](#cma-reservations) below).
- **crashkernel:** `arch_reserve_crashkernel()` reserves the kdump region (see [crashkernel reservation](#crashkernel-reservation) below).

### Reading the reservation log

The kernel logs all memblock reservations at early boot. A typical x86 dmesg contains:

```
[    0.000000] BIOS-provided physical RAM map:
[    0.000000] BIOS-e820: [mem 0x0000000000000000-0x000000000009fbff] usable
[    0.000000] BIOS-e820: [mem 0x000000000009fc00-0x000000000009ffff] reserved
[    0.000000] BIOS-e820: [mem 0x00000000000f0000-0x00000000000fffff] reserved
[    0.000000] BIOS-e820: [mem 0x0000000000100000-0x00000000bffdffff] usable
[    0.000000] BIOS-e820: [mem 0x00000000bffe0000-0x00000000bfffffff] reserved
...
[    0.000000] Early memory node ranges
[    0.000000]   node   0: [mem 0x0000000000001000-0x000000000009efff]
[    0.000000]   node   0: [mem 0x0000000000100000-0x00000000bffdffff]
[    0.000000] Initmem setup node 0 [mem 0x0000000000000000-0x00000000bfffffff]
[    0.000000] crashkernel reserved: 0x0000000009000000 - 0x0000000049000000 (1024 MB)
```

---

## The reserved memory map

### /proc/iomem

`/proc/iomem` is the canonical view of the kernel resource tree — a hierarchical record of every claimed physical address range. Every reservation that calls `insert_resource()` or `request_resource()` appears here:

```
# cat /proc/iomem
00000000-00000fff : Reserved
00001000-0009fbff : System RAM
0009fc00-0009ffff : Reserved
000a0000-000bffff : PCI Bus 0000:00
000c0000-000c99ff : Video ROM
000f0000-000fffff : Reserved
  000f0000-000fffff : System ROM
00100000-bffdffff : System RAM
  01000000-01c0ae8b : Kernel code
  01c0ae8c-0228317f : Kernel rodata
  02284000-02430abf : Kernel data
  02623000-02ffffff : Kernel bss
09000000-48ffffff : Crash kernel
bffe0000-bfffffff : Reserved
fd000000-fdffffff : PCI Bus 0000:00
...
```

Fields to note:

- `System RAM` — memory available to the kernel
- `Kernel code` / `Kernel rodata` / `Kernel data` / `Kernel bss` — exact regions occupied by the kernel image
- `Crash kernel` — the crashkernel-reserved region
- `Reserved` — firmware-reserved areas the kernel does not use
- `PCI Bus` — memory-mapped I/O ranges claimed by PCI

### /sys/kernel/debug/memblock/reserved

When `CONFIG_DEBUG_FS` is enabled, `memblock_init_debugfs()` in `mm/memblock.c` registers debugfs entries:

```c
static int __init memblock_init_debugfs(void)
{
    struct dentry *root = debugfs_create_dir("memblock", NULL);

    debugfs_create_file("memory", 0444, root,
                &memblock.memory, &memblock_debug_fops);
    debugfs_create_file("reserved", 0444, root,
                &memblock.reserved, &memblock_debug_fops);
    ...
}
```

```
# cat /sys/kernel/debug/memblock/reserved
   0: 0x0000000000000000..0x00000000000fffff
   1: 0x0000000001000000..0x0000000002ffffff
   2: 0x0000000009000000..0x0000000048ffffff
   3: 0x00000000bffe0000..0x00000000bfffffff
```

!!! note
    This file reflects the memblock state at the time of reading. After `memblock_free_all()` is called (during `mm_init()`), memblock's internal arrays may be freed if `CONFIG_ARCH_KEEP_MEMBLOCK` is not set. On such kernels, the debugfs file may be absent or empty post-boot. On x86, `CONFIG_ARCH_KEEP_MEMBLOCK` is typically enabled, preserving the data.

---

## crashkernel reservation

The `crashkernel=` kernel command line parameter reserves a contiguous region of physical memory at boot that is handed over to a secondary "capture kernel" when the running kernel panics. This is the foundation of kdump.

### How it works

`arch_reserve_crashkernel()` in `arch/x86/kernel/setup.c` parses the command line and delegates to `reserve_crashkernel_generic()` in `kernel/crash_reserve.c`:

```c
static void __init arch_reserve_crashkernel(void)
{
    unsigned long long crash_base, crash_size, low_size = 0, cma_size = 0;
    bool high = false;

    ret = parse_crashkernel(boot_command_line, memblock_phys_mem_size(),
                &crash_size, &crash_base, &low_size, &cma_size, &high);
    ...
    reserve_crashkernel_generic(crash_size, crash_base, low_size, high);
    reserve_crashkernel_cma(cma_size);
}
```

`reserve_crashkernel_generic()` uses `memblock_phys_alloc_range()` to find and reserve a suitable region:

```c
crash_base = memblock_phys_alloc_range(crash_size, CRASH_ALIGN,
                                       search_base, search_end);
```

Once allocated, the region is recorded in `crashk_res` and registered in the iomem resource tree:

```c
crashk_res.start = crash_base;
crashk_res.end   = crash_base + crash_size - 1;
insert_resource(&iomem_resource, &crashk_res);
```

The reserved memory is removed from the running kernel's linear map so it cannot be accidentally written. `kexec_load()` places the capture kernel image and initrd inside this region; on panic, `crash_kexec()` jumps into it.

### Syntax options

| Syntax | Meaning |
|---|---|
| `crashkernel=256M` | Reserve 256 MB, kernel chooses address |
| `crashkernel=256M@512M` | Reserve 256 MB at physical offset 512 MB |
| `crashkernel=256M,high` | Prefer memory above 4 GB |
| `crashkernel=256M,high crashkernel=64M,low` | 256 MB high + 64 MB DMA-accessible region |
| `crashkernel=512M-2G:64M,2G-:128M` | Size range: 64 MB if RAM is 512 M–2 G, 128 MB if > 2 G |

!!! tip
    On x86-64, if the initial low-memory search fails, the kernel automatically retries in high memory and allocates a small `crashk_low_res` region below 4 GB to satisfy DMA-capable hardware in the capture kernel.

### Timing

Note in `setup_arch()` that `arch_reserve_crashkernel()` is called *after* `initmem_init()` (which parses ACPI SRAT) so that the reservation avoids hotpluggable memory regions:

```c
initmem_init();
dma_contiguous_reserve(max_pfn_mapped << PAGE_SHIFT);

/*
 * Reserve memory for crash kernel after SRAT is parsed so that it
 * won't consume hotpluggable memory.
 */
arch_reserve_crashkernel();
```

---

## CMA reservations

CMA (Contiguous Memory Allocator) carves out a physically contiguous region at boot, but unlike a hard reservation it remains productive: the kernel places movable pages (page cache, anonymous memory) in the CMA region during normal operation. When a device driver requests a large contiguous DMA buffer, the kernel migrates those movable pages out and hands the now-empty contiguous range to the driver.

On x86, `setup_arch()` calls `dma_contiguous_reserve(max_pfn_mapped << PAGE_SHIFT)` to size and reserve the default CMA region.

See [CMA](cma.md) for full coverage of the CMA lifecycle, `dma_contiguous_reserve()`, `cma_declare_contiguous()`, and `alloc_contig_range()`.

---

## Runtime reservations

Once `memblock_free_all()` hands unreserved pages to the buddy allocator, the reservation landscape changes fundamentally. There is **no runtime equivalent of `memblock_reserve()`** for arbitrary physical ranges — the memblock arrays may have been freed, and the buddy allocator has no concept of marking an arbitrary range as off-limits after initialization.

To hold memory at runtime, the kernel must allocate it and keep it allocated:

```c
/* Allocate and pin pages — never free them */
struct page *page = alloc_pages(GFP_KERNEL, order);
```

Calling `alloc_pages()` removes the pages from the free pool. As long as the kernel holds the reference and never calls `__free_pages()`, those pages remain unavailable for other use.

!!! warning
    There is no way to "reserve" a specific physical address at runtime. If a driver or subsystem needs a particular physical range, it must be reserved at boot time via `memblock_reserve()` from an `early_param` handler or architecture setup code, or mapped through a mechanism like persistent memory (pmem) that uses `MEMBLOCK_NOMAP`.

### Memory hotplug

The one mechanism that changes the physical memory available to the buddy allocator at runtime is memory hotplug: adding new DIMM slots or removing existing ones on capable hardware. This extends (or shrinks) `memblock.memory` and the buddy allocator's managed range. See the memory hotplug documentation for details on `add_memory()`, `remove_memory()`, and the `MEMBLOCK_HOTPLUG` flag.

---

## ZONE_MOVABLE and movable_node

Beyond hard reservations, the kernel supports a softer form of memory isolation: ensuring that a zone or an entire NUMA node's memory is placed in `ZONE_MOVABLE`. Pages in `ZONE_MOVABLE` can only be satisfied by movable allocations, which guarantees they can be migrated out, making the zone suitable for memory offlining and hotplug.

The `movable_node` kernel command line parameter enables this behavior. It is handled by `cmdline_parse_movable_node()` in `mm/memory_hotplug.c`:

```c
static int __init cmdline_parse_movable_node(char *p)
{
    movable_node_enabled = true;
    return 0;
}
early_param("movable_node", cmdline_parse_movable_node);
```

When `movable_node_is_enabled()` returns true, `mm_init.c` iterates over memblock regions flagged `MEMBLOCK_HOTPLUG` and places their PFN range into `ZONE_MOVABLE` rather than `ZONE_NORMAL`. This prevents the kernel from placing non-migratable allocations (kernel code, pinned memory) on that node, enabling the entire node to be offlined and removed.

```
zone_movable_pfn[nid] = min(usable_startpfn, zone_movable_pfn[nid]);
```

`ZONE_MOVABLE` is also used without `movable_node` through the `kernelcore=` and `movablecore=` parameters, which split a portion of each node's memory into the movable zone.

!!! note "Memory tiering"
    `movable_node` is also used in CXL memory tiering configurations to mark slow-memory nodes as fully movable, enabling the kernel's tiered memory promotion/demotion machinery to move pages between fast (local DRAM) and slow (CXL-attached) tiers. See the CXL memory tiering documentation for details.

---

## Summary: reservation mechanisms at a glance

```
Boot time                          Runtime
─────────────────────────────────────────────────────────────
memblock_reserve()                 alloc_pages() + hold
  └─ reserves arbitrary range      └─ allocate and never free
  └─ buddy allocator never sees it

memblock_reserve_kern()            memory hotplug
  └─ like above + RSRV_KERN flag   └─ adds/removes whole regions

memblock_phys_alloc()
  └─ allocates AND reserves

memblock_mark_nomap()
  └─ reserves + excludes from
     kernel direct map

ZONE_MOVABLE / movable_node
  └─ soft reservation: isolates
     zone for movable allocs only
─────────────────────────────────────────────────────────────
Visible in:
  /proc/iomem                      (resource tree, always)
  /sys/kernel/debug/memblock/reserved  (if CONFIG_DEBUG_FS)
  dmesg | grep -i reserved
```

## Further reading

- [Kernel docs: Memory hotplug](https://docs.kernel.org/admin-guide/mm/memory-hotplug.html) — covers `MEMBLOCK_HOTPLUG` regions, `movable_node`, and how reservations interact with runtime memory add/remove
- [`Documentation/admin-guide/mm/memory-hotplug.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/admin-guide/mm/memory-hotplug.rst) — `kernelcore=` and `movablecore=` parameters that shape the ZONE_MOVABLE split at boot
- [`mm/memblock.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memblock.c) — core memblock implementation: `memblock_reserve()`, `memblock_mark_nomap()`, `memblock_free_all()`
- [`arch/x86/kernel/setup.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/setup.c) — `setup_arch()` orchestrating all x86 boot reservations in sequence
- [`kernel/crash_reserve.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/crash_reserve.c) — `reserve_crashkernel_generic()` implementation
- [LWN: memblock and early memory management](https://lwn.net/Articles/438225/) — how memblock replaced the earlier bootmem allocator and why flat arrays work for boot-time allocation (2011)
- [LWN: kdump and crashkernel](https://lwn.net/Articles/249508/) — the crashkernel reservation and kexec-based capture kernel design (2007)
- [memblock.md](memblock.md) — detailed coverage of the memblock allocator lifecycle, region merging, and transition to the buddy allocator
- [cma.md](cma.md) — how `dma_contiguous_reserve()` carves out CMA regions within the memblock reservation phase
- [memory-hotplug.md](memory-hotplug.md) — runtime counterpart to boot reservations: adding and removing physical memory after `memblock_free_all()`
