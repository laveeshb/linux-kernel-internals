# OverlayFS: The Copy-Up That Trusted an Unmapped UID

> CVE-2023-0386 — OverlayFS's copy-up path never checked whether a lower file's owning UID/GID actually had a mapping in the mounter's user namespace, so an attacker could smuggle a capability-bearing file through an unprivileged overlay mount and end up with root

Disclosed
:   March 22, 2023 (NVD record)

CVSS
:   7.8 HIGH (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`)

Bug present since
:   5.11 (February 2021), when `459c7c565ac3` ("ovl: unprivieged mounts") let unprivileged users mount OverlayFS inside a user namespace

Fixed in
:   commit `4f11ada10d0a`, mainline 6.2, February 2023; backported to stable

Exploit tool
:   yes — public PoC (`xkaneiki/CVE-2023-0386`, the `ovlcap` exploit) demonstrated privilege escalation to root

Actively exploited
:   yes — added to CISA KEV, June 17, 2025

*Part of [War Stories: VFS Bugs and Regressions](../war-stories.md).*

## Before state

`459c7c565ac3` ("ovl: unprivieged mounts", Miklos Szeredi, Linux 5.11) let unprivileged users create OverlayFS mounts inside their own user namespace — a feature explicitly built for the "rootless container" crowd, and one OverlayFS's documented permission model was designed to make safe: whatever the mounter could already do to the underlying layers with their own credentials is the ceiling on what the overlay mount can do, no more.

Writing to a file that only exists in the read-only lower layer triggers a **copy-up**: OverlayFS reads the lower file's `stat` data — including its owning UID and GID as seen through the mounter's user namespace — and creates a matching file in the writable upper layer via `ovl_copy_up_one()` in `fs/overlayfs/copy_up.c`.

## The trigger

A UID or GID with no mapping at all in a user namespace isn't reported to `stat(2)` as an error — it's reported as the **overflow UID**, `65534` (`nobody`) by default. `ovl_copy_up_one()` took that `stat` result at face value and proceeded with the copy-up regardless of whether the real underlying UID actually had a mapping in `current_user_ns()`.

That created exactly the inconsistency the fix's commit message calls out: if the overflow UID `65534` itself happened to have a real mapping in the mounter's namespace, copy-up would succeed and create a file owned by whatever `65534` mapped to — even though the *original* UID on the lower file was never actually mapped, meaning a manual `cp -a` run by that same unprivileged user, going through the ordinary permission-checked path, would have failed at exactly this point instead.

## Observed behavior

The publicly released proof of concept (`xkaneiki/CVE-2023-0386`, mirroring the pattern of the earlier "GameOver(lay)" family of OverlayFS bugs) pairs a FUSE-backed lower filesystem the attacker fully controls with a file carrying Linux file capabilities. The attacker's FUSE layer reports that file's ownership in a way that exploits the unmapped-UID/overflow-UID inconsistency, and triggers a copy-up of that capability-bearing file into the writable upper layer — landing it somewhere the capabilities are honored, rather than being rejected the way a same-privilege manual copy would have been. Red Hat's advisory summarizes the resulting primitive plainly: "unauthorized access to the execution of the setuid file with capabilities... how a user copies a capable file from a nosuid mount into another mount." From there the PoC's `getshell` step turns the misappropriated capability into a full root shell. Because unprivileged user-namespace mounts of OverlayFS are enabled by default on mainstream distributions (Ubuntu among them) and are also used by common container runtimes, the practical reach of the bug was every desktop and many container hosts running an affected kernel. CISA added CVE-2023-0386 to its Known Exploited Vulnerabilities catalog on June 17, 2025, confirming real-world exploitation well over two years after the initial patch.

## Why it happened

`459c7c565ac3` built unprivileged OverlayFS mounts on the premise that the mounter's own user-namespace permission checks would bound what the overlay could do — a correct premise everywhere the mounter's credentials were actually re-checked at the point of action. Copy-up's ownership handling was one place that premise silently didn't hold: it read `stat` data that had *already* been through the mounter's UID/GID mapping (so it looked "safe" — just a number) without separately confirming that number reflected a real, valid mapping rather than the ambiguous overflow value every unmapped ID collapses to. A `65534` from a genuinely-mapped `nobody` and a `65534` standing in for "this ID isn't mapped at all" are indistinguishable once they reach `stat`, and only the write path treated them as equivalent when they weren't.

## Resolution

`4f11ada10d0a` ("ovl: fail on invalid uid/gid mapping at copy up") adds exactly the check that was missing — four lines, right before copy-up proceeds:

```c
if (!kuid_has_mapping(current_user_ns(), ctx.stat.uid) ||
    !kgid_has_mapping(current_user_ns(), ctx.stat.gid))
	return -EOVERFLOW;
```

If the lower file's real UID or GID has no valid mapping in the mounter's user namespace, copy-up now fails outright with `-EOVERFLOW`, matching what a manual `cp -a` by that same user would have done — closing the exact inconsistency the commit message flags between `stat(2)`'s overflow-UID behavior and POSIX ACLs, which already return `-1` and fail cleanly on an invalid UID/GID rather than silently substituting a placeholder.

## What it taught us

**A value that has already passed through one security-relevant transformation can look "safe" to code downstream that doesn't know it needs to check further.** By the time copy-up saw a UID, it had already been mapped through the mounter's namespace — that step alone made it look like an ordinary, trustworthy number, when what it actually needed was a check that the mapping had *succeeded* rather than silently degraded to an ambiguous placeholder.

**An overflow or sentinel value that collapses multiple distinct real-world states into one representation is a standing invitation for exactly this bug.** `65534` meaning both "genuinely nobody" and "unmapped, we don't actually know" is fine for `stat(2)`'s user-facing contract; it is not fine for security-relevant code that acts on the number without first ruling out the second meaning.

!!! warning "Pattern to watch for"
    Wherever an ID (UID, GID, or any namespaced identifier) crosses a mapping boundary and the result is consumed as though it were an ordinary value, check for the overflow/sentinel case explicitly before acting on it — especially when the action (like copy-up here) has security consequences beyond the read that produced the value in the first place.

## See also

- [VFS Overview](../README.md) — the generic superblock/inode operations OverlayFS layers on top of
- [OverlayFS Capability-Xattr Bypass](overlayfs-capability-bypass.md) — an earlier variant of the same "capability survives a copy-up it shouldn't" bug class
- [Security: LSMs, Capabilities, and Seccomp](../../security/README.md) — the capability-check machinery OverlayFS's copy-up path depends on

## External references

- [git.kernel.org: 4f11ada10d0a](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=4f11ada10d0ad3fd53e2bd67806351de63a4f9c3) — "ovl: fail on invalid uid/gid mapping at copy up," the fix
- [git.kernel.org: 459c7c565ac3](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=459c7c565ac36ba09ffbf24231147f408fde4203) — "ovl: unprivieged mounts," the commit that enabled the mount configuration this bug required
- [NVD: CVE-2023-0386](https://nvd.nist.gov/vuln/detail/CVE-2023-0386) — CVE record, CVSS 7.8 HIGH; CISA KEV-listed June 17, 2025
- [Red Hat: CVE-2023-0386](https://access.redhat.com/security/cve/cve-2023-0386) — vendor advisory and technical summary
