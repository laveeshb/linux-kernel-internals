# Kprobes and Tracepoints

> Dynamic and static instrumentation points in the kernel

## Why three mechanisms?

kprobes, tracepoints, and BPF are not redundant — they solve different parts of a problem that evolved over a decade.

### kprobes: dynamic but fragile (2000s)

kprobes arrived in Linux 2.6.9 as a way to instrument production kernels without recompilation. A kprobe on `tcp_sendmsg` fires every time that function is called, giving you register state and the ability to run arbitrary code.

The problem: kprobes are inherently unstable. If `tcp_sendmsg` is renamed, inlined by the compiler, or its calling convention changes, the probe silently does nothing or attaches to the wrong place. A tool written against one kernel version often breaks on the next. This made kprobes useful for ad-hoc debugging but unreliable for production monitoring.

### Tracepoints: stable ABI (Linux 2.6.28, 2008)

Mathieu Desnoyers introduced [(LWN)](https://lwn.net/Articles/379903/) the `TRACE_EVENT` infrastructure to give tracing tools a stable surface. A tracepoint like `sched_switch` or `block_rq_issue` is a deliberate, named annotation placed by kernel developers in semantically meaningful locations.

The contract: the tracepoint *name* and its *fields* are stable across kernel versions (treated like a userspace-visible ABI). Tools that attach to `sched_switch` and read `prev_pid`/`next_pid` keep working release after release, regardless of how the surrounding code changes.

The zero-overhead design (jump labels that patch out the entire check when no consumers are registered) meant subsystem maintainers were willing to add tracepoints liberally — they cost nothing when idle.

The limitation: tracepoints only exist where developers placed them. There is no tracepoint for every interesting function, and adding one requires a kernel patch.

### BPF: programmable logic at both layers (Linux 3.18+)

BPF programs can attach to both tracepoints *and* kprobes, but they add a critical capability: instead of just logging every event, a BPF program can aggregate, filter, and compute in-kernel — only sending a summary to userspace.

This turned tracepoints from "fire and log" into "fire and compute." A BPF program on `block_rq_complete` can maintain a per-device latency histogram entirely in kernel memory and expose it as a BPF map. Without BPF, collecting that histogram required copying every raw event to userspace and aggregating there — at high I/O rates, this was prohibitive.

`fentry`/`fexit` (Linux 5.5, 2020) [(commit)](https://git.kernel.org/linus/fec56f5890d93fc2ed74166c397dc186b1c25769) added a fourth layer: BPF programs that attach to any kernel function entry/exit using BTF type information to access typed arguments, without the INT3-trap overhead of kprobes and without needing an explicit `TRACE_EVENT` annotation.

```
kprobes      → attach anywhere, unstable ABI, INT3 overhead
tracepoints  → stable ABI, zero overhead, limited coverage
BPF (kprobe) → programmable kprobes, in-kernel aggregation
BPF (tp)     → programmable tracepoints, structured arguments
fentry/fexit → typed function tracing, minimal overhead
```

The result is a layered system: use tracepoints for stable production instrumentation, kprobes/fentry for deep one-off investigation, and BPF programs to avoid flooding userspace with raw events.

## Kprobes: dynamic probes on any instruction

A kprobe can be attached to any instruction in the kernel (not just function entries). When hit, it calls a handler in your code.

### How kprobes work

```c
/* kernel/kprobes.c: simplified */

/* At probe registration: */
register_kprobe(kp)
  → find instruction at kp->addr
  → copy original instruction (for single-stepping)
  → replace first byte(s) with INT3 (0xCC) breakpoint
  → /* on x86 */

/* At runtime, when INT3 fires: */
do_int3()
  → kprobe_int3_handler()
      → call kp->pre_handler(kp, regs)
      → set up single-step: restore original instruction, set TF flag
      → /* return to single-step the original instruction */
  → after single-step:
      → post_kprobe_handler()
          → call kp->post_handler(kp, regs, 0)
          → restore INT3 breakpoint
```

On x86-64 with `CONFIG_KPROBES_ON_FTRACE`, kprobes at function entry use the existing ftrace hook instead of INT3, eliminating the breakpoint overhead.

### Registering kprobes from a kernel module

```c
/* drivers/mymodule/mymodule.c */
#include <linux/kprobes.h>

static int pre_handler(struct kprobe *p, struct pt_regs *regs)
{
    /* Called BEFORE the probed instruction executes */
    /* regs contains register state at probe point */
    printk(KERN_INFO "kprobe: hit tcp_sendmsg, rdi=0x%lx\n", regs->di);
    return 0;
}

static void post_handler(struct kprobe *p, struct pt_regs *regs,
                          unsigned long flags)
{
    /* Called AFTER the probed instruction executes (single-stepped) */
}

static struct kprobe kp = {
    .symbol_name = "tcp_sendmsg",  /* or .addr = (kprobe_opcode_t *)addr */
    .pre_handler = pre_handler,
    .post_handler = post_handler,
};

static int __init mymodule_init(void)
{
    int ret = register_kprobe(&kp);
    if (ret < 0) {
        pr_err("register_kprobe failed: %d\n", ret);
        return ret;
    }
    pr_info("kprobe registered at %p\n", kp.addr);
    return 0;
}

static void __exit mymodule_exit(void)
{
    unregister_kprobe(&kp);
}
```

### kretprobe: hook on function return

```c
static int entry_handler(struct kretprobe_instance *ri, struct pt_regs *regs)
{
    /* Called on function entry; can store data in ri->data */
    *(ktime_t *)ri->data = ktime_get();
    return 0;
}

static int return_handler(struct kretprobe_instance *ri, struct pt_regs *regs)
{
    /* Called on function return */
    ktime_t start = *(ktime_t *)ri->data;
    long retval = regs_return_value(regs);
    ktime_t elapsed = ktime_sub(ktime_get(), start);

    pr_info("tcp_sendmsg returned %ld, took %lld ns\n",
            retval, ktime_to_ns(elapsed));
    return 0;
}

static struct kretprobe my_kretprobe = {
    .handler     = return_handler,
    .entry_handler = entry_handler,
    .data_size   = sizeof(ktime_t),  /* per-instance data */
    .maxactive   = 20,               /* max concurrent instances */
    .kp.symbol_name = "tcp_sendmsg",
};
```

## Static tracepoints: TRACE_EVENT

Static tracepoints are annotation points compiled into the kernel at specific places. They have:
- Zero overhead when disabled (a single no-op test)
- Rich structured data (not just register dumps)
- Stable ABI (unlike kprobes which depend on function names)

### TRACE_EVENT macro

```c
/* include/trace/events/sched.h */
TRACE_EVENT(sched_switch,

    /* Arguments to the tracepoint call: */
    TP_PROTO(bool preempt,
             struct task_struct *prev,
             struct task_struct *next,
             unsigned int prev_state),

    /* Actual call arguments: */
    TP_ARGS(preempt, prev, next, prev_state),

    /* Fields stored in the ring buffer: */
    TP_STRUCT__entry(
        __array(        char,   prev_comm,  TASK_COMM_LEN   )
        __field(        pid_t,  prev_pid                    )
        __field(        int,    prev_prio                   )
        __field(        long,   prev_state                  )
        __array(        char,   next_comm,  TASK_COMM_LEN   )
        __field(        pid_t,  next_pid                    )
        __field(        int,    next_prio                   )
    ),

    /* Code to copy data into the ring buffer entry: */
    TP_fast_assign(
        memcpy(__entry->next_comm, next->comm, TASK_COMM_LEN);
        __entry->prev_pid   = prev->pid;
        __entry->prev_prio  = prev->prio;
        __entry->prev_state = __trace_sched_switch_state(preempt, prev_state, prev);
        memcpy(__entry->prev_comm, prev->comm, TASK_COMM_LEN);
        __entry->next_pid   = next->pid;
        __entry->next_prio  = next->prio;
    ),

    /* Format string for human-readable output: */
    TP_printk("prev_comm=%s prev_pid=%d prev_prio=%d prev_state=%s%s ==> "
              "next_comm=%s next_pid=%d next_prio=%d",
              __entry->prev_comm, __entry->prev_pid, __entry->prev_prio,
              ...)
);
```

### Adding a tracepoint to your code

```c
/* 1. Define the tracepoint (once, in a header): */
/* include/trace/events/mysubsystem.h */
#undef TRACE_SYSTEM
#define TRACE_SYSTEM mysubsystem

#if !defined(_TRACE_MYSUBSYSTEM_H) || defined(TRACE_HEADER_MULTI_READ)
#define _TRACE_MYSUBSYSTEM_H

#include <linux/tracepoint.h>

TRACE_EVENT(my_event,
    TP_PROTO(int value, const char *name),
    TP_ARGS(value, name),
    TP_STRUCT__entry(
        __field(int, value)
        __string(name, name)  /* variable-length string */
    ),
    TP_fast_assign(
        __entry->value = value;
        __assign_str(name, name);
    ),
    TP_printk("value=%d name=%s", __entry->value, __get_str(name))
);

#endif /* _TRACE_MYSUBSYSTEM_H */
#include <trace/define_trace.h>

/* 2. Use in source files: */
/* kernel/mysubsystem.c */
#define CREATE_TRACE_POINTS
#include <trace/events/mysubsystem.h>

void my_function(int val, const char *name)
{
    /* Tracepoint: zero-overhead when disabled */
    trace_my_event(val, name);
    /* ... */
}
```

### How tracepoints achieve zero overhead

```c
/* Generated by TRACE_EVENT: */
static inline void trace_my_event(int value, const char *name)
{
    /* Single branch: check if any caller is registered */
    if (static_key_false(&__tracepoint_my_event.key)) {
        /* overhead only when enabled */
        __tracepoint_my_event.funcs(value, name);
    }
}
```

`static_key_false` uses a patched nop/jmp instruction (via jump labels) — the entire `if` block is patched out at runtime when no one is listening.

## uprobes: userspace dynamic probes

uprobes work like kprobes but for userspace binaries, introduced in Linux 3.5 [(commit)](https://git.kernel.org/linus/2b144498950e6030d1a35a0f69e08de17b2b5daf). The kernel inserts a breakpoint into the mapped pages:

```bash
# Trace all calls to malloc in any process
echo 'p:malloc /lib/x86_64-linux-gnu/libc.so.6:0x9d430' \
    > /sys/kernel/tracing/uprobe_events
echo 1 > /sys/kernel/tracing/events/uprobes/malloc/enable

# Trace by symbol name (requires debug symbols)
echo 'p:my_func /usr/bin/myapp:my_function' \
    > /sys/kernel/tracing/uprobe_events
```

```c
/* Kernel struct uprobe */
struct uprobe {
    struct rb_node  rb_node;   /* inode's uprobe tree */
    refcount_t      ref;
    struct rw_semaphore register_rwsem;
    struct rw_semaphore consumer_rwsem;
    struct list_head   pending_list;
    struct uprobe_consumer *consumers;
    struct inode       *inode;   /* target binary's inode */
    loff_t              offset;  /* offset within file */
    loff_t              ref_ctr_offset;
    unsigned long       flags;
    struct arch_uprobe  arch;    /* arch-specific saved instruction */
};
```

## USDT: userspace statically defined tracepoints

Similar to kernel TRACE_EVENT, USDT probes are static markers in userspace code. BPF attachment to USDT probes via the uprobe mechanism became available in Linux 4.8.

```c
/* In C code (requires systemtap-sdt-dev or dtrace probes): */
#include <sys/sdt.h>
DTRACE_PROBE2(myapp, request_start, req_id, req_type);
/* ... */
DTRACE_PROBE1(myapp, request_end, req_id);
```

```bash
# List USDT probes in a binary
readelf --notes /usr/bin/python3 | grep stapsdt

# Trace with bpftrace
bpftrace -e 'usdt:/usr/bin/python3:function__entry { printf("%s\n", str(arg1)); }'

# Trace with perf
perf probe -x /usr/bin/python3 sdt_pythonX_Y:function__entry
```

## Observing probe activity

```bash
# Count kprobe hits
cat /sys/kernel/tracing/kprobe_profile
# tcp_sendmsg        42         0  ← hits, misses

# Event hit counts
cat /sys/kernel/tracing/events/syscalls/sys_enter_read/hist

# Aggregate with bpftrace
bpftrace -e 'kprobe:tcp_sendmsg { @[comm] = count(); }'
# Attaching 1 probe...
# ^C
# @[nginx]: 1234
# @[postgres]: 567

# Dynamic function graph with kprobe
echo function_graph > /sys/kernel/tracing/current_tracer
echo 'tcp_sendmsg' > /sys/kernel/tracing/set_graph_function
echo 1 > /sys/kernel/tracing/tracing_on
```

## Further reading

- [ftrace](ftrace.md) — Ring buffer and tracefs interface
- [perf Events](perf-events.md) — Hardware counters and sampling
- [BPF: Architecture](../bpf/bpf-overview.md) — kprobe/tracepoint BPF programs
- `Documentation/trace/kprobes.rst` — kernel kprobe documentation
- `Documentation/trace/tracepoints.rst` — static tracepoint documentation
