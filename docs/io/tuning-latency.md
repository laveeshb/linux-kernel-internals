# Tuning I/O for Latency-Sensitive Workloads

> Minimizing tail latency for applications where microseconds matter

## What latency-sensitive means

Throughput-oriented workloads want to maximize bytes per second. Latency-sensitive workloads want to minimize the time from I/O submission to completion — especially at the tail (p99, p999). High-frequency trading systems, real-time databases, interactive applications, and game servers all fall into this category.

The difference in approach is fundamental:

```
Throughput tuning:                    Latency tuning:
- Maximize queue depth                - Minimize queue depth
- Batch and merge I/Os                - Submit I/Os immediately
- Use large I/O sizes                 - Keep I/O sizes small and predictable
- Writeback buffering                 - Synchronous writes
- Background readahead                - Demand-only fetching
- Scheduler reordering                - First-come-first-served or none
```

---

## The latency budget: where time goes

A typical I/O from userspace to device and back:

```
Application write() call
    ↓
VFS layer (path lookup, permission check)           ~1µs
    ↓
Filesystem layer (journal, extent tree)             ~5-50µs
    ↓
Page cache (mark dirty) / O_DIRECT (bypass)         ~1µs
    ↓
Block layer (scheduler, merging, plug)              ~5-50µs (schedulers add overhead)
    ↓
Device driver (NVMe queue submission)               ~2-5µs
    ↓
NVMe device (flash controller, media latency)       ~50-200µs
    ↓
Interrupt / completion polling                      ~2-10µs
    ↓
Return to application                               ~1µs

Total end-to-end:                                   ~70-300µs (NVMe)
                                                    ~1-10ms (SATA SSD)
                                                    ~5-15ms (HDD)
```

Each layer adds its own latency. Reducing kernel-layer latency (scheduler, plug, filesystem) can bring NVMe latency from 300µs to 80µs — a 4× improvement in some workloads.

---

## Use `none` scheduler to eliminate scheduler overhead

The I/O scheduler was designed for spinning disks with seek penalties. For NVMe, it adds latency without benefit.

```bash
# Eliminate scheduler for NVMe
echo none > /sys/block/nvme0n1/queue/scheduler

# Verify
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq

# For SATA SSDs: mq-deadline with low latency settings
echo mq-deadline > /sys/block/sda/queue/scheduler
echo 0 > /sys/block/sda/queue/iosched/write_expire   # minimize write deadline
echo 0 > /sys/block/sda/queue/iosched/read_expire    # minimize read deadline
```

---

## Disable request plugging

The block layer "plugs" I/O — holds requests briefly to allow merging before submitting to the device. This improves throughput but adds latency.

```bash
# Disable plugging for latency-sensitive devices (per-device)
echo 0 > /sys/block/nvme0n1/queue/nomerges     # 0=allow merges, 1=no merges, 2=only simple merges

# Set nomerges=1 to submit each I/O immediately
echo 1 > /sys/block/nvme0n1/queue/nomerges
```

**Application-level plug disabling:**

For applications that submit I/O in batches, the kernel automatically plugs the queue during the batch and unplugs at the end of the system call. For io_uring with `IORING_SETUP_SQPOLL`, the submission thread runs in the kernel and can control this directly.

---

## Reduce queue depth for predictable latency

Counterintuitively, a lower queue depth can reduce tail latency. A deep queue causes later I/Os to wait behind earlier ones — head-of-line blocking. For latency-sensitive workloads where every I/O matters equally:

```bash
# Current queue depth
cat /sys/block/nvme0n1/queue/nr_requests   # e.g.: 1023

# Reduce to limit head-of-line blocking
echo 32 > /sys/block/nvme0n1/queue/nr_requests

# The right value depends on your I/O pattern:
# - Single-threaded synchronous: 1-4
# - Low-concurrency async: 16-64
# - High-concurrency async: 256-1024
```

**Measuring the effect:**

```bash
# Use fio to measure latency at different queue depths
for qd in 1 4 16 64 256; do
    echo -n "QD=$qd: "
    fio --name=lat_test --rw=randread --bs=4k --direct=1 \
        --numjobs=1 --iodepth=$qd \
        --filename=/dev/nvme0n1 --size=10G \
        --time_based --runtime=10 \
        --output-format=terse 2>/dev/null | \
        awk -F';' '{print "p50=" $40 "µs p99=" $42 "µs p999=" $43 "µs"}'
done
```

---

## Use O_DIRECT to eliminate page cache overhead

Page cache operations — marking pages dirty, checking for cache hits, managing LRU lists — add latency to every I/O. For latency-sensitive workloads with their own caching layer:

```bash
# Application-level: open with O_DIRECT
int fd = open(path, O_RDWR | O_DIRECT);

# Verify with strace that flags are set:
strace -e trace=open,openat your_application 2>&1 | grep O_DIRECT
```

**O_DIRECT alignment requirements:**

O_DIRECT requires that the buffer address, offset, and length all be aligned to the logical block size (usually 512 bytes, often 4096 bytes for modern devices).

```bash
# Check device logical block size
cat /sys/block/nvme0n1/queue/logical_block_size   # usually 512 or 4096
cat /sys/block/nvme0n1/queue/physical_block_size  # underlying media block size

# Use posix_memalign or aligned_alloc for O_DIRECT buffers
void *buf;
posix_memalign(&buf, 4096, IO_SIZE);  // 4096-byte aligned
```

---

## io_uring for low-latency async I/O

io_uring (added in v5.1, [commit 2b188cc1bb857](https://git.kernel.org/linus/2b188cc1bb857)) eliminates syscall overhead for I/O-intensive applications. For latency-sensitive workloads, the key features are:

**1. Submission queue polling (`IORING_SETUP_SQPOLL`):**

Instead of a `io_uring_enter()` syscall per batch, a kernel thread polls the submission queue continuously. I/O submission latency drops from ~1µs (syscall) to ~100ns (ring write + cache miss).

```c
struct io_uring_params params = {
    .flags = IORING_SETUP_SQPOLL,
    .sq_thread_idle = 1000,  // ms before SQ poll thread sleeps
};
int ring_fd = io_uring_setup(256, &params);
```

**2. Fixed buffers (`IORING_REGISTER_BUFFERS`):**

Pre-register buffers with the kernel to avoid per-I/O memory pinning:

```c
struct iovec iov[NUM_BUFS];
for (int i = 0; i < NUM_BUFS; i++) {
    posix_memalign(&iov[i].iov_base, 4096, BUF_SIZE);
    iov[i].iov_len = BUF_SIZE;
}
io_uring_register_buffers(&ring, iov, NUM_BUFS);
// Now use IORING_OP_READ_FIXED / IORING_OP_WRITE_FIXED
```

**3. Completion polling (`IORING_SETUP_IOPOLL`):**

Instead of waiting for an interrupt from the NVMe device, poll the device's completion queue. Adds CPU usage, eliminates interrupt latency (~2-5µs).

```c
struct io_uring_params params = {
    .flags = IORING_SETUP_IOPOLL,
};
// Works only with O_DIRECT files on supporting block devices
```

Latency comparison for 4KB random reads on NVMe:

| Method | Median | p99 |
|--------|--------|-----|
| `read()` (buffered) | 200µs | 800µs |
| `read()` (O_DIRECT) | 80µs | 300µs |
| `io_uring` (default) | 75µs | 280µs |
| `io_uring` + IOPOLL | 50µs | 120µs |
| `io_uring` + SQPOLL + IOPOLL | 45µs | 100µs |

---

## CPU affinity and NUMA placement

For latency-sensitive I/O, keeping the CPU, memory, and device on the same NUMA node avoids remote memory accesses on the I/O path.

```bash
# Find which NUMA node an NVMe device is on
cat /sys/block/nvme0n1/device/numa_node   # e.g.: 0

# Find which CPUs are on NUMA node 0
cat /sys/devices/system/node/node0/cpulist  # e.g.: 0-23

# Pin your latency-sensitive process to the same NUMA node
numactl --cpunodebind=0 --membind=0 ./your_application

# Or with taskset for CPU affinity only
taskset -c 0-23 ./your_application
```

**NVMe interrupt CPU affinity:**

NVMe completion interrupts are delivered to specific CPUs. For the lowest latency, ensure the interrupt and the application thread are on the same CPU or same NUMA node.

```bash
# Check NVMe interrupt CPU assignments
cat /proc/interrupts | grep nvme

# Find the CPU handling NVMe0 queue 1
grep nvme0q1 /proc/interrupts
# 87:       0       0    4321       0  PCI-MSI 524289-edge  nvme0q1

# The CPU with the highest count (column 4 in this case) handles this queue
# Set affinity for the NVMe IRQ:
IRQNUM=$(grep nvme0q1 /proc/interrupts | awk '{print $1}' | tr -d ':')
echo 0f > /proc/irq/$IRQNUM/smp_affinity  # pin to CPUs 0-3
```

---

## Disable power management features that add jitter

Power management can cause the device or CPU to be in a low-power state when an I/O arrives, adding variable "wakeup" latency.

```bash
# Disable NVMe APST (Autonomous Power State Transition)
nvme set-feature /dev/nvme0 -f 0x0c -v 0  # disable APST
# Or at boot: nvme_core.default_ps_max_latency_us=0

# Disable ASPM (Active State Power Management) for PCIe
# Find the NVMe device PCI address
lspci | grep NVMe
# e.g.: 01:00.0 Non-Volatile memory controller: ...

# Check current ASPM state
cat /sys/bus/pci/devices/0000:01:00.0/power/control  # "auto" or "on"

# Disable ASPM for this device
echo on > /sys/bus/pci/devices/0000:01:00.0/power/control

# CPU: use performance governor to avoid frequency scaling
echo performance | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# Disable CPU C-states for lowest interrupt latency
# (significant power cost — only for dedicated latency-critical nodes)
for i in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do echo 1 > $i; done
```

---

## Measuring I/O latency percentiles

```bash
# fio: comprehensive latency benchmarking
fio --name=latency_profile \
    --rw=randread \
    --bs=4k \
    --direct=1 \
    --ioengine=io_uring \
    --iodepth=1 \
    --numjobs=1 \
    --filename=/dev/nvme0n1 \
    --size=10G \
    --time_based \
    --runtime=60 \
    --percentile_list=50,90,95,99,99.9,99.99

# biolatency: kernel-level histogram (BCC)
/usr/share/bcc/tools/biolatency -d nvme0n1 30

# bpftrace: custom latency tracking
bpftrace -e '
kprobe:blk_account_io_start {
    @ts[arg0] = nsecs;
}
kprobe:blk_account_io_done /@ts[arg0]/ {
    @latency_ns = hist(nsecs - @ts[arg0]);
    delete(@ts[arg0]);
}
END { print(@latency_ns); }'

# For io_uring specifically: track submission to completion
bpftrace -e '
tracepoint:io_uring:io_uring_submit_sqe { @ts[args->req] = nsecs; }
tracepoint:io_uring:io_uring_complete /@ts[args->req]/ {
    @lat = hist((nsecs - @ts[args->req]) / 1000);
    delete(@ts[args->req]);
}'
```

---

## Checklist: latency-sensitive I/O tuning

```
[ ] I/O scheduler: echo none > /sys/block/nvme*/queue/scheduler
[ ] No merges: echo 1 > /sys/block/nvme*/queue/nomerges
[ ] Queue depth: tune nr_requests for your concurrency level
[ ] O_DIRECT: open data files with O_DIRECT | O_SYNC if needed
[ ] io_uring: use IORING_SETUP_IOPOLL for NVMe
[ ] NUMA: pin process and NVMe IRQ to same NUMA node
[ ] CPU governor: echo performance > .../scaling_governor
[ ] NVMe APST: disable autonomous power state transitions
[ ] dirty_bytes: set low (512MB) to prevent dirty stalls
[ ] Measure: fio --ioengine=io_uring --percentile_list=99,99.9
```

---

## Related pages

- [io_uring Architecture](../io-uring/io-uring-arch.md) — how io_uring eliminates syscall overhead
- [I/O Polling (HIPRI and IOPOLL)](io-polling.md) — kernel polling for NVMe
- [Direct I/O](direct-io.md) — O_DIRECT internals
- [Tuning Storage I/O](tuning-storage.md) — general sysctl reference
- [Debugging Slow I/O](debugging-slow-io.md) — finding the bottleneck
- [perf for I/O](perf-io.md) — PMU-based latency profiling
