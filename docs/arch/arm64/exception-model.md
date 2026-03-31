# ARM64 Exception Model

> Exception levels, interrupt handling, and the GIC

## Exception Levels

ARM64 defines four exception levels (EL0-EL3), roughly analogous to x86 protection rings but more hierarchical:

```
EL3: Secure Monitor (TrustZone firmware, e.g., ARM Trusted Firmware)
  │
EL2: Hypervisor (KVM runs here)
  │
EL1: OS Kernel (Linux kernel runs here)
  │
EL0: User space (applications)
```

Key properties:
- **EL0**: unprivileged, can only access user-accessible system registers
- **EL1**: kernel mode, full access to kernel address space and EL1 system registers
- **EL2**: hypervisor mode, can trap and emulate EL1 operations
- **EL3**: most privileged, manages secure/non-secure world transitions (TrustZone)

The Linux kernel runs at EL1 normally, but with VHE (Virtualization Host Extension, ARMv8.1+) KVM runs the host kernel at EL2 directly (EL2 registers are made to look like EL1 registers via VHE). Without VHE, a small EL2 stub handles world-switching while the host kernel stays at EL1. Guests always run at EL1/EL0.

## Exception types

ARM64 has four categories of exceptions:

| Category | Description | Examples |
|----------|-------------|---------|
| **Synchronous** | Caused by the current instruction | SVC, data abort, instruction abort, undefined |
| **IRQ** | External interrupt (normal priority) | Device interrupts |
| **FIQ** | Fast interrupt (high priority, typically routed to EL3) | Secure world interrupts |
| **SError** | Asynchronous system error | Bus errors, DRAM ECC |

## Exception vectors: VBAR_EL1

When an exception occurs, the CPU jumps to an entry in the **vector table**, pointed to by `VBAR_EL1` (Vector Base Address Register for EL1):

```
VBAR_EL1 base
  + 0x000: Synchronous, current EL with SP_EL0
  + 0x080: IRQ, current EL with SP_EL0
  + 0x100: FIQ, current EL with SP_EL0
  + 0x180: SError, current EL with SP_EL0
  + 0x200: Synchronous, current EL with SP_ELx
  + 0x280: IRQ, current EL with SP_ELx        ← kernel IRQ from EL1
  + 0x300: FIQ, current EL with SP_ELx
  + 0x380: SError, current EL with SP_ELx
  + 0x400: Synchronous, lower EL (AArch64)    ← syscall / fault from EL0
  + 0x480: IRQ, lower EL (AArch64)            ← IRQ while in userspace
  + 0x500: FIQ, lower EL (AArch64)
  + 0x580: SError, lower EL (AArch64)
  + 0x600: Synchronous, lower EL (AArch32)    ← 32-bit compat
  ...
```

### Linux vector table

```asm
/* arch/arm64/kernel/entry.S */
    .align  11
SYM_CODE_START(vectors)
    kernel_ventry   1, t, 64, sync    /* Synchronous EL1t (SP_EL0) */
    kernel_ventry   1, t, 64, irq     /* IRQ EL1t */
    kernel_ventry   1, t, 64, fiq     /* FIQ EL1t */
    kernel_ventry   1, t, 64, error   /* Error EL1t */

    kernel_ventry   1, h, 64, sync    /* Synchronous EL1h (SP_ELx) */
    kernel_ventry   1, h, 64, irq     /* IRQ EL1h */
    kernel_ventry   1, h, 64, fiq     /* FIQ EL1h */
    kernel_ventry   1, h, 64, error   /* Error EL1h */

    kernel_ventry   0, t, 64, sync    /* Synchronous EL0 64-bit */
    kernel_ventry   0, t, 64, irq     /* IRQ EL0 64-bit */
    kernel_ventry   0, t, 64, fiq     /* FIQ EL0 64-bit */
    kernel_ventry   0, t, 64, error   /* Error EL0 64-bit */

    kernel_ventry   0, t, 32, sync    /* Synchronous EL0 32-bit */
    kernel_ventry   0, t, 32, irq     /* IRQ EL0 32-bit */
    kernel_ventry   0, t, 32, fiq     /* FIQ EL0 32-bit */
    kernel_ventry   0, t, 32, error   /* Error EL0 32-bit */
SYM_CODE_END(vectors)
```

## Syndrome registers: ESR_EL1

When a synchronous exception occurs, `ESR_EL1` (Exception Syndrome Register) identifies the cause:

```c
/* arch/arm64/include/asm/esr.h */

/* ESR_EL1 bits: */
/* [31:26] EC: Exception Class */
#define ESR_ELx_EC_SHIFT    26
#define ESR_ELx_EC_MASK     (0x3FUL << ESR_ELx_EC_SHIFT)

/* Exception classes: */
#define ESR_ELx_EC_UNKNOWN  0x00  /* Unknown reason */
#define ESR_ELx_EC_SVC64   0x15  /* SVC instruction (EL0 → EL1, 64-bit) */
#define ESR_ELx_EC_IABT_LOW 0x20  /* Instruction abort from lower EL */
#define ESR_ELx_EC_IABT_CUR 0x21  /* Instruction abort from current EL */
#define ESR_ELx_EC_DABT_LOW 0x24  /* Data abort from lower EL */
#define ESR_ELx_EC_DABT_CUR 0x25  /* Data abort from current EL */
#define ESR_ELx_EC_SOFTSTP_LOW 0x32 /* Software step (debug) from lower EL */

/* [24] IL: Instruction Length (0=16-bit, 1=32-bit) */
/* [23:0] ISS: Instruction-Specific Syndrome */
/* For data aborts, ISS includes: DFSC (fault status code), WnR (write), SRT (register) */
```

### Fault status codes (DFSC)

```c
/* Data fault status codes in ESR_EL1.ISS.DFSC */
#define ESR_ELx_FSC_TYPE    0x3C
#define ESR_ELx_FSC_EXTABT  0x10  /* External abort */
#define ESR_ELx_FSC_SERROR  0x11  /* Async SError abort */
#define ESR_ELx_FSC_ACCESS  0x08  /* Access flag fault */
#define ESR_ELx_FSC_FAULT   0x04  /* Translation fault (page not present) */
#define ESR_ELx_FSC_PERM    0x0C  /* Permission fault */

/* Level bits [1:0]: */
/* 0b00 = level 0 (PGD), 0b01 = level 1, 0b10 = level 2, 0b11 = level 3 (PTE) */
```

### Linux fault handling

```c
/* arch/arm64/mm/fault.c */
static int __kprobes do_mem_abort(unsigned long far, unsigned long esr,
                                   struct pt_regs *regs)
{
    const struct fault_info *inf = esr_to_fault_info(esr);

    if (!inf->fn(far, esr, regs))
        return 0;

    /* Unhandled fault */
    arm64_notify_die(inf->name, regs, esr, far);
    return 0;
}

/* ESR EC → handler dispatch */
static const struct fault_info fault_info[] = {
    { do_bad,           SIGKILL, 0,                   "ttbr address size fault" },
    /* ... */
    { do_translation_fault, SIGSEGV, SEGV_MAPERR,     "level 3 translation fault" },
    { do_page_fault,    SIGSEGV, SEGV_MAPERR,          "level 3 translation fault" },
    { do_page_fault,    SIGSEGV, SEGV_ACCERR,          "level 3 permission fault"  },
};
```

## Syscall entry (SVC)

On ARM64, system calls use the `SVC #0` instruction (Supervisor Call):

```asm
/* Userspace syscall: */
mov x8, #__NR_write    /* syscall number in x8 */
mov x0, #1             /* fd = 1 (stdout) */
mov x1, x_buf          /* buffer address */
mov x2, x_len          /* length */
svc #0                 /* trap to EL1 */
/* returns in x0 */
```

The kernel SVC handler:

```asm
/* arch/arm64/kernel/entry.S */
SYM_CODE_START(el0t_64_sync_handler)
    /* Save all registers */
    kernel_entry 0, 64

    mrs     x22, esr_el1        /* read exception syndrome */
    lsr     x24, x22, #ESR_ELx_EC_SHIFT  /* extract EC */

    /* EC = 0x15 means SVC from 64-bit EL0 */
    cmp     x24, #ESR_ELx_EC_SVC64
    b.eq    el0_svc

    /* Other exception types */
    b       el0_sync_handler
SYM_CODE_END(el0t_64_sync_handler)
```

```c
/* arch/arm64/kernel/syscall.c */
static void el0_svc_common(struct pt_regs *regs, int scno,
                             int sc_nr, const syscall_fn_t syscall_table[])
{
    /* Apply syscall tracing (seccomp, ptrace) */
    invoke_syscall(regs, scno, sc_nr, syscall_table);
}
```

The syscall number is in `x8`, arguments in `x0-x5`, and the return value goes into `x0`.

## GIC: Generic Interrupt Controller

ARM systems use the GIC (Generic Interrupt Controller) for interrupt management, not the x86 APIC.

```
Peripheral ──► GIC Distributor (shared)
                    │
                    ├──► CPU Interface 0 (CPU 0)
                    ├──► CPU Interface 1 (CPU 1)
                    └──► CPU Interface N (CPU N)
                              │
                          IRQ line to CPU core
```

### GIC interrupt types

```c
/* GIC interrupt IDs */
/* 0-15:   SGI (Software Generated Interrupts) — IPIs */
/* 16-31:  PPI (Private Peripheral Interrupts) — per-CPU (timers, PMU) */
/* 32+:    SPI (Shared Peripheral Interrupts) — shared across CPUs */
/* 8192+:  LPI (Locality-specific Peripheral Interrupts) — MSI for PCIe */
```

### Linux GIC driver

```c
/* drivers/irqchip/irq-gic-v3.c */
static struct irq_chip gic_chip = {
    .name                   = "GICv3",
    .irq_mask               = gic_mask_irq,
    .irq_unmask             = gic_unmask_irq,
    .irq_eoi                = gic_eoi_irq,
    .irq_set_type           = gic_set_type,
    .irq_set_affinity       = gic_set_affinity,   /* CPU affinity */
    .irq_retrigger          = gic_retrigger,
    .irq_get_irqchip_state  = gic_irq_get_irqchip_state,
    .irq_set_irqchip_state  = gic_irq_set_irqchip_state,
};

/* EOI (End of Interrupt): acknowledge to GIC when done */
static void gic_eoi_irq(struct irq_data *d)
{
    gic_write_eoir(gic_irq(d));  /* EOIR1_EL1: write IRQ number to EOI */
}
```

### IPIs on ARM64

ARM64 IPIs (for TLB shootdown, function calls, rescheduling) use GIC SGIs:

```c
/* arch/arm64/kernel/smp.c */
static void smp_send_reschedule(int cpu)
{
    smp_cross_call(cpumask_of(cpu), IPI_RESCHEDULE);
}

void arch_send_call_function_ipi_mask(const struct cpumask *mask)
{
    smp_cross_call(mask, IPI_CALL_FUNC);
}

/* smp_cross_call → GIC SGI → IPI_RESCHEDULE/IPI_CALL_FUNC handler */
```

## System registers

ARM64 system registers are accessed with `MRS`/`MSR` instructions:

```asm
/* Read current EL */
mrs x0, CurrentEL          /* bits [3:2] = EL */
lsr x0, x0, #2             /* shift to get 0/1/2/3 */

/* Read virtual counter (vDSO uses this instead of syscall) */
mrs x0, CNTVCT_EL0

/* Read Thread ID register (TLS base) */
mrs x0, TPIDR_EL0

/* Enable/disable interrupts */
msr daifclr, #2            /* clear IRQ mask bit = enable IRQs */
msr daifset, #2            /* set IRQ mask bit = disable IRQs */
```

In the kernel (using C):

```c
/* arch/arm64/include/asm/sysreg.h */
u64 cntvct = read_sysreg(cntvct_el0);   /* virtual counter */
write_sysreg(ttbr0_val, ttbr0_el1);     /* page table base */
```

## Further reading

- [Memory Model](memory-model.md) — ARM64 weak ordering and barriers
- [Memory Management: page tables](../../mm/page-tables.md) — ARM64 page table format
- [Interrupts: Interrupt Handling Overview](../../interrupts/interrupts.md) — generic interrupt framework
- [Virtualization: KVM Architecture](../../virtualization/kvm-arch.md) — KVM on ARM64 (EL2)
- `arch/arm64/kernel/` in the kernel tree — ARM64 exception handlers
- ARM Architecture Reference Manual (ARM DDI 0487)
