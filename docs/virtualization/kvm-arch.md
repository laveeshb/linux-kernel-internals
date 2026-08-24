# KVM Architecture

> How the Linux kernel becomes a type-2 hypervisor

## Intel VT-x: hardware virtualization basics

Intel VT-x adds two new CPU operating modes:
- **VMX root mode**: where the hypervisor (KVM) runs — full privilege
- **VMX non-root mode**: where the guest OS runs — hardware-restricted

The critical data structure is the **VMCS** (Virtual Machine Control Structure) — a per-vCPU hardware structure that stores guest and host state and controls when VM exits happen.

```
Host CPU (ring 0)                    VMCS
    │                          ┌────────────────────┐
    │                          │ Guest state area:  │
    │  VMLAUNCH/VMRESUME ──────►  rip, rsp, cr3,    │
    │                          │  cs, es, tr, ...   │
    │  ◄─── VM Exit ──────────  ├────────────────────┤
    │                          │ Host state area:   │
    │                          │  (restored on exit)│
    │                          ├────────────────────┤
    │                          │ Control fields:    │
    │                          │  - exit reasons    │
    │                          │  - VMCS pointers   │
    │                          │  - MSR bitmaps     │
    │                          └────────────────────┘
```

## The /dev/kvm API

KVM exposes its functionality through ioctls on `/dev/kvm` and on the anonymous file descriptors returned by `KVM_CREATE_VM` and `KVM_CREATE_VCPU`:

```c
#include <linux/kvm.h>
#include <sys/ioctl.h>

/* Step 1: Open the KVM API */
int kvm_fd = open("/dev/kvm", O_RDWR);

/* Step 2: Create a VM */
int vm_fd = ioctl(kvm_fd, KVM_CREATE_VM, 0);

/* Step 3: Set up memory */
struct kvm_userspace_memory_region region = {
    .slot            = 0,
    .guest_phys_addr = 0x0,      /* guest physical address */
    .memory_size     = 0x100000, /* 1MB */
    .userspace_addr  = (uint64_t)mmap(NULL, 0x100000,
                                       PROT_READ|PROT_WRITE,
                                       MAP_PRIVATE|MAP_ANONYMOUS, -1, 0),
};
ioctl(vm_fd, KVM_SET_USER_MEMORY_REGION, &region);

/* Step 4: Create a vCPU */
int vcpu_fd = ioctl(vm_fd, KVM_CREATE_VCPU, 0);

/* Step 5: Map the vCPU run structure */
int vcpu_mmap_size = ioctl(kvm_fd, KVM_GET_VCPU_MMAP_SIZE, 0);
struct kvm_run *run = mmap(NULL, vcpu_mmap_size,
                           PROT_READ|PROT_WRITE, MAP_SHARED, vcpu_fd, 0);

/* Step 6: Set initial vCPU state (registers) */
struct kvm_regs regs = { .rip = 0x0, .rsp = 0x10000, .rflags = 0x2 };
ioctl(vcpu_fd, KVM_SET_REGS, &regs);

/* Step 7: Run the vCPU */
while (1) {
    ioctl(vcpu_fd, KVM_RUN, 0);  /* enters VMX non-root mode */

    switch (run->exit_reason) {
    case KVM_EXIT_HLT:
        printf("Guest halted\n");
        return 0;
    case KVM_EXIT_IO:
        /* Guest did I/O (in/out instruction) */
        handle_io(run);
        break;
    case KVM_EXIT_MMIO:
        /* Guest accessed unmapped MMIO region */
        handle_mmio(run);
        break;
    case KVM_EXIT_INTERNAL_ERROR:
        fprintf(stderr, "KVM internal error\n");
        return 1;
    }
}
```

## VM exits and their causes

A VM exit returns control from guest to host. Common exit reasons:

```c
/* include/uapi/linux/kvm.h — exit reasons */
KVM_EXIT_IO              /* PMIO (in/out) instruction */
KVM_EXIT_MMIO            /* memory-mapped I/O */
KVM_EXIT_HYPERCALL       /* guest called hypercall (vmcall/vmmcall) */
KVM_EXIT_DEBUG           /* debug event */
KVM_EXIT_HLT             /* hlt instruction */
KVM_EXIT_FAIL_ENTRY      /* VM entry failed */
KVM_EXIT_INTR            /* signal received while in KVM_RUN */
KVM_EXIT_SHUTDOWN        /* triple fault or machine check */
KVM_EXIT_TPR_ACCESS      /* TPR (task priority register) access */
KVM_EXIT_X86_RDMSR       /* RDMSR instruction */
KVM_EXIT_X86_WRMSR       /* WRMSR instruction */
KVM_EXIT_DIRTY_RING_FULL /* dirty page tracking ring full */
KVM_EXIT_AP_RESET_HOLD   /* multiprocessor boot */
```

Frequency matters: frequent exits (like timer ticks, MMIO) are costly because they require switching CPU state. Hardware features like APICv, posted interrupts, and EPT reduce exits.

## struct kvm and struct kvm_vcpu

```c
/* Simplified — real struct kvm is defined in include/linux/kvm_host.h;
 * arch-specific state (including the page-track notifier head) lives in
 * the embedded struct kvm_arch, defined per-arch (e.g.
 * arch/x86/include/asm/kvm_host.h), not here. */
struct kvm {
    spinlock_t           mmu_lock;      /* rwlock_t instead, on archs with
                                            KVM_HAVE_MMU_RWLOCK */
    struct mutex         slots_lock;
    struct mutex         slots_arch_lock;

    struct mm_struct     *mm;            /* userspace tied to this vm */
    unsigned long        nr_memslot_pages;
    struct kvm_memslots  *memslots[KVM_MAX_NR_ADDRESS_SPACES];

    struct xarray        vcpu_array;     /* indexed by vcpu_idx, not a flat
                                             array — see vcpu_idx below */
    atomic_t             online_vcpus;
    int                  max_vcpus;
    int                  created_vcpus;

    struct list_head     vm_list;
    struct mutex         lock;
    struct kvm_io_bus    *buses[KVM_NR_BUSES];
    struct kvm_irq_routing_table *irq_routing;
    struct hlist_head    irq_ack_notifier_list;

    struct kvm_arch      arch;           /* architecture-specific state */
};

struct kvm_vcpu {
    struct kvm          *kvm;
    int                  cpu;         /* physical CPU currently loaded on;
                                          -1 if not loaded (see vcpu_load()/vcpu_put()) */
    int                  vcpu_id;     /* id given by userspace at creation */
    int                  vcpu_idx;    /* index into kvm->vcpu_array */

    int                  ____srcu_idx; /* don't use directly — the leading
                                           underscores are intentional */
    int                  mode;        /* IN_GUEST_MODE, etc. */
    u64                  requests;    /* pending requests bitmask */
    unsigned long        guest_debug; /* debug flags */

    struct mutex         mutex;
    struct kvm_run       *run;        /* the mmap'd run structure */

    struct rcuwait        wait;       /* for blocking on halt */

    struct kvm_vcpu_arch  arch;       /* x86/arm64-specific state */
    struct kvm_vcpu_stat  stat;

    /* Dirty ring for tracking modified guest pages */
    struct kvm_dirty_ring dirty_ring;
};
```

## The vCPU run loop

`kvm_arch_vcpu_ioctl_run()` — the direct handler for the `KVM_RUN` ioctl — mostly just validates state and hands off to `vcpu_run()`, which loops calling `vcpu_enter_guest()` once per guest entry/exit:

```c
/* arch/x86/kvm/x86.c: vcpu_enter_guest(), simplified */
static int vcpu_enter_guest(struct kvm_vcpu *vcpu)
{
    fastpath_t exit_fastpath;
    u64 run_flags = 0;   /* built up earlier from pending-exit, debug-register,
                          * and debugctl state; omitted here */
    int r;

    /* Process any pending work before entering guest */
    if (kvm_check_request(KVM_REQ_TLB_FLUSH, vcpu))
        kvm_vcpu_flush_tlb_all(vcpu);
    /* ... handle other requests ... */

    /* Inject interrupts if pending */
    if (kvm_cpu_has_injectable_intr(vcpu))
        kvm_x86_call(inject_irq)(vcpu, false /* reinjected */);

    /* VM Entry */
    exit_fastpath = kvm_x86_call(vcpu_run)(vcpu, run_flags);  /* VMLAUNCH/VMRESUME */

    /* VM Exit: handle the reason */
    r = kvm_x86_call(handle_exit)(vcpu, exit_fastpath);

    return r;
}
```

`kvm_x86_call(op)` is a macro wrapping a `static_call` into `struct kvm_x86_ops` — the vendor backend (VMX or SVM) plugs in via fields like `.vcpu_run`, `.handle_exit`, and `.inject_irq`. `vcpu_run()` repeats this per-entry work in a `for (;;)` loop until the exit reason needs userspace, at which point it returns up to `kvm_arch_vcpu_ioctl_run()`.

## Hypercalls: guest-to-host communication

```c
/* Guest: issue a hypercall */
/* On x86: vmcall (Intel) or vmmcall (AMD) */
/* arch/x86/include/asm/kvm_para.h defines one variant per argument count,
 * kvm_hypercall0() through kvm_hypercall4() — there's no single variadic
 * kvm_hypercall(). Zero-argument example: */
static inline long kvm_hypercall0(unsigned int nr)
{
    long ret;
    asm volatile("vmcall"
                 : "=a"(ret)
                 : "a"(nr)
                 : "memory");
    return ret;
}

/* KVM hypercall numbers (include/uapi/linux/kvm_para.h) */
KVM_HC_VAPIC_POLL_IRQ     /* poll for virtual APIC interrupt */
KVM_HC_MMU_OP             /* MMU operation */
KVM_HC_FEATURES           /* get KVM feature flags */
KVM_HC_PPC_MAP_MAGIC_PAGE /* PowerPC */
KVM_HC_KICK_CPU           /* kick another vCPU (IPI) */
KVM_HC_CLOCK_PAIRING      /* time synchronization */
KVM_HC_SEND_IPI           /* send IPI to bitmap of vCPUs */
KVM_HC_SCHED_YIELD        /* yield to another vCPU */
KVM_HC_MAP_GPA_RANGE      /* memory attribute notification */
```

## Observing KVM

```bash
# One directory per VM, named <creator-pid>-<vm-fd-name> (requires debugfs):
ls /sys/kernel/debug/kvm/
# 1234-3/   ...

# Each vCPU gets its own subdirectory; each stat gets its own file inside it
# (see kvm_vcpu_stats_desc[] in arch/x86/kvm/x86.c) — no aggregate "exits" file:
ls /sys/kernel/debug/kvm/1234-3/vcpu0/
# exits  io_exits  mmio_exits  halt_exits  irq_window_exits  nmi_window_exits  ...

cat /sys/kernel/debug/kvm/1234-3/vcpu0/exits
# 12345678

# perf KVM stats
perf kvm stat record -a sleep 10
perf kvm stat report

# KVM tracepoints
ls /sys/kernel/tracing/events/kvm/
echo 1 > /sys/kernel/tracing/events/kvm/kvm_exit/enable
cat /sys/kernel/tracing/trace_pipe
# bash-1234 [003] kvm_exit: reason EXTERNAL_INTERRUPT rip 0xffff...
```

## Further reading

### Kernel source

- [include/linux/kvm_host.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/kvm_host.h) — `struct kvm` and `struct kvm_vcpu` definitions
- [arch/x86/kvm/x86.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/x86.c) — `kvm_arch_vcpu_ioctl_run()`, `vcpu_run()`, and `vcpu_enter_guest()`: the vCPU run loop (request handling, VM entry, exit dispatch)
- [arch/x86/kvm/vmx/vmx.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kvm/vmx/vmx.c) — Intel VT-x backend: VMLAUNCH/VMRESUME, `vmx_inject_irq(vcpu, bool reinjected)`, VMCS-based VM entry/exit
- [virt/kvm/kvm_main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/virt/kvm/kvm_main.c) — `/dev/kvm` core: `kvm_dev_ioctl()` handling `KVM_CREATE_VM`; `kvm_vm_ioctl()` handling `KVM_CREATE_VCPU` on the resulting VM fd
- [include/uapi/linux/kvm.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/kvm.h) — `KVM_EXIT_*` exit reason constants and the `kvm_run` ABI
- [include/uapi/linux/kvm_para.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/kvm_para.h) — `KVM_HC_*` hypercall numbers

### Related pages

- [Memory Virtualization](kvm-memory.md) — EPT, shadow paging, balloon
- [virtio](virtio.md) — I/O paravirtualization
- [Memory Management: page tables](../mm/page-tables.md) — EPT builds on x86 paging

### External

- [The KVM API](https://docs.kernel.org/virt/kvm/api.html) — official ioctl reference for `/dev/kvm`: `KVM_CREATE_VM`, `KVM_CREATE_VCPU`, `KVM_SET_USER_MEMORY_REGION`, `KVM_RUN`, and the `struct kvm_run` exit-reason union
- [KVM VCPU Requests](https://docs.kernel.org/virt/kvm/vcpu-requests.html) — the `vcpu->requests` bitmask mechanism (`kvm_check_request()`, `KVM_REQ_TLB_FLUSH`) used in the vCPU run loop
