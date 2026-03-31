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

| Object | Typical Size (x86-64) |
|--------|------------------------|
| `struct inode` | ~600 bytes |
| `struct dentry` | ~200 bytes |
| `struct file` | ~256 bytes |
| `struct sk_buff` | ~256 bytes |

Allocating a full page for a 200-byte object wastes 95% of the memory.

## The Slab Concept

Originally from SunOS ([Bonwick, USENIX Summer 1994](https://www.usenix.org/conference/usenix-summer-1994-technical-conference/slab-allocator-object-caching-kernel)), the idea:

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
| SLAB | [Removed (v6.8)](https://git.kernel.org/linus/16a1d968358a) | Original, complex, per-CPU queues |
| SLUB | **Default** ([since v2.6.23](https://git.kernel.org/linus/a0acd820)) | Simpler, lower overhead, no queues |
| SLOB | [Removed (v6.4)](https://git.kernel.org/linus/c9929f0e344a) | Minimal, for embedded systems |

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
```

Fast path uses atomic `cmpxchg` instead of locks (when hardware supports it).

### Allocation Fast Path

From `mm/slub.c`:

> "The fast path allocation (slab_alloc_node()) and freeing (do_slab_free()) are fully lockless when satisfied from the percpu slab (and when cmpxchg_double is possible to use, otherwise slab_lock is taken). They rely on the transaction id (tid) field to detect being preempted or moved to another cpu."

The fast path:
1. Read `freelist` and `tid` from per-CPU structure
2. Attempt atomic compare-and-swap (`this_cpu_cmpxchg`) to update freelist
3. If cmpxchg fails (another CPU or preemption changed tid), retry
4. If freelist is empty, fall back to slow path with locks

This avoids traditional locks in the common case while remaining correct under preemption and migration.

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
| full   | ----> |partial |->|partial |->|partial |
+--------+       +--------+  +--------+  +--------+
```

The per-CPU partial list behavior is controlled by `CONFIG_SLUB_CPU_PARTIAL`. When enabled (default), each CPU maintains its own partial list, reducing contention on the node's partial list.

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

### kvmalloc

For allocations that might be large, use `kvmalloc()` instead of `kmalloc()`:

```c
void *kvmalloc(size_t size, gfp_t flags);
void kvfree(const void *addr);
```

`kvmalloc()` tries `kmalloc()` first, falls back to `vmalloc()` for larger allocations. This avoids high-order allocation failures while keeping small allocations fast.

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
| `0x5a` | Uninitialized (`POISON_INUSE`) - detects uninitialized access |
| `0x6b` | Object freed (`POISON_FREE`) - detects use-after-free |
| `0xa5` | End marker (`POISON_END`) - marks end of poisoned region |
| `0xbb` | Red zone inactive (`SLUB_RED_INACTIVE`) - detects buffer overflows on free objects |
| `0xcc` | Red zone active (`SLUB_RED_ACTIVE`) - detects buffer overflows on in-use objects |

## Security Hardening

SLUB has several security features:

| Config Option | Purpose |
|---------------|---------|
| `CONFIG_SLAB_FREELIST_RANDOM` | Randomize freelist order to make heap exploits harder |
| `CONFIG_SLAB_FREELIST_HARDENED` | XOR freelist pointers with random value to detect corruption |
| `CONFIG_INIT_ON_ALLOC_DEFAULT_ON` | Zero memory on allocation |
| `CONFIG_INIT_ON_FREE_DEFAULT_ON` | Zero memory on free |

### KFENCE

KFENCE (Kernel Electric Fence) is a sampling-based memory safety error detector. From the [kernel documentation](https://docs.kernel.org/dev-tools/kfence.html):

> "KFENCE is designed to be enabled in production kernels, and has near zero performance overhead."

Unlike `slub_debug`, KFENCE can run in production because it only samples a fraction of allocations.

```bash
# Check if enabled
cat /sys/module/kfence/parameters/sample_interval
```

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
/* From mm/slub.c */
struct kmem_cache_cpu {
    union {
        struct {
            void *freelist;        /* Pointer to next available object */
            unsigned long tid;     /* Globally unique transaction id */
        };
        freelist_full_t freelist_tid;
    };
    struct slab *slab;             /* The slab from which we are allocating */
    struct slab *partial;          /* Partially allocated slabs */
    local_trylock_t lock;          /* Protects the fields above */
};
```

## History

### SLAB (1996)

Ported from SunOS, based on [Bonwick's 1994 paper](https://people.eecs.berkeley.edu/~kubitron/courses/cs194-24-S14/hand-outs/bonwick_slab.pdf).

*Note: Predates LKML archives.*

### SLUB Introduction (v2.6.22, 2007)

**Commit**: [81819f0fc828](https://git.kernel.org/linus/81819f0fc828)

**Author**: Christoph Lameter

*Note: The commit message contains the design rationale. Pre-2008 LKML archives are sparse.*

### SLAB Deprecation (v6.5, 2023)

**Commit**: [eb07c4f39c3e](https://git.kernel.org/linus/eb07c4f39c3e) ("mm/slab: rename CONFIG_SLAB to CONFIG_SLAB_DEPRECATED") | [LKML](https://lore.kernel.org/linux-arm-kernel/20230523091139.21449-1-vbabka@suse.cz/)

**Author**: Vlastimil Babka

SLAB was deprecated, with SLUB as the sole remaining allocator.

### SLAB Removal (v6.8, 2024)

**Commit**: [16a1d968358a](https://git.kernel.org/linus/16a1d968358a) ("mm/slab: remove mm/slab.c and slab_def.h") | [LKML](https://lore.kernel.org/lkml/20231113191340.17482-22-vbabka@suse.cz/)

**Author**: Vlastimil Babka

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

## Notorious bugs and edge cases

Heap exploitation is the bread and butter of kernel exploits. The SLUB allocator's design - storing freelist pointers inline with objects, using per-CPU caches, and merging similar caches - creates a rich attack surface.

### Case 1: Netfilter heap out-of-bounds (CVE-2021-22555)

#### What happened

In July 2021, Andy Nguyen (Google) demonstrated a 15-year-old heap out-of-bounds write in Linux Netfilter that bypassed all modern mitigations to achieve kernel code execution. The exploit won $10,000 in Google's kCTF program.

#### The bug

From the [Project Zero writeup](https://google.github.io/security-research/pocs/linux/cve-2021-22555/writeup.html):

The vulnerability exists in `net/netfilter/x_tables.c`. When `IPT_SO_SET_REPLACE` is called in compatibility mode, structures must be converted from 32-bit to 64-bit format. The conversion function `xt_compat_target_from_user()` could write 4 bytes of zeros out-of-bounds.

#### Exploitation technique

The exploit uses several advanced techniques:

1. **Heap spray with msg_msg**: Use `msgsnd()` to spray the heap with controlled `msg_msg` structures
2. **Corrupt msg_msg->m_list.next**: The 4-byte zero write partially overwrites a freelist pointer
3. **UAF primitive**: The corrupted pointer creates a use-after-free condition
4. **Leak kernel addresses**: Read freed msg_msg to defeat KASLR
5. **Fake object injection**: Spray fake objects to control execution

#### The fix

**Commit**: [b29c457a6511](https://git.kernel.org/linus/b29c457a6511) ("netfilter: x_tables: fix compat match/target pad out-of-bound write")

**Author**: Florian Westphal

---

### Case 2: io_uring use-after-free (CVE-2022-29582)

#### What happened

In 2022, security researchers discovered a race condition in io_uring's timeout handling that led to a use-after-free. The exploit achieved root privileges on Google's hardened kCTF environment.

#### The bug

From the [technical writeup](https://ruia-ruia.github.io/2022/08/05/CVE-2022-29582-io-uring/):

A race exists between timeout flush and removal in io_uring. When the same timeout request is processed by both paths simultaneously, it gets freed twice, creating a use-after-free.

#### Exploitation technique

The exploit uses a **cross-cache attack**:

1. **Trigger UAF**: Race the timeout paths to free `io_kiocb` twice
2. **Reclaim with different object**: Free the slab page, reallocate in a different cache
3. **Type confusion**: The freed `io_kiocb` slot now holds a different object type
4. **Arbitrary read/write**: Manipulate the confused object to gain primitives

#### The fix

**Commit**: [e677edbcabee](https://git.kernel.org/linus/e677edbcabee) ("io_uring: fix race between timeout flush and removal")

**Author**: Jens Axboe

---

### Case 3: SLUB freelist hardening bypasses

#### The hardening

Linux added `CONFIG_SLAB_FREELIST_HARDENED` to protect against freelist corruption. The freelist pointer is XORed with a per-cache random value and the pointer's own address.

#### Bypassing the hardening

Despite hardening, researchers have found bypasses:

1. **Information leak first**: If you can leak the XOR key, hardening provides no protection
2. **Partial overwrite**: Overwriting only the lower bytes of a freelist pointer can create valid pointers
3. **Double-free timing**: Control timing of frees to avoid detection

| Config | Protection | Bypass Difficulty |
|--------|-----------|-------------------|
| `SLAB_FREELIST_HARDENED` | Freelist pointer XOR | Medium (need leak) |
| `SLAB_FREELIST_RANDOM` | Random freelist order | Low (probabilistic) |
| `RANDOM_KMALLOC_CACHES` | Multiple caches per size | Medium (more spray) |

---

### Case 4: Cache merging security issues

#### The problem

SLUB merges caches with similar object sizes and flags to reduce memory overhead. When caches merge, objects of different types share the same slab pages, and UAF in one object type can affect the other.

#### The fix

For security-sensitive caches, use `SLAB_ACCOUNT` or `SLAB_NO_MERGE`. Boot option `slub_nomerge` disables all merging (performance cost).

---

### Case 5: Out-of-slab access patterns

#### The bug class

Many vulnerabilities involve accessing memory just outside a slab object (off-by-one, linear overflow). With standard SLUB, this corrupts adjacent objects or freelist pointers.

#### Detection

```bash
# Enable red zoning to detect overflows
slub_debug=Z

# KFENCE for production
CONFIG_KFENCE=y
```

---

### Summary: Lessons learned

| Bug | Year | Root Cause | Exploitation |
|-----|------|------------|--------------|
| CVE-2021-22555 | 2021 | Bounds check error | msg_msg spray |
| CVE-2022-29582 | 2022 | Race condition | Cross-cache attack |
| Freelist bypasses | Ongoing | Hardening limitations | Info leak + craft |
| Cache merging | Design | Memory optimization | Type confusion |

**The pattern**: SLUB bugs are rarely in SLUB itself - they're in code that *uses* SLUB. But understanding SLUB internals is essential for both exploitation and defense.

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
| [eb07c4f39c3e](https://git.kernel.org/linus/eb07c4f39c3e) | v6.5 | SLAB deprecation |
| [16a1d968358a](https://git.kernel.org/linus/16a1d968358a) | v6.8 | SLAB removal |

### Further Reading

- [Bonwick, "The Slab Allocator" (1994)](https://people.eecs.berkeley.edu/~kubitron/courses/cs194-24-S14/hand-outs/bonwick_slab.pdf) - Original design paper

### Related

- [page-allocator](page-allocator.md) - Where SLUB gets its pages
- [overview](overview.md) - How slab fits in the allocator hierarchy
- [Bug Index](bugs/README.md) - Index of all mm kernel bugs

## Further reading

- [page-allocator.md](page-allocator.md) — The buddy system that SLUB draws pages from
- [vmalloc.md](vmalloc.md) — `kvmalloc()` falls back to vmalloc for large allocations that kmalloc cannot satisfy
- [kasan.md](kasan.md) — Kernel Address Sanitizer; uses SLUB debug hooks to detect heap corruption
- [kfence.md](kfence.md) — Low-overhead sampling-based memory safety detector designed to run in production
- [slab-internals.md](slab-internals.md) — Deep dive into SLUB internal data structures and fast-path mechanics
- [mm/slub.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slub.c) — SLUB implementation; `slab_alloc_node()` is the allocation fast path
- [mm/slab_common.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slab_common.c) — Cache creation, merging, and kmalloc size-class setup shared across allocators
- [include/linux/slab.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/slab.h) — Public slab API: `kmalloc`, `kfree`, `kmem_cache_create`
- [LWN: The SLUB allocator](https://lwn.net/Articles/229984/) — Christoph Lameter's original introduction of SLUB and why it supersedes SLAB
- [LWN: Toward a better object allocator](https://lwn.net/Articles/546021/) — Discussion of SLUB improvements and the path toward SLAB removal
- `Documentation/mm/slub.rst` — Kernel documentation on SLUB internals and debugging options
