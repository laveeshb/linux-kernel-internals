# NUMA Distance and Inter-Socket Latency

> How the kernel quantifies memory access cost across nodes — and why those numbers are not nanoseconds

## Key Source Files

| File | Description |
|------|-------------|
| [`include/linux/topology.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/topology.h) | `LOCAL_DISTANCE`, `REMOTE_DISTANCE`, `RECLAIM_DISTANCE`, default `node_distance()` macro |
| [`arch/x86/include/asm/topology.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/topology.h) | x86 override: `node_distance(a, b)` → `__node_distance(a, b)` |
| [`mm/numa_memblks.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/numa_memblks.c) | `numa_distance[]` flat matrix, `numa_set_distance()`, `__node_distance()` |
| [`drivers/base/node.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/base/node.c) | `node_read_distance()` — sysfs `distance` attribute under each node |
| [`mm/page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/page_alloc.c) | `build_zonelists()`, `find_next_best_node()`, `node_reclaim_distance` |
| [`kernel/sched/fair.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/fair.c) | `task_numa_migrate()`, `should_numa_migrate_memory()` |
| [`arch/x86/mm/numa.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/mm/numa.c) | x86 NUMA initialisation, ACPI/AMD/OF init paths |

---

## NUMA distance defined

The kernel represents the cost of crossing a NUMA interconnect as a **dimensionless integer**, not a latency in nanoseconds. Two constants set the scale, defined in `include/linux/topology.h`:

```c
/* include/linux/topology.h — conforms to ACPI 2.0 SLIT distance definitions */
#define LOCAL_DISTANCE    10
#define REMOTE_DISTANCE   20
#define DISTANCE_BITS      8   /* distances are u8, range 0–255 */
```

The generic fallback macro, used on platforms that do not supply a hardware-derived table, is:

```c
/* include/linux/topology.h */
#ifndef node_distance
#define node_distance(from, to) \
    ((from) == (to) ? LOCAL_DISTANCE : REMOTE_DISTANCE)
#endif
```

On x86 the generic macro is overridden by a real lookup:

```c
/* arch/x86/include/asm/topology.h */
extern int __node_distance(int, int);
#define node_distance(a, b) __node_distance(a, b)
```

`__node_distance()` indexes a flat `u8` array called `numa_distance`, allocated and populated at boot from firmware data:

```c
/* mm/numa_memblks.c */
int __node_distance(int from, int to)
{
    if (from >= numa_distance_cnt || to >= numa_distance_cnt)
        return from == to ? LOCAL_DISTANCE : REMOTE_DISTANCE;
    return numa_distance[from * numa_distance_cnt + to];
}
EXPORT_SYMBOL(__node_distance);
```

### Distances are ratios, not nanoseconds

`LOCAL_DISTANCE = 10` does **not** mean 10 nanoseconds. The values are proportional: a distance of 20 means "roughly twice the cost of a local access". The ACPI SLIT specification defines them as relative performance ratios. A real 2-socket Intel system might show local DRAM at ~80 ns and remote DRAM at ~130 ns, but both would carry distance values of 10 and 20 respectively — the ratio 1:2 is what matters to the kernel, not the absolute measurement.

For the abstract distance model used by the memory tier framework (which translates hardware performance coordinates into tier placement), see [CXL Memory and Kernel Memory Tiering](cxl-memory-tiering.md).

---

## Where distances come from

### ACPI SLIT table

On systems with full ACPI support, distances are provided by the **System Locality Information Table (SLIT)**. Each entry `SLIT[i][j]` gives the relative latency from node `i` to node `j`. The SLIT is the primary source for multi-socket x86 servers, ARM servers, and most hardware where inter-socket topology is non-trivial.

SLIT is part of the same ACPI firmware infrastructure as the SRAT (System Resource Affinity Table), which maps CPUs and memory ranges to nodes. For a detailed treatment of how the kernel parses SRAT and SLIT, see the upcoming `numa-acpi-srat.md` explainer.

The `x86_numa_init()` function in `arch/x86/mm/numa.c` tries the following initialisation paths in order, stopping at the first success:

```
x86_acpi_numa_init()    ← SRAT + SLIT
amd_numa_init()         ← AMD-specific NUMA (older platforms)
of_numa_init()          ← Device Tree (non-ACPI ARM/RISC-V via DT)
dummy_numa_init()       ← fallback: single node, all memory in node 0
```

### Systems without SLIT

When no SLIT is present — or when ACPI is disabled — `numa_alloc_distance()` fills the matrix with defaults:

```c
/* mm/numa_memblks.c */
for (i = 0; i < cnt; i++)
    for (j = 0; j < cnt; j++)
        numa_distance[i * cnt + j] = i == j ?
            LOCAL_DISTANCE : REMOTE_DISTANCE;
```

Every node-pair gets distance 10 (self) or 20 (other). This is correct for a true 2-node UMA-equivalent system but will not reflect multi-hop topologies.

### Emulated and VM NUMA

Virtualisation hypervisors frequently expose a flat NUMA topology where all distances are 10, because the guest OS is not crossing real hardware interconnects. This causes the kernel's distance-driven decisions (zonelist ordering, NUMA balancing thresholds) to behave as if all memory is equidistant — which on a VM usually is true. See the [Common pitfalls](#common-pitfalls) section.

---

## The distance matrix

### Reading /sys/devices/system/node/nodeN/distance

The kernel exposes the complete row of the distance matrix for each node via sysfs. The `node_read_distance()` function in `drivers/base/node.c` iterates over all online nodes and emits `node_distance(nid, i)` for each:

```bash
# 2-socket system — 2 nodes
$ cat /sys/devices/system/node/node0/distance
10 21
$ cat /sys/devices/system/node/node1/distance
21 10
```

Node 0's row: distance to itself is 10, distance to node 1 is 21. Node 1's row mirrors it. The value 21 (rather than exactly 20) is common; firmware often reports 21 to indicate "one hop, slightly over the REMOTE_DISTANCE baseline".

`numactl --hardware` presents the same data in a more readable matrix form:

```
node distances:
node   0   1
  0:  10  21
  1:  21  10
```

### 4-socket system example

A 4-socket server where nodes 0/1 share one NUMA domain and nodes 2/3 share another, with cross-domain traffic passing through two interconnect hops, might show:

```
node distances:
node   0   1   2   3
  0:  10  11  21  22
  1:  11  10  22  21
  2:  21  22  10  11
  3:  22  21  11  10
```

- Distance 10–11: local socket (one hop within the same die or between adjacent dies)
- Distance 21–22: remote socket (two hops across the inter-socket fabric)

Reading the matrix: row is the *source* node, column is the *target* node. Entry `[0][2] = 21` means a CPU on node 0 accessing memory on node 2 has relative cost 21.

### Asymmetric distances

The SLIT specification allows asymmetric entries: `SLIT[i][j]` need not equal `SLIT[j][i]`. This can occur on certain NUMA-over-fabric configurations (e.g. coherent accelerator interconnects) where the cost of a read in one direction differs from the reverse. Linux stores and uses the full matrix without enforcing symmetry, so asymmetric firmware tables will be reflected faithfully in sysfs and in `node_distance()` calls.

### Internal storage

The matrix is stored as a flat `u8` array indexed as `numa_distance[from * numa_distance_cnt + to]`, allocated via `memblock` early in boot. The array is populated by `numa_set_distance()`, which rejects values outside the valid `u8` range and enforces that the diagonal entries are always `LOCAL_DISTANCE`.

---

## How the kernel uses distances

### Zonelist ordering (memory allocator fallback)

`build_zonelists()` in `mm/page_alloc.c` constructs the **fallback zonelist** — the ordered sequence of memory zones the allocator tries when the preferred node cannot satisfy a request. Nodes are sorted by their distance from the local node:

```c
/* mm/page_alloc.c — build_zonelists() */
while ((node = find_next_best_node(local_node, &used_mask)) >= 0) {
    if (node_distance(local_node, node) !=
        node_distance(local_node, prev_node))
        node_load[node] += 1;    /* new distance tier: reset round-robin */
    node_order[nr_nodes++] = node;
    prev_node = node;
}
build_zonelists_in_node_order(pgdat, node_order, nr_nodes);
```

`find_next_best_node()` uses `node_distance()` as the primary sort key, so nodes at distance 10 come first, then distance 21, then distance 30, and so on. The allocator will exhaust all memory on closer nodes before falling back to farther ones.

### Node reclaim threshold

`RECLAIM_DISTANCE` (default 30) controls when `node_reclaim()` is restricted to nearby nodes:

```c
/* include/linux/topology.h */
#ifndef RECLAIM_DISTANCE
#define RECLAIM_DISTANCE 30
#endif

extern int __read_mostly node_reclaim_distance;
```

If `node_reclaim_mode` is enabled and the distance to a candidate node exceeds `node_reclaim_distance`, the kernel will not attempt to reclaim memory on that node — it is cheaper to allocate remotely than to reclaim-and-migrate across a high-latency link.

AMD EPYC systems override `node_reclaim_distance` upward because their 2-hop distance (32) is still fast enough that cross-node reclaim improves performance rather than hurting it. This is documented in the kernel comment in `topology.h`.

### Scheduler: NUMA domain construction

The scheduler builds `sched_domain` hierarchy using NUMA distances. Nodes at the same distance from each other form a NUMA scheduling domain (`SD_NUMA`). `task_numa_migrate()` in `kernel/sched/fair.c` queries the distance between the task's current node and its preferred node when deciding whether to migrate:

```c
/* kernel/sched/fair.c — task_numa_migrate() */
env.dst_nid = p->numa_preferred_nid;
dist = env.dist = node_distance(env.src_nid, env.dst_nid);
taskweight = task_weight(p, env.src_nid, dist);
...
taskimp = task_weight(p, env.dst_nid, dist) - taskweight;
```

`dist` is passed into the weight calculations so that the migration benefit is scaled by how far the task would travel. A move across a high-distance link requires a larger imbalance to justify.

### NUMA balancing: migration decisions

`should_numa_migrate_memory()` in `kernel/sched/fair.c` decides whether a page fault on a remote page should trigger migration. For pages in slow memory tiers, the decision is based on access frequency (how recently the page was faulted) rather than distance alone. For conventional NUMA balancing, the mempolicy layer's `numa_nearest_node()` function in `mm/mempolicy.c` uses `node_distance()` to find nodes closer to the faulting CPU, and `numa_migrate_check()` in `mm/memory.c` prepares the migration:

```c
/* mm/mempolicy.c — nearest-node search */
dist = node_distance(node, n);
```

Pages are directed toward the node with the smallest distance to the CPU that faulted, subject to memory availability and cpuset constraints.

---

## Measuring actual latency

!!! warning "Distance values may not reflect real hardware"
    Firmware SLIT entries are populated by BIOS/firmware writers. On some platforms they are approximations, placeholders, or simply wrong. Always validate distance values against a direct latency measurement before drawing performance conclusions.

### Intel MLC (Memory Latency Checker)

Intel MLC is the industry-standard tool for measuring loaded and unloaded NUMA memory latency. It probes each node pair with configurable access patterns:

```bash
# Measure idle latency matrix across all node pairs
./mlc --latency_matrix

# Measure loaded latency (with traffic injectors)
./mlc --loaded_latency

# Bandwidth matrix
./mlc --bandwidth_matrix
```

MLC reports latencies in nanoseconds. Compare the ratio of remote-to-local latency against the kernel's distance ratio to assess whether the SLIT is calibrated correctly.

### numactl + stream

For a quick bandwidth measurement without MLC:

```bash
# Node 0 CPUs reading from node 1 memory
numactl --cpunodebind=0 --membind=1 ./stream

# Node 0 CPUs reading from local memory
numactl --cpunodebind=0 --membind=0 ./stream
```

The bandwidth ratio indicates how much remote access degrades throughput. A 2-socket system with a SLIT-reported distance ratio of 2:1 will typically show a bandwidth degradation of 30–50% for remote access, not 50%, because interconnect bandwidth is often asymmetric and the bottleneck shifts to the QPI/UPI link rather than DRAM bandwidth.

### perf mem

`perf mem` can attribute cache and DRAM misses to specific NUMA nodes using hardware performance monitoring units:

```bash
# Requires /proc/sys/kernel/perf_event_paranoid <= 1 (or CAP_PERFMON)
perf mem record -a -- sleep 5
perf mem report --sort=mem,sym
```

The report shows the source node (local/remote) for each memory access sample, letting you identify hot-spots with poor locality without modifying the workload.

### Loaded vs idle latency

Two measurements matter for different scenarios:

- **Idle latency** (no competing traffic): represents the raw hardware round-trip time. Useful for validating the SLIT ratio.
- **Loaded latency** (with bandwidth injectors): represents latency under real workload conditions. Interconnect contention under load can push remote latency significantly above what idle measurements suggest.

For bandwidth-bound workloads (databases, HPC), loaded latency and bandwidth saturation are the primary constraints. For latency-sensitive workloads (in-memory caches, trading systems), idle latency and tail latency under light load matter more.

---

## Multi-hop NUMA

On systems with more than two sockets, the distance matrix encodes **hop count** across the inter-socket fabric. A 4-socket system arranged in a ring or fully connected mesh will have at most two distinct remote distances:

```
distance 20-22: one hop  (directly connected socket pair)
distance 30-32: two hops (socket pair connected only through a third)
```

### Identifying multi-hop topology

Read the distance matrix and look for more than two distinct values in off-diagonal entries:

```bash
numactl --hardware | grep -A 10 "node distances"
```

If you see three or more distinct distance values, the system has multi-hop paths. The longest path identifies the worst-case remote access cost.

### Scheduler and allocator impact

`build_zonelists()` groups nodes into **distance tiers**: all nodes at the same distance from the local node form one tier, and the allocator exhausts one tier before proceeding to the next. On a 4-socket system with distances {10, 21, 32}, node 0's fallback order would be:

1. Node 0 (distance 10 — local)
2. Nodes directly connected (distance 21) — round-robin within tier
3. Nodes two hops away (distance 32) — only if tiers 1 and 2 are exhausted

The scheduler's `SD_NUMA` domain similarly treats the first hop differently from the second: migrations within the near tier are less penalised than migrations across a two-hop boundary.

### AMD EPYC multi-die topology

AMD EPYC processors expose multiple NUMA nodes per socket (one per die or per quadrant). A 2-socket EPYC system may present 4 or 8 NUMA nodes, with intra-socket distances of 12 and inter-socket distances of 32. The BIOS-provided SLIT on EPYC systems is generally accurate — AMD ships validated ACPI tables. The `node_reclaim_distance` override for EPYC (mentioned above) accounts for the fact that 32 is still fast enough to benefit from reclaim.

---

## Common pitfalls

!!! warning "All distances are 10: distances are likely wrong"
    If `numactl --hardware` shows every node distance as 10, the firmware is not providing a real SLIT, or the SLIT has been synthesised with all-local values. This happens in two common scenarios:

    1. **Virtualised NUMA** — the hypervisor exposes NUMA nodes (e.g. to spread vCPUs) but all guest memory is on the same NUMA domain of the host. All guest distances are 10 because there is no real remote cost.

    2. **Broken BIOS SLIT** — some firmware incorrectly reports all distances as 10 even on real multi-socket hardware. The kernel will treat all nodes as equidistant and will not prefer local memory allocation. Performance on a NUMA workload may be poor without obvious explanation.

    To detect the broken-BIOS case: if `lscpu` shows multiple sockets but `numactl -H` shows all distances as 10, the SLIT is almost certainly wrong. Check BIOS updates or use `acpidump | acpixtract -sLIT` to inspect the raw table.

!!! warning "VM NUMA topology without real NUMA effect"
    A VM configured with `numaNodes=2` will have a distance matrix, but if the hypervisor allocates guest memory from a single host NUMA node, accesses to either guest node go to the same physical memory. The kernel's NUMA balancing and zonelist decisions are driven by the guest distance table and will attempt migrations that have no performance benefit — and may add overhead. Consider disabling NUMA balancing inside VMs that do not map to real hardware topology (`echo 0 > /proc/sys/kernel/numa_balancing`).

!!! warning "Distance values are u8 — maximum 255"
    `DISTANCE_BITS 8` means distances are stored as unsigned 8-bit values. `numa_set_distance()` rejects any value that does not fit in a `u8`. Firmware providing distances above 255 (unusual but possible on deeply hierarchical fabric topologies) will be clamped or rejected, and `__node_distance()` will fall back to `REMOTE_DISTANCE`.

!!! warning "numactl may not show memory-only nodes"
    Nodes with no CPUs (e.g. CXL memory nodes, HMAT generic initiator nodes) may not appear in `numactl --hardware` output depending on the numactl version and kernel configuration. Use `ls /sys/devices/system/node/` to enumerate all nodes, including memory-only ones, and read each node's `distance` file directly.
