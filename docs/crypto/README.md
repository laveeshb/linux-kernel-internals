# Crypto Subsystem

> Cryptographic algorithms, kernel key management, and storage encryption

## The crypto stack

```
User space:    openssl / libgcrypt / kernel keyctl
                         │
      ┌──────────────────┼───────────────────────┐
      │                  │                        │
  AF_ALG socket     kernel keyring           dm-crypt / fscrypt
  (access kernel    (key storage)            (disk/file encryption)
   crypto from       struct key
   userspace)             │
      │                   │
      └──────────┬─────────┘
                 │
         Kernel Crypto API
         (crypto/*)
         struct crypto_alg
         ┌──────────────────────────────┐
         │ SKCIPHER  AEAD  HASH  AKCIPHER│
         │ (AES-XTS) (AES-GCM) (SHA-256)│
         └──────────────────────────────┘
                 │
         Hardware acceleration
         Intel AES-NI / QAT / ARM CE
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Kernel Crypto API](crypto-api.md) | struct crypto_alg, SKCIPHER, AEAD, hash, hardware offload |
| [dm-crypt and fscrypt](encryption.md) | Block-level and file-level encryption, keyring integration |
| [crypto_engine: Hardware Offload Framework](crypto-engine.md) | DMA-based hardware accelerators, driver callbacks, fallback pattern |
| [Kernel Keyring](keyring.md) | Key types (user, logon, trusted, encrypted), TPM-backed keys, keyctl |
| [Random Number Generation](rng.md) | /dev/random, getrandom(), DRBG, hardware entropy, VM entropy |
| [Crypto War Stories](war-stories.md) | IV reuse, timing attacks, boot entropy, keyring leaks, hardware bugs |

## Reading order

| Step | Page | Why |
|------|------|-----|
| 1 | [Getting Started](README.md) | Stack diagram and quick reference |
| 2 | [Kernel Crypto API](crypto-api.md) | Core abstractions: SKCIPHER, AEAD, hash, AF_ALG |
| 3 | [dm-crypt and fscrypt](encryption.md) | How the crypto API is used for storage encryption |
| 4 | [crypto_engine](crypto-engine.md) | How hardware accelerators plug in; the async driver model |
| 5 | [Kernel Keyring](keyring.md) | Where keys live; key types, permissions, TPM integration |
| 6 | [Random Number Generation](rng.md) | Where cryptographic randomness comes from |
| 7 | [Crypto War Stories](war-stories.md) | Real bugs and how the internals from above led to (or prevented) them |

## Quick reference

```bash
# List available crypto algorithms
cat /proc/crypto

# Check if AES-NI is available
grep aes /proc/cpuinfo

# Test crypto performance
cryptsetup benchmark
# Testing 128 bit cipher AES-XTS... 1234.5 MiB/s

# Key management
keyctl show           # show process keyrings
keyctl add user mykey "mysecret" @u
keyctl search @u user mykey
```
