# dm-crypt: Block-Level Encryption

> Device mapper encryption target, LUKS2 key management, and AES-XTS

## Architecture

dm-crypt sits in the device mapper stack, transparently encrypting/decrypting all I/O between the filesystem and the block device:

```
Application
    ↓ read/write
Filesystem (ext4/Btrfs/XFS)
    ↓ block I/O
dm-crypt (device mapper target)
    ↓ encrypt on write, decrypt on read
Block device (/dev/sda1, NVMe, etc.)
    ↓
Physical storage: only ciphertext on disk
```

```bash
# View dm-crypt device:
dmsetup table /dev/mapper/cryptroot
# 0 976771072 crypt aes-xts-plain64 :64:logon:cryptsetup:...
# sectors:    cipher           key          IV mode
```

## LUKS2 on-disk format

LUKS (**L**inux **U**nified **K**ey **S**etup) is the standard format for dm-crypt headers. LUKS2 (since kernel 4.12 / cryptsetup 2.0):

```
LUKS2 on-disk layout:
┌─────────────────────────────────────────────────────────┐
│ LUKS2 header (4KB) + backup header (4KB)                │
│   magic: "LUKS\xba\xbe" + version: 2                    │
│   hdr_size, seqid, label, checksum_alg                  │
│   salt[64], uuid, subsystem                             │
├─────────────────────────────────────────────────────────┤
│ JSON metadata area (variable, default 16KB)             │
│   keyslots: [{type, priority, kdf_params, af_params}]   │
│   tokens: [{type, keyslots: [...]}]                     │
│   segments: [{type: "crypt", offset, size, iv_tweak,    │
│               encryption: "aes-xts-plain64", ...}]      │
│   digests: [{type: "pbkdf2", keyslots, segments,        │
│              salt, digest}]                             │
├─────────────────────────────────────────────────────────┤
│ Keyslot area (default 16MB)                             │
│   Each keyslot: AF-split master key encrypted with      │
│   user passphrase-derived key                           │
├─────────────────────────────────────────────────────────┤
│ Encrypted data (segment 0)                              │
│   All filesystem data encrypted with master key         │
└─────────────────────────────────────────────────────────┘
```

### Key derivation (PBKDF2/Argon2)

```
User passphrase
      ↓ PBKDF2 or Argon2id (memory-hard, tuned to take ~1 second)
Derived key (same size as master key)
      ↓ XOR with AF-split stripes
Master key (256-bit for AES-256-XTS)
      ↓ used directly for AES-XTS encryption
```

Argon2id (LUKS2 default) is memory-hard — defeating GPU brute-force attacks.

## cryptsetup: LUKS management

```bash
# Create LUKS2 container:
cryptsetup luksFormat --type luks2 \
    --cipher aes-xts-plain64 \
    --key-size 512 \           # 512-bit key = AES-256-XTS (split 256+256)
    --hash sha512 \
    --pbkdf argon2id \
    --iter-time 3000 \         # KDF tuning: target 3 seconds
    /dev/sda1

# Open (decrypt and create /dev/mapper/mydev):
cryptsetup open /dev/sda1 mydev
# Prompts for passphrase → creates /dev/mapper/mydev

# Create filesystem on decrypted device:
mkfs.ext4 /dev/mapper/mydev
mount /dev/mapper/mydev /mnt

# Close (remove decrypted device):
umount /mnt
cryptsetup close mydev

# Show LUKS header info:
cryptsetup luksDump /dev/sda1
# Version:        2
# Epoch:          3
# Metadata area:  16384 [bytes]
# Keyslots area:  16744448 [bytes]
# UUID:           ...
# Label:          (no label)
# Subsystem:      (no subsystem)
# Flags:          (no flags)
# Keyslots:
#  0: luks2 (active)
#     Priority:   normal
#     Cipher:     aes-xts-plain64
#     Cipher key: 512 bits
#     PBKDF:      argon2id

# Add a second passphrase (key slot 1):
cryptsetup luksAddKey /dev/sda1

# Add a keyfile (for automated unlock):
dd if=/dev/urandom of=/root/keyfile bs=512 count=4
cryptsetup luksAddKey /dev/sda1 /root/keyfile

# Open with keyfile:
cryptsetup open /dev/sda1 mydev --key-file /root/keyfile

# Remove a passphrase:
cryptsetup luksKillSlot /dev/sda1 1   # remove slot 1
```

## dm-crypt kernel target

The kernel-side implementation is in `drivers/md/dm-crypt.c`:

```c
/* Device mapper target structure */
struct dm_target {
    /* ... */
    sector_t begin;    /* start of the target in the device */
    sector_t len;      /* length of the target */
    struct target_type *type;
    void *private;     /* points to crypt_config */
};

/* dm-crypt private state */
struct crypt_config {
    struct dm_dev   *dev;          /* underlying device */
    sector_t         start;        /* start sector */

    /* Crypto */
    struct crypto_skcipher **tfms; /* per-CPU cipher handles */
    unsigned int     tfms_count;   /* = num_cpus */
    char            *cipher_string; /* "aes-xts-plain64" */
    unsigned int     key_size;
    u8              *key;          /* master key in kernel memory */

    /* IV */
    iv_generator_fn  iv_gen_ops;   /* plain64, essiv, tcw, etc. */

    /* I/O */
    mempool_t        req_pool;     /* pool of crypt_io structs */
    struct workqueue_struct *io_queue;   /* encrypt/decrypt workers */
    struct workqueue_struct *crypt_queue;
};
```

### Encryption path (write)

```c
/* dm-crypt intercepts every bio: */
static int crypt_map(struct dm_target *ti, struct bio *bio)
{
    struct crypt_io *io;
    struct crypt_config *cc = ti->private;

    /* Allocate per-request state */
    io = mempool_alloc(&cc->io_pool, GFP_NOIO);
    io->cc = cc;
    io->base_bio = bio;

    if (bio_data_dir(bio) == WRITE) {
        /* Encrypt: submit to crypt_queue workqueue */
        kcryptd_queue_crypt(io);
    } else {
        /* Read: submit plain I/O, decrypt in completion */
        crypt_submit_bio(cc, io, bio);
    }
    return DM_MAPIO_SUBMITTED;
}

/* Encryption worker: */
static void kcryptd_crypt_write_io_submit(struct crypt_io *io, int async)
{
    /* For each page in the bio: */
    /*   1. Set up IV from sector number */
    /*   2. skcipher_request_set_crypt() */
    /*   3. crypto_skcipher_encrypt() */
    /*   4. Submit encrypted bio to underlying device */
}
```

### IV modes

```
plain64:   IV = sector_number (64-bit)
           Simple, fast; vulnerable to watermarking attacks

essiv:     IV = encrypt(sector_number, hash(master_key))
           Sector numbers not visible as IVs

tcw:       Tweak-CBC-Wide; for XTS mode with twist
           Resists CPA (chosen plaintext attacks)

aes-xts-plain64 (recommended):
           XTS = XEX (XOR-Encrypt-XOR) Tweakable Block Cipher
           Two AES keys: one for encryption, one for IV tweak
           Standard for disk encryption (IEEE P1619)
```

## Performance

```bash
# Benchmark cipher options:
cryptsetup benchmark
# # Tests are approximate using memory only (no storage IO).
# PBKDF2-sha1        1234567 iterations per second for 256-bit key
# PBKDF2-sha512       543210 iterations per second for 256-bit key
# argon2i           7 iterations per second for 256-bit key (64 MB memory)
# argon2id          7 iterations per second for 256-bit key (64 MB memory)
# #     Algorithm |       Key |      Encryption |      Decryption
#          aes-cbc        128b      1234.5 MiB/s      3456.7 MiB/s
#          aes-cbc        256b      1012.3 MiB/s      2890.1 MiB/s
#          aes-xts        256b      2100.4 MiB/s      2098.7 MiB/s
#          aes-xts        512b      1890.2 MiB/s      1887.3 MiB/s

# AES-NI hardware acceleration:
grep -m1 aes /proc/cpuinfo
# flags: ... aes ...  ← hardware AES-NI present

# Measure dm-crypt overhead vs raw device:
fio --filename=/dev/mapper/mydev --direct=1 --rw=read --bs=128k \
    --ioengine=libaio --iodepth=32 --name=crypt-read
fio --filename=/dev/sda1 --direct=1 --rw=read --bs=128k \
    --ioengine=libaio --iodepth=32 --name=raw-read
# With AES-NI: typically < 5% overhead
```

## /etc/crypttab: persistent configuration

```bash
# /etc/crypttab format: name device keyfile options
cryptroot   /dev/sda1   none          luks,discard
cryptdata   /dev/sdb1   /root/keyfile luks,nofail
cryptswap   /dev/sdc1   /dev/urandom  swap,cipher=aes-xts-plain64

# Fields:
# name:    → /dev/mapper/<name>
# device:  UUID=... or /dev/sdX or LABEL=...
# keyfile: "none" = prompt; path = file; /dev/urandom = random (for swap)
# options: luks, discard (trim), nofail (skip if not present), etc.

# Use UUID to be device-name-independent:
blkid /dev/sda1 | grep UUID
cryptroot   UUID=abc123-...   none   luks
```

## LUKS vs plain dm-crypt

```bash
# Plain dm-crypt (no LUKS header, no key management):
cryptsetup open --type plain \
    --cipher aes-xts-plain64 \
    --key-size 512 \
    --hash sha512 \
    /dev/sda1 mydev
# Key derived directly from passphrase via hash (no KDF tuning)
# No header means no metadata footprint (deniable encryption)
# But: can't add multiple keys, no integrity checking
```

## dm-integrity: authentication

dm-crypt provides confidentiality but not integrity. dm-integrity adds authentication tags:

```bash
# Create dm-integrity + dm-crypt stack:
# Step 1: format with integrity
cryptsetup open --type plain --integrity hmac-sha256 /dev/sda1 mydev-int
# Step 2: LUKS on top
cryptsetup luksFormat /dev/mapper/mydev-int
cryptsetup open /dev/mapper/mydev-int mydev

# Or use LUKS2 with integrity directly:
cryptsetup luksFormat --type luks2 \
    --integrity hmac-sha256 \
    /dev/sda1
# Adds HMAC tag per 512-byte sector → detects tampering
```

## Observability

```bash
# dm-crypt stats:
dmsetup status /dev/mapper/cryptroot
# 0 976771072 crypt 0 0 0 0 /dev/sda1 2048

# Block I/O stats for dm-crypt device:
iostat -x /dev/mapper/cryptroot 1

# Crypto subsystem stats:
cat /proc/crypto | grep -A5 "aes"
# name         : xts(aes)
# driver       : xts-aes-aesni
# module       : kernel
# priority     : 401
# type         : skcipher

# Hardware vs software crypto:
# driver ending in -aesni = hardware accelerated
# driver ending in -generic = software fallback

# BPF trace encrypt latency:
bpftrace -e '
kprobe:kcryptd_crypt_write_convert { @start[tid] = nsecs; }
kretprobe:kcryptd_crypt_write_convert /@start[tid]/
{
    @lat_us = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}'
```

## Further reading

- [Btrfs](../filesystems/btrfs.md) — commonly used filesystem on top of dm-crypt
- [ext4 Journaling](../filesystems/ext4-journal.md) — filesystem below dm-crypt
- [NVMe Driver](../block/nvme.md) — block device underneath dm-crypt
- [Kernel Crypto API](../crypto/crypto-api.md) — skcipher/AEAD dm-crypt uses
- [LSM Framework](lsm.md) — dm-crypt works with SELinux/AppArmor
- `drivers/md/dm-crypt.c` — dm-crypt target implementation
- `lib/crypto/` — kernel AES-XTS implementation
- `Documentation/admin-guide/device-mapper/dm-crypt.rst`
