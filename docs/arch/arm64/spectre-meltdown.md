# Spectre and Meltdown on ARM64

> Speculative execution vulnerabilities and mitigations

ARM64 has a distinct vulnerability profile from x86. Most ARM64 CPUs are **not** affected by Meltdown, and the dominant Spectre-class concerns are Spectre v1, Spectre v2, Spectre-BHB, and Speculative Store Bypass. The mitigations are implemented in ARM64-specific assembly, system registers, and architectural feature bits rather than the x86 MSR-based mechanisms.

---

## Summary table

| Vulnerability | CVE | Affected ARM64 hardware | Primary mitigation | KPTI needed? |
|---------------|-----|-------------------------|--------------------|--------------|
| Meltdown | CVE-2017-5754 | Cortex-A75 only | KPTI | Yes (A75 only) |
| Spectre v1 | CVE-2017-5753 | All | `array_index_nospec()` | No |
| Spectre v2 | CVE-2017-5715 | Most | CSV2 / IBPB / firmware | No |
| Spectre-BHB | CVE-2022-23960 | Many (A72, A77, A78, …) | CLRBHB / loop / CSV2_3 | No |
| Spectre v4 / SSB | CVE-2018-3639 | CPU-dependent | SSBS register bit | No |

---

## Background: speculative execution and cache side channels

Modern CPUs execute instructions speculatively — they predict which branch will be taken and execute ahead of confirmed program flow. If the prediction is wrong, the speculatively executed results are discarded. The problem: **side effects in the cache are not discarded**.

A cache side channel works by:

1. Flushing a probe array from the cache
2. Triggering the victim to speculatively access memory and load secret data into the cache
3. Measuring access times to the probe array to determine which cache line was loaded
4. Inferring the secret byte from the timing difference

This **Flush+Reload** technique underlies all of the vulnerabilities described here.

ARM64's **weakly ordered** memory model (see [Memory Model](memory-model.md)) means that speculative loads behave differently from x86's Total Store Order model. This is a key reason most ARM64 implementations are not vulnerable to classic Meltdown.

---

## Meltdown (CVE-2017-5754)

### Why most ARM64 is not affected

Meltdown on x86 works because the CPU speculatively reads a kernel address from user mode, and the value becomes transiently visible in a register before the permission fault is raised. This depends on TSO-like behavior where a speculative load can produce a value that propagates to later instructions.

ARM64's weak memory model does not generally permit this. On most ARM64 microarchitectures, a permission fault on a load prevents the loaded value from being forwarded to dependent instructions. The speculative window either does not open or does not produce a usable value.

**Exception: Cortex-A75.** ARM confirmed that the Cortex-A75 is susceptible to a Meltdown-equivalent, where a speculatively loaded kernel byte can influence the cache state before the permission abort is taken.

### Mitigation: KPTI (Cortex-A75 only)

KPTI (Kernel Page Table Isolation) separates the page tables used in user mode from those used in kernel mode, so that kernel addresses are not mapped while EL0 code is running. A speculative read of an unmapped address produces a TLB miss rather than a cached value, breaking the side channel.

On ARM64, KPTI is controlled by `arm64_kernel_use_ng_mappings()` in `arch/arm64/mm/mmu.c`. The kernel marks its mappings as non-global (`nG` bit set) when KPTI is required, so that user-mode TLBs do not cache kernel translations.

```bash
cat /sys/devices/system/cpu/vulnerabilities/meltdown
# Cortex-A75:   "Mitigation: PTI"
# Everything else: "Not affected"
```

On the vast majority of ARM64 hardware — AWS Graviton, Apple Silicon, Qualcomm Snapdragon, most Cortex-A series — KPTI is not enabled and there is no associated performance penalty.

---

## Spectre v1 (CVE-2017-5753): bounds check bypass

### The vulnerability

Spectre v1 exploits speculative execution past a bounds check. An attacker trains the branch predictor so it predicts "branch taken" for a conditional bounds check, then submits an out-of-bounds index. The CPU speculatively executes the load using the bad index and encodes the result in the cache.

```c
/* Vulnerable pattern — found in kernel code handling user-supplied indices */
if (index < array_size) {
    /*
     * CPU speculatively executes here even when index >= array_size,
     * because the branch predictor was trained to predict "taken".
     */
    value = kernel_array[index];           /* speculative out-of-bounds read */
    sink  = probe_array[value * 4096];     /* encodes secret in cache */
}
/* Permission check resolves, rollback — but probe_array[secret*4096] is warm */
```

Spectre v1 affects **all** CPUs with branch prediction, including every ARM64 implementation.

### Mitigation: array_index_nospec()

The primary in-kernel mitigation uses `array_index_nospec()` from `include/linux/nospec.h`. This macro computes a mask that is all-ones when the index is in range and all-zeros otherwise, without using a conditional branch that the CPU can speculate around.

```c
/* include/linux/nospec.h */
#define array_index_nospec(index, size)                          \
({                                                               \
    typeof(index) _i = (index);                                  \
    typeof(size)  _s = (size);                                   \
    unsigned long _mask = array_index_mask_nospec(_i, _s);       \
    BUILD_BUG_ON(sizeof(_i) > sizeof(long));                     \
    (typeof(_i)) (_i & _mask);                                   \
})
```

The ARM64 implementation of `array_index_mask_nospec()` uses a conditional move (CSEL) that clamps the index to zero without a speculative branch:

```c
/* arch/arm64/include/asm/barrier.h */
static inline unsigned long array_index_mask_nospec(unsigned long idx,
                                                     unsigned long sz)
{
    unsigned long mask;
    /*
     * Create a mask that is 0 when idx >= sz, all-ones otherwise.
     * Uses CSEL-based arithmetic that the CPU cannot speculate through.
     */
    asm volatile(
    "   cmp     %1, %2\n"
    "   cset    %0, lo\n"          /* lo: idx < sz (unsigned) */
    "   neg     %0, %0\n"          /* 0 → 0, 1 → 0xFFFF...FFFF */
    : "=r" (mask)
    : "r" (idx), "r" (sz)
    : "cc");
    return mask;
}
```

After sanitization, the pattern looks like:

```c
if (index < array_size) {
    index = array_index_nospec(index, array_size);  /* clamp speculatively */
    val = array[index];   /* safe: even speculatively, index is in bounds */
}
```

### Speculation barrier

In paths where `array_index_nospec()` is not applicable, `__nospeculation_barrier()` (mapped to the ARM64 `CSDB` — Consumption of Speculative Data Barrier, or `ISB` on older cores) can be inserted to prevent the CPU from forwarding speculatively loaded values into subsequent instructions.

```bash
cat /sys/devices/system/cpu/vulnerabilities/spectre_v1
# "Mitigation: __user pointer sanitization"
```

---

## Spectre v2 (CVE-2017-5715): branch target injection

### The vulnerability

Spectre v2 targets the **indirect branch predictor** (Branch Target Buffer, BTB). An attacker running at EL0 can poison BTB entries so that when the kernel executes an indirect branch (function pointer call, virtual dispatch), the CPU speculatively jumps to an attacker-chosen gadget and encodes data in the cache.

```
Attack sequence:
1. Attacker (EL0) repeatedly calls an indirect branch at address A → target T_attacker
   (trains the BTB: when kernel calls A, predict target T_attacker)
2. Kernel (EL1) executes:  blr x9  (indirect call via register)
   CPU speculatively jumps to T_attacker (attacker's gadget)
3. T_attacker reads a kernel secret and encodes it via cache timing
4. Rollback — but cache is warm
```

### Mitigation 1: CSV2 (architectural guarantee)

**CSV2** (Cache Speculation Variant 2) is an architectural feature bit in `ID_AA64PFR0_EL1`. When CSV2=1, the CPU implementation guarantees that branch prediction state is **not shared across exception levels or security domains**. A user-mode attacker cannot poison the BTB entries used by EL1.

CSV2 is a microarchitectural property — it does not require any software mitigation sequence. CPUs that expose CSV2=1 include Apple M-series, AWS Graviton3, and many recent Cortex-A cores.

```bash
cat /sys/devices/system/cpu/vulnerabilities/spectre_v2
# "Mitigation: CSV2"               — hardware guarantee, no SW overhead
# "Mitigation: Branch predictor hardening"   — firmware/SW mitigation active
# "Vulnerable"                     — no mitigation available
```

### Mitigation 2: IBPB via SMCCC firmware calls

Some ARM64 implementations expose an IBPB-equivalent (Indirect Branch Predictor Barrier) through firmware using the SMCCC (ARM SMC Calling Convention) interface. The kernel calls into EL3 firmware on privilege transitions to flush branch predictor state.

The kernel detects this capability via the SMCCC `ARCH_WORKAROUND_1` and `ARCH_WORKAROUND_2` function IDs and, where available, inserts firmware calls at EL0→EL1 transitions.

### Mitigation 3: Return trampolines (ARM64 retpoline equivalent)

ARM64 does not have the x86 RSB (Return Stack Buffer) retpoline trick, but the kernel uses **speculation-safe call sequences** for indirect branches on cores that require software mitigation. These rely on inserting an `SB` (Speculation Barrier, ARMv8.0-SB) or `ISB` after return-like sequences to prevent the CPU from speculating past the branch resolution point.

The kernel's `call_via_r*` trampolines in entry paths use these barriers to prevent attacker-controlled speculative paths from executing gadgets in the kernel.

---

## Spectre-BHB (CVE-2022-23960): Branch History Buffer injection

### The vulnerability

Spectre-BHB (Branch History Buffer) is a more severe refinement of Spectre v2 that was disclosed in March 2022. The **Branch History Buffer** (BHB) influences the prediction of indirect branches — not just the BTB entry, but the selector into the BTB. An attacker who poisons the BHB can redirect indirect branch prediction in the victim even on cores that implement CSV2.

This affects a wide range of ARM cores:

- Cortex-A72 (used in Raspberry Pi 4, many server SoCs)
- Cortex-A73, Cortex-A75
- Cortex-A76, Cortex-A77, Cortex-A78
- Neoverse N1, Neoverse N2 (used in AWS Graviton2/3)
- Various other implementations (see ARM's official errata list)

### Mitigation 1: CSV2_3 (architectural isolation)

**CSV2_3** is an extension of CSV2 (encoded in `ID_AA64PFR0_EL1`) that additionally guarantees BHB isolation between security domains. CPUs with CSV2_3=1 require no software BHB mitigation.

### Mitigation 2: CLRBHB instruction (ARMv8.9 / Cortex-X3 and later)

**CLRBHB** is a new instruction introduced in ARMv8.9 that explicitly clears the Branch History Buffer. The Linux kernel inserts `CLRBHB` in the exception entry path at EL0→EL1 transitions, so that user-mode BHB state cannot influence kernel indirect branch prediction.

```asm
/* arch/arm64/kernel/entry.S — BHB clearing at kernel entry (CLRBHB variant) */
    clrbhb
    isb
```

The `ISB` after `CLRBHB` is necessary to ensure the BHB clear takes effect before any subsequent indirect branches are predicted.

### Mitigation 3: BHB clearing loop (firmware-specified)

For cores that do not have `CLRBHB` or `ECBHB`, the kernel executes a **branch-heavy loop** to overwrite BHB history with benign entries. The number of loop iterations is specified per-CPU model by the firmware (via a SMCCC call or CPU-specific data in the kernel) because it depends on the BHB depth of that particular microarchitecture.

```asm
/* arch/arm64/kernel/entry.S — BHB clearing loop (simplified) */
/*
 * Execute 'k' branches to flush the Branch History Buffer.
 * The loop count is CPU-specific (e.g., 32 iterations for Cortex-A72).
 */
    mov     x0, #<loop_count>
1:  b       2f
2:  subs    x0, x0, #1
    b.ne    1b
    dsb     nsh
    isb
```

This sequence is inserted at every EL0→EL1 exception entry (system call, IRQ, fault) on affected cores, which means there is a small but measurable cost on every kernel entry on these CPUs.

### Mitigation 4: ECBHB (hardware automatic clearing)

Some newer ARM cores set the **ECBHB** bit in `ID_AA64MMFR1_EL1`. When ECBHB=1, the CPU hardware automatically clears the BHB on exception entry from a lower EL. No software BHB clearing sequence is required. The kernel checks this bit and skips the loop or `CLRBHB` sequence if it is set.

### Checking for BHB mitigation

```bash
cat /sys/devices/system/cpu/vulnerabilities/spec_rstack_overflow
# (not BHB — this is AMD-specific)

cat /sys/devices/system/cpu/vulnerabilities/spectre_v2
# "Mitigation: CSV2, BHB"          — hardware CSV2_3 or ECBHB
# "Mitigation: Spectre-BHB loop, Force BHB"
# "Mitigation: CLRBHB"
```

---

## Spectre v4 / Speculative Store Bypass (CVE-2018-3639)

### The vulnerability

The CPU may speculate that a load does not alias with a recent outstanding store (because address disambiguation is expensive). If the speculation is wrong, the load returns a **stale value** from cache or memory rather than the just-written value.

An attacker can exploit this by:
1. Writing a safe pointer value to memory
2. Causing the CPU to speculatively load a different (attacker-controlled) value from the same address, before the write is complete
3. Using the stale value as an array index to encode it in the cache

### Mitigation: SSBS register bit

ARM64 CPUs that support mitigation expose the **SSBS** (Speculative Store Bypass Safe) bit in `PSTATE`. Setting `SSBS=0` instructs the CPU to disable speculative store bypass, preventing the attack. The system register is accessed via `MSR SSBS, Xn` / `MRS Xn, SSBS` (the register is named `SSBS`, not `SSBS_EL1`).

Support is indicated by the **SSBS field in `ID_AA64PFR1_EL1`**.

The kernel exposes control of SSBS to user processes via `prctl`:

```c
/* User process opts into mitigation */
prctl(PR_SET_SPECULATION_CTRL,
      PR_SPEC_STORE_BYPASS,
      PR_SPEC_DISABLE,
      0, 0);
```

When a thread requests mitigation, the kernel sets `SSBS=0` when scheduling that thread in and restores it on context switch out. The overhead is confined to threads that explicitly opt in.

```bash
cat /sys/devices/system/cpu/vulnerabilities/spec_store_bypass
# "Mitigation: Speculative Store Bypass disabled via prctl"
# "Not affected"
# "Vulnerable"
```

---

## MTE and speculation

ARM64's Memory Tagging Extension (MTE, ARMv8.5-A) associates a 4-bit tag with each 16-byte granule of memory. A load or store that uses a pointer whose tag does not match the allocation tag raises a fault.

MTE is **not** a primary Spectre mitigation, but it has a secondary effect: tag checks constrain which speculative loads can produce usable values. A speculative load to a mis-tagged address will eventually fault, limiting the usefulness of some speculative gadgets.

MTE is primarily a memory safety and bug-detection feature. See the kernel's documentation on `arm64/memory-tagging-extension.rst` for details.

---

## Checking vulnerability status

```bash
# Print all vulnerability statuses at once
for f in /sys/devices/system/cpu/vulnerabilities/*; do
    echo "$(basename $f): $(cat $f)"
done

# Example output on a CSV2-capable Graviton3 system:
# meltdown: Not affected
# spectre_v1: Mitigation: __user pointer sanitization
# spectre_v2: Mitigation: CSV2, BHB
# spec_store_bypass: Mitigation: Speculative Store Bypass disabled via prctl
# srbds: Not affected
```

On most modern ARM64 hardware the output is encouraging: Meltdown is not relevant, Spectre v2 is covered by hardware (CSV2), and Spectre-BHB is either hardware-cleared (ECBHB) or mitigated by a short entry-path sequence.

---

## Kernel code locations

The ARM64 spectre mitigations are spread across several files:

| File | What it contains |
|------|-----------------|
| `arch/arm64/kernel/entry.S` | BHB clearing loop and `CLRBHB` at EL0→EL1 entry; kernel entry trampolines |
| `arch/arm64/kernel/proton-pack.c` | Runtime detection, per-CPU mitigation state, SMCCC firmware calls |
| `arch/arm64/include/asm/spectre.h` | Mitigation type enums, per-CPU spectre state structure |
| `arch/arm64/include/asm/barrier.h` | `array_index_mask_nospec()` ARM64 implementation; `__nospeculation_barrier()` |
| `include/linux/nospec.h` | Architecture-independent `array_index_nospec()` macro |
| `arch/arm64/mm/mmu.c` | `arm64_kernel_use_ng_mappings()` — KPTI decision for Cortex-A75 |

### BHB clearing in entry.S

The `entry.S` exception entry macro conditionally applies the BHB mitigation based on a per-CPU capability flag set at boot. The alternatives patching mechanism (`alternative_if` / `alternative_else`) selects the right sequence at runtime without adding a branch to the common path on unaffected hardware:

```asm
/* Conceptual structure in arch/arm64/kernel/entry.S */
/* On exception entry from EL0: */

alternative_if ARM64_WORKAROUND_SPECTRE_BHB_LOOP
    /* Insert branch-clearing loop (count is CPU-model-specific) */
    ...
alternative_else_nop_endif

alternative_if ARM64_WORKAROUND_SPECTRE_BHB_INSN
    clrbhb
    isb
alternative_else_nop_endif
```

This pattern means that CPUs with ECBHB or CSV2_3 execute the original `nop` instructions (no overhead), while affected CPUs execute the mitigation sequence.

---

## Comparison with x86

| Aspect | x86 | ARM64 |
|--------|-----|-------|
| Meltdown | Affects most pre-2019 Intel CPUs | Only Cortex-A75 |
| KPTI | Required on nearly all Intel | Only for Cortex-A75 |
| Spectre v2 mitigation | Retpoline / eIBRS / IBRS MSR | CSV2 (hardware), SMCCC firmware, entry barriers |
| Spectre v1 | `array_index_nospec()` + `LFENCE` | `array_index_nospec()` + `CSDB`/`ISB` |
| Spectre v4 | `IA32_SPEC_CTRL.SSBD` bit | SSBS `PSTATE` bit |
| BHB | BHI_DIS_S / eIBRS (recent Intel) | CLRBHB / loop / ECBHB / CSV2_3 |
| Mitigation controls | MSR writes (ring 0) | System register bits; SMCCC calls to EL3 |

A key architectural difference: on ARM64 most hardware mitigations are expressed as **system register bits** (`ID_AA64PFR0_EL1`, `ID_AA64PFR1_EL1`, `ID_AA64MMFR1_EL1`) checked at boot, rather than MSR-based controls toggled at runtime. This means the software stack is often simpler — either the hardware guarantees isolation (CSV2, ECBHB) or a small entry-path sequence handles it.

---

## Mitigation boot parameters

```bash
# Disable all mitigations (dangerous — isolated benchmarking only)
mitigations=off

# Default auto-selection
mitigations=auto

# Disable specific ARM64 mitigations
nospectre_v1            # disable Spectre v1 mitigations
nospectre_v2            # disable Spectre v2 / BHB mitigations
ssbd=off                # disable Speculative Store Bypass mitigation
nopti                   # disable KPTI (no effect on non-A75 anyway)
```

---

## Performance considerations

Because most ARM64 systems either have hardware-level isolation or require only a short entry-path sequence, the performance impact of ARM64 spectre mitigations is generally **lower** than on x86:

| Mitigation | Overhead |
|------------|----------|
| KPTI (Cortex-A75 only) | 5–30% syscall-heavy; ~5% with ASID-based optimization |
| `array_index_nospec()` | Negligible (a few instructions per bounds check) |
| BHB clearing loop | Small constant per kernel entry (~20–40 cycles on affected cores) |
| `CLRBHB` | Very small (~1–2 cycles + ISB) |
| ECBHB / CSV2_3 | Zero (hardware, no software overhead) |
| SSBS | Negligible when per-thread; zero when disabled |
| SMCCC IBPB firmware call | Moderate on affected cores at privilege transitions |

On recent hardware (Graviton3, Apple M-series, Cortex-X3+) CSV2_3 or ECBHB coverage means most of these paths execute `nop` alternatives and impose no measurable overhead.

---

## Further reading

- [Spectre and Meltdown on x86](../x86/spectre-meltdown.md) — x86 perspective: KPTI, retpoline, eIBRS, IBRS/IBPB/STIBP, MDS/VERW
- [ARM64 Exception Model](exception-model.md) — EL0-EL3 transitions, VBAR_EL1, exception entry paths where BHB clearing is inserted
- [ARM64 CPU Features](cpu-features.md) — how the kernel detects and uses CPU feature bits at boot (system register approach vs. x86 CPUID)
- ARM Architecture Reference Manual (ARM DDI 0487) — `ID_AA64PFR0_EL1` CSV2/CSV2_3 fields; `ID_AA64PFR1_EL1` SSBS field; `ID_AA64MMFR1_EL1` ECBHB field
- ARM Security Advisory: Spectre-BHB (2022) — per-core BHB depth table and recommended loop counts
- `Documentation/admin-guide/hw-vuln/spectre.rst` in the kernel tree — canonical kernel documentation for all spectre variants
