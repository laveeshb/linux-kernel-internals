# TUN/TAP Virtual Network Devices

> Userspace networking: how VPNs, QEMU, and container networks work

## What are TUN and TAP?

TUN and TAP are virtual network devices implemented entirely in software. They let userspace programs **send and receive network traffic** by reading and writing to a file descriptor.

```
Normal NIC:             Wire (hardware)
     ↕                         ↕
  kernel network stack  ←→  NIC driver
     ↕
  Application (socket)

TUN/TAP:               Userspace program (VPN, VM, etc.)
     ↕                         ↕
  kernel network stack  ←→  /dev/net/tun (file descriptor)
     ↕
  Application (socket)
```

| Feature | TUN | TAP |
|---------|-----|-----|
| Layer | Layer 3 (IP) | Layer 2 (Ethernet) |
| Frames | Raw IP packets | Full Ethernet frames (with MAC) |
| Use case | VPN tunnels (OpenVPN, WireGuard) | VM networking (QEMU), bridge |

## Creating a TUN interface

```c
#include <linux/if_tun.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>

int tun_alloc(char *dev, int flags)
{
    struct ifreq ifr = {};
    int fd, err;

    /* Open the clone device */
    fd = open("/dev/net/tun", O_RDWR);
    if (fd < 0)
        return fd;

    /* IFF_TUN  = TUN (IP) device */
    /* IFF_TAP  = TAP (Ethernet) device */
    /* IFF_NO_PI = don't prepend packet info header */
    ifr.ifr_flags = flags;  /* e.g., IFF_TUN | IFF_NO_PI */
    if (*dev)
        strncpy(ifr.ifr_name, dev, IFNAMSIZ);

    /* Register the TUN/TAP device */
    err = ioctl(fd, TUNSETIFF, &ifr);
    if (err < 0) {
        close(fd);
        return err;
    }

    /* dev is now filled with the assigned interface name, e.g., "tun0" */
    strcpy(dev, ifr.ifr_name);
    return fd;  /* fd is bound to the tun interface */
}

/* Usage: */
char tun_name[IFNAMSIZ] = "tun0";
int tun_fd = tun_alloc(tun_name, IFF_TUN | IFF_NO_PI);

/* Configure interface (equivalent to: ip link set tun0 up) */
/* ip addr add 10.0.0.1/24 dev tun0 */
```

## Reading and writing packets

```c
/* Reading: a packet arrived on the TUN interface */
uint8_t buf[65536];
ssize_t n = read(tun_fd, buf, sizeof(buf));
/* buf[0..n-1] is a raw IP packet (with IFF_NO_PI) */

/* Writing: inject a packet into the kernel network stack */
ssize_t sent = write(tun_fd, packet, packet_len);
/* The kernel treats this as if a packet arrived on tun0 */
```

## Minimal VPN server implementation

```c
/* Simplified: userspace VPN using TUN */

#define REMOTE_PORT 51820
#define MTU         1500

int main(void)
{
    /* Create TUN interface */
    char tun_name[IFNAMSIZ] = "vpn0";
    int tun_fd = tun_alloc(tun_name, IFF_TUN | IFF_NO_PI);

    /* UDP socket to the remote peer */
    int udp_fd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in remote = {
        .sin_family = AF_INET,
        .sin_port = htons(REMOTE_PORT),
    };
    inet_pton(AF_INET, "192.168.1.1", &remote.sin_addr);

    uint8_t buf[MTU + 28];  /* IP header headroom */

    /* Main forwarding loop */
    struct pollfd fds[2] = {
        { .fd = tun_fd, .events = POLLIN },
        { .fd = udp_fd, .events = POLLIN },
    };

    while (1) {
        poll(fds, 2, -1);

        if (fds[0].revents & POLLIN) {
            /* Packet from local applications → encrypt and send to peer */
            ssize_t n = read(tun_fd, buf, MTU);
            /* encrypt(buf, n) */
            sendto(udp_fd, buf, n, 0,
                   (struct sockaddr *)&remote, sizeof(remote));
        }

        if (fds[1].revents & POLLIN) {
            /* Packet from remote peer → decrypt and inject locally */
            ssize_t n = recv(udp_fd, buf, sizeof(buf), 0);
            /* decrypt(buf, n) */
            write(tun_fd, buf, n);
        }
    }
}
```

## WireGuard's TUN usage

WireGuard is implemented as a kernel module but uses the same TUN concept:

```bash
# WireGuard creates a virtual interface (wg0) backed by TUN internally
ip link add wg0 type wireguard
wg set wg0 private-key /etc/wireguard/privatekey \
           listen-port 51820 \
           peer <pubkey> allowed-ips 0.0.0.0/0 endpoint 1.2.3.4:51820
ip link set wg0 up
ip addr add 10.0.0.2/24 dev wg0

# Traffic to 10.0.0.0/24 → WireGuard encrypts → UDP to 1.2.3.4:51820
# Received UDP → WireGuard decrypts → appears to arrive on wg0
```

## TAP for VM networking (QEMU)

```bash
# QEMU uses TAP for full L2 networking (Ethernet frames):
ip tuntap add mode tap tap0
ip link set tap0 up

# Bridge tap0 with physical eth0:
ip link add br0 type bridge
ip link set eth0 master br0
ip link set tap0 master br0
ip link set br0 up

# QEMU uses tap0:
qemu-system-x86_64 \
    -netdev tap,id=net0,ifname=tap0,script=no,downscript=no \
    -device virtio-net-pci,netdev=net0 \
    ...
# Guest gets a full Ethernet interface, appears on the bridge
# Can get DHCP from the LAN, communicate with other VMs via br0
```

## Kernel implementation

### struct tun_struct

```c
/* drivers/net/tun.c */
struct tun_struct {
    struct tun_file __rcu   *tfiles[MAX_TAP_QUEUES]; /* file descriptors */
    unsigned int             numqueues;

    struct net_device       *dev;      /* the tun0/tap0 netdev */
    netdev_features_t        set_features;

    int                      vnet_hdr_sz;  /* for vhost/virtio zero-copy */
    int                      sndbuf;
    unsigned long            flags;
    /* IFF_TUN, IFF_TAP, IFF_NO_PI, IFF_VNET_HDR, IFF_MULTI_QUEUE */

    struct sock_fprog        fprog;    /* BPF filter on received packets */
    bool                     filter_attached;

    u32                      msg_enable;
    spinlock_t               lock;
    struct hlist_head        flows[TUN_NUM_FLOW_ENTRIES]; /* flow table */
    struct timer_list        flow_gc_timer;

    struct net               *net;     /* network namespace */
};
```

### Packet flow: write to TUN fd → kernel

```c
/* When userspace writes a packet to the TUN file descriptor: */
static ssize_t tun_chr_write_iter(struct kiocb *iocb, struct iov_iter *from)
{
    struct tun_file *tfile = file->private_data;
    struct tun_struct *tun = tun_get(tfile);
    struct sk_buff *skb;

    /* Build sk_buff from the userspace data */
    skb = tun_alloc_skb(tfile, align, len, gso.hdr_len, noblock);
    if (copy_from_iter(skb_put(skb, len), len, from) != len)
        goto drop;

    /* Set skb->protocol based on first byte (TUN) or Ethernet header (TAP) */
    skb->protocol = eth_type_trans(skb, tun->dev);

    /* Inject into the kernel network stack */
    netif_rx(skb);  /* → goes up through IP stack to sockets */

    return len;
}
```

### Packet flow: kernel → read from TUN fd

```c
/* When a packet is routed to the TUN device (written to userspace): */
static netdev_tx_t tun_net_xmit(struct sk_buff *skb, struct net_device *dev)
{
    struct tun_struct *tun = netdev_priv(dev);
    struct tun_file *tfile;

    /* Pick the appropriate queue (for multiqueue TUN) */
    tfile = rcu_dereference(tun->tfiles[txq]);

    /* Enqueue the sk_buff to the receive queue of the file descriptor */
    if (ptr_ring_produce(&tfile->tx_ring, skb))
        goto drop;

    /* Wake up userspace (poll/read will return POLLIN) */
    wake_up_interruptible_poll(&tfile->wq.wait, EPOLLIN | EPOLLRDNORM);

    return NETDEV_TX_OK;
drop:
    dev_kfree_skb(skb);
    return NETDEV_TX_OK;
}
```

## Multiqueue TUN (for performance)

```c
/* Enable multiqueue to use multiple CPU queues: */
ifr.ifr_flags = IFF_TUN | IFF_NO_PI | IFF_MULTI_QUEUE;

/* Open multiple fds, each is a separate queue: */
int fds[NUM_QUEUES];
for (int i = 0; i < NUM_QUEUES; i++) {
    char name[IFNAMSIZ] = "tun0";
    fds[i] = tun_alloc(name, IFF_TUN | IFF_NO_PI | IFF_MULTI_QUEUE);
    /* Each fd is pinned to a different CPU thread */
}
/* Kernel hashes packets to queues based on flow 5-tuple */
```

## vhost: kernel-accelerated TUN for QEMU

For VMs, **vhost** moves the TUN packet forwarding from QEMU userspace into the kernel, eliminating context switches:

```
Without vhost:
  Guest (VM) → virtio device → KVM VM exit → QEMU → write(tap_fd) → kernel

With vhost:
  Guest (VM) → virtio device → KVM VM exit → kernel vhost worker → tap_fd
  (no QEMU context switch for data path!)
```

```bash
# QEMU uses vhost automatically for virtio-net:
qemu-system-x86_64 \
    -netdev tap,id=net0,vhost=on \
    -device virtio-net-pci,netdev=net0 \
    ...
```

## Observing TUN/TAP

```bash
# List TUN/TAP interfaces:
ip tuntap list
# tun0: tun MULTI_QUEUE

# Interface stats:
ip -s link show tun0

# Trace TUN writes (packets from userspace):
bpftrace -e '
kprobe:tun_do_read {
    printf("TUN read: pid=%d dev=%s\n", pid,
           ((struct tun_struct *)arg0)->dev->name);
}'

# tcpdump on the TUN interface:
tcpdump -i tun0 -n

# Check vhost worker activity:
ps aux | grep vhost
cat /proc/$(pgrep vhost)/status
```

## Further reading

- [virtio](../virtualization/virtio.md) — paravirtual networking using TAP
- [Network Namespaces](net-namespaces.md) — isolated network stacks with veth pairs
- [NAPI](napi.md) — receive processing for real NICs
- [sk_buff](sk-buff.md) — packet data structure
- [XDP](xdp.md) — bypass the kernel stack entirely
- `drivers/net/tun.c` — complete TUN/TAP implementation
