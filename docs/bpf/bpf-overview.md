# BPF Architecture and Program Types

> How eBPF programs are loaded, verified, and attached to kernel hooks

## The bpf() syscall

Everything in eBPF flows through a single syscall:

```c
#include <linux/bpf.h>

int bpf(int cmd, union bpf_attr *attr, unsigned int size);
```

Key commands:

```c
BPF_PROG_LOAD      /* load and verify a BPF program */
BPF_MAP_CREATE     /* create a BPF map */
BPF_MAP_LOOKUP_ELEM
BPF_MAP_UPDATE_ELEM
BPF_MAP_DELETE_ELEM
BPF_OBJ_PIN        /* pin map/program to /sys/fs/bpf/ */
BPF_OBJ_GET        /* retrieve pinned object */
BPF_PROG_ATTACH    /* attach program to cgroup/hook */
BPF_PROG_DETACH
BPF_LINK_CREATE    /* create a BPF link (managed attachment) */
BPF_LINK_UPDATE
BTF_LOAD           /* load BTF type information */
```

## Loading a program

```c
/* kernel/bpf/syscall.c: bpf_prog_load() */
union bpf_attr attr = {
    .prog_type    = BPF_PROG_TYPE_SOCKET_FILTER,
    .insn_cnt     = prog_len / sizeof(struct bpf_insn),
    .insns        = (uint64_t)prog_insns,
    .license      = (uint64_t)"GPL",
    .log_level    = 1,          /* request verifier log */
    .log_buf      = (uint64_t)log_buf,
    .log_size     = LOG_BUF_SIZE,
    .kern_version = 0,          /* for kprobes, must match kernel */
};

int prog_fd = bpf(BPF_PROG_LOAD, &attr, sizeof(attr));
/* Returns file descriptor or -1 with errno */
```

The kernel flow after BPF_PROG_LOAD:

```
bpf_prog_load()
  → bpf_check_uarg_tail_zero()    /* validate attr padding */
  → find_prog_type()              /* look up type ops */
  → bpf_prog_alloc()              /* allocate struct bpf_prog */
  → copy_from_bpfptr(insns)       /* copy bytecode from userspace */
  → bpf_check()                   /* VERIFIER — safety proof */
  → bpf_prog_select_runtime()     /* JIT or interpreter selection */
  → bpf_prog_kallsyms_add()       /* expose in /proc/kallsyms */
  → anon_inode_getfd("bpf-prog")  /* return file descriptor */
```

## struct bpf_prog

The central kernel object for a loaded BPF program:

```c
/* include/linux/filter.h */
struct bpf_prog {
    u16             pages;          /* number of pages */
    u16             jited:1,        /* true if JIT-compiled */
                    jit_requested:1,
                    gpl_compatible:1,
                    cb_access:1,    /* accesses skb->cb area */
                    dst_needed:1,
                    blinding_requested:1,
                    blinded:1,
                    is_func:1,      /* function in a program array */
                    kprobe_override:1,
                    has_callchain_buf:1,
                    enforce_expected_attach_type:1,
                    call_get_stack:1,
                    call_get_func_ip:1,
                    tstamp_type_access:1;
    enum bpf_prog_type      type;   /* BPF_PROG_TYPE_* */
    enum bpf_attach_type    expected_attach_type;
    u32             len;            /* number of filter blocks */
    u32             jited_len;      /* size of JIT code */
    u8              tag[BPF_TAG_SIZE]; /* SHA1-based identifier */
    struct bpf_prog_stats __percpu *stats;
    struct bpf_prog_aux    *aux;    /* verifier state, maps, BTF */
    struct sock_fprog_kern *orig_prog; /* original Classic BPF */
    unsigned int    (*bpf_func)(const void *ctx,
                                const struct bpf_insn *insn);
    /* JIT/interpreter code follows */
    union {
        struct sock_filter  insns[0]; /* Classic BPF instructions */
        struct bpf_insn     insnsi[]; /* eBPF instructions */
    };
};
```

## BPF instruction set

eBPF has 11 64-bit registers (r0–r10) and a fixed-size instruction format:

```c
/* include/linux/filter.h */
struct bpf_insn {
    __u8    code;       /* opcode */
    __u8    dst_reg:4;  /* destination register */
    __u8    src_reg:4;  /* source register */
    __s16   off;        /* signed offset */
    __s32   imm;        /* signed immediate */
};
```

Register conventions:
- `r0` — return value from helper calls and program exit
- `r1`–`r5` — function arguments (r1 = context pointer on entry)
- `r6`–`r9` — callee-saved registers
- `r10` — frame pointer (read-only)

## Program types

Each program type has a specific context struct and allowed helpers:

```c
/* include/uapi/linux/bpf.h */
enum bpf_prog_type {
    BPF_PROG_TYPE_SOCKET_FILTER,    /* socket filter, ctx=sk_buff */
    BPF_PROG_TYPE_KPROBE,           /* kprobe/uprobe, ctx=pt_regs */
    BPF_PROG_TYPE_SCHED_CLS,        /* TC classifier, ctx=sk_buff */
    BPF_PROG_TYPE_SCHED_ACT,        /* TC action */
    BPF_PROG_TYPE_TRACEPOINT,       /* static tracepoints */
    BPF_PROG_TYPE_XDP,              /* XDP, ctx=xdp_md */
    BPF_PROG_TYPE_PERF_EVENT,       /* PMU/perf events */
    BPF_PROG_TYPE_CGROUP_SKB,       /* cgroup socket buffer */
    BPF_PROG_TYPE_CGROUP_SOCK,      /* cgroup socket creation */
    BPF_PROG_TYPE_LWT_IN,           /* lightweight tunnels */
    BPF_PROG_TYPE_SOCK_OPS,         /* socket event callbacks */
    BPF_PROG_TYPE_SK_SKB,           /* socket map steering */
    BPF_PROG_TYPE_CGROUP_DEVICE,    /* device access control */
    BPF_PROG_TYPE_SK_MSG,           /* sockmap message redirect */
    BPF_PROG_TYPE_RAW_TRACEPOINT,   /* raw tracepoints (no arg rewrite) */
    BPF_PROG_TYPE_CGROUP_SOCK_ADDR, /* cgroup bind/connect/sendmsg */
    BPF_PROG_TYPE_LWT_SEG6LOCAL,
    BPF_PROG_TYPE_LIRC_MODE2,       /* IR decoding */
    BPF_PROG_TYPE_SK_REUSEPORT,     /* SO_REUSEPORT steering */
    BPF_PROG_TYPE_FLOW_DISSECTOR,   /* custom flow dissection */
    BPF_PROG_TYPE_CGROUP_SYSCTL,    /* sysctl access control */
    BPF_PROG_TYPE_RAW_TRACEPOINT_WRITABLE,
    BPF_PROG_TYPE_CGROUP_SOCKOPT,
    BPF_PROG_TYPE_TRACING,          /* fentry/fexit/fmod_ret */
    BPF_PROG_TYPE_STRUCT_OPS,       /* implement kernel struct ops */
    BPF_PROG_TYPE_EXT,              /* function replacement */
    BPF_PROG_TYPE_LSM,              /* Linux Security Module hooks */
    BPF_PROG_TYPE_SK_LOOKUP,        /* socket lookup */
    BPF_PROG_TYPE_SYSCALL,          /* privileged syscall programs */
    BPF_PROG_TYPE_NETFILTER,        /* netfilter hook */
};
```

### Tracing programs in detail

```c
/* fentry: attaches to function entry, no overhead of kprobes */
SEC("fentry/tcp_sendmsg")
int BPF_PROG(trace_tcp_sendmsg, struct sock *sk,
             struct msghdr *msg, size_t size)
{
    bpf_printk("tcp_sendmsg: size=%zu\n", size);
    return 0;
}

/* fexit: attaches to function return, can see return value */
SEC("fexit/tcp_sendmsg")
int BPF_PROG(trace_tcp_sendmsg_exit, struct sock *sk,
             struct msghdr *msg, size_t size, int ret)
{
    bpf_printk("tcp_sendmsg returned %d\n", ret);
    return 0;
}

/* kprobe: can attach to any non-inlined function */
SEC("kprobe/tcp_sendmsg")
int kprobe_tcp_sendmsg(struct pt_regs *ctx)
{
    struct sock *sk = (struct sock *)PT_REGS_PARM1(ctx);
    /* access arguments through PT_REGS_PARM1..5 */
    return 0;
}
```

### XDP program

```c
/* Minimal XDP program */
SEC("xdp")
int xdp_drop_icmp(struct xdp_md *ctx)
{
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (eth->h_proto != htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    if (ip->protocol == IPPROTO_ICMP)
        return XDP_DROP;  /* drop ICMP */

    return XDP_PASS;
}
```

XDP return codes:
- `XDP_ABORTED` — bug/error, drops packet + fires tracepoint
- `XDP_DROP` — drop immediately (before skb allocation)
- `XDP_PASS` — pass to normal networking stack
- `XDP_TX` — send back out the same interface
- `XDP_REDIRECT` — redirect to another interface or AF_XDP socket

## BPF program lifecycle

```
Load: bpf(BPF_PROG_LOAD)  → prog_fd (refcount=1)
                              │
Attach: bpf_link_create()  → link_fd
        or explicit attach      │
                              │   prog refcount++
                              │
Running: hook fires        → bpf_prog_run(prog, ctx)
                              │
Detach: close(link_fd)     → link cleanup, prog refcount--
Unload: close(prog_fd)     → prog refcount--
                              │
refcount==0:               → bpf_prog_free()
                              JIT memory freed
```

BPF links (`BPF_LINK_CREATE`) are preferred over legacy attach methods because:
- Closing the link_fd automatically detaches (no dangling programs)
- Links survive the original loader process exiting (if pinned)
- Atomic program replacement via `BPF_LINK_UPDATE`

## Helper functions

BPF programs can't call arbitrary kernel functions — they use a whitelisted set of helpers:

```c
/* Common helpers */
bpf_map_lookup_elem(map, key)       → value pointer or NULL
bpf_map_update_elem(map, key, val, flags)
bpf_map_delete_elem(map, key)

bpf_ktime_get_ns()                  → nanoseconds since boot
bpf_get_current_pid_tgid()         → (tgid << 32) | pid
bpf_get_current_comm(buf, sz)       → process name string
bpf_get_current_task()             → struct task_struct *

bpf_probe_read_kernel(dst, sz, src) → safe kernel memory read
bpf_probe_read_user(dst, sz, src)   → safe userspace memory read
bpf_probe_read_kernel_str(dst, sz, src)

bpf_printk(fmt, ...)               → /sys/kernel/debug/tracing/trace_pipe

/* Networking */
bpf_skb_load_bytes(skb, off, to, len)
bpf_skb_store_bytes(skb, off, from, len, flags)
bpf_redirect(ifindex, flags)
bpf_fib_lookup(ctx, params, plen, flags)

/* Ringbuf */
bpf_ringbuf_reserve(map, size, flags)
bpf_ringbuf_submit(data, flags)
bpf_ringbuf_output(map, data, size, flags)
```

Each helper is assigned a stable number; new helpers get new numbers and never change existing ones for ABI stability.

## Observing BPF programs

```bash
# List all loaded BPF programs
bpftool prog list
# 42: xdp  name xdp_drop_icmp  tag a04f5eef06a7f555  gpl
#         loaded_at 2024-01-15T10:00:00+0000  uid 0
#         xlated 112B  jited 88B  memlock 4096B  map_ids 3

# Show disassembly (eBPF or JIT)
bpftool prog dump xlated id 42
bpftool prog dump jited id 42

# Show a program's maps
bpftool prog show id 42 --pretty

# BPF stats
bpftool prog profile id 42 duration 5 cycles instructions

# Trace output
cat /sys/kernel/debug/tracing/trace_pipe
```

## Further reading

- [BPF Maps](bpf-maps.md) — Sharing data between BPF and userspace
- [BPF Verifier](bpf-verifier.md) — How safety is enforced
- [BTF and CO-RE](btf-core.md) — Writing portable BPF programs
- `kernel/bpf/syscall.c` — bpf() syscall implementation
- `samples/bpf/` in the kernel tree — in-tree examples
