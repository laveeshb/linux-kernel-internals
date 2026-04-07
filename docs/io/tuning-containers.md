# Tuning I/O for Containers

> cgroup I/O isolation, throttling, and per-container storage tuning in Linux

## The container I/O problem

Containers share a host kernel and its storage devices. Without I/O isolation, a single container doing a bulk write or read can saturate the device and cause latency spikes for all other containers on the same host — the "noisy neighbor" problem.

```
Without I/O isolation:
┌──────────────────────────────────────────────┐
│                   Host                        │
│  Container A  Container B  Container C       │
│  (bulk write) (web server) (database)        │
│      ↓              ↓           ↓            │
│  ████████████████████████████████████        │
│         /dev/nvme0n1  (shared device)        │
└──────────────────────────────────────────────┘
  Container A saturates the device; B and C starve.

With cgroup v2 I/O isolation:
┌──────────────────────────────────────────────┐
│                   Host                        │
│  Container A  Container B  Container C       │
│  max: 100MB/s  weight: 200  weight: 500      │
│      ↓              ↓           ↓            │
│  ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░       │
│         /dev/nvme0n1  (isolated queues)      │
└──────────────────────────────────────────────┘
  Container A is capped; B and C get fair shares.
```

Linux provides I/O isolation through the **cgroup v2 `io` controller**, which implements both:
- **Throttling**: hard limits on IOPS and bandwidth per device
- **Scheduling**: weight-based fair sharing via BFQ or Kyber schedulers

---

## cgroup v2 I/O controller basics

The `io` controller is available in cgroup v2 (`/sys/fs/cgroup/` on modern systems).

```bash
# Check if cgroup v2 is active
mount | grep cgroup2
# cgroup2 on /sys/fs/cgroup type cgroup2 ...

# Enable the io controller for a cgroup
echo "+io" > /sys/fs/cgroup/mygroup/cgroup.subtree_control

# Find the device major:minor
ls -l /dev/nvme0n1   # e.g.: 259:0

# Set hard throttle limits: read/write IOPS and bandwidth
echo "259:0 rbps=104857600 wbps=52428800" > /sys/fs/cgroup/mygroup/io.max
#                ↑100MB/s read   ↑50MB/s write

# Set weight for proportional sharing (1-10000, default 100)
echo "259:0 weight=500" > /sys/fs/cgroup/mygroup/io.weight
```

**Available `io.max` fields:**

| Field | Meaning |
|-------|---------|
| `rbps` | Read bytes per second |
| `wbps` | Write bytes per second |
| `riops` | Read operations per second |
| `wiops` | Write operations per second |
| `max` | Keyword: no limit (default) |

```bash
# Example: limit a batch container to 50MB/s reads, 25MB/s writes, 1000 read IOPS
echo "259:0 rbps=52428800 wbps=26214400 riops=1000" > /sys/fs/cgroup/batch/io.max

# Read current stats
cat /sys/fs/cgroup/mygroup/io.stat
# 259:0 rbytes=1073741824 wbytes=524288000 rios=262144 wios=131072
#       dbytes=0 dios=0  wait_time=1234567 io_ticks=98765
```

**`io.stat` fields:**

| Field | Meaning |
|-------|---------|
| `rbytes` / `wbytes` | Total bytes read/written |
| `rios` / `wios` | Total read/write operations |
| `dbytes` / `dios` | Discards (TRIM) |
| `wait_time` | Total time tasks spent waiting for I/O (microseconds) |
| `io_ticks` | Time the device was busy servicing this cgroup's I/Os |

---

## Docker and container runtime integration

Container runtimes translate `--blkio-*` flags and resource spec fields into cgroup `io.*` writes.

**Docker:**

```bash
# Hard limits (cgroup v2 io.max)
docker run \
  --device-read-bps /dev/nvme0n1:100mb \
  --device-write-bps /dev/nvme0n1:50mb \
  --device-read-iops /dev/nvme0n1:1000 \
  --device-write-iops /dev/nvme0n1:500 \
  myimage

# Weight (cgroup v2 io.weight) — relative priority
docker run --blkio-weight 200 myimage   # lower priority (default: 500)
docker run --blkio-weight 800 myimage   # higher priority
```

**Kubernetes `resources.requests`/`limits`:**

Kubernetes does not expose `blkio` directly in the pod spec (as of v1.30). Use:

1. **Node-level policies** via `kubelet --config` with `topologyManagerPolicy`
2. **Custom admission webhooks** that inject cgroup limits
3. **Direct cgroup configuration** on the node for specific pods

```bash
# Find the cgroup path for a Kubernetes pod
# The path is based on pod UID and container name
find /sys/fs/cgroup -name "io.max" -path "*/pod<uid>/*" 2>/dev/null

# Using crictl to get cgroup path
crictl inspect <container-id> | jq '.info.runtimeSpec.linux.cgroupsPath'
```

---

## Choosing between throttling and weighting

These are fundamentally different mechanisms:

| | **Throttling (`io.max`)** | **Weighting (`io.weight`)** |
|---|---|---|
| **Mechanism** | Hard rate limit: device refused I/Os above the cap | Proportional share: device time divided by weight |
| **Enforced at** | Block layer (before the device) | I/O scheduler (BFQ or Kyber) |
| **Effect when device is idle** | Container limited even if no one else is using the device | Container gets full device if others are idle |
| **Effect under contention** | All containers capped at their limits | Higher-weight containers get proportionally more |
| **Best for** | Isolation guarantees (SLA enforcement) | Fair sharing (cost optimization) |
| **Latency impact** | Can cause stalls when limit is reached | Lower latency for high-weight containers |

**Practical guidance:**

- Use **throttling** for batch jobs, backups, and analytics that should not impact production workloads regardless of what other containers are doing.
- Use **weighting** for production services that need priority over other services but should use spare capacity when available.
- **Combine both**: throttle batch containers to prevent worst-case impact, and weight production containers to ensure priority during contention.

```bash
# Combined approach: batch container gets at most 50MB/s, but yields to others
echo "259:0 rbps=52428800 wbps=26214400" > /sys/fs/cgroup/batch/io.max
echo "259:0 weight=50" > /sys/fs/cgroup/batch/io.weight

# Production database: no hard limit, but high priority
echo "259:0 weight=800" > /sys/fs/cgroup/database/io.weight
```

---

## I/O scheduler requirements for weighting

cgroup I/O **weighting only works with BFQ or Kyber schedulers**. The `none` (passthrough) scheduler does not enforce weights — all I/Os go directly to the device queue without cgroup accounting.

```bash
# Check current scheduler
cat /sys/block/nvme0n1/queue/scheduler

# For weighting to work, use BFQ:
echo bfq > /sys/block/nvme0n1/queue/scheduler

# Or Kyber (lighter-weight, good for NVMe):
echo kyber > /sys/block/nvme0n1/queue/scheduler

# Verify: cgroup io.weight is now enforced
# (Test by running two containers with different weights and measuring throughput)
```

!!! note "Performance trade-off"
    BFQ adds per-process queue tracking overhead compared to `none`. On high-IOPS NVMe devices, this overhead can be 5-15% of device throughput. If isolation is not needed (single-tenant hosts), `none` is faster.

---

## Overlayfs and container filesystem I/O

Docker and containerd use **overlayfs** by default. Container filesystem writes go through overlayfs layers before reaching the underlying block device, adding overhead.

```bash
# Check overlayfs usage
df -T | grep overlay
# overlay   overlay   500G   12G  488G   3% /var/lib/docker

# overlayfs write amplification: copy-on-write
# A write to a file in a lower layer triggers:
# 1. Copy the file to the upper (writable) layer
# 2. Write the modification to the upper layer copy
# For large files, this is expensive on first write.

# Check overlayfs stats (kernel 5.17+)
cat /proc/self/mountinfo | grep overlay
```

**Avoiding overlayfs overhead for database containers:**

```bash
# Mount a host volume directly into the container (bypasses overlayfs)
docker run -v /data/mysql:/var/lib/mysql mysql:8.0

# Or use a named volume with a specific driver
docker volume create --driver local \
  --opt type=xfs \
  --opt device=/dev/nvme1n1 \
  mysql-data
docker run -v mysql-data:/var/lib/mysql mysql:8.0
```

Direct volume mounts bypass overlayfs entirely. The container's writes go straight to the host block device, avoiding the copy-on-write cost. For database containers, this is almost always the right choice.

---

## Monitoring I/O per container

```bash
# Real-time I/O per container with cgroup stats
watch -n 1 '
for cg in /sys/fs/cgroup/system.slice/docker-*.scope; do
    name=$(basename $cg | sed "s/docker-//;s/.scope//;s/\(.\{12\}\).*/\1/")
    stats=$(cat $cg/io.stat 2>/dev/null | head -1)
    echo "$name: $stats"
done'

# Using docker stats (uses cgroup io.stat internally)
docker stats --format "table {{.Container}}\t{{.BlockIO}}"

# Per-container iotop equivalent using /proc
# (requires root for /proc/PID/io)
for pid in $(docker inspect --format='{{.State.Pid}}' $(docker ps -q)); do
    name=$(docker inspect --format='{{.Name}}' $(docker ps -q --filter pid=$pid) 2>/dev/null)
    io=$(cat /proc/$pid/io 2>/dev/null | grep -E '(read_bytes|write_bytes)' | awk '{print $2}')
    echo "$name: $io"
done
```

---

## Practical configurations

### Batch/analytics container (low priority, throttled)

```bash
# Create cgroup for batch jobs
mkdir /sys/fs/cgroup/batch

# Enable io controller
echo "+io" > /sys/fs/cgroup/batch/cgroup.subtree_control

# Hard limit: 100MB/s read, 50MB/s write, 500 IOPS read
echo "259:0 rbps=104857600 wbps=52428800 riops=500" > /sys/fs/cgroup/batch/io.max

# Low priority weight
echo "259:0 weight=50" > /sys/fs/cgroup/batch/io.weight
```

### Production database container (high priority, unlimited)

```bash
mkdir /sys/fs/cgroup/database
echo "+io" > /sys/fs/cgroup/database/cgroup.subtree_control

# No hard limit — use full device when available
# (io.max defaults to "max" — no throttling)

# High weight for priority under contention
echo "259:0 weight=500" > /sys/fs/cgroup/database/io.weight
```

### Web server container (medium priority, some limiting)

```bash
mkdir /sys/fs/cgroup/webserver
echo "+io" > /sys/fs/cgroup/webserver/cgroup.subtree_control

# Modest write limit to prevent log writes from saturating
echo "259:0 wbps=10485760" > /sys/fs/cgroup/webserver/io.max  # 10MB/s write cap

# Default weight (100)
```

---

## Related pages

- [io Controller (cgroups)](../cgroups/io-cgroup.md) — detailed io controller internals
- [Tuning Storage I/O](tuning-storage.md) — host-level sysctl tuning
- [Tuning I/O for Databases](tuning-databases.md) — database-specific I/O tuning
- [I/O Schedulers](../block/io-schedulers.md) — BFQ, Kyber, mq-deadline internals
- [Debugging Slow I/O](debugging-slow-io.md) — diagnosing I/O problems
