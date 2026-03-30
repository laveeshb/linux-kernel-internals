# Detecting and preventing swap thrashing

> When the system spends more time swapping than doing useful work

## What is swap thrashing?

Swap thrashing occurs when the system's working set (pages actively in use) exceeds available RAM, forcing the kernel to continuously swap pages in and out. Each page fault triggers disk I/O to bring a page back, but bringing it in evicts another page that will be needed soon. The system becomes unresponsive because it spends most of its time moving pages between RAM and disk instead of running application code.

```
Normal swapping:
  Page out → [idle page] → swap     (page not needed for a while)
  Page in  ← [needed]    ← swap    (occasional, fast)

Thrashing:
  Page A out → swap    (to make room for B)
  Page B out → swap    (to make room for C)
  Page A in  ← swap    (needed again immediately!)
  Page C out → swap    (to make room for A)
  Page B in  ← swap    (needed again immediately!)
  ... cycle continues, system stalls
```

The key distinction: normal [swapping](swapping.md) moves cold pages to disk infrequently. Thrashing moves hot pages back and forth continuously.

## How to detect it

### vmstat: swap in/out rates

```bash
$ vmstat 1
procs -----------memory---------- ---swap-- -----io----
 r  b   swpd   free   buff  cache   si   so    bi    bo
 5 12 4194304  12340   1024  56000  8500  9200  8600  9300
 4 14 4194304  11200   1024  55800  9100  8800  9200  9000
```

- **si** (swap in) and **so** (swap out): sustained high values (thousands of KB/s) indicate thrashing
- **b** column: many blocked processes waiting on I/O
- **r** column: runnable processes piling up

### /proc/vmstat counters

```bash
$ grep -E 'pswpin|pswpout|pgmajfault' /proc/vmstat
pswpin 892451
pswpout 1045823
pgmajfault 934102
```

Watch these over time. Rapidly increasing `pswpin` and `pswpout` together means pages are being swapped in both directions. High `pgmajfault` (major page faults) confirms pages are being faulted from disk.

### PSI: Pressure Stall Information (v4.20+)

```bash
$ cat /proc/pressure/memory
some avg10=45.00 avg60=38.12 avg300=21.45 total=89234567
full avg10=32.00 avg60=25.88 avg300=14.22 total=62345678
```

- **some**: percentage of time at least one task is stalled on memory
- **full**: percentage of time all tasks are stalled on memory

!!! warning
    Rising `full avg10` indicates all tasks are simultaneously stalled on memory — no productive work is happening. Any sustained `full` pressure warrants investigation. The [PSI documentation](psi.md) describes how to use PSI triggers to act on these signals programmatically.

### Per-cgroup memory pressure

```bash
$ cat /sys/fs/cgroup/myapp/memory.pressure
some avg10=78.00 avg60=65.20 avg300=42.10 total=45678901
full avg10=55.00 avg60=41.30 avg300=28.50 total=31234567
```

This isolates pressure to a specific workload, which is how `systemd-oomd` detects thrashing at the cgroup level. See [Memory Cgroups](memcg.md) for more on cgroup memory controls.

## Why it happens

| Cause | What's going on |
|-------|----------------|
| Working set > RAM | The most common cause. Applications need more memory than physically available. |
| `vm.swappiness` too high | Kernel aggressively swaps out anonymous pages even when file cache could be reclaimed instead. See [Page Reclaim](reclaim.md). |
| No swap configured | Paradoxically worse -- without [swap](swap.md), the system cannot gradually degrade. Instead it goes straight to the OOM killer. |
| Memory leak | A process slowly consumes all RAM, pushing everything else into swap. |
| Too many cgroups with soft limits | Multiple cgroups competing for the same memory, each reclaiming from the others. |

## How to fix it

### 1. Add RAM or reduce the working set

The only real fix for a working set that exceeds RAM is to either add memory or run fewer/smaller workloads.

### 2. Tune vm.swappiness

```bash
# Check current value (default is 60)
$ sysctl vm.swappiness
vm.swappiness = 60

# Lower it to prefer reclaiming file cache over swapping anonymous pages
$ sysctl -w vm.swappiness=10
```

Lower values make the kernel prefer dropping file-backed pages (page cache) over swapping anonymous pages. This helps when thrashing is caused by the kernel being too eager to swap. See [Swap](swap.md) for details on how swappiness affects reclaim decisions.

### 3. Use zswap or zram

Compressed swap keeps pages in RAM (compressed) instead of writing to disk, dramatically reducing I/O:

```bash
# Enable zswap (compressed swap cache)
$ echo 1 > /sys/module/zswap/parameters/enabled
$ echo lz4 > /sys/module/zswap/parameters/compressor
$ echo 20 > /sys/module/zswap/parameters/max_pool_percent

# Or use zram (compressed block device as swap)
$ modprobe zram
$ echo lz4 > /sys/block/zram0/comp_algorithm
$ echo 4G > /sys/block/zram0/disksize
$ mkswap /dev/zram0
$ swapon -p 100 /dev/zram0
```

zswap/zram can achieve 2-3x compression, effectively expanding usable memory without disk I/O.

### 4. Set cgroup memory limits

Hard limits prevent a single workload from causing system-wide thrashing:

```bash
# cgroup v2: limit a workload to 4GB
$ echo 4G > /sys/fs/cgroup/myapp/memory.max

# Set a high watermark to trigger early reclaim
$ echo 3G > /sys/fs/cgroup/myapp/memory.high
```

`memory.high` triggers throttling and reclaim before hitting the hard limit, providing back-pressure to the application. See [Memory Cgroups](memcg.md).

## The thrashing livelock problem

Before kernel v4.20, the system had no good mechanism to detect thrashing at scale. The kernel would:

1. Try to reclaim pages
2. Swap out pages that are immediately needed again
3. Swap them back in, evicting other needed pages
4. Repeat indefinitely

The system would stay alive but make no forward progress -- a **livelock**. The OOM killer wouldn't fire because technically memory allocations were succeeding (just very slowly, via swap). Users saw a system that was completely unresponsive but wouldn't recover on its own.

The core problem: the [reclaim](reclaim.md) path had no way to measure whether its work was useful. It could reclaim pages, but couldn't tell that those same pages were being faulted back immediately.

## Modern solutions

### PSI-based OOM (systemd-oomd)

Kernel v4.20 introduced [Pressure Stall Information (PSI)](https://docs.kernel.org/accounting/psi.html), which measures the actual impact of resource contention on running tasks. `systemd-oomd` uses PSI to detect thrashing and kill workloads proactively:

```
PSI memory.pressure > threshold for duration
        │
        v
systemd-oomd identifies the cgroup causing pressure
        │
        v
Kills processes in that cgroup before the system locks up
```

This solves the livelock problem: instead of waiting for allocations to fail (which may never happen during thrashing), the system acts on observed stall time.

```bash
# Check if systemd-oomd is running
$ systemctl status systemd-oomd

# View its configuration
$ cat /etc/systemd/oomd.conf
```

### MGLRU: better page aging (v6.1+)

[Multi-Gen LRU (MGLRU)](https://docs.kernel.org/mm/multigen_lru.html) replaces the traditional active/inactive LRU with multiple generations, providing more accurate page age tracking. This reduces thrashing by making better eviction decisions -- the kernel is less likely to evict a page that will be needed soon.

```bash
# Check if MGLRU is enabled
$ cat /sys/kernel/mm/lru_gen/enabled
```

MGLRU is particularly effective for workloads with large working sets that just barely fit in memory, where the old LRU would thrash but MGLRU correctly identifies the coldest pages.

## Quick diagnostic checklist

```bash
# 1. Is the system thrashing right now?
vmstat 1 5                              # Look at si/so columns

# 2. How bad is memory pressure?
cat /proc/pressure/memory               # full avg10 > 20% = problem

# 3. What's using all the memory?
ps aux --sort=-%mem | head -10          # Top memory consumers
smem -tk                                # Per-process proportional memory

# 4. How much swap is in use?
swapon --show                           # Swap devices and usage
free -h                                 # Swap total/used/free

# 5. Check major faults over time
grep pgmajfault /proc/vmstat            # Run twice, compare values

# 6. Which cgroup is under pressure? (cgroup v2)
find /sys/fs/cgroup -name memory.pressure \
  -exec sh -c 'echo "=== $1 ==="; cat "$1"' _ {} \;
```

## See also

- [Swap](swap.md) -- swap architecture and configuration
- [What happens during swapping](swapping.md) -- the page-level swap in/out lifecycle
- [Page Reclaim](reclaim.md) -- how the kernel decides what to evict
- [Running out of memory](oom.md) -- what happens when reclaim and swap both fail
- [Memory Cgroups](memcg.md) -- isolating and limiting workload memory
