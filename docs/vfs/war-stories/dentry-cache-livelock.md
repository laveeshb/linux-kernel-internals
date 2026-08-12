# The Dentry-Cache Walk Livelock

> CVE-2014-8559 — `d_walk()`'s rename-detection restart couldn't tell "a rename happened" from "a sibling got killed," so a concurrent dentry prune could make the walker deadlock against itself and hang every rename on the machine

Disclosed
:   November 10, 2014 (NVD); fix authored October 26, 2014

Reported by
:   Prasad Pandit, Red Hat (RHBZ #1159313, October 31, 2014) — though the identical bug was independently diagnosed by Jaegeuk Kim eight months earlier

CVSS
:   5.5 MEDIUM (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H`)

Bug present since
:   ~v3.12 (November 2013), when `d_walk()` unified the dentry-tree traversal code

Fixed in
:   commit `ca5358ef75fc`, authored October 26, 2014; reached the 3.18.y stable branch about seven weeks later (3.18.1, December 2014), older LTS branches (3.10.y, 3.14.y) not until mid-2015, and mainline proper in Linux 3.19 (February 2015)

Exploit tool
:   no — no public exploit tool exists; this is a concurrency bug reachable through ordinary filesystem load, not a crafted-input attack

Actively exploited
:   no confirmed cases (not on CISA KEV) — local denial of service only

*Part of [War Stories: VFS Bugs and Regressions](../war-stories.md).*

## Before state

`d_walk()` (`fs/dcache.c`) is the generic, depth-first tree walker used for operations that need to visit every dentry under a directory — cache shrinking, unmount, `d_invalidate()`, and more. It holds at most one dentry's `d_lock` at a time, dropping the child's before taking the parent's, which makes global consistency the walker's real problem: nothing stops another thread from renaming part of the tree mid-walk. That's `rename_lock`'s job — a seqlock. The walker samples `rename_lock`'s sequence counter before it starts; if the counter changed by the time it finishes, `need_seqretry()` reports the walk as unsafe and it restarts from the top, this time actually holding `rename_lock`'s write side so it's guaranteed to finish.

Ascending back to a parent after finishing a subtree re-validated with a three-way condition:

```c
if (this_parent != child->d_parent ||
     (child->d_flags & DCACHE_DENTRY_KILLED) ||
     need_seqretry(&rename_lock, seq)) {
        spin_unlock(&this_parent->d_lock);
        rcu_read_unlock();
        goto rename_retry;
}
```

Only the third clause, `need_seqretry()`, is actually protected by `rename_lock`. The other two — a changed parent pointer, or the `DCACHE_DENTRY_KILLED` flag — could each independently be true without any rename having happened at all.

## The trigger

`DCACHE_DENTRY_KILLED` is set by `__dentry_kill()`, called whenever a dentry is finally freed — a memory-pressure dcache shrink, an `rmdir()`, a `dput()` dropping the last reference. None of that touches `rename_lock`. So a dentry being pruned out from under the walker, with no rename anywhere in sight, tripped the exact same restart path as a genuine rename.

Jaegeuk Kim hit this independently in February 2014, running `fsstress` (a standard filesystem-stress tool) with ten threads on a 3.14-rc3 kernel, and posted a lockdep report to the list:

```
[ INFO: possible recursive locking detected ]
(rename_lock){+.+...}, at: [<...>] d_walk+0x4d/0x3c0
but task is already holding lock:
(rename_lock){+.+...}, at: [<...>] d_walk+0x4d/0x3c0
*** DEADLOCK ***
```

He'd already spotted the shape of the problem: "I suspect that the upper conditions can trigger rename_retry even though rename_retry was done once before." Waiman Long replied the same day with essentially the fix's eventual approach: "It seems like the rename_lock may not be able to fully protect against the setting of the DCACHE_DENTRY_KILLED flag... I am 100% sure if we could just release the lock and let it try again without causing infinite loop." No public reply from Al Viro is visible in that thread, and the actual fix landed separately eight months later, credited to Red Hat's Prasad Pandit filing RHBZ #1159313 — the two reports appear to have converged independently on the same root cause rather than one causing the other.

## Observed behavior

The restart escalates deliberately: the first `rename_retry` sets `seq = 1` and goes around again, and an odd `seq` makes `need_seqretry()`'s underlying `read_seqbegin_or_lock()` take `rename_lock`'s actual write lock instead of just sampling it — a guarantee-of-progress mechanism, since a lockless retry loop against an actively-changing tree could otherwise spin forever. But dentry killing was never gated on `rename_lock` either, so a *second* concurrent kill during that now-locked pass could trip the very same branch again — sending the walker back to `rename_retry` while it already held the write lock from the first escalation. Linux spinlocks aren't reentrant. The task span forever trying to reacquire a lock it was already holding.

Because `rename_lock`'s write side is also what every `d_move()`/`vfs_rename()` call needs, one CPU wedged this way didn't just hang the triggering thread — it froze every future rename on the machine. Kim's original report captured both halves of this: the lockdep splat on one CPU, and a completely separate "`BUG: soft lockup - CPU#0 stuck for 22s!`" on another CPU, spinning in `_raw_spin_lock` inside `vfs_rename()`. Debian's advisory later described the practical trigger in the same terms independently: "kernel functions that iterate over a directory tree can dead-lock or live-lock in case some of the directory entries were recently deleted or dropped from the cache."

## Why it happened

The bug conflated two genuinely different events — "the tree structure changed in a way that invalidates my position" (a rename, correctly protected by a seqlock) and "an entry I'm about to visit no longer exists" (a kill, a much more common and entirely unrelated event) — because both looked, from inside the walker, like "I can't trust what's below me anymore." Folding a frequent, ordinary event into the same recovery path built for a rare, tightly-synchronized one turned a routine dcache shrink into a self-inflicted deadlock.

## Resolution

`ca5358ef75fc` ("deal with deadlock in d_walk()", Al Viro) stopped treating a killed sibling as a reason to restart the whole walk. Ascending now only triggers `rename_retry` for a genuine `need_seqretry()` failure — reinforced by a new `BUG_ON(seq & 1)` at the retry label, a hard assertion that a restart should never happen while already in locked mode. A killed child is instead skipped in place: a new inner loop walks forward through the sibling list (`child = list_entry(next, struct dentry, d_child); next = next->next;`) until it finds a live dentry to resume from, or reaches the end and ascends one level further.

That skip loop depends on a second change in the same commit: in `__dentry_kill()`, `list_del()` — which unlinks a node *and* poisons its own `next`/`prev` pointers to catch use-after-removal bugs — became `__list_del_entry()`, which only does the unlinking. A just-killed dentry's `d_child.next` still points at its old next sibling, which is exactly what lets the new loop safely chase past a run of killed dentries to find where the live list resumes. A separate, same-day commit, `946e51f2bf37`, made that safe under RCU: it moved `d_rcu` off the union it had shared with `d_child` onto `d_alias` instead, so a dentry's RCU-deferred free no longer overwrites the `d_child` links the skip loop still needs to walk.

## What it taught us

**A recovery path built for one class of concurrent change can silently start firing on a completely different, much more frequent one**, if both changes happen to trip the same flag or condition check. `rename_lock` was never meant to arbitrate dentry lifetime, only dentry position — but the ascend logic asked it to do both.

**Escalating a retry to a stronger lock only guarantees progress if every event that could trigger a *second* retry is itself excluded once that stronger lock is held.** The fix wasn't "take a bigger lock" — it was narrowing what's allowed to trigger a retry at all, so the escalated pass genuinely can't retrigger.

!!! warning "Pattern to watch for"
    A retry-then-escalate-to-a-lock pattern (sample a seqlock, retry once lockless, retry again holding the write side) is only livelock-free if the *set of events that can trigger a retry* is proven disjoint from anything that can happen while already holding that lock. If a retry condition can be tripped by something unrelated to what the lock actually protects, the escalated pass can retrigger against a lock the same task already holds.

## See also

- [VFS Overview](../README.md) — the dentry cache and `rename_lock`'s role in path resolution
- [RCU (Read-Copy-Update)](../../locking/rcu.md) — the RCU-protected traversal this fix's skip loop relies on
- [Seqlock](../../locking/seqlock.md) — the seqlock-with-lock-fallback pattern `rename_lock` uses

## External references

- [GitHub mirror: ca5358ef75fc](https://github.com/torvalds/linux/commit/ca5358ef75fc69fee5322a38a340f5739d997c10) — "deal with deadlock in d_walk()," the fix
- [GitHub mirror: 946e51f2bf37](https://github.com/torvalds/linux/commit/946e51f2bf37f1656916eb75bd0742ba33983c28) — "move d_rcu from overlapping d_child to overlapping d_alias," the same-day companion structural change
- [NVD: CVE-2014-8559](https://nvd.nist.gov/vuln/detail/CVE-2014-8559) — CVE record, CVSS 5.5 MEDIUM, published November 10, 2014
