# I/O Sysctl Tuning Reference

Compact reference for all I/O-related sysctls and block-layer knobs. Covers `vm.dirty_*` writeback controls under `/proc/sys/vm/`, filesystem limits under `/proc/sys/fs/`, per-device queue parameters under `/sys/block/`, and BDI (backing device info) controls under `/sys/class/bdi/`.

Read or write any `/proc/sys/` value at runtime:

```bash
# Read
sysctl vm.dirty_ratio
# Write (non-persistent)
sysctl -w vm.dirty_ratio=10
# Persistent (survives reboot)
echo "vm.dirty_ratio = 10" >> /etc/sysctl.d/99-io-tuning.conf
sysctl --system
```

Block-layer knobs live under sysfs and are not managed by `sysctl(8)`:

```bash
# Read
cat /sys/block/nvme0n1/queue/scheduler
# Write (non-persistent)
echo mq-deadline > /sys/block/nvme0n1/queue/scheduler
# Persistent — use a udev rule or a systemd service that runs after udev settles
```

---

## vm.dirty_* — Dirty Page Writeback Controls

The kernel's writeback subsystem accumulates modified (dirty) page cache in memory and periodically flushes it to disk via per-device flusher threads (`kworker/u*:*` threads running `wb_workfn`). The `vm.dirty_*` sysctls control when that flushing happens, how aggressively it runs, and when writing processes are throttled.

Two control dimensions exist for the dirty limits:

- **Ratio-based** (`dirty_ratio`, `dirty_background_ratio`): limits expressed as a percentage of total memory. Simple to reason about; scale automatically with RAM.
- **Byte-based** (`dirty_bytes`, `dirty_background_bytes`): absolute byte limits. More predictable on systems with variable or large memory (e.g., a 1 TiB machine where 10% means 100 GiB of dirty data).

Setting either byte knob to a nonzero value disables the corresponding ratio knob, and vice versa. Do not set both simultaneously.

---

### vm.dirty_ratio

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/vm/dirty_ratio` |
| Default | `20` |
| Valid range | `0`–`100` (percent) |
| Kernel source | `mm/page-writeback.c` — `dirty_ratio_handler()` |

Maximum percentage of total memory that can be occupied by dirty pages before a process that is generating more dirty data is throttled in `balance_dirty_pages()`. When a writing process crosses this threshold, the kernel inserts delays proportional to how far over the limit the system is. This is a hard per-process throttle, not a system-wide lock.

**Effect:** At the default of 20, on a 16 GiB machine the throttle engages when roughly 3.2 GiB of page cache is dirty. The writing process itself pays the writeback cost rather than a background thread.

**When to change:**

- **Lower** (e.g., 5–10) for databases or latency-sensitive services where write stalls are unacceptable. Less dirty data means shorter flush bursts.
- **Raise** (e.g., 40–60) on streaming-write workloads (log ingestion, video capture) where saturating the write path in background is preferable to throttling the writer.
- **Set to 0** only with `dirty_bytes` set instead; a ratio of 0 without a byte limit causes immediate throttling.

---

### vm.dirty_background_ratio

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/vm/dirty_background_ratio` |
| Default | `10` |
| Valid range | `0`–`100` (percent) |
| Kernel source | `mm/page-writeback.c` — `dirty_background_ratio_handler()` |

Percentage of total memory at which the kernel wakes the per-BDI flusher threads to begin background writeback. This is the low watermark: flushing starts before `dirty_ratio` is reached, so in normal operation the hard throttle in `balance_dirty_pages()` is never hit.

**Effect:** On a 16 GiB machine with the default of 10, background flushing begins around 1.6 GiB of dirty data. With `dirty_ratio` at 20, there is a 1.6 GiB window during which background flushing is active but writers are not yet throttled.

**When to change:**

- **Lower** (e.g., 1–3) when you need minimal dirty data in-flight — useful if the machine may lose power or if you need tighter write ordering guarantees above what fsync provides per-file.
- **Raise** (e.g., 20–30) to allow larger write batches before background flushing kicks in. Beneficial on fast NVMe where the flusher can drain quickly once it wakes.
- Always keep `dirty_background_ratio` < `dirty_ratio`.

---

### vm.dirty_bytes

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/vm/dirty_bytes` |
| Default | `0` (disabled; `dirty_ratio` is active) |
| Valid range | ≥ two pages in bytes (must be ≥ 8192 on a 4 KiB page system); `0` to disable |
| Kernel source | `mm/page-writeback.c` — `dirty_bytes_handler()` |

Absolute byte equivalent of `vm.dirty_ratio`. When set to a nonzero value, this limit replaces the ratio-based throttle. Writing processes are throttled when total dirty memory exceeds this number of bytes.

**Effect:** Unlike the ratio, this value does not change when memory is hotplugged or when the system has variable RAM. A cluster of identical machines will behave identically regardless of RAM differences.

**When to change:**

- Use on servers with large RAM where a percentage limit translates to an uncomfortably large dirty buffer (e.g., 10% of 512 GiB = 51 GiB).
- Set alongside `dirty_background_bytes` for a fully byte-controlled writeback policy.
- Do not set both `dirty_bytes` and `dirty_ratio` to nonzero values simultaneously; the kernel honors bytes when it is nonzero.

---

### vm.dirty_background_bytes

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/vm/dirty_background_bytes` |
| Default | `0` (disabled; `dirty_background_ratio` is active) |
| Valid range | ≥ 1 byte; `0` to disable |
| Kernel source | `mm/page-writeback.c` — `dirty_background_bytes_handler()` |

Absolute byte equivalent of `vm.dirty_background_ratio`. When nonzero, flusher threads begin background writeback once dirty memory exceeds this byte count.

**When to change:** Same rationale as `dirty_bytes`. Set both together for a coherent byte-based policy. Ensure `dirty_background_bytes` < `dirty_bytes`.

---

### vm.dirty_writeback_centisecs

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/vm/dirty_writeback_centisecs` |
| Default | `500` (5 seconds) |
| Valid range | `0`–`UINT_MAX` (centiseconds) |
| Kernel source | `fs/fs-writeback.c` — `wb_timer_fn()` |

How often (in centiseconds, i.e., hundredths of a second) the periodic writeback timer fires to wake the flusher threads. At the default of 500, flusher threads wake every 5 seconds to check for dirty data that has exceeded `dirty_expire_centisecs` and flush it.

**Effect:** This controls the periodic writeback cadence — the "kupdate" flush path. It is separate from the background-ratio-triggered path (which fires immediately when the ratio is exceeded) and the throttle path.

**When to change:**

- **Lower** (e.g., 200) on latency-sensitive systems that cannot tolerate sudden flush bursts every 5 seconds. More frequent, smaller flushes smooth out I/O latency.
- **Raise** (e.g., 1500–3000) on battery-powered or disk-spin-down systems where waking the disk every 5 seconds is undesirable.
- **Set to 0** to disable periodic writeback entirely. Useful for microbenchmarks where you want to measure write throughput without writeback interference. **Not safe for production** — dirty data will only be flushed when `dirty_ratio` is exceeded or on `fsync`.

---

### vm.dirty_expire_centisecs

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/vm/dirty_expire_centisecs` |
| Default | `3000` (30 seconds) |
| Valid range | `0`–`UINT_MAX` (centiseconds) |
| Kernel source | `fs/fs-writeback.c` — `wb_check_old_data_flush()` |

Age (in centiseconds) at which dirty data is considered "expired" and becomes eligible for writeback by the periodic flusher. Data that has been dirty for longer than this interval is flushed on the next `dirty_writeback_centisecs` wakeup.

**Effect:** At the default of 3000, data written to the page cache but not explicitly fsynced will be written to disk within at most 30 seconds of being dirtied (under normal memory pressure). This bounds the maximum data loss window on ungraceful shutdown to roughly 30 seconds.

**When to change:**

- **Lower** (e.g., 500–1000) to reduce the data loss window. Relevant for workloads that do not use `fsync` but still need durability guarantees.
- **Raise** (e.g., 6000–12000) to allow more write coalescing. If many small writes touch the same pages, keeping them dirty longer lets the kernel merge them into fewer I/O operations.
- Note: actual flush timing depends on `dirty_writeback_centisecs`; the effective maximum data age is approximately `dirty_expire_centisecs + dirty_writeback_centisecs`.

---

## vm.vfs_cache_pressure

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/vm/vfs_cache_pressure` |
| Default | `100` |
| Valid range | `0`–no hard maximum (values above 10000 are unusual) |
| Kernel source | `mm/vmscan.c` — `get_scan_count()` |

Controls the kernel's tendency to reclaim memory used for VFS caches (dentries and inodes) relative to file-backed page cache. At 100, the kernel treats them equally. Values above 100 cause the kernel to prefer reclaiming dentries and inodes before page cache; values below 100 cause it to keep them longer at the expense of page cache.

**Effect:** Dentry and inode caches hold filesystem metadata (path components, inode structures). They have no backing store: evicting them means the kernel must re-read them from disk on the next access. Page cache holds file data and can be re-read too, but for frequently accessed files the cost is similar.

**When to change:**

- **Lower** (e.g., 50) on file servers or build servers with many small files and deep directory trees, where dentry/inode cache hit rate is critical to throughput.
- **Higher** (e.g., 200–500) if `/proc/meminfo` shows large `Slab` consumption from dentries/inodes that are crowding out file data.
- **Set to 0** with caution: a pressure of 0 means dentries and inodes are never reclaimed, which can cause unbounded slab growth.

---

## vm.page-cluster

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/vm/page-cluster` |
| Default | `3` |
| Valid range | `0`–`SWAP_CLUSTER_MAX_LOG` (typically 8) |
| Kernel source | `mm/swap_state.c` — `swapin_readahead()` |

Controls the number of pages read from swap in a single cluster. The kernel reads `2^page-cluster` pages around the faulted page when a swap-in occurs. At the default of 3, each swap fault triggers a readahead of 8 pages (32 KiB with 4 KiB pages).

**Effect:** This knob is relevant only when swapping is in use. It does not affect regular file I/O or page cache. Higher values reduce the number of swap device I/O requests at the cost of reading more data than needed for workloads with poor swap locality.

**When to change:**

- **Lower** (e.g., 0–1) for SSD swap or `zram` where random access is cheap and readahead adds overhead without benefit.
- **Raise** (e.g., 5) for rotational disk swap where sequential readahead amortizes seek costs.

---

## fs.* — Filesystem and File Descriptor Limits

Knobs under `/proc/sys/fs/` control system-wide and per-process resource limits for file descriptors, pipes, AIO, and filesystem notifications.

---

### fs.file-max

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/fs/file-max` |
| Default | Calculated at boot: approximately `RAM_KB / 10` (varies) |
| Valid range | `1`–hardware limit |
| Kernel source | `fs/file_table.c` |

Maximum number of open file descriptions (not file descriptors — descriptions are the underlying kernel objects) allowed system-wide. When this limit is reached, `open()`, `socket()`, and similar calls fail with `ENFILE`.

**Effect:** On a 4 GiB system the default is typically around 400,000. Large production servers often need this increased.

**Check current usage:**

```bash
cat /proc/sys/fs/file-nr
# output: <allocated>  <free>  <max>
```

**When to change:**

- **Raise** when `/proc/sys/fs/file-nr` shows usage approaching the limit, or when applications log `ENFILE` (too many open files — system-wide, not per-process).
- Common increase for busy servers: `echo 2000000 > /proc/sys/fs/file-max`
- Do not confuse with the per-process limit (`fs.nr_open` and `ulimit -n`); both must be large enough.

---

### fs.file-nr (read-only)

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/fs/file-nr` |
| Access | Read-only |
| Kernel source | `fs/file_table.c` — `proc_nr_files()` |

Reports three numbers: `<allocated> <free> <max>`. The allocated count includes all open file descriptions; the free count is the number of allocated slots that have been deallocated but not yet returned to the allocator (always 0 on Linux 2.6+, kept for compatibility).

**Use:** Monitor this file to detect file descriptor leaks (allocated climbs without dropping) or to determine whether `fs.file-max` needs to be raised.

```bash
watch -n 1 cat /proc/sys/fs/file-nr
```

---

### fs.nr_open

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/fs/nr_open` |
| Default | `1048576` (1 Mi) |
| Valid range | `RLIMIT_NOFILE_MAX`–`INT_MAX` (practically 1–`INT_MAX`) |
| Kernel source | `fs/file.c` |

Per-process hard ceiling on the number of open file descriptors. This acts as an absolute cap on `RLIMIT_NOFILE`: even if `ulimit -n unlimited` or `LimitNOFILE=infinity` is set, the process cannot open more than `fs.nr_open` files.

**Effect:** By default, no process can open more than 1,048,576 file descriptors. `setrlimit(RLIMIT_NOFILE, ...)` calls that try to exceed this value are rejected with `EINVAL`.

**When to change:**

- Raise before increasing `LimitNOFILE` in systemd unit files beyond 1,048,576.
- Typical high-connection servers (proxies, connection multiplexers): `echo 10000000 > /proc/sys/fs/nr_open`
- Must be changed system-wide before per-process limits can exceed the old value.

---

### fs.pipe-max-size

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/fs/pipe-max-size` |
| Default | `1048576` (1 MiB) |
| Valid range | page size–`UINT_MAX` |
| Kernel source | `fs/pipe.c` — `pipe_max_size_proc_handler()` |

Maximum size in bytes that an unprivileged process can set a pipe buffer to via `fcntl(fd, F_SETPIPE_SZ, size)`. Privileged processes (`CAP_SYS_RESOURCE`) can exceed this limit.

**Effect:** Pipe buffer size affects throughput of zero-copy pipelines using `splice(2)` and `tee(2)`. A larger buffer allows more data to be staged before the reader processes it, reducing context switches.

**When to change:**

- Raise (e.g., 4 MiB or 16 MiB) for high-throughput `splice`/`sendfile` pipelines or logging infrastructure where pipes are used to buffer between stages.
- Relevant for `ffmpeg`, `gstreamer`, and similar media pipelines that tune pipe sizes explicitly.

---

### fs.pipe-user-pages-hard

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/fs/pipe-user-pages-hard` |
| Default | `0` (disabled) |
| Valid range | `0` (unlimited) or any positive integer (pages) |
| Kernel source | `fs/pipe.c` |

Hard limit on the total number of pages an unprivileged user may allocate across all their pipes. When the limit is reached, pipe creation and `F_SETPIPE_SZ` calls fail with `EPIPE` or `ENOMEM` for that user.

**When to change:** Set on multi-tenant systems to prevent a single user from monopolizing pipe memory. Leave at 0 on single-purpose servers.

---

### fs.pipe-user-pages-soft

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/fs/pipe-user-pages-soft` |
| Default | `16384` (64 MiB on 4 KiB pages) |
| Valid range | `0` (disabled) or any positive integer (pages) |
| Kernel source | `fs/pipe.c` |

Soft limit on total pipe pages per unprivileged user. Unlike the hard limit, once this is exceeded the kernel reduces new pipe allocations to a single page. Privileged processes are exempt.

**When to change:**

- Raise on systems where legitimate applications create many large pipes (log multiplexers, data pipelines).
- Set to 0 to disable the soft limit entirely.

---

### fs.aio-max-nr

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/fs/aio-max-nr` |
| Default | `65536` |
| Valid range | `1`–no hard maximum (limited by available memory) |
| Kernel source | `fs/aio.c` — `aio_max_nr` |

Maximum number of outstanding asynchronous I/O requests (submitted via `io_submit(2)`) allowed system-wide across all processes. This limit applies to the legacy Linux AIO interface (`io_setup`/`io_submit`/`io_getevents`), not to `io_uring`.

**Effect:** Each AIO context (created by `io_setup`) reserves slots up to the ring size requested. The sum of all reserved slots cannot exceed `aio-max-nr`. `io_setup` returns `EAGAIN` when the limit is reached.

**When to change:**

- Raise on database servers that use `O_DIRECT` + `libaio` (e.g., MySQL, PostgreSQL with `io_method=worker` or `io_method=io_uring`, Oracle, Db2). These engines typically allocate AIO contexts with hundreds or thousands of slots per thread.
- Common value for busy OLTP databases: `echo 1048576 > /proc/sys/fs/aio-max-nr`
- Monitor `fs.aio-nr` to see how close you are to the limit.

---

### fs.aio-nr (read-only)

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/fs/aio-nr` |
| Access | Read-only |
| Kernel source | `fs/aio.c` |

Current number of outstanding AIO requests (slots allocated to AIO contexts) system-wide. Use this to monitor consumption against `aio-max-nr`.

```bash
watch -n 1 'cat /proc/sys/fs/aio-nr /proc/sys/fs/aio-max-nr'
```

---

### fs.inotify.max_user_watches

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/fs/inotify/max_user_watches` |
| Default | `65536` (8192 on some older distros) |
| Valid range | `1`–`INT_MAX` |
| Kernel source | `fs/notify/inotify/inotify_user.c` |

Maximum number of inotify watches a single user (by UID) may create across all `inotify` instances. When reached, `inotify_add_watch(2)` returns `ENOSPC`.

**Effect:** Each watch consumes approximately 540 bytes on 64-bit kernels. 65,536 watches ≈ 34 MiB per user.

**When to change:**

- Raise when running IDEs (VS Code, JetBrains), file sync tools (Dropbox, Syncthing), or build tools (Bazel, Gradle) on a developer workstation. These tools watch entire directory trees.
- Common complaint is VS Code printing "System limit for number of file watchers reached".
- Typical developer workstation value: `echo 524288 > /proc/sys/fs/inotify/max_user_watches`

---

### fs.inotify.max_user_instances

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/fs/inotify/max_user_instances` |
| Default | `128` |
| Valid range | `1`–`INT_MAX` |
| Kernel source | `fs/notify/inotify/inotify_user.c` |

Maximum number of `inotify` instances (file descriptors created by `inotify_init`) per user. Distinct from watch count.

**When to change:** Raise when applications create many short-lived inotify instances (each container runtime, test harness, or daemon allocates its own).

---

### fs.inotify.max_queued_events

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/fs/inotify/max_queued_events` |
| Default | `16384` |
| Valid range | `1`–`INT_MAX` |
| Kernel source | `fs/notify/inotify/inotify_user.c` |

Maximum number of events that can be queued on a single inotify file descriptor before events are dropped and an `IN_Q_OVERFLOW` event is generated. A slow reader under a high-churn directory will see overflows.

**When to change:** Raise if applications log inotify overflow events or miss filesystem notifications under high filesystem activity.

---

### fs.lease-break-time

| Attribute | Value |
|-----------|-------|
| Path | `/proc/sys/fs/lease-break-time` |
| Default | `45` |
| Valid range | `0`–`INT_MAX` (seconds) |
| Kernel source | `fs/locks.c` |

Number of seconds the kernel waits for a process holding a file lease (obtained via `fcntl(F_SETLEASE)`) to voluntarily release it after receiving a `SIGIO` lease-break signal, before the kernel forcibly breaks the lease. Used by Samba and other SMB/NFSv4 servers to implement opportunistic locking.

**When to change:**

- Lower (e.g., 10) in SMB environments where client timeouts are shorter than 45 seconds.
- Raise if lease holders legitimately need more time to flush and close files (e.g., slow NFS re-exports).

---

## block/ — Block Layer Queue Controls

Per-device tuning parameters live under `/sys/block/<device>/queue/`. Changes take effect immediately but are not persistent. Make them persistent with a udev rule:

```
# /etc/udev/rules.d/60-io-scheduler.rules
ACTION=="add|change", KERNEL=="nvme*", ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="sd*", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="sd*", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="bfq"
```

---

### /sys/block/DEVICE/queue/scheduler

| Attribute | Value |
|-----------|-------|
| Path | `/sys/block/<device>/queue/scheduler` |
| Default | `mq-deadline` (NVMe), `bfq` (rotational, many distros) |
| Options | `none`, `mq-deadline`, `bfq`, `kyber` |

The I/O scheduler (elevator) that manages the submission queue for this device. The currently active scheduler appears in brackets in the file content.

```bash
cat /sys/block/sda/queue/scheduler
# [mq-deadline] bfq kyber none
echo bfq > /sys/block/sda/queue/scheduler
```

**Scheduler summary:**

| Scheduler | Best for |
|-----------|----------|
| `none` | NVMe / fast SSDs with hardware queuing; no reordering, minimal overhead |
| `mq-deadline` | General-purpose; prevents request starvation; good default for most block devices |
| `bfq` | Rotational disks and SSDs where interactive responsiveness matters; provides per-process I/O fairness |
| `kyber` | Low-latency SSDs; maintains separate queues for read and sync-write to bound latency |

**When to change:**

- NVMe drives: prefer `none` or `kyber` to minimize scheduling overhead.
- SATA SSD: `mq-deadline` or `kyber`.
- HDD: `bfq` for interactive systems; `mq-deadline` for throughput-oriented servers.
- Virtual disk (virtio-blk, cloud): `none` — the hypervisor handles scheduling.

---

### /sys/block/DEVICE/queue/nr_requests

| Attribute | Value |
|-----------|-------|
| Path | `/sys/block/<device>/queue/nr_requests` |
| Default | `64` (HDD/SATA SSD) or `128`+ (NVMe) |
| Valid range | `1`–hardware queue depth |

Maximum number of requests the I/O scheduler will keep queued per hardware dispatch queue. This is a scheduler-side limit, distinct from the hardware submission queue depth (`queue_depth` in the device's sysfs).

**Effect:** A higher `nr_requests` lets the scheduler accumulate more requests for merging and reordering before dispatching to the hardware. A lower value reduces queueing latency but may reduce throughput.

**When to change:**

- **NVMe deep-queue workloads** (parallel random I/O): increase to 1024 or 2048 to match hardware queue depth.
  ```bash
  echo 1024 > /sys/block/nvme0n1/queue/nr_requests
  ```
- **HDD random I/O**: decrease to 32 to reduce seek overhead from deep queues.
  ```bash
  echo 32 > /sys/block/sda/queue/nr_requests
  ```

---

### /sys/block/DEVICE/queue/read_ahead_kb

| Attribute | Value |
|-----------|-------|
| Path | `/sys/block/<device>/queue/read_ahead_kb` |
| Default | `128` |
| Valid range | `0`–no hard limit (practical limit: several MiB) |

Size in KiB of the readahead window applied by the block layer when it detects sequential read patterns. When a sequential read is detected, the kernel speculatively reads ahead beyond the current position by this many KiB.

**Effect:** Readahead hides I/O latency by prefetching data before it is requested. It is beneficial for sequential reads and harmful for random reads (wastes I/O bandwidth reading data that will not be used).

**When to change:**

- **Sequential HDD workloads** (log processing, backups): raise to 2048–8192.
  ```bash
  echo 2048 > /sys/block/sda/queue/read_ahead_kb
  ```
- **Random read workloads** (databases with `O_DIRECT`, KV stores): set to 0 to disable readahead entirely.
  ```bash
  echo 0 > /sys/block/nvme0n1/queue/read_ahead_kb
  ```
- **NVMe sequential**: 128 is often sufficient; NVMe latency is low enough that readahead provides less benefit than on HDD.

Note: `vm.readahead` and per-file readahead (via `posix_fadvise(POSIX_FADV_SEQUENTIAL)`) interact with this limit; the block-layer limit is a ceiling.

---

### /sys/block/DEVICE/queue/rotational

| Attribute | Value |
|-----------|-------|
| Path | `/sys/block/<device>/queue/rotational` |
| Default | `1` for HDD, `0` for SSD/NVMe |
| Valid range | `0` or `1` |

Hints to the kernel and I/O scheduler whether the underlying device is rotational (HDD) or not. This affects scheduling decisions (e.g., BFQ uses different idle strategies for rotational vs. non-rotational devices).

**When to check/change:**

- Verify NVMe and SSD devices report `0`. Some older kernels or virtualisation layers may incorrectly report `1`, causing the scheduler to apply seek-minimisation logic that harms SSD performance.
  ```bash
  cat /sys/block/nvme0n1/queue/rotational  # should be 0
  echo 0 > /sys/block/nvme0n1/queue/rotational  # if incorrectly set to 1
  ```
- Cloud VM disks may need manual correction.

---

### /sys/block/DEVICE/queue/discard_max_bytes

| Attribute | Value |
|-----------|-------|
| Path | `/sys/block/<device>/queue/discard_max_bytes` |
| Default | `0` if TRIM not supported; device-dependent otherwise |
| Access | Read-only (set by driver) |

Maximum size in bytes of a single discard (TRIM) request the device accepts. A value of 0 means the device does not support discard operations.

**Use:** Check this before configuring `fstrim` schedules or `discard` mount options:

```bash
cat /sys/block/nvme0n1/queue/discard_max_bytes
# 2147483136 — TRIM supported, up to ~2 GiB per request
```

Discard is generally more efficient as a periodic batch (`fstrim -av` from a systemd timer) than as inline `discard` mount option, which issues a TRIM on every `unlink`.

---

### /sys/block/DEVICE/queue/max_sectors_kb

| Attribute | Value |
|-----------|-------|
| Path | `/sys/block/<device>/queue/max_sectors_kb` |
| Default | `1280` (typical) or device-dependent |
| Valid range | Up to `max_hw_sectors_kb` (read-only hardware limit in same directory) |

Maximum size in KiB of a single I/O request that the block layer will issue to this device. The hardware limit is in `max_hw_sectors_kb`; `max_sectors_kb` can be set lower but not higher than the hardware limit.

**When to change:**

- Rarely needed in practice. Lower to reduce request latency at the cost of throughput.
- Some RAID controllers perform better with smaller maximum request sizes.

---

### /sys/block/DEVICE/queue/wbt_lat_usec

| Attribute | Value |
|-----------|-------|
| Path | `/sys/block/<device>/queue/wbt_lat_usec` |
| Default | `75000` µs (75 ms) for rotational; `2000` µs (2 ms) for NVMe |
| Valid range | `0` (disable WBT) or any positive integer (microseconds) |
| Kernel source | `block/blk-wbt.c` |

Target latency threshold for the writeback throttle (WBT). WBT monitors read latency and throttles buffered writeback I/O when read latency exceeds this value. This prevents background writeback from saturating the device and starving reads.

**Effect:** WBT is a dynamic, adaptive mechanism — it does not hard-limit writes to a rate; it uses the target latency as feedback. When reads are fast, writeback is not throttled. When read latency climbs above `wbt_lat_usec`, writeback is progressively throttled.

**When to change:**

- Lower (e.g., 500 µs) on ultra-low-latency NVMe to protect read SLAs more aggressively.
- Set to `0` to disable WBT entirely for dedicated write devices where reads are not a concern (pure write benchmark, log-structured storage).
  ```bash
  echo 0 > /sys/block/nvme0n1/queue/wbt_lat_usec
  ```
- Raise on slow HDD if WBT is throttling writeback too aggressively (symptoms: high dirty page accumulation despite low device utilization).

---

## BFQ-Specific: /sys/block/DEVICE/queue/iosched/

When BFQ is the active scheduler, per-device tuning parameters appear under `/sys/block/<device>/queue/iosched/`. These are only present when BFQ is selected.

---

### low_latency

| Attribute | Value |
|-----------|-------|
| Path | `/sys/block/<device>/queue/iosched/low_latency` |
| Default | `1` |
| Valid range | `0` or `1` |

Enables BFQ's soft real-time heuristic, which identifies interactive (latency-sensitive) processes by their I/O pattern (short, bursty bursts followed by idle time) and grants them a higher service share.

**When to change:**

- Set to `0` on purely throughput-oriented servers (batch processing, backup nodes) where the soft-RT heuristic adds overhead without benefit.
- Leave at `1` on desktop and mixed-workload systems.

---

### slice_idle

| Attribute | Value |
|-----------|-------|
| Path | `/sys/block/<device>/queue/iosched/slice_idle` |
| Default | `0` for NCQ-capable devices; `8` ms for single-queue rotational |
| Valid range | `0`–`UINT_MAX` (milliseconds) |

Time in milliseconds BFQ waits (idles) after the current process's slice expires, anticipating that the same process will issue another request. Idling eliminates interleaving of requests from different processes, which is critical for rotational drives where mixed-process I/O causes seeks.

**Effect:** On NCQ (Native Command Queuing) capable SATA and NVMe drives the device reorders internally, so per-process idling is unnecessary and `slice_idle=0` is correct. On old single-queue rotational drives, idling dramatically reduces seeks.

**When to change:**

- For NVMe or NCQ SATA, verify `slice_idle` is 0.
- For non-NCQ HDD with severe mixed-workload seek issues, try values of 4–8 ms.

---

### timeout_sync

| Attribute | Value |
|-----------|-------|
| Path | `/sys/block/<device>/queue/iosched/timeout_sync` |
| Default | `124` jiffies (approximately 500 ms at HZ=250) |
| Valid range | positive integer (jiffies) |

Maximum time in jiffies before BFQ forces a synchronous queue to be served, even if doing so is not optimal. Prevents starvation of synchronous (read or sync-write) requests when the device is saturated with competing async writes.

**When to change:** Rarely needs adjustment. Lower if sync requests are experiencing starvation under heavy async write load. The value is in jiffies, so it is CONFIG_HZ-dependent.

---

### fifo_expire_sync / fifo_expire_async

| Attribute | Value |
|-----------|-------|
| Path | `/sys/block/<device>/queue/iosched/fifo_expire_sync` / `fifo_expire_async` |
| Default | `124` jiffies sync; `250` jiffies async |
| Valid range | positive integer (jiffies) |

Time before BFQ promotes a request to the "expired" priority level to prevent starvation. Sync requests expire sooner than async requests, reflecting their typically higher latency sensitivity.

---

## BDI Controls: /sys/class/bdi/

Backing Device Info (BDI) entries represent writable block devices from the writeback perspective. They appear under `/sys/class/bdi/` with names like `8:0` (SCSI) or `259:0` (NVMe). These knobs affect writeback bandwidth allocation across multiple devices.

---

### /sys/class/bdi/DEVICE/max_ratio

| Attribute | Value |
|-----------|-------|
| Path | `/sys/class/bdi/<major:minor>/max_ratio` |
| Default | `100` |
| Valid range | `0`–`100` (percent) |

Caps the maximum percentage of the global dirty limit (`vm.dirty_ratio` / `vm.dirty_bytes`) that this device may consume. By default a single slow device can accumulate dirty data up to the entire global dirty limit, starving faster devices of writeback bandwidth.

**Effect:** Setting `max_ratio=10` on a slow USB drive prevents it from absorbing more than 10% of the system's dirty page budget, leaving the rest for fast devices.

**When to change:**

- Set on slow auxiliary devices (USB, spinning backup drives) attached alongside fast primary storage.
  ```bash
  echo 10 > /sys/class/bdi/8:16/max_ratio  # sdb = slow external drive
  ```

---

### /sys/class/bdi/DEVICE/min_ratio

| Attribute | Value |
|-----------|-------|
| Path | `/sys/class/bdi/<major:minor>/min_ratio` |
| Default | `0` |
| Valid range | `0`–`100` (percent; sum across all BDIs must not exceed 100) |

Guarantees this device at least `min_ratio`% of the global dirty bandwidth. Under memory pressure, the writeback throttle will prioritize flushing to this device to ensure its share.

**Effect:** Ensures a fast device is not starved of dirty writeback opportunity when a slower device holds a large dirty share.

**When to change:**

- Use on the primary high-speed storage device in a mixed-device configuration to ensure it is not rate-limited by the global dirty accounting.
- The sum of all `min_ratio` values system-wide must not exceed 100.

---

### /sys/class/bdi/DEVICE/read_ahead_kb

| Attribute | Value |
|-----------|-------|
| Path | `/sys/class/bdi/<major:minor>/read_ahead_kb` |
| Default | Mirrors `/sys/block/<device>/queue/read_ahead_kb` |
| Valid range | `0`–no limit |

Per-BDI readahead size. This is the same knob exposed from the BDI side. Modifying either path changes the same value.

---

## Tuning Recipes

### Database Server (NVMe, O_DIRECT)

Databases using `O_DIRECT` bypass the page cache entirely for data files. The main concerns are minimizing writeback interference with database I/O and ensuring the scheduler does not add unnecessary latency.

```bash
# Databases do their own buffering — minimize page cache writeback interference
echo 5  > /proc/sys/vm/dirty_ratio
echo 1  > /proc/sys/vm/dirty_background_ratio
echo 200 > /proc/sys/vm/dirty_writeback_centisecs   # flush WAL/journal more often
echo 1000 > /proc/sys/vm/dirty_expire_centisecs

# Scheduler: mq-deadline for predictable latency; none for maximum throughput
echo mq-deadline > /sys/block/nvme0n1/queue/scheduler

# O_DIRECT bypasses page cache, so readahead is irrelevant for data files
echo 0 > /sys/block/nvme0n1/queue/read_ahead_kb

# Deep queue for NVMe
echo 1024 > /sys/block/nvme0n1/queue/nr_requests

# AIO: increase for libaio-based databases (MySQL, PostgreSQL, Oracle)
echo 1048576 > /proc/sys/fs/aio-max-nr

# File descriptors
echo 2000000 > /proc/sys/fs/file-max
echo 2000000 > /proc/sys/fs/nr_open
```

---

### High-Throughput Sequential Writes (HDD)

Streaming workloads (log ingestion, video recording, backup) benefit from large write batches that amortize HDD seek costs and allow the flusher to issue large sequential I/O.

```bash
# Allow large dirty buffer to coalesce writes into sequential runs
echo 40 > /proc/sys/vm/dirty_ratio
echo 20 > /proc/sys/vm/dirty_background_ratio
echo 6000 > /proc/sys/vm/dirty_expire_centisecs     # keep dirty longer for coalescing
echo 500  > /proc/sys/vm/dirty_writeback_centisecs  # standard wakeup interval

# BFQ for fair access to the drive in mixed workloads
echo bfq > /sys/block/sda/queue/scheduler

# Aggressive readahead for sequential patterns
echo 2048 > /sys/block/sda/queue/read_ahead_kb

# Reduce queue depth to minimize seeks under concurrent random I/O
echo 32 > /sys/block/sda/queue/nr_requests
```

---

### Latency-Sensitive NVMe Workload

Real-time analytics, low-latency key-value stores, or any workload where tail read latency matters. Minimize dirty accumulation and scheduler queueing delay.

```bash
# Keep dirty window very small to avoid sudden flush bursts
echo 2 > /proc/sys/vm/dirty_ratio
echo 1 > /proc/sys/vm/dirty_background_ratio
echo 200 > /proc/sys/vm/dirty_writeback_centisecs   # flush more often
echo 500 > /proc/sys/vm/dirty_expire_centisecs      # expire dirty data quickly

# Kyber: latency-optimised scheduler for NVMe
echo kyber > /sys/block/nvme0n1/queue/scheduler

# Tighten WBT target to 500µs to protect reads from writeback saturation
echo 500 > /sys/block/nvme0n1/queue/wbt_lat_usec

# Disable readahead for random access patterns
echo 0 > /sys/block/nvme0n1/queue/read_ahead_kb
```

---

### Container/Cloud Host with Many Tenants

A host running many containers with independent workloads needs per-device bandwidth isolation and high file descriptor limits.

```bash
# Moderate dirty limits — predictable flushing across many writeback streams
echo 10 > /proc/sys/vm/dirty_ratio
echo 5  > /proc/sys/vm/dirty_background_ratio
echo 300 > /proc/sys/vm/dirty_writeback_centisecs

# High fd limits for many concurrent containers
echo 10000000 > /proc/sys/fs/file-max
echo 10000000 > /proc/sys/fs/nr_open

# High inotify limits for container runtimes and monitoring agents
echo 1048576 > /proc/sys/fs/inotify/max_user_watches
echo 4096    > /proc/sys/fs/inotify/max_user_instances

# AIO for containers running databases
echo 1048576 > /proc/sys/fs/aio-max-nr

# mq-deadline for fair multi-tenant I/O
echo mq-deadline > /sys/block/nvme0n1/queue/scheduler
```

---

## Quick Reference

### Identifying the Current Dirty State

```bash
# Current dirty, writeback, and available memory
grep -E 'Dirty|Writeback|MemFree|MemTotal' /proc/meminfo

# Writeback statistics (look for pdflush_proc_nr_dirtied, pgpgout, etc.)
grep -E 'nr_dirty|nr_writeback|pgpgout' /proc/vmstat
```

### Finding the BDI Name for a Device

```bash
# Map block device to BDI
ls -l /sys/class/bdi/ | grep -v total
# Or: read the uevent
cat /sys/block/sda/dev      # prints major:minor, e.g., 8:0
ls /sys/class/bdi/8:0/      # that is the BDI entry
```

### Monitoring I/O Scheduler Effectiveness

```bash
# Per-device I/O statistics
iostat -xz 1

# Scheduler queue depth and latency (requires blktrace)
blktrace -d /dev/nvme0n1 -o - | blkparse -i -

# Current queue parameters
for f in scheduler nr_requests read_ahead_kb rotational wbt_lat_usec; do
    printf "%-25s %s\n" "$f" "$(cat /sys/block/nvme0n1/queue/$f 2>/dev/null)"
done
```

### Persisting Changes

**sysctl (vm.* and fs.*):**

```bash
# /etc/sysctl.d/99-io-tuning.conf
vm.dirty_ratio = 5
vm.dirty_background_ratio = 1
vm.dirty_writeback_centisecs = 200
fs.file-max = 2000000
fs.nr_open = 2000000
fs.aio-max-nr = 1048576
```

Apply immediately: `sysctl --system`

**Block layer (sysfs):** Use a udev rule to apply settings when the device appears:

```
# /etc/udev/rules.d/60-block-tuning.rules
ACTION=="add|change", KERNEL=="nvme[0-9]*n[0-9]*", \
    ATTR{queue/scheduler}="mq-deadline", \
    ATTR{queue/nr_requests}="1024", \
    ATTR{queue/read_ahead_kb}="0"

ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", \
    ATTR{queue/scheduler}="bfq", \
    ATTR{queue/read_ahead_kb}="2048", \
    ATTR{queue/nr_requests}="32"
```

Apply without reboot: `udevadm control --reload && udevadm trigger --type=devices --action=change`

---

## Tips

- **Check before changing**: always record the current value (`sysctl vm.dirty_ratio`) before modifying it so you can roll back.
- **Monitor effects**: watch `/proc/vmstat` (particularly `nr_dirty`, `nr_writeback`, `pgpgout`) and `iostat -xz` after changing writeback parameters to confirm the expected behavior.
- **Bytes vs. ratios**: on machines with more than 64 GiB of RAM, prefer `dirty_bytes` / `dirty_background_bytes` over the ratio variants. A 10% dirty ratio on a 1 TiB server is 100 GiB of dirty data — far more than most workloads need.
- **Scheduler interaction**: changing `read_ahead_kb` affects both the block layer and the per-file readahead window. Applications can override readahead per file descriptor with `posix_fadvise(POSIX_FADV_RANDOM)` or `POSIX_FADV_SEQUENTIAL`.
- **Container awareness**: `vm.*` and `fs.*` sysctls are host-global. Containers see the host values. Per-container I/O control is handled through cgroup v2 `io.max` and `io.weight` (see [I/O cgroup controls](io-priorities.md)).
- **Kernel version matters**: `kyber` was added in 4.12; `bfq` was merged in 4.12; `wbt_lat_usec` in 4.10. Verify scheduler availability with `cat /sys/block/<dev>/queue/scheduler` before scripting.
