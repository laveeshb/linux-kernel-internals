# BPF Ring Buffer

> Lock-free, memory-efficient event streaming from BPF programs

## Why not perf event output?

Before `BPF_MAP_TYPE_RINGBUF` (5.8), BPF programs streamed events to userspace via `bpf_perf_event_output`:

```c
/* Old approach: per-CPU perf ring buffers */
struct bpf_map_def SEC("maps") events = {
    .type        = BPF_MAP_TYPE_PERF_EVENT_ARRAY,
    .key_size    = sizeof(int),
    .value_size  = sizeof(u32),
    .max_entries = MAX_CPUS,
};

SEC("tracepoint/syscalls/sys_enter_write")
int trace_write(struct trace_event_raw_sys_enter *ctx) {
    struct event e = { .pid = bpf_get_current_pid_tgid() >> 32 };
    bpf_perf_event_output(ctx, &events, BPF_F_CURRENT_CPU, &e, sizeof(e));
    return 0;
}
```

Problems with `PERF_EVENT_ARRAY`:
- **Per-CPU**: separate buffer per CPU, requires per-CPU polling in userspace
- **Memory waste**: each CPU gets a full buffer even if mostly idle
- **No variable-size records**: must pre-declare event size
- **Wakeup overhead**: `epoll_wait` requires a fd per CPU

## BPF ring buffer design

`BPF_MAP_TYPE_RINGBUF` uses a **single shared ring buffer** across all CPUs with a lock-free design:

```
Ring buffer memory layout:

  consumer_pos (4 bytes) ← read by userspace, written by userspace
  [padding]
  producer_pos (4 bytes) ← read by userspace, written by BPF kernel
  [padding]
  data area (size bytes) ← records written here

  Record format:
  ┌────────────────────────────────────────┐
  │ len (28 bits) | flags (4 bits)         │  ← 4-byte header
  ├────────────────────────────────────────┤
  │ data (len bytes)                       │
  │ [padding to 8-byte alignment]          │
  └────────────────────────────────────────┘

  flags: BPF_RINGBUF_BUSY_BIT   = 0x1 (record being written)
         BPF_RINGBUF_DISCARD_BIT = 0x2 (record discarded)
```

Key properties:
- **Single buffer**: no per-CPU waste; all CPUs share one ring
- **Spinlock-free**: compare-and-swap for producer position reservation
- **Two-phase commit**: reserve space, fill it, then submit or discard
- **Memory-mapped**: userspace reads directly without syscall

## BPF program side

```c
#include <vmlinux.h>
#include <bpf/bpf_helpers.h>

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);  /* 256KB ring */
} rb SEC(".maps");

struct event {
    u32 pid;
    u32 tid;
    u64 ts;
    char comm[16];
    int fd;
    ssize_t ret;
};

SEC("tracepoint/syscalls/sys_exit_write")
int trace_write_exit(struct trace_event_raw_sys_exit *ctx)
{
    struct event *e;

    /* Reserve space in the ring buffer */
    e = bpf_ringbuf_reserve(&rb, sizeof(*e), 0);
    if (!e)
        return 0;  /* ring full: drop event */

    /* Fill the record (safe: we own it until submit) */
    e->pid = bpf_get_current_pid_tgid() >> 32;
    e->tid = (u32)bpf_get_current_pid_tgid();
    e->ts  = bpf_ktime_get_ns();
    bpf_get_current_comm(e->comm, sizeof(e->comm));
    e->fd  = (int)ctx->args[0];
    e->ret = (ssize_t)ctx->ret;

    /* Commit: make visible to userspace */
    bpf_ringbuf_submit(e, 0);
    return 0;
}
```

### bpf_ringbuf_output: one-shot alternative

For small, fixed-size events where reserve+submit is overkill:

```c
/* Single call: reserve, copy, submit atomically */
bpf_ringbuf_output(&rb, &event, sizeof(event), 0);
/* Less efficient than reserve+submit for large events */
/* (copies from stack, can't fill in-place) */
```

### Discard on error

```c
e = bpf_ringbuf_reserve(&rb, sizeof(*e), 0);
if (!e)
    return 0;

/* ... fill e ... */

if (should_drop) {
    bpf_ringbuf_discard(e, 0);  /* release reserved space, no event */
    return 0;
}

bpf_ringbuf_submit(e, 0);
```

## Userspace consumption with libbpf

```c
#include <bpf/libbpf.h>

struct ring_buffer *rb;

static int handle_event(void *ctx, void *data, size_t size)
{
    struct event *e = data;
    printf("[%llu] pid=%u comm=%s fd=%d ret=%zd\n",
           e->ts, e->pid, e->comm, e->fd, e->ret);
    return 0;
}

int main(void)
{
    struct my_bpf *skel = my_bpf__open_and_load();
    my_bpf__attach(skel);

    /* Create ring buffer consumer */
    rb = ring_buffer__new(bpf_map__fd(skel->maps.rb),
                           handle_event, NULL, NULL);

    /* Poll: calls handle_event for each available record */
    while (1) {
        ring_buffer__poll(rb, 100 /* ms timeout */);
    }

    ring_buffer__free(rb);
    my_bpf__destroy(skel);
}
```

### Manual mmap polling

Without libbpf, the ring buffer is accessed via `mmap`:

```c
int map_fd = bpf_map__fd(skel->maps.rb);
int page_size = getpagesize();
int map_size = 256 * 1024;

/* Map: consumer + producer pages + data area */
void *mmap_base = mmap(NULL, page_size + page_size + map_size,
                        PROT_READ | PROT_WRITE, MAP_SHARED,
                        map_fd, 0);

unsigned long *consumer_pos = mmap_base;
unsigned long *producer_pos = mmap_base + page_size;
void *data = mmap_base + 2 * page_size;

/* Poll loop: */
while (1) {
    unsigned long prod = __atomic_load_n(producer_pos, __ATOMIC_ACQUIRE);
    unsigned long cons = *consumer_pos;

    while (cons < prod) {
        unsigned long offset = cons % map_size;
        u32 *hdr = data + offset;
        u32  len = *hdr & ~0xf;  /* mask off flag bits */
        u32  flags = *hdr & 0xf;

        if (flags & BPF_RINGBUF_BUSY_BIT)
            break;  /* producer hasn't committed yet */

        if (!(flags & BPF_RINGBUF_DISCARD_BIT)) {
            /* Valid record: data starts after header */
            process_event(data + offset + sizeof(u32), len);
        }

        cons += sizeof(u32) + ALIGN(len, 8);
        *consumer_pos = cons;  /* advance consumer */
    }

    /* Sleep or use epoll on ring buffer fd */
    usleep(1000);
}
```

## BPF_MAP_TYPE_RINGBUF vs PERF_EVENT_ARRAY

| Feature | PERF_EVENT_ARRAY | RINGBUF |
|---------|-----------------|---------|
| Memory | Per-CPU buffers | Single shared buffer |
| Variable-size records | No | Yes |
| Userspace polling | Per-CPU epoll fds | Single fd |
| In-place filling | No (stack copy) | Yes (reserve+submit) |
| Discard support | No | Yes |
| mmap access | Yes | Yes |
| Kernel version | 4.4 | 5.8 |
| Overhead | Higher | Lower |

## Wakeup control

```c
/* Submit without waking userspace (batch multiple events) */
bpf_ringbuf_submit(e, BPF_RB_NO_WAKEUP);

/* Force immediate wakeup (for latency-sensitive events) */
bpf_ringbuf_submit(e, BPF_RB_FORCE_WAKEUP);

/* Default: wake if userspace is waiting, don't otherwise */
bpf_ringbuf_submit(e, 0);
```

With `ring_buffer__poll` in libbpf, `BPF_RB_NO_WAKEUP` + a final `BPF_RB_FORCE_WAKEUP` can batch many events into a single wakeup, reducing overhead significantly.

## Query available space

```c
/* Check if ring has space before allocating */
u64 avail = bpf_ringbuf_query(&rb, BPF_RB_AVAIL_DATA);
u64 ring_size = bpf_ringbuf_query(&rb, BPF_RB_RING_SIZE);
u64 cons_pos  = bpf_ringbuf_query(&rb, BPF_RB_CONS_POS);
u64 prod_pos  = bpf_ringbuf_query(&rb, BPF_RB_PROD_POS);
```

## Further reading

- [BPF Maps](bpf-maps.md) — other BPF map types
- [BPF Architecture](bpf-overview.md) — program types overview
- [libbpf and Skeletons](libbpf.md) — `ring_buffer__new` / `ring_buffer__poll`
- [Kprobes and Tracepoints](../tracing/kprobes-tracepoints.md) — attaching to tracepoints
- `kernel/bpf/ringbuf.c` — ring buffer implementation
- `tools/lib/bpf/ringbuf.c` — libbpf consumer
