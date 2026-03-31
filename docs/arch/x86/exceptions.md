# x86 Exception and Interrupt Handling

> IDT, exception entry, hardware exceptions, and the page fault handler path

## x86 exception fundamentals

On x86, all exceptions and interrupts are delivered via the **Interrupt Descriptor Table (IDT)**. The IDT has 256 entries:

```
IDT entry layout (gate descriptor, 16 bytes on x86-64):
 ┌──────────────────────────────────────────────────┐
 │ Offset[63:32]                                    │
 ├──────────────────────────────────────────────────┤
 │ Reserved                  │ Offset[31:16]        │
 ├───────────┬───────────────┼──────────────────────┤
 │  P DPL S  │   Type        │ Segment Selector     │
 ├───────────┴───────────────┴──────────────────────┤
 │ Offset[15:0]                                     │
 └──────────────────────────────────────────────────┘

P   = present
DPL = descriptor privilege level (0=kernel, 3=user)
Type= 0xE = interrupt gate (clears IF), 0xF = trap gate (keeps IF)
```

Entries 0-31 are reserved for CPU exceptions. Entries 32-255 are for external interrupts and software traps (syscalls use int 0x80 historically, or SYSCALL instruction on x86-64).

## CPU exception vectors

| Vector | Mnemonic | Name | Error code | Fault/Trap/Abort |
|--------|----------|------|------------|-----------------|
| 0 | #DE | Divide Error | No | Fault |
| 1 | #DB | Debug | No | Fault/Trap |
| 2 | NMI | Non-Maskable Interrupt | No | Interrupt |
| 3 | #BP | Breakpoint | No | Trap |
| 4 | #OF | Overflow | No | Trap |
| 5 | #BR | BOUND Range Exceeded | No | Fault |
| 6 | #UD | Invalid Opcode | No | Fault |
| 7 | #NM | Device Not Available | No | Fault |
| 8 | #DF | Double Fault | Zero | Abort |
| 10 | #TS | Invalid TSS | Yes | Fault |
| 11 | #NP | Segment Not Present | Yes | Fault |
| 12 | #SS | Stack-Segment Fault | Yes | Fault |
| 13 | #GP | General Protection | Yes | Fault |
| 14 | #PF | Page Fault | Yes | Fault |
| 16 | #MF | x87 FPU Error | No | Fault |
| 17 | #AC | Alignment Check | Zero | Fault |
| 18 | #MC | Machine Check | No | Abort |
| 19 | #XM | SIMD FP Exception | No | Fault |
| 20 | #VE | Virtualization Exception | No | Fault |

**Fault**: saved CS:RIP points to the faulting instruction (re-executed after handler).
**Trap**: saved CS:RIP points to the instruction after the trap.
**Abort**: unrecoverable; saved state may be corrupted.

## IDT initialization

```c
/* arch/x86/kernel/idt.c */

/* IDT gate descriptor in kernel code */
struct idt_data {
    unsigned int    vector;
    unsigned int    segment;
    struct idt_bits bits;
    const void      *addr;
};

/* Early IDT setup (before C code) */
static const __initconst struct idt_data def_idts[] = {
    INTG(X86_TRAP_DE,       asm_exc_divide_error),
    INTG(X86_TRAP_NMI,      asm_exc_nmi),
    INTG(X86_TRAP_BP,       asm_exc_int3),     /* DPL=3: user can trigger */
    INTG(X86_TRAP_OF,       asm_exc_overflow),
    INTG(X86_TRAP_UD,       asm_exc_invalid_op),
    INTG(X86_TRAP_NM,       asm_exc_device_not_available),
    INTG(X86_TRAP_GP,       asm_exc_general_protection),
    INTG(X86_TRAP_PF,       asm_exc_page_fault),
    /* ... */
};

void __init idt_setup_early_traps(void)
{
    idt_setup_from_table(idt_table, early_idts, ARRAY_SIZE(early_idts), true);
    load_idt(&idt_descr);  /* LIDT instruction */
}
```

The `LIDT` instruction loads the IDT register (IDTR) with the base address and limit of the IDT table.

## Exception entry: hardware behavior

When the CPU delivers an exception to ring 0 (from ring 3 userspace):

```
Hardware actions (automatic, before any software):
  1. Look up IDT[vector] → get handler address and DPL
  2. Check DPL ≥ CPL (prevents user invoking kernel-only gates)
  3. Switch to kernel stack (via TSS.RSP0 for ring 0 target)
  4. Push on new stack:
       [SS]        ← old user SS
       [RSP]       ← old user RSP
       [RFLAGS]    ← old RFLAGS
       [CS]        ← old user CS
       [RIP]       ← address of faulting instruction (fault) or next (trap)
       [Error Code] ← for exceptions with error codes (GP, PF, etc.)
  5. Clear IF (interrupt gate): disables maskable interrupts
  6. Jump to handler address from IDT entry
```

For ring-0 → ring-0 exceptions (kernel taking a fault):
- No stack switch (stays on current kernel stack)
- Still pushes RIP/CS/RFLAGS/error code

## Exception entry assembly (x86-64)

Linux uses `DEFINE_IDTENTRY_*` macros to generate exception entry stubs:

```c
/* arch/x86/include/asm/idtentry.h */

/* Generates the asm entry stub + C handler declaration */
#define DEFINE_IDTENTRY_ERRORCODE(func)                         \
    __visible noinstr void func(struct pt_regs *regs, long error_code)

/* arch/x86/kernel/traps.c */
DEFINE_IDTENTRY_ERRORCODE(exc_general_protection)
{
    struct task_struct *tsk = current;
    unsigned long condition = error_code;
    char *desc;

    cond_local_irq_enable(regs);

    if (static_cpu_has(X86_FEATURE_UMIP)) {
        if (user_mode(regs) && fixup_umip_exception(regs))
            return;
    }

    if (v8086_mode(regs)) {
        handle_vm86_fault((struct kernel_vm86_regs *) regs, error_code);
        return;
    }

    tsk->thread.error_code = error_code;
    tsk->thread.trap_nr = X86_TRAP_GP;

    if (show_unhandled_signals && unhandled_signal(tsk, SIGSEGV) &&
        printk_ratelimit()) {
        pr_info("%s[%d] general protection ip:%lx sp:%lx error:%lx",
                tsk->comm, task_pid_nr(tsk),
                regs->ip, regs->sp, error_code);
    }

    force_sig_fault(SIGSEGV, SEGV_MAPERR, (void __user *)0);
}
```

## struct pt_regs

All exception handlers receive a `struct pt_regs` that captures the full register state:

```c
/* arch/x86/include/asm/ptrace.h */
struct pt_regs {
    /* Callee-saved registers (pushed by entry asm) */
    unsigned long r15, r14, r13, r12;
    unsigned long rbp;
    unsigned long rbx;

    /* Argument registers */
    unsigned long r11, r10, r9, r8;
    unsigned long rax, rcx, rdx, rsi, rdi;

    /* CPU-pushed on exception entry */
    unsigned long orig_rax;  /* syscall number or error code */
    unsigned long rip;
    unsigned long cs;
    unsigned long eflags;
    unsigned long rsp;
    unsigned long ss;
};
```

The entry assembly (`arch/x86/entry/entry_64.S`) saves all registers to build this structure before calling the C handler.

## Task State Segment (TSS)

The TSS is critical for stack switching on exception delivery:

```c
/* arch/x86/include/asm/processor.h */
struct x86_hw_tss {
    u32         reserved1;
    u64         sp0;    /* RSP0: kernel stack pointer (used for ring-0 target) */
    u64         sp1;
    u64         sp2;
    u64         reserved2;
    u64         ist[7]; /* IST1-IST7: Interrupt Stack Table entries */
    u32         reserved3;
    u32         reserved4;
    u16         reserved5;
    u16         io_bitmap_base;
} __attribute__((packed));
```

**IST (Interrupt Stack Table)**: Some critical exceptions use dedicated stacks from IST to handle faults even when the regular kernel stack is corrupted:

| Exception | IST | Reason |
|-----------|-----|--------|
| NMI | IST1 | Can interrupt any code including exception handlers |
| #DF (double fault) | IST2 | Stack pointer might be corrupted |
| #MC (machine check) | IST3 | Hardware may be completely broken |
| #DB (debug) | IST4 | Can fire in weird contexts |

## Page fault handler (#PF)

The page fault is the most important exception in a running system:

### Error code bits

```
#PF error code:
  bit 0: P   — 0=non-present, 1=protection violation
  bit 1: W/R — 0=read, 1=write
  bit 2: U/S — 0=supervisor (kernel), 1=user
  bit 3: RSVD — reserved bit violation
  bit 4: I/D — 0=data, 1=instruction fetch
  bit 5: PK  — protection key violation
  bit 6: SGX — SGX-related fault
```

### Handler entry

```c
/* arch/x86/mm/fault.c */

/*
 * CR2 contains the faulting linear address.
 * Called from asm_exc_page_fault after saving pt_regs.
 */
DEFINE_IDTENTRY_RAW_ERRORCODE(exc_page_fault)
{
    unsigned long address = read_cr2();  /* faulting virtual address */
    irqentry_state_t state;

    prefetchw(&current->mm->mmap_lock);

    /*
     * KVM: notify before running page fault handler.
     * Allows hypervisor to handle EPT-related faults first.
     */
    if (kvm_handle_async_pf(regs, (u32)error_code))
        return;

    state = irqentry_enter(regs);
    instrumentation_begin();
    handle_page_fault_out_of_line(regs, error_code, address);
    instrumentation_end();
    irqentry_exit(regs, state);
}
```

### Fault classification

```c
static noinline void
handle_page_fault_out_of_line(struct pt_regs *regs, unsigned long error_code,
                               unsigned long address)
{
    /* Fault from kernel mode? */
    if (unlikely(fault_in_kernel_space(address))) {
        do_kern_addr_fault(regs, error_code, address);
        return;
    }

    /* Fault from user mode or kernel accessing user memory */
    do_user_addr_fault(regs, error_code, address);
}
```

### User address fault path

```c
static inline void
do_user_addr_fault(struct pt_regs *regs, unsigned long error_code,
                   unsigned long address)
{
    struct vm_area_struct *vma;
    struct task_struct *tsk = current;
    struct mm_struct *mm = tsk->mm;
    vm_fault_t fault;
    unsigned int flags = FAULT_FLAG_DEFAULT;

    /* Spurious fault? Check if address is in a valid VMA */
    if (unlikely(!mm)) {
        bad_area_nosemaphore(regs, error_code, address);
        return;
    }

    /* Indicate this is a write or instruction fetch */
    if (error_code & X86_PF_WRITE)
        flags |= FAULT_FLAG_WRITE;
    if (error_code & X86_PF_INSTR)
        flags |= FAULT_FLAG_INSTRUCTION;
    if (error_code & X86_PF_USER)
        flags |= FAULT_FLAG_USER;

    /* Acquire mmap_lock (shared for reads, exclusive if needed) */
    if (unlikely(!mmap_read_trylock(mm))) {
        /* If in interrupt context or killed, can't wait */
        if (unlikely(faulthandler_disabled() || !user_mode(regs))) {
            bad_area_nosemaphore(regs, error_code, address);
            return;
        }
        mmap_read_lock(mm);
    }

    /* Find the VMA containing the faulting address */
    vma = find_vma(mm, address);
    if (unlikely(!vma)) {
        bad_area(regs, error_code, address, NULL);
        goto done;
    }
    if (likely(vma->vm_start <= address))
        goto good_area;

    /* Address is in a hole between VMAs — check if it's a stack growth */
    if (unlikely(!(vma->vm_flags & VM_GROWSDOWN))) {
        bad_area(regs, error_code, address, vma);
        goto done;
    }
    if (unlikely(expand_stack(vma, address))) {
        bad_area(regs, error_code, address, vma);
        goto done;
    }

good_area:
    fault = handle_mm_fault(mm, vma, address, flags);
    /* ... */

done:
    mmap_read_unlock(mm);
}
```

### Kernel address fault path

```c
static noinline void
do_kern_addr_fault(struct pt_regs *regs, unsigned long hw_error_code,
                   unsigned long address)
{
    /* Check the fixup table: expected faults in kernel code */
    if (fixup_exception(regs, X86_TRAP_PF, hw_error_code, address))
        return;

    /* KASAN/KFENCE shadow memory? */
    if (kfence_handle_page_fault(address, hw_error_code & X86_PF_WRITE, regs))
        return;

    /* vmalloc fault? (lazy mapping, VMALLOC_START to VMALLOC_END) */
    if (!(hw_error_code & (X86_PF_RSVD | X86_PF_USER | X86_PF_PK))) {
        if (vmalloc_fault(address) >= 0)
            return;
    }

    /* Oops: unexpected kernel fault */
    bad_area_nosemaphore(regs, hw_error_code, address);
}
```

## Exception fixup table

The kernel's exception fixup table maps faulting instruction addresses to recovery code. Used for `copy_from_user`/`copy_to_user`:

```c
/* arch/x86/lib/usercopy_64.S */
/* If this copy instruction faults: */
1:  rep movsb
    /* ... */
2:  ret
    /* Fixup entry: if [1] faults, jump to [3] */
    _ASM_EXTABLE_UA(1b, 3f)
3:  mov %ecx, %eax   /* Return number of bytes not copied */
    ret

/* In C: */
unsigned long copy_from_user(void *to, const void __user *from, unsigned long n)
{
    /*
     * If the copy faults (bad user pointer), the CPU exception
     * handler checks the fixup table and jumps to the error path
     * instead of oopsing.
     */
    return raw_copy_from_user(to, from, n);
}
```

## NMI handling

Non-Maskable Interrupts cannot be masked with `cli`. They require careful handling because they can interrupt *any* code including interrupt handlers:

```c
/* arch/x86/kernel/nmi.c */
DEFINE_IDTENTRY_RAW(exc_nmi)
{
    irqentry_state_t irq_state;

    /*
     * NMI uses its own IST stack. Since NMI can nest (NMI within NMI
     * handling), the kernel uses a careful "NMI nesting" protocol:
     */

    /* Check if we interrupted an NMI handler itself */
    if (this_cpu_read(nmi_state) != NMI_NOT_RUNNING) {
        this_cpu_write(nmi_cr2, read_cr2());
        this_cpu_write(nmi_state, NMI_LATCHED);
        return;
    }

    this_cpu_write(nmi_state, NMI_EXECUTING);
    this_cpu_write(nmi_cr2, read_cr2());

    nmi_restart:
    irq_state = irqentry_nmi_enter(regs);
    do_nmi(regs, 0);
    irqentry_nmi_exit(regs, irq_state);

    /* Check if NMI was latched while handling */
    if (this_cpu_dec_return(nmi_state) == NMI_LATCHED)
        goto nmi_restart;
}
```

NMIs are used for:
- Hardware errors (MCE, watchdog)
- Perf PMU overflow interrupts (PEBS/LBR)
- kdump NMI shootdown (crash on one CPU, NMI all others)
- Kernel watchdog (`CONFIG_HARDLOCKUP_DETECTOR`)

## SYSCALL/SYSRET (fast system call)

Modern x86-64 uses the `SYSCALL` instruction instead of `int 0x80`:

```
SYSCALL (user → kernel):
  1. Load RIP from MSR_LSTAR (syscall entry point)
  2. Save user RIP in RCX, RFLAGS in R11
  3. Load CS/SS from MSR_STAR segments
  4. Clear RFLAGS bits in MSR_SFMASK
  * Does NOT switch stack — kernel must do this in entry asm

SYSRET (kernel → user):
  1. Restore RIP from RCX, RFLAGS from R11
  2. Restore CS/SS
  * Does NOT save/restore any other registers
```

```c
/* arch/x86/entry/entry_64.S */
SYM_CODE_START(entry_SYSCALL_64)
    /* Switch from user stack to kernel stack: */
    swapgs                          /* swap GS with MSR_KERNEL_GS_BASE */
    movq    %rsp, PER_CPU_VAR(cpu_tss_rw + TSS_sp2)
    SWITCH_TO_KERNEL_CR3 scratch_reg=%rsp
    movq    PER_CPU_VAR(cpu_current_top_of_stack), %rsp

    /* Save user state: */
    pushq   $__USER_DS              /* ss */
    pushq   PER_CPU_VAR(cpu_tss_rw + TSS_sp2)  /* rsp */
    pushq   %r11                   /* rflags */
    pushq   $__USER_CS             /* cs */
    pushq   %rcx                   /* rip (saved by SYSCALL) */

    /* ... save remaining regs, call do_syscall_64() ... */
```

## Observability

```bash
# Count exceptions per type (perf)
perf stat -e exceptions:page_fault_user,exceptions:page_fault_kernel \
          -p <pid> sleep 5

# Watch page fault rate (vmstat)
vmstat 1
# pgfault: minor faults (page in from cache or anon)
# pgmajfault: major faults (disk read)

# Trace all page faults (heavy!)
bpftrace -e '
tracepoint:exceptions:page_fault_user {
    @[ustack] = count();
}'

# Decode IDT
crash> idt

# Show exception handler address for vector 14 (#PF)
python3 -c "
import struct, sys
# /sys/kernel/debug/x86/idt_table is a binary dump of the IDT
with open('/sys/kernel/debug/x86/idt_table','rb') as f:
    data = f.read()
v = 14  # page fault
entry = data[v*16:(v+1)*16]
lo16, seg, bits16, hi16, hi32, _ = struct.unpack('<HHHHII', entry)
addr = lo16 | (hi16 << 16) | (hi32 << 32)
print(f'#PF handler: {addr:#x}')
"

# /proc/interrupts shows interrupt counts per CPU
cat /proc/interrupts | head -5
```

## Further reading

- [ARM64 Exception Model](../arm64/exception-model.md) — equivalent AArch64 mechanisms
- [Page Fault Handler](../../mm/page-fault.md) — handle_mm_fault and VMA resolution
- [IRQ Handling](../../interrupts/interrupts.md) — external interrupt delivery
- [Syscall Entry](../../syscalls/syscall-entry.md) — SYSCALL/SYSRET path in detail
- [Kernel Hardening](../../security/kernel-hardening.md) — SMEP/SMAP, KPTI
- `arch/x86/kernel/traps.c` — exception handler implementations
- `arch/x86/mm/fault.c` — page fault handler
- `arch/x86/entry/entry_64.S` — exception/syscall entry assembly
- Intel SDM Vol 3A, Chapter 6 — Interrupt and Exception Handling
