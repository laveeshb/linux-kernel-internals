# CXL Memory and Kernel Memory Tiering

> Expanding past DRAM limits with CXL and the kernel's memory tier framework

## CXL memory as a NUMA node

Compute Express Link (CXL) is a high-speed cache-coherent interconnect built on PCIe that allows memory expansion cards to be attached to a CPU. From the operating system's perspective, CXL memory appears as a **NUMA node with no CPUs** — a memory-only node with higher access latency than local DRAM.

CXL 1.1 and 2.0 devices connect over a single PCIe link. Latency to CXL memory is higher than DDR because the request must traverse the PCIe fabric, though the gap varies with hardware and link generation. CXL 3.0 adds fabric-level switching that enables multi-host sharing and additional topologies.

!!! note "Actual latency and bandwidth are hardware-specific"
    Do not treat any specific latency or bandwidth figure as a guarantee. Real-world numbers depend on the CXL device, host memory controller, and platform. The kernel uses performance measurements from HMAT (Heterogeneous Memory Attribute Table) or CXL CDAT tables to place devices into the correct tier — not hardcoded values.

The Linux CXL driver registers each CXL memory region as a NUMA node during region activation. The region's performance characteristics are read from the `access_coordinate` data (populated from CDAT) and passed to the memory tier framework through a notifier. The relevant call chain in `drivers/cxl/core/region.c` is:

```c
/* drivers/cxl/core/region.c */
static int cxl_region_calculate_adistance(struct notifier_block *nb,
                                          unsigned long nid, void *data)
{
    struct cxl_region *cxlr = container_of(nb, struct cxl_region,
                                           adist_notifier);
    struct access_coordinate *perf;
    int *adist = data;

    perf = &cxlr->coord[ACCESS_COORDINATE_CPU];
    if (mt_perf_to_adistance(perf, adist))
        return NOTIFY_OK;
    return NOTIFY_STOP;
}
```

`mt_perf_to_adistance()` converts the hardware performance coordinates into an abstract distance value that the memory tier framework uses to assign the node to a tier.

## The memory tier framework

### Abstract distance

The kernel represents memory speed as an **abstract distance** — a dimensionless integer where smaller means faster. Regular DRAM has a reference abstract distance defined by `MEMTIER_ADISTANCE_DRAM`:

```c
/* include/linux/memory-tiers.h */
#define MEMTIER_CHUNK_BITS   7
#define MEMTIER_CHUNK_SIZE   (1 << MEMTIER_CHUNK_BITS)   /* 128 */

/* Offset slightly so devices marginally faster than DRAM share the tier */
#define MEMTIER_ADISTANCE_DRAM  ((4L * MEMTIER_CHUNK_SIZE) + (MEMTIER_CHUNK_SIZE >> 1))
```

Each `memory_tier` covers a range of abstract distance values of width `MEMTIER_CHUNK_SIZE` (128). Devices whose abstract distance falls in the same 128-unit window are grouped into the same tier. A smaller `adistance_start` means a higher (faster) tier.

### Tier assignment

A NUMA node is assigned to a tier through `struct memory_dev_type`:

```c
/* include/linux/memory-tiers.h */
struct memory_dev_type {
    struct list_head tier_sibling;  /* other types in same tier */
    struct list_head list;          /* types managed by one driver */
    int adistance;                  /* this type's abstract distance */
    nodemask_t nodes;               /* nodes of this abstract distance */
    struct kref kref;
};
```

At boot, `memory_tier_init()` places all online nodes into a default tier using `default_dram_type`. When a CXL region activates, its driver registers an adistance notifier (`register_mt_adistance_algorithm()`). The framework then calls the notifier chain, the CXL driver reports the CXL region's adistance, and `find_create_memory_tier()` either places the node in an existing tier or creates a new one.

### Sysfs representation

Memory tiers are visible under:

```
/sys/devices/virtual/memory_tiering/memory_tierN/
    nodelist   # NUMA nodes in this tier
```

The `N` in `memory_tierN` is derived from the tier's `adistance_start` shifted right by `MEMTIER_CHUNK_BITS`. A lower `N` means a higher (faster) tier.

On a system with local DRAM (node 0) and a CXL expansion node (node 1), you might see:

```
/sys/devices/virtual/memory_tiering/memory_tier4/nodelist  → 0
/sys/devices/virtual/memory_tiering/memory_tier8/nodelist  → 1
```

!!! note "The tier numbering is derived from abstract distance, not from insertion order"
    Two systems with the same hardware topology will have the same tier numbers because they are computed from the performance coordinates, not assigned sequentially.

### Demotion target topology

The framework builds a `node_demotion[]` array that maps each NUMA node to its preferred demotion target. Given three nodes:

```
memory_tier0 (fastest) → node 1  (HBM)
memory_tier1           → node 0  (DRAM)
memory_tier2 (slowest) → node 2  (CXL/PMEM)
```

The demotion paths would be:
- node 1 (HBM) → node 0 (DRAM)
- node 0 (DRAM) → node 2 (CXL)
- node 2 (CXL) → nowhere (terminal)

`next_demotion_node()` in `mm/memory-tiers.c` returns the preferred demotion target, choosing randomly among nodes in the preferred mask if multiple targets exist.

`node_is_toptier()` returns true for nodes in tiers at or above `top_tier_adistance`. Top-tier nodes are never demoted to.

## Page demotion: kswapd driving the slow path

When the kernel reclaims memory under memory pressure, it prefers to **demote** cold pages from fast to slow memory rather than swap them to disk. This is implemented in `mm/vmscan.c`.

### When demotion fires

The key predicate is `can_demote()` in `mm/vmscan.c`:

```c
static bool can_demote(int nid, struct scan_control *sc, struct mem_cgroup *memcg)
```

It returns true if the node has a valid demotion target (a lower tier with free capacity) and `numa_demotion_enabled` is set. When demotion is available, the reclaim path builds a `demote_folios` list alongside the normal `folio_list`:

```c
/* mm/vmscan.c — shrink_folio_list() */
if (do_demote_pass &&
    can_demote_folio(folio, ...))
    list_add(&folio->lru, &demote_folios);
```

`demote_folio_list()` then calls `migrate_pages()` to move those folios to the demotion target node. Folios that cannot be demoted (no space on the target, migration failure) are returned to the reclaim list and may be swapped.

The kernel prefers demotion to swapping because accessing demoted memory is typically much faster than a swap I/O, and because it keeps data in memory rather than discarding it.

!!! tip "Enable demotion with numa_demotion_enabled"
    Demotion is controlled by the `numa_demotion_enabled` variable, exposed as:
    ```
    /proc/sys/kernel/numa/demotion_enabled
    ```
    It defaults to disabled. Write `1` to enable. Without this, kswapd will swap to disk (or zswap) rather than demote to CXL.

### vmstat counters for demotion

`/proc/vmstat` tracks demotion events by initiator:

| Counter | Meaning |
|---------|---------|
| `pgdemote_kswapd` | Pages demoted by kswapd background reclaim |
| `pgdemote_direct` | Pages demoted by direct reclaim (allocating process) |
| `pgdemote_khugepaged` | Pages demoted during khugepaged split |
| `pgdemote_proactive` | Pages demoted by proactive reclaim |

## Page promotion: NUMA balancing driving the fast path

**Promotion** is the reverse: moving a hot page from slow memory (CXL) to fast memory (DRAM). The mechanism is NUMA balancing.

NUMA balancing works by periodically unmapping pages from their page tables (NUMA hinting faults). When the page is accessed, a minor fault fires and the kernel observes which CPU accessed the page. If a page in CXL memory is being accessed frequently by a CPU whose local DRAM is on a higher tier, the kernel migrates the page to that faster tier.

The memory tiering mode of NUMA balancing is activated by setting bit 1 of `numa_balancing_mode`:

```c
/* include/linux/sched/sysctl.h */
#define NUMA_BALANCING_MEMORY_TIERING  0x2
extern int sysctl_numa_balancing_mode;
```

When `NUMA_BALANCING_MEMORY_TIERING` is active, the `folio_use_access_time()` function repurposes the folio's `_last_cpupid` field to record page access time instead of the last CPU/PID. This lets the balancer identify hot pages in slow memory based on access recency rather than CPU affinity alone.

### vmstat counters for promotion

| Counter | Meaning |
|---------|---------|
| `pgpromote_success` | Pages successfully promoted to a faster tier |
| `pgpromote_candidate` | Pages identified as candidates for promotion |
| `pgpromote_candidate_nrl` | Candidates skipped (not recently local) |

## DAMON integration for cold-page demotion

DAMON (Data Access MONitor) can be used to identify cold pages in fast memory and demote them proactively, before memory pressure forces kswapd to act.

The relevant DAMOS (DAMON-based Operation Scheme) action is `DAMOS_MIGRATE_COLD`:

```c
/* include/linux/damon.h */
enum damos_action {
    DAMOS_WILLNEED,
    DAMOS_COLD,
    DAMOS_PAGEOUT,       /* reclaim to swap — does NOT demote */
    DAMOS_HUGEPAGE,
    DAMOS_NOHUGEPAGE,
    DAMOS_MIGRATE_HOT,
    DAMOS_MIGRATE_COLD,  /* migrate cold regions to a slower node */
    ...
};
```

!!! warning "DAMOS_PAGEOUT does not demote"
    `DAMOS_PAGEOUT` reclaims pages to swap or zswap. It does **not** migrate pages to a CXL node. Use `DAMOS_MIGRATE_COLD` when the goal is tiered memory demotion.

A DAMON scheme configured with `DAMOS_MIGRATE_COLD` and a target that includes CXL nodes will proactively move cold pages from DRAM to CXL, keeping warm pages in fast memory without waiting for memory pressure.

See the [DAMON documentation](damon.md) for details on configuring DAMON schemes via `/sys/kernel/mm/damon/`.

## Configuration

### Automatic with CXL hardware

On a system where the BIOS provides valid HMAT or CDAT tables and the CXL driver is loaded, the memory tier framework configures itself automatically at boot:

1. `memory_tier_init()` places existing NUMA nodes in the default DRAM tier.
2. CXL region activation registers an adistance notifier.
3. The framework assigns the CXL node to a tier based on its measured abstract distance.
4. `establish_demotion_targets()` builds the `node_demotion[]` table.

No manual configuration is needed beyond enabling demotion and the desired NUMA balancing mode.

### Sysctl knobs

```
/proc/sys/kernel/numa/demotion_enabled
```
Enable or disable demotion (0/1). Defaults to 0 (disabled).

```
/proc/sys/kernel/numa_balancing
```
Bitmap controlling NUMA balancing behavior. Set bit 1 (`value |= 2`) to enable memory tiering mode alongside normal NUMA balancing.

### numactl for manual placement

On systems without automatic CXL tier setup, or for testing, `numactl` can bind allocations to specific nodes:

```bash
# Allocate from node 1 (CXL) preferring node 0 (DRAM) on overflow
numactl --preferred=0 --membind=0,1 ./my_process

# Force allocation from CXL node only
numactl --membind=1 ./my_process
```

## Monitoring

### /proc/vmstat

The demotion and promotion counters described above are available in `/proc/vmstat` and via `sar`, `vmstat`, or `perf stat`:

```bash
watch -n 1 'grep -E "pgdemote|pgpromote" /proc/vmstat'
```

A healthy tiered-memory system under light pressure shows steady `pgdemote_kswapd` activity moving cold pages to CXL, and occasional `pgpromote_success` events when NUMA balancing moves hot pages back to DRAM.

### Tier membership

```bash
cat /sys/devices/virtual/memory_tiering/memory_tier*/nodelist
```

Shows which NUMA nodes belong to which tier.

### Tracepoints

`mm/vmscan.c` does not currently have dedicated tiering tracepoints, but the standard `mm_migrate_pages` tracepoint (`include/trace/events/migrate.h`) fires for every demotion migration and reports the migration mode and reason.

## Current limitations

**Automatic CXL node detection requires firmware cooperation.** If HMAT or CDAT data is absent or incorrect, the CXL node may land in the same tier as DRAM and demotion will not occur. Check `dmesg` for messages from the CXL driver and memory tier framework at boot.

**Demotion does not respect `cpusets.mems_allowed` in kernels before the fix landed in v6.15 and later patches.** Pages belonging to a cgroup may be demoted to nodes outside its `mems_allowed` set. This is a known limitation documented in `Documentation/driver-api/cxl/allocation/reclaim.rst`.

**khugepaged may conflict with tiering.** When khugepaged splits a THP on a CXL node, the `pgdemote_khugepaged` counter increments. In some configurations, khugepaged activity can re-promote pages that demotion just moved.

**NUMA balancing promotion adds overhead.** The balancer works by unmapping pages (causing faults on next access) to observe access patterns. On CXL nodes with cold pages this is usually fine, but misconfigured schemes that promote too aggressively can increase fault rates.

!!! note "This area is actively developed"
    Memory tiering, CXL support, and the interaction between DAMON, kswapd, and NUMA balancing are actively changing across kernel versions. Always check the kernel version's changelog when relying on specific behaviors described here.
