# Network Namespaces

> Per-namespace network stacks, device migration, and container networking isolation

## What network namespaces provide

Each **network namespace** has its own:
- Network interfaces (lo, eth0, etc.)
- IP addresses and routing tables
- iptables/nftables rules
- netfilter connection tracking
- Unix domain socket namespace
- Port numbers (independent 0-65535)
- `/proc/net/` view

```bash
# Container A (namespace ns1):         Container B (namespace ns2):
ip addr: 172.17.0.2/16                ip addr: 172.17.0.3/16
route: default via 172.17.0.1         route: default via 172.17.0.1
iptables: (container rules)           iptables: (container rules)
# Completely isolated — no visibility between namespaces
```

## Creating and using network namespaces

```bash
# Create a named network namespace:
ip netns add myns

# List namespaces:
ip netns list
# myns (id: 0)

# Run a command in a namespace:
ip netns exec myns ip addr
# 1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN
#     link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00

# Enter namespace interactively:
ip netns exec myns bash
# All network commands now operate in myns

# Configure the loopback:
ip netns exec myns ip link set lo up
ip netns exec myns ip addr add 127.0.0.1/8 dev lo

# Delete namespace:
ip netns del myns
```

## veth pairs: connecting namespaces

```bash
# Create a veth pair:
ip link add veth0 type veth peer name veth1

# Move one end into the namespace:
ip link set veth1 netns myns

# Configure both ends:
ip addr add 10.0.0.1/24 dev veth0
ip link set veth0 up

ip netns exec myns ip addr add 10.0.0.2/24 dev veth1
ip netns exec myns ip link set veth1 up

# Ping between host and namespace:
ping 10.0.0.2      # host → namespace
ip netns exec myns ping 10.0.0.1  # namespace → host
```

## Kernel internals: struct net

```c
/* include/net/net_namespace.h */

struct net {
    /* Reference counting */
    refcount_t          passive;    /* passive users: no active work */
    spinlock_t          rules_mod_lock;
    atomic64_t          net_cookie; /* unique ID */
    struct list_head    list;       /* all net namespaces */

    /* Network devices */
    struct list_head    dev_base_head;  /* all net_device in this ns */
    struct hlist_head  *dev_name_head;  /* hash by name */
    struct hlist_head  *dev_index_head; /* hash by ifindex */
    unsigned int        dev_base_seq;
    unsigned int        ifindex;        /* next ifindex to assign */

    /* Routing */
    struct netns_ipv4   ipv4;       /* IPv4 tables, routing */
    struct netns_ipv6   ipv6;       /* IPv6 tables */

    /* Sockets and protocols */
    struct sock        *rtnl;       /* rtnetlink socket */
    struct sock        *genl_sock;  /* generic netlink */

    /* iptables / nftables */
    struct netns_nf     nf;
    struct netns_xt     xt;

    /* Connection tracking */
    struct netns_ct     ct;

    /* Proc and sysctl */
    struct proc_dir_entry *proc_net;
    struct ctl_table_set sysctls;

    struct user_namespace  *user_ns;   /* owning user namespace */
    struct ucounts         *ucounts;
    struct idr              netns_ids;  /* for netnsid (used by rtnetlink) */
    struct ns_common        ns;         /* common namespace fields */
    /* ... */
};

/* The initial (host) network namespace: */
extern struct net init_net;

/* Get current task's network namespace: */
static inline struct net *sock_net(const struct sock *sk)
{
    return read_pnet(&sk->sk_net);
}
```

## Namespace lifecycle

```c
/* Creating a new network namespace (clone_newnet): */
/* kernel/nsproxy.c → net/core/net_namespace.c */

static int setup_net(struct net *net, struct user_namespace *user_ns)
{
    /* 1. Initialize per-namespace data structures */
    list_for_each_entry(ops, &pernet_list, list) {
        error = ops->init(net);  /* each subsystem initializes */
    }
    /* 2. Create loopback device (lo) */
    /* 3. Initialize routing tables */
    /* 4. Initialize conntrack */
    return 0;
}

/* Cleanup when namespace is freed: */
static void cleanup_net(struct work_struct *work)
{
    /* Run all pernet_operations exit callbacks in reverse order */
    list_for_each_entry_reverse(ops, &pernet_list, list) {
        if (ops->exit)
            ops->exit(net);
    }
}
```

### pernet_operations: subsystem hooks

Every subsystem that has per-namespace state registers cleanup/init hooks:

```c
/* Example: routing table per namespace */
static int __net_init ip_fib_net_init(struct net *net)
{
    /* Allocate per-namespace routing table */
    net->ipv4.fib_table_hash = kzalloc(...);
    return 0;
}

static void __net_exit ip_fib_net_exit(struct net *net)
{
    /* Free per-namespace routing table */
    kfree(net->ipv4.fib_table_hash);
}

static struct pernet_operations fib_net_ops = {
    .init = ip_fib_net_init,
    .exit = ip_fib_net_exit,
};
register_pernet_subsys(&fib_net_ops);
```

## Moving network devices between namespaces

```bash
# Move a physical/virtual device to a namespace:
ip link set eth1 netns myns

# Move back:
ip netns exec myns ip link set eth1 netns 1  # 1 = init_net's nsid
```

```c
/* net/core/dev.c */
int dev_change_net_namespace(struct net_device *dev,
                              struct net *net, const char *pat)
{
    /* 1. Detach from current net: dev_close, unregister_netdevice */
    dev_close(dev);
    /* 2. Change net pointer: */
    dev_net_set(dev, net);
    /* 3. Register in new net: */
    register_netdevice(dev);
    return 0;
}
```

## ip netns exec implementation

```bash
# ip netns exec myns COMMAND
# is equivalent to:
# 1. open("/var/run/netns/myns")    → gets a file descriptor to the ns
# 2. setns(fd, CLONE_NEWNET)        → switch to that ns
# 3. exec(COMMAND)
```

```c
/* ip netns exec uses setns(2): */
int ns_fd = open("/var/run/netns/myns", O_RDONLY);
setns(ns_fd, CLONE_NEWNET);   /* join the network namespace */
execv(argv[0], argv);
```

## Network namespace statistics

```bash
# Per-namespace network stats:
ip netns exec myns cat /proc/net/dev
# Inter-|   Receive                                                |  Transmit
#  face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets
#     lo:       0       0    0    0    0     0          0         0        0       0
#  veth1:  123456    1000    0    0    0     0          0         0    65432     800

# Socket stats per namespace:
ip netns exec myns ss -tulnp

# All open sockets per namespace:
ip netns exec myns cat /proc/net/tcp

# Network namespace IDs (for cross-ns routing in containers):
ip netns list-id
# nsid 0 (iproute2 id for init_net as seen from current ns)
```

## Observability

```bash
# Check network namespace of a process:
readlink /proc/1234/ns/net
# net:[4026531992]  ← inode number uniquely identifies the ns

# Find all processes in a namespace:
ls -la /proc/*/ns/net | grep "4026531992"

# List all unique network namespaces on the system:
find /proc -maxdepth 3 -name 'net' -path '*/ns/*' -print0 | \
    xargs -0 -I{} readlink {} | sort -u

# BPF: trace namespace creation:
bpftrace -e '
kprobe:setup_net
{ printf("new net ns: pid=%d, comm=%s\n", pid, comm); }'
```

## Further reading

- [Container Isolation](container-isolation.md) — namespaces in containers
- [Namespaces](namespaces.md) — all Linux namespaces overview
- [Container Networking](container-networking.md) — veth, bridge, overlay
- [Netfilter](netfilter.md) — per-namespace iptables
- [sk_buff](sk-buff.md) — network buffers tagged with namespace
- `net/core/net_namespace.c` — network namespace lifecycle
- `man ip-netns` — ip netns command reference
