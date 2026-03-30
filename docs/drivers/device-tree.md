# Device Tree: ARM Hardware Description

> DTS syntax, of_ API, platform driver binding, and DT overlays

## What is a Device Tree?

On x86, the kernel discovers hardware at runtime (ACPI, PCI enumeration). On ARM and other embedded platforms, hardware is not self-describing — a **Device Tree** (DT) is a static description passed from the bootloader to the kernel:

```
Bootloader (U-Boot)
  → loads kernel Image + DTB (device tree blob) into RAM
  → sets x0 = 0 (PSCI) + x1 = DTB address
  → jumps to kernel entry point

Kernel:
  → setup_machine_fdt(dtb) maps and parses the blob
  → creates struct device nodes for each hardware block
  → platform drivers bind to nodes via compatible string
```

## DTS syntax

Device tree source (`.dts`) is compiled to binary blob (`.dtb`) with `dtc`:

```dts
/* arch/arm64/boot/dts/example.dts */
/dts-v1/;

/ {
    model = "My Board v1.0";
    compatible = "myvendor,myboard";
    #address-cells = <1>;    /* 1 u32 for addresses */
    #size-cells = <1>;       /* 1 u32 for sizes */

    /* CPUs */
    cpus {
        #address-cells = <1>;
        #size-cells = <0>;
        cpu@0 {
            compatible = "arm,cortex-a53";
            device_type = "cpu";
            reg = <0>;
            enable-method = "psci";
        };
    };

    /* Memory */
    memory@80000000 {
        device_type = "memory";
        reg = <0x80000000 0x40000000>;  /* 1GB at 0x80000000 */
    };

    /* SoC peripherals */
    soc {
        compatible = "simple-bus";
        #address-cells = <1>;
        #size-cells = <1>;
        ranges;                          /* identity mapping */

        uart0: serial@11000000 {
            compatible = "ns16550a";
            reg = <0x11000000 0x1000>;   /* MMIO base + size */
            interrupts = <0 32 4>;       /* type SPI, irq 32, active-low level */
            clocks = <&uart_clk>;
            clock-names = "baudclk";
            current-speed = <115200>;
            status = "okay";             /* "disabled" to exclude */
        };

        i2c0: i2c@12000000 {
            compatible = "myvendor,i2c-v1";
            reg = <0x12000000 0x100>;
            interrupts = <0 40 4>;
            #address-cells = <1>;
            #size-cells = <0>;
            clock-frequency = <400000>;  /* 400kHz fast mode */
            status = "okay";

            /* I2C device at address 0x48 */
            temp_sensor: temperature@48 {
                compatible = "ti,tmp102";
                reg = <0x48>;
            };
        };

        gpio: gpio@13000000 {
            compatible = "myvendor,gpio";
            reg = <0x13000000 0x1000>;
            #gpio-cells = <2>;           /* pin + flags */
            gpio-controller;
            interrupt-controller;
            #interrupt-cells = <2>;
        };
    };
};
```

```bash
# Compile DTS to DTB:
dtc -I dts -O dtb -o board.dtb board.dts

# Decompile DTB back to DTS:
dtc -I dtb -O dts -o board.dts board.dtb

# Dump live DTB from running kernel:
dtc -I dtb -O dts /proc/device-tree > running.dts
# or:
ls /proc/device-tree/
```

## DTSI includes

```dts
/* SoC-level DTSI (shared hardware description): */
/* arch/arm64/boot/dts/myvendor/myvendor-soc.dtsi */
/ {
    soc {
        uart0: serial@11000000 {
            compatible = "ns16550a";
            reg = <0x11000000 0x1000>;
            status = "disabled";         /* off by default */
        };
    };
};

/* Board-level DTS (board-specific configuration): */
#include "myvendor-soc.dtsi"
/ {
    model = "My Board v1.0";
    &uart0 {
        status = "okay";             /* enable for this board */
        current-speed = <115200>;
    };
};
```

## Platform driver binding

### The compatible string

The kernel matches DT nodes to drivers via the `compatible` property:

```c
/* drivers/tty/serial/ns16550.c */

/* Device table: matches "compatible" strings in DTS */
static const struct of_device_id ns16550_of_match[] = {
    { .compatible = "ns16550a",   .data = &ns16550_config },
    { .compatible = "ns16550",    .data = &ns16550_config },
    { .compatible = "snps,dw-apb-uart", .data = &dw_apb_config },
    { /* sentinel */ }
};
MODULE_DEVICE_TABLE(of, ns16550_of_match);

static struct platform_driver ns16550_driver = {
    .probe   = ns16550_probe,
    .remove  = ns16550_remove,
    .driver  = {
        .name           = "ns16550",
        .of_match_table = ns16550_of_match,   /* DT binding */
        .pm             = &ns16550_pm_ops,
    },
};
module_platform_driver(ns16550_driver);
```

### probe() reading DT properties

```c
static int ns16550_probe(struct platform_device *pdev)
{
    struct device *dev = &pdev->dev;
    struct device_node *np = dev->of_node;   /* DT node */
    struct ns16550_port *port;
    struct resource *res;
    u32 clk_freq;
    int irq, ret;

    port = devm_kzalloc(dev, sizeof(*port), GFP_KERNEL);
    if (!port)
        return -ENOMEM;

    /* Get MMIO resource from DT "reg" property */
    res = platform_get_resource(pdev, IORESOURCE_MEM, 0);
    port->base = devm_ioremap_resource(dev, res);
    if (IS_ERR(port->base))
        return PTR_ERR(port->base);

    /* Get IRQ from DT "interrupts" property */
    irq = platform_get_irq(pdev, 0);
    if (irq < 0)
        return irq;

    /* Read a u32 property */
    ret = of_property_read_u32(np, "current-speed", &port->baud);
    if (ret)
        port->baud = 115200;     /* default */

    /* Read a string property */
    const char *str;
    ret = of_property_read_string(np, "clock-names", &str);

    /* Read an array of u32s */
    u32 clk_vals[2];
    ret = of_property_read_u32_array(np, "clock-frequency", clk_vals, 2);

    /* Check a boolean property */
    if (of_property_read_bool(np, "fifo-enable"))
        port->has_fifo = true;

    /* Get a GPIO */
    port->reset_gpio = devm_gpiod_get_optional(dev, "reset", GPIOD_OUT_LOW);

    /* Get a clock */
    port->clk = devm_clk_get(dev, "baudclk");
    if (!IS_ERR(port->clk)) {
        clk_prepare_enable(port->clk);
        port->uartclk = clk_get_rate(port->clk);
    }

    /* Get a regulator */
    port->vdd = devm_regulator_get_optional(dev, "vdd");

    ret = devm_request_irq(dev, irq, ns16550_isr, 0, dev_name(dev), port);
    if (ret)
        return ret;

    return uart_add_one_port(&ns16550_uart_driver, &port->uart);
}
```

## of_ API reference

```c
/* Node lookup */
struct device_node *of_find_compatible_node(struct device_node *from,
                                             const char *type,
                                             const char *compatible);
struct device_node *of_find_node_by_phandle(phandle handle);
struct device_node *of_get_parent(const struct device_node *node);
struct device_node *of_get_next_child(const struct device_node *node,
                                       struct device_node *prev);

/* Property reading */
int of_property_read_u32(const struct device_node *np,
                          const char *propname, u32 *out_value);
int of_property_read_u64(const struct device_node *np,
                          const char *propname, u64 *out_value);
int of_property_read_string(const struct device_node *np,
                             const char *propname, const char **out_string);
int of_property_read_u32_array(const struct device_node *np,
                                const char *propname,
                                u32 *out_values, size_t sz);
bool of_property_read_bool(const struct device_node *np,
                            const char *propname);

/* Address translation */
int of_address_to_resource(struct device_node *dev, int index,
                             struct resource *r);
void __iomem *of_iomap(struct device_node *node, int index);

/* IRQ mapping */
int of_irq_get(struct device_node *dev, int index);
int of_irq_count(struct device_node *dev);
```

## Phandles and cross-references

```dts
/* Phandles allow nodes to reference other nodes */
clocks {
    uart_clk: uart_clk {
        compatible = "fixed-clock";
        #clock-cells = <0>;
        clock-frequency = <24000000>;   /* 24MHz */
    };

    spi_clk: spi_clk {
        compatible = "fixed-clock";
        #clock-cells = <0>;
        clock-frequency = <48000000>;
    };
};

uart0: serial@11000000 {
    clocks = <&uart_clk>;            /* phandle reference */
    clock-names = "baudclk";
};

/* GPIO reference with args */
leds {
    led-red {
        gpios = <&gpio 5 GPIO_ACTIVE_HIGH>;  /* gpio node, pin 5, active high */
    };
};
```

```c
/* Resolve a phandle reference in driver: */
struct device_node *clk_node = of_parse_phandle(np, "clocks", 0);

/* Or use the clock framework abstraction: */
struct clk *clk = of_clk_get_by_name(np, "baudclk");
```

## Device Tree overlays (DTO)

Overlays allow dynamic modification of the live DT (e.g., Raspberry Pi hats):

```dts
/* overlay.dts - add a sensor on i2c0 */
/dts-v1/;
/plugin/;

/ {
    compatible = "raspberrypi,3-model-b";

    fragment@0 {
        target = <&i2c0>;
        __overlay__ {
            #address-cells = <1>;
            #size-cells = <0>;

            bmp280@76 {
                compatible = "bosch,bmp280";
                reg = <0x76>;
            };
        };
    };
};
```

```bash
# Compile overlay:
dtc -I dts -O dtb -o my-overlay.dtbo my-overlay.dts

# Apply overlay at runtime (Raspberry Pi / configfs):
mkdir /sys/kernel/config/device-tree/overlays/my-overlay
cat my-overlay.dtbo > /sys/kernel/config/device-tree/overlays/my-overlay/dtbo

# Remove overlay:
rmdir /sys/kernel/config/device-tree/overlays/my-overlay

# Check applied overlays:
ls /sys/kernel/config/device-tree/overlays/
```

## Debugging Device Trees

```bash
# Live DT as filesystem:
ls /proc/device-tree/
cat /proc/device-tree/model
# My Board v1.0

# sysfs: platform devices created from DT:
ls /sys/bus/platform/devices/
# 11000000.serial  12000000.i2c  ...

# Check driver binding:
ls -la /sys/bus/platform/devices/11000000.serial/driver
# → /sys/bus/platform/drivers/ns16550

# Dump all DT nodes matching a compatible:
grep -r "compatible" /proc/device-tree/ 2>/dev/null | head -20

# dtc on live kernel:
apt install device-tree-compiler
dtc -I fs /proc/device-tree 2>/dev/null | grep -A5 "serial@"

# Check for DT probe failures:
dmesg | grep -E "of_platform|platform|DT" | head -20

# Device Tree statistics:
cat /sys/kernel/debug/of_platform_bus/stats 2>/dev/null

# Find what matched a node:
cat /sys/bus/platform/devices/11000000.serial/of_node/compatible
# ns16550a

# fdt_probe_driver: check why driver didn't probe
dmesg | grep "11000000.serial"
# [    1.234] 11000000.serial: ttyS0 at MMIO 0x11000000 (irq = 32, ...) is a NS16550A
```

## Platform device lifecycle

```
DT blob → of_platform_populate() → creates struct platform_device for each node
                                                      ↓
                             platform_device.name = "11000000.serial"
                             platform_device.dev.of_node = &dt_node
                             platform_device.resource[] = [MMIO, IRQ]
                                                      ↓
                        platform_driver registered → of_match_table checked
                                                      ↓
                                    probe() called with struct platform_device *
```

```c
/* During boot: arch/arm64/kernel/setup.c */
of_platform_populate(NULL, of_default_bus_match_table, NULL, NULL);
/* Creates platform_device for every node with compatible that matches
   of_default_bus_match_table (includes "simple-bus", etc.) */

/* struct platform_device handed to probe(): */
struct platform_device {
    const char      *name;          /* "11000000.serial" */
    int             id;             /* -1 if from DT */
    struct device   dev;            /* contains of_node pointer */
    u32             num_resources;
    struct resource *resource;      /* MMIO base+size, IRQ */
};
```

## DT vs ACPI

| Feature | Device Tree | ACPI |
|---------|-------------|------|
| Platform | ARM, RISC-V, PowerPC | x86, ARM64 servers |
| Description | Static DTS file compiled to DTB | AML bytecode in BIOS |
| Discovery | of_match_table in driver | HID/CID in ACPI tables |
| Updates | DT overlays, reboot | DSDT patches |
| Debug | /proc/device-tree, dtc | acpidump, acpiexec |
| Clocks | DT clock framework | ACPI _CRS |
| Power | DT regulators, PSCI | ACPI _PSx methods |

```bash
# Check if system uses ACPI or DT:
ls /proc/device-tree  2>/dev/null && echo "Device Tree" || echo "ACPI/other"
ls /sys/firmware/acpi 2>/dev/null && echo "ACPI present"
```

## Further reading

- [PCI Drivers](pci-driver.md) — PCI device binding (vs DT platform binding)
- [IRQ Affinity](../interrupts/irq-affinity.md) — DT interrupt-controller binding
- [Preemption Model](../sched/preemption.md) — RT on embedded/ARM
- [Real-Time Tuning](../sched/rt-tuning.md) — PREEMPT_RT for ARM
- `Documentation/devicetree/bindings/` — DT binding specifications
- `drivers/of/` — of_ API implementation
- `scripts/dtc/` — Device Tree Compiler
- `arch/arm64/boot/dts/` — upstream DTS files
