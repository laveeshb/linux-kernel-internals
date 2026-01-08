# Memory Cgroups (memcg)

> Container memory limits and accounting

## What Is memcg?

Memory cgroups (memcg) allow limiting and tracking memory usage for groups of processes. They're the foundation of container memory limits (Docker, Kubernetes, systemd).

```
Container A (limit: 1GB)      Container B (limit: 2GB)
┌─────────────────────┐      ┌─────────────────────┐
│  Process 1          │      │  Process 3          │
│  Process 2          │      │  Process 4          │
│  [shared memory]    │      │  [shared memory]    │
└─────────────────────┘      └─────────────────────┘
         │                            │
         └────────────┬───────────────┘
                      │
              Memory Controller
              (tracks & enforces)
```

## cgroup v1 vs v2

Linux has two cgroup implementations:

| Feature | v1 | v2 |
|---------|----|----|
| Hierarchy | Multiple (one per controller) | Single unified |
| Memory+IO coordination | Difficult | Integrated |
| Pressure notification | Limited | PSI (Pressure Stall Info) |
| Default (modern systems) | Legacy | Preferred |

**v2 is recommended** for new deployments. This document focuses on v2.

```bash
# Check which version is mounted
mount | grep cgroup

# v1: /sys/fs/cgroup/memory, /sys/fs/cgroup/cpu, etc.
# v2: /sys/fs/cgroup (unified)
```

## Basic Operations

### Create a cgroup

```bash
# Create a new cgroup
mkdir /sys/fs/cgroup/mygroup

# Move a process into it
echo $PID > /sys/fs/cgroup/mygroup/cgroup.procs

# Enable memory controller
echo "+memory" > /sys/fs/cgroup/cgroup.subtree_control
```

### Set Memory Limit

```bash
# Set 500MB limit (cgroup v2)
echo 500M > /sys/fs/cgroup/mygroup/memory.max

# Set soft limit (reclaim target)
echo 400M > /sys/fs/cgroup/mygroup/memory.high
```

### View Usage

```bash
# Current memory usage
cat /sys/fs/cgroup/mygroup/memory.current

# Detailed statistics
cat /sys/fs/cgroup/mygroup/memory.stat
```

## Memory Limits (v2)

| File | Description |
|------|-------------|
| `memory.max` | Hard limit. OOM kill if exceeded. |
| `memory.high` | Soft limit. Throttle and reclaim aggressively. |
| `memory.low` | Protection. Best-effort preservation under pressure. |
| `memory.min` | Hard protection. Never reclaim below this. |

```
                    memory.max
                        │
        OOM kill ──────>│
                        │
                    memory.high
                        │
     Aggressive ───────>│
      reclaim           │
                        │
                    memory.low
                        │
    Protected ─────────>│ (best-effort)
                        │
                    memory.min
                        │
     Cannot ───────────>│ (hard guarantee)
      reclaim
```

### Example: Container Limits

```bash
# Production container setup
echo 1G > /sys/fs/cgroup/container/memory.max    # Hard limit
echo 800M > /sys/fs/cgroup/container/memory.high # Start throttling
echo 200M > /sys/fs/cgroup/container/memory.low  # Protect this much
```

## What's Accounted

memcg tracks:

| Type | Accounted | Notes |
|------|-----------|-------|
| Anonymous pages | Yes | Heap, stack, mmap(MAP_ANONYMOUS) |
| File cache | Yes | Pages from file reads |
| Slab (kmem) | Yes (v2) | Kernel objects for this cgroup |
| Huge pages | Separate | Via `hugetlb` controller |
| Kernel stacks | Yes (v2) | Per-task kernel stacks |

### Memory Statistics

```bash
cat /sys/fs/cgroup/mygroup/memory.stat

# Key fields:
# anon        - Anonymous memory
# file        - File cache
# slab        - Kernel slab objects
# sock        - Network socket buffers
# pgfault     - Page faults
# pgmajfault  - Major page faults (disk I/O)
```

## Per-cgroup Reclaim

When a cgroup approaches its limit, reclaim happens within that cgroup first.

```
Global memory OK
        │
        v
Cgroup A at memory.high
        │
        v
Reclaim from Cgroup A only
(other cgroups unaffected)
```

### memory.reclaim (v5.19+)

Proactively trigger reclaim:

```bash
# Reclaim 100MB from cgroup
echo 100M > /sys/fs/cgroup/mygroup/memory.reclaim
```

Useful for:
- Pre-warming before load spike
- Reducing memory before migration
- Testing reclaim behavior

## OOM Handling

When a cgroup exceeds `memory.max`:

1. Kernel tries reclaim within cgroup
2. If insufficient, triggers cgroup OOM
3. OOM killer selects process within cgroup
4. Selected process is killed

```bash
# View OOM events
cat /sys/fs/cgroup/mygroup/memory.events

# Fields:
# oom        - OOM events count
# oom_kill   - Processes killed by OOM
# max        - Times memory.max was hit
# high       - Times memory.high was hit
```

### OOM Group Kill (v4.19+)

**Commit**: [3d8b38eb81ca](https://git.kernel.org/linus/3d8b38eb81ca) ("mm, oom: introduce memory.oom.group")

Kill entire cgroup instead of single process:

```bash
echo 1 > /sys/fs/cgroup/mygroup/memory.oom.group
```

Useful for containers where killing one process leaves others broken.

## Pressure Stall Information (PSI)

PSI shows how much time tasks spend waiting for memory:

```bash
cat /sys/fs/cgroup/mygroup/memory.pressure

# avg10=0.00 avg60=0.00 avg300=0.00 total=12345
# some: percentage of time at least one task was stalled
# full: percentage of time all tasks were stalled
```

### Use Cases

- **Autoscaling**: Scale up when pressure increases
- **Health checks**: Detect memory-constrained containers
- **Load balancing**: Move workloads from pressured nodes

```bash
# Monitor system-wide pressure
cat /proc/pressure/memory
```

## Hierarchical Limits

Cgroups are hierarchical. Child limits can't exceed parent:

```
root (limit: 8GB)
├── container-a (limit: 2GB)
│   ├── app (limit: 1GB)      <- effective: 1GB
│   └── sidecar (limit: 3GB)  <- effective: 2GB (parent limit)
└── container-b (limit: 4GB)
```

## Swap Control

```bash
# Limit swap usage (v2)
echo 0 > /sys/fs/cgroup/mygroup/memory.swap.max    # No swap
echo 500M > /sys/fs/cgroup/mygroup/memory.swap.max # 500MB swap

# View swap usage
cat /sys/fs/cgroup/mygroup/memory.swap.current
```

## History

### Memory Controller Introduction (v2.6.25, 2008)

**Commit**: [8cdea7c05454](https://git.kernel.org/linus/8cdea7c05454) ("Memory controller: cgroups setup")

Initial memory cgroup implementation for cgroup v1.

### Unified Hierarchy (cgroup v2, v4.5, 2016)

The cgroup v2 unified hierarchy was marked non-experimental in v4.5, with the memory controller considered stable for production use. The memory controller was reworked significantly from v1, with cleaner semantics and integrated pressure stall information.

### Kernel Memory Accounting (v4.5+)

Kernel memory (slab, stacks) included in memory.current by default in v2.

### memory.reclaim (v5.19, 2022)

**Commit**: [94968384dde1](https://git.kernel.org/linus/94968384dde1) ("memcg: introduce per-memcg reclaim interface")

Proactive reclaim interface.

## Try It Yourself

### Create a Memory-Limited Shell

```bash
# Create cgroup
sudo mkdir /sys/fs/cgroup/test

# Enable memory controller (if needed)
echo "+memory" | sudo tee /sys/fs/cgroup/cgroup.subtree_control

# Set 100MB limit
echo 100M | sudo tee /sys/fs/cgroup/test/memory.max

# Move current shell into cgroup
echo $$ | sudo tee /sys/fs/cgroup/test/cgroup.procs

# Now try to allocate more than 100MB
python3 -c "x = 'a' * 150_000_000"  # Will be OOM killed
```

### Monitor a Container

```bash
# Find container's cgroup
CGROUP=$(cat /proc/<container-pid>/cgroup | cut -d: -f3)

# Watch memory usage
watch -n 1 cat /sys/fs/cgroup/$CGROUP/memory.current

# View detailed stats
cat /sys/fs/cgroup/$CGROUP/memory.stat
```

### Simulate Memory Pressure

```bash
# Create cgroup with low limit
sudo mkdir /sys/fs/cgroup/pressure-test
echo 50M | sudo tee /sys/fs/cgroup/pressure-test/memory.max

# Run memory-hungry process
echo $$ | sudo tee /sys/fs/cgroup/pressure-test/cgroup.procs
stress --vm 1 --vm-bytes 100M

# Watch pressure
cat /sys/fs/cgroup/pressure-test/memory.pressure
```

## Common Issues

### Container OOM Despite Free System Memory

Container hit its `memory.max` limit.

**Debug**: Check `memory.events` for `oom` count.

**Solutions**:
- Increase limit
- Optimize application memory usage
- Add swap and `memory.swap.max`

### Slow Container Startup

Memory being reclaimed during startup.

**Debug**: Check `memory.pressure`

**Solutions**:
- Increase `memory.high`
- Pre-warm with `memory.reclaim`
- Check if limit is too low

### Kernel Memory Growing Unbounded (v1)

In cgroup v1, kernel memory wasn't limited by default.

**Solution**: Use cgroup v2, or set `memory.kmem.limit_in_bytes` in v1.

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/memcontrol.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c) | Memory controller implementation |
| [`include/linux/memcontrol.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/memcontrol.h) | memcg API |

### Kernel Documentation

- [`Documentation/admin-guide/cgroup-v2.rst`](https://docs.kernel.org/admin-guide/cgroup-v2.html) - Authoritative cgroup v2 docs

### Related

- [reclaim](reclaim.md) - How memory is reclaimed
- [page-allocator](page-allocator.md) - Global memory allocation
- [glossary](glossary.md) - cgroup, OOM definitions
