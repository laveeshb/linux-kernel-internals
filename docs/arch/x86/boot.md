# x86-64 Boot Sequence

> From BIOS/UEFI reset vector to start_kernel()

The x86-64 boot process is a journey through three CPU modes: real mode (16-bit), protected mode (32-bit), and long mode (64-bit). The kernel must navigate this transition on every boot before it can run any 64-bit code. UEFI shortens but does not eliminate this path.

---

## Two boot paths

Modern x86-64 systems boot via one of two firmware interfaces:

| | BIOS | UEFI |
|--|------|------|
| Standard | Legacy (pre-2010 systems, some VMs) | All modern systems |
| Reset vector | 0xFFFFFFF0 in real mode | Firmware calls EFI stub directly |
| CPU mode at handoff | 16-bit real mode | 32-bit protected mode (or 64-bit) |
| Memory map delivery | BIOS INT 0x15 / e820 | EFI memory map via `GetMemoryMap()` |
| Bootloader needed | Yes (GRUB2, syslinux) | Optional (EFI stub can boot directly) |

---

## BIOS boot path

### Reset vector and POST

On power-on, the x86-64 CPU resets to real mode and executes its first instruction at the **reset vector**: physical address `0xFFFFFFF0` (mapped to ROM). This is the top 16 bytes of the 4GB address space.

The BIOS firmware runs **POST** (Power-On Self Test):
- Initializes and tests RAM
- Enumerates PCI devices
- Detects the memory map (passed to the OS via INT 0x15/E820)
- Loads the first-stage bootloader from the boot device's MBR (first 512 bytes)

### GRUB2: loading the kernel

GRUB2 (Grand Unified Bootloader version 2) is the most common Linux bootloader on BIOS systems. After being loaded by the BIOS from the MBR:

1. GRUB2's second stage loads the kernel image (`/boot/vmlinuz-*`) into memory
2. It reads or constructs `struct boot_params` (defined in `arch/x86/include/uapi/asm/bootparam.h`)
3. It populates the e820 memory map entries in `boot_params.e820_table`
4. It uses the 32-bit boot protocol and jumps directly to `startup_32` in the compressed stub, bypassing the real-mode setup code entirely (the 512-byte boot sector occupies offset 0–511; the real-mode setup code begins at offset 512/0x200, but modern GRUB2 skips it via the 32-bit entry point)

```c
/* arch/x86/include/uapi/asm/bootparam.h */
struct boot_params {
    struct screen_info       screen_info;        /* 0x000 */
    struct apm_bios_info     apm_bios_info;      /* 0x040 */
    /* ... */
    __u8                     e820_entries;        /* 0x1e8 */
    struct setup_header      hdr;                 /* 0x1f1 */
    /* ... */
    struct boot_e820_entry   e820_table[E820_MAX_ENTRIES_ZEROPAGE]; /* 0x2d0 */
};

struct setup_header {
    __u8    setup_sects;      /* number of setup sectors */
    __u16   root_flags;
    __u32   syssize;          /* size of protected-mode code in 16-byte units */
    /* ... */
    __u32   kernel_alignment; /* required alignment of kernel */
    __u8    relocatable_kernel;
    /* ... */
    __u64   pref_address;     /* preferred loading address */
    __u32   init_size;        /* size needed for initialization */
};
```

### bzImage layout

The kernel is distributed as a `bzImage` (big zImage) — a self-decompressing archive:

```
bzImage on disk:
┌────────────────────────────────────────────┐
│  Boot sector (512 bytes, MBR-compatible)   │
├────────────────────────────────────────────┤
│  Real-mode setup code (arch/x86/boot/)     │
│  • setup.elf compiled to 16-bit code       │
│  • Detects memory, video mode, CPUID       │
│  • Switches to protected mode              │
├────────────────────────────────────────────┤
│  Protected-mode stub (startup_32)          │
│  arch/x86/boot/compressed/head_32.S        │
├────────────────────────────────────────────┤
│  Compressed vmlinux (gzip/lz4/zstd/xz)    │
│  • The actual kernel ELF, compressed       │
│  • Decompressed into place at runtime      │
└────────────────────────────────────────────┘
```

---

## Real mode setup code (`arch/x86/boot/`)

The real-mode setup code runs in 16-bit mode and performs early hardware detection before switching to protected mode. Key files: `arch/x86/boot/main.c`, `arch/x86/boot/memory.c`, `arch/x86/boot/video.c`.

### Memory detection: e820

The setup code queries the BIOS for the physical memory map using INT 0x15/E820:

```c
/* arch/x86/boot/memory.c */
static int detect_memory_e820(void)
{
    int count = 0;
    struct biosregs ireg, oreg;
    struct boot_e820_entry *desc = boot_params.e820_table;
    static struct boot_e820_entry buf; /* static so it is zeroed */

    initregs(&ireg);
    ireg.ax  = 0xe820;
    ireg.cx  = sizeof(buf);
    ireg.edx = SMAP;    /* 'SMAP' signature */
    ireg.di  = (size_t)&buf;

    do {
        intcall(0x15, &ireg, &oreg);
        ireg.ebx = oreg.ebx; /* continuation value */
        /* ... copy buf to boot_params.e820_table[count++] ... */
    } while (ireg.ebx && count < ARRAY_SIZE(boot_params.e820_table));

    return boot_params.e820_entries = count;
}
```

The resulting e820 table describes which physical memory ranges are usable RAM, reserved (ACPI, MMIO), or unusable. The kernel's memory management subsystem (`memblock`) uses this table later in boot.

### Video mode setup and other detection

The setup code also:
- Detects available video modes and sets the console resolution
- Queries APM BIOS, EDD (Enhanced Disk Drive) information
- Reads CPUID to detect CPU capabilities
- Sets up the heap for use by the setup code itself

### Switching to protected mode: enabling CR0.PE

The final act of the real-mode setup code is switching to 32-bit protected mode:

```c
/* arch/x86/boot/pm.c */
void go_to_protected_mode(void)
{
    /* Hook before entering protected mode */
    realmode_switch_hook();

    /* Enable the A20 line (required for >1MB access) */
    if (enable_a20()) {
        puts("A20 gate not responding, unable to boot...\n");
        die();
    }

    /* Reset coprocessor */
    reset_coprocessor();

    /* Disable all interrupts — we are about to switch mode */
    mask_all_interrupts();

    /* Set up a minimal GDT and IDT */
    setup_idt();
    setup_gdt();

    /* Switch: set CR0.PE bit, then far-jump to 32-bit code */
    protected_mode_jump(boot_params.hdr.code32_start,
                        (u32)&boot_params + (ds() << 4));
}
```

`protected_mode_jump` (in `arch/x86/boot/pmjump.S`) sets `CR0.PE = 1` and executes a far jump to `startup_32` — the first 32-bit code.

---

## Protected mode → long mode

### startup_32 (`arch/x86/boot/compressed/head_32.S`)

`startup_32` runs in 32-bit protected mode. Its job:

1. Set up segment registers with flat 32-bit descriptors
2. Clear BSS
3. Set up a stack
4. Calculate the physical address where it is running (position-independent)
5. Set up initial page tables for the identity mapping needed during the transition
6. Enable PAE (Physical Address Extension): set `CR4.PAE = 1`
7. Load the initial page table into `CR3`
8. Set `EFER.LME = 1` via WRMSR (MSR 0xC0000080)
9. Enable paging: set `CR0.PG = 1` — this atomically activates long mode (EFER.LMA becomes 1)
10. Perform a far jump into 64-bit code segment → CPU is now in 64-bit long mode

```asm
/* arch/x86/boot/compressed/head_32.S (simplified) */

/* Enable PAE */
movl    %cr4, %eax
orl     $X86_CR4_PAE, %eax
movl    %eax, %cr4

/* Load page table */
leal    pgtable(%ebx), %eax
movl    %eax, %cr3

/* Enable long mode (EFER.LME) */
movl    $MSR_EFER, %ecx
rdmsr
btsl    $_EFER_LME, %eax
wrmsr

/* Enable paging + protection; activates long mode */
movl    $(X86_CR0_PG | X86_CR0_PE), %eax
movl    %eax, %cr0

/* Far jump to 64-bit code segment */
lret    /* pops cs:eip from stack, cs selects 64-bit descriptor */
```

### startup_64 (`arch/x86/boot/compressed/head_64.S`)

`startup_64` is the first 64-bit code. At this point:
- The CPU is in 64-bit long mode
- Only a minimal identity-mapped page table exists
- The compressed kernel blob is still in memory, not yet decompressed

`startup_64` sets up enough infrastructure to decompress the kernel:
1. Relocates itself if necessary (for KASLR — Kernel Address Space Layout Randomization)
2. Sets up a proper stack
3. Calls `extract_kernel()` which calls `decompress_kernel()`

### Decompression

```c
/* arch/x86/boot/compressed/misc.c */
asmlinkage __visible void *extract_kernel(void *rmode, memptr heap,
                                           unsigned char *input_data,
                                           unsigned long input_len,
                                           unsigned char *output,
                                           unsigned long output_len)
{
    /* ... */
    decompress_kernel(output, input_data, input_len, error);
    /* parse ELF headers, handle relocations */
    parse_elf(output);
    /* ... */
    return output;  /* returns entry point of decompressed kernel */
}
```

The decompressor is self-contained — it includes its own copy of the decompression library (gzip, lz4, zstd, xz, or lzma depending on build config). After decompression, control passes to the decompressed kernel's `startup_64` in `arch/x86/kernel/head_64.S`.

---

## UEFI boot path

### EFI handoff

UEFI firmware loads the kernel image as a PE/COFF executable and calls its entry point directly. The kernel's **EFI stub** (`arch/x86/boot/compressed/efi_stub_64.S`, `drivers/firmware/efi/libstub/`) handles this:

1. The EFI stub runs in the UEFI environment (protected mode or long mode, depending on firmware)
2. It calls UEFI Boot Services to:
   - Allocate memory for the kernel
   - Get the UEFI memory map (equivalent to e820)
   - Set up the `struct boot_params` that the kernel expects
3. It calls `ExitBootServices()` to relinquish UEFI firmware control
4. It jumps to the kernel entry point

The advantage: **no real mode required**. The firmware does the hardware initialization (POST equivalent) and hands off in a much cleaner state than BIOS does.

```c
/* drivers/firmware/efi/libstub/x86-stub.c (simplified) */
efi_status_t __efiapi efi_pe_entry(efi_handle_t handle,
                                    efi_system_table_t *sys_table_arg)
{
    /* ... allocate memory, build boot_params ... */
    status = efi_stub_common(handle, image, sys_table_arg, cmdline_ptr);
    /* ... */
    return status;
}
```

The `/sys/firmware/efi` directory exists on UEFI-booted systems:

```bash
# Check if booted via UEFI
ls /sys/firmware/efi          # exists on UEFI boot, absent on BIOS
cat /sys/firmware/efi/fw_platform_size  # 64 = 64-bit UEFI

# EFI variables
efibootmgr -v               # shows boot order and entries
```

---

## The kernel's own startup_64 (`arch/x86/kernel/head_64.S`)

After decompression, the decompressed kernel's `startup_64` runs. This is distinct from the compressed stub's `startup_64`. It sets up the kernel's permanent page tables and core infrastructure:

```asm
/* arch/x86/kernel/head_64.S (simplified structure) */

SYM_CODE_START_NOALIGN(startup_64)
    /* Verify we are in long mode */
    /* Set up %ss, %ds, %es, %fs, %gs to kernel data segment */

    /* Set up initial kernel page tables (4-level or 5-level) */
    /* early_top_pgt is the initial PGD */

    /* Set CR3 to point at early_top_pgt */
    leaq    early_top_pgt(%rip), %rax
    movq    %rax, %cr3

    /* Set up the GS base to point at the initial per-CPU data */
    /* (GS is used for per-CPU variable access in the kernel) */
    movl    $MSR_GS_BASE, %ecx
    /* ... load initial_gs into MSR ... */
    wrmsr

    /* Clear BSS */
    xorl    %eax, %eax
    leaq    __bss_start(%rip), %rdi
    leaq    __bss_stop(%rip), %rcx
    subq    %rdi, %rcx
    shrq    $3, %rcx
    rep stosq

    /* Call into C: x86_64_start_kernel() */
    leaq    x86_64_start_kernel(%rip), %rax
    callq   *%rax
SYM_CODE_END(startup_64)
```

---

## x86_64_start_kernel() → start_kernel()

```c
/* arch/x86/kernel/head64.c */
asmlinkage __visible void __init x86_64_start_kernel(char *real_mode_data)
{
    /*
     * We are still running on the init stack; interrupts are off.
     * The kernel is not yet mapped at its final virtual address everywhere.
     */

    /* Build the final early page tables */
    /* BSS already cleared in startup_64 assembly */

    /*
     * Copy the boot_params from real mode data area to its
     * final location (the real_mode_data pointer from the bootloader)
     */
    copy_bootdata(__va(real_mode_data));

    /*
     * Load the GDT and IDT with their final values.
     * This sets up the TSS and exception handling infrastructure.
     */
    load_ucode_bsp();

    /* Initialize the cr4 shadow (used by cr4_set_bits etc.) */
    cr4_init_shadow();

    /* Final page table setup, enable NX if available */
    x86_64_start_reservations(real_mode_data);
}

void __init x86_64_start_reservations(char *real_mode_data)
{
    /* ... */
    start_kernel();  /* the architecture-independent entry point */
}
```

`start_kernel()` (in `init/main.c`) is the first architecture-independent code: it initializes the scheduler, memory management, interrupt subsystem, and eventually starts the `init` process.

### What start_kernel() initializes

In order (selected highlights):

```
start_kernel()
  setup_arch()          — x86 arch init: e820 processing, APIC, CPU detection
  mm_init()             — memory management: memblock → buddy allocator
  sched_init()          — scheduler: runqueues, idle task
  trap_init()           — IDT: exception handlers
  init_IRQ()            — interrupt handling infrastructure
  softirq_init()        — softirq / tasklet infrastructure
  time_init()           — clocksource (TSC, HPET, etc.)
  rest_init()           — creates kernel_init thread, becomes idle
    kernel_init()
      do_initcalls()    — module __initcall() functions
      run_init_process() — exec /sbin/init (PID 1)
```

---

## Key data structures

| Structure | Location | Purpose |
|-----------|----------|---------|
| `struct boot_params` | `arch/x86/include/uapi/asm/bootparam.h` | Bootloader → kernel parameter passing |
| `struct setup_header` | Same file, embedded in `boot_params` | Kernel image metadata (load address, flags) |
| `struct boot_e820_entry` | `arch/x86/include/uapi/asm/e820.h` | One entry in the physical memory map |
| `struct e820_table` | `arch/x86/include/asm/e820/types.h` | Full memory map (up to 128 entries) |

---

## Observing the boot process

```bash
# Full boot log (from GRUB through start_kernel)
dmesg | head -200

# Memory map as seen by the kernel
cat /proc/iomem

# e820 entries from BIOS/UEFI
dmesg | grep -i e820

# UEFI-specific
ls /sys/firmware/efi/
cat /sys/firmware/efi/fw_platform_size   # 32 or 64

# Kernel command line passed by bootloader
cat /proc/cmdline

# CPU details detected at boot
dmesg | grep -E "CPU|microcode|BIOS"

# KASLR: kernel load address (randomized if CONFIG_RANDOMIZE_BASE=y)
grep _text /proc/kallsyms | head -1

# Boot time breakdown (requires systemd)
systemd-analyze
systemd-analyze blame
```

---

## Version notes

- **KASLR** (Kernel Address Space Layout Randomization): introduced in Linux 3.14 for x86-64; randomizes the physical and virtual load address of the kernel at each boot. Implemented in `arch/x86/boot/compressed/kaslr.c`.
- **5-level paging at boot**: if the CPU supports LA57 and the kernel is configured with `CONFIG_X86_5LEVEL=y`, `startup_64` sets up 5-level page tables. Introduced in Linux 4.14.
- **UEFI stub**: the in-kernel EFI stub (`CONFIG_EFI_STUB`) was introduced in Linux 3.3, allowing kernels to be booted directly by UEFI without a bootloader.
- **Compressed kernel formats**: gzip is the oldest; lz4, lzma, xz, zstd support was added incrementally; zstd (fastest decompression) was added in Linux 5.9.

---

## Further reading

### Kernel source & documentation

- [The Linux/x86 Boot Protocol](https://docs.kernel.org/arch/x86/boot.html) — the setup header, entry conventions, and protocol history
- [arch/x86/boot/](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/boot/) — the real-mode setup code walked through above
- [arch/x86/kernel/head_64.S](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/head_64.S) — `startup_64` and early paging setup

### Related pages

- [x86_64 Boot Page Table Setup](../../mm/boot-page-tables.md) — the early page tables in depth, KASLR, 5-level enablement
- [memblock](../../mm/memblock.md) — the boot-time memory allocator this sequence hands off to
- [ARM64 Boot Sequence](../arm64/boot.md) — the same journey on the other major architecture
