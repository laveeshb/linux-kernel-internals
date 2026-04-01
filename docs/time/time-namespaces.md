# Time Namespaces

> Per-container clock offsets: CLOCK_MONOTONIC and CLOCK_BOOTTIME isolation

## Motivation

Linux namespaces isolate kernel resources per container. Most namespaces (network, mount, PID) can be created by calling `unshare()` or `clone()` from within the process that will use them. Time namespaces (`CLONE_NEWTIME`) solve a different problem: making `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME` appear continuous across a checkpoint/restore cycle.

Without time namespaces, a container checkpointed at t=1000 and restored 3600 seconds later would see `CLOCK_MONOTONIC` jump from 1000 to 4600 — the 3600 seconds of real elapsed time while it was frozen. Any timeout or deadline computed against the monotonic clock before checkpoint would be wildly wrong after restore. Time namespaces allow CRIU and similar tools to give the container the illusion that no time passed during the suspension.

## CLONE_NEWTIME (Linux 5.6)

```c
/* Create a new time namespace */
unshare(CLONE_NEWTIME);

/* Or at process creation */
clone(child_fn, stack, CLONE_NEWTIME | SIGCHLD, NULL);
```

`CLONE_NEWTIME` was introduced in Linux 5.6. It is unique among namespace types in one important way: **the offsets in `/proc/<pid>/timens_offsets` must be written before the process calls `exec()` in the new time namespace**. The namespace is sealed when the vDSO is mapped into the new namespace's process on `exec()` — `timens_on_fork()` sets up the per-namespace vvar page at that point. A process can call `clock_gettime()` after `unshare(CLONE_NEWTIME)` but before `exec()`: it will use the slow syscall path and the namespace offsets are still mutable. The sealing trigger is `exec()`, not the first clock read.

## What is and is not namespaced

| Clock | Namespaced? |
|-------|-------------|
| `CLOCK_MONOTONIC` | Yes — offset applied |
| `CLOCK_BOOTTIME` | Yes — offset applied |
| `CLOCK_REALTIME` | No — always global UTC |
| `CLOCK_TAI` | No — always global TAI |
| `CLOCK_PROCESS_CPUTIME_ID` | No — per-process CPU time |
| `CLOCK_THREAD_CPUTIME_ID` | No — per-thread CPU time |

`CLOCK_REALTIME` is intentionally not namespaced. Wall clock time is shared across all containers on a host; only the monotonic and boot-time clocks — which measure elapsed time since some reference point — are given per-namespace offsets.

## struct time_namespace

```c
/* kernel/time/namespace.c */
struct time_namespace {
    struct user_namespace   *user_ns;
    struct ucounts          *ucounts;
    struct ns_common         ns;
    struct timens_offsets    offsets;   /* the clock adjustments */
    struct page             *vvar_page; /* per-namespace vDSO data page */
    bool                     frozen_offsets; /* true after exec() in the namespace */
};
```

The `offsets` field holds the addends applied to `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME` reads:

```c
struct timens_offsets {
    struct timespec64 monotonic; /* added to CLOCK_MONOTONIC reads */
    struct timespec64 boottime;  /* added to CLOCK_BOOTTIME reads */
};
```

These are plain `timespec64` values — seconds and nanoseconds added to the base clock value before returning to userspace.

## vDSO integration

`clock_gettime(CLOCK_MONOTONIC)` is implemented in the vDSO (virtual dynamic shared object) — a kernel-mapped page in every process's address space that allows the call to execute without a syscall. For time namespaces to work transparently with the vDSO, each time namespace gets its own vvar (vDSO variables) page.

When a process enters a new time namespace, the kernel maps the namespace-specific vvar page into the process's address space. The vDSO clock functions read clock data from this per-namespace page, which contains the base time plus the namespace's offset already incorporated into the `basetime` fields. The offset is applied at namespace setup time into the vvar page, so the vDSO path pays no extra cost at runtime compared to the non-namespaced case.

This means `clock_gettime(CLOCK_MONOTONIC)` inside a container with a time namespace remains a vDSO call (no syscall) and returns the offset-adjusted time without kernel involvement.

## Setting offsets

Offsets are configured by writing to `/proc/<pid>/timens_offsets` from outside the namespace, before the process uses the clock:

```
# Format: <clock_name> <seconds> <nanoseconds>
monotonic <sec> <nsec>
boottime  <sec> <nsec>
```

Example — give a container the illusion that it started 1000 seconds ago:

```bash
# Fork a child that will use the new namespace
unshare --time --fork bash &
CHILD_PID=$!

# Set the offset BEFORE the child calls exec()
echo "monotonic 1000 0" > /proc/$CHILD_PID/timens_offsets
echo "boottime 1000 0"  > /proc/$CHILD_PID/timens_offsets

# Now let the child exec its program — it sees CLOCK_MONOTONIC + 1000s
```

Once the child calls `exec()`, the per-namespace vvar page is mapped and the offsets are frozen. Further writes to `timens_offsets` after `exec()` return `EACCES`. A process may call `clock_gettime()` before `exec()` — it will use the slow syscall path and the offsets remain writable until `exec()` is called.

The offsets can be negative (the container sees time as earlier than the host's monotonic clock — useful for CRIU restore when the container was created before the host's monotonic baseline).

## CRIU use case

CRIU (Checkpoint/Restore In Userspace) is the primary consumer of time namespaces. When CRIU restores a checkpoint:

1. It forks the container process with `CLONE_NEWTIME`.
2. Before the process calls `exec()`, CRIU writes the appropriate offsets to `timens_offsets`. The offsets encode the difference between the container's monotonic time at checkpoint and the host's current monotonic time.
3. When the process executes (`exec()`), the per-namespace vvar page is mapped with the adjusted offsets baked in. The restored process sees a continuous `CLOCK_MONOTONIC` — the jump in wall time that occurred during suspension is hidden.

Without time namespaces, any timer, timeout, or deadline the container computed against `CLOCK_MONOTONIC` before checkpoint would expire immediately or have a wildly wrong remaining duration after restore.

## timerfd interaction

A `timerfd` created with `CLOCK_MONOTONIC` inside a time namespace uses the namespaced clock:

```c
/* Inside the container */
int fd = timerfd_create(CLOCK_MONOTONIC, 0);
struct itimerspec its = {
    .it_value = { .tv_sec = 5, .tv_nsec = 0 },
};
timerfd_settime(fd, TFD_TIMER_ABSTIME, &its, NULL);
/* Fires when namespaced CLOCK_MONOTONIC reaches 5 seconds from now */
```

The kernel tracks the timerfd expiry against the namespace-adjusted clock. After a CRIU restore, timers that had not yet expired continue to count down correctly from their original relative positions.

## Current limitations

- Only `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME` are offset. All other clocks are not namespaced.
- The offsets are integers (seconds + nanoseconds) — there is no per-namespace frequency correction or drift compensation.
- A process can be in at most one time namespace at a time; there is no stacking.
- Time namespaces do not affect the RTC, NTP synchronization, or `adjtimex()` — those are global.
- `/proc/uptime` is affected by the `CLOCK_BOOTTIME` offset within the namespace, so `uptime` inside a container shows the namespace-adjusted boot time.

## Inspecting time namespaces

```bash
# See which time namespace a process is in
ls -la /proc/<pid>/ns/time

# Compare two processes
readlink /proc/1/ns/time
readlink /proc/$$/ns/time

# Show offsets for a process
cat /proc/<pid>/timens_offsets
# monotonic 1000 0
# boottime  1000 0

# Verify clock isolation from inside
# (requires nsenter or running inside the namespace)
nsenter --time=/proc/<pid>/ns/time -- \
    python3 -c "import time; print(time.monotonic())"
```
