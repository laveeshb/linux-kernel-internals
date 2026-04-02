# Cgroup War Stories

> OOM kill storms, CPU throttling surprises, and cgroup v1 migration pain

These are five real categories of production incidents involving cgroups. The failure modes are subtle: cgroups enforce policy at the kernel level, and the interaction between the policy you set and the policy the kernel actually enforces is often not what you expect.

---

## 1. The CFS bandwidth thundering herd

**Setting**: A Kubernetes cluster with dozens of pods per node. Each pod had a CPU request/limit set in its spec, which the kubelet translated into `cpu.max` (CFS quota). The CFS period was the default: 100ms.

**What happened**: Every pod's CFS quota refills at the same instant — `t=0` of each 100ms period. Pods that were CPU-bound hit their quota, went to sleep, then became runnable again at `t=100ms`. All of them, simultaneously, on the same node. The scheduler's run queue spiked every 100ms with tens of runnable tasks all competing for CPU. Application-level request latency showed a sawtooth pattern with spikes at exactly 100ms intervals.

**The kernel mechanism**: CFS bandwidth control (`kernel/sched/fair.c`) manages per-cgroup quota using a per-period token bucket. When `cpu.max` is set to `200000 100000` (200ms of CPU per 100ms period = 2 CPUs), the cgroup gets 200ms of quota per period. When it is exhausted, the group is throttled. The `throttled_usec` counter in `cpu.stat` shows accumulated throttle time:

```bash
cat /sys/fs/cgroup/system.slice/myapp.service/cpu.stat
# usage_usec 4523190
# user_usec 3210456
# system_usec 1312734
# nr_periods 45231
# nr_throttled 12048          ← throttled in 12k out of 45k periods
# throttled_usec 1204800000   ← 1.2 seconds of accumulated throttle time
```

**Diagnosis**: The periodicity of the latency spikes was the key. `nr_throttled` / `nr_periods` gives the throttle ratio. A high ratio (> 5-10%) combined with latency spikes at exactly the period boundary is the CFS thundering herd.

**Fix**:

Option 1 — Increase the CFS period to reduce the frequency of synchronization. Changing from 100ms to 500ms:
```bash
# cpu.max format: quota period (both in microseconds)
echo "1000000 500000" > /sys/fs/cgroup/myapp/cpu.max   # 2 CPUs, 500ms period
```

Option 2 — Use `cpu.weight` (proportional shares) instead of `cpu.max` (hard quota). `cpu.weight` never throttles; it only reduces CPU share when the system is contended. For latency-sensitive workloads, proportional sharing is almost always better than hard quotas:
```bash
echo "200" > /sys/fs/cgroup/myapp/cpu.weight   # 2x default share
```

The Linux kernel 5.14 commit `(39f450ac4b06)` added `cpu.idle` to support SCHED_IDLE for background cgroups, which is another alternative for low-priority batch work.

---

## 2. The OOM kill loop

**Setting**: A containerized Java application running inside a cgroup with `memory.max=512M`. The container was managed by a supervisor process (also inside the cgroup) that restarted the JVM on exit.

**What happened**: The JVM gradually grew its heap to ~510M. A transient spike (GC unable to free enough memory, loading a large dataset) caused the cgroup to hit `memory.max`. The kernel's OOM killer invoked `out_of_memory()` → `oom_kill_process()`, which selected the JVM process as the largest `oom_score_adj`-weighted process and killed it. The supervisor restarted the JVM. The JVM grew back to 510M. The spike recurred. Killed again. This loop ran every ~30 seconds for six hours before anyone noticed — the container was never killed, only individual processes inside it, so Kubernetes never restarted the pod.

**The kernel mechanism**: When a cgroup exceeds `memory.max`, `try_charge_memcg()` calls `mem_cgroup_oom()` which invokes `mem_cgroup_out_of_memory()`. By default, the OOM killer selects the process with the highest `oom_score` within the cgroup (not the cgroup as a whole). If the container runtime has set `oom_score_adj` on only the container init process, the JVM (with default `oom_score_adj=0`) may be selected instead. The cgroup keeps running; the OOM event is visible in:

```bash
# OOM events per cgroup:
cat /sys/fs/cgroup/containers/c1/memory.events
# low 0
# high 0
# max 47            ← 47 times we hit memory.max
# oom 47            ← 47 OOM events
# oom_kill 47       ← 47 processes killed by OOM killer
# oom_group_kill 0  ← cgroup was never killed as a whole
```

**Diagnosis**: `memory.events` is the first place to look. `oom` > 0 means the cgroup has been OOM-killed. `oom_group_kill` = 0 means the whole cgroup (all processes) was never killed.

**Fix**:

Option 1 — Use `memory.high` as a soft ceiling. When memory usage exceeds `memory.high`, the kernel throttles allocation and triggers aggressive reclaim before reaching `memory.max`. The JVM gets CPU cycles back but is slowed down, giving the GC time to reclaim:
```bash
echo "400M" > /sys/fs/cgroup/containers/c1/memory.high   # soft limit
echo "512M" > /sys/fs/cgroup/containers/c1/memory.max    # hard limit
```

Option 2 — Enable `memory.oom.group`. When set to `1`, the OOM killer kills all processes in the cgroup (not just the largest one) on an OOM event. This ensures the supervisor is also killed, preventing the restart loop:
```bash
echo "1" > /sys/fs/cgroup/containers/c1/memory.oom.group
```

Option 3 — Increase `memory.max` to accommodate the spike, or configure the JVM's `-Xmx` to stay well below the cgroup limit.

---

## 3. The cgroup v1 to v2 migration surprise

**Setting**: A company migrated their container platform from Docker 19 on Ubuntu 20.04 (cgroup v1 hybrid mode) to containerd + runc on Ubuntu 22.04 (cgroup v2 only). Existing container images, monitoring agents, and scripts all ran fine in development — but production was broken.

**What happened**: Multiple classes of failures appeared simultaneously:

**Class 1 — Missing interface files**: Scripts that read memory usage from:
```
/sys/fs/cgroup/memory/<container-id>/memory.usage_in_bytes   ← v1
```
found that the path did not exist. On cgroup v2, the equivalent is:
```
/sys/fs/cgroup/<container-id>/memory.current   ← v2
```

**Class 2 — Missing swap accounting**: Cgroup v1 had a separate `memory.memsw.limit_in_bytes` for combined memory+swap limits. Cgroup v2 combines them under `memory.swap.max`:

| v1 | v2 |
|----|----|
| `memory.limit_in_bytes` | `memory.max` |
| `memory.soft_limit_in_bytes` | `memory.high` |
| `memory.memsw.limit_in_bytes` | No direct equivalent: v2 `memory.max` caps RAM only; `memory.swap.max` caps swap-only (not combined) |
| `memory.usage_in_bytes` | `memory.current` |
| `memory.memsw.usage_in_bytes` | `memory.current` + `memory.swap.current` (computed, not a single file) |

**Class 3 — Controller not enabled**: Several hosts showed that `memory.max` existed but writes were silently ignored. The root cause: the memory controller was not listed in `cgroup.subtree_control` at the container's parent cgroup. On cgroup v2, a controller must be enabled at each level of the hierarchy before its interface files appear in children. The kernel boot parameter `cgroup_enable=memory` is not needed for v2 (the memory controller is built in), but the subtree_control chain must be complete:

```bash
# Verify controllers are enabled at each level:
cat /sys/fs/cgroup/cgroup.subtree_control
# cpuset cpu io memory hugetlb pids     ← must include "memory"

cat /sys/fs/cgroup/system.slice/cgroup.subtree_control
# cpuset cpu io memory pids              ← must include "memory" here too
```

**The fix required**:
1. Updating all monitoring and tooling to use cgroup v2 paths
2. Ensuring systemd's `DefaultMemoryAccounting=yes` was set in `/etc/systemd/system.conf`
3. Auditing scripts for v1 paths using: `grep -r 'sys/fs/cgroup/memory' /usr/local/`
4. Updating Docker / containerd configs to use the cgroupv2 driver

The `libcgroup` and `cgroup-tools` packages still use v1 paths by default; most needed updates or replacement.

---

## 4. The pids controller and Java thread confusion

**Setting**: A Kubernetes pod running a Java 17 application, with `resources.limits` set in the pod spec. The kubelet translated `TasksMax` to `pids.max=100` on the pod's cgroup.

**What happened**: The Java application started normally, but under load its thread pool expanded. At 100 threads, `fork()` calls (including those triggered by `Runtime.exec()` for running subprocesses) started failing with `-EAGAIN`. The JVM caught `EAGAIN` from `clone()` as an `IOException`, logged it, and continued — but subprocess execution failed silently, causing data pipeline failures.

The `pids.max` counter counts **tasks**, not processes. In the Linux kernel, threads are tasks (`struct task_struct`). A JVM with 100 threads consumes all 100 slots in `pids.max=100`, leaving none for new threads or subprocesses. The operator had assumed `pids.max` only limited process (PID) count, not thread count.

**Verification**:

```bash
# Check current task count for the cgroup:
cat /sys/fs/cgroup/kubepods/pod-abc123/pids.current
# 98

# Check the limit:
cat /sys/fs/cgroup/kubepods/pod-abc123/pids.max
# 100

# ps undercounts because it shows processes, not kernel tasks (threads):
ps aux | grep java | wc -l
# 3    ← only shows the JVM process and a few wrappers

# /proc/PID/status shows all threads:
cat /proc/$(pgrep java)/status | grep Threads
# Threads: 97
```

**Fix**: Increase `pids.max` to accommodate the application's thread count. A Java application with a thread pool of 200 plus system threads might need `pids.max=250` or higher:

```bash
echo "500" > /sys/fs/cgroup/kubepods/pod-abc123/pids.max
```

In Kubernetes, set `TasksMax` or rely on the node's `--pods-per-core` calculation. The `pids.events` file shows how many times the limit was hit:

```bash
cat /sys/fs/cgroup/kubepods/pod-abc123/pids.events
# max 47    ← limit was hit 47 times
```

For monitoring, alert on `pids.current / pids.max > 0.8` to catch this before processes start failing.

---

## 5. The delegated cgroup race

**Setting**: A container runtime using `Delegate=yes` in its systemd service unit. On container start, the runtime:
1. Created a child cgroup under its delegated subtree
2. Wrote `cgroup.procs` to move the container init process into the new cgroup
3. Wrote `memory.max` to set the container's memory limit

**What happened**: On a heavily loaded node, step 3 was occasionally delayed by several hundred milliseconds. Between steps 2 and 3, the container's init process ran without a memory limit — in the root of the delegated subtree, which inherited the runtime's own generous `memory.max` (or no limit at all). During that window, a memory-hungry container init script could allocate well beyond the intended container limit.

In most cases the window was microseconds and irrelevant. But on an overloaded node where the container runtime's goroutines were preempted between the two writes, the window stretched to hundreds of milliseconds. A container designed to use 256M could allocate 2G during init before the limit was written.

**The kernel behavior**: Writing `cgroup.procs` is atomic with respect to that process's cgroup membership, but there is no transaction spanning "create cgroup + set limits + move process." The kernel has no mechanism to atomically set all limits and then admit a process. This is an inherent design property of the cgroup interface.

**Fix**: Always write resource limits **before** moving processes into the cgroup. The correct sequence is:

```bash
# 1. Create the cgroup directory
mkdir /sys/fs/cgroup/containerd.service/abc123/

# 2. Write ALL limits first (order within this step does not matter):
echo "268435456" > /sys/fs/cgroup/containerd.service/abc123/memory.max   # 256M
echo "0"         > /sys/fs/cgroup/containerd.service/abc123/memory.swap.max
echo "100"       > /sys/fs/cgroup/containerd.service/abc123/pids.max
echo "200000 1000000" > /sys/fs/cgroup/containerd.service/abc123/cpu.max

# 3. Only then move the process:
echo $CONTAINER_INIT_PID > /sys/fs/cgroup/containerd.service/abc123/cgroup.procs
```

The runc runtime learned this lesson and now writes limits before calling `clone()` or moving PIDs. The OCI runtime specification requires runtimes to apply resource limits before the container process begins executing.

A secondary fix: keep the intermediate cgroup (before the process is moved) under a restrictive parent cgroup that already has tight limits, so even a race is bounded.

---

## Patterns across incidents

These five incidents share common diagnostic steps:

```bash
# 1. Check if a cgroup is being throttled:
cat /sys/fs/cgroup/.../cpu.stat | grep throttled

# 2. Check OOM events:
cat /sys/fs/cgroup/.../memory.events

# 3. Check pids limit hits:
cat /sys/fs/cgroup/.../pids.events

# 4. Check what controllers are actually active:
cat /sys/fs/cgroup/.../cgroup.controllers
cat /sys/fs/cgroup/.../cgroup.subtree_control

# 5. Check current resource usage vs limits:
cat /sys/fs/cgroup/.../memory.current
cat /sys/fs/cgroup/.../pids.current
```

And a common principle: **cgroups enforce policy atomically within a single write, but not across multiple writes.** Set limits before adding processes. Use `memory.events` and `cpu.stat` to observe what the kernel is actually doing, not just what you configured.

## Further reading

- [Cgroup v2 Architecture](cgroup-v2.md) — unified hierarchy, subtree_control propagation
- [Resource Controllers](cgroup-controllers.md) — cpu.max, memory.max, pids.max interface files
- [systemd and Cgroup Integration](systemd-cgroups.md) — delegation, unit properties, live changes
- [io Controller](io-cgroup.md) — io.latency SLA and writeback attribution
- [Container Isolation](container-isolation.md) — runc, OCI spec, and container lifecycle
- `kernel/sched/fair.c` — CFS bandwidth controller and throttling implementation
- `mm/memcontrol.c` — memory controller OOM handling
- `kernel/cgroup/pids.c` — pids controller implementation
