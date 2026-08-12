# OverlayFS: The Capability Check That Only One Caller Made

> CVE-2021-3493 — the code that validates a `security.capability` xattr against the target user namespace lived in the `setxattr(2)` syscall handler, not in the generic `vfs_setxattr()` every filesystem is supposed to be able to trust — and OverlayFS's copy-up path called the latter

Disclosed
:   April 15, 2021 (Steve Beattie, Canonical, to oss-security)

Reported by
:   an independent security researcher, via the SSD Secure Disclosure program

CVSS
:   8.8 HIGH, Ubuntu Security Team scoring (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H`); 7.8 HIGH, NVD primary scoring (`.../S:U/...`)

Fixed in
:   commit `7c03e2cda4a5`, landed in the Linux 5.11 development cycle, December 2020

Exploit tool
:   yes — public PoC widely circulated in 2021 demonstrating root privilege escalation on affected Ubuntu kernels

Actively exploited
:   yes — added to CISA KEV, October 20, 2022

*Part of [War Stories: VFS Bugs and Regressions](../war-stories.md).*

## Before state

Linux file capabilities (`security.capability` xattr) let a specific binary run with elevated privileges without being full setuid-root — `cap_setuid`, `cap_net_bind_service`, and similar, attached to a file rather than granted process-wide. Because capabilities are namespace-relative (a capability meaningful in one user namespace shouldn't automatically be honored in another), setting that xattr goes through `cap_convert_nscap()`, which does two things at once: validates that the calling process is actually allowed to set a namespaced capability of this kind, and rewrites the on-disk xattr value into the namespaced (`vfs_ns_cap_data`) format.

Before `7c03e2cda4a5`, that call to `cap_convert_nscap()` lived inside the `setxattr()` system call handler in `fs/xattr.c` — one specific caller — rather than inside `vfs_setxattr()`, the generic entry point every filesystem's internal xattr-setting logic is expected to be able to call directly and trust.

## The trigger

OverlayFS's copy-up path sets xattrs on the newly-created upper file by calling `vfs_setxattr()` directly — it has no reason to go through the userspace `setxattr(2)` syscall path, since it's already operating on kernel-resident dentries during an internal filesystem operation. That meant every `security.capability` xattr copied up by OverlayFS skipped `cap_convert_nscap()` entirely: no permission check on whether the capability was valid to grant in the relevant user namespace, and no namespaced-format conversion.

NVD's own summary states the exploitability condition precisely: "the overlayfs implementation in the linux kernel did not properly validate with respect to user namespaces the setting of file capabilities on files in an underlying file system. Due to the combination of unprivileged user namespaces along with a patch carried in the Ubuntu kernel to allow unprivileged overlay mounts, an attacker could use this to gain elevated privileges." Upstream mainline OverlayFS did not support unprivileged mounts at all until `459c7c565ac3` landed in 5.11 — Ubuntu's kernel had carried its own out-of-tree patch enabling unprivileged overlay mounts for years before that landed upstream, which is what made this particular gap reachable by an unprivileged local user well before the underlying `vfs_setxattr()` bug itself was fixed.

## Observed behavior

An unprivileged user with access to Ubuntu's carried unprivileged-overlay-mount patch could construct a lower layer containing a file carrying a `security.capability` xattr, have OverlayFS copy that file up without its copy-up path ever running it through the missing permission check, and then execute the resulting upper-layer file to obtain the granted capability outright — a direct path to root if the capability chosen was powerful enough (`cap_setuid`, for instance, trivially yields a root shell). Exploiting it required nothing more exotic than ordinary user-namespace and overlay-mount access — both already enabled by default on affected Ubuntu releases — making it reachable from an unprivileged local shell. CISA added CVE-2021-3493 to its Known Exploited Vulnerabilities catalog on October 20, 2022, confirming sustained real-world exploitation well after the initial 2021 disclosure and patch.

## Why it happened

`cap_convert_nscap()`'s dual role — permission check *and* format conversion — was written assuming its only caller would be the `setxattr(2)` syscall path, because at the time, that was the only way a `security.capability` xattr could be set. `vfs_setxattr()` looked, from any other caller's perspective, like the correct, generic, already-permission-checked entry point — the commit message says as much: this is "what `vfs_foo()` is supposed to do anyway." The gap wasn't a missing check so much as a check placed one layer higher than where the function's name and position in the VFS call graph implied it already was.

## Resolution

`7c03e2cda4a5` ("vfs: move cap_convert_nscap() call into vfs_setxattr()", Miklos Szeredi) moves the `cap_convert_nscap()` call from the `setxattr()` syscall handler down into `vfs_setxattr()` itself, so every caller — the syscall path, OverlayFS's copy-up, and any other in-kernel caller such as eCryptfs — now gets the same permission check and namespaced-format conversion, with no way to route around it by calling the "generic" function directly.

## What it taught us

**A security check placed in one specific caller, rather than in the shared function every caller is expected to trust, is a check that new callers will not know to re-add.** `vfs_setxattr()`'s name and position in the VFS layer told every future caller — correctly, by every convention the rest of the VFS follows — that it was safe to call directly. The permission check simply wasn't where the interface's own contract said it would be.

**In-kernel callers that bypass a userspace-facing syscall wrapper inherit whatever validation lived only in that wrapper, silently.** OverlayFS wasn't doing anything unusual by calling `vfs_setxattr()` instead of going through a syscall — that's the entire point of having a generic VFS layer. The bug was in what `vfs_setxattr()` promised versus what it actually did.

!!! warning "Pattern to watch for"
    When a generic, filesystem-agnostic entry point (a `vfs_*()` function, a core helper) has a sibling syscall wrapper that does extra validation, verify that validation lives in the generic function itself — not the wrapper — before trusting any new in-kernel caller to inherit it correctly. If the check can only be found by reading the syscall handler, any caller that skips the syscall skips the check too.

## See also

- [VFS Overview](../README.md) — the generic `vfs_setxattr()` interface this bug lived in
- [OverlayFS: The Copy-Up That Trusted an Unmapped UID](overlayfs-uid-confusion.md) — a second copy-up-related privilege escalation, on the UID/GID mapping side rather than capabilities
- [Security: LSMs, Capabilities, and Seccomp](../../security/README.md) — Linux file capabilities and the namespace-relative permission model this bug bypassed

## External references

- [GitHub mirror: 7c03e2cda4a5](https://github.com/torvalds/linux/commit/7c03e2cda4a584cadc398e8f6641ca9988a39d52) — "vfs: move cap_convert_nscap() call into vfs_setxattr()," the fix
- [NVD: CVE-2021-3493](https://nvd.nist.gov/vuln/detail/CVE-2021-3493) — CVE record; CISA KEV-listed October 20, 2022
