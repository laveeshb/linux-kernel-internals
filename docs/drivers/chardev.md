# Character and Misc Devices

> Exposing driver functionality to userspace via /dev

## Character devices

A character device (cdev) is a special file in `/dev` that provides a byte-stream interface to a driver. Unlike block devices, character devices do not buffer data in the page cache — I/O goes directly to the driver.

```
/dev/mydevice (major=240, minor=0)
        │
        ▼
 struct cdev ────────► struct file_operations
        │                   .open
        │                   .read
        │                   .write
        │                   .unlocked_ioctl
        │                   .mmap
        │                   .release
        ▼
   driver code
```

## Allocating major/minor numbers

```c
/* Static allocation (reserved in Documentation/admin-guide/devices.txt) */
int ret = register_chrdev_region(MKDEV(240, 0), 1, "mydev");

/* Dynamic allocation (preferred): kernel assigns major */
dev_t devt;
int ret = alloc_chrdev_region(&devt, 0, /* first minor */
                               1,        /* count */
                               "mydev");
int major = MAJOR(devt);
int minor = MINOR(devt);

/* Release on exit */
unregister_chrdev_region(devt, 1);
```

## struct cdev

```c
#include <linux/cdev.h>

struct cdev {
    struct kobject          kobj;
    struct module          *owner;
    const struct file_operations *ops;
    struct list_head        list;
    dev_t                   dev;         /* major:minor */
    unsigned int            count;       /* number of minors */
};
```

## struct file_operations

```c
/* include/linux/fs.h */
struct file_operations {
    struct module *owner;
    loff_t (*llseek)(struct file *, loff_t, int);
    ssize_t (*read)(struct file *, char __user *, size_t, loff_t *);
    ssize_t (*write)(struct file *, const char __user *, size_t, loff_t *);
    ssize_t (*read_iter)(struct kiocb *, struct iov_iter *);  /* preferred */
    ssize_t (*write_iter)(struct kiocb *, struct iov_iter *);
    int (*iopoll)(struct kiocb *, struct io_comp_batch *, unsigned int flags);
    int (*iterate_shared)(struct file *, struct dir_context *);
    __poll_t (*poll)(struct file *, struct poll_table_struct *);
    long (*unlocked_ioctl)(struct file *, unsigned int, unsigned long);
    long (*compat_ioctl)(struct file *, unsigned int, unsigned long);
    int (*mmap)(struct file *, struct vm_area_struct *);
    int (*open)(struct inode *, struct file *);
    int (*flush)(struct file *, fl_owner_t id);
    int (*release)(struct inode *, struct file *);
    int (*fsync)(struct file *, loff_t, loff_t, int datasync);
    int (*fasync)(int, struct file *, int);
    /* ... */
};
```

## A complete minimal character driver

```c
/* drivers/mychardev/mychardev.c */
#include <linux/module.h>
#include <linux/cdev.h>
#include <linux/fs.h>
#include <linux/uaccess.h>
#include <linux/slab.h>

#define DEVICE_NAME "mychardev"
#define BUF_SIZE    4096

struct mychardev {
    struct cdev cdev;
    char    *buf;
    size_t   buf_len;
    struct mutex lock;
};

static struct mychardev mydev;
static dev_t devt;

static int mydev_open(struct inode *inode, struct file *filp)
{
    /* Store per-file state in filp->private_data if needed */
    struct mychardev *dev = container_of(inode->i_cdev,
                                          struct mychardev, cdev);
    filp->private_data = dev;
    return 0;
}

static ssize_t mydev_read(struct file *filp, char __user *buf,
                           size_t count, loff_t *ppos)
{
    struct mychardev *dev = filp->private_data;
    ssize_t ret;

    mutex_lock(&dev->lock);

    if (*ppos >= dev->buf_len) {
        ret = 0;  /* EOF */
        goto out;
    }

    count = min(count, dev->buf_len - (size_t)*ppos);
    if (copy_to_user(buf, dev->buf + *ppos, count)) {
        ret = -EFAULT;
        goto out;
    }

    *ppos += count;
    ret = count;

out:
    mutex_unlock(&dev->lock);
    return ret;
}

static ssize_t mydev_write(struct file *filp, const char __user *buf,
                            size_t count, loff_t *ppos)
{
    struct mychardev *dev = filp->private_data;
    ssize_t ret;

    if (count > BUF_SIZE)
        return -EINVAL;

    mutex_lock(&dev->lock);

    if (copy_from_user(dev->buf, buf, count)) {
        ret = -EFAULT;
        goto out;
    }

    dev->buf_len = count;
    *ppos = 0;
    ret = count;

out:
    mutex_unlock(&dev->lock);
    return ret;
}

static int mydev_release(struct inode *inode, struct file *filp)
{
    return 0;
}

static const struct file_operations mydev_fops = {
    .owner   = THIS_MODULE,
    .open    = mydev_open,
    .read    = mydev_read,
    .write   = mydev_write,
    .release = mydev_release,
    .llseek  = default_llseek,  /* uses f_pos */
};

static int __init mydev_init(void)
{
    int ret;

    /* Allocate device number */
    ret = alloc_chrdev_region(&devt, 0, 1, DEVICE_NAME);
    if (ret)
        return ret;

    /* Allocate and initialize cdev */
    cdev_init(&mydev.cdev, &mydev_fops);
    mydev.cdev.owner = THIS_MODULE;

    /* Allocate buffer */
    mydev.buf = kzalloc(BUF_SIZE, GFP_KERNEL);
    if (!mydev.buf) {
        unregister_chrdev_region(devt, 1);
        return -ENOMEM;
    }

    mutex_init(&mydev.lock);

    /* Register cdev — after this, open() can be called */
    ret = cdev_add(&mydev.cdev, devt, 1);
    if (ret) {
        kfree(mydev.buf);
        unregister_chrdev_region(devt, 1);
        return ret;
    }

    pr_info("mychardev: major=%d minor=%d\n", MAJOR(devt), MINOR(devt));
    return 0;
}

static void __exit mydev_exit(void)
{
    cdev_del(&mydev.cdev);
    kfree(mydev.buf);
    unregister_chrdev_region(devt, 1);
}

module_init(mydev_init);
module_exit(mydev_exit);
MODULE_LICENSE("GPL");
```

```bash
# After loading the module:
mknod /dev/mychardev c $(cat /sys/class/mychardev/mychardev/dev | cut -d: -f1) \
                      $(cat /sys/class/mychardev/mychardev/dev | cut -d: -f2)
# Or use class/device to auto-create with udev
echo "hello" > /dev/mychardev
cat /dev/mychardev  # → hello
```

## misc_register: the easy path

For simple devices that don't need multiple minors, `misc_register` handles major/minor allocation and class creation automatically:

```c
#include <linux/miscdevice.h>

static struct miscdevice mymisc = {
    .minor = MISC_DYNAMIC_MINOR,   /* kernel assigns minor */
    .name  = "mymisc",             /* /dev/mymisc */
    .fops  = &mydev_fops,
};

static int __init mymisc_init(void)
{
    return misc_register(&mymisc);
    /* /dev/mymisc created automatically via udev */
}

static void __exit mymisc_exit(void)
{
    misc_deregister(&mymisc);
}
```

All misc devices share major number 10. They appear under `/sys/class/misc/`.

## ioctl: control operations

ioctl lets userspace send control commands to the driver:

```c
/* In driver: */
static long mydev_ioctl(struct file *filp, unsigned int cmd, unsigned long arg)
{
    struct mydev_query query;

    switch (cmd) {
    case MYDEV_IOCTL_RESET:
        reset_hardware();
        return 0;

    case MYDEV_IOCTL_QUERY:
        /* Copy struct to/from userspace */
        if (copy_from_user(&query, (void __user *)arg, sizeof(query)))
            return -EFAULT;
        query.result = do_query(query.param);
        if (copy_to_user((void __user *)arg, &query, sizeof(query)))
            return -EFAULT;
        return 0;

    default:
        return -ENOTTY;  /* unknown ioctl */
    }
}
```

ioctl numbers use a structured format to avoid conflicts:

```c
/* include/uapi/linux/mydev.h */
#include <linux/ioctl.h>

/* _IO(type, nr)          — no argument */
/* _IOR(type, nr, dtype)  — read from kernel */
/* _IOW(type, nr, dtype)  — write to kernel */
/* _IOWR(type, nr, dtype) — read+write */

#define MYDEV_MAGIC 'M'
#define MYDEV_IOCTL_RESET  _IO(MYDEV_MAGIC, 0)
#define MYDEV_IOCTL_QUERY  _IOWR(MYDEV_MAGIC, 1, struct mydev_query)
```

```c
/* Userspace: */
int fd = open("/dev/mydev", O_RDWR);
ioctl(fd, MYDEV_IOCTL_RESET);
ioctl(fd, MYDEV_IOCTL_QUERY, &query);
```

## mmap: mapping device memory to userspace

Drivers can let userspace map device memory or kernel buffers directly:

```c
static int mydev_mmap(struct file *filp, struct vm_area_struct *vma)
{
    struct mychardev *dev = filp->private_data;
    unsigned long size = vma->vm_end - vma->vm_start;

    if (size > BUF_SIZE)
        return -EINVAL;

    /* Map kernel buffer to userspace */
    return remap_pfn_range(vma,
        vma->vm_start,
        virt_to_phys(dev->buf) >> PAGE_SHIFT,
        size,
        vma->vm_page_prot);
}

/* For device I/O memory (e.g., PCI BAR): */
static int mydev_mmap_io(struct file *filp, struct vm_area_struct *vma)
{
    unsigned long phys = dev->bar_phys + (vma->vm_pgoff << PAGE_SHIFT);
    unsigned long size = vma->vm_end - vma->vm_start;

    /* Mark as non-cacheable for device registers */
    vma->vm_page_prot = pgprot_noncached(vma->vm_page_prot);

    return remap_pfn_range(vma, vma->vm_start, phys >> PAGE_SHIFT,
                           size, vma->vm_page_prot);
}
```

```c
/* Userspace: */
void *mapped = mmap(NULL, size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);
/* Access device memory directly: */
volatile uint32_t *reg = (volatile uint32_t *)mapped;
uint32_t val = *reg;
```

## poll/select support

```c
static __poll_t mydev_poll(struct file *filp, poll_table *wait)
{
    struct mychardev *dev = filp->private_data;
    __poll_t mask = 0;

    poll_wait(filp, &dev->read_queue, wait);

    if (dev->data_available)
        mask |= EPOLLIN | EPOLLRDNORM;
    if (dev->write_space)
        mask |= EPOLLOUT | EPOLLWRNORM;

    return mask;
}
```

## struct device integration

To get a proper `/sys/class/` entry and auto-create `/dev/`:

```c
static struct class *mydev_class;

static int __init mydev_init(void)
{
    /* ... alloc_chrdev_region, cdev_init, cdev_add ... */

    /* Create /sys/class/mydev/ */
    mydev_class = class_create(THIS_MODULE, "mydev");
    if (IS_ERR(mydev_class))
        goto err_class;

    /* Create /sys/class/mydev/mydev0/ and trigger udev → /dev/mydev0 */
    device_create(mydev_class, NULL, devt, NULL, "mydev%d", 0);

    return 0;

err_class:
    /* cleanup */
}
```

## Further reading

- [Linux Device Model](device-model.md) — struct device, class, kobject
- [Platform Drivers](platform-driver.md) — devm_ resource management
- [VFS: File Operations](../vfs/file-ops.md) — How open/read/write reach the driver
- `Documentation/driver-api/miscellaneous_devices.rst`
