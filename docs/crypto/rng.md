# Random Number Generation

> /dev/random, getrandom(), DRBG, and hardware entropy

## Overview

The Linux kernel random number generator serves two distinct audiences:

- **Userspace**: `/dev/random`, `/dev/urandom`, and the `getrandom(2)` syscall
- **Kernel internals**: `get_random_bytes()`, `get_random_u32()`, and the DRBG crypto API

Both ultimately source from the same entropy pool, which is seeded from hardware events and
(on capable hardware) a hardware RNG instruction.

## The entropy pool

### Pre-5.17: multiple pools

Before kernel 5.17, the kernel maintained three pools:

- `input_pool`: the primary entropy accumulator (4096 bits, ChaCha20-based after 5.2)
- `blocking_pool`: fed `/dev/random`; blocked when estimated entropy was low
- `nonblocking_pool`: fed `/dev/urandom`; never blocked

The entropy _estimator_ was controversial: it claimed to track "bits of entropy" but was
largely a heuristic. In practice it often over-estimated or under-estimated, causing spurious
blocking or false confidence.

### 5.17+: a single BLAKE2s pool

Linux 5.17 (2022) — primarily Jason Donenfeld's rework — replaced the multi-pool design
with a single 256-bit BLAKE2s-based pool. The key insight: once you have 256 bits of
real entropy, further accumulation doesn't increase security. You have a secret that cannot
be brute-forced.

The new pool:

```c
/* drivers/char/random.c (5.17+) */

/* The primary pool is 256 bits folded through BLAKE2s */
static struct {
    struct blake2s_state    hash;
    spinlock_t              lock;
    unsigned int            init_bits;  /* accumulated so far */
} input_pool = {
    .lock = __SPIN_LOCK_UNLOCKED(input_pool.lock),
};
```

When 256 bits are accumulated, `crng_init` transitions from 0 → 2 (fully initialized).
After that, the pool is periodically reseeded from new entropy, but the CRNG output is
already cryptographically indistinguishable from random.

The CRNG (Cryptographically Secure Random Number Generator) uses ChaCha20 as its stream
cipher. Per-CPU CRNGs (added in 5.14) allow fast, lock-free generation:

```c
/* Simplified: each CPU has its own ChaCha20 state */
static DEFINE_PER_CPU(struct chacha20_state, crngs);
```

## Entropy sources

The kernel feeds entropy into the pool from multiple sources:

| Source | How | Notes |
|---|---|---|
| Interrupt timing | `add_interrupt_randomness()` — called from interrupt handlers | Jitter between interrupts carries entropy |
| Hardware RNG | `add_hwgenerator_randomness()` — from `/dev/hwrng` | RDRAND, TPM, virtio-rng |
| Disk I/O | Block layer timing via `add_disk_randomness()` | Removed in 5.18 as negligible |
| Boot-time | Seed file from previous boot via rng-tools/systemd-random-seed | Critical for VMs |
| CPU RDRAND | `arch_get_random_long()` — used during CRNG initialization | See note on RDRAND below |

### RDRAND

Intel's RDRAND instruction (Sandy Bridge, 2012+) generates random numbers from an on-chip
hardware entropy source. The kernel _does_ use RDRAND, but only as one input among many —
not as the sole source:

```c
/* arch/x86/kernel/cpu/rdrand.c */
static void __init x86_init_rdrand(struct cpuinfo_x86 *c)
{
    /* Test: generate 8 values; if any fail, disable RDRAND usage */
    ...
}
```

The rationale for not trusting RDRAND alone: if Intel (or another party) had backdoored the
RDRAND implementation, relying solely on it would compromise all cryptographic operations.
By mixing RDRAND with interrupt jitter and other sources, a compromised RDRAND cannot bias
the output. This is an explicit design decision discussed in the kernel changelog for
commits by Theodore Ts'o.

## getrandom(2)

```c
#include <sys/random.h>

ssize_t getrandom(void *buf, size_t buflen, unsigned int flags);
```

`getrandom(2)` was added in Linux 3.17. It is the preferred interface over `/dev/random` and
`/dev/urandom`.

Behavior:

- **No flags (0)**: blocks until the CRNG is fully initialized (256 bits of entropy), then
  returns cryptographically strong random bytes. Non-blocking after initialization.
- **`GRND_NONBLOCK`**: like the default, but returns `-EAGAIN` instead of blocking if the
  CRNG is not yet initialized.
- **`GRND_RANDOM`**: historically selected the "blocking pool" (reading from the entropy
  estimator). Since 5.6, this flag has **no effect** — it is treated identically to the
  default. Do not use `GRND_RANDOM` in new code; it does not provide more security than
  the default.
- **`GRND_INSECURE`** (added 5.6): returns random bytes even if the CRNG is not initialized.
  Only for non-cryptographic uses (e.g., kernel ASLR before full initialization).

```c
/* Correct usage in userspace */
uint8_t key[32];
ssize_t n = getrandom(key, sizeof(key), 0);
if (n < 0) {
    perror("getrandom");
    exit(1);
}
/* key now contains 32 cryptographically strong random bytes */
```

`getrandom()` is not interrupted by signals (unlike reads from `/dev/random`). For requests
of 256 bytes or less, it is guaranteed to return the full buffer or fail — no short reads.

## /dev/random and /dev/urandom

```
                      ┌──────────────────────────────┐
Entropy sources ────► │  Input pool (BLAKE2s, 256 bits│
                      │  accumulating to crng_init=2) │
                      └──────────────────┬────────────┘
                                         │
                               ChaCha20 CRNG
                              /         |          \
                    /dev/random   /dev/urandom  getrandom()
```

**`/dev/random`**: Since Linux 5.6, `/dev/random` is **non-blocking**. It no longer blocks
waiting for "sufficient entropy" after the CRNG is initialized. It outputs CRNG bytes, same
as `/dev/urandom`. Before 5.6 it blocked whenever the entropy estimate fell below a
threshold, causing frustrating freezes in scripts. The blocking behavior was widely
acknowledged as providing false security guarantees.

**`/dev/urandom`**: Always non-blocking. Safe for all cryptographic uses after boot
initialization. Before the CRNG is initialized (very early boot), reading `/dev/urandom` is
_technically_ unsafe (output could be predictable), but in practice the kernel initializes
early. The kernel logs a warning if urandom is read before initialization.

**Which to use?** Use `getrandom(2)` for new code. If you must use a file descriptor,
`/dev/urandom` is fine. `/dev/random` provides no additional security over `/dev/urandom`
since 5.6, and the blocking behavior before 5.6 was harmful.

## DRBG: Deterministic Random Bit Generator

The kernel implements NIST SP 800-90A Deterministic Random Bit Generators via the crypto API
(`crypto/drbg.c`). These are used by kernel subsystems that need NIST-compliant RNG behavior
(IPsec, certain FIPS-mode operations):

```c
#include <crypto/rng.h>

/* Allocate an HMAC-SHA256 based DRBG (no prediction resistance) */
struct crypto_rng *rng = crypto_alloc_rng("drbg_nopr_hmac_sha256", 0, 0);
if (IS_ERR(rng))
    return PTR_ERR(rng);

/* Seed from the kernel entropy pool */
u8 seed[32];
get_random_bytes(seed, sizeof(seed));
ret = crypto_rng_reset(rng, seed, sizeof(seed));

/* Generate bytes */
u8 output[16];
ret = crypto_rng_get_bytes(rng, output, sizeof(output));

crypto_free_rng(rng);
```

DRBG algorithm names follow the pattern `drbg_{pr,nopr}_{hmac,hash,ctr}_{hash_alg}`:

```
drbg_pr_hmac_sha256    HMAC-DRBG SHA-256, with prediction resistance
drbg_nopr_hmac_sha256  HMAC-DRBG SHA-256, no prediction resistance (faster)
drbg_pr_sha256         Hash-DRBG SHA-256, with prediction resistance
drbg_nopr_ctr_aes256   CTR-DRBG AES-256, no prediction resistance
```

Prediction resistance means the DRBG is reseeded from the entropy pool before each generate
call, providing forward secrecy. `nopr` variants reseed only periodically or on request.

## Kernel internal interfaces

For kernel code that needs random data:

```c
/* General: block until CRNG is initialized, then return bytes */
void get_random_bytes(void *buf, size_t len);

/* Fast per-CPU versions (lock-free, 5.14+) */
u32 get_random_u32(void);
u64 get_random_u64(void);
u32 get_random_u32_below(u32 ceil);  /* uniform in [0, ceil) — added 6.1 */

/* For filling structures with random data */
void get_random_bytes_arch(void *buf, size_t len);  /* prefers RDRAND */

/* For non-cryptographic random numbers (fast, no entropy guarantee) */
u32 prandom_u32(void);   /* deprecated; use get_random_u32() */
```

```c
/* Example: generate a random nonce for a network protocol */
u8 nonce[16];
get_random_bytes(nonce, sizeof(nonce));

/* Example: random jitter in a retry loop */
usleep_range(1000 + get_random_u32_below(1000), 3000);
```

## Initialization timeline

```
Power on
    │
    ├─ early_init_primary_crng()     ← CRNG allocated, NOT yet initialized
    │  crng_init = 0
    │
    ├─ Interrupt jitter accumulates  ← add_interrupt_randomness()
    │  RDRAND mixes in               ← arch_get_random_long()
    │
    ├─ systemd-random-seed.service   ← loads saved seed from /var/lib/systemd/random-seed
    │  (or rngd from rng-tools)
    │
    ├─ 256 bits accumulated          ← crng_init = 2
    │  crng_init_done()              ← wake_up_all() for getrandom() waiters
    │  pr_notice("random: crng init done")
    │
    └─ Periodic reseed               ← every ~5 minutes from fresh entropy
```

In a typical boot on bare metal, `crng_init_done` happens within the first few seconds.
On VMs with no virtio-rng and no saved seed, it can take tens of seconds or longer.

You can check initialization status:

```bash
# Kernel log shows when CRNG initializes
dmesg | grep "crng init done"
# [    2.341801] random: crng init done

# Current entropy estimate (informational only post-5.17)
cat /proc/sys/kernel/random/entropy_avail

# Pool size in bits
cat /proc/sys/kernel/random/poolsize
# 256   (always 256 since 5.17)
```

## VM entropy problem

Virtual machines share a hypervisor that controls timing. Interrupt jitter — the primary
entropy source on bare metal — is much less random in a VM:

1. The hypervisor may deliver interrupts at fixed intervals
2. Two VMs started from the same snapshot (or snapshotted and cloned) share identical
   RNG state at the snapshot point

**Fork problem**: if a VM is snapshotted and two instances resume from the same state,
both will produce identical random numbers until their RNG states diverge. This is a
real cryptographic hazard (identical TLS session keys, duplicate nonces).

### Solutions

**virtio-rng**: a paravirtual device that requests random bytes from the host:

```bash
# In the VM, check for virtio-rng
lsmod | grep virtio_rng
# or
ls /sys/bus/virtio/drivers/virtio_rng/

# The host (e.g., QEMU) feeds entropy from its own /dev/random
# The guest's kernel mixes this into its entropy pool via add_hwgenerator_randomness()
```

**RDRAND / RDSEED in the guest**: if the hypervisor passes through CPU RNG instructions,
the VM uses real hardware entropy.

**VM fork detection**: Linux 5.17+ includes `virt_randomize_platform_key()` which detects
VM forks via a virtual machine generation ID (VMGENID) ACPI device. When the hypervisor
changes the generation ID (on snapshot resume), the kernel reseeds the CRNG:

```c
/* drivers/virt/vmgenid.c */
/* ACPI device publishes a 128-bit generation counter in ACPI table */
/* On generation ID change, kernel calls add_vmfork_randomness() */
static void vmgenid_notify(struct acpi_device *device, u32 event)
{
    ...
    add_vmfork_randomness(new_id, sizeof(new_id));
}
```

## getrandom() in containers

`getrandom()` is **not namespaced** — it uses the host kernel's entropy pool regardless of
container namespace. A process inside a container calling `getrandom()` gets random bytes
from the same pool as the host. This is correct: the entropy pool is a global resource
and sharing it does not weaken it; more consumers mean more entropy mixing, not less.

Container runtimes do not (and should not) intercept `getrandom()`.

## Observing the RNG subsystem

```bash
# Current entropy estimate
cat /proc/sys/kernel/random/entropy_avail
# 256   (capped at pool size since 5.17)

# Pool parameters
cat /proc/sys/kernel/random/poolsize      # 256
cat /proc/sys/kernel/random/read_wakeup_threshold   # 64 (bits)
cat /proc/sys/kernel/random/write_wakeup_threshold  # 28 (bits)

# UUID generated from /dev/urandom (convenient test)
cat /proc/sys/kernel/random/uuid

# FIPS 140-2 statistical test on the output (requires rng-tools)
rngtest -c 1000 < /dev/urandom
# rngtest: bits tested:                 20000
# rngtest: FIPS 140-2 successes:        1000
# rngtest: FIPS 140-2 failures:         0

# Performance test
dd if=/dev/urandom of=/dev/null bs=1M count=100 2>&1
# 100 MB/s+ on modern hardware (ChaCha20 CRNG is fast)

# Watch entropy events via tracepoints (kernel 5.x+)
perf trace -e random:*
# or (for kernels with these tracepoints enabled):
trace-cmd record -e random:* sleep 10
trace-cmd report

# Check if hardware RNG is present and used
cat /sys/class/misc/hw_random/rng_current
# virtio_rng.0   (in a VM with virtio-rng)
# tpm-rng-0      (TPM as RNG source)
# intel_rng      (Intel hardware)

# Force rngd to add entropy from hardware RNG
rngd -f -r /dev/hwrng
```

## Relevant source

- `drivers/char/random.c` — the entire entropy pool, CRNG, getrandom() implementation
- `crypto/drbg.c` — NIST SP 800-90A DRBG implementation
- `drivers/char/hw_random/` — hardware RNG drivers (virtio-rng, intel-rng, tpm-rng, etc.)
- `drivers/virt/vmgenid.c` — VM fork detection via VMGENID
- `arch/x86/kernel/cpu/rdrand.c` — RDRAND support
- `include/linux/random.h` — kernel-internal RNG API

## Further reading

- [Kernel Crypto API](crypto-api.md) — DRBG via crypto_alloc_rng()
- [Kernel Keyring](keyring.md) — key generation uses get_random_bytes()
- `man 2 getrandom` — syscall documentation
- `man 4 random` — /dev/random and /dev/urandom
- Donenfeld, "A New Random Number Generator" (LWN, 2022) — design rationale for the 5.17 rewrite
