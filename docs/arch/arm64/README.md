# ARM64 Architecture

> Exception levels, memory model, and ARM-specific kernel internals

## Why ARM64?

ARM64 (AArch64) is the dominant architecture for:
- Mobile (Android, iOS)
- Embedded and IoT (Raspberry Pi, NXP, TI)
- Servers (AWS Graviton, Ampere Altra)
- Laptops (Apple Silicon, Qualcomm Snapdragon X)

Understanding ARM64-specific behavior is essential for kernel work on these platforms.

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Exception Model](exception-model.md) | EL0-EL3, VBAR_EL1, syndrome registers, GIC |
| [Memory Model](memory-model.md) | Weak ordering, barriers, load-acquire/store-release, LDAR/STLR |

## ARM64 vs x86 key differences

| Feature | x86-64 | ARM64 |
|---------|--------|-------|
| Memory ordering | TSO (total store order) | Weak (RVWMO relaxed) |
| Privilege levels | ring 0-3 | EL0-EL3 |
| Interrupt controller | APIC | GIC (Generic Interrupt Controller) |
| System registers | MSR/RDMSR | MRS/MSR instructions |
| SIMD | SSE/AVX | NEON / SVE / SME |
| Page sizes | 4K/2M/1G | 4K/16K/64K base + 2M/1G huge |
| TLB shootdown | IPI to other CPUs | TLBI broadcast via DSB |

## Quick reference

```bash
# CPU features on ARM64
cat /proc/cpuinfo | grep Features
# Features: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics ...

# ARM64-specific system registers (via perf or MSR equivalent)
# Read CNTVCT_EL0 (virtual counter — ARM equivalent of RDTSC)
# mrs x0, CNTVCT_EL0

# Exception level of running code
# EL0 = userspace, EL1 = kernel, EL2 = hypervisor, EL3 = secure monitor
```
