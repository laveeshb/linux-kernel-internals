# War Stories: Interrupt and IRQ-Affinity Bugs

> Four incidents in the machinery that decides which CPU handles an interrupt and cleans up after it moves — two CVEs, one two-year silent-failure gap, and one use-after-free in a rarely-exercised notifier path that took two separate fixes to fully close

Interrupt affinity is deceptively simple from the outside — "run this interrupt's handler on that CPU" — and genuinely intricate underneath, because changing it safely means coordinating in-flight interrupt delivery, per-CPU vector allocation, CPU hotplug, and (for drivers that want to know) an asynchronous notification callback, all without ever leaving a window where the same interrupt could be handled twice or a resource freed while something still points at it. Every incident below lives in that coordination layer, not in interrupt handling itself.

## Incidents

Ordered reverse chronologically by when the fix landed in mainline — newest first.

### [The Vector Leak That Needed Two CPUs to Go Offline in the Wrong Order](war-stories/vector-leak-cpu-offline.md)
**Linux 6.10 (July 2024) · CVE-2024-31076**
A deferred interrupt-affinity change and a CPU hot-unplug, interleaved in one specific rare order, meant one x86 interrupt vector was never returned to `vector_matrix` — a slow leak, one vector at a time, on systems that offline and re-online CPUs routinely.

### [The IPI Verifier That Trusted Its Own Caller](war-stories/ipi-send-verify-null-deref.md)
**Linux 6.3 (April 2023) · CVE-2023-53332**
`ipi_send_verify()` dereferenced its `irq_data` parameter before checking whether that parameter was `NULL` — an invalid IPI interrupt number turned a clean error return into a kernel oops.

### [The Warning That Vector Space Was Silently Breaking Affinity](war-stories/vector-exhaustion-silent-affinity-break.md)
**Linux 5.4 (November 2019) · not a CVE**
When every CPU in a reserved affinity mask had exhausted its 202 assignable interrupt vectors, activating the interrupt silently widened the mask with no log message — for about two years, an administrator had no way to learn their affinity request had been quietly overruled.

### [The Affinity Notifier That Outlived Its Own Reference Count](war-stories/affinity-notifier-uaf.md)
**Linux 5.2 (July 2019) · not a CVE**
Replacing an affinity-change notifier dropped the old one's reference count without checking whether its callback was still sitting in a workqueue — a use-after-free waiting for a very specific timing window to be hit.

## Common threads

| Pattern | Vector leak (CPU offline) | IPI verifier NULL deref | Vector exhaustion warning | Affinity-notifier UAF |
|---------|:---:|:---:|:---:|:---:|
| Involves interrupt CPU-affinity machinery specifically | Yes | Yes (IPI targeting) | Yes | Yes |
| Root cause: two independently-correct code paths racing against each other | Yes | No | — | No |
| Root cause: validation ordered after the operation it should have gated | No | Yes | — | No |
| Root cause: a release not synchronized against a still-outstanding deferred use | No | No | — | Yes |
| Is a security vulnerability (has a CVE) | Yes | Yes | No | No |
| Fix changed behavior, not just added a diagnostic | Yes | Yes | No (diagnostic only) | Yes |
| Years between introduction and fix | 7 (2017 → 2024) | ~7 (2015 → 2023) | ~2 (2017 → 2019) | ~8 (2011 → 2019) |

**Two of these four are architecturally related.** The vector leak and the vector-exhaustion warning both live in the same x86 per-CPU vector allocator, separated by five years — one is about a resource silently *falling back* to a different CPU when space runs out, the other is about a resource silently *not being reclaimed* after a CPU goes away. Neither is a mistake in the other's fix; they're two different failure modes in the same limited-resource-management problem, discovered independently.

**The IPI verifier bug and the affinity-notifier bug are both, in different ways, stories about validation and cleanup happening in the wrong order relative to the operation they were meant to guard.** The IPI verifier read a value from an unchecked pointer before checking the pointer — fixed by reordering a small number of lines. The affinity-notifier bug released a reference before confirming a deferred user of that reference had actually finished — fixed by adding a synchronous cancellation, not by reordering existing code, and it took a second fix a year later to also account for the reference that cancellation itself was holding. In both cases, the hard part was recognizing that an ordering assumption, not a missing check, was the actual bug.

**Only one of the four incidents here — the vector-exhaustion warning — isn't a "wrong behavior" bug at all.** The silent CPU-set fallback it made visible was arguably correct behavior; the gap was purely that nothing told an administrator it had happened. It's the only incident on this page whose fix is a single diagnostic line rather than a change to what the kernel actually does.

## See also

- [Interrupt Handling Overview](interrupts.md) — the top/bottom-half split and execution contexts these bugs assume
- [IRQ Affinity and CPU Isolation](irq-affinity.md) — the affinity-configuration interface three of the four incidents involve directly
- [Locking War Stories](../locking/war-stories.md) — a comparable set of kernel-internal bugs from priority-inheritance and rt_mutex bookkeeping, a different kind of cross-subsystem coordination problem
