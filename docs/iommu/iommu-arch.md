# IOMMU Architecture

> Intel VT-d, AMD-Vi, iommu_domain, and device passthrough

## Hardware implementations

### Intel VT-d (Virtualization Technology for Directed I/O)

Intel VT-d places a remapping hardware unit (DMAR unit) on the root complex. Each DMAR unit manages a segment of the PCIe bus:

```
CPU ──► System Agent ──► DMAR Unit ──► PCIe Root Port ──► Device
                              │
                         Page Tables
                         (IOVA → HPA)
                              │
                         Access Control
                         (read/write/execute bits)
```

The DMAR unit uses a two-level structure:
1. **Root table** (indexed by bus number)
2. **Context table** (indexed by device/function)
3. Each context entry points to the device's **IOMMU page tables**

```c
/* drivers/iommu/intel/iommu.c */
struct intel_iommu {
    void __iomem    *reg;        /* MMIO registers */
    u64              cap;        /* capability register */
    u64              ecap;       /* extended capability */
    /* ... */
    struct root_entry *root_entry; /* root table (bus indexed) */
    int              seq_id;
    struct iommu_device iommu_dev;
};
```

### AMD-Vi (AMD I/O Virtualization)

AMD uses a single system-wide Device Table (indexed by 16-bit device ID = bus+dev+fn). Each entry points to the device's page table and control flags:

```c
/* drivers/iommu/amd/amd_iommu_types.h */
struct dev_table_entry {
    u64 data[4];
    /*
     * Bits define:
     *   [0]    V:  valid
     *   [1]    TV: translation valid
     *   [11:9] Mode: page table levels
     *   [51:12] PTP: page table pointer
     *   (interrupt remapping fields are in data[2] of the 256-bit entry)
     */
};
```

## The IOMMU subsystem

The kernel abstracts both implementations behind a common API in `drivers/iommu/`.

### struct iommu_domain

An `iommu_domain` represents an isolated address space. One or more devices are attached to a domain; they share the same IOVA→PA translation.

```c
/* include/linux/iommu.h */
struct iommu_domain {
    unsigned            type;      /* IOMMU_DOMAIN_UNMANAGED / BLOCKED / IDENTITY / DMA */
    const struct iommu_domain_ops *ops;
    unsigned long       pgsize_bitmap; /* supported page sizes */
    struct iommu_domain_geometry geometry;  /* IOVA range constraints */
    struct iommu_dma_cookie *iova_cookie;   /* IOVA allocator state */
    /* ... */
};

struct iommu_domain_ops {
    int  (*attach_dev)(struct iommu_domain *domain, struct device *dev);
    void (*detach_dev)(struct iommu_domain *domain, struct device *dev);

    int  (*map_pages)(struct iommu_domain *domain, unsigned long iova,
                      phys_addr_t paddr, size_t pgsize, size_t pgcount,
                      int prot, gfp_t gfp, size_t *mapped);
    size_t (*unmap_pages)(struct iommu_domain *domain, unsigned long iova,
                           size_t pgsize, size_t pgcount,
                           struct iommu_iotlb_gather *iotlb_gather);

    phys_addr_t (*iova_to_phys)(struct iommu_domain *domain, dma_addr_t iova);
    /* ... */
};
```

### Domain types

```c
/* IOMMU_DOMAIN_BLOCKED: all access denied (default) */
/* IOMMU_DOMAIN_IDENTITY: IOVA == PA (passthrough) */
/* IOMMU_DOMAIN_UNMANAGED: driver manages mappings */
/* IOMMU_DOMAIN_DMA: kernel DMA layer manages mappings */
/* IOMMU_DOMAIN_DMA_FQ: DMA with flush queue for deferred TLB invalidation */
```

For normal DMA: `IOMMU_DOMAIN_DMA` — the kernel's DMA API manages IOVA allocation and mapping automatically.

## IOMMU groups

An IOMMU group is the smallest set of devices that the IOMMU can isolate from each other. Devices in the same group must share a domain — you cannot give them independent address spaces.

Why groups? PCIe peer-to-peer transactions: a PCIe bridge may allow devices behind it to DMA to each other, bypassing the IOMMU. The kernel groups these devices to prevent false isolation.

```bash
# A typical system: most devices get their own group
# PCIe root ports and their children may be grouped
ls /sys/kernel/iommu_groups/
# 0  1  2  3  ... 25  ...

# Group 0: Intel audio device
ls /sys/kernel/iommu_groups/0/devices/
# 0000:00:1f.3

# Group 12: discrete GPU (may include audio function)
ls /sys/kernel/iommu_groups/12/devices/
# 0000:01:00.0   (GPU)
# 0000:01:00.1   (GPU HDMI audio)
```

## VFIO: device passthrough to VMs

VFIO (Virtual Function I/O) uses the IOMMU to safely pass a physical device to a VM (KVM) or userspace driver.

```
VM guest
  │  writes to virtual device MMIO
  ▼
KVM VFIO handler
  │
  ▼
VFIO container (an IOMMU domain)
  │  guest physical address → IOVA mapping
  ▼
IOMMU page tables
  │  IOVA → host physical address
  ▼
physical device
```

### VFIO usage

```c
/* Userspace VFIO API */
#include <linux/vfio.h>

/* 1. Open the VFIO container */
int container = open("/dev/vfio/vfio", O_RDWR);

/* 2. Open the IOMMU group */
int group = open("/dev/vfio/12", O_RDWR);  /* group 12 */
ioctl(group, VFIO_GROUP_SET_CONTAINER, &container);

/* 3. Enable IOMMU on the container */
ioctl(container, VFIO_SET_IOMMU, VFIO_TYPE1_IOMMU);

/* 4. Open the device */
int device = ioctl(group, VFIO_GROUP_GET_DEVICE_FD, "0000:01:00.0");

/* 5. Map guest memory into IOMMU domain */
struct vfio_iommu_type1_dma_map dma_map = {
    .argsz = sizeof(dma_map),
    .flags = VFIO_DMA_MAP_FLAG_READ | VFIO_DMA_MAP_FLAG_WRITE,
    .vaddr = (uint64_t)guest_ram,     /* HVA */
    .iova  = 0x0,                     /* guest physical base */
    .size  = guest_ram_size,
};
ioctl(container, VFIO_IOMMU_MAP_DMA, &dma_map);

/* Now: device can DMA to guest memory at IOVA 0..guest_ram_size */
/* The IOMMU prevents the device from accessing other host memory */
```

## SR-IOV: virtual functions

SR-IOV (Single Root I/O Virtualization) creates multiple PCIe **virtual functions** (VFs) from a single physical function (PF). Each VF gets its own PCIe configuration space and can be independently assigned to a VM.

```bash
# Enable VFs on a NIC (e.g., create 4 VFs)
echo 4 | sudo tee /sys/bus/pci/devices/0000:01:00.0/sriov_numvfs

# Each VF gets its own PCI address
lspci | grep "Virtual Function"
# 0000:01:10.0 Ethernet controller: Intel ... Virtual Function
# 0000:01:10.2 ...

# Assign a VF to a VM via VFIO
echo "0000:01:10.0" > /sys/bus/pci/devices/0000:01:10.0/driver/unbind
echo "8086 154c" > /sys/bus/pci/drivers/vfio-pci/new_id
```

## IOMMU TLB management

The IOMMU has its own TLB (IOTLB) that caches IOVA→PA translations. After unmapping, the kernel must flush the IOTLB:

```c
/* drivers/iommu/iommu.c */
void iommu_iotlb_gather_add_page(struct iommu_domain *domain,
                                  struct iommu_iotlb_gather *gather,
                                  unsigned long iova, size_t size)
{
    /* Accumulate unmapped ranges */
    if (gather->start > iova)
        gather->start = iova;
    if (gather->end < iova + size)
        gather->end   = iova + size;
    gather->pgsize = size;
}

/* Flush accumulated ranges (batch for efficiency) */
void iommu_iotlb_sync(struct iommu_domain *domain,
                       struct iommu_iotlb_gather *iotlb_gather)
{
    if (domain->ops->iotlb_sync)
        domain->ops->iotlb_sync(domain, iotlb_gather);
    iommu_iotlb_gather_init(iotlb_gather);
}
```

Deferred flushing (flush queue) amortizes IOTLB invalidation cost by batching unmap operations.

## Observing the IOMMU

```bash
# DMAR faults (device violated IOMMU policy)
dmesg | grep DMAR
# DMAR: [DMA Write] Request device [01:00.0] fault addr 7f000000
# DMAR: [fault reason 02] Present bit in context entry is clear

# IOMMU statistics
cat /sys/kernel/debug/iommu/intel/iommu_perf_stats

# AMD-Vi statistics
cat /sys/kernel/debug/iommu/amd/amd_iommu_stats

# IOVA allocator state
cat /sys/kernel/debug/iommu/iova

# Test IOMMU isolation (VFIO test)
modprobe vfio-pci
```

## Further reading

- [DMA API](dma-api.md) — kernel driver DMA programming
- [Memory Management: DMA](../mm/dma.md) — DMA zones and device coherency
- [Memory Management: Device Coherency](../mm/device-coherency.md) — cache coherency with devices
- [Virtualization: KVM Memory](../virtualization/kvm-memory.md) — EPT complements IOMMU for VMs
- `drivers/iommu/` in the kernel tree — IOMMU subsystem
- `Documentation/userspace-api/iommu.rst` in the kernel tree
