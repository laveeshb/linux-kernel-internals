# Lock Contention Debugging

> Finding and fixing lock hotspots in the kernel

## Identifying the problem

Lock contention manifests as CPUs burning time waiting rather than doing useful work. Symptoms:
- High CPU utilization but low throughput
- `perf top` shows `_raw_spin_lock` or `mutex_lock` near the top
- `sar -u` shows high `%sys` with low actual work rate
- `perf stat` shows many `lock:contention_begin` events

## /proc/lock_stat

Requires `CONFIG_LOCK_STAT=y`. Provides per-lock-class contention statistics:

```bash
# Enable lock stats collection
echo 1 > /proc/sys/kernel/lock_stat

# View stats (reset on read if you use >)
cat /proc/lock_stat

# Reset counters
echo 0 > /proc/lock_stat
```

Output format:
```
class name    con-bounces  contentions  waittime-min  waittime-max  waittime-total  acq-bounces  acquisitions  holdtime-min  holdtime-max  holdtime-total
&rq->lock:
                   234567       234567          0.20       4567.89    12345678.90       345678      23456789          0.10        234.56    23456789.12
```

Key columns:
- **contentions**: number of times a caller had to wait (lock was already held)
- **waittime-max**: worst-case wait time (µs) — your tail latency
- **holdtime-total**: total time the lock was held — high means long critical sections
- **con-bounces**: contentions where the previous holder was on a different CPU (cross-CPU bouncing)

```bash
# Find the most contended locks
cat /proc/lock_stat | sort -k2 -rn | head -20

# Focus on high wait times
awk '$5 > 1000' /proc/lock_stat  # waittime-max > 1ms
```

## perf lock

`perf lock` traces lock events with timestamps:

```bash
# Record lock events (requires perf with lock support)
perf lock record -a sleep 10

# Analyze: show most contended locks
perf lock report

# Summary view
perf lock report --key acquired
```

Output:
```
                Name   acquired  contended  avg wait (ns)  total wait (ns)
        &rq->__lock:    1234567      45678          12345      12345678901
  &mm->mmap_lock(W):      23456       1234         234567       1234567890
```

## perf top for lock hotspots

```bash
# Find which functions spend most time waiting on locks
perf top -e lock:contention_begin,lock:contention_end

# Profile lock acquisition overhead
perf record -e lock:contention_begin -ag sleep 10
perf report --stdio
```

## bpftrace for lock analysis

```bash
# Track lock wait time per lock and call site
bpftrace -e '
kprobe:mutex_lock {
    @ts[tid] = nsecs;
    @caller[tid] = kstack;
}
kretprobe:mutex_lock /@ts[tid]/ {
    $wait = nsecs - @ts[tid];
    if ($wait > 1000000) {  /* > 1ms */
        printf("Long mutex wait: %lu ns\n  caller:\n%s\n",
               $wait, @caller[tid]);
    }
    delete(@ts[tid]);
    delete(@caller[tid]);
}'

# Histogram of spinlock hold times
bpftrace -e '
kprobe:_raw_spin_lock {
    @start[tid] = nsecs;
}
kprobe:_raw_spin_unlock /@start[tid]/ {
    @hold_ns = hist(nsecs - @start[tid]);
    delete(@start[tid]);
}'

# Find which locks have the most contention (spin loops)
bpftrace -e '
kprobe:__pv_queued_spin_lock_slowpath {
    @[kstack] = count();
}
interval:s:5 {
    print(@); clear(@);
}'
```

## Lockdep contention tracking

```bash
# With CONFIG_LOCK_STAT and CONFIG_LOCKDEP, check /proc/lockdep_stats
cat /proc/lockdep_stats
# lock-classes: 2341
# direct dependencies: 8234
# chain cache misses: 123
# hardirq-safe locks:  456
# softirq-safe locks:  789
```

## ftrace: tracing specific lock points

```bash
# Trace all mutex_lock calls with stack
echo mutex_lock > /sys/kernel/debug/tracing/set_ftrace_filter
echo function_graph > /sys/kernel/debug/tracing/current_tracer
echo 1 > /sys/kernel/debug/tracing/tracing_on
# ... reproduce the issue ...
echo 0 > /sys/kernel/debug/tracing/tracing_on
cat /sys/kernel/debug/tracing/trace | head -100
```

## Common lock contention patterns and fixes

### 1. Fine-grained locking

Replace one coarse lock with many per-bucket or per-object locks:

```c
/* Before: one global lock */
static DEFINE_SPINLOCK(hash_lock);
static struct hlist_head hash_table[HASH_SIZE];

/* After: per-bucket locks */
struct hash_bucket {
    spinlock_t lock;
    struct hlist_head head;
} ____cacheline_aligned;
static struct hash_bucket hash_table[HASH_SIZE];
```

The `____cacheline_aligned` attribute prevents false sharing between adjacent buckets.

### 2. Read-write splitting

If most access is read-only, use rwsem or RCU:

```c
/* Before: spinlock serializes readers and writers */
spin_lock(&config_lock);
val = config->value;
spin_unlock(&config_lock);

/* After: RCU allows concurrent reads */
rcu_read_lock();
cfg = rcu_dereference(config);
val = cfg->value;
rcu_read_unlock();
```

### 3. Per-CPU sharding

For counters and stats, use per-CPU variables:

```c
/* Before: atomic increment on shared counter */
atomic_inc(&event_count);

/* After: per-CPU counter, no synchronization needed */
this_cpu_inc(event_count);
```

### 4. Lock elision / trylock patterns

In some cases, falling back to a slower path avoids contention:

```c
/* Try to acquire, fall back to queuing work if busy */
if (!spin_trylock(&cache_lock)) {
    schedule_work(&cache_work);  /* retry later */
    return;
}
/* fast path */
spin_unlock(&cache_lock);
```

### 5. Batching

Reduce lock granularity by batching multiple updates into one critical section:

```c
/* Before: one lock per item */
for (item in items) {
    spin_lock(&list_lock);
    list_add(&item->node, &list);
    spin_unlock(&list_lock);
}

/* After: batch */
spin_lock(&list_lock);
for (item in items)
    list_add(&item->node, &list);
spin_unlock(&list_lock);
```

## Further reading

- [Lockdep](lockdep.md) — Detecting circular dependencies
- [Spinlock](spinlock.md) — When spinlocks make sense
- [RCU](rcu.md) — For read-heavy workloads
- [Per-CPU variables](percpu.md) — Eliminating shared counters
