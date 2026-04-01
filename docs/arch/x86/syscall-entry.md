# x86-64 Syscall Entry

> SYSCALL instruction, entry_SYSCALL_64, vDSO, and signal delivery

Every time a user process calls `read()`, `write()`, `mmap()`, or any other system call, control transfers from user space to the kernel and back. On x86-64, this transition is handled by the `SYSCALL`/`SYSRET` instruction pair — a fast path that avoids the overhead of the older `int 0x80` interrupt mechanism.

---

## The SYSCALL instruction

`SYSCALL` is an x86-64 instruction (available in 64-bit mode) that performs a privilege transition from ring 3 (user) to ring 0 (kernel). Unlike an interrupt-based entry, `SYSCALL` does not consult the IDT and does not push a full exception frame — it is a streamlined mechanism specifically designed for syscall entry.

### What SYSCALL does (hardware behavior)

```
When the CPU executes SYSCALL:

1. Save user RIP → RCX      (return address for SYSRET)
2. Save RFLAGS  → R11       (to restore on return)
3. Clear RFLAGS per SFMASK MSR (e.g., clears IF: no interrupts during entry trampoline)
4. Load CS from STAR MSR[47:32]  (kernel code segment selector)
5. Load SS from STAR MSR[47:32]+8 (kernel data segment selector)
6. Load RIP from LSTAR MSR   (→ entry_SYSCALL_64)
7. Does NOT switch the stack — RSP still points at user stack

Registers at the point entry_SYSCALL_64 begins:
  RAX = syscall number
  RDI = arg1, RSI = arg2, RDX = arg3, R10 = arg4, R8 = arg5, R9 = arg6
  RCX = saved user RIP (destroyed by SYSCALL)
  R11 = saved user RFLAGS (destroyed by SYSCALL)
  RSP = still pointing at user stack (not yet switched)
```

Note that the SYSCALL ABI differs from the C ABI in one way: the 4th argument comes in `R10` rather than `RCX` (because `RCX` is overwritten by the SYSCALL instruction itself).

### MSR setup

Three MSRs configure the SYSCALL behavior. The kernel sets them in `arch/x86/kernel/cpu/common.c` during `syscall_init()`:

| MSR | Address | Content |
|-----|---------|---------|
| `STAR` | `0xC0000081` | Bits 47:32 = kernel CS selector; bits 63:48 = user CS selector |
| `LSTAR` | `0xC0000082` | 64-bit SYSCALL target RIP (address of `entry_SYSCALL_64`) |
| `SFMASK` | `0xC0000084` | RFLAGS bits to clear on SYSCALL (clears `IF`, `TF`, `DF`, `AC`) |

```c
/* arch/x86/kernel/cpu/common.c */
void syscall_init(void)
{
    wrmsr(MSR_STAR, 0, (__USER32_CS << 16) | __KERNEL_CS);
    wrmsrl(MSR_LSTAR, (unsigned long)entry_SYSCALL_64);

    /*
     * Flags to clear on syscall entry: direction flag, interrupt flag,
     * trap flag, and alignment check flag.
     */
    wrmsrl(MSR_SYSCALL_MASK,
           X86_EFLAGS_TF|X86_EFLAGS_DF|X86_EFLAGS_IF|
           X86_EFLAGS_IOPL|X86_EFLAGS_AC|X86_EFLAGS_NT);
}
```

---

## entry_SYSCALL_64 (`arch/x86/entry/entry_64.S`)

`entry_SYSCALL_64` is the assembly entry point for all 64-bit syscalls. It must:
1. Save user state
2. Switch to a kernel stack
3. Enable interrupts (the SFMASK cleared IF; the kernel enables it after saving state)
4. Call `do_syscall_64()`
5. Restore user state and return

```asm
/* arch/x86/entry/entry_64.S (simplified, illustrative) */

SYM_CODE_START(entry_SYSCALL_64)
    /* We arrive here with user RSP; must not touch it until we save it */

    /* swapgs: swap GS.base with KernelGSbase MSR.
     * After this, GS points to the per-CPU data area.
     * This lets us access per-CPU variables to find the kernel stack. */
    swapgs

    /* Save user RSP to the per-CPU area; switch to kernel stack.
     * cpu_current_top_of_stack is a per-CPU variable holding the
     * top of the kernel stack for this CPU. */
    movq    %rsp, PER_CPU_VAR(cpu_tss_rw + TSS_sp2)
    SWITCH_TO_KERNEL_CR3 scratch_reg=%rsp   /* KPTI: switch to kernel PGD */
    movq    PER_CPU_VAR(cpu_current_top_of_stack), %rsp

    /* Push a synthetic exception frame (struct pt_regs) on the kernel stack */
    pushq   $__USER_DS                  /* SS */
    pushq   PER_CPU_VAR(cpu_tss_rw + TSS_sp2)  /* RSP (saved user stack) */
    pushq   %r11                        /* RFLAGS */
    pushq   $__USER_CS                  /* CS */
    pushq   %rcx                        /* RIP (user return address) */

    /* Save all other registers (building the rest of struct pt_regs) */
    pushq   %rax        /* orig_ax = syscall number */
    PUSH_AND_CLEAR_REGS rax=$-ENOSYS   /* push rdi..r15, clear sensitive regs */

    /* Now we have a full struct pt_regs on the kernel stack */
    movq    %rsp, %rdi  /* pt_regs * as first argument */

    /* Enable interrupts — safe now that we are on the kernel stack */
    TRACE_IRQS_OFF
    call    do_syscall_64

    /* ... return path: restore registers, SWAPGS, SYSRET/IRET ... */
SYM_CODE_END(entry_SYSCALL_64)
```

The `SWITCH_TO_KERNEL_CR3` macro is only active when KPTI is compiled in and running. It loads the kernel CR3 before accessing kernel stacks.

---

## struct pt_regs

The assembly builds a `struct pt_regs` on the kernel stack. This structure captures the complete register state of the user process:

```c
/* arch/x86/include/asm/ptrace.h */
struct pt_regs {
    /*
     * C ABI says these regs are callee-preserved. They aren't saved on kernel entry
     * unless syscall needs a full register dump (e.g., for ptrace).
     */
    unsigned long r15;
    unsigned long r14;
    unsigned long r13;
    unsigned long r12;
    unsigned long rbp;
    unsigned long rbx;

    /* These regs are callee-clobbered. Always saved on kernel entry. */
    unsigned long r11;   /* saved RFLAGS (for SYSCALL path) */
    unsigned long r10;
    unsigned long r9;
    unsigned long r8;
    unsigned long rax;   /* syscall return value */
    unsigned long rcx;   /* saved RIP (for SYSCALL path) */
    unsigned long rdx;
    unsigned long rsi;
    unsigned long rdi;

    /* On SYSCALL entry, orig_rax = syscall number.
     * On exception entry, orig_rax = -1 or the error code. */
    unsigned long orig_ax;

    /* These are pushed by hardware on exception, or synthesized for SYSCALL */
    unsigned long ip;    /* user RIP */
    unsigned long cs;    /* user CS */
    unsigned long flags; /* user RFLAGS */
    unsigned long sp;    /* user RSP */
    unsigned long ss;    /* user SS */
};
```

The layout matches what the hardware pushes during an interrupt/exception, so the same `pt_regs` structure is used for both paths.

---

## do_syscall_64() and the syscall table

`do_syscall_64()` dispatches to the actual syscall handler:

```c
/* arch/x86/entry/common.c */
__visible noinstr void do_syscall_64(struct pt_regs *regs, int nr)
{
    add_random_kstack_offset();
    nr = syscall_enter_from_user_mode(regs, nr);

    instrumentation_begin();

    if (!do_syscall_x64(regs, nr) && !do_syscall_x32(regs, nr) && nr != -1) {
        /* syscall not found */
        regs->ax = __x64_sys_ni_syscall(regs);
    }

    instrumentation_end();
    syscall_exit_to_user_mode(regs);
}

static __always_inline bool do_syscall_x64(struct pt_regs *regs, int nr)
{
    unsigned int unr = nr;

    if (likely(unr < NR_syscalls)) {
        unr = array_index_nospec(unr, NR_syscalls);
        regs->ax = sys_call_table[unr](regs);
        return true;
    }
    return false;
}
```

`array_index_nospec()` is a Spectre v1 mitigation: it masks the index to prevent speculative out-of-bounds access to `sys_call_table`.

### The syscall table

`sys_call_table[]` is an array of function pointers, indexed by syscall number:

```c
/* arch/x86/entry/syscall_64.c */
asmlinkage const sys_call_ptr_t sys_call_table[] = {
    [0 ... __NR_syscall_max] = &__x64_sys_ni_syscall, /* default: ENOSYS */
#include <asm/syscalls_64.h>   /* generated from syscall_64.tbl */
};
```

The table is generated from `arch/x86/entry/syscalls/syscall_64.tbl`:

```
# arch/x86/entry/syscalls/syscall_64.tbl (excerpt)
0    common  read            sys_read
1    common  write           sys_write
2    common  open            sys_open
...
60   common  exit            sys_exit
...
```

Each syscall handler is defined with the `SYSCALL_DEFINE` macro:

```c
/* fs/read_write.c */
SYSCALL_DEFINE3(read, unsigned int, fd, char __user *, buf, size_t, count)
{
    return ksys_read(fd, buf, count);
}
```

The macro expands to `__x64_sys_read(struct pt_regs *regs)`, which extracts arguments from `regs->di`, `regs->si`, `regs->dx`.

---

## The return path: SYSRET and IRET

After `do_syscall_64()` returns, the entry code restores registers and returns to userspace.

**Normal return via SYSRET:**

```asm
/* SYSRET restores: */
RIP    ← RCX   (saved user RIP)
RFLAGS ← R11   (saved user RFLAGS)
CS     ← from STAR MSR (user CS selector)
SS     ← from STAR MSR (user SS selector)
/* RSP is explicitly restored from pt_regs->sp before SYSRET */
```

**IRET fallback:** SYSRET cannot be used if the return address is non-canonical, if the task was interrupted mid-syscall by a signal, or in various edge cases. In those cases, the kernel uses `IRET` (interrupt return), which pops a full exception frame from the stack. `IRET` is slower but handles all cases correctly.

The kernel checks which path is safe before deciding:

```c
/* arch/x86/entry/entry_64.S */
/* If pt_regs->cs is not __USER_CS or RIP is non-canonical: use IRET */
/* Otherwise: use SYSRET */
```

---

## vDSO: fast syscalls without entering the kernel

The **vDSO** (virtual Dynamic Shared Object) is a small shared library that the kernel maps into every process's address space. It provides fast implementations of certain syscalls that do not actually require entering the kernel ring 0.

### How vDSO works

The kernel maps two special pages into the high end of every process's virtual address space:

1. **vDSO page**: executable code implementing fast syscall wrappers (`clock_gettime`, `gettimeofday`, `getcpu`, `clock_getres`)
2. **vvar page**: a read-only shared memory page containing kernel data that the vDSO code reads (current time, clock resolution, etc.)

```
Process virtual address space (top):
  vvar page (r--): kernel writes time data here
  vDSO page (r-x): user code calls into this; reads from vvar
```

The vvar page is updated by the kernel's timekeeping subsystem. The vDSO code reads from it directly — no syscall, no privilege transition. For `clock_gettime(CLOCK_REALTIME)`, this eliminates the SYSCALL/SYSRET overhead entirely.

```bash
# See vDSO mapped in a process
cat /proc/$$/maps | grep vdso
# 7ffd2a3d1000-7ffd2a3d3000 r--p 00000000 00:00 0      [vvar]
# 7ffd2a3d3000-7ffd2a3d5000 r-xp 00000000 00:00 0      [vdso]

# Extract the vDSO for analysis
cat /proc/self/maps | grep vdso
# Use vdso_test from tools/testing/selftests/vDSO/ in the kernel tree
```

### vDSO source

The vDSO is compiled as a special shared library:
- `arch/x86/vdso/` — x86-64 vDSO source
- `arch/x86/vdso/vdso64.lds.S` — linker script
- `arch/x86/vdso/vclock_gettime.c` — `clock_gettime` implementation

The vvar page is described by `struct vdso_data` (defined in `include/vdso/datapage.h`, the generic architecture-independent header), which contains time fields that the kernel updates using seqlock semantics to ensure the vDSO reader sees a consistent snapshot. `arch/x86/include/asm/vvar.h` defines the `VVAR()` access macro used to reference the vvar page, not the struct itself.

---

## int 0x80: the legacy 32-bit interface

Before `SYSCALL` (and even before `SYSENTER`), system calls on x86 were made via `INT 0x80` — a software interrupt. This mechanism still works in 64-bit kernels for compatibility with 32-bit applications and code.

- `INT 0x80` delivers a software interrupt through IDT vector 0x80
- The IDT entry for vector 0x80 points to `entry_INT80_compat` (in `arch/x86/entry/entry_64_compat.S`)
- This handler uses the **32-bit syscall table** (`ia32_sys_call_table[]`)
- `INT 0x80` in a 64-bit process uses only 32-bit registers (EAX, EBX, etc.) and the 32-bit ABI

`INT 0x80` is significantly slower than `SYSCALL` because it goes through the full IDT exception delivery mechanism (saves more state, checks DPL, etc.).

---

## Signal delivery before returning to userspace

Before `entry_SYSCALL_64` returns to userspace, the return path calls `syscall_exit_to_user_mode()`, which checks for pending signals:

```c
/* kernel/entry/common.c */
static void exit_to_user_mode_prepare(struct pt_regs *regs)
{
    u32 cached_flags = READ_ONCE(current_thread_info()->flags);

    if (unlikely(cached_flags & EXIT_TO_USER_MODE_WORK))
        exit_to_user_mode_loop(regs, cached_flags);
}

static void exit_to_user_mode_loop(struct pt_regs *regs, u32 cached_flags)
{
    while (true) {
        /* ... */
        if (cached_flags & _TIF_SIGPENDING)
            handle_signal_work(regs, cached_flags);
        /* ... */
    }
}
```

### Signal frame setup

When `do_signal()` determines a signal must be delivered, it sets up a **signal frame** on the user stack before returning:

```
User stack after signal frame setup:
  ┌─────────────────────────────────┐  ← rsp (new, after frame)
  │  struct rt_sigframe             │
  │    • uc (ucontext): saved regs  │
  │    • info (siginfo_t)           │
  │    • pretcode: → sa_restorer or │
  │      vDSO signal trampoline     │
  └─────────────────────────────────┘  ← old rsp (before signal)
```

The `struct rt_sigframe` (defined in `arch/x86/include/asm/sigframe.h`) contains a `ucontext_t` with a copy of `pt_regs` — the saved user register state at the point the signal was delivered.

The kernel then sets `regs->ip` to the signal handler address and `regs->sp` to the new stack top. When `entry_SYSCALL_64` completes its return, the CPU jumps to the signal handler instead of the original user code.

After the signal handler returns, it executes `sigreturn()` (or calls through the vDSO trampoline to `rt_sigreturn`), which calls the `rt_sigreturn` syscall. The kernel's handler (`sys_rt_sigreturn`) reads the saved `ucontext_t` from the signal frame, restores `pt_regs`, and returns to the original user instruction.

---

## Tracing and observability

### strace: intercepting every syscall

`strace` uses `ptrace(PTRACE_SYSCALL)` to pause the tracee at every syscall entry and exit:

```bash
# Trace all syscalls of a command
strace ls

# Trace specific syscall
strace -e trace=read,write cat /etc/hostname

# Show timing
strace -T ls

# Attach to running process
strace -p <pid>
```

### perf trace: low-overhead syscall tracing

```bash
# System-wide syscall summary
perf trace --summary sleep 5

# Per-process trace
perf trace -p <pid>

# Count syscalls by name
perf stat -e 'syscalls:sys_enter_*' -p <pid> sleep 5
```

### Tracepoints

The kernel provides entry and exit tracepoints for every syscall:

```bash
# List syscall tracepoints
ls /sys/kernel/debug/tracing/events/syscalls/ | head -20

# Enable tracing for a specific syscall
echo 1 > /sys/kernel/debug/tracing/events/syscalls/sys_enter_read/enable
cat /sys/kernel/debug/tracing/trace
```

### Seccomp BPF

Seccomp BPF filters are applied during `syscall_enter_from_user_mode()`, before the syscall handler runs. Each filter rule is a BPF program that receives the syscall number and arguments and returns an action (allow, deny, kill, trap, etc.). See `kernel/seccomp.c`.

```bash
# Check if a process has seccomp active
cat /proc/<pid>/status | grep Seccomp
# Seccomp: 2  (2 = filter mode)
```

### Finding entry_SYSCALL_64 in the running kernel

```bash
# Address of the syscall entry point
grep entry_SYSCALL_64 /proc/kallsyms

# Verify it matches LSTAR MSR
modprobe msr
rdmsr 0xC0000082   # LSTAR — should match the above address
```
