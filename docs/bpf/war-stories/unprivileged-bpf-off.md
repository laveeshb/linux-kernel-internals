# Unprivileged BPF Off by Default

> Not a CVE — the hardening response to years of them, and an admission that "safely unprivileged BPF" was a goal the subsystem had stopped pursuing

**Landed:** May 11, 2021 &nbsp;·&nbsp; **Author:** Daniel Borkmann &nbsp;·&nbsp; **Merged in:** [`08389d888287`](https://github.com/torvalds/linux/commit/08389d888287c3823f80b0216766b71e17f0aba5), mainline v5.13-rc4 &nbsp;·&nbsp; **Mechanism:** `CONFIG_BPF_UNPRIV_DEFAULT_OFF` &nbsp;·&nbsp; **Context:** [LWN 796328](https://lwn.net/Articles/796328/), "Reconsidering unprivileged BPF" (Jonathan Corbet, August 2019)

*Part of [War Stories: BPF Verifier Bugs and CVEs](../war-stories.md).*

## Before state

BPF's original ambition included a specific, load-bearing claim: that the verifier could make it safe to let an *unprivileged* user load programs into the kernel. Every other incident in [this series](../war-stories.md) is a bug in the machinery built to honor that claim.

The runtime switch for it was `/proc/sys/kernel/unprivileged_bpf_disabled`, and it was a one-way latch. The sysctl table entry says so in a comment:

```c
/* kernel/sysctl.c, before the change */
	/* only handle a transition from default "0" to "1" */
	.proc_handler	= proc_dointvec_minmax,
	.extra1		= SYSCTL_ONE,
	.extra2		= SYSCTL_ONE,
```

`extra1 == extra2 == 1` means the only value the handler would accept was 1. You could turn unprivileged BPF off; you could never turn it back on without rebooting. And the compiled-in default was 0 — on.

A partial answer had already landed a year earlier. [`2c78ee898d8f`](https://github.com/torvalds/linux/commit/2c78ee898d8f10ae6fb2fa23a3fbaec96b1b7366) ("bpf: Implement CAP_BPF", merged May 2020) split the verifier's single `allow_ptr_leaks` flag into four — `allow_ptr_leaks`, `bypass_spec_v1`, `bypass_spec_v4`, `bpf_capable` — so that a process could be granted the ability to load BPF programs without also being granted the ability to bypass speculative-execution mitigations. That gave administrators a middle setting between "root" and "anyone." It did not change what happened on a machine where nobody had configured anything.

## The trigger

The argument that produced this change is older than the change, and LWN documented it in August 2019 — nearly two years before the patch — in [Reconsidering unprivileged BPF](https://lwn.net/Articles/796328/). Corbet's framing:

> A recent discussion has made it clear, though, that the goal of opening up BPF to unprivileged users has been abandoned as unachievable, and that further work in that direction will not be accepted by the BPF maintainer.

Andy Lutomirski's objection is worth preserving because the disagreement was never actually resolved on the merits — it was resolved by shipping a knob:

> I hope not. There are a couple setsockopt uses right now, and and seccomp will surely want it someday. And the bpf-inside-container use case really is unprivileged bpf -- containers are, in many (most?) cases, explicitly not trusted by the host.

BPF maintainer Alexei Starovoitov replied that, as Corbet summarizes it, "Linux has become a single-user system" in which any code execution at all is a path to root. He continued:

> When we say 'unprivileged bpf' we really mean arbitrary malicious bpf program. It's been a constant source of pain. The constant blinding, randomization, verifier speculative analysis, all spectre v1, v2, v4 mitigations are simply not worth it. It's a lot of complex kernel code without users. There is not a single use case to allow arbitrary malicious bpf program to be loaded and executed.

Lutomirski's counter-counter: "There aren't major unprivileged eBPF users because the kernel support isn't there."

Corbet ends the 2019 article without picking a side, but names the stakes precisely:

> At its core, it's a fundamental difference of opinion over whether a Linux system can ever be truly hardened against an unprivileged user. If the answer is "no", then there is little point in maintaining a lot of complex code in the BPF subsystem to try to effect that hardening. Accepting that answer, though, is tantamount to saying that the Linux privilege model just doesn't work in the end: the combination of software bugs and hardware vulnerabilities will always undermine it, so we might as well just give up. That would be a discouraging conclusion to say the least.

Then came 2021. Within five weeks the subsystem authored fixes for [CVE-2021-31440](alu32-unsigned-bounds.md) (April 23), [CVE-2021-3490](alu32-bitwise-bounds.md) (May 10, publicly announced May 11), and [CVE-2021-33624](spectre-verifier.md) (May 28) — all reachable by an unprivileged process on a default-configured kernel.

## Observed behavior

Borkmann posted the knob on **May 11, 2021** — the same day CVE-2021-3490 was publicly announced on oss-security.

It went out as a two-patch series to `bpf@vger.kernel.org`. Patch 1/2 ("bpf, kconfig: Add consolidated menu entry for bpf with core options") created `kernel/bpf/Kconfig` and pulled BPF's options together from `init/Kconfig` and `net/Kconfig` into a single `General setup → BPF subsystem` menu, because "all core BPF related options are scattered in different Kconfig locations mainly due to historic reasons." Patch 2/2 added the knob into that new menu.

The [thread](https://lore.kernel.org/all/74ec548079189e4e4dffaeb42b8987bb3c852eee.1620765074.git.daniel@iogearbox.net/) drew no public replies. After two years of argument on the topic, the patch that changed the default went in without one.

## Why it happened

The 2019 impasse is the whole explanation, and it is a design disagreement rather than a mistake.

BPF's unprivileged-safety goal required the verifier to be a sound security boundary against a hostile program author. Speculative-execution attacks and a steady stream of arithmetic-tracking bugs made that boundary expensive to hold and, in Starovoitov's judgment, not worth holding. Meanwhile the actual users of BPF — tracing tools, network dataplanes, systemd, cgroup hooks — all run privileged anyway.

So the cost of the guarantee was concentrated in the subsystem, and the benefit was concentrated in use cases that either did not exist yet or could be served by a narrower capability. `CAP_BPF` in 2020 built the narrower capability. This patch changed which side of the trade-off you land on when you configure nothing.

Note what the change specifically is *not*: it does not remove unprivileged BPF, and it does not make the existing off switch permanent. It changes a default and makes the switch two-way.

## Resolution

[`08389d888287`](https://github.com/torvalds/linux/commit/08389d888287c3823f80b0216766b71e17f0aba5) ("bpf: Add kconfig knob for disabling unpriv bpf by default", v5.13-rc4) does three things.

It adds the kconfig option:

```
config BPF_UNPRIV_DEFAULT_OFF
	bool "Disable unprivileged BPF by default"
	depends on BPF_SYSCALL
	help
	  Disables unprivileged BPF by default by setting the corresponding
	  /proc/sys/kernel/unprivileged_bpf_disabled knob to 2. An admin can
	  still reenable it by setting it to 0 later on, or permanently
	  disable it by setting it to 1 (from which no other transition to
	  0 is possible anymore).
```

It wires that into the sysctl's initial value:

```c
int sysctl_unprivileged_bpf_disabled __read_mostly =
	IS_BUILTIN(CONFIG_BPF_UNPRIV_DEFAULT_OFF) ? 2 : 0;
```

And it introduces a third state. The sysctl is no longer a boolean with a latch; it is a three-valued setting, documented in `Documentation/admin-guide/sysctl/kernel.rst` by the same patch:

| Value | Meaning |
| --- | --- |
| 0 | Unprivileged calls to `bpf()` are enabled |
| 1 | Unprivileged calls to `bpf()` are disabled **without recovery** |
| 2 | Unprivileged calls to `bpf()` are disabled |

The distinction between 1 and 2 is the design's whole subtlety, and it is enforced by a purpose-built handler rather than the generic `proc_dointvec_minmax`:

```c
/* kernel/sysctl.c, added by 08389d888287 */
static int bpf_unpriv_handler(struct ctl_table *table, int write,
			      void *buffer, size_t *lenp, loff_t *ppos)
{
	int ret, unpriv_enable = *(int *)table->data;
	bool locked_state = unpriv_enable == 1;
	struct ctl_table tmp = *table;

	if (write && !capable(CAP_SYS_ADMIN))
		return -EPERM;

	tmp.data = &unpriv_enable;
	ret = proc_dointvec_minmax(&tmp, write, buffer, lenp, ppos);
	if (write && !ret) {
		if (locked_state && unpriv_enable != 1)
			return -EPERM;
		*(int *)table->data = unpriv_enable;
	}
	return ret;
}
```

`locked_state` preserves the old one-way behavior for anyone who had already written 1: once permanently disabled, it stays permanently disabled. But a kernel that booted into 2 can be moved to 0 by an administrator who needs unprivileged BPF for something, and can be moved to 1 to lock it down for good. The commit's summary: "This still allows a transition of 2 -> {0,1} through an admin. Similarly, this also still keeps 1 -> {1} behavior intact, so that once set to permanently disabled, it cannot be undone aside from a reboot."

The `extra1`/`extra2` bounds change from `SYSCTL_ONE`/`SYSCTL_ONE` to `SYSCTL_ZERO`/`two`, which is what makes writes of 0 and 2 reachable at all.

The commit also points at the middle path the subsystem had already built: "Either way, as an additional alternative, applications can make use of CAP_BPF that we added a while ago."

## What it taught us

**A security guarantee nobody can hold is worse than an honest default.** The 2019 discussion is uncomfortable reading precisely because Starovoitov is not arguing that unprivileged BPF is hard; he is arguing that it is not worth doing, and that the code written to make it safe is "a lot of complex kernel code without users." Whether or not you agree, the outcome — turn it off by default, keep the capability for those who ask — is more honest than shipping a boundary the maintainers privately do not believe in.

**Two-way switches get used; one-way switches get avoided.** The original latch was well-intentioned: once disabled, an attacker cannot re-enable it. In practice it meant an administrator who might need BPF later had to leave it on, because turning it off was irreversible without a reboot. Adding value 2 — off, but recoverable — cost one small purpose-built sysctl handler and made the safe default adoptable. The irreversible state stayed available for those who wanted it.

**Capabilities are the right granularity, but only if the default is right.** `CAP_BPF` merged in May 2020 and split BPF loading from `CAP_SYS_ADMIN` and from Spectre-mitigation bypass. It did not help a single unconfigured machine. The default is the security posture for almost everyone; the capability is the security posture for the people who read the documentation.

!!! warning "Pattern to watch for"
    Check what your kernels actually do, since this is a build-time choice your distributor makes for you, not an upstream default:

    ```bash
    # 0 = unprivileged bpf() allowed; 1 = disabled, irreversible; 2 = disabled, admin can re-enable
    sysctl kernel.unprivileged_bpf_disabled
    ```

    More generally: when a subsystem adds a hardening *option* rather than changing behavior directly, the security work is not finished — it has been delegated to whoever configures the build. Audit for options like this that your distribution leaves unset, and treat any capability-splitting patch (`CAP_BPF`, `CAP_PERFMON`, `CAP_CHECKPOINT_RESTORE`) as having a matching "what happens if nobody configures anything?" question attached.

## See also

- [BPF Verifier](../bpf-verifier.md) — including what the verifier does differently for privileged versus unprivileged loaders
- [Linux Capabilities](../../security/capabilities.md) — the model `CAP_BPF` splits `bpf()` loading out of
- [Spectre in the BPF Verifier](spectre-verifier.md) — the third of the 2021 verifier CVEs, fixed two and a half weeks after this knob was posted
- [ALU32 Bitwise Bounds Tracking](alu32-bitwise-bounds.md) — publicly announced the same day this patch was posted
- [Kernel Hardening](../../security/kernel-hardening.md) — the other build-time hardening options (KASLR, stack protectors, `HARDENED_USERCOPY`) worth auditing alongside this one
- [seccomp BPF](../../security/seccomp.md) — the classic-BPF user Lutomirski cited as a real unprivileged-BPF use case

## External references

- [GitHub mirror: 08389d888287](https://github.com/torvalds/linux/commit/08389d888287c3823f80b0216766b71e17f0aba5) — "bpf: Add kconfig knob for disabling unpriv bpf by default", the kconfig option, the three-valued sysctl, and the new handler
- [lore.kernel.org: the two-patch series](https://lore.kernel.org/all/74ec548079189e4e4dffaeb42b8987bb3c852eee.1620765074.git.daniel@iogearbox.net/) — posted May 11, 2021 to `bpf@vger.kernel.org`; no public replies
- [GitHub mirror: 2c78ee898d8f](https://github.com/torvalds/linux/commit/2c78ee898d8f10ae6fb2fa23a3fbaec96b1b7366) — "bpf: Implement CAP_BPF" (May 2020), which split `allow_ptr_leaks` into four separate verifier permissions
- [LWN: Reconsidering unprivileged BPF](https://lwn.net/Articles/796328/) — Jonathan Corbet, August 16, 2019; the Starovoitov/Lutomirski exchange this change eventually settled
- [kernel.org: `unprivileged_bpf_disabled`](https://docs.kernel.org/admin-guide/sysctl/kernel.html) — the sysctl documentation this patch rewrote
