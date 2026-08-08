# Foundations

The groundwork the rest of the kernel builds on: how it boots, meets the hardware, exposes itself to user space, and keeps time.

- [Architecture (arch/)](../arch/arm64/README.md) — where the kernel meets the hardware: boot, CPU features, exceptions, and per-arch specifics (x86, arm64)
- [System Calls (syscalls/)](../syscalls/README.md) — how user space crosses into the kernel and back
- [Modules (modules/)](../modules/README.md) — loading, linking, and unloading kernel code at runtime
- [Time (time/)](../time/README.md) — clocks, timers, ticks, and how the kernel keeps and measures time
