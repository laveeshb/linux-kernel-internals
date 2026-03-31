# PCI Drivers

> Writing a PCI device driver: probing, BAR mapping, and MSI-X interrupts

## PCI bus overview

PCI (Peripheral Component Interconnect) is the standard bus for connecting devices to a CPU. PCIe (PCI Express) is the modern serial version, but the driver API is largely the same.

```
CPU ← PCIe root complex → PCIe switch → endpoint devices
                                         (NIC, NVMe, GPU, etc.)

Each PCI device has:
  - Vendor ID + Device ID (16-bit each): identifies the device type
  - BARs (Base Address Registers): memory/IO regions exposed by the device
  - Configuration space (256B standard, 4KB extended): PCI registers
  - Interrupt: legacy INTx, MSI, or MSI-X
```

## Registering a PCI driver

```c
#include <linux/pci.h>
#include <linux/module.h>

/* Device ID table: which devices does this driver handle? */
static const struct pci_device_id mydev_ids[] = {
    { PCI_DEVICE(0x1234, 0x5678) },    /* vendor=0x1234, device=0x5678 */
    { PCI_DEVICE(0x1234, 0x5679) },    /* another model */
    { PCI_DEVICE_CLASS(PCI_CLASS_NETWORK_ETHERNET, ~0) }, /* all ethernet */
    { 0 }  /* sentinel */
};
MODULE_DEVICE_TABLE(pci, mydev_ids);

/* Driver registration */
static struct pci_driver mydev_driver = {
    .name     = "mydev",
    .id_table = mydev_ids,
    .probe    = mydev_probe,    /* called when device found */
    .remove   = mydev_remove,   /* called on device removal */
    .driver   = { .pm = &mydev_pm_ops },  /* PM via dev_pm_ops (no .suspend/.resume in pci_driver) */
    .shutdown = mydev_shutdown,
};

static int __init mydev_init(void)
{
    return pci_register_driver(&mydev_driver);
}

static void __exit mydev_exit(void)
{
    pci_unregister_driver(&mydev_driver);
}

module_init(mydev_init);
module_exit(mydev_exit);
```

The kernel calls `probe()` when a matching device is found (at boot, hot-plug, or module load).

## Probe function

```c
struct mydev {
    struct pci_dev *pdev;
    void __iomem   *bar0;    /* MMIO base for BAR 0 */
    void __iomem   *bar2;
    int             irq;
    /* device state */
};

static int mydev_probe(struct pci_dev *pdev, const struct pci_device_id *id)
{
    struct mydev *dev;
    int ret;

    /* 1. Allocate driver-private data */
    dev = devm_kzalloc(&pdev->dev, sizeof(*dev), GFP_KERNEL);
    if (!dev)
        return -ENOMEM;
    dev->pdev = pdev;
    pci_set_drvdata(pdev, dev);

    /* 2. Enable the PCI device */
    ret = pci_enable_device(pdev);
    if (ret) {
        dev_err(&pdev->dev, "cannot enable PCI device\n");
        return ret;
    }

    /* 3. Request ownership of BARs */
    ret = pci_request_regions(pdev, "mydev");
    if (ret) {
        dev_err(&pdev->dev, "cannot request regions\n");
        goto err_disable;
    }

    /* 4. Map BAR 0 (MMIO registers) */
    dev->bar0 = pci_iomap(pdev, 0, 0);  /* BAR 0, map all of it */
    if (!dev->bar0) {
        ret = -ENOMEM;
        goto err_release;
    }

    /* 5. Set DMA mask */
    ret = dma_set_mask_and_coherent(&pdev->dev, DMA_BIT_MASK(64));
    if (ret) {
        ret = dma_set_mask_and_coherent(&pdev->dev, DMA_BIT_MASK(32));
        if (ret) {
            dev_err(&pdev->dev, "no usable DMA configuration\n");
            goto err_unmap;
        }
    }

    /* 6. Enable bus mastering (required for DMA) */
    pci_set_master(pdev);

    /* 7. Setup MSI-X interrupts */
    ret = mydev_setup_interrupts(dev);
    if (ret)
        goto err_unmap;

    /* 8. Initialize hardware */
    mydev_hw_init(dev);

    dev_info(&pdev->dev, "mydev initialized, BAR0=%pK\n", dev->bar0);
    return 0;

err_unmap:
    pci_iounmap(pdev, dev->bar0);
err_release:
    pci_release_regions(pdev);
err_disable:
    pci_disable_device(pdev);
    return ret;
}

static void mydev_remove(struct pci_dev *pdev)
{
    struct mydev *dev = pci_get_drvdata(pdev);

    mydev_hw_stop(dev);
    mydev_teardown_interrupts(dev);
    pci_iounmap(pdev, dev->bar0);
    pci_release_regions(pdev);
    pci_disable_device(pdev);
    /* devm_* allocations freed automatically */
}
```

## BAR mapping and MMIO access

BARs (Base Address Registers) are the windows through which the CPU accesses device memory/registers:

```c
/* Read a 32-bit register at offset 0x10 */
u32 val = ioread32(dev->bar0 + 0x10);

/* Write a 64-bit register */
iowrite64(value, dev->bar0 + 0x20);

/* Read-modify-write */
u32 ctrl = ioread32(dev->bar0 + REG_CTRL);
ctrl |= CTRL_ENABLE;
iowrite32(ctrl, dev->bar0 + REG_CTRL);

/* Memory barrier: ensure MMIO writes are visible to the device */
mmiowb();  /* or wmb() on most architectures */
```

Always use `ioread*`/`iowrite*` (not plain pointer dereference) for MMIO regions — they handle architecture-specific memory ordering and MMIO semantics.

```bash
# Inspect BARs from userspace
lspci -vv -s <bus:dev.fn> | grep -A2 "Memory at\|I/O ports"

# See all PCI devices with their driver
lspci -k

# PCI configuration space
setpci -s <bus:dev.fn> VENDOR_ID.w   # read vendor ID
setpci -s <bus:dev.fn> STATUS.w      # read status register
```

## MSI and MSI-X interrupts

Modern devices use MSI (Message Signaled Interrupts) instead of legacy edge/level INTx signals:

- **Legacy INTx**: shared pin, slow, requires IOAPIC programming
- **MSI**: single interrupt vector, device writes to a magic memory address
- **MSI-X**: up to 2048 independent interrupt vectors, per-vector affinity

### MSI setup (single interrupt)

```c
/* Request a single MSI interrupt */
ret = pci_alloc_irq_vectors(pdev, 1, 1, PCI_IRQ_MSI);
if (ret < 0) {
    /* Fall back to legacy INTx */
    ret = pci_alloc_irq_vectors(pdev, 1, 1, PCI_IRQ_LEGACY);
}

int irq = pci_irq_vector(pdev, 0);  /* get the assigned IRQ number */

ret = request_irq(irq, mydev_isr, 0, "mydev", dev);

/* In remove: */
free_irq(pci_irq_vector(pdev, 0), dev);
pci_free_irq_vectors(pdev);
```

### MSI-X setup (multiple vectors)

```c
#define MYDEV_NUM_QUEUES 4

static int mydev_setup_interrupts(struct mydev *dev)
{
    struct pci_dev *pdev = dev->pdev;
    int nvecs, i, ret;

    /* Request up to MYDEV_NUM_QUEUES MSI-X vectors */
    nvecs = pci_alloc_irq_vectors(pdev,
                                   1,                  /* min vectors */
                                   MYDEV_NUM_QUEUES,   /* max vectors */
                                   PCI_IRQ_MSIX);
    if (nvecs < 0)
        return nvecs;

    dev->num_queues = nvecs;

    /* Request an IRQ handler per vector */
    for (i = 0; i < nvecs; i++) {
        int irq = pci_irq_vector(pdev, i);
        snprintf(dev->queue[i].irq_name, sizeof(dev->queue[i].irq_name),
                 "mydev-q%d", i);

        ret = request_irq(irq, mydev_queue_isr, 0,
                           dev->queue[i].irq_name, &dev->queue[i]);
        if (ret) {
            while (--i >= 0)
                free_irq(pci_irq_vector(pdev, i), &dev->queue[i]);
            pci_free_irq_vectors(pdev);
            return ret;
        }

        /* Pin each queue's IRQ to a specific CPU */
        irq_set_affinity_hint(irq, cpumask_of(i % num_online_cpus()));
    }
    return 0;
}
```

### MSI-X interrupt handler

```c
static irqreturn_t mydev_queue_isr(int irq, void *data)
{
    struct mydev_queue *q = data;
    u32 status;

    /* Read interrupt status register */
    status = ioread32(q->dev->bar0 + QUEUE_STATUS(q->idx));
    if (!(status & QUEUE_IRQ_PENDING))
        return IRQ_NONE;

    /* Clear the interrupt */
    iowrite32(QUEUE_IRQ_CLEAR, q->dev->bar0 + QUEUE_STATUS(q->idx));

    /* Process completions */
    mydev_process_completions(q);

    return IRQ_HANDLED;
}
```

## DMA with PCI

```c
/* Allocate coherent DMA memory (CPU and device see the same data) */
dma_addr_t dma_handle;
void *cpu_addr = dma_alloc_coherent(&pdev->dev, 4096, &dma_handle, GFP_KERNEL);
/* dma_handle: the address to program into the device's DMA register */
/* cpu_addr: the CPU virtual address */

/* Program device with DMA address */
iowrite64(dma_handle, dev->bar0 + REG_DMA_BASE);

/* Later: free */
dma_free_coherent(&pdev->dev, 4096, cpu_addr, dma_handle);

/* Streaming DMA (for existing buffers): */
dma_addr_t dma = dma_map_single(&pdev->dev, skb->data, skb->len,
                                  DMA_TO_DEVICE);
/* ... program device ... */
/* After device finishes: */
dma_unmap_single(&pdev->dev, dma, skb->len, DMA_TO_DEVICE);
/* Now safe to access skb->data */
```

## Reading PCI configuration space from a driver

```c
u16 vendor, device;
u8  revision;
u32 class_code;

pci_read_config_word(pdev, PCI_VENDOR_ID, &vendor);
pci_read_config_word(pdev, PCI_DEVICE_ID, &device);
pci_read_config_byte(pdev, PCI_REVISION_ID, &revision);
pci_read_config_dword(pdev, PCI_CLASS_REVISION, &class_code);

/* Check link speed (PCIe) */
u16 lnksta;
pcie_capability_read_word(pdev, PCI_EXP_LNKSTA, &lnksta);
int speed = lnksta & PCI_EXP_LNKSTA_CLS;  /* link speed */
int width = (lnksta & PCI_EXP_LNKSTA_NLW) >> 4;  /* link width */
```

## Using devm_ helpers

`devm_*` (device-managed) resources are automatically freed when the device is removed:

```c
/* Memory */
dev = devm_kzalloc(&pdev->dev, sizeof(*dev), GFP_KERNEL);

/* IOMAP */
dev->bar0 = devm_pci_iomap(pdev, 0, 0);

/* IRQ */
ret = devm_request_irq(&pdev->dev, irq, handler, 0, "mydev", dev);

/* No manual cleanup needed in .remove for devm_ resources */
```

## Further reading

- [Linux Device Model](device-model.md) — struct device, driver binding
- [Platform Drivers](platform-driver.md) — non-discoverable devices
- [DMA API](../mm/dma.md) — dma_alloc_coherent and scatter-gather
- [PCI BAR Mapping](../mm/pci-bar-mapping.md) — BAR physical layout
- [Interrupt Handling](../interrupts/interrupts.md) — IRQ descriptor path
- `include/linux/pci.h` — PCI driver API
- `drivers/net/ethernet/intel/e1000e/` — real NIC driver example
