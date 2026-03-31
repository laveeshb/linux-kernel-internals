# MSI and MSI-X: PCIe Message-Signaled Interrupts

> Replacing legacy INTx with per-queue interrupt vectors for NVMe, NIC, and GPU

## Why MSI-X?

Legacy PCI interrupts (INTx, INTA-INTD) have fundamental limitations:
- **Shared**: multiple devices share one IRQ line → spurious interrupts, no isolation
- **Level-triggered**: interrupt line held until acknowledged → cannot miss (line stays asserted until cleared); edge-triggered interrupts can be missed if the transition occurs while masked
- **Limited**: only 4 lines per PCI bus

MSI (Message-Signaled Interrupts) solves these by using memory writes instead of dedicated wires:

```
Legacy INTx:
  Device → asserts pin → CPU interrupt controller → CPU

MSI/MSI-X:
  Device → writes message to memory address (MSI address reg) → CPU
           This write IS the interrupt — the memory write triggers the CPU
```

**MSI-X** extends MSI to 2048 vectors per device (vs 32 for MSI), and each vector can have independent affinity.

## MSI capability structure

```
PCI config space:
  [PCI header]
  [Capabilities list]
    └── MSI capability (cap ID = 0x05):
         offset  size  field
         00      1     Capability ID (0x05)
         01      1     Next Pointer
         02-03   2     Message Control
                         [0]: MSI Enable
                         [3:1]: Multiple Message Capable (log2 of requested vectors)
                         [6:4]: Multiple Message Enable
                         [7]: 64-bit capable
         04-07   4     Message Address (low 32 bits, 4-byte aligned)
         08-0B   4     Message Address High (if 64-bit)
         0C-0D   2     Message Data
                         CPU writes: APIC ID + vector number
```

```c
/* Reading MSI capability from kernel: */
u16 ctrl;
pci_read_config_word(dev, pos + PCI_MSI_FLAGS, &ctrl);
int nvec = 1 << ((ctrl & PCI_MSI_FLAGS_QMASK) >> 1);  /* max vectors */
```

## MSI-X table

MSI-X uses a table in one of the device's BARs:

```
MSI-X capability (cap ID = 0x11):
  Message Control:
    [10:0]: Table Size - 1  (up to 2048 entries)
    [13]: Function Mask      (mask all vectors)
    [15]: MSI-X Enable

  Table Offset/BIR:
    [2:0]: BAR Index (which BAR contains the table)
    [31:3]: Table Offset (byte offset into that BAR)

  Pending Bit Array (PBA) Offset/BIR:
    [2:0]: BAR Index
    [31:3]: PBA Offset

MSI-X Table entry (16 bytes each):
  [31:0]:  Message Address Low
  [63:32]: Message Address High
  [95:64]: Message Data          (APIC ID + vector)
  [127:96]: Vector Control
               [0]: Masked (1 = masked)
```

## Linux kernel: requesting MSI-X vectors

```c
/* drivers/net/ethernet/intel/igb/igb_main.c (simplified) */

static int igb_set_interrupt_capability(struct igb_adapter *adapter)
{
    int numvecs, err;

    /* Try to get one vector per TX queue + one per RX queue + misc */
    numvecs = adapter->num_tx_queues + adapter->num_rx_queues + 1;

    /* Request MSI-X vectors: */
    /* pci_alloc_irq_vectors: tries MSI-X first, falls back to MSI, then INTx */
    err = pci_alloc_irq_vectors(adapter->pdev,
                                 1,         /* min vectors */
                                 numvecs,   /* max vectors */
                                 PCI_IRQ_MSIX | PCI_IRQ_MSI);
    if (err < 0) {
        /* Fall back to single interrupt */
        pci_alloc_irq_vectors(adapter->pdev, 1, 1, PCI_IRQ_ALL_TYPES);
        return 0;
    }
    adapter->num_q_vectors = err;  /* actual vectors granted */
    return 0;
}

/* Register handler for each vector: */
for (i = 0; i < adapter->num_q_vectors; i++) {
    /* pci_irq_vector: get IRQ number for vector i */
    int irq = pci_irq_vector(adapter->pdev, i);

    snprintf(name, sizeof(name), "%s-q%d", netdev->name, i);
    err = request_irq(irq, igb_msix_ring, 0, name,
                       adapter->q_vector[i]);
}

/* Free at cleanup: */
pci_free_irq_vectors(adapter->pdev);
```

## Per-vector IRQ affinity

With MSI-X, each vector can be pinned to a different CPU:

```bash
# List MSI-X IRQs for an NVMe device:
ls /proc/irq/ | xargs -I{} cat /proc/irq/{}/smp_affinity_list 2>/dev/null
# Most IRQs map to many CPUs

# For MSI-X NVMe with 8 queues:
# irq 32 → cpu 0  (queue 0)
# irq 33 → cpu 1  (queue 1)
# ...
# irq 39 → cpu 7  (queue 7)

# Set affinity for vector 0 to CPU 0:
echo 0 > /proc/irq/32/smp_affinity_list  # CPU 0 only (smp_affinity_list uses CPU numbers, not bitmasks)

# Or using irqbalance for automatic balancing:
systemctl start irqbalance
```

```c
/* Kernel: set affinity hint (driver calls this): */
irq_set_affinity_hint(irq, cpumask);
/* irqbalance respects hints when distributing IRQs */

/* Or force affinity: */
irq_set_affinity(irq, cpumask);
```

## Interrupt coalescing

To reduce interrupt rate (and CPU overhead), drivers aggregate multiple completions:

```bash
# Check current coalescing settings:
ethtool -c eth0
# Coalesce parameters for eth0:
# Adaptive RX: off  TX: off
# rx-usecs: 50       ← generate interrupt after 50µs idle
# rx-frames: 0       ← or after 0 packets (disabled)
# tx-usecs: 50
# tx-frames: 0

# Reduce interrupt rate (more coalescing = higher latency, less CPU):
ethtool -C eth0 rx-usecs=100 tx-usecs=100

# Adaptive coalescing (auto-tune based on load):
ethtool -C eth0 adaptive-rx on adaptive-tx on
```

### Kernel coalescing support

```c
/* NIC driver implements: */
static int igb_set_coalesce(struct net_device *netdev,
                             struct ethtool_coalesce *ec,
                             struct kernel_ethtool_coalesce *kernel_coal,
                             struct netlink_ext_ack *extack)
{
    struct igb_adapter *adapter = netdev_priv(netdev);

    /* rx-usecs → RDTR (Receive Delay Timer Register) */
    adapter->rx_itr_setting = ec->rx_coalesce_usecs;

    /* Program hardware register: */
    wr32(E1000_ITR, adapter->rx_itr_setting * 256000000 / 1000000);
    /* Hardware: interrupt fires when queue idle for ITR microseconds */
    return 0;
}
```

## Checking MSI-X status

```bash
# Verify MSI-X is active:
lspci -vvv -s 03:00.0 | grep -A 10 "MSI-X"
# Capabilities: [b0] MSI-X: Enable+ Count=33 Masked-
# Vector table: BAR=4 offset=00002000
# PBA: BAR=4 offset=00003000

# Number of MSI-X vectors in use:
cat /proc/interrupts | grep nvme
# 32:          0          0    PCI-MSI 2621440-edge   nvme0q0
# 33:      12345         67    PCI-MSI 2621441-edge   nvme0q1
# ...

# Per-CPU interrupt counts for a device:
cat /proc/irq/32/affinity_hint     # CPU affinity hint
cat /proc/irq/32/effective_affinity_list  # actual CPU

# Stats per vector:
cat /sys/bus/pci/devices/0000:03:00.0/msi_irqs/
# 32  33  34  ...  (one per MSI-X vector)
```

## MSI vs MSI-X comparison

| | INTx | MSI | MSI-X |
|---|------|-----|-------|
| Max vectors | 4 | 32 | 2048 |
| Sharing | Yes (shared wire) | No | No |
| Per-vector affinity | No | No | Yes |
| Masking | INTx disable | All vectors | Per-vector |
| Table location | PCI pins | Config space | BAR |
| Usage | Legacy | Simple devices | NVMe, 10GbE, GPU |

## Further reading

- [PCI Drivers](pci-driver.md) — PCIe driver basics including MSI setup
- [IRQ Affinity](../interrupts/irq-affinity.md) — configuring IRQ CPU affinity
- [NVMe Driver](../block/nvme.md) — uses one MSI-X vector per queue
- [IRQ Descriptor](../interrupts/irq-desc.md) — struct irq_desc and irq_chip
- `drivers/pci/msi/` — MSI/MSI-X implementation
- `Documentation/PCI/msi-howto.rst` — MSI usage guide for drivers
