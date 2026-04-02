# ARM64 CPU Features

> Feature detection, alternatives patching, hwcaps, and errata workarounds

## Overview

ARM64 (AArch64) implements a rich system for discovering CPU capabilities at
runtime and transparently patching the kernel image to exploit them. Three
distinct layers are involved:

1. **Feature detection** — ID registers are read at boot; capabilities are
   computed as the safe intersection across all CPUs.
2. **Alternatives patching** — Hot paths in the kernel text are rewritten
   in-place to use faster or more correct instructions when a feature is
   confirmed present.
3. **Userspace exposure** — Detected features are surfaced as `HWCAP_*` bits
   via `getauxval(AT_HWCAP)` and the `Features:` line in `/proc/cpuinfo`.

The kernel code lives primarily in:

| Path | Purpose |
|------|---------|
| `arch/arm64/kernel/cpufeature.c` | Feature detection, capability computation |
| `arch/arm64/include/asm/cpufeature.h` | `struct arm64_cpu_capabilities`, macros |
| `arch/arm64/kernel/alternative.c` | Alternatives patching engine |
| `arch/arm64/include/asm/alternative.h` | `alternative()`, `alternative_insn()` macros |
| `arch/arm64/kernel/cpu_errata.c` | Errata workaround table |
| `arch/arm64/include/uapi/asm/hwcap.h` | `HWCAP_*` constants exposed to userspace |

---

## Feature Detection at Boot

### ID Registers

ARM64 exposes CPU capabilities through a family of system registers readable
at EL1. The kernel reads these during `setup_cpu_features()` (called from
`setup_arch()`):

| Register | What it describes |
|----------|------------------|
| `ID_AA64ISAR0_EL1` | Instruction set: AES, SHA, CRC32, atomics, RDM, … |
| `ID_AA64ISAR1_EL1` | DPB, JSCVT, FCMA, LRCPC, GPA, GPI, FRINTTS, … |
| `ID_AA64ISAR2_EL1` | WFXT, RPRES, GPA3, APA3, MOPS, BC, … |
| `ID_AA64MMFR0_EL1` | PA size, ASID bits, TGran sizes |
| `ID_AA64MMFR1_EL1` | VH, HPDS, LO, PAN, SpecSEI, XNX |
| `ID_AA64MMFR2_EL1` | CNP, UAO, LSM, IESB, VARange, CCIDX |
| `ID_AA64PFR0_EL1` | EL0/1/2/3 widths, FP, AdvSIMD, GIC, RAS, SVE |
| `ID_AA64PFR1_EL1` | BT (BTI), SSBS, MTE, RAS_frac, MPAM_frac |
| `MIDR_EL1` | Implementer, architecture, variant, part, revision |

Each register encodes multiple 4-bit fields. The helper
`cpuid_feature_extract_field()` (defined in `arch/arm64/include/asm/cpufeature.h`)
extracts a single field:

```c
/* arch/arm64/include/asm/cpufeature.h */
static inline int cpuid_feature_extract_field(u64 features, int field, bool sign)
{
    return (sign)
        ? cpuid_feature_extract_signed_field(features, field)
        : (int)((features >> field) & 0xf);
}
```

`MIDR_EL1` encodes the CPU identity used for errata matching:

```
MIDR_EL1 layout
 [31:24] Implementer  (0x41 = ARM Ltd, 0x51 = Qualcomm, 0x53 = Samsung, …)
 [23:20] Variant      (major revision)
 [19:16] Architecture (always 0xF for ARMv8+)
 [15:4]  PartNum      (0xD03 = Cortex-A53, 0xD0B = Cortex-A76, …)
 [3:0]   Revision     (minor revision)
```

### Capability Accumulation Across CPUs

On SMP systems the feature intersection must be computed across all CPUs.
Each secondary CPU calls `check_local_cpu_capabilities()` on bringup. The
primary CPU drives the final safe set via `update_cpu_capabilities()`:

```
Boot CPU reads ID registers
       │
       ▼
update_cpu_capabilities(arm64_features)
       │   calls matches() on every arm64_cpu_capabilities entry
       ▼
set_cpu_cap() sets bit in cpu_hwcaps[] bitmap
       │
Secondary CPUs boot, call check_local_cpu_capabilities()
       │   verifies they do not lack any already-set cap
       ▼
apply_alternatives_all()  ← patches kernel text
       │
cpu_enable() hooks run per-CPU (e.g., enable SSBS, PAN)
```

The global `cpu_hwcaps` is a `DECLARE_BITMAP` of `ARM64_NCAPS` bits defined
in `arch/arm64/include/asm/cpucaps.h`.

---

## struct arm64_cpu_capabilities

Every ARM64 feature or erratum is described by a single entry in
`struct arm64_cpu_capabilities` (`arch/arm64/include/asm/cpufeature.h`):

```c
struct arm64_cpu_capabilities {
    const char          *desc;
    u16                  capability;   /* ARM64_* cap index, e.g. ARM64_HAS_LSE_ATOMICS */
    u16                  type;         /* ARM64_CPUCAP_* flags bitmask */
    bool                (*matches)(const struct arm64_cpu_capabilities *cap, int scope);
    void                (*cpu_enable)(const struct arm64_cpu_capabilities *cap);
    union {
        /* For register-based features: */
        struct {
            u32         sys_reg;       /* SYS_ID_AA64ISAR0_EL1, etc. */
            u8          field_pos;     /* bit position of the field */
            u8          field_width;   /* field width (usually 4) */
            u8          min_field_value;
            u8          hwcap_type;
            unsigned long hwcap;       /* HWCAP_* or HWCAP2_* bit */
        };
        /* For MIDR-based errata: */
        const struct midr_range *midr_range_list;
        struct midr_range        midr_range;
    };
};
```

Key `type` flag combinations:

| Flag | Meaning |
|------|---------|
| `ARM64_CPUCAP_SYSTEM_FEATURE` | Safe to use only when all CPUs have it |
| `ARM64_CPUCAP_BOOT_CPU_FEATURE` | Detected from the boot CPU only |
| `ARM64_CPUCAP_WEAK_LOCAL_CPU_FEATURE` | Per-CPU, missing on some CPUs is tolerated |
| `ARM64_CPUCAP_SCOPE_LOCAL_CPU` | Checked per-CPU during hotplug |

The two main global tables are:

```c
/* arch/arm64/kernel/cpufeature.c */
static const struct arm64_cpu_capabilities arm64_features[];
static const struct arm64_cpu_capabilities arm64_errata[];
```

`arm64_features[]` drives `HWCAP_*` exposure and alternatives patching.
`arm64_errata[]` drives workaround application.

---

## Checking Capabilities at Runtime

### System-wide: cpus_have_cap()

```c
/* arch/arm64/include/asm/cpufeature.h */
static inline bool cpus_have_cap(unsigned int num)
{
    return test_bit(num, cpu_hwcaps);
}
```

This reads a bit from the global `cpu_hwcaps` bitmap. It is safe to call
from any context after `setup_cpu_features()` completes. Common usage:

```c
if (cpus_have_cap(ARM64_HAS_LSE_ATOMICS))
    use_lse_path();
```

### Per-CPU: this_cpu_has_cap()

```c
static inline bool this_cpu_has_cap(unsigned int cap)
{
    if (!WARN_ON(cap >= ARM64_NCAPS))
        return !!test_bit(cap, (unsigned long *)this_cpu_ptr(&cpu_hwcaps));
    return false;
}
```

Used when a feature may not be uniform across all CPUs (e.g., SSBS, FPMR).

### Static keys: cpus_have_const_cap()

For extremely hot paths, capabilities are also backed by `static_key_false`
entries so the check compiles down to a single NOP that is patched to a branch
at boot:

```c
/* Fast path — no bitmap read, just a static branch */
if (cpus_have_const_cap(ARM64_HAS_LSE_ATOMICS)) { … }
```

---

## Alternatives Patching

### How It Works

The alternatives mechanism allows the kernel to ship one binary that runs
correctly on all ARMv8 CPUs and is then optimized for the actual hardware at
boot time. The scheme:

1. The compiler emits a **patching site** into the `.altinstructions` ELF
   section: `{orig_offset, alt_offset, cpucap, orig_len, alt_len}`.
2. The original (conservative) instruction sequence occupies the live text.
3. At boot, `apply_alternatives_all()` iterates `.altinstructions`; for each
   entry whose `cpucap` bit is set in `cpu_hwcaps`, it overwrites the live
   text with the alternative sequence using `aarch64_insn_patch_text()`.
4. Cache maintenance (`__flush_icache_range()`) makes the new instructions
   visible to the instruction stream.

### Assembly Macros

```asm
/* arch/arm64/include/asm/alternative.h */

/*
 * Replace instruction sequence 'oldinstr' with 'newinstr' when
 * 'cap' is present. Both sequences must have the same byte length.
 */
.macro alternative_insn oldinstr, newinstr, cap, enable = 1
    .if \enable
661:    \oldinstr
662:    .pushsection .altinstructions, "a"
        altinstruction_entry 661b, 663f, \cap, 662b-661b, 664f-663f
    .popsection
    .pushsection .altinstr_replacement, "ax"
663:    \newinstr
664:    .popsection
    .endif
.endm
```

In C code the `alternative()` macro wraps inline assembly:

```c
/* Inline asm form */
asm volatile(ALTERNATIVE("nop", "isb", ARM64_WORKAROUND_1542419));
```

### Example: LSE Atomics (LDXR/STXR → CAS)

Before patching, `atomic_add()` on ARM64 contains an LL/SC loop:

```asm
/* Original (always correct) */
661:
    ldxr    w0, [x1]
    add     w0, w0, w2
    stxr    w3, w0, [x1]
    cbnz    w3, 661b
```

When `ARM64_HAS_LSE_ATOMICS` is set, alternatives replaces this with:

```asm
/* Patched (LSE) */
    casa    w2, w0, [x1]
```

The capability index `ARM64_HAS_LSE_ATOMICS` is defined in
`arch/arm64/include/asm/cpucaps.h` and its detection entry in
`arm64_features[]` checks `ID_AA64ISAR0_EL1.Atomic` >= 2.

### apply_alternatives_all()

```c
/* arch/arm64/kernel/alternative.c */
void __init apply_alternatives_all(void)
{
    struct alt_region region = {
        .begin  = (struct alt_instr *)__alt_instructions,
        .end    = (struct alt_instr *)__alt_instructions_end,
    };
    /*
     * cpucaps are finalized. Walk every altinstruction entry and
     * patch if the corresponding cap bit is set.
     */
    BUG_ON(!system_capabilities_finalized());
    __apply_alternatives(&region, false, &cpu_hwcaps_ptrs);
}
```

Secondary CPUs also call `apply_alternatives_this_cpu()` to apply
`ARM64_CPUCAP_LOCAL_CPU_FEATURE` patches in their own context.

---

## HWCAP: Userspace Feature Exposure

Detected features are advertised to userspace through two mechanisms:

- **`getauxval(AT_HWCAP)`** and **`getauxval(AT_HWCAP2)`** — bitmask values
  placed in the ELF auxiliary vector by the kernel at `execve()` time.
- **`/proc/cpuinfo`** — the `Features:` line lists the same capabilities as
  human-readable strings.

### HWCAP Constants

Defined in `arch/arm64/include/uapi/asm/hwcap.h`:

| Constant | Bit | Feature |
|----------|-----|---------|
| `HWCAP_FP` | 0 | Floating-point (mandatory on ARMv8) |
| `HWCAP_ASIMD` | 1 | Advanced SIMD / Neon (mandatory) |
| `HWCAP_EVTSTRM` | 2 | Event stream (generic timer) |
| `HWCAP_AES` | 3 | AES instructions |
| `HWCAP_PMULL` | 4 | Polynomial multiply (PMULL/PMULL2) |
| `HWCAP_SHA1` | 5 | SHA-1 instructions |
| `HWCAP_SHA2` | 6 | SHA-256 instructions |
| `HWCAP_CRC32` | 7 | CRC32 instructions |
| `HWCAP_ATOMICS` | 8 | Large System Extensions (LSE atomics) |
| `HWCAP_FPHP` | 9 | Half-precision FP |
| `HWCAP_ASIMDHP` | 10 | Advanced SIMD half-precision |
| `HWCAP_CPUID` | 11 | EL0 ID register access |
| `HWCAP_ASIMDRDM` | 12 | Rounding double multiply accumulate |
| `HWCAP_JSCVT` | 13 | JavaScript FJCVTZS instruction |
| `HWCAP_FCMA` | 14 | Floating-point complex number multiply |
| `HWCAP_LRCPC` | 15 | Load-acquire RCpc |
| `HWCAP_DCPOP` | 16 | DC CVAP instruction |
| `HWCAP_SHA3` | 17 | SHA-3 instructions |
| `HWCAP_SM3` | 18 | SM3 instructions |
| `HWCAP_SM4` | 19 | SM4 instructions |
| `HWCAP_ASIMDDP` | 20 | SIMD dot product |
| `HWCAP_SHA512` | 21 | SHA-512 instructions |
| `HWCAP_SVE` | 22 | Scalable Vector Extension |
| `HWCAP_ASIMDFHM` | 23 | SIMD FP16 multiply accumulate |
| `HWCAP_DIT` | 24 | Data Independent Timing |
| `HWCAP_USCAT` | 25 | Unaligned single-copy-atomic access |
| `HWCAP_ILRCPC` | 26 | LRCPC2 (immediate offset) |
| `HWCAP_FLAGM` | 27 | Flag manipulation instructions |
| `HWCAP_SSBS` | 28 | Speculative Store Bypass Safe |
| `HWCAP_SB` | 29 | Speculation Barrier instruction |
| `HWCAP_PACA` | 30 | Pointer Authentication (address) |
| `HWCAP_PACG` | 31 | Pointer Authentication (generic) |

Selected `AT_HWCAP2` constants (in `hwcap.h` as `HWCAP2_*`):

| Constant | Feature |
|----------|---------|
| `HWCAP2_DCPODP` | DC CVADP instruction |
| `HWCAP2_SVE2` | SVE2 |
| `HWCAP2_SVEAES` | SVE2 + AES |
| `HWCAP2_BTI` | Branch Target Identification |
| `HWCAP2_MTE` | Memory Tagging Extension |
| `HWCAP2_ECV` | Enhanced Counter Virtualization |
| `HWCAP2_AFP` | Alternate Floating-Point Behavior |
| `HWCAP2_RPRES` | 12-bit reciprocal estimate |
| `HWCAP2_MTE3` | MTE asymmetric fault reporting |
| `HWCAP2_SME` | Scalable Matrix Extension |

### Reading HWCAPs from Userspace

```c
#include <sys/auxv.h>
#include <asm/hwcap.h>

unsigned long hwcap  = getauxval(AT_HWCAP);
unsigned long hwcap2 = getauxval(AT_HWCAP2);

if (hwcap & HWCAP_ATOMICS)
    /* safe to use LSE atomics */;
if (hwcap & HWCAP_SVE)
    /* SVE is available */;
if (hwcap2 & HWCAP2_BTI)
    /* BTI is enforced */;
```

---

## SVE — Scalable Vector Extension

SVE (ARMv8.2+) introduces vector registers of variable width: 128 to 2048
bits in 128-bit increments. Unlike NEON, the vector length is not fixed at
ISA design time but is implementation-defined and can be configured per-task.

### Vector Length Management

```c
/* arch/arm64/kernel/fpsimd.c */

/* Set the SVE vector length for the current task */
int sve_set_vector_length(struct task_struct *task, unsigned long vl,
                          unsigned long flags);
```

Userspace selects a vector length with:

```c
prctl(PR_SVE_SET_VL, vl);   /* set preferred VL in bytes */
prctl(PR_SVE_GET_VL);       /* get current VL */
```

The kernel rounds `vl` down to the largest supported value not exceeding the
request. Valid values are multiples of 16 from 16 to 256 bytes (128 to 2048
bits). The system-wide default VL is readable from
`/proc/sys/abi/sve_default_vector_length` (this is the default applied to new
threads, not an upper bound; the true maximum is reported by
`prctl(PR_SVE_GET_VL)` after setting the VL to an arbitrarily large value).

### Lazy State Save

SVE register state is saved and restored lazily:

1. When a task first executes an SVE instruction, a `trap_sve` exception fires
   (because `CPACR_EL1.ZEN` = 0 in most contexts).
2. The trap handler sets `TIF_SVE` in the thread flags, allocates per-task
   SVE storage (`task->thread.sve_state`), and re-enables SVE by setting
   `CPACR_EL1.ZEN = 0b11` (allow EL0 and EL1 SVE access without trapping).
3. On context switch, `fpsimd_thread_switch()` saves SVE state only when
   `TIF_SVE` is set, avoiding overhead for non-SVE tasks.

```c
/* thread_info flags (arch/arm64/include/asm/thread_info.h) */
#define TIF_SVE         23  /* SVE enabled for EL0 */
#define TIF_SVE_VL_INHERIT 24 /* Inherit SVE VL across exec */
```

### Kernel SVE Use

Kernel code that uses SVE (e.g., accelerated crypto) must explicitly enable
the FP/SVE access trap:

```c
kernel_neon_begin();   /* disables preemption, enables FPSIMD/SVE */
/* use NEON or SVE instructions */
kernel_neon_end();     /* restores state, re-enables preemption */
```

---

## BTI — Branch Target Identification

BTI is an ARMv8.5 control-flow integrity feature. When enabled for userspace
(`SCTLR_EL1.BT0 = 1`) or kernel (`SCTLR_EL1.BT1 = 1`), any indirect branch
(`BR`, `BLR`, `RET`) must land on a `BTI` instruction (or the destination of
a paired `BL`/`BLRAAZ` that implies a call target). Landing anywhere else
raises a Branch Target Exception. The kernel sets `BT0` to enforce BTI for
user processes; `BT1` controls enforcement in kernel code.

### ELF Marking

Binaries opt in via a GNU property note:

```
GNU_PROPERTY_AARCH64_FEATURE_1_BTI   (bit 0 of GNU_PROPERTY_AARCH64_FEATURE_1_AND)
```

The dynamic linker (`ld.so`) reads this note. The kernel checks it at `execve()` time via `arch_parse_elf_property()` in
`arch/arm64/kernel/process.c` and sets `SCTLR_EL1.BT0` for the process if
the property is present, enabling BTI enforcement for userspace code.

### Interaction with JIT and Signal Handlers

JIT compilers must emit `BTI c` (call target) or `BTI j` (jump target)
landing pads. The kernel signal return trampoline
(`arch/arm64/kernel/vdso/sigreturn.S`) is BTI-annotated to allow `BLR` into
it from user trampolines.

---

## MTE — Memory Tagging Extension

MTE (ARMv8.5+) implements hardware-assisted memory safety by associating a
4-bit **allocation tag** with every 16-byte **granule** of tagged memory, and
encoding a matching **logical tag** in pointer bits [59:56] (top-byte ignore
region).

On every load or store the hardware compares the pointer's logical tag with
the memory granule's allocation tag. A mismatch either raises a synchronous
fault or is recorded asynchronously, depending on the TCR_EL1 mode selected.

### Kernel API

```c
/* Enable MTE for the calling process */
prctl(PR_SET_TAGGED_ADDR_CTRL,
      PR_TAGGED_ADDR_ENABLE | PR_MTE_TCF_SYNC | (0xffff << PR_MTE_TAG_SHIFT),
      0, 0, 0);

/* mmap with PROT_MTE to get a taggable mapping */
void *p = mmap(NULL, size, PROT_READ | PROT_WRITE | PROT_MTE,
               MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
```

The flag `PROT_MTE` is `arch/arm64/include/uapi/asm/mman.h`.

### Modes

| Mode | SCTLR_EL1.TCF0 | Behavior |
|------|---------------|---------|
| `PR_MTE_TCF_NONE` | `0b00` | MTE disabled |
| `PR_MTE_TCF_SYNC` | `0b01` | Synchronous fault on tag mismatch |
| `PR_MTE_TCF_ASYNC` | `0b10` | Async fault; reported via SIGBUS |

MTE tags are not preserved across `fork()` for COW pages until the page is
actually written; the kernel handles tag inheritance in `copy_user_highpage()`.

---

## Errata Workarounds

CPU errata (hardware bugs) are handled through the same `arm64_cpu_capabilities`
infrastructure, but stored in `arm64_errata[]`
(`arch/arm64/kernel/cpu_errata.c`).

### MIDR-Based Matching

Each errata entry uses `MIDR_CPU_VAR_REV()` or `MIDR_ALL_VERSIONS()` to
match affected CPU revisions:

```c
/* arch/arm64/kernel/cpu_errata.c */
{
    .desc       = "Cortex-A53: 843419: A load or store might access "
                  "an incorrect address",
    .capability = ARM64_WORKAROUND_843419,
    .type       = ARM64_CPUCAP_LOCAL_CPU_ERRATUM,
    ERRATA_MIDR_REV_RANGE(MIDR_CORTEX_A53, 0, 0, 4),
},
```

`MIDR_CORTEX_A53` is `0x410FD030`. The range `(variant=0, rev_min=0,
rev_max=4)` matches r0p0 through r0p4.

### Workaround Mechanisms

| Mechanism | When Used |
|-----------|----------|
| Alternatives patch | Runtime: replaces instruction sequences |
| `cpu_enable` hook | Runtime: sets a system register flag |
| Kconfig option | Compile-time: inserts barriers unconditionally |
| Linker flag | Build-time: e.g., `--fix-cortex-a53-843419` |

### Selected Errata

| Erratum | CPU | Description | Workaround |
|---------|-----|-------------|-----------|
| 843419 | Cortex-A53 r0p0–r0p4 | Wrong address used in ADRP sequences | Linker `--fix-cortex-a53-843419` |
| 835769 | Cortex-A53 r0p0–r0p4 | Incorrect result from MUL/MADD after load | Compiler `-mfix-cortex-a53-835769` |
| 1530923 | Cortex-A55 | Speculative AT instruction may cause faults | Speculation barrier alternatives |
| 2457168 | Cortex-A510 | PMULL2 may produce incorrect results | Alternatives patch |
| 1418040 | Cortex-A55 | ICache invalidation may be incomplete | `ic iallu` alternatives |

Errata workarounds are conditionally compiled via `CONFIG_ARM64_ERRATUM_*`
Kconfig symbols and do not add overhead on unaffected hardware.

---

## Observability

### /proc/cpuinfo

```bash
$ cat /proc/cpuinfo | grep -E "CPU implementer|CPU architecture|CPU variant|CPU part|CPU revision|Features"
processor       : 0
CPU implementer : 0x41          # ARM Ltd
CPU architecture: 8
CPU variant     : 0x3
CPU part        : 0xd0b         # Cortex-A76
CPU revision    : 1

Features        : fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp \
                  asimdhp cpuid asimdrdm lrcpc dcpop asimddp ssbs
```

### sysfs ID Registers

Linux 5.11+ exposes raw ID register values under sysfs (gated by
`CONFIG_ARM64_CPUIDLE` build config and `ID_AA64DFR0_EL1.PMSVer` capability checks):

```bash
$ grep . /sys/devices/system/cpu/cpu0/regs/identification/*
/sys/devices/system/cpu/cpu0/regs/identification/midr_el1:0x413FD0B1
/sys/devices/system/cpu/cpu0/regs/identification/revidr_el1:0x00000000
```

### Checking Active hwcaps Programmatically

```c
#include <sys/auxv.h>
#include <asm/hwcap.h>
#include <stdio.h>

int main(void) {
    unsigned long hwcap  = getauxval(AT_HWCAP);
    unsigned long hwcap2 = getauxval(AT_HWCAP2);

    printf("LSE atomics : %s\n", (hwcap  & HWCAP_ATOMICS) ? "yes" : "no");
    printf("SVE         : %s\n", (hwcap  & HWCAP_SVE)     ? "yes" : "no");
    printf("BTI         : %s\n", (hwcap2 & HWCAP2_BTI)    ? "yes" : "no");
    printf("MTE         : %s\n", (hwcap2 & HWCAP2_MTE)    ? "yes" : "no");
    return 0;
}
```

### Kernel Capability Bitmap (debug)

The full capability bitmap is not directly exported, but you can infer the
active set from the `Features:` line and by reading
`/sys/devices/system/cpu/cpu*/regs/identification/midr_el1`.

For kernel developers, `cpus_have_cap(ARM64_HAS_LSE_ATOMICS)` is the
authoritative check inside the kernel; early in boot (before secondaries are
up) `boot_cpu_has(ARM64_HAS_LSE_ATOMICS)` is used instead.

---

## Boot-Time Flow Summary

```
start_kernel()
    └─ setup_arch()
          ├─ setup_machine_fdt()
          ├─ init_mem_init()
          └─ setup_cpu_features()
                ├─ init_cpu_features()        ← read ID regs on boot CPU
                ├─ setup_system_capabilities()
                │     └─ update_cpu_capabilities(arm64_features)
                │           └─ for each cap: cap->matches() → set_cpu_cap()
                ├─ apply_alternatives_all()   ← patch kernel text
                └─ (later) smp_cpus_done()
                      └─ check_local_cpu_capabilities()  per secondary CPU
```

---

## Further Reading

- `arch/arm64/include/asm/cpufeature.h` — full `struct arm64_cpu_capabilities`
  definition and all `ARM64_CPUCAP_*` type flags
- `arch/arm64/include/asm/cpucaps.h` — enumeration of all `ARM64_*` capability
  indices and `ARM64_NCAPS`
- `arch/arm64/kernel/cpufeature.c` — `arm64_features[]` table, detection logic,
  `update_cpu_capabilities()`, `apply_alternatives_all()` callsite
- `arch/arm64/kernel/cpu_errata.c` — `arm64_errata[]` table with full MIDR
  match ranges and workaround descriptions
- `arch/arm64/kernel/alternative.c` — patching engine, `__apply_alternatives()`
- `arch/arm64/include/asm/alternative.h` — `alternative_insn`, `alternative`,
  `ALTERNATIVE` macro definitions
- `arch/arm64/include/uapi/asm/hwcap.h` — all `HWCAP_*` and `HWCAP2_*`
  constants with bit positions
- `arch/arm64/kernel/fpsimd.c` — SVE state management, `kernel_neon_begin/end`,
  `TIF_SVE` handling
- `arch/arm64/kernel/process.c` — BTI enforcement at `execve()`, MTE
  initialization for new processes
- [ARM Architecture Reference Manual, ARMv8-A](https://developer.arm.com/documentation/ddi0487/latest)
  — definitive reference for all system registers and feature encodings
- [ARM CPU Feature Registers](https://www.kernel.org/doc/html/latest/arch/arm64/cpu-feature-registers.html)
  — kernel documentation on sysfs register exposure and `HWCAP_CPUID`
- [ARM64 ELF ABI](https://github.com/ARM-software/abi-aa/blob/main/sysvabi64/sysvabi64.rst)
  — `AT_HWCAP` assignment, BTI ELF note, SVE ABI
