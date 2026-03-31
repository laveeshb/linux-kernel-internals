# Linux Audit Subsystem

> Mandatory security auditing: logging syscalls, file accesses, and user actions

## What the audit subsystem does

The Linux audit subsystem provides mandatory, tamper-resistant logging of security-relevant events:
- Syscall execution (who called `open()`, `execve()`, `setuid()`?)
- File access (who read `/etc/shadow`?)
- Authentication events (PAM, sudo)
- User/group changes
- Network connections

Unlike optional logging (`syslog`), audit records cannot be suppressed by the audited process — they're written by the kernel before the syscall returns.

```bash
# Start auditd (usually runs at boot)
systemctl start auditd
systemctl enable auditd

# Log files
/var/log/audit/audit.log         # audit records
/etc/audit/audit.rules           # persistent rules
/etc/audit/auditd.conf           # daemon configuration
```

## audit rules with auditctl

```bash
# Watch a file for reads and writes:
auditctl -w /etc/shadow -p rwa -k shadow_access
# -w: watch path, -p: permissions (r/w/x/a = read/write/exec/attr)
# -k: key (search tag)

# Watch a directory:
auditctl -w /etc/audit/ -p wa -k audit_config_change

# Audit a syscall:
auditctl -a always,exit -F arch=b64 -S execve -k exec_tracking

# Audit execve for specific users:
auditctl -a always,exit -F arch=b64 -S execve \
         -F uid=1000 -k user_execve

# Audit privilege escalation:
auditctl -a always,exit -F arch=b64 \
         -S setuid -S setgid -S setresuid -S setresgid \
         -k privilege_change

# List current rules:
auditctl -l

# Delete all rules:
auditctl -D

# Make rules immutable (lock until reboot):
auditctl -e 2
```

### Persistent rules

```bash
# /etc/audit/rules.d/50-my-rules.rules
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity

-a always,exit -F arch=b64 -S execve -k execve

# Apply rules at boot:
augenrules --load  # merges /etc/audit/rules.d/*.rules
```

## Reading audit logs

```bash
# Raw format:
grep "key=shadow_access" /var/log/audit/audit.log
# type=SYSCALL msg=audit(1234567890.123:456):
#   arch=c000003e syscall=2 success=yes exit=3
#   a0=7fff123 a1=0 a2=0 a3=0
#   items=1 ppid=1234 pid=5678 auid=1000 uid=0 gid=0 euid=0 suid=0
#   fsuid=0 egid=0 sgid=0 fsgid=0 tty=pts0
#   ses=1 comm="cat" exe="/usr/bin/cat" key="shadow_access"
# type=CWD msg=audit(1234567890.123:456): cwd="/root"
# type=PATH msg=audit(1234567890.123:456):
#   item=0 name="/etc/shadow" inode=12345 dev=08:01
#   mode=0100640 ouid=0 ogid=42 rdev=00:00

# Pretty format with ausearch:
ausearch -k shadow_access --interpret
ausearch -x /usr/bin/sudo -i  # all sudo activity, interpreted

# Summary with aureport:
aureport --summary                # overview
aureport -x --summary             # execve summary
aureport -l                       # failed logins
aureport -au                      # authentication events
aureport --failed                 # all failed events

# Recent events
ausearch --start today --interpret | head -100
ausearch --start recent -m EXECVE -i | tail -20
```

## Kernel implementation

### struct audit_context

Each syscall entry allocates (or reuses) an audit context:

```c
/* include/linux/audit.h */
struct audit_context {
    int           in_syscall; /* 1 if currently in syscall */
    enum audit_state state;   /* AUDIT_DISABLED, AUDIT_BUILD_CONTEXT, AUDIT_RECORD_CONTEXT */
    unsigned int  serial;     /* sequence number */
    struct timespec64 ctime;  /* time of syscall entry */

    int           major;      /* syscall number */
    unsigned long argv[4];    /* syscall arguments */
    long          return_code; /* syscall return value */
    int           return_valid; /* 0: not yet returned */

    int           name_count;
    struct audit_names names[AUDIT_NAMES]; /* file paths accessed */
    struct audit_names *names_list;

    struct {
        uid_t         loginuid; /* /proc/self/loginuid: original uid */
        unsigned int  sessionid;
    };

    /* LSM-specific data */
    void         *lsm_entry;
};
```

### Audit record generation

```c
/* kernel/audit.c */
void __audit_syscall_entry(int major)
/* syscall arguments are read from current_pt_regs() internally */
{
    struct task_struct *t = current;
    struct audit_context *context = audit_context();

    if (!audit_enabled)
        return;

    /* Check if this syscall should be audited */
    state = audit_filter_syscall(t, context);
    if (state == AUDIT_DISABLED)
        return;

    context->major       = major;
    context->argv[0]     = a1;
    context->argv[1]     = a2;
    context->argv[2]     = a3;
    context->argv[3]     = a4;
    context->in_syscall  = 1;
    context->state       = state;
    ktime_get_coarse_real_ts64(&context->ctime);
}

void __audit_syscall_exit(int success, long return_code)
{
    /* Called on syscall exit */
    audit_log_exit();  /* write the SYSCALL record to audit buffer */
    /* Sends via Netlink (NETLINK_AUDIT) to auditd */
}
```

### Audit path records

```c
/* fs/namei.c: called when a file path is resolved */
void audit_inode(struct filename *name, const struct dentry *dentry,
                  unsigned int aflags)
{
    struct audit_context *context = audit_context();
    struct audit_names *n;

    if (!auditing_this_syscall(context))
        return;

    /* Record the path for the current syscall's audit record */
    n = audit_alloc_name(context, AUDIT_TYPE_NORMAL);
    n->name = name;
    n->dentry = dget(dentry);
    /* Written as TYPE=PATH record when syscall exits */
}
```

## Audit from userspace: audit_log_user_message

```c
#include <libaudit.h>

int audit_fd = audit_open();

/* Log a custom security-relevant event */
audit_log_user_message(audit_fd, AUDIT_USER_AUTH,
                        "op=login acct=alice res=failed",
                        NULL, NULL, NULL, 0);

/* PAM uses this for authentication logging: */
/* type=USER_AUTH msg=audit(1234567890.123:789): pid=5678 uid=1000
   auid=1000 ses=1 op=login acct=alice res=failed */

audit_close(audit_fd);
```

## Querying audit logs programmatically

```bash
# ausearch: powerful query tool
# Find all execve of /bin/sh in the last hour:
ausearch -x /bin/sh --start recent -i

# Find who accessed /etc/sudoers:
ausearch -f /etc/sudoers -i

# Find setuid calls by a specific user:
ausearch -ua 1000 -sc setuid -i

# JSON output (auditd ≥ 3.0):
ausearch --format enriched -i | head -50
```

## Integrity Measurement Architecture (IMA)

IMA builds on audit to provide file integrity:

```bash
# IMA measures files before execution and logs to audit:
# type=INTEGRITY_PCR msg=audit(...):
#   pid=1234 uid=0 auid=0 ses=0
#   op=hash_check
#   cause=open_id
#   comm="myapp" filename=/usr/bin/myapp
#   dev="sda1" ino=12345
#   integrity_status=pass

# Enable IMA logging:
echo "measure func=FILE_MMAP mask=MAY_EXEC" >> /etc/ima/ima-policy
```

## Further reading

- [LSM Framework](lsm.md) — LSM hooks that feed audit
- [Capabilities](capabilities.md) — capability changes trigger audit events
- [seccomp BPF](seccomp.md) — syscall filtering; audit logs seccomp denials
- [Credentials and User Namespaces](credentials.md) — audit's auid (login uid)
- `kernel/audit.c` — audit core implementation
- `kernel/auditsc.c` — syscall audit records
- `man 8 auditctl`, `man 8 ausearch`, `man 8 aureport`
