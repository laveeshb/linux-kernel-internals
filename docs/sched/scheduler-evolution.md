# Scheduler Evolution: O(1) → CFS → EEVDF

> How Linux's scheduler changed three times in thirty years, and why

## The problem every scheduler solves

The kernel must answer one question thousands of times per second: **which task should run next?**

The answer must be:
- **Fair** — no task should starve
- **Fast** — picking a task must be cheap
- **Responsive** — interactive tasks need low latency
- **Scalable** — work on hundreds of CPUs

No scheduler solves all four perfectly. Each generation of Linux scheduler made different trade-offs.

---

## The original scheduler (1991–2001)

Linux 1.0 used a simple O(n) scheduler: to pick the next task, it scanned every runnable task and picked the one with the highest "goodness" score.

This worked fine with a handful of processes. With hundreds, it didn't — every scheduling decision took time proportional to the number of runnable tasks.

---

## The O(1) scheduler (2.6.0, 2003)

**Author**: Ingo Molnar

Linux 2.6.0 introduced the O(1) scheduler. The key insight: **precompute priorities into fixed-size bitmaps**.

### How it worked

Two priority arrays per CPU (`active` and `expired`), each with 140 priority levels and a bitmap marking which levels had runnable tasks:

```c
struct prio_array {
    unsigned int nr_active;
    DECLARE_BITMAP(bitmap, MAX_PRIO + 1);
    struct list_head queue[MAX_PRIO];
};
```

To pick the next task:
1. `sched_find_first_bit(bitmap)` — O(1), finds highest-priority non-empty queue
2. Take the first task from that queue

When a task exhausted its timeslice, it moved from `active` to `expired` with a freshly calculated timeslice. When `active` emptied, swap the pointers.

### Why it was fast

No scanning. Task selection was a single bitmap operation regardless of how many tasks were running. This was a genuine win on large systems.

### The problem: fairness heuristics

The O(1) scheduler calculated "interactivity" scores to boost interactive tasks and penalize CPU-bound ones. These heuristics were notoriously fragile:

- Games and multimedia apps sometimes got misclassified as CPU-bound
- A sleeping task could wake up with an enormous priority boost, starving others
- The heuristics were opaque — understanding why a task ran (or didn't) required reading hundreds of lines of complex estimation code

Con Kolivas, a Linux contributor and anesthesiologist, spent years writing patches to fix these fairness problems. His work highlighted the fundamental issue: **interactive detection is the wrong approach**. The scheduler should be provably fair, not approximately fair.

---

## CFS: Completely Fair Scheduler (2.6.23, October 2007)

**Author**: Ingo Molnar (inspired by Con Kolivas's work)

**Commit**: [2bd8e7d04a0a](https://git.kernel.org/linus/2bd8e7d04a0a) (initial CFS merge)

CFS replaced the O(1) scheduler's heuristics with a single elegant concept: **virtual runtime**.

### The core idea

Every task has a `vruntime` — the amount of CPU time it has consumed, weighted by its priority. The scheduler always runs the task with the smallest `vruntime`.

This is provably fair: over time, all tasks at the same priority converge on equal CPU share.

### Virtual time and weight

Not all tasks are equal. A task at nice -20 should get more CPU than a task at nice +19. CFS handles this through **weight**:

```c
// kernel/sched/core.c
const int sched_prio_to_weight[40] = {
 /* -20 */     88761,     71755,     56483,     46273,     36291,
 /* -15 */     29154,     23254,     18705,     14949,     11916,
 /* -10 */      9548,      7620,      6100,      4904,      3906,
 /*  -5 */      3121,      2501,      1991,      1586,      1277,
 /*   0 */      1024,       820,       655,       526,       423,
 /*   5 */       335,       272,       215,       172,       137,
 /*  10 */       110,        87,        70,        56,        45,
 /*  15 */        36,        29,        23,        18,        15,
};
```

Each step in nice value is roughly a 1.25x weight difference. A task at nice 0 has weight 1024; at nice -1, weight 1277 (~25% more).

When updating vruntime, time is scaled by weight:

```c
// kernel/sched/fair.c
static u64 calc_delta_fair(u64 delta, struct sched_entity *se)
{
    if (unlikely(se->load.weight != NICE_0_LOAD))
        delta = __calc_delta(delta, NICE_0_LOAD, &se->load);
    return delta;
}
```

A high-weight task's vruntime advances slowly relative to wall time; a low-weight task's vruntime advances quickly. Result: high-weight tasks get more real CPU time while still being selected by the same "smallest vruntime" rule.

### The red-black tree

Runnable tasks are stored in a red-black tree (`struct rb_root_cached`), keyed by vruntime. The leftmost node is always the task with the smallest vruntime — the next task to run.

```
          [vruntime=100]
         /              \
  [vruntime=80]    [vruntime=130]
       /
 [vruntime=60]  ← pick this next
```

Enqueue, dequeue, and min-lookup are all O(log n). In practice, runqueues are small enough that this is effectively constant.

### Key data structures

```c
// include/linux/sched.h — per-task
struct sched_entity {
    struct load_weight  load;           // weight (derived from nice value)
    u64                 vruntime;       // virtual runtime
    u64                 exec_start;     // last time update_curr() ran
    u64                 sum_exec_runtime; // total real CPU time consumed
    // ... (EEVDF fields added later)
};

// kernel/sched/sched.h — per-CPU CFS runqueue
struct cfs_rq {
    struct rb_root_cached tasks_timeline; // RB-tree of runnable tasks
    struct sched_entity  *curr;           // currently running entity
    unsigned int          nr_queued;      // number of queued entities
    // ...
};
```

### The update loop

Every timer tick and on every context switch, `update_curr()` runs:

```c
// kernel/sched/fair.c
static void update_curr(struct cfs_rq *cfs_rq)
{
    struct sched_entity *curr = cfs_rq->curr;
    u64 now = rq_clock_task(rq_of(cfs_rq));
    u64 delta_exec = now - curr->exec_start;

    curr->exec_start = now;
    curr->sum_exec_runtime += delta_exec;
    curr->vruntime += calc_delta_fair(delta_exec, curr);

    // update_min_vruntime(cfs_rq);
}
```

### CFS strengths

- **No heuristics**: Fairness is a mathematical property, not an approximation
- **Predictable**: vruntime makes scheduling behavior auditable
- **Good for most workloads**: Server, desktop, container workloads all benefit

### CFS weaknesses

Over time, a new problem emerged. CFS's "minimum vruntime" approach optimizes for fairness but not for latency. A task that wakes up and needs to run quickly might have to wait behind tasks that technically have smaller vruntimes, even if those tasks have been running for a while.

Real-time and latency-sensitive workloads (network I/O, audio, gaming) need a scheduler that can make **latency guarantees**, not just fairness guarantees.

---

## EEVDF: Earliest Eligible Virtual Deadline First (6.6, October 2023)

**Author**: Peter Zijlstra (Intel)

**Commit**: [147f3efaa241](https://git.kernel.org/linus/147f3efaa241) ("sched/fair: Implement an EEVDF-like scheduling algorithm")

EEVDF is based on a 1995 academic paper by Ion Stoica and Hussein Abdel-Wahab. It adds **virtual deadlines** to the fairness model.

### The key insight

CFS asks: *who has used the least CPU?* (minimum vruntime)

EEVDF asks: *who has the most urgent deadline, among those who are eligible to run?*

This distinction matters for latency. A task that wakes up after sleeping has a short virtual deadline — it needs to run soon. EEVDF can give it the CPU without violating fairness for other tasks.

### Eligibility and virtual deadlines

Each task has:
- `vruntime` — virtual time consumed (same as CFS)
- `deadline` — virtual time by which it must run
- `slice` — requested time slice
- `vlag` — how far behind or ahead the task is relative to ideal fair share

A task is **eligible** if its `vruntime` is at or behind the current virtual time of the runqueue — it hasn't "spent ahead":

```c
// kernel/sched/fair.c
static bool vruntime_eligible(struct cfs_rq *cfs_rq, u64 vruntime)
{
    struct sched_entity *curr = cfs_rq->curr;
    s64 avg = cfs_rq->avg_vruntime;
    long load = cfs_rq->avg_load;

    if (curr && curr->on_rq) {
        unsigned long weight = scale_load_down(curr->load.weight);
        avg += entity_key(cfs_rq, curr) * weight;
        load += weight;
    }

    return avg >= (s64)(vruntime - cfs_rq->min_vruntime) * load;
}
```

Among eligible tasks, EEVDF picks the one with the **earliest virtual deadline**:

```c
// kernel/sched/fair.c
static struct sched_entity *pick_eevdf(struct cfs_rq *cfs_rq)
{
    return __pick_eevdf(cfs_rq);
}
```

The deadline is set when a task is enqueued:

```c
// kernel/sched/fair.c
se->deadline = se->vruntime + calc_delta_fair(se->slice, se);
```

### Comparison: CFS vs EEVDF

| Property | CFS | EEVDF |
|----------|-----|-------|
| Selection criterion | Minimum vruntime | Earliest deadline among eligible tasks |
| Latency for waking tasks | Poor (must wait for vruntime catch-up) | Good (eligible immediately, short deadline) |
| Fairness guarantee | Yes (vruntime convergence) | Yes (eligibility + deadline together) |
| Time slice | Dynamic, implicit | Explicit (`se->slice`) |
| Based on | Rotating Staircase Deadline (Con Kolivas) | Stoica & Abdel-Wahab, 1995 |

### What changed in practice

For most workloads the difference is subtle — CFS was already good. EEVDF primarily helps:

- **Network-heavy services**: Faster response to waking tasks after I/O
- **Audio/multimedia**: More consistent scheduling cadence
- **Mixed workloads**: CPU-bound tasks less likely to delay latency-sensitive ones

### The `kernel.sched_latency_ns` knob

EEVDF made the existing `sched_latency_ns` sysctl more meaningful as it now directly influences the `slice` assigned to tasks:

```bash
# Default: 6ms (6000000 ns)
cat /proc/sys/kernel/sched_latency_ns

# Halving this reduces per-task time slices (lower latency, higher overhead)
# Doubling increases throughput at the cost of responsiveness
```

---

## Summary

| Era | Scheduler | Version | Key innovation | Main weakness |
|-----|-----------|---------|----------------|---------------|
| 1991–2003 | Original | 1.0–2.4 | Simple goodness metric | O(n) selection |
| 2003–2007 | O(1) | 2.6.0–2.6.22 | Bitmap-based O(1) selection | Fragile interactivity heuristics |
| 2007–2023 | CFS | 2.6.23–6.5 | Virtual runtime, provable fairness | Poor latency for waking tasks |
| 2023– | EEVDF | 6.6+ | Virtual deadlines + eligibility | Still settling (active development) |

## Further reading

- [kernel/sched/fair.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/fair.c) — CFS and EEVDF implementation
- [LWN: An EEVDF CPU scheduler for Linux](https://lwn.net/Articles/925371/) (2023)
- [LWN: Introducing the Completely Fair Scheduler](https://lwn.net/Articles/230501/) (2007)
- Original EEVDF paper: Stoica & Abdel-Wahab, "Earliest Eligible Virtual Deadline First" (1995)
