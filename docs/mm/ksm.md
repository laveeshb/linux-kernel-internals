# Kernel Same-page Merging (KSM)

> Deduplicating identical memory pages

## What Is KSM?

KSM scans memory for pages with identical content and merges them into a single copy-on-write (COW) page. When multiple processes have the same data in memory, KSM saves RAM by keeping only one copy.

```
Before KSM:
Process A          Process B          Process C
┌─────────┐       ┌─────────┐        ┌─────────┐
│ Page X  │       │ Page X  │        │ Page X  │
│ (same   │       │ (same   │        │ (same   │
│ content)│       │ content)│        │ content)│
└─────────┘       └─────────┘        └─────────┘
   3 pages = 12KB

After KSM:
Process A          Process B          Process C
    │                  │                  │
    └──────────────────┼──────────────────┘
                       │
                       ▼
                 ┌─────────┐
                 │ Page X  │  (shared, COW)
                 │         │
                 └─────────┘
   1 page = 4KB (saved 8KB)
```

## Why KSM?

### The Virtualization Use Case

KSM was designed for virtual machines. Multiple VMs often run identical operating systems:

| Scenario | VMs | Potential Sharing |
|----------|-----|-------------------|
| 10 identical Linux VMs | 10 | Kernel, libraries, common data |
| Development cluster | 50 | Base OS, toolchains |
| VDI (Virtual Desktop) | 100+ | Windows, Office, browsers |

Without KSM: 10 VMs × 2GB = 20GB RAM
With KSM: Shared pages reduce to ~8GB (varies by workload)

### Beyond VMs

KSM also helps:
- Containers with shared base images
- Multiple instances of the same application
- Fork-heavy workloads

## How KSM Works

### The ksmd Daemon

A kernel thread (`ksmd`) continuously scans memory:

```
ksmd loop:
    │
    ├── Scan pages marked for merging
    │
    ├── Hash page content
    │
    ├── Look for matching hash in stable/unstable trees
    │
    ├── If match: verify byte-by-byte, merge pages
    │
    └── Sleep, repeat
```

### Two-Tree Structure

KSM uses two red-black trees:

**Stable tree**: Contains merged (shared) pages
- Pages already deduplicated
- Searched first for matches

**Unstable tree**: Contains candidate pages
- Pages seen once, waiting for a match
- Rebuilt each scan cycle

```
New page arrives
      │
      v
Search stable tree ──── Match? ──── Yes ──► Merge with stable page
      │                                           │
      No                                          │
      │                                           │
      v                                           │
Search unstable tree ── Match? ──── Yes ──► Merge both, add to stable
      │                                           │
      No                                          │
      │                                           │
      v                                           │
Add to unstable tree                              │
      │                                           │
      └───────────────────────────────────────────┘
```

### Copy-on-Write

Merged pages are marked COW. If any process writes to the page:

1. Page fault occurs
2. Kernel copies page for the writer
3. Writer gets private copy
4. Other processes keep shared page

## Enabling KSM

### For Applications

Applications must explicitly mark memory for KSM scanning:

```c
#include <sys/mman.h>

void *ptr = mmap(NULL, size, PROT_READ|PROT_WRITE,
                 MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);

/* Enable KSM scanning for this region */
madvise(ptr, size, MADV_MERGEABLE);

/* Disable KSM scanning */
madvise(ptr, size, MADV_UNMERGEABLE);
```

### For QEMU/KVM

QEMU enables KSM for guest memory by default (can be disabled with `-machine mem-merge=off`).

### System-Wide Control

```bash
# Enable/disable ksmd
echo 1 > /sys/kernel/mm/ksm/run   # Start scanning
echo 0 > /sys/kernel/mm/ksm/run   # Stop scanning
echo 2 > /sys/kernel/mm/ksm/run   # Stop and unmerge all

# Check if running
cat /sys/kernel/mm/ksm/run
```

## Configuration

### Scan Rate

```bash
# Pages to scan per cycle
cat /sys/kernel/mm/ksm/pages_to_scan
echo 100 > /sys/kernel/mm/ksm/pages_to_scan  # Default: 100

# Sleep between cycles (milliseconds)
cat /sys/kernel/mm/ksm/sleep_millisecs
echo 20 > /sys/kernel/mm/ksm/sleep_millisecs  # Default: 20
```

Higher `pages_to_scan` + lower `sleep_millisecs` = faster merging but more CPU.

### Merge Behavior

```bash
# Merge pages across NUMA nodes? (0=no, 1=yes)
cat /sys/kernel/mm/ksm/merge_across_nodes
# Default: 1 (merges across nodes)
# Set to 0 for NUMA-aware workloads

# Maximum merged pages (0=unlimited)
cat /sys/kernel/mm/ksm/max_page_sharing
# Limits how many processes share one page
```

## Monitoring

### KSM Statistics

```bash
# Pages currently shared (deduplicated)
cat /sys/kernel/mm/ksm/pages_shared

# Total references to shared pages
cat /sys/kernel/mm/ksm/pages_sharing

# Memory saved = (pages_sharing - pages_shared) × 4KB

# Unstable tree size
cat /sys/kernel/mm/ksm/pages_unshared

# Pages that can't be merged (volatile)
cat /sys/kernel/mm/ksm/pages_volatile

# Full scans completed
cat /sys/kernel/mm/ksm/full_scans
```

### Calculating Savings

```bash
#!/bin/bash
shared=$(cat /sys/kernel/mm/ksm/pages_shared)
sharing=$(cat /sys/kernel/mm/ksm/pages_sharing)
saved=$(( (sharing - shared) * 4 ))  # KB saved
echo "KSM saving: ${saved} KB"
```

### Per-Process KSM Usage

```bash
# Pages merged for a process
cat /proc/<pid>/ksm_merging_pages

# Memory saved for this process (bytes, v6.1+)
cat /proc/<pid>/ksm_stat
```

## Evolution

### Introduction (v2.6.32, 2009)

**Commit**: [f8af4da3b4c1](https://git.kernel.org/linus/f8af4da3b4c1) ("ksm: the mm interface to ksm")

**Authors**: Izik Eidus, Andrea Arcangeli, Chris Wright (Red Hat, VMware)

*Note: Pre-2010 LKML archives on lore.kernel.org are sparse. The commit message documents the design.*

Originally developed for KVM to reduce memory footprint of virtual machines.

### NUMA Awareness (v3.9, 2013)

**Commit**: [90bd6fd31c80](https://git.kernel.org/linus/90bd6fd31c80) ("ksm: allow trees per NUMA node") | [LKML](https://lore.kernel.org/all/alpine.LNX.2.00.1302111410290.1174@eggly.anvils/)

**Author**: Petr Holasek (submitted by Hugh Dickins)

Added `merge_across_nodes` option to prevent cross-node sharing that hurts NUMA locality.

### Per-Process Statistics (v6.1, 2022)

**Commit**: [cb4df4cae4f2](https://git.kernel.org/linus/cb4df4cae4f2) ("ksm: count allocated ksm rmap_items for each process") | [LKML](https://lore.kernel.org/linux-mm/20220822053653.204150-1-xu.xin16@zte.com.cn/)

**Author**: xu xin

Added `/proc/<pid>/ksm_stat` for per-process memory savings tracking.

## Trade-offs

### Benefits

| Benefit | Impact |
|---------|--------|
| Memory savings | 10-50% for VM workloads |
| Higher VM density | More VMs per host |
| Overcommit | Safely run more than physical RAM |

### Costs

| Cost | Impact |
|------|--------|
| CPU overhead | ksmd scanning uses CPU cycles |
| COW faults | Write to shared page = page fault + copy |
| Latency | COW adds latency to first write |
| Security | Side-channel attacks possible (timing) |

### Security Considerations

KSM can leak information through timing:
- Attacker allocates page with guessed content
- If merged quickly, content exists elsewhere
- Timing attack reveals memory contents

For security-sensitive environments, consider disabling KSM or using `merge_across_nodes=0` with process isolation.

## Common Issues

### High CPU Usage

ksmd consuming too much CPU.

**Symptoms**: High CPU in `ksmd` process

**Solutions**:
- Reduce `pages_to_scan`
- Increase `sleep_millisecs`
- Disable if savings are minimal

### Low Merge Rate

Few pages being merged.

**Debug**: Check `pages_shared` vs `pages_unshared`

**Causes**:
- Workloads with unique data
- Scan rate too slow
- Memory not marked `MADV_MERGEABLE`

### NUMA Performance Issues

Cross-node merging hurting performance.

**Symptoms**: Higher memory latency after KSM enabled

**Solution**:
```bash
echo 0 > /sys/kernel/mm/ksm/merge_across_nodes
```

## KSM vs Other Deduplication

| Method | Scope | Overhead | Use Case |
|--------|-------|----------|----------|
| KSM | RAM, runtime | CPU for scanning | VMs, containers |
| zswap | Swap, compressed | CPU for compression | Memory extension |
| Filesystem dedup | Disk | I/O for scanning | Storage efficiency |
| COW filesystems | Disk, snapshots | Metadata overhead | Backups, clones |

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/ksm.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/ksm.c) | KSM implementation |

### Kernel Documentation

- [`Documentation/admin-guide/mm/ksm.rst`](https://docs.kernel.org/admin-guide/mm/ksm.html)

### Mailing List Discussions

- [Original KSM patch series](https://lore.kernel.org/lkml/1247851850-4298-8-git-send-email-ieidus@redhat.com/) - Izik Eidus's July 2009 submission
- [KSM NUMA trees and page migration](https://lore.kernel.org/all/alpine.LNX.2.00.1302111410290.1174@eggly.anvils/T/) - Hugh Dickins's 2013 NUMA awareness patches

### Related

- [reclaim](reclaim.md) - Memory pressure interaction
- [numa](numa.md) - Cross-node merging considerations
- [thp](thp.md) - KSM doesn't merge huge pages
- [cow](cow.md) - COW behavior when KSM-merged pages are written
