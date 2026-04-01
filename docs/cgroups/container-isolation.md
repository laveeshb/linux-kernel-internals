# Container Isolation Internals

> How Docker, Kubernetes, and container runtimes use namespaces and cgroups

## What a container is, kernel-side

A container is a process (or process tree) that:

1. Lives in a set of **namespaces** (isolated view of system resources)
2. Is governed by a **cgroup** (resource limits)
3. Has a **filesystem root** (via mount namespace + chroot/pivot_root)
4. Is optionally restricted by **seccomp** (syscall filtering) and **LSM** (AppArmor/SELinux)

There is no "container" kernel object — it's a combination of existing primitives.

```
                    Container
    ┌─────────────────────────────────────────┐
    │  PID namespace: PIDs 1,2,3,...          │
    │  Mount namespace: / → container rootfs  │
    │  Net namespace: eth0=veth pair          │
    │  User namespace: uid 0=container root   │
    │  UTS namespace: hostname=container-1    │
    │  IPC namespace: isolated SysV/POSIX     │
    │  Cgroup namespace: /sys/fs/cgroup view  │
    ├─────────────────────────────────────────┤
    │  Cgroup: /sys/fs/cgroup/containers/c1/  │
    │    cpu.max = 500000/1000000 (50%)        │
    │    memory.max = 512M                    │
    │    pids.max = 100                       │
    ├─────────────────────────────────────────┤
    │  seccomp: syscall whitelist/blacklist   │
    │  AppArmor/SELinux: MAC policy           │
    └─────────────────────────────────────────┘
```

## Container creation sequence

This is what `docker run` or `runc` does at the kernel level:

```c
/* Simplified runc container creation */

/* 1. Create new namespaces via clone() */
pid_t child = clone(container_init,
    stack + STACK_SIZE,
    CLONE_NEWPID    /* new PID namespace */
    | CLONE_NEWNS   /* new mount namespace */
    | CLONE_NEWNET  /* new network namespace */
    | CLONE_NEWIPC  /* new IPC namespace */
    | CLONE_NEWUTS  /* new UTS namespace */
    | CLONE_NEWCGROUP  /* new cgroup namespace */
    | SIGCHLD,
    &config);

/* 2. Set up cgroup (from parent namespace) */
/* Write pid to cgroup.procs */
write_to_file("/sys/fs/cgroup/containers/c1/cgroup.procs", pid_str);

/* 3. Set up network (veth pair, from parent namespace) */
/* runc calls netlink to create veth0/veth1, move veth1 to child netns */

/* 4. In child: pivot_root to container filesystem */
/* mounts container rootfs, calls pivot_root or chroot */

/* 5. In child: setuid/setgid, drop capabilities */

/* 6. In child: install seccomp filter */
prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog);

/* 7. exec the container entrypoint */
execve("/entrypoint", argv, envp);
```

## pivot_root: switching filesystem root

Containers use `pivot_root` (not just `chroot`) to fully isolate the filesystem:

```c
/* Container init: */

/* 1. Mount container rootfs at a temp location */
mount(rootfs_path, "/new_root", "none", MS_BIND, NULL);

/* 2. Make mount namespace private (prevent propagation to host) */
mount("", "/", "none", MS_PRIVATE | MS_REC, NULL);

/* 3. Put old root somewhere under new root */
mkdir("/new_root/.old_root", 0755);

/* 4. pivot_root: new_root becomes /, old root goes to /.old_root */
syscall(SYS_pivot_root, "/new_root", "/new_root/.old_root");

/* 5. Unmount the old root to complete isolation */
umount2("/.old_root", MNT_DETACH);
rmdir("/.old_root");

/* Now /proc, /sys, /dev need to be mounted fresh */
mount("proc", "/proc", "proc", 0, NULL);
mount("sysfs", "/sys", "sysfs", 0, NULL);
mount("tmpfs", "/dev", "tmpfs", 0, NULL);
```

## Network setup: veth pairs

Container networking uses virtual ethernet pairs:

```
Host namespace                    Container namespace
─────────────────                 ──────────────────
veth0 (10.0.0.1)  ←──────────→  eth0 (172.17.0.2)
    │                  kernel
    │                  bridge
docker0 bridge
(172.17.0.1)
    │
    └── routes, NAT (iptables MASQUERADE)
```

```bash
# What runc does for container networking (simplified):
ip link add veth0 type veth peer name eth0
ip link set eth0 netns <container_pid>

# In host namespace:
ip link set veth0 master docker0
ip link set veth0 up

# In container namespace:
ip netns exec <container_pid> ip addr add 172.17.0.2/16 dev eth0
ip netns exec <container_pid> ip route add default via 172.17.0.1
```

## Cgroup namespace: container's view of cgroups

Without a cgroup namespace, a container would see the full host cgroup hierarchy. With `CLONE_NEWCGROUP`:

```bash
# Host sees:
cat /proc/1/cgroup
# 0::/

# Container (in its cgroup namespace) sees:
cat /proc/1/cgroup  # from inside container
# 0::/              ← the container's own cgroup looks like root

# /sys/fs/cgroup/ inside the container shows only its subtree
```

The cgroup namespace makes the container's cgroup appear as root, so `systemd` in a container doesn't see the host hierarchy.

## User namespace: rootless containers

Rootless containers (Docker rootless, Podman) run entirely as unprivileged users:

```
Host:     uid=1000 (user)
          uid=100000-165535 (subuid range)

Container: uid=0 (root inside)
           = uid=100000 outside  (via uid_map: 0 → 100000, range 65536)
```

```bash
# /etc/subuid maps users to subordinate UID ranges
cat /etc/subuid
# user:100000:65536

# Start rootless container
podman run --rm -it ubuntu bash
# Inside: id → uid=0(root)
# Outside: ps shows process running as uid=100000

# The kernel enforces: this "root" has no host privilege
# It cannot access /etc/shadow, load modules, etc.
```

The user namespace also enables unprivileged namespace creation for all other types. User namespaces were made fully functional for unprivileged users in Linux 3.8 [(LWN)](https://lwn.net/Articles/532593/).

## seccomp: syscall filtering

Seccomp restricts which syscalls a container can make:

```c
/* Install a seccomp filter (BPF program over syscall args) */
struct sock_filter filter[] = {
    /* Load syscall number */
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
             offsetof(struct seccomp_data, nr)),

    /* Allow read, write, exit, sigreturn */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_read, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_write, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    /* Default: kill */
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL),
};

struct sock_fprog prog = {
    .len = ARRAY_SIZE(filter),
    .filter = filter,
};
prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog);
```

Docker's default seccomp profile blocks ~40 syscalls (including `keyctl`, `kexec_load`, `perf_event_open`, `ptrace`, etc.).

## OCI runtime spec

The Open Container Initiative (OCI) runtime spec defines what a container runtime (runc, crun, kata) must do. The spec is a JSON file (`config.json`):

```json
{
  "ociVersion": "1.0.0",
  "process": {
    "user": {"uid": 0, "gid": 0},
    "args": ["/bin/sh"],
    "capabilities": {
      "bounding": ["CAP_NET_BIND_SERVICE", "CAP_KILL", ...]
    },
    "rlimits": [{"type": "RLIMIT_NOFILE", "hard": 1024, "soft": 1024}],
    "seccompProfile": "default.json"
  },
  "root": {"path": "rootfs", "readonly": true},
  "mounts": [
    {"destination": "/proc", "type": "proc", "source": "proc"},
    {"destination": "/dev", "type": "tmpfs", "source": "tmpfs"}
  ],
  "linux": {
    "namespaces": [
      {"type": "pid"}, {"type": "network"}, {"type": "ipc"},
      {"type": "uts"}, {"type": "mount"}, {"type": "cgroup"}
    ],
    "cgroupsPath": "/containers/mycontainer",
    "resources": {
      "memory": {"limit": 536870912},
      "cpu": {"quota": 200000, "period": 1000000}
    }
  }
}
```

## Debugging container isolation

```bash
# Check what namespaces a container process is in
PID=$(docker inspect --format '{{.State.Pid}}' mycontainer)
ls -la /proc/$PID/ns/

# Enter a container's namespace
nsenter --target $PID --mount --pid --net -- bash

# Check cgroup of a container process
cat /proc/$PID/cgroup

# See container's cgroup limits
cat /sys/fs/cgroup/$(cat /proc/$PID/cgroup | cut -d: -f3)/memory.max

# strace a container process from the host
strace -p $PID

# Check seccomp filter installed
cat /proc/$PID/status | grep Seccomp
# Seccomp: 2    ← 0=none, 1=strict, 2=filter

# Check capabilities
cat /proc/$PID/status | grep Cap
# CapPrm: 00000000a80425fb
capsh --decode=00000000a80425fb
```

## Further reading

- [Cgroup v2 Architecture](cgroup-v2.md) — Resource control internals
- [Resource Controllers](cgroup-controllers.md) — cpu, memory, io limits
- [Namespaces](namespaces.md) — All 8 namespace types in detail
- [BPF/eBPF](../bpf/README.md) — seccomp-bpf and cgroup BPF programs
- `runc` source code — reference OCI container runtime
