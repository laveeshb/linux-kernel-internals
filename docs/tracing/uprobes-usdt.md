# uprobes and USDT: Userspace Dynamic Tracing

> Attaching BPF programs to userspace functions and static tracepoints

## uprobes: dynamic userspace instrumentation

A **uprobe** is the userspace equivalent of a kprobe, introduced in Linux 3.5 by Srikar Dronamraju (IBM) [(commit)](https://git.kernel.org/linus/2b144498350860b6ee9dc57ff27a93ad488de5dc) — it instruments any instruction address in a userspace binary by:
1. Finding the address in the binary
2. Replacing the instruction with a breakpoint (INT3 on x86)
3. Running a BPF/ftrace handler on the breakpoint

```
uprobe on malloc() in libc:
  Process:     [normal code]→ malloc() → [int3 trap] → uprobe handler → malloc continues
  CPU cost:    ~100-500ns per hit (much higher than kprobes due to user/kernel transition)
```

## Attaching uprobes with bpftrace

```bash
# Trace malloc() calls in any process:
bpftrace -e 'uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc
{ printf("malloc(%d) by %s\n", arg0, comm); }'

# Trace a specific binary:
bpftrace -e 'uprobe:/usr/bin/nginx:ngx_http_process_request
{ @[comm] = count(); }'

# Function arguments:
bpftrace -e 'uprobe:/lib/libc.so.6:fopen
{ printf("fopen(\"%s\", \"%s\")\n", str(arg0), str(arg1)); }'

# Return value (uretprobe):
bpftrace -e '
uprobe:/lib/libc.so.6:malloc { @start[tid] = arg0; }
uretprobe:/lib/libc.so.6:malloc /@start[tid]/
{
    printf("malloc(%d) = %p\n", @start[tid], retval);
    delete(@start[tid]);
}'

# Trace by PID:
bpftrace -p 1234 -e 'uprobe:/usr/bin/python3:PyObject_MALLOC
{ @alloc_size = hist(arg0); }'

# Using symbol offsets:
bpftrace -e 'uprobe:/usr/bin/nginx:0x12345  # specific offset
{ printf("hit offset 0x12345\n"); }'
```

## uprobes with libbpf

```c
/* uprobe_example.bpf.c */
#include <vmlinux.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

/* Attach to malloc() entry */
SEC("uprobe//lib/x86_64-linux-gnu/libc.so.6:malloc")
int handle_malloc_entry(struct pt_regs *ctx)
{
    size_t size = PT_REGS_PARM1(ctx);  /* first argument */
    bpf_printk("malloc(%zu) called\n", size);
    return 0;
}

/* Attach to malloc() return */
SEC("uretprobe//lib/x86_64-linux-gnu/libc.so.6:malloc")
int handle_malloc_return(struct pt_regs *ctx)
{
    void *ptr = (void *)PT_REGS_RC(ctx);  /* return value */
    bpf_printk("malloc returned %p\n", ptr);
    return 0;
}
```

```c
/* uprobe_example.c - userspace loader */
#include "uprobe_example.skel.h"

int main(void)
{
    struct uprobe_example_bpf *skel = uprobe_example_bpf__open_and_load();

    /* libbpf auto-attaches based on SEC() annotations */
    uprobe_example_bpf__attach(skel);

    /* Or manually attach to a specific offset: */
    skel->links.handle_malloc_entry =
        bpf_program__attach_uprobe(skel->progs.handle_malloc_entry,
                                    false,    /* entry, not return */
                                    -1,       /* all PIDs */
                                    "/lib/x86_64-linux-gnu/libc.so.6",
                                    0x12345); /* file offset */

    /* Run until interrupted */
    pause();
    uprobe_example_bpf__destroy(skel);
    return 0;
}
```

## USDT: User Statically Defined Tracepoints

USDT tracepoints are **static** instrumentation points added by application developers. Unlike uprobes (which can attach to any instruction), USDTs are intentionally placed at meaningful locations:

```c
/* Application code (Python, PostgreSQL, Node.js, MySQL, etc.) */
#include <sys/sdt.h>   /* or probe.h */

void process_request(struct request *req)
{
    /* USDT tracepoint: fires when probe is attached, NOP otherwise */
    DTRACE_PROBE1(myapp, request-start, req->id);

    /* ... process ... */

    DTRACE_PROBE2(myapp, request-done, req->id, req->status);
}
```

```c
/* DTRACE_PROBE* compiles to: */
/* Normal execution: NOP instruction (0x90 on x86, ~0ns overhead) */
/* When attached: NOP replaced with INT3, uprobe handler fires */
/* Completely zero-overhead when no tool is attached */
```

### Finding USDT probes

```bash
# List all USDT probes in a binary:
readelf -n /usr/bin/python3 | grep stapsdt | head -20
# NT_STAPSDT (System Tap Static Probe)
#   Provider: python
#   Name: function__entry
#   Location: 0x000000000041a3c0
#   Base: 0x0000000000000000
#   Semaphore: 0x0000000000000000
#   Arguments: -4@%rdi -8@%rsi

# Using bpftrace:
bpftrace -l 'usdt:/usr/bin/python3:*'
# usdt:/usr/bin/python3:python:function__entry
# usdt:/usr/bin/python3:python:function__return
# usdt:/usr/bin/python3:python:import__find__load__start
# usdt:/usr/bin/python3:python:gc__start
# usdt:/usr/bin/python3:python:gc__done

# Using tplist (BCC):
tplist -l /usr/bin/python3
```

## USDT with bpftrace: Python function tracing

```bash
# Trace Python function calls:
bpftrace -e '
usdt:/usr/bin/python3:python:function__entry
{
    printf("%s:%d %s\n",
           str(arg1),   /* filename */
           arg2,        /* line number */
           str(arg0));  /* function name */
}'

# Count Python GC pauses:
bpftrace -e '
usdt:/usr/bin/python3:python:gc__start
{ @[arg0] = count(); }   /* arg0 = generation */'

# Time Python function calls:
bpftrace -e '
usdt:/usr/bin/python3:python:function__entry
{ @start[tid] = nsecs; }

usdt:/usr/bin/python3:python:function__return
/@start[tid]/
{
    @lat_us[str(arg0)] = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}'
```

## PostgreSQL USDT probes

```bash
# PostgreSQL has rich USDT support:
bpftrace -l 'usdt:/usr/lib/postgresql/14/bin/postgres:postgresql:*'
# usdt:...:postgresql:query__start
# usdt:...:postgresql:query__done
# usdt:...:postgresql:lock__wait__start
# usdt:...:postgresql:lock__wait__done
# usdt:...:postgresql:transaction__start
# usdt:...:postgresql:transaction__commit
# usdt:...:postgresql:transaction__abort

# Trace slow queries (> 100ms):
bpftrace -p $(pgrep postgres) -e '
usdt:/usr/lib/postgresql/14/bin/postgres:postgresql:query__start
{ @start[tid] = nsecs; @query[tid] = str(arg0); }

usdt:/usr/lib/postgresql/14/bin/postgres:postgresql:query__done
/@start[tid] && (nsecs - @start[tid]) > 100000000/  /* 100ms */
{
    printf("SLOW QUERY (%dms): %s\n",
           (nsecs - @start[tid]) / 1000000,
           @query[tid]);
    delete(@start[tid]);
    delete(@query[tid]);
}'
```

## Node.js USDT probes

```bash
# Node.js built with --with-dtrace:
bpftrace -l 'usdt:/usr/bin/node:*'
# usdt:/usr/bin/node:node:http__server__request
# usdt:/usr/bin/node:node:net__server__connection
# usdt:/usr/bin/node:node:gc__start

# Trace HTTP requests:
bpftrace -e '
usdt:/usr/bin/node:node:http__server__request
{
    printf("HTTP %s %s from %s\n",
           str(arg2),  /* method */
           str(arg3),  /* url */
           str(arg5)); /* remote address */
}'
```

## uprobe overhead vs tracepoints

```
Instrumentation overhead comparison:
  kprobe:         ~100ns per hit (context still in kernel)
  tracepoint:      ~10ns per hit (statically placed, minimal overhead)
  uprobe:         ~200-500ns per hit (user→kernel→user transition)
  USDT (attached): ~200-500ns (same as uprobe when attached)
  USDT (idle):       ~0ns (NOP instruction, no overhead)
  perf_event:      ~50ns for hardware PMU counters

Production considerations:
  - uprobes: can cause noticeable overhead on hot paths
  - USDT: zero-cost when not probed, minimal when probed
  - Prefer USDT to uprobes for production tracing
  - Limit uprobe attachment to < 1% of execution time paths
```

## uprobe kernel internals

```c
/* kernel/events/uprobes.c */

/* uprobe structure: */
struct uprobe {
    struct rb_node   rb_node;    /* in uprobe_tree, keyed by (inode, offset) */
    refcount_t       ref;
    struct rw_semaphore register_rwsem;
    struct inode    *inode;      /* binary inode */
    loff_t           offset;     /* file offset of probed instruction */
    loff_t           ref_ctr_offset; /* USDT semaphore offset */
    unsigned long    flags;
    struct arch_uprobe arch;     /* saved original instruction */
};

/* When a traced process executes INT3 from uprobe: */
/* arch/x86/kernel/traps.c: do_int3 → uprobe_pre_sstep_notifier */
void uprobe_notify_resume(struct pt_regs *regs)
{
    /* 1. Identify which uprobe fired */
    /* 2. Call all registered handlers (BPF programs) */
    /* 3. Single-step the original instruction */
    /* 4. Return to normal execution */
}
```

## Further reading

- [Kprobes and Tracepoints](kprobes-tracepoints.md) — kernel-side dynamic probing
- [BPF Maps](../bpf/bpf-maps.md) — sharing data between BPF programs
- [libbpf and Skeletons](../bpf/libbpf.md) — uprobe attachment via libbpf
- [perf Profiling](perf-profiling.md) — perf record with USDT
- `kernel/events/uprobes.c` — uprobe implementation
- `Documentation/trace/uprobetracer.rst`
- BCC tools: `trace`, `tplist`, `argdist`, `funccount`
