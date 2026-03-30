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

KVM exposes its functionality through ioctls on `/dev/kvm`, `/dev/kvm/<vm>`, and `/dev/kvm/<vm>/<vcpu>`:

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
KVM_EXIT_CPUID           /* cpuid instruction */
KVM_EXIT_FAIL_ENTRY      /* VM entry failed */
KVM_EXIT_EXCEPTION       /* exception in non-root mode */
KVM_EXIT_INTR            /* signal received while in KVM_RUN */
KVM_EXIT_SHUTDOWN        /* triple fault or machine check */
KVM_EXIT_SET_TPR         /* TPR (task priority register) write */
KVM_EXIT_TPR_ACCESS
KVM_EXIT_NMI             /* NMI */
KVM_EXIT_X86_RDMSR       /* RDMSR instruction */
KVM_EXIT_X86_WRMSR       /* WRMSR instruction */
KVM_EXIT_DIRTY_RING_FULL /* dirty page tracking ring full */
KVM_EXIT_AP_RESET_HOLD   /* multiprocessor boot */
```

Frequency matters: frequent exits (like timer ticks, MMIO) are costly because they require switching CPU state. Hardware features like APICv, posted interrupts, and EPT reduce exits.

## struct kvm and struct kvm_vcpu

```c
/* virt/kvm/kvm_main.c */
struct kvm {
    spinlock_t          mmu_lock;
    struct mutex        slots_lock;
    struct mutex        slots_arch_lock;

    struct mm_struct   *mm;          /* userspace VM process mm */
    unsigned long       nr_memslot_pages;
    struct kvm_memslots *memslots[KVM_ADDRESS_SPACE_NUM];

    struct kvm_vcpu    *vcpus[KVM_MAX_VCPUS];
    atomic_t            online_vcpus;
    int                 max_vcpus;
    int                 created_vcpus;

    struct list_head    vm_list;     /* link in kvm_list */
    struct mutex        lock;
    struct kvm_io_bus   *buses[KVM_NR_BUSES];
    struct kvm_irq_routing_table *irq_routing;
    struct hlist_head   irq_ack_notifier_list;

    /* Memory management */
    struct kvm_page_track_notifier_head *track_notifier_head;
    atomic64_t          arch_flags;

    struct kvm_arch     arch;        /* architecture-specific state */
};

struct kvm_vcpu {
    struct kvm         *kvm;
    int                 cpu;         /* physical CPU this vCPU ran on last */
    int                 vcpu_id;
    int                 vcpu_idx;

    int                 srcu_idx;
    int                 mode;        /* IN_GUEST_MODE, etc. */
    u64                 requests;    /* pending requests bitmask */
    unsigned long       guest_debug; /* debug flags */

    int                 pre_pcpu;
    struct list_head    blocked_vcpu_list;

    struct mutex        mutex;
    struct kvm_run     *run;         /* the mmap'd run structure */

    int                 guest_fpu_loaded;
    wait_queue_head_t   wq;          /* for blocking on halt */

    struct kvm_vcpu_arch arch;       /* x86/arm64-specific state */
    struct kvm_vcpu_stat stat;

    /* Dirty ring for tracking modified guest pages */
    struct kvm_dirty_ring dirty_ring;
};
```

## The vCPU run loop

```c
/* arch/x86/kvm/x86.c: kvm_arch_vcpu_ioctl_run() */
int kvm_arch_vcpu_ioctl_run(struct kvm_vcpu *vcpu)
{
    struct kvm_run *kvm_run = vcpu->run;

    while (1) {
        /* Process any pending work before entering guest */
        if (kvm_request_pending(vcpu)) {
            if (kvm_check_request(KVM_REQ_TLB_FLUSH, vcpu))
                kvm_flush_tlb(vcpu);
            /* ... handle other requests ... */
        }

        /* Inject interrupts if pending */
        if (vcpu->arch.interrupt.injected)
            vmx_inject_irq(vcpu);

        /* VM Entry */
        kvm_x86_ops.run(vcpu);   /* calls VMLAUNCH or VMRESUME */

        /* VM Exit: handle the reason */
        r = kvm_x86_ops.handle_exit(vcpu, exit_fastpath);

        if (r <= 0)
            break;  /* exit to userspace */

        /* Continue in-kernel: handle exits that don't need QEMU */
    }

    return r;
}
```

## Hypercalls: guest-to-host communication

```c
/* Guest: issue a hypercall */
/* On x86: vmcall (Intel) or vmmcall (AMD) */
static inline long kvm_hypercall(unsigned int nr, unsigned long p1,
                                  unsigned long p2, unsigned long p3,
                                  unsigned long p4)
{
    long ret;
    asm volatile("vmcall"
                 : "=a"(ret)
                 : "a"(nr), "b"(p1), "c"(p2), "d"(p3), "S"(p4)
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
# KVM stats per VM (requires debugfs)
ls /sys/kernel/debug/kvm/
# 42-0/  42-1/  ...  (vm_id-vcpu_id directories)

cat /sys/kernel/debug/kvm/42-0/exits
# Total: 12345678
# mmio: 23456
# io: 12345
# halt: 100
# irq_window: 5000

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

- [Memory Virtualization](kvm-memory.md) — EPT, shadow paging, balloon
- [virtio](virtio.md) — I/O paravirtualization
- [Memory Management: page tables](../mm/page-tables.md) — EPT builds on x86 paging
- `virt/kvm/` in the kernel tree — KVM core implementation
- `arch/x86/kvm/` — x86-specific KVM code
