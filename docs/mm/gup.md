# Getting User Pages (GUP)

> `get_user_pages()` vs `pin_user_pages()`, FOLL_LONGTERM, fast GUP, and why pinning fights copy-on-write and page migration

When the kernel — or a device behind it — needs to touch a page of *user* memory by its physical identity rather than through the process's page tables, it calls into the **get_user_pages** family (universally "GUP"). This is one of the most consequential and most bug-prone interfaces in the memory-management subsystem: it sits exactly where the stable world of physical pages meets the shifting world of user virtual memory, and getting the contract wrong has produced some of Linux's most famous vulnerabilities.

This page is about the *why*: why GUP has to exist, why it was split into two APIs that look almost identical, and why "just pin the page" turns out to be one of the hardest promises the kernel makes. For the copy-on-write fallout specifically, read [Copy-on-Write](cow.md) and the [CVE case studies](war-stories-cves.md); for the fast-path performance angle, [io_uring fixed buffers](../io-uring/fixed-buffers.md).

---

## The problem GUP solves

A user virtual address is a *lease*, not a deed. The page it names can be, at almost any moment:

- **not present yet** — never faulted in, or reclaimed to swap ([Page Fault Handler](page-fault.md));
- **relocated** — moved by compaction, NUMA balancing, or CMA to a different physical frame ([Compaction](compaction.md));
- **shared and read-only** — a copy-on-write page that will be duplicated on the next write ([Copy-on-Write](cow.md)).

That instability is fine for a CPU touching its own memory through its own page tables — the MMU and fault handler paper over it transparently. It is *not* fine for three important users who need to reach a page **by physical address, outside the owning process's page-table walk**:

1. **Hardware DMA** — a NIC, GPU, or NVMe controller programmed with a physical (or IOMMU) address will read/write that frame directly. If the kernel migrates or frees it mid-transfer, the device corrupts whatever now lives there.
2. **The kernel accessing another address space** — `process_vm_readv()`, ptrace, futexes on shared mappings, `vmsplice()`.
3. **Direct I/O** — the block layer DMAs straight into user buffers, bypassing the page cache.

GUP is the bridge: hand it an `mm_struct` and a user virtual address range, and it walks that process's page tables (**faulting pages in if necessary**), resolves each address to a `struct page`, takes a reference that holds the page in place, and returns the array of `struct page *`. The caller now has a physically-stable handle it can DMA to or `kmap()` — until it releases the reference.

```c
/* the shape of it — mm/gup.c */
long pin_user_pages(unsigned long start, unsigned long nr_pages,
                    unsigned int gup_flags, struct page **pages);
/* ... walk page tables, fault in what's missing, grab a ref per page ... */
/* later: */
unpin_user_pages(pages, nr_pages);
```

The `gup_flags` (`FOLL_WRITE`, `FOLL_PIN`, `FOLL_LONGTERM`, …) encode the caller's *intent*, and — as the history below shows — the entire safety of the interface turns on stating that intent correctly.

---

## get vs pin: two APIs that look identical and mean opposite things

Since Linux 5.6 there are two families that appear interchangeable:

| | `get_user_pages()` (FOLL_GET) | `pin_user_pages()` (FOLL_PIN) |
|---|---|---|
| **The distinction — will the caller access the page's *data*?** | **No** — only manipulates `struct page` metadata, not the memory it tracks | **Yes** — reads/writes the actual page contents (e.g. DMA) |
| Reference taken | ordinary page refcount +1 | base page: refcount += `GUP_PIN_COUNTING_BIAS` (1024); large folios use a separate `_pincount` |
| Detectable as a DMA pin? | no — indistinguishable from any other ref | yes — `folio_maybe_dma_pinned()` |
| Release with | `put_page()` | `unpin_user_pages()` |

The primary axis is **data access, not duration** — the kernel documentation is explicit that "FOLL_GET is for `struct page` manipulation, without affecting the data," while FOLL_PIN is for when "the caller will access the page data." (*How long* the pin is held is a separate axis, owned by `FOLL_LONGTERM` below.) The split exists because of a subtle, expensive lesson: **an ordinary reference count cannot tell the memory-management core that a page is being used for DMA.** A refcount of, say, 3 could mean three fleeting references or one live DMA transfer that must not be disturbed. Code that needs to make a decision — "is it safe to migrate this page, or write back this dirty folio while a device might still be writing to it?" — had no way to ask.

John Hubbard's `FOLL_PIN` redesign ([LWN: Explicit pinning of user-space pages](https://lwn.net/Articles/807108/)) makes the DMA intent *visible in the page itself*. The trick, per the [kernel documentation](https://docs.kernel.org/core-api/pin_user_pages.html), is to bias the count: a pin adds `GUP_PIN_COUNTING_BIAS` (1024) to the refcount rather than 1, so:

```c
/* "is this page pinned for DMA?" becomes answerable */
if (folio_maybe_dma_pinned(folio))
        /* do NOT migrate; do NOT assume writeback ends the writer */
```

The bias scheme is a pragmatic hack — on a huge compound page the count was shared, so a 1 GB page could only be pinned a handful of times before overflow, which is why large folios grew a *separate* `_pincount` field. But the important part is conceptual: **the API now carries the contract that context used to only imply.** The guidance is blunt — new code that touches page data should use `pin_user_pages()`; `get_user_pages()` is legacy for the cases that only manipulate `struct page` metadata.

---

## FOLL_LONGTERM: the pin that fights the whole memory manager

A short pin is a nuisance; a *long* pin is a structural problem. `FOLL_LONGTERM` marks a pin that may last seconds, minutes, or the lifetime of an RDMA registration — and an indefinitely unmovable page is at war with two subsystems designed around the assumption that any page can be relocated:

- **Compaction / anti-fragmentation** — the kernel earns physically-contiguous free space by migrating movable pages together. A long-term pin nails a page in place, permanently fragmenting the region around it ([Compaction](compaction.md)).
- **CMA and `ZONE_MOVABLE`** — these regions exist *specifically* so their pages can always be migrated away when someone needs contiguous memory. A page pinned there defeats the region's entire reason for existing ([CMA](cma.md)).

The kernel's answer is **migrate-before-pin**: a `FOLL_LONGTERM` request first tries to move the target page *out* of any movable zone or CMA area into ordinary memory, and only then pins it. If the migration fails, so does the pin ([LWN: Preserving the mobility of ZONE_MOVABLE](https://lwn.net/Articles/843326/), [prohibit pinning pages in ZONE_MOVABLE](https://lwn.net/Articles/843143/)). This is why a classic CMA allocation failure is "a page here is pinned by `get_user_pages()`" — a device driver's DMA buffer holding a CMA page hostage. The tension is fundamental: **movability and long-term pinning are mutually exclusive by construction**, and the kernel can only choose which one wins per-page.

---

## Fast GUP: walking page tables without the locks

The straightforward GUP path takes `mmap_lock` and walks the page tables under it. For a high-IOPS direct-I/O or io_uring workload doing millions of pins per second, that lock and the full walk are pure overhead ([io_uring fixed buffers](../io-uring/fixed-buffers.md) exists precisely to amortize it away). So there is a **lockless fast path**, `get_user_pages_fast()` / `pin_user_pages_fast()` — Nick Piggin's original x86 work in 2.6.27 ([LWN: Toward better direct I/O scalability](https://lwn.net/Articles/275808/)):

- It walks the page tables **without taking `mmap_lock`**, relying instead on the fact that a fast-GUP walker runs with **interrupts disabled**. On x86 that blocks the TLB-shootdown IPI that page-table freeing broadcasts, so the tables can't vanish underneath the walk; architectures with hardware TLB broadcast instead **RCU-free** the page tables and the interrupts-off window acts as the RCU read-side critical section ([LWN: a general RCU get_user_pages_fast](https://lwn.net/Articles/616211/); see [RCU in memory management](rcu-mm.md), `follow_page_mask()` and the `gup_fast` machinery in `mm/gup.c`).
- It speculatively bumps the refcount and then **re-validates** the PTE; if anything changed, it backs out and falls back to the slow, locked path.

This is a textbook lockless-read pattern: optimistic, verify-after, fall back on conflict. It is also the reason GUP interacts so delicately with copy-on-write — a fast walker and a faulting writer can race on the very same PTE.

---

## Why GUP is a bug magnet: the copy-on-write collision

Almost every notorious GUP bug is the same shape: **a page was pinned for one purpose while copy-on-write changed what that page *means*.** Two canonical examples (told in full in [Copy-on-Write](cow.md) and the [CVE case studies](war-stories-cves.md)):

- **Dirty COW (CVE-2016-5195)** — an 11-year-old race where `__get_user_pages()` retried a failed write fault *without* re-asserting `FOLL_WRITE`, so it handed back the original read-only page instead of a COW copy — letting an unprivileged process write read-only files. Fixed by [19be0eaffa3a](https://git.kernel.org/linus/19be0eaffa3a), which keeps write intent set across all retries.
- **The vmsplice/COW leak** — a child that pins a shared COW page via GUP, then lets the parent write to it, can observe the parent's later data through the stale pin even after unmapping its own PTE ([LWN: Patching until the COWs come home](https://lwn.net/Articles/849638/)).

The deep fix was architectural, not a patch: the `FOLL_PIN` split and `PG_anon_exclusive` exist so the COW machinery can *see* long-term pins and refuse to share a pinned page in the first place. GUP earned its reputation as a trap for exactly this class of bug, and the redesign's whole thesis is **make the contract explicit in the API rather than inferred from context** — because inference is what kept failing.

---

## The caller taxonomy

The [kernel documentation](https://docs.kernel.org/core-api/pin_user_pages.html) classifies GUP callers into cases, which is the fastest way to choose the right call:

| Case | Caller | Correct call |
|------|--------|--------------|
| 1 | **Direct I/O** — short-lived buffer, DMA completes soon | `pin_user_pages_fast()` |
| 2 | **RDMA / long-lived DMA** — buffer registered indefinitely | `pin_user_pages(..., FOLL_LONGTERM)` |
| 3 | **MMU-notifier users** — track the mapping, re-fetch on invalidation | often no pin needed |
| 4 | **`struct page` manipulation only** — never touches page *data* | `get_user_pages()` |
| 5 | **Writing to page data** | `pin_user_pages()` |

You never pass `FOLL_PIN` yourself — it is internal to GUP and "should not appear at the gup call sites"; you pick the `pin_user_pages*()` wrapper and it sets `FOLL_PIN` for you. The rule of thumb the documentation pushes: if you will access the *data*, use a pin; if the access outlives the syscall, add `FOLL_LONGTERM` and accept the migrate-first cost.

---

## Observing pins

```bash
# VmPin = pages pinned unmovable; drivers that account long-term pins
# (RDMA, VFIO, io_uring registered buffers) charge them to pinned_vm here.
# Note: an ad-hoc get_user_pages() pin is NOT systematically exposed —
# only callers that explicitly account show up.
grep -i "VmLck\|VmPin" /proc/$$/status

# Watch a device driver's DMA pinning live (VFIO, RDMA, io_uring):
sudo bpftrace -e 'kprobe:pin_user_pages_remote,
                  kprobe:pin_user_pages_fast { @[probe, comm] = count(); }'

# See GUP in kernel CPU profiles of a direct-I/O / io_uring workload —
# get_user_pages_fast / unpin_user_pages appear prominently unless the
# app uses registered/fixed buffers:
sudo perf top -e cycles --sort comm,symbol | grep -iE "user_pages"

# CMA allocation failing because a page in the region is pinned?
dmesg | grep -iE "alloc_contig|cma:.*fail|migrat"
```

---

## Common issues

**"CMA allocation failed" under memory pressure.** Almost always a page in the CMA region is pinned by an in-flight `get_user_pages()`/DMA and cannot be migrated out. The fix is upstream in the driver (use bounce buffers, or don't long-term-pin CMA pages), not in tuning.

**RDMA/VFIO registration fails with `-ENOMEM` despite free memory.** `FOLL_LONGTERM` migrate-before-pin couldn't relocate the page out of `ZONE_MOVABLE`, or you've hit `RLIMIT_MEMLOCK`. Long-term pins count against locked-memory limits precisely because they are unreclaimable.

**A device reads stale/garbage data after fork.** A classic pin-vs-COW interaction: pages pinned before a `fork()` can diverge from what the child sees once COW kicks in. Modern kernels mitigate this — pinned anonymous pages are copied *eagerly* at fork rather than shared COW (Peter Xu's early-COW-for-pinned-pages, 5.9), and 5.19's `PG_anon_exclusive` made GUP-vs-COW reliable in general — but the underlying hazard is why long-term DMA buffers should be set up with this in mind.

---

## Version notes

| Change | Linux version | Why it matters here |
|--------|--------------|---------------------|
| `get_user_pages_fast()` lockless path | 2.6.27 ([8174c430e445](https://git.kernel.org/linus/8174c430e445)) | The high-throughput DMA/direct-I/O fast path |
| Dirty COW fix (write intent kept across retries) | 4.8.3 / 4.9 ([19be0eaffa3a](https://git.kernel.org/linus/19be0eaffa3a)) | Closed CVE-2016-5195 (merged Oct 2016) |
| `pin_user_pages()` + `FOLL_PIN` | 5.6 ([eddb1c228f79](https://git.kernel.org/linus/eddb1c228f79)) | DMA intent made visible via the pin bias |
| `pin_user_pages_remote()` replaces `get_user_pages_remote()` for DMA | 5.6 | VFIO/RDMA switch to the pin API |
| Prohibit long-term pins in `ZONE_MOVABLE`; migrate-first | 5.11–5.12 | Preserves movability of CMA/movable zones |
| Early-COW for pinned pages at fork | 5.9 | Pinned anon pages copied eagerly instead of shared |
| `PG_anon_exclusive` — reliable COW vs pin | 5.19 ([LWN](https://lwn.net/Articles/887178/)) | The architectural end of the GUP/COW war |

---

## Further reading

### Kernel source & documentation

- [Documentation/core-api/pin_user_pages.rst](https://docs.kernel.org/core-api/pin_user_pages.html) — the authoritative contract: FOLL_GET vs FOLL_PIN, the caller cases, the counting bias
- [mm/gup.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/gup.c) — `get_user_pages*`, `pin_user_pages*`, `follow_page_mask()`, and the `gup_fast` lockless walk
- [include/linux/mm.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mm.h) — the `FOLL_*` flag definitions

### Related pages

- [Copy-on-Write](cow.md) — the GUP/COW interaction in full, and `PG_anon_exclusive`
- [CVE Case Studies](war-stories-cves.md) — Dirty COW and the FOLL_PIN redesign as incident history
- [io_uring Fixed Buffers](../io-uring/fixed-buffers.md) — pinning once to erase per-I/O GUP cost
- [VFIO Internals](../iommu/vfio-internals.md) — `pin_user_pages_remote()` for device DMA
- [CMA](cma.md) — why pinned pages are the top cause of CMA allocation failure
- [RCU in Memory Management](rcu-mm.md) — the lockless page-table walk fast GUP relies on

### LWN articles

- [Explicit pinning of user-space pages](https://lwn.net/Articles/807108/) — John Hubbard introduces `pin_user_pages()` and the counting bias
- [Patching until the COWs come home (part 1)](https://lwn.net/Articles/849638/) — Vlastimil Babka on the pin-vs-COW data-leak class
- [Preserving the mobility of ZONE_MOVABLE](https://lwn.net/Articles/843326/) — migrate-before-pin and why long-term pins threaten movable zones
- [Reliable GUP pins of anonymous pages](https://lwn.net/Articles/887178/) — David Hildenbrand on `PG_anon_exclusive` and ending the GUP/COW war
- [Toward better direct I/O scalability](https://lwn.net/Articles/275808/) — the 2008 origin of lockless `get_user_pages_fast()`
- [A general RCU get_user_pages_fast](https://lwn.net/Articles/616211/) — RCU-freed page tables for architectures without IPI TLB shootdown
