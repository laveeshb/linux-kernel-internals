# The pty_write() Lock That Was Fixed, Un-Fixed, and Fixed Again

> A 2018 fix for a data race added a lock. A 2020 fix for a lockdep-detected deadlock removed part of it — silently reintroducing the original race in a new shape. A 2022 CVE report finally caught the reintroduced bug, and the real fix took both properties at once instead of trading one for the other.

Landed (final fix)
:   Linux, July 2022 (CVE-2022-1462)

Driver
:   PTY core (`drivers/tty/pty.c`, `drivers/tty/tty_buffer.c`)

Reporter (2022)
:   "一只狗" via oss-security

Mechanism
:   Unsynchronized tty flip-buffer commit, three revisions across four years

CVE-2022-1462

*Part of [War Stories: TTY/Serial Bugs and Regressions](../war-stories.md).*

## Act 1 (2018): the original race

`pty_write()` inserted incoming bytes into the receiving side's tty flip buffer via `tty_insert_flip_string_fixed_flag()` and then called `tty_flip_buffer_push()` to commit them, with no lock around either call. Two threads could both reach `pty_write()` for the same pty concurrently through entirely different call chains — the KASAN report that motivated the fix shows one thread arriving via `n_hdlc_send_frames()` → `pty_write()` (triggered by a wakeup from an `n_tty_ioctl_helper()`/`__start_tty()` call) while another arrives via `tty_send_xchar()` → `pty_write()` (triggered by a separate `n_tty_ioctl_helper()` call on the other CPU) — and both could be mutating the flip buffer's tail and commit state at once, corrupting it: a slab out-of-bounds write.

Commit `b6da31b2c07c46f2dcad1d86caa835227a16d9ff` ("tty: Fix data race in tty_insert_flip_string_fixed_flag", DaeRyong Jeong, April 2018) fixes this the straightforward way: wrap both the insert and the subsequent `tty_flip_buffer_push()` in `to->port->lock`.

## Act 2 (2020): the fix creates a deadlock

Holding `port->lock` across `tty_flip_buffer_push()` turned out to have a cost the 2018 fix didn't anticipate: `tty_flip_buffer_push()` ends up taking the workqueue `pool->lock` directly (via `queue_work_on()`/`__queue_work()`), and that edge closes a cycle that also runs through `console_owner` and the 8250 console's own `port->lock` elsewhere in the dependency graph — `console_unlock()` takes `console_owner` while calling into `serial8250_console_write()`, which takes a UART's `port->lock`, while separately a task holding the workqueue's `pool->lock` (dumping workqueue state via `printk()`) can call into `console_unlock()` and block on `console_owner`. Lockdep flagged the resulting circular lock-ordering dependency across those three locks — a real deadlock risk under the right interleaving, not a lock `tty_flip_buffer_push()` itself ever directly acquires.

Commit `71a174b39f10b4b93223d374722aa894b5d8a82e` ("pty: do tty_flip_buffer_push without port->lock in pty_write", Artem Savkov, September 2020) resolves the lockdep cycle by moving `tty_flip_buffer_push()` back **outside** `port->lock` — but the insert itself stays locked. This looks like a narrower, more surgical fix than reverting Act 1 entirely. It isn't: `tty_flip_buffer_push()` *writes* the buffer's `commit` field (via `smp_store_release()`, so that the write is visible to a paired acquire-load) to mark how much data is ready to hand to the line discipline, and once that write moves outside the lock, a concurrent insert can leave `commit` in an inconsistent state relative to what a later, independent reader observes — the 2018 race, reborn in the commit-tracking field instead of the raw insert. That later read happens in `flush_to_ldisc()`, the workqueue worker described in Act 3 below, which pairs its own `smp_load_acquire(&head->commit)` against this now-unlocked write.

## Act 3 (2022): the reborn race gets a CVE

A researcher reported on oss-security that `flush_to_ldisc()` could compute a **negative** byte count — `smp_load_acquire(&head->commit) - head->read` going negative when the racing insert and read observed inconsistent state — leading to an out-of-bounds read and disclosure of kernel slab memory — Jiri Slaby's fix commit describes the same inconsistent-tail race more broadly as something that "can lead to out of bounds writes and other issues" too. Per NVD's own CVE description, the race was reproduced by racing `pty_write()` against `ioctl(TIOCSTI)` and `ioctl(TCXONC)` on the other end of the pair — both of which also insert characters into the same tty buffer outside of `pty_write()`'s call path. This is CVE-2022-1462, rated CVSS 3.1 6.3 (MEDIUM).

Commit `a501ab75e7624d133a5a3c7ec010687c8b961d23` ("tty: use new tty_insert_flip_string_and_push_buffer() in pty_write()", Jiri Slaby, July 2022) carries `Fixes: 71a174b39f10` in its own commit message — an explicit acknowledgment that the 2020 fix is what broke this. The real resolution introduces a new helper, `tty_insert_flip_string_and_push_buffer()`, that does the insert **and** the buffer commit under `port->lock` together — closing the 2018/2022 race — but defers the subsequent `queue_work()` call to *outside* the lock, which is what actually avoids the 2020 deadlock. The two properties the 2018 and 2020 fixes each got half of — no data race, no lock-ordering cycle — turn out to both be achievable, just not by choosing which operation happens under the lock as an either/or.

## Why it happened

Each of the first two fixes was locally correct for the specific problem it targeted. The 2018 fix genuinely closed a data race. The 2020 fix genuinely closed a lockdep-detected deadlock. Neither fix's author was wrong about the bug they were looking at — the 2020 fix's author was solving a real, verified lock-ordering problem, and the tool that caught it (lockdep) doesn't know or care about data-race safety, only about lock acquisition order. Moving the buffer commit outside the lock was a correct, minimal-looking way to break the specific cycle lockdep reported. What it didn't do was re-examine whether the *unlocked* commit read was still safe once the insert stayed locked but the read didn't — a property the 2018 fix had established as an invariant across both operations, and which the 2020 fix broke without anyone re-verifying it.

## Resolution

See Act 3 above: `tty_insert_flip_string_and_push_buffer()` performs the insert and the commit atomically under `port->lock`, and only releases the lock before the (lock-independent) work-queueing step — achieving both the 2018 fix's data-race safety and the 2020 fix's freedom from the lockdep cycle in the same commit.

## What it taught us

**A fix that resolves a *detected* problem (a lockdep splat, a specific crash) can silently undo an *undetected* invariant the previous fix relied on, if that invariant was never itself written down or tested for.** The 2018 fix established "insert and commit happen atomically together" as an implicit invariant. Nothing enforced or documented that invariant as a first-class property — so the 2020 fix, focused entirely on satisfying lockdep, had no signal that splitting insert and commit across the lock boundary would violate it.

**Two correctness properties that look like they trade off against each other (no data race vs. no deadlock) may both be achievable — the apparent tradeoff can be an artifact of *how* the fix is structured, not a fundamental conflict.** The final fix didn't choose between locking more or locking less; it changed *what* stays under the lock together (insert + commit, but not the subsequent work-queue call) to get both properties at once.

!!! warning "Pattern to watch for"
    A fix for a deadlock/lock-ordering problem that responds by moving one part of a previously-atomic multi-step operation outside the lock, without re-verifying that the steps still need to happen atomically with each other for a *different* reason (here: data-race safety) than the one that motivated putting them under the lock in the first place.

## See also

- [Serial Core and UART Drivers](../serial.md) / [Line Disciplines, termios, and Pseudo-Terminals](../line-disciplines.md) — the pty master/slave model and tty buffer mechanics this incident lives inside
- [The n_tty Echo Race](n-tty-echo-race.md) — a different tty-buffer locking bug, in N_TTY rather than the pty layer, with a comparably long tail (nine years from fix to CISA KEV listing)

## External references

- [NVD: CVE-2022-1462](https://nvd.nist.gov/vuln/detail/CVE-2022-1462) — CVSS 3.1 6.3 MEDIUM
- [oss-security: original report](https://seclists.org/oss-sec/2022/q2/155)
- [git.kernel.org: b6da31b2c07c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b6da31b2c07c46f2dcad1d86caa835227a16d9ff) — Act 1 (2018): lock the insert and commit
- [git.kernel.org: 71a174b39f10](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=71a174b39f10b4b93223d374722aa894b5d8a82e) — Act 2 (2020): move the commit outside the lock to fix a lockdep cycle
- [git.kernel.org: a501ab75e762](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=a501ab75e7624d133a5a3c7ec010687c8b961d23) — Act 3 (2022): the real fix, `Fixes: 71a174b39f10` in its own commit message
