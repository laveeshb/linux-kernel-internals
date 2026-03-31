# 1GB Huge Pages

> PUD-level huge pages for workloads where even 2MB pages leave TLB pressure on the table

## What are 1GB pages?

On x86-64, the CPU's page table walker can terminate a translation at three levels:

```
PGD → PUD → PMD → PTE → 4KB page
PGD → PUD → PMD →        2MB huge page  (PMD-level)
PGD → PUD →               1GB huge page  (PUD-level)
```

A **1GB huge page** maps the entire gigabyte with a single PUD entry. One TLB entry covers 1GB of virtual address space — 512 times the coverage of a 2MB page and 262,144 times the coverage of a 4KB page.

This is the largest page size supported on x86-64. It requires explicit CPU support and explicit reservation. Nothing happens automatically.

### CPU requirement

1GB pages require the `pdpe1gb` CPUID flag (kernel feature `X86_FEATURE_GBPAGES`). Check your system:

```bash
grep pdpe1gb /proc/cpuinfo
```

Any x86-64 CPU manufactured after roughly 2010 (Intel Westmere, AMD Barcelona and later) supports it. The kernel gates 1GB page support on this flag in `arch/x86/mm/hugetlbpage.c`:

```c
bool __init arch_hugetlb_valid_size(unsigned long size)
{
    if (size == PMD_SIZE)
        return true;
    else if (size == PUD_SIZE && boot_cpu_has(X86_FEATURE_GBPAGES))
        return true;
    else
        return false;
}
```

## TLB coverage: the core motivation

The TLB holds a finite number of virtual-to-physical address translations. When it fills, the CPU must walk the page table in memory — a multi-step operation that can cost 50–200 cycles per miss on modern hardware.

TLB entry counts for a 1GB working set:

| Page Size | TLB Entries for 1GB |
|-----------|---------------------|
| 4KB       | 262,144             |
| 2MB       | 512                 |
| 1GB       | 1                   |

For a 100GB database buffer pool (a realistic figure for Oracle, SAP HANA, or Redis with a large dataset):

| Page Size | TLB Entries for 100GB |
|-----------|-----------------------|
| 4KB       | ~26,200,000           |
| 2MB       | 51,200                |
| 1GB       | 100                   |

A typical L2 TLB (STLB) on a Skylake CPU holds 1,536 entries for 4KB pages and 32 entries for large pages (sources: [WikiChip Skylake server](https://en.wikichip.org/wiki/intel/microarchitectures/skylake_(server)#Memory_Hierarchy), [7-cpu.com](https://www.7-cpu.com/cpu/Skylake.html)). With a 100GB working set and 2MB pages, you need 51,200 TLB entries to cover it all — but the hardware only has 32 dedicated large-page TLB entries. With 1GB pages, 100 entries covers the entire pool.

For more on TLB mechanics and 2MB page TLB math, see [Transparent Huge Pages](thp.md) and [hugetlbfs vs THP](hugetlbfs-vs-thp.md).

## Allocation: boot time only (practically speaking)

### Why 1GB pages cannot be allocated at runtime

A 1GB page requires 1GB of **physically contiguous** memory, aligned to a 1GB physical boundary. On a freshly booted system with no memory fragmentation, this is feasible. On a system that has been running — with the kernel, drivers, file caches, and applications already fragmented across physical memory — finding a free, contiguous, aligned 1GB region is nearly impossible.

The kernel calls pages of this size "gigantic" because their allocation order (`PUD_SHIFT - PAGE_SHIFT` = 30 - 12 = order-18) exceeds `MAX_PAGE_ORDER` (typically 10 or 11). The buddy allocator does not manage blocks this large at all.

Runtime allocation is technically possible when `CONFIG_CONTIG_ALLOC` is enabled — the kernel can use `alloc_contig_pages()` or CMA (Contiguous Memory Allocator) to assemble a contiguous region by migrating existing pages out of the way. In practice this succeeds only immediately after boot, before memory becomes fragmented. On a loaded production system, it almost always fails silently: you write a count to `nr_hugepages` and `free_hugepages` stays at 0.

### Boot-time reservation

Reserve 1GB pages on the kernel command line, before the memory allocator has touched anything:

```
# Method 1: explicit size
hugepagesz=1G hugepages=N

# Method 2: set 1G as the default huge page size
default_hugepagesz=1G hugepages=N
```

Both `hugepagesz` and `default_hugepagesz` are parsed as `early_param` in `mm/hugetlb.c` (functions `hugepagesz_setup` and `default_hugepagesz_setup`). They run before the page allocator is fully initialized, which is why boot-time reservation succeeds where runtime reservation fails.

You can combine sizes on the command line to reserve both 2MB and 1GB pools:

```
hugepagesz=1G hugepages=16 hugepagesz=2M hugepages=1024
```

!!! warning "Order matters"
    `hugepages=N` applies to the most recently specified `hugepagesz`. A stray `hugepages=` before any `hugepagesz=` applies to the default page size (usually 2MB). Always pair them explicitly.

## Runtime failure: what it looks like

After boot, the 1GB pool lives at:

```
/sys/kernel/mm/hugepages/hugepages-1048576kB/
```

(1048576 kB = 1GB)

On a booted system without boot-time reservation, attempting runtime allocation:

```bash
# Attempt to allocate 4 x 1GB pages at runtime
echo 4 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages

# Check what actually happened
cat /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages   # shows actual pool size (may be 0-4)
cat /sys/kernel/mm/hugepages/hugepages-1048576kB/free_hugepages # shows unused pages in pool
```

`nr_hugepages` shows the actual number of huge pages in the pool — not the requested target. If you request 4 but the kernel can only allocate 2 (due to fragmentation), `nr_hugepages` shows 2. `free_hugepages` shows how many pool pages are not currently mapped by any process. On a loaded system, runtime allocation of 1GB pages almost always fails entirely.

!!! note "CONFIG_CONTIG_ALLOC"
    Some distributions enable `CONFIG_CONTIG_ALLOC`, which allows runtime gigantic page allocation via `alloc_contig_pages()`. This may succeed immediately after boot when memory is still unfragmented, but should not be relied upon for production deployments. Boot-time reservation is the only reliable method.

## NUMA implications

Each 1GB page is allocated on a specific NUMA node. A process running on node 0 that accesses a 1GB page residing on node 1 pays the NUMA remote memory penalty on **every single access** — there is no migration granularity below the 1GB page boundary.

With 4KB or 2MB pages, the kernel's NUMA balancing can migrate individual pages or 2MB chunks closer to the accessing CPU. With 1GB pages, NUMA balancing does not apply — the pages are pinned in the hugetlb pool and are never migrated.

### Per-node reservation

Always reserve 1GB pages on the specific NUMA nodes where your workload runs:

```bash
# Reserve 8 x 1GB pages on node 0
echo 8 > /sys/devices/system/node/node0/hugepages/hugepages-1048576kB/nr_hugepages

# Reserve 8 x 1GB pages on node 1
echo 8 > /sys/devices/system/node/node1/hugepages/hugepages-1048576kB/nr_hugepages
```

Or equivalently with `numactl` at application launch time:

```bash
numactl --membind=0 --cpunodebind=0 ./myapp
```

Check per-node 1GB page usage:

```bash
# Pages allocated per node
cat /sys/devices/system/node/node0/hugepages/hugepages-1048576kB/free_hugepages
cat /sys/devices/system/node/node1/hugepages/hugepages-1048576kB/free_hugepages

# Summary across all nodes
numastat -m | grep -i huge
```

## When 1GB pages outperform 2MB pages

2MB pages already reduce TLB pressure by 512x over 4KB pages. Switching to 1GB pages provides another 512x reduction — but this only matters if TLB misses are still the bottleneck after switching to 2MB.

**Workloads that benefit:**

- **In-memory databases** — Oracle Database, SAP HANA, and similar systems with buffer pools larger than ~100GB. The buffer pool is accessed randomly; every cache hit becomes a TLB miss at 2MB granularity when the working set exceeds TLB capacity.

- **ML training with large model weights** — Large language model training loads multi-gigabyte weight tensors that are repeatedly accessed. With 1GB pages, the entire weight tensor for a transformer layer can fit in a handful of TLB entries.

- **HPC with dense matrices** — Scientific codes doing dense linear algebra (DGEMM, FFTs) on large matrices see measurable speedups from 1GB pages when matrix dimensions push working sets into the hundreds of gigabytes.

- **DPDK and high-speed packet processing** — DPDK has long recommended 1GB pages for its memory pools. A single TLB entry covers the entire packet buffer pool, and the zero TLB miss rate on packet descriptor lookups is measurable in throughput.

**Rule of thumb:** consider 1GB pages when:
1. Your working set is larger than ~100GB, **and**
2. You can measure TLB miss rate via `perf stat -e dTLB-load-misses` and it is a non-trivial fraction of runtime, **and**
3. 2MB pages (THP or hugetlbfs) are already in use but TLB misses persist

```bash
# Measure TLB miss rate before and after switching to 1GB pages
perf stat -e cycles,dTLB-load-misses,dTLB-load-misses:u ./workload
```

## When NOT to use 1GB pages

1GB pages are a commitment. They have significant downsides that rule them out for many workloads.

**Memory waste.** A 1GB page allocated for a 100MB dataset wastes 900MB of physical RAM — permanently, until the application exits and the page returns to the pool. With 2MB pages the waste is at most 2MB per allocation.

**No swapping.** hugetlb pages (both 2MB and 1GB) are never swapped. A 1GB page that your application maps but rarely accesses sits in physical RAM indefinitely. On a machine with memory pressure, this can push other workloads into swap or OOM.

**Fragmentation of the pool itself.** Each 1GB page is committed to the pool even when not mapped by any application. Ten reserved but unmapped 1GB pages means 10GB of RAM sitting idle.

**Containers and overcommit.** Container environments typically rely on memory overcommit — the ability to promise more memory than exists and rely on typical usage being less than total reservation. hugetlb pages cannot be overcommitted: the pool is a hard limit. 1GB granularity also makes it impossible to size the pool precisely for containers with varying memory requirements.

**Small or medium workloads.** A process with a 4GB working set uses 4 TLB entries with 1GB pages. The same process with 2MB pages uses 2,048 TLB entries — well within the capacity of a modern STLB. There is no TLB benefit that justifies 1GB page overhead for small working sets.

!!! tip "For most workloads: start with 2MB"
    If you haven't already deployed 2MB hugetlbfs pages, do that first. The operational overhead is far lower (runtime allocation is possible), and you can measure how much TLB benefit you get before committing to the more complex 1GB setup. See [hugetlbfs vs THP](hugetlbfs-vs-thp.md) for 2MB page setup and comparison.

## Using 1GB pages from applications

### hugetlbfs mount

```bash
# Create a mount point for 1GB pages
mkdir -p /dev/hugepages-1G

# Mount with explicit page size
mount -t hugetlbfs -o pagesize=1G nodev /dev/hugepages-1G
```

### mmap() with MAP_HUGE_1GB

```c
#include <sys/mman.h>

/* Map 2GB using 1GB huge pages (MAP_HUGE_1GB = 30U << 26 = 0x78000000) */
void *ptr = mmap(NULL, 2UL * 1024 * 1024 * 1024,
                 PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB | MAP_HUGE_1GB,
                 -1, 0);
if (ptr == MAP_FAILED) {
    perror("mmap");  /* pool exhausted or not reserved */
    exit(1);
}
```

`MAP_HUGE_1GB` is defined in `include/uapi/linux/mman.h` as `HUGETLB_FLAG_ENCODE_1GB`, which is `(30U << HUGETLB_FLAG_ENCODE_SHIFT)` = `(30U << 26)` = `0x78000000`. The value 30 encodes log2(1GB) = 30.

### File on hugetlbfs (shared memory between processes)

```c
/* Process 1: create the backing file */
int fd = open("/dev/hugepages-1G/shm-buffer", O_CREAT | O_RDWR, 0600);
ftruncate(fd, 4UL * 1024 * 1024 * 1024);  /* 4GB = 4 x 1GB pages */

void *ptr = mmap(NULL, 4UL * 1024 * 1024 * 1024,
                 PROT_READ | PROT_WRITE,
                 MAP_SHARED, fd, 0);

/* Process 2: attach to the same file */
int fd2 = open("/dev/hugepages-1G/shm-buffer", O_RDWR);
void *ptr2 = mmap(NULL, 4UL * 1024 * 1024 * 1024,
                  PROT_READ | PROT_WRITE,
                  MAP_SHARED, fd2, 0);
```

The hugetlbfs file approach is used by Oracle's SGA and by DPDK for shared packet memory.

## Observing 1GB page usage

### /proc/meminfo

`/proc/meminfo` only shows the **default** huge page size pool. On a system where the default is 2MB (the common case), `HugePages_Total` reflects the 2MB pool, not the 1GB pool:

```bash
$ grep -i huge /proc/meminfo
AnonHugePages:    204800 kB    # THP (not hugetlbfs)
HugePages_Total:    1024       # default pool (2MB if default_hugepagesz=2M)
HugePages_Free:      900
HugePages_Rsvd:       50
HugePages_Surp:        0
Hugepagesize:       2048 kB    # confirms default is 2MB
```

To see the 1GB pool regardless of the default setting, use the size-specific sysfs directory:

```bash
$ ls /sys/kernel/mm/hugepages/hugepages-1048576kB/
free_hugepages  nr_hugepages  nr_hugepages_mempolicy  nr_overcommit_hugepages  resv_hugepages  surplus_hugepages

$ cat /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages
16

$ cat /sys/kernel/mm/hugepages/hugepages-1048576kB/free_hugepages
4
```

### Per-node via numastat

```bash
# Per-node breakdown of all huge page sizes
numastat -m

# Example output (excerpt):
# Node 0  Node 1   Total
# HugePages_Total   8.00    8.00   16.00
# HugePages_Free    2.00    2.00    4.00
```

### Per-node via sysfs

```bash
for node in /sys/devices/system/node/node*/hugepages/hugepages-1048576kB; do
    echo "$node:"
    echo "  nr:   $(cat $node/nr_hugepages)"
    echo "  free: $(cat $node/free_hugepages)"
done
```

### Per-process

```bash
# Maps using 1GB huge pages show up in smaps with KernelPageSize: 1048576 kB
grep -A5 "KernelPageSize" /proc/<pid>/smaps | grep -B1 "1048576"
```

## Key Source Files

| File | Description |
|------|-------------|
| [`mm/hugetlb.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/hugetlb.c) | hugetlb pool management: `hugepagesz_setup`, `default_hugepagesz_setup`, `alloc_gigantic_frozen_folio`, `hugetlb_gigantic_pages_alloc_boot` |
| [`include/linux/hugetlb.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/hugetlb.h) | `hstate_is_gigantic()`, `hugepage_migration_supported()` |
| [`arch/x86/mm/hugetlbpage.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/hugetlbpage.c) | `arch_hugetlb_valid_size()` — gates 1GB support on `X86_FEATURE_GBPAGES`; `gigantic_pages_init()` — registers the PUD-level hstate when `CONFIG_CONTIG_ALLOC` is set |
| [`arch/x86/include/asm/cpufeatures.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/cpufeatures.h) | `X86_FEATURE_GBPAGES` (`"pdpe1gb"`) — CPU capability flag |
| [`include/uapi/linux/mman.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/mman.h) | `MAP_HUGE_1GB` — mmap flag for 1GB pages |
| [`include/uapi/asm-generic/hugetlb_encode.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/asm-generic/hugetlb_encode.h) | `HUGETLB_FLAG_ENCODE_1GB` = `(30U << 26)` |

## History

### 1GB page support (v2.6.26, 2008)

1GB page support on x86-64 was introduced in Linux 2.6.26. AMD Barcelona (Family 10h) was the first x86 CPU to implement the `PDPE1GB` CPUID bit, which is exposed in Linux as `X86_FEATURE_GBPAGES` (cpufeature string `"pdpe1gb"`).

**LWN coverage**: [Huge pages part 3: Administration](https://lwn.net/Articles/376606/) covers the NUMA pool management that accompanied 1GB page support.

### MAP_HUGE_1GB flag (v3.8, 2013)

**Commit**: [42d7395feb56](https://git.kernel.org/linus/42d7395feb56) ("mm: support more pagesizes for MAP_HUGETLB/SHM_HUGETLB")

Before this commit, applications had to open a file on a `pagesize=1G` hugetlbfs mount to get 1GB pages. This commit added the page-size encoding in mmap flags, enabling `MAP_HUGETLB | MAP_HUGE_1GB` without a mount point.

## References

### Kernel Documentation

- [`Documentation/admin-guide/mm/hugetlbpage.rst`](https://docs.kernel.org/admin-guide/mm/hugetlbpage.html) — hugetlbfs admin guide including boot parameters and sysfs interface

### LWN Articles

- [Huge pages part 1: Introduction](https://lwn.net/Articles/374424/) (2010)
- [Huge pages part 2: Interfaces](https://lwn.net/Articles/375096/) (2010) — mmap flags and libhugetlbfs
- [Huge pages part 3: Administration](https://lwn.net/Articles/376606/) (2010) — pool management and NUMA

### Related Pages

- [hugetlbfs vs THP](hugetlbfs-vs-thp.md) — 2MB page comparison, pool management, and when to use hugetlbfs vs THP
- [Transparent Huge Pages](thp.md) — 2MB PMD-level THP internals and tuning
- [Page Tables](page-tables.md) — PUD-level page table entry structure
- [NUMA](numa.md) — per-node memory allocation and NUMA topology
- [Page Allocator](page-allocator.md) — why the buddy allocator cannot satisfy 1GB allocations at runtime
