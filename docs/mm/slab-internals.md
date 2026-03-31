# SLUB Allocator Internals

> struct kmem_cache, freelist mechanics, per-CPU caches, and slab debugging

## Why a slab allocator?

`kmalloc` could just call the page allocator for every allocation, but that's wasteful:
- Page allocator minimum granularity: 4096 bytes
- Typical kernel allocation: 32–512 bytes
- Objects of the same type are created and freed repeatedly

The slab allocator solves this by:
1. Allocating objects from pre-divided pages ("slabs")
2. Caching freed objects for immediate reuse (no page allocator round-trip)
3. Exploiting constructor patterns: objects are often the same type

Linux uses **SLUB** (the "unqueued" slab allocator) since 2.6.23.

## Architecture overview

```
kmalloc(128, GFP_KERNEL)
         │
         ▼
kmalloc-128 cache (struct kmem_cache)
         │
    ┌────┴─────────────────────────────────┐
    │ Per-CPU slab (struct kmem_cache_cpu)  │  ← current CPU
    │   freelist: →obj1 →obj2 →obj3        │  ← hot, no lock
    └────┬─────────────────────────────────┘
         │ (per-CPU depleted)
    ┌────▼─────────────────────────────────┐
    │ Per-node partial list (struct kmem_cache_node) │
    │   partial slabs with some free objects │
    └────┬─────────────────────────────────┘
         │ (no partial slabs)
         ▼
    Page allocator (get a new slab page)
```

## struct kmem_cache

```c
/* include/linux/slub_def.h */
struct kmem_cache {
    struct kmem_cache_cpu __percpu *cpu_slab; /* per-CPU fast path */

    /* Allocation flags and configuration: */
    slab_flags_t    flags;
    unsigned long   min_partial;  /* min partial slabs in node */
    unsigned int    size;         /* object size (with metadata) */
    unsigned int    object_size;  /* real object size */
    struct reciprocal_value reciprocal_size;
    unsigned int    offset;       /* offset to freelist pointer */
    struct kmem_cache_order_objects oo; /* order and objects per slab */
    struct kmem_cache_order_objects max;
    struct kmem_cache_order_objects min;
    gfp_t           allocflags;   /* gfp flags for slab allocation */
    int             refcount;
    void            (*ctor)(void *);  /* constructor */

    unsigned int    inuse;        /* offset to metadata */
    unsigned int    align;
    unsigned int    red_left_pad; /* for redzone debugging */
    const char      *name;
    struct list_head list;        /* in slab_caches list */

    struct kmem_cache_node *node[MAX_NUMNODES];
};
```

## struct kmem_cache_cpu (per-CPU fast path)

```c
struct kmem_cache_cpu {
    void        **freelist;     /* pointer to first free object */
    unsigned long tid;          /* transaction ID (ABA prevention) */
    struct slab *slab;          /* current slab being used */
    /* ... */
};
```

The freelist is an **embedded linked list**: each free object's first bytes contain a pointer to the next free object (or NULL at the end of the list).

```
Slab page layout (objects = 128 bytes, SLUB):
┌────────┬────────┬────────┬────────┬──────────────────┐
│ obj[0] │ obj[1] │ obj[2] │ obj[3] │ ... until end    │
│ free   │ used   │ free   │ free   │                  │
│ →obj[2]│ [data] │ →obj[3]│ NULL   │                  │
└────────┴────────┴────────┴────────┴──────────────────┘
                     ↑
cpu_slab->freelist = &obj[0] → obj[2] → obj[3] → NULL
```

## kmalloc path (alloc_cache_obj)

```c
/* mm/slub.c (simplified) */
static __always_inline void *__kmalloc(size_t size, gfp_t flags)
{
    struct kmem_cache *s;

    /* Round up to the next kmalloc-N size: */
    s = kmalloc_caches[kmalloc_type(flags, _RET_IP_)][kmalloc_index(size)];

    return slab_alloc(s, NULL, size, flags, _RET_IP_);
}

static __always_inline void *slab_alloc(struct kmem_cache *s,
                                         struct list_lru *lru,
                                         size_t orig_size, gfp_t gfpflags,
                                         unsigned long addr)
{
    void *object;
    struct kmem_cache_cpu *c;
    unsigned long tid;

    /* Fast path: per-CPU freelist */
    c = this_cpu_ptr(s->cpu_slab);
    tid = c->tid;
    barrier();

    object = c->freelist;
    if (unlikely(!object || !__slab_obj_cnt_ok(c, s))) {
        /* Per-CPU slab exhausted → slow path */
        object = __slab_alloc(s, gfpflags, NUMA_NO_NODE, addr, c, orig_size);
    } else {
        /* Advance the freelist pointer (the embedded next ptr): */
        void *next = get_freepointer_safe(s, object);

        /* CAS to prevent races with IRQs stealing from same freelist: */
        if (unlikely(!__update_cpu_freelist_fast(s, object, next, tid))) {
            object = __slab_alloc(s, gfpflags, NUMA_NO_NODE, addr, c, orig_size);
        }
    }
    return object;
}
```

## kfree path

```c
void kfree(const void *object)
{
    struct slab *slab;
    struct kmem_cache *s;

    /* Get the slab (and thus the cache) from the page: */
    slab = virt_to_slab(object);
    if (unlikely(!slab)) {
        /* Might be a large allocation (compound page) */
        free_large_kmalloc(page, object);
        return;
    }

    s = slab->slab_cache;
    slab_free(s, slab, object, NULL, &object, 1, _RET_IP_);
}

static void slab_free(struct kmem_cache *s, struct slab *slab,
                       void *head, void *tail, void **p, int cnt,
                       unsigned long addr)
{
    struct kmem_cache_cpu *c = this_cpu_ptr(s->cpu_slab);

    /* If freeing to the current slab, just prepend to freelist: */
    if (slab == c->slab) {
        /* Fast path: set object's next ptr to current freelist head */
        set_freepointer(s, head, c->freelist);
        c->freelist = head;
        c->tid = next_tid(c->tid);
        return;
    }

    /* Slow path: different slab → lock and handle */
    __slab_free(s, slab, head, tail, cnt, addr);
}
```

## kmem_cache_create (named caches)

```c
/* For frequently allocated objects with a specific type: */
struct kmem_cache *my_cache;

/* At module init: */
my_cache = kmem_cache_create(
    "my_struct",               /* name (shown in /proc/slabinfo) */
    sizeof(struct my_struct),  /* object size */
    __alignof__(struct my_struct), /* alignment */
    SLAB_HWCACHE_ALIGN |       /* align to cache lines */
    SLAB_PANIC,                /* BUG() if creation fails */
    my_struct_ctor             /* optional constructor */
);

/* Allocate and free: */
struct my_struct *obj = kmem_cache_alloc(my_cache, GFP_KERNEL);
kmem_cache_free(my_cache, obj);

/* At module exit: */
kmem_cache_destroy(my_cache);
```

## SLUB debugging

```bash
# Enable SLUB debugging at boot (heavy overhead!):
# SLUB_DEBUG in config, then:
# slub_debug=FZP (FreeZone, Poison, track Padding)
# or per-cache: slub_debug=FZP,my_struct

# /proc/slabinfo: cache statistics
cat /proc/slabinfo
# name            <active_objs> <num_objs> <objsize> <objperslab> ...
# kmalloc-128        12453       13000       128         32        ...
# my_struct             123         256       256         16        ...

# More detailed: slabtop (like top for slab)
slabtop
# Active / Total Objects (% used)    : 1234567 / 1500000 (82.3%)
# Active / Total Slabs (% used)      : 12345 / 15000 (82.3%)
# ...

# Find which cache holds a pointer:
# (in crash or gdb with vmlinux):
# crash> kmem -s <pointer>

# SLUB debug info for a cache:
ls /sys/kernel/slab/
cat /sys/kernel/slab/kmalloc-128/alloc_fastpath   # per-CPU alloc count
cat /sys/kernel/slab/kmalloc-128/free_fastpath
cat /sys/kernel/slab/kmalloc-128/slabs            # total slab pages
cat /sys/kernel/slab/kmalloc-128/objects          # total objects
cat /sys/kernel/slab/kmalloc-128/object_size      # 128

# KASAN: detects use-after-free and out-of-bounds in slab:
# CONFIG_KASAN=y causes SLUB to insert red zones and poison memory
```

## Memory poisoning

When `CONFIG_SLUB_DEBUG` is enabled, freed objects are poisoned:

```
Poison values:
  0x6b ('k') — object filled with this after free (SLUB_RED_ACTIVE)
  0x5a ('Z') — padding bytes (SLUB_RED_INACTIVE)
  0xcc — alignment padding

On the next allocation, SLUB checks that the poison is intact.
If not: use-after-free detected, kernel dumps the offending allocation.
```

## Further reading

- [kmalloc and slab](slab.md) — user-facing API
- [Page Allocator](page-allocator.md) — SLUB gets pages from here
- [KASAN](kasan.md) — slab memory error detection
- [KFENCE](kfence.md) — lightweight slab sampling-based detection
- `mm/slub.c` — SLUB implementation (~10,000 lines)
- `Documentation/mm/slub.rst` — SLUB documentation
