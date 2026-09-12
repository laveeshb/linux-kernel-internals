# PREEMPT_RT: Twenty Years to Mainline

> A patch set that started in 2004, took two decades, and finally became a fully mainline kernel option in Linux 6.12 — not because of one big blocker, but a chain of smaller ones that each had to be solved first

## The short version

`CONFIG_PREEMPT_RT` turns Linux into a kernel that can give hard, worst-case latency guarantees, not just good average-case performance. It does this by replacing spinlocks with preemptible, priority-inheriting `rt_mutex`es (see [Mutex and rt_mutex](mutex.md#rt_mutex-priority-inheritance-mutex)), forcing interrupt handlers to run as preemptible threads, and breaking up the few remaining long non-preemptible sections in the kernel. The mechanism itself has been mature and in-tree, in pieces, for years. What changed in kernel **6.12** (released November 2024) is narrower and more interesting than "PREEMPT_RT finally works": it's the story of one specific, long-identified blocker — `printk()` — finally being resolved, which is what let the option actually be turned on for the first time on real architectures.

## The twenty-year timeline

The project's age is not a rhetorical exaggeration. Kernel developer Sebastian Andrzej Siewior posted the patch series that finally enabled `PREEMPT_RT` in mainline on 6 September 2024, and LWN's coverage of that posting opens with the line: ["Work on realtime preemption for the Linux kernel got its start almost exactly 20 years ago (though it had its roots in earlier work, of course)"](https://lwn.net/Articles/989212/) — dating the project to roughly 2004.

The intervening years are documented in real time on LWN. A [2009 interview with Thomas Gleixner and Ingo Molnar](https://lwn.net/Articles/319544/) — by then already years into the effort — describes them returning from an eighteen-month hiatus to "a new realtime preemption tree and a newly reinvigorated development effort," with Gleixner explaining the delay as time spent getting x86's newly-unified 32/64-bit architecture into shape first. Both Gleixner and Siewior are, and were, engineers at **Linutronix**, the real-time Linux consultancy that has employed much of the PREEMPT_RT core team for most of the project's life — the `linutronix.de` addresses are visible directly on the 2024 patch postings.

Much of the RT patch set didn't wait for a single "merge PREEMPT_RT" event to reach mainline. Pieces of it landed piecemeal over the two decades: threaded interrupt handlers, generic `rt_mutex` infrastructure (see the [PI-Mutex Origin Story](war-stories/pi-mutex-origin.md) for a specific historical incident from that work), and priority inheritance for futexes among them. By the time of the 2024 merge, the RT patch set as a *downstream tree* had been usable enough that vendors were already shipping products and distributions on top of it — the LWN comment thread on the 2024 announcement includes a user reporting six years of production PREEMPT_RT use on ARM boards. What remained out-of-tree was a shrinking, but stubborn, set of blockers that prevented the full configuration from being *enabled in mainline itself*.

## The last blocker: printk

Siewior's own words, from the patch cover letter posted to the kernel mailing list, are direct about what had been holding things up: ["The printk bits required for PREEMPT_RT are sitting in linux-next. This was the last known roadblock for PREEMPT_RT"](https://lwn.net/Articles/989211/).

The problem printk posed was structural, not incidental, and it had been identified as the blocker for a long time before it was fixed: LWN's report on a printk discussion at the 2022 Linux Plumbers Conference states plainly that "printk() represents the last piece needing changes before the [PREEMPT_]RT patches can be fully merged" — two years before that actually happened ([LWN](https://lwn.net/Articles/909980/)). Realtime preemption's whole premise is that no code path — including one triggered by an emergency, like a kernel panic trying to print a backtrace — should be able to block a high-priority task indefinitely. But `printk()` had historically done exactly that: any CPU could take a single global console lock and spend unbounded time emitting output, including from contexts where RT's rules say nothing should be allowed to run long or sleep.

The fix that emerged from that 2022 discussion, driven primarily by John Ogness and Thomas Gleixner, replaced the single global console lock with a per-console lock and a priority-based takeover protocol: each CPU wanting to print declares a priority (normal, emergency, or panic), and a `console_can_proceed()` check lets a higher-priority message preempt a lower-priority one mid-output rather than waiting for it to finish, while an actively-printing kernel thread — not just-in-time inline emission — does the unbounded I/O work itself ([LWN](https://lwn.net/Articles/909980/)).

With that piece finally ready, Siewior's message spelled out the immediate, concrete effect precisely: ["With the printk bits merged, PREEMPT_RT could be enabled on X86, ARM64 and Risc-V"](https://lwn.net/Articles/989211/). That's the actual event: not new functionality being written, but the Kconfig gate coming down on the last three architectures that had already done everything else required.

## What actually flipped in the kernel tree

The `PREEMPT_RT` Kconfig option itself isn't new in 6.12 — it's been present for years, gated behind `depends on EXPERT && ARCH_SUPPORTS_RT` in `kernel/Kconfig.preempt` (confirmed unchanged as far back as kernel 5.10). What changed is which architectures declare `ARCH_SUPPORTS_RT`. Diffing `arch/x86/Kconfig`, `arch/arm64/Kconfig`, and `arch/riscv/Kconfig` between the 6.11 and 6.12 tags shows all three architectures adding a `select ARCH_SUPPORTS_RT` line for the first time at 6.12 — before that release, the option existed in the source tree but could not actually be turned on for any architecture in mainline. This matches Siewior's own framing exactly: the printk work removed the one remaining reason those three architectures couldn't declare support.

Not every architecture got there at once. The same patch cover letter notes that "ARM and POWERPC have a few essential patches left" and that Siewior had "lost track of MIPS" — a reminder that "PREEMPT_RT merged" in 6.12 specifically means x86, arm64, and RISC-V, not universal availability.

## What this doesn't mean

Being mainline doesn't mean `PREEMPT_RT` becomes the kernel's default preemption model, or that most users will ever set `CONFIG_PREEMPT_RT=y`. It's still an explicit, `EXPERT`-gated build-time choice, because it trades throughput for worst-case latency — a tradeoff most general-purpose systems don't want. See the [Real-Time Linux Tuning Guide](../sched/rt-tuning.md) for what actually configuring and running an RT kernel involves once you've built one, and [RT Scheduler: SCHED_FIFO and SCHED_RR](../sched/rt-scheduler.md) for the scheduling side that RT workloads typically pair with `PREEMPT_RT`.

## Further reading

### LWN articles

- [The realtime preemption end game — for real this time](https://lwn.net/Articles/989212/) — Jonathan Corbet's coverage of the September 2024 patch series, including the "almost exactly 20 years" framing
- [Allow to enable PREEMPT_RT.](https://lwn.net/Articles/989211/) — Sebastian Andrzej Siewior's original patch cover letter to the kernel mailing list, 6 September 2024
- [Interview: the return of the realtime preemption tree](https://lwn.net/Articles/319544/) — a 2009 interview with Thomas Gleixner and Ingo Molnar on the project's history and pace
- [A discussion on printk()](https://lwn.net/Articles/909980/) — Jake Edge's report on the 2022 Linux Plumbers Conference discussion that produced the per-console-lock, priority-takeover redesign that unblocked PREEMPT_RT

### Kernel source

- [kernel/Kconfig.preempt](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/Kconfig.preempt) — the `PREEMPT_RT` symbol and its `depends on EXPERT && ARCH_SUPPORTS_RT` gate
- [arch/Kconfig](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/Kconfig) — where the generic `ARCH_SUPPORTS_RT` symbol itself is defined
- [arch/x86/Kconfig](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/Kconfig), [arch/arm64/Kconfig](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm64/Kconfig), [arch/riscv/Kconfig](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/riscv/Kconfig) — each `select ARCH_SUPPORTS_RT` as of kernel 6.12

### Related pages

- [Mutex and rt_mutex](mutex.md) — the priority-inheritance mutex mechanism RT relies on for spinlock replacement
- [Priority Inversion & PI Mutexes](../sched/pi-mutexes.md) — the full mechanism behind priority inheritance
- [Real-Time Linux Tuning Guide](../sched/rt-tuning.md) — running and tuning a `PREEMPT_RT` kernel in practice
- [RT Scheduler: SCHED_FIFO and SCHED_RR](../sched/rt-scheduler.md) — the scheduling classes RT workloads use
- [The PI-Mutex Origin Story](war-stories/pi-mutex-origin.md) — a historical incident from the priority-inheritance work this project produced
