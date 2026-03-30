# Page Poisoning and Memory Zeroing

> Catching use-after-free bugs and enforcing memory hygiene with kernel poisoning mechanisms

The Linux kernel provides several overlapping mechanisms for filling memory with known patterns before or after use. Some are purely for debugging (catching bugs), others are for security (preventing data leakage). Understanding which tool to reach for requires knowing how they differ.

## Overview

| Mechanism | Layer | Pattern | Goal | Config |
|-----------|-------|---------|------|--------|
| `CONFIG_PAGE_POISONING` | Page allocator | `0xAA` (free), `0x00` (alloc) | Debug: catch UAF and use-before-init | `CONFIG_PAGE_POISONING` |
| `init_on_alloc` / `init_on_free` | Page + slab | `0x00` (zero) | Security: prevent data leakage | Boot parameter (v5.3+) |
| `slub_debug=P` | SLUB slab cache | `0x6b` (free), `0xa5` (redzone) | Debug: catch slab UAF and overflows | `CONFIG_SLUB_DEBUG` + boot param |

These are independent mechanisms. They can be combined, though some combinations are redundant (e.g., enabling both `CONFIG_PAGE_POISONING` and `init_on_free=1` zeros the same pages twice).

## CONFIG_PAGE_POISONING: Debug Poisoning

### What It Does

`CONFIG_PAGE_POISONING` causes the page allocator to fill pages with a known byte pattern when they are freed, then verify that pattern has not been disturbed when the page is next allocated.

The implementation lives in [`mm/page_poison.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_poison.c).

The pattern used:

- **On free**: pages are filled with `0xAA` (by `kernel_poison_pages()` called from `__free_pages_ok()` in [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c))
- **On alloc**: the kernel verifies every byte is still `0xAA` before handing the page to the requester, then fills with `0x00`

```
Page lifecycle with CONFIG_PAGE_POISONING:

  Allocate page
  ┌────────────────────────┐
  │  verify all bytes == 0xAA  │  ← if not: BUG (someone wrote after free)
  │  fill with 0x00            │  ← caller gets zeroed page
  └────────────────────────┘
          │
          │  (caller uses page)
          ▼
  Free page
  ┌────────────────────────┐
  │  fill with 0xAA            │  ← poison marker
  └────────────────────────┘
          │
          │  (page sits on free list)
          ▼
  Next allocation from this page:
  ┌────────────────────────┐
  │  verify all bytes == 0xAA  │  ← catches writes that happened while freed
  └────────────────────────┘
```

### How It Catches Use-After-Free

When code writes to a freed page, it overwrites some `0xAA` bytes. The next time that page is allocated, the verification scan finds bytes that do not match `0xAA` and reports the corruption.

The catch is timing: the write can happen anytime between the free and the next allocation. If the page is quickly recycled, the window is small. If the page sits on the free list for a while (e.g., under low allocation pressure), longer-lived writes are also detected.

### Enabling It

```
# Kernel config
CONFIG_PAGE_POISONING=y
```

You can also toggle poisoning at boot time (it is **off** by default even when compiled in):

```bash
# Enable at boot (required — CONFIG_PAGE_POISONING=y alone does not enable it)
page_poison=on

# Explicitly disable (the default)
page_poison=off
```

### Performance Cost

Page poisoning adds a full page write on every free and a full page read (verify) plus write (zero) on every allocation. For order-0 pages (4KB on x86), this is two extra memory operations per allocation cycle. For high-order pages (e.g., 2MB huge pages), the cost scales linearly with page size.

In practice, the overhead is measurable but workload-dependent. Allocation-heavy workloads (e.g., network-intensive, frequent small allocations) see higher overhead than workloads that allocate once at startup. This tool is suitable for development kernels and CI, not production.

### Reading a Page Poisoning Report

When the verification detects a corrupted byte, the kernel emits a message like:

```
BUG: Bad page state in process kworker/0:1  pfn:0x12ab3
page:ffffea00004aac00 refcount:0 mapcount:0 mapping:0000000000000000 index:0x0 pfn:0x12ab3
flags: 0x200000000000000(zone=2)
raw: 0200000000000000 ffffea00004aac08 ffffea00004aac08 0000000000000000
raw: 0000000000000000 0000000000000000 00000000ffffffff 0000000000000000
page dumped because: PAGE_FLAGS_CHECK_AT_FREE flag(s) set
Poison overwritten
First byte 0x0 instead of 0xaa
Call Trace:
 dump_stack+0x48/0x5e
 bad_page+0xb0/0x100
 check_new_page_bad+0x48/0x70
 get_page_from_freelist+0x590/0x13e0
 __alloc_pages_nodemask+0x12b/0x280
 ...
```

**Reading the report**:

1. `Poison overwritten` — the poisoning check failed; some code wrote to this page while it was on the free list
2. `First byte 0x0 instead of 0xaa` — the specific byte value found (here: zero, meaning the write was a zeroing operation or bzero-style memset)
3. The call trace shows **who allocated the page** and triggered the check — not who wrote to it (that would require KASAN or a watchpoint)
4. To find the writer, cross-reference with KASAN or add a hardware watchpoint (`perf mem`) on the poisoned address

!!! tip "Combining with KASAN"
    `CONFIG_PAGE_POISONING` and KASAN serve complementary roles. KASAN (see [KASAN](kasan.md)) catches the write at the moment it happens (with a precise stack trace). Page poisoning catches it at the next allocation, which is simpler to enable but gives you less information about the culprit. Run both together in a debug build for maximum coverage.

### When to Use It

Use `CONFIG_PAGE_POISONING` when:

- You suspect a use-after-free involving page-level allocations (not slab objects — for slab, use `slub_debug=P`)
- You want a simple, compiler-independent check (unlike KASAN, no special compiler flags needed)
- You are running a VM or low-performance system where KASAN's overhead is too high

## init_on_alloc and init_on_free: Security Zeroing

### What They Do

Introduced in Linux v5.3, `init_on_alloc` and `init_on_free` are **security features**, not debugging tools. Their purpose is to prevent sensitive kernel data from leaking into new allocations.

**Commit**: [6471384af2a6](https://git.kernel.org/linus/6471384af2a6) ("mm: security: introduce init_on_alloc=1 and init_on_free=1 boot options")
**Author**: Alexander Potapenko

The implementation hooks are in [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) (for pages) and [`mm/slab_common.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slab_common.c) (for slab).

- **`init_on_alloc=1`**: Every page and slab allocation is zeroed before being handed to the caller. The caller sees `0x00` for every byte.
- **`init_on_free=1`**: Every page and slab object is zeroed when freed. The freed memory is cleared before it goes back to the allocator.

```
init_on_free=1 (security focus):
  Caller frees memory
  └─→ kernel zeros it immediately           ← sensitive data erased now
      └─→ memory sits on free list (zeroed)
          └─→ next caller gets zeroed memory (bonus)

init_on_alloc=1 (simpler, slightly different guarantee):
  Caller requests memory
  └─→ kernel zeros it right before returning ← sensitive data from previous
      └─→ caller gets zeroed memory             owner is cleared
```

`init_on_free` gives the stronger security guarantee: it ensures data is erased at the moment of release, even if the memory is never reallocated (e.g., freed kernel buffers that sit idle).

### How It Differs from Debug Poisoning

| Aspect | `CONFIG_PAGE_POISONING` | `init_on_alloc/free` |
|--------|------------------------|---------------------|
| Pattern | `0xAA` on free, verify on alloc | `0x00` (zero) always |
| Goal | Debug: detect writes to freed memory | Security: erase sensitive data |
| Detects UAF | Yes (nonzero pattern) | No (zeros are not verified on alloc) |
| Overhead | 2× read+write per page cycle | 1× write per alloc or free |
| Compiler needed | No | No |
| Scope | Pages only | Pages and slab objects |

The key distinction: `0xAA` patterns are useless for security (an attacker can simply look for `0xAA` bytes and know the memory is not sensitive) but useful for debugging (a write of any other value is detectable). Zeroing is useful for security but invisible to debugging (a zero write to a freed page looks the same as the expected zero pattern).

### Enabling It

```bash
# Boot parameters (no recompilation needed)
init_on_alloc=1
init_on_free=1

# Or set both
init_on_alloc=1 init_on_free=1
```

These can also be set as compile-time defaults:

```
CONFIG_INIT_ON_ALLOC_DEFAULT_ON=y
CONFIG_INIT_ON_FREE_DEFAULT_ON=y
```

### Performance Cost

The v5.3 commit message measured the overhead on kernel compilation (a CPU-and-allocation-intensive workload):

- `init_on_alloc=1`: approximately 2% slowdown on kernel build
- `init_on_free=1`: approximately 1% slowdown on kernel build

These figures reflect a CPU-bound workload. Memory-allocation-heavy workloads (network stack, filesystem I/O, large heap churn) will see higher relative overhead because the zeroing touches more memory per unit of work. Workloads that allocate large contiguous buffers once and reuse them see near-zero overhead.

!!! note
    If `CONFIG_PAGE_POISONING` is also enabled, `init_on_free` and page poisoning both run on free. The kernel does not deduplicate them automatically; you may zero pages twice. Disable one if you enable the other for production-like performance testing.

### When to Use It

- **Security-sensitive kernels**: Enable `init_on_free=1` to comply with security hardening guides (e.g., KSPP recommendations)
- **Containers and multi-tenant workloads**: Prevent tenant A's freed memory from being readable by tenant B after reallocation
- **Not a debugging tool**: If you are trying to catch a use-after-free, use KASAN or `CONFIG_PAGE_POISONING` instead

## slub_debug Poisoning: Slab-Level Debugging

### What It Does

`CONFIG_PAGE_POISONING` operates at the page allocator level and catches bugs involving raw page allocations. Most kernel allocations go through the slab allocator (`kmalloc`, `kmem_cache_alloc`), which carves pages into smaller objects. For those, you need slab-level poisoning.

SLUB (the default slab allocator since v2.6.23) has built-in debug support controlled by the `slub_debug` boot parameter. The `P` flag enables poisoning.

The implementation is in [`mm/slub.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slub.c).

### The Poison Patterns

SLUB poisoning uses two distinct byte values (defined in [`include/linux/poison.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/poison.h)):

| Pattern | Value | Meaning |
|---------|-------|---------|
| `POISON_FREE` | `0x6b` (`k` in ASCII) | Object has been freed |
| `POISON_END` | `0xa5` | End-of-object marker (redzone boundary) |
| `POISON_INUSE` | `0x5a` | Object is in use (some allocators) |

On free, the object body is filled with `0x6b` and the redzone bytes are set to `0xa5`. On the next allocation, SLUB verifies these patterns before returning the object.

```
SLUB object layout with poisoning (P flag) and redzones (Z flag):

  ┌──────────┬─────────────────────────────┬──────────┐
  │ redzone  │    object body (0x6b when   │ redzone  │
  │ (0xa5)   │    free, data when in use)  │ (0xa5)   │
  └──────────┴─────────────────────────────┴──────────┘
```

The `0x6b` value (`k` in ASCII) is a recognizable signature in memory dumps, making it easy to spot freed slab memory in crash analysis tools like `crash(8)`.

### Enabling SLUB Poisoning

```bash
# Enable for all slab caches
slub_debug=P

# Combine with other flags (recommended for thorough debugging)
slub_debug=FZPU
# F = sanity checks
# Z = redzones (catch overflows into adjacent objects)
# P = poisoning (catch use-after-free)
# U = track allocation/free stacks

# Enable only for a specific cache (e.g., the ext4_inode_cache)
slub_debug=P,ext4_inode_cache

# Enable only for kmalloc-64
slub_debug=P,kmalloc-64
```

Alternatively, target a specific cache at runtime via sysfs:

```bash
# Check which caches exist
ls /sys/kernel/slab/

# Enable poisoning for a specific cache at runtime
# (only effective for objects not yet allocated in that cache)
echo 1 > /sys/kernel/slab/kmalloc-64/poison
```

Require `CONFIG_SLUB_DEBUG=y` in the kernel config (typically enabled in debug kernels automatically).

### How It Catches Slab Use-After-Free

When code writes to a freed slab object, it overwrites some `0x6b` bytes. The next time an object is taken from that slab, SLUB's `check_object()` function scans the body for bytes that are not `0x6b`. If found, it reports a poison corruption:

```
=============================================================================
BUG kmalloc-64 (Tainted: G    B   ): Poison overwritten
-----------------------------------------------------------------------------

INFO: 0xffff888100a51640-0xffff888100a5167f @offset=1600. First byte 0x0 instead of 0x6b
INFO: Allocated in bad_driver_init+0x38/0x60 age=142 cpu=0 pid=1234
INFO: Freed in bad_driver_exit+0x20/0x40 age=12 cpu=0 pid=1234
INFO: The buggy address belongs to the object at ffff888100a51640
 which belongs to the cache kmalloc-64 of size 64

Call Trace:
 dump_stack+0x48/0x5e
 print_trailer+0xf0/0x150
 object_err+0x2e/0x40
 check_object+0x218/0x270          ← SLUB poison verification
 alloc_debug_processing+0x6e/0x170
 ___slab_alloc+0x42e/0x560
 kmalloc_trace+0x26/0x50
 ...
```

**Reading the report**:

1. `BUG kmalloc-64: Poison overwritten` — a freed object in the `kmalloc-64` cache was written to while free
2. `First byte 0x0 instead of 0x6b` — byte at offset 0 of the object is `0x0`, not the expected `0x6b` poison
3. `Allocated in` / `Freed in` — SLUB tracks the last allocation and free site (requires the `U` flag in `slub_debug`)
4. The call trace shows who triggered the check (the next allocator), not who did the write

### When to Use It

Use `slub_debug=P` when:

- You suspect a use-after-free in a slab-allocated object (most `kmalloc` and `kmem_cache_alloc` objects fall here)
- You want to identify which specific slab cache is involved (use the cache-specific form: `slub_debug=P,mycache`)
- You want lower overhead than full KASAN but still need poison-level coverage

!!! warning "Performance impact"
    `slub_debug=FZPU` applied to all caches can slow down a system by 5–10x on allocation-heavy workloads. If performance matters, target only the suspect cache with `slub_debug=P,cache_name`.

## Choosing the Right Tool

```
Use-after-free suspicion
├── Involves a page-level allocation (vmalloc, alloc_pages)?
│   └── CONFIG_PAGE_POISONING
├── Involves a slab object (kmalloc, kmem_cache_alloc)?
│   ├── Want precise "who did it" with stack trace → KASAN (see kasan.md)
│   ├── Want pattern-based detection with lower overhead → slub_debug=P
│   └── Running in production → KFENCE (see kfence.md)
└── Security concern (prevent data leakage between tenants)?
    └── init_on_free=1
```

## Key Source Files

| File | Description |
|------|-------------|
| [`mm/page_poison.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_poison.c) | `CONFIG_PAGE_POISONING` implementation: `kernel_poison_pages()`, `kernel_unpoison_pages()` |
| [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) | Page allocator hooks that call poisoning and `init_on_alloc/free` |
| [`mm/slub.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slub.c) | SLUB allocator: `set_freepointer()`, `check_object()`, poison fill and verify |
| [`mm/slab_common.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slab_common.c) | `init_on_alloc` / `init_on_free` hooks for the slab layer |
| [`include/linux/poison.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/poison.h) | Poison byte constants: `POISON_FREE` (`0x6b`), `POISON_END` (`0xa5`) |

## History

### CONFIG_PAGE_POISONING

Page poisoning predates systematic git history tracking. The `PAGE_POISONING` config option and `0xAA` pattern have been present in the kernel for many years as a debugging aid; the current `mm/page_poison.c` file consolidates the logic that was previously scattered across `mm/page_alloc.c`.

### init_on_alloc / init_on_free (v5.3, 2019)

**Commit**: [6471384af2a6](https://git.kernel.org/linus/6471384af2a6) ("mm: security: introduce init_on_alloc=1 and init_on_free=1 boot options")
**Author**: Alexander Potapenko
**LWN coverage**: [Initializing memory on allocation and release](https://lwn.net/Articles/791380/) (2019)

Motivated by a class of information disclosure vulnerabilities where kernel memory from one context was reused in another without being cleared. The patch was part of a broader push to make the kernel's memory lifecycle safer by default, aligned with the Kernel Self Protection Project (KSPP).

### slub_debug Poisoning

SLUB was introduced in v2.6.23 (2007) as a replacement for SLAB. The `P` (poisoning) flag and `0x6b`/`0xa5` patterns were part of SLUB's debug infrastructure from the beginning, carrying forward conventions from the older SLAB allocator. The sysfs interface at `/sys/kernel/slab/<cache>/poison` enables per-cache control without rebooting.

## Further Reading

### Kernel Documentation

- [Documentation/mm/slub.rst](https://docs.kernel.org/mm/slub.html) — SLUB allocator documentation including `slub_debug` flag reference
- [Documentation/admin-guide/kernel-parameters.txt](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/admin-guide/kernel-parameters.txt) — `page_poison`, `init_on_alloc`, `init_on_free`, `slub_debug` boot parameters

### LWN Articles

- [Initializing memory on allocation and release](https://lwn.net/Articles/791380/) — design rationale for `init_on_alloc/free` (2019)

### Related

- [KASAN](kasan.md) — compiler-instrumented memory error detection; catches use-after-free at the moment of the write, with a precise stack trace
- [KFENCE](kfence.md) — sampling-based memory error detection safe for production use
- [OOM debugging](oom-debugging.md) — diagnosing and preventing out-of-memory kills
- [slab](slab.md) — the SLUB allocator internals and how slab caches are managed
