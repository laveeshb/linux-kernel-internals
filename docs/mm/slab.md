# Slab Allocator (SLUB)

> Efficient allocation of small kernel objects

## What is the Slab Allocator?

The slab allocator sits between the page allocator and kernel code. It carves pages into fixed-size object caches, reducing internal fragmentation and speeding up allocation of commonly-used structures.

```c
void *kmalloc(size_t size, gfp_t flags);
void kfree(const void *ptr);

/* Or create a dedicated cache */
struct kmem_cache *kmem_cache_create(const char *name, size_t size, ...);
void *kmem_cache_alloc(struct kmem_cache *cache, gfp_t flags);
void kmem_cache_free(struct kmem_cache *cache, void *ptr);
```

## Why Not Just Use the Page Allocator?

The page allocator works in `4KB` chunks. But kernel objects are often much smaller:

| Object | Typical Size |
|--------|--------------|
| `struct inode` | ~600 bytes |
| `struct dentry` | ~200 bytes |
| `struct task_struct` | ~8KB |
| `struct sk_buff` | ~256 bytes |

Allocating a full page for a 200-byte object wastes 95% of the memory.

## The Slab Concept

Originally from SunOS (Bonwick, 1994), the idea:

1. Pre-allocate pages for specific object types
2. Carve each page into fixed-size slots
3. Maintain free lists for fast alloc/free
4. Reuse memory without returning to page allocator

```
slab for 256-byte objects (one page):
+-------+-------+-------+-------+-------+-------+...+-------+
| obj 0 | obj 1 | obj 2 | obj 3 | obj 4 | obj 5 |   |obj 15 |
+-------+-------+-------+-------+-------+-------+...+-------+
   ^                 ^                       ^
   |                 |                       |
 in use            free                    free
```

## SLUB vs SLAB vs SLOB

Linux has had three slab implementations:

| Allocator | Status | Characteristics |
|-----------|--------|-----------------|
| SLAB | Removed (v6.8) | Original, complex, per-CPU queues |
| SLUB | **Default** | Simpler, lower overhead, no queues |
| SLOB | Removed (v6.4) | Minimal, for embedded systems |

**SLUB** (the "unqueued slab allocator") won because:
- Simpler code (easier to maintain, debug)
- Lower memory overhead
- Better NUMA awareness
- Comparable performance

## How SLUB Works

### Per-CPU Slabs

Each CPU has a "current" slab for fast allocation:

```
CPU 0                    CPU 1
  |                        |
  v                        v
+--------+              +--------+
| slab   |              | slab   |
| page   |              | page   |
|--------|              |--------|
| free   |              | free   |
| list   |              | list   |
+--------+              +--------+

No locking needed for per-CPU slab!
```

### Allocation Fast Path

```c
/* Simplified allocation */
void *slab_alloc(struct kmem_cache *s) {
    struct slab *slab = this_cpu_read(s->cpu_slab);
    void *object = slab->freelist;

    if (likely(object)) {
        slab->freelist = get_next_free(object);
        return object;
    }

    /* Slow path: get new slab */
    return __slab_alloc(s);
}
```

Fast path: load freelist pointer, advance it, return object. No locks.

### Freelist Encoding

SLUB stores the freelist pointer inside free objects themselves:

```
Free object layout:
+------------------+------------------+
| next free ptr    | (rest of object) |
+------------------+------------------+
^
|-- freelist points here

When allocated, pointer is overwritten by actual data
```

### Partial Slabs

When a CPU slab fills, SLUB gets a partially-full slab from the node's partial list:

```
Per-CPU          Per-Node Partial List
+--------+       +--------+  +--------+  +--------+
| full   | ----> | 75%    |->| 50%    |->| 25%    |
+--------+       +--------+  +--------+  +--------+
                 (sorted by fullness for efficiency)
```

## kmalloc Size Classes

`kmalloc()` uses pre-created caches for power-of-2 sizes:

```
kmalloc-8      (8 bytes)
kmalloc-16     (16 bytes)
kmalloc-32     (32 bytes)
kmalloc-64     (64 bytes)
kmalloc-96     (96 bytes)    <- not power of 2
kmalloc-128    (128 bytes)
...
kmalloc-8k     (8192 bytes)
```

Request for 100 bytes -> `kmalloc-128` (28 bytes internal fragmentation)

## Cache Merging

To reduce memory overhead, SLUB merges similar caches:

```
struct foo { int a, b, c; };      /* 12 bytes */
struct bar { int x, y, z; };      /* 12 bytes */

/* Both use the same underlying cache! */
```

Disable with boot option `slub_nomerge` for debugging.

## SLUB Debugging

SLUB has extensive debugging features:

```bash
# Boot options
slub_debug=P     # Poisoning - fill with patterns
slub_debug=F     # Sanity checks on free
slub_debug=Z     # Red zoning - guard bytes
slub_debug=U     # User tracking - store alloc/free caller
slub_debug=T     # Trace - print alloc/free

# Or for specific cache
slub_debug=PFZ,kmalloc-256

# Check via sysfs
cat /sys/kernel/slab/kmalloc-256/sanity_checks
```

### Poison Values

| Pattern | Meaning |
|---------|---------|
| `0x5a` | Newly allocated (uninitialized) |
| `0x6b` | Freed (use-after-free detection) |
| `0xa5` | Red zone (buffer overflow detection) |

## Try It Yourself

### View All Slab Caches

```bash
# Summary of all caches
cat /proc/slabinfo

# Or use slabtop for live monitoring
slabtop -s c    # Sort by cache size
```

### Inspect Specific Cache

```bash
# Via sysfs (SLUB)
ls /sys/kernel/slab/kmalloc-256/

# Key files:
# - object_size: actual object size
# - slab_size: size including metadata
# - objs_per_slab: objects per slab page
# - partial: number of partial slabs
# - cpu_slabs: per-CPU slabs
```

### Memory Usage by Cache

```bash
# Top memory consumers
cat /proc/slabinfo | awk 'NR>2 {print $1, $3*$4}' | sort -k2 -nr | head
```

### Trace Allocations

```bash
# Enable kmalloc tracing
echo 1 > /sys/kernel/debug/tracing/events/kmem/kmalloc/enable
cat /sys/kernel/debug/tracing/trace_pipe
```

## Key Data Structures

### struct kmem_cache

```c
struct kmem_cache {
    struct kmem_cache_cpu __percpu *cpu_slab;  /* Per-CPU data */
    unsigned int size;          /* Object size including metadata */
    unsigned int object_size;   /* Actual object size */
    struct kmem_cache_node *node[MAX_NUMNODES];  /* Per-node data */
    const char *name;
    /* ... */
};
```

### struct kmem_cache_cpu

```c
struct kmem_cache_cpu {
    void **freelist;           /* Pointer to next free object */
    struct slab *slab;         /* Current slab */
    struct slab *partial;      /* Per-CPU partial list */
    /* ... */
};
```

## History

### SLAB (1996)

Ported from SunOS, based on [Bonwick's 1994 paper](https://www.usenix.org/legacy/publications/library/proceedings/bos94/bonwick.html).

*Note: Predates LKML archives.*

### SLUB Introduction (v2.6.22, 2007)

**Commit**: [81819f0fc828](https://git.kernel.org/linus/81819f0fc828)
**Author**: Christoph Lameter

*Note: Original LKML thread (Feb 2007) predates reliable archives. See commit message for design rationale.*

### SLAB Deprecation (v6.5, 2023)

**Commit**: [03aecd6e4982](https://git.kernel.org/linus/03aecd6e4982)

SLAB was deprecated, with SLUB as the sole remaining allocator.

### SLAB Removal (v6.8, 2024)

**Commit**: [dade3b5a628d](https://git.kernel.org/linus/dade3b5a628d)

SLAB code removed. SLUB is now the only slab allocator.

## Common Issues

### Slab Fragmentation

Objects allocated but not freed, preventing slab pages from being returned.

**Debug**: Check `/sys/kernel/slab/*/partial`

### Memory Leaks

Allocations without matching frees.

**Debug**: Use `slub_debug=U` to track allocation sites, or use kmemleak.

### Cache Line Bouncing

Per-CPU slab contention on workloads that allocate on one CPU and free on another.

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/slub.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slub.c) | SLUB implementation |
| [`include/linux/slab.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/slab.h) | Slab API |
| [`mm/slab_common.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slab_common.c) | Common slab code |

### Key Commits

| Commit | Kernel | Description |
|--------|--------|-------------|
| [81819f0fc828](https://git.kernel.org/linus/81819f0fc828) | v2.6.22 | SLUB introduction |
| [03aecd6e4982](https://git.kernel.org/linus/03aecd6e4982) | v6.5 | SLAB deprecation |
| [dade3b5a628d](https://git.kernel.org/linus/dade3b5a628d) | v6.8 | SLAB removal |

### Further Reading

- [Bonwick, "The Slab Allocator" (1994)](https://www.usenix.org/legacy/publications/library/proceedings/bos94/bonwick.html) - Original design paper

### Related

- [page-allocator](page-allocator.md) - Where SLUB gets its pages
- [overview](overview.md) - How slab fits in the allocator hierarchy
