# Scheduler

> How Linux decides which task runs next

The Linux scheduler is responsible for deciding which task runs on each CPU at any given moment. It balances competing requirements: fairness between tasks, low latency for interactive work, high throughput for batch jobs, and determinism for real-time processes.

## Structure of this section

### Fundamentals
- [Scheduler Evolution](scheduler-evolution.md) — From O(1) to CFS to EEVDF
- [Scheduler Classes](scheduler-classes.md) — The five scheduling policies and how they're layered
- [CFS: Completely Fair Scheduler](cfs.md) — vruntime, the red-black tree, and weighted fairness
- [EEVDF Scheduler](eevdf.md) — Virtual deadlines, eligibility, and replacing CFS
- [Runqueues and Task Selection](runqueues.md) — Per-CPU runqueues and how tasks are picked

### Lifecycle
- [Life of a Context Switch](context-switch.md) — What happens inside `__schedule()`
- [What Happens When a Process Wakes Up](wakeup.md) — Wakeup path and scheduler placement
- [What Happens When You fork()](sched-fork.md) — How new tasks enter the scheduler

### Real-Time
- [RT Scheduler](rt-scheduler.md) — SCHED_FIFO, SCHED_RR, and the RT runqueue
- [SCHED_DEADLINE](deadline.md) — CBS and admission control
- [Priority Inversion and PI Mutexes](pi-mutexes.md) — The problem and the solution

### Resource Control
- [CPU cgroup v1 vs v2](cpu-cgroup.md) — shares, quota, and the hierarchy difference
- [CPU Bandwidth Control](cpu-bandwidth.md) — CFS bandwidth throttling
- [cpuset](cpuset.md) — CPU and NUMA node affinity via cgroups

### Topology
- [Scheduler Domains and Load Balancing](sched-domains.md) — SMT, LLC, NUMA hierarchy
- [CPU Affinity and Pinning](cpu-affinity.md) — taskset, sched_setaffinity, and when to use them

### Debugging
- [Understanding /proc/schedstat](schedstat.md) — Per-CPU and per-task scheduler statistics
- [Tracing the Scheduler](sched-tracing.md) — ftrace, perf sched, and scheduler events
- [Tuning for Latency vs Throughput](sched-tuning.md) — sysctl knobs and their trade-offs

## Key source files

| File | What it does |
|------|-------------|
| [`kernel/sched/core.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/core.c) | `__schedule()`, `context_switch()`, `wake_up_process()` |
| [`kernel/sched/fair.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/fair.c) | CFS and EEVDF implementation |
| [`kernel/sched/rt.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/rt.c) | RT scheduler |
| [`kernel/sched/deadline.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/deadline.c) | SCHED_DEADLINE |
| [`kernel/sched/sched.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/sched.h) | Core data structures: `struct rq`, `struct sched_class`, `struct cfs_rq` |
| [`include/linux/sched.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/sched.h) | `struct task_struct`, `struct sched_entity` |
