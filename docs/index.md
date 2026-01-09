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
| scheduler/ | Planned |
| networking/ | Planned |
| bpf/ | Planned |
| drivers/ | Planned |

## Community

- [Contributing Guide](contributing.md) to get started as a contributor
- [GitHub Discussions](https://github.com/laveeshb/linux-kernel-internals/discussions) for questions and conversations
- [GitHub Issues](https://github.com/laveeshb/linux-kernel-internals/issues) to suggest topics or report problems

## Disclaimer

This is a community learning resource, not a definitive reference. The Linux kernel is complex and constantly evolving. While we strive for accuracy and link to primary sources (commits, LKML), errors may exist. When in doubt, consult the [official kernel documentation](https://docs.kernel.org/) and source code. Contributions and corrections are welcome.

## License

- Documentation: [CC BY-SA 4.0](LICENSE-CC-BY-SA-4.0)
- Code snippets: [GPL-2.0](LICENSE-GPL-2.0)
- Tux logo: Larry Ewing (original), Simon Budig (SVG)
