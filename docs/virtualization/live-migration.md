# KVM Live Migration

> How running VMs are transferred between hosts with minimal downtime

## The goal

Live migration moves a running VM from one host to another while the VM continues executing. The VM is visible on the destination before the source stops — the handoff is invisible to guest workloads (or nearly so). The target: under 100 ms of guest-perceived pause.

The challenge is that the guest's RAM is being modified faster than it can be copied. Live migration solves this with a pre-copy phase that runs iteratively until the residual dirty set is small enough to transfer within the target downtime budget.

```
Source host                          Destination host
┌────────────────────────────┐       ┌────────────────────────────┐
│  QEMU + KVM (VM running)   │       │  QEMU + KVM (VM paused)    │
│                            │       │                            │
│  Phase 1: Pre-copy         │──RAM──►  Receiving pages           │
│  (VM still running,        │       │                            │
│   dirty pages tracked)     │       │                            │
│                            │       │                            │
│  Phase 2: Stop-and-copy    │──RAM──►  Remaining dirty pages     │
│  (VM paused)               │──CPU──►  vCPU register state       │
│                            │──DEV──►  Device state              │
│                            │       │                            │
│  Phase 3: Handoff          │       │  VM resumes here           │
│  (VM stopped on source)    │       │                            │
└────────────────────────────┘       └────────────────────────────┘
```

## KVM dirty page tracking

KVM provides two mechanisms to track which guest pages have been modified since the last checkpoint.

### Dirty log bitmap

Enable dirty tracking per memory slot with the `KVM_MEM_LOG_DIRTY_PAGES` flag:

```c
/* Set up a memory slot with dirty logging enabled */
struct kvm_userspace_memory_region region = {
    .slot            = 0,
    .flags           = KVM_MEM_LOG_DIRTY_PAGES,  /* enable dirty tracking */
    .guest_phys_addr = 0x0,
    .memory_size     = ram_size,
    .userspace_addr  = (uint64_t)ram_ptr,
};
ioctl(vm_fd, KVM_SET_USER_MEMORY_REGION, &region);
```

With dirty logging enabled, KVM write-protects all EPT/NPT leaf entries for the slot. On the first write to each page, an EPT violation exit fires; KVM records the page in the dirty bitmap and makes the mapping writable again. This adds one exit per first-write to each page per epoch.

Retrieve the dirty bitmap with `KVM_GET_DIRTY_LOG`:

```c
struct kvm_dirty_log dirty_log = {
    .slot        = 0,
    .dirty_bitmap = bitmap,  /* caller-allocated, size = num_pages / 8 bytes */
};
ioctl(vm_fd, KVM_GET_DIRTY_LOG, &dirty_log);
/* After this call, bitmap has one bit set per dirty page.
   KVM also clears all dirty bits and re-write-protects the pages. */
```

`KVM_CLEAR_DIRTY_LOG` (added in kernel 5.0) clears dirty bits for a specific range of pages rather than the entire slot, reducing the number of EPT write-protection flushes during iterative pre-copy:

```c
struct kvm_clear_dirty_log clear = {
    .slot        = 0,
    .num_pages   = pages_to_clear,
    .first_page  = page_offset,
    .dirty_bitmap = bitmap,
};
ioctl(vm_fd, KVM_CLEAR_DIRTY_LOG, &clear);
```

### Dirty ring (KVM_CAP_DIRTY_LOG_RING, kernel 5.11)

The ring buffer approach replaces polling a bitmap with a per-vCPU ring that records dirty GFNs in order:

```c
/* Check if dirty ring is supported */
int ring_size = ioctl(kvm_fd, KVM_CHECK_EXTENSION, KVM_CAP_DIRTY_LOG_RING);
/* ring_size: max entries per vCPU ring (power of two), 0 if unsupported */

/* Enable at VM creation time */
struct kvm_enable_cap cap = {
    .cap   = KVM_CAP_DIRTY_LOG_RING,
    .args  = { ring_size * sizeof(struct kvm_dirty_gfn) },
};
ioctl(vm_fd, KVM_ENABLE_CAP, &cap);

/* struct kvm_dirty_gfn — one entry per dirtied page */
struct kvm_dirty_gfn {
    __u32 flags;  /* KVM_DIRTY_GFN_F_DIRTY: page was dirtied */
    __u32 slot;
    __u64 offset; /* page offset within the slot */
};
```

The dirty ring is mmap'd from the vCPU fd at offset `KVM_DIRTY_LOG_PAGE_OFFSET * PAGE_SIZE` (a separate region from `struct kvm_run`, which is at offset 0). QEMU reads the ring as vCPU threads produce entries, avoiding the need to poll a bitmap and re-write-protect all pages.

## The three migration phases in detail

### Phase 1: Iterative pre-copy

QEMU on the source enables dirty logging, then repeatedly:

1. Copies all pages not yet sent (or re-dirtied since last round) to the destination.
2. Fetches the dirty bitmap via `KVM_GET_DIRTY_LOG`.
3. Sends the newly-dirtied pages.

Each round sends fewer pages — the guest's working set converges. QEMU tracks:

- **Dirty rate**: pages dirtied per second by the guest.
- **Bandwidth**: pages transferred per second to the destination.

Pre-copy ends when the estimated remaining transfer time drops below the target downtime, set via the `downtime-limit` migration parameter (default 300 ms) — a separate knob from `max-bandwidth`, which caps transfer speed rather than target downtime.

**Auto-converge**: if the dirty rate stays high and convergence is not happening, `mig_throttle_guest_down()` (in `migration/ram.c`) calls `cpu_throttle_set()` to periodically stall the vCPU threads, ramping the throttle percentage up by `cpu-throttle-increment` each time the `throttle-trigger-threshold` ratio is exceeded, up to `max-cpu-throttle`. This ensures migration completes at the cost of temporary guest performance degradation.

### Phase 2: Stop-and-copy

The source VM is paused. QEMU does a final `KVM_GET_DIRTY_LOG` pass and transfers all remaining dirty pages. Then it transfers CPU state.

### Phase 3: CPU state transfer

Each vCPU's register state is saved on the source and restored on the destination with a set of ioctls:

```c
/* General-purpose registers */
struct kvm_regs regs;
ioctl(vcpu_fd, KVM_GET_REGS, &regs);     /* rax, rbx, rip, rsp, rflags, ... */
ioctl(vcpu_fd, KVM_SET_REGS, &regs);

/* Segment registers, control registers, descriptor tables */
struct kvm_sregs sregs;
ioctl(vcpu_fd, KVM_GET_SREGS, &sregs);   /* cr0, cr3, cr4, cs, ss, gdt, ... */
ioctl(vcpu_fd, KVM_SET_SREGS, &sregs);

/* Model-specific registers (MSRs) */
struct kvm_msrs *msrs;  /* variable length: header + array of kvm_msr_entry */
ioctl(vcpu_fd, KVM_GET_MSRS, msrs);      /* EFER, LSTAR, FS_BASE, GS_BASE, ... */
ioctl(vcpu_fd, KVM_SET_MSRS, msrs);

/* Extended CPU state: AVX, AVX-512 registers */
struct kvm_xsave xsave;
ioctl(vcpu_fd, KVM_GET_XSAVE, &xsave);
ioctl(vcpu_fd, KVM_SET_XSAVE, &xsave);

/* FPU state (legacy path, superseded by KVM_GET_XSAVE on modern kernels) */
struct kvm_fpu fpu;
ioctl(vcpu_fd, KVM_GET_FPU, &fpu);
ioctl(vcpu_fd, KVM_SET_FPU, &fpu);

/* Local APIC state */
struct kvm_lapic_state lapic;
ioctl(vcpu_fd, KVM_GET_LAPIC, &lapic);
ioctl(vcpu_fd, KVM_SET_LAPIC, &lapic);

/* Nested virtualization state (if guest is also a hypervisor) */
/* KVM_GET_NESTED_STATE / KVM_SET_NESTED_STATE — see nested-virt.md */
```

## Device state

### QEMU-emulated devices

QEMU serializes device state using its VMState framework. Each device registers a `VMStateDescription`:

```c
/* hw/net/e1000.c, simplified — the real list has ~50 individual mac_reg[REG]
 * entries (not one array macro) plus several .subsections; no RX-buffer
 * content is migrated at all, only registers/config: */
static const VMStateDescription vmstate_e1000 = {
    .name    = "e1000",
    .version_id = 2,
    .minimum_version_id = 1,
    .fields  = (const VMStateField[]) {
        VMSTATE_PCI_DEVICE(parent_obj, E1000State),
        VMSTATE_UINT32(mac_reg[CTRL], E1000State),
        VMSTATE_UINT32(mac_reg[STATUS], E1000State),
        /* ... one VMSTATE_UINT32(mac_reg[REG], ...) per register ... */
        VMSTATE_UINT16_ARRAY(eeprom_data, E1000State, 64),
        VMSTATE_END_OF_LIST()
    },
};
```

`VMSTATE_*` macros encode field type, offset, and size. QEMU's migration layer iterates all registered `VMStateDescription` structures, serializes each field, and streams the result to the destination over the migration transport.

### vhost kernel backends

Kernel-side vhost devices (vhost-net, vhost-blk) have state that QEMU cannot serialize directly because it lives in the kernel. The key state is the virtqueue position:

```c
/* Save vhost vring state before migration */
struct vhost_vring_state state = { .index = queue_idx };
ioctl(vhost_fd, VHOST_GET_VRING_BASE, &state);
/* state.num contains the current avail/used index */

/* Restore on destination */
ioctl(vhost_fd, VHOST_SET_VRING_BASE, &state);
```

For virtio devices backed by QEMU (not vhost), the virtqueue state is captured through QEMU's own `struct VirtQueue` (not the Linux kernel's `struct virtio_device`, which is a driver-side type in an entirely different codebase) via `vmstate_virtqueue` in `hw/virtio/virtio.c`, which includes `last_avail_idx` and `used_idx`.

## Post-copy migration

Post-copy flips the direction: the VM starts on the destination **before** all pages are transferred. Pages not yet copied are fetched from the source on demand.

```
Pre-copy:   copy all RAM → stop VM → transfer CPU → resume on dest
Post-copy:  stop VM → transfer CPU → resume on dest (immediately)
                                       → fault on missing pages → fetch from source
```

KVM post-copy relies on **userfaultfd**. QEMU on the destination registers the guest RAM mapping (anonymous memory) with `userfaultfd` in `MISSING` mode; when the guest accesses an uncopied page, the kernel delivers a `UFFD_EVENT_PAGEFAULT` to a QEMU thread, which fetches the page from the source host and installs it.

```c
/* Destination: register RAM with userfaultfd */
int uffd = syscall(SYS_userfaultfd, O_CLOEXEC | O_NONBLOCK);

struct uffdio_api api = { .api = UFFD_API, .features = 0 }; /* anonymous memory needs no feature flag for MISSING mode */
ioctl(uffd, UFFDIO_API, &api);

struct uffdio_register reg = {
    .range  = { .start = (uint64_t)ram, .len = ram_size },
    .mode   = UFFDIO_REGISTER_MODE_MISSING,
};
ioctl(uffd, UFFDIO_REGISTER, &reg);

/* QEMU fault handler thread: reads uffd, fetches from source, copies page */
struct uffd_msg msg;
read(uffd, &msg, sizeof(msg));
/* msg.arg.pagefault.address: faulting GPA → fetch from source → UFFDIO_COPY */
```

Trade-offs of post-copy:

| | Pre-copy | Post-copy |
|--|---------|----------|
| Stop time | Higher (proportional to dirty rate) | Minimal (one round-trip for CPU state) |
| Page fetch latency | None after resume | Yes — each uncopied page stalls the vCPU |
| Failure sensitivity | Can abort and resume on source | Once VM starts on dest, source failure is fatal |

## Migration transports

QEMU supports several transport channels:

| Transport | Use case |
|-----------|----------|
| TCP | Default; simple, works everywhere |
| RDMA (`rdma:host:port`) | Low-latency bulk transfer for large RAM; bypasses CPU for DMA |
| multifd | Parallel TCP streams (`migrate_set_parameter multifd-channels N`); saturates high-bandwidth links |
| Unix socket | Same-host testing |

**multifd** (multiple file descriptors) opens N parallel channels and assigns pages to channels in round-robin. Added as an experimental feature (`x-multifd-channels`) in QEMU 2.11, it stabilized — dropping the `x-` prefix, renamed to `multifd-channels` — in QEMU 4.0. With 8 channels on a 25 Gbps link, it can saturate bandwidth that a single TCP stream cannot due to per-stream throughput limits.

## Observing migration

```bash
# QEMU monitor: start migration
(qemu) migrate tcp:192.168.1.2:4444

# Check migration status (real hmp_info_migrate output format)
(qemu) info migrate
# Status: 		active
# Time (ms): 		total=4321
# Remaining: 		56 MiB
# RAM info:
#   Throughput (Mbps): 	120.50
#   Sizes: 		pagesize=4 KiB, total=4096 MiB
#   Transfers: 		transferred=1234 MiB, remain=56 MiB
#     Channels: 		precopy=1234 MiB, multifd=0 MiB, postcopy=0 MiB
#     Page Types: 	normal=316000, zero=1500
#   Page Rates (pps): 	transfer=45000, dirty=12300
#   Others: 		dirty_syncs=8

# The configured downtime target is a separate query:
(qemu) info migrate_parameters
# downtime-limit: 300 ms

# On the source kernel: dirty log tracepoints
echo 1 > /sys/kernel/tracing/events/kvm/kvm_dirty_ring_push/enable
echo 1 > /sys/kernel/tracing/events/kvm/kvm_dirty_ring_reset/enable

# Monitor per-vCPU page-fault rate during migration (should spike then
# drop as dirty-tracking write-protection faults fire, then converge) —
# no dedicated per-exit-type breakdown exists in a single debugfs file,
# so watch the raw counter and use the perf command below for the
# EPT_VIOLATION-specific view:
watch -n1 'cat /sys/kernel/debug/kvm/*/vcpu0/pf_taken'

# perf: watch for extra EPT violations from write-protection faults
perf kvm stat report --event EPT_VIOLATION
```

## Further reading

### Kernel source

- [virt/kvm/kvm_main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/virt/kvm/kvm_main.c) — `kvm_vm_ioctl_get_dirty_log()` / `kvm_vm_ioctl_clear_dirty_log()`: the `KVM_GET_DIRTY_LOG` and `KVM_CLEAR_DIRTY_LOG` implementations
- [virt/kvm/dirty_ring.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/virt/kvm/dirty_ring.c) — `kvm_dirty_ring_push()` / `kvm_dirty_ring_reset()`: the `KVM_CAP_DIRTY_LOG_RING` ring-buffer implementation
- [include/uapi/linux/kvm.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/kvm.h) — `struct kvm_dirty_gfn`, `KVM_DIRTY_LOG_PAGE_OFFSET`, and the dirty-log/dirty-ring ioctl definitions
- [mm/userfaultfd.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/userfaultfd.c) — `handle_userfault()` and the `UFFDIO_COPY` path used by QEMU's post-copy destination to service missing-page faults
- [drivers/vhost/vhost.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/vhost/vhost.c) — `VHOST_GET_VRING_BASE` / `VHOST_SET_VRING_BASE` ioctl handlers for saving and restoring vring indices across migration

### QEMU source

QEMU migration is userspace code; per site policy these link to QEMU's own canonical GitLab repository, not a GitHub mirror.

- [migration/ram.c](https://gitlab.com/qemu-project/qemu/-/blob/master/migration/ram.c) — dirty-bitmap–driven RAM migration and the auto-converge throttling logic
- [migration/postcopy-ram.c](https://gitlab.com/qemu-project/qemu/-/blob/master/migration/postcopy-ram.c) — `userfaultfd` registration and fault servicing on the post-copy destination
- [migration/multifd.c](https://gitlab.com/qemu-project/qemu/-/blob/master/migration/multifd.c) — the multifd parallel migration-channel implementation
- [migration/vmstate.c](https://gitlab.com/qemu-project/qemu/-/blob/master/migration/vmstate.c) — `vmstate_save_state()` / `vmstate_load_state()`: the VMState serialization engine
- [hw/net/e1000.c](https://gitlab.com/qemu-project/qemu/-/blob/master/hw/net/e1000.c) — `vmstate_e1000`: the `VMStateDescription` example referenced on this page
- [qapi/migration.json](https://gitlab.com/qemu-project/qemu/-/blob/master/qapi/migration.json) — `throttle-trigger-threshold`, `cpu-throttle-increment`, and `multifd-channels` parameter definitions

### Man pages

- [`userfaultfd(2)`](https://man7.org/linux/man-pages/man2/userfaultfd.2.html) — the syscall QEMU's post-copy destination uses to register guest RAM and receive `UFFD_EVENT_PAGEFAULT`

### Related pages

- [KVM Architecture](kvm-arch.md) — KVM ioctls, `struct kvm_run`, vCPU lifecycle
- [KVM Exit Handling](kvm-exits.md) — EPT violations and exit-reason dispatch
- [Nested Virtualization](nested-virt.md) — `KVM_GET_NESTED_STATE` for migrating L1 hypervisors
- [Memory Virtualization](kvm-memory.md) — EPT/NPT, dirty page tracking, the balloon driver

### LWN articles

- [Page faults in user space: MADV_USERFAULT, remap_anon_range(), and userfaultfd()](https://lwn.net/Articles/615086/) — the original 2014 design discussion; states plainly that "the primary use case here is the live migration of virtual machines running under KVM"
- [The next steps for userfaultfd()](https://lwn.net/Articles/718198/) — follow-up on userfaultfd's evolution, reiterating that it "was originally created to help with the live migration of virtual machines between physical hosts"
- [Blocking userfaultfd() kernel-fault handling](https://lwn.net/Articles/819834/) — discusses demand-faulting pages across the network during migration, driven by userfaultfd events

### External

- [The Definitive KVM API Documentation](https://docs.kernel.org/virt/kvm/api.html) — official ioctl reference covering `KVM_GET_DIRTY_LOG`, `KVM_CLEAR_DIRTY_LOG`, and `KVM_CAP_DIRTY_LOG_RING`
- [Userfaultfd](https://docs.kernel.org/admin-guide/mm/userfaultfd.html) — kernel admin-guide documentation for the `MISSING`-mode fault handling used in post-copy
- [QEMU Migration framework](https://www.qemu.org/docs/master/devel/migration/main.html) — official QEMU developer docs on the VMState framework and pre-copy design
- [QEMU Postcopy](https://www.qemu.org/docs/master/devel/migration/postcopy.html) — official QEMU developer docs on post-copy internals
