# Crash Consistency and Recovery

> Why a filesystem survives a power cut mid-write — the two strategies (journaling and copy-on-write), what `fsync()` really promises, and where the guarantees leak

A single logical operation — appending to a file — touches several independent places on disk: the data blocks, the inode's block map, the inode itself (size, mtime), and the free-space bitmap. The device commits these whenever it likes, in whatever order it likes. If power fails partway through, the on-disk image can be left in a state that no correct sequence of operations could produce: an inode claiming blocks the allocator still considers free, or a lengthened file whose tail points at uninitialized garbage.

Crash consistency is the property that, after an unclean shutdown, the filesystem can be brought back to *some* valid state — never a corrupt one. Every serious Linux filesystem provides it, and they do so in one of two ways.

## Why you can't just "write carefully"

Ordering writes in the code doesn't order them on the platter. Two things get in the way:

- **Reordering.** The [block layer](../block/bio-request.md), the device queue, and the drive's own firmware are all free to reorder in-flight writes to optimize seeks and parallelism.
- **Volatile caches.** Almost every drive has a volatile write-back cache. A write that has "completed" from the kernel's point of view may still live only in that cache, and is lost on power failure.

So the filesystem needs a way to say *"these writes must reach stable media before those."* The kernel expresses this with two request flags (see the block layer's [writeback cache control](https://docs.kernel.org/block/writeback_cache_control.html)):

- **`REQ_PREFLUSH`** — flush the device cache so all *previously* completed writes are on stable media before this request begins.
- **`REQ_FUA`** (Force Unit Access) — this request itself must be on stable media before it is reported complete.

A journal commit and a CoW superblock update are both, underneath, a carefully placed pair of flush/FUA writes. (These replaced the older, coarser "write barriers"; the barrier concept was removed once flush/FUA gave finer control.)

## Strategy 1: journaling (ext4, XFS)

A journaling filesystem writes its intended changes to a dedicated **log** *before* touching their real locations. The sequence for one transaction:

1. Write the changed blocks (or just the metadata) into the journal.
2. Issue a flush, then write a **commit record** — with `REQ_FUA` — that marks the transaction complete and durable.
3. Only later ("checkpoint") copy the changes to their real, in-place locations.

If the machine crashes before step 2's commit record lands, recovery discards the incomplete transaction — it's as if the operation never happened. If it crashes after, recovery **replays** the logged blocks over their in-place destinations. Either way the filesystem lands in a consistent state, and recovery is bounded by the size of the log rather than a full-disk `fsck`.

What gets journaled is a policy choice. ext4 offers three data modes:

- **`data=journal`** — both data and metadata go through the log. Safest, roughly half the write throughput (everything is written twice).
- **`data=ordered`** (the default) — only metadata is journaled, but data blocks are forced to disk *before* the metadata that references them commits. This closes the "inode points at garbage" hole without journaling data.
- **`data=writeback`** — metadata journaled, no ordering of data against it: after a crash, metadata is consistent but a freshly extended file may expose stale contents.

The jbd2 mechanics behind all this — transactions, the commit record, checkpointing — are covered in the [ext4 journaling deep dive](ext4-journal.md). XFS uses the same write-ahead-logging idea with a very different, highly concurrent design (delayed logging, in-memory log items); see the kernel's [XFS delayed logging design](https://docs.kernel.org/filesystems/xfs/xfs-delayed-logging-design.html).

## Strategy 2: copy-on-write (btrfs)

A copy-on-write filesystem never overwrites live data. To change a block, it writes a *new* copy into free space, then updates the pointer to it — which, being a metadata block, is itself copied and re-pointed, all the way up the tree to the root. Nothing that the current, committed tree references is ever mutated in place.

A transaction commits by writing all the new blocks, flushing, and then atomically updating the **superblock** to point at the new tree root (again with a flush/FUA so the superblock write is durable and last). The superblock update is the single atomic pivot: either the new root is installed or it isn't.

Recovery is therefore trivial — there is nothing to replay. A crash mid-transaction simply leaves the superblock pointing at the *previous* root, and the half-written new blocks sit in space the old tree never referenced, to be reclaimed. btrfs keeps multiple superblock copies with monotonic generation numbers so it can always find the newest fully-written one. Snapshots are the same mechanism used deliberately: a snapshot is just an old tree root that is kept instead of reclaimed. See [btrfs](btrfs.md).

## `fsync()`: the application's durability contract

Filesystem consistency is not the same as *your data being safe*. After a crash a journaled filesystem guarantees its own metadata is consistent, but a `write()` that was still sitting in the [page cache](../io/page-cache-writeback.md) is simply gone. The only way an application forces its data to durable storage is `fsync()`/`fdatasync()` (or opening with `O_SYNC`), which flushes the file's dirty pages and the metadata needed to find them, all the way through the device cache.

This contract had a notorious hole. Historically the kernel recorded a writeback failure by setting a single per-inode error bit and clearing it on the first reader — so if the kernel's own flusher observed the `EIO` first, a later `fsync()` from the application returned **success** even though the data never reached disk. PostgreSQL hit exactly this in 2018 ("fsyncgate"): a checkpoint's `fsync()` reported success after the writeback error had already been consumed and discarded, and the database wrongly believed its data was safe. The fix was new per-file error tracking (`errseq_t`) that guarantees **every** open file descriptor sees a writeback error exactly once, regardless of who else observed it ([`5660e13d2fd6`](https://git.kernel.org/linus/5660e13d2fd6) "fs: new infrastructure for writeback error handling and reporting", building on the [`84cbadadc6ea`](https://git.kernel.org/linus/84cbadadc6ea) `errseq_t` type).

## Where the guarantees leak

Every scheme above rests on one assumption: **when the kernel issues a flush, the device actually persists.** Consumer drives have been caught ignoring `FLUSH`/FUA to win benchmarks; a drive that lies about durability defeats journaling and CoW alike, because the "committed" record may still be in a cache that a power cut erases. This is why durability testing uses real power-loss rigs, and why enterprise SSDs advertise power-loss-protected caches. The filesystem can only be as consistent as the storage is honest.

## Further reading

- [ext4 journaling deep dive](ext4-journal.md) — jbd2 transactions and the commit path in detail
- [btrfs](btrfs.md) — the copy-on-write B-tree and superblock pivot
- [page cache and writeback](../io/page-cache-writeback.md) — where dirty data lives before `fsync()`
- [Kernel docs: writeback cache control](https://docs.kernel.org/block/writeback_cache_control.html) — `REQ_PREFLUSH` / `REQ_FUA` semantics
- [Kernel docs: ext4 journal](https://docs.kernel.org/filesystems/ext4/journal.html) — the on-disk jbd2 format
