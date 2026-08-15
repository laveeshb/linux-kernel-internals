# Power Management War Stories

> Suspend regressions, thermal throttle storms, and runtime PM deadlocks

Power management is among the most regression-prone areas of the kernel. The state machines are complex, the hardware is diverse, and bugs are often timing- or platform-dependent. These incidents are composites of real failure patterns.

---

## 1. The suspend regression from a missing PM callback

### Setup

A PCIe NIC driver was submitted upstream. The driver implemented `probe`, `remove`, and the data path, but its `dev_pm_ops` structure was empty — no `suspend` or `resume` callbacks:

```c
static const struct dev_pm_ops mynic_pm_ops = {
    /* nothing here */
};
```

The driver worked perfectly on the submitter's test machine, which did not use suspend.

### What happened

On a laptop running the driver:

1. User closes lid. Systemd calls `echo mem > /sys/power/state`.
2. PM core calls `dpm_suspend()`, which walks the device list and calls each device's `->suspend` callback.
3. `mynic_pm_ops.suspend` is NULL. The PM core treats NULL as "no action needed" and marks the device as suspended without saving any hardware state.
4. The PCIe host controller is properly suspended and powers down the bus.
5. On resume, the host controller resets the PCIe bus (standard PCIe hot-reset behavior on resume).
6. The NIC's firmware and registers are in reset state, but the driver has not been told — it holds stale DMA ring pointers and register shadows from before suspend.
7. The driver accesses a DMA ring head pointer register. The hardware returns `0xFFFFFFFF` (PCIe reads to unpowered device). The driver interprets this as a fatal hardware error and calls `BUG()`.

### Diagnosis

The call trace from the kernel panic pointed into the NIC driver's interrupt handler. Enabling `CONFIG_PM_DEBUG` and `CONFIG_PM_SLEEP_DEBUG` added logging that showed the device was not going through its suspend path. Comparing against a working driver revealed the missing PM callbacks.

### Fix

```c
static int mynic_suspend(struct device *dev)
{
    struct mynic_priv *priv = dev_get_drvdata(dev);

    /* Stop DMA and interrupts */
    mynic_disable_irq(priv);
    mynic_stop_dma(priv);

    /* Save registers that survive power-off */
    mynic_save_state(priv);

    /* Let the PCI core handle PCI config space save + D3 transition */
    return 0;
}

static int mynic_resume(struct device *dev)
{
    struct mynic_priv *priv = dev_get_drvdata(dev);

    mynic_restore_state(priv);
    mynic_reset_hw(priv);
    mynic_init_rings(priv);
    mynic_enable_irq(priv);
    return 0;
}

/* DEFINE_SIMPLE_DEV_PM_OPS fills system sleep callbacks (suspend/resume/
   freeze/thaw/poweroff/restore) with the same pair of functions. Runtime
   PM callbacks need SET_RUNTIME_PM_OPS. (The older SIMPLE_DEV_PM_OPS macro
   does the same thing but is deprecated in favor of this one.) */
static DEFINE_SIMPLE_DEV_PM_OPS(mynic_pm_ops, mynic_suspend, mynic_resume);
```

`DEFINE_SIMPLE_DEV_PM_OPS` (defined in `include/linux/pm.h`) is a convenience macro that fills the system sleep callbacks (`suspend`, `resume`, `freeze`, `thaw`, `poweroff`, `restore`) with the same pair of functions. Note: it does **not** wire up runtime PM callbacks (`runtime_suspend`, `runtime_resume`) — those require `SET_RUNTIME_PM_OPS` separately.

**Lesson**: an absent callback is not a safe default for devices with hardware state. Use `CONFIG_PM_DEBUG` during development; test with `echo mem > /sys/power/state` before submitting any driver.

---

## 2. The runtime PM deadlock

### Setup

A driver for an I2C-attached touch controller used Runtime PM. The interrupt handler read coordinates from the device and queued events:

```c
static irqreturn_t touch_irq(int irq, void *data)
{
    struct touch_priv *priv = data;

    spin_lock(&priv->lock);

    /* Wake the device if it is runtime-suspended */
    pm_runtime_get_sync(priv->dev);   /* BUG: may sleep while holding spinlock */

    read_touch_registers(priv);       /* I2C transfer */
    queue_event(priv);

    pm_runtime_put(priv->dev);
    spin_unlock(&priv->lock);
    return IRQ_HANDLED;
}
```

### What happened

`pm_runtime_get_sync()` increments the usage counter. If the device is already active, it returns immediately. But if `runtime_status == RPM_SUSPENDED`, it calls the driver's `->runtime_resume()` callback, which performs an I2C transfer to bring the hardware out of low power. I2C transfers may sleep (they wait for bus transactions to complete).

Sleeping inside a spinlock violates a fundamental kernel rule — `spin_lock` disables preemption, and sleeping requires preemption to be enabled so the scheduler can run another task. The result is a BUG splat from `might_sleep()` inside the I2C subsystem, or worse, a silent deadlock.

`lockdep` reported the issue clearly:

```
BUG: sleeping function called from invalid context at kernel/locking/mutex.c:580
in_atomic(): 1, irqs_disabled(): 0, non-block: 0, pid: 42, name: kworker/0:1
...
Call Trace:
  __might_sleep
  mutex_lock_nested
  i2c_transfer
  touch_runtime_resume
  rpm_resume
  pm_runtime_get_sync
  touch_irq
```

### Fix

Two correct approaches:

**Option A** — use `pm_runtime_get_if_active()`, which never sleeps:

```c
static irqreturn_t touch_irq(int irq, void *data)
{
    struct touch_priv *priv = data;
    int active;

    spin_lock(&priv->lock);

    /* Non-blocking: returns 1 if active, 0 if suspended */
    active = pm_runtime_get_if_active(priv->dev);
    if (!active) {
        /* Device is suspended — schedule work to handle it */
        priv->irq_pending = true;
        schedule_work(&priv->resume_work);
        spin_unlock(&priv->lock);
        return IRQ_HANDLED;
    }

    read_touch_registers(priv);
    queue_event(priv);

    pm_runtime_put(priv->dev);
    spin_unlock(&priv->lock);
    return IRQ_HANDLED;
}
```

**Option B** — restructure to acquire the usage count *before* taking the spinlock:

```c
static irqreturn_t touch_irq(int irq, void *data)
{
    struct touch_priv *priv = data;

    /* Get outside the spinlock — allowed to sleep here */
    pm_runtime_get_sync(priv->dev);

    spin_lock(&priv->lock);
    read_touch_registers(priv);
    queue_event(priv);
    spin_unlock(&priv->lock);

    pm_runtime_put(priv->dev);
    return IRQ_HANDLED;
}
```

**Lesson**: `pm_runtime_get_sync()` is a potentially sleeping function. It must never be called with a spinlock held, from an interrupt handler (unless using `IRQF_NO_THREAD` and the device is known active), or from any atomic context. Use `pm_runtime_get_if_active()` in atomic context.

---

## 3. The thermal throttle storm

### Setup

A mobile SoC benchmark suite ran a sustained CPU-bound workload. The device had a single thermal zone covering the CPU cluster, with the `step_wise` governor and two cooling devices: CPU frequency (via cpufreq cooling) and a passive notification.

### What happened

```
t=0s:   CPU at 2.4 GHz, temperature rising
t=10s:  Temperature hits passive trip (85°C)
        step_wise: reduce cooling_state by 1 → frequency drops to 2.1 GHz
t=12s:  Temperature still rising (display + GPU also hot, but not managed)
        step_wise: reduce again → 1.8 GHz
t=14s:  Still rising
        step_wise: 1.5 GHz
...
t=30s:  CPU at 200 MHz (minimum), temperature has barely moved
        Benchmark reports 8% of expected throughput
```

The `step_wise` governor is reactive and single-actor: it only manages the CPU frequency, and it does so in fixed steps. It has no knowledge of the GPU or display, which were together dissipating more power than the CPU. Reducing CPU frequency helped very little because the CPU was not the primary heat source.

Additionally, `step_wise` has no integral term — it does not accumulate the error over time. It cannot throttle more aggressively when temperature remains above the trip point for an extended period.

### Fix

**Switch to `power_allocator`**: the Intelligent Power Allocation (IPA) governor uses a PID controller and manages all cooling devices in a thermal zone jointly. It asks each cooling device for its power consumption and redistributes a total budget:

```bash
echo power_allocator > /sys/class/thermal/thermal_zone0/policy

# Total sustainable power budget (mW); tune per device
echo 4000 > /sys/class/thermal/thermal_zone0/sustainable_power

# PID gains (tune for thermal mass of the device)
echo 500 > /sys/class/thermal/thermal_zone0/k_po   # overshoot gain
echo 500 > /sys/class/thermal/thermal_zone0/k_pu   # undershoot gain
echo 0   > /sys/class/thermal/thermal_zone0/k_d    # derivative
```

**Register GPU and display as cooling devices** in the same thermal zone. With all actors managed, the governor can reduce display brightness and GPU frequency alongside CPU frequency — preventing the situation where only the smallest heat source is throttled.

**Add earlier passive trip points**: if the trip point fires at 85°C but the thermal mass means the temperature keeps climbing for another 5 seconds, the governor is always behind. Moving the passive trip to 75°C gives the controller more lead time.

**Lesson**: `step_wise` is appropriate for simple, well-isolated thermal zones. For SoCs with multiple interacting heat sources, `power_allocator` with all actors registered provides closed-loop control. Thermal engineering and software must be co-designed.

---

## 4. The RAPL power limit surprise

### Setup

A cloud operator deployed new servers and, to enforce per-server power budgets for billing, set RAPL long-term power limits via the powercap sysfs interface:

```bash
# Set package 0 total power limit to 150 W
echo 150000000 > /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw
# "enabled" is a zone-level attribute (shared by all constraints in the
# zone), not per-constraint — there is no constraint_0_enabled file.
echo 1 > /sys/class/powercap/intel-rapl:0/enabled
```

### What happened

The workload was a mixed read-heavy database: moderate CPU compute, high memory bandwidth. Monitoring showed:

```
CPU utilization:  35%
Memory bandwidth: 85 GB/s  (high)
Server throughput: 30% of baseline
```

The database team suspected a kernel regression. Extensive profiling showed the CPUs were frequently stalling on memory reads — not because DRAM was slow, but because DRAM accesses were being *artificially throttled*. The RAPL DRAM domain power limit was being hit:

```bash
# Read energy counters on two domains over 1 second
cat /sys/class/powercap/intel-rapl:0:1/name
# "dram"
# (energy_uj was incrementing at 45 W equivalent — the DRAM domain limit was ~20 W)
```

The problem: the operator set a package-level limit of 150 W. Within that package limit, the DRAM sub-domain had its own default OEM-configured limit (set at manufacturing to protect memory stability) of approximately 20 W. The high-bandwidth workload drove DRAM power above this limit, causing the hardware to throttle memory controller throughput independently.

Setting the package limit did not change the DRAM sub-domain limit. The operator had not realized the sub-domains existed.

### Fix

```bash
# Enumerate all zones and their current limits
for zone in /sys/class/powercap/intel-rapl:*/; do
    name=$(cat "$zone/name" 2>/dev/null)
    limit=$(cat "$zone/constraint_0_power_limit_uw" 2>/dev/null)
    echo "$name: $limit µW"
done
# package-0: 150000000 µW
# core:      (not capped)
# uncore:    (not capped)
# dram:      20000000 µW   ← this was the bottleneck

# Raise DRAM domain limit to allow full memory bandwidth
echo 40000000 > /sys/class/powercap/intel-rapl:0:1/constraint_0_power_limit_uw
```

After raising the DRAM limit, memory bandwidth throttling disappeared and throughput returned to baseline — well within the 150 W package budget because the CPU cores were only at 35% load.

**Lesson**: RAPL sub-domain limits are independent of the package limit. Before setting power caps, enumerate all domains with `for zone in /sys/class/powercap/intel-rapl*/; do cat $zone/name $zone/constraint_0_power_limit_uw; done` and understand which domain is the actual bottleneck. Monitor `energy_uj` on all sub-domains during workload characterization.

---

## 5. The S2idle wakeup source mystery

### Setup

A laptop was deployed with S2idle (suspend-to-idle, `echo s2idle > /sys/power/mem_sleep`) as the default sleep mode. Users reported the laptop woke up approximately 30 seconds after being closed, every time, regardless of whether anything was plugged in.

### Diagnosis

```bash
# Observe dmesg immediately after a premature wake
dmesg | grep -i "wakeup\|wake\|resume" | tail -20
# PM: Waking up from sleep state 'freeze'
# PM: resume from suspend-to-idle
# (no device name in the message — firmware-level wakeup)

# Check wakeup_sources for recent activity
# Columns (drivers/base/power/wakeup.c, print_wakeup_source_stats()):
# name  active_count  event_count  wakeup_count  expire_count  active_since
# total_time  max_time  last_change  prevent_suspend_time
cat /sys/kernel/debug/wakeup_sources | sort -k4 -rn | head -10
# name                active_count  event_count  wakeup_count  ...
# i2c-touchpad        47            47            47           ...
# (wakeup_count matches the number of lid-close sleep attempts)
```

The `wakeup_count` field counts how many times a wakeup source generated a wakeup event. The I2C touchpad's `wakeup_count` incremented by 1 each time the lid was closed. The touchpad's firmware was generating spurious interrupt assertions during idle — even with the lid closed and no finger contact.

Confirming via `ftrace`:

```bash
echo 1 > /sys/kernel/debug/tracing/events/power/wakeup_source_activate/enable
cat /sys/kernel/debug/tracing/trace_pipe
# wakeup_source_activate: name=i2c-touchpad state=1
```

The wakeup fired from the I2C touchpad device, which had `wakeup` capability enabled by default in the ACPI tables.

### Fix

**Immediate workaround** — disable the wakeup capability for this device:

```bash
# Identify the I2C device path
ls /sys/bus/i2c/devices/
# i2c-0  i2c-1  i2c-2  ...

# Find the touchpad
grep -r "ELAN\|i2c-hid\|touchpad" /sys/bus/i2c/devices/*/name 2>/dev/null
# /sys/bus/i2c/devices/i2c-2/name: ELAN0001:00

# Disable wakeup for this device
echo disabled > /sys/bus/i2c/devices/i2c-2/power/wakeup

# Persist across reboots via udev rule
echo 'ACTION=="add", SUBSYSTEM=="i2c", ATTR{name}=="ELAN0001:00", \
  ATTR{power/wakeup}="disabled"' > /etc/udev/rules.d/99-touchpad-wakeup.rules
```

**How the sysfs workaround actually silences it** — `drivers/hid/i2c-hid/i2c-hid-core.c`'s `i2c_hid_core_suspend()` always puts the device into the low-power `I2C_HID_PWR_SLEEP` state and calls `disable_irq()` on the client's IRQ line, but only calls `i2c_hid_core_power_down()` — a full, driver-specific power cutoff — when `device_may_wakeup()` returns false for the device. Disabling wakeup via `power/wakeup` in sysfs is exactly what makes `device_may_wakeup()` return false, so it routes the touchpad through the full power-down path on every suspend, which is what actually stops the spurious firmware-level IRQ assertions — not just a "do nothing" flag.

**Lesson**: S2idle wakeup debugging always starts at `/sys/kernel/debug/wakeup_sources`. Sort by `wakeup_count` or `active_count` to find the culprit. The `wakeup_source_activate` ftrace event identifies the exact source. After finding the device, either disable its wakeup capability via sysfs or fix the driver to silence the hardware during idle.

---

## Further reading

### Kernel source

- [drivers/base/power/main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/base/power/main.c) — `dpm_run_callback()`'s `if (!cb) return 0;`, the exact mechanism that lets a NULL `suspend` hook silently do nothing, behind Case 1
- [include/linux/pm.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pm.h) — `DEFINE_SIMPLE_DEV_PM_OPS()` (the current macro; `SIMPLE_DEV_PM_OPS()` is now deprecated but equivalent) and `SET_RUNTIME_PM_OPS()`, Case 1's fix
- [drivers/pci/pci-driver.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pci/pci-driver.c) — `pci_pm_suspend()`, the bus-level `dev_pm_ops` that wraps a driver's own callbacks and still performs PCI config-space save and the D3 transition, Case 1
- [include/linux/pm_runtime.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pm_runtime.h) and [drivers/base/power/runtime.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/base/power/runtime.c) — `pm_runtime_get_sync()` (may sleep) versus `pm_runtime_get_if_active()` (never sleeps, returns 1/0), Case 2
- [drivers/thermal/gov_step_wise.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/thermal/gov_step_wise.c) and [drivers/thermal/gov_power_allocator.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/thermal/gov_power_allocator.c) — the single-step throttling logic versus the PID controller, Case 3
- [drivers/powercap/intel_rapl_common.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/powercap/intel_rapl_common.c) — `rapl_domain_names[]` (`"package"`, `"core"`, `"uncore"`, `"dram"`), the independent sub-domains behind Case 4
- [drivers/base/power/wakeup.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/base/power/wakeup.c) — `print_wakeup_source_stats()`, the column layout of `/sys/kernel/debug/wakeup_sources`, and the `wakeup_source_activate` tracepoint, Case 5
- [drivers/hid/i2c-hid/i2c-hid-core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/hid/i2c-hid/i2c-hid-core.c) — `i2c_hid_core_suspend()`, which powers the device down via `i2c_hid_core_power_down()` only when `device_may_wakeup()` is false, Case 5

### Related pages

- [Runtime PM](runtime-pm.md) — usage counting, callbacks, atomic context restrictions
- [System Suspend](suspend.md) — PM notifiers, freeze sequence, wakeup sources
- [Thermal Management](thermal.md) — step_wise vs power_allocator governors
- [Power Capping and RAPL](power-capping.md) — RAPL domain enumeration and limits

### LWN articles

- [Runtime power management](https://lwn.net/Articles/347573/) (August 19, 2009) — the original `runtime_suspend`/`runtime_resume`/`runtime_idle` additions to `dev_pm_ops`, behind Case 2
- [The power allocator thermal governor](https://lwn.net/Articles/602517/) (June 17, 2014) — the PID-controller design that Case 3's fix switches to
- [Power Capping Framework and RAPL Driver](https://lwn.net/Articles/567620/) (September 19, 2013) — the original powercap-framework and intel-rapl driver submission, the uniform sysfs interface behind Case 4

### External

- [Runtime Power Management Framework for I/O Devices](https://docs.kernel.org/power/runtime_pm.html) — canonical Runtime PM documentation, including `pm_runtime_get_if_active()`'s never-sleeps guarantee, Case 2
- [Basic PM Debugging](https://docs.kernel.org/power/basic-pm-debugging.html) — `/sys/power/pm_test`, `CONFIG_PM_DEBUG`, and the driver-isolation technique from Case 1's diagnosis
- [Power Capping Framework](https://docs.kernel.org/power/powercap/powercap.html) — the `constraint_N_power_limit_uw`/`enabled` sysfs ABI and the zone hierarchy behind Case 4
- [System Sleep States](https://docs.kernel.org/admin-guide/pm/sleep-states.html) — suspend-to-idle (`s2idle`), `/sys/power/mem_sleep`, and wakeup-capable devices, Case 5
