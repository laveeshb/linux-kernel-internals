# Spectre and Meltdown

> Hardware vulnerabilities, kernel mitigations, and performance impact

In January 2018, the coordinated disclosure of Meltdown and Spectre fundamentally changed the relationship between software and hardware. These vulnerabilities exploit CPU performance features — speculative execution and branch prediction — to leak information across privilege and process boundaries. The Linux kernel's mitigations touch nearly every hot path in the system.

---

## Background: speculative execution and cache side channels

Modern CPUs execute instructions speculatively — they predict branches and execute ahead of confirmed program flow. If the prediction is wrong, the speculatively executed results are discarded. The problem: **side effects in the cache are not discarded**.

A cache side channel works by:
1. Flushing a probe array from the cache (using `CLFLUSH`)
2. Triggering the victim to speculatively access memory and load data into the cache
3. Measuring access times to the probe array to determine which cache line was loaded
4. Inferring the secret byte from the timing difference

This is called a **Flush+Reload** or **Prime+Probe** attack. All major speculative execution vulnerabilities use variants of this technique.

---

## Meltdown (CVE-2017-5754)

### The vulnerability

Meltdown exploits a race between speculative execution and permission checks. On vulnerable Intel CPUs (and some ARM), the CPU speculatively executes memory reads from kernel addresses even in user mode, **before** the permission check that would generate a #GP or #PF fault.

```
Attack sequence:
1. User code executes: mov rax, [kernel_address]
2. CPU speculatively reads the kernel byte into rax
   (permission check not yet complete)
3. Attacker uses the value in rax as an index: mov rbx, [probe_array + rax*4096]
4. CPU raises a #GP fault (permission check completes) — speculatively loaded value is discarded
5. But the cache line for probe_array[secret_byte * 4096] is now warm
6. Attacker measures access times to probe_array — finds which byte was accessed
7. Secret kernel byte recovered
```

**Affected hardware**: Most Intel CPUs from ~2010 to ~2018 (before Coffee Lake Refresh). AMD CPUs are generally not affected. ARM Cortex-A75 is affected.

### Mitigation: KPTI

KPTI (Kernel Page Table Isolation) prevents the attack by ensuring that kernel addresses are simply **not mapped** in the page table while the CPU is running user code. If the kernel address is not in the page table, speculative reads produce a TLB miss (not a cached value), defeating the side channel.

See [page-tables.md](page-tables.md) for the full KPTI description.

```bash
cat /sys/devices/system/cpu/vulnerabilities/meltdown
# "Mitigation: PTI"         — KPTI active
# "Not affected"            — CPU not vulnerable
```

---

## Spectre v1 (CVE-2017-5753): bounds check bypass

### The vulnerability

Spectre v1 exploits speculative execution past a bounds check. The attacker trains the branch predictor to expect the branch to be taken, then causes a check to fail — but speculative execution has already read out-of-bounds data.

```c
/* Vulnerable pattern */
if (index < array_size) {
    /* CPU speculatively executes this even when index >= array_size */
    value = array[index];           /* speculative out-of-bounds read */
    sink  = probe_array[value * 4096]; /* loads secret byte into cache */
}
/* Branch predictor realizes mistake, rolls back — but cache is warm */
```

The attacker trains the branch predictor by calling the function many times with valid indices, then calls it once with a malicious index. The CPU predicts "branch taken" and speculatively reads the out-of-bounds value.

**Affected hardware**: All CPUs with branch prediction — essentially every modern CPU.

### Mitigations

**array_index_nospec()**: The primary in-kernel mitigation. It masks the index to zero if the bounds check fails, even speculatively:

```c
/* include/linux/nospec.h */
/*
 * array_index_nospec() - sanitize an array index after a bounds check.
 *
 * For a code sequence like:
 *   if (index < size) {
 *       index = array_index_nospec(index, size);
 *       val = array[index];
 *   }
 *
 * After sanitization, even in a mispredicted speculative execution path,
 * 'index' will be within bounds (or will be zero).
 */
#define array_index_nospec(index, size)                          \
({                                                               \
    typeof(index) _i = (index);                                  \
    typeof(size)  _s = (size);                                   \
    unsigned long _mask = array_index_mask_nospec(_i, _s);       \
    BUILD_BUG_ON(sizeof(_i) > sizeof(long));                     \
    (typeof(_i)) (_i & _mask);                                   \
})
```

`array_index_mask_nospec()` computes a mask that is `~0UL` when `index < size` and `0` otherwise, using arithmetic that the CPU cannot speculate around:

```c
static inline unsigned long array_index_mask_nospec(unsigned long index,
                                                      unsigned long size)
{
    /*
     * Subtract index from size, producing a borrow (bit 63) when size <= index.
     * The mask is the arithmetic right shift — all ones or all zeros.
     */
    unsigned long mask;
    asm volatile ("cmp %1,%2; sbb %0,%0;"
                  : "=r" (mask) : "g"(size), "r" (index) : "cc");
    return mask;
}
```

**Compiler mitigations**: The kernel is compiled with `-mindirect-branch=thunk-extern` (GCC) or equivalent, which also helps with Spectre v2 (below). For v1, `LFENCE` serializing fences can be inserted after bounds checks; the kernel uses this selectively in critical paths.

The syscall dispatch path uses `array_index_nospec()` to protect `sys_call_table[]` access:

```c
/* arch/x86/entry/common.c */
if (likely(unr < NR_syscalls)) {
    unr = array_index_nospec(unr, NR_syscalls);
    regs->ax = sys_call_table[unr](regs);
}
```

---

## Spectre v2 (CVE-2017-5715): branch target injection

### The vulnerability

Spectre v2 targets the **indirect branch predictor** (the BTB: Branch Target Buffer). An attacker can poison the BTB so that a victim's indirect call or jump speculatively executes attacker-controlled code.

The attack:
1. Attacker trains the BTB to associate a victim's indirect call address with the attacker's chosen target
2. When the victim executes the indirect call, the CPU speculatively jumps to the attacker's target
3. Attacker's target is a gadget that reads a secret and encodes it in the cache

This works across processes (same CPU core) and in some configurations across privilege levels (user → kernel).

**Affected hardware**: All modern CPUs with indirect branch prediction.

### Mitigation 1: Retpoline

**Retpoline** (return trampoline) is a software technique that replaces indirect calls and jumps with a sequence that defeats branch prediction for the target:

```asm
/* Retpoline sequence for an indirect call through *rax */

call    retpoline_rax_thunk

.global retpoline_rax_thunk
retpoline_rax_thunk:
    /* Step 1: Push the real target onto the stack */
    call    1f
    /* Step 2: Speculative execution ends up in a loop here */
    .align 16
2:  pause
    lfence
    jmp     2b          /* infinite speculative loop */
    /* Step 3: The real call set RIP to this point */
1:  mov     %rax, (%rsp) /* replace return address with target */
    ret                  /* speculative: loop; real: jump to target */
```

The CPU's return-address predictor (the RSB: Return Stack Buffer) predicts that `ret` will jump to the instruction after the `call 1f` — which is the `pause; lfence; jmp` loop. Speculative execution spins harmlessly in the loop. The actual (non-speculative) execution of `ret` uses the correct stack value (overwritten to `*rax`) and jumps to the real target.

The kernel is compiled with `-mindirect-branch=thunk-extern` (GCC 7.3+) to replace all indirect calls/jumps with retpoline thunks. The thunks are defined in `arch/x86/lib/retpoline.S`.

### Mitigation 2: eIBRS (Enhanced IBRS)

Newer Intel CPUs (Ice Lake and later) implement **eIBRS** (Enhanced Indirect Branch Restricted Speculation), a hardware mitigation. When `IA32_SPEC_CTRL.IBRS = 1` is set once at boot, the CPU continuously prevents cross-privilege BTB pollution — no retpoline needed.

On CPUs with eIBRS, the kernel disables retpoline and uses the hardware mitigation instead:

```bash
dmesg | grep -i "retpoline\|eibrs\|ibrs"
# "Spectre v2 : Mitigation: Retpoline"
# or
# "Spectre v2 : Mitigation: Enhanced / Automatic IBRS"
```

### Mitigation 3: IBRS (plain)

Plain **IBRS** (Indirect Branch Restricted Speculation) restricts cross-privilege BTB pollution, but must be re-enabled on every kernel entry (cleared on exit to avoid performance impact). It is slower than retpoline on CPUs without eIBRS.

```bash
cat /sys/devices/system/cpu/vulnerabilities/spectre_v2
# One of:
# "Mitigation: Retpoline"
# "Mitigation: Enhanced / Automatic IBRS"
# "Mitigation: IBRS"
# "Vulnerable"
```

---

## IBRS, IBPB, and STIBP: the three MSR-based controls

These three controls operate via `IA32_SPEC_CTRL` MSR (`0x48`) and `IA32_PRED_CMD` MSR (`0x49`):

### IBRS (Indirect Branch Restricted Speculation)

- Bit 0 of `IA32_SPEC_CTRL`
- When set: indirect branches in lower privilege levels (user) cannot influence speculative execution targets in higher privilege levels (kernel)
- Performance cost: measurable on older implementations
- eIBRS: always-on hardware version, no performance cost on modern Intel

### IBPB (Indirect Branch Predictor Barrier)

- Writing 1 to bit 0 of `IA32_PRED_CMD` flushes the indirect branch predictor state
- Used on context switch between processes: prevents process A's BTB state from influencing process B
- One-way barrier — issued by the kernel at context switch

```c
/* arch/x86/include/asm/nospec-branch.h */
static inline void indirect_branch_prediction_barrier(void)
{
    u64 val = PRED_CMD_IBPB;
    alternative_msr_write(MSR_IA32_PRED_CMD, val, X86_FEATURE_USE_IBPB);
}
```

### STIBP (Single Thread Indirect Branch Predictors)

- Bit 1 of `IA32_SPEC_CTRL`
- Prevents sibling hyperthreads from influencing each other's indirect branch prediction
- Relevant on SMT (hyper-threaded) CPUs where two hardware threads share a physical core
- The kernel can enable STIBP always, per-task (if the process requests it), or not at all

```bash
# STIBP mitigation status
cat /sys/devices/system/cpu/vulnerabilities/spectre_v2
# "Mitigation: Retpoline, IBPB: conditional, STIBP: conditional, RSB filling, PBRSB-eIBRS: Not affected"
```

---

## Spectre v4 (CVE-2018-3639): Speculative Store Bypass

### The vulnerability

The CPU may speculate that a load's address does not conflict with a recent store and bypass the store's value — reading stale data from cache or memory instead of the just-written value. An attacker can exploit this to read values that should have been overwritten.

### Mitigation: SSBD

**SSBD** (Speculative Store Bypass Disable) sets bit 2 of `IA32_SPEC_CTRL` to disable speculative store bypass globally:

```c
/* arch/x86/kernel/cpu/bugs.c */
static void ssb_select_mitigation(void)
{
    switch (ssb_mode) {
    case SPEC_STORE_BYPASS_DISABLE:
        /* Enable SSBD globally */
        x86_spec_ctrl_base |= SPEC_CTRL_SSBD;
        wrmsrl(MSR_IA32_SPEC_CTRL, x86_spec_ctrl_base);
        break;
    case SPEC_STORE_BYPASS_PRCTL:
        /* Enable per-thread via prctl(PR_SET_SPECULATION_CTRL) */
        break;
    /* ... */
    }
}
```

User processes can request SSBD via:

```c
prctl(PR_SET_SPECULATION_CTRL, PR_SPEC_STORE_BYPASS, PR_SPEC_DISABLE, 0, 0);
```

The kernel sets the SSBD bit when scheduling in such a thread and clears it on context switch out.

```bash
cat /sys/devices/system/cpu/vulnerabilities/spec_store_bypass
# "Mitigation: Speculative Store Bypass disabled via prctl"
# or "Vulnerable"
```

---

## MDS: Microarchitectural Data Sampling (CVE-2018-12130, etc.)

MDS is a family of vulnerabilities that allow leaking data from CPU internal buffers (line fill buffer, store buffer, load ports) to an attacker on the same physical CPU core.

Variants:
- **MFBDS** (CVE-2018-12130): Microarchitectural Fill Buffer Data Sampling (ZombieLoad)
- **MLPDS** (CVE-2018-12127): Microarchitectural Load Port Data Sampling
- **MSBDS** (CVE-2018-12126): Microarchitectural Store Buffer Data Sampling (Fallout)
- **MDSUM** (CVE-2019-11091): Microarchitectural Data Sampling Uncacheable Memory

### Mitigation: VERW

The `VERW` instruction (originally for segment verification) was repurposed on affected Intel CPUs to flush the relevant microarchitectural buffers as a side effect when executed just before transitioning from kernel to user mode or entering a guest VM.

```asm
/* arch/x86/entry/entry_64.S — before SYSRET/IRET */
/* On MDS-affected CPUs: */
sub     $8, %rsp
mov     %ds, (%rsp)
verw    (%rsp)       /* flush CPU buffers */
add     $8, %rsp
```

This is applied via the alternatives mechanism:

```c
/* arch/x86/include/asm/nospec-branch.h */
static inline void mds_clear_cpu_buffers(void)
{
    static const u16 ds = __KERNEL_DS;
    asm volatile("verw %[ds]" : : [ds] "m" (ds) : "cc");
}
```

`VERW` is cheap (a few cycles) but must be executed on every kernel→user transition, adding a small constant overhead.

```bash
cat /sys/devices/system/cpu/vulnerabilities/mds
# "Mitigation: Clear CPU buffers; SMT vulnerable"
# "Not affected"
```

---

## Performance impact

The mitigations impose measurable overhead, concentrated in syscall-heavy and context-switch-heavy workloads:

| Vulnerability | Mitigation | Typical overhead |
|---------------|------------|-----------------|
| Meltdown | KPTI (PTI) | 5–30% on syscall-heavy workloads; ~5% with PCID |
| Spectre v2 | Retpoline | 2–15% depending on indirect call frequency |
| Spectre v2 | eIBRS (hardware) | ~1% (modern Intel Ice Lake+) |
| Spectre v1 | `array_index_nospec` | Negligible (a few instructions per check) |
| IBPB | Per context-switch | 1–10% on context-switch-heavy workloads |
| STIBP | Continuous | 5–15% on SMT systems (when always-on) |
| MDS | VERW per exit | ~1-2% (a few cycles per kernel exit) |
| Spectre v4 | SSBD | 2–8% when enabled per-thread; negligible when off |

Workload-specific impact:
- **Database servers (PostgreSQL, MySQL)**: high syscall rate → KPTI and IBPB have the most impact
- **Web servers (nginx, Apache)**: moderate syscall rate; retpoline overhead visible
- **HPC / batch compute**: mostly user-space computation; mitigations largely invisible
- **Container orchestration**: high context-switch rate; IBPB overhead matters

```bash
# Measure syscall overhead before/after (compare with mitigations off vs on)
# Boot with: mitigations=off   (disables all; only for isolated benchmarking!)
# Normal:    mitigations=auto  (default)
# Maximum:   mitigations=auto,nosmt

# Quick syscall benchmark
perf stat -e instructions,cycles,cache-misses -r 5 \
    bash -c 'for i in $(seq 100000); do :; done'

# Measure CR3 switch cost (KPTI)
perf stat -e dTLB-load-misses,iTLB-load-misses ls

# See retpoline stats
grep . /sys/devices/system/cpu/vulnerabilities/*
dmesg | grep -E "Spectre|Meltdown|MDS|retpoline|IBRS|IBPB|STIBP|VERW"
```

---

## Mitigation control

The kernel provides several ways to control mitigations:

### Boot parameters

```bash
# Disable all mitigations (dangerous! only for benchmarking in isolated environments)
mitigations=off

# Default auto-selection
mitigations=auto

# Also disable SMT (hyper-threading) for strongest isolation
mitigations=auto,nosmt

# Individual controls
nopti                    # disable KPTI
nospectre_v1             # disable Spectre v1 mitigations
nospectre_v2             # disable Spectre v2 mitigations
spec_store_bypass_disable=off  # disable SSBD
mds=off                  # disable MDS mitigation
```

### Runtime control (per-process)

```c
/* Spectre v4 / SSBD — user can request mitigation for their process */
prctl(PR_SET_SPECULATION_CTRL, PR_SPEC_STORE_BYPASS, PR_SPEC_DISABLE, 0, 0);
prctl(PR_SET_SPECULATION_CTRL, PR_SPEC_INDIRECT_BRANCH, PR_SPEC_DISABLE, 0, 0);
```

### Observing all mitigations at once

```bash
grep . /sys/devices/system/cpu/vulnerabilities/*
# /sys/devices/system/cpu/vulnerabilities/itlb_multihit:KVM: Mitigation: VMX disabled
# /sys/devices/system/cpu/vulnerabilities/l1tf:Not affected
# /sys/devices/system/cpu/vulnerabilities/mds:Not affected
# /sys/devices/system/cpu/vulnerabilities/meltdown:Not affected
# /sys/devices/system/cpu/vulnerabilities/mmio_stale_data:Not affected
# /sys/devices/system/cpu/vulnerabilities/retbleed:Not affected
# /sys/devices/system/cpu/vulnerabilities/spec_rstack_overflow:Not affected
# /sys/devices/system/cpu/vulnerabilities/spec_store_bypass:Mitigation: Speculative Store Bypass disabled via prctl
# /sys/devices/system/cpu/vulnerabilities/spectre_v1:Mitigation: usercopy/swapgs barriers and __user pointer sanitization
# /sys/devices/system/cpu/vulnerabilities/spectre_v2:Mitigation: Retpoline; IBPB: conditional; IBRS_FW; STIBP: conditional; RSB filling; PBRSB-eIBRS: Not affected; BHI: Not affected
# /sys/devices/system/cpu/vulnerabilities/srbds:Not affected
# /sys/devices/system/cpu/vulnerabilities/tsx_async_abort:Not affected
```

---

## Timeline

| Date | Event |
|------|-------|
| Jan 3, 2018 | Coordinated public disclosure of Meltdown and Spectre v1/v2 |
| Jan 2, 2018 | Linux 4.15 released with KPTI (Meltdown fix) |
| Jan 2018 | Retpoline technique published by Google; kernel 4.15 gains retpoline |
| May 2018 | Spectre v4 (SSBD) disclosed; kernel 4.17 adds SSBD prctl |
| May 2018 | L1TF (Foreshadow) disclosed; kernel 4.19 adds mitigations |
| May 2019 | MDS (Zombieload) disclosed; kernel 5.1 adds VERW flush |
| Nov 2019 | TAA (TSX Async Abort); kernel 5.4 adds mitigation |
| 2020+ | Continued stream of microarchitectural vulnerabilities; mitigations added per release |
