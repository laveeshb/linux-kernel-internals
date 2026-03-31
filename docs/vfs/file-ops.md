# File Operations and the file struct

> How open(), read(), write(), and close() work in VFS

## The file_operations vtable

Every open file has a `struct file` with an `f_op` pointer to the filesystem's `file_operations`. VFS calls through this vtable for all I/O operations:

```c
/* include/linux/fs.h */
struct file_operations {
    loff_t  (*llseek)(struct file *, loff_t, int);
    ssize_t (*read)(struct file *, char __user *, size_t, loff_t *);
    ssize_t (*write)(struct file *, const char __user *, size_t, loff_t *);
    ssize_t (*read_iter)(struct kiocb *, struct iov_iter *);   /* preferred */
    ssize_t (*write_iter)(struct kiocb *, struct iov_iter *);  /* preferred */
    int     (*mmap)(struct file *, struct vm_area_struct *);
    int     (*open)(struct inode *, struct file *);
    int     (*release)(struct inode *, struct file *);  /* on last close */
    int     (*fsync)(struct file *, loff_t, loff_t, int datasync);
    long    (*unlocked_ioctl)(struct file *, unsigned int, unsigned long);
    int     (*iterate_shared)(struct file *, struct dir_context *);
    __poll_t (*poll)(struct file *, struct poll_table_struct *);
};
```

Filesystems typically only implement a subset. For fields left NULL, VFS uses generic fallbacks (e.g., `generic_file_read_iter`, `noop_llseek`).

## open(): from syscall to struct file

```c
/* Simplified: open("/path/to/file", O_RDWR) */
SYSCALL_DEFINE3(open, ...) → do_sys_open()
    1. Get a new file descriptor number
    2. do_filp_open()
         a. path_openat(): resolve pathname → path + flags
         b. do_last(): handle the final component
              - Permission check: inode_permission()
              - If O_CREAT and file doesn't exist: call i_op->create()
              - alloc_file(): allocate struct file
                   f_path = resolved path
                   f_op = inode->i_fop
                   f_mode = FMODE_READ | FMODE_WRITE
              - Call f_op->open(inode, file)
                   (ext4_file_open, for example)
    3. Install fd → struct file in process's file table
    4. Return fd
```

The `f_op->open()` call is the filesystem's chance to set up `file->private_data` (e.g., for /proc files that generate content dynamically).

## read(): the syscall path

```c
/* read(fd, buf, count) */
SYSCALL_DEFINE3(read, unsigned int, fd, char __user *, buf, size_t, count)
{
    struct fd f = fdget_pos(fd);  /* get struct file, increment f_pos lock */
    loff_t pos = file_pos_read(f.file);

    ret = vfs_read(f.file, buf, count, &pos);  /* calls f_op->read or read_iter */

    file_pos_write(f.file, pos);  /* update f_pos */
    fdput_pos(f);
    return ret;
}

/* vfs_read → calls filesystem's read_iter */
ssize_t vfs_read(struct file *file, char __user *buf, size_t count, loff_t *pos)
{
    if (file->f_op->read)
        ret = file->f_op->read(file, buf, count, pos);
    else if (file->f_op->read_iter)
        ret = new_sync_read(file, buf, count, pos);
    /* new_sync_read wraps read_iter with an iov_iter */
}
```

For regular files, `read_iter` calls `generic_file_read_iter()`, which:
1. Checks the page cache for the needed pages
2. If cached: copy pages to userspace (`copy_to_user`)
3. If not cached: trigger `readahead` → `mapping->a_ops->read_folio()` → disk I/O → wait → copy

## write(): dirty pages and writeback

```c
/* write(fd, buf, count) */
vfs_write() → file->f_op->write_iter()
    → generic_file_write_iter()
        → generic_perform_write()
            for each page that needs writing:
                1. Find or allocate page in page cache
                2. copy_from_user() → page
                3. Mark page dirty (set_page_dirty())
                4. Update inode size if needed

/* Pages are NOT written to disk immediately!
   They're marked dirty in the page cache.
   Writeback (per-BDI flusher kworker) writes them later. */
```

Data is only guaranteed on disk after:
- `fsync(fd)` or `fdatasync(fd)` — explicit flush
- The writeback daemon flushes (typically after 30 seconds or when memory pressure is high)
- The filesystem's `sync_fs()` is called

## llseek(): updating the file position

```c
loff_t vfs_llseek(struct file *file, loff_t offset, int whence)
{
    if (file->f_op->llseek)
        return file->f_op->llseek(file, offset, whence);
    return generic_file_llseek(file, offset, whence);
}

/* Generic implementation */
loff_t generic_file_llseek(struct file *file, loff_t offset, int whence)
{
    switch (whence) {
    case SEEK_SET: offset = offset; break;
    case SEEK_CUR: offset = file->f_pos + offset; break;
    case SEEK_END: offset = inode->i_size + offset; break;
    }
    /* Validate and update f_pos */
    file->f_pos = offset;
    return offset;
}
```

## mmap(): mapping the file into address space

```c
/* mmap(NULL, len, PROT_READ, MAP_SHARED, fd, offset) */
vm_mmap() → do_mmap()
    → mmap_region()
        → vma = vm_area_alloc(mm)
        → call_mmap(file, vma)    /* file->f_op->mmap() */

/* For regular files: */
int generic_file_mmap(struct file *file, struct vm_area_struct *vma)
{
    vma->vm_ops = &generic_file_vm_ops;
    /* vm_ops->fault() will handle page faults on demand */
    return 0;
}
```

The actual pages aren't faulted in until accessed. Each fault calls `filemap_fault()` which reads from the page cache (or disk).

## release(): last close

`f_op->release()` is called when the last file descriptor pointing to a `struct file` is closed. Note: `close()` doesn't immediately call `release()` — it decrements the reference count, and `release()` is called only when it reaches zero.

```c
/* close(fd) */
__close_fd() → filp_close()
    → f_op->flush()      /* called on every close */
    → fput(file)         /* decrements refcount */
        → if (--f_ref == 0): __fput(file)
            → f_op->release(inode, file)
            → dput(dentry)   /* release dentry reference */
```

`flush()` vs `release()`:
- `flush()`: called on every `close()` — some filesystems use this for error checking (NFS flushing dirty data)
- `release()`: called only when the last reference to the `struct file` is dropped (e.g., after all `dup()`'d fds are closed)

## fsync(): forcing data to disk

```c
int vfs_fsync(struct file *file, int datasync)
{
    return vfs_fsync_range(file, 0, LLONG_MAX, datasync);
}

/* Filesystems implement this to flush:
   datasync=0: flush data + metadata (full fsync)
   datasync=1: flush data + size metadata only (fdatasync) */
```

## Further reading

- [VFS Objects](vfs-objects.md) — The four VFS structures
- [Life of a write() syscall](life-of-write.md) — End-to-end write path
- [Page Cache](../mm/page-cache.md) — Where file data is buffered
- [Life of a file read](../mm/life-of-read.md) — The full read path
