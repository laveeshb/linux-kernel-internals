# Buffered I/O

> How `read()` and `write()` flow through VFS, the page cache, and back

## What buffered I/O means

By default every `read()` and `write()` on a regular file goes through the **page cache**: a region of DRAM managed by the kernel that caches file data as 4 KB pages (or larger folios since Linux 5.16). The kernel satisfies reads from these cached pages and accumulates writes in dirty pages before flushing them to storage asynchronously.

```
read()  → VFS → page cache hit?  yes → copy to userspace
                                  no  → fetch from disk → cache → copy to userspace

write() → VFS → page cache → mark dirty → return to userspace
                                 ↓  (later, by writeback)
                              storage
```

This is why `write()` returns before data hits the disk, and why repeated reads of the same file are fast.

## The syscall path into the kernel

Starting from userspace, a `read()` or `write()` on a regular file follows this chain:

```
read(fd, buf, count)
  → sys_read()                              [fs/read_write.c]
  → ksys_read()
  → vfs_read()
  → file->f_op->read_iter()                 [set at open time]
      → generic_file_read_iter()            [mm/filemap.c]   (most filesystems)

write(fd, buf, count)
  → sys_write()
  → ksys_write()
  → vfs_write()
  → file->f_op->write_iter()
      → generic_file_write_iter()           [mm/filemap.c]
```

`generic_file_read_iter` and `generic_file_write_iter` are the generic implementations used by ext4, xfs, btrfs, and most other filesystems. They work entirely against the page cache via the `address_space` abstraction.

The `kiocb` struct carries per-operation state through this chain:

```c
/* include/linux/fs.h */
struct kiocb {
    struct file       *ki_filp;    /* file being operated on */
    loff_t             ki_pos;     /* current file offset */
    void (*ki_complete)(struct kiocb *, long);  /* async completion cb */
    void              *private;
    int                ki_flags;   /* IOCB_* flags (O_DIRECT, O_SYNC, …) */
    u16                ki_ioprio;
    struct wait_page_queue *ki_waitq;  /* for async page waits */
};
```

## Page cache structure

Every inode that holds file data has an embedded `address_space` that owns its cached pages:

```c
/* include/linux/fs.h */
struct address_space {
    struct inode            *host;          /* owning inode */
    struct xarray            i_pages;       /* all cached folios, indexed by page index */
    struct rw_semaphore      invalidate_lock;
    gfp_t                    gfp_mask;      /* allocation flags for new pages */
    atomic_t                 i_mmap_writable;
    struct rb_root_cached    i_mmap;        /* all VMAs mapping this file */
    unsigned long            nrpages;       /* total pages in cache */
    unsigned long            writeback_index; /* next page to write back */
    const struct address_space_operations *a_ops;  /* readpage, writepage, … */
    unsigned long            flags;
    errseq_t                 wb_err;        /* sticky write-back error */
    spinlock_t               private_lock;
    struct list_head         private_list;
    void                    *private_data;
};
```

Before Linux 5.16 the cache was an `xarray` of `struct page *`. From 5.16 onward the unit is a **folio** — a physically contiguous group of pages represented by `struct folio`. A folio may be a single base page (order 0) or a large folio (order N, covering 2^N pages). The index into `i_pages` is the page index of the folio's first page.

```c
/* include/linux/mm_types.h (simplified) */
struct folio {
    /* Low-order bits of flags encode folio state */
    unsigned long flags;
    union {
        struct {
            /* For file-backed folios: */
            struct address_space *mapping;
            pgoff_t               index;     /* offset in file >> PAGE_SHIFT */
        };
    };
    atomic_t      _refcount;
    atomic_t      _mapcount;
    /* … followed by the actual page data … */
};
```

The `a_ops` pointer is the critical dispatch table linking the generic page cache code to filesystem-specific logic:

```c
/* include/linux/fs.h */
struct address_space_operations {
    int  (*read_folio)(struct file *, struct folio *);  /* formerly readpage */
    int  (*writepage)(struct page *, struct writeback_control *);
    void (*dirty_folio)(struct address_space *, struct folio *);
    int  (*write_begin)(struct file *, struct address_space *, loff_t,
                         unsigned len, struct page **, void **);
    int  (*write_end)(struct file *, struct address_space *, loff_t,
                       unsigned len, unsigned copied, struct page *, void *);
    int  (*writepages)(struct address_space *, struct writeback_control *);
    bool (*dirty_folio)(struct address_space *, struct folio *);
    /* … */
};
```

## Read path

`generic_file_read_iter` delegates to `filemap_read` for buffered I/O:

```c
/* mm/filemap.c */
ssize_t filemap_read(struct kiocb *iocb, struct iov_iter *iter,
                      ssize_t already_read)
{
    struct file           *filp  = iocb->ki_filp;
    struct address_space  *mapping = filp->f_mapping;
    struct inode          *inode = mapping->host;
    struct folio_batch     fbatch;
    pgoff_t index = iocb->ki_pos >> PAGE_SHIFT;
    loff_t  end;
    int     error = 0;

    do {
        /* Look up folios covering [index, last] in the xarray */
        nr = filemap_get_folios(mapping, &index, last_index, &fbatch);

        for (i = 0; i < nr; i++) {
            struct folio *folio = fbatch.folios[i];

            /* Wait until folio is up-to-date (may sleep on PG_locked) */
            error = folio_wait_uptodate(folio, iocb);
            if (error)
                goto out;

            /* Copy data from folio to user iov_iter */
            copied = copy_folio_to_iter(folio, offset, bytes, iter);
        }
    } while (iov_iter_count(iter) && iocb->ki_pos < isize && !error);

out:
    return already_read ? already_read : error;
}
```

### Cache hit

If the requested page index is present in `i_pages` and has `PG_uptodate` set, `filemap_read` copies directly from the folio to the user buffer. No I/O is issued and the call returns without sleeping.

### Cache miss

When a lookup in `i_pages` returns nothing for an index, the kernel must populate the folio:

```
filemap_read
  → filemap_get_folios() returns 0 for a range
  → filemap_create_folio()
      → __filemap_add_folio()       add locked folio to i_pages
      → filemap_read_folio()
          → a_ops->read_folio()     filesystem submits bio
              e.g. ext4_read_folio → mpage_read_folio → submit_bio
  → folio_wait_uptodate()           sleep until PG_uptodate is set
      (woken by end_page_read / folio_end_read after bio completes)
  → copy_folio_to_iter()            now safe to copy
```

The folio is held locked (`PG_locked`) while I/O is in flight. Any other reader that finds the folio already in `i_pages` but not yet uptodate will block inside `folio_wait_uptodate` on the same folio's wait queue rather than issuing a duplicate I/O.

Read-ahead runs in parallel: `page_cache_async_ra` and `ondemand_readahead` speculatively fill the cache ahead of the current read position to hide latency. The readahead window starts small and grows geometrically until it hits `ra->ra_pages`.

## Write path

`generic_file_write_iter` handles locking and sync semantics, then calls `generic_perform_write` for the actual work:

```c
/* mm/filemap.c */
ssize_t generic_perform_write(struct kiocb *iocb, struct iov_iter *i)
{
    struct file          *file    = iocb->ki_filp;
    struct address_space *mapping = file->f_mapping;
    const struct address_space_operations *a_ops = mapping->a_ops;
    loff_t pos = iocb->ki_pos;
    ssize_t written = 0;

    do {
        struct page *page;
        void        *fsdata;
        unsigned long offset = pos & (PAGE_SIZE - 1);
        unsigned long bytes  = min_t(unsigned long,
                                     PAGE_SIZE - offset,
                                     iov_iter_count(i));

        /*
         * 1. Ask the filesystem to prepare the target page.
         *    For block-mapped files this finds or allocates the page and
         *    reads partial-page data from disk if needed (read-modify-write).
         */
        status = a_ops->write_begin(file, mapping, pos, bytes,
                                     &page, &fsdata);
        if (unlikely(status < 0))
            break;

        /*
         * 2. Copy from user buffer into the page.
         */
        copied = copy_page_from_iter_atomic(page, offset, bytes, i);

        /*
         * 3. Tell the filesystem the copy is done; it marks the page dirty
         *    and unlocks it.
         */
        status = a_ops->write_end(file, mapping, pos, bytes, copied,
                                   page, fsdata);
        if (unlikely(status != copied)) { /* short write or error */ }

        pos     += copied;
        written += copied;

        balance_dirty_pages_ratelimited(mapping); /* throttle if too dirty */
    } while (iov_iter_count(i));

    return written;
}
```

`write_begin` and `write_end` are the two hooks that let each filesystem manage block allocation and journaling around the copy. For ext4 in `data=ordered` mode, `write_begin` pins journal credits and `write_end` triggers the journal commit for metadata before the page is marked dirty.

## Dirty page lifecycle

Once `write_end` marks a page dirty the kernel tracks it for writeback. The state machine for a folio is:

```
[not in cache]
      │  filemap_create_folio / filemap_fault
      ▼
[clean, uptodate]       ← disk data is authoritative
      │  copy_page_from_iter + SetPageDirty / folio_mark_dirty
      ▼
[dirty]                 ← page has newer data than disk
      │  wakeup_flusher_threads / writeback_inodes_wb
      ▼
[writeback]             ← bio submitted, PG_writeback set
      │  end_page_writeback / folio_end_writeback (bio completion)
      ▼
[clean, uptodate]       ← back to steady state
```

### How a page becomes dirty

```c
/* mm/page-writeback.c */
bool __folio_mark_dirty(struct folio *folio, struct address_space *mapping,
                         int warn)
{
    /*
     * For most file systems (no private buffer heads):
     * delegates to __set_page_dirty_nobuffers
     */
    if (mapping->a_ops->dirty_folio)
        return mapping->a_ops->dirty_folio(mapping, folio);

    return filemap_dirty_folio(mapping, folio);
}

/* mm/filemap.c */
bool filemap_dirty_folio(struct address_space *mapping, struct folio *folio)
{
    folio_memcg_lock(folio);
    if (folio_test_set_dirty(folio)) {   /* atomic test-and-set PG_dirty */
        folio_memcg_unlock(folio);
        return false;   /* already dirty */
    }

    /* Add to the per-BDI dirty list and account dirty memory */
    __folio_mark_dirty(folio, mapping, 1);
    folio_memcg_unlock(folio);

    __mark_inode_dirty(mapping->host, I_DIRTY_PAGES);
    return true;
}
```

The kernel enforces two dirty-throttle limits (expressed as percentages of memory):

- `dirty_background_ratio` / `dirty_background_bytes` — background writeback starts
- `dirty_ratio` / `dirty_bytes` — foreground throttling; `balance_dirty_pages_ratelimited` blocks the writing process

`/proc/sys/vm/dirty_writeback_centisecs` controls how often `wb_workfn` (the per-BDI writeback worker) wakes up to flush pages that have been dirty longer than `dirty_expire_centisecs`.

### Writeback

```c
/* fs/fs-writeback.c */
static long writeback_chunk_size(struct bdi_writeback *wb,
                                  struct wb_writeback_work *work)
{ /* … */ }

static long writeback_sb_inodes(struct super_block *sb,
                                 struct bdi_writeback *wb,
                                 struct wb_writeback_work *work)
{
    while (!list_empty(&wb->b_io)) {
        struct inode *inode = wb_inode(wb->b_io.prev);
        __writeback_single_inode(inode, &wbc);
        /* → do_writepages → a_ops->writepages or generic_writepages
             → write_cache_pages → folio_lock + a_ops->writepage per folio
               → ext4_writepage / iomap_writepage → submit_bio
               → folio_start_writeback(): sets PG_writeback */
    }
}
```

After a bio completes, the block layer calls the end I/O handler which calls `folio_end_writeback`, clearing `PG_writeback` and waking any waiters.

## Buffer heads

Before folios and `iomap`, block-mapped files tracked per-block I/O state with `struct buffer_head`:

```c
/* include/linux/buffer_head.h */
struct buffer_head {
    unsigned long      b_state;     /* BH_Uptodate, BH_Dirty, BH_Lock, … */
    struct buffer_head *b_this_page; /* circular list of page's bh */
    union {
        struct page    *b_page;      /* page this bh belongs to */
        struct folio   *b_folio;
    };
    sector_t           b_blocknr;   /* block number on disk */
    size_t             b_size;      /* block size */
    char              *b_data;      /* pointer within page */
    struct block_device *b_bdev;
    bh_end_io_t       *b_end_io;    /* I/O completion */
    void              *b_private;
    /* … */
};
```

Each page in a block-mapped file had a ring of buffer heads, one per filesystem block. For a 4 KB page with 1 KB blocks that is four buffer heads tracking four individual sectors. This works but is expensive: each buffer head is ~60 bytes allocated from slab, there is locking overhead for the ring, and the per-block granularity complicates folio-size increases.

The modern replacement is **iomap** (`fs/iomap/`). Instead of per-block metadata attached to each page, iomap maps a range of file bytes to a range of physical blocks in one call. This eliminates buffer heads for filesystems that have migrated (ext4, xfs, btrfs, f2fs). Buffer heads remain for older codepaths, FAT, and some block devices.

```c
/* include/linux/iomap.h */
struct iomap {
    u64            addr;    /* disk offset in bytes, IOMAP_NULL_ADDR if hole */
    loff_t         offset;  /* file offset */
    u64            length;  /* length of this mapping */
    u16            type;    /* IOMAP_HOLE, IOMAP_MAPPED, IOMAP_UNWRITTEN, … */
    u16            flags;
    struct block_device *bdev;
    struct dax_device   *dax_dev;
};
```

With iomap, `a_ops->write_begin` is implemented by `iomap_write_begin`, which calls the filesystem's `iomap_ops->iomap_begin` to get a single `struct iomap` covering the write range, then uses that to set up the folio — no buffer heads involved.

## O_SYNC and fsync

`write()` with buffered I/O returns as soon as data lands in the page cache. To get durability guarantees:

```c
/* O_SYNC: every write blocks until data+metadata reach stable storage */
int fd = open("file", O_WRONLY | O_SYNC);

/* O_DSYNC: every write blocks until data reaches stable storage (no metadata) */
int fd = open("file", O_WRONLY | O_DSYNC);

/* Manual fsync: flush all dirty pages + metadata for this file */
write(fd, buf, len);
fsync(fd);         /* → vfs_fsync → a_ops->writepages + inode log commit */

/* fdatasync: flush dirty pages only (skip metadata if size unchanged) */
fdatasync(fd);
```

When `O_SYNC` is set, `generic_file_write_iter` calls `generic_write_sync` after `generic_perform_write`, which calls `vfs_fsync_range` to force writeback and wait for it before returning to userspace.

## Key source files

| File | Role |
|------|------|
| `mm/filemap.c` | `filemap_read`, `generic_perform_write`, `filemap_dirty_folio`, page fault read |
| `mm/page-writeback.c` | dirty accounting, `balance_dirty_pages`, throttling |
| `fs/fs-writeback.c` | writeback worker, `writeback_sb_inodes`, `__writeback_single_inode` |
| `include/linux/fs.h` | `struct address_space`, `struct kiocb`, `address_space_operations` |
| `include/linux/pagemap.h` | page cache lookup helpers, folio state accessors |
| `include/linux/buffer_head.h` | `struct buffer_head`, BH_* state bits |
| `include/linux/iomap.h` | `struct iomap`, iomap operation tables |
| `fs/iomap/buffered-io.c` | iomap `write_begin`/`write_end`, iomap writepage |
| `mm/readahead.c` | `ondemand_readahead`, readahead window management |

## Further reading

- [Async I/O evolution](async-io.md) — POSIX AIO and io_uring, including how io_uring handles buffered I/O asynchronously
- [Direct I/O](direct-io.md) — bypassing the page cache with O_DIRECT
- [Page cache lifecycle](../mm/page-cache.md) — eviction, LRU lists, memory pressure
- `mm/filemap.c` — core buffered read and write implementation
- `include/linux/fs.h` — `address_space`, `kiocb`, and `address_space_operations` definitions
