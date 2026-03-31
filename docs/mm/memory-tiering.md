# Memory Tiering

> Managing heterogeneous memory: DRAM, CXL, PMEM, and HBM

## Why memory tiering?

Modern servers increasingly have multiple memory types with different performance characteristics:

| Memory type | Bandwidth | Latency | Capacity | Cost |
|-------------|-----------|---------|----------|------|
| HBM (on-package) | 1+ TB/s | ~10ns | 32-128GB | High |
| DDR5 DRAM | 50-100 GB/s | ~80ns | 256GB-4TB | Medium |
| CXL memory | 30-50 GB/s | ~200ns | 1-16TB | Lower |
| PMEM (Optane) | 20-40 GB/s | ~300ns | 1-8TB | Lowest |

The kernel must:
1. **Identify** which memory node belongs to which tier
2. **Place** hot pages on fast memory, cold pages on slow memory
3. **Promote** cold pages that become hot
4. **Demote** hot pages that go cold (under memory pressure)

## Memory tiers

```c
/* include/linux/memory-tiers.h */
struct memory_tier {
    struct list_head    list;
    struct list_head    memory_types;  /* memory types (NUMA nodes) in this tier */
    int                 adistance;     /* abstract distance: lower = faster */
    struct device       dev;
};

/* Default tier assignments: */
/* DRAM: adistance = DRAM_ADISTANCE (200) */
/* CXL:  adistance = CXL_ADISTANCE  (300) */
/* PMEM: adistance = PMEM_ADISTANCE  (400) */
```

### Tier discovery

```bash
# View memory tiers
cat /sys/devices/virtual/memory_tiering/memory_tierN/adistance
# 200   ← DRAM tier

# NUMA nodes and their tier assignment
for node in /sys/devices/system/node/node*/; do
    echo -n "$(basename $node): "
    cat "$node/memory_tier" 2>/dev/null || echo "none"
done

# numactl: shows memory nodes
numactl --hardware
# available: 4 nodes (0-3)
# node 0 cpus: 0-15
# node 0 size: 256000 MB     ← DRAM
# node 2 cpus:               ← no CPUs: CXL or PMEM memory node
# node 2 size: 512000 MB
```

## Page demotion

When fast memory is under pressure, the kernel demotes cold pages to slow memory nodes:

```c
/* mm/migrate.c */
int migrate_pages_to_node(struct list_head *pagelist, int node,
                           enum migrate_mode mode)
{
    /* Move pages from list to the specified NUMA node */
    return migrate_pages(pagelist, alloc_migration_target_page,
                          NULL, node, mode, MR_DEMOTION);
}

/* mm/vmscan.c: kswapd demotes when fast memory is low */
static bool demote_page_list(struct list_head *demote_pages,
                              struct pglist_data *pgdat)
{
    int target_nid = next_demotion_node(pgdat->node_id);
    if (target_nid == NUMA_NO_NODE)
        return false;  /* no slower tier available */

    return migrate_pages_to_node(demote_pages, target_nid, MIGRATE_ASYNC) == 0;
}
```

```bash
# Monitor page demotions
cat /proc/vmstat | grep pgdemote
# pgdemote_kswapd   12345   ← pages demoted by kswapd
# pgdemote_direct   678     ← pages demoted during direct reclaim
```

## Page promotion

When a page on slow memory is frequently accessed, NUMA Balancing or the tier migration daemon can promote it to fast memory:

```c
/* mm/numa_balancing.c */
static int numa_migrate_preferred(struct task_struct *p)
{
    unsigned long interval = msecs_to_jiffies(task_scan_period(p));
    /* Migrate pages used by this task to the task's preferred NUMA node */
    /* If preferred node is in a faster tier, this is a promotion */
}
```

### Explicit promotion via memory_tier sysfs

```bash
# Set a page's NUMA node migration policy
numactl --preferred=0 myprogram  # prefer DRAM (node 0)

# Move all pages of a process to DRAM
numactl --membind=0 --pid=1234 migrate

# Check current page placement
numastat -p <pid>
# Per-node memory use of process:
# N0      N1      N2      N3
# 512.0   128.0   0.0     1024.0  (MB)
```

## Tiered memory allocation

The kernel allocates from faster tiers first, falling back to slower:

```c
/* mm/page_alloc.c */
static struct page *get_page_from_freelist(gfp_t gfp_mask, unsigned int order,
                                            int alloc_flags,
                                            const struct alloc_context *ac)
{
    struct zoneref *z;
    struct zone *zone;

    /* Zonelist is ordered: faster memory zones listed first */
    for_next_zone_zonelist_nodemask(zone, z, ac->zonelist, ac->highest_zoneidx,
                                    ac->nodemask) {
        /* Try to allocate from this zone */
        page = rmqueue(ac->preferred_zoneref->zone, zone, order,
                        gfp_mask, alloc_flags, ac->migratetype);
        if (page)
            return page;
    }
    return NULL;
}
```

The zonelist order is set by `build_zonelists()` which considers NUMA distance. With memory tiers, CXL memory at distance 300 is listed after DRAM at distance 200.

## CXL (Compute Express Link) memory

CXL is a PCIe-based memory expansion standard that allows attaching DRAM at higher latency than on-package DDR:

```bash
# Check CXL devices
ls /sys/bus/cxl/devices/
# mem0  mem1  (CXL memory devices)

# CXL memory region
cat /sys/bus/cxl/devices/mem0/size

# Binding CXL memory to a NUMA node
# (done by firmware/BIOS, then exposed as NUMA node N)
cat /sys/devices/system/node/node2/memory_tier
# memory_tier2    ← CXL assigned to tier 2
```

## PMEM (Persistent Memory)

Optane DIMM and future persistent memory devices:

```bash
# ndctl: NVDIMM control
ndctl list
# [{
#   "dev":"namespace0.0",
#   "mode":"fsdax",
#   "size":549755813888,
#   "sector_size":512
# }]

# Mount PMEM as DAX (direct access, no page cache)
mount -o dax /dev/pmem0 /mnt/pmem

# Use PMEM as a memory tier (volatile, no persistence)
# Configure via kernel boot parameter:
# memmap=4G!4G  ← use 4G starting at 4G as PMEM (emulate with DRAM)
```

## NUMA migration policies

```bash
# System-wide NUMA migration policy
cat /proc/sys/kernel/numa_balancing
# 1 = enabled

# Per-process migration control
cat /proc/<pid>/numa_maps | head -5
# 7f1234560000 default anon=4 dirty=4 N0=4 kernelpagesize_kB=4
#                                     ^^^ all pages on NUMA node 0

# Force pages to specific node
numactl --membind=2 ./myapp  # allocate from node 2 (CXL)

# Check page NUMA placement
cat /proc/<pid>/numa_maps | awk '{print $2}' | sort | uniq -c
```

## Hot page detection for promotion

The kernel uses PTE access bits and page fault sampling to identify hot pages on slow tiers:

```c
/* mm/numa_balancing.c — NUMA balancing fault handler */
static int do_numa_page(struct vm_fault *vmf)
{
    struct page *page = vmf->page;
    int current_nid = page_to_nid(page);
    int target_nid  = numa_migrate_prep(page, vmf, vmf->address,
                                         current_nid, &flags);

    if (target_nid != current_nid) {
        /* Target is in faster tier: promote this page */
        migrate_misplaced_page(page, vmf, target_nid);
    }
    return 0;
}
```

## Observing memory tiering

```bash
# Memory tier statistics
cat /sys/kernel/debug/memory_tiering/

# Promotion/demotion rates
watch -n 1 'grep -E "pgpromote|pgdemote" /proc/vmstat'

# Per-tier allocation stats
cat /sys/devices/system/node/node*/vmstat | grep -E "nr_free|nr_active|nr_inactive"

# Numastat: per-node allocation stats
numastat
# Per-node process memory usage:
#                     Node 0    Node 2
#            Huge         0         0
#          Heap       1234.5   456.7
#           Stack        2.1      0.0

# CXL bandwidth monitoring
perf stat -e uncore_imc/data_reads/,uncore_imc/data_writes/ -a sleep 5
```

## Further reading

- [NUMA](numa.md) — NUMA topology fundamentals
- [CXL Memory Tiering](cxl-memory-tiering.md) — CXL-specific details
- [Page Reclaim](reclaim.md) — how demotion integrates with reclaim
- [MGLRU](mglru.md) — generation-based LRU, key for identifying cold pages
- `mm/memory-tiers.c` in the kernel tree — tier management
- `Documentation/admin-guide/mm/memory-tiers.rst` in the kernel tree
