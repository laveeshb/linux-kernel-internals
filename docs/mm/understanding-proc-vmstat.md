# Understanding /proc/vmstat

> The kernel's memory management scoreboard — every counter tells a story

## What Is /proc/vmstat?

`/proc/vmstat` is a pseudo-file that exposes the kernel's internal memory management counters. Every time the kernel allocates a page, reclaims memory, swaps, compacts, or handles a fault, it increments a counter. `/proc/vmstat` lets you read all of them.

```
$ cat /proc/vmstat | head -20
nr_free_pages 234567
nr_zone_inactive_anon 45678
nr_zone_active_anon 123456
nr_zone_inactive_file 89012
nr_zone_active_file 345678
nr_zone_unevictable 1234
nr_mlock 1234
nr_slab_reclaimable 56789
nr_slab_unreclaimable 12345
...
pgfault 987654321
pgmajfault 12345
pgfree 876543210
pgactivate 23456789
pgdeactivate 12345678
pgscan_kswapd 34567890
pgscan_direct 1234567
pgsteal_kswapd 33456780
pgsteal_direct 1134567
```

The file lives in [`mm/vmstat.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmstat.c) and aggregates per-CPU counters across all nodes and zones.

## The Critical Distinction: Gauges vs Counters

This is the single most important thing to understand about `/proc/vmstat`. There are two fundamentally different types of values:

### Gauges (`nr_*`) — Current State

Gauges report the **current** value. They go up and down. Reading them once gives you useful information.

```
nr_free_pages 234567       ← Right now, 234567 pages are free
nr_active_anon 123456      ← Right now, 123456 anonymous pages are active
nr_slab_reclaimable 56789  ← Right now, 56789 slab pages can be reclaimed
```

Think of a gauge like a thermometer: you read it and you know the temperature *right now*.

### Counters (`pg*`, `pswp*`, `thp_*`, etc.) — Monotonic Since Boot

Counters report the **cumulative total** since the system booted. They only go up. A single reading tells you almost nothing — you need **two readings and a time delta** to compute a rate.

```
pgfault 987654321          ← 987 million page faults since boot
pgmajfault 12345           ← 12,345 major faults since boot
pswpout 567890             ← 567,890 pages swapped out since boot
```

Think of a counter like an odometer: knowing you've driven 50,000 miles total is less useful than knowing you drove 100 miles in the last hour.

```
Gauges (nr_*)              Counters (pg*, pswp*, thp_*, etc.)
┌──────────────┐           ┌──────────────┐
│ Current      │           │ Cumulative   │
│ snapshot     │           │ since boot   │
│              │           │              │
│ One read     │           │ Need delta:  │
│ = useful     │           │ (v2-v1)/dt   │
│              │           │ = rate       │
│ Goes up      │           │              │
│ AND down     │           │ Only goes up │
└──────────────┘           └──────────────┘
```

!!! warning "The most common mistake"
    Seeing `pgmajfault 50000` and panicking. That is 50,000 major faults **since boot** — possibly weeks ago. What matters is the *rate*: how many per second right now?

## Key Counters by Scenario

### Memory Pressure

When you suspect the system is under memory pressure, these are the counters to watch:

| Counter | Type | What It Means |
|---------|------|---------------|
| `allocstall_normal` | counter | A process blocked in direct reclaim for Normal zone |
| `allocstall_movable` | counter | A process blocked in direct reclaim for Movable zone |
| `allocstall_dma32` | counter | A process blocked in direct reclaim for DMA32 zone |
| `pgscan_direct` | counter | Pages scanned by direct reclaim (process is stalled) |
| `pgscan_kswapd` | counter | Pages scanned by kswapd (background, healthy) |
| `pgmajfault` | counter | Major page faults (required disk I/O) |
| `nr_free_pages` | gauge | Current free pages |

**What to look for**:

- `allocstall_*` increasing means processes are **blocking** on memory allocation. This is the clearest signal of memory pressure.
- A rising `pgscan_direct` rate means [direct reclaim](reclaim.md) is active — kswapd can't keep up.
- Compare `pgscan_kswapd` vs `pgscan_direct`. In a healthy system, almost all scanning is done by kswapd. If direct reclaim dominates, you have a problem.

### Swap Activity

| Counter | Type | What It Means |
|---------|------|---------------|
| `pswpin` | counter | Pages swapped in from disk |
| `pswpout` | counter | Pages swapped out to disk |
| `nr_zone_inactive_anon` | gauge | Anonymous pages on inactive LRU (swap candidates) |

**What to look for**:

- A sustained `pswpout` rate means the system is actively [swapping out](swapping.md) pages. Some swap-out is normal under pressure.
- A sustained `pswpin` rate means the system is swapping pages **back in** — the pages it evicted are being used again. This is the painful case: it means the working set doesn't fit in RAM.
- High `pswpin` + high `pswpout` simultaneously = **swap thrashing**. The system is moving the same pages back and forth.

### Reclaim Efficiency

| Counter | Type | What It Means |
|---------|------|---------------|
| `pgsteal_kswapd` | counter | Pages successfully reclaimed by kswapd |
| `pgsteal_direct` | counter | Pages successfully reclaimed by direct reclaim |
| `pgscan_kswapd` | counter | Pages scanned by kswapd |
| `pgscan_direct` | counter | Pages scanned by direct reclaim |

**Reclaim efficiency** = `pgsteal / pgscan`

This ratio tells you how productive reclaim is. If the kernel scans 1000 pages to reclaim 100, the efficiency is 10% — most pages are in use and can't be freed. That's bad.

```
Efficiency = pgsteal_kswapd / pgscan_kswapd

  > 50%   Good — most scanned pages are reclaimable
  10-50%  Warning — many pages are in active use
  < 10%   Bad — the system is desperately scanning
```

!!! note "Why low efficiency matters"
    Low reclaim efficiency means the kernel is doing a lot of work (scanning LRU lists, checking page flags, taking locks) for little gain. This wastes CPU and increases allocation latency.

### THP (Transparent Huge Pages) Health

| Counter | Type | What It Means |
|---------|------|---------------|
| `thp_fault_alloc` | counter | Successful THP allocations on page fault |
| `thp_fault_fallback` | counter | THP allocation failed, fell back to 4KB pages |
| `thp_collapse_alloc` | counter | Successful THP collapses (khugepaged) |
| `thp_collapse_alloc_failed` | counter | Failed THP collapses |
| `thp_split_page` | counter | THPs that had to be split back to 4KB |

**What to look for**:

- The ratio `thp_fault_fallback / (thp_fault_alloc + thp_fault_fallback)` is the [THP](thp.md) failure rate. High failure rate means the system can't find contiguous 2MB chunks.
- Rising `thp_split_page` means THPs are being broken up — possibly due to partial munmap or memory pressure.
- If `thp_collapse_alloc_failed` is rising, khugepaged is trying to promote 4KB pages to THPs but failing.

### Compaction Health

| Counter | Type | What It Means |
|---------|------|---------------|
| `compact_stall` | counter | A process blocked waiting for compaction |
| `compact_fail` | counter | Compaction was attempted but failed |
| `compact_success` | counter | Compaction succeeded |
| `compact_migrate_scanned` | counter | Pages scanned for migration during compaction |
| `compact_free_scanned` | counter | Free pages scanned during compaction |

**What to look for**:

- `compact_stall` increasing means processes are **blocking** on [compaction](compaction.md). This adds latency to allocations.
- The failure rate `compact_fail / (compact_fail + compact_success)` tells you how often compaction works. High failure rate means memory is too fragmented.
- A high `compact_migrate_scanned` rate with high `compact_fail` means the kernel is doing expensive work (scanning, migrating pages) without producing contiguous blocks.

## Computing Rates from Counter Deltas

Since counters are monotonic, you need two samples and a time interval to compute a rate:

```
rate = (value_t2 - value_t1) / (t2 - t1)
```

### Manual two-sample method

```bash
# Sample 1
T1=$(date +%s)
V1=$(awk '/^pgmajfault / {print $2}' /proc/vmstat)

sleep 10

# Sample 2
T2=$(date +%s)
V2=$(awk '/^pgmajfault / {print $2}' /proc/vmstat)

# Rate
echo "Major faults/sec: $(( (V2 - V1) / (T2 - T1) ))"
```

### Watch multiple counters over time

```bash
# Print key counters every 5 seconds with deltas
while true; do
    awk '
    /^(pgscan_direct|pgsteal_direct|allocstall|pgmajfault|pswpin|pswpout) / {
        print $1, $2
    }' /proc/vmstat
    echo "---"
    sleep 5
done
```

A cleaner approach that computes actual deltas:

```bash
#!/bin/bash
# vmstat-delta.sh — show per-second rates for key counters
INTERVAL=${1:-5}
COUNTERS="pgscan_direct pgsteal_direct pgscan_kswapd pgsteal_kswapd allocstall_normal pgmajfault pswpin pswpout"

declare -A prev
first=1

while true; do
    while read name value; do
        for c in $COUNTERS; do
            if [[ "$name" == "$c" ]]; then
                if [[ $first -eq 0 ]]; then
                    delta=$(( value - prev[$name] ))
                    rate=$(( delta / INTERVAL ))
                    printf "%-25s %8d/s\n" "$name" "$rate"
                fi
                prev[$name]=$value
            fi
        done
    done < /proc/vmstat

    first=0
    [[ $first -eq 0 ]] && echo "---"
    sleep "$INTERVAL"
done
```

## Integration with Common Tools

### vmstat command

The `vmstat` command (from procps-ng) already reads `/proc/vmstat` internally, but it shows a simplified, aggregated view:

```bash
$ vmstat 1
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 1  0  12340 234567  89012 456789    0    0    12    34  567  890  5  2 92  1  0
```

| vmstat column | /proc/vmstat source |
|---------------|---------------------|
| `si` (swap in) | `pswpin` delta |
| `so` (swap out) | `pswpout` delta |
| `free` | `nr_free_pages` * page size |

`vmstat` is good for a quick overview. `/proc/vmstat` gives you the full picture — including counters like `allocstall_*`, `pgscan_direct`, and THP stats that `vmstat` doesn't expose.

### sar (sysstat)

`sar` collects and reports `/proc/vmstat` data over time:

```bash
# Page faults and major faults per second
sar -B 1

# Swap activity per second
sar -W 1

# Historical data (from collected logs)
sar -B -f /var/log/sa/sa28
```

| sar -B field | /proc/vmstat source |
|--------------|---------------------|
| `pgscank/s` | `pgscan_kswapd` delta |
| `pgscand/s` | `pgscan_direct` delta |
| `pgsteal/s` | `pgsteal_kswapd` + `pgsteal_direct` delta |
| `fault/s` | `pgfault` delta |
| `majflt/s` | `pgmajfault` delta |

!!! tip "sar for historical analysis"
    If you have `sysstat` installed and the `sa1`/`sa2` collectors running, `sar` lets you look back at past memory pressure events. This is invaluable for post-incident analysis.

### Monitoring systems (Prometheus, Grafana, etc.)

Node Exporter (Prometheus) exposes `/proc/vmstat` counters directly under the `node_vmstat_*` metric family:

```
node_vmstat_pgscan_direct
node_vmstat_pgsteal_direct
node_vmstat_pgmajfault
node_vmstat_pswpin
node_vmstat_pswpout
node_vmstat_allocstall_normal
node_vmstat_thp_fault_alloc
node_vmstat_thp_fault_fallback
```

Since these are exposed as Prometheus counters, you use `rate()` or `irate()` to compute per-second rates:

```promql
# Direct reclaim scan rate (pages/sec)
rate(node_vmstat_pgscan_direct[5m])

# Reclaim efficiency
rate(node_vmstat_pgsteal_kswapd[5m]) / rate(node_vmstat_pgscan_kswapd[5m])

# THP failure rate
rate(node_vmstat_thp_fault_fallback[5m])
/ (rate(node_vmstat_thp_fault_alloc[5m]) + rate(node_vmstat_thp_fault_fallback[5m]))

# Alert: sustained direct reclaim
rate(node_vmstat_pgscan_direct[5m]) > 1000
```

## Practical One-Liners

### Is the system under memory pressure right now?

```bash
# Check if direct reclaim or allocation stalls are happening
# Run twice with a gap, look for increasing values
grep -E '^(allocstall|pgscan_direct)' /proc/vmstat
```

If `allocstall_*` values are increasing between reads, processes are stalling on memory.

### Is the system swap-thrashing?

```bash
# Watch swap in/out rates (pages/sec)
watch -n1 "grep -E '^(pswpin|pswpout)' /proc/vmstat"
```

Both increasing together means pages are being evicted and faulted back repeatedly.

### How efficient is page reclaim?

```bash
# Reclaim efficiency snapshot
awk '
/^pgsteal_kswapd/  { steal += $2 }
/^pgsteal_direct/  { steal += $2 }
/^pgscan_kswapd/   { scan += $2 }
/^pgscan_direct/   { scan += $2 }
END {
    if (scan > 0) printf "Reclaim efficiency: %.1f%% (%d stolen / %d scanned)\n",
        100*steal/scan, steal, scan
    else print "No reclaim activity recorded"
}' /proc/vmstat
```

### Are THPs working or falling back?

```bash
awk '
/^thp_fault_alloc /    { alloc = $2 }
/^thp_fault_fallback / { fallback = $2 }
END {
    total = alloc + fallback
    if (total > 0) printf "THP success rate: %.1f%% (%d alloc, %d fallback)\n",
        100*alloc/total, alloc, fallback
    else print "No THP fault activity recorded"
}' /proc/vmstat
```

### Quick memory pressure dashboard

```bash
# One-shot summary of key indicators
awk '
/^nr_free_pages /          { printf "Free pages:          %d (%.0f MB)\n", $2, $2*4/1024 }
/^nr_zone_inactive_anon /  { printf "Inactive anon:       %d (%.0f MB)\n", $2, $2*4/1024 }
/^pgscan_direct /          { printf "Direct reclaim scans: %d (since boot)\n", $2 }
/^pgscan_kswapd /          { printf "kswapd scans:        %d (since boot)\n", $2 }
/^allocstall_normal /      { printf "Alloc stalls:        %d (since boot)\n", $2 }
/^pgmajfault /             { printf "Major faults:        %d (since boot)\n", $2 }
/^pswpin /                 { printf "Swap in:             %d pages (since boot)\n", $2 }
/^pswpout /                { printf "Swap out:            %d pages (since boot)\n", $2 }
/^compact_stall /          { printf "Compaction stalls:   %d (since boot)\n", $2 }
' /proc/vmstat
```

## Further Reading

- [Page Reclaim](reclaim.md) — how the kernel decides which pages to free
- [What happens during swapping](swapping.md) — the swap-out and swap-in paths
- [Transparent Huge Pages](thp.md) — 2MB page allocation and management
- [Compaction](compaction.md) — how the kernel defragments memory
- [Running out of memory](oom.md) — what happens when reclaim fails
- [`mm/vmstat.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmstat.c) — kernel source for /proc/vmstat
