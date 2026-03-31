# Landlock: Unprivileged Sandboxing

> Restrict a process's filesystem and network access without root — the new Linux sandbox LSM

## What is Landlock?

Landlock (merged in Linux 5.13) is a Linux Security Module that allows **unprivileged processes** to restrict their own access to the filesystem (and network since 5.19). Unlike seccomp which filters syscalls, Landlock controls resource access at a semantic level.

Key properties:
- **No root required**: any process can create a Landlock sandbox for itself
- **Irreversible**: once rules are enforced, they cannot be loosened
- **Inherited**: child processes inherit the restrictions
- **Stacked**: rules can only be restricted, never expanded

## Use cases

- Browsers sandboxing renderer processes
- Language runtimes restricting downloaded code
- Security-sensitive daemons reducing attack surface
- Container runtimes as a defense-in-depth layer

## API overview

```c
#include <linux/landlock.h>
#include <sys/syscall.h>

/* The three steps: create ruleset → add rules → enforce */

/* Step 1: Create a ruleset */
struct landlock_ruleset_attr ruleset_attr = {
    .handled_access_fs =
        LANDLOCK_ACCESS_FS_EXECUTE |
        LANDLOCK_ACCESS_FS_WRITE_FILE |
        LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_CHAR |
        LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG |
        LANDLOCK_ACCESS_FS_MAKE_SYM |
        LANDLOCK_ACCESS_FS_MAKE_SOCK |
        LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK |
        LANDLOCK_ACCESS_FS_MAKE_SYM |
        LANDLOCK_ACCESS_FS_REFER |      /* rename across dirs (v2) */
        LANDLOCK_ACCESS_FS_TRUNCATE,    /* truncate (v3) */
    .handled_access_net =
        LANDLOCK_ACCESS_NET_BIND_TCP |
        LANDLOCK_ACCESS_NET_CONNECT_TCP,
};

int ruleset_fd = syscall(SYS_landlock_create_ruleset,
                          &ruleset_attr, sizeof(ruleset_attr), 0);
```

### Step 2: Add rules

```c
/* Allow read access to /usr: */
int path_fd = open("/usr", O_PATH | O_CLOEXEC);

struct landlock_path_beneath_attr path_attr = {
    .allowed_access =
        LANDLOCK_ACCESS_FS_EXECUTE |
        LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR,
    .parent_fd = path_fd,
};

syscall(SYS_landlock_add_rule,
        ruleset_fd,
        LANDLOCK_RULE_PATH_BENEATH,
        &path_attr, 0);
close(path_fd);

/* Allow read-write to /tmp: */
path_fd = open("/tmp", O_PATH | O_CLOEXEC);
path_attr.allowed_access =
    LANDLOCK_ACCESS_FS_READ_FILE |
    LANDLOCK_ACCESS_FS_WRITE_FILE |
    LANDLOCK_ACCESS_FS_READ_DIR |
    LANDLOCK_ACCESS_FS_MAKE_REG |
    LANDLOCK_ACCESS_FS_REMOVE_FILE;
path_attr.parent_fd = path_fd;

syscall(SYS_landlock_add_rule,
        ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &path_attr, 0);
close(path_fd);

/* Allow TCP connect to port 443: */
struct landlock_net_port_attr net_attr = {
    .allowed_access = LANDLOCK_ACCESS_NET_CONNECT_TCP,
    .port = 443,
};
syscall(SYS_landlock_add_rule,
        ruleset_fd, LANDLOCK_RULE_NET_PORT, &net_attr, 0);
```

### Step 3: Enforce

```c
/* Drop ambient capabilities (needed before enforce): */
prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);

/* Apply the ruleset to this process (and all its children): */
syscall(SYS_landlock_restrict_self, ruleset_fd, 0);
close(ruleset_fd);

/* From this point: filesystem and network accesses are restricted */
/* Any access not covered by a rule → EACCES */
```

## Complete sandbox example

```c
#include <fcntl.h>
#include <linux/landlock.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <stdio.h>

static inline int landlock_create_ruleset(
    const struct landlock_ruleset_attr *attr, size_t size, __u32 flags)
{
    return syscall(__NR_landlock_create_ruleset, attr, size, flags);
}
static inline int landlock_add_rule(int ruleset_fd, enum landlock_rule_type type,
                                     const void *attr, __u32 flags)
{
    return syscall(__NR_landlock_add_rule, ruleset_fd, type, attr, flags);
}
static inline int landlock_restrict_self(int ruleset_fd, __u32 flags)
{
    return syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}

int sandbox_init(void)
{
    /* Check ABI version: */
    int abi = syscall(__NR_landlock_create_ruleset, NULL, 0,
                       LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 1) {
        /* Kernel doesn't support Landlock — fall back gracefully */
        fprintf(stderr, "Landlock not supported (abi=%d)\n", abi);
        return 0;
    }

    /* Use only features available in the kernel's ABI version: */
    __u64 fs_access =
        LANDLOCK_ACCESS_FS_EXECUTE |
        LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR |
        LANDLOCK_ACCESS_FS_WRITE_FILE |
        LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_REG;
    if (abi >= 2)
        fs_access |= LANDLOCK_ACCESS_FS_REFER;
    if (abi >= 3)
        fs_access |= LANDLOCK_ACCESS_FS_TRUNCATE;

    struct landlock_ruleset_attr ruleset_attr = {
        .handled_access_fs = fs_access,
    };
    if (abi >= 4) {
        ruleset_attr.handled_access_net =
            LANDLOCK_ACCESS_NET_BIND_TCP |
            LANDLOCK_ACCESS_NET_CONNECT_TCP;
    }

    int ruleset_fd = landlock_create_ruleset(&ruleset_attr,
                                              sizeof(ruleset_attr), 0);
    if (ruleset_fd < 0)
        return -errno;

    /* Allow read-only access to /usr and /lib: */
    const char *ro_paths[] = { "/usr", "/lib", "/lib64", NULL };
    for (int i = 0; ro_paths[i]; i++) {
        int fd = open(ro_paths[i], O_PATH | O_CLOEXEC);
        if (fd < 0) continue;
        struct landlock_path_beneath_attr pa = {
            .allowed_access = LANDLOCK_ACCESS_FS_EXECUTE |
                              LANDLOCK_ACCESS_FS_READ_FILE |
                              LANDLOCK_ACCESS_FS_READ_DIR,
            .parent_fd = fd,
        };
        landlock_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &pa, 0);
        close(fd);
    }

    /* Allow read-write to /tmp: */
    int tmp_fd = open("/tmp", O_PATH | O_CLOEXEC);
    if (tmp_fd >= 0) {
        struct landlock_path_beneath_attr pa = {
            .allowed_access = LANDLOCK_ACCESS_FS_READ_FILE |
                              LANDLOCK_ACCESS_FS_WRITE_FILE |
                              LANDLOCK_ACCESS_FS_READ_DIR |
                              LANDLOCK_ACCESS_FS_MAKE_REG |
                              LANDLOCK_ACCESS_FS_REMOVE_FILE,
            .parent_fd = tmp_fd,
        };
        landlock_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &pa, 0);
        close(tmp_fd);
    }

    prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    int ret = landlock_restrict_self(ruleset_fd, 0);
    close(ruleset_fd);
    return ret;
}
```

## Filesystem access rights

```c
/* File access rights: */
LANDLOCK_ACCESS_FS_EXECUTE      /* execute a file */
LANDLOCK_ACCESS_FS_WRITE_FILE   /* write to a file */
LANDLOCK_ACCESS_FS_READ_FILE    /* open/read a file */
LANDLOCK_ACCESS_FS_READ_DIR     /* list a directory (opendir) */
LANDLOCK_ACCESS_FS_REMOVE_DIR   /* rmdir */
LANDLOCK_ACCESS_FS_REMOVE_FILE  /* unlink */
LANDLOCK_ACCESS_FS_MAKE_CHAR    /* mknod char device */
LANDLOCK_ACCESS_FS_MAKE_DIR     /* mkdir */
LANDLOCK_ACCESS_FS_MAKE_REG     /* create regular file (creat/open O_CREAT) */
LANDLOCK_ACCESS_FS_MAKE_SOCK    /* create Unix socket */
LANDLOCK_ACCESS_FS_MAKE_FIFO    /* mkfifo */
LANDLOCK_ACCESS_FS_MAKE_BLOCK   /* mknod block device */
LANDLOCK_ACCESS_FS_MAKE_SYM     /* symlink */
LANDLOCK_ACCESS_FS_REFER        /* rename/link across directories (v2+) */
LANDLOCK_ACCESS_FS_TRUNCATE     /* truncate (v3+) */

/* Network access rights (v4+): */
LANDLOCK_ACCESS_NET_BIND_TCP    /* bind() a TCP socket to a port */
LANDLOCK_ACCESS_NET_CONNECT_TCP /* connect() a TCP socket to a port */
```

## Kernel implementation

### LSM hook

```c
/* security/landlock/fs.c */
static int hook_path_link(struct dentry *old_dentry,
                           const struct path *new_dir,
                           struct dentry *new_dentry)
{
    const struct landlock_ruleset *dom = landlock_get_current_domain();
    if (!dom)
        return 0;  /* not sandboxed */

    /* Check that the process is allowed to create links in new_dir: */
    return check_access_path(dom, new_dir,
                             LANDLOCK_ACCESS_FS_MAKE_REG);
}
```

### Rule storage

```c
/* Rules are stored in a red-black tree keyed by inode number: */
struct landlock_ruleset {
    struct rb_root_cached  root_inode;  /* FS rules */
    struct rb_root_cached  root_net;    /* net rules */
    /* ... */
};

/* On landlock_add_rule with LANDLOCK_RULE_PATH_BENEATH: */
/* - open the path_fd → get the inode number */
/* - insert a node in root_inode with allowed_access bitmask */
/* - All paths under that inode get the access rights */
```

## Landlock vs seccomp vs AppArmor

| Feature | seccomp | Landlock | AppArmor |
|---------|---------|----------|----------|
| Requires root | No | No | Yes (policy load) |
| Granularity | Syscall | Resource semantic | Path/capability |
| Stackable | Yes (AND) | Yes (most restrictive) | No |
| Runtime performance | Fast (BPF) | Fast (rb-tree) | Fast |
| Policy language | C/BPF | C API | Text profiles |
| Filesystem | Via syscall | Direct FS semantic | Yes |
| Network | Via syscall | TCP port (v4+) | Yes |

## Debugging

```bash
# Check Landlock support:
grep LANDLOCK /boot/config-$(uname -r)
# CONFIG_SECURITY_LANDLOCK=y

# Trace Landlock denials (shows as EACCES with LSM audit):
ausearch -m AVC | grep landlock
# or:
dmesg | grep "landlock"

# Test a sandbox:
# (requires landlock-abi >= 1)
unshare --user -- bash -c '
  python3 -c "
import ctypes, os
# ... simplified landlock in Python ...
"'

# strace shows EACCES for denied operations:
strace -e open,openat,write ./sandboxed_program 2>&1 | grep EACCES
```

## Further reading

- [seccomp](seccomp.md) — syscall-level filtering
- [LSM Framework](lsm.md) — how Landlock hooks into the LSM stack
- [Capabilities](capabilities.md) — privilege reduction
- [User Namespaces](user-namespaces.md) — unprivileged isolation
- `security/landlock/` — kernel implementation
- `Documentation/userspace-api/landlock.rst` — official kernel docs
- `samples/landlock/sandboxer.c` — example in kernel tree
