# The Vector Leak That Needed Two CPUs to Go Offline in the Wrong Order

> A deferred interrupt-affinity change, a CPU that goes offline before its cleanup work runs, and a fix that had shipped seven years of "modernized" vector management still didn't fully close

Landed
:   Linux 6.10 (July 2024) · fix authored May 22, 2024

Authors
:   Dongli Zhang (report and fix)

CVE
:   CVE-2024-31076

*Part of [War Stories: Interrupt and IRQ-Affinity Bugs](../war-stories.md).*

## Before state

On x86, moving an interrupt's affinity away from a CPU is not instantaneous. Changing affinity through procfs without the `IRQD_MOVE_PCNTXT` flag defers the actual move: the kernel waits until the interrupt next fires on its *current* CPU, and only then does `__irq_move_irq()` allocate a vector on the new CPU and mark the old one for cleanup via `apicd->move_in_progress`. The old vector isn't freed immediately, because doing so before the in-flight interrupt is guaranteed to be fully handled risks the same interrupt racing with itself across two CPUs. Freeing it is left for later, once the *new* CPU proves it received the interrupt.

## The trigger

That "later" is where the design has a gap. When the interrupt fires again — now on the new CPU — `irq_complete_move()` records the old CPU's stale vector on that old CPU's own `vector_cleanup` list, so a per-CPU timer running there can reclaim it in due course. That reclamation only happens if the old CPU is still online to run its own cleanup timer. If the old CPU is hot-unplugged before the interrupt ever fires again on the new CPU, nothing has queued the cleanup yet, and the CPU going away should have triggered `irq_force_complete_move()` as a fallback — except that function only fires for interrupts the offlining code still considers affine to the outgoing CPU. Because the affinity change had *already* been recorded as pointing at the new CPU, `irq_needs_fixup()` returns false, and the outgoing CPU's cleanup path skips this interrupt entirely, believing there's nothing left to do for it.

## Observed behavior

The stale vector is now stranded. `__vector_schedule_cleanup()` does still run for it later, triggered from the new CPU's side of the machinery — but by that point the outgoing CPU is already gone, so the function has no vector to actually reclaim; it can only reset `apicd->move_in_progress` and `apicd->prev_vector` back to zero and move on. The bookkeeping is cleared, but the vector itself was never returned to `vector_matrix`, the allocator that tracks which of a CPU's limited interrupt vectors are in use. Each time this sequence repeats — an affinity change deferred, then the source CPU offlined before the interrupt fires again on the destination — one more vector is lost. On a system that offlines and re-onlines CPUs routinely (a common pattern for power management, live-migration prep, or NUMA rebalancing), the leak compounds until vector space on some CPU is exhausted and new interrupts can no longer be assigned there at all.

## Why it happened

This is a race between two independent lifecycles that the code was tracking with local, per-path assumptions rather than a single source of truth: the "has this interrupt's move actually completed" state, and the "is this CPU about to disappear" state. Each individual check — `irq_needs_fixup()`'s affinity test, `irq_complete_move()`'s deferred-cleanup scheduling — is locally correct for the ordering it was written to expect. The bug only appears in the specific interleaving where a CPU offline event lands in the narrow window after an affinity change has been recorded but before the interrupt has fired even once on its new target.

That window predates the `vector_matrix`/`apicd`-based design most of the rest of this page's incidents live in. The fix's own `Fixes:` tag points to [`f0383c24b485`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=f0383c24b4855f6a4b5a358c7b2d2c16e0437e9b) (Thomas Gleixner, June 2017, "genirq/cpuhotplug: Add support for cleaning up move in progress"), which landed in Linux 4.13 — the generic `irq_needs_fixup()`/`irq_force_complete_move()` machinery this bug's race lives in didn't exist before that commit at all. The [2017 rework of x86 vector management](https://lwn.net/Articles/733618/) that introduced today's `vector_matrix`/`apicd`-based design came slightly later, in Linux 4.15, and inherited this specific race rather than introducing it. Both changes were motivated by the same underlying problem — CPU-offline and hibernation fragility in vector management — which shows how much of this problem space is inherently about ordering CPU-lifecycle events against in-flight interrupt state, not about any one implementation being sloppy.

## Resolution

The fix reorders the outgoing-CPU cleanup path so `irq_force_complete_move()` runs *before* the `irq_needs_fixup()` affinity check, for any interrupt that is currently affine to the outgoing CPU *or* used to be — closing the exact gap the stale affinity record was hiding behind. As a second line of defense, `__vector_schedule_cleanup()` was also changed to reclaim the vector itself (with a warning) if it's ever invoked in the state this bug produced, even though the reordering should mean that path is never taken anymore in practice.

## What it taught us

**Cleanup-on-teardown code paths need to check both possible orderings of the events they're racing against, not just the common one.** The common case — an interrupt fires again before its old CPU goes offline — was handled correctly from the start. The bug lived entirely in the far less common, harder-to-hit ordering, which is exactly the kind of path that survives code review and normal testing for years.

**A major rewrite of a subsystem doesn't retire the class of bug the rewrite was meant to fix — it just changes which specific race is still open.** Both the generic cpuhotplug fixup machinery this bug lives in and the x86-specific vector-management rework that came a couple of months later were responses to the same underlying CPU-offline-related fragility. Seven years after the first of those fixes, a CPU-offline-related bug was still there, just in a narrower, harder-to-trigger form.

!!! warning "Pattern to watch for"
    Any deferred cleanup that depends on "the thing I'm waiting for will eventually happen" needs an explicit answer for "what if the resource I'm waiting to clean up on disappears first." If that answer lives in a different code path (here, CPU hotplug) than the one doing the deferring (here, interrupt affinity), audit the interaction directly — each path can be independently correct and still leak when the two overlap.

## See also

- [IRQ Affinity and CPU Isolation](../irq-affinity.md) — the affinity-configuration interface this bug's trigger goes through
- [The Warning That Vector Space Was Silently Breaking Affinity](vector-exhaustion-silent-affinity-break.md) — a different bug in the same vector-allocation machinery, from the same era of the codebase

## External references

- [git.kernel.org: a6c11c0a5235](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=a6c11c0a5235) — "genirq/cpuhotplug, x86/vector: Prevent vector leak during CPU offline," the fix commit, with the full root-cause writeup in its own commit message
- [NVD: CVE-2024-31076](https://nvd.nist.gov/vuln/detail/CVE-2024-31076) — the CVE record, which reproduces the fix commit's description in full
- [git.kernel.org: f0383c24b485](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=f0383c24b4855f6a4b5a358c7b2d2c16e0437e9b) — "genirq/cpuhotplug: Add support for cleaning up move in progress," the June 2017 commit (Linux 4.13) the fix's own `Fixes:` tag points to, and the actual origin of the generic fixup machinery this bug's race lives in
- [LWN: x86: Rework the vector management](https://lwn.net/Articles/733618/) — Thomas Gleixner's September 2017 cover letter for the 52-patch series that introduced the `vector_matrix`/`apicd` design (Linux 4.15), a few months after and separate from the commit above, explicitly motivated in part by CPU-offline and hibernation fragility in the prior implementation
