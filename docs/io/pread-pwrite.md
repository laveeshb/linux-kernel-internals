# pread / pwrite / preadv2 / pwritev2

> Positional I/O, scatter-gather, and per-call flags: the full API from pread64 to RWF_ATOMIC

## The problem with read() / write() for concurrent I/O

`read()` and `write()` use `file->f_pos` — the file position stored in the open file description. Because an open file description is shared between all file descriptors that refer to it (after `dup`, `dup2`, `fork`, etc.), concurrent access creates a race:

```
Thread A                        Thread B
─────────────────────────────   ────────────────────────────────
lseek(fd, 0, SEEK_SET)         lseek(fd, 4096, SEEK_SET)
                                    ← context switch here
read(fd, buf, 4096)            ← reads from offset 4096, not 0
```

Even when two threads each hold their own `fd` obtained from `open()` independently, `lseek()` + `read()` is still not atomic: another `read()` on the same thread can interleave between the seek and the read.

The kernel serializes `f_pos` updates with `file->f_pos_lock` (a mutex), but this serialization is per-operation — it does not make seek+read atomic as a unit.

```
Thread A: fdget_pos() → acquires f_pos_lock
          f_pos = 4096
          fdput_pos() → releases f_pos_lock
Thread A: fdget_pos() → acquires f_pos_lock
          read from f_pos (4096)
          f_pos += bytes_read
          fdput_pos() → releases f_pos_lock
```

Between those two lock acquisitions, Thread B can change `f_pos`. This is a TOCTOU problem at the application level.

`pread()` and `pwrite()` solve this: they accept an explicit `offset` argument and never read or write `f_pos`. There is no race because the offset lives on the caller's stack.

---

## pread() / pwrite()

```c
#include <unistd.h>

/* Read count bytes from fd at offset into buf; f_pos is unchanged. */
ssize_t pread(int fd, void *buf, size_t count, off_t offset);

/* Write count bytes from buf to fd at offset; f_pos is unchanged. */
ssize_t pwrite(int fd, const void *buf, size_t count, off_t offset);
```

### Syscall implementation

The kernel entry points are `pread64` and `pwrite64` (the `64` suffix indicates that the offset is a 64-bit `loff_t`, matching `off64_t` from glibc):

```c
/* fs/read_write.c */
SYSCALL_DEFINE4(pread64, unsigned int, fd, char __user *, buf,
                size_t, count, loff_t, pos)
{
    struct fd f;
    ssize_t ret = -EBADF;

    f = fdget(fd);          /* note: fdget, NOT fdget_pos */
    if (f.file) {
        ret = -ESPIPE;
        if (f.file->f_mode & FMODE_PREAD)   /* file must be seekable */
            ret = vfs_read(f.file, buf, count, &pos);
            /*
             * pos is a local variable on the kernel stack.
             * vfs_read() may advance it, but the result is
             * never written back to f.file->f_pos.
             */
        fdput(f);
    }
    return ret;
}
```

The `FMODE_PREAD` / `FMODE_PWRITE` mode flags are set for regular files and block devices. Pipes, sockets, and other non-seekable file types do not set these flags and return `ESPIPE`.

### fdget vs fdget_pos — the key difference

`read()` uses `fdget_pos()`:

```c
/* fs/read_write.c */
ssize_t ksys_read(unsigned int fd, char __user *buf, size_t count)
{
    struct fd f = fdget_pos(fd);    /* acquires f_pos_lock */
    ssize_t ret = -EBADF;

    if (f.file) {
        loff_t pos, *ppos = file_ppos(f.file);
        if (ppos) {
            pos = *ppos;
            ppos = &pos;
        }
        ret = vfs_read(f.file, buf, count, ppos);
        if (!IS_ERR_VALUE(ret)) {
            if (ppos)
                f.file->f_pos = pos;    /* write back updated position */
        }
        fdput_pos(f);                   /* releases f_pos_lock */
    }
    return ret;
}
```

`pread()` uses `fdget()` (no lock, no position update):

| | `read()` / `write()` | `pread()` / `pwrite()` |
|---|---|---|
| Lock acquired | `f_pos_lock` (mutex) | none |
| Position source | `file->f_pos` | local stack variable |
| Position updated after | yes | no |
| Safe for concurrent threads | only sequentially | yes |

Because `pread()`/`pwrite()` do not touch `f_pos` and do not take `f_pos_lock`, multiple threads can issue concurrent positional reads on the same open file description without any serialization overhead.

### Error cases

```c
/* ESPIPE: fd is a pipe or socket */
pread(pipefd[0], buf, 4096, 0);     /* → -1, errno = ESPIPE */

/* EINVAL: offset is negative */
pread(fd, buf, 4096, -1);           /* → -1, errno = EINVAL */

/* Works fine: offset beyond EOF returns 0 */
pread(fd, buf, 4096, 1ULL << 40);   /* → 0 (EOF) if file is smaller */
```

---

## preadv() / pwritev()

`readv()` and `writev()` have had scatter-gather I/O since POSIX.1-2001, but there was no way to specify an explicit offset. Linux 2.6.30 added `preadv()` and `pwritev()` to fill this gap:

```c
#include <sys/uio.h>

ssize_t preadv(int fd, const struct iovec *iov, int iovcnt, off_t offset);
ssize_t pwritev(int fd, const struct iovec *iov, int iovcnt, off_t offset);
```

These combine the offset semantics of `pread()`/`pwrite()` with the scatter-gather capability of `readv()`/`writev()`. Like the non-vectored variants, they do not touch `f_pos` and require `FMODE_PREAD`/`FMODE_PWRITE`.

### Kernel path

```c
/* fs/read_write.c */
SYSCALL_DEFINE5(preadv, unsigned long, fd,
                const struct iovec __user *, vec, unsigned long, vlen,
                unsigned long, pos_l, unsigned long, pos_h)
{
    loff_t pos = pos_from_hilo(pos_h, pos_l);
    return do_preadv(fd, vec, vlen, pos, 0);
}

static ssize_t do_preadv(unsigned long fd, const struct iovec __user *vec,
                          unsigned long vlen, loff_t pos, rwf_t flags)
{
    struct fd f;
    ssize_t ret = -EBADF;

    f = fdget(fd);
    if (f.file) {
        ret = -ESPIPE;
        if (f.file->f_mode & FMODE_PREAD) {
            struct iovec iovstack[UIO_FASTIOV];
            struct iovec *iov = iovstack;
            struct iov_iter iter;

            ret = import_iovec(READ, vec, vlen,
                               ARRAY_SIZE(iovstack), &iov, &iter);
            if (ret >= 0) {
                ret = vfs_iter_read(f.file, &iter, &pos, flags);
                kfree(iov);
            }
        }
        fdput(f);
    }
    return ret;
}
```

The split of `pos` into `pos_l` and `pos_h` is a 32-bit ABI artifact: on 32-bit architectures, a 64-bit `loff_t` is passed as two 32-bit registers. On 64-bit architectures the ABI provides a single register.

### Why databases use preadv

A typical database page read looks like:

```c
/*
 * Read a B-tree page from a fixed offset into separate header and
 * data buffers, without touching f_pos and without a staging allocation.
 */
struct page_header hdr;
uint8_t data[PAGE_SIZE - sizeof(hdr)];

struct iovec iov[2] = {
    { .iov_base = &hdr,  .iov_len = sizeof(hdr)  },
    { .iov_base = data,  .iov_len = sizeof(data)  },
};

ssize_t n = preadv(dbfile, iov, 2, page_no * PAGE_SIZE);
```

Two benefits:
1. **No memcpy**: header and data land directly in separate structures — no need to read into a flat buffer and then split it.
2. **Thread-safe**: multiple threads can call `preadv()` on the same `fd` at different offsets simultaneously without any user-space locking.

---

## preadv2() / pwritev2(): per-call flags

Linux 4.6 extended `preadv()`/`pwritev()` with a `flags` argument:

```c
#include <sys/uio.h>

ssize_t preadv2(int fd, const struct iovec *iov, int iovcnt,
                off_t offset, int flags);
ssize_t pwritev2(int fd, const struct iovec *iov, int iovcnt,
                 off_t offset, int flags);
```

`flags` is of type `rwf_t` (defined as `__kernel_rwf_t`, an `int`). It allows per-call control of I/O behaviour that was previously only settable at file-open time via `O_` flags or required a separate fcntl call.

### RWF_* flags

| Flag | Value | Kernel version | Description |
|------|-------|----------------|-------------|
| `RWF_HIPRI` | `0x01` | 4.6 | High-priority I/O; poll for completion (NVMe polled queues) |
| `RWF_DSYNC` | `0x02` | 4.7 | Data-sync semantics for this write (like `O_DSYNC` per call) |
| `RWF_SYNC` | `0x04` | 4.7 | Full sync for this write (like `O_SYNC` per call) |
| `RWF_NOWAIT` | `0x08` | 4.14 | Return `EAGAIN` immediately if I/O would block |
| `RWF_APPEND` | `0x10` | 4.16 | Atomic append to end of file regardless of `offset` |
| `RWF_NOAPPEND` | `0x20` | 6.9 | Override `O_APPEND` for this call; write at given offset |
| `RWF_ATOMIC` | `0x40` | 6.11 | Hardware-guaranteed atomic write |

Flags are defined in `include/uapi/linux/fs.h`.

### How flags reach the filesystem: kiocb_set_rw_flags

Every I/O operation in the kernel is represented by a `struct kiocb` (kernel I/O control block). The `RWF_*` flags are translated to `IOCB_*` flags and stored in `kiocb.ki_flags`:

```c
/* include/linux/fs.h */
static inline int kiocb_set_rw_flags(struct kiocb *ki, rwf_t flags,
                                      int rw_type)
{
    int kiocb_flags = 0;

    /* check for unknown flags */
    if (unlikely(flags & ~RWF_SUPPORTED))
        return -EOPNOTSUPP;

    if (flags & RWF_NOWAIT) {
        if (!(ki->ki_filp->f_mode & FMODE_NOWAIT))
            return -EOPNOTSUPP;
        kiocb_flags |= IOCB_NOIO;          /* don't submit I/O, just check */
        kiocb_flags |= IOCB_NOWAIT;
    }
    if (flags & RWF_HIPRI)
        kiocb_flags |= IOCB_HIPRI;
    if (flags & RWF_DSYNC)
        kiocb_flags |= IOCB_DSYNC;
    if (flags & RWF_SYNC)
        kiocb_flags |= (IOCB_DSYNC | IOCB_SYNC);
    if (flags & RWF_APPEND)
        kiocb_flags |= IOCB_APPEND;
    if (flags & RWF_NOAPPEND)
        kiocb_flags |= IOCB_NOAPPEND;
    if (flags & RWF_ATOMIC)
        kiocb_flags |= IOCB_ATOMIC;
    if (iocb_is_dsync(ki))
        kiocb_flags |= IOCB_DSYNC;

    ki->ki_flags |= kiocb_flags;
    return 0;
}
```

Once `IOCB_*` flags are set on the `kiocb`, every layer that handles the I/O — the VFS, the filesystem (`ext4`, `xfs`), and the block layer — checks these flags to adjust behaviour. Filesystems check `iocb->ki_flags & IOCB_NOWAIT` before taking a lock that might sleep; the block layer checks `IOCB_HIPRI` to route to a polled NVMe queue.

### offset = -1: use current f_pos

When `offset` is `-1` (cast to `off_t`), `preadv2()` / `pwritev2()` behave like `readv()` / `writev()`: the current `f_pos` is used and updated afterward. This makes it possible to use `RWF_*` flags without having an explicit offset:

```c
/* Use RWF_NOWAIT with the current file position */
ssize_t n = preadv2(fd, iov, 1, (off_t)-1, RWF_NOWAIT);
```

When `offset == -1`, the syscall falls back to `fdget_pos()` and takes `f_pos_lock` — it behaves exactly like `readv()` plus flags.

---

## RWF_NOWAIT in detail

`RWF_NOWAIT` is the most commonly used per-call flag. It asks the kernel: "complete this I/O only if you can do so without blocking. Otherwise return `EAGAIN`."

```c
/* Attempt a non-blocking read from the page cache */
ssize_t n = preadv2(fd, iov, 1, offset, RWF_NOWAIT);
if (n == -1 && errno == EAGAIN) {
    /* I/O would have blocked — submit asynchronously */
    submit_async_io(fd, iov, offset);
    return;
}
if (n < 0) {
    perror("preadv2");
    return;
}
/* Data was in the page cache — returned without I/O */
process_data(iov[0].iov_base, n);
```

### When preadv2 with RWF_NOWAIT returns EAGAIN

The read returns `EAGAIN` without doing any I/O in these cases:

**Page cache miss**: The requested pages are not in the page cache and fetching them would require submitting block I/O. `generic_file_read_iter` checks `IOCB_NOWAIT` in `filemap_get_pages` and returns `-EAGAIN` rather than calling `read_folio` to submit a bio.

**Inode lock contended**: For buffered reads, `generic_file_read_iter` may need the `inode->i_rwsem` in read mode. If the lock is held by a writer and `IOCB_NOWAIT` is set, the kernel returns `-EAGAIN` rather than sleeping on the lock.

**Filesystem journal congested**: Filesystems like ext4 may need journal resources even for reads in some paths. If `IOCB_NOWAIT` is set and the required resource is unavailable, `-EAGAIN` is returned.

**Direct I/O extent mapping**: For `O_DIRECT` reads, ext4 and XFS need to look up the extent map. If the extent does not exist (hole) and `IOCB_NOWAIT` is set, XFS returns `-EAGAIN` for allocating extents because that requires journal transactions.

**Truncate or writeback lock**: Some filesystems hold `i_rwsem` exclusively during truncate. A concurrent `RWF_NOWAIT` read that cannot get a shared lock returns `-EAGAIN`.

Note: buffered reads rarely succeed with `RWF_NOWAIT` unless the pages are already in cache. For a workload that frequently gets `EAGAIN`, `io_uring` with `IORING_OP_READ` is more efficient since it submits true async I/O rather than polling.

### The FMODE_NOWAIT gate

Not all file types support `RWF_NOWAIT`. The kernel checks `FMODE_NOWAIT` on the file before honouring the flag:

```c
if (flags & RWF_NOWAIT) {
    if (!(ki->ki_filp->f_mode & FMODE_NOWAIT))
        return -EOPNOTSUPP;
    ...
}
```

`FMODE_NOWAIT` is set for regular files opened on filesystems that support non-blocking I/O (ext4, XFS, btrfs) and for block devices. It is not set for sockets, pipes, or filesystems that have not opted in.

---

## RWF_DSYNC and RWF_SYNC

`O_DSYNC` and `O_SYNC` are per-fd flags set at open time. They force data (and optionally metadata) to be written to stable storage before each write returns. The per-call equivalents avoid the overhead of opening the file with these flags when only some writes need durability:

```c
/*
 * Write a transaction log entry: must be durable before we return.
 * Normal data writes don't need this overhead.
 */
ssize_t n = pwritev2(logfd, iov, 1, log_offset, RWF_DSYNC);
if (n < 0) {
    perror("pwritev2 RWF_DSYNC");
}
/* Data is now on stable storage — safe to acknowledge the transaction */
```

`RWF_DSYNC` maps to `IOCB_DSYNC` and forces `vfs_fsync_range()` after the write completes, flushing data pages and the file's inode (but not the directory entry). `RWF_SYNC` maps to `IOCB_DSYNC | IOCB_SYNC` and also forces metadata (the `O_SYNC` equivalent).

The implementation in `do_iter_write`:

```c
/* fs/read_write.c */
static ssize_t do_iter_write(struct file *file, struct iov_iter *iter,
                              loff_t *pos, rwf_t flags)
{
    size_t tot_len;
    ssize_t ret = 0;

    /* ... permission checks ... */

    ret = __generic_file_write_iter(file_iocb, iter);  /* the actual write */

    if (ret > 0 && iocb_is_dsync(file_iocb)) {
        /* RWF_DSYNC or RWF_SYNC: flush data to stable storage */
        ret = generic_write_sync(file_iocb, ret);
    }

    return ret;
}
```

---

## RWF_APPEND

`O_APPEND` makes all writes to an fd atomic appends: the file position is moved to EOF under the inode lock before each write, preventing two concurrent writers from overwriting each other. But `O_APPEND` is a property of the open file description — you cannot toggle it per-call without `fcntl(F_SETFL)`.

`RWF_APPEND` provides the same atomic-append guarantee on a per-call basis:

```c
/*
 * Append a log record atomically.
 * The fd was not opened with O_APPEND; we use RWF_APPEND per call
 * so we can also do random reads/writes on the same fd.
 */
ssize_t n = pwritev2(fd, iov, 1, /* offset ignored */ 0, RWF_APPEND);
```

The `offset` argument is ignored when `RWF_APPEND` is set. The write position is determined by the filesystem under the inode lock, atomically with the write itself.

Implementation: `IOCB_APPEND` causes the VFS and filesystem to:
1. Lock the inode exclusively.
2. Read `i_size` to get the current EOF.
3. Write data starting at EOF.
4. Update `i_size` atomically.
5. Unlock.

This is the same code path as `O_APPEND`, just triggered by a per-call flag rather than a file mode.

### RWF_NOAPPEND (Linux 6.9)

The converse: if a file was opened with `O_APPEND`, `RWF_NOAPPEND` overrides it for a single call and writes at the given explicit `offset` instead:

```c
/* fd opened with O_APPEND, but write this particular record at a fixed offset */
pwritev2(fd, iov, 1, fixed_offset, RWF_NOAPPEND);
```

---

## RWF_HIPRI: high-priority polled I/O

NVMe drives support **polled I/O queues**: instead of waiting for a hardware interrupt when I/O completes, the CPU spins on the NVMe completion queue. This reduces latency at the cost of CPU time. `RWF_HIPRI` requests polled completion for this I/O:

```c
/* O_DIRECT is required for polled I/O */
int fd = open("file", O_RDWR | O_DIRECT);

ssize_t n = preadv2(fd, iov, 1, offset, RWF_HIPRI);
```

`RWF_HIPRI` sets `IOCB_HIPRI` on the kiocb. The block layer checks this flag and, if the block device supports polled queues (`BLK_MQ_F_POLL`), routes the bio to a polled queue and calls `blk_poll()` instead of waiting on a completion interrupt.

Effective only with `O_DIRECT` — buffered I/O completion happens asynchronously via writeback threads and cannot be polled by the application.

---

## RWF_ATOMIC (Linux 6.11)

Traditional disk writes have no atomicity guarantee at the hardware level: a power failure mid-write can leave a sector partially written. Databases work around this with journaling or copy-on-write. Modern storage devices (NVMe with the Atomic Write Unit feature set) can guarantee that a write of up to `N` bytes is either fully committed or not committed at all.

Linux 6.11 exposed this as `RWF_ATOMIC`:

```c
#include <sys/stat.h>   /* statx */
#include <linux/stat.h> /* STATX_WRITE_ATOMIC */

/* Step 1: check device capabilities */
struct statx stx;
if (statx(fd, "", AT_EMPTY_PATH, STATX_WRITE_ATOMIC, &stx) < 0)
    err(1, "statx");

printf("atomic write unit min: %u bytes\n", stx.stx_atomic_write_unit_min);
printf("atomic write unit max: %u bytes\n", stx.stx_atomic_write_unit_max);
printf("max atomic segments:   %u\n",       stx.stx_atomic_write_segments_max);

/* Step 2: issue an atomic write */
/* Buffer must be aligned to stx_atomic_write_unit_min */
/* Length must not exceed stx_atomic_write_unit_max */
ssize_t n = pwritev2(fd, iov, 1, offset, RWF_ATOMIC);
if (n < 0 && errno == EINVAL) {
    /* Alignment or size constraint violated, or FS doesn't support it */
}
```

### Requirements for RWF_ATOMIC

- The write size must be a power of two between `stx_atomic_write_unit_min` and `stx_atomic_write_unit_max`.
- The buffer address and file offset must be aligned to `stx_atomic_write_unit_min`.
- The write must not span a `stx_atomic_write_unit_max`-aligned boundary.
- The filesystem must support it. XFS supports `RWF_ATOMIC` on `O_DIRECT` writes as of 6.11. ext4 support is in progress.
- The block device must advertise the Atomic Write Unit via the NVMe or SCSI interface.

### Why this matters for databases

Without `RWF_ATOMIC`:
```
journaling overhead:
  write journal record → flush → update actual page → flush
  2× I/O amplification, 2× flush latency
```

With `RWF_ATOMIC` on supported hardware:
```
  write page directly at target location → hardware guarantees atomicity
  1× I/O, 0 journal overhead
```

PostgreSQL and MySQL are expected to adopt `RWF_ATOMIC` for 8 KB–16 KB page writes once the kernel and filesystem support stabilises.

---

## f_pos locking internals

For completeness: here is how `f_pos_lock` works in `read()` / `write()` and why `pread()` can skip it.

### The lock itself

`file->f_pos_lock` is a `mutex` embedded in `struct file`:

```c
/* include/linux/fs.h */
struct file {
    /* ... */
    spinlock_t          f_lock;
    fmode_t             f_mode;
    atomic_long_t       f_count;
    struct mutex        f_pos_lock;   /* protects f_pos for read/write */
    loff_t              f_pos;
    /* ... */
};
```

### file_ppos: stream vs seekable

Not all file types have a meaningful position. `file_ppos()` returns `NULL` for stream files (pipes, sockets) so that the lock path is skipped entirely:

```c
/* fs/read_write.c */
static inline loff_t *file_ppos(struct file *file)
{
    return file->f_mode & FMODE_STREAM ? NULL : &file->f_pos;
}
```

### fdget_pos / fdput_pos

```c
/* fs/read_write.c */
static struct fd fdget_pos(int fd)
{
    return __to_fd(__fdget_pos(fd));
}

/*
 * __fdget_pos: if the file has a position AND multiple threads share
 * this file description (f_count > 1), acquire f_pos_lock so that
 * concurrent read/write calls serialize their f_pos updates.
 */

static inline void fdput_pos(struct fd f)
{
    if (f.flags & FDPUT_POS_UNLOCK)
        mutex_unlock(&f.file->f_pos_lock);
    fdput(f);
}
```

The lock is only taken when `f_count > 1` (multiple fds referring to the same open file description). A file opened by a single-threaded process and not shared with `dup`/`fork` never contends on `f_pos_lock`.

### Summary: when does f_pos_lock fire?

| Scenario | f_pos_lock taken? |
|---|---|
| Single-threaded, no dup | No (`f_count == 1`) |
| After `dup(fd)` | Yes |
| After `fork()` | Yes (parent and child share the description) |
| `read()` on pipe | No (`FMODE_STREAM` → `file_ppos` returns NULL) |
| `pread()` on any file | Never |

---

## io_uring equivalents

`io_uring` (Linux 5.1+) exposes positional I/O as first-class operations, mapping directly onto the `preadv2`/`pwritev2` semantics:

| io_uring opcode | Equivalent syscall | Notes |
|---|---|---|
| `IORING_OP_READ` | `pread()` | Single buffer, explicit offset |
| `IORING_OP_WRITE` | `pwrite()` | Single buffer, explicit offset |
| `IORING_OP_READV` | `preadv()` | Vectored, explicit offset |
| `IORING_OP_WRITEV` | `pwritev()` | Vectored, explicit offset |
| `IORING_OP_READ_FIXED` | `pread()` | Pre-registered buffers (no copy from user) |
| `IORING_OP_WRITE_FIXED` | `pwrite()` | Pre-registered buffers (no copy from user) |

`RWF_*` flags are passed via `sqe->rw_flags`:

```c
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);

io_uring_prep_readv(sqe, fd, iov, 1, offset);
sqe->rw_flags = RWF_NOWAIT;   /* same RWF_* flags as preadv2 */

io_uring_submit(&ring);
```

Inside the kernel, `io_uring` creates a `kiocb` and calls `kiocb_set_rw_flags()` with the `sqe->rw_flags` value — the same function called by `preadv2`. The `IOCB_*` flags propagate through the filesystem in exactly the same way.

The main advantage of `io_uring` over `preadv2` is not the per-call flags (those are identical) but **submission batching**: many I/O operations are submitted in a single `io_uring_enter()` syscall, reducing syscall overhead for high-IOPS workloads.

---

## Performance comparison

| Syscall | `f_pos_lock`? | Vectored? | Per-call flags? | Best use case |
|---------|:---:|:---:|:---:|---|
| `read` / `write` | yes | no | no | Simple sequential access |
| `pread` / `pwrite` | no | no | no | Random access, concurrent threads |
| `readv` / `writev` | yes | yes | no | Scatter-gather sequential |
| `preadv` / `pwritev` | no | yes | no | Scatter-gather random access |
| `preadv2` / `pwritev2` | no | yes | yes | Full control per call |
| `io_uring` | no | yes | yes | High-concurrency, batch submission |

For a database using multiple threads to issue random reads:
- `read()` + `lseek()`: requires external mutex around each seek+read pair.
- `pread()`: safe without any mutex; each thread passes its own offset.
- `preadv()`: safe and avoids an extra `memcpy` when the page header and body go to different structures.
- `preadv2(..., RWF_NOWAIT)`: can check the page cache without blocking; fall back to `io_uring` on `EAGAIN`.
- `io_uring` with `IORING_OP_READ_FIXED`: lowest overhead for sustained random I/O.

---

## Key source files

| File | Contents |
|------|----------|
| `fs/read_write.c` | `pread64`, `pwrite64`, `do_preadv`, `do_pwritev`, `ksys_read`, `fdget_pos`, `fdput_pos`, `file_ppos` |
| `include/linux/fs.h` | `struct file`, `f_pos_lock`, `FMODE_PREAD`, `FMODE_PWRITE`, `FMODE_NOWAIT`, `kiocb_set_rw_flags`, `IOCB_*` flags |
| `include/uapi/linux/fs.h` | `RWF_HIPRI`, `RWF_DSYNC`, `RWF_SYNC`, `RWF_NOWAIT`, `RWF_APPEND`, `RWF_NOAPPEND`, `RWF_ATOMIC`, `rwf_t` |
| `mm/filemap.c` | `generic_file_read_iter`, `filemap_get_pages` — where `IOCB_NOWAIT` is checked for buffered reads |
| `fs/inode.c` | `inode_init_always` — where `i_rwsem` is initialised (taken in `RWF_NOWAIT` paths) |
| `io_uring/rw.c` | io_uring read/write handlers; calls `kiocb_set_rw_flags` with `sqe->rw_flags` |
| `block/blk-mq.c` | `blk_poll` — the polled completion path for `IOCB_HIPRI` |
| `fs/xfs/xfs_file.c` | XFS `read_iter` / `write_iter`; `RWF_ATOMIC` and `IOCB_NOWAIT` handling |

---

## Further reading

- [Vectored I/O (readv/writev)](vectored-io.md) — `struct iovec`, `iov_iter`, scatter-gather fundamentals
- [kiocb: The Kernel I/O Control Block](kiocb.md) — `IOCB_*` flags, `ki_flags`, async vs sync kiocb
- [Direct I/O](direct-io.md) — `O_DIRECT` alignment requirements; `RWF_HIPRI` requires `O_DIRECT`
- [Buffered I/O and the Page Cache](buffered-io.md) — what `RWF_NOWAIT` tests against; `filemap_get_pages`
- [Async I/O Evolution](async-io.md) — io_uring `IORING_OP_READ` / `IORING_OP_WRITE` and `sqe->rw_flags`
- [fsync / fdatasync](fsync-fdatasync.md) — what `RWF_DSYNC` and `RWF_SYNC` trigger under the hood
