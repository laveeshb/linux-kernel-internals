# I/O Patterns

> How Linux moves data between userspace, the page cache, and storage — and why the interface you choose shapes everything from latency to correctness

## Getting Started

This documentation explains how Linux handles I/O — not just the system call API, but the implementation decisions underneath: where data lives at each stage, what copies happen (or don't), what the kernel defers, and what trade-offs each interface forces on application developers.

### Prerequisites

This documentation assumes familiarity with:
- **C programming** — The kernel is written in C; syscall behavior is best understood at the C level
- **Basic OS concepts** — Processes, kernel vs. userspace, system calls, file descriptors
- **File descriptors** — What they are, how `open()` / `close()` / `dup()` work, and that they reference kernel-side `struct file` objects

If you've used `read()` and `write()` from C and wondered what happens inside, you're in the right place. A passing familiarity with virtual memory (pages, the page cache) will help but is not required — the relevant concepts are introduced where needed. See [Further Reading](#further-reading) for recommended textbooks.

### Getting the Kernel Source

```bash
git clone https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git
cd linux
```

The most relevant directories for I/O are `mm/` (page cache, readahead, writeback) and `fs/` (syscall entry points, splice, fallocate). For building and configuration, see [Documentation/admin-guide/README.rst](https://docs.kernel.org/admin-guide/README.html).

### Running Tests

The fastest way to experiment with I/O behavior without rebooting your machine:

```bash
# Install virtme-ng (runs the kernel in QEMU with your host filesystem)
pip install virtme-ng

# Build and boot with a test module
virtme-ng --kdir . --append 'test_module.run_tests=1'
```

For tracing I/O at runtime on your current kernel, `blktrace`, `bpftrace`, and `ftrace` are the primary tools — see [observability.md](observability.md) for how to use them.

### Suggested Reading Order

**Fundamentals — start here:**

1. **[Buffered I/O](buffered-io.md)** — How `read()` and `write()` interact with the page cache; what "buffered" actually means
2. **[Direct I/O](direct-io.md)** — `O_DIRECT`, alignment requirements, when to bypass the page cache, and when not to
3. **[Readahead](readahead.md)** — How the kernel speculatively fetches pages before you ask for them, and how to control it
4. **[Page Cache and Writeback](page-cache-writeback.md)** — Dirty pages, flusher threads, `fsync()`, and the durability guarantees (or lack thereof) of `write()`

**Memory-Mapped I/O:**

5. **[mmap I/O](mmap-io.md)** — Mapping files into the address space; page faults as the I/O mechanism; when mmap wins and when it doesn't

**Zero-Copy and Vectored:**

6. **[splice and sendfile](splice-sendfile.md)** — Moving data between file descriptors without userspace copies; what "zero-copy" actually means here
7. **[Vectored I/O](vectored-io.md)** — `readv()` / `writev()`, scatter-gather, `iov_iter` internals

**End-to-End Walkthroughs:**

8. **[Life of a write](life-of-a-write.md)** — Tracing a `write()` call from userspace through the page cache to the block layer
9. **[Async I/O](async-io.md)** — POSIX AIO (fake), Linux AIO (`io_submit`), and io_uring (real async); why the history matters

**Observability and Tuning:**

10. **[Observability](observability.md)** — Tools for measuring I/O: `iostat`, `blktrace`, `bpftrace`, `perf`, `/proc/diskstats`
11. **[Tuning Storage I/O](tuning-storage.md)** — Scheduler selection, readahead size, dirty ratio knobs, `fadvise()`, `madvise()`

**War Stories:**

12. **[War Stories](war-stories.md)** — Real bugs, surprising behaviors, and production incidents traced to I/O subsystem edge cases

### What You'll Learn

| Textbook Concept | Linux Reality |
|------------------|---------------|
| "`write()` saves data to disk" | [No — it writes into the page cache](page-cache-writeback.md). The kernel may not flush to storage for seconds. Call `fsync()` if you need durability |
| "`O_DIRECT` is faster" | [Depends entirely on workload](direct-io.md). Alignment requirements are strict, readahead is disabled, and for workloads with temporal locality the page cache usually wins |
| "`sendfile` is zero-copy" | [Zero userspace copies, yes](splice-sendfile.md), but the CPU still touches metadata and socket buffers. True zero-copy (DMA to NIC) requires additional hardware support |
| "`mmap` is always faster than `read()`" | [Not for sequential streaming](mmap-io.md). Page fault overhead and TLB pressure make `read()` competitive; mmap wins for random access and shared data |
| "AIO is async" | [It depends which AIO you mean](async-io.md). POSIX AIO (`aio_read`) is implemented with threads in glibc. Linux AIO (`io_submit`) is real kernel async but restricted to `O_DIRECT`. io_uring is the first truly general async I/O mechanism |
| "`splice` avoids copies" | [Only when no transformation is needed](splice-sendfile.md). Splice moves page references between kernel structures — the moment you touch the data, the copy happens |

### What Makes This Different

- **Real commits**: Every claim links to actual kernel commits
- **Real bugs**: Learn from what broke in production and why
- **Real discussions**: Links to LKML where design decisions were debated
- **Real trade-offs**: Not just "what" but "why this interface and not that one"
- **Hands-on**: "Try It Yourself" sections with commands to run and code to read

---

## Documentation

### Fundamentals

| Document | What You'll Learn |
|----------|-------------------|
| [buffered-io](buffered-io.md) | How `read()` and `write()` move data through the page cache; what happens on a cache hit vs. miss |
| [readahead](readahead.md) | The kernel's speculative prefetch logic; `POSIX_FADV_SEQUENTIAL`, `posix_fadvise()`, manual readahead |
| [page-cache-writeback](page-cache-writeback.md) | Dirty page accounting, flusher threads (`wb_workfn`), dirty throttling, and what `fsync()` actually flushes |
| [direct-io](direct-io.md) | `O_DIRECT` path through the kernel, alignment constraints, DIO vs. buffered I/O performance trade-offs |

### Memory-Mapped I/O

| Document | What You'll Learn |
|----------|-------------------|
| [mmap-io](mmap-io.md) | File-backed `mmap`, page fault handling, `MAP_SHARED` vs. `MAP_PRIVATE`, `msync()`, and when mmap hurts |

### Zero-Copy and Vectored

| Document | What You'll Learn |
|----------|-------------------|
| [splice-sendfile](splice-sendfile.md) | `splice()`, `sendfile()`, `tee()`; pipe buffers as the kernel's zero-copy primitive; limitations |
| [vectored-io](vectored-io.md) | `readv()` / `writev()`, scatter-gather DMA, `iov_iter` as the kernel's unified buffer abstraction |

### Allocation and Space Management

| Document | What You'll Learn |
|----------|-------------------|
| [fallocate](fallocate.md) | Pre-allocating space without writing data; `FALLOC_FL_PUNCH_HOLE`, `FALLOC_FL_KEEP_SIZE`, sparse files |

### End-to-End Walkthroughs

| Document | What You'll Learn |
|----------|-------------------|
| [life-of-a-write](life-of-a-write.md) | Tracing `write()` from the syscall entry through VFS, the address space, the block layer, and back |
| [async-io](async-io.md) | POSIX AIO implementation, Linux AIO (`io_submit`) restrictions, io_uring submission queues and completion rings |

### Observability and Tuning

| Document | What You'll Learn |
|----------|-------------------|
| [observability](observability.md) | Reading `/proc/diskstats`, `iostat`, `blktrace` event anatomy, `bpftrace` one-liners for I/O tracing |
| [tuning-storage](tuning-storage.md) | Block scheduler selection, `nr_requests`, readahead tuning, dirty ratio knobs, `fadvise` / `madvise` hints |

### War Stories

| Document | What You'll Learn |
|----------|-------------------|
| [war-stories](war-stories.md) | Production incidents and surprising behaviors: write ordering bugs, `fsync` gaps, mmap + truncate races |

---

## Key Source Files

If you want to read the actual kernel code:

| File | What It Does |
|------|--------------|
| [`mm/filemap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/filemap.c) | Core page cache implementation — `generic_file_read_iter()`, `generic_file_write_iter()`, page lookup and insertion |
| [`mm/readahead.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/readahead.c) | Readahead state machine, `page_cache_async_readahead()`, `force_page_cache_readahead()` |
| [`mm/page-writeback.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page-writeback.c) | Dirty page accounting, dirty throttling (`balance_dirty_pages()`), writeback control |
| [`fs/fs-writeback.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/fs-writeback.c) | Inode writeback, `wb_workfn()` flusher thread, `sync_inodes_sb()`, writeback bandwidth estimation |
| [`fs/read_write.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/read_write.c) | `read()`, `write()`, `pread()`, `pwrite()` syscall entry points; `vfs_read()` / `vfs_write()` |
| [`fs/splice.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/splice.c) | `splice()`, `sendfile()`, `tee()` — pipe buffer movement between file descriptors |
| [`fs/fallocate.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/fallocate.c) | `fallocate()` syscall dispatch; mode flag validation; filesystem delegation |
| [`lib/iov_iter.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/iov_iter.c) | `iov_iter` abstraction over `iovec`, `kvec`, `bio_vec`, and pipe buffers; copy to/from user |
| [`include/linux/fs.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/fs.h) | `struct file`, `struct inode`, `struct address_space`, `struct file_operations` — the central VFS types |

---

## Further Reading

### Blogs and Articles

- Jens Axboe's blog — [https://axboe.dk/](https://axboe.dk/) — Axboe is the author of io_uring and the block layer; his posts explain design decisions directly from the source
- LWN.net I/O coverage:
    - [Clarifying memory management with page folios](https://lwn.net/Articles/849538/) — folio conversion and the move away from raw page pointers
    - [Ringing in a new asynchronous I/O API](https://lwn.net/Articles/776703/) — the original io_uring introduction
    - [Buffered I/O without page-cache thrashing](https://lwn.net/Articles/806980/) — `RWF_UNCACHED`, a buffered-I/O mode that avoids polluting the page cache
    - [No-I/O dirty throttling](https://lwn.net/Articles/456904/) — how dirty throttling was redesigned

### Kernel Documentation

- [Documentation/filesystems/vfs.rst](https://docs.kernel.org/filesystems/vfs.html) — VFS layer internals, `file_operations`, `address_space_operations`
- [Documentation/filesystems/locking.rst](https://docs.kernel.org/filesystems/locking.html) — Locking rules for filesystem code
- [Documentation/block/](https://docs.kernel.org/block/) — Block layer, I/O schedulers, request queues
- [Documentation/admin-guide/mm/](https://docs.kernel.org/admin-guide/mm/) — `vm.dirty_ratio`, `vm.dirty_background_ratio`, and other tunables

### Textbooks

- Silberschatz et al., [*Operating System Concepts*](https://www.os-book.com/) — Ch. 13-14 (Storage and I/O Systems)
- Tanenbaum & Bos, [*Modern Operating Systems*](https://www.pearson.com/en-us/subject-catalog/p/modern-operating-systems/P200000003295) — Ch. 5 (Input/Output)
- Love, [*Linux Kernel Development*](https://www.oreilly.com/library/view/linux-kernel-development/9780768696974/) — Ch. 13 (The Virtual Filesystem), Ch. 15 (The Block I/O Layer)
- Kerrisk, [*The Linux Programming Interface*](https://man7.org/tlpi/) — Ch. 13 (File I/O Buffering), Ch. 49 (Memory Mappings)

### Papers

- Axboe, [*Efficient IO with io_uring*](https://kernel.dk/io_uring.pdf) — The design document for io_uring from its author
- Pai et al., [*Flash: An Efficient and Portable Web Server*](https://www.usenix.org/legacy/events/usenix99/full_papers/pai/pai.pdf) — USENIX 1999; the paper that exposed the limits of POSIX AIO for real workloads
