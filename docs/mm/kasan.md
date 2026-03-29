# KASAN (Kernel Address Sanitizer)

> Detecting memory bugs in the kernel at runtime

## What Is KASAN?

KASAN is a dynamic memory error detector for the Linux kernel. It catches bugs that are notoriously hard to find through code review or normal testing:

- **Out-of-bounds access**: Reading or writing past the end of an allocated object
- **Use-after-free**: Accessing memory after it has been freed
- **Double-free**: Freeing the same object twice
- **Invalid-free**: Freeing a pointer that was never allocated

These bugs cause silent data corruption, random crashes, and security vulnerabilities. Without a tool like KASAN, they can lurk in the kernel for years. A use-after-free in the kernel is especially dangerous because attackers can reclaim the freed object with controlled data, turning a memory bug into arbitrary code execution.

KASAN instruments every memory access the compiler generates, inserting checks that verify the accessed memory is valid. When it detects a violation, it prints a detailed report identifying the bug type, the offending access, and the allocation/deallocation history of the involved object.

## How KASAN Works

### The Three Modes

KASAN has three modes, each with different trade-offs between coverage, performance, and hardware requirements:

| Mode | Config Option | Mechanism | Overhead | Use Case |
|------|--------------|-----------|----------|----------|
| Generic KASAN | `CONFIG_KASAN_GENERIC` | Shadow memory | ~2x slowdown, 1/8 memory | Development and CI testing |
| SW_TAGS KASAN | `CONFIG_KASAN_SW_TAGS` | Software memory tagging | ~1.5x slowdown | Broader testing (arm64 only) |
| HW_TAGS KASAN | `CONFIG_KASAN_HW_TAGS` | ARM MTE hardware tagging | ~5-10% overhead | Production-like testing, dogfooding |

### Generic KASAN: Shadow Memory

Generic KASAN is the most widely used mode. It works by maintaining a **shadow memory** region that tracks the validity of every byte of kernel memory.

The key insight: one shadow byte can encode the state of eight real bytes.

```
Real memory (8-byte granule):
┌───┬───┬───┬───┬───┬───┬───┬───┐
│ 0 │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │  ← 8 bytes of kernel memory
└───┴───┴───┴───┴───┴───┴───┴───┘
                │
                │  maps to
                ▼
         ┌───────────┐
         │ shadow[N] │  ← 1 byte of shadow memory
         └───────────┘
```

**Shadow byte encoding**:

| Shadow Value | Meaning |
|-------------|---------|
| `0x00` | All 8 bytes are valid (accessible) |
| `0x01`-`0x07` | Only the first N bytes are valid (partial granule) |
| `0xFC` | KASAN internal redzone (between slab objects) |
| `0xFB` | Object freed (use-after-free detection) |
| `0xFE` | KASAN-specific redzone (object padding) |
| `0xF1` | Left redzone (before slab object) |
| `0xF2` | Right redzone (after slab object) |
| `0xF8` | kmalloc free shadow (freed kmalloc region) |

For every memory access, the compiler inserts a check:

```
1. Compute shadow address:  shadow_addr = (addr >> 3) + KASAN_SHADOW_OFFSET
2. Load shadow byte:        shadow_val  = *shadow_addr
3. If shadow_val != 0:
     a. If accessing all 8 bytes → BUG (invalid access)
     b. If partial access: check if (addr & 7) + size > shadow_val → BUG
4. Otherwise: access is valid, proceed
```

This means every 8-byte load or store compiles into roughly 5-10 extra instructions. The shadow memory itself consumes 1/8 of the total kernel address space.

```
Kernel address space layout with KASAN:

┌──────────────────────────┐  High addresses
│    Kernel code/data      │
├──────────────────────────┤
│    Shadow memory          │  ← 1/8 of kernel address space
│    (tracks validity of    │
│     all kernel memory)    │
├──────────────────────────┤
│    Normal kernel memory   │
└──────────────────────────┘  Low addresses
```

### SW_TAGS KASAN: Software Memory Tagging

SW_TAGS KASAN uses a different approach: instead of tracking per-byte validity, it assigns random **tags** to memory allocations and pointers. On each access, it checks that the pointer tag matches the memory tag.

```
Tagged pointer (arm64 Top Byte Ignore):
┌────────┬──────────────────────────────────────────────┐
│ Tag(8) │              Virtual Address (56)             │
└────────┴──────────────────────────────────────────────┘

Shadow memory stores the memory tag (1 byte per 16 bytes of real memory).

Access check:
  pointer_tag = ptr >> 56
  memory_tag  = shadow[addr >> 4]
  if pointer_tag != memory_tag → BUG
```

This relies on arm64's Top Byte Ignore (TBI) feature, which ignores the top byte of pointers during address translation. The kernel stores a random tag in that top byte.

When memory is freed, a new random tag is assigned to the shadow. The old pointer still carries the old tag, so any use-after-free will likely be caught (with probability 1 - 1/256 per access, since tags are 8 bits).

### HW_TAGS KASAN: Hardware Memory Tagging (ARM MTE)

HW_TAGS KASAN uses ARM Memory Tagging Extension (MTE), available on ARMv8.5+ processors. MTE implements the same tag-checking concept entirely in hardware:

- The CPU stores a 4-bit tag in every 16-byte memory granule (using dedicated tag storage in the memory controller)
- Pointers carry a 4-bit tag in bits [59:56]
- The CPU checks tags on every memory access with **zero additional instructions**

```
ARM MTE:
┌──────────┬─────────────────────────────────────────────┐
│ Tag(4)   │              Virtual Address (60)            │
└──────────┴─────────────────────────────────────────────┘
        │                        │
        │   hardware checks      │
        ▼                        ▼
   pointer tag  ==?  memory tag (stored in DRAM tag bits)
        │
        └── mismatch → hardware exception
```

The major advantage: overhead drops from 2x (Generic) to roughly 5-10%, making it viable for production testing and even dogfooding on real hardware. The trade-off is a coarser tag space (4 bits = 16 possible tags, so ~6% chance of missing a bug per access) and the requirement for MTE-capable hardware.

## What a KASAN Report Looks Like

When KASAN detects a bug, it prints a report to the kernel log. Here is a realistic example of a slab-out-of-bounds access:

```
==================================================================
BUG: KASAN: slab-out-of-bounds in example_function+0x58/0x90
Write of size 4 at addr ffff888012345678 by task insmod/1234

CPU: 2 PID: 1234 Comm: insmod Not tainted 6.8.0-kasan #1
Hardware name: QEMU Standard PC (Q35 + ICH9, 2009)
Call trace:
 dump_backtrace+0x0/0x30
 show_stack+0x18/0x28
 dump_stack_lvl+0x48/0x60
 print_report+0xd0/0x520
 kasan_report+0xa8/0xe0
 example_function+0x58/0x90           ← the buggy access
 test_module_init+0x30/0x48
 do_one_initcall+0x80/0x2a0

Allocated by task 1234:
 kmalloc_trace+0x28/0x40
 example_function+0x20/0x90           ← where the object was allocated
 test_module_init+0x30/0x48
 do_one_initcall+0x80/0x2a0

The buggy address belongs to the object at ffff888012345660
 which belongs to the cache kmalloc-32 of size 32
The buggy address is located 24 bytes to the right of
 allocated 32-byte region [ffff888012345660, ffff888012345680)

Memory state around the buggy address:
 ffff888012345500: fb fb fb fb fc fc fc fc 00 00 00 00 fc fc fc fc
 ffff888012345580: fb fb fb fb fc fc fc fc 00 00 00 00 fc fc fc fc
>ffff888012345600: 00 00 00 00 fc fc fc fc 00 00 00 00 fc fc fc fc
                                                       ^
 ffff888012345680: fc fc fc fc fb fb fb fb fc fc fc fc 00 00 00 00
 ffff888012345700: fc fc fc fc fb fb fb fb fc fc fc fc 00 00 00 00
==================================================================
```

**Reading the report**:

1. **Bug type**: `slab-out-of-bounds` -- the access went past the end of a slab object
2. **Access details**: A 4-byte write at address `ffff888012345678`
3. **Call trace**: Shows exactly where the bad access happened (`example_function+0x58`)
4. **Allocation trace**: Shows where the object was originally allocated
5. **Object details**: The object is in `kmalloc-32` (a 32-byte slab cache), and the access was 24 bytes past the end of the 32-byte allocation
6. **Shadow memory dump**: The `^` marker points to the shadow byte corresponding to the buggy address. `fc` means KASAN redzone -- the code wrote into the padding between slab objects

## Enabling KASAN

### Kernel Configuration

```
# Enable KASAN (pick one mode)
CONFIG_KASAN=y

# Generic mode (works on all architectures with compiler support)
CONFIG_KASAN_GENERIC=y

# OR: Software tag-based mode (arm64 only)
CONFIG_KASAN_SW_TAGS=y

# OR: Hardware tag-based mode (arm64 with MTE only)
CONFIG_KASAN_HW_TAGS=y

# Recommended companion options
CONFIG_KASAN_INLINE=y        # Inline checks (faster than outline)
CONFIG_STACKTRACE=y          # Better stack traces in reports
CONFIG_SLUB_DEBUG=y          # Enhanced slab debugging info
```

### Build Requirements

Generic KASAN requires GCC 8.3+ or Clang 7+. The compiler must support `-fsanitize=kernel-address` (Generic) or `-fsanitize=kernel-hwaddress` (SW_TAGS).

```bash
# Building a KASAN-enabled kernel
make defconfig
./scripts/config -e KASAN -e KASAN_GENERIC -e KASAN_INLINE
make -j$(nproc)
```

### Boot-Time Options

```bash
# For HW_TAGS mode: enable/disable at boot
kasan.mode=on          # Enable (default)
kasan.mode=off         # Disable
kasan.stacktrace=on    # Collect alloc/free stack traces
kasan.fault=report     # Report but don't panic (default)
kasan.fault=panic      # Panic on first KASAN error
```

## Try It Yourself

### Trigger a KASAN Report in QEMU

The kernel includes a built-in test module for KASAN:

```bash
# Boot a KASAN-enabled kernel in QEMU, then:

# Load the KASAN test module
modprobe kasan_test

# Or run specific tests via KUnit
# (KASAN tests are in lib/test_kasan.c / mm/kasan/kasan_test.c)
./tools/testing/kunit/kunit.py run --kunitconfig=mm/kasan/kasan_test.c
```

### Check If KASAN Is Active

```bash
# Check kernel config
zcat /proc/config.gz | grep KASAN

# Check boot messages
dmesg | grep -i kasan
```

### Read KASAN Reports

```bash
# Watch for KASAN reports in real time
dmesg -w | grep -A 30 "BUG: KASAN"
```

## Performance Overhead

| Mode | CPU Overhead | Memory Overhead | Detection Probability |
|------|-------------|-----------------|----------------------|
| Generic | ~2x slowdown | 1/8 of kernel memory for shadow | 100% -- deterministic |
| SW_TAGS | ~1.5x slowdown | 1/16 of kernel memory for shadow | ~99.6% per access (1/256 miss rate) |
| HW_TAGS | ~5-10% | Hardware tag storage | ~93.75% per access (1/16 miss rate) |

Generic mode has the highest overhead but catches everything. It is the standard choice for kernel CI systems and development builds. HW_TAGS mode is fast enough that Google uses it for testing on production Android devices with MTE-capable hardware.

## History

### v4.0: Introduction (2015)

**Commit**: [0b24becc8105](https://git.kernel.org/linus/0b24becc8105) ("kasan: add kernel address sanitizer infrastructure")

**Author**: Andrey Ryabinin (Samsung/Google)

KASAN was inspired by AddressSanitizer (ASan) for userspace, created by Konstantin Serebryany at Google. Andrey Ryabinin adapted the concept for the Linux kernel, using compiler instrumentation and shadow memory. The initial implementation supported x86_64 only.

**LWN coverage**: [The kernel address sanitizer](https://lwn.net/Articles/612153/) (2014)

### v5.11: Software Tag-Based Mode (2021)

**Commit**: [3c9e3aa11380](https://git.kernel.org/linus/3c9e3aa11380) ("kasan: add CONFIG_KASAN_GENERIC and CONFIG_KASAN_SW_TAGS")

**Author**: Andrey Konovalov (Google)

SW_TAGS KASAN introduced memory tagging in software, leveraging arm64's Top Byte Ignore feature. This mode trades some detection accuracy for significantly lower overhead, aimed at broader testing scenarios.

**LWN coverage**: [Tag-based KASAN](https://lwn.net/Articles/766768/) (2018)

### v5.12: Hardware Tag-Based Mode (2021)

**Commit**: [2e903b914797](https://git.kernel.org/linus/2e903b914797) ("kasan, arm64: implement HW_TAGS runtime")

**Author**: Andrey Konovalov (Google)

HW_TAGS mode leverages ARM Memory Tagging Extension (MTE) to perform tag checks in hardware, reducing overhead to near-zero. This was a major step toward making KASAN viable for production-like environments.

**LWN coverage**: [Arm Memory Tagging Extension and KASAN](https://lwn.net/Articles/834289/) (2020)

### v5.12: KASAN Boot Parameters

**Commit**: [1f600626bc50](https://git.kernel.org/linus/1f600626bc50) ("kasan, mm: allow cache merging with no metadata")

HW_TAGS mode introduced boot-time parameters (`kasan.mode`, `kasan.stacktrace`, `kasan.fault`) to allow enabling/disabling KASAN without recompilation, which is essential for production use.

### Ongoing: KASAN for More Subsystems

KASAN has been progressively extended to cover more kernel memory:

- Stack variables (Generic mode, via compiler instrumentation)
- Global variables (Generic mode)
- vmalloc allocations (added in v5.4 by Daniel Axtens)
- DMA and memory-mapped I/O regions

## Key Source Files

| File | Description |
|------|-------------|
| [`mm/kasan/`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kasan) | KASAN implementation directory |
| [`mm/kasan/common.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kasan/common.c) | Code shared across all modes (hooks into slab allocator, poisoning) |
| [`mm/kasan/generic.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kasan/generic.c) | Generic (shadow memory) mode implementation |
| [`mm/kasan/sw_tags.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kasan/sw_tags.c) | Software tag-based mode |
| [`mm/kasan/hw_tags.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kasan/hw_tags.c) | Hardware tag-based mode (ARM MTE) |
| [`mm/kasan/report.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kasan/report.c) | Bug report formatting and printing |
| [`mm/kasan/quarantine.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kasan/quarantine.c) | Quarantine for freed objects (delays reuse to catch use-after-free) |
| [`mm/kasan/shadow.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kasan/shadow.c) | Shadow memory management |
| [`include/linux/kasan.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/kasan.h) | KASAN public API and inline hooks |
| [`mm/kasan/kasan.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kasan/kasan.h) | Internal KASAN definitions and shadow value constants |

## Further Reading

### Kernel Documentation

- [KASAN official documentation](https://docs.kernel.org/dev-tools/kasan.html) -- comprehensive guide covering all three modes, configuration, and interpretation of reports

### LWN Articles

- [The kernel address sanitizer](https://lwn.net/Articles/612153/) -- original coverage (2014)
- [Tag-based KASAN](https://lwn.net/Articles/766768/) -- SW_TAGS mode design (2018)
- [Arm Memory Tagging Extension and KASAN](https://lwn.net/Articles/834289/) -- HW_TAGS mode (2020)

### Related

- [slab](slab.md) -- KASAN instruments slab allocator hooks to track allocations and frees
- [vmalloc](vmalloc.md) -- KASAN also covers vmalloc memory regions
- [vrealloc](vrealloc.md) -- KASAN poisoning bugs found during vrealloc development
