# ftrace: Function Tracer

> The kernel's built-in function tracing infrastructure

## What ftrace is

ftrace is the kernel's main tracing framework, accessible via tracefs at `/sys/kernel/tracing/`. Created by Steven Rostedt and introduced in Linux 2.6.27 [(commit)](https://git.kernel.org/linus/16444a8a40d4c7b4f6de34af0cae1f76a4f6c901) [(LWN)](https://lwn.net/Articles/290277/), it:

- Records every kernel function call (function tracer)
- Traces execution paths and call graphs (function_graph tracer)
- Provides a ring buffer for low-overhead event collection
- Is the backend for BPF `fentry`/`fexit` (Linux 5.5) [(commit)](https://git.kernel.org/linus/fec56f5890d93fc2ed74166c397dc186b1c25951), kprobes, and tracepoints

## tracefs interface

tracefs was introduced as a standalone filesystem in Linux 4.1 [(commit)](https://git.kernel.org/linus/4282d60689d4f21b40692029080440cc58e8a17d).

```bash
# Mount tracefs (if not already mounted)
mount -t tracefs tracefs /sys/kernel/tracing

# Key files:
/sys/kernel/tracing/
├── current_tracer           # active tracer (nop/function/function_graph/etc.)
├── tracing_on               # 1=enable, 0=disable
├── trace                    # read the trace buffer (blocking)
├── trace_pipe               # stream trace output (consuming read)
├── trace_options            # comma-separated options
├── available_tracers        # list of compiled-in tracers
├── available_filter_funcs   # functions that can be filtered
├── set_ftrace_filter        # limit function tracing to these functions
├── set_ftrace_notrace       # exclude these functions
├── set_graph_function       # function_graph: enter graph at these
├── set_graph_notrace
├── tracing_cpumask          # which CPUs to trace
├── per_cpu/                 # per-CPU ring buffers
│   └── cpu0/
│       ├── trace
│       └── stats
├── events/                  # tracepoint events
│   ├── enable               # enable all events
│   └── syscalls/
│       ├── sys_enter_read/
│       │   ├── enable
│       │   ├── filter
│       │   └── format
│       └── ...
├── instances/               # separate trace instances (non-interfering)
└── snapshot                 # freeze a snapshot of the ring buffer
```

## Function tracer

```bash
# Trace all function calls
echo function > /sys/kernel/tracing/current_tracer
echo 1 > /sys/kernel/tracing/tracing_on
sleep 0.001
echo 0 > /sys/kernel/tracing/tracing_on
cat /sys/kernel/tracing/trace | head -30
# bash-1234  [000] ..... 12345.678901: do_sys_open <-do_open_execat
# bash-1234  [000] ..... 12345.678902: _raw_spin_lock <-jiffies_to_timespec64

# Limit to specific functions
echo "tcp_*" > /sys/kernel/tracing/set_ftrace_filter
echo function > /sys/kernel/tracing/current_tracer
echo 1 > /sys/kernel/tracing/tracing_on

# Filter by module
echo ":mod:ext4" > /sys/kernel/tracing/set_ftrace_filter

# Multiple patterns (append with >>)
echo "schedule" >> /sys/kernel/tracing/set_ftrace_filter

# Clear filter (trace all)
echo "" > /sys/kernel/tracing/set_ftrace_filter
```

## Function graph tracer

Shows call hierarchy and execution time. Added by Frédéric Weisbecker in Linux 2.6.29 [(commit)](https://git.kernel.org/linus/15e6cb3673ea6277999642802406a764b49391b0).

```bash
echo function_graph > /sys/kernel/tracing/current_tracer
echo vfs_read > /sys/kernel/tracing/set_graph_function  # entry point
echo 1 > /sys/kernel/tracing/tracing_on
cat /some/file  # trigger the trace
echo 0 > /sys/kernel/tracing/tracing_on
cat /sys/kernel/tracing/trace
# CPU DURATION              FUNCTION CALLS
#  0  |  8.234 us  |        } /* vfs_read */
#  0  |            |        vfs_read() {
#  0  |            |          rw_verify_area() {
#  0  |  0.512 us  |            security_file_permission();
#  0  |  1.234 us  |          }
#  0  |            |          generic_file_read_iter() {
#  0  |            |            filemap_read() {
```

## How ftrace instruments functions

When `CONFIG_DYNAMIC_FTRACE=y` and `CONFIG_HAVE_FENTRY=y`, the compiler inserts a call to `__fentry__` (or `mcount`) at the start of every traceable function:

```asm
/* Every kernel function begins with: */
func:
    callq   __fentry__      ; 5 bytes (E8 + 4-byte offset)
    ; ... actual function code ...
```

When tracing is disabled, these calls are patched to `nop` instructions at boot time — **zero overhead when not tracing**.

When enabled:
```asm
func:
    callq   ftrace_caller   ; patched back in
```

`ftrace_caller` looks up which tracers are registered for this function and calls them. The patching is done with `text_poke_bp()` — a breakpoint-based patching technique that avoids stopping all CPUs.

Since Linux 5.x with `CONFIG_HAVE_FENTRY`, the compiler uses `__fentry__` (called before the function prologue saves registers) rather than `mcount`, which makes the hook faster and allows reliable stack unwinding.

## Ring buffer

ftrace uses a lockless per-CPU ring buffer (`kernel/trace/ring_buffer.c`):

```c
/* Architecture: */
struct ring_buffer {
    struct ring_buffer_per_cpu *buffers[NR_CPUS];
};

struct ring_buffer_per_cpu {
    /* Writer: */
    unsigned long   tail_page;   /* current write page */
    unsigned long   commit_page; /* last committed page */
    /* Reader: */
    unsigned long   reader_page;
    unsigned long   head_page;
    /* ... */
};
```

- Each CPU writes to its own buffer (no lock contention)
- Ring behavior: old events are overwritten when full (unless `trace_options` has `overwrite` disabled)
- Events are timestamped with per-CPU clock

```bash
# Check buffer size
cat /sys/kernel/tracing/buffer_size_kb
# 1408 (per CPU)

# Increase for long captures
echo 65536 > /sys/kernel/tracing/buffer_size_kb
```

## Dynamic events: kprobe_events and uprobe_events

```bash
# Add a kprobe on tcp_sendmsg: print first argument (sk)
echo 'p:my_probe tcp_sendmsg sk=%di' > /sys/kernel/tracing/kprobe_events
echo 1 > /sys/kernel/tracing/events/kprobes/my_probe/enable

cat /sys/kernel/tracing/trace_pipe
# bash-1234 [000] ..... 12345.0: my_probe: (tcp_sendmsg+0x0) sk=0xffff888...

# Remove the probe
echo '-:my_probe' >> /sys/kernel/tracing/kprobe_events

# Add a kretprobe: print return value
echo 'r:my_ret tcp_sendmsg retval=$retval' > /sys/kernel/tracing/kprobe_events

# Add uprobe
echo 'p:myapp /usr/bin/myapp:0x1234 arg1=%di' > /sys/kernel/tracing/uprobe_events
```

## Event tracing: tracepoints

```bash
# List available tracepoint events
ls /sys/kernel/tracing/events/

# Enable all events in a subsystem
echo 1 > /sys/kernel/tracing/events/block/enable

# Enable a specific event
echo 1 > /sys/kernel/tracing/events/syscalls/sys_enter_read/enable

# Filter: only events from PID 1234
echo "common_pid == 1234" > /sys/kernel/tracing/events/syscalls/sys_enter_read/filter

# View event format
cat /sys/kernel/tracing/events/syscalls/sys_enter_read/format
# name: sys_enter_read
# ID: 682
# format:
#     field:unsigned short common_type;    offset:0; size:2; signed:0;
#     field:unsigned char common_flags;    offset:2; size:1; signed:0;
#     field:unsigned char common_preempt_count;  offset:3; size:1; signed:0;
#     field:int common_pid;                offset:4; size:4; signed:1;
#     field:int __syscall_nr;              offset:8; size:4; signed:1;
#     field:unsigned int fd;               offset:16; size:8; signed:0;
#     field:char * buf;                    offset:24; size:8; signed:0;
#     field:size_t count;                  offset:32; size:8; signed:0;
```

## trace-cmd: the ftrace frontend

```bash
# Record syscalls for 5 seconds
trace-cmd record -e 'syscalls:sys_enter_*' sleep 5

# Record function graph for ext4
trace-cmd record -p function_graph -l "ext4_*" sleep 1

# Report
trace-cmd report | head -50

# Filter by CPU
trace-cmd report --cpu 0 | head -20

# Live tracing
trace-cmd stream -e sched:sched_switch

# kernel-shark: GUI frontend for trace-cmd output
kernelshark trace.dat
```

## trace instances: non-interfering sessions

```bash
# Create a private instance (doesn't affect the global trace)
mkdir /sys/kernel/tracing/instances/myinstance

# Each instance has its own ring buffer and tracer
echo function > /sys/kernel/tracing/instances/myinstance/current_tracer
echo "net_*" > /sys/kernel/tracing/instances/myinstance/set_ftrace_filter
echo 1 > /sys/kernel/tracing/instances/myinstance/tracing_on

# Multiple tools can trace simultaneously without interfering
cat /sys/kernel/tracing/instances/myinstance/trace_pipe &
# ... while main trace continues normally ...

rmdir /sys/kernel/tracing/instances/myinstance  # cleanup
```

## Further reading

- [Kprobes and Tracepoints](kprobes-tracepoints.md) — Dynamic and static event hooks
- [perf Events](perf-events.md) — Hardware PMU and sampling
- [BPF: Architecture](../bpf/bpf-overview.md) — BPF programs attached to fentry/fexit
- `Documentation/trace/ftrace.rst` — kernel documentation
