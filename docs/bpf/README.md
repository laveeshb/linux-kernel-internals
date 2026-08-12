# BPF/eBPF

> Safe, programmable hooks into the Linux kernel

## What is eBPF?

eBPF (extended Berkeley Packet Filter) lets you run sandboxed programs in the kernel without writing kernel modules. Programs are:

- **Verified** before loading — the kernel proves they terminate and never access invalid memory
- **JIT-compiled** — native machine code performance after first load
- **Event-driven** — attached to hooks (syscalls, network, tracepoints, kprobes)
- **Observable** — share data with userspace via maps

```
Userspace                          Kernel
─────────────────────────────────────────────────────────
 C source                         Event hook fires
    │                                  │
    ▼                                  ▼
 clang -target bpf                BPF program runs
    │                                  │
    ▼                              reads/writes
 .o (BPF bytecode)               BPF maps ◄──────── userspace reads
    │
    ▼
 libbpf / bpf() syscall
    │
    ▼
 Verifier (safety check)
    │
    ▼
 JIT compiler → native code
    │
    ▼
 Attach to hook
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Architecture & Program Types](bpf-overview.md) | bpf() syscall, BPF_PROG_TYPE_*, loading flow |
| [BPF Maps](bpf-maps.md) | Hash, array, ringbuf, per-CPU maps, pinning |
| [BPF Verifier](bpf-verifier.md) | Safety proofs, register tracking, pointer restrictions |
| [BTF and CO-RE](btf-core.md) | Type information, portable programs across kernel versions |
| [libbpf and Skeletons](libbpf.md) | Userspace API, BPF skeleton workflow |
| [BPF Ring Buffer](bpf-ringbuf.md) | `BPF_MAP_TYPE_RINGBUF`, reservation model, epoll notification |
| [BPF Networking](bpf-networking.md) | TC, cgroup hooks, sockmap |
| [War Stories](war-stories.md) | Verifier CVEs, Spectre in BPF, and why unprivileged BPF was turned off by default |

## Quick orientation

**Where BPF hooks in:**

```
Network receive    → XDP (before skb allocation)
                   → TC (after skb, before routing)
                   → socket filter
Syscall entry/exit → tracepoint sys_enter_*/sys_exit_*
                   → seccomp-bpf
Kernel functions   → kprobe/kretprobe
                   → fentry/fexit (BTF-based, lower overhead)
User functions     → uprobe/uretprobe
Perf events        → perf_event (PMU, hardware counters)
Cgroups            → cgroup/skb, cgroup/sock, cgroup/connect
Scheduler          → sched_ext (BPF-defined schedulers, 6.12+)
```

**Key kernel files:**
- `kernel/bpf/verifier.c` — safety checker
- `kernel/bpf/core.c` — interpreter and JIT glue
- `kernel/bpf/syscall.c` — bpf() syscall implementation
- `kernel/bpf/helpers.c` — bpf_* helper functions
- `arch/x86/net/bpf_jit_comp.c` — x86-64 JIT compiler
