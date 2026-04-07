# Truncate, Hole Punching, and Space Deallocation

> How the kernel shrinks files, creates sparse holes, and coordinates page cache invalidation with block deallocation

## What truncate does

`truncate(2)` and `ftruncate(2)` change a file's size. They can:

1. **Shrink a file** — remove data past the new size and release the underlying disk blocks.
2. **Extend a file** — create a sparse region past the old EOF that reads as zeros without allocating disk blocks.

Neither operation is a simple metadata update. Both require careful coordination between the page cache, the filesystem's block allocator, the VFS layer, and any memory mappings that the file currently has. Get any of those wrong and you have stale cached data, leaked blocks, or a process receiving `SIGBUS` from a mmap'd address that no longer has backing storage.

```
ftruncate(fd, new_size)
   │
   ├── new_size < i_size  (shrink)
   │     ├── 1. unmap_mapping_range()        — invalidate PTEs in all VMAs
   │     ├── 2. truncate_pagecache()         — evict pages past new_size
   │     └── 3. filesystem truncate          — free disk blocks
   │
   └── new_size > i_size  (extend / sparse)
         ├── 1. update i_size
         └── 2. pagecache_isize_extended()   — handle partial-page at old EOF
```

## System call path

```c
/* fs/open.c */
SYSCALL_DEFINE2(ftruncate, unsigned int, fd, loff_t, length)
  → do_sys_ftruncate(fd, length, 1)
  → vfs_truncate()          [fs/attr.c]

SYSCALL_DEFINE2(truncate, const char __user *, path, long, length)
  → do_sys_truncate(path, length)
  → vfs_truncate()          [fs/attr.c]
```

`vfs_truncate()` in `fs/attr.c` is the main coordination point:

```c
/* fs/attr.c (simplified) */
int vfs_truncate(const struct path *path, loff_t length)
{
    struct inode *inode = d_inode(path->dentry);

    /* 1. Basic sanity: not a directory, not a special file */
    error = may_write_file_inode(inode);
    if (error)
        return error;

    /* 2. Permission check — ATTR_SIZE requires write access (or CAP_FOWNER) */
    error = inode_permission(mnt_idmap(path->mnt), inode, MAY_WRITE);
    if (error)
        return error;

    /* 3. Open a file for the truncate operation */
    filp = dentry_open(path, O_WRONLY, current_cred());
    if (IS_ERR(filp))
        return PTR_ERR(filp);

    /* 4. Notify VFS; this calls inode->i_op->setattr() */
    newattrs.ia_size  = length;
    newattrs.ia_valid = ATTR_SIZE | ATTR_CTIME;
    error = notify_change(mnt_idmap(path->mnt), path->dentry,
                          &newattrs, NULL);
    fput(filp);
    return error;
}
```

`notify_change()` calls `inode->i_op->setattr()`. Most filesystems implement this by calling `setattr_copy()` (to update timestamps) followed by their own size-change logic — for example `ext4_setattr()` or `xfs_vn_setattr()`.

## The two operations: truncate down vs extend

### Truncate down (shrink)

Shrinking is the more complex case. The kernel must guarantee three things:

1. No process can fault in a page from the truncated range after the truncation completes.
2. All dirty pages in the truncated range are either written back or simply discarded (discarded is correct — they are no longer part of the file).
3. The filesystem frees the disk blocks that backed those pages.

The ordering matters. If blocks were freed before the page cache was cleared, a concurrent reader could see a page that points to a now-reallocated block belonging to a different file. The correct order is:

```
1. unmap_mapping_range()          — shoot down PTEs (mmap users)
2. truncate_inode_pages_range()   — remove folios from XArray
3. filesystem block freeing       — return blocks to allocator
```

#### `unmap_mapping_range()`

Before touching the page cache, `truncate_pagecache()` calls `unmap_mapping_range()` to walk all VMAs that map this file and zap the page table entries for the truncated range:

```c
/* mm/memory.c */
void unmap_mapping_range(struct address_space *mapping,
                          loff_t const holebegin, loff_t const holelen,
                          int even_cows)
```

This takes the `i_mmap_rwsem` read lock and iterates `mapping->i_mmap` (a red-black tree of VMAs). For each VMA that overlaps the hole, it calls `zap_page_range_single()` to clear PTEs and flush TLBs. After this, any access to those virtual addresses will page-fault rather than silently hitting stale data.

#### Page cache truncation

```c
/* mm/truncate.c */
void truncate_pagecache(struct inode *inode, loff_t newsize)
{
    struct address_space *mapping = inode->i_mapping;
    loff_t holebegin = round_up(newsize, PAGE_SIZE);

    unmap_mapping_range(mapping, holebegin, 0, 1);
    truncate_inode_pages(mapping, newsize);
    unmap_mapping_range(mapping, holebegin, 0, 1);
}
```

The double `unmap_mapping_range()` call closes a race window: between the first unmap and the `truncate_inode_pages()` call, a new mapping could have been established by `mmap()`. The second call catches it. After both calls, no VMA covers the truncated range.

#### The partial page at the new EOF

When `new_size` is not page-aligned, there is a partial page at the boundary. The last page is not evicted — it still holds valid data for bytes `[page_start, new_size)`. But bytes `[new_size, page_end)` must be zeroed before the page can be returned to userspace or reused. This is a security requirement: without the zero-fill, a new writer that extends the file again could read stale data from a previous file that happened to occupy the same block.

```c
/* mm/truncate.c */
static void truncate_cleanup_folio(struct folio *folio)
{
    if (folio_mapped(folio))
        unmap_mapping_folio(folio);

    if (folio_needs_release(folio))
        folio_invalidate(folio, 0, folio_size(folio));
}
```

For the partial page specifically, `zero_user_segment()` zeroes the tail bytes in the kernel mapping before any unlock happens.

#### Filesystem block deallocation

After the page cache is clean, the filesystem frees the underlying blocks. This is entirely filesystem-specific:

- **ext4**: `ext4_truncate()` in `fs/ext4/inode.c` walks the extent tree, frees extents past `new_size`, and updates the inode. For inline data, no block freeing is needed.
- **XFS**: `xfs_vn_setattr()` → `xfs_setattr_size()` → `xfs_itruncate_extents_flags()`, which trims the extent B-tree.
- **btrfs**: `btrfs_setsize()` → `btrfs_truncate()`, which handles copy-on-write extent cleanup.

### Extend (sparse file creation)

Extending a file past its current EOF is cheap: the kernel updates `i_size` and calls `pagecache_isize_extended()`. No blocks are allocated. The new range is a **sparse hole** — reads return zeros, but no disk I/O occurs because the filesystem maps this range to `IOMAP_HOLE` or similar, and the read path synthesizes zeros.

```c
/* mm/truncate.c */
void pagecache_isize_extended(struct inode *inode, loff_t from, loff_t to)
```

The subtle case is when the old EOF fell in the middle of a cached page. That page may have been partially filled (bytes `[page_start, old_size)` are valid; bytes `[old_size, page_end)` should read as zero but the kernel has not necessarily zeroed them yet). `pagecache_isize_extended()` finds that page in the XArray and calls `zero_user_segment()` on the zero-fill portion before updating `i_size`. If it did not do this, a reader could see uninitialized memory from a previous write that happened to land on the same page.

## `truncate_inode_pages_range` — the page cache side

```c
/* mm/truncate.c */
void truncate_inode_pages_range(struct address_space *mapping,
                                  loff_t lstart, loff_t lend)
```

This is the workhorse that removes folios from the XArray. It is called by both `truncate_pagecache()` (for shrink) and hole-punching (for middle-of-file holes). The steps:

1. **Acquire `invalidate_lock` write-lock.** This serializes against concurrent `mmap` page faults. A page fault that races with truncation must either complete before the lock or block until after. Without this lock, a fault could install a PTE for a page that `truncate_inode_pages_range` is about to free.

2. **Walk the XArray range.** `mapping->i_pages` is an XArray indexed by page index (`file_offset >> PAGE_SHIFT`). The function iterates all indices from `lstart >> PAGE_SHIFT` to `lend >> PAGE_SHIFT`.

3. **For each folio, call `truncate_cleanup_folio()`.** This:
   - Unmaps the folio from any remaining VMAs (should already be done by `unmap_mapping_range()`, but belt-and-suspenders).
   - Calls `a_ops->invalidate_folio()` — the filesystem hook that drops buffer heads, iomap state, or journal references attached to the folio.
   - Waits for any in-flight writeback to complete (can't free a page while a bio references it).

4. **Call `mapping_evict_folio()`.** Removes the folio from the XArray, drops the page cache reference, and frees it back to the page allocator (or LRU list if it has other references).

5. **Handle the partial folio.** For the first folio (which may straddle `lstart`), only the bytes from `lstart` onward within the folio are zeroed and/or evicted; the bytes before `lstart` are left intact.

```c
/* Sketch of the inner loop (mm/truncate.c) */
void truncate_inode_pages_range(struct address_space *mapping,
                                  loff_t lstart, loff_t lend)
{
    struct folio_batch fbatch;
    pgoff_t start = (lstart + PAGE_SIZE - 1) >> PAGE_SHIFT;
    pgoff_t end   = (lend >> PAGE_SHIFT);
    pgoff_t index = start;

    filemap_invalidate_lock(mapping);   /* write-lock invalidate_lock */

    while (index <= end) {
        nr = filemap_get_folios(mapping, &index, end, &fbatch);
        if (!nr)
            break;

        for (i = 0; i < nr; i++) {
            struct folio *folio = fbatch.folios[i];
            truncate_cleanup_folio(folio);
            folio_unlock(folio);
            mapping_evict_folio(mapping, folio);
        }
        folio_batch_release(&fbatch);
    }

    filemap_invalidate_unlock(mapping);
}
```

## Hole punching: `fallocate(FALLOC_FL_PUNCH_HOLE)`

Hole punching removes disk blocks from a range in the middle of a file. The file size does not change; the punched range reads as zeros. From the application's perspective, the file still has the same logical layout — just with a zero-filled gap where data used to be, and no disk space consumed by that gap.

```c
#include <linux/falloc.h>

/* Punch a 64 KiB hole starting at offset 1 MiB */
fallocate(fd,
          FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE,
          1UL << 20,    /* offset */
          64 << 10);    /* length */
```

`FALLOC_FL_KEEP_SIZE` is mandatory with `FALLOC_FL_PUNCH_HOLE`; the kernel returns `EINVAL` otherwise.

### Kernel path

```
fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, offset, len)
  → vfs_fallocate()          [fs/fallocate.c]
  → file->f_op->fallocate()
      → ext4_fallocate()     → ext4_punch_hole()    [fs/ext4/inode.c]
      → xfs_file_fallocate() → xfs_free_file_space() [fs/xfs/xfs_bmap_util.c]
      → btrfs_fallocate()    → btrfs_punch_hole()   [fs/btrfs/file.c]
```

Inside `ext4_punch_hole()`, the sequence mirrors the truncate-down path:

1. `filemap_write_and_wait_range()` — flush any dirty pages in the hole range.
2. `truncate_inode_pages_range()` — invalidate page cache for the punched range.
3. `ext4_ext_remove_space()` — walk the extent tree and remove extents covering the punched range, freeing the underlying blocks.
4. Update the extent tree to mark the range as a hole (`EXT4_EXT_MARK_UNWRIT` or simply remove the extents).

### Filesystem support

Hole punching requires filesystem support. Not all filesystems implement it:

| Filesystem | `FALLOC_FL_PUNCH_HOLE` | Notes |
|------------|------------------------|-------|
| ext4 | Yes (3.0+) | Requires extent-based files (not block-mapped) |
| XFS | Yes | Well-supported; native sparse file format |
| btrfs | Yes | CoW semantics; deletes extent references |
| tmpfs | Yes | In-memory pages freed immediately |
| FAT/vfat | No | No concept of sparse files |
| NFS | Partial | NFSv4.2 with `DEALLOCATE` support on server |
| CIFS/SMB | Partial | SMB 3.x server-dependent |

### Use cases

**Log rotation without descriptor invalidation.** A log consumer that has read bytes `[0, N)` can punch `[0, N)` to return disk space while the producer continues appending. Open file descriptors held by other processes remain valid; their file offsets are unaffected.

**Sparse database files.** A database that marks pages as free in its own free-list bitmap can punch holes over those pages. PostgreSQL, for example, does not do this by default, but the pattern is well-suited to its heap file format.

**Video and media editing.** A video editor that deletes a segment can punch the deleted frames, reclaiming space while keeping surrounding data at its original byte offsets.

## `FALLOC_FL_KEEP_SIZE`: pre-allocate without extending

With `mode = FALLOC_FL_KEEP_SIZE`, `fallocate()` allocates physical blocks for a range but does not change `st_size`. The file appears the same size to `stat(2)`, but the blocks are already reserved. A subsequent `write()` into the range fills pre-allocated blocks and cannot fail with `ENOSPC` for that range.

```c
/* Reserve 256 MiB for a WAL segment, keep st_size at 0 */
fallocate(fd, FALLOC_FL_KEEP_SIZE, 0, 256UL << 20);
```

### Extent representation

**ext4** creates *unwritten extents* in the extent tree. An unwritten extent has the `EXT_UNWRITTEN` flag set. Its block range is allocated and mapped, but reads synthesize zeros rather than returning disk content. The first `write()` to the extent converts it from unwritten to written.

```
Extent tree after FALLOC_FL_KEEP_SIZE:
  [0, 65536]  → block 12345  EXT_UNWRITTEN

After first write to block 0:
  [0, 0]      → block 12345  written
  [1, 65536]  → block 12346  EXT_UNWRITTEN
```

**XFS** uses a similar mechanism: the extent is marked `XFS_EXT_UNWRITTEN` in the B-tree. The conversion from unwritten to written happens in `xfs_iomap_write_unwritten()`, called from the iomap completion path.

## `FALLOC_FL_ZERO_RANGE`

`FALLOC_FL_ZERO_RANGE` zeros a byte range within a file without deallocating the blocks. Unlike hole punching, the blocks remain allocated; unlike `write(zeros)`, the operation can be metadata-only for aligned ranges.

```c
/* Zero bytes [4MiB, 8MiB) without punching a hole */
fallocate(fd, FALLOC_FL_ZERO_RANGE, 4UL << 20, 4UL << 20);
```

On ext4 and XFS, block-aligned zero-range requests convert written extents back to unwritten extents in the extent tree — the same representation as freshly preallocated blocks. No zero bytes are written to disk; the filesystem's read path synthesizes them from the unwritten extent marker. Unaligned edges require a read-modify-write for the partial blocks at each end.

The combination `FALLOC_FL_ZERO_RANGE | FALLOC_FL_KEEP_SIZE` additionally prevents the file size from being extended if `offset + len` exceeds `i_size`.

### When to prefer `FALLOC_FL_ZERO_RANGE` over hole punch

- You want the blocks to stay reserved (guaranteed no-ENOSPC on subsequent writes).
- You want the range to remain non-sparse for tools that check `st_blocks`.
- You are zeroing in a loop and will immediately re-write — keep the allocation, avoid re-allocating on the next write.

## Collapse and insert range

### `FALLOC_FL_COLLAPSE_RANGE`

Removes `len` bytes from the middle of a file starting at `offset`, shifting all subsequent file data down by `len` bytes. The file shrinks by exactly `len` bytes. Both `offset` and `len` must be multiples of the filesystem block size.

```c
/* Remove 1 MiB at offset 4 MiB, shifting the rest down */
fallocate(fd, FALLOC_FL_COLLAPSE_RANGE, 4UL << 20, 1UL << 20);
/* File size decreases by 1 MiB */
```

The operation is extent-tree manipulation — no data bytes need to move on disk if the extents are well-aligned. ext4 and XFS implement this by splicing extents in the tree. The page cache for the collapsed range is invalidated, and the remaining pages are re-indexed.

Supported on ext4 (3.15+) and XFS (3.15+). Not supported on btrfs.

### `FALLOC_FL_INSERT_RANGE`

The inverse: inserts `len` zero bytes at `offset`, shifting subsequent data up. The file grows by `len`. Alignment requirements are the same as collapse.

```c
/* Insert 512 KiB at offset 2 MiB */
fallocate(fd, FALLOC_FL_INSERT_RANGE, 2UL << 20, 512UL << 10);
/* File size increases by 512 KiB */
```

Supported on ext4 (4.1+) and XFS (4.1+). Rarely needed in practice; video editing workflows and certain binary file format updates are the main users.

## The truncate + mmap race

A classic source of `SIGBUS` in production:

1. **Process A** memory-maps a file: `addr = mmap(NULL, size, PROT_READ, MAP_SHARED, fd, 0)`.
2. **Process B** truncates the file to a smaller size or zero: `ftruncate(fd, 0)`.
3. **Process A** accesses `addr + offset` where `offset` is now beyond the new `i_size`.
4. The page fault handler checks the file size, finds the access is beyond EOF, and delivers **`SIGBUS`** to process A.

This is not a kernel bug — it is defined behavior for truncating a mapped file. The `SIGBUS` is the mechanism by which the kernel enforces the contract: "this address no longer has backing storage."

### How the kernel handles it

```
ftruncate(fd, new_size) where new_size < old_size
  │
  └── truncate_pagecache(inode, new_size)
        │
        ├── unmap_mapping_range(mapping, holebegin, 0, 1)
        │     → walk i_mmap (VMA red-black tree)
        │     → zap_page_range_single() for each VMA covering [holebegin, EOF)
        │     → flush TLBs
        │
        └── truncate_inode_pages(mapping, new_size)
              → remove folios from XArray
```

After `unmap_mapping_range()`, all PTEs in the truncated range are zeroed. The next access to those virtual addresses triggers a fresh page fault. `filemap_fault()` is called, checks `iocb->ki_pos >= i_size`, and returns `VM_FAULT_SIGBUS`. The kernel converts this to a `SIGBUS` signal delivered to the faulting process.

### Protecting mmap users from truncation

If you control both sides, the standard pattern is a reader-writer lock at the application level:

```c
/* Writer (truncater): */
pthread_rwlock_wrlock(&file_lock);
ftruncate(fd, new_size);
pthread_rwlock_unlock(&file_lock);

/* Reader (mmap user): */
pthread_rwlock_rdlock(&file_lock);
/* safe to access mmap range */
pthread_rwlock_unlock(&file_lock);
```

For one-sided cases (e.g., a library that does not control the truncating side), install a `SIGBUS` handler and use `sigsetjmp`/`siglongjmp` to recover:

```c
static sigjmp_buf sigbus_jmp;

static void sigbus_handler(int sig) {
    siglongjmp(sigbus_jmp, 1);
}

int safe_read_mapped(void *addr, size_t len, void *dst)
{
    struct sigaction sa = { .sa_handler = sigbus_handler };
    sigaction(SIGBUS, &sa, NULL);

    if (sigsetjmp(sigbus_jmp, 1)) {
        /* SIGBUS was delivered; addr is beyond EOF */
        return -EIO;
    }

    memcpy(dst, addr, len);
    return 0;
}
```

This pattern is used by database engines (SQLite WAL reader, LMDB) that must tolerate concurrent truncation.

## Security: ensuring zeroed pages

When a file is truncated down, the tail bytes of the last page must be zeroed before any other process can read them. Without this, a sequence like:

```
Process A writes "secret data" to file, then truncates to 0.
Process B opens the same file, writes 1 byte, then reads page 0.
Process B sees "ecret data" — data from process A's write.
```

The kernel prevents this in `mm/truncate.c`:

```c
/* Zero bytes [start, end) within the kernel mapping of a page */
void zero_user_segment(struct page *page,
                        unsigned int start,
                        unsigned int end)
{
    void *addr = kmap_local_page(page);
    if (end > start)
        memset(addr + start, 0, end - start);
    flush_dcache_page(page);
    kunmap_local(addr);
}
```

For folios, the equivalent is `folio_zero_segment()`, called from `truncate_inode_pages_range()` for the partial folio at the truncation boundary. This happens while the folio is still locked (before it is unlocked and potentially reused), so no window exists for a reader to see the uninitialized bytes.

## Truncate under memory pressure

When the pages being truncated are **dirty** (modified but not yet written to disk), the kernel must decide what to do with them. For a truncate-down operation, dirty data in the truncated range is simply **discarded** — it will never reach disk because it is no longer part of the file. But the discard is not free:

### Journal interaction (ext4 data=journal mode)

With ext4 mounted in `data=journal` mode, both data and metadata are journaled. A dirty page in the truncated range may have an outstanding transaction in the journal. The page cannot simply be freed — freeing it would leave the journal referencing a freed page.

`truncate_cleanup_folio()` calls `a_ops->invalidate_folio()`, which for ext4 with `data=journal` calls `jbd2_journal_invalidate_folio()`:

```c
/* fs/jbd2/transaction.c (simplified) */
int jbd2_journal_invalidate_folio(journal_t *journal,
                                   struct folio *folio,
                                   size_t offset, size_t length)
{
    /*
     * If the folio has b_frozen_data: the transaction has been submitted
     * but not committed. We must wait for the commit before freeing.
     *
     * If the folio has b_committed_data: the data is in the journal but
     * the commit is not done. Cannot free yet.
     *
     * Otherwise: detach journal state and allow the folio to be freed.
     */
}
```

In the worst case, truncating a file with dirty journaled pages requires waiting for a journal commit. This makes truncate under `data=journal` noticeably slower than under `data=ordered` or `data=writeback`.

### Writeback racing with truncate

The `truncate_cleanup_folio()` path waits for any in-flight writeback on a folio before freeing it. The flag `PG_writeback` (or `folio_test_writeback()`) is checked; if set, the function blocks on the folio's wait queue until the bio completes and `folio_end_writeback()` clears the flag.

This prevents the block layer from writing to a page that has already been freed back to the page allocator — a use-after-free in the I/O path.

## `invalidate_lock` and concurrent faults

`address_space.invalidate_lock` is a read-write semaphore that serializes truncation against page faults:

```
Truncation path:                    Page fault path:
  filemap_invalidate_lock()           filemap_invalidate_lock_shared()
  (write-lock)                        (read-lock)
    truncate_inode_pages_range()        filemap_fault()
    ...                                 folio_lock()
  filemap_invalidate_unlock()         filemap_invalidate_unlock_shared()
```

A page fault holds the read-lock, which blocks a concurrent truncation from proceeding. Truncation holds the write-lock, which blocks new page faults from beginning. This ensures that a folio cannot be simultaneously installed by a fault and removed by truncation.

Before `invalidate_lock` was introduced (Linux 5.15), this protection was provided by a more coarse-grained mechanism. The current per-`address_space` lock reduces contention for files with many concurrent readers.

## Try It Yourself

```bash
# Create a 10 MiB file and observe its block usage
dd if=/dev/zero of=demo.bin bs=1M count=10
stat demo.bin    # note st_blocks

# Shrink to 4 MiB
truncate -s 4M demo.bin
stat demo.bin    # st_size=4MiB, st_blocks decreased

# Extend to 20 MiB (sparse)
truncate -s 20M demo.bin
stat demo.bin    # st_size=20MiB, st_blocks unchanged (still ~4MiB)
du -sh demo.bin  # du shows physical usage, not st_size

# Observe hole structure with filefrag
filefrag -v demo.bin   # shows extent map; holes appear as gaps

# Punch a hole in the middle of a file
fallocate -l 10M dense.bin       # allocate 10 MiB (real blocks)
fallocate -p -o 2M -l 4M dense.bin  # punch 4 MiB hole at offset 2 MiB
filefrag -v dense.bin             # should show two extents with a gap

# Collapse range (remove middle 1 MiB, file shrinks)
# Requires ext4 or XFS and block-aligned offsets
fallocate --collapse-range --offset 2M --length 1M dense.bin

# strace to observe truncate syscall
strace -e trace=ftruncate truncate -s 1M testfile
# Output: ftruncate(3, 1048576)  = 0

# Watch block I/O during truncation with blktrace
blktrace -d /dev/nvme0n1 -a issue -o - | blkparse -i -
# (in another terminal)
truncate -s 0 /mnt/testfs/largefile

# Observe SIGBUS from truncating a mapped file
cat > mmap_race.c << 'EOF'
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    int fd = open("mapped.bin", O_RDWR | O_CREAT | O_TRUNC, 0644);
    ftruncate(fd, 4096);
    void *addr = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);

    /* Truncate to 0 while the mapping is live */
    ftruncate(fd, 0);

    /* This access will deliver SIGBUS */
    char *p = (char *)addr;
    printf("about to access truncated region...\n");
    *p = 'x';  /* SIGBUS here */
    printf("survived (should not reach here)\n");

    munmap(addr, 4096);
    close(fd);
    return 0;
}
EOF
gcc -o mmap_race mmap_race.c && ./mmap_race
# Expected: Bus error (core dumped)
```

## Key source files

| File | Contents |
|------|----------|
| `mm/truncate.c` | `truncate_inode_pages_range()`, `truncate_pagecache()`, `pagecache_isize_extended()`, `zero_user_segment()` |
| `fs/attr.c` | `vfs_truncate()`, `notify_change()` |
| `fs/fallocate.c` | `vfs_fallocate()`, mode dispatch and validation |
| `fs/ext4/inode.c` | `ext4_truncate()`, `ext4_setattr()`, `ext4_punch_hole()` |
| `fs/ext4/extents.c` | `ext4_fallocate()`, unwritten extent management |
| `fs/xfs/xfs_iops.c` | `xfs_vn_setattr()` |
| `fs/xfs/xfs_bmap_util.c` | `xfs_free_file_space()`, `xfs_alloc_file_space()` |
| `fs/jbd2/transaction.c` | `jbd2_journal_invalidate_folio()` — journal interaction during truncate |
| `mm/memory.c` | `unmap_mapping_range()` — PTE invalidation for truncated VMAs |
| `include/uapi/linux/falloc.h` | `FALLOC_FL_*` flag definitions |

## Further reading

- [fallocate and File Space Management](fallocate.md) — detailed coverage of all `FALLOC_FL_*` modes
- [Buffered I/O and the Page Cache](buffered-io.md) — how the page cache is structured, folio lifecycle
- [mmap as an I/O Mechanism](mmap-io.md) — the mmap path and why truncation races with it
- [Page Cache Internals](page-cache-internals.md) — XArray layout, folio locking, and the `address_space`
- [Life of a Write](life-of-a-write.md) — dirty page lifecycle and writeback, relevant for truncating dirty files
- `mm/truncate.c` — the canonical source for page cache truncation logic
- `fs/attr.c` — `vfs_truncate()` and the VFS attribute change path
