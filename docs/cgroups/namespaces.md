# Linux Namespaces

> Isolating what processes can see

## The eight namespace types

| Namespace | Flag | Isolates | Kernel |
|-----------|------|----------|--------|
| Mount | `CLONE_NEWNS` | Mount points, filesystem view | 2.4.19 (2002) |
| UTS | `CLONE_NEWUTS` | Hostname, NIS domain name | 2.6.19 |
| IPC | `CLONE_NEWIPC` | SysV IPC, POSIX message queues | 2.6.19 |
| PID | `CLONE_NEWPID` | Process IDs | 2.6.24 [(LWN)](https://lwn.net/Articles/259217/) |
| Network | `CLONE_NEWNET` | Network interfaces, routing, sockets | 2.6.24 |
| User | `CLONE_NEWUSER` | User/group IDs | 3.9 (complete) [(LWN)](https://lwn.net/Articles/532593/) |
| Cgroup | `CLONE_NEWCGROUP` | Cgroup root view | 4.6 |
| Time | `CLONE_NEWTIME` | CLOCK_MONOTONIC, CLOCK_BOOTTIME offsets | 5.6 |

## Creating namespaces

### clone() — create child in new namespace

```c
#define _GNU_SOURCE
#include <sched.h>
#include <unistd.h>

/* Stack for child */
static char child_stack[65536];

static int child_fn(void *arg)
{
    /* Running in new namespace(s) */
    printf("child PID: %d\n", getpid());  /* prints 1 in new PID ns */
    return 0;
}

int main(void)
{
    pid_t child = clone(child_fn,
                        child_stack + sizeof(child_stack),
                        CLONE_NEWPID | CLONE_NEWNS | CLONE_NEWNET | SIGCHLD,
                        NULL);
    waitpid(child, NULL, 0);
    return 0;
}
```

### unshare() — current process enters new namespace

```c
/* Detach from shared namespaces */
unshare(CLONE_NEWNS | CLONE_NEWUTS | CLONE_NEWIPC);

/* Equivalent shell command */
/* unshare --mount --uts --ipc bash */
```

```bash
# Shell: run bash in new namespaces
unshare --pid --mount --fork --mount-proc bash
# Now in isolated PID+mount namespace, ps shows only this bash subtree
```

### setns() — join an existing namespace

```c
#include <fcntl.h>
#include <sched.h>

/* Enter another process's network namespace */
int nsfd = open("/proc/1234/ns/net", O_RDONLY);
setns(nsfd, CLONE_NEWNET);
close(nsfd);
/* Now in pid 1234's network namespace */
```

```bash
# nsenter: enter namespaces of a running container
nsenter --target <pid> --mount --pid --net -- bash
```

## struct nsproxy: the task's namespace set

Each task holds a reference to its namespace set:

```c
/* include/linux/nsproxy.h */
struct nsproxy {
    atomic_t          count;          /* reference count */
    struct uts_namespace   *uts_ns;
    struct ipc_namespace   *ipc_ns;
    struct mnt_namespace   *mnt_ns;
    struct pid_namespace   *pid_ns_for_children;
    struct net             *net_ns;
    struct time_namespace  *time_ns;
    struct time_namespace  *time_ns_for_children;
    struct cgroup_namespace *cgroup_ns;
};

/* In struct task_struct: */
struct nsproxy *nsproxy;
```

Processes that share all namespaces point to the same `nsproxy` (refcount). When any namespace diverges, a new nsproxy is allocated.

## PID namespace

PID namespaces were introduced in Linux 2.6.24 [(LWN)](https://lwn.net/Articles/259217/). Each PID namespace has its own numbering starting from 1. A process has different PIDs in different namespaces:

```
Host PID namespace:        pid=1234 (systemd), pid=5678 (container init)
Container PID namespace:   pid=1 (container init), pid=100 (nginx)
```

```c
/* include/linux/pid_namespace.h */
struct pid_namespace {
    struct idr      idr;            /* pid → task mapping */
    struct rcu_head rcu;
    unsigned int    level;          /* nesting depth (0=init_pid_ns) */
    struct pid_namespace *parent;
    struct user_namespace *user_ns;
    struct ucounts *ucounts;
    struct ns_common ns;

    struct task_struct *child_reaper; /* PID 1 in this namespace */
    struct kmem_cache *pid_cachep;
    unsigned int    nr_hashed;
};
```

PID 1 in a PID namespace is the init — if it exits, all processes in the namespace are killed.

```bash
# See PID translations
cat /proc/1234/status | grep NSpid
# NSpid:  5678   1    ← host PID 5678 = PID 1 in container's namespace
```

## Mount namespace

Mount namespaces (Linux 2.4.19, 2002) were the first namespace type added to the kernel — which is why the flag is the generic `CLONE_NEWNS` rather than something like `CLONE_NEWMNT`. Each mount namespace has its own copy of the mount tree. Changes in one don't affect others.

```c
/* fs/namespace.c */
struct mnt_namespace {
    struct ns_common    ns;
    struct mount       *root;           /* root mount */
    struct list_head    list;           /* all mounts */
    struct user_namespace *user_ns;
    u64                 seq;            /* event sequence number */
    wait_queue_head_t   poll;
    u64                 event;
};
```

```bash
# Create isolated mount namespace and mount procfs for new PID ns
unshare --mount --pid --fork --mount-proc bash

# The bind mount makes the new /proc show PID namespace contents
# Host sees the old /proc
```

### Mount propagation types

```bash
# Shared: mounts propagate to peers
mount --make-shared /mnt

# Private: no propagation
mount --make-private /mnt

# Slave: receive propagation from master, don't send back
mount --make-slave /mnt

# Unbindable: cannot be bind-mounted
mount --make-unbindable /mnt
```

## Network namespace

Each network namespace has its own:
- Network interfaces (except loopback is separate per-ns)
- IP routing table
- Netfilter rules (iptables)
- Socket table
- `/proc/net/` view

```c
/* include/net/net_namespace.h */
struct net {
    /* First cache line: frequently accessed fields */
    refcount_t          passive;      /* passive reference count */
    spinlock_t          rules_mod_lock;

    unsigned int        dev_unreg_count;
    unsigned int        dev_base_seq;

    struct list_head    list;         /* list of all net namespaces */
    struct list_head    exit_list;
    struct llist_node   cleanup_list;

    struct user_namespace *user_ns;   /* owning user namespace */
    struct ucounts      *ucounts;
    struct idr          netns_ids;

    struct ns_common    ns;
    struct ref_tracker_dir  refcnt_tracker;

    struct list_head    dev_base_head; /* list of net devices */
    struct proc_dir_entry *proc_net;
    struct proc_dir_entry *proc_net_stat;

    /* Protocol-specific namespaced state: */
    struct netns_ipv4   ipv4;
    struct netns_ipv6   ipv6;
    struct netns_unix   unx;
    struct netns_packet packet;
    struct netns_nftables nft;
    /* ... */
};
```

```bash
# Create a network namespace
ip netns add myns

# Run a command in the namespace
ip netns exec myns ip link show

# Move a veth pair into a namespace (typical container networking)
ip link add veth0 type veth peer name veth1
ip link set veth1 netns myns
ip addr add 10.0.0.1/24 dev veth0
ip netns exec myns ip addr add 10.0.0.2/24 dev veth1
ip link set veth0 up
ip netns exec myns ip link set veth1 up

# List network namespaces
ip netns list
ls /var/run/netns/
```

## User namespace

User namespaces were made functionally complete and usable by unprivileged users in Linux 3.9 by Eric W. Biederman [(commit)](https://git.kernel.org/linus/94f2f14234178f118545a0be60a6371ddeb229b7) [(LWN)](https://lwn.net/Articles/532593/). User namespaces map UIDs/GIDs between inside and outside:

```c
/* kernel/user_namespace.c */
struct user_namespace {
    struct uid_gid_map  uid_map;        /* uid mapping rules */
    struct uid_gid_map  gid_map;
    struct uid_gid_map  projid_map;
    struct ucounts     *ucounts;
    struct user_namespace *parent;
    int                 level;
    kuid_t              owner;
    kgid_t              group;
    struct ns_common    ns;
    unsigned long       flags;
    struct list_head    keyring_name_list;
    struct key         *user_keyring_register;
    struct rw_semaphore keyring_sem;
};

struct uid_gid_map {
    u32                 nr_extents;     /* number of mapping ranges */
    union {
        struct uid_gid_extent extent[UID_GID_MAP_MAX_BASE_EXTENTS];
        struct {
            struct uid_gid_extent *forward;
            struct uid_gid_extent *reverse;
        };
    };
};
```

```bash
# Create user namespace as unprivileged user
unshare --user --map-root-user bash
# Now: "root" inside = uid 1000 outside

# Inspect the UID mapping
cat /proc/self/uid_map
# 0       1000          1   ← inside_start outside_start count
# UID 0 inside = UID 1000 outside, 1 entry

# Multi-range mapping (requires privilege)
echo "0 1000 10" > /proc/<pid>/uid_map
# UIDs 0-9 inside map to UIDs 1000-1009 outside
```

The key property: a process can be UID 0 (root) inside a user namespace but have no privilege outside it. This enables rootless containers.

### Capability scope

Capabilities in a user namespace only grant privilege over resources owned by that namespace and its descendants. Root in a user namespace cannot:
- Load kernel modules
- Modify kernel parameters outside the namespace
- Read files owned by other users on the host

## UTS namespace

```bash
# Isolate hostname
unshare --uts bash
hostname container1
# Host's hostname is unchanged
```

```c
struct uts_namespace {
    struct new_utsname name;    /* contains nodename (hostname) */
    struct user_namespace *user_ns;
    struct ucounts *ucounts;
    struct ns_common ns;
};
```

## Namespace file descriptors

Namespaces are persistent as long as:
1. A process is in them, OR
2. They have a file descriptor open, OR
3. They have a bind mount at `/proc/<pid>/ns/<type>` or `/var/run/netns/`

```bash
# Persist a network namespace across process death
touch /var/run/netns/myns
mount --bind /proc/<pid>/ns/net /var/run/netns/myns
# Now myns persists even after the creating process exits
```

## Observing namespaces

```bash
# See namespace IDs for all processes (matching = shared)
lsns
# NS TYPE   NPROCS   PID USER       COMMAND
# 4026531835 cgroup    102     1 root       /sbin/init
# 4026531836 pid       102     1 root       /sbin/init
# 4026531992 net        98     1 root       /sbin/init
# 4026532156 mnt         1  1234 user       bash

# See which namespaces a container uses
lsns --task <container_pid>

# Inspect /proc/self/ns/ symlinks
ls -la /proc/self/ns/

# Find all processes in the same network namespace
lsns -t net
```

## Further reading

- [Container Isolation](container-isolation.md) — How namespaces and cgroups combine
- [Cgroup v2 Architecture](cgroup-v2.md) — Resource control complement to isolation
- `man 7 namespaces` — kernel documentation for all namespace types
- `man 2 clone`, `man 2 unshare`, `man 2 setns`
