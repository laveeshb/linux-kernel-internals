# IOMMU War Stories

> Real incidents: DMA faults, group isolation failures, and performance surprises

These are representative real-world incidents that follow recognizable patterns from production systems, kernel bug reports, and public postmortem discussions. The kernel behaviors, tools, and fixes are accurate.

---

## 1. DMAR fault storm from a misbehaving NIC

### Problem

A server running a 10GbE NIC driver starts logging thousands of lines per second:

```
DMAR: [DMA Write] Request device [02:00.0] fault addr 7fa800000000
      DMAR:[fault reason 06] Write access is not set
DMAR: [DMA Write] Request device [02:00.0] fault addr 7fa800001000
      DMAR:[fault reason 06] Write access is not set
DMAR: [DMA Write] Request device [02:00.0] fault addr 7fa800002000
...
```

The NIC is sending (DMA write) to addresses that the IOMMU has no mapping for, or has mapped read-only. Network throughput drops to zero. The fault storm fills the kernel log ring buffer, displacing other messages.

### Diagnosis

The fault address `7fa800000000` is in the 64-bit IOVA space. The first step is to check whether the mapping even exists:

```bash
# Is the device using an IOMMU domain?
cat /sys/bus/pci/devices/0000:02:00.0/iommu_group
# 15

# Is the IOMMU active (not passthrough)?
dmesg | grep "DMAR: IOMMU"
# DMAR: IOMMU enabled

# DMAR fault registers (Intel VT-d specific)
# Fault reason 06 = "Write access is not set"
# (Fault reason 05 = "Read access is not set")
# This means a mapping exists but with wrong permissions (write attempted to read-only mapping)

# Check the IOVA allocator state for the domain
cat /sys/kernel/debug/iommu/intel/iommu_perf_stats
```

Fault reason 06 ("Write access is not set") is the important clue: the mapping exists, but the PTE does not allow writes and the device is trying to write. This points to a driver that incorrectly maps receive buffers as `DMA_TO_DEVICE` (read-only from device perspective) instead of `DMA_FROM_DEVICE`.

```bash
# Enable DMA API debugging to catch mismatched directions at map time
# (requires CONFIG_DMA_API_DEBUG=y)
echo 0 > /sys/kernel/debug/dma-api/disabled
dmesg | grep "DMA-API"
# DMA-API: device 0000:02:00.0 mapping error: wrong direction
```

### Root cause

A bug in the NIC driver's hot-path buffer refill code: receive descriptors were being mapped with `DMA_TO_DEVICE` instead of `DMA_FROM_DEVICE`. Without IOMMU, this was silent — physical addresses work regardless of the direction argument. With IOMMU active, the kernel creates a read-only IOMMU mapping for `DMA_TO_DEVICE`. The NIC tries to DMA-write received packet data into the buffer, the IOMMU blocks it, and a fault fires for every packet.

The bug was latent for years because test environments lacked IOMMU enabled.

### Fix

```c
/* Driver fix: change map direction for receive buffers */

/* Wrong: */
dma_handle = dma_map_single(dev, buf, len, DMA_TO_DEVICE);

/* Correct: device writes received data into this buffer */
dma_handle = dma_map_single(dev, buf, len, DMA_FROM_DEVICE);
```

**Workaround for production while the driver fix ships:**

```bash
# iommu=pt: passthrough mode — IOMMU groups still exist for VFIO,
# but no address translation (IOVA == PA). Eliminates permission checks.
# Add to kernel command line:
GRUB_CMDLINE_LINUX="intel_iommu=on iommu=pt"
```

`iommu=pt` disables DMA translation but keeps IOMMU groups intact. It is a legitimate performance optimization for trusted devices but eliminates the security benefit. Use it as a temporary workaround only; the real fix is the driver correction and re-enabling `iommu=on` (no `pt`).

**Long-term:** enable `CONFIG_DMA_API_DEBUG=y` in CI kernels to catch direction mismatches before they reach production.

---

## 2. IOVA allocator as a perf bottleneck

### Problem

A team upgrades their server from 10 GbE to 25 GbE. The NIC driver is the same codebase, just a faster link. They expect near-linear throughput scaling; instead, at high packet rates (small UDP packets, ~20 Mpps), CPU utilization for packet processing increases sharply. A `perf top` session shows:

```
Overhead  Symbol
  15.3%   alloc_iova
   8.1%   free_iova
   6.2%   iommu_map
   5.7%   iommu_unmap_fast
   ...
```

Over 29% of CPU is in IOVA allocation and mapping. The NIC driver uses `dma_map_single()` / `dma_map_page()` per packet, issuing one IOVA allocation per receive and transmit descriptor.

### Diagnosis

```bash
# Confirm IOMMU is active (not passthrough)
dmesg | grep "DMAR: IOMMU"

# Look at IOVA cache effectiveness
cat /sys/kernel/debug/iommu/iova
# The output shows allocation counts and cache hit rates per domain

# perf: show callers of alloc_iova
perf record -g -p $(pgrep irq/...-eth0) -- sleep 10
perf report --sort=symbol,dso | head -40
```

The perf callgraph shows `alloc_iova` being called from `iommu_dma_map_page` → `dma_map_page` → the NIC driver's descriptor refill function, one call per packet. At 20 Mpps, that is 20 million `alloc_iova` calls per second, each one touching the global rbtree spinlock when the rcache is exhausted.

Why is the rcache exhausted? The rcache holds freed IOVAs of matching sizes. With 2 KB receive buffers, the allocator uses the 1-page size class. But if the driver is allocating faster than it frees (in-flight descriptors exceed the rcache magazine size of 128), the rcache runs dry and falls through to the locked rbtree path.

### Fix

**Step 1: Switch to scatter-gather DMA batching.**

Instead of one `dma_map_single()` per buffer, batch multiple buffers with `dma_map_sg()`. This reduces the number of IOVA allocations:

```c
/* With IOMMU, dma_map_sg() can merge contiguous physical pages into
 * one IOVA range, reducing allocator pressure. */
nents = dma_map_sg(dev, sgl, count, DMA_FROM_DEVICE);
```

For a NIC with a ring of 512 descriptors, prefilling with `dma_map_sg()` in batches of 16–32 pages significantly reduces per-packet allocator calls.

**Step 2: Use `IOMMU_DOMAIN_DMA_FQ` (flush queue) mode.**

```bash
# Check if your kernel supports flush queue mode
grep CONFIG_IOMMU_DEFAULT_DMA_LAZY /boot/config-$(uname -r)
# CONFIG_IOMMU_DEFAULT_DMA_LAZY=y
```

With flush queue mode enabled, freed IOVAs are not returned to the pool immediately — they are batched and flushed together, amortizing IOTLB invalidation cost.

**Step 3: Confirm rcache coverage.**

The rcache covers allocations of 1, 2, 4, 8, 16, and 32 pages. If the NIC uses jumbo frames (9000-byte MTU, which needs 3 pages), it falls in the 4-page class. Ensure the driver uses consistent buffer sizes so the rcache can actually recycle entries.

**Result**: after switching to batched `dma_map_sg()` and enabling flush-queue mode, IOVA allocator overhead drops from 29% to under 4%, and the NIC achieves near-line-rate throughput.

---

## 3. IOMMU group blocking VFIO passthrough

### Problem

A user wants to pass their discrete GPU (`0000:01:00.0`) to a VM for GPU compute workloads. They follow the standard VFIO bind procedure:

```bash
echo "10de 1db6" | sudo tee /sys/bus/pci/drivers/vfio-pci/new_id
echo "0000:01:00.0" | sudo tee /sys/bus/pci/devices/0000:01:00.0/driver/unbind
echo "0000:01:00.0" | sudo tee /sys/bus/pci/drivers/vfio-pci/bind
```

Then in QEMU they see:

```
qemu-system-x86_64: -device vfio-pci,host=01:00.0: \
    vfio: error, group 12 is not viable, please ensure all devices
    within the iommu group are bound to their vfio driver:
    /sys/kernel/iommu_groups/12/devices/0000:01:00.1
```

The GPU's HDMI audio function (`01:00.1`) is in the same IOMMU group and is still bound to `snd_hda_intel`.

### Diagnosis

```bash
# See all devices in the group
ls /sys/kernel/iommu_groups/12/devices/
# 0000:01:00.0   (GPU, bound to vfio-pci)
# 0000:01:00.1   (GPU HDMI audio, bound to snd_hda_intel)

# Check why they're in the same group
# Look for ACS capability on the upstream port
lspci -vvv -s 0000:00:01.0 | grep "Access Control"
# (nothing — no ACS capability on the root port)
```

The GPU and its audio function are multi-function devices on the same PCIe slot. Without ACS on the upstream port (or the port doesn't support ACS at all), the IOMMU cannot isolate them — peer-to-peer DMA between the two functions bypasses the IOMMU. The kernel correctly groups them together.

VFIO enforces that the entire group must be assigned together. You cannot give the GPU to VM1 and the audio to VM2, or leave the audio in the host while passing the GPU to a VM.

### Options

**Option 1 (correct and safe): pass both devices to the VM.**

```bash
# Unbind audio from snd_hda_intel too
echo "0000:01:00.1" | sudo tee /sys/bus/pci/devices/0000:01:00.1/driver/unbind
echo "0000:01:00.1" | sudo tee /sys/bus/pci/drivers/vfio-pci/bind

# QEMU: pass both
-device vfio-pci,host=01:00.0 \
-device vfio-pci,host=01:00.1
```

The VM gets both GPU and its audio. This is the correct, safe approach.

**Option 2: ACS override patch (unsafe, understand the risks).**

Some community kernel patches (`pcie_acs_override=downstream,multifunction` boot parameter) force the kernel to treat each PCIe function as isolated even without hardware ACS. This breaks devices out of shared groups artificially.

```bash
# With ACS override patch applied:
GRUB_CMDLINE_LINUX="intel_iommu=on pcie_acs_override=downstream,multifunction"
```

**Risks:** The override lies to the IOMMU subsystem about isolation. If the GPU's compute engine can DMA to the audio function's memory (which it can on some hardware), and both are assigned to different VMs, VM1's device could access VM2's memory. This is a real security vulnerability for multi-tenant systems. On a single-user workstation, the practical risk is low, but the kernel deliberately does not include this patch in mainline.

**Option 3: Buy hardware with ACS-capable root ports.**

Server-grade PCIe switches and root complexes (EPYC, Xeon Scalable) often support ACS per-function, giving each PCIe device its own IOMMU group. Consumer chipsets frequently do not.

---

## 4. SVA page fault storm from an accelerator

### Problem

A team deploys Intel DSA (Data Streaming Accelerator) with SVA enabled for user-space copy offload. The application submits thousands of memory copy descriptors using process virtual addresses. Initially it works. Under load, the system slows dramatically and `dmesg` shows:

```
idxd 0000:6a:01.0: page request queue overflowed
idxd 0000:6a:01.0: PRI queue full, dropping page requests
DMAR: [PASID 0x42] Page request for addr 0x7f3c80000000: retried 3 times
```

Application throughput drops by 80%. CPU utilization for interrupt handling spikes.

### Diagnosis

The accelerator is encountering page faults mid-operation and sending Page Requests (PRI) to the IOMMU. The IOMMU delivers these to the kernel's IOMMU page fault handler, which must:

1. Find the `mm_struct` for the faulting PASID.
2. Call `handle_mm_fault()` to bring in the page.
3. Send a Page Request Response (PRG Response) back to the device.

At high submission rates, the device's PRI queue (a fixed-size hardware FIFO) fills faster than the kernel drains it. When the queue overflows, the device stalls pending work and may abort operations.

```bash
# Check DSA device status and PRI queue depth
cat /sys/bus/pci/devices/0000:6a:01.0/idxd/dsa0/state
# enabled

# Page fault handler activity (tracepoints)
echo 1 > /sys/kernel/tracing/events/iommu/io_page_fault/enable
cat /sys/kernel/tracing/trace | head -30
# iommu_page_fault: pasid=66 iova=0x7f3c80000000 reason=page-not-present

# Check if THP splitting is occurring (a major source of faults)
grep thp_split /proc/vmstat
```

Root causes in this case:
1. **Lazy allocation**: the application calls `mmap()` but does not touch all pages before submission. DSA encounters not-present PTEs on first access.
2. **THP splitting**: the kernel initially backed the buffer with 2 MB huge pages, but memory pressure caused them to split into 4 KB pages mid-workload, invalidating the device's ATC entries and generating a flood of re-faults.

### Mitigation

**Pre-fault pages before submission:**

```c
/* Application: fault in all pages before submitting to DSA */
madvise(buf, len, MADV_POPULATE_WRITE);
/* or use mlock() to both fault and pin */
mlock(buf, len);
```

`MADV_POPULATE_WRITE` (added in Linux 5.14) faults in all pages without requiring root, eliminating first-access faults.

**Disable THP for accelerator buffers:**

```c
/* Prevent THP from backing the buffer (avoids split-induced refaults) */
madvise(buf, len, MADV_NOHUGEPAGE);
```

**Increase the PRI queue depth** (if hardware supports it — check DVSEC registers).

**Use pre-pinned buffers for hot paths:**

For the hottest copy paths, pre-register buffers with the kernel and pin them for the session lifetime. DPDK's `idxd` PMD does this — it maps a fixed set of pinned buffers and submits only within them, avoiding SVA page faults entirely on the critical path while using SVA for the general case.

---

## 5. swiotlb exhaustion under IOMMU

### Problem

A server runs a mix of workloads: mostly 64-bit NVMe SSDs, but also a legacy RAID controller with a 32-bit DMA mask. The system has 256 GB of RAM. Under heavy I/O load, the RAID controller starts failing DMA allocations:

```
kernel: ata1: SCSI error: return code = 0x08000002
kernel: end_request: I/O error, dev sda, sector 0
kernel: DMA: Out of SW-IOMMU space for 131072 bytes at device 0000:04:00.0
```

And in dmesg earlier:

```
software IO TLB: mapped [mem 0x...] (64MB)
```

The swiotlb pool is 64 MB and is exhausted.

### Diagnosis

The RAID controller (`0000:04:00.0`) has a 32-bit DMA mask. The system RAM is mostly above 4 GB. With IOMMU enabled, the kernel allocates IOVAs below 4 GB for this device. But there is a subtlety:

When the IOMMU is active and a 32-bit device is present, the kernel still uses swiotlb in certain cases:

1. **IOVA allocation failure below 4 GB**: if the low IOVA space is fragmented or exhausted (from the `dma_32bit_pfn` region being oversubscribed), the IOMMU DMA layer falls back to swiotlb.
2. **Bounce for non-IOMMU paths**: during early boot before the IOMMU is initialized, or for devices not yet attached to an IOMMU domain.

```bash
# Check swiotlb usage
cat /sys/kernel/debug/swiotlb/io_tlb_nslabs
# 16384  (64MB / 4KB per slot)

cat /sys/kernel/debug/swiotlb/io_tlb_used
# 16384  ← fully exhausted

# Check IOVA space below 4GB
cat /sys/kernel/debug/iommu/iova
# Shows the 32-bit region state

# Which devices are competing for 32-bit IOVA?
for dev in /sys/bus/pci/devices/*/; do
    mask=$(cat $dev/dma_mask_bits 2>/dev/null)
    [ "$mask" = "32" ] && echo $dev
done
```

The problem: several devices (the RAID controller, a legacy USB controller, an old network card) all have 32-bit DMA masks. They share the 32-bit IOVA region. Under load, the NVMe drivers (64-bit) are not consuming 32-bit IOVA space, but the RAID driver sends large requests that fragment the low IOVA space, causing allocation failures. The kernel falls back to swiotlb for failed IOVA allocations, and the 64 MB swiotlb pool (the default) fills up quickly with 128 KB RAID I/O requests.

### Fix

**Increase the swiotlb pool size** (kernel command line):

```bash
# Increase swiotlb to 512MB (value is in MB, or use swiotlb=<num_slabs>)
GRUB_CMDLINE_LINUX="swiotlb=262144"
# 262144 slabs × 2KB per slab = 512MB
# Or in newer kernels (5.15+):
GRUB_CMDLINE_LINUX="swiotlb=512m"
```

**Ensure 64-bit devices don't consume 32-bit IOVA space.**

Audit drivers to ensure they call `dma_set_mask_and_coherent(dev, DMA_BIT_MASK(64))` where supported. A driver that fails to set a 64-bit mask defaults to 32-bit on some kernels, unnecessarily competing for low IOVA:

```c
/* Good practice in driver probe: */
ret = dma_set_mask_and_coherent(dev, DMA_BIT_MASK(64));
if (ret) {
    dev_warn(dev, "Unable to set 64-bit DMA mask, falling back to 32-bit\n");
    ret = dma_set_mask_and_coherent(dev, DMA_BIT_MASK(32));
    if (ret) {
        dev_err(dev, "No usable DMA configuration\n");
        return ret;
    }
}
```

**Consider replacing legacy 32-bit hardware.**

If the RAID controller is the sole 32-bit device, replacing it with a modern HBA eliminates the problem entirely. The swiotlb exists as a safety net, not a primary DMA path; sustained swiotlb usage means the system is not running optimally.

**Monitor proactively:**

```bash
# Alert if swiotlb usage exceeds 80%
USED=$(cat /sys/kernel/debug/swiotlb/io_tlb_used)
TOTAL=$(cat /sys/kernel/debug/swiotlb/io_tlb_nslabs)
echo "$USED / $TOTAL"
# Add to monitoring (Prometheus node_exporter custom collector, etc.)
```

---

## Common patterns

| Symptom | First tool | Likely cause |
|---------|-----------|-------------|
| `DMAR: [fault reason NN]` flood in dmesg | `dmesg \| grep DMAR` | Wrong DMA direction, stale mapping, or IOMMU not configured for device |
| High `alloc_iova` in `perf top` | `perf report`, `/sys/kernel/debug/iommu/iova` | IOVA rcache miss, per-packet mapping, wrong buffer sizes |
| VFIO "group not viable" error | `ls /sys/kernel/iommu_groups/<N>/devices/` | Multiple devices in one group; need to bind all to vfio-pci |
| DSA/accelerator stall with PRI overflow | `dmesg \| grep "page request"`, iommu tracepoints | Pages not pre-faulted; THP splitting; PRI queue too small |
| `DMA: Out of SW-IOMMU space` | `cat /sys/kernel/debug/swiotlb/io_tlb_used` | swiotlb pool exhausted; 32-bit device with large allocations |

## Further reading

- [IOMMU Architecture](iommu-arch.md) — IOMMU domains, IOTLB, DMAR fault registers
- [DMA API](dma-api.md) — `dma_map_single`, scatter-gather, swiotlb internals
- [IOVA Allocator](iova-allocator.md) — rcache, flush queues, 32-bit limit
- [SVA](sva.md) — PASID, PRI page fault handling
- [VFIO Internals](vfio-internals.md) — IOMMU groups, security model
