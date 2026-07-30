# The Physical Memory Model

> How the kernel tracks every page of RAM — FLATMEM, SPARSEMEM, and vmemmap — and how `struct page` itself is being dismantled into memory descriptors

The kernel keeps a `struct page` for every physical page frame in the machine, and it needs to get from a **physical frame number (PFN)** to that `struct page` — and back — constantly, in the hottest paths of the allocator. *How it stores that giant array of `struct page`* is what "the memory model" means. It has been rewritten several times, each rewrite forced by physical memory getting messier, and the `struct page` at the center of it is now being taken apart.

This page is about that abstraction: why it exists, the models the kernel has used, and where the whole thing is heading. For where the resulting array actually lives in the kernel address space, see [The Kernel Address Space](kernel-address-space.md); for the `struct page` itself as a data structure, [Life of a page](life-of-page.md).

---

## Why there's a "model" at all

Two facts collide:

1. **`pfn_to_page()` and `page_to_pfn()` must be fast.** They run on every allocation, free, reclaim scan, and page-table walk. Ideally they're a single array index.
2. **Physical memory is not a clean array.** Firmware carves out holes, memory-mapped devices claim windows, NUMA nodes start at aligned multi-terabyte offsets, and [hotplug](memory-hotplug.md) makes RAM appear and vanish at runtime.

A naive "one `struct page` per PFN, indexed by PFN" array is the fast option but wastes a 64-byte `struct page` on every hole — gigabytes of them on a machine with sparse physical layout. The **memory model** is the kernel's answer to "where is the `struct page` array and how do I index it *quickly* without paying for the holes." Each model, per [Documentation/mm/memory-model.rst](https://docs.kernel.org/mm/memory-model.html), simply defines its own `pfn_to_page()` / `page_to_pfn()`.

---

## FLATMEM: one flat array

The simplest model. A single global `mem_map[]` array covers the whole PFN range:

```c
/* the whole model, essentially */
#define __pfn_to_page(pfn)  (mem_map + ((pfn) - ARCH_PFN_OFFSET))
#define __page_to_pfn(page) ((unsigned long)((page) - mem_map) + ARCH_PFN_OFFSET)
```

One subtraction, one index — as fast as it gets. FLATMEM is correct and efficient **when physical memory is essentially contiguous**, which is why it's still the model on many small and embedded systems. Its weakness is exactly the holes: a `struct page` is allocated for every PFN in the range, present or not, so a gap in the physical map is paid for in wasted RAM.

---

## DISCONTIGMEM: per-node arrays (a dead end worth knowing)

The first attempt to handle holes came from NUMA. Big NUMA machines have enormous gaps *between* nodes, so FLATMEM's single array would burn gigabytes on the inter-node void. **DISCONTIGMEM** gave each NUMA node its own `mem_map` (`pg_data_t.node_mem_map`), so only populated nodes cost memory; `pfn_to_page()` first found the owning node, then indexed within it.

It was superseded because it conflated two *different* problems — "which NUMA node" and "which parts of memory are present" — into one mechanism. A single node can itself be sparse, which DISCONTIGMEM handled badly. SPARSEMEM (below) solved holes directly and independently of NUMA, and DISCONTIGMEM became dead weight: its last users (alpha, arc, m68k) were converted away by Linux 5.11, and the model was deleted entirely in 2021 ([LWN: Remove the DISCONTIGMEM memory model](https://lwn.net/Articles/858333/)). It's covered here only because SPARSEMEM's design is a direct response to its shortcomings.

---

## SPARSEMEM: sections

The model on essentially every modern 64-bit system. It divides the physical address space into fixed-size **sections** and gives each *present* section its own independently-allocated `struct page` sub-array:

- A section is `SECTION_SIZE_BITS` wide — **27 bits, i.e. 128 MB, on x86-64**.
- An array (or two-level radix for large machines) of `struct mem_section` records which sections exist and where their `struct page` sub-array lives. See [Memory Hotplug](memory-hotplug.md) for the `mem_section` structure in detail — hotplug is SPARSEMEM's biggest beneficiary, since adding or removing a DIMM is adding or removing sections.

The cost is in the lookup. "Classic" SPARSEMEM's `pfn_to_page()` is no longer a bare index — it extracts the section from the PFN, finds the section's `struct page` base, and indexes within it:

```c
/* classic sparsemem, conceptually */
struct mem_section *ms = __pfn_to_section(pfn);
struct page *base = section_mem_map_addr(ms);
return base + pfn;   /* base is pre-offset so this indexes correctly */
```

That extra indirection on *every* `pfn_to_page()` — a hot path — is the price SPARSEMEM pays to stop wasting `struct page` on holes. It was merged in **2.6.13 (2005)**, originally to make [memory hotplug](memory-hotplug.md) possible.

---

## SPARSEMEM_VMEMMAP: getting O(1) back

The dominant configuration today, and the default on x86-64 and most 64-bit architectures, is a clever move that recovers FLATMEM's single-index speed *without* FLATMEM's wasted memory.

The trick is to spend cheap **virtual** address space: map a virtually-contiguous `vmemmap` array of `struct page`, indexed directly by PFN — but only populate the backing pages for sections that actually exist.

```c
/* include/asm-generic/memory_model.h — CONFIG_SPARSEMEM_VMEMMAP */
#define __pfn_to_page(pfn)  (vmemmap + (pfn))
#define __page_to_pfn(page) ((unsigned long)((page) - vmemmap))
```

`pfn_to_page()` is a single addition again. The holes cost nothing but unmapped virtual address space, which on a 64-bit machine is free. This is the best of both worlds — flat-array speed, sparse-array density — and it's why the `vmemmap` region has a dedicated slot in the [kernel address space](kernel-address-space.md#vmemmap-the-struct-page-array-as-an-address-space-trick) (that page covers where it lives and how it's sized; this one is about why the model exists). It arrived in **2.6.24 (2008)**, and it's also the substrate for `ZONE_DEVICE`, which hands out `struct page`s for device memory by populating vmemmap for a device's address range.

| Model | `struct page` array | `pfn_to_page()` | Wastes memory on holes? | Handles hotplug? |
|-------|--------------------|-----------------|------------------------|------------------|
| FLATMEM | one flat `mem_map[]` | index (fastest) | **yes** | no |
| DISCONTIGMEM *(removed)* | per-NUMA-node arrays | find node, then index | between nodes only | no |
| SPARSEMEM | per-section sub-arrays | section lookup, then index | no | **yes** |
| SPARSEMEM_VMEMMAP | virtual array, sparsely backed | index (fastest) | no | **yes** |

The historical arc — FLATMEM → DISCONTIGMEM → SPARSEMEM → vmemmap — is told well in Mike Rapoport's [Memory: the flat, the discontiguous, and the sparse](https://lwn.net/Articles/789304/).

---

## The other half of the problem: `struct page` itself

The memory model decides *where the array is*. The other cost is *how big each element is* — and `struct page` is where the pressure now sits.

Each `struct page` is **64 bytes**, and there's one for every 4 KB of RAM. That's a fixed **~1.6% of all physical memory** spent just describing physical memory: ~16 GB of `struct page` on a 1 TB machine, before a single byte of it is used for anything.

Worse, `struct page` is a union-of-unions that has accumulated meanings since 1995. The same 64 bytes mean completely different things depending on whether the page is anonymous, file-backed, a slab object, a page-table page, free in the buddy allocator, or device memory — overlapping fields disambiguated only by context. It is cramped and type-unsafe, and it's the reason [folios](folio.md) exist: folios were step one, giving file and anonymous memory a distinct, honestly-typed handle instead of a bare `struct page`.

---

## Where it's going: memory descriptors (memdesc)

The long-term goal, driven by Matthew Wilcox out of the folio work, is to dismantle `struct page` entirely. In its place: an **8-byte "memory descriptor" (memdesc)** per page — a typed pointer whose low bits encode *what kind* of page this is and whose remaining bits point to a type-specific structure (a folio, a slab, a buddy record, a page-table descriptor…).

The transition is well underway rather than theoretical:

- Type-specific descriptors are being **carved out of `struct page` one at a time** — `struct slab` and `struct ptdesc` (page-table pages) and netmem descriptors have already been separated, each overlaying `struct page` during the migration.
- The hard part is the **"long tail"**: kernel code all over the tree reaches into arbitrary `struct page` fields, and every such site has to be converted before the union can actually shrink.
- The payoff: `struct page`'s memory tax drops from ~1.6% of RAM toward a fraction of that, the type confusion goes away, and memory management gets more flexible.

It's a distant end state, but a concrete one. Jonathan Corbet's [Separating memory descriptors from struct page](https://lwn.net/Articles/1073425/) is the current-state snapshot; [The proper time to split struct page](https://lwn.net/Articles/937839/) and [Fleshing out memory descriptors](https://lwn.net/Articles/974937/) cover the design and the debate.

---

## Observing the model

```bash
# Which memory model is this kernel built with?
zcat /proc/config.gz 2>/dev/null | grep -E "CONFIG_(FLATMEM|SPARSEMEM|SPARSEMEM_VMEMMAP)="
# or, on a running distro kernel:
grep -E "FLATMEM|SPARSEMEM" /boot/config-$(uname -r)

# The struct page tax — how much RAM is spent describing RAM.
# Rough estimate: MemTotal / 4096 * 64 bytes ≈ 1.6% of RAM.
grep MemTotal /proc/meminfo
# On 6.11+, per-page metadata is accounted directly:
grep -i memmap /proc/vmstat

# Section size (SECTION_SIZE_BITS) is a compile-time arch constant;
# on x86-64 it is 27 (128 MB sections).

# Watch pfn_to_page-heavy work in a kernel profile — with vmemmap it's
# a bare addition, so it rarely shows up (that's the point):
sudo perf top -e cycles --sort symbol | grep -iE "pfn_to|page_to_pfn"
```

---

## Common issues

**"Why is ~1.5–2% of my RAM just… gone at boot?"** That's the `struct page` array (plus other per-page metadata). It scales with total RAM, not usage, and it's the tax the memory model pays. The memdesc work above is the long-term fix.

**Huge machines and section overhead.** On systems with enormous but sparse physical maps, the choice of `SECTION_SIZE_BITS` trades granularity (smaller sections waste less on holes) against the size of the section arrays. This is an arch/config concern, rarely tuned by hand.

**`ZONE_DEVICE` / persistent memory needs `struct page`s.** Device and pmem ranges that want to participate in the normal mm machinery (DAX, `get_user_pages` on pmem) must have `struct page`s, which means populating vmemmap for the device range — sometimes storing that metadata in the device memory itself (`altmap`). This only works under SPARSEMEM_VMEMMAP.

---

## Version notes

| Change | Linux version | Why it matters here |
|--------|--------------|---------------------|
| FLATMEM | always | The original single-array model |
| SPARSEMEM | 2.6.13 (2005) | Per-section arrays; made hotplug possible |
| SPARSEMEM_VMEMMAP | 2.6.24 (2008) | O(1) `pfn_to_page()` with no waste on holes; today's default |
| DISCONTIGMEM removed | 2021 (last users gone by 5.11) | The NUMA-era model retired for good |
| Folios | 5.16+ | First honestly-typed replacement for bare `struct page` |
| Memory descriptors (`struct slab`, `ptdesc`, …) | ongoing | `struct page` being dismantled toward an 8-byte typed descriptor |

---

## Further reading

### Kernel source & documentation

- [Documentation/mm/memory-model.rst](https://docs.kernel.org/mm/memory-model.html) — the authoritative description of FLATMEM and SPARSEMEM, and the `pfn_to_page()` definitions
- [include/asm-generic/memory_model.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/asm-generic/memory_model.h) — the actual `pfn_to_page()`/`page_to_pfn()` macros for each model
- [include/linux/mmzone.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mmzone.h) — `struct mem_section` and the section machinery

### Related pages

- [The Kernel Address Space](kernel-address-space.md) — where the `vmemmap` array physically lives, and how it's sized
- [Memory Hotplug](memory-hotplug.md) — SPARSEMEM sections in action: adding and removing memory at runtime
- [Life of a page](life-of-page.md) — the `struct page` this whole model is an array of
- [Folio Abstraction](folio.md) — the first step of the `struct page` → memdesc transition

### LWN articles

- [Memory: the flat, the discontiguous, and the sparse](https://lwn.net/Articles/789304/) — the history of the memory models
- [Separating memory descriptors from struct page](https://lwn.net/Articles/1073425/) — the current state of the memdesc transition
- [The proper time to split struct page](https://lwn.net/Articles/937839/) — the design debate behind memdesc
- [Fleshing out memory descriptors](https://lwn.net/Articles/974937/) — how the 8-byte typed descriptor is meant to work
