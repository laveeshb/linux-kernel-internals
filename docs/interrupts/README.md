# Interrupts and Async Processing

> How hardware events reach kernel code, and how deferred work gets done

## The interrupt problem

Hardware devices need to tell the CPU that something happened — a network packet arrived, a disk read completed, a timer expired. The CPU can't poll everything constantly, so hardware uses **interrupts**: a signal that stops whatever the CPU is doing and runs an interrupt handler.

But interrupt handlers must be fast — they run with interrupts (partially) disabled, blocking all other interrupts. So kernel design divides work into two halves:

```
Hardware interrupt
    │
    ▼
Top half (hardirq)     ← runs immediately, must be fast
  - Acknowledge interrupt
  - Copy data from device
  - Schedule bottom half

Bottom half            ← deferred, runs with interrupts enabled
  - Process the data
  - Complete the work
  - May sleep (workqueues only)
```

## Contents

### Fundamentals
- [Interrupt Handling Overview](interrupts.md) — From hardware to handler
- [IRQ Descriptor and irq_chip](irq-desc.md) — The kernel's interrupt abstraction
- [request_irq and free_irq](request-irq.md) — Registering interrupt handlers
- [Threaded IRQs](threaded-irq.md) — Moving work out of hardirq context

### Deferred Work (Bottom Halves)
- [Softirqs](softirq.md) — The lowest-level deferral mechanism
- [Tasklets](tasklets.md) — Per-CPU serialized softirq consumers
- [Workqueues](workqueues.md) — Process-context deferred work
- [Timers and hrtimers](timers.md) — Deferred work at a specific time

## Execution contexts

Understanding which context code runs in is critical for choosing the right locking:

| Context | `in_interrupt()` | May sleep? | Preemptible? |
|---------|-----------------|------------|--------------|
| Process context | false | Yes | Yes |
| Softirq | true | No | No |
| Hardirq | true | No | No |
| Threaded IRQ | false | Yes | Yes |
| Workqueue | false | Yes | Yes |

`in_interrupt()` returns true in both softirq and hardirq context. Use `in_irq()` for hardirq-only, `in_softirq()` for softirq-only.
