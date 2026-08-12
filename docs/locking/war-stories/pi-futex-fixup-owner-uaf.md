# The PI-Futex Fixup That Had No Answer for a Permanent Fault

> CVE-2021-3347 — when the kernel couldn't write the new owner's TID back into a PI futex word, it gave up without making its own rt_mutex and pi_state agree on who owned the lock, and a subsequent unlock on that mismatch corrupted a waiter structure still resident on another task's kernel stack

Disclosed
:   January 29, 2021 (CVE reserved and published same day, NVD)

Reported by
:   gzobqq@gmail.com (per the fix commit's `Reported-by:` trailer)

CVSS
:   7.8 HIGH (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`)

Bug present since
:   2.6.26 (2008), when `fixup_pi_state_owner()`'s retry-on-fault logic was introduced

Fixed in
:   commit `34b1a1ce1458`, part of a 7-patch PI-futex series merged into Linus's tree January 28, 2021; first released as part of Linux 5.11-rc6 (January 31, 2021)

Exploit tool
:   no public PoC found

Actively exploited
:   no confirmed cases (not on CISA KEV)

*Part of [War Stories: Locking and Synchronization Bugs](../war-stories.md).*

## Before state

A PI (priority-inheritance) futex ties three things together, and the kernel's own documentation states plainly that they must never disagree: the TID written in the userspace futex word, `pi_state->owner`, and the owner field inside the attached kernel `rt_mutex`. `fixup_pi_state_owner()` exists to restore that agreement at the one place it can legitimately drift — after a fault-handling retry — before the task returns to userspace.

`1b7558e457ed` ("futexes: fix fault handling in futex_lock_pi"), from 2008, gave this function its central retry pattern: write the new owner's TID into the userspace futex word, and if that write faults — because the page was swapped out or a COW fault needs resolving — drop the hash-bucket lock, call `futex_handle_fault()` (later renamed `fault_in_user_writeable()`) to fault the page back in, and retry. That handled the *transient* case, which was the only case the commit's author had reason to think about: a fault that resolves once the page is back.

## The trigger

Not every fault resolves. If `fault_in_user_writeable()` itself fails — the mapping is genuinely gone, unwritable, or otherwise permanently broken — the 2008 code had no second plan. It returned `-EFAULT` and left the rtmutex and pi_state owner fields exactly where they'd been before the (never-completed) userspace write: potentially still pointing at the *previous* owner, while the *new* owner was left holding the rt_mutex or believing it owned the futex. The three-way invariant — userspace TID, `pi_state->owner`, rt_mutex owner — was now violated, with no path back to consistency and no code that treated this outcome as anything other than an ordinary, resolvable retry failure.

## Observed behavior

A subsequent `futex_unlock_pi()` trusts `pi_state` to decide what to unlock. Operating on the now-inconsistent state, it could release an rt_mutex the calling task didn't actually own — corrupting the rt_mutex's internal waiter rbtree. The fix commit states the consequence directly: this "can corrupt the RB tree of the rtmutex and cause a subsequent kernel stack use after free." An `rt_mutex_waiter` normally lives on a *blocked task's own kernel stack* for the duration of the block; unlocking a mutex that task didn't actually still legitimately hold could free (or otherwise invalidate) a waiter structure that a still-running or since-returned task's stack region was relying on staying valid — a use-after-free reachable from ordinary PI-futex usage, no special privileges required beyond being able to create the racing fault condition in the first place.

## Why it happened

The 2008 fix was correct about the problem it set out to solve — a real, observed failure in "highly threaded java apps on large SMP systems" caused by a resolvable race between a futex unlock and a concurrent fork or page swap. It reasoned carefully about *that* fault, and built a retry loop that handled it. It just never considered the fault that *doesn't* resolve — a case the original bug report didn't produce, so nothing forced anyone to ask "and what if `fault_in_user_writeable()` itself fails?" The gap wasn't sloppiness in the retry logic; it was a genuinely unconsidered branch of the state space, one that stayed latent for thirteen years until a review of the PI-futex fault paths specifically went looking for it.

## Resolution

`34b1a1ce1458` ("futex: Handle faults correctly for PI futexes") replaces "give up and leave things inconsistent" with "give up and make the *kernel's own* state consistent, even though userspace can't be fixed." When the userspace write is unrecoverable, the fix now calls `pi_state_update_owner(pi_state, rt_mutex_owner(&pi_state->pi_mutex))` — pinning `pi_state->owner` to whatever the rt_mutex itself actually says, rather than leaving the two to disagree. Userspace's futex word is left wrong, but any *subsequent* operation on that futex will now correctly fail, per the same invariant table this bug violated, rather than operating on a lock whose kernel-side bookkeeping was already split. The commit also removes a separate, similarly-dangerous fixup path in `futex_lock_pi()`/`futex_wait_requeue_pi()` that could unconditionally call `rt_mutex_futex_unlock()` on a `pi_state` in this same inconsistent condition.

## What it taught us

**A retry loop is only as safe as its "retry failed permanently" branch — and that branch is easy to leave unwritten if the original bug report never exercised it.** The 2008 fix handled every fault its authors could reproduce. The 2021 fix handled the one fault type nobody had reproduced yet: a `fault_in_user_writeable()` call that itself doesn't succeed.

**When kernel state and userspace state can't both be fixed, fix the one that other kernel code depends on being correct.** Userspace's futex word was going to be wrong either way once the mapping was genuinely broken — the fix's real insight was that leaving the *kernel's* internal bookkeeping consistent is what actually matters, since it's the kernel's own unlock path, not userspace, that trusts `pi_state` unconditionally.

!!! warning "Pattern to watch for"
    Any retry-on-fault loop that assumes the fault will eventually resolve needs an explicit, audited answer for the case where it doesn't — not just an early return that leaves partially-updated cross-referencing state (here: three fields across two structures) out of sync. If two or more pieces of state must agree by invariant, a fault-handling bailout path is exactly where that invariant is easiest to silently break.

## See also

- [Locking Overview](../README.md) — spinlocks, rt_mutex, and the priority-inheritance machinery this bug lives in
- [The PI-Mutex Origin Story](pi-mutex-origin.md) — how rt_mutex and PI futexes came to exist in the first place
- [The rt_mutex Deadlock Detector's Atomic-Sleep Bug](rtmutex-deadlock-detector-atomic-sleep.md) — a second rt_mutex correctness bug, on the deadlock-detection side rather than the fixup side

## External references

- [GitHub mirror: 34b1a1ce1458](https://github.com/torvalds/linux/commit/34b1a1ce1458f50ef27c54e28eb9b1947012907a) — "futex: Handle faults correctly for PI futexes," the fix
- [GitHub mirror: 1b7558e457ed](https://github.com/torvalds/linux/commit/1b7558e457ed0de61023cfc913d2c342c7c3d9f2) — "futexes: fix fault handling in futex_lock_pi," the 2008 commit whose retry logic never covered a permanent fault
- [oss-security: Linux Kernel local priv escalation via futexes](https://www.openwall.com/lists/oss-security/2021/01/29/1) — Marcus Meissner's CVE request, quoting the merge that introduced the fix
- [NVD: CVE-2021-3347](https://nvd.nist.gov/vuln/detail/CVE-2021-3347) — CVE record, CVSS 7.8 HIGH, published January 29, 2021
