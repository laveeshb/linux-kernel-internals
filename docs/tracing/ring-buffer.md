# The ftrace Ring Buffer and tracefs

> How the kernel records millions of trace events per second — from any context, with almost no overhead — and the filesystem you steer it through

Tracing has a brutal constraint: the instrumentation has to be *cheaper* than the thing it measures, and it has to work in **any** context — process, softirq, hard IRQ, even NMI — without ever taking a lock that could deadlock. A naive global, mutex-protected buffer fails on both counts. The data structure that solves it is the **ftrace ring buffer** ([`kernel/trace/ring_buffer.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/trace/ring_buffer.c)), and **tracefs** is the interface you drive it through.

## Per-CPU and lockless

Two design decisions make the buffer fast enough to leave on in production:

- **Per-CPU.** Each CPU writes into its *own* ring buffer, so two CPUs tracing at once never contend — no shared lock, no cache line bouncing between cores. The cost is that reassembling a global, time-ordered view happens later, at read time, by merging the per-CPU streams.
- **Lockless writes.** Within a CPU, recording an event is a **reserve/commit** protocol built on local atomic operations, not a lock:

  1. `ring_buffer_lock_reserve()` reserves space for an event,
  2. the caller writes the event payload into that space,
  3. `ring_buffer_unlock_commit()` finalizes it.

Because the protocol is per-CPU and lockless, it is safe for a hard IRQ — or even an NMI — to record an event *while it has interrupted another write on the same CPU*. The buffer is explicitly designed to handle these nested writes, which is exactly the property a global lock could never provide.

## Sub-buffers

A per-CPU buffer is a ring of page-sized **sub-buffers**. Events pack tightly into the current page; when it fills, the writer advances to the next page in the ring. Because reading and writing operate on *different* pages, a consumer can lift completed pages out while the producer keeps filling new ones — no coordination on the hot path.

## Two modes: flight recorder vs. lossless

What happens when the buffer fills depends on the mode:

- **Overwrite (the default)** — the buffer is a circular "flight recorder": once full, the oldest events are overwritten to make room. You always have the most *recent* history, which is what you want when arming a trace and waiting for a rare event to reproduce.
- **Producer/consumer** — writing stops (events are dropped and counted) rather than overwriting, so nothing already recorded is lost. You choose this when you must not miss events and have a consumer draining the buffer fast enough.

Buffer size is per-CPU and set through `buffer_size_kb`; the trade is memory for history.

## Reading: `trace` vs. `trace_pipe`

tracefs exposes the buffer two ways, and the distinction matters:

- **`trace`** — a *non-consuming snapshot*. Reading it does not remove events, so you can `cat` it repeatedly and diff the output. Good for "arm, reproduce, then inspect."
- **`trace_pipe`** — a *consuming, blocking stream*. Events are delivered as they arrive and are gone once read. This is the live-tail interface, the one to pipe into a tool.
- **`per_cpu/cpuN/trace`** — the raw single-CPU streams, before any global merge.

## tracefs: the control surface

Everything is steered through `/sys/kernel/tracing`:

| File | Purpose |
|---|---|
| `current_tracer` | select the active tracer (`function`, `function_graph`, `nop`, …) |
| `tracing_on` | master on/off switch (write `0`/`1`) |
| `buffer_size_kb` | per-CPU buffer size |
| `options/` | toggles, including overwrite mode |
| `trace_marker` | write to it to inject *your own* event into the timeline |
| `instances/` | create independent buffers so two tools don't fight over one |

`instances/` is the quietly important one: each instance is a fully separate ring buffer with its own tracer and events, so a background tracer and an ad-hoc investigation can run at once without corrupting each other's captures.

## Try it yourself

```bash
cd /sys/kernel/tracing

# grow the per-CPU buffer to 8 MB for a longer history
echo 8192 > buffer_size_kb

# live-tail scheduler switches as they happen (consuming read)
echo 1 > events/sched/sched_switch/enable
cat trace_pipe        # Ctrl-C to stop

# an isolated instance that won't disturb the main buffer
mkdir instances/myprobe
echo 1 > instances/myprobe/events/block/block_rq_issue/enable
cat instances/myprobe/trace
```

## Further reading

- [Kernel docs: ring buffer design](https://docs.kernel.org/trace/ring-buffer-design.html) — the lockless algorithm in full
- [`kernel/trace/ring_buffer.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/trace/ring_buffer.c) — the implementation
- [ftrace](ftrace.md) — the tracer that fills this buffer
