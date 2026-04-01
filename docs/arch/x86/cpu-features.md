# x86 CPU Features and Alternatives

> CPUID, feature flags, alternative patching, and hardware capabilities

The kernel must run on CPUs spanning decades of x86 evolution — from early Pentium 4s to the latest AMD Zen or Intel Core generations. The CPU feature detection and alternative patching infrastructure allows the kernel to be compiled once and then automatically tune itself to the current hardware at boot time.

---

## CPUID: querying CPU capabilities

`CPUID` is the x86 instruction for enumerating CPU capabilities. The caller loads a **leaf number** into `EAX` (and sometimes a subleaf into `ECX`) before executing `CPUID`. The CPU returns capability bits in `EAX`, `EBX`, `ECX`, and `EDX`.

```
CPUID usage:
  Input:  EAX = leaf, ECX = subleaf (for leaves that use it)
  Output: EAX, EBX, ECX, EDX = feature bits (leaf-defined)

Key leaves:
  EAX=0:           Maximum supported leaf; CPU vendor string in EBX/ECX/EDX
  EAX=1:           Basic feature bits
                    EDX: FPU, VME, PSE, TSC, MSR, PAE, MCE, CX8, APIC, SEP,
                         MTRR, PGE, MCA, CMOV, PAT, PSE-36, PSN, CLFSH, DS,
                         ACPI, MMX, FXSR, SSE, SSE2, SS, HTT, TM, IA64, PBE
                    ECX: SSE3, PCLMULQDQ, DTES64, MONITOR, DS-CPL, VMX, SMX,
                         EIST, TM2, SSSE3, CNXT-ID, SDBG, FMA, CX16, xTPR,
                         PDCM, PCID, DCA, SSE4.1, SSE4.2, x2APIC, MOVBE,
                         POPCNT, TSC-Deadline, AES, XSAVE, OSXSAVE, AVX,
                         F16C, RDRAND, Hypervisor
  EAX=7, ECX=0:    Extended features
                    EBX: FSGSBASE, TSC_ADJUST, SGX, AVX2, FDP_EXCPTN_ONLY,
                         SMEP, BMI2, ERMS, INVPCID, RTM, MPX, AVX512F,
                         AVX512DQ, RDSEED, ADX, SMAP, AVX512IFMA, CLFLUSHOPT,
                         CLWB, INTEL_PT, AVX512PF, AVX512ER, AVX512CD,
                         SHA_NI, AVX512BW, AVX512VL
                    ECX: PKU, OSPKE, WAITPKG, AVX512_VBMI2, SHSTK, GFNI,
                         VAES, VPCLMULQDQ, AVX512_VNNI, AVX512_BITALG,
                         AVX512_VPOPCNTDQ, LA57, RDPID, BUS_LOCK_DETECT,
                         CLDEMOTE, MOVDIRI, MOVDIR64B, ENQCMD, SGX_LC, PKS
  EAX=0x80000001:  AMD extended features (also used by Intel for some bits)
                    EDX: SYSCALL, NX, MMXEXT, FXSR_OPT, PDPE1GB, RDTSCP,
                         LM (long mode = 64-bit), 3DNOWEXT, 3DNOW
                    ECX: LAHF_LM, CMP_LEGACY, SVM, EXTAPIC, CR8_LEGACY,
                         ABM (LZCNT), SSE4A, MISALIGNSSE, 3DNOWPREFETCH,
                         OSVW, IBS, XOP, SKINIT, WDT, LWP, FMA4, TCE, NODEID,
                         TBM, TOPOEXT, PERFCTR_CORE, PERFCTR_NB
```

The kernel calls CPUID during early boot in `arch/x86/kernel/cpu/common.c` via `cpuid()` and `cpuid_count()` helpers:

```c
/* arch/x86/include/asm/processor.h */
static inline void cpuid(unsigned int op,
                          unsigned int *eax, unsigned int *ebx,
                          unsigned int *ecx, unsigned int *edx)
{
    *eax = op;
    *ecx = 0;
    __cpuid(eax, ebx, ecx, edx);
}

static inline void cpuid_count(unsigned int op, int count,
                                unsigned int *eax, unsigned int *ebx,
                                unsigned int *ecx, unsigned int *edx)
{
    *eax = op;
    *ecx = count;
    __cpuid(eax, ebx, ecx, edx);
}
```

---

## x86_capability[]: the kernel's feature bitmask

After parsing all CPUID leaves, the kernel stores CPU features in the `x86_capability` array inside `struct cpuinfo_x86`:

```c
/* arch/x86/include/asm/processor.h */
struct cpuinfo_x86 {
    /* ... */
    __u32   x86_capability[NCAPINTS + NBUGINTS];
    /* NCAPINTS words for features, NBUGINTS words for bug flags */
    /* ... */
};

/* The boot CPU's cpuinfo — used for most feature checks */
extern struct cpuinfo_x86 boot_cpu_data;
```

`NCAPINTS` is the number of 32-bit words in the feature bitmask array. Each bit corresponds to one `X86_FEATURE_*` constant. The words map to CPUID output registers in a defined order:

```c
/* arch/x86/include/asm/cpufeatures.h */
/*
 * Word  0: EDX from CPUID leaf 1
 * Word  1: ECX from CPUID leaf 1
 * Word  2: EDX from CPUID leaf 0x80000001
 * Word  3: Linux-defined synthetic features (no single CPUID bit)
 * Word  4: ECX from CPUID leaf 0x80000001
 * Word  5: EBX from CPUID leaf 1 (cache info)
 * Word  6: EBX from CPUID leaf 7, subleaf 0
 * Word  7: EDX from CPUID leaf 7, subleaf 0
 * Word  8: EBX from CPUID leaf 0x80000007 (APM)
 * Word  9: EBX from CPUID leaf 0x80000008
 * Word 10: ECX from CPUID leaf 7, subleaf 0
 * Word 11: EDX from CPUID leaf 7, subleaf 1
 * ...
 */

#define X86_FEATURE_FPU         ( 0*32+ 0)  /* Onboard FPU */
#define X86_FEATURE_VME         ( 0*32+ 1)  /* Virtual Mode Extensions */
#define X86_FEATURE_DE          ( 0*32+ 2)  /* Debugging Extensions */
#define X86_FEATURE_PSE         ( 0*32+ 3)  /* Page Size Extensions */
#define X86_FEATURE_TSC         ( 0*32+ 4)  /* Time Stamp Counter */
#define X86_FEATURE_MSR         ( 0*32+ 5)  /* Model-Specific Registers */
#define X86_FEATURE_PAE         ( 0*32+ 6)  /* Physical Address Extensions */
/* ... many more ... */
#define X86_FEATURE_FSGSBASE    ( 6*32+ 0)  /* RDFSBASE, WRFSBASE, RDGSBASE, WRGSBASE */
#define X86_FEATURE_PCID        ( 1*32+17)  /* Process Context IDs */
#define X86_FEATURE_INVPCID     ( 6*32+10)  /* INVPCID instruction */
#define X86_FEATURE_PKU         (16*32+ 3)  /* Protection Keys for Userspace */
#define X86_FEATURE_UMIP        (16*32+ 2)  /* User-Mode Instruction Prevention */
#define X86_FEATURE_AVX512F     ( 9*32+16)  /* AVX-512 Foundation */
```

---

## Three ways to check CPU features

The kernel provides three macros for checking features, with different performance characteristics:

### 1. cpu_has(): runtime check

```c
/* arch/x86/include/asm/cpufeature.h */
#define cpu_has(c, bit) test_cpu_cap(c, bit)

/* Example: check if a specific CPU struct has PCID */
if (cpu_has(&boot_cpu_data, X86_FEATURE_PCID)) {
    /* ... */
}
```

`cpu_has()` is a runtime check — it reads from the `x86_capability` array. Use this when you need to check a specific CPU (not just the boot CPU), or in early boot before alternatives are patched.

### 2. boot_cpu_has(): boot-time check

```c
#define boot_cpu_has(bit) cpu_has(&boot_cpu_data, bit)

/* Example: enable PCID if supported */
if (boot_cpu_has(X86_FEATURE_PCID))
    cr4_set_bits(X86_CR4_PCIDE);
```

`boot_cpu_has()` checks the boot CPU's feature flags. Used for one-time setup decisions during boot. These calls are not patched by the alternatives mechanism.

### 3. static_cpu_has(): compile-time patched

```c
#define static_cpu_has(bit) __static_cpu_has(bit)

/* Example: fast path for FSGSBASE */
if (static_cpu_has(X86_FEATURE_FSGSBASE)) {
    /* This branch may be compiled out entirely on CPUs without FSGSBASE,
     * or turned into an unconditional jump on CPUs that always have it */
    wrfsbase(value);
} else {
    wrmsrl(MSR_FS_BASE, value);
}
```

`static_cpu_has()` emits a **patchable** instruction sequence. At boot, `apply_alternatives()` patches the code in place:

- If the feature is **present**: the test is replaced with `jmp over_else` (always take the if-branch)
- If the feature is **absent**: the test is replaced with `jmp over_if` (always take the else-branch)

After patching, the check becomes a single unconditional branch — zero overhead compared to a memory read.

---

## Alternative patching

The **alternative** mechanism allows the kernel to ship with safe, conservative code and then patch in optimized instruction sequences at boot time based on the actual CPU capabilities.

### The ALTERNATIVE macro

```c
/* arch/x86/include/asm/alternative.h */

/*
 * ALTERNATIVE(orig_insn, alt_insn, feature):
 *   If 'feature' is present in boot_cpu_data: use alt_insn
 *   Otherwise: use orig_insn
 */
#define ALTERNATIVE(oldinstr, newinstr, feature)            \
    OLDINSTR(oldinstr)                                       \
    ".pushsection .altinstructions,\"a\"\n"                  \
    ALTINSTR_ENTRY(feature, 0)                               \
    ".popsection\n"                                          \
    ".pushsection .altinstr_replacement,\"ax\"\n"            \
    ALTINSTR_REPLACEMENT(newinstr, 0)                        \
    ".popsection\n"
```

The default instruction (`orig_insn`) is emitted inline in the `.text` section. The replacement instruction (`alt_insn`) is placed in `.altinstr_replacement`. A descriptor (`struct alt_instr`) is placed in `.altinstructions` to describe the patching.

### struct alt_instr

```c
/* arch/x86/include/asm/alternative.h */
struct alt_instr {
    s32  instr_offset;    /* offset of original instruction */
    s32  repl_offset;     /* offset of replacement instruction */
    u16  cpuid;           /* CPUID feature bit */
    u8   instrlen;        /* length of original instruction */
    u8   replacementlen;  /* length of replacement instruction */
};
```

### apply_alternatives() at boot

```c
/* arch/x86/kernel/alternative.c */
void __init_or_module apply_alternatives(struct alt_instr *start,
                                          struct alt_instr *end)
{
    struct alt_instr *a;

    for (a = start; a < end; a++) {
        u8 *instr  = (u8 *)&a->instr_offset  + a->instr_offset;
        u8 *repl   = (u8 *)&a->repl_offset   + a->repl_offset;

        if (!boot_cpu_has(a->cpuid))
            continue;   /* feature not present, keep original */

        /* Patch: copy replacement bytes over original instruction.
         * NOP-pad if replacement is shorter. */
        text_poke_early(instr, repl, a->replacementlen);
        /* ... */
    }
}
```

`apply_alternatives()` is called during `start_kernel()` via `alternative_instructions()`. It iterates the `.altinstructions` section and patches each instruction in place using `text_poke_early()` (which temporarily makes `.text` writable).

### Real examples of alternative use

```c
/* LOCK prefix: present on SMP, patched out to NOP on uniprocessor (UP) kernels */
ALTERNATIVE("lock; ", "nop", X86_FEATURE_UP)

/* Fast string operations (ERMS: Enhanced REP MOVSB/STOSB) */
ALTERNATIVE("rep movsq", "rep movsb", X86_FEATURE_ERMS)

/* Memory barrier: LFENCE vs MFENCE vs nothing (for Spectre) */
ALTERNATIVE("", "lfence", X86_FEATURE_LFENCE_RDTSC)
```

---

## CPU bug flags: x86_bugs[]

In addition to feature flags, the kernel maintains a set of **bug flags** in the upper `NBUGINTS` words of `x86_capability[]`. These are set during early CPU detection to indicate that a CPU requires a mitigation:

```c
/* arch/x86/include/asm/cpufeatures.h */
/*
 * Bug flags — stored in the upper NBUGINTS words of x86_capability[].
 * The macro X86_BUG(x) places bug flags above all feature words:
 *   #define X86_BUG(x)  (NCAPINTS*32 + (x))
 * So X86_BUG_CPU_MELTDOWN = X86_BUG(14) = NCAPINTS*32 + 14.
 */
#define X86_BUG_F00F            X86_BUG( 0)  /* Intel F0 0F bug */
#define X86_BUG_FDIV            X86_BUG( 1)  /* FPU FDIV */
#define X86_BUG_AMD_APM_ERRATUM X86_BUG( 2)  /* AMD APM bug */
#define X86_BUG_CPU_MELTDOWN    X86_BUG(14)  /* CPU is vulnerable to Meltdown */
#define X86_BUG_SPECTRE_V1      X86_BUG(15)  /* CPU is vulnerable to Spectre v1 */
#define X86_BUG_SPECTRE_V2      X86_BUG(16)  /* CPU is vulnerable to Spectre v2 */
#define X86_BUG_SPEC_STORE_BYPASS X86_BUG(17) /* Speculative store bypass */
#define X86_BUG_L1TF            X86_BUG(18)  /* L1 Terminal Fault */
#define X86_BUG_MDS             X86_BUG(19)  /* Microarchitectural Data Sampling */
#define X86_BUG_MSBDS_ONLY      X86_BUG(20)
#define X86_BUG_SWAPGS          X86_BUG(21)
#define X86_BUG_TAA             X86_BUG(22)  /* TSX Async Abort */
#define X86_BUG_ITLB_MULTIHIT   X86_BUG(23)
#define X86_BUG_SRBDS           X86_BUG(24)
#define X86_BUG_MMIO_STALE_DATA X86_BUG(25)
/* ... more added with each new hardware vulnerability ... */
```

Bug flags are set in `arch/x86/kernel/cpu/bugs.c` during `check_bugs()`:

```c
/* arch/x86/kernel/cpu/bugs.c */
void __init check_bugs(void)
{
    identify_boot_cpu();

    /*
     * identify_boot_cpu() set x86_capability[].
     * Now set bug flags based on CPU family/model/stepping.
     */
    if (cpu_matches(cpu_vuln_whitelist, NO_MELTDOWN))
        ; /* not vulnerable */
    else
        setup_force_cpu_bug(X86_BUG_CPU_MELTDOWN);

    /* ... check for each vulnerability ... */
    spectre_v2_select_mitigation();
    spectre_v1_select_mitigation();
    mds_select_mitigation();
    /* ... */
}
```

---

## Key CPU features in the kernel

### X86_FEATURE_FSGSBASE

Adds `RDFSBASE`, `WRFSBASE`, `RDGSBASE`, `WRGSBASE` instructions — fast reads and writes of the FS and GS segment base registers without going through the MSR interface.

- Without FSGSBASE: setting FS.base requires `wrmsr(MSR_FS_BASE, value)` — a serializing instruction
- With FSGSBASE: `wrfsbase(value)` — much faster; used for TLS in userspace and glibc's implementation of thread-local storage

The kernel enables FSGSBASE (sets `CR4.FSGSBASE`) if the CPU supports it. Support was added in **Linux 5.9**.

### X86_FEATURE_INVPCID

`INVPCID` (Invalidate Process-Context Identifier) instruction: selectively invalidate TLB entries by PCID and virtual address, or flush all non-global entries for a specific PCID.

Without INVPCID, PCID flushing requires writing CR3 (which flushes all TLB entries for that PCID). INVPCID is more precise and faster.

Some early Haswell CPUs support PCID but not INVPCID — the kernel detects this and falls back to CR3-based flushing.

### X86_FEATURE_PKU

**Protection Keys for Userspace (PKU)**: allows user-space code to mark memory regions with a 4-bit "protection key." The `PKRU` register controls access rights (read/write disable) for each of the 16 possible keys, without requiring a syscall or page table modification.

Useful for isolating sensitive data within a process (e.g., OpenSSL's private keys). Kernel support added in **Linux 4.6**.

### X86_FEATURE_UMIP

**User-Mode Instruction Prevention**: when `CR4.UMIP = 1`, executing `SGDT`, `SIDT`, `SLDT`, `SMSW`, or `STR` in ring 3 generates a #GP instead of returning hardware descriptor table addresses.

Prevents user processes from learning the addresses of IDT, GDT, and LDT — useful for defeating ASLR bypasses. Linux enables UMIP automatically when available.

### X86_FEATURE_RDRAND

`RDRAND` instruction: hardware random number generator that returns cryptographically random values. The kernel uses it as an entropy source for `/dev/random` and friends. Note: `RDRAND` alone is not trusted as the sole entropy source in the kernel (a bug in Intel's implementation of `RDRAND` was discovered on some Ivy Bridge systems returning constant values).

---

## Observing CPU features

```bash
# Feature flags as detected by the kernel (same as CPUID output, filtered)
cat /proc/cpuinfo | grep flags | head -1 | tr ' ' '\n' | sort | grep -E "pcid|invpcid|fsgsbase|pku|umip"

# All vulnerability mitigations
grep . /sys/devices/system/cpu/vulnerabilities/*

# Raw CPUID output (userspace tool)
# Install: apt-get install cpuid / dnf install cpuid
cpuid -1        # all leaves for CPU 0
cpuid -l 7      # extended features leaf 7

# Verify that alternatives were patched
# (requires CONFIG_X86_PTDUMP or careful use of /proc/kcore)
# The presence of a feature in /proc/cpuinfo flags confirms the feature flag is set

# Alternative patching size statistics (in dmesg if CONFIG_X86_ALT_PATCHING_STATS)
dmesg | grep -i alternat

# Check a specific MSR
modprobe msr
rdmsr 0xC0000082    # LSTAR
rdmsr 0x48b         # IA32_CORE_CAPABILITIES

# See which CPUs have ERMS (Enhanced REP MOVSB/STOSB)
grep erms /proc/cpuinfo

# Check PCID support and use
dmesg | grep -i pcid
```

---

## Version notes

| Feature | Linux version | Notes |
|---------|--------------|-------|
| `static_cpu_has()` | 2.6.39 | Compile-time patchable feature check |
| `ALTERNATIVE` macro | Early; formalized ~3.x | Assembly-level patching |
| PKU support | 4.6 | `CONFIG_X86_INTEL_MEMORY_PROTECTION_KEYS` |
| UMIP enforcement | 4.19 | Automatically enabled if supported |
| FSGSBASE instructions in kernel | 5.9 | `CR4.FSGSBASE` enabled |
| `X86_BUG_*` flags for speculative execution | 4.15 | Meltdown/Spectre era |
