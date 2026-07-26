# x86 Architecture War Stories

> Real incidents: KPTI regression, TSC drift, SYSRET bug, and more

The x86 architecture's complexity — decades of backward compatibility, microarchitectural quirks, and hardware-software interface subtleties — produces a steady stream of real-world incidents. These are five such incidents drawn from public kernel commit logs, CVE disclosures, LWN articles, and vendor advisories. Each had measurable impact on production systems.

---

## Case 1: KPTI performance regression on database workloads

### Before state

When KPTI (Kernel Page Table Isolation) shipped in Linux 4.15 in January 2018, it was an urgent Meltdown fix that had to land quickly. The mitigation was correct and effective, but its performance implications were not fully characterized before release.

PostgreSQL, MySQL, and other database servers make system calls at very high rates: `read()`, `write()`, `lseek()`, `fsync()`, `futex()` on hot paths. A PostgreSQL instance processing OLTP transactions might execute hundreds of thousands of syscalls per second per core.

### The regression

Teams running PostgreSQL 10 on Linux 4.15 immediately after the kernel upgrade reported throughput drops of **15–30%** on TPC-B-like benchmarks. The regression was not in any PostgreSQL code — the workload was identical. The kernel upgrade alone caused it.

### Diagnosis

`perf stat` told the story:

```bash
perf stat -e dTLB-load-misses,iTLB-load-misses,cycles \
          -p $(pgrep postgres | head -1) sleep 10

# Before KPTI: dTLB-load-misses ~0.1% of loads
# After  KPTI: dTLB-load-misses ~8-15% of loads (TLB is being trashed)
```

`perf record` with stack traces showed time concentrated in `native_write_cr3()` and the entry/exit trampoline code — the CR3-switching overhead. Each syscall required two CR3 loads (user PGD → kernel PGD on entry, kernel PGD → user PGD on exit), each of which flushed the TLB on CPUs without PCID.

The fundamental issue: without PCID, every CR3 load on entry/exit discards all TLB entries for the current CPU. A PostgreSQL worker doing 200,000 syscalls/second was refilling the TLB 400,000 times/second per core.

### Root cause

KPTI was designed with the PCID optimization in mind but it could only be used on CPUs that also support `INVPCID`. The initial KPTI implementation fell back to the slower (full TLB flush) path on CPUs that have PCID but lack `INVPCID` — which included some production Haswell server CPUs.

Even on CPUs with full PCID+INVPCID support, the KPTI PCID optimization (the dual-ASID scheme using kernel PCID = user ASID | 0x80, i.e., bit 7 set) was not enabled by default in the very first KPTI patches and had to be explicitly enabled and then auto-detected.

### Fix

The PCID optimization was refined and verified across CPU generations. For CPUs with PCID+INVPCID support, the kernel:

1. Assigns each process two PCIDs: one for the user PGD (e.g., PCID 5) and one for the kernel PGD (e.g., PCID 5 | 0x80 = 133)
2. Loads CR3 with `bit 63 = 1` (no TLB flush) when switching between the two PGDs for the same process — because the TLB entries tagged with the old PCID remain valid
3. Uses `INVPCID` to selectively invalidate entries when required (e.g., after `munmap`)

With the PCID optimization, the KPTI overhead on syscall-heavy workloads dropped to approximately 5%.

### Checking the current state

```bash
# Is KPTI active?
cat /sys/devices/system/cpu/vulnerabilities/meltdown
# "Mitigation: PTI"  = KPTI on
# "Not affected"     = CPU immune, no KPTI needed

# Is PCID being used? (check for PCID in CPU flags)
grep pcid /proc/cpuinfo

# KPTI + PCID optimization — look in dmesg
dmesg | grep -i "pcid\|pti\|kpti"

# Measure syscall overhead directly
time (for i in $(seq 100000); do true; done)
```

### What it taught us

Correctness-first security fixes can have severe performance consequences on specific workloads. The PCID optimization was known in advance but could not be validated across all CPU generations under production load before the January 2018 embargo lifted. Subsequent kernel releases (4.15.x, 4.16) refined the PCID path. This incident led to better benchmarking practices for security mitigations and more focus on CPU-model-specific fallbacks.

---

## Case 2: TSC drift on multi-socket systems

### Before state

The **TSC** (Time Stamp Counter) is an x86 register that increments at a fixed rate (on modern CPUs, the "invariant TSC" from CPUID leaf 0x80000007). It is the cheapest way to get a timestamp — a single `RDTSC` instruction with no kernel call overhead.

The Linux kernel uses the TSC as the primary clocksource (`clocksource=tsc`) on systems where it is deemed reliable. The vDSO's `clock_gettime(CLOCK_REALTIME)` reads from vvar data that is seqlock-protected and TSC-based — all in userspace, no syscall.

### The problem

On dual-socket (and larger) NUMA servers, operators observed that `gettimeofday()` returned **time that went backwards**. Applications logging timestamps in sequence would sometimes record a later event with an earlier timestamp than a prior event. Database replication systems using wall-clock time for ordering would fail their ordering guarantees.

```
T1 (thread on socket 0): timestamp = 1234567890.100
Thread migrates to socket 1
T2 (thread on socket 1): timestamp = 1234567889.998  ← time went backwards!
```

This produced assertion failures in log analyzers, replication ordering bugs, and mysterious "time skew" alerts.

### Diagnosis

The TSC counters on different sockets are not guaranteed to be synchronized at power-on. While BIOS firmware attempts to synchronize them, the synchronization is not perfect, and on some platforms the drift can be hundreds of microseconds or more at boot. Additionally, TSC values can diverge over time on older CPUs due to different clock domains per socket running at slightly different rates (this is mitigated by the "invariant TSC" feature on Nehalem and later, but the boot synchronization problem remains).

The kernel detects TSC reliability via the `tsc_reliable` flag (set based on CPUID and calibration) and the result of `tsc_clocksource_reliable` checks in `arch/x86/kernel/tsc.c`. TSC synchronization across CPUs is tested during boot in `check_tsc_sync_source()` and `check_tsc_sync_target()`.

```c
/* arch/x86/kernel/tsc_sync.c */
/*
 * Called by each secondary CPU to compare its TSC against the boot CPU.
 * If the difference exceeds a threshold, the TSC is marked unreliable.
 */
void check_tsc_sync_target(void)
{
    struct tsc_adjust *ref, *cur;
    cycles_t cur_max_warp;

    /* Read TSC and compare with boot CPU's TSC */
    /* If delta > threshold: mark TSC unreliable */
    if (nr_warps) {
        mark_tsc_unstable("TSC ADJUST differs");
    }
}
```

If the kernel detects TSC drift or skew, it falls back to the HPET (High Precision Event Timer) or ACPI PM timer as the clocksource.

### Root cause

Two separate issues:

1. **Boot synchronization drift**: TSC counters on each socket start from different values at power-on. Even a 1 microsecond difference means any process migrated from socket 0 to socket 1 (or reading from a CPU on the other socket via a shared `vvar` page) sees apparent time reversal.

2. **Task migration without TSC adjustment**: When a task migrates between CPUs on different sockets, the new CPU's TSC may be ahead or behind. If the kernel's timekeeping is not socket-aware, the vDSO reads the wrong TSC base.

### Fix and mitigations

**Kernel-side detection and fallback**: When `check_tsc_sync_source()` detects significant TSC skew between CPUs, it calls `mark_tsc_unstable()` which switches the clocksource from `tsc` to `hpet` or `acpi_pm`. This is visible in `dmesg`:

```
Detected 1 TSC warp(s) in TSC synchronization.
Marking TSC unstable due to: TSC ADJUST differs.
Switched to clocksource hpet
```

**TSC_ADJUST MSR**: Newer Intel CPUs (Skylake+) have the `TSC_ADJUST` MSR (0x3B), which allows firmware and the OS to apply per-CPU offsets to align TSC values. The kernel reads and validates `TSC_ADJUST` values in `tsc_sync.c`.

**`rdtsc_ordered()`**: The kernel's own RDTSC usage uses `rdtsc_ordered()` which adds a memory fence:

```c
/* arch/x86/include/asm/msr.h */
static __always_inline u64 rdtsc_ordered(void)
{
    /*
     * The RDTSC instruction is not ordered relative to memory access.
     * Add a serializing instruction (LFENCE) to ensure ordering.
     */
    WARN_ON_ONCE(preemptible());
    return rdtsc();  /* on x86-64 with LFENCE_RDTSC feature */
}
```

**Clocksource selection**: operators with multi-socket servers and TSC reliability concerns can force a stable clocksource:

```bash
# Check current clocksource
cat /sys/devices/system/clocksource/clocksource0/current_clocksource
# tsc

# Check available clocksources
cat /sys/devices/system/clocksource/clocksource0/available_clocksource
# tsc hpet acpi_pm

# Force HPET (lower overhead than acpi_pm, more reliable than tsc on affected HW)
echo hpet > /sys/devices/system/clocksource/clocksource0/current_clocksource

# Or set via boot parameter (permanent)
# clocksource=hpet
```

### What it taught us

TSC unreliability on multi-socket systems is well-known but the failure mode (time going backwards) surprises developers who assume wall-clock time is monotonic. Linux's TSC synchronization infrastructure (`tsc_sync.c`) and the VDSO's seqlock-protected time data are designed to handle this, but the fallback to HPET has real performance implications: HPET requires a ring transition, so `clock_gettime()` is no longer vDSO-fast. The lesson: never assume the TSC is synchronized across sockets without verifying `dmesg` and the current clocksource.

---

## Case 3: AMD SYSRET canonical address bug (CVE-2012-0217)

### Before state

`SYSRET` (the 64-bit return instruction, counterpart to `SYSCALL`) has a subtle behavior: it loads `CS` and sets privilege level to ring 3 **before** loading `RIP` from `RCX`. This means there is a brief moment — between the CS load and the RIP load — where the CPU is in ring 3 but has not yet set the user RIP.

### The vulnerability

On AMD processors, if the `RCX` register (which holds the user-space return address) contains a **non-canonical address** (an address where bits 63:48 are not a sign extension of bit 47), AMD's `SYSRET` checks RIP canonicality **after** switching the privilege level to ring 3. The resulting `#GP` therefore fires from ring 3, not ring 0. Normal exception delivery from ring 3 then uses the TSS to switch back to ring 0 — and the TSS stack pointer becomes the attack vector if it can be influenced.

On Intel processors, the non-canonical check happens **before** the privilege level change, so `#GP` is raised while still in ring 0 with the kernel stack, which is safe.

The vulnerability was AMD-specific in its exploitable form. However, Xen (the hypervisor) and early Linux code shared the same vulnerable pattern.

### Discovery and impact

The vulnerability was discovered by Rafal Wojtczuk and reported in 2012 (CVE-2012-0217). It affected:
- Xen paravirtualized guests on AMD hosts (the Xen `SYSRET` path)
- Linux kernels on AMD hardware
- NetBSD, FreeBSD, and other OS kernels using `SYSRET`

An unprivileged user process could gain full kernel (ring 0) execution.

### Root cause

The kernel's `entry_SYSCALL_64` return path checked the return address, but the check was not in the right place — it happened after the point where a non-canonical address in `RCX` could cause trouble. The fix requires checking `RCX` for canonicality before issuing `SYSRET`, and falling back to `IRET` if the address is non-canonical.

### Fix

The Linux fix (applied in 3.4.5 / 3.5 stable):

```c
/* arch/x86/entry/entry_64.S (post-fix, simplified) */
/*
 * If the return address (RCX) is non-canonical, we cannot use SYSRET.
 * SYSRET with a non-canonical RCX would #GP in ring 0 with user RSP.
 * Use IRET instead, which handles the privilege level change safely.
 */
testq   $0xffff000000000000, %rcx
jnz     swapgs_restore_regs_and_return_to_usermode  /* use IRET path */

/* Normal case: canonical address, safe to SYSRET */
USERGS_SYSRET64
```

The IRET fallback path (`swapgs_restore_regs_and_return_to_usermode`) restores all registers and uses the `IRET` instruction, which handles non-canonical return addresses by raising `#GP` at the correct privilege level (ring 3, with the correct stack).

Xen implemented the same fix in its `SYSRET` emulation path.

### Observing the fix

```bash
# The fix is in the SYSRET path — visible at:
grep -n "SYSRET\|non_canonical\|swapgs_restore" \
    arch/x86/entry/entry_64.S

# On an affected system, an unprivileged user could reproduce the bug by:
# 1. Calling a syscall with mmap to create a mapping at a non-canonical address
# 2. Using the non-canonical address as a stack return (via manipulation of the
#    sigreturn frame or direct thread-local RIP manipulation)
# Fixed kernels check RCX before SYSRET.
```

### What it taught us

The `SYSCALL`/`SYSRET` instruction pair has documented edge cases that differ between Intel and AMD implementations. The Linux kernel (and Xen) relied on behavior that is safe on Intel but exploitable on AMD. This case illustrates why the AMD architecture manuals must be read independently of Intel's, and why fuzzing and formal analysis of privilege transition code is important. The fix — a single canonical-address check — is cheap and correct, but it took a working exploit to surface the need for it.

---

## Case 4: Spectre v2 retpoline breaking BPF JIT indirect calls

### Before state

The BPF JIT compiler (in `arch/x86/net/bpf_jit_comp.c`) translates BPF bytecode into native x86-64 machine code at runtime. BPF helper function calls are compiled as indirect calls: the JIT emits code that calls through a function pointer.

Before Spectre v2 mitigations, a BPF helper call compiled to something like:

```asm
mov     rax, [helper_ptr]
call    *rax              /* direct indirect call */
```

### The problem

When the kernel is compiled with `-mindirect-branch=thunk-extern` to enable retpoline, the compiler replaces all indirect `call *rax` instructions in C code with retpoline thunk calls. But **the BPF JIT emits machine code directly** — it does not go through the compiler. The JIT was emitting bare `call *rax` instructions even after retpoline was required by the mitigation.

This meant that BPF programs, which run in kernel context, were making JIT-compiled indirect calls that were **not retpoline-protected** — leaving them as a potential Spectre v2 gadget.

Additionally, some BPF programs use tail calls (`BPF_TAIL_CALL`), which are indirect jumps. These also required retpoline treatment.

### Diagnosis

The issue was identified during the post-Spectre code audit. Security researchers reviewing the JIT output (obtainable from `/proc/sys/net/core/bpf_jit_dump` or BPF disassemblers) noticed that `call *rax` appeared in JIT output despite the kernel being compiled with retpoline.

### Fix

The BPF JIT was updated to emit retpoline sequences directly for all indirect calls and tail calls. Since the JIT emits raw bytes, it had to manually emit the retpoline byte sequence:

```c
/* arch/x86/net/bpf_jit_comp.c (post-fix) */

/* Emit a retpoline-safe indirect call through 'reg' */
static void emit_indirect_call(u8 **pprog, int reg)
{
    u8 *prog = *pprog;

    if (cpu_feature_enabled(X86_FEATURE_RETPOLINE_LFENCE)) {
        /* AMD retpoline variant: LFENCE; JMP *reg */
        EMIT3(0x0F, 0xAE, 0xE8);   /* LFENCE (3-byte: 0F AE E8) */
        EMIT2(0xFF, 0xE0 + reg); /* JMP *reg (opcode FF /4, e.g. FF E0 = JMP rax) */
    } else {
        /* Intel retpoline: call into thunk */
        /* emit: call __x86_indirect_thunk_rax (or appropriate reg) */
        emit_call(&prog, __x86_indirect_thunk_array[reg], prog);
    }
    *pprog = prog;
}
```

For tail calls (indirect jumps), a similar retpoline jump sequence was emitted.

The fix also affected the JIT for `BPF_CALL` instructions that call into kernel helper functions, and the tail call mechanism which uses an indirect jump through the BPF program array.

### Performance vs security tradeoff

Retpoline adds overhead to every BPF helper call — typically a handful of additional cycles. For BPF programs doing many helper calls (e.g., map lookups in XDP programs), this is measurable. The tradeoff was accepted because BPF programs run in kernel context and a Spectre v2 gadget in JIT output is exactly as dangerous as one in kernel C code.

On CPUs with eIBRS (hardware Spectre v2 mitigation, available on Ice Lake+), the kernel can use a faster calling convention since eIBRS makes the hardware-level protection always-on:

```bash
# Check if eIBRS is in use (affects BPF JIT behavior)
cat /sys/devices/system/cpu/vulnerabilities/spectre_v2
# "Mitigation: Enhanced / Automatic IBRS" = eIBRS, faster BPF calls
# "Mitigation: Retpoline" = software retpoline, every indirect call is a thunk
```

### What it taught us

JIT compilers are a special case in the mitigation story. The compiler-based mitigations (`-mindirect-branch=thunk-extern`) only work for C code compiled by GCC/Clang — they have no effect on machine code emitted at runtime by JIT compilers, interpreters, or hand-written assembly. Every JIT in the kernel (BPF, KVM's instruction emulator, etc.) had to be audited and updated independently. This drove the development of better tooling for auditing JIT output and better abstractions for emitting retpoline sequences from JIT code.

---

## Case 5: INVPCID not available on early Haswell CPUs

### Before state

PCID (Process-Context Identifiers) was introduced in Intel Sandy Bridge (2011) and allows the TLB to cache entries tagged with a process identifier, avoiding full TLB flushes on context switches. The KPTI PCID optimization (Linux 4.15) uses PCID to reduce the overhead of the dual-PGD CR3 switches required for Meltdown mitigation.

The `INVPCID` instruction (Invalidate Process-Context Identifier) allows selective TLB invalidation by PCID. It is required for the full KPTI+PCID optimization because:
- Without INVPCID, flushing a specific PCID requires loading CR3 with the no-flush bit cleared, which is a broader operation
- With INVPCID, you can invalidate exactly the entries you need

### The problem

Early Haswell CPUs (released in 2013) support PCID (the `pcid` bit appears in `/proc/cpuinfo`) but **do not support INVPCID** (`invpcid` is absent). This was a known errata/stepping issue: INVPCID was added to the CPUID feature bits in later Haswell steppings.

When the KPTI patches shipped in Linux 4.15, the initial PCID optimization path checked only for `X86_FEATURE_PCID` and attempted to use INVPCID. On early Haswell systems, this would cause an **Undefined Instruction (#UD) fault** when the kernel first tried to execute `INVPCID` — crashing on boot.

Additionally, some VM hypervisors (particularly older KVM and VMware versions) would expose PCID in CPUID but not properly virtualize INVPCID, causing the same boot crash in VMs.

### Diagnosis

The boot crash produced a message like:

```
kernel BUG at arch/x86/mm/tlb.c:!
invalid opcode: 0000 [#1] SMP PTI
CPU: 0 PID: 0 Comm: swapper/0 Not tainted 4.15.0
RIP: 0010:invpcid_flush_one
```

The instruction that faulted was the `INVPCID` instruction itself (opcode `66 0F 38 82 /r`).

### Root cause

The KPTI PCID code checked `X86_FEATURE_PCID` but not `X86_FEATURE_INVPCID` separately. The fix required checking both features and implementing a fallback path when INVPCID is unavailable.

### Fix

The kernel was updated to check both CPUID bits independently:

```c
/* arch/x86/include/asm/tlbflush.h (post-fix) */

/*
 * We use PCID only if both PCID and INVPCID are supported.
 * If PCID is available but INVPCID is not, PCID provides no benefit
 * for KPTI (we would need full CR3 reloads for the TLB invalidations
 * that INVPCID would handle selectively).
 */
static inline bool cpu_has_pcid(void)
{
    return boot_cpu_has(X86_FEATURE_PCID) &&
           boot_cpu_has(X86_FEATURE_INVPCID);
}
```

For the case where PCID is present but INVPCID is not, the kernel falls back to CR3 reload (clearing PCID and doing a full TLB flush where needed). This is slower than the PCID+INVPCID fast path but correct.

A separate fallback handles early INVPCID emulation in virtualized environments where the hypervisor does not expose the instruction.

```bash
# Check both PCID and INVPCID separately
grep -E '\bpcid\b|\binvpcid\b' /proc/cpuinfo

# If pcid is present but invpcid is absent: PCID optimization is disabled
# If both are present: KPTI PCID optimization is active

# Verify via dmesg
dmesg | grep -i "pcid\|invpcid"

# On affected systems (no invpcid), KPTI overhead is higher:
# Each syscall does a full TLB flush on CR3 switch
perf stat -e dTLB-load-misses,iTLB-load-misses -p $$ sleep 5
```

### What it taught us

CPUID feature bits cannot be assumed to be complete, consistent, or independent. A CPU can report PCID support while lacking INVPCID — a configuration that is useful in isolation (PCID works for normal context switches) but that the kernel's KPTI path could not use correctly without both. The fix required treating PCID and INVPCID as independent features and implementing the correct fallback for every combination.

This case is also a good example of why the kernel's feature detection and alternative patching infrastructure exists: `X86_FEATURE_*` flags and the `cpu_has()` family of functions provide a single authoritative source of truth for capability checks, making it possible to audit all the places a feature is required and add missing checks consistently.

---

## Further reading

### Sources

- [CVE-2012-0217 (NVD)](https://nvd.nist.gov/vuln/detail/CVE-2012-0217) — CVE-2012-0217, the SYSRET non-canonical-address privilege escalation (the vulnerable behavior is Intel's SYSRET; AMD CPUs are unaffected)
- [arch/x86/kernel/tsc.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/tsc.c) — TSC calibration and watchdog, scene of Case 2
- [Spectre Side Channels](https://docs.kernel.org/admin-guide/hw-vuln/spectre.html) — retpoline and its interaction with indirect calls (Case 4)

### Related pages

- [x86-64 Syscall Entry](syscall-entry.md) — the SYSRET path exploited in Case 3
- [Spectre and Meltdown](spectre-meltdown.md) — background for the KPTI and retpoline cases
- [x86 CPU Features](cpu-features.md) — feature detection, INVPCID fallback (Case 5)
