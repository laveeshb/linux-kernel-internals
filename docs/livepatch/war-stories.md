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
the scheduler had no opportunity to call `klp_update_patch_state()` for it.
`klp_send_signals()` calls `wake_up_state(task, TASK_INTERRUPTIBLE)` for
kthreads — this can only wake tasks in interruptible sleep, not tasks actively
running in a tight loop. The kthread's tight loop without `cond_resched()`
prevented both scheduling and the `TASK_INTERRUPTIBLE` wakeup from taking
effect.

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

   The taint was accepted. The system was marked for a planned reboot within
   24 hours.

2. **Restart the kthread** (permanent fix): a follow-up patch added
   `cond_resched()` inside the loop, allowing the transition to proceed
   without forcing.

### Lesson

Kthreads that loop without sleeping or calling `cond_resched()` are the
hardest targets for live patching. Before writing a patch that covers such a
function:

- Add `cond_resched()` or a brief `msleep()` to the kthread if you control
  its source (via a separate preparatory patch).
- Or patch the non-inlined callers instead, or restructure the kernel code to
  prevent inlining by adding `noinline` and submitting a patch upstream.

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
# /proc/slabinfo showing unexpected growth
grep klp_shadow /proc/slabinfo
# klp_shadow_node  41823  41823    64   63    1 : tunables    0    0    0
#                  ^^^^^  growing over time
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

Every closed socket left an orphaned `klp_shadow_node` in the hash table.
The hash table itself is defined in `kernel/livepatch/shadow.c` and is never
shrunk automatically.

### Detection

```bash
# Shadow node count growing linearly with socket churn
watch -n 5 'grep klp_shadow /proc/slabinfo'

# Total memory consumed by shadow nodes
python3 -c "
import re
for line in open('/proc/slabinfo'):
    if 'klp_shadow' in line:
        parts = line.split()
        count = int(parts[1])
        size  = int(parts[3])
        print(f'{count} objects x {size} bytes = {count*size/1024:.1f} KB')
"
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

## 4. Patching an inline function

### Scenario

An engineer identified a bug in a small validation helper,
`check_buffer_bounds()`. The function was clearly visible in the source tree
and had a plausible symbol name. A live patch was written, the module
compiled, and loaded without errors:

```bash
insmod bounds-fix.ko
# No errors

cat /sys/kernel/livepatch/bounds-fix/enabled
# 1

cat /sys/kernel/livepatch/bounds-fix/transition
# 0  (completed instantly — suspicious)
```

But bug reports continued. The patch appeared to do nothing.

### Root cause

`check_buffer_bounds()` was declared `static inline` in a header file. The
compiler inlined it at every call site — there was no standalone copy in the
kernel's text section. The symbol did not exist in `/proc/kallsyms`:

```bash
grep check_buffer_bounds /proc/kallsyms
# (no output)
```

Because the symbol was absent, KLP could not resolve `old_addr` for the
function. The patch loaded successfully — KLP does not fail on unresolved
symbols by default when the target object is `vmlinux` and the function is
absent — but the ftrace hook was never installed. The `patched` sysfs file
revealed this:

```bash
cat /sys/kernel/livepatch/bounds-fix/vmlinux/check_buffer_bounds/patched
# 0  ← hook never fired
```

The transition completed instantly because there was nothing to transition.

### Resolution

The fix required patching every function that had inlined
`check_buffer_bounds()`. The engineer used `objdump` on the compiled kernel
to identify all call sites:

```bash
# Find functions that contain the inlined check
objdump -d /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
    | grep -B 40 "call.*bounds" \
    | grep "^[0-9a-f]* <"
```

Each containing function was then patched with a replacement that embedded
the corrected bounds check logic.

### Lesson

Before writing a live patch for any function, verify it exists as a symbol:

```bash
grep <function_name> /proc/kallsyms
```

If it is absent, the function is either inlined, a macro, or compiled out
under the current kernel config. In those cases you must patch the callers
instead. Also check that the symbol is not duplicated (multiple functions with
the same name in different compilation units), in which case `old_sympos` in
`struct klp_func` must be set to select the correct occurrence.

## 5. Cumulative patch ordering

### Scenario

Two independent patches were applied to a staging kernel: P1 patching
`inet_accept` and P2 patching `nf_conntrack_in`. Both were stable. A
cumulative patch P3 (`.replace = true`) was prepared that incorporated both
fixes plus a new security fix. P3 was loaded before confirming P1 had
finished transitioning:

```bash
# P1 was still transitioning
cat /sys/kernel/livepatch/p1/transition
# 1   ← not yet complete

# P3 loaded anyway
insmod p3-cumulative.ko
```

The result was a corrupted `func_stack` for `inet_accept`. P3's `klp_func`
was pushed onto `func_stack` while P1's `klp_func` was still marked
`transition = true`. The ftrace handler saw two entries with overlapping
transition states, and some tasks received the P3 replacement while others
were still being evaluated against P1's state. A subtle memory corruption
followed under high connection load.

### Root cause

There is no dedicated `klp_atomic_replace()` function. Cumulative replace is
handled by `klp_init_patch()`, which calls `klp_add_nops()` when
`patch->replace` is set, followed by the same transition machinery every
patch uses (`klp_enable_patch()` → `klp_init_transition()`). That machinery
assumes all existing patches are in a stable state (no active transition). If
an old patch is mid-transition, its per-task state (`KLP_TRANSITION_IDLE`,
`KLP_TRANSITION_UNPATCHED`, `KLP_TRANSITION_PATCHED`) conflicts with the new
transition's bookkeeping.

The kernel does not prevent loading a cumulative patch while another is
transitioning — it trusts the operator to sequence correctly.

### Resolution

The corrupted hosts required a reboot to restore a clean state. The
cumulative patch was re-deployed after ensuring all prior patches had
stabilized:

```bash
# Safe cumulative patch deployment sequence

# 1. Verify all existing patches are stable
for p in /sys/kernel/livepatch/*/; do
    name=$(basename "$p")
    enabled=$(cat "$p/enabled")
    transition=$(cat "$p/transition")
    echo "$name: enabled=$enabled transition=$transition"
done
# p1: enabled=1 transition=0
# p2: enabled=1 transition=0

# 2. Only then load the cumulative patch
insmod p3-cumulative.ko

# 3. Monitor the new transition
watch -n 1 'cat /sys/kernel/livepatch/p3-cumulative/transition'
```

### Lesson

Never load a cumulative (`.replace = true`) patch while any other live patch
has `transition=1`. The transition state is global to the task's
`patch_state` field, and two concurrent transitions interfere with each
other's bookkeeping. A helper script that gates the load on all patches being
stable should be part of any live patching deployment pipeline.

See [Cumulative Patches and Atomic Replace](klp-cumulative.md) for the full
description of the `func_stack` and atomic replace mechanics, and
[KLP Consistency Model](klp-consistency.md) for details on the per-task
transition state machine.

## Further reading

### Kernel source

- [kernel/livepatch/transition.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/transition.c) — `klp_send_signals()`, whose `wake_up_state(task, TASK_INTERRUPTIBLE)` only wakes kthreads in interruptible sleep, and `klp_try_complete_transition()`, behind Case 1
- [kernel/livepatch/shadow.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/shadow.c) — the `klp_shadow_hash` hashtable and the `klp_shadow_get_or_alloc()`/`klp_shadow_free()` pairing that Case 2's patch got wrong
- [kernel/livepatch/core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/livepatch/core.c) — `klp_add_nops()`, which creates the placeholder `nop` functions referenced in Case 1's lesson, and the `old_sympos` handling for duplicate symbol names behind Case 4
- [include/linux/livepatch.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/livepatch.h) — `struct klp_func`'s `nop` and `old_sympos` fields, and the per-task transition states (`KLP_TRANSITION_IDLE`/`KLP_TRANSITION_UNPATCHED`/`KLP_TRANSITION_PATCHED`) behind Case 5
- [fs/ioctl.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/ioctl.c) — `ioctl_preallocate()` and the separate x86_64 `compat_ioctl_preallocate()` entry point, the two functions behind Case 3
- [include/linux/falloc.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/falloc.h) — `struct space_resv`/`struct space_resv_32`, the native/compat layout mismatch behind Case 3
- [Shadow variables](https://docs.kernel.org/livepatch/shadow-vars.html) — upstream documentation on matching a shadow variable's lifecycle to its parent object's, the rule Case 2's patch violated

### Related pages

- [Kernel Live Patching](klp.md) — the ftrace redirection mechanism and shadow variable API these incidents build on
- [KLP Consistency Model](klp-consistency.md) — per-task transition states and stack checking behind Cases 1 and 5
- [Cumulative Patches and Atomic Replace](klp-cumulative.md) — `.replace=true` and `func_stack` stacking behind Case 5
- [KLP State: Custom Consistency Checks](klp-state.md) — the API for patches where stack scanning alone isn't sufficient, relevant background for Case 5's ordering lesson
- [kexec](kexec.md) — the fast-reboot mechanism used as the fallback once a stuck transition can't be forced safely, as in Case 1's resolution

### LWN articles

- [livepatch: consistency model](https://lwn.net/Articles/632582/) (February 9, 2015) — the original per-task consistency model RFC, which explicitly flags kthreads that never sleep or transition as an open problem, the root cause behind Case 1
- [livepatch: introduce shadow variable API](https://lwn.net/Articles/731585/) (August 21, 2017) — Joe Lawrence's patch introducing `klp_shadow_alloc()`/`klp_shadow_get()`/`klp_shadow_free()` and the `(obj, id)`-keyed hashtable behind Case 2
- [livepatch: introduce atomic replace](https://lwn.net/Articles/734997/) (September 27, 2017) — the atomic replace / cumulative patch design discussed in Case 5
