# NUMA Topology Discovery: ACPI SRAT and SLIT

> How the kernel reads firmware tables to learn which memory belongs to which node — and how far apart those nodes are

On NUMA systems, the kernel cannot detect the physical memory topology on its own. It relies on firmware to describe which CPUs and memory ranges share a proximity domain and how far apart those domains are from each other. On x86 and ARM64 platforms this information lives in two ACPI tables: the **SRAT** (System Resource Affinity Table) and the **SLIT** (System Locality Information Table).

## Key Source Files

| File | Description |
|------|-------------|
| [`drivers/acpi/numa/srat.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/acpi/numa/srat.c) | Core SRAT/SLIT parsing: `acpi_numa_init()`, `acpi_parse_slit()` |
| [`arch/x86/mm/srat.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/srat.c) | x86 entry point (`x86_acpi_numa_init()`) and CPU affinity callbacks |
| [`arch/x86/mm/numa.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/numa.c) | x86 NUMA initialization orchestration, `dummy_numa_init()` |
| [`mm/numa_memblks.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/numa_memblks.c) | `numa_add_memblk()`, `numa_set_distance()`, NUMA distance table |
| [`include/acpi/actbl3.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/acpi/actbl3.h) | SRAT and SLIT C struct definitions |

## What Are SRAT and SLIT?

SRAT and SLIT are ACPI firmware tables that together describe the physical memory topology of a NUMA system.

**SRAT** answers: *which CPUs and which memory ranges belong to which proximity domain?*

**SLIT** answers: *how far apart are the proximity domains from each other?*

A **proximity domain** (PXM) is firmware's opaque identifier for a NUMA locality group. The kernel maps each PXM to a Linux node number during boot; after that, PXM values are only used internally by the ACPI parsing code.

```
Firmware view (SRAT/SLIT)           Linux kernel view
─────────────────────────           ─────────────────
PXM 0  →  CPU 0-7, 0x00000000-0x3FFFFFFFFF    →  node 0
PXM 1  →  CPU 8-15, 0x4000000000-0x7FFFFFFFFF →  node 1

SLIT distances:
  PXM 0 → PXM 0: 10 (local)          node_distance(0,0) = 10
  PXM 0 → PXM 1: 21 (remote)         node_distance(0,1) = 21
  PXM 1 → PXM 0: 21 (remote)         node_distance(1,0) = 21
  PXM 1 → PXM 1: 10 (local)          node_distance(1,1) = 10
```

## SRAT Table Format

The SRAT is a variable-length ACPI table. It starts with a standard header followed by a sequence of subtable entries, each describing one CPU or one memory range.

### Table Header

```c
/* include/acpi/actbl3.h */
struct acpi_table_srat {
    struct acpi_table_header header;  /* "SRAT" signature, length, revision */
    u32 table_revision;               /* Must be 1 */
    u64 reserved;                     /* Reserved, must be zero */
};
```

The `header.revision` field is significant: SRAT revision 1 uses only the low 8 bits of `proximity_domain` in CPU affinity entries. Revision 2 and later use the full 32-bit value.

### Memory Affinity Subtable

Each memory range gets one `acpi_srat_mem_affinity` entry:

```c
/* include/acpi/actbl3.h */
struct acpi_srat_mem_affinity {
    struct acpi_subtable_header header;  /* type=1 (ACPI_SRAT_TYPE_MEMORY_AFFINITY), length */
    u32 proximity_domain;                /* Which PXM this memory belongs to */
    u16 reserved;
    u64 base_address;                    /* Physical start address */
    u64 length;                          /* Size in bytes */
    u32 reserved1;
    u32 flags;
    u64 reserved2;
};

/* Relevant flags */
#define ACPI_SRAT_MEM_ENABLED       (1)      /* Entry is valid and should be used */
#define ACPI_SRAT_MEM_HOT_PLUGGABLE (1 << 1) /* Range is hot-pluggable */
#define ACPI_SRAT_MEM_NON_VOLATILE  (1 << 2) /* Range is non-volatile (NVDIMM) */
#define ACPI_SRAT_MEM_SPEC_PURPOSE  (1 << 3) /* Reserved for specific purpose */
```

The kernel skips any entry where `ACPI_SRAT_MEM_ENABLED` is not set. Hot-pluggable ranges are registered with memblock as hotplug regions so the memory hotplug subsystem can manage them correctly.

### CPU Affinity Subtables

Two subtable types handle CPUs depending on whether the system uses the legacy local APIC or x2APIC:

```c
/* Legacy APIC CPUs (SRAT type 0) */
struct acpi_srat_cpu_affinity {
    struct acpi_subtable_header header;
    u8  proximity_domain_lo;    /* Low 8 bits of PXM (SRAT rev 1 only uses this) */
    u8  apic_id;                /* Local APIC ID */
    u32 flags;                  /* ACPI_SRAT_CPU_ENABLED = 1 */
    u8  local_sapic_eid;        /* SAPIC extended ID (for Itanium, rarely used) */
    u8  proximity_domain_hi[3]; /* High 24 bits of PXM (SRAT rev >= 2) */
    u32 clock_domain;
};

/* x2APIC CPUs (SRAT type 2, ACPI 4.0+) */
struct acpi_srat_x2apic_cpu_affinity {
    struct acpi_subtable_header header;
    u16 reserved;
    u32 proximity_domain;       /* Full 32-bit PXM */
    u32 apic_id;                /* x2APIC ID */
    u32 flags;                  /* ACPI_SRAT_CPU_ENABLED = 1 */
    u32 clock_domain;
    u32 reserved2;
};

#define ACPI_SRAT_CPU_ENABLED  (1)  /* Entry is valid */
```

ARM64 systems use `acpi_srat_gicc_affinity` (SRAT type 3) instead of the APIC-based structures.

## SLIT Table Format

The SLIT encodes the relative memory access latency between every pair of proximity domains as a flat byte matrix:

```c
/* include/acpi/actbl3.h */
struct acpi_table_slit {
    struct acpi_table_header header;  /* "SLIT" signature */
    u64 locality_count;               /* Number of proximity domains (N) */
    u8  entry[];                      /* N*N byte matrix, row-major */
};
```

The distance from PXM `i` to PXM `j` is:

```
distance = slit->entry[i * locality_count + j]
```

Defined reference values (from `include/linux/topology.h`):

| Value | Meaning |
|-------|---------|
| `10` (`LOCAL_DISTANCE`) | Local node access |
| `20` (`REMOTE_DISTANCE`) | Default remote distance when no SLIT |
| > 10 | Higher = further away |

The diagonal (`i == j`) must always be `LOCAL_DISTANCE` (10). Off-diagonal values must be strictly greater than 10. The kernel validates this in `slit_valid()` before using the table — if the SLIT fails validation it is silently discarded and default distances are used.

## Kernel Parsing Path

### Entry Points

On x86, NUMA initialization is orchestrated from `x86_numa_init()` in `arch/x86/mm/numa.c`. It tries each initialization method in order until one succeeds:

```
x86_numa_init()
  └─ numa_init(x86_acpi_numa_init)         [CONFIG_ACPI_NUMA]
       └─ x86_acpi_numa_init()              arch/x86/mm/srat.c
            └─ acpi_numa_init()             drivers/acpi/numa/srat.c
                 ├─ parse SRAT table
                 └─ parse SLIT table
  └─ numa_init(amd_numa_init)              [CONFIG_AMD_NUMA, fallback]
  └─ numa_init(of_numa_init)              [Device Tree, acpi_disabled]
  └─ numa_init(dummy_numa_init)           [last resort: single node 0]
```

### SRAT Parsing in acpi_numa_init()

`acpi_numa_init()` in `drivers/acpi/numa/srat.c` drives the full SRAT/SLIT parsing sequence:

```c
int __init acpi_numa_init(void)
{
    /* Parse SRAT table header, then iterate all subtable types */
    if (!acpi_table_parse(ACPI_SIG_SRAT, acpi_parse_srat)) {
        struct acpi_subtable_proc srat_proc[5];

        /* CPU affinity subtables are processed first */
        srat_proc[0].id = ACPI_SRAT_TYPE_CPU_AFFINITY;
        srat_proc[0].handler = acpi_parse_processor_affinity;
        srat_proc[1].id = ACPI_SRAT_TYPE_X2APIC_CPU_AFFINITY;
        srat_proc[1].handler = acpi_parse_x2apic_affinity;
        srat_proc[2].id = ACPI_SRAT_TYPE_GICC_AFFINITY;   /* ARM64 */
        srat_proc[2].handler = acpi_parse_gicc_affinity;
        /* ... */
        acpi_table_parse_entries_array(ACPI_SIG_SRAT, ...);

        /* Then memory affinity subtables */
        cnt = acpi_table_parse_srat(ACPI_SRAT_TYPE_MEMORY_AFFINITY,
                                    acpi_parse_memory_affinity, 0);
    }

    /* Parse SLIT */
    acpi_table_parse(ACPI_SIG_SLIT, acpi_parse_slit);
    /* ... */
}
```

### CPU Entry Processing

For each CPU affinity subtable, `acpi_numa_processor_affinity_init()` (in `arch/x86/mm/srat.c`) is called:

1. Check `ACPI_SRAT_CPU_ENABLED` flag — skip disabled entries.
2. Extract the proximity domain, accounting for SRAT revision (rev 1 uses only `proximity_domain_lo`).
3. Call `acpi_map_pxm_to_node(pxm)` to get or allocate a Linux node number for this PXM.
4. Record the APIC ID → node mapping in `__apicid_to_node[]`.

### Memory Entry Processing

For each memory affinity subtable, `acpi_parse_memory_affinity()` is called:

1. Check `ACPI_SRAT_MEM_ENABLED` — skip disabled entries.
2. Extract `base_address` and `length` to form the physical range `[start, end)`.
3. Extract `proximity_domain` (masked to 8 bits for SRAT rev ≤ 1).
4. Call `acpi_map_pxm_to_node(pxm)` to get the Linux node number.
5. Call `numa_add_memblk(node, start, end)` to register the range.

### PXM to Node Mapping

The mapping between firmware PXM values and Linux node numbers is maintained by two arrays in `drivers/acpi/numa/srat.c`:

```c
static int pxm_to_node_map[MAX_PXM_DOMAINS];  /* PXM → node */
static int node_to_pxm_map[MAX_NUMNODES];      /* node → PXM */
```

Two public functions expose this mapping:

```c
int pxm_to_node(int pxm);   /* Returns NUMA_NO_NODE if PXM unknown */
int node_to_pxm(int node);  /* Returns PXM_INVAL if no mapping */
```

`acpi_map_pxm_to_node(pxm)` is the internal function that allocates a new node number the first time a PXM is encountered. It uses `first_unset_node(nodes_found_map)` to find the next available slot. This is how sparse PXM values (e.g., PXMs 0, 5, 100) get compacted into consecutive Linux node numbers (0, 1, 2).

### SLIT Parsing

`acpi_parse_slit()` iterates over the SLIT matrix after SRAT parsing is complete, so that all PXM→node mappings are already established:

```c
for (i = 0; i < slit->locality_count; i++) {
    int from_node = pxm_to_node(i);
    if (from_node == NUMA_NO_NODE)
        continue;  /* PXM with no memory or CPU in SRAT */

    for (j = 0; j < slit->locality_count; j++) {
        int to_node = pxm_to_node(j);
        if (to_node == NUMA_NO_NODE)
            continue;

        numa_set_distance(from_node, to_node,
            slit->entry[slit->locality_count * i + j]);
    }
}
```

PXMs that appear in the SLIT but have no corresponding SRAT entry (no CPUs or memory) are silently skipped.

## From Proximity Domains to the Memory Subsystem

After SRAT parsing, the topology information is held in two structures that feed into the rest of the kernel.

### numa_memblks and memblock

`numa_add_memblk()` records `[start, end)` → `node` mappings in an internal `numa_meminfo` structure (in `mm/numa_memblks.c`). Later, `numa_memblks_init()` calls `memblock_set_node()` to tag every `memblock.memory` region with its NUMA node number. This is how the buddy allocator's per-node free lists are populated correctly at boot.

See [memblock: The Boot-Time Memory Allocator](memblock.md) for how `memblock` tracks these regions and hands them to the buddy allocator.

### NUMA Distance Matrix

`numa_set_distance(from, to, distance)` writes into a flat `u8` array allocated from memblock:

```c
/* mm/numa_memblks.c */
numa_distance[from * numa_distance_cnt + to] = distance;
```

At runtime, `node_distance(from, to)` (and its underlying `__node_distance()`) reads from this array to answer scheduler and page-allocator queries about topology proximity. The scheduler uses distance to prefer local memory allocation; the page allocator uses it to choose fallback nodes when the local node is exhausted.

```
SRAT parsing          SLIT parsing
     │                     │
     ▼                     ▼
numa_add_memblk()    numa_set_distance()
     │                     │
     ▼                     ▼
numa_meminfo{}       numa_distance[]
     │                     │
     ▼                     ▼
memblock_set_node()  __node_distance()
     │                     │
     ▼                     ▼
buddy allocator      scheduler / page alloc
per-node free lists  fallback node selection
```

## Common Firmware Bugs

!!! warning "Broken SRAT: memory silently assigned to node 0"
    If the SRAT is missing memory entries, the kernel falls through to `numa_fill_memblks()`, which assigns unclaimed physical ranges to node 0. On a 4-socket system this means all 3 remote nodes' memory appears as node 0. The system boots but NUMA is completely broken: no remote memory is accessible from the correct node, and `numactl -H` will show a single huge node.

    Detection: `numactl -H` reports one enormous node instead of several balanced ones. Boot log will show `SRAT: Node 0 PXM 0 [mem ...]` for all memory.

!!! warning "Broken SLIT: all distances reported as 10"
    Some firmware incorrectly fills the entire SLIT matrix — including off-diagonal entries — with the value 10 (`LOCAL_DISTANCE`). This means the firmware claims all nodes are equidistant from each other, which is false.

    The kernel catches this in `slit_valid()`, which checks that diagonal entries equal `LOCAL_DISTANCE` and off-diagonal entries are strictly greater. A SLIT that fails this check is rejected with the message:

    ```
    SLIT table looks invalid. Not used.
    ```

    When the SLIT is rejected, the kernel falls back to default distances: `LOCAL_DISTANCE` (10) for same-node and `REMOTE_DISTANCE` (20) for all cross-node pairs. The scheduler and page allocator still function but cannot make topology-aware decisions beyond the two-level local/remote distinction.

!!! warning "Sparse or non-contiguous PXM values"
    The ACPI specification allows PXM values to be sparse — a system might have PXMs 0, 5, and 100 with no PXMs in between. The kernel handles this via `acpi_map_pxm_to_node()`, which allocates consecutive Linux node numbers regardless of PXM gaps. However, a SLIT for such a system must be sized `101 × 101` (for PXMs 0 through 100), and entries for non-existent PXMs must still be present.

    Firmware that sizes the SLIT matrix incorrectly — for example, using `3 × 3` instead of `101 × 101` — will cause the kernel to read past the end of the table when translating distances. The kernel will either silently use garbage distance values or reject the SLIT as invalid.

!!! warning "SRAT revision mismatch"
    SRAT revision 1 packs the proximity domain into only the low 8 bits of the `proximity_domain_lo` field of CPU affinity entries. Starting with revision 2, the full 32-bit `proximity_domain` is used. Firmware that sets `header.revision = 1` but writes 32-bit PXMs will have its high bits silently masked off (`pxm &= 0xff`). CPUs and memory that share a PXM > 255 will appear to belong to PXM `pxm & 0xff`, breaking node assignments.

## Validating NUMA Topology

### Runtime Tools

```bash
# Show node sizes, CPUs per node, and the distance matrix
numactl --hardware

# Example output on a 2-node system:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7
# node 0 size: 65536 MB
# node 0 free: 61234 MB
# node 1 cpus: 8 9 10 11 12 13 14 15
# node 1 size: 65536 MB
# node 1 free: 60987 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# Read distance for a specific pair
cat /sys/devices/system/node/node0/distance
# 10 21   (distance from node 0 to node 0, then node 0 to node 1)
```

### Boot Log

During early boot, the ACPI NUMA code logs each SRAT entry it accepts:

```bash
dmesg | grep -i "SRAT"
# ACPI: SRAT: Node 0 PXM 0 [mem 0x00000000-0x3fffffffff]
# ACPI: SRAT: Node 1 PXM 1 [mem 0x4000000000-0x7fffffffff]
# ACPI: SRAT: Node 0 PXM 0 [mem 0x100000000-0x3fffffffff] hotplug
```

Missing expected nodes here is a clear sign of a broken SRAT.

### Decoding the Raw Tables

For deep inspection, decode the raw ACPI tables with the standard toolchain:

```bash
# Dump all ACPI tables to binary files
acpidump -o acpi.dat
acpixtract acpi.dat

# Disassemble SRAT and SLIT
iasl -d SRAT.dat
iasl -d SLIT.dat
# Produces SRAT.dsl and SLIT.dsl — human-readable text

# Check for hotplug memory regions
grep -i "hot" SRAT.dsl
```

## Non-ACPI Systems

ACPI-based SRAT/SLIT parsing is used on x86 and ARM64. Other platforms discover NUMA topology differently:

**Device Tree (ARM, RISC-V)**: Topology is described by the `numa-node-id` property in DT nodes. `of_numa_init()` reads these and calls `numa_add_memblk()` with the same interface that the SRAT parser uses. See [memblock: The Boot-Time Memory Allocator](memblock.md) for context on how Device Tree memory regions flow into memblock.

**AMD without ACPI (`amd_numa_init()`)**: On older AMD systems where ACPI NUMA support is broken or absent, the kernel probes the AMD northbridge directly for memory topology. This is a fallback that runs only when `x86_acpi_numa_init()` fails.

**No NUMA firmware (`dummy_numa_init()`)**: When all other methods fail (or when `numa=off` is passed on the kernel command line), `dummy_numa_init()` creates a single fake node 0 that covers the entire physical address space. The system runs as if it were a UMA machine regardless of the actual hardware topology.

```c
/* arch/x86/mm/numa.c */
static int __init dummy_numa_init(void)
{
    node_set(0, numa_nodes_parsed);
    numa_add_memblk(0, 0, PFN_PHYS(max_pfn));
    return 0;
}
```
