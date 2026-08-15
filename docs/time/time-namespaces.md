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

`CLONE_NEWTIME` was introduced in Linux 5.6. It is unique among namespace types in one important way: **the offsets in `/proc/<pid>/timens_offsets` must be written before any process enters the new time namespace**. Calling `unshare(CLONE_NEWTIME)` creates a new time namespace for *future child processes* (`time_ns_for_children`), while the calling process itself remains in its original time namespace. When the first child process is forked or spawned, `timens_on_fork()` commits the namespace, sets up the per-namespace vvar page, and permanently sets `frozen_offsets = true`. Any attempt to write to `timens_offsets` after a process has entered the namespace fails with `-EACCES`.

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
/* include/linux/time_namespace.h */
struct time_namespace {
    struct user_namespace   *user_ns;
    struct ucounts          *ucounts;
    struct ns_common         ns;
    struct timens_offsets    offsets;   /* the clock adjustments */
#ifdef CONFIG_TIME_NS_VDSO
    struct page             *vvar_page; /* per-namespace vDSO data page */
#endif
    bool                     frozen_offsets; /* true after any process joins the namespace */
} __randomize_layout;
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

Offsets are configured by writing to `/proc/<pid>/timens_offsets` from outside the namespace, before any child process enters the new namespace:

```
# Format: <clock_name> <seconds> <nanoseconds>
monotonic <sec> <nsec>
boottime  <sec> <nsec>
```

Example — give a container the illusion that it started 1000 seconds ago:

```bash
# Unshare time namespace for future children
unshare --time bash -c '
    # Parent writes offsets for its future children into its own timens_offsets
    echo "monotonic 1000 0" > /proc/self/timens_offsets
    echo "boottime 1000 0"  > /proc/self/timens_offsets

    # Now fork a child into the new namespace
    # timens_on_fork() will freeze offsets on fork
    python3 -c "import time; print(time.monotonic())"
'
```

Once any process enters the namespace (e.g. on `fork()` after `unshare(CLONE_NEWTIME)`), `timens_on_fork()` commits the namespace and freezes the offsets. Further writes to `timens_offsets` return `EACCES`.

The offsets can be negative (the container sees time as earlier than the host's monotonic clock — useful for CRIU restore when the container was created before the host's monotonic baseline).

## CRIU use case

CRIU (Checkpoint/Restore In Userspace) is the primary consumer of time namespaces. When CRIU restores a checkpoint:

1. The CRIU restore process calls `unshare(CLONE_NEWTIME)`.
2. Before forking the target container process, CRIU writes the appropriate offsets to `/proc/self/timens_offsets`. The offsets encode the difference between the container's monotonic time at checkpoint and the host's current monotonic time.
3. CRIU forks the target process into the new namespace (`timens_on_fork()` commits the offsets and maps the per-namespace VVAR page). The restored process sees a continuous `CLOCK_MONOTONIC` — the jump in wall time that occurred during suspension is hidden.

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

## Further reading

### Kernel source

- [include/linux/time_namespace.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/time_namespace.h) — definition of `struct time_namespace`, `struct timens_offsets`, and the `timens_on_fork()` hook
- [kernel/time/namespace.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/namespace.c) — time namespace lifecycle, `/proc/[pid]/timens_offsets` parsing, permission checking, and clock offset translation (`do_timens_ktime_to_host()`)
- [kernel/time/namespace_vdso.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/namespace_vdso.c) — per-namespace VVAR page setup (`timens_setup_vdso_clock_data()`), VVAR page fault handling, and `timens_commit()`

### Man pages

- [`time_namespaces(7)`](https://man7.org/linux/man-pages/man7/time_namespaces.7.html) — overview of Linux time namespaces, `/proc/[pid]/timens_offsets` syntax, and offset freezing rules
- [`unshare(2)`](https://man7.org/linux/man-pages/man2/unshare.2.html) — disassociating execution context and creating a new time namespace with `CLONE_NEWTIME`
- [`setns(2)`](https://man7.org/linux/man-pages/man2/setns.2.html) — joining an existing time namespace via file descriptor
- [`clock_gettime(2)`](https://man7.org/linux/man-pages/man2/clock_gettime.2.html) — reading `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME` inside time namespaces

### Related pages

- [Timekeeping and Clocksources](timekeeping.md) — the baseline `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME` mechanisms and vDSO data layout
- [POSIX Timers and timerfd](posix-timers.md) — timerfd expiry adjustment inside time namespaces
- [vDSO Fast System Calls](../mm/vdso.md) — kernel-to-user shared data pages and architecture of VVAR mappings

### LWN articles

- [Time namespaces](https://lwn.net/Articles/766089/) — Jonathan Corbet, September 2018: containerized clock offsets for CRIU checkpoint/restore and virtualization
- [The 5.6 merge window opens](https://lwn.net/Articles/810780/) — Jonathan Corbet, January 30, 2020: official merging of time namespaces (`CLONE_NEWTIME`) into mainline Linux

### External

- [Namespaces in the Linux Kernel](https://docs.kernel.org/admin-guide/namespaces/index.html) — official kernel documentation covering namespaces and virtualization
