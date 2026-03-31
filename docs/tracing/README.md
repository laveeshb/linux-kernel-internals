# Kernel Tracing and Observability

> Instrumentation tools for understanding kernel behavior

## The tracing ecosystem

Linux provides multiple complementary tracing mechanisms:

```
                    What you want to observe
                           │
          ┌────────────────┼────────────────────┐
          │                │                    │
    Function calls   Kernel events         Hardware
      kprobe/BPF      tracepoints         perf PMU
      ftrace           TRACE_EVENT         cycles/cache
          │                │                    │
          └────────────────┼────────────────────┘
                           │
                    Collection frontends
                   ┌───────┴──────────┐
                   │                  │
                ftrace              perf
                trace-cmd         bpftrace
                perf-tools           BCC
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [ftrace](ftrace.md) | Function tracing, tracefs, ring buffer, trace-cmd |
| [Kprobes and Tracepoints](kprobes-tracepoints.md) | kprobe/kretprobe, static tracepoints, TRACE_EVENT |
| [perf Events](perf-events.md) | perf_event_open, PMU counters, sampling, flamegraphs |

## Quick reference

```bash
# ftrace: trace all calls to schedule()
echo function > /sys/kernel/tracing/current_tracer
echo schedule > /sys/kernel/tracing/set_ftrace_filter
echo 1 > /sys/kernel/tracing/tracing_on
sleep 1
echo 0 > /sys/kernel/tracing/tracing_on
cat /sys/kernel/tracing/trace | head -20

# perf: CPU cycles profile
perf record -g -F 99 -- sleep 10
perf report

# bpftrace: trace write() calls
bpftrace -e 'tracepoint:syscalls:sys_enter_write { printf("%s %d\n", comm, args->count); }'

# trace-cmd: ftrace frontend
trace-cmd record -e syscalls:sys_enter_read sleep 1
trace-cmd report
```
