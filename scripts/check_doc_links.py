#!/usr/bin/env python3
"""Validate internal doc links AND anchor fragments across docs/.

`mkdocs build --strict` catches missing link *targets* but treats broken
`#anchor` fragments as INFO, not warnings — so it will not fail the build
on a wrong `#section` slug. This checker closes that gap: it resolves both
the file part and the `#anchor` part of every internal Markdown link,
using python-markdown's real `slugify` so anchors match what MkDocs emits.

It is deliberately fence-aware: code inside ``` fences and `inline code`
spans is skipped, so C like `sys_call_table[unr](regs)` is not mistaken
for a Markdown link `[...](regs)` (a false positive that has bitten this
repo's ad-hoc audits before).

Exit status: 0 if every internal link + anchor resolves, 1 otherwise.
"""
import glob
import os
import re
import sys

from markdown.extensions.toc import slugify

DOCS = "docs"
LINK_RE = re.compile(r'(?<!\!)\[[^\]]*\]\(([^)]+)\)')
FENCE_RE = re.compile(r'^\s*(```|~~~)')


def anchors_of(path):
    """Return the set of anchor slugs MkDocs will emit for `path`."""
    slugs, used, in_fence = set(), {}, False
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if FENCE_RE.match(line):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            heading = re.match(r'^#{1,6}\s+(.*?)\s*#*$', line.rstrip("\n"))
            if heading:
                slug = slugify(heading.group(1), '-')
                if slug in used:
                    used[slug] += 1
                    slug = f"{slug}_{used[slug]}"
                else:
                    used[slug] = 0
                slugs.add(slug)
            slugs.update(re.findall(r'\{#([\w-]+)\}', line))       # {#explicit}
            slugs.update(re.findall(r'<a[^>]+(?:id|name)="([^"]+)"', line))
    return slugs


def main():
    files = glob.glob(f"{DOCS}/**/*.md", recursive=True)
    anchors = {os.path.normpath(f): anchors_of(f) for f in files}
    broken = []

    for f in files:
        base = os.path.dirname(f)
        in_fence = False
        with open(f, encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                if FENCE_RE.match(line):
                    in_fence = not in_fence
                    continue
                if in_fence:
                    continue
                clean = re.sub(r'`[^`]*`', '', line)  # drop inline code spans
                for target in LINK_RE.findall(clean):
                    target = target.strip()
                    if target.startswith(('http://', 'https://', 'mailto:', '//')):
                        continue
                    if target.startswith('#'):
                        owner, anchor = os.path.normpath(f), target[1:]
                    else:
                        path_part, _, anchor = target.partition('#')
                        if not path_part:
                            continue
                        resolved = os.path.normpath(os.path.join(base, path_part))
                        if not path_part.endswith('.md'):
                            if not os.path.exists(resolved):
                                broken.append((f, lineno, target, "missing-target"))
                            continue
                        if not os.path.exists(resolved):
                            broken.append((f, lineno, target, "missing-file"))
                            continue
                        owner = resolved
                    if anchor and owner in anchors and anchor not in anchors[owner]:
                        broken.append((f, lineno, target, "missing-anchor"))

    for src, lineno, target, kind in broken:
        print(f"{kind:14} {src}:{lineno}  ->  {target}")
    print(f"\nScanned {len(files)} files; {len(broken)} broken internal link(s)/anchor(s).")
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
