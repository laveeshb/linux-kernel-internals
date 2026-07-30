# ARM64 Boot Sequence

> From reset vector to start_kernel: head.S, page table setup, and MMU enable

## Overview

When power is applied to an ARM64 system, the CPU starts executing at the reset vector with the MMU disabled, in the highest exception level supported by the hardware.

```
Power on / Reset
     │
     ▼
EL3 (Secure Monitor, if present) → firmware (ATF / TF-A)
     │  Sets up security configuration, drops to EL2
     ▼
EL2 (Hypervisor, if present) → firmware (QEMU, KVM host)
     │  Sets up virtualization, drops to EL1
     ▼
EL1 (Kernel) → arch/arm64/kernel/head.S
     │
     └─► primary_entry
          │
          ├─ el2_setup: configure EL2 system registers
          ├─ set_cpu_boot_mode_flag
          ├─ __create_page_tables: build early page tables
          ├─ __cpu_setup: enable caches, initialize SCTLR_EL1
          ├─ __primary_switch:
          │    ├─ adrp x0, init_pg_dir  (set TTBR1_EL1)
          │    ├─ enable_mmu (set SCTLR_EL1.M=1)
          │    └─ b __primary_switched
          └─ __primary_switched:
               ├─ set up kernel stack
               ├─ zero BSS
               └─ b start_kernel  (C code)
```

## head.S: the entry point

```asm
/* arch/arm64/kernel/head.S */

    /*
     * Linux/arm64 Image header: first 64 bytes used by bootloader.
     * Bootloader jumps here with:
     *   x0 = physical address of device tree blob (DTB)
     *   x1 = 0 (reserved)
     *   x2 = 0 (reserved)
     *   x3 = 0 (reserved)
     */
    .section ".head.text","ax"

SYM_CODE_START(primary_entry)
    /* Disable all interrupts */
    msr     daifset, #0xf

    /* Preserve x0 (DTB address) for later */
    mov     x21, x0

    /* Are we running in EL2? Set up hypervisor configuration */
    bl      record_mmu_state
    bl      preserve_boot_args

    /*
     * Set up EL1 or EL2 system registers.
     * CPU starts with MMU off; endianness and cache state set via
     * __cpu_setup before MMU enable.
     */
    bl      __create_page_tables
    /* x23 = TTBR1 (kernel VA page tables physical address) */
    /* x25 = VA_BITS */

    bl      __cpu_setup
    adr_l   x8, __primary_switch
    br      x8
SYM_CODE_END(primary_entry)
```

## Exception level setup

```c
/* arch/arm64/kernel/head.S */

/*
 * Set up EL2 registers if booting at EL2 (common with KVM/Xen):
 * - Configure HCR_EL2: virtualization configuration
 * - Set up EL1 trap configuration
 * - Drop to EL1 via eret
 */
SYM_FUNC_START_LOCAL(el2_setup)
    msr     SPsel, #1           /* use SP_EL1 for EL1 */

    /* Check current exception level: */
    mrs     x0, CurrentEL
    cmp     x0, #CurrentEL_EL2
    b.eq    1f

    /* Running at EL1: nothing to do */
    mov     w0, #BOOT_CPU_MODE_EL1
    ret

1:  /* Running at EL2: configure for kernel at EL1 */
    mov_q   x0, HCR_HOST_NVHE_FLAGS  /* no-VHE host configuration */
    msr     HCR_EL2, x0

    /* Allow kernel to access physical timers and PMU: */
    mov     x0, #(CNTHCTL_EL2_EL1PCTEN | CNTHCTL_EL2_EL1PTEN)
    msr     CNTHCTL_EL2, x0

    /* Drop to EL1 via ERET: */
    mov     x0, #(PSR_F_BIT | PSR_I_BIT | PSR_A_BIT | PSR_D_BIT | \
                  PSR_MODE_EL1h)
    msr     SPSR_EL2, x0
    msr     ELR_EL2, lr
    mov     w0, #BOOT_CPU_MODE_EL2
    eret
SYM_FUNC_END(el2_setup)
```

## Early page tables

Before the MMU is enabled, the kernel creates minimal page tables mapping:
1. The kernel itself (identity map for the boot path)
2. The kernel virtual address space (high addresses, TTBR1)

```c
/* arch/arm64/kernel/head.S */
SYM_FUNC_START_LOCAL(__create_page_tables)
    /*
     * ARM64 uses two sets of page tables:
     *   TTBR0_EL1: user space (VA [0, VA_BITS-1])
     *   TTBR1_EL1: kernel space (VA [-(1<<VA_BITS), -1])
     *
     * On boot: create identity map for [_text, _end) in TTBR0
     *          and kernel map in TTBR1
     */

    /* Clear init_pg_dir (kernel page tables) */
    adrp    x0, init_pg_dir
    adrp    x1, init_pg_end
    sub     x1, x1, x0
    bl      __pi_memset             /* zero init_pg_dir (__memzero is ARM32 only) */

    /* Create the initial kernel page tables: */
    /* Map kernel text/data at KIMAGE_VADDR */
    adrp    x0, init_pg_dir
    adrp    x6, _text
    bl      map_kernel_segment      /* maps _text.._end at kernel VA */
    ret
SYM_FUNC_END(__create_page_tables)
```

## CPU setup: enabling the MMU

```asm
/* arch/arm64/kernel/head.S */
SYM_FUNC_START(__primary_switch)
    /*
     * Set TTBR0 (identity map, used during MMU enable)
     * and TTBR1 (kernel VA map)
     */
    adrp    x1, idmap_pg_dir    /* TTBR0: identity map for boot path */
    adrp    x2, init_pg_dir     /* TTBR1: kernel VA map */
    bl      __enable_mmu

    /* After MMU enable: we're now running at kernel VAs */
    ldr     x8, =__primary_switched
    adrp    x0, KERNEL_START        /* physical address of _text */
    br      x8
SYM_FUNC_END(__primary_switch)

SYM_FUNC_START_LOCAL(__enable_mmu)
    /*
     * Set up MAIR_EL1: memory attribute indirection register
     * Defines 8 memory types (Normal WB, Device, etc.)
     */
    mov_q   x5, MAIR_EL1_SET
    msr     mair_el1, x5

    /*
     * Set up TCR_EL1: Translation Control Register
     * - IPS: physical address size
     * - T0SZ: VA range for TTBR0 (user, 48-bit)
     * - T1SZ: VA range for TTBR1 (kernel, 48-bit)
     * - TG0/TG1: 4KB granule
     * - SH0/SH1: inner shareable
     * - ORGN/IRGN: outer/inner write-back cacheable
     */
    mrs     x10, ID_AA64MMFR0_EL1
    ...
    msr     tcr_el1, x10

    /* Set TTBR0 and TTBR1: */
    msr     ttbr0_el1, x1
    msr     ttbr1_el1, x2
    isb

    /* Enable MMU: set SCTLR_EL1.M = 1 */
    mrs     x0, sctlr_el1
    orr     x0, x0, #SCTLR_EL1_M     /* MMU enable */
    orr     x0, x0, #SCTLR_EL1_C     /* cache enable */
    orr     x0, x0, #SCTLR_EL1_I     /* instruction cache enable */
    msr     sctlr_el1, x0
    isb     /* ISB required after SCTLR_EL1 write */
    ret
SYM_FUNC_END(__enable_mmu)
```

## After MMU enable: __primary_switched

```asm
SYM_FUNC_START_LOCAL(__primary_switched)
    /* Set up the exception vector table (VBAR_EL1) */
    adr_l   x4, vectors             /* arch/arm64/kernel/entry.S */
    msr     vbar_el1, x4
    isb

    /* Set up the initial kernel stack */
    adr_l   x5, init_task           /* struct task_struct for init */
    msr     sp_el0, x5              /* used for current macro */
    adr_l   x6, init_thread_union
    add     sp, x6, #THREAD_SIZE    /* kernel stack top (init_thread_union + THREAD_SIZE) */

    /* Record which exception level we booted at */
    str_l   x5, __boot_cpu_mode, x6

    /* Zero BSS: */
    adrp    x0, __bss_start
    adrp    x1, __bss_stop
    sub     x1, x1, x0
    bl      __pi_memset

    /* Preserve DTB address for setup_arch: */
    str_l   x21, __fdt_pointer, x5

    /* Jump to C code! */
    b       start_kernel
SYM_FUNC_END(__primary_switched)
```

## SMP secondary CPU boot

Secondary CPUs start at `secondary_entry` after being released by the primary:

```c
/* arch/arm64/kernel/head.S */
SYM_CODE_START(secondary_entry)
    /* Same setup as primary: EL2, CPU features, page tables */
    bl      el2_setup           /* configure EL2 (shared with primary) */
    bl      __cpu_setup

    adr_l   x0, KERNEL_START
    bl      __secondary_switch
    /* → secondary_start_kernel() */
SYM_CODE_END(secondary_entry)

/* arch/arm64/kernel/smp.c */
void secondary_start_kernel(void)
{
    struct mm_struct *mm = &init_mm;
    unsigned int cpu = smp_processor_id();

    mmgrab(mm);
    current->active_mm = mm;

    /* Initialize per-CPU data structures */
    notify_cpu_starting(cpu);

    /* Set up interrupts and timers for this CPU */
    local_irq_enable();
    cpu_startup_entry(CPUHP_AP_ONLINE_IDLE);
    /* → idle loop */
}
```

## Observing the boot

```bash
# See kernel boot messages:
dmesg | head -50
# [    0.000000] Booting Linux on physical CPU 0x0000000000 [0x410fd034]
# [    0.000000] Linux version 6.8.0 (gcc 13.2.0)
# [    0.000000] Machine model: Raspberry Pi 4 Model B
# [    0.000000] efi: UEFI not found.
# [    0.000000] OF: fdt: Ignoring memory range 0x0 - 0x80000
# [    0.000000] Zone ranges:
# [    0.000000]   DMA      [mem 0x0000000000000000-0x000000003fffffff]
# [    0.000000]   DMA32    empty
# [    0.000000]   Normal   [mem 0x0000000040000000-0x000000013fffffff]

# Check exception level we booted at:
dmesg | grep "booted at EL"
# Kernel booted at EL2

# KASLR offset (if enabled):
dmesg | grep "kaslr"
# KASLR enabled: offset 0x5500000

# Check the arm64 CPU features detected:
dmesg | grep "CPU features"
cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_cur_freq
```

## Further reading

- [ARM64 Exception Model](exception-model.md) — EL0-EL3, exception entry/exit
- [ARM64 Memory Model](memory-model.md) — TTBR0/TTBR1, page table format
- [Page Tables](../../mm/page-tables.md) — host-side page table internals
- [SMP](../../sched/context-switch.md) — secondary CPU initialization
- [arch/arm64/kernel/head.S](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm64/kernel/head.S) — complete boot assembly
- [arch/arm64/mm/mmu.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm64/mm/mmu.c) — page table creation
- [Booting AArch64 Linux](https://docs.kernel.org/arch/arm64/booting.html) — the boot contract between firmware/bootloader and kernel
- ARM Architecture Reference Manual (ARM DDI 0487) — authoritative reference
