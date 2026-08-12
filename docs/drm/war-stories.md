# War Stories: GPU/DRM Bugs and Regressions

> Five incidents from the shared DRM scheduler and driver recovery paths — none of them a CVE, all of them a GPU that either hung when it shouldn't have, or didn't recover when it should have

[Command Submission, `dma_fence`, and the GPU Scheduler](command-submission.md) documents `drm_sched`, TDR, and the `dma_fence` signaling contract as they work today. This page is the incident record behind that architecture — the hangs, deadlocks, and starvation bugs that shaped it, and in two cases, are still shaping it as recently as this year.

There is no CVE on this page. GPU/DRM's public incident record looks structurally different from the [BPF verifier's](../bpf/war-stories.md) or the [network stack's](../net/war-stories.md): those are security boundaries an unprivileged attacker can cross. `drm_sched` and the TDR/recovery paths are reliability boundaries — get them wrong and the GPU hangs, deadlocks, or starves a client, but nothing here hands an attacker a privilege they didn't already have. That doesn't make the bugs easier to find or fix. Three of the five incidents below are locking or lifetime bugs caught by lockdep, hung-task detection, or a crash trace pasted directly into the fixing commit — the same category of bug this site's [locking](../locking/README.md) and [interrupts](../interrupts/README.md) pages cover in the abstract, showing up here in a subsystem where the failure mode is a stuck compositor instead of a panic.

The other two are policy, not bugs: two changes to how `drm_sched` decides *which* job runs next, each one fixing a real starvation pattern the previous policy couldn't see coming until workloads exercised it.

## Incidents

Ordered reverse chronologically by when the fix landed — newest first.

### [The Xe TDR Recovery Regression Chain](war-stories/xe-tdr-recovery-regression.md)
**November 2024 – July 2026 · not a CVE**
A fix for one Xe TDR bug on Lunar Lake regressed unstarted-job recovery twenty months later; the next fix was itself found to dereference freed job memory, written just two days after it. Three commits, one function; the last two each carry a `Fixes:` tag pointing at the one before them.

### [The Scheduler Fairness Evolution](war-stories/scheduler-fairness-evolution.md)
**Linux 6.2 (2022) → Linux 7.2 (2026) · not a CVE**
Round robin starved entities with long job queues. FIFO fixed that and starved low-priority entities under sustained high-priority load instead. Fair scheduling, borrowing CFS's virtual-runtime model, is the current answer to both.

### [The msm GPU Recovery/Shrinker Deadlock](war-stories/msm-shrinker-deadlock.md)
**April 2026 (Linux 7.1) · not a CVE**
A GPU-hang recovery worker allocated memory for a crash dump while holding the lock the stuck ring's job thread needed — and that allocation triggered a shrinker that waited on the exact fence the stuck job would have signaled.

### [The `drm_sched_entity_kill_jobs_cb` Lockdep Deadlock](war-stories/entity-kill-jobs-deadlock.md)
**November 2025 · not a CVE**
A cleanup callback ran in interrupt context and took a lock that ordinary process-context code held without disabling interrupts — plus a second, independent deadlock in the same function, both fixed by moving the logic out of the signaling callback entirely.

### [The `NO_HANG` False Positive](war-stories/no-hang-false-positive.md)
**Linux 6.17 (July 2025) · not a CVE**
For years the scheduler had one answer to a fired timeout: reset the hardware. Three drivers had their own, better way to know the GPU wasn't actually hung, and had no way to tell the scheduler so — until this.

## Common threads

| Pattern | Xe TDR chain | Fairness evolution | msm shrinker | Kill-jobs deadlock | NO_HANG |
|---------|:---:|:---:|:---:|:---:|:---:|
| Root cause lives in a driver-shared `drm_sched` code path | Driver-specific | Yes | Driver-specific | Yes | Both |
| Caught by an automated detector (lockdep, hung-task, GPF) rather than a user complaint alone | Yes | No | Yes | Yes | No |
| Fix is itself a multi-commit chain, each fixing the previous fix | Yes | — | No | No | No |
| Motivated by a specific, named observation tool or bug tracker | No | Yes (GPUVis) | No | Yes (Mesa #13908) | No |
| Involves the `dma_fence` signaling-path contract | No | No | Yes | Yes | No |
| Multiple drivers affected by the same root fix | No | Yes | No | Yes | Yes |

**Three of five are lifetime or locking bugs, and every one of those three was caught by a mechanical detector, not by someone reading code and spotting the flaw.** Lockdep caught the interrupt-unsafe locking in `drm_sched_entity_kill_jobs_cb()` before it caused user-visible harm on most machines; hung-task detection caught the msm shrinker deadlock only after it had already stalled a ring for two minutes; the Xe GPF was caught by the kernel's own general-protection-fault handler two days after the fix that caused it was written. None of the three would have been obvious from a diff alone — each requires either running the deadlocked scenario or having a tool that reasons about lock ordering abstractly.

**The Xe chain is the sharpest illustration on this page of a fix regressing its own fix.** Compare it to [BPF's ALU32 unsigned-bounds bug](../bpf/war-stories/alu32-unsigned-bounds.md), where a fix for one half of a symmetric pattern left the other half broken for four and a half months — a *sibling* left unfixed. The Xe chain is different: each fix was itself broken by the code it introduced, in the same function, requiring a third commit to fully resolve. Twenty months elapsed between the first commit and the last.

**The two policy changes are the odd ones out — not bugs, but the scheduler admitting a previous fairness model didn't generalize.** Read alongside [the same subsystem's architecture page](command-submission.md#scheduling-policy-three-eras), the pattern is a single subsystem correcting itself twice in the same direction: round robin was blind to queue age, so FIFO fixed that; FIFO was blind to priority under load, so fair scheduling fixed that too. Each transition was a real improvement, and each new policy exposed a fairness dimension the previous one hadn't been tested against yet.

**Nothing on this page is a CVE, and that's a genuine property of the subsystem, not an oversight in what got selected.** A GPU hang, a stuck compositor, a scheduler-fairness regression — all real, all disruptive, none of them hand an unprivileged process a privilege it didn't have. Compare the [security](../security/war-stories.md) or [BPF](../bpf/war-stories.md) pages, where a comparably small mistake — a stale struct field, a copy taken before a value changed, a register-bounds error — is the entire vulnerability. Here it's a reliability incident with a hung-task trace instead of an exploit chain.

## See also

- [Command Submission, `dma_fence`, and the GPU Scheduler](command-submission.md) — the architecture every incident on this page lives inside: `drm_sched`, TDR, and the `dma_fence` cross-driver contract
- [GEM Buffer Objects and dma-buf Sharing](gem-dmabuf.md) — GEM shrinkers and `dma_resv`, the other half of the msm deadlock
- [KMS Object Model and Atomic Modesetting](kms.md) — the display side of the same subsystem
- [Locking](../locking/README.md) — general background on lockdep, interrupt-context locking hazards, and lock-nesting bugs
- [BPF War Stories](../bpf/war-stories.md) and [Network War Stories](../net/war-stories.md) — the same site's security-incident pages, for the contrast in what "war story" means when the bug class is exploitable rather than reliability-only
