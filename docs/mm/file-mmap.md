# File-Backed mmap and Page Faults

> How mmap() of a file works: from mapping to first read

## mmap of a regular file

```c
int fd = open("data.bin", O_RDONLY);
void *addr = mmap(NULL, file_size, PROT_READ, MAP_PRIVATE | MAP_POPULATE, fd, 0);
```

`mmap()` creates a **VMA** (virtual memory area) but does NOT immediately read the file. Pages are faulted in lazily — the first access to each page triggers a **page fault**.

```
mmap() call:
  1. Allocate struct vm_area_struct
  2. Link to mm_struct's VMA tree (maple tree)
  3. Set vma->vm_file = file
     vma->vm_ops = &generic_file_vm_ops (or ext4_file_vm_ops)
  4. Return virtual address — no pages allocated yet

First read from addr:
  1. CPU: address not in page table → hardware page fault
  2. Kernel: do_page_fault() → handle_mm_fault()
  3. VMA found → filemap_fault() or ext4_filemap_fault()
  4. Page cache lookup: is the page already in cache?
     Hit: map the existing page into the process's page table
     Miss: allocate a page, read from disk, map into page table
```

## The page fault path

```c
/* mm/memory.c */
vm_fault_t handle_mm_fault(struct vm_area_struct *vma,
                             unsigned long address, unsigned int flags,
                             struct pt_regs *regs)
{
    pgd_t *pgd = pgd_offset(mm, address);
    p4d_t *p4d = p4d_alloc(mm, pgd, address);
    pud_t *pud = pud_alloc(mm, p4d, address);
    pmd_t *pmd = pmd_alloc(mm, pud, address);

    return handle_pte_fault(vmf);
}

static vm_fault_t handle_pte_fault(struct vm_fault *vmf)
{
    pte_t entry = *vmf->pte;

    if (!pte_present(entry)) {
        if (pte_none(entry)) {
            if (vma->vm_ops) {
                /* File-backed: call the VMA's fault handler */
                return do_fault(vmf);
            }
            /* Anonymous: allocate a zero page */
            return do_anonymous_page(vmf);
        }
        /* Swap entry: page is in swap */
        return do_swap_page(vmf);
    }

    /* Present but write-protected: copy-on-write */
    if (vmf->flags & FAULT_FLAG_WRITE && !pte_write(entry))
        return do_wp_page(vmf);

    return VM_FAULT_PFNMAP;
}
```

### do_fault: file-backed fault

```c
/* mm/memory.c */
static vm_fault_t do_fault(struct vm_fault *vmf)
{
    struct vm_area_struct *vma = vmf->vma;

    if (!vma->vm_ops->fault)
        return VM_FAULT_SIGBUS;

    if (!(vmf->flags & FAULT_FLAG_WRITE)) {
        /* Read fault: share the page (MAP_PRIVATE or MAP_SHARED) */
        return do_read_fault(vmf);
    }

    if (!(vma->vm_flags & VM_SHARED)) {
        /* Write fault on MAP_PRIVATE: copy-on-write */
        return do_cow_fault(vmf);
    }

    /* Write fault on MAP_SHARED: dirty the page */
    return do_shared_fault(vmf);
}

static vm_fault_t do_read_fault(struct vm_fault *vmf)
{
    /* Call the VMA's fault() operation */
    ret = __do_fault(vmf);
    /* For ext4: → ext4_filemap_fault → filemap_fault */

    map_pages(vmf, vmf->pgoff, vmf->pgoff);
    /* Install PTE: virtual address → physical page */
}
```

### filemap_fault: page cache lookup

```c
/* mm/filemap.c */
vm_fault_t filemap_fault(struct vm_fault *vmf)
{
    struct file *file = vmf->vma->vm_file;
    struct address_space *mapping = file->f_mapping;
    pgoff_t offset = vmf->pgoff;

    /* 1. Lookup page in page cache */
    folio = filemap_get_folio(mapping, offset);

    if (!folio) {
        /* Page cache miss: need to read from disk */

        /* 2. Trigger readahead for surrounding pages */
        page_cache_sync_readahead(mapping, ra, file, offset,
                                   ra->ra_pages);

        /* 3. Allocate a new folio */
        folio = filemap_alloc_folio(vmf->gfp_mask, 0);

        /* 4. Add to page cache */
        filemap_add_folio(mapping, folio, offset, vmf->gfp_mask);

        /* 5. Read from disk via address_space_operations */
        mapping->a_ops->readahead(rac);
        /* → ext4_readahead → ext4_mpage_readpages → bio submission */

        wait_on_page_locked(folio);
    } else {
        /* Cache hit: trigger async readahead for future pages */
        page_cache_async_readahead(mapping, ra, file, folio,
                                    offset, ra->ra_pages);
    }

    vmf->page = folio_file_page(folio, offset);
    return VM_FAULT_LOCKED;
    /* Caller installs the PTE */
}
```

## Readahead

The kernel prefetches pages ahead of sequential access:

```c
/* mm/readahead.c */
void page_cache_sync_readahead(struct address_space *mapping,
                                struct file_ra_state *ra,
                                struct file *filp,
                                pgoff_t index, unsigned long req_count)
{
    /* Adaptive: start small, double until hitting the ra_max limit */
    /* Typical: 128KB initial, up to 512KB or more */
    ondemand_readahead(mapping, ra, filp, false, index, req_count);
}
```

Readahead state per file (`struct file_ra_state`):

```c
struct file_ra_state {
    pgoff_t start;          /* where readahead starts */
    unsigned int size;      /* # of readahead pages */
    unsigned int async_size;/* # to trigger async readahead */
    unsigned int ra_pages;  /* max readahead window */
    unsigned int mmap_miss; /* for mmap readahead */
    loff_t prev_pos;        /* previous file position */
};
```

## MAP_PRIVATE vs MAP_SHARED

### MAP_PRIVATE (copy-on-write)

```
Initial state:
  Process PTE → page cache page (read-only)

On first write:
  COW fault:
  1. Allocate a new page
  2. Copy page cache page → new page
  3. Install new PTE → new page (writable)
  4. Page cache page unchanged
```

```c
/* MAP_PRIVATE write fault */
static vm_fault_t do_cow_fault(struct vm_fault *vmf)
{
    /* Allocate a new page */
    vmf->cow_page = alloc_page_vma(GFP_HIGHUSER_MOVABLE, vma, vmf->address);

    /* Read the original file page */
    ret = __do_fault(vmf);

    /* Copy original page to new COW page */
    copy_user_highpage(vmf->cow_page, vmf->page, vmf->address, vma);

    /* Install PTE to the new writable copy */
    finish_fault(vmf);
}
```

### MAP_SHARED (shared dirty)

```
Write to MAP_SHARED:
  1. PTE was read-only (even though VMA is writable)
  2. do_shared_fault: dirty the page in-place
  3. Mark page dirty in page cache
  4. Install writable PTE

Later:
  Writeback daemon flushes dirty pages to disk
```

```c
static vm_fault_t do_shared_fault(struct vm_fault *vmf)
{
    /* Get page from file (may read from disk) */
    ret = __do_fault(vmf);

    /* If filesystem needs it: notify about the dirty page */
    if (vma->vm_ops->page_mkwrite) {
        vma->vm_ops->page_mkwrite(vmf);
        /* ext4: starts a journal transaction, marks page dirty */
    }

    /* Install writable PTE */
    finish_fault(vmf);
    set_page_dirty(vmf->page);
}
```

## madvise hints

`madvise()` tells the kernel how the application will access pages:

```c
madvise(addr, length, advice);
```

| Advice | Effect |
|--------|--------|
| `MADV_SEQUENTIAL` | Increase readahead aggressively; free pages after use |
| `MADV_RANDOM` | Disable readahead; random access pattern |
| `MADV_WILLNEED` | Prefetch pages now (async readahead) |
| `MADV_DONTNEED` | Discard pages, free physical memory |
| `MADV_FREE` | Mark pages as candidates for reclaim (lazy free) |
| `MADV_HUGEPAGE` | Request THP for this range |
| `MADV_POPULATE_READ` | Populate pages by simulating reads (no COW) |
| `MADV_POPULATE_WRITE` | Populate pages by simulating writes (triggers COW) |

```c
/* Prefetch a file section before processing */
madvise(file_addr, CHUNK_SIZE, MADV_WILLNEED);
/* ... do other work ... */
/* Now access file_addr — pages likely already in cache */

/* Free a large mapping after done with it */
madvise(mmap_addr, file_size, MADV_DONTNEED);
/* Physical pages freed immediately; next access re-reads from file */
```

### MADV_SEQUENTIAL in the kernel

```c
/* mm/madvise.c */
static long madvise_behavior(struct vm_area_struct *vma, ...)
{
    switch (behavior) {
    case MADV_SEQUENTIAL:
        new_flags |= VM_SEQ_READ;
        new_flags &= ~VM_RAND_READ;
        break;
    case MADV_RANDOM:
        new_flags |= VM_RAND_READ;
        new_flags &= ~VM_SEQ_READ;
        break;
    }
}

/* In filemap_fault: check vm_flags */
if (vma->vm_flags & VM_SEQ_READ)
    ra->ra_pages = max(ra->ra_pages, bdi->ra_pages);
if (vma->vm_flags & VM_RAND_READ)
    ra->ra_pages = 0;  /* disable readahead */
```

## Huge pages for file mappings (THP)

File-backed mappings can use Transparent Huge Pages if the filesystem supports it (ext4, tmpfs, xfs with 5.18+):

```c
/* Huge page fault: maps 2MB instead of 4KB */
vm_fault_t do_huge_pmd_anonymous_page(struct vm_fault *vmf)
{
    /* For file-backed: filemap_fault_huge → read 512 contiguous pages */
}
```

```bash
# Enable THP for file mappings
echo always > /sys/kernel/mm/transparent_hugepage/enabled

# Per-mapping
madvise(addr, length, MADV_HUGEPAGE);

# Check THP usage
cat /proc/<pid>/smaps | grep -A5 "file_name"
# AnonHugePages:    2048 kB
```

## Further reading

- [Page Cache](page-cache.md) — the cache filemap_fault reads from
- [Copy-on-Write](cow.md) — MAP_PRIVATE COW mechanics
- [Process Address Space](mmap.md) — VMA layout
- [What Happens During exec()](exec.md) — file mmaps created by ELF loader
- [Page Reclaim](reclaim.md) — reclaiming file-backed pages
- `mm/filemap.c` — filemap_fault, readahead
- `mm/madvise.c` — madvise implementation
