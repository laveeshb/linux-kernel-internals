# io Cgroup Controller

> Block I/O bandwidth throttling, weight-based scheduling, and latency SLAs

## Overview

The cgroup v2 `io` controller manages block I/O resources for processes. It provides:
- **io.max**: hard rate limits (bytes/sec, IOPS)
- **io.weight**: proportional share scheduling (WFQ)
- **io.latency**: latency SLA enforcement (evict excess I/O to protect latency) [(commit)](https://git.kernel.org/linus/d70675121546c35feaceebf7ed9caed8716640f3) [(LWN)](https://lwn.net/Articles/758963/)

```bash
# Enable the io controller on a cgroup:
echo "+io" > /sys/fs/cgroup/mycgroup/cgroup.subtree_control

# Check supported features:
cat /sys/block/sda/queue/scheduler
# [mq-deadline] kyber bfq none
# BFQ supports io.weight proportional scheduling
# mq-deadline supports io.latency
```

## io.max: Hard rate limits

```bash
# Format: MAJ:MIN rbps=N wbps=N riops=N wiops=N
echo "8:0 rbps=52428800" > /sys/fs/cgroup/mycgroup/io.max  # 50MB/s read
echo "8:0 wbps=26214400" > /sys/fs/cgroup/mycgroup/io.max  # 25MB/s write
echo "8:0 riops=1000"    > /sys/fs/cgroup/mycgroup/io.max  # 1000 read IOPS
echo "8:0 wiops=500"     > /sys/fs/cgroup/mycgroup/io.max  # 500 write IOPS

# Multiple limits at once:
echo "8:0 rbps=52428800 wbps=26214400 riops=1000 wiops=500" \
    > /sys/fs/cgroup/mycgroup/io.max

# Remove a limit:
echo "8:0 rbps=max wbps=max riops=max wiops=max" \
    > /sys/fs/cgroup/mycgroup/io.max

# Read current limits:
cat /sys/fs/cgroup/mycgroup/io.max
# 8:0 rbps=52428800 wbps=26214400 riops=1000 wiops=500
```

### Kernel implementation

```c
/* block/blk-throttle.c */
/* When a bio is submitted, blk-throttle checks if the cgroup is over limit: */
static bool throtl_tg_is_idle(struct throtl_grp *tg)
{
    /* Check both bytes and IOPS limits */
    return (tg->bytes_disp[READ] + tg->bytes_disp[WRITE]) == 0;
}

static void tg_dispatch_one_bio(struct throtl_grp *tg, bool rw)
{
    struct throtl_data *td = tg->td;
    struct bio *bio;

    /* Check if we're within limits */
    if (tg_bps_limit(tg, rw)) {
        /* Rate-limit: delay bio dispatch */
        tg->disptime = jiffies + tg->slice_remaining[rw];
        throtl_schedule_pending_timer(tg->service_queue, tg->disptime);
        return;
    }
    /* Dispatch normally */
    bio_list_pop(&tg->service_queue->bio_lists[rw]);
    throtl_dispatch_bio(td, tg, bio);
}
```

## io.weight: Proportional scheduling

Requires BFQ I/O scheduler (Kyber does not support weight; mq-deadline and none are also unsupported):

```bash
# Set weight (1-10000, default 100):
echo "default 200" > /sys/fs/cgroup/high-prio/io.weight  # 2x default
echo "default 50"  > /sys/fs/cgroup/low-prio/io.weight   # 0.5x default

# Per-device weight:
echo "8:0 200" > /sys/fs/cgroup/high-prio/io.weight  # only for /dev/sda
echo "default 100" >> /sys/fs/cgroup/high-prio/io.weight  # others default

# Under BFQ: io.weight implements WFQ (Weighted Fair Queuing)
# high-prio gets 200/(200+50+100) = 57% of bandwidth
# low-prio gets 50/(200+50+100) = 14% of bandwidth
# normal gets 100/(200+50+100) = 29% of bandwidth
```

### BFQ weight-based scheduling

BFQ (Budget Fair Queuing) is a proportional-share I/O scheduler that implements weight-based fairness:

```c
/* block/bfq-iosched.c */
struct bfq_group {
    struct bfq_entity entity;  /* scheduling entity */
    struct bfq_sched_data sched_data;  /* active/idle queues */
    /* ... */
};

/* Weight is set via cgroup io.weight: */
static void bfq_pd_init(struct blkg_policy_data *pd)
{
    struct bfq_group *bfqg = blkg_to_bfqg(pd->blkg);
    bfqg->entity.weight = pd->cgroup_weight; /* from io.weight */
    bfqg->entity.new_weight = bfqg->entity.weight;
}
```

## io.latency: Latency SLA

`io.latency` provides latency-based I/O protection. Introduced in Linux 4.19 by Josef Bacik [(commit)](https://git.kernel.org/linus/d70675121546c35feaceebf7ed9caed8716640f3) [(LWN)](https://lwn.net/Articles/758963/). When a cgroup's latency exceeds the target, the controller throttles competing cgroups:

```bash
# Set target latency for a cgroup:
echo "8:0 target=10ms" > /sys/fs/cgroup/important/io.latency

# The kernel monitors latency for this cgroup.
# If p99 latency exceeds 10ms, throttle competing cgroups.

# io.latency is an SLA, not a hard limit:
# - The protected cgroup's I/O is prioritized
# - Competing cgroups are throttled even if they have io.max budget

# Check if throttling is happening:
cat /sys/fs/cgroup/important/io.stat
# 8:0 rbytes=... wbytes=... rios=... wios=... dbytes=... dios=...
# rbytes=read bytes completed
# dbytes=discard bytes (TRIM/DISCARD operations)
```

### How io.latency works

```c
/* block/blk-iolatency.c */
/* The iolatency monitor tracks per-IO latency for each cgroup: */

struct iolatency_grp {
    struct blkg_rwstat stats;         /* per-direction stats */
    struct blk_iolatency *blkiolat;
    u64     min_lat_nsec;             /* target from io.latency */
    u64     cur_win_nsec;             /* current monitoring window */
    atomic64_t window_start;
    atomic_t  scale_cookie;          /* throttle cookie for competing cgroups */
    /* ... */
};

/* When an IO completes: */
static void blkcg_iolatency_done_bio(struct rq_qos *rqos, struct bio *bio)
{
    u64 now = ktime_get_ns();
    u64 bio_issue_time = bio->bi_issue.value;
    u64 lat = now - bio_issue_time;

    /* Track latency in window */
    iolatency_record_time(iolat, lat);

    /* Check if we exceeded target */
    if (lat > iolat->min_lat_nsec)
        iolatency_check_latencies(iolat, now);
}
```

## io.stat: I/O statistics

```bash
# Per-device I/O stats for a cgroup:
cat /sys/fs/cgroup/mycgroup/io.stat
# 8:0 rbytes=1234567890 wbytes=987654321 rios=12345 wios=9876 \
#     dbytes=0 dios=0 wait_usec=123456789 io_service_bytes=... \
#     io_wait_time=...

# Fields:
# rbytes/wbytes: read/write bytes completed
# rios/wios:     read/write I/O count
# dbytes/dios:   discard bytes/count
# wait_usec:     total time spent waiting in queue (µs)
```

## Writeback attribution

Dirty page writeback can be attributed to the cgroup that dirtied the pages:

```bash
# Check writeback stats:
cat /sys/fs/cgroup/mycgroup/io.stat
# dbytes/dios = discard (TRIM) bytes/count; writeback is counted in wbytes

# Tune writeback throttling:
echo 80 > /proc/sys/vm/dirty_ratio           # 80% of RAM as dirty threshold
echo "8:0 wbps=10485760" > /sys/fs/cgroup/mycgroup/io.max  # throttle writeback
```

```c
/* mm/page-writeback.c: writeback is attributed via inode ownership */
/* If inode is created by a cgroup, its writeback counts against that cgroup */
```

## Container I/O isolation

Docker/containerd use io.max and io.weight for container isolation:

```bash
# Docker: set device read rate
docker run --device-read-bps /dev/sda:50mb --device-write-bps /dev/sda:25mb \
    my-image

# Docker: set I/O weight
docker run --blkio-weight 500 my-image   # 500/1000 = 0.5x default

# Kubernetes: resource requests/limits use io.max underneath:
# resources:
#   limits:
#     blkio.throttle.read_bps_device: "52428800"  # 50MB/s
```

## Further reading

- [cgroup v2 Architecture](cgroup-v2.md) — cgroup v2 hierarchy and controllers
- [Resource Controllers](cgroup-controllers.md) — memory, cpu, and io controllers
- [I/O Schedulers](../block/io-schedulers.md) — BFQ scheduler that io.weight uses
- [NVMe Driver](../block/nvme.md) — block device underneath the io controller
- `block/blk-throttle.c` — io.max throttling implementation
- `block/blk-iolatency.c` — io.latency implementation
- `block/bfq-iosched.c` — BFQ I/O scheduler with weight support
