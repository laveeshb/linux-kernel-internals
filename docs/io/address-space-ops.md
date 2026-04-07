# address_space_operations

> The dispatch table that connects the generic page cache to filesystem-specific I/O logic

## What is address_space_operations?

Every inode that can hold file data has a `struct address_space` embedded in it. The `a_ops` pointer on that `address_space` is what lets the page cache call filesystem-specific code to read and write pages. Without `a_ops`, the kernel has no way to populate a page cache miss, flush dirty pages back to disk, or handle cache invalidation during truncation.

```
Page cache (mm/filemap.c)
        │
        │  cache miss → a_ops->read_folio()
        │  dirty flush → a_ops->writepages()
        │  write setup → a_ops->write_begin() / write_end()
        │  invalidate  → a_ops->invalidate_folio()
        ▼
Filesystem (ext4, xfs, btrfs, …)
        │
        ▼
Block layer → storage
```

The `address_space` also owns the `xarray` of cached folios (`i_pages`) and appears as the target of `mmap` mappings. The `a_ops` table is the single seam where generic VM code hands off to per-filesystem logic.

```c
/* include/linux/fs.h (simplified) */
struct address_space {
    struct inode            *host;           /* owning inode */
    struct xarray            i_pages;        /* cached folios, indexed by page index */
    struct rw_semaphore      invalidate_lock;
    gfp_t                    gfp_mask;
    atomic_t                 i_mmap_writable;
    struct rb_root_cached    i_mmap;         /* VMAs mapping this file */
    unsigned long            nrpages;
    unsigned long            writeback_index;
    const struct address_space_operations *a_ops;
    unsigned long            flags;
    errseq_t                 wb_err;
    spinlock_t               private_lock;
    struct list_head         private_list;
    void                    *private_data;
};
```

The `a_ops` pointer is set at inode creation time by the filesystem — for regular files in ext4, `inode->i_mapping->a_ops = &ext4_aops` happens in `ext4_iget()`.

## struct address_space_operations

The full struct definition as it appears in `include/linux/fs.h`:

```c
struct address_space_operations {
    int  (*read_folio)(struct file *, struct folio *);
    int  (*writepage)(struct page *, struct writeback_control *);
    void (*writepages)(struct address_space *, struct writeback_control *);
    bool (*dirty_folio)(struct address_space *, struct folio *);
    void (*readahead)(struct readahead_control *);
    int  (*write_begin)(struct file *, struct address_space *mapping,
                         loff_t pos, unsigned len,
                         struct folio **, void **fsdata);
    int  (*write_end)(struct file *, struct address_space *mapping,
                       loff_t pos, unsigned len, unsigned copied,
                       struct folio *, void *fsdata);
    sector_t (*bmap)(struct address_space *, sector_t);
    void (*invalidate_folio)(struct folio *, size_t offset, size_t len);
    bool (*release_folio)(struct folio *, gfp_t);
    void (*free_folio)(struct folio *);
    ssize_t (*direct_IO)(struct kiocb *, struct iov_iter *iter);
    int  (*migrate_folio)(struct address_space *, struct folio *dst,
                           struct folio *src, enum migrate_mode);
    int  (*launder_folio)(struct folio *);
    bool (*is_partially_uptodate)(struct folio *, size_t from, size_t count);
    void (*is_dirty_writeback)(struct folio *, bool *dirty, bool *wb);
    int  (*swap_activate)(struct swap_info_struct *sis, struct file *file,
                           sector_t *span);
    void (*swap_deactivate)(struct file *file);
    int  (*swap_rw)(struct kiocb *iocb, struct iov_iter *iter);
};
```

The `write_begin` and `write_end` signatures shown above reflect the folio-based interface introduced in Linux 6.12. Before 6.12 the `struct page **` and `struct page *` variants were used; many older references and out-of-tree drivers still show the page-based signatures.

Not every filesystem implements every operation. The kernel checks for `NULL` before calling most hooks. The mandatory minimum for a read-only filesystem is `read_folio`; a writable filesystem also needs `write_begin`, `write_end`, `dirty_folio`, and `writepages` (or `writepage`).

---

## read_folio: reading a single folio

```c
int (*read_folio)(struct file *file, struct folio *folio);
```

**Called when:** the page cache does not have an uptodate copy of a page and a reader needs it. This is the cache-miss path in `filemap_read` and the fault handler for file-backed `mmap`.

**Contract:**
- The folio arrives locked (`folio_test_locked()` is true) and not uptodate.
- The implementation must submit I/O to fill the folio.
- If I/O is submitted asynchronously, the function returns `0` immediately. The folio stays locked until the bio completion handler calls `folio_end_read()`, which sets `PG_uptodate` and releases the lock, waking any sleepers.
- On error the implementation must call `folio_unlock()` and return a negative errno.
- The implementation must **not** call `folio_unlock()` on the success path — the caller blocks on the lock and expects the folio to be unlocked only after data is ready.

**Call chain (ext4):**

```
filemap_read_folio()                        [mm/filemap.c]
  → a_ops->read_folio()
      → ext4_read_folio()                   [fs/ext4/inode.c]
          → mpage_read_folio()              [fs/mpage.c]
              → do_mpage_readpage()
                  → map_blocks via ext4_get_block()
                  → bio_add_folio()
                  → submit_bio()
  ← folio stays locked; caller blocks on folio_wait_locked()
  ← bio completion → folio_end_read() → PG_uptodate set, lock released
```

`mpage_read_folio` is a generic helper in `fs/mpage.c` that works for any block-mapped filesystem. It translates a folio's file offset to a block number using the filesystem's `get_block` callback, builds a bio, and submits it. Filesystems that use iomap (xfs, btrfs) have their own thin wrappers that call into `iomap_read_folio()` instead.

---

## readahead: bulk prefetch

```c
void (*readahead)(struct readahead_control *ractl);
```

**Called when:** the readahead machinery (`mm/readahead.c`) speculatively wants to fill the cache ahead of the current read position, or when `MADV_SEQUENTIAL` / `mmap` faults trigger a readahead window.

The caller has already allocated and locked a batch of folios and added them to `i_pages`. The `readahead_control` struct describes the range:

```c
/* include/linux/pagemap.h */
struct readahead_control {
    struct file            *file;
    struct address_space   *mapping;
    struct file_ra_state   *ra;
    pgoff_t                _index;   /* first page index in the window */
    unsigned int           _nr_pages; /* number of pages requested */
    unsigned int           _batch_count;
    bool                   _workingset;
    unsigned long          _pflags;
};
```

**Contract:**
- The implementation should submit I/O for as many folios in the window as possible, ideally coalescing them into large bios rather than one bio per page.
- Any folio the implementation decides not to read must be unlocked via `folio_unlock()`.
- Return is void; errors are recorded per-folio via `folio_set_error()` in the completion handler.

**Generic implementation — `mpage_readahead`** (`fs/mpage.c`):

```c
void mpage_readahead(struct readahead_control *ractl, get_block_t get_block)
{
    struct folio *folio;
    struct mpage_readpage_args args = { .get_block = get_block };

    while ((folio = readahead_folio(ractl)) != NULL) {
        args.folio = folio;
        args.nr_pages = readahead_count(ractl);
        args.bio = do_mpage_readpage(&args);
    }
    if (args.bio)
        mpage_bio_submit(args.bio);
}
```

`do_mpage_readpage` accumulates physically contiguous blocks into one bio. When a block is not contiguous with the previous one it submits the current bio and starts a new one. This means a single `readahead` call on a heavily fragmented file may issue many bios, but a well-allocated file issues just one.

**ext4** delegates directly: `ext4_readahead()` calls `mpage_readahead()` with `ext4_get_block` as the block-mapping function.

**xfs** uses `iomap_readahead()`, which calls `xfs_read_iomap_begin()` to obtain extent mappings and then builds bios from them without touching per-page block numbers at all.

---

## writepages: bulk writeback

```c
void (*writepages)(struct address_space *mapping,
                   struct writeback_control *wbc);
```

**Called by:** the writeback machinery (`fs/fs-writeback.c` → `do_writepages()`) to flush dirty folios. Also called directly by `sync_file_range()` and `msync()`.

`struct writeback_control` communicates the writeback request parameters:

```c
/* include/linux/writeback.h (key fields) */
struct writeback_control {
    long            nr_to_write;       /* how many pages to write; decremented */
    long            pages_skipped;
    loff_t          range_start;       /* byte range (inclusive) */
    loff_t          range_end;
    enum writeback_sync_modes sync_mode; /* WB_SYNC_NONE or WB_SYNC_ALL */
    unsigned        for_kupdate:1;     /* periodic background writeback */
    unsigned        for_background:1;  /* dirty ratio exceeded */
    unsigned        tagged_writepages:1;
    unsigned        no_cgroup_owner:1;
};
```

`WB_SYNC_ALL` means the caller will wait for I/O to complete (fsync path). `WB_SYNC_NONE` means best-effort; the writeback worker can skip locked folios.

**Generic helper — `write_cache_pages`** (`mm/page-writeback.c`):

Most filesystems implement `writepages` by calling `write_cache_pages`, which iterates the dirty folios in `i_pages`, locks each one, and calls a per-folio callback:

```c
/* mm/page-writeback.c (simplified) */
int write_cache_pages(struct address_space *mapping,
                      struct writeback_control *wbc,
                      writepage_t writepage, void *data)
{
    struct folio_batch fbatch;
    pgoff_t index = wbc->range_start >> PAGE_SHIFT;
    pgoff_t end   = wbc->range_end   >> PAGE_SHIFT;

    while (index <= end) {
        nr = filemap_get_folios_tag(mapping, &index, end,
                                    PAGECACHE_TAG_DIRTY, &fbatch);
        for (i = 0; i < nr; i++) {
            struct folio *folio = fbatch.folios[i];
            folio_lock(folio);
            writepage(folio, wbc, data);    /* filesystem callback */
            wbc->nr_to_write -= folio_nr_pages(folio);
        }
        folio_batch_release(&fbatch);
        if (wbc->nr_to_write <= 0 && wbc->sync_mode == WB_SYNC_NONE)
            break;
    }
    return 0;
}
```

The `PAGECACHE_TAG_DIRTY` tag is maintained by the xarray so that `filemap_get_folios_tag` does not have to scan the entire page cache.

**iomap path — `iomap_writepages`** (`fs/iomap/buffered-io.c`):

Filesystems using iomap register `iomap_writepages` directly. It calls `iomap_writepage_map()` for each dirty folio, which calls the filesystem's `iomap_ops->iomap_begin()` to get the block mapping for the range, then coalesces adjacent mapped extents into large bios before submission. This avoids the one-folio-at-a-time granularity of the `write_cache_pages` pattern.

---

## write_begin and write_end: the write protocol

This is the critical two-phase protocol that surrounds every buffered write in `generic_perform_write`:

```c
/* mm/filemap.c */
do {
    status = a_ops->write_begin(file, mapping, pos, bytes,
                                &folio, &fsdata);
    copied = copy_page_from_iter_atomic(&folio->page, offset, bytes, i);
    status = a_ops->write_end(file, mapping, pos, bytes, copied,
                               folio, fsdata);
    pos    += copied;
} while (iov_iter_count(i));
```

The split exists so that user data can be copied directly into the page cache page without any bounce buffer. The page is locked across the copy to prevent concurrent access from another writer or from the VM reclaim path.

### write_begin

```c
int (*write_begin)(struct file *file, struct address_space *mapping,
                   loff_t pos, unsigned len,
                   struct folio **foliop, void **fsdata);
```

**Responsibilities:**
1. Find or allocate a folio in `i_pages` covering `pos`.
2. Lock the folio.
3. If the write does not cover the full folio (partial write): read existing data from disk first. This is the read-modify-write path — the folio must be fully uptodate before the caller overwrites part of it, or the non-written portion will contain garbage.
4. For block-mapped filesystems: ensure disk blocks are allocated for the range. An unallocated region becomes a hole after write_begin returns; the blocks must exist before write_end marks the folio dirty, or writeback will find nothing to write.
5. Store any per-write filesystem state (journal handles, private data) in `*fsdata`.
6. Return a locked, prepared folio in `*foliop`.

**ext4 implementation — `ext4_write_begin`** (`fs/ext4/inode.c`):

```c
static int ext4_write_begin(struct file *file,
                             struct address_space *mapping,
                             loff_t pos, unsigned len,
                             struct folio **foliop, void **fsdata)
{
    struct inode *inode = mapping->host;
    handle_t *handle;
    int ret;

    /*
     * Reserve journal credits. The number of credits depends on whether
     * we need to allocate blocks and how many indirect blocks ext4 may
     * have to modify (for non-extent inodes).
     */
    handle = ext4_journal_start(inode, EXT4_HT_WRITE_PAGE,
                                 ext4_writepage_trans_blocks(inode));
    if (IS_ERR(handle))
        return PTR_ERR(handle);

    *fsdata = handle;

    /* Grab (or allocate) the folio and lock it */
    ret = block_write_begin(mapping, pos, len, foliop,
                             ext4_get_block);
    if (ret < 0) {
        ext4_journal_stop(handle);
        return ret;
    }

    return 0;
}
```

`block_write_begin` (in `fs/buffer.c`) handles the generic part: folio lookup or allocation, and the read-modify-write for partial pages via `__block_write_begin_int`.

For encrypted files, `ext4_write_begin` also sets up the encryption context so the copy in `copy_page_from_iter_atomic` lands in the correct ciphertext form.

### write_end

```c
int (*write_end)(struct file *file, struct address_space *mapping,
                  loff_t pos, unsigned len, unsigned copied,
                  struct folio *folio, void *fsdata);
```

**Responsibilities:**
1. If `copied < len` (the copy was short, e.g., due to a fault): handle the partial update. May need to zero the un-written portion.
2. Mark the folio dirty (`folio_mark_dirty()`).
3. Unlock the folio (`folio_unlock()`).
4. If the write extended the file (`pos + copied > i_size`): update `i_size` and call `mark_inode_dirty()`.
5. Release any filesystem state from `fsdata` (journal handles, etc.).
6. Return the number of bytes actually committed (usually `copied`; a short return causes `generic_perform_write` to retry).

**ext4 implementation — `ext4_write_end`** (`fs/ext4/inode.c`):

```c
static int ext4_write_end(struct file *file,
                           struct address_space *mapping,
                           loff_t pos, unsigned len, unsigned copied,
                           struct folio *folio, void *fsdata)
{
    handle_t *handle = fsdata;
    struct inode *inode = mapping->host;
    int ret;

    /*
     * block_write_end marks the folio dirty and unlocks it.
     * It also handles the short-copy case.
     */
    copied = block_write_end(file, mapping, pos, len, copied,
                              folio, fsdata);

    /*
     * If i_size changed, write the updated inode to the journal.
     * This does NOT commit the transaction; the journal still needs
     * a checkpoint or explicit fsync to reach stable storage.
     */
    if (pos + copied > inode->i_size) {
        i_size_write(inode, pos + copied);
        mark_inode_dirty(inode);
    }

    ext4_journal_stop(handle);

    return copied;
}
```

The call to `ext4_journal_stop` decrements the journal credit count for this handle. If the handle's credit count reaches zero and the transaction hasn't been committed, `ext4_journal_stop` may trigger a partial commit. Under `data=ordered` mode, the actual data pages are written to disk before the journal commit that records the metadata update — this ordering is enforced in `ext4_writepages` via `jbd2_inode_add_write_transaction`.

### Why two phases?

Without the split, the kernel would need to either:
- Copy user data into a temporary buffer, then copy from buffer into the page (two copies, wasted memory bandwidth), or
- Hold the inode mutex across the `copy_from_user`, blocking all other writers for the duration of potentially slow user page faults.

With the split, `write_begin` acquires only what it needs (the target folio lock and journal credits), and the copy happens with only that folio locked. If the copy faults on a user page, only this folio is stalled — not the entire file.

---

## dirty_folio: marking folios dirty

```c
bool (*dirty_folio)(struct address_space *mapping, struct folio *folio);
```

**Called by:** `folio_mark_dirty()` in `mm/page-writeback.c`, which is the public API for marking a folio as containing modified data. `write_end` implementations call this after the copy.

**Returns:** `true` if the folio was newly dirtied, `false` if it was already dirty.

**Default — `filemap_dirty_folio`** (`mm/filemap.c`):

```c
bool filemap_dirty_folio(struct address_space *mapping, struct folio *folio)
{
    folio_memcg_lock(folio);
    if (folio_test_set_dirty(folio)) {   /* atomic test-and-set PG_dirty */
        folio_memcg_unlock(folio);
        return false;
    }
    folio_memcg_unlock(folio);

    __lruvec_stat_mod_folio(folio, NR_FILE_DIRTY, folio_nr_pages(folio));
    __zone_stat_mod_folio(folio, NR_ZONE_WRITE_PENDING,
                          folio_nr_pages(folio));
    __mark_inode_dirty(mapping->host, I_DIRTY_PAGES);
    return true;
}
```

The dirty accounting (`NR_FILE_DIRTY`) feeds into the `dirty_ratio` / `dirty_background_ratio` throttle in `balance_dirty_pages_ratelimited`.

**ext4 override — `ext4_dirty_folio`** (journalled data mode):

For `data=journal` mode, ext4 registers `ext4_journalled_dirty_folio` instead of `filemap_dirty_folio`. It calls `__set_page_dirty_nobuffers` (which skips the buffer_head dirty marking) and then sets a journal-specific dirty flag so that the journalling layer knows to write the data through the journal rather than directly.

---

## invalidate_folio: cache invalidation

```c
void (*invalidate_folio)(struct folio *folio, size_t offset, size_t len);
```

**Called when:** the kernel needs to discard cached data. Primary callers:
- `truncate_inode_pages_range()` — file truncation or `ftruncate()`
- `punch_hole` via `fallocate(FALLOC_FL_PUNCH_HOLE)`
- `invalidate_inode_pages2_range()` — O_DIRECT writes need to invalidate any buffered copies of the same range

The `offset` and `len` parameters allow partial-folio invalidation (e.g., for a large folio that is only partially within the truncated range). When `offset == 0 && len == folio_size(folio)`, the entire folio is being discarded.

**Contract:**
- Must release any filesystem-private state attached to the folio (buffer heads, journal handles).
- Must call `folio_invalidate()` (or the lower-level `__folio_invalidate()`) to clear `PG_uptodate` and release buffer heads.

**ext4 — `ext4_invalidate_folio`** (`fs/ext4/inode.c`):

```c
void ext4_invalidate_folio(struct folio *folio, size_t offset, size_t len)
{
    /*
     * If this folio has journal metadata attached (jbd2 has reserved
     * this folio as part of a transaction), we cannot free it until
     * the transaction commits. jbd2_journal_invalidate_folio handles
     * this by checking whether the folio is part of a checkpoint
     * transaction and, if so, blocking until the commit completes.
     */
    if (folio_buffers(folio))
        jbd2_journal_invalidate_folio(journal, folio, offset, len);
    else
        folio_invalidate(folio, offset, len);
}
```

If jbd2 has an uncommitted reference to the folio (it is part of a running or checkpointing transaction), `jbd2_journal_invalidate_folio` will wait for the transaction to commit before allowing the folio to be freed. This prevents the journal from referencing freed memory.

---

## release_folio: can we drop this folio?

```c
bool (*release_folio)(struct folio *folio, gfp_t gfp_flags);
```

**Called by:** the page reclaim path (`try_to_free_buffers()` in `mm/buffer.c`), before the VM attempts to free a folio under memory pressure.

**Returns:** `true` to allow the folio to be freed; `false` to prevent eviction.

A filesystem returns `false` when it has private state attached to the folio that has not yet been flushed. The most common reason is that the folio has buffer heads with journal references — freeing the folio now would leave dangling pointers in the journal.

```c
/* fs/ext4/inode.c */
bool ext4_release_folio(struct folio *folio, gfp_t wait)
{
    /*
     * Do not release if this folio is still under journal writeback
     * (jbd2 has not yet written the commit record for a transaction
     * that modified this folio).
     */
    if (folio_test_writeback(folio))
        return false;

    return jbd2_journal_try_to_free_buffers(journal, folio);
}
```

`jbd2_journal_try_to_free_buffers` attempts to detach buffer heads from the folio. If any buffer head is part of a transaction that has not yet been checkpointed, it returns false, and the VM will leave the folio alone and try a different victim.

**iomap equivalent — `iomap_release_folio`** (`fs/iomap/buffered-io.c`): Used by xfs and other iomap filesystems. It checks whether the folio has an `iomap_page` struct (tracking per-block uptodate bits for sub-folio granularity) and frees it if all blocks are uptodate.

---

## free_folio: final cleanup

```c
void (*free_folio)(struct folio *folio);
```

**Called after:** the folio has been removed from the page cache and its reference count has dropped to zero. This is the final cleanup hook — the folio is about to be returned to the page allocator.

Unlike `release_folio`, `free_folio` cannot veto the operation. It is used for unconditional cleanup of private state. Not many filesystems implement this; it is mainly used by filesystems that attach per-folio accounting structures that must not leak.

---

## direct_IO: O_DIRECT path

```c
ssize_t (*direct_IO)(struct kiocb *iocb, struct iov_iter *iter);
```

**Called by:** `generic_file_direct_write()` and `generic_file_read_iter()` when `iocb->ki_flags & IOCB_DIRECT` is set (the file was opened with `O_DIRECT`).

O_DIRECT bypasses the page cache entirely: user buffers are DMA'd to/from disk directly. The filesystem must translate file offsets to block addresses and submit bios without touching `i_pages`.

**Modern path (iomap filesystems):**

Filesystems that have migrated to iomap register `noop_direct_IO` in `a_ops->direct_IO` and instead handle O_DIRECT via a separate `->read_iter` / `->write_iter` implementation that calls `iomap_dio_rw()`:

```c
/* fs/xfs/file.c */
static ssize_t xfs_file_dio_write(struct kiocb *iocb, struct iov_iter *from)
{
    return iomap_dio_rw(iocb, from, &xfs_direct_write_iomap_ops,
                        &xfs_dio_write_ops, 0, NULL, 0);
}
```

`iomap_dio_rw` (in `fs/iomap/direct-io.c`) handles alignment validation, user page pinning, bio construction, and completion — it calls the filesystem's `iomap_ops->iomap_begin()` to get the block mapping, then submits bios directly to the block layer.

**Legacy path — `__blockdev_direct_IO`** (`fs/direct-io.c`):

Older block-mapped filesystems use the legacy helper:

```c
/* fs/ext2/inode.c */
static ssize_t ext2_direct_IO(struct kiocb *iocb, struct iov_iter *iter)
{
    return __blockdev_direct_IO(iocb, inode, inode->i_sb->s_bdev,
                                iter, ext2_get_block, NULL, NULL,
                                DIO_LOCKING | DIO_SKIP_HOLES);
}
```

`__blockdev_direct_IO` calls `ext2_get_block` per aligned block range to get block numbers, builds bios, submits them, and optionally waits (for synchronous `kiocb`).

**Alignment requirements:**

O_DIRECT imposes strict alignment: both the file offset and the user buffer must be aligned to the logical block size of the device (typically 512 bytes or 4096 bytes). If alignment is violated, `generic_file_direct_write` returns `-EINVAL` before calling into `direct_IO`.

---

## bmap: block mapping

```c
sector_t (*bmap)(struct address_space *mapping, sector_t block);
```

**Returns:** the disk block number (in 512-byte sectors) for the given file block number (`block` is a page-sized block offset, not a byte offset).

**Used by:**
- `hdparm --fibmap` / `FIBMAP` ioctl — userspace tools that query physical block locations
- `filefrag` — file fragmentation reporting
- Some swap activation paths

`bmap` is not used for normal read or write I/O — those paths use `read_folio`/`writepages` or iomap's extent mapping. It is a legacy interface that predates iomap.

**Implementation:**

```c
/* fs/ext4/inode.c */
static sector_t ext4_bmap(struct address_space *mapping, sector_t block)
{
    struct inode *inode = mapping->host;

    /*
     * Flush any dirty metadata so that the block map is stable before
     * we query it. Without this, a newly allocated block might not yet
     * have been written to the on-disk inode.
     */
    if (mapping_tagged(mapping, PAGECACHE_TAG_DIRTY))
        filemap_write_and_wait(mapping);

    return generic_block_bmap(mapping, block, ext4_get_block);
}
```

Filesystems that use extents (rather than indirect blocks) return `0` for unallocated regions. Holes in a sparse file correctly return `0`.

---

## migrate_folio: NUMA and page migration

```c
int (*migrate_folio)(struct address_space *mapping,
                     struct folio *dst, struct folio *src,
                     enum migrate_mode mode);
```

**Called by:** the page migration machinery (`mm/migrate.c`) when the kernel wants to move a folio to a different NUMA node (for NUMA balancing), to a different memory tier (CXL memory, PMEM), or during memory compaction.

The implementation must:
1. Copy the folio's content from `src` to `dst`.
2. Transfer any filesystem-private state (buffer heads, iomap_page structs) from `src` to `dst`.
3. Re-add `dst` to `i_pages` at the same index, replacing `src`.

**Generic implementations:**

- `buffer_migrate_folio()` — for buffer-head filesystems (ext4, ext2): copies buffer heads from src to dst in addition to the page data.
- `filemap_migrate_folio()` — for iomap filesystems (xfs): copies only the folio data; no per-folio private state to transfer.

Migration can fail (returns `-EAGAIN`) if the folio is currently under writeback or has an elevated reference count from a DMA mapping.

---

## launder_folio: flush before migration

```c
int (*launder_folio)(struct folio *folio);
```

**Called by:** the page migration path when it encounters a folio with `PG_dirty` or `PG_writeback` set. Before the folio can be migrated, its dirty data must be flushed to disk.

The implementation typically calls `folio_wait_writeback(folio)` to block until any in-progress writeback completes, then submits a synchronous write if the folio is still dirty.

This hook is not widely implemented; most filesystems either rely on the migration path to skip dirty folios (`MIGRATEPAGE_SUCCESS` vs. `-EBUSY`) or use the generic `folio_wait_writeback` path.

---

## is_partially_uptodate: sub-folio read check

```c
bool (*is_partially_uptodate)(struct folio *folio,
                               size_t from, size_t count);
```

**Called by:** `filemap_read` before issuing a read I/O, to determine whether the requested byte range is already uptodate within a folio that is not fully uptodate. This allows the kernel to avoid a disk read when only part of a large folio is needed.

This hook is only meaningful when sub-folio granularity tracking exists. For block-mapped filesystems with buffer heads, each buffer head has its own `BH_Uptodate` bit. `block_is_partially_uptodate` checks whether all buffer heads overlapping `[from, from+count)` have `BH_Uptodate` set:

```c
/* fs/buffer.c */
bool block_is_partially_uptodate(struct folio *folio,
                                  size_t from, size_t count)
{
    struct buffer_head *bh, *head;
    unsigned block_start, block_end, blocksize;
    bool ret = true;

    head = folio_buffers(folio);
    if (!head)
        return false;

    blocksize = head->b_size;
    for (bh = head, block_start = 0; bh != head || !block_start;
         bh = bh->b_this_page, block_start = block_end) {
        block_end = block_start + blocksize;
        if (block_end <= from || block_start >= from + count)
            continue;
        if (!buffer_uptodate(bh)) {
            ret = false;
            break;
        }
    }
    return ret;
}
```

For iomap filesystems, `iomap_is_partially_uptodate` checks the `iomap_page` bitmap that tracks uptodate status at block granularity within a large folio.

---

## is_dirty_writeback: reclaim state query

```c
void (*is_dirty_writeback)(struct folio *folio,
                            bool *dirty, bool *wb);
```

**Called by:** the page reclaim path to determine the dirty/writeback state of a folio for memory pressure accounting. The VM uses this to decide whether to wait for writeback or skip a folio.

This hook exists because the standard `PG_dirty` and `PG_writeback` flags may not capture the full picture for journalling filesystems — a folio might be clean in the page cache sense but still have uncommitted journal data that prevents it from being reclaimed. The hook lets filesystems expose a more conservative view of dirty state.

---

## swap_activate, swap_deactivate, swap_rw: swap on files

```c
int  (*swap_activate)(struct swap_info_struct *sis,
                       struct file *file, sector_t *span);
void (*swap_deactivate)(struct file *file);
int  (*swap_rw)(struct kiocb *iocb, struct iov_iter *iter);
```

These three hooks allow a regular file to be used as a swap device (`swapon(2)` on a file rather than a block device).

**`swap_activate`:** Called when the file is activated as a swap file. The filesystem must validate that the file is suitable (fully allocated, no holes, not compressed) and populate `sis` with the block mapping. Returns the number of usable pages in `*span`.

**`swap_deactivate`:** Called on `swapoff(2)`. The filesystem releases any resources it allocated during activation.

**`swap_rw`:** Called to perform the actual swap I/O. For iomap filesystems, this is `iomap_swapfile_activate` + direct I/O via `iomap_dio_rw`. For ext4, `ext4_iomap_swap_activate` uses the iomap path to ensure the file's extents are contiguous enough for swap use.

These hooks are typically only implemented by local filesystems that support swap files (ext4, xfs, f2fs, tmpfs). Network filesystems and FUSE do not implement them.

---

## How filesystems register a_ops

The `a_ops` pointer is set to a statically defined `const struct address_space_operations` at inode initialization time. This is `const` because the dispatch table must not change for the lifetime of the inode.

### ext4

```c
/* fs/ext4/inode.c */
static const struct address_space_operations ext4_aops = {
    .read_folio             = ext4_read_folio,
    .readahead              = ext4_readahead,
    .writepages             = ext4_writepages,
    .write_begin            = ext4_write_begin,
    .write_end              = ext4_write_end,
    .dirty_folio            = ext4_dirty_folio,
    .bmap                   = ext4_bmap,
    .invalidate_folio       = ext4_invalidate_folio,
    .release_folio          = ext4_release_folio,
    .direct_IO              = noop_direct_IO,   /* iomap DIO via file->f_op */
    .migrate_folio          = buffer_migrate_folio,
    .is_partially_uptodate  = block_is_partially_uptodate,
    .error_remove_folio     = generic_error_remove_folio,
    .swap_activate          = ext4_iomap_swap_activate,
};
```

ext4 has multiple `a_ops` variants: `ext4_aops` for the normal case, `ext4_journalled_aops` for `data=journal` mode (where data pages go through the journal), and `ext4_da_aops` for delayed allocation (the default since Linux 2.6.23). The correct set is chosen in `ext4_set_aops()` based on the inode's flags and the mount options.

```c
/* fs/ext4/inode.c */
void ext4_set_aops(struct inode *inode)
{
    switch (ext4_inode_journal_mode(inode)) {
    case EXT4_INODE_ORDERED_DATA_MODE:
    case EXT4_INODE_WRITEBACK_DATA_MODE:
        break;
    case EXT4_INODE_JOURNAL_DATA_MODE:
        inode->i_mapping->a_ops = &ext4_journalled_aops;
        return;
    default:
        BUG();
    }
    if (test_opt(inode->i_sb, DELALLOC))
        inode->i_mapping->a_ops = &ext4_da_aops;
    else
        inode->i_mapping->a_ops = &ext4_aops;
}
```

### xfs

xfs has fully migrated to iomap, resulting in a simpler `a_ops` that delegates almost everything to generic iomap helpers:

```c
/* fs/xfs/xfs_aops.c */
const struct address_space_operations xfs_address_space_operations = {
    .read_folio             = xfs_read_folio,
    .readahead              = xfs_readahead,
    .writepages             = xfs_writepages,
    .dirty_folio            = filemap_dirty_folio,
    .release_folio          = iomap_release_folio,
    .invalidate_folio       = iomap_invalidate_folio,
    .bmap                   = xfs_vm_bmap,
    .direct_IO              = noop_direct_IO,
    .migrate_folio          = filemap_migrate_folio,
    .is_partially_uptodate  = iomap_is_partially_uptodate,
    .error_remove_folio     = generic_error_remove_folio,
    .swap_activate          = xfs_iomap_swap_activate,
};
```

`xfs_read_folio`, `xfs_readahead`, and `xfs_writepages` are thin wrappers around `iomap_read_folio`, `iomap_readahead`, and `iomap_writepages` that pass in xfs's own `iomap_ops` implementation. There is no `write_begin`/`write_end` in the xfs `a_ops` — xfs handles buffered writes entirely through `xfs_file_buffered_write` → `iomap_file_buffered_write`, bypassing `generic_perform_write` entirely.

---

## The iomap layer: replacing per-operation complexity

Before iomap (merged in Linux 4.8 for xfs, progressively adopted elsewhere), each filesystem had to implement the full set of `a_ops` separately: its own `read_folio`, `readahead`, `write_begin`, `write_end`, `writepages`, `direct_IO`, and `invalidate_folio`. These implementations were largely parallel and subtly inconsistent — different filesystems had different bugs in their read-modify-write handling, their large-write optimizations, and their O_DIRECT alignment checks.

iomap reduces this to a single abstraction: the filesystem provides an `iomap_ops` table with one key function:

```c
/* include/linux/iomap.h */
struct iomap_ops {
    /*
     * Return the mapping of a file range. The filesystem fills in
     * *iomap with the physical block mapping for [pos, pos+length).
     * Multiple calls may be needed to cover a range that spans
     * multiple extents.
     */
    int (*iomap_begin)(struct inode *inode, loff_t pos, loff_t length,
                       unsigned flags, struct iomap *iomap,
                       struct iomap *srcmap);

    int (*iomap_end)(struct inode *inode, loff_t pos, loff_t length,
                     ssize_t written, unsigned flags,
                     struct iomap *iomap);
};
```

Given this single mapping function, iomap provides complete, well-tested implementations for the entire `a_ops` surface:

| iomap function | replaces a_ops hook |
|---|---|
| `iomap_read_folio()` | `read_folio` |
| `iomap_readahead()` | `readahead` |
| `iomap_writepages()` | `writepages` |
| `iomap_write_begin()` / `iomap_write_end()` | `write_begin` / `write_end` |
| `iomap_dio_rw()` | `direct_IO` (via `->read_iter` / `->write_iter`) |
| `iomap_invalidate_folio()` | `invalidate_folio` |
| `iomap_release_folio()` | `release_folio` |
| `iomap_is_partially_uptodate()` | `is_partially_uptodate` |

The benefit is multiplicative: improvements to `iomap_writepages` (large bio coalescing, writeback error handling, large folio support) immediately benefit all filesystems that use it.

**Extent mapping cache — `iomap_page`:**

For large folios (order > 0), iomap needs to track which individual filesystem blocks within the folio are uptodate. It attaches a `struct iomap_page` to the folio's private slot:

```c
/* fs/iomap/buffered-io.c */
struct iomap_page {
    atomic_t        read_bytes_pending;
    atomic_t        write_bytes_pending;
    spinlock_t      uptodate_lock;
    unsigned long   uptodate[];   /* bitmap, one bit per block */
};
```

This bitmap is what `iomap_is_partially_uptodate` reads, and it is what allows a 64 KB large folio on a 4 KB block filesystem to track that only the first 4 KB has been read from disk.

---

## tmpfs and anonymous pages

`tmpfs` (`fs/shmem.c`) uses `shmem_aops` — there is no block device involved. Pages are backed by anonymous memory and may be swapped out under memory pressure:

```c
/* fs/shmem.c */
static const struct address_space_operations shmem_aops = {
    .dirty_folio      = filemap_dirty_folio,
    .write_begin      = shmem_write_begin,
    .write_end        = shmem_write_end,
    .invalidate_folio = shmem_invalidate_folio,
    .release_folio    = shmem_release_folio,
    .writepage        = shmem_writepage,   /* writes to swap */
    .migrate_folio    = migrate_folio,
#ifdef CONFIG_TRANSPARENT_HUGEPAGE
    .is_partially_uptodate = shmem_is_partially_uptodate,
#endif
};
```

Key differences from disk-backed filesystems:

- **No `read_folio`:** A page that is not in the cache and not in swap is simply a new allocation filled with zeros (`shmem_get_folio` → `shmem_alloc_folio`). There is nothing to read from disk.
- **`writepage` writes to swap:** Under memory pressure the VM calls `shmem_writepage`, which allocates a swap slot and writes the page there. The page's `mapping` pointer is replaced with an `swp_entry_t` so the swap entry can be found on the next access.
- **No `writepages`:** tmpfs does not do periodic background writeback. Pages only leave RAM when the VM explicitly evicts them.

The `mmap` of a `tmpfs` file is backed by the same `address_space`, which is why `memfd_create()` (which creates a tmpfs inode) is used for anonymous shared memory between processes — the page cache is the shared backing store.

---

## Page cache lookup and the a_ops contract

To close the loop: here is how a cache miss leads from VFS to `read_folio`:

```
sys_read(fd, buf, count)
  → vfs_read() → file->f_op->read_iter()
  → generic_file_read_iter() → filemap_read()        [mm/filemap.c]
  → filemap_get_folios()                              look up i_pages xarray
      → <miss>
  → filemap_create_folio()
      → folio_alloc() + __filemap_add_folio()         allocate + insert locked folio
  → filemap_read_folio()
      → mapping->a_ops->read_folio(file, folio)       *** filesystem hook ***
          submit bio; return 0
  → folio_wait_locked(folio)                          block until bio completes
  ← bio completion → folio_end_read()
      folio_mark_uptodate(folio)
      folio_unlock(folio)                             wakes filemap_read
  → copy_folio_to_iter(folio, offset, bytes, iter)   copy to userspace
  → return bytes read
```

The page cache is responsible for deduplicating concurrent requests: if two threads miss on the same page, the second thread finds the folio in `i_pages` already (added by the first thread), observes that `PG_locked` is set, and blocks on `folio_wait_locked` rather than issuing a second `read_folio` call.

---

## Key source files

| File | Role |
|---|---|
| `include/linux/fs.h` | `struct address_space_operations` definition; `struct address_space` |
| `mm/filemap.c` | `filemap_read`, `filemap_read_folio`, `generic_perform_write`, `filemap_dirty_folio` |
| `mm/page-writeback.c` | `write_cache_pages`, `folio_mark_dirty`, dirty throttling |
| `fs/fs-writeback.c` | `do_writepages`, writeback worker, `__writeback_single_inode` |
| `fs/buffer.c` | `block_write_begin`, `block_write_end`, `block_is_partially_uptodate`, buffer head helpers |
| `fs/mpage.c` | `mpage_read_folio`, `mpage_readahead` — generic block-mapped read helpers |
| `fs/ext4/inode.c` | `ext4_aops`, `ext4_da_aops`, `ext4_journalled_aops`; `ext4_write_begin/end` |
| `fs/xfs/xfs_aops.c` | `xfs_address_space_operations`; thin iomap wrappers |
| `fs/iomap/buffered-io.c` | `iomap_read_folio`, `iomap_readahead`, `iomap_write_begin/end`, `iomap_writepages` |
| `fs/iomap/direct-io.c` | `iomap_dio_rw` — iomap O_DIRECT path |
| `fs/shmem.c` | `shmem_aops`, `shmem_writepage`, swap-backed anonymous pages |
| `mm/readahead.c` | `ondemand_readahead`, readahead window management |
| `mm/migrate.c` | folio migration, calls `migrate_folio` and `launder_folio` |

## Further reading

- [Buffered I/O](buffered-io.md) — how `read()` and `write()` flow through VFS and the page cache
- [Direct I/O](direct-io.md) — bypassing the page cache with `O_DIRECT`
- [Async I/O evolution](async-io.md) — POSIX AIO and io_uring
- `fs/iomap/buffered-io.c` — iomap implementations of most `a_ops` hooks
- `mm/filemap.c` — the generic page cache engine that calls into `a_ops`
- `Documentation/filesystems/vfs.rst` — VFS layer overview including `address_space_operations` contract documentation
