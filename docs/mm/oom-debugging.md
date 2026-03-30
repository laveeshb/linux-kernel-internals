# OOM scenarios and debugging guide

> Practical playbook for preventing, detecting, and diagnosing out-of-memory kills

This is the hands-on companion to [Running out of memory](oom.md), which covers the kernel internals. This page focuses on what to do in practice.

## Preventing OOM

### Size memory for your workload

```bash
# Baseline: check current usage and headroom
free -h
cat /proc/meminfo | grep -E "MemTotal|MemAvailable|SwapTotal|SwapFree"

# Per-process RSS (top consumers)
ps aux --sort=-%mem | head -20

# Sum of all process RSS (approximate committed memory)
awk '/Rss:/ {sum += $2} END {print sum/1024, "MB"}' /proc/[0-9]*/smaps_rollup 2>/dev/null
```

Rule of thumb: keep `MemAvailable` above 10-15% of `MemTotal` during peak load. If it regularly drops below that, add RAM or reduce workload.

### Add swap

Running without swap is the single most common cause of unnecessary OOM kills. Even a small swap gives the kernel a pressure valve for cold anonymous pages.

```bash
# Check for existing swap
swapon --show

# Create a swap file (4 GB example)
# Note: fallocate may not work on Btrfs or XFS with reflinks.
# Use dd as a portable alternative: dd if=/dev/zero of=/swapfile bs=1M count=4096
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Tune swappiness (default 60; lower = prefer reclaiming page cache)
sysctl vm.swappiness=30
```

See [What happens during swapping](swapping.md) for details on how the kernel uses swap.

### Set cgroup memory limits

Cgroup limits contain runaway processes before they pressure the entire system. See [Memory Cgroups](memcg.md) for the full picture.

```bash
# systemd service (recommended)
# In the unit file [Service] section:
#   MemoryMax=2G
#   MemoryHigh=1800M

# Manual cgroup v2
echo 2G > /sys/fs/cgroup/myservice/memory.max
echo 1800M > /sys/fs/cgroup/myservice/memory.high
```

`memory.high` is a soft throttle -- the kernel slows allocations before hitting the hard `memory.max` limit. Always set both.

### Tune watermarks

```bash
# Give kswapd more room to work (default is often too small for servers)
sysctl vm.min_free_kbytes=262144    # 256 MB
sysctl vm.watermark_scale_factor=50 # 0.5% of zone memory per step
```

See the watermark discussion in [Running out of memory](oom.md#stage-1-watermarks-and-pressure-detection).

## Detecting approaching OOM

Catching memory pressure before OOM fires is far better than debugging after the fact.

### Monitor PSI (Pressure Stall Information)

PSI (available since kernel 4.20) is the best single metric for memory pressure.

```bash
# Current pressure (some = at least one task stalled, full = all tasks stalled)
cat /proc/pressure/memory
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0

# Per-cgroup pressure
cat /sys/fs/cgroup/myservice/memory.pressure
```

Operational guidelines (these are heuristics, not kernel-defined limits — tune for your workload):

| `some avg10` | Meaning |
|-------------|---------|
| < 5%  | Healthy |
| 5-20% | Moderate pressure, investigate |
| > 20% | Severe pressure, OOM likely if sustained |

**PSI trigger for automated response** (cgroup v2):

```bash
# PSI triggers require holding the fd open — a shell echo will not work
# because closing the fd destroys the trigger (psi_fop_release() calls
# psi_trigger_destroy()). Use a program that holds the fd open and
# calls poll()/epoll(). Example trigger format:
#   "some 500000 2000000"  (500ms of stall time within a 2s window)
# See kernel docs: Documentation/accounting/psi.rst
```

### Track MemAvailable

```bash
# One-liner: log MemAvailable every 10 seconds
while true; do
  date +%H:%M:%S | tr '\n' ' '
  awk '/MemAvailable/ {print $2/1024, "MB"}' /proc/meminfo
  sleep 10
done

# Alert if MemAvailable drops below 5%
awk '/MemTotal/ {total=$2} /MemAvailable/ {avail=$2}
     END {pct=avail*100/total; if (pct < 5) print "WARNING: MemAvailable at " pct "%"}' /proc/meminfo
```

### Watch vmstat counters

```bash
# Real-time view (1-second interval)
vmstat 1

# Key columns:
#   si/so  = swap in/out (KB/s) -- nonzero means active swapping
#   free   = free memory (KB)
#   buff/cache = reclaimable memory

# Detailed counters for reclaim activity
watch -n 1 'grep -E "allocstall|pgscan_direct|pgsteal|oom_kill" /proc/vmstat'
```

| Counter | What it means |
|---------|---------------|
| `allocstall_normal` | Direct reclaim events (allocating process blocked) |
| `pgscan_direct` | Pages scanned during direct reclaim |
| `pgsteal_direct` | Pages successfully reclaimed in direct reclaim |
| `oom_kill` | Total OOM kills since boot |

If `allocstall` is rising, the system is under memory pressure and headed toward OOM.

## Analyzing OOM after the fact

### Reading the OOM kill log

```bash
# Find OOM events in kernel log
dmesg -T | grep -i "out of memory"
dmesg -T | grep -i "oom"

# On systemd systems (persisted across reboots)
journalctl -k --grep="Out of memory"
journalctl -k --grep="oom" --since="2024-01-01"
```

A typical OOM message looks like:

```
[Thu Jan  4 03:14:15 2024] myapp invoked oom-killer: gfp_mask=0x100cca(GFP_HIGHUSER_MOVABLE), order=0, oom_score_adj=0
[...]
[Thu Jan  4 03:14:15 2024] Mem-Info:
[...]
[Thu Jan  4 03:14:15 2024] Out of memory: Killed process 12345 (myapp)
                           total-vm:4194304kB, anon-rss:3145728kB, file-rss:2048kB,
                           shmem-rss:0kB, UID:1000 pgtables:8192kB oom_score_adj:0
```

Key fields to check:

| Field | What to look for |
|-------|-----------------|
| `gfp_mask` | Allocation type that triggered OOM. `GFP_KERNEL` = kernel allocation, `GFP_HIGHUSER_MOVABLE` = userspace page |
| `order` | 0 = single page (real OOM). Higher orders may be fragmentation, not true OOM |
| `anon-rss` | Anonymous resident memory of the killed process |
| `oom_score_adj` | Was the victim protected or targeted? |
| `Mem-Info` section | System-wide memory state at time of kill |

!!! tip "order > 0 kills"
    If `order` is greater than 0, the system may not actually be out of memory -- it could be a fragmentation issue. Check if `MemAvailable` was still reasonable in the Mem-Info dump. See [Compaction](compaction.md) for details.

### Correlate with monitoring

The OOM log only captures a snapshot. Correlate with external monitoring to understand the trend:

```bash
# Check if the cgroup hit its limit (not system-wide OOM)
cat /sys/fs/cgroup/myservice/memory.events
# Look for oom and oom_kill counters > 0

# Check peak usage
cat /sys/fs/cgroup/myservice/memory.peak

# Was swap available?
dmesg -T | grep -A 50 "invoked oom-killer" | grep -i swap
```

Questions to answer:

1. **Was it system-wide or cgroup-scoped?** Check if the OOM log mentions a specific cgroup.
2. **Was swap available?** If `SwapFree` was 0 in the Mem-Info dump, adding swap would have helped.
3. **Was memory steadily growing (leak) or did it spike?** Correlate with your time-series monitoring.
4. **Which process was actually consuming memory?** The killed process is the largest, not necessarily the leaker.

## Common misconfigurations

### No swap

Without swap, anonymous pages (heap, stack) cannot be reclaimed at all. The kernel can only reclaim page cache, and once that is exhausted, OOM is immediate.

```bash
# Check
swapon --show
# If empty, you have no swap -- add some (see above)
```

Even SSDs benefit from swap. The kernel preferentially swaps cold pages that haven't been touched in minutes or hours.

### Too many OOM-protected processes

Setting `oom_score_adj=-1000` on multiple processes leaves the OOM killer with no good victims.

```bash
# Find all OOM-protected processes
for pid in /proc/[0-9]*; do
  adj=$(cat "$pid/oom_score_adj" 2>/dev/null)
  if [ "$adj" = "-1000" ]; then
    comm=$(cat "$pid/comm" 2>/dev/null)
    echo "PID $(basename $pid): $comm (oom_score_adj=$adj)"
  fi
done
```

If the only killable processes are tiny (low RSS), the OOM killer may loop without freeing enough memory, or the system may hang. Protect only the one or two truly critical processes (e.g., database, init).

### Cgroup limits too tight

A cgroup limit that matches normal usage with no headroom causes OOM kills during minor spikes.

```bash
# Check how close the cgroup is to its limit
echo "Current: $(cat /sys/fs/cgroup/myservice/memory.current)"
echo "Max:     $(cat /sys/fs/cgroup/myservice/memory.max)"
echo "Peak:    $(cat /sys/fs/cgroup/myservice/memory.peak)"

# Check for throttling events (memory.high breaches)
cat /sys/fs/cgroup/myservice/memory.events | grep high
```

Set `memory.max` at least 20-30% above typical peak usage. Use `memory.high` at the actual target to get throttling (graceful slowdown) rather than kills.

### Overcommit misconfiguration

```bash
# Check overcommit policy
cat /proc/sys/vm/overcommit_memory
# 0 = heuristic (default, usually fine)
# 1 = always overcommit (dangerous: no malloc failures, just OOM kills)
# 2 = strict accounting (may reject allocations too aggressively)

cat /proc/sys/vm/overcommit_ratio  # Used with mode 2 (percentage of RAM)
```

See [Memory Overcommit](overcommit.md) for the full explanation.

## Testing OOM handling

### stress-ng: controlled memory pressure

```bash
# Allocate 90% of available memory across 4 workers
stress-ng --vm 4 --vm-bytes 90% --vm-keep --timeout 60s

# Trigger OOM deliberately (allocate more than available)
stress-ng --vm 2 --vm-bytes 120% --vm-keep --timeout 30s

# Gradual pressure ramp (useful with monitoring)
stress-ng --vm 1 --vm-bytes 50% --vm-method all --vm-keep --timeout 120s
```

### Cgroup-based controlled OOM

Test OOM within a cgroup without risking the host:

```bash
# Create a test cgroup with a small limit
mkdir -p /sys/fs/cgroup/oom-test
echo 100M > /sys/fs/cgroup/oom-test/memory.max
echo $$ > /sys/fs/cgroup/oom-test/cgroup.procs

# Allocate more than the limit (will trigger cgroup OOM)
stress-ng --vm 1 --vm-bytes 200M --vm-keep --timeout 10s

# Check that OOM fired within the cgroup
cat /sys/fs/cgroup/oom-test/memory.events | grep oom

# Clean up: move shell back to root cgroup
echo $$ > /sys/fs/cgroup/cgroup.procs
rmdir /sys/fs/cgroup/oom-test
```

### oom_score_adj manipulation

```bash
# Make a specific process the OOM target
echo 1000 > /proc/$PID/oom_score_adj

# Verify scores
for pid in $(pgrep -x myapp); do
  echo "PID $pid: score=$(cat /proc/$pid/oom_score) adj=$(cat /proc/$pid/oom_score_adj)"
done
```

### Verify your application handles OOM gracefully

```bash
# Check if a process restarted after OOM (systemd)
systemctl status myservice
# Look for: "Main process exited, code=killed, status=9/KILL"

# Confirm systemd will restart it
systemctl show myservice | grep Restart=
```

## Userspace OOM handlers

### systemd-oomd

`systemd-oomd` (introduced in [systemd 247](https://github.com/systemd/systemd/blob/v247/NEWS), stabilized in [248](https://github.com/systemd/systemd/blob/v248/NEWS)) kills processes based on PSI pressure and swap usage before the kernel OOM killer fires. It acts earlier and more predictably.

```bash
# Check if running
systemctl status systemd-oomd

# View configuration
cat /etc/systemd/oomd.conf
# [OOM]
# SwapUsedLimit=90%
# DefaultMemoryPressureDurationSec=20s

# Per-service overrides (in unit file)
# [Service]
# ManagedOOMSwap=kill
# ManagedOOMMemoryPressure=kill
# ManagedOOMMemoryPressureLimit=80%
```

How it differs from the kernel OOM killer:

| Aspect | Kernel OOM | systemd-oomd |
|--------|-----------|--------------|
| Trigger | Allocation failure after reclaim exhaustion | PSI threshold or swap usage |
| Scope | System-wide or per-cgroup | Per-cgroup (systemd slices) |
| Reaction time | Last resort (late) | Configurable (early) |
| Victim selection | Highest `oom_score` | Highest memory usage in cgroup |
| Configuration | `/proc/*/oom_score_adj` | Unit file directives |

### Other userspace handlers

**earlyoom** -- lightweight daemon, popular on desktops:

```bash
# Install and configure
# earlyoom monitors MemAvailable% and SwapFree%
# Default: kill when both drop below 10%
earlyoom -m 5 -s 5    # Kill at 5% memory and 5% swap remaining
```

**nohang** -- more configurable alternative to earlyoom, supports PSI triggers and custom actions per-process.

### When to use userspace OOM handlers

- Desktops/workstations: earlyoom or systemd-oomd prevent the system from becoming unresponsive.
- Container hosts: systemd-oomd with per-slice policies gives predictable behavior.
- Servers with critical services: userspace handlers can make smarter kill decisions than the kernel.

## Quick reference

### One-page diagnostic checklist

```bash
# 1. Is swap available?
swapon --show

# 2. Current memory state
free -h

# 3. Memory pressure (kernel 4.20+)
cat /proc/pressure/memory

# 4. Top memory consumers
ps aux --sort=-%mem | head -10

# 5. Recent OOM events
dmesg -T | grep -i "out of memory"

# 6. Direct reclaim activity (rising = trouble)
grep -E "allocstall|oom_kill" /proc/vmstat

# 7. Cgroup limits and events
for cg in /sys/fs/cgroup/*/; do
  if [ -f "$cg/memory.max" ]; then
    max=$(cat "$cg/memory.max")
    [ "$max" != "max" ] && echo "$(basename $cg): current=$(cat $cg/memory.current) max=$max"
  fi
done

# 8. OOM-protected processes
grep "^-1000$" /proc/*/oom_score_adj 2>/dev/null | head -20
```

## Further reading

- [Running out of memory](oom.md) -- kernel OOM internals (watermarks, reclaim stages, OOM killer scoring)
- [Memory Cgroups](memcg.md) -- cgroup memory limits and accounting
- [Memory Overcommit](overcommit.md) -- how Linux promises more memory than it has
- [What happens during swapping](swapping.md) -- the swap subsystem in detail
- [Page Reclaim](reclaim.md) -- how the kernel reclaims memory before resorting to OOM
