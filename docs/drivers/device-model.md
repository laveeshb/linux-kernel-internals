# Linux Device Model

> The object-oriented framework that organizes all kernel devices

## Why the device model exists

Before 2.6, each bus subsystem (PCI, USB, SCSI) independently managed power, hotplug, and sysfs. The device model (introduced in 2.5) unified this into a single framework:

- **Power management**: suspend/resume traverse the device tree in order
- **Hotplug**: consistent uevent notifications for adding/removing devices
- **sysfs**: every device and driver automatically appears in `/sys/`
- **Reference counting**: devices live exactly as long as they're needed

## kobject: the base object

Every kernel object that appears in sysfs has a `kobject`:

```c
/* include/linux/kobject.h */
struct kobject {
    const char          *name;        /* directory name in sysfs */
    struct list_head     entry;       /* list of siblings */
    struct kobject      *parent;      /* parent in sysfs hierarchy */
    struct kset         *kset;        /* containing set */
    const struct kobj_type *ktype;    /* type with sysfs ops */
    struct kernfs_node  *sd;          /* sysfs directory node */
    struct kref          kref;        /* reference count */
    unsigned int state_initialized:1;
    unsigned int state_in_sysfs:1;
    unsigned int state_add_uevent_sent:1;
    unsigned int state_remove_uevent_sent:1;
    unsigned int uevent_suppress:1;
};
```

Reference counting:
```c
kobject_get(kobj);    /* increment refcount */
kobject_put(kobj);    /* decrement; calls ktype->release() when zero */
```

## struct device: the universal device

```c
/* include/linux/device.h */
struct device {
    struct kobject          kobj;          /* base kobject — first field */
    struct device           *parent;       /* parent device */
    struct device_private   *p;            /* private driver core data */

    const char              *init_name;    /* initial device name */
    const struct device_type *type;        /* device type */

    struct bus_type         *bus;          /* bus this device is on */
    struct device_driver    *driver;       /* driver assigned to device */
    void                    *driver_data;  /* driver-private data */

    struct dev_links_info   links;         /* supplier/consumer links */
    struct dev_pm_info      power;         /* power management state */
    struct dev_pm_domain    *pm_domain;

    struct device_node      *of_node;      /* device tree node */
    struct fwnode_handle    *fwnode;       /* firmware node (DT or ACPI) */

    dev_t                   devt;          /* major:minor (if applicable) */
    struct class            *class;        /* class (input, block, net...) */

    const struct attribute_group **groups; /* sysfs attribute groups */
    void (*release)(struct device *dev);   /* called when refcount hits 0 */

    struct iommu_group      *iommu_group;
    /* ... */
};
```

Key operations:
```c
device_initialize(dev);          /* initialize kobject */
device_add(dev);                 /* register in sysfs, send uevent */
device_register(dev);            /* = initialize + add */
device_unregister(dev);          /* remove from sysfs */

device_get(dev);                 /* get reference */
put_device(dev);                 /* release reference */

dev_set_drvdata(dev, data);      /* store driver-private pointer */
dev_get_drvdata(dev);            /* retrieve it */
```

## struct bus_type: the bus abstraction

```c
struct bus_type {
    const char          *name;          /* "pci", "usb", "platform", "i2c" */
    const char          *dev_name;      /* format for auto-named devices */
    struct device       *dev_root;      /* bus root device */

    const struct attribute_group **bus_groups;
    const struct attribute_group **dev_groups;
    const struct attribute_group **drv_groups;

    /* Called to see if a driver handles this device */
    int (*match)(struct device *dev, struct device_driver *drv);
    /* Called by userspace write to /sys/.../uevent */
    int (*uevent)(struct device *dev, struct kobj_uevent_env *env);
    /* Called when a device is about to be bound to a driver */
    int (*probe)(struct device *dev);
    /* Ordered device listing for PM */
    int (*remove)(struct device *dev);
    void (*shutdown)(struct device *dev);

    int (*online)(struct device *dev);
    int (*offline)(struct device *dev);

    int (*suspend)(struct device *dev, pm_message_t state);
    int (*resume)(struct device *dev);

    int (*num_vf)(struct device *dev);
    int (*dma_configure)(struct device *dev);
    void (*dma_cleanup)(struct device *dev);

    const struct dev_pm_ops *pm;
    const struct iommu_ops  *iommu_ops;
    struct subsys_private   *p;         /* private bus core data */
    struct lock_class_key   lock_key;
    bool need_parent_lock;
};
```

```c
/* Register a bus type */
int bus_register(struct bus_type *bus);
void bus_unregister(struct bus_type *bus);

/* Iterate over devices on a bus */
bus_for_each_dev(bus, start, data, fn);
bus_for_each_drv(bus, start, data, fn);
```

## struct device_driver

```c
struct device_driver {
    const char              *name;         /* driver name */
    struct bus_type         *bus;
    struct module           *owner;        /* THIS_MODULE */
    const char              *mod_name;

    bool                     suppress_bind_attrs;
    enum probe_type          probe_type;   /* synchronous, async, force_sync */

    const struct of_device_id   *of_match_table; /* device tree matches */
    const struct acpi_device_id *acpi_match_table;

    int (*probe)(struct device *dev);      /* bind driver to device */
    void (*sync_state)(struct device *dev);
    int (*remove)(struct device *dev);     /* unbind */
    void (*shutdown)(struct device *dev);
    int (*suspend)(struct device *dev, pm_message_t state);
    int (*resume)(struct device *dev);
    const struct attribute_group **groups;
    const struct attribute_group **dev_groups;

    const struct dev_pm_ops *pm;
    void (*coredump)(struct device *dev);

    struct driver_private *p;
};
```

## The match and probe flow

When a device is registered (or a driver is registered), the bus iterates all drivers (or devices) calling `bus->match()`. On a match, `driver_probe_device()` is called:

```c
/* drivers/base/dd.c: simplified */
static int driver_probe_device(struct device_driver *drv, struct device *dev)
{
    int ret;

    /* Check if already bound */
    if (dev->driver)
        return 0;

    /* bus-level permission check */
    if (drv->bus->match && !drv->bus->match(dev, drv))
        return 0;

    /* pin device and driver */
    dev->driver = drv;

    /* call bus probe (which usually calls driver->probe) */
    if (dev->bus->probe)
        ret = dev->bus->probe(dev);
    else if (drv->probe)
        ret = drv->probe(dev);

    if (ret) {
        dev->driver = NULL;
        return ret;
    }

    /* success: device is now bound */
    driver_bound(dev);
    return 0;
}
```

## sysfs attributes

Drivers and devices expose attributes (files) in sysfs:

```c
/* Simple device attribute */
static ssize_t temperature_show(struct device *dev,
                                 struct device_attribute *attr,
                                 char *buf)
{
    struct my_device *mydev = dev_get_drvdata(dev);
    return sysfs_emit(buf, "%d\n", read_temperature(mydev));
}

static ssize_t setpoint_store(struct device *dev,
                               struct device_attribute *attr,
                               const char *buf, size_t count)
{
    struct my_device *mydev = dev_get_drvdata(dev);
    int val;

    if (kstrtoint(buf, 10, &val) < 0)
        return -EINVAL;
    set_setpoint(mydev, val);
    return count;
}

/* DEVICE_ATTR_RO: read-only, name = "temperature" */
static DEVICE_ATTR_RO(temperature);

/* DEVICE_ATTR_WO: write-only */
/* DEVICE_ATTR_RW: read-write */
static DEVICE_ATTR_RW(setpoint);

/* Group them */
static struct attribute *mydev_attrs[] = {
    &dev_attr_temperature.attr,
    &dev_attr_setpoint.attr,
    NULL,
};
ATTRIBUTE_GROUPS(mydev);  /* creates mydev_groups[] */

/* In driver probe: */
device_add_groups(dev, mydev_groups);
```

```bash
# Result in sysfs
cat /sys/bus/platform/devices/mydev.0/temperature
# 45
echo 50 > /sys/bus/platform/devices/mydev.0/setpoint
```

## uevent: hotplug notification

When devices are added/removed, the kernel sends uevents to userspace (received by `udevd`/`systemd-udevd`):

```bash
# Watch uevents live
udevadm monitor --kernel --udev

# KERNEL: add@/devices/pci0000:00/0000:00:14.0/usb1/1-1
# ACTION=add
# DEVPATH=/devices/pci0000:00/...
# SUBSYSTEM=usb
# ...

# Rule to rename a network interface
# /etc/udev/rules.d/70-persistent-net.rules:
# SUBSYSTEM=="net", ACTION=="add", ATTR{address}=="aa:bb:cc:dd:ee:ff", NAME="eth0"
```

The kernel's `kobject_uevent()` sends netlink messages; udevd receives them and runs rules.

## Power management: dev_pm_ops

```c
static const struct dev_pm_ops my_pm_ops = {
    .suspend  = my_suspend,   /* save state, reduce power */
    .resume   = my_resume,    /* restore state */
    .freeze   = my_freeze,    /* for hibernation snapshot */
    .thaw     = my_thaw,
    .restore  = my_restore,
    /* Runtime PM: */
    .runtime_suspend = my_runtime_suspend,  /* auto-suspend when idle */
    .runtime_resume  = my_runtime_resume,
};

/* In driver: */
static int my_suspend(struct device *dev)
{
    struct my_device *mydev = dev_get_drvdata(dev);
    /* save registers, turn off clocks, etc. */
    return 0;
}
```

```c
/* Enable runtime PM for a device */
pm_runtime_enable(dev);
pm_runtime_set_active(dev);
pm_runtime_use_autosuspend(dev);
pm_runtime_set_autosuspend_delay(dev, 1000);  /* 1 second idle → suspend */

/* In device operations: */
pm_runtime_get_sync(dev);   /* increment usage count, resume if suspended */
/* ... use device ... */
pm_runtime_put_autosuspend(dev);  /* decrement, autosuspend timer starts */
```

## Further reading

- [Platform Drivers](platform-driver.md) — The most common embedded driver pattern
- [Character and Misc Devices](chardev.md) — Exposing devices to userspace via /dev
- `Documentation/driver-api/driver-model/` — kernel driver model documentation
- `drivers/base/` — core device model implementation
