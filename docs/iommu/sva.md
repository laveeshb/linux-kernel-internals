# Shared Virtual Addressing

> PASID-based SVA for accelerators and smart NICs

## The problem SVA solves

In classic IOMMU DMA, a device operates in its own I/O virtual address space (IOVA space). When a driver wants a device to access a user-space buffer, the kernel must:

1. Pin the user pages.
2. Allocate an IOVA range.
3. Create IOMMU mappings for those pages.
4. Give the IOVA to the device.
5. After the operation: unmap, unpin, free the IOVA.

For an accelerator that processes many small user-space operations (Intel DSA scatter-gather, GPU compute kernels, SmartNIC offloads), this per-operation pinning and mapping is expensive. It also requires the kernel or a privileged driver to mediate every access.

**Shared Virtual Addressing (SVA)** lets a device share the same virtual address space as a user process. The device can directly use the process's virtual addresses — no IOVA translation layer, no pinning at submission time. The IOMMU enforces isolation by keying every device transaction with a **PASID** that identifies which process's page tables to use.

## PASID: Process Address Space ID

PASID is a 20-bit PCIe TLP prefix field defined in the PCIe specification. When a device issues a DMA read or write, it can tag the transaction with a PASID value. The IOMMU uses this tag to select the correct page table for address translation:

```
Device DMA request:
  [PASID=42] [virtual address 0x7fff1000] [read 4096 bytes]
                        │
                        ▼
              IOMMU PASID table (indexed by PASID)
                        │
                        ▼
              Process 42's page tables (cr3 equivalent)
                        │
                        ▼
              Physical address → memory access
```

Without SVA, all device transactions for a given IOMMU domain use a single page table (the domain's IOVA space). With SVA, each PASID maps to one process's page tables. The IOMMU hardware maintains a PASID table alongside the device's context entry.

PASID values 0 through 2^20−1 (just over one million) are available. In practice, the kernel allocates PASIDs from a global ID space using `iommu_alloc_global_pasid()` (drivers/iommu/iommu.c, kernel 6.1+).

## PCIe capability requirements

SVA depends on three PCIe capabilities working together:

### ATS (Address Translation Services)

ATS allows a device to cache IOVA-to-physical translations in a device-side TLB (the ATC — Address Translation Cache). Under SVA the device sends translation requests upstream; the IOMMU responds with the physical address, which the device caches for future accesses to the same virtual page.

ATS is optional. Without it, every device memory access generates a full IOMMU page walk. With ATS, the device's ATC absorbs most lookups.

```bash
# Check if a device supports ATS
lspci -vvv -s 0000:01:00.0 | grep "Address Translation"
# Capabilities: [100] Address Translation Service (ATS)
#   ATSCap: Invalidate Queue Depth: 32
#   ATSCtl: Enable+, Smallest Translation Unit: 0
```

### PRI (Page Request Interface)

Without SVA, the kernel pre-faults all pages before submitting work to a device. With SVA, the device can encounter a page fault (page not present, swapped out, or not yet faulted in) mid-transaction. PRI allows the device to send a **Page Request** upstream, asking the IOMMU/CPU to resolve the fault and signal when the page is ready.

The IOMMU delivers the page request to the kernel's IOMMU page fault handler. The kernel handles it like a CPU page fault: allocates or brings in the page, updates the page tables, and sends a **Page Request Response** back to the device to resume.

PRI requires ATS. Not all hardware supports PRI; on hardware without PRI, SVA can still work if the driver pre-faults all pages before submission (removing the benefit of on-demand paging).

### ACS (Access Control Services)

ACS prevents PCIe peer-to-peer transactions from bypassing the IOMMU. Without ACS, a device could DMA to another device's memory without going through the IOMMU, defeating isolation. ACS is a prerequisite for IOMMU group isolation, which is itself a prerequisite for SVA safety.

```bash
# Check ACS capability
lspci -vvv -s 0000:00:1c.0 | grep "Access Control"
# Capabilities: [148] Access Control Services
#   ACSCap: SrcValid+ TransBlk+ ReqRedir+ CmpltRedir+ UpstreamFwd- EgressCtrl- DirectTrans-
#   ACSCtl: SrcValid+ TransBlk+ ReqRedir+ CmpltRedir+ UpstreamFwd- EgressCtrl- DirectTrans-
```

## io_pgtable_ops: the page table abstraction

Different IOMMU hardware uses different page table formats. Intel VT-d uses its own multi-level page tables; AMD-Vi uses a different format; ARM SMMU v3 supports both its native format and the ARM64 CPU page table format (which is what makes SVA efficient on ARM — the device literally walks the same tables as the CPU).

The kernel abstracts this behind `struct io_pgtable_ops`:

```c
/* include/linux/io-pgtable.h */
struct io_pgtable_ops {
    int (*map_pages)(struct io_pgtable_ops *ops,
                     unsigned long iova, phys_addr_t paddr,
                     size_t pgsize, size_t pgcount,
                     int prot, gfp_t gfp, size_t *mapped);

    size_t (*unmap_pages)(struct io_pgtable_ops *ops,
                          unsigned long iova,
                          size_t pgsize, size_t pgcount,
                          struct iommu_iotlb_gather *gather);

    phys_addr_t (*iova_to_phys)(struct io_pgtable_ops *ops,
                                 unsigned long iova);
};
```

For SVA, `io_pgtable_ops` maps to the process page tables directly. The ARM SMMU v3 implementation (`drivers/iommu/arm/arm-smmu-v3/`) can configure a stream entry to use the ARM64 page table format. However, the stream table entry does not point directly to the process's `pgd` — ARM SMMUv3 uses a Context Descriptor (CD) table as an indirection layer: the stream table entry points to the CD table, and each CD entry (indexed by PASID) holds the TTBR equivalent that points to the process's `pgd`. Intel's implementation (`drivers/iommu/intel/svm.c`) creates a PASID entry in the DMAR PASID table using first-level page tables (FLPTR in scalable mode); SVA always uses first-level page tables with the process `pgd` — the IOMMU does not use CR3 directly.

## The Linux SVA API (kernel 5.14+)

The `iommu_sva` API, stabilized in Linux 5.14, provides three operations:

```c
/* include/linux/iommu.h */

/*
 * Bind a device to the current process's address space.
 * Returns a handle representing the binding; the caller gets a PASID
 * via iommu_sva_get_pasid().
 *
 * The device must support SVA (IOMMU driver checks capabilities).
 * The calling process's mm_struct is pinned for the lifetime of the handle.
 */
struct iommu_sva *iommu_sva_bind_device(struct device *dev,
                                         struct mm_struct *mm);

/*
 * Release a binding. After this call, the device must no longer issue
 * DMA transactions with the associated PASID.
 */
void iommu_sva_unbind_device(struct iommu_sva *handle);

/*
 * Retrieve the PASID assigned to this binding.
 * The driver programs this value into the device so it can tag transactions.
 */
u32 iommu_sva_get_pasid(struct iommu_sva *handle);
```

### Typical driver flow

```c
/* In a character device's open or ioctl handler */
struct iommu_sva *sva_handle;
u32 pasid;

/* Bind: associates current->mm with the device */
sva_handle = iommu_sva_bind_device(dev->device, current->mm);
if (IS_ERR(sva_handle)) {
    ret = PTR_ERR(sva_handle);
    goto err;
}

/* Get the PASID to program into hardware */
pasid = iommu_sva_get_pasid(sva_handle);

/* Write PASID into device registers so it tags DMA with this value */
writel(pasid, dev->bar + DEV_PASID_REG);

/* Userspace can now submit work using virtual addresses directly */
/* The device will walk the process page tables via the IOMMU */

/* On close/cleanup */
iommu_sva_unbind_device(sva_handle);
```

## mm_struct to PASID table: the kernel flow

When `iommu_sva_bind_device()` is called:

1. **PASID allocation**: `iommu_alloc_global_pasid()` reserves a PASID from the global ID space.
2. **PASID table entry**: The IOMMU driver writes the process's page table root into the PASID table at index PASID. On Intel, `intel_svm_set_dev_pasid()` calls `intel_pasid_setup_first_level()`, which programs the DMAR PASID table entry with the process's CR3 (Intel SVA always uses first-level page tables). On ARM SMMU v3, `arm_smmu_sva_set_dev_pasid()` programs a CD (Context Descriptor) entry.
3. **mm notifier**: The kernel registers an `mmu_notifier` callback on the process's `mm_struct`. When the process's page tables change (page unmapped, THP split, process exit), the notifier fires and triggers an IOTLB invalidation for all devices sharing this PASID. This is what keeps the device's ATC coherent with the CPU page tables.
4. **Handle returned**: The `struct iommu_sva` wraps the PASID and the mm reference.

```
mm_struct
  ├── pgd (page table root)
  └── mmu_notifier_mm
        └── iommu_sva_notifier ──► triggers ATC invalidation on page table changes
                                     │
                                     ▼
                               iommu_sva_handle
                                 ├── pasid = 42
                                 └── iommu_domain (PASID entry points here)
```

## Use cases

### Intel DSA (Data Streaming Accelerator)

DSA (available on Intel Sapphire Rapids and later) performs memory copy, fill, CRC, and compare operations. With SVA, a user-space library (Intel's `idxd` userspace driver, used by DPDK and SPDK) can submit descriptors containing virtual addresses. DSA reads from and writes to user virtual addresses without the kernel needing to pin or map anything:

```c
/* DSA descriptor with SVA (userspace PASID flow) */
struct dsa_hw_desc desc = {
    .opcode     = DSA_OPCODE_MEMMOVE,
    .src_addr   = (uint64_t)src_vaddr,  /* process virtual address */
    .dst_addr   = (uint64_t)dst_vaddr,  /* process virtual address */
    .xfer_size  = len,
    .flags      = IDXD_OP_FLAG_CRAV | IDXD_OP_FLAG_RCR,
};
/* Submitted to DSA work queue; device uses PASID to resolve addresses */
```

### ARM SMMU v3 with SVA

ARM SMMUv3 with SVA support (`CONFIG_ARM_SMMU_V3_SVA`) can share ARM64 page tables directly with the SMMU. Because the SMMU natively speaks the ARM64 page table format, setting up SVA is setting a pointer in the Stream Table — no format translation needed.

### GPU compute (ROCm/CUDA)

GPU compute workloads (ROCm on AMD GPUs, some CUDA configurations) benefit from SVA for unified memory: the GPU and CPU share a virtual address space, with the IOMMU enforcing access control per-process. Page faults on the GPU side are handled by the kernel's IOMMU fault handler, which brings in the page and signals the GPU to retry.

## Limitations

- **Hardware support required**: SVA needs IOMMU hardware with PASID table support (Intel VT-d with PASID capability, AMD-Vi with PASID support, ARM SMMUv3 with CD tables).
- **PRI is optional but important**: Without PRI, all pages must be pre-faulted before device submission — eliminating on-demand paging but still allowing virtual address reuse.
- **ACS required for isolation**: PCIe topology must support ACS on all bridges between the device and the root complex, or IOMMU group isolation is unsound.
- **PASID table size limits**: 20-bit PASID means at most 1M concurrent bindings per IOMMU. In practice, IOMMU hardware may support fewer (check `ecap` register bits on Intel, or SMMU IDR1 on ARM).
- **Process lifetime**: If the process exits while a device binding is active, the `mmu_notifier` exit callback fires. The kernel tears down the PASID table entry and stops accepting transactions for that PASID. The device driver must handle this gracefully (DMA errors on pending transactions).

```bash
# Check Intel IOMMU PASID support
dmesg | grep -i pasid
# DMAR: PASID supported

# ARM SMMU SVA support
dmesg | grep -i sva
# arm-smmu-v3: SVA support enabled

# Check kernel SVA config
grep CONFIG_IOMMU_SVA /boot/config-$(uname -r)
# CONFIG_IOMMU_SVA=y
```

## Source files

| File | Role |
|------|------|
| `drivers/iommu/iommu-sva.c` | `iommu_sva_bind_device()`, mm notifier, PASID lifecycle |
| `drivers/iommu/intel/svm.c` | Intel VT-d SVA: PASID table programming, PRI handling |
| `drivers/iommu/arm/arm-smmu-v3/arm-smmu-v3-sva.c` | ARM SMMUv3 SVA: CD table, s1 page table sharing |
| `drivers/iommu/ioasid.c` | PASID allocation (`ioasid_alloc()`, `ioasid_free()`) — existed in 5.11–6.0; removed in 6.1 when PASID allocation was folded into the iommu core (`drivers/iommu/iommu.c`) |
| `include/linux/iommu.h` | `iommu_sva`, `iommu_sva_bind_device()` declarations |
| `include/linux/io-pgtable.h` | `io_pgtable_ops` abstraction |

## Further reading

- [IOMMU Architecture](iommu-arch.md) — IOMMU domains, IOTLB, hardware overview
- [VFIO Internals](vfio-internals.md) — device passthrough (different isolation model)
- [IOMMU War Stories](war-stories.md) — SVA page fault storm incident
- `Documentation/iommu/iommu-sva.rst` — kernel SVA documentation
- PCIe Base Specification §10 (ATS), §10.4 (PRI)
