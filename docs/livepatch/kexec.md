# kexec

> Boot a new kernel from within a running kernel, without hardware reset

## What kexec does

`kexec` loads a new kernel into memory and jumps to it directly, bypassing BIOS/UEFI POST and the bootloader:

```
Normal boot:      BIOS/UEFI → GRUB → kernel
kexec boot:       running kernel → kexec_exec → new kernel
                  (BIOS/POST skipped → faster reboot, savings vary
                   widely by firmware and hardware)
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

/* include/linux/kexec.h */
struct kexec_segment {
    /* ->buf for kexec_load() (userspace ptr); ->kbuf for kexec_file_load() (kernel ptr) */
    union {
        void __user *buf;
        void        *kbuf;
    };
    size_t        bufsz;  /* size of buffer */
    unsigned long mem;    /* target physical address */
    size_t        memsz;  /* size at target */
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

If `CONFIG_KEXEC_SIG=y`, the kernel image must be signed with a trusted key — useful for Secure Boot compatibility.

## Machine kexec: the jump

When `kexec -e` is run, `machine_kexec()` performs the actual handoff:

```c
/* arch/x86/kernel/machine_kexec_64.c */
void machine_kexec(struct kimage *image)
{
    unsigned long reloc_start = (unsigned long)__relocate_kernel_start;
    relocate_kernel_fn *relocate_kernel_ptr;
    unsigned int relocate_kernel_flags;
    void *control_page;

    /* By this point kernel_kexec() has already parked every other CPU
       via machine_shutdown()'s stop_other_cpus() (or, on the
       CONFIG_KEXEC_JUMP preserve-context path, suspend_disable_secondary_cpus());
       this function does not stop CPUs itself. */

    /* Interrupts aren't acceptable while we reboot */
    local_irq_disable();
    hw_breakpoint_disable();
    cet_disable();

    control_page = page_address(image->control_code_page);

    /* relocate_kernel_ptr points at the relocation trampoline
       copied into control_page */
    relocate_kernel_ptr = control_page + ((unsigned long)relocate_kernel - reloc_start);

    relocate_kernel_flags = 0;
    if (image->preserve_context)
        relocate_kernel_flags |= RELOC_KERNEL_PRESERVE_CONTEXT;

    load_segments();

    /* Jump to the relocation trampoline: copies new kernel segments
       to their final locations, then jumps to the new kernel entry */
    image->start = relocate_kernel_ptr((unsigned long)image->head,
                                        virt_to_phys(control_page),
                                        image->start,
                                        relocate_kernel_flags);
}
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

    /* Flags to indicate special processing */
    unsigned int type : 1;        /* KEXEC_TYPE_DEFAULT or KEXEC_TYPE_CRASH */
    unsigned int preserve_context : 1;
    unsigned int file_mode : 1;   /* set if loaded via kexec_file_load() */
    unsigned int no_cma : 1;

    /* ... */
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

    if (!kexec_trylock())
        return -EBUSY;
    if (!kexec_image) {
        error = -EINVAL;
        goto Unlock;
    }

#ifdef CONFIG_KEXEC_JUMP
    if (kexec_image->preserve_context) {
        /* preserve-context ("kexec jump") path: reuses the same
           device-suspend callbacks as hibernation */
        pm_prepare_console();
        freeze_processes();
        console_suspend_all();
        dpm_suspend_start(PMSG_FREEZE);
        dpm_suspend_end(PMSG_FREEZE);
        suspend_disable_secondary_cpus();
        local_irq_disable();
        syscore_suspend();
    } else
#endif
    {
        kexec_in_progress = true;
        /* kernel_restart_prepare() runs the reboot notifier chain,
           sets system_state, disables usermodehelpers, and shuts
           down devices */
        kernel_restart_prepare("kexec reboot");
        migrate_to_reboot_cpu();
        syscore_shutdown();
        cpu_hotplug_enable();
        machine_shutdown();
    }

    kmsg_dump(KMSG_DUMP_SHUTDOWN);
    /* Jump to new kernel; does not return on success */
    machine_kexec(kexec_image);

#ifdef CONFIG_KEXEC_JUMP
    /* Only reached if preserve_context and the "jump" kernel later
       hands control back (mirror-image resume of the block above) */
#endif

 Unlock:
    kexec_unlock();
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
# CONFIG_KEXEC_SIG=y   (optional)

# Memory reserved for kdump
cat /proc/iomem | grep -i crash
# 100000000-10fffffff : Crash kernel

# kexec_loaded reports whether an image is currently loaded and
# ready to execute, not whether the running kernel itself was
# booted via kexec
cat /sys/kernel/kexec_loaded
dmesg | grep -i kexec

# Timing: kexec vs cold boot. kexec skips BIOS/UEFI POST and the
# bootloader stage, so it's typically faster than a full reboot —
# but the actual savings (anywhere from roughly one second to tens
# of seconds) depend heavily on firmware POST time and CPU count,
# so measure on your own hardware rather than assuming a fixed number
time systemctl kexec
# vs
time reboot
```

## Further reading

### Kernel source

- [kernel/kexec.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/kexec.c) — `SYSCALL_DEFINE4(kexec_load, ...)`: the segment-list-based load syscall
- [kernel/kexec_file.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/kexec_file.c) — `SYSCALL_DEFINE5(kexec_file_load, ...)` and the `CONFIG_KEXEC_SIG` signature-verification path
- [kernel/kexec_core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/kexec_core.c) — `kernel_kexec()`'s shutdown sequence and the `loaded`/`crash_loaded` sysfs attributes exposed as `/sys/kernel/kexec_loaded` and `/sys/kernel/kexec_crash_loaded`
- [include/linux/kexec.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/kexec.h) — `struct kimage` and `struct kexec_segment` definitions
- [arch/x86/kernel/machine_kexec_64.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/machine_kexec_64.c) — `machine_kexec()`: the actual handoff to the new kernel on x86-64

### Man pages

- [kexec_load(2)](https://man7.org/linux/man-pages/man2/kexec_load.2.html) — covers both the `kexec_load()` and `kexec_file_load()` syscalls
- [kexec(8)](https://man7.org/linux/man-pages/man8/kexec.8.html) — the userspace `kexec-tools` command: `-l`/`-p`/`-e`/`-u` options

### Related pages

- [kdump and crash](../debugging/kdump.md) — crash dump collection using kexec
- [Kernel Live Patching](klp.md) — avoiding reboots entirely
- [Power Management: System Suspend](../power/suspend.md) — the `freeze_processes()`/`dpm_suspend_start()` device-suspend sequence that `CONFIG_KEXEC_JUMP`'s preserve-context path reuses from the hibernation code path

### LWN articles

- [kexec: A new system call to allow in kernel loading](https://lwn.net/Articles/574400/) — the original RFC introducing `kexec_file_load()` with its kernel-fd/initrd-fd design
- [Reworking kexec for signatures](https://lwn.net/Articles/603116/) — why `kexec_file_load()` exists: restricting kexec to signed kernels, and its relationship to Secure Boot

### External

- [Kdump](https://docs.kernel.org/admin-guide/kdump/kdump.html) — official kdump setup guide covering `crashkernel=` sizing and the `irqpoll`/`nr_cpus=1`/`reset_devices` boot options used when loading the capture kernel
