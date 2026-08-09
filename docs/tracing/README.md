# Kernel Tracing and Observability

> How to see what the kernel is actually doing — live, in production, without a debugger or a reboot

## Getting Started

You cannot fix what you cannot see. A process stalls, a tail latency spikes, a syscall occasionally hangs — and none of it is visible from user space. Kernel tracing is the set of tools that make the kernel's internal behavior observable: which functions run, which events fire, how long each takes, and what the hardware is doing underneath — on a live system, usually with low enough overhead to leave running in production.

Everything in this section is built on three sources of events and a handful of frontends that collect them:

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

### Where the events come from

- **Static tracepoints** (`TRACE_EVENT`) are instrumentation points that kernel developers placed at meaningful spots — a request queued, a task scheduled, a page faulted. They are stable, self-describing, and nearly free when disabled, which makes them the preferred source for production tracing.
- **Dynamic probes** — **kprobes** (and uprobes in user space) — attach to *almost any* instruction address, giving visibility the kernel authors never anticipated, at the cost of being tied to a specific kernel version.
- **Hardware counters** — the CPU's performance-monitoring unit (PMU), read through **perf**, count cycles, cache misses, and branch mispredictions, and drive sampling profilers.

### The frontends

- **ftrace** — the kernel's built-in tracer, driven through the `tracefs` filesystem at `/sys/kernel/tracing`: function tracing, function-graph, and tracepoint capture with no extra tooling. `trace-cmd` is its friendlier front end.
- **perf** — sampling, PMU counters, and profiling; the source of most flame graphs.
- **BPF** (`bpftrace`, BCC) — the modern, programmable frontend. Instead of shipping raw events to user space, a BPF program runs *in the kernel* at each event and aggregates on the spot — histograms, per-process sums, latency distributions — which is what makes tracing millions of events per second affordable. See [BPF](../bpf/README.md).

### Choosing a tool

| You want to… | Reach for |
|---|---|
| See which functions run and how they nest | [ftrace](ftrace.md) function-graph |
| Aggregate events cheaply (histograms, counts) | [bpftrace / BPF](../bpf/README.md) |
| Probe a spot with no tracepoint | [kprobes](kprobes-tracepoints.md) |
| Profile CPU time / find hot paths | [perf](perf-profiling.md) |
| Trace user-space functions | [uprobes / USDT](uprobes-usdt.md) |

### Prerequisites

Comfort with the shell and basic kernel concepts (processes, syscalls, interrupts). Most tools need root (or `CAP_BPF` / `CAP_PERFMON`). Tracepoint and BPF tooling assumes a kernel built with `CONFIG_FTRACE`, `CONFIG_BPF_SYSCALL`, and friends — standard on every mainstream distribution.

### Suggested reading order

1. **[ftrace](ftrace.md)** — the foundation: tracefs, the ring buffer, and the function tracer
2. **[ftrace Advanced](ftrace-advanced.md)** — function-graph, triggers, and in-kernel aggregation
3. **[Kprobes and Tracepoints](kprobes-tracepoints.md)** — dynamic vs. static instrumentation, and `TRACE_EVENT`
4. **[uprobes and USDT](uprobes-usdt.md)** — reaching into user space
5. **[perf Events](perf-events.md)** — the PMU, sampling, and `perf_event_open()`
6. **[perf Profiling](perf-profiling.md)** — flame graphs and profiling workflows

### What you'll learn

| Question | Where it's answered |
|---|---|
| "Why is this function slow?" | [ftrace function-graph](ftrace-advanced.md) shows the call tree with per-call timing |
| "How do I count events without drowning in output?" | [BPF](../bpf/README.md) aggregates in-kernel — you get the histogram, not the raw stream |
| "There's no tracepoint where I need one" | [kprobes](kprobes-tracepoints.md) attach almost anywhere |
| "Where is the CPU actually spending time?" | [perf](perf-profiling.md) sampling + flame graphs |

## Documentation

| Page | What it covers |
|------|----------------|
| [ftrace](ftrace.md) | Function tracing, tracefs, ring buffer, trace-cmd |
| [ftrace Advanced](ftrace-advanced.md) | Function graph, trigger actions, boot-time tracing |
| [Kprobes and Tracepoints](kprobes-tracepoints.md) | kprobe/kretprobe, static tracepoints, TRACE_EVENT |
| [uprobes and USDT](uprobes-usdt.md) | Userspace probes and static markers |
| [perf Events](perf-events.md) | perf_event_open, PMU counters, sampling, flamegraphs |
| [perf Profiling](perf-profiling.md) | CPU profiling workflows, flamegraph recipes |

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

## Further reading

- [Kernel docs: tracing](https://docs.kernel.org/trace/index.html) — ftrace, kprobes, tracepoints, and more
- [BPF](../bpf/README.md) — the programmable tracing frontend
