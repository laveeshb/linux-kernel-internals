# Credentials and User Namespaces

> struct cred, uid mapping, and capability inheritance across namespace boundaries

## struct cred: task credentials

Every task has a `struct cred` that holds its security identity:

```c
/* include/linux/cred.h */
struct cred {
    atomic_long_t usage;        /* reference count */

    kuid_t        uid;          /* real UID */
    kgid_t        gid;          /* real GID */
    kuid_t        suid;         /* saved UID */
    kgid_t        sgid;         /* saved GID */
    kuid_t        euid;         /* effective UID (used for permission checks) */
    kgid_t        egid;         /* effective GID */
    kuid_t        fsuid;        /* UID for filesystem access */
    kgid_t        fsgid;        /* GID for filesystem access */

    kernel_cap_t  cap_inheritable; /* capabilities child can gain via execve */
    kernel_cap_t  cap_permitted;   /* maximum allowed capabilities */
    kernel_cap_t  cap_effective;   /* currently active capabilities */
    kernel_cap_t  cap_bset;        /* capability bounding set */
    kernel_cap_t  cap_ambient;     /* ambient capabilities (cross-exec) */

    struct user_struct *user;
    struct user_namespace *user_ns;  /* namespace this UID belongs to */

    /* LSM blobs */
    void *security;   /* selinux_cred, etc. */
};
```

### Credential immutability

Credentials are **copy-on-write**: to modify credentials, you prepare a new copy, modify it, then commit:

```c
/* kernel/cred.c */
/* Example: setuid() implementation */
int do_setuid(uid_t uid)
{
    struct cred *new;

    /* Prepare a modifiable copy */
    new = prepare_creds();
    if (!new)
        return -ENOMEM;

    /* Modify the copy */
    new->uid  = make_kuid(current_user_ns(), uid);
    new->suid = new->uid;
    new->euid = new->uid;

    /* Commit atomically: replaces current->cred */
    return commit_creds(new);
    /* Old cred is freed when no references remain */
}

/* Reading credentials (always safe): */
uid_t uid = current_uid().val;
uid_t euid = current_euid().val;

/* Or from any task: */
uid_t uid = task_uid(task).val;
```

### The credential transition on execve

```c
/* security/commoncap.c */
int cap_bprm_creds_from_file(struct linux_binprm *bprm, const struct file *file)
{
    const struct cred *old = current_cred();
    struct cred *new = bprm->cred;

    /* For set-uid binary: */
    if (uid_eq(new->euid, root_uid) ||
        capable_wrt_inode_uidgid(&init_user_ns, file_inode(bprm->file),
                                   CAP_SETUID)) {
        new->euid = inode->i_uid;  /* set-uid: gain file owner's uid */
    }

    /* Capabilities:
     * pP' = (pI & fI) | (fP & bounding_set)
     * pE' = pP' & fE
     * pI' = pI
     *
     * where:
     *   p = process (old)
     *   f = file capability bits
     *   P = permitted, E = effective, I = inheritable
     */
    new->cap_permitted =
        cap_union(cap_intersect(old->cap_inheritable, fcaps->inheritable),
                  cap_intersect(fcaps->permitted, old->cap_bset));
}
```

## User namespaces

A **user namespace** creates a private mapping between UIDs/GIDs in the namespace and the host system. This allows:
- Unprivileged container creation
- "root" inside a container without host root
- Capability isolation: root inside namespace ≠ root outside

```bash
# Create a user namespace (unprivileged):
unshare --user --map-root-user bash
# Inside: whoami → root
# But: /proc/self/uid_map shows we're mapped to our real UID

cat /proc/self/uid_map
# 0     1000    1   (UID 0 in ns = UID 1000 on host; 1 UID mapped)
```

### uid_map and gid_map

```bash
# /proc/<pid>/uid_map format:
# <ns-uid-start> <host-uid-start> <count>

# Typical single-user mapping (for a container):
# 0     100000    65536
# UIDs 0-65535 in the namespace map to 100000-165535 on the host

# Write the mapping (from parent namespace or privileged):
echo "0 1000 1" > /proc/<pid>/uid_map
echo "0 1000 1" > /proc/<pid>/gid_map
# Note: requires either: be the process itself (unshare), or CAP_SETUID on host
```

### newuidmap / newgidmap

```bash
# For containers with range mappings:
# /etc/subuid and /etc/subgid define allowed ranges:
cat /etc/subuid
# alice:100000:65536
# (alice can use UIDs 100000-165535 for container mappings)

# Map container UIDs:
newuidmap <pid> 0 1000 1 1 100000 65536
# UID 0 in container = 1000 on host (1 UID)
# UIDs 1-65536 in container = 100000-165535 on host

newgidmap <pid> 0 1000 1 1 100000 65536
```

## Kernel: UID translation

When the kernel resolves UIDs for permission checks, it always works with **k**uids (kernel UIDs) that map to the initial user namespace:

```c
/* include/linux/uidgid.h */
typedef struct {
    uid_t val;
} kuid_t;  /* always in the initial user namespace */

/* Translate from namespace to kernel uid: */
kuid_t kuid = make_kuid(current_user_ns(), ns_uid);
/* Translate back: */
uid_t  ns_uid = from_kuid(current_user_ns(), kuid);

/* Check if a kuid is valid in a namespace: */
if (!uid_valid(kuid))
    return -EINVAL;

/* Check ownership: */
if (!uid_eq(kuid, file_inode->i_uid))
    return -EACCES;
```

### struct user_namespace

```c
/* include/linux/user_namespace.h */
struct user_namespace {
    struct uid_gid_map uid_map;    /* uid translations */
    struct uid_gid_map gid_map;
    struct uid_gid_map projid_map;

    struct user_namespace *parent; /* enclosing namespace */
    int level;                     /* nesting depth (max 32) */
    kuid_t owner;                  /* creator's kuid in parent ns */
    kgid_t group;                  /* creator's kgid in parent ns */

    struct ns_common ns;
    unsigned long flags;

    /* /proc/<pid>/uid_map + gid_map */
    struct list_head  keyring_name_list;
    struct key        *user_keyring_register;

    /* Per-namespace process limits */
    ucount_t         ucounts;
};
```

## Capabilities across namespaces

Capabilities are **namespace-scoped**: having `CAP_NET_ADMIN` in a network namespace only grants control over that namespace's network stack.

```bash
# Check capabilities in a namespace:
capsh --print
# Current: =
# cap_net_admin+eip  (only net_admin effective/inheritable/permitted)

# Run a process with specific capabilities:
capsh --caps='cap_net_admin+eip cap_sys_admin+eip' -- -c 'ip link add ...'

# Container with only net_admin (via Docker):
docker run --cap-drop=ALL --cap-add=NET_ADMIN myimage
```

```c
/* capability check: is the process allowed? */
bool capable(int cap)
{
    return ns_capable(&init_user_ns, cap);
}

bool ns_capable(struct user_namespace *ns, int cap)
{
    /* Check effective capability in the given namespace */
    return security_capable(current_cred(), ns, cap, CAP_OPT_NONE) == 0;
}

/* For filesystem operations: check against file's namespace */
bool capable_wrt_inode_uidgid(struct user_namespace *ns,
                                const struct inode *inode, int cap)
{
    /* Capable if we have cap in the ns where the inode's uid is mapped */
    struct user_namespace *inode_ns = inode->i_sb->s_user_ns;
    return ns_capable(inode_ns, cap);
}
```

## The loginuid: audit identity

`/proc/self/loginuid` records the original user who logged in, even after `su`/`sudo`:

```bash
# After ssh login as alice:
cat /proc/self/loginuid    # 1000 (alice's UID)

# After sudo su:
id                         # uid=0(root) ...
cat /proc/self/loginuid    # 1000 (still alice!)

# This is what audit uses for auid (audit uid):
ausearch -ua 1000          # find all alice's actions, even as root
```

```c
/* set on login via PAM: */
/* /proc/<pid>/loginuid is backed by task->loginuid */
kuid_t task_loginuid(const struct task_struct *t)
{
    return t->loginuid;
}

/* Cannot be changed after first set (without CAP_AUDIT_CONTROL) */
```

## Observing credential changes

```bash
# Trace setuid/setgid calls
bpftrace -e '
tracepoint:syscalls:sys_enter_setuid {
    printf("%s(%d) setuid(%d)\n", comm, pid, args->uid);
}'

# Watch capability use
bpftrace -e '
kprobe:cap_capable {
    printf("%s: checking cap %d in ns %p\n", comm, arg2, arg1);
}'

# Track credential changes (execve, setuid, etc.)
auditctl -a always,exit -F arch=b64 \
    -S execve -S setuid -S setresuid -S setresgid \
    -k cred_change
ausearch -k cred_change -i | tail -20
```

## Further reading

- [Capabilities](capabilities.md) — capability bit reference
- [LSM Framework](lsm.md) — LSM hooks on credential transitions
- [Namespaces](../cgroups/namespaces.md) — user namespace with other namespaces
- [Container Isolation](../cgroups/container-isolation.md) — practical container security
- [Linux Audit](audit.md) — audit uses loginuid for auid
- `kernel/cred.c` — credential lifecycle
- `kernel/user_namespace.c` — user namespace implementation
