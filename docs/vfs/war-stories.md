# War Stories: VFS Bugs and Regressions

> Four CVEs from the dentry cache, `seq_file`, and OverlayFS — a livelock in the generic tree walker, an integer truncation seven years in the making, and two variants of the same OverlayFS copy-up trusting something it shouldn't have

Unlike [GPU/DRM's incident record](../drm/war-stories.md), every incident here is a CVE — VFS sits directly on a security boundary: it's the layer that decides what an unprivileged process can read, write, or become. Two of the four involve OverlayFS's copy-up path specifically, and both stem from the same underlying shape of mistake: copy-up acted on a value — a UID, a capability xattr — that needed a security-relevant check on the way out, and either the check silently didn't run at all, or it ran but nobody confirmed it actually succeeded.

## Incidents

Ordered reverse chronologically by when the fix landed in mainline — newest first.

### [OverlayFS: The Copy-Up That Trusted an Unmapped UID](war-stories/overlayfs-uid-confusion.md)
**Linux 6.2 (February 2023) · CVE-2023-0386**
Copy-up read a lower file's UID/GID through the mounter's namespace mapping and took the result at face value — never checking whether the mapping had actually succeeded or silently collapsed to the ambiguous overflow value every unmapped ID shares.

### [Sequoia: The seq_file Size-Truncation Overflow](war-stories/sequoia-seq-file-overflow.md)
**Disclosed July 2021, fixed in Linux 5.14 · CVE-2021-33909**
A `size_t` buffer size, silently narrowed to a 32-bit `int` since the day `dentry_path()` was written, stayed unreachable until an unrelated 2014 fix made it possible to grow a buffer large enough to trigger it — and then sat unreachable-in-practice for seven more years until someone went looking, turning "make a very long directory path" into an exact, attacker-chosen out-of-bounds write.

### [OverlayFS: The Capability Check That Only One Caller Made](war-stories/overlayfs-capability-bypass.md)
**Fixed December 2020, shipped in Linux 5.11 (February 2021) · CVE-2021-3493**
The permission check for setting a namespaced capability xattr lived in the `setxattr(2)` syscall handler instead of the generic `vfs_setxattr()` every filesystem is supposed to trust — so OverlayFS's copy-up path, which calls the latter directly, skipped it entirely.

### [The Dentry-Cache Walk Livelock](war-stories/dentry-cache-livelock.md)
**Linux 3.19 (February 2015) · CVE-2014-8559**
`d_walk()`'s rename-detection restart couldn't tell "a rename happened" from "a sibling got killed," so a concurrent dentry prune could make the walker deadlock against itself and hang every rename on the machine.

## Common threads

| Pattern | UID confusion | Sequoia | Capability bypass | Dentry livelock |
|---------|:---:|:---:|:---:|:---:|
| Involves OverlayFS copy-up specifically | Yes | No | Yes | No |
| Root cause: a security check on copy-up either silently skipped or its success never confirmed | Yes | No | Yes | No |
| Root cause: two events conflated because they looked identical from inside the check | No | No | No | Yes |
| Root cause: silent numeric truncation | No | Yes | No | No |
| Required unprivileged user namespaces to reach | Yes | Yes (bind mount inside one) | Yes | No |
| Caught by an automated detector (lockdep) rather than manual audit | No | No | No | Yes |
| CISA KEV-listed | Yes (Jun 2025) | No | Yes (Oct 2022) | No |
| Public exploit tool published | Yes | Crasher PoC public; full exploit private | Yes | No |

**Two of four are the same OverlayFS mistake wearing different clothes.** The UID-confusion bug and the capability-check bypass both involve copy-up setting something security-relevant on the new upper file — an ownership ID, a capability xattr — without a security check on that specific value actually running and succeeding at copy-up time. In the UID case the mapping ran but nobody checked it hadn't silently degraded to the overflow placeholder; in the capability case the permission check never ran on that path at all. Neither is a logic error in the classic sense; both are a *trust boundary drawn one layer too early*.

**The dentry livelock is the odd one out, and the only one caught by tooling before it shipped a fix.** Jaegeuk Kim's lockdep report predates Red Hat's later bug report by eight months — an independent discovery that traced the exact same root cause, without either report causing the other. Sequoia and the two OverlayFS bugs were all found by researchers reading code and reasoning about attacker-controlled inputs, not by a detector firing during ordinary testing.

**Sequoia stands alone as a pure integer-width bug, and has the longest documented dormancy of the incidents on this page that state one.** The vulnerable narrowing conversion in `dentry_path()` existed from the function's original design; it took a 2014 fix to a completely unrelated allocation-failure problem to make it reachable at all, and seven more years before anyone went looking for exactly this class of bug.

**Every incident here is a local-privilege or local-denial-of-service bug, not a remote one.** VFS's CVE history reflects what the layer actually guards: not the network-facing attack surface [BPF](../bpf/war-stories.md) or [networking](../net/war-stories.md) deal with, but the boundary between what one unprivileged local user can do versus what they can trick the kernel into doing on their behalf.

## See also

- [VFS Overview](README.md) — the dentry cache, path resolution, and the generic superblock/inode/dentry/file objects every incident here operates on
- [Security: LSMs, Capabilities, and Seccomp](../security/README.md) — the capability and permission-check machinery two of these incidents bypassed
- [Locking](../locking/README.md) — `rename_lock`, seqlocks, and the lockdep machinery that caught the dentry livelock
- [BPF War Stories](../bpf/war-stories.md), [Network War Stories](../net/war-stories.md), [Security War Stories](../security/war-stories.md), [GPU/DRM War Stories](../drm/war-stories.md) — the same site's other incident pages, for comparison across subsystems
