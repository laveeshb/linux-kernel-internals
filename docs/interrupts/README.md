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

## Why five deferred-work mechanisms, not one

That two-half split is the easy part. The harder question — one a newcomer to this part of the kernel reasonably asks — is why there are *five* different ways to implement the "bottom half" box above (softirqs, tasklets, workqueues, threaded IRQs, timers/hrtimers), rather than one obvious answer. The short version: each one exists because an earlier mechanism turned out to be wrong for some real workload, and rather than replace the old one outright, the kernel usually kept it and added a new option alongside it. The [Softirqs](softirq.md#from-bottom-halves-to-softirqs-to-threaded-irqs) page tells that lineage in full — the original single-lock "bottom half" (BH) mechanism from Linux 2.0–2.3 serialized *all* deferred work behind one global spinlock, which became an SMP scalability wall; softirqs replaced it by letting different deferred-work types run in parallel on different CPUs; tasklets then gave drivers a softirq-like mechanism without requiring every driver author to write reentrant, per-CPU-safe code.

None of those three can sleep, though, and by the mid-2000s a growing set of drivers genuinely needed to — I2C and SPI reads, anything that has to take a mutex. That gap is what [threaded IRQs](threaded-irq.md#where-this-actually-came-from) and [workqueues](workqueues.md) fill, and threaded IRQs in particular have a specific, verifiable origin worth knowing up front: mainline didn't invent the idea in 2009, it imported one the out-of-tree [PREEMPT_RT](../locking/preempt-rt.md) patch set had already been relying on for years, because RT's whole premise — bounded worst-case latency — is incompatible with anything running for long with interrupts fully disabled. The same pattern shows up twice more in this subsystem: [hrtimers](timers.md#hrtimer-high-resolution-timers) exist because integrating high-resolution timer patches into the RT tree forced a real answer to "how does Linux represent a point in time precisely, across architectures," where before there had only been a scatter of single-purpose, single-architecture patches; and much of the pressure behind [deprecating tasklets](tasklets.md#the-deprecation-nobody-planned-to-start-then-couldnt-finish) in favor of threaded IRQs came from the same Linutronix-affiliated engineers (Thomas Gleixner, Sebastian Andrzej Siewior) who built and maintained the RT tree, because tasklets — atomic-context-only, unable to sleep or be preempted — are exactly the kind of thing RT's model has no room for.

None of this means the older mechanisms disappeared. Softirqs still exist because a handful of very hot paths (networking's `NET_RX_SOFTIRQ`, in particular) genuinely can't afford a thread-scheduling round trip; tasklets are still in the tree, deprecated but not removed, because a few drivers (AMD's `ccp` crypto engine, Intel's `i915` GPU driver) combine them with other mechanisms in ways that resist a one-line conversion. What you're looking at across these pages is less a single coherent design than five answers accumulated over roughly three decades, each solving the specific problem in front of its author at the time — with the out-of-tree realtime effort acting as an unusually persistent source of pressure to eventually generalize the ad hoc fix into something every driver could use.

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

### War stories
- [War Stories](war-stories.md) — two CVEs and two long-standing bugs in the IRQ-affinity and vector-allocation machinery

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
