# Life of a malloc

> Tracing a userspace memory allocation from `malloc()` to physical pages

## What happens when you call malloc?

When a program calls `malloc(1024)`, what actually happens? The answer involves multiple layers of software, each optimizing for different goals:

```mermaid
flowchart TD
    A["malloc(1024)"] --> B

    subgraph B["glibc (ptmalloc2)"]
        B1["Check thread-local free lists"]
        B2["Try arena allocation"]
        B3["Maybe call brk() or mmap()"]
    end

    B -->|"only if needed"| C

    subgraph C["Kernel: System Call"]
        C1["brk(): extend heap"]
        C2["mmap(): create new mapping"]
    end

    C --> D

    subgraph D["Kernel: VMA Creation"]
        D1["Create/extend vm_area_struct"]
        D2["No physical memory yet!"]
    end

    D -->|"later, on first access"| E

    subgraph E["Kernel: Page Fault"]
        E1["Process touches the memory"]
        E2["Trap into kernel"]
        E3["Allocate physical page"]
        E4["Update page tables"]
    end

    E --> F

    subgraph F["Physical Memory"]
        F1["Page from buddy allocator"]
        F2["Mapped into process address space"]
    end
```

The key insight: **malloc doesn't allocate physical memory**. It reserves virtual address space. Physical pages are allocated later, on first access, through demand paging.

## Stage 1: Userspace (glibc)

### The allocator's job

`malloc()` is a library function, not a system call. glibc implements it using [ptmalloc (derived from dlmalloc)](https://sourceware.org/glibc/manual/latest/html_node/The-GNU-Allocator.html). The allocator has one goal: satisfy memory requests without calling into the kernel more than necessary.

```c
void *malloc(size_t size);
```

For each allocation, ptmalloc2 checks:

1. **Thread-local cache**: Each thread has a tcache with small, recently-freed chunks. Fastest path - no locking.

2. **Fastbins**: Per-arena lists of small freed chunks (up to ~160 bytes default). Quick LIFO access.

3. **Small/large bins**: Sorted lists of freed chunks. Searched for best fit.

4. **Top chunk**: The "wilderness" - unused space at the end of the heap. Can be carved up.

5. **System call**: Only when all else fails does glibc ask the kernel for more memory.

### When glibc calls the kernel

glibc uses two system calls to get memory from the kernel:

| Method | When Used | Typical Threshold |
|--------|-----------|-------------------|
| `brk()` | Small allocations, heap growth | < [128KB](https://man7.org/linux/man-pages/man3/mallopt.3.html) (tunable via `M_MMAP_THRESHOLD`) |
| `mmap()` | Large allocations | >= 128KB |

The threshold is [adaptive](https://man7.org/linux/man-pages/man3/mallopt.3.html) - glibc adjusts it upward when large blocks are freed. You can override with `mallopt(M_MMAP_THRESHOLD, bytes)`.

**Why two methods?**

- `brk()` extends the heap contiguously. Simple, but freed memory can't return to the kernel until everything above it is also freed.
- `mmap()` creates independent mappings. Can be returned to the kernel immediately with `munmap()`, but has more overhead.

See [brk vs mmap](brk-vs-mmap.md) for the full trade-off analysis.

## Stage 2: Kernel entry

### The brk() path

When glibc calls `brk()`, it's asking the kernel to move the program break - the end of the heap:

```c
// Userspace (glibc)
void *new_mem = sbrk(4096);  // Wrapper around brk()
```

The kernel handles this in [`mm/mmap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mmap.c):

```c
// Pseudocode - actual implementation has more validation
SYSCALL_DEFINE1(brk, unsigned long, brk)
{
    struct mm_struct *mm = current->mm;

    // Validate: not decreasing into existing mappings,
    // not exceeding RLIMIT_DATA, etc.

    // Extend or shrink the heap VMA
    if (brk > mm->brk)
        do_brk_flags(...);  // Creates/extends VMA

    mm->brk = brk;
    return brk;
}
```

The kernel updates the process's `mm_struct` to extend the heap VMA. No physical memory is allocated yet - just the virtual address range is reserved.

### The mmap() path

For larger allocations, glibc uses `mmap()` with `MAP_ANONYMOUS`:

```c
// Userspace (glibc simplified)
void *ptr = mmap(NULL, size, PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

// Kernel: mm/mmap.c
SYSCALL_DEFINE6(mmap, ...)
{
    // Find free virtual address range
    // Create new VMA
    // Return address to userspace
}
```

Again, no physical memory yet. The kernel creates a VMA describing the mapping and returns. No page table entries exist yet - they'll be created lazily on first access.

## Stage 3: VMA creation

Both `brk()` and `mmap()` result in VMA (Virtual Memory Area) creation or modification.

```c
// From include/linux/mm_types.h
struct vm_area_struct {
    unsigned long vm_start;     // Start address
    unsigned long vm_end;       // End address (exclusive)
    struct mm_struct *vm_mm;    // Owning address space
    pgprot_t vm_page_prot;      // Access permissions
    unsigned long vm_flags;     // VM_READ, VM_WRITE, etc.
    struct file *vm_file;       // NULL for anonymous memory
    // ...
};
```

For a `malloc()` that triggers `mmap()`:

```mermaid
flowchart LR
    subgraph before["Before mmap()"]
        direction LR
        A1[stack] --- A2[libs] --- A3[heap] --- A4[text]
    end

    before -->|"mmap()"| after

    subgraph after["After mmap()"]
        direction LR
        B1[stack] --- B2["<b>NEW VMA</b><br/>vm_file = NULL<br/>vm_flags = VM_READ|WRITE"] --- B3[libs] --- B4[heap]
    end
```

The new VMA is added to the process's maple tree (or red-black tree in kernels before v6.1). See [process address space](mmap.md) for details on VMA organization.

**Key point**: When `malloc()` returns, you have a valid pointer, but no physical memory backs it. The page table entries for this region don't exist yet - they're created on first access when the CPU faults.

## Stage 4: Page fault

Physical memory is allocated on first access. When the program reads or writes the malloc'd memory:

```c
char *ptr = malloc(4096);
ptr[0] = 'x';  // First access - triggers page fault
```

The CPU finds no valid page table entry and triggers a page fault exception. The kernel handles it:

```c
// Simplified from mm/memory.c
static vm_fault_t handle_pte_fault(struct vm_fault *vmf)
{
    // PTE is empty - this is a new page
    if (pte_none(vmf->orig_pte)) {
        if (vma_is_anonymous(vmf->vma))
            return do_anonymous_page(vmf);  // Our path
        else
            return do_fault(vmf);  // File-backed
    }
    // ... other cases (COW, swap, etc.)
}
```

### Anonymous page allocation

For anonymous memory (heap, stack), [`do_anonymous_page()`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memory.c) runs:

```c
// Simplified from mm/memory.c
static vm_fault_t do_anonymous_page(struct vm_fault *vmf)
{
    struct folio *folio;

    // 1. Allocate a physical page (folio)
    //    A folio is the modern replacement for struct page - it represents
    //    one or more contiguous pages as a single unit. For most anonymous
    //    allocations, this is a single 4KB page.
    folio = vma_alloc_zeroed_movable_folio(vmf->vma, vmf->address);

    // 2. Prepare page table entry
    entry = mk_pte(&folio->page, vma->vm_page_prot);
    if (vma->vm_flags & VM_WRITE)
        entry = pte_mkwrite(pte_mkdirty(entry), vma);

    // 3. Install in page table
    set_pte_at(vma->vm_mm, vmf->address, vmf->pte, entry);

    // 4. Add to reverse mapping (for reclaim)
    folio_add_new_anon_rmap(folio, vma, vmf->address);

    return 0;
}
```

This is where physical memory finally gets allocated.

## Stage 5: Page allocator

The `vma_alloc_zeroed_movable_folio()` call ultimately reaches the buddy allocator:

```c
// The chain of calls (simplified):
vma_alloc_zeroed_movable_folio()
  → folio_alloc()
    → __folio_alloc()
      → __alloc_pages()  // The core buddy allocator entry point
```

[`__alloc_pages()`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) is the heart of Linux memory allocation:

```c
// mm/page_alloc.c (heavily simplified)
struct page *__alloc_pages(gfp_t gfp, unsigned int order, int nid, nodemask_t *nodemask)
{
    // 1. Fast path: try per-CPU lists
    page = get_page_from_freelist(gfp, order, ...);
    if (page)
        return page;

    // 2. Slow path: wake kswapd, try harder
    page = __alloc_pages_slowpath(gfp, order, ...);
    return page;
}
```

### Fast path

Most allocations succeed immediately from per-CPU page lists or zone free lists:

```mermaid
flowchart TD
    subgraph pcplists["Per-CPU lists (pcplists) - No locking needed"]
        CPU0["CPU 0: [page][page][page]..."]
        CPU1["CPU 1: [page][page]..."]
        CPU2["CPU 2: [page][page][page][page]..."]
    end

    pcplists -->|"refill when empty"| buddy

    subgraph buddy["Zone free lists (buddy allocator)"]
        O0["Order 0: [4KB][4KB][4KB]..."]
        O1["Order 1: [8KB][8KB]..."]
        O2["..."]
    end
```

For a single-page allocation (typical for page faults), the kernel checks the per-CPU list first. This requires no locking and is very fast.

### Slow path

If free pages are low:

1. **Wake kswapd**: Background reclaim daemon
2. **Direct reclaim**: The allocating process frees some pages itself
3. **Compaction**: Defragment memory for high-order allocations
4. **OOM killer**: Last resort - kill a process to free memory

See [page reclaim](reclaim.md) for details on memory pressure handling.

## Stage 6: Return to userspace

After the page fault handler succeeds:

1. **Page table updated**: The PTE now points to the physical page
2. **TLB entry created**: CPU caches the virtual→physical mapping
3. **Execution resumes**: The faulting instruction is retried

```mermaid
flowchart LR
    subgraph before["Before page fault"]
        VA1["Virtual Address<br/>0x7f1234"] -.-x|"✗"| NP["No physical<br/>page"]
    end

    subgraph after["After page fault"]
        VA2["Virtual Address<br/>0x7f1234"] --> PP["Physical Page<br/>0x3a5000"]
        PP --> ZM["Zeroed memory<br/>(4096 bytes)"]
    end
```

The program continues, unaware that a complex dance just occurred. From its perspective, `ptr[0] = 'x'` just worked.

## Why demand paging?

This lazy allocation strategy has major benefits:

### 1. Fast malloc

`malloc()` returns immediately. The kernel work is deferred until actually needed.

### 2. Sparse allocations are cheap

A program can allocate 1GB but only use 4KB. It pays only for what it touches:

```c
// "Allocate" 1GB
char *huge = malloc(1024 * 1024 * 1024);

// Only use 4KB - only one physical page allocated
huge[0] = 'a';
```

### 3. Overcommit works

The kernel can promise more memory than physically exists. Most programs don't use all they request. See [memory overcommit](overcommit.md).

### 4. fork() is fast

Child processes share pages with parents via [copy-on-write](cow.md). Physical copies only happen when either process writes.

## Try it yourself

### Watch malloc in action

```bash
# Trace system calls from a simple allocation
strace -e brk,mmap,munmap -f sh -c 'head -c 1M /dev/zero > /dev/null'

# See page faults
perf stat -e page-faults,minor-faults,major-faults ./your_program
```

### Observe demand paging

```bash
# Create a program that allocates but doesn't touch memory
cat > /tmp/lazy.c << 'EOF'
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main() {
    printf("PID: %d\n", getpid());
    printf("Before malloc...\n");
    getchar();

    char *p = malloc(100 * 1024 * 1024);  // 100MB
    printf("After malloc, before touch...\n");
    getchar();

    for (int i = 0; i < 100 * 1024 * 1024; i += 4096)
        p[i] = 'x';  // Touch each page
    printf("After touching all pages...\n");
    getchar();

    return 0;
}
EOF
gcc -o /tmp/lazy /tmp/lazy.c
/tmp/lazy

# In another terminal, watch RSS grow:
watch -n 1 'ps -o pid,vsz,rss,comm -p $(pgrep lazy)'
# VSZ jumps after malloc, RSS jumps only after touching
```

### Examine the malloc threshold

```bash
# See glibc's mmap threshold behavior
cat > /tmp/mmap_test.c << 'EOF'
#include <stdio.h>
#include <stdlib.h>

int main() {
    // Small allocation - likely uses brk()
    void *small = malloc(1024);
    printf("Small (1KB): %p\n", small);

    // Large allocation - likely uses mmap()
    void *large = malloc(256 * 1024);
    printf("Large (256KB): %p\n", large);

    // Notice the address ranges are very different
    return 0;
}
EOF
gcc -o /tmp/mmap_test /tmp/mmap_test.c
strace -e brk,mmap /tmp/mmap_test
```

### Trace page faults in the kernel

```bash
# Enable page fault tracing (requires root, debugfs mounted)
echo 1 > /sys/kernel/debug/tracing/events/exceptions/page_fault_user/enable
cat /sys/kernel/debug/tracing/trace_pipe &

# Run a program - see faults in real time
./your_program

# Disable when done
echo 0 > /sys/kernel/debug/tracing/events/exceptions/page_fault_user/enable
```

## Common misconceptions

### "malloc allocates memory"

Not really. It reserves address space. Physical pages come later via page faults.

### "My program uses 1GB because malloc(1GB) succeeded"

Check RSS (Resident Set Size), not VSZ (Virtual Size). VSZ includes all reserved address space; RSS is physical memory actually used.

```bash
ps -o pid,vsz,rss,comm -p <pid>
```

### "Page faults are bad"

Minor faults (demand paging) are normal and expected. Major faults (reading from disk) are expensive. The kernel optimizes for minor faults to be fast.

## Key source files

| File | What It Does |
|------|--------------|
| [`mm/mmap.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mmap.c) | brk(), mmap() implementation |
| [`mm/memory.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memory.c) | Page fault handling, do_anonymous_page() |
| [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) | Buddy allocator, __alloc_pages() |
| [`include/linux/mm_types.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mm_types.h) | vm_area_struct, mm_struct definitions |

## History

### Demand paging origins

Demand paging has been part of Linux since the beginning. The basic mechanism - mapping virtual addresses without backing physical memory until access - is fundamental to Unix-like systems.

### VMA management evolution

In **Stage 3** above, when `mmap()` creates a new VMA, it must be inserted into the process's VMA collection for later lookup (e.g., during page faults). The data structure for this has evolved:

**Red-black tree (early Linux)**: VMAs were organized in an rb-tree for `O(log n)` lookup. Simple but required careful locking.

**Maple tree (v6.1, 2022)**: VMAs moved to a maple tree - a B-tree variant optimized for cache locality and RCU-safe operations. This allows concurrent VMA lookups without holding `mmap_lock`, improving page fault scalability.

**Commit**: [d4af56c5c7c6](https://git.kernel.org/linus/d4af56c5c7c6) ("mm: start tracking VMAs with maple tree") | [LKML](https://lore.kernel.org/linux-mm/20220906194824.2110408-9-Liam.Howlett@oracle.com/)

**Author**: Liam Howlett (Oracle)

### Folio conversion (v5.16+)

In **Stage 4** above, `do_anonymous_page()` allocates a `struct folio` rather than a raw `struct page`. A folio is the modern abstraction for memory:

- **What it is**: A folio represents one or more physically contiguous pages managed as a unit
- **Why it exists**: The old `struct page` API was ambiguous - functions didn't know if they received a head page, tail page, or single page. Folios make the semantics explicit.
- **In our flow**: `vma_alloc_zeroed_movable_folio()` allocates a folio, which for anonymous faults is typically a single 4KB page (or a 2MB transparent huge page if enabled)

**Commit**: [7b230db3b8d3](https://git.kernel.org/linus/7b230db3b8d3) ("mm: Introduce struct folio") | [LKML](https://lore.kernel.org/linux-mm/20210622121551.3398730-3-willy@infradead.org/)

**Author**: Matthew Wilcox (Oracle)

## Notorious bugs and edge cases

The malloc path spans userspace (glibc) and kernel (brk/mmap, page fault). Bugs at either level can lead to memory corruption or privilege escalation.

---

### Case 1: glibc heap overflow (CVE-2023-6246)

#### What happened

In January 2024, Qualys discovered a heap buffer overflow in glibc's `__vsyslog_internal()` function that could be exploited for local privilege escalation.

#### The bug

From the [Qualys disclosure](https://medium.com/@elpepinillo/heap-heap-hooray-unveiling-glibc-heap-overflow-vulnerability-cve-2023-6246-0c6412423069):

The `__vsyslog_internal()` function in glibc could overflow a heap buffer when processing specially crafted input. The heap (managed by ptmalloc2 in glibc) stores the buffer, and overflowing it corrupts adjacent heap metadata.

#### Real-world implications

An attacker with local access could escalate to root by exploiting programs that use `syslog()`.

#### Why this matters for malloc

When you call `malloc()`, glibc's ptmalloc2 manages the heap internally. Heap corruption vulnerabilities like this one abuse:

1. **Chunk metadata**: ptmalloc stores size/flags adjacent to user data
2. **Free list pointers**: Corrupting these leads to arbitrary write primitives
3. **Tcache/fastbin**: Modern glibc mitigations complicate exploitation but don't eliminate it

#### The fix

**Commit**: [6bd0e4efcc78](https://sourceware.org/git/?p=glibc.git;a=commit;h=6bd0e4efcc78f3c0115e5ea9739a1642807450da) (glibc)

Fixed in glibc 2.39. The vulnerability was introduced in glibc 2.37 by commit `52a5be0df411`.

#### Mitigations

Modern glibc includes:
- **Safe-linking**: Pointer mangling in fastbins/tcache
- **Chunk size validation**: Detect corrupted size fields
- **Top chunk integrity checks**: Prevent wilderness corruption

---

### Case 2: The Stack Clash (2017)

#### What happened

Qualys discovered that the gap between stack and heap could be jumped, allowing stack-to-heap or heap-to-stack corruption.

#### The bug

The kernel maintains a "stack guard page" - an unmapped page between the stack and other mappings. The assumption: any access to this page triggers a segfault.

But large allocations (via `alloca()` or VLAs) can jump over the guard page:

```c
void vulnerable() {
    char buf[HUGE_SIZE];  // If HUGE_SIZE > guard gap...
    buf[0] = 'A';         // ...we land in heap/mmap region
}
```

#### Real-world implications

Local privilege escalation on many Linux distributions. The vulnerability affected:
- Linux (CVE-2017-1000364)
- FreeBSD, OpenBSD, NetBSD, Solaris
- Programs using large stack allocations

#### The fix

**Commit**: [1be7107fbe18](https://git.kernel.org/linus/1be7107fbe18) ("mm: larger stack guard gap, between vmas")

The kernel increased the stack guard gap from 1 page (4KB) to 1MB by default:

```bash
# Check current guard gap (Documentation/admin-guide/kernel-parameters.txt)
cat /proc/sys/vm/stack_guard_gap
# Default: 256 (pages) = 1MB on 4KB page systems
```

#### Why this matters for malloc

The heap (via `brk()`) and stack grow toward each other. This bug showed that the boundary between them must be carefully protected.

---

### Case 3: mmap_min_addr bypass (CVE-2009-2695)

#### What happened

NULL pointer dereference bugs in the kernel could be exploited by mapping memory at address 0.

#### The bug

Many kernel bugs involve dereferencing a NULL pointer. Normally this would crash. But if an attacker can map memory at address 0 and control its contents, they can turn a NULL dereference into code execution.

The kernel added `mmap_min_addr` to prevent low-address mappings. But SELinux's `unconfined_t` domain bypassed this restriction.

From [Red Hat's advisory](https://access.redhat.com/articles/17995):

> *"A system with SELinux enforced was found to be more permissive in allowing local users in the unconfined_t domain to map low memory areas even if the mmap_min_addr restriction is enabled."*

#### The fix

Multiple commits fixed the SELinux policy and strengthened `mmap_min_addr` enforcement:
- [9c0d9010](https://git.kernel.org/linus/9c0d9010)
- [8cf948e7](https://git.kernel.org/linus/8cf948e7)

```bash
# Check current minimum mmap address
cat /proc/sys/vm/mmap_min_addr
# Default: 65536 (64KB) - set by LSM_MMAP_MIN_ADDR in security/Kconfig
```

#### Why this matters for malloc

When `malloc()` uses `mmap()` for large allocations, the kernel chooses the address. `mmap_min_addr` ensures the kernel never maps at dangerously low addresses.

---

### Case 4: ptmalloc thread arena exhaustion

#### What happened

Under heavy concurrent allocation, glibc's ptmalloc could create excessive arenas, wasting memory.

#### The bug

ptmalloc creates per-thread arenas to reduce lock contention. But the default limit (`8 * num_cpus`) can lead to:

1. Many threads each get their own arena
2. Each arena has its own heap segment
3. Fragmentation and memory waste explode

#### Real-world implications

Applications with many threads (e.g., Java apps, web servers) could use 2-3x more memory than expected due to arena overhead.

#### Mitigation

```bash
# Limit arenas (set before running program)
export MALLOC_ARENA_MAX=2

# Or use alternative allocators
# jemalloc, tcmalloc have better multi-threaded behavior
```

---

### Case 5: brk randomization weaknesses

#### What happened

ASLR (Address Space Layout Randomization) randomizes mmap but historically left brk predictable.

#### The bug

If `brk()` always returns the same address, heap exploitation becomes easier - attackers know where heap data lives.

Early ASLR implementations randomized:
- Stack location ✓
- mmap base ✓
- brk/heap location - **partially or not at all**

#### Modern status

Modern kernels randomize brk with `CONFIG_COMPAT_BRK=n`:

```bash
# Check if brk randomization is enabled
cat /proc/sys/kernel/randomize_va_space
# 2 = full ASLR including brk
```

---

### Summary: Lessons learned

| Bug | Year | Layer | Impact | Prevention |
|-----|------|-------|--------|------------|
| **glibc heap overflow** | 2024 | Userspace | Root access | Update glibc |
| **Stack Clash** | 2017 | Kernel | Root access | Larger guard gap |
| **mmap_min_addr bypass** | 2009 | Kernel/SELinux | Root access | Fixed in kernel |
| **Arena exhaustion** | Ongoing | Userspace | Memory waste | `MALLOC_ARENA_MAX` |
| **brk predictability** | Historical | Kernel | Easier exploitation | Full ASLR |

The common thread: **malloc is the foundation of memory safety**. Bugs in heap management (glibc) or virtual memory setup (kernel) have severe security implications.

## Further reading

### Related docs

- [Process address space](mmap.md) - VMAs, mmap details
- [Page allocator](page-allocator.md) - Buddy system internals
- [Memory overcommit](overcommit.md) - Why demand paging enables overcommit
- [brk vs mmap](brk-vs-mmap.md) - When glibc uses each method
- [Page reclaim](reclaim.md) - What happens when memory runs low

### External resources

- [glibc malloc internals](https://sourceware.org/glibc/wiki/MallocInternals) - Official glibc documentation
- [The Stack Clash](https://blog.qualys.com/vulnerabilities-threat-research/2017/06/19/the-stack-clash) - Qualys research paper
- [Heap exploitation techniques](https://github.com/shellphish/how2heap) - Educational heap exploitation examples
