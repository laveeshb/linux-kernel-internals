# Scheduling & Concurrency

How the kernel shares CPUs among competing tasks and keeps concurrent code correct.

- [Scheduler (sched/)](../sched/README.md) — how the kernel decides which task runs next, and when
- [Locking (locking/)](../locking/README.md) — the primitives that keep concurrent code correct: spinlocks, mutexes, RCU
- [Interrupts (interrupts/)](../interrupts/README.md) — handling hardware events and safely deferring work
- [IPC (ipc/)](../ipc/README.md) — how processes communicate: pipes, signals, shared memory, message queues
