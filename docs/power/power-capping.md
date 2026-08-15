# Power Capping and RAPL

> Intel RAPL, the powercap framework, and constraining CPU power consumption

## What is RAPL?

**Running Average Power Limit (RAPL)** is an Intel hardware feature introduced with Sandy Bridge (2011) that does two things:

1. **Measures** energy consumption of major hardware domains using on-die counters
2. **Limits** sustained power draw by throttling clock frequencies when a domain's rolling average exceeds a configured cap

RAPL is not a software power meter — the counters are built into the package's power management unit and are accurate to roughly 15.3 µJ per tick (the default energy unit, 2⁻¹⁶ J, from `MSR_RAPL_POWER_UNIT`). It is the basis for `perf stat -e power/energy-pkg/`, powertop's package power display, and many data-center power management tools.

## RAPL domains

Each power domain covers a different physical scope:

| Domain | Scope | Available since |
|--------|-------|----------------|
| `package` | Entire CPU socket (cores + uncore + LLC) | Sandy Bridge |
| `core` | CPU cores + L1/L2 caches only | Sandy Bridge |
| `uncore` | GPU (integrated graphics / ring bus) | Sandy Bridge |
| `dram` | DRAM power consumption | Sandy Bridge EP |
| `psys` | Platform-wide (SoC + VR losses) | Skylake |

On a dual-socket server you will see `intel-rapl:0` and `intel-rapl:1` for the two packages, each with child zones for their sub-domains.

## The MSR interface

At the hardware level RAPL is exposed through Model-Specific Registers:

```
MSR_PKG_ENERGY_STATUS   (0x611)  — rolling energy counter, ~15.3 µJ units
MSR_PKG_POWER_LIMIT     (0x610)  — configures limit 1 (sustained) and limit 2 (burst)
MSR_PKG_POWER_INFO      (0x614)  — TDP, min power, max power (read-only)

MSR_PP0_ENERGY_STATUS   (0x639)  — core domain energy
MSR_PP1_ENERGY_STATUS   (0x641)  — uncore domain energy
MSR_DRAM_ENERGY_STATUS  (0x619)  — DRAM domain energy
MSR_PLATFORM_ENERGY_STATUS (0x64d) — psys domain energy (Skylake+)
```

The energy unit (Joules per LSB) is read from `MSR_RAPL_POWER_UNIT (0x606)`, bits [12:8]. The power unit (Watts per LSB) comes from bits [3:0] of the same MSR, typically 1/8 W.

Direct MSR access requires `CAP_SYS_RAWIO` and the `msr` kernel module. The powercap sysfs interface is the preferred path for userspace.

## The powercap framework

`drivers/powercap/` provides a generic abstraction for power-capping hardware. The framework:

- Represents each hardware domain as a **powercap zone** (`struct powercap_zone`)
- Exposes zones as directories under `/sys/class/powercap/`
- Allows drivers for different hardware (Intel RAPL, ARM SCMI) to register zones without duplicating sysfs code

```c
/* include/linux/powercap.h */
struct powercap_zone {
    int                             id;
    char                           *name;
    void                           *control_type_inst;
    const struct powercap_zone_ops *ops;
    struct device                   dev;
    int                             const_id_cnt;
    struct idr                      idr;
    struct idr                     *parent_idr;
    /* ... */
};

struct powercap_zone_ops {
    int (*get_max_energy_range_uj)(struct powercap_zone *, u64 *);
    int (*get_energy_uj)(struct powercap_zone *, u64 *);
    int (*reset_energy_uj)(struct powercap_zone *);
    int (*get_max_power_range_uw)(struct powercap_zone *, u64 *);
    int (*get_power_uw)(struct powercap_zone *, u64 *);
    int (*set_enable)(struct powercap_zone *, bool);
    int (*get_enable)(struct powercap_zone *, bool *);
    int (*release)(struct powercap_zone *);
};
```

A control type (e.g., `intel-rapl`) is registered first with `powercap_register_control_type()`, then each RAPL domain is registered as a zone with `powercap_register_zone()`. Child zones (core, dram, uncore) are registered with the package zone as parent.

## The intel_rapl driver

`drivers/powercap/intel_rapl_common.c` is the driver that bridges RAPL MSRs to the powercap framework. It:

1. Enumerates RAPL domains by probing MSRs for each CPU package
2. Reads the energy/power unit from `MSR_RAPL_POWER_UNIT`
3. Registers each domain as a `powercap_zone`
4. Implements `get_energy_uj` by reading the appropriate energy MSR and scaling

Two interface drivers load on top of the common code:

- `intel_rapl_msr.c` — accesses RAPL via MSRs directly (bare metal, the traditional path since Sandy Bridge)
- `intel_rapl_tpmi.c` — accesses RAPL via TPMI (Topology Aware Register and PM Capsule Interface), a PCIe-VSEC-exposed MMIO region that avoids the per-CPU scheduling MSR access requires; used on newer Xeon platforms with PMT/TPMI hardware

On systems with the driver loaded, `lsmod | grep rapl` should show `intel_rapl_common` plus either `intel_rapl_msr` or `intel_rapl_tpmi` depending on the interface, and (on some platforms) `rapl` for the perf event backend.

## sysfs interface

```bash
# List all powercap zones
ls /sys/class/powercap/
# intel-rapl  intel-rapl:0  intel-rapl:0:0  intel-rapl:0:1  intel-rapl:0:2

# Zone names
cat /sys/class/powercap/intel-rapl:0/name          # "package-0"
cat /sys/class/powercap/intel-rapl:0:0/name        # "core"
cat /sys/class/powercap/intel-rapl:0:1/name        # "uncore" or "dram"

# Read current accumulated energy (µJ; wrap-around counter)
cat /sys/class/powercap/intel-rapl:0/energy_uj
# 4882348230

# Compute power: read energy_uj twice, 1 second apart
E1=$(cat /sys/class/powercap/intel-rapl:0/energy_uj)
sleep 1
E2=$(cat /sys/class/powercap/intel-rapl:0/energy_uj)
echo "Package power: $(( (E2 - E1) / 1000000 )) W"

# Read current long-term power limit (µW)
cat /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw
# 45000000  (= 45 W)

# Set a 35 W long-term power limit on package 0
echo 35000000 > /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw

# Enable the zone (may already be enabled) -- enabled is a zone-level
# attribute, not per-constraint; there is no constraint_0_enabled file
echo 1 > /sys/class/powercap/intel-rapl:0/enabled

# Read the time window over which the limit is averaged
cat /sys/class/powercap/intel-rapl:0/constraint_0_time_window_us
# 999424  (~1 second)
```

## Constraint 0 vs Constraint 1

RAPL supports two independent power constraints per zone:

| Constraint | Name | Typical time window | Behavior |
|-----------|------|---------------------|----------|
| `constraint_0` | Long-term (PL1) | 1 s – 28 s | Sustained cap; hardware throttles if rolling average exceeds this |
| `constraint_1` | Short-term (PL2) | 1 ms – 7 ms | Burst cap; allows exceeding PL1 briefly for responsiveness |

PL2 is always ≥ PL1. A typical OEM configuration: PL1 = 15 W (thermal envelope), PL2 = 25 W (burst for a few milliseconds, per the `constraint_1` time window above). After the burst window expires, the processor clamps to PL1.

```bash
# Short-term (burst) limit
cat /sys/class/powercap/intel-rapl:0/constraint_1_name
# "short_term"
cat /sys/class/powercap/intel-rapl:0/constraint_1_power_limit_uw
# 64000000  (64 W burst)
cat /sys/class/powercap/intel-rapl:0/constraint_1_time_window_us
# 2440       (~2.4 ms)
```

## Measuring energy with perf

The `perf` tool can read RAPL energy counters via the `power` PMU, which uses the same MSRs under the hood but integrates with the perf event infrastructure:

```bash
# Measure package energy for a workload
perf stat -e power/energy-pkg/ -- ./my_workload
#  Performance counter stats for './my_workload':
#        24.35 Joules power/energy-pkg/
#       3.152370284 seconds time elapsed

# All available RAPL events
perf list | grep power
#  power/energy-cores/     [Kernel PMU event]
#  power/energy-gpu/       [Kernel PMU event]
#  power/energy-pkg/       [Kernel PMU event]
#  power/energy-ram/       [Kernel PMU event]
```

The perf backend is in `arch/x86/events/rapl.c` and registers a PMU named `power` that maps `energy-pkg` to `MSR_PKG_ENERGY_STATUS`, `energy-cores` to `MSR_PP0_ENERGY_STATUS`, and so on.

## ARM equivalent: SCMI power capping

On ARM platforms, SCMI (System Control and Management Interface) provides a comparable capability via the platform firmware. The driver `drivers/powercap/arm_scmi_powercap.c` registers zones from the dedicated SCMI **Powercap** protocol (`SCMI_PROTOCOL_POWERCAP`, protocol ID `0x18`) as powercap zones, so the same `/sys/class/powercap/` interface works on ARM servers (e.g., Ampere Altra). This is a distinct SCMI protocol from **Power domain management** (`SCMI_PROTOCOL_POWER`, protocol ID `0x11`), which is what backs Linux's generic power-domain (genpd) framework, not powercap.

```bash
# On an ARM server with SCMI powercap
ls /sys/class/powercap/
# arm-scmi  arm-scmi:0  ...
cat /sys/class/powercap/arm-scmi:0/name
# "package_0"
```

The SCMI protocol (defined in Arm DEN0056) runs over shared memory or mailbox between Linux and the SCP (System Control Processor). SCMI message type `POWERCAP_CAP_GET` / `POWERCAP_CAP_SET` map directly to the powercap zone ops.

## Interaction with thermal management

RAPL power limits and the thermal framework are complementary, not overlapping:

```
Temperature-based:  Thermal zone → trip point → cpufreq cooling → frequency drop
Power-based:        RAPL PL1/PL2 → hardware throttles clocks directly

RAPL acts faster (hardware decision, microsecond granularity).
Thermal acts on sustained temperature (software, second granularity).
PROCHOT (thermal limit from temperature sensor) overrides both.
```

Setting a RAPL limit lower than TDP controls steady-state power without relying on temperature sensors. This is useful in power-capped environments (data centers with per-rack power limits) where thermal headroom is not the constraint.

## Observability

```bash
# turbostat shows per-package RAPL data continuously
sudo turbostat --show PkgWatt,CorWatt,RAMWatt --interval 1

# Watch energy counters directly
watch -n 1 'for z in /sys/class/powercap/intel-rapl:*/; do
    echo -n "$(cat $z/name): $(cat $z/energy_uj) µJ  "; done; echo'

# Check if a constraint is currently active/throttling
# (no direct sysfs node; infer from cpu frequency drop or perf counters)
perf stat -e cpu-cycles,ref-cycles -- sleep 1
# If ref-cycles >> cpu-cycles, the CPU is being throttled
```

## Further reading

### Kernel source

- [include/linux/powercap.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/powercap.h) — `struct powercap_zone`, `struct powercap_zone_ops`, and the control-type/zone registration API
- [drivers/powercap/intel_rapl_common.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/powercap/intel_rapl_common.c) — shared RAPL domain/constraint logic used by both interface drivers
- [drivers/powercap/intel_rapl_msr.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/powercap/intel_rapl_msr.c) — MSR-based RAPL interface driver
- [arch/x86/include/asm/msr-index.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/msr-index.h) — `MSR_RAPL_POWER_UNIT`, `MSR_PKG_ENERGY_STATUS`, and the other MSR offsets used on this page
- [drivers/powercap/arm_scmi_powercap.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/powercap/arm_scmi_powercap.c) — ARM SCMI powercap driver, registering SCMI power domains as powercap zones
- [arch/x86/events/rapl.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/events/rapl.c) — the `power` PMU backend that exposes RAPL counters to `perf stat -e power/energy-*/`

### Man pages

- [perf-stat(1)](https://man7.org/linux/man-pages/man1/perf-stat.1.html) — `-e` event-selection syntax used to read RAPL energy counters through the `power` PMU

### Related pages

- [cpufreq and P-states](cpufreq.md) — frequency scaling; a separate control path from RAPL's own hardware throttling
- [Thermal Management](thermal.md) — temperature-based throttling; complements RAPL's power-based limits
- [Power Management War Stories](war-stories.md) — a RAPL DRAM-domain power-limit incident (composite of real failure patterns)

### LWN articles

- [Power Capping Framework](https://lwn.net/Articles/562015/) — Srinivas Pandruvada's original RFC patch series (2013) that introduced the generic `drivers/powercap/` sysfs framework RAPL registers against

### External

- [Documentation/power/powercap/powercap.rst](https://docs.kernel.org/power/powercap/powercap.html) — upstream powercap framework documentation: terminology, sysfs tree layout, control types and zones
- Intel 64 and IA-32 Architectures Software Developer's Manual, Volume 3B, Chapter 15 (Power and Thermal Management) — RAPL MSR definitions
