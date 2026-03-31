# VFIO: Virtual Function I/O and Device Passthrough

> IOMMU groups, DMA remapping, and direct PCI device access from userspace/VMs

## What is VFIO?

VFIO (Virtual Function I/O) provides a secure mechanism to expose PCI devices directly to userspace processes or VMs, bypassing the kernel driver. A guest VM with VFIO passthrough can access the device at near-native speed:

```
Without passthrough:
  Guest driver → virtio protocol → host vhost/QEMU → host kernel driver → hardware
  Every I/O: multiple context switches, data copies

With VFIO passthrough:
  Guest driver → VFIO → IOMMU DMA remapping → hardware
  Direct DMA: guest physical addresses remapped by IOMMU to real hardware addresses
```

**Requirements**:
- IOMMU hardware (Intel VT-d or AMD-Vi)
- Device must be in its own IOMMU group (or group isolation satisfied)
- `intel_iommu=on` or `amd_iommu=on` boot parameter

## IOMMU groups

An IOMMU group is the smallest set of devices that must be isolated together for DMA safety. Devices in the same PCIe hierarchy that can peer-DMA to each other form a group:

```bash
# List all IOMMU groups:
find /sys/kernel/iommu_groups -type l | sort -V | head -20
# /sys/kernel/iommu_groups/0/devices/0000:00:00.0
# /sys/kernel/iommu_groups/1/devices/0000:00:01.0
# /sys/kernel/iommu_groups/2/devices/0000:00:02.0
# ...

# Check which group a device belongs to:
ls /sys/bus/pci/devices/0000:03:00.0/iommu_group
# → ../../../kernel/iommu_groups/15

# List all devices in a group:
ls /sys/kernel/iommu_groups/15/devices/
# 0000:03:00.0  0000:03:00.1  ← e.g., NIC with two functions

# For passthrough, ALL devices in the group must be passed through
# (or left to vfio-pci stub driver)
```

## VFIO architecture

```
Userspace (QEMU/application)
    ↓ open/ioctl
/dev/vfio/vfio           ← container (IOMMU domain)
/dev/vfio/<group_id>     ← IOMMU group
    ↓
VFIO kernel driver
    ↓
IOMMU driver (Intel VT-d / AMD-Vi)
    ↓
PCIe device BAR access (MMIO mapped to guest/userspace)
DMA: guest GPA → IOMMU → host HPA (remapped per container)
```

### Key objects

```c
/* 1. Container: an IOMMU address space (shared by multiple groups) */
/*    fd = open("/dev/vfio/vfio", O_RDWR) */

/* 2. Group: a set of devices that share DMA isolation requirements */
/*    fd = open("/dev/vfio/15", O_RDWR)  (group 15) */

/* 3. Device: one PCI function within a group */
/*    fd = ioctl(group_fd, VFIO_GROUP_GET_DEVICE_FD, "0000:03:00.0") */
```

## Setting up VFIO passthrough

```bash
# Step 1: Enable IOMMU in boot parameters (/etc/default/grub):
GRUB_CMDLINE_LINUX="intel_iommu=on iommu=pt"
# iommu=pt: passthrough mode (better performance for non-vfio devices)
update-grub && reboot

# Step 2: Load vfio-pci module:
modprobe vfio-pci

# Step 3: Unbind device from its current driver:
echo 0000:03:00.0 > /sys/bus/pci/devices/0000:03:00.0/driver/unbind

# Step 4: Bind to vfio-pci:
echo "10de 1234" > /sys/bus/pci/drivers/vfio-pci/new_id  # vendor:device
# or:
echo 0000:03:00.0 > /sys/bus/pci/drivers/vfio-pci/bind

# Step 5: Verify:
ls /sys/bus/pci/devices/0000:03:00.0/driver
# → /sys/bus/pci/drivers/vfio-pci

# Step 6: Check group:
ls /sys/kernel/iommu_groups/15/devices/
# All devices in group must be bound to vfio-pci (or no driver)
```

## QEMU device passthrough

```bash
# Pass an NVIDIA GPU to a VM:
qemu-system-x86_64 \
    -enable-kvm \
    -m 8G \
    -cpu host \
    -device vfio-pci,host=03:00.0,multifunction=on \
    -device vfio-pci,host=03:00.1 \   # audio function
    -drive if=virtio,file=vm.img \
    -net user,hostfwd=tcp::2222-:22

# Pass an NVMe SSD:
qemu-system-x86_64 \
    -enable-kvm \
    -device vfio-pci,host=02:00.0 \   # NVMe controller
    ...
```

## Userspace VFIO API

Applications (not just VMs) can use VFIO directly for device access:

```c
#include <linux/vfio.h>

/* 1. Open container */
int container = open("/dev/vfio/vfio", O_RDWR);
ioctl(container, VFIO_GET_API_VERSION);  /* must be VFIO_API_VERSION */

/* 2. Open IOMMU group */
int group = open("/dev/vfio/15", O_RDWR);
struct vfio_group_status status;
ioctl(group, VFIO_GROUP_GET_STATUS, &status);
assert(status.flags & VFIO_GROUP_FLAGS_VIABLE);

/* 3. Add group to container */
ioctl(group, VFIO_GROUP_SET_CONTAINER, &container);

/* 4. Set IOMMU type (creates the DMA mapping domain) */
ioctl(container, VFIO_SET_IOMMU, VFIO_TYPE1_IOMMU);

/* 5. Map DMA buffers into IOMMU */
struct vfio_iommu_type1_dma_map dma_map = {
    .argsz = sizeof(dma_map),
    .flags = VFIO_DMA_MAP_FLAG_READ | VFIO_DMA_MAP_FLAG_WRITE,
    .vaddr = (uintptr_t)buf,    /* host virtual address */
    .iova  = 0x10000000,        /* IOVA (device sees this address) */
    .size  = BUF_SIZE,
};
ioctl(container, VFIO_IOMMU_MAP_DMA, &dma_map);
/* Device can now DMA to/from IOVA 0x10000000 */

/* 6. Get device fd */
int device = ioctl(group, VFIO_GROUP_GET_DEVICE_FD, "0000:03:00.0");

/* 7. Get device info (BARs, interrupts) */
struct vfio_device_info device_info = { .argsz = sizeof(device_info) };
ioctl(device, VFIO_DEVICE_GET_INFO, &device_info);
/* device_info.num_regions: number of BARs/capabilities */
/* device_info.num_irqs:    number of interrupt types */

/* 8. Map BAR 0 (MMIO registers) into process address space */
struct vfio_region_info reg = {
    .argsz = sizeof(reg),
    .index = VFIO_PCI_BAR0_REGION_INDEX,
};
ioctl(device, VFIO_DEVICE_GET_REGION_INFO, &reg);
void *mmio = mmap(NULL, reg.size, PROT_READ|PROT_WRITE,
                   MAP_SHARED, device, reg.offset);
/* Now: read/write directly to mmio like a kernel driver would */
```

## SR-IOV: Virtual Functions

SR-IOV (Single Root I/O Virtualization) allows one physical device to appear as multiple virtual functions (VFs):

```bash
# Enable SR-IOV (create 4 VFs from one PF):
echo 4 > /sys/bus/pci/devices/0000:03:00.0/sriov_numvfs

# VFs appear as new PCI devices:
lspci | grep "Virtual Function"
# 03:00.1  VF 1
# 03:00.2  VF 2
# 03:00.3  VF 3
# 03:00.4  VF 4

# Bind each VF to vfio-pci and pass to different VMs:
echo 0000:03:00.1 > /sys/bus/pci/drivers/vfio-pci/bind

# Network SR-IOV: VF gets its own MAC/VLAN, dedicated queue rings
ip link set eth0 vf 0 mac 52:54:00:01:02:03 vlan 100 rate 1000
```

## Mediated devices (mdev)

Some devices support mediated passthrough — the host driver slices the device and presents virtual sub-devices:

```bash
# Intel GVT-g: share one GPU across multiple VMs
ls /sys/bus/pci/devices/0000:00:02.0/mdev_supported_types/
# i915-GVTg_V5_4  ← 4 GPU VMs sharing one GPU

# Create a mediated device instance:
uuidgen  # e.g., 83b8f4f2-509f-382f-3c1e-e6bfe0fa1001
echo "83b8f4f2-509f-382f-3c1e-e6bfe0fa1001" > \
    /sys/bus/pci/devices/0000:00:02.0/mdev_supported_types/i915-GVTg_V5_4/create

# Assign to QEMU:
qemu-system-x86_64 \
    -device vfio-pci,sysfsdev=/sys/bus/mdev/devices/83b8f4f2-...
```

## VFIO kernel internals

```c
/* drivers/vfio/vfio.c */

/* The container manages the IOMMU domain: */
struct vfio_container {
    struct kref         kref;
    struct list_head    group_list;
    struct rw_semaphore group_lock;
    struct vfio_iommu_driver *iommu_driver;
    void               *iommu_data;   /* iommu_domain */
    bool                noiommu;
};

/* Each group connects devices to a container: */
struct vfio_group {
    struct iommu_group  *iommu_group;
    struct vfio_container *container;
    struct list_head    device_list;
    struct cdev         cdev;         /* /dev/vfio/<id> */
};

/* VFIO PCI device - wraps a PCI device for userspace access: */
struct vfio_pci_core_device {
    struct vfio_device  vdev;
    struct pci_dev     *pdev;
    void __iomem       *barmap[PCI_STD_NUM_BARS]; /* BAR mappings */
    struct eventfd_ctx *ctx[VFIO_PCI_NUM_IRQS];  /* IRQ eventfds */
    /* ... */
};
```

### DMA mapping path

```c
/* When userspace calls VFIO_IOMMU_MAP_DMA: */
static int vfio_iommu_type1_dma_map(...)
{
    /* 1. Pin the userspace pages */
    pin_user_pages_fast(vaddr, npage, FOLL_WRITE, pages);

    /* 2. Create IOMMU mapping: IOVA → physical pages */
    iommu_map(domain, iova, phys_addr, size,
              IOMMU_READ | IOMMU_WRITE | IOMMU_CACHE);

    /* Now device DMA to IOVA goes through IOMMU → correct physical pages */
    /* Without IOMMU: device could DMA anywhere → security hole */
}
```

## Observability

```bash
# Check IOMMU is active:
dmesg | grep -i iommu | head -5
# [    0.234] DMAR: IOMMU enabled

# Check VFIO groups:
ls /dev/vfio/
# vfio  15  23  ...

# IOMMU mappings for a container:
cat /sys/kernel/debug/iommu/intel/iommu_devices 2>/dev/null | head -20

# Performance: check for IOMMU TLB shootdowns
perf stat -e power/pts/  # Intel IOMMU TLB misses
```

## Further reading

- [KVM Architecture](kvm-arch.md) — VM exits and VMCS
- [Memory Virtualization](kvm-memory.md) — EPT and shadow paging
- [IOMMU Architecture](../iommu/iommu-arch.md) — IOMMU hardware and DMA API
- [PCI Drivers](../drivers/pci-driver.md) — How PCI drivers work before VFIO
- `drivers/vfio/` — VFIO framework
- `drivers/vfio/pci/` — vfio-pci driver
- `Documentation/driver-api/vfio.rst`
