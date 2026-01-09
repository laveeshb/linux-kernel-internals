# Memory Compaction

> Defragmenting physical memory for large allocations

## What Is Compaction?

Memory compaction moves pages to create contiguous free regions. Over time, free memory becomes fragmented - scattered in small pieces throughout physical memory. Compaction consolidates these fragments.

```
Before Compaction:
┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
│ U │ F │ U │ F │ U │ U │ F │ U │ F │ F │ U │ F │ U │ F │ U │ F │
└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
  U = Used, F = Free (scattered)

After Compaction:
┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
│ U │ U │ U │ U │ U │ U │ U │ U │ U │ F │ F │ F │ F │ F │ F │ F │
└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
  Contiguous free region created
```

## Why Compaction?

### The Fragmentation Problem

The buddy allocator needs physically contiguous pages for high-order allocations:

| Order | Size | Use Cases |
|-------|------|-----------|
| 0 | 4KB | Regular pages |
| 1 | 8KB | Some kernel allocations |
| 2 | 16KB | Jumbo frames |
| 3+ | 32KB+ | Huge pages, DMA buffers |

After running for days/weeks, a system may have plenty of free memory but no contiguous regions for high-order allocations.

### Before Compaction

Prior to compaction, high-order allocation failures were common:
- THP couldn't allocate 2MB pages
- DMA buffers failed
- Network jumbo frames unavailable

The only solutions were rebooting or reserving memory at boot.

## How Compaction Works

### The Algorithm

Compaction uses two scanners moving toward each other:

```
Zone start                                              Zone end
    │                                                       │
    ▼                                                       ▼
┌───────────────────────────────────────────────────────────────┐
│                           Zone                                 │
└───────────────────────────────────────────────────────────────┘
    │                                                       │
    ▼ Migration scanner                   Free scanner ▼    │
    │ (finds movable pages)         (finds free pages)      │
    │                                                       │
    └──────────────► ◄──────────────────────────────────────┘
                     Meet in middle
```

1. **Free scanner**: Starts at zone end, moves backward, finds free pages
2. **Migration scanner**: Starts at zone start, moves forward, finds movable pages
3. **Migration**: Move pages from migration scanner to free scanner locations
4. **Result**: Free space consolidated at one end

### Page Mobility

Not all pages can be moved:

| Migrate Type | Movable? | Examples |
|--------------|----------|----------|
| `MIGRATE_MOVABLE` | Yes | User pages, page cache |
| `MIGRATE_RECLAIMABLE` | Sometimes | Caches (can be freed instead) |
| `MIGRATE_UNMOVABLE` | No | Kernel allocations, DMA |

Compaction only works with movable pages. Unmovable pages create permanent fragmentation.

## Compaction Triggers

### 1. Direct Compaction (Synchronous)

When a high-order allocation fails, the allocating process runs compaction:

```
alloc_pages(order=9)  /* 2MB for THP */
        │
        v
    Allocation fails
        │
        v
    Direct compaction (process blocks)
        │
        v
    Retry allocation
```

### 2. kcompactd (Asynchronous)

Background kernel thread that compacts proactively:

```bash
# One kcompactd per NUMA node
ps aux | grep kcompactd
# kcompactd0, kcompactd1, ...
```

Woken when:
- Watermarks indicate fragmentation
- High-order allocations are failing
- Explicitly triggered

### 3. Manual Trigger

```bash
# Trigger compaction on all nodes
echo 1 > /proc/sys/vm/compact_memory

# Per-node trigger
echo 1 > /sys/devices/system/node/node0/compact
```

## Configuration

### Proactive Compaction (v5.9+)

Compacts in the background before allocations need it:

```bash
# Enable proactive compaction (0-100, 0=disabled)
cat /proc/sys/vm/compaction_proactiveness
echo 20 > /proc/sys/vm/compaction_proactiveness

# Higher = more aggressive background compaction
# Lower = less CPU usage, more direct compaction
```

### Compaction Behavior

```bash
# Fragmentation index threshold for compaction
# Compaction triggers when fragmentation_index > extfrag_threshold
# Index 0 = failure due to lack of memory, 1000 = due to fragmentation
cat /proc/sys/vm/extfrag_threshold
# 500 (default) - lower = more aggressive (compact at lower fragmentation)

# View fragmentation index per order
cat /sys/kernel/debug/extfrag/extfrag_index
```

## Monitoring

### Compaction Statistics

```bash
cat /proc/vmstat | grep compact
# compact_migrate_scanned  - Pages scanned for migration
# compact_free_scanned     - Pages scanned for free space
# compact_isolated         - Pages isolated for migration
# compact_stall            - Direct compaction stalls
# compact_fail             - Compaction failures
# compact_success          - Successful compactions
```

### Fragmentation Index

```bash
# Per-order fragmentation (0.0 = no fragmentation, 1.0 = severe)
cat /sys/kernel/debug/extfrag/extfrag_index

# Example:
# Node 0, zone   Normal
#     order   0   1   2   3   4   5   6   7   8   9  10
#     index 0.0 0.0 0.0 0.0 0.1 0.2 0.4 0.6 0.8 0.9 1.0
```

### Tracing

```bash
# Trace compaction events
echo 1 > /sys/kernel/debug/tracing/events/compaction/mm_compaction_begin/enable
echo 1 > /sys/kernel/debug/tracing/events/compaction/mm_compaction_end/enable
cat /sys/kernel/debug/tracing/trace_pipe
```

## Evolution

### Introduction (v2.6.35, 2010)

**Commit**: [748446bb6b5a](https://git.kernel.org/linus/748446bb6b5a) ("mm: compaction: memory compaction core") | [LKML](https://lore.kernel.org/lkml/1269347146-7461-1-git-send-email-mel@csn.ul.ie/)

**Author**: Mel Gorman

Initial compaction implementation to support THP and reduce high-order allocation failures.

### kcompactd (v4.6, 2016)

**Commit**: [698b1b30642f](https://git.kernel.org/linus/698b1b30642f) ("mm, compaction: introduce kcompactd") | [LKML](https://lore.kernel.org/lkml/1454938691-2197-1-git-send-email-vbabka@suse.cz/)

**Author**: Vlastimil Babka

Background compaction daemon, similar to kswapd for reclaim.

### Proactive Compaction (v5.9, 2020)

**Commit**: [facdaa917c4d](https://git.kernel.org/linus/facdaa917c4d) ("mm: proactive compaction") | [LKML](https://lore.kernel.org/linux-mm/20200428221055.598-1-nigupta@nvidia.com/)

**Author**: Nitin Gupta

Compact proactively based on fragmentation levels, reducing direct compaction stalls.

## Compaction vs Reclaim

Both run under memory pressure, but serve different purposes:

| Aspect | Reclaim | Compaction |
|--------|---------|------------|
| Goal | Free memory | Create contiguous regions |
| When | Low free pages | High-order allocation fails |
| Action | Evict/swap pages | Move pages |
| Daemon | kswapd | kcompactd |

They often work together: reclaim frees pages, compaction arranges them.

## Common Issues

### Direct Compaction Stalls

Processes blocked waiting for compaction.

**Symptoms**: Latency spikes, high `compact_stall` count

**Solutions**:
- Enable proactive compaction
- Tune `compaction_proactiveness`
- Reduce high-order allocations

### Compaction Failures

Can't create contiguous regions.

**Symptoms**: High `compact_fail`, THP allocation failures

**Causes**:
- Too many unmovable pages
- Severe fragmentation

**Solutions**:
- Reduce kernel memory usage
- Increase movable zone size
- Consider memory hotplug for isolation

### High CPU from kcompactd

Background compaction consuming CPU.

**Debug**: `top`, `perf top`

**Solutions**:
- Reduce `compaction_proactiveness`
- Accept more direct compaction instead

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/compaction.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/compaction.c) | Compaction implementation |
| [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) | Compaction triggers |

### Related

- [page-allocator](page-allocator.md) - Buddy system, migrate types
- [thp](thp.md) - Primary consumer of compaction
- [reclaim](reclaim.md) - Works alongside compaction
- [contiguous-memory](contiguous-memory.md) - Why contiguous allocations fail and solutions
