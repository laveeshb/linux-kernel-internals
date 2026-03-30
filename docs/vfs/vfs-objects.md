# VFS Objects: superblock, inode, dentry, file

> The four data structures that represent every file system object in Linux

## Overview

VFS defines four objects that together represent any filesystem resource:

```
Mounted filesystem
    │
    └── struct super_block
           (one per mounted filesystem)
               │
               └── struct inode  ←────────────────────────────────┐
                      (one per file/dir/symlink)                   │
                          │                                        │
                          └── struct dentry ──────── struct dentry │
                                 /                                 bin
                                 usr                               bash
                          (path components, cached)
                          │
                          └── struct file
                                 (one per open() call)
```

## struct super_block: the mounted filesystem

A `super_block` exists for each mounted filesystem instance. It holds the global state of the mounted filesystem:

```c
/* include/linux/fs/super_types.h */
struct super_block {
    dev_t                    s_dev;       /* device identifier */
    unsigned long            s_blocksize; /* block size in bytes */
    loff_t                   s_maxbytes;  /* maximum file size */
    struct file_system_type *s_type;      /* filesystem type */
    const struct super_operations *s_op; /* superblock operations vtable */
    unsigned long            s_flags;    /* MS_RDONLY etc */
    unsigned long            s_magic;    /* filesystem magic number */
    struct dentry           *s_root;     /* root directory dentry */
    struct rw_semaphore      s_umount;   /* unmount semaphore */
    void                    *s_fs_info;  /* filesystem-private data */
};

struct super_operations {
    struct inode *(*alloc_inode)(struct super_block *sb);
    void         (*destroy_inode)(struct inode *inode);
    void         (*dirty_inode)(struct inode *inode, int flags);
    int          (*write_inode)(struct inode *inode,
                                struct writeback_control *wbc);
    void         (*evict_inode)(struct inode *inode);
    void         (*put_super)(struct super_block *sb);
    int          (*sync_fs)(struct super_block *sb, int wait);
    int          (*statfs)(struct dentry *dentry, struct kstatfs *kstatfs);
};
```

`s_fs_info` is the "escape hatch" — the filesystem stores its own private data here. For ext4, it's a `struct ext4_sb_info` with journal handle, block group descriptors, etc.

## struct inode: a file system object

An `inode` represents a file, directory, symlink, device node, or socket — any named object in the filesystem. One inode can have multiple names (hard links) but a single set of metadata.

```c
/* include/linux/fs.h */
struct inode {
    umode_t              i_mode;     /* file type + permissions */
    unsigned int         i_flags;    /* S_IMMUTABLE, S_APPEND, etc. */
    kuid_t               i_uid;      /* owner UID */
    kgid_t               i_gid;      /* owner GID */
    const struct inode_operations *i_op;  /* inode operations vtable */
    struct super_block  *i_sb;       /* the filesystem this belongs to */
    struct address_space *i_mapping; /* page cache for this file */
    unsigned long        i_ino;      /* inode number */
    unsigned int         i_nlink;    /* number of hard links */
    loff_t               i_size;     /* file size in bytes */
    blkcnt_t             i_blocks;   /* number of 512-byte blocks */
    spinlock_t           i_lock;     /* protects i_blocks, i_bytes, i_size */
    struct timespec64    __i_atime;  /* access time */
    struct timespec64    __i_mtime;  /* modification time */
    struct timespec64    __i_ctime;  /* change time */
};

struct inode_operations {
    struct dentry *(*lookup)(struct inode *, struct dentry *, unsigned int);
    int (*create)(struct mnt_idmap *, struct inode *, struct dentry *,
                  umode_t, bool);
    int (*link)(struct dentry *, struct inode *, struct dentry *);
    int (*unlink)(struct inode *, struct dentry *);
    int (*mkdir)(struct mnt_idmap *, struct inode *, struct dentry *, umode_t);
    int (*rmdir)(struct inode *, struct dentry *);
    int (*rename)(struct mnt_idmap *, struct inode *, struct dentry *,
                  struct inode *, struct dentry *, unsigned int);
    int (*setattr)(struct mnt_idmap *, struct dentry *, struct iattr *);
    int (*getattr)(struct mnt_idmap *, const struct path *,
                   struct kstat *, u32, unsigned int);
    int (*permission)(struct mnt_idmap *, struct inode *, int);
    const char *(*get_link)(struct dentry *, struct inode *,
                             struct delayed_call *);  /* for symlinks */
};
```

The `i_mapping` field points to the `address_space` structure that links this inode to its pages in the page cache. When you `read()` a file, data goes into pages indexed by this `address_space`.

## struct dentry: a path component

A `dentry` (directory entry) caches the mapping from a name to an inode. The **dentry cache** (dcache) is VFS's primary lookup cache — before going to disk, the kernel checks if the path component is already in the dcache.

```c
/* include/linux/dcache.h */
struct dentry {
    unsigned int              d_flags;    /* state flags */
    seqcount_spinlock_t       d_seq;      /* seqlock for RCU walks */
    struct hlist_bl_node      d_hash;     /* hash table for lookup */
    struct dentry            *d_parent;   /* parent directory dentry */
    struct qstr               d_name;     /* name (quick string with hash) */
    struct inode             *d_inode;    /* inode this name refers to
                                            (NULL = negative dentry) */
    const struct dentry_operations *d_op;
    struct super_block       *d_sb;       /* filesystem superblock */
    struct lockref            d_lockref;  /* refcount + spinlock */
    struct list_head          d_lru;      /* LRU eviction list */
    struct hlist_head         d_children; /* child dentries */
};
```

Key distinction:
- **Positive dentry**: `d_inode != NULL` — the name exists in the filesystem
- **Negative dentry**: `d_inode == NULL` — the name was looked up but doesn't exist (cached to avoid repeated failed lookups)

Multiple dentries can point to the same inode (hard links). When you `link("a", "b")`, you create a new dentry `b` pointing to the same inode as `a`.

## struct file: an open file description

A `file` is created each time `open()` is called. Multiple `file` structs can refer to the same inode (from different processes or multiple opens in the same process):

```c
/* include/linux/fs.h */
struct file {
    spinlock_t                    f_lock;
    fmode_t                       f_mode;     /* FMODE_READ, FMODE_WRITE */
    const struct file_operations *f_op;       /* file operations vtable */
    struct address_space         *f_mapping;  /* page cache */
    struct inode                 *f_inode;    /* the inode */
    unsigned int                  f_flags;    /* O_RDONLY, O_NONBLOCK, etc. */
    const struct cred            *f_cred;     /* credentials at open time */
    struct path                   f_path;     /* dentry + vfsmount */
    loff_t                        f_pos;      /* current file position */
    file_ref_t                    f_ref;      /* reference count */
    void                         *private_data; /* filesystem-private per-open state */
};

struct file_operations {
    loff_t  (*llseek)(struct file *, loff_t, int);
    ssize_t (*read)(struct file *, char __user *, size_t, loff_t *);
    ssize_t (*write)(struct file *, const char __user *, size_t, loff_t *);
    ssize_t (*read_iter)(struct kiocb *, struct iov_iter *);
    ssize_t (*write_iter)(struct kiocb *, struct iov_iter *);
    int     (*mmap)(struct file *, struct vm_area_struct *);
    int     (*open)(struct inode *, struct file *);
    int     (*release)(struct inode *, struct file *);  /* called on last close */
    int     (*fsync)(struct file *, loff_t, loff_t, int datasync);
    long    (*unlocked_ioctl)(struct file *, unsigned int, unsigned long);
    int     (*iterate_shared)(struct file *, struct dir_context *);  /* readdir */
};
```

`f_pos` is per-open-file, which is why two processes with the same `open()` of the same file can read at different positions. But after `fork()`, parent and child share the same `struct file` (and thus the same `f_pos`) until one of them calls `open()` again.

## How the four objects relate to user operations

```
open("/usr/bin/bash", O_RDONLY)
  ↓
namei resolution:
  dentry "/" → inode of /
  dentry "usr" → inode of /usr
  dentry "bin" → inode of /usr/bin
  dentry "bash" → inode of /usr/bin/bash  ← target inode found
  ↓
alloc_file():
  new struct file created
  f_inode = bash's inode
  f_op = inode->i_fop  (ext4_file_operations)
  f_op->open() called
  ↓
returns fd (index into process's file descriptor table)

read(fd, buf, 4096)
  ↓
file = task->files->fdt->fd[fd]
file->f_op->read_iter()
  → ext4_file_read_iter()
  → generic_file_read_iter()
  → page cache lookup → disk read if miss
```

## Further reading

- [Path Resolution](namei.md) — How VFS walks from "/" to the target dentry
- [File Operations](file-ops.md) — The file_operations vtable in detail
- [Dentry and Inode Caches](dcache-icache.md) — How VFS caches lookups
- [Page Cache](../mm/page-cache.md) — Where file data lives in memory
