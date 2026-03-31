# Reclaim Throttling and Balancing

> How the kernel slows down allocators when reclaim can't keep up

When memory pressure is high, two things must not happen simultaneously: a single
allocating process must not monopolize the CPU burning through reclaim, and
reclaim must not be overwhelmed while allocators continue charging ahead. The
kernel solves both problems with throttling — temporarily pausing allocating
processes to let reclaim make progress, and coordinating between kswapd and
direct reclaimers to balance the load.

## Key Source Files

| File | Relevant functions |
|------|--------------------|
| [`mm/vmscan.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmscan.c) | `reclaim_throttle()` — core throttle sleep; `throttle_direct_reclaim()` — pfmemalloc-reserve throttle; `consider_reclaim_throttle()` — NOPROGRESS path; `balance_pgdat()` — kswapd node balancing; `shrink_node()` — per-node reclaim; `allow_direct_reclaim()` — wakeup condition; `pgdat_balanced()` — watermark check; `writeback_throttling_sane()` — dirty throttle availability |
| [`mm/memcontrol.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c) | `__mem_cgroup_handle_over_high()` — memory.high enforcement; `reclaim_high()` — cgroup reclaim loop; `calculate_high_delay()` — proportional penalty; `mem_find_max_overage()` / `swap_find_max_overage()` — ancestor overage scan |
| [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) | `__alloc_pages_slowpath()` — slow allocation path; `__alloc_pages_direct_reclaim()` / `__perform_reclaim()` — direct reclaim entry; `try_to_free_pages()` call site |
| [`include/linux/mmzone.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mmzone.h) | `enum vmscan_throttle_state`, `enum pgdat_flags`, `enum lruvec_flags`, `reclaim_wait[]` waitqueues, `pfmemalloc_wait` waitqueue |

---

## Why Throttling Exists

Without throttling, an application that allocates memory rapidly could cycle
continuously through direct reclaim, consuming entire CPU cores in an attempt
to free pages. Other processes would be starved and forward progress on actual
work would stall. More subtly, reclaim itself can reach a state where it cannot
recover: if every page it finds is under writeback, scanning more aggressively
just wastes CPU. The right answer is to pause and wait.

Throttling achieves two goals:

1. **Fairness** — prevents one process from monopolising the reclaim path.
2. **Backpressure** — when reclaim cannot keep up, slow the allocators rather than spin on futile work.

The kernel distinguishes several distinct reasons for throttling, each with its own
wait queue and timeout:

```
enum vmscan_throttle_state {
    VMSCAN_THROTTLE_WRITEBACK,   /* pages cycling through LRU faster than writeback */
    VMSCAN_THROTTLE_ISOLATED,    /* too many parallel reclaimers isolating pages */
    VMSCAN_THROTTLE_NOPROGRESS,  /* reclaim making no headway at high priority */
    VMSCAN_THROTTLE_CONGESTED,   /* dirty pages backed by a congested device */
    NR_VMSCAN_THROTTLE,
};
```

The `pg_data_t` structure (one per NUMA node) holds one wait queue per throttle
reason, plus a separate queue for direct-reclaim pfmemalloc throttling:

```c
/* include/linux/mmzone.h */
wait_queue_head_t reclaim_wait[NR_VMSCAN_THROTTLE];
wait_queue_head_t pfmemalloc_wait;
```

---

## Direct Reclaim vs. kswapd

The kernel has two reclaim actors:

```
Allocation path                     Background
───────────────                     ──────────
alloc_pages()                       kswapd (per-node kernel thread)
    │                                   │
    └─ __alloc_pages_slowpath()         └─ balance_pgdat()
           │                                    │
           └─ __alloc_pages_direct_reclaim()    └─ kswapd_shrink_node()
                  │                                     │
                  └─ __perform_reclaim()                └─ shrink_node()
                         │
                         └─ try_to_free_pages()
                                │
                                └─ shrink_zones()
                                       │
                                       └─ shrink_node()
```

**kswapd** runs in the background and reclaims pages until each zone's free
pages rise above the `high` watermark. It does not block any allocating
process.

**Direct reclaim** runs in the context of the allocating process itself when
`__alloc_pages_slowpath()` cannot satisfy an allocation from existing free
pages. The process calling `alloc_pages()` enters `try_to_free_pages()` and
may be throttled there.

!!! note "Priority escalation"
    Both paths use a reclaim priority that starts at `DEF_PRIORITY` (12) and
    descends toward 0. At priority *p*, each LRU list scan covers
    `list_size >> p` pages — lower priorities scan larger fractions of memory
    until the full list is examined at priority 0.

---

## `reclaim_throttle()` — Core Sleep Function

`reclaim_throttle()` in `mm/vmscan.c` is the single function through which
all non-pfmemalloc throttling passes:

```c
void reclaim_throttle(pg_data_t *pgdat, enum vmscan_throttle_state reason)
```

It selects the appropriate wait queue from `pgdat->reclaim_wait[reason]` and
puts the calling task to sleep with `TASK_UNINTERRUPTIBLE` for a reason-dependent
timeout:

| Throttle reason | Timeout | When triggered |
|-----------------|---------|----------------|
| `VMSCAN_THROTTLE_WRITEBACK` | `HZ/10` (100 ms) | Pages cycling the LRU faster than writeback can drain them (`sc->nr.immediate` non-zero) |
| `VMSCAN_THROTTLE_ISOLATED` | `HZ/50` (20 ms) | Too many parallel reclaimers have isolated pages from the LRU simultaneously |
| `VMSCAN_THROTTLE_NOPROGRESS` | 1 jiffy | Direct reclaim at priority 1 with zero pages reclaimed |
| `VMSCAN_THROTTLE_CONGESTED` | 1 jiffy | All dirty pages backed by a congested device (`LRUVEC_CGROUP_CONGESTED` or `LRUVEC_NODE_CONGESTED` set) |

!!! info "Kernel threads are exempt"
    `reclaim_throttle()` skips throttling for any task with `PF_USER_WORKER` or
    `PF_KTHREAD` set (except kswapd itself). Journalling threads, writeback
    workers, and other kernel threads must remain free to run because reclaim
    depends on them to make forward progress.

For `VMSCAN_THROTTLE_WRITEBACK`, the code also tracks how many pages have
completed writeback since throttling began (`pgdat->nr_reclaim_start`), so
that `__acct_reclaim_writeback()` can wake throttled tasks early once enough
pages have been cleaned — rather than always waiting the full timeout.

**Who wakes throttled tasks?**  `balance_pgdat()` in kswapd wakes the
`pfmemalloc_wait` queue when `allow_direct_reclaim()` becomes true. The
`reclaim_wait[]` queues are woken by `consider_reclaim_throttle()` when
reclaim efficiency exceeds 12% (scanned-to-reclaimed ratio `> 1/8`), and by
kswapd when it clears the congested state.

---

## `throttle_direct_reclaim()` — pfmemalloc Reserve Throttle

This is a separate throttle path with a different purpose. The kernel reserves
a portion of low-zone pages (`pfmemalloc` reserves) for network stack
allocations needed to swap over the network. If those reserves are depleted,
allowing further direct reclaim would be counterproductive — kswapd should
handle it unimpeded.

```c
static bool throttle_direct_reclaim(gfp_t gfp_mask,
                                    struct zonelist *zonelist,
                                    nodemask_t *nodemask)
```

The function is called at the top of `try_to_free_pages()`, before any
reclaim work begins. It immediately returns (no throttle) if:

- The calling task has `PF_KTHREAD` set (kernel thread).
- A fatal signal is pending (let the process exit and free its memory
  naturally).
- `allow_direct_reclaim()` returns true — the sum of free pages across all zones up to and including `ZONE_NORMAL` exceeds half the accumulated pfmemalloc reserve across those same zones.

When throttling is applied, the process sleeps on `pgdat->pfmemalloc_wait`:

```c
/* Caller cannot enter filesystem — might be holding a journal lock */
if (!(gfp_mask & __GFP_FS))
    wait_event_interruptible_timeout(pgdat->pfmemalloc_wait,
                                     allow_direct_reclaim(pgdat), HZ);
else
    /* Block until kswapd makes progress */
    wait_event_killable(pgdat->pfmemalloc_wait,
                        allow_direct_reclaim(pgdat));
```

Each throttle event increments the `PGSCAN_DIRECT_THROTTLE` vmstat counter
(visible as `pgscan_direct_throttle` in `/proc/vmstat`).

`allow_direct_reclaim()` iterates all zones from the lowest up through `ZONE_NORMAL`, accumulating both free pages and pfmemalloc reserves, then checks if `free_pages > pfmemalloc_reserve / 2`. If the node is in a hopeless state (`kswapd_test_hopeless()`), direct reclaim is always permitted.

!!! warning "Fatal signal handling"
    If `throttle_direct_reclaim()` returns `true`, a fatal signal arrived
    during the sleep. `try_to_free_pages()` returns 1 in that case, and the
    page allocator skips the OOM killer — the process is already dying.

---

## `consider_reclaim_throttle()` — No-Progress Throttle

After each `shrink_zones()` pass during direct reclaim,
`consider_reclaim_throttle()` evaluates whether throttling is warranted:

```c
static void consider_reclaim_throttle(pg_data_t *pgdat,
                                      struct scan_control *sc)
```

- If reclaim efficiency is above 12.5% (`sc->nr_reclaimed > sc->nr_scanned >> 3`),
  it wakes any tasks already sleeping on `VMSCAN_THROTTLE_NOPROGRESS`.
- If we are at priority 1 (one step from scanning the entire LRU) and
  `sc->nr_reclaimed` is still zero, it calls
  `reclaim_throttle(pgdat, VMSCAN_THROTTLE_NOPROGRESS)`.
- kswapd and cgroup reclaim are exempt — they use `VMSCAN_THROTTLE_WRITEBACK`
  instead when stalled on I/O.

---

## Memory Cgroup Throttling — the `memory.high` Path

### The Proportional Delay

cgroup v2's `memory.high` is a soft limit. Exceeding it does not immediately
kill or hard-stop the cgroup. Instead, the exceeding process is slowed down
proportionally to how far over the limit the cgroup (or any of its ancestors)
has drifted.

When an allocation causes a cgroup to exceed `memory.high`, the charge path
sets `current->memcg_nr_pages_over_high`. On the return to userspace (or
sooner if the count exceeds `MEMCG_CHARGE_BATCH`),
`__mem_cgroup_handle_over_high()` is called:

```
Allocation exceeds memory.high
           │
           v
    memcg_nr_pages_over_high += batch
           │
           v (on return to userspace or if count > MEMCG_CHARGE_BATCH)
    __mem_cgroup_handle_over_high()
           │
           ├── reclaim_high()              ← try_to_free_mem_cgroup_pages()
           │       walking up cgroup tree
           │
           ├── calculate_high_delay()      ← exponential penalty in jiffies
           │
           └── schedule_timeout_killable(penalty_jiffies)
```

`reclaim_high()` walks up the cgroup hierarchy reclaiming from each ancestor
that is over its `memory.high` limit. After up to `MAX_RECLAIM_RETRIES` (16)
attempts at reclaim, if usage is still above the limit,
`calculate_high_delay()` computes a sleep duration.

### The Delay Formula

The penalty is calculated by `calculate_high_delay()`:

```c
penalty_jiffies = max_overage * max_overage * HZ;
penalty_jiffies >>= MEMCG_DELAY_PRECISION_SHIFT;   /* 20 bits */
penalty_jiffies >>= MEMCG_DELAY_SCALING_SHIFT;     /* 14 bits */

/* Scale by nr_pages relative to MEMCG_CHARGE_BATCH */
return penalty_jiffies * nr_pages / MEMCG_CHARGE_BATCH;
```

`max_overage` is a fixed-point ratio of how far over `memory.high` the cgroup
(or its worst ancestor) is, computed as:

```c
overage = (usage - high) << MEMCG_DELAY_PRECISION_SHIFT;
overage = overage / high;   /* fraction of the limit */
```

The quadratic term means the penalty grows quickly with overage: a cgroup
that is 2× over its limit is penalised far more than one just barely over.
The final result is clamped to `MEMCG_MAX_HIGH_DELAY_JIFFIES` (2 seconds) per
return-to-userspace batch, so the application never hangs permanently — it
just runs very slowly.

!!! note "Separate memory and swap penalties"
    `calculate_high_delay()` is called twice: once with the result of
    `mem_find_max_overage()` (memory overage) and once with
    `swap_find_max_overage()` (swap overage). Both ancestors in the hierarchy
    are walked independently and the penalties are additive.

!!! note "Small overages are free"
    If `penalty_jiffies <= HZ/100` (10 ms), the task is not slept at all.
    This avoids penalising cgroups that drifted only slightly over their limit
    and may already be reclaiming successfully.

---

## Write Throttling and Reclaim Stalls

### `PGDAT_WRITEBACK` and the Writeback Throttle

When `shrink_node()` finds that every page it examined is under writeback
(`sc->nr.writeback == sc->nr.taken`), it sets the `PGDAT_WRITEBACK` flag on
the node. This signals to kswapd that dirty writeback is keeping pace with
LRU scanning and that pages are cycling through the list faster than the
storage can drain them.

If `sc->nr.immediate` is non-zero — pages both under writeback *and* already
recycled back to the tail of the inactive LRU — `shrink_node()` calls:

```c
reclaim_throttle(pgdat, VMSCAN_THROTTLE_WRITEBACK);
```

This sleeps for up to 100 ms or until `__acct_reclaim_writeback()` wakes the
queue after enough pages complete writeback.

### `LRUVEC_NODE_CONGESTED` and `VMSCAN_THROTTLE_CONGESTED`

If all dirty pages scanned are both dirty and congested
(`sc->nr.dirty == sc->nr.congested`), the node is marked congested via
`LRUVEC_NODE_CONGESTED` (set by kswapd) or `LRUVEC_CGROUP_CONGESTED` (set by
cgroup reclaim). Direct reclaimers that detect either flag then call:

```c
reclaim_throttle(pgdat, VMSCAN_THROTTLE_CONGESTED);
```

kswapd itself is not throttled here — it is free to keep scanning since
stalling kswapd would stop all reclaim progress. Only user-context direct
reclaimers sleep.

### `balance_dirty_pages()` — the Upstream Throttle

The write-throttle path in `mm/page-writeback.c` is the primary mechanism
for slowing down processes that dirty pages faster than writeback can drain
them. `balance_dirty_pages()` is called by the filesystem write path — it is
not called directly by the reclaim path. However, the two interact: if
`balance_dirty_pages()` is unavailable (for example with legacy cgroup v1
memory controllers where writeback and memcg are decoupled),
`writeback_throttling_sane()` returns `false` and `shrink_folio_list()` falls
back to stalling directly on writeback I/O, which lacks the fairness and
bandwidth-proportionality of the normal dirty throttle.

---

## Fair Reclaim Under Pressure

### Reclaim Priority and the Cgroup Hierarchy

When multiple cgroups are all under memory pressure, the kernel does not
simply reclaim from the cgroup with the most memory. `shrink_node_memcgs()`
iterates all memcgs in the node's lruvec tree and calls
`shrink_lruvec()` on each one. The amount scanned from each cgroup is
proportional to that cgroup's share of reclaimable pages on the node, modified
by its configured `swappiness`.

Reclaim priority starts at `DEF_PRIORITY` (12) and decrements toward 0 as
pressure increases. At each priority level, the scan visits a fraction
`1 >> priority` of each LRU list. Lower priorities scan larger fractions —
priority 0 scans the entire list.

### Cgroup Hierarchy Walk in `reclaim_high()`

For `memory.high` enforcement, `reclaim_high()` does not just reclaim from
the directly exceeding cgroup. It walks up to the root via
`parent_mem_cgroup()`, reclaiming from each ancestor that is also over its
own `memory.high`. This prevents a deeply nested cgroup from escaping its
ancestors' limits just because the immediate parent happens to be within its
own limit.

```c
do {
    if (page_counter_read(&memcg->memory) > READ_ONCE(memcg->memory.high))
        nr_reclaimed += try_to_free_mem_cgroup_pages(...);
} while ((memcg = parent_mem_cgroup(memcg)) &&
         !mem_cgroup_is_root(memcg));
```

The `mem_find_max_overage()` function performs a similar ancestor walk when
computing the penalty delay, picking the worst (most over-limit) ancestor to
determine the penalty magnitude.

---

## `balance_pgdat()` — kswapd Node Balancing

kswapd's main loop calls `balance_pgdat()` to reclaim pages on a node until
at least one zone is balanced. A zone is balanced when its free pages pass
the `high` watermark as tested by `pgdat_balanced()`:

```c
static bool pgdat_balanced(pg_data_t *pgdat, int order, int highest_zoneidx)
```

It checks zones from lowest to highest, returning `true` as soon as one zone
satisfies `__zone_watermark_ok()` at the `high_wmark_pages()` threshold.

Once `pgdat_balanced()` is true, kswapd calls `prepare_kswapd_sleep()` which:

1. Wakes any processes sleeping on `pgdat->pfmemalloc_wait` (they were
   waiting for pfmemalloc reserves to be replenished).
2. Calls `clear_pgdat_congested()` to clear `PGDAT_WRITEBACK`,
   `LRUVEC_NODE_CONGESTED`, and `LRUVEC_CGROUP_CONGESTED`.

`balance_pgdat()` also wakes `pfmemalloc_wait` mid-loop whenever
`allow_direct_reclaim()` becomes true, so throttled allocators are not
forced to wait until kswapd has fully balanced the node.

---

## Observing Throttling

### PSI — the Most Direct Signal

Pressure Stall Information captures exactly the phenomenon throttling
addresses: tasks stalled waiting for memory. See [PSI](psi.md) for a full
explanation. During reclaim throttling, tasks waiting in `reclaim_throttle()`
or `throttle_direct_reclaim()` are accounted as memory stalls by
`psi_memstall_enter()` / `psi_memstall_leave()`.

```bash
# Snapshot — "full" means every runnable task was stalled
cat /proc/pressure/memory
# some avg10=8.42 avg60=3.11 avg300=1.05 total=12450183
# full avg10=2.17 avg60=0.84 avg300=0.27 total=3241885
```

Rising `full` memory pressure is a reliable indicator that throttling is
active and the system cannot reclaim fast enough.

### `/proc/vmstat` Counters

```bash
grep -E 'pgscan|pgsteal|allocstall|throttle' /proc/vmstat
```

| Counter | Meaning |
|---------|---------|
| `pgscan_kswapd` | Pages scanned by kswapd |
| `pgsteal_kswapd` | Pages reclaimed by kswapd |
| `pgscan_direct` | Pages scanned during direct reclaim |
| `pgsteal_direct` | Pages reclaimed during direct reclaim |
| `pgscan_direct_throttle` | Times `throttle_direct_reclaim()` blocked a process |
| `allocstall_*` | Times `try_to_free_pages()` was entered per zone class |

**Interpreting the ratios:**

- A healthy system has `pgscan_kswapd` far exceeding `pgscan_direct`. kswapd
  is handling pressure in the background and direct reclaim rarely activates.
- High `pgscan_direct` relative to `pgscan_kswapd` means kswapd cannot keep
  up and allocating processes are doing their own reclaim. This is a sign of
  sustained memory pressure.
- Rising `pgscan_direct_throttle` means pfmemalloc reserves are repeatedly
  depleted — the system may be near the edge of what kswapd can handle.
- High `allocstall_*` counts indicate `try_to_free_pages()` is entered
  frequently. Each increment corresponds to a process entering direct reclaim
  (not a throttle event itself, but a reclaim entry).

!!! tip "Watch the steal/scan ratio"
    `pgsteal / pgscan` is the reclaim efficiency. A ratio below ~50% means
    reclaim is scanning many pages it cannot free — often due to referenced
    pages, pinned pages, or heavy write pressure. This low efficiency is what
    drives `VMSCAN_THROTTLE_NOPROGRESS`.

---

## Tuning

### `vm.swappiness`

Controls the relative cost the kernel assigns to reclaiming anonymous
(swap-backed) pages versus file-backed pages. The internal variable is
`vm_swappiness` with a default of 60.

- **0** — strongly prefer reclaiming file cache; anonymous pages are only
  swapped when there is no alternative (note: does not disable swap entirely
  since Linux 3.5).
- **60** — default balance; anonymous and file pages are both candidates with
  a slight preference for file.
- **100** — treat anonymous and file pages as equally costly to reclaim.
- **200** — aggressively swap anonymous pages even when file cache is
  reclaimable (introduced in 5.8 for proactive reclaim scenarios).

A lower `swappiness` reduces I/O from swapping at the cost of dropping more
file cache. On systems with abundant swap and slow disks this can increase
`VMSCAN_THROTTLE_WRITEBACK` events if file writes dominate.

```bash
# Read current value
sysctl vm.swappiness

# Set temporarily
sysctl -w vm.swappiness=10

# Persist across reboots
echo "vm.swappiness = 10" >> /etc/sysctl.d/99-memory.conf
```

### `vm.vfs_cache_pressure`

Governs how aggressively the kernel reclaims dentries and inodes (VFS slab
caches) relative to page cache. The internal variable is
`sysctl_vfs_cache_pressure` in `fs/dcache.c`, default 100.

- **< 100** — the kernel reclaims slab caches less aggressively than page
  cache. Metadata-heavy workloads (many small files) benefit from a lower
  value.
- **100** — default; slab and page cache are weighted equally.
- **> 100** — slab caches are reclaimed more aggressively. Reduces dentry/inode
  memory at the cost of more VFS lookup overhead when metadata is evicted.

```bash
sysctl vm.vfs_cache_pressure
sysctl -w vm.vfs_cache_pressure=50
```

### `vm.dirty_ratio` and `vm.dirty_background_ratio`

These control when `balance_dirty_pages()` — the primary write throttle —
activates. They directly affect whether reclaim encounters pages under
writeback and thus how often `VMSCAN_THROTTLE_WRITEBACK` is triggered.

| Sysctl | Internal variable | Default | Meaning |
|--------|------------------|---------|---------|
| `vm.dirty_background_ratio` | `dirty_background_ratio` | 10% | Fraction of dirtyable memory at which `flusher` threads begin background writeback |
| `vm.dirty_ratio` | `vm_dirty_ratio` | 20% | Fraction at which writing processes are throttled in `balance_dirty_pages()` |

- Lowering `dirty_background_ratio` starts background writeback sooner,
  keeping the dirty pool smaller and reducing reclaim stalls on writeback.
- Lowering `dirty_ratio` throttles writers sooner, at the cost of higher
  write latency for the application.
- On systems with large RAM (hundreds of GB), percentage-based ratios can
  allow enormous dirty pools. Consider using `vm.dirty_bytes` and
  `vm.dirty_background_bytes` for absolute limits instead.

```bash
# Keep dirty data bounded on a 256 GB system
sysctl -w vm.dirty_background_bytes=1073741824   # 1 GB
sysctl -w vm.dirty_bytes=4294967296              # 4 GB
```

---

## Putting It Together: A Pressure Escalation Sequence

```
1. Allocation demand rises; kswapd wakes and runs balance_pgdat().
   └── pgscan_kswapd increases; system healthy.

2. kswapd falls behind; free pages drop below min watermark.
   └── __alloc_pages_slowpath() → __alloc_pages_direct_reclaim()
   └── try_to_free_pages() entered; allocstall_* increments.

3. Direct reclaim finds pages under writeback.
   └── sc->nr.immediate > 0
   └── reclaim_throttle(VMSCAN_THROTTLE_WRITEBACK) — 100 ms sleep.
   └── PSI memory stall accounting begins.

4. Reclaim makes no progress at priority 1.
   └── consider_reclaim_throttle() → VMSCAN_THROTTLE_NOPROGRESS.

5. pfmemalloc reserves depleted.
   └── throttle_direct_reclaim() → pfmemalloc_wait sleep.
   └── pgscan_direct_throttle increments.
   └── kswapd woken (allow_direct_reclaim → wake_up kswapd_wait).

6. kswapd recovers the node; pgdat_balanced() becomes true.
   └── wake_up_all(&pgdat->pfmemalloc_wait).
   └── clear_pgdat_congested().
   └── Direct reclaimers wake and retry allocations.
```

At step 3 and beyond, PSI `memory.full` pressure rises. Monitoring this
sequence via `/proc/vmstat` counter deltas and PSI gives an accurate picture
of which throttle stage the system has reached and how long it spends there.

## Further reading

- [mm/vmscan.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmscan.c) — `reclaim_throttle()`, `throttle_direct_reclaim()`, `consider_reclaim_throttle()`, `balance_pgdat()`, `allow_direct_reclaim()`, and `pgdat_balanced()` — the complete throttling and kswapd balancing implementation
- [mm/memcontrol.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c) — `__mem_cgroup_handle_over_high()`, `reclaim_high()`, `calculate_high_delay()`, `mem_find_max_overage()`, and `swap_find_max_overage()` — the `memory.high` proportional penalty path
- `Documentation/admin-guide/cgroup-v2.rst` — `memory.high` semantics, throttling behaviour when the soft limit is exceeded, and the relationship to `memory.max`
- [LWN: Throttling memory-hungry cgroups](https://lwn.net/Articles/758781/) — the original design discussion for the proportional `memory.high` delay, explaining the quadratic penalty formula and why a simple hard stop was rejected
- [reclaim](reclaim.md) — the broader reclaim picture: kswapd, direct reclaim, watermarks, LRU lists, and swappiness
- [memcg](memcg.md) — `memory.high` and `memory.max` from the operator perspective: how to set limits and interpret `memory.events`
