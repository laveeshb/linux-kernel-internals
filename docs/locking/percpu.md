# Per-CPU Variables

> Eliminating shared state by giving each CPU its own copy

## The core idea

Many kernel subsystems maintain per-CPU counters or state — a count of context switches, cache statistics, a runqueue pointer. The obvious approach is a global variable with a lock. But the per-CPU approach is better: give each CPU its own copy.

Benefits:
- **No synchronization needed for CPU-local access**: reading/writing your own CPU's copy requires no locks
- **No cache line bouncing**: each CPU touches only its own data, no false sharing
- **Naturally scalable**: performance doesn't degrade as CPU count increases

The tradeoff: reading the system-wide total requires summing all CPUs' copies.

## How it works

The kernel allocates a contiguous per-CPU area for each CPU at boot. A per-CPU variable is an offset into this area. To access CPU N's copy, you compute `base[N] + offset`:

```
Per-CPU memory layout:

CPU 0 area:  [var_a] [var_b] [counter] [...]
CPU 1 area:  [var_a] [var_b] [counter] [...]
CPU 2 area:  [var_a] [var_b] [counter] [...]
                      ↑
                      same offset, different base address per CPU
```

## Declaring and using per-CPU variables

```c
#include <linux/percpu.h>
#include <linux/percpu-defs.h>

/* Declare a per-CPU variable (one copy per CPU) */
DEFINE_PER_CPU(int, my_counter);
DEFINE_PER_CPU(struct my_stats, cpu_stats);

/* Declare in header: */
DECLARE_PER_CPU(int, my_counter);

/* Access your own CPU's copy */
/* get_cpu_var: disables preemption, returns reference */
int val = get_cpu_var(my_counter);
get_cpu_var(my_counter)++;
put_cpu_var(my_counter);  /* re-enables preemption */

/* this_cpu_*: low-overhead variant, you must ensure no migration */
this_cpu_inc(my_counter);
this_cpu_add(my_counter, 5);
int v = this_cpu_read(my_counter);
this_cpu_write(my_counter, 0);
```

The difference between `get_cpu_var` and `this_cpu_*`:
- `get_cpu_var` disables preemption — safe even if code can be preempted
- `this_cpu_*` does NOT disable preemption — caller must guarantee they won't migrate (e.g., already in a preemption-disabled section, or in a per-CPU context)

## Accessing another CPU's data

```c
/* Read CPU N's copy (observer only, no lock needed for reading) */
int val = per_cpu(my_counter, cpu_id);

/* Get a pointer to CPU N's copy */
int *ptr = per_cpu_ptr(&my_counter, cpu_id);
```

For writes to another CPU's variable, you typically need either a lock or to use an IPI (inter-processor interrupt) to run code on that CPU.

## Summing all CPUs

```c
/* Sum a per-CPU integer across all CPUs */
long total = 0;
int cpu;
for_each_possible_cpu(cpu)
    total += per_cpu(my_counter, cpu);

/* Or using the convenience helper for percpu_counter: */
s64 sum = percpu_counter_sum(&my_percpu_counter);
```

## percpu_counter: the ready-made solution

For simple counters, `percpu_counter` provides a complete implementation that batches updates to a central counter:

```c
#include <linux/percpu_counter.h>

struct percpu_counter my_counter;
percpu_counter_init(&my_counter, 0, GFP_KERNEL);

/* Fast: update this CPU's local count */
percpu_counter_add(&my_counter, 1);
percpu_counter_inc(&my_counter);
percpu_counter_dec(&my_counter);

/* Approximate: fast sum (may be slightly off) */
s64 approx = percpu_counter_read(&my_counter);

/* Exact: sums all CPUs (slower) */
s64 exact = percpu_counter_sum(&my_counter);

percpu_counter_destroy(&my_counter);
```

`percpu_counter` batches updates: each CPU accumulates up to `batch` (default 32) local changes before flushing to the global counter. This makes increments O(1) with no atomic operations in the fast path.

## When NOT to use per-CPU variables

Per-CPU is not always the answer:

```
Use per-CPU when:
  ✓ Data is primarily updated by the owning CPU
  ✓ Global aggregates can be approximate (stats, counters)
  ✓ Per-CPU state makes semantic sense (runqueues, CPU-local caches)

Don't use per-CPU when:
  ✗ Any CPU can update the data equally often
  ✗ The global total must always be exact and consistent
  ✗ The data is inherently global (a single flag, a single pointer)
```

## Real-world usage: VM stats

The mm subsystem uses per-CPU variables for page counters:

```c
/* mm/vmstat.c */
DEFINE_PER_CPU(struct vm_event_state, vm_event_states);

/* Increment a VM event counter (e.g., number of page faults) */
static inline void count_vm_event(enum vm_event_item item)
{
    this_cpu_inc(vm_event_states.event[item]);
}

/* Read the global total */
unsigned long global_node_page_state(enum node_stat_item item)
{
    long x = atomic_long_read(&vm_node_stat[item]);
    return x;
}
```

And the scheduler uses per-CPU runqueues:

```c
/* kernel/sched/core.c */
DEFINE_PER_CPU_SHARED_ALIGNED(struct rq, runqueues);

#define cpu_rq(cpu) (&per_cpu(runqueues, (cpu)))
#define this_rq()   this_cpu_ptr(&runqueues)
```

## Further reading

- [Atomic operations](atomics.md) — When you do need synchronization
- [Spinlock](spinlock.md) — Protecting truly shared data
- `Documentation/core-api/per-cpu.rst` in the kernel tree
