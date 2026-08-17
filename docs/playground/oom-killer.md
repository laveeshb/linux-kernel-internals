---
hide:
  - navigation
  - toc
---

# Ever had a browser tab just vanish?

You're low on memory. Something has to go. **You decide what runs — the kernel decides what dies.**

<div id="oom-game"></div>

Curious what actually happened just now? The kernel didn't pick at random — it scored every
process and killed the one it judged least essential to keep alive. Read how that scoring
really works in [Running out of memory](../mm/oom.md), or see the [debugging playbook](../mm/oom-debugging.md)
for spotting it happening on a real machine.
