# HMM: Heterogeneous Memory Management

> Sharing virtual address spaces between CPU and GPU — struct page for device memory

## The problem

Modern systems have GPUs and other accelerators with their own memory (VRAM). Applications want to use a single virtual address space across CPU and GPU:

```
Traditional (two address spaces):
  CPU:  malloc → virtual addr 0x7f000000
  GPU:  cudaMalloc → device addr 0xc000000000
  Programmer: explicit copies between the two

With HMM (unified virtual address space):
  CPU:  mmap → virtual addr 0x7f000000
  GPU:  same virtual addr 0x7f000000 (GPU MMU maps same pages)
  Programmer: writes to address, GPU reads from same address
  Kernel: tracks ownership and handles faults on both sides
```

## HMM components

```
Application virtual address space
         │
    ┌────┴────────────────────────────────┐
    │         CPU page tables (MMU)        │
    │         GPU page tables (IOMMU)      │
    └────┬────────────────────────────────┘
         │
    ┌────┴───────────────────────┐
    │        HMM layer           │
    │  - mirror (CPU↔GPU sync)   │
    │  - range (snapshot VA)     │
    │  - device memory (VRAM)    │
    └────┬──────────────────────┘
         │
    ┌────┴───────────────────────────────────────────┐
    │  Physical memory:                              │
    │  DRAM (system RAM)    VRAM (GPU memory)        │
    │  struct page          struct page (ZONE_DEVICE) │
    └────────────────────────────────────────────────┘
```

## struct page for device memory

HMM extends `struct page` to represent GPU/device memory through `ZONE_DEVICE`:

```c
/* mm/memremap.c */

/* Device memory types: */
enum memory_type {
    MEMORY_DEVICE_PRIVATE,     /* GPU private memory, not CPU-accessible */
    MEMORY_DEVICE_COHERENT,    /* CPU-accessible device memory (CXL, etc.) */
    MEMORY_DEVICE_FS_DAX,      /* DAX filesystems */
    MEMORY_DEVICE_GENERIC,     /* generic device memory */
    MEMORY_DEVICE_PCI_P2PDMA,  /* P2P DMA between PCIe devices */
};

/* Register device memory as ZONE_DEVICE pages: */
struct dev_pagemap pgmap = {
    .type  = MEMORY_DEVICE_PRIVATE,
    .range = {
        .start = phys_base,
        .end   = phys_base + size - 1,
    },
    .ops = &my_device_pagemap_ops,
};
devm_memremap_pages(dev, &pgmap);
/* Now: pfn_to_page(pfn) works for device memory pages */
```

## HMM mirror: synchronizing CPU and GPU page tables

The **HMM mirror** allows a device driver to receive notifications when the CPU page table changes, so it can update the GPU page table accordingly:

```c
/* include/linux/hmm.h */

/* A driver creates one mirror per process/GPU context: */
struct hmm_mirror {
    struct mm_struct        *mm;
    const struct hmm_mirror_ops *ops;
    struct list_head         list;       /* in mm->hmm->mirrors */
};

/* Callbacks the driver implements: */
const struct hmm_mirror_ops my_gpu_mirror_ops = {
    /* CPU page table changed for a range — update GPU page table */
    .sync_cpu_device_pagetables = my_gpu_update_pagetable,
};

/* Register the mirror: */
hmm_mirror_register(&mirror, mm);
```

### mmu_interval_notifier: lighter alternative (Linux 5.10+)

```c
/* Preferred modern API: no full mirror, just range notifications */
struct mmu_interval_notifier notifier;

static const struct mmu_interval_notifier_ops gpu_mni_ops = {
    .invalidate = gpu_invalidate_range,
};

/* Register: notified when [start, end) VA range changes */
mmu_interval_notifier_insert(&notifier, mm, start, length, &gpu_mni_ops);

static bool gpu_invalidate_range(struct mmu_interval_notifier *mni,
                                  const struct mmu_notifier_invalidate_range_start_t *range,
                                  unsigned long cur_seq)
{
    /* GPU must stop accessing this range */
    gpu_unmap_range(mni->start, mni->length);
    mmu_interval_set_seq(mni, cur_seq);
    return true;
}
```

## HMM range snapshot

A driver uses `hmm_range_fault()` to snapshot the current CPU page table state for a range, getting the physical addresses (PFNs) the GPU should map:

```c
/* arch/x86/kernel/gpu_driver.c (simplified) */

#define HMM_PFN_VALID   (1UL << 0)
#define HMM_PFN_WRITE   (1UL << 1)
#define HMM_PFN_DEVICE  (1UL << 2)

static int gpu_fault_and_map(struct mm_struct *mm, unsigned long addr,
                              unsigned long len)
{
    unsigned long pfns[len / PAGE_SIZE];
    struct hmm_range range = {
        .notifier     = &notifier,
        .notifier_seq = mmu_interval_read_begin(&notifier),
        .start        = addr,
        .end          = addr + len,
        .pfns         = pfns,
        .flags        = HMM_PFN_VALID | HMM_PFN_WRITE,
        .values       = hmm_range_values,  /* driver fills this */
        .default_flags = HMM_PFN_VALID,
        .pfn_flags_mask = HMM_PFN_WRITE,
    };

    int ret;
retry:
    ret = hmm_range_fault(&range);
    if (ret == -EBUSY) {
        /* Page table changed while we were snapshotting — retry */
        range.notifier_seq = mmu_interval_read_begin(&notifier);
        goto retry;
    }
    if (ret)
        return ret;

    /* Now pfns[] contains the host PFNs for each page in [addr, addr+len) */
    /* pfns[i] has HMM_PFN_VALID set if page is present */
    /* pfns[i] has HMM_PFN_WRITE set if writeable */

    /* Program GPU page table to use these physical addresses */
    for (int i = 0; i < len / PAGE_SIZE; i++) {
        if (!(pfns[i] & HMM_PFN_VALID))
            continue;
        phys_addr_t phys = PFN_PHYS(pfns[i] >> HMM_PFN_SHIFT);
        gpu_map_page(addr + i * PAGE_SIZE, phys, pfns[i] & HMM_PFN_WRITE);
    }
    return 0;
}
```

## Device-private memory migration

For GPUs with private VRAM (not CPU-addressable), pages are migrated between system RAM and VRAM on demand:

```
GPU accesses CPU page:
  GPU page fault → driver's fault handler
  → migrate_vma_setup() + migrate_vma_pages()
  → pages move from DRAM to VRAM
  → GPU page table updated with VRAM physical address

CPU accesses GPU page:
  CPU page fault (page has ZONE_DEVICE private struct page)
  → driver's migrate_to_ram callback
  → pages move from VRAM to DRAM
  → CPU page table updated with DRAM physical address
```

```c
/* Driver implements: */
static const struct dev_pagemap_ops my_pgmap_ops = {
    /* Called when CPU tries to access device-private page */
    .migrate_to_ram = my_gpu_migrate_to_ram,

    /* Called when device-private page reference count drops to 0 */
    .page_free = my_gpu_page_free,
};

static vm_fault_t my_gpu_migrate_to_ram(struct vm_fault *vmf)
{
    /* Migrate the GPU page back to system RAM */
    struct migrate_vma args = {
        .vma        = vmf->vma,
        .start      = vmf->address & PAGE_MASK,
        .end        = (vmf->address & PAGE_MASK) + PAGE_SIZE,
        .src        = src_pfns,
        .dst        = dst_pfns,
        .pgmap_owner = my_gpu_device,
        .flags      = MIGRATE_VMA_SELECT_DEVICE_PRIVATE,
    };

    migrate_vma_setup(&args);
    /* args.src now has PFNs of GPU pages to migrate */

    /* Allocate system RAM pages, copy GPU memory to them */
    for_each_migrate_pfn(args.src, args.dst, i) {
        struct page *dpage = alloc_page(GFP_HIGHUSER_MOVABLE);
        gpu_copy_to_ram(args.src[i], dpage);
        args.dst[i] = migrate_pfn(page_to_pfn(dpage));
    }

    migrate_vma_pages(&args);    /* install RAM pages in CPU PTE */
    migrate_vma_finalize(&args); /* release GPU pages */
    return 0;
}
```

## SVM (Shared Virtual Memory) in practice

CUDA and ROCm implement SVM using HMM:

```c
/* CUDA managed memory: */
cudaMallocManaged(&ptr, size, cudaMemAttachGlobal);
/* ptr is a CPU VA backed by HMM */
/* Access from CPU → normal page fault, kernel allocates DRAM */
/* Access from GPU → GPU fault, driver calls hmm_range_fault() */
/*                   or migrates to VRAM */

/* cudaMemPrefetchAsync: hint to migrate pages before needed */
cudaMemPrefetchAsync(ptr, size, cudaCpuDeviceId);  /* prefetch to CPU */
cudaMemPrefetchAsync(ptr, size, 0);                /* prefetch to GPU 0 */
```

## Observing HMM

```bash
# Check if kernel has HMM support:
zcat /proc/config.gz | grep -E "HMM|ZONE_DEVICE|DEVICE_PRIVATE"
# CONFIG_HMM_MIRROR=y
# CONFIG_ZONE_DEVICE=y
# CONFIG_DEVICE_PRIVATE=y

# ZONE_DEVICE memory stats:
cat /proc/zoneinfo | grep -A20 "Device"

# nvidia-smi shows unified memory stats:
nvidia-smi --query-gpu=memory.used,memory.free --format=csv

# Trace HMM range faults:
bpftrace -e '
kprobe:hmm_range_fault {
    printf("hmm_range_fault: pid=%d addr=%lx\n", pid, ((struct hmm_range *)arg0)->start);
}'

# NUMA-aware: HMM migrates pages to GPU memory (different NUMA node)
numastat -p <cuda_process>
```

## Further reading

- [Memory Tiering](memory-tiering.md) — CXL and NUMA memory tiers
- [IOMMU](../iommu/iommu-arch.md) — IOMMU for GPU DMA
- [VFIO](../virtualization/vfio.md) — device passthrough using IOMMU
- [DMA API](../iommu/dma-api.md) — DMA mapping fundamentals
- [Page Allocator](page-allocator.md) — ZONE_DEVICE integration
- `mm/hmm.c` — HMM core implementation
- `mm/migrate_device.c` — device memory migration
- `Documentation/mm/hmm.rst` — kernel HMM documentation
