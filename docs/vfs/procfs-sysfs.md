# procfs and sysfs

> How /proc and /sys expose kernel state to userspace

## /proc: the process filesystem

`/proc` is a virtual filesystem that exposes kernel and process information. Files in `/proc` have no on-disk representation — content is generated on-the-fly when read.

```bash
# Common /proc files:
/proc/cpuinfo         # CPU description
/proc/meminfo         # memory statistics
/proc/interrupts      # IRQ counts per CPU
/proc/net/dev         # network interface statistics
/proc/sys/            # sysctl tunables

# Per-process (one directory per PID):
/proc/<pid>/maps      # virtual memory areas
/proc/<pid>/status    # task status
/proc/<pid>/fd/       # open file descriptors (symlinks)
/proc/<pid>/cmdline   # command line arguments
/proc/<pid>/mem       # process memory (requires ptrace)
```

## Creating a /proc entry

### Simple single-value file

```c
#include <linux/proc_fs.h>
#include <linux/seq_file.h>

/* Show function: called on read */
static int mymod_show(struct seq_file *m, void *v)
{
    seq_printf(m, "value: %d\n", my_value);
    seq_printf(m, "name: %s\n", my_name);
    return 0;
}

/* Write function: called on write */
static ssize_t mymod_write(struct file *file, const char __user *buf,
                             size_t count, loff_t *ppos)
{
    char kbuf[32];
    if (copy_from_user(kbuf, buf, min(count, sizeof(kbuf) - 1)))
        return -EFAULT;
    kbuf[count] = '\0';
    kstrtoint(kbuf, 10, &my_value);
    return count;
}

/* File operations: use single_open for simple one-page files */
static int mymod_open(struct inode *inode, struct file *file)
{
    return single_open(file, mymod_show, NULL);
}

static const struct proc_ops mymod_fops = {
    .proc_open    = mymod_open,
    .proc_read    = seq_read,
    .proc_write   = mymod_write,
    .proc_lseek   = seq_lseek,
    .proc_release = single_release,
};

/* Create /proc/mymod on init */
static int __init mymod_init(void)
{
    proc_create("mymod", 0644, NULL, &mymod_fops);
    /* NULL parent = /proc/ root */
    return 0;
}

static void __exit mymod_exit(void)
{
    remove_proc_entry("mymod", NULL);
}
```

### seq_file: multi-page iterators

For files with many entries (like `/proc/net/tcp`), use the seq_file iterator API:

```c
/* Iterate over a list of entries */
static void *mylist_seq_start(struct seq_file *m, loff_t *pos)
{
    return seq_list_start(&my_list, *pos);
}

static void *mylist_seq_next(struct seq_file *m, void *v, loff_t *pos)
{
    return seq_list_next(v, &my_list, pos);
}

static void mylist_seq_stop(struct seq_file *m, void *v)
{
    /* Cleanup if needed (unlock, etc.) */
}

static int mylist_seq_show(struct seq_file *m, void *v)
{
    struct my_entry *e = list_entry(v, struct my_entry, list);
    seq_printf(m, "%s %d %llu\n", e->name, e->count, e->bytes);
    return 0;
}

static const struct seq_operations mylist_seq_ops = {
    .start = mylist_seq_start,
    .next  = mylist_seq_next,
    .stop  = mylist_seq_stop,
    .show  = mylist_seq_show,
};

/* Open: set up the seq_file */
static int mylist_open(struct inode *inode, struct file *file)
{
    return seq_open(file, &mylist_seq_ops);
}
```

`seq_file` handles pagination automatically: if the output doesn't fit in one page, the kernel calls `start`/`next`/`show` again with the right offset for the next read.

### /proc directory

```c
struct proc_dir_entry *mydir;

/* Create /proc/mymod/ directory */
mydir = proc_mkdir("mymod", NULL);

/* Create /proc/mymod/status */
proc_create("status", 0444, mydir, &status_fops);

/* Create /proc/mymod/stats (read-only) */
proc_create_single("stats", 0444, mydir, stats_show);

/* Remove on exit */
remove_proc_subtree("mymod", NULL);
```

## /proc internals: struct proc_dir_entry

```c
/* fs/proc/internal.h */
struct proc_dir_entry {
    /* Inode number: assigned sequentially */
    unsigned int    low_ino;
    nlink_t         nlink;
    kuid_t          uid;
    kgid_t          gid;
    loff_t          size;

    const struct inode_operations *proc_iops;
    union {
        const struct proc_ops *proc_ops;
        const struct file_operations *proc_dir_ops;
    };
    const struct dentry_operations *proc_dops;
    union {
        const struct seq_operations *seq_ops;
        int (*single_show)(struct seq_file *, void *);
    };
    proc_write_t write;
    void         *data;
    unsigned int  state_size;
    unsigned int  len;
    char          name[];
};
```

The `/proc` filesystem is implemented as a regular VFS filesystem (`proc_fs_type`) that creates inodes on demand when a path is looked up.

## sysfs: the device and driver hierarchy

`sysfs` is mounted at `/sys` and exposes the kernel's device model as a directory tree:

```
/sys/
├── bus/           (bus types: pci, usb, i2c, ...)
├── class/         (device classes: net, block, input, ...)
├── devices/       (device hierarchy mirroring hardware topology)
│   ├── pci0000:00/
│   │   └── 0000:00:1c.0/   (PCI bridge)
│   │       └── 0000:01:00.0/  (network card)
└── kernel/        (kernel parameters and statistics)
    ├── mm/transparent_hugepage/
    └── security/
```

## kobject: the sysfs object

`kobject` is the fundamental object in the sysfs/device model hierarchy:

```c
/* include/linux/kobject.h */
struct kobject {
    const char          *name;
    struct list_head    entry;
    struct kobject      *parent;         /* parent kobject */
    struct kset         *kset;
    const struct kobj_type *ktype;
    struct kernfs_node  *sd;             /* sysfs directory node */
    struct kref         kref;            /* reference count */
    /* ... */
};

/* Create a kobject (creates a sysfs directory): */
struct kobject *kobj;
kobj = kobject_create_and_add("myobject", kernel_kobj);
/* Creates: /sys/kernel/myobject/ */

/* Cleanup: */
kobject_put(kobj);  /* decrement ref; frees when 0 */
```

## Sysfs attributes: files in sysfs

```c
/* A sysfs attribute = one file in /sys/... */
struct attribute {
    const char *name;
    umode_t     mode;   /* permissions */
};

/* For device attributes (struct device): */
struct device_attribute {
    struct attribute  attr;
    ssize_t (*show)(struct device *dev, struct device_attribute *attr, char *buf);
    ssize_t (*store)(struct device *dev, struct device_attribute *attr,
                      const char *buf, size_t count);
};

/* Define a device attribute: */
static ssize_t speed_show(struct device *dev,
                           struct device_attribute *attr, char *buf)
{
    struct mydev *d = dev_get_drvdata(dev);
    return sysfs_emit(buf, "%u\n", d->speed);
}

static ssize_t speed_store(struct device *dev,
                             struct device_attribute *attr,
                             const char *buf, size_t count)
{
    struct mydev *d = dev_get_drvdata(dev);
    unsigned int val;
    if (kstrtouint(buf, 10, &val))
        return -EINVAL;
    d->speed = val;
    return count;
}

static DEVICE_ATTR_RW(speed);   /* creates dev_attr_speed */
/* DEVICE_ATTR_RO(speed): read-only */
/* DEVICE_ATTR_WO(speed): write-only */
```

### Attribute groups

Drivers typically register attribute groups (multiple attributes at once):

```c
/* Declare attributes */
static DEVICE_ATTR_RO(stats);
static DEVICE_ATTR_RW(enable);
static DEVICE_ATTR_RW(threshold);

/* Group them */
static struct attribute *mydev_attrs[] = {
    &dev_attr_stats.attr,
    &dev_attr_enable.attr,
    &dev_attr_threshold.attr,
    NULL,
};

static const struct attribute_group mydev_attr_group = {
    .attrs = mydev_attrs,
    /* Optional: .name = "config" → creates /sys/.../config/ subdir */
};

static const struct attribute_group *mydev_attr_groups[] = {
    &mydev_attr_group,
    NULL,
};

/* Register with device (in probe): */
/* Option 1: manual */
device_add_group(&pdev->dev, &mydev_attr_group);

/* Option 2: via device's driver_data at registration */
struct device_driver mydev_driver = {
    .dev_groups = mydev_attr_groups,
    /* ... */
};
/* Attributes are created/removed automatically with the device */
```

## kernfs: the sysfs backend

sysfs is built on top of `kernfs`, a generic virtual filesystem infrastructure:

```c
/* fs/kernfs/kernfs-internal.h */
struct kernfs_node {
    atomic_t         count;
    atomic_t         active;
    struct kernfs_node *parent;
    const char       *name;
    struct rb_node   rb;

    const void       *ns;       /* namespace for per-ns files */
    unsigned int     hash;

    union {
        struct kernfs_elem_dir    dir;      /* directory */
        struct kernfs_elem_symlink symlink; /* symlink */
        struct kernfs_elem_attr   attr;     /* attribute (file) */
    };

    void     *priv;       /* kobject/attribute pointer */
    kuid_t    uid;
    kgid_t    gid;
    struct kernfs_iattrs *iattr;
};
```

`/sys` attributes go through: `kernfs_fop_read_iter → kernfs_seq_show → sysfs_kf_seq_show → attribute->show()`

## sysctl: /proc/sys via sysfs-like API

```c
#include <linux/sysctl.h>

static int my_value = 42;
static int my_min = 0;
static int my_max = 1000;

static struct ctl_table mymod_table[] = {
    {
        .procname   = "my_value",
        .data       = &my_value,
        .maxlen     = sizeof(int),
        .mode       = 0644,
        .proc_handler = proc_dointvec_minmax,
        .extra1     = &my_min,
        .extra2     = &my_max,
    },
    { }  /* sentinel */
};

static struct ctl_table_header *mymod_sysctl;

static int __init mymod_init(void)
{
    mymod_sysctl = register_sysctl("mymod", mymod_table);
    /* Creates: /proc/sys/mymod/my_value */
    return 0;
}

static void __exit mymod_exit(void)
{
    unregister_sysctl_table(mymod_sysctl);
}
```

## Further reading

- [VFS Objects](vfs-objects.md) — inode/dentry fundamentals
- [Linux Device Model](../drivers/device-model.md) — kobject hierarchy in detail
- [Sysctl Reference](../mm/sysctl-reference.md) — kernel tunables via /proc/sys
- [Netlink](../net/netlink.md) — kernel-userspace messaging beyond /proc
- `fs/proc/` — procfs implementation
- `fs/sysfs/` and `fs/kernfs/` — sysfs/kernfs implementation
- `include/linux/kobject.h`, `include/linux/device.h`
