# The Warning That Vector Space Was Silently Breaking Affinity

> An administrator sets an interrupt's CPU affinity, the kernel silently overrules it when the CPUs they picked have run out of vectors, and for over a decade there was no way to find out from the syslog that it had happened

Landed
:   Linux 5.4 (November 2019) · fix authored August 22, 2019

Authors
:   Neil Horman (fix); reported and tested by a Red Hat-affiliated reporter (`djuran@redhat.com`, per the commit's `Reported-by`/`Tested-by` tags)

Not a CVE

*Part of [War Stories: Interrupts and Async Processing](../war-stories.md).*

## Before state

Each x86 CPU has 256 interrupt vectors total, and most of them aren't available for devices: 32 are reserved by the architecture for CPU exceptions and traps, and the kernel itself reserves another 22 for internal purposes like IPIs and the local APIC timer. That leaves 202 vectors per CPU that can actually be assigned to device interrupts. When an interrupt is set up, or its affinity is changed by the kernel or an administrator, the vector-assignment code tries to honor the requested affinity mask by allocating a free vector on one of the CPUs in that mask.

## The trigger

On a system with many high-interrupt-count devices — multi-queue NICs and storage controllers on a large-core-count machine are the common case — it's entirely possible for every CPU in a requested affinity mask to already have all 202 of its assignable vectors in use. When that happens, the vector-assignment code doesn't fail the request. It falls back silently to a wider set of CPUs outside the one the administrator asked for, and assigns the interrupt there instead.

## Observed behavior

The actual, in-effect affinity was never hidden — it's always been readable from `/proc/irq/$N/effective_affinity` — but nothing wrote to the kernel log when the fallback happened, so there was no indication that a requested affinity change had silently failed. An administrator pinning interrupts for a latency-sensitive or NUMA-aware workload would set the affinity they wanted, see no error, and have no reason to go check `effective_affinity` against what they'd asked for — until performance on the "pinned" workload didn't match expectations, at which point tracking the mismatch back to vector exhaustion elsewhere in the system required already suspecting this specific failure mode. The fix's own `Reported-by`/`Tested-by` tags credit a real reporter who hit this and verified the fix, though the changelog doesn't spell out their exact workload.

## Why it happened

This isn't a bug in the sense of incorrect behavior — the fallback itself is arguably the right thing to do, since refusing to deliver the interrupt at all would be worse than delivering it on a CPU outside the requested set. The gap was purely observability: a code path can be functioning exactly as designed and still leave an administrator with no way to learn that the system quietly overrode their explicit request. Whether that counts as a bug or a missing feature is a matter of framing, but from the administrator's side the effect was identical to a silent failure.

## Resolution

Neil Horman's fix adds a single check to `activate_reserved()`, the function that finalizes a reserved interrupt's vector assignment: if the interrupt's effective affinity mask isn't a subset of the affinity mask that was actually requested, it now logs `pr_warn("irq %u: Affinity broken due to vector space exhaustion.\n", ...)`. Thomas Gleixner, who carried the patch into mainline, describes his own role as having "massaged [the] changelog and made the `pr_warn()` more informative" — the underlying diagnosis and fix came from Horman, working from a reported case that had been reproduced and tested against the fix before it merged.

## What it taught us

**A code path can be entirely correct and still constitute a bug from the operator's point of view, if it changes behavior with no way to observe that it happened.** The fallback-to-a-wider-CPU-set logic wasn't wrong; the absence of any log line when it triggered was the actual problem, and it took a real reported case — not a crash, not a test failure — to surface it.

**"The information is technically available somewhere" is not the same as "the information will be found."** `effective_affinity` had always told the truth. What was missing was anything that would prompt someone to go look at it in the first place.

!!! warning "Pattern to watch for"
    Any code path that silently falls back to a different resource than what was requested — a different CPU, a different memory node, a different device — is a debugging trap waiting to happen, even if the fallback logic itself is sound. If the request can silently not be honored, log it once, even at a low level; the cost of one `pr_warn()` is far lower than the cost of an administrator not knowing where to look.

## See also

- [IRQ Affinity and CPU Isolation](../irq-affinity.md) — the affinity-configuration interface and `effective_affinity` file this bug involves
- [The Vector Leak That Needed Two CPUs to Go Offline in the Wrong Order](vector-leak-cpu-offline.md) — a different bug in the same vector-allocation machinery, five years later

## External references

- [git.kernel.org: 743dac494d61](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=743dac494d61) — "x86/apic/vector: Warn when vector space exhaustion breaks affinity," the fix commit, including the 202-vector accounting and Gleixner's note on carrying the patch
