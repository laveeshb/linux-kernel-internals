# memblock: The Boot-Time Memory Allocator

> Before the buddy system can manage memory, something has to manage memory first

## What is memblock?

memblock is the kernel's early boot-time memory allocator. It tracks which physical memory regions exist and which are already reserved, allowing the kernel to allocate memory during the earliest stages of boot -- long before the buddy allocator (page allocator) is initialized.

```c
/* Add a region of physical memory */
int memblock_add(phys_addr_t base, phys_addr_t size);

/* Mark a region as reserved (in use) */
int memblock_reserve(phys_addr_t base, phys_addr_t size);

/* Allocate memory during early boot */
void *memblock_alloc(phys_addr_t size, phys_addr_t align);
```

## The Chicken-and-Egg Problem

The buddy allocator is the kernel's primary physical memory manager at runtime. But setting it up requires memory:

- **Zone structures** (`struct zone`) need to be allocated for each memory zone
- **Page frame metadata** (`struct page`) needs one entry per physical page -- on a 16GB system that's millions of entries
- **Per-CPU data structures** for allocation caches
- **Free lists** for the buddy system itself

But you cannot allocate memory without a memory allocator. Something simpler must come first.

memblock solves this bootstrap problem with a deliberately minimal design: two flat arrays that track memory regions. No page tables, no locking, no per-CPU caches -- just "here's what exists" and "here's what's taken."

```
Boot sequence:

  1. Firmware / bootloader loads kernel into RAM

  2. Architecture setup discovers physical memory layout
     (via device tree, ACPI, or e820 on x86)

  3. memblock tracks available and reserved regions
     +----------------------------------------------+
     | memblock.memory:   [0 - 4GB], [8GB - 16GB]  |  <- what exists
     | memblock.reserved: [0 - 16MB], [64MB - 80MB] |  <- what's taken
     +----------------------------------------------+

  4. Kernel uses memblock_alloc() to get memory for
     page tables, struct page array, zone structures...

  5. Buddy allocator initialized using memblock info

  6. memblock_free_all() hands remaining free memory
     to the buddy system

  7. memblock is done (memory can be freed if not needed)
```

## How memblock Works

### Two Arrays: memory and reserved

The core data structure is simple. memblock maintains two collections of regions:

```c
struct memblock {
    bool bottom_up;                          /* allocation direction */
    phys_addr_t current_limit;               /* allocation limit */
    struct memblock_type memory;             /* physical memory regions */
    struct memblock_type reserved;           /* reserved (in-use) regions */
};
```

Each `memblock_type` holds a dynamically-growing array of regions:

```c
struct memblock_type {
    unsigned long cnt;                       /* number of regions */
    unsigned long max;                       /* max regions (grows if needed) */
    phys_addr_t total_size;                  /* total size of all regions */
    struct memblock_region *regions;         /* array of regions */
    char *name;                              /* "memory" or "reserved" */
};

struct memblock_region {
    phys_addr_t base;                        /* start address */
    phys_addr_t size;                        /* region size */
    enum memblock_flags flags;               /* HOTPLUG, MIRROR, NOMAP */
#ifdef CONFIG_NUMA
    int nid;                                 /* NUMA node id */
#endif
};
```

The `memory` array describes what physical memory exists (as reported by firmware). The `reserved` array describes what's already been claimed -- the kernel image itself, device tree blob, initrd, early allocations, etc.

**Free memory** is implicitly defined as: regions in `memory` that are not covered by `reserved`.

```
Physical address space:
0                                                              16GB
|--------------------------------------------------------------|

memblock.memory (what exists):
|==========|                  |================================|
0        4GB                 8GB                             16GB

memblock.reserved (what's taken):
|==|    |=|                  |=|
kernel  DTB                  initrd

Free = memory minus reserved
```

### Region Merging

When adjacent or overlapping regions are added, memblock automatically merges them. This keeps the arrays compact:

```
memblock_add(0, 1GB)    -> memory: [0, 1GB]
memblock_add(1GB, 1GB)  -> memory: [0, 2GB]     (merged)
memblock_add(3GB, 1GB)  -> memory: [0, 2GB], [3GB, 4GB]  (gap, no merge)
```

### Static Bootstrap

The initial region arrays are statically allocated:

```c
static struct memblock_region memblock_memory_init_regions[INIT_MEMBLOCK_REGIONS];
static struct memblock_region memblock_reserved_init_regions[INIT_MEMBLOCK_RESERVED_REGIONS];
```

`INIT_MEMBLOCK_REGIONS` defaults to 128. If more regions are needed, memblock doubles the array using `memblock_double_array()`, which allocates new space from memblock itself -- a neat self-referential trick that works because the old array remains valid until the copy is complete.

## Key APIs

### Adding and Removing Memory

```c
/* Tell memblock about physical memory regions (called by arch code) */
int memblock_add(phys_addr_t base, phys_addr_t size);

/* Remove a region (e.g., firmware reserved areas) */
int memblock_remove(phys_addr_t base, phys_addr_t size);

/* Mark a region as reserved */
int memblock_reserve(phys_addr_t base, phys_addr_t size);

/* Free a previously reserved region */
int memblock_phys_free(phys_addr_t base, phys_addr_t size);

/* Mark memory as not directly usable (won't be mapped) */
int memblock_mark_nomap(phys_addr_t base, phys_addr_t size);
```

### Allocating Memory

```c
/* Allocate aligned memory (most common) */
void *memblock_alloc(phys_addr_t size, phys_addr_t align);

/* Allocate from a specific address range */
void *memblock_alloc_range_nid(phys_addr_t size, phys_addr_t align,
                               phys_addr_t start, phys_addr_t end,
                               int nid, bool exact_nid);

/* Allocate raw physical address (no virtual mapping) */
phys_addr_t memblock_phys_alloc(phys_addr_t size, phys_addr_t align);
```

`memblock_alloc()` does two things: finds a free physical region and maps it into the kernel's virtual address space (via `memblock_alloc_internal()` which calls `memblock_alloc_range_nid()` then `memblock_reserve()` on the result). The returned pointer is a kernel virtual address ready to use.

### Querying Memory

```c
/* Is this address in a reserved region? */
bool memblock_is_reserved(phys_addr_t addr);

/* Is this address in a memory region? */
bool memblock_is_memory(phys_addr_t addr);

/* Total amount of usable RAM */
phys_addr_t memblock_phys_mem_size(void);

/* Iterate over free (unreserved) memory regions */
for_each_free_mem_range(i, nid, flags, &start, &end, NULL)
```

## Memory Discovery: Device Tree and ACPI

memblock does not discover memory on its own. Architecture-specific code populates it using firmware information.

### Device Tree (ARM, RISC-V, PowerPC, etc.)

On device-tree platforms, the `/memory` nodes describe physical RAM:

```dts
/ {
    memory@80000000 {
        device_type = "memory";
        reg = <0x00 0x80000000 0x00 0x80000000>;  /* 2GB at 0x80000000 */
    };
};
```

The kernel's early DT scanning code (`early_init_dt_scan_memory()` in [`drivers/of/fdt.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/of/fdt.c)) parses these nodes and calls `memblock_add()` for each region. Reserved memory nodes (`/reserved-memory`) result in `memblock_reserve()` calls.

### ACPI (x86, ARM servers)

On ACPI systems, the firmware provides memory maps through different mechanisms:

- **x86**: The BIOS/UEFI provides an **e820 memory map** -- a table of address ranges with types (usable, reserved, ACPI reclaimable, etc.). The function `e820__memblock_setup()` in [`arch/x86/kernel/e820.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/e820.c) translates e820 entries into `memblock_add()` and `memblock_reserve()` calls.

- **ARM64 with ACPI**: Uses EFI memory map entries, processed by `efi_init()`.

### The Pattern

Regardless of platform, the flow is the same:

```
Firmware provides memory layout
        |
        v
Architecture code parses it
        |
        v
memblock_add() for usable regions
memblock_reserve() for reserved regions
        |
        v
memblock has complete picture of physical memory
```

## The Handoff to the Buddy Allocator

Once the kernel has used memblock to set up all the data structures the buddy allocator needs, memblock's job is nearly done. The handoff happens through `memblock_free_all()`:

```c
void __init memblock_free_all(void)
{
    unsigned long pages;

    pages = free_low_memory_core_early();  /* release memblock pages to buddy */
    totalram_pages_add(pages);
}
```

This function walks all memblock memory regions, and for each page that is **not** reserved, calls `__free_pages_core()` to hand it to the buddy allocator. After this point, the buddy system owns all free physical memory and memblock is no longer needed for allocation.

The memblock data structures themselves are marked `__initdata`, meaning they live in the kernel's init section. After boot completes (`free_initmem()`), this memory is reclaimed -- unless `CONFIG_ARCH_KEEP_MEMBLOCK` is enabled (which preserves memblock data for later queries, useful for kexec and memory hotplug).

```
memblock_free_all() walkthrough:

  For each page in memblock.memory:
      if not in memblock.reserved:
          __free_pages_core(page)   ->  buddy allocator now owns it
          totalram_pages++

  Result: buddy free lists populated, system ready for normal allocation
```

## History and Evolution

### bootmem: The Original Approach (Linux 2.4 through early 3.x)

Before memblock, the kernel used a **bitmap-based** boot allocator called `bootmem`. Each bit represented one physical page: 1 = allocated, 0 = free.

The problems with bootmem:

- **Bitmap overhead**: A 64GB system needs a 2MB bitmap just for accounting
- **Linear search**: Finding free memory required scanning the bitmap -- O(n) in the number of pages
- **No NUMA awareness**: The original bootmem had no concept of memory nodes
- **Fragile**: The bitmap itself needed to live somewhere in memory, creating another bootstrap problem

### The Rise of memblock (Logical Memory Blocks)

memblock's predecessor was called **lmb** (Logical Memory Blocks), used on PowerPC. It tracked memory as a list of regions rather than a per-page bitmap -- far more efficient when memory is mostly contiguous.

**Commit**: [95f72d1ed41a](https://git.kernel.org/linus/95f72d1ed41a) ("lmb: rename to memblock") | [LWN coverage](https://lwn.net/Articles/382559/)
**Kernel**: v2.6.35 (2010)
**Author**: Yinghai Lu

Yinghai Lu renamed lmb to memblock and began extending it for use on x86. The rename was the first step in making it architecture-independent.

### memblock Replaces bootmem

Over several kernel releases, architectures migrated from bootmem to memblock:

- **ARM**: One of the early adopters alongside PowerPC
- **x86**: Migrated in the v2.6.35 -- v3.x timeframe

**Commit**: [9a8dd708d547](https://git.kernel.org/linus/9a8dd708d547) ("memblock: remove bootmem dependency on memblock")
**Kernel**: v3.12 (2013)

The final removal of bootmem happened when all architectures had been converted:

**Commit**: [355c45affca7](https://git.kernel.org/linus/355c45affca7114ab510e296a5b7012943aeea17) ("mm: remove bootmem allocator implementation")
**Kernel**: v4.20 (2018)
**Author**: Mike Rapoport (IBM)

This was a significant cleanup -- the bootmem code had accumulated decades of workarounds and special cases.

### Recent Improvements

**Commit**: [35fd0808de0e](https://git.kernel.org/linus/35fd0808de0e) ("memblock: introduce memblock_phys_free()")
**Kernel**: v6.1 (2022)
**Author**: Mike Rapoport

Part of a broader effort to clean up early memory management and reduce the use of `memblock_free()` which had confusing semantics (it freed from the reserved list, not the memory list).

## Observing memblock

### debugfs Interface

If `CONFIG_ARCH_KEEP_MEMBLOCK` is enabled, you can inspect the memblock state after boot:

```bash
# View memory regions
cat /sys/kernel/debug/memblock/memory

# View reserved regions
cat /sys/kernel/debug/memblock/reserved

# Example output (memory):
#    0: 0x0000000000000000..0x000000009fffffff (2560 MB)
#    1: 0x0000000100000000..0x00000004ffffffff (16384 MB)
```

### Early Boot Messages

memblock logs its activity to dmesg during early boot. Look for lines with the `memblock` prefix:

```bash
dmesg | grep -i memblock

# Example output:
# [    0.000000] memblock_add: [mem 0x00000000-0x9fffffff]
# [    0.000000] memblock_reserve: [mem 0x01000000-0x01ffffff]
# [    0.000000] memblock: memory size = 16384 MB
```

For more verbose output, pass `memblock=debug` on the kernel command line. This enables detailed logging of every memblock operation:

```bash
# In bootloader config (e.g., GRUB):
linux /vmlinuz memblock=debug ...
```

### e820 Table (x86)

On x86 systems, you can see the firmware memory map that feeds into memblock:

```bash
dmesg | grep e820

# Example output:
# BIOS-e820: [mem 0x0000000000000000-0x000000000009fbff] usable
# BIOS-e820: [mem 0x000000000009fc00-0x000000000009ffff] reserved
# BIOS-e820: [mem 0x00000000000f0000-0x00000000000fffff] reserved
# BIOS-e820: [mem 0x0000000000100000-0x000000003fffffff] usable
```

## Try It Yourself

### Inspect memblock Regions

```bash
# Check if your kernel preserves memblock data
ls /sys/kernel/debug/memblock/ 2>/dev/null && echo "memblock debugfs available"

# If available, examine the memory layout
cat /sys/kernel/debug/memblock/memory
cat /sys/kernel/debug/memblock/reserved

# Count the number of memory regions
wc -l < /sys/kernel/debug/memblock/memory
```

### Trace the Boot Memory Setup

```bash
# See how firmware reported memory to the kernel
dmesg | grep -E "(e820|memblock|Memory:)"

# The "Memory:" line shows the final accounting
# Memory: 16123456K/16777216K available
#          (X kernel code, Y rwdata, Z rodata, W init, V bss, ...)
```

### Enable Verbose memblock Logging

```bash
# Add to kernel command line (requires reboot)
# For GRUB: edit /etc/default/grub, add memblock=debug to GRUB_CMDLINE_LINUX
sudo sed -i 's/GRUB_CMDLINE_LINUX="\(.*\)"/GRUB_CMDLINE_LINUX="\1 memblock=debug"/' /etc/default/grub
sudo update-grub

# After reboot, check the detailed log
dmesg | grep memblock | head -50
```

### Compare memblock with Runtime View

```bash
# memblock's view (boot time, if preserved)
cat /sys/kernel/debug/memblock/memory 2>/dev/null

# Buddy allocator's view (runtime)
cat /proc/buddyinfo

# Total managed memory
grep MemTotal /proc/meminfo
```

## Key Data Structures

### struct memblock (Global State)

The entire memblock state lives in a single global variable:

```c
struct memblock memblock __initdata_memblock = {
    .memory.regions     = memblock_memory_init_regions,
    .memory.cnt         = 1,    /* empty dummy region */
    .memory.max         = INIT_MEMBLOCK_REGIONS,
    .memory.name        = "memory",

    .reserved.regions   = memblock_reserved_init_regions,
    .reserved.cnt       = 1,
    .reserved.max       = INIT_MEMBLOCK_RESERVED_REGIONS,
    .reserved.name      = "reserved",

    .bottom_up          = false,
    .current_limit      = MEMBLOCK_ALLOC_ANYWHERE,
};
```

The `__initdata_memblock` annotation means this data is either `__initdata` (freed after boot) or `__meminitdata` (kept for memory hotplug), depending on `CONFIG_ARCH_KEEP_MEMBLOCK`.

### memblock_flags

```c
enum memblock_flags {
    MEMBLOCK_NONE       = 0x0,   /* No special flags */
    MEMBLOCK_HOTPLUG    = 0x1,   /* Hotpluggable memory */
    MEMBLOCK_MIRROR     = 0x2,   /* Mirrored (EFI) memory */
    MEMBLOCK_NOMAP      = 0x4,   /* Don't add to direct mapping */
    MEMBLOCK_DRIVER_MANAGED = 0x8, /* Managed by a driver */
};
```

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/memblock.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memblock.c) | Core memblock implementation |
| [`include/linux/memblock.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/memblock.h) | Public API and data structures |
| [`drivers/of/fdt.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/of/fdt.c) | Device tree memory scanning |
| [`arch/x86/kernel/e820.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/e820.c) | x86 e820 to memblock translation |

### Key Commits

| Commit | Kernel | Description |
|--------|--------|-------------|
| [95f72d1ed41a](https://git.kernel.org/linus/95f72d1ed41a) | v2.6.35 | Rename lmb to memblock |
| [9a8dd708d547](https://git.kernel.org/linus/9a8dd708d547) | v3.12 | Remove bootmem dependency on memblock |
| [355c45affca7](https://git.kernel.org/linus/355c45affca7114ab510e296a5b7012943aeea17) | v4.20 | Remove bootmem allocator implementation |
| [35fd0808de0e](https://git.kernel.org/linus/35fd0808de0e) | v6.1 | Introduce memblock_phys_free() |

### LWN Articles

- [A quick history of early-boot memory allocators](https://lwn.net/Articles/382559/) -- Coverage of the lmb-to-memblock rename and rationale
- [Improvements to memblock](https://lwn.net/Articles/761215/) -- Mike Rapoport's work cleaning up the early memory allocator

### Related

- [page-allocator](page-allocator.md) - The buddy allocator that memblock hands off to
- [overview](overview.md) - How memblock fits in the allocator hierarchy
- [numa](numa.md) - NUMA-aware memblock allocation
