# When does copy-on-write break?

> COW is elegant in theory, but the edge cases will surprise you

## The COW promise

Copy-on-write (COW) is one of the kernel's most important optimizations. When you `fork()`, the child doesn't get a physical copy of the parent's memory - both processes share the same pages, marked read-only in the [page tables](page-tables.md). Only when either process writes does the kernel copy the page.

```
After fork():
┌─────────────┐     ┌─────────────┐
│   Parent    │     │    Child    │
│  Page Table │     │  Page Table │
└──────┬──────┘     └──────┬──────┘
       │                   │
       │    (read-only)    │
       └────────┬──────────┘
                ▼
         ┌─────────────┐
         │   Shared    │
         │   Physical  │
         │    Page     │
         └─────────────┘
```

This is why `fork()` is fast - no copying, just page table manipulation. But when does this sharing actually break?

## When COW triggers a copy

### 1. Any write to a shared page

The obvious case. When either process writes:

```c
pid_t pid = fork();
if (pid == 0) {
    // Child writes to a shared page
    buffer[0] = 'x';  // Page fault → COW copy
}
```

The write triggers a page fault, the kernel sees the page is shared, allocates a new page from the [page allocator](page-allocator.md), copies the content, and updates the faulting process's [page table](page-tables.md).

### 2. Writing to a private file mapping

`MAP_PRIVATE` file mappings use COW too:

```c
void *p = mmap(NULL, size, PROT_READ | PROT_WRITE,
               MAP_PRIVATE, fd, 0);  // Private mapping

// Initially shares pages with page cache
p[0] = 'x';  // COW: gets private copy
```

The initial mapping shares pages with the [page cache](page-cache.md). Writing triggers COW, giving you a private copy that diverges from the file.

### 3. KSM de-duplication (and then writing)

[KSM](ksm.md) (Kernel Same-page Merging) scans for identical pages and merges them with COW:

```
Before KSM:
Process A: [Page with "hello"]
Process B: [Page with "hello"]  (identical content)

After KSM merging:
Process A ──┐
            ├──► [Single shared page: "hello"]
Process B ──┘

After Process A writes:
Process A: [Private copy: "hello!"]  ← COW triggered
Process B: [Still sharing original]
```

This is why VMs with identical guest OS pages can share memory - until the guest writes.

### 4. `MADV_WIPEONFORK` regions after fork

Memory marked with `MADV_WIPEONFORK` ([added in kernel 4.14](https://git.kernel.org/linus/d2cd9ede6e19) | [LKML](https://lore.kernel.org/lkml/20170811212829.29186-3-riel@redhat.com/)) appears zeroed in the child:

```c
madvise(addr, len, MADV_WIPEONFORK);
fork();
// Child: sees zero-filled memory (on access)
// Parent: pages unchanged
```

The child doesn't inherit the parent's page mappings for this region. When the child accesses the memory, it faults in fresh zero pages on demand - not immediate allocation at fork time, but the content is effectively wiped.

## When COW doesn't work as expected

### Problem 1: fork() + immediate write pattern

The classic anti-pattern:

```c
char *big_buffer = malloc(1GB);
memset(big_buffer, 0, 1GB);  // Pages now allocated

pid_t pid = fork();
if (pid == 0) {
    // Child immediately writes to everything
    memset(big_buffer, 1, 1GB);  // COW copies ALL 1GB
    exit(0);
}
```

After the child's `memset`, you have 2GB of physical memory in use, not 1GB. The fork was "free," but the writes weren't. This is why [memory overcommit](overcommit.md) works - the kernel assumes most COW pages won't actually be copied.

**Solution**: If the child will `exec()` immediately, don't worry - `exec()` discards the address space before COW happens. If the child needs to process data, consider sharing memory explicitly with [`mmap(MAP_SHARED)`](mmap.md), or use `posix_spawn()` for the fork+exec pattern.

*Note: `vfork()` avoids page table copying but is dangerous - the child shares the parent's stack and address space entirely. Any writes in the child corrupt the parent. Only use it if you `exec()` or `_exit()` immediately.*

### Problem 2: Reading doesn't mean safe

Reading shared pages is safe... usually. But some "reads" are actually writes:

```c
// Looks like a read, but...
if (buffer[i] != 0) { ... }  // Safe read

// This is NOT just a read:
buffer[i]++;  // Read-modify-write = write = COW

// Neither is this (atomic read-modify-write):
__sync_fetch_and_add(&buffer[i], 1);  // Still triggers COW
```

### Problem 3: Page table overhead

COW doesn't copy pages, but it does copy **[page tables](page-tables.md)** at fork time:

```
Parent with large virtual address space:
├── Page tables: tens to hundreds of MB (depends on mapping density)
└── Physical pages: Whatever is actually in use

After fork():
├── Child gets copy of page tables (can be significant)
└── Physical pages: Still shared (COW)
```

For processes with large sparse address spaces, page table copying during fork can be significant. This is why `vfork()` exists - it doesn't copy page tables at all.

### Problem 4: COW and huge pages

[Huge pages](thp.md) (2MB or 1GB) interact with COW in interesting ways. For anonymous THP, the kernel splits the huge page into 4KB pages before COW to avoid copying 2MB for a single-byte write:

```
Original 2MB THP (after fork, shared):
┌─────────────────────────────────────────────────┐
│                    2MB page                     │
└─────────────────────────────────────────────────┘
                        │
                        ▼ Write triggers split first
┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
│ 4K │ 4K │ 4K │... │ 4K │ 4K │ 4K │ 4K │ 4K │ 4K │
└────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘
                        │
                        ▼ Then COW only the written 4K page
```

This splitting behavior is the default for anonymous THP since kernel ~4.5. However, **hugetlbfs** pages (explicit huge pages via `mmap(..., MAP_HUGETLB)`) are *not* split - writing one byte to a shared 2MB hugetlbfs page does copy all 2MB.

### Problem 5: GUP (get_user_pages) and COW

When the kernel pins user pages for DMA (via `get_user_pages()`), COW gets complicated. The [Dirty COW vulnerability](https://dirtycow.ninja/) (CVE-2016-5195) exploited a race condition in this area.

The kernel now handles this with more care, but the interaction between pinned pages and COW remains complex. See [`mm/gup.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/gup.c) for the gory details.

## Performance implications

### Memory bandwidth

COW copies consume memory bandwidth. If many processes fork and write:

```
Time:     t0          t1          t2          t3
          │           │           │           │
Parent    [====]      [====]      [====]      [====]
          fork↓
Child1    [====]      [====]──write──[copy]   [====]
                      fork↓
Child2              [====]──write──[copy]     [====]
                              fork↓
Child3                      [====]──write──[copy]
                                    │
                                    ▼
                          Memory bandwidth spike
```

### CPU overhead

The COW page fault path ([`mm/memory.c:do_wp_page()`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memory.c)) is well-optimized but not free:

1. Allocate new folio (without holding locks)
2. Copy page content via `__wp_page_copy_user()`
3. Take page table lock
4. Re-check PTE hasn't changed (another thread might have handled it)
5. Flush cache and TLB (`ptep_clear_flush()`)
6. Update rmap (`folio_add_new_anon_rmap()`)
7. Set new PTE (`set_pte_at()`)
8. Release locks

The copy happens *before* taking the lock - this allows concurrent faults on different pages. On a hot path with many COW faults, the overhead still adds up.

### TLB shootdowns

When a COW copy happens, the old read-only PTE must be replaced with a writable one pointing to the new page. This requires invalidating the stale TLB entry on the faulting CPU.

Note that after `fork()`, parent and child have *separate* address spaces (`mm_struct`). When the child COWs a page, only the child's page table changes - the parent's mapping to the original page remains valid. Cross-process TLB shootdowns don't apply here.

TLB shootdowns become expensive in *multithreaded* processes where multiple CPUs share the same `mm`. If one thread COWs a page that other CPUs have cached in their TLBs, those entries must be invalidated via inter-processor interrupts (IPIs).

## Monitoring COW

```bash
# Watch for COW faults
perf stat -e page-faults,minor-faults,major-faults ./program

# Trace COW events specifically
perf trace -e 'exceptions:page_fault_*' ./program

# Check a process's COW-related memory (see virtual-physical-resident.md for details)
grep -E "Private|Shared" /proc/<pid>/smaps | head -20

# Private_Clean:  Pages private to this process, not written since mapped
# Private_Dirty:  Pages private to this process, written (possibly COW'd)
# Shared_Clean:   Pages shared with others, not written
# Shared_Dirty:   Pages shared with others, written
# See [Virtual vs Physical vs Resident](virtual-physical-resident.md) for full smaps explanation
```

## Evolution

### Origins (pre-Linux)

COW was first implemented in the late 1960s/early 1970s. The technique became widespread in Unix systems in the 1980s. Linux inherited COW from the Unix tradition when Linus Torvalds wrote the first version in 1991.

*Note: The original Linux COW implementation predates git. The core logic in `mm/memory.c` has been substantially rewritten multiple times.*

### The Dirty COW vulnerability (2016)

**CVE-2016-5195** - Fixed by [commit 19be0eaffa3a](https://git.kernel.org/linus/19be0eaffa3a) ("mm: remove gup_flags FOLL_WRITE games from __get_user_pages()") | [LKML (stable backport)](https://lore.kernel.org/lkml/20161019182853.224077572@linuxfoundation.org/)

A race condition between COW and `get_user_pages()` allowed unprivileged users to write to read-only files, enabling privilege escalation. The bug was 11 years old - Linus Torvalds had attempted to fix it in 2005 ([commit 4ceb5db9757a](https://git.kernel.org/linus/4ceb5db9757a)) but that fix was reverted due to s390 issues.

*Note: The 2005 fix predates modern LKML archiving on lore.kernel.org.*

From the fix commit message:
> *"This is an ancient bug that was actually attempted to be fixed once (badly) by me eleven years ago... In the meantime, the VM has become more scalable, and what used to be a purely theoretical race back then has become easier to trigger."*

### FOLL_PIN and pin_user_pages() (v5.6, 2020)

**Commit**: [eddb1c228f79](https://git.kernel.org/linus/eddb1c228f79) ("mm/gup: introduce pin_user_pages*() and FOLL_PIN") | [LKML](https://lore.kernel.org/lkml/20200107224558.2362728-12-jhubbard@nvidia.com/)

**Author**: John Hubbard (NVIDIA)

Post-Dirty COW, the kernel needed a clean distinction between:
- **get_user_pages()**: Short-term references (will be released quickly)
- **pin_user_pages()**: Long-term pins for DMA (new FOLL_PIN flag)

This allowed the COW machinery to know when pages are pinned for DMA and handle them more carefully.

### PG_anon_exclusive (v5.19, 2022)

**Commit**: [6c287605fd56](https://git.kernel.org/linus/6c287605fd56) ("mm: remember exclusively mapped anonymous pages with PG_anon_exclusive") | [LKML](https://lore.kernel.org/lkml/20220428083441.37290-13-david@redhat.com/)

**Author**: David Hildenbrand (Red Hat)

The definitive fix for GUP/COW races. Added a page flag to track whether an anonymous page is exclusively owned. Key insight from the commit:

> *"Let's mark exclusively mapped anonymous pages with PG_anon_exclusive as exclusive, and use that information to make GUP pins reliable and stay consistent with the page mapped into the page table even if the page table entry gets write-protected."*

This replaced the "refcount > 1" heuristic with explicit exclusivity tracking, making COW behavior predictable even with pinned pages.

### COW under VMA lock (v6.4+, 2023)

**Commit**: [164b06f238b9](https://git.kernel.org/linus/164b06f238b9) ("mm: call wp_page_copy() under the VMA lock")

Part of the ongoing per-VMA lock work to improve page fault scalability. COW faults can now be handled without taking `mmap_lock` in many cases.

### THP COW improvements (v6.8+, 2024)

**Commit**: [1da190f4d0a6](https://git.kernel.org/linus/1da190f4d0a6) ("mm: Copy-on-Write (COW) reuse support for PTE-mapped THP")

When a THP is PTE-mapped and a COW fault occurs, the kernel can now reuse subpages that are exclusively owned rather than always copying. This reduces COW overhead for THP significantly.

## Related history

### MADV_WIPEONFORK (v4.14, 2017)

**Commit**: [d2cd9ede6e19](https://git.kernel.org/linus/d2cd9ede6e19) ("mm,fork: introduce MADV_WIPEONFORK") | [LKML](https://lore.kernel.org/lkml/20170811212829.29186-3-riel@redhat.com/)

**Author**: Rik van Riel (Red Hat)

Added for security-sensitive applications that need to regenerate secrets after fork (PRNG state, PKCS#11 sessions, etc.). Alternative to `MADV_DONTFORK` that preserves address space layout.

## Best practices

### For application developers

1. **After fork, exec quickly** - If you're just spawning a subprocess, `exec()` before touching memory
2. **Use `posix_spawn()` for subprocess creation** - It's safer than `fork()+exec()` and often faster
3. **Use MAP_SHARED for truly shared data** - Don't rely on COW for data you want to share; see [mmap](mmap.md)
4. **Avoid `vfork()` unless you know exactly what you're doing** - It's fast but dangerous (child shares parent's stack)

### For kernel/driver developers

1. **Minimize GUP usage** - Pinning pages complicates COW
2. **Use FOLL_PIN for long-term pins** - Proper accounting helps the COW machinery
3. **Test fork() paths** - COW bugs often manifest only after fork

## Try it yourself

```bash
# Watch COW in action
# Terminal 1: Create a process with large memory
python3 -c "
import os
data = bytearray(100 * 1024 * 1024)  # 100MB
print(f'Parent PID: {os.getpid()}')
pid = os.fork()
if pid == 0:
    print(f'Child PID: {os.getpid()}')
    input('Press Enter to write (trigger COW)...')
    data[0] = 1  # Trigger COW
    input('COW done. Press Enter to exit...')
else:
    os.wait()
"

# Terminal 2: Watch memory usage
watch -n 1 'ps -o pid,rss,vsz,comm -p <parent_pid>,<child_pid>'
# RSS increases after child writes (COW copy)

# Trace page faults during fork+exec
strace -f -e trace=clone,execve -o /tmp/trace.log /bin/ls
```

## Further reading

### Related docs

- [Memory overcommit](overcommit.md) - COW enables overcommit
- [KSM](ksm.md) - COW-based page deduplication
- [THP](thp.md) - COW behavior with huge pages
- [Process address space](mmap.md) - VMAs and page fault handling

### LWN articles

- [The Dirty COW vulnerability](https://lwn.net/Articles/704231/) (2016) - Security implications and root cause
- [Revisiting get_user_pages() and COW](https://lwn.net/Articles/849638/) (2020) - John Hubbard's analysis of the problem
- [Checking page "dirtiness" on the way out](https://lwn.net/Articles/827171/) (2020) - The FOLL_PIN solution
- [Tracking page state with PG_anon_exclusive](https://lwn.net/Articles/893906/) (2022) - David Hildenbrand's solution

### Key LKML threads

- [FOLL_PIN patch series](https://lore.kernel.org/lkml/20200107224558.2362728-12-jhubbard@nvidia.com/) - John Hubbard's v5.6 series
- [PG_anon_exclusive series](https://lore.kernel.org/lkml/20220428083441.37290-13-david@redhat.com/) - David Hildenbrand's v5.19 series
- [COW under VMA lock](https://lore.kernel.org/linux-mm/20230109205336.3665937-1-surenb@google.com/) - Suren Baghdasaryan's per-VMA lock work
