# NUMA Effects on Memory Reclaim

> How per-node watermarks, per-node kswapd threads, and NUMA balancing interact to shape memory reclaim on multi-socket systems — and what can go wrong when a remote node is under pressure.

## Background: NUMA memory is node-local

On a NUMA system each physical CPU socket (a **node**) owns a bank of memory. The kernel represents each node as a `pg_data_t` (also called `pgdat`). Each `pgdat` contains one or more zones (`struct zone`), and each zone maintains its own watermark thresholds.

```
System with 2 NUMA nodes
────────────────────────────────────────────────────────────
  Node 0 (pgdat 0)                Node 1 (pgdat 1)
  ┌────────────────────┐          ┌────────────────────┐
  │ zone: ZONE_DMA     │          │ zone: ZONE_DMA     │
  │ zone: ZONE_DMA32   │          │ zone: ZONE_DMA32   │
  │ zone: ZONE_NORMAL  │          │ zone: ZONE_NORMAL  │
  │                    │          │                    │
  │  kswapd0 thread    │          │  kswapd1 thread    │
  └────────────────────┘          └────────────────────┘
```

There is **one kswapd kernel thread per node**, not one for the whole system. Reclaim accounting, watermarks, and LRU lists are all per-node. This is the fundamental fact that drives everything else in this document.

---

## Per-node watermarks

Every `struct zone` stores its own watermark array:

```c
/* include/linux/mmzone.h */
enum zone_watermarks {
    WMARK_MIN,
    WMARK_LOW,
    WMARK_HIGH,
    WMARK_PROMO,        /* used when memory-tiering NUMA balancing is on */
    NR_WMARK
};

struct zone {
    /* ... */
    unsigned long _watermark[NR_WMARK];
    unsigned long watermark_boost;   /* temporary boost after fragmentation events */
    /* ... */
};
```

The accessor macros add `watermark_boost` to the stored value:

```c
static inline unsigned long wmark_pages(const struct zone *z,
                                         enum zone_watermarks w)
{
    return z->_watermark[w] + z->watermark_boost;
}

static inline unsigned long min_wmark_pages(const struct zone *z)  { ... }
static inline unsigned long low_wmark_pages(const struct zone *z)  { ... }
static inline unsigned long high_wmark_pages(const struct zone *z) { ... }
static inline unsigned long promo_wmark_pages(const struct zone *z){ ... }
```

The watermarks control two different reclaim paths:

| Condition | Action |
|---|---|
| free pages < `low_wmark_pages(zone)` | `wakeup_kswapd()` — wake the node's kswapd |
| free pages < `min_wmark_pages(zone)` | Direct reclaim — the allocating process blocks |

Because each zone on each node has its own watermarks, **Node 1 can be at `WMARK_MIN` while Node 0 sits comfortably above `WMARK_HIGH`**. The kernel does not average watermarks across nodes.

---

## Per-node kswapd

### One thread per pgdat

`kswapd_run()` creates one kernel thread per node at boot:

```c
/* mm/vmscan.c */
void __meminit kswapd_run(int nid)
{
    pg_data_t *pgdat = NODE_DATA(nid);
    /* ... */
    pgdat->kswapd = kthread_create_on_node(kswapd, pgdat, nid,
                                            "kswapd%d", nid);
    /* ... */
    wake_up_process(pgdat->kswapd);
}
```

Each thread is pinned to its node (`kthread_create_on_node`) so allocations made by kswapd itself come from the correct local pool. The `pgdat` pointer stored in `pg_data_t::kswapd` is that node's thread handle.

### How kswapd wakes up

`wakeup_kswapd()` is called from the page allocator (`mm/page_alloc.c`) whenever an allocation is attempted against a zone whose free pages are below `WMARK_LOW`:

```c
/* mm/vmscan.c */
void wakeup_kswapd(struct zone *zone, gfp_t gfp_flags, int order,
                   enum zone_type highest_zoneidx)
{
    pg_data_t *pgdat = zone->zone_pgdat;   /* the zone's owning node */
    /* ... */
    if (READ_ONCE(pgdat->kswapd_order) < order)
        WRITE_ONCE(pgdat->kswapd_order, order);
    /* ... */
    wake_up_interruptible(&pgdat->kswapd_wait);
}
```

Only the **zone's owning node's kswapd** is woken. A shortage on Node 1 does not automatically wake kswapd on Node 0.

### What balance_pgdat does

Once woken, the kswapd thread calls `balance_pgdat()`:

```c
/* mm/vmscan.c */
static int balance_pgdat(pg_data_t *pgdat, int order, int highest_zoneidx)
```

`balance_pgdat()` loops over the node's zones in priority order, calling `shrink_node()` until all managed zones are balanced. "Balanced" is tested by `pgdat_balanced()`:

```c
/* mm/vmscan.c */
static bool pgdat_balanced(pg_data_t *pgdat, int order, int highest_zoneidx)
{
    /* ... */
    for_each_managed_zone_pgdat(zone, pgdat, i, highest_zoneidx) {
        if (sysctl_numa_balancing_mode & NUMA_BALANCING_MEMORY_TIERING)
            mark = promo_wmark_pages(zone);
        else
            mark = high_wmark_pages(zone);
        /* check free pages >= mark ... */
    }
}
```

kswapd reclaims until every zone on **its own node** is above `WMARK_HIGH`. It has no obligation to reclaim from a remote node, and it does not look at the remote node's watermarks.

### kswapd vs direct reclaim

| | kswapd (background) | Direct reclaim |
|---|---|---|
| Triggered by | free pages < `WMARK_LOW` | free pages < `WMARK_MIN` |
| Who reclaims | Dedicated kernel thread | The allocating process itself |
| Process latency | None (async) | Process blocks |
| Entry point | `balance_pgdat()` | `try_to_free_pages()` → `do_try_to_free_pages()` |
| Node scope | Own node's LRU | Follows the allocation's `zonelist` |

!!!note
    `kswapd_failures` in `pg_data_t` counts consecutive runs that reclaimed zero pages. After `MAX_RECLAIM_RETRIES` failures, `kswapd_test_hopeless()` returns true and the node is considered "hopeless". kswapd backs off and lets direct reclaim handle the node instead.

---

## NUMA balancing and its interaction with reclaim

### How NUMA hint faults work

When `CONFIG_NUMA_BALANCING` is on, the kernel periodically scans a task's VMA with `task_numa_work()` (in `kernel/sched/fair.c`), installing PROT_NONE PTEs on pages whose placement it wants to evaluate. The next access to such a page traps as a page fault and reaches `do_numa_page()` in `mm/memory.c`.

`do_numa_page()` calls `numa_migrate_check()` to decide whether the faulting page should move to the local node. If migration is warranted, it proceeds through `migrate_misplaced_folio_prepare()` and `migrate_misplaced_folio()`:

```c
/* mm/memory.c */
static vm_fault_t do_numa_page(struct vm_fault *vmf)
{
    /* ... */
    target_nid = numa_migrate_check(folio, vmf, vmf->address, &flags,
                                     writable, &last_cpupid);
    if (target_nid == NUMA_NO_NODE)
        goto out_map;               /* stay put */

    if (migrate_misplaced_folio_prepare(folio, vma, target_nid)) {
        flags |= TNF_MIGRATE_FAIL;
        goto out_map;
    }
    if (!migrate_misplaced_folio(folio, target_nid)) {
        nid = target_nid;
        flags |= TNF_MIGRATED;      /* moved to local node */
        task_numa_fault(last_cpupid, nid, nr_pages, flags);
        return 0;
    }
    flags |= TNF_MIGRATE_FAIL;
    /* ... */
}
```

The same pattern applies to transparent huge pages, handled in `mm/huge_memory.c`.

### The promotion path vs the reclaim path

When a remote page is accessed:

```
Remote page accessed on Node 0 by CPU on Node 0
               │
               ▼
         NUMA hint fault fires
         (do_numa_page called)
               │
   ┌───────────┴───────────┐
   │                       │
   ▼                       ▼
Migration succeeds     Migration fails
(page moves to         (page stays on
 Node 0 — promotion)    Node 1 — remote)
               │                   │
               ▼                   ▼
     Page now on Node 0's    Page stays on Node 1's
     LRU — ages normally      LRU — aged and potentially
                               reclaimed by kswapd1
```

Pages that cannot be migrated (for example because Node 0 is low on memory itself, or the page is shared and migration is blocked) stay on Node 1's LRU. Node 1's kswapd will eventually reclaim them as cold pages, regardless of whether the faulting process is still actively using them on Node 0.

This is the core tension: **the reclaim path and the promotion path compete**. A page that kswapd1 reclaims to relieve Node 1's pressure may be one that NUMA balancing was about to promote to Node 0 for better locality.

### WMARK_PROMO and memory tiering

When `sysctl_numa_balancing_mode` has `NUMA_BALANCING_MEMORY_TIERING` set (used for CXL/persistent memory tiers), `pgdat_balanced()` uses `promo_wmark_pages(zone)` instead of `high_wmark_pages(zone)` as its target. This reserves more headroom on the faster tier so promotions from slower memory can proceed without immediately triggering reclaim.

---

## zone_reclaim_mode

### What it was

`vm.zone_reclaim_mode` (kernel variable: `node_reclaim_mode`) is a sysctl that, when non-zero, causes the page allocator to attempt local reclaim **before** falling back to a remote node's memory. It was intended for workloads where NUMA locality is more important than the cache-spill cost of forced reclaim.

The bits are defined in `include/uapi/linux/mempolicy.h`:

```c
#define RECLAIM_ZONE    (1<<0)  /* enable zone/node reclaim */
#define RECLAIM_WRITE   (1<<1)  /* writeback dirty pages during reclaim */
#define RECLAIM_UNMAP   (1<<2)  /* unmap mapped pages during reclaim */
```

`node_reclaim_enabled()` returns true when any of these bits is set:

```c
/* mm/internal.h */
static inline bool node_reclaim_enabled(void)
{
    return node_reclaim_mode & (RECLAIM_ZONE|RECLAIM_WRITE|RECLAIM_UNMAP);
}
```

When enabled and an allocation misses its preferred zone's watermark, `get_page_from_freelist()` in `mm/page_alloc.c` calls `node_reclaim()` on the local node before moving on to remote zones:

```c
/* mm/page_alloc.c */
if (!node_reclaim_enabled() ||
    !zone_allows_reclaim(zonelist_zone(ac->preferred_zoneref), zone))
    continue;

ret = node_reclaim(zone->zone_pgdat, gfp_mask, order);
```

`zone_allows_reclaim()` enforces a NUMA distance gate: reclaim is only attempted if the target zone's node is within `node_reclaim_distance` of the preferred zone's node (default: `RECLAIM_DISTANCE = 30` in `include/linux/topology.h`). This prevents the allocator from doing expensive local reclaim to avoid a remote node that is actually close by.

### Why it caused latency problems

Forcing local reclaim before remote allocation means:

- Useful hot pages are evicted from local memory to preserve an empty watermark buffer.
- Workloads with working sets that span nodes, or that share memory across nodes, see disproportionate eviction because zone_reclaim never looks at the remote node's free space.
- Write-back paths (`RECLAIM_WRITE`) add I/O latency to allocation paths that would otherwise complete quickly by using remote DRAM.

For general-purpose workloads — including most databases and in-memory caches — the loss of warm cache pages exceeds any benefit from avoiding the NUMA penalty of a remote access.

### Current state

`zone_reclaim_mode` is **disabled by default** (zero). The kernel documentation (`Documentation/admin-guide/sysctl/vm.rst`) explicitly states:

> *zone_reclaim_mode is disabled by default. For file servers or workloads that benefit from having their data cached, zone_reclaim_mode should be left disabled as the caching effect is likely to be more important than data locality.*

It remains useful only for tightly partitioned HPC or NUMA-aware real-time workloads where each process's working set fits entirely within a single node and remote access latency is the dominant performance concern.

!!!warning
    Enabling `zone_reclaim_mode` on a shared-memory workload or a workload with a working set larger than one NUMA node will typically hurt throughput. Benchmark before and after on your specific workload.

---

## Remote memory pressure causing local reclaim

Consider a two-node system where Node 1's allocations are exhausting local memory:

```
Node 0: 20 GB free (comfortably above WMARK_HIGH)
Node 1:  1 GB free (below WMARK_LOW, kswapd1 running hard)
```

With `zone_reclaim_mode = 0` (the default), what happens to a process running on Node 1?

1. Node 1's page allocator falls through Node 1's zones, finds them below watermark, and checks the `zonelist` — which includes Node 0's zones as fallback.
2. The allocator **does not call `node_reclaim()`** because `node_reclaim_enabled()` is false.
3. The allocation succeeds immediately from Node 0. The process gets remote memory but doesn't stall.
4. Meanwhile, kswapd1 continues reclaiming from Node 1's own LRU in the background, trying to push Node 1 back above `WMARK_HIGH`.

**Critically: kswapd1 reclaims from Node 1's LRU regardless of Node 0's free memory.** It has no mechanism to "borrow" Node 0's headroom. The result is that Node 1 may reclaim actively used pages from Node 1 while Node 0 sits largely idle.

This is not a bug — it is the correct behavior for general-purpose workloads. The alternative (stopping reclaim because remote memory is free) would leak memory on the remote node indefinitely, eventually causing remote memory to run out too.

!!!note
    Processes on Node 1 **do not automatically migrate to Node 0** when Node 1 is under pressure. Process placement is a scheduler concern, not a memory reclaim concern. Use `numactl --cpunodebind` or `taskset` to explicitly control process placement, or rely on the scheduler's load-balancing (which considers NUMA topology but is not guaranteed to move processes off a memory-pressured node).

---

## Observing per-node reclaim

### /proc/vmstat

`/proc/vmstat` reports system-wide counters. The most relevant for reclaim:

```bash
grep -E 'pgsteal|pgscan|kswapd' /proc/vmstat
```

Key fields (string names from `mm/vmstat.c`):

| Counter | Meaning |
|---|---|
| `pgsteal_kswapd` | Pages reclaimed by kswapd (all nodes combined) |
| `pgsteal_direct` | Pages reclaimed by direct reclaim |
| `pgscan_kswapd` | Pages scanned by kswapd |
| `pgscan_direct` | Pages scanned by direct reclaim |
| `pgscan_direct_throttle` | Times direct reclaim was throttled |
| `kswapd_low_wmark_hit_quickly` | Times kswapd restored the low watermark without a full scan |
| `kswapd_high_wmark_hit_quickly` | Times kswapd reached the high watermark quickly |
| `zone_reclaim_success` | `node_reclaim()` calls that reclaimed enough pages |
| `zone_reclaim_failed` | `node_reclaim()` calls that did not reclaim enough |

`zone_reclaim_success` and `zone_reclaim_failed` are non-zero only when `zone_reclaim_mode != 0`.

### Per-node vmstat

Each node exposes its own vmstat counters through sysfs:

```bash
# Per-node free pages
cat /sys/devices/system/node/node0/vmstat
cat /sys/devices/system/node/node1/vmstat

# Example fields visible here:
# nr_inactive_anon, nr_active_anon, nr_inactive_file, nr_active_file
# pgsteal_kswapd, pgscan_kswapd, pgsteal_direct, pgscan_direct
```

Comparing `pgsteal_kswapd` between nodes reveals which node is bearing the reclaim burden. A large asymmetry often indicates a memory placement problem.

### NUMA allocation counters

```bash
numastat          # per-node hit/miss counters (reads /sys/devices/system/node/nodeN/numastat)
numastat -p <pid> # per-process NUMA mapping
```

The relevant per-node counters (also visible in `/sys/devices/system/node/nodeN/numastat`):

| Counter | Meaning |
|---|---|
| `numa_hit` | Allocations that landed on the intended node |
| `numa_miss` | Allocations that landed on a different node (process got remote memory) |
| `numa_foreign` | Allocations intended for this node that landed elsewhere |
| `numa_local` | Allocations by a CPU local to this node |
| `numa_other` | Allocations by a CPU on a remote node |

A rising `numa_miss` on Node 1 alongside active kswapd reclaim on Node 1 is the canonical sign that Node 1 is memory-pressured and falling back to remote allocation.

### NUMA balancing counters

```bash
grep numa /proc/vmstat
```

| Counter | Meaning |
|---|---|
| `numa_hint_faults` | PROT_NONE fault fires (NUMA hint page scanned and accessed) |
| `numa_hint_faults_local` | Hint faults where the page was already local |
| `numa_pages_migrated` | Pages successfully promoted/migrated via NUMA balancing |

A low `numa_pages_migrated` / `numa_hint_faults` ratio means most hint faults are failing to migrate, often because the target node is too full.

---

## Tuning

### MPOL_INTERLEAVE to reduce per-node hotspots

When a large shared-memory dataset (e.g., a database buffer pool, a shared queue) is allocated entirely on one node, any memory pressure on that node will evict parts of that dataset. Interleaving spreads the allocation — and the pressure — across all nodes:

```c
/* Application code */
#include <numaif.h>

unsigned long nodemask = 0x3;  /* nodes 0 and 1 */
mbind(addr, length, MPOL_INTERLEAVE, &nodemask, 2, 0);
```

```bash
# At process start
numactl --interleave=all ./my_application
```

The tradeoff: individual accesses will sometimes be remote, increasing average latency. This is usually worthwhile when the dataset is too large to fit on one node or when multiple NUMA-local processes all need the same data.

### Transparent huge pages and NUMA

THP allocation is always attempted from the local node first. If the local node cannot satisfy a 2MB contiguous allocation but a remote node can, the kernel falls back to a remote allocation or to a base-page allocation — it does not split the THP request across nodes. Under local memory pressure, kswapd's compaction (`kcompactd`) runs to create the contiguous free range, but this compaction is also per-node.

For applications that mix NUMA pinning with THP:

- `MADV_HUGEPAGE` on a region that spans both nodes will attempt THPs on whichever node each VMA range maps to.
- `numactl --membind=0 --huge-pages` restricts THP allocation to Node 0; if Node 0 lacks contiguous memory, the allocation falls back to base pages or blocks.

!!!tip
    If kswapd on one node is consistently more active than others while the overall system has free memory, the first thing to check is whether a single process or shared segment is concentrating its allocations on that node. `numastat -p <pid>` shows how a process's virtual mappings distribute across nodes.

### Adjusting node_reclaim_distance

On AMD EPYC or similar multi-die platforms where 2-hop NUMA distance is reported as 32 (above the default `RECLAIM_DISTANCE` of 30), the kernel may refuse to do local reclaim across the intra-socket fabric even though those accesses are relatively fast. The distance threshold can be tuned:

```bash
# Raise the distance threshold so intra-socket remote nodes are eligible for reclaim
echo 40 > /proc/sys/vm/numa_reclaim_distance   # if exposed as sysctl
```

!!!warning
    `node_reclaim_distance` is a compile-time and boot-time tunable. Some distributions expose it via `/proc/sys/vm/numa_reclaim_distance`; others require a kernel parameter. Confirm availability before scripting.

---

## Key Source Files

| File | What it contains |
|---|---|
| `mm/vmscan.c` | `kswapd()`, `kswapd_run()`, `balance_pgdat()`, `pgdat_balanced()`, `wakeup_kswapd()`, `node_reclaim()`, `node_reclaim_mode` variable |
| `mm/page_alloc.c` | `get_page_from_freelist()`, `zone_watermark_ok()`, `__zone_watermark_ok()`, `zone_allows_reclaim()`, `node_reclaim_distance` |
| `include/linux/mmzone.h` | `struct zone` (watermark fields), `struct pglist_data` (kswapd fields), `enum zone_watermarks`, watermark accessor inlines |
| `mm/migrate.c` | `migrate_misplaced_folio()`, `migrate_misplaced_folio_prepare()`, `migrate_pages()` |
| `mm/memory.c` | `do_numa_page()`, `numa_migrate_check()` |
| `mm/internal.h` | `node_reclaim_enabled()` |
| `include/uapi/linux/mempolicy.h` | `RECLAIM_ZONE`, `RECLAIM_WRITE`, `RECLAIM_UNMAP`, `MPOL_INTERLEAVE` |
| `include/linux/topology.h` | `RECLAIM_DISTANCE` default (30), `node_reclaim_distance` declaration |
| `include/linux/vm_event_item.h` | `PGSTEAL_KSWAPD`, `PGSCAN_KSWAPD`, `NUMA_HINT_FAULTS`, `NUMA_PAGE_MIGRATE` enum values |
| `mm/vmstat.c` | Counter string names (`pgsteal_kswapd`, `numa_hit`, `numa_miss`, `zone_reclaim_success`, etc.) |
| `kernel/sched/fair.c` | `task_numa_work()` — NUMA hint PTE scanner |
