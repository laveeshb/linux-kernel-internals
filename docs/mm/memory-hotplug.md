# Memory Hotplug

> Adding and removing physical memory while the system keeps running — the machinery that lets cloud VMs grow or shrink without a reboot

## What Is Memory Hotplug?

Memory hotplug is the kernel's ability to add or remove physical RAM at runtime. The feature has two broad use cases that pull in different directions:

**Physical hotplug** — enterprise servers with hot-swap memory bays can accept new DIMMs while the system is running. A database server can grow from 256 GB to 512 GB without a maintenance window. Similarly, a failed DIMM can be isolated and removed without powering down.

**Virtual machine memory resizing** — cloud hypervisors add and remove memory from guest VMs to reclaim unused pages from idle tenants and give them to busy ones. This is now the dominant use case. Orchestration systems can increase a VM's memory when a workload spikes, or decrease it to reclaim resources. Tools like `virtio-mem` use hotplug as the mechanism underneath.

The kernel provides two symmetric operations:

- **Hot-add** (online): add a new physical memory range and make it available to the allocator.
- **Hot-remove** (offline): drain all pages off a memory range and then physically remove it. Hot-remove is significantly harder than hot-add.

## Memory Sections

The kernel's sparse memory model tracks physical memory in fixed-size **sections**. Each section is the smallest independently online/offline unit.

Section size is architecture-defined via `SECTION_SIZE_BITS`. On x86-64:

```c
/* arch/x86/include/asm/sparsemem.h */
# define SECTION_SIZE_BITS  27  /* matt - 128 is convenient right now */
```

This means sections are `1 << 27` = **128 MB** on x86-64. For comparison, arm64 uses 512 MB sections (`SECTION_SIZE_BITS = 29`).

Each section is represented by `struct mem_section` from `include/linux/mmzone.h`:

```c
struct mem_section {
    /*
     * This is, logically, a pointer to an array of struct pages.
     * However, it is stored with some other magic.
     */
    unsigned long section_mem_map;

    struct mem_section_usage *usage;
#ifdef CONFIG_PAGE_EXTENSION
    /* ... */
#endif
};
```

The `section_mem_map` field encodes both the pointer to the `struct page` array for this section and a set of status flags packed into the low bits:

- `SECTION_MARKED_PRESENT` — physical memory is present here
- `SECTION_HAS_MEM_MAP` — the `struct page` array is valid
- `SECTION_IS_ONLINE` — the section has been onlined to the allocator

At the user-facing level, the kernel groups multiple sections into **memory blocks**. A memory block is the unit exposed in sysfs. `MIN_MEMORY_BLOCK_SIZE` is set to `1 << SECTION_SIZE_BITS`, so on x86-64 the minimum block size is 128 MB. In practice blocks are often larger.

## The Sysfs Interface

Every memory block has a sysfs directory under `/sys/devices/system/memory/`:

```
/sys/devices/system/memory/
├── auto_online_blocks          # Policy for automatic onlining
├── block_size_bytes            # Memory block size in hex bytes
├── memory0/                    # Block 0 (often firmware-reserved)
│   ├── node0                   # NUMA node symlink
│   ├── online_type             # Last online type used
│   ├── phys_index              # Physical block index
│   ├── removable               # Whether block can be removed
│   ├── state                   # offline / online / going-offline
│   └── valid_zones             # Which zones this block can be onlined to
├── memory1/
│   └── state
...
├── memory128/
│   └── state
```

The `state` file is the primary control interface. It accepts:

| Write value | Effect |
|-------------|--------|
| `online` | Online using auto policy (`MMOP_ONLINE`) |
| `online_kernel` | Online to `ZONE_NORMAL` (`MMOP_ONLINE_KERNEL`) |
| `online_movable` | Online to `ZONE_MOVABLE` (`MMOP_ONLINE_MOVABLE`) |
| `offline` | Attempt to offline (may fail) |

```bash
# Check the state of a memory block
cat /sys/devices/system/memory/memory128/state

# Bring it online into ZONE_MOVABLE
echo online_movable > /sys/devices/system/memory/memory128/state

# Offline it (may fail if unmovable pages are present)
echo offline > /sys/devices/system/memory/memory128/state
```

The kernel code that parses these writes lives in `drivers/base/memory.c`:

```c
/* drivers/base/memory.c */
static const char *const online_type_to_str[] = {
    [MMOP_OFFLINE]         = "offline",
    [MMOP_ONLINE]          = "online",
    [MMOP_ONLINE_KERNEL]   = "online_kernel",
    [MMOP_ONLINE_MOVABLE]  = "online_movable",
};
```

## Hot-Add Path

When new memory appears (via firmware/ACPI notification or a `virtio-mem` device), the kernel follows this path:

```
Firmware/ACPI or virtio-mem signals new memory range
        │
        ▼
add_memory(nid, start, size, mhp_flags)    [mm/memory_hotplug.c]
        │
        ▼
add_memory_resource()
        │
        ├── arch_add_memory()              [arch-specific page table setup]
        │         Maps the new range into the kernel's linear map
        │
        ├── create_memory_block_devices()  [drivers/base/memory.c]
        │         Creates /sys/devices/system/memory/memoryN entries
        │
        └── (auto_online_blocks policy)
              │
              ▼
        online_pages(pfn, nr_pages, zone, group)  [mm/memory_hotplug.c]
              │
              ├── move_pfn_range_to_zone()     Associate pages with zone
              ├── memory_notify(MEM_GOING_ONLINE, ...)
              ├── online_pages_range()          Add pages to buddy allocator
              ├── undo_isolate_page_range()     Open the range for allocation
              └── memory_notify(MEM_ONLINE, ...)
```

`add_memory()` takes a NUMA node id, a physical start address, a size in bytes, and a flags bitfield (`mhp_t`). Key flags include:

- `MHP_MERGE_RESOURCE` — merge the new resource entry with adjacent ones in `/proc/iomem`
- `MHP_MEMMAP_ON_MEMORY` — store the `struct page` array (vmemmap) inside the hot-added memory itself, conserving existing memory

`arch_add_memory()` handles the architecture-specific work: building page table entries so the kernel's direct mapping covers the new physical addresses.

`online_pages()` does the memory-model work: it associates the PFN range with the requested zone, fires memory notifiers so drivers and subsystems can react, adds the pages to the buddy allocator via `online_pages_range()`, and then calls `undo_isolate_page_range()` to open the range for normal allocation.

### ZONE_MOVABLE vs ZONE_NORMAL for New Memory

When onlining, you must choose a zone:

**`ZONE_NORMAL` (online_kernel)**: New pages join the normal kernel zone. Kernel data structures may be placed here. This is a one-way door — you cannot offline the section later if the kernel has put unmovable data on it.

**`ZONE_MOVABLE` (online_movable)**: New pages join the movable zone. The kernel guarantees it will never place unmovable allocations here. This is the exit ramp — if you ever need to offline this memory, it is possible because all pages can be migrated away.

!!! tip "Always use `online_movable` for hotplugged memory in VMs"
    If there is any chance you will need to offline (shrink) the VM's memory later, online new sections as `ZONE_MOVABLE`. Onlining as `ZONE_NORMAL` effectively makes the memory permanent because kernel slab, page tables, and other unmovable allocations may land there immediately.

## ZONE_MOVABLE

`ZONE_MOVABLE` exists specifically to enable hot-remove. The contract is strict: **no unmovable kernel allocations ever go here**. Only pages that can be migrated to another location are placed in `ZONE_MOVABLE` — anonymous memory, file-backed pages, and similar movable content.

This zone is not created by default on a normal system. It is enabled by boot parameters:

```bash
# Reserve all but 8GB for ZONE_MOVABLE (8GB stays as kernel-usable zones)
kernelcore=8G

# Alternatively, specify how much should be ZONE_MOVABLE
movablecore=80%
```

`kernelcore=N` sets the amount of memory that must remain in kernel-usable zones; the rest becomes `ZONE_MOVABLE`. `movablecore=N` is the inverse: it specifies how much should be movable.

To inspect the current zone layout:

```bash
# Show all zones including Movable
grep -A5 "Node.*Movable" /proc/zoneinfo

# Compact summary from /proc/meminfo
grep -E "MemTotal|MemFree" /proc/meminfo
```

!!! note "ZONE_MOVABLE and CMA"
    CMA pages (see [CMA](cma.md)) in kernel zones behave similarly to `ZONE_MOVABLE` — they can be migrated. But `ZONE_MOVABLE` is the primary mechanism for ensuring entire memory sections can be reclaimed.

## Hot-Remove Path

Hot-remove is much harder than hot-add. The fundamental challenge: before the kernel can give back a physical memory range, every `struct page` in that range must be free. That means migrating all live pages elsewhere. Pages that cannot be migrated block the offline.

The offline path is:

```
User writes "offline" to sysfs state file
        │
        ▼
memory_block_offline()              [drivers/base/memory.c]
        │
        ▼
offline_pages(pfn, nr_pages, zone, group)  [mm/memory_hotplug.c]
        │
        ├── zone_pcp_disable()          Disable per-CPU page lists
        ├── lru_cache_disable()         Disable LRU caches
        │
        ├── start_isolate_page_range()  [mm/page_isolation.c]
        │       Mark every pageblock MIGRATE_ISOLATE
        │       Prevents new allocations into the range
        │       Returns -EBUSY if any pageblock cannot be isolated
        │
        ├── memory_notify(MEM_GOING_OFFLINE, ...)
        │
        ├── [loop]
        │       scan_movable_pages()    Find pages still present
        │       do_migrate_range()      Migrate them out via migrate_pages()
        │       [repeat until no movable pages remain or failure]
        │
        ├── dissolve_free_hugetlb_folios()   Handle huge pages
        │
        ├── test_pages_isolated()       Verify range is fully free
        │
        ├── __offline_isolated_pages()  Remove pages from buddy allocator
        │       Marks sections SECTION_IS_ONLINE = 0
        │
        ├── undo_isolate_page_range()   On success: not needed
        │   (or on failure: restore MIGRATE_MOVABLE and cancel)
        │
        └── memory_notify(MEM_OFFLINE, ...)
              or memory_notify(MEM_CANCEL_OFFLINE, ...) on failure
```

### Page Isolation

`start_isolate_page_range()` in `mm/page_isolation.c` marks every pageblock in the target range as `MIGRATE_ISOLATE`. Once isolated, the page allocator will not hand out pages from this range to new allocations. This prevents a race where pages are freed from the range only to have new allocations immediately refill it.

If any pageblock cannot be isolated (for example, because it straddles a zone boundary or has a structural constraint), `start_isolate_page_range()` returns `-EBUSY` and the offline fails immediately.

### Page Migration

`do_migrate_range()` calls `migrate_pages()` with `MR_MEMORY_HOTPLUG` as the migration reason. The migration allocates replacement pages elsewhere in the system and moves all content and page table mappings. Pages are classified in `page_is_unmovable()`:

```c
/* mm/page_isolation.c */
bool page_is_unmovable(struct zone *zone, struct page *page,
        enum pb_isolate_mode mode, unsigned long *step)
{
    /* Boot-time allocations and memory holes are PG_reserved and unmovable */
    if (PageReserved(page))
        return true;

    /* All pages in ZONE_MOVABLE are considered movable */
    if (zone_idx(zone) == ZONE_MOVABLE)
        return false;
    ...
}
```

### Failure Cases

The offline can fail for several reasons, and the kernel will report them in dmesg:

| Failure reason | Cause |
|----------------|-------|
| `failure to isolate range` | A pageblock could not be marked MIGRATE_ISOLATE |
| `unmovable page` | A page in the range has no migration method |
| `notifier failure` | A kernel notifier (driver, subsystem) rejected the offline |
| `signal backoff` | A signal arrived during the migration loop |
| `failure to dissolve huge pages` | Hugetlbfs pages could not be freed |
| `memory holes` | The range contains non-RAM gaps |

!!! warning "Unmovable pages are the most common blocker"
    If memory was onlined as `ZONE_NORMAL`, kernel slab caches, page tables, and other unmovable allocations may have been placed there. These cannot be migrated. The offline will spin through the migration loop and eventually fail with `unmovable page`. The only remedy is to online future hotplugged memory as `ZONE_MOVABLE`.

After a failed offline, `undo_isolate_page_range()` and `memory_notify(MEM_CANCEL_OFFLINE, ...)` restore the section to normal use.

### remove_memory

Once all blocks covering a physical range have been offlined, `remove_memory()` can be called to complete the hardware removal:

```c
/* include/linux/memory_hotplug.h (CONFIG_MEMORY_HOTREMOVE) */
extern int remove_memory(u64 start, u64 size);
extern void __remove_memory(u64 start, u64 size);
extern int offline_and_remove_memory(u64 start, u64 size);
```

`remove_memory()` verifies all blocks are offline, then calls `arch_remove_memory()` to tear down the page table mappings for the range, followed by `sparse_remove_section()` to free the `struct page` arrays.

## Memory Onlining Policies

### auto_online_blocks

The `auto_online_blocks` sysfs attribute at `/sys/devices/system/memory/auto_online_blocks` controls what happens when new memory blocks appear — whether they are onlined automatically and into which zone:

```bash
# Check the current policy
cat /sys/devices/system/memory/auto_online_blocks

# Possible values: offline, online, online_kernel, online_movable

# Automatically online new blocks into ZONE_MOVABLE
echo online_movable > /sys/devices/system/memory/auto_online_blocks

# Leave new blocks offline for manual handling
echo offline > /sys/devices/system/memory/auto_online_blocks
```

This attribute maps directly to the kernel's `mhp_get_default_online_type()` / `mhp_set_default_online_type()` pair.

### The online_policy Module Parameter

`memory_hotplug.online_policy` (settable via kernel command line or `/sys/module/memory_hotplug/parameters/online_policy`) controls zone selection when using the plain `online` (auto) mode:

| Policy | Behavior |
|--------|----------|
| `contig-zones` (default) | Keep zones contiguous; online to the zone the adjacent memory block uses |
| `auto-movable` | Online to `ZONE_MOVABLE` when the movable:kernel ratio allows it |

The `auto-movable` policy uses `auto_movable_ratio` (default 301%) as an upper bound on the `ZONE_MOVABLE : kernel zones` ratio. This prevents the system from becoming so MOVABLE-heavy that kernel allocations are starved.

### Recommended Settings for Cloud VMs

For guest VMs that will have memory added and removed by the hypervisor:

```bash
# At boot (in /etc/rc.local or cloud-init):
echo online_movable > /sys/devices/system/memory/auto_online_blocks
```

This ensures every hotplugged section is immediately available to applications and can be removed later without obstruction.

## NUMA and Hotplug

### Adding Memory to an Existing Node

The common case — a new DIMM or VM memory increment belongs to an already-online NUMA node. This is relatively straightforward: `add_memory(nid, ...)` is called with the existing node's id, and `try_online_node()` is a no-op because the node is already online.

### Adding a New NUMA Node

Adding memory to a brand-new NUMA node is more complex. The node's `pg_data_t` structure must be allocated first, and the NUMA topology (distance tables, fallback lists) must be rebuilt. `try_online_node()` handles the first-memory case:

```c
/* mm/memory_hotplug.c */
int try_online_node(int nid)
{
    int ret;
    mem_hotplug_begin();
    ret = __try_online_node(nid, true);
    mem_hotplug_done();
    return ret;
}
```

If CPUs are associated with the new node (CPU hotplug), that adds further coordination requirements — CPUs must be brought online only after their node has memory.

### Removing the Last Memory from a Node

When `offline_pages()` is about to remove the last present pages from a NUMA node, it notifies the system via `node_notify(NODE_REMOVING_LAST_MEMORY, ...)`. On success, `node_clear_state(node, N_MEMORY)` marks the node as memory-less. `kswapd` and `kcompactd` for that node are stopped. The zone lists are rebuilt without the empty node.

## Observing Hotplug Events

### dmesg

The kernel logs memory online/offline events:

```
kernel: [  123.456789] memory: online [mem 0x0000001000000000-0x000000103fffffff]
kernel: [  456.789012] Offlined Pages 32768
```

For a failed offline:

```
kernel: memory offlining [mem 0x0000001000000000-0x000000101fffffff] failed due to unmovable page
```

### udev Events

When memory blocks are created in sysfs, `udev` sees `add` events for devices of subsystem `memory`. A `udev` rule can trigger custom scripts:

```
ACTION=="add", SUBSYSTEM=="memory", ATTR{state}=="offline", \
  RUN+="/usr/local/bin/memory-online.sh $env{DEVPATH}"
```

This is how `systemd` and distribution scripts implement automatic onlining as an alternative to the kernel's built-in `auto_online_blocks`.

### /sys/devices/system/memory/

```bash
# Count total memory blocks
ls /sys/devices/system/memory/ | grep -c memory

# List all offline blocks
for d in /sys/devices/system/memory/memory*/; do
  state=$(cat "$d/state")
  [ "$state" = "offline" ] && echo "$d: $state"
done

# Show which zone each block would be onlined to
for d in /sys/devices/system/memory/memory*/; do
  echo "$d: $(cat $d/valid_zones 2>/dev/null)"
done
```

## The Cloud and VM Use Case

### virtio-mem

`virtio-mem` (introduced in Linux 5.8) is the modern memory balloon device for KVM/QEMU. Unlike the traditional `virtio-balloon`, which inflates by pinning pages away from the guest, `virtio-mem` uses memory hotplug: it adds and removes actual physical address ranges from the guest's view.

The driver (`drivers/virtio/virtio_mem.c`) operates in two modes selected automatically based on alignment:

- **Sub Block Mode (SBM)**: A Linux memory block spans several smaller sub-blocks. Individual sub-blocks within a block can be plugged or unplugged. Memory is added/removed at Linux memory block granularity.
- **Big Block Mode (BBM)**: A Big Block spans one or more Linux memory blocks. Used when the device's block size exceeds the Linux memory block size.

In both modes, `virtio-mem` calls `add_memory()` to plug memory and `offline_and_remove_memory()` to unplug it. The driver tracks which sub-blocks are plugged using bitmaps.

The implication for zone selection: `virtio-mem` relies on userspace or the kernel's `auto_online_blocks` to online the added blocks. Setting `auto_online_blocks=online_movable` is essential for `virtio-mem` to be able to unplug memory, because blocks in `ZONE_MOVABLE` can be offlined.

### Why VMs Prefer ZONE_MOVABLE for All Guest RAM

Some VM configurations (particularly those using the `movable_node` boot option) put all guest memory into `ZONE_MOVABLE`. The rationale:

1. The hypervisor may want to reclaim any guest page, not just hotplugged ones.
2. Guest kernels should not assume their memory is permanently assigned.
3. Live migration moves all guest memory, which requires it to be migratable.

The `movable_node` boot parameter forces an entire NUMA node into `ZONE_MOVABLE`.

### Kubernetes and Memory Hotplug

Some Kubernetes runtimes (notably those using `kata-containers` or `cloud-hypervisor`) resize VM memory to match pod resource limits. When a pod's memory limit is increased, the runtime hot-adds memory to the VM. When the limit is decreased (and the memory balloon approach is used), memory sections are offlined and removed. The `auto_online_blocks=online_movable` setting is a common tuning recommendation in cloud VM images for this reason.

## Key Source Files

| File | Description |
|------|-------------|
| [`mm/memory_hotplug.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memory_hotplug.c) | Core hotplug logic: `add_memory()`, `remove_memory()`, `online_pages()`, `offline_pages()`, `do_migrate_range()` |
| [`include/linux/memory_hotplug.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/memory_hotplug.h) | Public API: `add_memory()`, `online_pages()`, `offline_pages()`, `mhp_t` flags, `struct mhp_params` |
| [`drivers/base/memory.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/base/memory.c) | sysfs interface: `state` attribute, `auto_online_blocks`, `memory_block_online()`, `memory_block_offline()` |
| [`mm/page_isolation.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_isolation.c) | Page isolation: `start_isolate_page_range()`, `undo_isolate_page_range()`, `page_is_unmovable()` |
| [`include/linux/mmzone.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mmzone.h) | `struct mem_section`, `SECTION_SIZE_BITS` reference, `struct mem_section_usage` |
| [`include/linux/memory.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/memory.h) | `struct memory_block`, `struct memory_group`, `enum memory_block_state`, `register_memory_notifier()` |
| [`arch/x86/include/asm/sparsemem.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/sparsemem.h) | x86-64 `SECTION_SIZE_BITS = 27` (128 MB sections) |
| [`drivers/virtio/virtio_mem.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/virtio/virtio_mem.c) | `virtio-mem` driver — uses `add_memory()` / `offline_and_remove_memory()` |
| [`mm/mm_init.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mm_init.c) | `kernelcore=` and `movablecore=` boot parameter parsing |

## Try It Yourself

```bash
# List all memory blocks and their states
ls /sys/devices/system/memory/ | grep memory

# Check current onlining policy
cat /sys/devices/system/memory/auto_online_blocks

# Check memory block size
printf "%d MB\n" $(($(cat /sys/devices/system/memory/block_size_bytes) / 1024 / 1024))

# Find any offline memory blocks
for d in /sys/devices/system/memory/memory*/; do
  state=$(cat "$d/state" 2>/dev/null)
  [ "$state" = "offline" ] && echo "OFFLINE: $d"
done

# Check which zones a memory block can be onlined to
cat /sys/devices/system/memory/memory0/valid_zones

# Check ZONE_MOVABLE size via /proc/zoneinfo
grep -A5 "Node.*Movable" /proc/zoneinfo

# Watch dmesg for hotplug events in real time
dmesg -w | grep -E "memory|hotplug|Offlined|online"

# On a VM with virtio-mem, check if the driver is loaded
lsmod | grep virtio_mem
ls /sys/bus/virtio/drivers/virtio_mem/ 2>/dev/null
```

## Common Issues

### Offline Fails with "unmovable page"

The section contains an unmovable kernel allocation — slab objects, page tables, or a pinned page.

**Diagnosis**:
```bash
dmesg | grep "offlining.*failed"
# Look for the specific failure reason

# Check what zone the block is in
cat /sys/devices/system/memory/memoryN/valid_zones
# If it shows only "Normal", all normal-zone allocations are blocking you
```

**Remedies**:
- If possible, online the block as `ZONE_MOVABLE` instead (requires re-onlining)
- Set `auto_online_blocks=online_movable` before the next hotplug event
- Try the offline repeatedly — memory compaction runs between attempts and may free the range

### Memory Block Not Appearing After Hotplug

The physical device was added but no sysfs entry appeared.

- Check `dmesg` for ACPI or firmware errors
- Verify `CONFIG_MEMORY_HOTPLUG=y` in the running kernel (`zcat /proc/config.gz | grep MEMORY_HOTPLUG`)
- On VMs, check that the hypervisor signal (ACPI notification or `virtio-mem` event) was delivered

### ZONE_MOVABLE Is Empty

`grep -A5 "Node.*Movable" /proc/zoneinfo` shows zero pages.

- `ZONE_MOVABLE` is only populated if `kernelcore=`, `movablecore=`, or `movable_node` is specified at boot, or if memory was onlined via `online_movable`
- Hotplugged memory onlined as `online_movable` will appear here

## History

### SPARSEMEM and the Foundations (v2.6.13, 2005)

Memory hotplug required a new memory model. The classic `FLATMEM` model assumed a contiguous `mem_map` array spanning all physical memory, which breaks when memory appears and disappears at runtime. SPARSEMEM introduced the per-section `struct mem_section` array, making the `struct page` arrays discontiguous and independently allocatable.

### Initial Hotplug Support (v2.6.15, 2006)

Basic memory hot-add support was merged for x86-64 and ia64, providing `add_memory()` and the initial sysfs interface. Hot-remove was not yet supported.

### Memory Hot-Remove (v2.6.24, 2008)

`offline_pages()` and the page migration machinery for hot-remove were added, enabling `ZONE_MOVABLE` to be used as a staging area for removable memory.

### virtio-mem (v5.8, 2020)

**Commit**: [35ee9a3e812b](https://git.kernel.org/linus/35ee9a3e812b)

**Author**: David Hildenbrand (Red Hat)

The `virtio-mem` driver provided a clean interface for hypervisors to add and remove guest memory in fine-grained blocks, replacing the coarser balloon driver approach for cloud use cases.

**LWN coverage**: [virtio-mem: paravirtualized memory hot(un)plug](https://lwn.net/Articles/820428/)

### memmap_on_memory (v5.14, 2021)

The `MHP_MEMMAP_ON_MEMORY` flag and `memory_hotplug.memmap_on_memory` parameter allowed the `struct page` metadata for hotplugged memory to be stored inside the hotplugged memory itself, rather than consuming existing RAM.

## References

- [LWN: Memory hotplug](https://lwn.net/Articles/197855/) — early overview of the hot-remove design
- [LWN: virtio-mem](https://lwn.net/Articles/820428/) — virtio-mem design and use cases
- [Kernel docs: Memory hotplug](https://docs.kernel.org/mm/memory-hotplug.html) — official kernel documentation
- [numa](numa.md) — NUMA topology and how hotplug interacts with node online/offline
- [cma](cma.md) — CMA and `MIGRATE_CMA`, related movable memory machinery
- [compaction](compaction.md) — page migration used by `do_migrate_range()` during offline
- [page-allocator](page-allocator.md) — migrate types and zone layout
