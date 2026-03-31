# Memory Bandwidth Optimization

> When latency is not the bottleneck — maximizing throughput across NUMA nodes

## The bandwidth wall

Most NUMA documentation focuses on latency: keep data close to the CPU that uses it. But a different bottleneck appears in bandwidth-bound workloads — large matrix operations, streaming analytics, ML training data shuffles, in-memory caches serving millions of keys per second. These workloads do not suffer from high latency on individual accesses so much as they hit a hard ceiling on how many bytes per second a single NUMA node can deliver.

Each NUMA node has a fixed memory bandwidth determined by its DDR controller and channel configuration. A dual-channel DDR5-4800 system delivers roughly 77 GB/s per channel × 2 channels ≈ **154 GB/s per node**. Modern server CPUs can each drive 20 GB/s or more of memory traffic at peak. The math closes quickly:

```
Node 0 peak bandwidth:   ~154 GB/s (2-channel DDR5-4800)
Peak per CPU core:       ~20 GB/s (sustained streaming)
Saturation point:        ~8 cores driving max bandwidth on one node

A 32-core system on one node: 4x over-subscribed
```

When all threads allocate from the same NUMA node, you get local latency but artificially cap throughput at one node's bandwidth. Distributing allocations across nodes multiplies available bandwidth at the cost of some remote-access latency. For bandwidth-bound workloads this trade-off is favorable.

!!! note "These numbers are illustrative"
    Actual bandwidth depends on your DDR generation, channel count, memory interleaving at the hardware level, and workload access pattern. Measure with `stream` on your target hardware.

## Bandwidth vs latency: choosing a strategy

The right strategy depends on whether your workload is latency-bound or bandwidth-bound:

| Workload type | Example | Bottleneck | Strategy |
|--------------|---------|------------|---------|
| Latency-bound | OLTP database, in-memory cache with sub-ms SLO | Access latency per operation | `MPOL_BIND` to local node; keep data near CPU |
| Bandwidth-bound | Large matrix multiply, ML data loading, Kafka consumers, Redis cluster | Aggregate GB/s | `MPOL_INTERLEAVE` across nodes; trade latency for bandwidth |
| Mixed | Multi-tenant server with varied workloads | Depends on tenant | Per-VMA policy; profile first |

The crossover point is workload-specific. A workload that repeatedly accesses a 512MB working set fits comfortably in one node's bandwidth budget. A workload that streams through 200GB of data per second does not. Profile before tuning.

## MPOL_INTERLEAVE: the kernel mechanism

`MPOL_INTERLEAVE` is Linux's primary tool for spreading memory allocations across NUMA nodes. It round-robins page allocations across a specified nodemask: page 0 goes to node 0, page 1 to node 1, and so on. Each node receives an approximately equal share of the region's physical pages.

The implementation lives in [`mm/mempolicy.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mempolicy.c). For process-level interleaving, `interleave_nodes()` advances `current->il_prev` through the policy nodemask on each allocation:

```c
/* mm/mempolicy.c */
static unsigned int interleave_nodes(struct mempolicy *policy)
{
    unsigned int nid;
    unsigned int cpuset_mems_cookie;

    do {
        cpuset_mems_cookie = read_mems_allowed_begin();
        nid = next_node_in(current->il_prev, policy->nodes);
    } while (read_mems_allowed_retry(cpuset_mems_cookie));

    if (nid < MAX_NUMNODES)
        current->il_prev = nid;
    return nid;
}
```

For VMA-based interleaving (used by `mbind()`), `interleave_nid()` derives the target node from the page's offset within the VMA, so the same page always maps to the same node even after a process restart with the same mapping layout.

See [NUMA memory management](numa.md) for the full policy API including `MPOL_BIND`, `MPOL_PREFERRED`, and `MPOL_LOCAL`.

### Applying MPOL_INTERLEAVE

**Per-process (set_mempolicy)** — all subsequent allocations by this process interleave across all nodes:

```c
#include <numaif.h>
#include <numa.h>

/* Interleave across all available nodes */
struct bitmask *all_nodes = numa_all_nodes_ptr;
set_mempolicy(MPOL_INTERLEAVE,
              all_nodes->maskp,
              all_nodes->size + 1);
```

**Per-region (mbind)** — apply interleave to a specific already-allocated region:

```c
#include <numaif.h>
#include <sys/mman.h>

void *buf = mmap(NULL, size, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

unsigned long nodemask = 0x3;  /* nodes 0 and 1 */
mbind(buf, size, MPOL_INTERLEAVE,
      &nodemask, 3,             /* maxnode = 3 (bits 0 and 1 valid) */
      MPOL_MF_MOVE);            /* migrate existing pages now */
```

**Command line (numactl)** — wrap an existing binary with no code changes:

```bash
# Interleave across all nodes
numactl --interleave=all ./myapp

# Interleave across specific nodes
numactl --interleave=0,1 ./myapp
```

### When to use MPOL_INTERLEAVE

!!! tip "Best-fit workloads for MPOL_INTERLEAVE"
    - **Large in-memory datasets**: memcached and Redis cluster instances that serve a dataset significantly larger than one node's bandwidth budget
    - **Scientific computing arrays**: NumPy/SciPy operations on arrays that fit in RAM but exceed single-node bandwidth
    - **ML training data loaders**: preprocessing pipelines that stream large datasets into GPU memory
    - **Analytics engines**: in-memory columnar stores (DuckDB, Spark on DRAM) performing full-table scans

### MPOL_WEIGHTED_INTERLEAVE

Linux 6.9 added `MPOL_WEIGHTED_INTERLEAVE` ([commit fa3bea4e1f82](https://git.kernel.org/linus/fa3bea4e1f82)), which distributes pages proportionally rather than evenly. If node 0 has 256 GB and node 1 has 128 GB, you can weight allocations 2:1 to match available capacity. The weights are configured via `/sys/kernel/mm/mempolicy/weighted_interleave/nodeN`.

## First-touch policy and its bandwidth implications

Linux uses **first-touch allocation**: the page is allocated on the NUMA node where the faulting thread is running at the time of the first write to that page. This is the most common reason deliberate interleaving fails silently.

The problem pattern:

```c
// Main thread (on node 0) initializes a large buffer
// All pages land on node 0 — MPOL_INTERLEAVE has no effect here
// because mbind was not called BEFORE the first touch
char *buf = malloc(10UL << 30);  /* 10 GB */
memset(buf, 0, 10UL << 30);      /* first touch: all pages go to node 0 */

// Now set policy and spawn workers — too late
set_mempolicy(MPOL_INTERLEAVE, ...);
spawn_workers(buf);
```

`MPOL_INTERLEAVE` via `set_mempolicy()` affects future allocations. Pages already faulted in are unaffected. Similarly, `mbind()` without `MPOL_MF_MOVE` changes the policy for future faults but does not migrate existing pages.

!!! tip "Fixing first-touch problems"
    **Option 1 — Set policy before first touch:**
    ```c
    set_mempolicy(MPOL_INTERLEAVE, &all_nodes_mask, max_node);
    char *buf = malloc(size);
    memset(buf, 0, size);  /* first touch now interleaves correctly */
    ```

    **Option 2 — mbind with MPOL_MF_MOVE:**
    ```c
    char *buf = malloc(size);
    memset(buf, 0, size);          /* all on node 0 */
    mbind(buf, size, MPOL_INTERLEAVE,
          &nodemask, max_node, MPOL_MF_MOVE);  /* migrates existing pages */
    ```

    **Option 3 — Parallel initialization:**
    ```c
    /* Pin workers to different nodes; each touches its own portion */
    #pragma omp parallel for schedule(static)
    for (size_t i = 0; i < n; i++)
        buf[i] = 0;
    ```

    Option 3 is the most effective for C++ programs with static or global initialization, where a single thread runs all constructors before `main()`.

## Hardware prefetchers and access pattern efficiency

The CPU's hardware prefetcher detects sequential access patterns and pre-fetches cache lines from memory before they are requested. This has direct implications for bandwidth utilization: a prefetcher-friendly access pattern saturates available bandwidth more effectively than a random one.

**Access pattern efficiency (approximate ranking)**:

```
Sequential (stride 1):   ~100% of peak bandwidth
Strided (stride 2-8):    50–80% of peak bandwidth
Strided (stride 16+):    25–50% of peak bandwidth
Random (pointer chase):  5–15% of peak bandwidth
```

For anonymous memory, the kernel has no visibility into the access pattern — the hardware prefetcher operates independently. But for **file-backed pages**, the kernel's readahead mechanism provides a software analogue: it detects sequential file reads and issues speculative `page_cache_ra_unbounded()` calls to bring pages into the page cache before they are faulted in. This is effective for streaming analytics on files but not for anonymous heap allocations.

### Row-major vs column-major

Matrix code is the canonical example. For a row-major C array `A[rows][cols]`:

```c
/* Bandwidth-friendly: sequential access, prefetcher happy */
for (int i = 0; i < rows; i++)
    for (int j = 0; j < cols; j++)
        sum += A[i][j];

/* Bandwidth-unfriendly: column-major stride = cols * sizeof(float) */
for (int j = 0; j < cols; j++)
    for (int i = 0; i < rows; i++)
        sum += A[i][j];
```

The column-major loop on a 10,000×10,000 float array has a stride of 40,000 bytes between accesses. This defeats the prefetcher and reduces effective bandwidth by 5–10x on a typical server.

!!! tip "For bandwidth-bound matrix workloads"
    Combine `MPOL_INTERLEAVE` with row-major access patterns and 2MB huge pages. Each component addresses a different bottleneck: interleave adds aggregate bandwidth, row-major access enables prefetching, and huge pages reduce TLB overhead on large arrays.

## Transparent huge pages and bandwidth

[Transparent huge pages](thp.md) reduce TLB pressure by mapping memory in 2MB blocks instead of 4KB. Fewer TLB entries means more of the CPU's memory access capacity goes to actual data transfers rather than page-table walks.

For large bandwidth-bound workloads, the combination `THP + MPOL_INTERLEAVE` addresses two separate bottlenecks:

| Mechanism | What it fixes |
|-----------|---------------|
| `MPOL_INTERLEAVE` | Single-node bandwidth ceiling |
| THP (2MB pages) | TLB thrashing on large working sets |

Enable THP for the relevant region:

```c
void *buf = mmap(NULL, size, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
madvise(buf, size, MADV_HUGEPAGE);     /* request THP */

unsigned long nodemask = (1UL << nr_nodes) - 1;
set_mempolicy(MPOL_INTERLEAVE, &nodemask, nr_nodes + 1);

memset(buf, 0, size);  /* first touch: interleaved 2MB huge pages */
```

Note: with THP enabled, khugepaged may collapse adjacent 4KB pages into a 2MB page asynchronously. The resulting huge page lands on whichever node held most of its component 4KB pages. If interleaving is done correctly at first-touch time, this should not cause problems. See [THP](thp.md) for the interaction between NUMA balancing and THP.

## NUMA balancing and deliberate interleaving

NUMA automatic balancing (`/proc/sys/kernel/numa_balancing`) works by periodically unmapping pages to catch access faults, then migrating pages toward the nodes that access them most. For most workloads this is beneficial. For deliberately interleaved workloads, it can silently undo your tuning by migrating all pages toward the node where the majority of threads run.

```bash
# Check current state
cat /proc/sys/kernel/numa_balancing

# Disable for deliberately interleaved workloads
echo 0 > /proc/sys/kernel/numa_balancing
```

!!! tip "When to disable NUMA balancing"
    Disable NUMA balancing when:

    - You have explicitly set `MPOL_INTERLEAVE` and want to preserve the distribution
    - The workload accesses memory evenly from all nodes (e.g., each worker thread processes its own shard)
    - You see unexpectedly high `numa_miss` counts after interleaving is set up correctly

    Leave NUMA balancing enabled when:

    - You have not set explicit policies
    - The workload's access pattern is irregular or changes over time
    - You need the kernel to automatically correct poor initial placement

Also note: **kernel allocations are not subject to user mempolicies**. `set_mempolicy()` and `mbind()` affect user-space virtual memory regions only. Kernel data structures (slab objects, page tables, network buffers) are allocated by the kernel's own NUMA-aware allocator and are not interleaved by user policy.

## Measuring memory bandwidth

### Benchmark tools

**`stream`** — the gold standard for measuring sustainable memory bandwidth:

```bash
# Build stream benchmark
wget https://www.cs.virginia.edu/stream/FTP/Code/stream.c
gcc -O3 -march=native -fopenmp stream.c -o stream
./stream

# Example output:
# Function    Best Rate MB/s  Avg time     Min time     Max time
# Copy:          145234.4     0.011004     0.010983     0.011031
# Scale:         140123.8     0.011388     0.011419     0.011375
# Add:           148902.1     0.016134     0.016117     0.016152
# Triad:         149015.3     0.016100     0.016105     0.016093

# Measure bandwidth per NUMA node
numactl --membind=0 ./stream    # node 0 only
numactl --membind=1 ./stream    # node 1 only
numactl --interleave=all ./stream  # interleaved
```

**`mbw`** — simpler bandwidth measurement:

```bash
mbw 1024    # test with 1GB
```

### Topology inspection

```bash
# Inspect NUMA hardware topology
numactl --hardware

# Example output:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
# node 0 size: 129020 MB
# node 0 free: 121432 MB
# node 1 cpus: 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
# node 1 size: 131072 MB
# node 1 free: 122804 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# Per-process NUMA distribution
numastat -m -p <pid>

# Example output:
#                           Per-node process memory usage (MB)
#                                            Node 0   Node 1    Total
#                           --------------- -------- -------- --------
# myapp (pid 12345)            Private           987      991     1978
```

### Hardware performance counters

```bash
# LLC misses indicate memory traffic leaving the cache hierarchy
perf stat -e LLC-load-misses,LLC-store-misses -p <pid>

# NUMA-specific events (Intel, where supported)
perf stat -e offcore_response.all_requests.l3_miss.any_snoop \
          -p <pid>
```

### /proc/vmstat NUMA counters

```bash
cat /proc/vmstat | grep numa
```

The key counters (confirmed in [`mm/vmstat.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmstat.c)):

| Counter | Meaning | What a high value means |
|---------|---------|------------------------|
| `numa_hit` | Allocations satisfied on the preferred node | Good: memory landing where intended |
| `numa_miss` | Allocations that fell through to a non-preferred node | High miss rate: node pressure, or interleave not set |
| `numa_foreign` | Pages intended for this node that were placed elsewhere | Cross-node pressure |
| `numa_interleave` | Allocations placed by `MPOL_INTERLEAVE` | Confirms interleave policy is active |
| `numa_local` | Allocations on the same node as the running thread | High: good for latency-bound workloads |
| `numa_other` | Allocations on a different node than the running thread | High: remote allocations (may be intentional with interleave) |

!!! tip "Reading the counters"
    A healthy interleaved workload shows high `numa_interleave` and roughly equal `N0` and `N1` counts in `numastat -m`. A high `numa_miss` with low `numa_interleave` suggests first-touch placement is concentrating pages on one node despite your policy setting.

## CXL memory and bandwidth tiering

CXL (Compute Express Link) memory appears to Linux as additional NUMA nodes with no attached CPUs. The bandwidth of a PCIe Gen 5 x16 CXL link is lower than local DRAM (local DDR5 ≈ 150+ GB/s vs. CXL over PCIe Gen 5 x16 ≈ 64 GB/s bidirectional), but higher than NVMe. CXL is appropriate for cold data that needs fast access but does not need the full bandwidth of local DRAM.

For bandwidth-bound workloads, CXL nodes are generally not suitable targets for `MPOL_INTERLEAVE` — spreading hot data to a lower-bandwidth tier reduces aggregate throughput. CXL is better used through the kernel's automatic memory tiering (demotion of cold pages from DRAM to CXL).

See [CXL Memory Tiering](cxl-memory-tiering.md) for the kernel's tiering framework and how CXL nodes are assigned to tiers based on HMAT/CDAT performance data.

## Decision flowchart

```
Is your workload memory bandwidth-bound?
  |
  No → Focus on MPOL_BIND / latency; bandwidth is not the issue
  |
  Yes
  |
  ├── Single NUMA node?
  │     Yes → Bandwidth ceiling is fixed; consider CXL or upgrade
  │     No ↓
  |
  ├── Are pages landing where you expect?
  │     Check: numastat -m, /proc/vmstat numa_interleave
  │     No → First-touch problem → see "First-touch" section above
  │     Yes ↓
  |
  ├── Is NUMA balancing migrating pages away from interleave?
  │     Check: watch -n1 'cat /proc/vmstat | grep numa'
  │     Yes → echo 0 > /proc/sys/kernel/numa_balancing
  │     Already off ↓
  |
  └── Are access patterns sequential?
        No → Optimize data layout (row-major, structure of arrays)
        Yes → Add MADV_HUGEPAGE for TLB headroom
```

## Key source files

| File | Description |
|------|-------------|
| [`mm/mempolicy.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mempolicy.c) | `MPOL_INTERLEAVE` and `MPOL_WEIGHTED_INTERLEAVE` implementation; `interleave_nodes()`, `interleave_nid()` |
| [`include/linux/mempolicy.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mempolicy.h) | `struct mempolicy`, policy mode constants |
| [`include/uapi/linux/mempolicy.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/mempolicy.h) | Userspace-visible policy constants (`MPOL_INTERLEAVE`, `MPOL_WEIGHTED_INTERLEAVE`, etc.) |
| [`mm/vmstat.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmstat.c) | `numa_hit`, `numa_miss`, `numa_interleave` counter names |
| [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) | Where `NUMA_HIT`/`NUMA_MISS` counters are incremented |
| [`arch/x86/mm/numa.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/numa.c) | x86 NUMA topology discovery from ACPI SRAT/SLIT |

## References

### Kernel documentation

- [`Documentation/admin-guide/mm/numa_memory_policy.rst`](https://docs.kernel.org/admin-guide/mm/numa_memory_policy.html)
- [`Documentation/mm/numa.rst`](https://docs.kernel.org/mm/numa.html) — NUMA balancing implementation details

### Mailing list discussions

- [MPOL_WEIGHTED_INTERLEAVE introduction](https://lore.kernel.org/linux-mm/20231117-weighted-interleave-v6-0-d1af872c78aa@quicinc.com/) — Gregory Price (Qualcomm), Nov 2023
- [NUMA balancing and THP interaction](https://lore.kernel.org/linux-mm/20130926103049.GM19413@suse.de/) — Mel Gorman on THP NUMA migration design

### External benchmarks

- [STREAM benchmark](https://www.cs.virginia.edu/stream/) — McCalpin, J.D., standard for memory bandwidth measurement

### Related

- [NUMA memory management](numa.md) — policy API, automatic balancing, monitoring
- [Transparent huge pages](thp.md) — THP configuration, khugepaged, TLB pressure
- [CXL Memory Tiering](cxl-memory-tiering.md) — heterogeneous memory tiers
- [Tuning databases](tuning-databases.md) — huge pages, THP, and latency-sensitive workloads

## Further reading

- [Kernel docs: NUMA memory policy](https://docs.kernel.org/admin-guide/mm/numa_memory_policy.html) — complete reference for `set_mempolicy()`, `mbind()`, and all policy modes including `MPOL_WEIGHTED_INTERLEAVE`
- [`Documentation/admin-guide/mm/numa_memory_policy.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/admin-guide/mm/numa_memory_policy.rst) — kernel source for the NUMA memory policy admin guide
- [`mm/mempolicy.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mempolicy.c) — `MPOL_INTERLEAVE` and `MPOL_WEIGHTED_INTERLEAVE` implementation; `interleave_nodes()` and `interleave_nid()`
- [LWN: NUMA in a hurry](https://lwn.net/Articles/486858/) — practical introduction to NUMA topology and the pitfalls of first-touch allocation (2012)
- [LWN: Weighted interleave memory policy](https://lwn.net/Articles/948552/) — rationale and design of `MPOL_WEIGHTED_INTERLEAVE` for heterogeneous memory capacity (2023)
- [STREAM benchmark](https://www.cs.virginia.edu/stream/) — McCalpin's standard for measuring sustainable memory bandwidth; essential for calibrating any bandwidth optimization
- [numa.md](numa.md) — NUMA balancing implementation, `node_distance`, fallback zone lists, and the full mempolicy API
- [cxl-memory-tiering.md](cxl-memory-tiering.md) — why CXL nodes are poor interleave targets and how the tier framework assigns bandwidth-appropriate placement
- [thp.md](thp.md) — transparent huge pages and their interaction with NUMA balancing and bandwidth-bound workloads
