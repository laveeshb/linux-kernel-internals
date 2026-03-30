# NUMA Zonelist Construction and Fallback Ordering

> When a NUMA node runs out of memory, the kernel's pre-built fallback list determines where the next allocation lands — and memory policies can override that list entirely.

## What Is a Zonelist?

Every NUMA node (`pg_data_t`, also called `pgdat`) carries an array of zonelists. A zonelist is an ordered sequence of `zoneref` entries — one entry per (zone, node) pair — that the allocator walks in priority order when fulfilling a request.

```c
/* include/linux/mmzone.h */

/* Maximum number of zones on a zonelist */
#define MAX_ZONES_PER_ZONELIST (MAX_NUMNODES * MAX_NR_ZONES)

enum {
    ZONELIST_FALLBACK,      /* zonelist with fallback */
#ifdef CONFIG_NUMA
    ZONELIST_NOFALLBACK,    /* zonelist without fallback (__GFP_THISNODE) */
#endif
    MAX_ZONELISTS
};

/*
 * This struct contains information about a zone in a zonelist. It is stored
 * here to avoid dereferences into large structures and lookups of tables
 */
struct zoneref {
    struct zone *zone;   /* Pointer to actual zone */
    int zone_idx;        /* zone_idx(zoneref->zone) */
};

/*
 * One allocation request operates on a zonelist. A zonelist
 * is a list of zones, the first one is the 'goal' of the
 * allocation, the other zones are fallback zones, in decreasing
 * priority.
 */
struct zonelist {
    struct zoneref _zonerefs[MAX_ZONES_PER_ZONELIST + 1];
};
```

Each `pgdat` holds two zonelists (`node_zonelists[MAX_ZONELISTS]`):

| Index | Name | Purpose |
|---|---|---|
| `ZONELIST_FALLBACK` | Fallback list | Normal allocations; preferred node first, then sorted by NUMA distance |
| `ZONELIST_NOFALLBACK` | No-fallback list | Used when `__GFP_THISNODE` is set; local node only, never crosses to another node |

The helper `node_zonelist(nid, gfp_flags)` selects the right list based on whether `__GFP_THISNODE` is present in the GFP flags:

```c
/* include/linux/gfp.h */
static inline struct zonelist *node_zonelist(int nid, gfp_t flags)
{
    return NODE_DATA(nid)->node_zonelists + gfp_zonelist(flags);
}
```

where `gfp_zonelist()` returns `ZONELIST_NOFALLBACK` if `__GFP_THISNODE` is set, and `ZONELIST_FALLBACK` otherwise.

---

## How Zonelists Are Built

### Entry Point: `build_all_zonelists()`

Zonelists are constructed at two points in the kernel's lifetime:

1. **Boot** — `build_all_zonelists()` is called during memory initialization. Because the system is still in `SYSTEM_BOOTING`, it delegates to `build_all_zonelists_init()`, which calls `__build_all_zonelists(NULL)` to rebuild all nodes.
2. **Memory hotplug** — When a node comes online, `build_all_zonelists(pgdat)` is called again with the new node's `pgdat`. If that node is not yet online, only its own zonelist is rebuilt; otherwise all nodes are rebuilt so their fallback lists reflect the new topology.

```c
/* mm/page_alloc.c */
void __ref build_all_zonelists(pg_data_t *pgdat)
{
    if (system_state == SYSTEM_BOOTING) {
        build_all_zonelists_init();
    } else {
        __build_all_zonelists(pgdat);
    }
    ...
}
```

The rebuild holds a write-side seqlock (`zonelist_update_seq`) so that concurrent allocators — which may run at IRQ level with `GFP_ATOMIC` — can detect a rebuild in progress and re-read the zonelist.

### Node Ordering: `build_zonelists()`

For each `pgdat`, `build_zonelists()` constructs the `ZONELIST_FALLBACK` list by calling `find_next_best_node()` repeatedly until all nodes with memory have been visited:

```c
/* mm/page_alloc.c */
static void build_zonelists(pg_data_t *pgdat)
{
    static int node_order[MAX_NUMNODES];
    int node, nr_nodes = 0;
    nodemask_t used_mask = NODE_MASK_NONE;
    int local_node, prev_node;

    local_node = pgdat->node_id;
    prev_node = local_node;

    while ((node = find_next_best_node(local_node, &used_mask)) >= 0) {
        if (node_distance(local_node, node) !=
            node_distance(local_node, prev_node))
            node_load[node] += 1;

        node_order[nr_nodes++] = node;
        prev_node = node;
    }

    build_zonelists_in_node_order(pgdat, node_order, nr_nodes);
    build_thisnode_zonelists(pgdat);
    ...
}
```

The kernel prints the resulting order at boot: `Fallback order for Node N: 0 1 2 ...`

### Choosing the Next Best Node: `find_next_best_node()`

`find_next_best_node()` scores every unvisited node using a composite metric:

1. **NUMA distance** — the primary signal, read from the ACPI SLIT table via `node_distance()`. Closer nodes score lower.
2. **CPU presence penalty** — nodes that have CPUs (`PENALTY_FOR_NODE_WITH_CPUS`) score slightly higher than headless memory-only nodes. Memory-only nodes see less allocation pressure from the kernel itself, making them better overflow targets.
3. **Load balancing** — a small `node_load` increment is applied to the first node in each new distance group, spreading allocations round-robin among equidistant peers.

The preferred (local) node is always placed first.

### The `numa_zonelist_order` Sysctl

The kernel exposes `/proc/sys/vm/numa_zonelist_order`. In current kernels, only `"Node"` order is implemented. An older zone-based ordering mode was removed because it was not useful in practice. The sysctl is retained for compatibility but ignores any value that does not begin with `'d'`, `'D'`, `'n'`, or `'N'` (matching `"Default"` and `"Node"`), emitting a warning otherwise.

```bash
$ cat /proc/sys/vm/numa_zonelist_order
Node
```

---

## Zone Ordering Within a Node

Within a single node, `build_zonerefs_node()` iterates zones from the highest zone index down to zero and appends each populated zone to the list:

```c
/* mm/page_alloc.c */
static int build_zonerefs_node(pg_data_t *pgdat, struct zoneref *zonerefs)
{
    struct zone *zone;
    enum zone_type zone_type = MAX_NR_ZONES;
    int nr_zones = 0;

    do {
        zone_type--;
        zone = pgdat->node_zones + zone_type;
        if (populated_zone(zone)) {
            zoneref_set_zone(zone, &zonerefs[nr_zones++]);
            check_highest_zone(zone_type);
        }
    } while (zone_type);

    return nr_zones;
}
```

The zone type enum in ascending order is:

```c
/* include/linux/mmzone.h */
enum zone_type {
    ZONE_DMA,       /* CONFIG_ZONE_DMA    — small DMA-capable window */
    ZONE_DMA32,     /* CONFIG_ZONE_DMA32  — 32-bit DMA window         */
    ZONE_NORMAL,    /* main addressable memory                         */
    ZONE_MOVABLE,   /* pages that can be migrated or offlined          */
    __MAX_NR_ZONES
};
```

Because the loop counts *down* from `MAX_NR_ZONES - 1`, a typical x86-64 node's zones appear in the zonelist as:

```
ZONE_MOVABLE → ZONE_NORMAL → ZONE_DMA32 → ZONE_DMA
```

**Why this order?** The allocator tries the largest-capacity zones first (`ZONE_NORMAL` and `ZONE_MOVABLE` together hold the vast majority of RAM). `ZONE_DMA32` and `ZONE_DMA` are preserved for hardware devices that have strict addressing constraints. Using normal memory for ordinary allocations protects these limited DMA-capable regions.

---

## Fallback Algorithm: Iterating the Zonelist

### The `for_each_zone_zonelist` Family

The allocator's fast path (`get_page_from_freelist()`) iterates the zonelist using:

```c
/* include/linux/mmzone.h */

/* Iterate all zones at or below highest_zoneidx */
#define for_each_zone_zonelist(zone, z, zlist, highidx) \
    for_each_zone_zonelist_nodemask(zone, z, zlist, highidx, NULL)

/* Same, but filtered to zones whose node is in nodemask */
#define for_each_zone_zonelist_nodemask(zone, z, zlist, highidx, nodemask) \
    for (z = first_zones_zonelist(zlist, highidx, nodemask), zone = zonelist_zone(z); \
         zone; \
         z = next_zones_zonelist(++z, highidx, nodemask), \
             zone = zonelist_zone(z))
```

`z` is a cursor (`struct zoneref *`) into the zonelist's `_zonerefs` array. Advancing `++z` moves to the next entry without re-scanning from the beginning — this is O(1) per step.

### Watermark Gating

At each zone the allocator checks the watermark before attempting an allocation:

```c
/* mm/page_alloc.c — inside get_page_from_freelist() */
mark = wmark_pages(zone, alloc_flags & ALLOC_WMARK_MASK);
if (!zone_watermark_fast(zone, order, mark,
                         ac->highest_zoneidx, alloc_flags,
                         gfp_mask)) {
    /* watermark failed — skip this zone, continue the loop */
    ...
    continue;
}
/* watermark passed — allocate from this zone */
```

`zone_watermark_ok()` checks that `free_pages - requested > watermark + lowmem_reserve[highest_zoneidx]`. The `lowmem_reserve` array provides a per-zone buffer that prevents higher-zone allocations from completely exhausting DMA-capable zones.

!!! note "The allocator does not retry the full list"
    Once the watermark check fails for a zone, that zone is skipped — the loop simply moves to the next entry. There is no re-scan from the beginning. If all zones in the fallback list fail the watermark check, the allocation falls into `__alloc_pages_slowpath()`, which triggers reclaim, compaction, and ultimately OOM if memory cannot be freed.

---

## How Memory Policies Modify Zonelist Traversal

Memory policies (`struct mempolicy`) intercept the allocation path in `mempolicy.c` and can change either the preferred node or the nodemask that filters the zonelist iterator.

```c
/* include/linux/mempolicy.h */
struct mempolicy {
    atomic_t refcnt;
    unsigned short mode;   /* MPOL_DEFAULT, MPOL_BIND, MPOL_PREFERRED, ... */
    unsigned short flags;  /* MPOL_F_STATIC_NODES, MPOL_F_RELATIVE_NODES, ... */
    nodemask_t nodes;      /* interleave/bind/preferred/etc. */
    int home_node;         /* home node for MPOL_BIND and MPOL_PREFERRED_MANY */
    union {
        nodemask_t cpuset_mems_allowed;
        nodemask_t user_nodemask;
    } w;
    struct rcu_head rcu;
};
```

The `policy_nodemask()` function in `mempolicy.c` translates the policy mode into a `(preferred_nid, nodemask)` pair that the core allocator uses:

```c
/* mm/mempolicy.c */
static nodemask_t *policy_nodemask(gfp_t gfp, struct mempolicy *pol,
                                   pgoff_t ilx, int *nid)
{
    nodemask_t *nodemask = NULL;

    switch (pol->mode) {
    case MPOL_PREFERRED:
        *nid = first_node(pol->nodes);
        break;
    case MPOL_BIND:
        if (apply_policy_zone(pol, gfp_zone(gfp)) &&
            cpuset_nodemask_valid_mems_allowed(&pol->nodes))
            nodemask = &pol->nodes;
        ...
        break;
    case MPOL_INTERLEAVE:
        *nid = (ilx == NO_INTERLEAVE_INDEX) ?
            interleave_nodes(pol) : interleave_nid(pol, ilx);
        break;
    ...
    }

    return nodemask;
}
```

### `MPOL_DEFAULT`

No policy object is set (`current->mempolicy == NULL`). The allocator uses the current CPU's node as the preferred node and no nodemask filter. The full fallback list is available.

### `MPOL_PREFERRED`

The `nodes` field holds exactly one node. `policy_nodemask()` sets `*nid` to that node, making it the preferred starting point. The nodemask filter remains `NULL`, so if the preferred node is exhausted, the allocator falls back through the full `ZONELIST_FALLBACK` list.

### `MPOL_BIND`

`policy_nodemask()` returns `&pol->nodes` as the nodemask filter. `for_each_zone_zonelist_nodemask` skips any zone whose node is not in that mask. The allocator therefore only considers the bound nodes. **If all bound nodes are exhausted, no fallback to other nodes occurs** — the allocation fails and triggers OOM rather than spilling onto an unbound node.

!!! warning "MPOL_BIND and OOM"
    A process bound with `MPOL_BIND` to a node that is full will be killed by the OOM killer rather than falling back to remote memory. This is intentional: the application has explicitly declared that it requires local memory.

### `MPOL_INTERLEAVE`

`interleave_nodes()` advances `current->il_prev` to the next node in `pol->nodes` and returns it as the preferred node for this allocation. No nodemask filter is applied to the zonelist — normal fallback is still available if the interleaved node is temporarily exhausted. Over many allocations, pages are spread round-robin across the allowed nodes.

### `MPOL_LOCAL`

Allocate from the current CPU's NUMA node. `policy_nodemask()` does not modify `*nid` for `MPOL_LOCAL` (it falls through to the default case), so `numa_node_id()` is used. Normal fallback applies.

### Summary Table

| Policy | Preferred Node | Nodemask Filter | On Exhaustion |
|---|---|---|---|
| `MPOL_DEFAULT` | Current CPU's node | None | Falls back normally |
| `MPOL_PREFERRED` | Specified node | None | Falls back normally |
| `MPOL_BIND` | First node in mask (or `home_node`) | `pol->nodes` | OOM — no fallback |
| `MPOL_INTERLEAVE` | Round-robin across `pol->nodes` | None | Falls back normally |
| `MPOL_LOCAL` | Current CPU's node | None | Falls back normally |

---

## Practical Effect: Two-Node Example

Consider a system with node 0 (32 GB) and node 1 (32 GB). NUMA distance: local = 10, remote = 20. Node 0's `ZONELIST_FALLBACK` list is:

```
[ZONE_NORMAL/node0] → [ZONE_DMA32/node0] → [ZONE_NORMAL/node1] → [ZONE_DMA32/node1]
```

**Scenario 1 — Default policy, node 0 is full:**
A task running on node 0 with no explicit policy fills node 0's `ZONE_NORMAL`. `get_page_from_freelist()` fails the watermark check on `ZONE_NORMAL/node0`, skips `ZONE_DMA32/node0` (watermark check also fails or `lowmem_reserve` denies it), and succeeds on `ZONE_NORMAL/node1`. The allocation is served from node 1 at remote latency. `numastat` records a `numa_miss` on node 0 and a `numa_foreign` on node 1.

**Scenario 2 — `MPOL_BIND` to node 0, node 0 is full:**
The nodemask filter restricts the iterator to node 0 entries only. Both `ZONE_NORMAL/node0` and `ZONE_DMA32/node0` fail the watermark check. No other zones pass the nodemask filter. The slow path fails to reclaim enough memory and the OOM killer is invoked. The task does **not** fall back to node 1.

**Scenario 3 — `MPOL_PREFERRED` for node 0, node 0 is full:**
The preferred nid is overridden to node 0, but no nodemask filter is applied. When node 0's zones fail the watermark check, the iterator continues to `ZONE_NORMAL/node1` and the allocation succeeds. Behaviour is identical to the default policy except that node 0 is tried first even if the task happens to be scheduled on node 1.

---

## Observing Fallback in Practice

### `numastat`

```bash
numastat
```

| Counter | Meaning |
|---|---|
| sysfs name | `/proc/vmstat` name | Meaning |
|---|---|---|
| `numa_hit` | `numa_hit` | Allocated on the intended (preferred) node |
| `numa_miss` | `numa_miss` | Allocated on a different node because the preferred node was full |
| `numa_foreign` | `numa_foreign` | A remote task allocated from this node |
| `interleave_hit` | `numa_interleave` | Interleave policy landed on the intended node |
| `local_node` | `numa_local` | Allocated on the local node (CPU and memory are co-located) |
| `other_node` | `numa_other` | Allocated on a non-local node |

High `numa_miss` counts indicate memory pressure on the preferred node and frequent fallback to remote memory.

### `/proc/zoneinfo`

```bash
grep -A 20 "Node 0, zone" /proc/zoneinfo
```

Per-zone free page counts and the three watermarks (`min`, `low`, `high`) are visible here. When `free` approaches `min`, the zone will fail `zone_watermark_ok()` for most allocations and the allocator will skip to the next zonelist entry.

### Kernel Boot Log

At boot, the kernel prints each node's fallback order:

```
Fallback order for Node 0: 0 1
Fallback order for Node 1: 1 0
```

This comes directly from `build_zonelists()`:

```c
pr_info("Fallback order for Node %d: ", local_node);
for (node = 0; node < nr_nodes; node++)
    pr_cont("%d ", node_order[node]);
```

---

## Key Source Files

| File | What to Look For |
|---|---|
| `include/linux/mmzone.h` | `struct zoneref`, `struct zonelist`, `enum zone_type`, `ZONELIST_FALLBACK`, `ZONELIST_NOFALLBACK`, `MAX_ZONES_PER_ZONELIST`, `for_each_zone_zonelist`, `for_each_zone_zonelist_nodemask`, `enum numa_stat_item` |
| `include/linux/mempolicy.h` | `struct mempolicy` — `mode`, `flags`, `nodes`, `home_node` |
| `include/uapi/linux/mempolicy.h` | `MPOL_DEFAULT`, `MPOL_PREFERRED`, `MPOL_BIND`, `MPOL_INTERLEAVE`, `MPOL_LOCAL`, `MPOL_PREFERRED_MANY` |
| `include/linux/gfp.h` | `node_zonelist()`, `gfp_zonelist()` |
| `mm/page_alloc.c` | `build_all_zonelists()`, `__build_all_zonelists()`, `build_zonelists()`, `build_zonelists_in_node_order()`, `build_thisnode_zonelists()`, `build_zonerefs_node()`, `find_next_best_node()`, `get_page_from_freelist()`, `zone_watermark_ok()`, `__zone_watermark_ok()` |
| `mm/mempolicy.c` | `policy_nodemask()`, `alloc_pages_mpol()`, `interleave_nodes()`, `mempolicy_slab_node()` |
