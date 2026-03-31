# Syscall Entry Path

> From the `syscall` instruction to kernel code — and back

## x86-64 hardware mechanism

When userspace executes `syscall`:

1. **CPU saves**: `rip` → `rcx`, `rflags` → `r11`, then clears IF
2. **CPU loads**: `rip` from `IA32_LSTAR` MSR (set to `entry_SYSCALL_64` at boot)
3. **CPU switches**: CS/SS from `IA32_STAR` MSR (kernel segments)

The `rax` register holds the syscall number. Arguments go in: `rdi`, `rsi`, `rdx`, `r10`, `r8`, `r9` (note: `r10` not `rcx` — `rcx` is clobbered by `syscall`).

Return value comes back in `rax`. On error, the kernel negates errno and userspace glibc converts it.

## entry_SYSCALL_64: the assembly entry point

```asm
/* arch/x86/entry/entry_64.S */
SYM_CODE_START(entry_SYSCALL_64)
    UNWIND_HINT_ENTRY
    ENDBR

    swapgs                  /* load kernel GS (points to per-CPU data) */
    /* Set up kernel stack using per-CPU cpu_current_top_of_stack */
    movq    %rsp, PER_CPU_VAR(cpu_tss_rw + TSS_sp2)
    SWITCH_TO_KERNEL_CR3 scratch_reg=%rsp
    movq    PER_CPU_VAR(cpu_current_top_of_stack), %rsp

    /* Push pt_regs — save all user registers */
    pushq   $__USER_DS                  /* ss */
    pushq   PER_CPU_VAR(cpu_tss_rw + TSS_sp2)  /* rsp */
    pushq   %r11                        /* rflags */
    pushq   $__USER_CS                  /* cs */
    pushq   %rcx                        /* rip */
    pushq   %rax                        /* syscall number (orig_rax) */
    PUSH_AND_CLEAR_REGS rax=$-ENOSYS    /* rax=-ENOSYS as default return */

    /* ... (IBRS mitigation, context tracking) ... */

    movq    %rsp, %rdi                  /* pt_regs pointer as first arg */
    movl    %eax, %esi                  /* syscall number as second arg */
    call    do_syscall_64
    /* ... return path ... */
SYM_CODE_END(entry_SYSCALL_64)
```

## struct pt_regs: saved register state

```c
/* arch/x86/include/asm/ptrace.h */
struct pt_regs {
    unsigned long r15;
    unsigned long r14;
    unsigned long r13;
    unsigned long r12;
    unsigned long rbp;
    unsigned long rbx;
    unsigned long r11;
    unsigned long r10;
    unsigned long r9;
    unsigned long r8;
    unsigned long rax;      /* syscall number / return value */
    unsigned long rcx;      /* saved rip (from syscall instruction) */
    unsigned long rdx;
    unsigned long rsi;
    unsigned long rdi;
    unsigned long orig_rax; /* original syscall number (rax before call) */
    unsigned long rip;      /* userspace instruction pointer */
    unsigned long cs;
    unsigned long eflags;
    unsigned long rsp;      /* userspace stack pointer */
    unsigned long ss;
};
```

## do_syscall_64: the dispatch

```c
/* arch/x86/entry/common.c */
__visible noinstr void do_syscall_64(struct pt_regs *regs, int nr)
{
    add_random_kstack_offset();
    nr = syscall_enter_from_user_mode(regs, nr);

    instrumentation_begin();

    if (!do_syscall_x64(regs, nr) && !do_syscall_x32(regs, nr) && nr != -1) {
        /* syscall number out of range */
        regs->ax = __x64_sys_ni_syscall(regs);  /* -ENOSYS */
    }

    instrumentation_end();
    syscall_exit_to_user_mode(regs);
}

static __always_inline bool do_syscall_x64(struct pt_regs *regs, int nr)
{
    unsigned int unr = nr;

    if (likely(unr < NR_syscalls)) {
        unr = array_index_nospec(unr, NR_syscalls);  /* Spectre mitigation */
        regs->ax = sys_call_table[unr](regs);         /* dispatch! */
        return true;
    }
    return false;
}
```

## sys_call_table: the dispatch table

```c
/* arch/x86/entry/syscall_64.c */
asmlinkage const sys_call_ptr_t sys_call_table[] = {
#include <asm/syscalls_64.h>
};
```

The `syscalls_64.h` is generated from `syscall_64.tbl`:

```
# syscall_64.tbl (arch/x86/entry/syscalls/syscall_64.tbl)
# <number> <abi>  <name>           <entry point>
0          common  read              sys_read
1          common  write             sys_write
2          common  open              sys_open
3          common  close             sys_close
...
62         common  kill              sys_kill
...
435        common  clone3            sys_clone3
```

## Argument passing and copying

Syscall arguments come in registers. For pointers into userspace, the kernel must **copy** them in — it can never directly dereference a userspace pointer:

```c
/* Copying from userspace */
copy_from_user(kernel_buf, user_ptr, size)
    → check_access_ok(user_ptr, size)  /* is address in user range? */
    → __copy_from_user()               /* architecture-specific copy */
    → returns bytes NOT copied (0 = success)

/* Copying to userspace */
copy_to_user(user_ptr, kernel_buf, size)

/* Copying a string from userspace (stops at NUL or len) */
strncpy_from_user(kernel_buf, user_ptr, max_len)

/* Single value helpers (inlined, optimized) */
get_user(x, user_ptr)   /* x = *user_ptr */
put_user(x, user_ptr)   /* *user_ptr = x */
```

Why mandatory copies?
- User pointers might be NULL or invalid
- Kernel and user address spaces are separate (KPTI)
- Userspace can change the pointed-to memory after the check (TOCTOU)

## KPTI and CR3 switching

Kernel Page Table Isolation (KPTI) prevents Meltdown by using different page tables in user mode vs kernel mode:

```
User mode:  CR3 → user page tables (kernel not mapped, only entry stubs)
                  ↓ syscall instruction
Kernel mode: SWITCH_TO_KERNEL_CR3 (expensive TLB flush!)
             CR3 → kernel page tables (full mapping)
                  ↓ sysretq / swapgs
User mode:  SWITCH_TO_USER_CR3
```

On modern CPUs with PCID support, KPTI uses Process Context IDs to avoid full TLB flushes, keeping each address space's TLB entries tagged.

## The vDSO: avoiding syscalls for fast operations

Some syscalls are called millions of times per second (e.g., `gettimeofday`, `clock_gettime`). The kernel exports a virtual Dynamic Shared Object (vDSO) — a small piece of code mapped into every process — that implements these without entering kernel mode:

```bash
# See the vDSO mapped in a process
cat /proc/self/maps | grep vdso
# 7fff12345000-7fff12346000 r-xp 00000000 00:00 0  [vdso]

# Functions in the vDSO
nm /proc/self/maps  # doesn't work, but:
objdump -T /lib/x86_64-linux-gnu/vdso.so.1 2>/dev/null | grep -i clock
```

The vDSO reads kernel timekeeping data from a shared memory page (`vvar`) that the kernel updates atomically. The vDSO function reads the data directly, with no privilege switch:

```c
/* vDSO: arch/x86/entry/vdso/vclock_gettime.c */
static __always_inline int
do_hres(const struct vdso_data *vd, clockid_t clk,
        struct __kernel_timespec *ts)
{
    const struct vdso_timestamp *vdso_ts = &vd->basetime[clk];
    u64 cycles, last, sec, ns;
    u32 seq;

    do {
        seq = vdso_read_begin(vd);     /* seqlock read_begin */
        cycles = vdso_cycles();        /* read TSC (no syscall) */
        ns = vdso_ts->nsec;
        last = vd->cycle_last;
        if (unlikely((s64)(cycles - last) < 0))
            return clock_gettime_fallback(clk, ts);
        ns += vdso_calc_delta(cycles, last, vd->mask, vd->mult);
        ns >>= vd->shift;
        sec = vdso_ts->sec;
    } while (unlikely(vdso_read_retry(vd, seq)));  /* seqlock retry */

    ts->tv_sec  = sec + __iter_div_u64_rem(ns, NSEC_PER_SEC, &ns);
    ts->tv_nsec = ns;
    return 0;
}
```

Syscalls fast-pathed through the vDSO (no ring switch):
- `clock_gettime(CLOCK_REALTIME/MONOTONIC/...)`
- `gettimeofday()`
- `clock_getres()`
- `getcpu()`

## Seccomp: restricting syscalls

The seccomp filter runs on every syscall before the dispatch table:

```c
/* kernel/seccomp.c: in syscall_enter_from_user_mode() */
if (unlikely(task_work_pending(current)))
    task_work_run();

if (unlikely(test_thread_flag(TIF_SECCOMP))) {
    u32 action = seccomp_run_filters(nr, &match);
    /* action can be: ALLOW, KILL, ERRNO, TRACE, LOG, TRAP */
}
```

## Signals and restarts

Some syscalls can be interrupted by signals (`EINTR`). The kernel supports automatic restart for these:

```c
/* ERESTARTSYS: restart if no signal handler, return EINTR if one */
return -ERESTARTSYS;

/* ERESTARTNOINTR: always restart, transparent to userspace */
return -ERESTARTNOINTR;

/* ERESTARTNOHAND: restart if no handler installed */
return -ERESTARTNOHAND;
```

These special codes (`< -MAX_ERRNO`) never reach userspace — the signal path converts them to either `EINTR` or re-queues the syscall.

## Further reading

- [SYSCALL_DEFINE and dispatch](syscall-define.md) — Defining syscalls in C
- [Adding a new syscall](adding-syscall.md) — Practical guide for kernel contributors
- `arch/x86/entry/entry_64.S` — Assembly entry point
- `arch/x86/entry/common.c` — do_syscall_64()
- `Documentation/process/adding-syscalls.rst` — kernel documentation
