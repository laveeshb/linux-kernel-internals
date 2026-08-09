# BPF for Tracing (bpftrace and BCC)

> The modern way to observe Linux: attach a small verified program to almost any event and aggregate the results *in the kernel*

Static tracepoints, ftrace, and perf each capture events and ship them to user space to be counted. That model has a ceiling: at millions of events per second, the buffer writes, the copies, and the user-space parsing become the bottleneck — you spend more measuring than you learn. BPF removes that ceiling, which is why it has become the dominant tracing frontend.

## Why BPF changed tracing

Instead of streaming raw events out, BPF lets you attach a small program that runs **at the event, in the kernel**, and does the aggregation on the spot. A per-CPU map increment replaces a buffer write plus a copy plus a user-space parse — so you read out the *histogram*, not the firehose that produced it.

Two properties make this safe enough for production:

- **The verifier** statically proves the program can't crash the kernel, loop forever, or touch memory it shouldn't — before it's ever attached. (See [BPF](../bpf/README.md) for how the verifier and JIT work.)
- **It's dynamic** — load, attach, detach, all at runtime, no reboot and no module.

## Where you can attach

A tracing BPF program can hook almost anywhere events originate:

- **kprobe / kretprobe** — the entry or return of nearly any kernel function
- **tracepoints** and **raw tracepoints** — the kernel's static instrumentation points
- **fentry / fexit** — a lower-overhead way to trace function entry/exit, built on the same compiler-inserted `__fentry__` hook that [ftrace](ftrace.md) uses; cheaper than kprobes and with typed access to arguments
- **perf events** — PMU counters and timed sampling (for profiling)
- **uprobes / USDT** — user-space functions and static markers

## Maps: aggregation that stays in the kernel

**Maps** are how a program accumulates state across events without involving user space on the hot path — a hash keyed by PID, a per-CPU counter, or a log2 **histogram** of latencies. User space reads the map out once, when you want the answer, not once per event.

## The two toolkits

- **bpftrace** — a high-level, awk-like language for one-liners and short scripts. This is the fast path for interactive investigation.
- **BCC** — a Python/C++ library for building complete, packaged tools; the `bcc-tools` suite (`execsnoop`, `biolatency`, `tcplife`, `runqlat`, …) is written with it.

## In practice

```bash
# Count syscalls by process name
bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }'

# Latency histogram of vfs_read(), in-kernel — fentry/fexit capture entry+exit
bpftrace -e '
  fentry:vfs_read { @start[tid] = nsecs; }
  fexit:vfs_read  /@start[tid]/ {
      @ns = hist(nsecs - @start[tid]); delete(@start[tid]);
  }'

# Who is opening which files
bpftrace -e 'tracepoint:syscalls:sys_enter_openat {
    printf("%s -> %s\n", comm, str(args->filename)); }'
```

Each of these does its counting or bucketing inside the kernel and prints a compact summary on exit — the same questions the [ftrace histogram triggers](ftrace.md) answer, but in a general-purpose language you can extend arbitrarily.

## Where this fits

BPF-for-tracing is the observability-facing use of the general BPF machine. This page is about *using* it to answer questions; for how the verifier, JIT, maps, and program lifecycle actually work, see the [BPF](../bpf/README.md) section.

## Further reading

- [Kernel docs: BPF](https://docs.kernel.org/bpf/index.html) — the subsystem reference
- [bpftrace reference guide](https://github.com/bpftrace/bpftrace/blob/master/man/adoc/bpftrace.adoc) — the language and its probe types
- [BPF](../bpf/README.md) — the verifier, JIT, maps, and program model behind these tools
- [Kprobes and Tracepoints](kprobes-tracepoints.md) — the probe mechanisms BPF attaches to
