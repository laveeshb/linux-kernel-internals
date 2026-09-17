# The Cost of Asking "Is There Any Work For Me?" Too Often

> Removing a stale condition around newidle-balance cost tracking fixed the bug it was meant to fix — and uncovered that a wakeup-heavy workload could spend a fifth of its CPU time just checking for work that almost never existed

Reported by
:   Chris Mason (Meta), via `schbench` benchmarking

First fix
:   commit `155213a2aed4` ("sched/fair: Bump sd->max_newidle_lb_cost when newidle balance fails"), mainline Linux 6.17 (July 2025)

Follow-up refinement
:   commit `33cf66d88306` ("sched/fair: Proportional newidle balance"), mainline (November 2025)

*Part of [War Stories: Scheduler Bugs](../war-stories.md).*

## Before state

When a CPU is about to go idle, `sched_balance_newidle()` walks up its scheduling-domain hierarchy asking each domain whether there's a runnable task somewhere it could pull over — a "newidle balance." Because this check runs on the latency-sensitive idle-entry path, each domain tracks the cost of its own newidle-balance attempts in `sd->max_newidle_lb_cost`, decaying that estimate over time, so an expensive domain can eventually be skipped rather than delaying every wakeup.

## The trigger

Chris Mason bisected a `schbench` regression to an earlier commit, `c5b0a7eefc` ("sched/fair: Remove sysctl_sched_migration_cost condition"), using a workload designed to stress exactly this path: `schbench -L -m 4 -M auto -t 256 -n 0 -r 0 -s 0` pins 4 message threads to CPUs 0-3 and spreads 1024 worker threads across the rest, all of them doing no real work — just waking each other up and going back to sleep as fast as possible. Reverting the bisected commit took throughput from 3.4M requests/second back up to 5.4M RPS on a v6.9 kernel.

## Observed behavior

`schedstat` showed roughly 100x more newidle-balance attempts than before, and profiling showed the worker threads spending about 20% of their CPU time inside newidle balancing — almost all of those attempts failing to find a busy group to pull work from. The removed condition had been silently suppressing most of this cost; once it was gone, every one of those failed "is there work for me?" checks ran at full price on a workload that, by design, almost never had a genuine answer of "yes."

## Why it happened

`sysctl_sched_migration_cost` originally gated newidle balancing as a coarse, static threshold. Removing that condition (in the earlier, since-superseded commit) was a reasonable-looking simplification on its own — but it also removed the only thing keeping newidle-balance frequency in check for a workload whose CPUs go idle and become runnable again on a timescale far shorter than any load-balance interval was designed around. Nothing about the removal was individually wrong; the cost model it left behind simply had no mechanism for penalizing a domain that keeps failing to find work, only for penalizing one that keeps succeeding slowly.

## Resolution

Mason's fix, `155213a2aed4`, changed `update_newidle_cost()` to actively raise `sd->max_newidle_lb_cost` whenever a newidle-balance attempt fails to pull a task, rather than only tracking the cost of attempts that already ran, capped by `sysctl_sched_migration_cost` (plus a small margin) so the estimate can't grow without bound. This directly discourages repeating an expensive check that keeps coming back empty.

A follow-up four months later, Peter Zijlstra's `33cf66d88306`, went further: instead of a cost-based penalty alone, it tracks each domain's newidle-balance *success rate* (`sd->newidle_ratio`) and uses that to probabilistically skip the balance attempt entirely — "throw a 1k sided dice; and only run newidle_balance according to the success rate," gated behind a new `NI_RANDOM` scheduler feature flag. Zijlstra's own measurements on the same `schbench` case showed reverting Mason's fix and adding the randomized approach instead (2.18 Mrps/s) came close to the pre-regression baseline (2.22 Mrps/s), a clear improvement over the reverted state alone (2.04 Mrps/s) — with Chris Mason himself credited as a tester on the patch.

## What it taught us

**Removing a static threshold can remove a workload's only defense, even when the threshold looks like dead weight in isolation.** `sysctl_sched_migration_cost`'s gating condition wasn't doing anything sophisticated — but for a wakeup-storm workload, "do nothing sophisticated but at least do it rarely" was load-bearing.

**A cost estimator that only tracks successful, expensive operations has a blind spot for cheap operations that fail constantly.** The original `max_newidle_lb_cost` model assumed the thing worth avoiding was a *slow* balance attempt; the actual regression came from a *fast* balance attempt that simply ran far too often, a failure mode the existing accounting had no way to see.

!!! note "A fix and its own follow-up, both real"
    This is a case where a first, targeted fix (penalize failure by cost) was good enough to ship, and a more general refinement (track success rate, skip probabilistically) arrived as a separate, later patch rather than a correction — worth noting as a normal part of how scheduler heuristics get tuned in the open, not evidence the first fix was wrong.

## See also

- [Scheduler Overview](../README.md) — load balancing and the scheduling-domain hierarchy
- [Scheduler Evolution](../scheduler-evolution.md) — how CFS's balancing logic has changed over time

## External references

- [git.kernel.org: 155213a2aed4](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=155213a2aed42c85361bf4f5c817f5cb68951c3b) — "sched/fair: Bump sd->max_newidle_lb_cost when newidle balance fails," Chris Mason's fix, with the full `schbench` bisection writeup
- [git.kernel.org: 33cf66d88306](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=33cf66d88306663d16e4759e9d24766b0aaa2e17) — "sched/fair: Proportional newidle balance," Peter Zijlstra's follow-up introducing `NI_RANDOM`, with before/after `schbench` and SpecJBB measurements
