# Per-VMA Locks

> Eliminating the mmap_lock bottleneck in page fault handling

## The mmap_lock bottleneck

Every process has a single per-`mm_struct` read-write semaphore called `mmap_lock`. Historically it was the gate for nearly every operation that touches the process's virtual memory layout:

- Page faults acquire it **for read** (shared access with other faults)
- `mmap()`, `munmap()`, `mprotect()`, `mremap()`, `brk()` acquire it **for write** (exclusive)

The read-side contention problem is subtle. Read locks in a rwsem are shared, so multiple threads faulting simultaneously should be able to proceed in parallel — and they do, until a writer shows up. A single `mmap()` or `munmap()` call in any thread takes the write lock and **blocks every concurrent page fault** in the process until the writer finishes.

For multi-threaded workloads that mix frequent faults with occasional VMA modifications (think: many worker threads faulting in new heap pages while the allocator occasionally calls `mmap()`), `mmap_lock` becomes a serialization point that caps fault throughput.

The `mmap_lock` is also coarse: it protects the entire VMA tree. If thread A is faulting in region X and thread B is faulting in region Y, they still contend on the same lock even though they are touching completely different VMAs.

## Per-VMA lock design

Per-VMA locks (merged in Linux 6.4) give each `vm_area_struct` its own lightweight lock. The page fault path tries this VMA-scoped lock first, only falling back to `mmap_lock` if the VMA is being modified concurrently.

### Lock state in the VMA

Two fields in `vm_area_struct` implement the per-VMA lock (guarded by `CONFIG_PER_VMA_LOCK`):

```c
/* In vm_area_struct (include/linux/mm_types.h) */

unsigned int vm_lock_seq;      /* sequence number, updated on each write-lock */
refcount_t vm_refcnt;          /* reference count + reader/writer state */
```

The per-`mm_struct` counterpart is:

```c
/* In mm_struct */
int mm_lock_seq;               /* bumped every time mmap_lock is write-locked */
```

A VMA is considered **unlocked** when `vma->vm_lock_seq != mm->mm_lock_seq`. Whenever the mm is write-locked (e.g. for `mmap()`), `mm_lock_seq` is incremented, which invalidates all existing per-VMA read locks simultaneously — without touching each VMA.

The `vm_refcnt` field encodes the reader count plus a special `VM_REFCNT_EXCLUDE_READERS_FLAG` bit used during write-locking and VMA detach. The detailed state machine is documented in the `vm_area_struct` definition in `include/linux/mm_types.h`.

!!! note "The sequence counter is allowed to overflow"
    The kernel comment on `vm_lock_seq` explicitly notes that overflow is acceptable. Overflow can only cause an occasional unnecessary fallback to `mmap_lock`, not a correctness failure.

### The VMA lookup: maple tree + RCU

VMA lookups during the fast fault path use the maple tree (`mm->mm_mt`, type `struct maple_tree`) under RCU protection. The maple tree is an RCU-safe B-tree that stores VMAs keyed by address range.

`lock_vma_under_rcu()` in `mm/memory.c` is the entry point:

```c
struct vm_area_struct *lock_vma_under_rcu(struct mm_struct *mm,
                                          unsigned long address)
{
    MA_STATE(mas, &mm->mm_mt, address, address);
    struct vm_area_struct *vma;

retry:
    rcu_read_lock();
    vma = mas_walk(&mas);           /* RCU-protected maple tree walk */
    if (!vma) { ... goto inval; }

    if (!vma_start_read(vma))       /* attempt per-VMA read lock */
        goto inval;                 /* lock failed (VMA changed), fall back */

    rcu_read_unlock();

    /* validate address range */
    if (address < vma->vm_start || address >= vma->vm_end) {
        vma_end_read(vma);
        goto inval;
    }
    return vma;  /* stable locked VMA, no mmap_lock held */
    ...
}
```

`vma_start_read()` checks `vma->vm_lock_seq == mm->mm_lock_seq`. If they match the VMA is currently write-locked and the function returns NULL (falls back to mmap_lock). If they don't match it increments `vm_refcnt` using an acquire fence and re-checks, establishing the read lock.

## The fault path

`handle_mm_fault()` in `mm/memory.c` is called by architecture fault handlers with either the VMA lock or `mmap_lock` held, indicated by the `FAULT_FLAG_VMA_LOCK` flag:

```c
/* mm/memory.c */
vm_fault_t handle_mm_fault(struct vm_area_struct *vma, unsigned long address,
                            unsigned int flags, struct pt_regs *regs)
{
    /*
     * By the time we get here, we already hold either the VMA lock
     * or the mmap_lock (FAULT_FLAG_VMA_LOCK tells you which).
     */
    if (unlikely(is_vm_hugetlb_page(vma)))
        ret = hugetlb_fault(vma->vm_mm, vma, address, flags);
    else
        ret = __handle_mm_fault(vma, address, flags);
    ...
}
```

The architecture-specific fault handler (e.g. `do_user_addr_fault()` on x86) first tries `lock_vma_under_rcu()`. On success it sets `FAULT_FLAG_VMA_LOCK` and calls `handle_mm_fault()`. If the RCU fast path fails (VMA modification in progress, VMA not found, or address range mismatch), it falls back to acquiring `mmap_lock` for read in the normal way.

If a fault handler inside `__handle_mm_fault()` determines it cannot proceed without `mmap_lock` — for example when it needs to retry after blocking I/O — it releases the VMA lock with `vma_end_read()` and returns `VM_FAULT_RETRY`. The caller then retakes `mmap_lock`.

## Write-locking a VMA

When a VMA must be modified (e.g. during `mprotect()`, split/merge during `mmap()`, or unmap during `munmap()`), the kernel calls `vma_start_write()`:

```c
/* mm/mmap.c and mm/memory.c — callers */
vma_start_write(vma);
```

`vma_start_write()` (in `mm/mmap_lock.c`) requires that `mmap_lock` is already held for write. It sets `vma->vm_lock_seq = mm->mm_lock_seq`, which makes `vma_start_read()` fail for this VMA until the write-lock is released and `mm_lock_seq` is bumped again.

The protocol ensures correctness: any operation that modifies a VMA must first hold `mmap_lock` write, then call `vma_start_write()`. Fault handlers that hold a per-VMA read lock are thereby excluded from seeing partial modifications.

## Operations that still require mmap_lock

Per-VMA locks only accelerate the **read** side of faults. The following operations still require `mmap_lock` for write:

| Operation | Reason |
|-----------|--------|
| `mmap()` / `munmap()` | VMA tree insertion/removal |
| `mprotect()` | VMA flags modification |
| `mremap()` | VMA address range change |
| `brk()` | Heap boundary change |
| VMA split/merge during fault | Modifies adjacent VMAs |
| `execve()` | Tears down entire address space |

`mmap_lock` for read is still used as the fallback for any fault where the per-VMA lock path fails.

## Observability

There are no sysfs knobs for per-VMA locks — the feature is always enabled when `CONFIG_PER_VMA_LOCK=y` (which is the default in kernels >= 6.4 on supported architectures).

Four vmstat-style counters track per-VMA lock activity (defined in `include/linux/vm_event_item.h`):

| Counter | Meaning |
|---------|---------|
| `VMA_LOCK_SUCCESS` | Fast path succeeded; fault handled under per-VMA lock |
| `VMA_LOCK_ABORT` | Fast path failed; fell back to `mmap_lock` |
| `VMA_LOCK_RETRY` | Fast path was retried (e.g. after a transient failure) |
| `VMA_LOCK_MISS` | VMA was detached between lookup and lock; retried |

These are readable via the standard `count_vm_vma_lock_event()` infrastructure. They appear in `/proc/vmstat` on kernels where `CONFIG_PER_VMA_LOCK` is enabled.

!!! tip "Diagnosing contention"
    If `VMA_LOCK_ABORT` is high relative to `VMA_LOCK_SUCCESS`, the workload is frequently faulting during VMA modifications. This is expected if the application calls `mmap()`/`munmap()` at high frequency from a thread that also takes heavy faults.

## Limitations and special cases

**Hugetlb faults** do not use per-VMA locks. `handle_mm_fault()` routes `VM_HUGETLB` pages through `hugetlb_fault()`, which uses its own `hugetlb_vma_lock_read()` / `hugetlb_vma_lock_write()` infrastructure — a separate locking scheme for hugetlb VMAs.

**FAULT_FLAG_RETRY_NOWAIT** cannot be combined with `FAULT_FLAG_VMA_LOCK`. The kernel asserts this in `sanitize_fault_flags()`:

```c
/* mm/memory.c */
if (WARN_ON_ONCE((*flags &
        (FAULT_FLAG_VMA_LOCK | FAULT_FLAG_RETRY_NOWAIT)) ==
        (FAULT_FLAG_VMA_LOCK | FAULT_FLAG_RETRY_NOWAIT)))
    return VM_FAULT_SIGSEGV;
```

The reason: `FAULT_FLAG_RETRY_NOWAIT` assumes the lock is not dropped on `VM_FAULT_RETRY`, but per-VMA lock protocol requires dropping it.

**userfaultfd** has its own interaction. The userfaultfd code (`mm/userfaultfd.c`) uses `lock_vma_under_rcu()` directly in some paths, calling `vma_start_read_locked()` and `vma_end_read()` explicitly.

**madvise** for some behaviors (e.g. `MADV_DONTNEED` ranges) uses `lock_vma_under_rcu()` in the per-range path added in recent kernels.

!!! warning "Per-VMA locks require CONFIG_PER_VMA_LOCK"
    The entire feature is compiled out if `CONFIG_PER_VMA_LOCK` is not set. On such kernels all faults go through `mmap_lock`. Most production distro kernels enable it from 6.4 onward.

## Further reading

### Kernel source

- [include/linux/mmap_lock.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mmap_lock.h) — `vma_start_read()`, `vma_end_read()`, `vma_start_write()`, and the sequence-counter helpers
- [mm/mmap_lock.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mmap_lock.c) — `lock_vma_under_rcu()`: the fast-path VMA lookup combining RCU and per-VMA locking
- [include/linux/mm_types.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mm_types.h) — `vm_lock_seq`, `vm_refcnt`, and `mm_lock_seq` field definitions with their locking contracts

### Kernel commits

- [5e31275cc997](https://git.kernel.org/linus/5e31275cc997) — Linux 6.4: "mm: add per-VMA lock and helper functions to control it" (Suren Baghdasaryan, Google)
- [d4af56c5c7c6](https://git.kernel.org/linus/d4af56c5c7c6) — Linux 6.1: maple tree VMA storage, prerequisite for scalable per-VMA locking

### Related pages

- [rcu-mm.md](rcu-mm.md) — how `SLAB_TYPESAFE_BY_RCU` and the maple tree enable the lock-free VMA lookup that per-VMA locks build on
- [mmap.md](mmap.md) — operations that still require the coarse `mmap_lock` write side

### LWN articles

- [LWN: Per-VMA locks](https://lwn.net/Articles/906852/) — 2022 article covering the design and motivation for per-VMA locking
- [LWN: Scalable page-fault handling](https://lwn.net/Articles/932298/) — follow-up covering the Linux 6.4 merge and benchmarks
