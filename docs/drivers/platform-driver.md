# Platform Drivers

> The most common driver pattern for embedded and SoC devices

## What platform devices are

Platform devices are devices that are not discoverable by hardware (unlike PCI or USB). They are instantiated via:
- **Device tree** (ARM, RISC-V, embedded)
- **ACPI** (x86, modern ARM servers)
- **Board files** (old ARM, legacy)

Examples: UARTs, I2C controllers, GPIO controllers, clocks — hardware that's wired onto the SoC and can't be dynamically probed.

## struct platform_driver

```c
/* include/linux/platform_device.h */
struct platform_driver {
    int (*probe)(struct platform_device *);   /* device found, bind driver */
    void (*remove)(struct platform_device *);  /* device removed, unbind */
    void (*shutdown)(struct platform_device *);
    int (*suspend)(struct platform_device *, pm_message_t state);
    int (*resume)(struct platform_device *);
    struct device_driver driver;              /* embedded generic driver */
    const struct platform_device_id *id_table; /* legacy ID matching */
    bool driver_managed_dma;
};

struct platform_device {
    const char      *name;           /* for legacy matching */
    int              id;             /* appended to name: "serial.0" */
    struct device    dev;            /* embedded generic device */
    u32              num_resources;
    struct resource *resource;       /* I/O memory, IRQ, etc. */
    const struct platform_device_id *id_entry;
    const char      *driver_override; /* force specific driver */
    struct mfd_cell *mfd_cell;
    struct pdev_archdata archdata;
};
```

## A minimal platform driver

```c
/* drivers/mydriver/mydriver.c */
#include <linux/module.h>
#include <linux/platform_device.h>
#include <linux/of.h>
#include <linux/io.h>
#include <linux/interrupt.h>
#include <linux/clk.h>

struct mydev {
    void __iomem    *base;    /* mapped register base */
    struct clk      *clk;
    int              irq;
};

/* IRQ handler */
static irqreturn_t mydev_irq(int irq, void *data)
{
    struct mydev *dev = data;
    u32 status = readl(dev->base + STATUS_REG);

    if (!(status & MY_IRQ_BIT))
        return IRQ_NONE;

    /* handle interrupt */
    writel(MY_IRQ_BIT, dev->base + STATUS_CLR_REG);
    return IRQ_HANDLED;
}

static int mydev_probe(struct platform_device *pdev)
{
    struct mydev *dev;
    struct resource *res;
    int ret;

    /* Allocate driver private data (devm: freed automatically on remove) */
    dev = devm_kzalloc(&pdev->dev, sizeof(*dev), GFP_KERNEL);
    if (!dev)
        return -ENOMEM;

    /* Map I/O memory from resource #0 */
    dev->base = devm_platform_ioremap_resource(pdev, 0);
    if (IS_ERR(dev->base))
        return PTR_ERR(dev->base);

    /* Get and enable clock */
    dev->clk = devm_clk_get(&pdev->dev, "mydev_clk");
    if (IS_ERR(dev->clk))
        return PTR_ERR(dev->clk);

    ret = clk_prepare_enable(dev->clk);
    if (ret)
        return ret;

    /* Request IRQ */
    dev->irq = platform_get_irq(pdev, 0);
    if (dev->irq < 0)
        return dev->irq;

    ret = devm_request_irq(&pdev->dev, dev->irq, mydev_irq,
                           IRQF_SHARED, "mydev", dev);
    if (ret)
        return ret;

    /* Store driver data */
    platform_set_drvdata(pdev, dev);

    dev_info(&pdev->dev, "mydev initialized at %p, irq %d\n",
             dev->base, dev->irq);
    return 0;
}

static void mydev_remove(struct platform_device *pdev)
{
    struct mydev *dev = platform_get_drvdata(pdev);

    /* devm resources freed automatically; only need to disable clock */
    clk_disable_unprepare(dev->clk);
}

/* Device tree match table */
static const struct of_device_id mydev_of_match[] = {
    { .compatible = "vendor,mydev-v1" },
    { .compatible = "vendor,mydev-v2", .data = &mydev_v2_config },
    { }  /* sentinel */
};
MODULE_DEVICE_TABLE(of, mydev_of_match);

/* Legacy platform ID match (non-DT) */
static const struct platform_device_id mydev_id_table[] = {
    { "mydev", 0 },
    { }
};
MODULE_DEVICE_TABLE(platform, mydev_id_table);

static struct platform_driver mydev_driver = {
    .probe  = mydev_probe,
    .remove = mydev_remove,
    .id_table = mydev_id_table,
    .driver = {
        .name           = "mydev",
        .of_match_table = mydev_of_match,
        .pm             = &mydev_pm_ops,  /* optional */
    },
};

module_platform_driver(mydev_driver);
/* Expands to module_init/module_exit that call
   platform_driver_register/unregister */

MODULE_DESCRIPTION("Example platform driver");
MODULE_LICENSE("GPL");
MODULE_AUTHOR("Example Author <author@example.com>");
```

## devm_: automatic resource management

`devm_` (device-managed) functions bind resource lifetime to a `struct device`. When the device is unbound (removed), all `devm_` resources are freed in reverse registration order.

```c
/* Memory */
devm_kzalloc(&dev, size, GFP_KERNEL)    /* freed on device removal */
devm_kmalloc(&dev, size, GFP_KERNEL)

/* I/O memory */
devm_ioremap(&dev, phys_addr, size)
devm_ioremap_resource(&dev, resource)
devm_platform_ioremap_resource(pdev, index)  /* map resource by index */

/* IRQ */
devm_request_irq(&dev, irq, handler, flags, name, data)
devm_request_threaded_irq(...)

/* Clock */
devm_clk_get(&dev, "clock-name")
devm_clk_get_enabled(&dev, "clock-name")  /* get + enable in one call */

/* GPIO */
devm_gpiod_get(&dev, "reset", GPIOD_OUT_LOW)

/* Regulator */
devm_regulator_get(&dev, "vdd")

/* DMA */
devm_dma_request_chan(&dev, "tx")

/* Register your own cleanup */
devm_add_action(&dev, my_cleanup_fn, my_data);
devm_add_action_or_reset(&dev, my_cleanup_fn, my_data);
```

### Why devm_ matters

```c
/* Without devm: error paths are a nightmare */
static int probe(struct platform_device *pdev)
{
    dev->base = ioremap(res->start, resource_size(res));
    if (!dev->base) { return -ENOMEM; }

    ret = request_irq(irq, handler, 0, "dev", dev);
    if (ret) {
        iounmap(dev->base);  /* must undo ioremap */
        return ret;
    }

    dev->clk = clk_get(&pdev->dev, "myclk");
    if (IS_ERR(dev->clk)) {
        free_irq(irq, dev);   /* must undo request_irq */
        iounmap(dev->base);   /* must undo ioremap */
        return PTR_ERR(dev->clk);
    }
    /* ... */
}

/* With devm: errors just return, devm handles cleanup */
static int probe(struct platform_device *pdev)
{
    dev->base = devm_platform_ioremap_resource(pdev, 0);
    if (IS_ERR(dev->base)) return PTR_ERR(dev->base);

    ret = devm_request_irq(&pdev->dev, irq, handler, 0, "dev", dev);
    if (ret) return ret;

    dev->clk = devm_clk_get(&pdev->dev, "myclk");
    if (IS_ERR(dev->clk)) return PTR_ERR(dev->clk);
    /* ... */
}
```

## Device tree binding

The device tree describes hardware topology. Each node with a `compatible` property can be matched by a driver:

```dts
/* Example device tree node */
/ {
    soc {
        mydev: mydev@10000000 {
            compatible = "vendor,mydev-v1";
            reg = <0x10000000 0x1000>;  /* I/O memory: base, size */
            interrupts = <GIC_SPI 42 IRQ_TYPE_LEVEL_HIGH>;
            clocks = <&ccu CLK_MYDEV>;
            clock-names = "mydev_clk";
            reset-gpios = <&gpio 10 GPIO_ACTIVE_LOW>;
            status = "okay";
        };
    };
};
```

The platform bus automatically creates a `platform_device` from this node when the kernel boots. The driver's `of_match_table` is compared against `compatible`.

### Reading device tree properties

```c
static int mydev_probe(struct platform_device *pdev)
{
    struct device_node *np = pdev->dev.of_node;
    u32 frequency;
    bool active_high;

    /* Read simple integer properties */
    if (of_property_read_u32(np, "clock-frequency", &frequency))
        frequency = 100000;  /* default */

    /* Read boolean property */
    active_high = of_property_read_bool(np, "active-high");

    /* Get a named GPIO */
    struct gpio_desc *reset_gpio = devm_gpiod_get(&pdev->dev, "reset",
                                                   GPIOD_OUT_LOW);

    /* Get compatible string data */
    const struct mydev_config *cfg =
        of_device_get_match_data(&pdev->dev);
}
```

## Deferring probe

If a resource isn't ready yet (e.g., a clock driver hasn't probed yet):

```c
static int mydev_probe(struct platform_device *pdev)
{
    dev->clk = devm_clk_get(&pdev->dev, "myclk");
    if (IS_ERR(dev->clk)) {
        if (PTR_ERR(dev->clk) == -EPROBE_DEFER)
            return -EPROBE_DEFER;  /* retry later when clk is available */
        return PTR_ERR(dev->clk);
    }
}
```

`-EPROBE_DEFER` tells the probe infrastructure to retry this driver once any other driver finishes probing.

## Observing platform devices

```bash
# List platform devices
ls /sys/bus/platform/devices/

# See driver bound to a platform device
cat /sys/bus/platform/devices/mydev.0/driver/module/name

# See resources (I/O memory, IRQ)
cat /sys/bus/platform/devices/mydev.0/resource
# 0x10000000 0x10000fff 0x200  ← start end flags

# Force rebind
echo mydev.0 > /sys/bus/platform/drivers/mydev/unbind
echo mydev.0 > /sys/bus/platform/drivers/mydev/bind

# Check kernel log for probe messages
dmesg | grep mydev
```

## Further reading

- [Linux Device Model](device-model.md) — struct device, bus, driver internals
- [Character and Misc Devices](chardev.md) — Exposing devices via /dev
- `Documentation/driver-api/driver-model/platform.rst`
- `Documentation/devicetree/bindings/` — DT binding documentation
