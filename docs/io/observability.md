# I/O Observability

> Observing and debugging I/O behavior with /proc, iostat, blktrace, ftrace, and perf

The Linux kernel exposes I/O activity through several overlapping layers: pseudo-filesystem counters in `/proc` and `/sys`, block-layer tracing with `blktrace`, kernel tracepoints via ftrace, and per-process accounting in `/proc/PID/io`. This reference covers all of them, explains what each metric means, and shows how to combine them when diagnosing real problems.

---

## /proc/diskstats

`/proc/diskstats` is the canonical source of per-device I/O statistics. Every tool that reports disk throughput or latency — `iostat`, `sar`, `dstat`, Prometheus `node_exporter` — reads this file and computes deltas.

**Source**: [`block/genhd.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/genhd.c) and [`block/diskstats.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/diskstats.c); the per-disk counters live in `struct disk_stats` inside `struct gendisk`.

```bash
$ cat /proc/diskstats
  8   0 sda 487291 21643 42316994 316924 1082744 508437 60720520 5468340 0 1535480 5787056 0 0 0 0 28491 42832
  8   1 sda1 433 0 17624 716 0 0 0 0 0 716 716 0 0 0 0 0 0
259   0 nvme0n1 1284731 84203 98471824 712341 3827164 921842 241837952 14382910 0 3071428 15096084 84291 0 7831204 62831 0 0
```

The format is: major minor name [field1 ... fieldN], where N is kernel-version dependent: 11 fields pre-4.18, 15 fields from 4.18 (discard stats added), 17 fields from 5.5 (flush stats added).

### Field-by-field reference

| # | Field | Type | Description |
|---|-------|------|-------------|
| 1 | reads completed | counter | Total reads that completed successfully. A "completed" read means data was returned to the requesting process. |
| 2 | reads merged | counter | Adjacent read requests that were merged in the I/O scheduler before dispatch. Merged reads reduce queue depth and improve throughput. |
| 3 | sectors read | counter | Total 512-byte sectors read. Divide by 2 to convert to KiB. |
| 4 | time reading (ms) | counter | Milliseconds spent in read I/Os. This is the sum of latencies for all completed reads — divide by reads completed to get average read latency. |
| 5 | writes completed | counter | Total writes that completed successfully. |
| 6 | writes merged | counter | Adjacent write requests merged by the I/O scheduler. |
| 7 | sectors written | counter | Total 512-byte sectors written. |
| 8 | time writing (ms) | counter | Milliseconds spent in write I/Os. |
| 9 | I/Os in progress | gauge | **Current** number of I/Os issued to the device but not yet completed. This is the only gauge in diskstats; all others are counters. See below for interpretation. |
| 10 | time doing I/Os (ms) | counter | Milliseconds during which at least one I/O was in progress (i.e., the device was "busy"). This is what `iostat %util` is derived from. |
| 11 | weighted time doing I/Os (ms) | counter | Sum of `(I/Os in progress) × (elapsed ms)` over time. Used by `iostat` to compute `avgqu-sz` and `await`. |
| 12 | discards completed | counter | Total discard (TRIM) requests completed. Zero on devices that do not support discards. Added in kernel 4.18. |
| 13 | discards merged | counter | Discard requests merged. |
| 14 | sectors discarded | counter | Total 512-byte sectors discarded. |
| 15 | time discarding (ms) | counter | Milliseconds spent in discard I/Os. |
| 16 | flush requests completed | counter | Total flush (cache flush/FUA barrier) requests completed. Added in kernel 5.5. |
| 17 | time flushing (ms) | counter | Milliseconds spent in flush requests. |

!!! note "Kernel version availability"
    The field count is kernel-version dependent: 17 fields on Linux 5.5+; 15 fields on 4.18–5.4 (fields 16–17 flush stats not yet present); 11 fields pre-4.18 (fields 12–17 discard and flush stats not yet present). Tools that parse diskstats must handle variable column counts.

### Interpreting "I/Os in progress" (field 9)

Field 9 is the device queue depth at the instant you read the file. It reflects I/Os that have been issued to the driver but whose completion interrupt has not yet been processed.

- **Spinning disk**: A sustained value of 1–2 is normal. Values consistently above the device's rated queue depth (typically 32–64 for modern HDDs) means the block layer has more I/O queued in software than the device can handle.
- **NVMe**: NVMe devices expose multiple hardware queues (often one per CPU). `iostat` reports an aggregate across all queues, so `avgqu-sz` of 16 on a 16-queue NVMe device is not saturation — it may just mean one pending I/O per queue.
- **A value of 0** despite high throughput means I/Os complete quickly; the sample just happened to hit a quiet moment. Use `avgqu-sz` from `iostat` for a time-averaged view.

### How iostat is built on diskstats

`iostat` reads `/proc/diskstats` twice (at time T1 and T2) and computes:

```
interval = T2 - T1 (in milliseconds)
r/s      = Δreads_completed / interval_seconds
rkB/s    = Δsectors_read × 512 / 1024 / interval_seconds
await    = Δtime_reading / Δreads_completed  (average latency per read)
%util    = Δtime_doing_IOs / interval × 100
avgqu-sz = Δweighted_time_IOs / interval
```

The source is in the `sysstat` package, [`iostat.c`](https://github.com/sysstat/sysstat/blob/master/iostat.c).

---

## iostat -x Output

`iostat -x` (extended statistics) is the most common first tool for I/O diagnosis. Run it with an interval to get deltas rather than averages since boot:

```bash
iostat -x 1          # 1-second intervals, all devices
iostat -x -d sda 5   # 5-second intervals, sda only
iostat -xz 1         # suppress devices with zero activity
```

### Realistic example output

```
Device            r/s     rkB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wkB/s   wrqm/s  %wrqm w_await wareq-sz     d/s     dkB/s   drqm/s  %drqm d_await dareq-sz     f/s f_await  aqu-sz  %util
nvme0n1        182.00  46081.00     0.00   0.00    0.22   253.2    94.00  24318.00     8.00   7.84    1.14   258.7    0.00      0.00     0.00   0.00    0.00      0.0    4.00    0.18    0.31   5.20
sda              2.00    128.00    14.00  87.50    4.31    64.0   118.00   7432.00   243.00  67.32   42.18    63.0    0.00      0.00     0.00   0.00    0.00      0.0    0.00    0.00    4.98  87.40
```

### Field explanations

| Field | Meaning |
|-------|---------|
| `r/s`, `w/s` | Reads and writes completed per second (after merges). This is the device's I/O rate. |
| `rkB/s`, `wkB/s` | Kilobytes read and written per second. Divide by 1024 for MB/s. Compare against the device's rated sequential throughput. |
| `rrqm/s`, `wrqm/s` | Read and write requests merged per second in the I/O scheduler before dispatch. High merge rates indicate sequential or spatially-local workloads where the scheduler can coalesce requests. |
| `%rrqm`, `%wrqm` | Percentage of read/write requests that were merged. In the example, `sda` merges 87.5% of reads and 67.3% of writes — a very sequential workload. `nvme0n1` merges almost nothing, typical for random I/O workloads. |
| `r_await`, `w_await` | Average latency (ms) for read and write requests from submission to completion. This includes time spent in the kernel queue plus device service time. This is what users experience as I/O latency. |
| `aqu-sz` (or `avgqu-sz` in older sysstat) | Average queue size: the time-averaged number of requests in flight. Derived from field 11 (weighted time). For spinning disks, sustained `aqu-sz > 1` indicates queuing; for NVMe it is normal to see higher values across all queues. |
| `rareq-sz`, `wareq-sz` | Average request size in KiB for reads and writes. Small values (< 16 KiB) with high I/O rate indicates random I/O. Large values (> 128 KiB) indicates sequential or large-block I/O. |
| `%util` | Percentage of the interval during which the device had at least one I/O in flight (from diskstats field 10). **This is not CPU utilization** — it is device busy time. |
| `svctm` | **Deprecated and removed in recent sysstat.** Was estimated service time = `%util / (r/s + w/s)`. The estimate was unreliable for SSDs and devices with internal parallelism; do not use it. |

### Identifying saturation

`%util` approaching 100% on a **spinning disk** means the device is saturated — it is busy essentially all the time and cannot absorb more I/O without increasing latency. Paired signals:

- `await` rising well above the device's typical service time (1–5 ms for HDD, 0.05–0.3 ms for NVMe)
- `aqu-sz` growing — requests accumulating in the queue faster than they complete

On **NVMe and SSDs**, `%util` of 100% does not necessarily mean saturation because the device handles I/O in parallel internally. An NVMe drive can sustain 100% `%util` at 0.1 ms `await` because it has many hardware queues. Watch `await` (or `r_await`/`w_await`) for latency increases instead.

**Saturation checklist**:

1. `%util` → 100% **and** `r_await` or `w_await` rising: device is a bottleneck
2. `aqu-sz` > 1 on HDD: queue depth too high for device speed
3. `rrqm/s` falling to zero on a normally-sequential workload: the workload randomized, increasing latency
4. `wkB/s` hitting a plateau at the device's write bandwidth: writes are being throttled

---

## /proc/sys/vm/ Writeback Parameters

The VM's dirty writeback system controls when modified pages are flushed from the page cache to storage. Tuning these parameters affects write latency consistency and throughput. All values live in `/proc/sys/vm/` and are settable via `sysctl`.

**Source**: [`mm/page-writeback.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page-writeback.c).

### dirty_ratio and dirty_bytes

```bash
$ cat /proc/sys/vm/dirty_ratio
20
$ cat /proc/sys/vm/dirty_bytes
0
```

`dirty_ratio` sets the maximum percentage of total system memory that can be filled with dirty (modified, not yet written) pages. When this threshold is crossed, **processes that call `write()` are throttled** — they block in the kernel until writeback makes progress. This is the hard limit; hitting it causes direct application latency.

`dirty_bytes` is the same limit expressed as an absolute byte count. If `dirty_bytes` is non-zero, it takes precedence over `dirty_ratio`. Only one of the two is active at a time.

**When to adjust**: On systems with many GiB of RAM, `dirty_ratio=20%` can allow tens of GiB of dirty data to accumulate. A sudden writeback of that much data causes a latency spike. Lower the ratio (5–10%) or set an absolute `dirty_bytes` cap (e.g., 1 GiB) for latency-sensitive workloads.

```bash
# Cap dirty data at 1 GiB absolutely
sysctl vm.dirty_bytes=1073741824
```

### dirty_background_ratio and dirty_background_bytes

```bash
$ cat /proc/sys/vm/dirty_background_ratio
10
```

`dirty_background_ratio` sets the threshold at which the kernel starts **background writeback** via `flusher` threads (formerly `pdflush`). This is the soft limit — writeback begins here but processes are not yet blocked.

`dirty_background_bytes` is the absolute equivalent. Same precedence rule as above.

The relationship between the two thresholds:

```
dirty_background_ratio < dirty_ratio
(background writeback starts)    (process throttling starts)
```

A wide gap between the two values creates a large zone in which dirty data accumulates without application throttling. A narrow gap means writeback starts sooner and the system stays closer to zero dirty pages.

### dirty_writeback_centisecs

```bash
$ cat /proc/sys/vm/dirty_writeback_centisecs
500
```

The interval (in centiseconds, i.e. hundredths of a second) at which the `wb_workfn` flusher thread wakes up and writes dirty pages. Default 500 = 5 seconds.

Setting this to 0 disables periodic writeback entirely (not recommended for most workloads). Reducing it (e.g., 100 = 1 second) causes more frequent smaller writeback bursts, which can improve latency consistency at the cost of slightly more background I/O.

### dirty_expire_centisecs

```bash
$ cat /proc/sys/vm/dirty_expire_centisecs
3000
```

How long (in centiseconds) a dirty page can stay in the page cache before writeback is considered "expired" and the page must be written. Default 3000 = 30 seconds.

Pages that have been dirty longer than this value are eligible for writeback on the next `dirty_writeback_centisecs` wakeup. Reducing this value causes the kernel to flush pages more aggressively as they age, keeping the dirty window smaller.

### Checking if writeback is keeping up

```bash
# Current dirty and writeback page counts (pages × 4 KiB = bytes)
grep -E "^Dirty:|^Writeback:" /proc/meminfo

# Watch the writeback pipeline in real time
watch -n 1 'grep -E "^Dirty:|^Writeback:|^NFS_Unstable:" /proc/meminfo'

# Rate of pages being dirtied and written via /proc/vmstat
grep -E "nr_dirty|nr_writeback|nr_dirtied|nr_written" /proc/vmstat
```

**Signals that writeback is not keeping up**:

- `Dirty:` in `/proc/meminfo` is consistently near or above `dirty_bytes` / (`dirty_ratio` × total memory)
- `nr_dirtied` rate in `/proc/vmstat` substantially exceeds `nr_written` rate
- Application `write()` calls show elevated latency (strace, perf, or eBPF) — this is the signature of process throttling at the dirty limit

```bash
# Delta writeback activity (1-second samples)
while true; do
    paste <(grep -E "nr_dirtied|nr_written" /proc/vmstat) \
          <(sleep 1; grep -E "nr_dirtied|nr_written" /proc/vmstat) | \
    awk '$1==$3 {print $1, $4-$2, "pages/s"}'
done
```

---

## /sys/class/bdi/

The BDI (Backing Device Info) subsystem tracks per-device writeback state. Each block device (and network filesystem mount) has an entry under `/sys/class/bdi/`.

**Source**: [`include/linux/backing-dev.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/backing-dev.h) and [`mm/backing-dev.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/backing-dev.c).

```bash
$ ls /sys/class/bdi/
259:0   8:0   default   loop0

$ ls /sys/class/bdi/259:0/   # nvme0n1
avg_read_bandwidth  dirty    max_bytes       max_ratio     read_ahead_kb
avg_write_bandwidth  error   max_prop_frac   min_bytes     stable_pages_required
```

### Key files

**`read_ahead_kb`** — the per-device readahead window in KiB. The kernel's readahead algorithm reads ahead this many bytes past the current I/O position when sequential access is detected. Default is typically 128 KiB, but the kernel adjusts this dynamically based on access patterns. For large sequential reads (database backups, streaming), increasing this value reduces the number of I/O requests at the cost of reading data that may not be needed.

```bash
# Increase readahead for a database backup device
echo 4096 > /sys/class/bdi/8:0/read_ahead_kb
# Or via blockdev:
blockdev --setra 8192 /dev/sda   # 8192 × 512 bytes = 4 MiB
```

**`max_ratio`** — maximum percentage of total dirty memory that this device's dirty pages can occupy. Default 100 (no per-device limit). Useful when you have a fast NVMe and a slow HDD on the same system and do not want the HDD writeback to monopolize the dirty cache.

```bash
# Limit sda to 30% of the dirty pool
echo 30 > /sys/class/bdi/8:0/max_ratio
```

**`stable_pages_required`** — if 1, the block device requires stable pages: the kernel must not modify a page while it is under writeback. Some drivers (particularly certain network filesystems and RDMA NICs) set this. It disables the copy-on-write optimisation for dirty pages, adding CPU overhead.

!!! warning "Removed in Linux 5.18"
    `stable_pages_required` was removed in Linux 5.18 when stable-page requirements were eliminated from the block layer. This file does not exist on kernels 5.18+.

```bash
# Linux 5.17 and earlier only:
cat /sys/class/bdi/*/stable_pages_required
```

### bdi_stat counters

The per-BDI counters are exposed indirectly through `/proc/vmstat` fields prefixed with `nr_` (e.g., `nr_dirty`, `nr_writeback`). The BDI-level counters track:

- **BDI_WRITEBACK**: pages currently being written back to this device
- **BDI_RECLAIMABLE**: dirty pages associated with this device that are candidates for reclaim
- **BDI_WRITTEN**: total pages written (monotonic counter)

These can be observed via `bpftrace` against the `writeback` tracepoint group, which includes `bdi_name` in most events.

---

## blktrace and blkparse

`blktrace` captures every event in the block layer for a device and writes binary trace data. `blkparse` decodes it. Together they let you trace the lifecycle of individual I/O requests — from the moment they are queued to when they complete.

**Installation**: usually in the `blktrace` package.

**Source**: [`block/blktrace.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blktrace.c).

### Recording a trace

```bash
# Record all block events on /dev/sda for 10 seconds
blktrace -d /dev/sda -o /tmp/sda_trace -- sleep 10

# This creates per-CPU files: /tmp/sda_trace.blktrace.0, .1, .2 ...

# Parse immediately (combine per-CPU files)
blkparse -i /tmp/sda_trace -o /tmp/sda_trace.txt

# Or pipe directly without writing files
blktrace -d /dev/sda -o - | blkparse -i -
```

### Block layer actions (the action codes)

Each trace event has an action code indicating where in the block stack the event occurred. The key codes:

| Code | Name | Description |
|------|------|-------------|
| `Q` | Queue | I/O request submitted to the block layer by the filesystem or application. |
| `G` | Get request | A `struct request` was allocated from the request pool. |
| `M` | Back merge | Request was back-merged with an existing request in the I/O scheduler queue (merged at the tail of an existing in-queue request). |
| `I` | Insert | Request inserted into the I/O scheduler queue. |
| `S` | Sleep | No request struct was available; the submitter had to sleep waiting for one. |
| `D` | Dispatch | Request dispatched (sent) to the device driver. |
| `C` | Complete | Device driver reported completion — the I/O is done. |
| `P` | Plug | The request queue was plugged (coalescing window started). |
| `U` | Unplug | The request queue was unplugged (coalescing window ended, I/O flushed to driver). |
| `F` | Front merge | Request was front-merged with an existing request (merged at the head of an existing in-queue request). |
| `X` | Split | A large bio was split into smaller requests. |
| `A` | Remap | Request was remapped (e.g., from a device mapper device to the underlying device). |
| `R` | Requeue | Request was requeued (returned from driver to block layer for retry). |

### Sample blkparse output

```
  8,0    3        1     0.000000000   693  Q   W 4456448 + 256 [kworker/u8:2]
  8,0    3        2     0.000004123   693  G   W 4456448 + 256 [kworker/u8:2]
  8,0    3        3     0.000005891   693  I   W 4456448 + 256 [kworker/u8:2]
  8,0    3        4     0.000008341     0  D   W 4456448 + 256 [swapper/3]
  8,0    3        5     0.004182934     0  C   W 4456448 + 256 [swapper/3]
```

Columns: `device  cpu  sequence  timestamp(s)  pid  action  rwbs  sector + nr_sectors  [comm]`

The `rwbs` field encodes the I/O type: `R`=read, `W`=write, `D`=discard, `F`=flush, `S`=sync, `N`=none, `A`=readahead.

### Measuring I/O latency with blkparse

The latency of a single I/O request is the time from `D` (dispatch to driver) to `C` (complete). The time from `Q` (queue) to `C` includes scheduler queuing time.

```bash
# Use blkparse's built-in latency summary
blkparse -i /tmp/sda_trace -d /tmp/sda_trace.bin
btt -i /tmp/sda_trace.bin

# Or extract D-to-C latency manually
blkparse -i /tmp/sda_trace -f "%T %a %S\n" | \
  awk '
    /D/ { dispatch[$3] = $1 }
    /C/ { if ($3 in dispatch) { lat = $1 - dispatch[$3]; print lat * 1000 " ms"; delete dispatch[$3] } }
  ' | sort -n | awk 'BEGIN{n=0; sum=0} {n++; sum+=$1; a[n]=$1} END{
    print "count=" n " avg=" sum/n " ms"
    print "p50=" a[int(n*0.50)] " ms"
    print "p99=" a[int(n*0.99)] " ms"
  }'
```

### btt — block trace toolkit

`btt` is a companion tool that parses `blktrace` binary data and produces structured latency breakdowns:

```bash
blktrace -d /dev/sda -o /tmp/trace -- sleep 30
blkparse -i /tmp/trace -d /tmp/trace.bin -O
btt -i /tmp/trace.bin
```

`btt` breaks I/O latency into components:

- **Q2G**: Queue to Get request (allocating a request struct)
- **G2I**: Get to Insert (I/O scheduler processing)
- **I2D**: Insert to Dispatch (time spent in scheduler queue — this is the "queuing" portion)
- **D2C**: Dispatch to Complete (device service time)
- **Q2C**: Total latency (Queue to Complete)

On a healthy system, `I2D` (scheduler queuing) should be small and `D2C` should match the device's advertised latency. High `I2D` means the I/O scheduler is delaying dispatch to batch requests — this can be intentional (for HDDs) or problematic (for latency-sensitive NVMe workloads).

### blkiomon

`blkiomon` provides online I/O monitoring from a blktrace stream, without writing to disk:

```bash
blktrace -d /dev/nvme0n1 -o - | blkiomon -I 5 -
# Reports D2C latency statistics every 5 seconds
```

---

## ftrace I/O Tracepoints

The `block` and `writeback` tracepoint groups expose the same events as `blktrace` but through the standard ftrace infrastructure. This allows them to be combined with other kernel tracepoints, filtered by PID or CPU, and consumed by `perf` or `bpftrace`.

### Finding available tracepoints

```bash
ls /sys/kernel/debug/tracing/events/block/
ls /sys/kernel/debug/tracing/events/writeback/
ls /sys/kernel/debug/tracing/events/filemap/

# Or via perf
perf list 'block:*' 'writeback:*' 'filemap:*'
```

### Enabling with ftrace

```bash
# Enable the entire writeback group
echo 1 > /sys/kernel/debug/tracing/events/writeback/enable

# Stream events
cat /sys/kernel/debug/tracing/trace_pipe

# Clean up
echo 0 > /sys/kernel/debug/tracing/events/writeback/enable
echo > /sys/kernel/debug/tracing/trace
```

### block:block_rq_issue and block:block_rq_complete

`block_rq_issue` fires when a request is dispatched to the device driver (the `D` event in blktrace). `block_rq_complete` fires on completion (the `C` event).

These two tracepoints are the ftrace equivalent of measuring D2C latency without `blktrace`.

**Fields (block_rq_complete)**:

| Field | Description |
|-------|-------------|
| `dev` | Device major:minor |
| `sector` | Starting sector |
| `nr_sector` | Number of sectors |
| `errors` | Error code (0 = success) |
| `rwbs` | I/O type flags (R/W/D/F) |
| `cmd` | SCSI command string (for SCSI devices) |

```bash
# Measure block I/O latency with bpftrace
bpftrace -e '
tracepoint:block:block_rq_issue {
    @start[args->dev, args->sector] = nsecs;
}
tracepoint:block:block_rq_complete
/@start[args->dev, args->sector]/ {
    $lat = nsecs - @start[args->dev, args->sector];
    delete(@start[args->dev, args->sector]);
    @latency_us = hist($lat / 1000);
}
interval:s:10 { print(@latency_us); clear(@latency_us); }'
```

### writeback:writeback_single_inode

Fires when the writeback code processes the dirty pages of a single inode. This is the per-inode view of writeback activity.

**Fields**:

| Field | Description |
|-------|-------------|
| `name` | Backing device name (e.g., `sda`, `nvme0n1`) |
| `ino` | Inode number |
| `state` | Inode writeback state flags |
| `dirtied_when` | Jiffies when the inode was first dirtied |
| `writeback_index` | Page offset where writeback started |
| `nr_to_write` | Pages requested to write |
| `wrote` | Pages actually written |

```bash
# Which inodes are generating the most writeback?
bpftrace -e '
tracepoint:writeback:writeback_single_inode {
    @pages[args->ino, str(args->name)] = sum(args->wrote);
}
interval:s:10 {
    print(@pages, 10);
    clear(@pages);
}'
```

If a specific inode number keeps appearing, translate it to a path:

```bash
find / -inum <inode_number> 2>/dev/null
```

### writeback:global_dirty_state

Fires periodically from `balance_dirty_pages()` in the writeback throttling code. Provides a snapshot of the global dirty page state including the current limit calculations.

**Fields**:

| Field | Description |
|-------|-------------|
| `nr_dirty` | Current dirty pages |
| `nr_writeback` | Pages currently under writeback |
| `background_thresh` | The background writeback threshold (pages) |
| `dirty_thresh` | The hard dirty limit (pages) |
| `dirty_limit` | Effective dirty limit after smoothing |
| `nr_dirtied` | Monotonic dirty page counter |
| `nr_written` | Monotonic written page counter |

```bash
echo 1 > /sys/kernel/debug/tracing/events/writeback/global_dirty_state/enable
cat /sys/kernel/debug/tracing/trace_pipe
# Output: writeback-global_dirty_state: dirty=12345 writeback=234 bg_thresh=51200 thresh=102400
```

This tracepoint is invaluable for understanding whether `dirty_ratio`/`dirty_background_ratio` tuning is having the intended effect. Watch `nr_dirty` relative to `dirty_thresh` — if they are consistently close, processes are being throttled.

### writeback:writeback_writepage

Fires for each page written via `write_cache_pages()`. Very high frequency — enable only briefly on targeted inodes using a filter:

```bash
# Filter to a specific device
echo 'name == "sda"' > /sys/kernel/debug/tracing/events/writeback/writeback_writepage/filter
echo 1 > /sys/kernel/debug/tracing/events/writeback/writeback_writepage/enable
```

### filemap:mm_filemap_add_to_page_cache

Fires when a page is added to the page cache — either on a read fault that brings a page in from storage, or when a file is first mmap'd or read.

**Fields**: `i_ino`, `s_dev`, `index` (page index within the file), `pfn`

```bash
# Cache population rate by device
bpftrace -e '
tracepoint:filemap:mm_filemap_add_to_page_cache {
    @add[args->s_dev] = count();
}
interval:s:1 { print(@add); clear(@add); }'
```

### filemap:mm_filemap_delete_from_page_cache

Fires when a page is evicted from the page cache — either due to memory reclaim, explicit `fadvise(POSIX_FADV_DONTNEED)`, or file truncation.

**Fields**: same as add: `i_ino`, `s_dev`, `index`, `pfn`

```bash
# Cache churn: additions vs evictions per second
bpftrace -e '
tracepoint:filemap:mm_filemap_add_to_page_cache    { @add = count(); }
tracepoint:filemap:mm_filemap_delete_from_page_cache { @del = count(); }
interval:s:5 {
    printf("cache: +%d -%d pages/5s (net %d)\n", @add, @del, @add - @del);
    clear(@add); clear(@del);
}'
```

High eviction rates (`mm_filemap_delete_from_page_cache`) combined with high major fault rates (`pgmajfault` in `/proc/vmstat`) indicates the page cache is too small for the working set — pages are evicted and then immediately needed again, causing repeated disk reads.

---

## perf for I/O

`perf` can record, count, and sample block layer tracepoints with low overhead. It is particularly useful for attributing I/O to specific processes and call stacks.

### Counting block events

```bash
# Count all block events for 10 seconds system-wide
perf stat -e 'block:block_rq_issue,block:block_rq_complete,block:block_bio_queue' \
           -a -- sleep 10

# Example output:
#  Performance counter stats for 'system wide':
#     182,413      block:block_rq_issue
#     182,389      block:block_rq_complete
#     201,847      block:block_bio_queue
```

The difference between `block_bio_queue` and `block_rq_issue` is the number of bios that were merged — they entered the block layer but were absorbed into existing requests.

### Recording with call stacks

```bash
# Record block completions with kernel+user stacks for 30 seconds
perf record -e block:block_rq_complete -ag -- sleep 30
perf report
```

The `-a` flag records system-wide (all CPUs). `-g` captures call stacks. This shows which code paths are generating the most I/O completions.

```bash
# perf script for post-processing
perf script | head -50
# Output format:
# kworker/u8:2   693 [003] 12345.678901: block:block_rq_complete: 8,0 W () 4456448 + 256 [0]
```

### Finding writeback hotspots with perf top

```bash
# Live view of functions spending time in writeback
perf top -e block:block_rq_issue --sort comm,dso,symbol

# Writeback-specific: watch flusher thread CPU usage
perf top -p $(pgrep -d, kworker) -e cycles
```

### Counting writeback tracepoints

```bash
# Writeback activity summary over 60 seconds
perf stat -e 'writeback:writeback_single_inode,writeback:global_dirty_state,writeback:writeback_written' \
           -a -- sleep 60
```

### perf with bpftrace for I/O attribution

```bash
# Top processes by write I/O bytes (using block tracepoints)
bpftrace -e '
tracepoint:block:block_rq_issue /args->rwbs[0] == "W"/ {
    @bytes[comm] = sum(args->nr_sector * 512);
}
interval:s:10 { print(@bytes, 10); clear(@bytes); }'
```

---

## /proc/PID/io

Every process has an `/proc/PID/io` file that accounts for its I/O activity since the process started. This is distinct from `/proc/diskstats` — it attributes I/O to individual processes rather than devices.

**Source**: [`fs/proc/base.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/proc/base.c), accounting via `task_io_accounting` in `include/linux/task_io_accounting.h`.

```bash
$ cat /proc/$(pgrep postgres | head -1)/io
rchar: 18492831744
wchar: 4831291392
syscr: 2847291
syscw: 1038472
read_bytes: 12849381376
write_bytes: 3748103168
cancelled_write_bytes: 104857600
```

### Field-by-field reference

| Field | Description |
|-------|-------------|
| `rchar` | Bytes passed to `read()`, `pread()`, `readv()` and similar syscalls. This counts **all** bytes read regardless of whether they came from the page cache or disk. Reading a file entirely cached will still increment `rchar`. |
| `wchar` | Bytes passed to `write()`, `pwrite()`, `writev()` and similar. Again, counts bytes passed to the syscall, not bytes that hit storage. |
| `syscr` | Number of read system calls (read, pread64, readv, etc.). |
| `syscw` | Number of write system calls. |
| `read_bytes` | Bytes that actually caused block-layer reads. These are bytes read from storage (page cache misses). This counter only increments when the kernel had to fetch pages from disk. |
| `write_bytes` | Bytes written to storage via writeback. Pages written from this process's dirty footprint that were flushed to disk. |
| `cancelled_write_bytes` | Bytes of writeback that were "cancelled" — dirty pages that were freed without being written, typically because the process truncated or deleted a file before its dirty pages were flushed. In the example, 100 MiB of writes were avoided. |

### Key distinctions

**`wchar` vs `write_bytes`**: `wchar` counts bytes passed to `write()`. `write_bytes` counts bytes that actually hit storage. The gap between them is the amount of write I/O absorbed by the page cache (writes that will eventually be flushed by writeback, or that were cancelled). A process with `wchar = 10 GiB` and `write_bytes = 500 MiB` is heavily buffered — 95% of its writes stayed in cache.

**`read_bytes` is cumulative and not per-read**: A process that reads the same cached file 1000 times will have `rchar` increasing by the file size each time, but `read_bytes` only increments once (the first read that brought the page in from disk). Subsequent reads hit the page cache and do not increment `read_bytes`.

**`cancelled_write_bytes` can reduce storage pressure**: A database that writes to a temporary file and then unlinks it before flushing may have large `wchar` but significant `cancelled_write_bytes`, meaning the actual storage traffic was much lower.

### Using /proc/PID/io for diagnosis

```bash
# Snapshot I/O for a process
pid=$(pgrep myapp)
cat /proc/$pid/io

# Delta over 5 seconds
a=$(cat /proc/$pid/io)
sleep 5
b=$(cat /proc/$pid/io)

paste <(echo "$a") <(echo "$b") | \
  awk '{split($1,k,":");split($2,v,":");printf "%s: %d/s\n", k[1], (v[2]-$2)/5}'
```

### iotop

`iotop` reads `/proc/PID/io` for all processes and displays a sorted live view:

```bash
iotop -o        # show only processes doing I/O
iotop -a        # accumulated I/O since iotop started
iotop -p <pid>  # monitor a specific process
```

The `DISK READ` and `DISK WRITE` columns in `iotop` come from deltas of `read_bytes` and `write_bytes` — the actual storage traffic. The `SWAPIN` and `IO%` columns indicate time the process spent blocked on I/O.

---

## Pressure Stall Information (PSI)

PSI measures the fraction of time that tasks are stalled waiting for I/O. Unlike utilization metrics (which measure device busyness), PSI measures **application impact** — the actual time workloads spent waiting.

**Source**: [`kernel/sched/psi.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/psi.c). Requires `CONFIG_PSI=y` (enabled by default since 5.2).

### /proc/pressure/io

```bash
$ cat /proc/pressure/io
some avg10=0.12 avg60=0.08 avg300=0.03 total=47382910
full avg10=0.00 avg60=0.00 avg300=0.00 total=8241033
```

**`some`**: The fraction of time during which **at least one task** was stalled waiting for I/O. In the example, 0.12% of time in the last 10 seconds had at least one task blocked on I/O. This represents any I/O stall affecting any task.

**`full`**: The fraction of time during which **all runnable tasks** were stalled on I/O simultaneously — the system as a whole was blocked on I/O with no runnable task able to make progress. This is a stronger signal of I/O saturation.

**`avg10`, `avg60`, `avg300`**: Exponentially-weighted moving averages over 10 seconds, 60 seconds, and 300 seconds respectively. Like load average, but for I/O stall percentage.

**`total`**: Cumulative microseconds spent in the stall state since boot. Useful for computing deltas.

### Interpreting PSI values

| Value | Meaning |
|-------|---------|
| `some` < 1% | I/O stalls are rare; no significant pressure |
| `some` 1–10% | Moderate stall; some tasks occasionally wait on I/O |
| `some` > 10% | Significant I/O pressure; investigate with iostat and blktrace |
| `full` > 0% (sustained) | All runnable tasks are blocked; I/O is a hard bottleneck |
| `full` > 1% | Severe saturation; the entire system is waiting on I/O |

The difference between `some` and `full` is informative: a large `some` with near-zero `full` means I/O affects some tasks but others can still make progress. `full` approaching `some` means the I/O stall is affecting essentially all activity.

### cgroup io.pressure

In a cgroup v2 hierarchy, each cgroup exposes its own I/O pressure:

```bash
cat /sys/fs/cgroup/system.slice/io.pressure
some avg10=0.43 avg60=0.21 avg300=0.09 total=1283910
full avg10=0.00 avg60=0.00 avg300=0.00 total=29341
```

This lets you attribute I/O pressure to specific services without system-wide instrumentation. A high `some` value in a specific cgroup while the system-level `some` is low indicates that service is I/O-bound relative to its peers.

### Integrating with systemd-oomd

`systemd-oomd` monitors PSI values and can kill cgroups that exceed configurable pressure thresholds. Its configuration (`/etc/systemd/oomd.conf`) uses `DefaultMemoryPressureLimit=` and `DefaultMemoryPressureDurationSec=` — note these are memory PSI settings, but the same mechanism applies to I/O via cgroup resource control.

### Setting up PSI alerts

```bash
# Alert when I/O stall exceeds 5% over 10 seconds (using kernel PSI notifications)
# Open the file with O_RDWR, write the trigger, then poll for events
# From a shell, this is easier with a script:

while true; do
    some=$(awk '/^some/ {print $2}' /proc/pressure/io | cut -d= -f2)
    if awk "BEGIN {exit !($some > 5.0)}"; then
        echo "$(date): I/O PSI some=$some% exceeds threshold"
    fi
    sleep 10
done
```

For production use, tools like Prometheus `node_exporter` (version 1.1+) expose PSI metrics as `node_pressure_io_stalled_seconds_total`.

---

## Practical Debugging Scenarios

### Scenario 1: "My disk is 100% utilised but latency is low"

**Symptom**: `iostat -x` shows `%util=100` on an NVMe device but `r_await` and `w_await` are well under 1 ms. Application performance is normal.

**Explanation**: `%util` measures whether any I/O was in flight during each millisecond of the interval — not how much headroom the device has. A high-performance NVMe device can sustain tens of thousands of IOPS across many parallel hardware queues. Each queue may service one I/O in 0.1 ms, but across 16 queues running in parallel, `%util` will show 100% even though the device is far from saturated.

**Diagnosis steps**:

```bash
# Check actual queue depth and latency
iostat -x 1

# Look at aqu-sz: if it's close to 1, the device is barely queued
# If r_await is below the device's spec, there's headroom

# Check NVMe queue count
ls /sys/class/nvme/nvme0/nvme0n1/
cat /sys/class/nvme/nvme0/num_queues

# Inspect per-queue depth
ls /sys/block/nvme0n1/mq/
```

**Resolution**: `%util` is not the right saturation metric for NVMe. Use `await` (ideally `r_await` and `w_await`) to assess whether latency is degrading. Add capacity or reduce I/O only if `await` is rising above your SLA threshold.

### Scenario 2: "Write latency spikes every 30 seconds"

**Symptom**: Application write latency is normally 1–2 ms but spikes to 50–200 ms at regular ~30-second intervals, then recovers.

**Explanation**: The kernel's dirty page flusher (`wb_workfn`) wakes every `dirty_writeback_centisecs` (default 500 = 5 s) and writes pages that have been dirty for `dirty_expire_centisecs` (default 3000 = 30 s). If dirty pages accumulate to the point where writeback generates a large burst of I/O, requests from applications must wait in the block queue behind the writeback flush.

**Diagnosis steps**:

```bash
# Check the writeback interval settings
sysctl vm.dirty_writeback_centisecs vm.dirty_expire_centisecs

# Watch dirty page accumulation in real time
watch -n 1 'grep -E "^Dirty:|^Writeback:|^nr_dirtied|^nr_written" /proc/meminfo /proc/vmstat 2>/dev/null'

# Correlate write latency spikes with writeback events
echo 1 > /sys/kernel/debug/tracing/events/writeback/writeback_single_inode/enable
cat /sys/kernel/debug/tracing/trace_pipe &
# ... reproduce the latency spike ...
echo 0 > /sys/kernel/debug/tracing/events/writeback/writeback_single_inode/enable

# Check if the disk is getting saturated during writeback
iostat -x 1 | grep -E "Device|nvme|sda"
```

**Resolution options**:

1. Reduce `dirty_expire_centisecs` to flush more frequently in smaller batches:
   ```bash
   sysctl vm.dirty_expire_centisecs=500   # Flush pages after 5 seconds
   sysctl vm.dirty_writeback_centisecs=100  # Check every 1 second
   ```
2. Reduce `dirty_bytes` or `dirty_ratio` to cap the total dirty data that can accumulate before throttling begins.
3. Use `sync` or `fsync` with appropriate granularity in the application to control flush timing explicitly.
4. Use I/O scheduling: `blk-mq` with the `kyber` scheduler can prioritize foreground reads over writeback.

### Scenario 3: "Reads are slow but disk shows no reads"

**Symptom**: Application read latency is high. `iostat` shows near-zero read throughput. `/proc/vmstat` shows elevated `pgmajfault`. The machine has low free memory.

**Explanation**: The application's working set was in the page cache, but memory pressure caused the kernel to evict those pages (via `mm_filemap_delete_from_page_cache`). Now each access to an evicted page generates a major page fault, which blocks the process while the kernel reads the page back from disk. The disk reads may complete quickly in isolation, but the rate of major faults creates sustained latency from the application's perspective.

**Diagnosis steps**:

```bash
# Confirm major fault rate
grep pgmajfault /proc/vmstat
# Watch it increase
watch -n 1 'grep pgmajfault /proc/vmstat'

# Check memory pressure
grep -E "^(MemAvailable|Active|Inactive|Cached|Dirty):" /proc/meminfo

# Check reclaim activity
grep -E "pgscan_kswapd|pgscan_direct|pgsteal" /proc/vmstat

# Identify which files are being evicted with filemap tracepoints
echo 1 > /sys/kernel/debug/tracing/events/filemap/mm_filemap_delete_from_page_cache/enable
cat /sys/kernel/debug/tracing/trace_pipe | head -100
echo 0 > /sys/kernel/debug/tracing/events/filemap/mm_filemap_delete_from_page_cache/enable
```

**Resolution**:

- Identify which process or cgroup is consuming memory that displaces the cache. `smem` or `cgroup memory.stat` can show which processes are responsible.
- Pin critical files in the page cache: `vmtouch -l /path/to/file` (userspace) or `mlock()` (application).
- Use cgroup v2 memory limits to prevent other workloads from evicting the shared cache.
- Add memory, or move the competing workload to a different machine.

### Scenario 4: "A process is doing more I/O than expected"

**Symptom**: `iotop` shows a specific process writing many MB/s. Application logs do not explain it. The volume of I/O is much higher than the expected logical write rate.

**Diagnosis steps**:

```bash
# Get the process's I/O breakdown
pid=$(pgrep suspect_app)
cat /proc/$pid/io

# Compare wchar (logical writes) vs write_bytes (actual storage writes)
# If write_bytes >> wchar / (page_size): the application is writing many small I/Os
# without buffering, or is doing excessive metadata updates (e.g., fsync on every write)

# Check for fsync/fdatasync calls
strace -p $pid -e trace=fsync,fdatasync,sync_file_range -T 2>&1 | head -50

# Record the call stack for block writes
perf record -e block:block_rq_issue -p $pid -ag -- sleep 10
perf report

# Check if another process is doing writeback on the same files
# (e.g., a backup tool reading and causing dirty pages to flush)
lsof -p $pid | grep -v mem   # open file descriptors
```

**Common causes**:

- Application calls `fsync()` after every write: check with `strace -e fsync`. Each fsync flushes the entire dirty page range for that file descriptor.
- Log rotation or monitoring agents reading large files, displacing page cache and causing re-reads elsewhere.
- `O_DIRECT` I/O bypassing the page cache: `wchar` ≈ `write_bytes` is the signature (no buffering gap).
- SQLite or other embedded databases with aggressive WAL flushing.

```bash
# Check for O_DIRECT file descriptors
ls -la /proc/$pid/fd | xargs -I{} sh -c 'fdinfo=$(cat /proc/$pid/fdinfo/{} 2>/dev/null); echo "$fdinfo" | grep -i "flags.*0100000"'

# Or more conveniently:
for fd in /proc/$pid/fd/*; do
    flags=$(awk '/^flags:/{print $2}' /proc/$pid/fdinfo/$(basename $fd) 2>/dev/null)
    # O_DIRECT is 0100000 (octal) = 0x8000
    [ -n "$flags" ] && printf '%d\n' "0x$flags" | grep -q '^[0-9]' && \
      echo "fd $(basename $fd): flags=$flags"
done
```

---

## Quick Reference: Tool Selection

| Question | Tool |
|----------|------|
| Is the device saturated? | `iostat -x 1` — watch `%util`, `r_await`, `w_await` |
| Which process is doing the I/O? | `iotop -o` or `/proc/PID/io` deltas |
| Where in the block stack is latency added? | `blktrace` + `btt` for Q2G/G2I/I2D/D2C breakdown |
| Which inode is generating writeback? | `writeback:writeback_single_inode` tracepoint |
| Is dirty writeback keeping up? | `Dirty:` in `/proc/meminfo`; `nr_dirtied` vs `nr_written` in `/proc/vmstat` |
| Is I/O stalling the workload? | `/proc/pressure/io` PSI values |
| Is the page cache being thrashed? | `filemap:mm_filemap_delete_from_page_cache` rate; `pgmajfault` in `/proc/vmstat` |
| What call stack is causing I/O? | `perf record -e block:block_rq_issue -ag` |
| Are writes amplified by fsync? | `strace -e fsync,fdatasync`; `block_rq_issue` count vs `write()` count |
| Per-device writeback tuning | `/sys/class/bdi/<dev>/max_ratio`, `read_ahead_kb` |

---

## Key Source Files

| File | Description |
|------|-------------|
| [`block/diskstats.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/diskstats.c) | `/proc/diskstats` output generation |
| [`block/blktrace.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blktrace.c) | blktrace in-kernel tracing infrastructure |
| [`include/trace/events/block.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/block.h) | Block layer tracepoint definitions |
| [`include/trace/events/writeback.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/writeback.h) | Writeback tracepoint definitions |
| [`include/trace/events/filemap.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/filemap.h) | Page cache tracepoint definitions |
| [`mm/page-writeback.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page-writeback.c) | Dirty page throttling and writeback control |
| [`mm/backing-dev.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/backing-dev.c) | BDI (backing device info) subsystem |
| [`kernel/sched/psi.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/psi.c) | Pressure Stall Information implementation |
| [`fs/proc/base.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/proc/base.c) | `/proc/PID/io` accounting |
| [`include/linux/task_io_accounting.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/task_io_accounting.h) | Per-task I/O accounting struct |

---

## Further Reading

### Kernel documentation

- [`Documentation/block/stat.rst`](https://docs.kernel.org/block/stat.html) — official documentation for `/proc/diskstats` and `/sys/block/<dev>/stat` fields
- [`Documentation/admin-guide/sysctl/vm.rst`](https://docs.kernel.org/admin-guide/sysctl/vm.html) — all `vm.*` sysctl parameters including dirty writeback tuning
- [`Documentation/block/blktrace.rst`](https://docs.kernel.org/block/blktrace.html) — blktrace usage guide and action code reference
- [`Documentation/accounting/psi.rst`](https://docs.kernel.org/accounting/psi.html) — PSI design, interpretation, and notification interface

### Related pages

- [page-cache-writeback.md](page-cache-writeback.md) — how dirty pages are managed and flushed
- [buffered-io.md](buffered-io.md) — the full buffered write path from `write()` to storage
- [readahead.md](readahead.md) — how the kernel prefetches pages and how to tune readahead
- [direct-io.md](direct-io.md) — O_DIRECT I/O: bypassing the page cache and its trade-offs

### LWN articles

- [LWN: Pressure stall information](https://lwn.net/Articles/759781/) — design and motivation for PSI, by Johannes Weiner
- [LWN: Block I/O bandwidth management](https://lwn.net/Articles/806396/) — cgroup v2 I/O controller and `io.pressure`
- [LWN: The multiqueue block layer](https://lwn.net/Articles/552904/) — blk-mq design and how it changed queue depth semantics for NVMe
