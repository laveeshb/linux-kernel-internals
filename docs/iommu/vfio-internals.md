# VFIO Internals

> Device passthrough: containers, groups, mdev, and KVM integration

## Overview

VFIO (Virtual Function I/O) is the kernel framework for safely exposing physical devices to userspace processes or virtual machines. It uses the IOMMU to enforce memory access isolation while giving the userspace driver (or hypervisor) direct access to device MMIO, interrupts, and DMA.

The three primary use cases are:
- **VM device passthrough**: QEMU/KVM passes a physical NIC, GPU, or NVMe to a guest.
- **Userspace drivers**: DPDK binds NICs to VFIO for kernel-bypass packet processing.
- **Mediated devices**: A physical GPU or NIC is split into virtual instances assigned to separate VMs.

VFIO source lives in `drivers/vfio/` with headers in `include/linux/vfio.h`.

## Container → group → device hierarchy

```
/dev/vfio/vfio          (VFIO container)
    │
    ├── /dev/vfio/12    (IOMMU group 12)
    │       ├── 0000:01:00.0   (GPU)
    │       └── 0000:01:00.1   (GPU HDMI audio)
    │
    └── /dev/vfio/7     (IOMMU group 7)
            └── 0000:03:00.0   (NVMe)
```

**Container**: an IOMMU domain. All groups added to a container share one IOMMU address space. The container is the unit that receives `VFIO_IOMMU_MAP_DMA` calls — mapping guest physical memory into the device's IOVA space.

**Group**: maps to an IOMMU group (the smallest isolatable set of devices). A group must be added to a container before its devices can be opened. All devices in a group share the container's IOMMU domain — it is not possible to assign devices in the same group to different VMs.

**Device**: the individual PCI function. Once the group is in a container, the device fd allows MMIO region mapping, interrupt setup, and device reset.

## Core data structures

```c
/* include/linux/vfio.h */
struct vfio_device {
    struct device            *dev;
    const struct vfio_device_ops *ops;
    struct vfio_group        *group;
    /* IOMMU binding is via iommufd_device in 6.x+ */
    /* ... */
};

/* drivers/vfio/vfio.h -- private to the VFIO core, not the public header above */
struct vfio_group {
    struct device             dev;
    struct cdev                cdev;
    refcount_t                drivers;
    unsigned int               container_users;
    struct iommu_group       *iommu_group;
    struct vfio_container    *container;
    struct list_head          device_list;
    /* ... */
};

/* drivers/vfio/container.c -- no domain pointer; the container just
 * dispatches to whichever IOMMU backend (iommu_driver) is set */
struct vfio_container {
    struct kref                kref;
    struct list_head          group_list;
    struct rw_semaphore       group_lock;
    struct vfio_iommu_driver *iommu_driver;
    void                     *iommu_data; /* driver-private (e.g. vfio_iommu) */
    bool                        noiommu;
};
```

The `vfio_device_ops` structure defines per-device operations (`open_device`/`close_device`, read, write, ioctl for MMIO/interrupt/reset).

## IOMMU type1 backend

The most common IOMMU backend is `vfio_iommu_type1` (`drivers/vfio/vfio_iommu_type1.c`). It handles x86 systems with Intel VT-d or AMD-Vi, and arm64 systems with ARM SMMU.

### DMA mapping: pinning and mapping

When QEMU calls `VFIO_IOMMU_MAP_DMA`, the kernel must:

1. **Pin the host pages** (user virtual address → physical pages, preventing swap).
2. **Map into the IOMMU domain** (IOVA → physical address, so the device can DMA to guest memory).

```c
/* drivers/vfio/vfio_iommu_type1.c (simplified) */
static int vfio_dma_do_map(struct vfio_iommu *iommu,
                            struct vfio_iommu_type1_dma_map *map)
{
    unsigned long vaddr = map->vaddr;
    dma_addr_t iova = map->iova;
    size_t size = map->size;

    /* Pin user pages: HVA → HPA */
    ret = pin_user_pages_remote(current->mm, vaddr,
                                 npage, gup_flags, pages);

    /* Record the mapping in our rb-tree */
    dma = vfio_find_dma(iommu, iova, size);  /* ensure no overlap */
    vfio_link_dma(iommu, new_dma);           /* insert into tree */

    /* Create IOMMU page table entries: IOVA → HPA, across every
     * domain in iommu->domain_list (a container can span more than
     * one IOMMU domain) -- not a single iommu->domain pointer */
    vfio_pin_map_dma(iommu, dma, size);
}
```

The `pin_user_pages_remote()` call (introduced in kernel 5.6 to replace `get_user_pages_remote()` for DMA pinning) increments the page refcount and marks pages as pinned, preventing them from being swapped or moved while the device may be accessing them.

### The DMA map rb-tree

All active DMA mappings are tracked in a red-black tree, keyed and searched for overlap by IOVA (`vfio_find_dma()`) — not a radix tree or the kernel's interval-tree API. This allows the kernel to:
- Detect and reject overlapping `MAP_DMA` requests.
- Enumerate all mappings for cleanup when a group is removed.
- Implement `VFIO_IOMMU_UNMAP_DMA` by looking up and removing entries.

```c
/* struct vfio_iommu tracks mappings */
struct vfio_iommu {
    struct list_head       domain_list; /* one container can span >1 IOMMU domain */
    struct rb_root          dma_list;   /* rb-tree of vfio_dma, overlap-searched by IOVA */
    unsigned int            dma_avail;   /* remaining DMA map limit */
    /* ... */
};

struct vfio_domain {
    struct iommu_domain    *domain;
    struct list_head       next;
    struct list_head       group_list;
};

struct vfio_dma {
    struct rb_node        node;
    dma_addr_t            iova;
    unsigned long         vaddr;
    size_t                size;
    int                   prot;        /* IOMMU_READ | IOMMU_WRITE */
    struct rb_root        pfn_list;    /* pinned pages */
};
```

### IOMMU backend variants

| Backend | Where used | Notes |
|---------|-----------|-------|
| `vfio_iommu_type1` | x86 (VT-d, AMD-Vi), arm64 (SMMU) | Standard; pin_user_pages + iommu_map |
| `vfio_iommu_spapr_tce` | PowerPC (POWER8/9 TCE IOMMU) | TCE (Translation Control Entry) tables |
| `vfio-noiommu` | No IOMMU present | Unsafe; no isolation; requires `enable_unsafe_noiommu_mode=1` |

`vfio-noiommu` exists for development boards and embedded systems without an IOMMU. It provides the VFIO userspace API but offers no isolation — the device can DMA anywhere. It is a compile-time option and prints a warning in dmesg.

## MSI/MSI-X interrupt delivery

One of the most complex parts of VFIO is delivering device interrupts to the VM without userspace round-trips. The full path for MSI delivery:

```
Device raises MSI
    │
    ▼
IOMMU interrupt remapping table (translates MSI address/data → vector)
    │
    ▼
Host CPU vector delivery
    │
    ▼
KVM irqfd: bypasses userspace entirely
    │
    ▼
KVM in-kernel irqchip (APIC emulation)
    │
    ▼
vCPU interrupt injection → guest ISR
```

### vfio_irq_ctx and eventfd

```c
/* drivers/vfio/pci/vfio_pci_intrs.c */
struct vfio_pci_irq_ctx {
    struct eventfd_ctx        *trigger;  /* eventfd for interrupt notification */
    struct virqfd             *unmask;   /* for level-triggered IRQs */
    struct virqfd             *mask;
    char                      *name;
    bool                       masked;
    struct irq_bypass_producer producer;
};
```

When QEMU sets up interrupts via `VFIO_DEVICE_SET_IRQS`, VFIO creates an `eventfd` for each MSI vector. The device's MSI handler calls `eventfd_signal(ctx->trigger)`, which wakes any waiter on the eventfd.

### irqfd: the fast path

The key optimization is `irqfd` — KVM's mechanism for injecting interrupts from an eventfd without returning to userspace:

```c
/* KVM irqfd (virt/kvm/eventfd.c) */
/*
 * QEMU calls KVM_IRQFD ioctl to associate an eventfd with a guest IRQ line.
 * When the eventfd is signaled (by VFIO's MSI handler), the irqfd workqueue
 * fires kvm_set_irq() directly in the host kernel.
 */
```

Flow with irqfd:
1. QEMU configures `KVM_IRQFD` binding eventfd → guest IRQ number.
2. Device MSI fires → host interrupt handler → `eventfd_signal()`.
3. irqfd's wait queue wakes → `kvm_set_irq()` runs → injects interrupt into guest vCPU.

No userspace is involved in steps 2–3. The guest sees its interrupt within microseconds of the device raising MSI.

For legacy INTx interrupts, the path is slower: VFIO uses `irqfd` plus a resample mechanism to handle level-triggered semantics.

## mdev: Mediated Devices

mdev allows a physical device with internal resources (GPU compute engines, NIC queues, crypto engines) to be partitioned into multiple independent virtual devices, each assignable to a different VM.

### Architecture (kernel 5.x)

```c
/* include/linux/mdev.h — current struct shape; the mdev_parent_ops-based
 * design this section otherwise describes predates this and was replaced
 * (see "struct vfio_device_ops" below) */
struct mdev_parent {
    struct device            *dev;         /* physical device (PF) */
    struct mdev_driver       *mdev_driver;
    struct mdev_type        **types;       /* each type is a resource slice */
    unsigned int              nr_types;
    atomic_t                  available_instances;
    /* ... */
};

struct mdev_device {
    struct device             dev;
    guid_t                    uuid;        /* identifies the mdev instance */
    struct mdev_type         *type;        /* reached via type->parent, not a direct field */
    /* ... */
};
```

The physical device driver registers a `mdev_parent` with supported mdev types. Each type describes a resource slice (e.g., "1/4 of the GPU"). Userspace creates instances via sysfs:

```bash
# Create an nvidia vGPU mdev instance on GPU 0000:01:00.0
UUID=$(uuidgen)
echo $UUID > /sys/bus/pci/devices/0000:01:00.0/mdev_supported_types/nvidia-35/create
# nvidia-35 = GRID RTX 6000-1Q (1GB vGPU type)

# The mdev appears as a new device:
ls /sys/bus/mdev/devices/
# $UUID
```

### struct vfio_device_ops (kernel 5.19+)

In Linux 5.19, the older `mdev_parent_ops` interface was consolidated into `struct vfio_device_ops` (commit `6b42f491e17c`, "vfio/mdev: Remove mdev_parent_ops"). Physical device drivers that support mdev now implement `vfio_device_ops` directly:

```c
/* include/linux/vfio.h */
struct vfio_device_ops {
    char *name;

    int  (*init)(struct vfio_device *vdev);
    void (*release)(struct vfio_device *vdev);
    int  (*open_device)(struct vfio_device *vdev);
    void (*close_device)(struct vfio_device *vdev);

    ssize_t (*read)(struct vfio_device *vdev, char __user *buf,
                    size_t count, loff_t *ppos);
    ssize_t (*write)(struct vfio_device *vdev, const char __user *buf,
                     size_t count, loff_t *ppos);
    long    (*ioctl)(struct vfio_device *vdev, unsigned int cmd,
                     unsigned long arg);

    int  (*mmap)(struct vfio_device *vdev, struct vm_area_struct *vma);
    void (*request)(struct vfio_device *vdev, unsigned int count);

    int  (*match)(struct vfio_device *vdev, char *buf);
    void (*dma_unmap)(struct vfio_device *vdev, u64 iova, u64 length);
    /* ... */
};
```

**Intel GVT-g** (Intel integrated GPU virtualization, `drivers/gpu/drm/i915/gvt/`) and **nvidia vGPU** implement their own `vfio_device_ops`. The mdev device appears to QEMU as a standard VFIO device, so no QEMU changes are needed — QEMU just opens `/dev/vfio/<group>` and operates normally.

### mdev isolation model

mdev devices in the same physical function share one IOMMU group (the PF's group). They therefore share one IOMMU domain. The isolation between vGPU instances is enforced by the physical device's own hardware (GPU MMU, NIC queue isolation) — not by separate IOMMU domains. This is weaker than full device passthrough, and the security model depends entirely on the correctness of the PF driver's virtual device implementation.

## Complete VM passthrough: QEMU → KVM flow

```
QEMU process
  ├── opens /dev/vfio/vfio            (container)
  ├── opens /dev/vfio/12              (group)
  ├── VFIO_GROUP_SET_CONTAINER        (attach group to container)
  ├── VFIO_SET_IOMMU (TYPE1_IOMMU)   (activate IOMMU on container)
  ├── opens device fd (VFIO_GROUP_GET_DEVICE_FD)
  ├── VFIO_IOMMU_MAP_DMA              (pin guest RAM, map into IOMMU)
  │       │
  │       ▼ kernel: pin_user_pages() + iommu_map()
  │
  ├── VFIO_DEVICE_GET_REGION_INFO     (discover MMIO/config BAR regions)
  ├── mmap(device fd, BAR0_offset)    (map MMIO BAR directly into QEMU VA)
  │       │
  │       ▼ guest MMIO write → VMExit → KVM → QEMU → write to mmap'd BAR
  │         (or with assigned device: VMExit suppressed, write goes directly)
  │
  ├── VFIO_DEVICE_SET_IRQS            (set up MSI eventfds)
  └── KVM_IRQFD                       (bind eventfds to guest IRQ lines)

Runtime:
  Device DMA:    Device → IOMMU (IOVA → HPA) → host memory → guest sees it
  Device MSI:    Device → IOMMU interrupt remap → host IRQ → irqfd → vCPU
```

### VFIO_IOMMU_MAP_DMA in detail

QEMU maps all guest RAM into the IOMMU domain at guest startup. For a 4 GB guest:

```c
struct vfio_iommu_type1_dma_map dma_map = {
    .argsz = sizeof(dma_map),
    .flags = VFIO_DMA_MAP_FLAG_READ | VFIO_DMA_MAP_FLAG_WRITE,
    .vaddr = (uint64_t)guest_ram_hva,  /* QEMU's VA for guest RAM */
    .iova  = 0x0,                      /* guest physical address base */
    .size  = 0x100000000ULL,           /* 4 GB */
};
ioctl(container, VFIO_IOMMU_MAP_DMA, &dma_map);
```

The kernel walks all 4 GB of QEMU's VA range, pins the pages, and creates IOMMU page table entries mapping IOVA 0..4GB → host physical pages. After this, the assigned device can DMA to guest physical addresses directly — the IOMMU translates them to the correct host pages.

## Security model

The IOMMU group is the security boundary. Devices in the same group share an IOMMU domain — they can DMA to each other without IOMMU enforcement. VFIO enforces:

1. **Whole-group assignment**: you cannot assign device A from a group to VM1 and device B from the same group to VM2. The entire group must go to one VM (or stay in the host).
2. **No cross-group DMA**: IOMMU page tables ensure the device can only reach memory explicitly mapped via `VFIO_IOMMU_MAP_DMA`. A compromised device cannot reach host kernel memory or other VMs' memory.
3. **Interrupt remapping required**: On Intel, VT-d interrupt remapping must be active (check `dmesg | grep "Enabled IRQ remapping"`). Without interrupt remapping, a device can inject arbitrary interrupts, bypassing the security model.

```bash
# Verify IOMMU is enforcing isolation (not passthrough mode)
dmesg | grep -i "iommu"
# DMAR: IOMMU enabled  ← translation active
# (NOT: iommu=pt ← passthrough mode, no isolation)

# Check interrupt remapping
dmesg | grep -i "remapping"
# DMAR-IR: Enabled IRQ remapping in x2apic mode

# List devices in a group before passthrough
ls /sys/kernel/iommu_groups/12/devices/
# If more than one device: both must be passed through together
```

## Observing VFIO

```bash
# VFIO devices and groups
ls /sys/bus/pci/drivers/vfio-pci/

# Active VFIO containers/groups (requires root)
ls /dev/vfio/

# DMAR faults during passthrough (device DMA'd to unmapped address)
dmesg | grep DMAR

# VFIO tracing (generic x86/arm64)
echo 1 > /sys/kernel/tracing/events/vfio/enable
echo 1 > /sys/kernel/tracing/events/iommu/enable
# Note: events/vfio_ap/ tracepoints are s390 (IBM Z) only — for AP
# (Adjunct Processor) crypto devices. Do not use on x86 or arm64.

# MSI eventfd: see how often interrupts fire
# (via /proc/interrupts or perf stat)
grep vfio /proc/interrupts
```

## Source files

| File | Role |
|------|------|
| `drivers/vfio/vfio_main.c` | Container/group/device lifecycle, ioctls |
| `drivers/vfio/vfio_iommu_type1.c` | IOMMU backend: pin_user_pages, iommu_map, DMA map tree |
| `drivers/vfio/pci/vfio_pci_core.c` | PCI device ops: MMIO mmap, config space, interrupts |
| `drivers/vfio/pci/vfio_pci_intrs.c` | MSI/MSI-X/INTx eventfd setup, irqfd integration |
| `drivers/vfio/mdev/` | Mediated device bus and sysfs interface |
| `virt/kvm/eventfd.c` | `irqfd` — eventfd → vCPU interrupt injection |
| `include/linux/vfio.h` | All VFIO struct and ioctl definitions |
| `include/uapi/linux/vfio.h` | Userspace-visible ioctl API |

## Further reading

### Kernel source

- [drivers/vfio/vfio_main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/vfio/vfio_main.c) — `vfio_register_group_dev()` and core device/group/container lifecycle
- [drivers/vfio/vfio.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/vfio/vfio.h) — `struct vfio_group` (private to the VFIO core, not `include/linux/vfio.h`)
- [drivers/vfio/container.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/vfio/container.c) — `struct vfio_container` and the `VFIO_SET_IOMMU`/group-attach path
- [drivers/vfio/vfio_iommu_type1.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/vfio/vfio_iommu_type1.c) — `vfio_dma_do_map()`, `struct vfio_iommu`, `struct vfio_dma`: the type1 IOMMU backend
- [include/linux/vfio.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/vfio.h) — `struct vfio_device` and `struct vfio_device_ops`, the public bus-driver API
- [drivers/vfio/pci/vfio_pci_intrs.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/vfio/pci/vfio_pci_intrs.c) — `struct vfio_pci_irq_ctx`: MSI/MSI-X/INTx eventfd setup
- [drivers/vfio/mdev/mdev_core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/vfio/mdev/mdev_core.c) — `mdev_register_parent()` and the mediated-device bus core
- [virt/kvm/eventfd.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/virt/kvm/eventfd.c) — `irqfd`: a workqueue calls `kvm_set_irq()` when the bound eventfd fires

### Man pages

- [`ioctl(2)`](https://man7.org/linux/man-pages/man2/ioctl.2.html) — every VFIO container/group/device operation (`VFIO_SET_IOMMU`, `VFIO_IOMMU_MAP_DMA`, `VFIO_DEVICE_SET_IRQS`, …) is an ioctl on a `/dev/vfio` file descriptor

### Related pages

- [IOMMU Architecture](iommu-arch.md) — IOMMU domains, groups, SR-IOV
- [IOVA Allocator](iova-allocator.md) — the in-kernel IOVA allocator used by `dma_map_*()`; VFIO's type1 backend bypasses it, since userspace supplies the IOVA directly in `VFIO_IOMMU_MAP_DMA`
- [IOMMU War Stories](war-stories.md) — group isolation blocking passthrough (real incident)
- [VFIO: Virtual Function I/O and Device Passthrough](../virtualization/vfio.md) — the same subsystem from a setup/operations angle: QEMU passthrough, SR-IOV, mdev walkthrough
- [Getting User Pages (GUP)](../mm/gup.md) — `pin_user_pages_remote()`, the page-pinning primitive behind VFIO's DMA mapping path

### LWN articles

- [Safe device assignment with VFIO](https://lwn.net/Articles/474088/) — Jonathan Corbet's original coverage of the VFIO framework and IOMMU-group-based device assignment (January 3, 2012)

### External

- [VFIO — "Virtual Function I/O"](https://docs.kernel.org/driver-api/vfio.html) — official kernel documentation for the container/group/device model and userspace API
- [VFIO Mediated devices](https://docs.kernel.org/driver-api/vfio-mediated-device.html) — official documentation for the mdev framework
