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
/* include/linux/thermal.h */

struct thermal_zone_device {
    int                 id;
    char                type[THERMAL_NAME_LENGTH];
    struct device       device;
    struct thermal_attr temp_attr;
    struct thermal_attr mode_attr;

    int                 temperature;        /* current temp in millidegrees */
    int                 last_temperature;
    int                 emul_temperature;   /* for testing */
    int                 passive;            /* passive cooling active? */
    int                 forced_passive;

    struct thermal_zone_device_ops  *ops;   /* .get_temp, .set_trips */
    struct thermal_zone_params      *tzp;   /* governor params */
    struct thermal_governor         *governor;

    struct list_head    thermal_instances;  /* connected cooling devices */
    struct idr          idr;               /* trip point IDs */
    int                 num_trips;
    /* ... */
};

/* Trip point types: */
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
    struct my_sensor *sensor = tzd->devdata;
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

struct thermal_zone_device *tzd = thermal_zone_device_register(
    "my_sensor",           /* type string */
    ARRAY_SIZE(trips),     /* number of trip points */
    0,                     /* mask of writable trips */
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
    int     id;
    char    type[THERMAL_NAME_LENGTH];
    struct  device device;
    struct  thermal_cooling_device_ops *ops;
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
cat /sys/class/thermal/cooling_device0/type    # "Processor" or "cpufreq"
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
/* k_po, k_pu, k_d: PID controller gains                  */
/* Estimate: (current_temp - control_temp) → power_budget */
/* → allocate proportionally to each cooling device       */
```

```bash
# Tune power_allocator governor:
echo power_allocator > /sys/class/thermal/thermal_zone0/policy
echo 3000 > /sys/class/thermal/thermal_zone0/sustainable_power  # 3W budget
echo 100  > /sys/class/thermal/thermal_zone0/k_po  # proportional gain
echo 100  > /sys/class/thermal/thermal_zone0/k_pu
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

# ACPI trip points come from ACPI _PSV (passive), _CRT (critical), _HOT:
acpidump -n DSDT | grep -A 20 "ThermalZone"
```

## Fan control

```bash
# Fan cooling devices:
cat /sys/class/thermal/cooling_device*/type | grep -i fan
# Fan

# Manual fan control (bypass thermal framework):
# (varies by platform; common methods:)

# Dell laptops (i8k):
echo 2 > /proc/i8k  # set fan level

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

# Kernel thermal tracepoints:
echo 1 > /sys/kernel/debug/tracing/events/thermal/enable
cat /sys/kernel/debug/tracing/trace_pipe
# thermal_temperature: thermal_zone=x86_pkg_temp id=0 temp=45000 ...
# thermal_zone_trip: thermal_zone=x86_pkg_temp trip=0 temp=80000 type=passive

# BPF trace thermal throttling:
bpftrace -e '
tracepoint:thermal:thermal_zone_trip
{
    printf("TRIP: zone=%s, trip=%d, temp=%d°C\n",
           str(args->thermal_zone), args->trip,
           args->temp / 1000);
}'

# Check if CPU is thermally throttled (PROCHOT):
grep -r "throttle\|prochot" /sys/devices/system/cpu/cpu*/thermal_throttle/
cat /sys/devices/system/cpu/cpu0/thermal_throttle/core_throttle_count

# MSR-based throttling on Intel:
rdmsr 0x1b1   # IA32_THERM_STATUS: bit 4 = prochot
# bit 4 set → CPU is/was thermally throttled
```

## ARM thermal: SCMI and TF-A

On ARM SoCs, temperature management often involves the firmware:

```bash
# SCMI thermal (System Control and Management Interface):
cat /sys/class/thermal/thermal_zone*/type | grep scmi
# arm-scmi

# TF-A (Trusted Firmware-A) handles critical shutdown;
# Linux gets temperature via SCMI protocol to secure world
```

## Further reading

- [cpufreq and P-states](cpufreq.md) — CPU frequency scaling (thermal cooling device)
- [cpuidle](cpuidle.md) — C-states reduce power to prevent thermal issues
- [Runtime PM](runtime-pm.md) — device power management
- [Device Tree](../drivers/device-tree.md) — thermal zones defined in DTS on ARM
- `drivers/thermal/` — thermal framework
- `Documentation/driver-api/thermal/` — thermal framework documentation
