# PSI Polling: A Waitqueue That Outlived the cgroup That Owned It

> CVE-2023-52707 — a pressure-monitoring waitqueue was freed the moment its cgroup was removed, but a thread still polling the pressure file kept a reference to it and could dereference the freed memory on exit

Fixed in
:   commit `c2dbe32d5db5` ("sched/psi: Fix use-after-free in ep_remove_wait_queue()"), mainline Linux 6.2 (February 2023)

Found and fixed by
:   Munehisa Kamata (Amazon)

Bug present since
:   Linux 5.2, via commit `0e94682b73bf`

*Part of [War Stories: Scheduler Bugs](../war-stories.md).*

## Before state

Pressure Stall Information (PSI) lets a process register a trigger on a cgroup's `cpu.pressure`, `memory.pressure`, or `io.pressure` file and poll (or `epoll`) it for notification when pressure crosses a threshold. Each trigger owns a waitqueue that `epoll`'s internal bookkeeping (`struct eventpoll`) attaches to via the file it opened, following the normal `epoll` lifecycle: the waitqueue is expected to remain valid for as long as any `epoll` instance still references the file, and gets detached and released as part of that file eventually being closed.

## The trigger

Removing a non-root cgroup while a thread is still polling one of its pressure files takes a different teardown path than closing the file normally:

```
do_rmdir
  cgroup_rmdir
    kernfs_drain_open_files
      cgroup_file_release
        cgroup_pressure_release
          psi_trigger_destroy
```

`psi_trigger_destroy()` frees the trigger's waitqueue as part of tearing down the cgroup, regardless of whether any process still has the pressure file open and registered with `epoll`. The polling thread's file descriptor is still valid and its `epoll` registration is still live — it just now points at freed memory.

## Observed behavior

When the polling thread later closes the file, or exits and its file descriptors are cleaned up, `epoll`'s own release path runs:

```
fput
  ep_eventpoll_release
    ep_free
      ep_remove_wait_queue
        remove_wait_queue
```

`ep_remove_wait_queue()` dereferences the waitqueue that `cgroup_rmdir()` had already freed when the cgroup was removed — a straightforward use-after-free, reachable by an unprivileged process that only needs permission to poll a pressure file in a cgroup someone else (or something else) later removes.

## Why it happened

The root problem, as the fixing commit states directly, is that `cgroup_file_release()` — and by extension the pressure trigger's waitqueue lifetime — was never tied to the underlying file's actual lifetime. `epoll`'s contract assumes a waitqueue registered against an open file descriptor stays valid until that descriptor's own `struct file` is released; PSI's pressure-trigger waitqueue instead followed the cgroup's removal lifecycle, an entirely separate and earlier event that `epoll` had no way to know about or wait for.

## Resolution

The correct fix — making `cgroup_file_release()`'s timing genuinely match the file's real lifetime — would have required non-trivial refactoring at the cgroup or kernfs layer. Instead, the fix uses `wake_up_pollfree()`, a helper added specifically for this class of problem (per its introducing commit, `42288cb44c4b`): call it from `psi_trigger_destroy()` before freeing the waitqueue, so any still-registered `epoll` watcher is woken and detaches itself cleanly at cgroup-removal time, rather than being left holding a dangling reference to be discovered later on close.

## What it taught us

**A subsystem that participates in another subsystem's lifecycle contract has to honor that contract exactly, even when its own natural teardown path is different.** PSI triggers are cgroup-scoped and get torn down when the cgroup goes away; `epoll` waitqueues are file-scoped and expect to survive until the file itself is released. Bridging the two correctly means recognizing that "the cgroup is gone" and "the file is closed" are genuinely different events that can happen in either order — not treating the earlier one as if it also means the latter.

**A purpose-built escape hatch (`wake_up_pollfree()`) can be the right fix even when it isn't the "clean" one.** The commit message is explicit that tying `cgroup_file_release()` to `fput()` properly would be the more correct fix, but also the far larger one — using the existing pattern for "this waitqueue's lifetime isn't tied to the file's" was judged the safer, smaller change for something this reachable.

!!! warning "Pattern to watch for"
    Whenever one kernel object (here, a cgroup-owned trigger) is referenced from a general-purpose notification mechanism (here, `epoll`) built around a *different* object's lifetime (a `struct file`), check what happens if the owning object is torn down first, out of band, while the notification mechanism still believes the reference is live.

## See also

- [Scheduler Overview](../README.md) — pressure-stall accounting and PSI
- [cgroup v2](../../cgroups/cgroup-v2.md) — cgroup removal and file lifecycle

## External references

- [git.kernel.org: c2dbe32d5db5](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=c2dbe32d5db5c4ead121cf86dabd5ab691fb47fe) — "sched/psi: Fix use-after-free in ep_remove_wait_queue()," the mainline fix
- [git.kernel.org: security/vulns — CVE-2023-52707](https://git.kernel.org/pub/scm/linux/security/vulns.git/plain/cve/published/2023/CVE-2023-52707.mbox) — the kernel CVE team's official announcement, including affected/fixed versions across stable branches
