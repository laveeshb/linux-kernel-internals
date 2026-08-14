# Kernel Crypto API

> Symmetric ciphers, AEAD, hash functions, and hardware acceleration

## Overview

The Linux kernel crypto API provides a unified interface to cryptographic operations. Callers request a transform by name (e.g., `"gcm(aes)"`, `"sha256"`) and the subsystem selects the best available implementation — software fallback or hardware accelerator.

## struct crypto_alg

Every cryptographic algorithm registers a `struct crypto_alg`:

```c
/* include/linux/crypto.h */
struct crypto_alg {
    struct list_head    cra_list;
    struct list_head    cra_users;

    u32                 cra_flags;      /* CRYPTO_ALG_TYPE_* */
    unsigned int        cra_blocksize;  /* cipher block size */
    unsigned int        cra_ctxsize;    /* size of transform context */
    unsigned int        cra_alignmask; /* required alignment */
    unsigned int        cra_reqsize;   /* extra per-request context size */

    int                 cra_priority;  /* higher = preferred (e.g., AES-NI > software) */
    refcount_t          cra_refcnt;

    char                cra_name[CRYPTO_MAX_ALG_NAME];    /* "aes", "sha256", ... */
    char                cra_driver_name[CRYPTO_MAX_ALG_NAME]; /* "aes-aesni", ... */

    const struct crypto_type *cra_type;

    union {
        struct cipher_alg      cipher;
    } cra_u;
    /* Note: ablkcipher_alg and blkcipher_alg were removed in kernel 5.5;
     * all symmetric ciphers now use skcipher_alg. Compression is a
     * separate transform type today, not a member of this union. */

    int (*cra_init)(struct crypto_tfm *tfm);
    void (*cra_exit)(struct crypto_tfm *tfm);
    void (*cra_destroy)(struct crypto_alg *alg);

    struct module          *cra_module;
};
```

## SKCIPHER: symmetric ciphers

SKCIPHER (symmetric key cipher) is the API for symmetric block ciphers like AES-CBC, AES-XTS, ChaCha20:

```c
#include <crypto/skcipher.h>

/* Allocate a cipher transform */
struct crypto_skcipher *tfm = crypto_alloc_skcipher("xts(aes)", 0, 0);
if (IS_ERR(tfm)) {
    pr_err("Failed to allocate xts(aes): %ld\n", PTR_ERR(tfm));
    return PTR_ERR(tfm);
}

/* Set key (XTS needs 2x key: data key + tweak key) */
u8 key[64];  /* 32 bytes data + 32 bytes tweak = AES-256-XTS */
get_random_bytes(key, sizeof(key));
crypto_skcipher_setkey(tfm, key, sizeof(key));

/* Allocate a request (holds per-operation state) */
struct skcipher_request *req = skcipher_request_alloc(tfm, GFP_KERNEL);

/* Set up scatter-gather I/O */
struct scatterlist sg;
sg_init_one(&sg, plaintext_buf, buflen);

/* IV for XTS: sector number */
u8 iv[16] = { 0 };  /* sector 0 */
skcipher_request_set_crypt(req, &sg, &sg, buflen, iv);

/* Encrypt in-place (synchronous) */
int ret = crypto_skcipher_encrypt(req);

/* Decrypt */
skcipher_request_set_crypt(req, &sg, &sg, buflen, iv);
ret = crypto_skcipher_decrypt(req);

/* Cleanup */
skcipher_request_free(req);
crypto_free_skcipher(tfm);
```

### Common cipher names

```
"cbc(aes)"          AES-CBC (128/192/256 bit key)
"xts(aes)"          AES-XTS (disk encryption)
"ctr(aes)"          AES-CTR (stream cipher mode)
"gcm(aes)"          AES-GCM (AEAD — see below)
"chacha20"          ChaCha20 stream cipher
"chacha20poly1305"  ChaCha20-Poly1305 (AEAD)
"ecb(aes)"          AES-ECB (avoid — deterministic)
```

## AEAD: authenticated encryption

AEAD (Authenticated Encryption with Associated Data) provides confidentiality AND integrity in one operation. AES-GCM is the most common kernel AEAD:

```c
#include <crypto/aead.h>

struct crypto_aead *tfm = crypto_alloc_aead("gcm(aes)", 0, 0);

/* Key (128, 192, or 256 bits for AES) */
u8 key[32];  /* AES-256-GCM */
crypto_aead_setkey(tfm, key, sizeof(key));

/* Authentication tag length: 16 bytes = 128-bit tag */
crypto_aead_setauthsize(tfm, 16);

struct aead_request *req = aead_request_alloc(tfm, GFP_KERNEL);

/* Layout in scatter-gather:
   [associated data (AAD)] [plaintext/ciphertext] [auth tag (on encrypt)]

   assoclen = length of AAD
   cryptlen = length of plaintext (encrypt) or ciphertext+tag (decrypt) */

struct scatterlist src[2], dst[2];
sg_init_one(&src[0], aad, aadlen);        /* associated data */
sg_init_one(&src[1], plaintext, ptlen);    /* plaintext */
sg_init_one(&dst[0], aad, aadlen);        /* pass-through AAD */
sg_init_one(&dst[1], ciphertext, ptlen + 16); /* ciphertext + 16-byte tag */

u8 iv[12];   /* 96-bit IV recommended for GCM */
get_random_bytes(iv, sizeof(iv));

aead_request_set_crypt(req, src, dst, ptlen, iv);
aead_request_set_ad(req, aadlen);

/* Encrypt: outputs ciphertext + 16-byte authentication tag */
ret = crypto_aead_encrypt(req);

/* Decrypt: verifies tag, returns -EBADMSG if authentication fails */
aead_request_set_crypt(req, src, dst, ptlen + 16, iv);
aead_request_set_ad(req, aadlen);
ret = crypto_aead_decrypt(req);
if (ret == -EBADMSG)
    pr_err("Authentication failed — data corrupted or tampered\n");
```

## Hash functions

```c
#include <crypto/hash.h>

/* Simple SHA-256 hash */
struct crypto_shash *tfm = crypto_alloc_shash("sha256", 0, 0);

SHASH_DESC_ON_STACK(desc, tfm);  /* allocate desc on stack */
desc->tfm = tfm;

u8 digest[32];
crypto_shash_init(desc);
crypto_shash_update(desc, data, datalen);
crypto_shash_final(desc, digest);

/* Or: one-shot */
crypto_shash_digest(desc, data, datalen, digest);

crypto_free_shash(tfm);
```

### HMAC

```c
struct crypto_shash *tfm = crypto_alloc_shash("hmac(sha256)", 0, 0);
crypto_shash_setkey(tfm, hmac_key, keylen);

SHASH_DESC_ON_STACK(desc, tfm);
desc->tfm = tfm;

u8 mac[32];
crypto_shash_digest(desc, message, msglen, mac);
```

## Asynchronous (ahash) API

For large data or hardware offload, use the async hash API:

```c
struct crypto_ahash *tfm = crypto_alloc_ahash("sha256", 0, 0);
struct ahash_request *req = ahash_request_alloc(tfm, GFP_KERNEL);

struct scatterlist sg;
sg_init_one(&sg, data, datalen);
ahash_request_set_crypt(req, &sg, digest, datalen);

/* Complete callback for async operation */
ahash_request_set_callback(req, CRYPTO_TFM_REQ_MAY_BACKLOG,
                            my_hash_complete, &completion);

ret = crypto_ahash_digest(req);
if (ret == -EINPROGRESS)
    wait_for_completion(&completion);  /* hardware processing */
```

## Hardware acceleration

The crypto subsystem automatically uses hardware accelerators when available. The `cra_priority` field determines selection:

| Priority | Implementation |
|----------|---------------|
| 4001 | Intel QAT hardware |
| 400–800  | Intel AES-GCM, by instruction set: base AES-NI (400), AVX (500), VAES+AVX2 (600), VAES+AVX512 (800) — the highest available on the running CPU wins |
| 300  | Generic C implementation |

```bash
# See which implementation is selected
cat /proc/crypto | grep -A 10 "name.*gcm"
# name         : gcm(aes)
# driver       : generic-gcm-aesni
# module       : kernel
# priority     : 400     ← base AES-NI selected (higher-priority AVX/VAES variants need newer CPU support)

# Run the full crypto test suite (requires CONFIG_CRYPTO_TEST)
modprobe tcrypt mode=0
```

### Intel AES-NI

AES-NI adds hardware instructions for AES rounds. The kernel implementation uses them via SIMD (SSE/AVX) register operations:

```c
/* arch/x86/crypto/aesni-intel_glue.c — real cbc_encrypt() */
static int cbc_encrypt(struct skcipher_request *req)
{
    struct crypto_skcipher *tfm = crypto_skcipher_reqtfm(req);
    struct crypto_aes_ctx *ctx = aes_ctx(crypto_skcipher_ctx(tfm));
    struct skcipher_walk walk;
    unsigned int nbytes;
    int err;

    /* Kernel must save/restore SIMD registers around these calls */
    err = skcipher_walk_virt(&walk, req, false);
    while ((nbytes = walk.nbytes)) {
        kernel_fpu_begin();   /* save FPU state */
        aesni_cbc_enc(ctx, walk.dst.virt.addr, walk.src.virt.addr,
                      nbytes & AES_BLOCK_MASK, walk.iv);  /* AESENC instruction */
        kernel_fpu_end();     /* restore FPU state */
        nbytes &= AES_BLOCK_SIZE - 1;
        err = skcipher_walk_done(&walk, nbytes);
    }
    return err;
}
```

The `crypto_simd_usable()`/fallback branch used when SIMD isn't available (e.g. in some interrupt contexts) lives one layer up, in key setup (`aes_set_key_common()`), not inline in each per-block encrypt function like `cbc_encrypt()`.

`kernel_fpu_begin()` is relatively expensive (saves ~512 bytes of SIMD state), so AES-NI is most beneficial for large buffers.

## AF_ALG: userspace access to kernel crypto

AF_ALG sockets expose kernel crypto to userspace. The kernel's own documentation
([`userspace-if.rst`](https://docs.kernel.org/crypto/userspace-if.html), cited below) is blunt
about it: AF_ALG is deprecated, "most kernel developers now consider it to be a mistake," its
original purpose (giving userspace access to hardware accelerators) has been removed, it is
always slower than an optimized userspace implementation, and it has a history of CVEs. New
code should use a userspace crypto library instead; this section documents the interface as it
exists, not as a recommended approach.

```c
/* Userspace: use kernel AES-GCM via AF_ALG socket */
int sockfd = socket(AF_ALG, SOCK_SEQPACKET, 0);

struct sockaddr_alg sa = {
    .salg_family = AF_ALG,
    .salg_type   = "aead",
    .salg_name   = "gcm(aes)",
};
bind(sockfd, (struct sockaddr *)&sa, sizeof(sa));

/* Set key */
setsockopt(sockfd, SOL_ALG, ALG_SET_KEY, key, sizeof(key));
setsockopt(sockfd, SOL_ALG, ALG_SET_AEAD_AUTHSIZE, NULL, 16);

/* Accept returns operation fd */
int opfd = accept(sockfd, NULL, 0);

/* Encrypt via sendmsg/recvmsg */
struct cmsghdr cmsg;
/* ... set IV, AD length in ancillary data ... */
sendmsg(opfd, &msg, 0);
recvmsg(opfd, &msg_out, 0);
```

## Observing the crypto subsystem

```bash
# All registered algorithms with priority
cat /proc/crypto

# Crypto test suite (requires CONFIG_CRYPTO_TEST)
modprobe tcrypt mode=0   # test all algorithms (mode=1 tests MD5 only)
modprobe tcrypt mode=200 # benchmark AES
# testing AES-128-ECB encryption
#  128 bit key:  1234.5 MB/s

# Hardware utilization (QAT example)
cat /sys/kernel/debug/qat_*/fw_counters

# CPU cycles for crypto (perf)
perf stat -e instructions,cycles cryptsetup benchmark
```

## Further reading

### Kernel source

- [include/linux/crypto.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/crypto.h) — `struct crypto_alg`, `CRYPTO_ALG_TYPE_*`, and the `cra_*` flag bits
- [include/crypto/skcipher.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/crypto/skcipher.h) — `crypto_alloc_skcipher()`, `skcipher_request_set_crypt()`, and the full SKCIPHER API surface
- [include/crypto/aead.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/crypto/aead.h) — `crypto_alloc_aead()`, `aead_request_set_ad()`, `crypto_aead_setauthsize()`
- [include/crypto/hash.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/crypto/hash.h) — `crypto_alloc_shash()`/`crypto_alloc_ahash()`, `SHASH_DESC_ON_STACK`, `ahash_request_set_crypt()`
- [arch/x86/crypto/aesni-intel_glue.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/crypto/aesni-intel_glue.c) — the real AES-NI SKCIPHER implementations (`cbc_encrypt()`, `ecb_encrypt()`, the `DEFINE_GCM_ALGS()` AEAD family) and their registered `cra_priority` values
- [Documentation/crypto/userspace-if.rst](https://docs.kernel.org/crypto/userspace-if.html) — the AF_ALG user-space interface; as of this kernel it opens with an explicit deprecation notice (see note below)

### Related pages

- [dm-crypt and fscrypt](encryption.md) — the main consumer of SKCIPHER/AEAD for storage encryption
- [crypto_engine: Hardware Offload Framework](crypto-engine.md) — how DMA-based hardware accelerators plug into the `cra_priority` selection this page describes
- [Kernel Keyring](keyring.md) — where key material handed to `crypto_*_setkey()` is usually stored
- [Random Number Generation](rng.md) — `crypto_alloc_rng()` and the DRBG algorithms exposed through this same API
- [Crypto War Stories](war-stories.md) — IV reuse, timing side channels, and a hardware accelerator that silently corrupted AES-GCM output

### LWN articles

- [A netlink-based user-space crypto API](https://lwn.net/Articles/410763/) — Jake Edge, October 20, 2010: Herbert Xu's original proposal for the `AF_ALG` address family covered in this page
- [WireGuard and the crypto API](https://lwn.net/Articles/802376/) — Jake Edge, October 16, 2019: Jason Donenfeld's and Linus Torvalds's criticism of the abstract AEAD/SKCIPHER interfaces for performance-critical, compile-time-known transforms
- [Progress in modernizing kernel cryptography](https://lwn.net/Articles/1077427/) — Joe Brockmeier, July 8, 2026: Eric Biggers on the overhead of the `struct crypto_alg`/SKCIPHER/AEAD model described on this page, and the ongoing move toward simpler `lib/crypto` library functions

### External

- [NIST SP 800-38D: Recommendation for Block Cipher Modes of Operation — GCM and GMAC](https://csrc.nist.gov/pubs/sp/800/38/d/final) — the specification behind `"gcm(aes)"`, including the 96-bit IV recommendation used in the AEAD example above
