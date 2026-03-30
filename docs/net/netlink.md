# Netlink

> Kernel-userspace communication for network configuration tools

## What is Netlink?

Netlink is a socket-based IPC mechanism for communication between userspace and the kernel. It's how most network configuration tools work:

| Tool | Netlink family | Purpose |
|------|---------------|---------|
| `ip link`, `ip addr` | `NETLINK_ROUTE` (rtnetlink) | Interface/address/route management |
| `ss`, `netstat` | `NETLINK_SOCK_DIAG` | Socket statistics |
| `ethtool` | `NETLINK_GENERIC` (ethtool_nl) | NIC configuration |
| `iw`, `nmcli` | `NETLINK_GENERIC` (nl80211) | WiFi configuration |
| `tc` | `NETLINK_ROUTE` | Traffic control |
| `nftables` | `NETLINK_NETFILTER` | Firewall rules |
| `audit` | `NETLINK_AUDIT` | Audit subsystem |
| `uevent` | `NETLINK_KOBJECT_UEVENT` | Device hotplug events |

## Netlink socket basics

```c
#include <linux/netlink.h>
#include <sys/socket.h>

/* Open a Netlink socket */
int fd = socket(AF_NETLINK, SOCK_RAW, NETLINK_ROUTE);

/* Bind: register our PID */
struct sockaddr_nl addr = {
    .nl_family = AF_NETLINK,
    .nl_pid    = getpid(),   /* 0 = kernel assigns */
    .nl_groups = 0,          /* multicast groups (see below) */
};
bind(fd, (struct sockaddr *)&addr, sizeof(addr));
```

## Netlink message format

Every Netlink message has a fixed header:

```c
/* include/uapi/linux/netlink.h */
struct nlmsghdr {
    __u32 nlmsg_len;    /* Total length including header */
    __u16 nlmsg_type;   /* Message type (family-specific) */
    __u16 nlmsg_flags;  /* Flags: NLM_F_REQUEST, NLM_F_ACK, NLM_F_DUMP, ... */
    __u32 nlmsg_seq;    /* Sequence number (for matching replies) */
    __u32 nlmsg_pid;    /* Sender PID (0 = kernel) */
    /* Payload follows: family-specific struct + attributes */
};
```

Common flags:
- `NLM_F_REQUEST`: this is a request to the kernel
- `NLM_F_ACK`: request an acknowledgement
- `NLM_F_DUMP`: dump all objects of this type
- `NLM_F_CREATE`: create if not exists (add operations)
- `NLM_F_EXCL`: fail if exists (add operations)

## rtnetlink: network interface management

`NETLINK_ROUTE` (rtnetlink) is used by `ip` to manage interfaces, addresses, and routes.

### List all interfaces (GETLINK dump)

```c
#include <linux/rtnetlink.h>
#include <net/if.h>

/* Build a RTM_GETLINK dump request */
struct {
    struct nlmsghdr nlh;
    struct ifinfomsg ifi;
} req = {
    .nlh = {
        .nlmsg_len   = NLMSG_LENGTH(sizeof(struct ifinfomsg)),
        .nlmsg_type  = RTM_GETLINK,
        .nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP,
        .nlmsg_seq   = 1,
    },
    .ifi = {
        .ifi_family = AF_UNSPEC,
    },
};

send(fd, &req, req.nlh.nlmsg_len, 0);

/* Read replies (multiple messages, one per interface) */
char buf[8192];
while (1) {
    ssize_t n = recv(fd, buf, sizeof(buf), 0);
    struct nlmsghdr *nlh = (struct nlmsghdr *)buf;

    for (; NLMSG_OK(nlh, n); nlh = NLMSG_NEXT(nlh, n)) {
        if (nlh->nlmsg_type == NLMSG_DONE)
            goto done;
        if (nlh->nlmsg_type == RTM_NEWLINK) {
            struct ifinfomsg *ifi = NLMSG_DATA(nlh);
            /* Parse attributes */
            struct rtattr *rta = IFLA_RTA(ifi);
            int len = IFLA_PAYLOAD(nlh);
            for (; RTA_OK(rta, len); rta = RTA_NEXT(rta, len)) {
                if (rta->rta_type == IFLA_IFNAME)
                    printf("interface: %s\n", (char *)RTA_DATA(rta));
                if (rta->rta_type == IFLA_MTU)
                    printf("mtu: %u\n", *(uint32_t *)RTA_DATA(rta));
            }
        }
    }
}
done:;
```

### Netlink attributes (rtattr / nlattr)

Netlink uses a TLV (Type-Length-Value) attribute format:

```c
/* rtattr format: */
struct rtattr {
    unsigned short rta_len;   /* Total length including header */
    unsigned short rta_type;  /* Attribute type */
    /* Data follows */
};

/* Parse: RTA_DATA(rta) points to the attribute data */
/* Nested: RTA_DATA(rta) is itself a list of rtatrr */

/* Modern generic netlink uses nlattr with same layout: */
struct nlattr {
    __u16 nla_len;
    __u16 nla_type;  /* Top 2 bits: NLA_F_NESTED, NLA_F_NET_BYTEORDER */
};
```

### RTM_NEWROUTE: add a route

```c
/* Add route: 10.0.0.0/8 via 192.168.1.1 dev eth0 */
struct {
    struct nlmsghdr  nlh;
    struct rtmsg     rtm;
    char             attrs[256];
} req = {};

req.nlh.nlmsg_len   = NLMSG_LENGTH(sizeof(req.rtm));
req.nlh.nlmsg_type  = RTM_NEWROUTE;
req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_CREATE | NLM_F_ACK;
req.nlh.nlmsg_seq   = 2;

req.rtm.rtm_family   = AF_INET;
req.rtm.rtm_dst_len  = 8;   /* prefix length */
req.rtm.rtm_table    = RT_TABLE_MAIN;
req.rtm.rtm_protocol = RTPROT_STATIC;
req.rtm.rtm_scope    = RT_SCOPE_UNIVERSE;
req.rtm.rtm_type     = RTN_UNICAST;

/* Add destination: RTA_DST */
uint32_t dst = inet_addr("10.0.0.0");
addattr_l(&req.nlh, sizeof(req), RTA_DST, &dst, 4);

/* Add gateway: RTA_GATEWAY */
uint32_t gw = inet_addr("192.168.1.1");
addattr_l(&req.nlh, sizeof(req), RTA_GATEWAY, &gw, 4);

/* Add interface index: RTA_OIF */
int ifidx = if_nametoindex("eth0");
addattr32(&req.nlh, sizeof(req), RTA_OIF, ifidx);

send(fd, &req, req.nlh.nlmsg_len, 0);
/* Read ACK to confirm success */
```

## Generic Netlink (genetlink)

Generic Netlink is a multiplexer that allows kernel subsystems to define their own message families without using a reserved `NETLINK_*` protocol number.

```
AF_NETLINK + NETLINK_GENERIC
    ↓
genetlink dispatcher
    ├── family "ethtool"   → ethtool_nl handlers
    ├── family "nl80211"   → cfg80211 handlers
    ├── family "nlctrl"    → list families
    └── family "devlink"   → devlink handlers
```

### Using libnl3

Most tools use `libnl3` rather than raw sockets:

```c
#include <netlink/netlink.h>
#include <netlink/genl/genl.h>
#include <netlink/genl/ctrl.h>

struct nl_sock *sock = nl_socket_alloc();
genl_connect(sock);

/* Resolve family name to ID */
int family = genl_ctrl_resolve(sock, "nl80211");

/* Build and send a message */
struct nl_msg *msg = nlmsg_alloc();
genlmsg_put(msg, NL_AUTO_PORT, NL_AUTO_SEQ, family, 0, 0,
            NL80211_CMD_GET_INTERFACE, 0);
nla_put_u32(msg, NL80211_ATTR_IFINDEX, if_nametoindex("wlan0"));

nl_send_auto(sock, msg);
nlmsg_free(msg);

/* Receive and parse reply */
nl_recvmsgs_default(sock);
```

## Kernel side: registering a genetlink family

```c
/* net/wireless/nl80211.c (simplified) */
#include <net/genetlink.h>

static const struct genl_ops nl80211_ops[] = {
    {
        .cmd    = NL80211_CMD_GET_INTERFACE,
        .doit   = nl80211_get_interface,
        .dumpit = nl80211_dump_interface,
        .policy = nl80211_policy,
    },
    {
        .cmd    = NL80211_CMD_SET_INTERFACE,
        .doit   = nl80211_set_interface,
        .flags  = GENL_ADMIN_PERM,  /* requires CAP_NET_ADMIN */
    },
    /* ... many more ... */
};

static struct genl_family nl80211_fam __ro_after_init = {
    .name     = NL80211_GENL_NAME,   /* "nl80211" */
    .version  = 1,
    .maxattr  = NL80211_ATTR_MAX,
    .policy   = nl80211_policy,
    .module   = THIS_MODULE,
    .ops      = nl80211_ops,
    .n_ops    = ARRAY_SIZE(nl80211_ops),
    .mcgrps   = nl80211_mcgrps,      /* multicast groups */
    .n_mcgrps = ARRAY_SIZE(nl80211_mcgrps),
};

static int __init nl80211_init(void)
{
    return genl_register_family(&nl80211_fam);
}
```

## Netlink multicast: event notifications

Netlink multicast allows the kernel to push events to interested userspace processes:

```c
/* Subscribe to route change events */
struct sockaddr_nl addr = {
    .nl_family = AF_NETLINK,
    .nl_groups = RTMGRP_LINK        /* interface changes */
              | RTMGRP_IPV4_IFADDR  /* address changes */
              | RTMGRP_IPV4_ROUTE,  /* route changes */
};
bind(fd, (struct sockaddr *)&addr, sizeof(addr));

/* Now recv() will receive RTM_NEWLINK, RTM_NEWADDR, RTM_NEWROUTE events
   without sending any request */

/* systemd-networkd, NetworkManager, and dhclient use this to detect
   cable plug/unplug, DHCP lease changes, etc. */
```

### Kernel side: sending a multicast notification

```c
/* net/core/rtnetlink.c */
/* Called when an interface comes up: */
void rtmsg_ifinfo(int type, struct net_device *dev, unsigned int change,
                   gfp_t flags)
{
    struct sk_buff *skb = rtmsg_ifinfo_build_skb(type, dev, change,
                                                    0, flags, NULL, 0, 0);
    if (skb) {
        /* Send to RTNLGRP_LINK multicast group */
        rtnl_notify(skb, dev_net(dev), 0, RTNLGRP_LINK, NULL, flags);
    }
}
```

## NETLINK_SOCK_DIAG: socket statistics

Used by `ss` to list sockets faster than `/proc/net/tcp`:

```c
/* Request TCP socket dump */
struct {
    struct nlmsghdr nlh;
    struct inet_diag_req_v2 req;
} request = {
    .nlh = {
        .nlmsg_len   = sizeof(request),
        .nlmsg_type  = SOCK_DIAG_BY_FAMILY,
        .nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP,
    },
    .req = {
        .sdiag_family   = AF_INET,
        .sdiag_protocol = IPPROTO_TCP,
        .idiag_states   = (1 << TCP_ESTABLISHED) | (1 << TCP_LISTEN),
        .idiag_ext      = (1 << (INET_DIAG_INFO - 1)),  /* get tcp_info */
    },
};
send(fd, &request, sizeof(request), 0);
/* Receive: one INET_DIAG_INFO per socket */
```

## Further reading

- [Socket Layer Overview](socket-layer.md) — AF_NETLINK socket implementation
- [procfs and sysfs](../vfs/procfs-sysfs.md) — alternative kernel-userspace interfaces
- [XDP and AF_XDP](af-xdp.md) — socket-based packet processing
- [Network Debugging](net-debugging.md) — `ss` and `ip` command internals
- `net/netlink/` — core netlink implementation
- `net/core/rtnetlink.c` — rtnetlink
- `net/wireless/nl80211.c` — nl80211 genetlink family
- `libnl3` documentation — userspace netlink library
