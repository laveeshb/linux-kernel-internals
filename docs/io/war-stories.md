# War Stories: I/O Bugs, Regressions, and Data Loss Incidents

> Real incidents from Linux I/O subsystem history — what broke, why, and what the kernel learned

The Linux I/O stack is one of the most complex paths in the kernel, spanning VFS, the page cache, filesystem journaling, block layer, and device drivers. Changes at any layer can produce subtle interactions that only manifest under specific workloads, crash scenarios, or combinations of flags that seemed safe in isolation.

This page documents five well-known I/O incidents drawn from public kernel commit logs, LWN articles, LKML discussions, and documented reports from database and application teams. These are not hypothetical risks. Each caused real data loss, silent corruption, or production outages before the root cause was understood.

---

## Case 1: ext4 `data=writeback` and stale data exposure after a crash

### Before state

ext4 inherited from ext3 three journaling modes that trade durability for performance:

- `data=journal`: all data and metadata are written to the journal before the commit. Slowest, but strongest crash guarantees.
- `data=ordered` (the default): metadata is journaled, but data blocks are written to their final location *before* the metadata commit. This ensures that after a crash, any metadata pointing to a newly allocated block also points to data that has been written.
- `data=writeback`: metadata is journaled, but data writes are completely decoupled from the journal commit. Data may be written before or after the associated metadata journal commit — or not at all before a crash.

In `data=ordered` mode, the kernel enforces an ordering: data blocks go to disk, *then* the journal transaction containing the inode update commits. This is why the default mode is safe: if the system crashes after the journal commit but before the data write, ext4's recovery will replay the journal and end up with an inode that points to unwritten data — but this case cannot occur because the data write happens first.

`data=writeback` was offered as a performance option. For workloads that did their own internal durability management (databases, certain log-structured applications), the overhead of the ordered flush was unnecessary. The assumption was that callers using `data=writeback` understood the trade-off.

### The change

The trigger was not a single kernel change but a configuration choice made by system administrators and distributions seeking better write throughput. The mount option `data=writeback` was sometimes recommended in performance guides, particularly for ext4 on servers with battery-backed write caches, where the assumption was that the hardware ensured ordering.

The combination that caused data exposure: truncating a file (or overwriting it by truncating and rewriting) followed by a crash before the new data was flushed, but after the journal metadata commit.

### Observed regression

After a crash and journal recovery, users found that files contained **stale data** — data that had previously belonged to a different file, or to an earlier version of the same file, rather than the newly written data or zeros.

The scenario:

1. Application truncates a file to zero length and begins writing new content.
2. ext4 allocates new data blocks. These blocks may be reused from a recently freed file and still contain that file's old data on disk.
3. In `data=ordered` mode, the new data would be written to disk before the inode's metadata (with the new block pointers) is committed to the journal. A crash before the data write means the journal never commits the new block pointers — the file is safely empty or contains partial data, never stale foreign data.
4. In `data=writeback` mode, the journal can commit the metadata (the inode update with the new block pointers) without waiting for the data write. If the system crashes after the journal commit but before the data blocks are written, recovery replays the journal and produces an inode pointing to the newly allocated (but unwritten) blocks — which still contain whatever was on disk before.

The result was that opening a recovered file could expose data from a previously deleted file — a security and data integrity problem. This behavior was documented in the ext4 documentation and in LWN's coverage of ext4 journaling modes.

### Why it happened

The root cause is the decoupling of metadata journaling from data writeback in `data=writeback` mode. ext4's journal guarantees metadata consistency: after recovery, the filesystem structure is coherent. But metadata consistency does not imply data integrity — it only means the pointers are valid, not that the pointed-to data is what the application wrote.

The relevant code path in `fs/ext4/`:

- `ext4_writepage()` and `ext4_write_end()` handle data writeback.
- In `data=ordered` mode, `ext4_jbd2_inode_add_write()` registers the inode's data pages with the current journal transaction. JBD2 flushes these data pages before allowing the transaction to commit.
- In `data=writeback` mode, this registration does not happen. The journal transaction commits independently of data writeback.

The unwritten data issue is specific to block reuse: a newly allocated block inherits whatever content the previous occupant left on disk. In `data=ordered` mode this is harmless because the new data is written before the block pointer is committed. In `data=writeback` mode the block pointer can be committed while the block still holds stale content.

The ext4 documentation is explicit about this: "`data=writeback` mode does not maintain data ordering and is known to lead to stale data exposure after a crash." But this warning was not always read before enabling the option.

### Resolution

The resolution for users was to not use `data=writeback` unless the workload was specifically designed for it (i.e., the application maintained its own write ordering and durability, as a database does with `fsync`). The default `data=ordered` mode does not have this vulnerability.

For workloads that needed the performance of `data=writeback` without the stale data risk, the correct approach was to use `O_DIRECT` for the writes that needed to bypass the page cache entirely, or to call `fsync()` before the metadata update could be committed without the corresponding data.

Modern kernels and filesystem documentation make the warning prominent:

```bash
# Check current journaling mode
tune2fs -l /dev/sdX | grep "Default mount options"

# Mount with explicit ordered mode (same as default)
mount -o data=ordered /dev/sdX /mnt

# data=writeback requires that the application handles its own durability
mount -o data=writeback /dev/sdX /mnt
# WARNING: stale data exposure after crash without application-level fsync
```

Some distributions removed `data=writeback` from their tuning guides after the exposure pattern became widely understood. The ext4 development team also documented the interaction clearly in `Documentation/filesystems/ext4/` in the kernel source tree.

### What it taught us

**"Metadata consistency" is not "data integrity."** A journaled filesystem can guarantee that the filesystem structure is coherent after recovery without guaranteeing that the data in files is what the application wrote. These are different properties, and conflating them leads to dangerous configurations.

**Performance options that change crash semantics need clear warnings.** `data=writeback` was presented as a performance knob. Its crash behavior was an afterthought. The real lesson is that any option that changes what "crash safe" means deserves prominent documentation, not a footnote.

**Block reuse amplifies journaling mode differences.** The stale data exposure only occurs because newly allocated blocks may contain old data. On freshly provisioned storage this is less likely; on a long-running filesystem with many files created and deleted, it is common. This made the bug intermittent and hard to reproduce in short tests.

!!! warning "Pattern to watch for"
    Filesystems mounted with `data=writeback` that do not use `O_DIRECT` or per-write `fsync()` are vulnerable to stale data exposure after a crash. Check mount options on all filesystem mounts:

    ```bash
    # Check mount options for all ext4 mounts
    grep ext4 /proc/mounts | awk '{print $1, $2, $4}'

    # Check filesystem default mount options (baked in at mkfs time)
    tune2fs -l /dev/sdX | grep "Default mount options"

    # If data=writeback appears and the filesystem holds application data:
    # ensure the application calls fsync() before considering a write durable,
    # or remount with data=ordered.
    ```

---

## Case 2: `O_DIRECT` and buffered I/O coherency — mixing modes corrupts reads

### Before state

Linux provides two I/O paths to the same file:

- **Buffered I/O** (default): reads and writes go through the page cache. Multiple processes reading the same file share cached pages.
- **O_DIRECT**: reads and writes bypass the page cache entirely, going directly between the userspace buffer and the storage device.

The correct mental model for the page cache is that it is a coherent cache: any read should see the most recently written data, regardless of how that data was written. Under the buffered I/O path alone this is guaranteed — everyone shares the same in-memory pages.

### The change

The problem arises when *both* paths are active simultaneously on the same file. This happens in practice: a database uses `O_DIRECT` for its own I/O, but a backup tool, monitoring agent, or `rsync` opens the same file without `O_DIRECT`, reading through the page cache.

The expectation of users encountering this situation was reasonable: surely the kernel would ensure that a buffered read of a file returns the data that was most recently written, regardless of which path wrote it?

### Observed regression

When an `O_DIRECT` write was followed by a buffered read of the same file region, the buffered read could return **stale data** — the content of the page cache from before the `O_DIRECT` write, not the freshly written data.

The sequence:

1. Process A opens a file with `O_DIRECT` and writes 4 KB to offset 0.
2. The write goes directly to disk; the page cache is not updated.
3. Process B (or even Process A without `O_DIRECT`) reads offset 0 via `read()`.
4. The page cache contains the old version of the data (from before step 1, if the page was previously cached). The kernel serves the stale cached page.
5. Process B sees data that does not reflect the `O_DIRECT` write.

The reverse direction also causes problems: a buffered write followed by an `O_DIRECT` read may read from disk rather than from the in-memory dirty page, again returning stale data.

The `open(2)` man page documents this explicitly:

> "If a file is opened in `O_DIRECT` mode while the same file has been opened with buffered I/O, the results are undefined."

But "undefined" was often interpreted as a theoretical concern rather than a routine production hazard, especially when tools like backup agents and database engines operated on the same files.

### Why it happened

The fundamental issue is that `O_DIRECT` writes are invisible to the page cache. From the page cache's perspective, the data at a given offset is what it last cached — it has no knowledge of an `O_DIRECT` write that went around it.

The kernel does include a cache invalidation step in the `O_DIRECT` write path, but the window between the invalidation and the completion of the DMA transfer creates a race:

In `fs/direct-io.c` (and later in the iomap direct I/O path), the `O_DIRECT` write sequence is roughly:

```
1. Invalidate (truncate) page cache pages covering the write range
2. Submit DMA write to storage
3. Wait for DMA completion
```

Between steps 1 and 3, a concurrent buffered read will fault in the page from disk — but the DMA write may not have completed yet, so the page that gets faulted in may be the *old* data from disk, not the new data being written. After the DMA completes (step 3), the disk has the new data, but the page cache now has a stale copy that was read in during the window.

This is a classic TOCTOU (time-of-check-to-time-of-use) race: the invalidation and the I/O completion are not atomic, and a concurrent reader can slip in between them.

The problem was acknowledged in the kernel, in glibc documentation, and in database documentation. PostgreSQL's documentation explicitly warned users not to mix buffered and direct I/O on database files. The `open(2)` man page on Linux carried the "undefined behavior" note precisely because the kernel developers recognized the race was not fully closed.

### Resolution

The correct resolution for applications is to avoid mixing `O_DIRECT` and buffered I/O on the same file. In practice this means:

- Tools that read database files (backups, monitoring) should also use `O_DIRECT`, or else the database should ensure the page cache is up to date before such reads (by calling `sync_file_range` or ensuring no concurrent `O_DIRECT` writes are in flight).
- Applications that use `O_DIRECT` for performance-critical writes should open all file descriptors to that file with `O_DIRECT`, not a mix.

From the kernel side, the `O_DIRECT` write path was made more careful about page cache invalidation over time. The `__blockdev_direct_IO()` path and the newer `iomap_dio_rw()` path both perform invalidation before and after the I/O to reduce the window, but the race cannot be fully eliminated without serializing all buffered reads against concurrent `O_DIRECT` writes — which would defeat the purpose of `O_DIRECT`.

```c
/*
 * Diagnostic: detect mixed-mode I/O on the same file.
 * Both fds refer to the same file; this is the problematic pattern.
 */
int fd_direct  = open("dbfile", O_RDWR | O_DIRECT);
int fd_buffered = open("dbfile", O_RDONLY);  /* page cache path */

/* A write through fd_direct followed by a read through fd_buffered
 * may return stale data. Do not do this. */
```

Modern Linux (v5.x and later) made further improvements to the `O_DIRECT` invalidation path to shrink the race window, but the fundamental advice remains: do not mix modes on the same file.

### What it taught us

**"Undefined behavior" in system call documentation is a real warning, not a theoretical footnote.** When the `open(2)` man page says mixing `O_DIRECT` and buffered I/O produces undefined results, it means there is a real race that the kernel cannot fully close without sacrificing the performance properties that make `O_DIRECT` valuable.

**Cache coherency is only guaranteed within a single I/O path.** The page cache is coherent for buffered I/O. `O_DIRECT` is coherent with disk. They are not coherent with each other.

**Operational tools that touch database files need to understand I/O modes.** Backup agents, `rsync`-based replication, and monitoring tools that read files without `O_DIRECT` while a database writes those same files with `O_DIRECT` are silently operating on potentially stale data.

!!! warning "Pattern to watch for"
    Mixed-mode I/O is particularly common in environments where databases are copied or backed up using standard filesystem tools (`cp`, `rsync`, `tar`) while the database continues running with `O_DIRECT`. The backup may be internally consistent but contain stale reads from the page cache.

    ```bash
    # Check if a process is using O_DIRECT on a file
    # (look for the 0x4000 flag in /proc/<pid>/fdinfo)
    grep flags /proc/<pid>/fdinfo/<fd>
    # flags: 0100002 → O_RDWR only (buffered)
    # flags: 0140002 → O_RDWR | O_DIRECT (0x4000 = 040000 octal = 16384 decimal)

    # Or use lsof:
    lsof -p <pid> | grep REG
    # Look for the "DIR" column; O_DIRECT files show specific access patterns
    ```

---

## Case 3: `fsync()` after `rename()` is not enough — losing files after a crash

### Before state

The canonical pattern for safely overwriting a file in a crash-safe manner is the "write to temp, then rename" idiom:

```c
/* Safe file update pattern */
fd = open("file.tmp", O_WRONLY | O_CREAT | O_TRUNC, 0644);
write(fd, data, len);
fsync(fd);   /* flush data and metadata of the new file */
close(fd);
rename("file.tmp", "file");  /* atomic replacement */
```

The intent is to ensure that either the old `file` or the new `file` is visible after a crash — never a partially-written version. The `fsync()` call before `rename()` ensures the new content is on disk. The `rename()` syscall is atomic at the VFS level.

This pattern was used by SQLite (in its journal mode), PostgreSQL (for WAL segment renaming and configuration file updates), many text editors, and countless other applications that needed to update files safely.

### The change

The problem was not a kernel regression. It was a gap between what programmers believed `fsync()` + `rename()` guaranteed and what it actually guaranteed on Linux.

The missing step: after `rename()`, the **parent directory** must also be `fsync()`'d.

### Observed regression

After a crash, the file `file.tmp` had been durably written (because `fsync(fd)` was called), and the `rename()` had completed in-memory — but after journal recovery, the directory entry pointing to `file` had vanished. The directory still showed the old state, as if the rename had never happened.

Applications that used this pattern for configuration updates could find their configuration file missing after a crash — reverting to an old version or losing the file entirely. SQLite users reported that databases could appear to lose committed transactions after a power failure. PostgreSQL reported similar issues in early versions with WAL segment management.

The problem was extensively documented by the database community and became one of the most well-known POSIX `fsync` subtleties. Ted Ts'o (an ext4 maintainer) and the PostgreSQL and SQLite developers wrote about it publicly. It also appears in Dan Luu's survey of file system correctness and in the Russ Cox analysis of file system behavior.

### Why it happened

On Linux, `fsync(fd)` flushes the file's data and inode to disk. It does **not** flush the parent directory.

A `rename()` modifies the parent directory: it removes the old directory entry (`file.tmp`) and adds a new one (`file`). This directory modification is an in-memory change (to the directory's data pages and to the inode's metadata). Without an `fsync()` on the directory, this change may not reach disk before a crash.

The sequence that causes the loss:

1. `write()` + `fsync(fd)` on `file.tmp` → data on disk, inode on disk.
2. `rename("file.tmp", "file")` → directory pages modified in page cache (dirty), but not yet on disk.
3. System crashes before the dirty directory pages are written.
4. After recovery: `file.tmp`'s data is on disk, the inode is on disk, but the directory does not contain an entry for `file`. The new file is an orphan. The old directory entry for `file` (pointing to the old content) may or may not be present depending on the filesystem's crash recovery semantics.

On ext4 with `data=ordered` journaling, the directory update is journaled but the journal transaction may not have been committed. Recovery replays committed transactions only — uncommitted transactions are discarded. The result is a directory in its pre-rename state.

The fix requires fsyncing the directory:

```c
/* Correct crash-safe file replacement */
int fd = open("file.tmp", O_WRONLY | O_CREAT | O_TRUNC, 0644);
write(fd, data, len);
fsync(fd);            /* flush data and inode of the new file */
close(fd);
rename("file.tmp", "file");

/* This step is the one that was missing: */
int dir_fd = open(".", O_RDONLY);
fsync(dir_fd);        /* flush the directory entry update */
close(dir_fd);
```

The directory `fsync()` ensures that the rename's modification to the directory pages is on disk before the application considers the operation complete.

### Resolution

**SQLite** (versions 3.7.x and later) added directory `fsync()` to its unix VFS layer after this issue was reported and analyzed. The `PRAGMA fullfsync` and the default unix sync behavior were updated to fsync the directory after rename operations involving WAL files and rollback journals.

**PostgreSQL** added `fsync_fname()` and explicit directory syncing in its WAL and checkpoint code. The `fsync_fname` function in `src/backend/storage/file/fd.c` opens the path and calls `fsync()`, and PostgreSQL calls this for parent directories after file renames.

**The kernel** added `sync_file_range(2)` and `fdatasync(2)` as supplementary tools, but neither addresses the directory sync requirement — those are still userspace responsibilities. The kernel cannot automatically fsync directories on rename because that would make `rename()` synchronous and break the performance properties that make it useful.

On ext4, the `dirsync` mount option makes all directory operations synchronous:

```bash
# Mount with dirsync: all directory updates are synchronous
mount -o dirsync /dev/sdX /mnt
# This is slow but ensures directory entries are always durable.
# Most applications should handle this themselves rather than using dirsync.
```

The `sync_file_range()` syscall can be used to flush specific byte ranges of a file, but does not help with directory durability:

```c
/* sync_file_range: flush specific ranges of a file's data */
/* Does NOT fsync inode or parent directory */
sync_file_range(fd, 0, 0, SYNC_FILE_RANGE_WRITE | SYNC_FILE_RANGE_WAIT_AFTER);
/* Still need: fsync(fd) for inode, fsync(dir_fd) for directory entry */
```

### What it taught us

**`rename()` atomicity is in-memory atomicity, not durability.** The rename syscall is atomic in the sense that no other process will see a partially-renamed state — but it is not durable until the directory's pages are flushed to disk.

**POSIX does not require `rename()` to be durable.** POSIX guarantees that `rename()` is atomic with respect to concurrent observers, but says nothing about crash recovery. Linux implements the POSIX guarantee without the additional durability guarantee. Applications that need both must explicitly fsync the directory.

**High-profile software shipped with this bug.** SQLite and PostgreSQL, two of the most carefully written database systems in open source, both had this issue in some of their releases. If they missed it, the implication is that most applications missed it too. The correct pattern is not obvious from reading the man pages.

!!! warning "Pattern to watch for"
    Any application that uses write-to-temp-then-rename for crash safety must fsync the parent directory after the rename. This includes text editors (saving files), databases (log segment management), and any system that atomically replaces configuration or data files.

    ```bash
    # Check if a process is fsyncing after rename using strace
    strace -e trace=fsync,fdatasync,rename,renameat -p <pid>

    # Correct output for a crash-safe rename should show:
    # fsync(fd_for_tempfile)     ← flush new file content
    # rename("file.tmp", "file") ← atomic replacement
    # fsync(fd_for_directory)    ← flush directory entry update

    # Missing the last fsync means the rename may be lost after a crash.
    ```

---

## Case 4: Dirty throttling writeback stalls — write latency spikes from balance_dirty_pages

### Before state

The Linux dirty page throttling mechanism exists to prevent applications from writing data to the page cache faster than the kernel can flush it to storage. Without throttling, an application could dirty all available memory in seconds, leaving the kernel with no clean pages to allocate and causing sudden, catastrophic I/O bursts.

The mechanism works by tracking the total amount of dirty data system-wide and per backing device, comparing it against configurable thresholds, and slowing down ("throttling") processes that are writing too fast when those thresholds are exceeded. The key function is `balance_dirty_pages()`, called from `generic_perform_write()` after each write that dirtied pages.

Before v3.1, the throttling logic applied a per-process pause when the dirty ratio exceeded a threshold. The pause was relatively crude: processes were either running or sleeping, with limited gradation between the two.

### The change

In Linux v3.1, Fengguang Wu introduced a substantially reworked dirty throttling algorithm (sometimes called "smoothed dirty throttling" or "bdi-based throttling"). The goal was to make throttling more proportional and fair: instead of a binary sleep/run decision, processes should be slowed to match the throughput of the underlying storage device, with pauses scaled to the degree of exceedance.

The new algorithm tracked per-BDI (backing device info) write bandwidth, estimated how long a dirty page would take to be written back, and used that estimate to compute a sleep time for throttled writers. The intent was to produce smooth, predictable write behavior across diverse storage speeds.

This change was covered in detail in LWN articles on the dirty throttling rework (see [LWN: Flushing out pdflush](https://lwn.net/Articles/326552/) for background, and the v3.1 changelog).

### Observed regression

After v3.1, several production workloads reported **write latency spikes** — individual `write()` calls that normally completed in microseconds now took tens or hundreds of milliseconds. The spikes were intermittent and correlated with periods of high write activity.

The pattern had two distinct manifestations:

**The bandwidth estimation problem**: The new algorithm estimated storage bandwidth by measuring how fast dirty pages were being written back. If the writeback thread was briefly idle (because there was nothing to flush), the bandwidth estimate could fall to a low value. The next burst of writes would then be throttled heavily based on the stale low-bandwidth estimate, causing the first writes in a burst to stall even though the device was fully available.

**The sync-heavy workload problem**: Workloads that called `fsync()` frequently (databases, journaling applications) created a sawtooth pattern: write a burst of data, call `fsync()` which drains the dirty pages, repeat. The dirty throttle saw the post-fsync state as "no dirty pages" and reset its bandwidth estimate. The next write burst was then throttled as if the device were slow, even though it had just demonstrated high throughput.

These regressions were reported on LKML by database operators and application developers, and Fengguang Wu and other mm developers issued a series of fixes in v3.2 through v3.10 to address the stall cases.

### Why it happened

The bandwidth estimation in `bdi_dirty_limit()` and the throttle computation in `balance_dirty_pages()` relied on an exponentially weighted moving average of observed writeback throughput. The averaging window and the reaction to sudden changes in write rate created instability:

```
Estimated bandwidth:
  bw_est = α × recent_bw + (1-α) × old_bw_est

If writeback is idle:
  recent_bw → 0
  bw_est → decays toward 0
  Throttle computation: sleep_time = dirty_bytes / bw_est → very large

Next write burst:
  First write hits balance_dirty_pages()
  bw_est is still near 0 from the idle period
  sleep_time is computed as enormous
  Process sleeps for hundreds of milliseconds
  Meanwhile, writeback starts and demonstrates full bandwidth
  But the sleeping process doesn't wake up quickly enough
```

The issue was that the throttling algorithm was reactive: it measured what the device had done recently and assumed that was representative of what it could do now. A device that had been idle for 500 ms appeared to have zero bandwidth, even if it was capable of 500 MB/s.

The per-process sleep in `balance_dirty_pages()` is in `mm/page-writeback.c`. The sleep is implemented via `io_schedule_timeout()`, which puts the process into the `TASK_KILLABLE` sleep state and does not return until the timeout expires or the process is killed — there is no early wakeup based on the device becoming available.

### Resolution

Fengguang Wu and the mm team issued multiple patches across v3.2–v3.10 to address the stall cases:

- **Minimum bandwidth floor**: A minimum estimated bandwidth was established to prevent the estimate from decaying to zero. This prevented the catastrophic first-write stall after an idle period.
- **Wakeup improvements**: Logic was added to wake throttled processes earlier when writeback caught up faster than expected.
- **Global vs. per-BDI accounting fixes**: Interaction bugs between global dirty limits and per-BDI limits were fixed to prevent double-throttling.

Operator-visible tunables for the dirty throttling behavior:

```bash
# Global dirty thresholds
cat /proc/sys/vm/dirty_ratio          # % of RAM at which throttling starts
cat /proc/sys/vm/dirty_background_ratio  # % at which background writeback starts

# Or absolute byte values (override ratio settings if nonzero)
cat /proc/sys/vm/dirty_bytes
cat /proc/sys/vm/dirty_background_bytes

# Writeback timeout: how old a dirty page can be before forced writeback
cat /proc/sys/vm/dirty_expire_centisecs    # default: 3000 (30 seconds)
cat /proc/sys/vm/dirty_writeback_centisecs # how often writeback runs

# For workloads with frequent fsync and write bursts:
# Reduce dirty_ratio to keep less dirty data in flight at any time.
# This reduces the throttle headroom needed.
sysctl vm.dirty_ratio=5
sysctl vm.dirty_background_ratio=3
```

For database workloads that use `fsync()` heavily and are sensitive to write latency, a common production workaround was to use `O_DIRECT` (bypassing dirty throttling entirely) or to reduce `dirty_ratio` to reduce the amount of data the throttler had to manage.

The `tracing/events/writeback/` tracepoints can expose throttling events:

```bash
# Enable writeback throttle tracing
echo 1 > /sys/kernel/debug/tracing/events/writeback/balance_dirty_pages/enable
cat /sys/kernel/debug/tracing/trace_pipe
# Look for: balance_dirty_pages: ... paused=<N>ms ...
```

### What it taught us

**Feedback-control algorithms are sensitive to idle periods.** An estimator that measures throughput during active periods and extrapolates to predict future capacity will fail when the system transitions from idle to active. The measurement during idle (zero throughput) is not representative of capacity.

**Throttling that sleeps unconditionally cannot react to changing conditions.** When `balance_dirty_pages()` puts a process to sleep for a computed duration, that duration was correct at the moment of calculation — but it may be wrong seconds later when the storage device has demonstrated higher throughput. The throttler should be able to wake early.

**Write throughput ≠ write latency.** The throttling mechanism was designed to protect aggregate throughput and memory usage. It was not designed to bound per-write latency. A process writing 4 KB could sleep for 100 ms if the estimator was wrong about bandwidth — a 25,000x latency amplification. This is unacceptable for latency-sensitive workloads.

!!! warning "Pattern to watch for"
    Intermittent write latency spikes on kernels v3.1–v3.10 (or on later kernels with high dirty ratios) should be investigated with writeback tracing before attributing the latency to storage hardware.

    ```bash
    # Check for throttling events
    grep -i 'balance_dirty\|writeback_wait' /sys/kernel/debug/tracing/available_events

    # Quick check: are writers being throttled?
    cat /proc/vmstat | grep -E 'writeback|dirty'
    # Key counters:
    # nr_dirty         - current dirty pages
    # nr_writeback     - pages currently under writeback
    # nr_dirty_threshold - current dirty throttle threshold

    # If nr_dirty is consistently near nr_dirty_threshold, throttling is active.
    # If write latency spikes correlate with nr_dirty crossing the threshold,
    # dirty throttling is the cause.
    ```

---

## Case 5: The `sendfile()` and `splice()` stall — zero-copy I/O and pipe buffer deadlocks

### Before state

`sendfile(2)` and `splice(2)` are zero-copy I/O system calls that allow data to be transferred between file descriptors without copying it through userspace. Their primary use case is efficient file serving (HTTP servers like nginx and Apache) and data pipelines.

```
Traditional read() + write():
  disk → kernel buffer (DMA)
  kernel buffer → userspace buffer (copy)
  userspace buffer → socket buffer (copy)
  socket buffer → NIC (DMA)

sendfile() / splice():
  disk → page cache (DMA)
  page cache → socket buffer (page reference, no copy)
  socket buffer → NIC (DMA)
```

`splice()` is more general: it can splice between any two file descriptors where at least one is a pipe. It was introduced in v2.6.17 (2006) by Jens Axboe and Linus Torvalds as a generalization of `sendfile()`.

Both calls were heavily used in high-throughput file serving and are critical to the performance of nginx, Apache, and various proxy servers.

### The change

The pipe buffer implementation that backs `splice()` uses a fixed-size ring of buffer entries (`PIPE_DEF_BUFFERS = 16` entries by default). Each entry can reference a page from the page cache. When the ring is full and the reader has not consumed any entries, the writer blocks.

The interaction that caused production incidents was not a single kernel change but the combined effect of:

1. Large file transfers using `splice()` that fed data faster than the consumer (socket, pipe reader) could drain it.
2. The file being read was also being written by another process (a log file, a growing file, or a file being updated).
3. The `sendfile()` caller holding `mmap_lock` (formerly `mmap_sem`) on the source file's mappings while blocked on the pipe buffer being full.

In certain kernel versions (particularly in the v2.6.x series through early v3.x), the interaction between `splice()`'s pipe buffer blocking and locks held on the source file could produce deadlocks or very long stalls.

### Observed regression

Production reports from file servers and content delivery systems described two failure patterns:

**Throughput collapse under load**: nginx or Apache processes using `sendfile()` would see throughput drop to near zero when serving many concurrent large file transfers. The system had CPU and network capacity available, but the file serving processes were blocked.

**Deadlocks with writable files**: In scenarios where a log file was being both written (by an application) and served via `splice()` or `sendfile()` (by a proxy or log shipping agent), a deadlock could occur. The `splice()` reader held the pipe write end blocked waiting for the pipe buffer to drain; the pipe buffer drain was waiting for the socket to drain; and the socket was waiting for the application to read — creating a cycle.

These were reported in nginx bug trackers, Apache mailing lists, and LKML discussions about `splice()` and `sendfile()` behavior under load.

A related and well-documented issue was the interaction between `splice()` and files that had pages under writeback. In some kernel versions, splicing a page that was currently being written back (dirty → writeback state transition) could cause `splice()` to block on the page lock in `wait_on_page_writeback()`, producing unexpected latency for operations that were supposed to be zero-copy reads.

### Why it happened

The `splice()` implementation in `fs/splice.c` involves several distinct lock acquisitions and blocking points:

```
splice_file_to_pipe():
  1. get_pipe_inode()     → acquire pipe->mutex
  2. do_splice_to()       → calls file->f_op->splice_read
     → generic_file_splice_read()
       → find_get_pages_contig() → acquires page references
       → for each page: wait_on_page_locked() if page is locked
       → for each page: wait_on_page_writeback() if page under writeback
  3. pipe_write()         → blocks if pipe buffer is full
     (holds pipe->mutex while blocked)
```

The blocking in step 3 (pipe buffer full) while holding state from steps 1–2 created the opportunity for priority inversions and deadlocks when the pipe reader was another kernel path that needed the same resources.

Additionally, the `sendfile()` implementation on older kernels used a temporary mapping of the source pages that, in some configurations, required acquiring the file's `mmap_lock` for reading. If the file was simultaneously being truncated or remapped by another process, `mmap_lock` contention caused `sendfile()` to block — sometimes for the duration of a competing `mmap()` or `munmap()` operation on a large mapping.

The zero-copy page reference mechanism in `splice()` meant that spliced pages were "pinned" in the page cache until the pipe buffer entry was consumed. Under high load, this could exhaust the pipe buffer (PIPE_BUF_FLAG_* limits) and cause all further splice operations on those files to block until the consumer drained its end.

### Resolution

Several improvements addressed these issues across kernel versions:

**Pipe buffer size tuning** (v2.6.35+): The `F_SETPIPE_SZ` fcntl was added to allow setting the pipe buffer size per pipe. High-throughput applications could increase the pipe buffer to reduce the frequency of blocking:

```c
/* Increase pipe buffer to 1 MB to reduce blocking frequency */
int fds[2];
pipe(fds);
fcntl(fds[1], F_SETPIPE_SZ, 1024 * 1024);  /* 1 MB pipe buffer */

/* Check current and maximum sizes */
int current_size = fcntl(fds[0], F_GETPIPE_SZ);

/* System maximum (default 1 MB, configurable) */
/* cat /proc/sys/fs/pipe-max-size */
```

**Writeback wait removal from splice path**: Later kernel versions made the splice read path skip pages under active writeback rather than blocking on them, accepting that the spliced data might be slightly behind the current write state. This avoided the `wait_on_page_writeback()` blocking in the hot path.

**`sendfile()` implementation refinements**: The interaction between `sendfile()` and `mmap_lock` was addressed by limiting the scope of the lock during the page reference phase, reducing contention with concurrent mmap/munmap operations.

For applications:

```bash
# Increase system-wide maximum pipe size (affects F_SETPIPE_SZ ceiling)
sysctl fs.pipe-max-size=4194304  # 4 MB

# Check current pipe-max-size
cat /proc/sys/fs/pipe-max-size

# For nginx: use sendfile = on with sendfile_max_chunk to limit
# the amount of data sent in one sendfile() call, preventing
# the kernel from holding page references for too long.
# nginx.conf:
#   sendfile on;
#   sendfile_max_chunk 512k;
```

The `sendfile_max_chunk` configuration (nginx-specific) limits how much data is transferred per `sendfile()` syscall, allowing the event loop to regain control and drain pipe buffers between chunks.

### What it taught us

**Zero-copy is not zero-blocking.** `sendfile()` and `splice()` eliminate memory copies, but they do not eliminate the need to acquire locks and wait for page states. A path that blocks on `wait_on_page_writeback()` in the middle of a "zero-copy" operation is still a blocking operation from the caller's perspective.

**Pipe buffers are a hidden resource that can be exhausted.** The default 16-entry, 64 KB pipe buffer is fine for most uses but becomes a bottleneck for high-throughput file serving. The inability to resize pipe buffers at all (before v2.6.35) was a design limitation that created a fixed ceiling on `splice()` throughput per file descriptor pair.

**Deadlock analysis must include kernel blocking points.** The `splice()` deadlock scenarios were difficult to diagnose because the blocking was invisible from userspace: processes appeared to be doing I/O but were actually blocked on pipe buffer drains, page writeback waits, or mmap_lock contention deep in the kernel. Standard tools like `strace` did not clearly expose which kernel lock was causing the block.

!!! warning "Pattern to watch for"
    If nginx, Apache, or another file server using `sendfile()` shows high CPU idle but low throughput under load, check whether splice/sendfile is blocking on pipe buffer exhaustion or page locks:

    ```bash
    # Check for processes blocked in sendfile/splice
    # D state means blocked in kernel (uninterruptible sleep)
    ps aux | grep " D "

    # Get kernel stack of a stuck process
    cat /proc/<pid>/wchan          # shows which kernel function it's sleeping in
    cat /proc/<pid>/stack          # full kernel stack (requires root)

    # Look for:
    # pipe_write         → pipe buffer full
    # wait_on_page_bit   → waiting for a page lock
    # inode_lock         → inode lock contention

    # Check pipe buffer size for the relevant file descriptors
    ls -la /proc/<pid>/fd/         # identify pipe fds
    cat /proc/<pid>/fdinfo/<fd>    # pipe_size shows current buffer
    ```

---

## Common threads

These five incidents share structural patterns that recur across the I/O stack:

| Pattern | ext4 writeback stale data | O_DIRECT coherency | fsync + rename | Dirty throttle stalls | splice deadlocks |
|---------|--------------------------|-------------------|----------------|----------------------|-----------------|
| Correct in isolation, wrong in combination | Yes | Yes | Yes | Partial | Yes |
| Documented but widely misunderstood | Yes | Yes | Yes | No | Partial |
| Required userspace behavior change | Yes | Yes | Yes | No | Partial |
| Fixed by kernel improvement alone | No | No | No | Yes (partial) | Yes (partial) |
| Root cause: ordering or timing assumption | Yes | Yes | Yes | Yes | Yes |

The I/O stack is particularly prone to **ordering assumption bugs**: code that is correct when operations happen in a given sequence but silently fails when that sequence is not enforced by explicit synchronization. The three fsync-related cases (Cases 1, 3, and implicitly Case 2) all fit this pattern.

A second theme is **coherency across abstraction boundaries**: the page cache is coherent within itself, the journal is coherent within itself, and the block device is coherent within itself — but interactions between these layers, or between different I/O paths to the same file, are where the bugs live.

---

## See also

- [Page Cache Writeback](page-cache-writeback.md) — How dirty pages are flushed, throttling thresholds, and BDI bandwidth estimation
- [Direct I/O](direct-io.md) — O_DIRECT alignment requirements, DIO path, and mmap comparison
- [Async I/O evolution](async-io.md) — POSIX AIO, Linux AIO limitations, and io_uring
- [splice and sendfile](splice-sendfile.md) — Zero-copy I/O internals and pipe buffer mechanics
- [mmap I/O](mmap-io.md) — Memory-mapped I/O, page faults, and mmap/O_DIRECT interaction
- [Filesystem observability](observability.md) — Tracepoints, /proc/vmstat counters, and iostat for diagnosing I/O issues
- [Life of a write](life-of-a-write.md) — End-to-end write path from syscall to disk

---

## External references

- [LWN: Flushing out pdflush](https://lwn.net/Articles/326552/) — Background on writeback thread design leading to the dirty throttling rework
- [LWN: When writeback goes wrong](https://lwn.net/Articles/384093/) — Dirty throttling and BDI writeback problems
- [LWN: No-I/O dirty throttling](https://lwn.net/Articles/456904/) — Fengguang Wu's dirty throttling improvements in v3.1
- [ext4 and data loss](https://lwn.net/Articles/322823/) — ext4 journaling modes and their crash semantics
- [Kernel docs: ext4](https://docs.kernel.org/filesystems/ext4/index.html) — Official ext4 documentation including journaling mode descriptions
- [open(2) man page](https://man7.org/linux/man-pages/man2/open.2.html) — O_DIRECT documentation including the mixed-mode coherency warning
- [fsync(2) man page](https://man7.org/linux/man-pages/man2/fsync.2.html) — fsync semantics and the note on directory syncing
- [SQLite atomic commit documentation](https://www.sqlite.org/atomiccommit.html) — SQLite's analysis of fsync semantics and the directory sync requirement
- [PostgreSQL WAL reliability documentation](https://www.postgresql.org/docs/current/wal-reliability.html) — PostgreSQL's requirements for fsync and directory sync
- [Russ Cox: Fsync after rename](https://research.swtch.com/gofsck) — Analysis of fsync + rename semantics on Linux and other systems
- [splice(2) man page](https://man7.org/linux/man-pages/man2/splice.2.html) — splice system call documentation
- [fs/splice.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/splice.c) — splice implementation
- [fs/ext4/inode.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/ext4/inode.c) — ext4 writepage and ordered/writeback mode handling
- [mm/page-writeback.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page-writeback.c) — balance_dirty_pages() and dirty throttling implementation

## Further reading

- [war-stories-regressions.md](../mm/war-stories-regressions.md) — Memory management regressions: THP compaction stalls, NUMA balancing overhead, khugepaged CPU storms, and swap readahead mismatch; the same "optimization correct in theory, wrong for this workload" pattern applies to I/O
- [Tuning storage I/O](tuning-storage.md) — Practical guidance for dirty ratio tuning, O_DIRECT configuration, and sendfile/splice tuning for production workloads
- [Filesystem observability](observability.md) — The `/proc/vmstat` counters (`nr_dirty`, `nr_writeback`, `pgpgout`) and tracepoints for diagnosing all five cases documented here
- [Ensuring data reaches disk](https://lwn.net/Articles/457667/) — Jeff Moyer on the directory fsync requirement and filesystem behavior differences across Linux filesystem implementations
