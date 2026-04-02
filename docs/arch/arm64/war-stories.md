# ARM64 War Stories

> Cache coherency bugs, TLB shootdown ordering, BTI enforcement, and SVE context corruption

These are realistic composites of failure patterns that actually occur on ARM64 systems. Each story follows a real bug class rooted in ARM64 architecture specifics — weak memory ordering, hardware coherency requirements, CPU feature enforcement, and errata handling. Names and products are illustrative; the failure modes are real.

---

## 1. The SVE Context Switch Bug

### Setup

A storage driver was optimized to use SIMD to accelerate CRC32 checksums on data blocks during I/O completion. The developer correctly called `kernel_neon_begin()` and `kernel_neon_end()` in the checksum path — or so they thought. A refactoring pass moved some of the checksum logic into a helper function called from a workqueue. In that helper, `kernel_neon_begin()` was present, but an early-return error path skipped `kernel_neon_end()`.

The kernel was running on an ARMv8.2 platform with SVE support. Several userspace threads were using SVE for BLAS routines in a scientific computing workload.

### What Happened

On a heavily loaded system, a userspace thread using SVE would occasionally produce wrong numerical results — not crashes, not NaN, just subtly incorrect floating-point outputs that only showed up when comparing against a reference implementation.

The mechanism was subtle:

1. A userspace SVE thread is running in EL0. The `TIF_SVE` flag in its `thread_info` is set, indicating SVE state is live and must be preserved across context switches.
2. The Linux kernel uses **lazy save/restore** for FP/SIMD state. It does not unconditionally save the FPSIMD/SVE registers on every kernel entry. Instead, `CPACR_EL1.FPEN` is used as a trap gate: when the kernel wants to deny a task's FP state from being touched, it clears `FPEN`, causing any subsequent FPSIMD/SVE instruction to trap to EL1.
3. The workqueue handler ran in a softirq context on the same CPU. The early-return path skipped `kernel_neon_end()`, which meant `CPACR_EL1.FPEN` was left in the "enabled" state, and the kernel's internal accounting of "NEON is in use by the kernel" was lost.
4. When the userspace SVE task was scheduled back in, `fpsimd_restore_current_state()` checked the lazy-save bookkeeping and concluded the SVE registers were still valid — it skipped the restore. But the workqueue had already clobbered the FPSIMD register file. The userspace task resumed with wrong vector register contents.

The key registers and functions:

- `TIF_SVE` — thread flag indicating SVE state is valid and must be saved/restored
- `CPACR_EL1.FPEN` (bits 21:20) — controls FP/SVE trap to EL1; `0b01` traps SVE, `0b11` allows both FPSIMD and SVE
- `fpsimd_save_state()` / `fpsimd_load_state()` — low-level save/restore of the FPSIMD register file
- `kernel_neon_begin()` — saves userspace FPSIMD/SVE context if needed, enables NEON for kernel use, disables preemption
- `kernel_neon_end()` — restores accounting state, re-enables preemption

```c
/* WRONG: early return skips kernel_neon_end() */
static int checksum_block(struct request *rq)
{
    int ret;

    kernel_neon_begin();

    ret = validate_header(rq);
    if (ret < 0)
        return ret;   /* BUG: kernel_neon_end() not called */

    do_neon_checksum(rq);
    kernel_neon_end();
    return 0;
}

/* CORRECT: every return path calls kernel_neon_end() */
static int checksum_block(struct request *rq)
{
    int ret;

    kernel_neon_begin();

    ret = validate_header(rq);
    if (ret < 0)
        goto out;

    do_neon_checksum(rq);
out:
    kernel_neon_end();
    return ret;
}
```

### Diagnosis

The bug was silent and non-deterministic. Diagnosis steps:

1. **Reproduce with a stress test**: run the SVE userspace workload alongside heavy I/O to trigger the workqueue path frequently.
2. **Add assertions**: instrument `kernel_neon_end()` calls by checking that preemption is still disabled (as `kernel_neon_begin()` disables it) — a mismatch signals a missed `kernel_neon_end()`.
3. **Tracing**: add `ftrace` hooks around `fpsimd_save_state()` and `fpsimd_load_state()` to log which task context they run in; a restore that does not follow a save on the same CPU is the smoking gun.
4. **`WARN_ON` in scheduler**: the kernel's `fpsimd_thread_switch()` path (called from `__switch_to()`) can be instrumented to check that the NEON-in-kernel state is clean at switch time.

### Fix

Ensure every kernel code path that calls `kernel_neon_begin()` has a matching `kernel_neon_end()` on all exit paths. A common pattern is the `goto out` idiom shown above. If the NEON usage can fail partway through, keep `kernel_neon_end()` in a single cleanup label.

For longer kernel NEON paths: preemption is disabled between `kernel_neon_begin()` and `kernel_neon_end()`, so keep the NEON critical section as short as possible. Do not block, sleep, or call any function that might schedule inside this window.

### Lesson

ARM64's lazy FPSIMD/SVE save/restore makes kernel NEON use efficient, but the correctness contract is strict: `kernel_neon_begin()` and `kernel_neon_end()` must be perfectly paired. Missing a `kernel_neon_end()` breaks the kernel's accounting without any immediate fault — the corruption only appears later when a userspace task resumes with a clobbered register file. Code review must treat these pairs as carefully as mutex lock/unlock.

---

## 2. The Missing DSB Before TLBI

### Setup

A driver for a custom DMA remapping engine maintained its own set of page table entries to map device-visible buffers into a restricted VA space. When a buffer was replaced, the driver updated the PTE, then called `flush_tlb_range()` to shoot down stale TLB entries on all CPUs. The code was written by an engineer with x86 experience and tested on a single-core development board before being deployed to a 16-core ARM64 server.

### What Happened

On the 16-core system, about once every few hours, a CPU would take a fault on an address that should have been remapped. The fault was a translation fault at the new VA — the MMU page table walker was fetching a stale PTE that pointed to the old physical page, which had already been freed.

The root cause was a missing `dsb(ishst)` between the PTE write and the TLBI instruction.

ARM64 has a **weak memory model**. A store to a PTE is a normal memory write. The TLB invalidate (`TLBI` instruction) is a broadcast operation that signals other CPUs' TLBs to flush the entry. But the ARM architecture only guarantees that the TLBI takes effect with respect to TLB entries — it does **not** guarantee that a preceding PTE store is visible to another CPU's MMU walker before the TLBI completes on that CPU, unless a `DSB` (Data Synchronization Barrier) is issued first.

The required sequence for a PTE update on ARM64 is:

```
1. Write the new PTE to memory                 (str  x1, [x0])
2. DSB ISHST — Inner Shareable Store barrier    (dsb  ishst)
   Ensures the PTE store is globally visible
   to all MMU page table walkers before TLBI
3. Issue TLBI for the affected VA range         (TLBI ASIDE1IS / VAAE1IS / etc.)
4. DSB ISH — Inner Shareable barrier            (dsb  ish)
   Ensures the TLBI has completed on all CPUs
5. ISB — Instruction Synchronization Barrier    (isb)
   Ensures subsequent instructions fetch from
   updated mappings
```

The driver's code, expressed at the C level:

```c
/* WRONG: no DSB between PTE write and TLB flush */
static void remap_buffer(struct my_dev *dev, unsigned long va,
                         phys_addr_t new_pa)
{
    pte_t *ptep = lookup_pte(dev, va);
    set_pte(ptep, pfn_pte(new_pa >> PAGE_SHIFT, PAGE_KERNEL));
    /* Missing: dsb(ishst) here */
    flush_tlb_range(&dev->vma, va, va + PAGE_SIZE);
}

/* CORRECT: barrier ensures PTE store is visible before TLBI */
static void remap_buffer(struct my_dev *dev, unsigned long va,
                         phys_addr_t new_pa)
{
    pte_t *ptep = lookup_pte(dev, va);
    set_pte(ptep, pfn_pte(new_pa >> PAGE_SHIFT, PAGE_KERNEL));
    dsb(ishst);   /* ARM64: store barrier before TLBI broadcast */
    flush_tlb_range(&dev->vma, va, va + PAGE_SIZE);
    /* flush_tlb_range issues dsb(ish) + isb internally on ARM64 */
}
```

Why did it work on x86? x86 uses **Total Store Order (TSO)**: all store operations are visible to other processors in program order before any subsequent serializing instruction (like the `INVLPG` or IPI used for TLB shootdown). TSO gives the DSB-equivalent for free. ARM64's relaxed model does not.

Why did it work on a single core? With one CPU, there is no other MMU walker to race with. The local TLB invalidate sees the updated PTE from the local store buffer.

### Diagnosis

1. **Intermittent translation faults** at addresses that should be valid; `dmesg` shows `do_page_fault` for kernel addresses.
2. The fault VA matches a recently remapped region, and the physical address in the stale PTE matches the old mapping.
3. Narrow down by adding `dsb(ishst)` as a diagnostic and observing that the fault rate drops to zero.
4. Review all driver PTE-update paths against the ARM ARM (Architecture Reference Manual) required sequence for "break-before-make" and PTE updates.

### Fix

Insert `dsb(ishst)` between PTE writes and any TLBI or `flush_tlb_*` call. In most cases, drivers should not be manipulating PTEs directly — using the kernel's `remap_pfn_range()`, `vm_insert_page()`, or `io_remap_pfn_range()` handles barriers correctly. If direct PTE manipulation is unavoidable, follow the full ARM64 sequence explicitly.

### Lesson

The ARM64 memory model requires explicit store barriers before TLB invalidates. Code ported from x86 or tested only on uniprocessor systems will appear to work, then fail under load on multi-core ARM64. The `dsb(ishst)` before TLBI is not a performance hint — it is architecturally required for correctness.

---

## 3. The Cache Coherency Trap: DMA from a Non-Coherent Device

### Setup

An embedded SoC (a custom ARM64 board for industrial control) had a PCIe endpoint with a proprietary DMA engine. Unlike commodity PCIe cards that participate in cache snooping via PCIe's MESIF coherency protocol, this DMA engine accessed DRAM directly through the SoC's bus fabric — bypassing CPU cache snooping entirely. The SoC datasheet documented this, but the driver author assumed that "PCIe = cache coherent" and wrote the driver accordingly.

### What Happened

The driver allocated a transmit buffer with `kmalloc()`, filled it with packet data, then programmed the DMA engine to read the buffer and transmit it over the custom fabric link. The device would occasionally transmit zeros or stale data instead of the intended packet contents.

The sequence:

1. `kmalloc()` returns a pointer to a kernel virtual address backed by a physical page. The buffer is **cacheable** — the CPU's L1/L2 cache is enabled for this region.
2. The driver writes packet data into the buffer. These writes go into the CPU's L1 (and possibly L2) cache. They may not yet have been written back (flushed) to DRAM.
3. The driver writes the physical address of the buffer into the DMA engine's descriptor register.
4. The DMA engine fetches data from DRAM — bypassing CPU caches — and reads zeros or old values because the CPU's writes are still sitting in cache.

The fix the DMA API provides:

```c
/* WRONG: using kmalloc buffer directly for non-coherent DMA */
static int bad_driver_tx(struct my_dev *dev, void *data, size_t len)
{
    void *buf = kmalloc(len, GFP_KERNEL);
    memcpy(buf, data, len);
    /* CPU writes are in cache; device will read stale DRAM */
    program_dma(dev, virt_to_phys(buf), len, DMA_TO_DEVICE);
    return 0;
}

/* CORRECT: use dma_map_single() which flushes cache on non-coherent arches */
static int good_driver_tx(struct my_dev *dev, void *data, size_t len)
{
    void *buf = kmalloc(len, GFP_KERNEL);
    dma_addr_t dma_addr;

    memcpy(buf, data, len);

    dma_addr = dma_map_single(dev->dev, buf, len, DMA_TO_DEVICE);
    if (dma_mapping_error(dev->dev, dma_addr)) {
        kfree(buf);
        return -EIO;
    }
    /* dma_map_single() with DMA_TO_DEVICE flushes (clean+invalidate)
     * the affected cache lines on non-coherent platforms.
     * On ARM64 this issues: dc civac (Data Cache Clean and Invalidate
     * by VA to PoC) for each cache line in the buffer. */
    program_dma(dev, dma_addr, len, DMA_TO_DEVICE);
    return 0;
}
```

For buffers that the **device writes** and the **CPU reads** (`DMA_FROM_DEVICE`), the inverse applies: after DMA completes, `dma_unmap_single()` (or `dma_sync_single_for_cpu()`) must invalidate the cache lines so the CPU does not read stale cached data instead of what the device wrote to DRAM.

For frequently used shared buffers, `dma_alloc_coherent()` is the right tool — it allocates memory mapped as non-cacheable (or with cache-bypassing attributes), so neither side needs explicit flush/invalidate calls:

```c
/* Best for rings/descriptors: allocate as coherent from the start */
buf = dma_alloc_coherent(dev->dev, size, &dma_addr, GFP_KERNEL);
/* CPU and device both see a consistent view; no flush needed */
```

Whether a device requires explicit cache management depends on `dev->dma_coherent` (set from DT or ACPI describing the platform's coherency fabric) or the presence of an IOMMU that provides snooping. On platforms with a fully coherent interconnect, `dma_map_single()` is a no-op for cache management; on non-coherent platforms it does the necessary `dc civac` sequence.

### Diagnosis

1. Device transmits wrong data — zeros, old values, or garbage — not random corruption.
2. The bug is **consistent at low speed** (cache lines always flushed before the race) and **worse under load** (cache lines less likely to have been evicted naturally).
3. A temporary workaround: mark the buffer memory as non-cacheable using `pgprot_noncached()` or `pgprot_writecombine()` — if the bug disappears, cache coherency is confirmed as the cause.
4. Check the SoC TRM (Technical Reference Manual) and Linux DTS for `dma-coherent` property on the device node.
5. Audit all `virt_to_phys()` calls in the driver — any direct physical address use that bypasses `dma_map_*` is a red flag on a non-coherent platform.

### Fix

Replace all direct `virt_to_phys()` + register programming with the DMA API (`dma_map_single()` / `dma_unmap_single()` or `dma_alloc_coherent()`). Ensure the device node in the DTS does **not** have `dma-coherent` unless the hardware actually supports it. For descriptor rings and control structures, use `dma_alloc_coherent()`.

### Lesson

Cache coherency is not guaranteed for all DMA-capable devices, even on sophisticated SoCs. The Linux DMA API exists precisely to abstract the coherency requirement: it is a no-op on coherent platforms and does the right cache operations on non-coherent ones. Using `virt_to_phys()` directly instead of `dma_map_single()` is always wrong in a portable driver — it fails silently on non-coherent hardware.

---

## 4. The BTI Enforcement Crash in a JIT Compiler

### Setup

A language runtime embedded in a container orchestration agent generated native ARM64 code at runtime to evaluate policy expressions. The JIT compiled policy rules to machine code, mapped the code with `mmap(PROT_READ | PROT_EXEC)`, then called into it via a function pointer. The system was a modern ARM64 server running a distribution kernel compiled with BTI (Branch Target Identification) support.

### What Happened

The runtime crashed with a signal, `dmesg` showed:

```
[12345.678] traps: agent[4321] proc violation BTI pc=0x7f3a0000 addr=0x7f3a0000
```

The crash occurred precisely when the runtime invoked the JIT-compiled function pointer. BTI (ARMv8.5-A) protection was rejecting the indirect branch into the JIT code.

**How BTI works:**

BTI adds a new mechanism to enforce that indirect branches (calls via function pointer, `blr`, `br`) may only land on designated landing pad instructions. It is controlled by:

- `SCTLR_EL1.BT0` — enables BTI enforcement for EL0 (userspace)
- `SCTLR_EL1.BT1` — enables BTI enforcement for EL1 (kernel)
- The `BTYPE` field in `PSTATE` — tracks what type of branch was just taken (none / call / jump)

When an indirect branch is executed, the CPU sets `BTYPE` to record the branch type. The instruction at the landing address must be one of:

- `BTI c` — landing pad for calls (`blr`, `bl` indirect)
- `BTI j` — landing pad for jumps (`br`, `b` indirect)
- `BTI jc` — landing pad for both
- `NOP` — only valid in some configurations

If the landing address does not have the correct `BTI` instruction, the CPU raises a Branch Target Exception. The ESR_EL1 encodes this as EC=`0x24` (data abort from current EL) or EC=`0x11` (SVC) — specifically, the `BTYPE` field in ESR indicates a BTI failure (ISS `DFSC` value `0b100100`).

The kernel enables BTI for a process when the ELF binary has the `GNU_PROPERTY_AARCH64_FEATURE_1_BTI` bit set in its `.note.gnu.property` section. You can check this:

```bash
readelf -n /usr/bin/agent | grep -A2 "AArch64 Instruction Set Architecture"
# Output shows: BTI enabled
```

The language runtime's main binary had BTI declared and enabled. Its JIT emitter, however, generated raw ARM64 instructions without any `BTI` preamble:

```c
/* WRONG: JIT prologue missing BTI landing pad */
static void emit_function_prologue(struct jit_ctx *ctx)
{
    /* First instruction emitted is the actual function body */
    emit(ctx, STP_X29_X30_SP_M16);  /* stp x29, x30, [sp, #-16]! */
    emit(ctx, MOV_X29_SP);          /* mov x29, sp                 */
    /* ... rest of function */
}

/* CORRECT: emit BTI c as first instruction */
static void emit_function_prologue(struct jit_ctx *ctx)
{
    emit(ctx, BTI_C);               /* bti c  — call landing pad   */
    emit(ctx, STP_X29_X30_SP_M16); /* stp x29, x30, [sp, #-16]!   */
    emit(ctx, MOV_X29_SP);          /* mov x29, sp                  */
    /* ... rest of function */
}
```

The encoding of `BTI c` is `0xd503245f` (a hint-space instruction). `BTI j` is `0xd503249f`. `BTI jc` is `0xd50324df`.

Note that BTI enforcement only applies to **pages mapped with** `PROT_BTI` (via `mprotect()`) or to the main executable and its shared libraries when the BTI ELF note is present. If the JIT maps memory with only `PROT_READ | PROT_EXEC`, BTI enforcement may not apply to that region — but if the runtime's own executable is BTI-enabled and uses an indirect call (`blr`) to reach JIT code, the CPU still enforces the BTI requirement at the landing address if the process was started with BTI enabled.

### Diagnosis

1. The crash backtrace points to the instruction immediately after `blr xN` where `xN` holds the JIT code address.
2. Decode the ESR_EL1 from the signal info or `dmesg`: `EC=0x24`, ISS indicates BTI failure.
3. Inspect the first 4 bytes of the JIT buffer: they should be `5f 24 03 d5` (`bti c`) but instead show the first instruction of the function body.
4. Confirm BTI is active: `grep BTI /proc/$(pidof agent)/smaps` or check `/proc/cpuinfo` for `bti` in the Features line.
5. Verify the binary's BTI note: `readelf -n /usr/bin/agent`.

### Fix

The JIT emitter must emit `BTI c` as the very first instruction of every function entry point that may be reached via an indirect call (`blr`). For jump tables and indirect `br` targets, emit `BTI j` instead. The change is a single-word addition to the function prologue emitter.

If a JIT targets a mixed environment (some callers may be BTI-unaware), `BTI jc` at all entry points provides maximum compatibility.

For the `mmap` region, calling `mprotect(buf, size, PROT_READ | PROT_EXEC | PROT_BTI)` opts the JIT pages into BTI enforcement explicitly (Linux 5.8+), which also enables the kernel to audit the code before execution.

### Lesson

BTI is a forward-edge CFI (Control Flow Integrity) mechanism baked into ARMv8.5. When a process binary declares BTI support, the kernel enforces landing pad requirements for all indirect branches — including branches into runtime-generated code. JIT compilers, eBPF back-ends, and FFI stubs must all be updated to emit `BTI c` / `BTI j` preambles. This is a one-instruction fix, but it requires explicit awareness of the BTI ABI.

---

## 5. The Erratum Workaround with the Wrong MIDR Range

### Setup

A SoC vendor shipped a line of ARM Cortex-A55 based processors. Revision r0p2 of the core had an erratum in its speculative prefetcher: under specific conditions, a spurious prefetch could generate a fault for an address that was not actually being accessed, causing a kernel oops. The upstream kernel fix applied a workaround by disabling the prefetcher via an implementation-defined register when the erratum was detected.

A downstream vendor kernel team backported this fix. The erratum workaround was conditional on the MIDR_EL1 value — it should apply to r0p0, r0p1, and r0p2 of the affected core. However, the backport had a transcription error: the revision range in the errata table covered only r0p0 and r0p1.

### What Happened

Production devices, which shipped with r0p2 silicon, hit spurious kernel faults under memory pressure. The fault address was always unmapped, the fault was non-reproducible from userspace, and it appeared deep in `do_page_fault` on a kernel address that was provably mapped.

**The MIDR_EL1 register format:**

```
Bits [31:24] — Implementer  (e.g., 0x41 = ARM)
Bits [23:20] — Variant      (major revision, e.g., 0 = r0)
Bits [19:16] — Architecture (0xf = ARMv8)
Bits [15:4]  — Part number  (e.g., 0xD05 = Cortex-A55)
Bits [3:0]   — Revision     (minor revision, e.g., 2 = p2)
```

The `MIDR_CPU_MODEL()` macro matches on implementer and part number. The errata entry in the `arm64_errata[]` table specifies a revision range via the `midr_range` structure (first and last MIDR values, encoding variant and revision). The incorrect backport:

```c
/* WRONG: range ends at r0p1 (revision = 1), misses r0p2 */
static const struct midr_range affected_range[] = {
    MIDR_RANGE(MIDR_CORTEX_A55, 0, 0, 0, 1),
    /* variant_min=0, revision_min=0, variant_max=0, revision_max=1 */
};

/* CORRECT: range must include r0p2 (revision = 2) */
static const struct midr_range affected_range[] = {
    MIDR_RANGE(MIDR_CORTEX_A55, 0, 0, 0, 2),
    /* variant_min=0, revision_min=0, variant_max=0, revision_max=2 */
};
```

At boot, the kernel iterates `arm64_errata[]` and calls the `matches` function for each entry. If the current CPU's MIDR falls within the declared range, the erratum is applied and a boot message is printed:

```
[    0.000000] CPU features: detected: Workaround for Cortex-A55 erratum 1530923
```

On the affected r0p2 devices, no such message appeared — a clear sign the workaround was not active.

To read the MIDR of a running system:

```bash
cat /sys/devices/system/cpu/cpu0/regs/identification/midr_el1
# e.g., 0x0000000041AF5402
#               ^^ ^^^^ ^^
#               |  |    |--- revision (2 = p2)
#               |  |-------- part (D05 = Cortex-A55, stored as 0xd05 in bits 15:4)
#               |------------ implementer (0x41 = ARM)
```

The revision field (`bits[3:0]`) read as `2` (p2), but the erratum table's range only went to `1` (p1) — a one-off error.

### Diagnosis

1. **Spurious kernel faults** on an address that is mapped; fault is non-deterministic and load-dependent.
2. Check whether the erratum workaround boot message appears: `dmesg | grep -i erratum` or `dmesg | grep -i workaround`.
3. Read `midr_el1` from sysfs: `cat /sys/devices/system/cpu/cpu0/regs/identification/midr_el1`. Decode the revision field.
4. Cross-reference the silicon revision against the errata table in the kernel source. Check `arch/arm64/kernel/cpu_errata.c` (or the vendor equivalent) for the MIDR range.
5. On debug kernels, `/sys/kernel/debug/cpu_features` or `/sys/kernel/debug/arm64_cpu_features` may list active workarounds.
6. Confirm by patching the range to include r0p2, reboot, and verify the workaround message appears and spurious faults cease.

### Fix

Widen the MIDR revision range to include all affected silicon revisions. After the fix, verify with a production r0p2 device that the boot message appears. Add a comment referencing the errata ID and the affected revision range explicitly so future backports are easier to audit:

```c
/* Workaround for Cortex-A55 erratum NNNNNN.
 * Affected: r0p0, r0p1, r0p2.
 * See ARM erratum document ID NNNNNN, revision C. */
static const struct midr_range affected_range[] = {
    MIDR_RANGE(MIDR_CORTEX_A55, 0, 0, 0, 2),
};
```

### Lesson

Errata workarounds are safety-critical: an off-by-one in a MIDR revision range silently leaves devices unprotected. Every backport of an erratum fix must be validated against the actual silicon revision deployed in the target hardware. Reading `midr_el1` from sysfs is a one-line check that should be part of any bringup checklist. Boot-time messages confirming erratum activation are a valuable diagnostic signal — their absence is a warning.

---

## Summary

| # | Bug | Root cause | Detection method | ARM64-specific? |
|---|-----|-----------|-----------------|----------------|
| 1 | SVE context switch corruption | Unmatched `kernel_neon_begin/end` breaks lazy FP save accounting | Userspace numerical errors; ftrace on fpsimd paths | Yes — lazy FPSIMD/SVE save is ARM64-specific |
| 2 | Stale PTE after TLBI | Missing `dsb(ishst)` before TLB invalidate | Intermittent translation faults on recently remapped VA | Yes — ARM64 weak ordering; x86 TSO hides this |
| 3 | Device reads stale DMA data | Non-coherent DMA without cache flush | Device transmits zeros; confirmed with `pgprot_noncached` | Partly — non-coherent DMA exists on other arches but common on embedded ARM64 |
| 4 | BTI enforcement crash | JIT code missing `BTI c` landing pad instruction | SIGSEGV with ESR EC=0x24 BTI failure | Yes — ARMv8.5 BTI is ARM64-specific |
| 5 | Erratum workaround not applied | MIDR revision range off-by-one in errata table | Spurious faults; no erratum boot message; `midr_el1` sysfs | Yes — ARM64 MIDR-based errata infrastructure |

---

## Further Reading

- [Exception Model](exception-model.md) — EL0-EL3, ESR_EL1 syndrome decoding, SCTLR_EL1 control bits
- [Memory Model](memory-model.md) — Weak ordering, DSB/ISB/DMB barriers, load-acquire/store-release
- [Page Tables](page-tables.md) — PTE format, TLB management, `flush_tlb_range()` internals
- [CPU Features](cpu-features.md) — Feature detection, MIDR_EL1 format, `arm64_errata[]` infrastructure, SVE/BTI/MTE capability probing
- [Spectre and Meltdown](spectre-meltdown.md) — Speculative execution, erratum-driven mitigations, SMCCC firmware interfaces
