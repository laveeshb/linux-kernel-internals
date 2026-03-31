# Kernel Module Signing

> Cryptographic verification of modules before loading

## Why module signing?

Without module signing, anyone with root access can insert arbitrary kernel code via `insmod`. Module signing prevents loading unauthorized modules in security-sensitive environments:
- **Secure Boot**: UEFI firmware verifies the boot chain; modules must also be verified
- **Locked-down kernel**: `lockdown=integrity` mode prevents unsigned modules
- **Compliance**: PCI-DSS, FIPS 140-2 requirements

## Configuration

```bash
# Kconfig options:
CONFIG_MODULE_SIG=y           # Enable module signature support
CONFIG_MODULE_SIG_FORCE=y     # Require signatures (refuse unsigned)
CONFIG_MODULE_SIG_ALL=y       # Automatically sign all modules at build
CONFIG_MODULE_SIG_SHA512=y    # Use SHA-512 for signing hash
CONFIG_MODULE_SIG_KEY="certs/signing_key.pem"  # Signing key path

# Check current configuration:
zcat /proc/config.gz | grep CONFIG_MODULE_SIG
```

## Generating signing keys

```bash
# Generate a new key pair (during kernel build):
# The kernel build system auto-generates if CONFIG_MODULE_SIG_KEY points
# to a non-existent file.

# Manual generation:
openssl req -new -nodes -utf8 -sha512 -days 36500 \
    -batch -x509 \
    -config x509.genkey \
    -outform PEM \
    -out signing_key.pem \
    -keyout signing_key.pem

# x509.genkey contents:
cat > x509.genkey << 'EOF'
[ req ]
default_bits = 4096
distinguished_name = req_distinguished_name
prompt = no
string_mask = utf8only
x509_extensions = myexts

[ req_distinguished_name ]
O = My Organization
CN = Module Signing Key
emailAddress = root@localhost

[ myexts ]
basicConstraints=critical,CA:FALSE
keyUsage=digitalSignature
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF
```

## Signing a module

```bash
# Sign a module using the kernel's sign-file utility:
/usr/src/linux-<version>/scripts/sign-file sha512 \
    signing_key.pem \
    signing_key.pem \
    mymodule.ko
# First pem: private key, Second pem: X.509 certificate

# Verify the signature:
/usr/src/linux-<version>/scripts/sign-file --dry-run \
    sha512 signing_key.pem signing_key.pem mymodule.ko

# Inspect the signature on a signed module:
hexdump -C mymodule.ko | tail -5
# The last bytes are "~Module signature appended~\n" + sig data
```

## Module signature format

The signature is appended at the end of the `.ko` file:

```c
/* include/linux/module_signature.h */
struct module_signature {
    u8  algo;        /* hash algorithm: PKEY_HASH_SHA256 etc. */
    u8  hash;        /* hash digest: 0 = SHA1, 1 = SHA224, etc. */
    u8  id_type;     /* key identifier type: PKEY_ID_PKCS7 */
    u8  signer_len;  /* length of signer name */
    u8  key_id_len;  /* length of key identifier */
    u8  __pad[3];
    __be32 sig_len;  /* length of the signature */
};
```

Layout at end of signed `.ko`:
```
[ELF sections]
[PKCS#7 signed data (DER encoded)]
[struct module_signature]
"~Module signature appended~\n"
```

```bash
# Read the signature info:
modinfo mymodule.ko | grep sig
# sig_id: PKCS#7
# signer: My Organization: Module Signing Key
# sig_key: 01:23:45:67:89:ab:cd:ef:...
# sig_hashalgo: sha512
```

## Loading and verification

```c
/* kernel/module/signing.c */
int module_sig_check(struct load_info *info, int flags)
{
    int err = -ENOKEY;
    const unsigned long markerlen = sizeof(MODULE_SIG_STRING) - 1;
    const char *reason;
    const void *mod = info->hdr;

    /* Check for the "~Module signature appended~\n" marker */
    if (info->len > markerlen &&
        memcmp(mod + info->len - markerlen, MODULE_SIG_STRING, markerlen) == 0) {

        /* Parse the struct module_signature at the end */
        info->len -= markerlen;
        /* Extract and verify the PKCS#7 signature */
        err = mod_verify_sig(mod, info);
    }

    if (!err) {
        info->sig_ok = true;
        return 0;
    }

    /* Unsigned/bad signature: */
    if (is_module_sig_enforced()) {
        pr_notice("%s: module verification failed: signature and/or required key missing - tainting kernel\n",
                   info->name);
        return err;
    }

    /* Not enforced: warn and taint the kernel */
    pr_notice("%s: loading out-of-tree module taints kernel.\n", info->name);
    add_taint(TAINT_OOT_MODULE, LOCKDEP_STILL_OK);
    return 0;
}
```

## Enrolled keys: the system keyring

The kernel maintains a keyring of trusted keys:

```bash
# View the kernel's built-in keyring:
keyctl show %:.builtin_trusted_keys
# Keyring
#  1234567 ---lswrv      0     0  keyring: .builtin_trusted_keys
#  7654321 ---lswrv      0     0   \_ asymmetric: My Org: Module Signing Key: abc123

# View system keyring (includes UEFI db keys):
keyctl show %:.secondary_trusted_keys

# System keyring sources:
# 1. Built-in at compile time (CONFIG_SYSTEM_TRUSTED_KEYS)
# 2. Loaded from UEFI Secure Boot db at boot
# 3. Enrolled via keyctl (requires CAP_SYS_ADMIN + enforced = off)
```

## Enrolling a custom key (UEFI + Secure Boot)

```bash
# 1. Export the certificate
openssl x509 -in signing_key.pem -outform DER -out signing_key.der

# 2. Enroll into UEFI Machine Owner Key (MOK) database:
mokutil --import signing_key.der
# Prompts for a password; requires reboot to confirm in UEFI

# 3. After reboot: key is trusted, modules signed with it load

# 4. Verify enrollment:
mokutil --list-enrolled | grep "Subject:"

# 5. Load a module signed with this key:
insmod mymodule.ko   # succeeds without warnings
```

## Kernel lockdown mode

Linux lockdown (5.4+, tied to Secure Boot) restricts what root can do:

```bash
# Check lockdown mode:
cat /sys/kernel/security/lockdown
# [none] integrity confidentiality

# Modes:
# none:           no restrictions
# integrity:      prevent bypassing module signing and integrity checks
# confidentiality: also prevent reading kernel memory

# Set lockdown (requires CAP_SYS_ADMIN, only upward not downward):
echo integrity > /sys/kernel/security/lockdown

# With UEFI Secure Boot enabled:
# The kernel automatically enters lockdown=integrity mode
```

Under `lockdown=integrity`:
- Unsigned modules are rejected (regardless of `MODULE_SIG_FORCE`)
- `/dev/mem`, `/dev/kmem`, `/dev/port` access denied
- kexec only with signed kernel images
- BPF writing to kernel memory restricted

## Debugging module signature issues

```bash
# Why did a module fail to load?
dmesg | grep -E "module|sig|sign" | tail -20
# [   12.345] mymodule: module verification failed: signature and/or required key missing

# Check if module is signed:
modinfo mymodule.ko | grep sig_id
# (empty if unsigned)

# Force load an unsigned module (if not enforced):
modprobe --force mymodule   # --force is modprobe, not insmod
# Warning: will taint kernel

# What's the kernel's signature enforcement status?
cat /proc/sys/kernel/sig_enforce  # if it exists
# or:
dmesg | grep "Module sig enforcement"

# Check taint flags:
cat /proc/sys/kernel/tainted
# See Documentation/admin-guide/tainted-kernels.rst for bit meanings
```

## Further reading

- [Writing and Loading Modules](module-basics.md) — module lifecycle
- [LSM Framework](../security/lsm.md) — lockdown as an LSM
- [Capabilities](../security/capabilities.md) — CAP_SYS_MODULE for insmod
- [kernel Crypto API](../crypto/crypto-api.md) — PKCS#7 verification uses kernel crypto
- `kernel/module/signing.c` — module signature verification
- `scripts/sign-file.c` — signing tool
- `Documentation/admin-guide/module-signing.rst`
