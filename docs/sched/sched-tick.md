# The Scheduling Tick

> How the kernel drives time-based scheduling: jiffies, HZ, and NOHZ

## The periodic tick

The kernel runs a periodic timer interrupt (the "tick") at a rate of `HZ` times per second. The tick drives:
- Updating `jiffies` (coarse-grained time)
- Updating process CPU time accounting
- Checking if the current task should be preempted (`scheduler_tick`)
- Running expired timers (wheel timers)

```c
/* kernel/time/tick-common.c */
static void tick_handle_periodic(struct clock_event_device *dev)
{
    tick_periodic(cpu);
}

static void tick_periodic(int cpu)
{
    if (tick_do_timer_cpu == cpu) {
        /* Update jiffies on one designated CPU */
        do_timer(1);           /* jiffies++ */
        update_wall_time();    /* update CLOCK_REALTIME */
    }

    /* Per-CPU: account time, check preemption */
    update_process_times(user_mode(get_irq_regs()));
}

void update_process_times(int user_tick)
{
    struct task_struct *p = current;

    /* Account CPU time to current task */
    account_process_tick(p, user_tick);

    /* Run expired timer wheel entries */
    run_local_timers();

    /* Check if task should be preempted */
    scheduler_tick();
}
```

## HZ: the tick rate

`HZ` is a compile-time constant:

```c
/* 250 is the default on most x86 kernels */
/* 100: server (lower overhead)   */
/* 250: desktop (good compromise) */
/* 1000: lowest latency (1ms timer resolution) */

CONFIG_HZ_100  → HZ = 100  (10ms tick)
CONFIG_HZ_250  → HZ = 250  (4ms tick)
CONFIG_HZ_300  → HZ = 300
CONFIG_HZ_1000 → HZ = 1000 (1ms tick)

/* Practical timer resolution with HZ=1000: ~1ms */
/* With NOHZ+hrtimers: sub-millisecond regardless of HZ */
```

```bash
# Check configured HZ
zcat /proc/config.gz | grep "^CONFIG_HZ="
# CONFIG_HZ=250

# Current jiffies
cat /proc/uptime   # seconds since boot = jiffies/HZ
```

## jiffies: coarse-grained time

`jiffies` is a 64-bit counter incremented every tick:

```c
/* include/linux/jiffies.h */
extern unsigned long volatile jiffies;

/* Converting between jiffies and time: */
unsigned long timeout = jiffies + msecs_to_jiffies(100);  /* 100ms */
unsigned long timeout = jiffies + HZ / 10;                 /* 100ms (HZ=1000) */
unsigned long timeout = jiffies + HZ * 2;                  /* 2 seconds */

/* Comparison (handles wraparound): */
if (time_after(jiffies, timeout))
    /* timeout expired */
if (time_before(jiffies, deadline))
    /* deadline not yet reached */

/* jiffies_to_msecs: */
unsigned long elapsed_ms = jiffies_to_msecs(jiffies - start);
```

`jiffies` wraps around after `ULONG_MAX / HZ` seconds (~497 days on 32-bit, irrelevant on 64-bit). The `time_after`/`time_before` macros use subtraction to handle wraparound correctly.

## scheduler_tick: preemption check

```c
/* kernel/sched/core.c */
void scheduler_tick(void)
{
    int cpu = smp_processor_id();
    struct rq *rq = cpu_rq(cpu);
    struct task_struct *curr = rq->curr;

    /* Let the scheduling class update its state */
    curr->sched_class->task_tick(rq, curr, 0);
    /* For CFS: update vruntime, check if current should yield */
    /* For RT: check RR timeslice expiry */

    /* Trigger load balancing every tick */
    trigger_load_balance(rq);

    /* Update scheduler statistics */
    rq->idle_stamp = 0;
}

/* CFS tick: */
static void task_tick_fair(struct rq *rq, struct task_struct *curr, int queued)
{
    struct cfs_rq *cfs_rq;
    struct sched_entity *se = &curr->se;

    for_each_sched_entity(se) {
        cfs_rq = cfs_rq_of(se);
        entity_tick(cfs_rq, se, queued);
    }
}

static void entity_tick(struct cfs_rq *cfs_rq, struct sched_entity *curr, int queued)
{
    /* Update vruntime (CPU time accounting) */
    update_curr(cfs_rq);

    /* Update load average (PELT) */
    update_load_avg(cfs_rq, curr, UPDATE_TG);

    /* Check if the current task should be preempted */
    if (cfs_rq->nr_running > 1)
        check_preempt_tick(cfs_rq, curr);
}

static void check_preempt_tick(struct cfs_rq *cfs_rq, struct sched_entity *curr)
{
    unsigned long ideal_runtime;
    struct sched_entity *se;

    /* How long should this task run? (fair share of CPU) */
    ideal_runtime = sched_slice(cfs_rq, curr);

    /* How long has it actually run? */
    delta_exec = curr->sum_exec_runtime - curr->prev_sum_exec_runtime;

    if (delta_exec > ideal_runtime) {
        /* Task exceeded its timeslice: set TIF_NEED_RESCHED */
        resched_curr(rq_of(cfs_rq));
    }
}
```

## NOHZ idle: stopping the tick when idle

When a CPU is idle, there's no need to fire the tick interrupt. **NOHZ idle** (CONFIG_NO_HZ_IDLE, enabled by default) suppresses the tick when the CPU is idle:

```
Normal (HZ=250):             NOHZ idle:
CPU0 idle: tick every 4ms    CPU0 idle: tick suppressed
                              Next tick: when timer expires or task wakes

Power savings: significant on idle systems
```

```c
/* kernel/time/tick-sched.c */
void tick_nohz_idle_enter(void)
{
    /* Called when CPU enters idle */
    struct tick_sched *ts = this_cpu_ptr(&tick_cpu_sched);

    ts->inidle = 1;
    /* Calculate next wake time from timer wheel */
    /* Program the clock event device for that time */
    /* No more periodic ticks until wake time */
}

void tick_nohz_idle_exit(void)
{
    /* Called when CPU exits idle */
    /* Catch up jiffies for the time slept */
    /* Restore periodic tick */
}
```

## NOHZ full: tickless for running tasks

**NOHZ full** (CONFIG_NO_HZ_FULL) goes further — it suppresses the tick even when a single task is running on a CPU:

```bash
# Boot parameter: make CPUs 1,2,3 fully tickless
GRUB_CMDLINE_LINUX="nohz_full=1-3 rcu_nocbs=1-3"

# Effects on CPUs 1-3:
# - No periodic tick when exactly one task running
# - jiffies updates delegated to CPU 0
# - RCU callbacks offloaded
# - Useful for: HPC, real-time, latency-critical workloads
```

```c
/* tick-sched.c: NOHZ full logic */
static bool can_stop_full_tick(int cpu, struct tick_sched *ts)
{
    /* Only tickless if exactly one task is running */
    if (rq->nr_running > 1)
        return false;

    /* RCU must agree it's OK to go tickless */
    if (!rcu_is_watching())
        return false;

    /* No perf events that need the tick */
    if (perf_event_active(current))
        return false;

    return true;
}
```

NOHZ full CPUs receive a tick "kick" from CPU 0 when:
- Another task is added to the run queue
- RCU needs a quiescent state
- Timers expire

## Tick device and clockevents

The tick is driven by a **clock event device** — a hardware timer that can be programmed to fire at a specific time:

```c
/* kernel/time/clockevents.c */
struct clock_event_device {
    void   (*event_handler)(struct clock_event_device *);
    int    (*set_next_event)(unsigned long evt, struct clock_event_device *);
    int    (*set_next_ktime)(ktime_t expires, struct clock_event_device *);
    ktime_t next_event;
    u64     max_delta_ns;
    u64     min_delta_ns;
    u32     mult;     /* ns conversion */
    u32     shift;
    enum clock_event_state state_use_accessors;
    unsigned int features;
    /* ... */
};

/* Per-CPU: each CPU has its own tick device */
DEFINE_PER_CPU(struct tick_device, tick_cpu_device);
```

On x86:
- BSP (boot CPU): uses TSC or HPET for the tick
- Other CPUs: use the local APIC timer
- All CPUs: can switch to one-shot mode (for NOHZ)

```bash
# See clock event devices
cat /sys/bus/clockevents/devices/*/current_mode
# periodic (HZ mode)
# oneshot   (NOHZ mode)

cat /sys/bus/clockevents/devices/*/name
# lapic (local APIC timer)
# tsc-deadline (TSC with deadline mode — most efficient)
```

## Accounting overhead

```bash
# See scheduler tick statistics
cat /proc/sched_debug | grep -E "\.nr_switches|\.clock|avg_idle"

# Profiling: how much time is spent in scheduler_tick?
perf stat -e cycles:k -C 0 sleep 1 | grep cycles
# Most should be idle (NOHZ_IDLE suppresses ticks)

# Count timer interrupts:
grep "^LOC:" /proc/interrupts  # "Local timer interrupts"
```

## Further reading

- [Preemption Model](preemption.md) — TIF_NEED_RESCHED and preemption contexts
- [CFS](cfs.md) — vruntime, sched_slice, ideal_runtime
- [hrtimers](../time/hrtimers.md) — high-resolution timers that bypass the tick
- [Timers and hrtimers](../interrupts/timers.md) — timer wheel and hrtimer integration
- [Energy-Aware Scheduling](eas.md) — tick and load tracking interaction
- `kernel/time/tick-sched.c` — NOHZ implementation
- `kernel/sched/core.c` — scheduler_tick, check_preempt_tick
