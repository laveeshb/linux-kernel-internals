# Linux Kernel Internals

A community hub for understanding the Linux kernel — documentation and discussions about design decisions, internals, and the journey of contributing. Where docs.kernel.org explains *what* the kernel does, this site focuses on *why* it's designed that way: the trade-offs, the failed alternatives, and the LKML debates behind them.

**[View the documentation](https://kernel-internals.org/)**

## What's inside

Documentation spanning every major subsystem, with sourced citations (kernel commits, LWN, lore) and end-to-end "life of a ..." walkthroughs. Mirrors the site's own nav structure:

| Area | Sections |
|------|----------|
| Foundations | [Kernel internals](docs/kernel/) · [Architecture](docs/arch/) (x86-64, arm64: page tables, syscall entry, Spectre/Meltdown) · [Syscalls](docs/syscalls/) · [Time & timers](docs/time/) · [Modules](docs/modules/) |
| Memory | [Memory management](docs/mm/) (allocators, reclaim, MGLRU, DAMON, CXL tiering, folios, THP…) · [IOMMU](docs/iommu/) |
| Scheduling & concurrency | [Scheduler](docs/sched/) (EEVDF, deadline, EAS…) · [Locking & RCU](docs/locking/) · [Interrupts](docs/interrupts/) · [IPC](docs/ipc/) |
| Storage & I/O | [VFS](docs/vfs/) · [Filesystems](docs/filesystems/) · [Block layer](docs/block/) · [I/O paths](docs/io/) · [io_uring](docs/io-uring/) |
| Devices & drivers | [Device drivers](docs/drivers/) · [USB](docs/usb/) · [GPU/DRM](docs/drm/) |
| Networking & BPF | [Network stack](docs/net/) (XDP, AF_XDP, kTLS, netfilter, namespaces…) · [BPF/eBPF](docs/bpf/) |
| Isolation & security | [Security](docs/security/) (SELinux, Landlock, seccomp…) · [Cgroups & namespaces](docs/cgroups/) · [Virtualization/KVM](docs/virtualization/) · [Crypto](docs/crypto/) · [Livepatch](docs/livepatch/) |
| Observability | [Tracing](docs/tracing/) · [Debugging](docs/debugging/) · [Power management](docs/power/) |

## Quick Links

- [Contributing Guide](docs/contributing.md) - Get started as a contributor
- [GitHub Discussions](../../discussions) - Questions and conversations
- [Issues](../../issues) - Suggest topics or report problems

## License

- Documentation: [CC BY-SA 4.0](LICENSE-CC-BY-SA-4.0)
- Code snippets: [GPL-2.0](LICENSE-GPL-2.0)
- Tux logo: Larry Ewing (original), Simon Budig (SVG)
