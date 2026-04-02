# Cgroup BPF Programs

> Attaching eBPF programs to cgroups for network policy, device control, and resource accounting

## Overview

BPF programs can be attached to cgroup directories and run for every process in that cgroup and its descendants. This gives you programmable, per-cgroup policy without patching the kernel or writing kernel modules. A cgroup BPF program executes in the kernel at a well-defined hook point — a socket being created, a packet arriving, a device node being opened — and decides what to do.

Unlike traditional cgroup controllers (which expose a fixed set of interface files), cgroup BPF lets you express arbitrary policy in a verified, sandboxed program. The same mechanism powers Kubernetes NetworkPolicy enforcement, container device whitelists, and per-service TCP tuning.

## Attach types

Attach types are defined in `include/uapi/linux/bpf.h` as `enum bpf_attach_type`. The cgroup-related ones:

### Network packet filtering

`BPF_CGROUP_INET_INGRESS` / `BPF_CGROUP_INET_EGRESS`

Called for every IPv4/IPv6 packet sent or received by a socket owned by a process in the cgroup. The program receives an `__sk_buff` context and returns:

- `1` — pass the packet
- `0` — drop the packet

```c
/* Egress: drop all packets to 10.0.0.0/8 from this cgroup */
SEC("cgroup_skb/egress")
int block_internal(struct __sk_buff *skb)
{
    void *data     = (void *)(long)skb->data;
    void *data_end = (void *)(long)skb->data_end;
    struct iphdr *ip = data;

    if (ip + 1 > data_end)
        return 1;

    /* Drop packets destined for 10.0.0.0/8 */
    if ((bpf_ntohl(ip->daddr) & 0xff000000) == 0x0a000000)
        return 0;
    return 1;
}
```

### Socket creation control

`BPF_CGROUP_INET_SOCK_CREATE`

Called when `socket()` is invoked by a process in the cgroup. The program receives a `struct bpf_sock` and can deny socket creation by returning `0`:

```c
SEC("cgroup/sock_create")
int restrict_raw_sockets(struct bpf_sock *sk)
{
    /* Deny raw socket creation (SOCK_RAW) — only allow STREAM and DGRAM */
    if (sk->type == SOCK_RAW)
        return 0;
    return 1;
}
```

This is lighter-weight than seccomp filtering on `socket()` because the BPF program has access to socket metadata without needing to decode syscall arguments.

### TCP lifecycle hooks

`BPF_CGROUP_SOCK_OPS`

Called at multiple TCP lifecycle events — connection established, timeout, retransmit, RTO change — and can query or set socket options per-cgroup. The program receives a `struct bpf_sock_ops`:

```c
SEC("sockops")
int set_buffer_sizes(struct bpf_sock_ops *skops)
{
    switch (skops->op) {
    case BPF_SOCK_OPS_ACTIVE_ESTABLISHED_CB:
        /* Connection established (client side): increase TCP send buffer */
        bpf_setsockopt(skops, SOL_SOCKET, SO_SNDBUF, &(int){4 * 1024 * 1024},
                       sizeof(int));
        break;
    case BPF_SOCK_OPS_PASSIVE_ESTABLISHED_CB:
        /* Connection established (server side) */
        bpf_setsockopt(skops, SOL_SOCKET, SO_RCVBUF, &(int){4 * 1024 * 1024},
                       sizeof(int));
        break;
    }
    return 1;
}
```

Attaching this to a service's cgroup applies the TCP tuning to all sockets opened by that service — without touching the global `sysctl` values that affect all processes on the host.

### Device access control

`BPF_CGROUP_DEVICE`

Called when a process in the cgroup attempts to `open()`, `mknod()`, or `access()` a device node. The program receives a `struct bpf_cgroup_dev_ctx` describing the device major/minor and the requested access type (`BPF_DEVCG_ACC_READ`, `BPF_DEVCG_ACC_WRITE`, `BPF_DEVCG_ACC_MKNOD`), and returns `1` to allow or `0` to deny:

```c
SEC("cgroup/dev")
int device_policy(struct bpf_cgroup_dev_ctx *ctx)
{
    /* Allow access only to /dev/null (1:3) and /dev/zero (1:5) */
    if (ctx->major == 1 && (ctx->minor == 3 || ctx->minor == 5))
        return 1;
    /* Allow /dev/pts/* (136:*) for terminal emulators */
    if (ctx->major == 136)
        return 1;
    return 0;
}
```

`BPF_CGROUP_DEVICE` is the cgroup v2 replacement for the legacy `devices` cgroup v1 controller. The v1 controller exposed `devices.allow` / `devices.deny` files; cgroup v2 dropped the `devices` controller entirely and relies on `BPF_CGROUP_DEVICE` instead. Container runtimes like runc generate and load a `BPF_CGROUP_DEVICE` program from the OCI spec's `linux.resources.devices` list.

### Sysctl interception

`BPF_CGROUP_SYSCTL`

Called when a process reads or writes a sysctl under `/proc/sys`. The program receives a `struct bpf_sysctl` and can inspect or modify the value, or deny the operation:

```c
SEC("cgroup/sysctl")
int sysctl_filter(struct bpf_sysctl *ctx)
{
    /* Deny writes to net.core.somaxconn from within the cgroup */
    char name[64] = {};
    bpf_sysctl_get_name(ctx, name, sizeof(name), 0);
    if (ctx->write && __builtin_memcmp(name, "net/core/somaxconn", 18) == 0)
        return 0;
    return 1;
}
```

### Socket option interception

`BPF_CGROUP_GETSOCKOPT` / `BPF_CGROUP_SETSOCKOPT`

Called when `getsockopt(2)` or `setsockopt(2)` is issued. The program can override the option value seen by the application (useful for returning per-cgroup defaults) or block certain socket options entirely.

## Attach flags

When attaching a program with `bpf(BPF_PROG_ATTACH, ...)`, the `flags` field controls the hierarchy behavior:

| Flag | Meaning |
|------|---------|
| (none / `0`) | Exclusive: only one program per cgroup per attach type; child cgroups inherit but cannot override |
| `BPF_F_ALLOW_OVERRIDE` | Child cgroups can replace this program with their own |
| `BPF_F_ALLOW_MULTI` | Multiple programs can be attached; both parent and child programs run (in order, parent first) |

`BPF_F_ALLOW_MULTI` is the most common in practice — it allows a platform-level policy at the root cgroup and per-container refinements in child cgroups, with both executing.

## The syscall interface

```c
/* Attach a program to a cgroup */
union bpf_attr attr = {
    .target_fd   = cgroup_fd,           /* open("/sys/fs/cgroup/c1", O_RDONLY) */
    .attach_bpf_fd = prog_fd,           /* loaded BPF program fd */
    .attach_type = BPF_CGROUP_INET_EGRESS,
    .attach_flags = BPF_F_ALLOW_MULTI,
};
bpf(BPF_PROG_ATTACH, &attr, sizeof(attr));

/* Detach */
attr.attach_bpf_fd = prog_fd;
bpf(BPF_PROG_DETACH, &attr, sizeof(attr));

/* Query programs attached to a cgroup */
attr.query.target_fd  = cgroup_fd;
attr.query.attach_type = BPF_CGROUP_INET_EGRESS;
bpf(BPF_PROG_QUERY, &attr, sizeof(attr));
```

With `libbpf`, the higher-level API is `bpf_prog_attach()` / `bpf_prog_detach()`.

## Practical example: per-container egress rate limiting

Cgroup BPF does not provide a built-in rate-limiter (that is the job of the `io` controller for block I/O, or TC for network). The pattern is to combine a `BPF_CGROUP_INET_EGRESS` program with a TC `qdisc` (e.g., `tbf` or `fq`) on the container's `veth` interface:

```bash
# 1. Create a veth pair for the container
ip link add veth0 type veth peer name eth0

# 2. Attach a TBF qdisc to veth0 (host side) — 10Mbit/s
tc qdisc add dev veth0 root tbf rate 10mbit burst 32kbit latency 400ms

# 3. Attach a BPF program to the container's cgroup that marks packets
#    (sets skb->mark) so the TC classifier can identify per-cgroup flows
bpftool prog load mark_egress.bpf.o /sys/fs/bpf/mark_egress
bpftool cgroup attach /sys/fs/cgroup/containers/c1/ egress \
    pinned /sys/fs/bpf/mark_egress allow_multi
```

The BPF program itself uses `bpf_skb_store_bytes()` or sets `skb->mark` to a container ID, and TC flower/u32 classifiers match on the mark to apply per-container `tbf` qdiscs.

For a purely BPF approach, a custom token-bucket implemented in a `BPF_MAP_TYPE_ARRAY` (with atomic operations) can rate-limit packets directly from the `BPF_CGROUP_INET_EGRESS` hook by dropping packets when the bucket is empty.

## Inspecting attached programs

```bash
# Show all BPF programs attached to a cgroup subtree:
bpftool cgroup tree /sys/fs/cgroup/containers/c1/

# Show programs attached to a single cgroup directory:
bpftool cgroup show /sys/fs/cgroup/

# Example output:
# /sys/fs/cgroup/containers/c1
# ID       AttachType      AttachFlags     Name
# 42       egress          multi           block_internal
# 43       device          multi           device_policy
```

`bpftool cgroup tree` recurses through the hierarchy and lists every attached program with its ID, name, and flags. Use `bpftool prog show id 42` to inspect a specific program's bytecode, maps, and BTF information.

## Kernel implementation

The kernel runs cgroup BPF programs from the hot paths of network, socket, and device subsystems. The internal entry points use the `__cgroup_bpf_run_filter_*()` family (double-underscore prefix), defined in `include/linux/bpf-cgroup.h` and invoked via `BPF_CGROUP_RUN_PROG_*` wrapper macros:

```c
/* include/linux/bpf-cgroup.h (simplified signatures) */
int __cgroup_bpf_run_filter_skb(struct sock *sk, struct sk_buff *skb,
                                 enum cgroup_bpf_attach_type atype);
int __cgroup_bpf_run_filter_sk(struct sock *sk,
                                enum cgroup_bpf_attach_type atype);
int __cgroup_bpf_run_filter_sock_ops(struct sock *sk,
                                     struct bpf_sock_ops_kern *sock_ops,
                                     enum cgroup_bpf_attach_type atype);
int __cgroup_bpf_check_dev_permission(short dev_type, u32 major, u32 minor,
                                       short access,
                                       enum cgroup_bpf_attach_type atype);
```

These are invoked via macros from:
- `net/ipv4/ip_output.c`, `net/ipv6/ip6_output.c` → `BPF_CGROUP_RUN_PROG_INET_EGRESS`
- `net/core/dev.c` (`__netif_receive_skb_core`) → `BPF_CGROUP_RUN_PROG_INET_INGRESS`
- `net/ipv4/af_inet.c` (`inet_create`) → `BPF_CGROUP_RUN_PROG_INET_SOCK`
- `security/device_cgroup.c` (`devcgroup_check_permission`) → `BPF_CGROUP_RUN_PROG_DEVICE_CGROUP`

The `struct cgroup_bpf` embedded in `struct cgroup` holds the attached programs:

```c
/* include/linux/bpf-cgroup-defs.h */
struct cgroup_bpf {
    /*
     * effective[] holds the effective set of programs for this cgroup —
     * programs attached here plus inherited from ancestors (flattened).
     */
    struct bpf_prog_array __rcu *effective[MAX_CGROUP_BPF_ATTACH_TYPE];

    /* programs attached directly to this cgroup */
    struct hlist_head     progs[MAX_CGROUP_BPF_ATTACH_TYPE];
    u8                    flags[MAX_CGROUP_BPF_ATTACH_TYPE];

    struct list_head      storages;
    struct bpf_prog_array *inactive; /* for RCU update */
};
```

When a program is attached, `update_effective_progs()` (called from `__cgroup_bpf_attach()`) walks from root to the target cgroup and rebuilds the `effective[]` prog arrays for the cgroup and all its descendants. `cgroup_bpf_inherit()` is a separate function called only at cgroup creation time to copy inherited programs from the parent. The hot path only dereferences `effective[]` via `BPF_PROG_RUN_ARRAY()` — there is no hierarchy walk at runtime.

## Further reading

- [Cgroup v2 Architecture](cgroup-v2.md) — `struct cgroup` and the unified hierarchy
- [Container Isolation](container-isolation.md) — how BPF device policy fits with seccomp and capabilities
- [BPF Networking (TC, cgroup, sockmap)](../bpf/bpf-networking.md) — TC-based rate limiting alongside cgroup BPF
- [BPF Verifier](../bpf/bpf-verifier.md) — how BPF programs are safety-checked before attachment
- `kernel/bpf/cgroup.c` — attach/detach/run implementation
- `include/uapi/linux/bpf.h` — `enum bpf_attach_type` and all `BPF_CGROUP_*` constants
- `tools/bpf/bpftool/cgroup.c` — bpftool cgroup subcommand implementation
- `Documentation/bpf/prog_cgroup_skb.rst` — upstream documentation
