# Filesystem War Stories

> Four incidents where a filesystem behaved *exactly as designed* and still lost data, handed out root, or corrupted itself while trying to fix corruption — and what the kernel changed in response

Filesystems fail in instructive ways. The bugs below aren't sloppy code; each one is a design decision colliding with reality — an optimization that widened a crash window, a container feature that trusted the wrong metadata, a RAID layer with no atomicity for its own updates. They map directly onto the concepts in [crash consistency](crash-consistency.md), [overlayfs](overlayfs.md), and [btrfs](btrfs.md).

## 1. ext4 and the empty files: delayed allocation meets `O_PONIES` (2009)

When ext4 became a default, users upgrading from ext3 started reporting a shocking symptom: after a crash or hard power-off, recently-saved files — KDE config, session state, whole dotfiles — came back **zero length**. Data that "had been saved" was simply gone.

Nothing was corrupt. This was [delayed allocation](iomap.md) working as intended. To choose good on-disk layout, ext4 defers picking physical blocks for freshly written data for up to ~30 seconds. Applications were saving files with the classic "atomic replace" idiom — write a new file, then `rename()` it over the old one — but *without* an `fsync()` in between. On ext3 the shorter allocation window and `data=ordered` behavior had made that pattern *usually* survive a crash. ext4's wider window turned "usually" into "usually not": after a crash, the rename had committed (metadata) but the data blocks were never allocated, leaving a valid directory entry pointing at an empty file.

The famous LKML thread that followed was, in effect, a fight over whether applications were owed durability they never asked for — Ted Ts'o's point was that **POSIX guarantees nothing without `fsync()`**, a position critics mockingly labeled the demand for "`O_PONIES`" (magical guarantees). But being *right* about POSIX doesn't help users. Ext4 added heuristics that detect exactly these idioms and force the data out: replacing a file via `rename()`, or truncating a file to zero and rewriting it, triggers writeback of the delayed-allocation blocks. The behavior is controlled by the **`auto_da_alloc`** mount option, on by default and [documented in the ext4 admin guide](https://docs.kernel.org/admin-guide/ext4.html).

**Lesson:** the gap between what the standard promises and what applications *assume* is where data goes to die. A correct optimization that changes observable timing is a compatibility break. See [crash consistency](crash-consistency.md) for why `fsync()` remains the only real guarantee.

## 2. overlayfs copy-up and a path to root: CVE-2023-0386 (2023)

[overlayfs](overlayfs.md) implements containers' layered images: a read-only lower layer, a writable upper layer, and **copy-up** — the first write to a lower-layer file copies it into the upper layer, preserving its metadata, including the setuid bit.

The vulnerability chained two features. An unprivileged user, inside a user namespace, could set up a [FUSE](fuse.md) mount that served a file *claiming* to be a setuid-root binary owned by uid 0. Used as an overlayfs lower layer, copy-up faithfully carried the setuid bit and ownership up into the real upper filesystem — where the mapping was no longer confined to the namespace. The result was a genuine setuid-root binary on a normally-mounted filesystem: a straight path from unprivileged user to root.

The fix makes copy-up **verify the uid/gid actually map** into the mounter's namespace and refuse the operation otherwise ([`4f11ada10d0a`](https://git.kernel.org/linus/4f11ada10d0a) "ovl: fail on invalid uid/gid mapping at copy up"). Copying up a file whose owner can't be represented in the caller's credentials is exactly the case that must fail closed.

**Lesson:** a filesystem that faithfully preserves metadata is a security boundary when one of its layers is attacker-controlled. Trusting uid/gid from a FUSE-backed lower layer meant trusting the attacker; the union filesystem must re-validate identity at the moment it crosses a privilege boundary.

## 3. The btrfs RAID5/6 write hole

[btrfs](btrfs.md) is copy-on-write and checksums everything, which normally makes it exceptionally crash-safe. Its parity RAID (RAID5/RAID6) is the glaring exception, and the reason is structural.

A RAID5 stripe is several data blocks plus one parity block computed across them. Updating part of a stripe means recomputing and rewriting parity. That read-modify-write of the parity block is **not** protected by btrfs's CoW transaction machinery — it happens in place. If power is lost after some of a stripe's blocks are written but before parity is consistent, the stripe is left with parity that doesn't match its data: the **write hole**. Worse, the corruption is latent — it only surfaces later, when a disk fails and btrfs reconstructs a block from the now-wrong parity, silently returning bad data (or, for metadata, endangering the whole filesystem). The btrfs project's own documentation marks RAID5/6 as **unstable** and [documents the write hole explicitly](https://btrfs.readthedocs.io/en/latest/btrfs-man5.html), cautioning against relying on it — the common guidance is to keep metadata on a RAID profile (like RAID1) that isn't exposed to it.

**Lesson:** crash consistency is not a property of "the filesystem" as a whole — each subsystem needs its own atomicity story. btrfs solved it for the tree and for single-device writes, but the parity-RAID stripe update sits *outside* that mechanism, so all the CoW guarantees above it don't reach it.

## 4. CVE-2025-68784: repairing a filesystem's own reallocating buffer out from under itself

XFS's [online repair](xfs.md#online-repair-xfs-519) can salvage extended-attribute values from metadata it otherwise judges too damaged to trust — `xrep_xattr_salvage_remote_attr()` reads a remote (out-of-line) attribute value out of a corrupt leaf block and copies whatever's recoverable into a scratch buffer, `sc->buf`, so it can be reinserted once the attribute structure itself is rebuilt.

The function builds a `struct xfs_da_args` — the argument struct XFS's attribute code passes around internally — as a single initializer, including `.value = ab->value` pointing at that scratch buffer. Only *after* constructing this struct does it call `xchk_setup_xattr_buf()` to make sure the buffer is large enough for the value it's about to salvage, growing it (via `krealloc()`-style reallocation) if the existing one is too small. If that reallocation moves the buffer, `ab->value` gets updated to point at the new memory — but `args.value`, captured at struct-initializer time, still points at the old, now-freed allocation. The subsequent call to `xfs_attr3_leaf_getvalue(leaf_bp, &args)` reads and writes through that stale pointer: a used-after-free in code whose entire job is repairing corruption, on a metadata path that only exists because [online repair](xfs.md#online-repair-xfs-519) added the ability to fix XFS attribute structures without unmounting.

The fix ([`5990fd756943`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=5990fd756943836978ad184aac980e2b36ab7e01) "xfs: fix a UAF problem in xattr repair", Darrick J. Wong) is a two-line reordering: drop `.value = ab->value` from the initializer, and assign `args.value = ab->value` explicitly right after `xchk_setup_xattr_buf()` returns successfully — guaranteeing `args.value` always reflects whatever `ab->value` currently is, reallocated or not. The bug had existed since Linux 6.10, when attribute repair itself was added.

**Lesson:** a pointer captured into a struct literal at declaration time is a snapshot, not a live reference — if anything between that declaration and the struct's use can reallocate the thing it points at, the snapshot is stale the moment the reallocation happens. This is the same class of bug as capturing a `container_of()` result across a lock you drop and reacquire: correct at the instant it was taken, wrong by the time it's used.

## Further reading

- [Crash Consistency and Recovery](crash-consistency.md) — journaling vs CoW, and why `fsync()` is the only durability contract
- [overlayfs](overlayfs.md) · [btrfs](btrfs.md) · [FUSE](fuse.md) · [XFS](xfs.md) — the subsystems these incidents live in
- [Kernel docs: ext4 admin guide](https://docs.kernel.org/admin-guide/ext4.html) — `auto_da_alloc` and the other ext4 mount options
