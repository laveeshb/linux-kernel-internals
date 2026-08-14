# Random Number Generation

> /dev/random, getrandom(), DRBG, and hardware entropy

## Overview

The Linux kernel random number generator serves two distinct audiences:

- **Userspace**: `/dev/random`, `/dev/urandom`, and the `getrandom(2)` syscall
- **Kernel internals**: `get_random_bytes()`, `get_random_u32()`, and the DRBG crypto API

Both ultimately source from the same entropy pool, which is seeded from hardware events and
(on capable hardware) a hardware RNG instruction.

## The entropy pool

### Pre-5.6: multiple pools

In early kernel versions, the kernel maintained three pools:

- `input_pool`: the primary entropy accumulator (4096 bits, hash-based mixing)
- `blocking_pool`: fed `/dev/random`; blocked when estimated entropy was low
- `nonblocking_pool`: fed `/dev/urandom`; never blocked

The `nonblocking_pool` was merged into the CRNG output stage earlier, and the
`blocking_pool` was removed in **Linux 5.6**. By 5.6 only the `input_pool` remained,
with a ChaCha20-based CRNG output stage. This is also when `/dev/random` became
non-blocking. The entropy _estimator_ was controversial: it claimed to track "bits of
entropy" but was largely a heuristic. In practice it often over-estimated or
under-estimated, causing spurious blocking or false confidence.

### 5.17+: a single BLAKE2s pool

Linux 5.17 (2022) — primarily Jason Donenfeld's rework — replaced the multi-pool design
with a single 256-bit BLAKE2s-based pool. The key insight: once you have 256 bits of
real entropy, further accumulation doesn't increase security. You have a secret that cannot
be brute-forced.

The new pool:

```c
/* drivers/char/random.c (5.17+) */

/* The primary pool is 256 bits mixed through BLAKE2s (input pool, not CRNG output) */
static struct {
    struct blake2s_ctx      hash;
    spinlock_t              lock;
    unsigned int            init_bits;  /* accumulated so far */
} input_pool = {
    .hash.h = { /* BLAKE2s IV, pre-mixed with the output length */ ... },
    .hash.outlen = BLAKE2S_HASH_SIZE,
    .lock = __SPIN_LOCK_UNLOCKED(input_pool.lock),
};
```

The `crng_init` counter has three states: 0 (unseeded), 1 (early seeded, ~128 bits of
entropy, usable but not fully initialized), and 2 (fully seeded, 256 bits). The transition
is 0 → 1 → 2. After `crng_init` reaches 2, the pool is periodically reseeded from new
entropy, but the CRNG output is already cryptographically indistinguishable from random.

The CRNG (Cryptographically Secure Random Number Generator) uses ChaCha20 as its stream
cipher. Per-CPU CRNGs (added in 5.18, replacing an earlier per-NUMA-node design) allow fast,
lock-free generation:

```c
/* struct crng — internal type, wraps ChaCha20 state; not a public kernel API */
/* Each CPU has its own CRNG instance for lock-free generation */
```

## Entropy sources

The kernel feeds entropy into the pool from multiple sources:

| Source | How | Notes |
|---|---|---|
| Interrupt timing | `add_interrupt_randomness()` — called from interrupt handlers | Jitter between interrupts carries entropy |
| Hardware RNG | `add_hwgenerator_randomness()` — from `/dev/hwrng` | RDRAND, TPM, virtio-rng |
| Disk I/O | Block layer timing via `add_disk_randomness()` | Still present and exported (`EXPORT_SYMBOL_GPL`) |
| Boot-time | Seed file from previous boot via rng-tools/systemd-random-seed | Critical for VMs |
| CPU RDRAND | `arch_get_random_long()` — used during CRNG initialization | See note on RDRAND below |

### RDRAND

Intel's RDRAND instruction (Sandy Bridge, 2012+) generates random numbers from an on-chip
hardware entropy source. The kernel _does_ use RDRAND, but only as one input among many —
not as the sole source:

```c
/* arch/x86/kernel/cpu/rdrand.c */
void x86_init_rdrand(struct cpuinfo_x86 *c)
{
    /* Test: generate 8 values; if any fail or don't change enough, disable RDRAND usage */
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

/* Allocate the kernel's registered DRBG (exposed under the generic "stdrng" name) */
struct crypto_rng *rng = crypto_alloc_rng("stdrng", 0, 0);
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

As of this kernel, `crypto/drbg.c` registers a single algorithm: `cra_name = "stdrng"`,
`cra_driver_name = "drbg_nopr_hmac_sha512"` — an HMAC-DRBG built on SHA-512, without
prediction resistance. The older design registered a family of names following the pattern
`drbg_{pr,nopr}_{hmac,hash,ctr}_{hash_alg}` (letting callers pick a specific mode/hash and
choose prediction resistance); that family, and support for prediction resistance itself,
were removed in a later simplification, leaving `crypto_alloc_rng("stdrng", 0, 0)` as the way
to reach it.

## Kernel internal interfaces

For kernel code that needs random data:

```c
/* General: block until CRNG is initialized, then return bytes */
void get_random_bytes(void *buf, size_t len);

/* Fast per-CPU versions (lock-free, 5.18+) */
u32 get_random_u32(void);
u64 get_random_u64(void);
u32 get_random_u32_below(u32 ceil);  /* uniform in [0, ceil) — added 6.2 */
```

`get_random_bytes_arch()` and the zero-argument `prandom_u32()` — both older APIs sometimes
referenced in outdated documentation — no longer exist in the current tree; `get_random_u32()`
is the current replacement for both use cases.

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
    ├─ rand_initialize() / early kernel init ← CRNG allocated, NOT yet initialized
    │  (internal routines; not part of the stable API)
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
    └─ Periodic reseed               ← every CRNG_RESEED_INTERVAL (60 seconds) from fresh entropy
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

**VM fork detection**: Linux 5.17+ includes support for detecting VM forks via a virtual
machine generation ID (VMGENID) ACPI device. When the hypervisor changes the generation ID
(on snapshot resume), the kernel calls `add_vmfork_randomness()` to reseed the CRNG:

```c
/* drivers/virt/vmgenid.c */
/* ACPI/DT device publishes a 128-bit generation counter */
struct vmgenid_state {
    u8 *next_id;              /* pointer to the live counter in device memory */
    u8 this_id[VMGENID_SIZE]; /* last-seen copy */
};

static void vmgenid_notify(struct device *device)
{
    struct vmgenid_state *state = device->driver_data;
    u8 old_id[VMGENID_SIZE];

    memcpy(old_id, state->this_id, sizeof(old_id));
    memcpy(state->this_id, state->next_id, sizeof(state->this_id));
    if (!memcmp(old_id, state->this_id, sizeof(old_id)))
        return;  /* unchanged: not a fork/resume event */

    add_vmfork_randomness(state->this_id, sizeof(state->this_id));
}
```

The ACPI notify handler is a thin wrapper that just calls `vmgenid_notify(dev)` when the
platform signals a generation-ID change; the diff-and-reseed logic above is what actually
detects the change and reseeds.

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
# Note: read_wakeup_threshold was removed in Linux 5.17. write_wakeup_threshold is
# still a live sysctl node but is now vestigial (reads return a value; writes are
# silently ignored). Use entropy_avail, poolsize, and urandom_min_reseed_secs instead.

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

### Kernel source

- [drivers/char/random.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/char/random.c) — the BLAKE2s input pool, ChaCha20 CRNG, and the `getrandom()`/`/dev/random`/`/dev/urandom` implementation
- [crypto/drbg.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/crypto/drbg.c) — the NIST SP 800-90A DRBG exposed through `crypto_alloc_rng()`
- [include/linux/random.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/random.h) — `get_random_bytes()`, `get_random_u32()`/`get_random_u64()`, `get_random_u32_below()`, and the `add_*_randomness()` entropy-feeding API
- [drivers/virt/vmgenid.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/virt/vmgenid.c) — VM fork detection via the VMGENID ACPI/DT device
- [arch/x86/kernel/cpu/rdrand.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/kernel/cpu/rdrand.c) — `x86_init_rdrand()`, the boot-time RDRAND self-test

### Man pages

- [`getrandom(2)`](https://man7.org/linux/man-pages/man2/getrandom.2.html) — syscall flags (`GRND_NONBLOCK`, `GRND_RANDOM`), signal behavior, and the 256-byte no-short-read guarantee
- [`random(4)`](https://man7.org/linux/man-pages/man4/random.4.html) — `/dev/random` and `/dev/urandom` device semantics, including the Linux 5.6 non-blocking change

### Related pages

- [Kernel Crypto API](crypto-api.md) — `crypto_alloc_rng()` and the DRBG interface built on top of this page's entropy pool
- [dm-crypt and fscrypt](encryption.md) — where `get_random_bytes()`/`/dev/urandom` output is consumed for volume keys and IVs
- [Kernel Keyring](keyring.md) — where generated key material is stored once created
- [Crypto War Stories](war-stories.md) — incident 3, "`getrandom()` blocking at boot," a real entropy-starvation case built on the material in this page

### LWN articles

- [The search for truly random numbers in the kernel](https://lwn.net/Articles/567055/) — Jonathan Corbet, September 18, 2013 — why the kernel mixes RDRAND into the pool instead of trusting it alone
- [A system call for random numbers: getrandom()](https://lwn.net/Articles/606141/) — Jake Edge, July 23, 2014 — the original design discussion for the syscall this page documents
- [Uniting the Linux random-number devices](https://lwn.net/Articles/884875/) — Jake Edge, February 16, 2022 — Jason Donenfeld's push, from the era of the pool rewrite, to make `/dev/random` and `/dev/urandom` behave identically

### External

- [NIST SP 800-90A Rev. 1](https://csrc.nist.gov/pubs/sp/800/90/a/r1/final) — "Recommendation for Random Number Generation Using Deterministic Random Bit Generators," the standard implemented by `crypto/drbg.c`
