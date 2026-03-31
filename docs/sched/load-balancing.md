# Load Balancing

> How the scheduler distributes tasks across CPUs

## Why load balancing is hard

Load balancing must trade off:
- **Throughput**: spread tasks evenly to use all CPUs
- **Cache affinity**: a task recently on CPU A has hot cache — migrating it to B is expensive
- **NUMA locality**: migrating across NUMA nodes is more expensive than across cores
- **Topology awareness**: don't migrate across P-cores/E-cores on hybrid CPUs

The Linux scheduler uses a **hierarchical scheduling domain** topology to navigate these trade-offs.

## Scheduling domains and groups

```
System topology (example: 2-socket NUMA, 4 cores each, 2-way SMT):

NUMA domain
├── MC (multicore) domain — socket 0
│   ├── SMT group: {cpu0, cpu4}   (physical core 0)
│   ├── SMT group: {cpu1, cpu5}   (physical core 1)
│   ├── SMT group: {cpu2, cpu6}   (physical core 2)
│   └── SMT group: {cpu3, cpu7}   (physical core 3)
└── MC domain — socket 1
    ├── SMT group: {cpu8, cpu12}
    ...
```

Each scheduling domain has parameters controlling when to balance:

```c
/* include/linux/sched/topology.h */
struct sched_domain {
    struct sched_domain __rcu *parent; /* up to NUMA domain */
    struct sched_domain __rcu *child;  /* down to SMT domain */
    struct sched_group  *groups;       /* circular list of groups */

    unsigned long       min_interval;  /* balance interval at min load */
    unsigned long       max_interval;  /* balance interval at max load */
    unsigned int        busy_factor;   /* extra balance when busy */

    int                 balance_interval; /* current interval */
    unsigned int        nr_balance_failed; /* consecutive failed balances */

    unsigned long       last_balance;  /* jiffies of last balance */

    int                 span_weight;   /* number of CPUs this domain covers */
    cpumask_var_t       span;          /* CPUs in this domain */

    /* Flags controlling behavior */
    unsigned int        flags;
    /* SD_LOAD_BALANCE: participate in balancing */
    /* SD_BALANCE_NEWIDLE: balance when CPU goes idle */
    /* SD_BALANCE_EXEC: balance on exec() */
    /* SD_BALANCE_FORK: balance on fork() */
    /* SD_WAKE_AFFINE: try to wake on current CPU */
    /* SD_ASYM_PACKING: use SD for asymmetric packing (E-core/P-core) */
    /* SD_NUMA: NUMA domain */
};
```

## Periodic load balancing

Every CPU runs `load_balance()` periodically (via the scheduler tick):

```c
/* kernel/sched/fair.c */
static int load_balance(int this_cpu, struct rq *this_rq,
                         struct sched_domain *sd, enum cpu_idle_type idle,
                         int *continue_balancing)
{
    struct lb_env env = {
        .sd             = sd,
        .dst_cpu        = this_cpu,
        .dst_rq         = this_rq,
        .idle           = idle,
        .loop_break     = SCHED_NR_MIGRATE_BREAK,
        .cpus           = cpus,
        .fbq_type       = all,
        .tasks          = LIST_HEAD_INIT(env.tasks),
    };

    /* Find the busiest group in this scheduling domain */
    struct sched_group *group = find_busiest_group(&env);
    if (!group)
        goto out_balanced;

    /* Find the busiest runqueue in the busiest group */
    struct rq *busiest = find_busiest_queue(&env, group);
    if (!busiest)
        goto out_balanced;

    env.src_cpu = busiest->cpu;
    env.src_rq  = busiest;

    /* Move tasks from busiest to this_rq */
    ld_moved = move_tasks(&env);

    return ld_moved;
}
```

## Load metric: PELT

The scheduler uses **PELT** (Per-Entity Load Tracking) to measure each task's load contribution. Introduced in Linux 3.8 by Paul Turner (Google) — [`9d85f21c94f7`](https://git.kernel.org/linus/9d85f21c94f7f7a84d0ba686c58aa6d9da58fdbb). PELT tracks an exponentially weighted moving average of CPU utilization:

```
util_avg = util_avg * decay + new_util * (1 - decay)
```

The decay factor is set so that history older than 32ms has < 1% weight.

```c
/* kernel/sched/pelt.c */
static u32 accumulate_sum(u64 delta, struct sched_avg *sa,
                           unsigned long load, unsigned long runnable,
                           int running)
{
    u32 contrib = (u32)delta;  /* delta since last update */

    /* Geometric series sum for accumulated utilization */
    if (delta < 1024) {
        contrib = div_u64(delta * sa->period_contrib + (contrib << 10),
                          1024);
    } else {
        sa->util_sum = (sa->util_sum >> 1) + (running << (SCHED_CAPACITY_SHIFT - 1));
    }
    return contrib;
}
```

## struct lb_env: the balancing context

```c
/* kernel/sched/sched.h */
struct lb_env {
    struct sched_domain *sd;         /* domain being balanced */

    struct rq           *src_rq;     /* source runqueue (busiest) */
    int                  src_cpu;

    int                  dst_cpu;    /* destination CPU */
    struct rq           *dst_rq;

    struct cpumask      *dst_grpmask; /* CPUs in destination group */
    int                  new_dst_cpu;

    enum cpu_idle_type   idle;       /* CPU_IDLE / CPU_NOT_IDLE / CPU_NEWLY_IDLE */

    long                 imbalance;  /* load imbalance to fix */
    struct cpumask      *cpus;       /* eligible CPUs */

    unsigned int         flags;
    unsigned int         loop;
    unsigned int         loop_break;
    unsigned int         loop_max;

    enum fbq_type        fbq_type;   /* filter type: all/regular/remote/base */
    enum migration_type  migration_type;

    struct list_head     tasks;      /* tasks to migrate */
};
```

## newidle_balance: when CPU goes idle

When a CPU has no tasks, it immediately tries to pull work from a busier CPU:

```c
/* kernel/sched/fair.c */
static int newidle_balance(struct rq *this_rq, struct rq_flags *rf)
{
    unsigned long next_balance = jiffies + HZ;
    int this_cpu = this_rq->cpu;
    u64 t0, t1, curr_cost = 0;
    struct sched_domain *sd;
    int pulled_task = 0;

    update_blocked_averages(this_cpu);

    rcu_read_lock();
    for_each_domain(this_cpu, sd) {
        int continue_balancing = 1;

        if (this_rq->avg_idle < curr_cost + sd->avg_scan_cost ||
            !READ_ONCE(sd->nohz_idle))
            break;

        if (sd->flags & SD_BALANCE_NEWIDLE) {
            pulled_task = load_balance(this_cpu, this_rq, sd,
                                        CPU_NEWLY_IDLE, &continue_balancing);
        }

        if (pulled_task || this_rq->nr_running > 0)
            break;
    }
    rcu_read_unlock();

    return pulled_task;
}
```

`avg_idle` tracks average idle duration. If the CPU is expected to be idle for less time than the scan cost, it skips balancing — not worth the cache pollution.

## Wakeup balancing: select_task_rq_fair

When a task wakes up, the scheduler selects which CPU to place it on:

```c
/* kernel/sched/fair.c */
static int select_task_rq_fair(struct task_struct *p, int prev_cpu,
                                int wake_flags)
{
    int sync = (wake_flags & WF_SYNC) && !(current->flags & PF_EXITING);
    struct sched_domain *tmp, *sd = NULL;
    int cpu = smp_processor_id();
    int new_cpu = prev_cpu;
    int want_affine = 0;

    /* SD_WAKE_AFFINE: try to wake on current CPU (good for producer/consumer) */
    rcu_read_lock();
    for_each_domain(cpu, tmp) {
        if (want_affine && (tmp->flags & SD_WAKE_AFFINE) &&
            cpumask_test_cpu(prev_cpu, sched_domain_span(tmp))) {
            /* Wake affine: check if current CPU is a good choice */
            if (wake_affine(tmp, p, cpu, prev_cpu, sync))
                new_cpu = cpu;
            break;
        }
        if (tmp->flags & sd_flag)
            sd = tmp;
    }

    /* Find idlest CPU in the selected domain */
    if (sd)
        new_cpu = find_idlest_cpu(sd, p, cpu, prev_cpu, sd_flag);

    rcu_read_unlock();
    return new_cpu;
}
```

**Wake affine**: if task B always wakes after task A (producer/consumer), schedule B on the same or nearby CPU to share cache lines.

## Misfit tasks on asymmetric CPUs

On big.LITTLE / hybrid CPUs (ARM big.LITTLE, Intel hybrid P+E cores), a task is "misfit" if it demands more capacity than its current CPU provides:

```c
/* kernel/sched/fair.c */
static bool task_fits_capacity(struct task_struct *p, long capacity)
{
    return fits_capacity(task_util(p), capacity);
}

static inline bool fits_capacity(unsigned long util, unsigned long capacity)
{
    /* 80% threshold: task fits if util < 80% of CPU capacity */
    return util < capacity * 1024 / 1280;  /* 80% threshold */
}

/* Misfit migration: triggered by nohz_balance_kick */
static void check_misfit_status(struct rq *rq, struct sched_domain *sd)
{
    if (rq->misfit_task_load &&
        (rq->curr->nr_cpus_allowed == 1 ||
         !task_fits_capacity(rq->curr, rq->cpu_capacity))) {
        sd->balance_interval = 1;  /* balance immediately */
    }
}
```

## Observing load balancing

```bash
# Runqueue lengths per CPU
watch -n 1 'cat /proc/schedstat | awk "NR%2==0{cpu++; print \"cpu\"cpu, \$9}"'

# Load balancing statistics
cat /proc/schedstat | head -5
# version 15
# timestamp 123456789
# cpu0 0 0 0 0 0 0 0 0 0   ← various fields
# domain0 00000003 lb_count lb_balanced lb_failed ...

# perf: scheduling events
perf stat -e sched:sched_migrate_task,sched:sched_wakeup -a sleep 5

# Trace task migrations
echo 1 > /sys/kernel/tracing/events/sched/sched_migrate_task/enable
cat /sys/kernel/tracing/trace_pipe
# myapp-1234 [002] sched_migrate_task: comm=myapp pid=1234 prio=120 orig_cpu=2 dest_cpu=5

# Scheduling domain topology
cat /proc/sys/kernel/sched_domain/cpu0/domain0/name
# MC
cat /proc/sys/kernel/sched_domain/cpu0/domain1/name
# NUMA

# PELT utilization signal for each task
cat /proc/<pid>/sched | grep -i util
```

## Further reading

- [EAS: Energy-Aware Scheduling](eas.md) — energy-optimal CPU selection on heterogeneous hardware
- [Scheduler: EEVDF](eevdf.md) — per-CPU task selection
- [Scheduler: Scheduling Domains](sched-domains.md) — domain construction
- [Memory Management: NUMA](../mm/numa.md) — NUMA topology and load balancing
- `kernel/sched/fair.c` — CFS/EEVDF and load balancing
- `kernel/sched/topology.c` — domain construction
