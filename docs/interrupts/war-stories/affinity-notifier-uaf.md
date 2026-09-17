# The Affinity Notifier That Outlived Its Own Reference Count

> Replacing a callback and freeing the old one looked complete once the reference count hit zero — except the old callback could still be sitting in a workqueue, about to run on memory that had just been freed

Landed
:   Linux 5.2 (July 2019) · fix authored March 24, 2019

Authors
:   Prasad Sodagudi (author); Thomas Gleixner (applied the fix)

Not a CVE

*Part of [War Stories: Interrupts and Async Processing](../war-stories.md).*

## Before state

`irq_set_affinity_notifier()` lets a driver register a callback that fires whenever an interrupt's CPU affinity changes. Because the notification itself has to happen outside the context where the affinity actually changed, the notifier's callback doesn't run inline — the kernel queues a `struct work_struct` to invoke it later, in ordinary process context. The notifier object is reference-counted with a `kref`, since both the interrupt subsystem and the still-pending work item can hold a reference to it at the same time.

## The trigger

When a driver calls `irq_set_affinity_notifier()` again to install a *new* notifier — replacing whatever was registered before — the function correctly drops the *old* notifier's reference count. If that drop takes the count to zero, `kref_put()` invokes the notifier's own `release` callback, freeing the memory the old notifier occupied. Nothing about that sequence checked whether the old notifier's work item was still sitting in a workqueue waiting to run.

## Observed behavior

If the old notifier's callback work was still queued at the moment its reference count hit zero, the memory it pointed to was freed while a workqueue thread still held a pending job to execute code inside it. When that job eventually ran, it operated on already-freed memory — a use-after-free that, depending on what had since reallocated that memory, could also corrupt whatever workqueue's own internal list-management state happened to overlap with the freed notifier's memory layout.

## Why it happened

The reference-counting discipline here tracked one kind of ownership — "does anything still hold a pointer to this object" — but a queued work item's use of the object isn't expressed as a `kref` reference the way a live pointer held by another subsystem would be. The work item references the notifier implicitly, through the closure baked into the `struct work_struct` when it was queued, not through anything the `kref` accounting could see. Dropping the last *counted* reference and there being zero *actual* outstanding uses of the object are not automatically the same fact, whenever a mechanism that uses an object doesn't participate in the object's own reference-counting scheme.

## Resolution

The fix is a single added line: before calling `kref_put()` on the old notifier, `irq_set_affinity_notifier()` now calls `cancel_work_sync(&old_notify->work)` first. `cancel_work_sync()` blocks until the work item is guaranteed to either have already run to completion or never run at all, which means by the time `kref_put()` executes, nothing can still be pending against the notifier being freed.

## What it taught us

**A reference count only protects an object from things that actually take a reference to it.** A deferred-execution mechanism like a queued work item can hold an implicit, unaccounted use of an object's memory without ever incrementing the same `kref` that governs when that memory gets freed — and no amount of correctly reading and writing the counter catches that kind of gap, because the gap is in what the counter was tracking in the first place.

**"Cancel the pending work before releasing what it touches" is the general shape of the fix, and it generalizes far beyond this one notifier.** Any object that both participates in reference counting and can be the target of a still-queued deferred callback needs the cancel-then-release ordering, specifically because the two lifecycle mechanisms don't know about each other by default.

!!! warning "Pattern to watch for"
    Before freeing (or letting a `kref` free) any object that a work item, timer, or tasklet might still reference, ask whether that deferred mechanism was ever cancelled — and cancel it *synchronously*, not just requested-to-cancel, before the free happens. A reference count dropping to zero tells you what it was designed to track; it doesn't automatically account for every other way something in the kernel might still touch that memory.

## See also

- [IRQ Affinity and CPU Isolation](../irq-affinity.md) — where `irq_set_affinity_notifier()` and the affinity-change notification path live
- [Workqueues](../workqueues.md) — the deferred-execution mechanism the notifier's callback runs through

## External references

- [git.kernel.org: 59c39840f5ab](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=59c39840f5ab) — "genirq: Prevent use-after-free and work list corruption," the fix commit
