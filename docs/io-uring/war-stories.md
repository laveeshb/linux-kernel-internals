# War Stories: io_uring Bugs and Incidents

> Real vulnerabilities, crashes, and behavioral surprises from io_uring's first years — what broke, why, and what the kernel learned

io_uring arrived in Linux 5.1 (May 2019) as the most significant I/O interface redesign in the kernel's history. It replaced the syscall-per-operation model with a shared-memory ring that lets applications submit and harvest completions without entering the kernel on the fast path. The design achieved real throughput gains — hundreds of thousands of IOPS on NVMe with near-zero syscall overhead — but it also introduced a subsystem of substantial complexity: asynchronous worker threads with independent lifetimes, user-controlled kernel object registration, cancellation state machines, and timeout chains.

That complexity has produced a steady stream of bugs. This page documents four well-documented incidents: two privilege-escalation CVEs with publicly analyzed root causes, a kernel panic caused by an interaction with CPU hotplug, and a seccomp bypass that led Android, Chrome OS, and gVisor to disable io_uring for untrusted code. A fifth section covers a correctness trap — CQ ring overflow — that does not make headlines but silently corrupts application behavior.

These are not theoretical risks. Each caused real harm in production: privilege escalation, kernel panics, data loss, or wholesale disabling of the feature across major platforms.

---

## Case 1: CVE-2022-29582 — use-after-free in the fixed file table

### Before state

io_uring supports *fixed files*: the application registers an array of file descriptors with `IORING_REGISTER_FILES`, and subsequent SQEs reference them by index rather than by fd. The kernel holds a reference-counted array of `struct file *` pointers — `io_ring_ctx->file_data` — and each in-flight operation increments a reference on the relevant slot before use and decrements it on completion.

The registration and update path lives in `io_uring/rsrc.c`. File slots can be updated dynamically via `IORING_REGISTER_FILES_UPDATE`, which replaces individual entries in the array while operations may be in flight on existing entries.

Prior to the fix, the code that handled file updates under concurrent operation teardown had a race window.

### The trigger

The vulnerability was a race between two concurrent paths:

1. An in-flight operation completing (or being cancelled) and releasing its reference to a fixed file slot.
2. A `IORING_REGISTER_FILES_UPDATE` call arriving while that release was in progress.

The update path checked whether a slot was "in use" before replacing it, but the check and the actual replacement were not atomic with respect to the concurrent release. A carefully timed `IORING_REGISTER_FILES_UPDATE` could cause the slot to be replaced — freeing the old `struct file *` — at the same moment that another path was still holding a reference to it and had not yet finished using it.

The result was a use-after-free on the `struct file` object. The freed object remained partially valid for long enough (the `f_op` pointer was often still readable) that the corruption was exploitable as a local privilege escalation primitive.

### Observed behavior

From a user's perspective, no error was visible during normal operation. The race was narrow but not too narrow to hit reliably: exploit tooling documented in the Qualys advisory could trigger the condition repeatedly by racing `io_uring_enter` (to drive completions) against `io_uring_register` with `IORING_REGISTER_FILES_UPDATE`.

On an unpatched kernel the bug could be reached by any local user with the ability to create an io_uring ring — no special capability required. The CVSS score was 7.8 (High). The vulnerability affected kernels from the introduction of fixed files through 5.17.2, and was also present in the 5.15 LTS tree through 5.15.33.

### Why it happened — kernel internals

The lifetime of a fixed file slot had two relevant reference counts:

- A **per-slot reference** (`io_fixed_file_set` inside the `io_rsrc_data` structure) counting how many in-flight operations hold a borrow on that slot.
- The **normal `struct file` reference count** (`file->f_count`), which io_uring incremented when it installed the file and decremented when it removed it.

The race window was in the transition between "operation is done using the slot" and "slot is safe to replace." The operation decrement happened in the completion path, which runs on an io-wq thread. The update path ran on the syscall thread calling `io_uring_register`. The update path read the per-slot reference count and, if it appeared zero, proceeded to swap out the `struct file *` pointer. But the completion path could decrement the reference count to zero *after* the update path had read it as nonzero — or conversely, the completion path could decrement to zero and then stall, while the update path observed zero and freed the file before the completion path had actually finished referencing it.

The fix required ensuring that the update path and the completion path could not race on the same slot: the update needed to wait for all in-flight borrows on a slot to drain before replacing it, using proper memory ordering barriers and a deferred-free mechanism (RCU or a similar grace period) rather than a racy check-then-act sequence.

```
Thread A (io-wq, completing op)        Thread B (syscall, REGISTER_FILES_UPDATE)
───────────────────────────────────    ──────────────────────────────────────────
read slot->file  // still valid
                                       read slot->refcount  // see 0
                                       kfree(slot->file)    // file is freed
use slot->file   // UAF here
decrement slot->refcount
```

The kernel code involved was `io_uring/rsrc.c`, specifically the fixed file registration, update, and teardown functions.

### Resolution

The fix tightened the lifetime contract between the update path and the completion path. The update path was changed to use a deferred replacement: rather than immediately freeing the old file when the reference count appeared zero, it scheduled the actual `fput` through a mechanism that guaranteed all concurrent accessors had completed. The reference counting around slot borrow/release was also corrected to use appropriate atomic operations with the right ordering.

CVE-2022-29582 was fixed in:

- Linux **5.17.3** (mainline stable)
- Linux **5.15.34** (LTS backport)
- Linux **5.10.111** (LTS backport)

The fix was not backported to 5.4 LTS because the fixed-file update feature introduced the race did not exist in that tree in the same form.

A detailed public exploitation analysis was published by Qualys, demonstrating full local privilege escalation to root on a default Ubuntu installation. The writeup is referenced in [Further reading](#further-reading).

### What it taught us

**Dynamic update paths on shared kernel objects require careful synchronization.** Fixed files introduced an optimization (avoiding per-operation `fget`/`fput` overhead by pre-registering files) but the update mechanism needed to reason carefully about objects that could be in use on other threads. The pattern — "check reference count, if zero then free" — is unsafe without proper barriers and is a recurring source of UAF bugs in concurrent kernel code.

**io_uring's wide syscall accessibility amplifies the impact of local vulnerabilities.** Unlike older async I/O interfaces that required elevated privileges or large ring buffer setups, io_uring rings can be created by ordinary user processes with a single `io_uring_setup` syscall. A local privilege escalation in io_uring is therefore reachable from any sandboxed context that has not specifically blocked `io_uring_setup`.

!!! warning "Pattern to watch for"
    Any kernel component that maintains a registered array of kernel objects that can be updated while in-flight operations hold references to those objects faces this class of race. The canonical safe pattern is: mark the slot as "pending replacement," drain all current users via a reference counting mechanism with proper ordering, then perform the replacement. Check-then-act without atomicity is not safe.

---

## Case 2: CVE-2023-2598 — integer overflow in fixed buffer registration

### Before state

io_uring supports *fixed buffers*: the application calls `io_uring_register` with `IORING_REGISTER_BUFFERS` to pre-register a set of user-space memory regions with the kernel. The kernel pins the pages, maps them into the io_uring context, and subsequent read/write operations that reference these buffers by index (`IORING_OP_READ_FIXED`, `IORING_OP_WRITE_FIXED`) can skip the per-operation `get_user_pages` overhead.

The registration code in `io_uring/rsrc.c` accepts a `struct iovec` array from userspace: each entry specifies a base address and length. The kernel must compute the total number of pages that need to be pinned across all buffer entries to determine how much memory to allocate for the internal accounting structures.

### The trigger

When computing the total page count across all registered buffers, the registration code summed page counts per buffer. The page count per individual buffer was calculated by dividing the buffer length by `PAGE_SIZE` (with alignment handling). The accumulation was done in a variable that was not wide enough — it could overflow when the sum of pages across all registered buffers exceeded `UINT_MAX` (on 32-bit paths) or when specific alignment edge cases were hit.

An attacker could register a set of buffers whose total page count wrapped around to a small value. The kernel would then allocate an internal page accounting array sized for the small (overflowed) count, but subsequent operations would access that array as if it were sized for the true, larger count — producing an out-of-bounds write into kernel memory.

### Observed behavior

The bug was not externally visible during registration. `IORING_REGISTER_BUFFERS` returned success. The corruption manifested later, during operations that used the fixed buffers, when the undersized internal array was accessed past its end.

On an unpatched kernel, a local user could craft a set of buffer registrations whose combined page count overflowed the accumulator, then use `IORING_OP_READ_FIXED` or `IORING_OP_WRITE_FIXED` to trigger the out-of-bounds access. This is a memory-corruption primitive usable for privilege escalation.

The affected kernel versions spanned from the introduction of fixed buffers (Linux 5.1) through **Linux 6.2**. The fix landed in **Linux 6.3**.

### Why it happened — kernel internals

The core of the overflow was in the page-counting path inside `io_sqe_buffers_register()` in `io_uring/rsrc.c`. Each buffer's page count was computed correctly in isolation, but the accumulator holding the running total was either a `u32` or was used in a context where it could wrap. The subsequent `kvmalloc` call for the internal `struct io_mapped_ubuf` array was sized based on the number of buffers (not the total page count), but the page-tracking bookkeeping array that relied on the total count was what overflowed.

A simplified view of the problematic pattern:

```c
// Pseudocode illustrating the vulnerable shape (not literal kernel code)
u32 total_pages = 0;
for (int i = 0; i < nr_bufs; i++) {
    unsigned long npages = (iov[i].iov_len + PAGE_SIZE - 1) >> PAGE_SHIFT;
    total_pages += npages;  // can overflow if sum > UINT_MAX
}
// Allocate internal array sized for total_pages
// ... but total_pages has wrapped to a small value
struct page **pages = kvmalloc_array(total_pages, sizeof(*pages), GFP_KERNEL);
// Subsequent use writes past the end of pages[]
```

The fix changed the accumulator to `size_t` (or equivalent unsigned long) and added an explicit overflow check that returns `-EINVAL` if the total page count would exceed `ULONG_MAX` or a configured maximum. It also added validation that each individual buffer's length does not exceed reasonable bounds before accumulation.

### Resolution

The fix in Linux 6.3 corrected the type of the accumulator and added bounds checks that reject registration calls whose total page count exceeds a safe limit. Importantly, the check was added *before* any allocation, so a crafted registration simply returns an error rather than allocating an undersized structure.

The fix was backported to the 6.1 and 5.15 LTS trees. Systems running kernels before 6.3 (or the relevant LTS backport versions) should be considered vulnerable if local unprivileged users have access to `io_uring_setup`.

The source of the vulnerability — `io_uring/rsrc.c:io_sqe_buffers_register()` — is the same file implicated in CVE-2022-29582, highlighting that fixed resource registration paths have been a consistent source of bugs.

### What it taught us

**Integer overflow in size calculations before memory allocation is one of the most common classes of kernel vulnerability.** The pattern is well-known: if you compute `n * sizeof(T)` or `sum(sizes)` without overflow checking and then allocate based on the result, an overflow turns a large allocation intent into a small allocation with a large subsequent access. The fix is always the same: use `size_add`/`size_mul` overflow-checking helpers (or equivalent explicit checks) before any allocation whose size derives from user-supplied inputs.

**Registration paths deserve the same scrutiny as execution paths.** io_uring bugs often live in the `io_uring_register` paths — fixed file registration, buffer registration, credential registration — rather than in the hot SQE submission path. These registration paths handle complex user-supplied arrays and perform multi-step kernel object setup, but they receive less fuzz coverage because they are called once at setup time rather than thousands of times per second.

!!! warning "Pattern to watch for"
    Any kernel code that accepts a user-supplied count or array of lengths and accumulates them before a single allocation is a candidate for this bug class. Linux provides `array_size()`, `size_add()`, and `check_add_overflow()` helpers precisely for this purpose. When reviewing io_uring registration code, look for accumulations of user-supplied lengths without these helpers.

    ```c
    // Safe pattern using kernel overflow-checking helpers
    size_t total;
    if (check_add_overflow(existing_total, new_pages, &total))
        return -EINVAL;
    ```

---

## Case 3: SQPOLL thread crash on CPU hotplug

### Before state

`IORING_SETUP_SQPOLL` creates a dedicated kernel thread — the SQ polling thread — whose sole job is to poll the submission ring in a tight loop, draining SQEs without requiring the application to make `io_uring_enter` syscalls. This is the lowest-latency submission path: the application writes SQEs into the shared ring and the kernel thread picks them up within its poll interval.

The SQPOLL thread is bound to a CPU when the ring is created. If `IORING_SETUP_SQ_AFF` is specified, the thread is pinned to a particular CPU via `sq_thread_cpu` in `struct io_uring_params`. If unspecified, it runs on whatever CPU the creating process was on at setup time.

CPU hotplug is the Linux mechanism for taking CPUs online or offline at runtime — used in cloud environments for power management, in NUMA systems for topology changes, and by hypervisors when adjusting vCPU counts for running VMs.

### The trigger

When a CPU is taken offline (`CPU_DOWN` notifier chain), all threads running on that CPU must be migrated to other CPUs. The kernel's CPU hotplug infrastructure sends notifications to subsystems that have per-CPU threads or state, giving them an opportunity to migrate or quiesce before the CPU is removed from the scheduler's runqueue set.

io_uring's SQPOLL thread did not properly register with the CPU hotplug notification chain in early implementations. When the CPU the SQPOLL thread was bound to was taken offline, the thread had nowhere to migrate. Depending on the kernel version and the exact hotplug sequence, the result ranged from the SQPOLL thread stalling (stopping processing SQEs while appearing alive) to a kernel BUG() or NULL pointer dereference when the scheduler tried to place the thread on a CPU that no longer existed in the active set.

The problem was particularly acute when `IORING_SETUP_SQ_AFF` had pinned the thread to a specific CPU: the thread had an explicit CPU affinity mask containing only the now-offline CPU, and the scheduler could not migrate it anywhere.

### Observed behavior

In cloud environments that perform live CPU hotplug — either for power efficiency (offline unused vCPUs) or during live migration — SQPOLL rings created before a hotplug event would start misbehaving afterward. SQEs written to the ring were not processed; the application appeared to submit work but no completions arrived. In more severe cases, a kernel panic occurred during the hotplug sequence itself when the CPU removal attempted to quiesce threads it could not migrate.

The issue was intermittent because it depended on SQPOLL rings being active at the moment of a CPU offline event, which in turn depended on workload timing and the hotplug policy of the specific platform.

The bug was reported and traced through kernel commit logs in discussions of SQPOLL robustness, and fixes were applied across the 5.x kernel series.

### Why it happened — kernel internals

The SQPOLL thread was created with `kthread_create_on_cpu()` or equivalent, which pins the thread to a specific CPU at creation time. The CPU affinity was set unconditionally and was not updated when that CPU went offline.

Linux CPU hotplug proceeds in phases via the `cpuhp_setup_state` mechanism. Subsystems that need to react to CPU removal register callbacks at specific phases. If a subsystem does not register a hotplug callback, the kernel makes a best-effort attempt to migrate any threads, but threads with explicit CPU affinity masks that have become invalid cannot be migrated to a valid CPU automatically — the affinity mask must be updated first.

The SQPOLL thread also held state (`struct io_sq_data`) that referenced the CPU number it was scheduled on. Some code paths read this CPU number for scheduling decisions without validating that the CPU was still online, producing accesses that could fault or produce incorrect behavior.

The fix required:

1. Registering a CPU hotplug state callback in the io_uring SQPOLL path that fires when a CPU is being taken offline.
2. In that callback, either migrating the SQPOLL thread to another CPU (by updating its affinity mask to a valid set) or — if the thread was pinned via `IORING_SETUP_SQ_AFF` to a specific CPU that is going offline — signaling an error condition to the ring and waking any blocked submitters.
3. Ensuring that the CPU number stored in SQPOLL state structures was validated before use or updated atomically during hotplug transitions.

### Resolution

The kernel patches that addressed SQPOLL CPU hotplug handling added io_uring to the `cpuhp_setup_state` infrastructure with appropriate prepare and cleanup callbacks. The SQPOLL thread's CPU affinity handling was also hardened: on systems where the pinned CPU goes offline, the thread migrates to the nearest available CPU rather than becoming unschedulable.

Applications that use `IORING_SETUP_SQ_AFF` to pin the SQPOLL thread to a specific CPU should be aware that on systems with dynamic CPU topology (cloud VMs, systems using `cpupower` to offline cores), the pinned CPU may not remain available. The SQPOLL hotplug fix was integrated without a dedicated feature flag; a kernel version check is the appropriate way to verify this fix is present. There is no specific flag in `io_uring_params.features` for SQPOLL hotplug safety — other available feature flags such as `IORING_FEAT_NODROP` are unrelated to this fix.

For applications that do not strictly require a specific CPU affinity for the SQPOLL thread, omitting `IORING_SETUP_SQ_AFF` is the safer choice: the kernel assigns the thread to a CPU and manages migration automatically.

### What it taught us

**Kernel threads with CPU affinity must participate in the hotplug notifier chain.** The CPU hotplug infrastructure requires active cooperation: subsystems cannot assume that a CPU they depend on will remain online. This is a known requirement for device drivers and subsystems that maintain per-CPU state, but it was not fully handled in io_uring's initial SQPOLL implementation.

**Performance features that depend on specific system topology create robustness obligations.** SQPOLL's value proposition is low-latency submission via CPU-local polling. Delivering that property correctly requires handling all the ways the topology can change: CPU hotplug, CPU frequency scaling, NUMA rebalancing, and scheduler migration. The initial implementation optimized for the fast path and did not fully account for these transitions.

**Cloud environments exercise code paths that dedicated hardware tests do not.** CPU hotplug in the middle of a running workload is uncommon on physical servers but routine in cloud environments (vCPU resizing, live migration, power management). Bugs that require this specific sequence go undetected in normal testing and appear only in production cloud deployments.

!!! warning "Pattern to watch for"
    If a SQPOLL ring stops processing SQEs after a CPU topology change (hotplug, VM resize), check whether the SQPOLL thread is still running (`ps aux | grep io_uring`) and whether it has a valid CPU affinity (`taskset -p <pid>`). An affinity mask of `0x0` or containing only offline CPUs indicates the thread is stuck. Recreating the ring after the topology change is the workaround on unpatched kernels. Ensure the running kernel includes SQPOLL hotplug fixes before using `IORING_SETUP_SQ_AFF` in environments with dynamic CPU topology.

---

## Case 4: io_uring as a seccomp bypass — restrictions in Android, Chrome OS, and gVisor

### Before state

seccomp-bpf is the standard Linux mechanism for syscall filtering in sandboxes. A process installs a BPF program that is evaluated at the syscall entry point (`seccomp_run_filters`). For every syscall the process makes, the BPF program decides whether to allow it, return an error, or kill the process. This is the foundation of the sandbox in Chrome, Android apps, Flatpak applications, and container runtimes.

The model is straightforward: work happens inside syscalls, syscalls go through the filter, the filter enforces the policy. Historically this was a sound assumption.

### The trigger

io_uring broke the assumption. When a process submits an `IORING_OP_OPENAT` SQE, the kernel does not immediately open the file in the context of the submitting process's syscall. Instead, if the operation cannot complete inline, it is queued to an io-wq worker thread. That thread then calls `do_filp_open()` directly — it executes the equivalent of `openat`, but from within the kernel, not through the syscall entry path. seccomp filters are evaluated at syscall entry; they are never invoked for work performed by io-wq threads.

The consequence is that a process running under a strict seccomp policy that blocks `openat`, `read`, `write`, `connect`, and virtually every other syscall can still perform those operations by submitting them as io_uring SQEs. The io-wq thread, which runs with the process's UID, GID, capabilities, and open file table, carries out the operation without the seccomp filter ever being consulted.

`IORING_SETUP_SQPOLL` makes this worse. With SQPOLL, the application does not need to call `io_uring_enter` after setup — it just writes SQEs into the shared ring memory. Since `io_uring_enter` is the one syscall that could be blocked by seccomp to prevent ring usage after setup, SQPOLL eliminates even that chokepoint. An application that sets up a ring before installing its seccomp filter (or that passes a ring fd across a trust boundary) retains full I/O capability with no syscall surface for the filter to act on.

### Observed behavior

The bypass was not a single incident with a single discoverer. It was noticed independently by multiple security researchers examining io_uring's interaction with sandboxing infrastructure, and was documented publicly in the Linux security community around 2022-2023.

The practical impact: any seccomp-based sandbox that allowed `io_uring_setup` (or that handed an already-created ring fd to a sandboxed process) could be bypassed for I/O operations. This affected:

- **Android**: app processes are subject to strict seccomp filters via Bionic's seccomp policy tables. An app that created an io_uring ring (or received a ring fd from another component) could perform arbitrary I/O regardless of its seccomp policy.
- **Chrome OS**: renderer and GPU process sandboxes use seccomp-bpf to restrict syscalls available to potentially malicious web content. io_uring provided a path around those restrictions.
- **gVisor**: the gVisor sentry intercepts all syscalls from guest processes to enforce its security model. io_uring's async execution model is fundamentally incompatible with sentry-level interposition — io-wq threads do not issue guest syscalls that the sentry can intercept.

### Why it happened — kernel internals

The seccomp model has always assumed that interesting work happens through the syscall gate. For 30 years, that assumption held: if you blocked the syscall, you blocked the capability. io_uring created a new execution path that performs equivalent work through a kernel-internal route that bypasses the gate.

The structural issue is in `io_uring/io-wq.c`. When an io-wq worker thread picks up a work item, it calls `io_wq_worker_running()` and proceeds to invoke the operation's handler directly (e.g., `io_openat()`, `io_read()`, `io_write()`). These handlers call the same VFS and network stack functions that syscall handlers call, but they do so without going through `syscall_enter_from_user_mode()` — and therefore without invoking `seccomp_run_filters()`.

The kernel's own documentation acknowledges the issue. There is no simple in-kernel fix that would cause io-wq threads to re-evaluate the submitting process's seccomp policy, because the io-wq thread is a separate kernel thread that does not "belong to" the submitting process in the way a normal syscall does. Retrofitting seccomp evaluation onto io-wq work items would require either re-evaluating the filter on the io-wq thread (which changes the semantics of seccomp policies and breaks existing correct uses) or adding a new seccomp mode specifically for async work (which adds complexity and has its own risks).

The LSM hooks added in Linux 5.12 for io_uring (`security_uring_override_creds`, `security_uring_sqpoll`, `security_uring_cmd`) help SELinux and AppArmor enforce coarser-grained policy (e.g., deny SQPOLL thread creation) but do not provide syscall-level filtering.

### Resolution

The platforms affected chose restriction over mitigation:

**Android 12 and later**: `io_uring_setup` is blocked by the default seccomp policy for untrusted app processes in Bionic's seccomp filter tables (`SCMP_ACT_ERRNO`). The change was introduced because the Android security team determined that the seccomp bypass risk outweighed the performance benefit for app processes. Privileged system processes (with different seccomp policies) may still use io_uring.

**Chrome OS**: the Chrome browser's sandbox policies for renderer, GPU, and utility processes were updated to block `io_uring_setup`. The policies are maintained in the Chromium source tree in the seccomp policy files for each process type.

**gVisor**: `io_uring_setup` returns `ENOSYS` by default in gVisor containers. The gVisor team's position is that supporting io_uring would require the sentry to emulate the full io-wq execution model, which is not architecturally feasible without fundamentally changing how gVisor interposes on kernel operations.

**In the upstream kernel**, `IORING_SETUP_DEFER_TASKRUN` (Linux 6.1) reduces the attack surface for the SQPOLL-specific vector: with `DEFER_TASKRUN`, completions run on the submitting thread rather than on io-wq threads, meaning no separate kernel threads are spawned for completion processing. However, `DEFER_TASKRUN` does not eliminate the async io-wq path for all operations — blocking operations still go through io-wq.

The effective mitigation for seccomp-based sandboxes remains: **block `io_uring_setup` in the seccomp policy if the process does not need it**. If the process creates a ring during initialization and then drops privileges, block `io_uring_setup` after ring creation to prevent creation of additional unrestricted rings.

```
# The only fully effective mitigation for seccomp sandboxes
# is to prevent creation of new rings in the sandboxed process:

seccomp policy rule: SCMP_SYS(io_uring_setup) -> SCMP_ACT_ERRNO(ENOSYS)
```

### What it taught us

**New I/O models require re-examination of security abstractions, not just addition of new hooks.** seccomp worked by controlling the syscall gate. io_uring bypassed the gate entirely for async work. The correct response was not to add io_uring-specific syscall hooks on top of seccomp — it was to recognize that the security model needed updating. Android, Chrome OS, and gVisor made the pragmatic choice: if the new interface cannot be secured within the existing model, restrict access to it.

**Performance-oriented kernel features have broader security implications than they initially appear.** io_uring was designed by I/O engineers optimizing for throughput. The seccomp implications were not the focus of the initial design. Security properties of kernel features need to be evaluated explicitly, not assumed to follow from the general syscall model.

**Capability restriction is not the same as behavioral restriction.** A process that has been seccomp-filtered to deny `openat` retains the *kernel capability* to open files (it has the right UID, file permissions, etc.). seccomp restricts the *interface*, not the *capability*. io_uring exposed this distinction by providing a second interface to the same underlying capability.

!!! warning "Pattern to watch for"
    If a seccomp-sandboxed process shows unexpected file system or network activity that does not correspond to any syscalls visible in strace output, suspect an io_uring ring is in use. The activity will appear in kernel tracing (`bpftrace`, `opensnoop`, `tcpconnect`) but not in strace because strace observes syscall entry/exit and io-wq work bypasses the syscall path. Check `/proc/<pid>/fdinfo` for file descriptors of type `io_uring` or use `lsof` to list io_uring ring fds.

    ```bash
    # Detect io_uring rings held by a process
    ls -la /proc/<pid>/fd | grep -v ' -> /'
    grep 'io_uring' /proc/<pid>/fdinfo/*

    # Trace io_uring operations without strace
    bpftrace -e 'tracepoint:io_uring:io_uring_submit_sqe { printf("%s(%d): op=%d\n", comm, pid, args->opcode); }'
    ```

---

## Case 5: CQ ring overflow and silent completion loss

### Before state

io_uring's completion model is built around the CQ ring: a power-of-two circular buffer of `struct io_uring_cqe` entries (completion queue entries) mapped into both kernel and user address space. The kernel writes completions into the ring by advancing the tail pointer; the application reads them by advancing the head pointer. As long as the application reads completions at least as fast as the kernel produces them, the ring never fills.

The CQ ring size is set at `io_uring_setup` time. The default is twice the SQ ring size (`cq_entries = sq_entries * 2`). Alternatively, `IORING_SETUP_CQSIZE` allows specifying a larger CQ at setup time.

### The trigger

If the application does not drain the CQ ring fast enough — or if a burst of completions arrives faster than the application can read them — the ring fills. The kernel cannot write new CQEs into a full ring because it cannot advance the tail past the head.

This is not a hypothetical: it happens in production when:

- An application submits many requests in bulk and then performs a batch of unrelated work before harvesting completions.
- The SQPOLL thread continues submitting work even while the application is sleeping or blocked elsewhere.
- A large number of linked requests (`IOSQE_IO_LINK`) complete in rapid succession.
- A timeout or cancellation storm produces many completions simultaneously.

### Observed behavior

When the CQ ring fills, the kernel does not block waiting for space. Instead, it increments an overflow counter in `io_ring_ctx` and — in older kernel versions — dropped the CQE on the floor entirely. In newer versions (Linux 5.9+), the kernel attempts to cache overflowed CQEs in an internal list (`io_ring_ctx->cq_overflow_list`) and flushes them to the ring when space becomes available.

The consequence of the older behavior was straightforward: completions were silently dropped. An application waiting for N operations to complete would never receive some of their completions. Depending on the application's design, this caused:

- Permanent hangs: a coroutine or thread waiting on a completion that was dropped would never wake.
- Incorrect state: a buffer the application considered "in flight" would remain considered in flight forever, eventually exhausting the buffer pool.
- Resource leaks: file descriptors or registered buffers that were supposed to be released on completion would never be released.

The newer overflow-list behavior does not drop completions, but it introduces backpressure: the kernel will not let the application submit new SQEs while the overflow list is non-empty. New submissions return `-EBUSY` or are silently not processed until the backlog is drained. An application that does not check `io_uring_enter`'s return value or does not check for the `IORING_CQ_OVERFLOW` bit in `sq_flags` could submit work that the kernel quietly holds, mistaking a stalled ring for a normally operating one.

### Why it happened — kernel internals

The overflow handling went through several iterations as the kernel learned what "correct" behavior should be:

**Linux 5.1–5.8**: Overflow CQEs were dropped. The `cq_overflow` counter in `struct io_uring` (the user-visible shared ring structure) was incremented, but many applications did not check it. The only indication to the application was the incrementing counter at `*(uint32_t *)(cqring + cqring->overflow_offset)` — a field that most application code copied from examples that did not inspect it.

**Linux 5.9**: The kernel added an internal overflow list. Instead of dropping overflowed CQEs, they are placed in `io_ring_ctx->cq_overflow_list`. The `IORING_CQ_OVERFLOW` flag is set in the CQ ring flags (`cqring->flags`). Submissions are refused with `-EBUSY` (or silently queued, depending on submission flags) until the application drains the CQ ring enough to flush the overflow list.

**Linux 5.10+**: `io_uring_enter` with the `IORING_ENTER_GETEVENTS` flag will automatically flush the overflow list before returning events, ensuring that completions in the overflow list are visible to the application as long as it uses `io_uring_enter` for event harvesting.

The root cause was a design tension: the CQ ring is a lock-free structure. The kernel writes completions by advancing the CQ tail with a store-release, and the application reads them by advancing the CQ head. There is no mutual exclusion. If the ring is full, the kernel has nowhere to write without overwriting unread entries — a destructive operation. The original implementation chose to drop rather than block (dropping is always safe for lock-free completion; blocking would require synchronization).

### Resolution

The behavioral fix is in the kernel (5.9+), but the application-side fix requires active participation:

**Check for overflow before and after harvesting completions:**

```c
#include <liburing.h>

void drain_completions(struct io_uring *ring, int min_complete)
{
    struct io_uring_cqe *cqe;
    unsigned head;
    int count = 0;

    /*
     * Check for CQ overflow before reading completions.
     * If IORING_CQ_OVERFLOW is set, the kernel has completions
     * buffered internally that need to be flushed.
     */
    if (IO_URING_READ_ONCE(*ring->cq.kflags) & IORING_CQ_OVERFLOW) {
        /*
         * Calling io_uring_enter with IORING_ENTER_GETEVENTS
         * flushes the overflow list. liburing's io_uring_submit_and_wait
         * does this automatically; if calling io_uring_enter directly,
         * ensure IORING_ENTER_GETEVENTS is set.
         */
        io_uring_get_events(ring);
    }

    io_uring_for_each_cqe(ring, head, cqe) {
        /* process cqe->res, cqe->user_data, cqe->flags */
        count++;
    }
    io_uring_cq_advance(ring, count);
}
```

**Size the CQ ring appropriately at setup time:**

```c
struct io_uring_params params;
memset(&params, 0, sizeof(params));

/*
 * Request a larger CQ ring to absorb completion bursts.
 * Default is sq_entries * 2; for bursty workloads, use 4x or 8x.
 */
params.flags = IORING_SETUP_CQSIZE;
params.cq_entries = sq_entries * 8;

int ring_fd = syscall(__NR_io_uring_setup, sq_entries, &params);
```

**Monitor the overflow counter:**

```c
/*
 * The overflow counter is the number of completions that have
 * overflowed since the ring was created. It only increments
 * on kernels older than 5.9 (where they are dropped); on 5.9+
 * the counter increments but completions are preserved in the
 * overflow list. A non-zero value on any kernel version means
 * the application is not draining the CQ ring fast enough.
 */
uint32_t overflow = IO_URING_READ_ONCE(*ring->cq.koverflow);
if (overflow > last_overflow) {
    fprintf(stderr, "io_uring CQ overflow: %u completions delayed\n",
            overflow - last_overflow);
    last_overflow = overflow;
}
```

### What it taught us

**Lock-free data structures require explicit backpressure handling.** The CQ ring's lock-free design is what makes io_uring fast, but lock-free rings do not have a natural backpressure mechanism. The application must ensure it drains the ring faster than the kernel fills it, or use a larger ring. This is a design constraint that must be communicated clearly to application authors — and it was not, in io_uring's early documentation.

**"Set and forget" API semantics do not compose with bounded buffers.** Many event loop frameworks assume that submitting work and checking for completions are independent concerns. With io_uring, they are coupled: if the completion loop falls behind, the submission loop must slow down. Applications that submit aggressively without draining aggressively will encounter CQ overflow on any hardware, given sufficient load.

**Silent failure is worse than loud failure.** The initial behavior — dropping completions and incrementing a counter that few applications checked — was worse than returning an error from the submission call would have been. An application that receives `-ENOSPC` from `io_uring_enter` knows it needs to drain the ring. An application whose completions were silently dropped has no indication anything is wrong until its workload hangs.

!!! warning "Pattern to watch for"
    Hangs in applications using io_uring where submitted operations never complete, combined with the `cq_overflow` counter in `/proc/<pid>/fdinfo/<ring_fd>` being non-zero, indicate CQ ring overflow. Check the ring's `cq_entries` size versus the depth of concurrent operations at peak load. On kernels before 5.9, some completions may have been permanently lost; on 5.9+, they are queued and will be flushed once the ring has space.

    ```bash
    # Check io_uring ring state for a running process
    # ring_fd is the file descriptor number of the io_uring ring
    cat /proc/<pid>/fdinfo/<ring_fd>
    # Look for:
    #   sq_entries:  <n>     -- submission queue depth
    #   cq_entries:  <n>     -- completion queue depth
    #   cq_overflow: <n>     -- non-zero means overflow has occurred
    #   sq_dropped:  <n>     -- SQEs dropped due to invalid submission
    ```

---

## Common threads

These five incidents share a set of structural patterns worth recognizing:

| Pattern | CVE-2022-29582 (UAF) | CVE-2023-2598 (overflow) | SQPOLL hotplug | seccomp bypass | CQ overflow |
|---------|----------------------|--------------------------|----------------|----------------|-------------|
| Root in resource registration path | Yes | Yes | No | No | No |
| Concurrent access / race condition | Yes | No | Yes | No | Yes |
| Missed interaction with external subsystem | No | No | Yes (hotplug) | Yes (seccomp) | No |
| Silent failure mode | No | No | Partial | Yes | Yes |
| Fixed by kernel alone | Yes | Yes | Yes | No (policy) | Partial |
| Requires application-side hardening | No | No | Partial | Yes | Yes |

The recurring lesson: io_uring's complexity is not primarily in its hot path — the SQE submission loop and CQE harvest loop are straightforward. The complexity is in the lifecycle management of registered resources (files, buffers, credentials), the interaction with external kernel subsystems (seccomp, CPU hotplug, scheduler), and the behavior at the boundaries of normal operation (overflow, cancellation, teardown).

Bugs in io_uring tend to be discovered not through fuzzing the normal path but through exercising edge cases: races during teardown, integer boundary conditions during registration, topology changes after setup, and application behavior when the kernel pushes back.

---

## See also

- [Security and Hardening](security.md) — Attack surface, seccomp bypass, CVE overview, and lockdown patterns
- [Architecture and Rings](io-uring-arch.md) — SQ/CQ layout, SQE/CQE structures, and the submission model
- [Operations and Advanced Features](io-uring-ops.md) — Fixed buffers, SQPOLL, and the operations involved in several of these bugs
- [Fixed Buffers](fixed-buffers.md) — Fixed buffer registration (the CVE-2023-2598 code path)
- [Life of a Request](life-of-request.md) — How SQEs become io-wq work items (the async path underlying the seccomp bypass)

---

## External references

- [CVE-2022-29582 — NVD entry](https://nvd.nist.gov/vuln/detail/CVE-2022-29582) — Affected versions and CVSS scoring
- [Qualys CVE-2022-29582 exploitation writeup](https://www.qualys.com/2022/05/02/cve-2022-29582/lpe-io-uring.txt) — Detailed analysis of the UAF and privilege escalation technique
- [CVE-2023-2598 — NVD entry](https://nvd.nist.gov/vuln/detail/CVE-2023-2598) — Fixed buffer integer overflow
- [Security topics: io_uring, VM attestation, and random-reseed notifications](https://lwn.net/Articles/943239/) — LWN coverage of Google's "safe only for use by trusted components" stance and the `kernel.io_uring_disabled` sysctl
- [Auditing io_uring](https://lwn.net/Articles/858023/) — LWN article on adding LSM and audit hooks to io_uring
- [io_uring/rsrc.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/io_uring/rsrc.c) — Fixed file and buffer registration (site of both CVE-2022-29582 and CVE-2023-2598)
- [io_uring/io-wq.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/io_uring/io-wq.c) — Worker thread pool (async execution path underlying the seccomp bypass)
- [io_uring man page](https://man7.org/linux/man-pages/man7/io_uring.7.html) — `io_uring_params`, ring flags, and feature bits

## Further reading

- [security.md](security.md) — Full treatment of the seccomp bypass (Case 4), `IORING_REGISTER_RESTRICTIONS`, and per-platform lockdown decisions
- [fixed-buffers.md](fixed-buffers.md) — How fixed buffer registration works and the performance trade-offs that made the CVE-2023-2598 code path attractive to attackers
- [life-of-request.md](life-of-request.md) — The complete lifecycle from SQE write to CQE harvest, including the io-wq offload path that bypasses seccomp
- [liburing documentation](https://github.com/axboe/liburing) — The reference userspace library; `io_uring_get_events()` and overflow handling are documented in the API reference
- [io_uring.c changelog in kernel git](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/log/io_uring/io_uring.c) — Commit history showing the progression of security fixes and overflow handling improvements
