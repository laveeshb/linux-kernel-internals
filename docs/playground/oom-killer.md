---
hide:
  - navigation
  - toc
---

# Ever had a browser tab just vanish?

You're low on memory. Something has to go. **You decide what runs — the kernel decides what dies.**

<div id="oom-game"></div>

Want to see this for real, not simulated? The
[OOM killer sandbox](https://github.com/laveeshb/linux-kernel-internals/tree/main/sandbox/oom-vm)
boots an actual Linux kernel in a disposable VM on your own machine and streams the genuine kernel
log as it runs out of memory for real. Or read the [debugging playbook](../mm/oom-debugging.md)
for spotting an OOM kill on a real, running system.
