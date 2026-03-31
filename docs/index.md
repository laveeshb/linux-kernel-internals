# Linux Kernel Internals

A community hub for understanding the Linux kernel — documentation and discussions about design decisions, internals, and the journey of contributing.

## What This Is

**Documentation**: Deep dives into kernel subsystems, explaining *why* things work the way they do, not just the APIs.

**Discussion**: A place to ask questions, share discoveries, and help each other understand the kernel.

## Why?

The kernel has extensive API documentation, but understanding the *rationale* requires digging through mailing list archives, scattered articles, and tribal knowledge. We're building a more accessible resource.

## Documentation

### General
| Document | Description |
|----------|-------------|
| [Linux Evolution](linux-evolution.md) | From hobby project to world infrastructure |

### Subsystems
| Subsystem | Status |
|-----------|--------|
| [Memory Management (mm/)](mm/README.md) | Available |
| [Scheduler (sched/)](sched/README.md) | Available |
| [Networking (net/)](net/network-stack-overview.md) | Available |
| [Locking (locking/)](locking/README.md) | Available |
| [Interrupts (interrupts/)](interrupts/README.md) | Available |
| [Security (security/)](security/README.md) | Available |
| [VFS (vfs/)](vfs/README.md) | Available |
| [BPF (bpf/)](bpf/README.md) | Available |
| [Block Layer (block/)](block/README.md) | Available |
| [Filesystems (filesystems/)](filesystems/README.md) | Available |
| [Drivers (drivers/)](drivers/README.md) | Available |
| [Cgroups (cgroups/)](cgroups/README.md) | Available |
| [Tracing (tracing/)](tracing/README.md) | Available |
| [Debugging (debugging/)](debugging/README.md) | Available |
| [IPC (ipc/)](ipc/README.md) | Available |
| [Architecture (arch/)](arch/arm64/README.md) | Available |
| [Modules (modules/)](modules/README.md) | Available |
| [Virtualization (virtualization/)](virtualization/README.md) | Available |
| [Power Management (power/)](power/README.md) | Available |
| [Time (time/)](time/README.md) | Available |
| [Syscalls (syscalls/)](syscalls/README.md) | Available |
| [IO (io/)](io/README.md) | Available |
| [io_uring (io-uring/)](io-uring/README.md) | Available |
| [Crypto (crypto/)](crypto/README.md) | Available |
| [Livepatch (livepatch/)](livepatch/README.md) | Available |
| [IOMMU (iommu/)](iommu/README.md) | Available |

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
