# IOMMU and DMA

> Hardware address translation and memory protection for devices

## Why IOMMU?

Without an IOMMU, a DMA-capable device can access any physical memory — a compromised network card can read or overwrite kernel memory. The IOMMU sits between the PCIe bus and physical memory, translating device I/O virtual addresses (IOVAs) to physical addresses and enforcing access permissions.

```
Without IOMMU:
  Device → physical memory (unrestricted)

With IOMMU:
  Device → IOVA → IOMMU translation → physical memory
                  (checked against per-domain page tables)
```

Beyond security, the IOMMU enables:
- **IOVA remapping**: devices with < 64-bit address buses can DMA to high memory
- **Scatter-gather flattening**: discontiguous physical pages appear contiguous to the device
- **Device passthrough (VFIO)**: safely assign physical devices to VMs

## Pages in this section

| Page | What it covers |
|------|----------------|
| [IOMMU Architecture](iommu-arch.md) | Intel VT-d, AMD-Vi, iommu_domain, IOMMU groups, VFIO |
| [DMA API](dma-api.md) | dma_alloc_coherent, dma_map_single/sg, swiotlb, IOVA allocation |
| [IOVA Allocator](iova-allocator.md) | iova_domain, rbtree, per-CPU rcache magazines, flush queues |
| [Shared Virtual Addressing](sva.md) | PASID, ATS, PRI, iommu_sva API, Intel DSA, ARM SMMU v3 |
| [VFIO Internals](vfio-internals.md) | Container/group/device hierarchy, mdev, MSI irqfd, KVM passthrough |
| [IOMMU War Stories](war-stories.md) | DMAR faults, IOVA perf bottleneck, group isolation, swiotlb exhaustion |

## Reading order

New to IOMMU internals? Work through the pages in this order:

1. **[README](README.md)** — this page; why IOMMU exists, quick reference
2. **[IOMMU Architecture](iommu-arch.md)** — hardware (VT-d, AMD-Vi, ARM SMMU), the kernel abstraction (`iommu_domain`, groups), IOTLB
3. **[DMA API](dma-api.md)** — how drivers actually use DMA: coherent, streaming, scatter-gather, swiotlb
4. **[IOVA Allocator](iova-allocator.md)** — the address allocator underneath DMA mapping; rcache and flush queue internals; performance impact
5. **[Shared Virtual Addressing](sva.md)** — advanced: PASID-based VA sharing for accelerators; requires understanding of IOMMU domains
6. **[VFIO Internals](vfio-internals.md)** — device passthrough architecture; page pinning, interrupt delivery, mdev
7. **[IOMMU War Stories](war-stories.md)** — real incidents tying all the above together; good for consolidating understanding

## Quick reference

```bash
# Check if IOMMU is active
dmesg | grep -i iommu | head -20
# DMAR: IOMMU enabled
# AMD-Vi: device isolation enabled

# List IOMMU groups (devices that share address space)
ls /sys/kernel/iommu_groups/
for g in /sys/kernel/iommu_groups/*/devices/*; do echo "$g"; done

# Enable IOMMU at boot (kernel parameter)
# Intel: intel_iommu=on
# AMD:   amd_iommu=on
# Both:  iommu=pt (passthrough — no translation, just groups)

# VFIO: bind a device for VM passthrough
echo "8086 1521" | sudo tee /sys/bus/pci/drivers/vfio-pci/new_id
echo "0000:01:00.0" | sudo tee /sys/bus/pci/devices/0000:01:00.0/driver/unbind
echo "0000:01:00.0" | sudo tee /sys/bus/pci/drivers/vfio-pci/bind
```
