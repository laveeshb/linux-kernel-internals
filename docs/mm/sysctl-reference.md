# Memory Sysctl Tuning Reference

Compact reference for all memory-related sysctls under `/proc/sys/vm/`. Each entry links to the [kernel sysctl documentation](https://docs.kernel.org/admin-guide/sysctl/vm.html).

Read or write any value at runtime:

```bash
# Read
sysctl vm.swappiness
# Write (non-persistent)
sysctl -w vm.swappiness=10
# Persistent (survives reboot)
echo "vm.swappiness = 10" >> /etc/sysctl.d/99-tuning.conf
sysctl --system
```

---

## Reclaim

Controls how aggressively the kernel reclaims memory and manages free-page watermarks.

| Sysctl | Default | Description | When to change |
|--------|---------|-------------|----------------|
| [`vm.swappiness`](https://docs.kernel.org/admin-guide/sysctl/vm.html#swappiness) | 60 | Weight for reclaiming anonymous pages vs page cache (0-200) | Lower for latency-sensitive workloads that prefer dropping cache over swapping; raise for memory-overcommitted hosts |
| [`vm.min_free_kbytes`](https://docs.kernel.org/admin-guide/sysctl/vm.html#min-free-kbytes) | Varies (scales with RAM) | Minimum KB of free memory the kernel keeps reserved | Raise on systems that hit direct reclaim stalls or need burst allocations (e.g., high-speed networking) |
| [`vm.watermark_scale_factor`](https://docs.kernel.org/admin-guide/sysctl/vm.html#watermark-scale-factor) | 10 | Gap between min/low/high watermarks as fraction of zone size (units of 0.01%) | Raise to trigger kswapd earlier, reducing direct reclaim; useful for bursty allocation patterns |
| [`vm.watermark_boost_factor`](https://docs.kernel.org/admin-guide/sysctl/vm.html#watermark-boost-factor) | 15000 | Temporary watermark boost after memory fragmentation events (units of 0.01%) | Lower or set to 0 on systems where boosted reclaim causes unnecessary swapping |
| [`vm.vfs_cache_pressure`](https://docs.kernel.org/admin-guide/sysctl/vm.html#vfs-cache-pressure) | 100 | Tendency to reclaim dentry/inode caches vs page cache (0 = never, 100 = fair, >100 = aggressive) | Lower for file-server workloads with many small files; raise when dentry/inode caches consume too much memory |

---

## Dirty Pages

Controls when and how often dirty (modified) page cache is written back to disk.

| Sysctl | Default | Description | When to change |
|--------|---------|-------------|----------------|
| [`vm.dirty_ratio`](https://docs.kernel.org/admin-guide/sysctl/vm.html#dirty-ratio) | 20 | Percentage of total memory at which a writing process is forced to start writeback | Lower for latency-sensitive I/O; raise for throughput on fast storage |
| [`vm.dirty_background_ratio`](https://docs.kernel.org/admin-guide/sysctl/vm.html#dirty-background-ratio) | 10 | Percentage of total memory at which background writeback (per-device writeback threads) kicks in | Lower to keep less dirty data in memory (safer on power loss); raise on fast storage to batch more writes |
| [`vm.dirty_expire_centisecs`](https://docs.kernel.org/admin-guide/sysctl/vm.html#dirty-expire-centisecs) | 3000 | Age (in centiseconds) at which dirty data becomes eligible for writeback | Lower for data safety; raise to allow more write coalescing |
| [`vm.dirty_writeback_centisecs`](https://docs.kernel.org/admin-guide/sysctl/vm.html#dirty-writeback-centisecs) | 500 | Interval (in centiseconds) between writeback thread wake-ups | Lower for more frequent flushes; raise (or set to 0 to disable) on battery-powered devices to reduce disk wake-ups |

!!! tip
    Use `dirty_bytes` / `dirty_background_bytes` instead of the ratio variants when you need an absolute cap that does not scale with RAM.

---

## Overcommit

Controls the kernel's memory overcommit policy. See also [Memory Overcommit](overcommit.md).

| Sysctl | Default | Description | When to change |
|--------|---------|-------------|----------------|
| [`vm.overcommit_memory`](https://docs.kernel.org/admin-guide/sysctl/vm.html#overcommit-memory) | 0 | Policy: 0 = heuristic, 1 = always allow, 2 = strict limit | Set to 2 on systems where OOM kills are unacceptable (databases, embedded); set to 1 for certain HPC or container setups |
| [`vm.overcommit_ratio`](https://docs.kernel.org/admin-guide/sysctl/vm.html#overcommit-ratio) | 50 | When `overcommit_memory=2`: commit limit = swap + RAM * ratio / 100 | Raise when applications legitimately need more virtual memory; only effective with mode 2 |
| [`vm.overcommit_kbytes`](https://docs.kernel.org/admin-guide/sysctl/vm.html#overcommit-kbytes) | 0 | When `overcommit_memory=2`: absolute overcommit limit in KB (overrides ratio if nonzero) | Use instead of ratio when you need a precise byte-level commit limit |

---

## Huge Pages

Controls static (hugetlbfs) huge page allocation. For transparent huge pages, see [THP](thp.md).

| Sysctl | Default | Description | When to change |
|--------|---------|-------------|----------------|
| [`vm.nr_hugepages`](https://docs.kernel.org/admin-guide/sysctl/vm.html#nr-hugepages) | 0 | Number of persistent huge pages to pre-allocate | Set to the number of huge pages your application requires (e.g., DPDK, large databases) |
| [`vm.nr_overcommit_hugepages`](https://docs.kernel.org/admin-guide/sysctl/vm.html#nr-overcommit-hugepages) | 0 | Additional huge pages that can be allocated on demand beyond `nr_hugepages` | Set when applications may need burst huge-page capacity but you do not want to pin all memory upfront |
| [`vm.hugetlb_shm_group`](https://docs.kernel.org/admin-guide/sysctl/vm.html#hugetlb-shm-group) | 0 | GID allowed to create SysV shared memory segments backed by huge pages | Set to the group ID of unprivileged users that need huge-page shared memory (e.g., database service accounts) |

---

## NUMA

Tuning knobs for Non-Uniform Memory Access systems. See also [NUMA](numa.md).

| Sysctl | Default | Description | When to change |
|--------|---------|-------------|----------------|
| [`vm.zone_reclaim_mode`](https://docs.kernel.org/admin-guide/sysctl/vm.html#zone-reclaim-mode) | 0 | Bitmask controlling whether the kernel reclaims local-node memory before allocating remotely (1 = enable zone reclaim, 2 = writeback, 4 = swap) | Enable on large NUMA systems where local-memory latency matters more than cache retention; leave at 0 for most workloads |
| [`vm.numa_stat`](https://docs.kernel.org/admin-guide/sysctl/vm.html#numa-stat) | 1 | Enable per-node NUMA hit/miss/foreign statistics in `/proc/vmstat` | Disable (set to 0) on large NUMA machines where the per-update overhead of these counters is measurable |

---

## OOM

Controls Out-Of-Memory killer behavior. See also [Running out of memory](oom.md).

| Sysctl | Default | Description | When to change |
|--------|---------|-------------|----------------|
| [`vm.oom_kill_allocating_task`](https://docs.kernel.org/admin-guide/sysctl/vm.html#oom-kill-allocating-task) | 0 | When set to 1, kill the task that triggered OOM instead of scanning for the worst offender | Enable on systems where scanning is too slow or you want deterministic OOM behavior |
| [`vm.oom_dump_tasks`](https://docs.kernel.org/admin-guide/sysctl/vm.html#oom-dump-tasks) | 1 | Dump per-task memory info to the kernel log on OOM | Disable on systems with thousands of tasks where the dump itself causes problems |
| [`vm.panic_on_oom`](https://docs.kernel.org/admin-guide/sysctl/vm.html#panic-on-oom) | 0 | Trigger a kernel panic instead of invoking the OOM killer (0 = off, 1 = panic, 2 = panic even for cgroup OOM) | Enable in clusters where a dead node is preferable to a degraded one (lets a watchdog or cluster manager restart the machine) |

---

## Miscellaneous

| Sysctl | Default | Description | When to change |
|--------|---------|-------------|----------------|
| [`vm.max_map_count`](https://docs.kernel.org/admin-guide/sysctl/vm.html#max-map-count) | 65530 | Maximum number of VMAs a process may have | Raise for applications with many mappings (e.g., JVMs, Elasticsearch, mmap-heavy databases) |
| [`vm.mmap_min_addr`](https://docs.kernel.org/admin-guide/sysctl/vm.html#mmap-min-addr) | 0 (kernel default; most distros set 65536) | Lowest virtual address a user-space process is allowed to mmap | Lower only if legacy software requires mapping at address zero; keep high for NULL-pointer dereference protection |
| [`vm.compact_memory`](https://docs.kernel.org/admin-guide/sysctl/vm.html#compact-memory) | Write-only | Writing 1 triggers synchronous memory compaction across all zones | Use before allocating huge pages on a fragmented system; avoid in production hot paths |
| [`vm.drop_caches`](https://docs.kernel.org/admin-guide/sysctl/vm.html#drop-caches) | Write-only | Writing 1 = free page cache, 2 = free dentries/inodes, 3 = both | Use only for benchmarking or debugging; not recommended in production as the kernel manages caches effectively on its own |

---

## Quick Tips

- **Check current values**: `sysctl -a | grep vm.` lists every `vm.*` parameter and its value.
- **Monitor effects**: watch `/proc/vmstat`, `/proc/meminfo`, and per-zone stats in `/proc/zoneinfo` after changing a sysctl.
- **Persist changes**: place tuning in `/etc/sysctl.d/*.conf` files rather than editing `/etc/sysctl.conf` directly.
- **Container awareness**: inside a container, many `vm.*` sysctls are host-global and require privileged access. Memory cgroup knobs (see [memcg](memcg.md)) are the per-container equivalent.
