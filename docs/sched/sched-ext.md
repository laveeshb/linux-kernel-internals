# sched_ext: BPF-Programmable Scheduling

> How a standing "no" to pluggable schedulers became a "yes" in Linux 6.12

## What it is

`sched_ext` (SCX) is a sixth [scheduler class](scheduler-classes.md). Unlike the others, its scheduling policy isn't compiled into the kernel — it's a BPF program, loaded and unloaded from userspace like any other BPF object. Writing a new CPU scheduler for Linux no longer requires patching and rebuilding the kernel; it means writing a BPF program against a fixed set of callbacks and loading it.

It isn't a peer of `fair`, `rt`, and `deadline` in priority, though: the kernel's own scheduler-class linkage (`include/asm-generic/vmlinux.lds.h`'s `SCHED_DATA`) orders the classes `stop → dl → rt → fair → ext → idle`. A CPU only ever looks at `ext` for a task to run after `deadline`, `rt`, and `fair` have nothing runnable — sched_ext sits just above `idle`, not alongside the established three.

`kernel/sched/ext.c` is absent from the Linux v6.11 tag and present in v6.12, confirming the class merged in **Linux 6.12** (November 2024).

## A standing "no"

Loadable, pluggable scheduling policy is not a new idea — it's one Linus Torvalds had rejected before. When Tejun Heo first posted the sched_ext patch set (co-written with David Vernet, Josh Don, and Barret Rhoden), scheduler maintainer Peter Zijlstra's response was blunt:

> "I hate all of this. Linus NAK'ed loadable schedulers a number of times in the past and this is just that again -- with the extra downside of the whole BPF thing on top."
>
> — [Peter Zijlstra, replying to the first posted version](https://lwn.net/ml/linux-kernel/Y5b2btWFJeEfTyJg@hirez.programming.kicks-ass.net/)

That single sentence carries the whole prior history: this wasn't the first attempt at pluggable scheduling, and every previous one had been turned down by Torvalds himself. The objection wasn't really about BPF — it was about the scheduler, of all subsystems, being opened up to third-party policy at all. A misbehaving scheduler doesn't crash a program; it can wedge the entire machine.

## The 2024 override

Despite that, Torvalds decided to merge it anyway — over the scheduler maintainer's own objection. LWN reported in June 2024 that he'd made his decision and would override the scheduler maintainer to merge it, quoting Torvalds' own reasoning directly:

> "I honestly see no reason to delay this any more. This whole patchset was the major (private) discussion at last year's kernel maintainer summit, and I don't find any value in having the same discussion (whether off-list or as an actual event) at the upcoming maintainer summit one year later, so to make any kind of sane progress, my current plan is to merge this for 6.11."

Torvalds is explicit that this was a "(private)" discussion, not a formal agenda item — and LWN's own published coverage of the [2023 Kernel Maintainers Summit](https://lwn.net/Articles/951847/) is consistent with that: the day's listed sessions were filesystem maintenance, committing to Rust, maintainer burnout, and a Q&A on maintainer pain points. sched_ext isn't among them. Whatever conversation Torvalds is referring to happened outside the summit's reported agenda, which is weaker evidence than "the whole kernel community spent a Maintainer Summit's worth of formal time on it" — it's his own stated reason for not wanting to repeat an off-the-record discussion, not a documented consensus-seeking process.

The override didn't stick on the first try, either. Torvalds' announcement above named 6.11 as the target, but [LWN's coverage of the actual 6.11 merge window](https://lwn.net/Articles/982605/) tells a different story: "After that came a strongly worded discussion about whether that step was justified, or whether sched_ext needed more work first... sched_ext was not merged for 6.11." The override triggered real, substantive pushback, not a routine slip — `kernel/sched/ext.c` didn't land until the following cycle, 6.12, in November 2024.

## How it actually works

A BPF scheduler is a `struct sched_ext_ops` instance — a set of callbacks the kernel invokes at each point in a task's scheduling lifecycle. The real struct, defined in `kernel/sched/ext.c`, includes (among others):

```c
/* kernel/sched/ext.c */
struct sched_ext_ops {
    s32  (*select_cpu)(struct task_struct *p, s32 prev_cpu, u64 wake_flags);
    void (*enqueue)(struct task_struct *p, u64 enq_flags);
    void (*dequeue)(struct task_struct *p, u64 deq_flags);
    void (*dispatch)(s32 cpu, struct task_struct *prev);
    void (*tick)(struct task_struct *p);
    void (*runnable)(struct task_struct *p, u64 enq_flags);
    void (*running)(struct task_struct *p);
    void (*stopping)(struct task_struct *p, bool runnable);
    void (*quiescent)(struct task_struct *p, u64 deq_flags);
    bool (*yield)(struct task_struct *from, struct task_struct *to);
    bool (*core_sched_before)(struct task_struct *a, struct task_struct *b);
    void (*set_weight)(struct task_struct *p, u32 weight);
    s32  (*init_task)(struct task_struct *p, struct scx_init_task_args *args);
    /* ... dump()/dump_cpu()/dump_task() for debugging, cgroup callbacks,
       cpu_online()/cpu_offline(), and more, in between ... */
    s32  (*init)(void);
    void (*exit)(struct scx_exit_info *info);
};
```

The lifecycle for a single wakeup: `select_cpu()` picks a target CPU (this is where a scheduler might implement its own idle-CPU search), `enqueue()` places the task somewhere the scheduler chooses, and `dispatch()` is called whenever a CPU's local dispatch queue runs empty — including when the previously-running task's time slice ran out but it's still runnable, not only when the CPU is truly idle. A scheduler doesn't manage its own run queue data structure from scratch — it moves tasks between **dispatch queues (DSQs)**, `struct scx_dispatch_q` in the kernel. A DSQ isn't strictly a FIFO or a priority queue; per the kernel's own documentation, a single DSQ "can operate as both a FIFO and a priority queue" at once, with vtime-ordered entries (`scx_bpf_dispatch_vtime()`) always consumed after plain FIFO ones. Every CPU has its own built-in **local DSQ** (`SCX_DSQ_LOCAL`) that it always runs tasks from, plus a single built-in **global DSQ** (`SCX_DSQ_GLOBAL`) shared by all CPUs as a default landing spot; a scheduler is free to create additional DSQs for per-cgroup or other custom queuing, which get "consumed" into a CPU's local DSQ to actually run.

## The safety model

Letting a BPF program make scheduling decisions is only tenable if a broken one can't hang the machine. Two independent mechanisms enforce that:

**The BPF verifier** rejects at load time any program that could loop unboundedly, access memory it shouldn't, or otherwise violate BPF's usual safety guarantees — the same verifier that gates every other BPF program type.

**The watchdog** catches misbehavior the verifier can't: a scheduler that's fully valid BPF but simply never dispatches a runnable task. `kernel/sched/ext.c`'s watchdog periodically walks each runqueue's runnable list and checks how long each task has waited, capped at `SCX_WATCHDOG_MAX_TIMEOUT` — 30 seconds:

```c
/* kernel/sched/ext.c (simplified) */
static bool check_rq_for_timeouts(struct rq *rq)
{
    list_for_each_entry(p, &rq->scx.runnable_list, scx.runnable_node) {
        if (time_after(jiffies, p->scx.runnable_at + scx_watchdog_timeout)) {
            scx_ops_error_kind(SCX_EXIT_ERROR_STALL,
                               "%s[%d] failed to run for %u.%03us", ...);
            return true;
        }
    }
    return false;
}
```

A stall doesn't trigger an immediate, synchronous flip to CFS — `scx_ops_error_kind()` queues a disable request onto a kernel thread's work queue (`kthread_queue_work()`), which then runs `scx_ops_disable_workfn()`. That function's first substantive step is **bypass mode**: `scx_ops_bypass(true)` marks every runqueue `SCX_RQ_BYPASSING`, and sched_ext's own dispatch logic starts ignoring the BPF scheduler's decisions in favor of a hardcoded global FIFO — guaranteeing forward progress as soon as that queued work runs, without waiting for anything else to unload. The same function then does the slower, full teardown: it walks every task still on the SCX class and recomputes its scheduler class via the core scheduler's `__setscheduler_class()`, which checks deadline and RT priority first and only falls through to `&fair_sched_class` — [EEVDF](eevdf.md) — once neither applies and SCX itself is being torn down. The BPF scheduler is unloaded, and every task it owned lands back on EEVDF until a new one is loaded.

There's also a manual escape hatch that doesn't depend on the watchdog or the verifier at all: pressing the `SysRq-S` key sequence aborts the running BPF scheduler and reverts every task to CFS immediately, the same as a detected stall or scheduler-triggered error. A companion `SysRq-D` dumps sched_ext's internal debug state without terminating the scheduler, for diagnosing a problem without losing it.

## Real-world adoption

At the 2024 Linux Plumbers Conference, Tejun Heo described real deployments, not hypotheticals: `scx_layered` was already running on **over one million machines**, delivering measurable performance gains; `scx_lavd` was headed for shipment on Valve's **Steam Deck**; and `scx_bpfland` was showing promising results for general desktop use. By late 2024, sched_ext support was shipping in CachyOS, Arch Linux, Ubuntu, Fedora, Nix, and openSUSE — on those distributions, trying a different scheduler is a package install and a command, not a kernel rebuild.

## Where it's heading

Heo's own framing of the future work is **composability**: letting multiple BPF schedulers cooperate instead of one program owning every decision. The stated goal is for one scheduler to focus on time-slice policy while another handles load balancing or partitioning, and eventually for schedulers to stack down the cgroup hierarchy — a different scheduler responsible for each level.

## Further reading

### Kernel source

Links pinned to the **v6.12** tag — several of these names have since been renamed (e.g. `scx_ops_bypass()` → `scx_bypass()`, `scx_ops_disable_workfn()` → `scx_disable_workfn()` as of v6.13), so a HEAD-tracking link would show different names than described above.

- [kernel/sched/ext.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/ext.c?h=v6.12) — the sched_ext implementation: `struct sched_ext_ops`, dispatch queues, the watchdog, bypass mode, and the `SysRq-S`/`SysRq-D` handlers
- [include/linux/sched/ext.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/sched/ext.h?h=v6.12) — `struct scx_dispatch_q` and other public sched_ext types
- [Documentation/scheduler/sched-ext.rst](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/scheduler/sched-ext.rst?h=v6.12) — the kernel's own design document: DSQ semantics, the FIFO-and-priority-queue behavior, and the three conditions that abort a BPF scheduler
- [include/asm-generic/vmlinux.lds.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/asm-generic/vmlinux.lds.h?h=v6.12) — `SCHED_DATA`, the linker-enforced scheduler class ordering (`stop → dl → rt → fair → ext → idle`)

### LWN articles

- [The extensible scheduler class](https://lwn.net/Articles/922405/) (February 2023) — Jonathan Corbet's review of the second posted version, including Zijlstra's "I hate all of this" response to the first
- [Extensible scheduler class to be merged for 6.11](https://lwn.net/Articles/978007/) (June 2024) — Torvalds' override announcement, in his own words
- [The rest of the 6.11 merge window](https://lwn.net/Articles/982605/) (August 2024) — the actual outcome: "sched_ext was not merged for 6.11" after a "strongly worded discussion"
- [sched: Implement BPF extensible scheduler class](https://lwn.net/Articles/978911/) — Tejun Heo's v7 (final) patch-series cover letter, posted 18 June 2024, ahead of the attempted 6.11 merge
- [The 2023 Kernel Maintainers Summit](https://lwn.net/Articles/951847/) (November 2023) — LWN's published coverage of the summit's actual agenda, which does not list sched_ext
- [Sched_ext at LPC 2024](https://lwn.net/Articles/991205/) — real deployment numbers (scx_layered, scx_lavd/Steam Deck) and the composability roadmap

### Mailing list

- [Peter Zijlstra's "I hate all of this" reply](https://lwn.net/ml/linux-kernel/Y5b2btWFJeEfTyJg@hirez.programming.kicks-ass.net/) — via LWN's own mailing-list mirror, his response to the first posted version of the patch set

### Related pages

- [Scheduler Classes](scheduler-classes.md) — how sched_ext fits alongside the other five classes
- [EEVDF](eevdf.md) — where a task's scheduler class resolves to once sched_ext is disabled
- [Scheduler Evolution](scheduler-evolution.md) — the O(1) → CFS → EEVDF history this class sits alongside
