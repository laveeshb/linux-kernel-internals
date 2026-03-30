# Tuning Memory for Containers

> Getting container memory limits right -- and debugging when they're wrong

## Why Container Memory Is Different

On a bare-metal server, all processes share a single pool of memory managed by the kernel. Containers change this model fundamentally: each container gets its own memory boundary enforced by the kernel's **cgroup memory controller**. Understanding how that controller works is the difference between a stable production deployment and mysterious OOM kills at 3 AM.

This page focuses on **cgroup v2**, which is the [recommended cgroup version](https://lwn.net/Articles/679786/) for all new deployments (declared production-ready in kernel v4.5). If you're still on cgroup v1, the concepts are similar but the interface files differ. See [Memory Cgroups](memcg.md) for v1 vs v2 differences.

## The Four Memory Knobs

The cgroup v2 memory controller exposes four files that control how much memory a group of processes can use. They form a hierarchy from hard enforcement to soft protection:

```
                    memory.max      <- Hard ceiling. Exceed this and die.
                        |
                    memory.high     <- Soft ceiling. Exceed this and get throttled.
                        |
                        |  (normal operation zone)
                        |
                    memory.low      <- Soft floor. Protected from reclaim (best-effort).
                        |
                    memory.min      <- Hard floor. Absolutely protected from reclaim.
```

| File | Type | What Happens | Default |
|------|------|-------------|---------|
| [`memory.max`](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files) | Hard limit | OOM killer invoked when exceeded | `max` (no limit) |
| [`memory.high`](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files) | Soft limit | Processes throttled, aggressive reclaim | `max` (no limit) |
| [`memory.low`](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files) | Soft protection | Memory below this is protected from reclaim (best-effort) | `0` |
| [`memory.min`](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files) | Hard protection | Memory below this is never reclaimed | `0` |

### memory.max: The Hard Limit

When a cgroup's memory usage reaches `memory.max`, the kernel tries reclaim within that cgroup. If reclaim fails to free enough memory, the cgroup OOM killer is invoked and a process within the cgroup is killed. The host system is unaffected -- this is a cgroup-scoped OOM, not a global one.

```bash
# Set a 1GB hard limit
echo 1G > /sys/fs/cgroup/mycontainer/memory.max
```

This is the wall your container cannot climb over. It exists to prevent a single container from starving the rest of the system.

### memory.high: The Soft Limit

`memory.high` is more nuanced. When usage exceeds this threshold, the kernel does not kill anything. Instead, it aggressively reclaims memory from the cgroup and **throttles** allocating processes -- they're put to sleep until the reclaim frees enough pages.

```bash
# Throttle at 800MB, kill at 1GB
echo 800M > /sys/fs/cgroup/mycontainer/memory.high
echo 1G > /sys/fs/cgroup/mycontainer/memory.max
```

Why have both? Because `memory.high` creates back-pressure. Instead of running at full speed until you hit a wall and die, your application slows down gradually. This gives monitoring time to detect the problem and is far gentler than an OOM kill.

!!! tip "Think of it like a speed limit vs a cliff"
    `memory.high` is a speed limit sign -- you slow down when you hit it. `memory.max` is the edge of a cliff -- you go over it and you're dead.

### memory.low and memory.min: Protection Guarantees

These knobs work in the opposite direction. Instead of limiting how much memory a cgroup can use, they guarantee how much it gets to keep during system-wide memory pressure.

- **`memory.low`**: Best-effort protection. Memory below this threshold won't be reclaimed unless there is no other reclaimable memory anywhere in the system. Think of it as "please don't take this memory unless you absolutely have to."

- **`memory.min`**: Hard protection. Memory below this threshold is never reclaimed, period. Even under extreme pressure, the kernel will OOM-kill other things rather than reclaim this cgroup's protected memory.

```bash
# Guarantee the database container keeps at least 2GB
echo 2G > /sys/fs/cgroup/database/memory.min

# Prefer to keep 4GB if possible
echo 4G > /sys/fs/cgroup/database/memory.low
```

**Protection is hierarchical**: the effective protection for a child cgroup is limited by its parent's protection. If a parent has `memory.min` of 4GB, the sum of children's `memory.min` values can exceed 4GB, but the effective protection is distributed proportionally up to the parent's 4GB. This is documented in the [cgroup v2 distribution model](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files).

```
parent (memory.min: 4GB)
├── child-a (memory.min: 3GB)  <- effective: ~2.4GB (3/5 of 4GB)
├── child-b (memory.min: 2GB)  <- effective: ~1.6GB (2/5 of 4GB)
```

## Why Containers See Wrong Memory Numbers

Run `free` inside a typical container and you'll see the **host's** total memory, not the container's limit:

```bash
# Inside a container with 1GB limit
$ free -h
              total        used        free
Mem:           62Gi        45Gi        17Gi    # <- This is the HOST's memory!
```

This happens because `/proc/meminfo` is a global file that reports system-wide memory. The container's cgroup limit exists only in the cgroup filesystem, not in `/proc`. Many applications (especially JVMs, databases, and language runtimes) read `/proc/meminfo` to auto-tune themselves. When they see 62GB of total memory instead of 1GB, they allocate far too much and get OOM-killed.

### The Solutions

**LXCFS**: A FUSE filesystem that intercepts reads to `/proc/meminfo`, `/proc/cpuinfo`, and other files, returning cgroup-aware values instead. [LXCFS](https://linuxcontainers.org/lxcfs/) mounts over `/proc` inside the container so existing tools work without modification.

**Runtime-specific flags**: Many runtimes now detect cgroup limits natively:

```bash
# Java 10+ automatically detects cgroup limits
java -XX:+UseContainerSupport -jar app.jar

# Java 8u191+ also supports it
java -XX:+UnlockExperimentalVMOptions -XX:+UseCGroupMemoryLimitForHeap -jar app.jar
```

**cgroup-aware tools**: Modern versions of `systemd-cgtop`, `cadvisor`, and `kubectl top` read from the cgroup filesystem directly rather than `/proc/meminfo`.

## Common Problems

### Container OOM When Host Has Free Memory

This is the most frequently misdiagnosed container problem. The host shows 17GB free, but your container just got killed.

The cause is simple: the container hit its **cgroup memory limit** (`memory.max`), which triggered a cgroup-scoped OOM kill. Global free memory is irrelevant -- the cgroup has its own accounting.

```bash
# Confirm the cgroup limit was hit
cat /sys/fs/cgroup/mycontainer/memory.events
# oom 3          <- OOM was triggered 3 times
# oom_kill 3     <- 3 processes were killed
# max 47         <- memory.max was hit 47 times
```

**Fixes**:

- Increase `memory.max` if the limit is too low
- Add `memory.high` below `memory.max` to create back-pressure before the OOM
- Optimize the application's memory usage
- Allow swap with `memory.swap.max` to give a buffer

### Page Cache Counting Against the Limit

In cgroup v2, **page cache is charged to the cgroup that read the file**. This catches many people off guard. A container that reads large files will have its page cache counted against its memory limit, even though the kernel can reclaim that cache at any time.

```bash
# Check how much is cache vs anonymous memory
cat /sys/fs/cgroup/mycontainer/memory.stat | grep -E '^(anon|file) '
# anon 524288000     <- actual working memory
# file 209715200     <- page cache (reclaimable)
```

The cache is reclaimable, so it won't cause OOM by itself. But it does cause `memory.high` throttling if the combined usage exceeds the soft limit. If this is a problem, size `memory.high` with page cache headroom in mind.

### Slow Container Start Under Memory Pressure

If a container starts slowly, it might be because `memory.high` is set too close to actual usage. Every allocation triggers reclaim and throttling. Check `memory.pressure` to confirm:

```bash
cat /sys/fs/cgroup/mycontainer/memory.pressure
# some avg10=45.00 avg60=30.00 avg300=12.00 total=890234
# full avg10=20.00 avg60=10.00 avg300=5.00 total=234567
```

If these numbers are high, your container is spending significant time waiting for memory.

## Kubernetes: Requests vs Limits

Kubernetes exposes two memory settings per container, and they map directly to cgroup knobs:

| Kubernetes | cgroup v2 | Behavior |
|-----------|-----------|----------|
| `resources.limits.memory` | `memory.max` | Hard limit. Container is OOM-killed if exceeded. |
| `resources.requests.memory` | `memory.min` (requires MemoryQoS feature gate) | Scheduling guarantee. Used for QoS classification; `memory.min` mapping requires the alpha [MemoryQoS feature gate](https://kubernetes.io/docs/tasks/configure-pod-container/quality-service-pod/) (k/enhancements#2570). |

```yaml
# Pod spec
resources:
  requests:
    memory: "512Mi"   # Schedule on a node with 512Mi available; protect this amount
  limits:
    memory: "1Gi"     # Hard ceiling; OOM kill above this
```

### How QoS Classes Affect Memory

Kubernetes assigns Quality of Service classes based on requests and limits:

- **Guaranteed** (requests == limits): Container gets exactly what it asks for. With MemoryQoS enabled, the kubelet sets `memory.min` equal to the limit, providing hard protection.
- **Burstable** (requests < limits): Container can use more than requested, up to its limit. With MemoryQoS enabled, gets `memory.min` set to the request value.
- **BestEffort** (no requests or limits): No cgroup memory limit is set. First to be killed under node pressure.

!!! note "MemoryQoS feature gate"
    The `memory.min` mapping described above requires the `MemoryQoS` feature gate, which was alpha in Kubernetes 1.22+ and is not enabled by default. In standard Kubernetes deployments, `resources.requests.memory` influences scheduling and QoS class only — it does not set `memory.min` in the cgroup.

```
Node (16GB)
├── Guaranteed pod (memory.min=1G, memory.max=1G)  <- always safe
├── Burstable pod  (memory.min=512M, memory.max=2G) <- protected up to 512M
└── BestEffort pod (no limits)                       <- first to die
```

!!! warning "Set requests even if you don't set limits"
    Without a `requests.memory`, your pod is BestEffort class and will be the first to be evicted when the node runs low on memory. Always set at least requests.

## Docker: --memory and --memory-reservation

Docker exposes container memory settings through command-line flags:

| Docker Flag | cgroup v2 | Behavior |
|------------|-----------|----------|
| `--memory` (or `-m`) | `memory.max` | Hard limit. OOM kill if exceeded. |
| `--memory-reservation` | `memory.low` | Soft protection under system pressure. |
| `--memory-swap` | `memory.swap.max` + `memory.max` | Total memory + swap limit. |
| `--oom-kill-disable` | Disables OOM killer | **Dangerous**: can hang the container and host. |

```bash
# Run a container with 1GB limit and 750MB reservation
docker run -d \
  --memory=1g \
  --memory-reservation=750m \
  --name myapp myimage

# Equivalent cgroup settings:
# memory.max = 1073741824
# memory.low = 786432000
```

!!! warning "Docker --memory-swap semantics"
    `--memory-swap` sets the **combined** memory + swap limit, not just swap. So `--memory=1g --memory-swap=2g` means 1GB RAM + 1GB swap. Set `--memory-swap=-1` for unlimited swap.

## Monitoring Container Memory

### Key Files

```bash
CGROUP=/sys/fs/cgroup/mycontainer

# Current usage (bytes)
cat $CGROUP/memory.current
# 734003200

# Peak usage (useful for sizing)
cat $CGROUP/memory.peak       # v5.19+
# 891289600

# Detailed breakdown
cat $CGROUP/memory.stat
# anon 524288000              # heap, stack, anonymous mmap
# file 209715200              # page cache
# slab 12582912               # kernel slab objects
# sock 4194304                # socket buffers
# shmem 0                     # shared memory (tmpfs)
# pgfault 1234567             # page faults
# pgmajfault 42               # major faults (disk I/O)

# Events (problems that happened)
cat $CGROUP/memory.events
# low 0                       # times memory.low was breached
# high 152                    # times memory.high was exceeded
# max 3                       # times memory.max was hit
# oom 1                       # OOM events
# oom_kill 1                  # processes OOM-killed
# oom_group_kill 0            # group OOM kills
```

### Pressure Stall Information (PSI)

PSI gives you the most actionable signal about whether a container is memory-constrained:

```bash
cat $CGROUP/memory.pressure
# some avg10=2.50 avg60=1.00 avg300=0.50 total=45678
# full avg10=0.00 avg60=0.00 avg300=0.00 total=1234
```

- **some**: Percentage of time that at least one task in the cgroup was stalled waiting for memory. If this is consistently above zero, the container is under pressure.
- **full**: Percentage of time that all tasks were stalled. If this is above zero, the container is completely blocked on memory.

PSI was introduced as a cgroup-level feature in [v4.20](https://lwn.net/Articles/759658/) and is the foundation of Meta's [oomd](https://facebookincubator.github.io/oomd/) userspace OOM daemon, which uses PSI to proactively kill workloads before the kernel OOM killer fires.

```bash
# Set up a PSI trigger to get notified when pressure exceeds a threshold
# (useful for building auto-scaling)
echo "some 50000 1000000" > $CGROUP/memory.pressure
# Trigger when "some" exceeds 50ms per 1s window
```

## Swap in Containers

By default in cgroup v2, swap is allowed up to whatever the system provides. You can control this per-cgroup:

```bash
# Disable swap entirely for this container
echo 0 > /sys/fs/cgroup/mycontainer/memory.swap.max

# Allow up to 500MB of swap
echo 500M > /sys/fs/cgroup/mycontainer/memory.swap.max

# Check current swap usage
cat /sys/fs/cgroup/mycontainer/memory.swap.current
```

### Why Allow Swap in Containers?

The conventional wisdom of "disable swap for containers" comes from cgroup v1 where swap accounting was expensive and unreliable. In cgroup v2, swap accounting is efficient and well-integrated.

Swap provides a buffer between "memory.high throttling" and "memory.max OOM kill". Without swap, a sudden spike in memory usage goes directly to OOM. With swap, the spike gets absorbed into swap, giving you time to detect and react.

### memory.zswap.max (v6.5+)

[zswap](https://docs.kernel.org/admin-guide/mm/zswap.html) compresses pages in memory before writing them to swap. The `memory.zswap.max` file limits how much compressed data a cgroup can store in the zswap pool:

```bash
# Limit zswap usage to 200MB for this cgroup
echo 200M > /sys/fs/cgroup/mycontainer/memory.zswap.max

# Check zswap usage
cat /sys/fs/cgroup/mycontainer/memory.zswap.current
```

This prevents a single container from filling the entire zswap pool and forcing other containers' pages to be written to slow disk swap. The per-cgroup zswap limit was introduced in [commit f4840ccfca25](https://git.kernel.org/linus/f4840ccfca25) ("zswap: memcg accounting").

## Best Practices

### Sizing Limits

1. **Profile first**: Run your application under realistic load and observe `memory.peak` (or `memory.max_usage_in_bytes` on v1). Set `memory.max` to 1.25-1.5x the observed peak.

2. **Set memory.high below memory.max**: A gap of 10-20% between `memory.high` and `memory.max` gives the kernel room to throttle and reclaim before killing.

    ```bash
    # If your app peaks at 800MB:
    echo 1200M > /sys/fs/cgroup/mycontainer/memory.max   # 1.5x peak
    echo 1000M > /sys/fs/cgroup/mycontainer/memory.high  # throttle zone
    ```

3. **Account for page cache**: If your workload is I/O-heavy, add headroom for page cache. Check `memory.stat`'s `file` field under load.

4. **Use memory.low for critical services**: If a container must not be reclaimed (e.g., database buffer pool), set `memory.low` or `memory.min`.

### Handling OOM Gracefully

**Use `memory.oom.group`** ([commit 3d8b38eb81ca](https://git.kernel.org/linus/3d8b38eb81ca), "mm, oom: introduce memory.oom.group"): When a container OOM occurs, the default behavior kills a single process. For multi-process containers (e.g., a web server with workers), killing one process often leaves the container in a broken state. `memory.oom.group` kills all processes in the cgroup together, ensuring a clean restart.

```bash
# Kill all processes in the cgroup on OOM (v4.19+)
echo 1 > /sys/fs/cgroup/mycontainer/memory.oom.group
```

**Use systemd or container runtime restart policies**: Since OOM is not always preventable, make sure your container can restart cleanly.

```bash
# Docker: always restart on OOM
docker run --restart=always --memory=1g myimage

# Kubernetes: the default restartPolicy is Always
```

**Monitor `memory.events`**: Set up alerts on the `oom` and `oom_kill` counters. An increasing count means the limit is too low or the application has a leak.

### A Complete Production Setup

```bash
CGROUP=/sys/fs/cgroup/mycontainer

# Hard limit: 1.5x observed peak
echo 1500M > $CGROUP/memory.max

# Throttle before OOM
echo 1200M > $CGROUP/memory.high

# Protect critical working set
echo 500M > $CGROUP/memory.min

# Allow some swap as buffer
echo 512M > $CGROUP/memory.swap.max

# Kill all processes together on OOM
echo 1 > $CGROUP/memory.oom.group
```

## Try It Yourself

### Observe memory.high Throttling

```bash
# Create a cgroup with a low soft limit
sudo mkdir -p /sys/fs/cgroup/throttle-test
echo "+memory" | sudo tee /sys/fs/cgroup/cgroup.subtree_control
echo 50M | sudo tee /sys/fs/cgroup/throttle-test/memory.high
echo 100M | sudo tee /sys/fs/cgroup/throttle-test/memory.max

# Run a process that slowly allocates memory
echo $$ | sudo tee /sys/fs/cgroup/throttle-test/cgroup.procs
python3 -c "
import time
chunks = []
for i in range(80):
    chunks.append(b'x' * 1_000_000)  # 1MB per iteration
    print(f'Allocated {i+1}MB')
    time.sleep(0.1)
"
# Notice it slows down dramatically around 50MB (memory.high)
# and gets killed around 100MB (memory.max)
```

### Compare memory.low Protection

```bash
# Create parent and two children
sudo mkdir -p /sys/fs/cgroup/parent
echo "+memory" | sudo tee /sys/fs/cgroup/cgroup.subtree_control
echo 200M | sudo tee /sys/fs/cgroup/parent/memory.max
echo "+memory" | sudo tee /sys/fs/cgroup/parent/cgroup.subtree_control

sudo mkdir /sys/fs/cgroup/parent/protected
sudo mkdir /sys/fs/cgroup/parent/unprotected

# Protect one child
echo 100M | sudo tee /sys/fs/cgroup/parent/protected/memory.low

# Allocate memory in both, then observe which one gets reclaimed
# when the parent approaches its 200M limit
```

### Monitor a Docker Container's Memory

```bash
# Start a container
docker run -d --name memtest --memory=256m nginx

# Find its cgroup path
CGPATH=$(docker inspect memtest --format '{{.HostConfig.CgroupParent}}')
# Or on systemd-based systems:
PID=$(docker inspect memtest --format '{{.State.Pid}}')
CGROUP=$(cat /proc/$PID/cgroup | grep -o '/.*')

# Watch memory in real-time
watch -n 1 "echo '--- usage ---' && \
  cat /sys/fs/cgroup${CGROUP}/memory.current && \
  echo '--- pressure ---' && \
  cat /sys/fs/cgroup${CGROUP}/memory.pressure && \
  echo '--- events ---' && \
  cat /sys/fs/cgroup${CGROUP}/memory.events"

# Cleanup
docker rm -f memtest
```

## History

### memory.high Throttling (v4.0+, stable in v4.5)

**Author**: Johannes Weiner

The `memory.high` knob was added as part of the cgroup v2 memory controller in v4.0 ([commit 241994ed8649](https://git.kernel.org/linus/241994ed8649)), but cgroup v2 was experimental until v4.5 when it was [declared production-ready](https://lwn.net/Articles/679786/). The soft-limit throttling model — where processes are slowed down instead of killed — made container memory management much more predictable.

### memory.oom.group (v4.19, 2018)

**Commit**: [3d8b38eb81ca](https://git.kernel.org/linus/3d8b38eb81ca) ("mm, oom: introduce memory.oom.group")

**Author**: Roman Gushchin

Allowed killing all processes in a cgroup together on OOM, which is essential for container-based deployments where partial kills leave broken state.

### Per-cgroup PSI (v4.20, 2018)

**Commit**: [eb414681d5a0](https://git.kernel.org/linus/eb414681d5a0) ("psi: pressure stall information for CPU, memory, and IO") | [LWN](https://lwn.net/Articles/759658/)

**Author**: Johannes Weiner

Enabled fine-grained pressure monitoring per cgroup, replacing the crude `memory.failcnt` counter from v1.

### memory.reclaim (v5.19, 2022)

**Commit**: [94968384dde1](https://git.kernel.org/linus/94968384dde1) ("memcg: introduce per-memcg reclaim interface") | [LWN](https://lwn.net/Articles/894849/)

**Authors**: Shakeel Butt (original author, Google) and Yosry Ahmed (Google, drove subsequent revisions)

Proactive reclaim: allows userspace to trigger reclaim within a cgroup without waiting for memory pressure. Used by Meta and Google for pre-emptive memory management.

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/memcontrol.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memcontrol.c) | Memory controller implementation |
| [`mm/vmpressure.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmpressure.c) | Memory pressure notifications |
| [`kernel/sched/psi.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/psi.c) | Pressure Stall Information |

### Kernel Documentation

- [`Documentation/admin-guide/cgroup-v2.rst`](https://docs.kernel.org/admin-guide/cgroup-v2.html) - Authoritative cgroup v2 reference
- [`Documentation/admin-guide/mm/zswap.rst`](https://docs.kernel.org/admin-guide/mm/zswap.html) - zswap documentation

### LWN Articles

- [Controlling memory with cgroup v2](https://lwn.net/Articles/662925/) - memory.high design and motivation
- [PSI - Pressure Stall Information](https://lwn.net/Articles/759658/) - per-cgroup pressure tracking
- [User-space OOM handling](https://lwn.net/Articles/894849/) - memory.reclaim and proactive management
- [The unified cgroup hierarchy](https://lwn.net/Articles/679786/) - cgroup v2 reaching production readiness

### Related

- [Memory Cgroups](memcg.md) - Detailed memcg internals and v1 vs v2
- [Running out of memory](oom.md) - The global OOM kill path
- [Page Reclaim](reclaim.md) - How the kernel reclaims memory
- [Swap](swap.md) - Swap subsystem internals
- [Glossary](glossary.md) - cgroup, OOM, PSI definitions
