# Contributing

We welcome contributions from anyone interested in documenting and discussing Linux kernel internals.

## Ways to Contribute

### Write Documentation

Help document kernel subsystems:
1. Pick a subsystem or topic
2. Create/update files in `docs/`
3. Submit a PR

Good documentation:
- Explains *why*, not just *what*
- Links to primary sources (commits, mailing lists, LWN)
- Includes code snippets where helpful
- Stays focused and practical

### Write Blog Posts

Share your kernel journey:
1. Create a file in `blog/` named `YYYY-MM-DD-title.md`
2. Use the [blog post template](templates/blog-post.md)
3. Submit a PR

Good topics:
- Patches you submitted and what you learned
- Bugs you investigated and how you debugged them
- Subsystems you explored and what you discovered
- Tools and techniques that helped you

### Join Discussions

- Ask questions in [GitHub Discussions](../../discussions)
- Answer questions from others
- Suggest topics that need documentation

### Report Issues

- Found an error? Open an issue.
- Want to request a topic? Open an issue.

## Guidelines

### Style

- Write clearly and concisely
- Use code blocks for kernel code (with `c` syntax highlighting)
- Use headers to organize content
- Link to related documentation

### Sources

Always cite your sources:
- Commit hashes: `[commit abcd1234](https://git.kernel.org/...)`
- Mailing list: link to lore.kernel.org archives
- LWN articles: include title and link

### File Organization

```
docs/
  subsystem/
    overview.md          # Start here for the subsystem
    topic-name.md        # Specific topics

blog/
  2025-01-07-my-first-kernel-patch.md
```

## Submitting Changes

1. Fork the repository
2. Create a branch (`git checkout -b my-contribution`)
3. Make your changes
4. Submit a PR with a clear description

## Code of Conduct

Be respectful and constructive. We're all here to learn.

## Questions?

Open a [Discussion](../../discussions) or reach out to the maintainers.
