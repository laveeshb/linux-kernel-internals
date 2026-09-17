# BPF Security Model

> Capabilities, the unprivileged-BPF knob, and BPF as a security module

## Two different security questions

[The verifier](bpf-verifier.md) answers one question: *given that a program is allowed to load, will it behave safely?* This page answers a different one: *who is allowed to load a program in the first place, and what can a BPF program itself be trusted to enforce?* The two are related — the whole point of a sound verifier is that the answer to the second question can be "more people than just root" — but they're separate mechanisms, and the [BPF war stories](war-stories.md) page documents the kernel gradually losing confidence that the verifier alone was strong enough, which is why the capability and sysctl layer below exists at all.

## The capability model

Loading a BPF program or creating a BPF map goes through the same central check, `bpf_token_capable()`, defined in `kernel/bpf/token.c` (only declared in `include/linux/bpf.h`):

```c
static bool bpf_ns_capable(struct user_namespace *ns, int cap)
{
	return ns_capable(ns, cap) || (cap != CAP_SYS_ADMIN && ns_capable(ns, CAP_SYS_ADMIN));
}

bool bpf_token_capable(const struct bpf_token *token, int cap)
{
	struct user_namespace *userns;

	/* BPF token allows ns_capable() level of capabilities */
	userns = token ? token->userns : &init_user_ns;
	if (!bpf_ns_capable(userns, cap))
		return false;
	if (token && security_bpf_token_capable(token, cap) < 0)
		return false;
	return true;
}
```

`CAP_SYS_ADMIN` is always an accepted fallback for any specific BPF capability check — a process with `CAP_SYS_ADMIN` doesn't additionally need `CAP_BPF`. `CAP_BPF` itself is the specific, narrower capability, added in Linux 5.8 (confirmed absent from `include/uapi/linux/capability.h` at the v5.7 tag, present at v5.8) specifically so BPF program loading and map creation no longer required the much broader `CAP_SYS_ADMIN`. `CAP_PERFMON` is checked separately for the riskier verifier relaxations — `bpf_allow_ptr_leaks()`, `bpf_allow_uninit_stack()`, and bypassing the Spectre v1/v4 mitigations (`bpf_bypass_spec_v1()`/`bpf_bypass_spec_v4()`), all declared right next to `bpf_token_capable()` in `include/linux/bpf.h`. Without a token, the check falls back to `init_user_ns` and behaves like a plain `capable()` check; with one, it's evaluated against the token's own user namespace, plus an additional LSM veto via `security_bpf_token_capable()`.

### BPF tokens: delegating capabilities into a namespace

The `token` argument above isn't decorative. `kernel/bpf/token.c` (confirmed absent at v6.8, present at v6.9) lets a process holding real capabilities on the host mount a `bpffs` instance with `delegate_cmds=`, `delegate_maps=`, `delegate_progs=`, and `delegate_attachs=` options (`kernel/bpf/inode.c`), then hand a file descriptor for that mount to an unprivileged process in a different user namespace — a container, for instance. That process calls `bpf()` with `BPF_TOKEN_CREATE` to mint a token from the fd, and passes the token on subsequent `BPF_MAP_CREATE`/`BPF_PROG_LOAD` calls. Before the ordinary capability check runs, `bpf_token_get_from_fd()`, `bpf_token_allow_cmd()`, `bpf_token_allow_prog_type()`, and `bpf_token_allow_map_type()` (all `kernel/bpf/token.c`) gate whether the token covers the specific command, program type, or map type being requested. It's the mechanism that makes "a container can load *this specific* XDP program without being root" possible without loosening the mounter's own trust boundary.

## `unprivileged_bpf_disabled`: three states, not two

The `kernel.unprivileged_bpf_disabled` sysctl (`kernel/bpf/syscall.c`) gates whether a process without `CAP_BPF` can create BPF maps or load BPF programs at all — both `map_create_alloc()` (called from `map_create()`, the `BPF_MAP_CREATE` handler, checking `sysctl_unprivileged_bpf_disabled && !bpf_token_capable(token, CAP_BPF)`) and `bpf_prog_load()` (checking `sysctl_unprivileged_bpf_disabled && !bpf_cap`) refuse outright if it's true. `map_create_alloc()` is a recent split of the map-creation path — on older kernels the equivalent check sits directly in `map_create()`. But the value isn't a boolean; there are three states, and the difference between two of them matters:

```c
/* kernel/bpf/syscall.c */
int sysctl_unprivileged_bpf_disabled __read_mostly =
	IS_BUILTIN(CONFIG_BPF_UNPRIV_DEFAULT_OFF) ? 2 : 0;
```

- **0** — unprivileged BPF is allowed.
- **1** — disabled, and *locked*: once set to 1, the kernel's own write handler refuses to change it back (`bpf_unpriv_handler()` treats `unpriv_enable == 1` as a one-way latch — any further write that isn't itself `1` returns `-EPERM`). There's no way to re-enable unprivileged BPF on a running kernel after this, short of a reboot.
- **2** — disabled by default (via `CONFIG_BPF_UNPRIV_DEFAULT_OFF`), but *recoverable*: an administrator can still write `0` back to re-enable it.

This isn't a hypothetical distinction. Two separate commits are involved: `08389d888287` (May 2021, landed in Linux 5.13) added the `CONFIG_BPF_UNPRIV_DEFAULT_OFF` Kconfig option and the three-valued sysctl itself, but didn't turn the knob on — that Kconfig symbol had no `default` at 5.13, 5.14, or 5.15, so upstream kernels still shipped with unprivileged BPF allowed. `8a03e56b253e` (October 2021, landed in Linux 5.16) is the commit that actually added `default y`, making disabled-by-default (value 2, specifically because it's reversible) the shipped upstream behavior — see the [unprivileged-BPF-off-by-default](war-stories/unprivileged-bpf-off.md) change for that story. Value 1 exists for administrators who've decided to close the door permanently on a given machine.

Writing to the sysctl at all requires `CAP_SYS_ADMIN`, regardless of the current or target value.

## What unprivileged BPF can still do

On a kernel that still allows unprivileged BPF (`unprivileged_bpf_disabled` at 0 — not the shipped-upstream default since 5.16, but still common on kernels built without `CONFIG_BPF_UNPRIV_DEFAULT_OFF`, or with the sysctl explicitly re-enabled), a process without `CAP_BPF` is restricted well beyond what the verifier alone would allow:

- **Program type**: only `BPF_PROG_TYPE_SOCKET_FILTER` and `BPF_PROG_TYPE_CGROUP_SKB` may be loaded without `CAP_BPF` (`kernel/bpf/syscall.c`, checked immediately after the `unprivileged_bpf_disabled` gate).
- **Program size**: an unprivileged program is capped at `BPF_MAXINSNS` — 4096 instructions (`include/uapi/linux/bpf_common.h`) — versus `BPF_COMPLEXITY_LIMIT_INSNS`, 1,000,000, defined in `include/linux/bpf.h` and used as the verifier's own path-exploration budget in `kernel/bpf/verifier.c`, for a `CAP_BPF`-holding one.
- **Pointer and speculation leaks**: `bpf_allow_ptr_leaks()` and the Spectre-bypass checks above all accept `CAP_PERFMON` as one way to relax them — but each also has its own, capability-independent escape hatch (`bpf_jit_bypass_spec_v1()`/`bpf_jit_bypass_spec_v4()` for architectures whose JIT is structurally immune, or booting with `mitigations=off`), so an unprivileged program on an affected, default-mitigated machine gets the verifier's strictest, most defensive rules with no way to relax them through capabilities alone.
- **Unaligned access**: on architectures without efficient unaligned access, `BPF_F_ANY_ALIGNMENT` also requires `CAP_BPF`.

None of this is enforced by the verifier's safety proof — it's a separate, capability-gated policy layered on top of it, and it's the layer that actually changed in response to the verifier CVEs on the [war stories page](war-stories.md).

## BPF as a security module: BPF LSM

Everything above is about controlling who can load BPF. BPF LSM inverts the relationship: it lets a BPF program *become* part of the kernel's own access-control decision, attached directly to [LSM](../security/lsm.md) hooks.

`kernel/bpf/bpf_lsm.c` (Google, added in Linux 5.7 — confirmed absent at v5.6, present at v5.7) works by declaring a weak, no-op function for every LSM hook that can take a BPF attachment:

```c
/* kernel/bpf/bpf_lsm.c */
#define LSM_HOOK(RET, DEFAULT, NAME, ...)	\
__weak noinline RET bpf_lsm_##NAME(__VA_ARGS__)	\
{						\
	return DEFAULT;				\
}
#include <linux/lsm_hook_defs.h>
#undef LSM_HOOK
```

Each `bpf_lsm_<hookname>()` stub is registered as an attachable BTF function (`BTF_SET_START(bpf_lsm_hooks)` / `BTF_ID(func, bpf_lsm_##NAME)`, same file), and a BPF program of type `BPF_PROG_TYPE_LSM` (`include/uapi/linux/bpf.h`) attaches to one of them — `BPF_LSM_MAC` for the ordinary access-control hooks, `BPF_LSM_CGROUP` for a cgroup-scoped variant. Because the attach point is a real LSM hook, the program's return value can actually deny an operation, the same as SELinux or AppArmor would — the difference is the policy is a BPF program instead of a compiled-in or loaded security module, so it can be short-lived, generated at runtime, or scoped to exactly one workload. The verifier enforces one extra rule specific to this program type: `bpf_lsm_verify_prog()` (`kernel/bpf/bpf_lsm.c`) rejects any LSM program that isn't GPL-compatible, refusing to let a proprietary policy attach to a security decision point.

`CONFIG_BPF_LSM` (`kernel/bpf/Kconfig`) is the build-time switch, and its own help text is direct about the intended use: "Enables instrumentation of the security hooks with BPF programs for implementing dynamic MAC and Audit Policies." It depends on `BPF_EVENTS`, `BPF_SYSCALL`, `SECURITY`, and `BPF_JIT` all being enabled — this is not something a minimal kernel build gets by accident. Building it in isn't the whole story, though: LSMs are only active if they're in the ordered list the `LSM` Kconfig string enables (`bpf` is included in every distribution's default list in `security/Kconfig`), and that list "can be controlled at boot with the `lsm=` parameter" — a custom `lsm=` boot argument that drops `bpf` silently disables BPF LSM even on a kernel built with `CONFIG_BPF_LSM=y`.

Loading an LSM-attached BPF program is still gated by the ordinary capability rules above, not a separate, more permissive path: `BPF_PROG_TYPE_LSM` isn't one of the two program types unprivileged loading allows, so it requires `CAP_BPF`, on top of `CONFIG_BPF_LSM` being built in at all — and because `BPF_PROG_TYPE_LSM` is also one of the program types `is_perfmon_prog_type()` (`kernel/bpf/syscall.c`) covers, loading one requires `CAP_PERFMON` as well. BPF LSM changes what a *sufficiently privileged* BPF program is allowed to influence, not who's allowed to load one.

## Further reading

### Kernel source

- [kernel/bpf/syscall.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/bpf/syscall.c) — `bpf_unpriv_handler()`, the `unprivileged_bpf_disabled` sysctl table entry, and the capability checks in program/map creation
- [include/linux/bpf.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/bpf.h) — the `bpf_token_capable()` declaration, `bpf_allow_ptr_leaks()`, `bpf_bypass_spec_v1()`/`bpf_bypass_spec_v4()`
- [kernel/bpf/token.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/bpf/token.c) — `bpf_token_capable()`'s actual definition, and the token-delegation checks (`bpf_token_get_from_fd()`, `bpf_token_allow_cmd()`, `bpf_token_allow_prog_type()`, `bpf_token_allow_map_type()`)
- [include/uapi/linux/bpf_common.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/bpf_common.h) — `BPF_MAXINSNS`
- [kernel/bpf/bpf_lsm.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/bpf/bpf_lsm.c) — the `bpf_lsm_<hook>()` weak-symbol mechanism and BTF registration
- [kernel/bpf/Kconfig](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/bpf/Kconfig) — `CONFIG_BPF_LSM` and its dependencies
- [include/uapi/linux/bpf.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/bpf.h) — `BPF_PROG_TYPE_LSM`, `BPF_LSM_MAC`, `BPF_LSM_CGROUP`

### Related pages

- [BPF Verifier](bpf-verifier.md) — the safety proof this page's capability layer sits on top of
- [War Stories](war-stories.md) — why the capability model exists: verifier CVEs and the 2021 unprivileged-BPF-off-by-default change
- [LSM Framework](../security/lsm.md) — the hook framework BPF LSM attaches into
- [Linux Capabilities](../security/capabilities.md) — `CAP_BPF`, `CAP_PERFMON`, and the wider capability split
