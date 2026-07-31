# Understanding /proc/diskstats

> A field-by-field guide to reading and interpreting Linux block device statistics

## What `/proc/diskstats` tells you

`/proc/diskstats` exposes per-block-device I/O counters maintained by the kernel's block layer. Every I/O request that passes through `blk-mq` is counted here — reads, writes, discards, flushes, queue time, and service time.

```bash
cat /proc/diskstats
#  8       0 sda 91234 1023 3456789 45678 56789 2345 9876543 234567 0 123456 280245 0 0 0 0 1234 5678
#  8       1 sda1 85432 ...
# 259       0 nvme0n1 ...
```

The counters are cumulative since boot. To get rates, take the delta between two readings.

---

## Field reference

```
Field  1: major device number
Field  2: minor device number
Field  3: device name
Field  4: reads completed successfully
Field  5: reads merged
Field  6: sectors read
Field  7: time spent reading (ms)
Field  8: writes completed
Field  9: writes merged
Field 10: sectors written
Field 11: time spent writing (ms)
Field 12: I/Os currently in progress
Field 13: time spent doing I/Os (ms)
Field 14: weighted time spent doing I/Os (ms)
Field 15: discards completed (kernel 4.18+)
Field 16: discards merged (kernel 4.18+)
Field 17: sectors discarded (kernel 4.18+)
Field 18: time spent discarding (ms) (kernel 4.18+)
Field 19: flush requests completed (kernel 5.5+)
Field 20: time spent flushing (ms) (kernel 5.5+)
```

---

## Fields 4–7: Reads

### Field 4: `reads_completed`

The number of read I/Os that completed successfully. This includes I/Os that were satisfied from the device (not from a higher-level cache). Does **not** include reads merged into an existing queued request before they were issued (those are counted in field 5).

```bash
# Rate: reads per second
prev=$(awk '/^sda /{print $4}' /proc/diskstats); sleep 1
curr=$(awk '/^sda /{print $4}' /proc/diskstats)
echo "$((curr - prev)) reads/sec"
```

### Field 5: `reads_merged`

The number of read requests that were merged with an adjacent in-flight request before being issued to the device. Two reads for adjacent sectors can be merged into one larger read, reducing IOPS at the device level.

A high merge ratio indicates good I/O locality and an efficient I/O scheduler. A low ratio (close to 0) is normal for NVMe with `none` scheduler or for purely random workloads.

```
reads_merged / (reads_completed + reads_merged) = merge ratio
```

### Field 6: `sectors_read`

Total sectors (512 bytes each) read. Divide by 2048 for megabytes, or use:

```bash
# Read throughput in MB/s
awk 'BEGIN{prev=0} /^sda /{
    if (prev > 0) printf "%.1f MB/s read\n", ($6 - prev) * 512 / 1024 / 1024;
    prev = $6
}' <(cat /proc/diskstats; sleep 1; cat /proc/diskstats)
```

### Field 7: `ms_reading`

Total milliseconds spent in read I/Os. This is the sum of the duration of each read request from when it was issued to the device until it completed.

```
average read latency = ms_reading / reads_completed   (in ms per read)
```

If `ms_reading / reads_completed` is much higher than the device's rated latency (e.g., 10ms on an NVMe that should do 0.1ms), I/Os are spending time queued in the scheduler before reaching the device, or the device is under heavy contention.

---

## Fields 8–11: Writes

The write fields mirror the read fields:

- **Field 8** (`writes_completed`): writes finished successfully
- **Field 9** (`writes_merged`): writes merged before issue
- **Field 10** (`sectors_written`): sectors written (× 512 bytes)
- **Field 11** (`ms_writing`): total ms spent in write I/Os

```bash
# Average write latency
awk '/^nvme0n1 /{
    if ($8 > 0) printf "avg write latency: %.2f ms\n", $11 / $8
}' /proc/diskstats
```

**Write latency vs read latency**: on HDDs and SSDs, writes are often faster than reads at the device level because of write caching. But writes with `fsync()` are slower because they must flush the device cache — the `ms_writing` counter includes the flush wait.

---

## Field 12: `ios_in_progress`

The number of I/Os currently in flight to the device — submitted to the driver but not yet completed. This is a **snapshot** (not cumulative), reflecting the instantaneous queue depth.

```bash
# Watch queue depth in real time
watch -n 0.5 "awk '/^nvme0n1 /{print \"in-flight:\", \$12}' /proc/diskstats"
```

**Interpreting `ios_in_progress`:**

- Consistently 0: the device is idle or I/O is very bursty (you're sampling between bursts).
- 1–8: light load, device is not saturated.
- Near `nr_requests` (default 1023 for NVMe): device is saturated; new I/Os queue in the software layer.
- 0 while `%util` is high in `iostat`: `iostat` uses field 13 (`ms_doing_io`) for `%util`, not field 12. The device may be processing I/Os faster than they can be sampled.

---

## Field 13: `ms_doing_io`

Total milliseconds during which at least one I/O was in progress. This is the raw input to `iostat`'s `%util` metric:

```
%util = (delta ms_doing_io) / (measurement_interval_ms) × 100
```

`%util` reaching 100% means the device had at least one I/O in flight for the entire measurement interval — the device was never idle. For HDDs, this indicates saturation. For NVMe, 100% `%util` is normal and does not indicate saturation (NVMe can handle many parallel I/Os at 100% utilization).

```bash
# Compute %util manually
prev=$(awk '/^sda /{print $13}' /proc/diskstats)
sleep 1
curr=$(awk '/^sda /{print $13}' /proc/diskstats)
echo "util: $(( (curr - prev) ))%"   # if interval is exactly 1000ms
```

---

## Field 14: `ms_weighted_io` (weighted time in I/Os)

This field increments by `(current_ios_in_progress × elapsed_ms)` each time a BIO is queued or completed. It is the queue-depth-weighted time — the integral of queue depth over time.

```
ms_weighted_io / ms_doing_io ≈ average queue depth during active periods
```

This is used by `iostat` to compute `aqu-sz` (average queue size):

```
aqu-sz = delta(ms_weighted_io) / measurement_interval_ms
```

A high `aqu-sz` with low `await` is fine (NVMe servicing a large parallel queue efficiently). A high `aqu-sz` with high `await` indicates the device cannot keep up with the queue — genuine saturation.

---

## Fields 15–18: Discards (kernel 4.18+)

Discards (TRIM/UNMAP) notify the device of freed space, allowing SSDs to garbage-collect unused blocks in advance. The discard fields mirror the read/write structure:

- **Field 15** (`discards_completed`): discard operations completed
- **Field 16** (`discards_merged`): discards merged (rare in practice)
- **Field 17** (`sectors_discarded`): sectors discarded
- **Field 18** (`ms_discarding`): ms spent processing discards

```bash
# Is discard active? (databases, containers benefit from periodic TRIM)
awk '/^nvme0n1 /{print "discards:", $15, "sectors:", $17}' /proc/diskstats

# Enable periodic TRIM via fstrim (run from cron weekly)
fstrim -v /  # discard unused blocks on the root filesystem
```

High discard rates indicate active space reclamation — expected on systems that delete and recreate large files (containers, databases rotating logs). Very high discard rates can cause SSD write amplification if the device's garbage collector is overwhelmed.

---

## Fields 19–20: Flush requests (kernel 5.5+)

Flush requests send a cache-flush command (`REQ_PREFLUSH` or `REQ_FUA`) to the device, telling it to commit write-cached data to persistent media. These are generated by journaling filesystems before journal commits and by explicit `fsync()` calls.

- **Field 19** (`flush_requests`): flush commands completed
- **Field 20** (`ms_flushing`): total ms spent in flush operations

```bash
# Flush rate: how often the device is being flushed
prev_f=$(awk '/^sda /{print $19}' /proc/diskstats); sleep 10
curr_f=$(awk '/^sda /{print $19}' /proc/diskstats)
echo "$(( (curr_f - prev_f) / 10 )) flushes/sec"

# Average flush latency (ms per flush)
awk '/^sda /{if ($19 > 0) printf "avg flush latency: %.1f ms\n", $20/$19}' /proc/diskstats
```

**Why flush latency matters for databases:**

Each `fsync()` or `fdatasync()` on a file that has dirty data triggers at least one flush command. The flush latency directly bounds the maximum transaction rate:

```
max_tps ≤ 1000 / avg_flush_latency_ms

NVMe (0.1ms flush): max ~10,000 TPS from flush alone
SATA SSD (1ms flush): max ~1,000 TPS
HDD (5ms flush): max ~200 TPS
```

Monitoring `ms_flushing / flush_requests` gives the actual flush latency on your storage.

---

## Practical analysis recipes

### Detect a saturated device

```bash
# Sample diskstats twice, compute derived metrics
{
  read line1 < <(grep '^sda ' /proc/diskstats)
  sleep 5
  read line2 < <(grep '^sda ' /proc/diskstats)

  set -- $line1; r1=$4; w1=$8; ms_io1=$13; ms_w1=$14
  set -- $line2; r2=$4; w2=$8; ms_io2=$13; ms_w2=$14

  interval=5000  # ms
  echo "reads/sec:    $(( (r2-r1)/5 ))"
  echo "writes/sec:   $(( (w2-w1)/5 ))"
  echo "%util:        $(( (ms_io2-ms_io1)*100/interval ))%"
  echo "avg queue:    $(echo "scale=1; (${ms_w2}-${ms_w1})/${interval}" | bc)"
}
```

### Find the device with the highest write latency

```bash
awk '
NF >= 14 && $8 > 100 {
    lat = $11 / $8
    if (lat > max_lat) { max_lat = lat; max_dev = $3 }
}
END { printf "slowest writer: %s at %.1f ms avg\n", max_dev, max_lat }
' /proc/diskstats
```

### Watch flush activity during a database checkpoint

```bash
# Before checkpoint
awk '/nvme0n1/{print $19, $20}' /proc/diskstats

# Run checkpoint (PostgreSQL):
# psql -c "CHECKPOINT"

# After checkpoint
awk '/nvme0n1/{print $19, $20}' /proc/diskstats
# Delta: how many flushes the checkpoint generated and total ms spent
```

---

## Relationship to `iostat` output

| `iostat -x` column | `/proc/diskstats` derivation |
|--------------------|-----------------------------|
| `r/s` | `delta(reads_completed) / interval` |
| `w/s` | `delta(writes_completed) / interval` |
| `rkB/s` | `delta(sectors_read) × 512 / 1024 / interval` |
| `wkB/s` | `delta(sectors_written) × 512 / 1024 / interval` |
| `rrqm/s` | `delta(reads_merged) / interval` |
| `wrqm/s` | `delta(writes_merged) / interval` |
| `r_await` | `delta(ms_reading) / delta(reads_completed)` |
| `w_await` | `delta(ms_writing) / delta(writes_completed)` |
| `aqu-sz` | `delta(ms_weighted_io) / (interval × 1000)` |
| `%util` | `delta(ms_doing_io) / (interval × 10)` |

`iostat` is a more convenient interface for monitoring; `/proc/diskstats` is the authoritative source for programmatic access, alerting, and custom metrics pipelines.

---

## Related pages

- [Tuning Storage I/O](tuning-storage.md) — acting on what diskstats reveals
