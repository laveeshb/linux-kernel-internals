# Page Reclaim

> What happens when memory runs low

## What Is Page Reclaim?

When the system runs low on free memory, the kernel must reclaim pages from existing users. Page reclaim finds pages that can be freed or written to swap, making room for new allocations.

```
Memory Pressure
      │
      v
┌─────────────────┐
│  Page Reclaim   │
├─────────────────┤
│ - File pages    │──> Write dirty pages, drop clean
│ - Anonymous     │──> Swap out
│ - Slab caches   │──> Shrink caches
└─────────────────┘
      │
      v
Free Pages Available
```

## Two Paths to Reclaim

### 1. Background Reclaim (kswapd)

`kswapd` is a per-node kernel thread that reclaims pages in the background when memory falls below the `low` watermark.

```
Free pages fall below low watermark
           │
           v
    Wake kswapd
           │
           v
    Reclaim pages until high watermark reached
           │
           v
    kswapd sleeps
```

**Key characteristic**: Processes don't block. kswapd works asynchronously.

### 2. Direct Reclaim

When kswapd can't keep up and free pages fall below the `min` watermark, allocating processes must reclaim pages themselves.

```
Allocation request
        │
        v
    Free pages < min?
        │ yes
        v
    Direct reclaim (process blocks)
        │
        v
    Retry allocation
```

**Key characteristic**: The allocating process blocks until pages are freed.

## Watermarks

Each zone has three watermarks controlling reclaim behavior:

```
             ┌──────────────────┐
  high ─────>│                  │  Zone healthy, no action
             ├──────────────────┤
  low  ─────>│  Wake kswapd     │  Background reclaim starts
             ├──────────────────┤
  min  ─────>│  Direct reclaim  │  Allocating process helps
             ├──────────────────┤
             │  OOM territory   │  Kill processes
             └──────────────────┘
```

Watermarks are derived from `vm.min_free_kbytes`:

```bash
# View watermarks
cat /proc/zoneinfo | grep -E "min|low|high"

# Adjust base value (affects all watermarks)
sysctl vm.min_free_kbytes=65536
```

## LRU Lists

The kernel tracks page usage with LRU (Least Recently Used) lists. Pages move between lists based on access patterns.

### Classic LRU (Two-List)

```
              Active                    Inactive
         ┌─────────────┐           ┌─────────────┐
  Hot    │   Recent    │           │   Recent    │
 pages   │   access    │ ────────> │   access    │ ──> Reclaim
         │             │  demote   │             │
         └─────────────┘           └─────────────┘
               ^                          │
               │        promote           │
               └──────────────────────────┘
```

Four lists per node (two types x two states):
- `LRU_INACTIVE_ANON` - Inactive anonymous pages
- `LRU_ACTIVE_ANON` - Active anonymous pages
- `LRU_INACTIVE_FILE` - Inactive file-backed pages
- `LRU_ACTIVE_FILE` - Active file-backed pages

### Multi-Gen LRU (MGLRU)

Introduced in v6.1, MGLRU replaces the two-list model with multiple generations for better aging accuracy.

```
Generation 0 (oldest) ──> Generation 1 ──> ... ──> Generation N (youngest)
      │
      v
   Reclaim
```

**Benefits**:
- Better detection of hot vs cold pages
- Reduced CPU overhead from page table scanning
- Improved performance under memory pressure

```bash
# Check if MGLRU is enabled (hex bitmask)
cat /sys/kernel/mm/lru_gen/enabled
# 0x0007 = fully enabled (0x0001 | 0x0002 | 0x0004)

# Enable all MGLRU features (if built with CONFIG_LRU_GEN)
echo 0x0007 > /sys/kernel/mm/lru_gen/enabled
# Bits: 0x0001=base, 0x0002=clear accessed in leaf PTEs, 0x0004=non-leaf PTEs
```

## What Gets Reclaimed

### File Pages (Page Cache)

Pages backed by files on disk:

| State | Action |
|-------|--------|
| Clean | Drop immediately (can re-read from disk) |
| Dirty | Write to disk first, then drop |

### Anonymous Pages

Pages with no file backing (heap, stack):

| Swap Available | Action |
|----------------|--------|
| Yes | Write to swap, then free |
| No | Cannot reclaim without killing owner (OOM killer) |

### Slab Caches

Kernel object caches can shrink via **shrinkers**:

```c
/* Shrinkers registered by subsystems */
register_shrinker(&my_shrinker);

/* Called during reclaim */
struct shrinker {
    unsigned long (*count_objects)(struct shrinker *, ...);
    unsigned long (*scan_objects)(struct shrinker *, ...);
};
```

Examples: dentry cache, inode cache, vfs caches.

```bash
# View shrinker stats
cat /sys/kernel/debug/shrinker/*
```

## Swappiness

`vm.swappiness` controls the balance between reclaiming file pages vs anonymous pages:

| Value | Behavior |
|-------|----------|
| 0 | Avoid swapping, prefer file cache reclaim |
| 60 | Default balance |
| 100 | Aggressively swap anonymous pages |

```bash
# View current value
cat /proc/sys/vm/swappiness

# Adjust (persistent in /etc/sysctl.conf)
sysctl vm.swappiness=10
```

## OOM Killer

When reclaim fails and memory is exhausted, the OOM (Out of Memory) killer terminates processes to free memory.

### OOM Score

Each process has an OOM score (0-1000). Higher = more likely to be killed.

```bash
# View OOM score
cat /proc/<pid>/oom_score

# Adjust OOM priority (-1000 to 1000)
echo -500 > /proc/<pid>/oom_score_adj  # Less likely to be killed
echo 1000 > /proc/<pid>/oom_score_adj  # Kill this first
```

### OOM Selection Criteria

The kernel considers:
1. Memory usage (primary factor)
2. `oom_score_adj` adjustments
3. Whether killing frees memory (children, shared pages)
4. Root processes get slight protection

```bash
# Watch OOM events
dmesg | grep -i "out of memory"

# Or via tracing
echo 1 > /sys/kernel/debug/tracing/events/oom/oom_score_adj_update/enable
```

## Reclaim Behavior Tunables

| Sysctl | Description |
|--------|-------------|
| `vm.min_free_kbytes` | Base for watermark calculation |
| `vm.swappiness` | Anon vs file reclaim balance |
| `vm.vfs_cache_pressure` | Pressure on dentry/inode caches |
| `vm.dirty_ratio` | Max dirty pages before blocking writes |
| `vm.dirty_background_ratio` | When background writeback starts |

## History

### Origins

Page reclaim has existed since early Linux. The basic kswapd mechanism predates git history.

### rmap (Reverse Mapping, v2.5)

**Problem**: To reclaim a page, kernel needed to find all PTEs pointing to it. Required scanning all page tables.

**Solution**: Reverse mapping - each page tracks which PTEs map it.

### Split LRU (v2.6.28, 2008)

**Commit**: [4f98a2fee8ac](https://git.kernel.org/linus/4f98a2fee8ac) ("vmscan: split LRU lists into anon & file sets")

**Author**: Rik van Riel

*Note: Pre-2009 LKML archives on lore.kernel.org are sparse. The commit message documents the rationale.*

Split single LRU into separate anonymous and file lists for better reclaim decisions.

### MGLRU (v6.1, 2022)

**Commit**: [ac35a4902374](https://git.kernel.org/linus/ac35a4902374) ("mm: multi-gen LRU: minimal implementation") | [LKML](https://lore.kernel.org/linux-mm/20220815071332.627393-1-yuzhao@google.com/)

**Author**: Yu Zhao

Multi-generational LRU for improved page aging and reduced overhead.

## Try It Yourself

### Monitor Reclaim Activity

```bash
# Real-time reclaim stats
watch -n 1 'cat /proc/vmstat | grep -E "pgscan|pgsteal|kswapd"'

# Key metrics:
# pgscan_kswapd  - Pages scanned by kswapd
# pgscan_direct  - Pages scanned by direct reclaim
# pgsteal_*      - Pages successfully reclaimed
```

### Trigger Memory Pressure

```bash
# Consume memory to trigger reclaim
stress --vm 1 --vm-bytes 2G --vm-keep

# Watch kswapd wake up
watch -n 1 'ps aux | grep kswapd'
```

### Trace Reclaim Events

```bash
# Enable reclaim tracing
echo 1 > /sys/kernel/debug/tracing/events/vmscan/mm_vmscan_direct_reclaim_begin/enable
echo 1 > /sys/kernel/debug/tracing/events/vmscan/mm_vmscan_direct_reclaim_end/enable

# Watch events
cat /sys/kernel/debug/tracing/trace_pipe
```

### Check Zone Pressure

```bash
# Detailed zone info including watermarks
cat /proc/zoneinfo

# Quick check
cat /proc/buddyinfo
```

## Common Issues

### Direct Reclaim Stalls

Processes blocked in direct reclaim, causing latency spikes.

**Debug**: Check `allocstall_*` in `/proc/vmstat`

**Solutions**:
- Increase `vm.min_free_kbytes`
- Add swap if missing
- Reduce memory pressure

### kswapd CPU Usage

kswapd consuming excessive CPU.

**Debug**: `top` or `perf top`

**Causes**:
- Too little free memory
- Workload constantly dirtying pages
- Swap thrashing

### OOM Kills Despite Free Memory

Free memory exists but in wrong zone or fragmented.

**Debug**: Check `/proc/buddyinfo` and `/proc/zoneinfo`

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/vmscan.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmscan.c) | Core reclaim logic |
| [`mm/oom_kill.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/oom_kill.c) | OOM killer |
| [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) | Watermark checks |

### Kernel Documentation

- [`Documentation/admin-guide/mm/multigen_lru.rst`](https://docs.kernel.org/admin-guide/mm/multigen_lru.html)
- [`Documentation/mm/balance.rst`](https://docs.kernel.org/mm/balance.html)

### Mailing List Discussions

- [Multi-Gen LRU Framework v14](https://lore.kernel.org/linux-mm/20220815071332.627393-1-yuzhao@google.com/) - Yu Zhao's August 2022 patch series
- [MGLRU design doc](https://lore.kernel.org/all/20220815071332.627393-15-yuzhao@google.com/) - Detailed design explaining generations, page table walks, and the PID controller

### Related

- [page-allocator](page-allocator.md) - Watermarks, zones
- [glossary](glossary.md) - LRU, OOM, swap definitions
- [memcg](memcg.md) - Per-cgroup memory limits and reclaim
