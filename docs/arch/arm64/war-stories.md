# ARM64 War Stories

> Cache coherency bugs, TLB shootdown ordering, BTI enforcement, and SVE context corruption

Each story follows a real bug class rooted in ARM64 architecture specifics — weak memory ordering, hardware coherency requirements, CPU feature enforcement, and errata handling.

!!! note "How these are written"
    These aren't write-ups of a single named incident tied to one commit or CVE — they're realistic scenarios built from failure patterns that actually occur on ARM64 systems. Names and products are illustrative; the failure modes are real. The references at the end of the page verify the underlying ARM64 mechanisms each case relies on (lazy/context-switched FPSIMD state, TLB/barrier ordering, MIDR-based errata matching, BTI enforcement) against current kernel source and architecture documentation. See the [BPF](../../bpf/war-stories.md), [scheduler](../../sched/war-stories.md), or [interrupts](../../interrupts/war-stories.md) war-stories pages for the site's usual format: specific, datable incidents, most (though not all — see [wake_wide()](../../sched/war-stories/wake-wide-heuristic.md)) tied to a fix commit or CVE.

---

## 1. The SVE Context Switch Bug

### Setup

A storage driver was optimized to use SIMD to accelerate CRC32 checksums on data blocks during I/O completion. The developer correctly called `kernel_neon_begin()` and `kernel_neon_end()` in the checksum path — or so they thought. A refactoring pass moved some of the checksum logic into a helper function called from a workqueue. In that helper, `kernel_neon_begin()` was present, but an early-return error path skipped `kernel_neon_end()`.

The kernel was running on an ARMv8.2 platform with SVE support. Several userspace threads were using SVE for BLAS routines in a scientific computing workload, and the storage driver's checksum work ran on the same CPUs under heavy load.

### What Happened

On a heavily loaded system, kworker threads doing checksum work would occasionally corrupt seemingly unrelated local state a few calls later — a garbled local variable, or in the worst cases a corrupted return address leading to a crash with a backtrace that made no sense. The corruption was silent at the point it happened and only surfaced later, in different code entirely.

The mechanism, once found:

1. A kernel function calling `kernel_neon_begin()` from process or softirq context (like this workqueue handler) must supply a caller-owned buffer — `struct user_fpsimd_state`, typically declared on the stack — because kernel-mode NEON use in these contexts is **preemptible**, not run with preemption held off for the duration. `kernel_neon_begin(&state)` records that buffer in `current->thread.kernel_fpsimd_state` and sets the `TIF_KERNEL_FPSTATE` thread flag, so that if this task is scheduled out while it still "owns" the NEON registers, the scheduler knows how to save and restore that state across the switch.
2. `kernel_neon_end(&state)` is the other half of that contract: it clears `TIF_KERNEL_FPSTATE` and resets `current->thread.kernel_fpsimd_state` to `NULL`, telling the scheduler this task no longer has live kernel-mode NEON state to preserve.
3. The early-return path skipped `kernel_neon_end()`. The function returned — unwinding the stack frame that held `state` — while `TIF_KERNEL_FPSTATE` was still set and `current->thread.kernel_fpsimd_state` still pointed at that now-dead stack address.
4. If this kworker thread was preempted before anything cleared that state, `fpsimd_thread_switch()` (called from `__switch_to()`) saw `TIF_KERNEL_FPSTATE` set and called `fpsimd_save_kernel_state(current)`, which writes the live NEON register contents into `*current->thread.kernel_fpsimd_state` — the stale stack address. By then, that stack region had very likely been reused by whatever the kworker thread called next, so the write silently clobbered a local variable, a saved register, or a return address belonging to completely different code.

The key registers and functions (`arch/arm64/kernel/fpsimd.c`):

- `TIF_KERNEL_FPSTATE` — thread flag marking that this task's kernel-mode FPSIMD/NEON state must be saved and restored across a context switch
- `current->thread.kernel_fpsimd_state` — pointer to the caller-provided buffer backing that state; set by `kernel_neon_begin()`, cleared by `kernel_neon_end()`
- `get_cpu_fpsimd_context()` / `put_cpu_fpsimd_context()` — a brief `local_bh_disable()`/`local_bh_enable()` pair (or `preempt_disable()`/`preempt_enable()` under `CONFIG_PREEMPT_RT`) held only while `kernel_neon_begin()`/`kernel_neon_end()` update this bookkeeping — not held for the whole NEON critical section
- `fpsimd_thread_switch()` — called from `__switch_to()`; if the outgoing task has `TIF_KERNEL_FPSTATE` set, calls `fpsimd_save_kernel_state()`, which saves into `task->thread.kernel_fpsimd_state`

```c
/* WRONG: early return skips kernel_neon_end(), leaving kernel_fpsimd_state
 * pointing at &state after this stack frame is gone */
static int checksum_block(struct request *rq)
{
    struct user_fpsimd_state state;
    int ret;

    kernel_neon_begin(&state);

    ret = validate_header(rq);
    if (ret < 0)
        return ret;   /* BUG: kernel_neon_end() not called */

    do_neon_checksum(rq);
    kernel_neon_end(&state);
    return 0;
}

/* CORRECT: every return path calls kernel_neon_end() before the
 * stack-allocated state buffer goes out of scope */
static int checksum_block(struct request *rq)
{
    struct user_fpsimd_state state;
    int ret;

    kernel_neon_begin(&state);

    ret = validate_header(rq);
    if (ret < 0)
        goto out;

    do_neon_checksum(rq);
out:
    kernel_neon_end(&state);
    return ret;
}
```

### Diagnosis

The bug was silent and non-deterministic, and the corruption surfaced far from its cause. Diagnosis steps:

1. **Reproduce with a stress test**: run the checksum workload under heavy load so this kworker thread is frequently preempted while its stack still holds a live (but abandoned) `kernel_fpsimd_state` pointer.
2. **Add an assertion**: audit every return path out of a `kernel_neon_begin()`-protected function for a matching `kernel_neon_end()`; a task that returns to userspace, blocks for a long time, or exits while `TIF_KERNEL_FPSTATE` is still set has leaked the pairing.
3. **Tracing**: add `ftrace` hooks around `kernel_neon_begin()`/`kernel_neon_end()` to log call sites and their `state` pointers; a `begin` whose `state` address never shows up in a matching `end` on the same task is the smoking gun.
4. **KASAN/stack-protector signal**: since the corrupted memory is a reused stack slot, a stack-protector canary failure or a KASAN stack-out-of-bounds report in a completely unrelated function on the same kworker is consistent with this bug — don't assume the crash site is the bug site.

### Fix

Ensure every kernel code path that calls `kernel_neon_begin()` has a matching `kernel_neon_end()` on all exit paths, using the same `state` buffer on both calls. A common pattern is the `goto out` idiom shown above. If the NEON usage can fail partway through, keep `kernel_neon_end()` in a single cleanup label.

Kernel NEON use guarded this way is preemptible on non-`PREEMPT_RT` kernels — that's the reason a caller-provided buffer is required in process/softirq context in the first place. Don't assume preemption is held off for the whole region between `kernel_neon_begin()` and `kernel_neon_end()`; the only thing briefly held off is the internal bookkeeping update inside those two calls themselves.

### Lesson

ARM64's context-switchable kernel-mode NEON state makes kernel NEON use both efficient and preemptible, but the correctness contract is strict: `kernel_neon_begin()` and `kernel_neon_end()` must be perfectly paired, using the same caller-owned buffer. Missing a `kernel_neon_end()` doesn't fail immediately — it leaves a dangling pointer in `current->thread.kernel_fpsimd_state` that only causes damage on the next context switch, and the damage lands wherever the stack happens to be reused, not at the site of the bug. Code review must treat these pairs as carefully as mutex lock/unlock — more so, since the failure mode here is a wild write, not a deadlock.

---

## 2. The Missing DSB Before TLBI

!!! note "This one is now historical"
    As of Linux 6.16, `set_pte()` itself calls `queue_pte_barriers()`/`emit_pte_barriers()` — `dsb(ishst); isb();` — automatically for any valid, non-user PTE (confirmed by tag-diff: absent in `arch/arm64/include/asm/pgtable.h` at v6.15, present at v6.16). The specific bug below, reached through the ordinary `set_pte()` helper the driver uses, cannot happen on a 6.16+ kernel. It's included because the underlying ordering rule is still real and still binds any code that bypasses `set_pte()` — a driver-maintained page-table format for an IOMMU or accelerator with its own PTE layout, for instance — and because the "why did this only show up on a 16-core server" reasoning below hasn't changed.

### Setup

A driver for a custom DMA remapping engine maintained its own set of page table entries to map device-visible buffers into a restricted VA space, predating Linux 6.16's automatic PTE barrier batching. When a buffer was replaced, the driver updated the PTE, then called `flush_tlb_range()` to shoot down stale TLB entries on all CPUs. The code was written by an engineer with x86 experience and tested on a single-core development board before being deployed to a 16-core ARM64 server.

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

Insert `dsb(ishst)` between PTE writes and any TLBI or `flush_tlb_*` call. In most cases, drivers should not be manipulating PTEs directly — using the kernel's `remap_pfn_range()`, `vm_insert_page()`, or `io_remap_pfn_range()` handles barriers correctly, and as of Linux 6.16 even a direct `set_pte()` call handles this specific ordering automatically. If a driver maintains its own page-table format entirely outside the generic `set_pte()`/`pte_t` machinery — an IOMMU or accelerator with a private table layout — none of that automatic handling applies, and the full ARM64 sequence must still be followed explicitly.

### Lesson

The ARM64 memory model requires explicit store barriers before TLB invalidates. Code ported from x86 or tested only on uniprocessor systems will appear to work, then fail under load on multi-core ARM64. The `dsb(ishst)` before TLBI is not a performance hint — it is architecturally required for correctness, for any page-table format the generic kernel PTE helpers don't already cover.

---

## 3. The Cache Coherency Trap: DMA from a Non-Coherent Device

### Setup

An embedded SoC (a custom ARM64 board for industrial control) had a PCIe endpoint with a proprietary DMA engine. Unlike commodity PCIe cards, whose reads and writes are ordinarily kept coherent because the root complex snoops the CPU caches on their behalf (with a device able to opt out per-transaction via the PCIe "No Snoop" TLP attribute), this DMA engine accessed DRAM directly through the SoC's bus fabric — bypassing that snooping path entirely. The SoC datasheet documented this, but the driver author assumed that "PCIe = cache coherent" and wrote the driver accordingly.

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
    /* dma_map_single() with DMA_TO_DEVICE cleans (but does not invalidate)
     * the affected cache lines on non-coherent platforms.
     * On ARM64 this issues: dc cvac (Data Cache Clean by VA to PoC)
     * for each cache line in the buffer — clean only, not clean+invalidate. */
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

Whether a device requires explicit cache management depends on `dev->dma_coherent` (set from DT or ACPI describing the platform's coherency fabric) or the presence of an IOMMU that provides snooping. On platforms with a fully coherent interconnect, `dma_map_single()` is a no-op for cache management; on non-coherent platforms it does the necessary `dc cvac` sequence.

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

A language runtime embedded in a container orchestration agent generated native ARM64 code at runtime to evaluate policy expressions. The JIT deliberately mapped its generated code with `mmap(PROT_READ | PROT_EXEC | PROT_BTI)` — opting the pages into BTI (Branch Target Identification) enforcement on purpose, for the security benefit of blocking arbitrary indirect-branch landing points into JIT-emitted code. The system was a modern ARM64 server running a distribution kernel compiled with BTI support.

### What Happened

The runtime crashed with a signal. `dmesg` showed:

```
agent[4321]: unhandled exception: BTI, ESR 0x0000000034000002, undefined instruction in agent[7f3a0000+1000]
```

The crash occurred precisely when the runtime invoked the JIT-compiled function pointer. BTI (ARMv8.5-A) protection was rejecting the indirect branch into the JIT code, because the JIT itself had opted its pages into that enforcement.

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

If the landing address does not have the correct `BTI` instruction, the CPU raises a Branch Target Exception. The ESR_EL1 encodes this with EC=`0x0D` (`ESR_ELx_EC_BTI`), defined in `arch/arm64/include/asm/esr.h`. This is distinct from a data abort (EC=`0x24`) — BTI exceptions have their own exception class and ISS encoding.

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

BTI enforcement is a per-page property, not a whole-process one: it only applies to pages explicitly mapped as "Guarded Pages" (`PTE_GP`), which the kernel sets when a mapping is created or changed with `PROT_BTI` — either directly via `mmap()`/`mprotect()`, as this JIT does, or automatically for the main executable and its shared libraries when the ELF `GNU_PROPERTY_AARCH64_FEATURE_1_BTI` note is present and the whole binary was built BTI-aware. A JIT that maps its generated code with plain `PROT_READ | PROT_EXEC` (no `PROT_BTI`) gets no BTI enforcement on that memory at all, regardless of whether the calling binary itself is BTI-enabled — enforcement follows the target page, not the caller. This JIT asked for that enforcement deliberately, which is exactly what exposed the missing landing pad.

### Diagnosis

1. The crash backtrace points to the instruction immediately after `blr xN` where `xN` holds the JIT code address.
2. Decode the ESR_EL1 from the signal info or `dmesg`: `EC=0x0D` (`ESR_ELx_EC_BTI`), reported by the kernel's `esr_class_str[]` table as `"BTI"`. This raises `SIGILL` with `si_code` `ILL_ILLOPC` (`do_el0_bti()`, `arch/arm64/kernel/traps.c`) — not a segmentation fault, even though the trigger is a branch-target check.
3. Inspect the first 4 bytes of the JIT buffer: they should be `5f 24 03 d5` (`bti c`) but instead show the first instruction of the function body.
4. Confirm the JIT pages are Guarded: `grep -E '^VmFlags.*\bbt\b' /proc/$(pidof agent)/smaps` (the kernel's smaps `VmFlags` token for `VM_ARM64_BTI` is the two-letter `bt`, not the string "BTI") or check `/proc/cpuinfo` for `bti` in the Features line to confirm CPU support.
5. Verify the binary's BTI note: `readelf -n /usr/bin/agent`.

### Fix

The JIT emitter must emit `BTI c` as the very first instruction of every function entry point that may be reached via an indirect call (`blr`). For jump tables and indirect `br` targets, emit `BTI j` instead. The change is a single-word addition to the function prologue emitter.

If a JIT targets a mixed environment (some callers may be BTI-unaware), `BTI jc` at all entry points provides maximum compatibility.

A JIT that instead starts out mapping its code with plain `PROT_READ | PROT_EXEC` can opt into the same enforcement later with `mprotect(buf, size, PROT_READ | PROT_EXEC | PROT_BTI)` (Linux 5.8+) — worth doing deliberately for the security benefit, but only once every code-generation path actually emits the required landing pads first.

### Lesson

BTI is a forward-edge CFI (Control Flow Integrity) mechanism baked into ARMv8.5, and it's enforced per-page, not per-process: only memory explicitly mapped `PROT_BTI` (or, in the common case, a BTI-aware executable's own code and its shared libraries) gets landing-pad checks on indirect branches into it. A JIT that opts its generated code into that enforcement gets a real security benefit — but every code-generation path must then emit `BTI c` / `BTI j` preambles, including runtime-generated code, eBPF back-ends, and FFI stubs. This is a one-instruction-per-function-entry fix, but it requires the JIT to actually know about the BTI ABI before it turns enforcement on.

---

## 5. The Erratum Workaround with the Wrong MIDR Range

!!! note "Deliberately generic hardware"
    This case uses a placeholder core name and part number rather than a real ARM design, specifically so the erratum, MIDR value, and revision range below don't get mapped back onto any real, documented silicon erratum — the mechanism (a MIDR revision range in `arm64_errata[]`) is completely generic and doesn't depend on which real core it's protecting.

### Setup

A SoC vendor licensed an ARM Cortex-family core (referred to here as "MyCore," since the specific real core doesn't matter to the bug). Revision r0p2 of the core had an erratum: under specific conditions, a spurious event in the memory pipeline could generate a fault for an address that was not actually being accessed, causing a kernel oops. The upstream kernel fix applied a workaround via an implementation-defined register when the erratum was detected.

A downstream vendor kernel team backported this fix. The erratum workaround was conditional on the MIDR_EL1 value — it should apply to r0p0, r0p1, and r0p2 of the affected core. However, the backport had a transcription error: the revision range in the errata table covered only r0p0 and r0p1.

### What Happened

Production devices, which shipped with r0p2 silicon, hit spurious kernel faults under memory pressure. The fault address was always unmapped, the fault was non-reproducible from userspace, and it appeared deep in `do_page_fault` on a kernel address that was provably mapped.

**The MIDR_EL1 register format:**

```
Bits [31:24] — Implementer  (e.g., 0x41 = ARM, the design licensor)
Bits [23:20] — Variant      (major revision, e.g., 0 = r0)
Bits [19:16] — Architecture (0xf = ARMv8)
Bits [15:4]  — Part number  (implementation-defined per core design)
Bits [3:0]   — Revision     (minor revision, e.g., 2 = p2)
```

The `MIDR_CPU_MODEL()` macro matches on implementer and part number. The errata entry in the `arm64_errata[]` table specifies a revision range via the `midr_range` structure (first and last MIDR values, encoding variant and revision). The incorrect backport:

```c
/* WRONG: range ends at r0p1 (revision = 1), misses r0p2 */
static const struct midr_range affected_range[] = {
    MIDR_RANGE(MIDR_MYCORE, 0, 0, 0, 1),
    /* variant_min=0, revision_min=0, variant_max=0, revision_max=1 */
};

/* CORRECT: range must include r0p2 (revision = 2) */
static const struct midr_range affected_range[] = {
    MIDR_RANGE(MIDR_MYCORE, 0, 0, 0, 2),
    /* variant_min=0, revision_min=0, variant_max=0, revision_max=2 */
};
```

At boot, the kernel iterates `arm64_errata[]` and calls the `matches` function for each entry. If the current CPU's MIDR falls within the declared range, the erratum is applied and a boot message is printed in the form the kernel's `arm64_errata[]` entries actually use — `pr_fmt` for this code is `"CPU features: "`, and each entry's `.desc` string reads just `"ARM erratum NNNNNN"` (see e.g. the real, unrelated entries in `arch/arm64/kernel/cpu_errata.c`, which read `"ARM erratum 832075"`, `"ARM erratum 834220"`, and so on — no core name, no "Workaround for" prefix):

```
CPU features: detected: ARM erratum NNNNNN
```

On the affected r0p2 devices, no such message appeared — a clear sign the workaround was not active.

To read the MIDR of a running system:

```bash
cat /sys/devices/system/cpu/cpu0/regs/identification/midr_el1
# e.g., 0x00000000410FFFF2
```

Reading the low 32 bits, `410FFFF2`, against the bit layout above: implementer `0x41` (ARM), variant `0x0` (r0), architecture `0xf` (ARMv8), part number `0xfff` (this core's placeholder part number), revision `0x2` (p2). The revision field (`bits[3:0]`) read as `2` (p2), but the erratum table's range only went to `1` (p1) — a one-off error.

### Diagnosis

1. **Spurious kernel faults** on an address that is mapped; fault is non-deterministic and load-dependent.
2. Check whether the erratum workaround boot message appears: `dmesg | grep -i erratum`. (The kernel's own `.desc` strings for these entries say "ARM erratum ...", not "workaround" — grepping for "workaround" alone won't find it.)
3. Read `midr_el1` from sysfs: `cat /sys/devices/system/cpu/cpu0/regs/identification/midr_el1`. Decode the revision field as shown above.
4. Cross-reference the silicon revision against the errata table in the kernel source. Check `arch/arm64/kernel/cpu_errata.c` (or the vendor equivalent) for the MIDR range.
5. Confirm by patching the range to include r0p2, reboot, and verify the workaround message appears and spurious faults cease.

### Fix

Widen the MIDR revision range to include all affected silicon revisions. After the fix, verify with a production r0p2 device that the boot message appears. Add a comment referencing the errata ID and the affected revision range explicitly so future backports are easier to audit:

```c
/* Workaround for MyCore erratum NNNNNN.
 * Affected: r0p0, r0p1, r0p2.
 * See ARM erratum document ID NNNNNN, revision C. */
static const struct midr_range affected_range[] = {
    MIDR_RANGE(MIDR_MYCORE, 0, 0, 0, 2),
};
```

### Lesson

Errata workarounds are safety-critical: an off-by-one in a MIDR revision range silently leaves devices unprotected. Every backport of an erratum fix must be validated against the actual silicon revision deployed in the target hardware. Reading `midr_el1` from sysfs is a one-line check that should be part of any bringup checklist. Boot-time messages confirming erratum activation are a valuable diagnostic signal — their absence is a warning.

---

## Summary

| # | Bug | Root cause | Detection method | ARM64-specific? |
|---|-----|-----------|-----------------|----------------|
| 1 | Stack corruption on preemption | Unmatched `kernel_neon_begin/end` leaves a dangling `kernel_fpsimd_state` pointer into a dead stack frame | Corruption in unrelated code after the buggy function returns; ftrace on begin/end call sites | Yes — ARM64's context-switchable kernel-mode NEON state is ARM64-specific |
| 2 | Stale PTE after TLBI | Missing `dsb(ishst)` before TLB invalidate | Intermittent translation faults on recently remapped VA | Yes — ARM64 weak ordering; x86 TSO hides this |
| 3 | Device reads stale DMA data | Non-coherent DMA without cache flush | Device transmits zeros; confirmed with `pgprot_noncached` | Partly — non-coherent DMA exists on other arches but common on embedded ARM64 |
| 4 | BTI enforcement crash | JIT code missing `BTI c` landing pad instruction | SIGILL (ILL_ILLOPC) with ESR EC=0x0D (ESR_ELx_EC_BTI) | Yes — ARMv8.5 BTI is ARM64-specific |
| 5 | Erratum workaround not applied | MIDR revision range off-by-one in errata table | Spurious faults; no erratum boot message; `midr_el1` sysfs | Yes — ARM64 MIDR-based errata infrastructure |

---

## Further Reading

- [Exception Model](exception-model.md) — EL0-EL3, ESR_EL1 syndrome decoding, SCTLR_EL1 control bits
- [Memory Model](memory-model.md) — Weak ordering, DSB/ISB/DMB barriers, load-acquire/store-release
- [Page Tables](page-tables.md) — PTE format, TLB management, `flush_tlb_range()` internals
- [CPU Features](cpu-features.md) — Feature detection, MIDR_EL1 format, `arm64_errata[]` infrastructure, SVE/BTI/MTE capability probing
- [Spectre and Meltdown](spectre-meltdown.md) — Speculative execution, erratum-driven mitigations, SMCCC firmware interfaces
- [Documentation/arch/arm64/silicon-errata.rst](https://docs.kernel.org/arch/arm64/silicon-errata.html) — the kernel's list of every worked-around erratum (Case 5's world)
- [arch/arm64/kernel/cpu_errata.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm64/kernel/cpu_errata.c) — MIDR match ranges for erratum workarounds
