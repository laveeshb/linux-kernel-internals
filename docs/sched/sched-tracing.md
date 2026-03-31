# Scheduler Tracing

> ftrace, perf, and BPF tools for observing scheduler behavior in real time

## Scheduler trace events

The kernel emits scheduler events through the tracepoint system (ftrace). These are defined in `include/trace/events/sched.h` and cover every significant scheduling decision.

Key events:

| Event | When it fires |
|-------|---------------|
| `sched:sched_switch` | Every context switch |
| `sched:sched_wakeup` | Task transitions from sleeping to runnable |
| `sched:sched_wakeup_new` | Newly created task becomes runnable |
| `sched:sched_waking` | Task wakeup starts (before it's on a runqueue) |
| `sched:sched_migrate_task` | Task moves between CPUs |
| `sched:sched_process_fork` | fork() |
| `sched:sched_process_exec` | exec() |
| `sched:sched_process_exit` | Task exits |
| `sched:sched_stat_sleep` | Task woke from voluntary sleep (CONFIG_SCHEDSTATS) |
| `sched:sched_stat_wait` | Time spent waiting on runqueue (CONFIG_SCHEDSTATS) |
| `sched:sched_stat_iowait` | Time spent in I/O wait (CONFIG_SCHEDSTATS) |

## sched_switch: the most important event

```c
// include/trace/events/sched.h
TRACE_EVENT(sched_switch,
    TP_PROTO(bool preempt,
             struct task_struct *prev,
             struct task_struct *next,
             unsigned int prev_state),
    // Fields:
    // prev_comm, prev_pid, prev_prio, prev_state
    // next_comm, next_pid, next_prio
    //
    // prev_state uses TASK_REPORT flags:
    //   R = running/runnable (preempted)
    //   S = interruptible sleep
    //   D = uninterruptible sleep (I/O)
    //   T = stopped
    //   Z = zombie
);
```

A `prev_state=R` means the task was preempted (involuntary switch). `prev_state=S` means it voluntarily gave up the CPU.

## Recording with ftrace

```bash
# Enable specific events and record for 5 seconds
trace-cmd record -e sched:sched_switch \
                 -e sched:sched_wakeup \
                 -e sched:sched_migrate_task \
                 sleep 5

# View the recording
trace-cmd report | head -50

# Filter by PID
trace-cmd record -e sched:sched_switch \
                 --filter 'next_pid == 1234 || prev_pid == 1234' \
                 sleep 5
```

### Direct ftrace interface

```bash
# Enable events via debugfs
echo 1 > /sys/kernel/debug/tracing/events/sched/sched_switch/enable
echo 1 > /sys/kernel/debug/tracing/events/sched/sched_wakeup/enable

# Read the ring buffer
cat /sys/kernel/debug/tracing/trace

# Or stream it
cat /sys/kernel/debug/tracing/trace_pipe &

# Filter by comm (task name)
echo 'next_comm == "myapp"' > \
    /sys/kernel/debug/tracing/events/sched/sched_switch/filter

# Clean up
echo 0 > /sys/kernel/debug/tracing/events/sched/sched_switch/enable
echo > /sys/kernel/debug/tracing/trace
```

## perf sched: high-level scheduling analysis

`perf sched` records scheduling activity and produces latency reports:

```bash
# Record scheduling events for 10 seconds
perf sched record -- sleep 10

# Show latency report: per-task scheduling delay
perf sched latency
# Task                  |   Runtime ms  | Switches | Average delay ms | Maximum delay ms
# myapp:(2)             |     4500.123  |     1042  |          0.234   |         12.456
# kworker/0:1           |      123.456  |      567  |          0.012   |          0.234

# Replay the recording to see exact scheduling order
perf sched replay

# Show all scheduling events in order
perf sched script | head -20
```

### perf sched latency

High "Maximum delay" for a task means it was occasionally stuck waiting for the CPU for a long time. Common causes:
- CPU temporarily saturated
- Lock contention in the scheduler (rare)
- NUMA migration overhead
- RT task monopolizing the CPU

```bash
# Show tasks with highest maximum latency
perf sched latency --sort max
```

## perf stat for scheduling counters

```bash
# Count context switches and migrations
perf stat -e context-switches,cpu-migrations ./workload

# Count scheduler events system-wide
perf stat -e sched:sched_switch,sched:sched_wakeup,sched:sched_migrate_task \
          -a sleep 10

# Compare voluntary vs involuntary switches (requires cs breakdowns)
perf stat -e sched:sched_switch -a sleep 5
```

## BPF tracing with bpftrace

```bash
# Trace context switches: show who switched to whom
bpftrace -e '
tracepoint:sched:sched_switch {
    printf("%s -> %s\n", args->prev_comm, args->next_comm);
}'

# Show tasks with the longest scheduler wait time (time in runqueue)
bpftrace -e '
tracepoint:sched:sched_wakeup { @start[args->pid] = nsecs; }
tracepoint:sched:sched_switch {
    if (@start[args->next_pid]) {
        @wait_ns[args->next_comm] = hist(nsecs - @start[args->next_pid]);
        delete(@start[args->next_pid]);
    }
}'

# Count migrations per task
bpftrace -e '
tracepoint:sched:sched_migrate_task {
    @[args->comm] = count();
}'
```

## Wakeup latency: runqlat (BCC)

`runqlat` (from the BCC toolkit) measures how long tasks wait in the runqueue before running:

```bash
# Show runqueue latency histogram system-wide
runqlat

# Per-PID histogram
runqlat -p $PID

# Example output:
# usecs               : count     distribution
# 0 -> 1              : 12345     |********************|
# 2 -> 3              : 4567      |*******             |
# 4 -> 7              : 234       |                    |
# 8 -> 15             : 89        |                    |
# 16 -> 31            : 45        |                    |
# 32 -> 63            : 12        |                    |  ← latency spikes here
```

`runqlen` shows the distribution of runqueue lengths:

```bash
runqlen  # shows how many tasks are typically in the runqueue
```

## Wakeup tracing with ftrace function graph

To trace the full wakeup path including kernel functions:

```bash
# Trace the wakeup path for a specific PID
echo function_graph > /sys/kernel/debug/tracing/current_tracer
echo $PID > /sys/kernel/debug/tracing/set_ftrace_pid
echo 1 > /sys/kernel/debug/tracing/tracing_on
# ... run workload ...
cat /sys/kernel/debug/tracing/trace > /tmp/wakeup_trace.txt
echo 0 > /sys/kernel/debug/tracing/tracing_on
echo nop > /sys/kernel/debug/tracing/current_tracer
```

Or use the built-in wakeup tracers:

```bash
# Trace latency from wakeup to first run (worst case)
echo wakeup > /sys/kernel/debug/tracing/current_tracer
# Finds the maximum wakeup latency in microseconds
cat /sys/kernel/debug/tracing/tracing_max_latency
```

## Reading sched_switch output

A typical `trace-cmd report` line:

```
myapp-1234 [002] 12345.678901: sched_switch: prev_comm=myapp prev_pid=1234
    prev_prio=120 prev_state=S ==> next_comm=kworker/2:1 next_pid=5678 next_prio=120
```

Interpretation:
- `myapp` (pid 1234) on CPU 2 switched to sleep (`prev_state=S`)
- `kworker/2:1` (pid 5678) is now running on CPU 2
- Both at priority 120 (nice 0)

If `prev_state=R`, myapp was preempted — it wanted to keep running but something higher priority took over.

## Further reading

- [Scheduler Statistics](schedstat.md) — Cumulative per-task stats in /proc
- [Scheduler Tuning](sched-tuning.md) — Knobs that affect the behavior you're observing
- [Context Switch](context-switch.md) — What the kernel does on each sched_switch event
- [Wakeup](wakeup.md) — The full wakeup path from hardware interrupt to task running
