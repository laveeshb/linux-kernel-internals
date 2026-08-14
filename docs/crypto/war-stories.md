# Crypto War Stories

> Real incidents: timing attacks, IV reuse, key leaks, and broken RNG

These are five real-world problems rooted in kernel crypto behavior. Each follows the same
structure: the problem, how it was diagnosed, the root cause in kernel internals, and the fix.

---

## 1. IV reuse in dm-crypt with plain IV mode

### Problem

A system administrator configured a dm-crypt volume using the legacy `aes-cbc-plain` cipher
specification. After deploying it to a fleet of servers, a security review found that an
attacker with read access to the raw block device could determine when two sectors contained
identical plaintext.

### Diagnosis

The cipher specification was:

```bash
cryptsetup create myvolume /dev/sda2 --cipher aes-cbc-plain --key-size 256
```

The "plain" IV mode means the IV for each sector is simply the 32-bit sector number:

```c
/* drivers/md/dm-crypt.c */
static int crypt_iv_plain_gen(struct crypt_config *cc, u8 *iv,
                               struct dm_crypt_request *dmreq)
{
    memset(iv, 0, cc->iv_size);
    *(__le32 *)iv = cpu_to_le32(dmreq->iv_sector & 0xffffffff);
    return 0;
}
```

With AES-CBC and a static IV derived only from a 32-bit sector number, any two sectors with
the same sector number that happen to have the same first block of plaintext will produce
identical first blocks of ciphertext. This is the key CBC IV-reuse failure mode: if two
messages share the same IV and key, an attacker can detect when their **first plaintext
blocks are identical** by comparing the first ciphertext blocks.

```
AES_CBC(key, IV=42, plaintext_v1)[block_0] == AES_CBC(key, IV=42, plaintext_v2)[block_0]
    iff plaintext_v1[block_0] == plaintext_v2[block_0]
```

This is a **watermarking / traffic analysis** attack: an attacker with read access to the
raw device can detect when two versions of the same sector begin with the same 16-byte
block. This is distinct from the XOR-of-ciphertexts-equals-XOR-of-plaintexts leakage, which
applies to stream cipher modes (CTR, OFB) — not CBC. In CBC, IV reuse reveals block
equality, not plaintext content directly.

```bash
# Confirm the cipher mode
cryptsetup status myvolume
# cipher: aes-cbc-plain    ← vulnerable
```

### Root cause

`aes-cbc-plain` was the historical default in older cryptsetup versions. It was superseded by
`aes-cbc-essiv:sha256` (which derives the IV as `AES_encrypt(SHA256(volume_key), sector_num)`,
preventing watermarking) and then by `aes-xts-plain64` (which uses a mathematically sound
tweakable block cipher mode that does not have CBC's IV-reuse vulnerability).

The "plain" suffix means: the IV is the literal sector number, no derivation. The "plain64"
suffix uses a 64-bit sector number, fixing the original plain's 32-bit overflow issue.

### Fix

Migrate to AES-XTS, which eliminates the IV-reuse problem by design:

```bash
# Check current setup
cryptsetup benchmark
# Testing 128 bit cipher AES-XTS...   1623.5 MiB/s (encrypt)  1607.2 MiB/s (decrypt)
# Testing 128 bit cipher AES-CBC...   1784.2 MiB/s (encrypt)   532.1 MiB/s (decrypt)
# Note: AES-XTS decrypt is ~3x faster than AES-CBC decrypt

# New volumes: use LUKS2 with the default cipher (aes-xts-plain64)
cryptsetup luksFormat --type luks2 /dev/sda2
# Default cipher since cryptsetup 2.x: aes-xts-plain64

# Existing volume: must re-encrypt (in-place re-encryption available in LUKS2)
cryptsetup reencrypt --cipher aes-xts-plain64 --key-size 512 /dev/sda2
```

AES-XTS uses two keys (hence 512 bits for AES-256-XTS: 256-bit data key + 256-bit tweak key)
and a tweak derived from the sector number in GF(2^128), making each sector's encryption
mathematically independent even for identical plaintext sectors.

---

## 2. Timing side-channel in MAC verification: crypto_memneq

### Problem

A kernel module implementing a custom authentication protocol compared authentication
tags using `memcmp()`. Under carefully crafted network inputs, an attacker on the local
network was able to distinguish valid from invalid authentication tags by measuring response
latency with microsecond precision.

### Diagnosis

The vulnerable code:

```c
/* Incorrect: timing-variable comparison */
if (memcmp(received_tag, expected_tag, TAG_LEN) != 0) {
    return -EBADMSG;
}
```

`memcmp()` returns as soon as it finds a differing byte. An attacker sending MAC tags that
differ at the last byte (rather than the first) causes `memcmp()` to run longer. With enough
samples (millions of requests), the byte-by-byte comparison is statistically distinguishable,
allowing a timing oracle attack to reconstruct the expected tag one byte at a time.

This is the same class of vulnerability as the 2013 Lucky13 TLS attack and various HMAC
verification bugs.

### Root cause

`memcmp()` is defined to return after the first difference — this is correct for general
use, but wrong for secret comparison. The compiler is also free to optimize comparison code
in ways that create timing variation.

Linux added `crypto_memneq()` in kernel 3.14 (commit b839da0f) specifically to address this:

```c
/* include/crypto/utils.h */
static inline int crypto_memneq(const void *a, const void *b, size_t size)
{
    return __crypto_memneq(a, b, size) != 0UL ? 1 : 0;
}

/* lib/crypto/memneq.c — simplified generic path; the real implementation
 * also has a loop-free 16-byte fast path and an unaligned-access variant.
 * This helper is static inline; noinline is on the exported dispatcher,
 * __crypto_memneq(), which switches on size and calls this or the fast path. */
static inline unsigned long __crypto_memneq_generic(const void *a, const void *b, size_t size)
{
    unsigned long neq = 0;

    /* Accumulate XOR of all bytes. Result is 0 iff a == b.
     * Every byte is always read; no early exit. */
    while (size >= sizeof(unsigned long)) {
        neq |= *(unsigned long *)a ^ *(unsigned long *)b;
        OPTIMIZER_HIDE_VAR(neq);
        a   += sizeof(unsigned long);
        b   += sizeof(unsigned long);
        size -= sizeof(unsigned long);
    }
    while (size > 0) {
        neq |= *(unsigned char *)a ^ *(unsigned char *)b;
        OPTIMIZER_HIDE_VAR(neq);
        a++;
        b++;
        size--;
    }
    return neq;
}
```

`OPTIMIZER_HIDE_VAR(neq)` after every accumulation step (not a `-Os` compiler flag — there is
no such override for this file) hides the running accumulator from the optimizer, preventing
it from proving the loop could exit early. Combined with the exported dispatcher
`__crypto_memneq()` being `noinline` (preventing the caller's optimization context from
affecting the comparison), the function maintains its constant-time property.

### Fix

Replace all `memcmp()` calls in authentication paths with `crypto_memneq()`:

```c
/* Correct: constant-time comparison */
#include <crypto/utils.h>

if (crypto_memneq(received_tag, expected_tag, TAG_LEN)) {
    return -EBADMSG;
}
```

The AEAD crypto API (`crypto_aead_decrypt()`) already uses constant-time comparison
internally for authentication tag verification. For custom code, `crypto_memneq()` is the
right tool. The kernel also provides `crypto_authenc_extractkeys()` and higher-level
constructs that handle this correctly.

---

## 3. getrandom() blocking at boot: services hang waiting for entropy

### Problem

A fleet of KVM virtual machines running a custom Linux-based appliance exhibited a
reproducible hang during boot: `sshd` took 60–90 seconds to start, systemd journal showed
services timing out, and the boot would eventually continue but with a severely delayed
network stack.

### Diagnosis

The symptom was traced to `getrandom()` blocking:

```bash
# On a slow-boot VM, check blocked processes
cat /proc/*/wchan | sort | uniq -c | sort -rn | head
# 12 random_read_iter     ← 12 processes blocked in random_read_iter
```

The blocked call stack (from a kernel oops or via sysrq-T):

```
[<0>] __schedule+0x3c4/0xa80
[<0>] schedule+0x4a/0xb0
[<0>] getrandom_wait+0x...     ← waiting for crng_init_done
[<0>] sys_getrandom+0x...
```

`getrandom()` blocks until 256 bits of entropy are collected into the CRNG. On this VM:

```bash
# Check whether virtio-rng is present
lsmod | grep virtio_rng
# (empty — not loaded)

# No virtio-rng, no RDRAND passthrough, no saved seed:
dmesg | grep -E "random:|crng"
# [    0.301234] random: fast init done
# [  127.441821] random: crng init done  ← 127 seconds!
```

The VM was:
- Running under KVM without virtio-rng device configured
- CPU feature masking prevented RDRAND from being visible to the guest
- `systemd-random-seed.service` was loading the seed file too late in the boot sequence
  (after `network.target`, which itself needed `sshd` which needed getrandom...)

### Root cause

Circular dependency in boot:
```
network.target
    needs sshd
        needs getrandom() (blocks for entropy)
            needs: interrupt jitter, virtio-rng, or saved seed
                saved seed loaded by systemd-random-seed.service
                    After basic.target (late)
```

On virtual machines, interrupt jitter is low (the hypervisor delivers predictable timer
interrupts). Without virtio-rng, the kernel collects entropy very slowly.

### Fix

Three independent fixes, applied together for defense in depth:

**1. Add virtio-rng to the VM definition** (best fix):

```xml
<!-- QEMU/libvirt: add a virtio-rng device -->
<rng model='virtio'>
  <backend model='random'>/dev/urandom</backend>
</rng>
```

The guest kernel driver (`drivers/char/hw_random/virtio-rng.c`) calls
`add_hwgenerator_randomness()`, feeding host entropy into the guest pool immediately.

**2. Ensure systemd-random-seed loads early**:

```bash
# Verify the service is enabled and not in a late target
systemctl cat systemd-random-seed.service | grep -A 5 '\[Unit\]'
# Before= should include sysinit.target or similar early target
```

**3. On bare metal with a TPM or Intel CPU**:

```bash
# Enable rng-tools to harvest from hardware
apt install rng-tools
systemctl enable --now rngd
# rngd reads /dev/hwrng (which uses RDRAND/TPM) and feeds /dev/random
```

After adding virtio-rng:

```bash
dmesg | grep "crng init done"
# [    1.234567] random: crng init done  ← 1.2 seconds, normal
```

---

## 4. Kernel keyring leak via /proc

### Problem

A security audit found that a non-privileged process could enumerate key descriptions
from other users' keyrings by reading `/proc/keys`. The concern was: could this leak
sensitive information about key existence or purpose?

### Diagnosis

```bash
# Any process can read /proc/keys
cat /proc/keys
# 0c7ec5e3 I--Q--   1 perm 1f3f0000     0     0 keyring _uid_ses.0
# 2effa75e I--Q--   1 perm 1f3f0000  1000  1000 user    myapp:db_password
#                                    ^^^^
#                                    This key's description leaks the fact
#                                    that "myapp" has a "db_password" key
```

The key _description_ (name) is visible to all processes that can read `/proc/keys`, even
if they cannot read the payload. This is by design — `/proc/keys` shows all keys in the
system but is filtered by the calling process's `view` permission.

### Root cause

`/proc/keys` is implemented in `security/keys/proc.c`. The kernel calls `key_task_permission()`
for each key, with the `KEY_NEED_VIEW` permission bit:

```c
/* security/keys/proc.c */
static int proc_keys_show(struct seq_file *m, void *v)
{
    struct key *key = v;
    ...

    /* Skip keys this process can't view */
    rc = key_task_permission(make_key_ref(key, 0), current_cred(),
                              KEY_NEED_VIEW);
    if (rc < 0)
        return 0;   /* silently skip */

    /* Show description, type, permissions, uid, gid, expiry */
    /* Does NOT show payload */
    seq_printf(m, "%08x %s%s%s%s%s%s %5d %3d %s %s\n",
               key->serial, ...
               key->type->name,
               key->description);
    return 0;
}
```

The default permissions for user-created keys give `view` permission to the world
(`other` bits include `0x01 = view`). A key with `perm = 0x1f3f0000` has:
- possessor: `0x1f` = view|read|write|search|link (setattr bit 0x20 is NOT set)
- user: `0x3f` = all permissions (view|read|write|search|link|setattr)
- group: `0x00` = no permissions
- other: `0x00` = no permissions

**But**: in this case the key was created with permissive `other` permissions:

```bash
keyctl setperm <serial> 0x3f3f3f01  # other can "view" — bug!
```

Or the application used a key _description_ that exposed sensitive information (e.g., the
description contained a hostname or database name).

### Root cause (continued): logon keys prevent this

Keys of type `"logon"` cannot be read even by the owning process — the `.read` callback
returns `-EPERM`. This is why fscrypt and cryptsetup use logon keys for actual key material:
even with `view` permission on the description, the payload is unreachable:

```bash
# logon key: visible in /proc/keys but payload unreadable
keyctl add logon fscrypt:abc123 "$(dd if=/dev/urandom bs=32 count=1 2>/dev/null)" @s

# Description visible:
# 1234abcd I--Q--   1 perm 1f1f0000  1000  1000 logon   fscrypt:abc123

# Payload is inaccessible:
keyctl print 1234abcd
# keyctl_read_alloc: Permission denied
```

### Fix

1. **Use logon keys for sensitive material** — applications that store secrets in the
   keyring should use `"logon"` type so the payload is never readable from userspace.

2. **Use opaque descriptions** — if using `"user"` type keys, the description should not
   encode sensitive information (e.g., use a UUID rather than `myapp:db_password`).

3. **Set restrictive permissions** — create keys with `other=0x00`:

```bash
keyctl add user myapp:token "..." @s
keyctl setperm <serial> 0x3f3f0000  # possessor and user only; group and other: nothing
```

4. **Use `/proc/key-users`** (not `/proc/keys`) to monitor quota without exposing
   descriptions — it only shows counts per UID.

---

## 5. Hardware accelerator returning wrong results: silent ciphertext corruption

### Problem

A server using an Intel QuickAssist Technology (QAT) accelerator for AES-GCM encryption in
a TLS proxy began producing authentication failures on approximately 0.01% of requests.
Application logs showed intermittent `-EBADMSG` from the kernel AEAD decrypt path. The
failures were random in timing and not reproducible with specific inputs.

### Diagnosis

The proxy was using the `qat` kernel driver which registers a high-priority AES-GCM
implementation:

```bash
cat /proc/crypto | grep -A 15 "name.*gcm(aes)"
# name         : gcm(aes)
# driver       : qat_aes_gcm
# module       : intel_qat
# priority     : 4001        ← higher than AES-NI (800)
# type         : aead
# async        : yes
```

The hardware was selected by priority. Disabling the QAT module forced fallback to AES-NI:

```bash
# Test: bypass QAT by unloading the driver
rmmod intel_qat
# Failures stopped. The QAT hardware was producing corrupt output.
```

The root cause was a firmware bug in a specific QAT revision that incorrectly handled
scatter-gather lists spanning a 4GB physical address boundary.

### Root cause: CRYPTO_ALG_TESTED and the self-test framework

The kernel's crypto subsystem has a mandatory self-test framework (`crypto/testmgr.c`) that
runs known-answer tests on every registered algorithm before it is marked usable. An
algorithm that fails its self-test gets the `CRYPTO_ALG_TESTED` flag withheld and cannot
be used:

```c
/* include/linux/crypto.h */
#define CRYPTO_ALG_TESTED       0x00000400

/* An algorithm is usable only if this bit is set (or testing is disabled) */
```

The self-test for AES-GCM uses hardcoded test vectors from the NIST CAVP test suite:

```c
/* crypto/testmgr.h — excerpt (illustrative; actual file has hundreds of vectors) */
static const struct aead_testvec aes_gcm_tv_template[] = {
    {
        .key   = "\x00\x00\x00\x00\x00\x00\x00\x00"
                 "\x00\x00\x00\x00\x00\x00\x00\x00",
        .klen  = 16,
        .iv    = "\x00\x00\x00\x00\x00\x00\x00\x00"
                 "\x00\x00\x00\x00",
        .ptext = "",
        .plen  = 0,
        .aad   = "",
        .alen  = 0,
        .ctext = "\x58\xe2\xfc\xce\xfa\x7e\x30\x61"
                 "\x36\x7f\x1d\x57\xa4\xe7\x45\x5a", /* auth tag only */
        .clen  = 16,
    },
    /* ... many more vectors ... */
};
```

The QAT driver's implementation passed the self-tests (which use small, aligned test
vectors) but failed on real workloads with large scatter-gather lists crossing address
boundaries. The self-test framework caught algorithm-level bugs, but this was a
hardware bug that only manifested with specific DMA layouts.

### Fix

**Immediate**: disable the QAT for AES-GCM by reducing its priority or unloading the driver.

**In the driver**: add a DMA boundary check in the scatter-gather setup:

```c
/* Check that no DMA segment crosses a 4GB boundary */
static int qat_check_sg_alignment(struct scatterlist *sg, int nents)
{
    struct scatterlist *s;
    int i;

    for_each_sg(sg, s, nents, i) {
        dma_addr_t start = sg_dma_address(s);
        dma_addr_t end   = start + sg_dma_len(s) - 1;
        if ((start >> 32) != (end >> 32))
            return -EINVAL;   /* crosses 4GB boundary, use fallback */
    }
    return 0;
}
```

When the boundary check fails, the driver falls back to the software AES-GCM implementation
using the same fallback pattern described in [crypto_engine](crypto-engine.md).

**Longer term**: the kernel's `tcrypt` selftest mode can be used to stress-test with larger
and more varied inputs:

```bash
# Run the AEAD test suite (requires CONFIG_CRYPTO_TEST)
# Note: tcrypt mode numbers are not stable across kernel versions.
# The gcm(aes) aead test is in the mode 150s range; verify in your kernel's crypto/tcrypt.c.
modprobe tcrypt mode=154   # gcm(aes) aead test — verify in your kernel's crypto/tcrypt.c
# testing gcm(aes)...
# test 0 (512 byte blocks): passed.
# ...
```

The `CRYPTO_ALG_TESTED` mechanism ensures that a driver with broken self-tests is never
exposed to callers. However, it cannot protect against latent hardware bugs that pass
self-tests but fail under real DMA conditions. Drivers should implement their own
correctness checks for hardware-specific edge cases, and production deployments should
validate hardware with workload-realistic test patterns before relying on new accelerators.

---

## Summary: lessons from the field

| Incident | Core mistake | Correct approach |
|---|---|---|
| IV reuse (dm-crypt) | Legacy `aes-cbc-plain` cipher string | Use `aes-xts-plain64` (LUKS2 default) |
| Timing attack (memcmp) | `memcmp()` for secret comparison | `crypto_memneq()` from `<crypto/utils.h>` |
| Boot entropy starvation | No hardware RNG in VM | virtio-rng device + saved seed |
| Keyring description leak | Sensitive data in key description | Opaque descriptions + logon key type |
| Hardware silent corruption | Trusted self-tests as sufficient validation | DMA boundary checks + fallback |

## Further reading

### Kernel source

- [drivers/md/dm-crypt.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/md/dm-crypt.c) — `crypt_iv_plain_gen()` and `crypt_iv_essiv_gen()`, the IV generators behind Case 1's plain-IV watermarking issue
- [include/crypto/utils.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/crypto/utils.h) and [lib/crypto/memneq.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/crypto/memneq.c) — `crypto_memneq()`/`__crypto_memneq()`, the constant-time comparison behind Case 2
- [drivers/char/random.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/char/random.c) — `add_hwgenerator_randomness()` and the `pr_notice("crng init done\n")` log line behind Case 3
- [drivers/char/hw_random/virtio-rng.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/char/hw_random/virtio-rng.c) — the virtio-rng guest driver's `hwrng.read` callback that Case 3's fix relies on to feed host entropy into the guest pool
- [security/keys/proc.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/security/keys/proc.c) — `proc_keys_show()` and its `key_task_permission(..., KEY_NEED_VIEW)` check, the `/proc/keys` view-permission filtering behind Case 4
- [include/linux/crypto.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/crypto.h) — `CRYPTO_ALG_TESTED` (`0x00000400`), the self-test gate behind Case 5
- [crypto/testmgr.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/crypto/testmgr.c) and [crypto/tcrypt.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/crypto/tcrypt.c) — the mandatory self-test framework and the standalone stress-test module referenced in Case 5's fix

### Man pages

- [`cryptsetup(8)`](https://man7.org/linux/man-pages/man8/cryptsetup.8.html) — the LUKS/dm-crypt command-line tool used throughout Case 1
- [`getrandom(2)`](https://man7.org/linux/man-pages/man2/getrandom.2.html) — documents the blocking-until-seeded behavior behind Case 3
- [`random(4)`](https://man7.org/linux/man-pages/man4/random.4.html) — `/dev/random` vs `/dev/urandom`, entropy pool initialization, and why `getrandom(2)` is recommended during early boot
- [`keyctl(1)`](https://man7.org/linux/man-pages/man1/keyctl.1.html) — `setperm`, `print`, and the view/read/write/search/link/setattr permission bits used in Case 4

### Related pages

- [Kernel Crypto API](crypto-api.md) — AEAD, SKCIPHER, the algorithm registration model
- [dm-crypt and fscrypt](encryption.md) — IV modes and cipher choices
- [Kernel Keyring](keyring.md) — key types and permission model
- [crypto_engine](crypto-engine.md) — the fallback pattern for hardware drivers
- [Random Number Generation](rng.md) — entropy at boot

### LWN articles

- [Constant-time instructions and processor optimizations](https://lwn.net/Articles/921511/) (February 2023) — timing side channels and the tension between constant-time code and CPU-level optimizations, directly behind Case 2
- [FIPS-compliant random numbers for the kernel](https://lwn.net/Articles/877607/) (December 2021) — the debate over faster boot-time entropy collection, the broader context behind Case 3

### External

- [Kernel documentation: dm-crypt](https://docs.kernel.org/admin-guide/device-mapper/dm-crypt.html) — the `cipher-chainmode-ivmode[:ivopts]` specification format, including `aes-cbc-essiv:sha256` and `aes-xts-plain64`, behind Case 1
- [Kernel documentation: hw_random](https://docs.kernel.org/admin-guide/hw_random.html) — the `/dev/hwrng` framework that hardware RNG drivers (including virtio-rng) feed, behind Case 3's fix
- [Kernel documentation: Key Service (core)](https://docs.kernel.org/security/keys/core.html) — `/proc/keys` semantics, the view/read/write/search/link/setattr permission bits, and the `logon` key type, behind Case 4
- [Kernel documentation: Kernel Crypto API Architecture](https://docs.kernel.org/crypto/architecture.html) — the `priority` and `selftest` fields shown in `/proc/crypto` and the priority-based implementation selection behind Case 5
