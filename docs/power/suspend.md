# System Suspend and Hibernate

> System-wide power states: suspend-to-RAM, hibernate, and the PM state machine

## Sleep states

Linux supports multiple system-level sleep states, described by ACPI S-states and the kernel's internal model:

| Kernel state | ACPI | Description |
|---|---|---|
| `freeze` | S0 (idle) | Freeze user processes, suspend devices. CPU stays powered. Very fast resume. |
| `standby` | S1 | Shallow sleep. CPU powered down but state retained. |
| `mem` | S3 | **Suspend-to-RAM (STR)**. All state in DRAM, rest powered off. Common laptop sleep. |
| `disk` | S4 | **Hibernate (STD)**. Memory image written to swap/file, power completely off. |

```bash
# Check which states are available
cat /sys/power/state
# freeze mem disk

# Enter suspend-to-RAM
echo mem | sudo tee /sys/power/state
```

## The suspend state machine

```
/sys/power/state write "mem"
        │
        ▼
kernel/power/suspend.c: pm_suspend()
        │
        ├─ 1. Sync filesystems
        │
        ├─ 2. Freeze userspace processes
        │      freeze_processes() — set TIF_SIGPENDING, tasks reach
        │      try_to_freeze() and enter the refrigerator (freezable points)
        │
        ├─ 3. Suspend devices (reverse probe order)
        │      dpm_suspend_start() → each driver's .suspend callback
        │      (deepest devices in tree suspended first)
        │
        ├─ 4. Disable non-boot CPUs (CPU hotplug)
        │
        ├─ 5. Suspend syscore (timers, IRQ chips, clocksource)
        │      syscore_suspend() — last things before hardware off
        │
        ├─ 6. Enter hardware sleep
        │      acpi_suspend_enter() or platform-specific
        │      ──────────────── ASLEEP ────────────────
        │
        └─ 7. Resume (reverse order):
               syscore_resume()
               Enable CPUs
               dpm_resume_end() → each driver's .resume callback
               Thaw processes
```

## PM notifiers

Notifiers allow subsystems to react to suspend/resume events:

```c
#include <linux/suspend.h>

static int mysubsys_pm_notify(struct notifier_block *nb,
                               unsigned long action, void *data)
{
    switch (action) {
    case PM_SUSPEND_PREPARE:
        /* About to suspend: flush caches, stop background work */
        flush_workqueue(mysubsys_wq);
        break;
    case PM_POST_SUSPEND:
        /* Resumed: restart background work */
        queue_delayed_work(mysubsys_wq, &mysubsys_work, HZ);
        break;
    case PM_HIBERNATION_PREPARE:
        break;
    case PM_POST_HIBERNATION:
        break;
    case PM_RESTORE_PREPARE:   /* before loading hibernate image */
        break;
    case PM_POST_RESTORE:
        break;
    }
    return NOTIFY_OK;
}

static struct notifier_block mysubsys_pm_nb = {
    .notifier_call = mysubsys_pm_notify,
};

/* Register */
register_pm_notifier(&mysubsys_pm_nb);

/* Unregister */
unregister_pm_notifier(&mysubsys_pm_nb);
```

## Device suspend callbacks

The full driver PM callback sequence for system suspend:

```
dpm_prepare()      → driver .prepare()         (optional; prepare for suspend)
dpm_suspend()      → driver .suspend()          (save state, stop DMA)
dpm_suspend_late() → driver .suspend_late()     (last operations before power off)
dpm_suspend_noirq()→ driver .suspend_noirq()    (IRQs disabled; final operations)
─────────────── hardware suspended ───────────────
dpm_resume_noirq() → driver .resume_noirq()     (IRQs still disabled)
dpm_resume_early() → driver .resume_early()     (restore critical state)
dpm_resume()       → driver .resume()           (full restore)
dpm_complete()     → driver .complete()         (post-resume cleanup)
```

For most drivers, only `.suspend` and `.resume` need implementation. The `_noirq` and `_late/_early` variants are for hardware that requires very late/early access.

### Minimal suspend implementation

```c
static int mydriver_suspend(struct device *dev)
{
    struct mydata *priv = dev_get_drvdata(dev);

    /* Stop hardware operations */
    mydriver_stop_hw(priv);

    /* Save registers that hardware won't retain */
    priv->saved_config = readl(priv->base + CONFIG_REG);
    priv->saved_irq_mask = readl(priv->base + IRQ_MASK_REG);

    /* Disable clocks/power */
    clk_disable_unprepare(priv->clk);

    return 0;
}

static int mydriver_resume(struct device *dev)
{
    struct mydata *priv = dev_get_drvdata(dev);
    int ret;

    /* Re-enable clocks/power */
    ret = clk_prepare_enable(priv->clk);
    if (ret)
        return ret;

    /* Restore saved registers */
    writel(priv->saved_config,   priv->base + CONFIG_REG);
    writel(priv->saved_irq_mask, priv->base + IRQ_MASK_REG);

    /* Reinitialize hardware */
    mydriver_init_hw(priv);

    return 0;
}

/* Shared PM ops using the SET_ macros */
static const struct dev_pm_ops mydriver_pm_ops = {
    SET_SYSTEM_SLEEP_PM_OPS(mydriver_suspend, mydriver_resume)
    SET_RUNTIME_PM_OPS(mydriver_runtime_suspend,
                       mydriver_runtime_resume, NULL)
};
```

## Wakeup sources

A **wakeup source** is a hardware event that can wake the system from sleep. Common wakeup sources: keyboard, touchpad, NIC (Wake-on-LAN), RTC alarm, USB.

```c
/* Driver: register a wakeup source */
static int mydriver_probe(struct platform_device *pdev)
{
    struct mydata *priv;
    /* ... */

    device_init_wakeup(&pdev->dev, true);  /* this device can wake the system */

    /* Configure hardware to assert wakeup interrupt during suspend */
    /* ... */
    return 0;
}

/* Before suspend: arm the wakeup interrupt */
static int mydriver_suspend(struct device *dev)
{
    if (device_may_wakeup(dev))
        enable_irq_wake(priv->irq);  /* route IRQ as wakeup source */
    /* ... */
}

static int mydriver_resume(struct device *dev)
{
    if (device_may_wakeup(dev))
        disable_irq_wake(priv->irq);
    /* ... */
}
```

### Wakeup source tracking

```c
#include <linux/pm_wakeup.h>

/* The kernel tracks active wakeup sources */
struct wakeup_source {
    const char           *name;
    int                    id;
    struct list_head      entry;
    spinlock_t            lock;
    struct wake_irq      *wakeirq;
    struct timer_list     timer;
    unsigned long         timer_expires;
    ktime_t               total_time;
    ktime_t               max_time;
    ktime_t               last_time;
    ktime_t               start_prevent_time;
    ktime_t               prevent_sleep_time;
    unsigned long         event_count;
    unsigned long         active_count;
    unsigned long         relax_count;
    unsigned long         expire_count;
    unsigned long         wakeup_count;
    struct device        *dev;
    bool                   active:1;
    bool                   autosleep_enabled:1;
};
```

```bash
# Which wakeup sources are active (blocking suspend)?
cat /sys/kernel/debug/wakeup_sources
# name          active_count  event_count  wakeup_count  expire_count  active_since  total_time  max_time  last_change  prevent_suspend_time
# NETLINK       0             1234         0             0             0             0           0         12345        0
# battery       1             5678         1             0             12345         67890       12345     67890        12345

# Which IRQs can wake the system?
cat /proc/interrupts | grep -i wake

# Last wakeup reason (after resume)
cat /sys/kernel/debug/suspend_stats
```

## Hibernate (suspend-to-disk)

Hibernation saves the entire memory image to disk, then powers off. On resume, the image is read back and execution continues exactly where it left off.

```
echo disk | sudo tee /sys/power/state
```

### Hibernate state machine

```
1. Freeze processes
2. Create memory snapshot (swsusp_save):
   - Walk all pages, copy to free pages or swap
   - The "hibernation image" = all in-use memory pages
3. Write image to swap partition or hibernation file
4. Power off
─────────── powered off ──────────
5. Boot (normal cold boot; bootloader has no special role)
6. Kernel: check resume= parameter or /sys/power/resume device for hibernation image
7. swsusp_read(): read the image back from swap
8. hibernation_restore(): overwrite running kernel pages with the saved image
9. Resume execution at hibernation point
```

### Configuring hibernate destination

```bash
# Use a specific swap partition
echo /dev/sda2 | sudo tee /sys/power/resume

# Or a swap file: /sys/power/resume_offset takes the raw <PAGE_SIZE>-unit
# offset of the swap file's header within its partition (found via the
# FIBMAP ioctl — see Documentation/power/swsusp-and-swap-files.rst), then
# /sys/power/resume names the partition holding the file
echo 34816 | sudo tee /sys/power/resume_offset
echo /dev/sda1 | sudo tee /sys/power/resume  # partition containing the swap file

# Equivalently, on the kernel command line:
# resume=/dev/sda1 resume_offset=34816

# Check current hibernate device
cat /sys/power/resume
```

## Freeze (s2idle / S0ix)

Modern laptops use **s2idle** (suspend-to-idle, sometimes called S0ix or "connected standby"). Unlike S3, the CPU stays in a very shallow sleep state, allowing:

- Bluetooth/WiFi to stay connected
- Background tasks to run at reduced rate
- Faster wake time (~1 second vs ~3 seconds for S3)

```bash
# Force s2idle (ignore platform S3 support)
echo s2idle | sudo tee /sys/power/mem_sleep

# Or prefer S3 if available
echo deep | sudo tee /sys/power/mem_sleep

cat /sys/power/mem_sleep
# s2idle [deep]   (brackets = current selection)
```

## Diagnosing suspend failures

```bash
# Verbose suspend logging
echo 1 | sudo tee /sys/power/pm_debug_messages
echo 1 | sudo tee /sys/power/pm_print_times

# After failed suspend attempt
dmesg | grep -E "PM:|suspend|freeze" | tail -50

# Which device failed to suspend?
dmesg | grep "error during suspend"

# Time each driver's suspend callback takes
cat /sys/kernel/debug/suspend_stats
# success: 42
# fail: 2
# failed_freeze: 0
# failed_prepare: 0
# failed_suspend: 1       ← driver failed here
# failed_suspend_noirq: 0

# Enable PM tracepoints for detailed timeline
echo 1 > /sys/kernel/tracing/events/power/device_pm_callback_start/enable
echo 1 > /sys/kernel/tracing/events/power/device_pm_callback_end/enable
cat /sys/kernel/tracing/trace_pipe > /tmp/suspend_trace &
echo mem | sudo tee /sys/power/state
# Ctrl-C background cat, examine /tmp/suspend_trace
```

## Further reading

### Kernel source

- [kernel/power/suspend.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/power/suspend.c) — `pm_suspend()`, `enter_state()`, `suspend_devices_and_enter()`: the S1-S3/s2idle entry path
- [kernel/power/hibernate.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/power/hibernate.c) — `hibernate()`, `hibernation_restore()`, and the `/sys/power/resume`/`resume_offset` attributes
- [kernel/power/snapshot.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/power/snapshot.c) — `swsusp_save()`: walks all pages to build the hibernation image
- [include/linux/suspend.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/suspend.h) — `PM_SUSPEND_PREPARE`/`PM_POST_SUSPEND`/`PM_HIBERNATION_PREPARE` notifier constants, `register_pm_notifier()`
- [include/linux/pm_wakeup.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pm_wakeup.h) — `struct wakeup_source`, `device_init_wakeup()`, `device_may_wakeup()`
- [drivers/base/power/main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/base/power/main.c) — `dpm_prepare()`/`dpm_suspend()`/`dpm_suspend_late()`/`dpm_suspend_noirq()` and their resume-side counterparts

### Related pages

- [cpufreq](cpufreq.md) — CPU frequency scaling
- [Runtime PM](runtime-pm.md) — device-level power management
- [Device Drivers: platform driver](../drivers/platform-driver.md) — dev_pm_ops integration
- [Interrupts: Timers](../interrupts/timers.md) — `timer_list`, `hrtimer`, and the clocksource machinery timekeeping across suspend/resume depends on

### LWN articles

- [A new suspend/hibernate infrastructure](https://lwn.net/Articles/274008/) — Jonathan Corbet, March 19, 2008; Rafael Wysocki's rework separating the suspend and hibernation device callback paths
- [PM / Sleep: Introduce new phases of device suspend/resume](https://lwn.net/Articles/475730/) — Rafael Wysocki's patch series adding the `.suspend_late`/`.resume_early` and `_noirq` phases described above
- [Waking systems from suspend](https://lwn.net/Articles/429925/) — John Stultz, March 2, 2011; how the RTC and other wakeup sources bring a system out of suspend

### External

- [Documentation/driver-api/pm/devices.rst](https://docs.kernel.org/driver-api/pm/devices.html) — the full device suspend/resume phase model and the ordering guarantees across the device hierarchy
- [Documentation/admin-guide/pm/sleep-states.rst](https://docs.kernel.org/admin-guide/pm/sleep-states.html) — the `freeze`/`standby`/`mem`/`disk` labels and their ACPI S-state mapping
- [Documentation/admin-guide/pm/suspend-flows.rst](https://docs.kernel.org/admin-guide/pm/suspend-flows.html) — code-flow diagrams for suspend-to-idle vs. standby vs. suspend-to-RAM
- [Documentation/power/swsusp-and-swap-files.rst](https://docs.kernel.org/power/swsusp-and-swap-files.html) — how to point hibernation at a swap file instead of a swap partition
