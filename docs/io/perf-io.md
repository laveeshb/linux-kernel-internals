# perf for I/O Performance Analysis

> Profiling, tracing, and counting I/O events with the Linux `perf` tool — from syscall latency to hardware PMU counters

`perf` is the primary performance analysis tool shipped with the Linux kernel. It is built on two primitives: **hardware performance monitoring units (PMUs)** on the CPU, and **kernel tracepoints** exposed via the kernel's event infrastructure. For I/O work, both matter: PMU events reveal cache, TLB, and memory bus pressure; tracepoints reveal exactly which syscalls fired, how long they took, and where in the block layer time was spent.

This page covers the four main `perf` subcommands in an I/O context:

| Subcommand | What it does |
|---|---|
| `perf stat` | Count events over an interval; get aggregate totals |
| `perf trace` | Trace syscalls with per-call latency, like `strace` but low overhead |
| `perf record` + `perf report` | Sample CPU time or tracepoints, build call-graph profiles |
| `perf script` | Dump raw recorded events for post-processing (flamegraphs, etc.) |

---

## How perf sees I/O events

The kernel exposes I/O-relevant events at three levels:

```
Syscall layer      syscalls:sys_enter_read, sys_exit_read, sys_enter_write, ...
Block layer        block:block_rq_issue, block:block_rq_complete, block:block_bio_remap, ...
Page cache         filemap:mm_filemap_add_to_page_cache, mm_filemap_delete_from_page_cache
Writeback          writeback:writeback_start, writeback_written, writeback_wait
Scheduler          sched:sched_stat_iowait  (time a task spent blocked on I/O)
```

Each of these is a **tracepoint** defined in the kernel source with the `TRACE_EVENT` macro. You can see all available tracepoints on a running kernel:

```bash
# List all tracepoint event groups
perf list tracepoint

# Filter to block and filesystem events
perf list 'block:*' 'syscalls:sys_enter_read' 'syscalls:sys_enter_write'
perf list 'filemap:*' 'writeback:*'
```

The tracepoint definitions for the block layer live in [`include/trace/events/block.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/block.h). The syscall tracepoints are generated from the syscall table in [`include/trace/events/syscalls.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/syscalls.h).

---

## perf stat: counting I/O events

`perf stat` attaches to a process or command, counts specified events for the duration, and prints totals when the process exits or the sleep interval completes. It adds near-zero overhead compared to tracing tools.

### Counting syscalls

```bash
# Count read/write syscalls for a running process (replace PID)
perf stat -e syscalls:sys_enter_read,syscalls:sys_enter_write \
          -e syscalls:sys_exit_read,syscalls:sys_exit_write \
          -p $(pgrep myapp) sleep 10

# Run a command and count its I/O syscalls from start to finish
perf stat -e syscalls:sys_enter_read,syscalls:sys_enter_write \
          -e syscalls:sys_enter_pread64,syscalls:sys_enter_pwrite64 \
          -e syscalls:sys_enter_fsync,syscalls:sys_enter_fdatasync \
          cat /var/log/syslog > /dev/null
```

The `sys_enter_*` tracepoints fire when the syscall is entered. The `sys_exit_*` variants fire on return. Comparing the two counts for `read` tells you whether any reads are being interrupted and retried (`EINTR`) or failing.

### Counting block I/O events

```bash
# Count how many BIOs are issued and completed during a fio run
perf stat -e block:block_rq_issue,block:block_rq_complete \
          -e block:block_bio_remap \
          fio --filename=/dev/nvme0n1 --rw=randread --bs=4k \
              --iodepth=32 --numjobs=1 --time_based --runtime=10s \
              --name=baseline --direct=1

# Count block events for a running database
perf stat -e block:block_rq_issue,block:block_rq_complete \
          -e block:block_rq_merge \
          -p $(pgrep -f "postgres: checkpointer") sleep 30
```

`block:block_rq_issue` fires when a request is dispatched to the device driver. `block:block_rq_complete` fires on interrupt/completion. The gap between the two represents device latency. `block:block_rq_merge` tells you whether the I/O scheduler is coalescing adjacent requests — a high merge rate on sequential workloads is good; on random workloads it indicates the I/O pattern has some locality.

### Measuring page cache effectiveness

The ratio of page cache adds to block I/O dispatches tells you your hit rate:

```bash
# For every block I/O issued, how many pages were served from cache?
perf stat -e filemap:mm_filemap_add_to_page_cache \
          -e block:block_rq_issue \
          cat /path/to/large/file > /dev/null

# Second run — should show zero block_rq_issue if file fits in RAM
perf stat -e filemap:mm_filemap_add_to_page_cache \
          -e block:block_rq_issue \
          cat /path/to/large/file > /dev/null
```

On the second run, `block:block_rq_issue` should be zero or very small. If it is not, either the file is larger than available RAM, another process is evicting pages, or the file is opened `O_DIRECT`.

### Measuring writeback activity

```bash
# How much writeback occurred during a write-heavy test?
perf stat -e writeback:writeback_written \
          -e writeback:writeback_wait \
          -e writeback:writeback_start \
          dd if=/dev/zero of=/tmp/testfile bs=1M count=1024
```

`writeback:writeback_wait` events indicate that a process was throttled because dirty memory exceeded `dirty_ratio`. If you see many of these during write benchmarks, the application is being stalled by writeback pressure. Tuning `vm.dirty_ratio` and `vm.dirty_background_ratio` affects this.

---

## perf trace: syscall tracing with per-call latency

`perf trace` traces syscalls for a target process and reports the duration of each call. It is functionally similar to `strace` but implemented via the kernel's ring buffer, so it imposes far less overhead and does not perturb timing the way `ptrace`-based tools do.

### Basic usage

```bash
# Trace all I/O syscalls for a PostgreSQL backend
perf trace -p $(pgrep -f "postgres: .*") \
           -e read,write,pread64,pwrite64,fsync,fdatasync,open,openat,close

# Trace a command from start to finish
perf trace -- dd if=/dev/urandom of=/tmp/test bs=4k count=1000
```

Output format:

```
     0.000 read(3, 0x7f8a1c000b20, 8192)              = 8192 <0.023 ms>
     0.023 pwrite64(7, 0x7f8a1c002000, 4096, 8192)    = 4096 <0.041 ms>
     0.064 fsync(7)                                   = 0 <1.284 ms>
     1.348 read(3, 0x7f8a1c000b20, 8192)              = 8192 <0.018 ms>
```

The number after `=` is the return value. The `<N ms>` at the end is the elapsed time for that syscall. For `fsync`, this directly reflects how long the storage device took to acknowledge the flush.

### Finding slow syscalls

```bash
# Show only syscalls taking longer than 1 ms
perf trace -p $(pgrep mysqld) --duration 1000

# Show only fsync and fdatasync calls (critical for durability analysis)
perf trace -p $(pgrep postgres) -e fsync,fdatasync --duration 100
```

`--duration N` filters to syscalls that took more than N microseconds. This is useful when you want to see only the outlier calls that are contributing to tail latency rather than the steady stream of fast calls.

### Summarizing syscall time

```bash
# Summary mode: totals per syscall (not per-call detail)
perf trace -s -p $(pgrep app) sleep 10

# Example output:
#  syscall            calls  errors  total       min       avg       max
#  --------------- --------  ------ --------  --------  --------  --------
#  read                4721      0  120.3 ms    0.01 ms   0.02 ms  12.4 ms
#  write               1842      0   28.1 ms    0.01 ms   0.01 ms   0.8 ms
#  fsync                312      0  891.2 ms    0.9 ms    2.8 ms   45.2 ms
#  pread64             6221      0  441.8 ms    0.02 ms   0.07 ms   8.1 ms
```

This shows at a glance that `fsync` is dominating wallclock time even though it has the fewest calls.

### Tracing writeback-related events alongside syscalls

```bash
# Mix syscall tracing with tracepoints
perf trace -p $(pgrep app) \
           -e write,fsync \
           -e writeback:writeback_wait \
           sleep 30
```

When `writeback:writeback_wait` events appear interleaved with `write` calls, the process is being throttled by dirty-page pressure.

---

## perf record: CPU profiling for I/O paths

`perf record` samples the CPU's instruction pointer (and optionally the full call stack) at a specified frequency. For I/O analysis, this answers: "which kernel functions is my process spending time in while doing I/O?"

### Basic CPU profiling

```bash
# Record at 99 Hz with call graphs for 10 seconds
perf record -F 99 -g -p $(pgrep fio) sleep 10

# View the report interactively
perf report

# Non-interactive, sorted by shared library and symbol
perf report --stdio --sort=dso,symbol | head -60
```

### What to look for in I/O-heavy profiles

When a process is doing buffered reads, typical hot paths include:

```
generic_file_read_iter     — top-level buffered read function
  filemap_read             — reads from the page cache
    copy_folio_to_iter     — copies page cache data to user buffer
    folio_wait_locked      — sleeping waiting for a page to be read from disk
      io_schedule          — the scheduler call that blocks the process
```

When doing buffered writes:

```
generic_perform_write      — top-level buffered write
  iov_iter_copy_from_user_atomic — copy from user buffer to page cache
  balance_dirty_pages_ratelimited — throttled by dirty page limit
    io_schedule            — sleeping waiting for writeback to drain
```

For direct I/O:

```
__blkdev_direct_IO         — direct I/O submission
  bio_alloc                — allocate a bio
  submit_bio               — submit to block layer
  blk_mq_submit_bio        — blk-mq submission path
  nvme_queue_rq            — NVMe driver enqueue
  blk_mq_start_request     — start the request timer
```

High time in `io_schedule` or `folio_wait_locked` means the process is spending most of its time sleeping waiting for I/O. High time in `copy_folio_to_iter` or `iov_iter_copy_from_user_atomic` means the memcpy overhead between page cache and user buffer is significant — consider `O_DIRECT` or `mmap`.

### Profiling with tracepoints as sampling events

Instead of sampling the clock, you can record a stack trace every time a specific event fires:

```bash
# Record a call graph every time a block I/O request is issued
perf record -e block:block_rq_issue --call-graph dwarf \
            -p $(pgrep fio) sleep 5

perf report
```

This shows which code paths are generating block I/O. The call graph will trace from the kernel block layer up through the filesystem, VFS, and into the application. This is how you answer "which function in my application is causing device I/O?"

```bash
# Record every page cache miss (folio read from storage)
perf record -e filemap:mm_filemap_add_to_page_cache --call-graph dwarf \
            -- cat /path/to/file > /dev/null
perf report
```

```bash
# Record every writeback wait (process throttled by dirty pages)
perf record -e writeback:writeback_wait --call-graph dwarf \
            -p $(pgrep app) sleep 30
perf report
```

!!! note "dwarf vs. frame-pointer call graphs"
    `--call-graph dwarf` uses DWARF unwind information from the binary and is more accurate, especially for binaries compiled without frame pointers. It has higher overhead because the kernel must capture a stack snapshot at each sample. `--call-graph fp` uses frame pointers and is faster but requires binaries compiled with `-fno-omit-frame-pointer`. For kernel symbols, `--call-graph lbr` uses the CPU's Last Branch Record hardware if available.

### Profiling with `dwarf` call graphs for I/O-bound processes

```bash
# Comprehensive I/O profile: clock sampling + block I/O tracepoint
perf record -F 99 -g --call-graph dwarf \
            -e cpu-clock \
            -e block:block_rq_issue \
            -p $(pgrep postgres) sleep 30

perf report --sort=comm,dso,symbol
```

---

## perf script and flamegraphs

`perf script` dumps raw recorded samples as text. This output feeds the Brendan Gregg flamegraph toolchain, which is the most practical way to visualize a CPU or I/O profile.

### Generating a flamegraph for I/O paths

```bash
# Step 1: record
perf record -F 99 -g --call-graph dwarf \
            -e block:block_rq_issue \
            -p $(pgrep fio) sleep 10

# Step 2: dump events
perf script > perf.out

# Step 3: collapse stacks (requires FlameGraph repo)
# https://github.com/brendangregg/FlameGraph
stackcollapse-perf.pl perf.out > perf.folded

# Step 4: render
flamegraph.pl perf.folded > io-flame.svg
```

The resulting SVG shows a flame chart where width represents time. I/O paths in the kernel appear as tall stacks reaching down through `vfs_read` → `generic_file_read_iter` → `submit_bio` → `nvme_queue_rq`. Functions that are wide relative to siblings are the ones consuming the most CPU time (or generating the most I/O events).

### Off-CPU flamegraphs: time spent blocked on I/O

Regular flamegraphs show where the CPU is executing. Off-CPU flamegraphs show where processes are *sleeping* — which for I/O-bound work is often more informative:

```bash
# Record off-CPU events (requires perf sched or bpftrace; perf approach shown)
perf record -e sched:sched_switch --call-graph dwarf -a sleep 10
perf script | stackcollapse-perf.pl --kernel | flamegraph.pl > offcpu.svg
```

!!! note "bpftrace for off-CPU analysis"
    The `perf sched` approach has limitations. For production off-CPU analysis, `bpftrace`'s `offcputime.bt` script (from the BCC tools collection) is more reliable. `perf` is better for on-CPU profiles and tracepoint-based event counts.

---

## Hardware PMU events for storage

Modern Intel and AMD CPUs have hardware counters that measure microarchitectural events relevant to I/O:

### Last Level Cache (LLC) misses

```bash
# LLC misses indicate data being fetched from main memory rather than CPU cache
# High LLC misses during I/O = DMA data landing in DRAM, then fetched on first access
perf stat -e cache-misses,cache-references \
          -e LLC-load-misses,LLC-store-misses \
          -p $(pgrep app) sleep 10

# Example interpretation:
# cache-references:  40,128,421
# cache-misses:       8,221,440   # 20% miss rate
# LLC-load-misses:    6,341,202   # most misses are on loads (read path)
```

A high LLC miss rate during a read-heavy workload usually means:

1. The working set does not fit in the LLC (common for database buffer pools larger than ~8 MB per core).
2. I/O buffers are being populated by DMA and accessed by the CPU for the first time — the first touch of DMA-written data is always an LLC miss.
3. The read access pattern is random enough that prefetchers cannot help.

### Memory bandwidth — DMA and buffer copy overhead

```bash
# Intel uncore IMC (Integrated Memory Controller) counters
# These measure actual DRAM bus transactions, not LLC events
perf stat -e uncore_imc/data_reads/,uncore_imc/data_writes/ sleep 5

# Alternative on systems where uncore events are available as pseudo-events
perf stat -e mem-loads,mem-stores -p $(pgrep app) sleep 10
```

Memory bandwidth matters for I/O because buffered I/O involves at minimum two copies of every byte through DRAM: once from the device into the page cache (DMA), and once from the page cache into the user buffer (`copy_to_user`). For a process doing 1 GB/s of buffered reads, the actual DRAM bandwidth consumed is at least 2 GB/s.

```bash
# Check if available on your system
perf list | grep -i 'uncore_imc\|memory_bw'
```

### TLB misses — relevant for mmap I/O

When applications use `mmap` for I/O (common in databases and memory-mapped log readers), TLB pressure becomes significant:

```bash
# dTLB misses: data TLB (relevant for mmap reads/writes)
perf stat -e dTLB-load-misses,dTLB-store-misses \
          -e iTLB-load-misses \
          -p $(pgrep app) sleep 10

# Ratio: dTLB-load-misses / mem-loads gives the TLB miss rate
perf stat -e dTLB-load-misses,mem_inst_retired.all_loads \
          -p $(pgrep app) sleep 10
```

High dTLB miss rates during mmap I/O indicate that the access pattern is striding across many pages faster than the TLB can cache. Using huge pages (`madvise(MADV_HUGEPAGE)`) or `mmap` with `MAP_HUGETLB` can reduce TLB pressure significantly for large sequential scans.

### Checking available hardware events

The set of hardware PMU events depends on the CPU microarchitecture. Always check what is actually available on the target system:

```bash
# Hardware events
perf list hardware

# Software events (kernel counters)
perf list software

# Hardware cache events
perf list hw-cache

# All events including tracepoints (long list)
perf list

# Check if a specific event works
perf stat -e cache-misses echo test
```

---

## perf annotate: instruction-level hotspots

When `perf report` identifies a hot function, `perf annotate` shows the disassembly of that function with per-instruction sample counts:

```bash
# First, record with enough samples
perf record -F 999 -g -p $(pgrep app) sleep 10

# Then annotate a specific function
perf annotate filemap_read

# Or annotate interactively from the report
perf report
# (press 'a' on a symbol to annotate)
```

This is useful when optimizing the kernel itself or when debugging performance regressions in a specific kernel function. For application developers, it is most useful when hot time appears in a user-space function — `perf annotate` will show which instruction inside, say, a memcpy implementation or a checksum loop is consuming cycles.

---

## perf bench: I/O microbenchmarks

`perf bench` includes several microbenchmarks relevant to I/O subsystem performance:

```bash
# Memory copy bandwidth — the overhead of buffered I/O's copy_to_user path
perf bench mem memcpy --size 1GB --iterations 10

# Memory set — models page cache zeroing on allocation
perf bench mem memset --size 1GB --iterations 10

# Futex performance — affects file lock contention (flock, fcntl locks)
perf bench futex wake --threads 8
perf bench futex requeue

# Scheduler — how fast the kernel context-switches (affects I/O-bound processes)
perf bench sched pipe --loop 1000000
perf bench sched messaging --group --thread
```

The `mem memcpy` benchmark gives you the theoretical ceiling for buffered I/O throughput on a given system. If your application's buffered read throughput is significantly below this number, the bottleneck is device I/O, not the copy path. If it is close to this number, you are CPU-bound on the copy, and `O_DIRECT` with user-space buffers aligned to page boundaries will help.

---

## perf kvm: I/O in virtual machines

When running workloads inside KVM guests, I/O-related VM exits add latency. `perf kvm` traces these exits:

```bash
# Live statistics of VM exit reasons for a QEMU/KVM process
perf kvm stat live -p $(pgrep qemu-kvm)

# Record VM exits and analyze offline
perf kvm stat record -p $(pgrep qemu-kvm) sleep 30
perf kvm stat report

# Example output (I/O-relevant exit types):
# VM-EXIT          Samples  Samples%  Time%    Min Time   Max Time   Avg time
# VMEXIT_IOIO          821    12.4%    31.2%    0.8 us     124.0 us   8.4 us
# VMEXIT_EPT_MISCONFIG  42     0.6%     2.1%    1.2 us      18.3 us   4.8 us
# VMEXIT_MSR           234     3.5%     0.8%    0.3 us       4.1 us   0.4 us
```

`VMEXIT_IOIO` — VM exit caused by a guest I/O port instruction. High counts here mean the guest is issuing legacy port I/O (common with emulated IDE/AHCI devices rather than virtio).

`VMEXIT_EPT_MISCONFIG` — Extended Page Table misconfiguration, often caused by MMIO access to device registers. High counts during storage I/O can indicate the guest is polling an emulated device rather than using interrupt-driven virtio.

For storage-intensive VMs, switching from emulated SCSI/AHCI to `virtio-blk` or `virtio-scsi` reduces VM exits significantly because virtio uses shared memory rings rather than port I/O.

---

## Measuring fsync latency distribution

Single `perf trace` output shows individual syscall times. For a distribution, you need to collect many samples and summarize:

```bash
# Collect fsync exit timestamps for 60 seconds, extract the duration field
perf trace -p $(pgrep postgres) -e fsync 2>&1 | \
    awk '/fsync/ && /ms>/ {
        match($0, /<([0-9.]+) ms>/, arr)
        if (arr[1] != "") print arr[1]
    }' | sort -n > fsync-latencies.txt

# Count and summarize
awk '{
    count++
    sum += $1
    if ($1 > max) max = $1
    if (count == 1 || $1 < min) min = $1
} END {
    printf "count=%d min=%.3f max=%.3f avg=%.3f ms\n", count, min, max, sum/count
}' fsync-latencies.txt

# Rough percentile (requires sorted input)
wc -l fsync-latencies.txt  # get total N
awk 'NR==int(0.99*LINES)' LINES=$(wc -l < fsync-latencies.txt) fsync-latencies.txt
```

For production latency histograms, `bpftrace` is cleaner:

```bash
# bpftrace fsync latency histogram (shown here for comparison)
bpftrace -e '
    tracepoint:syscalls:sys_enter_fsync { @start[tid] = nsecs; }
    tracepoint:syscalls:sys_exit_fsync  /@start[tid]/
    {
        @latency_us = hist((nsecs - @start[tid]) / 1000);
        delete(@start[tid]);
    }'
```

---

## I/O scheduler profiling

The I/O scheduler (BFQ, mq-deadline, none) adds latency in exchange for fairness or deadline guarantees. Profile scheduler overhead:

```bash
# Identify time spent in BFQ scheduler functions
perf record -F 99 -g -e cpu-clock \
            -- dd if=/dev/zero of=/dev/sda bs=4k count=100000 oflag=direct
perf report | grep -A5 bfq

# Compare schedulers: record with mq-deadline
echo mq-deadline > /sys/block/sda/queue/scheduler
perf stat -e block:block_rq_issue,block:block_rq_complete \
          -e cpu-clock \
          -- fio --filename=/dev/sda --rw=randwrite --bs=4k \
                 --iodepth=4 --numjobs=4 --time_based --runtime=30s \
                 --name=test --direct=1

# Compare with none (pass-through for NVMe — avoids scheduler overhead entirely)
echo none > /sys/block/nvme0n1/queue/scheduler
perf stat -e block:block_rq_issue,block:block_rq_complete \
          -e cpu-clock \
          -- fio --filename=/dev/nvme0n1 --rw=randwrite --bs=4k \
                 --iodepth=4 --numjobs=4 --time_based --runtime=30s \
                 --name=test --direct=1
```

On NVMe devices with hardware multi-queue support, the `none` scheduler typically outperforms BFQ and mq-deadline for single-tenant workloads because it eliminates software queuing overhead. BFQ is appropriate when multiple processes with different priorities share a device.

---

## Practical diagnostic workflows

### "Why is my application slow?" workflow

This is the most common starting point. Work from the application down to the hardware:

```bash
# Step 1: Which syscalls are slow?
perf trace -s -p $PID sleep 10
# Look at avg and max time for read, write, pread64, pwrite64, fsync

# Step 2: Where is CPU time going?
perf record -F 99 -g -p $PID sleep 10
perf report --stdio --sort=symbol | head -30
# Look for io_schedule, folio_wait_locked (blocking on I/O)
# or balance_dirty_pages_ratelimited (throttled by writeback)

# Step 3: How many block I/Os are being issued?
perf stat -e block:block_rq_issue,block:block_rq_complete \
          -e block:block_rq_merge \
          -p $PID sleep 10
# High merge rate on a random workload = some locality exists
# Low completion rate vs issue rate = device is saturated

# Step 4: Is writeback throttling the process?
perf stat -e writeback:writeback_wait -p $PID sleep 10
# Any count here = process was stalled waiting for dirty pages to flush
# Fix: lower vm.dirty_ratio or increase write buffer
```

### "Is the bottleneck I/O or CPU?" workflow

```bash
# Compare clock time vs CPU time
perf stat -e cpu-clock,task-clock \
          -e block:block_rq_issue \
          -p $PID sleep 10

# Interpretation:
# task-clock / cpu-clock gives the fraction of wallclock time the process was on CPU
# A value near 1.0 = CPU-bound
# A value near 0.0 = I/O-bound (the process was mostly sleeping)

# Alternative: use perf stat's built-in CPUs-utilized metric
perf stat -p $PID sleep 10
# Look for: "0.12 CPUs utilized" -- if well below 1.0 on a single-threaded process,
# the process is spending most of its time blocked (on I/O or locks)
```

### "Where is the I/O coming from?" workflow

When you see high block I/O counts but are not sure which part of the application generates them:

```bash
# Record a call graph on every block I/O issue
perf record -e block:block_rq_issue --call-graph dwarf -a sleep 10

# View which call paths generated the most I/Os
perf report --sort=comm,symbol

# Or generate a flamegraph focused on I/O-generating paths
perf script | stackcollapse-perf.pl | flamegraph.pl \
    --title "Block I/O issue call paths" > io-origin.svg
```

### "Is the page cache working?" workflow

```bash
# Run the workload once to populate the cache
perf stat -e block:block_rq_issue cat /path/to/file > /dev/null
# Note the block_rq_issue count (should be high: cold cache)

# Run again immediately
perf stat -e block:block_rq_issue cat /path/to/file > /dev/null
# block_rq_issue should be near zero: warm cache

# If still high on second run, the file is being opened O_DIRECT,
# the file is larger than available RAM, or memory pressure is evicting pages
```

### "Why is fsync slow?" workflow

```bash
# Step 1: How long is each fsync taking?
perf trace -p $(pgrep app) -e fsync,fdatasync --duration 500
# List all fsyncs taking > 500 μs

# Step 2: How many fsyncs per second?
perf stat -e syscalls:sys_enter_fsync,syscalls:sys_enter_fdatasync \
          -p $(pgrep app) sleep 10
# Divide by 10 to get calls/second

# Step 3: Are fsyncs grouping (write combining) or serialized?
perf trace -p $(pgrep app) -e write,fsync 2>&1 | head -100
# If fsync follows immediately after every write, the application
# is doing synchronous write-per-record; consider group commit

# Step 4: Is device flush the bottleneck?
perf stat -e block:block_rq_issue \
          -e syscalls:sys_enter_fsync \
          -p $(pgrep app) sleep 10
# Each fsync should generate at least one block flush request
# If block_rq_issue << sys_enter_fsync, the filesystem is batching flushes
```

---

## perf + flamegraphs: complete example

The following is a complete workflow for profiling a PostgreSQL checkpointer:

```bash
# 1. Identify the checkpointer PID
CPID=$(pgrep -f "postgres: checkpointer")

# 2. Record for one checkpoint cycle (~30s by default)
perf record -F 99 -g --call-graph dwarf \
            -e cpu-clock \
            -e block:block_rq_issue \
            -e writeback:writeback_written \
            -p $CPID sleep 30

# 3. Generate flamegraph
perf script | stackcollapse-perf.pl > checkpoint.folded
flamegraph.pl --title "PostgreSQL checkpointer" checkpoint.folded > checkpoint.svg

# 4. Focus on just the block I/O issue events
perf script | grep block:block_rq_issue | stackcollapse-perf.pl > io.folded
flamegraph.pl --title "Block I/O issue paths" io.folded > checkpoint-io.svg
```

The first flamegraph shows CPU time distribution. The second shows which code paths are generating device I/O. Together they identify whether the checkpointer is CPU-bound (time in checksum computation, buffer management) or I/O-bound (time in `io_schedule` waiting for writes to complete).

---

## Common pitfalls

**Sampling frequency too low**: The default `perf record` frequency is 4000 Hz. For short-lived I/O operations, use `-F 9999` or the maximum allowed by `/proc/sys/kernel/perf_event_max_sample_rate`. The kernel will automatically reduce the frequency if it exceeds the rate limit.

```bash
# Check and set the maximum sample rate
cat /proc/sys/kernel/perf_event_max_sample_rate
echo 100000 > /proc/sys/kernel/perf_event_max_sample_rate
```

**Missing kernel symbols**: If `perf report` shows `[kernel.kallsyms]` with no symbol names, ensure `CONFIG_KALLSYMS=y` and that you have permission to read kernel symbols.

```bash
# Check symbol visibility
cat /proc/sys/kernel/kptr_restrict
echo 0 > /proc/sys/kernel/kptr_restrict   # as root; allows reading kernel pointers
echo 0 > /proc/sys/kernel/perf_event_paranoid  # as root; allows all perf events
```

**`dwarf` call graphs with stripped binaries**: `--call-graph dwarf` requires DWARF debug information in the binary. For system processes (PostgreSQL, MySQL, etc.), install the debug symbol package:

```bash
# Debian/Ubuntu
apt install postgresql-14-dbgsym

# RHEL/Fedora
dnf install postgresql-debuginfo
```

**Tracepoints not available**: Some tracepoints (particularly `syscalls:sys_enter_*`) require `CONFIG_FTRACE_SYSCALLS=y` and `CONFIG_TRACEPOINTS=y` in the kernel. Most distribution kernels enable these, but custom or embedded kernels may not.

```bash
# Verify tracepoints are available
ls /sys/kernel/debug/tracing/events/syscalls/ | head -10
ls /sys/kernel/debug/tracing/events/block/
```

---

## Key source files

The kernel infrastructure underlying `perf` for I/O:

| File | Description |
|---|---|
| [`kernel/events/core.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/events/core.c) | Core `perf_event` implementation; `perf_event_open()` syscall |
| [`include/trace/events/block.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/block.h) | Block layer tracepoint definitions (`block_rq_issue`, `block_rq_complete`, etc.) |
| [`include/trace/events/syscalls.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/syscalls.h) | Syscall enter/exit tracepoints |
| [`include/trace/events/filemap.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/filemap.h) | Page cache tracepoints |
| [`include/trace/events/writeback.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/writeback.h) | Writeback tracepoints |
| [`block/blk-mq.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-mq.c) | blk-mq multi-queue block layer; where `block_rq_issue` fires |
| [`mm/filemap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/filemap.c) | `filemap_read()`, `generic_file_read_iter()` — buffered read hot path |
| [`mm/page-writeback.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page-writeback.c) | `balance_dirty_pages_ratelimited()` — process throttling on dirty pages |
| [`tools/perf/`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/tools/perf) | `perf` source tree (part of the kernel repository) |

## Further reading

- [Brendan Gregg, *Systems Performance* (2nd ed., 2020)](https://www.brendangregg.com/systems-performance-2nd-edition-book.html) — Chapter 9 (Disk I/O) and Chapter 13 (perf) are directly applicable.
- [Brendan Gregg's perf examples](https://www.brendangregg.com/perf.html) — extensive cookbook of `perf` one-liners.
- [FlameGraph repository](https://github.com/brendangregg/FlameGraph) — `stackcollapse-perf.pl` and `flamegraph.pl` for visualizing `perf script` output.
- [Linux `perf` wiki](https://perf.wiki.kernel.org/index.php/Main_Page) — official reference for the tool.
- [`Documentation/trace/tracepoints.rst`](https://www.kernel.org/doc/html/latest/trace/tracepoints.html) — kernel documentation for the tracepoint infrastructure.
- [LWN: "The perf tool"](https://lwn.net/Articles/339361/) — original introduction to `perf` by its authors.
- The `observability.md` page in this directory covers complementary tools: `blktrace`, `iostat`, `/proc/diskstats`, and `ftrace` — useful alongside `perf` for full-stack I/O analysis.
