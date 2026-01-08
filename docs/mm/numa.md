# NUMA Memory Management

> Managing memory across multiple nodes

## What Is NUMA?

NUMA (Non-Uniform Memory Access) describes systems where memory access time depends on which CPU accesses which memory. Each CPU has "local" memory (fast) and "remote" memory (slower).

```
┌─────────────────────────────────────────────────────────┐
│                      NUMA System                         │
│                                                          │
│   Node 0                          Node 1                 │
│  ┌──────────────┐                ┌──────────────┐       │
│  │    CPU 0-7   │                │   CPU 8-15   │       │
│  └──────┬───────┘                └──────┬───────┘       │
│         │ fast                          │ fast          │
│  ┌──────▼───────┐                ┌──────▼───────┐       │
│  │  Memory 64GB │◄───────────────►  Memory 64GB │       │
│  └──────────────┘     slow       └──────────────┘       │
│                    interconnect                          │
└─────────────────────────────────────────────────────────┘

CPU 0 accessing Node 0 memory: ~80ns
CPU 0 accessing Node 1 memory: ~150ns (1.9x slower)
```

## Why NUMA Matters

### The Scalability Problem

As systems grew beyond 4-8 CPUs, a single memory bus became a bottleneck. Every CPU competed for the same memory bandwidth.

### NUMA as Solution

NUMA divides memory into nodes, each with dedicated bandwidth. Local access is fast; remote access crosses an interconnect but the system scales.

| System Type | CPUs | Memory Bandwidth |
|-------------|------|------------------|
| UMA (single bus) | 1-8 | Shared, contended |
| NUMA (2 nodes) | 8-32 | 2x bandwidth |
| NUMA (8 nodes) | 32-128+ | 8x bandwidth |

## Linux NUMA Support

### Topology Discovery

Linux discovers NUMA topology from firmware (ACPI SRAT/SLIT tables):

```bash
# View NUMA topology
numactl --hardware

# Example output:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7
# node 0 size: 65536 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10
```

The distance matrix shows relative access latency (10 = local, higher = remote).

### Default Allocation Policy

By default, Linux allocates memory from the node where the task is running ("local allocation"):

```c
/* Default: allocate from current node */
void *ptr = malloc(size);  /* Goes to local node */
```

## Memory Policies

Linux provides fine-grained control over NUMA placement via memory policies.

### Policy Types

| Policy | Behavior |
|--------|----------|
| `MPOL_DEFAULT` | Local allocation (system default) |
| `MPOL_BIND` | Only allocate from specified nodes |
| `MPOL_PREFERRED` | Prefer specified node, fall back to others |
| `MPOL_INTERLEAVE` | Round-robin across specified nodes |
| `MPOL_LOCAL` | Always allocate from local node |

### Setting Policies

**Process-wide (set_mempolicy)**:
```c
#include <numaif.h>

unsigned long nodemask = 0x1;  /* Node 0 */
set_mempolicy(MPOL_BIND, &nodemask, sizeof(nodemask) * 8);
/* All future allocations from node 0 only */
```

**Per-region (mbind)**:
```c
#include <numaif.h>

void *ptr = mmap(...);
unsigned long nodemask = 0x3;  /* Nodes 0 and 1 */
mbind(ptr, size, MPOL_INTERLEAVE, &nodemask,
      sizeof(nodemask) * 8, 0);
/* This region interleaved across nodes 0-1 */
```

**Command line (numactl)**:
```bash
# Run on specific CPUs and memory nodes
numactl --cpunodebind=0 --membind=0 ./myapp

# Interleave memory across all nodes
numactl --interleave=all ./myapp
```

### When to Use Each Policy

| Use Case | Recommended Policy |
|----------|-------------------|
| General applications | `MPOL_DEFAULT` (let kernel decide) |
| Memory-bandwidth bound | `MPOL_INTERLEAVE` |
| Latency-sensitive | `MPOL_BIND` to local node |
| Large shared buffers | `MPOL_INTERLEAVE` |
| Database buffer pools | `MPOL_BIND` or `MPOL_INTERLEAVE` |

## Automatic NUMA Balancing

Since v3.8, Linux can automatically migrate pages to be closer to the CPUs accessing them.

### How It Works

1. Kernel periodically unmaps pages (marks PTEs as "NUMA hint faults")
2. When accessed, a NUMA hint fault occurs
3. Kernel records which node accessed the page
4. If page is frequently accessed from remote node, migrate it

```
Page on Node 0, accessed by CPU on Node 1
              │
              v
      NUMA hint fault
              │
              v
    Record access from Node 1
              │
              v
    Migrate page to Node 1
              │
              v
    Future accesses are local (fast)
```

### Configuration

```bash
# Enable/disable NUMA balancing
cat /proc/sys/kernel/numa_balancing
echo 1 > /proc/sys/kernel/numa_balancing

# Scan period bounds (milliseconds between scans)
cat /proc/sys/kernel/numa_balancing_scan_period_min_ms  # Min time between scans
cat /proc/sys/kernel/numa_balancing_scan_period_max_ms  # Max time between scans
# Kernel adjusts scan rate within these bounds based on migration activity
```

### Trade-offs

**Benefits**:
- No application changes needed
- Adapts to changing access patterns
- Helps poorly-placed workloads

**Costs**:
- CPU overhead from fault handling
- Migration overhead
- Can fight with explicit policies

## Memory Tiering (CXL Era)

Modern systems add new memory tiers via CXL (Compute Express Link):

```
┌─────────────────────────────────────────────┐
│              Tiered Memory                   │
│                                              │
│  Tier 0: Local DRAM     (~80ns, expensive)  │
│  Tier 1: CXL Memory     (~200ns, cheaper)   │
│  Tier 2: Persistent Mem (~300ns, persistent)│
└─────────────────────────────────────────────┘
```

Linux treats CXL memory as additional NUMA nodes with higher distances. The kernel can demote cold pages to slower tiers and promote hot pages to faster tiers.

```bash
# View memory tiers (v6.1+)
cat /sys/devices/virtual/memory_tiering/memory_tier*/nodelist
```

## Monitoring

### Per-Node Statistics

```bash
# Memory per node
cat /sys/devices/system/node/node*/meminfo

# NUMA hits/misses
cat /proc/vmstat | grep numa
# numa_hit        - Allocations satisfied from preferred node
# numa_miss       - Allocations from non-preferred node
# numa_foreign    - Pages intended for this node, placed elsewhere
# numa_interleave - Interleaved allocations
# numa_local      - Local allocations
# numa_other      - Non-local allocations
```

### Per-Process NUMA Map

```bash
# Show which nodes hold a process's pages
cat /proc/<pid>/numa_maps

# Example:
# 7f8a1000 default file=/lib/libc.so anon=1 dirty=1 N0=1
# 7f8a2000 interleave:0-1 anon=512 N0=256 N1=256
```

## Evolution

### Early NUMA (v2.5-2.6, 2003-2004)

Basic NUMA support added by SGI, IBM and others for their large systems. Memory policies (`set_mempolicy`, `mbind`) introduced by Andi Kleen. The mempolicy code predates git history (included in initial v2.6.12 import).

### cpusets Integration (v2.6.16, 2005)

**Commit**: [68860ec10bcc](https://git.kernel.org/linus/68860ec10bcc) ("cpusets: automatic numa mempolicy rebinding")

cpusets allowed constraining processes to specific nodes, enabling NUMA-aware container isolation.

### Automatic NUMA Balancing (v3.8, 2013)

**Merge**: [3d59eebc5e13](https://git.kernel.org/linus/3d59eebc5e13) ("Merge tag 'balancenuma-v11'")

Kernel-level automatic page migration based on access patterns. Major work by Mel Gorman, Rik van Riel, and others.

### Memory Tiering (v5.18+, 2022)

**Commit**: [c574bbe91703](https://git.kernel.org/linus/c574bbe91703) ("NUMA balancing: optimize page placement for memory tiering system")

Support for heterogeneous memory (CXL, persistent memory) as additional NUMA tiers with automatic promotion/demotion. Further refined in v6.1 with explicit memory tier framework ([992bf77591cb](https://git.kernel.org/linus/992bf77591cb)).

## Common Issues

### Remote Memory Pressure

Allocations forced to remote nodes due to local exhaustion.

**Symptoms**: High `numa_miss` in `/proc/vmstat`

**Solutions**:
- Balance workload memory across nodes
- Use `MPOL_INTERLEAVE` for large allocations
- Reserve memory on each node

### NUMA Balancing Overhead

Excessive migration and fault handling.

**Symptoms**: High CPU in `task_numa_fault`, many page migrations

**Solutions**:
- Disable if workload has stable access patterns: `echo 0 > /proc/sys/kernel/numa_balancing`
- Tune scan rates
- Use explicit memory policies

### Unbalanced Node Usage

One node exhausted while others have free memory.

**Debug**: Check `/sys/devices/system/node/node*/meminfo`

**Solutions**:
- Use `MPOL_INTERLEAVE` for large allocations
- Improve workload distribution

## References

### Key Code

| File | Description |
|------|-------------|
| [`mm/mempolicy.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/mempolicy.c) | Memory policy implementation |
| [`kernel/sched/fair.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/sched/fair.c) | NUMA balancing in scheduler |
| [`mm/migrate.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/migrate.c) | Page migration |

### Kernel Documentation

- [`Documentation/admin-guide/mm/numa_memory_policy.rst`](https://docs.kernel.org/admin-guide/mm/numa_memory_policy.html)

### Mailing List Discussions

- [Automatic NUMA Balancing V3 (RFC)](https://lore.kernel.org/linux-mm/20121116160852.GA4302@gmail.com/t/) - Mel Gorman's 2012 RFC laying out the four-stage design
- [NUMA balancing sysctls documentation](https://lore.kernel.org/lkml/1373065742-9753-2-git-send-email-mgorman@suse.de/) - July 2013 patch series

### Related

- [page-allocator](page-allocator.md) - Per-node zones
- [reclaim](reclaim.md) - Per-node reclaim
- [glossary](glossary.md) - NUMA terminology
