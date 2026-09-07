# Syscall Auditing

> The Linux Audit subsystem: recording who called what and when

## What the audit subsystem does

The Linux audit subsystem records security-relevant events and makes them
available to a userspace daemon (`auditd`) for logging, filtering, and analysis.
Its primary use is compliance: Common Criteria evaluation, PCI-DSS, HIPAA, and
similar frameworks all require proof that specific system events were logged and
that the logs cannot be suppressed by the audited process itself.

For each audited syscall, the kernel records:

- The syscall number, arguments, and return value
- PID, UID, EUID, and the audit login UID (`auid`) — the UID of the user who
  originally authenticated, even after `setuid()` transitions
- The executable path (`exe`) and current working directory
- File paths accessed, socket addresses used, IPC objects touched

Records are written by the kernel before the syscall returns to userspace. The
audited process cannot suppress or alter them.

## Architecture

```
   kernel                          userspace
   ──────                          ─────────
   audit_syscall_entry()
   audit_syscall_exit()
        │
        │  audit_buffer records
        ▼
   kernel netlink socket
   (NETLINK_AUDIT, family 9)
        │
        │  AF_NETLINK messages
        ▼
      auditd
        │
        ├── /var/log/audit/audit.log
        └── audisp plugins (e.g., syslog, remote logging)
```

`auditd` is the only process that opens `NETLINK_AUDIT`. It sets audit rules
via `auditctl`, which sends netlink messages of type `AUDIT_ADD_RULE` and
`AUDIT_DEL_RULE` to the kernel. The kernel sends records of type `AUDIT_SYSCALL`,
`AUDIT_PATH`, `AUDIT_SOCKADDR`, and others back to `auditd` over the same
socket.

## In-kernel hooks: audit_syscall_entry() and audit_syscall_exit()

The two main entry points into the audit subsystem are called from the generic
syscall boundary code:

```c
/* include/linux/audit.h */
static inline void audit_syscall_entry(int major, unsigned long a0,
                                        unsigned long a1, unsigned long a2,
                                        unsigned long a3);
static inline void audit_syscall_exit(void *pt_regs);
```

Both are `static inline` wrappers that check `audit_context()` before doing any
work, then forward to the real implementations — `__audit_syscall_entry()` and
`__audit_syscall_exit()` — defined in `kernel/auditsc.c`.

These are called from `syscall_enter_from_user_mode()` and
`syscall_exit_to_user_mode()` in `include/linux/entry-common.h` when the
`SYSCALL_WORK_SYSCALL_AUDIT` flag is set in the current task's `syscall_work`.

`SYSCALL_WORK_SYSCALL_AUDIT` is set in `audit_alloc()` whenever a context is
allocated for the task — which, once auditing is enabled system-wide, is the
common case (see the next section). Only a task that a task-level rule
explicitly disables, or a system where audit has never been enabled at all,
skips this entirely.

## struct audit_context

Each task that is being audited carries an `audit_context` for the duration of
a syscall. The context accumulates all information about the syscall and the
kernel objects it touched:

```c
/* kernel/audit.h (internal) */
struct audit_context {
    int                dummy;       /* 1 if this is a dummy context */
    enum {
        AUDIT_CTX_UNUSED,
        AUDIT_CTX_SYSCALL,
        AUDIT_CTX_URING,
    }                  context;
    enum audit_state   state;         /* baseline from audit_filter_task(), set once at audit_alloc() */
    enum audit_state   current_state; /* per-syscall; reset to 'state' each syscall, refined by audit_filter_syscall() */

    int                major;        /* syscall number */
    unsigned long      argv[4];      /* first four syscall arguments */
    long               return_code;  /* syscall return value */
    int                return_valid; /* 1 once return_code is populated */

    int                name_count;
    struct list_head   names_list;   /* list of struct audit_names */

    struct audit_stamp stamp;        /* contains serial and ctime */

    /* ... further fields for IPC, network, LSM-specific data ... */
};
```

Note: `serial` and `ctime` are accessed as `ctx->stamp.serial` and
`ctx->stamp.ctime` via the nested `struct audit_stamp`. `loginuid` and
`sessionid` are not fields of `struct audit_context` — they live directly on
`struct task_struct` (`tsk->loginuid`, `tsk->sessionid`).

The context is attached to `current->audit_context` and is a per-*task*
allocation, not a per-syscall one — it's allocated once, in `audit_alloc()`
(see the next section), and reused for every syscall the task makes.
`audit_syscall_entry()` doesn't allocate anything; on each syscall it
re-populates the existing context's fields (`major`, `argv`, `arch`,
`context = AUDIT_CTX_SYSCALL`, a fresh timestamp) for the syscall that's
starting. `audit_syscall_exit()` doesn't free it either — after filtering and
optionally logging, it calls `audit_reset_context()`, which frees the
*accumulated* per-syscall data (names, aux records) and clears `current_state`
back to the baseline `state`, leaving the context ready for the task's next
syscall. The context struct itself is only freed at task exit, via
`audit_free()`/`audit_free_context()`.

## Two filter stages: audit_filter_task() and audit_filter_syscall()

Rule matching happens in two separate stages, not one:

**1. `audit_filter_task()`** (`kernel/auditsc.c`) runs once per task, from
`audit_alloc()` at task-creation/exec time — *before* any context exists for
that task:

```c
/* kernel/auditsc.c */
static enum audit_state audit_filter_task(struct task_struct *tsk, char **key);
```

If a task-level rule matches, its state (`AUDIT_STATE_RECORD` or
`AUDIT_STATE_DISABLED`) is returned directly. If nothing matches,
`audit_filter_task()` defaults to `AUDIT_STATE_RECORD`'s weaker cousin,
`AUDIT_STATE_BUILD` — **not** `AUDIT_STATE_DISABLED`. `audit_alloc()` only skips
context allocation entirely when the state comes back `AUDIT_STATE_DISABLED`;
`AUDIT_STATE_BUILD` still gets a context. In practice, once *any* audit rule
has ever been loaded system-wide, essentially every task gets a `BUILD`-state
context — the real savings come from the next stage deferring the expensive
work, not from skipping allocation.

**2. `audit_filter_syscall()`** (`kernel/auditsc.c`) runs at syscall *exit*,
against the context `audit_filter_task()` already allocated:

```c
/* kernel/auditsc.c */
static void audit_filter_syscall(struct task_struct *tsk,
                                  struct audit_context *ctx);
```

Rules here are matched on combinations of:

- Syscall number (`-S openat`, `-S execve`)
- Architecture (`-F arch=b64`)
- UID / EUID / AUID (`-F uid=1000`, `-F auid!=4294967295`)
- PID (`-F pid=1234`)
- Executable path (`-F exe=/usr/bin/ssh`)
- File path (watch rules, `-w /etc/passwd`)
- Custom key (`-k mykey`)

`audit_filter_syscall()` is `static void` — it does not return a value or set
`ctx->current_state` itself. It delegates to the shared helper
`__audit_filter_op()`, which walks the rule list and, on a match, sets
`ctx->current_state = state` before returning. If nothing matches,
`current_state` (already `BUILD` from stage 1) is left as-is and no record is
emitted for this syscall. If a rule matches with action `always`,
`current_state` becomes `AUDIT_STATE_RECORD` and the accumulated context is
logged.

This is the fast path: for a `BUILD`-state context, all the bookkeeping
happened for nothing if `audit_filter_syscall()` finds no match — but that
bookkeeping is far cheaper than assembling and emitting a full record, which
is what stage 2 actually gates.

## The in-kernel audit logging API

Other kernel subsystems — LSMs, filesystem hooks, device drivers — emit audit
records using the same three-function API:

```c
/* kernel/audit.c */

/* Allocate a new audit buffer for a record of type 'type' */
struct audit_buffer *audit_log_start(struct audit_context *ctx,
                                      gfp_t gfp_mask, int type);

/* Append formatted text to the buffer (printf-style) */
void audit_log_format(struct audit_buffer *ab, const char *fmt, ...);

/* Finalise and enqueue the buffer for delivery to auditd */
void audit_log_end(struct audit_buffer *ab);
```

Example from `kernel/auditsc.c` (simplified) — building the `AUDIT_SYSCALL`
record itself:

```c
ab = audit_log_start(context, GFP_KERNEL, AUDIT_SYSCALL);
if (ab) {
    audit_log_format(ab, "arch=%x syscall=%d", context->arch, context->major);
    if (context->return_valid != AUDITSC_INVALID)
        audit_log_format(ab, " success=%s exit=%ld",
                         str_yes_no(context->return_valid == AUDITSC_SUCCESS),
                         context->return_code);
    audit_log_format(ab, " a0=%lx a1=%lx a2=%lx a3=%lx items=%d",
                     context->argv[0], context->argv[1],
                     context->argv[2], context->argv[3],
                     context->name_count);
    audit_log_task_info(ab);   /* appends ppid/pid/auid/uid/gid/.../ses/comm/exe */
    audit_log_key(ab, context->filterkey);
    audit_log_end(ab);
}
```

The `pid=`/`uid=`/`auid=`/`ses=`/`comm=`/`exe=` fields don't come from a
hand-rolled format call — `audit_log_task_info()` (`kernel/audit.c`) is a
shared helper that appends the full process-identity block, reused by every
record type that needs "who did this," not just `AUDIT_SYSCALL`.

## Auxiliary records

A single syscall often generates more than one audit record. The `AUDIT_SYSCALL`
record is emitted first; then one or more auxiliary records are appended in the
same event group (identified by a shared serial number):

| Record type | When emitted | Captured via |
|-------------|-------------|--------|
| `AUDIT_PATH` | For each file path resolved during the syscall | `audit_inode()` in `fs/namei.c` callers |
| `AUDIT_CWD` | Current working directory | (built directly in `kernel/auditsc.c`) |
| `AUDIT_SOCKADDR` | Socket address used by network syscalls | `audit_sockaddr()` in `net/socket.c` |
| `AUDIT_IPC` | SysV IPC object accessed | IPC syscall paths, e.g. `ipc/shm.c`/`ipc/sem.c`/`ipc/msg.c` |
| `AUDIT_MQ_*` | POSIX message queue operations | `audit_mq_*()` in `ipc/mqueue.c` |

Each of these is a two-step handoff, the same pattern as `audit_inode()` above:
the syscall path calls a thin capture wrapper (declared in
`include/linux/audit.h`) to stash the relevant data on the current
`audit_context`, but the actual `audit_log_start(..., AUDIT_SOCKADDR)`-style
call that builds and emits the record happens later, centrally, in
`kernel/auditsc.c` when the context is finalized at syscall exit — not at the
capture site itself.

All records for one syscall share the same `msg=audit(timestamp:serial)` field.
`ausearch` and `aureport` group them by serial when presenting output.

## Userspace interface

### Adding rules with auditctl

```bash
# Watch all openat calls by uid 1000
auditctl -a always,exit -F arch=b64 -S openat -F uid=1000 -k file_access

# Watch writes and attribute changes to a sensitive file
auditctl -w /etc/passwd -p wa -k passwd_changes

# Audit privilege-related syscalls system-wide
auditctl -a always,exit -F arch=b64 \
    -S setuid -S setgid -S setresuid -S setresgid \
    -k priv_change

# List current rules
auditctl -l

# Make rules immutable until next reboot (locks audit config)
auditctl -e 2
```

### Searching logs with ausearch

```bash
# Find events tagged with a key
ausearch -k passwd_changes

# All openat calls since midnight
ausearch -sc openat --start today

# Events from a specific executable
ausearch -x /usr/bin/sudo -i

# Events affecting a file
ausearch -f /etc/shadow -i
```

### Summary reports with aureport

```bash
# Overall summary
aureport --summary

# File access summary
aureport --file --summary

# Authentication events
aureport -au

# Failed events only
aureport --failed
```

### Persistent rules

Rules written to `/etc/audit/rules.d/*.rules` are loaded by `augenrules` at
boot and passed to `auditctl -R`:

```
# /etc/audit/rules.d/50-syscall.rules
-a always,exit -F arch=b64 -S execve -k exec_tracking
-w /etc/passwd -p wa -k identity
-w /etc/shadow -p wa -k identity
```

`/etc/audit/auditd.conf` controls the daemon: log file path, rotation policy,
disk space limits, and what to do when the disk is full (`suspend`, `halt`, or
`keep_logs`).

## Performance: the fast-path and audit_dummy_context()

Audit is designed to have near-zero cost for tasks and syscalls that are not
being audited.

`audit_dummy_context()` returns true when the current task's audit context is
NULL or when `ctx->dummy` is non-zero. `dummy` is set in `__audit_syscall_entry()`
as `context->dummy = !audit_n_rules` — a global counter of how many audit
rules are currently loaded, system-wide. This is coarser and cheaper than the
per-task/per-syscall `current_state` filtering covered above: it doesn't ask
"does a rule match *this* task or syscall," only "does *any* rule exist
*anywhere* right now." A "dummy" context is one that was allocated (to avoid
the overhead of checking for a context's existence on every syscall once
auditing is enabled) but whose task has nothing to gain from the more precise
filtering, because there's nothing loaded to filter against. It does NOT mean
"no context was allocated." Code that would otherwise build expensive path or
inode records checks `audit_dummy_context()` first and skips the work:

```c
/* include/linux/audit.h */
static inline void audit_inode(struct filename *name,
                                const struct dentry *dentry,
                                unsigned int aflags)
{
    if (unlikely(!audit_dummy_context()))
        __audit_inode(name, dentry, aflags);
}
```

`audit_inode()` itself is a thin `static inline` gate in the header — the
"expensive record assembly" it's guarding lives in `__audit_inode()`
(`kernel/auditsc.c`), which is only ever reached when there's a real context to
add the path to.

`SYSCALL_WORK_SYSCALL_AUDIT` gates whether `audit_syscall_entry()` and
`audit_syscall_exit()` do anything at all — but as covered above, once audit
is enabled system-wide the flag is set for essentially every task by default
(`AUDIT_STATE_BUILD`), not just ones a rule specifically selected. The real
fast path is `audit_dummy_context()`: it's cheap enough to check on every
`audit_inode()`/`audit_log_start()`-style call site, so a `BUILD`-state
context that never gets promoted to `RECORD` costs a pointer read and a branch
per check, not full record assembly.

The `AUDIT_BACKLOG_LIMIT` (configurable via `auditctl -b`) bounds the number of
audit records buffered in the kernel while `auditd` is slow to consume them.
When the backlog fills, new records are either dropped (with a
`audit: backlog limit exceeded` kernel message) or the kernel waits, depending
on the `backlog_wait_time` setting.

## Further reading

### Kernel source

- [include/linux/audit.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/audit.h) — the public `audit_syscall_entry()`/`audit_syscall_exit()`/`audit_inode()` inline wrappers, which call the real `__audit_syscall_entry()`/`__audit_syscall_exit()`/`__audit_inode()` only when a context is present, plus `audit_dummy_context()`
- [kernel/auditsc.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/auditsc.c) — `__audit_syscall_entry()`, `__audit_syscall_exit()`, and `__audit_inode()` (the real implementations behind the inline wrappers), plus `audit_alloc()`, `audit_filter_task()`, `audit_filter_syscall()`, and `__audit_filter_op()`: the two-stage rule-matching path
- [kernel/audit.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/audit.h) — the internal `struct audit_context` and `struct audit_stamp` definitions
- [kernel/audit.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/audit.c) — the `NETLINK_AUDIT` socket, `audit_log_start()`/`audit_log_format()`/`audit_log_end()`, and `audit_backlog_limit` handling
- [include/linux/entry-common.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/entry-common.h) — `syscall_enter_from_user_mode()` and `syscall_exit_to_user_mode()`, where `audit_syscall_entry()`/`audit_syscall_exit()` are actually invoked, gated on the `SYSCALL_WORK_SYSCALL_AUDIT` flag

### Man pages

- [`auditctl(8)`](https://man7.org/linux/man-pages/man8/auditctl.8.html) — utility for loading, listing, and deleting kernel audit rules
- [`ausearch(8)`](https://man7.org/linux/man-pages/man8/ausearch.8.html) — searching audit logs by key, syscall, executable, or file
- [`aureport(8)`](https://man7.org/linux/man-pages/man8/aureport.8.html) — summary reports over audit logs
- [`auditd.conf(5)`](https://man7.org/linux/man-pages/man5/auditd.conf.5.html) — audit daemon configuration: log path, rotation, and disk-full behavior

### Related pages

- [Syscall Entry Path](syscall-entry.md) — `syscall_enter_from_user_mode()` and `syscall_exit_to_user_mode()` where the audit hooks are called
- [Linux Audit Subsystem](../security/audit.md) — broader audit coverage including IMA, PAM integration, and file watch rules
- [LSM Framework](../security/lsm.md) — the LSM hook framework; its SELinux subsection covers reading SELinux's own AVC-denial audit records via `ausearch -m AVC`
- [seccomp BPF](../security/seccomp.md) — seccomp denials appear in the audit log

### External

- [docs.kernel.org: Core kernel API — audit functions](https://docs.kernel.org/core-api/kernel-api.html#c.audit_log_start) — kernel-doc reference for `audit_log_start()`, `audit_log_format()`, `audit_log_end()`, `__audit_syscall_entry()`, and `__audit_syscall_exit()`
