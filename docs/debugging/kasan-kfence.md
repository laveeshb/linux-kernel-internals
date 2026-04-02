# KASAN and KFENCE

> Memory error detection: out-of-bounds, use-after-free, and heap corruption

## Overview

The kernel has two complementary tools for catching memory errors at runtime:

- **KASAN** (Kernel Address Sanitizer) — comprehensive, deterministic, high overhead; ideal for development and CI
- **KFENCE** (Kernel Electric Fence) — sampling-based, near-zero overhead; suitable for production systems

They can be enabled simultaneously. KFENCE catches what it samples with zero overhead; KASAN catches everything with significant overhead.

---

## KASAN: Kernel Address Sanitizer

`CONFIG_KASAN` enables compile-time instrumentation that checks every memory access against a shadow memory region.

### Shadow memory

Generic KASAN maps every 8 bytes of kernel memory to 1 **shadow byte** stored in a dedicated shadow region. On x86-64, the shadow region starts at `0xfffffe8000000000`.

```
shadow_address = (address >> 3) + 0xfffffe8000000000;
```

The shadow byte encoding:

| Shadow value | Meaning |
|---|---|
| `0` | All 8 bytes are accessible |
| `1`–`7` | First N bytes are accessible; bytes N+1–8 are in a redzone |
| `0x6b` (`KASAN_FREED_MAGIC`) | Object was freed (use-after-free) |
| `0x7d` (`KASAN_REDZONE_MAGIC`) | Slab redzone between objects |
| `0xf9` (`KASAN_GLOBAL_REDZONE`) | Global variable redzone |
| `0xf2` (`KASAN_STACK_LEFT`) | Left stack redzone |
| `0xf3` (`KASAN_STACK_MID`) | Stack mid-redzone |
| `0xf4` (`KASAN_STACK_RIGHT`) | Right stack redzone |
| `0xfc` (`KASAN_KMALLOC_REDZONE`) | kmalloc right redzone |

These constants are defined in `mm/kasan/kasan.h` (older kernels) and `include/linux/kasan-tags.h`.

### Compiler instrumentation

With `CONFIG_KASAN_GENERIC`, GCC/Clang is invoked with `-fsanitize=kernel-address`. The compiler inserts a call before every memory access:

```c
/* Before a 4-byte load from ptr: */
__asan_load4(ptr);

/* Before a 4-byte store to ptr: */
__asan_store4(ptr);
```

These functions are implemented in `mm/kasan/generic.c` (`kasan_check_range()` is the common entry point). They compute the shadow address, read the shadow byte, and report if the access is invalid.

```c
/* Simplified shadow check (mm/kasan/shadow.c): */
static __always_inline bool memory_is_poisoned_1(unsigned long addr)
{
    s8 shadow_value = *(s8 *)kasan_mem_to_shadow((void *)addr);
    if (unlikely(shadow_value)) {
        s8 last_accessible_byte = addr & KASAN_GRANULE_MASK;
        return unlikely(last_accessible_byte >= shadow_value);
    }
    return false;
}
```

### Inline vs. outline instrumentation

`CONFIG_KASAN_INLINE` (default): the shadow check is inlined at each access site — faster but produces a larger kernel binary.

`CONFIG_KASAN_OUTLINE`: the compiler emits a function call to `__asan_load*`/`__asan_store*` — smaller binary, higher call overhead.

### Slab allocator integration

KASAN hooks into the slab allocator via functions defined in `mm/kasan/common.c`:

- `kasan_alloc_pages(page, order, flags)` — called from `__alloc_pages()` to unpoison a newly allocated page
- `kasan_poison_pages(page, order, init)` — called on page free to poison the region
- `kasan_slab_alloc(cache, object, flags, init)` — unpoisons a slab object returned to the caller
- `kasan_slab_free(cache, object, ip)` — poisons a freed slab object with `KASAN_FREED_MAGIC`

For use-after-free detection, KASAN also records allocation and free stack traces:

- `kasan_save_stack(flags)` — captures the current call stack into a ring buffer of stack records
- `kasan_set_track(track, flags)` — stores the captured stack in the object's `kasan_track` metadata

The metadata is stored in a `struct kasan_alloc_meta` appended to each object:

```c
/* include/linux/kasan.h */
struct kasan_alloc_meta {
    struct kasan_track alloc_track;
    struct kasan_track free_track[KASAN_NR_FREE_STACKS];
};
```

### SW-tag KASAN (arm64)

On arm64 with `CONFIG_KASAN_SW_TAGS`, KASAN uses the **top-byte ignore** (TBI) feature: bits [63:56] of a pointer are ignored by the MMU, so KASAN stores a random 8-bit tag there.

- Each `kmalloc` allocation receives a random tag; the pointer returned to the caller has the tag in bits [63:56].
- The shadow byte stores the expected tag for that granule.
- On each access, the compiler-inserted check compares the pointer tag against the shadow tag; mismatch = report.

This reduces false negatives from imprecise granularity and enables catching some inter-object OOB accesses that generic KASAN misses.

### HW-tag KASAN (arm64 MTE)

`CONFIG_KASAN_HW_TAGS` uses ARM **Memory Tagging Extension** (MTE) hardware:

- The CPU stores a 4-bit tag in physical memory alongside each 16-byte granule.
- Pointers carry a matching 4-bit tag in bits [59:56].
- The CPU raises a tag check fault on mismatch — no shadow memory needed, near-zero overhead when idle.
- Integration is in `mm/kasan/hw_tags.c`; the allocator calls `set_tag()`/`get_tag()` wrappers over MTE instructions (`irg`, `stg`, `ldg`).

### KASAN report format

```
==================================================================
BUG: KASAN: use-after-free in skb_put+0x68/0xa4
Write of size 4 at addr ffff888101234560 by task eth0/1234

CPU: 2 PID: 1234 Comm: eth0 Not tainted 6.8.0 #1
Call Trace:
 kasan_report+0xbd/0x100
 kasan_check_range+0x115/0x1a0
 skb_put+0x68/0xa4
 ath9k_rx_tasklet+0x234/0x580 [ath9k]
 tasklet_action_common+0x9a/0x160

Allocated by task 1234:
 kasan_save_stack+0x26/0x50
 __kasan_kmalloc+0x81/0xa0
 skb_alloc+0x44/0x80
 ath9k_rx_alloc+0x12/0x30 [ath9k]

Freed by task 1234:
 kasan_save_stack+0x26/0x50
 __kasan_slab_free+0x120/0x160
 kmem_cache_free+0x68/0x2e0
 dev_kfree_skb+0x18/0x20
 ath9k_rx_complete+0x88/0xc0 [ath9k]

The buggy address belongs to the object at ffff888101234500
 which belongs to the cache skbuff_head_cache of size 232
Shadow bytes around the buggy address:
 ffff888101234400: fb fb fb fb fb fb fb fb fb fb fb fb fb fb fb fb
 ffff888101234480: fb fb fb fb fb fb fb fb fb fb fb fb fb fb fb fb
>ffff888101234500: 6b 6b 6b 6b 6b 6b 6b 6b 6b 6b 6b 6b 6b 6b 6b 6b
                                                              ^
==================================================================
```

Key sections:
1. **Bug type and location** — access type, size, address, offending function
2. **Allocation stack** — where the object was originally allocated
3. **Free stack** — where the object was freed
4. **Shadow dump** — surrounding shadow bytes; `6b` = `KASAN_FREED_MAGIC`

### Overhead

| Resource | Cost |
|---|---|
| Memory | ~12.5% overhead (1 shadow byte per 8 kernel bytes) |
| CPU | ~2–3× slowdown (instrumentation at every access) |
| Inline vs. outline | Inline: ~20% faster, ~40% larger `.text` |

### Enabling KASAN

```bash
# Minimal KASAN configuration:
CONFIG_KASAN=y
CONFIG_KASAN_GENERIC=y       # or KASAN_SW_TAGS / KASAN_HW_TAGS on arm64
CONFIG_KASAN_INLINE=y        # inline shadow checks (faster)
CONFIG_DEBUG_INFO=y          # needed for stack trace symbols
CONFIG_SLUB_DEBUG=y          # enables SLUB metadata needed by KASAN
CONFIG_STACKTRACE=y          # capture allocation/free stacks

# Optional but recommended:
CONFIG_KASAN_STACK=y         # detect stack OOB (some overhead)
CONFIG_KASAN_VMALLOC=y       # detect vmalloc OOB
CONFIG_KASAN_MODULE_TEST=y   # test module for self-check
```

---

## KFENCE: Kernel Electric Fence

`CONFIG_KFENCE` provides a **sampling** memory error detector with near-zero average overhead, suitable for production kernels.

### How it works

KFENCE does not use shadow memory. Instead it maintains a small **KFENCE pool** of objects, each surrounded by **guard pages** (unmapped pages). An out-of-bounds write to a guard page causes an immediate page fault, which KFENCE intercepts and reports.

```
KFENCE pool layout (one slot):
┌─────────────────┐  ← unmapped guard page (4 KB)
│  GUARD PAGE     │    OOB access here → page fault → KFENCE report
├─────────────────┤
│  object (N bytes)│   ← the actual allocation (right-aligned in page)
├─────────────────┤
│  GUARD PAGE     │  ← unmapped guard page (4 KB)
│                 │    OOB access here → page fault → KFENCE report
└─────────────────┘
```

Objects are **right-aligned** within their page so that a one-byte overrun immediately hits the following guard page.

For **use-after-free** detection: when a KFENCE object is freed, its page is marked inaccessible (similar to `mprotect(PROT_NONE)`). Any subsequent access faults and triggers a KFENCE report.

### Sampling

KFENCE is not invoked for every allocation. Instead, the slab allocator calls `kfence_alloc()` at a configurable rate:

```c
/* mm/kfence/core.c — called from slab allocator hot path */
void *__kfence_alloc(struct kmem_cache *s, size_t size, gfp_t flags)
{
    if (!kfence_allocation_gate.counter)
        return NULL;        /* not time to sample yet */
    /* ... */
    return kfence_alloc(s, size, flags);
}
```

The gate counter decrements by one on each allocator invocation. When it reaches zero, the next allocation is redirected into the KFENCE pool and the counter resets to `kfence_sample_interval` (in milliseconds, converted to allocation counts using a timer).

### Configuration

```bash
# Kconfig:
CONFIG_KFENCE=y
CONFIG_KFENCE_NUM_OBJECTS=255   # number of KFENCE slots (default 255)
                                 # more slots = higher detection probability
                                 # each slot uses 2 pages (guard + object)

# Boot parameter:
kfence.sample_interval=100      # sample one allocation every ~100 ms (default)
                                 # 0 = disable KFENCE
                                 # lower value = more coverage, more memory used

# Sysctl (runtime adjustment):
echo 50 > /sys/module/kfence/parameters/sample_interval
```

### KFENCE pool size

With `CONFIG_KFENCE_NUM_OBJECTS=255` and 2 pages (8 KB) per slot, the pool uses ~2 MB of physical memory. Each slot is a fixed-size region; objects smaller than a page are right-aligned within the slot's data page.

The pool is allocated at boot in `kfence_init()` (`mm/kfence/core.c`) and registered with the page allocator to keep it from being reclaimed.

### KFENCE report format

```
==================================================================
BUG: KFENCE: out-of-bounds write in kstrdup+0x48/0x70

Out-of-bounds write at 0xffff888080a3c007 (1B left of kfence-#42):
 kstrdup+0x48/0x70
 driver_attach+0x18/0x40
 bus_add_driver+0x1a0/0x2a0

kfence-#42 [0xffff888080a3c000-0xffff888080a3c006, size=7, cache=kmalloc-8] allocated by task 1:
 kfence_alloc+0x7c/0xb0
 __kmalloc+0x3e/0x80
 kstrdup+0x20/0x70
 driver_register+0x30/0x60

CPU: 0 PID: 1 Comm: swapper Not tainted 6.8.0 #1
==================================================================
```

Key fields:
- **kfence-#42** — the KFENCE slot number
- **0xffff888080a3c000-0xffff888080a3c006** — the object address range (7 bytes)
- **1B left of kfence-#42** — the overrun distance

### Limitations vs. KASAN

KFENCE only catches errors in the sampled allocations. An OOB or UAF in a non-sampled allocation is invisible to KFENCE. This is intentional — the trade-off gives production-safe overhead.

---

## KASAN vs. KFENCE comparison

| Property | KASAN (generic) | KFENCE |
|---|---|---|
| Detection coverage | All allocations | Sampled (~1 per interval) |
| Overhead (CPU) | ~2–3× | ~0% (amortized) |
| Overhead (memory) | ~12.5% shadow | ~2 MB fixed pool |
| False negatives | Very few (8-byte granularity) | Many (only sampled objects) |
| False positives | None | None |
| Deterministic | Yes | No (sampling) |
| Production use | No | Yes |
| OOB detection | Shadow byte check | Guard page fault |
| UAF detection | Shadow byte (`KASAN_FREED_MAGIC`) | Guard page (mprotect) |
| Allocation stack | Yes | Yes |
| Free stack | Yes | Yes |
| Kernel version | 4.0+ | 5.12+ |
| Arm64 hardware variant | MTE (HW-tag KASAN) | N/A |

### Using both together

Enable both in development kernels. KASAN catches everything; KFENCE adds an independent detector and its reports appear in production-like workloads where KASAN overhead is too high to run continuously.

```bash
CONFIG_KASAN=y
CONFIG_KFENCE=y
# KFENCE takes priority for sampled allocations; KASAN covers the rest
```

---

## Further reading

- [KCSAN](kcsan.md) — data race detection (complements KASAN)
- [syzkaller](syzkaller.md) — fuzzer that uses KASAN to find bugs automatically
- [Oops Analysis](oops-analysis.md) — decoding stack traces from KASAN reports
- [KASAN in mm/](../mm/kasan.md) — memory-management perspective
- [KFENCE in mm/](../mm/kfence.md) — allocator integration details
- `mm/kasan/` — KASAN implementation
- `mm/kfence/` — KFENCE implementation
- `Documentation/dev-tools/kasan.rst`
- `Documentation/dev-tools/kfence.rst`
