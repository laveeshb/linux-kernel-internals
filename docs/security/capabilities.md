# Linux Capabilities

> Fine-grained privilege decomposition

## The problem with root

Traditionally, privilege in Unix is binary: a process either has UID 0 (root, omnipotent) or it doesn't. This is too coarse — a web server needs to bind to port 80, but shouldn't have access to raw network sockets, loading kernel modules, or rebooting the system.

Linux capabilities split root's power into ~40 discrete privileges that can be granted independently.

## The 40 capabilities

```c
/* include/uapi/linux/capability.h */

/* Networking */
CAP_NET_BIND_SERVICE  /* bind to ports < 1024 */
CAP_NET_RAW           /* use raw sockets, ICMP */
CAP_NET_ADMIN         /* configure network interfaces, routing */
CAP_NET_BROADCAST     /* make socket broadcasts */

/* Process control */
CAP_KILL             /* send signals to any process */
CAP_SETUID           /* set any UID */
CAP_SETGID           /* set any GID */
CAP_SETPCAP          /* set/drop capabilities */

/* System administration */
CAP_SYS_ADMIN        /* many privileged operations (too broad) */
CAP_SYS_BOOT         /* reboot() syscall */
CAP_SYS_MODULE       /* load/unload kernel modules */
CAP_SYS_TIME         /* set system clock */
CAP_SYS_PTRACE       /* ptrace any process */
CAP_SYS_RAWIO        /* iopl, direct port I/O */
CAP_SYS_CHROOT       /* chroot() */
CAP_SYS_NICE         /* set negative nice values, scheduling class */
CAP_SYS_RESOURCE     /* set resource limits, override hard limits */

/* File operations */
CAP_CHOWN            /* change file ownership */
CAP_DAC_OVERRIDE     /* bypass file permission checks */
CAP_DAC_READ_SEARCH  /* bypass read/search checks */
CAP_FOWNER           /* bypass file owner checks */
CAP_FSETID           /* set setuid/setgid on files */
CAP_LINUX_IMMUTABLE  /* set immutable/append-only file flags */
CAP_MKNOD            /* create special files */

/* IPC */
CAP_IPC_LOCK         /* lock memory (mlock) */
CAP_IPC_OWNER        /* override IPC ownership checks */

/* Security */
CAP_MAC_ADMIN        /* manage MAC policies (SELinux/AppArmor) */
CAP_MAC_OVERRIDE     /* override MAC (SELinux) */
CAP_AUDIT_CONTROL    /* configure audit */
CAP_AUDIT_READ       /* read audit log */
CAP_AUDIT_WRITE      /* write audit log */

/* BPF */
CAP_BPF              /* load and run BPF programs (5.8+) */
CAP_PERFMON          /* perf_event_open for tracing (5.8+) */

/* Checkpoint/restore */
CAP_CHECKPOINT_RESTORE  /* CRIU restore operations */
```

## Capability sets

Each process has **5 capability sets**:

```c
/* Per-thread capability state */
struct thread_info {
    /* ... */
};

/* In struct cred: */
struct cred {
    /* ... */
    kernel_cap_t    cap_inheritable; /* can be inherited across exec */
    kernel_cap_t    cap_permitted;   /* superset of effective */
    kernel_cap_t    cap_effective;   /* actually used for checks */
    kernel_cap_t    cap_bset;        /* bounding set: max cap_permitted */
    kernel_cap_t    cap_ambient;     /* ambient: auto-added to permitted on exec (since 4.3) */
};
```

Rules:
- **Effective**: used in access checks (`capable()`)
- **Permitted**: superset of effective; can re-add dropped effective caps
- **Inheritable**: can be passed across exec if the file also has it
- **Bounding**: ceiling — caps in bset can be in permitted; once dropped, cannot be regained
- **Ambient**: automatically inherited by children and across exec (since 4.3)

## Checking capabilities in the kernel

```c
/* Anywhere in the kernel: */
if (!capable(CAP_SYS_ADMIN))
    return -EPERM;

/* Namespace-aware check: */
if (!ns_capable(net->user_ns, CAP_NET_ADMIN))
    return -EPERM;

/* From task explicitly: */
if (!has_capability(task, CAP_KILL))
    return -EPERM;
```

`capable()` checks `current->cred->cap_effective`.

## Viewing and modifying capabilities

```bash
# View capabilities of current process
cat /proc/self/status | grep -i cap
# CapInh: 0000000000000000
# CapPrm: 0000003fffffffff
# CapEff: 0000003fffffffff
# CapBnd: 0000003fffffffff
# CapAmb: 0000000000000000

# Decode capability bitmask
capsh --decode=0000003fffffffff
# 0x0000003fffffffff=cap_chown,cap_dac_override,cap_dac_read_search,...

# View capabilities of a running process
cat /proc/1234/status | grep Cap

# Run a command with specific capabilities
capsh --caps="cap_net_bind_service+eip" -- -c "/usr/sbin/nginx"

# Drop all capabilities (security hardening)
capsh --drop=all -- -c "myprogram"
```

## File capabilities (setcap)

Executables can have capabilities in their extended attributes, allowing them to run with elevated privileges without setuid:

```bash
# Grant capability to an executable
setcap cap_net_bind_service=+eip /usr/bin/node

# View capabilities on a file
getcap /usr/bin/node
# /usr/bin/node cap_net_bind_service=eip

# Remove all capabilities
setcap -r /usr/bin/node

# Common use cases:
setcap cap_net_bind_service=+eip /usr/bin/node  # Node.js on port 80
setcap cap_net_raw=+eip /usr/bin/ping           # raw ICMP without root
setcap cap_dac_read_search=+eip /usr/sbin/rsync  # backup without root
```

The `e`, `i`, `p` flags:
- `e` = effective
- `i` = inheritable
- `p` = permitted

## Capability-based privilege dropping

A properly written daemon starts with root, acquires needed capabilities, then drops the rest:

```c
/* daemon startup: */
static void drop_privileges(void)
{
    /* Keep only what we need: CAP_NET_BIND_SERVICE */
    cap_t caps = cap_get_proc();

    cap_value_t keep[] = { CAP_NET_BIND_SERVICE };

    /* Clear all caps, then set only what we need */
    cap_clear(caps);
    cap_set_flag(caps, CAP_EFFECTIVE,   1, keep, CAP_SET);
    cap_set_flag(caps, CAP_PERMITTED,   1, keep, CAP_SET);
    cap_set_flag(caps, CAP_INHERITABLE, 0, NULL, CAP_CLEAR);

    if (cap_set_proc(caps) < 0)
        err(1, "cap_set_proc");
    cap_free(caps);

    /* Also drop from bounding set to prevent re-gaining */
    if (prctl(PR_CAPBSET_DROP, CAP_SYS_ADMIN, 0, 0, 0) < 0)
        err(1, "PR_CAPBSET_DROP");

    /* Change to non-root uid/gid */
    if (setgid(www_gid) < 0 || setuid(www_uid) < 0)
        err(1, "setuid/setgid");
}
```

## No-New-Privileges

`PR_SET_NO_NEW_PRIVS` prevents a process from gaining any new privileges through exec (even via setuid binaries or file capabilities):

```c
prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
/* Now: execve() cannot gain capabilities or change uid via setuid */
/* This is also set by seccomp filter installation */
```

```bash
# Run with no new privileges (set via prctl in the program itself)
# prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
unshare --user bash
```

## CAP_SYS_ADMIN: the problem capability

`CAP_SYS_ADMIN` is sometimes called "the new root" because it covers too many unrelated operations:

- Mount/unmount filesystems
- Configure network namespaces
- `ptrace` (with restrictions)
- Access kernel keyring
- Modify disk quotas
- Override resource limits
- Set hostname (UTS namespace)
- ... and 40+ more

Prefer more specific capabilities where possible. If a library says "requires CAP_SYS_ADMIN", investigate whether a narrower capability works.

## Further reading

- [LSM Framework](lsm.md) — MAC on top of capability checks
- [seccomp BPF](seccomp.md) — Syscall-level filtering
- [Cgroups & Namespaces: User Namespace](../cgroups/namespaces.md) — Capabilities in user namespaces
- `man 7 capabilities` — complete capability reference
