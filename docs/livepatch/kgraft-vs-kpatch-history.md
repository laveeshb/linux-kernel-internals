# kGraft vs. kpatch: How Two Rivals Became One Upstream

> SUSE and Red Hat each built a live-patching mechanism in 2014, on genuinely different technical models — the merged result kept both, and took until 2017 to actually finish

## Two answers to the same question, weeks apart

The problem both projects set out to solve wasn't new: the Ksplice patch set had offered live kernel patching since 2008, but it never reached mainline, and after Oracle acquired the company behind it in 2011 it largely disappeared from the Linux ecosystem — leaving the underlying need unmet ([LWN, "The initial kGraft submission"](https://lwn.net/Articles/596854/)). In 2014, SUSE and Red Hat each independently built and open-sourced a new mechanism to fill that gap, and the two were not compatible with each other.

SUSE announced **kGraft** first: [LWN's coverage is dated February 3, 2014](https://lwn.net/Articles/584016/), quoting SUSE's own description of building on "ftrace and its mcount-based reserved space in function headers, the INT3/IPI-NMI patching also used in jumplabels, and RCU-like update of code that does not require stopping the kernel." The actual code followed about three months later — Jonathan Corbet's coverage of ["the initial kGraft submission"](https://lwn.net/Articles/596854/) (April 30, 2014) is direct about authorship: "KGraft is the work of Jiří Kosina and Jiří Slaby, both working at SUSE." The basic kGraft mechanism was, in Corbet's own qualified phrase, "only a 600-line patch" — a description of that initial patch itself, not of everything kGraft would go on to include.

Red Hat's **kpatch** followed within days. Corbet's coverage of ["the first kpatch submission"](https://lwn.net/Articles/597407/) (May 7, 2014) opens by noting the timing directly: "Last week saw the posting of SUSE's kGraft live-patching mechanism; shortly thereafter, developers at Red Hat came forward with their competing kpatch mechanism," and names the two authors directly: "kpatch developer Josh Poimboeuf" and "kGraft developer Jiri Kosina." Poimboeuf's own cover letter — ["\[RFC PATCH 0/2\] kpatch: dynamic kernel patching"](https://lkml.iu.edu/hypermail/linux/kernel/1405.0/00278.html), posted to the kernel mailing list on 1 May 2014 — opens "Since Jiri posted the kGraft patches, I wanted to share an alternative live patching solution called kpatch." (The Seth Jennings commit discussed below, by contrast, is the later, separate *merged* livepatch core that both projects' code fed into — not kpatch itself.) Both mechanisms used the same underlying primitive — ftrace's function-entry hook, the same mechanism [covered in depth on this site's own KLP page](klp.md) — but they solved the hard problem, *when is it safe to switch a task from the old function to the new one*, in genuinely different ways.

## Two different answers to "when is it safe to switch"

LWN's later retrospective on the unification effort lays out the technical distinction precisely:

> As originally developed, kpatch worked by calling `stop_machine()` to bring the entire system to a halt. It then would check the stack of every process in the system to ensure that none are running within the function(s) to be patched; if the affected functions are not currently running, the patch can proceed, otherwise the operation fails. KGraft, instead, used a "two-universe" model where every process in the system is switched from the old code to the new at a "safe" point. The most common safe point is exit from a system call; at that point, the process cannot be running in any kernel code.

— [LWN, "A rough patch for live patching"](https://lwn.net/Articles/634649/)

Neither approach was strictly better, and each had a real failure mode the other didn't. kpatch's stack-check bought precision — a task could be patched the instant it was provably safe — at the cost of a stop-the-world pause and an outright hard failure case: as Corbet put it, "if kernel code is running inside one of the target functions, kpatch will simply fail," and some functions (`schedule()`, `do_wait()`, `irq_thread()` among the examples given) are essentially always running somewhere in the kernel, meaning kpatch alone could never apply a patch that touched them — though Corbet also gave the practical scope: "on a typical system, there will probably be a few dozen functions that can block a live patch in this way — a pretty small subset of the thousands of functions in the kernel" ([LWN](https://lwn.net/Articles/597407/)). kGraft's per-task, syscall-exit migration avoided that hard failure, but the cost it paid was more than bookkeeping: because a task only transitions at a safe point like syscall exit, "the process of trapping every process in a safe place can take an unbounded period of time during which the system is in a weird intermediate state" ([LWN, "A rough patch for live patching"](https://lwn.net/Articles/634649/)). That guarantee also had a real implementation cost — kGraft hand-modified `kthread_should_stop()` and inserted `kgr_task_safe()` calls by hand into the kernel threads that don't make that call — and an unresolved edge case: a process blocked on I/O "could remain in the kernel for a long time, preventing the cleanup of the graft operation," with no forced-transition mechanism actually present in the posted patch set ([LWN, "The initial kGraft submission"](https://lwn.net/Articles/596854/)).

## The unification: LPC 2014, and a proposal before the merge

The two projects converged in public at the [2014 Linux Plumbers Conference](https://blog.linuxplumbersconf.org/2014/), held October 15–17 in Düsseldorf, Germany — Seth Jennings' own cover letter for the eventual merged patch set says so directly: "This solution was discussed in the Live Patching Mini-conference at LPC 2014" ([LWN, "Kernel Live Patching"](https://lwn.net/Articles/619390/), a mirror of the patch posting dated 6 November 2014).

That November posting — sent by Jennings to Josh Poimboeuf, Jiri Kosina, Vojtech Pavlik, and ftrace maintainer Steven Rostedt — is the actual merger proposal, and its own description of the scope is blunt about what it does and doesn't attempt: "It represents the greatest common functionality set between kpatch \[...\] and kGraft \[...\] and can accept patches built using either method." It's also explicit that this first version implements no consistency model at all — the same disclaimer, word for word, carried over into the commit message when the patch was actually merged, quoted in full below.

## What actually landed first: no consistency model at all

The code that became upstream `kernel/livepatch/` was authored by Seth Jennings on 16 December 2014 and committed six days later by SUSE's Jiri Kosina, as committer of record, into the `jikos/livepatching` subsystem tree on 22 December 2014 — the patch's own ABI documentation stamps `KernelVersion: 3.19.0`, meaning it was aimed at whatever release was then in development. It didn't reach mainline immediately: Linus pulled the `jikos/livepatching` tree on 10 February 2015, during the 4.0 merge window, which is why `kernel/livepatch/core.c` is absent from the Linux **v3.19** tag and present at **v4.0** (released 12 April 2015). The commit's own message is explicit about a real limitation this first cut accepted:

> This first version does not implement any consistency mechanism that ensures that old and new code do not run together. In practice, ~90% of CVEs are safe to apply in this way, since they simply add a conditional check. However, any function change that can not execute safely with the old version of the function can *not* be safely applied in this version.

— [commit `b700e7f03df5`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b700e7f03df5d92f85fa5247fe1f557528d3363d), Seth Jennings

Kosina's own note on the commit explains why SUSE ended up as co-copyright holder despite Jennings (Red Hat) being the patch's author: "due to the number of contributions that got folded into this original patch from Seth Jennings, add SUSE's copyright as well, as discussed via e-mail." Kosina (SUSE) is the committer of record. The commit's trailers, in order, read as a joint SUSE/Red Hat roster: Signed-off-by from Jennings and Poimboeuf (Red Hat, kpatch), then Reviewed-by from Miroslav Beneš, Petr Mladek (both SUSE), and Masami Hiramatsu (Hitachi — neither SUSE nor Red Hat), then a second round of Signed-off-by from Beneš, Mladek, and Kosina (all SUSE) — Beneš and Mladek show up twice, both reviewing the patch and signing off on it.

## The real hybrid took over two years to land

A proper consistency model — one that actually combined the two projects' techniques rather than deferring the question — was proposed on 9 February 2015: Josh Poimboeuf posted his RFC patch set the day *before* the livepatch core itself actually reached mainline. LWN reported that the patch set "retains the two-universe model from kGraft, but it uses the stack-trace checking from kpatch to accelerate the task of switching processes to the new code" ([LWN, "A rough patch for live patching"](https://lwn.net/Articles/634649/)) — but getting it upstream took far longer than the initial merge had.

`kernel/livepatch/transition.c`, the file that implements this per-task consistency model, is absent from the Linux **v4.11** tag and present at **v4.12** — the mechanism didn't actually ship until kernel 4.12, released 2 July 2017, roughly two and a half years after both the RFC and the 4.0 mainline merge (the two events landed a single day apart). The final commit's message states its lineage without ambiguity:

> This code stems from the design proposal made by Vojtech \[1\] in November 2014. It's a hybrid of kGraft and kpatch: it uses kGraft's per-task consistency and syscall barrier switching combined with kpatch's stack trace switching.

— [commit `d83a7cb375ee`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d83a7cb375eec21f04c83542395d08b2f6641da2), "livepatch: change to a per-task consistency model," Josh Poimboeuf, authored 13 February 2017

That footnoted "\[1\]" points to a specific document — Vojtech Pavlik's own design proposal, [posted to the kernel mailing list on 7 November 2014](https://lkml.kernel.org/r/20141107140458.GA21774@suse.cz) — a separate posting from Jennings' merger cover letter one day earlier; the two are easy to conflate but describe different things (Jennings proposed merging the two existing mechanisms as-is; Pavlik proposed the hybrid design that `d83a7cb375ee` actually implemented two and a half years later). Notably, the final commit also carries `Acked-by: Ingo Molnar <mingo@kernel.org> # for the scheduler changes` — the same Molnar who, as covered below, argued the entire live-patching premise was misguided.

Concretely, the shipped mechanism (`klp_try_switch_task()`, `klp_check_stack()` in `kernel/livepatch/transition.c`) tries kpatch's stack-check first — if none of a sleeping task's stack frames are in a patched function, it's switched immediately — and falls back to kGraft's syscall-exit/interrupt-return safe points for tasks that don't sleep predictably. [This site's own KLP Consistency Model page](klp-consistency.md) covers that mechanism — the `patch_state` field, the transition states, and the fallback rules — in full technical depth; this page is the story of how it came to exist as a merger of two competing designs rather than a single invention.

## Why the gap: nobody trusted the stack unwinder yet

The two-and-a-half-year gap wasn't inertia — Poimboeuf's hybrid design ran into real, specific technical objections almost immediately, and they took years to actually resolve, not just negotiate away. Corbet's February 2015 coverage of the proposal names the objection precisely: adopting kpatch's stack-trace check meant depending on the stack unwinder for *correctness*, not just for debug output, and Peter Zijlstra said so bluntly:

> So far stack unwinding has basically been a best effort debug output kind of thing, you're wanting to make the integrity of the kernel depend on it. You require an absolute 100% correctness of the stack unwinder — where today it is; as stated above; a best effort debug output thing. That is a *big* change.

— [LWN, "A rough patch for live patching"](https://lwn.net/Articles/634649/)

Ingo Molnar raised the same concern from a different angle — getting a genuinely reliable stack trace out of a process running in kernel space was known to be hard, with a real history of bugs and per-architecture quirks — and then went further, proposing to abandon both projects' designs entirely: "I think they are fundamentally misguided in both implementation and in design, which turns them into an (unwilling) extended arm of the security theater," suggesting live-state kexec (saving system state, booting a new kernel, and restoring it) as an alternative to any consistency model at all ([LWN](https://lwn.net/Articles/634649/)). That proposal didn't win, but it underlines that the disagreement wasn't cosmetic — a respected kernel developer was arguing the entire live-patching premise was the wrong approach, not just quibbling over which project's technique to keep.

That's the real reason the final 2017 commit gates the whole stack-check path behind a specific, named capability: "This option is only available if the architecture has reliable stacks (`HAVE_RELIABLE_STACKTRACE`)" ([commit `d83a7cb375ee`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d83a7cb375eec21f04c83542395d08b2f6641da2)). Making stack unwinding provably reliable — not merely best-effort — was the actual multi-year prerequisite hiding behind the "consistency model" line item, not a lack of agreement on what to build. At the moment of the 4.12 merge, though, only x86_64 actually cleared that bar: `arch/x86/Kconfig` gates `HAVE_RELIABLE_STACKTRACE` behind `X86_64 && FRAME_POINTER && STACK_VALIDATION`, and arm64, powerpc, and s390 didn't declare support for years afterward. "Finished in 2017" means the mechanism and its x86_64 gate landed then, not that every architecture could use it from day one.

The 4.12 merge wasn't the end of this mechanism's own evolution, either: the `immediate` flag it shipped with (an escape hatch to apply a patch with no consistency model at all, for patches that don't need one) was removed in Linux 4.16; the manual `SIGSTOP`/`SIGCONT` administrator workaround for stuck tasks was replaced by a "fake signal" mechanism in 4.15; and atomic replace, which removed the separate registration step this page's cited commits still require, landed in 5.1.

## Further reading

### Kernel source

- [kernel/livepatch/core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/core.c) — the original merged interface (kernel 4.0)
- [kernel/livepatch/transition.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/transition.c) — the per-task consistency model (kernel 4.12): `klp_try_switch_task()`, `klp_check_stack()`
- [commit b700e7f03df5](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=b700e7f03df5d92f85fa5247fe1f557528d3363d) — the initial merge, Seth Jennings, December 2014
- [commit d83a7cb375ee](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d83a7cb375eec21f04c83542395d08b2f6641da2) — the per-task consistency model, Josh Poimboeuf, 2017

### LWN articles

- [kGraft — live kernel patching from SUSE](https://lwn.net/Articles/584016/) — the initial kGraft coverage, February 2014
- [The first kpatch submission](https://lwn.net/Articles/597407/) — the initial kpatch coverage, May 2014
- [Kernel Live Patching](https://lwn.net/Articles/619390/) — Seth Jennings' November 2014 merger proposal, mirrored on LWN
- [A rough patch for live patching](https://lwn.net/Articles/634649/) — the technical comparison of kpatch's stack-checking vs. kGraft's two-universe model, and Poimboeuf's hybrid proposal
- [livepatch: consistency model](https://lwn.net/Articles/632582/) — Josh Poimboeuf's February 2015 RFC patch set, mirrored on LWN
- [Vojtech Pavlik's November 2014 design proposal](https://lkml.kernel.org/r/20141107140458.GA21774@suse.cz) — the direct ancestor of the hybrid design `d83a7cb375ee` implemented

### Related pages

- [Kernel Live Patching (KLP)](klp.md) — the ftrace-based redirection mechanism both kGraft and kpatch built on
- [KLP Consistency Model](klp-consistency.md) — the shipped per-task consistency mechanism this page's history led to
- [Cumulative Patches and Atomic Replace](klp-cumulative.md) — later evolution of the same framework
