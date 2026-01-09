# Contributing to Linux Kernel Internals

> **Reading this on the website?** Head to the [GitHub repository](https://github.com/laveeshb/linux-kernel-internals) to contribute, open issues, or join discussions.

Thank you for your interest in contributing! This project aims to document Linux kernel internals in an accessible, engaging way.

## Project Philosophy

This is **not** another reference documenting what the Linux kernel looks like today. The official [kernel documentation](https://docs.kernel.org/) already does that well.

Instead, we focus on:

- **Why** things are designed the way they are
- **How** subsystems evolved over time
- **What problems** led to current solutions
- **Trade-offs** that were considered

When writing, don't just explain *what* the code does - help readers understand the reasoning behind design decisions, the historical context, and how things changed over kernel versions. Link to commits, mailing list discussions, and conference talks that capture these decisions.

## How to Contribute

### Finding Work

Browse [open issues](https://github.com/laveeshb/linux-kernel-internals/issues) and filter by [labels](https://github.com/laveeshb/linux-kernel-internals/labels):

| Label prefix | Purpose |
|--------------|---------|
| `priority/*` | Importance (high, medium, low) |
| `area/*` | Kernel subsystem (mm, scheduler, etc.) |
| `type/*` | Document style (narrative, reference, guide, explainer) |
| `epic/*` | Grouped work items |

Look for `good first issue` if you're new to the project.

### Workflow

1. **Fork** the repository
2. **Create a branch** from `main` (e.g., `add-kasan-docs`)
3. **Write your content** following the style guide below
4. **Test locally** with `mkdocs serve`
5. **Submit a PR** with a clear description
6. **Address feedback** from reviewers

### Pull Request Requirements

- PRs require **1 approval** before merging
- Keep PRs focused on a single topic
- Link to the relevant issue (e.g., "Closes #42")

## Writing Style Guide

### Voice and Tone

- **Accessible but accurate** - Explain complex topics clearly without sacrificing correctness
- **Teach, don't just document** - Help readers understand *why*, not just *what*
- **Use active voice** - "The kernel allocates pages" not "Pages are allocated by the kernel"
- **Be concise** - Avoid filler words and unnecessary jargon

### Document Structure

Every document should follow this general structure:

```markdown
# Title

> One-line description of what this covers

## What is [Topic]?

Brief introduction explaining what this is and why it matters.

## Core Concepts

Main technical content with examples.

## How It Works

Step-by-step explanations, diagrams, code examples.

## Try It Yourself

Commands readers can run to explore the concept.

## History / Evolution (if relevant)

When features were added, why decisions were made.

## Further Reading

Links to kernel docs, LWN articles, relevant commits.
```

### Formatting Conventions

**Headers**

- Use sentence case: "Page allocator" not "Page Allocator"
- H1 (`#`) for page title only
- H2 (`##`) for major sections
- H3 (`###`) for subsections

**Code blocks**
```c
// Use language hints for syntax highlighting
struct page *page = alloc_pages(GFP_KERNEL, 0);
```

**Shell commands**
```bash
# Show what the command does with a comment
cat /proc/meminfo | grep -i huge
```

**Tables** for comparisons:
| Feature | Option A | Option B |
|---------|----------|----------|
| Speed   | Fast     | Slow     |
| Memory  | Low      | High     |

**Diagrams** using ASCII or Mermaid:
```
+-----------+      +-----------+
|  Process  |----->|  Kernel   |
+-----------+      +-----------+
```

```mermaid
graph LR
    A[User Space] --> B[System Call]
    B --> C[Kernel]
```

### Content Guidelines

**Do include:**

- Real kernel function names and structures
- Links to actual kernel commits when discussing changes
- Specific kernel versions when features were introduced
- "Try it yourself" sections with commands
- Common misconceptions and pitfalls
- Historical context for design decisions

**Don't include:**

- Speculation or unverified information
- Outdated information without noting it's outdated
- Copy-pasted content from other sources
- Marketing language or hype
- Commercial sources (vendor blogs, product documentation, sponsored content)

### Sourcing Claims

Every claim, opinion, or technical statement should be backed by verifiable sources:

**Acceptable sources:**

- Kernel commits (`git.kernel.org` only — not mirrors or forks)
- LKML threads (`lore.kernel.org`)
- Official kernel documentation (`docs.kernel.org`)
- LWN.net articles
- Conference talks (Linux Plumbers, Kernel Recipes, etc.)
- Academic papers
- Maintainer blog posts

**Not acceptable:**

- Commercial vendor documentation
- Product marketing materials
- Unsourced Stack Overflow answers
- AI-generated content without verification

When making a claim, link to the source:
```markdown
The buddy allocator coalesces free blocks to reduce fragmentation
([Knuth, TAOCP Vol 1](https://example.com), first implemented in
[commit abc123](https://git.kernel.org/...)).
```

### Linking to Kernel Source

When referencing kernel code:

- Link to [git.kernel.org](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/) for browsable source
- Use stable/latest kernel version unless discussing historical changes
- Include function signatures when introducing APIs

Example:
```markdown
The [`alloc_pages()`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/gfp.h)
function is the primary interface...
```

### Referencing Commits

When a feature was introduced or changed, link to the commit:

```markdown
This was introduced in kernel 5.18
([commit abc1234](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=abc1234):
"mm: add feature X").
```

## Technical Accuracy

### Verification

- Test commands before including them
- Verify kernel version information
- Cross-reference with official kernel documentation
- When unsure, note it: "As of kernel 6.x..." or "This may vary by configuration"

### Review Process

Reviewers will check for:

- Technical accuracy
- Clarity and readability
- Adherence to style guide
- Working code examples
- Proper linking and references

## Local Development

### Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/linux-kernel-internals.git
cd linux-kernel-internals

# Create virtual environment
python -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install mkdocs mkdocs-material

# Start local server
mkdocs serve
```

### Preview

Open `http://127.0.0.1:8000` to preview your changes. The server auto-reloads on file changes.

### Build

```bash
mkdocs build
```

Check for warnings in the build output.

## Commit Messages

Write clear, descriptive commit messages:

```
Add KASAN documentation

- Explain what KASAN detects
- Document configuration options
- Include example report analysis
```

**Do:**

- Use imperative mood ("Add" not "Added")
- Keep first line under 50 characters
- Explain what and why in the body

**Don't:**

- Include AI/assistant attribution
- Use vague messages like "Update docs"
- Include unrelated changes in one commit

## Questions?

- Open a [Discussion](https://github.com/laveeshb/linux-kernel-internals/discussions) for questions
- File an [Issue](https://github.com/laveeshb/linux-kernel-internals/issues) for bugs or suggestions

## License

By contributing, you agree that your contributions will be licensed under the same dual license as the project:

- Documentation: [CC BY-SA 4.0](https://github.com/laveeshb/linux-kernel-internals/blob/main/LICENSE-CC-BY-SA-4.0)
- Code examples: [GPL-2.0](https://github.com/laveeshb/linux-kernel-internals/blob/main/LICENSE-GPL-2.0)
