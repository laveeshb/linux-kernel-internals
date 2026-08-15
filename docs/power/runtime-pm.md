# Runtime PM

> Device-level power management: suspending idle devices while the system runs

## What is Runtime PM?

Runtime PM allows individual devices to enter low-power states while the rest of the system continues running. A GPU can be powered off when no display is attached; a USB device can be suspended when idle; a PCIe NIC can cut power to its PHY between bursts.

```
System running (S0)
├── CPU: P-state varies with load
├── GPU:  [active] → [runtime suspended] after 2 seconds idle
├── NVMe: [active] → [runtime suspended] after 1 second idle
├── USB:  [runtime suspended] (nothing plugged in)
└── NIC:  [active]
```

## PM callbacks: struct dev_pm_ops

Every driver can register power management callbacks:

```c
/* include/linux/pm.h — abridged; see System Suspend for the _late/_early
   and _noirq variants (12 more callbacks) called during system sleep */
struct dev_pm_ops {
    /* System sleep: called on system suspend/resume */
    int (*prepare)(struct device *dev);
    void (*complete)(struct device *dev);
    int (*suspend)(struct device *dev);
    int (*resume)(struct device *dev);
    int (*freeze)(struct device *dev);    /* hibernate snapshot */
    int (*thaw)(struct device *dev);
    int (*poweroff)(struct device *dev);
    int (*restore)(struct device *dev);
    /* ... suspend_late/resume_early, freeze_late/thaw_early,
       poweroff_late/restore_early, and the six *_noirq variants ... */

    /* Runtime PM: called when device idles or resumes */
    int (*runtime_suspend)(struct device *dev);
    int (*runtime_resume)(struct device *dev);
    int (*runtime_idle)(struct device *dev);
};
```

A driver registers them with:

```c
static const struct dev_pm_ops mydriver_pm_ops = {
    SET_SYSTEM_SLEEP_PM_OPS(mydriver_suspend, mydriver_resume)
    SET_RUNTIME_PM_OPS(mydriver_runtime_suspend,
                       mydriver_runtime_resume,
                       mydriver_runtime_idle)
};

static struct platform_driver mydriver = {
    .driver = {
        .name   = "mydriver",
        .pm     = &mydriver_pm_ops,
    },
    /* ... */
};
```

## Usage counting: get and put

The core of Runtime PM is a **usage counter**. The device stays active while the counter is > 0; it may be suspended when it reaches 0.

```c
#include <linux/pm_runtime.h>

/* Increment usage count and wait for device to become active.
   If device is suspended, resumes it first. */
int ret = pm_runtime_get_sync(dev);
if (ret < 0) {
    /* Device could not be resumed — return error */
    return ret;
}

/* ... use the device ... */

/* Decrement usage count. If count reaches 0, queue an idle check
   (runs runtime_idle, then runtime_suspend if that allows it). */
pm_runtime_put(dev);

/* Or: decrement and queue suspend after the autosuspend delay */
pm_runtime_put_autosuspend(dev);
```

The difference between `pm_runtime_put` variants:

| Function | Behavior |
|----------|---------- |
| `pm_runtime_put_sync` | Runs the idle check synchronously if count reaches 0 — calls `runtime_idle()`, then `runtime_suspend()` immediately if nothing vetoes it |
| `pm_runtime_put` | Queues an async idle check if count reaches 0 |
| `pm_runtime_put_autosuspend` | Queues a suspend after the autosuspend delay if count reaches 0 |
| `pm_runtime_put_noidle` | Decrements but does not trigger suspend |

## Autosuspend

Autosuspend adds a configurable delay before suspension. This prevents thrashing when a device is briefly idle between bursts of activity:

```c
/* In probe: enable autosuspend with 2-second delay */
pm_runtime_set_autosuspend_delay(dev, 2000 /* ms */);
pm_runtime_use_autosuspend(dev);

/* Mark the device as initially active (since probe just brought it up).
   This MUST happen before pm_runtime_enable(): __pm_runtime_set_status()
   returns -EAGAIN (without changing the status) once runtime PM is
   already enabled for the device. */
pm_runtime_get_noresume(dev);
pm_runtime_set_active(dev);
pm_runtime_enable(dev);
pm_runtime_put_autosuspend(dev);
```

The autosuspend delay is also exported to userspace:

```bash
# Read/write autosuspend delay for a device (ms, -1 = disabled)
cat /sys/bus/usb/devices/1-1/power/autosuspend_delay_ms
echo 1000 | sudo tee /sys/bus/usb/devices/1-1/power/autosuspend_delay_ms
```

## Runtime PM state machine

There is no `RPM_IDLE` status — idle is a *callback*, not a status the
device parks in. The device remains `RPM_ACTIVE` the entire time its
`runtime_idle()` callback runs; only if that callback (or the caller)
goes on to request a suspend does the status change:

```
           pm_runtime_enable()
                   │
                   ▼
              [RPM_ACTIVE]
              usage_count > 0
                   │
         pm_runtime_put() → count=0
                   │
                   ▼
      still [RPM_ACTIVE] — runtime_idle() callback fires
                   │
    idle CB (or no callback) allows suspend → pm_runtime_suspend()
                   │
                   ▼
           [RPM_SUSPENDING]
      runtime_suspend() callback
                   │
                   ▼
           [RPM_SUSPENDED]
                   │
         pm_runtime_get_sync()
                   │
                   ▼
           [RPM_RESUMING]
      runtime_resume() callback
                   │
                   ▼
              [RPM_ACTIVE]
```

The real states (`enum rpm_status` in `include/linux/pm.h`) are
`RPM_INVALID`, `RPM_ACTIVE`, `RPM_RESUMING`, `RPM_SUSPENDED`,
`RPM_SUSPENDING`, and `RPM_BLOCKED`.

### The idle callback

The idle callback is called when usage count reaches 0. It decides whether to actually suspend:

```c
static int mydriver_runtime_idle(struct device *dev)
{
    struct mydata *priv = dev_get_drvdata(dev);

    /* Don't suspend if there's pending work */
    if (!list_empty(&priv->pending_list))
        return -EBUSY;  /* don't suspend */

    /* Let PM core call runtime_suspend */
    return pm_runtime_autosuspend(dev);
    /* or: return 0 (PM core will call runtime_suspend immediately) */
}
```

## struct device power fields

```c
/* include/linux/pm.h — abridged; the real struct has ~55 fields */
struct dev_pm_info {
    pm_message_t        power_state;    /* current power state */
    bool                can_wakeup:1;   /* device can generate wakeup events */
    bool                async_suspend:1;
    bool                in_dpm_list:1;

    /* Runtime PM fields (under #ifdef CONFIG_PM) */
    struct hrtimer      suspend_timer;  /* autosuspend timer */
    u64                 timer_expires;
    struct work_struct  work;

    wait_queue_head_t   wait_queue;

    atomic_t            usage_count;    /* get/put counter */
    atomic_t            child_count;    /* children that are active */

    unsigned int        disable_depth:3; /* depth of pm_runtime_disable() calls */
    int                 runtime_error;

    enum rpm_status     runtime_status; /* current runtime PM state */
};
```

## Power domains

A power domain is a hardware block that can be independently powered off. Multiple devices may share a domain — the domain stays on until all devices in it are suspended.

```c
/* include/linux/pm_domain.h */
struct generic_pm_domain {
    struct device          dev;
    struct dev_pm_domain domain;    /* embedded — has dev_pm_ops */
    struct list_head      gpd_list_node;

    const char           *name;
    atomic_t              sd_count;  /* number of subdomains with power "on" */
    enum gpd_status       status;    /* GENPD_STATE_ON / GENPD_STATE_OFF */

    unsigned int          device_count;
    unsigned int          device_id;       /* unique device id */
    unsigned int          suspended_count;
    unsigned int          prepared_count;
    unsigned int          performance_state; /* aggregated max performance state */

    struct dev_power_governor *gov;

    struct list_head      parent_links; /* parent domains */
    struct list_head      child_links;  /* child domains */
    struct list_head      dev_list;     /* devices in this domain */

    int (*power_off)(struct generic_pm_domain *domain);
    int (*power_on)(struct generic_pm_domain *domain);
};
```

### genpd usage (ARM SoC example)

```c
/* SoC power domain setup (in platform code or device tree) */
static struct generic_pm_domain gpu_pd = {
    .name      = "gpu",
    .power_off = gpu_domain_power_off,
    .power_on  = gpu_domain_power_on,
};

/* Attach a device to the domain */
pm_genpd_add_device(&gpu_pd, &gpu_dev);

/* Now: when all devices in gpu_pd are runtime-suspended,
   power_off() is called automatically */
```

## Runtime PM in interrupt context

`pm_runtime_get_sync` may sleep (to wait for resume). This is not allowed in interrupt context. Use the non-blocking variant:

```c
/* In interrupt handler: try to get, but don't sleep.
   pm_runtime_get_if_active() is tri-valued: 1 = active (count bumped),
   0 = not active, -EINVAL = runtime PM disabled for this device. Both
   the "not active" and "disabled" cases must skip the device — only
   ret == 1 bumped the usage count, so only that case may call put(). */
ret = pm_runtime_get_if_active(dev);
if (ret <= 0) {
    /* Device is suspended (or runtime PM is disabled) — schedule work */
    schedule_work(&priv->deferred_work);
    return IRQ_HANDLED;
}

/* Device is active */
handle_interrupt(dev);
pm_runtime_put(dev);
return IRQ_HANDLED;
```

## Observing Runtime PM

```bash
# Runtime PM status for all PCI devices
for d in /sys/bus/pci/devices/*/; do
    echo -n "$d: "
    cat "$d/power/runtime_status" 2>/dev/null || echo "N/A"
done

# Usage count and autosuspend
cat /sys/bus/pci/devices/0000:00:02.0/power/runtime_usage
cat /sys/bus/pci/devices/0000:00:02.0/power/autosuspend_delay_ms

# Enable runtime PM for a device (some drivers require userspace enable)
echo auto | sudo tee /sys/bus/usb/devices/1-1/power/control
echo on   | sudo tee /sys/bus/usb/devices/1-1/power/control  # disable

# PM tracepoints (rpm_suspend, rpm_resume, rpm_idle, rpm_usage,
# rpm_return_int, rpm_status — include/trace/events/rpm.h)
echo 1 > /sys/kernel/tracing/events/rpm/enable
cat /sys/kernel/tracing/trace_pipe
# mydriver 0000:01:00.0: rpm_idle flags 0x0
# mydriver 0000:01:00.0: rpm_suspend flags 0x4

# powertop shows device runtime PM activity
sudo powertop --html=powertop.html
```

## Common pitfalls

### Forgetting pm_runtime_enable

```c
/* WRONG: runtime PM is disabled by default */
static int mydriver_probe(struct platform_device *pdev)
{
    /* ... setup ... */
    /* missing: pm_runtime_enable(&pdev->dev) */
    return 0;
}
/* pm_runtime_get_sync will always return -EACCES when runtime PM disabled */
```

### Not balancing get/put

```c
/* WRONG: skipping put on error path */
static int mydriver_do_io(struct device *dev)
{
    pm_runtime_get_sync(dev);
    if (error_condition)
        return -EIO;  /* leaked get! usage_count never decremented */
    pm_runtime_put(dev);
    return 0;
}

/* RIGHT: always put */
static int mydriver_do_io(struct device *dev)
{
    int ret;
    pm_runtime_get_sync(dev);
    ret = do_actual_io(dev);
    pm_runtime_put(dev);
    return ret;
}
```

### Calling get_sync in atomic context

```c
/* WRONG: pm_runtime_get_sync may sleep */
spin_lock_irqsave(&lock, flags);
pm_runtime_get_sync(dev);  /* may sleep! BUG */
```

## Further reading

### Kernel source

- [include/linux/pm.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pm.h) — `struct dev_pm_ops`, `struct dev_pm_info`, and the `SET_RUNTIME_PM_OPS()`/`SET_SYSTEM_SLEEP_PM_OPS()` macros
- [include/linux/pm_runtime.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pm_runtime.h) — the `pm_runtime_get*()`/`pm_runtime_put*()` inline wrappers and autosuspend helpers
- [drivers/base/power/runtime.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/base/power/runtime.c) — the runtime PM core: `__pm_runtime_suspend()`, `__pm_runtime_resume()`, `pm_runtime_get_if_active()`, and the `RPM_*` state machine
- [include/linux/pm_domain.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pm_domain.h) — `struct generic_pm_domain` and `enum gpd_status`
- [drivers/pmdomain/core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pmdomain/core.c) — `pm_genpd_add_device()` and the genpd core (moved here from `drivers/base/power/domain.c` during the driver-core reorganization)

### Related pages

- [Power Domains and genpd](power-domains.md) — full treatment of `struct generic_pm_domain`, governors, and the devicetree binding
- [cpufreq](cpufreq.md) — CPU-level frequency/voltage scaling
- [System Suspend](suspend.md) — system-wide sleep states
- [Device Drivers: platform driver](../drivers/platform-driver.md) — devm_ and probe flow

### LWN articles

- [Runtime power management](https://lwn.net/Articles/347573/) — Jonathan Corbet, August 19, 2009; Rafael Wysocki's original runtime PM patch set and the `runtime_suspend`/`runtime_resume`/`runtime_idle` callbacks described above

### External

- [Documentation/power/runtime_pm.rst](https://docs.kernel.org/power/runtime_pm.html) — upstream reference for the runtime PM API, usage-count rules, and locking
