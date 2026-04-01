# Extended Attributes (xattr)

> Attaching arbitrary metadata to files and directories

## What are extended attributes?

Extended attributes (xattr) allow attaching name-value pairs to files and directories. They extend the traditional POSIX metadata (owner, permissions, timestamps) with arbitrary key-value data. Xattr support was introduced in Linux 2.4 [(man page)](https://www.man7.org/linux/man-pages/man2/getxattr.2.html).

```c
#include <sys/xattr.h>

/* Set an extended attribute */
setxattr("/path/to/file", "user.comment", "reviewed", 8, 0);

/* Get an extended attribute */
char value[256];
ssize_t len = getxattr("/path/to/file", "user.comment", value, sizeof(value));

/* List all attributes */
char list[4096];
ssize_t list_len = listxattr("/path/to/file", list, sizeof(list));
/* list is NUL-separated: "user.comment\0user.author\0" */

/* Remove an attribute */
removexattr("/path/to/file", "user.comment");
```

There are also `l` variants (`lgetxattr`, `lsetxattr`) that don't follow symlinks, and `f` variants (`fgetxattr`, `fsetxattr`) that operate on open file descriptors.

## Namespace prefixes

Every xattr name must begin with a recognized namespace prefix:

| Namespace | Prefix | Who can set/get | Purpose |
|-----------|--------|----------------|---------|
| `user` | `user.` | Any process (with write permission on file) | General application use |
| `system` | `system.` | Kernel and privileged processes | NFSv4 ACLs, POSIX ACLs |
| `security` | `security.` | Kernel security modules (LSMs) | SELinux labels, AppArmor |
| `trusted` | `trusted.` | CAP_SYS_ADMIN only | Container runtimes, OverlayFS |

### `user` namespace

Any process with write permission on the file can set `user.*` attributes:

```bash
# Tag a file for application use
setfattr -n user.reviewed -v "2024-01-15" report.pdf
getfattr -n user.reviewed report.pdf
# file: report.pdf
# user.reviewed="2024-01-15"

# List all user attributes
getfattr -d report.pdf
```

Restrictions:
- Not supported on symlinks or device files (to prevent privilege escalation via root-owned devices)
- Subject to filesystem quota if enabled

### `security` namespace

Used by Linux Security Modules. You rarely set these directly:

```bash
# SELinux file context label
getfattr -n security.selinux /etc/passwd
# security.selinux="system_u:object_r:passwd_file_t:s0"

# AppArmor (uses security.apparmor)
getfattr -n security.apparmor /usr/bin/python3
```

Setting `security.*` requires `CAP_SYS_ADMIN` or LSM-specific permissions.

### `trusted` namespace

Requires `CAP_SYS_ADMIN`. Used by:
- **OverlayFS**: `trusted.overlay.opaque`, `trusted.overlay.whiteout` for directory/file hiding
- **Container runtimes**: Store container metadata on image layers
- **Quota systems**: Some implementations store quota data in `trusted.*`

```bash
# OverlayFS opaque directory marker
getfattr -n trusted.overlay.opaque /some/overlayfs/dir
# trusted.overlay.opaque="y"
```

### `system` namespace

Used for POSIX ACLs (NFSv4 and traditional):

```bash
# POSIX ACL stored as system.posix_acl_access
setfacl -m u:alice:rw /shared/file
getfattr -n system.posix_acl_access /shared/file
# Returns binary ACL encoding
```

## Filesystem support

```bash
# Check if filesystem supports xattr
mount | grep " / " | grep -o 'user_xattr\|xattr'
# or
tune2fs -l /dev/sda1 | grep "Default mount options"

# ext4: supports all namespaces by default
# tmpfs: supports user.* and trusted.* (no security by default)
# btrfs: full xattr support
# XFS: full xattr support (uses B-tree per inode for many attrs)
# NFS: depends on server; NFSv4.2 has native xattr support
# OverlayFS: delegates to upper/lower filesystem
```

## Kernel implementation

### xattr dispatch: struct xattr_handler

Each filesystem registers handlers for each namespace:

```c
/* include/linux/xattr.h */
struct xattr_handler {
    const char *name;    /* exact name match (e.g., "system.posix_acl_access") */
    const char *prefix;  /* prefix match (e.g., "user.")  */
    int flags;

    bool (*list)(struct dentry *dentry);
    int  (*get)(const struct xattr_handler *,
                struct dentry *, struct inode *,
                const char *name, void *buffer, size_t size);
    int  (*set)(const struct xattr_handler *,
                struct mnt_idmap *, struct dentry *, struct inode *,
                const char *name, const void *value, size_t size, int flags);
};
```

ext4's xattr handler table:

```c
/* fs/ext4/xattr.c */
static const struct xattr_handler * const ext4_xattr_handler_map[] = {
    [EXT4_XATTR_INDEX_USER]              = &ext4_xattr_user_handler,
    [EXT4_XATTR_INDEX_POSIX_ACL_ACCESS]  = &posix_acl_access_xattr_handler,
    [EXT4_XATTR_INDEX_POSIX_ACL_DEFAULT] = &posix_acl_default_xattr_handler,
    [EXT4_XATTR_INDEX_TRUSTED]           = &ext4_xattr_trusted_handler,
    [EXT4_XATTR_INDEX_SECURITY]          = &ext4_xattr_security_handler,
    NULL
};

const struct xattr_handler * const *ext4_xattr_handlers = ext4_xattr_handler_map;
```

### VFS xattr syscall path

```c
/* fs/xattr.c */
SYSCALL_DEFINE5(setxattr, const char __user *, pathname,
                const char __user *, name,
                const void __user *, value, size_t, size, int, flags)
{
    struct path path;
    user_path_at(AT_FDCWD, pathname, LOOKUP_FOLLOW, &path);
    error = setxattr(mnt_idmap(path.mnt), path.dentry, name, kvalue, size, flags);
}

int setxattr(struct mnt_idmap *idmap, struct dentry *dentry,
             const char __user *name, const void __user *value,
             size_t size, int flags)
{
    /* Parse namespace prefix: "user.", "security.", etc. */
    handler = xattr_resolve_name(dentry->d_inode, &kname);

    /* Check namespace-specific permissions */
    error = handler->set(handler, idmap, dentry, inode, kname,
                          kvalue, size, flags);
}
```

### Storage in ext4

ext4 stores xattrs in two places:

1. **Inode body** (EA inode inline): small attributes stored directly in inode's unused space
2. **Dedicated xattr block**: a 4KB block holding multiple attributes in a key-value format

```
ext4 inode
├── i_extra_isize (points to end of fixed inode)
└── [xattr inline area]
    ├── entry: name_index=1("user.") name_len=3 value_len=5 → "foo" = "hello"
    └── ...

[if overflow] → separate xattr block (4096 bytes)
    ├── header: magic, refcount, hash
    ├── entries: name/value pairs sorted by name
    └── values: stored at end of block (grow backwards)
```

```bash
# Inspect xattr storage in ext4
debugfs -R "stat <inode_number>" /dev/sda1
# i_extra_isize: 28
# Extended attributes stored in inode body / block
```

## Security module integration

SELinux and other LSMs use `security.*` xattrs to label files:

```c
/* security/selinux/hooks.c */
static int selinux_inode_init_security(struct inode *inode,
                                        struct inode *dir,
                                        const struct qstr *qstr,
                                        const char **name,
                                        void **value,
                                        size_t *len)
{
    /* Set security.selinux on new file based on parent context */
    xattrs[0].name  = XATTR_SELINUX_SUFFIX;  /* "selinux" */
    xattrs[0].value = context;
    xattrs[0].value_len = clen;
    return 0;
}

/* Called from vfs_create → security_inode_init_security */
```

```bash
# Relabel a file (restore SELinux context from policy):
restorecon /path/to/file

# Check context:
ls -Z /etc/passwd
# system_u:object_r:passwd_file_t:s0 /etc/passwd

# Recursively relabel after restore:
restorecon -R /var/www/html/
```

## fscrypt and xattr

fscrypt stores its per-file encryption policy as an xattr:

```c
/* fs/crypto/policy.c */
/* fscrypt stores the encryption context via the filesystem's set_context op: */
static int fscrypt_set_context(struct inode *inode, void *fs_data)
{
    /* Stored using a filesystem-internal xattr index (EXT4_XATTR_INDEX_ENCRYPTION),
     * not directly accessible as a named user/trusted xattr */
    return inode->i_sb->s_cop->set_context(inode, &ci->ci_policy,
                                            fscrypt_context_size(&ci->ci_policy), fs_data);
}

/* ext4 uses: EXT4_XATTR_INDEX_ENCRYPTION → internal xattr, not exposed as trusted.fscrypt */
```

```bash
# Check if a file is encrypted (use fscrypt tools, not getfattr):
fscryptctl get_policy /encrypted/file
# or:
lsattr /encrypted/file | grep -o 'E'
```

## OverlayFS whiteout and opaque markers

OverlayFS uses `trusted.*` xattrs to implement its layering:

```bash
# Opaque directory: tells overlayfs to stop looking at lower layers
getfattr -n trusted.overlay.opaque /overlay/upper/somedir
# trusted.overlay.opaque="y"

# Origin: tracks which lower inode this was copied from
getfattr -n trusted.overlay.origin /overlay/upper/file
```

```c
/* fs/overlayfs/xattr.c */
int ovl_check_setxattr(struct ovl_fs *ofs, struct dentry *upperdentry,
                        enum ovl_xattr ox, const void *value, size_t size, int xerr)
{
    /* ox == OVL_XATTR_OPAQUE: trusted.overlay.opaque */
    return ovl_do_setxattr(ofs, upperdentry, ox, value, size);
}
```

## Further reading

- [VFS Objects](vfs-objects.md) — inodes that store xattrs
- [OverlayFS](../filesystems/overlayfs.md) — uses trusted.overlay.* xattrs
- [dm-crypt and fscrypt](../crypto/encryption.md) — fscrypt encryption policy xattr
- [LSM Framework](../security/lsm.md) — SELinux/AppArmor use security.* xattrs
- `fs/xattr.c` — VFS xattr dispatch
- `fs/ext4/xattr.c` — ext4 xattr storage implementation
