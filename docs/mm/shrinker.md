# Shrinker API

> A callback mechanism that lets subsystems participate in memory reclaim — when the kernel needs memory, it asks registered shrinkers to free their caches.

## What Are Shrinkers?

The kernel maintains many in-memory caches: directory entry (dentry) caches, inode caches, DMA-buf heaps, driver-private object pools, zswap pools, and more. These caches are valuable — they avoid expensive recomputation or I/O — but they must yield memory when the system is under pressure.

The shrinker API is how subsystems register with the memory management core to say: "I have objects you can ask me to free." When reclaim runs, it calls every registered shrinker twice per sweep: first to ask how much could be freed (counting pass), then to actually free some of it (scanning pass).

Examples of shrinkers in the tree:

- `fs/super.c` — per-superblock shrinker covering dentry LRU and inode LRU (`super_cache_scan` / `super_cache_count`)
- `mm/huge_memory.c` — deferred split THP shrinker
- `mm/zswap.c` — zswap pool shrinker
- `mm/workingset.c` — workingset shadow entry shrinker
- `fs/xfs/xfs_icache.c` — XFS inode GC shrinker
- `mm/vmalloc.c` — vmap node shrinker

## `struct shrinker`

From `include/linux/shrinker.h`:

```c
struct shrinker {
    unsigned long (*count_objects)(struct shrinker *,
                                   struct shrink_control *sc);
    unsigned long (*scan_objects)(struct shrinker *,
                                  struct shrink_control *sc);

    long batch;     /* reclaim batch size, 0 = default */
    int seeks;      /* seeks to recreate an obj */
    unsigned flags;

    /*
     * The reference count of this shrinker. Registered shrinkers have an
     * initial refcount of 1, then lookup operations are allowed to use it
     * via shrinker_try_get(). On unregistration the initial refcount is
     * discarded, and the shrinker is freed asynchronously via RCU after
     * its refcount reaches 0.
     */
    refcount_t refcount;
    struct completion done;  /* used to wait for refcount to reach 0 */
    struct rcu_head rcu;

    void *private_data;

    /* Internal use */
    struct list_head list;
#ifdef CONFIG_MEMCG
    int id;          /* ID in shrinker_idr */
#endif
#ifdef CONFIG_SHRINKER_DEBUG
    int debugfs_id;
    const char *name;
    struct dentry *debugfs_entry;
#endif
    /* objs pending delete, per node */
    atomic_long_t *nr_deferred;
};

#define DEFAULT_SEEKS 2
```

### Field guide

| Field | Description |
|-------|-------------|
| `count_objects` | Return the number of objects that *could* be freed. Called without actually freeing anything. |
| `scan_objects` | Free up to `sc->nr_to_scan` objects. Return number freed, `SHRINK_STOP`, or `SHRINK_EMPTY`. |
| `batch` | How many objects to scan per `scan_objects` call. `0` uses the internal default of 128. Larger batches reduce call overhead; smaller batches improve latency. |
| `seeks` | Relative cost to recreate one object (disk seeks as a unit). Used by the priority scaling formula. Use `DEFAULT_SEEKS` (2) if unsure. Set to 0 for objects that require no I/O to recreate — this causes them to be trimmed more aggressively. |
| `flags` | `SHRINKER_NUMA_AWARE`, `SHRINKER_MEMCG_AWARE`, `SHRINKER_NONSLAB` — described below. |
| `private_data` | Opaque pointer for the shrinker implementation, e.g. the `super_block *` in `fs/super.c`. |
| `nr_deferred` | Per-node count of scan work that was calculated but not yet completed (due to `batch` rounding or contention). Carried forward to the next invocation. Managed by the core. |

## `struct shrink_control`

The kernel passes a `struct shrink_control` to both callbacks on every invocation.

```c
struct shrink_control {
    gfp_t gfp_mask;

    /* current node being shrunk (for NUMA aware shrinkers) */
    int nid;

    /*
     * How many objects scan_objects should scan and try to reclaim.
     * Reset before every call.
     */
    unsigned long nr_to_scan;

    /*
     * How many objects did scan_objects process?
     * Defaults to nr_to_scan; callee should update to reflect actual progress.
     */
    unsigned long nr_scanned;

    /* current memcg being shrunk (for memcg aware shrinkers) */
    struct mem_cgroup *memcg;
};
```

### Field semantics

**`gfp_mask`** — the allocation context that triggered reclaim. Shrinkers must respect this. If `__GFP_FS` is clear, the shrinker must not enter the filesystem (e.g., `super_cache_scan` returns `SHRINK_STOP` immediately in that case). If `__GFP_IO` is clear, avoid starting I/O.

**`nid`** — the NUMA node being shrunk. Only meaningful when `SHRINKER_NUMA_AWARE` is set; other shrinkers always see node 0.

**`nr_to_scan`** — set by the core before calling `scan_objects`. The shrinker should attempt to free this many objects. It is safe to modify (the core resets it before each call).

**`nr_scanned`** — pre-filled to `nr_to_scan` by the core. The shrinker should update this to reflect how many objects were actually examined (not just freed). The core uses it to account for work done when updating `nr_deferred`.

**`memcg`** — the memory cgroup being targeted. Set by the core when walking per-memcg shrinkers; `NULL` for the global (root memcg) path. Only meaningful when `SHRINKER_MEMCG_AWARE` is set.

## `count_objects` vs `scan_objects`

These two callbacks implement a two-phase contract:

### `count_objects` — estimate freeable capacity

```c
unsigned long (*count_objects)(struct shrinker *, struct shrink_control *sc);
```

Return the number of objects that *could* be freed from the cache. The return value controls whether `scan_objects` is called at all:

| Return value | Meaning |
|---|---|
| `SHRINK_EMPTY` (`~0UL - 1`) | The cache is completely empty. The core clears the per-memcg shrinker bit for this shrinker, skipping it in future passes until new objects are added. |
| `0` | Nothing freeable right now (e.g., all objects are pinned, or count is below a threshold). `scan_objects` will not be called for this sweep. |
| `N > 0` | There are approximately N freeable objects. The core uses this to calculate how many objects to request via `nr_to_scan`. |

**No lock requirements.** `count_objects` must not take locks that could deadlock with reclaim. The count can be stale — the core tolerates a mismatch between `count_objects` and what `scan_objects` actually frees. This is by design: counts are used for proportional scaling, not as hard limits.

### `scan_objects` — actually free objects

```c
unsigned long (*scan_objects)(struct shrinker *, struct shrink_control *sc);
```

Walk your cache, free up to `sc->nr_to_scan` objects, update `sc->nr_scanned`, and return the number of objects freed.

| Return value | Meaning |
|---|---|
| `N >= 0` | Number of objects freed during this call. |
| `SHRINK_STOP` (`~0UL`) | Cannot make progress right now — a lock that would be needed could cause a deadlock in the current reclaim context. The core will not call `scan_objects` again for this shrinker during the current reclaim invocation. |
| `SHRINK_EMPTY` (`~0UL - 1`) | No objects remain in the cache. |

```c
/* Defined in include/linux/shrinker.h */
#define SHRINK_STOP  (~0UL)
#define SHRINK_EMPTY (~0UL - 1)
```

## Shrinker Flags

```c
#define SHRINKER_NUMA_AWARE   BIT(2)
#define SHRINKER_MEMCG_AWARE  BIT(3)
#define SHRINKER_NONSLAB      BIT(4)
```

**`SHRINKER_NUMA_AWARE`** — the shrinker is called once per NUMA node. `sc->nid` is set to the node being reclaimed. Use this when your cache is partitioned by node (e.g., per-node LRUs). Without this flag, the shrinker is called once with `nid = 0` regardless of which node is under pressure.

**`SHRINKER_MEMCG_AWARE`** — the shrinker participates in per-memcg reclaim. When a memcg is over its limit, the core calls shrinkers that are `MEMCG_AWARE` with `sc->memcg` set to the target cgroup. The shrinker must then only free objects charged to that memcg. This requires your LRU to be initialized with `list_lru_init_memcg()`. Without this flag, the shrinker is only called during global (root-cgroup) reclaim.

**`SHRINKER_NONSLAB`** — only meaningful in combination with `SHRINKER_MEMCG_AWARE`. Marks a shrinker as managing non-slab memory. When memcg kmem accounting is disabled, non-`NONSLAB` shrinkers are skipped during per-memcg reclaim; `NONSLAB` shrinkers are always called. Used for objects like DMA-buf attachments that are not slab allocations but should still be reclaimed per-memcg.

## How the Kernel Invokes Shrinkers

### Call path

```
Memory pressure (allocation fails or watermark crossed)
    │
    ├── kswapd (background) ──────────────────────────────┐
    │                                                      │
    └── direct reclaim (allocating process blocks) ────────┤
                                                           │
                                                           v
                                              shrink_node() in mm/vmscan.c
                                                           │
                                                           v
                                              shrink_slab(gfp_mask, nid,
                                                          memcg, priority)
                                              in mm/shrinker.c
                                                           │
                                     ┌─────────────────────┴──────────────────────┐
                                     │ (non-root memcg)                           │ (root)
                                     v                                            v
                          shrink_slab_memcg()                    list_for_each_entry_rcu
                          iterates per-memcg bitmap               over shrinker_list
                                     │                                            │
                                     └──────────────┬─────────────────────────────┘
                                                    v
                                          do_shrink_slab(sc, shrinker, priority)
                                                    │
                                          1. call count_objects()
                                          2. compute nr_to_scan via priority
                                          3. loop: call scan_objects() in
                                             batches until total_scan exhausted
                                             or SHRINK_STOP returned
```

### Priority scaling in `do_shrink_slab`

The `priority` parameter (from `sc->priority` in `mm/vmscan.c`) controls how aggressively the shrinker is invoked. Higher priority means more memory pressure.

```c
/* From mm/shrinker.c: do_shrink_slab() */
if (shrinker->seeks) {
    delta = freeable >> priority;  /* at priority 12: very small delta */
    delta *= 4;
    do_div(delta, shrinker->seeks);
} else {
    delta = freeable / 2;          /* seeks=0: trim half regardless */
}

total_scan = nr >> priority;   /* deferred work, scaled down at low priority */
total_scan += delta;
total_scan = min(total_scan, (2 * freeable));
```

At `priority = DEF_PRIORITY` (12, low pressure): `freeable >> 12` is tiny — the shrinker is barely touched. As priority approaches 0 (extreme pressure): the full deferred count and a larger `delta` are applied, scanning more objects per call. `total_scan` is capped at `2 * freeable` to prevent over-scanning.

`do_shrink_slab` then calls `scan_objects` in a loop, `batch_size` objects at a time, until `total_scan` is exhausted or `SHRINK_STOP` is returned. Any work calculated but not done (due to batch rounding) is saved in `nr_deferred` and added to the next invocation.

### Concurrency and locking

The shrinker list is protected by `shrinker_mutex` for mutation (registration/unregistration) and by RCU for iteration. Individual shrinker lookup uses `shrinker_try_get()` (a `refcount_inc_not_zero`) to hold a reference while `do_shrink_slab` runs. `shrinker_free()` calls `wait_for_completion(&shrinker->done)` to drain all in-flight references before freeing memory.

This means `scan_objects` can run concurrently on different CPUs (for different nodes or memcgs). Shrinker implementations must be safe under concurrent calls.

## Registration and Lifecycle

### The three-step lifecycle

```c
/* 1. Allocate and configure */
struct shrinker *shrinker;

shrinker = shrinker_alloc(SHRINKER_NUMA_AWARE | SHRINKER_MEMCG_AWARE,
                           "mydriver-%s", device_name);
if (!shrinker)
    return -ENOMEM;

shrinker->count_objects = mydriver_count_objects;
shrinker->scan_objects  = mydriver_scan_objects;
shrinker->seeks         = DEFAULT_SEEKS;
shrinker->private_data  = my_private_ctx;

/* 2. Register (shrinker becomes visible to reclaim) */
shrinker_register(shrinker);

/* ... device/module in use ... */

/* 3. Free (unregisters, drains references, then frees asynchronously via RCU) */
shrinker_free(shrinker);
```

### `shrinker_alloc(flags, fmt, ...)`

Allocates and initializes a `struct shrinker`. The `fmt` argument is a `printf`-style name used in `/sys/kernel/debug/shrinker/` (when `CONFIG_SHRINKER_DEBUG` is set). If `SHRINKER_MEMCG_AWARE` is requested but memcg is disabled at runtime, the flag is silently cleared and the shrinker falls back to non-memcg mode.

Returns `NULL` on allocation failure.

### `shrinker_register(shrinker)`

Adds the shrinker to `shrinker_list`, sets `SHRINKER_REGISTERED`, and initializes `refcount` to 1 (making it visible to reclaim). Must only be called on a shrinker returned by `shrinker_alloc()`.

### `shrinker_free(shrinker)`

Handles both unregistration and freeing in one call:

1. If registered: drops the initial refcount and waits (`wait_for_completion`) for all in-flight `do_shrink_slab` calls to finish.
2. Removes from `shrinker_list` under `shrinker_mutex`.
3. Removes from the memcg IDR if `SHRINKER_MEMCG_AWARE`.
4. Schedules the struct itself for `kfree` via `call_rcu`.

After `shrinker_free()` returns, it is safe to free whatever structure holds the shrinker (e.g., the `super_block`, the driver's device structure).

### When to call each

| Situation | When to register | When to free |
|-----------|-----------------|--------------|
| Module-global cache | `module_init` / `subsys_initcall` | `module_exit` |
| Per-device cache | `probe()`, after cache is initialized | `remove()` / error path in `probe()` |
| Per-superblock cache | `sget()` / `alloc_super()`, before mount completes | `kill_sb()` / `deactivate_super()` |

## Real Example: The Superblock Shrinker

Every mounted filesystem gets a per-superblock shrinker covering both the dentry LRU and the inode LRU. It is set up in `alloc_super()` (`fs/super.c`):

```c
/* fs/super.c: alloc_super() */
s->s_shrink = shrinker_alloc(SHRINKER_NUMA_AWARE | SHRINKER_MEMCG_AWARE,
                              "sb-%s", type->name);

s->s_shrink->scan_objects  = super_cache_scan;
s->s_shrink->count_objects = super_cache_count;
s->s_shrink->batch         = 1024;
s->s_shrink->private_data  = s;
```

The shrinker is registered later, after the superblock is fully set up and marked `SB_BORN`:

```c
/* fs/super.c: vfs_get_tree() / mount_fs() path */
shrinker_register(s->s_shrink);
```

**`super_cache_count`** queries `list_lru_shrink_count()` on the dentry and inode LRUs, adds any filesystem-private object count from `s_op->nr_cached_objects()`, and returns `SHRINK_EMPTY` if the total is zero.

**`super_cache_scan`** proportionally distributes `sc->nr_to_scan` across dentries, inodes, and FS-private objects. It calls `prune_dcache_sb()` first (dentries pin inodes), then `prune_icache_sb()`, then `s_op->free_cached_objects()`. If `__GFP_FS` is not set in `sc->gfp_mask`, it returns `SHRINK_STOP` immediately to avoid re-entering a filesystem that may be holding locks.

## Common Mistakes

!!! warning "Blocking or sleeping in `scan_objects` without checking `gfp_mask`"
    `scan_objects` can be called from direct reclaim in any context. If the caller holds a lock that your shrinker also needs, or if reclaim is happening under a filesystem lock, taking that lock again will deadlock. Always check `sc->gfp_mask` for `__GFP_FS` and `__GFP_IO` before entering the filesystem or starting I/O. Return `SHRINK_STOP` if you cannot safely proceed.

!!! warning "Returning 0 from `count_objects` when the cache is actually empty"
    `0` means "nothing freeable right now" (e.g., objects are pinned). `SHRINK_EMPTY` means "the cache is completely empty." These are not interchangeable. Returning `0` when the cache is empty costs nothing in the global reclaim path, but in the per-memcg path it prevents the kernel from clearing the shrinker's bit in the memcg bitmap, causing unnecessary future wakeups.

!!! warning "Mishandling `nr_scanned`"
    `sc->nr_scanned` is pre-filled to `sc->nr_to_scan`. If your `scan_objects` examines fewer objects than requested (e.g., because it hit a trylock and skipped some), update `sc->nr_scanned` to reflect the actual number examined. The core uses it to compute `next_deferred`. Leaving it at `nr_to_scan` when you scanned fewer will incorrectly mark that work as done and under-report deferred work.

!!! warning "Forgetting to call `shrinker_free` on error paths"
    If `shrinker_register` has been called and your device or module initialization later fails, `shrinker_free` must be called before returning the error. A registered shrinker pointing to freed or partially-initialized data will be called during the next reclaim cycle, causing a use-after-free or a NULL dereference. `shrinker_free` handles both the unregistered case (no-op if not yet registered) and the registered case, so it is safe to call unconditionally on any cleanup path after `shrinker_alloc` has succeeded.

!!! warning "Concurrent calls to `scan_objects`"
    The kernel may call `scan_objects` concurrently for different nodes (if `SHRINKER_NUMA_AWARE`) or different memcgs (if `SHRINKER_MEMCG_AWARE`). Your LRU walks and counters must be safe under concurrent access. Use `list_lru` (which has per-node, per-memcg locking built in) rather than rolling your own list.

!!! warning "Using `seeks = 0` unintentionally"
    Setting `seeks` to 0 triggers the aggressive branch in `do_shrink_slab`: `delta = freeable / 2`. This means at any priority, the shrinker requests to scan half its freeable objects in one pass. This is intentional for caches that are cheap to repopulate (no I/O), but using it by accident for an expensive cache will cause excessive eviction under pressure.

## Key Source Files

| File | Description |
|------|-------------|
| [`include/linux/shrinker.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/shrinker.h) | `struct shrinker`, `struct shrink_control`, `SHRINK_STOP`, `SHRINK_EMPTY`, flags, `shrinker_alloc`/`shrinker_register`/`shrinker_free` declarations |
| [`mm/shrinker.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/shrinker.c) | `shrinker_alloc`, `shrinker_register`, `shrinker_free`, `do_shrink_slab`, `shrink_slab`, `shrink_slab_memcg`, memcg bitmap management |
| [`mm/vmscan.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmscan.c) | `shrink_node`, `shrink_lruvec` — where `shrink_slab()` is called from during reclaim |
| [`fs/super.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/super.c) | `super_cache_scan`, `super_cache_count`, per-superblock shrinker setup in `alloc_super` |
| [`fs/dcache.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/dcache.c) | `prune_dcache_sb` — called by `super_cache_scan` to shrink the dentry LRU |
| [`fs/inode.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/inode.c) | `prune_icache_sb` — called by `super_cache_scan` to shrink the inode LRU |
| [`include/linux/list_lru.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/list_lru.h) | `list_lru_init_memcg`, `list_lru_shrink_count`, `list_lru_shrink_walk` — NUMA/memcg-aware LRU used with shrinkers |

## Further reading

- [mm/shrinker.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/shrinker.c) — `shrinker_alloc()`, `shrinker_register()`, `shrinker_free()`, `do_shrink_slab()` (priority scaling and batch loop), `shrink_slab()`, and `shrink_slab_memcg()` with the per-memcg bitmap
- [mm/vmscan.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmscan.c) — `shrink_node()` and `shrink_lruvec()`, the reclaim entry points that call `shrink_slab()` after scanning LRU lists
- [LWN: Smarter shrinkers](https://lwn.net/Articles/550463/) — motivation and design for the two-phase `count_objects`/`scan_objects` split, replacing the older single-callback model
- [LWN: Shrinker reorganization](https://lwn.net/Articles/966451/) — the extraction of shrinker code from `mm/vmscan.c` into the dedicated `mm/shrinker.c` file and the RCU-based refcount lifecycle introduced alongside it
- [reclaim](reclaim.md) — the broader reclaim picture showing where `shrink_slab()` fits alongside LRU scanning, kswapd, and direct reclaim
- [memcg](memcg.md) — per-cgroup reclaim context: when `sc->memcg` is set and how `SHRINKER_MEMCG_AWARE` shrinkers interact with cgroup memory limits
