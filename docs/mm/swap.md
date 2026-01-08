# Swap

> Extending memory to disk

## What Is Swap?

Swap allows the kernel to move infrequently used pages from RAM to disk, freeing memory for active use. When those pages are needed again, they're read back from swap.

```
RAM Full, need more memory:
┌─────────────────────────────────────────┐
│ RAM: [Active] [Active] [Inactive] [Active] │
└─────────────────────────────────────────┘
                    │
                    ▼ (swap out)
┌─────────────────────────────────────────┐
│ RAM: [Active] [Active] [FREE] [Active]    │
└─────────────────────────────────────────┘
┌─────────────────────────────────────────┐
│ Swap: [Inactive page]                     │
└─────────────────────────────────────────┘

Later, page accessed:
                    │
                    ▼ (swap in)
┌─────────────────────────────────────────┐
│ RAM: [Active] [Page back] [X] [Active]   │
└─────────────────────────────────────────┘
```

## Swap Types

### Swap Partition

Dedicated disk partition for swap:

```bash
# Create swap partition (during install or with fdisk)
mkswap /dev/sda2
swapon /dev/sda2

# View active swap
swapon --show
# NAME      TYPE      SIZE USED PRIO
# /dev/sda2 partition 8G   1.2G -2
```

### Swap File

Regular file used as swap:

```bash
# Create a 4GB swap file (modern method)
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# Make permanent in /etc/fstab:
# /swapfile none swap sw 0 0
```

**Note for btrfs (COW filesystems):** The `+C` (no-copy-on-write) attribute must be set before the file has data:

```bash
# Method 1: Create empty file, set +C, then allocate
touch /swapfile
chattr +C /swapfile
fallocate -l 4G /swapfile
chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

# Method 2: Set +C on parent directory (new files inherit it)
mkdir /swap && chattr +C /swap
fallocate -l 4G /swap/swapfile
# ... then mkswap, swapon as usual
```

### zswap (Compressed Swap Cache)

Compresses pages before writing to disk, often avoiding disk I/O entirely:

```
Page to swap out
       │
       v
Compress in RAM (zswap pool)
       │
       ├── Fits in pool? ──► Store compressed (no disk I/O)
       │
       └── Pool full? ──► Write to backing swap device
```

```bash
# Enable zswap
echo 1 > /sys/module/zswap/parameters/enabled

# Configure compressor and pool
echo lz4 > /sys/module/zswap/parameters/compressor
echo 20 > /sys/module/zswap/parameters/max_pool_percent

# View statistics
grep -r . /sys/kernel/debug/zswap/ 2>/dev/null
```

### zram (Compressed RAM Disk)

RAM-based block device with compression - swap without disk:

```bash
# Load module
modprobe zram

# Set size (compression makes effective size larger)
echo 4G > /sys/block/zram0/disksize

# Use as swap
mkswap /dev/zram0
swapon /dev/zram0 -p 100  # Higher priority than disk swap
```

## Swap Architecture

### Swap Areas

Linux supports multiple swap areas with priorities:

```bash
# View swap areas
cat /proc/swaps
# Filename        Type        Size      Used    Priority
# /dev/sda2       partition   8388604   1234560 -2
# /dev/zram0      partition   4194300   567890  100
```

Higher priority swap is used first. Equal priorities are striped (round-robin).

### Swap Cache

Recently swapped-in pages stay in swap cache briefly:

```
Swap cache:
┌─────────────────────────────────────────┐
│ Page in RAM + still on swap             │
│ (if process forks, child can share)     │
└─────────────────────────────────────────┘
```

If a swapped-in page is swapped out again without modification, no disk write needed.

### Swap Slots

Swap space is divided into slots (one per page):

```c
/* Each slot tracks one swapped page */
swap_entry_t entry = swp_entry(type, offset);
/* type: which swap area */
/* offset: slot within that area */
```

## Swapping Mechanics

### Swap Out (Page to Disk)

```
Memory pressure
       │
       v
Select victim page (from inactive list)
       │
       v
Allocate swap slot
       │
       v
Write page to swap
       │
       v
Update PTE: present=0, swap_entry=slot
       │
       v
Free page frame
```

### Swap In (Disk to Page)

```
Process accesses swapped page
       │
       v
Page fault (not present)
       │
       v
Read swap entry from PTE
       │
       v
Allocate page frame
       │
       v
Read from swap into page
       │
       v
Update PTE: present=1, page_frame=new
       │
       v
Resume process
```

## Configuration

### Swappiness

Controls preference for swapping anonymous pages vs dropping file cache:

```bash
cat /proc/sys/vm/swappiness
# 60 (default)

# Lower = prefer dropping cache, avoid swapping
echo 10 > /proc/sys/vm/swappiness

# Higher = more willing to swap
echo 80 > /proc/sys/vm/swappiness

# 0 = swap only to avoid OOM (not never)
```

### Swap Priority

```bash
# Set priority when enabling
swapon -p 100 /dev/zram0    # High priority
swapon -p -2 /dev/sda2      # Low priority (default)

# In /etc/fstab:
# /dev/zram0 none swap sw,pri=100 0 0
# /dev/sda2  none swap sw,pri=-2  0 0
```

### Overcommit

```bash
# Memory overcommit policy
cat /proc/sys/vm/overcommit_memory
# 0 = heuristic (default) - allow reasonable overcommit
# 1 = always allow - never fail malloc
# 2 = strict - limit to swap + ratio*RAM

# For mode 2, the ratio:
cat /proc/sys/vm/overcommit_ratio
# 50 (default) = swap + 50% of RAM
```

## Monitoring

### Swap Usage

```bash
# Quick view
free -h
#                total   used   free  shared  buff/cache  available
# Swap:           8.0G   1.2G   6.8G

# Detailed
cat /proc/meminfo | grep -i swap
# SwapCached:    123456 kB  (pages in swap and RAM)
# SwapTotal:    8388604 kB
# SwapFree:     7000000 kB
```

### Swap Activity

```bash
# Pages swapped in/out
cat /proc/vmstat | grep -E "pswpin|pswpout"
# pswpin  - Pages read from swap
# pswpout - Pages written to swap

# Real-time monitoring
vmstat 1
# si = swap in (KB/s)
# so = swap out (KB/s)
```

### Per-Process Swap

```bash
# Swap usage per process
cat /proc/<pid>/status | grep -i swap
# VmSwap:     1234 kB

# System-wide total
awk '/VmSwap/{sum+=$2} END {print sum" kB"}' /proc/*/status 2>/dev/null

# Top swap consumers by process
grep VmSwap /proc/*/status 2>/dev/null | sort -k2 -n | tail
```

### zswap Statistics

```bash
cat /sys/kernel/debug/zswap/pool_total_size     # Compressed size
cat /sys/kernel/debug/zswap/stored_pages        # Pages in zswap
cat /sys/kernel/debug/zswap/written_back_pages  # Evicted to disk
```

## Evolution

### Original Swap (1991)

Basic swap support from the beginning. Single swap area.

### Multiple Swap Areas (v1.3)

Support for multiple swap partitions with priorities.

### Swap Files (v2.6)

Swap files became as efficient as partitions.

### zswap (v3.11, 2013)

**Commit**: [2b2811178e85](https://git.kernel.org/linus/2b2811178e85) ("zswap: add to mm/")

Compressed swap cache to reduce disk I/O.

### zram Swap (v3.14, 2014)

zram became suitable for swap use, enabling diskless swap.

### THP Swap (v4.13, 2017)

**Commit**: [38d8b4e6bdc8](https://git.kernel.org/linus/38d8b4e6bdc8) ("mm, THP, swap: delay splitting THP during swap out")

Transparent Huge Pages can now be swapped without splitting first.

### Swap-over-NFS (Experimental)

Work ongoing to allow swapping to network storage for diskless systems.

## Swap vs No Swap

### Arguments for Swap

| Benefit | Explanation |
|---------|-------------|
| OOM prevention | Swap provides buffer before OOM killer |
| Hibernation | Requires swap for suspend-to-disk |
| Idle page eviction | Unused pages can be moved out |
| Overcommit safety | More headroom for memory spikes |

### Arguments Against Swap

| Concern | Explanation |
|---------|-------------|
| Latency | Swap is slow, can cause hangs |
| SSD wear | Frequent swapping wears flash |
| Thrashing | Heavy swap = system unusable |
| Memory hiding | Masks memory leaks |

### Recommendation

Most systems benefit from some swap:
- **Servers**: RAM + zswap, small disk swap for emergencies
- **Desktops**: RAM/2 to RAM, with zswap
- **Embedded**: Often none (limited storage, predictable workload)

## Common Issues

### Swap Thrashing

Constant swapping makes system unusable.

**Symptoms**: High `si`/`so` in vmstat, system unresponsive

**Solutions**:
- Add RAM
- Reduce workload
- Lower swappiness
- Kill memory-hungry processes

### Swap Full

No swap space available.

**Symptoms**: OOM kills despite "free" memory

**Solutions**:
- Add more swap
- Enable zswap/zram
- Investigate memory usage

### SSD Wear

Excessive swap writes wearing SSD.

**Solutions**:
- Use zswap (reduces writes 2-5x)
- Reduce swappiness
- Add RAM

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/swapfile.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/swapfile.c) | Swap area management |
| [`mm/swap_state.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/swap_state.c) | Swap cache |
| [`mm/zswap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/zswap.c) | Compressed swap cache |
| [`drivers/block/zram/`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/block/zram) | zram implementation |

### Kernel Documentation

- [`Documentation/admin-guide/mm/zswap.rst`](https://docs.kernel.org/admin-guide/mm/zswap.html)

### Related

- [reclaim](reclaim.md) - When swap is triggered
- [page-cache](page-cache.md) - File pages vs anonymous pages
- [mmap](mmap.md) - Anonymous memory that gets swapped
