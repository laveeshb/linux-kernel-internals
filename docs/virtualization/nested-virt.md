# Nested Virtualization

> Running a hypervisor inside a VM: L0, L1, L2, and the vmcs12

## Terminology

Nested virtualization adds a second layer to the usual host/guest split:

```
L0: The real hardware host, running Linux + KVM
    (the "true" hypervisor — sees real VMCS, real EPT)

L1: A virtual machine running its own hypervisor (e.g., another KVM, Hyper-V, VMware ESXi)
    (thinks it owns the hardware; executes VMLAUNCH/VMRESUME)

L2: A virtual machine created by L1
    (nested guest — two levels of virtualization deep)
```

Without nested virtualization support, L1's attempt to execute `VMLAUNCH` would cause a `#UD` (undefined instruction) or a `#GP` (general protection fault) because the guest is not in VMX root mode. KVM nested virtualization makes `VMLAUNCH` and related instructions work from inside L1.

Enabling nested virtualization:

```bash
# Intel
modprobe kvm-intel nested=1
# or permanently:
echo "options kvm-intel nested=1" > /etc/modprobe.d/kvm.conf

# AMD
modprobe kvm-amd nested=1

# Verify the feature is exposed to L1
cat /sys/module/kvm_intel/parameters/nested   # Y
grep -m1 vmx /proc/cpuinfo                    # vmx flag visible inside L1 guest
```

## The problem: L1 executes VMLAUNCH

When KVM creates L1, it exposes the `vmx` CPUID flag so L1 believes it has VT-x. L1 can execute `VMPTRLD`, `VMWRITE`, `VMLAUNCH`, and `VMRESUME`. On real hardware these are privileged instructions only available in VMX root mode. L1 is running in VMX non-root mode — so they all cause VM exits to L0.

L0 must respond to each of these exits by emulating what the hardware would do if L1 were a real hypervisor:

| L1 instruction | Exit to L0 | L0 action |
|---------------|-----------|-----------|
| `VMXON` | `EXIT_REASON_VMXON` | `handle_vmxon()` — enable nested VMX state for this vCPU |
| `VMPTRLD` (set current VMCS) | `EXIT_REASON_VMPTRLD` | `handle_vmptrld()` — record which vmcs12 L1 is working with |
| `VMWRITE` | `EXIT_REASON_VMWRITE` | `handle_vmwrite()` — write field to vmcs12 in memory |
| `VMREAD` | `EXIT_REASON_VMREAD` | `handle_vmread()` — read field from vmcs12 in memory |
| `VMLAUNCH` | `EXIT_REASON_VMLAUNCH` | `handle_vmlaunch()` → `nested_vmx_run()` — synthesize L2 entry |
| `VMRESUME` | `EXIT_REASON_VMRESUME` | `handle_vmresume()` → `nested_vmx_run()` — re-enter L2 |
| `VMXOFF` | `EXIT_REASON_VMXOFF` | `handle_vmxoff()` — disable nested VMX state |

All of the above handlers live in `arch/x86/kvm/vmx/nested.c`.

## struct vmcs12: L1's view of the VMCS

L0 keeps an in-memory copy of what L1 believes the VMCS contains. This is `struct vmcs12`, defined in `arch/x86/kvm/vmx/vmcs12.h`:

```c
/* arch/x86/kvm/vmx/vmcs12.h (selected fields) */
struct vmcs12 {
    /* Header — must match the hardware VMCS revision identifier */
    u32 revision_id;
    u32 abort;            /* VM-entry abort indicator */

    /* Guest state area: what L1 puts here is L2's state */
    u64 guest_cr0, guest_cr3, guest_cr4;
    u64 guest_rsp, guest_rip, guest_rflags;
    u64 guest_ia32_efer;
    u16 guest_cs_selector, guest_ss_selector;
    /* ... all segment registers, descriptor table regs ... */

    /* Host state area: where L1 wants to return after L2 exits */
    u64 host_cr0, host_cr3, host_cr4;
    u64 host_rsp, host_rip;
    u64 host_ia32_efer;

    /* Control fields: what L1 wants to intercept for L2 */
    u32 pin_based_vm_exec_control;
    u32 cpu_based_vm_exec_control;
    u32 secondary_vm_exec_control;
    u64 ept_pointer;          /* L1's EPT for L2 (GPA → L1 HPA mapping) */
    u64 msr_bitmap;           /* L1's MSR bitmap for L2 */

    /* Exit/entry info: filled by L0 when synthesizing exits to L1 */
    u32 vm_exit_reason;
    u64 exit_qualification;
    u64 guest_physical_address;  /* GPA that caused EPT violation */
    u32 vm_instruction_error;
    /* ... */
};
```

L0 allocates one `struct vmcs12` per L1 vCPU and stores a pointer in `struct vcpu_vmx.nested.cached_vmcs12` (in `arch/x86/kvm/vmx/vmx.h`). When L1 executes `VMREAD`/`VMWRITE`, L0 reads/writes fields of this in-memory structure rather than touching a real VMCS.

## The merge: vmcs01 + vmcs12 = vmcs02

L0 has its own VMCS for running L1 — call it **vmcs01**. When L1 launches L2, L0 cannot simply use L1's vmcs12 as-is, because:

- vmcs12 describes L2's state in L1's terms (L1 HPAs may be L0 GPAs).
- L0 needs to add its own controls (e.g., L0's own EPT pointer, L0's MSR bitmaps).

Instead, L0 creates **vmcs02**: a real VMCS that merges L1's intent with L0's requirements.

```
vmcs01 (L0 → L1):        vmcs12 (L1's intent for L2):     vmcs02 (L0 → L2 on real hardware):
  L0's EPT for L1           L1's EPT for L2                  Two-level EPT (nested EPT)
  L0's MSR bitmap           L1's MSR bitmap                  Union of both bitmaps
  L0 host state             L1 host state (= L2 exit target) L0 host state
  L1 guest state            L2 guest state                   L2 guest state
```

The merge is performed via `nested_vmx_run()` → `prepare_vmcs02()` in `arch/x86/kvm/vmx/nested.c`:

```c
/* arch/x86/kvm/vmx/nested.c (simplified) */
static int prepare_vmcs02(struct kvm_vcpu *vcpu, struct vmcs12 *vmcs12,
                           bool from_vmentry, enum vm_entry_failure_code *entry_failure_code)
{
    struct vcpu_vmx *vmx = to_vmx(vcpu);

    /* Load L2 guest state from vmcs12 into vmcs02 */
    vmcs_write64(GUEST_RIP,    vmcs12->guest_rip);
    vmcs_write64(GUEST_RSP,    vmcs12->guest_rsp);
    vmcs_write64(GUEST_CR0,    vmcs12->guest_cr0);
    vmcs_write64(GUEST_CR3,    vmcs12->guest_cr3);
    /* ... all guest state fields ... */

    /* Merge control fields: union of what L0 and L1 want to intercept */
    vmcs_write32(PIN_BASED_VM_EXEC_CONTROL,
        vmcs12->pin_based_vm_exec_control |
        vmx->nested.msrs.pinbased_ctls_fixed1);

    /*
     * EPT: if L1 enabled EPT for L2, set up the two-level walk.
     * L2 GPA → L1 HPA (via vmcs12->ept_pointer)
     * L1 HPA is actually L0 GPA → L0 HPA (via vmcs01's EPT)
     * Hardware walks both levels on each L2 memory access.
     */
    if (nested_vmx_ept_enabled(vmcs12))
        vmcs_write64(EPT_POINTER, vmx->nested.ept_pointer);
    else
        /* Shadow paging fallback for L2 */
        ;

    return 0;
}
```

## L2 exit handling: who handles what?

When L2 causes a VM exit, the exit first arrives at L0 (hardware always exits to the true host). L0 must decide:

1. **L0 handles it**: the exit is caused by L0's own interception (e.g., L0's EPT violation for memory not yet mapped in L0's EPT). L0 handles it and re-enters L2 without L1 ever seeing it.
2. **L1 should handle it**: the exit matches a condition in vmcs12's control fields that L1 configured. L0 synthesizes a vmexit to L1.

```c
/* arch/x86/kvm/vmx/nested.c */
static int vmx_check_nested_events(struct kvm_vcpu *vcpu)
{
    /* Determine if a pending event should be injected to L2
       or cause a synthetic exit to L1 */
    ...
}

static bool nested_vmx_reflect_vmexit(struct kvm_vcpu *vcpu)
{
    /*
     * Returns true if this exit should be "reflected" (forwarded) to L1.
     * Decision is based on vmcs12's execution controls.
     *
     * Examples:
     *   EXIT_REASON_CPUID  → always reflected if L1 set CPU_BASED_CPUID_EXITING
     *   EXIT_REASON_IO     → reflected if the I/O port is in L1's I/O bitmap
     *   EXIT_REASON_EPT_VIOLATION → reflected if L1 enabled EPT for L2
     */
    ...
}
```

When L0 decides to reflect the exit to L1:

```c
/* Synthesize the vmexit: fill vmcs12 exit fields, restore L1 state */
static void nested_vmx_vmexit(struct kvm_vcpu *vcpu, u32 exit_reason,
                               u32 exit_intr_info, unsigned long exit_qualification)
{
    struct vmcs12 *vmcs12 = get_vmcs12(vcpu);

    /* Write exit information into vmcs12 so L1 can read it via VMREAD */
    vmcs12->vm_exit_reason        = exit_reason;
    vmcs12->exit_qualification    = exit_qualification;
    vmcs12->vm_exit_intr_info     = exit_intr_info;
    vmcs12->guest_rip             = kvm_rip_read(vcpu); /* L2's RIP at exit */
    vmcs12->guest_physical_address = vmcs_read64(GUEST_PHYSICAL_ADDRESS);

    /* Switch from vmcs02 back to vmcs01 (restore L1 as the active guest) */
    vmx->loaded_vmcs = &vmx->vmcs01;
    vmcs_load(vmx->loaded_vmcs->vmcs);

    /* Restore L1 host (= L0 guest) state from vmcs12->host_* fields */
    /* L1 will resume at vmcs12->host_rip (its vmexit handler) */
}
```

## AMD-V nested virtualization

AMD uses the VMCB (Virtual Machine Control Block) instead of the VMCS. The nested analogs are:

| Intel (VMX) | AMD (SVM) |
|------------|-----------|
| `struct vmcs12` | `struct vmcb` pointed to by `nested.vmcb12` |
| `prepare_vmcs02()` | `nested_svm_vmrun()` in `arch/x86/kvm/svm/nested.c` |
| vmcs02 | vmcb02 — the merged VMCB used to run L2 |
| Two-level EPT | Two-level NPT (nested page tables) |
| `VMLAUNCH`/`VMRESUME` | `VMRUN` |
| `VMPTRLD`/`VMREAD`/`VMWRITE` | `VMSAVE`/`VMLOAD` |

AMD's approach is conceptually identical: L1 executes `VMRUN` which exits to L0; L0 merges L1's VMCB (vmcb12) with its own (vmcb01) to produce vmcb02 and loads that to run L2 on real hardware.

## Two-level EPT: the performance cost

The most significant performance impact of nested virtualization comes from memory address translation. In the non-nested case, a guest memory access requires a single EPT walk (4 levels of page table for GPA → HPA). With nesting:

```
L2 GVA → L2 GPA:   L2's own page tables (4 levels)  ← each entry is a GPA
L2 GPA → L1 HPA:   L1's EPT (vmcs12->ept_pointer)   ← 4 levels, each entry GPA walks L0 EPT
L1 HPA = L0 GPA → L0 HPA: L0's EPT (vmcs01's EPT)   ← 4 levels

Worst case EPT walk: 4 × (4+1) + (4+1) = 25 memory accesses per TLB miss
Non-nested EPT walk: (4+1) = 5 memory accesses per TLB miss
```

Hardware vendors have optimized this (Intel's "EPT with shadow" elimination via tagged TLBs, VPID), but the fundamental overhead remains. Measurements show nested KVM typically runs 10–20% slower than non-nested for CPU-bound workloads, and more for memory-intensive or I/O-heavy workloads.

## KVM_CAP_NESTED_STATE: migrating nested guests

A VM that is itself running a hypervisor (L1) requires saving the nested VMX/SVM state for live migration. The state includes vmcs12, vmcb12, and related control structures.

```c
/* Check nested state size */
int size = ioctl(vcpu_fd, KVM_CHECK_EXTENSION, KVM_CAP_NESTED_STATE);

/* Get nested state */
struct kvm_nested_state *state = malloc(size);
state->size = size;
ioctl(vcpu_fd, KVM_GET_NESTED_STATE, state);
/* state->format distinguishes VMX from SVM; followed by vmcs12 data, etc. */

/* Restore on destination */
ioctl(vcpu_fd, KVM_SET_NESTED_STATE, state);
```

`struct kvm_nested_state` is defined in `arch/x86/include/uapi/asm/kvm.h`. The `format` field distinguishes VMX (`KVM_STATE_NESTED_FORMAT_VMX`) from SVM (`KVM_STATE_NESTED_FORMAT_SVM`). The variable-length data following the header contains the vmcs12/vmcb12 content and any shadow VMCS.

## Observing nested virtualization

```bash
# Confirm L2 is running (inside L1 guest)
cat /proc/cpuinfo | grep hypervisor   # hypervisor flag present in L2

# L0: see that nested exits are happening
echo 1 > /sys/kernel/tracing/events/kvm/kvm_nested_vmexit/enable
echo 1 > /sys/kernel/tracing/events/kvm/kvm_nested_vmentry/enable
cat /sys/kernel/tracing/trace_pipe
# qemu-1234 [000] kvm_nested_vmentry: rip=0xffffffff81234567
# qemu-1234 [000] kvm_nested_vmexit: reason=EXIT_REASON_EPT_VIOLATION ...

# perf: compare exit rates nested vs non-nested
perf kvm stat report   # look for elevated EPT_VIOLATION, VMLAUNCH/VMRESUME counts

# L0 debugfs: nested-specific counters
cat /sys/kernel/debug/kvm/*/nested_run_pending
cat /sys/kernel/debug/kvm/*/l1_set_tpr

# Module parameter (read-only after boot; set at load time)
cat /sys/module/kvm_intel/parameters/nested   # Y or N
cat /sys/module/kvm_amd/parameters/nested     # 1 or 0
```

## Security considerations

Nested virtualization exposes a large attack surface. L1 can craft arbitrary VMCS/VMCB values and attempt to confuse L0:

- **vmcs12 field validation**: `nested_vmx_check_controls()`, `nested_vmx_check_host_state()`, and `nested_vmx_check_guest_state()` validate all vmcs12 control and state fields before entering L2. Invalid combinations cause `VM_FAIL` with `VM_INSTRUCTION_ERROR` set, matching hardware behavior.
- **EPT pointer sanity**: L0 verifies `vmcs12->ept_pointer` alignment and reserved bits.
- **Spectre/Meltdown mitigations**: L0 must flush branch predictor state on L2 → L1 → L0 transitions to prevent L2 from influencing L0's branch prediction through L1.

## Further reading

### Kernel source

- [arch/x86/kvm/vmx/nested.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/vmx/nested.c) — Intel nested VMX: `handle_vmxon()`, `handle_vmptrld()`, `handle_vmlaunch()`/`handle_vmresume()` → `nested_vmx_run()`, `prepare_vmcs02()`, `vmx_check_nested_events()`, `nested_vmx_reflect_vmexit()`, `nested_vmx_vmexit()`
- [arch/x86/kvm/vmx/vmcs12.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/vmx/vmcs12.h) — `struct vmcs12` definition, L1's view of the VMCS for L2
- [arch/x86/kvm/svm/nested.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/svm/nested.c) — AMD nested SVM: `nested_svm_vmrun()`, the vmcb02 merge (SVM's analog of `prepare_vmcs02()`)
- [include/uapi/linux/kvm.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/kvm.h) — `KVM_GET_NESTED_STATE`/`KVM_SET_NESTED_STATE` ioctl definitions and `KVM_CAP_NESTED_STATE`
- [arch/x86/include/uapi/asm/kvm.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/uapi/asm/kvm.h) — `struct kvm_nested_state` and the `KVM_STATE_NESTED_FORMAT_VMX`/`KVM_STATE_NESTED_FORMAT_SVM` format constants

### Related pages

- [KVM Architecture](kvm-arch.md) — VMCS structure, vCPU run loop
- [KVM Exit Handling](kvm-exits.md) — exit dispatch table, exit reason handling
- [Live Migration](live-migration.md) — `KVM_GET_NESTED_STATE` for migrating L1 hypervisors
- [Memory Virtualization](kvm-memory.md) — EPT/NPT, two-level page table walking

### External

- [Nested VMX](https://docs.kernel.org/virt/kvm/x86/nested-vmx.html) — kernel documentation for Intel nested VMX: the L0/L1/L2 model, vmcs01/vmcs12/vmcs02, and the full `struct vmcs12` field layout
- [KVM API docs: `KVM_GET_NESTED_STATE`/`KVM_SET_NESTED_STATE`](https://docs.kernel.org/virt/kvm/api.html#kvm-get-nested-state) — the `struct kvm_nested_state` layout and `KVM_CAP_NESTED_STATE` used for live migration of nested guests
