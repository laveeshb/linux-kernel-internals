# What happens during swapping

> The journey of a page from memory to disk and back

## What is swapping?

When memory runs low, the kernel can move anonymous pages (heap, stack, private mappings) to a swap device - either a disk partition or a swap file. This frees physical memory for other uses while preserving the page's contents.

```mermaid
flowchart LR
    subgraph SwapOut["Swap Out (Memory → Disk)"]
        direction LR
        subgraph PM1["Process Memory"]
            AP["Anonymous Page"]
        end
        subgraph SS1["Swap Space (disk)"]
            SL1["Swap slot (copy)"]
        end
        AP -->|write| SL1
        PM1 -.->|Page freed!| PM1
    end
```

```mermaid
flowchart RL
    subgraph SwapIn["Swap In (Disk → Memory)"]
        direction RL
        subgraph SS2["Swap Space (disk)"]
            SL2["Swap slot"]
        end
        subgraph PM2["Process Memory"]
            NP["New Page (restored)"]
        end
        SL2 -->|read| NP
    end
```

Unlike file pages (which can be re-read from their backing file), anonymous pages have nowhere to go except swap space.

## Why this page was chosen

The kernel doesn't randomly pick pages to swap. It uses the [LRU (Least Recently Used)](reclaim.md) lists to find cold pages - pages that haven't been accessed recently.

### The selection process

```mermaid
flowchart TB
    subgraph PageReclaimScanning["Page Reclaim Scanning"]
        ActiveLRU["<b>Active Anonymous LRU</b><br/>(hot pages - recently used)<br/><i>Not scanned first - these pages are in use</i>"]
        InactiveLRU["<b>Inactive Anonymous LRU</b><br/>(cold pages - candidates for swap)<br/><i>Scanned during reclaim</i>"]
        Selection["<b>Selection Criteria:</b><br/>- Not recently accessed (PG_referenced clear)<br/>- Not locked (PG_locked clear)<br/>- Not being written back already<br/>- Can be unmapped from all page tables"]

        ActiveLRU -->|"demote (if not recently accessed)"| InactiveLRU
        InactiveLRU --> Selection
    end
```

### The referenced flag check

Pages get a "second chance" via the referenced flag:

```mermaid
flowchart TB
    subgraph ReferencedFlagCheck["Page on Inactive LRU"]
        Scan["Reclaim scan finds page"]
        Check{"PG_referenced<br/>set?"}
        Accessed["Page was accessed since last scan:<br/>- Clear PG_referenced<br/>- Rotate to end of list (give it more time)"]
        Cold["Page is truly cold:<br/>- Select for swap out"]

        Scan --> Check
        Check -->|Yes| Accessed
        Check -->|No| Cold
    end
```

This prevents swapping out pages that are still being used occasionally.

## Swap space organization

Linux supports two types of swap:

| Type | Device | Characteristics |
|------|--------|-----------------|
| Swap partition | `/dev/sda2` | Dedicated, fixed size |
| Swap file | `/swapfile` | Flexible, can resize, easier to manage |

On modern kernels (2.6+), the kernel [maps swap file blocks to disk sectors at swapon time](https://lwn.net/Articles/2668/) and performs [direct block I/O, bypassing all filesystem code](https://lkml.org/lkml/2005/7/7/326). Performance between partition and file swap is effectively identical for non-fragmented files on non-COW filesystems (ext4, XFS). On SSDs, even fragmented swap files show negligible overhead since seek penalties don't apply.

### Swap area structure

```c
// From include/linux/swap.h
struct swap_info_struct {
    unsigned long flags;        // SWP_USED, SWP_WRITEOK, etc.
    signed char prio;           // Priority (higher = used first)
    struct file *swap_file;     // The swap file/device
    struct block_device *bdev;  // Block device (if partition)
    unsigned long *swap_map;    // Usage count per slot
    unsigned long lowest_bit;   // Optimization: first free slot hint
    unsigned long highest_bit;  // Optimization: last used slot
    unsigned int pages;         // Total slots in this area
    unsigned int inuse_pages;   // Currently used slots
    // ...
};
```

### Swap slots

Swap space is divided into page-sized slots:

```mermaid
flowchart TB
    subgraph SwapArea["Swap Area (e.g., 1GB)"]
        direction LR
        subgraph Slots["Slot Numbers"]
            S0["0<br/>used"]
            S1["1<br/>free"]
            S2["2<br/>used"]
            S3["3<br/>free"]
            S4["4<br/>free"]
            S5["5<br/>used"]
            S6["6<br/>used"]
            S7["7<br/>free"]
            SDOTS["..."]
            SN["N-1<br/>free"]
        end
    end

    subgraph SwapMap["swap_map[] tracks usage count for each slot"]
        M0["0: count=2 (shared by 2 processes after fork)"]
        M1["1: count=0 (free)"]
        M2["2: count=1 (one owner)"]
        M3["..."]
    end
```

### Viewing swap status

```bash
# View swap areas
cat /proc/swaps
# Filename          Type        Size      Used    Priority
# /dev/nvme0n1p3    partition   8388604   12345   -2

# Detailed swap info
swapon --show

# System-wide swap usage
free -h
```

## Stage 1: Swap slot allocation

When the kernel decides to swap out a page, it first allocates a slot:

```c
// mm/swap_slots.c / mm/swapfile.c (simplified)
swp_entry_t folio_alloc_swap(struct folio *folio)
{
    struct swap_info_struct *si;
    swp_entry_t entry;

    // Find a swap area with free slots
    // Higher priority areas are checked first
    si = swap_info[...];  // Based on priority

    // Allocate a slot
    offset = scan_swap_map_slots(si, ...);

    // Create swap entry (type + offset encoded)
    entry = swp_entry(si->type, offset);

    return entry;
}
```

### Swap entry encoding

A swap entry packs the swap area type and offset into a single value:

```mermaid
flowchart LR
    subgraph SwapEntry["Swap Entry (64-bit)"]
        direction TB
        B0["Bits 0: Present = 0<br/>(not a valid page mapping)"]
        B1["Bits 1-5: Swap type<br/>(which swap area, 0-31)"]
        B2["Bits 6-57: Swap offset<br/>(slot number within the area)"]
        B3["Bits 58-63: Flags and reserved"]
    end
```

This entry will replace the page table entry (PTE) after the page is written out.

## Stage 2: Writing to swap

Once a slot is allocated, the page content is written to the swap device:

```c
// mm/vmscan.c shrink_folio_list() (simplified)
static unsigned int shrink_folio_list(struct list_head *folio_list, ...)
{
    // For each folio...

    // 1. Unmap from all page tables first
    //    (so no one can access while we're writing)
    try_to_unmap(folio, TTU_BATCH_FLUSH);

    // 2. If anonymous and we can swap...
    if (folio_test_anon(folio)) {
        if (!add_to_swap(folio))
            goto activate;  // Can't swap, keep in memory

        // 3. Write page to swap device
        pageout(folio, mapping);
    }
}
```

### The add_to_swap() function

```c
// mm/swap_state.c
bool add_to_swap(struct folio *folio)
{
    swp_entry_t entry;

    // 1. Get a swap slot
    entry = folio_alloc_swap(folio);
    if (!entry.val)
        return false;  // No swap space available

    // 2. Set up folio for swap
    folio_set_swapcache(folio);
    folio->swap = entry;

    // 3. Add to swap cache (so others can find it during I/O)
    __folio_set_swap_entry(folio, entry);
    xa_store(&swap_address_space->i_pages, ...);

    return true;
}
```

### Writing to disk

```c
// Simplified I/O path
static int pageout(struct folio *folio, struct address_space *mapping)
{
    // Submit write I/O to swap device
    // This is asynchronous - we don't wait here

    struct writeback_control wbc = {
        .sync_mode = WB_SYNC_NONE,  // Don't wait
    };

    return mapping->a_ops->writepage(&folio->page, &wbc);
}
```

The actual I/O goes through the block layer:

```mermaid
flowchart TB
    subgraph PageWritePath["Page Write Path"]
        pageout["pageout()"]
        swap_writepage["swap_writepage()"]
        __swap_writepage["__swap_writepage()"]
        submit_bio["submit_bio()"]
        block["Block layer"]
        driver["Device driver"]
        disk["Disk"]

        pageout --> swap_writepage
        swap_writepage --> __swap_writepage
        __swap_writepage --> submit_bio
        submit_bio --> block
        block --> driver
        driver --> disk
    end
```

## Stage 3: Page table update

After the write completes, the PTE is updated to contain the swap entry instead of a page mapping:

```mermaid
flowchart LR
    subgraph Before["Before swap out"]
        direction LR
        PTE1["<b>Page Table Entry (PTE)</b><br/>Present=1<br/>PFN=0x12345"]
        PP["<b>Physical Page</b><br/>Frame 0x12345<br/>[page data]"]
        PTE1 --> PP
    end
```

```mermaid
flowchart LR
    subgraph After["After swap out"]
        direction LR
        SE["<b>Swap Entry</b><br/>Present=0<br/>Type=0<br/>Offset=0x789"]
        SD["<b>Swap Device</b><br/>Slot 0x789<br/>[page data]"]
        SE --> SD
    end
    Freed["Physical page returned to buddy allocator!"]
```

### The swap cache

During I/O, the page stays in the **swap cache** - an address space that allows finding in-flight pages:

```mermaid
flowchart LR
    subgraph SwapCachePurpose["Swap Cache Purpose: While page is being written to swap"]
        ProcessA["Process A"]
        SwapCache["Swap Cache<br/>(finds it!)"]
        Page["Page"]

        ProcessA -->|tries to access| SwapCache
        SwapCache --> Page
    end

    Note["Without swap cache, Process A would have to wait for write<br/>to complete, then read it back immediately (wasteful!)"]
```

After I/O completes successfully:
- Page is removed from swap cache
- Physical page is freed
- Only the swap slot remains with the data

## Stage 4: Process accesses swapped page

Later, when a process accesses a swapped-out address, a page fault brings it back.

### The fault handler detects a swap entry

```c
// arch/x86/mm/fault.c → mm/memory.c
static vm_fault_t handle_pte_fault(struct vm_fault *vmf)
{
    pte_t entry = vmf->orig_pte;

    if (!pte_present(entry)) {
        if (pte_none(entry))
            return do_anonymous_page(vmf);  // New page

        // PTE has swap entry
        return do_swap_page(vmf);  // ← Our path!
    }

    // ... handle other cases
}
```

### do_swap_page() brings the page back

```c
// mm/memory.c (simplified)
vm_fault_t do_swap_page(struct vm_fault *vmf)
{
    swp_entry_t entry = pte_to_swp_entry(vmf->orig_pte);
    struct folio *folio;

    // 1. Check swap cache first (maybe another thread faulted already)
    folio = swap_cache_get_folio(entry, ...);

    if (!folio) {
        // 2. Not in cache - need to read from swap
        folio = swapin_readahead(entry, ...);
    }

    // 3. Wait for page to be ready
    folio_lock(folio);

    // 4. Verify swap entry still valid (race check)
    // ...

    // 5. Update page table: swap entry → page mapping
    pte = mk_pte(&folio->page, vmf->vma->vm_page_prot);
    if (vmf->flags & FAULT_FLAG_WRITE)
        pte = pte_mkwrite(pte_mkdirty(pte), vmf->vma);

    set_pte_at(vmf->vma->vm_mm, vmf->address, vmf->pte, pte);

    // 6. Update LRU
    folio_add_lru(folio);

    // 7. Free swap slot (if we're the last user)
    swap_free(entry);

    return 0;
}
```

### Swap-in readahead

Like file readahead, the kernel predicts you might access nearby swapped pages:

```c
// mm/swap_state.c
struct folio *swapin_readahead(swp_entry_t entry, gfp_t gfp_mask,
                                struct vm_fault *vmf)
{
    struct page *page;

    // Read the requested page
    page = read_swap_cache_async(entry, ...);

    // Also read nearby pages (readahead)
    if (should_readahead(...)) {
        for (offset = -readahead_win; offset <= readahead_win; offset++) {
            swp_entry_t ra_entry = swp_entry(type, entry_offset + offset);
            read_swap_cache_async(ra_entry, ...);
        }
    }

    return page_folio(page);
}
```

## Stage 5: Swap slot freed

After successful swap-in, the swap slot can be freed:

```c
// mm/swapfile.c
void swap_free(swp_entry_t entry)
{
    struct swap_info_struct *si = swap_info[swp_type(entry)];

    // Decrement usage count
    // (might be >1 if COW shared the slot)
    count = swap_map[swp_offset(entry)]--;

    if (count == 0) {
        // Slot is now free for reuse
        si->inuse_pages--;
    }
}
```

### Swap slots and COW

When processes share a swapped page (after fork + swap):

```mermaid
flowchart TB
    subgraph SharedSlot["Parent and Child share swap slot"]
        SwapSlot["<b>Swap slot 0x789</b><br/>swap_map[0x789] = 2 (two users)<br/>Contents: page data"]
        ParentPTE["Parent's PTE: swap entry: slot 0x789"]
        ChildPTE["Child's PTE: swap entry: slot 0x789"]

        ParentPTE --> SwapSlot
        ChildPTE --> SwapSlot
    end

    subgraph ParentSwapIn["When parent swaps in"]
        P1["Reads from slot 0x789"]
        P2["swap_map[0x789] = 1 (still used by child)"]
        P3["Parent's PTE → physical page"]
        P4["Slot NOT freed yet"]
        P1 --> P2 --> P3 --> P4
    end

    subgraph ChildSwapIn["When child swaps in"]
        C1["Reads from slot 0x789"]
        C2["swap_map[0x789] = 0"]
        C3["Slot is now free"]
        C1 --> C2 --> C3
    end

    SharedSlot --> ParentSwapIn --> ChildSwapIn
```

## The complete swap cycle

Putting it all together:

```mermaid
flowchart TB
    subgraph SwapOutPhase["Swap Out Phase"]
        Step1["<b>1. Memory Pressure</b><br/>kswapd wakes or direct reclaim starts"]
        Step2["<b>2. Page Selection</b> (mm/vmscan.c)<br/>Scan inactive anonymous LRU<br/>Find cold page without PG_referenced"]
        Step3["<b>3. Unmap Page</b><br/>Remove from all page tables via rmap<br/>Page now inaccessible to processes"]
        Step4["<b>4. Allocate Swap Slot</b><br/>folio_alloc_swap() finds free slot<br/>Add page to swap cache"]
        Step5["<b>5. Write to Swap</b><br/>submit_bio() queues I/O<br/>Async write to swap device"]
        Step6["<b>6. Complete Swap Out</b><br/>PTEs now contain swap entries<br/>Physical page freed to buddy<br/>Page removed from swap cache"]

        Step1 --> Step2
        Step2 --> Step3
        Step3 --> Step4
        Step4 --> Step5
        Step5 --> Step6
    end

    TimePasses["--- Time passes ---"]

    subgraph SwapInPhase["Swap In Phase"]
        Step7["<b>7. Process Accesses Address</b><br/>Page fault (PTE not present)<br/>do_swap_page() handles it"]
        Step8["<b>8. Swap In</b><br/>Allocate new physical page<br/>Read from swap device<br/>Add to swap cache during I/O"]
        Step9["<b>9. Restore Mapping</b><br/>Update PTE: swap entry → page mapping<br/>Add page to active LRU"]
        Step10["<b>10. Free Swap Slot</b><br/>swap_free() decrements count<br/>Slot available for reuse (if count=0)"]

        Step7 --> Step8
        Step8 --> Step9
        Step9 --> Step10
    end

    Step6 --> TimePasses
    TimePasses --> Step7
```

## Swap tunables

### Swappiness

Controls how aggressively the kernel swaps:

```bash
# View current value
cat /proc/sys/vm/swappiness
# Default: 60

# Reduce swapping (prefer reclaiming file cache)
sysctl vm.swappiness=10

# Avoid swapping almost entirely
sysctl vm.swappiness=1
```

| Value | Effect |
|-------|--------|
| 0 | Swap only to avoid OOM |
| 1-30 | Prefer file cache reclaim |
| 60 | Default balance |
| 100 | Aggressive swapping |

### Swap priority

Multiple swap areas can have different priorities:

```bash
# Higher priority = used first
swapon -p 10 /dev/fast_ssd     # Priority 10 (used first)
swapon -p 5 /dev/slow_hdd      # Priority 5 (used when fast is full)

# Same priority = round-robin
swapon -p 10 /dev/ssd1
swapon -p 10 /dev/ssd2         # Striped across both
```

### VFS cache pressure

Affects the balance between reclaiming file cache vs swapping:

```bash
cat /proc/sys/vm/vfs_cache_pressure
# Default: 100

# Lower = keep file caches longer (swap more)
# Higher = drop file caches more readily (swap less)
```

## Swap performance considerations

### SSD vs HDD

| Metric | HDD | SSD |
|--------|-----|-----|
| Random read | ~10ms | ~0.1ms |
| Sequential read | ~100MB/s | ~500-3000MB/s |
| Write endurance | Unlimited | Limited (but usually fine) |

SSDs dramatically improve swap performance, making swapping much less painful.

### Swap thrashing

When the working set exceeds RAM, the system constantly swaps pages in and out:

```mermaid
flowchart LR
    subgraph Thrashing["Thrashing"]
        direction TB
        TimeArrow["Time →"]

        subgraph PageA["Page A"]
            A1["in memory"] --> A2["swap out"] --> A3["swap in"] --> A4["swap out"] --> A5["..."]
        end

        subgraph PageB["Page B"]
            B1["swap in"] --> B2["swap out"] --> B3["swap in"] --> B4["swap out"] --> B5["..."]
        end

        subgraph PageC["Page C"]
            C1["swap out"] --> C2["swap in"] --> C3["swap out"] --> C4["swap in"] --> C5["..."]
        end

        Result["System spends more time swapping than doing useful work!"]
    end
```

**Signs of thrashing**:
- High swap I/O (`vmstat` si/so columns)
- High CPU time in kernel (`top` shows high sy/wa)
- Application responsiveness drops drastically

**Solutions**:
- Add more RAM
- Reduce memory usage
- Use zswap or zram for compression

### zswap and zram

**zswap**: Compresses pages before writing to swap device:

```mermaid
flowchart LR
    subgraph NormalSwap["Normal swap"]
        NS_Page["Page"] --> NS_Device["Swap device"]
    end
```

```mermaid
flowchart LR
    subgraph WithZswap["With zswap"]
        ZS_Page["Page"] --> ZS_Compress["Compress"] --> ZS_RAM["RAM pool"] -.->|if needed| ZS_Device["Swap device"]
    end
```

**zram**: Creates a compressed RAM disk as swap:

```bash
# Enable zram
modprobe zram
echo lz4 > /sys/block/zram0/comp_algorithm
echo 2G > /sys/block/zram0/disksize
mkswap /dev/zram0
swapon -p 100 /dev/zram0  # High priority
```

## Try it yourself

### Monitor swap activity

```bash
# Real-time swap I/O
vmstat 1
# si = swap in (KB/s)
# so = swap out (KB/s)

# Detailed swap stats
cat /proc/vmstat | grep -E "pswp|swap"
# pswpin  - pages swapped in
# pswpout - pages swapped out
```

### Watch a swap operation

```bash
# Terminal 1: Monitor swap
watch -n 1 'free -h; echo; cat /proc/swaps'

# Terminal 2: Force swapping
stress --vm 1 --vm-bytes 90% --vm-keep &

# Terminal 3: Watch specific process swap usage
for pid in $(pgrep stress); do
    echo "PID $pid: $(grep VmSwap /proc/$pid/status)"
done
```

### Trace swap events

```bash
# Enable swap tracing
echo 1 > /sys/kernel/debug/tracing/events/vmscan/mm_vmscan_writepage/enable
echo 1 > /sys/kernel/debug/tracing/events/swap/swap_readpage/enable

# Watch events
cat /sys/kernel/debug/tracing/trace_pipe
```

### Examine swap contents

```bash
# Per-process swap usage
for pid in /proc/[0-9]*; do
    comm=$(cat $pid/comm 2>/dev/null)
    swap=$(grep VmSwap $pid/status 2>/dev/null | awk '{print $2}')
    [ "$swap" != "0" ] && [ -n "$swap" ] && echo "$comm: ${swap}kB"
done | sort -t: -k2 -n -r | head -10
```

### Test swap in/out explicitly

```bash
# Allocate memory and force swap
cat > /tmp/swap_test.c << 'EOF'
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main() {
    size_t size = 200 * 1024 * 1024;  // 200MB
    char *buf = malloc(size);

    // Touch all pages
    memset(buf, 'A', size);
    printf("Allocated and touched %zuMB\n", size / 1024 / 1024);
    printf("Press Enter to trigger memory pressure...\n");
    getchar();

    // Let system swap it out
    printf("Sleeping - watch with vmstat...\n");
    sleep(30);

    // Access again (swap in)
    printf("Accessing memory (swap in)...\n");
    volatile char c = buf[0];  // Force access

    printf("Done. Press Enter to exit.\n");
    getchar();
    return 0;
}
EOF
gcc -o /tmp/swap_test /tmp/swap_test.c
/tmp/swap_test
```

## Key source files

| File | What It Does |
|------|--------------|
| [`mm/swapfile.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/swapfile.c) | Swap area management, slot allocation |
| [`mm/swap_state.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/swap_state.c) | Swap cache operations |
| [`mm/page_io.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_io.c) | Swap I/O operations |
| [`mm/memory.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memory.c) | do_swap_page() - swap-in handling |
| [`mm/vmscan.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vmscan.c) | Page reclaim, swap-out path |
| [`include/linux/swap.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/swap.h) | Swap data structures |

## History

### Swap evolution

**Early Linux**: Basic swap support from the beginning.

**v2.6**: Swap clustering for better sequential I/O.

**v3.11 (2013)**: zswap - compressed swap cache.

**Commit**: [2b2811178e85](https://git.kernel.org/linus/2b2811178e85) ("zswap: add to mm/") | [LKML](https://lore.kernel.org/lkml/1368636374-13292-1-git-send-email-sjenning@linux.vnet.ibm.com/)

**Author**: Seth Jennings (IBM)

In the swap-out flow (Stage 2-3 above), zswap intercepts pages before they hit the swap device. It compresses them and stores them in a RAM pool. Only when the pool fills up do pages get written to the actual swap device. This dramatically reduces swap I/O for compressible workloads.

**v3.14 (2014)**: zram moved from staging to mainline.

**Commit**: [cd67e10ac699](https://git.kernel.org/linus/cd67e10ac699) ("zram: promote zram from staging")

**Author**: Minchan Kim (LG Electronics)

Unlike zswap (which caches before a real swap device), zram *is* the swap device - a compressed RAM disk. The entire swap flow above happens, but the "disk" is actually compressed memory. This is popular on memory-constrained systems like Android phones and Chromebooks.

**v5.8 (2020)**: Swap slot allocation improvements for SSD performance.

**Commit**: [490705888107](https://git.kernel.org/linus/490705888107) ("swap: reduce lock contention on swap cache from swap slots allocation")

**Author**: Huang Ying (Intel)

In Stage 1 (slot allocation) above, the kernel now uses a swap slot cache to batch slot allocations, reducing contention on SSDs where swap I/O is fast enough that allocation overhead becomes significant.

### Modern swap improvements

The swap subsystem continues to evolve for better SSD utilization and reduced latency:

- Better slot allocation algorithms
- Improved swap readahead
- Integration with memory cgroups for per-cgroup swap accounting

## Notorious bugs and edge cases

Swap involves complex interactions between page tables, swap slots, and caching. Race conditions in this code can cause data corruption or security vulnerabilities.

---

### Case 1: The swap slot ABA problem (CVE-2024-26759)

#### What happened

In early 2024, Huang Ying (Intel) discovered a race condition in the "skip swapcache" optimization path that could cause data corruption.

#### The bug

The [LKML discussion](https://lkml.org/lkml/2024/2/16/426) explains the ABA problem:

When `SWP_SYNCHRONOUS_IO` is enabled (common on fast NVMe drives), the kernel skips the swap cache for performance. But this creates a race:

1. **Thread T0**: Starts swapping in entry X, allocates page A
2. **Thread T1**: Also starts swapping in entry X (same entry), allocates page B
3. **Thread T1**: Finishes first, installs page B, frees entry X via `swap_free()`
4. **Thread T1**: Later swaps out a *modified* page, **reuses** entry X
5. **Thread T0**: Finishes, sees PTE unchanged (still points to entry X)
6. **Thread T0**: Installs **stale** page A into PTE

```mermaid
sequenceDiagram
    participant T0 as Thread 0
    participant T1 as Thread 1
    participant Swap as Swap Slot X

    T0->>Swap: Read entry X → Page A
    T1->>Swap: Read entry X → Page B
    T1->>Swap: Installs B, frees X
    Note over Swap: Slot X is FREE
    T1->>Swap: Swap out modified page → reuses X
    Note over Swap: Slot X has NEW data
    T0->>T0: PTE still says "swap entry X"
    T0->>T0: Installs STALE page A
    Note over T0: DATA CORRUPTION!
```

The PTE value hasn't changed (still `swp_entry_t` for slot X), so the `pte_same()` check passes, but the data is completely different.

#### Real-world implications

This is **silent data corruption** - applications would see old data instead of current data, with no errors reported. Databases, filesystems, or any application relying on data consistency could be affected.

#### The fix

**Commit**: [13ddaf26be32](https://git.kernel.org/linus/13ddaf26be32) ("mm/swap: fix race when skipping swapcache")

**Author**: Kairui Song

The fix adds proper locking and verification to prevent the ABA scenario when bypassing the swap cache.

Fixes commit: [0bcac06f27d7](https://git.kernel.org/linus/0bcac06f27d7) ("mm, swap: skip swapcache for swapin of synchronous device")

---

### Case 2: ZSWAP race conditions

#### What happened

The zswap compressed swap cache introduced concurrency challenges. [LKML bug reports](https://linux.kernel.narkive.com/0AHtSnDW/bug-report-zswap-theoretical-race-condition-issues) documented theoretical races.

#### The bug

When a duplicate store and reclaim happen concurrently:

1. Entry X with offset A exists in zswap
2. **Thread 0**: Starts reclaiming entry X
3. **Thread 1**: Stores a *new* page at offset A, allocates new entry Y
4. **Thread 0**: Calls `zswap_get_swap_cache_page()` but gets the old data

The swap cache now contains old data for offset A instead of the new data.

#### Real-world implications

If `do_swap_page()` retrieves the page from swap cache, it returns stale data - another silent corruption scenario.

#### Mitigations

Zswap has undergone multiple locking improvements to address these races. The interactions between:
- Zswap entry lifecycle
- Swap cache operations
- Page writeback

...all need careful synchronization.

---

### Case 3: Swap-over-NFS instability

#### What happened

Swapping to NFS has historically been problematic. When the system is under memory pressure and needs to swap, it also needs memory for network I/O.

#### The bug

The classic deadlock scenario:

1. System under memory pressure
2. Kernel tries to swap out pages to NFS
3. NFS needs to allocate memory for network packets
4. Memory allocation triggers more reclaim
5. Deadlock: can't free memory without network, can't do network without memory

#### Mitigations

**`PF_MEMALLOC` and memory reserves**: The kernel reserves memory for critical I/O paths. Processes doing swap I/O can dip into reserves.

**Swap-over-NBD patches**: Commit [c32a8d1eddb0](https://git.kernel.org/linus/c32a8d1eddb0) and related work improved network swap reliability.

**Practical advice**: Don't swap to NFS in production. Use local swap or zram.

---

### Case 4: Swap partition vs. swap file races

#### What happened

Swap files introduce additional complexity compared to swap partitions because the filesystem layer is involved.

#### The bug

With swap files, `swap_writepage()` must go through the filesystem. This can race with:
- Filesystem operations on the same device
- Filesystem metadata updates
- Journal commits

#### Historical issues

- **XFS + swap**: Early XFS had issues with swap files due to delayed allocation
- **Btrfs + swap**: Only supported swap files from kernel 5.0 due to COW complexity
- **F2FS**: Added swap file support in kernel 5.10

#### Modern status

Most filesystems now support swap files correctly, but the added complexity means more potential for bugs compared to raw partitions.

---

### Case 5: The swap readahead trap

#### What happened

Swap readahead (reading more than one page on swap-in) is an optimization that can backfire.

#### The problem

Unlike file readahead (where sequential access is common), swap access patterns are often random - especially on systems with many processes. Aggressive swap readahead:

1. Reads pages that won't be used
2. Evicts useful pages from memory
3. Increases swap I/O
4. Makes memory pressure worse

#### The bug class

Readahead tuning issues have caused performance regressions across kernel versions. The heuristics for "should we readahead?" are imperfect.

#### Mitigation

```bash
# Check current readahead (pages)
cat /proc/sys/vm/page-cluster
# Default: 3 (meaning 2^3 = 8 pages readahead)

# Disable swap readahead
echo 0 > /proc/sys/vm/page-cluster

# On SSDs, readahead matters less (fast random access)
# On HDDs, readahead helps if access is sequential
```

---

### Case 6: Large folio + swap = data loss (2023)

#### What happened

The large folio support (kernel 6.1+) introduced a data loss bug affecting XFS and other filesystems. Organizations reported [active data loss](https://lore.kernel.org/linux-mm/CAHk-=wjty_0NfiZn2HVzT0Ye-RR09+Rqbd1azwJLOTJrX+V5MQ@mail.gmail.com/T/) in production.

#### The bug

Large folios change how pages are tracked and written back. Interactions with the swap and writeback paths led to pages being marked clean when they were actually dirty, resulting in data loss.

From the LKML report:

> *"At least 16 instances of data loss in a fleet of 1.5k VMs... happens mostly on nodes running database or storage-oriented workloads, including PostgreSQL, MySQL, RocksDB."*

#### Real-world implications

This is catastrophic for databases and storage systems. Data written to memory but not yet persisted could simply disappear.

#### The fix

Meta and other companies disabled large folios while fixes were developed:

**Commit**: [a48d5bdc877b](https://git.kernel.org/linus/a48d5bdc877b) ("mm: fix for negative counter: nr_file_hugepages")

**Author**: Stefan Roesch

Multiple patches were required to fully address the issue.

---

### Summary: Lessons learned

| Bug | Year | Root Cause | Impact | Prevention |
|-----|------|------------|--------|------------|
| **Swap slot ABA** | 2024 | Skip-swapcache race | Data corruption | Fixed in mainline |
| **ZSWAP races** | Ongoing | Compression + swap cache | Data corruption | Multiple fixes |
| **Swap-over-NFS** | Historical | Memory deadlock | System hang | Use local swap |
| **Large folio + swap** | 2023 | Writeback tracking | Data loss | Disable large folios or update kernel |
| **Readahead trap** | Ongoing | Wrong heuristics | Performance | Tune `page-cluster` |

The common thread: **swap is a "slow path" that gets less testing than the normal memory path**. When the system is under memory pressure, it's already in a degraded state, and bugs in swap handling compound the problem.

## Further reading

### Related docs

- [Swap](swap.md) - Swap configuration and management
- [Page reclaim](reclaim.md) - How pages are selected for swap
- [Life of a page](life-of-page.md) - Complete page lifecycle
- [Running out of memory](oom.md) - What happens when swap isn't enough

### LWN articles

- [In defense of swap](https://lwn.net/Articles/690079/) (2016) - Why swap matters
- [zswap: compressed swap caching](https://lwn.net/Articles/537422/) (2013) - Compressed swap
- [Large folios for anonymous memory](https://lwn.net/Articles/908023/) (2022) - The large folio work that led to bugs
