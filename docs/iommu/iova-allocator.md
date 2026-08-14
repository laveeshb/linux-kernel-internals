# IOVA Allocator

> How the kernel manages I/O virtual address space

## What is IOVA space?

Every device attached to an IOMMU domain has its own I/O virtual address space. When a driver calls `dma_map_single()` or `dma_map_sg()`, the DMA-IOMMU layer must carve out a range of I/O virtual addresses (IOVAs), create a mapping in the IOMMU page tables for that range, and return the IOVA to the driver. When the transfer completes and the driver unmaps, those addresses must be returned to the pool.

At high packet or I/O rates this allocation and free cycle is on the fast path. A 25 Gbps NIC receiving small packets can issue millions of DMA maps per second. The IOVA allocator is therefore a significant source of CPU overhead — it shows up in `perf top` profiles for network and NVMe workloads.

The allocator lives in `drivers/iommu/iova.c`, with types declared in `include/linux/iova.h`.

## Core data structures

### struct iova_domain

```c
/* include/linux/iova.h */
struct iova_domain {
    spinlock_t      iova_rbtree_lock; /* serialize rbtree access */
    struct rb_root  rbroot;           /* rbtree of allocated IOVAs */
    struct rb_node *cached_node;      /* last free() position hint */
    struct rb_node *cached32_node;    /* cached node for < 4GB range */
    unsigned long   granule;          /* allocation granularity (page size) */
    unsigned long   start_pfn;        /* lowest allocatable IOVA PFN */
    unsigned long   dma_32bit_pfn;    /* highest IOVA PFN < 4GB */
    unsigned long   max32_alloc_size; /* max single alloc below 4GB */
    struct iova      anchor;          /* sentinel node in rbtree */
    struct iova_rcache *rcaches; /* dynamically allocated in iova_domain_init_rcaches() */
    struct hlist_node cpuhp_dead;     /* CPU-hotplug teardown of rcache state */
};
```

The domain covers the entire IOVA address space available to a group of devices. The `granule` is typically 4 KB (one page), meaning IOVAs are allocated in page-sized units. The rbtree tracks allocated ranges so the allocator can find holes.

### struct iova

```c
/* include/linux/iova.h */
struct iova {
    struct rb_node  node;
    unsigned long   pfn_hi;   /* last PFN of this allocation (inclusive) */
    unsigned long   pfn_lo;   /* first PFN of this allocation */
};
```

Each allocated range is represented as a `struct iova` embedded in the rbtree. `pfn_lo` and `pfn_hi` are IOVA PFNs (IOVA >> PAGE_SHIFT).

## Allocation and free call paths

### alloc_iova()

```c
/* drivers/iommu/iova.c */
struct iova *alloc_iova(struct iova_domain *iovad,
                        unsigned long size,      /* in page frames */
                        unsigned long limit_pfn, /* upper bound */
                        bool size_aligned);
```

The function searches the rbtree from `limit_pfn` downward (allocating top-down to keep low addresses available for 32-bit devices). It walks the cached hint first; if that misses, it falls back to a full rbtree traversal to find a free gap.

The allocation is top-down for an important reason: keeping low IOVA space (below 4 GB) free for 32-bit legacy devices that arrive later. 64-bit-capable devices fill from the top; 32-bit-limited devices fill from `dma_32bit_pfn` downward.

### free_iova()

```c
/* drivers/iommu/iova.c */
void free_iova(struct iova_domain *iovad, unsigned long pfn);
```

Removes the node from the rbtree and updates the cached hint. With the spinlock, this is serialized — at high rate, this becomes a bottleneck. The per-CPU rcache exists to avoid this path entirely for common sizes.

### The DMA-IOMMU wrapper

In practice, drivers don't call `alloc_iova()` directly. The DMA-IOMMU layer calls `iommu_dma_alloc_iova()`, which first checks the per-CPU rcache and falls back to `alloc_iova()` only on a cache miss:

```c
/* drivers/iommu/dma-iommu.c (simplified) */
static dma_addr_t iommu_dma_alloc_iova(struct iommu_domain *domain,
                                        size_t size,
                                        u64 dma_limit,
                                        struct device *dev)
{
    struct iommu_dma_cookie *cookie = domain->iova_cookie;
    struct iova_domain *iovad = &cookie->iovad;
    unsigned long shift = iova_shift(iovad);
    unsigned long iova_len = size >> shift;

    /* Fast path: per-CPU rcache (falls back to alloc_iova() on miss) */
    return alloc_iova_fast(iovad, iova_len, dma_limit >> shift, true);
}
```

## Per-CPU IOVA caches (rcache)

The magazine-style per-CPU cache is the key to keeping IOVA allocation off the rbtree lock on the fast path.

### struct iova_rcache and struct iova_cpu_rcache

```c
/* drivers/iommu/iova.c — these are all internal to iova.c, not exposed
 * in include/linux/iova.h, which only forward-declares struct iova_rcache */

/* 127 chosen so sizeof(struct iova_magazine) = exactly 1024 bytes
 * (127 × 8 + 8 = 1024), avoiding kmalloc internal fragmentation. */
#define IOVA_MAG_SIZE 127

struct iova_magazine {
    union {
        unsigned long size;         /* fill count when in use */
        struct iova_magazine *next; /* free-list link when in depot */
    };
    unsigned long  pfns[IOVA_MAG_SIZE];
};

struct iova_cpu_rcache {
    spinlock_t         lock;
    struct iova_magazine *loaded;   /* current magazine (drawn from) */
    struct iova_magazine *prev;     /* spare magazine */
};

struct iova_rcache {
    spinlock_t          lock;       /* protects depot */
    unsigned int         depot_size;
    struct iova_magazine *depot;    /* singly-linked list of depot magazines */
    struct iova_cpu_rcache __percpu *cpu_rcaches;
    struct iova_domain  *iovad;     /* owning domain, for the depot-trim worker below */
    struct delayed_work  work;      /* periodically trims the depot back down */
};
```

A delayed-work callback (`iova_depot_work_func()`, period `IOVA_DEPOT_DELAY` = 100ms) periodically
frees depot magazines down to `num_online_cpus()` — the depot is not an unbounded stash.

`IOVA_RANGE_CACHE_MAX_SIZE` is defined as 6 in recent kernels, giving 6 size classes. Each size class manages IOVAs of a specific power-of-two page count (1, 2, 4, 8, 16, 32 pages), covering the most common DMA buffer sizes for network and NVMe workloads.

### How the magazine cache works

The design is inspired by the Slab magazine allocator (Bonwick & Adams, 2001):

```
Per-CPU rcache:
  loaded magazine  [pfn, pfn, pfn, ..., pfn]  <- alloc/free here
  prev magazine    [pfn, pfn, pfn, ..., pfn]  <- spare

Global depot:
  [mag0] [mag1] [mag2] ... [magN]             <- overflow magazines
```

**Allocation (fast path, no rbtree lock):**
1. Pop a PFN from the `loaded` magazine of the matching size class.
2. If `loaded` is empty, swap `loaded` and `prev`. If `prev` is also empty, pull a full magazine from the global depot. If the depot is also empty, fall back to `alloc_iova()` (slow path, acquires rbtree lock).

**Free (fast path, no rbtree lock):**
1. Push the PFN onto the `loaded` magazine.
2. If `loaded` is full, swap `loaded` and `prev`. If `prev` is also full, push `prev` to the depot and allocate a fresh empty magazine for `prev`.

The critical property: on the normal alloc/free cycle, no spinlock contention with other CPUs. Each CPU manages its own loaded magazine independently.

**Performance note:** The rcache is what makes 10 Gbps+ NICs viable on IOMMU-enabled systems. Without it, every packet's DMA map would acquire the global rbtree spinlock. A single-threaded 25 Gbps small-packet workload can issue over 3 million `dma_map_single()` calls per second; the rcache absorbs this with no cross-CPU synchronization in the common case.

## IOVA flush queues (struct iova_fq)

Introduced in Linux 5.15, flush queues decouple IOVA freeing from IOTLB invalidation. Unmapping a DMA range requires both freeing the IOVA and flushing the IOMMU TLB. IOTLB flushes are expensive — on Intel VT-d they require a write to the DMAR registers and may stall the bus.

```c
/* drivers/iommu/dma-iommu.c — not include/linux/iova.h, which has no "fq" symbols at all */
#define IOVA_DEFAULT_FQ_SIZE   256

struct iova_fq_entry {
    unsigned long iova_pfn;
    unsigned long pages;
    struct iommu_pages_list freelist; /* IOMMU page-table pages freed with this entry,
                                        * deferred until the batched flush actually runs */
    u64 counter;               /* flush counter when this entry was added */
};

struct iova_fq {
    spinlock_t lock;
    unsigned int head, tail;
    unsigned int mod_mask;     /* ring size - 1; entries[] is power-of-two sized */
    struct iova_fq_entry entries[]; /* flexible array member */
};
```

Instead of calling `iommu_iotlb_sync()` immediately after each unmap, the flush queue accumulates freed IOVAs. A background worker (or the next domain-wide flush) drains the queue, performs one batched IOTLB invalidation, and then returns the IOVAs to the rcache or rbtree. This amortizes the hardware invalidation cost over many unmaps.

The domain type `IOMMU_DOMAIN_DMA_FQ` enables flush-queue mode:

```c
/* drivers/iommu/dma-iommu.c — real signature takes the domain, not the
 * cookie directly, and handles a separate MSI-cookie teardown case */
static void iommu_dma_free_iova(struct iommu_domain *domain, dma_addr_t iova,
                                size_t size, struct iommu_iotlb_gather *gather)
{
    struct iova_domain *iovad = &domain->iova_cookie->iovad;

    if (domain->cookie_type == IOMMU_COOKIE_DMA_MSI) {
        /* MSI case: only ever cleaning up the most recent allocation */
        domain->msi_cookie->msi_iova -= size;
    } else if (gather && gather->queued) {
        queue_iova(domain->iova_cookie, iova_pfn(iovad, iova),
                   size >> iova_shift(iovad), &gather->freelist);
    } else {
        free_iova_fast(iovad, iova_pfn(iovad, iova),
                       size >> iova_shift(iovad));
    }
}
```

## The 32-bit DMA limit

Many legacy and embedded devices have 32-bit DMA address registers. On a system with > 4 GB of RAM, the IOMMU must ensure those devices receive IOVAs below 4 GB — physical memory above 4 GB is fine, but the IOVA the device sees must fit in 32 bits.

The `dma_32bit_pfn` field in `struct iova_domain` marks the upper boundary of the 32-bit IOVA region:

```c
/* init_iova_domain() sets a fixed 4 GB boundary, derived only from the
 * domain's granule -- it takes no struct device and is not clamped by
 * any device's DMA mask:
 *   iovad->dma_32bit_pfn = 1UL << (32 - iova_shift(iovad));
 * Per-device DMA-mask clamping happens separately, as a local limit_pfn
 * inside iommu_dma_alloc_iova(), not by mutating this field. */
```

When a driver calls `dma_set_mask(dev, DMA_BIT_MASK(32))`, subsequent allocations use `limit_pfn = iovad->dma_32bit_pfn`. The allocator satisfies the constraint by searching only the region below 4 GB.

The consequence: on a system with many 32-bit devices, the low IOVA range becomes contested. Large 64-bit-capable devices should explicitly call `dma_set_mask(dev, DMA_BIT_MASK(64))` to allow allocation from the unconstrained high range, leaving low IOVAs for those that truly need them.

## Impact on DMA performance

IOVA allocation shows up in profiles in two ways:

1. **Lock contention on `iova_rbtree_lock`** — occurs when the rcache is cold (driver startup, or buffer sizes that miss all six size classes). Visible in `perf` as time in `alloc_iova()` holding the spinlock.

2. **IOTLB flush cost** — without flush queues, each `dma_unmap_single()` issues an IOTLB invalidation. On Intel VT-d, this costs hundreds of nanoseconds per call. Flush queues batch this cost.

```bash
# See IOVA allocator state per domain
# Note: no single generic /sys/kernel/debug/iommu/iova file exists.
# IOVA-related stats appear under vendor-specific paths, e.g.:
#   /sys/kernel/debug/iommu/intel/  (Intel VT-d)

# perf: find IOVA allocation cost in a NIC driver workload
perf record -g -- netperf -t UDP_STREAM -H <host> -l 30
perf report --sort=symbol | grep -i iova

# Tracepoints for DMA map/unmap timing
echo 1 > /sys/kernel/tracing/events/dma/enable
cat /sys/kernel/tracing/trace
```

A common tuning mistake for high-throughput drivers: using `dma_map_single()` per-packet instead of `dma_map_sg()` with batched scatter-gather entries. `dma_map_sg()` coalesces contiguous pages and issues fewer IOVA allocations, reducing both allocator pressure and the number of IOMMU page table entries that must be flushed.

## Source files

| File | Role |
|------|------|
| `drivers/iommu/iova.c` | IOVA rbtree allocator, rcache, flush queues |
| `include/linux/iova.h` | `iova_domain`, `iova`, `iova_rcache`, `iova_fq` struct definitions |
| `drivers/iommu/dma-iommu.c` | DMA-IOMMU glue: calls into iova.c from DMA API |
| `drivers/iommu/iommu.c` | `iommu_iotlb_gather` accumulation and sync |

## Further reading

### Kernel source

- [drivers/iommu/iova.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/iommu/iova.c) — `alloc_iova()`, `free_iova()`, the rbtree allocator, and the per-CPU rcache/magazine implementation
- [include/linux/iova.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/iova.h) — `struct iova_domain` and `struct iova` definitions
- [drivers/iommu/dma-iommu.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/iommu/dma-iommu.c) — `iommu_dma_alloc_iova()` / `iommu_dma_free_iova()`, and the flush-queue (`struct iova_fq`) implementation

### Related pages

- [DMA API](dma-api.md) — `dma_map_single`, `dma_map_sg`, swiotlb
- [IOMMU Architecture](iommu-arch.md) — IOMMU domains, IOTLB flush mechanics
- [IOMMU War Stories](war-stories.md) — IOVA allocator as a perf bottleneck (real incident)
