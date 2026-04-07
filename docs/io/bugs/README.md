# I/O Subsystem Bugs (Kernel)

> A catalog of notable Linux kernel I/O bugs, vulnerabilities, and edge cases

This index covers bugs in the Linux kernel's I/O stack — spanning VFS, the page cache, writeback, the block layer, and device drivers. These are real kernel bugs analyzed for educational purposes: what broke, why, and what the kernel learned.

---

## Quick Reference

### By Severity

| Severity | Count | Examples |
|----------|-------|---------|
| **Critical (CVE, exploitable)** | 10+ | Dirty Pipe, pipe refcount overflow, recvmmsg double-free |
| **Data loss / corruption** | 8+ | ext4 data=writeback, O_DIRECT coherency, fsync+rename, errseq_t |
| **Performance regression** | 6+ | Dirty throttling v3.1, CFQ→BFQ, cgroup writeback v4.2 |
| **Deadlock / hang** | 4+ | writeback deadlock, NFS hard-mount hang, io_uring cancel hang |

### By Year

| Year | Notable Bugs |
|------|-------------|
| 2024 | io_uring fd leak (CVE-2024-0646), FUSE writeback deadlock |
| 2023 | eBPF verifier I/O map OOB (CVE-2023-2163), XFS log recovery corruption |
| 2022 | Dirty Pipe (CVE-2022-0847), io_uring UAF via linked timeouts |
| 2021 | io_uring SQPOLL CPU stall, writeback cgroup double-free |
| 2020 | io_uring corking regression (v5.8), page cache truncation race |
| 2019 | pipe reference count overflow (CVE-2019-11487) |
| 2016 | recvmmsg double-free (CVE-2016-10229) |
| 2011–2013 | Dirty throttling regression (v3.1), THP + AIO latency |
| 2008–2012 | ext4 data=writeback stale data, fsync+rename directory loss |

---

## Detailed Bug Documentation

### War Stories (narrative format)

| Document | Category | Key Incidents |
|----------|----------|---------------|
| [War Stories: Data Loss](../war-stories-data-loss.md) | Data loss | ext4 writeback, O_DIRECT coherency, fsync+rename, errseq_t |
| [War Stories: Regressions](../war-stories-regressions.md) | Performance | Dirty throttling v3.1, CFQ→BFQ, cgroup writeback, io_uring corking |
| [War Stories: CVEs](../war-stories-cves.md) | Security | CVE-2016-10229, CVE-2019-11487, Dirty Pipe, io_uring fd leak |

---

## Bug Categories

### Data Loss and Corruption

#### ext4 `data=writeback` — stale data after crash
- **Subsystem**: `fs/ext4/`, `fs/jbd2/`
- **Root cause**: Journal commits metadata without waiting for data writeback. Reused blocks contain previous file's data after crash.
- **Affected**: All ext4 versions with `data=writeback`
- **Fix**: Do not use `data=writeback` without application-level `fsync()`. Use `data=ordered` (default).
- **Full analysis**: [War Stories: Data Loss §1](../war-stories-data-loss.md#incident-1)

#### `O_DIRECT` + buffered I/O coherency race
- **Subsystem**: `fs/direct-io.c`, `mm/filemap.c`
- **Root cause**: `O_DIRECT` writes bypass page cache. Cache invalidation before DMA and DMA completion are not atomic — buffered readers can re-populate stale data in the window.
- **Affected**: All kernels; race window narrowed but not closed
- **Fix**: Never mix `O_DIRECT` and buffered I/O on the same file from different processes.
- **Full analysis**: [War Stories: Data Loss §2](../war-stories-data-loss.md#incident-2)

#### `fsync()` + `rename()` — directory entry lost after crash
- **Subsystem**: VFS, all local filesystems
- **Root cause**: `fsync(fd)` flushes file data and inode but not the parent directory. A crash before the directory pages are flushed leaves no directory entry pointing to the new file.
- **Affected**: All Linux filesystems; all kernels
- **Fix**: `fsync()` the parent directory fd after `rename()`.
- **Full analysis**: [War Stories: Data Loss §3](../war-stories-data-loss.md#incident-3)

#### Writeback errors silently dropped before v4.13
- **Subsystem**: `mm/filemap.c`, writeback
- **Root cause**: Writeback error stored as a clearable flag on the inode. Could be cleared by successful writeback of a different page. `fsync()` returned 0 even after a writeback failure.
- **Fixed**: v4.13 — `errseq_t` sequence tracking ([commit 5660e13d2fd5](https://git.kernel.org/linus/5660e13d2fd5))
- **Full analysis**: [War Stories: Data Loss §4](../war-stories-data-loss.md#incident-4)

---

### Performance Regressions

#### Dirty throttling rework — write latency spikes in v3.1
- **Subsystem**: `mm/page-writeback.c`
- **Root cause**: New proportional throttling algorithm with per-BDI bandwidth estimator. Estimator could underestimate available bandwidth, causing over-throttling. Thundering herd on threshold crossing.
- **Introduced**: v3.1. Stabilized over v3.2–v3.13.
- **Full analysis**: [War Stories: Regressions §1](../war-stories-regressions.md#regression-1)

#### CFQ→BFQ transition — latency regressions for mixed workloads
- **Subsystem**: `block/bfq-*.c`
- **Root cause**: BFQ's budget-based scheduling misfired on mixed sequential/random and on filesystems with internal journaling (ext4/jbd2 seen as separate processes).
- **Resolution**: Use `none` for NVMe, `mq-deadline` for SATA SSD, `bfq` for HDD with weighting.
- **Full analysis**: [War Stories: Regressions §2](../war-stories-regressions.md#regression-2)

#### Writeback cgroup integration — stalls for cgrouped workloads in v4.2
- **Subsystem**: `mm/backing-dev.c`, `mm/page-writeback.c`
- **Root cause**: Three-way interaction between per-cgroup dirty throttling, memcg reclaim, and cgroup-aware kworker scheduling produced latency spikes not visible in synthetic benchmarks.
- **Stabilized**: v4.5
- **Full analysis**: [War Stories: Regressions §3](../war-stories-regressions.md#regression-3)

#### io_uring O_DIRECT corking — read latency increase in v5.8
- **Subsystem**: `io_uring/io_uring.c`
- **Root cause**: Completion batching did not distinguish between read and write completions. Write batch corking delayed read completions by 50–100µs.
- **Fixed**: v5.10 ([commit 90696f](https://git.kernel.org/linus/90696f))
- **Full analysis**: [War Stories: Regressions §4](../war-stories-regressions.md#regression-4)

---

### Security Vulnerabilities (CVEs)

#### CVE-2016-10229 — `recvmmsg` double-free via MSG_PEEK
- **CVSS**: 9.8 Critical | **Subsystem**: `net/socket.c`
- **Root cause**: Double-free of `struct msghdr` in UDP `MSG_PEEK` path under race with incoming datagram.
- **Fixed**: v4.5-rc7 ([commit a2e2725](https://git.kernel.org/linus/a2e2725541fa))
- **Full analysis**: [War Stories: CVEs §1](../war-stories-cves.md)

#### CVE-2019-11487 — pipe reference count overflow
- **CVSS**: 7.8 High | **Subsystem**: `fs/pipe.c`
- **Root cause**: Pipe page reference count stored as `atomic_t` (32-bit). ~2³¹ writes overflows to negative, triggering premature page free.
- **Fixed**: v5.1 ([commit 15fab63](https://git.kernel.org/linus/15fab63e1e57)) — changed to `atomic64_t`
- **Full analysis**: [War Stories: CVEs §2](../war-stories-cves.md)

#### CVE-2022-0847 — Dirty Pipe (write to read-only files via splice)
- **CVSS**: 7.8 High | **Subsystem**: `fs/pipe.c`, `fs/splice.c`
- **Root cause**: `PIPE_BUF_FLAG_CAN_MERGE` not cleared on pipe page drain. Splice attaches file page cache page to pipe buffer; subsequent write merges into file's page cache, bypassing permissions.
- **Introduced**: v5.8 | **Fixed**: v5.16.11, v5.15.25, v5.10.102 ([commit 9d2231c](https://git.kernel.org/linus/9d2231c5d74e))
- **Full analysis**: [War Stories: CVEs §3](../war-stories-cves.md)

#### CVE-2023-2163 — eBPF verifier I/O map OOB read
- **CVSS**: 8.2 High | **Subsystem**: `kernel/bpf/verifier.c`
- **Root cause**: Imprecise interval tracking for bitwise operations + pointer arithmetic allowed out-of-bounds reads via BPF maps used in I/O tracing programs.
- **Fixed**: v6.3 ([commit 71b547f](https://git.kernel.org/linus/71b547f))
- **Full analysis**: [War Stories: CVEs §4](../war-stories-cves.md)

#### CVE-2024-0646 — io_uring file descriptor leak via IORING_OP_CONNECT
- **CVSS**: 7.8 High | **Subsystem**: `io_uring/net.c`
- **Root cause**: Reference not released in cancel path of async connect operation. Repeated exploitation exhausts system file handle limit.
- **Fixed**: v6.6.2 ([commit 3f66f8](https://git.kernel.org/linus/3f66f8))
- **Full analysis**: [War Stories: CVEs §5](../war-stories-cves.md)

---

## How to Use This Index

**For debugging a production issue**: Start with the category that matches your symptom — data loss, hang, or performance regression. The bug entries link to full narrative analysis with reproduction steps and mitigation commands.

**For security review**: The CVE table summarizes the exploitability, affected versions, and fixes. All listed CVEs have public fixes in the mainline kernel.

**For kernel development**: Each entry identifies the source file and the commit that fixed the issue. Reading the fix and the surrounding discussion on LKML provides insight into the design constraints that allowed the bug to exist.

---

## Related Pages

- [War Stories: Data Loss](../war-stories-data-loss.md)
- [War Stories: Regressions](../war-stories-regressions.md)
- [War Stories: CVEs](../war-stories-cves.md)
- [Debugging Data Corruption](../debugging-data-corruption.md)
- [Debugging I/O Hangs](../debugging-io-hangs.md)
- [io_uring Security](../../io-uring/security.md)
