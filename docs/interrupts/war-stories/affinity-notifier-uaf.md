# The Affinity Notifier That Outlived Its Own Reference Count

> Replacing a callback and freeing the old one looked complete once the reference count hit zero — except the old callback could still be sitting in a workqueue, about to run on memory that had just been freed

Landed
:   Linux 5.2 (July 2019) · fix authored March 24, 2019

Authors
:   Prasad Sodagudi (author); Thomas Gleixner (applied the fix)

Heuristic/API introduced by
:   Ben Hutchings, `irq_set_affinity_notifier()`, January 2011 (Linux 2.6.39) — about eight years before this fix

Not a CVE

*Part of [War Stories: Interrupt and IRQ-Affinity Bugs](../war-stories.md).*

## Before state

`irq_set_affinity_notifier()` lets a driver register a callback that fires whenever an interrupt's CPU affinity changes. Because the notification itself has to happen outside the context where the affinity actually changed, the notifier's callback doesn't run inline — the kernel queues a `struct work_struct` to invoke it later, in ordinary process context. The notifier object is reference-counted with a `kref`, since both the interrupt subsystem and the still-pending work item can hold a reference to it at the same time.

## The trigger

When a driver calls `irq_set_affinity_notifier()` again to install a *new* notifier — replacing whatever was registered before — the function correctly drops the *old* notifier's reference count. If that drop takes the count to zero, `kref_put()` invokes the notifier's own `release` callback, freeing the memory the old notifier occupied. Nothing about that sequence checked whether the old notifier's work item was still sitting in a workqueue waiting to run.

## Observed behavior

If the old notifier's callback work was still queued at the moment its reference count hit zero, the memory it pointed to was freed while a workqueue thread still held a pending job to execute code inside it. When that job eventually ran, it operated on already-freed memory — a use-after-free that, depending on what had since reallocated that memory, could also corrupt whatever workqueue's own internal list-management state happened to overlap with the freed notifier's memory layout.

## Why it happened

The reference count itself wasn't the gap — the still-queued work item genuinely held one: `irq_set_affinity_locked()` calls `kref_get(&desc->affinity_notify->kref)` before it calls `schedule_work()`, and the callback, `irq_affinity_notify()`, ends with the matching `kref_put()` once it has run. What was missing was any synchronization between *that* lifecycle and the one `irq_set_affinity_notifier()` uses when a driver installs a replacement notifier. The replacement path dropped its own reference on the old notifier — potentially the reference that brought the count to zero and freed it — without first checking, or waiting for, whether the old notifier's work was still sitting in the workqueue. The fix's own commit message states the problem plainly: "nothing prevents the old notifier from remaining queued in the work list. If still queued, this creates a use-after-free... and potential work list corruption." A correctly-counted reference protects an object only for as long as something continues to hold it; it says nothing about *when* the last holder lets go relative to a still-outstanding use elsewhere, and closing that gap needed an explicit wait, not better counting.

## Resolution

The fix adds two lines: before calling `kref_put()` on the old notifier, `irq_set_affinity_notifier()` now calls `cancel_work_sync(&old_notify->work)` first. `cancel_work_sync()` blocks until the work item is guaranteed to either have already run to completion or never run at all, which means by the time `kref_put()` executes, nothing can still be pending against the notifier being freed.

This wasn't quite the end of the story. A year later, commit [`df81dfcfd699`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=df81dfcfd6991d547653d46c051bac195cd182c1) (Edward Cree, landed in Linux 5.7) found that this fix had traded the use-after-free for a reference leak: if `cancel_work_sync()` actually canceled outstanding work, that work's own `kref_get()` was never matched by a `kref_put()`, because the callback that would have released it never got to run. Current mainline handles this by checking `cancel_work_sync()`'s return value and putting the extra reference only when it reports having canceled real pending work:
```c
if (old_notify) {
        if (cancel_work_sync(&old_notify->work)) {
                /* Pending work had a ref, put that one too */
                kref_put(&old_notify->kref, old_notify->release);
        }
        kref_put(&old_notify->kref, old_notify->release);
}
```

## What it taught us

**Cancelling deferred work and releasing a reference are two separate operations, and getting the interaction right took two attempts.** The first fix correctly closed the use-after-free by cancelling the work before dropping the reference, but didn't account for the reference *that cancelled work itself was holding* — trading a crash for a slow leak.

**"Cancel the pending work before releasing what it touches" is the general shape of the fix, and it generalizes far beyond this one notifier — but only if the cancellation's own bookkeeping is accounted for too.** Any object that both participates in reference counting and can be the target of a still-queued deferred callback needs the cancel-then-release ordering, and needs to ask whether the callback itself held a reference that a successful cancellation now leaves stranded.

!!! warning "Pattern to watch for"
    Before freeing (or letting a `kref` free) any object that a work item, timer, or tasklet might still reference, ask whether that deferred mechanism was ever cancelled — and cancel it *synchronously*, not just requested-to-cancel, before the free happens. Then check the other direction too: if the deferred mechanism itself held a counted reference, a successful cancellation means that reference now needs to be released explicitly, since the callback that would have released it will never run.

## See also

- [Workqueues](../workqueues.md) — the deferred-execution mechanism the notifier's callback runs through

## External references

- [git.kernel.org: 59c39840f5ab](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=59c39840f5ab) — "genirq: Prevent use-after-free and work list corruption," the fix commit
- [git.kernel.org: df81dfcfd699](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=df81dfcfd6991d547653d46c051bac195cd182c1) — "genirq: fix reference leaks on irq affinity notifiers," Edward Cree's follow-up fix for the reference leak the first fix introduced
