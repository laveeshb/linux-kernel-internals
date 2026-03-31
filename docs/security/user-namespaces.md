# User Namespaces and Credential Mapping

> uid/gid mapping, capability sets, and the privilege model for containers

## What user namespaces provide

A user namespace maps user and group IDs between a process's view and the host system. Inside the namespace, a process can have uid 0 (root) while being mapped to an unprivileged uid on the host.

This is the foundation for **rootless containers**: running containers without any host privileges.

```
Host system:           Container (user namespace):
  uid=1000 (alice)  ←→  uid=0 (root inside container)
  gid=1000           ←→  gid=0
  uid=1001-65535     ←→  uid=1-64535
```

## Creating a user namespace

```c
#include <sched.h>
#include <unistd.h>

/* Clone with new user namespace */
pid_t pid = clone(child_func, stack_top,
                  CLONE_NEWUSER | SIGCHLD, NULL);

/* Or in the shell: */
/* unshare -U /bin/bash */
/* id → uid=65534(nobody) until mapped */
```

After `clone(CLONE_NEWUSER)`, the child process has a new user namespace but **no uid/gid mapping yet**. All operations requiring privileges fail until the parent writes the mapping.

## uid_map and gid_map

```bash
# From the parent (after fork):
# Map child uid 0 → host uid 1000, range 1
echo "0 1000 1" > /proc/<child_pid>/uid_map
echo "0 1000 1" > /proc/<child_pid>/gid_map

# Format: <ns-uid> <host-uid> <count>
# Maps ns-uid range [0, count) to host-uid range [host-uid, host-uid+count)

# Multi-range mapping (for container with many users):
echo "0 1000 1" > /proc/<pid>/uid_map    # root maps to host 1000
echo "1 100000 65534" >> ...             # uid 1-65534 maps to host 100000-165533
```

### newuidmap / newgidmap

For unprivileged users to write mappings beyond the single-entry restriction, the `newuidmap` setuid helper is used:

```bash
# /etc/subuid format: user:start:count
# alice:100000:65536
# means alice can use host uids 100000-165535 in user namespaces

# newuidmap writes the uid_map for an unprivileged process:
newuidmap <pid> <ns-uid> <host-uid> <count> [...]
newuidmap 1234 0 1000 1 1 100000 65535

# Podman/rootless Docker use this automatically:
podman run --rm alpine id
# uid=0(root) gid=0(root) groups=0(root)
# (on host, process runs as alice with uid 1000)
```

### /etc/subuid and /etc/subgid

```bash
# View subordinate ID ranges allocated for a user:
cat /etc/subuid
# alice:100000:65536
# bob:165536:65536

# Allocate a range for a new user:
usermod --add-subuids 200000-265535 charlie
usermod --add-subgids 200000-265535 charlie
```

## Capabilities in user namespaces

Within a new user namespace, a process starts with a **full set of capabilities** — but only within that namespace:

```c
/* Capabilities in a user namespace are scoped: */

/* Permitted inside namespace: */
CAP_NET_ADMIN    /* modify network config of ns-owned network namespaces */
CAP_SYS_ADMIN    /* various admin ops within the namespace */
CAP_SETUID       /* change uid to any uid in the mapping */
CAP_CHOWN        /* chown to any uid in the mapping */
/* ... */

/* NOT permitted even inside namespace: */
/* CAP_SYS_RAWIO: direct hardware access */
/* CAP_SYS_MODULE: load kernel modules */
/* Anything requiring global system access */
```

### struct cred

```c
/* include/linux/cred.h */
struct cred {
    atomic_long_t   usage;

    kuid_t          uid;    /* real UID */
    kgid_t          gid;    /* real GID */
    kuid_t          suid;   /* saved UID */
    kgid_t          sgid;   /* saved GID */
    kuid_t          euid;   /* effective UID */
    kgid_t          egid;   /* effective GID */
    kuid_t          fsuid;  /* filesystem UID */
    kgid_t          fsgid;  /* filesystem GID */
    unsigned        securebits;  /* SUID-related security bits */

    kernel_cap_t    cap_inheritable; /* caps new processes can inherit */
    kernel_cap_t    cap_permitted;   /* caps this process may use */
    kernel_cap_t    cap_effective;   /* caps currently in use */
    kernel_cap_t    cap_bset;        /* capability bounding set */
    kernel_cap_t    cap_ambient;     /* ambient capability set */

    struct user_namespace   *user_ns;  /* owning user namespace */
    struct user_struct      *user;
    struct group_info       *group_info;

    /* RCU-protected: */
    struct rcu_head         rcu;
} __randomize_layout;
```

### Capability sets

```
cap_permitted:   maximum capabilities the process can have
cap_effective:   capabilities currently active (checked by kernel)
cap_inheritable: capabilities passed across execve
cap_bset:        bounding set: caps can never exceed this
cap_ambient:     ambient: automatically inherited without execve magic
```

### Checking capabilities

```c
/* kernel/capability.c */
bool ns_capable(struct user_namespace *ns, int cap)
{
    return ns_capable_common(ns, cap, CAP_OPT_NONE);
}

bool capable(int cap)
{
    return ns_capable(&init_user_ns, cap);
}
```

When a process calls `capable(CAP_NET_ADMIN)`, the kernel checks whether the process has the capability in the namespace that owns the resource being accessed.

## kuid_t and uid remapping in the kernel

The kernel uses `kuid_t` (kernel UID) throughout to avoid confusion between namespaced and host UIDs:

```c
/* include/linux/uidgid.h */
typedef struct {
    uid_t val;
} kuid_t;

/* Convert between namespace UID and kernel UID: */
kuid_t make_kuid(struct user_namespace *from, uid_t uid)
{
    /* Map uid through from's uid_map to get host uid */
    return KUIDT_INIT(map_id_up(&from->uid_map, uid));
}

uid_t from_kuid(struct user_namespace *to, kuid_t uid)
{
    /* Map host uid through to's uid_map to get ns uid */
    return map_id_down(&to->uid_map, __kuid_val(uid));
}

/* Example: */
/* User writes uid=0 to a file owned by uid=0 in namespace */
/* Kernel converts: kuid = make_kuid(task->user_ns, 0) = host uid 1000 */
/* File's st_uid = from_kuid(task->user_ns, file->kuid) = 0 (shown as 0 in ns) */
```

## User namespace security boundaries

### What a user namespace CANNOT do

Even with root inside a user namespace, a process cannot:

```
✗ Load kernel modules (CAP_SYS_MODULE requires init_user_ns)
✗ Access raw block devices (CAP_SYS_RAWIO)
✗ Modify global network interfaces (only ns-owned ones)
✗ Change system clock (CAP_SYS_TIME)
✗ Use ptrace on processes outside the namespace
✗ Access files owned by unmapped uids (/proc, /sys with root ownership)
```

### Nested user namespaces

User namespaces can be nested (up to 32 levels):

```
init_user_ns (uid 0 = system root)
└── container_user_ns (uid 0 → host uid 1000)
    └── nested_user_ns (uid 0 → host uid 1000)
        (capabilities are scoped to each level)
```

## Practical: rootless containers

```bash
# Run rootless container with Podman (no sudo needed):
podman run --rm -it fedora bash
# Inside: whoami → root
# Host: ps shows process as uid 1000 (your user)

# How it works:
# 1. Podman creates user namespace
# 2. Writes uid_map: 0 → 1000 (you), 1-65535 → 100000-165534 (subuid range)
# 3. Creates other namespaces (pid, mnt, net) owned by user namespace
# 4. Mounts overlayfs (allowed via user namespace owning mount namespace)

# Inspect the mapping:
cat /proc/$(pgrep -f "podman.*fedora")/uid_map
# 0       1000          1
# 1     100000      65535

# Check capabilities of container process:
cat /proc/$(pgrep -f "podman.*fedora")/status | grep Cap
# CapPrm: 000001ffffffffff  ← full in user ns
# CapEff: 000001ffffffffff
# CapBnd: 000001ffffffffff
```

## Security considerations

```bash
# CVE-2022-0847 (dirty pipe): user namespace enabled exploitation
# CVE-2021-3493: OverlayFS + user ns privilege escalation
# Mitigation: restrict unprivileged user namespaces

# Check if unprivileged user namespaces are allowed:
cat /proc/sys/kernel/unprivileged_userns_clone  # Debian/Ubuntu
cat /proc/sys/user/max_user_namespaces         # standard kernel

# Restrict (some distros):
echo 0 > /proc/sys/kernel/unprivileged_userns_clone  # disable
echo 1 > /proc/sys/user/max_user_namespaces          # allow max 1

# AppArmor: deny unprivileged user ns creation
# Ubuntu 23.10+: blocks user namespace creation by default for non-root
# except for known applications (Chrome, Podman, etc.)
echo 1 > /proc/sys/kernel/apparmor_restrict_unprivileged_userns
```

## Observing user namespace activity

```bash
# Show user namespace hierarchy:
lsns -t user
# NS         TYPE  NPROCS   PID USER  COMMAND
# 4026531837 user     223     1 root  /sbin/init
# 4026532536 user       2  5434 alice /usr/bin/podman

# Show UID/GID mappings:
cat /proc/<pid>/uid_map
cat /proc/<pid>/gid_map

# Trace user namespace creation:
bpftrace -e '
kprobe:create_user_ns {
    printf("user ns created by pid %d (%s)\n", pid, comm);
}'

# Check which namespace owns a capability check:
bpftrace -e '
kprobe:ns_capable {
    printf("ns_capable: pid=%d cap=%d\n", pid, arg1);
}'

# strace shows namespace syscalls:
strace -e clone,unshare,setns podman run ...
# clone(... CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNS|CLONE_NEWNET ...)
```

## Further reading

- [Credentials](credentials.md) — struct cred, privilege model
- [Capabilities](capabilities.md) — capability sets and checks
- [Container Isolation](../cgroups/container-isolation.md) — namespaces together
- [Network Namespaces](../net/net-namespaces.md) — network isolation
- [SELinux](selinux.md) — MAC on top of DAC
- `kernel/user_namespace.c` — uid_map parsing and namespace creation
- `include/linux/cred.h` — struct cred definition
- `man 7 user_namespaces` — comprehensive man page
- `man 1 newuidmap` — subordinate uid mapping helper
