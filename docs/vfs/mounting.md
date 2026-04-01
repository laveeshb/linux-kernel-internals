# Filesystem Registration and Mounting

> How filesystems plug into VFS and how mount() works

## Registering a filesystem type

Every filesystem must define a `file_system_type` and register it with VFS:

```c
/* include/linux/fs.h */
struct file_system_type {
    const char *name;       /* "ext4", "tmpfs", "proc", etc. */
    int fs_flags;           /* FS_REQUIRES_DEV, FS_USERNS_MOUNT, etc. */
    int (*init_fs_context)(struct fs_context *); /* fill in mount context */
    void (*kill_sb)(struct super_block *);       /* unmount cleanup */
    struct module *owner;
    struct file_system_type *next;     /* linked list of all filesystems */
    struct hlist_head fs_supers;       /* all superblocks of this type */
};

/* Register at module load time */
static struct file_system_type my_fs_type = {
    .name           = "myfs",
    .init_fs_context = my_init_fs_context,
    .kill_sb        = kill_litter_super,  /* for simple in-memory fs */
    .owner          = THIS_MODULE,
};

static int __init myfs_init(void)
{
    return register_filesystem(&my_fs_type);
}
module_init(myfs_init);

static void __exit myfs_exit(void)
{
    unregister_filesystem(&my_fs_type);
}
module_exit(myfs_exit);
```

After registration, the filesystem appears in `/proc/filesystems`:

```bash
cat /proc/filesystems
# nodev  sysfs
# nodev  tmpfs
# nodev  bdev
# nodev  proc
#        ext4
# nodev  btrfs
#        vfat
```

`nodev` means the filesystem doesn't require a block device.

## The mount syscall

The `mount(2)` system call attaches a filesystem to the directory tree [(man page)](https://man7.org/linux/man-pages/man2/mount.2.html).

```c
/* User calls: mount("/dev/sda1", "/mnt/data", "ext4", 0, "") */
SYSCALL_DEFINE5(mount, ...)
    → path_mount()
        → do_new_mount()
            1. get_fs_type("ext4")    ← find registered ext4 fs_type
            2. fs_context_for_mount() ← allocate fs_context
            3. vfs_get_tree()
                 → fs_type->init_fs_context(fc)  ← filesystem fills context
                 → fc->ops->get_tree(fc)          ← create/find superblock
                    → ext4_get_tree() → mount_bdev()
                        a. blkdev_get_by_path("/dev/sda1") ← open block device
                        b. sget_dev(): find or create super_block for this device
                        c. ext4_fill_super(): read superblock from disk,
                           set s_op, s_root, etc.
            4. do_new_mount_fc(): attach mount to the tree
                 → graft_tree(): insert new vfsmount at mountpoint

/* The result: a new struct mount attached to the namespace's mount tree */
```

## Mount namespace and vfsmount

Each process has a **mount namespace** (`struct mnt_namespace`) containing a tree of `vfsmount` objects. Mount namespaces were introduced in Linux 2.4.19 [(man page)](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html); before that, all processes shared a single global mount table. Each `vfsmount` represents one mount point:

```c
struct vfsmount {
    struct dentry *mnt_root;     /* root dentry of this mounted fs */
    struct super_block *mnt_sb;  /* superblock */
    int mnt_flags;               /* MNT_READONLY, MNT_NOSUID, etc. */
};

struct mount {
    struct vfsmount mnt;
    struct mount *mnt_parent;   /* mount that this is mounted on */
    struct dentry *mnt_mountpoint; /* dentry in parent where we're mounted */
    struct list_head mnt_child;    /* children of mnt_parent */
};
```

When path resolution reaches a mountpoint dentry, `follow_mount()` switches to the mounted filesystem's root dentry, crossing into the new `vfsmount`.

## /proc/mounts and /proc/self/mountinfo

```bash
# All current mounts
cat /proc/mounts
# sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
# proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
# /dev/sda1 / ext4 rw,relatime,errors=remount-ro 0 0
# tmpfs /tmp tmpfs rw,nosuid,nodev 0 0

# Detailed format with mount IDs (used by systemd)
cat /proc/self/mountinfo
# 36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext4 /dev/sdb rw,errors=remount-ro
# ^  ^  ^    ^     ^                ^           ^    ^
# mount_id parent_id maj:min root  mount_point opts peer_group fstype source
```

## Implementing a simple in-memory filesystem

Here's the minimal skeleton for a new filesystem:

```c
/* Inode operations for a directory */
static struct inode_operations myfs_dir_iops = {
    .lookup = simple_lookup,
    .create = myfs_create,
    .mkdir  = myfs_mkdir,
    .unlink = simple_unlink,
    .rmdir  = simple_rmdir,
};

/* File operations for a regular file */
static struct file_operations myfs_file_fops = {
    .read_iter  = generic_file_read_iter,
    .write_iter = generic_file_write_iter,
    .llseek     = generic_file_llseek,
    .mmap       = generic_file_mmap,
    .fsync      = noop_fsync,
};

/* Address space operations (page cache) */
static struct address_space_operations myfs_aops = {
    .dirty_folio    = filemap_dirty_folio,
    .writepage      = simple_writepage,
};

/* Superblock operations */
static struct super_operations myfs_super_ops = {
    .statfs         = simple_statfs,
    .drop_inode     = generic_delete_inode,
};

/* Fill in the superblock (called during mount) */
static int myfs_fill_super(struct super_block *sb, struct fs_context *fc)
{
    struct inode *root_inode;

    sb->s_maxbytes = MAX_LFS_FILESIZE;
    sb->s_blocksize = PAGE_SIZE;
    sb->s_blocksize_bits = PAGE_SHIFT;
    sb->s_magic = 0x4D594653;  /* 'MYFS' */
    sb->s_op = &myfs_super_ops;

    /* Create root inode */
    root_inode = new_inode(sb);
    root_inode->i_ino = 1;
    root_inode->i_mode = S_IFDIR | 0755;
    root_inode->i_op = &myfs_dir_iops;
    root_inode->i_fop = &simple_dir_operations;

    /* Create root dentry */
    sb->s_root = d_make_root(root_inode);

    return 0;
}

static int myfs_get_tree(struct fs_context *fc)
{
    return get_tree_nodev(fc, myfs_fill_super);
}

static const struct fs_context_operations myfs_context_ops = {
    .get_tree = myfs_get_tree,
};

static int myfs_init_fs_context(struct fs_context *fc)
{
    fc->ops = &myfs_context_ops;
    return 0;
}

static struct file_system_type myfs_type = {
    .name            = "myfs",
    .init_fs_context = myfs_init_fs_context,
    .kill_sb         = kill_litter_super,
    .owner           = THIS_MODULE,
};
```

## bind mount and move mount

```bash
# Bind mount: mount a directory at another location
mount --bind /original/path /new/path
# Creates a new vfsmount pointing to the same dentry/inode tree

# Move mount: atomically change mount location
mount --move /old/mountpoint /new/mountpoint
```

Bind mounts are widely used in containers to share host directories into a container's namespace [(man page)](https://man7.org/linux/man-pages/man8/mount.8.html).

## Further reading

- [VFS Objects](vfs-objects.md) — What superblock, inode, dentry, file are
- [Path Resolution](namei.md) — How mount points are crossed during lookup
- [Life of a write() syscall](life-of-write.md) — What happens after mounting
