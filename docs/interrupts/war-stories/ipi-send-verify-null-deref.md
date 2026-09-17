# The IPI Verifier That Trusted Its Own Caller

> A validation function meant to catch bad interrupt handles read one of its own fields before checking whether that field existed, turning an invalid IPI number into a kernel oops instead of a clean error

Landed
:   Linux 6.3 (April 2023) · fix authored August 17, 2022

Authors
:   Sergey Shtylyov

CVE
:   CVE-2023-53332

*Part of [War Stories: Interrupts and Async Processing](../war-stories.md).*

## Before state

Sending an inter-processor interrupt through the generic IPI layer — `ipi_send_mask()` or `ipi_send_single()` — routes through `ipi_send_verify()` first, a function whose entire job is to validate the request before anything touches hardware: is the IRQ chip valid, does it support sending IPIs at all, is the destination CPU in range, and does the requested destination mask fit within the IPI's own affinity mask. That last check needs the IPI's affinity mask, which the original code fetched via `irq_data_get_affinity_mask(data)` as the very first thing the function did — before any of its other validation ran.

## The trigger

If `ipi_send_mask()` or `ipi_send_single()` is called with an invalid interrupt number, the `struct irq_data *data` pointer that `ipi_send_verify()` receives is `NULL`. The function's very first line called `irq_data_get_affinity_mask(data)` unconditionally, dereferencing that `NULL` pointer before the function had validated anything, including the one thing it should have checked first: whether it had been handed a real interrupt descriptor at all.

## Observed behavior

The result is a kernel oops from inside a helper that a caller supplying a bad interrupt number should have been able to trust to fail cleanly with an error code, not crash. The bug was found not through a crash report from the field, but by the Linux Verification Center's static analysis tooling (SVACE) — the kind of NULL-dereference-on-an-unchecked-pointer pattern static analysis is specifically good at catching before anyone hits it at runtime.

## Why it happened

The function did have a NULL check, just aimed at the wrong variable and placed after the dereference it should have guarded. The original code read `if (!chip || !ipimask) return -EINVAL;` — checking whether the *affinity mask itself* came back NULL, which can legitimately happen for reasons unrelated to `data` being invalid. But by the time that check ran, `irq_data_get_affinity_mask(data)` had already been called on the very first line of the function, so a NULL `data` pointer had already been dereferenced before the function's own validation logic ever got a chance to reject it. The check that would have caught the real problem — is `data` itself non-NULL — didn't exist at all.

## Resolution

The fix reorders the function: it no longer calls `irq_data_get_affinity_mask()` until after `chip` and `data` have both been confirmed non-NULL and the destination CPU number has been range-checked. Only once those checks pass does the function fetch the affinity mask and check *that* for NULL separately, preserving the original mask-specific validation without ever dereferencing `data` before confirming it exists.

## What it taught us

**A NULL check anywhere in a function doesn't mean the function is protected against NULL — only the specific pointer that check tests, and only for code that runs after it.** This function had validation logic; it just validated the wrong thing before the dangerous dereference happened, which gave a false sense that the "well, we do check for NULL" box was already checked.

**Static analysis catches exactly this shape of bug better than most manual review does**, because a human reading `if (!chip || !ipimask) return -EINVAL;` sees a NULL check right there in the function and tends to move on, without separately tracing whether every value used *before* that line was already validated.

!!! warning "Pattern to watch for"
    When a function computes a value from a parameter and validates that parameter somewhere in the same function, check whether the computation happens before or after the validation — a NULL check later in the function provides no protection for a dereference earlier in it, no matter how defensive the function looks as a whole.

## See also

- [Interrupt Handling Overview](../interrupts.md) — where `struct irq_data` and the generic IPI layer fit in the broader interrupt-handling path

## External references

- [git.kernel.org: feabecaff590](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=feabecaff5902f896531dde90646ca5dfa9d4f7d) — "genirq/ipi: Fix NULL pointer deref in irq_data_get_affinity_mask()," the upstream fix, authored by Sergey Shtylyov and carried into mainline by Thomas Gleixner
- [NVD: CVE-2023-53332](https://nvd.nist.gov/vuln/detail/CVE-2023-53332) — the CVE record; note the "2023" numbering reflects when the CVE identifier was later assigned to this fix, not when the fix itself landed
