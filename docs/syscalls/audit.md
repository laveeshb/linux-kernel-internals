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
void audit_syscall_entry(int major, unsigned long a1, unsigned long a2,
                          unsigned long a3, unsigned long a4);
static inline void audit_syscall_exit(void *pt_regs);
```

These are called from `syscall_enter_from_user_mode()` and
`syscall_exit_to_user_mode()` in `kernel/entry/common.c` when the
`TIF_SYSCALL_AUDIT` thread-info flag is set on the current task.

`TIF_SYSCALL_AUDIT` is set when audit rules are loaded that could match the
task. Tasks with no matching rules never set `TIF_SYSCALL_AUDIT` and never pay
the cost of audit context allocation.

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
    enum audit_state   current_state; /* AUDIT_STATE_DISABLED / AUDIT_STATE_BUILD / AUDIT_STATE_RECORD */

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

The context is attached to `current->audit_context`. It is allocated (or
re-initialised) in `audit_syscall_entry()` and released (and flushed to the
netlink socket) in `audit_syscall_exit()`.

## audit_filter_syscall(): per-rule matching

Before allocating any context, the kernel checks whether any loaded rule
matches the current task and syscall:

```c
/* kernel/auditsc.c */
static void audit_filter_syscall(struct task_struct *tsk,
                                  struct audit_context *ctx);
```

Rules are matched on combinations of:

- Syscall number (`-S openat`, `-S execve`)
- Architecture (`-F arch=b64`)
- UID / EUID / AUID (`-F uid=1000`, `-F auid!=4294967295`)
- PID (`-F pid=1234`)
- Executable path (`-F exe=/usr/bin/ssh`)
- File path (watch rules, `-w /etc/passwd`)
- Custom key (`-k mykey`)

`audit_filter_syscall()` is `static void` — it does not return a value.
Instead, it modifies `ctx->current_state` in place. If no rule matches,
`ctx->current_state` is set to `AUDIT_STATE_DISABLED` and the syscall
proceeds without any audit overhead. If a rule matches with action `always`,
`ctx->current_state` is set to `AUDIT_STATE_RECORD` and context allocation
proceeds.

This is the fast path: the filter runs on every syscall entry for audited
tasks, but the check itself is a scan of a short list of pre-compiled rule
entries.

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

Example from `kernel/auditsc.c` (simplified):

```c
ab = audit_log_start(context, GFP_KERNEL, AUDIT_SYSCALL);
if (ab) {
    audit_log_format(ab, "arch=%x syscall=%d success=%s exit=%ld",
                     context->arch, context->major,
                     success ? "yes" : "no",
                     context->return_code);
    audit_log_format(ab, " pid=%d uid=%u auid=%u ses=%u",
                     task_pid_nr(tsk),
                     from_kuid(&init_user_ns, task_uid(tsk)),
                     from_kuid(&init_user_ns, tsk->loginuid),
                     tsk->sessionid);
    audit_log_end(ab);
}
```

## Auxiliary records

A single syscall often generates more than one audit record. The `AUDIT_SYSCALL`
record is emitted first; then one or more auxiliary records are appended in the
same event group (identified by a shared serial number):

| Record type | When emitted | Source |
|-------------|-------------|--------|
| `AUDIT_PATH` | For each file path resolved during the syscall | `fs/namei.c: audit_inode()` |
| `AUDIT_CWD` | Current working directory | `kernel/auditsc.c` |
| `AUDIT_SOCKADDR` | Socket address used by network syscalls | `net/socket.c` |
| `AUDIT_IPC` | SysV IPC object accessed | `ipc/util.c` |
| `AUDIT_MQ_*` | POSIX message queue operations | `ipc/mqueue.c` |

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
NULL or when `ctx->dummy` is non-zero. A "dummy" context is one that was
allocated (to avoid the overhead of checking for a context on every syscall
once auditing is enabled) but marked dummy because no rule matched at syscall
entry. It does NOT mean "no context was allocated." Code that would otherwise
build expensive path or inode records checks `audit_dummy_context()` first and
skips the work:

```c
/* fs/namei.c */
void audit_inode(struct filename *name, const struct dentry *dentry,
                  unsigned int aflags)
{
    struct audit_context *context = audit_context();

    if (audit_dummy_context())
        return;
    /* ... expensive record assembly ... */
}
```

`TIF_SYSCALL_AUDIT` ensures the per-syscall hooks run only for tasks that have
been selected by at least one rule. Tasks that are never matched by any rule
never set `TIF_SYSCALL_AUDIT`, so `audit_syscall_entry()` and
`audit_syscall_exit()` are never called for them.

The `AUDIT_BACKLOG_LIMIT` (configurable via `auditctl -b`) bounds the number of
audit records buffered in the kernel while `auditd` is slow to consume them.
When the backlog fills, new records are either dropped (with a
`audit: backlog limit exceeded` kernel message) or the kernel waits, depending
on the `backlog_wait_time` setting.

## Further reading

- [Syscall Entry Path](syscall-entry.md) — `syscall_enter_from_user_mode()` and `syscall_exit_to_user_mode()` where the audit hooks are called
- [Linux Audit Subsystem](../security/audit.md) — broader audit coverage including IMA, PAM integration, and file watch rules
- [LSM Framework](../security/lsm.md) — LSM hooks that emit additional audit records
- [seccomp BPF](../security/seccomp.md) — seccomp denials appear in the audit log
- `kernel/audit.c` — netlink socket, `audit_log_start/format/end()`
- `kernel/auditsc.c` — `audit_syscall_entry()`, `audit_syscall_exit()`, `struct audit_context`
- `man 8 auditctl`, `man 8 ausearch`, `man 8 aureport`, `man 5 auditd.conf`
