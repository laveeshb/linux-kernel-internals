# kexec

> Boot a new kernel from within a running kernel, without hardware reset

## What kexec does

`kexec` loads a new kernel into memory and jumps to it directly, bypassing BIOS/UEFI POST and the bootloader:

```
Normal boot:      BIOS/UEFI → GRUB → kernel
kexec boot:       running kernel → kexec_exec → new kernel
                  (BIOS/POST skipped → 5-10 second faster reboot)
```

Primary uses:
1. **Fast reboot**: upgrade kernel in seconds instead of minutes
2. **kdump**: crash kernel boots capture kernel to save vmcore
3. **A/B kernel updates**: atomically switch to a new kernel

## kexec_load syscall

```c
/* kernel/kexec.c */
/*
 * kexec_load(entry, nr_segments, segments, flags)
 *   entry:      entry point of new kernel
 *   nr_segments: number of memory segments to load
 *   segments:   array of kexec_segment structs
 *   flags:      KEXEC_ON_CRASH=for kdump, KEXEC_ARCH=arch, etc.
 */

struct kexec_segment {
    const void  __user *buf;   /* userspace buffer with segment data */
    size_t               bufsz; /* size of buffer */
    const void          *mem;  /* target physical address */
    size_t               memsz; /* size at target */
};
```

### kexec_file_load: signature-verified loading

`kexec_file_load` takes a file descriptor instead of raw memory segments, enabling kernel image signature verification:

```c
/* kexec_file_load(kernel_fd, initrd_fd, cmdline_len, cmdline, flags) */
int kexec_file_load(int kernel_fd,      /* open("/boot/vmlinuz", O_RDONLY) */
                     int initrd_fd,      /* initrd file descriptor */
                     unsigned long cmdline_len,
                     const char __user *cmdline,
                     unsigned long flags);
```

If `CONFIG_KEXEC_VERIFY_SIG=y`, the kernel image must be signed with a trusted key — useful for Secure Boot compatibility.

## Machine kexec: the jump

When `kexec -e` is run, `machine_kexec()` performs the actual handoff:

```c
/* arch/x86/kernel/machine_kexec_64.c */
void machine_kexec(struct kimage *image)
{
    unsigned long page_list;
    unsigned long reboot_code_buffer_phys;
    void *reboot_code_buffer;

    /* Disable interrupts */
    local_irq_disable();

    /* Stop all other CPUs */
    machine_crash_nonpanic_core(NULL);

    /* Copy identity-mapped page tables (kexec needs to access
       the new kernel's pages which are at physical addresses) */
    page_list = image->head & PAGE_MASK;

    /* Jump to the relocation trampoline */
    reboot_code_buffer = page_address(image->control_code_page);
    relocate_kernel((unsigned long)page_list,
                     reboot_code_buffer,
                     image->start,
                     image->preserve_context,
                     image->arch.pgtable);
}

/* relocate_kernel (assembly): */
/*   1. Switch to identity-mapped page tables */
/*   2. Copy new kernel segments to their final locations */
/*   3. Jump to new kernel entry point */
```

## kimage: the loaded kernel

```c
/* include/linux/kexec.h */
struct kimage {
    kimage_entry_t  head;            /* page list head */
    kimage_entry_t *entry;           /* current position in page list */
    kimage_entry_t *last_entry;      /* end of page list */

    unsigned long    start;          /* entry point of new kernel */

    struct page     *control_code_page; /* page for relocation code */
    struct page     *swap_page;         /* temporary page for copying */

    unsigned long    nr_segments;    /* number of loaded segments */
    struct kexec_segment segment[KEXEC_SEGMENT_MAX]; /* up to 16 segments */

    struct list_head control_pages;  /* pages used by kexec itself */
    struct list_head dest_pages;     /* pages for new kernel */
    struct list_head unusable_pages; /* pages that can't be used */

    /* ... */
    unsigned long    flags;
    int              type;           /* KEXEC_TYPE_DEFAULT or KEXEC_TYPE_CRASH */
};
```

## kdump integration

kdump uses kexec to boot a capture kernel when the primary kernel crashes:

```
Primary kernel running
    │ panic() / oops
    ▼
machine_crash_shutdown()
    │ stop all CPUs
    │ save registers
    ▼
machine_kexec(kexec_crash_image)
    │
    ▼
Capture kernel boots
    │ reads /proc/vmcore (primary kernel's memory)
    ▼
makedumpfile saves vmcore → reboot
```

The capture kernel is loaded into a reserved physical memory region (`crashkernel=256M`) during normal boot. The primary kernel never uses this region, so it's intact after a crash.

```bash
# Load kdump kernel at boot
kexec -p /boot/vmlinuz-kdump \
    --initrd=/boot/initrd-kdump.img \
    --reuse-cmdline \
    --append="irqpoll nr_cpus=1 reset_devices"

# List loaded kernels
cat /sys/kernel/kexec_crash_loaded
# 1 = crash kernel loaded

cat /sys/kernel/kexec_loaded
# 0 = no normal kexec kernel loaded
```

## kexec userspace tool

```bash
# Load a kernel for kexec reboot
kexec -l /boot/vmlinuz \
    --initrd=/boot/initrd.img \
    --reuse-cmdline       # use current boot cmdline

# Load with explicit command line
kexec -l /boot/vmlinuz \
    --initrd=/boot/initrd.img \
    --append="root=/dev/sda1 quiet"

# Execute: jump to new kernel immediately
kexec -e

# Or: schedule for next reboot (via systemctl)
systemctl kexec
# runs kexec -e during shutdown

# Load crash kernel
kexec -p /boot/vmlinuz-crash \
    --initrd=/boot/initrd-crash.img \
    --append="1 irqpoll"

# Unload crash kernel
kexec -p -u
```

## kexec in the kernel

### Shutdown sequence

```c
/* kernel/kexec_core.c */
int kernel_kexec(void)
{
    int error = 0;

    /* Execute pre-kexec notifiers */
    error = blocking_notifier_call_chain(&reboot_notifier_list, SYS_RESTART, NULL);

    /* Suspend filesystems and devices */
    error = pm_notifier_call_chain(PM_SUSPEND_PREPARE);

    kernel_restart_prepare(NULL);

    /* Disable SMP: all other CPUs stopped */
    migrate_to_reboot_cpu();
    syscore_shutdown();

    /* Jump to new kernel */
    machine_kexec(kexec_image);

    /* Should not return */
    BUG();
    return error;
}
```

### Preserving EFI runtime services

```c
/* For EFI systems: preserve EFI runtime memory */
if (efi_enabled(EFI_RUNTIME_SERVICES)) {
    /* Mark EFI runtime regions as preserved */
    /* New kernel can use EFI runtime services */
}
```

## Observing kexec

```bash
# Check kexec support in kernel
grep KEXEC /boot/config-$(uname -r)
# CONFIG_KEXEC=y
# CONFIG_KEXEC_FILE=y
# CONFIG_KEXEC_VERIFY_SIG=y   (optional)

# Memory reserved for kdump
cat /proc/iomem | grep -i crash
# 100000000-10fffffff : Crash kernel

# Boot source detection: was this a kexec boot?
cat /sys/kernel/kexec_loaded
# After kexec reboot: bootloader may set ACPI table flag
dmesg | grep -i kexec

# Timing: kexec vs cold boot
time systemctl kexec   # ~5 seconds
# vs
time reboot            # ~60 seconds (BIOS POST)
```

## Further reading

- [kdump and crash](../debugging/kdump.md) — crash dump collection using kexec
- [Kernel Live Patching](klp.md) — avoiding reboots entirely
- [Power Management: System Suspend](../power/suspend.md) — PM notifiers in kexec path
- `kernel/kexec_core.c`, `arch/x86/kernel/machine_kexec_64.c` — kexec core
- `man 8 kexec` — userspace kexec tool
