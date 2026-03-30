# Zone Reclaim Policy

> How the kernel reclaims memory per-zone, the role of `vm.zone_reclaim_mode`, and why it is off by default

## Key Source Files

| File | Relevance |
|------|-----------|
| `mm/vmscan.c` | `node_reclaim()`, `balance_pgdat()`, `node_reclaim_mode` |
| `mm/page_alloc.c` | `get_page_from_freelist()`, `zone_watermark_fast()`, `zone_allows_reclaim()`, `boost_watermark()` |
| `include/linux/mmzone.h` | `struct zone`, `enum zone_watermarks`, `enum zone_type`, watermark accessors |
| `include/uapi/linux/mempolicy.h` | `RECLAIM_ZONE`, `RECLAIM_WRITE`, `RECLAIM_UNMAP` bit definitions |
| `include/linux/topology.h` | `RECLAIM_DISTANCE` default |

---

## Memory Zones

Linux divides physical memory into zones so that allocations with different addressing constraints can be satisfied without waste. The zone types are defined in `enum zone_type` in `include/linux/mmzone.h`:

```c
enum zone_type {
#ifdef CONFIG_ZONE_DMA
    ZONE_DMA,       /* first ~16MB: ISA/legacy DMA devices */
#endif
#ifdef CONFIG_ZONE_DMA32
    ZONE_DMA32,     /* first 4GB: 32-bit DMA devices */
#endif
    ZONE_NORMAL,    /* remaining directly-mapped physical memory */
#ifdef CONFIG_HIGHMEM
    ZONE_HIGHMEM,   /* above ZONE_NORMAL on 32-bit arches */
#endif
    ZONE_MOVABLE,   /* movable pages only; aids hotplug/THP */
#ifdef CONFIG_ZONE_DEVICE
    ZONE_DEVICE,    /* persistent/device memory */
#endif
    __MAX_NR_ZONES
};
```

Zones form a hierarchy. An allocator that needs `ZONE_DMA` memory can only use `ZONE_DMA`. An allocator requesting `ZONE_NORMAL` memory may fall back to `ZONE_DMA32` or `ZONE_DMA` if needed, but not the reverse. Each zone is independent: it has its own free lists, its own watermarks, and its own reclaim pressure.

```
Physical address space (typical 64-bit x86):

0         16MB          4GB                          RAM top
|─ZONE_DMA─|───ZONE_DMA32───|────────ZONE_NORMAL────────────|
  GFP_DMA     GFP_DMA32          GFP_KERNEL (default)
```

---

## Zone Watermarks

Every zone tracks three watermarks that control when reclaim begins. These are stored in `struct zone._watermark[]` and accessed through inline helpers — never read the array directly.

### The `enum zone_watermarks` enum

```c
/* include/linux/mmzone.h */
enum zone_watermarks {
    WMARK_MIN,
    WMARK_LOW,
    WMARK_HIGH,
    WMARK_PROMO,   /* used with memory tiering / NUMA balancing */
    NR_WMARK
};
```

The three main levels:

| Watermark | Meaning |
|-----------|---------|
| `WMARK_MIN` | Last resort. Direct reclaim stalls allocating processes until free pages rise above this level. |
| `WMARK_LOW` | Background threshold. Falling below here wakes `kswapd`. |
| `WMARK_HIGH` | Target. `kswapd` reclaims until free pages reach this level, then sleeps. |

### Watermark accessor macros

`struct zone` stores the raw watermark values in `_watermark[]`. The `watermark_boost` field is added on top at read time to implement temporary boosting (see [Watermark Boosting](#watermark-boosting)). Always use these accessors:

```c
/* include/linux/mmzone.h */

struct zone {
    unsigned long _watermark[NR_WMARK];
    unsigned long watermark_boost;
    /* ... */
};

static inline unsigned long wmark_pages(const struct zone *z,
                                        enum zone_watermarks w)
{
    return z->_watermark[w] + z->watermark_boost;
}

static inline unsigned long min_wmark_pages(const struct zone *z)  { return wmark_pages(z, WMARK_MIN); }
static inline unsigned long low_wmark_pages(const struct zone *z)  { return wmark_pages(z, WMARK_LOW); }
static inline unsigned long high_wmark_pages(const struct zone *z) { return wmark_pages(z, WMARK_HIGH); }
```

Watermark values are derived from `vm.min_free_kbytes`. Raising that sysctl proportionally raises all three levels in every zone.

### Checking watermarks: `zone_watermark_fast()` and `zone_watermark_ok()`

The allocator calls `zone_watermark_fast()` in the hot path and falls back to `zone_watermark_ok()` for the slower full check. Both live in `mm/page_alloc.c`:

```c
bool zone_watermark_ok(struct zone *z, unsigned int order,
                       unsigned long mark,
                       int highest_zoneidx, unsigned int alloc_flags);

static inline bool zone_watermark_fast(struct zone *z, unsigned int order,
                                       unsigned long mark, int highest_zoneidx,
                                       unsigned int alloc_flags, gfp_t gfp_mask);
```

`zone_watermark_fast()` tries a quick path: if free pages exceed `mark + lowmem_reserve[highest_zoneidx]` without any order-N consideration, it returns `true` immediately. Otherwise it calls `__zone_watermark_ok()` for the full accounting across all free-list orders.

---

## Per-Zone kswapd: `balance_pgdat()`

`kswapd` is a per-node (per-`pgdat`) kernel thread but it reclaims zone by zone. The core loop is `balance_pgdat()` in `mm/vmscan.c`:

```c
/*
 * kswapd scans the zones in the highmem->normal->dma direction. It skips
 * zones which have free_pages > high_wmark_pages(zone), but once a zone is
 * found to have free_pages <= high_wmark_pages(zone), any page in that zone
 * or lower is eligible for reclaim until at least one usable zone is
 * balanced.
 */
static int balance_pgdat(pg_data_t *pgdat, int order, int highest_zoneidx)
```

The direction matters: kswapd scans **from the highest zone index downward** (e.g. `ZONE_MOVABLE` → `ZONE_NORMAL` → `ZONE_DMA32` → `ZONE_DMA`). Once it finds a zone below `WMARK_HIGH`, that zone and all lower zones become candidates for reclaim in the same pass. It continues until at least one zone eligible for the triggering allocation is balanced back above `WMARK_HIGH`.

```
kswapd zone scan order (highest → lowest):

  ZONE_MOVABLE  ← scanned first
  ZONE_NORMAL
  ZONE_DMA32
  ZONE_DMA      ← scanned last

If ZONE_NORMAL falls below WMARK_HIGH, pages are reclaimed from
ZONE_NORMAL and ZONE_DMA32 and ZONE_DMA in the same pass.
```

`kswapd` also accounts for watermark boosting: at the start of each `balance_pgdat()` call it snapshots `zone->watermark_boost` for every zone into a local `zone_boosts[]` array. After each shrink_node iteration, it decrements `zone->watermark_boost` by the amount it snapshotted, gradually draining the boost as reclaim makes progress.

---

## `node_reclaim()` and `vm.zone_reclaim_mode`

### The sysctl

`vm.zone_reclaim_mode` is the user-visible name for the kernel variable `node_reclaim_mode` (declared in `mm/vmscan.c`):

```c
/* mm/vmscan.c */
int node_reclaim_mode __read_mostly;  /* default: 0 (disabled) */
```

Its bits are defined in `include/uapi/linux/mempolicy.h`:

```c
#define RECLAIM_ZONE  (1<<0)  /* Enable zone reclaim */
#define RECLAIM_WRITE (1<<1)  /* Writeout pages during reclaim */
#define RECLAIM_UNMAP (1<<2)  /* Unmap pages during reclaim */
```

The bits are additive:

| Value | Effect |
|-------|--------|
| `0` | Zone reclaim disabled (default) |
| `1` | Reclaim clean file pages from local node |
| `2` | + allow writeback of dirty pages during reclaim |
| `4` | + allow unmapping of mapped file pages |
| `7` | All reclaim types enabled |

When any bit is set, `node_reclaim_enabled()` returns true:

```c
/* mm/internal.h */
static inline bool node_reclaim_enabled(void)
{
    return node_reclaim_mode & (RECLAIM_ZONE|RECLAIM_WRITE|RECLAIM_UNMAP);
}
```

### The call site in `get_page_from_freelist()`

The hook is in `mm/page_alloc.c` inside `get_page_from_freelist()`, which is the main allocation path. After a zone fails its watermark check, the allocator checks whether node reclaim is worth trying:

```c
/* mm/page_alloc.c — inside get_page_from_freelist() */
if (!node_reclaim_enabled() ||
    !zone_allows_reclaim(zonelist_zone(ac->preferred_zoneref), zone))
    continue;

ret = node_reclaim(zone->zone_pgdat, gfp_mask, order);
switch (ret) {
case NODE_RECLAIM_NOSCAN:
    /* did not scan */
    continue;
case NODE_RECLAIM_FULL:
    /* scanned but unreclaimable */
    continue;
default:
    /* did we reclaim enough? */
    if (zone_watermark_ok(zone, order, mark,
            ac->highest_zoneidx, alloc_flags))
        goto try_this_zone;
    continue;
}
```

If reclaim succeeded and the zone is now above its watermark, the allocation proceeds from that zone. Otherwise the allocator moves on to the next zone in the zonelist.

### Inside `node_reclaim()`

`node_reclaim()` in `mm/vmscan.c` is the synchronous, per-node reclaim path. It is called directly from the allocator and blocks the allocating process:

```c
int node_reclaim(struct pglist_data *pgdat, gfp_t gfp_mask, unsigned int order)
{
    const unsigned long nr_pages = 1 << order;
    struct scan_control sc = {
        .nr_to_reclaim = max(nr_pages, SWAP_CLUSTER_MAX),
        .gfp_mask      = current_gfp_context(gfp_mask),
        .order         = order,
        .priority      = NODE_RECLAIM_PRIORITY,  /* = 4: scan 1/16 of zone */
        .may_writepage = !!(node_reclaim_mode & RECLAIM_WRITE),
        .may_unmap     = !!(node_reclaim_mode & RECLAIM_UNMAP),
        .may_swap      = 1,
        .reclaim_idx   = gfp_zone(gfp_mask),
    };
    /* ... */
}
```

Before doing any scanning it checks two conditions that short-circuit the call:

1. **Reclaim threshold**: If `node_pagecache_reclaimable(pgdat) <= pgdat->min_unmapped_pages` *and* slab reclaimable is below `pgdat->min_slab_pages`, it returns `NODE_RECLAIM_FULL` immediately (not enough reclaimable to be worth trying).
2. **CPU locality**: If the node has CPUs attached and it is not the calling CPU's node, it returns `NODE_RECLAIM_NOSCAN`. This ensures node_reclaim only executes on the local node or on CPU-less (memory-only) nodes.

On success it increments `PGSCAN_ZONE_RECLAIM_SUCCESS`; on failure, `PGSCAN_ZONE_RECLAIM_FAILED`. Both counters are visible in `/proc/vmstat` as `zone_reclaim_success` and `zone_reclaim_failed`.

---

## Why `zone_reclaim_mode` Is Disabled by Default

When `zone_reclaim_mode=1`, the kernel prefers to reclaim pages from local memory before falling back to allocating from a remote NUMA node. The intent was to preserve NUMA locality, but in practice this causes a significant problem:

**`node_reclaim()` stalls the allocating process.** Because it runs synchronously in the allocation hot path, the process blocks for the duration of the scan-and-reclaim cycle. On a system under any meaningful memory pressure this introduces latency spikes in the application. Allocating from a remote node via the zonelist fallback is typically much faster than waiting for local reclaim.

The trade-off breaks down as follows:

| Scenario | Preferred behavior |
|----------|--------------------|
| Remote node access adds < 2x latency overhead | `zone_reclaim_mode=0` — allocate remotely |
| Application has strict NUMA locality, large working set that fits per-node | `zone_reclaim_mode=1` might help |
| Streaming or I/O-heavy workload | `zone_reclaim_mode=0` — page cache turnover makes local reclaim counterproductive |
| Database with large buffer pool pinned per node | `zone_reclaim_mode=1` can reduce cross-node traffic |

The kernel comment in `mm/vmscan.c` says it plainly:

> If non-zero call node_reclaim when the number of free pages falls below the watermarks.

That "if non-zero" is a hint that "zero" is the safe default. Modern server workloads almost universally leave this at `0`.

---

## `RECLAIM_DISTANCE` and `zone_allows_reclaim()`

Even when `zone_reclaim_mode` is non-zero, the kernel will not invoke `node_reclaim()` for zones that are topologically close to the requesting node. The threshold is `RECLAIM_DISTANCE`, defined in `include/linux/topology.h`:

```c
#ifndef RECLAIM_DISTANCE
/*
 * If the distance between nodes in a system is larger than RECLAIM_DISTANCE
 * (in whatever arch specific measurement units returned by node_distance())
 * and node_reclaim_mode is enabled then the VM will only call node_reclaim()
 * on nodes within this distance.
 */
#define RECLAIM_DISTANCE 30
#endif

extern int __read_mostly node_reclaim_distance;
```

The runtime variable `node_reclaim_distance` starts at `RECLAIM_DISTANCE` (30) and can be overridden by platform code. AMD EPYC machines, for example, raise it because cross-node memory access at 2-hop distance (ACPI SLIT distance 32) still improves performance when balanced against reclaim cost.

The check is `zone_allows_reclaim()` in `mm/page_alloc.c`:

```c
#ifdef CONFIG_NUMA
int __read_mostly node_reclaim_distance = RECLAIM_DISTANCE;

static bool zone_allows_reclaim(struct zone *local_zone, struct zone *zone)
{
    return node_distance(zone_to_nid(local_zone), zone_to_nid(zone)) <=
                node_reclaim_distance;
}
```

ACPI SLIT distance values: `LOCAL_DISTANCE=10` (same node), `REMOTE_DISTANCE=20` (1 hop). A value of `30` means: reclaim locally (distance 10) but do not reclaim if the candidate zone is 1 hop away (distance 20 ≤ 30 — so this allows reclaim on 1-hop nodes). Zones beyond 2 hops (distance > 30) skip reclaim in favor of direct remote allocation.

```
node_distance(local, candidate) <= node_reclaim_distance?
  Yes → node_reclaim() may run
  No  → skip reclaim, allocate from remote zone directly
```

---

## DMA Zone Pressure

`ZONE_DMA` (first ~16MB) and `ZONE_DMA32` (first 4GB) are small relative to total system RAM. They fill up with device-specific allocations (`GFP_DMA`, `GFP_DMA32`) and are not easily reclaimed.

### Why DMA zones deplete

- Device drivers allocate bounce buffers, descriptor rings, and firmware regions with `GFP_DMA` or `GFP_DMA32`.
- These allocations are often long-lived (held for the device's lifetime).
- The kernel does not automatically migrate DMA allocations to other zones.

### Fallback and OOM behavior

- `GFP_KERNEL` allocations (normal memory) can fall back to `ZONE_DMA32` or `ZONE_DMA` if `ZONE_NORMAL` is exhausted, but the reverse is not true.
- A `GFP_DMA` allocation with no free pages in `ZONE_DMA` triggers the OOM killer even if `ZONE_NORMAL` has gigabytes free, because `ZONE_NORMAL` memory is not reachable by the device.

```
GFP_KERNEL allocation path (zonelist fallback order):
  ZONE_NORMAL → ZONE_DMA32 → ZONE_DMA
  (can fall down, never up)

GFP_DMA allocation path:
  ZONE_DMA only — OOM if exhausted
```

### Detecting DMA zone pressure

```bash
# Check free pages per zone vs watermarks
grep -A 10 "zone" /proc/zoneinfo | grep -E "Node|zone|free|min|low|high"

# Example of a healthy DMA zone:
# Node 0, zone      DMA
#   pages free     2652
#         min      33
#         low      41
#         high     49
```

Signs of trouble: `free` pages in `DMA` or `DMA32` approaching `min`, combined with allocation failures logged as `DMA-zone allocation failure` in `dmesg`.

---

## Watermark Boosting

### The problem it solves

When a high-order allocation (e.g. a THP) falls back to a lower migratetype (e.g. `MIGRATE_UNMOVABLE` stealing from `MIGRATE_MOVABLE`), it pollutes the lower-order free lists. Without intervention, future high-order allocations will keep failing and kswapd will never be woken because the zone may be above its normal watermarks even though it is internally fragmented.

### How it works

`boost_watermark()` in `mm/page_alloc.c` is called when `try_to_claim_block()` detects a migratetype fallback at order less than `pageblock_order`. It temporarily raises `zone->watermark_boost`:

```c
static inline bool boost_watermark(struct zone *zone)
{
    unsigned long max_boost;

    if (!watermark_boost_factor)
        return false;
    /* skip tiny zones where boosting would cause OOM */
    if ((pageblock_nr_pages * 4) > zone_managed_pages(zone))
        return false;

    max_boost = mult_frac(zone->_watermark[WMARK_HIGH],
                          watermark_boost_factor, 10000);
    if (!max_boost)
        return false;

    max_boost = max(pageblock_nr_pages, max_boost);

    zone->watermark_boost = min(zone->watermark_boost + pageblock_nr_pages,
                                max_boost);
    return true;
}
```

`watermark_boost_factor` defaults to `15000` (i.e. 150% of `WMARK_HIGH`). The boost is added to every `wmark_pages()` call, making the zone appear less full than it is — which triggers kswapd even when the zone is nominally above `WMARK_HIGH`.

After boosting, `ZONE_BOOSTED_WATERMARK` is set on the zone flag. On the next `rmqueue()` return path, this flag is checked and kswapd is woken:

```c
/* mm/page_alloc.c */
if ((alloc_flags & ALLOC_KSWAPD) &&
    unlikely(test_bit(ZONE_BOOSTED_WATERMARK, &zone->flags))) {
    clear_bit(ZONE_BOOSTED_WATERMARK, &zone->flags);
    wakeup_kswapd(zone, 0, 0, zone_idx(zone));
}
```

`balance_pgdat()` then drains the boost incrementally: each iteration it subtracts the initial `zone_boosts[i]` snapshot from `zone->watermark_boost` until the boost is gone and the zone is genuinely balanced.

### Controlling boost behavior

```bash
# Default: 15000 (150% of WMARK_HIGH)
cat /proc/sys/vm/watermark_boost_factor

# Disable boosting entirely
echo 0 > /proc/sys/vm/watermark_boost_factor
```

Set to `0` on systems where THP fallbacks are frequent and the resulting kswapd wake-ups cause unwanted reclaim pressure.

---

## Observing Zone State

### `/proc/zoneinfo`

The canonical per-zone diagnostic. Key fields:

```
Node 0, zone   Normal
  pages free     524288
        boost    0         ← current watermark_boost
        min      8192
        low      10240
        high     12288
        spanned  2097152
        present  2097152
        managed  1998765
```

Check for zones where `free` is below `low` or approaching `min`.

### `/proc/vmstat` — zone reclaim counters

These counters are only present when `CONFIG_NUMA=y`:

```bash
grep zone_reclaim /proc/vmstat
# zone_reclaim_success  42      ← node_reclaim() freed enough pages
# zone_reclaim_failed   1831    ← node_reclaim() ran but could not satisfy
```

A high `zone_reclaim_failed` count with `zone_reclaim_mode` enabled is a strong signal that the workload's hot pages cannot be reclaimed locally and `zone_reclaim_mode` should be disabled.

### Quick diagnostic workflow

```bash
# 1. Check zone watermarks and free pages
grep -A 15 "^Node" /proc/zoneinfo | grep -E "Node|zone|free|boost|min|low|high"

# 2. Check whether zone reclaim is enabled
cat /proc/sys/vm/zone_reclaim_mode

# 3. Check reclaim success/failure ratio (NUMA only)
grep -E "zone_reclaim|pgscan" /proc/vmstat

# 4. Check for DMA zone exhaustion
grep -A 10 "zone.*DMA" /proc/zoneinfo | grep free

# 5. Watch for kswapd activity driven by watermark boosting
grep -E "pageoutrun|kswapd" /proc/vmstat
```

### Tuning guidance

| Symptom | Likely cause | Action |
|---------|-------------|--------|
| `zone_reclaim_failed` >> `zone_reclaim_success` | Working set does not fit local node | `echo 0 > /proc/sys/vm/zone_reclaim_mode` |
| Latency spikes on NUMA system | `zone_reclaim_mode` stalling allocators | Disable zone reclaim mode |
| OOM with free memory in other zones | DMA zone exhausted | Reduce `GFP_DMA`/`GFP_DMA32` consumers; check driver memory usage |
| kswapd running without memory pressure | Watermark boost active | Check `boost` field in `/proc/zoneinfo`; consider lowering `watermark_boost_factor` |
| High-order allocation failures persist | Zone fragmentation | Inspect `/proc/buddyinfo`; consider `vm.compaction_proactiveness` |
