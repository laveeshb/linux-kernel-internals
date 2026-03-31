# dm-crypt and fscrypt

> Block-level and file-level encryption in Linux

## Two encryption layers

Linux provides encryption at two levels:

| Layer | Subsystem | What's encrypted | Key granularity |
|-------|-----------|-----------------|-----------------|
| Block device | dm-crypt | Entire partition/disk | One key per volume |
| Filesystem | fscrypt | Individual files/dirs | Per-file or per-directory keys |

dm-crypt is transparent to the filesystem; fscrypt is transparent to applications but per-file.

## dm-crypt: block-level encryption

dm-crypt is a device mapper target that transparently encrypts reads and writes using the kernel crypto API.

```
Application → read/write /dev/mapper/myvolume
                              │
                         dm-crypt layer
                         (AES-XTS decrypt/encrypt)
                              │
                         /dev/sda2 (ciphertext on disk)
```

### LUKS: Linux Unified Key Setup

LUKS is the standard format for dm-crypt volumes. It stores encrypted key material in a header, allowing multiple passphrases to unlock the same volume:

```bash
# Create a LUKS volume
cryptsetup luksFormat /dev/sda2
# Enter passphrase

# Open (decrypt) the volume
cryptsetup luksOpen /dev/sda2 myvolume
# /dev/mapper/myvolume now exists

# Use it like any block device
mkfs.ext4 /dev/mapper/myvolume
mount /dev/mapper/myvolume /mnt/secure

# Close (re-encrypt the volume key, remove device)
umount /mnt/secure
cryptsetup luksClose myvolume
```

### dm-crypt internals

```c
/* drivers/md/dm-crypt.c */
struct crypt_config {
    struct dm_dev       *dev;           /* backing block device */
    sector_t             start;

    /* Per-CPU I/O work queues */
    struct workqueue_struct *io_queue;
    struct workqueue_struct *crypt_queue;

    /* Crypto transform */
    struct crypto_skcipher **tfms;      /* one per CPU for parallelism */
    unsigned int          tfms_count;

    /* IV generator */
    struct iv_operations  *iv_gen_ops;  /* ESSIV, plain64, benbi, ... */
    char                  iv_mode[CRYPTO_MAX_ALG_NAME];

    unsigned long long    iv_offset;    /* sector number offset for IV */
    unsigned int          iv_size;

    char                  cipher_string[CRYPTO_MAX_ALG_NAME];

    struct crypt_iv_operations *iv_gen_private;
};

/* Each I/O is processed in a crypt_io */
struct dm_crypt_io {
    struct crypt_config    *cc;
    struct bio             *base_bio;
    u8                     *integrity_metadata;

    struct work_struct      work;   /* submitted to crypt_queue */

    struct convert_context  ctx;    /* current conversion state */
    atomic_t                io_pending;
    blk_status_t            error;
    sector_t                sector;
};
```

### AES-XTS: why not CBC?

dm-crypt uses AES-XTS (XEX-based tweaked-codebook mode with ciphertext stealing) rather than AES-CBC for disk encryption:

**CBC weakness for disk encryption**: In CBC, sector 1 always encrypts to the same ciphertext for a given key (the IV is derived from the sector number). An attacker can detect which sectors have identical plaintext. AES-XTS uses a tweak derived from the physical sector number, making each sector's encryption unique.

```
AES-XTS(key, sector_num, plaintext) → ciphertext

Tweak = AES_encrypt(key2, sector_num)
For each 16-byte block i in the sector:
  ciphertext[i] = AES_encrypt(key1, plaintext[i] XOR tweak_i) XOR tweak_i
  tweak_{i+1}   = GF(2^128) multiplication of tweak_i
```

### IV generation

dm-crypt supports several IV modes:

```c
/* IV modes (selected by the cipher string): */

/* plain/plain64: IV = sector number */
/* "aes-cbc-plain64" */

/* essiv: IV = encrypt(sector_num) with SHA256 of volume key */
/* Prevents watermarking attacks against CBC */
/* "aes-cbc-essiv:sha256" */

/* Standard for new volumes: */
/* "aes-xts-plain64" — sector number as 64-bit LE integer */
```

## dm-integrity: authenticated block storage

dm-integrity adds a per-sector checksum to detect data corruption:

```bash
# Create an integrity device (adds 4-byte CRC per 512-byte sector)
cryptsetup open --type integrity /dev/sda2 myintegrity
# Or combine with dm-crypt for authenticated encryption:
cryptsetup luksFormat --integrity hmac-sha256 /dev/sda2
```

## fscrypt: filesystem-level encryption

fscrypt is built into ext4, f2fs, and ubifs. It encrypts file contents and filenames, with keys stored in the kernel keyring.

```
Directory with encryption policy:
  /encrypted/
  ├── Afvd3kLm (encrypted filename → real: "secret.txt")
  └── Bxyz9pQr (encrypted filename → real: "notes.md")

Reading a file:
  open("/encrypted/Afvd3kLm") → page cache miss
  → read block from disk (ciphertext)
  → fscrypt_decrypt_pagecache_blocks()
  → AES-256-XTS with per-file derived key
  → return plaintext
```

### Setting up fscrypt

```bash
# Requires CONFIG_FS_ENCRYPTION=y and an fscrypt-capable filesystem

# Generate a master key (256 bits)
keyctl new_session
fscryptctl generate-key > master.key

# Add master key to filesystem
fscryptctl add-key /mnt/myfs < master.key
# Key identifier: 0123456789abcdef0123456789abcdef

# Set encryption policy on a directory
fscryptctl set-policy 0123456789abcdef0123456789abcdef /mnt/myfs/private/
# Now all files created under /mnt/myfs/private/ are encrypted

# After unmounting and remounting without the key:
# filenames appear as ciphertext, content unreadable
```

### Key hierarchy

fscrypt derives per-file keys from the master key using HKDF-SHA512:

```
Master key (256 bit)
      │
      │ HKDF-SHA512(master_key, "fscrypt\0" || context || nonce)
      ▼
Per-file key (256 bit, unique per inode)
      │
      │ AES-256-XTS
      ▼
Encrypted content
```

The nonce stored in the inode is unique per file, ensuring different keys for files with identical content.

### fscrypt policies

```c
/* include/uapi/linux/fscrypt.h */
struct fscrypt_policy_v2 {
    __u8 version;                       /* FSCRYPT_POLICY_V2 = 2 */
    __u8 contents_encryption_mode;      /* FSCRYPT_MODE_AES_256_XTS */
    __u8 filenames_encryption_mode;     /* FSCRYPT_MODE_AES_256_CTS */
    __u8 flags;                         /* FSCRYPT_POLICY_FLAGS_PAD_* */
    __u8 log2_data_unit_size;           /* 0 = filesystem block size */
    __u8 __reserved[3];
    __u8 master_key_identifier[FSCRYPT_KEY_IDENTIFIER_SIZE]; /* 16 bytes */
};

/* Encryption modes: */
FSCRYPT_MODE_AES_256_XTS   /* for file contents (recommended) */
FSCRYPT_MODE_AES_256_CTS   /* for filenames */
FSCRYPT_MODE_AES_128_CBC   /* legacy */
FSCRYPT_MODE_ADIANTUM      /* for low-power devices (no AES-NI) */
```

### fscrypt in the kernel

```c
/* fs/crypto/crypto.c */
int fscrypt_decrypt_pagecache_blocks(struct folio *folio, size_t len,
                                      size_t offs)
{
    const struct inode *inode = folio->mapping->host;
    const unsigned int du_bits = inode->i_crypt_info->ci_data_unit_bits;
    const unsigned int du_size = 1U << du_bits;
    u64 index = ((u64)folio->index << (PAGE_SHIFT - du_bits)) + (offs >> du_bits);
    unsigned int i;

    for (i = offs; i < offs + len; i += du_size, index++) {
        /* Derive IV from file offset (sector number equivalent) */
        u64 lblk_num = index;  /* logical block number */

        /* Decrypt using per-file key */
        fscrypt_crypt_block(inode, FS_DECRYPT, lblk_num,
                            folio_page(folio, i >> PAGE_SHIFT), ...);
    }
    return 0;
}
```

## Kernel keyring integration

Both dm-crypt (via cryptsetup) and fscrypt store key material in the kernel keyring:

```bash
# View current keyring
keyctl show @s         # session keyring
keyctl show @u         # user keyring
keyctl show @us        # user-session keyring

# Add a dm-crypt volume key to the keyring
keyctl add logon cryptsetup:0123456789abcdef <key_data> @s

# Add an fscrypt master key
keyctl add logon fscrypt:0123456789abcdef <key_data> @s

# Key types used:
# "user": arbitrary user data
# "logon": kernel-only (cannot be read back by userspace)
# "keyring": a keyring itself (can hold other keys)
# "encrypted": encrypted with a master key
```

```c
/* Kernel: look up a key */
struct key *key = request_key(&key_type_logon, "fscrypt:...", NULL);
const struct user_key_payload *ukp = user_key_payload_locked(key);
memcpy(master_key, ukp->data, ukp->datalen);
key_put(key);
```

## Observing encryption

```bash
# dm-crypt status
cryptsetup status myvolume
# /dev/mapper/myvolume is active and is in use.
#   type:    LUKS2
#   cipher:  aes-xts-plain64
#   keysize: 512 bits     (256 data + 256 tweak for XTS)
#   key location: dm-crypt
#   device:  /dev/sda2

# LUKS header info
cryptsetup luksDump /dev/sda2

# fscrypt status
fscryptctl get-policy /mnt/myfs/private/
# Encryption policy for /mnt/myfs/private/:
#   Policy version: 2
#   Master key identifier: 0123456789abcdef0123456789abcdef
#   Contents encryption mode: AES-256-XTS
#   Filenames encryption mode: AES-256-CTS

# Performance
cryptsetup benchmark
# Tests common cipher/mode combinations

# Block layer stats (I/O through dm-crypt)
cat /sys/block/dm-0/stat
```

## Further reading

- [Kernel Crypto API](crypto-api.md) — AES-XTS and AEAD internals
- [Memory Management: DMA](../mm/dma.md) — DMA for hardware crypto engines
- [Security: Capabilities](../security/capabilities.md) — `CAP_SYS_ADMIN` for dm setup
- [Block Layer: bio and request](../block/bio-request.md) — bio processing through dm-crypt
- `drivers/md/dm-crypt.c` — dm-crypt implementation
- `fs/crypto/` — fscrypt implementation
- `man 8 cryptsetup` — LUKS management
