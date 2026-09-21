# io_uring Security and Hardening

> Attack surface, seccomp bypass, CVEs, and production lockdown

## The attack surface

io_uring executes async operations from a kernel worker thread pool called **io-wq**. When an operation cannot complete inline (blocking read, file open, etc.), the kernel queues it to an io-wq thread. That thread runs with the credentials of the submitting task — the same UID, GID, capabilities, and open file table — but it runs **outside the normal syscall path**.

This matters because every kernel security hook designed around the syscall boundary becomes irrelevant for io-wq execution:

- **seccomp filters** are evaluated at syscall entry; io-wq threads perform equivalent operations without making a syscall from userspace
- **ptrace**-based sandboxes observe system calls; io-wq work is invisible to them
- **audit rules** keyed on syscall numbers may not fire for async paths
- the **personality** field in an SQE allows submitting operations under a *different registered credential*, which is a legitimate feature but widens the attack surface considerably

The io-wq path through `io_uring/io-wq.c` and the core submission machinery in `io_uring/io_uring.c` form a large, complex state machine. Subtle lifetime bugs and type confusions in that state machine have been the source of several privilege-escalation CVEs.

The gap goes deeper than just the io-wq thread pool. seccomp's BPF program runs from a specific hook in the syscall entry path (`secure_computing()`, invoked from arch entry code before a syscall's number and arguments are dispatched) — io-wq worker execution never passes through that entry path at all, so there is no check for it to bypass; the code path the check lives in simply isn't entered. The same gap applies to the submission model itself, independent of io-wq: `io_uring_enter` lets userspace batch an arbitrary number of future operations as opaque binary SQEs into a shared-memory ring, which the kernel then consumes asynchronously. A monitor built strictly around the syscall boundary — seccomp, ptrace — has no equivalent point to intercept once per *operation* inside that ring, only once per `io_uring_enter` call covering however many operations were batched. LSM hooks are different: they mediate at the point of object access (opening a file, a socket operation), so they still fire for work an io-wq thread performs — which is why SELinux and AppArmor were able to add `io_uring`-specific object classes covering credential sharing (`personality`/`override_creds`) and SQPOLL rather than needing a wholesale redesign. `IORING_REGISTER_RESTRICTIONS` fills a narrower gap: an allowlist a trusted component can apply before handing a ring to untrusted code, independent of whichever LSM (if any) is active.

## seccomp and io_uring

A process can install a strict seccomp filter that allows almost no syscalls, then use io_uring to perform those same operations asynchronously. The kernel does not re-evaluate the submitting process's seccomp policy when an io-wq thread executes the work.

```
Userspace (seccomp: deny openat) ──► io_uring_enter ──► SQE: IORING_OP_OPENAT
                                                              │
                                          ┌───────────────────┘
                                          │  io-wq thread
                                          │  (no seccomp check)
                                          ▼
                                      do_filp_open()   ← opens the file
```

`IORING_SETUP_SQPOLL` makes this worse: a dedicated kernel polling thread drains the SQ ring continuously, so the process does not even need to call `io_uring_enter` (a syscall that *could* be blocked by seccomp) after the ring is set up.

Without `IORING_SETUP_SQPOLL` (the default), there is no dedicated polling thread, but io-wq threads still bypass seccomp for async work that cannot complete inline.

`IORING_SETUP_SINGLE_ISSUER` (Linux 6.0) restricts submission to the one thread that created the ring, but does not change the seccomp bypass property.

The practical consequence: **seccomp alone is not a sufficient sandbox for processes that have access to an io_uring file descriptor**. Android, Chrome OS, and gVisor each restrict io_uring for untrusted code as a result, though not all by the same mechanism (see below).

## Restrictions added over time

The kernel has progressively tightened io_uring's privilege boundaries:

| Version | Change |
|---------|--------|
| 5.10 | `IORING_REGISTER_RESTRICTIONS` — whitelist the opcodes and registration operations a ring is allowed to use |
| 6.0 | `IORING_SETUP_SINGLE_ISSUER` — only one thread may submit SQEs to the ring |
| 6.1 | `IORING_SETUP_DEFER_TASKRUN` — defers task-work completions until an explicit `io_uring_enter(GETEVENTS)` call, instead of running them as soon as they're ready (requires `IORING_SETUP_SINGLE_ISSUER`; cannot be combined with `IORING_SETUP_SQPOLL`) |

`IORING_SETUP_DEFER_TASKRUN` is useful for latency-sensitive submission threads that want to control when completion processing happens, rather than having it interrupt whatever the thread is doing. It doesn't change io-wq usage either way — blocking operations that can't complete inline are still offloaded to io-wq threads regardless of this flag.

## `IORING_REGISTER_RESTRICTIONS`

After setting up a ring, a privileged component can **lock it down** before handing the ring fd to an untrusted component. The `IORING_REGISTER_RESTRICTIONS` registration call (`io_uring_register(2)`) accepts an array of `struct io_uring_restriction` entries. Once applied, restrictions are permanent for the lifetime of the ring — they cannot be removed.

Restriction types:

| Type | Effect |
|------|--------|
| `IORING_RESTRICTION_REGISTER_OP` | Allow only the specified `IORING_REGISTER_*` operation |
| `IORING_RESTRICTION_SQE_OP` | Allow only the specified `IORING_OP_*` opcode in SQEs |
| `IORING_RESTRICTION_SQE_FLAGS_ALLOWED` | Mask of SQE flags userspace is allowed to set |
| `IORING_RESTRICTION_SQE_FLAGS_REQUIRED` | Mask of SQE flags that must be set on every SQE |

The implementation lives in `io_uring/rsrc.c` (resource registration) and `io_uring/io_uring.c` (`io_uring_register` dispatch and restriction enforcement).

### Example: handing a restricted ring to an untrusted component

```c
#include <linux/io_uring.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <string.h>
#include <stdint.h>

/* Wrapper — liburing provides io_uring_register() but this shows the raw call */
static int uring_register(int ring_fd, unsigned opcode, void *arg, unsigned nr_args)
{
    return (int)syscall(__NR_io_uring_register, ring_fd, opcode, arg, nr_args);
}

int setup_restricted_ring(unsigned sq_entries)
{
    struct io_uring_params params;
    memset(&params, 0, sizeof(params));

    /*
     * IORING_SETUP_SINGLE_ISSUER: only the creating thread may submit.
     * IORING_SETUP_DEFER_TASKRUN: defer completions to an explicit
     *   io_uring_enter(GETEVENTS) call instead of running them eagerly;
     *   does not affect whether io-wq is used, and cannot be combined
     *   with IORING_SETUP_SQPOLL.
     * SINGLE_ISSUER requires Linux 6.0; DEFER_TASKRUN requires 6.1 and
     *   also requires SINGLE_ISSUER, so using both needs Linux 6.1.
     */
    params.flags = IORING_SETUP_SINGLE_ISSUER |
                   IORING_SETUP_DEFER_TASKRUN;

    int ring_fd = (int)syscall(__NR_io_uring_setup, sq_entries, &params);
    if (ring_fd < 0)
        return ring_fd;

    /* Build the restriction list */
    struct io_uring_restriction restrictions[] = {
        /* Only allow IORING_OP_READ and IORING_OP_WRITE */
        {
            .opcode     = IORING_RESTRICTION_SQE_OP,
            .sqe_op     = IORING_OP_READ,
        },
        {
            .opcode     = IORING_RESTRICTION_SQE_OP,
            .sqe_op     = IORING_OP_WRITE,
        },
        /* Only allow IOSQE_IO_LINK and IOSQE_ASYNC on any SQE — anything
         * else, including IOSQE_FIXED_FILE and IOSQE_IO_DRAIN, is rejected */
        {
            .opcode             = IORING_RESTRICTION_SQE_FLAGS_ALLOWED,
            .sqe_flags          = IOSQE_IO_LINK | IOSQE_ASYNC,
        },
    };

    int ret = uring_register(ring_fd, IORING_REGISTER_RESTRICTIONS,
                              restrictions,
                              sizeof(restrictions) / sizeof(restrictions[0]));
    if (ret < 0) {
        close(ring_fd);
        return ret;
    }

    /*
     * ring_fd is now locked: any SQE with an opcode other than READ or
     * WRITE, or with disallowed flags, will be rejected with -EACCES.
     * Hand ring_fd to the untrusted component.
     */
    return ring_fd;
}
```

After `IORING_REGISTER_RESTRICTIONS` is applied, the kernel checks each SQE against the restriction bitmap in `io_ring_ctx->restrictions` on the hot submission path. Attempts to use a disallowed opcode or flag return `-EACCES`.

## CVEs and kernel hardening

The complexity of the io_uring state machine — cancellation, timeouts, linked requests, fixed buffers, registered credentials — creates a large surface for subtle memory-safety bugs:

**CVE-2022-29582** — use-after-free in io_uring timeout handling (`fs/io_uring.c`, before the 6.0 split into the `io_uring/` directory). A race between `io_flush_timeouts()` and linked-timeout cancellation, triggered by combining `IORING_OP_TIMEOUT` and `IORING_OP_LINK_TIMEOUT` in a linked SQE chain, allowed a local attacker to escalate privileges. Fixed in Linux 5.17.3 / 5.15.34 (also backported to 5.10.111). CVSS 7.0.

**CVE-2023-2598** — missing consecutiveness check in fixed buffer registration's huge-page optimization. When registering a buffer via `IORING_REGISTER_BUFFERS`, the kernel assumed that pages belonging to the same folio were physically contiguous and coalesced them into a single bvec entry — but userspace can map the same page repeatedly, so that assumption didn't hold, giving out-of-bounds access to physical memory beyond the buffer. The bug was introduced in 6.3-rc1 and fixed in 6.3.2 (mainline 6.4) — kernels 6.3.0 and 6.3.1 shipped with it. The affected code was in `io_uring/rsrc.c:io_sqe_buffer_register()`.

**General pattern**: most io_uring CVEs share the same shape — a refcount, lifetime, or size calculation goes wrong in the async teardown path, turning a freed object into an exploitable primitive. The combination of multiple io-wq threads, user-controlled lifetimes, and shared kernel objects is inherently difficult to reason about.

Staying on a recent kernel is the most effective mitigation. The io_uring subsystem receives security fixes backported to stable trees, but only for a limited window.

## Android, Chrome OS, and gVisor restrictions

Each of these platforms restricts io_uring for untrusted code. Android and Chrome OS cite sandboxing difficulty explicitly; gVisor's support remains experimental and limited by default:

**Android**: since a June 2023 announcement, Google blocks io_uring for regular apps — "our seccomp-bpf filter ensures that io_uring is unreachable to apps" — after io_uring accounted for roughly 60% of the kernel exploits submitted to Google's kCTF vulnerability-reward program over the preceding year. AOSP's sepolicy grants io_uring access only to a small set of system processes, such as `fastbootd` and `snapuserd`.

**Chrome OS**: disabled io_uring while exploring better sandboxing options, per the same 2023 announcement — not a Chrome-sandbox seccomp-bpf policy scoped to specific process types.

**gVisor**: `io_uring_setup` and `io_uring_enter` have a partial implementation, off by default and limited to basic I/O operations when enabled; `io_uring_register` is unimplemented and returns `ENOSYS`.

**Linux Security Modules**: SELinux gained an `io_uring` object class with dedicated LSM hooks in Linux 5.16; AppArmor added its own io_uring mediation much later, in Linux 6.7. Policy can deny `sqpoll` (spawning the SQPOLL kernel thread) and `override_creds` (using the `personality` field to run ops under alternate credentials) independently of the general io_uring access.

```
# SELinux: forbid SQPOLL thread creation for confined_t
neverallow confined_t self:io_uring sqpoll;

# AppArmor: deny credential override
deny io_uring override_creds,
```

## Best practices for production

**Minimize flags**

- Default: omit `IORING_SETUP_SQPOLL` unless polling latency is critical and the process is trusted. SQPOLL spawns a kernel thread that runs continuously with the process's credentials.
- Use `IORING_SETUP_SINGLE_ISSUER` (Linux 6.0+) for any ring accessed from a single submission thread.
- Use `IORING_SETUP_DEFER_TASKRUN` (Linux 6.1+) alongside `IORING_SETUP_SINGLE_ISSUER` to control when completion processing runs, rather than having it interrupt the submission thread as soon as results are ready. It does not reduce io-wq usage on its own.

**Lock down rings in sandboxed contexts**

Apply `IORING_REGISTER_RESTRICTIONS` immediately after `io_uring_setup`, before handing the ring fd to any untrusted code. Restrict to the minimum set of opcodes the component needs. This limits the blast radius of a compromised component even if the kernel has an unpatched vulnerability.

**Seccomp policy**

If the process does not need io_uring at all, block `io_uring_setup` in the seccomp filter. If the process creates a ring during initialization and then drops privileges, block `io_uring_setup` after ring creation — this prevents a compromised process from creating additional, unrestricted rings.

**Avoid `personality` (registered credentials) unless necessary**

The `personality` field in an SQE allows operations to run under a pre-registered credential set (`IORING_REGISTER_PERSONALITY`). This is a powerful feature that is easy to misuse. Restrict its use with `IORING_RESTRICTION_REGISTER_OP` to prevent registration of new personalities after the ring is set up.

**Monitor with audit**

The kernel audit subsystem emits records for `io_uring_setup` and `io_uring_register`. In environments with auditd or a SIEM ingesting audit logs, rules on these event types surface unexpected ring creation or capability registration.

## Further reading

- [Architecture and Rings](io-uring-arch.md) — SQ/CQ layout, SQE/CQE structures
- [Operations and Advanced Features](io-uring-ops.md) — Supported ops, SQPOLL, fixed buffers
- `io_uring/io_uring.c` — core submission path and restriction enforcement
- `io_uring/rsrc.c` — fixed buffer and credential registration, CVE-2023-2598 site
- `io_uring/io-wq.c` — worker thread pool implementation
- `include/uapi/linux/io_uring.h` — `IORING_RESTRICTION_*` constants and `struct io_uring_restriction`
- [Auditing io_uring](https://lwn.net/Articles/858023/) — LWN article on adding LSM and audit hooks to io_uring
- [CVE-2022-29582 writeup](https://ruia-ruia.github.io/2022/08/05/CVE-2022-29582-io-uring/) — detailed exploitation analysis
