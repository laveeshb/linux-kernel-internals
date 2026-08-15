# Thermal Management: Thermal Zones and Cooling

> Linux thermal framework, trip points, cooling devices, and thermal governors

## Overview

Modern SoCs and CPUs generate heat. Without thermal management, they would throttle or shut down unexpectedly. The Linux thermal framework provides a structured way to:
1. **Monitor** temperatures via thermal zones
2. **Define** thermal policies via trip points and governors
3. **Enforce** cooling via cooling devices (CPU frequency scaling, fan control)

```
Hardware sensor → thermal zone → governor → cooling device
     (NTC, PCH, CPU, GPU)          |           (cpufreq, fan, GPU)
                                   ↓
                          trip points: warning/critical/throttle
```

## Thermal zones

A **thermal zone** represents a sensor and its associated policy:

```bash
# List all thermal zones:
ls /sys/class/thermal/
# thermal_zone0  thermal_zone1  thermal_zone2  ...  cooling_device0  ...

# Check a zone:
cat /sys/class/thermal/thermal_zone0/type          # "x86_pkg_temp"
cat /sys/class/thermal/thermal_zone0/temp          # current temp in millidegrees
# 45000 = 45°C
cat /sys/class/thermal/thermal_zone0/mode          # "enabled" or "disabled"
cat /sys/class/thermal/thermal_zone0/policy        # "step_wise" etc.

# List trip points:
for trip in /sys/class/thermal/thermal_zone0/trip_point_*_temp; do
    type=$(echo $trip | sed 's/_temp/_type/')
    echo "$(cat $type): $(cat $trip)m°C"
done
# passive: 95000m°C   ← throttle at 95°C
# critical: 105000m°C ← emergency shutdown at 105°C
```

### Kernel structures

```c
/* drivers/thermal/thermal_core.h — struct thermal_zone_device is private to
 * the thermal subsystem, not exposed via include/linux/thermal.h; drivers
 * only ever see an opaque pointer returned by the registration functions. */

struct thermal_zone_device {
    int                 id;
    char                type[THERMAL_NAME_LENGTH];
    struct device       device;
    enum thermal_device_mode mode;
    void                *devdata;
    int                 num_trips;

    int                 temperature;        /* current temp in millidegrees */
    int                 last_temperature;
    int                 emul_temperature;   /* for testing */
    int                 passive;            /* passive cooling active? */

    struct thermal_zone_device_ops  ops;    /* .get_temp, .set_trips */
    struct thermal_zone_params      *tzp;   /* governor params */
    struct thermal_governor         *governor;

    struct list_head    trips_high;         /* trips above current temp */
    struct list_head    trips_reached;      /* trips currently crossed */
    struct mutex        lock;
    struct thermal_trip_desc trips[];       /* flexible array, one per trip */
    /* ... */
};

/* Trip point types: include/uapi/linux/thermal.h */
enum thermal_trip_type {
    THERMAL_TRIP_ACTIVE = 0,    /* activate cooling device (fan) */
    THERMAL_TRIP_PASSIVE,       /* reduce performance (cpufreq) */
    THERMAL_TRIP_HOT,           /* driver-defined action */
    THERMAL_TRIP_CRITICAL,      /* emergency shutdown */
};
```

## Registering a thermal zone (driver)

```c
/* Driver: register a temperature sensor as a thermal zone */
static int my_get_temp(struct thermal_zone_device *tzd, int *temp)
{
    /* struct thermal_zone_device is private to the thermal core (see
     * above), so drivers can't dereference tzd->devdata directly —
     * use the accessor exported by include/linux/thermal.h instead. */
    struct my_sensor *sensor = thermal_zone_device_priv(tzd);
    *temp = read_sensor_millidegrees(sensor);
    return 0;
}

static struct thermal_zone_device_ops my_tz_ops = {
    .get_temp = my_get_temp,
};

/* At probe time: */
struct thermal_trip trips[] = {
    { .temperature = 80000, .type = THERMAL_TRIP_PASSIVE },    /* 80°C */
    { .temperature = 100000, .type = THERMAL_TRIP_CRITICAL },  /* 100°C */
};

struct thermal_zone_device *tzd = thermal_zone_device_register_with_trips(
    "my_sensor",           /* type string */
    trips,                 /* array of trip points */
    ARRAY_SIZE(trips),     /* number of trip points */
    sensor_data,           /* driver private data */
    &my_tz_ops,
    NULL,                  /* thermal zone params */
    1000,                  /* passive_delay ms */
    5000                   /* polling_delay ms */
);
thermal_zone_device_enable(tzd);
```

## Cooling devices

```c
/* A cooling device can reduce power: e.g., CPU frequency */
struct thermal_cooling_device {
    int         id;
    const char  *type;
    struct      device device;
    struct      thermal_cooling_device_ops *ops;
    /* ... */
};

struct thermal_cooling_device_ops {
    int (*get_max_state)(struct thermal_cooling_device *, unsigned long *);
    int (*get_cur_state)(struct thermal_cooling_device *, unsigned long *);
    int (*set_cur_state)(struct thermal_cooling_device *, unsigned long);
};

/* CPU frequency scaling cooling device (cpufreq_cooling): */
/* state 0 = max frequency, state N = minimum frequency */
struct thermal_cooling_device *cdev =
    cpufreq_cooling_register(cpu_policy);
/* This is how cpufreq thermal throttling works */
```

```bash
# View cooling devices:
ls /sys/class/thermal/cooling_device*/
cat /sys/class/thermal/cooling_device0/type    # "Processor" or "cpufreq-cpu0"
cat /sys/class/thermal/cooling_device0/max_state  # e.g., 3 (4 levels)
cat /sys/class/thermal/cooling_device0/cur_state  # current level (0=off)
```

## Thermal governors

The governor decides **when** to activate cooling and **how much**:

### step_wise (default on many platforms)

Raises cooling level by 1 when temperature exceeds a trip point, lowers by 1 when below:

```
temp rising:  trip reached → cooling_state++
temp falling: temp < (trip - hysteresis) → cooling_state--
```

### power_allocator (IPA — Intelligent Power Allocation)

A PID controller that distributes a power budget across cooling devices:

```c
/* drivers/thermal/gov_power_allocator.c */
/* Parameters (tunable via /sys/class/thermal/thermal_zone*/
/*                             /sustainable_power etc.):  */
/* sustainable_power: maximum sustainable power (mW)      */
/* k_po, k_pu, k_i, k_d: PID controller gains — proportional */
/* (overshoot/undershoot), integral, and derivative terms.   */
/* Stored as fixed-point (mul_frac()/int_to_frac() in the    */
/* driver), not plain integers, even though the sysfs files  */
/* below show/accept decimal integers.                       */
/* Estimate: (current_temp - control_temp) → power_budget */
/* → allocate proportionally to each cooling device       */
```

```bash
# Tune power_allocator governor:
echo power_allocator > /sys/class/thermal/thermal_zone0/policy
echo 3000 > /sys/class/thermal/thermal_zone0/sustainable_power  # 3W budget
echo 100  > /sys/class/thermal/thermal_zone0/k_po  # proportional gain (overshoot)
echo 100  > /sys/class/thermal/thermal_zone0/k_pu  # proportional gain (undershoot)
echo 10   > /sys/class/thermal/thermal_zone0/k_i   # integral gain
echo 0    > /sys/class/thermal/thermal_zone0/k_d   # derivative gain
```

### user_space

Delegates decisions to a userspace daemon (e.g., thermald):

```bash
echo user_space > /sys/class/thermal/thermal_zone0/policy
# thermald or thermal daemon reads temperature and sets:
echo 1 > /sys/class/thermal/cooling_device0/cur_state
```

## ACPI thermal zones

On x86, ACPI defines thermal zones in DSDT/SSDT:

```bash
# ACPI thermal zones (separate from Linux thermal framework initially):
cat /sys/class/thermal/thermal_zone*/type | grep -i acpi
# acpitz

# ACPI trip points come from ACPI _PSV (passive), _CRT (critical), _HOT.
# ThermalZone is an ASL keyword, not present in the raw AML binary, so it
# won't show up in a raw dump — disassemble first:
acpidump -n DSDT -o dsdt.dat
iasl -d dsdt.dat            # produces dsdt.dsl (ASL source)
grep -A 20 "ThermalZone" dsdt.dsl
```

## Fan control

```bash
# Fan cooling devices:
cat /sys/class/thermal/cooling_device*/type | grep -i fan
# Fan

# Manual fan control (bypass thermal framework):
# (varies by platform; common methods:)

# Dell laptops (i8k): /proc/i8k is read-only status output (drivers/hwmon/dell-smm-hwmon.c
# registers a .proc_ioctl handler, but no .proc_write); setting the fan level
# requires the I8K_SET_FAN ioctl (e.g. via the `i8kutils`/`i8kfan` userspace tools),
# not a plain sysfs-style write.

# ACPI fans via hwmon:
cat /sys/class/hwmon/hwmon*/name
cat /sys/class/hwmon/hwmon0/fan1_input  # RPM
echo 200 > /sys/class/hwmon/hwmon0/pwm1  # 0-255 speed

# Check fan is thermal-controlled:
cat /sys/class/hwmon/hwmon0/pwm1_enable
# 0 = full speed, 1 = manual, 2 = auto (thermal)
echo 2 > /sys/class/hwmon/hwmon0/pwm1_enable  # auto mode
```

## Observability and debugging

```bash
# Watch thermal zones in real time:
watch -n 1 'for z in /sys/class/thermal/thermal_zone*/; do
    echo -n "$(cat $z/type): $(cat $z/temp)m°C  "; done; echo'

# Kernel thermal tracepoints (drivers/thermal/thermal_trace.h):
echo 1 > /sys/kernel/debug/tracing/events/thermal/enable
cat /sys/kernel/debug/tracing/trace_pipe
# thermal_temperature: thermal_zone=x86_pkg_temp id=0 temp_prev=44000 temp=45000
# thermal_zone_trip: thermal_zone=x86_pkg_temp id=0 trip=0 trip_type=passive
# (thermal_zone_trip carries the trip index and type, not a temperature —
#  read the current temp from the paired thermal_temperature event or /sys)

# BPF trace thermal throttling:
bpftrace -e '
tracepoint:thermal:thermal_zone_trip
{
    printf("TRIP: zone=%s, id=%d, trip=%d, type=%d\n",
           str(args->thermal_zone), args->id, args->trip,
           args->trip_type);
}'

# Check if CPU is thermally throttled (PROCHOT): the info lives in the
# *names* of numeric counter files under thermal_throttle/, not in their
# contents, so grepping for a string won't match — cat the counters instead:
cat /sys/devices/system/cpu/cpu0/thermal_throttle/core_throttle_count
cat /sys/devices/system/cpu/cpu0/thermal_throttle/core_power_limit_count
cat /sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count

# MSR-based throttling on Intel (IA32_THERM_STATUS bits, per SDM Vol 3B §15.7):
rdmsr -p0 0x19c   # IA32_THERM_STATUS (per-core)
# bit 0: Thermal Status — currently being throttled due to temperature
# bit 1: Thermal Status Log — sticky "has this happened since last clear" flag
# bit 2: PROCHOT#/FORCEPR Event — currently throttled by an external PROCHOT# assertion
# bit 3: PROCHOT#/FORCEPR Log — sticky version of bit 2
# (bit 0 = current thermal-status throttling; bit 2 = current PROCHOT# throttling — distinct events)

# Package-wide equivalent:
rdmsr -p0 0x1b1   # IA32_PACKAGE_THERM_STATUS: same bit layout, package-wide
```

## ARM thermal: SCMI and TF-A

On ARM SoCs, temperature management often involves the firmware:

```bash
# SCMI thermal (System Control and Management Interface):
# DT-described zones get their sysfs "type" from the thermal-zones node
# name itself (thermal_zone_device_register_with_trips(np->name, ...) in
# drivers/thermal/thermal_of.c) — an SCMI-backed zone's sensor comes from
# a "thermal-sensors = <&scmi_sensors N>" reference, not a fixed type string.
cat /sys/class/thermal/thermal_zone*/type

# TF-A (Trusted Firmware-A) handles critical shutdown;
# Linux gets temperature via SCMI protocol to secure world
```

## Further reading

### Kernel source

- [include/linux/thermal.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/thermal.h) — `struct thermal_trip`, `struct thermal_zone_device_ops`, and `thermal_zone_device_register_with_trips()` — the actual registration API (the older `thermal_zone_device_register()` no longer exists)
- [drivers/thermal/thermal_core.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/thermal/thermal_core.h) — the real, subsystem-private `struct thermal_zone_device` layout (it is not in `include/linux/thermal.h`; drivers only ever hold an opaque pointer)
- [drivers/thermal/gov_step_wise.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/thermal/gov_step_wise.c) — `get_target_state()`, the `cur_state ± 1` throttling logic behind `step_wise`
- [drivers/thermal/gov_power_allocator.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/thermal/gov_power_allocator.c) — the PID controller (`k_po`, `k_pu`, `k_d`, `sustainable_power`) behind `power_allocator`
- [include/linux/cpu_cooling.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/cpu_cooling.h) — `cpufreq_cooling_register()`, the cpufreq cooling device constructor
- [drivers/thermal/thermal_trace.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/thermal/thermal_trace.h) — the `thermal_temperature` and `thermal_zone_trip` tracepoint field definitions
- [arch/x86/include/asm/msr-index.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/msr-index.h) — `MSR_IA32_THERM_STATUS` (0x19c, per-core) vs `MSR_IA32_PACKAGE_THERM_STATUS` (0x1b1), both with PROCHOT at bit 0

### Related pages

- [cpufreq and P-states](cpufreq.md) — CPU frequency scaling (thermal cooling device)
- [cpuidle](cpuidle.md) — C-states reduce power to prevent thermal issues
- [Runtime PM](runtime-pm.md) — device power management
- [Device Tree](../drivers/device-tree.md) — thermal zones defined in DTS on ARM

### LWN articles

- [The power allocator thermal governor](https://lwn.net/Articles/602517/) (June 17, 2014) — the PID-controller design and multi-actor power budgeting behind `power_allocator`/IPA

### External

- [Generic Thermal Sysfs driver How To](https://docs.kernel.org/driver-api/thermal/sysfs-api.html) — the thermal zone and cooling device registration API and full sysfs ABI (trip points, `policy`, `mode`)
- [Power allocator governor tunables](https://docs.kernel.org/driver-api/thermal/power_allocator.html) — what `k_po`, `k_pu`, `k_d`, and `sustainable_power` actually control
