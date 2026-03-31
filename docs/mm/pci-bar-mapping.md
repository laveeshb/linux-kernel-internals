# PCI BAR Memory Mapping

> How the kernel discovers, claims, and maps PCI device memory regions into kernel virtual address space

## What Are PCI BARs?

Every PCI and PCIe device exposes up to six **Base Address Registers** (BARs), numbered BAR0 through BAR5, in its configuration space. These registers tell the operating system where the device's memory-mapped I/O (MMIO) regions live in the physical address space.

BARs live at offsets `0x10` through `0x24` in the standard PCI configuration header, defined in [`include/uapi/linux/pci_regs.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/pci_regs.h):

```c
#define PCI_BASE_ADDRESS_0  0x10  /* 32 bits */
#define PCI_BASE_ADDRESS_1  0x14  /* 32 bits */
#define PCI_BASE_ADDRESS_2  0x18  /* 32 bits */
#define PCI_BASE_ADDRESS_3  0x1c  /* 32 bits */
#define PCI_BASE_ADDRESS_4  0x20  /* 32 bits */
#define PCI_BASE_ADDRESS_5  0x24  /* 32 bits */
```

The maximum number of standard BARs is defined as `PCI_STD_NUM_BARS = 6` in [`include/uapi/linux/pci_regs.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/pci_regs.h).

### How BAR Size Is Determined

The firmware or OS discovers the size of a BAR region using a hardware protocol: write all-1s (`0xFFFFFFFF`) to the BAR register, read the value back, mask off the type bits, and invert. The result is the size minus one. This is called **BAR sizing** and is performed by `pci_read_bases()` in [`drivers/pci/probe.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/probe.c), called from `pci_setup_device()` during bus enumeration.

```
Write: 0xFFFFFFFF → BAR register
Read back: 0xFFFFF000  (device decodes 12 address bits → 4 KB region)
Mask type bits, invert: size = 4096 bytes
```

The device decodes only the bits it responds to; the rest read back as zero. The lower bits hold type information and are masked before the inversion.

## BAR Types

The lower bits of each BAR register encode the region's type:

```c
#define PCI_BASE_ADDRESS_SPACE         0x01  /* 0 = memory, 1 = I/O */
#define PCI_BASE_ADDRESS_SPACE_IO      0x01
#define PCI_BASE_ADDRESS_SPACE_MEMORY  0x00
#define PCI_BASE_ADDRESS_MEM_TYPE_MASK 0x06
#define PCI_BASE_ADDRESS_MEM_TYPE_32   0x00  /* 32-bit address */
#define PCI_BASE_ADDRESS_MEM_TYPE_1M   0x02  /* Below 1M (obsolete) */
#define PCI_BASE_ADDRESS_MEM_TYPE_64   0x04  /* 64-bit address */
#define PCI_BASE_ADDRESS_MEM_PREFETCH  0x08  /* prefetchable? */
```

### Memory BARs (`PCI_BASE_ADDRESS_SPACE_MEMORY`)

The common case. The BAR describes a window of physical address space that maps directly to device registers or device-local memory. CPU accesses to this window go out on the PCIe bus and reach the device. The kernel maps these regions using `ioremap()` or one of its variants.

### I/O BARs (`PCI_BASE_ADDRESS_SPACE_IO`)

A legacy type specific to x86. The device occupies a range in the x86 I/O port address space, accessed via `inb()`/`outb()` instructions rather than normal memory loads and stores. Modern devices rarely use I/O BARs; PCIe firmware often assigns them but devices may not actually need them. `pci_iomap()` handles both types transparently.

### Prefetchable BARs (`PCI_BASE_ADDRESS_MEM_PREFETCH`)

A memory BAR with a guarantee that reads have no side effects and the CPU or PCIe fabric can safely prefetch data and combine writes. This is set only for regions like GPU framebuffers where sequential writes benefit from write-combining. Non-prefetchable BARs must not be speculatively read -- side effects (like clearing a status register on read) would be triggered incorrectly.

### 64-bit BARs (`PCI_BASE_ADDRESS_MEM_TYPE_64`)

A 64-bit memory BAR uses **two consecutive BAR slots** to store the full 64-bit base address: the lower 32 bits in BAR `n` and the upper 32 bits in BAR `n+1`. This means a device can have at most three 64-bit BARs (using all six slots in pairs), and accessing the resource via `pci_resource_start(dev, n)` gives the full 64-bit physical address correctly -- the kernel handles the two-register assembly transparently during `pci_read_bases()`.

```
BAR Layout for a device with one 64-bit BAR at BAR0:

  BAR0  [0x10]: lower 32 bits of address + type bits
  BAR1  [0x14]: upper 32 bits of address
  BAR2  [0x18]: next independent BAR (e.g., another memory region)
```

## Linux BAR Enumeration

During PCI bus enumeration, the kernel calls `pci_setup_device()` → `pci_read_bases()` for every device found. This function reads and sizes all BARs, then stores the results in `dev->resource[]` -- an array of `struct resource` indexed 0 through 5 (for the standard BARs), with entry 6 reserved for the expansion ROM.

After enumeration, three macros in [`include/linux/pci.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pci.h) give drivers everything they need:

```c
pci_resource_start(dev, bar)  /* physical base address of the BAR */
pci_resource_len(dev, bar)    /* size of the BAR region in bytes  */
pci_resource_flags(dev, bar)  /* type and attribute flags          */
```

The flags use the `IORESOURCE_*` constants from [`include/linux/ioport.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/ioport.h):

| Flag | Value | Meaning |
|------|-------|---------|
| `IORESOURCE_IO` | `0x00000100` | I/O port BAR |
| `IORESOURCE_MEM` | `0x00000200` | Memory BAR |
| `IORESOURCE_PREFETCH` | `0x00002000` | Prefetchable memory |
| `IORESOURCE_MEM_64` | `0x00100000` | 64-bit address BAR |

## Requesting and Mapping a BAR

A driver must follow three steps in order: enable the device, claim the BAR region from the kernel resource tree, and map the BAR into kernel virtual address space. All three functions live in [`drivers/pci/pci.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/pci.c) and [`drivers/pci/iomap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/iomap.c).

### The Standard Driver Pattern

```c
static int my_driver_probe(struct pci_dev *pdev,
                           const struct pci_device_id *id)
{
    void __iomem *base;
    int err;

    /* 1. Enable the device (powers on, enables bus mastering) */
    err = pci_enable_device(pdev);
    if (err)
        return err;

    /* 2. Claim BAR 0 — prevents other drivers from touching it.
     *    pci_request_regions() claims all BARs at once. */
    err = pci_request_region(pdev, 0, "my_driver");
    if (err)
        goto err_disable;

    /* 3. Map BAR 0 into kernel virtual address space.
     *    Pass 0 as maxlen to map the full BAR. */
    base = pci_iomap(pdev, 0, 0);
    if (!base) {
        err = -ENOMEM;
        goto err_release;
    }

    /* 4. Access the device using ioread*/iowrite* — never
     *    dereference the pointer directly. */
    u32 version = ioread32(base + REG_VERSION);
    iowrite32(CTRL_ENABLE, base + REG_CONTROL);

    pci_set_drvdata(pdev, base);
    return 0;

err_release:
    pci_release_region(pdev, 0);
err_disable:
    pci_disable_device(pdev);
    return err;
}

static void my_driver_remove(struct pci_dev *pdev)
{
    void __iomem *base = pci_get_drvdata(pdev);

    pci_iounmap(pdev, base);
    pci_release_region(pdev, 0);
    pci_disable_device(pdev);
}
```

### Function Reference

**`pci_request_region(pdev, bar, name)`** / **`pci_request_regions(pdev, name)`**

Claims one BAR (or all BARs) by inserting entries into the kernel's `iomem` or `ioport` resource tree. Returns `-EBUSY` if another driver already owns the region. This is the software lock that prevents two drivers from simultaneously mapping the same hardware registers. Defined in [`drivers/pci/pci.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/pci.c).

**`pci_iomap(pdev, bar, maxlen)`**

Maps the BAR into kernel virtual address space and returns a `void __iomem *` cookie. Internally calls `ioremap()` for memory BARs or `__pci_ioport_map()` for I/O BARs. If `maxlen` is 0, the entire BAR is mapped. Defined in [`drivers/pci/iomap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/iomap.c).

**`ioread32(addr)` / `iowrite32(val, addr)`**

The correct way to access MMIO. These functions handle any required memory barriers and work correctly regardless of whether the underlying mapping is true MMIO or an I/O port range. Do **not** dereference the `__iomem` pointer directly -- the compiler will allow it but it bypasses the barriers and will break on some architectures.

**`pci_iounmap(pdev, addr)` / `pci_release_regions(pdev)`**

Teardown pair for the mapping and claim. Always call them in driver `remove()`.

### Managed Variant: `pcim_iomap()`

For drivers that want automatic cleanup on driver detach, the devres-managed variant `pcim_iomap()` is available. It requires `pcim_enable_device()` instead of `pci_enable_device()`. The mapping is automatically released when the driver unbinds. Defined in [`drivers/pci/devres.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/devres.c).

```c
err = pcim_enable_device(pdev);
if (err)
    return err;

base = pcim_iomap(pdev, 0, 0);
if (!base)
    return -ENOMEM;
/* No explicit cleanup needed in remove() */
```

## Memory Types for BAR Mappings

How the CPU accesses MMIO depends on the **page attribute** applied when the virtual mapping is created. The choice has large performance implications. On x86, this is controlled by the **Page Attribute Table (PAT)**, implemented in [`arch/x86/mm/pat/memtype.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/pat/memtype.c).

### Uncached (UC) — Non-Prefetchable BARs

`ioremap()` (called internally by `pci_iomap()`) maps the region as **UC-minus** (uncacheable, write-posted). Every read and write goes directly to the device; no data is held in any CPU cache. This is mandatory for control registers where each read may have side effects and writes must be visible to the device immediately.

```c
/* ioremap() is the default -- UC-minus caching */
void __iomem *ioremap(resource_size_t phys_addr, unsigned long size);
```

### Write-Combining (WC) — Prefetchable BARs

`ioremap_wc()` maps the region with **write-combining** enabled. The CPU may buffer multiple writes and send them to the device in a single burst, dramatically improving throughput for sequential writes. Reads still go to the device but there is no read prefetching. This is the correct choice for framebuffers, PCIe peer-to-peer memory, and any large, streaming-write workload.

```c
/* ioremap_wc() -- write-combining for prefetchable BARs */
void __iomem *ioremap_wc(resource_size_t phys_addr, unsigned long size);
```

The PCI subsystem provides a wrapper for the write-combining case, defined in [`drivers/pci/iomap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/iomap.c):

```c
/* Maps a BAR with write-combining (prefetchable BARs only) */
void __iomem *pci_iomap_wc(struct pci_dev *dev, int bar,
                            unsigned long maxlen);
```

`pci_iomap_wc()` returns `NULL` for I/O BARs (write-combining makes no sense for port I/O) and calls `ioremap_wc()` for memory BARs.

### Choosing the Right Mapping

```c
unsigned long flags = pci_resource_flags(pdev, bar);

if (flags & IORESOURCE_PREFETCH) {
    /* Safe to use write-combining */
    base = pci_iomap_wc(pdev, bar, 0);
} else {
    /* Non-prefetchable: use uncached */
    base = pci_iomap(pdev, bar, 0);
}
```

!!! warning "Performance impact"
    Mapping a 256 MB framebuffer as UC instead of WC can reduce sequential write throughput by an order of magnitude. GPU drivers are careful to use `pci_iomap_wc()` for VRAM BARs and `pci_iomap()` for register BARs even on the same device.

## IOMMU and BAR Access

The IOMMU translates device-issued DMA addresses (device → RAM direction). BAR accesses travel in the **opposite direction** (CPU → device) and bypass the IOMMU entirely. The CPU issues a physical memory transaction on the PCIe bus; the device responds directly.

```
DMA (device → RAM):
  Device --[DMA addr]--> IOMMU --[phys addr]--> RAM

MMIO (CPU → device):
  CPU --[phys addr]--> PCIe --[reaches device, not RAM]
```

The IOMMU is not involved in MMIO reads or writes. However, during BAR assignment the firmware (and optionally the kernel) must ensure BAR physical addresses do not overlap with installed RAM. On x86 this is enforced by the memory map in `E820`, and the PCI subsystem checks `iomem_resource` before accepting BAR assignments.

## 64-Bit BARs and Address Space Conflicts

On systems with more than 4 GB of RAM, 32-bit BARs (which can only describe addresses below 4 GB) can conflict with installed memory. On most modern x86 systems, firmware handles this by reserving a region below 4 GB (sometimes called the **PCI hole** or **TOLUD** -- Top Of Low Usable DRAM) where BARs are placed without conflict. However, this shrinks the effective addressable low memory.

To check whether a BAR uses 64-bit addressing from driver code:

```c
if (pci_resource_flags(pdev, bar) & IORESOURCE_MEM_64) {
    /* BAR uses a 64-bit address; bar+1 is consumed for the high bits */
    pr_info("64-bit BAR at %pa, size %pa\n",
            &pci_resource_start(pdev, bar),
            &pci_resource_len(pdev, bar));
}
```

Modern NVMe drives, CXL memory devices, and high-end GPUs routinely use 64-bit BARs larger than 4 GB (e.g., a 16 GB VRAM BAR) placed above the 4 GB boundary. The kernel places these via `pci_reassign_resource()` in [`drivers/pci/setup-res.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/setup-res.c) when firmware leaves BARs unassigned or assigns them suboptimally.

!!! note "Firmware vs. kernel BAR assignment"
    Most x86 systems have firmware assign all BARs before the kernel boots. The kernel then reads and trusts those assignments. On embedded systems or when `pci=realloc` is passed on the kernel command line, the kernel may reassign BARs itself.

## Debugging BAR Mappings

### `lspci -v`

Shows all BARs assigned to a device, including their physical addresses, sizes, and types:

```
$ lspci -v -s 03:00.0
03:00.0 VGA compatible controller: NVIDIA Corporation ...
        Memory at f6000000 (32-bit, non-prefetchable) [size=16M]
        Memory at e0000000 (64-bit, prefetchable) [size=256M]
        Memory at f0000000 (64-bit, prefetchable) [size=32M]
        I/O ports at e000 [size=128]
```

The lines after the device description are the BARs. `prefetchable` indicates `IORESOURCE_PREFETCH` is set.

### `/proc/iomem`

Shows how BARs occupy the physical address space alongside RAM and other resources:

```
$ cat /proc/iomem
00000000-00000fff : Reserved
...
e0000000-efffffff : PCI Bus 0000:03
  e0000000-efffffff : 0000:03:00.0
    e0000000-efffffff : nvidia
f6000000-f6ffffff : 0000:03:00.0
  f6000000-f6ffffff : nvidia
```

Entries are indented to show the resource hierarchy: bus window → device BAR → driver claim.

### `/sys/bus/pci/devices/BBDF/resource`

Each PCI device has a `resource` file showing all six BARs plus the expansion ROM, one per line, as three hex fields: start, end, flags.

```
$ cat /sys/bus/pci/devices/0000:03:00.0/resource
0x00000000f6000000 0x00000000f6ffffff 0x0000000000040200
0x00000000e0000000 0x00000000efffffff 0x000000000014220c
0x00000000f0000000 0x00000000f1ffffff 0x000000000014220c
0x000000000000e000 0x000000000000e07f 0x0000000000040101
0x0000000000000000 0x0000000000000000 0x0000000000000000
0x0000000000000000 0x0000000000000000 0x0000000000000000
```

The third column is the `IORESOURCE_*` flags. `0x200` is `IORESOURCE_MEM`; `0x2000` is `IORESOURCE_PREFETCH`; `0x100000` is `IORESOURCE_MEM_64`.

### `/sys/bus/pci/devices/BBDF/resource0` through `resource5`

These files are `mmap()`-able from userspace (when the BAR is not marked exclusive). A userspace tool can map a BAR directly without a kernel driver:

```c
int fd = open("/sys/bus/pci/devices/0000:03:00.0/resource0", O_RDWR);
size_t len = /* from resource file or lspci */ 16 * 1024 * 1024;
void *mmio = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
uint32_t val = *(volatile uint32_t *)mmio;  /* direct access from userspace */
```

This is how tools like `nvtop` and GPU compute debuggers access device memory without a kernel driver. Note that `pci_request_regions_exclusive()` prevents this by setting `IORESOURCE_EXCLUSIVE`, blocking the sysfs mmap path.

### Checking BAR assignments at boot

```bash
# All PCI-related messages during bus enumeration
dmesg | grep -i pci | grep -i BAR

# Check a specific device's resources from sysfs
cat /sys/bus/pci/devices/0000:03:00.0/resource

# Show the full iomem map
cat /proc/iomem | grep -A2 "PCI Bus"
```

## Key Source Files

| File | Description |
|------|-------------|
| [`drivers/pci/iomap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/iomap.c) | `pci_iomap()`, `pci_iomap_wc()`, `pci_iomap_range()`, `pci_iounmap()` |
| [`drivers/pci/pci.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/pci.c) | `pci_request_region()`, `pci_request_regions()`, `pci_release_regions()` |
| [`drivers/pci/probe.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/probe.c) | `pci_setup_device()`, `pci_read_bases()` — BAR sizing and enumeration |
| [`drivers/pci/devres.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/devres.c) | `pcim_iomap()`, `pcim_enable_device()` — managed (devres) variants |
| [`drivers/pci/setup-res.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/setup-res.c) | `pci_reassign_resource()` — BAR relocation |
| [`include/linux/pci.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pci.h) | `pci_resource_start()`, `pci_resource_len()`, `pci_resource_flags()` |
| [`include/uapi/linux/pci_regs.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/pci_regs.h) | `PCI_BASE_ADDRESS_*` constants, `PCI_STD_NUM_BARS` |
| [`include/linux/ioport.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/ioport.h) | `IORESOURCE_MEM`, `IORESOURCE_PREFETCH`, `IORESOURCE_MEM_64` |
| [`arch/x86/mm/ioremap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/ioremap.c) | `ioremap()`, `ioremap_wc()`, `ioremap_uc()` on x86 |
| [`arch/x86/mm/pat/memtype.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/pat/memtype.c) | PAT — page attribute table controlling cache modes |

---

## References

### Further Reading

- [Kernel documentation: Device I/O](https://docs.kernel.org/driver-api/device-io.html) — authoritative guide to MMIO access functions
- [PCI Local Bus Specification, rev 3.0](https://pcisig.com/) — defines BAR layout, sizing protocol, and type bits
- [LWN: PCI resource management](https://lwn.net/Articles/51834/) — early overview of how Linux manages PCI resources
- [LWN: Write-combining mappings](https://lwn.net/Articles/252029/) — PAT and write-combining performance on x86

### Related Pages

- [DMA Memory Allocation](dma.md) — how devices transfer data to/from RAM (distinct from MMIO)
- [vmalloc](vmalloc.md) — kernel virtual address space that `ioremap()` carves from
- [Page Tables](page-tables.md) — how `ioremap()` mappings appear in the kernel page table
- [CXL Memory Tiering](cxl-memory-tiering.md) — CXL devices expose large 64-bit BARs for memory expansion

## Further reading

- [Kernel docs: Device I/O](https://docs.kernel.org/driver-api/device-io.html) — authoritative guide to `ioread*`/`iowrite*`, `ioremap` variants, and MMIO access rules
- [`Documentation/PCI/`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/PCI) — kernel PCI documentation directory covering BAR assignment, error handling, and host bridge enumeration
- [`Documentation/PCI/pci.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/PCI/pci.rst) — step-by-step guide to writing PCI drivers including the enable/request/map lifecycle
- [`drivers/pci/iomap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/iomap.c) — `pci_iomap()` and `pci_iomap_wc()` source
- [`drivers/pci/probe.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/probe.c) — `pci_read_bases()` BAR sizing protocol implementation
- [LWN: PCI resource management](https://lwn.net/Articles/51834/) — early overview of how Linux claims and tracks PCI resources (2003)
- [LWN: Write-combining and the PAT](https://lwn.net/Articles/252029/) — PAT memory types and write-combining performance on x86 (2008)
- [../drivers/pci-driver.md](../drivers/pci-driver.md) — PCI driver model: probe/remove lifecycle, device IDs, and power management
- [Device Memory Coherency](device-coherency.md) — cache attribute selection (`ioremap` vs `ioremap_wc`) for MMIO regions
- [DMA Memory Allocation](dma.md) — device-to-RAM data paths that complement BAR-based MMIO access
