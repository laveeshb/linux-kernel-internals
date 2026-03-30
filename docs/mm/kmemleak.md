# Kmemleak (Kernel Memory Leak Detector)

> Finding unreferenced kernel allocations with a garbage-collection style scan

## What Is Kmemleak?

Kmemleak is a kernel subsystem that detects **memory leaks** in the kernel — allocations that are no longer referenced by any pointer but have never been freed. These are sometimes called *orphaned* allocations. They do not cause immediate crashes, but they silently consume memory that can never be reclaimed, eventually leading to exhaustion.

Kmemleak is documented at [`Documentation/dev-tools/kmemleak.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/dev-tools/kmemleak.rst) and implemented in [`mm/kmemleak.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kmemleak.c).

## How Kmemleak Differs from KASAN and KFENCE

Kmemleak, [KASAN](kasan.md), and [KFENCE](kfence.md) all guard kernel memory, but they target fundamentally different failure modes:

| Tool | What it catches | How it works | Deployment |
|------|----------------|--------------|------------|
| Kmemleak | Memory **leaks** (never freed) | Garbage-collection scan, gray-coloring | Testing, debug builds |
| [KASAN](kasan.md) | **Use-after-free**, out-of-bounds, double-free | Shadow memory + compiler instrumentation | Testing, CI |
| [KFENCE](kfence.md) | Use-after-free, out-of-bounds (sampled) | Guard pages, hardware page faults | Production, always-on |

A buffer that is allocated, its only pointer is overwritten without freeing it, and then the allocation is forgotten: KASAN and KFENCE are silent (no bad access happened). Only kmemleak reports it.

Conversely, kmemleak cannot tell you that a freed pointer was accessed again. That is KASAN's domain.

## How Kmemleak Works

### The Gray-Coloring Algorithm

Kmemleak uses an algorithm inspired by **garbage collector tri-color marking**. Every tracked allocation is assigned one of three states:

```
White  ── not yet reachable from any root; candidate for reporting
Gray   ── reachable (a pointer to it was found during scanning)
Black  ── explicitly told to ignore (kmemleak_ignore only)
```

At the end of a scan:

- **Gray objects** are considered live. They will not be reported.
- **White objects** (those never colored gray) are *potentially leaked* — no pointer to them was found anywhere in the scanned memory.

The algorithm is described in the source at the top of [`mm/kmemleak.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kmemleak.c).

### What Gets Scanned

To find pointers, kmemleak scans:

1. **Data and BSS segments** of the kernel image — global/static variables that might hold pointers to allocations
2. **The init section** (`.init.data`) before it is freed
3. **Per-CPU data areas** — per-CPU variables that could hold allocation pointers
4. **Stack of every thread** — each task's kernel stack is scanned for pointer-like values
5. **Extra scan areas** explicitly registered via `kmemleak_scan_area()` — used by subsystems that store pointers in memory regions not covered by the above

Any value in any of these regions that **looks like** a pointer into a tracked allocation marks that allocation gray (reachable).

### What "Looks Like a Pointer" Means

Kmemleak uses a conservative approach: **any word-sized value that falls within the address range of a tracked allocation is treated as a valid pointer**. This is intentionally liberal to avoid false positives.

The consequence is false negatives: if the pointer is stored in a form kmemleak cannot read (e.g., XOR-obfuscated linked list pointers, packed bitfields, or offsets rather than direct pointers), kmemleak will miss it and falsely report the allocation as leaked. This is a known limitation — see [Limitations](#limitations) below.

### Tracking Allocations

Kmemleak hooks into the kernel allocator by way of callbacks declared in [`include/linux/kmemleak.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/kmemleak.h):

| Allocator event | Kmemleak callback |
|----------------|-------------------|
| `kmalloc()` / `kmem_cache_alloc()` | `kmemleak_alloc()` — register new object |
| `kfree()` / `kmem_cache_free()` | `kmemleak_free()` — unregister object |
| `vmalloc()` | `kmemleak_vmalloc()` |
| `vfree()` | `kmemleak_free()` |

These hooks are called from deep inside the slab allocator ([`mm/slab_common.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slab_common.c), [`mm/slub.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slub.c)) and are compiled out entirely when `CONFIG_DEBUG_KMEMLEAK` is not set.

Each tracked object is represented by a `struct kmemleak_object` (defined in `mm/kmemleak.c`) that stores:

- The allocation pointer and size
- The allocation stack trace (captured at `kmemleak_alloc()` time)
- Reference count and state flags
- Minimum number of pointer references required before declaring a leak (default 1; set via the `min_count` parameter to `kmemleak_alloc()`)

### The Scan Thread

A kernel thread (`kmemleak` kthread) periodically executes `kmemleak_scan()`. The scan:

1. **Marks all objects white** (candidate state)
2. **Walks all scan areas** (data, BSS, per-CPU, stacks) looking for pointer values
3. **Colors reachable objects gray** — objects pointed to by a scanned root are marked reachable via `make_gray_object()`
4. **Reports survivors** — any object still white after the full walk is reported as a potential leak

The scan is also triggered on demand via the debugfs interface (see [Using Kmemleak](#using-kmemleak)).

## Enabling Kmemleak

### Kernel Configuration

```
CONFIG_DEBUG_KMEMLEAK=y

# Optional: early log buffer for boot-time leaks
CONFIG_DEBUG_KMEMLEAK_DEFAULT_OFF=n   # Enable at boot (default)
# or
CONFIG_DEBUG_KMEMLEAK_DEFAULT_OFF=y   # Boot disabled; enable via boot param

# Auto-scan interval in seconds (default: 600)
CONFIG_DEBUG_KMEMLEAK_AUTO_SCAN=y
```

Enabling kmemleak requires `CONFIG_DEBUG_KMEMLEAK=y`. The related options are defined in [`lib/Kconfig.debug`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/Kconfig.debug).

!!! warning "Not for production"
    Kmemleak adds measurable memory and CPU overhead (see [Performance Overhead](#performance-overhead)). It is intended for development and debugging builds, not production deployment.

### Boot Parameters

```bash
# Disable kmemleak entirely (even if compiled in)
kmemleak=off

# Enable even if CONFIG_DEBUG_KMEMLEAK_DEFAULT_OFF=y
kmemleak=on
```

### Verifying Kmemleak Is Active

```bash
# Check configuration
zcat /proc/config.gz | grep KMEMLEAK

# Check boot messages
dmesg | grep kmemleak

# Check that debugfs interface exists
ls /sys/kernel/debug/kmemleak
```

## Using Kmemleak

### The debugfs Interface

Kmemleak exposes a single file at `/sys/kernel/debug/kmemleak` that serves as both a control channel (writes) and a report interface (reads).

#### Reading Reports

```bash
# Trigger a scan and then read results
echo scan > /sys/kernel/debug/kmemleak
cat /sys/kernel/debug/kmemleak
```

A typical leak report looks like:

```
unreferenced object 0xffff88801a2b4c00 (size 128):
  comm "insmod", pid 1423, jiffies 4295032145 (age 142.340s)
  hex dump (first 32 bytes):
    74 65 73 74 20 62 75 66 66 65 72 20 63 6f 6e 74  test buffer cont
    65 6e 74 00 00 00 00 00 00 00 00 00 00 00 00 00  ent.............
  backtrace:
    [<00000000deadbeef>] kmalloc_trace+0x2a/0x40
    [<00000000cafebabe>] leaky_function+0x34/0x60 [my_module]
    [<00000000f00df00d>] do_one_initcall+0x80/0x2a0
    [<00000000abcd1234>] do_init_module+0x5e/0x220
```

**Reading the report**:

| Field | Meaning |
|-------|---------|
| `unreferenced object 0xffff...` | Allocation address found with no pointer to it |
| `size 128` | Allocation size in bytes |
| `comm / pid / jiffies` | Task name, PID, and kernel timestamp at allocation time |
| `age` | Seconds since the allocation was made |
| `hex dump` | First bytes of the allocation (helps identify the object type) |
| `backtrace` | Call stack at allocation time — this shows **where the leak was created** |

The backtrace points to where the memory was allocated, which is typically where you begin the investigation. The leak itself (where the pointer was dropped) is the bug to find.

#### Control Commands

```bash
# Trigger an immediate scan
echo scan > /sys/kernel/debug/kmemleak

# Clear all current reports (useful to get a clean baseline)
echo clear > /sys/kernel/debug/kmemleak

# Disable kmemleak at runtime (stops tracking new allocations)
echo off > /sys/kernel/debug/kmemleak

# Dump information about the tracked object at a specific address
echo dump=0xffff88801a2b4c00 > /sys/kernel/debug/kmemleak
```

### Workflow: Finding a Leak in a Kernel Module

```bash
# 1. Get a clean baseline before loading the module
echo clear > /sys/kernel/debug/kmemleak
echo scan  > /sys/kernel/debug/kmemleak
cat /sys/kernel/debug/kmemleak    # Should be empty or show pre-existing leaks

# 2. Load and exercise the module
modprobe my_module
# ... run the workload that exercises my_module ...

# 3. Unload the module (leaks should now be orphaned)
rmmod my_module

# 4. Trigger a fresh scan
echo scan > /sys/kernel/debug/kmemleak

# 5. Read results
cat /sys/kernel/debug/kmemleak
```

!!! tip "Multiple scan passes"
    The first read after loading may include transient allocations. Run `echo scan > /sys/kernel/debug/kmemleak` a second or third time, waiting a few seconds between passes. Objects that persist across multiple scans are more likely to be true leaks.

### Automatic Scanning

By default, kmemleak schedules automatic scans every 600 seconds (10 minutes) using a kernel thread. You can see this thread:

```bash
ps aux | grep kmemleak
# root         23  0.0  0.0      0     0 ?  S    boot  0:00 [kmemleak]
```

Automatic scans produce the same output as manual scans. Check `/sys/kernel/debug/kmemleak` at any time to see the accumulated results.

## Annotating Allocations

Kmemleak can report false positives for allocations where the pointer is stored in a way it cannot scan — XOR-linked lists, encoded pointers, hardware descriptor rings, or deliberately long-lived allocations that the programmer knows are intentional. The API in [`include/linux/kmemleak.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/kmemleak.h) provides annotations to suppress these reports.

### kmemleak_not_leak

```c
#include <linux/kmemleak.h>

void *buf = kmalloc(size, GFP_KERNEL);
/* buf is stored in hardware registers — kmemleak can't scan those */
writel(virt_to_phys(buf), hw_reg);
kmemleak_not_leak(buf);
```

`kmemleak_not_leak(ptr)` tells kmemleak that this allocation is **intentionally not tracked** — it will not be reported even if no pointer to it is found during scanning. Use this when you know the allocation is reachable through a path kmemleak cannot see.

### kmemleak_ignore

```c
void *scratch = kmalloc(size, GFP_KERNEL);
kmemleak_ignore(scratch);
```

`kmemleak_ignore(ptr)` suppresses reporting for this specific allocation and also suppresses scanning its contents. Use this for allocations that are truly intentional one-time allocations that are never freed (e.g., early-boot data structures that live for the kernel lifetime).

### kmemleak_no_scan

```c
kmemleak_no_scan(ptr);
```

`kmemleak_no_scan(ptr)` prevents kmemleak from scanning the contents of this allocation for pointers to other objects. It does not suppress leak reporting for `ptr` itself; it just stops kmemleak from using `ptr`'s contents as roots. Use this when the object contains values that look like pointers but are not (e.g., hash values, checksums, raw data buffers).

### kmemleak_erase

```c
kmemleak_erase(&global_ptr);
```

`kmemleak_erase(ptr)` explicitly removes a pointer from consideration during scanning. Use this when a pointer to an allocation has been cleared but the allocation will be freed later through a different mechanism. This prevents kmemleak from following the now-null pointer during the scan.

### kmemleak_alloc / kmemleak_free (Manual Registration)

For memory that is tracked by a custom allocator rather than `kmalloc`/`vmalloc`, you can register and unregister objects manually:

```c
/* Register an externally-managed allocation */
kmemleak_alloc(ptr, size, min_count, gfp);

/* Unregister when freed */
kmemleak_free(ptr);
```

The `min_count` parameter controls how many pointer references are required before kmemleak considers the object reachable. Setting `min_count=0` means kmemleak will never report this object regardless of references (equivalent to `kmemleak_ignore`). Setting `min_count=2` requires at least two pointer references.

### Summary of Annotation Functions

| Function | Effect |
|----------|--------|
| `kmemleak_not_leak(ptr)` | Do not report this object as leaked |
| `kmemleak_ignore(ptr)` | Do not report; do not scan contents |
| `kmemleak_no_scan(ptr)` | Do not scan contents (still track for leaks) |
| `kmemleak_erase(addrp)` | Remove a pointer from scan consideration |
| `kmemleak_alloc(ptr, size, min_count, gfp)` | Manually register an object |
| `kmemleak_free(ptr)` | Manually unregister an object |

## Limitations

### False Positives (Incorrectly Reported Leaks)

Kmemleak reports an allocation as leaked whenever its scan finds no pointer to it. This produces false positives when the pointer exists but is hidden:

- **Encoded pointers**: XOR-linked lists (`list_add_rcu` variants), offset-based references, or deliberately obfuscated pointers are not recognized as valid references.
- **Pointer stored in hardware**: Physical addresses written to MMIO registers, DMA descriptor rings, or IOMMU tables are not part of the scanned memory.
- **Pointer stored in userspace memory**: If a kernel pointer is copied to a userspace buffer (unusual, and typically a bug itself), kmemleak does not scan userspace.
- **Pointer split across two words**: On architectures where unaligned access is legal, a pointer split across a word boundary may not be recognized.

The `kmemleak_not_leak()` and `kmemleak_no_scan()` annotations exist specifically to silence these false positives in known-good code.

### False Negatives (Missed Leaks)

Kmemleak can fail to detect a real leak if:

- The pointer happens to be present somewhere in scanned memory (a stale value from a previous allocation that was never cleared), making the object appear reachable.
- The allocation is freed before the scan runs (kmemleak correctly removes freed objects from tracking).
- The allocation is below the minimum size tracked by kmemleak.

### Performance Overhead

Kmemleak has three main sources of overhead:

1. **Per-allocation cost**: Every `kmalloc()` and `kfree()` invokes a kmemleak callback that updates the internal object tree (a red-black tree keyed on allocation address). This adds latency to every allocation.
2. **Memory for metadata**: Each tracked `struct kmemleak_object` consumes memory proportional to the number of live allocations.
3. **Scan cost**: The periodic scan traverses the data segment, per-CPU areas, and every thread's kernel stack. On systems with many threads or large data segments, a single scan can take hundreds of milliseconds.

The scan temporarily disables migration and reads every thread's stack, which can cause scheduling jitter. This makes kmemleak unsuitable for latency-sensitive workloads.

### What Kmemleak Cannot Detect

- Leaks in userspace processes (use Valgrind or AddressSanitizer for that)
- Leaks in memory-mapped I/O regions
- Memory that is technically reachable but functionally never used (logical leaks)
- Reference counting bugs (where a reference count never reaches zero, keeping an object alive indefinitely) — these are reachable and will not be reported

For OOM conditions caused by accumulation of unfreed objects, see [OOM Debugging](oom-debugging.md).

## History

### v2.6.28: Introduction (2008)

Kmemleak was introduced by Catalin Marinas (Arm Ltd) in kernel 2.6.28. The initial submission is described in the commit that added the infrastructure and the debugfs interface. The design drew on ideas from the Boehm-Demers-Weiser conservative garbage collector applied to the kernel's flat virtual address space.

**LWN coverage**: [Finding kernel memory leaks](https://lwn.net/Articles/187979/) (2006) describes the early design proposals that preceded the upstream submission.

### v2.6.30–v2.6.32: Stabilization

Early after introduction, Catalin Marinas and other contributors addressed false-positive rates and scanning coverage, adding support for per-CPU variables and refining the gray-coloring pass.

### v3.2: Early-Log Buffer

The early-log buffer was added to capture allocations that happen before the kmemleak data structures are fully initialized (very early boot), allowing boot-time leaks to be reported once kmemleak is ready.

### v4.x: Stability and Integration Improvements

Incremental improvements over the v4.x series addressed interactions with other debug infrastructure (fault injection, KASAN), reduced false-positive rates, and improved default scan interval behavior.

### v5.x: SLUB Integration Improvements

As SLUB became the dominant slab allocator (see [Slab Allocator](slab.md)), kmemleak's hooks in [`mm/slub.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slub.c) were refined to correctly track SLUB's internal object lifecycle, reducing false positives from SLUB's own internal allocations.

## Key Source Files

| File | Description |
|------|-------------|
| [`mm/kmemleak.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kmemleak.c) | Full kmemleak implementation: object tracking, scan logic, debugfs interface |
| [`include/linux/kmemleak.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/kmemleak.h) | Public API: `kmemleak_alloc`, `kmemleak_free`, annotation functions |
| [`Documentation/dev-tools/kmemleak.rst`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/dev-tools/kmemleak.rst) | Official kernel documentation |
| [`mm/slab_common.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slab_common.c) | Calls `kmemleak_alloc` and `kmemleak_free` from common slab paths |
| [`mm/slub.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slub.c) | SLUB allocator; calls kmemleak hooks on alloc/free |
| [`mm/vmalloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmalloc.c) | Calls `kmemleak_vmalloc` / `kmemleak_vfree` |
| [`lib/Kconfig.debug`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/Kconfig.debug) | `CONFIG_DEBUG_KMEMLEAK` and related Kconfig options |

## Further Reading

### Kernel Documentation

- [Kmemleak official documentation](https://docs.kernel.org/dev-tools/kmemleak.html) — configuration, usage, and the scanning algorithm

### LWN Articles

- [Finding kernel memory leaks](https://lwn.net/Articles/187979/) — early design proposal describing the motivation and algorithm

### Related

- [KASAN](kasan.md) — catches use-after-free and out-of-bounds; complementary to kmemleak
- [KFENCE](kfence.md) — production-safe sampling detector; catches access bugs, not leaks
- [OOM Debugging](oom-debugging.md) — when accumulated leaks lead to exhaustion
- [Slab Allocator](slab.md) — kmemleak hooks into slab allocation paths
