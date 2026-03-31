# Cgroups & Namespaces

> Resource control and isolation primitives that underpin containers

## What cgroups and namespaces do

**Cgroups (control groups)** limit *how much* resource a group of processes can use:
- CPU time (cpu.weight, cpu.max)
- Memory (memory.max, memory.swap.max)
- I/O bandwidth (io.weight, io.max)
- Process count (pids.max)

**Namespaces** control *what* processes can see:
- Which processes are visible (PID namespace)
- Which filesystem view they have (mount namespace)
- Which network interfaces and addresses they have (network namespace)
- Their hostname and domain (UTS namespace)
- Their user/group IDs (user namespace)

Together they implement container isolation: Docker, Kubernetes pods, and systemd services are built on these primitives.

```
┌──────────────────────────────────────────────────────────────┐
│  Container / Pod                                              │
│  ┌─────────────────────────┐  ┌────────────────────────────┐ │
│  │ Namespaces (isolation)  │  │ Cgroup (resource limits)   │ │
│  │  - PID: pid 1 inside    │  │  - cpu.max 200000/1000000  │ │
│  │  - mnt: own filesystem  │  │  - memory.max 512M         │ │
│  │  - net: own veth pair   │  │  - pids.max 100            │ │
│  │  - user: uid 0 → 1000   │  │                            │ │
│  └─────────────────────────┘  └────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Cgroup v2 Architecture](cgroup-v2.md) | Hierarchy, controllers, struct cgroup |
| [Resource Controllers](cgroup-controllers.md) | cpu, memory, io, pids controllers in detail |
| [Namespaces](namespaces.md) | All 8 namespace types, clone/unshare/setns |
| [Container Isolation](container-isolation.md) | How namespaces + cgroups combine for containers |

## Quick reference

```bash
# Cgroup v2 filesystem
mount | grep cgroup2
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)

# Current process's cgroup
cat /proc/self/cgroup
# 0::/user.slice/user-1000.slice/session-1.scope

# Systemd creates cgroups automatically
systemctl status nginx
# CGroup: /system.slice/nginx.service

# Namespaces of current process
ls -la /proc/self/ns/
# lrwxrwxrwx ... cgroup -> 'cgroup:[4026531835]'
# lrwxrwxrwx ... mnt -> 'mnt:[4026531840]'
# lrwxrwxrwx ... net -> 'net:[4026531992]'
# lrwxrwxrwx ... pid -> 'pid:[4026531836]'
# lrwxrwxrwx ... user -> 'user:[4026531837]'
# lrwxrwxrwx ... uts -> 'uts:[4026531838]'
# lrwxrwxrwx ... ipc -> 'ipc:[4026531839]'
# lrwxrwxrwx ... time -> 'time:[4026531834]'
```
