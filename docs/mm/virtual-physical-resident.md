# Virtual vs Physical vs Resident Memory

> Understanding `VSZ`, `RSS`, and why memory numbers don't add up

## The Confusion

You run `ps aux` and see a process using 500MB of virtual memory (`VSZ`). But `free` shows plenty of memory available. Or you add up all the `RSS` values and get more than your total RAM. What's going on?

The answer lies in understanding three different ways of measuring memory.

## The Three Memory Types

### Virtual Memory (VSZ/VIRT)

**What it is:** The total address space a process has mapped.

**What it includes:**
- Code (text segment)
- Data (heap, stack, globals)
- Shared libraries
- Memory-mapped files
- Allocations that haven't been touched yet

Virtual memory is just *address space*. It doesn't mean physical RAM is being used.

**`VSZ` is almost always meaningless for understanding memory usage.** Don't use it to answer "how much memory is this process using?" - use `RSS`, `PSS`, or `USS` instead. `VSZ` is only useful for debugging address space layout issues.

```bash
# A process with 500MB virtual doesn't use 500MB of RAM
$ ps -o pid,vsz,rss,comm -p $$
  PID    VSZ   RSS COMMAND
 1234 502400 12340 bash
```

In this example, `bash` has 500MB of virtual address space but only ~12MB resident in RAM. The `VSZ` number is essentially meaningless for capacity planning.

### Physical Memory

**What it is:** Actual RAM chips in your system.

**What uses it:**
- Kernel code and data structures
- Process pages that are resident (`RSS`)
- Page cache (file data cached in memory, including block buffers)
- Slab caches (kernel object caches)

Physical memory is shared, cached, and reused. The kernel manages it as a scarce resource.

```bash
$ free -h
              total        used        free      shared  buff/cache   available
Mem:           15Gi       4.2Gi       1.1Gi       890Mi       10Gi        10Gi
```

Here, 10GB is "used" by cache but available if needed.

### Resident Memory (RSS/RES)

**What it is:** The portion of virtual memory currently in physical RAM.

**What it includes:**
- Private pages actually in RAM
- Shared pages (libraries, shared memory)

**What it excludes:**
- Swapped out pages
- Pages never touched (demand paging)
- Memory-mapped files not currently loaded

`RSS` can be misleading for shared memory - here's why.

## Why `RSS` Doesn't Add Up

Consider two processes using the same shared library:

```
Process A: RSS = 100MB (includes 40MB libc)
Process B: RSS = 80MB (includes 40MB libc)
Total RSS = 180MB
```

But `libc` only exists once in physical RAM. The actual memory used is closer to 140MB.

This is why `RSS` totals often exceed physical RAM - shared pages are counted multiple times.

### `PSS`: Proportional Set Size

To solve the double-counting problem, Linux provides `PSS`:

```
Shared memory contribution = (shared size) / (number of sharers)
```

For the example above:
```
Process A: PSS = 60MB + (40MB / 2) = 80MB
Process B: PSS = 40MB + (40MB / 2) = 60MB
Total PSS = 140MB (accurate!)
```

```bash
# Works on any kernel since 2.6.25 (2008)
$ awk '/^Pss:/ {sum += $2} END {print sum " kB"}' /proc/<pid>/smaps

# Faster on kernel 4.14+ (no parsing needed)
$ grep ^Pss: /proc/<pid>/smaps_rollup
Pss:               98765 kB
```

Note: `PSS` has been available since kernel 2.6.25 via `/proc/<pid>/smaps`. The pre-aggregated `/proc/<pid>/smaps_rollup` was [added in kernel 4.14](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=493b0e9d945f) (2017) to avoid parsing overhead.

## Virtual Memory Can Be Huge

A process can map far more virtual memory than physical RAM exists:

```c
// This succeeds even on a 16GB system
void *p = mmap(NULL, 1UL << 40,  // 1 TB
               PROT_READ | PROT_WRITE,
               MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE,
               -1, 0);
// MAP_NORESERVE: don't reserve swap space for this mapping.
// Without it, strict overcommit (mode 2) might reject the allocation.
```

Why? Because:
1. **Demand paging**: Pages aren't allocated until touched
2. **Overcommit**: Linux allows allocations exceeding physical RAM
3. **Sparse mappings**: Most of the space may never be used

## The Memory Lifecycle

```
┌─────────────────────────────────────────────────────────┐
│                    Virtual Address Space                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │  Mapped  │ │  Mapped  │ │  Mapped  │ │  Mapped  │   │
│  │ (unused) │ │ (in RAM) │ │ (swapped)│ │ (file)   │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │
└─────────────────────────────────────────────────────────┘
        │              │             │            │
        │              ▼             │            │
        │       ┌──────────┐         │            │
        │       │ Physical │         │            │
        │       │   RAM    │◄────────┘            │
        │       └──────────┘   (swap in)          │
        │              │                          │
        │              ▼                          ▼
        │       ┌──────────┐              ┌──────────┐
        │       │   Swap   │              │   Disk   │
        │       │  Device  │              │  (file)  │
        │       └──────────┘              └──────────┘
        │
        ▼
   Page fault on
   first access
   (demand paging)
```

## Practical Examples

### Example 1: JVM Heap

```bash
$ java -Xmx4g -jar myapp.jar &
$ ps -o vsz,rss,comm -p $!
   VSZ    RSS COMMAND
5242880 512000 java
```

Virtual: ~5GB (includes max heap reservation)
Resident: ~500MB (actual heap usage)

The JVM reserves virtual space for the max heap but only uses physical RAM as needed.

### Example 2: Memory-Mapped File

```bash
$ ls -l bigfile.dat
-rw-r--r-- 1 user user 10737418240 Jan 1 00:00 bigfile.dat  # 10GB file

# Process maps entire file
$ cat /proc/<pid>/maps | grep bigfile
7f0000000000-7f0280000000 r--s ... bigfile.dat

$ ps -o vsz,rss -p <pid>
    VSZ    RSS
10500000  50000   # 10GB virtual, 50MB resident
```

The file is mapped but only accessed pages are in RAM.

### Example 3: Shared Libraries

```bash
$ pmap -x <pid> | grep libc
00007f1234000000   2048K r-x-- libc.so.6    # Code (shared)
00007f1234200000     64K r---- libc.so.6    # Read-only data
00007f1234210000     16K rw--- libc.so.6    # Private data (COW)
```

Most of `libc` is shared across all processes using it.

### `USS`: Unique Set Size

**`USS`** (Unique Set Size) measures only the private memory used by a process - memory that would be freed if this process alone were killed. It excludes all shared memory.

```bash
# USS = Private_Clean + Private_Dirty (both matched by "Private")
$ grep ^Private /proc/<pid>/smaps | awk '{sum += $2} END {print sum " kB"}'
```

`USS` is useful for understanding the true per-process memory cost, especially when analyzing container density or kill impact.

## Historical Context

Memory metrics evolved as systems became more complex and the question "how much memory is this process using?" became harder to answer.

### Early Unix: Simple Metrics

In early Unix systems, memory accounting was straightforward:
- **Virtual size**: How much address space is mapped
- **Resident size**: How much is in physical RAM

This was sufficient when processes rarely shared memory and systems had megabytes, not gigabytes.

### The Shared Library Problem (1990s-2000s)

As shared libraries became universal, `RSS` became misleading. If 100 processes share `libc`, each reports `libc`'s size in its `RSS` - summing them gives a wildly inflated total.

The `/proc` filesystem (present since early Linux development, well before 1.0) provided basic memory stats, but detailed per-mapping information came later.

### Linux Adds Detailed Accounting

| Version | Year | Addition |
|---------|------|----------|
| **2.6.14** | Oct 2005 | `/proc/pid/smaps` - [commit e070ad49](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=e070ad49f31155d872d8e96cab2142840993e3c0) by Mauricio Lin |
| **2.6.25** | Apr 2008 | **`PSS` added** - [LKML patch](https://lkml.iu.edu/hypermail/linux/kernel/0710.3/1565.html) by Fengguang Wu, concept by Matt Mackall |
| **4.14** | Nov 2017 | `/proc/pid/smaps_rollup` - [commit 493b0e9d](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=493b0e9d945f) for faster aggregate stats |

### The `PSS` Innovation (2007-2008)

Matt Mackall proposed `PSS` at the [Embedded Linux Conference](https://lwn.net/Articles/230975/) to answer: *"How much memory are applications really using?"*

The insight was simple: if 4 processes share a 40MB library, charge each 10MB (40/4) instead of 40MB. This makes `PSS` values actually sum to physical memory usage.

The [original LKML patch](https://lkml.iu.edu/hypermail/linux/kernel/0708.1/3420.html) (August 2007) was submitted by Fengguang Wu implementing Matt Mackall's concept. It was merged as part of the "maps4" series in kernel 2.6.25.

### Finer-Grained PSS Breakdown

Modern kernels (4.14+) provide PSS broken down by type in `smaps_rollup`:

```bash
$ grep Pss /proc/<pid>/smaps_rollup
Pss:               98765 kB
Pss_Anon:          41000 kB   # Anonymous (heap, stack)
Pss_File:          54000 kB   # File-backed mappings
Pss_Shmem:          3765 kB   # Shared memory (41000 + 54000 + 3765 = 98765)
```

For quick RSS checks without parsing smaps, use `/proc/<pid>/status`:

```bash
$ grep -E '^(VmRSS|RssAnon|RssFile|RssShmem)' /proc/<pid>/status
VmRSS:      123456 kB
RssAnon:     45000 kB
RssFile:     75000 kB
RssShmem:     3456 kB
```

### Modern Challenges

Today's complexity continues to grow:
- **`cgroups`**: Memory limits across process groups
- **`KSM`**: Identical pages merged across processes
- **Transparent Huge Pages**: 2MB/1GB pages complicate accounting
- **Memory tiering**: Fast vs slow memory (DRAM vs PMEM)

The basic `VSZ`/`RSS`/`PSS` model still works, but tools like `cgroup` memory stats and `/proc/meminfo` provide the fuller picture.

## Summary

| Metric | What It Measures | Shared Memory | Use For |
|--------|------------------|---------------|---------|
| `VSZ`/`VIRT` | Address space | Counts fully | Seeing address layout |
| `RSS`/`RES` | Pages in RAM | Counts per-process | Quick memory check |
| `PSS` | Proportional RAM | Divides fairly | Accurate accounting |
| `USS` | Private only | Excludes | Per-process impact |

## Try It Yourself

```bash
# Compare VSZ vs RSS
ps aux --sort=-%mem | head -10

# See detailed memory breakdown
cat /proc/self/smaps_rollup

# Watch memory changes
watch -n 1 'cat /proc/meminfo | head -10'

# See shared vs private
pmap -x <pid>
```

## Further Reading

- [proc(5) man page](https://man7.org/linux/man-pages/man5/proc.5.html) - `/proc` filesystem documentation
- [ELC: How much memory are applications really using?](https://lwn.net/Articles/230975/) - Matt Mackall's `PSS` introduction
- [smaps_rollup LKML discussion](https://lore.kernel.org/lkml/20170806225154.18820-1-dancol@google.com/) - Original patch series
