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
The `klp_send_signals()` path sends `SIGURG` to unblock `D`-state tasks, but
this kthread was in `R` state (runnable) — `SIGURG` is silently ignored by
kthreads.

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
- Or use a `nop` patch: patch the function with a no-op replacement to
  instantly drain the stack, then apply the real fix as a second patch.
  The `nop` field in `struct klp_func` exists for exactly this use case:

  ```c
  /* First patch: nop to drain the old function from stacks */
  static struct klp_func drain_funcs[] = {
      {
          .old_name = "old_net_processor",
          .new_func = NULL,
          .nop      = true,    /* call through to original, just establishes hook */
      },
      {}
  };
  ```

  Once the nop patch is fully transitioned (no stacks have the old function),
  the real patch can be loaded as a cumulative replacement.

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

Shadow variables are stored in a global hash table, `klp_shadow_htable`,
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

A CVE was discovered in the read path. A live patch was deployed to all
production hosts within two hours, fixing `vfs_read`. The vulnerability was
considered remediated. Three days later, a security audit found that 32-bit
processes on a subset of mixed-architecture hosts were still exploitable.

### Root cause

The patch targeted only the 64-bit syscall entry path. The 32-bit compat
entry point, `compat_sys_read`, called a different code path that did not go
through the patched `vfs_read`:

```c
/* 64-bit path — patched */
SYSCALL_DEFINE3(read, unsigned int, fd, char __user *, buf, size_t, count)
{
    ...
    return vfs_read(f.file, buf, count, &f.file->f_pos);  /* ← patched */
}

/* 32-bit compat path — NOT patched */
COMPAT_SYSCALL_DEFINE3(read, unsigned int, fd,
                        compat_uptr_t, buf, compat_size_t, count)
{
    ...
    return vfs_read(f.file, compat_ptr(buf), count,
                    &f.file->f_pos);  /* ← same vfs_read, but... */
}
```

In this particular case the vulnerability was actually in a helper called
by both paths, but the helper was reached via a slightly different call chain
in the compat path that bypassed the patched code.

### Detection

```bash
# Check /proc/kallsyms for compat variants of the target function
grep -i "compat.*read\|read.*compat" /proc/kallsyms
# ffffffff81200a30 T compat_sys_read
# ffffffff81200b20 T __se_compat_sys_read

# Look for COMPAT_SYSCALL_DEFINE in the source
grep -r "COMPAT_SYSCALL_DEFINE.*read" fs/read_write.c
```

### Resolution

A second patch was deployed that covered the compat path. Going forward, the
team added a checklist item for every syscall patch:

1. Does the syscall have a `COMPAT_SYSCALL_DEFINE` variant?
2. Does the vulnerability exist in the 32-bit path too?
3. Are there `ia32_sys_*` wrappers (`arch/x86/entry/syscall_32.c`) that
   bypass the patched function?

### Lesson

For any patch targeting a syscall or a function called from a syscall, check
`/proc/kallsyms` and the source tree for `compat_` variants before
considering the patch complete. Architecture-specific entry tables
(`arch/x86/entry/syscalls/syscall_32.tbl`) map compat syscall numbers to
handler functions and are a good reference.

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

The KLP atomic replace path in `klp_atomic_replace()` assumes that all
existing patches are in a stable state (no active transition). It marks old
patches for replacement and then begins the new transition. If an old patch
is mid-transition, its per-task state (`KLP_UNDEFINED`, `KLP_UNPATCHED`,
`KLP_PATCHED`) conflicts with the new transition's bookkeeping.

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

- [KLP Consistency Model](klp-consistency.md) — per-task states, stack checking, forced transitions
- [Cumulative Patches and Atomic Replace](klp-cumulative.md) — stacking and .replace=true
- [Kernel Live Patching](klp.md) — shadow variables, observing patches
- `kernel/livepatch/transition.c` — klp_try_complete_transition, klp_send_signals
- `kernel/livepatch/shadow.c` — klp_shadow_htable implementation
