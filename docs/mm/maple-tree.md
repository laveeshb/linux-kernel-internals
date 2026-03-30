# Maple Tree: VMA Management Data Structure

> The B-tree variant that replaced the rbtree + linked list for virtual memory area management in Linux 6.1

## Key Source Files

| File | Purpose |
|------|---------|
| `include/linux/maple_tree.h` | Public API: `struct maple_tree`, `struct ma_state`, all macros and inline functions |
| `lib/maple_tree.c` | Full implementation, `maple_tree_init()`, `mas_walk()`, `mas_find()`, `mas_store()`, `mas_erase()` |
| `include/linux/mm_types.h` | `struct mm_struct` embedding (`mm_mt`), `struct vma_iterator`, `MM_MT_FLAGS` |
| `mm/mmap.c` | `find_vma()`, `find_vma_intersection()`, process teardown with `__mt_destroy()` |
| `mm/vma.c` | VMA insertion via `vma_iter_store_gfp()`, removal via `vma_iter_clear()` |
| `kernel/fork.c` | `mm_init()`: maple tree initialization with `mt_init_flags()` |

---

## Why the Maple Tree Replaced rbtree + Linked List

Before Linux 6.1, every `mm_struct` maintained two redundant data structures for VMAs:

- An **red-black tree** (`mm->mm_rb`) keyed on `vm_start`, providing O(log n) lookup by address.
- A **doubly-linked list** (`vma->vm_next` / `vma->vm_prev`) threading all VMAs in address order, used for sequential iteration.

Every VMA insertion, deletion, or modification had to update both structures atomically under `mmap_lock`. Beyond the extra code complexity, there were two concrete performance costs:

1. **Cache misses during sequential scans.** Walking the linked list requires following `vm_next` pointers, one per VMA, with each pointer potentially pointing to a different cache line in a different slab object. On a process with thousands of mappings this becomes a long chain of pointer-chasing loads.

2. **Memory overhead.** Each `vm_area_struct` carried three rbtree node fields (`rb_node`, plus parent and colour embedded in the pointer) and two list pointers, costing ~40 bytes per VMA solely for indexing.

The maple tree (merged in v6.1, authored at Oracle by Liam Howlett and Matthew Wilcox) unifies both structures into a single B-tree variant that natively supports range-keyed lookup *and* efficient sequential iteration. Because B-tree nodes pack multiple pivots and slots into one 256-byte cache line, a single node access provides several pivot comparisons, dramatically reducing cache misses compared to an rbtree where each comparison requires loading a different node.

---

## What the Maple Tree Is

The maple tree is an RCU-safe, range-keyed B-tree. It stores non-overlapping ranges of unsigned long keys, mapping each range to an opaque pointer value. For VMA management the key is the address range `[vm_start, vm_end - 1]` and the value is `struct vm_area_struct *`.

### Node types and sizes

Three node types are defined (from `include/linux/maple_tree.h`):

```c
/* On 64-bit: 256 bytes per node, aligned to 256 bytes */
#define MAPLE_NODE_SLOTS     31   /* slots in a generic node */
#define MAPLE_RANGE64_SLOTS  16   /* range node: 15 pivots + 16 slots */
#define MAPLE_ARANGE64_SLOTS 10   /* alloc-range node: 9 pivots + 10 slots + gaps */
```

The two node variants in use:

**`maple_range_64` — the standard internal/leaf node**

```c
struct maple_range_64 {
    struct maple_pnode *parent;
    unsigned long pivot[MAPLE_RANGE64_SLOTS - 1]; /* 15 range boundaries */
    union {
        void __rcu *slot[MAPLE_RANGE64_SLOTS];    /* 16 child or value pointers */
        struct {
            void __rcu *pad[MAPLE_RANGE64_SLOTS - 1];
            struct maple_metadata meta;            /* end offset + largest gap */
        };
    };
};
```

A `maple_range_64` node stores up to 15 pivots and 16 slots in 256 bytes. In B-tree terms, pivots are the inclusive upper bounds of the ranges stored in each slot. Slot *i* covers the range `(pivot[i-1], pivot[i]]`, with slot 0 covering from the node's implied minimum.

**`maple_arange_64` — the allocation-range node**

```c
struct maple_arange_64 {
    struct maple_pnode *parent;
    unsigned long pivot[MAPLE_ARANGE64_SLOTS - 1]; /* 9 range boundaries */
    void __rcu *slot[MAPLE_ARANGE64_SLOTS];         /* 10 pointers */
    unsigned long gap[MAPLE_ARANGE64_SLOTS];        /* largest NULL gap per slot */
    struct maple_metadata meta;
};
```

Allocation-range nodes additionally track the largest contiguous gap of NULL entries within each subtree. This supports `mas_empty_area()` / `mas_empty_area_rev()`, which find a free address range of a given size without scanning the entire tree — critical for `mmap()` address selection.

### Node allocation

All nodes are allocated from a dedicated `kmem_cache` named `maple_node`, created at boot by `maple_tree_init()`:

```c
void __init maple_tree_init(void)
{
    struct kmem_cache_args args = {
        .align          = sizeof(struct maple_node),
        .sheaf_capacity = 32,
    };
    maple_node_cache = kmem_cache_create("maple_node",
            sizeof(struct maple_node), &args, SLAB_PANIC);
}
```

The 256-byte alignment ensures that the bottom 8 bits of a node pointer are always zero. The maple tree uses these bits to encode the node type and tree metadata directly in the pointer, avoiding extra memory accesses.

### Maximum tree height

```c
#define MAPLE_HEIGHT_MAX  31
```

With 16 slots per `maple_range_64` node, a tree of height 31 can represent 16^31 distinct ranges — far beyond any realistic address space.

---

## struct maple_tree

```c
/* include/linux/maple_tree.h */
struct maple_tree {
    union {
        spinlock_t          ma_lock;
#ifdef CONFIG_LOCKDEP
        struct lockdep_map *ma_external_lock;
#endif
    };
    unsigned int    ma_flags;
    void __rcu     *ma_root;
};
```

- **`ma_lock`** — internal spinlock, used when no external lock is supplied. For `mm->mm_mt` this is unused: the tree is configured with `MT_FLAGS_LOCK_EXTERN` so that `mmap_lock` acts as the serialising lock.
- **`ma_flags`** — bitmask of tree-wide properties (see below).
- **`ma_root`** — RCU-protected pointer to the root node (or a single stored value if the tree has exactly one entry at index 0).

### Flags

```c
#define MT_FLAGS_ALLOC_RANGE   0x01  /* track largest free gap per node */
#define MT_FLAGS_USE_RCU       0x02  /* nodes are freed via RCU */
#define MT_FLAGS_LOCK_IRQ      0x100 /* ma_lock acquired IRQ-safe */
#define MT_FLAGS_LOCK_BH       0x200 /* ma_lock acquired BH-safe */
#define MT_FLAGS_LOCK_EXTERN   0x300 /* external lock; ma_lock unused */
```

### How mm_struct embeds the maple tree

```c
/* include/linux/mm_types.h */
struct mm_struct {
    ...
    struct maple_tree mm_mt;
    ...
    struct rw_semaphore mmap_lock;
    ...
};

/* The flags used when initialising mm->mm_mt */
#define MM_MT_FLAGS  (MT_FLAGS_ALLOC_RANGE | MT_FLAGS_LOCK_EXTERN | \
                      MT_FLAGS_USE_RCU)
```

All three flags are active for `mm->mm_mt`:

- `MT_FLAGS_ALLOC_RANGE` — enables gap tracking so that `mmap()` can find a free region efficiently.
- `MT_FLAGS_LOCK_EXTERN` — the tree's internal `ma_lock` spinlock is bypassed; callers must hold `mmap_lock` for write before any mutation.
- `MT_FLAGS_USE_RCU` — removed nodes are freed via `call_rcu()` rather than immediately, enabling lockless RCU readers (see [RCU safety](#rcu-safety) below).

The tree is initialised and bound to `mmap_lock` in `mm_init()` (`kernel/fork.c`):

```c
static struct mm_struct *mm_init(struct mm_struct *mm, ...)
{
    mt_init_flags(&mm->mm_mt, MM_MT_FLAGS);
    mt_set_external_lock(&mm->mm_mt, &mm->mmap_lock);
    ...
}
```

---

## RCU Safety

The maple tree achieves lockless reads by ensuring that nodes removed from the tree are not freed until all currently executing RCU read-side critical sections have completed. When `MT_FLAGS_USE_RCU` is set, the removal path calls `call_rcu()` instead of freeing immediately:

```c
/* lib/maple_tree.c — node removal path */
if (mt_in_rcu(mt)) {
    mt_destroy_walk(enode, mt, false);
    call_rcu(&node->rcu, mt_free_walk);   /* deferred free */
} else {
    mt_destroy_walk(enode, mt, true);     /* immediate free */
}
```

The `struct maple_node` reuses its `slot[]` array as an `rcu_head` after the node is removed from the tree (both are stored in a union). A reader that loaded a pointer from `slots[]` before the node was unlinked can safely continue dereferencing it; the memory will not be returned to the allocator until after its RCU grace period.

### RCU mode lifecycle in the mm

The `mm->mm_mt` operates with RCU enabled most of the time. During process teardown and the `dup_mmap()` path, the kernel temporarily disables RCU mode to avoid the overhead of deferred freeing when nodes are being discarded en masse:

```c
/* mm/mmap.c — exit_mmap() */
mt_clear_in_rcu(&mm->mm_mt);   /* switch to immediate free for teardown */
...
__mt_destroy(&mm->mm_mt);      /* free all remaining nodes */

/* mm/mmap.c — dup_mmap() — after bulk duplication is complete */
mt_set_in_rcu(vmi.mas.tree);   /* re-enable RCU on the new mm */
```

`mt_set_in_rcu()` and `mt_clear_in_rcu()` toggle `MT_FLAGS_USE_RCU` under the tree's lock.

### Lockless VMA lookup (per-VMA lock fast path)

A reader holding only `rcu_read_lock()` — with no `mmap_lock` — can safely walk `mm->mm_mt` to find a VMA. This is the foundation of the per-VMA lock fast path (see [per-vma-locks.md](per-vma-locks.md)):

```c
/* mm/mmap_lock.c — lock_vma_under_rcu() */
MA_STATE(mas, &mm->mm_mt, address, address);

rcu_read_lock();
vma = mas_walk(&mas);          /* lockless maple tree walk under RCU */
if (!vma)
    goto inval;
vma = vma_start_read(mm, vma); /* attempt per-VMA read lock */
...
rcu_read_unlock();
```

`mas_walk()` traverses from root to leaf purely by reading `__rcu`-annotated pointers and pivots. No lock is required because removed nodes remain valid for at least one RCU grace period.

---

## MA_STATE and the Maple State Cursor

The `struct ma_state` is the operation cursor for all advanced maple tree APIs. It tracks the current position in the tree so that sequential operations (e.g. iterating over all VMAs) do not need to restart from the root on each call.

```c
/* include/linux/maple_tree.h */
struct ma_state {
    struct maple_tree      *tree;         /* the tree being operated on */
    unsigned long           index;        /* range start of current operation */
    unsigned long           last;         /* range end of current operation */
    struct maple_enode     *node;         /* current node */
    unsigned long           min;          /* implied minimum of current node */
    unsigned long           max;          /* implied maximum of current node */
    struct slab_sheaf      *sheaf;        /* pre-allocated node pool */
    struct maple_node      *alloc;        /* single pre-allocated node (fast path) */
    unsigned long           node_request; /* number of nodes to pre-allocate */
    enum maple_status       status;       /* ma_start / ma_active / ma_none / ma_error / ... */
    unsigned char           depth;        /* depth during write descent */
    unsigned char           offset;       /* slot/pivot index within current node */
    unsigned char           mas_flags;
    unsigned char           end;          /* last used slot in current node */
    enum store_type         store_type;   /* type of write needed */
};
```

The `status` field determines how the next operation treats the cursor:

| Status | Meaning |
|--------|---------|
| `ma_start` | Not yet positioned; next operation walks from root |
| `ma_active` | Cursor is valid at `node`/`offset`; in-place continuation is safe |
| `ma_none` | Search complete; no entry found at `index` |
| `ma_root` | Entry found in the root pointer (tree has only one entry) |
| `ma_pause` | Node data may be stale; restart required (e.g. lock dropped) |
| `ma_overflow` | Reached the upper search limit |
| `ma_underflow` | Reached the lower search limit |
| `ma_error` | Error occurred; `node` encodes the negative errno |

The `MA_STATE` macro initialises a cursor on the stack:

```c
#define MA_STATE(name, mt, first, end)      \
    struct ma_state name = {                \
        .tree   = mt,                       \
        .index  = first,                    \
        .last   = end,                      \
        .node   = NULL,                     \
        .status = ma_start,                 \
        .min    = 0,                        \
        .max    = ULONG_MAX,                \
        ...                                 \
    }
```

After an operation completes, `mas->index` and `mas->last` hold the full range of the entry that was found or stored.

The `struct vma_iterator` used throughout `mm/mmap.c` and `mm/vma.c` is a thin wrapper:

```c
/* include/linux/mm_types.h */
struct vma_iterator {
    struct ma_state mas;
};

#define VMA_ITERATOR(name, __mm, __addr)    \
    struct vma_iterator name = {            \
        .mas = {                            \
            .tree   = &(__mm)->mm_mt,       \
            .index  = __addr,               \
            .status = ma_start,             \
        },                                  \
    }
```

---

## Key Operations

### Tree lifecycle: `mt_init()` and `mtree_destroy()`

```c
/* Initialise an empty tree with default flags (no external lock, no RCU) */
static inline void mt_init(struct maple_tree *mt)
{
    mt_init_flags(mt, 0);
}

/* Initialise with specific flags (used for mm->mm_mt) */
static inline void mt_init_flags(struct maple_tree *mt, unsigned int flags);

/* Destroy a tree, freeing all nodes (acquires ma_lock internally) */
void mtree_destroy(struct maple_tree *mt);

/* Destroy without locking — caller must hold the external lock */
void __mt_destroy(struct maple_tree *mt);
```

For `mm->mm_mt`, `mm_init()` uses `mt_init_flags()` with `MM_MT_FLAGS`. Teardown in `exit_mmap()` and `dup_mmap()` error paths uses `__mt_destroy(&mm->mm_mt)` after the caller already holds `mmap_lock` for write.

---

### `mas_walk()` — position cursor at index

```c
void *mas_walk(struct ma_state *mas);
```

Searches for `mas->index` in the tree. On return, `mas->index` and `mas->last` are set to the range of the found entry (or to `0` and `ULONG_MAX` if nothing was found). Does not advance the cursor; calling `mas_walk()` twice on the same index returns the same entry.

Safe to call under `rcu_read_lock()` alone (no write lock needed). The per-VMA lock fast path uses this directly:

```c
MA_STATE(mas, &mm->mm_mt, address, address);
rcu_read_lock();
vma = mas_walk(&mas);
```

---

### `mas_find()` — forward iteration from index

```c
void *mas_find(struct ma_state *mas, unsigned long max);
```

Returns the next entry whose range overlaps `[mas->index, max]`. After a successful return, `mas->index` and `mas->last` describe the range of the returned entry and the cursor is positioned there; the next call starts scanning forward from `mas->last + 1`.

Returns `NULL` when no entry exists in the remaining range (sets status to `ma_overflow`).

Must be called with `rcu_read_lock()` or the write lock held.

The `mas_for_each()` macro uses this:

```c
#define mas_for_each(__mas, __entry, __max) \
    while (((__entry) = mas_find((__mas), (__max))) != NULL)
```

---

### `mas_store()` / `mas_store_gfp()` — insert or update a range mapping

```c
/* Store entry at [mas->index, mas->last]. Requires pre-allocated nodes. */
void *mas_store(struct ma_state *mas, void *entry);

/* Store with on-demand allocation (returns -ENOMEM on failure). */
int mas_store_gfp(struct ma_state *mas, void *entry, gfp_t gfp);
```

Both functions write `entry` into the tree for the range `[mas->index, mas->last]`, which must be set before calling. If an existing entry overlaps the range, it is displaced (split, shrunk, or replaced as needed). Returns the first displaced entry (if any) for `mas_store()`; returns 0 or `-ENOMEM` for `mas_store_gfp()`.

Requires the write lock.

In VMA code, `vma_iter_store_gfp()` wraps `mas_store_gfp()`:

```c
/* mm/vma.h */
static inline int vma_iter_store_gfp(struct vma_iterator *vmi,
                                     struct vm_area_struct *vma, gfp_t gfp)
{
    __mas_set_range(&vmi->mas, vma->vm_start, vma->vm_end - 1);
    mas_store_gfp(&vmi->mas, vma, gfp);
    if (unlikely(mas_is_err(&vmi->mas)))
        return -ENOMEM;
    vma_mark_attached(vma);
    return 0;
}
```

---

### `mas_erase()` — remove the entry at the current index

```c
void *mas_erase(struct ma_state *mas);
```

Finds the range containing `mas->index`, erases the entire range (stores NULL), and returns the previous entry. On return, `mas->index` and `mas->last` are set to the erased range.

Requires the write lock.

In VMA code the removal path uses `vma_iter_clear()`, which calls `mas_store_prealloc()` with NULL:

```c
/* mm/vma.h */
static inline void vma_iter_clear(struct vma_iterator *vmi)
{
    mas_store_prealloc(&vmi->mas, NULL);
}
```

---

### `mt_for_each()` — simple full-tree iteration

```c
/* include/linux/maple_tree.h */
#define mt_for_each(__tree, __entry, __index, __max)        \
    for (__entry = mt_find(__tree, &(__index), __max);      \
         __entry;                                            \
         __entry = mt_find_after(__tree, &(__index), __max))
```

`mt_for_each` uses the simpler `mt_find()` / `mt_find_after()` interface (which acquires and releases `rcu_read_lock()` internally on each call), rather than an explicit `ma_state`. It is convenient for read-only traversals that do not need to maintain cursor state between iterations.

---

## Code Examples

### VMA lookup by address

```c
/* find_vma() — mm/mmap.c */
struct vm_area_struct *find_vma(struct mm_struct *mm, unsigned long addr)
{
    unsigned long index = addr;

    mmap_assert_locked(mm);
    return mt_find(&mm->mm_mt, &index, ULONG_MAX);
}
```

`mt_find()` starts at `index` and returns the first entry whose range covers or follows `addr`. For address lookup this is equivalent to asking "which VMA covers addr, or if none, which is the next one".

### VMA insertion during mmap

```c
/* mm/vma.c — anonymous mapping creation (simplified) */
vma = vm_area_alloc(mm);
vma_set_range(vma, addr, addr + len, pgoff);
vm_flags_init(vma, vm_flags);
vma_start_write(vma);                    /* mark VMA write-locked */

if (vma_iter_store_gfp(vmi, vma, GFP_KERNEL))
    goto mas_store_fail;

mm->map_count++;
```

### Iterating all VMAs (e.g. for /proc/PID/maps)

```c
VMA_ITERATOR(vmi, mm, 0);
struct vm_area_struct *vma;

for_each_vma(vmi, vma) {
    /* vma->vm_start, vma->vm_end, vma->vm_flags ... */
}
```

`for_each_vma` is built on `vma_next()` which advances the `vma_iterator` forward through the maple tree without restarting from the root.

### Finding a free address range (mmap hint search)

```c
/* mas_empty_area() — finds a gap of at least `size` bytes in [min, max] */
MA_STATE(mas, &mm->mm_mt, 0, 0);
mas_empty_area(&mas, mmap_min_addr, mmap_end - len, len);
addr = mas.index;
```

This leverages the `gap[]` array in `maple_arange_64` nodes to skip subtrees that cannot contain a gap large enough, making free-range search O(log n) rather than O(n).

---

## Performance Compared to rbtree

| Property | rbtree + linked list | Maple tree |
|----------|---------------------|------------|
| Point lookup | O(log n) | O(log n) |
| Sequential scan | O(n) pointer chasing | O(n) sequential node reads |
| Free-gap search | O(n) full scan | O(log n) via gap metadata |
| Cache lines per node | 1 (one VMA pointer per node) | Up to 16 entries per 256-byte node |
| Memory per VMA (index overhead) | ~40 bytes (rb_node + list pointers) | Amortised ~16 bytes (shared node) |
| Lock on reads | mmap_lock required | RCU read lock sufficient |
| Update complexity | Two structure updates | One tree update |

The key advantage for sequential scans (e.g. reading `/proc/PID/maps` or `mprotect()` over a large range) is that a `maple_range_64` node holds 16 VMA pointers in one 256-byte allocation. A full-node traversal costs one cache miss to load the node, then up to 16 useful entries, compared to one cache miss *per entry* when following a linked list.

For address spaces with thousands of mappings (JVM, large applications, container runtimes), this reduction in cache pressure is measurable.

---

## Debugging

### `/proc/PID/maps` and `/proc/PID/smaps`

These files are generated by iterating `mm->mm_mt` directly. No change is required to read them; the maple tree is the authoritative source.

### `CONFIG_DEBUG_MAPLE_TREE`

Enable via `lib/Kconfig.debug`:

```
CONFIG_DEBUG_MAPLE_TREE=y   # requires CONFIG_DEBUG_KERNEL=y
```

With this option:

- `MT_BUG_ON()`, `MAS_BUG_ON()`, and `MT_WARN_ON()` perform additional consistency checks at each tree operation and dump the full tree on failure.
- Extra range validation is performed inside `mas_store()` before each write.
- `mt_validate()` can be called explicitly to check the structural integrity of any tree:

```c
void mt_validate(struct maple_tree *mt);
```

`mt_validate()` checks that all pivot arrays are sorted, that no ranges overlap, that gap metadata is consistent, and that the height stored in `ma_flags` matches the actual tree depth.

### `mt_dump()`

```c
void mt_dump(const struct maple_tree *mt, enum mt_dump_format format);
```

Prints the full tree to the kernel log in decimal (`mt_dump_dec`) or hexadecimal (`mt_dump_hex`) format. Available only when `CONFIG_DEBUG_MAPLE_TREE=y`. Called automatically by `MT_BUG_ON()` and `MAS_BUG_ON()` on failure.

### `mas_dump()`

```c
void mas_dump(const struct ma_state *mas);
```

Prints the current state of an `ma_state` cursor (index, last, node pointer, status, min/max, depth, offset). Useful when debugging an incorrect cursor state.

!!! tip "Tracing maple tree operations"
    The maple tree has built-in tracepoints (`trace_ma_read`, `trace_ma_write`, `trace_ma_op`) instrumented throughout `lib/maple_tree.c`. These are visible via `ftrace` when the corresponding `maple_tree` event group is enabled and provide per-operation visibility into the tree without requiring `CONFIG_DEBUG_MAPLE_TREE`.

!!! note "RCU mode and debugging"
    When `CONFIG_DEBUG_MAPLE_TREE` is combined with `CONFIG_MAPLE_RCU_DISABLED` (a compile-time option at the top of `lib/maple_tree.c`), RCU freeing is suppressed entirely and nodes are freed immediately. This can help expose use-after-free bugs in tree consumers but is not safe for production.

---

## Relationship to Other Subsystems

- **Per-VMA locks** (`mm/mmap_lock.c`) depend on `MT_FLAGS_USE_RCU` to perform lockless VMA lookups under `rcu_read_lock()`. See [per-vma-locks.md](per-vma-locks.md).
- **`/proc/PID/maps`** iterates `mm->mm_mt` via `for_each_vma()` under `mmap_lock` for read.
- **`dup_mmap()`** uses `__mt_dup()` to bulk-copy the parent maple tree into the child `mm`, then replaces any `VM_DONTCOPY` entries with `vma_iter_clear_gfp()`.
- **`execve()`** tears down the address space by calling `exit_mmap()`, which calls `__mt_destroy(&mm->mm_mt)` after clearing all page table entries.
- **vmalloc** uses a red-black tree (`free_vmap_area_root`, a `struct rb_root`) for tracking kernel virtual address space — not a maple tree.
