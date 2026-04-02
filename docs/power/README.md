# Power Management

> CPU frequency scaling, device runtime power, and system suspend in the Linux kernel

## The power management stack

```
User space (udev, systemd, powertop)
    │
    ▼
sysfs / /sys/devices/.../power/  /sys/devices/system/cpu/cpu*/cpufreq/
    │
    ▼
PM core (drivers/base/power/)
    ├── Runtime PM:  device active/suspended lifecycle
    ├── System PM:   suspend/hibernate state machine
    └── Wakeup:      wakeup_source tracking
    │
    ▼
cpufreq subsystem (drivers/cpufreq/)
    ├── Governor:    schedutil / ondemand / powersave / performance
    └── Driver:      intel_pstate / acpi-cpufreq / cppc_cpufreq
    │
    ▼
Hardware: ACPI P-states, HWP (Hardware P-state), C-states, ARM DVFS
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [cpufreq](cpufreq.md) | P-states, governors, schedutil, intel_pstate, HWP |
| [cpuidle](cpuidle.md) | C-states, latency/power tradeoffs, menu and TEO governors |
| [Runtime PM](runtime-pm.md) | dev_pm_ops, pm_runtime_get/put, usage counting, autosuspend |
| [System Suspend](suspend.md) | suspend-to-RAM, hibernate, wakeup sources, PM notifiers |
| [Thermal Management](thermal.md) | thermal zones, trip points, cooling devices, step_wise, power_allocator |
| [Power Domains and genpd](power-domains.md) | generic_pm_domain, rail dependencies, DT binding, debugfs |
| [Power Capping and RAPL](power-capping.md) | Intel RAPL, powercap framework, MSRs, ARM SCMI |
| [War Stories](war-stories.md) | Suspend regressions, runtime PM deadlocks, thermal storms, RAPL surprises |

## Quick reference

```bash
# Current CPU frequency scaling
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq

# Change governor (all CPUs)
echo schedutil | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# Device runtime PM status
cat /sys/bus/pci/devices/*/power/runtime_status
# active / suspended / error

# System suspend states available
cat /sys/power/state
# freeze mem disk

# Suspend to RAM
echo mem | sudo tee /sys/power/state

# Who is blocking suspend?
cat /sys/kernel/debug/wakeup_sources
```
