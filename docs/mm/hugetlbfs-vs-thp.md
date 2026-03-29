# Explicit hugetlbfs vs Transparent Huge Pages

> Two approaches to huge pages in Linux: one you ask for, one you get automatically

## Why Huge Pages?

Modern CPUs cache virtual-to-physical address translations in the TLB (Translation Lookaside Buffer). With standard 4KB pages, a workload touching a few gigabytes of memory needs hundreds of thousands of page table entries - far more than the TLB can hold. Every TLB miss triggers an expensive multi-level page table walk.

Huge pages (2MB or 1GB on x86-64) reduce TLB pressure dramatically:

| Page Size | Pages for 1GB | TLB Entries Needed |
|-----------|---------------|--------------------|
| 4KB       | 262,144       | 262,144            |
| 2MB       | 512           | 512                |
| 1GB       | 1             | 1                  |

Linux provides two distinct mechanisms for using huge pages. They share the same hardware support (PMD-level and PUD-level page table entries) but differ fundamentally in how they are managed.

## The Two Approaches

### hugetlbfs: Explicit, Preallocated Huge Pages

hugetlbfs is the original huge page mechanism. The administrator reserves a pool of huge pages at boot or runtime, and applications explicitly request them. Nothing happens automatically.

```
Administrator                          Application
     │                                      │
     ├── Reserve pool                       │
     │   (boot param or sysctl)             │
     │                                      │
     ├── Mount hugetlbfs                    │
     │   mount -t hugetlbfs ...             │
     │                                      │
     │                                      ├── mmap() with MAP_HUGETLB
     │                                      │   or open file on hugetlbfs
     │                                      │
     │                                      ├── Use memory
     │                                      │
     │                                      └── munmap() / close
     │                                      │
     └── Pages return to pool               │
```

The kernel reserves these pages at allocation time, removing them from the regular page allocator entirely. They sit in a separate pool managed by [`mm/hugetlb.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/hugetlb.c) and cannot be used for anything else.

### THP: Transparent, On-Demand Huge Pages

Transparent Huge Pages require no application changes. The kernel automatically promotes 4KB pages to 2MB huge pages when it can, and splits them back when it must.

```
Application                            Kernel
     │                                      │
     ├── malloc() / mmap()                  │
     │   (normal allocation)                │
     │                                      │
     ├── Touch memory                       ├── Page fault
     │                                      │   Can allocate 2MB?
     │                                      │   ├── Yes: map huge page
     │                                      │   └── No: fall back to 4KB
     │                                      │
     │                                      ├── khugepaged scans later
     │                                      │   Collapse 512 x 4KB → 2MB
     │                                      │
     └── free() / munmap()                  └── Pages return to buddy
```

THP pages come from the regular buddy allocator. The kernel finds (or creates via compaction) contiguous 2MB-aligned regions on demand. See [`mm/huge_memory.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/huge_memory.c) for the core implementation.

## Side-by-Side Comparison

| Feature | hugetlbfs | THP |
|---------|-----------|-----|
| **Page sizes** | 2MB and 1GB (x86-64); arch-dependent | 2MB (PMD); 16KB-1MB with mTHP (v6.10+) |
| **Application changes** | Required: `MAP_HUGETLB`, hugetlbfs file, or libhugetlbfs | None (or optional `MADV_HUGEPAGE` hint) |
| **Allocation** | Preallocated pool, reserved at boot/runtime | On-demand from buddy allocator |
| **Swappable** | No - pages are pinned in RAM | Yes (since v4.13, swapped as whole unit) |
| **Fragmentation risk** | Low - pool reserved upfront | Higher - needs contiguous memory at fault time |
| **Overcommit** | No - allocation fails if pool exhausted | Yes - falls back to 4KB pages |
| **NUMA awareness** | Per-node pools via `hugepages_*` sysfs | Allocation prefers local node; NUMA balancing can cause thrashing |
| **Memory accounting** | Separate pool, visible in `/proc/meminfo` | Part of regular anonymous memory |
| **Page cache support** | Yes (files on hugetlbfs) | Yes for anonymous; file THP limited |
| **Split/collapse** | No - always huge | Yes - kernel splits and collapses as needed |
| **Latency predictability** | High - no compaction, no fallback | Lower - compaction stalls possible |
| **Wasted memory risk** | Pool sits unused if not consumed | 2MB granularity can waste memory on small allocations |

## When to Use hugetlbfs

hugetlbfs is the right choice when you control the application, need guaranteed huge pages, and cannot tolerate allocation failures or latency jitter.

### Databases (Oracle, PostgreSQL, MySQL)

Database shared buffers are long-lived, large, and heavily accessed. hugetlbfs gives them pinned huge pages that never get split or swapped:

```bash
# PostgreSQL: use huge pages for shared buffers
# postgresql.conf
huge_pages = on   # or "try" for fallback to regular pages
```

PostgreSQL uses `mmap()` with `MAP_HUGETLB` for its shared memory segment. Oracle has used hugetlbfs since the early 2000s for its SGA (System Global Area).

### DPDK and Network Packet Processing

DPDK (Data Plane Development Kit) maps packet buffers on hugetlbfs to get pinned physical memory with known addresses - critical for DMA with network hardware:

```bash
# DPDK typically requires 1GB huge pages
echo 4 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages
mount -t hugetlbfs -o pagesize=1G nodev /dev/hugepages-1G
```

1GB pages are especially valuable here: a single TLB entry covers the entire packet buffer pool.

### KVM/QEMU Virtual Machines

VMs benefit from huge pages for guest memory - fewer TLB entries means less overhead from nested address translation (EPT/NPT):

```bash
# QEMU with hugetlbfs-backed guest memory
qemu-system-x86_64 -m 4G \
    -mem-path /dev/hugepages \
    -mem-prealloc ...
```

## When to Use THP

THP works best for workloads where you want huge page benefits without application modifications, and can tolerate occasional fallback to 4KB pages.

### General Server Workloads

For applications you cannot modify or recompile, THP provides automatic benefit:

```bash
# Enable THP system-wide
echo always > /sys/kernel/mm/transparent_hugepage/enabled
```

The kernel will opportunistically use huge pages for all anonymous memory.

### Applications with Large Heaps

Java, Python, and other managed-runtime applications benefit from THP without any code changes. The JVM in particular sees significant gains from reduced TLB pressure on large heaps.

For fine-grained control without modifying the application:

```bash
# Use madvise mode + per-process hints via libhugetlbfs or LD_PRELOAD
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
```

### KVM (Transparent Mode)

THP was originally designed for KVM. From the initial THP commit [71e3aac0724f](https://git.kernel.org/linus/71e3aac0724f):

> "Lately I've been working to make KVM use hugepages transparently without the usual restrictions of hugetlbfs."

VMs get huge pages automatically for guest memory without reserving a hugetlbfs pool.

## When to Disable THP

Some workloads perform worse with THP. The core issue is that THP adds background work (compaction, khugepaged scanning, page splitting) that can cause unpredictable latency.

### Latency-Sensitive Applications (Redis, Memcached)

In-memory stores that serve requests in microseconds can see multi-millisecond stalls when the kernel runs memory compaction to satisfy a huge page allocation:

```bash
# Redis and Memcached documentation both recommend:
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
```

The Redis documentation specifically calls out THP as a source of latency and memory usage issues.

### Sparse Memory Access Patterns

Applications that allocate large regions but only touch a few bytes per 2MB region waste memory. The kernel allocates a full 2MB page even if only 4KB is used.

### Real-Time and Deterministic Workloads

Any workload where worst-case latency matters more than throughput should disable THP. Compaction is not bounded in time:

```bash
# A middle ground: THP only for apps that ask
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo madvise > /sys/kernel/mm/transparent_hugepage/defrag
```

## Configuration

### hugetlbfs Setup

#### Reserve the Pool

```bash
# At boot (kernel command line) - most reliable for large pools
hugepagesz=2M hugepages=1024
hugepagesz=1G hugepages=4

# At runtime (may fail if memory is fragmented)
echo 1024 > /proc/sys/vm/nr_hugepages                          # 2MB pages
echo 4 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages  # 1GB pages

# Check current state
cat /proc/meminfo | grep -i huge
# HugePages_Total:    1024
# HugePages_Free:     1024
# HugePages_Rsvd:        0
# HugePages_Surp:        0
# Hugepagesize:       2048 kB
```

#### Mount hugetlbfs

```bash
# Default 2MB page size
mount -t hugetlbfs nodev /dev/hugepages

# Explicit 1GB page size
mount -t hugetlbfs -o pagesize=1G nodev /dev/hugepages-1G
```

Most distributions mount the default hugetlbfs automatically via systemd.

#### Use from Applications

```c
#include <sys/mman.h>

/* Option 1: MAP_HUGETLB flag (no mount needed on modern kernels) */
void *ptr = mmap(NULL, size, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB, -1, 0);

/* Option 2: 1GB pages */
void *ptr = mmap(NULL, size, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB | MAP_HUGE_1GB,
                 -1, 0);

/* Option 3: File on hugetlbfs */
int fd = open("/dev/hugepages/myfile", O_CREAT | O_RDWR, 0600);
void *ptr = mmap(NULL, size, PROT_READ | PROT_WRITE,
                 MAP_SHARED, fd, 0);
```

#### NUMA-Aware Pool Configuration

```bash
# Reserve pages on specific NUMA nodes
echo 512 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 512 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages
```

### THP Setup

```bash
# Global mode
echo always  > /sys/kernel/mm/transparent_hugepage/enabled   # All anonymous memory
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled   # Only MADV_HUGEPAGE regions
echo never   > /sys/kernel/mm/transparent_hugepage/enabled   # Disabled

# Defrag behavior (when to compact memory for huge pages)
echo always        > /sys/kernel/mm/transparent_hugepage/defrag  # Sync on fault (stalls)
echo defer         > /sys/kernel/mm/transparent_hugepage/defrag  # Async via khugepaged
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag  # Defer most, sync for hints
echo madvise       > /sys/kernel/mm/transparent_hugepage/defrag  # Only for MADV_HUGEPAGE
echo never         > /sys/kernel/mm/transparent_hugepage/defrag  # Never compact for THP

# khugepaged tuning
echo 10000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
echo 4096  > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
```

See the [THP kernel docs](https://docs.kernel.org/admin-guide/mm/transhuge.html) for all tunables.

## Monitoring

### hugetlbfs: /proc/meminfo

```bash
$ grep -i huge /proc/meminfo
AnonHugePages:    204800 kB    # THP usage (not hugetlbfs!)
ShmemHugePages:        0 kB
ShmemPmdMapped:        0 kB
HugePages_Total:    1024       # hugetlbfs pool size
HugePages_Free:      900       # Unused pages in pool
HugePages_Rsvd:       50       # Reserved but not yet faulted
HugePages_Surp:        0       # Surplus pages above nr_hugepages
Hugepagesize:       2048 kB    # Default huge page size
```

Key relationships:

- **HugePages_Total - HugePages_Free** = pages currently mapped by applications
- **HugePages_Rsvd** = pages promised to applications but not yet faulted in
- **Available** = HugePages_Free - HugePages_Rsvd

```bash
# Per-node hugetlbfs stats
cat /sys/devices/system/node/node0/hugepages/hugepages-2048kB/free_hugepages
cat /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
```

### THP: /sys/kernel/mm/transparent_hugepage/ and /proc/vmstat

```bash
$ grep thp /proc/vmstat
thp_fault_alloc 1234          # Huge pages allocated on page fault
thp_fault_fallback 56         # Fell back to 4KB on fault
thp_collapse_alloc 789        # Pages collapsed by khugepaged
thp_collapse_alloc_failed 12  # khugepaged collapse failures
thp_split_page 45             # Huge pages split back to 4KB
thp_zero_page_alloc 3         # Zero huge pages allocated
thp_swpout 0                  # Huge pages swapped out (as unit)
thp_swpout_fallback 0         # Swap fell back to splitting first
```

```bash
# Per-process THP usage
grep AnonHugePages /proc/<pid>/smaps_rollup

# Current THP mode
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
```

### Quick Health Check

```bash
#!/bin/bash
echo "=== hugetlbfs ==="
grep -i huge /proc/meminfo

echo ""
echo "=== THP ==="
echo "Mode: $(cat /sys/kernel/mm/transparent_hugepage/enabled)"
echo "Defrag: $(cat /sys/kernel/mm/transparent_hugepage/defrag)"
echo ""
echo "Allocations:"
grep -E "thp_fault_alloc|thp_fault_fallback|thp_collapse|thp_split" /proc/vmstat
```

## History

### hugetlbfs (v2.5.36, 2002)

**Commit**: hugetlbfs was added during the Linux 2.5 development series (pre-git era, 2002).

The implementation lives in [`fs/hugetlbfs/inode.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/hugetlbfs/inode.c) and [`mm/hugetlb.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/hugetlb.c). The original motivation came from database vendors (particularly Oracle and IBM) who needed huge pages on Linux to match the performance of proprietary Unix systems (AIX, Solaris, HP-UX) that had long supported them.

**LWN coverage**: [Huge pages part 1: Introduction](https://lwn.net/Articles/374424/) provides an overview of the mechanism and its history.

*Note: Linux 2.5 predates git (the kernel switched to git in April 2005 with 2.6.12). No commit IDs exist for the original hugetlbfs patches.*

Key milestones in hugetlbfs evolution:

- **v2.6.16 (2006)**: `MAP_HUGETLB` flag concept discussed; programs no longer strictly need a hugetlbfs mount point
- **v2.6.32 (2009)**: Commit [e5ff2159a434](https://git.kernel.org/linus/e5ff2159a434) ("hugetlb: add MAP_HUGETLB example") - `MAP_HUGETLB` available as mmap flag
- **v3.8 (2013)**: Commit [42d7395feb56](https://git.kernel.org/linus/42d7395feb56) ("mm: support more pagesizes for MAP_HUGETLB/SHM_HUGETLB") - encode page size in mmap flags (enabling 1GB pages via `MAP_HUGE_1GB`)

### THP (v2.6.38, 2011)

**Commit**: [71e3aac0724f](https://git.kernel.org/linus/71e3aac0724f) ("thp: transparent hugepage core")

**Author**: Andrea Arcangeli (Red Hat)

The initial THP implementation targeted anonymous memory for KVM virtual machines. The commit message explains the motivation: removing the restrictions of hugetlbfs while keeping the TLB benefits.

**LWN coverage**: [Transparent huge pages](https://lwn.net/Articles/423584/) covers the design and early reception.

Key milestones in THP evolution:

- **v3.11 (2013)**: `MADV_HUGEPAGE` / `MADV_NOHUGEPAGE` for per-VMA control
- **v4.13 (2017)**: Commit [38d8b4e6bdc8](https://git.kernel.org/linus/38d8b4e6bdc8) ("mm, THP, swap: delay splitting THP during swap out") - THP swap support (Huang Ying)
- **v5.4 (2019)**: Improved defrag modes (`defer+madvise`)
- **v6.10 (2024)**: Commit [19eaf44954df](https://git.kernel.org/linus/19eaf44954df) ("mm: thp: support allocation of anonymous multi-size THP") - multi-size THP (mTHP) enabling page sizes between 4KB and 2MB (Ryan Roberts)

### The Design Tension

hugetlbfs and THP represent a classic systems design trade-off: **explicit control vs automatic optimization**.

hugetlbfs gives the administrator full control. You know exactly how many huge pages exist, which applications use them, and there are no surprises. The cost is operational complexity and wasted memory if the pool is oversized.

THP removes the operational burden but introduces unpredictability. The kernel makes decisions that can help most workloads but hurt some. Years of bug fixes and tuning knobs (defrag modes, madvise hints, mTHP) show the ongoing effort to make the automatic approach work reliably.

Neither approach is going away. The kernel development community continues to improve both - hugetlbfs gets better NUMA support and accounting, while THP gets finer granularity (mTHP) and better heuristics.

## Try It Yourself

```bash
# === hugetlbfs ===

# Reserve 10 huge pages (2MB each = 20MB)
echo 10 > /proc/sys/vm/nr_hugepages

# Verify the pool
grep HugePages /proc/meminfo

# Mount hugetlbfs (if not already mounted)
mkdir -p /mnt/huge
mount -t hugetlbfs nodev /mnt/huge

# Write a small C program that uses MAP_HUGETLB and verify with:
grep HugePages /proc/meminfo   # HugePages_Free should decrease

# === THP ===

# Check current THP mode
cat /sys/kernel/mm/transparent_hugepage/enabled

# Run a program that allocates a large anonymous region:
#   void *p = mmap(NULL, 64*1024*1024, PROT_READ|PROT_WRITE,
#                  MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
#   memset(p, 0, 64*1024*1024);

# While it's running, check:
grep AnonHugePages /proc/<pid>/smaps_rollup
grep thp_fault_alloc /proc/vmstat

# === Compare latency ===

# With THP defrag=always, run a latency-sensitive workload and observe stalls:
echo always > /sys/kernel/mm/transparent_hugepage/defrag
# Then try:
echo never > /sys/kernel/mm/transparent_hugepage/defrag
# Compare tail latencies

# === Watch khugepaged ===
# In one terminal:
grep thp_collapse /proc/vmstat
# Run a workload, wait 10+ seconds, check again
grep thp_collapse /proc/vmstat
# The counter should increase as khugepaged collapses pages
```

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/hugetlb.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/hugetlb.c) | hugetlbfs pool management and fault handling |
| [`fs/hugetlbfs/inode.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/hugetlbfs/inode.c) | hugetlbfs filesystem implementation |
| [`mm/huge_memory.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/huge_memory.c) | THP core implementation |
| [`mm/khugepaged.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/khugepaged.c) | THP collapse daemon |

### Kernel Documentation

- [`Documentation/admin-guide/mm/hugetlbpage.rst`](https://docs.kernel.org/admin-guide/mm/hugetlbpage.html) - hugetlbfs admin guide
- [`Documentation/admin-guide/mm/transhuge.rst`](https://docs.kernel.org/admin-guide/mm/transhuge.html) - THP admin guide

### LWN Articles

- [Huge pages part 1: Introduction](https://lwn.net/Articles/374424/) (2010) - Overview of huge pages in Linux
- [Huge pages part 2: Interfaces](https://lwn.net/Articles/375096/) (2010) - hugetlbfs and libhugetlbfs
- [Huge pages part 3: Administration](https://lwn.net/Articles/376606/) (2010) - Pool management and NUMA
- [Transparent huge pages](https://lwn.net/Articles/423584/) (2011) - THP design and introduction
- [Multi-size THP](https://lwn.net/Articles/937239/) (2023) - mTHP motivation and design

### Related

- [Transparent Huge Pages](thp.md) - Deep dive on THP internals, bugs, and tuning
- [Compaction](compaction.md) - Memory defragmentation that THP depends on
- [Page Allocator](page-allocator.md) - The buddy allocator that serves both mechanisms
- [NUMA](numa.md) - Per-node huge page pools and THP NUMA interactions
- [Page Tables](page-tables.md) - PMD-level and PUD-level huge page mappings
