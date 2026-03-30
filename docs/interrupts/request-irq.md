# request_irq and free_irq

> Registering interrupt handlers with the kernel

## The basic API

```c
#include <linux/interrupt.h>

/* Register an interrupt handler */
int request_irq(unsigned int irq,
                irq_handler_t handler,
                unsigned long flags,
                const char *name,
                void *dev_id);

/* Returns 0 on success, negative errno on failure */

/* Unregister: dev_id must match what was passed to request_irq */
void free_irq(unsigned int irq, void *dev_id);

/* Managed version: automatically freed when device is removed */
int devm_request_irq(struct device *dev, unsigned int irq,
                     irq_handler_t handler, unsigned long flags,
                     const char *name, void *dev_id);
```

## Handler return values

```c
typedef irqreturn_t (*irq_handler_t)(int irq, void *dev_id);

#define IRQ_NONE      (0)            /* not my interrupt */
#define IRQ_HANDLED   (1)            /* handled the interrupt */
#define IRQ_WAKE_THREAD (2)          /* wake the threaded handler */
```

- Return `IRQ_NONE` if the interrupt wasn't from your device (important for shared IRQs)
- Return `IRQ_HANDLED` when you've handled it
- Return `IRQ_WAKE_THREAD` to wake the threaded handler (see [Threaded IRQs](threaded-irq.md))

## IRQF flags

```c
/* Trigger type (usually already configured by firmware/devicetree) */
IRQF_TRIGGER_RISING   /* edge: low → high */
IRQF_TRIGGER_FALLING  /* edge: high → low */
IRQF_TRIGGER_HIGH     /* level: active high */
IRQF_TRIGGER_LOW      /* level: active low */

/* Sharing */
IRQF_SHARED           /* interrupt line shared with other devices */

/* Threading */
IRQF_ONESHOT          /* disable IRQ line until thread handler completes */
IRQF_NO_THREAD        /* force non-threaded even if requested */

/* Power management */
IRQF_NO_SUSPEND       /* don't disable during suspend */
IRQF_FORCE_RESUME     /* force-enable on resume even if disabled */

/* Misc */
IRQF_NOBALANCING      /* exclude from IRQ balancing */
IRQF_PERCPU           /* per-CPU interrupt */
```

## A minimal driver example

```c
#include <linux/interrupt.h>
#include <linux/module.h>

struct my_device {
    int irq;
    void __iomem *regs;
    /* ... */
};

static irqreturn_t my_irq_handler(int irq, void *dev_id)
{
    struct my_device *dev = dev_id;
    u32 status;

    /* Read interrupt status register */
    status = readl(dev->regs + STATUS_REG);

    /* Check if this is our interrupt */
    if (!(status & MY_IRQ_BIT))
        return IRQ_NONE;

    /* Acknowledge (clear) the interrupt */
    writel(MY_IRQ_BIT, dev->regs + STATUS_CLEAR_REG);

    /* Do minimal work here — queue deferred processing */
    schedule_work(&dev->work);

    return IRQ_HANDLED;
}

static int my_driver_probe(struct platform_device *pdev)
{
    struct my_device *dev;
    int ret;

    dev = devm_kzalloc(&pdev->dev, sizeof(*dev), GFP_KERNEL);

    dev->irq = platform_get_irq(pdev, 0);
    dev->regs = devm_ioremap_resource(&pdev->dev, res);

    INIT_WORK(&dev->work, my_work_handler);

    /* devm_request_irq: automatically freed when device is removed */
    ret = devm_request_irq(&pdev->dev, dev->irq, my_irq_handler,
                           0, dev_name(&pdev->dev), dev);
    if (ret) {
        dev_err(&pdev->dev, "Failed to request IRQ %d\n", dev->irq);
        return ret;
    }

    return 0;
}
```

## Shared IRQs

On legacy systems (e.g., PCI INTx), multiple devices share a single IRQ line. Each registers with `IRQF_SHARED`:

```c
/* Both devices register on the same IRQ */
request_irq(irq, handler_a, IRQF_SHARED, "device-a", dev_a);
request_irq(irq, handler_b, IRQF_SHARED, "device-b", dev_b);

/* When the IRQ fires, both handlers are called in sequence:
   kernel calls handler_a(irq, dev_a), then handler_b(irq, dev_b)
   Each must check its own hardware status register and return IRQ_NONE
   if not its interrupt */
```

Requirements for shared IRQs:
1. `IRQF_SHARED` must be set by all sharing drivers
2. `dev_id` must be unique (typically the device struct pointer)
3. Each handler must be able to determine if it was its device

## disable_irq / enable_irq

```c
/* Disable an IRQ and wait for any running handler to complete */
disable_irq(irq);          /* sleeps until handler done */
disable_irq_nosync(irq);   /* returns immediately */

/* Re-enable */
enable_irq(irq);

/* Balanced: nested calls (depth counter) */
disable_irq(irq);  /* depth=1 */
disable_irq(irq);  /* depth=2 */
enable_irq(irq);   /* depth=1, still disabled */
enable_irq(irq);   /* depth=0, now enabled */
```

`disable_irq()` increments `irq_desc->depth`. The IRQ is only physically disabled when `depth` goes from 1 to 0.

## synchronize_irq

After calling `free_irq()`, you may need to wait for any currently-running handler to complete:

```c
free_irq(dev->irq, dev);
synchronize_irq(dev->irq);  /* wait for in-flight handlers */
/* now safe to free dev */
```

`devm_request_irq()` handles this automatically at device removal, so prefer it over manual `request_irq()` + `free_irq()`.

## Getting the IRQ number

```c
/* From platform resources */
irq = platform_get_irq(pdev, 0);

/* From device tree */
irq = of_irq_get(np, 0);

/* From PCI */
irq = pci_irq_vector(pdev, 0);  /* MSI or legacy */

/* From GPIO */
irq = gpiod_to_irq(gpio);
```

## Further reading

- [IRQ Descriptor and irq_chip](irq-desc.md) — What's registered under the hood
- [Threaded IRQs](threaded-irq.md) — Moving work out of hardirq context
- [Workqueues](workqueues.md) — For deferred work from interrupt handlers
