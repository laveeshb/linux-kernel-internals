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

    int                 cra_priority;  /* higher = preferred (e.g., AES-NI > software) */
    atomic_t            cra_refcnt;

    char                cra_name[CRYPTO_MAX_ALG_NAME];    /* "aes", "sha256", ... */
    char                cra_driver_name[CRYPTO_MAX_ALG_NAME]; /* "aes-aesni", ... */

    const struct crypto_type *cra_type;

    union {
        struct ablkcipher_alg  ablkcipher;
        struct blkcipher_alg   blkcipher;
        struct cipher_alg      cipher;
        struct compress_alg    compress;
    } cra_u;

    int (*cra_init)(struct crypto_tfm *tfm);
    void (*cra_exit)(struct crypto_tfm *tfm);
    void (*cra_destroy)(struct crypto_alg *alg);

    struct module          *cra_module;
};
```

## SKCIPHER: symmetric ciphers

SKCIPHER (synchronous key cipher) is the API for symmetric block ciphers like AES-CBC, AES-XTS, ChaCha20:

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
| 800  | Intel AES-NI + PCLMULQDQ |
| 300  | Generic C implementation |

```bash
# See which implementation is selected
cat /proc/crypto | grep -A 10 "name.*gcm"
# name         : gcm(aes)
# driver       : gcm_base(ctr(aes-aesni),ghash-clmulni-intel)
# module       : kernel
# priority     : 800     ← AES-NI selected

# Force software implementation (for testing)
modprobe tcrypt mode=1  # run crypto test suite
```

### Intel AES-NI

AES-NI adds hardware instructions for AES rounds. The kernel implementation uses them via SIMD (SSE/AVX) register operations:

```c
/* arch/x86/crypto/aesni-intel_glue.c */
static int aesni_skcipher_encrypt(struct skcipher_request *req)
{
    struct crypto_skcipher *tfm = crypto_skcipher_reqtfm(req);
    struct crypto_aes_ctx *ctx = aes_ctx(crypto_skcipher_ctx(tfm));

    /* Kernel must save/restore SIMD registers around these calls */
    if (!crypto_simd_usable())
        return crypto_skcipher_encrypt_fallback(req);

    kernel_fpu_begin();   /* save FPU state */
    aesni_cbc_enc(ctx, dst, src, len, iv);  /* AESENC instruction */
    kernel_fpu_end();     /* restore FPU state */
    return 0;
}
```

`kernel_fpu_begin()` is relatively expensive (saves ~512 bytes of SIMD state), so AES-NI is most beneficial for large buffers.

## AF_ALG: userspace access to kernel crypto

AF_ALG sockets expose kernel crypto to userspace without copying data to/from kernel buffers:

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
modprobe tcrypt mode=1   # test all algorithms
modprobe tcrypt mode=200 # benchmark AES
# testing AES-128-ECB encryption
#  128 bit key:  1234.5 MB/s

# Hardware utilization (QAT example)
cat /sys/kernel/debug/qat_*/fw_counters

# CPU cycles for crypto (perf)
perf stat -e instructions,cycles cryptsetup benchmark
```

## Further reading

- [dm-crypt and fscrypt](encryption.md) — using kernel crypto for storage
- [BPF: verifier](../bpf/bpf-verifier.md) — BPF crypto helpers
- [Security: seccomp](../security/seccomp.md) — restricting crypto syscalls
- `crypto/` in the kernel tree — algorithm implementations
- `Documentation/crypto/` in the kernel tree
