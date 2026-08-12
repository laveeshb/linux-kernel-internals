# Towelroot: The Missing Check on the Requeuer's Half of the Pair

> CVE-2014-3153 — `futex_requeue()` never checked that a PI-requeue's source and destination were actually different futexes, and the identical check on the *sibling* function two years earlier hadn't been enough to catch it

Disclosed
:   June 2, 2014 (reported to Red Hat by Kees Cook); fixed in mainline June 5, 2014

Reported by
:   Pinkie Pie (pseudonym); reported via Kees Cook, Google

CVSS
:   7.8 HIGH / 7.2 (CVSS v2) (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`)

Bug present since
:   `FUTEX_CMP_REQUEUE_PI` support, ~2009

Fixed in
:   commit `e9c243a5a6de`, mainline Linux 3.15 (June 8, 2014)

Exploit tool
:   yes — George Hotz's "Towelroot," a public one-click Android rooting tool

Actively exploited
:   yes — added to CISA KEV, May 25, 2022; Google's own 2014 telemetry named this the year's single most significantly exploited Android kernel bug

*Part of [War Stories: Locking and Synchronization Bugs](../war-stories.md).*

## Before state

`FUTEX_CMP_REQUEUE_PI` moves a thread waiting on one futex over to a second, PI-aware futex, without waking it up first — the mechanism glibc uses to implement `pthread_cond_wait()` on a priority-inheritance mutex efficiently. The waiting thread (T1) calls `FUTEX_WAIT_REQUEUE_PI(uaddr, uaddr2)` and blocks, with a `struct rt_mutex_waiter` allocated on its own kernel stack. A second thread (T2) then calls `FUTEX_CMP_REQUEUE_PI(uaddr, uaddr2)` — `futex_requeue()` — which walks the source futex's waiter list and, for each match, calls `rt_mutex_start_proxy_lock()` to attach T1's stack-resident waiter onto `uaddr2`'s real PI mutex, on T1's behalf, entirely from T2's context. The whole protocol depends on one unstated invariant: `uaddr` and `uaddr2` are genuinely different futexes — one plain, one PI-aware. Nothing in `futex_requeue()` checked that.

## The trigger

The sibling function, `futex_wait_requeue_pi()`, had already been patched for exactly this gap — two years earlier. In 2012, Dave Jones's `trinity` syscall fuzzer found that calling `FUTEX_WAIT_REQUEUE_PI` with `uaddr == uaddr2` produced a NULL-pointer dereference: with source and destination identical, `q.key` and `key2` compare equal, an early-wakeup check misfires, and the code dereferences a `pi_mutex` that was never actually set up. Darren Hart's fix, `6f7b0a2a5c0f`, added `if (uaddr == uaddr2) return -EINVAL;` — but only to `futex_wait_requeue_pi()`, the *waiter* side of the pair. `futex_requeue()`, the *requeuer* side that actually performs the `FUTEX_CMP_REQUEUE_PI` transfer, has the identical invariant and never received the equivalent guard.

## Observed behavior

Forcing `uaddr1 == uaddr2` through the unguarded requeuer path desynchronizes the requeue machinery's bookkeeping from what `rt_mutex_start_proxy_lock()` actually did to the target mutex's waiter structure. The practical result, per public technical analyses of the bug: `futex_wait_requeue_pi()` can exit without ever removing `rt_waiter` from the PI mutex's wait list. `rt_waiter` lives on T1's kernel stack — a region that gets reused the moment that syscall returns. The PI mutex's own waiter-tracking structure is left holding a pointer into now-stale stack memory. An attacker who can then get a subsequent syscall to reuse that exact stack slot with attacker-controlled data effectively forges a fake `rt_mutex_waiter` — task pointer, list linkage, and all — at an address the kernel's own PI lock-handoff code will later dereference as if it were legitimate. That corrupted-pointer primitive is what public exploit writeups (including a later ported PoC on Exploit-DB) describe turning into arbitrary kernel memory read/write, and from there, overwriting kernel credential structures for a full root shell.

## Why it happened

The 2012 fix was scoped to the crash `trinity` actually produced — a NULL dereference in `futex_wait_requeue_pi()`. It was a correct, narrow fix for a real, reproduced bug. Nobody at the time re-derived the invariant from first principles and asked "does every function in this pair need this same check?" The requeuer side has the identical precondition and the identical failure mode when violated, but it never crashed on its own during the fuzzing run that found the first bug — it just sat there, unguarded, for two more years, until someone went looking specifically for the mirror-image gap rather than waiting for a fuzzer to stumble onto it a second time.

## Resolution

`e9c243a5a6de` ("futex: Forbid uaddr == uaddr2 in futex_requeue(..., requeue_pi=1)") adds the missing `if (uaddr1 == uaddr2) return -EINVAL;` to `futex_requeue()` — bringing it in line with the check `futex_wait_requeue_pi()` already had. Thomas Gleixner's review caught that a raw pointer comparison isn't actually sufficient: two different virtual addresses (in the same process, or across processes for a shared futex) can resolve to the same underlying page and offset. The commit adds a second check, comparing the *resolved* `union futex_key` values via `match_futex()`, and retrofits that same key-comparison onto the original 2012 fix in `futex_wait_requeue_pi()`, which had only ever compared raw pointers.

## What it taught us

**A fix for a crash a fuzzer found is not the same as a fix for the invariant the fuzzer stumbled onto.** `trinity` found one function's violation of "source and destination must differ." The invariant applied equally to a second function nobody happened to fuzz into crashing — and a narrowly-scoped fix has no mechanism for surfacing that the same precondition exists elsewhere.

**Pointer equality is a weaker check than the property it's standing in for.** Even the eventual complete fix needed a second pass: comparing `uaddr == uaddr2` catches the obvious case, but the real invariant is about the *futex identity* the addresses resolve to, which required comparing keys, not pointers, to close entirely.

!!! warning "Pattern to watch for"
    When two functions implement opposite halves of the same protocol (here: the waiter side and the requeuer side of PI-futex requeue), a precondition discovered and fixed on one side is a strong signal to audit the other side for the identical gap — not just to fix the crash in front of you and move on. The mirror-image function often shares the exact same invariant with no compiler or fuzzer connecting the two for you.

## See also

- [Locking Overview](../README.md) — futexes, rt_mutex, and the PI-requeue protocol this bug lives in
- [The PI-Mutex Origin Story](pi-mutex-origin.md) — why PI futexes and `FUTEX_LOCK_PI`/`FUTEX_CMP_REQUEUE_PI` exist at all
- [The PI-Futex Fixup That Had No Answer for a Permanent Fault](pi-futex-fixup-owner-uaf.md) — a second PI-futex use-after-free, on the fault-handling side rather than the requeue side

## External references

- [GitHub mirror: e9c243a5a6de](https://github.com/torvalds/linux/commit/e9c243a5a6de0be8e584c604d353412584b592f8) — "futex: Forbid uaddr == uaddr2 in futex_requeue(..., requeue_pi=1)," the fix
- [GitHub mirror: 6f7b0a2a5c0f](https://github.com/torvalds/linux/commit/6f7b0a2a5c0fb03be7c25bd1745baa50582348ef) — "futex: Forbid uaddr == uaddr2 in futex_wait_requeue_pi()," the 2012 fix that only covered the sibling function
- [Debian DSA-2949-1](https://lists.debian.org/debian-security-announce/2014/msg00130.html) — "Pinkie Pie discovered an issue in the futex subsystem that allows a local user to gain ring 0 control via the futex syscall"
- [Google Android Security 2014 Year in Review](https://source.android.com/docs/security/reports/Google_Android_Security_2014_Report_Final.pdf) — names CVE-2014-3153 as the year's most significantly exploited Android local-privilege-escalation bug
- [NVD: CVE-2014-3153](https://nvd.nist.gov/vuln/detail/CVE-2014-3153) — CVE record; CISA KEV-listed May 25, 2022
