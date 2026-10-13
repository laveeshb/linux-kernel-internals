---
hide:
  - navigation
---

# Linux Kernel Internals

A community hub for understanding the Linux kernel — documentation and discussions about design decisions, internals, and the journey of contributing.

!!! tip "Ever had a browser tab just vanish when memory ran low?"
    [Find out who decided it had to die &rarr;](playground/oom-killer.md)

## What This Is

**Documentation**: Deep dives into kernel subsystems, explaining *why* things work the way they do, not just the APIs.

**Discussion**: A place to ask questions, share discoveries, and help each other understand the kernel.

## Why?

The kernel has extensive API documentation, but understanding the *rationale* requires digging through mailing list archives, scattered articles, and tribal knowledge. We're building a more accessible resource.

## Documentation

### General

- [Linux Evolution](linux-evolution.md) — from hobby project to world infrastructure

### Subsystems

**Foundations**

- [Kernel Internals (kernel/)](kernel/README.md) — the glue that holds every subsystem together: boot, logging, parameters, panics, and module init
- [Architecture (arch/)](arch/arm64/README.md) — where the kernel meets the hardware: boot, CPU features, exceptions, and per-arch specifics (x86, arm64)
- [System Calls (syscalls/)](syscalls/README.md) — how user space crosses into the kernel and back
- [Modules (modules/)](modules/README.md) — loading, linking, and unloading kernel code at runtime
- [Time (time/)](time/README.md) — clocks, timers, ticks, and how the kernel keeps and measures time

**Memory**

- [Memory Management (mm/)](mm/README.md) — how the kernel allocates, maps, and reclaims physical and virtual memory
- [IOMMU (iommu/)](iommu/README.md) — address translation and isolation between devices and memory

**Scheduling & Concurrency**

- [Scheduler (sched/)](sched/README.md) — how the kernel decides which task runs next, and when
- [Locking (locking/)](locking/README.md) — the primitives that keep concurrent code correct: spinlocks, mutexes, RCU
- [Interrupts (interrupts/)](interrupts/README.md) — handling hardware events and safely deferring work
- [IPC (ipc/)](ipc/README.md) — how processes communicate: pipes, signals, shared memory, message queues

**Storage & I/O**

- [VFS (vfs/)](vfs/README.md) — the abstraction that lets one API drive every filesystem
- [Filesystems (filesystems/)](filesystems/README.md) — how on-disk formats and the page cache turn bytes into files
- [Block Layer (block/)](block/README.md) — the path from a filesystem request to a physical device
- [I/O Patterns (io/)](io/README.md) — buffered vs. direct, sync vs. async, and the tradeoffs between them
- [io_uring (io-uring/)](io-uring/README.md) — the ring-based interface for high-performance asynchronous I/O

**Devices & Drivers**

- [Drivers (drivers/)](drivers/README.md) — the device model and how drivers bind to hardware
- [USB (usb/)](usb/README.md) — the host-scheduled, hot-pluggable peripheral bus: descriptors, endpoints, and URBs
- [GPU / DRM (drm/)](drm/README.md) — the graphics and display stack: KMS modesetting, GEM buffers, and command submission

**Networking & BPF**

- [Networking (net/)](net/network-stack-overview.md) — the journey of a packet through the stack, from socket to wire
- [BPF (bpf/)](bpf/README.md) — running sandboxed programs in the kernel for tracing, networking, and security

**Isolation & Security**

- [Cgroups (cgroups/)](cgroups/README.md) — accounting for and limiting resources per group of processes; the basis of containers
- [Security (security/)](security/README.md) — LSMs, capabilities, seccomp, and the kernel's access-control machinery
- [Virtualization (virtualization/)](virtualization/README.md) — KVM and how the kernel runs guest machines
- [Crypto (crypto/)](crypto/README.md) — the kernel's cryptographic API and hardware acceleration
- [Livepatch (livepatch/)](livepatch/README.md) — patching a running kernel without rebooting

**Observability**

- [Tracing (tracing/)](tracing/README.md) — ftrace, tracepoints, and perf: seeing what the kernel is doing
- [Debugging (debugging/)](debugging/README.md) — tools and techniques for diagnosing kernel problems
- [Power Management (power/)](power/README.md) — suspend, resume, cpufreq, and idle states

## Community

- [Contributing Guide](contributing.md) to get started as a contributor
- [GitHub Discussions](https://github.com/laveeshb/linux-kernel-internals/discussions) for questions and conversations
- [GitHub Issues](https://github.com/laveeshb/linux-kernel-internals/issues) to suggest topics or report problems

## Disclaimer

This is a community learning resource, not a definitive reference. The Linux kernel is complex and constantly evolving. While we strive for accuracy and link to primary sources (commits, LKML), errors may exist. When in doubt, consult the [official kernel documentation](https://docs.kernel.org/) and source code. Contributions and corrections are welcome.

## License

- Documentation: [CC BY-SA 4.0](https://github.com/laveeshb/linux-kernel-internals/blob/main/LICENSE-CC-BY-SA-4.0)
- Code snippets: [GPL-2.0](https://github.com/laveeshb/linux-kernel-internals/blob/main/LICENSE-GPL-2.0)
- Tux logo: Larry Ewing (original), Simon Budig (SVG)
