# Memory Management Bugs (Kernel)

> A catalog of notable Linux kernel memory management bugs, vulnerabilities, and edge cases

This index covers bugs in the Linux kernel's mm/ subsystem - security vulnerabilities, data corruption, performance regressions, and stability issues. These are real kernel bugs we analyze for educational purposes.

## Quick Reference

### By Severity

| Severity | Count | Examples |
|----------|-------|----------|
| **Critical (CVE, exploit)** | 15+ | Dirty COW, Meltdown, SLUB exploits |
| **Data corruption** | 5+ | Large folio data loss, swap ABA |
| **Deadlock/hang** | 5+ | mmap_sem deadlock, OOM livelock |
| **Performance** | 5+ | Thrashing, readahead traps |

### By Year

| Year | Notable Bugs |
|------|--------------|
| 2024 | Swap slot ABA (CVE-2024-26759) |
| 2023 | StackRot (CVE-2023-3269), Large folio data loss, glibc heap overflow (CVE-2023-6246) |
| 2022 | io_uring UAF (CVE-2022-29582), systemd cgroup massacre |
| 2021 | Netfilter heap OOB (CVE-2021-22555) |
| 2020 | THP COW race (CVE-2020-29368) |
| 2018 | mremap TLB race (CVE-2018-18281), Spectre variants |
| 2017 | Meltdown (CVE-2017-5754), Spectre (CVE-2017-5753/5715), Stack Clash |
| 2016 | Dirty COW (CVE-2016-5195) |

---

## Detailed Bug Documentation

### Subsystem Bug Sections

Detailed analysis of bugs in specific subsystems (located within each topic's documentation):

| Document | Subsystem | Key Bugs |
|----------|-----------|----------|
| [SLUB Allocator Bugs](../slab.md#notorious-bugs-and-edge-cases) | mm/slub.c | CVE-2021-22555, CVE-2022-29582, heap exploitation |
| [THP Bugs](../thp.md#notorious-bugs-and-edge-cases) | mm/huge_memory.c | CVE-2020-29368, khugepaged races, collapse bugs |
| [Page Table Bugs](../page-tables.md#notorious-bugs-and-edge-cases) | arch/*/mm/ | Meltdown, Spectre, TLB flush races |

### Lifecycle Document Bug Sections

The lifecycle docs contain narrative bug coverage as part of their end-to-end walkthroughs:

| Document | Section | Key Bugs |
|----------|---------|----------|
| [fork.md](../fork.md#notorious-bugs-and-edge-cases) | COW & fork bugs | Dirty COW (CVE-2016-5195), StackRot (CVE-2023-3269), mremap (CVE-2004-0077) |
| [oom.md](../oom.md#notorious-bugs-and-edge-cases) | OOM killer bugs | mmap_sem deadlock, thrashing livelock, CVE-2012-4398 |
| [life-of-malloc.md](../life-of-malloc.md#notorious-bugs-and-edge-cases) | Heap & allocation bugs | glibc CVE-2023-6246, Stack Clash, mmap_min_addr bypass |
| [life-of-page.md](../life-of-page.md#notorious-bugs-and-edge-cases) | Page lifecycle bugs | Refcount overflow, large folio data loss, LRU corruption |
| [life-of-read.md](../life-of-read.md#notorious-bugs-and-edge-cases) | Page cache bugs | filemap_fault races, 9p corruption, readahead issues |
| [swapping.md](../swapping.md#notorious-bugs-and-edge-cases) | Swap bugs | Swap slot ABA (CVE-2024-26759), zswap races |

---

## Bug Categories

### Security Vulnerabilities (CVEs)

Bugs with assigned CVEs, typically exploitable for privilege escalation or information disclosure.

| CVE | Name | Subsystem | Type | Details |
|-----|------|-----------|------|---------|
| CVE-2024-26759 | Swap slot ABA | swap | Race/corruption | [swapping.md](../swapping.md#case-1-the-swap-slot-aba-problem-cve-2024-26759) |
| CVE-2023-3269 | StackRot | maple tree | UAF | [fork.md](../fork.md#case-2-stackrot-cve-2023-3269) |
| CVE-2023-6246 | glibc syslog | glibc heap | Overflow | [life-of-malloc.md](../life-of-malloc.md#case-1-glibc-heap-overflow-cve-2023-6246) |
| CVE-2022-29582 | io_uring UAF | io_uring/slub | UAF | [slab.md](slab.md#case-2-io_uring-use-after-free-cve-2022-29582) |
| CVE-2021-22555 | Netfilter heap OOB | netfilter/slub | Heap OOB | [slab.md](slab.md#case-1-netfilter-heap-out-of-bounds-cve-2021-22555) |
| CVE-2020-29368 | THP COW race | thp | Race | [thp.md](thp.md#case-1-thp-cow-race-cve-2020-29368) |
| CVE-2018-18281 | mremap TLB race | mremap | TLB race | [fork.md](../fork.md#case-4-tlb-flush-races-in-mremap-cve-2018-18281) |
| CVE-2017-5754 | Meltdown | CPU/page tables | Side channel | [page-tables.md](page-tables.md#case-1-meltdown-cve-2017-5754) |
| CVE-2017-5753 | Spectre v1 | CPU | Side channel | [page-tables.md](page-tables.md#case-2-spectre-cve-2017-5753-cve-2017-5715) |
| CVE-2017-5715 | Spectre v2 | CPU | Side channel | [page-tables.md](page-tables.md#case-2-spectre-cve-2017-5753-cve-2017-5715) |
| CVE-2016-5195 | Dirty COW | COW | Race | [fork.md](../fork.md#case-1-dirty-cow-cve-2016-5195) |
| CVE-2012-4398 | OOM deadlock | OOM | Deadlock | [oom.md](../oom.md#case-5-cve-2012-4398---oom-deadlock-denial-of-service) |
| CVE-2009-2695 | mmap_min_addr bypass | mmap | Logic | [life-of-malloc.md](../life-of-malloc.md#case-3-mmap_min_addr-bypass-cve-2009-2695) |
| CVE-2004-0077 | mremap disaster | mremap | Logic | [fork.md](../fork.md#case-3-the-mremap-disaster-cve-2004-0077) |

### Data Corruption Bugs

Bugs causing silent data loss or corruption without security implications.

| Bug | Year | Subsystem | Details |
|-----|------|-----------|---------|
| Large folio data loss | 2023 | writeback/folio | [life-of-page.md](../life-of-page.md#case-2-large-folio-data-loss-2023) |
| Swap slot ABA | 2024 | swap | [swapping.md](../swapping.md#case-1-the-swap-slot-aba-problem-cve-2024-26759) |
| 9p read corruption | 2025 | 9p/netfs | [life-of-read.md](../life-of-read.md#case-2-9p-read-corruption-2025) |
| zswap races | Ongoing | zswap | [swapping.md](../swapping.md#case-2-zswap-race-conditions) |

### Deadlock & Hang Bugs

Bugs causing system hangs or unrecoverable states.

| Bug | Year | Subsystem | Details |
|-----|------|-----------|---------|
| mmap_sem deadlock | 2010-2016 | OOM | [oom.md](../oom.md#case-2-the-mmap_sem-deadlock-2010-2016) |
| Swap-over-NFS deadlock | Historical | swap/NFS | [swapping.md](../swapping.md#case-3-swap-over-nfs-instability) |

### Performance Bugs

Bugs causing severe performance degradation.

| Bug | Year | Subsystem | Details |
|-----|------|-----------|---------|
| Thrashing livelock | 2010+ | reclaim | [oom.md](../oom.md#case-3-the-thrashing-livelock-2010-mitigated-2018) |
| Readahead trap | Ongoing | readahead | [swapping.md](../swapping.md#case-5-the-swap-readahead-trap) |
| khugepaged CPU | Ongoing | thp | [thp.md](thp.md#case-3-khugepaged-cpu-storms) |

---

## Exploitation Techniques

Common techniques used to exploit mm bugs:

### Heap Exploitation (SLUB)

| Technique | Description | Used In |
|-----------|-------------|---------|
| **Heap spray** | Fill heap with controlled objects | CVE-2021-22555 |
| **Cross-cache attack** | Exploit objects across different caches | CVE-2022-29582 |
| **Freelist corruption** | Overwrite SLUB freelist pointers | Many heap overflows |
| **msg_msg abuse** | Use msgsnd() for heap layout control | CVE-2021-22555 |

### Race Conditions

| Technique | Description | Used In |
|-----------|-------------|---------|
| **userfaultfd** | Pause kernel at precise moments | Dirty COW variants |
| **FUSE** | Control page fault timing via filesystem | Various exploits |
| **CPU pinning** | Control which CPU runs exploit code | Race window expansion |

### Side Channels

| Technique | Description | Used In |
|-----------|-------------|---------|
| **Flush+Reload** | Measure cache timing | Meltdown, Spectre |
| **Prime+Probe** | Fill cache, measure evictions | Spectre variants |

---

## Hardening & Mitigations

### Kernel Config Options

| Option | Protects Against | Performance Impact |
|--------|------------------|-------------------|
| `CONFIG_SLAB_FREELIST_RANDOM` | Heap layout prediction | Minimal |
| `CONFIG_SLAB_FREELIST_HARDENED` | Freelist pointer corruption | Minimal |
| `CONFIG_INIT_ON_ALLOC_DEFAULT_ON` | Info leaks via uninitialized memory | Low |
| `CONFIG_INIT_ON_FREE_DEFAULT_ON` | UAF info leaks | Low |
| `CONFIG_PAGE_TABLE_ISOLATION` | Meltdown | 1-5% |
| `CONFIG_RETPOLINE` | Spectre v2 | Variable |

### Runtime Tunables

```bash
# Restrict userfaultfd (reduces race exploit surface)
echo 0 > /proc/sys/vm/unprivileged_userfaultfd

# Restrict kernel pointer exposure
echo 2 > /proc/sys/kernel/kptr_restrict

# Enable KFENCE sampling
echo 100 > /sys/module/kfence/parameters/sample_interval
```

---

## External Resources

### Research & Write-ups

- [Google Project Zero](https://googleprojectzero.blogspot.com/) - Kernel vulnerability research
- [xairy/linux-kernel-exploitation](https://github.com/xairy/linux-kernel-exploitation) - Comprehensive link collection
- [how2heap](https://github.com/shellphish/how2heap) - Heap exploitation techniques

### Disclosure Lists

- [oss-security](https://www.openwall.com/lists/oss-security/) - Public vulnerability disclosures
- [LKML security](https://lore.kernel.org/linux-security-module/) - Kernel security discussions

---

## Contributing

Found a bug not listed here? Contributions welcome:

1. Add to the appropriate subsystem file in `bugs/`
2. Include: CVE (if assigned), fix commit, root cause analysis
3. Link from this index
