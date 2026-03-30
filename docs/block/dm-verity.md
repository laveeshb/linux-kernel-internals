# Device Mapper: dm-verity and Integrity Checking

> Merkle tree verification of block device data for Android and ChromeOS

## What is dm-verity?

dm-verity provides **transparent integrity checking** of a block device using a Merkle (hash) tree. Every read is verified against pre-computed hashes. If data is tampered with, the kernel returns an error or panics.

Used by:
- **Android**: verifying the read-only system partition
- **ChromeOS**: verified boot for rootfs
- **Linux distributions**: immutable root filesystem with integrity

```
Without dm-verity: read block → use data (no check)
With dm-verity:    read block → hash block → compare with Merkle tree → use data
```

## Merkle tree structure

```
Data blocks:        [B0][B1][B2][B3][B4][B5][B6][B7]
                      ↓   ↓   ↓   ↓   ↓   ↓   ↓   ↓
Level 0 hashes:     [H0][H1][H2][H3][H4][H5][H6][H7]
                     └─────────┘   └─────────────────┘
Level 1 hashes:         [H01]              [H23-47]
                          └──────────────────┘
Root hash:                         [ROOT]

On read of B3:
  1. Compute H3 = hash(B3)
  2. Verify H3 matches stored hash at level 0
  3. Verify level 0 hash block matches level 1 hash
  4. ... up to ROOT
  5. Verify ROOT matches the stored root hash (from trusted source)
```

The root hash is stored outside the block device (in the kernel command line, TPM, or signed partition table).

## dm-verity on-disk layout

```
dm-verity device:
┌───────────────────────────────────┐
│ Data blocks (read-only)           │  ← filesystem or raw data
│ [block 0][block 1]...[block N-1]  │
├───────────────────────────────────┤
│ Hash tree                         │
│ Level L-1 (leaf hashes)           │
│ Level L-2                         │
│ ...                               │
│ Level 0 (root)                    │
└───────────────────────────────────┘
```

The hash tree can be on the same device (after the data) or on a separate device.

## Setting up dm-verity

```bash
# Step 1: Format a block device with dm-verity:
veritysetup format /dev/sdb1 /dev/sdc1   # data device, hash device
# VERITY header information for /dev/sdb1
# UUID:                   abc123-...
# Hash type:              1
# Data blocks:            262144
# Data block size:        4096
# Hash block size:        4096
# Hash algorithm:         sha256
# Salt:                   deadbeef...
# Root hash:              1234567890abcdef...  ← SAVE THIS!

# Step 2: Open dm-verity:
veritysetup open /dev/sdb1 verified-root /dev/sdc1 \
    1234567890abcdef...   # root hash from step 1

# Step 3: Mount the verified device:
mount -o ro /dev/mapper/verified-root /mnt

# Any tampered block → read returns -EIO (or panic if configured)

# Step 4: Verify manually:
veritysetup verify /dev/sdb1 /dev/sdc1 1234567890abcdef...
# Verification successful.
```

## Kernel dm-verity implementation

```c
/* drivers/md/dm-verity-target.c */

struct dm_verity {
    struct dm_dev    *data_dev;     /* data block device */
    struct dm_dev    *hash_dev;     /* hash tree device */
    sector_t          data_start;   /* start sector of data */
    sector_t          hash_start;   /* start sector of hash tree */
    sector_t          data_blocks;  /* number of data blocks */
    unsigned int      data_dev_block_bits;
    unsigned int      hash_dev_block_bits;
    unsigned int      digest_size;  /* hash output size */
    const char       *alg_name;    /* "sha256" */
    u8               *root_digest; /* trusted root hash */
    u8               *salt;        /* salt to prevent pre-image attacks */
    unsigned int      salt_size;
    struct crypto_ahash *tfm;      /* hash transform */
    /* ... */
};

/* On every read: */
static int verity_verify_io(struct dm_verity_io *io)
{
    struct dm_verity *v = io->v;
    struct bio_vec bv;

    /* For each data block in the bio: */
    while (more_blocks) {
        /* 1. Hash the data block */
        verity_hash_init(v, io);
        /* io->req = crypto_ahash_request for the block */

        /* 2. Walk up the Merkle tree levels */
        for (level = v->levels - 1; level >= 0; level--) {
            /* Read hash block from hash_dev */
            /* Verify this level's hash against parent */
        }

        /* 3. Verify root hash */
        if (memcmp(root_hash, v->root_digest, v->digest_size)) {
            if (v->mode == DM_VERITY_MODE_EIO)
                return -EIO;       /* silent failure */
            else if (v->mode == DM_VERITY_MODE_PANIC)
                panic("dm-verity: data corrupted!");
        }
    }
    return 0;
}
```

### Error modes

```c
enum verity_mode {
    DM_VERITY_MODE_EIO,          /* return -EIO on corruption (default) */
    DM_VERITY_MODE_LOGGING,      /* log but continue */
    DM_VERITY_MODE_RESTART,      /* reboot */
    DM_VERITY_MODE_PANIC,        /* kernel panic */
};
```

## dm-verity in Android

Android uses dm-verity for the `/system` partition since Android 4.4 (KitKat):

```
Android boot process:
  1. Bootloader verifies kernel + dm-verity metadata signature (AVB)
  2. Kernel boots with dm-verity= parameter:
     dm-verity=1,/dev/sda1,/dev/sda2,4096,4096,N_BLOCKS,HASH_START,sha256,ROOT_HASH,SALT
  3. Init mounts /dev/mapper/verity as /system
  4. Any modified system file → IO error → boot failure

AVB (Android Verified Boot) 2.0:
  - Uses vbmeta partition to store root hashes and signature
  - PKCS#7 signature verified against OEM certificate
```

```bash
# Android: check verity status
adb shell getprop ro.boot.veritymode
# enforcing

# Check dm-verity device:
adb shell dmctl table system
# 0 ...: verity 1 /dev/block/sda1 /dev/block/sda2 4096 4096 ...
```

## dm-verity with fec (Forward Error Correction)

```bash
# Enable FEC: can correct up to N corrupted bytes without failing:
veritysetup format --fec-device=/dev/sdc2 --fec-roots=2 \
    /dev/sdb1 /dev/sdc1
# FEC roots=2 → can correct 2*255/255 = ~0.8% of data

# Open with FEC:
veritysetup open --fec-device=/dev/sdc2 /dev/sdb1 verified /dev/sdc1 \
    <root_hash>
```

## Observability

```bash
# Check dm-verity corruption stats:
dmsetup status verified
# 0 524288000 verity V
# → V = no errors, C = corruption detected

# Kernel error log on corruption:
dmesg | grep -E "dm-verity|verity"
# dm-verity: device 252:0 is corrupted
# dm-verity: hashed block 1234 is corrupted

# Check if verity is enforced:
cat /sys/module/dm_verity/parameters/error_behavior
# EIO
```

## dm-thin: thin provisioning

Another important device mapper target — thin provisioning allows creating virtual block devices larger than physical storage:

```bash
# Create thin pool (metadata + data devices):
dmsetup create pool --table \
    "0 20971520 thin-pool /dev/sdb1 /dev/sdb2 128 0"
#   sectors   target   metadata     data       chunk-size min-free-space

# Create a thin volume (virtual device, no physical allocation):
dmsetup message pool 0 "create_thin 0"       # thin ID 0
dmsetup create thin0 --table "0 2097152 thin /dev/mapper/pool 0"

# Actual blocks are allocated on first write (copy-on-write with provisioning)

# Create snapshot:
dmsetup message pool 0 "create_snap 1 0"   # snap ID 1, origin ID 0
dmsetup create snap0 --table "0 2097152 thin /dev/mapper/pool 1"
```

## Further reading

- [dm-crypt](../security/dm-crypt.md) — dm-crypt stacks well with dm-verity
- [NVMe Driver](nvme.md) — block device dm-verity protects
- [BPF Networking](../bpf/bpf-networking.md) — similar pipeline interception
- `drivers/md/dm-verity*.c` — dm-verity implementation
- `Documentation/admin-guide/device-mapper/verity.rst`
- Android AVB documentation
