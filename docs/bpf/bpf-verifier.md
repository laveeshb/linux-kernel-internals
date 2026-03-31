# BPF Verifier

> How the kernel proves BPF programs are safe before running them

## What the verifier does

Every BPF program must pass the verifier before it can run. The verifier statically analyzes the bytecode and proves:

1. **Termination** — no infinite loops (bounded loops since kernel 5.3)
2. **Memory safety** — all pointer dereferences are in-bounds
3. **Type safety** — helpers are called with correct argument types
4. **Context correctness** — only fields allowed for the program type are accessed
5. **Stack safety** — no stack overflow, no uninitialized reads

The verifier performs this analysis in `kernel/bpf/verifier.c` (~30,000 lines).

## Two phases of verification

### Phase 1: CFG analysis (dead code elimination)

```
bpf_check()
  → check_subprogs()        /* find function boundaries */
  → check_cfg()             /* build control flow graph */
      → mark reachable instructions
      → detect back edges (loops)
      → verify loop bounds (for bounded loops)
```

The CFG check marks all reachable instructions. Dead code (unreachable) is rejected.

### Phase 2: Abstract interpretation (type and bounds tracking)

```
bpf_check()
  → do_check_main()         /* simulate execution of all paths */
      → for each instruction:
          check_alu_op()    /* arithmetic safety */
          check_mem_access() /* pointer dereference safety */
          check_helper_call() /* helper argument types */
      → explore all branches (must verify both sides of conditional)
```

## Register state tracking

The verifier tracks the type and bounds of every register at every program point:

```c
/* kernel/bpf/verifier.c */
struct bpf_reg_state {
    enum bpf_reg_type type;  /* what kind of pointer this is */
    /* For scalar values: */
    s64  smin_value;   /* signed minimum */
    s64  smax_value;   /* signed maximum */
    u64  umin_value;   /* unsigned minimum */
    u64  umax_value;   /* unsigned maximum */
    /* For pointers: */
    s32  off;          /* constant offset added */
    u32  range;        /* bytes accessible from this pointer */
    struct bpf_map *map_ptr; /* if PTR_TO_MAP_VALUE */
    /* ... */
};

enum bpf_reg_type {
    NOT_INIT,           /* register not initialized */
    SCALAR_VALUE,       /* integer (no pointer semantics) */
    PTR_TO_CTX,         /* pointer to program context (xdp_md, etc.) */
    PTR_TO_MAP_KEY,     /* pointer to map key area on stack */
    PTR_TO_MAP_VALUE,   /* pointer to map value (lookup result) */
    PTR_TO_MAP_VALUE_OR_NULL, /* must NULL-check before use */
    PTR_TO_STACK,       /* pointer into BPF stack */
    PTR_TO_PACKET,      /* pointer into skb data */
    PTR_TO_PACKET_END,  /* pointer to skb data end */
    PTR_TO_FUNC,        /* pointer to BPF subfunction */
    /* ... */
};
```

## Pointer safety: the NULL check requirement

The most common verifier rejection is using a pointer without checking for NULL:

```c
/* This FAILS verification */
SEC("kprobe/tcp_sendmsg")
int bad_prog(struct pt_regs *ctx)
{
    u32 pid = bpf_get_current_pid_tgid() >> 32;
    u64 *count = bpf_map_lookup_elem(&counts, &pid);
    (*count)++;  /* ERROR: count might be NULL */
    return 0;
}

/* Verifier error:
 * 5: (85) call unknown#1
 * 6: (07) r0 += 1
 * R0 invalid mem access 'map_value_or_null'
 */

/* This PASSES */
SEC("kprobe/tcp_sendmsg")
int good_prog(struct pt_regs *ctx)
{
    u32 pid = bpf_get_current_pid_tgid() >> 32;
    u64 *count = bpf_map_lookup_elem(&counts, &pid);
    if (!count)
        return 0;  /* NULL check required */
    (*count)++;    /* Now verifier knows count != NULL */
    return 0;
}
```

After the NULL check, `count` transitions from `PTR_TO_MAP_VALUE_OR_NULL` to `PTR_TO_MAP_VALUE` — the verifier tracks this state split across the two branches.

## Bounds checking for packet access

XDP and TC programs must prove every packet access is in-bounds:

```c
SEC("xdp")
int parse_http(struct xdp_md *ctx)
{
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    struct ethhdr *eth = data;

    /* REQUIRED: bounds check before accessing eth fields */
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    /* Now verifier knows eth[0..sizeof(ethhdr)-1] is valid */
    if (eth->h_proto != htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *ip = data + sizeof(struct ethhdr);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    /* ip->... accesses are now verified safe */
    return XDP_PASS;
}
```

The verifier tracks `PTR_TO_PACKET` offsets and validates that arithmetic stays within `[data, data_end)`.

## Stack usage

BPF programs have a fixed 512-byte stack. The verifier tracks which stack slots are initialized:

```c
/* Stack-allocated variables are tracked per-slot (8 bytes) */
SEC("kprobe/do_sys_open")
int trace_open(struct pt_regs *ctx)
{
    char path[256];  /* uses 256 bytes of the 512-byte stack */

    /* Must initialize before passing to helper */
    /* bpf_probe_read_user_str initializes path[] */
    bpf_probe_read_user_str(path, sizeof(path),
                            (void *)PT_REGS_PARM2(ctx));
    bpf_printk("open: %s\n", path);
    return 0;
}
```

Passing an uninitialized stack slot to a helper that reads it is a verifier error.

## Bounded loops (since 5.3)

Before 5.3, all loops were forbidden. Now the verifier allows loops if it can prove a bound:

```c
/* Works: verifier can track i < 10 */
int sum = 0;
for (int i = 0; i < 10; i++)
    sum += array[i];

/* Works: bounded by map max_entries */
bpf_for_each_map_elem(&map, callback, &ctx, 0);

/* May fail: verifier can't always prove termination for
   dynamic bounds — add a #pragma unroll or manual bound */
u32 n = bpf_map_lookup_elem(&config, &zero);
for (u32 i = 0; i < n; i++) {   /* n is runtime value */
    /* verifier may reject if it can't bound iterations */
}

/* Fix: cap the bound explicitly */
if (n > MAX_ITERATIONS)
    n = MAX_ITERATIONS;
for (u32 i = 0; i < n; i++) { /* now bounded */ }
```

The verifier limits loop iterations to prevent exponential state explosion during analysis.

## Complexity limit

The verifier tracks program states (register + stack snapshot at each instruction). To prevent DoS via complex programs:

```
BPF_COMPLEXITY_LIMIT_INSNS = 1,000,000  /* verified instructions */
/* The verifier also limits states per instruction to prevent state explosion */
```

If a program is too complex:
```
BPF program is too large. Processed 1000001 insn
```

Strategies to reduce complexity:
- Use `__always_inline` to inline helper functions (reduces call sites)
- Split into tail calls (each program has its own limit)
- Use `bpf_loop()` instead of unrolled loops

## Reading verifier output

Request the verifier log when loading fails:

```c
char log_buf[1 << 16];
union bpf_attr attr = {
    .log_level = 2,           /* 1=errors, 2=verbose, 3+more */
    .log_buf   = (uint64_t)log_buf,
    .log_size  = sizeof(log_buf),
    /* ... */
};
```

Sample verifier output for a type error:

```
0: (bf) r6 = r1
1: (85) call bpf_get_current_pid_tgid#14
2: (77) r0 >>= 32
3: (63) *(u32 *)(r10 -4) = r0     ; store pid on stack
4: (bf) r2 = r10
5: (07) r2 += -4                   ; r2 = &pid (stack pointer)
6: (18) r1 = 0xffff...             ; r1 = &counts map
8: (85) call bpf_map_lookup_elem#1
9: (15) if r0 == 0x0 goto pc+2    ; NULL check
10: (07) r0 += 1                   ; increment counter
11: (62) *(u32 *)(r0 +0) = ...    ; WRONG: writing to pointer+0
; R0 is PTR_TO_MAP_VALUE but write at offset 0 for u64 needs range check
```

## Privileged vs unprivileged BPF

Unprivileged BPF (`CAP_BPF` not set) is heavily restricted:
- Only `BPF_PROG_TYPE_SOCKET_FILTER` and `BPF_PROG_TYPE_CGROUP_SKB`
- No pointer arithmetic beyond map value access
- JIT hardening: constant blinding (prevents JIT spraying attacks)
- Verifier enforces stricter rules

Privileged BPF requires:
- `CAP_BPF` (since 5.8, split from `CAP_SYS_ADMIN`)
- `CAP_PERFMON` for tracing programs
- `CAP_NET_ADMIN` for XDP and TC programs

```bash
# Check kernel BPF settings
sysctl kernel.unprivileged_bpf_disabled
# 0 = allow unprivileged BPF, 1 = disable (requires CAP_BPF or CAP_SYS_ADMIN)
```

## Further reading

- [BPF Maps](bpf-maps.md) — What map access patterns the verifier allows
- [BTF and CO-RE](btf-core.md) — How BTF helps the verifier with type info
- `kernel/bpf/verifier.c` — Complete verifier implementation
- `Documentation/bpf/verifier.rst` — Official kernel verifier documentation
