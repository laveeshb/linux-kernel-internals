# War Stories: Scheduler Bugs and Design Tensions

> Two CVEs, two performance regressions with a real fix, and one heuristic tension that was never cleanly resolved — five incidents that show the scheduler's hardest bugs are as often about *stale assumptions* as about memory safety

Only two of the five incidents below are CVEs. The other three are reliability and performance sagas — cases where a fix for one bug quietly exposed a design flaw that had been masked for years, or where a heuristic tuned against one real production workload turned out to actively hurt another. That mix is itself representative of scheduler bugs generally: getting task placement and bandwidth accounting *correct* under every workload shape is hard enough that most of the scheduler's most interesting incidents never needed a memory-safety bug to be worth telling.

## Incidents

Ordered reverse chronologically by when the fix (or, for the unresolved case, the cited discussion) landed — newest first.

### [The DEADLINE Lock Holder That Forgot to Inherit on the Way Down](war-stories/deadline-pi-deboost.md)
**CVE-2026-23371**
A SCHED_DEADLINE task holding a priority-inheritance mutex, demoted to a lower scheduling class mid-hold, could skip inheriting the waiting donor's deadline parameters — corrupting the kernel's own bandwidth accounting.

### [The Cost of Asking "Is There Any Work For Me?" Too Often](war-stories/newidle-balance-cost.md)
**Linux 6.17 (July 2025), with a follow-up refinement in November 2025**
Removing a stale condition around newidle-balance cost tracking fixed the bug it targeted — and revealed that a wakeup-storm workload could spend a fifth of its CPU time on failed checks for work that almost never existed.

### [PSI Polling: A Waitqueue That Outlived the cgroup That Owned It](war-stories/psi-trigger-uaf.md)
**Linux 6.2 (February 2023) · CVE-2023-52707**
A pressure-monitoring trigger's waitqueue followed its cgroup's teardown lifecycle, not the polling file descriptor's — so removing the cgroup while a thread still had the file open left `epoll`'s own release path dereferencing freed memory.

### [wake_wide(): A Heuristic That Helps One Workload by Hurting Another](war-stories/wake-wide-heuristic.md)
**LKML discussion, July 2017 — unresolved**
Facebook's producer-consumer workload needed the scheduler to pack woken tasks tightly for cache locality; the same heuristic made `hackbench`'s all-to-all communication pattern ping-pong between CPU caches and perform worse. No proposal was judged a clear winner.

### [The CFS Bandwidth Slice That Expired Before It Was Spent](war-stories/cfs-bandwidth-throttling.md)
**Linux 5.4 (August 2019)**
A multi-threaded, non-CPU-bound application under `cpu.cfs_quota_us` could be throttled while never using its full quota, because unused per-CPU bandwidth slices expired at every period boundary — a design flaw an unrelated bug had accidentally been masking for five years.

## Common threads

| Pattern | DEADLINE PI de-boost | newidle-balance cost | PSI waitqueue UAF | wake_wide() | CFS bandwidth |
|---------|:---:|:---:|:---:|:---:|:---:|
| CVE | Yes | No | Yes | No | No |
| Root cause: state computed correctly once, then never re-derived after conditions changed | Yes | No | No | No | No |
| Root cause: two subsystems' lifecycle assumptions didn't match | No | No | Yes | No | No |
| Root cause: a fix for one bug masked (or exposed) an unrelated design flaw | No | Yes | No | No | Yes |
| A clean fix exists and shipped | Yes | Yes | Yes | **No** | Yes |
| Affects correctness of kernel-internal accounting, not just user-visible behavior | Yes | No | No | No | Yes |

**Two of the five are genuine security bugs, and they fail in opposite ways.** The PSI waitqueue bug is a lifecycle mismatch between two subsystems that each manage a resource correctly on their own terms but disagree about when a shared object should die. The DEADLINE PI bug is a single subsystem's own state going stale across a transition it didn't know it needed to watch for. Neither is a classic bounds-check or type-confusion bug — both are consistency bugs in bookkeeping that only mattered once a specific sequence of otherwise-legitimate operations lined up.

**The two performance stories (CFS bandwidth, newidle-balance) share a shape: a fix for bug A silently changed the cost or availability of resource B, and nobody was specifically testing for that interaction until a real, unusual production workload found it.** Both took a genuinely non-CPU-bound, wakeup-heavy workload — Kubernetes-style interactive containers in one case, an intentionally do-nothing `schbench` configuration in the other — to surface, because both regressions are invisible to CPU-bound benchmarks.

**wake_wide() is the odd one out, and included deliberately: not every scheduler war story ends with a commit hash.** It's the clearest illustration on this page that a heuristic genuinely can't satisfy two real, equally legitimate workloads at once with a single cheap check — and that recognizing "we need a middle ground we haven't found yet" is sometimes the honest end state of a scheduler debate.

## See also

- [Scheduler Overview](README.md) — CFS, EEVDF, SCHED_DEADLINE, and load balancing
- [Locking War Stories](../locking/war-stories.md) — priority-inheritance bugs from the mutex side of the same PI protocol the DEADLINE incident above depends on
- [BPF War Stories](../bpf/war-stories.md) — a different kind of scheduler-adjacent subsystem's incident history, for contrast
