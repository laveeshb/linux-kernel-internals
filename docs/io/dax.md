# DAX: Direct Access for Persistent Memory

> Byte-addressable PMEM without the page cache: CPU load/store directly to persistent storage

## What DAX is

The page cache exists because storage is slow. When you read a file, the kernel copies data from disk into DRAM pages; subsequent reads hit DRAM at 50 ns rather than disk at 100 µs or more. The cache is the right abstraction for spinning disks and even most NAND flash.

Persistent memory (PMEM) breaks that assumption. PMEM — Intel Optane DC, NVDIMM-N, and future CXL devices — is **byte-addressable, directly accessible by the CPU, and persistent across power cycles**. Access latency is measured in hundreds of nanoseconds, close to DRAM and orders of magnitude faster than even NVMe. Routing it through the page cache does three bad things:

1. **Adds a DRAM copy**: data already sitting in fast PMEM gets copied into DRAM pages unnecessarily.
2. **Wastes memory**: DRAM is often more expensive than PMEM; duplicating data inverts the cost hierarchy.
3. **Adds latency**: the page cache machinery (folio allocation, LRU tracking, dirty marking, writeback) is not free.

**DAX (Direct Access)** removes the page cache from the path entirely. On a DAX-mounted filesystem, read/write syscalls translate to CPU `memcpy` operations directly to and from PMEM. `mmap()` gives userspace virtual addresses that map directly to PMEM physical addresses — a store instruction from userspace writes persistent memory with no intermediate copy.

```
Normal buffered I/O:
  read()  → VFS → page cache (miss) → bio → block driver → PMEM → copy to DRAM → copy to user
  write() → VFS → page cache (dirty page) → writeback → bio → block driver → PMEM

DAX I/O:
  read()  → VFS → DAX layer → CPU memcpy from PMEM → user buffer
  write() → VFS → DAX layer → CPU memcpy to PMEM

DAX mmap (the killer feature):
  mmap()  → page fault → DAX fault → install PTE → PMEM physical address
  access  → CPU load/store directly to PMEM (no kernel involvement after fault)
```

The concept first appeared in Linux 3.11 as `MAP_POPULATE` support for ramdisks. Real DAX support for PMEM hardware landed in 3.12, with ext4 as the first filesystem. Since then DAX has matured substantially: XFS gained DAX in 4.0, per-file DAX flags arrived in 5.8, and the iomap-based DAX path is now the standard implementation.

---

## Hardware landscape

### Intel Optane DC Persistent Memory (3D XPoint)

The primary target hardware for DAX in the Linux kernel. Optane DC DIMMs plug into standard DIMM slots and appear to the CPU as byte-addressable memory on the memory bus. Two modes of operation:

- **App Direct mode**: PMEM exposed as `/dev/pmem0`, `/dev/pmem1`, etc. — this is the DAX path.
- **Memory mode**: PMEM acts as a large volatile cache in front of DRAM (no persistence, no DAX).

Optane DC is no longer in production as of 2022, but it was the hardware that drove the entire PMEM/DAX kernel infrastructure. The abstractions remain relevant for future devices.

### NVDIMM-N

DRAM with battery backup and flash backing. On power loss, the controller flushes DRAM to flash; on restore, it reloads from flash. From the CPU's perspective it looks identical to DRAM — byte-addressable, DIMM slots, low latency. Slower than Optane for persistent writes because the flush-to-flash path is involved.

### CXL persistent memory

Compute Express Link (CXL) brings persistent memory over PCIe-like interconnects. CXL Type 3 devices can provide byte-addressable memory (including persistent variants). The kernel's DAX infrastructure is being extended to support CXL memory devices, treating them as pmem-like regions accessible via the DAX path.

### The `/dev/pmem` device

PMEM exposed in App Direct mode appears as `/dev/pmem0`, `/dev/pmem1`, etc. — character-like block devices backed by persistent memory. Unlike a normal block device, the kernel can map PMEM physical addresses directly into process address spaces because PMEM is directly CPU-accessible (it's on the memory bus).

```bash
# List PMEM namespaces
ndctl list -N

# Check PMEM regions
cat /proc/iomem | grep Persistent

# PMEM devices
ls -la /dev/pmem*
```

The `ndctl` tool manages NVDIMM namespaces. A namespace defines how a PMEM region is exposed — as a raw block device (`fsdax` mode for DAX), as a raw `devdax` character device, or as a sector-mode emulated block device.

```bash
# Create a filesystem-DAX namespace
ndctl create-namespace --mode=fsdax --region=region0

# Create a device-DAX namespace (raw access, no filesystem)
ndctl create-namespace --mode=devdax --region=region0
```

---

## Enabling DAX

### Filesystem mount options

```bash
# Mount ext4 with DAX (all files use DAX)
mount -o dax /dev/pmem0 /mnt/pmem

# ext4 per-inode DAX (5.8+): mount enables DAX per file attribute
mount -o dax=inode /dev/pmem0 /mnt/pmem

# Force DAX on all files regardless of per-file flag
mount -o dax=always /dev/pmem0 /mnt/pmem

# XFS DAX modes
mount -t xfs -o dax=always /dev/pmem0 /mnt/pmem    # all files
mount -t xfs -o dax=inode  /dev/pmem0 /mnt/pmem    # per-file flag
mount -t xfs -o dax=never  /dev/pmem0 /mnt/pmem    # disable DAX

# tmpfs with DAX (5.7+, useful for NVDIMM-backed tmpfs)
mount -t tmpfs -o dax /dev/pmem0 /mnt/pmem
```

### Per-file DAX flag (5.8+)

Starting in Linux 5.8, ext4 and XFS support a per-inode DAX flag. This allows mixing DAX and non-DAX files on the same filesystem:

```bash
# Set DAX flag on a file
xfs_io -c 'chattr +x' /mnt/pmem/myfile

# Check DAX flag
xfs_io -c 'lsattr' /mnt/pmem/myfile

# Using the FS_XFLAG_DAX flag via ioctl
# (FS_IOC_FSSETXATTR / FS_IOC_FSGETXATTR)
```

### Verifying DAX is active

```bash
# Check if a filesystem has DAX enabled
mount | grep dax

# Check if a specific file is using DAX
xfs_io -c 'statx -r' /mnt/pmem/myfile | grep dax

# Via /proc/mounts
cat /proc/mounts | grep pmem

# dmesg shows DAX activation at mount time
dmesg | grep -i dax

# Check file's statx flags (AT_STATX_SYNC_AS_STAT)
# STATX_ATTR_DAX set in stx_attributes if file uses DAX
```

---

## DAX in the VFS stack

Understanding what DAX removes from the path is best done by contrasting the call chains:

```
Normal buffered read:
  read()
    → vfs_read()
    → generic_file_read_iter()
    → filemap_read()           ← page cache lookup
    → page_cache_sync_readahead()
    → ext4_read_folio()        ← filesystem reads block
    → submit_bio()             ← block layer
    → NVMe driver
    → PMEM hardware
    → copy_page_to_iter()      ← copy DRAM page to user buffer

DAX read:
  read()
    → vfs_read()
    → generic_file_read_iter()
    → dax_read_iter()          ← DAX path (no page cache)
    → dax_iomap_rw()
    → iomap_apply()
    → ext4_iomap_begin()       ← get PMEM physical address
    → dax_direct_access()      ← map PMEM into kernel address space
    → copy_to_iter()           ← CPU memcpy from PMEM to user buffer

DAX mmap access (after fault):
  store instruction
    → CPU → PTE → PMEM physical address
    → persistent write (no kernel involvement)
```

The crucial difference: no folio allocation, no dirty tracking, no writeback, no bio, no block driver. The page cache simply does not exist in this path.

---

## struct dax_device and dax_operations

Every device that supports DAX registers a `struct dax_device`. This is the abstraction between the DAX filesystem layer and the PMEM driver.

```c
/* include/linux/dax.h */
struct dax_device {
    struct inode              inode;
    struct cdev               cdev;
    const struct dax_operations *ops;
    void                     *private;
    unsigned long             flags;
};
```

The `dax_operations` table is the driver interface:

```c
struct dax_operations {
    /*
     * direct_access: map a range of PMEM into the kernel address space.
     * pgoff:    page offset within the device
     * nr_pages: number of pages requested
     * mode:     DAX_ACCESS or DAX_RECOVERY_WRITE
     * kaddr:    out: kernel virtual address of the mapping
     * pfn:      out: page frame number (for PTE installation)
     * returns:  number of contiguous pages mapped (may be < nr_pages)
     */
    long (*direct_access)(struct dax_device *dax_dev,
                           pgoff_t pgoff, long nr_pages,
                           enum dax_access_mode mode,
                           void **kaddr, pfn_t *pfn);

    /*
     * dax_supported: can this dax_device serve DAX for the given
     * block_device range? Called at filesystem mount time.
     */
    bool (*dax_supported)(struct dax_device *dax_dev,
                           struct block_device *bdev,
                           int blkbits, sector_t start, sector_t end);

    /*
     * zero_page_range: zero a range of PMEM (used for hole punching,
     * truncate, and fallocate on DAX files).
     */
    int  (*zero_page_range)(struct dax_device *dax_dev,
                             pgoff_t pgoff, size_t nr_pages);

    /*
     * recovery_write: write to a PMEM range that previously returned
     * poison, clearing the error condition. Used by the error recovery path.
     */
    size_t (*recovery_write)(struct dax_device *dax_dev,
                              pgoff_t pgoff, void *addr,
                              size_t bytes, struct iov_iter *iter);
};
```

The NVDIMM driver (e.g., `drivers/nvdimm/pmem.c`) implements this interface. `direct_access()` is the hot path: it translates a file page offset to a kernel virtual address and a `pfn_t` (physical page frame number). The kernel virtual address is used for memcpy operations; the `pfn_t` is used to install PTEs for mmap'd DAX mappings.

```c
/* drivers/nvdimm/pmem.c (simplified) */
static long pmem_dax_direct_access(struct dax_device *dax_dev,
                                    pgoff_t pgoff, long nr_pages,
                                    enum dax_access_mode mode,
                                    void **kaddr, pfn_t *pfn)
{
    struct pmem_device *pmem = dax_get_private(dax_dev);
    resource_size_t offset = PFN_PHYS(pgoff) + pmem->data_offset;

    if (kaddr)
        *kaddr = pmem->virt_addr + offset;
    if (pfn)
        *pfn = phys_to_pfn_t(pmem->phys_addr + offset, PFN_MAP | PFN_DEV);

    return nr_pages;
}
```

---

## DAX read/write path

### Entry point: generic_file_read_iter / generic_file_write_iter

The VFS read/write entry points check whether the file's address space is DAX-enabled:

```c
/* mm/filemap.c */
ssize_t generic_file_read_iter(struct kiocb *iocb, struct iov_iter *to)
{
    struct file *file = iocb->ki_filp;
    struct inode *inode = file->f_mapping->host;

    if (IS_DAX(inode)) {
        return dax_read_iter(iocb, to);
    }
    /* normal buffered path */
    return filemap_read(iocb, to, 0);
}
```

`IS_DAX(inode)` checks the `S_DAX` flag in `inode->i_flags`, set at inode creation time based on the mount option or per-file DAX attribute.

### dax_iomap_rw: the DAX I/O engine

Both DAX reads and writes funnel through `dax_iomap_rw()` in `fs/dax.c`:

```c
/* fs/dax.c (simplified) */
ssize_t dax_iomap_rw(struct kiocb *iocb, struct iov_iter *iter,
                      const struct iomap_ops *ops)
{
    struct inode *inode = iocb->ki_filp->f_mapping->host;
    loff_t pos = iocb->ki_pos;
    ssize_t done = 0;

    while (iov_iter_count(iter)) {
        /*
         * Ask the filesystem to map the current file offset.
         * For DAX files, iomap_begin() returns an iomap with
         * type IOMAP_MAPPED and dax_dev set.
         */
        ret = iomap_apply(inode, pos, iov_iter_count(iter),
                           iomap_flags, ops, iter, dax_iomap_iter);
        if (ret <= 0)
            break;
        pos  += ret;
        done += ret;
    }
    return done;
}
```

### dax_iomap_iter: the per-extent DAX operation

For each extent returned by `iomap_begin()`, `dax_iomap_iter()` performs the actual I/O:

```c
/* fs/dax.c (simplified) */
static loff_t dax_iomap_iter(const struct iomap_iter *iomi,
                               struct iov_iter *iter)
{
    struct iomap *iomap = &iomi->iomap;
    loff_t length = iomap_length(iomi);
    loff_t pos    = iomi->pos;
    void  *kaddr;
    pfn_t  pfn;

    /*
     * direct_access() maps the PMEM range into the kernel address space.
     * kaddr is a kernel virtual address pointing directly into PMEM.
     */
    ret = dax_direct_access(iomap->dax_dev,
                             PHYS_PFN(iomap->addr) + pgoff,
                             PHYS_PFN(length), DAX_ACCESS,
                             &kaddr, &pfn);

    if (iov_iter_rw(iter) == READ) {
        copy_to_iter(kaddr, length, iter);       /* PMEM → user buffer */
    } else {
        copy_from_iter(kaddr, length, iter);     /* user buffer → PMEM */
        dax_flush(iomap->dax_dev, kaddr, length); /* writeback CPU caches */
    }

    return length;
}
```

For writes, `dax_flush()` issues `CLWB` + `SFENCE` instructions to ensure the data reaches PMEM rather than sitting in CPU cache (see the persistence section below).

---

## DAX mmap path

`mmap()` is the killer feature of DAX. It gives userspace a virtual address range that maps directly to PMEM physical addresses. Loads and stores from userspace go straight to persistent memory:

```c
/* Example: mmap a DAX file */
int fd = open("/mnt/pmem/data", O_RDWR);

/* Map the entire file */
size_t size = 4UL * 1024 * 1024 * 1024;  /* 4 GB */
void *addr = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
if (addr == MAP_FAILED)
    perror("mmap");

/* addr now directly addresses PMEM — no copy on access */
/* This store goes directly to persistent memory: */
memcpy(addr + offset, src, len);

/* To ensure persistence, flush CPU caches: */
/* (or use libpmem / PMDK which handles this automatically) */
__builtin_ia32_clwb(addr + offset);
_mm_sfence();
```

After `mmap()`, the virtual address range is set up in the process's `vm_area_struct` but no PTEs are installed yet. Physical addresses are mapped in on demand through the fault path.

### The DAX fault path

```
1. First access to mmap'd address triggers a page fault (no PTE installed).

2. do_page_fault()
     → handle_mm_fault()
     → handle_pte_fault()           ← PTE not present
     → do_fault()                   ← backed by a file
     → do_shared_fault()
     → vma->vm_ops->fault()
     → ext4_dax_fault()  (or xfs_dax_fault())

3. filemap_fault() detects IS_DAX(inode):
     → dax_iomap_fault()            ← fs/dax.c

4. dax_iomap_fault():
     → iomap_begin()                ← filesystem maps file offset to PMEM address
     → dax_iomap_pfn()              ← get pfn_t for the PMEM page
     → vmf_insert_mixed()           ← install "device PFN" PTE

5. PTE now points to PMEM physical address.
   Subsequent accesses: CPU walks page tables, finds PTE, directly accesses PMEM.
   No kernel involvement.
```

### Device PFNs and "struct page"

Standard PTEs point to `struct page` entries in the kernel's `mem_map` array. PMEM has a complication: depending on the system configuration, PMEM physical pages may not have `struct page` backing (the page structures would consume too much DRAM for multi-terabyte PMEM ranges).

The kernel handles this with **`pfn_t`** — a type that can represent either a normal page-backed PFN or a device PFN (one without `struct page`):

```c
/* include/linux/pfn_t.h */
typedef struct {
    u64 val;
} pfn_t;

#define PFN_DEV  (1ULL << 63)   /* device PFN: no struct page */
#define PFN_MAP  (1ULL << 62)   /* has a struct page mapping */
```

`vmf_insert_mixed()` handles both cases, installing a PTE that points directly to the PMEM physical address. For device PFNs, the kernel uses **ZONE_DEVICE** pages — minimal `struct page` entries allocated specifically for device memory mappings.

---

## Huge page DAX (PMD-level mappings)

For large PMEM files, 4 KB PTEs create TLB pressure: a 1 GB file requires 262,144 PTEs. DAX supports 2 MB PMD-level ("huge page") mappings to reduce TLB overhead.

The fault path for huge DAX:

```c
/* fs/dax.c */
static vm_fault_t dax_iomap_fault(struct vm_fault *vmf,
                                   unsigned int order,
                                   const struct iomap_ops *ops)
{
    if (order == PMD_ORDER) {
        /* 2 MB mapping request */
        return dax_iomap_pmd_fault(vmf, ops);
    }
    /* 4 KB fallback */
    return dax_iomap_pte_fault(vmf, ops);
}

static vm_fault_t dax_iomap_pmd_fault(struct vm_fault *vmf,
                                        const struct iomap_ops *ops)
{
    /* Check alignment: PMEM range must be 2 MB aligned */
    if (!IS_ALIGNED(iomap.addr, PMD_SIZE))
        goto fallback;  /* fall back to 4 KB PTE */

    /* Map 2 MB range at once */
    pfn = dax_iomap_pfn(&iomap, vmf->pgoff, PMD_SIZE, &entry);
    return vmf_insert_pfn_pmd(vmf, pfn, vmf->flags & FAULT_FLAG_WRITE);

fallback:
    return dax_iomap_pte_fault(vmf, ops);
}
```

Requirements for 2 MB DAX mappings:
- PMEM region must be 2 MB physically aligned
- File offset must be 2 MB aligned
- `mmap()` address must be 2 MB aligned
- The filesystem mapping must cover the full 2 MB range (no extent boundaries within the PMD)

When these conditions are met, the kernel installs a single PMD entry covering 2 MB rather than 512 PTE entries. The result is 512x fewer TLB entries for large sequential access patterns.

---

## CLWB and persistence

The most important correctness property of PMEM: **a CPU store to PMEM does not immediately make data persistent**. The store goes into the CPU cache hierarchy first. If the system loses power before the cache line is evicted to PMEM, the store is lost.

For applications that need persistence guarantees, cache lines must be explicitly written back:

| Instruction | Effect |
|-------------|--------|
| `CLWB addr` | Write the cache line containing `addr` back to memory; keep in cache (non-evicting) |
| `CLFLUSHOPT addr` | Write back and evict from cache |
| `CLFLUSH addr` | Write back and evict (serializing, slower, use CLFLUSHOPT instead) |
| `SFENCE` | Store fence: all prior stores complete before any subsequent stores |

The kernel provides architecture-specific wrappers:

```c
/* arch/x86/include/asm/cacheflush.h */
static inline void arch_wb_cache_pmem(void *addr, size_t size)
{
    u64 clflush_mask = boot_cpu_data.x86_clflush_size - 1;
    void *vend = addr + size;
    void *p;

    for (p = (void *)((unsigned long)addr & ~clflush_mask);
         p < vend; p += boot_cpu_data.x86_clflush_size)
        clwb(p);  /* CLWB instruction */
}

static inline void arch_invalidate_pmem(void *addr, size_t size)
{
    /* CLFLUSHOPT: flush and evict (useful after error recovery) */
    /* … similar loop with clflushopt … */
}
```

The DAX write path calls `dax_flush()` which wraps `arch_wb_cache_pmem()` followed by `wmb()` (write memory barrier / SFENCE on x86):

```c
/* drivers/dax/super.c */
void dax_flush(struct dax_device *dax_dev, void *addr, size_t size)
{
    if (unlikely(!dax_write_cache_enabled(dax_dev)))
        return;
    arch_wb_cache_pmem(addr, size);
}
```

Applications using PMDK (the Persistent Memory Development Kit) or `libpmem` get this automatically. Direct PMEM programmers must handle cache flushing themselves.

### The persistence domain

Modern Intel platforms introduce the concept of a **persistence domain** — the boundary at which a write becomes guaranteed-persistent. With ADR (Asynchronous DRAM Refresh), writes reaching the memory controller are persistent even without explicit cache flush. With eADR (Enhanced ADR), writes reaching the CPU cache are persistent (the platform flushes caches on power loss).

```bash
# Check if eADR is available (CPU caches are persistent domain)
cat /sys/bus/nd/devices/region0/persistence_domain
# "cpu_cache" = eADR available, no CLWB needed
# "memory_controller" = ADR only, CLWB required
```

---

## fsync on DAX files

`fsync()` on a regular file submits dirty pages through the block layer and waits for the disk write. On a DAX file there are no dirty pages and no block layer — but there are potentially dirty CPU cache lines.

```c
/* fs/dax.c */
static int dax_writeback_one(struct xa_state *xas,
                               struct dax_device *dax_dev,
                               struct inode *inode,
                               void *entry)
{
    void *kaddr;
    pfn_t pfn;
    long ret;
    size_t size;

    /* Get the PMEM address for this page/PMD entry */
    ret = dax_direct_access(dax_dev, pgoff, nr_pages,
                             DAX_ACCESS, &kaddr, &pfn);

    /* Flush CPU caches for this PMEM range */
    dax_flush(dax_dev, kaddr, size);

    return 0;
}
```

The DAX fsync path:

```
fsync(fd)
  → vfs_fsync()
  → ext4_sync_file()
  → file_write_and_wait_range()    ← for DAX: flushes CPU caches, not pages
  → dax_writeback_mapping_range()
  → for each dirty DAX entry in xarray:
      dax_writeback_one()
        → dax_direct_access()      ← get PMEM kaddr
        → dax_flush()              ← CLWB + SFENCE
  → ext4_commit_super()            ← flush journal (metadata)
```

The "dirty" tracking for DAX uses the XArray that backs the inode's address space. Rather than tracking dirty folios (there are none), DAX tracks dirty extents using special XArray entries tagged with `RADIX_DAX_DIRTY`.

---

## DAX and O_DIRECT

O_DIRECT normally bypasses the page cache by going through the block layer directly. On a DAX filesystem, O_DIRECT takes a different route:

```
O_DIRECT on non-DAX filesystem:
  write() → iomap_dio_rw() → bio → block driver → disk

O_DIRECT on DAX filesystem:
  write() → dax_iomap_rw() → dax_direct_access() → CPU memcpy → PMEM
```

The key difference: there is no bio and no block driver. The DAX path for O_DIRECT behaves identically to buffered DAX I/O — both use `dax_iomap_rw()`. The distinction between `O_DIRECT` and buffered on a DAX filesystem is smaller than on a regular filesystem, because DAX buffered I/O already bypasses the page cache.

Practical considerations:
- O_DIRECT still enforces sector alignment on DAX filesystems
- O_DIRECT skips any `fadvise` / readahead hints (irrelevant for DAX anyway)
- For latency-sensitive applications that expect O_DIRECT semantics, it works correctly on DAX filesystems

---

## Filesystem support

| Filesystem | DAX Support | Version | Notes |
|------------|------------|---------|-------|
| ext4 | Full | 3.12+ | `-o dax`, per-file flag in 5.8+ |
| XFS | Full | 4.0+ | `-o dax=always/inode/never` |
| tmpfs | Yes | 5.7+ | `-o dax`, useful with NVDIMM-backed tmpfs |
| ext2 | Basic | old | Legacy, minimal maintenance |
| btrfs | No | — | COW is fundamentally incompatible with DAX |
| F2FS | Partial | — | Ongoing work |
| NFS/CIFS | No | — | Network filesystems cannot provide direct physical access |

### Why btrfs cannot support DAX

btrfs uses copy-on-write (COW) semantics for all writes: a write to an existing block allocates a new block, writes the data there, and then updates the tree to point to the new location. The old block is freed.

DAX mmap installs PTEs pointing to specific PMEM physical addresses. With COW, those physical addresses can change under the process's feet — the PTE would point to freed or reused PMEM. Making this safe would require either abandoning COW (breaking fundamental btrfs guarantees) or invalidating all DAX PTEs on every write (destroying performance). Neither is acceptable.

This is a fundamental architectural incompatibility, not a "not implemented yet" situation.

---

## Limitations and gotchas

### 1. No transparent huge pages

THP (Transparent Huge Pages) automatically promotes 4 KB page cache pages to 2 MB mappings. DAX huge page mappings exist but are not transparent — they depend on explicit alignment of the PMEM extent, file offset, and virtual address. If any alignment condition fails, the kernel silently falls back to 4 KB PTEs. There is no automatic promotion.

### 2. fork() and copy-on-write

Standard COW on `fork()` works by write-protecting pages and allocating new anonymous pages on write. DAX PTEs point to device memory (PMEM), not to `struct page` entries managed by the allocator. The COW mechanism cannot allocate a new PMEM page — it allocates DRAM pages.

The result: after `fork()`, if a child writes to a DAX mmap'd region, the COW fault creates an anonymous DRAM page. The child's write goes to DRAM, not to PMEM. The parent still sees the original PMEM data. This can be surprising for applications that expect forked children to share PMEM state.

### 3. Encryption incompatibility

ext4 filesystem-level encryption (`fscrypt`) works by encrypting data as it enters the page cache. DAX bypasses the page cache entirely, so there is no point in the I/O path where encryption can be applied. Attempting to enable both encryption and DAX on the same inode fails with `EINVAL`.

Full-disk encryption at the block layer (dm-crypt) also does not work with DAX because DAX bypasses the block layer.

### 4. No swap to DAX files

The kernel's swap path writes anonymous pages to swap devices or files through the block layer. DAX files are not eligible as swap targets — the swap path does not use the DAX I/O path. PMEM can be used as swap indirectly by using it as a block device (without DAX), accepting the overhead.

### 5. msync() and dirty tracking

With regular mmap'd files, the kernel tracks dirty pages through the page cache's dirty bit mechanism. Writeback eventually flushes them to disk. With DAX mmap, stores go directly to PMEM — there is no dirty page, and therefore no automatic writeback.

Applications must use `msync()` (or explicit CLWB/SFENCE) to ensure stores are persistent:

```c
/* Write to PMEM via DAX mmap */
memcpy(pmem_addr, data, len);

/* Ensure persistence (flushes CPU caches for the range) */
msync(pmem_addr, len, MS_SYNC);
/* MS_SYNC on a DAX mapping calls dax_flush() → arch_wb_cache_pmem() */
```

Failing to call `msync()` after a DAX mmap write and before declaring the data durable is a correctness bug. Unlike regular files where writeback happens automatically, DAX applications bear full responsibility for cache coherency.

### 6. Poison: hardware errors on PMEM reads

DRAM ECC silently corrects single-bit errors. PMEM can return **poison** on a read from a location that had an uncorrectable error (e.g., a failed bit that was written during a previous crash). When the CPU reads a poisoned PMEM location, the machine check architecture (MCA) fires.

The kernel handles this by delivering `SIGBUS` to the process that touched the poisoned address:

```
Access to poisoned PMEM
  → Machine Check Exception (MCE)
  → do_machine_check()
  → memory_failure()
  → kill_accessing_process()
  → SIGBUS delivered to process
```

Applications that need to handle PMEM errors must install a `SIGBUS` handler and use `madvise(MADV_HWPOISON)` for testing or the `MCE_INJECT` interface:

```c
/* Install SIGBUS handler for PMEM error handling */
struct sigaction sa = {
    .sa_sigaction = pmem_error_handler,
    .sa_flags     = SA_SIGINFO,
};
sigaction(SIGBUS, &sa, NULL);

/* The handler receives si_addr = poisoned address */
static void pmem_error_handler(int sig, siginfo_t *si, void *ctx)
{
    void *bad_addr = si->si_addr;
    /* Mark the affected region as unusable, recover from backup, etc. */
}
```

The `dax_operations.recovery_write()` callback allows drivers to implement error recovery — writing to a poisoned region can clear the error state on some hardware.

---

## KMEM DAX: PMEM as a NUMA memory node

Linux 5.1 introduced the ability to use PMEM as a **NUMA memory node** rather than as a DAX filesystem. In this mode, PMEM appears to the kernel as slow DRAM:

```bash
# Reconfigure a devdax namespace to be system RAM
daxctl reconfigure-device --mode=system-ram dax0.0

# PMEM now appears as a NUMA node
numactl --hardware
# available: 2 nodes (0-1)
# node 0: 64 GB DRAM (fast)
# node 1: 256 GB PMEM (slow)

# Allocate from PMEM NUMA node
numactl --membind=1 ./my_application
```

This is distinct from DAX filesystem usage:

| Mode | PMEM used as | Access | Persistence |
|------|-------------|--------|-------------|
| DAX filesystem | Storage | `read()`/`write()`/`mmap()` file | Yes, explicit `msync()` |
| KMEM DAX | Memory (NUMA node) | `malloc()` / kernel allocator | Volatile (no persistence guarantees) |

KMEM DAX is managed by the `daxctl` tool and the `kmem` driver (`drivers/dax/kmem.c`). The kernel's memory tiering infrastructure (introduced in 5.15) can automatically migrate hot pages between DRAM and PMEM NUMA nodes.

---

## Key source files

| File | Purpose |
|------|---------|
| `fs/dax.c` | Core DAX implementation: `dax_read_iter()`, `dax_write_iter()`, `dax_iomap_fault()`, `dax_writeback_mapping_range()` |
| `include/linux/dax.h` | `struct dax_device`, `struct dax_operations`, DAX API |
| `drivers/nvdimm/pmem.c` | NVDIMM pmem driver: implements `dax_operations` for PMEM hardware |
| `drivers/dax/super.c` | DAX device framework: `dax_flush()`, `dax_direct_access()` wrappers |
| `drivers/dax/kmem.c` | KMEM DAX: expose PMEM as NUMA memory node |
| `mm/filemap.c` | `generic_file_read_iter()`: DAX check and dispatch |
| `arch/x86/include/asm/cacheflush.h` | `arch_wb_cache_pmem()`, `clwb()` instruction wrapper |
| `tools/testing/nvdimm/` | Kernel self-tests for NVDIMM/DAX |

---

## Further reading

- [iomap Internals](iomap-internals.md) — the `iomap_begin()` / `iomap_apply()` infrastructure that DAX builds on
- [Direct I/O](direct-io.md) — O_DIRECT: DAX's non-persistent cousin
- [mmap I/O](mmap-io.md) — standard mmap fault path; DAX replaces the page cache parts
- [Page Cache Internals](page-cache-internals.md) — what DAX bypasses and why
- [fsync/fdatasync](fsync-fdatasync.md) — durability guarantees; DAX fsync flushes CPU caches instead of waiting for I/O
- `Documentation/filesystems/dax.rst` — kernel documentation for DAX
- `Documentation/driver-api/nvdimm/nvdimm.rst` — NVDIMM subsystem documentation
- PMDK / libpmem documentation — userspace library for PMEM programming
