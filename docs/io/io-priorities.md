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
/* kernel/sched/core.c */
int get_current_ioprio(void)
{
    struct io_context *ioc = current->io_context;

    if (ioc) {
        int ioprio = ioc->ioprio;

        if (ioprio != IOPRIO_DEFAULT)
            return ioprio;
    }
    /* Fall back to deriving from CPU nice */
    return IOPRIO_PRIO_VALUE(IOPRIO_CLASS_BE,
                             task_nice_ioclass(current));
}
```

If the process has an `io_context` with an explicit ioprio set via `ioprio_set()`, that value is used. Otherwise the ioprio is derived from the CPU nice value, keeping the two scheduling dimensions loosely coupled.

### bio->bi_ioprio assignment

```c
/* block/blk-core.c — bio inherits ioprio from the submitting kiocb */
void bio_set_ioprio(struct bio *bio)
{
    /* If the bio already has an explicit ioprio, keep it */
    if (bio->bi_ioprio)
        return;
    blkcg_set_ioprio(bio);  /* try cgroup-level ioprio first */
}

/* fs/iomap/direct-io.c — DIO path */
static void iomap_dio_submit_bio(const struct iomap_iter *iter,
                                  struct iomap_dio *dio,
                                  struct bio *bio)
{
    /* Copy ioprio from the originating kiocb into the bio */
    if (dio->iocb->ki_flags & IOCB_HIPRI)
        bio_set_polled(bio);
    bio->bi_ioprio = dio->iocb->ki_ioprio;
    submit_bio(bio);
}
```

For buffered writes the path is slightly different: the bio is created by the writeback path from a `struct writeback_control`, and the ioprio comes from the cgroup rather than the originating process.

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

The cgroup weight maps to a BE ioprio level via:

```c
/*
 * Map cgroup io.weight (1–10000) to IOPRIO_CLASS_BE level (0–7).
 * Higher weight → lower ioprio level number → more bandwidth from BFQ.
 */
static int blkcg_weight_to_ioprio(int weight)
{
    return IOPRIO_BE_NR - DIV_ROUND_CLOSEST(
        weight * IOPRIO_BE_NR,
        IOPRIO_WEIGHT_MAX);
}
```

A cgroup with `io.weight 100` (default) maps to BE level 4. A cgroup with `io.weight 1000` maps to BE level 0 (most bandwidth).

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
    struct bfq_data     *bfqd;          /* owning scheduler */
    struct rb_root       sort_list;     /* requests sorted by sector */
    struct request      *next_rq;       /* next request to dispatch */
    int                  ioprio;        /* ioprio class + level */
    int                  ioprio_class;  /* IOPRIO_CLASS_* */
    u32                  max_budget;    /* sectors to serve this round */
    u32                  budget_timeout;
    /* ... */
};
```

Each `bfq_queue` is assigned a budget (in sectors) proportional to its weight. When the budget is exhausted, BFQ moves to the next queue.

### Budget allocation and weight

```
weight → max_budget:

  bfqq->max_budget = BFQ_DEFAULT_MAX_BUDGET
                   × (bfqq->weight / BFQ_DEFAULT_WEIGHT)

  default weight = 100
  BE level 0 → weight 320
  BE level 4 → weight 100 (default)
  BE level 7 → weight  10
```

A process at BE level 0 therefore gets roughly 32× the budget of one at BE level 7.

### Priority class ordering

BFQ enforces a strict class hierarchy: RT before BE before IDLE.

```c
/* block/bfq-iosched.c */
static struct bfq_queue *bfq_select_queue(struct bfq_data *bfqd)
{
    /* First: any RT queue with pending requests */
    bfqq = bfq_get_next_queue(bfqd, IOPRIO_CLASS_RT);
    if (bfqq)
        return bfqq;

    /* Then: BE queues in weighted-fair order */
    bfqq = bfq_get_next_queue(bfqd, IOPRIO_CLASS_BE);
    if (bfqq)
        return bfqq;

    /* Finally: IDLE queues only when nothing else is pending */
    return bfq_get_next_queue(bfqd, IOPRIO_CLASS_IDLE);
}
```

### Soft real-time detection

BFQ heuristically detects **interactive** applications (web browsers, text editors) by observing short think times between bursts of I/O. These are temporarily boosted to near-RT priority even if they are in BE class. This is the "soft real-time" promotion:

```c
/* bfq detects soft-RT if:
 *   - queue has short bursts (small budget used)
 *   - followed by idle periods (think time > threshold)
 *
 * Boosted queues skip ahead of ordinary BE queues.
 */
static bool bfq_bfqq_is_soft_rt(struct bfq_queue *bfqq)
{
    return bfqq->wr_coeff > 1 &&
           bfq_bfqq_in_large_burst(bfqq) == false;
}
```

### Seeky detection

BFQ tracks whether a queue submits **sequential** or **random** (seeky) I/O. Random-access queues get a smaller budget to prevent them from monopolising the disk's seek time:

```c
/* A queue is considered seeky if its average seek distance
 * exceeds BFQ_BFQQ_MAX_SEQ_SECTORS.
 * Seeky queues get max_budget reduced proportionally. */
if (BFQQ_SEEKY(bfqq))
    bfqq->max_budget >>= BFQ_SEEKY_BUDGET_SHIFT;
```

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

struct deadline_data {
    /* Sorted by sector (for merging) */
    struct rb_root       sort_list[DD_DIR_COUNT][DD_PRIO_MAX + 1];
    /* Sorted by deadline (for anti-starvation) */
    struct list_head     fifo_list[DD_DIR_COUNT][DD_PRIO_MAX + 1];
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

`io.latency` helps indirectly: if priority inversion causes a high-priority cgroup's latency to spike, BFQ will boost that cgroup's weight in subsequent rounds, partially recovering from the inversion. This is a recovery mechanism, not prevention.

---

## Kernel data structures summary

```
task_struct
  └── ioprio (u16)            ← set by ioprio_set(), read by get_current_ioprio()

struct kiocb
  └── ki_ioprio (u16)         ← copied from task_struct at I/O submission

struct bio
  └── bi_ioprio (u16)         ← copied from kiocb; carries priority to block layer

struct request
  └── ioprio (u16)            ← copied from bio; seen by the scheduler

struct bfq_queue
  └── ioprio                  ← derived from request->ioprio on queue creation
  └── ioprio_class            ← RT / BE / IDLE
  └── max_budget              ← sectors per round, proportional to weight(ioprio)
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
- [struct kiocb](kiocb.md) — ki_ioprio and how it propagates through the I/O stack
- [Direct I/O](direct-io.md) — O_DIRECT path where ioprio most reliably reaches the scheduler
- [Async I/O](async-io.md) — io_uring interaction with BFQ's per-process model
- [cgroups I/O](../cgroups/io-cgroup.md) — io.weight, io.max, io.latency reference
- [Observability](observability.md) — blktrace, ftrace, iostat for verifying priority enforcement
