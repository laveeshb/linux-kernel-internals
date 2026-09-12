# sched_ext: BPF-Programmable Scheduling

> How a standing "no" to pluggable schedulers became a "yes" in Linux 6.12

## What it is

`sched_ext` (SCX) is a sixth [scheduler class](scheduler-classes.md), sitting at the same layer as `fair`, `rt`, and `deadline`. Unlike the others, its scheduling policy isn't compiled into the kernel — it's a BPF program, loaded and unloaded from userspace like any other BPF object. Writing a new CPU scheduler for Linux no longer requires patching and rebuilding the kernel; it means writing a BPF program against a fixed set of callbacks and loading it.

`kernel/sched/ext.c` is absent from the Linux v6.11 tag and present in v6.12, confirming the class merged in **Linux 6.12** (November 2024).

## A standing "no"

Loadable, pluggable scheduling policy is not a new idea — it's one Linus Torvalds had rejected before. When Tejun Heo first posted the sched_ext patch set, scheduler maintainer Peter Zijlstra's response was blunt:

> "I hate all of this. Linus NAK'ed loadable schedulers a number of times in the past and this is just that again -- with the extra downside of the whole BPF thing on top."

That single sentence carries the whole prior history: this wasn't the first attempt at pluggable scheduling, and every previous one had been turned down by Torvalds himself. The objection wasn't really about BPF — it was about the scheduler, of all subsystems, being opened up to third-party policy at all. A misbehaving scheduler doesn't crash a program; it can wedge the entire machine.

## The 2024 override

Despite that, Torvalds decided to merge it anyway — over the scheduler maintainer's own objection. LWN reported in June 2024 that he'd made his decision and would override the scheduler maintainer to merge it, quoting Torvalds' own reasoning directly:

> "I honestly see no reason to delay this any more. This whole patchset was the major (private) discussion at last year's kernel maintainer summit, and I don't find any value in having the same discussion (whether off-list or as an actual event) at the upcoming maintainer summit one year later, so to make any kind of sane progress, my current plan is to merge this for 6.11."

Two things stand out. First, this had already been the dominant topic of discussion at an entire Maintainer Summit — a whole community of senior kernel developers had spent real time on it without reaching consensus, which is exactly the situation a BDFL override exists for. Second, Torvalds' own timeline slipped: he announced the 6.11 merge in June 2024, but `kernel/sched/ext.c` didn't actually land until 6.12 that November — even the override took an extra cycle to land cleanly.

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
    s32  (*init)(void);
    void (*exit)(struct scx_exit_info *info);
    /* ... dump()/dump_cpu()/dump_task() for debugging, and more ... */
};
```

The lifecycle for a single wakeup: `select_cpu()` picks a target CPU (this is where a scheduler might implement its own idle-CPU search), `enqueue()` places the task somewhere the scheduler chooses, and `dispatch()` is called when a CPU is about to go idle and needs a task handed to it. A scheduler doesn't manage its own run queue data structure from scratch — it moves tasks between **dispatch queues (DSQs)**, `struct scx_dispatch_q` in the kernel, each either a plain FIFO or ordered by a scheduler-assigned virtual time (`scx_bpf_dispatch_vtime()`). The built-in global DSQ (`SCX_DSQ_GLOBAL`) is always available as a default landing spot; a scheduler is free to create its own DSQs for per-CPU, per-cgroup, or arbitrary custom queuing.

## The safety model

Letting a BPF program make scheduling decisions is only tenable if a broken one can't hang the machine. Two independent mechanisms enforce that:

**The BPF verifier** rejects at load time any program that could loop unboundedly, access memory it shouldn't, or otherwise violate BPF's usual safety guarantees — the same verifier that gates every other BPF program type.

**The watchdog** catches misbehavior the verifier can't: a scheduler that's fully valid BPF but simply never dispatches a runnable task. `kernel/sched/ext.c`'s watchdog periodically walks each runqueue's runnable list and checks how long each task has waited:

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

A stall triggers a two-stage response, not a single "fall back to CFS" flip. The immediate reaction is **bypass mode**: `scx_ops_bypass(true)` marks every runqueue `SCX_RQ_BYPASSING`, and sched_ext's own dispatch logic starts ignoring the BPF scheduler's decisions in favor of a hardcoded global FIFO — guaranteeing forward progress synchronously, without waiting for anything to unload. Only after that safety valve is in place does `scx_ops_disable_workfn()` do the slower, full teardown: it walks every task still on the SCX class and recomputes its scheduler class via the core scheduler's `__setscheduler_class()`, which checks deadline and RT priority first and only falls through to `&fair_sched_class` — [EEVDF](eevdf.md) — once neither applies and SCX itself is being torn down. The BPF scheduler is unloaded, and every task it owned lands back on EEVDF until a new one is loaded.

## Real-world adoption

At the 2024 Linux Plumbers Conference, Tejun Heo described real deployments, not hypotheticals: `scx_layered` was already running on **over one million machines**, delivering measurable performance gains; `scx_lavd` was headed for shipment on Valve's **Steam Deck**; and `scx_bpfland` was showing promising results for general desktop use. By late 2024, sched_ext support was shipping in CachyOS, Arch Linux, Ubuntu, Fedora, Nix, and openSUSE — on those distributions, trying a different scheduler is a package install and a command, not a kernel rebuild.

## Where it's heading

Heo's own framing of the future work is **composability**: letting multiple BPF schedulers cooperate instead of one program owning every decision. The stated goal is for one scheduler to focus on time-slice policy while another handles load balancing or partitioning, and eventually for schedulers to stack down the cgroup hierarchy — a different scheduler responsible for each level.

## Further reading

### Kernel source

- [kernel/sched/ext.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/ext.c) — the sched_ext implementation: `struct sched_ext_ops`, dispatch queues, the watchdog, and bypass mode
- [include/linux/sched/ext.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/sched/ext.h) — `struct scx_dispatch_q` and other public sched_ext types

### LWN articles

- [The extensible scheduler class](https://lwn.net/Articles/922405/) (2023) — Zijlstra's "I hate all of this" review of the first posted version
- [Extensible scheduler class to be merged for 6.11](https://lwn.net/Articles/978007/) (June 2024) — Torvalds' override announcement, in his own words
- [sched: Implement BPF extensible scheduler class](https://lwn.net/Articles/978911/) (2024) — the merge-commit mailing list crosspost, naming Tejun Heo as author
- [Sched_ext at LPC 2024](https://lwn.net/Articles/991205/) — real deployment numbers (scx_layered, scx_lavd/Steam Deck) and the composability roadmap

### Mailing list

- [\[PATCH 12/34\] sched_ext: Implement BPF extensible scheduler class](https://lkml.iu.edu/hypermail/linux/kernel/2308.2/00511.html) — the original August 2023 patch series posting

### Related pages

- [Scheduler Classes](scheduler-classes.md) — how sched_ext fits alongside the other five classes
- [EEVDF](eevdf.md) — where a task's scheduler class resolves to once sched_ext is disabled
- [Scheduler Evolution](scheduler-evolution.md) — the O(1) → CFS → EEVDF history this class sits alongside
