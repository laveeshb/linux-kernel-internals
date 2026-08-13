# KVM Exit Handling

> What happens when a guest faults: exit reasons, I/O emulation, and MMIO

## The vcpu_run loop

Every KVM vCPU runs in a tight loop inside `kvm_arch_vcpu_ioctl_run()` in `arch/x86/kvm/x86.c`. The loop enters the guest, hardware runs the guest until something requires hypervisor intervention (a VM exit), then KVM dispatches that exit to the appropriate handler.

```
kvm_arch_vcpu_ioctl_run()          arch/x86/kvm/x86.c
  └── vcpu_run()
        └── vcpu_enter_guest()
              ├── kvm_x86_ops.prepare_guest_switch(vcpu)
              ├── VMLAUNCH / VMRESUME  ← hardware runs guest here
              │       (guest executes at near-native speed)
              │
              │   [VM exit fires — hardware saves guest state to VMCS]
              │
              └── kvm_x86_ops.handle_exit(vcpu, exit_fastpath)
                    └── vmx_exit_handlers[exit_reason](vcpu)
                          returns 1 → resume guest
                          returns 0 → exit to userspace (QEMU)
```

The key contract: a handler returning `1` means KVM can re-enter the guest immediately. Returning `0` or a negative error means `KVM_RUN` ioctl returns to userspace, which inspects `struct kvm_run` to learn what happened.

### vcpu_enter_guest internals

Before entering the guest on each iteration, `vcpu_enter_guest()` processes any pending work:

```c
/* arch/x86/kvm/x86.c (simplified) */
static int vcpu_enter_guest(struct kvm_vcpu *vcpu)
{
    /* Process pending requests: TLB flushes, MMU reloads, etc. */
    if (kvm_request_pending(vcpu)) {
        if (kvm_check_request(KVM_REQ_TLB_FLUSH_GUEST, vcpu))
            kvm_vcpu_flush_tlb_guest(vcpu);
        if (kvm_check_request(KVM_REQ_MMU_RELOAD, vcpu))
            kvm_mmu_unload(vcpu);
        /* ... other KVM_REQ_* flags ... */
    }

    /* Inject a pending interrupt (if any) before entering */
    if (vcpu->arch.interrupt.injected)
        kvm_x86_ops.inject_irq(vcpu);

    /* Disable preemption, switch to guest CR3, enter VMX non-root */
    kvm_x86_ops.run(vcpu);  /* VMLAUNCH or VMRESUME */

    /*
     * We are back — VM exit occurred.
     * vcpu->arch.exit_reason is now set from the VMCS.
     */
    exit_fastpath = kvm_x86_ops.handle_exit_irqoff(vcpu);

    return kvm_x86_ops.handle_exit(vcpu, exit_fastpath);
}
```

## Exit reason dispatch

On Intel, the exit reason is stored in the VMCS `VM_EXIT_REASON` field. KVM VMX reads it into `vcpu->arch.exit_reason` and indexes into `vmx_exit_handlers[]`:

```c
/* arch/x86/kvm/vmx/vmx.c */
static int (*vmx_exit_handlers[])(struct kvm_vcpu *vcpu) = {
    [EXIT_REASON_EXCEPTION_NMI]     = handle_exception_nmi,
    [EXIT_REASON_EXTERNAL_INTERRUPT]= handle_external_interrupt,
    [EXIT_REASON_IO_INSTRUCTION]    = handle_io,
    [EXIT_REASON_CR_ACCESS]         = handle_cr,
    [EXIT_REASON_DR_ACCESS]         = handle_dr,
    [EXIT_REASON_CPUID]             = kvm_emulate_cpuid,
    [EXIT_REASON_MSR_READ]          = kvm_emulate_rdmsr,
    [EXIT_REASON_MSR_WRITE]         = kvm_emulate_wrmsr,
    [EXIT_REASON_HLT]               = kvm_emulate_halt,
    [EXIT_REASON_EPT_VIOLATION]     = handle_ept_violation,
    [EXIT_REASON_EPT_MISCONFIG]     = handle_ept_misconfig,
    [EXIT_REASON_VMCALL]            = handle_vmcall,
    [EXIT_REASON_APIC_ACCESS]       = handle_apic_access,
    /* ... ~40 total handlers ... */
};

static int vmx_handle_exit(struct kvm_vcpu *vcpu,
                            enum exit_fastpath_completion exit_fastpath)
{
    u32 exit_reason = vmx_get_exit_reason(vcpu);

    if (unlikely(exit_reason >= ARRAY_SIZE(vmx_exit_handlers) ||
                 !vmx_exit_handlers[exit_reason]))
        return handle_invalid_guest_state(vcpu);

    return vmx_exit_handlers[exit_reason](vcpu);
}
```

AMD SVM follows the same pattern with `svm_exit_handlers[]` in `arch/x86/kvm/svm/svm.c`, indexed by the `EXITCODE` field in the VMCB.

## Common exit reasons

### EXIT_REASON_IO_INSTRUCTION — port I/O

Port I/O instructions (`in`/`out`) exit unconditionally on VMX (unless the I/O bitmap says otherwise). The fast path handles simple cases in-kernel; the slow path exits to userspace.

```c
/* arch/x86/kvm/vmx/vmx.c */
static int handle_io(struct kvm_vcpu *vcpu)
{
    unsigned long exit_qualification = vmx_get_exit_qual(vcpu);
    int size   = (exit_qualification & 7) + 1; /* 1, 2, or 4 bytes */
    int in     = (exit_qualification >> 3) & 1;
    int string = (exit_qualification >> 4) & 1;
    int port   = exit_qualification >> 16;

    if (string)
        return kvm_emulate_instruction(vcpu, 0);

    return kvm_emulate_pio(vcpu, in, size, port);
}
```

`kvm_emulate_pio()` (in `arch/x86/kvm/x86.c`) first tries in-kernel device emulation via the `kvm_io_bus` dispatch table. If no in-kernel device owns the port, it fills `kvm_run` and returns `0`:

```c
/* struct kvm_run — userspace sees this on KVM_EXIT_IO */
struct kvm_run {
    __u32 exit_reason;    /* KVM_EXIT_IO */
    /* ... */
    struct {
        __u8  direction;  /* KVM_EXIT_IO_IN or KVM_EXIT_IO_OUT */
        __u8  size;       /* 1, 2, or 4 */
        __u16 port;       /* I/O port number */
        __u32 count;      /* for string I/O: repeat count */
        __u64 data_offset;/* offset into kvm_run where data lives */
    } io;
};
```

### EXIT_REASON_EPT_VIOLATION — EPT/NPT page fault

When the guest accesses a guest physical address (GPA) that has no valid Extended Page Table (EPT) entry, or violates access permissions, hardware raises an EPT violation exit.

```c
/* arch/x86/kvm/vmx/vmx.c */
static int handle_ept_violation(struct kvm_vcpu *vcpu)
{
    unsigned long exit_qualification = vmx_get_exit_qual(vcpu);
    gpa_t gpa = vmcs_read64(GUEST_PHYSICAL_ADDRESS);
    u64 error_code = 0;

    /* Was this a read, write, or instruction fetch? */
    /* No PFERR bit for read (absence of WRITE and FETCH implies read) */
    if (exit_qualification & EPT_VIOLATION_ACC_WRITE)
        error_code |= PFERR_WRITE_MASK;
    if (exit_qualification & EPT_VIOLATION_ACC_INSTR)
        error_code |= PFERR_FETCH_MASK;

    return kvm_mmu_page_fault(vcpu, gpa, error_code, NULL, 0);
}
```

`kvm_mmu_page_fault()` (in `arch/x86/kvm/mmu/mmu.c`) determines the cause:

- **Missing mapping**: installs a new EPT leaf entry pointing to the host physical page.
- **MMIO range**: the GPA maps to a device, not RAM — triggers MMIO emulation (see below).
- **Permission fault**: guest tried a disallowed access (e.g., write to read-only page for CoW).

### EXIT_REASON_CPUID

`CPUID` is always intercepted so KVM can filter or synthesize feature bits. The handler calls `kvm_emulate_cpuid()` in `arch/x86/kvm/cpuid.c`, which looks up the leaf in `vcpu->arch.cpuid_entries[]` (populated from `KVM_SET_CPUID2` ioctl). Sensitive leaves are masked — for example, the hypervisor bit is set, and certain VMX feature bits are hidden from the guest.

### EXIT_REASON_HLT

When the guest executes `HLT` and interrupts are disabled, there is nothing for the vCPU to do. KVM calls `kvm_vcpu_halt()` which calls `kvm_vcpu_block()`:

```c
/* virt/kvm/kvm_main.c */
bool kvm_vcpu_block(struct kvm_vcpu *vcpu)
{
    /* vcpu->wait is a struct rcuwait, not a wait_queue_head_t */
    rcuwait_wait_event(&vcpu->wait,
                       kvm_arch_vcpu_runnable(vcpu) ||
                       kvm_arch_vcpu_has_work(vcpu),
                       TASK_INTERRUPTIBLE);
    return kvm_arch_vcpu_runnable(vcpu);
}
```

The vCPU thread sleeps until `kvm_vcpu_kick()` wakes it — typically because a virtual interrupt arrived.

### EXIT_REASON_MSR_READ / MSR_WRITE

MSR accesses can be made cheap with the **MSR bitmap**: a 4KB bitmap in the VMCS where each bit controls whether a specific MSR causes a VM exit. Frequently-read MSRs like `IA32_TSC` or `IA32_SYSENTER_EIP` can be pass-through (no exit). For intercepted MSRs, KVM dispatches to `kvm_get_msr()` or `kvm_set_msr()` (in `arch/x86/kvm/x86.c`), which uses switch-based per-MSR dispatch inside `__kvm_get_msr()` / `__kvm_set_msr()`.

### EXIT_REASON_EXCEPTION_NMI

Guest exceptions (page faults, GPFs, breakpoints) and NMIs exit here. `handle_exception_nmi()` in `arch/x86/kvm/vmx/vmx.c` inspects the `VM_EXIT_INTR_INFO` VMCS field to determine the vector. Depending on context:

- **Guest page fault** (`#PF`): handled by `kvm_handle_page_fault()` — either maps a host page or re-injects the fault to the guest.
- **Breakpoint** (`#BP`): delivered to the guest or intercepted for GDB stub.
- **NMI**: injected into the guest via the VMCS event-injection mechanism.

## MMIO emulation

When `handle_ept_violation()` determines the faulting GPA is in a MMIO region (no host physical mapping exists), KVM emulates the instruction that caused the fault rather than mapping a page.

```
Guest executes:   mov [0xfee00000], eax   (write to local APIC MMIO)

  1. EPT violation exits — GPA 0xfee00000 has no EPT mapping
  2. handle_ept_violation() → kvm_mmu_page_fault()
  3. kvm_mmu_page_fault() detects MMIO: no struct page for this GPA
  4. kvm_io_bus_write() tries in-kernel devices (e.g., KVM's APIC emulation)
     ├── hit: handled in-kernel, resume guest (return 1)
     └── miss: fall through to x86_emulate_instruction()

  5. x86_emulate_instruction() decodes the faulting instruction
     uses struct x86_emulate_ops to fetch instruction bytes from guest
  6. Emulated result placed in kvm_run.mmio; ioctl returns to userspace
```

The MMIO fields in `struct kvm_run` (from `include/uapi/linux/kvm.h`):

```c
/* When exit_reason == KVM_EXIT_MMIO */
struct kvm_run {
    __u32 exit_reason;   /* KVM_EXIT_MMIO */
    /* ... */
    struct {
        __u64 phys_addr; /* guest physical address of the MMIO access */
        __u8  data[8];   /* data to write (for writes); filled by userspace (for reads) */
        __u32 len;       /* access size: 1, 2, 4, or 8 bytes */
        __u8  is_write;  /* 1 = guest write, 0 = guest read */
    } mmio;
};
```

For a guest **read**: QEMU fills `kvm_run.mmio.data` with the device register value, then re-enters KVM via `KVM_RUN`. KVM completes the emulated instruction by writing the data into the guest register.

For a guest **write**: QEMU reads `kvm_run.mmio.data` and forwards it to the device model.

### KVM in-kernel MMIO devices

Several devices are emulated entirely in-kernel to avoid the QEMU round-trip:

| Device | In-kernel emulation |
|--------|---------------------|
| Local APIC | `arch/x86/kvm/lapic.c` |
| IOAPIC | `arch/x86/kvm/ioapic.c` |
| PIT (8254 timer) | `arch/x86/kvm/i8254.c` |

These register on the `kvm_io_bus` with `kvm_io_bus_register_dev()` and are matched by GPA range before any exit to userspace occurs.

## Interrupt injection

Interrupts to guest vCPUs do not arrive via normal hardware interrupt lines. KVM manages virtual interrupt delivery:

```c
/* Kick a vCPU to check for pending interrupts */
void kvm_vcpu_kick(struct kvm_vcpu *vcpu)
{
    /* If vCPU is running on another pCPU, send IPI to force exit */
    if (kvm_arch_vcpu_should_kick(vcpu))
        smp_send_reschedule(vcpu->cpu);

    /* Wake the vCPU thread if it is blocking (e.g., in HLT) */
    rcuwait_wake_up(&vcpu->wait);
}
```

The interrupt routing path for device interrupts:

```
Device (e.g., virtio-net) signals IRQ
  → kvm_set_irq(kvm, irq_source_id, irq, level, ...)   virt/kvm/irqchip.c
  → kvm_irq_routing_table lookup: GSI → IOAPIC pin or MSI
  → kvm_ioapic_set_irq() / kvm_apic_set_irq()
  → kvm_vcpu_kick(target_vcpu)
  → on next vcpu_enter_guest(): inject via VMCS VM-entry interrupt info field
```

The routing table (`struct kvm_irq_routing_table`, allocated in `virt/kvm/irqchip.c`) maps GSI numbers to IOAPIC/MSI entries and is updated via the `KVM_SET_GSI_ROUTING` ioctl.

Advanced interrupt features that reduce exits:

- **APICv / AVIC**: virtualizes the local APIC in hardware (Intel APICv / AMD AVIC), eliminating most APIC MMIO exits and enabling posted interrupt delivery without a VM exit.
- **Posted interrupts**: the CPU delivers virtual interrupts directly to the guest without a VM exit using the Posted Interrupt Descriptor (PID).

## Performance: measuring exits

VM exits are the primary source of KVM overhead. Minimizing exit frequency and exit handling latency is the main performance lever.

```bash
# Per-VM, per-vCPU exit counters in debugfs
ls /sys/kernel/debug/kvm/
# <pid>-<vmid>/   directories, one per VM

cat /sys/kernel/debug/kvm/1234-0/exits
# total: 8473921
# io_exits: 12304
# mmio_exits: 340291
# irq_window_exits: 5023
# halt_exits: 29103
# halt_wakeup: 29099

# perf KVM: aggregate exit statistics across all VMs
perf kvm stat record -a sleep 10
perf kvm stat report
# Analyze VM exits:
# VM-EXIT  Samples  Samples%  Time%    Min Time  Max Time  Avg time
# HLT          ...
# EPT_VIOLATION ...

# kvm_exit tracepoint: per-exit-reason trace
echo 1 > /sys/kernel/tracing/events/kvm/kvm_exit/enable
cat /sys/kernel/tracing/trace_pipe
# qemu-1234 [002] kvm_exit: reason EPT_VIOLATION rip 0xffffffff81234567 ...

# kvm_mmio tracepoint: MMIO emulation events
echo 1 > /sys/kernel/tracing/events/kvm/kvm_mmio/enable

# kvm_pio tracepoint: port I/O events
echo 1 > /sys/kernel/tracing/events/kvm/kvm_pio/enable
```

Key performance guidelines:

- **MMIO exits**: use in-kernel emulation (APIC, IOAPIC) or virtio (which batches kicks) to reduce frequency.
- **MSR exits**: tune the MSR bitmap to pass-through frequently-read MSRs.
- **PIO exits**: COM1 serial at boot is a common source; disable serial console in production VMs.
- **EPT violations at startup**: normal — the working set pages in over the first few seconds.

## Further reading

### Kernel source

- [arch/x86/kvm/x86.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/x86.c) — `vcpu_enter_guest()`: the per-exit dispatch loop; `kvm_fast_pio()`: the in-kernel port I/O fast path; `kvm_get_msr()`/`kvm_set_msr()`: MSR read/write dispatch
- [arch/x86/kvm/vmx/vmx.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/vmx/vmx.c) — `vmx_exit_handlers[]`: the VMX exit-reason dispatch table; `handle_io()`, `handle_ept_violation()`, `handle_exception_nmi()`
- [arch/x86/kvm/svm/svm.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/svm/svm.c) — `svm_exit_handlers[]`: AMD SVM's equivalent exit-reason table, indexed by the VMCB `EXITCODE` field
- [arch/x86/kvm/mmu/mmu.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/mmu/mmu.c) — `kvm_mmu_page_fault()`: distinguishes a missing EPT mapping, an MMIO region, and a permission fault
- [arch/x86/kvm/cpuid.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/cpuid.c) — `kvm_emulate_cpuid()`: CPUID leaf lookup and feature-bit filtering
- [arch/x86/kvm/emulate.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/emulate.c) — `x86_emulate_insn()`: the instruction emulator invoked for MMIO and string I/O
- [virt/kvm/kvm_main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/virt/kvm/kvm_main.c) — `kvm_vcpu_block()`/`kvm_vcpu_kick()`: HLT-driven vCPU sleep and wake
- [virt/kvm/irqchip.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/virt/kvm/irqchip.c) — `kvm_set_irq()` and the GSI routing table used to deliver device interrupts
- [arch/x86/kvm/lapic.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/lapic.c) — in-kernel local APIC emulation
- [arch/x86/kvm/ioapic.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/ioapic.c) — in-kernel IOAPIC emulation
- [arch/x86/kvm/i8254.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/i8254.c) — in-kernel PIT (8254 timer) emulation
- [include/uapi/linux/kvm.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/kvm.h) — `struct kvm_run`, `KVM_EXIT_IO`, `KVM_EXIT_MMIO`: the userspace-visible exit ABI

### Related pages

- [KVM Architecture](kvm-arch.md) — vCPU lifecycle, VMCS, KVM ioctls
- [Memory Virtualization](kvm-memory.md) — EPT, shadow paging, MMU notifiers
- [Nested Virtualization](nested-virt.md) — exit handling for L2 guests

### External

- [The Definitive KVM API Documentation](https://docs.kernel.org/virt/kvm/api.html) — `KVM_RUN`, `struct kvm_run`, and the `KVM_EXIT_IO`/`KVM_EXIT_MMIO` field layouts
- [KVM VCPU Requests](https://docs.kernel.org/virt/kvm/vcpu-requests.html) — the `KVM_REQ_*` flag mechanism processed at the top of `vcpu_enter_guest()`
