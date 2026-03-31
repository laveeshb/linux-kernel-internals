# ftrace Advanced: Histograms, Triggers, and Function Tracing

> Beyond basic tracing: aggregating data in-kernel without overhead

## ftrace recap

The basic ftrace interface lives at `/sys/kernel/debug/tracing/`. The [ftrace basics page](ftrace.md) covers the foundational setup. This page covers advanced features: in-kernel histograms, triggers, synthetic events, and the `function_graph` tracer.

## Event triggers

Triggers execute actions when a tracepoint fires, without copying data to the trace buffer:

```bash
# Trigger format: echo "action[:count]" > events/.../trigger
# Actions: traceon, traceoff, snapshot, stacktrace, hist:...

# Enable tracing when a specific process does a write():
echo 'traceon if comm == "myapp"' > \
    events/syscalls/sys_enter_write/trigger

# Take a stack trace on every kmalloc > 1MB:
echo 'stacktrace if bytes_req > 1048576' > \
    events/kmem/kmalloc/trigger

# Disable trigger:
echo '!stacktrace if bytes_req > 1048576' > \
    events/kmem/kmalloc/trigger
```

## Histogram triggers (hist:)

Histograms aggregate event data **in the kernel**, reducing overhead compared to reading individual events:

### Count by key

```bash
# Count syscalls by PID
echo 'hist:keys=pid' > events/raw_syscalls/sys_enter/trigger
sleep 5
cat events/raw_syscalls/sys_enter/hist
# { pid:   1234 } hitcount:   4521
# { pid:   5678 } hitcount:    891
# Totals: Hits: 5412, Entries: 2

# Count by syscall number
echo 'hist:keys=id' > events/raw_syscalls/sys_enter/trigger
cat events/raw_syscalls/sys_enter/hist
# { id:        0 } hitcount:  12345  # read
# { id:        1 } hitcount:   8901  # write
```

### Aggregate values

```bash
# Sum bytes written per PID
echo 'hist:keys=common_pid:vals=count:sort=count.descending' > \
    events/syscalls/sys_enter_write/trigger

# Latency histogram: how long does write() take?
echo 'hist:keys=common_pid:vals=lat:sort=lat' > \
    events/syscalls/sys_exit_write/trigger

# Track kmalloc sizes: sum bytes per call_site
echo 'hist:keys=call_site.sym:vals=bytes_req:sort=bytes_req.descending' > \
    events/kmem/kmalloc/trigger
cat events/kmem/kmalloc/hist
# { call_site: ext4_write_begin [ext4] } bytes_req:  1048576
# { call_site: tcp_sendmsg              } bytes_req:   524288
```

### Two-event latency measurement

Measure time between pairs of events using `onmatch`:

```bash
# Measure read() latency: time from sys_enter to sys_exit
echo 'hist:keys=common_pid:ts0=common_timestamp.usecs' > \
    events/syscalls/sys_enter_read/trigger

echo 'hist:keys=common_pid:
    vals=lat:
    lat=common_timestamp.usecs-$ts0:
    onmatch(syscalls.sys_enter_read).trace(read_lat,$lat)' > \
    events/syscalls/sys_exit_read/trigger

# Or directly show the latency histogram:
echo 'hist:keys=lat:
    lat=common_timestamp.usecs-$ts0.usecs:
    onmatch(syscalls.sys_enter_read).save(comm)' > \
    events/syscalls/sys_exit_read/trigger
```

### Synthetic events: derived events from two sources

```bash
# Create a synthetic event that fires with latency data
echo 'wakeup_latency u64 lat; pid_t pid; char comm[16]' > \
    synthetic_events

# Record start time on wakeup:
echo 'hist:keys=pid:wakeup_ts=common_timestamp.usecs' > \
    events/sched/sched_waking/trigger

# On schedule-in: compute latency, fire synthetic event
echo 'hist:keys=next_pid:
    wakeup_lat=common_timestamp.usecs-$wakeup_ts:
    onmatch(sched.sched_waking).wakeup_latency($wakeup_lat,next_pid,next_comm)' > \
    events/sched/sched_switch/trigger

# Enable the synthetic event
echo 1 > events/synthetic/wakeup_latency/enable
cat trace
# wakeup_latency: lat=45 pid=1234 comm=myapp
```

## function_graph tracer

`function_graph` traces both function entry and exit, showing the call tree with duration:

```bash
# Enable function_graph tracer
echo function_graph > current_tracer

# Run a command
bash -c 'ls /tmp > /dev/null'

cat trace | head -30
# # tracer: function_graph
# #
# CPU  DURATION                  FUNCTION CALLS
# |    |   |                     |   |   |   |
# 0)   1.827 us   |            _raw_spin_lock_irqsave();
# 0)   5.380 us   |          } /* _raw_spin_unlock_irqrestore */
# 0) + 12.345 us  |        } /* mutex_lock */
# 0)              |        vfs_read() {
# 0)              |          rw_verify_area() {
# 0)   0.384 us   |            security_file_permission();
# 0)   2.183 us   |          } /* rw_verify_area */
# 0)              |          new_sync_read() {
# 0)   0.234 us   |            __vfs_read();
# 0) + 45.123 us  |          } /* new_sync_read */
# 0) + 52.456 us  |        } /* vfs_read */
```

`+` = >10µs, `!` = >100µs, `#` = >1ms, `$` = >10ms

### Filter to specific functions

```bash
# Trace only VFS and ext4 functions
echo 'vfs_* ext4_*' > set_ftrace_filter

# Trace a specific function and its callees
echo vfs_read > set_graph_function

# Exclude internal functions (too noisy):
echo '__irq_*' > set_graph_notrace
```

## function tracer with call graph

The `function` tracer records every function call (very high overhead):

```bash
echo function > current_tracer

# Limit to specific functions to reduce overhead:
echo vfs_read > set_ftrace_filter
echo 1 > function_profile_enabled

# Wait, then show profile:
cat trace_stat/function0 | sort -k2 -n -r | head -20
# Function                 Hit    Time      Avg
# vfs_read              12345  123456us   10.0us
```

### Dynamic function tracing

```bash
# Trace all calls to a specific module's functions:
echo ':mod:ext4' > set_ftrace_filter

# Trace functions matching a pattern:
echo '*alloc*page*' > set_ftrace_filter

# Show available functions:
cat available_filter_functions | grep 'ext4_'
```

## Stack tracer: find stack depth offenders

```bash
# Enable stack tracer (built as module or CONFIG_STACK_TRACER)
echo 1 > /proc/sys/kernel/stack_tracer_enabled

# See maximum stack depth seen
cat stack_trace
# Depth    Size   Location    (42 entries)
# -----    ----   --------
#     0    6560   interrupt_entry+0x1a/0x20
#     1    6536   do_IRQ+0x41/0xd0
#     ...

# Sort by stack depth
cat stack_max_size
# 6560
```

## trace-cmd: scripted ftrace

`trace-cmd` is a userspace wrapper that simplifies ftrace usage:

```bash
# Record write() latency for 5 seconds
trace-cmd record -e syscalls:sys_enter_write \
                 -e syscalls:sys_exit_write \
                 -p function_graph \
                 -g vfs_write \
                 sleep 5

# View the report
trace-cmd report | head -50

# Visualize with KernelShark (GUI)
kernelshark trace.dat
```

## perf with ftrace

```bash
# perf ftrace: uses ftrace under the hood
perf ftrace -G vfs_read,vfs_write ls /tmp

# Function latency profiling
perf ftrace latency -T vfs_read -- dd if=/dev/zero of=/dev/null bs=4k count=10000
```

## Further reading

- [ftrace](ftrace.md) — ftrace basics and setup
- [Kprobes and Tracepoints](kprobes-tracepoints.md) — adding tracepoints to kernel code
- [perf Events](perf-events.md) — perf-based profiling
- [perf Profiling Advanced](perf-profiling.md) — flame graphs and off-CPU analysis
- `Documentation/trace/histogram.rst` — histogram trigger documentation
- `Documentation/trace/ftrace.rst` — full ftrace documentation
