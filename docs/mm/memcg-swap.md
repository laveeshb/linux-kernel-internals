# Swap Accounting in Cgroups

> How swap usage is tracked, limited, and monitored per cgroup

## Why Per-Cgroup Swap Accounting Matters

Without swap accounting, a container with a `memory.max` of 1G can page out 2G of anonymous memory to swap and effectively use 3G of memory — 1G in RAM plus 2G on disk. The cgroup limit is bypassed. Per-cgroup swap accounting closes this gap by counting swap usage separately and enforcing an independent limit.

cgroup v2 tracks RAM and swap with two separate counters and two separate limits. This separation is intentional: it gives operators independent control over how much RAM a cgroup uses and how much swap it can consume.

## The cgroup v2 Swap Interface

### memory.swap.current

`memory.swap.current` reports the number of bytes a cgroup's anonymous pages currently occupy in swap. **This is swap-only** — pages that have been swapped out and are not currently in RAM.

```bash
cat /sys/fs/cgroup/mycontainer/memory.swap.current
# 209715200   (200MB currently in swap)
```

A page that has been swapped out and then swapped back in is no longer counted here (it is now in RAM and counted in `memory.current`). A page that has been copied to swap but is still resident in RAM (swap cache) counts in `memory.current`, not `memory.swap.current`. The two counters are disjoint: `memory.current + memory.swap.current` gives the total memory footprint of the cgroup across both RAM and swap.

```
memory.current        = pages in RAM charged to this cgroup
memory.swap.current   = pages in swap (not currently in RAM) charged to this cgroup
                        ─────────────────────────────────────────────────────────
total footprint       = memory.current + memory.swap.current
```

### memory.swap.max

`memory.swap.max` is the hard limit on swap usage. When a cgroup's `memory.swap.current` reaches this value, further swapping for that cgroup is blocked. Anonymous pages that would have been swapped out are instead reclaimed directly (if possible) or trigger OOM.

```bash
# Disable swap entirely for this cgroup
echo 0 > /sys/fs/cgroup/mycontainer/memory.swap.max

# Allow up to 512MB of swap
echo 512M > /sys/fs/cgroup/mycontainer/memory.swap.max

# Unlimited swap (default if not set)
echo max > /sys/fs/cgroup/mycontainer/memory.swap.max
```

When `memory.swap.max = 0`, the cgroup behaves as if swap does not exist: anonymous pages cannot be paged out, so memory pressure leads directly to OOM rather than swapping. This is the behavior most container orchestrators rely on when `--memory-swap` is set equal to `--memory`.

!!! note "memory.swap.max only limits swap pages, not memsw"
    Setting `memory.swap.max = 512M` means the cgroup can use up to 512MB of swap in addition to its `memory.max`. It does not mean the total (RAM + swap) is capped at 512MB. For a combined limit, set both `memory.max` and `memory.swap.max`.

### memory.swap.high (v5.8+)

`memory.swap.high` is a soft limit on swap usage, analogous to `memory.high` for RAM. When `memory.swap.current` exceeds `memory.swap.high`, the kernel throttles processes in the cgroup and tries to reclaim swap (by swapping pages back in and then freeing them, or by reclaiming the freed anonymous pages).

No processes are killed at `memory.swap.high`. It exists to create back-pressure before `memory.swap.max` is reached.

**Introduced**: This interface was added in kernel v5.8. See [LWN: Cgroup swap high limit](https://lwn.net/Articles/912708/) for the motivation and design discussion.

```bash
# Throttle when swap exceeds 256MB, hard stop at 512MB
echo 256M > /sys/fs/cgroup/mycontainer/memory.swap.high
echo 512M > /sys/fs/cgroup/mycontainer/memory.swap.max
```

If your kernel is older than v6.2, `memory.swap.high` will not exist. Check with:

```bash
ls /sys/fs/cgroup/mycontainer/memory.swap.high 2>/dev/null || echo "not available (kernel < 5.8)"
```

### memory.swap.events (v4.18+)

```bash
cat /sys/fs/cgroup/mycontainer/memory.swap.events
# high 12    <- times swap exceeded memory.swap.high
# max 2      <- times swap hit memory.swap.max
# fail 0     <- swap allocation failures
```

This file was introduced in kernel v6.5 alongside other swap accounting improvements. On older kernels, swap events are not reported separately — swap-related OOM events appear in `memory.events`.

## zswap: Compressed Swap per Cgroup

[zswap](https://docs.kernel.org/admin-guide/mm/zswap.html) is an in-kernel compressed cache for swap pages. Instead of writing anonymous pages directly to disk, zswap compresses them and stores them in a pool of RAM. Pages that cannot fit in zswap are written to disk as usual. This trades CPU for reduced swap I/O.

### memory.zswap.current

`memory.zswap.current` reports the **compressed** bytes this cgroup is using in the zswap pool — the actual RAM consumed by the compressed data. The uncompressed logical size of the swap data is larger; `memory.zswap.current` reflects the physical RAM footprint of the compressed pages in the pool.

```bash
cat /sys/fs/cgroup/mycontainer/memory.zswap.current
# 41943040   (40MB of RAM holding compressed swap pages; uncompressed equivalent may be 100MB+)
```

### memory.zswap.max

`memory.zswap.max` limits how much of the zswap pool this cgroup can use. Without a per-cgroup zswap limit, a single cgroup could fill the entire zswap pool and force other cgroups' pages to disk.

**Commit**: [f4840ccfca25](https://git.kernel.org/linus/f4840ccfca25) ("zswap: memcg accounting")

**Author**: Johannes Weiner (kernel v6.5)

```bash
# Limit this cgroup to 200MB of zswap
echo 200M > /sys/fs/cgroup/mycontainer/memory.zswap.max

# Disable zswap for this cgroup (use disk swap directly)
echo 0 > /sys/fs/cgroup/mycontainer/memory.zswap.max

# Unlimited zswap (default)
echo max > /sys/fs/cgroup/mycontainer/memory.zswap.max
```

!!! note "memory.zswap.max requires zswap to be enabled system-wide"
    If zswap is not enabled (check `cat /sys/module/zswap/parameters/enabled`), `memory.zswap.current` will always be 0 and `memory.zswap.max` has no effect. See the [zswap documentation](https://docs.kernel.org/admin-guide/mm/zswap.html) for enabling zswap.

## The cgroup v1 memsw Interface (Legacy)

cgroup v1 used a different model: a combined **memory + swap** limit called `memsw`. The relevant files were:

| File | Meaning |
|------|---------|
| `memory.limit_in_bytes` | RAM-only limit |
| `memory.memsw.limit_in_bytes` | Combined RAM + swap limit |
| `memory.memsw.usage_in_bytes` | Current combined RAM + swap usage |
| `memory.memsw.max_usage_in_bytes` | Peak combined usage |

### Why memsw was problematic

The `memsw` model had a fundamental design issue: you could not limit swap independently of RAM. If you set `memory.limit_in_bytes = 1G` and `memory.memsw.limit_in_bytes = 2G`, the cgroup could use up to 1G of RAM and 1G of swap. But you could not say "use up to 1G of RAM and up to 512MB of swap" — the two limits were coupled by the combined counter.

Additionally, the combined counter had performance issues. Every swap-in required updating both `memory.usage_in_bytes` and `memory.memsw.usage_in_bytes`, and the interaction between the two limits created subtle races.

### Why cgroup v2 separates them

cgroup v2 replaced `memsw` with separate `memory.max` and `memory.swap.max`. This allows independent control:

```bash
# v2: 1GB RAM, 512MB swap — independent limits
echo 1G   > /sys/fs/cgroup/mycontainer/memory.max
echo 512M > /sys/fs/cgroup/mycontainer/memory.swap.max
```

The separation also makes the semantics clearer: `memory.current` always means RAM, `memory.swap.current` always means disk swap. There is no combined counter to misinterpret.

## What Happens When the Swap Limit Is Hit

When `memory.swap.current` reaches `memory.swap.max`:

1. The kernel cannot swap out any more anonymous pages from this cgroup.
2. The kernel tries direct reclaim of file-backed pages (page cache) within the cgroup — these do not require swap.
3. If reclaim cannot free enough memory to satisfy the allocation, the cgroup OOM killer is invoked.

The OOM kill log will show a normal cgroup OOM (prefix: `Memory cgroup out of memory:`). There is no separate "swap limit exceeded" kill message — from the kernel's perspective, the cgroup ran out of memory because swapping was unavailable.

```bash
# Observe swap limit being hit
cat /sys/fs/cgroup/mycontainer/memory.events
# oom 1           <- OOM was triggered (may be due to swap limit)
# oom_kill 1

# If kernel >= 6.5, check swap events directly
cat /sys/fs/cgroup/mycontainer/memory.swap.events
# max 1           <- swap.max was hit
# fail 0
```

## Monitoring Swap Pressure per Cgroup

### Basic monitoring

```bash
CGROUP=/sys/fs/cgroup/mycontainer

# Current RAM and swap usage
echo "RAM:  $(cat $CGROUP/memory.current) bytes"
echo "Swap: $(cat $CGROUP/memory.swap.current) bytes"

# Limits
echo "RAM limit:  $(cat $CGROUP/memory.max)"
echo "Swap limit: $(cat $CGROUP/memory.swap.max)"

# Usage as a percentage of limit (requires arithmetic)
swap_current=$(cat $CGROUP/memory.swap.current)
swap_max=$(cat $CGROUP/memory.swap.max)
[ "$swap_max" != "max" ] && echo "Swap usage: $((swap_current * 100 / swap_max))%"
```

### Swap activity in memory.stat

`memory.stat` includes swap-related counters:

```bash
cat /sys/fs/cgroup/mycontainer/memory.stat | grep -E "^(pswp|workingset)"

# pswpin         <- pages swapped in
# pswpout        <- pages swapped out
# workingset_refault_anon  <- anonymous pages re-faulted after being reclaimed
```

!!! note "pgpgin/pgpgout not available in cgroup v2"
    `pgpgin` and `pgpgout` are cgroup v1 fields. In cgroup v2 they are explicitly skipped by `mm/memcontrol.c`. Use `pswpin`/`pswpout` for swap activity and `iostat` for broader I/O accounting.

`pswpout` increasing means the cgroup is actively swapping out. `workingset_refault_anon` increasing means pages that were swapped out are being faulted back in — a sign of swap thrashing, where the working set does not fit in the RAM allocation.

### PSI as a swap pressure signal

Memory PSI (`memory.pressure`) captures stall time due to both RAM and swap pressure. A cgroup that is heavily swapping will show elevated PSI `some` values because processes stall waiting for swap I/O.

```bash
cat /sys/fs/cgroup/mycontainer/memory.pressure
# some avg10=15.00 avg60=8.00 avg300=3.00 total=234567
# full avg10=5.00  avg60=2.00 avg300=0.80 total=56789
```

If `pswpin` + `pswpout` are high and PSI `some` is elevated, the cgroup is spending significant time on swap I/O. This typically means the working set is too large for the `memory.max` allocation.

### Watch for swap in real time

```bash
# Poll swap usage every second
while true; do
    swap=$(cat /sys/fs/cgroup/mycontainer/memory.swap.current)
    echo "$(date +%H:%M:%S) swap: $((swap / 1024 / 1024))MB"
    sleep 1
done

# Or use watch
watch -n 1 "cat /sys/fs/cgroup/mycontainer/memory.swap.current | \
    awk '{printf \"%.1f MB\n\", \$1/1024/1024}'"
```

## Swap in Docker and Kubernetes

### Docker

Docker exposes swap control through two flags:

| Flag | Effect |
|------|--------|
| `--memory=1g` | Sets `memory.max = 1G` |
| `--memory-swap=2g` | Sets the **combined** RAM+swap limit to 2G (so 1G RAM + 1G swap) |
| `--memory-swap=-1` | Unlimited swap |
| `--memory-swap=<value equal to --memory>` | No swap (memsw limit = RAM limit) |

!!! warning "Docker --memory-swap semantics are confusing"
    `--memory-swap` is a **combined** limit (RAM + swap), not a swap-only limit. `--memory=1g --memory-swap=1g` means no swap. `--memory=1g --memory-swap=2g` means 1GB swap. On cgroup v2 hosts (Docker 20.10+), Docker translates this into `memory.swap.max` (swap-only limit), automatically computing the difference. The combined semantics of the flag are preserved, but the kernel interface used is the native cgroup v2 one.

```bash
# Allow 512MB of swap for a 1GB container
docker run -d --memory=1g --memory-swap=1536m nginx
# 1536MB memsw limit - 1024MB memory limit = 512MB swap

# Disable swap
docker run -d --memory=1g --memory-swap=1g nginx
```

### Kubernetes

Kubernetes memory limits map only to `memory.max` (RAM). Swap is disabled by default on Kubernetes nodes because the scheduler assumes memory requests and limits reflect only RAM.

The `NodeSwap` feature gate (alpha in v1.22, beta in v1.28) enables swap on Kubernetes nodes, with per-pod swap control via `swapBehavior` in the node configuration. See the [Kubernetes swap documentation](https://kubernetes.io/docs/concepts/architecture/nodes/#swap-memory) for current status.

```yaml
# Kubernetes swap is opt-in and controlled at the node level, not per-pod
# Pod-level swap settings are not yet available in stable Kubernetes
```

## Best Practices

### Deciding whether to allow swap

| Workload type | Swap recommendation |
|---------------|---------------------|
| Latency-sensitive (databases, caches) | Disable (`memory.swap.max = 0`). Swap causes unpredictable latency spikes. |
| Batch jobs, data pipelines | Allow swap. Temporary spikes absorbed into swap rather than causing OOM. |
| Web servers, application servers | Allow limited swap (`memory.swap.max` = 25-50% of `memory.max`). Provides a buffer without allowing unbounded paging. |
| Containers with memory leaks | Disable swap. Swap masks the leak — the container uses swap instead of being killed, making the problem harder to detect. |

### Set memory.high to avoid reaching the swap limit

If a cgroup has swap enabled, set `memory.high` to trigger throttling before the cgroup has consumed all its RAM. This gives the kernel a chance to reclaim page cache before resorting to swapping anonymous pages.

```bash
echo 800M > /sys/fs/cgroup/mycontainer/memory.high   # Throttle here
echo 1G   > /sys/fs/cgroup/mycontainer/memory.max    # OOM here
echo 512M > /sys/fs/cgroup/mycontainer/memory.swap.max  # Swap budget
```

### Use zswap to reduce disk I/O

If your system has spare CPU capacity and swap I/O is a bottleneck, enabling zswap reduces the amount of data written to disk:

```bash
# Enable zswap globally
echo 1 > /sys/module/zswap/parameters/enabled

# Limit per-cgroup zswap usage (kernel >= 6.5)
echo 200M > /sys/fs/cgroup/mycontainer/memory.zswap.max
```

The default zswap pool size is a heuristic (typically 20% of total RAM — check `/sys/module/zswap/parameters/max_pool_percent`). Without per-cgroup limits, a single container can saturate the zswap pool.

## Try It Yourself

### Observe swap usage in a cgroup

```bash
# Create a cgroup with limited RAM but some swap
sudo mkdir -p /sys/fs/cgroup/swap-test
echo "+memory" | sudo tee /sys/fs/cgroup/cgroup.subtree_control
echo 128M | sudo tee /sys/fs/cgroup/swap-test/memory.max
echo 256M | sudo tee /sys/fs/cgroup/swap-test/memory.swap.max

# Move the current shell into the cgroup
echo $$ | sudo tee /sys/fs/cgroup/swap-test/cgroup.procs

# Allocate more than the RAM limit — should use swap instead of OOM
python3 -c "
import time
x = bytearray(200 * 1024 * 1024)  # 200MB: 128MB fits in RAM, rest goes to swap
print('allocated 200MB')
time.sleep(10)
"

# In another terminal, watch swap usage
watch -n 1 cat /sys/fs/cgroup/swap-test/memory.swap.current
```

### Observe OOM when swap limit is also hit

```bash
sudo mkdir -p /sys/fs/cgroup/swap-oom-test
echo 64M  | sudo tee /sys/fs/cgroup/swap-oom-test/memory.max
echo 64M  | sudo tee /sys/fs/cgroup/swap-oom-test/memory.swap.max  # no swap
echo $$ | sudo tee /sys/fs/cgroup/swap-oom-test/cgroup.procs

# This will OOM because swap is disabled
python3 -c "x = bytearray(100 * 1024 * 1024)"
```

## Key Source Files

| File | Relevant code |
|------|---------------|
| [`mm/memcontrol.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c) | Swap charge/uncharge: `__mem_cgroup_try_charge_swap()`, `__mem_cgroup_uncharge_swap()`, `mem_cgroup_swapin_charge_folio()`; swap limit enforcement; `memory.swap.current` and `memory.swap.max` reads/writes |
| [`include/linux/memcontrol.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/memcontrol.h) | `struct mem_cgroup`: `swap`, `memsw`, swap counter fields |
| [`mm/swap_state.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/swap_state.c) | Swap cache management, interacts with memcg charges |
| [`mm/zswap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/zswap.c) | zswap implementation including per-memcg accounting |

## History

### cgroup v1 memsw (v2.6.34, 2010)

The combined memory+swap (`memsw`) interface was introduced in cgroup v1. It provided the only mechanism to limit swap per cgroup, but the combined-limit model caused confusion and the implementation had performance overhead from maintaining two coupled counters.

### cgroup v2 separate swap accounting

cgroup v2 separated `memory.max` (RAM) from `memory.swap.max` (swap-only), fixing the semantic confusion of `memsw`. The separation was part of the broader cgroup v2 memory controller redesign that reached production readiness in v4.5. See [LWN: The unified cgroup hierarchy](https://lwn.net/Articles/679786/).

### memory.swap.high (v5.8, 2020)

**LWN**: [Cgroup swap high limit](https://lwn.net/Articles/912708/)

Added a soft swap limit analogous to `memory.high` for RAM, enabling throttle-before-OOM behavior for swap as well as for RAM.

### Per-cgroup zswap accounting (v5.19, 2022)

**Commit**: [f4840ccfca25](https://git.kernel.org/linus/f4840ccfca25) ("zswap: memcg accounting")

**Author**: Johannes Weiner

Enabled `memory.zswap.current` and `memory.zswap.max`, preventing any single cgroup from monopolizing the zswap pool and causing other cgroups' pages to be written to disk.

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/memcontrol.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c) | Swap charge/uncharge, swap limit enforcement |
| [`mm/zswap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/zswap.c) | zswap implementation and memcg accounting |
| [`include/linux/memcontrol.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/memcontrol.h) | memcg struct and swap counter fields |

### Kernel Documentation

- [`Documentation/admin-guide/cgroup-v2.rst`](https://docs.kernel.org/admin-guide/cgroup-v2.html) — memory interface files, swap accounting
- [`Documentation/admin-guide/mm/zswap.rst`](https://docs.kernel.org/admin-guide/mm/zswap.html) — zswap documentation

### LWN Articles

- [The unified cgroup hierarchy](https://lwn.net/Articles/679786/) — cgroup v2 design including swap separation
- [Cgroup swap high limit](https://lwn.net/Articles/912708/) — memory.swap.high motivation and design

### Related

- [Memory Cgroups](memcg.md) — memcg fundamentals
- [Tuning memory for containers](tuning-containers.md) — practical container memory tuning
- [Cgroup OOM controller](memcg-oom.md) — what happens when the swap limit contributes to OOM
- [Hierarchical memory limits](memcg-hierarchy.md) — how limits propagate through the cgroup tree

## Further reading

- [mm/memcontrol.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c) — `__mem_cgroup_try_charge_swap()` and `__mem_cgroup_uncharge_swap()` for the swap charge/uncharge paths; `memory.swap.current` and `memory.swap.max` read/write handlers
- [mm/zswap.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/zswap.c) — zswap implementation including per-memcg pool accounting introduced by commit `f4840ccfca25`
- `Documentation/admin-guide/cgroup-v2.rst` — `memory.swap.*` and `memory.zswap.*` interface file semantics, including the disjoint-counter model (`memory.current + memory.swap.current = total footprint`)
- `Documentation/admin-guide/mm/zswap.rst` — zswap architecture, enabling instructions, and pool configuration
- [LWN: The unified cgroup hierarchy in 4.5](https://lwn.net/Articles/679786/) — cgroup v2 design context, including why `memory.max` and `memory.swap.max` were separated from the v1 combined `memsw` model
- [LWN: Cgroup swap high limit](https://lwn.net/Articles/912708/) — motivation and design for `memory.swap.high`, the soft swap limit that throttles before `memory.swap.max` triggers OOM
- [memcg](memcg.md) — memcg fundamentals: `memory.max`, `memory.high`, and basic cgroup operations
- [memcg-oom](memcg-oom.md) — what the OOM kill log looks like when the swap limit is the proximate cause of the kill
- [reclaim](reclaim.md) — how the kernel reclaims anonymous pages via swap and file pages via writeback during memory pressure
