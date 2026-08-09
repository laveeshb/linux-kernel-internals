# iomap: the Extent-Based I/O Framework

> The modern, filesystem-agnostic layer that maps file offsets to device blocks and drives buffered, direct, and DAX I/O over them — what it is, what it replaced, and why

For most of Linux's history, the generic code that turned a `read()` or `write()` into block I/O was built on the **`buffer_head`**: one small descriptor per filesystem block. iomap is the framework that replaced it, and it is now the shared I/O engine under XFS, gfs2, zonefs, and the direct-I/O path of ext4 and btrfs (plus ext4's DAX path). Understanding iomap is understanding how a modern Linux filesystem actually moves data.

## The problem with `buffer_head`

A `buffer_head` describes the mapping and state of a **single** filesystem block (typically 4 KiB). That granularity is the whole problem:

- **One struct per block.** A 1 MiB buffered write allocates and threads ~256 `buffer_head`s, each individually mapped, tracked, and torn down — real CPU and memory overhead for what is logically one contiguous operation.
- **No notion of an extent.** Modern filesystems (XFS, ext4, btrfs) store files as **extents** — "these 40,000 blocks are contiguous on disk." The `buffer_head` model can't express that; it re-derives the mapping one block at a time.
- **Tangled state.** `buffer_head` mixed the block *mapping* with page dirtiness/writeback state and locking, making the generic paths hard to reason about and hard to make concurrent.

## The core idea: describe a mapping, not a block

iomap's central structure, `struct iomap`, describes an arbitrarily large **contiguous mapping** of a file range to a device range in a single object — offset, length, the device block address, the backing device, and a **type**:

| Type | Meaning |
|---|---|
| `IOMAP_MAPPED` | real, allocated blocks on disk at a known address |
| `IOMAP_HOLE` | a sparse hole — reads return zeros, no blocks allocated |
| `IOMAP_UNWRITTEN` | blocks are allocated but not yet initialized (preallocation); reads return zeros |
| `IOMAP_DELALLOC` | delayed allocation — reserved in memory, no physical block chosen yet |
| `IOMAP_INLINE` | data stored inline in the inode itself |

One `struct iomap` can cover megabytes, so the generic code asks the filesystem for a mapping *once* and then processes the whole range.

## How it works: `iomap_begin` and the iteration loop

The division of labor is the point. The filesystem provides just two callbacks in a `struct iomap_ops`:

- **`->iomap_begin(inode, pos, length, ...)`** — "for this file range, fill in a `struct iomap`." This is the *only* filesystem-specific logic: consult the extent tree, allocate if needed, and return the mapping.
- **`->iomap_end()`** — optional cleanup/commit after the range is processed.

Everything else lives in generic `fs/iomap/` code. An operation runs the **`iomap_iter`** loop: it calls `->iomap_begin` for the current position, gets back a mapping, does the actual work (copy to/from the page cache, build and submit `bio`s) across that mapping, advances, and repeats until the whole request is covered. The filesystem never touches the page cache or the [block layer](../block/bio-request.md) directly — it only answers "where does this file offset live?"

On top of the iterator, iomap provides the full set of high-level operations, so a filesystem gets them all by implementing `iomap_begin` once:

- **Buffered I/O** — `iomap_file_buffered_write()`, and the buffered read path, folio-native.
- **Direct I/O** — `iomap_dio_rw()`, the shared O_DIRECT engine.
- **Writeback** — building `bio`s from dirty folios over their mappings.
- **DAX** — direct-access I/O to persistent memory, bypassing the page cache.
- **`FIEMAP`, `SEEK_HOLE`/`SEEK_DATA`, swapfile activation** — all fall out of the same "ask the fs for the mapping" model.

## History and adoption

iomap was introduced in 2016 by Christoph Hellwig ([`ae259a9c8593`](https://git.kernel.org/linus/ae259a9c8593) "fs: introduce iomap infrastructure", Linux 4.8), initially to give XFS a clean `SEEK_HOLE`/`FIEMAP` and direct-I/O path. It proved general enough that the code was later split into its own subsystem directory ([`1c230208f53d`](https://git.kernel.org/linus/1c230208f53d) "iomap: start moving code to fs/iomap/"), and filesystems migrated their paths onto it:

- **XFS** — the original consumer; all of its I/O paths run on iomap.
- **gfs2, zonefs, erofs** — adopted iomap for their block-mapping and I/O.
- **ext4** — uses iomap for DAX and direct I/O.
- **btrfs** — moved its direct-I/O path onto iomap.

iomap was also **converted to folios early**, and — crucially — its generic paths were already centralized in `fs/iomap/` rather than duplicated behind per-filesystem `buffer_head` code. That is why the kernel's folio conversion advanced first through the iomap-based filesystems: there was one place to convert, not one per filesystem.

## Further reading

- [Kernel docs: iomap design](https://docs.kernel.org/filesystems/iomap/design.html) — the data model and the theory of operation
- [Kernel docs: iomap operations](https://docs.kernel.org/filesystems/iomap/operations.html) — the buffered, direct, DAX, and writeback APIs
- [bio and request structures](../block/bio-request.md) — the block-layer objects iomap builds and submits
- [ext4](ext4.md) · [XFS](xfs.md) · [btrfs](btrfs.md) — the filesystems whose I/O paths run on iomap
