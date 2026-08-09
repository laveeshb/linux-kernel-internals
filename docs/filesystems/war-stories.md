# Filesystem War Stories

> Three incidents where a filesystem behaved *exactly as designed* and still lost data or handed out root — and what the kernel changed in response

Filesystems fail in instructive ways. The bugs below aren't sloppy code; each one is a design decision colliding with reality — an optimization that widened a crash window, a container feature that trusted the wrong metadata, a RAID layer with no atomicity for its own updates. They map directly onto the concepts in crash consistency, [overlayfs](overlayfs.md), and [btrfs](btrfs.md).

## 1. ext4 and the empty files: delayed allocation meets `O_PONIES` (2009)

When ext4 became a default, users upgrading from ext3 started reporting a shocking symptom: after a crash or hard power-off, recently-saved files — KDE config, session state, whole dotfiles — came back **zero length**. Data that "had been saved" was simply gone.

Nothing was corrupt. This was delayed allocation working as intended. To choose good on-disk layout, ext4 defers picking physical blocks for freshly written data for up to ~30 seconds. Applications were saving files with the classic "atomic replace" idiom — write a new file, then `rename()` it over the old one — but *without* an `fsync()` in between. On ext3 the shorter allocation window and `data=ordered` behavior had made that pattern *usually* survive a crash. ext4's wider window turned "usually" into "usually not": after a crash, the rename had committed (metadata) but the data blocks were never allocated, leaving a valid directory entry pointing at an empty file.

The famous LKML thread that followed was, in effect, a fight over whether applications were owed durability they never asked for — Ted Ts'o's point was that **POSIX guarantees nothing without `fsync()`**, a position critics mockingly labeled the demand for "`O_PONIES`" (magical guarantees). But being *right* about POSIX doesn't help users. Ext4 added heuristics that detect exactly these idioms and force the data out: replacing a file via `rename()`, or truncating a file to zero and rewriting it, triggers writeback of the delayed-allocation blocks. The behavior is controlled by the **`auto_da_alloc`** mount option, on by default and [documented in the ext4 admin guide](https://docs.kernel.org/admin-guide/ext4.html).

**Lesson:** the gap between what the standard promises and what applications *assume* is where data goes to die. A correct optimization that changes observable timing is a compatibility break. `fsync()` remains the only real guarantee.

## 2. overlayfs copy-up and a path to root: CVE-2023-0386 (2023)

[overlayfs](overlayfs.md) implements containers' layered images: a read-only lower layer, a writable upper layer, and **copy-up** — the first write to a lower-layer file copies it into the upper layer, preserving its metadata, including the setuid bit.

The vulnerability chained two features. An unprivileged user, inside a user namespace, could set up a FUSE mount that served a file *claiming* to be a setuid-root binary owned by uid 0. Used as an overlayfs lower layer, copy-up faithfully carried the setuid bit and ownership up into the real upper filesystem — where the mapping was no longer confined to the namespace. The result was a genuine setuid-root binary on a normally-mounted filesystem: a straight path from unprivileged user to root.

The fix makes copy-up **verify the uid/gid actually map** into the mounter's namespace and refuse the operation otherwise ([`4f11ada10d0a`](https://git.kernel.org/linus/4f11ada10d0a) "ovl: fail on invalid uid/gid mapping at copy up"). Copying up a file whose owner can't be represented in the caller's credentials is exactly the case that must fail closed.

**Lesson:** a filesystem that faithfully preserves metadata is a security boundary when one of its layers is attacker-controlled. Trusting uid/gid from a FUSE-backed lower layer meant trusting the attacker; the union filesystem must re-validate identity at the moment it crosses a privilege boundary.

## 3. The btrfs RAID5/6 write hole

[btrfs](btrfs.md) is copy-on-write and checksums everything, which normally makes it exceptionally crash-safe. Its parity RAID (RAID5/RAID6) is the glaring exception, and the reason is structural.

A RAID5 stripe is several data blocks plus one parity block computed across them. Updating part of a stripe means recomputing and rewriting parity. That read-modify-write of the parity block is **not** protected by btrfs's CoW transaction machinery — it happens in place. If power is lost after some of a stripe's blocks are written but before parity is consistent, the stripe is left with parity that doesn't match its data: the **write hole**. Worse, the corruption is latent — it only surfaces later, when a disk fails and btrfs reconstructs a block from the now-wrong parity, silently returning bad data (or, for metadata, endangering the whole filesystem). The btrfs project's own documentation marks RAID5/6 as **unstable** and [documents the write hole explicitly](https://btrfs.readthedocs.io/en/latest/btrfs-man5.html), cautioning against relying on it — the common guidance is to keep metadata on a RAID profile (like RAID1) that isn't exposed to it.

**Lesson:** crash consistency is not a property of "the filesystem" as a whole — each subsystem needs its own atomicity story. btrfs solved it for the tree and for single-device writes, but the parity-RAID stripe update sits *outside* that mechanism, so all the CoW guarantees above it don't reach it.

## Further reading

- [overlayfs](overlayfs.md) · [btrfs](btrfs.md) — the subsystems these incidents live in
- [Kernel docs: ext4 admin guide](https://docs.kernel.org/admin-guide/ext4.html) — `auto_da_alloc` and the other ext4 mount options
