# About

[kernel-internals.org](https://kernel-internals.org) is a reference for the *design rationale* behind the Linux kernel — not "here's the struct and the function," but "here's the problem, what was tried first, why the current design won, and what it costs."

## Why this exists

The kernel is exhaustively documented, yet the material is oddly split. [docs.kernel.org](https://docs.kernel.org) is authoritative reference — it tells you *what* a thing is and *how* to use it, not *why* it is built that way. [LWN](https://lwn.net) is the best writing anywhere on the *why*, but it is news-shaped: tied to a particular patch series, organized by when things happened rather than by subsystem. The reasoning behind the design — the trade-offs, the alternatives that were rejected, the mailing-list arguments that settled it — ends up scattered across commits and threads.

This site pulls that reasoning together and organizes it by subsystem, so you can sit down and understand not just how the kernel works, but why it works that way. It is meant to complement docs.kernel.org, not compete with it.

## How it stays honest

- **Every claim traces to a primary source** — a specific commit on [git.kernel.org](https://git.kernel.org), an [LWN](https://lwn.net) article, or a [lore.kernel.org](https://lore.kernel.org) thread. If a claim cannot be cited, it does not belong on the site, and where something is summarized the original is one click away.
- **Cross-references do not rot** — continuous integration fails the build on any broken internal link or anchor, so as the site grows the links between pages stay honest.
- **Content reflects a specific kernel snapshot** — pages are fact-checked against Linux mainline as of a point-in-time commit (currently [`f5bbbfec59b4`](https://github.com/torvalds/linux/commit/f5bbbfec59b4e2fb7520a91de3df8a6174325d6a), August 2026, v7.2-rc7), updated periodically. Individual pages cite the specific kernel version each claim is true as of, so a page being slightly behind current mainline doesn't make it wrong — just possibly missing the newest development.

## Getting involved

The site is open source — the full source and history live on **[GitHub](https://github.com/laveeshb/linux-kernel-internals)**. Contributions are welcome:

- **Corrections** — if a *why* is wrong, please say so. A confidently wrong explanation is worse than none.
- **Requests** — a subsystem or topic you would like covered? [Start a discussion](https://github.com/laveeshb/linux-kernel-internals/discussions).
- **Contributions** — see the [Contributing guide](contributing.md); the [open issues](https://github.com/laveeshb/linux-kernel-internals/issues) track what is next.

## License

- Documentation: [CC BY-SA 4.0](https://github.com/laveeshb/linux-kernel-internals/blob/main/LICENSE-CC-BY-SA-4.0)
- Code snippets: [GPL-2.0](https://github.com/laveeshb/linux-kernel-internals/blob/main/LICENSE-GPL-2.0)

---

Created and maintained by [Laveesh Bansal](https://laveeshb.com).
