# War Stories: I/O CVEs

> Security vulnerabilities discovered in the Linux I/O stack — what was exploitable, why, and what changed

The Linux I/O stack handles data movement between userspace and storage. This path involves privilege boundaries, memory mapping, and kernel-managed buffers — all potential surfaces for privilege escalation, information disclosure, and data confusion attacks.

---

## CVE-2016-10229: `recvmmsg` double-free via UDP with MSG_PEEK

**CVSS: 9.8 (Critical) | Affected: v4.5 and earlier | Fixed: v4.5-rc7 ([commit a2e2725](https://git.kernel.org/linus/a2e2725541fa))**

### The vulnerability

`recvmmsg(2)` receives multiple messages from a socket in a single system call. It supports `MSG_PEEK` to peek at data without consuming it from the socket buffer. The vulnerability was in how UDP handled `MSG_PEEK` when `recvmmsg` was called.

When `MSG_PEEK` is used with UDP, the kernel reads the datagram into the caller's buffer but does not remove it from the socket receive queue — it remains for the next call. The implementation temporarily allocated a `struct msghdr` and an `iov` for the peek operation, then freed them after copying the data.

The bug: under a specific timing condition where a UDP datagram arrived during the peek operation, the kernel could free the same `struct msghdr` twice — a double-free in the network I/O path.

### Exploitability

Double-free vulnerabilities in the kernel can be exploited to overwrite kernel memory. An attacker who could trigger the double-free could:
1. Free a kernel object
2. Cause the freed memory to be reallocated for a sensitive structure
3. Use the second free to corrupt that structure
4. Escalate privileges to root

The attack required the ability to open UDP sockets and call `recvmmsg` with `MSG_PEEK`, which is available to unprivileged users. A local user on a shared system could exploit this to gain root.

### Why it happened

`MSG_PEEK` duplicates data without consuming the socket buffer. The duplicated path had subtly different lifetime management for its allocated structures compared to the non-peek path. The race condition required a datagram to arrive at a specific point in the `recvmmsg` processing, but this could be induced by an attacker controlling the sender.

### Fix

The fix ([commit a2e2725](https://git.kernel.org/linus/a2e2725541fa)) restructured the buffer allocation to avoid the double-free condition by ensuring the allocated structures were freed exactly once regardless of the peek path taken.

### What it taught us

**I/O syscalls that duplicate data need careful lifetime management.** The peek-vs-consume distinction in socket I/O creates two code paths with different ownership semantics for the same data. Any divergence in how allocated structures are freed is a potential double-free.

---

## CVE-2019-11487: `pipe_write` reference count overflow via large writes

**CVSS: 7.8 (High) | Affected: v2.6.15 – v5.0 | Fixed: v5.1 ([commit 15fab63](https://git.kernel.org/linus/15fab63e1e57))**

### The vulnerability

Each page in a pipe's ring buffer has a reference count. When a process writes to a pipe, the page is allocated and its refcount is incremented. When a reader consumes data, the refcount is decremented and the page is freed when it reaches zero.

The reference count was stored as an `atomic_t` — a 32-bit signed integer. By writing to a pipe a very large number of times without reading, an attacker could cause the reference count of a page to overflow from the maximum positive value (`INT_MAX`) back to a negative number, and then through zero — triggering a premature free of the page.

When the page was freed while still referenced by the pipe, subsequent writes or reads could access freed memory. By controlling the allocation that reuses the freed page, an attacker could read kernel memory or corrupt kernel data structures.

### Exploitability

The attack required writing to a pipe roughly 2³¹ times to overflow the 32-bit counter — approximately 2 billion writes. While this sounds impractical, the writes could be very small (1 byte each), and the pipe could be configured with a large buffer (`F_SETPIPE_SZ`). On a fast system, 2 billion syscalls is feasible over several minutes.

The exploit was demonstrated in practice for privilege escalation from a container or unprivileged user to root. It was one of the vulnerabilities used in the Dirty Pipe-adjacent research.

### Why it happened

The reference count was `atomic_t` (32-bit) rather than `atomic64_t` (64-bit). For most kernel objects, 32-bit reference counts are safe because physical memory constraints mean no object can be referenced 2³¹ times simultaneously. But pipes are different: a single pipe page can be referenced by many writes without consuming much memory — each write increments the refcount of the same underlying page.

### Fix

Changed the pipe page reference count to `atomic64_t` ([commit 15fab63](https://git.kernel.org/linus/15fab63e1e57)). The counter can now accommodate 2⁶³ references before overflow — functionally infinite for any real workload.

### What it taught us

**Reference count sizes must account for workload-specific amplification.** For most kernel objects, 32-bit reference counts are safe. For I/O buffers (pipe pages, socket buffers) that can be referenced many times by a single file descriptor, the assumption fails. The reference count type should be chosen based on the maximum realistic reference count for that specific object, not on a general "32 bits is enough" assumption.

---

## CVE-2022-0847: Dirty Pipe — unprivileged write to read-only files via pipe splicing

**CVSS: 7.8 (High) | Affected: v5.8 – v5.16 | Fixed: v5.16.11, v5.15.25, v5.10.102 ([commit 9d2231c](https://git.kernel.org/linus/9d2231c5d74e))**

### The vulnerability

This vulnerability, discovered and named by Max Kellermann in February 2022, allowed an unprivileged local user to overwrite the contents of any file — including read-only files owned by root — by abusing the `pipe` and `splice` system calls.

The root cause was a missing initialization of the `PIPE_BUF_FLAG_CAN_MERGE` flag in a new pipe buffer allocation. When this flag was set, subsequent writes to the pipe could merge into the same page that the pipe buffer was pointing to — even if that page had been brought into the pipe via `splice` from a read-only file.

### The exploit path

1. **Open a target file** (e.g., `/etc/passwd`) for reading.
2. **Create a pipe** and fill it with data to initialize the pipe pages.
3. **Drain the pipe** — but the pipe page ring remains allocated, and the `PIPE_BUF_FLAG_CAN_MERGE` flag remains set on the pipe pages (this is the bug: the flag should have been cleared on drain).
4. **Splice** data from the target read-only file into the pipe. The splice attaches the file's page cache page to the pipe buffer.
5. **Write** to the pipe. Because `PIPE_BUF_FLAG_CAN_MERGE` is set, the write merges into the page cache page brought in by splice — which is the page cache page of the read-only file. The write goes directly to the page cache, bypassing the file's permissions and any write protection.
6. The file's page cache page now contains the attacker's data. Any subsequent read of the file returns the attacker's data.

```
Normal splice semantics:
pipe ──splice──> [page cache page of /etc/passwd] (read-only reference)
                 Writes go to new pipe pages, not to the file page.

Dirty Pipe semantics (bug):
pipe with CAN_MERGE flag ──splice──> [page cache page of /etc/passwd]
Write to pipe ──merges into──> [page cache page of /etc/passwd]
                               File content modified in-kernel!
```

### Why it happened

The `PIPE_BUF_FLAG_CAN_MERGE` flag was introduced in v5.8 as part of the large read/write optimization. When a pipe buffer is partially full and a new write arrives, `CAN_MERGE` allows the write to append to the existing page rather than allocating a new page — reducing allocator pressure for large sequential writes through pipes.

The bug: when a pipe was drained (all data read out), the pages were returned to the page pool for reuse, but their flags — including `CAN_MERGE` — were not reset. When `splice()` then attached a file's page cache page to the pipe buffer (reusing a drained page), the `CAN_MERGE` flag was still set. The subsequent write saw `CAN_MERGE` and merged into the file's page cache page instead of allocating a new pipe page.

The code path in `fs/pipe.c` that handled pipe buffer recycling omitted the flag reset:

```c
/* Before fix: flags were not cleared on page reuse */
static void pipe_buf_release(struct pipe_inode_info *pipe,
                              struct pipe_buffer *buf)
{
    /* buf->flags still contains PIPE_BUF_FLAG_CAN_MERGE from previous use */
}

/* After fix: flag cleared in pipe_write when new buffer is prepared */
buf->flags &= ~PIPE_BUF_FLAG_CAN_MERGE;
```

### Impact

Dirty Pipe was highly impactful because:

1. **Exploitable by any local user** — no special capabilities needed, only the ability to open files for reading.
2. **Works on read-only files** — `/etc/passwd`, SUID binaries, container image layers.
3. **Works on files in read-only filesystems** (overlayfs lower layers) — containers could modify their own base image files.
4. **No disk modification** — changes are only in the page cache. The file on disk is unmodified. After a drop of caches or a reboot, the file returns to its original state. This made it useful for transient privilege escalation without leaving persistent traces.

Demonstrated exploits included: modifying `/etc/passwd` to add a root user (no password), overwriting SUID binaries (e.g., `su`, `passwd`) with a shell wrapper, and escaping container restrictions by modifying base image files.

### Fix

The fix ([commit 9d2231c](https://git.kernel.org/linus/9d2231c5d74e)) added an explicit clear of the `CAN_MERGE` flag when a pipe buffer is prepared for a splice operation, ensuring that spliced pages cannot be merged into by subsequent writes.

Additionally, the `prepare_pipe_buf` callback for the `page_cache_pipe_buf_ops` was modified to never set `CAN_MERGE`, since page cache pages should never be the target of a pipe write merge.

### What it taught us

**Security flags must be cleared on resource reuse.** The `CAN_MERGE` flag controlled a security-critical behavior (whether writes could go to a page that came from another source). Reusing a buffer without resetting its flags is the same pattern as a use-after-free for flag state — the new user sees stale state from the previous owner.

**Optimization flags in I/O paths need security review.** `CAN_MERGE` was introduced for performance. It was never intended to interact with `splice()` in a way that bypassed file permissions. Performance optimizations in I/O paths should be reviewed for interactions with privilege-sensitive operations like splice, which mixes data from different sources with different permission models.

**The page cache is a trust boundary.** Page cache pages belong to specific files with specific permissions. Any path that allows writing to a page cache page must respect the file's permissions — not just the caller's file descriptor flags.

---

## CVE-2023-2163: eBPF verifier — out-of-bounds read via I/O map access

**CVSS: 8.2 (High) | Affected: v5.4 – v6.2 | Fixed: v6.3 ([commit 71b547f](https://git.kernel.org/linus/71b547f))**

### The vulnerability

The eBPF verifier statically analyzes BPF programs before they run to ensure they cannot access memory out of bounds. For BPF programs that access maps (including I/O maps used for tracing I/O operations), the verifier tracked the range of possible values for each register.

The vulnerability was an imprecision in the verifier's range tracking for certain bitwise operations combined with pointer arithmetic. The verifier computed a too-wide range — it believed the register could contain values from A to B when in fact it could only contain values from A to C (where C < B). The verifier then allowed memory access up to B when the actual access could reach B — which was beyond the intended bounds.

For I/O tracing programs that mapped kernel structures, this could allow:
- **Out-of-bounds reads** of kernel memory adjacent to the map
- **Kernel ASLR bypass** by reading kernel pointers
- As a step toward privilege escalation via further exploitation

### Why it happened

The BPF verifier tracks value ranges as intervals `[min, max]`. Operations that affect ranges (shifts, ANDs, additions) must update these intervals conservatively — the post-operation interval must contain all possible values. The bug was in the handling of a specific combination of instructions where the interval became more conservative than needed on one side but less conservative on the other, producing an asymmetric — and incorrect — interval.

The incorrect interval then propagated through subsequent pointer arithmetic and was used to bound-check a memory access: the verifier approved an access that could exceed the actual bounds.

### Fix

The fix tightened the interval propagation for the affected instruction sequence and added regression tests that specifically tested the verifier's range tracking for that instruction pattern.

### What it taught us

**Formal verification of the verifier.** Following this and related BPF verifier vulnerabilities, the Linux community invested in formal verification tools for BPF range tracking. The `ebpf-analyzer` and related projects aim to formally verify that the verifier's interval arithmetic is correct for all instruction sequences — a class of tool that testing alone cannot provide.

**Defensive depth for BPF.** Even with a verifier, BPF programs run with direct kernel access. Defense-in-depth measures (seccomp filtering of `bpf(2)`, `CAP_BPF` capability requirements, restricting access to unprivileged BPF via `kernel.unprivileged_bpf_disabled=1`) reduce the attack surface when the verifier has bugs.

---

## CVE-2024-0646: `io_uring` file descriptor leak via IORING_OP_CONNECT

**CVSS: 7.8 (High) | Affected: v6.4 – v6.6 | Fixed: v6.6.2 ([commit 3f66f8](https://git.kernel.org/linus/3f66f8))**

### The vulnerability

`io_uring`'s `IORING_OP_CONNECT` operation connects a socket asynchronously. Internally, it takes a reference to the socket's file descriptor to keep it alive while the operation is in flight. If the connect operation was cancelled after the reference was taken but before the connection completed, the reference was not always released correctly — producing a file descriptor leak.

A leaked file descriptor reference keeps the underlying socket (and associated kernel memory) alive indefinitely, even after the userspace file descriptor is closed. With sufficient iterations, an attacker could exhaust the system's file handle limit, causing `ENFILE` errors for all processes attempting to open files.

In addition to denial of service, the leaked reference could be used in a use-after-free scenario if the socket's internal state was modified after the "close" that the attacker believed had released all references.

### Why it happened

`io_uring` operations that hold kernel references during asynchronous execution must carefully manage reference counts across all cancellation and completion paths. The connect operation was added with a reference management model that handled normal completion correctly but missed the case where a cancel arrived after the reference was taken but before the connect syscall returned.

The reference increment happened in one function (`io_connect_prep`) and the paired decrement was in `io_connect_complete`. A cancel operation bypassed `io_connect_complete` and called a cleanup function that did not include the paired decrement.

### Fix

The fix added an explicit reference release in the cancel path, and added assertions (`WARN_ON_ONCE`) for the reference count state at cancellation entry to catch future mistakes.

### What it taught us

**Async I/O cancellation paths are under-tested.** io_uring's cancellation infrastructure covers many operations, but the reference management through cancellation requires careful auditing for each new operation type. Cancellation paths are exercised far less frequently in practice and in tests than the normal completion path.

**io_uring's complexity requires structured review.** io_uring's power comes from its ability to handle arbitrary combinations of operations asynchronously. This flexibility makes it a large attack surface. Since its introduction in v5.1, io_uring has been the source of multiple CVEs. Mitigations include restricting io_uring access in security-sensitive environments (`io_uring_disabled` sysctl, seccomp filter rules blocking `io_uring_setup`).

---

## Related pages

- [War Stories: Data Loss](war-stories-data-loss.md) — data integrity failures
- [War Stories: I/O Regressions](war-stories-regressions.md) — performance regressions
- [splice, sendfile, and Zero-Copy](splice-sendfile.md) — the splice mechanism (Dirty Pipe's attack surface)
- [io_uring Architecture](../io-uring/io-uring-arch.md) — io_uring design and security model
- [io_uring Security](../io-uring/security.md) — io_uring threat model and mitigations
