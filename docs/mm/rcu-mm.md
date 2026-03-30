# RCU in Memory Management

> How Read-Copy-Update lets page faults find VMAs without taking a lock

## Key Source Files

| File | Purpose |
|------|---------|
| `mm/mmap_lock.c` | `lock_vma_under_rcu()`, `vma_start_read()`, `vma_end_write_all()` |
| `mm/vma_init.c` | `vm_area_alloc()`, `vm_area_free()`, `SLAB_TYPESAFE_BY_RCU` slab setup |
| `lib/maple_tree.c` | `ma_free_rcu()`, `mt_free_walk()` — RCU-deferred node freeing |
| `include/linux/mm_types.h` | `struct vm_area_struct` — `vm_freeptr`, `vm_lock_seq`, `vm_refcnt` |
| `include/linux/rcupdate.h` | `rcu_read_lock()`, `rcu_dereference()`, `call_rcu()`, `kfree_rcu()`, `synchronize_rcu()` |
| `mm/mmu_notifier.c` | SRCU-protected notifier list; `srcu_read_lock()` / `srcu_read_unlock()` |
| `mm/filemap.c` | `filemap_get_folios_contig()`, `filemap_get_folios_tag()` — RCU page-cache iteration |
| `arch/x86/mm/fault.c` | Page fault entry: `lock_vma_under_rcu()` fast path before `lock_mm_and_find_vma()` |

---

## Why RCU in memory management

Every process's virtual address space is a collection of VMAs (Virtual Memory Areas) stored in the maple tree at `mm->mm_mt`. Every page fault needs to find the right VMA for the faulting address before it can install a page table entry. Until Linux 6.4 this lookup always required taking `mmap_lock` for read.

`mmap_lock` is a per-`mm_struct` read-write semaphore. Read locks are shared, so parallel faults in the same process can proceed together — up to the point where any writer (an `mmap()`, `munmap()`, `mprotect()`, or `mremap()` call in any thread) takes the write lock and **blocks every concurrent fault**. On systems with many threads all faulting simultaneously, even brief writer windows serialise large bursts of fault handling.

The problem is also structural: `mmap_lock` is coarse-grained, guarding the entire VMA tree. Two threads faulting into completely separate memory regions still contend on it.

RCU (Read-Copy-Update) breaks this bottleneck. The maple tree is RCU-safe — its nodes are freed via `call_rcu()` rather than immediately. This means a reader holding `rcu_read_lock()` can walk the tree and access its nodes safely, knowing no node it has already observed can be freed under it. Combined with per-VMA reference counting, the common case — finding a VMA that is not being modified right now — becomes entirely lock-free from the reader's perspective.

---

## RCU basics

RCU is a synchronisation mechanism optimised for read-heavy workloads. The core contract:

- **Readers** call `rcu_read_lock()` before accessing RCU-protected data and `rcu_read_unlock()` when done. The reader section cannot sleep (it disables preemption in non-PREEMPT kernels, holds a special token in PREEMPT_RCU).
- **Readers dereference pointers** with `rcu_dereference()`, which inserts the appropriate memory barrier to prevent the compiler or CPU from speculating loads of dependent data before the pointer itself is loaded.
- **Writers** update data using `rcu_assign_pointer()` to publish a new pointer, then wait for all current readers to finish their RCU read sections before freeing the old version. This waiting period is called a **grace period**.

There are two ways to wait for a grace period:

```c
/* Synchronous: blocks the caller until all readers have completed */
synchronize_rcu();

/* Asynchronous: schedules a callback for after the grace period */
call_rcu(&obj->rcu_head, my_free_function);

/* Convenience wrapper: frees the object after the grace period */
kfree_rcu(ptr, rcu_head_field);
```

The key insight is that `synchronize_rcu()` can take milliseconds — readers across all CPUs must each finish their current RCU read section. `call_rcu()` and `kfree_rcu()` return immediately, deferring the free to an RCU callback thread. Memory management code chooses between them based on whether it can afford to wait.

---

## VMA lookup under RCU

### The maple tree is RCU-safe

The maple tree (`mm->mm_mt`) stores VMAs keyed on address range. When a VMA is removed or a tree node is replaced, the old node is not freed immediately. Instead, `ma_free_rcu()` in `lib/maple_tree.c` calls `kfree_rcu(node, rcu)`, which defers the free until after a grace period:

```c
/* lib/maple_tree.c */
static void ma_free_rcu(struct maple_node *node)
{
    WARN_ON(node->parent != ma_parent_ptr(node));
    kfree_rcu(node, rcu);
}
```

Readers holding `rcu_read_lock()` can therefore walk tree nodes safely — any node they see is guaranteed to remain allocated (though not necessarily in the tree) until after the read section ends.

### `lock_vma_under_rcu()`

`lock_vma_under_rcu()` in `mm/mmap_lock.c` is the fast-path VMA lookup used by page faults since v6.4. It combines an RCU read section for the maple tree walk with a per-VMA reference count to stabilise the found VMA:

```c
/* mm/mmap_lock.c */
struct vm_area_struct *lock_vma_under_rcu(struct mm_struct *mm,
                                          unsigned long address)
{
    MA_STATE(mas, &mm->mm_mt, address, address);
    struct vm_area_struct *vma;

retry:
    rcu_read_lock();
    vma = mas_walk(&mas);           /* RCU-protected maple tree walk */
    if (!vma) {
        rcu_read_unlock();
        goto inval;
    }

    vma = vma_start_read(mm, vma);  /* attempt per-VMA read lock */
    if (IS_ERR_OR_NULL(vma)) {
        if (PTR_ERR(vma) == -EAGAIN)
            goto retry;             /* VMA was detached, retry */
        goto inval;                 /* rcu_read_unlock() already called */
    }

    rcu_read_unlock();

    /* Validate that the locked VMA actually covers the address */
    if (unlikely(address < vma->vm_start || address >= vma->vm_end)) {
        vma_end_read(vma);
        goto inval;
    }
    return vma;   /* Stable, per-VMA-locked VMA, no mmap_lock held */

inval:
    count_vm_vma_lock_event(VMA_LOCK_ABORT);
    return NULL;
}
```

!!! note "IMPORTANT: `vma_start_read()` may release the RCU lock on failure"
    The comment in the source is explicit: when `vma_start_read()` returns an error, it has already called `rcu_read_unlock()`. Callers must not call `rcu_read_unlock()` again in error paths after `vma_start_read()` fails. This asymmetry is a common source of confusion when reading the code.

### `vma_start_read()`

`vma_start_read()` (also in `mm/mmap_lock.c`) is the per-VMA read lock acquisition. It uses `vm_lock_seq` and `mm_lock_seq` to detect whether the VMA is currently being written:

```c
/* mm/mmap_lock.c */
static inline struct vm_area_struct *vma_start_read(struct mm_struct *mm,
                                                    struct vm_area_struct *vma)
{
    /* Fast bail-out: if lock sequences match, VMA is write-locked */
    if (READ_ONCE(vma->vm_lock_seq) == READ_ONCE(mm->mm_lock_seq.sequence)) {
        vma = NULL;
        goto err;   /* also calls rcu_read_unlock() */
    }

    /* Increment vm_refcnt with acquire fence */
    if (unlikely(!__refcount_inc_not_zero_limited_acquire(&vma->vm_refcnt,
                                                          &oldcnt,
                                                          VM_REFCNT_LIMIT))) {
        vma = oldcnt ? NULL : ERR_PTR(-EAGAIN);
        goto err;
    }

    /* Re-check lock sequence under the reference count */
    if (unlikely(vma->vm_lock_seq == raw_read_seqcount(&mm->mm_lock_seq))) {
        vma_refcount_put(vma);
        vma = NULL;
        goto err;
    }
    return vma;
    ...
}
```

The logic:

1. If `vma->vm_lock_seq == mm->mm_lock_seq.sequence`, the VMA is currently write-locked — bail.
2. Increment `vm_refcnt` with acquire semantics to prevent loads of VMA fields from being reordered before the count increment.
3. Re-check `vm_lock_seq` under the reference count, because the sequence number could have changed between step 1 and step 2.

For the full per-VMA lock state machine and the write-side (`vma_end_write_all()`), see [Per-VMA Locks](per-vma-locks.md).

### The page fault fast path (x86)

The architecture fault handler in `arch/x86/mm/fault.c` tries the RCU path first:

```c
/* arch/x86/mm/fault.c */
vma = lock_vma_under_rcu(mm, address);
if (!vma)
    goto lock_mmap;   /* fall back to mmap_lock */

if (unlikely(access_error(error_code, vma))) {
    bad_area_access_error(...);
    count_vm_vma_lock_event(VMA_LOCK_SUCCESS);
    return;
}
fault = handle_mm_fault(vma, address, flags | FAULT_FLAG_VMA_LOCK, regs);
if (!(fault & (VM_FAULT_RETRY | VM_FAULT_COMPLETED)))
    vma_end_read(vma);
...
lock_mmap:
    vma = lock_mm_and_find_vma(mm, address, regs);  /* slow path */
```

The `FAULT_FLAG_VMA_LOCK` flag tells `handle_mm_fault()` which lock is held. ARM64, ARM, PowerPC, s390, LoongArch, and RISC-V all implement the same pattern.

---

## `struct vm_area_struct` and RCU

### Allocation: `SLAB_TYPESAFE_BY_RCU`

`vm_area_struct` objects are allocated from a dedicated slab cache (`vm_area_cachep`) created in `mm/vma_init.c`:

```c
/* mm/vma_init.c */
vm_area_cachep = kmem_cache_create("vm_area_struct",
        sizeof(struct vm_area_struct), &args,
        SLAB_HWCACHE_ALIGN | SLAB_PANIC | SLAB_TYPESAFE_BY_RCU |
        SLAB_ACCOUNT);
```

`SLAB_TYPESAFE_BY_RCU` is the key flag. It means:

- Objects are **not freed immediately** to the system when released; instead they are kept until after a grace period.
- Critically, the slab allocator may **reuse** a freed object for a new allocation once the grace period elapses, but it will not return the memory to the OS or a different slab.
- A reader holding `rcu_read_lock()` can safely read from a `vm_area_struct` pointer it obtained from the maple tree — the struct's memory will remain allocated (though possibly reused) until the read section ends.

This differs from `call_rcu()` with a free callback: with `SLAB_TYPESAFE_BY_RCU`, the type of the object (`struct vm_area_struct`) is preserved across the grace period. Readers must still validate that the VMA they found is still the one they expected (via `vma_start_read()`).

`vm_area_free()` in `mm/vma_init.c` is the public VMA destruction function:

```c
/* mm/vma_init.c */
void vm_area_free(struct vm_area_struct *vma)
{
    vma_assert_detached(vma);
    vma_numab_state_free(vma);
    free_anon_vma_name(vma);
    vma_pfnmap_track_ctx_release(vma);
    kmem_cache_free(vm_area_cachep, vma);  /* returns to SLAB_TYPESAFE_BY_RCU slab */
}
```

The slab, not the caller, handles the grace period.

### Fields accessible under RCU (before `vma_start_read()`)

The comment in `include/linux/mm_types.h` at the `struct vm_area_struct` definition states:

> Only explicitly marked struct members may be accessed by RCU readers before getting a stable reference.

Fields that an unstable RCU reader (before `vma_start_read()` succeeds) may access:

| Field | Why stable |
|-------|-----------|
| `vm_start`, `vm_end` | Unioned with `vm_freeptr`; stable once the VMA is in the maple tree |
| `vm_mm` | Explicitly documented as accessible to unstable RCU readers |
| `vm_lock_seq` | Read with `READ_ONCE()` in `vma_start_read()` for the optimistic check |
| `vm_refcnt` | Accessed atomically throughout the locking protocol |

Fields that are **not** safe without a successful `vma_start_read()` (per-VMA read lock):

- `vm_flags` — may be changing due to `mprotect()`
- `vm_file`, `vm_pgoff`, `anon_vma` — may change on unmap or remap
- `vm_ops`, `vm_private_data` — tied to the underlying file/device

!!! warning "Field reuse via `vm_freeptr`"
    `vm_start` and `vm_end` share a union with `vm_freeptr`, the SLAB free-list pointer. When a VMA is freed back to the slab, the allocator may write to `vm_freeptr`, clobbering `vm_start`/`vm_end`. This is exactly why `vma_start_read()` validates address bounds *after* acquiring the per-VMA lock: if the lock fails, the struct may already be in an undefined state.

---

## Page table walks under RCU

### `follow_page_mask()` and `vma_pgtable_walk_begin()`

`follow_page_mask()` in `mm/gup.c` looks up a physical page for a user virtual address (used by `get_user_pages()` and friends). It wraps the page table walk with:

```c
/* mm/gup.c */
static struct page *follow_page_mask(struct vm_area_struct *vma,
                                     unsigned long address, unsigned int flags,
                                     unsigned long *page_mask)
{
    vma_pgtable_walk_begin(vma);
    ...
    page = follow_p4d_mask(vma, address, pgd, flags, page_mask);
    vma_pgtable_walk_end(vma);
    return page;
}
```

`vma_pgtable_walk_begin()` in `mm/memory.c` acquires a hugetlb VMA read lock if the VMA is a HugeTLB mapping:

```c
/* mm/memory.c */
void vma_pgtable_walk_begin(struct vm_area_struct *vma)
{
    if (is_vm_hugetlb_page(vma))
        hugetlb_vma_lock_read(vma);
}

void vma_pgtable_walk_end(struct vm_area_struct *vma)
{
    if (is_vm_hugetlb_page(vma))
        hugetlb_vma_unlock_read(vma);
}
```

For normal (non-hugetlb) VMAs these are no-ops; the protection comes from the page table lock (`pte_offset_map_lock()`) and the fact that page table pages are reference-counted via `mm->pgtables_bytes` tracking in `mm_inc_nr_ptes()` / `mm_dec_nr_ptes()`.

### Page table page lifetime

Page table pages (the physical pages that *hold* PTEs) are tracked by:

- `mm_inc_nr_ptes()` / `mm_dec_nr_ptes()` on alloc and free, updating `mm->pgtables_bytes`.
- A `page_table_lock` spinlock in `mm_struct` for some global page table operations.
- Per-page-table spinlocks obtained via `pte_offset_map_lock()` for PTE-level operations.

When `follow_page_pte()` walks to the PTE level, it uses `pte_offset_map_lock()` to take the per-page-table spinlock, preventing the page table page from being freed (via `mm_dec_nr_ptes()`) while the PTE is being read.

RCU alone does not protect page table pages from being freed. The layered design is: RCU protects the *VMA* (so the fault handler can find the right VMA without `mmap_lock`); the per-VMA lock then stabilises the VMA; and normal page table locking (`pte_offset_map_lock()`) protects the PTE contents.

---

## MMU notifiers and SRCU

MMU notifiers allow subsystems like KVM and RDMA to be informed when the kernel is about to invalidate page table entries. KVM uses this to flush guest physical → host virtual mappings whenever the host tears down or remaps a region.

### The notifier list uses SRCU, not plain RCU

The mmu notifier list in `mm/mmu_notifier.c` uses **SRCU (Sleepable RCU)** rather than classic RCU. The key difference: SRCU permits sleeping inside the read-side critical section, which notifier callbacks (like KVM's TLB flush path) may need.

```c
/* mm/mmu_notifier.c */
DEFINE_STATIC_SRCU(srcu);   /* one global SRCU domain for all MMs */
```

When the kernel needs to notify subscribers (for example, during page table teardown in `unmap_vmas()`):

```c
/* mm/mmu_notifier.c — simplified */
int __mmu_notifier_invalidate_range_start(struct mmu_notifier_range *range)
{
    int id = srcu_read_lock(&srcu);
    hlist_for_each_entry_rcu(subscription, &subscriptions->list, hlist,
                             srcu_read_lock_held(&srcu)) {
        subscription->ops->invalidate_range_start(subscription, range);
    }
    srcu_read_unlock(&srcu, id);
    ...
}
```

The iteration uses `hlist_for_each_entry_rcu()`, which is safe because notifier registrations and unregistrations modify the list under `mmap_write_lock()` + SRCU synchronisation. Readers only need `srcu_read_lock()`.

### `mmu_notifier_get()` and `mmu_notifier_put()`

```c
/* include/linux/mmu_notifier.h */
static inline struct mmu_notifier *
mmu_notifier_get(const struct mmu_notifier_ops *ops, struct mm_struct *mm)
{
    struct mmu_notifier *ret;
    mmap_write_lock(mm);
    ret = mmu_notifier_get_locked(ops, mm);   /* calls __mmu_notifier_register() */
    mmap_write_unlock(mm);
    return ret;
}

void mmu_notifier_put(struct mmu_notifier *subscription);
```

`mmu_notifier_get()` requires `mmap_write_lock` — registration modifies the notifier list and must be serialised. `mmu_notifier_put()` uses SRCU to defer the final cleanup until all in-progress `invalidate_range_start` callbacks have completed.

### Why this matters for KVM

Without SRCU, KVM's invalidation callback would have to complete without sleeping, which is impractical for cross-hypervisor TLB flushes or IPI-based shootdowns that need to synchronize with vCPU threads. SRCU allows KVM to sleep inside `invalidate_range_start()` while still being protected against concurrent list modification.

---

## Folio and page cache RCU

The page cache maps file offsets to folios (contiguous groups of pages) using an XArray (`mapping->i_pages`). The XArray is internally RCU-safe: its `xa_head` pointer is `__rcu`-annotated and node slots are RCU-protected.

### RCU lookups in `filemap.c`

Several functions iterate the page cache under `rcu_read_lock()` and use `folio_try_get()` to atomically acquire a reference before the RCU section ends:

```c
/* mm/filemap.c — filemap_get_folios_contig() */
unsigned filemap_get_folios_contig(struct address_space *mapping,
        pgoff_t *start, pgoff_t end, struct folio_batch *fbatch)
{
    XA_STATE(xas, &mapping->i_pages, *start);
    rcu_read_lock();

    for (folio = xas_load(&xas); folio && xas.xa_index <= end;
            folio = xas_next(&xas)) {
        if (xas_retry(&xas, folio))
            continue;
        if (xa_is_value(folio))   /* swap/shadow entry */
            goto update_start;
        if (!folio_try_get(folio))
            goto retry;
        if (unlikely(folio != xas_reload(&xas)))
            goto put_folio;       /* folio was replaced while we grabbed it */
        folio_batch_add(fbatch, folio);
        ...
    }
    rcu_read_unlock();
    ...
}
```

The pattern is:

1. `rcu_read_lock()` — prevents XArray node freeing.
2. `xas_load()` / `xas_next()` — walk under RCU protection.
3. `folio_try_get()` — atomically increment the folio's reference count; returns false if the count was already zero (folio being freed).
4. `xas_reload()` — verify the XArray slot still points to the same folio (it could have been replaced by a new folio between `xas_next()` and `folio_try_get()`).
5. `rcu_read_unlock()` — the folio is now held by a reference count and safe to use outside the RCU section.

`filemap_get_folio()` (single-folio lookup) ultimately calls `filemap_get_entry()` which uses the same `rcu_read_lock()` + `folio_try_get()` + `xas_reload()` sequence.

### Why not just a spinlock?

The page cache is read far more often than it is modified. Under load, a spinlock on every lookup would bounce the cache line across CPUs. RCU with `folio_try_get()` allows all CPUs to read the XArray concurrently, at the cost of slightly more complex retry logic on the rare occasions a folio is being evicted simultaneously.

---

## Grace period costs

### `synchronize_rcu()` is slow

`synchronize_rcu()` blocks until every CPU has passed through a quiescent state (a point where no RCU read section is active on that CPU). On a large NUMA system this can take several milliseconds.

Memory management code avoids synchronous grace periods on performance-critical paths:

| Operation | Mechanism | Reason |
|-----------|-----------|--------|
| Maple tree node removal | `kfree_rcu(node, rcu)` via `ma_free_rcu()` | VMA unmap must be fast |
| VMA slab free | `SLAB_TYPESAFE_BY_RCU` (implicit grace period in slab) | Avoids per-VMA `call_rcu` overhead |
| MMU notifier unregister | `synchronize_srcu(&srcu)` | Must ensure all in-flight callbacks are done before freeing the notifier |
| `mmap_write_unlock()` | Calls `vma_end_write_all()` → `mm_lock_seqcount_end()` | Invalidates all per-VMA read locks by incrementing `mm_lock_seq`; no grace period needed |

### The hidden cost in `mmap_write_lock()`

When `mmap_write_lock()` acquires the write side of `mmap_lock`, it does *not* itself wait for an RCU grace period — but the write lock will block until all current `mmap_read_lock()` holders release, and those read holders may themselves be sitting inside `rcu_read_lock()` sections in the fault path. Effectively, the write lock waits for in-progress fault handling to complete.

When `mmap_write_unlock()` is called, it calls `vma_end_write_all()` which increments `mm_lock_seq`, atomically invalidating all outstanding per-VMA read locks. Any thread that subsequently calls `vma_start_read()` will see the updated sequence number and fall back to the `mmap_lock` slow path for the next fault.

---

## Debugging RCU issues in mm

### `CONFIG_PROVE_RCU`

Enable `CONFIG_PROVE_RCU` (implied by `CONFIG_PROVE_LOCKING`) to get lockdep coverage of RCU usage. With this option, `RCU_LOCKDEP_WARN()` calls emit warnings when RCU-annotated pointers are accessed outside a valid RCU read section.

The mm code uses `RCU_LOCKDEP_WARN` liberally:

```c
/* mm/mmap_lock.c — vma_start_read() */
RCU_LOCKDEP_WARN(!rcu_read_lock_held(), "no rcu lock held");

/* mm/mmap_lock.c — lock_next_vma() */
RCU_LOCKDEP_WARN(!rcu_read_lock_held(), "no rcu read lock held");
```

### `lockdep_assert_in_rcu_read_lock()`

`include/linux/rcupdate.h` defines `lockdep_assert_in_rcu_read_lock()` (requires `CONFIG_PROVE_RCU`), which triggers a warning if called outside an RCU read section. Use this in new code that assumes RCU protection.

### Sparse and `__rcu` annotations

Pointer fields that are RCU-protected are annotated `__rcu` in their declarations (e.g., `void __rcu *xa_head` in `struct xarray`). Building with `sparse` (`make C=1`) will warn if such a pointer is dereferenced without `rcu_dereference()`.

### Common bugs in mm RCU code

**Sleeping inside `rcu_read_lock()`.**
Classic RCU does not permit sleeping. In the page fault path, `lock_vma_under_rcu()` holds `rcu_read_lock()` only for the maple tree walk — it releases it before calling `handle_mm_fault()`. If a code path acquires `rcu_read_lock()` and then calls something that can sleep (memory allocation, file I/O, a mutex), `CONFIG_PROVE_RCU` will fire.

```
BUG: sleeping function called from invalid context
in_atomic(): 1, irqs_disabled(): 0, ...
```

**Accessing VMA fields without a stable reference.**
Reading `vma->vm_flags` or `vma->vm_file` under only `rcu_read_lock()` (without a successful `vma_start_read()`) is incorrect — those fields may be changing concurrently. The `SLAB_TYPESAFE_BY_RCU` guarantee only means the *memory* is not freed, not that the *fields* are stable.

**Reuse confusion with `SLAB_TYPESAFE_BY_RCU`.**
Because slab objects can be reused after a grace period, a reader that obtains a `vm_area_struct *` from the maple tree and then sleeps (outside the RCU section) may wake to find the same memory now describes a completely different VMA in a different `mm`. Always validate with `vma_start_read()` — it checks `vma->vm_mm == mm` and the lock sequence numbers.

**Forgetting `vma_end_read()` on all paths.**
`vma_start_read()` increments `vm_refcnt`. Every successful return from `lock_vma_under_rcu()` must be balanced by exactly one `vma_end_read()`. Missing it leaks a reference, which eventually stalls any writer that needs to drain all readers (e.g., `munmap()`).

---

## Putting it together: a read fault on a normal VMA

```
User thread takes a page fault
│
├─ arch fault handler (e.g. arch/x86/mm/fault.c)
│   ├─ lock_vma_under_rcu(mm, address)
│   │   ├─ rcu_read_lock()
│   │   ├─ mas_walk(&mas)          → finds VMA in maple tree under RCU
│   │   ├─ vma_start_read(mm, vma) → increments vm_refcnt, validates lock seq
│   │   └─ rcu_read_unlock()       → RCU section ends; VMA stable via vm_refcnt
│   │
│   └─ handle_mm_fault(vma, address, FAULT_FLAG_VMA_LOCK, regs)
│       └─ __handle_mm_fault()
│           └─ do_fault() / do_anonymous_page() / ...
│               └─ pte_offset_map_lock()   → page table spinlock
│
└─ vma_end_read(vma)               → decrements vm_refcnt
```

No `mmap_lock` is taken in the common case. The VMA tree walk, the VMA stability, and the PTE update are each protected by the appropriate narrow-scope lock or RCU section.

---

## See also

- [Per-VMA Locks](per-vma-locks.md) — detailed coverage of `vm_lock_seq`, `vm_refcnt`, and the write-side protocol
- [Maple Tree](maple-tree.md) — the RCU-safe B-tree that stores VMAs
- [Page Tables](page-tables.md) — PTE locking, `pte_offset_map_lock()`, and page table page lifetime
- [Page Cache](page-cache.md) — XArray-based folio storage and the broader file-backed fault path
