# ftrace for I/O Tracing

> Using the kernel's built-in tracing framework for function tracing, tracepoints, latency histograms, and block I/O analysis

ftrace is Linux's built-in tracing framework, living entirely in the kernel — no external agents, no sampling overhead, no side effects from network egress. For I/O debugging it covers everything from "which process called `submit_bio`?" to "what is the latency distribution of NVMe completions?" to "why is writeback throttling this application?". This document covers the full stack: the raw debugfs interface, function and function-graph tracers, block tracepoints, latency histograms with synthetic events, writeback and page cache tracing, and the `trace-cmd` wrapper that makes all of it scriptable.

---

## What ftrace is

ftrace began as a function tracer (hence the name) and grew into a framework hosting multiple tracing plugins. The key components for I/O work:

| Component | What it does |
|-----------|--------------|
| **Function tracer** | Instruments every kernel function using `mcount`/`ftrace_caller` trampolines; records which functions were called and by whom |
| **Function graph tracer** | Captures function entry and exit, showing a call tree with per-function wall-clock time |
| **Tracepoints** | Static probe points scattered throughout the kernel (block layer, VFS, writeback, filemap, syscalls); each fires a structured event with typed fields |
| **Histograms** | Aggregate tracepoint data in-kernel into key/value maps and latency distributions — no post-processing needed |
| **Stack traces** | On any function hit, optionally record the full kernel call stack |
| **Synthetic events** | Combine two tracepoints (e.g., issue + complete) into a single latency event, computed in-kernel |

**Source**: [`kernel/trace/`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/trace) — the main framework lives in `trace.c`, `trace_functions.c`, `trace_events.c`, and `trace_events_hist.c`.

---

## The /sys/kernel/debug/tracing interface

All ftrace control is exposed through debugfs. If debugfs is not mounted:

```bash
mount -t debugfs none /sys/kernel/debug
```

On most distributions it is mounted automatically. Verify:

```bash
grep debugfs /proc/mounts
# none /sys/kernel/debug debugfs rw,relatime 0 0
```

### Key control files

```
/sys/kernel/debug/tracing/
├── current_tracer          # Active tracer: nop, function, function_graph, blk
├── available_tracers       # List all tracers compiled in
├── tracing_on              # 1 = tracing enabled, 0 = paused (ring buffer kept)
├── trace                   # Snapshot: read the ring buffer without consuming it
├── trace_pipe              # Live stream: consuming read; blocks until data arrives
├── trace_clock             # Timestamp source: local, global, mono, x86-tsc
├── buffer_size_kb          # Per-CPU ring buffer size
├── set_ftrace_filter       # Limit function tracer to these functions (glob ok)
├── set_ftrace_notrace      # Exclude these functions from function tracer
├── set_ftrace_pid          # Only trace this PID (empty = all)
├── set_graph_function      # Root function(s) for function_graph tracer
├── available_events        # All tracepoints: subsystem:event_name
├── events/                 # Per-event controls (enable, filter, trigger, format)
└── options/
    ├── func_stack_trace    # Print stack trace on every function hit
    ├── sym-offset          # Show symbol+offset in output
    └── print-parent        # Show parent function in function trace output
```

### Reading the trace

`trace` is a snapshot — you can read it multiple times; the buffer is not consumed:

```bash
cat /sys/kernel/debug/tracing/trace | head -30
```

`trace_pipe` is a live stream that consumes records from the ring buffer. Use it for continuous monitoring:

```bash
cat /sys/kernel/debug/tracing/trace_pipe
```

Press `Ctrl+C` to stop; the records already read are gone from the buffer.

### Output format

A raw ftrace record looks like:

```
          fio-12341 [003] d... 12345.678901: block_rq_issue: 8,0 W 0 () 1048576 + 256 [fio]
```

Fields, left to right:

| Field | Example | Meaning |
|-------|---------|---------|
| Process | `fio-12341` | `comm-pid` of the process running on CPU when the event fired |
| CPU | `[003]` | Which CPU the event was recorded on |
| Flags | `d...` | IRQ/preempt/hardirq/softirq state bits |
| Timestamp | `12345.678901` | Seconds.microseconds since boot (or from `trace_clock`) |
| Event | `block_rq_issue` | Subsystem:event name |
| Payload | `8,0 W 0 () 1048576 + 256 [fio]` | Event-specific fields |

For `block_rq_issue`, the payload is: `dev  rwbs  error  rwb_name  sector + nr_sectors  [comm]`.

---

## Tracing block I/O with the blk tracer

The `blk` tracer is a dedicated block layer tracer. It captures every state transition of a block request — queue, merge, dispatch, complete — with minimal overhead.

```bash
# Enable the blk tracer
echo blk > /sys/kernel/debug/tracing/current_tracer

# Optional: restrict to one device (major:minor)
echo '8,0' > /sys/kernel/debug/tracing/blk_trace_filter_dev   # if supported

# Start tracing
echo 1 > /sys/kernel/debug/tracing/tracing_on

# Run workload
fio --name=test --ioengine=sync --rw=randread --bs=4k --size=1g --runtime=5 --time_based

# Stop tracing
echo 0 > /sys/kernel/debug/tracing/tracing_on

# Read results
cat /sys/kernel/debug/tracing/trace | head -50
```

Typical output:

```
    fio-12341 [001] ....  1234.100001: block_rq_insert: 259,0 R 0 () 2097152 + 8 [fio]
    fio-12341 [001] ....  1234.100012: block_rq_issue: 259,0 R 0 () 2097152 + 8 [fio]
          <idle>-0 [001] d...  1234.100318: block_rq_complete: 259,0 R 0 () 2097152 + 8 [0]
```

Three lines for a single 4 KiB read:

1. **block_rq_insert** — request entered the per-device queue (blk-mq software queue)
2. **block_rq_issue** — request dispatched to the device driver
3. **block_rq_complete** — completion interrupt processed

The time delta between `block_rq_issue` and `block_rq_complete` is the device service time — the true hardware latency. The delta between `block_rq_insert` and `block_rq_issue` is time spent in the software queue (scheduling, merging).

### The rwbs field

The `rwbs` field in block events is a compact string encoding the request type:

| Character | Meaning |
|-----------|---------|
| `R` | Read |
| `W` | Write |
| `D` | Discard (TRIM) |
| `F` | Flush |
| `S` | Synchronous (O_SYNC / FUA) |
| `A` | Read-ahead |
| `M` | Metadata |
| `N` | None (no data transfer) |

Examples: `RM` = metadata read, `WS` = synchronous write, `RS` = sync read.

### Reset between runs

Always clear the trace buffer before a new capture:

```bash
echo > /sys/kernel/debug/tracing/trace
```

---

## trace-cmd: the ftrace wrapper

`trace-cmd` is a command-line wrapper around the debugfs ftrace interface. It handles enabling events, recording to a binary file, and reporting in one command.

Install:

```bash
# Debian/Ubuntu
apt install trace-cmd

# RHEL/Fedora
dnf install trace-cmd
```

### Recording block I/O

```bash
# Record all block events for 5 seconds
trace-cmd record -e 'block:*' sleep 5

# Report from the recording
trace-cmd report | head -40
```

### Filtering to issue and complete

The most useful pair for latency analysis:

```bash
trace-cmd record -e block:block_rq_issue -e block:block_rq_complete sleep 5
trace-cmd report | grep -v ' 0\[' | head -60
```

### Per-device filter

```bash
# Only capture events for /dev/nvme0n1 (major 259, minor 0)
trace-cmd record -e block:block_rq_issue \
    --filter 'dev == MKDEV(259,0)' sleep 5
```

### Record function traces

```bash
# Record calls to submit_bio for 3 seconds
trace-cmd record -p function -l submit_bio sleep 3
trace-cmd report
```

### Saving and sharing

`trace-cmd record` writes a binary `trace.dat` file. To convert to text for sharing:

```bash
trace-cmd report > trace.txt
```

To get a summary of event counts:

```bash
trace-cmd report --stat
```

### kernelshark

For graphical analysis, `kernelshark` reads `trace.dat` files and renders per-CPU timelines with event filtering:

```bash
kernelshark trace.dat
```

---

## Tracing specific kernel functions

### Function tracer: trace a single function

```bash
# Clear any previous filter
echo > /sys/kernel/debug/tracing/set_ftrace_filter

# Set filter to a specific function
echo generic_file_read_iter > /sys/kernel/debug/tracing/set_ftrace_filter

# Switch to function tracer
echo function > /sys/kernel/debug/tracing/current_tracer

echo 1 > /sys/kernel/debug/tracing/tracing_on

# Run workload
dd if=/dev/sda of=/dev/null bs=4k count=1000

echo 0 > /sys/kernel/debug/tracing/tracing_on

cat /sys/kernel/debug/tracing/trace | head -20
```

Output:

```
              dd-15234 [002] .....  8912.340123: generic_file_read_iter <-new_sync_read
              dd-15234 [002] .....  8912.340145: generic_file_read_iter <-new_sync_read
```

Each line shows: the function traced (`generic_file_read_iter`) and its immediate caller (`new_sync_read`).

### Glob patterns in set_ftrace_filter

```bash
# All functions starting with ext4_
echo 'ext4_*' > /sys/kernel/debug/tracing/set_ftrace_filter

# All submit_bio variants
echo 'submit_bio*' > /sys/kernel/debug/tracing/set_ftrace_filter

# Multiple patterns: append with >>
echo 'generic_file_read_iter' > /sys/kernel/debug/tracing/set_ftrace_filter
echo 'filemap_read' >> /sys/kernel/debug/tracing/set_ftrace_filter
```

To see what is currently filtered:

```bash
cat /sys/kernel/debug/tracing/set_ftrace_filter
```

### Available functions

Not all kernel functions are traceable — only those with `mcount` instrumentation (which requires `CONFIG_DYNAMIC_FTRACE`):

```bash
# Search for traceable submit_bio variants
grep submit_bio /sys/kernel/debug/tracing/available_filter_functions
```

### Function graph tracer: see call trees

The `function_graph` tracer records function entry **and** exit, giving a call tree with per-function execution time:

```bash
echo function_graph > /sys/kernel/debug/tracing/current_tracer
echo generic_file_read_iter > /sys/kernel/debug/tracing/set_graph_function

echo 1 > /sys/kernel/debug/tracing/tracing_on
dd if=/tmp/testfile of=/dev/null bs=4096 count=10
echo 0 > /sys/kernel/debug/tracing/tracing_on

cat /sys/kernel/debug/tracing/trace
```

Typical output:

```
 2)               |  generic_file_read_iter() {
 2)               |    filemap_read() {
 2)               |      filemap_get_read_batch() {
 2)   0.187 us    |        find_get_pages_contig();
 2)   0.612 us    |      }
 2)               |      copy_folio_to_iter() {
 2)   0.934 us    |        copy_page_to_iter_nofault();
 2)   1.102 us    |      }
 2) + 15.234 us   |    } /* filemap_read */
 2)   0.083 us    |    iov_iter_count();
 2) + 16.891 us   |  } /* generic_file_read_iter */
```

The `+` prefix means the function took more than 10 µs. `!` means more than 100 µs. `#` means more than 1000 µs. This is invaluable for understanding where time is spent within a complex I/O path.

### Limiting graph depth

Deep call trees can be overwhelming. Limit nesting depth:

```bash
echo 3 > /sys/kernel/debug/tracing/max_graph_depth
```

---

## Latency histograms with synthetic events

ftrace's histogram trigger allows aggregation of tracepoint data in-kernel — computing distributions and maps without post-processing.

### Simple histogram: I/O request size distribution

```bash
# Histogram of block_rq_issue, keyed by request size (nr_sector)
echo 'hist:keys=nr_sector:vals=hitcount:sort=nr_sector' > \
  /sys/kernel/debug/tracing/events/block/block_rq_issue/trigger

# Run workload
fio --name=mix --ioengine=sync --rw=randrw --bs=4k --size=512m --runtime=10 --time_based

# Read histogram
cat /sys/kernel/debug/tracing/events/block/block_rq_issue/hist
```

Output:

```
{ nr_sector:          8 } hitcount:       4821
{ nr_sector:         16 } hitcount:        203
{ nr_sector:         32 } hitcount:         41
{ nr_sector:        128 } hitcount:         12
```

`nr_sector` values are in 512-byte units: 8 sectors = 4 KiB, 128 sectors = 64 KiB.

### Histogram by device and rwbs

```bash
echo 'hist:keys=dev,rwbs:vals=hitcount:sort=hitcount' > \
  /sys/kernel/debug/tracing/events/block/block_rq_issue/trigger

cat /sys/kernel/debug/tracing/events/block/block_rq_issue/hist
```

Output:

```
{ dev: 66305, rwbs: "RA" } hitcount:       8234   # readahead on device 259:1
{ dev: 66305, rwbs: "R"  } hitcount:       3102   # reads on device 259:1
{ dev: 66305, rwbs: "W"  } hitcount:        891   # writes on device 259:1
```

### Measuring block I/O latency with synthetic events

A synthetic event combines two tracepoints — `block_rq_issue` (start) and `block_rq_complete` (end) — to compute per-request latency in the kernel:

```bash
# Create the synthetic event definition
echo 'block_lat u64 lat; dev_t dev; u32 nr_sector; char rwbs[8]' > \
  /sys/kernel/debug/tracing/synthetic_events

# Attach the "start" side: record timestamp on issue
echo 'hist:keys=dev,sector:ts0=common_timestamp.usecs' > \
  /sys/kernel/debug/tracing/events/block/block_rq_issue/trigger

# Attach the "end" side: compute latency and record synthetic event
echo 'hist:keys=dev,sector:lat=common_timestamp.usecs-$ts0:onmatch(block.block_rq_issue).block_lat(lat,dev,nr_sector,rwbs)' > \
  /sys/kernel/debug/tracing/events/block/block_rq_complete/trigger

# Enable the synthetic event
echo 1 > /sys/kernel/debug/tracing/events/synthetic/block_lat/enable

# Run workload
fio --name=lat --ioengine=sync --rw=randread --bs=4k --size=1g --runtime=10 --time_based

# Read the latency data
cat /sys/kernel/debug/tracing/trace_pipe | head -20
```

Each `block_lat` event in the trace output carries the round-trip latency in microseconds for that exact request.

### Histogram over synthetic events

Build a histogram over the synthetic `block_lat` event to get a latency distribution:

```bash
# Histogram of latencies in microseconds, grouped by read/write
echo 'hist:keys=rwbs,lat:vals=hitcount:sort=lat' > \
  /sys/kernel/debug/tracing/events/synthetic/block_lat/trigger

cat /sys/kernel/debug/tracing/events/synthetic/block_lat/hist
```

This gives a full in-kernel latency distribution — equivalent to what `bcc` `biolatency` produces but without any BPF dependency.

### Clearing triggers

```bash
# Remove all triggers from an event
echo '!hist:keys=dev,sector:ts0=common_timestamp.usecs' > \
  /sys/kernel/debug/tracing/events/block/block_rq_issue/trigger
```

Or simply disable and re-enable the event to clear its trigger list.

---

## Tracing writeback

Writeback tracepoints live under `events/writeback/`. They are the fastest way to diagnose dirty throttling and flusher thread behavior.

### Watch dirty page throttling

When a process is throttled by `balance_dirty_pages()`, a `balance_dirty_pages` event fires with the current dirty byte counts and the amount of time the process will sleep:

```bash
echo 1 > /sys/kernel/debug/tracing/events/writeback/balance_dirty_pages/enable
cat /sys/kernel/debug/tracing/trace_pipe | grep balance_dirty
```

Output fields include: `bdi`, `limit` (target dirty bytes), `setpoint`, `dirty`, `bground`, `bdi_setpoint`, `bdi_dirty`, `dirty_ratelimit`, `task_ratelimit`, `dirtied`, `dirtied_pause`, `paused`, `pause`, `period`, `think`.

If `pause` is consistently non-zero for your application's PID, dirty throttling is costing you write latency.

### Available writeback tracepoints

```bash
ls /sys/kernel/debug/tracing/events/writeback/
```

Key events:

| Event | When it fires |
|-------|--------------|
| `writeback_write_inode_start` / `_end` | Around writing a single inode's dirty pages |
| `writeback_writeback_start` / `_written` | When a flusher work item starts and finishes |
| `balance_dirty_pages` | Each time a writer is throttled |
| `writeback_dirty_inode` | When an inode is marked dirty |
| `writeback_queue_io` | When dirty inodes are moved to the I/O queue |
| `global_dirty_state` | Periodic snapshot of global dirty state |
| `wbc_writepage` | Per-page writeback decision |

### Watch flusher thread activity

```bash
echo 1 > /sys/kernel/debug/tracing/events/writeback/writeback_writeback_start/enable
echo 1 > /sys/kernel/debug/tracing/events/writeback/writeback_writeback_written/enable
cat /sys/kernel/debug/tracing/trace_pipe
```

The `writeback_written` event shows: `name` (the BDI name, e.g., `259:0`), `nr_pages` written, `sb_dev`, `sync_mode`, `kupdate` (whether it was a periodic flush), `range_cyclic`, `background`, `reason`, `cgroup`.

To see writeback reason codes, look at `include/trace/events/writeback.h` — reasons include `WB_REASON_BACKGROUND`, `WB_REASON_VMSCAN`, `WB_REASON_SYNC`, `WB_REASON_PERIODIC`.

### Measure writeback latency with trace-cmd

```bash
trace-cmd record \
  -e writeback:writeback_writeback_start \
  -e writeback:writeback_writeback_written \
  sleep 30

trace-cmd report | awk '
  /writeback_start/  { start[$NF] = $1 }
  /writeback_written/ {
    if ($NF in start)
      printf "BDI %s: %.3f ms\n", $NF, ($1 - start[$NF]) * 1000
  }
'
```

---

## Tracing page cache

Page cache tracepoints are under `events/filemap/`. They let you observe cache hits, misses, and evictions at the folio level.

### Watch page cache misses (reads that go to disk)

A `mm_filemap_add_to_page_cache` event fires when a new folio is inserted into the page cache — which happens on a cache miss, before the I/O that fills it:

```bash
echo 1 > /sys/kernel/debug/tracing/events/filemap/mm_filemap_add_to_page_cache/enable
cat /sys/kernel/debug/tracing/trace_pipe | head -20
```

Output:

```
     fio-23411 [001] ....  4512.901234: mm_filemap_add_to_page_cache: dev 259:0 ino 123456 page=0xffffea001234 pfn=0x1234 ofs=4096
```

Fields: `dev`, `ino` (inode number), `page`, `pfn`, `ofs` (byte offset within the file).

### Filter by inode number

First, find the inode number:

```bash
stat /path/to/file | grep Inode
# Inode: 123456
```

Then apply a filter:

```bash
echo 'ino == 123456' > \
  /sys/kernel/debug/tracing/events/filemap/mm_filemap_add_to_page_cache/filter

echo 1 > /sys/kernel/debug/tracing/events/filemap/mm_filemap_add_to_page_cache/enable
```

Now only cache misses for that specific file appear in the trace.

### Watch page cache evictions

```bash
echo 1 > /sys/kernel/debug/tracing/events/filemap/mm_filemap_delete_from_page_cache/enable
```

A spike of deletions under memory pressure confirms the page cache is being reclaimed. Correlate with `writeback:writeback_writeback_start` to distinguish clean evictions (no I/O) from dirty page writebacks (I/O required).

### Count cache misses per PID

```bash
echo 'hist:keys=common_pid:vals=hitcount:sort=hitcount:desc' > \
  /sys/kernel/debug/tracing/events/filemap/mm_filemap_add_to_page_cache/trigger

# Run workload for 30 seconds, then read:
cat /sys/kernel/debug/tracing/events/filemap/mm_filemap_add_to_page_cache/hist
```

The top PIDs with the most cache misses are doing the most I/O.

---

## Filtering by PID and process name

### Restrict function tracer to a single PID

```bash
echo 1234 > /sys/kernel/debug/tracing/set_ftrace_pid
echo function > /sys/kernel/debug/tracing/current_tracer
echo 1 > /sys/kernel/debug/tracing/tracing_on
```

To trace multiple PIDs, write them one per line (append with `>>`).

To clear the PID filter (trace all):

```bash
echo > /sys/kernel/debug/tracing/set_ftrace_pid
```

### Filter tracepoint events by comm (process name)

```bash
# Only block_rq_issue events from fio
echo 'comm == "fio"' > \
  /sys/kernel/debug/tracing/events/block/block_rq_issue/filter
```

`comm` is the 16-character process name from `task->comm`. For multithreaded applications, all threads share the same `comm` (unless renamed with `prctl`).

### Filter by PID in tracepoint events

```bash
echo 'common_pid == 12345' > \
  /sys/kernel/debug/tracing/events/block/block_rq_issue/filter
```

`common_pid` is available in every tracepoint event — it is the PID of the task that triggered the event. Combine conditions with `&&`:

```bash
echo 'common_pid == 12345 && nr_sector > 8' > \
  /sys/kernel/debug/tracing/events/block/block_rq_issue/filter
```

### Filter format

Filter expressions use C-like operators: `==`, `!=`, `<`, `>`, `<=`, `>=`, `&&`, `||`. String fields support `~` for glob matching:

```bash
echo 'comm ~ "java*"' > \
  /sys/kernel/debug/tracing/events/block/block_rq_issue/filter
```

See available fields for any event:

```bash
cat /sys/kernel/debug/tracing/events/block/block_rq_issue/format
```

---

## Stack traces: who is calling a function

### Enable per-hit stack traces

```bash
# Who calls submit_bio?
echo submit_bio > /sys/kernel/debug/tracing/set_ftrace_filter
echo function > /sys/kernel/debug/tracing/current_tracer
echo 1 > /sys/kernel/debug/tracing/options/func_stack_trace
echo 1 > /sys/kernel/debug/tracing/tracing_on

# Short workload
dd if=/tmp/testfile of=/dev/null bs=4k count=100

echo 0 > /sys/kernel/debug/tracing/tracing_on
cat /sys/kernel/debug/tracing/trace | head -60
```

Output:

```
              dd-22831 [000] .....  9012.345678: submit_bio <-submit_bh
              dd-22831 [000] .....  9012.345678: <stack trace>
 => submit_bio
 => submit_bh
 => __block_write_begin_int
 => block_write_begin
 => ext4_write_begin
 => generic_perform_write
 => ext4_buffered_write_iter
 => ext4_file_write_iter
 => new_sync_write
 => vfs_write
 => ksys_write
 => __x64_sys_write
 => do_syscall_64
```

Stack traces are recorded on every function invocation, so they can add significant overhead if the function is called at high frequency. Always use a short capture window or combine with PID filtering.

### Stack trace on a tracepoint

For tracepoints rather than function calls, use the `stacktrace` trigger:

```bash
echo stacktrace > \
  /sys/kernel/debug/tracing/events/block/block_rq_issue/trigger
```

This appends a stack trace to every `block_rq_issue` event. Limit to one call site:

```bash
# Capture at most 5 stack samples
echo 'stacktrace:5' > \
  /sys/kernel/debug/tracing/events/block/block_rq_issue/trigger
```

---

## Common recipes

### Find the slowest block I/O requests

Use `trace-cmd` to capture issue and complete timestamps, then compute latencies:

```bash
trace-cmd record \
  -e block:block_rq_issue \
  -e block:block_rq_complete \
  sleep 10

trace-cmd report | awk '
BEGIN { OFS="\t" }
/block_rq_issue/ {
    match($0, /[0-9]+\.[0-9]+/)
    ts = substr($0, RSTART, RLENGTH)
    match($0, /[0-9]+,[ \t]*[0-9]+/)
    dev = substr($0, RSTART, RLENGTH)
    match($0, /[0-9]+ \+ [0-9]+/)
    sect = substr($0, RSTART, RLENGTH)
    key = dev ":" sect
    issue[key] = ts
}
/block_rq_complete/ {
    match($0, /[0-9]+\.[0-9]+/)
    ts = substr($0, RSTART, RLENGTH)
    match($0, /[0-9]+,[ \t]*[0-9]+/)
    dev = substr($0, RSTART, RLENGTH)
    match($0, /[0-9]+ \+ [0-9]+/)
    sect = substr($0, RSTART, RLENGTH)
    key = dev ":" sect
    if (key in issue) {
        lat = (ts - issue[key]) * 1000   # ms
        print lat, key
        delete issue[key]
    }
}
' | sort -rn | head -20
```

### Detect fsync calls and their cost

```bash
echo 1 > /sys/kernel/debug/tracing/events/syscalls/sys_enter_fsync/enable
echo 1 > /sys/kernel/debug/tracing/events/syscalls/sys_exit_fsync/enable
cat /sys/kernel/debug/tracing/trace_pipe
```

Each `sys_exit_fsync` event carries `ret` — the return value (0 on success, negative errno on failure). Pair `enter` and `exit` timestamps by `common_pid` to measure per-fsync latency.

For a histogram of fsync durations using synthetic events:

```bash
echo 'fsync_lat u64 delta' > /sys/kernel/debug/tracing/synthetic_events

echo 'hist:keys=common_pid:ts0=common_timestamp.usecs' > \
  /sys/kernel/debug/tracing/events/syscalls/sys_enter_fsync/trigger

echo 'hist:keys=common_pid:delta=common_timestamp.usecs-$ts0:onmatch(syscalls.sys_enter_fsync).fsync_lat(delta)' > \
  /sys/kernel/debug/tracing/events/syscalls/sys_exit_fsync/trigger

echo 1 > /sys/kernel/debug/tracing/events/synthetic/fsync_lat/enable

# Run workload with heavy fsync
fio --name=sync --ioengine=sync --rw=write --bs=4k --size=256m \
    --fsync=1 --runtime=30 --time_based

cat /sys/kernel/debug/tracing/trace_pipe | grep fsync_lat | head -20
```

### Correlate user PID to block requests

Build a histogram mapping PID → I/O operations to identify which process is generating block I/O:

```bash
echo 'hist:keys=common_pid,rwbs:vals=hitcount:sort=hitcount:desc' > \
  /sys/kernel/debug/tracing/events/block/block_rq_issue/trigger

sleep 30

cat /sys/kernel/debug/tracing/events/block/block_rq_issue/hist
```

Output:

```
{ common_pid:  12345, rwbs: "R"  } hitcount:      18234
{ common_pid:  12345, rwbs: "W"  } hitcount:       4821
{ common_pid:   9871, rwbs: "RA" } hitcount:       3104
```

Cross-reference PIDs with process names:

```bash
cat /proc/12345/comm
# fio
```

### Trace O_DIRECT I/O submissions

O_DIRECT reads and writes bypass the page cache and submit I/O directly from the `blkdev_direct_IO` path. Trace the entry point:

```bash
echo blkdev_direct_IO > /sys/kernel/debug/tracing/set_ftrace_filter
echo function_graph > /sys/kernel/debug/tracing/current_tracer
echo 1 > /sys/kernel/debug/tracing/options/func_stack_trace
echo 1 > /sys/kernel/debug/tracing/tracing_on
```

### Watch read-ahead decisions

```bash
echo 1 > /sys/kernel/debug/tracing/events/filemap/mm_filemap_add_to_page_cache/enable

# Trigger on readahead-originated insertions only
# (readahead sets PG_readahead on the first folio of each window)
echo 1 > /sys/kernel/debug/tracing/events/block/block_rq_issue/enable

# Filter block events to read-ahead requests (rwbs contains 'A')
echo 'rwbs ~ "*A*"' > \
  /sys/kernel/debug/tracing/events/block/block_rq_issue/filter
```

---

## Enabling and disabling events cleanly

### Enable all events in a subsystem

```bash
echo 1 > /sys/kernel/debug/tracing/events/block/enable
echo 1 > /sys/kernel/debug/tracing/events/writeback/enable
```

### Disable all events and reset to nop tracer

```bash
echo 0 > /sys/kernel/debug/tracing/events/enable
echo nop > /sys/kernel/debug/tracing/current_tracer
echo > /sys/kernel/debug/tracing/set_ftrace_filter
echo > /sys/kernel/debug/tracing/set_ftrace_pid
echo 0 > /sys/kernel/debug/tracing/options/func_stack_trace
echo > /sys/kernel/debug/tracing/trace
```

Always reset after a debugging session. Leaving tracing enabled adds overhead and fills the ring buffer.

### A clean start script

```bash
#!/bin/bash
# reset-ftrace.sh — return ftrace to a known-clean state
TRACING=/sys/kernel/debug/tracing

echo 0 > $TRACING/tracing_on
echo nop > $TRACING/current_tracer
echo 0 > $TRACING/events/enable
echo > $TRACING/set_ftrace_filter
echo > $TRACING/set_graph_function
echo > $TRACING/set_ftrace_pid
echo 0 > $TRACING/options/func_stack_trace
echo > $TRACING/trace
echo "ftrace reset."
```

---

## Overhead considerations

ftrace is not zero-cost. Understand the tradeoffs before deploying in production:

| Technique | Overhead | Notes |
|-----------|----------|-------|
| Tracepoints (disabled) | Zero | Static probes; no-ops when disabled |
| Tracepoints (enabled, no filter) | Low–medium | One ring buffer write per event |
| Function tracer | Medium–high | Instruments every call; avoid tracing hot functions without PID filter |
| Function graph tracer | High | Two ring buffer writes per call (entry + exit) |
| Histograms | Low | Aggregation in-kernel; much cheaper than reading trace_pipe |
| `func_stack_trace` | High | Calls `stack_trace_save()` on every hit; avoid on high-frequency functions |

Rules of thumb:

- Use **tracepoints** for production tracing; they have been tuned for low overhead
- Use **histograms** instead of consuming `trace_pipe` when you need aggregates
- Apply **PID or comm filters** before enabling function tracing in production
- Keep **buffer_size_kb** large enough to avoid overruns during the capture window; overruns are reported in `per_cpu/cpuN/stats`

Check for overruns:

```bash
cat /sys/kernel/debug/tracing/per_cpu/cpu0/stats | grep overrun
```

Increase buffer size:

```bash
echo 65536 > /sys/kernel/debug/tracing/buffer_size_kb   # 64 MiB per CPU
```

---

## Key source files

| File | Content |
|------|---------|
| [`kernel/trace/trace.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/trace/trace.c) | Core framework: ring buffer management, `trace_pipe`, `trace` file, tracer registration |
| [`kernel/trace/trace_functions.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/trace/trace_functions.c) | Function and function_graph tracer implementation |
| [`kernel/trace/trace_events.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/trace/trace_events.c) | Tracepoint infrastructure, event enable/disable, filter parsing |
| [`kernel/trace/trace_events_hist.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/trace/trace_events_hist.c) | Histogram triggers, synthetic events, `onmatch` actions |
| [`include/trace/events/block.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/block.h) | Block layer tracepoint definitions: `block_rq_issue`, `block_rq_complete`, `block_bio_*` |
| [`include/trace/events/writeback.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/writeback.h) | Writeback tracepoint definitions |
| [`include/trace/events/filemap.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/trace/events/filemap.h) | Page cache tracepoint definitions |
| [`block/blk-mq.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-mq.c) | blk-mq: calls `trace_block_rq_issue`, `trace_block_rq_complete` |
| [`mm/filemap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/filemap.c) | Page cache: calls `trace_mm_filemap_add_to_page_cache` etc. |

### Further reading

- [ftrace kernel documentation](https://www.kernel.org/doc/html/latest/trace/ftrace.html) — the authoritative reference for all control files
- [Histogram triggers documentation](https://www.kernel.org/doc/html/latest/trace/histogram.html) — full syntax for `hist:`, `onmatch`, and synthetic events
- [trace-cmd manual](https://www.trace-cmd.org/) — `trace-cmd record`, `report`, and `split` usage
- [Brendan Gregg — ftrace](https://www.brendangregg.com/blog/2014-09-11/perf-kernel-line-tracing.html) — practical examples and overhead discussion
- [LWN: Kernel Trace Points](https://lwn.net/Articles/379903/) — background on the tracepoint mechanism
- See [Observability](observability.md) for `blktrace`, `/proc/diskstats`, and `iostat` coverage
- See [Writeback Internals](writeback-internals.md) for the full writeback implementation
- See [Page Cache Internals](page-cache-internals.md) for the page cache data structures traced here
