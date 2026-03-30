# Network Device and NAPI

> How the kernel receives packets from hardware: interrupt mitigation and polling

## The problem NAPI solves

Before NAPI (New API), each arriving packet triggered a hardware interrupt. At low traffic rates, this works fine. Under high load — say, 10 Gbps with 64-byte packets — the NIC fires hundreds of thousands of interrupts per second. The kernel spends more time handling interrupts than processing packets: **interrupt livelock**.

NAPI solves this by switching to a polling model when traffic is high:

1. A packet arrives → NIC fires interrupt
2. Kernel disables further NIC interrupts
3. Kernel polls the NIC ring buffer for more packets
4. After processing a budget of packets, re-enable interrupts

This batches work and dramatically reduces interrupt overhead at high packet rates.

## struct napi_struct

Each network device (or each queue on a multi-queue NIC) has one `napi_struct`:

```c
// include/linux/netdevice.h
struct napi_struct {
    struct list_head    poll_list;    // on this CPU's softirq poll list
    unsigned long       state;        // NAPI_STATE_SCHED, NAPI_STATE_DISABLE, ...
    int                 weight;       // max packets per poll() call (budget)
    int                 (*poll)(struct napi_struct *, int);  // driver's poll function

    struct net_device   *dev;
    struct hrtimer      timer;        // for threaded NAPI or deferred processing

    u32                 napi_id;      // unique ID for busy polling
    int                 index;        // queue index on the device

    // GRO (Generic Receive Offload) state
    struct gro_node     gro;
};
```

## The NAPI receive flow

```
1. Packet arrives in NIC ring buffer
2. NIC raises interrupt
        ↓
3. Hard IRQ handler (driver's irq_handler):
   - napi_schedule(&napi)    → sets NAPI_STATE_SCHED
   - disable NIC interrupt    (no more hardware interrupts)
   - return IRQ_HANDLED
        ↓
4. Soft IRQ (NET_RX_SOFTIRQ) runs on the same CPU:
   - net_rx_action() polls all scheduled NAPI instances
        ↓
5. Driver's poll() function:
   for each packet (up to budget):
       skb = napi_build_skb(rx_buf, headroom)
       __netif_receive_skb(skb)  → route up the stack
   if (processed < budget):
       napi_complete_done(&napi, processed)  → re-enable interrupt
   else:
       return budget  → more work, stay scheduled
```

## Driver implementation pattern

```c
// Interrupt handler
static irqreturn_t my_nic_interrupt(int irq, void *dev_id)
{
    struct my_nic *nic = dev_id;
    // Disable interrupts for this NIC queue
    my_nic_disable_irq(nic);
    // Schedule NAPI poll
    napi_schedule(&nic->napi);
    return IRQ_HANDLED;
}

// NAPI poll function
static int my_nic_poll(struct napi_struct *napi, int budget)
{
    struct my_nic *nic = container_of(napi, struct my_nic, napi);
    int processed = 0;

    while (processed < budget) {
        struct sk_buff *skb = my_nic_receive_one(nic);
        if (!skb)
            break;
        napi_gro_receive(napi, skb);  // pass to GRO + network stack
        processed++;
    }

    if (processed < budget) {
        // No more packets: exit polling mode, re-enable interrupts
        napi_complete_done(napi, processed);
        my_nic_enable_irq(nic);
    }

    return processed;
}
```

## NAPI budget

The budget (default: 64 packets per poll call) is a fairness mechanism — one heavily-loaded NIC can't monopolize the softirq CPU. After 64 packets, the softirq handler yields and lets other work run.

```bash
# Adjust NAPI budget (per device)
ethtool -G eth0 rx 4096  # increase ring buffer size

# The global budget is in /proc/sys/net/core/netdev_budget
cat /proc/sys/net/core/netdev_budget  # default: 300
echo 600 > /proc/sys/net/core/netdev_budget  # for high-throughput workloads

# Time limit for a single poll cycle
cat /proc/sys/net/core/netdev_budget_usecs  # default: 2000 (2ms)
```

## GRO: Generic Receive Offload

GRO merges multiple small TCP segments into a single large `sk_buff` before passing up the stack, reducing per-packet overhead:

```c
// Driver calls napi_gro_receive() instead of netif_receive_skb()
// GRO accumulates segments from the same TCP flow
// When done, delivers a large merged skb up the stack
napi_gro_receive(napi, skb);
```

```bash
# Check GRO is enabled
ethtool -k eth0 | grep generic-receive-offload
# generic-receive-offload: on

# Disable GRO (for debugging or when GRO adds latency)
ethtool -K eth0 gro off
```

## struct net_device

```c
// include/linux/netdevice.h (key fields)
struct net_device {
    char            name[IFNAMSIZ];  // "eth0", "lo", etc.
    unsigned long   state;           // __LINK_STATE_START, etc.
    struct netdev_queue *_tx;        // transmit queues (array)
    struct Qdisc    *qdisc;          // traffic control qdisc

    const struct net_device_ops *netdev_ops;  // driver operations

    unsigned int    flags;           // IFF_UP, IFF_BROADCAST, IFF_PROMISC, ...
    unsigned int    mtu;             // maximum transmission unit

    // Stats
    struct net_device_stats stats;   // rx/tx packets, bytes, errors
    // ...
};
```

## Threaded NAPI

For workloads that need predictable latency, NAPI can run in a kernel thread instead of a softirq:

```bash
# Enable threaded NAPI for all NICs
echo 1 > /sys/class/net/eth0/threaded

# The kernel creates "napi/eth0-0" etc. kthreads
# These can be pinned to CPUs for better cache locality
taskset -cp 4 $(pgrep "napi/eth0-0")
```

Threaded NAPI allows the poll function to sleep (e.g., for GRO flush timers) and gives the scheduler full control over poll CPU placement.

## Busy polling

For ultra-low-latency applications, busy polling bypasses softirq and polls the NIC directly from user context:

```bash
# Enable busy polling
echo 50 > /proc/sys/net/core/busy_poll    # poll for 50µs
echo 50 > /proc/sys/net/core/busy_read    # also on recv()

# Per-socket (SO_BUSY_POLL option)
setsockopt(fd, SOL_SOCKET, SO_BUSY_POLL, &timeout_us, sizeof(timeout_us));
```

This trades CPU cycles for latency — the application spins polling the NIC instead of sleeping and being woken by softirq.

## RPS/RFS: multi-CPU receive scaling

A single-queue NIC delivers all packets to one CPU. **RPS (Receive Packet Steering)** distributes packets across CPUs in software:

```bash
# Distribute receive processing across CPUs 0-7
echo ff > /sys/class/net/eth0/queues/rx-0/rps_cpus

# RFS (Receive Flow Steering): steer packets to the CPU where the
# application is running (improves cache locality)
echo 32768 > /proc/sys/net/core/rps_sock_flow_entries
echo 2048  > /sys/class/net/eth0/queues/rx-0/rps_flow_cnt
```

Modern multi-queue NICs with RSS (Receive Side Scaling) do this in hardware, distributing flows across hardware queues — one NAPI instance per queue.

## Diagnosing receive performance

```bash
# RX drop counters
ethtool -S eth0 | grep -i drop

# Softirq statistics (NET_RX_SOFTIRQ overruns)
cat /proc/net/softnet_stat
# Columns: total, dropped, time_squeeze, [cpu_collision], [received_rps], [flow_limit_count]
# time_squeeze: poll ran out of budget (consider increasing netdev_budget)
# dropped: packet dropped due to backlog overflow

# Interrupts per CPU
cat /proc/interrupts | grep eth0

# Check GRO merging stats
ethtool -S eth0 | grep gro
```

## Further reading

- [sk_buff](sk-buff.md) — The packet structure built during receive
- [Life of a Packet (receive)](life-of-packet-rx.md) — Full receive path beyond NAPI
- [Socket Layer Overview](socket-layer.md) — Where packets go after network layer processing
- [XDP](xdp.md) — Processing packets even earlier, before sk_buff allocation
