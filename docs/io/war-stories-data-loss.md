# War Stories: I/O Data Loss Incidents

> Real crashes, missing files, and silent corruption from Linux I/O history — what was lost, why, and what changed

These incidents are drawn from public LKML discussions, filesystem developer post-mortems, database team reports, and kernel commit histories. Each caused real data loss or stale data exposure on production systems.

---

## Incident 1: ext4 `data=writeback` — stale data exposure after a crash {#incident-1}

*Documented: ext4 since first release. Widely reported: 2008–2012. Documentation improved: v3.x era.*

### Before state

ext4 supports three journaling modes:

- `data=journal`: data and metadata written to journal before commit. Safest, slowest.
- `data=ordered` (default): data written to final location before metadata journal commit. Safe.
- `data=writeback`: metadata journaled; data writeback completely decoupled. Fastest, most dangerous.

In `data=ordered` mode, the kernel enforces: data blocks are flushed to disk *before* the journal transaction committing the inode update. This invariant ensures that after a crash, any committed inode points to data that is actually on disk.

### What happened

Performance guides and database documentation sometimes recommended `data=writeback` for write-heavy workloads on servers with battery-backed write caches. The reasoning: databases manage their own durability via `fsync()`, so the filesystem's ordered flush overhead is redundant overhead.

The scenario that exposed stale data:

1. Application truncates a file to zero and begins writing new content.
2. ext4 allocates new data blocks — possibly reusing blocks recently freed from another file. These blocks still contain the previous file's data on disk.
3. In `data=writeback` mode: the journal commits the inode update (pointing to the newly allocated blocks) *before* the new data is written to those blocks.
4. System crashes after the journal commit but before the new data write.
5. After journal recovery: the inode points to the newly allocated blocks. The blocks still contain the previous file's contents.

The result: opening the file returns data that belonged to a different, now-deleted file. This is a security issue (data from deleted files leaks) and a data integrity issue (the application's write is lost).

### Root cause

`data=ordered` mode exists precisely to prevent this: it keeps data writes ahead of metadata commits. `data=writeback` removes this invariant. The combination of block reuse (newly allocated blocks inheriting old content) and deferred data writeback creates the exposure window.

From `fs/ext4/`:
- `data=ordered`: `ext4_jbd2_inode_add_write()` registers inode data pages with the current journal transaction. JBD2 flushes them before transaction commit.
- `data=writeback`: this registration does not happen. Data writeback is independent of the journal.

### Resolution

Do not use `data=writeback` unless the application manages its own durability (databases that `fsync()` explicitly). For most workloads, `data=ordered` is the correct default.

```bash
# Check journaling mode
tune2fs -l /dev/sda1 | grep "Default mount options"
mount | grep ext4
# Look for: data=writeback (dangerous), data=ordered (safe, default)

# Remount with safe journaling mode
mount -o remount,data=ordered /dev/sda1
```

### What it taught us

**"Performance options that change crash semantics need prominent warnings."** `data=writeback` was presented as a performance knob; its crash semantics were a footnote. Any mount option that changes what "crash safe" means deserves prominent documentation that appears before the performance numbers.

**"Metadata consistency ≠ data integrity."** A journaled filesystem can guarantee structural consistency (no dangling pointers, no lost extents) without guaranteeing that file data is what the application wrote. These are orthogonal guarantees.

---

## Incident 2: `O_DIRECT` + buffered I/O coherency — stale reads from mixed-mode access {#incident-2}

*Documented in `open(2)` man page. Widely encountered: 2005–present. Race window narrowed but not closed.*

### Before state

Linux provides two paths to access the same file:
- **Buffered I/O**: data flows through the page cache. All readers see the same cached pages.
- **O_DIRECT**: reads and writes bypass the page cache, going directly between user buffers and storage.

The page cache is coherent for buffered I/O: all processes sharing the same cached pages see consistent data. The natural expectation is that this coherency extends across both paths — a buffered read should always see the most recently written data, regardless of whether that data was written via `O_DIRECT` or buffered I/O.

### What happened

When a process writes to a file with `O_DIRECT` and another process reads the same file region via buffered I/O, the buffered reader can see **stale data**:

1. Process A opens the file with `O_DIRECT` and writes 4KB to offset 0. The write goes directly to disk; the page cache is not updated.
2. If the page was previously cached (from an earlier buffered read), the page cache still holds the old version.
3. Process B reads offset 0 via `read()`. The page cache has a stale cached page. The kernel serves the old data.

The reverse also fails: a buffered write followed by an `O_DIRECT` read can read from disk rather than the in-memory dirty page, returning pre-write data.

The `O_DIRECT` write path calls `invalidate_inode_pages2_range()` to flush the affected region from the page cache *before* submitting the DMA write to the device. A concurrent buffered reader that starts after the invalidation but before the DMA completes will issue a fresh read from the device — which still holds the pre-write data — and populate the page cache with that stale content. When the DMA write then commits, the page cache is out of sync. Subsequent buffered reads serve the now-stale cached copy.

### Root cause

`O_DIRECT` was designed to bypass the page cache. "Bypassing the cache" means the cache is not updated on write — but it also means the cache can become inconsistent with disk. The invalidation-before-write approach closes most of the window, but cannot close it entirely without serializing all buffered reads against concurrent `O_DIRECT` writes.

From the kernel's perspective, this is documented behavior. The `open(2)` man page states:

> "If a file is opened in O_DIRECT mode while the same file has been opened without this flag, the behavior is undefined."

### Real-world impact

Backup tools that read database files via `rsync`, `cp`, or `tar` while the database writes those same files with `O_DIRECT` produce backups that may contain stale page cache reads. The backup is internally consistent but contains data that predates some of the database's writes.

PostgreSQL documentation explicitly warns against running read-only backups without `O_DIRECT` while the database uses `O_DIRECT` for data files.

### Resolution

Do not mix `O_DIRECT` and buffered I/O on the same file from different processes. Choose one mode for all accessors.

```bash
# Detect mixed-mode access
# Check if a process is using O_DIRECT: look for flag 0x4000 in fdinfo
grep flags /proc/<pid>/fdinfo/* | awk -F: '{
    flags = strtonum($2);
    if (and(flags, 0x4000)) print FILENAME ": O_DIRECT set";
}'
```

### What it taught us

**"Undefined behavior in man pages is a real warning."** "Undefined" means the kernel cannot close the race without breaking the performance properties of `O_DIRECT`. It is not a theoretical footnote.

**"Backup tools need to understand I/O modes."** `rsync` and `cp` use buffered I/O. Running them on files that are being actively modified with `O_DIRECT` produces backups with undefined consistency properties.

---

## Incident 3: `fsync()` after `rename()` — missing files after a crash {#incident-3}

*First widely documented: ~2009. Fixed in SQLite: 3.7.x. Fixed in PostgreSQL: multiple versions. Affects all local filesystems.*

### Before state

The standard pattern for safely replacing a file is:

```c
fd = open("file.tmp", O_WRONLY | O_CREAT | O_TRUNC, 0644);
write(fd, new_content, len);
fsync(fd);           /* new content is on storage */
close(fd);
rename("file.tmp", "file");  /* atomic replacement */
```

This pattern guarantees that readers see either the old `file` or the new `file` — never a partial write. It was used by SQLite, PostgreSQL (WAL segment management), text editors, and configuration management tools.

### What happened

After a crash, the replacement sometimes appeared to have never happened: `file.tmp` data was on disk, but the directory entry for `file` pointed to the old content — or `file` was missing entirely.

The missing step: `fsync()` on the **parent directory**.

`rename()` modifies the parent directory — it removes the `file.tmp` directory entry and adds a `file` directory entry. This directory modification is in the page cache (dirty) but not flushed to disk by `fsync(fd)`. `fsync(fd)` flushes the file's data and inode, but not the parent directory.

After a crash before the directory pages are flushed, journal recovery replays committed transactions only. If the journal transaction containing the directory update had not committed, the directory is in its pre-rename state. The file data is on disk (inode flushed by `fsync(fd)`), but no directory entry points to it — the file is an orphan.

### Why it was missed

POSIX guarantees that `rename()` is **atomic with respect to concurrent observers** — no process will ever see a partial rename. But POSIX does not require `rename()` to be **durable without an explicit sync**. Linux implements the POSIX guarantee without the additional durability guarantee, which is correct but non-obvious.

### Impact

SQLite reported that databases could lose committed transactions after a power failure in early versions. PostgreSQL reported that WAL segments could disappear after a crash, requiring WAL replay from an older checkpoint. Text editors that used write-to-temp-then-rename could lose the new file after a crash.

### Resolution

```c
/* Correct crash-safe replacement */
int fd = open("file.tmp", O_WRONLY | O_CREAT | O_TRUNC, 0644);
write(fd, new_content, len);
fdatasync(fd);
close(fd);
rename("file.tmp", "file");

int dir_fd = open(".", O_RDONLY);
fsync(dir_fd);    /* ← the missing step */
close(dir_fd);
```

SQLite added this in its unix VFS layer. PostgreSQL added `fsync_fname()` which syncs both file and parent directory.

```bash
# Verify an application syncs the directory after rename:
strace -e trace=fsync,fdatasync,rename,renameat -p <pid> 2>&1
# Should show: fdatasync(fd_for_tempfile) → rename → fsync(fd_for_directory)
# Missing the last fsync means directory entry may not survive a crash
```

### What it taught us

**"`rename()` atomicity is in-memory atomicity, not durability."** The syscall is atomic for concurrent observers; it is not durable until the parent directory is flushed.

**"High-profile software shipped with this bug."** SQLite and PostgreSQL — two of the most carefully written database systems — both had this issue. It was not obvious from reading the man pages. Every application that uses the write-to-temp-then-rename pattern needs to verify it is syncing the parent directory.

---

## Incident 4: Asynchronous writeback errors silently dropped before v4.13 {#incident-4}

*Kernel-wide issue. Partial fix: v4.13 (errseq_t). Broader fix: v5.8+.*

### Before state

Writeback is asynchronous: `write()` returns immediately, and the data is flushed to storage in the background by kworker threads. If a writeback fails (device returns an error, filesystem runs out of space), the application has already returned from `write()` successfully.

Before v4.13, the writeback error was stored in the inode but **not reliably delivered to applications**. An `fsync()` call after a writeback failure might return 0 (success) rather than `EIO`, depending on timing. Applications that called `fsync()` to verify data durability could incorrectly believe their data was safe.

### What happened

Applications using the following pattern assumed data was safely on storage:

```c
write(fd, data, len);  /* succeeds: data in page cache */
fsync(fd);             /* might return 0 even if writeback failed! */
/* Application believes data is durable. It is not. */
```

The writeback error was stored in `inode->i_mapping->flags` (`AS_EIO`, `AS_ENOSPC`), but the clearing semantics were poorly defined. A writeback error for page A might be cleared by a successful writeback of page B, or might not be visible to an `fsync()` that ran after the error occurred but before a new write.

This affected databases, log writers, and any application relying on `fsync()` to confirm durability.

### Root cause

The error flag was a global per-inode bit, not a per-opener or time-stamped value. Multiple applications opening the same file could miss errors. An error that occurred before an `fsync()` call might have already been cleared by a successful writeback of a different page.

### Resolution

In v4.13, Linus Torvalds introduced `errseq_t` ([commit 5660e13d2fd5](https://git.kernel.org/linus/5660e13d2fd5)), a sequence counter embedded in the writeback error state. Each `fsync()` call checks the sequence counter against the last-seen value:

- If the counter advanced since the last `fsync()` on this file descriptor, `EIO` is returned.
- The counter only advances on writeback errors, not on success.
- The error is returned exactly once per file descriptor per error event.

This ensures that an application calling `fsync()` after a writeback failure will see `EIO` — even if other successful writeback operations have occurred in between.

```c
/* After v4.13: fsync() reliably returns EIO after writeback failure */
write(fd, data, len);
if (fsync(fd) < 0) {
    if (errno == EIO) {
        /* data is NOT on storage — handle this */
    }
}
```

### What it taught us

**"Error delivery from async operations requires sequence tracking, not flags."** A boolean error flag that can be cleared by unrelated operations is not sufficient for reliable error delivery. The `errseq_t` design — a counter that monotonically increases on errors and is sampled per-opener — is the correct pattern for async error delivery.

**"Filesystems that silence errors create invisible data loss."** If `fsync()` returns 0 but the data is not on storage, any application that relies on `fsync()` for durability silently has a weaker guarantee than it believes. This class of silent failure is arguably worse than a returned error: the application has no way to know it needs to retry or abort.

---

## Related pages

- [War Stories: Performance Regressions](war-stories-regressions.md) — when I/O got slower
- [War Stories: CVEs](war-stories-cves.md) — security vulnerabilities in the I/O stack
- [fsync, fdatasync, and O_SYNC](fsync-fdatasync.md) — durability semantics
- [I/O Consistency and Ordering](io-consistency.md) — ordering guarantees
- [Buffered I/O vs Direct I/O](buffered-vs-direct.md) — when to use O_DIRECT
- [Debugging Data Corruption](debugging-data-corruption.md) — diagnosing corruption in production
