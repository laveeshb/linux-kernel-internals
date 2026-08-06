# CVE War Stories: Memory Management Lessons

> Four vulnerabilities that reshaped how the kernel thinks about memory safety — told as narratives from discovery to design change

The bugs covered here are all documented technically in other pages of this site. This page is the **narrative companion**: where each CVE came from, what exploitation actually looked like in practice, why the immediate fix was necessary but not sufficient, and what lasting changes the mm subsystem absorbed as a result.

Each story follows the same arc:

1. Discovery — who found it and how
2. The vulnerability — a brief restatement of what was wrong (with a cross-reference to the technical doc)
3. The exploitation primitive — what an attacker could concretely do
4. The fix — the specific kernel change
5. Design changes — the hardening work that followed
6. What it taught the mm subsystem — the lasting lesson

---

## Dirty COW (CVE-2016-5195)

*Race condition in copy-on-write — nine years in the tree*

### Discovery

In October 2016, Phil Oester was performing routine forensic analysis on a compromised production web server. Inside the exploit binary left by the attacker, he identified a previously unknown privilege escalation. The code was exploiting a race condition in the kernel's copy-on-write path. Oester contacted kernel security team members, and the bug was publicly disclosed on October 19, 2016.

The race condition itself had been introduced with kernel 2.6.22 in July 2007. Linus Torvalds had attempted a fix in 2005 — before it even shipped in that form — but the fix was reverted due to compatibility problems on s390. The window between creation and discovery: **nine years**.

The name "Dirty COW" comes from the dirty bit in the COW path, plus the bug's interaction with copy-on-write. It acquired its own logo and website (dirtycow.ninja), a rarity for kernel CVEs.

### The vulnerability

The technical mechanism is described in [cow.md — the Dirty COW section](cow.md#the-dirty-cow-vulnerability-2016). In brief: two threads could race to confuse the kernel into writing data to a read-only page instead of a private copy. One thread wrote through a `/proc/self/mem` path; the other called `madvise(MADV_DONTNEED)` to discard the COW copy the first thread was creating. Done rapidly enough, the kernel would drop the copy and retry the write — this time against the original read-only mapping.

The root cause was in `__get_user_pages()`. The function used `FOLL_WRITE` to indicate that a write was intended, but when the first attempt failed (due to the page being read-only and needing COW), it retried *without* `FOLL_WRITE`. The retry succeeded — but now the kernel no longer knew a write was coming, so it handed back the original page without performing COW. The madvise thread's job was to keep forcing these retries.

### The exploitation primitive

The primitive is a write-anywhere-to-a-read-only-file-mapping. On a typical Linux system, this means:

- **Overwrite `/etc/passwd`** — add a root-equivalent user with no password, or replace root's password hash
- **Patch a setuid binary** — inject shellcode into `/usr/bin/sudo` or any other setuid-root binary in place on disk
- **Root Android before Nougat** — the Android kernel did not receive the patch for several months; Android 6.x and earlier devices were widely exploited in the wild

Exploitation was reliable. The race window is narrow but the loop runs thousands of times per second, and the operation is idempotent — you can keep trying until you win. Public proof-of-concept exploits appeared within hours of disclosure. Red Hat noted that the bug was already being exploited before the patch was published.

The `userfaultfd` syscall (available since kernel 4.3) further widened the race window: an attacker could pause the kernel precisely in the middle of the fault path by triggering a user-handled fault, giving the madvise thread reliable timing. See [fork.md — userfaultfd races](fork.md#case-5-fork-and-userfaultfd-races) for the general pattern.

### The fix

**Commit**: [19be0eaffa3a](https://git.kernel.org/linus/19be0eaffa3a) — "mm: remove gup_flags FOLL_WRITE games from `__get_user_pages()`"
**Author**: Linus Torvalds
**Date**: October 19, 2016

The fix is three lines of substantive change. The `FOLL_WRITE` flag is set at the start of `__get_user_pages()` if a write was requested, and it stays set throughout all retries. There is no longer a retry path that drops write intent. If the page cannot be made writable, the fault fails — it does not silently fall back to handing out the read-only page.

Linus's commit message: *"This is an ancient bug that was actually attempted to be fixed once (badly) by me eleven years ago in commit 4ceb5db9757a ('Fix get_user_pages() race for write access') but that was then reverted in f33ea7f404e5 due to problems on s390."*

The backport went to every stable kernel in active support within 24 hours. The patch for stable kernels was coordinated by Greg Kroah-Hartman.

### Design changes

The immediate fix closed the FOLL_WRITE gap, but the underlying problem — the kernel having no reliable way to distinguish short-term GUP pins from long-term DMA pins — continued to produce related bugs.

Two major structural changes followed over the next six years:

**FOLL_PIN and `pin_user_pages()` (v5.6, 2020)**

**Commit**: [eddb1c228f79](https://git.kernel.org/linus/eddb1c228f79) — "mm/gup: introduce `pin_user_pages*()` and FOLL_PIN"
**Author**: John Hubbard (NVIDIA)

The kernel now has two distinct APIs for pinning user pages. `get_user_pages()` is for short-term references (the page will be released quickly, before userspace can observe the difference). `pin_user_pages()` is for long-term pins such as DMA operations — pages will be held for an extended period while the hardware operates on them. The two APIs differ in how they account for the pin in the refcount, allowing the COW machinery to detect long-term pins and handle them correctly.

**`PG_anon_exclusive` (v5.19, 2022)**

**Commit**: [6c287605fd56](https://git.kernel.org/linus/6c287605fd56) — "mm: remember exclusively mapped anonymous pages with `PG_anon_exclusive`"
**Author**: David Hildenbrand (Red Hat)

The definitive closure. A new page flag tracks whether an anonymous page is exclusively owned by one process. The COW machinery previously inferred exclusivity from refcount > 1 — a heuristic that failed under GUP pins. With `PG_anon_exclusive`, exclusivity is explicit state. A pinned page that a COW operation would normally reuse is now correctly identified as shared, and the COW copy is always made. The commit message: *"Let's mark exclusively mapped anonymous pages with PG_anon_exclusive as exclusive, and use that information to make GUP pins reliable."*

### What it taught the mm subsystem

!!! note "Lesson: Write intent must be an invariant, not a hint that retries can drop"

    The FOLL_WRITE race existed because the retry path was written as an optimization: on the first failed attempt, drop the write requirement to avoid a COW fault, then retry. The optimization assumed the retry would trigger the COW on second access. Under concurrent madvise, that assumption was false.

    The broader principle: when a caller states intent at the entry point of a syscall or kernel API (write, pin, fault), that intent must be carried through every retry and every slow path. Code that silently softens requirements during retry is a reliability hazard in single-threaded code and a security hazard in concurrent code.

    GUP in particular acquired a reputation as a trap for this class of bug. The FOLL_PIN / pin_user_pages() redesign was a direct architectural response: make the contract explicit in the API rather than inferred from context.

---

## StackRot (CVE-2023-3269)

*Use-after-free via maple tree rotation — new data structure, new invariant class*

### Discovery

In June 2023, Ruihan Li, a graduate student at Peking University, was auditing the maple tree — the interval tree that replaced red-black trees for VMA management in kernel 6.1. He was specifically looking at the interaction between the maple tree's RCU-safe rotation logic and the MM locking model.

The disclosure was published on the oss-security mailing list on July 5, 2023 ([link](https://www.openwall.com/lists/oss-security/2023/07/05/1)), after coordinated fixes landed in 6.1.37, 6.3.11, 6.4.1, and the 6.5-rc4 development tree. Unusually, Li had also developed a working privilege escalation exploit before disclosure, which he described in his GitHub writeup ([github.com/lrh2000/StackRot](https://github.com/lrh2000/StackRot)).

The bug was introduced with the maple tree merge in kernel 6.1 (December 2022). The window between introduction and disclosure was approximately seven months.

### The vulnerability

The technical mechanism is described in [fork.md — StackRot](fork.md#case-2-stackrot-cve-2023-3269). In brief: when the user stack grows downward (via a `MAP_GROWSDOWN` VMA), the kernel extends the VMA by lowering its start address. This modification updates the maple tree that stores VMAs — but the update did not hold the MM write lock. Because maple trees are designed for RCU-safe access, modifying a tree node creates a new node and schedules the old one for freeing via an RCU callback. Any thread holding the MM read lock at the time of the modification still holds a pointer to the old node, which will be freed when the RCU grace period expires.

The result is a use-after-free on a maple tree node. The object is freed while a live pointer to it exists in another kernel thread's stack frame.

### The exploitation primitive

UAF on a maple tree node is a controlled heap object reuse primitive. Li's exploit demonstrated:

1. Trigger the UAF to free the maple tree node
2. Spray the freed slab slot with a controlled object (a `pipe_buffer` or similar well-understood kernel heap object)
3. The kernel code that still holds the stale maple tree node pointer now reads attacker-controlled data as if it were tree metadata
4. Use the corrupted tree metadata to achieve arbitrary kernel read/write
5. Overwrite credential structure to escalate to root

The exploit required only unprivileged local access — no special capabilities. It worked on any system running kernel 6.1 through 6.4, which included all major distributions that had shipped 6.1+ kernels (notably Debian 12 "Bookworm", which shipped with 6.1).

Li noted the exploit was reliable on x86-64 with CONFIG_SLAB_FREELIST_HARDENED disabled, and that KFENCE could detect the UAF during development. The window between stack growth and RCU free is wide enough on loaded systems to be consistently winnable.

### The fix

The fix was merged by Linus Torvalds on June 28, 2023, during the 6.5 merge window.

The core change: stack VMA expansion now holds the MM write lock while modifying the maple tree. This prevents any concurrent reader from holding a stale RCU pointer to a node that is about to be freed — because modifications that require write lock cannot overlap with readers that hold read lock.

Additionally, the fix ensured that maple tree node replacements triggered by stack expansion take place in a context where the old node cannot be freed until all readers have released the MM lock.

Linus's merge message provided a detailed explanation of the locking invariant that had been violated and the reasoning for the chosen fix over alternatives.

### Design changes

StackRot triggered a broader review of the maple tree's correctness under the kernel's MM locking model.

**`LOCKDEP` annotations for maple tree operations** — several patches added or tightened lockdep assertions to ensure that tree modifications that can produce RCU-freeable nodes always happen under the appropriate lock. This makes future violations detectable in debug builds before they reach production.

**Maple tree stress testing expansion** — the maple tree test suite (`lib/test_maple_tree.c`) was expanded with concurrency tests specifically exercising the scenario that StackRot exploited. Syzbot coverage of the maple tree/VMA interaction was explicitly broadened in the fuzzer configurations maintained by Google and the kernel security team.

**Audit of other `MAP_GROWSDOWN` paths** — the stack growth path was audited for other sites where VMA metadata is modified outside of full MM write lock protection. No additional UAFs were found immediately, but the audit produced several tightening patches for adjacent code.

### What it taught the mm subsystem

!!! note "Lesson: RCU-safe does not mean lock-free for all callers — the locking domain must match the object lifetime"

    The maple tree's designers built careful RCU-safe node replacement: old nodes are freed via `kfree_rcu()` rather than immediately. This is correct within RCU's memory model. The error was that VMA readers use the MM read lock — not RCU read-lock — for their protection, so the RCU grace period does not protect them.

    When a new data structure is adopted in a subsystem with an existing locking model, the new structure's memory reclamation story must be audited against every existing protection primitive used by callers. "The tree is RCU-safe" and "all callers of the tree hold the correct lock" are separate properties. StackRot collapsed when the two were conflated.

    This is a recurring hazard when upgrading or replacing core data structures in the mm subsystem. The red-black tree that maple trees replaced had been in place for over a decade; its locking invariants were universally understood. A new structure starts with only the understanding of its authors.

---

## Meltdown (CVE-2017-5754)

*Hardware speculation defeats software isolation — KPTI and the permanent reshaping of kernel mapping policy*

### Discovery

The Meltdown and Spectre vulnerabilities were discovered independently by multiple research groups in 2017, then coordinated for simultaneous public disclosure on January 3, 2018.

Meltdown specifically was discovered by Jann Horn (Google Project Zero), and independently by Moritz Lipp, Michael Schwarz, Daniel Gruss, and colleagues at Graz University of Technology. The Graz group had been studying cache side-channel attacks against operating system isolation mechanisms; Horn came at it from the angle of speculative execution semantics and what the processor's out-of-order engine would actually do when asked to access a kernel address from user mode.

The coordinated disclosure was unusually complex. Intel, AMD, and ARM were notified in June 2017. OS vendors (Linux, Windows, macOS, FreeBSD) received notification under embargo. Coordinating patches across an entire operating system ecosystem — all of which needed to ship simultaneously to prevent any one vendor's patch from revealing the vulnerability before the others were ready — over a six-month embargo period is one of the largest coordinated disclosure operations in the history of software security.

The embargo broke early. Google's Project Zero policy requires public disclosure within 90 days of vendor notification. The 90-day window expired before the coordinated date. Disclosure was moved to January 3, 2018 — earlier than originally planned.

### The vulnerability

The technical mechanism is described in [page-tables.md — Meltdown](page-tables.md#case-1-meltdown-cve-2017-5754). In brief: Intel CPUs (and some ARM cores) speculatively execute instructions past a privilege check failure. When a user-mode process reads a kernel virtual address, the CPU raises a page fault — but before it does, it may have already speculatively read the kernel memory and placed the data in a register, and the memory access has left a trace in the L1/L2 cache. The fault is delivered and the register value is discarded, but the cache state persists. Using a Flush+Reload side channel, the attacker can measure which cache lines were populated by the speculative load and reconstruct the value that was briefly in the register.

The exploit is a loop: read one kernel byte speculatively, measure the cache side channel to recover the value, advance to the next byte.

### The exploitation primitive

Meltdown's primitive is **arbitrary kernel memory read from user space**, with no kernel code execution required, no memory corruption, and no race window to win. The attack is a pure observation of hardware behavior.

On a vulnerable system, an unprivileged process can read:

- The entire kernel image (defeating KASLR trivially — the kernel's virtual address is readable directly)
- Any other process's memory that is mapped in the kernel (via `copy_to_user` / `copy_from_user` buffers, page tables, pipe buffers, etc.)
- Cryptographic keys, TLS session data, or process secrets that happened to be in kernel memory at the time

The Graz team demonstrated reading `/etc/shadow` passwords from kernel memory at approximately 500 KB/s. The Project Zero PoC demonstrated reading kernel memory without privileges on a standard Linux desktop. No special hardware, no root, no kernel exploit — just careful timing of cache reads.

Cloud environments were the most immediately alarming target. On a shared host, one VM's kernel memory could potentially be read from another VM on the same physical CPU, breaking the fundamental tenant isolation promise of public cloud infrastructure. Amazon, Google, and Microsoft all scrambled to patch their hypervisor fleets before disclosure.

### The fix: KPTI

**Commit**: [aa8c6248f8c7](https://git.kernel.org/linus/aa8c6248f8c7) — "x86/mm/pti: Add infrastructure for page table isolation"
**Author**: Thomas Gleixner

KPTI — Kernel Page Table Isolation — is the only viable software mitigation for Meltdown. The principle: if kernel virtual addresses are not mapped in the user-mode page tables at all, speculative reads of kernel addresses from user mode will fault before they can populate the cache.

Before KPTI, Linux maintained a single set of page tables per process. The kernel's virtual address space was mapped in the upper portion of every process's page table, allowing the kernel to access user memory directly during system calls without switching page tables. This was a deliberate performance optimization stretching back decades.

KPTI creates two sets of page tables per process:

- A **user-mode table** that contains only the process's own mappings plus a minimal kernel stub — just enough to enter the kernel (the syscall entry trampoline) but no kernel data whatsoever
- A **kernel-mode table** that contains the full kernel virtual address space, used only while the CPU is in kernel mode

Transitioning from user to kernel mode now requires a CR3 switch (page table switch). Returning to user mode requires another. Every system call, every interrupt, every exception pays this cost.

The performance impact was immediately controversial. Benchmarks showed:

- **Database workloads** (many system calls): 5–15% throughput reduction
- **I/O-heavy workloads**: 3–10% reduction
- **CPU-bound workloads**: 0–1% (few system calls)
- **Syscall microbenchmarks**: up to 30% latency increase for very fast syscalls

Intel's subsequent hardware (Ice Lake and later) added PCID (Process-Context Identifiers) support, allowing TLB entries to be tagged by address space so that the CR3 switch does not require a full TLB flush. With PCID, KPTI overhead drops to roughly 1–3% on most workloads.

There is no patch that fixes the CPU itself. Microcode updates improved some behaviors but did not eliminate the fundamental speculation vulnerability on existing hardware. KPTI remains the authoritative mitigation on all Intel hardware that predates eIBRS (Enhanced Indirect Branch Restricted Speculation, Ice Lake 2019).

### Design changes

Meltdown and KPTI produced changes at every level of the kernel's memory mapping philosophy. Several are permanent.

**The "mapping the kernel in userspace is wrong" principle**

Before Meltdown, mapping kernel virtual addresses in user-mode page tables was not considered a security boundary. The protection was the supervisor bit on the PTEs — user mode could see the mappings but the CPU would fault if it tried to access them. Meltdown proved that "the CPU will fault" was insufficient: the speculative engine read the data before delivering the fault.

KPTI enshrined a new invariant: kernel addresses must not appear in user-mode page tables. This is now a design requirement, not an optimization decision.

**`/sys/devices/system/cpu/vulnerabilities/` sysfs interface**

Meltdown disclosure created a need to communicate CPU vulnerability status to users and administrators. The kernel added the `vulnerabilities/` sysfs directory, reporting per-vulnerability status (`Not affected`, `Mitigation: PTI`, `Vulnerable`) for each known CPU side-channel. This interface is now populated for Meltdown, Spectre v1, Spectre v2, MDS, TAA, and several other hardware vulnerabilities discovered after 2018.

**Spectre mitigations and the `nospec` barrier family**

Spectre (CVE-2017-5753, CVE-2017-5715), disclosed alongside Meltdown, is technically distinct but shares the speculative execution root cause. The mitigations for Spectre introduced a family of barrier macros — `array_index_nospec()`, `barrier_nospec()`, `__builtin_ia32_lfence()` wrappers — that the mm subsystem now uses wherever array bounds checks are followed by array accesses that could be speculated. See [page-tables.md — Spectre](page-tables.md#case-2-spectre-cve-2017-5753-cve-2017-5715) for the technical details.

**Retpoline and the indirect-call hardening pass**

Spectre v2 requires replacing indirect calls and indirect jumps with retpoline sequences — an artifice that uses a return stack loop to trap speculative execution rather than letting it follow the branch predictor to an attacker-chosen target. A large fraction of the kernel's indirect calls went through mm code paths (VMA operations, page fault handlers, page allocator callbacks). The retpoline audit produced a pass over mm code to eliminate or annotate indirect calls that could be targeted.

**KPTI as a template for future hardware mitigations**

After Meltdown, two further hardware vulnerabilities required KPTI-like page table manipulation: MDS (Microarchitectural Data Sampling, CVE-2018-12126 family) and TAA (TSX Asynchronous Abort, CVE-2019-11135). The infrastructure KPTI added for maintaining dual page tables, handling CR3 switches in the syscall and interrupt paths, and communicating mitigation status via sysfs was reused directly. The pattern — software isolation layer over a hardware-unfixable vulnerability — has become a recurring design idiom.

### What it taught the mm subsystem

!!! note "Lesson: Hardware assumptions are the hardest axioms to defend — isolation must be physical, not logical"

    The entire premise of kernel memory safety on x86 — that user-mode processes could not read kernel memory because the CPU would fault on the access — turned out to be conditional on the CPU not speculatively executing the read first. This conditional was not documented. It was not in the x86 architecture manual. It was discovered empirically by people who asked: what does the CPU *actually do*, not what does the architecture *say it does*.

    For the mm subsystem, the lesson operates on two levels.

    At the hardware level: any security property that depends on a CPU raising a fault *before* the side effects of an instruction are visible must be treated as suspect on out-of-order hardware. The CPU may have already done the work. The fault arrives late.

    At the design level: KPTI is proof that "logical separation" (supervisor bit on PTEs) is weaker than "physical absence" (the kernel virtual address does not exist in the user-mode page table). When a security boundary matters, the right implementation is to make crossing it require explicit work, not to rely on hardware to enforce it automatically. The kernel now maps nothing in user-mode page tables that does not need to be there.

    This is not cheap. Every system call on a patched Intel CPU is meaningfully slower than before 2018. That cost is paid permanently, on every Linux server and workstation, for hardware that will never be patched. It is the longest-lasting performance tax ever levied by a security vulnerability on the Linux kernel.

---

## THP COW Race (CVE-2020-29368)

*Mapcount atomicity in huge page splitting — an optimization assumption that broke under concurrency*

### Discovery

In November 2020, Jann Horn of Google Project Zero filed CVE-2020-29368 following analysis of the THP (Transparent Huge Page) copy-on-write path. Horn had been systematically reviewing copy-on-write interactions in the mm subsystem in the aftermath of Dirty COW and its follow-on fixes. The bug was a race condition in mapcount checking during huge PMD splitting, a code path introduced years earlier as part of the THP performance optimization work.

This was not a production incident or a forensic discovery. It was a targeted code audit by a researcher with deep knowledge of mm internals and a specific research question: after FOLL_WRITE and FOLL_PIN, are there remaining cases where COW can be bypassed?

### The vulnerability

The technical mechanism is described in [thp.md — THP COW race](thp.md#case-1-thp-cow-race-cve-2020-29368). In brief: when a write fault occurs on a shared 2MB THP, the kernel must split the huge page into 512 4KB pages before performing COW on the specific page that was written. The split decision is gated on `mapcount` — if the huge page is only mapped once (mapcount == 1), the kernel skips the COW copy and writes directly to the page, reusing it as a "private" page since no one else is sharing it.

The problem: `mapcount` is read and the COW decision is made, and then the page table is modified — but these two operations are not atomic. Another thread can map the same huge page between the mapcount read and the page table update, making the mapcount stale. The kernel writes to the page believing it has exclusive ownership; the second thread now shares a page that was supposed to be private.

### The exploitation primitive

The primitive is a COW bypass for anonymous THP. Unlike Dirty COW, which targeted read-only file mappings, this race targets anonymous private mappings — the kind created by `malloc()`, stack allocation, and anonymous `mmap()`.

The exploit primitive:

1. Allocate a large anonymous buffer (backed by THP) in process A
2. Fork — now both parent and child share the THP under COW semantics
3. In the child: trigger a write fault on the THP while a racing thread in the parent maps the same huge page
4. Win the race: the child writes directly to the shared physical page rather than making a copy
5. Both processes now see each other's writes to what they each believe is a private mapping

This breaks the fundamental process isolation guarantee for anonymous memory. In practice, the race window is narrow — the mapcount check and the PTE update happen within a single fault handler invocation — but with userfaultfd or FUSE to control fault timing, the window can be reliably widened.

The impact: an attacker who can run code in a process that shares a THP with a privileged process (via fork, or via a deliberate memory sharing arrangement) can potentially read or write that privileged process's private memory. In container environments where a host process forks worker children, this could allow a container escape or cross-container read.

### The fix

**Commit**: [c444eb564fb1](https://git.kernel.org/linus/c444eb564fb1) — "mm: thp: make the THP mapcount atomic against `__split_huge_pmd_locked()`"
**Author**: Andrea Arcangeli (reported by Jann Horn)

The fix makes the mapcount read and the PTE update atomic with respect to each other by holding the page table lock across both operations. The mapcount is re-read under the lock, and the COW decision is made only when the kernel can guarantee no new mapping can be added while it proceeds with the direct write.

This is a small patch — the change is a lock scope extension and a re-check under the lock — but it requires care because the page table lock is already held in related code paths and acquiring it twice is a deadlock risk. Horn's fix carefully identifies the precise site where the lock must be widened.

### Design changes

CVE-2020-29368 was part of a series of COW-related audits and fixes in 2020–2022 that treated the GUP / COW interaction as a subsystem in need of systematic hardening rather than point fixes.

**`wp_page_reuse()` audit**

The function `wp_page_reuse()` is the kernel's page reuse optimization: when COW detects that the page has only one user, it avoids the copy and promotes the existing page directly to writable status. Every caller of this function was audited for correct mapcount accounting. Several adjacent callers were tightened or annotated.

**THP-specific COW reuse (v6.15, 2025)**

**Commit**: [1da190f4d0a6](https://git.kernel.org/linus/1da190f4d0a6) — "mm: Copy-on-Write (COW) reuse support for PTE-mapped THP"
**Author**: David Hildenbrand (Red Hat)

After `PG_anon_exclusive` was established as the authoritative ownership tracker for anonymous pages (see [the Dirty COW design changes above](#design-changes)), THP COW could be re-optimized more safely. A PTE-mapped THP subpage that is `PG_anon_exclusive` — exclusively owned — can be reused on COW without a copy, because the ownership tracking is now explicit state rather than an inferred heuristic from mapcount. The optimization that CVE-2020-29368 exploited has been rebuilt on a sound foundation.

**Syzbot THP coverage expansion**

Following the CVE, the Google syzbot continuous fuzzing infrastructure added specific THP-related fault injection scenarios. These cover the split path, the mapcount check, and concurrent fork/write/madvise races against THP regions. As of 2024, syzbot runs multiple THP-targeted kernels continuously.

### What it taught the mm subsystem

!!! note "Lesson: Optimizations that skip copies based on ownership heuristics need atomic ownership checks"

    The `mapcount == 1` optimization was sound in a world where checking the count and acting on it could be considered instantaneous. In a concurrent kernel with preemption and SMP, the window between "check the count" and "act on the result" is long enough to fit a racing thread's map operation.

    This is a specific instance of the check-then-act TOCTOU class. The general principle: any decision of the form "because X is true, I will skip the safety operation Y" requires that X remain true for the entire duration of the decision's consequence. If X can change between the check and the act, the check must be performed under a lock that prevents X from changing.

    The broader lesson for THP: huge pages are performance optimizations that introduce concurrency hazards that do not exist at 4KB granularity. A 2MB page is shared by 512 times more PTEs than a 4KB page, making racing operations 512 times more likely to interfere with each other at a given access rate. The complexity multiplier of THP is not just in the code — it is in the space of possible interleavings.

---

## Cross-cutting lessons

The four CVEs above span hardware speculation, race conditions in COW, data structure locking invariants, and ownership tracking. Despite their differences, they share structural patterns that repeat across mm security bugs.

### The patterns

| CVE | Root pattern | Where it appears again |
|-----|-------------|----------------------|
| Dirty COW | Write intent dropped during retry | Any retry loop that weakens preconditions |
| StackRot | Protection domain mismatch (RCU vs lock) | Any new data structure with different reclamation semantics |
| Meltdown | Hardware behavior contradicts architecture spec | Any security property depending on a CPU fault arriving before side effects |
| THP COW race | TOCTOU on ownership heuristic | Any optimization that skips a safety operation based on a non-atomic check |

### Defense in depth after 2020

Each CVE described here contributed one or more components to the current layered defense model for mm:

- **Explicit ownership tracking** (`PG_anon_exclusive`) rather than inferred ownership from refcount heuristics — closes the class of COW bypass bugs
- **Separate GUP APIs** (`pin_user_pages` vs `get_user_pages`) with accounting — makes long-term pins visible to COW
- **KPTI** — makes kernel virtual addresses physically absent from user-mode page tables
- **Lockdep annotations on maple tree operations** — makes protection domain violations detectable in debug builds
- **`unprivileged_userfaultfd = 0`** in most distributions — reduces the race window amplification primitive available to exploits
- **KFENCE and KASAN** — detect UAF in development and staging before production

No single mitigation is complete. The value is in the combination: an attacker who wins a race condition but cannot amplify the window (no userfaultfd), cannot reliably reuse the freed object (KFENCE detects it in testing), and cannot read kernel memory to build an exploit chain (KPTI, kptr_restrict) faces a substantially harder problem than the same attacker in 2016.

---

## Further reading

### Original disclosures

- [dirtycow.ninja](https://dirtycow.ninja/) — Dirty COW disclosure, October 2016
- [meltdownattack.com](https://meltdownattack.com/) — Meltdown paper and PoC, January 2018
- [StackRot disclosure](https://github.com/lrh2000/StackRot) — CVE-2023-3269, July 2023
- [oss-security: CVE-2020-29368](https://www.openwall.com/lists/oss-security/2020/12/03/2) — THP COW race

### LWN coverage

- [Dirty COW and clean commit messages](https://lwn.net/Articles/704231/) (2016) — Jonathan Corbet on the Dirty COW race and its fix
- [The current state of kernel page-table isolation](https://lwn.net/Articles/741878/) (2017) — KPTI design, the Meltdown mitigation
- [Patching until the COWs come home (part 1)](https://lwn.net/Articles/849638/) (2021) — Vlastimil Babka on the GUP-pin vs. COW problem
- [get_user_pages() and COW, 2022 edition](https://lwn.net/Articles/895439/) (2022) — David Hildenbrand's PG_anon_exclusive solution

### Key kernel commits

- [19be0eaffa3a](https://git.kernel.org/linus/19be0eaffa3a) — Dirty COW fix
- [aa8c6248f8c7](https://git.kernel.org/linus/aa8c6248f8c7) — KPTI initial infrastructure
- [eddb1c228f79](https://git.kernel.org/linus/eddb1c228f79) — FOLL_PIN introduction
- [6c287605fd56](https://git.kernel.org/linus/6c287605fd56) — PG_anon_exclusive
- [c444eb564fb1](https://git.kernel.org/linus/c444eb564fb1) — THP mapcount atomicity fix

### Technical docs on this site

- [Copy-on-Write](cow.md) — COW mechanics, GUP, and the full FOLL_PIN/PG_anon_exclusive evolution
- [What happens when you fork](fork.md) — Dirty COW and StackRot technical walkthrough
- [Page Tables](page-tables.md) — Meltdown, KPTI, and Spectre technical details
- [Transparent Huge Pages](thp.md) — THP COW race and khugepaged bugs
- [Bug Index](bugs/README.md) — full CVE catalog with links to all technical analyses
