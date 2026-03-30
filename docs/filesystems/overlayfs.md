# OverlayFS

> Union mounts for container image layers

## What OverlayFS does

OverlayFS presents a merged view of two or more directory trees:

```
overlay mount (what containers see):
  /
  ├── bin/bash          ← from lower (base image, read-only)
  ├── lib/              ← from lower
  ├── etc/hostname      ← from upper (container-specific, writable)
  └── tmp/myfile        ← from upper (written by container)

lower (read-only, multiple layers possible):
  Layer 3 (app image):  /app/
  Layer 2 (node):       /usr/local/bin/node
  Layer 1 (debian):     /bin/ /lib/ /etc/ ...

upper (writable layer — per container):
  etc/hostname
  tmp/myfile

work (internal scratch dir, must be on same filesystem as upper):
  (used for atomic copy-up)
```

## Mounting OverlayFS

```bash
# Basic two-layer overlay
mount -t overlay overlay \
    -o lowerdir=/lower,upperdir=/upper,workdir=/work \
    /merged

# Multi-layer (Docker uses this for image layers)
# Layers listed right-to-left: rightmost is the bottom layer
mount -t overlay overlay \
    -o lowerdir=/layer3:/layer2:/layer1,upperdir=/upper,workdir=/work \
    /merged

# Read-only overlay (no upper/work — useful for union of multiple images)
mount -t overlay overlay \
    -o lowerdir=/layer2:/layer1 \
    /merged
```

## Copy-on-write (copy-up)

When a container writes to a file from a lower layer, OverlayFS:
1. Copies the file from lower to upper (copy-up)
2. Applies the write to the copy in upper
3. Future reads see the upper copy

```
Container: open("/etc/passwd", O_RDWR)
  → File is in lower layer (read-only)
  → OverlayFS: copy /etc/passwd to upper/etc/passwd
  → Open the upper copy for writing
  → Container sees the modified version
  → Lower layer unchanged (other containers unaffected)
```

### Copy-up in the kernel

```c
/* fs/overlayfs/copy_up.c */
static int ovl_copy_up_inode(struct ovl_copy_up_ctx *c, struct dentry *temp)
{
    struct ovl_fs *ofs = OVL_FS(c->dentry->d_sb);
    int err;

    /* Copy data */
    if (S_ISREG(c->stat.mode)) {
        struct path upperpath, datapath;
        ovl_path_upper(c->dentry, &upperpath);
        ovl_copy_up_data(c, &upperpath);
    }

    /* Copy metadata (timestamps, xattrs, owner) */
    err = ovl_copy_up_metadata(c, temp);

    return err;
}

static int ovl_copy_up_data(struct ovl_copy_up_ctx *c,
                              const struct path *temp)
{
    struct file *new_file, *old_file;

    old_file = ovl_path_open(&c->lowerpath, O_LARGEFILE | O_RDONLY);
    new_file = ovl_path_open(temp, O_LARGEFILE | O_WRONLY);

    /* Atomic copy: splice/copy_file_range for zero-copy */
    err = do_splice_direct(old_file, &old_pos, new_file, &new_pos,
                            len, SPLICE_F_MOVE);
    return err;
}
```

Copy-up is atomic: the kernel writes to a temp file in `workdir`, then `rename()`s it to the final location in `upper`. If interrupted, no partial file is visible.

## Whiteout files

When a container *deletes* a file from the lower layer, OverlayFS creates a **whiteout** entry in upper — a special file that marks the file as deleted:

```bash
# Container deletes /etc/shadow
rm /etc/shadow

# In upper layer, a whiteout is created:
ls -la /upper/etc/
# c---------  0 root root 0, 0 ... shadow    ← char device 0,0 = whiteout

# OverlayFS hides lower:/etc/shadow because upper:/etc/shadow is a whiteout
```

### Opaque directories

When a container deletes a directory and recreates it (or if a copy-up of a directory occurs), OverlayFS marks the upper directory as **opaque** — lower directory contents are hidden:

```bash
# Container: rm -rf /etc && mkdir /etc && echo "new" > /etc/hosts

# upper/etc has xattr: trusted.overlay.opaque = "y"
getfattr -n trusted.overlay.opaque /upper/etc/
# trusted.overlay.opaque="y"
# → lower/etc/ contents completely hidden
```

## Metacopy optimization

**Metacopy** (`metacopy=on`) defers data copy-up until actual data write. Metadata changes (chmod, chown, xattr) only copy metadata, leaving data in lower:

```
Without metacopy:  chown myfile → full data copy-up
With metacopy:     chown myfile → only metadata copied to upper
                   write to myfile → data copy-up happens now
```

```bash
mount -t overlay overlay \
    -o lowerdir=lower,upperdir=upper,workdir=work,metacopy=on \
    /merged
```

This dramatically reduces copy-up cost for permission changes.

## Docker's overlay2 driver

Docker uses OverlayFS as its default storage driver (`overlay2`):

```bash
# Docker image layers
ls /var/lib/docker/overlay2/
# <layer-id>/
#   diff/      ← the layer's filesystem tree
#   link       ← short symlink name for this layer
#   lower      ← ':'-separated list of parent layer symlinks
#   merged/    ← the mounted overlay (only for running containers)
#   work/      ← overlay workdir

# Inspect a running container's overlay
docker inspect <container> | jq '.[].GraphDriver.Data'
# {
#   "LowerDir": "/var/lib/docker/overlay2/abc/diff:/var/lib/docker/overlay2/def/diff",
#   "MergedDir": "/var/lib/docker/overlay2/xyz/merged",
#   "UpperDir": "/var/lib/docker/overlay2/xyz/diff",
#   "WorkDir": "/var/lib/docker/overlay2/xyz/work"
# }
```

### Layer sharing

The power of OverlayFS for containers: multiple containers with the same base image share the lower layers:

```
debian:latest (shared, read-only):
  lower layers: /var/lib/docker/overlay2/abc/diff

Container A:                Container B:
  upper: /xyz/diff           upper: /pqr/diff
  lower: /abc/diff           lower: /abc/diff    (same!)
  (Container A changes)      (Container B changes)
```

Changes in Container A don't affect Container B — each has its own upper layer.

## OverlayFS internals

### struct ovl_entry

```c
/* fs/overlayfs/ovl_entry.h */
struct ovl_entry {
    union {
        struct {
            unsigned long    flags;
        };
        struct rcu_head     rcu;
    };
    unsigned                 numlower;   /* number of lower layers */
    struct ovl_path          lowerstack[]; /* flexible array of lower paths */
};

/* Per-inode overlay state */
struct ovl_inode {
    union {
        struct ovl_dir_cache  *cache;   /* directory entry cache */
        struct inode          *lowerdata; /* lower data inode (metacopy) */
    };
    const char        *redirect;         /* redirect xattr value */
    u64                version;          /* copy-up version */
    unsigned long      flags;
    struct inode       vfs_inode;        /* embedded VFS inode */
    struct dentry     *__upperdentry;    /* upper dentry (after copy-up) */
    struct ovl_entry  *oe;               /* lower layers */
};
```

### Lookup: merging directory entries

```c
/* fs/overlayfs/dir.c */
static struct dentry *ovl_lookup(struct inode *dir, struct dentry *dentry,
                                  unsigned int flags)
{
    struct ovl_entry *oe;
    const struct cred *old_cred;

    /* Look up in upper first */
    if (ovl_dentry_upper(dentry->d_parent)) {
        upperdentry = ovl_lookup_upper(dentry, ...);
        if (upperdentry && ovl_is_whiteout(upperdentry)) {
            /* Found a whiteout: file is deleted */
            return d_splice_alias(ERR_PTR(-ENOENT), dentry);
        }
    }

    /* Look up in each lower layer */
    for (i = 0; i < poe->numlower; i++) {
        lowerdentry = ovl_lookup_lower(dentry, &poe->lowerstack[i], ...);
        if (lowerdentry)
            break;
    }

    /* Merge: upper (if exists) takes precedence over lower */
    /* Opaque dirs: stop looking through lower */
}
```

## Performance considerations

```bash
# Copy-up latency: first write to a large file triggers full copy
# This can cause latency spikes in containers

# Measure copy-up cost
time (docker exec mycontainer sh -c "echo x >> /etc/large_file")

# Use named volumes to avoid copy-up for frequently written data
docker run -v /host/data:/container/data myimage

# Check overlay stats
cat /proc/fs/overlayfs/features  # supported features

# inode usage (overlayfs consumes host inodes for upper layer)
df -i /var/lib/docker
```

## Further reading

- [Container Networking](../net/container-networking.md) — network side of containers
- [Cgroups: Container Isolation](../cgroups/container-isolation.md) — full container setup
- [VFS: Filesystem Registration and Mounting](../vfs/mounting.md) — how overlayfs registers
- [VFS: Path Resolution](../vfs/namei.md) — dentry lookup through overlayfs
- [Memory Management: Copy-on-Write](../mm/cow.md) — page-level CoW vs file-level CoW
- `fs/overlayfs/` in the kernel tree — OverlayFS implementation
- `Documentation/filesystems/overlayfs.rst` in the kernel tree
