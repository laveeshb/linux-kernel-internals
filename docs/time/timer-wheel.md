# The Timer Wheel

> jiffies, struct timer_list, and the hierarchical timer wheel for low-resolution timers

## Two timer systems

Linux maintains two distinct timer implementations that serve different use cases:

| System | Precision | Data structure | Insert cost | Typical use |
|--------|-----------|---------------|-------------|-------------|
| **hrtimer** | ~nanosecond | Per-CPU red-black tree | O(log n) | `sleep()`, audio, network pacing, real-time |
| **timer_list** (timer wheel) | ~1/HZ (1–10 ms) | Per-CPU hierarchical wheel | O(1) | TCP retransmit, watchdogs, delayed work |

hrtimers program hardware clockevents directly for precise wakeups. The timer wheel is designed for timeouts that are frequently cancelled before expiry (e.g., TCP retransmit timers that are cancelled when an ACK arrives). The O(1) insert and cancel cost is the key advantage — most timer-list timers never actually fire.

## jiffies and HZ

`jiffies` is a global counter incremented once per hardware tick. It is the fundamental unit of time for the timer wheel.

```c
/* include/linux/jiffies.h */
extern unsigned long volatile jiffies;  /* wraps at ULONG_MAX */
extern u64 jiffies_64;                  /* 64-bit, no wraparound in practice */
```

`HZ` is the number of jiffies per second, configured at compile time:

| CONFIG_HZ | Tick period | Typical use |
|-----------|-------------|-------------|
| 100 | 10 ms | Servers, embedded (CONFIG_HZ_100) |
| 250 | 4 ms | Desktop default on many distros |
| 1000 | 1 ms | Low-latency desktops, real-time |

Conversion helpers:

```c
msecs_to_jiffies(500)       /* ms → jiffies; safe with HZ-independent code */
jiffies_to_msecs(jiffies)   /* jiffies → ms */
usecs_to_jiffies(100)       /* us → jiffies (rounds up) */
nsecs_to_jiffies(1000000UL) /* ns → jiffies */
```

Always use these helpers rather than computing `HZ * seconds` directly — the helpers handle rounding correctly and are portable across HZ configurations.

## struct timer_list

```c
/* include/linux/timer.h */
struct timer_list {
    struct hlist_node   entry;    /* linkage in the wheel bucket */
    unsigned long       expires;  /* absolute expiry in jiffies */
    void              (*function)(struct timer_list *); /* callback */
    u32                 flags;    /* encoded CPU affinity + TIMER_* flags */
};
```

Key fields:

- `expires` — absolute jiffies value when the timer should fire. Set via `add_timer()` or `mod_timer()`.
- `function` — called from softirq context (TIMER_SOFTIRQ) on the CPU the timer is pinned to. Must not sleep.
- `flags` — encodes the target CPU in the upper bits and timer flags in the lower bits.

Initializing a timer:

```c
struct timer_list my_timer;

/* Static init */
DEFINE_TIMER(my_timer, my_callback);

/* Dynamic init */
timer_setup(&my_timer, my_callback, 0);
```

`timer_setup()` replaced the older `init_timer()` + `setup_timer()` pattern (changed in Linux 4.15) — the callback now receives the `struct timer_list *` directly rather than an opaque `unsigned long` data argument.

## The public API

### add_timer()

```c
void add_timer(struct timer_list *timer);
```

Inserts a timer into the wheel. `timer->expires` must be set before calling. The timer fires no earlier than `expires` but may fire slightly later if the CPU is busy.

```c
timer_setup(&my_timer, my_callback, 0);
my_timer.expires = jiffies + msecs_to_jiffies(500);
add_timer(&my_timer);
```

### mod_timer()

```c
int mod_timer(struct timer_list *timer, unsigned long expires);
```

Changes the expiry of a pending timer atomically. If the timer is not pending, it is added. Returns 1 if the timer was pending, 0 if it was not. This is the preferred way to both add and modify a timer in one call.

### timer_reduce()

```c
int timer_reduce(struct timer_list *timer, unsigned long expires);
```

Like `mod_timer()` but only moves the expiry *earlier*. If the timer is already set to expire at or before `expires`, the call is a no-op. Added in Linux 4.20. This prevents a driver from accidentally delaying a timer that was already scheduled to fire sooner — useful when multiple code paths may arm the same timer.

### del_timer() vs del_timer_sync()

```c
int del_timer(struct timer_list *timer);
int del_timer_sync(struct timer_list *timer);
```

`del_timer()` removes the timer from the wheel. If the callback is currently running on another CPU, `del_timer()` returns immediately — the callback continues executing. This can cause use-after-free if you free data the callback touches immediately after `del_timer()`.

`del_timer_sync()` waits until the callback has finished on all CPUs before returning. Always use `del_timer_sync()` before freeing resources a timer callback accesses.

```c
/* Safe teardown */
del_timer_sync(&my_timer);
kfree(my_data);   /* safe: callback is done */
```

Since Linux 6.2, `timer_shutdown_sync()` marks the timer as permanently dead after stopping it, so any subsequent `add_timer()` or `mod_timer()` calls are silently ignored. Use this when a timer must never fire again (e.g., during driver removal).

## The hierarchical wheel (Linux 4.8+)

Linux 4.8 replaced the old five-level cascade wheel with a hierarchical wheel design (`kernel/time/timer.c`). The old design required expensive cascade operations when the wheel's hand advanced past a level boundary; the new design uses a simpler, more cache-friendly structure.

### struct timer_base

```c
/* kernel/time/timer.c (internal) */
struct timer_base {
    raw_spinlock_t      lock;
    struct timer_list  *running_timer;   /* callback executing now */
#ifdef CONFIG_PREEMPT_RT
    spinlock_t          expiry_lock;
    atomic_t            timer_waiters;
#endif
    unsigned long       clk;            /* last processed jiffies value */
    unsigned long       next_expiry;    /* earliest pending expiry */
    unsigned int        cpu;
    bool                next_expiry_recalc;
    bool                is_idle;
    bool                timers_pending;
    DECLARE_BITMAP(pending_map, WHEEL_SIZE);
    struct hlist_head   vectors[WHEEL_SIZE]; /* the buckets */
} ____cacheline_aligned;
```

On SMP systems with `CONFIG_NO_HZ_COMMON`, each CPU has three `timer_base` instances (`NR_BASES = 3`): `BASE_LOCAL` (for pinned timers), `BASE_GLOBAL` (for non-pinned / migratable timers), and `BASE_DEF` (for deferrable timers).

### Wheel geometry

The number of levels depends on the configured `HZ`:

- **HZ > 100** (e.g., HZ=250 or HZ=1000, the default for desktop/server kernels): `LVL_DEPTH = 9`, giving **9 × 64 = 576 buckets**.
- **HZ ≤ 100** (e.g., embedded/low-power kernels): `LVL_DEPTH = 8`, giving **8 × 64 = 512 buckets**.

The table below shows the geometry for HZ=250 (`LVL_DEPTH = 9`), each with 64 buckets (`LVL_SIZE = 64`):

| Level | Granularity | Range covered |
|-------|-------------|---------------|
| 0 | 1 jiffy | 0 – 63 jiffies |
| 1 | 8 jiffies | 64 – 511 jiffies |
| 2 | 64 jiffies | 512 – 4,095 jiffies |
| 3 | 512 jiffies | 4,096 – 32,767 jiffies |
| 4 | 4,096 jiffies | 32,768 – 262,143 jiffies |
| 5 | 32,768 jiffies | 262,144 – 2,097,151 jiffies |
| 6 | 262,144 jiffies | 2,097,152 – 16,777,215 jiffies |
| 7 | 2,097,152 jiffies | 16,777,216 – 134,217,727 jiffies |
| 8 | 16,777,216 jiffies | up to ~67,108 seconds at HZ=250 |

Each level is 8× coarser than the previous. When a timer is inserted, the kernel computes which level and bucket it belongs to based on the delta between now and `expires`. This is a pure bitmask operation — O(1) insert at any range.

Total wheel capacity: 576 buckets (9 × 64) for HZ=250. The `pending_map` bitmap lets the kernel quickly find the next non-empty bucket without scanning all entries.

### __run_timers()

```c
static void __run_timers(struct timer_base *base);
```

Called indirectly from `run_timer_softirq()` (the TIMER_SOFTIRQ handler) via the call chain `run_timer_softirq()` → `run_timer_base()` → `__run_timer_base()` → `__run_timers()` on each tick. It advances `base->clk` to the current jiffies value, identifies all buckets that have become due, and executes their callbacks. On SMP systems with `CONFIG_NO_HZ_COMMON`, `run_timer_softirq()` runs `BASE_LOCAL`, `BASE_GLOBAL`, and `BASE_DEF`, and invokes `tmigr_handle_remote()` when the timer migration hierarchy is active.

The softirq is raised by the tick interrupt handler. On a NOHZ (tickless) system, the tick may be skipped entirely when the CPU is idle, and `__run_timers()` catches up when the CPU wakes.

## Deferrable timers

```c
timer_setup(&my_timer, my_callback, TIMER_DEFERRABLE);
```

A deferrable timer is stored in `BASE_DEF` (the deferrable base). These timers expire only when the CPU is already running — they do not wake an idle CPU. If the CPU remains idle past the expiry time, the timer fires when the CPU next wakes for any reason.

Use deferrable timers for periodic maintenance work that is not time-critical (e.g., statistics gathering, buffer flushing). Using them reduces unnecessary wakeups and improves power efficiency on NOHZ systems.

## Relationship to workqueues

`schedule_delayed_work()` combines the timer wheel with the workqueue system:

```c
/* Internally: */
struct delayed_work {
    struct work_struct  work;
    struct timer_list   timer;  /* fires after the delay */
    /* ... */
};

schedule_delayed_work(&my_dwork, msecs_to_jiffies(100));
```

When the timer fires, its callback calls `queue_work()` to push `work` onto the system workqueue. The actual work runs in a workqueue thread (process context, can sleep) rather than in softirq context. Use `schedule_delayed_work()` when the deferred action needs to sleep or allocate memory — use a plain `timer_list` only when the callback is short and cannot sleep.

## Observing timers

There is no direct procfs interface for inspecting pending timer-wheel entries. Use kernel tracing instead:

```bash
# Trace __run_timers firings with ftrace
echo '__run_timers' > /sys/kernel/debug/tracing/set_ftrace_filter
echo function > /sys/kernel/debug/tracing/current_tracer
cat /sys/kernel/debug/tracing/trace_pipe

# Count timer callbacks by function with bpftrace
bpftrace -e '
  kprobe:call_timer_fn {
    @[ksym(arg1)] = count();
  }
  interval:s:5 { print(@); clear(@); exit(); }
'

# Show per-CPU timer softirq counts
grep TIMER /proc/softirqs

# High-level: see timer expiry latency distribution
perf stat -e irq:softirq_entry,irq:softirq_exit -a -- sleep 5
```

## Common pitfalls

### Jiffies wraparound

`jiffies` is an `unsigned long` and wraps at `ULONG_MAX`. On 32-bit kernels with HZ=1000 this happens every ~49 days. Never compare jiffies with raw `>` or `<`:

```c
/* WRONG: breaks at wraparound */
if (jiffies > my_timer.expires) { ... }

/* CORRECT: use the wraparound-safe macros */
if (time_after(jiffies, my_timer.expires)) { ... }
if (time_before(jiffies, deadline)) { ... }
if (time_after_eq(jiffies, start + HZ)) { ... }
```

`time_after(a, b)` is defined as shown below. The subtraction happens at `unsigned long` width first, then the result is cast to `long` — this is not the same as casting each operand individually:

```c
/* include/linux/jiffies.h */
/* The subtraction is done at unsigned long width; the result is cast to long */
#define time_after(a,b)     \
    (typecheck(unsigned long, a) && \
     typecheck(unsigned long, b) && \
     ((long)((b) - (a)) < 0))
```

This handles unsigned wraparound correctly by interpreting the result of the unsigned subtraction as a signed value.

### Sleeping in a timer callback

Timer callbacks run in softirq context. They must not sleep, call `schedule()`, or acquire any lock that could sleep (e.g., a mutex). Use `schedule_delayed_work()` if the deferred action needs to sleep.

## Further reading

### Kernel source

- [include/linux/timer.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/timer.h) — public `struct timer_list` API: `timer_setup()`, `add_timer()`, `mod_timer()`, `timer_reduce()`, `del_timer_sync()`, and `timer_shutdown_sync()`
- [include/linux/jiffies.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/jiffies.h) — `jiffies` counter, time conversion helpers (`msecs_to_jiffies()`), and wraparound-safe comparison macros (`time_after()`, `time_before()`)
- [kernel/time/timer.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/timer.c) — hierarchical timer wheel implementation, `__run_timers()`, level and bucket calculation, and softirq execution
- [kernel/time/timer_migration.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/timer_migration.c) — hierarchical timer pull migration (`tmigr_handle_remote()`) managing global timers across idle CPU clusters

### Man pages

- [`time(7)`](https://man7.org/linux/man-pages/man7/time.7.html) — overview of time concepts, jiffies, and kernel timer granularities

### Related pages

- [High-Resolution Timers (hrtimers)](hrtimers.md) — nanosecond-precision rbtree timers vs coarse timer wheel comparison
- [Clocksource and Clockevent Drivers](clocksource.md) — hardware tick generation and clockevent interrupt handling
- [Time Subsystem War Stories](war-stories.md) — real-world teardown use-after-free races and 32-bit jiffies overflow bugs
- [Workqueues: Concurrency-Managed Workqueues](../interrupts/workqueues.md) — `delayed_work` mechanisms combining timer wheels with process-context workqueues

### LWN articles

- [Reinventing the timer wheel](https://lwn.net/Articles/646014/) — Jonathan Corbet, June 2015: Thomas Gleixner's redesign replacing the cascade wheel with the non-cascading hierarchy
- [High-resolution timers and dynamic ticks](https://lwn.net/Articles/167897/) — Jonathan Corbet, January 2006: the interaction between the timer wheel and dyntick/NOHZ idle states

### External

- [Timekeeping and Timers in Linux](https://docs.kernel.org/core-api/timekeeping.html) — official kernel guide to timer systems and timekeeping
- [Timers Subsystem Documentation](https://docs.kernel.org/timers/index.html) — kernel documentation covering timer wheel internals, high-resolution timers, and NO_HZ operation
