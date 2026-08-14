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

Generic KASAN maps every 8 bytes of kernel memory to 1 **shadow byte** stored in a dedicated shadow region. On x86-64 with 4-level paging, the shadow region starts at `0xdffffc0000000000` (the `KASAN_SHADOW_OFFSET`).

```
shadow_address = (address >> 3) + 0xdffffc0000000000;
```

The shadow byte encoding:

| Shadow value | Meaning |
|---|---|
| `0` | All 8 bytes are accessible |
| `1`–`7` | First N bytes are accessible; bytes N+1–8 are in a redzone |
| `0xFB` (`KASAN_SLAB_FREE`) | Object was freed (use-after-free) |
| `0xFC` (`KASAN_SLAB_REDZONE`) | kmalloc right redzone |
| `0xf9` (`KASAN_GLOBAL_REDZONE`) | Global variable redzone |
| `0xF1` (`KASAN_STACK_LEFT`) | Left stack redzone |
| `0xF2` (`KASAN_STACK_MID`) | Stack mid-redzone |
| `0xF3` (`KASAN_STACK_RIGHT`) | Right stack redzone |
| `0xF4` (`KASAN_STACK_PARTIAL`) | Partial stack frame redzone |

These constants are defined in `mm/kasan/kasan.h`. (`include/linux/kasan-tags.h` defines a separate set of pointer-tag constants — `KASAN_TAG_KERNEL`, `KASAN_TAG_INVALID`, etc. — used by the SW-tag/HW-tag modes below, not these poison/redzone values.)

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
/* Simplified shadow check (mm/kasan/generic.c): */
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

- `kasan_unpoison_pages(page, order, init)` — called from `__alloc_pages()` to unpoison a newly allocated page
- `kasan_poison_pages(page, order, init)` — called on page free to poison the region
- `kasan_slab_alloc(cache, object, flags, init)` — unpoisons a slab object returned to the caller
- `kasan_slab_free(cache, object, ...)` — poisons a freed slab object with `KASAN_SLAB_FREE (0xFB)`

For use-after-free detection, KASAN also records allocation and free stack traces:

- `kasan_save_stack(flags)` — captures the current call stack into a ring buffer of stack records
- `kasan_set_track(track, stack)` — stores the captured stack in the object's `kasan_track` metadata

The allocation-side metadata is stored in a `struct kasan_alloc_meta`, held inside the object's redzone; free-side metadata lives in a separate `struct kasan_free_meta`, stored within the freed object's own memory:

```c
/* mm/kasan/kasan.h */
struct kasan_alloc_meta {
    struct kasan_track alloc_track;
    /* Free track is stored in kasan_free_meta. */
    depot_stack_handle_t aux_stack[2];
};

struct kasan_free_meta {
    struct qlist_node quarantine_link;
    struct kasan_track free_track;
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
 ffff888101234400: fd fd fd fd fd fd fd fd fd fd fd fd fd fd fd fd
 ffff888101234480: fd fd fd fd fd fd fd fd fd fd fd fd fd fd fd fd
>ffff888101234500: fb fb fb fb fb fb fb fb fb fb fb fb fb fb fb fb
                                                              ^
==================================================================
```

Key sections:
1. **Bug type and location** — access type, size, address, offending function
2. **Allocation stack** — where the object was originally allocated
3. **Free stack** — where the object was freed
4. **Shadow dump** — surrounding shadow bytes; `fb` = `KASAN_SLAB_FREE` (freed slab object)

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

KFENCE is not invoked for every allocation. Instead, the slab allocator calls `__kfence_alloc()` at a configurable rate:

```c
/* mm/kfence/core.c — simplified; called from slab allocator hot path */
void *__kfence_alloc(struct kmem_cache *s, size_t size, gfp_t flags)
{
    /* Each call claims one tick of the gate; only the call that brings
     * it from 0 to 1 samples this allocation into the KFENCE pool. */
    int allocation_gate = atomic_inc_return(&kfence_allocation_gate);
    if (allocation_gate > 1)
        return NULL;         /* not this allocation's turn */

    return kfence_guarded_alloc(s, size, flags, ...);
}
```

A periodic work item (`toggle_allocation_gate()`) fires every `kfence_sample_interval` milliseconds and resets `kfence_allocation_gate` to `-kfence_burst` — allowing a burst of up to `kfence_burst + 1` samples per interval, not just one (`kfence_burst` defaults to 0, i.e. one sample per interval). Each call to `__kfence_alloc()` atomically increments the gate via `atomic_inc_return()`; only the call whose result is `≤ 1` gets redirected into the KFENCE pool. When `CONFIG_KFENCE_STATIC_KEYS` is enabled, a static branch (`kfence_allocation_key`) also gates the fast path so non-sampled allocations skip this check almost entirely.

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
| UAF detection | Shadow byte (`KASAN_SLAB_FREE`, 0xFB) | Guard page (mprotect) |
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

### Kernel source

- [mm/kasan/report.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kasan/report.c) — `kasan_report()` and `print_report()`: the report-generation code behind the KASAN report format shown above
- [mm/kasan/kasan.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kasan/kasan.h) — internal header holding the actual shadow-byte constants (`KASAN_SLAB_FREE`, `KASAN_SLAB_REDZONE`, etc.) and the `kasan_alloc_meta`/`kasan_free_meta` layout
- [mm/kfence/core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kfence/core.c) — `__kfence_alloc()` and the `kfence_allocation_gate` sampling counter referenced above
- [mm/kfence/report.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kfence/report.c) — `kfence_report_error()`: the report-generation code behind the KFENCE report format shown above

### Related pages

- [KCSAN](kcsan.md) — data race detection (complements KASAN)
- [syzkaller](syzkaller.md) — fuzzer that uses KASAN to find bugs automatically
- [Oops Analysis](oops-analysis.md) — decoding stack traces from KASAN reports
- [KASAN in mm/](../mm/kasan.md) — shadow memory layout, the three tagging modes, and compiler instrumentation in depth
- [KFENCE in mm/](../mm/kfence.md) — pool layout, guard-page mechanics, and sampling design in depth

### External

- [KASAN official documentation](https://docs.kernel.org/dev-tools/kasan.html) — report-format reference, boot parameters (`kasan.mode`, `kasan.fault`, `kasan.stacktrace`), and how to run the KUnit test suite
- [KFENCE official documentation](https://docs.kernel.org/dev-tools/kfence.html) — report-format reference, the `/sys/kernel/debug/kfence/{stats,objects}` interface, and boot/sysfs tuning parameters
