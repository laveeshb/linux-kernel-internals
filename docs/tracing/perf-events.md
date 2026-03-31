# perf Events

> Hardware performance counters, sampling, and profiling

## What perf events are

`perf_event_open` is the Linux syscall for accessing performance monitoring hardware:

- **Hardware counters** (PMU): CPU cycles, instructions, cache misses, branch mispredictions
- **Software counters**: page faults, context switches, CPU migrations
- **Tracepoints**: static kernel events
- **Dynamic events**: kprobes, uprobes, BPF
- **Sampling**: record PC/stack every N events for statistical profiling

## perf_event_open syscall

```c
#include <linux/perf_event.h>

struct perf_event_attr attr = {
    .type           = PERF_TYPE_HARDWARE,
    .config         = PERF_COUNT_HW_CPU_CYCLES,  /* count CPU cycles */
    .size           = sizeof(attr),
    .disabled       = 1,    /* start disabled */
    .exclude_kernel = 0,    /* count kernel events too */
    .exclude_hv     = 1,    /* exclude hypervisor */
};

/* Monitor the current process on any CPU */
int fd = syscall(SYS_perf_event_open, &attr,
                 0,    /* pid: 0=current process */
                 -1,   /* cpu: -1=any */
                 -1,   /* group_fd: -1=no group */
                 0);   /* flags */

/* Start counting */
ioctl(fd, PERF_EVENT_IOC_ENABLE, 0);

/* ... code to measure ... */

/* Read counter */
long long count;
read(fd, &count, sizeof(count));
printf("CPU cycles: %lld\n", count);

/* Stop */
ioctl(fd, PERF_EVENT_IOC_DISABLE, 0);
close(fd);
```

## Event types

```c
/* Hardware events (CPU PMU) */
.type = PERF_TYPE_HARDWARE
.config:
    PERF_COUNT_HW_CPU_CYCLES         /* CPU cycles */
    PERF_COUNT_HW_INSTRUCTIONS       /* retired instructions */
    PERF_COUNT_HW_CACHE_REFERENCES   /* cache accesses */
    PERF_COUNT_HW_CACHE_MISSES       /* cache misses */
    PERF_COUNT_HW_BRANCH_INSTRUCTIONS /* branch instructions */
    PERF_COUNT_HW_BRANCH_MISSES      /* branch mispredictions */
    PERF_COUNT_HW_BUS_CYCLES
    PERF_COUNT_HW_STALLED_CYCLES_FRONTEND
    PERF_COUNT_HW_STALLED_CYCLES_BACKEND

/* Software events (kernel counters) */
.type = PERF_TYPE_SOFTWARE
.config:
    PERF_COUNT_SW_CPU_CLOCK          /* CPU clock (ns) */
    PERF_COUNT_SW_TASK_CLOCK         /* task-local clock */
    PERF_COUNT_SW_PAGE_FAULTS        /* page faults */
    PERF_COUNT_SW_CONTEXT_SWITCHES   /* voluntary + involuntary */
    PERF_COUNT_SW_CPU_MIGRATIONS     /* task moved between CPUs */
    PERF_COUNT_SW_PAGE_FAULTS_MIN    /* minor faults (no disk I/O) */
    PERF_COUNT_SW_PAGE_FAULTS_MAJ    /* major faults (disk I/O) */
    PERF_COUNT_SW_ALIGNMENT_FAULTS
    PERF_COUNT_SW_EMULATION_FAULTS
    PERF_COUNT_SW_DUMMY

/* Hardware cache events */
.type = PERF_TYPE_HW_CACHE
/* .config encodes: cache_id | (cache_op_id << 8) | (result_id << 16) */
/* e.g., L1D read misses: */
.config = PERF_COUNT_HW_CACHE_L1D | (PERF_COUNT_HW_CACHE_OP_READ << 8) |
          (PERF_COUNT_HW_CACHE_RESULT_MISS << 16)

/* Tracepoint events */
.type = PERF_TYPE_TRACEPOINT
.config = <tracepoint_id>  /* from /sys/kernel/tracing/events/.../id */

/* Raw CPU PMU events */
.type = PERF_TYPE_RAW
.config = <cpu-specific PMU event code>  /* e.g., Intel perfmon event */
```

## Sampling mode

Sampling records the instruction pointer (and optionally call stack) every N events:

```c
struct perf_event_attr attr = {
    .type           = PERF_TYPE_HARDWARE,
    .config         = PERF_COUNT_HW_CPU_CYCLES,
    .sample_type    = PERF_SAMPLE_IP | PERF_SAMPLE_TID |
                      PERF_SAMPLE_TIME | PERF_SAMPLE_CALLCHAIN,
    .sample_period  = 1000000,  /* every 1M cycles */
    /* OR: */
    .sample_freq    = 99,       /* ~99 Hz (kernel adjusts period) */
    .freq           = 1,        /* enable freq mode */
    .wakeup_events  = 1,        /* wake userspace every N samples */
    /* Callchain depth: */
    .exclude_callchain_kernel = 0,
    .exclude_callchain_user   = 0,
};
```

Samples are written to an `mmap`'d ring buffer (the perf mmap buffer):

```c
/* Map the ring buffer */
void *mmap_buf = mmap(NULL, (1 + pages) * PAGE_SIZE,
                      PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);

struct perf_event_mmap_page *header = mmap_buf;
/* header->data_head: write position (updated by kernel) */
/* header->data_tail: read position (updated by userspace) */

void *data = mmap_buf + PAGE_SIZE;  /* ring starts after metadata page */

/* Read loop: */
while (header->data_tail != header->data_head) {
    struct perf_event_header *event = data + (header->data_tail % data_size);
    /* process event */
    header->data_tail += event->size;
}
```

## perf tool: the userspace frontend

### Counting

```bash
# Count events for a command
perf stat ls
# Performance counter stats for 'ls':
#      0.98 msec task-clock                #    0.783 CPUs utilized
#         1      context-switches          #    1.022 K/sec
#         0      cpu-migrations            #    0.000 /sec
#       163      page-faults               #  166.389 K/sec
#   2,345,678    cycles                    #    2.394 GHz
#   1,234,567    instructions              #    0.53  insn per cycle
#     456,789    branches                  #  466.520 M/sec
#      12,345    branch-misses             #    2.70% of all branches

# Specific events
perf stat -e cycles,instructions,cache-misses,cache-references -- ./myapp

# System-wide
perf stat -a sleep 5

# CPI (cycles per instruction) analysis
perf stat -e cycles,instructions -r 3 ./myapp  # repeat 3 times
```

### CPU profiling with perf record

```bash
# Record with call graphs (frame pointer)
perf record -g -F 99 -- ./myapp
# Or: sample all CPUs
perf record -g -F 99 -a sleep 30

# Report
perf report
# Overhead  Command   Symbol
#  25.43%   myapp     [k] __schedule
#  18.21%   myapp     [.] malloc
#  12.33%   myapp     [.] my_function

# Show call graph
perf report --call-graph=graph

# Annotate with source
perf report --stdio
```

### Flame graphs

```bash
# Record
perf record -g -F 99 -p <pid> sleep 30

# Convert to flame graph (via Brendan Gregg's scripts)
perf script | stackcollapse-perf.pl | flamegraph.pl > flamegraph.svg

# Or use hotspot (GUI)
hotspot perf.data
```

### Kernel internals: struct perf_event

```c
/* include/linux/perf_event.h */
struct perf_event {
    struct list_head        event_entry;
    struct list_head        sibling_list; /* group siblings */
    struct list_head        active_list;

    struct perf_event_attr  attr;         /* user-space config */
    struct hw_perf_event    hw;           /* PMU hardware state */

    struct perf_event_context *ctx;       /* context (task or CPU) */
    atomic_long_t           refcount;

    /* Callback when an overflow/sample occurs: */
    perf_overflow_handler_t overflow_handler;
    void                   *overflow_handler_context;

    /* Ring buffer for samples: */
    struct perf_buffer __rcu *rb;

    /* Tracepoint: */
    struct trace_event_call *tp_event;

    /* BPF: */
    struct bpf_prog         *prog;

    u64                     id;           /* unique event ID */
    /* ... */
};

struct hw_perf_event {
    /* PMU hardware registers: */
    union {
        struct { /* hardware */
            u64 config;          /* programmed into PMU */
            u64 last_tag;
            unsigned long config_base;
            unsigned long event_base;
            int event_base_rdpmc;
            int idx;             /* counter index */
            int last_cpu;
            int flags;
        };
        /* ... */
    };
    u64                     prev_count;  /* last read value */
    u64                     sample_period;
    u64                     last_period;
    local64_t               period_left;
    /* ... */
};
```

### PMU: Hardware Performance Monitoring Unit

Each CPU architecture has a PMU with a limited number of programmable counters. On Intel:

```
Intel PMU (Skylake):
  - 4 general-purpose counters (PERFCTR0..3)  ← programmable with any event
  - 3 fixed-function counters:
      FIXED_CTR0 = instructions retired
      FIXED_CTR1 = CPU clock cycles
      FIXED_CTR2 = reference cycles
  - Each counter generates an NMI when it overflows

Relevant MSRs:
  IA32_PERFEVTSELx: event selector (event, umask, usr, os, edge, etc.)
  IA32_PMCx:        counter value
  IA32_FIXED_CTR_CTRL: enable fixed counters
  IA32_PERF_GLOBAL_CTRL: enable/disable all counters
```

The perf subsystem multiplexes software events onto the limited hardware counters using `context_switch` and `rotation`.

## Observing perf internals

```bash
# List available events
perf list

# Check if PMU is working
perf stat -e cycles echo hello

# Hardware event codes for raw events
# Intel: https://perfmon-events.intel.com/
perf stat -e r4c14  # raw Intel event code (hex)

# Check NMI handler
cat /proc/interrupts | grep NMI

# perf_event_paranoid: controls access
cat /proc/sys/kernel/perf_event_paranoid
# -1: no restrictions, 0: allow kernel profiling, 1: user only, 2: no kernel addr (default)
echo 0 > /proc/sys/kernel/perf_event_paranoid
```

## Further reading

- [ftrace](ftrace.md) — Low-level function tracing
- [Kprobes and Tracepoints](kprobes-tracepoints.md) — Dynamic and static events used with perf
- [BPF: Architecture](../bpf/bpf-overview.md) — BPF_PROG_TYPE_PERF_EVENT programs
- `tools/perf/` in the kernel tree — perf tool source
- `Documentation/admin-guide/perf-security.rst`
