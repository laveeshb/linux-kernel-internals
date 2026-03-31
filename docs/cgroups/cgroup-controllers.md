# Cgroup v2 Resource Controllers

> Controlling CPU, memory, I/O, and process count

## cpu controller

Controls CPU bandwidth allocation.

### Interface files

```bash
# CPU time weight (relative, default 100, range 1–10000)
cat /sys/fs/cgroup/myapp/cpu.weight
echo 200 > /sys/fs/cgroup/myapp/cpu.weight  # 2x normal priority

# CPU bandwidth quota: <quota_us> <period_us>
# "200000 1000000" = 20% of one CPU
# "max 1000000"    = unlimited
cat /sys/fs/cgroup/myapp/cpu.max
echo "200000 1000000" > /sys/fs/cgroup/myapp/cpu.max

# Per-CPU burst: allow exceeding quota temporarily (single value in µs)
echo "100000" > /sys/fs/cgroup/myapp/cpu.max.burst

# CPU stats
cat /sys/fs/cgroup/myapp/cpu.stat
# usage_usec 1234567        ← total CPU time used (µs)
# user_usec 987654
# system_usec 246913
# nr_periods 1234           ← number of periods elapsed
# nr_throttled 56           ← times throttled
# throttled_usec 12345      ← total throttled time
```

### How cpu.max works internally

```c
/* kernel/sched/core.c: scheduler checks bandwidth */
struct cfs_bandwidth {
    ktime_t         period;       /* quota refill period */
    u64             quota;        /* quota per period (ns) */
    u64             burst;        /* allowed burst above quota */
    u64             runtime;      /* remaining runtime this period */
    u64             runtime_expires;

    short           idle;         /* no tasks waiting */
    short           period_active;
    struct hrtimer  period_timer;  /* refills runtime each period */
    struct hrtimer  slack_timer;   /* returns unused runtime */

    struct list_head throttled_cfs_rq; /* rqs that hit zero runtime */
    int             throttled;
    int             nr_periods;
    int             nr_throttled;
    int             nr_burst;
    u64             burst_time;
    u64             throttled_time;
};
```

When a cfs_rq runs out of quota, it's added to `throttled_cfs_rq` and pulled off the runqueue until the period timer fires to refill `runtime`.

### cpu.weight and EEVDF

`cpu.weight` maps to the EEVDF scheduler's `se.weight`. A process with weight 200 gets twice the CPU share of a weight-100 process when both are runnable.

```c
/* Conversion: cpu.weight → scheduler weight */
static u32 sched_weight_from_cgroup(unsigned long cgroup_weight)
{
    /* cgroup uses 1–10000, scheduler uses 1–1048576 */
    return scale_load_down(cgroup_weight *
                           (SCHED_WEIGHT_SCALE / CGROUP_WEIGHT_DFL));
}
```

## memory controller

Controls memory usage. The most complex controller due to accounting overhead.

### Interface files

```bash
# Hard memory limit (OOM kill when exceeded)
echo "512M" > /sys/fs/cgroup/myapp/memory.max

# Soft limit (hint for memory reclaim pressure)
echo "400M" > /sys/fs/cgroup/myapp/memory.high

# OOM notification: send SIGKILL vs return ENOMEM
# By default, cgroup OOM kills the process that triggered it

# Swap limit (swap usage only; not combined with memory)
echo "1G" > /sys/fs/cgroup/myapp/memory.swap.max

# Current usage
cat /sys/fs/cgroup/myapp/memory.current    # bytes used
cat /sys/fs/cgroup/myapp/memory.peak       # historical peak

# Detailed stats (see mm/memory-stat.md for field descriptions)
cat /sys/fs/cgroup/myapp/memory.stat

# OOM events
cat /sys/fs/cgroup/myapp/memory.events
# low 0
# high 12          ← times memory.high was exceeded
# max 0            ← times memory.max was exceeded (with retry)
# oom 2            ← OOM kills triggered
# oom_kill 3       ← processes killed by OOM
# oom_group_kill 0
```

### memory.high: the reclaim throttle

`memory.high` is a soft limit that triggers reclaim instead of killing:

```c
/* mm/memcontrol.c: mem_cgroup_handle_over_high() */
/* Called after each page allocation if usage > memory.high */
void mem_cgroup_handle_over_high(gfp_t gfp_mask)
{
    unsigned long penalty_jiffies;
    unsigned long overage;

    overage = mem_find_max_overage(current->nsproxy->cgroup_ns);
    if (!overage)
        return;

    /* Throttle: sleep proportional to how much we're over high */
    penalty_jiffies = calculate_high_delay(memcg, nr_pages, overage);
    schedule_timeout_killable(penalty_jiffies);

    /* Also try to reclaim */
    mem_cgroup_reclaim(memcg, gfp_mask, 0);
}
```

### Page accounting

Each page is charged to one `mem_cgroup` via `page_counter`:

```c
/* include/linux/page_counter.h */
struct page_counter {
    atomic_long_t   usage;       /* current usage in pages */
    unsigned long   min;         /* memory.min (protection) */
    unsigned long   low;         /* memory.low (protection) */
    unsigned long   high;        /* memory.high (soft limit) */
    unsigned long   max;         /* memory.max (hard limit) */
    struct page_counter *parent; /* parent in cgroup hierarchy */
    unsigned long   watermark;   /* peak usage */
    unsigned long   failcnt;     /* count of max hits */
};
```

When a page is allocated:
```c
mem_cgroup_charge(page, mm, gfp)
  → get_mem_cgroup_from_mm(mm)      /* find which memcg this mm belongs to */
  → charge_memcg(memcg, nr_pages)
      → page_counter_try_charge(&memcg->memory, nr_pages, &counter)
      → if over max: try to reclaim → if still over: OOM
```

### memory.min and memory.low: protection

```bash
# Reserve at least 256MB for this cgroup (never reclaim below this)
echo "256M" > /sys/fs/cgroup/myapp/memory.min

# Try to keep at least 256MB (reclaim this last, under global pressure)
echo "256M" > /sys/fs/cgroup/myapp/memory.low
```

## io controller

Controls block I/O bandwidth and IOPS using BFQ or mq-deadline scheduler integration.

### Interface files

```bash
# Relative weight for I/O scheduler (default 100, range 1–10000)
echo "8:0 200" > /sys/fs/cgroup/myapp/io.weight  # major:minor weight

# Absolute limits: <major>:<minor> rbps=N wbps=N riops=N wiops=N
echo "8:0 rbps=10485760 wbps=5242880" > /sys/fs/cgroup/myapp/io.max
# 10MB/s read, 5MB/s write on device 8:0

# I/O stats per device
cat /sys/fs/cgroup/myapp/io.stat
# 8:0 rbytes=1048576 wbytes=524288 rios=128 wios=64 dbytes=0 dios=0

# I/O pressure (PSI)
cat /sys/fs/cgroup/myapp/io.pressure
# some avg10=0.00 avg60=0.00 avg300=0.00 total=0
# full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

### How io.max works

The io controller uses the block layer's throttle path:

```c
/* block/blk-cgroup.c: blkcg_policy_ops for throttle */
struct blkcg_policy blkcg_policy_throttl = {
    .pd_alloc_fn  = tg_pd_alloc,
    .pd_init_fn   = tg_pd_init,
    .pd_free_fn   = tg_pd_free,
    /* ... */
};

/* When a bio is submitted: */
blk_throtl_bio(bio)
  → find tg (throtl_grp) for current task's blkcg
  → check against rbps/wbps/riops/wiops limits
  → if over limit: queue bio in tg, schedule timer to dispatch later
```

## pids controller

Limits the total number of processes and threads.

### Interface files

```bash
# Limit to 100 processes/threads total
echo 100 > /sys/fs/cgroup/myapp/pids.max

# Current count
cat /sys/fs/cgroup/myapp/pids.current   # current PIDs

# Events
cat /sys/fs/cgroup/myapp/pids.events
# max 3  ← times fork() was rejected due to pids.max
```

### How pids.max is enforced

```c
/* kernel/fork.c: copy_process() */
static struct task_struct *copy_process(...)
{
    /* ... */
    retval = cgroup_can_fork(p, args);
    /* pids_can_fork() checks: */
    if (atomic64_read(&pids_cgrp->counter) >= pids_max)
        return -EAGAIN;  /* fork() returns EAGAIN */
    /* ... */
}
```

## cpuset controller

Pins processes to specific CPUs and NUMA nodes:

```bash
# Allow only CPUs 0-3
echo "0-3" > /sys/fs/cgroup/myapp/cpuset.cpus

# Require memory from NUMA node 0 only
echo "0" > /sys/fs/cgroup/myapp/cpuset.mems

# Exclusive: no other cgroup uses these CPUs
echo 1 > /sys/fs/cgroup/myapp/cpuset.cpus.exclusive
```

## Monitoring cgroup resource usage

```bash
# CPU pressure (PSI — Pressure Stall Information)
cat /sys/fs/cgroup/myapp/cpu.pressure
# some avg10=1.23 avg60=0.45 avg300=0.12 total=12345678
# "some" = at least one task stalled
# "full" = all tasks stalled (not shown for CPU)

# Memory pressure
cat /sys/fs/cgroup/myapp/memory.pressure

# Watch cgroup stats with systemd-cgtop
systemd-cgtop

# Watch with cgroupv2 tools
cat /sys/fs/cgroup/myapp/cpu.stat
cat /sys/fs/cgroup/myapp/memory.current
```

## Delegation for rootless containers

```bash
# Grant unprivileged user ownership of a subtree
chown -R user:user /sys/fs/cgroup/myapp/

# User can now create sub-cgroups and move their own processes
# but cannot enable controllers not already enabled by parent
```

The `nsdelegate` mount option prevents container breakouts:
```bash
mount -o remount,nsdelegate /sys/fs/cgroup
# Now: tasks in a namespace can only control their subtree
```

## Further reading

- [Cgroup v2 Architecture](cgroup-v2.md) — Hierarchy and core data structures
- [Memory Cgroups](../mm/memcg.md) — Deep dive into memcg accounting
- [PSI](../mm/psi.md) — Pressure stall information
- `Documentation/admin-guide/cgroup-v2.rst` — Complete controller reference
