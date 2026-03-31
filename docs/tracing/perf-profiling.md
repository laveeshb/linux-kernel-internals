# perf Profiling Advanced

> Flame graphs, off-CPU analysis, memory profiling, and scheduler tracing

## perf record basics (recap)

```bash
# CPU profiling: sample at 99Hz for 30 seconds
perf record -F 99 -a -g -- sleep 30

# Profile a specific command
perf record -F 999 -g ./my_program

# Read report
perf report --stdio | head -50
```

See [perf Events](perf-events.md) for fundamentals. This page covers advanced analysis.

## Flame graphs: visualizing CPU time

Flame graphs show the call stack hierarchy of where CPU time is spent. The x-axis is time (sorted alphabetically, not temporally); width represents time spent.

### Generating flame graphs

```bash
# 1. Record with call graphs
perf record -F 99 -a -g -- sleep 30
# or for a specific process:
perf record -F 99 -g -p <pid> -- sleep 30

# 2. Convert to flame graph format (Brendan Gregg's tools)
# Install: git clone https://github.com/brendangregg/FlameGraph
perf script | \
    /path/to/FlameGraph/stackcollapse-perf.pl | \
    /path/to/FlameGraph/flamegraph.pl > cpu-flamegraph.svg

# Open in browser
open cpu-flamegraph.svg  # or firefox, chromium
```

### Differential flame graphs

Compare before/after a change:

```bash
# Before change
perf record -F 99 -g -o before.data -- ./workload
perf script -i before.data | stackcollapse-perf.pl > before.folded

# After change
perf record -F 99 -g -o after.data -- ./workload
perf script -i after.data | stackcollapse-perf.pl > after.folded

# Generate differential flame graph
difffolded.pl before.folded after.folded | flamegraph.pl > diff.svg
# Red = regressions (more time), Blue = improvements (less time)
```

### Kernel symbols in flame graphs

```bash
# Ensure kernel symbols are readable:
echo 0 > /proc/sys/kernel/kptr_restrict
echo -1 > /proc/sys/kernel/perf_event_paranoid

# For kernel modules: load debug symbols
modprobe --force-modversion mymodule
```

## Off-CPU analysis: where threads are blocked

**On-CPU** profiling shows where CPU time is spent. **Off-CPU** analysis shows where threads are *sleeping* — waiting for I/O, locks, page faults, etc.

### Off-CPU with perf sched

```bash
# Record scheduler events
perf sched record -- sleep 10

# Show off-CPU time (time waiting to be scheduled)
perf sched latency | head -30
# -------------------------------------------------
# Task                  |   Runtime ms  | Switches | Average delay ms | Maximum delay ms |
# -------------------------------------------------
# myapp:1234            |     1234.567  |     8901 |          0.138  |          12.345  |

# Flame graph for scheduler latency
perf sched script | \
    stackcollapse-perf-sched.pl | \
    flamegraph.pl --color=io > offcpu-flamegraph.svg
```

### Off-CPU with BPF (bpftrace)

```bash
# Trace time sleeping in do_nanosleep:
bpftrace -e '
kprobe:do_nanosleep { @start[tid] = nsecs; }
kretprobe:do_nanosleep /@start[tid]/
{
    @sleep_ms = hist((nsecs - @start[tid]) / 1000000);
    delete(@start[tid]);
}'

# Off-CPU profiling: sample stacks at blocking points
bpftrace -e '
tracepoint:sched:sched_switch
/args->prev_state != 0 && args->prev_pid > 0/
{
    @stacks[ustack, kstack, args->prev_comm] = sum(1);
}'
```

### Off-CPU with BCC offcputime

```bash
# Install BCC tools
apt install bpfcc-tools python3-bpfcc

# Profile off-CPU time for 30 seconds
offcputime-bpfcc -f 30 | flamegraph.pl --color=io --title="Off-CPU Time" > offcpu.svg
offcputime-bpfcc -f -p <pid> 30 > off-cpu.folded
```

## Memory profiling

### Finding memory allocations with perf mem

```bash
# Record memory access events (requires hardware PMU support)
perf mem record -a -- sleep 5
perf mem report | head -30

# Loads and stores with latency:
perf c2c record -g -a -- sleep 5
perf c2c report   # cache-to-cache transfer analysis
```

### perf malloc sampling

```bash
# Profile malloc calls using uprobes
perf probe -x /lib/x86_64-linux-gnu/libc.so.6 malloc
perf record -e probe_libc:malloc -a -g -- sleep 5
perf report

# Or with BCC:
memleak-bpfcc -p <pid> 10
# TOP 10 stacks with outstanding allocations:
#    bytes      count     stack
#  1048576        100     malloc -> myapp_allocate_buffer -> main
```

### Tracking page faults

```bash
# Count page faults per process
perf stat -e page-faults,major-faults -p <pid> sleep 5

# Find where page faults occur
perf record -e page-faults -g -p <pid> -- sleep 5
perf report | head -20

# Minor vs major faults with bpftrace:
bpftrace -e '
tracepoint:exceptions:page_fault_user
{
    /* error_code bit 0: protection violation (1) vs not-present (0) — not minor/major */
    @faults[comm, args->error_code & 4 ? "user" : "kernel"] = count();
}'
```

## Scheduler analysis

### Visualizing context switches

```bash
# Record scheduler events for a process
perf sched record -p <pid> -- sleep 5

# Show timeline: when was the task running vs sleeping?
perf sched timehist | head -40
# time   cpu   task name    wait time  sch delay  run time
# ...    ...   myapp:1234   0.045ms    0.002ms    1.234ms

# Replay in slow motion (simulation mode):
perf sched replay
```

### Finding scheduler wakeup latency

```bash
# Record wakeup events
perf record -e sched:sched_wakeup,sched:sched_switch -a -g -- sleep 10

# Analyze with script
perf script | awk '
/sched_wakeup/ { wake[$3] = $1 }
/sched_switch/ { if ($6 in wake) { print $6, $1 - wake[$6], "ms wakeup latency"; delete wake[$6] } }
'
```

### runqlat: run queue latency histogram

```bash
# BCC tool: histogram of time tasks wait in run queue
runqlat-bpfcc 5
# Tracing run queue latency... Hit Ctrl-C to end.
# usecs               : count     distribution
#     0 -> 1          : 12345    |******************************|
#     2 -> 3          : 4567     |***********                   |
#     4 -> 7          : 1234     |***                           |
#     8 -> 15         : 89       |                              |
#    16 -> 31         : 12       |                              |
#   64 -> 127         : 2        |                              |
# 2048 -> 4095        : 1        |                              |  ← problem!

# bpftrace equivalent:
bpftrace -e '
tracepoint:sched:sched_wakeup,
tracepoint:sched:sched_wakeup_new
{ @qtime[args->pid] = nsecs; }

tracepoint:sched:sched_switch
{
    if (@qtime[args->next_pid]) {
        @usecs = hist((nsecs - @qtime[args->next_pid]) / 1000);
        delete(@qtime[args->next_pid]);
    }
}'
```

## Profiling with hardware counters

```bash
# Branch mispredictions (CPU pipeline stalls)
perf stat -e branch-misses,branches ./my_program
# branch-misses: 1,234,567  #  12.34% of all branches

# Cache misses
perf stat -e L1-dcache-load-misses,L1-dcache-loads,
              LLC-load-misses,LLC-loads ./my_program

# TLB misses (expensive: triggers page table walk)
perf stat -e dTLB-load-misses,dTLB-loads ./my_program

# Instruction-level profiling:
perf record -e cycles:pp -g ./my_program   # precise sampling
perf report --sort=sym,dso --stdio
```

### perf annotate: hot instruction identification

```bash
# See which instructions are hottest
perf record -F 999 -g ./my_program
perf annotate --stdio | head -60

# Output:
#  Percent |     Source code & Disassembly of my_program for cycles
# -------------------------
#          :    for (i = 0; i < N; i++) {
#   42.34  :      400b23:  mov    (%rax,%rdx,8),%rcx   ← hot load
#    0.01  :      400b27:  add    %rcx,%rbx
#    0.12  :      400b2a:  inc    %rdx
```

## Linux perf for Java/JVM

```bash
# Enable JIT symbol mapping (requires perf-map-agent or async-profiler):
java -XX:+PreserveFramePointer \
     -agentpath:/path/to/libperfmap.so \
     MyApp &

# Record and generate flame graph
perf record -F 99 -g -p $(pgrep java) -- sleep 30
perf script | stackcollapse-perf.pl | flamegraph.pl > java-flamegraph.svg

# async-profiler (better for JVM):
./profiler.sh -d 30 -f flamegraph.html $(pgrep java)
```

## perf top: live profiling

```bash
# Live CPU usage by function (like 'top' for functions)
perf top

# Per-thread breakdown
perf top -t <tid>

# Hide kernel symbols (user-space only)
perf top -K

# Show assembly
perf top --disassembler-style=att
```

## Further reading

- [perf Events](perf-events.md) — perf fundamentals, hardware counters
- [ftrace Advanced](ftrace-advanced.md) — in-kernel histograms, function_graph
- [Kprobes and Tracepoints](kprobes-tracepoints.md) — adding custom tracepoints
- [MM Tracepoints](../mm/mm-tracepoints.md) — memory-specific tracing
- [Scheduler Tracing](../sched/sched-tracing.md) — scheduler-specific perf
- FlameGraph: `https://github.com/brendangregg/FlameGraph`
- BCC tools: `https://github.com/iovisor/bcc`
