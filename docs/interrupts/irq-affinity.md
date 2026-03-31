# IRQ Affinity and CPU Isolation

> Controlling which CPUs handle interrupts for performance and latency

## Why IRQ affinity matters

By default, the kernel distributes interrupts across CPUs automatically (`irqbalance` daemon). For latency-sensitive or high-throughput workloads, manual affinity control lets you:
- Dedicate CPUs to specific network queues (one queue per CPU)
- Isolate real-time tasks from interrupt storms
- Colocate IRQ handling with the NUMA node that owns the memory

## Viewing IRQ assignments

```bash
# List all IRQs with CPU affinity and counts
cat /proc/interrupts
# CPU0     CPU1     CPU2     CPU3
#   0:   ...   IO-APIC   2-edge      timer
#  16:   ...   PCI-MSI   xhci_hcd
# eth0-q0: (MSI-X queue 0)
# eth0-q1: (MSI-X queue 1)

# Show affinity for a specific IRQ
cat /proc/irq/42/smp_affinity      # bitmask (hex)
cat /proc/irq/42/smp_affinity_list # human-readable (CPU list)

# Example: IRQ 42 runs on CPU 0 and CPU 1
# /proc/irq/42/smp_affinity:      00000003  (CPUs 0,1)
# /proc/irq/42/smp_affinity_list: 0-1
```

## Setting IRQ affinity

```bash
# Pin IRQ 42 to CPU 3 only
echo 8 > /proc/irq/42/smp_affinity       # 0x8 = bit 3 = CPU 3
# or:
echo 3 > /proc/irq/42/smp_affinity_list  # CPU 3

# Pin to multiple CPUs (0 and 3):
echo 9 > /proc/irq/42/smp_affinity       # 0x9 = bits 0,3
echo 0,3 > /proc/irq/42/smp_affinity_list

# All CPUs:
echo ff > /proc/irq/42/smp_affinity      # 0xff = CPUs 0-7
```

### High-throughput NIC: one queue per CPU

```bash
# Find IRQ numbers for each NIC queue
grep 'eth0' /proc/interrupts
# 100:  0  0  0  0  PCI-MSI  eth0-q0
# 101:  0  0  0  0  PCI-MSI  eth0-q1
# 102:  0  0  0  0  PCI-MSI  eth0-q2
# 103:  0  0  0  0  PCI-MSI  eth0-q3

# Bind each queue to one CPU
echo 1  > /proc/irq/100/smp_affinity  # q0 → CPU 0
echo 2  > /proc/irq/101/smp_affinity  # q1 → CPU 1
echo 4  > /proc/irq/102/smp_affinity  # q2 → CPU 2
echo 8  > /proc/irq/103/smp_affinity  # q3 → CPU 3

# Also set XPS (Transmit Packet Steering) for TX:
echo 1 > /sys/class/net/eth0/queues/tx-0/xps_cpus  # tx-0 → CPU 0
echo 2 > /sys/class/net/eth0/queues/tx-1/xps_cpus  # tx-1 → CPU 1
```

## irqbalance: automatic balancing

`irqbalance` is a daemon that periodically rebalances IRQs across CPUs:

```bash
# Start/stop irqbalance
systemctl start irqbalance
systemctl stop irqbalance  # stop for manual control

# irqbalance policy hints
# Mark an IRQ as "performance" (don't move it):
IRQBALANCE_BANNED_IRQS="42 43"  # in /etc/sysconfig/irqbalance

# One-shot: balance and exit
irqbalance --oneshot

# Watch irqbalance decisions
irqbalance --debug --foreground 2>&1 | head -50
```

For latency-sensitive workloads, stop irqbalance and set affinity manually.

## Kernel API: irq_set_affinity_hint

Drivers can suggest preferred CPUs for their IRQs:

```c
#include <linux/interrupt.h>
#include <linux/cpumask.h>

/* Suggest CPU 3 for this IRQ (irqbalance will respect this hint) */
irq_set_affinity_hint(irq, cpumask_of(3));

/* Suggest a range of CPUs */
cpumask_t mask;
cpumask_clear(&mask);
cpumask_set_cpu(0, &mask);
cpumask_set_cpu(1, &mask);
irq_set_affinity_hint(irq, &mask);

/* Clear the hint */
irq_set_affinity_hint(irq, NULL);

/* Force affinity (bypasses irqbalance) */
irq_set_affinity(irq, &mask);
```

NIC drivers like mlx5 use `irq_set_affinity_hint` in their queue setup to suggest NUMA-local CPUs:

```c
/* net/ethernet/mellanox/mlx5/core/eq.c */
static int mlx5_irq_set_affinity_hint(struct mlx5_irq *irq, int i)
{
    struct cpumask *mask = mlx5_irq_get_affinity_mask(irq->pool, i);
    return irq_set_affinity_hint(irq->map.irq, mask);
}
```

## CPU isolation for real-time workloads

For real-time tasks that must not be interrupted, isolate CPUs from the kernel's scheduler and interrupt balancer:

### isolcpus: remove CPUs from the scheduler

```bash
# Boot parameter: remove CPUs 2,3 from scheduler load balancing
GRUB_CMDLINE_LINUX="isolcpus=2,3"

# After boot: CPUs 2,3 won't run kernel threads or normal processes
# Only explicitly placed tasks run there (taskset/cgroup cpuset)

# Place a task on an isolated CPU:
taskset -c 2 ./realtime_task

# Or via cgroup cpuset:
echo 2 > /sys/fs/cgroup/realtime/cpuset.cpus
echo 0 > /sys/fs/cgroup/realtime/cpuset.mems
```

### nohz_full: tickless operation

```bash
# Remove CPUs from the scheduling tick (reduces timer interrupts to ~0)
GRUB_CMDLINE_LINUX="isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3"

# nohz_full: disable the periodic scheduling tick when only 1 task runs
# rcu_nocbs: offload RCU callbacks from these CPUs to "RCU kthreads"

# Verify: after boot, isolated CPUs should have near-zero interrupts
watch -n1 'cat /proc/interrupts | head -5'
```

### irq_default_affinity: exclude isolated CPUs

```bash
# Set system-wide default affinity to exclude CPUs 2,3
echo 3 > /proc/irq/default_smp_affinity  # 0x3 = CPUs 0,1 only
# New IRQs will be placed on CPUs 0,1 by default
```

### Full isolation example (latency-critical CPU)

```bash
#!/bin/bash
# Isolate CPU 3 for a real-time task

CPU=3
MASK=$((1 << CPU))
HEX_MASK=$(printf '%x' $MASK)  # = "8" for CPU 3

# 1. Move all movable IRQs off CPU 3
for irq in /proc/irq/*/; do
    irq_num=$(basename $irq)
    [ "$irq_num" = "0" ] && continue  # skip timer
    current=$(cat /proc/irq/$irq_num/smp_affinity 2>/dev/null)
    # If current mask includes CPU 3, remove it
    new_mask=$(( 0x$current & ~MASK ))
    [ $new_mask -eq 0 ] && new_mask=1  # can't have empty mask
    echo $new_mask > /proc/irq/$irq_num/smp_affinity 2>/dev/null
done

# 2. Stop irqbalance from moving IRQs back
systemctl stop irqbalance

# 3. Move kernel threads off CPU 3 (optional, requires tuna)
tuna --cpus=3 --isolate

# 4. Pin the real-time task
taskset -c $CPU ./realtime_task &
```

## Monitoring interrupt distribution

```bash
# Live interrupt counts per CPU
watch -n0.5 'cat /proc/interrupts'

# Show interrupt rate per IRQ (sar)
sar -I ALL 1 5

# Total interrupts per CPU:
cat /proc/stat | grep intr

# IRQ affinity summary script:
for irq in /proc/irq/*/; do
    name=$(cat $irq/irq_name 2>/dev/null || basename $irq)
    aff=$(cat $irq/smp_affinity_list 2>/dev/null)
    printf "IRQ %-4s affinity=%-10s name=%s\n" $(basename $irq) "$aff" "$name"
done
```

## Receive Packet Steering (RPS/RFS)

For NICs with fewer hardware queues than CPUs, RPS steers packets to specific CPUs in software:

```bash
# Enable RPS: steer received packets across all CPUs
echo ff > /sys/class/net/eth0/queues/rx-0/rps_cpus  # all 8 CPUs

# RFS: steer to the CPU that last ran the application (cache-hot)
echo 4096 > /sys/class/net/eth0/queues/rx-0/rps_flow_cnt
echo 4096 > /proc/sys/net/core/rps_sock_flow_entries
```

RPS is implemented as a softirq that moves packet processing to the target CPU via IPI (inter-processor interrupt).

## Further reading

- [IRQ Descriptor and irq_chip](irq-desc.md) — struct irq_desc internals
- [request_irq and free_irq](request-irq.md) — IRQ handler registration
- [Threaded IRQs](threaded-irq.md) — threaded IRQ handlers for latency
- [PCI Drivers](../drivers/pci-driver.md) — MSI-X affinity in NIC drivers
- [CPU Affinity](../sched/cpu-affinity.md) — process CPU pinning
- [Scheduling Domains](../sched/sched-domains.md) — scheduler topology
- `kernel/irq/manage.c` — irq_set_affinity implementation
