# Hierarchical Memory Limits

> How memory limits and protections propagate through the cgroup v2 tree

## The Problem with Flat Limits

A single cgroup limit is easy to reason about: set `memory.max`, and the kernel enforces it. But real deployments are not flat. A Kubernetes node has system services, kubelet, and hundreds of pods. A container runtime has a parent cgroup for the entire runtime, child cgroups per container, and grandchild cgroups per process group. When limits are set at every level, the rules for how they interact matter enormously.

cgroup v2 defines a clear model: limits cascade downward and protections are distributed proportionally. This page explains exactly how that works.

## The Four Knobs, Revisited

cgroup v2 exposes four memory control files. Two are **limits** (caps on consumption), and two are **protections** (guarantees against reclaim):

| File | Direction | Type | Enforcement |
|------|-----------|------|-------------|
| `memory.max` | Downward cap | Hard limit | OOM kill if exceeded |
| `memory.high` | Downward cap | Soft limit | Throttle + aggressive reclaim |
| `memory.low` | Upward guarantee | Soft protection | Best-effort; kernel avoids reclaiming below this |
| `memory.min` | Upward guarantee | Hard protection | Never reclaimed, even under extreme pressure |

The hierarchy rules for limits and protections are different, and understanding that difference is the key to this page.

## How Limits Cascade: The Effective Limit

For `memory.max` and `memory.high`, a child cgroup's **effective limit** is the minimum of its own setting and its parent's remaining headroom. The kernel does not silently override a child's setting; instead, enforcement happens at every level independently.

Consider this hierarchy:

```
root
└── service (memory.max = 4G)
    ├── container-a (memory.max = 3G)
    └── container-b (memory.max = 3G)
```

Both `container-a` and `container-b` have `memory.max = 3G`, but the parent `service` has only 4G. This is allowed — cgroup v2 does not prevent you from writing a child limit larger than the parent. What happens in practice:

- If `container-a` uses 3G and `container-b` tries to use 2G, the parent's 4G limit will throttle or OOM `container-b` even though `container-b`'s own `memory.max` of 3G has not been reached.
- The effective limit for any cgroup is the minimum of its own limit and what the parent tree can accommodate.

The kernel enforces limits at each level independently via `mem_cgroup_is_root()` checks throughout [`mm/memcontrol.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c). Each charge operation walks up the cgroup tree, testing the limit at every ancestor.

```
Charge path for a page allocation (simplified):
  try_charge() in mm/memcontrol.c
    → walks up cgroup tree
    → at each ancestor: compare usage against memory.max
    → if any ancestor is at limit: enter reclaim / OOM
```

## How Protections Are Distributed

Protection (`memory.min` and `memory.low`) works differently from limits. When a child's protection is considered during global reclaim, the kernel must compute the **effective protection** — the amount the child can actually keep, given what the parent can guarantee.

The calculation is defined in `mem_cgroup_protected()` in [`mm/memcontrol.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c). The kernel documentation at [`Documentation/admin-guide/cgroup-v2.rst`](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files) describes the model as follows: a child's effective protection is the minimum of its own configured protection and the parent's protection, distributed proportionally when the sum of children's protections exceeds the parent's.

### The Proportional Distribution Formula

When the sum of sibling protections exceeds the parent's protection, each child receives a proportional share:

```
effective_protection(child) =
    min(child.memory.min,
        parent_protection × (child.memory.min / sum_of_sibling_memory_mins))
```

This is a heuristic for fair distribution, not a hard mathematical guarantee — the kernel uses this formula as a reclaim weight, not as a strict reservation enforced at charge time.

**Example:**

```
parent (memory.min = 4G)
├── child-a (memory.min = 3G)
└── child-b (memory.min = 2G)
```

Sum of children = 5G, parent protection = 4G. Since 5G > 4G, each child gets a proportional share:

- `child-a` effective protection = 4G × (3G / 5G) = **2.4G**
- `child-b` effective protection = 4G × (2G / 5G) = **1.6G**

If the sum of children's protections is ≤ the parent's protection, each child gets its full configured value.

## A Three-Level Hierarchy: System → Service → Container

Here is a concrete example with three levels. The system has 16G of RAM, a `system.slice` cgroup for all services, a `myapp.service` cgroup for a single application, and `worker` and `sidecar` containers inside it.

```
system.slice   (memory.max = 12G, memory.min = 2G)
└── myapp.service  (memory.max = 8G,  memory.min = 3G, memory.high = 7G)
    ├── worker     (memory.max = 6G,  memory.min = 2G, memory.high = 5G)
    └── sidecar    (memory.max = 2G,  memory.min = 1G)
```

### Enforcing limits from this hierarchy

```
system.slice:   effective max = 12G
myapp.service:  effective max = min(8G, 12G)  = 8G
worker:         effective max = min(6G, 8G)   = 6G
sidecar:        effective max = min(2G, 8G)   = 2G
```

If `worker` uses 6G and `sidecar` tries to allocate 3G, `sidecar` will be throttled at its own 2G `memory.max`, not at the parent level. But if `worker` uses 6G and `sidecar` uses 2G (8G total), `myapp.service` has no more headroom — any further allocation from either child triggers reclaim at the `myapp.service` level.

### Protection distribution from this hierarchy

```
myapp.service:  memory.min = 3G
  worker:       memory.min = 2G
  sidecar:      memory.min = 1G
  sum = 3G = parent protection, so each child gets its full value
```

If the sum equaled the parent exactly, no proportional scaling is needed. Now suppose sidecar is given `memory.min = 2G`:

```
  worker:  memory.min = 2G
  sidecar: memory.min = 2G
  sum = 4G > parent (3G)
  worker  effective protection = 3G × (2G/4G) = 1.5G
  sidecar effective protection = 3G × (2G/4G) = 1.5G
```

### What happens when a child exceeds its limit but the parent has headroom

The parent having headroom does not prevent a child's `memory.max` from triggering. A child at its own limit is throttled or OOM-killed even if the parent still has free capacity. The cgroup hierarchy enforces limits at every level independently — a child cannot "borrow" from the parent's unused headroom.

```
myapp.service: usage = 3G, max = 8G    ← still 5G available
└── worker:    usage = 5.9G, max = 6G  ← worker at its own limit

A worker allocation that pushes usage to 6.1G will trigger
worker's OOM killer, even though myapp.service has 5G free.
```

To allow a child to use the parent's headroom, either raise the child's limit or remove it entirely (set `memory.max = max`).

## Local vs Hierarchical Counters in memory.stat

`memory.stat` reports two categories of counters: **local** (charged to this cgroup only) and **hierarchical** (charged to this cgroup and all descendants).

```bash
cat /sys/fs/cgroup/myapp.service/memory.stat
```

Fields in `memory.stat` labeled with no prefix are **local** to that cgroup. Fields prefixed in the kernel's accounting code as "hierarchical" represent the sum of the cgroup and all descendants. In cgroup v2, `memory.current` always reflects the hierarchical total — it is the sum of memory charged to the cgroup and all children.

To see only a cgroup's own memory (excluding children), subtract each child's `memory.current` from the parent's:

```bash
# Hierarchical total
cat /sys/fs/cgroup/myapp.service/memory.current
# 3145728000

# Subtract children to get myapp.service's own usage
parent=$(cat /sys/fs/cgroup/myapp.service/memory.current)
worker=$(cat /sys/fs/cgroup/myapp.service/worker/memory.current)
sidecar=$(cat /sys/fs/cgroup/myapp.service/sidecar/memory.current)
echo $((parent - worker - sidecar))  # local usage only
```

The `memory.stat` file itself contains key fields whose scope is always the hierarchical subtree in cgroup v2. The documentation in [`Documentation/admin-guide/cgroup-v2.rst`](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files) notes that `memory.stat` values "account for the entire subtree."

### Key memory.stat fields and their meaning

```bash
cat /sys/fs/cgroup/myapp.service/worker/memory.stat

anon 1073741824          # anonymous pages: heap, stack, mmap(MAP_ANONYMOUS)
file 209715200           # file-backed pages: page cache
kernel 12582912          # kernel memory: slab, stacks, pagetables
slab 8388608             #   kernel slab allocations (subset of kernel)
sock 4194304             # socket receive/send buffers
shmem 0                  # shared memory (tmpfs, IPC shm)
file_mapped 104857600    # file pages that are mapped (subset of file)
file_dirty 0             # file pages with pending writes
file_writeback 0         # file pages currently being written
inactive_anon 0          # anonymous pages on the inactive LRU
active_anon 1073741824   # anonymous pages on the active LRU
inactive_file 104857600  # file pages on the inactive LRU (reclaim candidates)
active_file 104857600    # file pages on the active LRU
unevictable 0            # pages that cannot be reclaimed (mlock'd, etc.)
pgfault 458923           # total page faults
pgmajfault 12            # major faults (required disk I/O)
pgrefill 1024            # pages scanned during active→inactive aging
pgscan 2048              # pages scanned during reclaim
pgsteal 1536             # pages actually reclaimed
pgactivate 512           # pages moved from inactive to active
workingset_refault_anon 0    # anonymous pages re-faulted after reclaim
workingset_refault_file 64   # file pages re-faulted after reclaim
```

## Watching Hierarchical Limits with memory.events

Each cgroup has a `memory.events` file. In cgroup v2, there is also `memory.events.local` for events attributed only to that cgroup (not its children).

```bash
# Events attributed to myapp.service and all its children
cat /sys/fs/cgroup/myapp.service/memory.events
# low 0        <- times a child's memory dropped below memory.low
# high 45      <- times memory.high was exceeded (this cgroup or any child)
# max 3        <- times memory.max was hit
# oom 1        <- OOM events
# oom_kill 1   <- processes killed by OOM
# oom_group_kill 0

# Events attributed only to myapp.service's own processes
cat /sys/fs/cgroup/myapp.service/memory.events.local
# (same format, but only counts events in this cgroup's own page charges)
```

`memory.events.local` was introduced alongside the hierarchical event propagation model. See [`Documentation/admin-guide/cgroup-v2.rst`](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files) for the full field list.

## Setting Up a Three-Level Hierarchy

```bash
# Create the hierarchy
sudo mkdir -p /sys/fs/cgroup/myapp.service/worker
sudo mkdir -p /sys/fs/cgroup/myapp.service/sidecar

# Enable memory controller at each level
echo "+memory" | sudo tee /sys/fs/cgroup/cgroup.subtree_control
echo "+memory" | sudo tee /sys/fs/cgroup/myapp.service/cgroup.subtree_control

# Set limits and protections
echo 8G  | sudo tee /sys/fs/cgroup/myapp.service/memory.max
echo 7G  | sudo tee /sys/fs/cgroup/myapp.service/memory.high
echo 3G  | sudo tee /sys/fs/cgroup/myapp.service/memory.min

echo 6G  | sudo tee /sys/fs/cgroup/myapp.service/worker/memory.max
echo 5G  | sudo tee /sys/fs/cgroup/myapp.service/worker/memory.high
echo 2G  | sudo tee /sys/fs/cgroup/myapp.service/worker/memory.min

echo 2G  | sudo tee /sys/fs/cgroup/myapp.service/sidecar/memory.max
echo 1G  | sudo tee /sys/fs/cgroup/myapp.service/sidecar/memory.min

# Verify effective limits by reading back settings
for cg in myapp.service myapp.service/worker myapp.service/sidecar; do
    echo "=== $cg ==="
    echo "max:  $(cat /sys/fs/cgroup/$cg/memory.max)"
    echo "high: $(cat /sys/fs/cgroup/$cg/memory.high)"
    echo "min:  $(cat /sys/fs/cgroup/$cg/memory.min)"
    echo "cur:  $(cat /sys/fs/cgroup/$cg/memory.current)"
done
```

## Common Mistakes

### Setting child protections larger than the parent

```
parent: memory.min = 1G
├── child-a: memory.min = 600M
└── child-b: memory.min = 600M
sum = 1.2G > 1G
```

This is allowed, but each child's effective protection is scaled down to 500M. The kernel will not warn you. Audit child protections relative to parent protections to ensure your guarantees are real.

### Assuming parent headroom is available to children

A child cgroup that has been given `memory.max = 1G` will be OOM-killed at 1G even if its parent cgroup has 10G of free capacity. The limit is per-cgroup, not "available within parent."

### Forgetting that memory.current is hierarchical

If a parent cgroup's `memory.current` equals its `memory.max`, the parent is at its limit even if no individual child is at its limit. The combined usage of all children has reached the parent's cap.

## Key Source Files

| File | Relevant functions |
|------|--------------------|
| [`mm/memcontrol.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c) | `mem_cgroup_protected()` — computes effective protection; `mem_cgroup_margin()` — headroom to limit; `try_charge()` — charge + limit enforcement path |
| [`include/linux/memcontrol.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/memcontrol.h) | `struct mem_cgroup`, `mem_cgroup_protection()` inline |
| [`Documentation/admin-guide/cgroup-v2.rst`](https://docs.kernel.org/admin-guide/cgroup-v2.html) | Authoritative description of the distribution model |

## History

### cgroup v2 Memory Controller (v4.5, 2016)

The cgroup v2 memory controller, including the hierarchical protection model, was declared production-ready in v4.5 ([commit 67e9c74b8a87](https://git.kernel.org/linus/67e9c74b8a87)). The proportional protection model replaced the simpler v1 approach and was specifically designed for multi-tenant workloads. See [LWN: The unified cgroup hierarchy](https://lwn.net/Articles/679786/).

### memory.low and memory.min (v4.18, 2018)

`memory.low` (best-effort protection) and `memory.min` (hard protection) were introduced as part of the memory protection model described in [LWN: Putting cgroup memory protection back together](https://lwn.net/Articles/762472/). The `mem_cgroup_protected()` function implementing the proportional distribution calculation was developed by Tejun Heo and Roman Gushchin.

### memory.events.local

`memory.events.local` was added to distinguish per-cgroup events from hierarchical events, allowing operators to determine whether a parent cgroup's OOM event was caused by a child or its own processes. See [`Documentation/admin-guide/cgroup-v2.rst`](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files) for the version it was introduced.

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/memcontrol.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c) | Memory controller: limit enforcement, protection calculation |
| [`include/linux/memcontrol.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/memcontrol.h) | memcg struct and API |

### Kernel Documentation

- [`Documentation/admin-guide/cgroup-v2.rst`](https://docs.kernel.org/admin-guide/cgroup-v2.html) — authoritative cgroup v2 reference, including the protection distribution model

### LWN Articles

- [The unified cgroup hierarchy](https://lwn.net/Articles/679786/) — cgroup v2 reaching production readiness
- [Putting cgroup memory protection back together](https://lwn.net/Articles/762472/) — memory.low and memory.min design

### Related

- [Memory Cgroups](memcg.md) — memcg fundamentals and v1 vs v2
- [Tuning memory for containers](tuning-containers.md) — practical limit-setting guide
- [memory.stat reference](memory-stat.md) — all memory.stat fields explained
