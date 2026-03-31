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
