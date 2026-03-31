# Path Resolution (namei)

> How the kernel converts a string like "/usr/bin/bash" into an inode

## The challenge

Path resolution sounds simple: split the path on `/`, look up each component in the parent directory. But it must handle:

- Symlinks (which themselves contain paths to resolve)
- Mount points (crossing into a different filesystem)
- Concurrent modifications (another process renames a directory while you traverse it)
- `.` (current directory) and `..` (parent directory)
- Permission checks at each level

The kernel's path resolution lives in `fs/namei.c` and is called the **namei** subsystem (from the historical Unix function name).

## Entry point: filename_lookup

Most VFS operations start with a path. The kernel resolves it through:

```c
/* Simplified call chain for open("/usr/bin/bash", O_RDONLY) */
do_sys_open()
  → do_filp_open()
    → path_openat()
      → link_path_walk()   ← main resolution loop
        → walk_component()  ← resolve one path component
          → lookup_fast()   ← dcache lookup (RCU, lock-free)
          → lookup_slow()   ← filesystem lookup (takes i_rwsem)
      → do_last()          ← handle final component (open file)
```

## The nameidata structure

`struct nameidata` carries state through the resolution:

```c
/* fs/namei.c */
struct nameidata {
    struct path path;         /* current position: (dentry, vfsmount) */
    struct qstr last;         /* name of last component */
    struct path root;         /* root for this lookup */
    struct inode *inode;      /* inode of current directory */
    unsigned int flags;       /* LOOKUP_* flags */
    unsigned int state;       /* ND_* state bits */
    unsigned int depth;       /* symlink recursion depth */
    int last_type;            /* LAST_NORM, LAST_ROOT, LAST_DOT, LAST_DOTDOT */
    /* ... */
};
```

## link_path_walk: the main loop

`link_path_walk()` iterates over path components separated by `/`:

```c
/* fs/namei.c (simplified) */
static int link_path_walk(const char *name, struct nameidata *nd)
{
    /* Skip leading slashes */
    while (*name == '/')
        name++;

    for (;;) {
        struct qstr this;
        int type;

        /* Get next component (up to next '/') */
        type = hash_name(nd->path.dentry, name, &this);

        /* Special cases: "." and ".." */
        if (type != LAST_NORM) {
            /* handle . and .. */
        }

        /* Look up the component */
        err = walk_component(nd, WALK_MORE);

        /* Advance past the "/" */
        name += this.len;
        while (*name == '/')
            name++;
        if (!*name)
            break;  /* end of path */
    }
    return 0;
}
```

## walk_component: RCU-walk and ref-walk

Each component is looked up in two stages:

### Stage 1: RCU walk (lock-free, optimistic)

```c
static struct dentry *lookup_fast(struct nameidata *nd)
{
    struct dentry *parent = nd->path.dentry;

    /* Try to find in dcache under RCU (no locks, very fast) */
    dentry = __d_lookup_rcu(parent, &nd->last, &nd->next_seq);
    if (!dentry)
        return NULL;  /* miss: fall through to ref-walk */

    /* Validate: did the dentry get deleted while we looked? */
    if (!d_try_get_rcu(dentry, nd->next_seq))
        return NULL;  /* invalidated: retry */

    return dentry;
}
```

The RCU walk uses `d_seq` (a seqlock on each dentry) to detect concurrent modifications without taking any lock. This is the fast path — most lookups hit the dcache and return without taking a lock.

### Stage 2: Ref walk (takes i_rwsem)

If RCU walk fails (cache miss or retry):

```c
static struct dentry *lookup_slow(const struct qstr *name,
                                   struct dentry *dir, unsigned int flags)
{
    struct inode *inode = dir->d_inode;
    struct dentry *dentry;

    /* Lock directory for reading */
    inode_lock_shared(inode);  /* down_read(&inode->i_rwsem) */

    /* Check dcache again (race: could have been added) */
    dentry = __d_lookup(dir, name);
    if (!dentry) {
        /* Not in cache: call filesystem */
        dentry = d_alloc(dir, name);
        inode->i_op->lookup(inode, dentry, flags);
        /* dentry is now positive (with inode) or negative */
    }

    inode_unlock_shared(inode);
    return dentry;
}
```

`i_op->lookup()` calls into the filesystem (e.g., ext4) which reads the directory from disk, finds the entry, and associates its inode with the dentry.

## Mount point crossing

When resolution hits a mount point, it silently crosses into the mounted filesystem:

```c
/* At a mountpoint: switch to the new filesystem's root */
if (d_mountpoint(dentry)) {
    /* Follow the mount: nd->path = mnt->mnt_root */
    follow_mount(&nd->path);
    /* Continue resolution in the new filesystem */
}
```

This is why `cd /proc/net` works transparently even though `/proc` is a different filesystem from `/`.

## Symlink resolution

When a component is a symlink, `link_path_walk` is called recursively with the symlink's target:

```c
/* Symlink: get the link target and resolve it */
const char *link = nd->inode->i_op->get_link(nd->path.dentry,
                                               nd->inode, &delayed);
/* Recurse into link_path_walk with link as the new path */
nd->depth++;
if (nd->depth > MAXSYMLINKS)  /* default 40 */
    return -ELOOP;
err = link_path_walk(link, nd);
nd->depth--;
```

## LOOKUP flags

```c
LOOKUP_FOLLOW    /* follow final symlink */
LOOKUP_DIRECTORY /* final component must be a directory */
LOOKUP_OPEN      /* called from open(): prepare for file creation */
LOOKUP_CREATE    /* create if not exists */
LOOKUP_EXCL      /* fail if exists (for O_EXCL) */
LOOKUP_REVAL     /* force dentry revalidation (NFS) */
LOOKUP_RCU       /* stay in RCU walk mode if possible */
```

## /proc/self/fd and /proc/self/fdinfo

```bash
# Each open file has a symlink in /proc/self/fd/
ls -la /proc/self/fd
# lrwxrwxrwx 1 root 0 -> /dev/null
# lrwxrwxrwx 1 root 1 -> /dev/pts/0
# lrwxrwxrwx 1 root 2 -> /dev/pts/0

# Reading the link resolves to the file's path
readlink /proc/self/fd/0
# /dev/null
```

The `/proc/self/fd/N` symlinks use a special resolution path that goes through the process's file descriptor table rather than through the filesystem.

## Further reading

- [VFS Objects](vfs-objects.md) — What superblock, inode, dentry, file are
- [Dentry and Inode Caches](dcache-icache.md) — How path lookups are cached
- [File Operations](file-ops.md) — What happens after the path is resolved
