# The Folio Abstraction

> `struct folio` replaces the compound-page patchwork with a first-class kernel object that makes multi-page memory units safe, explicit, and efficient

## Key source files

| File | Purpose |
|------|---------|
| `include/linux/mm_types.h` | `struct folio` definition and layout assertions |
| `include/linux/page-flags.h` | `page_folio()`, `folio_page()`, flag accessors |
| `include/linux/mm.h` | `folio_order()`, `folio_nr_pages()`, `folio_size()`, `folio_pfn()`, `folio_address()`, `folio_get()`, `folio_put()` |
| `include/linux/page_ref.h` | `folio_ref_count()`, `folio_try_get()` |
| `include/linux/pagemap.h` | `filemap_alloc_folio()`, `filemap_grab_folio()`, `readahead_folio()`, `filemap_add_folio()` |
| `include/linux/swap.h` | `folio_add_lru()`, `folio_add_lru_vma()` |
| `mm/folio-compat.c` | Page-API shims that delegate to folio functions |

---

## Why folios exist

### The compound page problem

`struct page` was designed for order-0 (single, 4KB) pages. Huge pages were bolted on later using the *compound page* mechanism: a contiguous group of pages is allocated where the first page is the *head* and every subsequent page is a *tail*.

Tails encode a back-pointer to the head in `page->compound_head` with the LSB set as a tag. Code that receives an arbitrary `struct page *` must therefore constantly ask: is this a head or a tail? If it is a tail, dereference the back-pointer first. Get it wrong and you silently corrupt the head's reference count, flags, or mapping pointer.

The result is a pervasive pattern:

```c
/* Old-style: every caller has to do this dance */
page = compound_head(page);
```

This is error-prone, invisible to the type system, and scattered across thousands of call sites.

### What a folio is

A `struct folio` is a first-class kernel object representing a **physically, virtually, and logically contiguous power-of-two-aligned set of bytes**. It is always at least `PAGE_SIZE` in size. The key guarantee is: a pointer to a `struct folio` is always a pointer to the *head*. There are no tail folios.

- An order-0 folio is a single 4KB page.
- An order-N folio is 2^N physically contiguous pages (2^N × `PAGE_SIZE` bytes).
- The size is encoded in the object itself via `folio_order()`, not inferred from context.

`struct folio` was introduced by Matthew Wilcox starting in Linux 5.16 (2022) and the conversion has been ongoing in every release since.

---

## struct folio

The definition lives in `include/linux/mm_types.h`:

```c
struct folio {
    /* private: don't document the anon union */
    union {
        struct {
            memdesc_flags_t flags;
            union {
                struct list_head lru;
                struct {
                    void *__filler;
                    unsigned int mlock_count;
                };
                struct dev_pagemap *pgmap;
            };
            struct address_space *mapping;
            union {
                pgoff_t index;
                unsigned long share;
            };
            union {
                void *private;
                swp_entry_t swap;
            };
            atomic_t _mapcount;
            atomic_t _refcount;
            /* ... CONFIG_MEMCG, WANT_PAGE_VIRTUAL, etc. */
        };
        struct page page;   /* union at offset 0 */
    };
    /* second and third page slots: large-folio metadata */
    union { struct { ... }; struct page __page_1; };
    union { struct { ... }; struct page __page_2; };
    union { struct { ... }; struct page __page_3; };
};
```

The critical design point: `struct page page` is the **first member of the anonymous union**, at offset 0. A `struct folio *` cast to `struct page *` is always the head page. The kernel enforces this with compile-time `static_assert` calls immediately after the struct definition:

```c
#define FOLIO_MATCH(pg, fl) \
    static_assert(offsetof(struct page, pg) == offsetof(struct folio, fl))
FOLIO_MATCH(flags,      flags);
FOLIO_MATCH(mapping,    mapping);
FOLIO_MATCH(_refcount,  _refcount);
/* ... */
```

If the layout ever drifts, the build breaks.

### Size and order accessors

These are all in `include/linux/mm.h`:

```c
/* Allocation order: 0 for a single page, N for 2^N pages */
static inline unsigned int folio_order(const struct folio *folio);

/* Number of struct pages spanned by this folio: 1 << folio_order() */
static inline unsigned long folio_nr_pages(const struct folio *folio);

/* Total byte size: PAGE_SIZE << folio_order() */
static inline size_t folio_size(const struct folio *folio);

/* Base-2 log of byte size: PAGE_SHIFT + folio_order() */
static inline unsigned int folio_shift(const struct folio *folio);
```

For order-0 (the common case), `folio_order()` returns 0 without dereferencing any extra fields — the `folio_test_large()` check short-circuits immediately.

---

## page ↔ folio conversion

### page_folio() — page to its owning folio

Defined in `include/linux/page-flags.h`:

```c
#define page_folio(p)   (_Generic((p),                          \
    const struct page *: (const struct folio *)_compound_head(p), \
    struct page *:       (struct folio *)_compound_head(p)))
```

This is a `_Generic` macro so it preserves const-correctness. `_compound_head()` follows the `compound_head` pointer if the LSB is set (tail page) or returns the page itself if it is already a head. The result is always a head page cast to `struct folio *`.

!!! note "No-reference race"
    The kernel documentation notes: if the caller does not already hold a reference, `page_folio()` can race with a folio split. Always verify that the folio still contains the page after acquiring a reference.

### folio_page() — nth page within a folio

```c
#define folio_page(folio, n)    (&(folio)->page + (n))
```

Simple pointer arithmetic. `folio_page(folio, 0)` is the head page; `folio_page(folio, folio_nr_pages(folio) - 1)` is the last page. No bounds checking is performed — the caller is assumed to hold a reference.

### folio_file_page() — page for a given file index

When a large folio spans multiple page-cache indices, `folio_file_page()` maps a file offset to the correct sub-page:

```c
/* include/linux/pagemap.h */
static inline struct page *folio_file_page(struct folio *folio, pgoff_t index);
```

### folio_pfn() and folio_address()

```c
/* Page Frame Number of the first page in the folio */
static inline unsigned long folio_pfn(const struct folio *folio);

/* Kernel virtual address (direct map) of the folio */
static inline void *folio_address(const struct folio *folio);
```

The symmetric `pfn_folio(pfn)` converts a PFN back to a folio:

```c
static inline struct folio *pfn_folio(unsigned long pfn)
{
    return page_folio(pfn_to_page(pfn));
}
```

---

## Reference counting

### The model

The reference count lives in the folio (head page) in `_refcount`. Tail pages have no independent refcount. All reference operations go through the folio.

### folio_get() and folio_put()

```c
/* include/linux/mm.h */

/* Increment refcount — requires a reference already held */
static inline void folio_get(struct folio *folio);

/* Decrement refcount — frees the folio when it reaches zero */
static inline void folio_put(struct folio *folio);
```

`get_page()` and `put_page()` still exist but are wrappers:

```c
static inline void get_page(struct page *page)
{
    struct folio *folio = page_folio(page);
    /* ... */
    folio_get(folio);
}

static inline void put_page(struct page *page)
{
    struct folio *folio = page_folio(page);
    folio_put(folio);
}
```

### folio_ref_count()

```c
/* include/linux/page_ref.h */
static inline int folio_ref_count(const struct folio *folio);
```

Returns the raw reference count. The kernel documentation warns not to access `_refcount` directly; always use this accessor.

### folio_try_get()

Use this when you do not already hold a reference and need to speculatively acquire one:

```c
/* include/linux/page_ref.h */
static inline bool folio_try_get(struct folio *folio);
```

Returns `true` if the reference was acquired, `false` if the folio was already at zero (freed or frozen for splitting/migration). This is the folio equivalent of the old `get_page_unless_zero()`.

!!! warning "folio_get() vs folio_try_get()"
    Use `folio_get()` only when you already hold a reference (e.g., you received the folio from the page cache with a lock held). Use `folio_try_get()` when you found the folio pointer through a data structure and need to pin it before the lock is acquired.

---

## Where folios are used today

### Page cache

`struct address_space` stores its cached pages in an XArray (`i_pages`). The XArray entries are `struct folio *` pointers. All modern page-cache lookup paths return folios:

```c
/* Look up — returns a locked folio, creates one if absent */
static inline struct folio *filemap_grab_folio(
    struct address_space *mapping, pgoff_t index);

/* Low-level lookup/creation with flags */
struct folio *__filemap_get_folio(struct address_space *mapping,
    pgoff_t index, fgf_t fgf_flags, gfp_t gfp);

/* Insert a folio into the page cache and the LRU */
int filemap_add_folio(struct address_space *mapping,
    struct folio *folio, pgoff_t index, gfp_t gfp);
```

### Readahead

The `->readahead` address space operation receives a `struct readahead_control *`. Drivers and filesystems that have been converted call `readahead_folio()` in a loop:

```c
/* include/linux/pagemap.h */
static inline struct folio *readahead_folio(struct readahead_control *ractl);
```

Each call returns the next folio to fill and advances the control structure by `folio_nr_pages()` pages.

### Writeback

The writeback path uses folio-native operations. `mm/folio-compat.c` contains the shims that map old page-based APIs onto their folio equivalents:

```c
/* These page-API functions are compatibility shims (folio-compat.c) */
void end_page_writeback(struct page *page)  /* → folio_end_writeback() */
bool set_page_dirty(struct page *page)      /* → folio_mark_dirty() */
void mark_page_accessed(struct page *page)  /* → folio_mark_accessed() */
```

The comment at the top of `folio-compat.c` is explicit: *"All of the callers of these functions should be converted to use folios eventually."*

### LRU lists

```c
/* include/linux/swap.h */
void folio_add_lru(struct folio *folio);
void folio_add_lru_vma(struct folio *folio, struct vm_area_struct *vma);
```

LRU accounting is per-folio. A large folio counts as `folio_nr_pages()` pages on the LRU, but it is a single eviction unit — the kernel cannot partially evict a folio.

### Filesystem adoption

Most in-tree filesystems have converted their `->readahead`, `->read_folio`, and `->writepages` methods. The address space operations struct (`struct address_space_operations`) now carries folio-native slots: `dirty_folio`, `migrate_folio`, `error_remove_folio`. Filesystems that have not yet converted fall back to compatibility wrappers; the conversion effort is ongoing.

---

## Large folios

An order-N folio with N ≥ 1 is a *large folio*. `folio_test_large()` returns true for these:

```c
/* include/linux/page-flags.h */
static inline bool folio_test_large(const struct folio *folio);
```

### Allocation

For page-cache use, allocate via `filemap_alloc_folio()`:

```c
/* include/linux/pagemap.h */
#define filemap_alloc_folio(gfp, order, mapping) \
    alloc_hooks(filemap_alloc_folio_noprof(gfp, order, mapping))
```

For generic kernel use, `folio_alloc()` (in `include/linux/gfp.h`) wraps the buddy allocator:

```c
#define folio_alloc(gfp, order) \
    alloc_hooks(folio_alloc_noprof(gfp, order))
```

### File-backed large folios and TLB

When a page-cache folio spans multiple PMD-size-aligned pages, fewer page-table entries are needed to map it. For workloads that read or mmap large files sequentially, large folios reduce:

- **Page fault count**: one fault populates the whole folio.
- **TLB pressure**: contiguous physical pages can be covered by a single PMD entry if alignment permits.
- **Writeback overhead**: one `writepages` call can submit the whole folio as a single I/O.

The maximum order for page-cache folios is governed by `MAX_PAGECACHE_ORDER`, which is `min(MAX_XAS_ORDER, PREFERRED_MAX_PAGECACHE_ORDER)`. On most 64-bit configs `PREFERRED_MAX_PAGECACHE_ORDER` is `HPAGE_PMD_ORDER` (order 9, 2MB), matching the PMD size.

Filesystems advertise their supported folio order range through:

```c
/* include/linux/pagemap.h */
static inline void mapping_set_folio_order_range(
    struct address_space *mapping,
    unsigned int min, unsigned int max);
```

### Relation to mTHP

Large folios in the page cache are the file-backed counterpart to multi-size THP (mTHP) for anonymous memory. See [mTHP](mthp.md) for the anonymous side. The key distinction: file-backed large folios are managed by the page cache and `struct address_space`; anonymous large folios are managed by the THP machinery and `struct vm_area_struct`.

---

## The conversion in progress

### The pattern: folio-compat.c

`mm/folio-compat.c` is the canonical example of how the conversion proceeds. Each function in that file has the same structure:

```c
/* Old page-based API — still exported for unconverted callers */
void unlock_page(struct page *page)
{
    return folio_unlock(page_folio(page));
}
EXPORT_SYMBOL(unlock_page);
```

The page function converts to a folio and delegates. As callers are converted to call `folio_unlock()` directly, the page shim eventually has no callers and can be removed.

### Naming convention

The kernel has adopted a consistent naming convention:

| API style | Naming pattern | Example |
|-----------|---------------|---------|
| Folio-native (new) | `folio_*` | `folio_lock()`, `folio_mark_dirty()` |
| Page-based (legacy) | original names | `lock_page()`, `set_page_dirty()` |
| Conversion helper | `page_folio()` | `page_folio(page)` |

If a function name starts with `folio_`, it takes a `struct folio *` and operates on the whole folio. If it takes a `struct page *`, check `mm/folio-compat.c` — it is probably a shim.

### How to tell if a function has been converted

1. Check the parameter type: `struct folio *` means converted.
2. Look in `mm/folio-compat.c`: if the old name appears there, the implementation has moved to a `folio_*` counterpart.
3. Search the address space operations struct (`struct address_space_operations` in `include/linux/fs.h`): slots named `*_folio` have been converted; slots still named `*_page` have not.

---

## Writing folio-aware code

### The decision rule

| You are working with… | Use |
|----------------------|-----|
| Page cache (file data) | Folio APIs throughout |
| LRU tracking | `folio_add_lru()` |
| Writeback state | `folio_mark_dirty()`, `folio_start_writeback()`, `folio_end_writeback()` |
| Raw page allocation (`alloc_pages`) | Returns `struct page *`; call `page_folio()` immediately |
| Existing code that passes `struct page *` | Convert at the boundary; hold a folio reference before touching flags |

### Typical folio-aware read path (sketch)

```c
struct folio *folio;

/* 1. Look up or create a folio in the page cache */
folio = filemap_grab_folio(mapping, index);
if (IS_ERR(folio))
    return PTR_ERR(folio);

/* folio is now locked and referenced */

/* 2. Check if it's already up to date */
if (folio_test_uptodate(folio)) {
    folio_unlock(folio);
    return 0;
}

/* 3. Submit I/O for the whole folio */
/* ... filesystem-specific read ... */

/* 4. Mark it up to date and release */
folio_mark_uptodate(folio);
folio_unlock(folio);
folio_put(folio);
```

### Allocating a folio directly

When you need a folio outside the page cache (e.g., a private kernel buffer):

```c
/* Allocate a single-page (order-0) folio */
struct folio *folio = folio_alloc(GFP_KERNEL, 0);
if (!folio)
    return -ENOMEM;

/* Use it ... */

folio_put(folio);   /* drops the allocator's reference; frees if zero */
```

### Do not call folio_get() without a prior reference

```c
/* WRONG: folio pointer from a data structure with no lock held */
folio_get(folio);   /* may race with free */

/* RIGHT: speculatively acquire a reference */
if (!folio_try_get(folio))
    return -ENOENT;  /* folio was freed before we got it */
```

---

## Reference summary

| Function | Header | Description |
|----------|--------|-------------|
| `page_folio(page)` | `page-flags.h` | Convert any page to its owning folio |
| `folio_page(folio, n)` | `page-flags.h` | Get the nth page within a folio |
| `folio_order(folio)` | `mm.h` | Allocation order (0 for single page) |
| `folio_nr_pages(folio)` | `mm.h` | Number of pages: `1 << folio_order()` |
| `folio_size(folio)` | `mm.h` | Byte size: `PAGE_SIZE << folio_order()` |
| `folio_pfn(folio)` | `mm.h` | PFN of the first page |
| `folio_address(folio)` | `mm.h` | Kernel virtual address |
| `folio_get(folio)` | `mm.h` | Increment refcount (requires prior ref) |
| `folio_put(folio)` | `mm.h` | Decrement refcount; frees at zero |
| `folio_try_get(folio)` | `page_ref.h` | Speculatively acquire a reference |
| `folio_ref_count(folio)` | `page_ref.h` | Raw reference count |
| `folio_test_large(folio)` | `page-flags.h` | True for order ≥ 1 folios |
| `folio_add_lru(folio)` | `swap.h` | Add folio to the LRU list |
| `filemap_grab_folio(mapping, index)` | `pagemap.h` | Look up or create a page-cache folio |
| `filemap_alloc_folio(gfp, order, mapping)` | `pagemap.h` | Allocate a page-cache folio |
| `readahead_folio(ractl)` | `pagemap.h` | Get next folio from a readahead batch |
