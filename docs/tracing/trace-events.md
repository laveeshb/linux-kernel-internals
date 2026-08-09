# Trace Events and Dynamic Events

> The kernel's thousands of built-in instrumentation points — how they're defined, filtered, and triggered — and how to add your own at runtime

The [ring buffer](ring-buffer.md) records events; **trace events** are what fills it. The kernel ships with thousands of them, and lets you attach your own. Understanding this layer is what turns "I can run a canned trace" into "I can ask the kernel a precise question."

## Static trace events: `TRACE_EVENT`

A static trace event is an instrumentation point a kernel developer placed with the `TRACE_EVENT` macro. From one macro the kernel generates three things: the tracepoint call site, a *typed record* of the fields it captures, and a self-describing **format** so tools know how to decode it. Because they're declared deliberately and are essentially free when disabled, static events are the stable, preferred instrumentation for production.

They appear under tracefs, grouped by subsystem:

```
/sys/kernel/tracing/events/
├── sched/
│   ├── sched_switch/
│   │   ├── enable      # write 1 to turn this event on
│   │   ├── filter      # per-event predicate (evaluated in-kernel)
│   │   ├── trigger     # actions to run when the event fires
│   │   └── format      # the field layout, for decoders
│   └── sched_wakeup/
├── block/
├── syscalls/
└── ...
```

Enabling one is a single write:

```bash
echo 1 > /sys/kernel/tracing/events/sched/sched_switch/enable
```

## Filters: decide in-kernel what's worth recording

The `filter` file attaches a predicate that runs **before** the event is written to the buffer. Only matching events cost anything to record — the rest are discarded at the source, which is how you trace a busy event without drowning:

```bash
# only record reads larger than 4 KiB
echo 'count > 4096' > events/syscalls/sys_enter_read/filter
```

Filters reference the event's own fields (the ones listed in `format`) and support the usual comparisons and `&&` / `||`.

## Triggers: act when an event fires

The `trigger` file attaches an *action* to an event. Instead of just recording, the kernel can react:

- `traceon` / `traceoff` — start or stop tracing (e.g. stop the moment a rare error event fires, freezing the flight-recorder history that led up to it)
- `stacktrace` — capture a kernel stack at the event
- `snapshot` — swap the buffer aside for later inspection
- `hist` — build an **in-kernel histogram** keyed by event fields

The histogram trigger is the quietly powerful one: it aggregates in the kernel with no user-space stream and no BPF at all.

```bash
# histogram of read sizes per process, entirely in-kernel
echo 'hist:key=comm:val=count' > events/syscalls/sys_enter_read/trigger
cat events/syscalls/sys_enter_read/hist
```

## Dynamic events: add instrumentation at runtime

When no static event exists where you need one, you can create one on the fly — it then appears under `events/` and behaves exactly like a built-in event (same enable/filter/trigger/format):

- **kprobe events** (`kprobe_events`) — probe an arbitrary kernel function or instruction, capturing chosen arguments
- **uprobe events** (`uprobe_events`) — the same for user-space binaries
- **synthetic events** (`synthetic_events`) — combine fields from *two* events (for example, subtract a start timestamp from an end timestamp to measure a latency)

```bash
# create a kprobe event capturing do_sys_openat2()'s filename argument
echo 'p:myopen do_sys_openat2 file=+0(%si):string' > kprobe_events
echo 1 > events/kprobes/myopen/enable
cat trace_pipe
```

The result is a uniform model: whether an event is a decade-old static tracepoint or one you defined a second ago with a kprobe, it enables, filters, triggers, and decodes through the same tracefs interface. See [kprobes and tracepoints](kprobes-tracepoints.md) for how the underlying probes work.

## Further reading

- [Kernel docs: event tracing](https://docs.kernel.org/trace/events.html) — events, filters, and triggers
- [Kernel docs: histogram triggers](https://docs.kernel.org/trace/histogram.html) — the in-kernel `hist` aggregation
- [Kprobes and Tracepoints](kprobes-tracepoints.md) — the probe mechanisms behind dynamic events
