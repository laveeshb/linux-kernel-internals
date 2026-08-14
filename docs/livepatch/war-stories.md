# Live Patching War Stories

> Real incidents, tricky edge cases, and lessons learned

## 1. The stuck transition

### Scenario

A live patch was applied to a production system to fix a bug in a network
processing function used by a kthread. The patch loaded successfully and
`enabled` read `1`, but `transition` remained `1` for hours:

```bash
cat /sys/kernel/livepatch/net-fix/transition
# 1   (still stuck after 4 hours)
```

### Root cause

The kthread in question ran a tight polling loop:

```c
/* Simplified: the buggy kthread */
static int net_kthread(void *arg)
{
    while (!kthread_should_stop()) {
        process_pending_work();   /* calls old (buggy) function */
        /* No sleep, no cond_resched() — never schedules out */
    }
    return 0;
}
```

Because the kthread never yielded the CPU voluntarily and never entered sleep,
it never hit a context switch where `klp_sched_try_switch()` could try it —
that scheduler-path check only runs when the outgoing task is entering a
freezable sleep state, exactly what this kthread never did. `klp_send_signals()`
calls `wake_up_state(task, TASK_INTERRUPTIBLE)` for kthreads — this can only
wake tasks in interruptible sleep, not tasks actively running in a tight loop.
The kthread's tight loop without `cond_resched()` prevented both the
scheduler-path check and the `TASK_INTERRUPTIBLE` wakeup from taking effect.

The kthread's stack confirmed it:

```bash
cat /proc/<kthread_pid>/stack
# [<0>] process_pending_work+0x3a/0x120  ← old function, still on stack
# [<0>] net_kthread+0x18/0x50
# [<0>] kthread+0xd6/0x100
# [<0>] ret_from_fork+0x22/0x30
```

### Resolution

Two options were available:

1. **Force the transition** (chosen as a stopgap): after verifying the new
   function was safe to call even mid-execution in this specific case, the
   force file was written:

   ```bash
   echo 1 > /sys/kernel/livepatch/net-fix/force
   ```

   The kernel was already tainted with `TAINT_LIVEPATCH` from loading the
   module — forcing adds no additional taint of its own. The unsafety of the
   force itself was accepted as a stopgap, and the system was marked for a
   planned reboot within 24 hours.

2. **Make the kthread sleep** (permanent fix): a follow-up patch made the loop
   sleep between iterations instead of spinning. That gives the transition two
   ways in — the kthread is now off-CPU when the periodic workqueue scan runs
   (so `klp_check_and_switch_task()` no longer returns `-EBUSY`) and its stack
   no longer holds the patched function while it waits.

   On current kernels the sleep has to be a real sleep. A bare
   `cond_resched()` is not enough: since commit
   [`676e8cf70cb0`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=676e8cf70cb0)
   ("sched,livepatch: Untangle cond_resched() and live-patching", 2025-05-09)
   the livepatch hook hangs off `TASK_FREEZABLE` sleeps in `__schedule()`
   rather than off `cond_resched()`, so a loop that only yields still never
   reaches `__klp_sched_try_switch()`.

### Lesson

Kthreads that loop without ever sleeping are the hardest targets for live
patching: they never return to userspace, they never enter the freezable sleep
the scheduler-path check keys off, and they are always on-CPU when the
workqueue scan tries them. Before writing a patch that covers such a function:

- Give the kthread a real sleep — a brief `msleep()`, or better a freezable
  wait — if you control its source (via a separate preparatory patch). Yielding
  with `cond_resched()` alone no longer helps the transition.

  Note: the `nop` field in `struct klp_func` is used by the cumulative replace
  mechanism (`klp_add_nops()`) to create placeholder entries that call through
  to the original function for functions covered by older patches but not
  explicitly patched by the new cumulative patch. It is not a tool for draining
  stacks in this scenario.

## 2. Shadow variable lifecycle bug

### Scenario

A live patch added per-socket state to track a new security attribute. The
patch allocated a shadow variable during `connect()` and read it during
`send()`. The patch was deployed and worked correctly — but over the following
week, memory use on the affected hosts crept upward and never stabilized.

```bash
# Unreclaimable slab climbing and never coming back down
grep -E '^(Slab|SReclaimable|SUnreclaim):' /proc/meminfo
# Slab:            1842160 kB
# SReclaimable:     732876 kB
# SUnreclaim:      1109284 kB   ← ~40 MB/day, tracking connection churn
```

### Root cause

Shadow variables are stored in a global hash table, `klp_shadow_hash`,
keyed by (object pointer, ID). The patch allocated a shadow for each new
socket but never freed it when the socket was closed:

```c
/* Patch code — the bug */
static int patched_tcp_connect(struct sock *sk, struct sockaddr *uaddr,
                                int addr_len)
{
    struct my_shadow *s;

    s = klp_shadow_get_or_alloc(sk, KLP_MY_SHADOW_ID,
                                 sizeof(*s), GFP_KERNEL,
                                 NULL, NULL);
    s->attr = compute_security_attr(uaddr);

    /* Call original logic ... */
}

/* Missing: klp_shadow_free() in the socket release path */
```

Every closed socket left an orphaned `struct klp_shadow` in the hash table.
The hash table itself is a file-scope `DEFINE_HASHTABLE(klp_shadow_hash, 12)`
in `kernel/livepatch/shadow.c`, and nothing ever shrinks it: the only two exits
are `klp_shadow_free()` (one `<obj, id>` pair) and `klp_shadow_free_all()`
(every shadow with a given `id`). Both must be called by the patch.

### Detection

This is the awkward part: there is no `klp_shadow` slab cache to grep for.
`kernel/livepatch/shadow.c` contains no `kmem_cache_create()` at all — every
shadow variable comes out of a plain `kmalloc`:

```c
/* kernel/livepatch/shadow.c — __klp_shadow_get_or_alloc() */
new_shadow = kzalloc(size + sizeof(*new_shadow), gfp_flags);
```

so the allocations land in the shared generic `kmalloc-*` buckets with
everything else of that size, and `/proc/slabinfo` has no livepatch-specific
line. `struct klp_shadow` is 48 bytes of header on 64-bit (`hlist_node`,
`rcu_head`, `obj`, `id`) plus the patch's own payload — here a single 32-bit
attribute, for 52 bytes total — so these shadows came out of `kmalloc-64`.
Watching that bucket is corroborating evidence, never proof:

```bash
# Generic, shared bucket — a hint, not an attribution
watch -n 60 "grep -E '^kmalloc-64 ' /proc/slabinfo"
```

kmemleak is no help either. The orphans are still linked into
`klp_shadow_hash`, and `struct klp_shadow`'s `hlist_node` is its first member,
so a pointer to the start of every allocation is sitting in a live kernel data
structure. Kmemleak only reports objects for which no such pointer can be
found, so it never flags them. This is a lifecycle leak, not an
unreferenced-memory leak.

What actually closed the case was a two-step process. First, correlate: plot
`SUnreclaim:` from `/proc/meminfo` against the host's socket open/close rate
and confirm the slope only appeared after the patch was loaded, and only on
hosts that had it. Second, confirm by walking the hash table directly.
`klp_shadow_hash` is `static`, with no procfs, sysfs, or debugfs interface, so
this needs a debug-info kernel and a tool that can read kernel data
structures — `drgn` against the live kernel, or `crash` against a dump:

```python
# drgn, on a kernel built with debug info
from collections import Counter
from drgn.helpers.linux.list import hlist_for_each_entry

counts = Counter()
for bucket in prog["klp_shadow_hash"]:
    for s in hlist_for_each_entry("struct klp_shadow",
                                  bucket.address_of_(), "node"):
        counts[hex(int(s.id))] += 1
print(counts)
# Counter({'0x1': 41823})   ← the host had ~1200 live sockets
```

### Resolution

A follow-up patch hooked the socket release path and freed the shadow:

```c
/* Fix patch — added to socket release */
static void patched_sock_release(struct socket *sock)
{
    /* Free the shadow variable we attached in patched_tcp_connect */
    klp_shadow_free(sock->sk, KLP_MY_SHADOW_ID, NULL);

    /* Call original release */
    orig_sock_release(sock);
}
```

### Lesson

Every `klp_shadow_get_or_alloc()` must have a corresponding
`klp_shadow_free()`. Map out the full lifecycle of the kernel object before
writing the patch:

- **Allocated** in: `connect()` — must call `klp_shadow_get_or_alloc()`
- **Used** in: `send()`, `recv()` — must call `klp_shadow_get()`
- **Freed** in: `sock_release()`, `tcp_close()` — must call `klp_shadow_free()`

If the object's destructor is in a different module from where the shadow is
created, both the creator and destructor paths must be patched together.
See [Kernel Live Patching](klp.md) for the shadow variable API.

## 3. The compat syscall miss

### Scenario

A CVE was discovered in the legacy XFS-compatible space-reservation ioctls —
`FS_IOC_RESVSP`, `FS_IOC_UNRESVSP`, and `FS_IOC_ZERO_RANGE`. A live patch was
deployed to all production hosts within two hours, fixing `ioctl_preallocate()`
in `fs/ioctl.c`. The vulnerability was considered remediated. Three days
later, a security audit found that 32-bit processes on x86_64 hosts were
still exploitable through the exact same ioctl commands.

### Root cause

The patch targeted only the native ioctl path. On `CONFIG_X86_64`, the 32-bit
compat entry point, `compat_sys_ioctl()`, dispatches the equivalent
`_32`-suffixed command codes (`FS_IOC_RESVSP_32`, `FS_IOC_UNRESVSP_32`,
`FS_IOC_ZERO_RANGE_32`) straight to a separate function,
`compat_ioctl_preallocate()`, which the patch never touched:

```c
/* Native path — patched */
static int ioctl_preallocate(struct file *filp, int mode, void __user *argp)
{
    struct space_resv sr;

    if (copy_from_user(&sr, argp, sizeof(sr)))
        return -EFAULT;
    ...
    return vfs_fallocate(filp, mode | FALLOC_FL_KEEP_SIZE,
                          sr.l_start, sr.l_len);   /* ← patched */
}

/* 32-bit compat path on x86_64 — NOT patched */
#if defined CONFIG_COMPAT && defined(CONFIG_X86_64)
/* on ia32 l_start is on a 32-bit boundary; just account for the
 * different alignment */
static int compat_ioctl_preallocate(struct file *file, int mode,
                                    struct space_resv_32 __user *argp)
{
    struct space_resv_32 sr;   /* distinct, packed 32-bit layout */

    if (copy_from_user(&sr, argp, sizeof(sr)))
        return -EFAULT;
    ...
    return vfs_fallocate(file, mode | FALLOC_FL_KEEP_SIZE,
                          sr.l_start, sr.l_len);   /* ← same call, but... */
}
#endif
```

`compat_ioctl_preallocate()` exists because `struct space_resv`'s 64-bit
`l_start`/`l_len` fields are 8-byte aligned, but on ia32 they're only 4-byte
aligned — so the compat path defines its own packed `struct space_resv_32`
and its own copy-in routine (`include/linux/falloc.h`). Inside
`COMPAT_SYSCALL_DEFINE3(ioctl...)`, the `_32` command codes are handled
directly by `compat_ioctl_preallocate()` and never reach `do_vfs_ioctl()` →
`file_ioctl()` → `ioctl_preallocate()`, the function the patch had hooked.

### Detection

```bash
# Check /proc/kallsyms for the compat counterpart
grep -i preallocate /proc/kallsyms
# ffffffff812a1050 t ioctl_preallocate
# ffffffff812a1120 t compat_ioctl_preallocate   ← separate symbol, unpatched

# Confirm the compat dispatch in the source
grep -n "compat_ioctl_preallocate\|FS_IOC_RESVSP_32" fs/ioctl.c
```

### Resolution

A second patch was deployed that also hooked `compat_ioctl_preallocate()`.
Going forward, the team added a checklist item for every ioctl-handler patch:

1. Does the ioctl command have a `_32` compat variant, and does a
   `CONFIG_X86_64`-guarded struct like `space_resv_32` exist for it?
2. Does the compat path — either a driver's separate `f_op->compat_ioctl`,
   or, as here, a branch inside `compat_sys_ioctl()` in `fs/ioctl.c` — call a
   genuinely different function, rather than forwarding to the native
   handler?
3. Is the vulnerability present in both the native and compat parsing
   routines?

### Lesson

For any patch targeting a function reached through `do_vfs_ioctl()` or
`f_op->unlocked_ioctl`, check whether the same command number has a compat
counterpart that runs different code. Not every `compat_ioctl` diverges —
generic ones like `compat_ptr_ioctl()` just forward to the native handler
after a pointer conversion — but any handler with a genuinely different
compat argument layout, like `space_resv` vs. `space_resv_32` here, needs its
own livepatch target. `grep -i <name> /proc/kallsyms` for the function's
name family is a fast first check; the source is the definitive answer.

## 4. The wrong occurrence of a duplicated symbol

### Scenario

A bug was traced to `rx_ring_refill()`, a small `static` helper in a built-in
network driver. A live patch was written against it. The first `insmod` failed
outright:

```bash
insmod rx-fix.ko
# insmod: ERROR: could not insert module rx-fix.ko: Invalid parameters

dmesg | tail -1
# livepatch: unresolvable ambiguity for symbol 'rx_ring_refill' in object '(null)'
```

That message is `klp_find_object_symbol()` refusing to guess: `old_sympos` was
left at its default of `0`, which means "this symbol must be unique," and a
second built-in driver defined its own `static rx_ring_refill()`. (The object
prints as `(null)` because a `vmlinux` target is passed to
`klp_find_object_symbol()` as a NULL `objname`.)

The engineer disambiguated, set `.old_sympos = 1`, rebuilt, and reloaded. This
time everything came up clean:

```bash
insmod rx-fix.ko
# No errors

cat /sys/kernel/livepatch/rx-fix/enabled      # 1
cat /sys/kernel/livepatch/rx-fix/transition   # 0 — completed
cat /sys/kernel/livepatch/rx-fix/vmlinux/patched
# 1  ← the hook really is installed
```

The original bug kept reproducing anyway. Worse, an unrelated wireless
interface on the same hosts started dropping frames under load.

### Root cause

The patch was live, the transition had finished, and the ftrace hook was
installed — on the wrong function. `old_sympos` selected the other driver's
`rx_ring_refill()`.

The occurrence numbering is not arbitrary, and it is not the order `nm` prints.
`scripts/kallsyms.c` sorts the name index with `compare_names()`, which breaks
ties between identical names by **ascending address**:

```c
/* scripts/kallsyms.c — compare_names() */
ret = strcmp(sym_name(sa), sym_name(sb));
if (!ret) {
    if (sa->addr > sb->addr)
        return 1;
    else if (sa->addr < sb->addr)
        return -1;
    ...
}
```

For a `vmlinux` target, `klp_find_object_symbol()` walks that index via
`kallsyms_on_each_match_symbol()` and stops when its running count reaches
`sympos`, so *sympos N is the Nth occurrence in ascending address order*. (A
module target takes the other branch, `module_kallsyms_on_each_symbol()`, which
walks that module's ELF symbol table in index order and skips `SHN_UNDEF`
entries — a different ordering, and one to verify rather than assume.) The
engineer had derived the position from `nm vmlinux | grep rx_ring_refill`, and
`nm` sorts alphabetically by name unless given `-n` — for two identically named
symbols, `strcmp()` returns 0 and the tie order is whatever `qsort()` leaves
it as, which here did not match address order. Position 1 was the wireless
driver's copy.

Nothing in the kernel objects to this. A `sympos` that is in range resolves to
*some* real function and patching proceeds normally; only an out-of-range value
is rejected, with a different message:

```c
/* kernel/livepatch/core.c — klp_find_object_symbol() */
} else if (sympos != args.count && sympos > 0) {
        pr_err("symbol position %lu for symbol '%s' in object '%s' not found\n",
               sympos, name, objname ? objname : "vmlinux");
}
```

So the ambiguity that fails loudly is the safe one. A wrong-but-valid
`old_sympos` is the silent one.

### Detection

`dmesg` was clean, which was itself the clue — this was not a resolution
failure, so the question was *what* had been resolved. `old_func` is
deliberately not exposed through sysfs, but the effective position is, in the
per-function directory name — the directory is named `"%s,%lu"` with
`old_sympos ? old_sympos : 1`, so a `.old_sympos` of `0` also shows as `,1`
(the struct field itself stays `0`; only the directory name substitutes the
effective position):

```bash
ls /sys/kernel/livepatch/rx-fix/vmlinux/
# patched  rx_ring_refill,1     ← "<function>,<sympos>"
```

From there the mapping was rebuilt offline. `/proc/kallsyms` is emitted in
address order, so its listing *is* the kernel's numbering:

```bash
grep ' rx_ring_refill$' /proc/kallsyms
# ffffffff81a4c210 t rx_ring_refill    ← sympos 1
# ffffffff81b0e8c0 t rx_ring_refill    ← sympos 2

# Map each address back to its compilation unit
addr2line -f -e /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
    0xffffffff81a4c210 0xffffffff81b0e8c0
# rx_ring_refill
# drivers/net/wireless/.../rx.c:412        ← what got patched
# rx_ring_refill
# drivers/net/ethernet/.../rx.c:88         ← what was meant
```

### Resolution

The patch was rebuilt with `.old_sympos = 2` and redeployed. The sysfs
directory name confirmed the new target before anyone waited on behaviour:

```bash
ls /sys/kernel/livepatch/rx-fix/vmlinux/
# patched  rx_ring_refill,2
```

The team then added a build-time check: for every `klp_func`, resolve
`old_name` against an address-sorted symbol listing, and fail the build unless
the occurrence at the configured `old_sympos` maps back — via `addr2line` — to
the source file the patch was written against.

### Lesson

`old_sympos` is a 1-based index counted per object — in ascending address order
for `vmlinux` — and getting it wrong is one of the few livepatch mistakes the
kernel cannot catch for you:

- For a `vmlinux` target, derive it from an **address-ordered** listing:
  `/proc/kallsyms` is already in that order, and `nm -n vmlinux` can be made to
  be. Plain `nm` sorts alphabetically by name and tells you nothing about
  position.
- Always verify what was actually resolved, not just that the patch enabled.
  The `<function>,<sympos>` directory name plus an `addr2line` of the matching
  `/proc/kallsyms` entry is the whole check.
- Leaving `old_sympos` at `0` is the safe default precisely because it fails
  the load when the name is not unique. Do not set a position to silence that
  error; set it because you have confirmed which occurrence you want.

Before any of this, confirm the function exists as a symbol at all:

```bash
grep " <function_name>$" /proc/kallsyms
```

If it is absent — inlined from a header, a macro, or compiled out under the
running config — `klp_find_object_symbol()` prints `symbol '%s' not found in
symbol table` and returns `-EINVAL`, which propagates through
`klp_init_object_loaded()` and `klp_init_patch()` to `klp_enable_patch()`, so
the `insmod` fails and the module never loads. There is no partially applied
state to discover later; you simply have to patch the callers instead.

## 5. The cumulative patch that forgot `.replace`

### Scenario

A fleet had accumulated three live patches: P1 fixing `tcp_sendmsg`, P2 fixing
`ip_output`, and P3 fixing `nf_conntrack_in`. P2's fix was later identified as
the cause of a throughput regression and was slated to be dropped.

The plan was a single cumulative patch, P4, carrying the P1 and P3 fixes plus a
new security fix in `udp_sendmsg`, and *not* carrying P2's change — so that
after P4 was applied,
`ip_output` would run the original upstream code again. P4 was built, rolled
out, and everything reported healthy:

```bash
insmod p4-cumulative.ko
cat /sys/kernel/livepatch/p4-cumulative/enabled      # 1
cat /sys/kernel/livepatch/p4-cumulative/transition   # 0 — completed
```

A week of throughput graphs later, the regression was still there on every
patched host.

### Root cause

`.replace` had been left at its default of `false` in P4's `struct klp_patch`.
The line that set it had been dropped in a refactor of the patch module's
source template, and nothing at build or load time complained: a non-cumulative
patch is a perfectly legal patch.

Without `.replace`, none of the replace machinery runs. In
`klp_init_patch()` the nop generation is guarded:

```c
/* kernel/livepatch/core.c — klp_init_patch() */
if (patch->replace) {
        ret = klp_add_nops(patch);
        if (ret)
                return ret;
}
```

and in `klp_complete_transition()` the teardown of superseded patches is
guarded the same way:

```c
/* kernel/livepatch/transition.c — klp_complete_transition() */
if (klp_transition_patch->replace && klp_target_state == KLP_TRANSITION_PATCHED) {
        klp_unpatch_replaced_patches(klp_transition_patch);
        klp_discard_nops(klp_transition_patch);
}
```

So P4 did the only thing a plain patch does: for each function it named, it
pushed its own `klp_func` onto the head of that function's `ops->func_stack`
(`list_add_rcu()` in `klp_patch_func()`), and stopped there. P1, P2 and P3
stayed enabled. `tcp_sendmsg` and `nf_conntrack_in` now had two-deep stacks
whose heads happened to be P4's equivalent implementations, which is why
nothing looked wrong. But `ip_output` was not named by P4 at all — P4 had
deliberately dropped it — so nothing was pushed for it, and the head of its
`func_stack` was still P2's `klp_func`. The regression could not revert,
because nothing had asked it to.

Reverting a function that an older patch touched is exactly what `.replace`
buys, and only `.replace`. Upstream's own list of what atomic replace makes
possible leads with it: "Atomically revert some functions in a previous patch
while upgrading other functions."

### Detection

The tell is that the superseded patches were all still present. After a real
atomic replace they would not be: once the transition settles,
`klp_try_complete_transition()` calls `klp_free_replaced_patches_async()` for a
`.replace` patch, and that walks every patch ahead of the new one through
`klp_free_patch_start()` (`list_del()` from `klp_patches`) and
`klp_free_patch_finish()` (`kobject_put()`), so their sysfs directories
disappear entirely.

```bash
# Four directories, four enabled patches — no replacement happened
grep . /sys/kernel/livepatch/*/enabled
# /sys/kernel/livepatch/p1/enabled:1
# /sys/kernel/livepatch/p2/enabled:1
# /sys/kernel/livepatch/p3/enabled:1
# /sys/kernel/livepatch/p4-cumulative/enabled:1

# The flag is exposed read-only, per patch
cat /sys/kernel/livepatch/p4-cumulative/replace
# 0   ← it was never a cumulative patch

# stack_order is the patch's 1-based position in klp_patches; a successful
# atomic replace leaves the new patch alone at 1
cat /sys/kernel/livepatch/p4-cumulative/stack_order
# 4   ← stacked on top of three patches, not replacing them

# And ip_output is still owned by p2
ls /sys/kernel/livepatch/p2/vmlinux/
# ip_output,1  patched
ls /sys/kernel/livepatch/p4-cumulative/vmlinux/
# nf_conntrack_in,1  patched  tcp_sendmsg,1  udp_sendmsg,1
```

### Resolution

P4 was rebuilt unchanged except for `.replace = true` and reloaded as P5. This
time `klp_add_nops()` ran: it walked every function covered by P1 through P4,
found `ip_output` had no counterpart in the new patch, and allocated a dynamic
`nop` `klp_func` for it — an entry that the ftrace handler deliberately does
nothing for, so the original `ip_output` runs. When the transition finished,
the four older patches were unpatched, removed from `klp_patches`, and their
modules became removable.

```bash
insmod p5-cumulative.ko
cat /sys/kernel/livepatch/p5-cumulative/transition   # wait for 0

cat /sys/kernel/livepatch/p5-cumulative/replace      # 1
cat /sys/kernel/livepatch/p5-cumulative/stack_order  # 1
ls /sys/kernel/livepatch/
# p5-cumulative        ← the older directories are gone
```

### Lesson

A patch is cumulative only because you said so. Nothing infers it from the
patch's contents, and a missing `.replace` produces no warning at any stage.

- Follow the upstream advice from
  `Documentation/livepatch/cumulative-patches.rst`: "A good practice is to set
  .replace flag in any released livepatch." A patch that replaces everything is
  correct even when there is nothing to replace.
- Gate deployment on the observable outcome, not on `enabled` and `transition`.
  After the transition settles, `replace` should read `1`, `stack_order` should
  read `1`, and `/sys/kernel/livepatch/` should contain exactly one directory.
- Remember what "replace" does not do: only the new cumulative patch's
  (un)patching callbacks run, and the superseded patches' callbacks are
  skipped. Anything the patches you are superseding did in a callback, the
  cumulative patch must do itself.

See [Cumulative Patches and Atomic Replace](klp-cumulative.md) for the full
description of the `func_stack`, the `nop` funcs, and the atomic replace flow.

## Further reading

### Kernel source

- [kernel/livepatch/transition.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/transition.c) — `klp_send_signals()`, whose `wake_up_state(task, TASK_INTERRUPTIBLE)` only wakes kthreads in interruptible sleep, and `klp_try_complete_transition()`, behind Case 1
- [kernel/livepatch/shadow.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/shadow.c) — the `klp_shadow_hash` hashtable and the `klp_shadow_get_or_alloc()`/`klp_shadow_free()` pairing that Case 2's patch got wrong
- [kernel/livepatch/core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/core.c) — `klp_find_object_symbol()`, whose `old_sympos` counting and "unresolvable ambiguity"/"symbol position ... not found" errors drive Case 4, and the `if (patch->replace)` guard around `klp_add_nops()` behind Case 5
- [kernel/livepatch/patch.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/patch.c) — `klp_patch_func()`'s `list_add_rcu()` onto `ops->func_stack`, the plain stacking that Case 5's patch got instead of a replace, and `klp_ftrace_handler()`'s `if (func->nop)` early exit
- [scripts/kallsyms.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/kallsyms.c) — `compare_names()`, which breaks ties between identically named symbols by ascending address and so defines what `old_sympos` counts in Case 4
- [include/linux/livepatch.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/livepatch.h) — `struct klp_func`'s `nop` and `old_sympos` fields, including the comment stating that a zero `old_sympos` requires a unique symbol, behind Cases 1 and 4
- [Documentation/livepatch/cumulative-patches.rst](https://docs.kernel.org/livepatch/cumulative-patches.html) — the upstream atomic replace guide: the "atomically revert some functions" feature and the "set .replace flag in any released livepatch" advice Case 5 turns on
- [fs/ioctl.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/ioctl.c) — `ioctl_preallocate()` and the separate x86_64 `compat_ioctl_preallocate()` entry point, the two functions behind Case 3
- [include/linux/falloc.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/falloc.h) — `struct space_resv`/`struct space_resv_32`, the native/compat layout mismatch behind Case 3

### Related pages

- [Kernel Live Patching](klp.md) — the ftrace redirection mechanism and shadow variable API these incidents build on
- [KLP Consistency Model](klp-consistency.md) — per-task transition states and stack checking behind Case 1
- [Cumulative Patches and Atomic Replace](klp-cumulative.md) — `.replace=true`, the `nop` funcs, and `func_stack` stacking behind Case 5
- [KLP State: Custom Consistency Checks](klp-state.md) — the API for carrying state between cumulative patches, the companion problem to Case 5's callback caveat
- [kexec](kexec.md) — reboot without a full firmware POST, an alternative to live patching when a fix requires downtime

### LWN articles

- [livepatch: consistency model](https://lwn.net/Articles/632582/) (February 9, 2015) — the original per-task consistency model RFC and per-task transition design behind Case 1
- [livepatch: introduce shadow variable API](https://lwn.net/Articles/731585/) (August 21, 2017) — Joe Lawrence's patch introducing `klp_shadow_alloc()`/`klp_shadow_get()`/`klp_shadow_free()` and the `(obj, id)`-keyed hashtable behind Case 2
- [livepatch: introduce atomic replace](https://lwn.net/Articles/734997/) (September 27, 2017) — the atomic replace / cumulative patch design discussed in Case 5

### External

- [Shadow variables](https://docs.kernel.org/livepatch/shadow-vars.html) — upstream documentation on matching a shadow variable's lifecycle to its parent object's, the rule Case 2's patch violated
