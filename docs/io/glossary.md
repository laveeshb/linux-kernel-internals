# I/O Glossary

Terms you'll encounter in Linux I/O internals, explained in context.

---

## A

### `address_space`
The in-kernel object (`struct address_space`) that connects a file's inode to its page cache pages. Every file has one. It contains the page cache (an XArray of `struct folio` objects), the `address_space_operations` vtable, and writeback state. See [`address_space_operations`](address-space-ops.md).

### `address_space_operations`
The vtable (`struct address_space_operations`) that filesystems use to plug their page cache behavior into the VFS. Defines `readpage`, `writepage`, `write_begin`, `write_end`, `bmap`, and similar hooks. See [address_space_operations](address-space-ops.md).

### AIO (Asynchronous I/O)
The POSIX asynchronous I/O interface (`aio_read`, `aio_write`, `aio_fsync`), and its Linux-specific `io_submit`/`io_getevents` variant. Allows I/O operations to be submitted and completed without blocking the calling thread. Largely superseded by `io_uring` for new code. See [Async I/O Evolution](async-io.md).

### `await` (iostat)
The average time from when an I/O is submitted to the device driver to when the completion is returned, in milliseconds. Includes queue wait time in the I/O scheduler plus device service time. High `await` with low `%util` indicates queue starvation or filesystem overhead.

---

## B

### Balance dirty pages (`balance_dirty_pages`)
The function called after every buffered write to check if the amount of dirty data in the page cache has exceeded the configured threshold. If it has, the writing process is throttled (slept for a computed interval) to allow writeback to catch up. See [Writeback Internals](writeback-internals.md).

### BDI (Backing Device Info)
The kernel structure (`struct backing_dev_info`) representing a storage device from the writeback subsystem's perspective. Tracks per-device dirty page counts, bandwidth estimates, and writeback state. Each block device has one; network filesystems (NFS) also register BDIs.

### BFQ (Budget Fair Queueing)
An I/O scheduler (`bfq`) that allocates each process a "budget" of sectors and provides proportional fairness. Designed for HDDs where fairness matters, and for multi-tenant environments using cgroup I/O weighting. See [I/O Schedulers](../block/io-schedulers.md).

### BIO
The fundamental kernel structure (`struct bio`) representing a single block I/O request — a set of physical memory pages to be read from or written to a range of block device sectors. Filesystems build BIOs; the block layer submits them to device drivers. Multiple BIOs can be merged into a request (`struct request`) by the I/O scheduler.

### Block layer
The kernel subsystem between filesystems (and direct I/O paths) and device drivers. Receives BIOs, optionally reorders and merges them via the I/O scheduler, and dispatches them to drivers. The modern block layer (`blk-mq`) supports multiple hardware queues for NVMe parallelism.

### `blk-mq`
The multi-queue block layer, introduced in v3.13 ([commit 320ae51feed5](https://git.kernel.org/linus/320ae51feed5)) and made the default in v4.9. Replaces the single-queue block layer with a design that supports multiple per-CPU software queues and multiple hardware queues, eliminating queue locking overhead on multi-core systems.

---

## C

### Copy-on-Write (COW)
A technique where two entities share a page until one modifies it, at which point the modifier receives its own private copy. Used in `fork()` (children share parents' pages until modified), in Btrfs and ZFS (snapshot semantics), and in overlayfs (container layers). In I/O, COW can cause write amplification when large pages are modified.

### `cgroup io controller`
The cgroup v2 controller that provides per-cgroup I/O throttling (`io.max`) and priority weighting (`io.weight`). Requires BFQ or Kyber scheduler for weighting. See [Tuning I/O for Containers](tuning-containers.md).

---

## D

### DAX (Direct Access)
A mode for accessing persistent memory (PMEM) devices without the page cache. Data is accessed at byte granularity directly from persistent memory, bypassing the block layer and page cache. Requires filesystem support (`ext4 -o dax`, XFS DAX). See [DAX](dax.md).

### Dirty page
A page in the page cache that has been modified by a write but not yet written back to storage. Dirty pages are tracked per-inode and per-BDI. The kernel flushes dirty pages to storage via writeback. See [Writeback Internals](writeback-internals.md).

### `dirty_ratio` / `dirty_background_ratio`
Sysctl tunables (`vm.dirty_ratio`, `vm.dirty_background_ratio`) that control dirty page throttling. `dirty_background_ratio` is the threshold at which background writeback starts. `dirty_ratio` is the threshold at which writing processes are throttled. See [I/O Sysctl Reference](sysctl-io-reference.md).

### `D state`
A process state in the Linux scheduler meaning "uninterruptible sleep" — the process is waiting for I/O to complete and cannot be killed by signals. A process stuck in D state for more than 120 seconds triggers a "hung task" warning. See [Debugging I/O Hangs](debugging-io-hangs.md).

---

## E

### `errseq_t`
A kernel type (introduced in v4.13, [commit 5660e13d2fd5](https://git.kernel.org/linus/5660e13d2fd5)) used to track whether a writeback error has occurred for a file since the last time the error was checked. `fsync()` uses `errseq_t` to return `EIO` exactly once after a writeback failure, rather than on every subsequent `fsync()` call.

### Extent
A contiguous range of blocks on storage allocated to a file. Modern filesystems (ext4 with extents enabled, XFS, Btrfs) use extents rather than per-block pointers for large files, reducing metadata overhead and enabling more efficient large I/O.

---

## F

### `fallocate`
A syscall that pre-allocates disk space for a file without writing data. Eliminates the possibility of `ENOSPC` during subsequent writes and prevents fragmentation. Supports modes including `FALLOC_FL_PUNCH_HOLE` (create holes in sparse files) and `FALLOC_FL_KEEP_SIZE` (allocate without changing file size). See [fallocate and Space Management](fallocate.md).

### `file_operations`
The vtable (`struct file_operations`) that drivers and filesystems register to implement file I/O. Contains function pointers for `read`, `write`, `ioctl`, `mmap`, `fsync`, `splice_read`, and others. The VFS calls these when an application performs I/O on a file descriptor. See [`struct file_operations`](file-operations.md).

### Flush command
A block layer request with `REQ_PREFLUSH` that tells the device to flush its write cache to persistent media before processing the accompanying write. Used by journaling filesystems to ensure ordering — journal commit writes only proceed after data writes are fully durable.

### Folio
A kernel abstraction (v5.16+, [commit 7b230db3b8d3](https://git.kernel.org/linus/7b230db3b8d3)) representing one or more contiguous pages in the page cache. Replaces the ambiguous use of `struct page` for multi-page allocations. A folio is always the head of a compound page or a single page. See [Page Cache Internals](page-cache-internals.md).

### FUA (Force Unit Access)
A flag on a block request (`REQ_FUA`) that tells the device to write the data directly to persistent media, bypassing the device's write cache. Slower than a cached write, but guarantees that the data survives a power failure. Used for journal commits and explicit `fsync()` operations.

---

## I

### `iomap`
A modern kernel framework (introduced in v4.8, [commit 4b4bb46d00b3](https://git.kernel.org/linus/4b4bb46d00b3)) for implementing filesystem block mapping — the translation from file offsets to block device addresses. Replaces the older `buffer_head` approach for I/O, enabling more efficient large I/O, direct I/O, and DAX. Used by XFS, ext4 (for large files), Btrfs, and others. See [iomap Internals](iomap-internals.md).

### `io_uring`
A Linux I/O interface (v5.1, [commit 2b188cc1bb857](https://git.kernel.org/linus/2b188cc1bb857)) that uses shared-memory ring buffers to submit and complete I/O with minimal syscall overhead. Supports arbitrary operations (not just file I/O), kernel-side polling (`IORING_SETUP_SQPOLL`), and registered buffers. See [io_uring Architecture](../io-uring/io-uring-arch.md).

### `iov_iter`
A kernel structure (`struct iov_iter`) that abstracts the source or destination of an I/O operation. Can represent a userspace `iovec` array, a kernel buffer, a pipe, or a BVEC (page array). Filesystem `read` and `write` paths accept `iov_iter` rather than raw user pointers. See [iov_iter](iov-iter.md).

### IOPS (I/O Operations Per Second)
The number of individual read or write operations completed per second. Relevant for random I/O workloads where each operation accesses a different location and the per-operation latency dominates throughput.

---

## J

### JBD2 (Journaling Block Device 2)
The journaling layer used by ext4. Manages the filesystem journal: batches metadata updates into transactions, writes transactions to the journal, and replays them on recovery. JBD2 is separate from ext4 and can theoretically be used by other filesystems. Commit: [bb6142ca6cfe](https://git.kernel.org/linus/bb6142ca6cfe).

### Journal
A log of filesystem metadata updates (and optionally data) maintained on disk to ensure consistency after a crash. On crash recovery, the journal is replayed: committed transactions are applied, uncommitted ones are discarded. This ensures the filesystem is always in a consistent state after recovery.

---

## K

### `kiocb`
The per-I/O control block (`struct kiocb`) that tracks the state of an in-progress read or write operation. Contains the file, offset, I/O size, flags (`IOCB_DIRECT`, `IOCB_SYNC`, etc.), and completion information. Filesystem `read_iter` and `write_iter` methods take a `kiocb`. See [`struct kiocb`](kiocb.md).

### Kyber
An I/O scheduler designed for fast multi-queue devices (NVMe). Uses per-domain queues (reads, writes, discard) with latency-based throttling rather than BFQ's per-process budget approach. Lower overhead than BFQ, appropriate for NVMe with moderate fairness requirements.

---

## M

### `mq-deadline`
A multi-queue variant of the deadline I/O scheduler. Maintains separate queues for reads and writes with configurable deadlines to prevent starvation. Good default for SATA SSDs and situations where BFQ overhead is not acceptable.

### `mmap` I/O
Accessing file data via memory-mapped regions (`mmap(2)`) rather than `read()`/`write()`. The page cache backs the mapping; reads fault pages in from storage; writes dirty pages. Avoids a userspace copy compared to `read()`/`write()` for shared-memory patterns. See [Memory-Mapped I/O](mmap-io.md).

---

## O

### `O_DIRECT`
A flag for `open(2)` that bypasses the page cache for reads and writes. Data transfers go directly between the userspace buffer and storage via DMA. Requires aligned buffer, offset, and transfer size. Used by databases and streaming workloads to avoid double-caching. See [Direct I/O](direct-io.md) and [Buffered I/O vs Direct I/O](buffered-vs-direct.md).

### `O_SYNC` / `O_DSYNC`
Flags for `open(2)` that make each `write()` synchronous. `O_SYNC` waits for data and all metadata. `O_DSYNC` waits for data and the minimum metadata needed to retrieve it (equivalent to calling `fdatasync()` after every write). See [fsync, fdatasync, and O_SYNC](fsync-fdatasync.md).

### Overlayfs
A union filesystem used by Docker and other container runtimes. Presents a merged view of multiple directory layers: reads come from the highest layer containing the file; writes go to the top (writable) layer using copy-on-write. See [Tuning I/O for Containers](tuning-containers.md).

---

## P

### Page cache
The kernel's in-memory cache of file data. All buffered reads and writes pass through the page cache. The page cache is managed as an XArray (since v4.20) indexed by page offset within the file. See [Page Cache Internals](page-cache-internals.md) and [Buffered I/O and the Page Cache](buffered-io.md).

### `PIPE_BUF`
The maximum size of an atomic write to a pipe or FIFO (at least 512 bytes; 4096 on Linux). Writes ≤ `PIPE_BUF` are guaranteed to be atomic — they complete without interleaving with writes from other processes. See [Writes Are Not Atomic](writes-not-atomic.md).

### PSI (Pressure Stall Information)
A kernel mechanism (v4.20, [commit 0e94682b73bf](https://git.kernel.org/linus/0e94682b73bf)) that measures the fraction of time tasks are stalling due to resource (CPU, memory, I/O) contention. Exposed via `/proc/pressure/{cpu,memory,io}`. The most direct measure of I/O impact on application performance. See [Debugging Slow I/O](debugging-slow-io.md).

---

## R

### Readahead
The kernel's mechanism for speculatively reading pages ahead of the current file position. Detects sequential access patterns and prefetches subsequent pages before they are requested. Configurable via `/sys/block/<dev>/queue/read_ahead_kb` and `posix_fadvise(POSIX_FADV_SEQUENTIAL)`. See [Readahead](readahead.md).

### `REQ_SYNC`
A block request flag indicating the I/O is on the synchronous path (the process is waiting for it). The block layer and I/O scheduler use this flag to prioritize synchronous reads over asynchronous writeback.

---

## S

### `sendfile`
A syscall that transfers data between file descriptors directly in the kernel, without copying to userspace. Used for high-performance file serving (the web server copies a file to a socket without touching the data in userspace). See [splice, sendfile, and Zero-Copy](splice-sendfile.md).

### Sparse file
A file with "holes" — regions that have been allocated in the directory entry but contain no actual data on storage. Reads from holes return zeros. Created via `ftruncate` or `lseek + write` beyond the current end of file. See [fallocate and Space Management](fallocate.md).

### `splice`
A syscall that moves data between file descriptors via the page cache or a pipe buffer, without copying to userspace. More general than `sendfile`. See [splice, sendfile, and Zero-Copy](splice-sendfile.md).

### `struct file`
The per-open-file-descriptor kernel object. Contains the current file position, flags (O_RDONLY, O_DIRECT, etc.), reference count, and a pointer to the inode. Each `open()` call creates a new `struct file`; multiple file descriptors can refer to the same `struct file` via `dup()`. See [`struct file_operations`](file-operations.md).

### `sync_file_range`
A syscall for fine-grained writeback control: kick off writeback for a specific byte range of a file without waiting, wait for in-progress writeback of a range, or both. Used by databases to overlap data writeback with WAL writes. Does not guarantee durability (does not flush the device's write cache). See [I/O Consistency and Ordering](io-consistency.md).

---

## V

### VFS (Virtual Filesystem Switch)
The kernel abstraction layer between system calls (`open`, `read`, `write`) and specific filesystem implementations (ext4, XFS, Btrfs). Provides a unified interface so applications can work with any filesystem. Contains the `inode`, `dentry`, `file`, and `superblock` abstractions. See [Life of an open()](life-of-an-open.md).

---

## W

### Writeback
The process of flushing dirty pages from the page cache to storage. Triggered by dirty thresholds (`dirty_background_ratio`) and page age (`dirty_expire_centisecs`). Performed by per-BDI kworker threads (`writeback` kworkers). See [Writeback Internals](writeback-internals.md) and [Page Cache Writeback](page-cache-writeback.md).

### Write amplification
When a small write causes a larger write to storage. Sources include: journaling (write once to journal, once to final location), copy-on-write filesystems (write to new location + update metadata), RAID parity updates, and SSD internal garbage collection.

---

## X

### XArray
The data structure (introduced in v4.20) used to store pages in the page cache. Replaces the radix tree. An XArray is a resizable array of pointers with efficient sparse storage, RCU-friendly lockless reads for common cases, and built-in support for marks (dirty, writeback). See [Page Cache Internals](page-cache-internals.md).

---

## Z

### Zero-copy
Transferring data between I/O endpoints without copying it through userspace buffers. Techniques include `sendfile()`, `splice()`, `O_DIRECT` with DMA, and the `MSG_ZEROCOPY` socket flag. Reduces CPU overhead and memory bandwidth consumption for high-throughput I/O. See [Zero-Copy Internals](zero-copy-internals.md).
