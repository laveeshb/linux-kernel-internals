# Virtualization: KVM

> Hardware-accelerated virtual machines in the Linux kernel

## KVM architecture overview

KVM (Kernel-based Virtual Machine) is a hypervisor built into the Linux kernel. It uses hardware virtualization extensions (Intel VT-x / AMD-V) to run virtual machines at near-native speed.

```
Host (Linux + KVM)
┌─────────────────────────────────────────────────────────┐
│  QEMU (userspace)                                        │
│  ┌──────────────────────────────────────────────────┐    │
│  │ VM process: manages devices, memory layout, VNC   │    │
│  │  │                                                │    │
│  │  │ ioctl(/dev/kvm, KVM_RUN)                      │    │
│  └──│──────────────────────────────────────────────┘    │
│     ▼                                                    │
│  KVM kernel module                                       │
│  ┌──────────────────────────────────────────────────┐    │
│  │ vCPU thread: runs in VMX non-root mode            │    │
│  │  ├── VM Entry: switch to guest (vmlaunch/vmresume)│    │
│  │  ├── Guest runs (near-native speed)               │    │
│  │  └── VM Exit: return to host on sensitive ops     │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  Hardware: Intel VT-x / AMD-V                           │
└─────────────────────────────────────────────────────────┘
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [KVM Architecture](kvm-arch.md) | /dev/kvm API, vCPU, VM exits, VMCS |
| [Memory Virtualization](kvm-memory.md) | EPT/NPT, shadow paging, balloon, huge pages |
| [virtio](virtio.md) | Paravirtualized I/O, virtqueue, vhost acceleration |
| [VFIO Device Passthrough](vfio.md) | IOMMU groups, DMA remapping, VFIO container hierarchy |
| [KVM Exit Handling](kvm-exits.md) | Exit reasons, I/O emulation, MMIO, interrupt injection |
| [KVM Live Migration](live-migration.md) | Dirty logging, pre-copy, CPU state transfer, post-copy |
| [Nested Virtualization](nested-virt.md) | L0/L1/L2, vmcs12, vmcs02 merge, two-level EPT |
| [War Stories](war-stories.md) | VENOM, L1TF, a nested-VMX UAF, a vhost overflow, and the MDS mitigation's five-year timing gap |

## Quick reference

```bash
# Check KVM support
lsmod | grep kvm
# kvm_intel   or  kvm_amd
# kvm

ls /dev/kvm  # must exist

# Check hardware virtualization
grep -m1 -E "vmx|svm" /proc/cpuinfo

# List running VMs (QEMU/KVM)
virsh list --all
qemu-img info disk.qcow2

# VM memory usage
virsh domstats --list-running --balloon
```
