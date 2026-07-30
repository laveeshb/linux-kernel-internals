# I/O Consistency and Ordering

> What ordering guarantees does Linux provide for reads and writes, and how do you get stronger ones?

## The problem with "written to disk"

When a `write()` system call returns, the data is in the page cache. It may reach storage seconds later, or not at all before a power failure. "Written to disk" means something specific only if enforced — and the default path enforces nothing beyond eventual writeback.

Consistency and ordering in Linux I/O have four distinct levels, each providing stronger guarantees at higher cost:

```
Weakest                                                    Strongest
────────────────────────────────────────────────────────────────────
buffered    O_SYNC /    fsync /       barrier         power-fail safe
write()     fdatasync  fdatasync +    writes          with O_DIRECT +
            per-write  dir fsync                      fdatasync + dir
                                                      fsync
```

---

## Level 1: Buffered write — no ordering, no durability

The default. `write()` copies data into the page cache and returns. The kernel will flush it to storage at some future time, subject to dirty thresholds and writeback timeouts.

```c
int fd = open("file", O_WRONLY);
write(fd, data, len);
close(fd);
/* Data may reach storage in 0ms to 30s (dirty_expire_centisecs = 3000 = 30s default) */
/* A crash before writeback loses all writes */
```

**Visibility to other processes**: a concurrent reader using buffered I/O will see the updated data immediately (from the page cache). This is coherent within the buffered I/O subsystem — all buffered readers and writers share the same page cache.

**Ordering between writes**: buffered writes to the same process from the same thread are ordered — write B, submitted after write A, will be visible after write A to a buffered reader. But writeback to storage can reorder writes: write A may not reach storage before write B.

---

## Level 2: `O_SYNC` and `fdatasync` — per-write durability

`O_SYNC` makes every `write()` synchronous: the call does not return until the data *and* associated metadata are on storage. This is the strongest per-write guarantee.

`fdatasync(fd)` flushes data and the minimum metadata needed to retrieve the data (file size if it changed). It does not update inode atime, mtime, or ctime unless required for data retrieval.

`fsync(fd)` flushes data and all metadata (including timestamps).

```c
/* O_SYNC: every write is durable before returning */
int fd = open("file", O_WRONLY | O_SYNC);
write(fd, data, len);  /* returns only after data and metadata are on storage */

/* fdatasync: batch writes, then flush */
int fd = open("file", O_WRONLY);
for (int i = 0; i < n; i++) {
    write(fd, records[i], record_size);
}
fdatasync(fd);  /* flush all buffered writes + minimal metadata */

/* fsync: same as fdatasync but also flushes timestamps */
fsync(fd);
```

**Cost**: each `fdatasync()`/`fsync()` causes at least one storage write (the flush command to the device). On an NVMe device, this takes ~100µs. On a SATA SSD, ~1ms. On a spinning disk, ~5-10ms.

**What is NOT guaranteed by `fsync(fd)`**: the parent directory entry. If the file was newly created or renamed, the directory entry may not be on storage even after `fsync(fd)` returns. See [fsync, fdatasync, and O_SYNC](fsync-fdatasync.md) and [War Stories: Data Loss](war-stories-data-loss.md#incident-3).

---

## Level 3: Directory sync — ensuring new files survive crashes

After creating or renaming a file and calling `fsync(fd)`, the file's data and inode are on storage. But the directory entry pointing to the file may not be. A crash at this point can leave an orphaned inode (data on disk, no directory entry pointing to it) or a missing file.

```c
/* Crash-safe file creation */
int fd = open("newfile", O_WRONLY | O_CREAT | O_TRUNC, 0644);
write(fd, data, len);
fdatasync(fd);      /* data and inode on storage */
close(fd);

/* Still not safe: directory entry not yet on storage */
int dir_fd = open(".", O_RDONLY);
fsync(dir_fd);      /* directory entry on storage */
close(dir_fd);
/* Now safe: newfile will survive a crash */
```

**Crash-safe rename pattern** (atomic file replacement):

```c
/* Write to temp file */
int tmp = open("file.tmp", O_WRONLY | O_CREAT | O_TRUNC, 0644);
write(tmp, new_data, len);
fdatasync(tmp);
close(tmp);

/* Atomically replace */
rename("file.tmp", "file");

/* Sync the directory — the step everyone forgets */
int dir = open(".", O_RDONLY);
fsync(dir);
close(dir);
```

Without the `fsync(dir)`, the rename is only in memory. A crash before the directory pages are flushed produces a filesystem in the pre-rename state — as if the rename never happened.

---

## Level 4: Barrier writes — ordering without full sync

Some workloads need ordering between writes without requiring each write to be durable immediately. For example: a database needs to ensure that data pages are on storage before the corresponding log entry is written — but does not need each data page write to return synchronously.

**`sync_file_range(2)`** provides fine-grained control:

```c
/* Queue writes for a range without waiting */
sync_file_range(fd, offset, len, SYNC_FILE_RANGE_WRITE);

/* Wait for those specific writes to complete */
sync_file_range(fd, offset, len,
    SYNC_FILE_RANGE_WAIT_BEFORE | SYNC_FILE_RANGE_WRITE | SYNC_FILE_RANGE_WAIT_AFTER);
```

This is used by PostgreSQL: it calls `sync_file_range()` with `SYNC_FILE_RANGE_WRITE` to kick off background writeback of data pages, then later waits for those writes to complete before fsyncing the WAL. This overlaps data writeback with WAL writes, improving checkpoint throughput.

**`O_DSYNC`** provides ordered writes without full sync overhead:

```c
/* O_DSYNC: data reaches storage before write() returns,
   but metadata (atime, mtime) does not */
int fd = open("file", O_WRONLY | O_DSYNC);
```

`O_DSYNC` is equivalent to calling `fdatasync()` after every write but with potentially lower overhead because the kernel can optimize the flush path.

---

## Write ordering and the block layer

The kernel's block layer includes several mechanisms that affect write ordering:

**Write barriers** (now called "flush commands"): before Linux 2.6.37, write barriers were explicit block layer requests that ensured all preceding writes completed before the barrier, and all following writes started after. Since 2.6.37, this is handled automatically by the block layer's flush infrastructure.

When a filesystem submits a write that requires a barrier (e.g., a journal commit), it sets the `REQ_PREFLUSH` and/or `REQ_FUA` flags:

```
REQ_PREFLUSH: flush the device's write cache before this write
REQ_FUA: force unit access — write directly to persistent media, bypassing cache

Commit write sequence:
[data writes] → REQ_PREFLUSH → [journal commit write with REQ_FUA]
                     ↑                              ↑
              all data writes               this write is durable
              completed and                before returning
              flushed before this
```

**Write cache and FUA**: storage devices typically have a volatile write cache. A write that reaches the device's write cache is "durable" from the device's perspective — but a power failure before the cache is flushed loses the data. `REQ_FUA` bypasses the cache and writes directly to persistent media, at the cost of higher latency.

```bash
# Check if a device has a write cache
hdparm -I /dev/sda | grep 'Write cache'

# Enable/disable write cache
hdparm -W1 /dev/sda  # enable (default)
hdparm -W0 /dev/sda  # disable (every write goes to media — very slow)
```

---

## Ordered vs data journaling in ext4

ext4's journaling mode determines the ordering guarantees provided by the filesystem:

**`data=ordered`** (default): data blocks are written to their final location *before* the journal metadata commit. This ensures that after a crash and journal replay, the file data is either the new data or the old data — never uninitialized data from a reallocated block.

**`data=journal`**: all data writes go through the journal. Strongest guarantee, slowest performance. Each write is written twice (journal + final location).

**`data=writeback`**: metadata is journaled, but data writes are completely independent. Fastest, but a crash after the journal commit and before the data write can expose stale data from reused blocks. (See [War Stories: Data Loss](war-stories-data-loss.md#incident-1).)

```bash
# Check filesystem journaling mode
tune2fs -l /dev/sda1 | grep "Default mount options"
# or
mount | grep ext4
# Look for: data=ordered, data=journal, or data=writeback
```

---

## NFS and distributed consistency

NFS adds another dimension: the client's page cache may be out of sync with the server's state, and multiple clients may have conflicting cached versions.

**NFS consistency modes:**

- **`close-to-open`** (default for NFSv3): data is flushed to the server on `close()`, and validated against the server's version on `open()`. Between open and close, the client may have stale data.
- **`noac`** (no attribute caching): attribute cache is disabled. Every stat, read, and write goes to the server. Consistent but slow.
- **Delegations** (NFSv4): the server grants exclusive access to a client, allowing the client to cache aggressively while knowing it is the only writer.

```bash
# Mount NFS with strict consistency (noac disables attribute and data caching)
mount -o noac,sync nfsserver:/export /mnt

# Check current cache timeout settings
mount | grep nfs
# Look for: actimeo, acregmin, acregmax, acdirmin, acdirmax
```

---

## Summary: consistency guarantees by mechanism

| Mechanism | Data on storage | Metadata on storage | Directory entry | Ordering |
|-----------|----------------|---------------------|-----------------|----------|
| `write()` | No (async) | No | No | No |
| `write()` + `fsync(fd)` | Yes | Yes | No | After call |
| `write()` + `fdatasync(fd)` | Yes | Minimal | No | After call |
| `write()` + `O_SYNC` | Yes (per write) | Yes | No | Per write |
| `write()` + `O_DSYNC` | Yes (per write) | Minimal | No | Per write |
| `rename()` + `fsync(dir)` | Yes (if prior fsync) | Yes | Yes | After dir fsync |
| `sync_file_range(WRITE\|WAIT)` | Yes (range) | No | No | Yes (range) |
| `O_DIRECT` + `fdatasync` | Yes | Minimal | No | After call |

---

## Related pages

- [fsync, fdatasync, and O_SYNC](fsync-fdatasync.md) — durability semantics in depth
- [Writeback Internals](writeback-internals.md) — how dirty pages reach storage
- [Life of an fsync()](life-of-an-fsync.md) — the kernel path of an fsync call
- [War Stories: Data Loss](war-stories-data-loss.md) — real incidents from ordering failures
- [Writes Are Not Atomic](writes-not-atomic.md) — atomicity of individual write calls
- [Buffered I/O and the Page Cache](buffered-io.md) — how buffered writes work
