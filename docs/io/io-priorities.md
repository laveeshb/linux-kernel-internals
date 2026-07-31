# I/O Priorities

> `ioprio_set()`, priority classes, cgroup I/O weight, and how the block scheduler uses priorities

## What I/O priority means

CPU scheduling has hard preemption: a higher-priority task can evict a lower-priority task from the CPU mid-instruction. I/O priority is weaker — it is **advisory**. The block scheduler tries to honor it but makes no hard guarantees except for the RT class on BFQ.

Priority affects:

- **Order of request dispatch** from the scheduler queue — RT requests go before BE, BE before IDLE
- **Bandwidth allocation** — BFQ allocates I/O bandwidth proportional to per-process weight, which is derived from ioprio
- **Latency targets** — BFQ's latency mode boosts cgroups whose actual latency exceeds a configured target

What priority does *not* affect:

- The `none` scheduler ignores ioprio entirely (no scheduler, no priority enforcement)
- `mq-deadline` uses ioprio only for ordering, not bandwidth
- Page cache writeback is not bound to any process's ioprio (writeback runs as a kernel thread)

---

## ioprio_set() and ioprio_get()

There is no glibc wrapper; these are raw syscalls.

```c
#include <linux/ioprio.h>
#include <sys/syscall.h>

/* Set I/O priority for the calling process */
int ret = syscall(SYS_ioprio_set,
                  IOPRIO_WHO_PROCESS,   /* target: process */
                  0,                    /* 0 = current process */
                  IOPRIO_PRIO_VALUE(IOPRIO_CLASS_BE, 0));

/* Get I/O priority for a specific PID */
int prio = syscall(SYS_ioprio_get, IOPRIO_WHO_PROCESS, pid);
int class = IOPRIO_PRIO_CLASS(prio);   /* extract class */
int level = IOPRIO_PRIO_DATA(prio);    /* extract level */
```

### Target selectors

| Constant | Meaning |
|---|---|
| `IOPRIO_WHO_PROCESS` | A single process (or thread) by PID |
| `IOPRIO_WHO_PGRP` | All processes in a process group |
| `IOPRIO_WHO_USER` | All processes owned by a UID |

### Priority classes

```c
/* include/uapi/linux/ioprio.h */
#define IOPRIO_CLASS_NONE  0   /* inherit from CPU nice */
#define IOPRIO_CLASS_RT    1   /* real-time: served first */
#define IOPRIO_CLASS_BE    2   /* best-effort: default */
#define IOPRIO_CLASS_IDLE  3   /* idle: only when nothing else is pending */
```

### Building a priority value

```c
/* Encode class and level into a single u16 */
#define IOPRIO_PRIO_VALUE(class, data) \
    (((class) << IOPRIO_CLASS_SHIFT) | (data))

/* Examples */
IOPRIO_PRIO_VALUE(IOPRIO_CLASS_RT,   0)  /* RT, highest level */
IOPRIO_PRIO_VALUE(IOPRIO_CLASS_BE,   4)  /* BE, level 4 — default */
IOPRIO_PRIO_VALUE(IOPRIO_CLASS_IDLE, 0)  /* IDLE (level ignored) */
```

Priority levels within RT and BE run from **0 (highest) to 7 (lowest)**. The IDLE class has no meaningful level.

### The ionice command

`ionice` is the userspace wrapper around these syscalls:

```bash
# Check current I/O priority for a PID
ionice -p 1234

# Set BE class, level 0 (highest BE) for a running process
ionice -c 2 -n 0 -p $(pgrep postgres)

# Launch a process as IDLE class
ionice -c 3 rsync -av /data /backup

# Launch a process with RT class, level 0 (requires CAP_SYS_ADMIN)
ionice -c 1 -n 0 bash -c 'exec ./latency-critical-job'

# Set ioprio for all processes in a shell subtree
ionice -c 2 -n 0 bash -c 'exec your-critical-job'
```

---

## Priority classes in detail

### RT (Real-time)

RT is the highest priority class. The block scheduler (BFQ or mq-deadline) dispatches RT requests before any BE or IDLE request in the same queue.

- **Levels**: 0–7, where 0 is highest within RT
- **Requires `CAP_SYS_ADMIN`** — unprivileged processes cannot set RT class
- **Risk**: RT can starve lower-priority I/O completely if the RT process submits continuously
- **Typical uses**: real-time audio playback, industrial control systems, storage I/O for VMs that require bounded latency

```bash
# Grant a process RT I/O — must be run as root or with CAP_SYS_ADMIN
ionice -c 1 -n 0 -p $(pgrep jackd)
```

Under BFQ, RT queues are served in a separate budget round before any BE queue gets a turn. Under mq-deadline, RT requests are placed on a high-priority FIFO that is drained before BE and IDLE FIFOs.

### BE (Best-effort)

BE is the default class for every process. If no explicit `ioprio_set()` has been called, the process is in `IOPRIO_CLASS_BE` with a level derived from its CPU nice value:

```
ioprio_level = (cpu_nice + 20) / 5
```

So `nice 0` → BE level 4 (the midpoint), `nice -20` → BE level 0, `nice 19` → BE level 7.

- **Levels**: 0–7 (0 = most I/O bandwidth, 7 = least)
- BFQ allocates bandwidth proportionally: a process at level 0 gets more sectors per round than one at level 7
- CFQ (removed in Linux 5.0) ordered BE processes strictly within the class; BFQ uses a weighted fair queue

### IDLE

IDLE class processes are served only when no RT or BE I/O is pending. This makes them ideal for background workloads that should not compete with foreground I/O at all.

```bash
# Background backup — will not slow down anything else
ionice -c 3 nice -n 19 rsync -av /data /backup

# Filesystem scrub as a background task
ionice -c 3 btrfs scrub start /

# Combine ionice -c 3 with CPU nice for truly background work
ionice -c 3 nice -n 19 find / -name '*.log' -mtime +30 -delete
```

The IDLE class is implemented in BFQ by checking whether any RT or BE `bfq_queue` has pending requests before dispatching from an IDLE queue.

---

## How priority flows through the kernel

A priority set with `ioprio_set()` must travel from `task_struct` all the way to the block scheduler. Here is the full path:

```
ioprio_set() syscall
  → stored in task_struct->ioprio

write() / read() syscall entry
  → init_sync_kiocb() / init_kiocb()
  → kiocb.ki_ioprio = get_current_ioprio()

bio submission (submit_bio / iomap_dio_rw)
  → bio->bi_ioprio = kiocb->ki_ioprio

blk-mq request allocation (blk_mq_get_request)
  → rq->ioprio = bio->bi_ioprio

Scheduler (BFQ) enqueue
  → bfq_queue->ioprio from rq->ioprio
  → RT queues served before BE before IDLE
  → weight within BE class derived from ioprio level
```

### get_current_ioprio()

```c
/* include/linux/ioprio.h */
static inline int get_current_ioprio(void)
{
    return __get_task_ioprio(current);
}

static inline int __get_task_ioprio(struct task_struct *p)
{
    struct io_context *ioc = p->io_context;
    int prio;

    if (!ioc)   /* no io_context: derive class + level from CPU nice */
        return IOPRIO_PRIO_VALUE(task_nice_ioclass(p), task_nice_ioprio(p));

    prio = ioc->ioprio;
    if (IOPRIO_PRIO_CLASS(prio) == IOPRIO_CLASS_NONE)  /* class NONE: use nice */
        prio = IOPRIO_PRIO_VALUE(task_nice_ioclass(p), task_nice_ioprio(p));
    return prio;
}
```

If the process has an `io_context` with an explicit ioprio set via `ioprio_set()`, that value is used. Otherwise the ioprio is derived from the CPU nice value, keeping the two scheduling dimensions loosely coupled.

### bio->bi_ioprio assignment

```c
/* block/blk-core.c — a bio inherits ioprio from the submitting task */
static void bio_set_ioprio(struct bio *bio)
{
    /* Nobody set ioprio yet? Initialize from the task's (nice-derived) ioprio */
    if (IOPRIO_PRIO_CLASS(bio->bi_ioprio) == IOPRIO_CLASS_NONE)
        bio->bi_ioprio = get_current_ioprio();
    blkcg_set_ioprio(bio);   /* then apply any cgroup I/O-priority policy */
}
```

For direct I/O the bio carries the originating kiocb's `ki_ioprio` (copied when the DIO bio is built in `fs/iomap/direct-io.c`); for buffered writes the bio is created later by the writeback path, so its ioprio comes from the cgroup/writeback context rather than the originating process.

---

## cgroup v2 I/O weight

With **cgroup v2**, I/O priorities are administered per-cgroup rather than per-process. The cgroup hierarchy overrides or supplements individual `task_struct->ioprio` values.

### io.weight

```bash
# Set I/O weight for a cgroup (range 1–10000, default 100)
echo "100" > /sys/fs/cgroup/myapp/io.weight

# Per-device weight override (major:minor weight)
echo "8:16 200" > /sys/fs/cgroup/myapp/io.weight

# Read current weights
cat /sys/fs/cgroup/myapp/io.weight
# default 100
# 8:16 200

# Set weight for a cgroup relative to its siblings
# A cgroup with weight 200 gets twice the I/O bandwidth of one with weight 100
echo "200" > /sys/fs/cgroup/highprio/io.weight
echo "50"  > /sys/fs/cgroup/background/io.weight
```

`io.weight` is **not** translated into a per-task ioprio level — it is a separate, proportional mechanism. The value (1–10000, default 100) is consumed directly by the block I/O controller (BFQ, or the `blk-iocost` cost model that backs `io.weight` on other schedulers) to divide device bandwidth among sibling cgroups in proportion to their weights: a cgroup with weight 200 gets roughly twice the share of one with weight 100. Per-task `ioprio` (via `ionice`) and per-cgroup `io.weight` are independent knobs — the former orders requests within BFQ's priority classes, the latter partitions bandwidth between cgroups.

### io.bfq.weight

BFQ exposes its own weight interface directly:

```bash
# BFQ weight: 1–1000 (default 100)
echo "500" > /sys/fs/cgroup/myapp/io.bfq.weight

# Per-device BFQ weight
echo "8:16 500" > /sys/fs/cgroup/myapp/io.bfq.weight

# Read current BFQ weights
cat /sys/fs/cgroup/myapp/io.bfq.weight
# default 100
# 8:16 500
```

`io.bfq.weight` maps directly into BFQ's internal weight without the intermediate conversion that `io.weight` applies.

### Moving a process into a cgroup

```bash
# Create a cgroup
mkdir /sys/fs/cgroup/background

# Set low I/O weight
echo "10" > /sys/fs/cgroup/background/io.weight

# Move a process into it
echo $PID > /sys/fs/cgroup/background/cgroup.procs

# Everything the process submits now uses the cgroup's weight
```

---

## io.latency: latency targeting

`io.latency` lets a cgroup declare a target I/O latency. BFQ monitors whether the cgroup meets its target and boosts its weight temporarily when latency exceeds the threshold.

```bash
# Set a 10ms read latency target for device 8:16
echo "8:16 10000" > /sys/fs/cgroup/critical/io.latency

# Read current latency targets
cat /sys/fs/cgroup/critical/io.latency
# 8:16 10000

# Multiple devices
echo "8:0 5000"  > /sys/fs/cgroup/db/io.latency   # 5ms for sda
echo "8:16 5000" >> /sys/fs/cgroup/db/io.latency  # 5ms for sdb
```

The latency is specified in **microseconds**.

### How io.latency works with BFQ

```
Cgroup submits I/O request
  → BFQ records submission timestamp

I/O completes
  → BFQ computes actual latency
  → compares to io.latency target

If actual > target:
  → blkcg_iolatency_throttle() temporarily boosts cgroup weight
  → competing cgroups are throttled until latency recovers

If actual <= target consistently:
  → weight returns to nominal io.weight value
```

This is especially useful for databases sharing storage with bulk background workloads:

```bash
# Database cgroup: low latency target
mkdir /sys/fs/cgroup/db
echo "100" > /sys/fs/cgroup/db/io.weight
echo "8:0 5000" > /sys/fs/cgroup/db/io.latency  # 5ms target

# Backup cgroup: no latency target, low weight
mkdir /sys/fs/cgroup/backup
echo "10" > /sys/fs/cgroup/backup/io.weight

# Move processes
echo $DB_PID     > /sys/fs/cgroup/db/cgroup.procs
echo $BACKUP_PID > /sys/fs/cgroup/backup/cgroup.procs
```

Now if the backup causes database latency to spike above 5ms, BFQ will throttle the backup cgroup until the database is back within target.

---

## BFQ: Budget Fair Queueing

BFQ is the scheduler that most fully honors ioprio and cgroup I/O weights. It is the default on many desktop and general-purpose Linux systems.

```bash
# Check if BFQ is active
cat /sys/block/sda/queue/scheduler
# [bfq] mq-deadline none

# Enable BFQ
echo bfq > /sys/block/sda/queue/scheduler
```

### Per-process queues

BFQ maintains a `bfq_queue` for each process (or cgroup entity):

```c
/* block/bfq-iosched.h */
struct bfq_queue {
    struct bfq_data     *bfqd;           /* owning scheduler */
    struct rb_root       sort_list;      /* requests sorted by sector */
    struct request      *next_rq;        /* next request to dispatch */
    unsigned short       ioprio;         /* ioprio level */
    unsigned short       ioprio_class;   /* IOPRIO_CLASS_* */
    int                  max_budget;     /* sectors to serve this round */
    unsigned long        budget_timeout;
    /* ... */
};
```

Each `bfq_queue` is served for at most `max_budget` sectors per activation; when the budget is exhausted (or times out), BFQ moves on to the next queue. `max_budget` itself is auto-tuned by BFQ (starting from `bfq_default_max_budget`, 16K sectors) — it is *not* derived from the ioprio level. What the ioprio level controls is the queue's **weight**, which sets its share of disk time in BFQ's proportional-share (WF2Q+) scheduler.

### From ioprio level to weight

```
weight ← ioprio level  (block/bfq-wf2q.c):

  weight = (IOPRIO_NR_LEVELS − level) × BFQ_WEIGHT_CONVERSION_COEFF
         = (8 − level) × 10

  BE level 0 → weight 80
  BE level 4 → weight 40   ← default ioprio
  BE level 7 → weight 10
```

A process at BE level 0 therefore carries 8× the weight of one at BE level 7 (80 vs 10), and receives a correspondingly larger share of the device.

### Priority class ordering

BFQ enforces a strict class hierarchy: RT before BE before IDLE. This ordering is not a simple `if` ladder — it falls out of BFQ's hierarchical scheduler. `bfq_select_queue()` (in `block/bfq-iosched.c`) picks the next queue to serve by walking BFQ's service-tree hierarchy via `bfq_get_next_queue()`, and that hierarchy is ordered by class: an RT queue with pending I/O is always chosen before any BE queue, and BE queues before IDLE. Within the BE class, queues are served in weighted-fair order according to their per-queue weights (derived from the ioprio level).

### Soft real-time detection

BFQ heuristically detects **interactive** applications (web browsers, text editors) by observing short bursts of I/O separated by idle periods (think time above a threshold). Such queues are temporarily boosted even while in the BE class — the "soft real-time" promotion. Internally this is implemented as **weight raising**: BFQ multiplies the queue's weight by a coefficient (`bfqq->wr_coeff > 1`) for a bounded interval, so a boosted queue is scheduled ahead of ordinary BE queues. Queues flagged as part of a "large burst" of process creation (`bfq_bfqq_in_large_burst()`) are excluded, since a storm of short-lived processes is not the interactive pattern the heuristic targets.

### Seeky detection

BFQ tracks whether a queue submits **sequential** or **random** (seeky) I/O, classifying a queue as seeky via the `BFQQ_SEEKY()` macro when its average seek distance is large. Seeky queues are budgeted differently: because random I/O cannot make good use of a long, uninterrupted service slot, BFQ caps their budget so a seeky queue cannot hold the device while doing little useful work. This protects sequential workloads — which benefit from sustained access — from being starved by a random-access queue.

### io_uring and BFQ

io_uring can confuse BFQ's per-process model when application-level queuing is used. With SQPOLL or fixed files, multiple processes may submit I/O through a single io_uring context. BFQ sees a single queue rather than per-process queues, potentially undermining per-process weight differentiation. For cgroup-based isolation, `io.weight` is more reliable than per-process ioprio when io_uring is in use.

---

## mq-deadline: simpler priority support

`mq-deadline` is the default scheduler for NVMe and SCSI devices on many systems. Its priority support is simpler than BFQ's — ordering only, no bandwidth proportioning.

```bash
# Check if mq-deadline is active
cat /sys/block/nvme0n1/queue/scheduler
# [mq-deadline] none bfq
```

### How mq-deadline handles ioprio

mq-deadline maintains separate FIFO queues per priority class:

```c
/* block/mq-deadline.c */
enum dd_prio {
    DD_RT_PRIO   = 0,   /* IOPRIO_CLASS_RT */
    DD_BE_PRIO   = 1,   /* IOPRIO_CLASS_BE */
    DD_IDLE_PRIO = 2,   /* IOPRIO_CLASS_IDLE */
    DD_PRIO_MAX  = 2,
};

/* One set of queues per priority class (DD_DIR_COUNT = 2: read, write) */
struct dd_per_prio {
    struct rb_root       sort_list[DD_DIR_COUNT];  /* sorted by sector (merging) */
    struct list_head     fifo_list[DD_DIR_COUNT];  /* sorted by deadline (anti-starvation) */
    /* ... */
};

struct deadline_data {
    struct dd_per_prio   per_prio[DD_PRIO_COUNT];  /* RT, BE, IDLE (DD_PRIO_COUNT = 3) */
    /* ... */
};
```

Dispatch order:
1. RT read / RT write requests (by deadline then sector)
2. BE read / BE write requests
3. IDLE requests — only when RT and BE FIFOs are empty

Within a class, mq-deadline dispatches by **deadline** (anti-starvation timer) then **sector order** (reduce seeks). It does **not** differentiate levels within a class — BE level 0 and BE level 7 are treated identically by mq-deadline.

```bash
# Tuning mq-deadline priorities
cat /sys/block/sda/queue/iosched/read_expire   # default 500ms
cat /sys/block/sda/queue/iosched/write_expire  # default 5000ms
cat /sys/block/sda/queue/iosched/prio_aging_expire  # ms before low-prio ages up
```

---

## ionice in practice

### Background maintenance jobs

```bash
# Filesystem backup — IDLE class, no impact on foreground I/O
ionice -c 3 rsync -av --progress /data /backup/

# Combine with CPU deprioritisation
ionice -c 3 nice -n 19 tar -czf /backup/archive.tar.gz /var/lib/pgsql/

# btrfs balance — can be very I/O intensive
ionice -c 3 btrfs balance start -dusage=50 /

# Find and process large files without disturbing production
ionice -c 3 find /var/log -name '*.log' -size +100M -exec gzip {} \;
```

### Interactive and database I/O

```bash
# High-priority database backup (needs CAP_SYS_ADMIN for RT)
ionice -c 1 -n 0 pg_basebackup -D /backup/pgbase

# Improve I/O for a running database (BE class, level 0)
ionice -c 2 -n 0 -p $(pgrep -x postgres | head -1)

# Check what ionice class a process is currently using
ionice -p $(pgrep mysqld)
# best-effort: prio 4
```

### Adjusting a running process

```bash
# Lower a running process's I/O priority without restarting it
PID=$(pgrep -x bacula-fd)
ionice -c 3 -p $PID        # demote to IDLE
ionice -p $PID             # verify

# Raise I/O priority for a stuck backup that is taking too long
ionice -c 2 -n 0 -p $BACKUP_PID
```

### Scripting with ioprio_set directly

```c
#include <sys/syscall.h>
#include <linux/ioprio.h>
#include <unistd.h>
#include <stdio.h>

int main(void)
{
    /* Set this process to IDLE class before doing background work */
    int ret = syscall(SYS_ioprio_set,
                      IOPRIO_WHO_PROCESS,
                      0,
                      IOPRIO_PRIO_VALUE(IOPRIO_CLASS_IDLE, 0));
    if (ret < 0) {
        perror("ioprio_set");
        return 1;
    }

    /* All I/O from here on is IDLE class */
    do_background_scan();
    return 0;
}
```

---

## Priority inversion

A subtle hazard in the I/O stack: a high-priority process can be blocked waiting for a low-priority process to release a resource.

### Page lock contention

```
High-priority process:   wants to read page at offset X
  → page is locked (PG_locked set)
  → waits on page lock

Low-priority process:    holds PG_locked (doing writeback or readahead)
  → scheduled less frequently by I/O scheduler
  → high-priority process is effectively at low-priority
```

This is a form of priority inversion in the page cache layer. The I/O scheduler cannot help because the high-priority process is not blocked *at the scheduler* — it is blocked on a page lock above the scheduler.

### inode and filesystem locks

Similarly, if a low-priority process holds `inode->i_rwsem` during a truncate or write, a high-priority process wanting to read the same file will block for the duration, regardless of its ioprio.

### Partial mitigation: IOCB_NOWAIT

`IOCB_NOWAIT` tells the filesystem and block layer to return `-EAGAIN` rather than blocking if any lock or resource is not immediately available:

```c
/* High-priority code that cannot afford to wait */
kiocb->ki_flags |= IOCB_NOWAIT;
ret = file->f_op->read_iter(kiocb, &iter);
if (ret == -EAGAIN) {
    /* Resource temporarily unavailable — handle or retry later */
    schedule_retry();
}
```

io_uring uses `IOCB_NOWAIT` by default for all non-blocking operations, falling back to a worker thread only when `-EAGAIN` is returned. This avoids priority inversion at the cost of a worker thread for the slow path.

### cgroup io.latency as a compensating mechanism

`io.latency` can help indirectly. It is implemented by the **blk-iolatency** controller (independent of BFQ): you set a target latency for a protected cgroup, and when that cgroup's observed latency exceeds the target, the controller throttles the *competing* cgroups — reducing their allowed I/O depth — until the protected cgroup recovers. It cannot undo a lock-based inversion, but by squeezing lower-priority I/O it keeps a latency-sensitive cgroup's delays bounded. This is a containment mechanism, not prevention.

---

## Kernel data structures summary

```
task_struct
  └── io_context->ioprio (u16) ← set by ioprio_set(), read by get_current_ioprio()

struct kiocb
  └── ki_ioprio (u16)         ← copied from the task's ioprio at I/O submission

struct bio
  └── bi_ioprio (u16)         ← copied from kiocb; carries priority to block layer

struct request
  └── ioprio (u16)            ← copied from bio; seen by the scheduler

struct bfq_queue
  └── ioprio                  ← derived from request->ioprio on queue creation
  └── ioprio_class            ← RT / BE / IDLE
  └── weight                  ← (8 − level) × 10; sets share of disk time
  └── max_budget              ← sectors per round (auto-tuned, not weight-derived)
```

---

## Choosing the right mechanism

| Scenario | Recommended approach |
|---|---|
| Single background process | `ionice -c 3` (IDLE class) |
| Multiple competing applications | cgroup v2 `io.weight` |
| Database with latency SLA | cgroup v2 `io.latency` |
| Real-time audio / hardware control | `ionice -c 1 -n 0` (RT, needs root) |
| Cloud VM storage isolation | cgroup v2 `io.weight` per container |
| NVMe workload | BFQ or mq-deadline; consider `none` for pure throughput |
| io_uring-heavy application | cgroup `io.weight` rather than per-process ioprio |

---

## Observing I/O priorities in action

```bash
# See ioprio for all threads of a process
for tid in /proc/$(pgrep postgres)/task/*/; do
    pid=$(basename $tid)
    echo -n "tid $pid: "
    ionice -p $pid
done

# BFQ queue stats per device
cat /sys/block/sda/queue/iosched/stats

# blktrace: see ioprio in the I/O trace
blktrace -d /dev/sda -o - | blkparse -i - | grep 'prio'

# ftrace: trace BFQ dispatch decisions
echo 1 > /sys/kernel/debug/tracing/events/block/block_rq_issue/enable
cat /sys/kernel/debug/tracing/trace_pipe | grep -E 'prio|ioprio'

# Verify cgroup I/O weight is being applied
cat /sys/fs/cgroup/myapp/io.stat  # BFQ per-cgroup statistics
```

---

## Key source files

| File | Contents |
|---|---|
| `include/uapi/linux/ioprio.h` | `IOPRIO_CLASS_*` constants, `IOPRIO_PRIO_VALUE()`, `IOPRIO_PRIO_CLASS()` macros |
| `fs/ioprio.c` | `ioprio_set()` / `ioprio_get()` syscall implementation |
| `kernel/sched/core.c` | `get_current_ioprio()` — reads from `io_context` or derives from nice |
| `block/bfq-iosched.c` | BFQ scheduler: per-queue budget, weight, RT/BE/IDLE class dispatch |
| `block/bfq-iosched.h` | `struct bfq_queue`, `struct bfq_data` definitions |
| `block/mq-deadline.c` | mq-deadline: per-class FIFO queues and deadline dispatch |
| `block/blk-ioprio.c` | cgroup I/O priority integration — maps `io.weight` to ioprio |
| `block/blk-cgroup.c` | cgroup blkio core — `blkcg_get_queue()`, weight inheritance |

---

## Further reading

- [I/O Schedulers](../block/io-schedulers.md) — BFQ, mq-deadline, none, Kyber
- [blk-mq](../block/blk-mq.md) — multi-queue block layer, request lifecycle
- [Direct I/O](direct-io.md) — O_DIRECT path where ioprio most reliably reaches the scheduler
- [Async I/O](async-io.md) — io_uring interaction with BFQ's per-process model
- [cgroups I/O](../cgroups/io-cgroup.md) — io.weight, io.max, io.latency reference
- [Observability](observability.md) — blktrace, ftrace, iostat for verifying priority enforcement
