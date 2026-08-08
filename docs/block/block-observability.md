# Block Layer Observability

> Seeing what the block layer is doing — from cheap aggregate counters up to per-request tracing

Block I/O problems — a slow database, a stalling desktop, a saturated disk — are usually invisible at the application level, which only sees "the write took a long time." The block layer offers three levels of visibility to find out *why*: always-on aggregate counters, on-demand per-request tracing, and programmable tracepoints.

## Level 1: aggregate counters

Every block device exports cumulative counters through `/proc/diskstats` (and per-device `/sys/block/<dev>/stat`). Each line carries, among other fields: reads completed, reads merged, sectors read, milliseconds spent reading, the same four for writes, I/Os currently in flight, and total milliseconds the device has had I/O in progress.

These counters are the raw material for `iostat -x`, which reports *rates* by differencing the counters over an interval:

```bash
iostat -x 1 /dev/nvme0n1
# Device   r/s   w/s   rkB/s   wkB/s  r_await  w_await  aqu-sz  %util
```

- **`r_await` / `w_await`** — average time an I/O spent from submission to completion, *including* time queued. Rising await with normal throughput usually means requests are piling up upstream (in the scheduler or plug), not that the device is slow.
- **`aqu-sz`** — average queue depth (how many I/Os were outstanding). Little's Law ties it to await × throughput.
- **`%util`** — the fraction of time the device had at least one I/O in flight. On a single spinning disk, near 100% means saturated; on an NVMe device with many independent hardware queues, `%util` can read 100% while the device is far from its limit, so it is *not* a saturation signal for parallel devices. (Older `svctm` was removed for this same reason — it was misleading on modern hardware.)

## Level 2: per-request tracing — blktrace

When the aggregates say "await is high" but not *where* the time went, `blktrace` records an event for **every stage of every request**. `blkparse` renders the trace, and each line is tagged with an action letter — the stages a request passes through on its way down the [block layer](block-overview.md):

| Action | Meaning |
|---|---|
| `Q` | bio **queued** — entered the block layer |
| `G` | **get request** — a request was allocated |
| `M` / `F` | back-**merge** / **front**-merge into an existing request |
| `I` | request **inserted** into the scheduler |
| `D` | request **dispatched** to the driver |
| `C` | request **completed** |

```bash
blktrace -d /dev/nvme0n1 -o - | blkparse -i -
```

`btt` (block trace timeline) post-processes a capture into a latency breakdown by stage — most usefully **Q2D** (time from queue to dispatch: how long the block layer/scheduler held the I/O) versus **D2C** (dispatch to completion: time actually at the device). That single split answers the most common question: *is the latency in the kernel or in the hardware?*

## Level 3: programmable tracing — tracepoints and BPF

The same stages are exposed as static tracepoints — `block:block_rq_issue`, `block:block_rq_complete`, `block:block_bio_queue`, `block:block_rq_insert` — which any BPF tool can attach to without a full capture. The BCC / bpftrace suite turns them into focused answers:

- **`biolatency`** — a histogram of I/O completion latency (spot bimodal distributions and tail latency)
- **`biosnoop`** — one line per I/O with issuing process, sector, size, and latency
- **`biotop`** — `top`, but for block I/O by process

```bash
# latency histogram, per second, for one device
biolatency -D 1

# a one-liner: average completion latency by device, live
bpftrace -e 'tracepoint:block:block_rq_complete { @[args->dev] = avg(nsecs); }'
```

## Putting it together

A practical diagnosis flow:

1. **`iostat -x`** first. High `await` with low throughput and modest `%util` → the time is *upstream* (queuing, throttling, scheduler). High throughput at the device's known limit → simply saturated.
2. If it looks upstream, **`blktrace | btt`** and compare **Q2D vs D2C**. Large Q2D means the block layer is holding the I/O — check the [I/O scheduler](io-schedulers.md) and any [cgroup I/O throttling](../cgroups/io-cgroup.md). Large D2C means the device (or its firmware) is the bottleneck.
3. To attribute latency to *processes*, reach for **`biosnoop`** / **`biotop`**.

## Further reading

- [Kernel docs: procfs `diskstats`](https://docs.kernel.org/admin-guide/iostats.html) — the definitive field-by-field reference
- [I/O Schedulers](io-schedulers.md) — where Q2D latency comes from
- [bio and request structures](bio-request.md) — the objects these traces follow
