# KFENCE (Kernel Electric Fence)

> Low-overhead sampling-based heap bug detection for production kernels

## What Is KFENCE?

KFENCE is a lightweight memory error detector that catches heap out-of-bounds accesses, use-after-free bugs, and invalid-free errors in the kernel. Unlike full-blown sanitizers that instrument every memory access, KFENCE uses a **sampling-based** approach: it only protects a small fraction of allocations at any time, relying on statistical probability to catch bugs over hours or days of uptime.

The key insight is that bugs that happen frequently in production will eventually hit a KFENCE-protected allocation, even if only 1 in every ~10,000 allocations is protected. This makes KFENCE practical for always-on deployment where KASAN would be prohibitively expensive.

## Why KFENCE Exists

### The Gap Between Testing and Production

Before KFENCE, kernel developers faced a dilemma:

| Tool | Overhead | Where It Runs | Bug Coverage |
|------|----------|---------------|--------------|
| KASAN (generic) | ~2-3x slowdown, 1.5-3x memory | CI, testing | Every allocation |
| KASAN (SW/HW tag) | ~10-50% slowdown | Testing, some hardware | Every allocation |
| Nothing | 0% | Production | None |

Many heap bugs only manifest under real production workloads -- specific timing, memory pressure, or access patterns that are hard to reproduce in test environments. KFENCE fills this gap: it runs in production with near-zero overhead, catching bugs that would otherwise go undetected until they cause data corruption or crashes.

### Real-World Motivation

Google developed KFENCE after running KASAN-like detection internally and finding that:

1. Many bugs only appeared on production machines under real traffic
2. Full sanitizer overhead was unacceptable for production fleets
3. Even a low sampling rate catches high-frequency bugs quickly

## How It Differs from KASAN

```
KASAN (always-on):
  Every allocation → instrumented → checked on every access
  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
  │shadow│ │shadow│ │shadow│ │shadow│ │shadow│  ← shadow memory for ALL
  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘

KFENCE (sampling):
  1 in ~N allocations → placed in guarded pool → hardware trap on error
  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
  │normal│ │normal│ │KFENCE│ │normal│ │normal│  ← only some protected
  └──────┘ └──────┘ │guard │ └──────┘ └──────┘
                     │pages │
                     └──────┘
```

| Aspect | KASAN | KFENCE |
|--------|-------|--------|
| Detection | Deterministic (every access) | Probabilistic (sampled) |
| Overhead | 2-3x CPU, 1.5-3x memory | < 1% CPU, fixed ~2MB memory |
| Deployment | Testing, CI | Production, always-on |
| Mechanism | Shadow memory + compiler instrumentation | Guard pages + hardware page faults |
| Coverage | All allocations | Small rotating subset |
| Configuration | Compile-time only | Runtime tunable via sysfs |

## How It Works

### The Object Pool

KFENCE pre-allocates a fixed pool of memory at boot time. By default, this pool holds space for 255 objects. The pool is laid out with **guard pages** between every object slot:

```
KFENCE pool layout:

  ┌───────┐ ┌────────┐ ┌───────┐ ┌────────┐ ┌───────┐ ┌────────┐ ┌───────┐
  │ guard │ │ object │ │ guard │ │ object │ │ guard │ │ object │ │ guard │
  │ page  │ │ page   │ │ page  │ │ page   │ │ page  │ │ page   │ │ page  │
  │ (no   │ │        │ │ (no   │ │        │ │ (no   │ │        │ │ (no   │
  │access)│ │        │ │access)│ │        │ │access)│ │        │ │access)│
  └───────┘ └────────┘ └───────┘ └────────┘ └───────┘ └────────┘ └───────┘
  unmapped   mapped     unmapped   mapped     unmapped   mapped     unmapped
```

Each object slot is a full page (4KB on x86), but the actual object is placed at either the **left edge** or **right edge** of the page:

- **Right-aligned**: object placed at end of page, so out-of-bounds access to the right hits the guard page immediately
- **Left-aligned**: object placed at start of page, so out-of-bounds access to the left hits the guard page

KFENCE alternates alignment to catch both left and right overflows.

### The Sampling Mechanism

KFENCE does not intercept every `kmalloc()` or `kmem_cache_alloc()` call. Instead, it uses a **timer-based sampling interval**:

1. A static branch (normally not taken) is toggled on a timer
2. When toggled on, the **next** allocation is redirected to the KFENCE pool
3. After one allocation is captured, the static branch is toggled off
4. The timer fires again after the configured interval (default: 100ms)

```
Time →
  ─────────────────────────────────────────────────────────────
  │         │ sample │         │ sample │         │ sample │
  │  normal │  one   │  normal │  one   │  normal │  one   │
  │  allocs │ alloc  │  allocs │ alloc  │  allocs │ alloc  │
  ─────────────────────────────────────────────────────────────
             ↑ 100ms  ↑         ↑ 100ms  ↑
            timer    captured   timer    captured
```

This approach ensures near-zero overhead during normal operation. The static branch (`static_branch_unlikely`) compiles to a NOP in the fast path, meaning zero cost for the 99.99%+ of allocations that are not sampled.

### Detecting Bugs

When a KFENCE-protected allocation is misused, the hardware MMU does the detection:

**Out-of-bounds access**: The access hits an unmapped guard page, triggering a page fault. The KFENCE fault handler identifies the faulting address, finds the nearest KFENCE object, and reports the overflow or underflow.

**Use-after-free**: When an object is freed, its page is unmapped (protection set to `PROT_NONE`). Any subsequent access triggers a page fault. KFENCE keeps metadata about the freed object (including the free stack trace) so it can report what was freed and when.

**Invalid free**: When `kfree()` is called on a KFENCE address, KFENCE validates the pointer. Double-frees and invalid pointers are caught and reported.

## What a KFENCE Report Looks Like

When KFENCE detects a bug, it prints a detailed report to the kernel log. Here is an annotated example of an out-of-bounds write:

```
==================================================================
BUG: KFENCE: out-of-bounds write in driver_probe+0x84/0x120      ← Bug type and location

Out-of-bounds write at 0xffff8881045ab000 (1 byte(s) to the right ← Faulting address and
 of kfence-#72):                                                     which KFENCE slot
 driver_probe+0x84/0x120                                          ← Stack trace of the
 really_probe+0x170/0x3e0                                            bad access
 __driver_probe_device+0x78/0x160
 driver_probe_device+0x1e/0x90
 bus_for_each_drv+0x84/0xe0

kfence-#72: 0xffff8881045aafe0-0xffff8881045aafff, size=32,       ← Object details:
 cache=kmalloc-32                                                    address range, size,
                                                                     slab cache name

allocated by task 1234 on cpu 3 at 42.010s:                       ← Allocation stack trace
 kmalloc+0x2e/0x40                                                   with task, CPU, and
 driver_init+0x30/0x80                                               timestamp
 do_init_module+0x50/0x200
 load_module+0x2a4c/0x2e70
 __do_sys_finit_module+0xac/0x120
 do_syscall_64+0x5c/0xf0
==================================================================
```

For use-after-free bugs, the report also includes the **free stack trace**, showing where the object was freed:

```
==================================================================
BUG: KFENCE: use-after-free read in corrupt_data+0x28/0x40

Use-after-free read at 0xffff8881045ab000 (4 byte(s)):
 corrupt_data+0x28/0x40
 test_function+0x60/0x90

kfence-#51: 0xffff8881045a6fe0-0xffff8881045a6fff, size=32,
 cache=kmalloc-32

allocated by task 789 on cpu 1 at 18.500s:
 kmalloc+0x2e/0x40
 setup_object+0x24/0x60

freed by task 789 on cpu 1 at 19.200s:                            ← Free stack trace
 kfree+0x4e/0x60                                                     helps you find the
 cleanup_object+0x1c/0x40                                            premature free
 work_handler+0x80/0xa0
==================================================================
```

These reports provide enough information to diagnose the root cause: you can see exactly what object was involved, how big it was, which slab cache it came from, and the full call stacks for allocation, free, and the offending access.

## Configuration

### Build-Time Options

Enable KFENCE in your kernel config:

```
CONFIG_KFENCE=y
```

This is the only required option. KFENCE is designed to be enabled by default in distribution kernels.

Optional build-time settings:

| Config Option | Default | Description |
|---------------|---------|-------------|
| `CONFIG_KFENCE` | n | Enable KFENCE |
| `CONFIG_KFENCE_SAMPLE_INTERVAL` | 100 | Default sampling interval in milliseconds |
| `CONFIG_KFENCE_NUM_OBJECTS` | 255 | Number of objects in the KFENCE pool |
| `CONFIG_KFENCE_STRESS_TEST_FAULTS` | 0 | Inject faults for testing KFENCE itself |

### Runtime Tuning

The sampling interval can be adjusted at runtime without rebooting:

```bash
# Check current sampling interval (milliseconds)
cat /sys/module/kfence/parameters/sample_interval

# Increase interval (less overhead, fewer catches)
echo 500 > /sys/module/kfence/parameters/sample_interval

# Decrease interval (more overhead, more catches)
echo 50 > /sys/module/kfence/parameters/sample_interval

# Disable KFENCE at runtime
echo 0 > /sys/module/kfence/parameters/sample_interval
```

### Boot Parameters

You can also set the interval at boot:

```
kfence.sample_interval=200
```

## Performance Characteristics

### Why It Is Safe for Production

KFENCE was designed from the ground up for production use:

**Near-zero fast-path overhead**: The sampling check uses a static branch that compiles to a NOP instruction. On x86, this means zero additional instructions in the allocation fast path when KFENCE is not sampling (which is >99.99% of the time).

**Fixed memory cost**: The KFENCE pool is allocated at boot and has a fixed size. With the default 255 objects, the pool consumes roughly 2MB (255 object pages + 256 guard pages = 511 pages). This does not grow.

**No compiler instrumentation**: Unlike KASAN, KFENCE does not require compiler support or code changes. It works with any compiler and does not increase code size.

**No shadow memory**: KASAN requires shadow memory proportional to total system memory (typically 1/8th of RAM). KFENCE uses only its fixed pool regardless of system memory size.

| Metric | KASAN (generic) | KFENCE |
|--------|-----------------|--------|
| CPU overhead | 100-200% | < 1% |
| Memory overhead | ~12.5% of RAM | ~2MB fixed |
| Code size increase | Significant | None |
| Production safe | No | Yes |

### The Trade-off

The cost of low overhead is **probabilistic detection**. KFENCE will not catch every bug immediately. A bug must hit a KFENCE-protected allocation to be detected. For bugs that occur frequently (e.g., on every call to a specific function), detection typically happens within minutes to hours. Rare bugs may take days or weeks, but they will eventually be caught if the system runs long enough.

## Try It Yourself

### Check if KFENCE Is Enabled

```bash
# Check kernel config
zcat /proc/config.gz 2>/dev/null | grep KFENCE || grep KFENCE /boot/config-$(uname -r)

# Check if KFENCE is active (non-zero interval means active)
cat /sys/module/kfence/parameters/sample_interval
```

### Monitor KFENCE Activity

```bash
# KFENCE statistics are available via debugfs
cat /sys/kernel/debug/kfence/stats

# Example output:
#   enabled: 1
#   objects allocated: 189
#   objects freed: 42
#   zombie allocations: 0
#   skip allocs (pool full): 312
#   bugs found: 0
```

### Trigger a Test Bug (in a VM)

!!! warning
    Only do this in a test VM or QEMU instance, never on a production system.

The kernel includes a KFENCE test module:

```bash
# Build with CONFIG_KFENCE_KUNIT_TEST=y
# Run the KFENCE KUnit tests
modprobe kfence_test

# Or run via KUnit framework
./tools/testing/kunit/kunit.py run kfence
```

### Tuning for Your Workload

```bash
# Start conservative (default 100ms)
cat /sys/module/kfence/parameters/sample_interval

# If you want faster detection and can tolerate minimal overhead:
echo 20 > /sys/module/kfence/parameters/sample_interval

# Monitor for any detected bugs
dmesg | grep -i kfence
```

## History

### v5.12: Introduction (2021)

**Commits**:

- [0ce20dd84089](https://git.kernel.org/linus/0ce20dd84089) ("mm: add Kernel Electric Fence infrastructure")
- [bc8fbc5f305a](https://git.kernel.org/linus/bc8fbc5f305a) ("mm, kfence: insert KFENCE hooks for SLAB")
- [d3fb45f370d9](https://git.kernel.org/linus/d3fb45f370d9) ("mm, kfence: insert KFENCE hooks for SLUB")

**Authors**: Marco Elver and Alexander Potapenko (Google)

**Kernel**: v5.12

KFENCE was developed at Google, where a similar internal tool had been running in production for years. The upstream submission brought this capability to the wider Linux community.

The patch series went through extensive review on LKML: [KFENCE v7 patch series](https://lore.kernel.org/lkml/20201103175841.3495947-1-elver@google.com/) (originally posted November 2020, merged for v5.12 in early 2021).

**LWN coverage**: [KFENCE: A low-overhead memory safety error detector](https://lwn.net/Articles/832354/) provides an accessible overview of the design rationale.

### v5.17: Improved Reporting and Coverage

**Commit**: [58f116052668](https://git.kernel.org/linus/58f116052668) ("kfence: track memcache for allocations not covered by a slab cache")

Various improvements to reporting quality and coverage were added over subsequent releases, including better integration with memory cgroups and more informative stack traces.

### v5.18: KFENCE for DMA Allocations

**Commit**: [0ddb5349ce00](https://git.kernel.org/linus/0ddb5349ce00) ("kfence: allow use of a deferrable timer")

Added a deferrable timer option to reduce overhead on systems where power consumption matters. The timer does not wake idle CPUs, making KFENCE friendlier to mobile and embedded systems.

### Ongoing Development

KFENCE continues to receive improvements. Key areas of ongoing work include better coverage heuristics, integration with other debugging tools, and expanding the types of bugs it can detect.

## Key Source Files

| File | Description |
|------|-------------|
| [`mm/kfence/core.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kfence/core.c) | Main KFENCE implementation: pool init, allocation, sampling |
| [`mm/kfence/report.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kfence/report.c) | Bug report generation and formatting |
| [`mm/kfence/kfence_test.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kfence/kfence_test.c) | KUnit test suite |
| [`include/linux/kfence.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/kfence.h) | Public API and inline hooks |
| [`mm/kfence/kfence.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kfence/kfence.h) | Internal header with pool metadata structures |

## References

### Kernel Documentation

- [KFENCE official documentation](https://docs.kernel.org/dev-tools/kfence.html) -- comprehensive reference for configuration and design

### LWN Articles

- [KFENCE: A low-overhead memory safety error detector](https://lwn.net/Articles/832354/) -- overview article from the initial submission

### LKML Discussions

- [KFENCE v7 patch series](https://lore.kernel.org/lkml/20201103175841.3495947-1-elver@google.com/) -- the final review series before merge
- [KFENCE v1 RFC](https://lore.kernel.org/lkml/20200907134055.2878499-1-elver@google.com/) -- the original RFC with design discussion

### Related

- [slab](slab.md) -- KFENCE hooks into the slab allocator (SLUB/SLAB) to intercept allocations
- [vmalloc](vmalloc.md) -- KFENCE pool uses page-level protection similar to vmalloc guard pages
- [oom](oom.md) -- KFENCE's fixed pool size means it does not contribute to OOM pressure
