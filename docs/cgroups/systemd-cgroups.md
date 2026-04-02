# systemd and Cgroup Integration

> How systemd manages the cgroup hierarchy: slices, scopes, services, and delegation

## Overview

systemd is the cgroup manager on nearly every modern Linux distribution. Since systemd 232 (2016), systemd assumes exclusive ownership of the cgroup v2 hierarchy: it creates sub-trees for every unit, writes resource limits to the appropriate interface files, and enforces the rule that only one userspace agent manages a given subtree. No other tool should write to `/sys/fs/cgroup` directly unless systemd has explicitly delegated that subtree.

This arrangement solves a problem that plagued cgroup v1: multiple managers (Docker, LXC, Kubernetes, systemd itself) competing to write the same cgroup files, often overwriting each other's settings.

## Unit types and their cgroup mapping

systemd exposes three unit types that map to cgroups:

### Service units (`.service`)

A long-running daemon. systemd creates a cgroup at `system.slice/<name>.service/` and moves the daemon's processes into it at start time.

```
/sys/fs/cgroup/system.slice/nginx.service/
├── cgroup.procs        ← contains nginx worker PIDs
├── cpu.max             ← set from CPUQuota=
├── memory.max          ← set from MemoryMax=
├── io.weight           ← set from IOWeight=
└── pids.max            ← set from TasksMax=
```

The cgroup is created when the service starts and removed (after a drain) when it stops. If the service crashes and restarts, the same cgroup path is reused.

### Scope units (`.scope`)

A group of externally-started processes registered with systemd via D-Bus (`org.freedesktop.systemd1.Manager.StartTransientUnit`). Container runtimes use scopes to register containers they start themselves. The cgroup path is `user.slice/user-<uid>.slice/<name>.scope/` for user scopes.

Unlike services, systemd does not start or stop processes in a scope — it only creates the cgroup and tracks it. The runtime that registered the scope is responsible for the processes.

### Slice units (`.slice`)

Hierarchical grouping containers for services and scopes. A slice does not hold processes directly; it holds child slices, services, and scopes. Its cgroup provides a resource envelope shared by all children.

The default slices are:
- `system.slice` — all system services
- `user.slice` — all user sessions
- `machine.slice` — VMs and containers managed by `systemd-machined`

## The default cgroup layout

```
/sys/fs/cgroup/
├── cgroup.controllers
├── cgroup.subtree_control
├── init.scope/            ← PID 1 (systemd) itself
│   └── cgroup.procs       ← contains 1
├── system.slice/          ← system services
│   ├── cgroup.subtree_control
│   ├── nginx.service/
│   │   ├── cgroup.procs
│   │   ├── cpu.max
│   │   └── memory.max
│   ├── sshd.service/
│   │   └── cgroup.procs
│   └── containerd.service/
│       └── cgroup.procs   ← contains containerd (not containers)
├── user.slice/            ← user sessions
│   └── user-1000.slice/
│       ├── session-1.scope/
│       │   └── cgroup.procs   ← login shell and its children
│       └── user@1000.service/ ← user systemd instance
│           └── cgroup.procs
└── machine.slice/         ← VMs / containers via machined
```

systemd ensures the `system.slice` and `user.slice` always exist and that `cgroup.subtree_control` is populated with the controllers listed in `DefaultCPUAccounting=`, `DefaultMemoryAccounting=`, etc. in `/etc/systemd/system.conf`.

## Resource limits in unit files

Unit file properties map directly to cgroup v2 interface files:

```ini
[Service]
# cpu.max = quota period (microseconds)
CPUQuota=50%          # cpu.max = "500000 1000000"  (50% of one CPU)

# memory.max (hard limit; triggers OOM kill when exceeded)
MemoryMax=512M        # memory.max = 536870912

# memory.high (soft limit; triggers reclaim before OOM)
MemoryHigh=400M       # memory.high = 419430400

# memory.swap.max (limit swap usage)
MemorySwapMax=0       # memory.swap.max = 0  (no swap)

# io.weight (BFQ proportional scheduling weight, 1-10000)
IOWeight=100          # io.weight = 100

# io.max (per-device hard bandwidth limit)
IOReadBandwidthMax=/dev/sda 50M   # io.max = "8:0 rbps=52428800"
IOWriteBandwidthMax=/dev/sda 25M  # io.max = "8:0 wbps=26214400"

# pids.max
TasksMax=100          # pids.max = 100

# cpuset.cpus (pin to specific CPUs)
AllowedCPUs=0-3       # cpuset.cpus = "0-3"

# cpuset.mems (pin to specific NUMA nodes)
AllowedMemoryNodes=0  # cpuset.mems = "0"
```

When systemd writes these, it uses `sd_bus_call_method()` over D-Bus for live changes, and then writes directly to the cgroup interface files during unit startup via the internal `cg_set_attribute()` helper (in `src/basic/cgroup-util.c` of the systemd source).

## Live property changes

`systemctl set-property` applies a resource change to a running unit without restarting it:

```bash
# Reduce nginx to 25% CPU quota
systemctl set-property nginx.service CPUQuota=25%

# Limit memory
systemctl set-property nginx.service MemoryMax=256M

# The change is:
# 1. Sent via D-Bus to PID 1 (systemd)
# 2. systemd writes the value to /sys/fs/cgroup/system.slice/nginx.service/cpu.max
# 3. Optionally persisted to /etc/systemd/system/nginx.service.d/50-CPUQuota.conf

# Verify the change took effect:
cat /sys/fs/cgroup/system.slice/nginx.service/cpu.max
# 250000 1000000
```

The `--runtime` flag applies the change only until next reboot (no `.conf` file created):

```bash
systemctl set-property --runtime nginx.service MemoryMax=256M
```

## Delegation

When `Delegate=yes` is set in a unit file, systemd marks the service's cgroup as delegated. systemd will still create the cgroup and set top-level limits, but it will not recurse into the subtree — it will not touch `cgroup.subtree_control` or any files below the delegation point. The service itself is responsible for managing its own sub-hierarchy.

```ini
[Service]
Delegate=yes
# Or delegate specific controllers only:
Delegate=cpu memory pids
```

This is used by:
- **containerd** / **Docker** — create per-container sub-cgroups under `containerd.service/`
- **Kubernetes kubelet** — creates per-pod cgroups under `kubelet.service/` or a dedicated slice
- **User systemd instances** — `user@1000.service` is delegated so the per-user systemd can manage `user.slice/user-1000.slice/`

When `Delegate=yes`, systemd writes the `cgroup.delegate` file (available since kernel 5.10 in some form, formally as `cgroup.delegate` in later versions) and sets the cgroup's ownership to the service's `User=` so the unprivileged process can write `cgroup.subtree_control` and create child cgroups without root.

The correct pattern for a container runtime using delegation:

```bash
# systemd has created: /sys/fs/cgroup/system.slice/containerd.service/
# Delegate=yes means containerd owns this subtree.

# containerd creates a cgroup for container abc123:
mkdir /sys/fs/cgroup/system.slice/containerd.service/abc123/

# Write limits BEFORE moving any process into the cgroup:
echo "512M" > /sys/fs/cgroup/system.slice/containerd.service/abc123/memory.max
echo "100"  > /sys/fs/cgroup/system.slice/containerd.service/abc123/pids.max

# Then move the container init process:
echo $CONTAINER_PID > /sys/fs/cgroup/system.slice/containerd.service/abc123/cgroup.procs
```

## Transient units

`systemd-run` creates a transient scope or service cgroup on the fly without writing a unit file:

```bash
# Run a command in a transient scope under myslice.slice with resource limits
systemd-run --scope \
    --slice=myslice.slice \
    --property=MemoryMax=256M \
    --property=CPUQuota=50% \
    -- stress --vm 2 --vm-bytes 200M

# Run a one-shot service (waits for completion)
systemd-run --service-type=oneshot \
    --property=TasksMax=20 \
    -- /usr/local/bin/batch-job.sh

# Check the generated cgroup:
systemd-cgls /sys/fs/cgroup/myslice.slice/
```

Transient units are registered via `org.freedesktop.systemd1.Manager.StartTransientUnit` over D-Bus. The unit and its cgroup are removed automatically when the process exits.

## Observability

```bash
# Show the full cgroup tree annotated with systemd unit names:
systemd-cgls

# Example output:
# Control group /:
# -.slice
# ├─system.slice
# │ ├─nginx.service
# │ │ ├─1234 nginx: master process /usr/sbin/nginx
# │ │ └─1235 nginx: worker process
# │ └─sshd.service
# │   └─5678 sshd: accepting connections
# └─user.slice
#   └─user-1000.slice
#     └─session-1.scope
#       ├─9012 -bash
#       └─9013 systemd-cgls

# Live per-cgroup resource usage (like top for cgroups):
systemd-cgtop

# Show resource settings for a unit:
systemctl show nginx.service | grep -E 'CPU|Memory|IO|Tasks'
# CPUQuota=50%
# MemoryMax=536870912
# TasksMax=100

# Check raw cgroup interface files:
cat /sys/fs/cgroup/system.slice/nginx.service/cpu.stat
cat /sys/fs/cgroup/system.slice/nginx.service/memory.current
cat /sys/fs/cgroup/system.slice/nginx.service/io.stat
```

## How systemd enables controllers

systemd reads `/proc/cgroups` to discover available controllers and uses `cgroup.subtree_control` to propagate them down the hierarchy. The `DefaultCPUAccounting=yes` / `DefaultMemoryAccounting=yes` / `DefaultIOAccounting=yes` knobs in `/etc/systemd/system.conf` control which controllers systemd enables globally.

```bash
# See which controllers systemd has enabled:
cat /sys/fs/cgroup/cgroup.subtree_control
# cpuset cpu io memory hugetlb pids

# See controllers available to a service's cgroup:
cat /sys/fs/cgroup/system.slice/cgroup.subtree_control
```

If a controller is not listed in `cgroup.subtree_control` at the relevant level, interface files like `memory.max` won't exist in the child cgroup — a common source of confusion when controllers are disabled by default.

## Further reading

- [Cgroup v2 Architecture](cgroup-v2.md) — unified hierarchy, struct cgroup, subtree_control
- [Resource Controllers](cgroup-controllers.md) — cpu, memory, io, pids interface files in detail
- [Container Isolation](container-isolation.md) — how Docker/containerd use delegation
- [Cgroup War Stories](war-stories.md) — delegation race conditions and v1→v2 migration surprises
- `man systemd.resource-control(5)` — complete list of resource control properties
- `man systemd-run(1)` — transient unit creation
- `src/core/cgroup.c` in the systemd source — cgroup management implementation
- `Documentation/admin-guide/cgroup-v2.rst` — kernel cgroup v2 documentation
