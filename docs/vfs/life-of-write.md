# Life of a write() Syscall

> From application call to dirty page in the page cache (and eventually to disk)

## Overview

```
Application: write(fd, buf, 4096)
    ↓
Syscall entry → vfs_write()
    ↓
Permission check
    ↓
generic_file_write_iter()
    ↓
Page cache: find or create pages
    ↓
copy_from_user() → dirty page
    ↓
Mark inode dirty, update i_size
    ↓
Return to application
    ↓ (later)
Writeback daemon (kworker/flusher)
    ↓
Filesystem's ->writepages() (ext4, etc.)
    ↓
Block layer → disk
```

## Phase 1: Syscall entry

The `write(2)` system call is documented in the Linux man pages [(man page)](https://man7.org/linux/man-pages/man2/write.2.html). The VFS layer dispatches it through a chain of generic helpers before it reaches the filesystem-specific code.

```c
/* arch/x86/entry/syscalls/syscall_64.tbl → sys_write */
SYSCALL_DEFINE3(write, unsigned int, fd, const char __user *, buf, size_t, count)
{
    /* 1. Get struct file from fd */
    struct fd f = fdget_pos(fd);

    /* 2. Get current position */
    loff_t pos = file_pos_read(f.file);

    /* 3. Dispatch to VFS */
    ret = vfs_write(f.file, buf, count, &pos);

    /* 4. Update file position */
    file_pos_write(f.file, pos);
    fdput_pos(f);
    return ret;
}
```

## Phase 2: VFS checks

```c
/* fs/read_write.c */
ssize_t vfs_write(struct file *file, const char __user *buf,
                  size_t count, loff_t *pos)
{
    /* Check that file is open for writing */
    if (!(file->f_mode & FMODE_WRITE))
        return -EBADF;

    /* Security check (SELinux, AppArmor, etc.) */
    ret = security_file_permission(file, MAY_WRITE);

    /* Dispatch to filesystem's write_iter */
    if (file->f_op->write_iter)
        ret = new_sync_write(file, buf, count, pos);
    else if (file->f_op->write)
        ret = file->f_op->write(file, buf, count, pos);
}
```

## Phase 3: generic_file_write_iter

For regular files, the filesystem's `write_iter` (e.g., `ext4_file_write_iter`) eventually calls `generic_file_write_iter()`:

```c
/* mm/filemap.c */
ssize_t generic_file_write_iter(struct kiocb *iocb, struct iov_iter *from)
{
    struct file *file = iocb->ki_filp;
    struct inode *inode = file->f_mapping->host;

    /* Lock inode for writing (prevents concurrent writes) */
    inode_lock(inode);

    /* Check file size limits */
    ret = generic_write_checks(iocb, from);

    /* Write to page cache */
    ret = generic_perform_write(iocb, from);

    inode_unlock(inode);
    return ret;
}
```

## Phase 4: writing to the page cache

`generic_perform_write()` loops over each page needed:

```c
ssize_t generic_perform_write(struct kiocb *iocb, struct iov_iter *i)
{
    struct address_space *mapping = iocb->ki_filp->f_mapping;
    loff_t pos = iocb->ki_pos;

    do {
        unsigned long offset = pos & (PAGE_SIZE - 1); /* offset within page */
        size_t bytes = min(PAGE_SIZE - offset, iov_iter_count(i));

        /* 1. Find or allocate page in page cache */
        page = a_ops->write_begin(file, mapping, pos, bytes, &page, &fsdata);
        /* write_begin may read the page from disk if partially written */

        /* 2. Copy data from userspace into the page */
        copied = copy_page_from_iter_atomic(page, offset, bytes, i);

        /* 3. Mark page dirty and update state */
        a_ops->write_end(file, mapping, pos, bytes, copied, page, fsdata);
        /* write_end calls set_page_dirty() → marks page for writeback */

        pos += copied;
    } while (iov_iter_count(i));

    return pos - iocb->ki_pos;
}
```

## Phase 5: dirty tracking

After `set_page_dirty()`, multiple structures are marked dirty:

```c
/* Page is added to address_space->i_pages as a dirty folio */
set_page_dirty(page)
    → folio_mark_dirty(folio)
        → mapping->a_ops->dirty_folio()
        → __set_page_dirty()
            → radix_tree_tag_set(mapping, page_index, PAGECACHE_TAG_DIRTY)

/* Inode is added to the superblock's dirty inode list */
__mark_inode_dirty(inode, I_DIRTY_PAGES)
    → list_move(&inode->i_io_list, &wb->b_dirty)
    /* wb = writeback control (one per bdi = block device) */

/* Writeback timer is armed if not already */
wb_wakeup_delayed(wb)
```

## Phase 6: writeback

The writeback daemon (`kworker`) periodically flushes dirty pages to disk:

```c
/* Called by kworker thread in fs/fs-writeback.c */
void wb_workfn(struct bdi_writeback *wb)
{
    /* Find all dirty inodes */
    while (!list_empty(&wb->b_io)) {
        inode = list_first_entry(&wb->b_io, ...);

        /* Write all dirty pages for this inode */
        writeback_single_inode(inode, wbc);
            → mapping->a_ops->writepages(mapping, wbc)
                → ext4_writepages()
                    → mpage_writepages()
                        → for each dirty page:
                            submit_bio(bio)
                            → block layer → disk
    }
}
```

Writeback is triggered by:
- **Time**: after `dirty_expire_centisecs` (default 3000 = 30 seconds)
- **Memory pressure**: when dirty pages exceed `dirty_ratio` (default 20% of RAM)
- **fsync()**: explicit flush by the application

## Viewing dirty page state

```bash
# Current dirty memory
cat /proc/meminfo | grep -i dirty
# Dirty:          102400 kB   ← data written but not yet on disk
# Writeback:        4096 kB   ← data being written to disk right now

# Writeback tunables
cat /proc/sys/vm/dirty_ratio          # max dirty as % of RAM before throttle
cat /proc/sys/vm/dirty_background_ratio  # % to start background writeback
cat /proc/sys/vm/dirty_expire_centisecs  # age before dirty data is written
cat /proc/sys/vm/dirty_writeback_centisecs  # how often to wake writeback

# Per-device writeback stats
ls /sys/class/bdi/*/
cat /sys/class/bdi/8:0/read_ahead_kb
```

## fsync() vs fdatasync() vs sync()

`fsync()` [(man page)](https://man7.org/linux/man-pages/man2/fsync.2.html) guarantees that all data and metadata for a file are on stable storage. `fdatasync()` is the lighter variant: it flushes data and any metadata needed to read the data back (e.g., file size) but skips non-essential metadata such as access time. `sync()` [(man page)](https://man7.org/linux/man-pages/man2/sync.2.html) flushes everything system-wide.

```c
/* fsync: flush data + metadata for this file */
fsync(fd)
    → vfs_fsync() → file->f_op->fsync()
    → ext4_sync_file()
        → filemap_write_and_wait_range()  ← flush dirty pages
        → ext4_flush_completed_IO()       ← journal commit

/* fdatasync: flush data + size metadata only (no atime/mtime) */
fdatasync(fd)  /* faster than fsync when only data matters */

/* sync: flush ALL dirty data and metadata system-wide */
sync()         /* use sparingly — blocks until complete */
```

## Further reading

- [Page Cache](../mm/page-cache.md) — How dirty pages are stored in memory
- [File Operations](file-ops.md) — The file_operations vtable
- [VFS Objects](vfs-objects.md) — struct file, inode, dentry, superblock
- [Life of a file read](../mm/life-of-read.md) — The read direction
