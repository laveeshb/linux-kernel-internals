# I2C and SPI Bus Drivers

> Writing drivers for I2C and SPI peripheral devices in the Linux kernel

## I2C overview

I2C (Inter-Integrated Circuit) is a two-wire serial protocol for connecting low-speed peripherals (sensors, EEPROMs, touch controllers) to a microprocessor.

```
Physical wires:
  SDA (data)  ────────────────────────
  SCL (clock) ────────────────────────
              │       │       │
           Master    Dev1    Dev2
        (host CPU) (0x48) (0x50)
                     ↑       ↑
                  7-bit addresses
```

### I2C transaction format

```
Start: SDA falls while SCL is high
  │
  └─ [7-bit address] [R/W bit] [ACK]
     │
     └─ [data byte 0] [ACK]
        [data byte 1] [ACK]
        ...
Stop: SDA rises while SCL is high
```

## I2C client driver

### struct i2c_driver

```c
#include <linux/i2c.h>
#include <linux/module.h>

/* Device-specific private data */
struct my_sensor {
    struct i2c_client *client;
    struct mutex       lock;
    int                irq;
};

/* Match table for device tree / ACPI */
static const struct of_device_id my_sensor_of_match[] = {
    { .compatible = "vendor,my-sensor" },
    { /* sentinel */ }
};
MODULE_DEVICE_TABLE(of, my_sensor_of_match);

static const struct i2c_device_id my_sensor_id[] = {
    { "my-sensor", 0 },
    { /* sentinel */ }
};
MODULE_DEVICE_TABLE(i2c, my_sensor_id);

/* Called when device is found */
static int my_sensor_probe(struct i2c_client *client)
{
    struct my_sensor *sensor;
    int ret;

    /* Verify the device supports the operations we need */
    if (!i2c_check_functionality(client->adapter,
                                  I2C_FUNC_SMBUS_BYTE_DATA)) {
        dev_err(&client->dev, "SMBus byte operations required\n");
        return -EOPNOTSUPP;
    }

    sensor = devm_kzalloc(&client->dev, sizeof(*sensor), GFP_KERNEL);
    if (!sensor)
        return -ENOMEM;

    sensor->client = client;
    mutex_init(&sensor->lock);
    i2c_set_clientdata(client, sensor);

    /* Read and verify device ID register */
    ret = i2c_smbus_read_byte_data(client, REG_DEVICE_ID);
    if (ret < 0) {
        dev_err(&client->dev, "failed to read device ID: %d\n", ret);
        return ret;
    }
    if (ret != EXPECTED_DEVICE_ID) {
        dev_err(&client->dev, "unexpected device ID: 0x%02x\n", ret);
        return -ENODEV;
    }

    /* Register with IIO or hwmon subsystem */
    return my_sensor_register_iio(sensor);
}

static void my_sensor_remove(struct i2c_client *client)
{
    struct my_sensor *sensor = i2c_get_clientdata(client);
    my_sensor_unregister_iio(sensor);
}

static struct i2c_driver my_sensor_driver = {
    .driver = {
        .name         = "my-sensor",
        .of_match_table = my_sensor_of_match,
    },
    .probe    = my_sensor_probe,
    .remove   = my_sensor_remove,
    .id_table = my_sensor_id,
};
module_i2c_driver(my_sensor_driver);
/* Expands to: module_init + module_exit with i2c_add/del_driver */
```

## I2C transfer functions

### SMBus (common for simple devices)

```c
/* Read/write a single byte at a register address: */
s32 i2c_smbus_read_byte_data(struct i2c_client *client, u8 reg);
s32 i2c_smbus_write_byte_data(struct i2c_client *client, u8 reg, u8 value);

/* Read/write a 16-bit word: */
s32 i2c_smbus_read_word_data(struct i2c_client *client, u8 reg);
s32 i2c_smbus_write_word_data(struct i2c_client *client, u8 reg, u16 value);

/* Read a block of data: */
s32 i2c_smbus_read_i2c_block_data(struct i2c_client *client, u8 reg,
                                   u8 length, u8 *values);
/* values receives `length` bytes starting from register `reg` */

/* Example: read 6 bytes of accelerometer data from reg 0x28: */
u8 data[6];
ret = i2c_smbus_read_i2c_block_data(client, 0x28, 6, data);
```

### Raw I2C messages (for complex protocols)

```c
/* For devices that don't follow SMBus convention: */
int i2c_transfer(struct i2c_adapter *adap, struct i2c_msg *msgs, int num);

/* Example: write register address, then read multiple bytes
   (common register access pattern): */
static int my_read_regs(struct i2c_client *client, u8 reg,
                         u8 *buf, size_t len)
{
    struct i2c_msg msgs[2] = {
        {
            /* Write phase: send register address */
            .addr  = client->addr,
            .flags = 0,              /* write */
            .len   = 1,
            .buf   = &reg,
        },
        {
            /* Read phase: read `len` bytes */
            .addr  = client->addr,
            .flags = I2C_M_RD,      /* read */
            .len   = len,
            .buf   = buf,
        },
    };
    return i2c_transfer(client->adapter, msgs, 2);
}
```

## regmap: register access abstraction

`regmap` provides a unified API for register access across I2C, SPI, MMIO, and other buses:

```c
#include <linux/regmap.h>

/* Define the register map configuration: */
static const struct regmap_config my_regmap_config = {
    .reg_bits   = 8,    /* register address width */
    .val_bits   = 8,    /* register value width */
    .max_register = 0xFF,

    /* Optional: caching for read-only or slow registers */
    .cache_type = REGCACHE_RBTREE,

    /* Readable/writeable register masks: */
    .readable_reg = my_readable_reg,
    .writeable_reg = my_writeable_reg,
    .volatile_reg  = my_volatile_reg,  /* not cached */
};

static int my_sensor_probe(struct i2c_client *client)
{
    struct my_sensor *sensor;
    struct regmap *regmap;

    /* Create regmap backed by I2C: */
    regmap = devm_regmap_init_i2c(client, &my_regmap_config);
    if (IS_ERR(regmap))
        return PTR_ERR(regmap);

    sensor->regmap = regmap;
    /* ... */
}

/* Use regmap for register access: */
unsigned int val;
regmap_read(sensor->regmap, REG_STATUS, &val);
regmap_write(sensor->regmap, REG_CONFIG, 0x01);

/* Read-modify-write (atomic): */
regmap_update_bits(sensor->regmap, REG_CONFIG,
                   BIT(3) | BIT(2),   /* mask */
                   BIT(3));           /* value: set bit 3, clear bit 2 */

/* Bulk read multiple consecutive registers: */
u8 buf[6];
regmap_bulk_read(sensor->regmap, REG_DATA_START, buf, 6);
```

## SPI overview

SPI (Serial Peripheral Interface) is a synchronous 4-wire protocol:

```
SCLK  ──────────────────── clock (master-driven)
MOSI  ──────────────────── master-out slave-in
MISO  ──────────────────── master-in slave-out
CS/SS ──────────────────── chip select (one per device, active-low)

Unlike I2C:
  - Full-duplex (simultaneous TX and RX)
  - No addressing: CS line selects device
  - No ACK: master never knows if slave received
  - Higher speeds (up to 100+ MHz vs I2C's 3.4 MHz)
```

## SPI device driver

```c
#include <linux/spi/spi.h>

struct my_spi_dev {
    struct spi_device *spi;
    struct mutex       lock;
};

static const struct of_device_id my_spi_of_match[] = {
    { .compatible = "vendor,my-spi-sensor" },
    { }
};

static int my_spi_probe(struct spi_device *spi)
{
    struct my_spi_dev *dev;

    /* Configure SPI parameters: */
    spi->bits_per_word = 8;
    spi->mode          = SPI_MODE_0;    /* CPOL=0, CPHA=0 */
    spi->max_speed_hz  = 10000000;      /* 10 MHz */
    spi_setup(spi);                      /* apply configuration */

    dev = devm_kzalloc(&spi->dev, sizeof(*dev), GFP_KERNEL);
    dev->spi = spi;
    spi_set_drvdata(spi, dev);

    return my_spi_dev_init(dev);
}

static struct spi_driver my_spi_driver = {
    .driver = {
        .name         = "my-spi-sensor",
        .of_match_table = my_spi_of_match,
    },
    .probe = my_spi_probe,
};
module_spi_driver(my_spi_driver);
```

## SPI transfer functions

```c
/* Simple synchronous read/write: */
u8 tx_buf[4], rx_buf[4];

/* Full-duplex transfer (TX and RX simultaneously): */
struct spi_transfer t = {
    .tx_buf = tx_buf,
    .rx_buf = rx_buf,
    .len    = 4,
    .speed_hz = 5000000,  /* override default speed */
};
struct spi_message m;
spi_message_init(&m);
spi_message_add_tail(&t, &m);
ret = spi_sync(spi, &m);

/* Convenience wrappers: */
spi_write(spi, tx_buf, 4);           /* TX only */
spi_read(spi, rx_buf, 4);            /* RX only (sends 0x00) */
spi_write_then_read(spi, tx_buf, 2, rx_buf, 4);  /* CS held low between */

/* regmap for SPI (same API as I2C!): */
regmap = devm_regmap_init_spi(spi, &my_regmap_config);
regmap_read(regmap, REG_ID, &val);
```

## Device Tree instantiation

```dts
/* Board DTS: */
&i2c1 {
    status = "okay";
    clock-frequency = <400000>;  /* 400 kHz fast mode */

    my_sensor: sensor@48 {
        compatible = "vendor,my-sensor";
        reg = <0x48>;            /* I2C address */
        vdd-supply = <&ldo3>;    /* power supply */
        interrupt-parent = <&gpio0>;
        interrupts = <15 IRQ_TYPE_EDGE_FALLING>;
    };
};

&spi0 {
    status = "okay";
    cs-gpios = <&gpio1 5 GPIO_ACTIVE_LOW>;

    my_spi_sensor: sensor@0 {
        compatible = "vendor,my-spi-sensor";
        reg = <0>;              /* chip select 0 */
        spi-max-frequency = <10000000>;
        spi-cpol;               /* CPOL=1 */
        spi-cpha;               /* CPHA=1 → together: SPI_MODE_3 */
    };
};
```

## Debugging I2C/SPI

```bash
# List I2C buses:
ls /dev/i2c-*
i2cdetect -l

# Scan I2C bus 1 for devices:
i2cdetect -y 1
#      0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f
# 40: -- -- -- -- -- -- -- -- 48 -- -- -- -- -- -- --
# (device found at address 0x48)

# Read register 0x00 from device at address 0x48:
i2cget -y 1 0x48 0x00

# Write 0x01 to register 0x10:
i2cset -y 1 0x48 0x10 0x01

# Decode I2C traffic (if hardware supports):
# Use /sys/kernel/debug/i2c-0/
cat /sys/kernel/debug/i2c-0/timing

# SPI trace:
echo 1 > /sys/kernel/debug/dynamic_debug/control
# or use spidev_test:
spidev_test -D /dev/spidev0.0 -s 1000000 -p '\x01\x02\x03'

# regmap debugfs:
ls /sys/kernel/debug/regmap/
cat /sys/kernel/debug/regmap/my-sensor-0-0048/registers
# 00: 01
# 01: 0f
# ...

# Trace I2C transactions:
bpftrace -e '
kprobe:i2c_transfer {
    printf("i2c_transfer: adapter=%s num_msgs=%d\n",
           ((struct i2c_adapter *)arg0)->name, (int)arg2);
}'
```

## Further reading

- [Platform Drivers](platform-driver.md) — MMIO register-mapped devices
- [Device Tree](device-tree.md) — DTS binding for I2C/SPI devices
- [Device Model](device-model.md) — bus/device/driver framework
- [DMA API](../iommu/dma-api.md) — DMA for SPI controllers
- `drivers/i2c/` — I2C subsystem
- `drivers/spi/` — SPI subsystem
- `include/linux/regmap.h` — regmap API
- `Documentation/driver-api/i2c.rst` — I2C driver guide
