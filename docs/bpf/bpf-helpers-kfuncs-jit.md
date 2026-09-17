# Helpers, kfuncs, and the JIT

> How a BPF program calls into the kernel, and how it actually runs once loaded

[Architecture and Program Types](bpf-overview.md) covers helpers as a flat list of callable functions. This page goes one level deeper: the actual calling-convention mechanics behind that list, the newer kfunc mechanism that grew up alongside it, and how a verified program turns into the code the CPU actually executes.

## Helpers: a fixed, numbered ABI

A BPF program can't call an arbitrary kernel symbol — the compiler has no way to link against kernel code, and the verifier has no way to reason about arbitrary function bodies. Instead, the kernel exposes a fixed set of helper functions, each identified by a stable number baked into the instruction stream at compile time:

```c
/* include/uapi/linux/bpf.h — the helper ID list is built from a single
 * macro invoked once per helper, e.g.: */
FN(map_lookup_elem, 1, ##ctx)
FN(map_update_elem, 2, ##ctx)
FN(map_delete_elem, 3, ##ctx)
/* ... */
```

`bpf_map_lookup_elem()` is helper 1 — the oldest, most-used helper, from before the numbered-list convention even needed a name. A `BPF_CALL` instruction in the compiled program doesn't reference a symbol; it carries this number as an immediate operand.

### The five-register calling convention

Every helper — regardless of its real signature — is called through exactly five 64-bit registers (`r1`–`r5`), because that's what a `BPF_CALL` instruction can pass. A helper implementation looks like an ordinary typed C function, but it's wrapped by a macro that generates the real, register-typed entry point:

```c
/* include/linux/filter.h */
#define BPF_CALL_x(x, attr, name, ...)					\
	static __always_inline						\
	u64 ____##name(__BPF_MAP(x, __BPF_DECL_ARGS, __BPF_V, __VA_ARGS__)); \
	typedef u64 (*btf_##name)(__BPF_MAP(x, __BPF_DECL_ARGS, __BPF_V, __VA_ARGS__)); \
	attr u64 name(__BPF_REG(x, __BPF_DECL_REGS, __BPF_N, __VA_ARGS__));	\
	attr u64 name(__BPF_REG(x, __BPF_DECL_REGS, __BPF_N, __VA_ARGS__))	\
	{								\
		return ((btf_##name)____##name)(__BPF_MAP(x,__BPF_CAST,__BPF_N,__VA_ARGS__));\
	}								\
	static __always_inline						\
	u64 ____##name(__BPF_MAP(x, __BPF_DECL_ARGS, __BPF_V, __VA_ARGS__))

#define BPF_CALL_2(name, ...)	BPF_CALL_x(2, __NOATTR, name, __VA_ARGS__)
```

`BPF_CALL_2(bpf_map_lookup_elem, struct bpf_map *, map, void *, key)` expands to a real function taking two typed arguments (`____bpf_map_lookup_elem`), plus a second, register-typed wrapper (`bpf_map_lookup_elem`) that takes five `u64`s, casts the first two down to `struct bpf_map *`/`void *`, and calls through. The verifier and the JIT only ever see the register-typed wrapper; the typed inner function is what you actually write the helper's logic in.

### Type-checking a helper call

The verifier has to know what each helper's arguments and return value actually mean — a `u64` register might hold a map pointer, a raw integer, or a pointer the program isn't allowed to touch. That metadata lives in a separate struct, one per helper:

```c
/* include/linux/bpf.h */
struct bpf_func_proto {
	u64 (*func)(u64 r1, u64 r2, u64 r3, u64 r4, u64 r5);
	bool gpl_only;
	bool pkt_access;
	bool might_sleep;
	/* ... allow_fastcall omitted here ... */
	enum bpf_return_type ret_type;
	union {
		struct {
			enum bpf_arg_type arg1_type;
			enum bpf_arg_type arg2_type;
			enum bpf_arg_type arg3_type;
			enum bpf_arg_type arg4_type;
			enum bpf_arg_type arg5_type;
		};
		enum bpf_arg_type arg_type[MAX_BPF_FUNC_ARGS];
	};
	/* ... BTF-id and size metadata for pointer/size argument pairs ... */
};
```

Each program type has a `get_func_proto()` callback that maps a helper's numeric ID to its `bpf_func_proto` — which is also how the verifier enforces that, say, an XDP program can't call a helper that's only valid for tracing. Because the numbering is permanent — a helper's ID is part of the userspace-facing BPF ABI — a program compiled against one kernel keeps working on any newer kernel that still recognizes the ID. New helpers only ever get new numbers.

## kfuncs: an escape hatch from the flat helper list

The helper list is a single, kernel-wide enum: every helper, from every subsystem, is added to the same list, gets the same permanent ABI guarantee, and needs review from BPF maintainers even if it's only useful to one subsystem. That doesn't scale to letting individual subsystems (or even individual kernel modules) expose their own narrow, possibly-unstable functions to BPF.

Kfuncs solve this by letting a subsystem register a set of kernel functions as directly callable from BPF, without going through the helper enum at all. The registration API — `register_btf_kfunc_id_set()`, `struct btf_kfunc_id_set` — was introduced in Linux **5.18**; confirmed by tag-diff of `include/linux/btf.h` (absent at v5.17, present at v5.18).

A real kfunc set, from `kernel/bpf/helpers.c`:

```c
/* kernel/bpf/helpers.c */
BTF_KFUNCS_START(generic_btf_ids)
BTF_ID_FLAGS(func, bpf_obj_new, KF_ACQUIRE | KF_RET_NULL | KF_IMPLICIT_ARGS)
BTF_ID_FLAGS(func, bpf_obj_new_impl, KF_ACQUIRE | KF_RET_NULL)
BTF_ID_FLAGS(func, bpf_obj_drop, KF_RELEASE | KF_IMPLICIT_ARGS)
BTF_ID_FLAGS(func, bpf_obj_drop_impl, KF_RELEASE)
/* ... */
BTF_KFUNCS_END(generic_btf_ids)

static const struct btf_kfunc_id_set generic_kfunc_set = {
	.owner = THIS_MODULE,
	.set   = &generic_btf_ids,
};
```

That set is then registered per program type it should be visible to:

```c
/* kernel/bpf/helpers.c */
ret = register_btf_kfunc_id_set(BPF_PROG_TYPE_TRACING, &generic_kfunc_set);
ret = ret ?: register_btf_kfunc_id_set(BPF_PROG_TYPE_SCHED_CLS, &generic_kfunc_set);
ret = ret ?: register_btf_kfunc_id_set(BPF_PROG_TYPE_XDP, &generic_kfunc_set);
```

The `KF_*` flags (`include/linux/btf.h`) are the verifier's substitute for `bpf_func_proto`'s argument-type checking, expressed in terms kfuncs actually need: `KF_ACQUIRE` marks a function that hands back a reference the program must eventually release; `KF_RELEASE` marks the function that releases it; `KF_RET_NULL` tells the verifier the return value must be null-checked before use. Unlike a helper's permanent numeric ID, a kfunc is resolved by name through BTF at load time — kfuncs are explicitly *not* guaranteed stable across kernel versions unless a subsystem documents otherwise, which is the tradeoff for not needing central review to add one.

## The JIT: from bytecode to native code

A verified BPF program is a sequence of fixed-width instructions — safe to run, but still bytecode that needs to be dispatched one instruction at a time by an interpreter unless it's compiled to real machine code first. Linux has had a JIT for BPF since before eBPF existed: Eric Dumazet's x86-64 JIT for classic (socket-filter) BPF, covered by Jonathan Corbet on LWN in April 2011 ([LWN](https://lwn.net/Articles/437981/)) and confirmed landing in Linux **3.0** (July 2011) via tag-diff of `arch/x86/net/bpf_jit_comp.c` (absent at v2.6.39, present at v3.0). The eBPF rewrite in 2014 replaced that JIT along with everything else, but the same file and the same idea — translate the whole program to native instructions once, instead of re-interpreting it on every run — carried forward.

Each architecture provides its own JIT behind one function, but that function isn't called directly — it's wrapped by a step that can rewrite the program first:

```c
/* kernel/bpf/core.c — the real wrapper, handling constant blinding.
 * Controlled by the bpf_jit_harden sysctl: rewrites immediate values
 * before JITing, to mitigate JIT spraying (Documentation/admin-guide/
 * sysctl/net.rst) rather than being on unconditionally. */
static struct bpf_prog *bpf_prog_jit_compile(struct bpf_verifier_env *env, struct bpf_prog *prog)
{
#ifdef CONFIG_BPF_JIT
	struct bpf_prog *orig_prog;

	if (!bpf_prog_need_blind(prog))
		return bpf_int_jit_compile(env, prog);

	orig_prog = prog;
	prog = bpf_jit_blind_constants(env, prog);
	/*
	 * If blinding was requested and we failed during blinding, we must fall
	 * back to the interpreter.
	 */
	if (IS_ERR(prog))
		goto out_restore;

	prog = bpf_int_jit_compile(env, prog);
	/* ... */
#endif
}
```

`bpf_int_jit_compile(struct bpf_verifier_env *env, struct bpf_prog *prog)` (declared in `include/linux/filter.h`, defined per-architecture) is the real compiler. Every supported architecture defines its own version of this same function; `arch/x86/net/bpf_jit_comp.c` alone is over 4,000 lines, translating each fixed-width BPF opcode into the corresponding x86-64 instruction sequence, including the register-allocation and calling-convention work needed to make a JITed BPF function callable like any other.

### Choosing JIT or interpreter

Compilation isn't unconditional — it happens as part of finalizing a verified program, with a documented fallback if it fails:

```c
/* kernel/bpf/core.c (simplified) */
struct bpf_prog *__bpf_prog_select_runtime(struct bpf_verifier_env *env,
					    struct bpf_prog *fp, int *err)
{
	bool jit_needed = fp->jit_required;

	if (!bpf_prog_select_interpreter(fp))
		jit_needed = true;

	/*
	 * eBPF JITs can rewrite the program in case constant
	 * blinding is active. However, in case of error during
	 * blinding, bpf_int_jit_compile() must always return a
	 * valid program, which in this case would simply not
	 * be JITed, but falls back to the interpreter.
	 */
	fp = bpf_prog_jit_compile(env, fp);
	if (!fp->jited && jit_needed) {
		*err = -ENOTSUPP;
		return fp;
	}
	/* ... */
	return fp;
}
```

The comment names a real safety property: if the architecture can't (or, with constant blinding, chooses not to) produce JITed code, the interpreter is still a fully valid fallback — normally. `jit_required` (`fp->jit_required = IS_ENABLED(CONFIG_BPF_JIT_ALWAYS_ON)`) is the one case where that fallback is refused entirely: `CONFIG_BPF_JIT_ALWAYS_ON` removes the interpreter from the kernel outright, specifically "to avoid speculative execution of BPF instructions by the interpreter" — a Spectre-class mitigation, since an unJITed BPF program is still walked instruction-by-instruction by real (speculatable) kernel code.

## Further reading

### Kernel source

- [include/linux/filter.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/filter.h) — the `BPF_CALL_x` macro family and `bpf_int_jit_compile()`'s declaration
- [include/linux/bpf.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/bpf.h) — `struct bpf_func_proto`, the verifier's per-helper type-checking metadata
- [include/uapi/linux/bpf.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/bpf.h) — `enum bpf_func_id`, generated from the `___BPF_FUNC_MAPPER` helper-name-to-number list
- [include/linux/btf.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/btf.h) — `register_btf_kfunc_id_set()`, `struct btf_kfunc_id_set`, and the `KF_ACQUIRE`/`KF_RELEASE`/`KF_RET_NULL` flags
- [include/linux/btf_ids.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/btf_ids.h) — `BTF_KFUNCS_START`/`BTF_ID_FLAGS`/`BTF_KFUNCS_END`
- [kernel/bpf/helpers.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/bpf/helpers.c) — `generic_btf_ids`, a real kfunc set covering `bpf_obj_new`/`bpf_obj_drop` and friends
- [kernel/bpf/core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/bpf/core.c) — `__bpf_prog_select_runtime()`, the JIT-or-interpreter decision and constant-blinding fallback
- [arch/x86/net/bpf_jit_comp.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/net/bpf_jit_comp.c) — the x86-64 JIT

### LWN articles

- [A JIT for packet filters](https://lwn.net/Articles/437981/) — Jonathan Corbet, April 2011, covering Eric Dumazet's x86-64 classic-BPF JIT ahead of its Linux 3.0 merge

### Related pages

- [BPF Architecture and Program Types](bpf-overview.md) — the helper list as used from a program, and the `bpf()` syscall's load path
- [BPF Verifier](bpf-verifier.md) — how `bpf_func_proto` and BTF type information feed the safety proof
- [BTF and CO-RE](btf-core.md) — the BTF type-encoding machinery kfunc registration builds on
