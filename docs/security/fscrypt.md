# fscrypt: Per-File Encryption

> Key hierarchy, HKDF derivation, and transparent encryption in ext4/F2FS/Btrfs

## Overview

fscrypt provides **per-directory** transparent encryption at the VFS layer. Unlike dm-crypt (full disk), fscrypt encrypts individual files and directories, allowing:
- Multiple users to have separate encrypted directories with different keys
- Selective encryption (not all files need to be encrypted)
- Fast key revocation (remove key → files become inaccessible)

Supported filesystems: **ext4, F2FS, UBIFS, Btrfs** (5.14+)

```
Application read()/write()
          ↓
    Page cache (plaintext while key is present)
          ↓ (encrypt on writeback, decrypt on readahead)
    fscrypt layer
          ↓
    Block device (ciphertext)
```

## Key hierarchy

fscrypt uses a two-level key hierarchy:

```
User passphrase / TPM / hardware key
         ↓ PBKDF2 or Argon2 (userspace)
Master key (256-bit, type: ext4/logon)
         ↓ HKDF-SHA512 (kernel)
         ├── File encryption key (per-file, derived from master + file nonce)
         ├── Filename encryption key (for directory entries)
         └── IV (per-block, derived from file nonce + block number)
```

Each encrypted directory has a **policy** that records:
- Which master key to use (by key descriptor or key identifier)
- Which encryption mode (AES-256-XTS for contents, AES-256-CTS for filenames)
- Key derivation version (v1 trusted keyring, v2 HKDF)

## Setting up encryption (API v2)

```bash
# Step 1: Enable encryption on the filesystem (ext4):
tune2fs -O encrypt /dev/sda1
# or at mkfs time:
mkfs.ext4 -O encrypt /dev/sda1

# Step 2: Add master key to kernel keyring:
# Generate a 512-bit key:
dd if=/dev/urandom bs=64 count=1 of=/tmp/master_key 2>/dev/null

# Add to session keyring:
keyctl add logon fscrypt:$(xxd -p /tmp/master_key | head -c 16) \
    /tmp/master_key @s

# Or using the fscrypt tool:
apt install fscrypt
fscrypt setup /dev/sda1
fscrypt encrypt /home/user/private/ --user=user
```

### Kernel ioctl API

```c
#include <linux/fscrypt.h>

/* Step 1: Add master key to filesystem keyring */
struct fscrypt_add_key_arg {
    struct fscrypt_key_specifier key_spec;  /* identifies the key */
    __u32 raw_size;     /* 16-64 bytes for AES, 64 bytes for HKDF */
    __u32 key_id;       /* output: kernel-assigned ID */
    __u32 __reserved[8];
    __u8  raw[];        /* key material */
};

struct fscrypt_key_specifier key_spec = {
    .type = FSCRYPT_KEY_SPEC_TYPE_IDENTIFIER,  /* v2: HKDF-based */
};
int key_fd = open("/", O_RDONLY);
ioctl(key_fd, FS_IOC_ADD_ENCRYPTION_KEY, &add_key_arg);
/* Returns key_spec.u.identifier (16-byte hash of key) */

/* Step 2: Set encryption policy on a directory */
struct fscrypt_policy_v2 policy = {
    .version           = FSCRYPT_POLICY_V2,
    .contents_encryption_mode = FSCRYPT_MODE_AES_256_XTS,
    .filenames_encryption_mode = FSCRYPT_MODE_AES_256_CTS,
    .flags             = FSCRYPT_POLICY_FLAGS_PAD_32,
    .master_key_identifier = /* key_spec.u.identifier */,
};
int dir_fd = open("/home/user/private", O_RDONLY);
ioctl(dir_fd, FS_IOC_SET_ENCRYPTION_POLICY, &policy);
/* From now on, all new files in this directory are encrypted */
```

## Key derivation internals

```c
/* fs/crypto/hkdf.c */

/* HKDF-SHA512 is used to derive all per-file keys: */

/* File content key: */
/* Input keying material (IKM) = master_key */
/* Info = "fscrypt\0" + mode + filesystem UUID + file nonce */
fscrypt_hkdf_expand(&ci->ci_master_key->mk_secret.hkdf,
                     HKDF_CONTEXT_PER_FILE_ENC_KEY,
                     info, infolen,
                     derived_key, mode->keysize);

/* File nonce: random 16 bytes stored in inode on disk */
/* Every file gets a unique nonce → unique key even if same master key */

/* Per-file key stored in: */
struct fscrypt_inode_info {
    struct fscrypt_master_key *ci_master_key;
    union fscrypt_iv    ci_iv;          /* per-block IV base */
    struct crypto_skcipher *ci_enc_key; /* actual cipher */
    /* ... */
};
```

### IV generation (per-block)

```c
/* For AES-256-XTS (contents encryption): */
/* IV = file_nonce XOR (block_number as little-endian u64) */
/* → each 4K block has a unique IV derived from the file */

/* For filename encryption (AES-256-CTS): */
/* IV = 0 (filenames are encrypted with ECB-like semantics) */
/* → same filename in same directory always encrypts the same way */
/* → directory listing is possible (if you have the key), order leaks */

/* For SipHash-based IV (policy flag FSCRYPT_POLICY_FLAG_IV_INO_LBLK_64): */
/* IV = SipHash(file_nonce, ino, block_number) */
/* Enables hardware inline encryption (one key per filesystem) */
```

## Inline encryption hardware

```bash
# Check for inline encryption support:
cat /sys/block/nvme0n1/queue/crypto_capabilities 2>/dev/null
# AES-256-XTS, key size 64, data unit size 512/1024/2048/4096

# Mount with inline encryption:
mount -o inlinecrypt /dev/nvme0n1p1 /data
# Kernel programs NVMe keyslot; block layer does encryption in hardware
# CPU only sets up keys — no per-block crypto overhead

# Check if inlinecrypt is active:
cat /proc/mounts | grep inlinecrypt
```

## Key revocation and locking

```c
/* Remove master key from filesystem (lock encrypted directories): */
ioctl(fs_fd, FS_IOC_REMOVE_ENCRYPTION_KEY, &key_spec);
/* All pages of encrypted files are evicted from page cache */
/* Inode's ci_enc_key is freed → files become unreadable */
/* On next access attempt: -ENOKEY (key not available) */
```

```bash
# Using fscrypt tool:
fscrypt lock /home/user/private/   # lock (remove key from kernel)
fscrypt unlock /home/user/private/ # unlock (re-add key)

# Check encryption status:
fscrypt status /home/user/private/
# "/home/user/private": encrypted
#   Policy version:      2
#   Encryption mode:     AES-256-XTS (contents)
#                        AES-256-CTS (filenames)
#   Key:                 unlocked (key identifier: abc123...)
```

## fscrypt vs dm-crypt

| | fscrypt | dm-crypt |
|---|---------|----------|
| Granularity | Per-directory | Full block device |
| Multiple keys | Yes | No (one key per device) |
| Key revocation | Hot-revoke (pages evicted) | Unmount required |
| Metadata encryption | Filenames only | All metadata |
| Performance | Slightly higher CPU | AES-NI nearly free |
| Use case | Multi-user (Android FBE, shared laptops) | Single-user laptop, server |
| Filesystem | ext4/F2FS/Btrfs | Any FS on top |

## Observability

```bash
# Check if a file is encrypted:
fscryptctl get_policy /home/user/private/secret.txt
# Encryption policy for /home/user/private/secret.txt:
#   Policy version: 2
#   Master key identifier: abc1234567890def
#   Contents encryption mode: AES-256-XTS
#   Filenames encryption mode: AES-256-CTS
#   Flags: PAD_32

# List all master keys in a filesystem:
ioctl(fs_fd, FS_IOC_GET_ENCRYPTION_KEY_STATUS, &status)
# (or use fscrypt status)

# dmesg for crypto errors:
dmesg | grep -E "fscrypt|crypto"

# BPF trace key lookups:
bpftrace -e 'kprobe:fscrypt_get_encryption_info { @[comm] = count(); }'
```

## Further reading

- [dm-crypt](dm-crypt.md) — full-disk encryption alternative
- [xattr](../vfs/xattr.md) — fscrypt stores policy in `trusted.fscrypt` xattr
- [Linux Audit](audit.md) — audit fscrypt key operations
- [Credentials](credentials.md) — per-user keyrings for master keys
- `fs/crypto/` — fscrypt implementation
- `Documentation/filesystems/fscrypt.rst`
