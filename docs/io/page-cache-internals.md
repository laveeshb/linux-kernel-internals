# Page Cache Internals

> The XArray data structure, folio lifecycle, locking model, and how the page cache evolved from radix tree to XArray to folios

## What the page cache is

The page cache is the kernel's in-memory representation of file data. It is the reason why reading the same file twice is fast, why writes do not block waiting for disk, and why large files can be mapped into multiple processes simultaneously.

Every byte of a regular file that the kernel has touched lives in the page cache until memory pressure forces it out. A `read()` on a cached file is a `copy_to_user()` from DRAM. A `write()` is a `copy_from_user()` into DRAM followed by a mark-dirty operation. The actual disk I/O happens asynchronously, later, by the writeback subsystem.

```
read():   page cache hit  → copy_to_user() → done
          page cache miss → allocate folio → submit_bio() → wait → copy_to_user()

write():  copy_from_user() → mark folio dirty → return
                                   ↓  (asynchronously, later)
                          writeback → submit_bio() → disk
```

This design is what makes buffered I/O fast: reads exploit temporal locality, writes are batched, and multiple readers (including mmap'd processes) share the same physical pages.

---

## Data structure evolution

The kernel's page cache has gone through four distinct structural eras. Understanding them explains why modern code looks the way it does.

### Era 1: Buffer cache (pre-2.4)

Before Linux 2.4, the kernel had two separate caches:

- The **page cache** held file data mapped in page-granularity chunks.
- The **buffer cache** held block device data in block-granularity chunks (512 B to 4 KB).

A read from a file backed by a block device populated both caches. The same data sat in RAM twice: once in the page cache (for `read()`) and once in the buffer cache (for the block layer). This double-caching wasted memory and created coherency problems.

Linux 2.4 unified them. All file data now goes through the page cache. Buffer heads (`struct buffer_head`) were retained as a per-block-within-page tracking structure, but the buffer cache as a separate entity disappeared.

### Era 2: Radix tree (2.4 – 4.19)

The page cache was implemented as a **radix tree** indexed by page index (file offset >> `PAGE_SHIFT`). Each leaf held a `struct page *`.

```c
/* include/linux/fs.h, pre-4.20 */
struct address_space {
    struct radix_tree_root page_tree;  /* all cached pages */
    spinlock_t             tree_lock;  /* protects page_tree */
    /* … */
};
```

The radix tree gave O(log N) lookup — acceptable for large files — and supported "exception entries": special tagged pointers used to track pages that were in the process of being swapped out. The external `tree_lock` spinlock protected the entire tree, which became a contention point on high-core-count machines.

### Era 3: XArray (4.20+)

Linux 4.20 replaced the radix tree with the **XArray**, designed by Matthew Wilcox. The `xarray` is conceptually the same structure — a sparse array of pointers indexed by an unsigned long — but with a substantially cleaner implementation and internal locking.

```c
/* include/linux/fs.h, 4.20+ */
struct address_space {
    struct xarray  i_pages;   /* replaces page_tree + tree_lock */
    /* … */
};
```

Key improvements over the radix tree:

- **Internal spinlock**: the XArray embeds its own lock inside `xa_lock()` / `xa_unlock()` macros. Callers do not need to maintain a separate `tree_lock`.
- **Multi-index entries**: a single entry can span multiple consecutive indices. This was the feature required to support large folios (one folio covering 2^N pages occupies 2^N consecutive XArray slots).
- **Cleaner API**: `xa_load()`, `xa_store()`, `xa_erase()` vs the old `radix_tree_lookup()`, `radix_tree_insert()`, `radix_tree_delete()` with their separate locking requirements.
- **Mark bits**: three mark arrays per node, used for `PAGECACHE_TAG_DIRTY`, `PAGECACHE_TAG_WRITEBACK`, and `PAGECACHE_TAG_TOWRITE`.

The algorithmic complexity (O(log N) height proportional to `BITS_PER_LONG`) and the underlying trie structure are unchanged; the XArray is a polish pass over the radix tree, not a new algorithm.

### Era 4: Folios (5.16+)

`struct page` was an overloaded type. A single `struct page` could refer to:

- A single base page (4 KB on x86).
- The **head** of a compound page (the first page of a physically contiguous group allocated at a higher order).
- A **tail** page within a compound page.

Code throughout the kernel had to test `PageCompound(page)` and call `compound_head(page)` before touching many fields. Bugs were common and the semantics were unclear at every call site.

Linux 5.16 introduced `struct folio` as the **canonical unit of the page cache**. A folio is always the head. It always represents 2^order contiguous base pages. All page cache operations that previously accepted a `struct page *` pointing at a head were converted to accept `struct folio *`.

```c
/* include/linux/mm_types.h (simplified) */
struct folio {
    union {
        struct {
            unsigned long flags;       /* PG_* state bits */
            union {
                struct list_head lru;
                /* … */
            };
            struct address_space *mapping;
            pgoff_t               index;   /* page index of first page */
            union {
                void *private;
                /* … */
            };
            atomic_t  _mapcount;
            atomic_t  _refcount;
#ifdef CONFIG_MEMCG
            unsigned long memcg_data;
#endif
        };
        struct page page;
    };
    /* For order > 0, additional fields follow here */
};
```

Large folios in the **file** page cache (as opposed to anonymous memory) required Linux 6.1+. A folio of order N covers 2^N base pages and occupies 2^N consecutive slots in `i_pages`.

Benefits of large folios:

- One `folio_mark_dirty()` covers 16 pages instead of 16 `SetPageDirty()` calls.
- One bio per folio for sequential I/O (fewer bio submissions).
- Fewer TLB entries needed when the folio is mmap'd.
- One lock/unlock cycle per folio instead of one per base page.

---

## struct address_space internals

Every inode that holds cached file data has an embedded `address_space`. Sockets, pipes, and anonymous mappings use their own address spaces. The `address_space` is the primary object the page cache manipulates.

```c
/* include/linux/fs.h */
struct address_space {
    struct inode           *host;
    struct xarray           i_pages;         /* all cached folios */
    struct rw_semaphore     invalidate_lock;  /* prevents races with truncate */
    gfp_t                   gfp_mask;        /* GFP flags for folio allocation */
    atomic_t                i_mmap_writable; /* count of writable VMAs */
    struct rb_root_cached   i_mmap;          /* tree of VMAs mapping this file */
    unsigned long           nrpages;         /* total cached pages (base page units) */
    pgoff_t                 writeback_index; /* writeback cursor */
    const struct address_space_operations *a_ops;
    unsigned long           flags;           /* AS_EIO, AS_ENOSPC, AS_UNEVICTABLE */
    errseq_t                wb_err;          /* sticky writeback error */
    spinlock_t              private_lock;
    struct list_head        private_list;
    void                   *private_data;
} __attribute__((aligned(sizeof(long))));
```

Field by field:

**`host`** — The inode that owns this address space. For an anonymous mapping or a special case like `shmem`, this may point to a synthetic inode. Most code uses `mapping->host` to reach the inode.

**`i_pages`** — The XArray that maps `pgoff_t` (page index = byte offset >> `PAGE_SHIFT`) to `struct folio *`. This is the central data structure of the page cache. Lookups go through `xa_load()` or the higher-level `filemap_get_folio()`. The XArray's internal lock is acquired via `xa_lock(&mapping->i_pages)`.

**`invalidate_lock`** — A `rw_semaphore`. Write-locked by truncate operations (`truncate_inode_pages_range`) to prevent page faults from instantiating new folios into a range that is being removed. Read-locked by the page fault path (`filemap_fault`) to allow concurrent faults while no truncate is in progress.

**`gfp_mask`** — GFP allocation flags used when allocating new folios for this mapping. Filesystems that cannot tolerate memory reclaim during a folio allocation (e.g., those using `GFP_NOFS`) set this field accordingly. `mapping_gfp_mask(mapping)` is the accessor.

**`i_mmap_writable`** — Count of VMAs mapped writable into this file. Used by the write-protect logic: if this is non-zero, the file has at least one writable mmap'd region and dirty accounting must account for that.

**`i_mmap`** — An interval tree (`rb_root_cached`) of all `struct vm_area_struct` objects that map this file, sorted by page index. Used for **reverse mapping (RMAP)**: given a folio, find all PTEs that point to it. Required for `msync()`, copy-on-write, and page reclaim. Protected by `i_mmap_rwsem` (embedded in the inode's `i_mapping`).

**`nrpages`** — Total number of **base pages** in the cache for this mapping. For an order-2 folio (4 base pages), `nrpages` is incremented by 4. Not the number of folios.

**`writeback_index`** — The page index where the next periodic writeback pass should begin. The writeback code advances this cursor as it writes pages, ensuring that all pages eventually get written rather than the same hot pages being written repeatedly.

**`a_ops`** — The `address_space_operations` vtable. The critical hooks are `read_folio` (fetch a folio from storage), `writepages` (flush dirty folios to storage), `dirty_folio` (mark a folio dirty with any filesystem-specific accounting), and `write_begin`/`write_end` (prepare and finalise a partial-page write).

**`flags`** — Bitfield of `AS_*` flags:
- `AS_EIO` — a writeback I/O error has occurred; `filemap_check_errors()` reports it.
- `AS_ENOSPC` — a no-space-left error has occurred during writeback.
- `AS_UNEVICTABLE` — pages in this mapping should not be reclaimed (e.g., `mlock`'d).

**`wb_err`** — An `errseq_t` that records the most recent sticky writeback error. See the `errseq_t` section below.

**`private_lock` / `private_list` / `private_data`** — Filesystem-private fields. Typically used by filesystems that need to attach per-mapping state. ext4 uses `private_data` to attach journalling state.

---

## Folio states (PG_* flags)

Every folio has a `flags` field encoded in its first word. The flags are the same bit positions as the old `struct page` flags — the folio type is a strict superset. Flag accessors follow the naming pattern `folio_test_<flag>()`, `folio_set_<flag>()`, `folio_clear_<flag>()`.

The most important flags for I/O paths:

| Flag | Meaning |
|------|---------|
| `PG_locked` | Folio is locked; other accessors must wait on the folio's wait queue |
| `PG_uptodate` | Folio data is valid (read from disk, written, or zero-initialised) |
| `PG_dirty` | Folio has been written to and needs writeback to storage |
| `PG_writeback` | Folio writeback I/O is currently in progress |
| `PG_referenced` | Folio was recently accessed; used as a hint by the LRU machinery |
| `PG_active` | Folio is on the active LRU list (as opposed to the inactive list) |
| `PG_reclaim` | Folio has been marked for reclaim by the page scanner |
| `PG_error` | I/O error occurred during read or writeback |
| `PG_private` | Folio has filesystem-private data attached (`folio->private`; used for buffer heads or iomap state) |
| `PG_mappedtodisk` | All blocks in this folio have been allocated on disk |
| `PG_checked` | Filesystem-specific check flag (ext2/ext3 used this) |
| `PG_swapbacked` | Folio is backed by swap rather than a file |

### Accessor macros

The generic accessors are generated by macros in `include/linux/page-flags.h`:

```c
/* include/linux/page-flags.h */
FOLIO_TEST_FLAG(dirty,   PG_dirty)
FOLIO_SET_FLAG(dirty,    PG_dirty)
FOLIO_CLEAR_FLAG(dirty,  PG_dirty)

/* Expanded form (conceptually): */
static inline bool folio_test_dirty(struct folio *folio)
{
    return test_bit(PG_dirty, &folio->flags);
}

static inline void folio_set_dirty(struct folio *folio)
{
    set_bit(PG_dirty, &folio->flags);
}

static inline void folio_clear_dirty(struct folio *folio)
{
    clear_bit(PG_dirty, &folio->flags);
}
```

Note the distinction between `folio_set_dirty()` (raw bit manipulation, no accounting) and `folio_mark_dirty()` (the correct public API that also handles accounting through `a_ops->dirty_folio`). Most callers outside the core MM should use `folio_mark_dirty()`.

Similarly, `folio_test_set_dirty()` is an atomic test-and-set that returns the old value — used in `filemap_dirty_folio()` to avoid double-accounting:

```c
/* mm/filemap.c */
bool filemap_dirty_folio(struct address_space *mapping, struct folio *folio)
{
    folio_memcg_lock(folio);
    if (folio_test_set_dirty(folio)) {  /* atomic; returns true if was already dirty */
        folio_memcg_unlock(folio);
        return false;
    }
    folio_memcg_unlock(folio);

    __lruvec_stat_mod_folio(folio, NR_FILE_DIRTY, folio_nr_pages(folio));
    __zone_stat_mod_folio(folio, NR_ZONE_WRITE_PENDING, folio_nr_pages(folio));
    __mark_inode_dirty(mapping->host, I_DIRTY_PAGES);
    return true;
}
```

---

## Folio locking

The folio lock is a single-bit mutex: `PG_locked` in `folio->flags`. It is not a full kernel mutex — it has no owner record — but it follows the same acquire/release pattern.

### folio_lock / folio_unlock

```c
/* include/linux/pagemap.h */

/*
 * Lock the folio. If PG_locked is already set, sleep until it is cleared.
 * Sets PG_locked before returning.
 */
void folio_lock(struct folio *folio);

/*
 * Try to lock the folio without sleeping.
 * Returns true if the lock was acquired, false if it was already held.
 */
bool folio_trylock(struct folio *folio);

/*
 * Unlock the folio: clear PG_locked and wake any waiters.
 */
void folio_unlock(struct folio *folio);
```

`folio_lock` is implemented with an optimistic fast path — it tries `test_and_set_bit(PG_locked, &folio->flags)` and falls into `__folio_lock_async` only if the bit was already set. The slow path calls `io_schedule()` (not `schedule()`) so that the task is accounted against I/O wait time in `iowait` statistics.

```c
/* mm/filemap.c (simplified) */
void folio_lock(struct folio *folio)
{
    if (!trylock_folio(folio))
        __folio_lock(folio);
}

static void __folio_lock(struct folio *folio)
{
    folio_wait_bit(folio, PG_locked);
    /* folio_wait_bit will attempt to grab the lock when woken */
}
```

### The folio waitqueue

The kernel cannot afford one `wait_queue_head_t` per folio — that would add 24 bytes to every folio. Instead, waiters are hashed into a global table of wait queues keyed on the folio address.

```c
/* mm/filemap.c */

/* Hash the folio address to a wait queue bucket */
static wait_queue_head_t *folio_waitqueue(struct folio *folio)
{
    return &folio_wait_table[hash_ptr(folio, PAGE_WAIT_TABLE_BITS)];
}

/* Wait for a specific bit to be cleared on this folio */
void folio_wait_bit(struct folio *folio, int bit_nr)
{
    wait_queue_head_t *q = folio_waitqueue(folio);
    struct wait_page_queue wait;

    init_wait(&wait.wait);
    wait.folio  = folio;
    wait.bit_nr = bit_nr;

    for (;;) {
        prepare_to_wait(q, &wait.wait, TASK_UNINTERRUPTIBLE);
        if (!folio_test_bit(folio, bit_nr))
            break;
        io_schedule();
    }
    finish_wait(q, &wait.wait);
}
```

Wakeup is done by `folio_wake_bit()`, which walks the bucket's wait queue and wakes only those entries whose `folio` and `bit_nr` match — preventing false wakeups for other folios that hash to the same bucket.

Key wait functions:

- `folio_wait_locked(folio)` — wait for `PG_locked` to be cleared (i.e., for the folio lock to be released).
- `folio_wait_writeback(folio)` — wait for `PG_writeback` to be cleared (i.e., for in-flight I/O to complete).
- `folio_wait_stable(folio)` — wait for both: used before reading folio data that may be undergoing writeback on a filesystem that does not support in-place writes during writeback.

### invalidate_lock

`address_space.invalidate_lock` is a `rw_semaphore` that mediates between truncate and page fault:

- **Truncate path** (`truncate_inode_pages_range`): acquires `invalidate_lock` for **writing** before removing folios from `i_pages`. This blocks any concurrent page faults.
- **Page fault path** (`filemap_fault`): acquires `invalidate_lock` for **reading** before looking up and locking a folio. Multiple concurrent faults can proceed in parallel; only a truncate blocks them.

Without `invalidate_lock`, a truncate could remove a folio from `i_pages` and free it just as a page fault handler was about to pin it. The result would be a use-after-free in the page table entry.

```c
/* mm/filemap.c (simplified) */
vm_fault_t filemap_fault(struct vm_fault *vmf)
{
    struct address_space *mapping = vmf->vma->vm_file->f_mapping;

    filemap_invalidate_lock_shared(mapping);  /* read-lock invalidate_lock */

    folio = filemap_get_folio(mapping, vmf->pgoff);
    /* … */

    filemap_invalidate_unlock_shared(mapping);
    return ret;
}
```

```c
/* mm/truncate.c (simplified) */
void truncate_inode_pages_range(struct address_space *mapping,
                                 loff_t lstart, loff_t lend)
{
    filemap_invalidate_lock(mapping);  /* write-lock invalidate_lock */

    /* Remove folios from i_pages XArray */
    truncate_inode_folio(mapping, folio);
    /* … */

    filemap_invalidate_unlock(mapping);
}
```

---

## XArray operations in the page cache

The XArray in `lib/xarray.c` is the data structure that backs `i_pages`. The page cache accesses it through two layers: a low-level `xa_*` API and a higher-level `xas_*` cursor API that amortises tree traversal across multiple operations on the same node.

### Low-level XArray API

```c
/* include/linux/xarray.h */

/* Load: O(log N), no lock required if the caller holds RCU read lock */
void *xa_load(struct xarray *xa, unsigned long index);

/* Store: returns the old entry; caller must hold xa_lock */
void *xa_store(struct xarray *xa, unsigned long index, void *entry, gfp_t gfp);

/* Erase: equivalent to xa_store(xa, index, NULL) */
void *xa_erase(struct xarray *xa, unsigned long index);

/* Lock / unlock the XArray's internal spinlock */
void xa_lock(struct xarray *xa);
void xa_unlock(struct xarray *xa);
void xa_lock_irq(struct xarray *xa);
void xa_unlock_irq(struct xarray *xa);
```

### Cursor API for range operations

For range lookups and multi-entry stores, the `XA_STATE` cursor avoids re-traversing the tree from the root for each access:

```c
/* include/linux/xarray.h */
#define XA_STATE(name, array, index)                    \
    struct xa_state name = __XA_STATE(array, index, 0, 0)

/* xa_state contains:
 *   xas_xa    — pointer to the xarray
 *   xas_index — current index
 *   xas_node  — current internal node
 *   xas_offset — offset within xas_node
 */
```

### How filemap uses the XArray

```c
/* mm/filemap.c (simplified) */

/* Look up a folio by page index */
struct folio *filemap_get_folio(struct address_space *mapping, pgoff_t index)
{
    struct folio *folio;

    rcu_read_lock();
    folio = xa_load(&mapping->i_pages, index);
    if (xa_is_value(folio))
        folio = NULL;  /* exception entry (swap / in-progress) */
    if (folio)
        folio_get(folio);  /* increment refcount */
    rcu_read_unlock();

    return folio;
}

/* Insert a new folio at index */
int __filemap_add_folio(struct address_space *mapping,
                         struct folio *folio, pgoff_t index, gfp_t gfp)
{
    XA_STATE(xas, &mapping->i_pages, index);
    int error;

    folio_ref_add(folio, 1);
    folio->mapping = mapping;
    folio->index   = index;

    xas_lock_irq(&xas);
    xas_store(&xas, folio);  /* insert into the XArray */
    if (xas_error(&xas)) {
        error = xas_error(&xas);
        goto unlock;
    }
    mapping->nrpages += folio_nr_pages(folio);
unlock:
    xas_unlock_irq(&xas);
    return error;
}
```

### Large folios and multi-index entries

A large folio of order N covers 2^N base pages and therefore 2^N consecutive page indices. The XArray's multi-index entry support is what makes this possible: a single `xas_store_range()` call marks all 2^N indices as occupied by the same folio.

```c
/* mm/filemap.c (simplified, large folio path) */
int __filemap_add_folio(struct address_space *mapping,
                         struct folio *folio, pgoff_t index, gfp_t gfp)
{
    unsigned int nr = folio_nr_pages(folio);

    /* For order-0 folios: XA_STATE(xas, &mapping->i_pages, index) */
    /* For large folios:   XA_STATE_ORDER(xas, &mapping->i_pages, index, folio_order(folio)) */
    XA_STATE_ORDER(xas, &mapping->i_pages, index, folio_order(folio));

    xas_lock_irq(&xas);
    xas_store(&xas, folio);   /* occupies all 2^order slots atomically */
    mapping->nrpages += nr;
    xas_unlock_irq(&xas);
}
```

A lookup at any index within the folio's range returns the same folio pointer, making the multi-index entry transparent to callers that scan the XArray sequentially.

### XArray tags

The XArray supports three **mark bits** per entry. The page cache uses them for writeback tagging:

| Tag | `PAGECACHE_TAG_*` | Meaning |
|-----|-------------------|---------|
| 0 | `PAGECACHE_TAG_DIRTY` | Folio is dirty |
| 1 | `PAGECACHE_TAG_WRITEBACK` | Folio writeback is in progress |
| 2 | `PAGECACHE_TAG_TOWRITE` | Folio selected for this writeback pass |

`write_cache_pages()` uses these tags to efficiently iterate only dirty folios in a range:

```c
/* mm/page-writeback.c (simplified) */
int write_cache_pages(struct address_space *mapping,
                      struct writeback_control *wbc,
                      writepage_t writepage, void *data)
{
    XA_STATE(xas, &mapping->i_pages, index);

    xas_for_each_marked(&xas, folio, end, PAGECACHE_TAG_DIRTY) {
        /* Only visits dirty folios — skips over clean ones efficiently */
        folio_lock(folio);
        writepage(folio, wbc, data);
    }
}
```

---

## Page cache coherency

### mmap vs read/write coherency

A file can be mmap'd and read/written via `read()`/`write()` simultaneously from the same or different processes. The kernel guarantees coherency because both paths operate on the **same** `address_space.i_pages`:

- `read()` copies from the folio to the user buffer.
- `write()` copies from the user buffer into the folio and marks it dirty.
- `mmap` maps the folio's physical page directly into the process's page table.

There is no second copy. A `write()` that modifies a folio is immediately visible to any process that has the same folio mmap'd — they share the same physical page. This is why POSIX requires this coherency: it is a natural consequence of the unified page cache.

The `i_mmap` RB-tree records every `vm_area_struct` that maps this file. It is used for:

- **Reverse mapping (RMAP)**: given a folio, find and update/invalidate all PTEs that map it. Required for page reclaim, copy-on-write, and `mprotect()`.
- **`msync()`**: find all dirty PTEs in the range and ensure the backing folios are written back.
- **Truncate**: walk all VMAs to remove PTEs for pages being truncated, preventing future accesses to freed pages.

### Truncate coherency

Truncate is the most complex coherency case. The sequence is:

```
truncate_setsize(inode, new_size)          /* update i_size atomically */
truncate_inode_pages_final(mapping)
  → filemap_invalidate_lock(mapping)       /* write-lock invalidate_lock */
  → truncate_inode_pages_range(mapping, new_size, LLONG_MAX)
      → xa_lock(&mapping->i_pages)
      → remove folios from XArray
      → xa_unlock(&mapping->i_pages)
      → folio_unmap_invalidate()           /* remove PTEs via i_mmap walk */
      → folio_unlock(folio)
  → filemap_invalidate_unlock(mapping)
```

While `invalidate_lock` is write-locked, any page fault for an address in the file blocks at `filemap_invalidate_lock_shared()`. After the truncate completes:

- The removed folios are gone from `i_pages`.
- Their PTEs have been zapped.
- Any new access to the truncated range triggers a fresh page fault.
- `filemap_fault` finds no folio in `i_pages`, allocates a new zero folio (the new length of the file is zero or the accessed offset is past `i_size`), or returns `VM_FAULT_SIGBUS` for accesses past the end of the new file size.

### Write ordering and page cache

The page cache does not guarantee write ordering to userspace. Two concurrent `write()` calls to overlapping regions of the same file have undefined interleaving — the caller must use external synchronisation (e.g., a lock, or `pwrite()` with non-overlapping ranges) to get deterministic results. The kernel provides atomicity only at the `write_begin`/`write_end` level within a single filesystem block boundary.

---

## errseq_t: sticky error tracking

Writeback I/O errors present a fundamental problem: a `write()` call returns before the data hits disk, so the I/O error arrives later, asynchronously. How does the kernel report it to the application?

The answer is `errseq_t`:

```c
/* include/linux/errseq.h */

/*
 * errseq_t packs an error code and a monotonically increasing sequence
 * number into a single 32-bit value. The low bits are the sequence;
 * the upper bits are the error code (negated).
 *
 * This allows multiple readers to each observe an error exactly once,
 * even if they sample the errseq_t at different times.
 */
typedef u32 errseq_t;
```

The mechanism:

1. When a writeback I/O error occurs, `mapping_set_error(mapping, error)` atomically updates `mapping->wb_err` to encode the error plus a new sequence number.
2. Each file descriptor records the last sequence number it has observed in `file->f_wb_err` (sampled at `open()` time).
3. On `fsync()` or `fdatasync()`, `filemap_check_errors(mapping)` compares `mapping->wb_err` against `file->f_wb_err`. If the sequence number advanced, an error is returned — even if the dirty pages have since been written successfully.
4. The sequence number increases monotonically, so if two errors occur before any application calls `fsync()`, the application still sees an error. But it sees it **once**: after the first `fsync()` returns the error, `file->f_wb_err` is updated, and a second `fsync()` (with no new error) returns 0.

```c
/* fs/sync.c (simplified fsync path) */
int vfs_fsync_range(struct file *file, loff_t start, loff_t end, int datasync)
{
    struct inode *inode = file->f_mapping->host;

    ret = file->f_op->fsync(file, start, end, datasync);
    if (!ret)
        ret = filemap_check_errors(file->f_mapping);
    return ret;
}

/* mm/filemap.c */
int filemap_check_errors(struct address_space *mapping)
{
    return errseq_check_and_advance(&mapping->wb_err, &file->f_wb_err);
}
```

This design ensures that:

- An application doing `write(); fsync()` in a loop will observe the first write error on the `fsync()` following the failed writeback, not silently lose it.
- Multiple file descriptors open on the same file each track their own sequence pointer — they each observe the error independently.
- The kernel does not need to buffer error events; the 32-bit `errseq_t` is the entire state.

---

## Large folios (6.1+)

Large folios in the file page cache were enabled in Linux 6.1. A folio of order N covers 2^N base pages. In the page cache, it occupies 2^N consecutive XArray indices starting at `folio->index`.

### Checking and querying folio order

```c
/* include/linux/mm.h */

/* True if the folio covers more than one base page */
static inline bool folio_test_large(const struct folio *folio)
{
    return folio_test_head(folio);
}

/* Returns the allocation order (0 for a single base page) */
static inline unsigned int folio_order(const struct folio *folio)
{
    if (!folio_test_large(folio))
        return 0;
    return folio->_folio_order;
}

/* Number of base pages covered by this folio */
static inline long folio_nr_pages(const struct folio *folio)
{
    return 1L << folio_order(folio);
}
```

### Allocation

Large folios are allocated via `folio_alloc()` with an explicit order, or by the page cache's `filemap_create_folio()` when readahead and the filesystem's `a_ops` agree that a large folio is appropriate:

```c
/* mm/readahead.c (simplified) */
static void page_cache_ra_order(struct readahead_control *ractl,
                                  struct file_ra_state *ra,
                                  unsigned int new_order)
{
    /* Allocate a folio large enough to cover the readahead window */
    folio = filemap_alloc_folio(mapping_gfp_mask(mapping), new_order);
    if (!folio)
        goto fallback;

    /* Insert the large folio into i_pages (occupies 2^order slots) */
    err = filemap_add_folio(mapping, folio, index, mapping_gfp_mask(mapping));
}
```

### Benefits in practice

For a sequential read of a 1 MB file with 64 KB folios (order 4):

| Operation | 4 KB folios (256) | 64 KB folios (16) |
|-----------|-------------------|-------------------|
| Folio lock/unlock cycles | 256 | 16 |
| XArray insertions | 256 | 16 |
| `read_folio` calls (or bio completions) | 256 | 16 |
| `folio_mark_dirty` calls per write | 256 | 16 |
| TLB entries (if mmap'd) | 256 PTEs | 16 PTEs (or fewer with huge pages) |

The reduction is proportional to the order for most operations, making large folios a significant win for I/O-heavy sequential workloads.

### Constraints

- The filesystem must opt in by indicating large folio support in `a_ops`.
- The folio must be physically contiguous: `__alloc_pages()` with the given order must succeed. This is harder as the system runs longer and memory becomes fragmented.
- Large folios interact with transparent huge pages (THP) for file mappings; the two features share infrastructure.

---

## Page cache statistics

### /proc/meminfo

```bash
grep -E 'Cached|Dirty|Writeback|Mapped' /proc/meminfo
```

| Field | Meaning |
|-------|---------|
| `Cached:` | Total page cache size (file data), excluding `SwapCached` |
| `Dirty:` | Pages marked dirty, waiting for writeback |
| `Writeback:` | Pages currently being written back to disk |
| `Mapped:` | Pages mapped into at least one process's address space |

### /proc/vmstat

```bash
grep -E 'nr_file|nr_dirty|nr_writeback|pgpgin|pgpgout' /proc/vmstat
```

| Counter | Meaning |
|---------|---------|
| `nr_file_pages` | Total pages in the page cache |
| `nr_dirty` | Pages currently dirty |
| `nr_writeback` | Pages currently under writeback |
| `pgpgin` | Pages read in from disk (page cache misses causing reads) |
| `pgpgout` | Pages written out to disk (writeback) |
| `pgfault` | Total page faults (minor + major) |
| `pgmajfault` | Major page faults (required disk I/O to resolve) |

### Per-cgroup (cgroup v2)

In a cgroup v2 hierarchy, `memory.stat` reports per-cgroup page cache statistics:

```bash
cat /sys/fs/cgroup/mygroup/memory.stat | grep -E 'file|dirty|writeback'
# file         — bytes of file-backed memory (page cache)
# file_dirty   — bytes of dirty file-backed memory
# file_writeback — bytes of file-backed memory currently under writeback
# pgpgin       — page cache fill events
# pgpgout      — page cache eviction events
```

### ftrace

For tracing individual folio operations:

```bash
# Trace page cache miss/fill events
echo 1 > /sys/kernel/debug/tracing/events/filemap/mm_filemap_add_to_page_cache/enable
echo 1 > /sys/kernel/debug/tracing/events/filemap/mm_filemap_delete_from_page_cache/enable
cat /sys/kernel/debug/tracing/trace_pipe

# Trace writeback activity
echo 1 > /sys/kernel/debug/tracing/events/writeback/enable
cat /sys/kernel/debug/tracing/trace_pipe
```

---

## Putting it together: a folio's lifecycle

A folio's life in the page cache follows a predictable state machine:

```
[not in cache]
      │
      │  filemap_create_folio() / filemap_fault()
      │  → __filemap_add_folio() inserts locked folio into i_pages
      │  → a_ops->read_folio() submits bio
      ▼
[locked, !uptodate]           ← PG_locked set, PG_uptodate clear
      │
      │  bio completes: folio_end_read()
      │  → folio_mark_uptodate()         PG_uptodate set
      │  → folio_unlock()                PG_locked cleared, waiters woken
      ▼
[clean, uptodate]             ← page cache hit state; data valid
      │
      │  write() / mmap write: copy_from_user() + folio_mark_dirty()
      ▼
[dirty, uptodate]             ← data in cache is newer than disk
      │
      │  writeback: write_cache_pages() → folio_lock() → writepage
      │  → folio_start_writeback()       PG_writeback set
      │  → folio_unlock()                PG_locked cleared (writeback proceeds unlocked)
      ▼
[writeback, uptodate]         ← bio in flight to disk
      │
      │  bio completes: folio_end_writeback()
      │  → folio_clear_writeback()       PG_writeback cleared, waiters woken
      ▼
[clean, uptodate]             ← back to steady state
      │
      │  memory pressure: folio_try_remove_mapping() / __remove_mapping()
      │  → remove from i_pages, free pages
      ▼
[not in cache]
```

A folio can be evicted (the last transition) only when it is clean, unlocked, not under writeback, and has no page table references (`_mapcount == -1`). The page scanner (`mm/vmscan.c`) checks all these conditions before reclaiming.

---

## Key source files

| File | Role |
|------|------|
| `mm/filemap.c` | `filemap_read`, `generic_perform_write`, `filemap_create_folio`, `filemap_get_folio`, `__filemap_add_folio`, `filemap_fault` |
| `include/linux/pagemap.h` | Folio accessors, `folio_lock`, `folio_trylock`, `folio_unlock`, `folio_wait_locked`, `folio_wait_writeback`, `filemap_get_folio` |
| `include/linux/fs.h` | `struct address_space`, `struct address_space_operations`, `struct inode` |
| `include/linux/page-flags.h` | `PG_*` flag definitions, `folio_test_*` / `folio_set_*` / `folio_clear_*` accessor macros |
| `include/linux/mm_types.h` | `struct folio`, `struct page` |
| `lib/xarray.c` | XArray implementation: `xa_load`, `xa_store`, `xas_store`, `xas_for_each_marked` |
| `include/linux/xarray.h` | XArray API, `XA_STATE`, `XA_STATE_ORDER`, tag definitions |
| `mm/truncate.c` | `truncate_inode_pages_range`, folio invalidation under `invalidate_lock` |
| `mm/page-writeback.c` | `folio_mark_dirty`, `filemap_dirty_folio`, `write_cache_pages`, dirty throttling |
| `mm/vmscan.c` | Page scanner, folio reclaim, LRU management |
| `mm/readahead.c` | `page_cache_ra_order`, large folio readahead, readahead window management |
| `include/linux/errseq.h` | `errseq_t`, `errseq_check_and_advance` |

---

## Further reading

- [Buffered I/O](buffered-io.md) — the `read()` and `write()` paths through the page cache end-to-end
- [Page cache writeback](page-cache-writeback.md) — dirty throttling, `bdi_writeback`, and the writeback worker
- [Readahead](readahead.md) — how the kernel speculatively fills the page cache ahead of sequential reads
- [mmap as an I/O mechanism](mmap-io.md) — mapping the page cache directly into process address spaces
- [Direct I/O](direct-io.md) — bypassing the page cache entirely with `O_DIRECT`
- Matthew Wilcox, ["Introducing XArray"](https://lwn.net/Articles/745073/) — LWN article explaining the design rationale
- Matthew Wilcox, ["Large folios for the page cache"](https://lwn.net/Articles/893512/) — LWN article on the folio conversion and large folio motivation
