# Stale ptracer Credentials

> CVE-2019-13272 — `PTRACE_TRACEME` recorded the credentials of the *parent* it drafted as tracer rather than those of the child that actually requested the relationship, so an unprivileged child could obtain a root-marked ptrace relationship no privileged code ever asked for — and keep it after that parent dropped privileges and became attacker-controlled

**Disclosed:** July 17, 2019 (fix authored July 4, 2019) &nbsp;·&nbsp; **Reported by:** Jann Horn, Google Project Zero (issue 1903) &nbsp;·&nbsp; **CVSS:** 7.8 HIGH (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H` — NVD primary and CISA-ADP's secondary score agree; CVSS 2.0: 7.2 HIGH) &nbsp;·&nbsp; **Bug present since:** 4.10 (commit `64b875f7ac8a`, November 2016) &nbsp;·&nbsp; **Fixed in:** 5.2 upstream; stable 5.1.17, 4.19.58, 4.14.133, 4.9.185, 4.4.185 (all announced July 10, 2019), 3.16.71 &nbsp;·&nbsp; **Exploit tool:** yes — four Exploit-DB entries (three PoCs, one Metasploit module) &nbsp;·&nbsp; **Actively exploited:** yes — [added to CISA's KEV catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) December 10, 2021

*Part of [War Stories: Linux Security Bugs and CVEs](../war-stories.md).*

## Before state

When one process traces another, the kernel needs to remember *how privileged the tracer was at the moment the relationship was formed*. It cannot just re-check the tracer's current credentials later, because the tracer might legitimately drop privileges after attaching — and it cannot ignore the question either, because the answer decides whether a traced process is allowed to complete a setuid `execve()` at full privilege.

Linux stores that answer in a single field on the *tracee*, added to `struct task_struct` in 2016 by [`64b875f7ac8a`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=64b875f7ac8a5d60a4e191479299e931ee949b67) ("ptrace: Capture the ptracer's creds not PT_PTRACE_CAP"):

```c
/* include/linux/sched.h */
const struct cred __rcu *ptracer_cred; /* Tracer's credentials at attach */
```

That commit replaced an older single bit, `PT_PTRACE_CAP`, whose problem was that it recorded only *whether* the tracer was capable, not *in which user namespace* — Eric Biederman's commit message notes that "this has already allowed one mistake through insufficient granularity," and that the `PTRACE_TRACEME` path had been "overlooked" when the bit was first introduced. Storing a full `struct cred` pointer fixed both, and a new helper answered the question on demand:

```c
/* kernel/capability.c */
bool ptracer_capable(struct task_struct *tsk, struct user_namespace *ns)
{
	int ret = 0;  /* An absent tracer adds no restrictions */
	const struct cred *cred;
	rcu_read_lock();
	cred = rcu_dereference(tsk->ptracer_cred);
	if (cred)
		ret = security_capable_noaudit(cred, ns, CAP_SYS_PTRACE);
	rcu_read_unlock();
	return (ret == 0);
}
```

By the 5.2 development cycle, the code that populated that field looked like this (`kernel/ptrace.c`):

```c
void __ptrace_link(struct task_struct *child, struct task_struct *new_parent,
		   const struct cred *ptracer_cred)
{
	BUG_ON(!list_empty(&child->ptrace_entry));
	list_add(&child->ptrace_entry, &new_parent->ptraced);
	child->parent = new_parent;
	child->ptracer_cred = get_cred(ptracer_cred);
}

static void ptrace_link(struct task_struct *child, struct task_struct *new_parent)
{
	rcu_read_lock();
	__ptrace_link(child, new_parent, __task_cred(new_parent));
	rcu_read_unlock();
}
```

The `ptrace_link()` wrapper had exactly two callers, and the whole bug lives in the difference between them:

```c
ptrace_link(task, current);                    /* ptrace_attach()  */
ptrace_link(current, current->real_parent);    /* ptrace_traceme() */
```

For `PTRACE_ATTACH`, `new_parent` *is* `current` — the process asking for the relationship — so `__task_cred(new_parent)` names the right process. For `PTRACE_TRACEME`, `new_parent` is `current->real_parent`, and the process asking for the relationship is the child. The wrapper recorded `new_parent`'s credentials in both cases, because it derived the credentials from the *tracer* argument rather than from the *requester*.

For background on `struct cred`, its copy-on-write discipline, and what happens to credentials across `execve()`, see [Credentials and User Namespaces](../credentials.md). The privilege-dropping pattern this bug undermines — acquire root, do the privileged work, `setuid()` back down, then `execve()` something less trusted — is covered in [Linux Capabilities](../capabilities.md#capability-based-privilege-dropping).

## The trigger

`PTRACE_TRACEME` is unusual among ptrace requests: it is issued by the *tracee*, and it does not name a tracer. The kernel picks one for you — your real parent — and the only permission check is an LSM hook, `security_ptrace_traceme(current->parent)`, which asks whether the *parent* may trace the child — never whether the child should be allowed to draft it:

```c
/* kernel/ptrace.c, ptrace_traceme() */
write_lock_irq(&tasklist_lock);
/* Are we already being traced? */
if (!current->ptrace) {
	ret = security_ptrace_traceme(current->parent);
	if (!ret && !(current->real_parent->flags & PF_EXITING)) {
		current->ptrace = PT_PTRACED;
		ptrace_link(current, current->real_parent);
	}
}
write_unlock_irq(&tasklist_lock);
```

So an unprivileged process can unilaterally cause `ptracer_cred` to be set to a *snapshot of whatever credentials its parent happens to hold at that instant*. It does not need permission to trace the parent; it does not need the parent's cooperation; the parent is not even notified.

The exploitation window is the gap in a privileged parent's lifetime between "is root" and "is no longer root." Jann Horn's [original Project Zero report](https://project-zero.issues.chromium.org/issues/42450993) (issue 1903) demonstrated it against polkit's `pkexec`: an attacker process A forks B; B forks a child C and only *then* `execve()`s `pkexec`, so C's real parent is now running as root; C calls `PTRACE_TRACEME`, and its recorded `ptracer_cred` snapshots root-owning B. C then `execve()`s a setuid binary — and because the kernel consults `ptracer_cred`, which holds *B's* root credentials rather than those of C, the process that actually requested the relationship, it treats the ptrace relationship as privileged and does not suppress the setuid transition, so C ends up running at full root while still traced. Only afterward does B drop privileges and become dumpable, at which point A can `PTRACE_ATTACH` to B and drive root-privileged C through it. Two derivative Exploit-DB proof-of-concept tools (bcoles's automated helper-targeting version of Horn's original, tested across twenty-odd distributions, and a later, three-distribution modification of bcoles's by Ujas Dhami) automated exactly this polkit-helper technique, and Rapid7 shipped it as a [Metasploit module](https://raw.githubusercontent.com/rapid7/metasploit-framework/master/modules/exploits/linux/local/ptrace_traceme_pkexec_helper.rb) in October 2019. All three of these later tools test the same local-session precondition — an `$XDG_SESSION_ID` for a non-remote login (`loginctl … Remote=no`) — but only the Metasploit module acts on it: its `check` returns `CheckCode::Safe` when `loginctl` reports `Remote=yes`, which is why it documents that it "cannot be executed over ssh." The two C proof-of-concepts merely print a warning — and likewise for SELinux's `deny_ptrace` boolean, which only they test — because `check_env()`'s return value is discarded by `main()`. Yama's `kernel.yama.ptrace_scope = 3` would block the `PTRACE_TRACEME` outright — scope 2 rejects it only when the parent lacks `CAP_SYS_PTRACE`, which the root `pkexec` parent has — yet none of those three checks the sysctl at all; neither restriction is Linux's default, which is why the bug was exploitable out of the box on most desktop and server distributions of the era.

## Observed behavior

The privilege half of this bug produced no crash, no memory corruption, no fuzzer-visible artifact — its only symptom is a permission decision coming out wrong. (A separate object-lifetime half of the same report is louder: Horn's other proof-of-concept races `setresuid()` against `PTRACE_TRACEME` and trips `put_cred_rcu()`'s panic.) A traced process could be manipulated (registers rewritten, `/proc/<pid>/mem` written, syscalls intercepted) by a "tracer" the kernel had marked privileged on the strength of credentials it never volunteered — and by the time the manipulation happened, the flesh-and-blood process behind that tracer role had dropped privileges via `setuid()`/`setgid()` and moved on to executing attacker-reachable code. NVD scores it CVSS 3.1 **7.8 HIGH** (`CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`) — local, low complexity, low privileges required, full confidentiality/integrity/availability impact, because the end state is arbitrary code execution as root.

The bug had been present since Linux **4.10**, into which [`64b875f7ac8a`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=64b875f7ac8a5d60a4e191479299e931ee949b67) — authored November 2016 — introduced `ptracer_cred` — nearly three years before Jann Horn's report. Distributions each caught up on their own schedule once the fix and CVE were public: Debian's DSA-4484 followed on July 20, Red Hat's RHSA-2019:2405 on August 7, and Ubuntu's five kernel advisories (USN-4093-1 through USN-4118-1, see External references) landed in two batches, August 13 and September 2 — a seven-week tail rather than a coordinated same-week release.

## Why it happened

The root cause is a **subject/object mismatch inside a two-caller helper function**. `ptrace_link()` was written to serve both `PTRACE_ATTACH` (where the caller and the tracer are the same process) and `PTRACE_TRACEME` (where they are not) with a single code path that assumed they always were. `__task_cred(new_parent)` is the correct credential source when `new_parent == current`; for `PTRACE_TRACEME` it silently picks the *wrong* subject — the parent, who isn't the one asking for anything — and nothing in the type system or the function's signature flagged that the assumption had been violated for one of its two call sites.

The commit that introduced `ptracer_cred`, `64b875f7ac8a`, was itself a security fix — it replaced the coarser `PT_PTRACE_CAP` bit specifically because that bit didn't distinguish *which* user namespace the tracer was capable in. Eric Biederman's message for that 2016 commit already flagged that the `PTRACE_TRACEME` path had been "overlooked" once before when `PT_PTRACE_CAP` was first added; the same call site went wrong a second time when the bit was replaced with a full credential pointer — this time not by being skipped but by being wired up with the wrong subject: `ptrace_link()`'s single credential source was correct in the common case (`PTRACE_ATTACH`) and silently wrong here. There's also a secondary, smaller bug the fix folds in: `ptrace_link()` obtained an RCU reference to the parent's credentials and then handed that pointer to `get_cred()` — and, in Jann Horn's own words from the fix's commit message, "the object lifetime rules for things like struct cred do not permit unconditionally turning an RCU reference into a stable reference" that way. That's a second reason the old code path was unsound, independent of whose credentials it was even reading.

## Resolution

[`6994eefb0053`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=6994eefb0053799d2e07cd140df6c2ea106c41ee) ("ptrace: Fix ->ptracer_cred handling for PTRACE_TRACEME"), authored by Jann Horn on July 4, 2019, collapses `ptrace_link()` to a single line:

```c
static void ptrace_link(struct task_struct *child, struct task_struct *new_parent)
{
	__ptrace_link(child, new_parent, current_cred());
}
```

`current_cred()` — the credentials of whichever process is actually executing the syscall that requests the ptrace relationship — replaces `__task_cred(new_parent)` unconditionally. For `PTRACE_ATTACH` this is a no-op, since `current` and `new_parent` were already the same process. For `PTRACE_TRACEME` it's the actual fix: the recorded credentials now belong to the child making the request, not the parent it's asking to be traced by, so a later privilege change in the parent can no longer retroactively upgrade a ptrace relationship the child itself established while unprivileged. It also sidesteps the RCU/`get_cred()` lifetime issue, since `current_cred()` needs no RCU dereference at all.

The commit carries `Fixes: 64b875f7ac8a` and `Acked-by: Oleg Nesterov <oleg@redhat.com>` — Nesterov being one of ptrace's longtime maintainers — but **no `Link:` trailer**, and no pre-merge public LKML/lore.kernel.org review thread exists for this patch — its first appearance on a public list was July 8, as one patch in each of Greg Kroah-Hartman's five stable-review series, four days after the merge. It was handled privately and merged directly: Linus committed it to mainline on July 4, it shipped in the v5.2 release on July 7, and Jann Horn's Project Zero report went public on July 17 — the fix itself was in public git history nearly two weeks before the CVE and the distro advisories caught up to it.

The fix landed in mainline for 5.2 and was backported within a week to 5.1.17, 4.19.58, 4.14.133, 4.9.185, 4.4.185, and later 3.16.71 — a wide stable-tree spread reflecting how long-lived the bug was (present in mainline since 4.10, but `64b875f7ac8a` carried `Cc: stable`, so the vulnerable code reached the 4.4, 4.9 and 3.16 stable trees too).

```bash
# Interim mitigation while unpatched: only scope 3 blocks PTRACE_TRACEME unconditionally
sysctl -w kernel.yama.ptrace_scope=3    # 0/1 do not stop this bug (1 = Ubuntu/Debian default,
                                        # restricts PTRACE_ATTACH only); 2 rejects TRACEME only
                                        # when the parent lacks CAP_SYS_PTRACE. Setting 3 is irreversible
                                        # until reboot; lower values can still be changed either way.
```

## What it taught us

**A helper function serving two call sites needs to name its actual precondition, not just satisfy the common case.** `ptrace_link()`'s bug is invisible if you only ever trace the `PTRACE_ATTACH` path; it only shows up once you ask "what does `new_parent` mean for the *other* caller?" — a question the function's own signature didn't prompt.

**A call site that was wrong once deserves an audit, not just a fix.** The commit that introduced `ptracer_cred` explicitly noted that `PTRACE_TRACEME` had already been missed once, when `PT_PTRACE_CAP` was first added, fifteen years earlier. The 2016 rewrite closed that gap and reopened it from the other side, recording credentials for `PTRACE_TRACEME` at last — but the wrong process's. Repairing a known-fragile call site is not the same as auditing it.

**Credentials must be captured from the requester, never inferred from a related process.** `current_cred()` is always the right subject for an access-control decision triggered by `current`'s own syscall; reaching across to a different task_struct for "whoever seems relevant" reintroduces exactly the kind of confused-deputy gap this bug exploited.

**A privilege-dropping pattern (`setuid()` then `execve()`) is only as safe as every relationship formed before the drop.** Ptrace isn't the only such relationship — open file descriptors, pending signals, and namespace membership all cross the same boundary — but this bug is a concrete case of one specific relationship silently carrying stale privilege forward across a drop that was supposed to end it.

!!! warning "Pattern to watch for"
    Any kernel object that snapshots "how privileged was the *other* party in this relationship at creation time" needs to record the credentials of the process making the request, not a related process picked for convenience — and needs a test for every distinct calling convention of the code that populates it, not just the most common one.

## See also

- [Credentials and User Namespaces](../credentials.md) — `struct cred`, its copy-on-write discipline, and what happens to credentials across `execve()`
- [Linux Capabilities](../capabilities.md) — the privilege-dropping pattern (`setuid()` then `execve()`) this bug undermined
- [Nested User Namespace UID/GID Mapping](nested-userns-uid-mapping.md) — another Jann Horn-reported credential/identity bug in the same era

## External references

- [NVD: CVE-2019-13272](https://nvd.nist.gov/vuln/detail/CVE-2019-13272) — CVSS 3.1 7.8 HIGH, published July 17, 2019
- [git.kernel.org: 6994eefb0053](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=6994eefb0053799d2e07cd140df6c2ea106c41ee) — "ptrace: Fix ->ptracer_cred handling for PTRACE_TRACEME"
- [git.kernel.org: 64b875f7ac8a](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=64b875f7ac8a5d60a4e191479299e931ee949b67) — "ptrace: Capture the ptracer's creds not PT_PTRACE_CAP" (2016), the commit whose `PTRACE_TRACEME` handling this bug's fix corrected
- [Google Project Zero: Issue 1903](https://project-zero.issues.chromium.org/issues/42450993) — Jann Horn's original report, including the polkit `pkexec` exploitation path (formerly `bugs.chromium.org/p/project-zero/issues/detail?id=1903`)
- [CISA: Known Exploited Vulnerabilities Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) — CVE-2019-13272 added December 10, 2021
- [Exploit-DB 47133](https://www.exploit-db.com/exploits/47133), [47163](https://www.exploit-db.com/exploits/47163), [50541](https://www.exploit-db.com/exploits/50541) — Horn's original report and PoC (47133), plus two derivatives: bcoles's automated helper-targeting version of it (47163, 2019-07-24) and Ujas Dhami's modification of bcoles's (50541, 2021-11-23)
- [Rapid7 Metasploit module: ptrace_traceme_pkexec_helper](https://raw.githubusercontent.com/rapid7/metasploit-framework/master/modules/exploits/linux/local/ptrace_traceme_pkexec_helper.rb) — Exploit-DB 47543, October 2019
- [Debian DSA-4484](https://www.debian.org/security/2019/dsa-4484), [Ubuntu USN-4093-1](https://usn.ubuntu.com/4093-1/) (and USN-4094-1, 4095-1, 4117-1, 4118-1), [Red Hat RHSA-2019:2405](https://access.redhat.com/errata/RHSA-2019:2405) — representative downstream vendor advisories, July–September 2019