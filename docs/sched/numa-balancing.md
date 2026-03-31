# NUMA Automatic Balancing

> How the scheduler detects and fixes NUMA locality mismatches

## The problem

On NUMA systems, memory access latency depends on which NUMA node holds the physical page:

```
Node 0:                 Node 1:
  CPU 0, CPU 1            CPU 2, CPU 3
  Memory 0 (fast)         Memory 1 (fast)
       │                        │
       └──────── QPI/UPI ────────┘
                (slow: ~2× penalty)

Task running on CPU 2 reading pages on Node 0:
  → every cache miss → remote memory access → 2× latency!
```

**Automatic NUMA balancing** (CONFIG_NUMA_BALANCING) detects this situation and migrates pages to the node where they're being used.

## How it works

### Phase 1: Mark pages as inaccessible (PROT_NONE)

The NUMA balancer periodically scans a process's page tables and changes the PTE of accessed pages to `PROT_NONE` (unmaps them without freeing):

```c
/* kernel/sched/fair.c */
static void task_numa_work(struct callback_head *work)
{
    struct task_struct *p = current;
    unsigned long start = p->numa_scan_offset;

    /* Walk a chunk of VA space, NUMA-fault the PTEs: */
    change_prot_numa(p->mm, start, start + NUMA_SCAN_SIZE);
    /* Sets PTE to PROT_NONE with _PAGE_NUMA flag */

    p->numa_scan_offset = start + NUMA_SCAN_SIZE;
    if (p->numa_scan_offset >= p->mm->highest_vm_end)
        p->numa_scan_offset = 0;  /* wrap around */
}
```

### Phase 2: Catch NUMA page faults

When the task accesses the PROT_NONE page, a page fault fires:

```c
/* mm/memory.c: do_numa_page() */
static vm_fault_t do_numa_page(struct vm_fault *vmf)
{
    struct page *page = vm_normal_page(vmf->vma, vmf->address, vmf->orig_pte);
    int page_nid    = page_to_nid(page);   /* current NUMA node of page */
    int this_nid    = numa_node_id();       /* CPU's NUMA node */

    /* Record the access for statistics */
    task_numa_fault(last_cpupid, page_nid, 1, flags);

    /* Should we migrate this page? */
    if (page_nid != this_nid) {
        /* Migrate the page to this_nid */
        migrate_misplaced_page(page, vmf->vma, this_nid);
    }

    /* Restore the PTE (make it accessible again) */
    pte_t pte = pte_modify(vmf->orig_pte, vma->vm_page_prot);
    set_pte_at(vmf->vma->vm_mm, vmf->address, vmf->pte, pte);

    return 0;
}
```

### Phase 3: Task migration

If the task has most of its pages on Node 1 but runs on Node 0, the scheduler may migrate the **task** instead of (or in addition to) the pages:

```c
/* kernel/sched/fair.c */
static bool task_numa_compare(struct task_numa_env *env,
                               long taskimp, long groupimp, bool maymove)
{
    /*
     * Compare: task running on preferred_node vs current_node
     * taskimp: improvement score from moving task
     * groupimp: improvement from moving entire task group
     */
    long imp = env->p->numa_group ? groupimp : taskimp;
    if (imp <= env->best_imp)
        return false;
    /* Better NUMA locality → update best candidate */
    env->best_imp  = imp;
    env->best_task = env->dst_task;
    env->best_cpu  = env->dst_cpu;
    return true;
}
```

## NUMA statistics per task

```c
/* task_struct NUMA fields: */
struct task_struct {
    /* ... */
    int             numa_preferred_nid;   /* preferred NUMA node */
    unsigned long   numa_migrate_retry;
    u64             node_stamp;           /* last numa balancing work */
    u64             last_task_numa_placement;
    u64             last_sum_exec_runtime;
    struct callback_head    numa_work;

    struct numa_group __rcu *numa_group;  /* task group for shared memory */

    unsigned long   *numa_faults;         /* faults per node per access type */
    /* [2 * nr_nodes]: [local faults, remote faults] for each node */
    /* [2]: cpu vs mem accesses */
};
```

## NUMA groups: shared memory balancing

When multiple tasks share memory (e.g., a multithreaded program), they form a **NUMA group**:

```c
struct numa_group {
    refcount_t          refcount;
    spinlock_t          lock;
    int                 nr_tasks;
    pid_t               gid;
    int                 active_nodes;

    /* Fault statistics per node: */
    unsigned long       total_faults;
    unsigned long       max_faults_cpu;

    unsigned long       *faults;       /* faults[node][type] */
    unsigned long       *faults_cpu;

    struct rcu_head     rcu;
    unsigned long       nodes[];       /* online nodes participating */
};

/* Tasks in a group are migrated together to preserve shared memory locality */
```

## Balancing scan rate

The scan rate adapts based on how many NUMA faults are found:

```c
/* How often to scan (pages per second): */
/* Controlled by: /proc/sys/kernel/numa_balancing_scan_period_min/max */

static void update_task_scan_period(struct task_struct *p,
                                     unsigned long shared, unsigned long private)
{
    /* More faults → scan more aggressively (lower period) */
    /* Fewer faults → scan less often (higher period) */

    unsigned int period = p->numa_scan_period;
    if (faults > p->numa_faults_locality[2])
        period = max(period / 2, task_scan_min(p));  /* speed up */
    else
        period = min(period * 2, task_scan_max(p));  /* slow down */

    p->numa_scan_period = period;
}
```

## Configuration

```bash
# Enable/disable automatic NUMA balancing:
echo 1 > /proc/sys/kernel/numa_balancing   # enable (default)
echo 0 > /proc/sys/kernel/numa_balancing   # disable

# Scan period (milliseconds) — how often to scan each task's VAS:
cat /proc/sys/kernel/numa_balancing_scan_period_min_ms  # default 1000
cat /proc/sys/kernel/numa_balancing_scan_period_max_ms  # default 60000

# Scan size — bytes scanned per interval:
cat /proc/sys/kernel/numa_balancing_scan_size_mb  # default 256

# Time a page must be "hot" before migrating:
cat /proc/sys/kernel/numa_balancing_hot_threshold_ms  # default 1000

# Tune for a database workload (aggressive):
echo 100  > /proc/sys/kernel/numa_balancing_scan_period_min_ms
echo 5000 > /proc/sys/kernel/numa_balancing_scan_period_max_ms
echo 1024 > /proc/sys/kernel/numa_balancing_scan_size_mb
```

## Observing NUMA balancing

```bash
# Per-process NUMA stats:
cat /proc/<pid>/sched  # numa_faults, numa_preferred_nid, ...
cat /proc/<pid>/numa_maps
# 7f1234000000 default anon=12 dirty=12 N0=8 N1=4
#                                         ↑N0  ↑N1 = pages on each node

# System-wide NUMA balancing stats:
cat /proc/vmstat | grep numa
# numa_hint_faults      12345   ← PROT_NONE faults triggered
# numa_hint_faults_local 8000  ← faults already on preferred node
# numa_pages_migrated    4345  ← pages migrated
# numa_pte_updates       50000 ← PTEs marked PROT_NONE

# NUMA misses in perf:
perf stat -e dtlb_load_misses.miss_causes_a_walk,node_loads,node_stores \
          -p <pid> sleep 5

# numastat: per-node allocation stats
numastat <pid>
numastat -m  # system memory per node

# Trace NUMA page fault + migration:
bpftrace -e '
kprobe:do_numa_page {
    @numa_faults[tid] = count();
}
kprobe:migrate_misplaced_page {
    @migrations = count();
}'

# Check NUMA topology:
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3
# node 1 cpus: 4 5 6 7
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10
```

## When to disable NUMA balancing

```bash
# Disable for workloads where it hurts:
# 1. Already NUMA-pinned workloads:
numactl --cpunodebind=0 --membind=0 ./myapp
# (explicit placement beats auto-balancing)

# 2. Latency-sensitive workloads:
# NUMA faults add ~10µs per fault — avoid for RT tasks
echo 0 > /proc/sys/kernel/numa_balancing

# 3. tmpfs/huge page workloads:
# Pages in tmpfs or huge pages aren't scanned by NUMA balancer
# No benefit to enable

# 4. Mostly sequential single-node access:
# If the app already accesses data on the local node, balancing adds
# overhead (scan + faults) with no benefit
```

## NUMA-aware memory allocation

For applications that want explicit NUMA control:

```c
/* Link with -lnuma */
#include <numa.h>

/* Allocate on node 0: */
void *mem = numa_alloc_onnode(size, 0);

/* Allocate on the local node (where this thread runs): */
void *mem = numa_alloc_local(size);

/* Set memory policy for subsequent allocations: */
struct bitmask *mask = numa_bitmask_alloc(numa_num_configured_nodes());
numa_bitmask_setbit(mask, 0);
numa_set_membind(mask);   /* only allocate from node 0 */
```

## Further reading

- [NUMA](../mm/numa.md) — NUMA architecture and zonelist
- [NUMA Distance](../mm/numa-distance.md) — ACPI SRAT and distance matrices
- [NUMA Reclaim](../mm/numa-reclaim.md) — reclaim policies per node
- [CFS Load Balancing](load-balancing.md) — CPU scheduler load balancing
- [NUMA Zonelist](../mm/numa-zonelist.md) — memory allocation fallback
- `kernel/sched/fair.c` — task_numa_work, do_numa_page
- `mm/migrate.c` — migrate_misplaced_page
