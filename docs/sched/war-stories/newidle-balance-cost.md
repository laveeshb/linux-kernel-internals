# The Cost of Asking "Is There Any Work For Me?" Too Often

> Removing a stale condition around newidle-balance cost tracking uncovered that a wakeup-heavy workload could spend a fifth of its CPU time just checking for work that almost never existed — and the first fix for that, while effective on its own benchmark, caused a measurable regression on database workloads and had to be reverted before a different approach shipped

Reported by
:   Chris Mason (Meta), via `schbench` benchmarking

First fix (later reverted)
:   commit `155213a2aed4` ("sched/fair: Bump sd->max_newidle_lb_cost when newidle balance fails"), mainline Linux 6.17 (September 2025)

Reverted in
:   commit `d206fbad9328` ("sched/fair: Revert max_newidle_lb_cost bump"), Peter Zijlstra, after multiple independent reports of a database-workload regression

Fix (shipped)
:   commit `33cf66d88306` ("sched/fair: Proportional newidle balance"), mainline Linux 6.19 (February 2026)

*Part of [War Stories: Scheduler Bugs](../war-stories.md).*

## Before state

When a CPU is about to go idle, `sched_balance_newidle()` walks up its scheduling-domain hierarchy asking each domain whether there's a runnable task somewhere it could pull over — a "newidle balance." Because this check runs on the latency-sensitive idle-entry path, each domain tracks the cost of its own newidle-balance attempts in `sd->max_newidle_lb_cost`, decaying that estimate over time, so an expensive domain can eventually be skipped rather than delaying every wakeup.

## The trigger

Chris Mason bisected a `schbench` regression to an earlier commit, `c5b0a7eefc70` ("sched/fair: Remove sysctl_sched_migration_cost condition", Vincent Guittot, mainline Linux 5.16), using a workload designed to stress exactly this path: `schbench -L -m 4 -M auto -t 256 -n 0 -r 0 -s 0` pins 4 message threads to CPUs 0-3 and spreads 1024 worker threads across the rest, all of them doing no real work — just waking each other up and going back to sleep as fast as possible. Reverting the bisected commit took throughput from 3.4M requests/second back up to 5.4M RPS on a v6.9 kernel. The regression had been latent since v5.16 — roughly three and a half years — before this specific workload shape bisected it.

## Observed behavior

`schedstat` showed roughly 100x more newidle-balance attempts than before, and profiling showed the worker threads spending about 20% of their CPU time inside newidle balancing — almost all of those attempts failing to find a busy group to pull work from. The condition Guittot's commit removed had been silently suppressing most of this cost; once it was gone, every one of those failed "is there work for me?" checks ran at full price on a workload that, by design, almost never had a genuine answer of "yes."

## Why it happened

`sysctl_sched_migration_cost` originally gated newidle balancing as a coarse, static threshold. Removing that condition was a reasonable-looking simplification on its own — it has not been reverted, and the condition remains absent in current mainline — but it also removed the only thing keeping newidle-balance frequency in check for a workload whose CPUs go idle and become runnable again on a timescale far shorter than any load-balance interval was designed around. Nothing about the removal was individually wrong; the cost model it left behind simply had no mechanism for penalizing a domain that keeps failing to find work, only for penalizing one that keeps succeeding slowly.

## Resolution

Mason's first fix, `155213a2aed4`, changed `sched_balance_newidle()` to actively raise `sd->max_newidle_lb_cost` (via `domain_cost = (3 * sd->max_newidle_lb_cost) / 2`) whenever a newidle-balance attempt failed to pull a task, capped by `sysctl_sched_migration_cost` plus a small margin so the estimate couldn't grow without bound. On `schbench` this worked as intended. But it did not stay in the tree: several people reported regressions on database workloads as a direct result — Adam Li (Ampere) reported a 6% regression on SpecJBB, with further reports from Joseph Salisbury (Oracle), Dietmar Eggemann (Arm), and Hazem Mohamed Abuelfotoh (Amazon) — and Peter Zijlstra reverted it in `d206fbad9328`.

In its place, Zijlstra's `33cf66d88306` took a different approach: instead of a cost-based penalty, it tracks each domain's newidle-balance *success rate* (`sd->newidle_ratio`) and uses that to probabilistically skip the balance attempt entirely — "throw a 1k sided dice; and only run newidle_balance according to the success rate," gated behind a new `NI_RANDOM` scheduler feature flag. Zijlstra's own measurements on the same `schbench` case showed reverting Mason's fix and adding the randomized approach instead (2.18 Mrps/s) came close to the `schbench`-only figure Mason's fix had achieved (2.22 Mrps/s on 6.18-rc4, i.e. with Mason's fix still applied) — a clear improvement over the reverted-with-nothing-in-its-place state (2.04 Mrps/s) — with Chris Mason himself credited as a tester on the patch.

## Current status

The story didn't end there either. In January 2026, Zijlstra posted `9fe89f022c05` ("sched/fair: More complex proportional newidle balance"), reporting that some workloads (easyWave, fio) have a fairly low newidle-balance success rate but still benefit greatly from attempting it — a case `NI_RANDOM`'s pure probability model handles poorly. That patch adds a second, rate-based term, gated behind a `NI_RATE` feature flag, and merged into mainline Linux 7.0 alongside `NI_RANDOM`, which is still present. Reported-by credits include Mario Roy and Hazem Mohamed Abuelfotoh (Amazon) — the same reporter from the SpecJBB regression, this time on the other side of a tuning tradeoff.

## What it taught us

**Removing a static threshold can remove a workload's only defense, even when the threshold looks like dead weight in isolation.** `sysctl_sched_migration_cost`'s gating condition wasn't doing anything sophisticated — but for a wakeup-storm workload, "do nothing sophisticated but at least do it rarely" was load-bearing.

**A cost estimator that only tracks successful, expensive operations has a blind spot for cheap operations that fail constantly.** The original `max_newidle_lb_cost` model assumed the thing worth avoiding was a *slow* balance attempt; the actual regression came from a *fast* balance attempt that simply ran far too often, a failure mode the existing accounting had no way to see.

**A fix that clearly solves the reported bug can still be the wrong fix, if it changes behavior for every domain rather than just the one that regressed.** Mason's cost-bump applied globally, and it happened to hurt exactly the kind of low-success-but-worthwhile newidle balance that database workloads rely on — a cost that never showed up on `schbench`, because `schbench`'s newidle balances are worthless almost by construction.

!!! warning "A revert is real signal, not scheduler-tuning-as-usual"
    This case is a genuine correction, not two independent improvements landing back to back: Mason's fix was reverted specifically because it regressed a different, equally real class of workload. The lesson isn't "scheduler heuristics get iterated on" in the abstract — it's that a newidle-balance fix validated against one synthetic wakeup-storm benchmark said nothing about its effect on database workloads until production reports came in from four separate vendors.

## See also

- [Scheduler Overview](../README.md) — load balancing and the scheduling-domain hierarchy
- [Scheduler Evolution](../scheduler-evolution.md) — how CFS's balancing logic has changed over time

## External references

- [git.kernel.org: 155213a2aed4](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=155213a2aed42c85361bf4f5c817f5cb68951c3b) — "sched/fair: Bump sd->max_newidle_lb_cost when newidle balance fails," Chris Mason's fix, with the full `schbench` bisection writeup
- [git.kernel.org: d206fbad9328](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d206fbad9328ddb68ebabd7cf7413392acd38081) — "sched/fair: Revert max_newidle_lb_cost bump," Peter Zijlstra's revert, with the SpecJBB regression reports
- [git.kernel.org: 33cf66d88306](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=33cf66d88306663d16e4759e9d24766b0aaa2e17) — "sched/fair: Proportional newidle balance," Peter Zijlstra's replacement fix introducing `NI_RANDOM`, with before/after `schbench` and SpecJBB measurements
