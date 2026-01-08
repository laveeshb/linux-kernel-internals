# How to Use This Site

A guide to navigating this documentation effectively.

---

## Reading Paths

### New to Kernel Development?

Start here if you're new to the Linux kernel:

1. **[Linux Evolution](linux-evolution.md)** - Understand the history
2. **[mm/ Getting Started](mm/README.md)** - Prerequisites and setup
3. **[mm/ Overview](mm/overview.md)** - The big picture of memory management
4. Follow the suggested reading order in mm/README.md

### Looking for Specific Topics?

Use the **[Index](site-index.md)** for a complete listing, or jump directly:

| I want to understand... | Go to |
|------------------------|-------|
| kmalloc / kfree | [kmalloc (SLUB)](mm/slab.md#kmalloc-size-classes) |
| How memory allocation works | [Page Allocator](mm/page-allocator.md), [kmalloc](mm/slab.md) |
| Virtual memory and page tables | [Page Tables](mm/page-tables.md) |
| What happens under memory pressure | [Page Reclaim](mm/reclaim.md) |
| Container memory limits | [Memory Cgroups](mm/memcg.md) |
| Huge pages | [THP](mm/thp.md) |
| A specific term | [Glossary](mm/glossary.md) |

### Debugging a Problem?

Each page has a "Try It Yourself" section with practical commands:

- `/proc` and `/sys` interfaces to inspect kernel state
- Tracing commands to observe behavior
- Test commands to reproduce scenarios

---

## Page Structure

Most pages follow this structure:

1. **What Is X?** - Brief explanation
2. **How It Works** - Technical details with diagrams
3. **Evolution** - Historical context and key commits
4. **Try It Yourself** - Practical commands
5. **Further Reading** - LKML links, related docs

---

## Navigation Features

### Site Navigation

- **Left sidebar**: Browse all pages hierarchically
- **Right sidebar**: Jump to sections within current page (table of contents)
- **Search**: Use the search bar (top) to find any topic

### Links

- **Commit links**: `[abc123]` links go to git.kernel.org
- **LKML links**: Links to lore.kernel.org patch discussions
- **Source links**: Links to kernel source files

---

## Conventions

### Code Blocks

```c
// Kernel C code
void *ptr = kmalloc(size, GFP_KERNEL);
```

```bash
# Shell commands to try
cat /proc/meminfo
```

### Callouts

> **Note**: Important information or caveats

### Tables

Used for comparing options, listing files, or summarizing features.

---

## Contributing

Found an error? Have a suggestion?

- **[GitHub Issues](https://github.com/laveeshb/linux-kernel-internals/issues)** - Report problems
- **[GitHub Discussions](https://github.com/laveeshb/linux-kernel-internals/discussions)** - Ask questions

---

## Quick Links

| Destination | Link |
|-------------|------|
| Home | [Home](index.md) |
| Full Index | [Index](site-index.md) |
| mm/ Documentation | [Getting Started](mm/README.md) |
| Glossary | [Glossary](mm/glossary.md) |
