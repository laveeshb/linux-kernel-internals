# Kernel Keyring

> Key storage, key types, keyrings, and TPM-backed keys

## Overview

The Linux kernel keyring subsystem provides a general-purpose mechanism for storing
cryptographic material (keys, tokens, certificates) in kernel memory with access-control
enforcement. Keys live in kernel space — they can be referenced by processes without ever
being readable in userspace if the key type forbids it.

Callers interact with keyrings via the `keyctl(2)` syscall (or wrappers like `add_key(2)`
and `request_key(2)`). Subsystems such as fscrypt, NFS, IPsec, and IMA use the keyring
internally to store keys that were installed by userspace.

## struct key

Every key — including a keyring — is represented by `struct key` in `include/linux/key.h`:

```c
struct key {
    refcount_t              usage;
    key_serial_t            serial;         /* unique key ID (keyctl show prints these) */
    union {
        struct list_head    graveyard_link;
        /* internal linkage — varies by kernel version */
    };
    struct rw_semaphore     sem;            /* protects key contents */
    struct key_user         *user;          /* owner accounting */
    union {
        time64_t            expiry;         /* 0 = no expiry */
        time64_t            revoked_at;
    };
    time64_t                last_used_at;

    kuid_t                  uid;
    kgid_t                  gid;
    key_perm_t              perm;           /* permission bits (see below) */

    unsigned short          quotalen;       /* bytes charged against quota */
    unsigned short          datalen;        /* payload length */

    unsigned long           flags;
    /* KEY_FLAG_INSTANTIATED, KEY_FLAG_DEAD, KEY_FLAG_REVOKED, ... */

    char                    *description;  /* human-readable name */

    const struct key_type   *type;         /* "user", "logon", "keyring", ... */

    struct keyring_index_key index_key; /* holds type and description */

    union {
        union key_payload   payload;        /* the actual key material */
        struct {
            /* For keyrings: */
            struct assoc_array      keys;
        };
    };
};
```

`key_serial_t` is a 32-bit integer (the numeric ID shown by `keyctl show`). Keys are
reference-counted; `key_get()` / `key_put()` manage the lifetime.

## Key types

The `struct key_type` defines how a key is instantiated, validated, read, and destroyed.
Built-in key types:

### "user" — userspace-readable bytes

```c
/* security/keys/user_defined.c */
```

An arbitrary byte blob. Both the description and payload are visible to permitted processes.
Used for general key storage where userspace needs to retrieve the value:

```bash
keyctl add user mykey "hello world" @u
keyctl pipe <serial>   # outputs payload bytes
```

### "logon" — kernel-only, unreadable by userspace

Same payload format as "user" but the key type's `.read` callback returns `-EPERM`. Designed
for kernel consumers (fscrypt, dm-crypt) that need to store key material that must never
be exposed back to userspace:

```bash
keyctl add logon fscrypt:abcdef0123456789 <binary_key_data> @s
# Cannot be read back: keyctl pipe will return "permission denied"
```

fscrypt uses logon keys in the format `fscrypt:<key_identifier>`. dm-crypt (via cryptsetup)
uses `cryptsetup:<uuid>`.

### "keyring" — a keyring is itself a key

A keyring holds references to other keys. When you search a keyring, the kernel traverses
the chain recursively. The payload is an `assoc_array` of `struct key *`.

```bash
keyctl newring mykeyring @u   # create a named keyring linked to user keyring
keyctl link <key_serial> <ring_serial>   # link key into a keyring
```

### "encrypted" — encrypted under a master key

Encrypted keys are stored encrypted under a "master key" (a trusted or user key). The
plaintext never leaves kernel space:

```c
/* security/keys/encrypted-keys/encrypted.c */
struct encrypted_key_payload {
    struct rcu_head     rcu;
    char               *master_desc;    /* description of the encrypting key */
    char               *datalen;
    u8                 *iv;
    u8                 *encrypted_data;
    unsigned short      decrypted_datalen;
    unsigned short      payload_datalen;
    unsigned short      format;
    u8                 *decrypted_data;         /* AES-CBC decrypted in kernel */
    u8                  payload_data[];
};
```

Creating an encrypted key:

```bash
# Create a user master key first
keyctl add user kmk "$(dd if=/dev/urandom bs=32 count=1 2>/dev/null)" @u

# Create a new 32-byte encrypted key, encrypted under kmk
keyctl add encrypted myenckey "new user:kmk 32" @u

# Export (still encrypted) to save
keyctl pipe <serial> > myenckey.blob

# Later: reload from blob
keyctl add encrypted myenckey "load user:kmk $(cat myenckey.blob)" @u
```

Two subtypes: `"new"` creates a fresh random key; `"load"` loads an existing encrypted blob.

### "trusted" — sealed to a TPM

Trusted keys are generated and sealed by the TPM (Trusted Platform Module). The plaintext
key material is never exposed to userspace — it only exists inside the TPM or in kernel
memory while unsealed:

```c
/* security/keys/trusted-keys/trusted_tpm1.c and trusted_tpm2.c */
struct trusted_key_payload {
    struct rcu_head     rcu;
    unsigned int        key_len;            /* key size in bytes */
    unsigned int        blob_len;           /* TPM sealed blob size */
    unsigned char       migratable;         /* can the key be migrated? */
    unsigned char       old_format;
    unsigned char       key[MAX_KEY_SIZE + 1];   /* plaintext in kernel only */
    unsigned char       blob[MAX_BLOB_SIZE];     /* TPM-sealed ciphertext */
};
```

The TPM seals the key under its Storage Root Key (SRK), optionally binding it to PCR values
(so the key only unseals when the system is in a specific measured boot state):

```bash
# Requires CONFIG_TRUSTED_KEYS=y and a TPM

# Create a new 32-byte trusted key, seal it to current PCR state
keyctl add trusted mytrustedkey "new 32" @u

# Export the sealed blob (the TPM-encrypted form — safe to save)
keyctl pipe <serial> > mytrustedkey.blob

# After reboot: reload the blob (TPM unseals it if PCRs match)
keyctl add trusted mytrustedkey "load $(xxd -p mytrustedkey.blob | tr -d '\n')" @u

# Use the trusted key as a master key for encrypted keys:
keyctl add encrypted myenckey "new trusted:mytrustedkey 64" @u
```

### "asymmetric" — public key for signature verification

Stores an RSA or EC public key (X.509 certificate, PKCS#7). Used by IMA (Integrity
Measurement Architecture) for file signature verification, and by the kernel module signing
subsystem:

```bash
# IMA: add a signing certificate to the IMA keyring
# (usually done during initramfs before pivot_root)
evmctl import /etc/keys/ima.crt $(keyctl show @u | awk '/\.ima/ {print $1}')
```

The kernel verifies the certificate chain up to a key in the system keyring
(`.builtin_trusted_keys` or `.secondary_trusted_keys`).

## Keyring hierarchy

Keyrings are arranged in a hierarchy. When a key is searched, the kernel walks up the chain:

```
@t  thread keyring        ← searched first (per-thread, rarely used)
@p  process keyring       ← per-process (all threads share it)
@s  session keyring       ← per-login-session (inherited across fork/exec)
@u  user keyring          ← per-UID, persists while user is logged in
@us user-session keyring  ← per-UID session (union of @u and @s for most purposes)
@g  group keyring         ← per-GID (rarely used)

System keyrings (kernel-internal, not per-process):
.builtin_trusted_keys     ← built-in X.509 certificates (module signing, IMA)
.secondary_trusted_keys   ← runtime-added trusted certs
.ima                      ← IMA policy and measurement list keys
.blacklist                ← revoked certificate hashes
```

```bash
keyctl show         # current session keyring tree
keyctl show @u      # user keyring
keyctl show @s      # session keyring

# Example output:
# Keyring
#  xxxxxxxx --alswrv    500  500  keyring: _ses
#  yyyyyyyy --alswrv    500  500   \_ keyring: _uid.500
#  zzzzzzzz --alswrv    500  500       \_ user: mykey
```

On `fork()`, the child inherits the parent's session and user keyrings. On `exec()`, the
thread keyring is cleared. On `CLONE_NEWUSER`, a new user keyring is created for the new
user namespace.

## Key permissions: key_perm_t

Permissions are a 32-bit value encoding four subjects × six permission bits:

```
Bits 31..24: possessor permissions  (the process that "possesses" the key)
Bits 23..16: user permissions       (process UID == key UID)
Bits 15.. 8: group permissions      (process GID == key GID)
Bits  7.. 0: other permissions

Per-subject permission bits:
  0x01  view      see the key's description and metadata
  0x02  read      read the key's payload
  0x04  write     update the payload or add links to a keyring
  0x08  search    find the key during a search
  0x10  link      link the key into a keyring
  0x20  setattr   change ownership, permissions, expiry
```

```bash
# Show permissions in octal-like format:
# --alswrv means: all of {link,search,write,read,view} for possessor
keyctl show @u
# xxxxxxxx --alswrv    500  500  keyring: _uid.500
#           ^^^^^^^^
#           perm field: possessor=alswrv, user=alswrv, ...

# Set permissions explicitly (hex):
keyctl setperm <serial> 0x3f3f0000
#   0x3f = view|read|write|search|link|setattr
#   possessor=0x3f, user=0x3f, group=0, other=0
```

## keyctl(2) syscall

```c
#include <sys/types.h>
#include <keyutils.h>   /* userspace library wrapping keyctl(2) */

/* Add a key */
key_serial_t add_key(const char *type, const char *description,
                     const void *payload, size_t plen,
                     key_serial_t keyring);

/* Request (search for) a key, optionally calling a userspace helper if not found */
key_serial_t request_key(const char *type, const char *description,
                          const char *callout_info, key_serial_t dest_keyring);

/* keyctl operations */
long keyctl(int operation, ...);
```

Key `keyctl` operations:

| Operation | Description |
|---|---|
| `KEYCTL_GET_KEYRING_ID` | Resolve a special keyring constant (`KEY_SPEC_*`) to its serial |
| `KEYCTL_DESCRIBE` | Get description, type, UID, GID, permissions |
| `KEYCTL_READ` | Read the payload (returns `-EPERM` for "logon" type) |
| `KEYCTL_UPDATE` | Update a key's payload |
| `KEYCTL_REVOKE` | Revoke a key (marks it dead, searches skip it) |
| `KEYCTL_UNLINK` | Remove a key from a keyring |
| `KEYCTL_LINK` | Add a key to a keyring |
| `KEYCTL_SEARCH` | Search a keyring tree for a key by type+description |
| `KEYCTL_SET_TIMEOUT` | Set or clear key expiry |
| `KEYCTL_SETPERM` | Change key permissions |
| `KEYCTL_INSTANTIATE` | Instantiate a key from a userspace key helper |
| `KEYCTL_INVALIDATE` | Immediately invalidate a key |

`KEY_SPEC_*` constants for special keyrings:

```c
KEY_SPEC_THREAD_KEYRING    /* @t */
KEY_SPEC_PROCESS_KEYRING   /* @p */
KEY_SPEC_SESSION_KEYRING   /* @s */
KEY_SPEC_USER_KEYRING      /* @u */
KEY_SPEC_USER_SESSION_KEYRING  /* @us */
KEY_SPEC_GROUP_KEYRING     /* @g */
KEY_SPEC_REQKEY_AUTH_KEY   /* for request_key authentication */
```

## Shell usage

```bash
# Add a "user" type key to the session keyring
keyctl add user mypasswd "s3cr3t" @s

# Show the keyring tree
keyctl show @s

# Read a key's payload
keyctl pipe <serial>
keyctl print <serial>     # same but ensures text output

# Search for a key by type and description
keyctl search @s user mypasswd

# Describe a key (type, uid, gid, perm, description)
keyctl describe <serial>

# Set timeout (seconds from now)
keyctl timeout <serial> 300     # key expires in 5 minutes

# Revoke a key immediately
keyctl revoke <serial>

# Unlink from a keyring
keyctl unlink <serial> @s

# Create a new empty keyring
keyctl newring myring @s

# Link a key into an additional keyring
keyctl link <key_serial> <ring_serial>
```

## Key garbage collection

Keys are automatically collected when:

1. **Expiry**: if `expiry` is set and `time64_t` has passed. The key enters "expired" state;
   subsequent searches and reads return `-EKEYEXPIRED`.

2. **Revocation**: `keyctl revoke` or kernel call to `key_revoke()`. Returns `-EKEYREVOKED`.

3. **Reference count drops to zero**: when all processes holding the key have exited or
   unlinked it, and no keyrings reference it.

4. **User quota**: each UID has a quota for number of keys and total bytes. Creating a key
   that exceeds the quota returns `-EDQUOT`. Tunable via
   `/proc/sys/kernel/keys/maxkeys` and `/proc/sys/kernel/keys/maxbytes`.

```bash
# Check key quota
cat /proc/key-users
# 0:     4 4/1000000 4/1000000 0/1000000   (uid: keys/max keys/max bytes/max)

cat /proc/keys   # all keys visible to the calling process
```

## Kernel-side key lookup

Kernel subsystems use `request_key()` internally:

```c
/* Look up an existing key (no userspace upcall) */
struct key *key = request_key(&key_type_logon, "fscrypt:identifier", NULL);
if (IS_ERR(key)) {
    return PTR_ERR(key);  /* -ENOKEY if not found */
}

/* Read the payload under the key's RCU lock */
const struct user_key_payload *ukp;
rcu_read_lock();
ukp = user_key_payload_rcu(key);
if (!ukp) {
    rcu_read_unlock();
    key_put(key);
    return -EKEYREVOKED;
}
memcpy(out_key_material, ukp->data, ukp->datalen);
rcu_read_unlock();

key_put(key);  /* decrement refcount */
```

## Trusted keys with TPM: deeper look

Trusted keys use the TPM's key hierarchy. The TPM 2.0 flow:

```
Boot:
  UEFI/firmware → measures boot components → extends TPM PCRs
  kernel loads  → PCR[4] = kernel hash, PCR[7] = SecureBoot state, etc.

keyctl add trusted mytrustedkey "new 32 keyhandle=0x81000001 pcr:sha256:0,1,7" @u
                                          │               │
                                          │               └─ seal to PCR values 0, 1, 7
                                          └─ use this persistent SRK handle

# TPM seals the key:
#   1. Generate random 32 bytes
#   2. TPM2_Create() under the SRK, binding the current PCR[0,1,7] values
#   3. Return TPM2B_PRIVATE + TPM2B_PUBLIC (the sealed blob)

# Later (after reboot):
keyctl add trusted mytrustedkey "load <hex_blob>" @u
#   TPM2_Load() + TPM2_Unseal() — only succeeds if PCRs match
```

If PCRs don't match (e.g., a different kernel booted), `TPM2_Unseal` returns an error and
the key cannot be instantiated. This is the mechanism behind full-disk encryption that
auto-unlocks only when the system is in a known-good state (similar to Windows BitLocker with
TPM-only mode).

## Encrypted keys: "new" vs "load"

Encrypted keys require a master key to be present in the keyring at the time of creation:

```bash
# "new": generate a new random key, encrypt it under master, store encrypted blob in kernel
keyctl add encrypted myenckey "new user:mymaster 32" @u

# Export the encrypted blob (this is ciphertext — safe to store on disk)
keyctl pipe <serial> | xxd

# "load": decrypt an existing blob using the master key in the keyring
keyctl add encrypted myenckey "load user:mymaster <hex_blob>" @u
```

The payload format on disk is: `<key_type> <master_desc> <datalen> <iv> <ciphertext> <hmac>`,
all in hex. The encryption uses AES-256-CBC with an HMAC-SHA256 integrity check.

## fscrypt and IMA integration

**fscrypt** uses logon keys. When userspace calls `FS_IOC_ADD_ENCRYPTION_KEY`, the kernel:

1. Derives a "filesystem-level" key identifier (SHA-512 hash of the raw key material)
2. Stores the master key in the filesystem's in-kernel key structure
3. Optionally also accepts "logon" type keys via the legacy v1 API

**IMA** uses asymmetric keys for file signature verification:

```bash
# IMA signature verification flow:
# 1. At boot, IMA loads certs from the IMA keyring (.ima)
# 2. At file access, IMA reads the security.ima xattr (PKCS#7 signature)
# 3. ima_verify_signature() looks up the signing key in .ima
# 4. If not found, or if the signature is invalid: policy action (warn/deny)

# Add an IMA cert manually (e.g., in initramfs):
keyctl padd asymmetric "" %:.ima < /etc/ima/signing_key.der
```

## Container isolation

Key namespaces (`struct key_namespace`) were added in Linux 5.2, tied to user namespaces
via `CLONE_NEWUSER`. Each user namespace has its own keyring namespace, providing isolation
between containers using separate user namespaces. Specifically:

- `CLONE_NEWUSER` creates a new user namespace, which gets a fresh user keyring (`@u`)
  and session keyring (`@s`) for UIDs within that namespace.
- A container's `@u` is separate from the host's `@u`, so `keyctl add user key "data" @u`
  inside the container does not affect the host.
- The kernel-internal system keyrings (`.builtin_trusted_keys`, `.ima`) are global — all
  namespaces share them.

Container runtimes rely on the session keyring being established fresh for each container.

## Observing the keyring

```bash
# Keys visible to the current process
cat /proc/keys
# Serial  Flags  Usage  Expiry  Perm      UID   GID  Type  Description
# 0c7ec5e3 I--Q--   1 perm 1f3f0000     0     0 keyring _uid_ses.0

# All keys in the system (requires CAP_SYS_ADMIN for others' keys)
cat /proc/key-users

# Show the keyring tree from shell
keyctl show @s

# List keys on the IMA keyring
keyctl show %:.ima

# Check if a specific key exists
keyctl search @u logon fscrypt:0123456789abcdef
```

## Relevant source

- `security/keys/` — core keyring implementation
- `security/keys/trusted-keys/` — trusted key type (TPM 1.2 and 2.0)
- `security/keys/encrypted-keys/` — encrypted key type
- `include/linux/key.h` — `struct key`, `struct key_type`
- `include/uapi/linux/keyctl.h` — `KEYCTL_*` constants
- `crypto/asymmetric_keys/` — asymmetric key type
- `Documentation/security/keys/core.rst` — kernel documentation

## Further reading

- [dm-crypt and fscrypt](encryption.md) — how logon keys integrate with fscrypt and dm-crypt
- [Kernel Crypto API](crypto-api.md) — the crypto primitives that process key material
- `man 7 keyrings` — userspace keyring overview
- `man 1 keyctl` — shell commands for key management
