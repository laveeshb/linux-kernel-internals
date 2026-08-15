# Power Domains and genpd

> Grouping devices under shared power rails: the generic power domain framework

## The problem: shared power rails

On a desktop or server CPU, each core can individually gate its power. On an embedded SoC it is rarely that simple. A typical mobile SoC might power the GPU block, the display controller, and the memory interface for that display all from a single PMIC rail. Cutting that rail to save power requires that every device on it be quiescent first. If even one device is still doing DMA, powering off the rail corrupts data.

```
SoC power topology (simplified)

  VDD_GPU rail
  ├── GPU core
  ├── GPU MMU
  └── GPU L2 cache

  VDD_DISPLAY rail
  ├── Display controller (DPU)
  ├── DSI host
  └── MIPI PHY

Each rail: single switch, all devices must be idle before it can be cut.
```

Before genpd, each SoC vendor duplicated logic to track device idleness and sequence rail power-off. The **Generic Power Domain (genpd)** framework, introduced in Linux 3.1 (2011), provides that infrastructure once and for all.

## struct generic_pm_domain

The central structure (`include/linux/pm_domain.h`):

```c
struct generic_pm_domain {
    struct dev_pm_domain   domain;       /* embedded; exposes dev_pm_ops */
    struct list_head       gpd_list_node;/* link in global gpd_list */

    const char            *name;

    enum gpd_status        status;       /* GENPD_STATE_ON or GENPD_STATE_OFF */

    unsigned int           device_count;
    unsigned int           suspended_count;
    unsigned int           prepared_count;

    /* callbacks */
    int (*power_off)(struct generic_pm_domain *domain);
    int (*power_on) (struct generic_pm_domain *domain);

    struct list_head       dev_list;      /* struct generic_pm_domain_data per dev */
    struct list_head       parent_links;  /* links where this domain is the parent (i.e. its subdomains) */
    struct list_head       child_links;   /* links where this domain is the child (i.e. its parent domains) */

    /* governor timing data lives in genpd->gd (struct genpd_governor_data) */
};
```

`status` reflects whether the rail is currently powered:

| Value | Meaning |
|-------|---------|
| `GENPD_STATE_ON` | Rail on; at least one device is active |
| `GENPD_STATE_OFF` | Rail off; all devices are runtime-suspended |

## Registering a power domain

```c
/* platform code or SoC driver */
#include <linux/pm_domain.h>

static struct generic_pm_domain gpu_domain = {
    .name      = "gpu-domain",
    .power_off = gpu_domain_power_off,  /* cut the VDD_GPU rail */
    .power_on  = gpu_domain_power_on,   /* assert the VDD_GPU rail */
};

static int soc_pm_init(void)
{
    /* Register with genpd core; third argument: is the domain initially off? */
    pm_genpd_init(&gpu_domain, NULL /* use default governor */, false);
    return 0;
}
```

`pm_genpd_init()` links the domain into the global `gpd_list` and populates `genpd->domain.ops` (a `struct dev_pm_ops`) with genpd's own runtime-PM and system-sleep callbacks (`genpd_runtime_suspend()`, `genpd_runtime_resume()`, `genpd_suspend_noirq()`, and so on). Every device later added to this domain gets `dev->pm_domain` pointed at `&genpd->domain` via `dev_pm_domain_set()`, so those callbacks run instead of the device's bus-level ones.

## Adding devices to a domain

```c
/* Called during device probe, typically from OF glue or platform code */
int ret = pm_genpd_add_device(&gpu_domain, &gpu_dev->dev);
if (ret)
    dev_err(&gpu_dev->dev, "failed to add to power domain: %d\n", ret);
```

After this call the Runtime PM lifecycle of `gpu_dev` is managed by the domain. When `gpu_dev` calls `pm_runtime_put()`, the genpd layer intercepts `runtime_suspend` and checks whether this was the last active device. If so, it invokes `gpu_domain.power_off()`.

On ARM SoCs using Device Tree, the binding `power-domains = <&pd_gpu>` in the DTS node causes the driver core to call `dev_pm_domain_attach()` during probe, which in turn calls `genpd_dev_pm_attach()` to parse the phandle and perform the attachment automatically — no explicit driver call is needed. (`of_genpd_add_device()` is a separate, lower-level API for platform code that already has an `of_phandle_args` and wants to add a device manually.) The `&pd_gpu` phandle refers to a power domain provider registered with `of_genpd_add_provider_simple()` or `of_genpd_add_provider_onecell()`.

## Domain dependencies

Some rails have dependencies — a sub-rail cannot be on unless its parent rail is also on. genpd models this with subdomain links:

```c
/*
 * Declare: "display_dsi_domain" cannot be powered unless
 * "display_core_domain" is already powered.
 */
ret = pm_genpd_add_subdomain(&display_core_domain, &display_dsi_domain);
```

Internally each domain's `parent_links` list holds the links to its own subdomains (the domains it is parent of), while `child_links` holds the links to the domains it is itself a subdomain of. During power-on, the parent is powered first; during power-off, the child is powered off first.

```
Dependency graph:

  display_core_domain (parent)
  └── display_dsi_domain (child)
         └── mipi_phy_domain (child of child)

Power-on order:  display_core → display_dsi → mipi_phy
Power-off order: mipi_phy → display_dsi → display_core
```

## Runtime PM integration

genpd integrates transparently with Runtime PM:

```
pm_runtime_put(dev)           [device driver]
        │
        ▼
genpd runtime_suspend hook    [genpd framework]
   dev->suspended_count++
   if (domain->suspended_count == domain->device_count)
        domain->power_off()   [platform callback → cuts rail]
```

On resume the direction reverses:

```
pm_runtime_get_sync(dev)      [device driver]
        │
        ▼
genpd runtime_resume hook
   if (domain->status == GENPD_STATE_OFF)
        domain->power_on()    [platform callback → asserts rail]
   wait for power_on to settle (gpd_timing_data latency)
   dev->runtime_resume()      [device driver callback]
```

## struct gpd_timing_data

Each device can carry timing metadata used by the genpd governor to decide whether it is worth powering the domain off for a predicted idle period:

```c
/* include/linux/pm_domain.h */
struct gpd_timing_data {
    s64 suspend_latency_ns;    /* time from last device suspend to rail off */
    s64 resume_latency_ns;     /* time from power_on() call to device ready */
    s64 effective_constraint_ns;
    ktime_t next_wakeup;
    bool constraint_changed;
    bool cached_suspend_ok;
};
```

If the governor predicts the idle window is shorter than `suspend_latency_ns + resume_latency_ns`, it skips the power-off because the cost of cycling the rail exceeds the benefit.

Drivers can supply per-state timing via the `domain-idle-state` Device Tree node using `entry-latency-us` and `exit-latency-us` properties (in microseconds; the kernel scales to nanoseconds internally).

## genpd governors

Three governors ship in-tree (`drivers/pmdomain/governor.c`):

**`simple_qos_governor`** (the default): powers off the domain when all devices are suspended and the predicted idle duration exceeds the round-trip latency. It uses the `effective_constraint_ns` from QoS constraints attached to devices.

**`pm_domain_always_on_gov`**: never powers off the domain; used for domains that must stay on (e.g., always-on power rails).

**`pm_domain_cpu_gov`** (built only under `CONFIG_CPU_IDLE`): used for CPU/cluster power domains (`GENPD_FLAG_CPU_DOMAIN`); picks the deepest idle state whose residency and latency fit the predicted idle window and any CPU PM QoS constraints.

The governor is selected as the second argument to `pm_genpd_init()`. Pass `NULL` for the default `simple_qos`.

## Debugging with debugfs

The genpd core creates one directory per domain under `/sys/kernel/debug/pm_genpd/`:

```bash
# List all registered power domains
ls /sys/kernel/debug/pm_genpd/
# pm_genpd_summary  gpu-domain  display_core  display_dsi  ...

# Global summary of all domains and their devices:
cat /sys/kernel/debug/pm_genpd/pm_genpd_summary
# domain                          status          children
# gpu-domain                      on
#   /devices/platform/gpu         active  resume-latency: 0 ns
#     constraint: 0 ns

# Per-domain directories contain: current_state, sub_domains,
# idle_states, active_time, total_idle_time, devices
cat /sys/kernel/debug/pm_genpd/gpu-domain/current_state
```

The global `pm_genpd_summary` file is synthesized by `summary_show()` in `drivers/pmdomain/core.c`, which walks the global `gpd_list` and calls `genpd_summary_one()` per domain, covering all domain statuses, attached devices, and performance state in one pass.

## Real-world implementations

Several production genpd backends illustrate the framework:

**Qualcomm GDSC (Global Distributed Switch Controller)** — `drivers/clk/qcom/gdsc.c`. Each GDSC controls one power domain. The `gdsc_enable()` / `gdsc_disable()` functions register directly as a `generic_pm_domain`'s `power_on`/`power_off` callbacks; they toggle the GDSC's collapse bit (via `gdsc_toggle_logic()`) and poll the hardware for the domain to settle before returning.

**Samsung Exynos power domains** — `drivers/pmdomain/samsung/exynos-pm-domains.c`. Gates power by writing to a `LOCAL_PWR_CFG` register and polling a status register at offset `+0x4` for the PMU's acknowledgement.

**Rockchip power domains** — `drivers/pmdomain/rockchip/pm-domains.c`. Uses a power domain controller peripheral accessed via `regmap`. Subdomain dependencies are declared in Device Tree; the driver calls `pm_genpd_add_subdomain()` based on DT topology.

All three follow the same pattern: allocate `struct generic_pm_domain`, fill `power_on`/`power_off` callbacks, call `pm_genpd_init()`, and register as a DT provider.

## Further reading

### Kernel source

- [include/linux/pm_domain.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pm_domain.h) — `struct generic_pm_domain`, `struct gpd_timing_data`, and the `pm_genpd_*`/`of_genpd_*` API
- [drivers/pmdomain/core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pmdomain/core.c) — genpd core: `pm_genpd_init()`, `genpd_add_subdomain()`, `genpd_dev_pm_attach()`, debugfs summary
- [drivers/pmdomain/governor.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/pmdomain/governor.c) — `simple_qos_governor` and `pm_domain_always_on_gov`
- [drivers/clk/qcom/gdsc.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/clk/qcom/gdsc.c) — Qualcomm GDSC genpd backend: `gdsc_enable()`/`gdsc_disable()`

### Related pages

- [Runtime PM](runtime-pm.md) — usage counting, autosuspend, dev_pm_ops; genpd's runtime_suspend/resume hooks build on this
- [System Suspend](suspend.md) — system-wide sleep; genpd participates in the freeze/suspend sequence
- [Device Tree](../drivers/device-tree.md) — `power-domains` binding and phandle parsing

### LWN articles

- [PM / Domains: Support for generic I/O PM domains](https://lwn.net/Articles/449302/) — Rafael J. Wysocki's original genpd patchset (2011) explaining the shared-power-resource and parent/child domain model this page describes

### External

- [Documentation/driver-api/pm/devices.rst — Device Power Management Domains](https://docs.kernel.org/driver-api/pm/devices.html#device-power-management-domains) — upstream explanation of `dev->pm_domain`, `struct dev_pm_domain`, and why power domain callbacks take precedence over subsystem callbacks
- [Documentation/devicetree/bindings/power/power-domain.yaml](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/devicetree/bindings/power/power-domain.yaml) — DT binding spec for `power-domains` and `#power-domain-cells`
