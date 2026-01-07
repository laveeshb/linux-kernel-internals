# Linux Kernel Internals

A community hub for understanding the Linux kernel — documentation, blog posts, and discussions about design decisions, internals, and the journey of contributing.

## What This Is

**Documentation**: Deep dives into kernel subsystems, explaining *why* things work the way they do, not just the APIs.

**Blog**: Posts about kernel exploration, patches submitted, bugs fixed, and lessons learned along the way.

**Discussion**: A place to ask questions, share discoveries, and help each other understand the kernel.

## Why?

The kernel has extensive API documentation, but understanding the *rationale* requires digging through mailing list archives, paywalled LWN articles, and tribal knowledge. We're building a more accessible resource.

## Structure

```
├── docs/               # Reference documentation
│   ├── mm/             # Memory management
│   ├── scheduler/      # Process scheduler
│   ├── networking/     # Network stack
│   ├── bpf/            # BPF/eBPF subsystem
│   └── drivers/        # Driver subsystems
├── blog/               # Blog posts and write-ups
│   └── YYYY-MM-DD-title.md
└── resources/          # Useful links, tools, references
```

## Recent Posts

<!-- Add blog posts here as they're written -->

*Coming soon...*

## Documentation

| Subsystem | Status | Description |
|-----------|--------|-------------|
| [mm/vmalloc](docs/mm/vmalloc.md) | In Progress | Virtual memory allocation |
| More coming... | | |

## Community

- [GitHub Discussions](../../discussions) for questions and conversations
- [Issues](../../issues) to suggest topics or report problems

## License

- Documentation and blog content: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- Code snippets: [GPL-2.0](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) (matching kernel)

---

*This project is not affiliated with the Linux kernel project or the Linux Foundation.*
