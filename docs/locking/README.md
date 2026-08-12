# Locking and Synchronization

> How the Linux kernel serializes concurrent access to shared data

## Why locking matters

Linux runs on systems with hundreds of CPUs, all sharing kernel data structures. Without synchronization, two CPUs could simultaneously modify a linked list — corrupting its pointers, losing entries, or looping forever. Locking prevents this.

The kernel provides a rich set of primitives, each with different performance characteristics and usage contexts:

| Primitive | Sleeps? | IRQ-safe? | Use when |
|-----------|---------|-----------|----------|
| `raw_spinlock_t` | No | Yes | Must not sleep, IRQ context |
| `spinlock_t` | No (RT: yes) | No | Process context, short critical sections |
| `mutex_t` | Yes | No | Process context, longer critical sections |
| `rw_semaphore` | Yes | No | Many readers, few writers |
| `rwlock_t` | No | Yes | Many readers, IRQ context |
| RCU | No (readers) | Yes (readers) | Read-heavy, pointer-based data |
| `seqlock_t` | No | Yes | Small data, writers must not starve |

## Contents

### Fundamentals
- [Spinlock and raw_spinlock](spinlock.md) — The atomic building block
- [Mutex and rt_mutex](mutex.md) — Sleeping locks for process context
- [rwlock and rwsem](rwlock-rwsem.md) — Reader-writer locking
- [RCU (Read-Copy-Update)](rcu.md) — Lock-free reads via grace periods
- [Seqlock](seqlock.md) — Sequence counters for small frequently-read data

### Advanced
- [Atomic operations and memory barriers](atomics.md) — The primitives beneath the primitives
- [Per-CPU variables](percpu.md) — Eliminating shared state entirely
- [Lockdep](lockdep.md) — The kernel's lock validator
- [Lock contention debugging](lock-debugging.md) — Diagnosing lock hotspots
- [Futex internals](futex.md) — How userspace locking works

### War stories
- [War Stories](war-stories.md) — three CVEs and one origin story from rt_mutex and PI-futexes

## The hierarchy: what can nest inside what

```
Hardware interrupts (NMI)
    └── can only use: raw_spinlock (irqsave), atomic ops
Hardware interrupts (IRQ)
    └── can use: raw_spinlock (irqsave), rwlock (irqsave), seqlock
Softirqs / tasklets
    └── can use: spinlock (bh), rwlock (bh), RCU read side
Process context (preemptible)
    └── can use: everything, including mutex, semaphore, RCU
```

Never call a sleeping lock from interrupt context — the kernel will warn or deadlock.
