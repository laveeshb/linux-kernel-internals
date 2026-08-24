# KVM Exit Handling

> What happens when a guest faults: exit reasons, I/O emulation, and MMIO

## The vcpu_run loop

Every KVM vCPU runs in a tight loop inside `kvm_arch_vcpu_ioctl_run()` in `arch/x86/kvm/x86.c`. The loop enters the guest, hardware runs the guest until something requires hypervisor intervention (a VM exit), then KVM dispatches that exit to the appropriate handler.

```
kvm_arch_vcpu_ioctl_run()          arch/x86/kvm/x86.c
  └── vcpu_run()
        └── vcpu_enter_guest()
              ├── kvm_x86_call(prepare_switch_to_guest)(vcpu)
              ├── VMLAUNCH / VMRESUME  ← hardware runs guest here
              │       (guest executes at near-native speed)
              │
              │   [VM exit fires — hardware saves guest state to VMCS]
              │
              ├── kvm_x86_call(handle_exit_irqoff)(vcpu)   (interrupts still off)
              │
              └── kvm_x86_call(handle_exit)(vcpu, exit_fastpath)
                    └── kvm_vmx_exit_handlers[exit_reason](vcpu)
                          returns 1 → resume guest
                          returns 0 → exit to userspace VMM
```

The key contract: a handler returning `1` means KVM can re-enter the guest immediately. Returning `0` or a negative error means `KVM_RUN` ioctl returns to userspace, which inspects `struct kvm_run` to learn what happened.

### vcpu_enter_guest internals

Before entering the guest on each iteration, `vcpu_enter_guest()` processes any pending work:

```c
/* arch/x86/kvm/x86.c (simplified) */
static int vcpu_enter_guest(struct kvm_vcpu *vcpu)
{
    fastpath_t exit_fastpath;
    u64 run_flags = 0;   /* KVM_RUN_FORCE_IMMEDIATE_EXIT, KVM_RUN_LOAD_GUEST_DR6,
                           * KVM_RUN_LOAD_DEBUGCTL — built up from pending-exit,
                           * debug-register, and debugctl state; omitted here */

    /* Process pending requests: TLB flushes, MMU reloads, etc. */
    if (kvm_check_request(KVM_REQ_MMU_SYNC, vcpu))
        kvm_mmu_sync_roots(vcpu);
    if (kvm_check_request(KVM_REQ_TLB_FLUSH, vcpu))
        kvm_vcpu_flush_tlb_all(vcpu);
    /* ... other KVM_REQ_* flags ... */

    /* Inject a pending interrupt (if any) before entering */
    if (kvm_cpu_has_injectable_intr(vcpu))
        kvm_x86_call(inject_irq)(vcpu, false /* reinjected */);

    /* Disable preemption, switch to guest CR3, enter VMX non-root */
    exit_fastpath = kvm_x86_call(vcpu_run)(vcpu, run_flags);  /* VMLAUNCH or VMRESUME */

    /*
     * We are back — VM exit occurred. handle_exit_irqoff() does minimal
     * work with interrupts still disabled (e.g. #NM handling); it doesn't
     * return anything — exit_fastpath came from the vcpu_run() call above.
     */
    kvm_x86_call(handle_exit_irqoff)(vcpu);

    /* ... re-enable interrupts/preemption, account guest time, etc ... */

    return kvm_x86_call(handle_exit)(vcpu, exit_fastpath);
}
```

## Exit reason dispatch

On Intel, the exit reason is stored in the VMCS `VM_EXIT_REASON` field. `vmx_get_exit_reason(vcpu)` reads it (from a per-vCPU VMX field, not `vcpu->arch`) into a `union vmx_exit_reason`, and the low bits (`.basic`) index into `kvm_vmx_exit_handlers[]`:

```c
/* arch/x86/kvm/vmx/vmx.c */
static int (*kvm_vmx_exit_handlers[])(struct kvm_vcpu *vcpu) = {
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
    [EXIT_REASON_VMCALL]            = kvm_emulate_hypercall,
    [EXIT_REASON_APIC_ACCESS]       = handle_apic_access,
    /* ... ~50 total handlers ... */
};

static int __vmx_handle_exit(struct kvm_vcpu *vcpu,
                              fastpath_t exit_fastpath)
{
    struct vcpu_vmx *vmx = to_vmx(vcpu);
    union vmx_exit_reason exit_reason = vmx_get_exit_reason(vcpu);

    /* If guest state is invalid (e.g. after a bad VM entry), emulate
     * instead of dispatching through the table below: */
    if (vmx->vt.emulation_required)
        return handle_invalid_guest_state(vcpu);

    /* ... failed-entry and event-vectoring checks omitted ... */

    if (exit_reason.basic >= kvm_vmx_max_exit_handlers ||
        !kvm_vmx_exit_handlers[exit_reason.basic]) {
        /* Unrecognized exit reason: dump state, exit to userspace */
        dump_vmcs(vcpu);
        kvm_prepare_unexpected_reason_exit(vcpu, exit_reason.full);
        return 0;
    }

    return kvm_vmx_exit_handlers[exit_reason.basic](vcpu);
}
```

`__vmx_handle_exit()` does the actual dispatch; the entry point reached via `kvm_x86_call(handle_exit)` is a thin `vmx_handle_exit()` wrapper around it that also checks for a detected bus lock (`KVM_EXIT_X86_BUS_LOCK`).

AMD SVM follows the same pattern with `svm_exit_handlers[]` in `arch/x86/kvm/svm/svm.c`, indexed by the `EXITCODE` field in the VMCB.

## Common exit reasons

### EXIT_REASON_IO_INSTRUCTION — port I/O

Port I/O instructions (`in`/`out`) exit by default; the per-VMCS I/O bitmap can be configured to let specific ports run without exiting at all. Of the ports that do exit, the fast path handles simple cases in-kernel; the slow path (string I/O) falls back to full instruction emulation.

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

    return kvm_fast_pio(vcpu, size, port, in);
}
```

`kvm_fast_pio()` (in `arch/x86/kvm/x86.c`) hands off to `kvm_fast_pio_in()`/`kvm_fast_pio_out()`, which go through the emulator's `emulator_pio_in()`/`emulator_pio_out()` path. That path tries in-kernel device emulation via the `kvm_io_bus` dispatch table first; if no in-kernel device owns the port, it fills `kvm_run` and returns `0`:

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
/* arch/x86/kvm/vmx/vmx.c — handle_ept_violation() with its
 * __vmx_handle_ept_violation() helper folded in, simplified */
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
/* virt/kvm/kvm_main.c, simplified */
bool kvm_vcpu_block(struct kvm_vcpu *vcpu)
{
    struct rcuwait *wait = kvm_arch_vcpu_get_wait(vcpu);  /* &vcpu->wait, generically */
    bool waited = false;

    kvm_arch_vcpu_blocking(vcpu);
    prepare_to_rcuwait(wait);

    for (;;) {
        set_current_state(TASK_INTERRUPTIBLE);
        if (kvm_vcpu_check_block(vcpu) < 0)
            break;          /* runnable again, or has other pending work */
        waited = true;
        schedule();
    }

    finish_rcuwait(wait);
    kvm_arch_vcpu_unblocking(vcpu);
    return waited;          /* did we actually sleep, or was there work already? */
}
```

The vCPU thread sleeps until `kvm_vcpu_kick()` wakes it — typically because a virtual interrupt arrived.

### EXIT_REASON_MSR_READ / MSR_WRITE

MSR accesses can be made cheap with the **MSR bitmap**: a 4KB page (pointed to by the VMCS's `MSR_BITMAP` field, not embedded in the VMCS itself) where each bit controls whether a specific MSR causes a VM exit. Frequently-read MSRs like `IA32_TSC` or `IA32_SYSENTER_EIP` can be pass-through (no exit). For intercepted MSRs, KVM dispatches to `kvm_emulate_rdmsr()` or `kvm_emulate_wrmsr()` (in `arch/x86/kvm/x86.c`), which uses switch-based per-MSR dispatch inside `__kvm_get_msr()` / `__kvm_set_msr()`.

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
  4. kvm_mmu_page_fault() calls x86_emulate_instruction() to decode and
     execute the faulting instruction (uses struct x86_emulate_ops to
     fetch instruction bytes from guest)
  5. The emulator's write-emulated callback reaches vcpu_mmio_write(),
     which dispatches the actual write:
     ├── in-kernel local APIC — checked directly (vcpu->arch.apic->dev),
     │   not via the generic kvm_io_bus
     │     hit: handled in-kernel, resume guest (return 1)
     └── miss → kvm_io_bus_write(KVM_MMIO_BUS, ...) — other in-kernel
           devices (e.g. IOAPIC), matched by registered GPA range
           ├── hit: handled in-kernel, resume guest (return 1)
           └── miss: kvm_run.mmio filled; ioctl returns to userspace
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

For a guest **read**: userspace (e.g. QEMU) fills `kvm_run.mmio.data` with the device register value, then re-enters KVM via `KVM_RUN`. KVM completes the emulated instruction by writing the data into the guest register.

For a guest **write**: userspace reads `kvm_run.mmio.data` and forwards it to its device model.

### KVM in-kernel devices

Several devices are emulated entirely in-kernel to avoid the round-trip to userspace:

| Device | In-kernel emulation | Registration |
|--------|---------------------|---------------|
| Local APIC | `arch/x86/kvm/lapic.c` | Checked directly (`vcpu->arch.apic->dev`) ahead of the generic bus — not registered via `kvm_io_bus_register_dev()` |
| IOAPIC | `arch/x86/kvm/ioapic.c` | `kvm_io_bus_register_dev(kvm, KVM_MMIO_BUS, ...)`, matched by GPA range |
| PIT (8254 timer) | `arch/x86/kvm/i8254.c` | `kvm_io_bus_register_dev(kvm, KVM_PIO_BUS, ...)` — legacy port I/O (ports 0x40-0x43, 0x61), not MMIO |

Only IOAPIC (and other genuine MMIO devices) go through the generic `kvm_io_bus` GPA-range lookup; the Local APIC is special-cased ahead of it, and the PIT is reached via the separate port-I/O bus, not MMIO at all.

## Interrupt injection

Interrupts to guest vCPUs do not arrive via normal hardware interrupt lines. KVM manages virtual interrupt delivery:

```c
/* virt/kvm/kvm_main.c — __kvm_vcpu_kick(), simplified.
 * kvm_vcpu_kick(vcpu) is a thin inline wrapper: __kvm_vcpu_kick(vcpu, false). */
void __kvm_vcpu_kick(struct kvm_vcpu *vcpu, bool wait)
{
    int me, cpu;

    /* Wake it first: if it was blocking (e.g. in HLT), waking it is enough —
     * no IPI needed since it wasn't running on a pCPU. */
    if (kvm_vcpu_wake_up(vcpu))
        return;

    me = get_cpu();

    /* Kicking your own vCPU from its own thread (e.g. a self-IPI-style
     * event): just flip the mode flag it polls, no actual IPI needed. */
    if (vcpu == __this_cpu_read(kvm_running_vcpu)) {
        if (vcpu->mode == IN_GUEST_MODE)
            WRITE_ONCE(vcpu->mode, EXITING_GUEST_MODE);
        goto out;
    }

    /* Otherwise it's running on some other pCPU: send an IPI to force a
     * VM exit so it notices pending work. */
    if (kvm_arch_vcpu_should_kick(vcpu)) {
        cpu = READ_ONCE(vcpu->cpu);   /* -1 if not currently loaded */
        if (cpu != me && (unsigned int)cpu < nr_cpu_ids && cpu_online(cpu))
            smp_send_reschedule(cpu);
    }
out:
    put_cpu();
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
- **Posted interrupts**: the CPU delivers virtual interrupts directly to the guest without a VM exit, tracked via a per-vCPU posted-interrupt descriptor (`struct pi_desc`).

## Performance: measuring exits

VM exits are the primary source of KVM overhead. Minimizing exit frequency and exit handling latency is the main performance lever.

```bash
# Per-VM directories in debugfs, one per VM: <creator-pid>-<vm-fd-name>
ls /sys/kernel/debug/kvm/
# 1234-3/   ...   (VM-level stat files live directly here)

# Each vCPU gets its own subdirectory, with one raw-counter file per stat
# (see kvm_vcpu_stats_desc[] in arch/x86/kvm/x86.c) — no single aggregate file:
ls /sys/kernel/debug/kvm/1234-3/vcpu0/
# exits  io_exits  mmio_exits  irq_window_exits  halt_exits  halt_wakeup  ...

cat /sys/kernel/debug/kvm/1234-3/vcpu0/exits
# 8473921
cat /sys/kernel/debug/kvm/1234-3/vcpu0/mmio_exits
# 340291

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

- [arch/x86/kvm/x86.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/x86.c) — `vcpu_enter_guest()`: the per-exit dispatch loop; `kvm_fast_pio()`: the in-kernel port I/O fast path; `kvm_emulate_rdmsr()`/`kvm_emulate_wrmsr()`: MSR read/write VM-exit dispatch
- [arch/x86/kvm/vmx/vmx.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/vmx/vmx.c) — `kvm_vmx_exit_handlers[]`: the VMX exit-reason dispatch table; `handle_io()`, `handle_ept_violation()`, `handle_exception_nmi()`
- [arch/x86/kvm/svm/svm.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/svm/svm.c) — `svm_exit_handlers[]`: AMD SVM's equivalent exit-reason table, indexed by the VMCB `EXITCODE` field
- [arch/x86/kvm/mmu/mmu.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/mmu/mmu.c) — `kvm_mmu_page_fault()`: distinguishes a missing EPT mapping, an MMIO region, and a permission fault
- [arch/x86/kvm/cpuid.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/cpuid.c) — `kvm_emulate_cpuid()`: CPUID leaf lookup and feature-bit filtering
- [arch/x86/kvm/emulate.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/emulate.c) — `x86_emulate_insn()`: the low-level decode-and-execute step invoked internally by `x86_emulate_instruction()` (in `x86.c`), the top-level entry point for MMIO and string I/O emulation; `vcpu_mmio_write()`/`vcpu_mmio_read()` (in `x86.c`) are the emulator callbacks that dispatch to the local APIC directly or fall back to `kvm_io_bus_write()`/`kvm_io_bus_read()`
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
