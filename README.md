# Linux Kernel Internals

A community hub for understanding the Linux kernel — documentation and discussions about design decisions, internals, and the journey of contributing. Where docs.kernel.org explains *what* the kernel does, this site focuses on *why* it's designed that way: the trade-offs, the failed alternatives, and the LKML debates behind them.

**[View the documentation](https://kernel-internals.org/)**

## What's inside

**375+ documents across 28 subsystems**, with sourced citations (kernel commits, LWN, lore) and end-to-end "life of a ..." walkthroughs.

| Area | Sections |
|------|----------|
| Memory | [Memory management](docs/mm/) (90+ docs: allocators, reclaim, MGLRU, DAMON, CXL tiering, folios, THP…) · [IOMMU](docs/iommu/) |
| CPU & scheduling | [Scheduler](docs/sched/) (EEVDF, deadline, EAS…) · [Locking & RCU](docs/locking/) · [Interrupts](docs/interrupts/) · [Time & timers](docs/time/) |
| I/O & storage | [I/O paths](docs/io/) · [io_uring](docs/io-uring/) · [Block layer](docs/block/) · [VFS](docs/vfs/) · [Filesystems](docs/filesystems/) |
| Networking | [Network stack](docs/net/) (XDP, AF_XDP, kTLS, netfilter, namespaces…) |
| Architecture | [x86-64](docs/arch/x86/) (page tables, syscall entry, Spectre/Meltdown) · [arm64](docs/arch/arm64/) |
| Isolation & security | [Security](docs/security/) (SELinux, Landlock, seccomp…) · [Cgroups & namespaces](docs/cgroups/) · [Virtualization/KVM](docs/virtualization/) |
| Observability | [Tracing](docs/tracing/) · [BPF](docs/bpf/) · [Debugging](docs/debugging/) |
| Kernel machinery | [Core kernel](docs/kernel/) · [Syscalls](docs/syscalls/) · [Modules](docs/modules/) · [Livepatch](docs/livepatch/) · [Drivers](docs/drivers/) · [IPC](docs/ipc/) · [Power](docs/power/) · [Crypto](docs/crypto/) |

Or browse the [full site index](docs/site-index.md).

## Quick Links

- [Contributing Guide](docs/contributing.md) - Get started as a contributor
- [GitHub Discussions](../../discussions) - Questions and conversations
- [Issues](../../issues) - Suggest topics or report problems

## License

- Documentation: [CC BY-SA 4.0](LICENSE-CC-BY-SA-4.0)
- Code snippets: [GPL-2.0](LICENSE-GPL-2.0)
- Tux logo: Larry Ewing (original), Simon Budig (SVG)
