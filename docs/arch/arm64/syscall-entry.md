# ARM64 Syscall Entry

> From SVC instruction to kernel C handler and back

Every system call made by a 64-bit ARM process — `read()`, `write()`, `mmap()`, or any other — follows a
specific hardware and software path from `SVC #0` in userspace through the kernel's assembly entry point,
register-save machinery, C dispatch layer, and back to userspace via `ERET`. This page traces that path.

---

## The SVC instruction

On ARM64, system calls are made with `SVC #0` (Supervisor Call). The calling convention is:

| Register | Role |
|----------|------|
| `x8` | Syscall number |
| `x0`–`x5` | Arguments (up to 6) |
| `x0` | Return value (after return) |

```asm
/* Userspace: calling write(1, buf, len) on ARM64 */
mov  x8, #64        /* __NR_write = 64 */
mov  x0, #1         /* fd = 1 (stdout) */
ldr  x1, =buf       /* buffer address */
mov  x2, #len       /* length */
svc  #0             /* trap to EL1; return value in x0 */
```

The immediate in `SVC #0` is conventionally zero — Linux ignores it. The syscall number comes from `x8`.

### Contrast with x86-64

| Aspect | ARM64 (`SVC #0`) | x86-64 (`SYSCALL`) |
|--------|------------------|-------------------|
| Syscall number | `x8` | `rax` |
| Arguments | `x0`–`x5` | `rdi`, `rsi`, `rdx`, `r10`, `r8`, `r9` |
| Return value | `x0` | `rax` |
| Saved return address | CPU writes `ELR_EL1` | CPU writes `rcx` |
| Saved flags | CPU writes `SPSR_EL1` | CPU writes `r11` |
| Entry mechanism | Exception vector (VBAR_EL1) | Fixed MSR (LSTAR) |

On ARM64, `SVC #0` triggers a synchronous exception dispatched through the vector table. On x86-64,
`SYSCALL` jumps directly to the `LSTAR` MSR address without going through the IDT.

---

## Exception vector dispatch

When `SVC #0` executes, the CPU takes a **synchronous exception** and jumps to `VBAR_EL1 + 0x400` —
the slot for synchronous exceptions from 64-bit EL0:

```
VBAR_EL1 + 0x200: Synchronous, EL1 with SP_ELx   (kernel exceptions)
VBAR_EL1 + 0x400: Synchronous, lower EL (AArch64) ← SVC from 64-bit EL0
VBAR_EL1 + 0x600: Synchronous, lower EL (AArch32) ← SVC from 32-bit EL0
```

The Linux vector table in `arch/arm64/kernel/entry.S`:

```asm
/* arch/arm64/kernel/entry.S */
    .align  11
SYM_CODE_START(vectors)
    kernel_ventry   1, h, 64, sync    /* Synchronous EL1h (kernel exceptions) */
    kernel_ventry   1, h, 64, irq     /* IRQ EL1h */
    /* ... */
    kernel_ventry   0, t, 64, sync    /* Synchronous EL0, 64-bit ← here for SVC */
    kernel_ventry   0, t, 64, irq     /* IRQ EL0, 64-bit */
    /* ... */
    kernel_ventry   0, t, 32, sync    /* Synchronous EL0, 32-bit (AArch32 compat) */
    /* ... */
SYM_CODE_END(vectors)
```

### ESR_EL1 and EC == 0x15

The CPU populates `ESR_EL1` with the exception cause. Bits 31:26 are the **Exception Class (EC)**; for
a 64-bit SVC, EC is `0x15`:

```c
/* arch/arm64/include/asm/esr.h */
#define ESR_ELx_EC_SHIFT    26
#define ESR_ELx_EC_SVC64    0x15   /* SVC from 64-bit EL0 */
#define ESR_ELx_EC_SVC32   0x11   /* SVC from 32-bit EL0 */
```

The handler reads `ESR_EL1`, extracts EC, and branches to `el0_svc`:

```asm
/* arch/arm64/kernel/entry.S (simplified) */
SYM_CODE_START(el0t_64_sync_handler)
    kernel_entry 0, 64               /* save registers to pt_regs */

    mrs     x22, esr_el1             /* read exception syndrome */
    lsr     x24, x22, #ESR_ELx_EC_SHIFT

    cmp     x24, #ESR_ELx_EC_SVC64
    b.eq    el0_svc                  /* branch to SVC handler */
    b       el0_sync_handler         /* other exceptions: faults, debug */
SYM_CODE_END(el0t_64_sync_handler)
```

---

## Register save and restore

`kernel_entry 0, 64` saves all userspace registers onto the kernel stack as a `struct pt_regs`:

```c
/* arch/arm64/include/asm/ptrace.h */
struct pt_regs {
    union {
        struct user_pt_regs user_regs;
        struct {
            u64 regs[31];   /* x0–x30 */
            u64 sp;         /* user stack pointer (SP_EL0) */
            u64 pc;         /* ELR_EL1: user return address */
            u64 pstate;     /* SPSR_EL1: saved processor state */
        };
    };
    u64 orig_x0;    /* original x0 (for syscall restart) */
    s32 syscallno;  /* syscall number */
    /* ... additional fields for MTE, SVE state ... */
};
```

The macro switches to the per-task kernel stack (from `SP_EL1`), saves `x0`–`x30`, `sp`, `ELR_EL1`
(return PC), and `SPSR_EL1` (saved PSTATE). The resulting `pt_regs *` is passed to all C handlers.

On the return path, `kernel_exit 0` restores all fields and executes `ERET`, which atomically restores
the program counter from `ELR_EL1` and processor state from `SPSR_EL1`, returning to EL0.

---

## The C dispatch path

After register save, control flows from assembly into C:

```
el0_svc (entry.S)
  └─► do_el0_svc (syscall.c)
        └─► el0_svc_common (syscall.c)
              ├── syscall_enter_from_user_mode_work()  [tracing, seccomp]
              └── invoke_syscall()
                    └─► sys_call_table[scno](regs)
```

`el0_svc_common` in `arch/arm64/kernel/syscall.c` saves `orig_x0` and `syscallno` into `pt_regs`, runs
any pre-syscall work, then calls `invoke_syscall`:

```c
/* arch/arm64/kernel/syscall.c */
static void invoke_syscall(struct pt_regs *regs, unsigned int scno,
                            unsigned int sc_nr,
                            const syscall_fn_t syscall_table[])
{
    long ret;

    if (scno < sc_nr) {
        syscall_fn_t syscall_fn;
        syscall_fn = syscall_table[array_index_nospec(scno, sc_nr)];  /* Spectre v1 */
        ret = __invoke_syscall(regs, syscall_fn);
    } else {
        ret = do_ni_syscall(regs, scno);   /* -ENOSYS */
    }

    syscall_set_return_value(current, regs, 0, ret);
}
```

### The syscall table

The ARM64 native syscall table is built in `arch/arm64/kernel/sys.c` via the `__SYSCALL()` macro:

```c
/* arch/arm64/kernel/sys.c */
#define __SYSCALL(nr, sym)  [nr] = __arm64_##sym,

const syscall_fn_t sys_call_table[__NR_syscalls] = {
    [0 ... __NR_syscalls - 1] = __arm64_sys_ni_syscall,
#include <asm/unistd.h>
};
```

ARM64 uses the generic syscall numbering from `include/uapi/asm-generic/unistd.h` — the same table
shared with RISC-V and LoongArch. `__NR_write` is 64, `__NR_read` is 63, `__NR_openat` is 56.

---

## Syscall tracing and seccomp

`syscall_enter_from_user_mode_work()` in `kernel/entry/common.c` handles all pre-syscall hooks. It
checks the `syscall_work` flags in `thread_info`:

```c
/* kernel/entry/common.c */
static long syscall_enter_from_user_mode_work(struct pt_regs *regs, long syscall)
{
    u32 work = READ_ONCE(current_thread_info()->syscall_work);

    if (work & SYSCALL_WORK_SECCOMP)
        syscall = __secure_computing(NULL);   /* run BPF filter */

    if (work & SYSCALL_WORK_SYSCALL_TRACEPOINT)
        trace_sys_enter(regs, syscall);       /* sys_enter raw tracepoint */

    syscall = ptrace_syscall_enter(regs, syscall);  /* ptrace stop if traced */

    return syscall;
}
```

When a task is traced with `PTRACE_SYSCALL` (as used by `strace`), `TIF_SYSCALL_TRACE` is set and
`ptrace_syscall_enter()` pauses the task. The tracer reads registers via `PTRACE_GETREGSET` with
`NT_PRSTATUS`, which exposes `struct user_pt_regs`.

The return path mirrors entry: `syscall_exit_to_user_mode()` fires `sys_exit` tracepoints, handles
ptrace exit-stops, and delivers any pending signals before `kernel_exit` restores registers.

---

## AArch32 compat

A 64-bit ARM64 kernel can run 32-bit ARM (AArch32) ELF binaries (`CONFIG_COMPAT`). These processes also
use `SVC #0`, but with a different register convention:

| Register | Role |
|----------|------|
| `r7` | Syscall number (EABI) |
| `r0`–`r5` | Arguments |
| `r0` | Return value |

The hardware routes AArch32 synchronous exceptions to **VBAR_EL1 + 0x600** instead of `+0x400`. The
entry handler `el0t_32_sync_handler` recognises EC `0x11` (`ESR_ELx_EC_SVC32`) and branches to
`el0_svc_compat`, which dispatches via a separate table:

```c
/* arch/arm64/kernel/sys_compat.c */
#define __SYSCALL(nr, sym)  [nr] = __arm64_compat_##sym,

const syscall_fn_t compat_sys_call_table[__NR_compat_syscalls] = {
    [0 ... __NR_compat_syscalls - 1] = __arm64_compat_sys_ni_syscall,
#include <asm/unistd32.h>
};
```

AArch32 syscall numbers match the historical 32-bit ARM ABI and differ from native arm64 numbers.
Compat handlers use `compat_*` types (`compat_size_t`, `compat_timespec64`, `compat_uptr_t`) to
translate 32-bit struct layouts. `TIF_32BIT` marks a compat thread; `is_compat_task()` checks it.

---

## vDSO: avoiding SVC for hot paths

`clock_gettime`, `gettimeofday`, and `clock_getres` are called millions of times per second in some
workloads. The **vDSO** (virtual Dynamic Shared Object) implements these without `SVC #0` by reading
timekeeping data from a kernel-managed shared page:

```bash
cat /proc/self/maps | grep -E 'vdso|vvar'
# ffff800000000000-ffff800000001000 r--p 00000000 00:00 0  [vvar]
# ffff800000001000-ffff800000002000 r-xp 00000000 00:00 0  [vdso]
```

The ARM64 vDSO lives at `arch/arm64/kernel/vdso/`. Instead of the x86 TSC, it reads `CNTVCT_EL0` — the
ARM generic virtual timer counter, which the kernel configures as accessible from EL0:

```asm
mrs x0, CNTVCT_EL0   /* read virtual counter — no privilege transition */
```

The vDSO reads `struct vdso_data` (from `include/vdso/datapage.h`) in the **vvar page**, using a seqlock
to detect concurrent kernel updates. The shared implementation in `lib/vdso/gettimeofday.c` is compiled
for both arm64 and x86; only `__arch_get_hw_counter()` is architecture-specific. If the clock mode is
`VDSO_CLOCKMODE_NONE` (e.g., after VM migration), the vDSO falls back transparently to `svc #0`.

There is no vsyscall fixed-address page on ARM64 — that is an x86-64-only legacy.

---

## Observability

### strace

```bash
strace ls                       # trace all syscalls
strace -e trace=read,write ls   # filter by syscall name
strace -T ls                    # show per-syscall elapsed time
strace -p <pid>                 # attach to a running process
```

`strace` uses `ptrace(PTRACE_SYSCALL)` and never sees vDSO-accelerated calls — those never issue
`svc #0`.

### perf trace and bpftrace

```bash
perf trace ls                   # low-overhead syscall trace via tracepoints
perf trace --summary sleep 5    # per-syscall counts and latency summary

# Count syscalls by name
bpftrace -e 'tracepoint:syscalls:sys_enter_* { @[probe] = count(); }'

# Trace specific process
bpftrace -e 'tracepoint:syscalls:sys_enter_read /pid == 1234/ { printf("fd=%d\n", args->fd); }'
```

### /proc/PID/syscall

```bash
cat /proc/$(pidof sshd)/syscall
# 281 0x4 0x7ffd3a2b1000 0x400 0x0 0x0 0x0 0x7ffd3a2b1080 0xffffb3a82000
# ^nr  ^args...                                              ^sp    ^pc
```

Shows the syscall number, arguments, user SP, and user PC for a process blocked in a syscall.

### Raw tracepoints

```bash
# Enable sys_enter_read tracing via ftrace
echo 1 > /sys/kernel/debug/tracing/events/syscalls/sys_enter_read/enable
cat /sys/kernel/debug/tracing/trace
```

---

## Further reading

**In this site:**

- [ARM64 Exception Model](exception-model.md) — VBAR_EL1, ESR_EL1, exception levels, and the GIC
- [ARM64 Memory Model](memory-model.md) — Weak ordering, barriers, and LDAR/STLR
- [x86-64 Syscall Entry](../x86/syscall-entry.md) — SYSCALL/SYSRET, entry_SYSCALL_64, KPTI
- [Syscall Entry Path](../../syscalls/syscall-entry.md) — Architecture-neutral overview
- [vDSO and Virtual System Calls](../../syscalls/vdso.md) — vvar page, seqlock, clock modes
- [32-bit Compat Syscalls](../../syscalls/compat.md) — compat types, compat_sys_call_table
- [ptrace and Syscall Interception](../../syscalls/ptrace-interception.md) — How strace works

**Kernel source files:**

- `arch/arm64/kernel/entry.S` — vector table, `kernel_entry`/`kernel_exit`, `el0t_64_sync_handler`
- `arch/arm64/kernel/syscall.c` — `do_el0_svc`, `el0_svc_common`, `invoke_syscall`
- `arch/arm64/kernel/sys.c` — `sys_call_table` definition
- `arch/arm64/kernel/sys_compat.c` — `compat_sys_call_table` for AArch32 processes
- `arch/arm64/kernel/vdso/` — ARM64 vDSO source
- `arch/arm64/include/asm/ptrace.h` — `struct pt_regs` layout
- `arch/arm64/include/asm/esr.h` — ESR_EL1 exception class constants
- `include/vdso/datapage.h` — `struct vdso_data` (shared vvar layout)
- `lib/vdso/gettimeofday.c` — Shared vDSO clock implementation (arm64 and x86)
- `kernel/entry/common.c` — `syscall_enter_from_user_mode`, `syscall_exit_to_user_mode`

**External:**

- ARM Architecture Reference Manual (ARM DDI 0487) — definitive AArch64 exception model reference
- `Documentation/arm64/` in the kernel tree
