# Dentry and Inode Caches

> How VFS caches filesystem lookups for performance

## Why three separate caches?

Linux maintains three distinct caches for filesystem data: the **dentry cache** (path lookups), the **inode cache** (file metadata), and the **page cache** (file contents). Understanding why they're separate — rather than one unified cache — explains many VFS design decisions.

### Different data, different access patterns

| Cache | What it stores | Typical size | Access pattern |
|-------|---------------|-------------|----------------|
| dcache | `(parent_dir, name) → inode number` | ~200 bytes per entry | Every `open()`, `stat()`, `exec()` — extremely high frequency |
| icache | Inode metadata (size, permissions, timestamps, block locations) | ~600 bytes per entry | Accessed when a file is open or its metadata is needed |
| page cache | File contents (4KB pages) | Variable (up to GBs for a hot file) | Accessed on `read()`/`write()`/`mmap()` |

A `stat()` call needs dentry + inode but no page cache pages. A `read()` needs all three. An `ls -l` in a large directory needs many dentries and inodes but few or no page cache pages. Unifying the caches would require storing vastly different-sized objects in one structure, defeating slab allocation efficiency.

### Why cache "file not found"?

The dcache stores **negative dentries**: entries where the lookup returned ENOENT. This seems wasteful — why cache a failure?

Compilers generate negative lookups constantly. A C compiler searching for `<stdio.h>` tries each directory in the include path: `/usr/local/include/stdio.h`, `/usr/include/stdio.h`, etc. Without negative caching, each failed lookup would hit the filesystem. With it, the kernel returns ENOENT from the dcache without a disk read. On build servers compiling thousands of files, this is a significant win.

Negative dentries are evicted under memory pressure just like positive ones, and they're invalidated immediately when the file is created (`d_instantiate()` replaces the negative dentry).

### Why caches are essential

Without caching, every path component lookup would require a disk read to find the directory entry. On a system doing thousands of `open()` calls per second, that would be catastrophically slow. VFS caches path lookups in the **dentry cache (dcache)** and stores open inodes in the **inode cache (icache)**.

## The dentry cache (dcache)

The dcache is a hash table mapping `(parent_dentry, name) → dentry`. Once a path component is looked up, its dentry is cached so subsequent lookups skip the filesystem:

```
First lookup of "/usr/bin/bash":
  "/" → dentry for /   (in cache)
  "usr" → miss → ext4_lookup("/", "usr") → read disk → cache
  "bin" → miss → ext4_lookup("/usr", "bin") → read disk → cache
  "bash" → miss → ext4_lookup("/usr/bin", "bash") → read disk → cache

Second lookup of "/usr/bin/bash":
  "/" → hit
  "usr" → hit
  "bin" → hit
  "bash" → hit (entire path resolved from cache, no disk I/O)
```

### Dentry states

```
In-use (d_lockref.count > 0):
  Referenced by a struct file, nameidata, or other kernel object.
  Not eligible for eviction.

Unused (d_lockref.count == 0):
  Not currently referenced. On the LRU list.
  May be evicted under memory pressure.

Negative (d_inode == NULL):
  Cached "file not found" result.
  Avoids repeated filesystem lookups for non-existent files.
```

### dcache operations

```c
/* Look up in dcache (RCU, lock-free fast path) */
struct dentry *__d_lookup_rcu(const struct dentry *parent,
                               const struct qstr *name, unsigned *seqp);

/* Full lookup with reference */
struct dentry *d_lookup(const struct dentry *parent, const struct qstr *name);

/* Add a new dentry to the cache */
void d_add(struct dentry *entry, struct inode *inode);

/* Mark a dentry as unused (release reference) */
dput(dentry);

/* Invalidate and remove from cache */
d_invalidate(dentry);

/* Check if a dentry is a mountpoint */
d_mountpoint(dentry);
```

### dcache size and statistics

```bash
# Current dcache size
cat /proc/sys/fs/dentry-state
# 234567 198765 45 0 0 0
# nr_dentry nr_unused age_limit want_pages nr_negative nr_unused

# Memory used by dcache
cat /proc/slabinfo | grep dentry
# dentry  198765  198765   192  21  1 : tunables  0  0  0 : slabdata  9465  9465  0

# Tune dcache: keep more entries (default: auto-sized)
echo 1000000 > /proc/sys/fs/dentry-state  # not directly writable; tuned via vfs_cache_pressure
```

### vfs_cache_pressure

Controls how aggressively the kernel reclaims dcache and icache under memory pressure:

```bash
# Default: 100 (balanced)
cat /proc/sys/vm/vfs_cache_pressure

# Higher: more aggressive reclaim (lower memory usage, more cache misses)
echo 200 > /proc/sys/vm/vfs_cache_pressure

# Lower: keep more entries (faster lookups, more memory used)
echo 50 > /proc/sys/vm/vfs_cache_pressure
```

## The inode cache (icache)

When a dentry's inode is loaded from disk (or created), it's stored in the inode cache. The inode stays in cache as long as it's referenced (either by a dentry or an open file).

### Inode states

```
In-use: referenced by at least one dentry or open file
  I_NEW: being initialized, not yet visible
  I_DIRTY_*: has dirty metadata (needs writeback)
  I_WRITEBACK: currently being written to disk
  I_FREEING: being evicted from cache

Unreferenced: no dentries, no open files
  On the inode LRU list, eligible for eviction
```

### Inode lifecycle

```c
/* Allocate a new inode (called by filesystem) */
struct inode *new_inode(struct super_block *sb)
{
    struct inode *inode = alloc_inode(sb);
    /* sb->s_op->alloc_inode() called if defined */
    inode->i_sb = sb;
    inode_init_always(sb, inode);
    return inode;
}

/* Get an existing inode (or create if not in cache) */
struct inode *iget_locked(struct super_block *sb, unsigned long ino)
{
    /* Hash lookup by (sb, ino) */
    inode = find_inode(sb, ino);
    if (inode)
        return inode;  /* cache hit */

    /* Cache miss: allocate and mark I_NEW */
    inode = alloc_inode(sb);
    insert_inode_hash(inode);
    /* Caller must fill in inode fields and call unlock_new_inode() */
    return inode;
}

/* Release inode reference */
iput(inode)
    → if (--i_count == 0) {
        /* No more references: call evict_inode */
        if (inode->i_nlink == 0)
            sb->s_op->evict_inode(inode);  /* delete from filesystem */
        /* If nlink > 0: move to LRU for potential reclaim */
    }
```

### Eviction

When memory is low, the kernel calls `prune_icache()` to free unused inodes:

```c
/* Called by the shrinker */
static long super_cache_scan(struct shrinker *shrink,
                              struct shrink_control *sc)
{
    struct super_block *sb = shrink->private_data;
    /* Evict unused dentries and inodes */
    prune_dcache_sb(sb, sc);
    prune_icache_sb(sb, sc);
}
```

Before an inode is freed, `evict_inode()` is called. For ext4, this writes back dirty data and releases journal resources.

## Cache statistics

```bash
# Slab allocator stats (incl. dentry and inode caches)
cat /proc/slabinfo | grep -E "^dentry|^inode_cache|ext4_inode"

# Total slab memory breakdown
cat /proc/meminfo | grep -E "Slab|SReclaimable|SUnreclaim"
# Slab:           2345678 kB
# SReclaimable:   1234567 kB  ← can be reclaimed under pressure (dcache, icache)
# SUnreclaim:     1111111 kB  ← cannot be reclaimed

# How much dcache/icache is actually using:
vmstat -m | grep -E "dentry|inode"
```

## Forcing cache drop (for testing)

```bash
# Drop all caches (pagecache + dcache + icache) — don't use in production
echo 3 > /proc/sys/vm/drop_caches

# Only drop dentries and inodes
echo 2 > /proc/sys/vm/drop_caches

# Only drop pagecache
echo 1 > /proc/sys/vm/drop_caches
```

This is useful for benchmarking to ensure you're measuring cold-cache performance. It doesn't free any dirty pages (they would be flushed first anyway).

## Further reading

- [VFS Objects](vfs-objects.md) — What dentries and inodes are
- [Path Resolution](namei.md) — How the dcache is used during lookup
- [Page Cache](../mm/page-cache.md) — The analogous cache for file data
- [Shrinker API](../mm/shrinker.md) — How caches register with the memory reclaim system
