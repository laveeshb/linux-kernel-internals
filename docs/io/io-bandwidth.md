# I/O Bandwidth: Measurement and Optimization

> How to measure actual I/O bandwidth, where the limits come from, and how to approach them

## What limits I/O bandwidth?

I/O bandwidth — bytes per second moving between storage and memory — is bounded by the weakest link in the chain:

```
Application → VFS → Page Cache → Block Layer → PCIe Bus → Storage Device
                                                    ↑
                                              The bottleneck
                                              is usually here
                                              or the device itself

Typical limits:
  SATA III link:       600 MB/s
  PCIe 3.0 ×4 (NVMe): ~3.5 GB/s
  PCIe 4.0 ×4 (NVMe): ~7 GB/s
  PCIe 5.0 ×4 (NVMe): ~14 GB/s
  DDR5 memory bus:     ~77 GB/s per channel
```

In practice, the limit is often not the hardware interface but the software path: CPU overhead, queue serialization, filesystem overhead, or the memory subsystem's ability to supply data fast enough.

---

## Measuring device bandwidth

### `fio`: the authoritative benchmark

```bash
# Sequential read throughput (O_DIRECT, bypass page cache)
fio --name=seq_read \
    --rw=read \
    --bs=1M \
    --direct=1 \
    --numjobs=1 \
    --iodepth=32 \
    --filename=/dev/nvme0n1 \
    --size=20G \
    --time_based \
    --runtime=30 \
    --group_reporting

# Sequential write throughput
fio --name=seq_write \
    --rw=write \
    --bs=1M \
    --direct=1 \
    --numjobs=1 \
    --iodepth=32 \
    --filename=/dev/nvme0n1 \
    --size=20G \
    --time_based \
    --runtime=30 \
    --group_reporting

# Key output line:
# READ: bw=5123MiB/s (5373MB/s), 5123MiB/s-5123MiB/s (5373MB/s-5373MB/s), io=150GiB (161GB), run=30001-30001msec
```

**Why `bs=1M` and `iodepth=32`?** Sequential bandwidth is maximized with large I/O sizes (the device can serve a 1MB request in one operation) and sufficient queue depth to keep the device busy while the previous I/O completes.

```bash
# Find the optimal block size for your device
for bs in 4k 16k 64k 256k 1M 4M; do
    bw=$(fio --name=test --rw=read --bs=$bs --direct=1 \
              --iodepth=32 --numjobs=1 \
              --filename=/dev/nvme0n1 --size=4G \
              --time_based --runtime=10 --output-format=terse 2>/dev/null \
              | awk -F';' '{print $6}')
    echo "bs=$bs: ${bw}KB/s"
done
```

### `dd`: quick sequential measurement

```bash
# Read throughput (O_DIRECT, from device)
dd if=/dev/nvme0n1 of=/dev/null bs=1M count=4096 iflag=direct 2>&1 | tail -1
# 4294967296 bytes (4.3 GB, 4.0 GiB) copied, 0.843 s, 5.1 GB/s

# Write throughput (O_DIRECT, to device)
dd if=/dev/zero of=/dev/nvme0n1 bs=1M count=4096 oflag=direct 2>&1 | tail -1
```

`dd` is not a reliable benchmark (single-threaded, no queue depth control), but it is fast and available everywhere.

### `/proc/diskstats` for live throughput

```bash
# Live read/write throughput in MB/s
awk '
BEGIN { getline line1 < "/proc/diskstats"; close("/proc/diskstats") }
/nvme0n1/ { split(line1, a); split($0, b)
  printf "read: %.1f MB/s  write: %.1f MB/s\n",
    (b[6]-a[6])*512/1024/1024,
    (b[10]-a[10])*512/1024/1024
  exit }
' <(grep nvme0n1 /proc/diskstats; sleep 1; grep nvme0n1 /proc/diskstats)
```

---

## The CPU bottleneck in I/O bandwidth

On modern NVMe devices (5–7 GB/s), the storage device is often not the bottleneck — the CPU is. Moving data between the device and memory requires:

1. **Interrupt handling**: one interrupt per I/O completion (or per-batch with interrupt coalescing)
2. **Memory copy**: if data passes through the kernel buffer before reaching userspace
3. **DMA management**: programming the IOMMU, pinning pages, checking completion

```bash
# Check CPU usage during sequential I/O
iostat -xz 1 &
mpstat -P ALL 1 &

dd if=/dev/nvme0n1 of=/dev/null bs=1M count=10240 iflag=direct

# Look for: high %irq or %soft on the CPU handling NVMe interrupts
# If one CPU is pegged at 100% doing I/O interrupts, you are CPU-bound
```

**CPU-limited bandwidth symptoms:**
- `iostat %util` < 100% but bandwidth plateau at ~3–4 GB/s
- One CPU core at 100% (`mpstat` shows high `%irq` or `%soft`)
- Throughput increases linearly with the number of parallel jobs (up to CPU saturation)

**Solutions:**

```bash
# 1. Spread NVMe IRQs across CPUs
# Find NVMe IRQ numbers
grep nvme /proc/interrupts | awk '{print $1}' | tr -d ':'

# Set affinity to spread across all CPUs
for irq in $(grep nvme0 /proc/interrupts | awk '{print $1}' | tr -d ':'); do
    echo ff > /proc/irq/$irq/smp_affinity  # all 8 CPUs in bitmask
done

# 2. Use io_uring with IOPOLL to eliminate interrupt overhead
# IOPOLL: application polls for completion instead of waiting for interrupt
# Trades CPU cycles for reduced interrupt latency

# 3. Increase interrupt coalescing (batch completions, fewer interrupts)
# NVMe: set completion queue interrupt coalescing
nvme set-feature /dev/nvme0 -f 8 -v 0x0064  # aggregate 100 entries or 1ms
```

---

## Queue depth and parallelism

For sequential I/O, bandwidth scales with queue depth — up to the device's internal parallelism limit:

```bash
# Bandwidth vs queue depth (1 job, varying iodepth)
for qd in 1 2 4 8 16 32 64 128; do
    bw=$(fio --name=qd_test --rw=read --bs=128k --direct=1 \
              --numjobs=1 --iodepth=$qd \
              --filename=/dev/nvme0n1 --size=10G \
              --time_based --runtime=10 --output-format=terse 2>/dev/null \
              | awk -F';' '{print $6}')
    echo "iodepth=$qd: $((bw/1024)) MB/s"
done
```

Typical NVMe bandwidth vs queue depth curve:

```
QD=1:   ~1.5 GB/s  (device latency limits throughput)
QD=4:   ~3.8 GB/s
QD=8:   ~5.5 GB/s
QD=16:  ~6.8 GB/s  (approaching device max)
QD=32:  ~7.0 GB/s  (saturated — diminishing returns)
QD=64:  ~7.0 GB/s  (no improvement, higher latency)
```

The relationship is: `throughput = queue_depth / latency`. If latency is 100µs (0.1ms), a single queue achieves 10,000 IOPS = 40 MB/s at 4KB. At queue depth 32: 320,000 IOPS = 1.25 GB/s at 4KB.

---

## Memory bandwidth as a ceiling

For large sequential I/O, data must move between the device and DRAM. The DRAM bandwidth imposes an absolute ceiling:

```bash
# Measure DRAM bandwidth with stream benchmark
# https://www.cs.virginia.edu/stream/
./stream
# Triad: 85432.3 MB/s  (typical DDR5 on a desktop)

# For NVMe at 7 GB/s: DRAM bandwidth is not the bottleneck
# For a RAID of 8 NVMe at 7 GB/s each = 56 GB/s: approaching DRAM limits
```

When building high-bandwidth storage systems (NVMe-oF, large RAID arrays), DRAM bandwidth becomes the limiting factor. Solutions include:

- **NUMA-aware I/O**: keep I/O buffers in the same NUMA node as the device
- **DMA directly to PMEM**: bypass DRAM for persistent memory destinations
- **Kernel bypass**: SPDK (Storage Performance Development Kit) avoids kernel overhead entirely

---

## Filesystem overhead on bandwidth

A raw block device delivers its rated bandwidth. A filesystem on top adds overhead:

```bash
# Raw device bandwidth
fio --name=raw --rw=read --bs=1M --direct=1 --iodepth=32 \
    --filename=/dev/nvme0n1 --size=10G --runtime=10 --time_based

# Same device with ext4 filesystem
mkfs.ext4 /dev/nvme0n1
mount /dev/nvme0n1 /mnt
fio --name=fs --rw=read --bs=1M --direct=1 --iodepth=32 \
    --filename=/mnt/testfile --size=10G --runtime=10 --time_based
```

Typical filesystem overhead for sequential I/O with `O_DIRECT`:
- **ext4, XFS**: 3–8% overhead (extent lookup, inode lock)
- **Btrfs**: 5–15% overhead (tree operations, checksums)
- **tmpfs**: 0% (memory-backed, no device I/O)

For buffered I/O (through page cache), the page cache adds a copy but also enables readahead and caching, which can deliver higher bandwidth than the device for re-read workloads.

---

## Monitoring bandwidth in production

```bash
# iostat: simplest monitoring
iostat -xz 1 | grep -E '(nvme|Device)'

# Key columns for bandwidth:
# rkB/s: read KB/s
# wkB/s: write KB/s

# bpftrace: live per-process I/O bandwidth
bpftrace -e '
tracepoint:block:block_rq_complete {
    @bytes_by_comm[comm] = sum(args->nr_sector * 512);
}
interval:s:1 {
    print(@bytes_by_comm);
    clear(@bytes_by_comm);
}'

# Alert when write bandwidth exceeds threshold (for monitoring systems)
THRESHOLD=$((400 * 1024))  # 400 MB/s in KB/s
while true; do
    wbw=$(awk '/nvme0n1/{print $9}' /proc/diskstats)
    sleep 1
    wbw2=$(awk '/nvme0n1/{print $9}' /proc/diskstats)
    rate=$(( (wbw2 - wbw) * 512 / 1024 ))
    if [ $rate -gt $THRESHOLD ]; then
        echo "WARN: write bandwidth ${rate}KB/s exceeds ${THRESHOLD}KB/s"
    fi
done
```

---

## Quick reference: bandwidth characteristics by storage type

| Storage | Seq Read | Seq Write | Notes |
|---------|----------|-----------|-------|
| SATA HDD | 80–200 MB/s | 70–180 MB/s | Rotational; sequential ≫ random |
| SATA SSD | 400–560 MB/s | 350–520 MB/s | SATA III interface limit |
| NVMe Gen3 ×4 | 2–3.5 GB/s | 1.5–3 GB/s | PCIe 3.0 ×4 limit: 3.94 GB/s |
| NVMe Gen4 ×4 | 4–7 GB/s | 3–6.5 GB/s | PCIe 4.0 ×4 limit: 7.88 GB/s |
| NVMe Gen5 ×4 | 8–14 GB/s | 6–12 GB/s | PCIe 5.0 ×4 limit: 15.75 GB/s |
| Intel Optane | 2.5–7 GB/s | 2–7 GB/s | Very low latency (10µs); bandwidth lags NVMe Gen5 |
| NVMe-oF (TCP) | Up to 25 Gb/s NIC | | Network-limited |

---

## Related pages

- [Tuning I/O for Streaming Workloads](tuning-streaming.md) — maximizing sequential throughput
- [Tuning I/O for Low Latency](tuning-latency.md) — when bandwidth is not the goal
- [Tuning I/O for Databases](tuning-databases.md) — mixed random/sequential workloads
- [I/O Polling (HIPRI and IOPOLL)](io-polling.md) — eliminating interrupt overhead
- [Understanding /proc/diskstats](understanding-proc-diskstats.md) — measuring bandwidth from diskstats
- [Debugging Slow I/O](debugging-slow-io.md) — diagnosing bandwidth bottlenecks
