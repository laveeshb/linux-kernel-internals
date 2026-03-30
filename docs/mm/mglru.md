# MGLRU: Multi-Generation LRU

> A generational page reclaim algorithm for better working set detection

## The problem with classic LRU

The classic LRU (Least Recently Used) page reclaim uses two lists per memory zone: **active** and **inactive**. Pages migrate between them based on access. The fundamental problems:

1. **The scan cost**: To find reclaimable pages, the reclaimer walks the inactive list. If the inactive list is full of hot pages (false negatives), it wastes CPU time.
2. **One-time access pollution**: A large `dd` or `tar` operation reads every file once, thrashing the active list with cold pages.
3. **No temporal locality**: Classic LRU treats a page accessed 1 second ago the same as one accessed 1 year ago.

## MGLRU's generational model

MGLRU (Multi-Generation LRU, merged in 6.1) divides pages into **generations**. Each generation represents pages that became hot at roughly the same time. The oldest generation is evicted first:

```
Generation 0 (oldest): pages not accessed since earliest timestamp
Generation 1:          pages accessed in the second-oldest period
...
Generation N (newest): recently accessed pages

Reclaim: evict from generation 0 first → if empty, evict generation 1 → ...
Age: promote pages to the newest generation when accessed
```

Typical number of generations: 4. Each generation is ~seconds to minutes of activity.

## Key data structures

```c
/* mm/vmscan.c (6.1+) */

/* Per-node, per-type (anon/file) LRU state */
struct lru_gen_folio {
    /* Min/max generation counters */
    unsigned long max_seq;          /* newest generation */
    unsigned long min_seq[ANON_AND_FILE]; /* oldest non-empty generation */

    /* Per-generation page counts */
    long          nr_pages[MAX_NR_GENS][ANON_AND_FILE][MAX_NR_ZONES];

    /* Bloom filter for faster refault detection */
    unsigned long *filters[NR_BLOOM_FILTERS];
    atomic_long_t  nr_evicted[ANON_AND_FILE];
    atomic_long_t  nr_refaulted[ANON_AND_FILE];
    atomic_long_t  protected[NR_HIST_GENS][ANON_AND_FILE][NR_BIRTH_MARKS];
};

/* Per-folio generation tracking embedded in folio flags */
/* gen = folio_lru_gen(folio): which generation this folio is in */
```

## Aging: scanning for hot pages

**Aging** walks page tables to find recently accessed pages and promote them to the newest generation:

```c
/* mm/vmscan.c */
static bool walk_mm(struct lruvec *lruvec, struct mm_struct *mm,
                     struct lru_gen_walk_control *lwc)
{
    struct lru_gen_mm_walk walk = {
        .lruvec = lruvec,
        .seq    = min_seq(lruvec, ANON_AND_FILE),
        /* ... */
    };

    /* Walk all VMAs, checking PTE accessed bits */
    walk_page_range(mm, 0, ULONG_MAX, &lru_gen_mm_walk_ops, &walk);
    return walk.force_scan;
}
```

The accessed bit in PTEs tells the kernel which pages have been touched since the last aging pass. Pages with the accessed bit set are promoted to the newest generation; those without are left in their old generation (and will be evicted sooner).

## Eviction: reclaiming old generations

**Eviction** reclaims pages from the oldest generation:

```c
/* mm/vmscan.c */
static long evict_folios(struct lruvec *lruvec, struct scan_control *sc,
                          swp_entry_t *swpent)
{
    int type = get_type_to_scan(lruvec, sc, &tier);
    long nr_to_scan = get_nr_to_scan(lruvec, sc, can_age, type);
    long nr_reclaimed = 0;

    /* Get the oldest generation */
    unsigned long min_seq = READ_ONCE(lrugen->min_seq[type]);

    /* Collect folios from the oldest generation */
    isolate_folios(lruvec, sc, type, min_seq, &list);

    /* Try to reclaim them (writeback, swap, or just free) */
    nr_reclaimed = reclaim_pages(&list);

    /* If min generation is now empty, advance min_seq */
    if (!nr_pages_in_gen(lruvec, type, min_seq))
        WRITE_ONCE(lrugen->min_seq[type], min_seq + 1);

    return nr_reclaimed;
}
```

## Working set protection: refault detection

MGLRU detects when evicted pages are immediately faulted back in (**refaults**), indicating the working set was violated. It uses a Bloom filter:

1. When a page is evicted, its fingerprint is added to the Bloom filter
2. When a page is faulted in, MGLRU checks if it was recently evicted
3. If yes: the page is placed in a **protected generation** — older than the newest but protected from immediate eviction

```c
/* Refault detection */
static bool lru_gen_test_recent(struct lruvec *lruvec, bool file,
                                 struct folio *folio, ...)
{
    struct lru_gen_folio *lrugen = &lruvec->lrugen;
    /* Check Bloom filter: was this folio recently evicted? */
    return test_bloom_filter(lrugen, lrugen->min_seq[file], folio);
}
```

## Comparison: classic LRU vs MGLRU

| Aspect | Classic LRU | MGLRU |
|--------|-------------|-------|
| Data structure | active + inactive lists | 4 generation lists |
| Reclaim target | scan inactive list | evict oldest generation |
| Access tracking | active/inactive promotion | PTE accessed bit scan |
| Working set detection | refault distance approximation | Bloom filter per generation |
| Streaming reads | pollutes active list | one-time accesses stay in old gen |
| Memory overhead | 2 list_head per folio | generation counters + Bloom filter |

## Configuration

```bash
# MGLRU is enabled by default in 6.1+
cat /sys/kernel/mm/lru_gen/enabled
# 0x0007  ← bitmask: 1=enabled, 2=mglru, 4=aging

# Enable/disable components
echo 0 > /sys/kernel/mm/lru_gen/enabled    # disable MGLRU (use classic LRU)
echo 0x0007 > /sys/kernel/mm/lru_gen/enabled  # enable all

# Min LRU generations (default 2)
cat /sys/kernel/mm/lru_gen/min_ttl_ms
# 0  ← no minimum lifetime

# Set minimum time a generation stays before eviction
echo 1000 > /sys/kernel/mm/lru_gen/min_ttl_ms  # protect pages for 1s

# Number of generations: controlled by MAX_NR_GENS (compile-time, usually 4)
```

## Observing MGLRU

```bash
# Generation distribution per node/memcg/zone
cat /sys/kernel/debug/lru_gen

# Output format:
# memcg    N    lruvec    aged anon  0  1  2  3
#                         evicted anon 0 1 2 3
#                         aged file  0  1  2  3
#                         evicted file 0 1 2 3

# Memory pressure stats
cat /proc/vmstat | grep -E "pgpromote|pgdemote|lru_gen"
# pgpromote_success 12345    ← pages promoted to newer generation
# pgdemote_kswapd 67890      ← pages demoted (aged into older generation)

# Refault rate (working set violations)
cat /proc/vmstat | grep pgrefault
# pgrefault 1234

# perf: track LRU events
perf stat -e vmscan:mm_vmscan_lru_isolate -a sleep 5
```

## Further reading

- [Page Reclaim](reclaim.md) — overall reclaim framework
- [Reclaim Throttling](reclaim-throttling.md) — memory pressure signaling
- [Swap](swap.md) — where anon pages go when evicted
- [Page Cache](page-cache.md) — file-backed page lifecycle
- `mm/vmscan.c` in the kernel tree — MGLRU implementation
- `Documentation/admin-guide/mm/multigen_lru.rst` in the kernel tree
