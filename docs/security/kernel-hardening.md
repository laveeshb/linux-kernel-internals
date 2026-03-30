# Kernel Hardening: KASLR, Stack Protectors, and Spectre Mitigations

> Defense-in-depth: making exploitation harder after a vulnerability is found

## Defense layers

Modern Linux implements multiple hardening techniques at different levels:

```
Hardware level:      SMEP/SMAP/CET (Intel), PAN/PXN (ARM)
Kernel compilation:  KASLR, stack canaries, CFI, FORTIFY_SOURCE
Runtime:             ASLR (userspace), seccomp, namespaces, SELinux
CPU microcode:       Spectre/Meltdown mitigations, IBRS, STIBP
```

## KASLR: Kernel Address Space Layout Randomization

KASLR randomizes where the kernel and its modules are loaded in memory, making it harder for an attacker to use known kernel addresses in exploits:

```bash
# Check if KASLR is enabled:
cat /proc/sys/kernel/randomize_va_space
# 2 = full ASLR (userspace + vDSO)

# Check if kernel itself is randomized:
dmesg | grep KASLR
# [    0.000000] KASLR enabled

# Kernel base address (available to root):
cat /proc/kallsyms | grep "_text" | head -1
# ffffffffc1000000 T _text  ← random base each boot

# KASLR offset from compile-time base:
# amd64: randomizes text and module regions separately
# range: +-512MB for text, +-1.5GB for modules
```

```
Boot time:
  Decompressor generates random offset (from RDRAND or RDSEED or RTC jitter)
  Maps kernel at: 0xFFFFFFFF81000000 + random_offset
  Sets up page tables with new addresses
```

**Bypass**: KASLR is defeated by:
- Kernel pointer leaks via `/proc`, uninitialized reads, or info-disclosure bugs
- `CONFIG_RANDOMIZE_BASE=n` in non-default configs

```bash
# Harden against pointer leaks:
echo 2 > /proc/sys/kernel/kptr_restrict      # hide kernel pointers from all
echo 1 > /proc/sys/kernel/dmesg_restrict     # require CAP_SYSLOG for dmesg
```

## Stack canaries (stack-protector)

Compiler-inserted canaries detect stack buffer overflows before return:

```c
/* With CONFIG_STACKPROTECTOR: */
void vulnerable_function(char *input)
{
    /* Compiler inserts: */
    unsigned long __stack_chk_guard_local = __stack_chk_guard; /* canary */

    char buf[64];
    strcpy(buf, input);  /* potential overflow */

    /* Compiler inserts before return: */
    if (__stack_chk_guard_local != __stack_chk_guard)
        __stack_chk_fail();   /* PANIC: stack smashing detected */
}

/* __stack_chk_fail in the kernel: */
void __stack_chk_fail(void)
{
    panic("stack-protector: Kernel stack is corrupted in: %pB\n",
          __builtin_return_address(0));
}
```

```bash
# Check if stack protector is enabled:
grep CONFIG_STACKPROTECTOR /boot/config-$(uname -r)
# CONFIG_STACKPROTECTOR=y
# CONFIG_STACKPROTECTOR_STRONG=y  ← protects more functions (slower)

# Verify it fires:
dmesg | grep "stack-protector"
# If a corruption is detected: kernel panic with function address
```

## SMEP and SMAP (Intel x86)

**SMEP** (Supervisor Mode Execution Prevention): prevents kernel from executing userspace code pages.
**SMAP** (Supervisor Mode Access Prevention): prevents kernel from accessing userspace memory unexpectedly.

```bash
# Check hardware support:
grep -m1 smep /proc/cpuinfo  # smep in flags
grep -m1 smap /proc/cpuinfo  # smap in flags

# Check kernel uses them:
grep CONFIG_X86_SMAP /boot/config-$(uname -r)
# CONFIG_X86_SMAP=y

# SMEP: CR4.SMEP bit must be set (verified at boot)
# SMAP: kernel uses stac/clac instructions around copy_to_user

# ARM64 equivalents:
# PAN (Privileged Access Never) = SMAP
# PXN (Privileged Execute Never) = SMEP
```

## HARDENED_USERCOPY

Prevents kernel bugs that could copy too much data to/from userspace:

```bash
CONFIG_HARDENED_USERCOPY=y
# Adds bounds checking to copy_to_user/copy_from_user:
# - Is the kernel pointer pointing to a valid slab object?
# - Is the copy size within the object's bounds?
# - Not a stack address that we're copying?

# If violated:
# usercopy: Kernel memory overwrite attempt detected to slab ... size=xxx ...
```

## FORTIFY_SOURCE

Compiler-inserted bounds checking for common string/memory functions:

```c
/* CONFIG_FORTIFY_SOURCE=y: */
/* The kernel's memcpy becomes: */
#define memcpy(dst, src, n) \
    __builtin_memcpy_chk(dst, src, n, __builtin_object_size(dst, 0))
/* __builtin_object_size provides compile-time or runtime size of dst */
/* If n > size(dst): __fortify_panic() */

/* At runtime for variable-size objects: */
static inline void *memcpy(void *dst, const void *src, size_t len)
{
    size_t p_size = __builtin_object_size(p, 0);
    if (len > p_size)
        fortify_panic("memcpy", ...);
    return __underlying_memcpy(dst, src, len);
}
```

## Spectre and Meltdown mitigations

### Meltdown (CVE-2017-5754)

Meltdown allows userspace to read kernel memory via speculative execution. Mitigated by **KPTI** (Kernel Page-Table Isolation):

```bash
# Check KPTI status:
dmesg | grep -i "page table isolation\|PTI"
# [    0.000000] Kernel/User page tables isolation: enabled

# KPTI cost:
# - Separate page tables for kernel and user mode
# - On every syscall: TLB flush + CR3 switch (expensive)
# - Mitigated with PCID hardware feature

# Check PCID support:
grep pcid /proc/cpuinfo | head -1
# flags: ... pcid ...  ← TLB tagged by address space, no flush needed
```

### Spectre v1 (CVE-2017-5753): Bounds Check Bypass

```c
/* Vulnerable pattern (Spectre v1): */
if (index < array_size)          /* bounds check - may be speculatively bypassed */
    return array[index];          /* speculative read of out-of-bounds data */

/* Mitigation: array_index_nospec() */
index = array_index_nospec(index, array_size);
/* Uses conditional move (cmov) to sanitize index without a branch */
/* Defeats speculative bypass of the bounds check */
return array[index];
```

### Spectre v2 (CVE-2017-5715): Branch Target Injection

```bash
# Mitigation: Retpoline (return trampoline)
# Replace indirect branch with return + trampoline:
# IBRS (Indirect Branch Restricted Speculation)
# eIBRS (Enhanced IBRS): hardware mitigation on newer CPUs

# Check mitigation status:
cat /sys/devices/system/cpu/vulnerabilities/spectre_v2
# Mitigation: Enhanced / IBRS, IBPB: conditional, RSB filling, PBRSB-eIBRS: SW sequence

# IBPB: Indirect Branch Predictor Barrier
# Flush branch predictor on context switch (expensive: ~4000 cycles)
grep ibpb /proc/cpuinfo   # ibpb in flags
cat /sys/kernel/debug/x86/ibpb_enabled  # 0/1
```

### MDS/TAA mitigations

```bash
# Check all CPU vulnerability status:
cat /sys/devices/system/cpu/vulnerabilities/*
# itlb_multihit: Not affected
# l1tf: Mitigation: PTE Inversion
# mds: Mitigation: Clear CPU buffers; SMT disabled
# meltdown: Mitigation: PTI
# spec_store_bypass: Mitigation: Speculative Store Bypass disabled via prctl
# spectre_v1: Mitigation: usercopy/swapgs barriers and __user pointer sanitization
# spectre_v2: Mitigation: Enhanced / IBRS, IBPB: conditional
# srbds: Not affected
# tsx_async_abort: Not affected

# Disable mitigations for benchmarking (DANGEROUS - testing only):
# Boot with: mitigations=off
# or: nospectre_v1 nospectre_v2 nopti mds=off
```

## CFI: Control Flow Integrity

**Clang CFI** (CONFIG_CFI_CLANG) prevents control-flow hijacking by verifying indirect call targets at runtime:

```c
/* Without CFI: attacker can overwrite a function pointer to point anywhere */
/* With CFI: indirect call target must match the declared function type */

/* Forward CFI: check that call target has matching type signature */
void (*fn_ptr)(int, int) = get_function_pointer();
fn_ptr(arg1, arg2);  /* CFI verifies fn_ptr points to a (int,int)->void function */

/* If violated: kernel panic / BUG() */
```

```bash
# Check if CFI is enabled:
grep CONFIG_CFI_CLANG /boot/config-$(uname -r)
# CONFIG_CFI_CLANG=y
# CONFIG_CFI_PERMISSIVE=n  (n = enforce, y = warn only)

# Android uses CFI for all kernel modules
```

## Hardening configuration checklist

```bash
# Key security config options to verify:
zcat /proc/config.gz | grep -E \
    "CONFIG_RANDOMIZE_BASE|CONFIG_STACKPROTECTOR|CONFIG_SMAP|CONFIG_SMEP|\
CONFIG_HARDENED_USERCOPY|CONFIG_FORTIFY_SOURCE|CONFIG_CFI_CLANG|\
CONFIG_INIT_ON_ALLOC_DEFAULT_ON|CONFIG_INIT_ON_FREE_DEFAULT_ON|\
CONFIG_PAGE_TABLE_ISOLATION|CONFIG_RETPOLINE"

# Expected: all should be =y (except INIT_* which might be =n for performance)

# Runtime check:
cat /sys/devices/system/cpu/vulnerabilities/*  # all should say "Mitigation"
grep kaslr_offset /proc/kallsyms               # should require root
```

## Further reading

- [LSM Framework](lsm.md) — SELinux/AppArmor security policy
- [Credentials](credentials.md) — privilege model that hardening protects
- [seccomp BPF](seccomp.md) — syscall filtering
- [Page Fault Handler](../mm/page-fault.md) — SMEP/SMAP implemented via page tables
- `Documentation/security/` — kernel security documentation
- kernel-hardening mailing list — upstream hardening discussions
- KSPP (Kernel Self Protection Project) config recommendations
