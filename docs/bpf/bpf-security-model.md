# BPF Security Model

> Capabilities, the unprivileged-BPF knob, and BPF as a security module

## Two different security questions

[The verifier](bpf-verifier.md) answers one question: *given that a program is allowed to load, will it behave safely?* This page answers a different one: *who is allowed to load a program in the first place, and what can a BPF program itself be trusted to enforce?* The two are related — the whole point of a sound verifier is that the answer to the second question can be "more people than just root" — but they're separate mechanisms, and the [BPF war stories](war-stories.md) page documents the kernel gradually losing confidence that the verifier alone was strong enough, which is why the capability and sysctl layer below exists at all.

## The capability model

Loading a BPF program or creating a BPF map goes through the same central check in `kernel/bpf/syscall.c`: `bpf_token_capable()` (`include/linux/bpf.h`), which reduces to:

```c
static inline bool bpf_token_capable(const struct bpf_token *token, int cap)
{
	return capable(cap) || (cap != CAP_SYS_ADMIN && capable(CAP_SYS_ADMIN));
}
```

`CAP_SYS_ADMIN` is always an accepted fallback for any specific BPF capability check — a process with `CAP_SYS_ADMIN` doesn't additionally need `CAP_BPF`. `CAP_BPF` itself is the specific, narrower capability, added in Linux 5.8 (confirmed absent from `include/uapi/linux/capability.h` at the v5.7 tag, present at v5.8) specifically so BPF program loading and map creation no longer required the much broader `CAP_SYS_ADMIN`. `CAP_PERFMON` is checked separately for the riskier verifier relaxations — `bpf_allow_ptr_leaks()`, `bpf_allow_uninit_stack()`, and bypassing the Spectre v1/v4 mitigations (`bpf_bypass_spec_v1()`/`bpf_bypass_spec_v4()`), all defined right next to `bpf_token_capable()` in `include/linux/bpf.h`.

## `unprivileged_bpf_disabled`: three states, not two

The `kernel.unprivileged_bpf_disabled` sysctl (`kernel/bpf/syscall.c`) gates whether a process without `CAP_BPF` can create BPF maps or load BPF programs at all — both `map_create_alloc()` (called from `map_create()`, the `BPF_MAP_CREATE` handler) and program loading check `sysctl_unprivileged_bpf_disabled && !bpf_cap` and refuse outright if it's true. But the value isn't a boolean; there are three states, and the difference between two of them matters:

```c
/* kernel/bpf/syscall.c */
int sysctl_unprivileged_bpf_disabled __read_mostly =
	IS_BUILTIN(CONFIG_BPF_UNPRIV_DEFAULT_OFF) ? 2 : 0;
```

- **0** — unprivileged BPF is allowed.
- **1** — disabled, and *locked*: once set to 1, the kernel's own write handler refuses to change it back (`bpf_unpriv_handler()` treats `unpriv_enable == 1` as a one-way latch — any further write that isn't itself `1` returns `-EPERM`). There's no way to re-enable unprivileged BPF on a running kernel after this, short of a reboot.
- **2** — disabled by default (via `CONFIG_BPF_UNPRIV_DEFAULT_OFF`), but *recoverable*: an administrator can still write `0` back to re-enable it.

This isn't a hypothetical distinction — value 2, specifically because it's reversible, is what the kernel actually shipped as the default-off setting in May 2021, after the [unprivileged-BPF-off-by-default](war-stories/unprivileged-bpf-off.md) change; value 1 exists for administrators who've decided to close the door permanently on a given machine.

Writing to the sysctl at all requires `CAP_SYS_ADMIN`, regardless of the current or target value.

## What unprivileged BPF can still do

Even with `unprivileged_bpf_disabled` at 0, a process without `CAP_BPF` is restricted well beyond what the verifier alone would allow:

- **Program type**: only `BPF_PROG_TYPE_SOCKET_FILTER` and `BPF_PROG_TYPE_CGROUP_SKB` may be loaded without `CAP_BPF` (`kernel/bpf/syscall.c`, checked immediately after the `unprivileged_bpf_disabled` gate).
- **Program size**: an unprivileged program is capped at `BPF_MAXINSNS` — 4096 instructions (`include/uapi/linux/bpf_common.h`) — versus `BPF_COMPLEXITY_LIMIT_INSNS`, 1,000,000, for a `CAP_BPF`-holding one. The same constant doubles as the verifier's own path-exploration budget (`kernel/bpf/verifier.c`).
- **Pointer and speculation leaks**: `bpf_allow_ptr_leaks()` and the Spectre-bypass checks above all require `CAP_PERFMON`, so an unprivileged program gets the verifier's strictest, most defensive rules with no way to relax them.
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

Each `bpf_lsm_<hookname>()` stub is registered as an attachable BTF function (`BTF_SET_START(bpf_lsm_hooks)` / `BTF_ID(func, bpf_lsm_##NAME)`, same file), and a BPF program of type `BPF_PROG_TYPE_LSM` (`include/uapi/linux/bpf.h`) attaches to one of them — `BPF_LSM_MAC` for the ordinary access-control hooks, `BPF_LSM_CGROUP` for a cgroup-scoped variant. Because the attach point is a real LSM hook, the program's return value can actually deny an operation, the same as SELinux or AppArmor would — the difference is the policy is a BPF program instead of a compiled-in or loaded security module, so it can be short-lived, generated at runtime, or scoped to exactly one workload.

`CONFIG_BPF_LSM` (`kernel/bpf/Kconfig`) is the build-time switch, and its own help text is direct about the intended use: "Enables instrumentation of the security hooks with BPF programs for implementing dynamic MAC and Audit Policies." It depends on `BPF_EVENTS`, `BPF_SYSCALL`, `SECURITY`, and `BPF_JIT` all being enabled — this is not something a minimal kernel build gets by accident.

Loading an LSM-attached BPF program is still gated by the ordinary capability rules above, not a separate, more permissive path: `BPF_PROG_TYPE_LSM` isn't one of the two program types unprivileged loading allows, so it requires `CAP_BPF` outright, on top of `CONFIG_BPF_LSM` being built in at all. BPF LSM changes what a *sufficiently privileged* BPF program is allowed to influence, not who's allowed to load one.

## Further reading

### Kernel source

- [kernel/bpf/syscall.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/bpf/syscall.c) — `bpf_unpriv_handler()`, the `unprivileged_bpf_disabled` sysctl table entry, and the capability checks in program/map creation
- [include/linux/bpf.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/bpf.h) — `bpf_token_capable()`, `bpf_allow_ptr_leaks()`, `bpf_bypass_spec_v1()`/`bpf_bypass_spec_v4()`
- [include/uapi/linux/bpf_common.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/bpf_common.h) — `BPF_MAXINSNS`
- [kernel/bpf/bpf_lsm.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/bpf/bpf_lsm.c) — the `bpf_lsm_<hook>()` weak-symbol mechanism and BTF registration
- [kernel/bpf/Kconfig](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/bpf/Kconfig) — `CONFIG_BPF_LSM` and its dependencies
- [include/uapi/linux/bpf.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/bpf.h) — `BPF_PROG_TYPE_LSM`, `BPF_LSM_MAC`, `BPF_LSM_CGROUP`

### Related pages

- [BPF Verifier](bpf-verifier.md) — the safety proof this page's capability layer sits on top of
- [War Stories](war-stories.md) — why the capability model exists: verifier CVEs and the 2021 unprivileged-BPF-off-by-default change
- [LSM Framework](../security/lsm.md) — the hook framework BPF LSM attaches into
- [Linux Capabilities](../security/capabilities.md) — `CAP_BPF`, `CAP_PERFMON`, and the wider capability split
