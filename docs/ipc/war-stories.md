# IPC War Stories

> Leaked semaphores, fd exhaustion, signal storms, and pipe capacity surprises

Real-world IPC bugs share a common theme: the happy path works perfectly, but the error path, the slow consumer, or the edge case that only manifests after days of operation reveals a fundamental misunderstanding of how the kernel manages IPC resources. These are five real categories of incidents — the kind that show up in post-mortems.

---

## 1. The SysV semaphore leak

### What happened

A C++ application used SysV semaphores for inter-process locking. Each worker process called `semget(IPC_CREAT, ...)` on startup and `semctl(IPC_RMID)` on clean shutdown. In the error path — triggered when the backing database was unreachable — the code returned early before calling `IPC_RMID`.

After 48 hours of operation with periodic connection failures, `ipcs -s` showed 128 semaphore sets. The system `SEMMNI` limit had been reached. Subsequent worker startups received `ENOSPC` from `semget()`. The service was down.

```bash
# Diagnosis: count orphaned sets
ipcs -s | wc -l          # 131 (128 sets + 3 header lines)

# Identify orphaned sets by dead creator pid
ipcs -s -v | awk 'NR>3 {
    ret = system("kill -0 " $5 " 2>/dev/null")
    if (ret != 0) print "orphaned semid=" $2 " key=" $1
}'
```

### Root cause

SysV semaphore sets persist in kernel memory until `IPC_RMID` is called or the machine reboots. They have no association with any file descriptor or process lifetime. The kernel tracks them in the `ipc_ids` structure (`ipc/util.c`) keyed by a numeric ID — there is no automatic garbage collection.

### Fix

Two complementary changes:

1. **Immediate**: clean up manually with `ipcrm -s` for each leaked semid, then restart the service.

2. **Permanent**: use `SEM_UNDO` on all `semop()` calls so the kernel automatically reverses the operation if the process exits, and call `IPC_RMID` in a `SIGTERM`/`SIGINT` handler *and* in the normal error path.

Better still: migrate to POSIX named semaphores. `sem_unlink()` removes the name from the filesystem namespace; the semaphore object itself is destroyed when the last `sem_t` handle is closed — no persistent kernel object, no leak.

```c
/* POSIX named semaphore: automatic cleanup */
sem_t *sem = sem_open("/myapp-lock", O_CREAT | O_EXCL, 0600, 1);
/* ... use sem_wait() / sem_post() ... */
sem_close(sem);
sem_unlink("/myapp-lock");  /* name gone; object destroyed when last user closes */
```

---

## 2. The Unix socket fd leak via SCM_RIGHTS

### What happened

A privilege-separated daemon split into a privileged parent and an unprivileged worker. The parent opened sensitive files and passed their file descriptors to the worker via `SCM_RIGHTS` over a Unix domain socket (`SOCK_SEQPACKET`). The worker handled requests, used the fds, and was supposed to `close()` them after use.

A bug in the error-handling branch — triggered when the downstream service returned an unexpected status code — caused the worker to skip the `close()` call. Each failed request left one fd open. After several thousand requests, the worker process hit `EMFILE` (errno 24, "Too many open files"). New requests were rejected at the `recvmsg()` stage because the kernel could not install the incoming fd into the worker's table.

```bash
# Diagnosis
lsof -p <worker_pid> | wc -l        # thousands
lsof -p <worker_pid> | grep passwd  # many open copies of /etc/passwd
```

### Root cause

When `SCM_RIGHTS` delivers a file descriptor, the kernel calls `receive_fd()` (in `fs/file.c`), which allocates a new file descriptor in the receiver's `files_struct` via `alloc_fd()`. This is a full kernel-level `dup()` — the receiver's fd table grows by one per received fd, completely independently of the sender. The sender closing its copy has no effect on the receiver's copy.

In-flight `SCM_RIGHTS` fds are tracked per-`user_struct` (`user->unix_inflight`), not on `struct unix_sock` itself. Once delivered, the fd is solely the receiver's responsibility.

### Fix

Close received fds in every code path, including error paths. The pattern:

```c
int received_fd = -1;

/* ... recvmsg and extract received_fd ... */

int ret = process_request(received_fd);
/* close ALWAYS, not just on success */
if (received_fd >= 0) {
    close(received_fd);
    received_fd = -1;
}
if (ret < 0)
    return ret;
```

For defense in depth: apply `O_CLOEXEC` to received fds immediately via `fcntl(received_fd, F_SETFD, FD_CLOEXEC)` so they do not leak into child processes spawned by `exec()`. Also raise `RLIMIT_NOFILE` to give earlier warning headroom, and monitor `/proc/<pid>/fd` count in alerting.

---

## 3. The pipe capacity surprise

### What happened

A log aggregation pipeline connected a producer (generating structured log lines) to a consumer (compressing and forwarding to a remote endpoint) via an anonymous pipe. Under normal load, the consumer kept up. During a 50ms processing spike — caused by a TLS renegotiation on the remote connection — the consumer stalled.

During those 50ms, the producer continued writing. The pipe filled to its default 65536-byte limit (`/proc/sys/fs/pipe-max-size` defaults to 1 MiB, but the *per-pipe* default capacity is 64 KiB, controlled by the `pipe_max_size` sysctl and the individual pipe's current capacity). The producer's `write()` call blocked. Since the producer thread was also responsible for ingesting incoming log events, the entire ingestion path backed up. By the time the consumer recovered, 8 seconds of logs had been dropped.

```bash
# Check current pipe capacity (Linux 2.6.35+)
fcntl(fd, F_GETPIPE_SZ)  # returns current capacity in bytes
cat /proc/sys/fs/pipe-max-size  # system-wide maximum
```

### Root cause

A pipe is a fixed-capacity circular buffer. `struct pipe_inode_info` (defined in `include/linux/pipe_fs_i.h`) tracks the ring of `struct pipe_buffer` pages. When all pages are full, `anon_pipe_write()` in `fs/pipe.c` either blocks (default) or returns `EAGAIN` (if `O_NONBLOCK`). There is no automatic buffering beyond the kernel pipe capacity.

### Fix

Three options, in order of invasiveness:

1. **Increase pipe capacity** (quick fix):
   ```c
   /* Increase to 1 MiB (bounded by /proc/sys/fs/pipe-max-size) */
   fcntl(pipefd[1], F_SETPIPE_SZ, 1048576);
   ```
   This buys time but does not eliminate the blocking — it only delays it.

2. **Non-blocking writes with a userspace buffer**: set `O_NONBLOCK` on the write end, handle `EAGAIN` by accumulating in a userspace ring buffer, and retry on the next iteration. This decouples producer and consumer at the cost of memory.

3. **Switch to a Unix socket with `SO_SNDBUF`**: a `SOCK_STREAM` Unix socket with a large `SO_SNDBUF` provides more tunable buffering, and with `O_NONBLOCK` the `EAGAIN` back-pressure is explicit and recoverable without blocking the producer thread.

---

## 4. The signal storm from SIGCHLD

### What happened

A job scheduler spawned thousands of short-lived worker processes. The parent installed a `SIGCHLD` handler that called `waitpid(-1, &status, WNOHANG)` once — to reap one child — and returned. Under low load, this worked: one child exited, one signal arrived, one `waitpid()` call reaped it.

Under high load, multiple children exited within a short window. Linux standard signals (`SIGCHLD` is signal 17, a standard signal) are *not* queued — if the signal is already pending, additional deliveries are discarded. The parent received one `SIGCHLD` for what were actually 200 child exits. The single `waitpid()` call reaped one zombie. The other 199 remained in the process table as zombies.

After several hours, `ps aux | grep Z` showed thousands of `<defunct>` entries. The pid namespace was exhausted. New `fork()` calls returned `EAGAIN`.

```bash
# Count zombie children
ps -o pid,stat,ppid | awk '$2 ~ /Z/ && $3 == <parent_pid> {count++} END {print count}'
```

### Root cause

Standard signals (1–31) use a single-bit pending mask per thread (`pending` in `struct task_struct`, type `struct sigpending`). The mask has one bit per signal number. If `SIGCHLD` is already pending when another child exits, the new delivery is silently discarded — the mask bit is already set. The signal handler sees only one delivery regardless of how many children exited.

Real-time signals (`SIGRTMIN` through `SIGRTMAX`, kernel range 32–64, user-visible range 34–64 once glibc's two reserved signals are excluded) use a queue (`struct sigqueue`) and are not subject to this merging, but `SIGCHLD` is a standard signal.

### Fix

Always loop `waitpid()` until it returns 0 (no more waitable children) or -1/`ECHILD` (no children at all):

```c
static void sigchld_handler(int sig)
{
    int saved_errno = errno;
    int status;
    pid_t pid;

    /* Loop: one signal may represent multiple child exits */
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        /* record pid/status if needed */
    }

    errno = saved_errno;  /* waitpid may set errno; restore for interrupted syscalls */
}
```

The `while` loop is non-optional. Signal handlers for `SIGCHLD` without it are subtly broken in any multi-child scenario. Alternatively, use `signalfd` with `SIGCHLD` blocked at the thread level and loop `waitpid()` every time the signalfd becomes readable.

---

## 5. The eventfd overflow

### What happened

A high-throughput event pipeline used `eventfd` with `EFD_SEMAPHORE | EFD_NONBLOCK` to notify a consumer of pending work items. The producer, running in a tight loop, called `write(efd, &one, 8)` for each work item. The consumer read from the eventfd and processed items one at a time.

Under a traffic spike, the producer generated items faster than the consumer could process them. The eventfd counter climbed toward `UINT64_MAX - 1`. When the counter reached that threshold, subsequent `write()` calls returned `EAGAIN` — the kernel refused to increment further because doing so would overflow the `uint64_t` counter (see `eventfd_write()` in `fs/eventfd.c`).

The producer code did not check the return value of `write()` carefully:

```c
/* Bug: EAGAIN silently dropped */
write(efd, &(uint64_t){1}, 8);
```

Work items were enqueued in the producer's internal queue but the consumer was never notified they existed. After the spike subsided and the consumer caught up, the eventfd counter dropped — but the stranded items remained in the queue, unprocessed, until the next producer write triggered a fresh notification. Those items experienced unbounded latency.

### Root cause

`eventfd_write()` in `fs/eventfd.c` checks:

```c
if (ULLONG_MAX - ctx->count <= ucnt) {
    /* Would overflow UINT64_MAX - 1 */
    if (file->f_flags & O_NONBLOCK)
        return -EAGAIN;
    /* else: block until counter drops */
}
```

The counter saturates at `UINT64_MAX - 1` (not `UINT64_MAX`, because `UINT64_MAX` is the sentinel value used internally). With `EFD_NONBLOCK`, the write returns `EAGAIN` silently rather than blocking. The event is lost if the caller does not handle `EAGAIN` as backpressure.

### Fix

Handle `EAGAIN` explicitly on every non-blocking eventfd write:

```c
uint64_t one = 1;
ssize_t n = write(efd, &one, sizeof(one));
if (n < 0) {
    if (errno == EAGAIN) {
        /* Counter is saturated: consumer is behind. */
        /* Apply backpressure: slow down, log, or wake consumer another way. */
        apply_backpressure();
    } else {
        perror("eventfd write");
    }
}
```

Or switch to an IPC mechanism where backpressure is part of the protocol rather than a special error code:

- **POSIX message queue** (`mq_open`): `mq_send()` blocks (or returns `EAGAIN`) when the queue is full (`mq_maxmsg` items); the queue depth is explicit and configurable.
- **Unix socket** (`AF_UNIX SOCK_DGRAM`): when the receive buffer is full, `sendmsg()` returns `ENOBUFS` or blocks — explicit backpressure on each message.
- **Blocking eventfd** (without `EFD_NONBLOCK`): the producer blocks when the counter is at maximum, providing natural flow control at the cost of a blocked thread.

The general principle: `EFD_NONBLOCK` is appropriate only when `EAGAIN` is explicitly handled as a first-class condition, not a rare error.

---

## Patterns across all five

| Incident | Root mechanism | Detection | Prevention |
|----------|---------------|-----------|------------|
| SysV semaphore leak | Persistent kernel objects | `ipcs -s`, `ENOSPC` | `IPC_RMID` in all paths; prefer POSIX semaphores |
| SCM_RIGHTS fd leak | Receiver owns the fd | `lsof`, `EMFILE` | Close in all paths; `O_CLOEXEC` |
| Pipe capacity | Fixed kernel buffer | Producer blocks | `F_SETPIPE_SZ`; non-blocking + userspace buffer |
| SIGCHLD coalescing | Standard signal bit-mask | Zombie accumulation | Loop `waitpid()` in handler |
| eventfd overflow | `UINT64_MAX - 1` cap | Silent `EAGAIN` | Check return value; handle `EAGAIN` as backpressure |

## Further reading

### Kernel source

- [ipc/util.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/ipc/util.c) — `ipc_addid()`, `ipc_rmid()`, and the per-namespace `ipc_ids` table that SysV objects live in until explicitly removed, behind Case 1
- [ipc/sem.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/ipc/sem.c) — `semget()`, `semctl()`, and the `SEM_UNDO` adjustment-on-exit handling behind Case 1's fix
- [fs/file.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/file.c) — `receive_fd()` and `alloc_fd()`, which install a received `SCM_RIGHTS` descriptor into the receiver's own `files_struct`, behind Case 2
- [net/core/scm.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/net/core/scm.c) — `scm_detach_fds()` and `scm_recv_one_fd()`, the control-message path that calls `receive_fd()` for each `SCM_RIGHTS` descriptor, behind Case 2
- [net/unix/garbage.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/net/unix/garbage.c) — the per-user `unix_inflight` counter and cycle-detecting garbage collector for in-flight `SCM_RIGHTS` fds, behind Case 2
- [include/linux/pipe_fs_i.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/pipe_fs_i.h) — `struct pipe_inode_info` and `struct pipe_buffer`, the fixed-size ring behind Case 3
- [fs/pipe.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/pipe.c) — `anon_pipe_write()`, the `pipe_max_size` sysctl, and `F_SETPIPE_SZ` handling behind Case 3
- [kernel/signal.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/signal.c) — `legacy_queue()` and `__send_signal_locked()`, which drop a standard signal that is already pending on the target, behind Case 4
- [include/linux/signal_types.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/signal_types.h) — `struct sigpending` (a bitmask) versus `struct sigqueue` (a queued list entry), the data structures behind Case 4's standard/real-time distinction
- [fs/eventfd.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/eventfd.c) — `eventfd_write()` and the `ULLONG_MAX - 1` saturation check behind Case 5

### Man pages

- [`semop(2)`](https://man7.org/linux/man-pages/man2/semop.2.html) — documents `SEM_UNDO`: adjustments are automatically reversed when a process terminates, used in Case 1
- [`sem_unlink(3)`](https://man7.org/linux/man-pages/man3/sem_unlink.3.html) — confirms a named POSIX semaphore is destroyed only once every process that has it open has closed it, the mechanism behind Case 1's "migrate to POSIX semaphores" fix
- [`ipcs(1)`](https://man7.org/linux/man-pages/man1/ipcs.1.html) — the diagnostic tool used in Case 1
- [`unix(7)`](https://man7.org/linux/man-pages/man7/unix.7.html) — documents `SCM_RIGHTS` ancillary data for passing open file descriptors between processes, used in Case 2
- [`pipe(7)`](https://man7.org/linux/man-pages/man7/pipe.7.html) — documents pipe capacity (16 pages / 65,536 bytes by default since Linux 2.6.11) and blocking-write behavior, used in Case 3
- [`fcntl(2)`](https://man7.org/linux/man-pages/man2/fcntl.2.html) — documents `F_SETPIPE_SZ`/`F_GETPIPE_SZ` for resizing a pipe, used in Case 3's fix
- [`signal(7)`](https://man7.org/linux/man-pages/man7/signal.7.html) — documents that standard signals do not queue (multiple pending instances collapse to one) while real-time signals do, the mechanism behind Case 4
- [`wait(2)`](https://man7.org/linux/man-pages/man2/waitpid.2.html) — documents `waitpid()` and `WNOHANG`, used in Case 4's fix
- [`eventfd(2)`](https://man7.org/linux/man-pages/man2/eventfd.2.html) — documents `EFD_SEMAPHORE`, `EFD_NONBLOCK`, and the counter's `UINT64_MAX - 1` saturation point, used in Case 5
- [`mq_send(3)`](https://man7.org/linux/man-pages/man3/mq_send.3.html) — documents the blocking/`EAGAIN` behavior when `mq_maxmsg` is reached, the alternative mechanism mentioned in Case 5's fix

### Related pages

- [Signals](signals.md) — `SIGCHLD`, `sigaction`, `sigprocmask`
- [Pipes and FIFOs](pipes.md) — `struct pipe_inode_info`, `PIPE_BUF`, `F_SETPIPE_SZ`
- [Unix Domain Sockets](unix-sockets.md) — `SCM_RIGHTS`, `SCM_CREDENTIALS`, fd passing internals
- [SysV IPC: Semaphores and Message Queues](sysv-semaphores.md) — `SEM_UNDO`, `IPC_RMID`, `SEMMNI`
- [eventfd and signalfd](eventfd-signalfd.md) — `EFD_SEMAPHORE`, `EFD_NONBLOCK`, counter semantics
- [POSIX Message Queues](mqueue.md) — `mq_send`, `mq_maxmsg`, blocking/backpressure semantics, the alternative discussed in Case 5

### LWN articles

- [Circular pipes](https://lwn.net/Articles/118750/) (January 11, 2005) — the introduction of the multi-page circular pipe buffer in 2.6.11, the ancestor of the `struct pipe_inode_info` ring behind Case 3
- [The evolution of pipe buffers](https://lwn.net/Articles/119682/) (January 18, 2005) — follow-up on the pipe buffer redesign, including the 16-page capacity ceiling behind Case 3's default 64 KiB pipe size
- [io_uring, SCM_RIGHTS, and reference-count cycles](https://lwn.net/Articles/779472/) (February 13, 2019) — how the kernel tracks and garbage-collects in-flight `SCM_RIGHTS` file descriptors, the mechanism behind Case 2
